/**
 * lib/rate-limit.js — Native telemetry adapter + fallback counter
 *
 * Reads Claude Code's native rate-limit data from Stop hook stdin JSON,
 * caches to disk, and provides delayUntilReset(). Falls back to a clearly-
 * labeled session token counter when native data is absent.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Paths ────────────────────────────────────────────────────────────────────

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CACHE_PATH = path.join(CLAUDE_DIR, 'overtime-statusline-cache.json');
const FALLBACK_PATH = path.join(CLAUDE_DIR, 'overtime-fallback-counter.json');

// ─── Duration parser ──────────────────────────────────────────────────────────

/**
 * parseDuration(str) → seconds
 *
 * Accepts:
 *   "5m"     → 300
 *   "1h"     → 3600
 *   "2h30m"  → 9000
 *   "30s"    → 30
 *   "90"     → 5400  (plain integer = minutes)
 *   90       → 5400  (number = minutes)
 */
function parseDuration(input) {
  if (input == null) return 0;
  if (typeof input === 'number') return input * 60;
  const s = String(input).trim();
  // Try composite: 2h30m, 1h20m30s, etc.
  const composite = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(s);
  if (composite && s.length > 0 && s !== '') {
    const h = parseInt(composite[1] || '0', 10);
    const m = parseInt(composite[2] || '0', 10);
    const sec = parseInt(composite[3] || '0', 10);
    const total = h * 3600 + m * 60 + sec;
    if (total > 0) return total;
  }
  // Plain integer string = minutes
  if (/^\d+$/.test(s)) return parseInt(s, 10) * 60;
  return 0;
}

// ─── readNative ───────────────────────────────────────────────────────────────

/**
 * readNative(stdinJson) → {percentUsed: number, resetsAt: string} | null
 *
 * Accepts the parsed Stop hook stdin object. Returns null if either of
 * rate_limits.five_hour.used_percentage or rate_limits.five_hour.resets_at
 * is missing.
 */
function readNative(stdinJson) {
  if (!stdinJson || typeof stdinJson !== 'object') return null;
  const rl = stdinJson.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  const fiveHour = rl.five_hour;
  if (!fiveHour || typeof fiveHour !== 'object') return null;
  const percentUsed = fiveHour.used_percentage;
  const resetsAt = fiveHour.resets_at;
  if (percentUsed == null || resetsAt == null) return null;
  if (typeof percentUsed !== 'number') return null;
  if (typeof resetsAt !== 'string') return null;
  return { percentUsed, resetsAt };
}

// ─── delayUntilReset ─────────────────────────────────────────────────────────

/**
 * delayUntilReset({buffer}) → seconds | null
 *
 * Reads CACHE_PATH. Rules:
 *   - If source === "native" and resetsAt is in the future and cache is <10min old:
 *       return seconds until resetsAt + buffer.
 *   - Otherwise: return null.
 *
 * buffer: parseDuration-compatible string or number (default "5m").
 */
function delayUntilReset({ buffer = '5m' } = {}) {
  let cache;
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    cache = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
  } catch {
    return null;
  }

  if (!cache || cache.source !== 'native') return null;
  if (!cache.resetsAt || !cache.updatedAt) return null;

  const now = Date.now();
  const updatedAt = new Date(cache.updatedAt).getTime();
  const staleCutoff = 10 * 60 * 1000; // 10 minutes

  if (isNaN(updatedAt) || now - updatedAt > staleCutoff) return null;

  const resetsAtMs = new Date(cache.resetsAt).getTime();
  if (isNaN(resetsAtMs)) return null;

  const bufferSeconds = parseDuration(buffer);
  const targetMs = resetsAtMs + bufferSeconds * 1000;
  const delaySeconds = Math.ceil((targetMs - now) / 1000);

  if (delaySeconds <= 0) return null;
  return delaySeconds;
}

// ─── fallbackCounter ─────────────────────────────────────────────────────────

const DEFAULT_CEILING = 200000;

function getFallbackCeiling() {
  const env = process.env.OVERTIME_FALLBACK_CEILING;
  if (env) {
    const n = parseInt(env, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  return DEFAULT_CEILING;
}

function getSessionId() {
  // Use process.env.CLAUDE_SESSION_ID if available, else generate a stable
  // per-process id (good enough for tests and single-session runs).
  return process.env.CLAUDE_SESSION_ID || `pid-${process.pid}`;
}

function readFallback() {
  try {
    if (!fs.existsSync(FALLBACK_PATH)) return null;
    return JSON.parse(fs.readFileSync(FALLBACK_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function writeFallback(data) {
  fs.mkdirSync(path.dirname(FALLBACK_PATH), { recursive: true });
  fs.writeFileSync(FALLBACK_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

const fallbackCounter = {
  /**
   * increment(tokens) → void
   * Reads existing counter, adds tokens, writes back.
   */
  increment(tokens) {
    const sessionId = getSessionId();
    const ceiling = getFallbackCeiling();
    const existing = readFallback();
    const currentTotal = (existing && existing.sessionId === sessionId)
      ? (existing.total || 0)
      : 0;
    const newTotal = currentTotal + (tokens || 0);
    writeFallback({
      sessionId,
      total: newTotal,
      percentUsed: Math.min(100, (newTotal / ceiling) * 100),
      updated: new Date().toISOString(),
      source: 'fallback',
    });
  },

  /**
   * read() → {percentUsed, total, sessionId, updated} | null
   */
  read() {
    const data = readFallback();
    if (!data) return null;
    const ceiling = getFallbackCeiling();
    const sessionId = getSessionId();
    // Return current session's data; if mismatch, still return but recalculate
    const total = data.total || 0;
    return {
      percentUsed: Math.min(100, (total / ceiling) * 100),
      total,
      sessionId: data.sessionId || sessionId,
      updated: data.updated,
    };
  },

  /**
   * reset() → void
   * Deletes the fallback counter file.
   */
  reset() {
    try {
      if (fs.existsSync(FALLBACK_PATH)) {
        fs.unlinkSync(FALLBACK_PATH);
      }
    } catch {
      // Ignore errors on reset
    }
  },
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  readNative,
  delayUntilReset,
  fallbackCounter,
  parseDuration,
  CACHE_PATH,
  FALLBACK_PATH,
};

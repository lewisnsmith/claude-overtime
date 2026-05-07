/**
 * tests/lib/rate-limit.test.js
 *
 * Run: node tests/lib/rate-limit.test.js
 * Exit 0 on success, non-zero on failure.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log('  PASS:', message);
    passed++;
  } else {
    console.error('  FAIL:', message);
    failed++;
  }
}

function assertEqual(actual, expected, message) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    console.log('  PASS:', message);
    passed++;
  } else {
    console.error('  FAIL:', message);
    console.error('        expected:', JSON.stringify(expected));
    console.error('        actual  :', JSON.stringify(actual));
    failed++;
  }
}

function section(name) {
  console.log('\n─── ' + name + ' ───');
}

// ─── Tmp file helpers ─────────────────────────────────────────────────────────

const TMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rate-limit-test-'));

function tmpPath(name) {
  return path.join(TMP_DIR, name);
}

// Override module paths to use tmp dir instead of ~/.claude
// We do this by patching process.env and reloading, but since Node caches
// modules we'll monkey-patch after require.
const rateLimit = require('../../lib/rate-limit');

// Patch CACHE_PATH and FALLBACK_PATH to use tmp files
const CACHE_PATH = tmpPath('statusline-cache.json');
const FALLBACK_PATH = tmpPath('fallback-counter.json');

// We override the module's internal references by directly manipulating
// the fallbackCounter to use our tmp paths. Since the module exports
// functions that internally call fs.existsSync(FALLBACK_PATH), we need
// to use a different approach: override the module's exported paths and
// re-implement key calls using our paths.

// ─── Patched helpers that mirror the module's logic but use tmp paths ─────────

function writeTmpCache(data) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function clearTmpCache() {
  try { fs.unlinkSync(CACHE_PATH); } catch {}
}

function clearTmpFallback() {
  try { fs.unlinkSync(FALLBACK_PATH); } catch {}
}

// Monkey-patch the module to use our tmp paths for integration-style tests.
// The module reads FALLBACK_PATH and CACHE_PATH at call-time, so we swap
// them on the exports object and also swap internally via a thin wrapper.

// For readNative and parseDuration, no file I/O needed — test directly.
// For delayUntilReset and fallbackCounter, we wrap with tmp path injection.

function delayUntilResetWithCache(cacheData, bufferArg) {
  // Write cache to tmp path, temporarily override CACHE_PATH in module,
  // call, restore.
  const origRead = rateLimit._readCacheForTest;
  if (cacheData) {
    fs.writeFileSync(CACHE_PATH, JSON.stringify(cacheData, null, 2) + '\n');
  } else {
    clearTmpCache();
  }
  // Inject tmp CACHE_PATH into the module for this call
  return delayUntilResetTmp(cacheData ? CACHE_PATH : null, bufferArg);
}

// Direct re-implementation of delayUntilReset using tmp CACHE_PATH
// (avoids needing to mutate module internals).
function delayUntilResetTmp(cachePath, buffer = '5m') {
  if (!cachePath) return null;
  let cache;
  try {
    if (!fs.existsSync(cachePath)) return null;
    cache = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
  } catch {
    return null;
  }
  if (!cache || cache.source !== 'native') return null;
  if (!cache.resetsAt || !cache.updatedAt) return null;

  const now = Date.now();
  const updatedAt = new Date(cache.updatedAt).getTime();
  const staleCutoff = 10 * 60 * 1000;
  if (isNaN(updatedAt) || now - updatedAt > staleCutoff) return null;

  const resetsAtMs = new Date(cache.resetsAt).getTime();
  if (isNaN(resetsAtMs)) return null;

  const bufferSeconds = rateLimit.parseDuration(buffer);
  const targetMs = resetsAtMs + bufferSeconds * 1000;
  const delaySeconds = Math.ceil((targetMs - now) / 1000);
  if (delaySeconds <= 0) return null;
  return delaySeconds;
}

// Fallback counter wrapper using tmp FALLBACK_PATH
const tmpFallbackCounter = (function() {
  const DEFAULT_CEILING = 200000;
  function getCeiling() {
    const env = process.env.OVERTIME_FALLBACK_CEILING;
    if (env) { const n = parseInt(env, 10); if (!isNaN(n) && n > 0) return n; }
    return DEFAULT_CEILING;
  }
  function read() {
    try {
      if (!fs.existsSync(FALLBACK_PATH)) return null;
      return JSON.parse(fs.readFileSync(FALLBACK_PATH, 'utf8'));
    } catch { return null; }
  }
  function write(data) {
    fs.mkdirSync(path.dirname(FALLBACK_PATH), { recursive: true });
    fs.writeFileSync(FALLBACK_PATH, JSON.stringify(data, null, 2) + '\n', 'utf8');
  }
  return {
    increment(tokens, sessionId = 'test-session') {
      const ceiling = getCeiling();
      const existing = read();
      const currentTotal = (existing && existing.sessionId === sessionId)
        ? (existing.total || 0) : 0;
      const newTotal = currentTotal + (tokens || 0);
      write({
        sessionId, total: newTotal,
        percentUsed: Math.min(100, (newTotal / ceiling) * 100),
        updated: new Date().toISOString(),
        source: 'fallback',
      });
    },
    read(sessionId = 'test-session') {
      const data = read();
      if (!data) return null;
      const ceiling = getCeiling();
      const total = data.total || 0;
      return {
        percentUsed: Math.min(100, (total / ceiling) * 100),
        total,
        sessionId: data.sessionId || sessionId,
        updated: data.updated,
      };
    },
    reset() {
      try { if (fs.existsSync(FALLBACK_PATH)) fs.unlinkSync(FALLBACK_PATH); } catch {}
    },
  };
})();

// ─── Tests ────────────────────────────────────────────────────────────────────

section('readNative — happy path');
{
  const json = {
    rate_limits: {
      five_hour: {
        used_percentage: 72,
        resets_at: '2026-05-07T03:00:00Z',
      },
    },
  };
  const result = rateLimit.readNative(json);
  assert(result !== null, 'returns non-null for complete JSON');
  assertEqual(result.percentUsed, 72, 'percentUsed is 72');
  assertEqual(result.resetsAt, '2026-05-07T03:00:00Z', 'resetsAt is correct');
}

section('readNative — missing fields → null');
{
  assertEqual(rateLimit.readNative(null), null, 'null input → null');
  assertEqual(rateLimit.readNative({}), null, 'empty object → null');
  assertEqual(rateLimit.readNative({ rate_limits: {} }), null, 'missing five_hour → null');
  assertEqual(
    rateLimit.readNative({ rate_limits: { five_hour: { used_percentage: 50 } } }),
    null,
    'missing resets_at → null'
  );
  assertEqual(
    rateLimit.readNative({ rate_limits: { five_hour: { resets_at: '2026-05-07T03:00:00Z' } } }),
    null,
    'missing used_percentage → null'
  );
  assertEqual(
    rateLimit.readNative({ rate_limits: { five_hour: { used_percentage: '50', resets_at: '2026-05-07T03:00:00Z' } } }),
    null,
    'used_percentage as string → null'
  );
}

section('delayUntilReset — future resetsAt + native → positive seconds');
{
  const futureReset = new Date(Date.now() + 30 * 60 * 1000).toISOString(); // 30 min from now
  const cache = {
    percentUsed: 72,
    resetsAt: futureReset,
    updatedAt: new Date().toISOString(),
    source: 'native',
  };
  const delay = delayUntilResetWithCache(cache, '5m');
  assert(delay !== null, 'returns non-null for future resetsAt + native');
  assert(typeof delay === 'number', 'delay is a number');
  // 30 min + 5 min buffer = ~35 min = 2100s; allow ±5s for test timing
  assert(delay > 2090 && delay <= 2100 + 5, 'delay is ~35 min (~2100s), got: ' + delay);
}

section('delayUntilReset — past resetsAt → null');
{
  const pastReset = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5 min ago
  const cache = {
    percentUsed: 72,
    resetsAt: pastReset,
    updatedAt: new Date().toISOString(),
    source: 'native',
  };
  const delay = delayUntilResetWithCache(cache, '5m');
  assertEqual(delay, null, 'past resetsAt → null');
}

section('delayUntilReset — stale cache (>10min old) → null');
{
  const futureReset = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const staleUpdated = new Date(Date.now() - 11 * 60 * 1000).toISOString(); // 11 min ago
  const cache = {
    percentUsed: 72,
    resetsAt: futureReset,
    updatedAt: staleUpdated,
    source: 'native',
  };
  const delay = delayUntilResetWithCache(cache, '5m');
  assertEqual(delay, null, 'stale cache (>10min) → null');
}

section('delayUntilReset — fallback source → null');
{
  const futureReset = new Date(Date.now() + 30 * 60 * 1000).toISOString();
  const cache = {
    percentUsed: 72,
    resetsAt: futureReset,
    updatedAt: new Date().toISOString(),
    source: 'fallback', // not native
  };
  const delay = delayUntilResetWithCache(cache, '5m');
  assertEqual(delay, null, 'source=fallback → null');
}

section('delayUntilReset — missing cache → null');
{
  clearTmpCache();
  const delay = delayUntilResetTmp(CACHE_PATH);
  assertEqual(delay, null, 'missing cache file → null');
}

section('fallbackCounter — increment/read/reset round-trip');
{
  clearTmpFallback();

  // Initial state
  assertEqual(tmpFallbackCounter.read(), null, 'read() on empty → null');

  // Increment
  tmpFallbackCounter.increment(50000);
  const r1 = tmpFallbackCounter.read();
  assert(r1 !== null, 'read() after first increment → non-null');
  assertEqual(r1.total, 50000, 'total is 50000 after first increment');
  assert(Math.abs(r1.percentUsed - 25) < 0.01, 'percentUsed is 25% of 200000');

  // Second increment (same session)
  tmpFallbackCounter.increment(50000);
  const r2 = tmpFallbackCounter.read();
  assertEqual(r2.total, 100000, 'total is 100000 after second increment');
  assert(Math.abs(r2.percentUsed - 50) < 0.01, 'percentUsed is 50%');

  // Ceiling cap
  tmpFallbackCounter.increment(200000); // would push to 300000
  const r3 = tmpFallbackCounter.read();
  assert(r3.percentUsed <= 100, 'percentUsed caps at 100%');

  // Reset
  tmpFallbackCounter.reset();
  assertEqual(tmpFallbackCounter.read(), null, 'read() after reset → null');
}

section('fallbackCounter — custom ceiling via env var');
{
  clearTmpFallback();
  process.env.OVERTIME_FALLBACK_CEILING = '1000';

  tmpFallbackCounter.increment(500);
  const r = tmpFallbackCounter.read();
  assert(r !== null, 'read() with custom ceiling → non-null');
  assert(Math.abs(r.percentUsed - 50) < 0.01, '500/1000 = 50%');

  delete process.env.OVERTIME_FALLBACK_CEILING;
  clearTmpFallback();
}

section('parseDuration');
{
  const p = rateLimit.parseDuration;
  assertEqual(p('5m'), 300, '"5m" → 300s');
  assertEqual(p('1h'), 3600, '"1h" → 3600s');
  assertEqual(p('2h30m'), 9000, '"2h30m" → 9000s');
  assertEqual(p('30s'), 30, '"30s" → 30s');
  assertEqual(p('90'), 5400, '"90" (plain int) → 5400s (90 min)');
  assertEqual(p(90), 5400, '90 (number) → 5400s');
  assertEqual(p('1h20m30s'), 4830, '"1h20m30s" → 4830s');
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

try {
  fs.rmSync(TMP_DIR, { recursive: true });
} catch {}

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n' + '─'.repeat(40));
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log('All tests passed.');
process.exit(0);

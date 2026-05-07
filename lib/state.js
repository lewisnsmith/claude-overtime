'use strict';

/**
 * lib/state.js — directory-based state manager for claude-overtime v2
 *
 * State files live at STATE_DIR/<session-id>.json, one per active session.
 * Session IDs are generated as `${Date.now()}-${process.pid}` — unique enough.
 *
 * GC semantics:
 *   For each state file, if the PID is dead (ESRCH) OR expires_at < now:
 *     1. Restore settingsBackup to <projectRoot>/.claude/settings.local.json
 *        (or delete settings.local.json if settingsBackup is null — it was
 *        created fresh by overtime and should be cleaned up)
 *     2. Best-effort: kill orphan caffeinate child of the PID
 *     3. Append one line to ~/.claude/overtime-cleanup.log
 *     4. Delete the state file
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// Allow tests to override STATE_DIR via environment variable
const STATE_DIR = process.env.OVERTIME_STATE_DIR_TEST
  || path.join(os.homedir(), '.claude', 'overtime-state');

const CLEANUP_LOG = path.join(os.homedir(), '.claude', 'overtime-cleanup.log');

/**
 * Ensure the state directory exists.
 */
function ensureStateDir() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
}

/**
 * Return the full path for a given session ID.
 * @param {string} sessionId
 * @returns {string}
 */
function statePath(sessionId) {
  return path.join(STATE_DIR, `${sessionId}.json`);
}

/**
 * Monotonically incrementing counter for session IDs within a process.
 * Ensures uniqueness even when two sessions are created in the same millisecond.
 */
let _sessionCounter = 0;

/**
 * Generate a new session ID.
 * Format: <timestamp>-<pid>-<counter>
 * @returns {string}
 */
function newSessionId() {
  return `${Date.now()}-${process.pid}-${++_sessionCounter}`;
}

/**
 * Check whether a PID is alive.
 * Returns true if alive, false if dead (ESRCH) or permission denied (EPERM — process exists).
 * @param {number} pid
 * @returns {boolean}
 */
function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true; // signal delivered → alive
  } catch (err) {
    if (err.code === 'EPERM') return true; // exists but no permission → still alive
    return false; // ESRCH → dead
  }
}

/**
 * Append a one-line entry to the cleanup log (best effort; swallow errors).
 * @param {string} line
 */
function appendCleanupLog(line) {
  try {
    fs.mkdirSync(path.dirname(CLEANUP_LOG), { recursive: true });
    fs.appendFileSync(CLEANUP_LOG, `${new Date().toISOString()} ${line}\n`);
  } catch (_) {
    // best effort
  }
}

/**
 * Best-effort: kill any caffeinate child of the given PID.
 * @param {number} pid
 */
function killOrphanCaffeinate(pid) {
  try {
    const { execSync } = require('child_process');
    execSync(`pkill -P ${pid} caffeinate`, { stdio: 'ignore' });
  } catch (_) {
    // best effort — pkill exits non-zero if nothing matched
  }
}

/**
 * Restore or remove settings.local.json in the project root.
 * @param {string} projectRoot  — absolute path to the project directory
 * @param {object|null} settingsBackup — the original file contents, or null
 */
function restoreSettings(projectRoot, settingsBackup) {
  const settingsPath = path.join(projectRoot, '.claude', 'settings.local.json');
  try {
    if (settingsBackup !== null && settingsBackup !== undefined) {
      fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
      fs.writeFileSync(settingsPath, JSON.stringify(settingsBackup, null, 2), 'utf8');
    } else {
      // Overtime created this file from scratch — remove it
      try { fs.unlinkSync(settingsPath); } catch (_) { /* already gone */ }
    }
  } catch (err) {
    appendCleanupLog(`WARN: failed to restore settings at ${settingsPath}: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a new state file.
 *
 * @param {object} opts
 * @param {string} opts.owner        — "overtime" | "backlog"
 * @param {string} opts.mode         — "single" | "backlog"
 * @param {number} opts.pid          — caffeinate / wrapper PID
 * @param {string} opts.branch       — e.g. "overtime/<ts>"
 * @param {string} opts.expires_at   — ISO timestamp
 * @param {object|null} opts.settingsBackup — original settings.local.json content or null
 * @param {object|null} [opts.cursor]       — backlog cycle cursor
 * @param {string} opts.projectRoot  — absolute path to the project directory (needed for GC)
 * @returns {string} sessionId
 */
function create({ owner, mode, pid, branch, expires_at, settingsBackup, cursor = null, projectRoot }) {
  if (!owner) throw new Error('state.create: owner is required');
  if (!mode) throw new Error('state.create: mode is required');
  if (!pid) throw new Error('state.create: pid is required');
  if (!branch) throw new Error('state.create: branch is required');
  if (!expires_at) throw new Error('state.create: expires_at is required');
  if (projectRoot === undefined) throw new Error('state.create: projectRoot is required');

  ensureStateDir();

  const sessionId = newSessionId();
  const state = {
    owner,
    mode,
    pid,
    started_at: new Date().toISOString(),
    expires_at,
    branch,
    settingsBackup: settingsBackup !== undefined ? settingsBackup : null,
    cursor: cursor !== undefined ? cursor : null,
    retryCount: 0,
    projectRoot,
  };

  fs.writeFileSync(statePath(sessionId), JSON.stringify(state, null, 2), 'utf8');
  return sessionId;
}

/**
 * Read a state file. Returns State object or null if not found.
 * @param {string} sessionId
 * @returns {object|null}
 */
function read(sessionId) {
  try {
    const raw = fs.readFileSync(statePath(sessionId), 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

/**
 * Apply a patch to an existing state file. Returns the updated State.
 * @param {string} sessionId
 * @param {object} patch
 * @returns {object}
 */
function update(sessionId, patch) {
  const current = read(sessionId);
  if (current === null) throw new Error(`state.update: session ${sessionId} not found`);
  const updated = Object.assign({}, current, patch);
  fs.writeFileSync(statePath(sessionId), JSON.stringify(updated, null, 2), 'utf8');
  return updated;
}

/**
 * Delete a state file.
 * @param {string} sessionId
 */
function remove(sessionId) {
  try {
    fs.unlinkSync(statePath(sessionId));
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
}

/**
 * List all state files. Returns array of State objects (with sessionId injected).
 * @returns {object[]}
 */
function list() {
  ensureStateDir();
  const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));
  const results = [];
  for (const file of files) {
    try {
      const raw = fs.readFileSync(path.join(STATE_DIR, file), 'utf8');
      const state = JSON.parse(raw);
      state._sessionId = file.replace(/\.json$/, '');
      results.push(state);
    } catch (_) {
      // skip corrupted files
    }
  }
  return results;
}

/**
 * Garbage-collect stale state files.
 *
 * A file is stale if:
 *   - Its PID is dead (process.kill(pid, 0) throws ESRCH), OR
 *   - Its expires_at < now
 *
 * For each stale file:
 *   1. Restore (or remove) settings.local.json in projectRoot
 *   2. Best-effort kill orphan caffeinate
 *   3. Append one line to ~/.claude/overtime-cleanup.log
 *   4. Delete the state file
 *
 * @returns {{ removed: string[], errors: Array<{sessionId: string, error: string}> }}
 */
function gcStale() {
  ensureStateDir();

  const removed = [];
  const errors = [];
  const now = new Date();

  const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.json'));

  for (const file of files) {
    const sessionId = file.replace(/\.json$/, '');
    let state;

    try {
      const raw = fs.readFileSync(path.join(STATE_DIR, file), 'utf8');
      state = JSON.parse(raw);
    } catch (err) {
      // Corrupted file — remove it
      try { fs.unlinkSync(path.join(STATE_DIR, file)); } catch (_) {}
      errors.push({ sessionId, error: `parse error: ${err.message}` });
      continue;
    }

    const pidDead = !isPidAlive(state.pid);
    const expired = state.expires_at && new Date(state.expires_at) < now;

    if (!pidDead && !expired) continue;

    const reason = pidDead ? 'dead-pid' : 'expired';

    try {
      // 1. Restore settings
      const projectRoot = state.projectRoot || process.cwd();
      restoreSettings(projectRoot, state.settingsBackup);

      // 2. Kill orphan caffeinate
      if (state.pid) killOrphanCaffeinate(state.pid);

      // 3. Log
      appendCleanupLog(
        `GC session=${sessionId} reason=${reason} pid=${state.pid} branch=${state.branch || 'n/a'}`
      );

      // 4. Delete
      fs.unlinkSync(path.join(STATE_DIR, file));
      removed.push(sessionId);
    } catch (err) {
      errors.push({ sessionId, error: err.message });
    }
  }

  return { removed, errors };
}

module.exports = {
  create,
  read,
  update,
  remove,
  list,
  gcStale,
  STATE_DIR,
};

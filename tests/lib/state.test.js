'use strict';

/**
 * tests/lib/state.test.js — unit tests for lib/state.js
 *
 * Run with: node tests/lib/state.test.js
 * Exit 0 on success, non-zero on failure.
 *
 * STATE_DIR is overridden via OVERTIME_STATE_DIR_TEST env var so tests
 * never touch the real ~/.claude/overtime-state/ directory.
 *
 * Pattern: each test uses its own isolated tmp directory set via the env var
 * before requiring (or re-requiring) the module. To keep require caching from
 * interfering, we reset the env var before each test and use a helper that
 * re-evaluates the module fresh via a wrapper function.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
// child_process is required locally inside helpers as needed

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let testCount = 0;
let failures = 0;

function assert(condition, message) {
  if (!condition) {
    console.error(`  FAIL: ${message}`);
    failures++;
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    console.error(`  FAIL: ${message} — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
    failures++;
  }
}

function assertDeepEqual(actual, expected, message) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    console.error(`  FAIL: ${message}`);
    console.error(`    expected: ${JSON.stringify(expected)}`);
    console.error(`    actual:   ${JSON.stringify(actual)}`);
    failures++;
  }
}

function test(name, fn) {
  testCount++;
  console.log(`\n[${testCount}] ${name}`);
  try {
    fn();
    console.log('  PASS');
  } catch (err) {
    failures++;
    console.error(`  ERROR: ${err.message}`);
    console.error(err.stack);
  }
}

/**
 * Create a fresh tmp directory and point OVERTIME_STATE_DIR_TEST at it.
 * Returns { stateDir, projectDir, getModule }.
 * getModule() returns a fresh require of lib/state.js scoped to stateDir.
 */
function setupTmpEnv() {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-state-test-'));
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-project-test-'));

  // Override STATE_DIR for this process — lib/state.js reads this at module load time,
  // so we need to delete it from the require cache and re-require after setting the env.
  process.env.OVERTIME_STATE_DIR_TEST = stateDir;
  // Clear cached module so STATE_DIR is re-evaluated
  const modPath = require.resolve('../../lib/state');
  delete require.cache[modPath];
  const stateModule = require('../../lib/state');

  return { stateDir, projectDir, state: stateModule };
}

function cleanupTmpEnv(stateDir, projectDir) {
  try { fs.rmSync(stateDir, { recursive: true, force: true }); } catch (_) {}
  try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch (_) {}
}

function futureISO(ms) {
  return new Date(Date.now() + ms).toISOString();
}

function pastISO(ms) {
  return new Date(Date.now() - ms).toISOString();
}

// Spawn a short-lived child, wait for it to exit, return the dead PID.
function spawnAndKillChild() {
  const { spawnSync: spawnSyncFn } = require('child_process');
  // Run a process that exits immediately; its PID will be dead afterwards.
  const result = spawnSyncFn('true', [], { encoding: 'utf8' });
  if (result.pid == null || result.pid === 0) {
    throw new Error('spawnAndKillChild: failed to get child PID');
  }
  const pid = result.pid;
  // spawnSync waits for the child to finish, so the PID is guaranteed dead.
  // Verify to be safe.
  let dead = false;
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
      // still alive — tight spin (shouldn't happen after spawnSync)
    } catch (err) {
      if (err.code === 'ESRCH') { dead = true; break; }
    }
  }
  if (!dead) throw new Error(`spawnAndKillChild: PID ${pid} still alive after 2s`);
  return pid;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('create + read round-trip', () => {
  const { stateDir, projectDir, state } = setupTmpEnv();
  try {
    const sessionId = state.create({
      owner: 'overtime',
      mode: 'single',
      pid: process.pid,
      branch: 'overtime/test-123',
      expires_at: futureISO(3600_000),
      settingsBackup: null,
      cursor: null,
      projectRoot: projectDir,
    });

    assert(typeof sessionId === 'string' && sessionId.length > 0, 'sessionId is a non-empty string');

    const s = state.read(sessionId);
    assert(s !== null, 'read returns non-null');
    assertEqual(s.owner, 'overtime', 'owner');
    assertEqual(s.mode, 'single', 'mode');
    assertEqual(s.pid, process.pid, 'pid');
    assertEqual(s.branch, 'overtime/test-123', 'branch');
    assertEqual(s.settingsBackup, null, 'settingsBackup');
    assertEqual(s.cursor, null, 'cursor');
    assertEqual(s.retryCount, 0, 'retryCount');
    assertEqual(s.projectRoot, projectDir, 'projectRoot');
    assert(typeof s.started_at === 'string', 'started_at is a string');
  } finally {
    cleanupTmpEnv(stateDir, projectDir);
  }
});

test('read returns null for missing session', () => {
  const { stateDir, projectDir, state } = setupTmpEnv();
  try {
    const result = state.read('nonexistent-session-id');
    assertEqual(result, null, 'read returns null for missing session');
  } finally {
    cleanupTmpEnv(stateDir, projectDir);
  }
});

test('update merges patches correctly', () => {
  const { stateDir, projectDir, state } = setupTmpEnv();
  try {
    const sessionId = state.create({
      owner: 'backlog',
      mode: 'backlog',
      pid: process.pid,
      branch: 'overtime/bl-456',
      expires_at: futureISO(7200_000),
      settingsBackup: { version: 1 },
      cursor: { phase: 'audit', cycleN: 0 },
      projectRoot: projectDir,
    });

    const updated = state.update(sessionId, { retryCount: 2, cursor: { phase: 'plan', cycleN: 1 } });
    assertEqual(updated.retryCount, 2, 'retryCount updated');
    assertEqual(updated.cursor.phase, 'plan', 'cursor.phase updated');
    assertEqual(updated.cursor.cycleN, 1, 'cursor.cycleN updated');
    // Original fields preserved
    assertEqual(updated.owner, 'backlog', 'owner preserved');
    assertEqual(updated.mode, 'backlog', 'mode preserved');
    assertEqual(updated.branch, 'overtime/bl-456', 'branch preserved');

    // Read back from disk to confirm persistence
    const onDisk = state.read(sessionId);
    assertEqual(onDisk.retryCount, 2, 'retryCount on disk');
    assertEqual(onDisk.cursor.phase, 'plan', 'cursor.phase on disk');
  } finally {
    cleanupTmpEnv(stateDir, projectDir);
  }
});

test('list returns all state files', () => {
  const { stateDir, projectDir, state } = setupTmpEnv();
  try {
    // Start with empty
    assertEqual(state.list().length, 0, 'list starts empty');

    const id1 = state.create({
      owner: 'overtime',
      mode: 'single',
      pid: process.pid,
      branch: 'overtime/a',
      expires_at: futureISO(1000),
      settingsBackup: null,
      projectRoot: projectDir,
    });

    const id2 = state.create({
      owner: 'backlog',
      mode: 'backlog',
      pid: process.pid,
      branch: 'overtime/b',
      expires_at: futureISO(2000),
      settingsBackup: null,
      projectRoot: projectDir,
    });

    const all = state.list();
    assertEqual(all.length, 2, 'list returns 2 sessions');
    const ids = all.map(s => s._sessionId);
    assert(ids.includes(id1), 'list includes id1');
    assert(ids.includes(id2), 'list includes id2');
  } finally {
    cleanupTmpEnv(stateDir, projectDir);
  }
});

test('remove deletes state file', () => {
  const { stateDir, projectDir, state } = setupTmpEnv();
  try {
    const sessionId = state.create({
      owner: 'overtime',
      mode: 'single',
      pid: process.pid,
      branch: 'overtime/del',
      expires_at: futureISO(1000),
      settingsBackup: null,
      projectRoot: projectDir,
    });

    assert(state.read(sessionId) !== null, 'exists before remove');
    state.remove(sessionId);
    assertEqual(state.read(sessionId), null, 'null after remove');
    // Double remove is safe
    state.remove(sessionId);
  } finally {
    cleanupTmpEnv(stateDir, projectDir);
  }
});

test('gcStale removes file with dead PID', () => {
  const { stateDir, projectDir, state } = setupTmpEnv();
  try {
    const deadPid = spawnAndKillChild();

    const sessionId = state.create({
      owner: 'overtime',
      mode: 'single',
      pid: deadPid,
      branch: 'overtime/dead',
      expires_at: futureISO(3600_000), // not expired by time
      settingsBackup: null,
      projectRoot: projectDir,
    });

    const result = state.gcStale();
    assert(result.removed.includes(sessionId), 'gcStale removes dead-PID session');
    assert(result.errors.length === 0, 'no errors');
    assertEqual(state.read(sessionId), null, 'state file deleted');
  } finally {
    cleanupTmpEnv(stateDir, projectDir);
  }
});

test('gcStale removes file with past expires_at', () => {
  const { stateDir, projectDir, state } = setupTmpEnv();
  try {
    // Use process.pid (alive) so this is triggered by expiry, not dead PID
    const sessionId = state.create({
      owner: 'overtime',
      mode: 'single',
      pid: process.pid,
      branch: 'overtime/expired',
      expires_at: pastISO(1000), // 1 second in the past
      settingsBackup: null,
      projectRoot: projectDir,
    });

    const result = state.gcStale();
    assert(result.removed.includes(sessionId), 'gcStale removes expired session');
    assert(result.errors.length === 0, 'no errors');
    assertEqual(state.read(sessionId), null, 'state file deleted');
  } finally {
    cleanupTmpEnv(stateDir, projectDir);
  }
});

test('gcStale restores settingsBackup to projectRoot', () => {
  const { stateDir, projectDir, state } = setupTmpEnv();
  try {
    const settingsBackup = { allowedTools: ['Bash', 'Edit'], version: 42 };

    const sessionId = state.create({
      owner: 'overtime',
      mode: 'single',
      pid: process.pid,
      branch: 'overtime/restore',
      expires_at: pastISO(500), // expired
      settingsBackup,
      projectRoot: projectDir,
    });

    const result = state.gcStale();
    assert(result.removed.includes(sessionId), 'session removed');
    assert(result.errors.length === 0, 'no errors');

    const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
    assert(fs.existsSync(settingsPath), 'settings.local.json restored');
    const written = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assertDeepEqual(written, settingsBackup, 'restored content matches backup');
  } finally {
    cleanupTmpEnv(stateDir, projectDir);
  }
});

test('gcStale deletes settings.local.json when settingsBackup is null', () => {
  const { stateDir, projectDir, state } = setupTmpEnv();
  try {
    // Simulate overtime having created settings.local.json from scratch
    const settingsPath = path.join(projectDir, '.claude', 'settings.local.json');
    fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
    fs.writeFileSync(settingsPath, JSON.stringify({ allowedTools: ['Bash'] }), 'utf8');

    const sessionId = state.create({
      owner: 'overtime',
      mode: 'single',
      pid: process.pid,
      branch: 'overtime/nullbackup',
      expires_at: pastISO(500), // expired
      settingsBackup: null, // overtime created settings.local.json fresh
      projectRoot: projectDir,
    });

    const result = state.gcStale();
    assert(result.removed.includes(sessionId), 'session removed');
    assert(result.errors.length === 0, 'no errors');
    assert(!fs.existsSync(settingsPath), 'settings.local.json deleted when backup was null');
  } finally {
    cleanupTmpEnv(stateDir, projectDir);
  }
});

test('gcStale does not touch live sessions', () => {
  const { stateDir, projectDir, state } = setupTmpEnv();
  try {
    const sessionId = state.create({
      owner: 'overtime',
      mode: 'single',
      pid: process.pid, // alive
      branch: 'overtime/live',
      expires_at: futureISO(3600_000), // not expired
      settingsBackup: null,
      projectRoot: projectDir,
    });

    const result = state.gcStale();
    assertEqual(result.removed.length, 0, 'no sessions removed');
    assert(state.read(sessionId) !== null, 'live session still present');
  } finally {
    cleanupTmpEnv(stateDir, projectDir);
  }
});

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log(`\n${'─'.repeat(50)}`);
console.log(`Results: ${testCount - failures}/${testCount} passed`);
if (failures > 0) {
  console.error(`${failures} test(s) FAILED`);
  process.exit(1);
} else {
  console.log('All tests passed.');
  process.exit(0);
}

'use strict';
/**
 * tests/bin/cli.test.js — CLI integration tests for bin/claude-overtime.js
 *
 * Run with a temp HOME to avoid touching real user settings:
 *   HOME=$(mktemp -d) node tests/bin/cli.test.js
 *
 * Or via npm test (if configured).
 */

const assert      = require('assert');
const { execSync } = require('child_process');
const fs          = require('fs');
const path        = require('path');
const os          = require('os');

// ─── Setup ────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const CLI       = path.join(REPO_ROOT, 'bin', 'claude-overtime.js');

/**
 * Create a temporary HOME directory, run fn, then clean up.
 */
function withTempHome(fn) {
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-overtime-test-'));
  try {
    fn(tmpHome);
  } finally {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
}

/**
 * Run the CLI in a given temp HOME, returning { stdout, stderr, exitCode }.
 */
function cli(args, tmpHome, extraEnv = {}) {
  const env = Object.assign({}, process.env, { HOME: tmpHome }, extraEnv);
  try {
    const stdout = execSync(
      `node ${CLI} ${args}`,
      { env, cwd: REPO_ROOT, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    return { stdout, stderr: '', exitCode: 0 };
  } catch (e) {
    return {
      stdout:   e.stdout  || '',
      stderr:   e.stderr  || '',
      exitCode: e.status  || 1,
    };
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}`);
    console.error('   ', e.message);
    failed++;
  }
}

// ─── Tests ────────────────────────────────────────────────────────────────────

console.log('cli.test.js\n');

// ── install --dry-run ──────────────────────────────────────────────────────

test('install --dry-run exits 0', () => {
  withTempHome(tmpHome => {
    const { exitCode } = cli('install --dry-run', tmpHome);
    assert.strictEqual(exitCode, 0, 'Expected exit code 0');
  });
});

test('install --dry-run prints expected file paths', () => {
  withTempHome(tmpHome => {
    const { stdout } = cli('install --dry-run', tmpHome);
    // Should mention the hook scripts and command
    assert.ok(
      stdout.includes('overtime.md') || stdout.includes('overtime'),
      'Expected overtime command mention in dry-run output'
    );
    assert.ok(
      stdout.includes('claude-overtime-stop') || stdout.includes('stop'),
      'Expected stop hook mention in dry-run output'
    );
  });
});

test('install --dry-run writes no files', () => {
  withTempHome(tmpHome => {
    const claudeDir = path.join(tmpHome, '.claude');
    cli('install --dry-run', tmpHome);
    // ~/.claude/ should either not exist or have nothing meaningful
    if (fs.existsSync(claudeDir)) {
      const files = fs.readdirSync(claudeDir);
      const unexpectedFiles = files.filter(f => f !== 'settings.json');
      // settings.json should NOT be created by dry-run
      const settingsExists = fs.existsSync(path.join(claudeDir, 'settings.json'));
      assert.ok(!settingsExists, 'Dry-run must not write settings.json');
      assert.deepStrictEqual(unexpectedFiles, [], `Dry-run must not create files: ${unexpectedFiles}`);
    }
    // If ~/.claude/ wasn't created at all, that's also fine
  });
});

// ── install idempotency ────────────────────────────────────────────────────

test('install is idempotent (second run is a no-op)', () => {
  withTempHome(tmpHome => {
    // First install
    const r1 = cli('install', tmpHome);
    assert.strictEqual(r1.exitCode, 0, `First install failed: ${r1.stderr}`);

    // Read settings after first install
    const settingsPath = path.join(tmpHome, '.claude', 'settings.json');
    const settings1 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));

    // Second install
    const r2 = cli('install', tmpHome);
    assert.strictEqual(r2.exitCode, 0, `Second install failed: ${r2.stderr}`);

    // Settings should be identical
    const settings2 = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.deepStrictEqual(
      settings1,
      settings2,
      'Second install must not change settings.json'
    );

    // No duplicate hook entries
    const hooks = settings2.hooks || {};
    for (const hookType of ['Stop', 'SessionStart', 'PreToolUse']) {
      const entries = hooks[hookType] || [];
      const tagged = entries.filter(e =>
        JSON.stringify(e).includes('claude-overtime')
      );
      assert.ok(
        tagged.length <= 1,
        `Duplicate entries for ${hookType}: found ${tagged.length}`
      );
    }
  });
});

// ── install + uninstall cleanup ────────────────────────────────────────────

test('uninstall after install removes all installed files', () => {
  withTempHome(tmpHome => {
    const r1 = cli('install', tmpHome);
    assert.strictEqual(r1.exitCode, 0, `install failed: ${r1.stderr}`);

    const r2 = cli('uninstall', tmpHome);
    assert.strictEqual(r2.exitCode, 0, `uninstall failed: ${r2.stderr}`);

    const hooksDir = path.join(tmpHome, '.claude', 'hooks');
    if (fs.existsSync(hooksDir)) {
      const remaining = fs.readdirSync(hooksDir).filter(f =>
        f.startsWith('claude-overtime')
      );
      assert.deepStrictEqual(remaining, [], `Hook files still present: ${remaining}`);
    }

    const commandDest = path.join(tmpHome, '.claude', 'commands', 'overtime.md');
    assert.ok(!fs.existsSync(commandDest), 'overtime.md should be removed after uninstall');
  });
});

test('uninstall preserves unrelated settings.json keys', () => {
  withTempHome(tmpHome => {
    // Write a pre-existing settings.json with unrelated keys
    const claudeDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const settingsPath = path.join(claudeDir, 'settings.json');
    const preExisting = {
      theme: 'dark',
      someOtherKey: { nested: true },
    };
    fs.writeFileSync(settingsPath, JSON.stringify(preExisting, null, 2) + '\n');

    cli('install', tmpHome);
    cli('uninstall', tmpHome);

    const final = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(final.theme, 'dark', 'theme key should be preserved');
    assert.deepStrictEqual(final.someOtherKey, { nested: true }, 'nested key should be preserved');
    assert.ok(!final.statusLine || !JSON.stringify(final.statusLine).includes('claude-overtime'),
      'claude-overtime statusLine entry should be removed');
  });
});

// ── state show with no sessions ───────────────────────────────────────────

test('state show with no sessions prints empty message', () => {
  withTempHome(tmpHome => {
    // Point state dir at a fresh temp dir
    const stateDir = path.join(tmpHome, '.claude', 'overtime-state');
    const { stdout, exitCode } = cli('state show', tmpHome, {
      OVERTIME_STATE_DIR_TEST: stateDir,
    });
    assert.strictEqual(exitCode, 0, `state show failed: stdout=${stdout}`);
    assert.ok(
      stdout.toLowerCase().includes('no active') || stdout.toLowerCase().includes('none') || stdout.trim() === '',
      `Expected empty-session message, got: ${stdout}`
    );
  });
});

// ── config get warnAt ─────────────────────────────────────────────────────

test('config get warnAt returns 90 (default)', () => {
  withTempHome(tmpHome => {
    const stateDir = path.join(tmpHome, '.claude', 'overtime-state');
    const { stdout, exitCode } = cli('config get warnAt', tmpHome, {
      OVERTIME_STATE_DIR_TEST: stateDir,
    });
    assert.strictEqual(exitCode, 0, `config get warnAt failed: ${stdout}`);
    const val = JSON.parse(stdout.trim());
    assert.strictEqual(val, 90, `Expected warnAt=90, got ${val}`);
  });
});

// ── config set + get round-trip ───────────────────────────────────────────

test('config set + get round-trip works', () => {
  withTempHome(tmpHome => {
    cli('config set warnAt 75', tmpHome);
    const { stdout, exitCode } = cli('config get warnAt', tmpHome);
    assert.strictEqual(exitCode, 0);
    assert.strictEqual(JSON.parse(stdout.trim()), 75);
  });
});

// ── config validate ───────────────────────────────────────────────────────

test('config validate exits 0 when no config files', () => {
  withTempHome(tmpHome => {
    const { exitCode } = cli('config validate', tmpHome);
    assert.strictEqual(exitCode, 0);
  });
});

test('config validate exits 1 on bad config', () => {
  withTempHome(tmpHome => {
    const claudeDir = path.join(tmpHome, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(
      path.join(claudeDir, 'overtime-config.json'),
      JSON.stringify({ warnAt: 'not-a-number' }) + '\n'
    );
    const { exitCode } = cli('config validate', tmpHome);
    assert.strictEqual(exitCode, 1, 'Expected exit 1 for invalid config');
  });
});

// ── status exits 0 ────────────────────────────────────────────────────────

test('status exits 0', () => {
  withTempHome(tmpHome => {
    const { exitCode } = cli('status', tmpHome);
    assert.strictEqual(exitCode, 0);
  });
});

// ── help / unknown exits correctly ────────────────────────────────────────

test('unknown subcommand exits non-zero', () => {
  withTempHome(tmpHome => {
    const { exitCode } = cli('notacommand', tmpHome);
    assert.notStrictEqual(exitCode, 0, 'Expected non-zero exit for unknown subcommand');
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}

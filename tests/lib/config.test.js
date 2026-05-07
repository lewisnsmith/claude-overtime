'use strict';
/**
 * tests/lib/config.test.js
 * Plain Node.js tests (no framework). Run with: node tests/lib/config.test.js
 * Exit 0 = all pass. Non-zero = failure.
 */

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// ─── Test harness ─────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    console.log('  PASS:', name);
    passed++;
  } catch (e) {
    console.error('  FAIL:', name);
    console.error('       ', e.message);
    failures.push({ name, error: e });
    failed++;
  }
}

// ─── Module helpers ───────────────────────────────────────────────────────────

const CONFIG_MODULE = require.resolve('../../lib/config.js');

function clearModuleCache() {
  delete require.cache[CONFIG_MODULE];
}

/**
 * Load a fresh config module with `os.homedir()` → tmpGlobal and `cwd()` → tmpProject.
 * Patches persist for the duration of the callback fn, then are restored.
 * Returns whatever fn returns.
 */
function withTmpDirs({ globalDir, projectDir }, fn) {
  const origHomedir = os.homedir;
  const origCwd = process.cwd;

  os.homedir = () => globalDir;
  process.cwd = () => projectDir;

  clearModuleCache();
  const config = require(CONFIG_MODULE);

  // capture stderr
  const stderrLines = [];
  const origWrite = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk) => { stderrLines.push(String(chunk)); return true; };

  let result;
  try {
    result = fn(config, stderrLines);
  } finally {
    process.stderr.write = origWrite;
    os.homedir = origHomedir;
    process.cwd = origCwd;
    clearModuleCache();
  }

  return result;
}

/**
 * Creates two fresh tmp dirs (global, project), optionally writes config JSON
 * into each, then calls withTmpDirs.
 */
function runWithTmpConfigs({ globalConfig, projectConfig } = {}, fn) {
  const tmpGlobal  = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-g-'));
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-p-'));

  if (globalConfig !== undefined) {
    // GLOBAL_CONFIG_PATH = os.homedir()/.claude/overtime-config.json
    // tmpGlobal acts as the HOME dir, so the config lives in .claude subdir
    const gDir = path.join(tmpGlobal, '.claude');
    fs.mkdirSync(gDir, { recursive: true });
    const gPath = path.join(gDir, 'overtime-config.json');
    fs.writeFileSync(gPath, JSON.stringify(globalConfig, null, 2) + '\n', 'utf8');
  }
  if (projectConfig !== undefined) {
    const pDir = path.join(tmpProject, '.claude');
    fs.mkdirSync(pDir, { recursive: true });
    const pPath = path.join(pDir, 'overtime-config.json');
    fs.writeFileSync(pPath, JSON.stringify(projectConfig, null, 2) + '\n', 'utf8');
  }

  return withTmpDirs({ globalDir: tmpGlobal, projectDir: tmpProject }, (config, stderrLines) => {
    return fn(config, stderrLines, tmpGlobal, tmpProject);
  });
}

// ─── Tests ───────────────────────────────────────────────────────────────────

console.log('\nRunning tests/lib/config.test.js\n');

// 1. CONFIG_DEFAULTS round-trip
test('CONFIG_DEFAULTS has all expected keys with correct defaults', () => {
  clearModuleCache();
  const { CONFIG_DEFAULTS } = require(CONFIG_MODULE);
  clearModuleCache();

  assert.strictEqual(CONFIG_DEFAULTS.defaultDelay,   'auto');
  assert.strictEqual(CONFIG_DEFAULTS.delayBuffer,    '5m');
  assert.strictEqual(CONFIG_DEFAULTS.warnAt,         90);
  assert.strictEqual(CONFIG_DEFAULTS.maxRetries,     5);
  assert.strictEqual(CONFIG_DEFAULTS.abortBehavior,  'stop');
  assert.strictEqual(CONFIG_DEFAULTS.autoOvertime,   false);
  assert.deepStrictEqual(CONFIG_DEFAULTS.customRules,      []);
  assert.strictEqual(CONFIG_DEFAULTS.prTitlePrefix,  'overtime: ');
  assert.strictEqual(CONFIG_DEFAULTS.prBodyTemplate, '{{log}}');
  assert.deepStrictEqual(CONFIG_DEFAULTS.protectedBranches, []);
  assert.deepStrictEqual(CONFIG_DEFAULTS.editAllowGlobs,   ['**/*']);
  assert.deepStrictEqual(CONFIG_DEFAULTS.editDenyGlobs,    ['node_modules/**', '.git/**', '**/.env*']);
});

// 2. loadMerged with no config files returns frozen defaults
test('loadMerged with no config files returns frozen defaults', () => {
  runWithTmpConfigs({}, (config) => {
    const merged = config.loadMerged();

    assert.strictEqual(merged.defaultDelay, 'auto');
    assert.strictEqual(merged.warnAt, 90);
    assert.strictEqual(merged.maxRetries, 5);
    assert.deepStrictEqual(merged.customRules, []);
    assert.deepStrictEqual(merged.protectedBranches, []);
    assert.strictEqual(Object.isFrozen(merged), true);
  });
});

// 3. Global config overridden by project config (scalar)
test('project config overrides global config for scalar keys', () => {
  runWithTmpConfigs({
    globalConfig:  { defaultDelay: '3h', warnAt: 80 },
    projectConfig: { defaultDelay: '1h' },
  }, (config) => {
    const merged = config.loadMerged();
    assert.strictEqual(merged.defaultDelay, '1h', 'project should override global for defaultDelay');
    assert.strictEqual(merged.warnAt, 80,          'global value kept when project does not override');
  });
});

// 4. customRules concatenates across layers
test('customRules concatenates: global + project (not override)', () => {
  runWithTmpConfigs({
    globalConfig:  { customRules: ['rule-A', 'rule-B'] },
    projectConfig: { customRules: ['rule-C'] },
  }, (config) => {
    const merged = config.loadMerged();
    assert.deepStrictEqual(merged.customRules, ['rule-A', 'rule-B', 'rule-C']);
  });
});

// 5. customRules with empty global
test('customRules works when only project has rules', () => {
  runWithTmpConfigs({
    globalConfig:  {},
    projectConfig: { customRules: ['proj-rule'] },
  }, (config) => {
    const merged = config.loadMerged();
    assert.deepStrictEqual(merged.customRules, ['proj-rule']);
  });
});

// 6. protectedBranches set globally → rejected with stderr warning
test('protectedBranches in global config is ignored with stderr warning', () => {
  runWithTmpConfigs({
    globalConfig:  { protectedBranches: ['main', 'production'] },
    projectConfig: {},
  }, (config, stderrLines) => {
    const merged = config.loadMerged();

    // protectedBranches should be [] (project has none)
    assert.deepStrictEqual(merged.protectedBranches, [], 'global protectedBranches must be ignored');

    // At least one warning should mention protectedBranches
    const warnText = stderrLines.join('');
    assert.ok(
      warnText.includes('protectedBranches'),
      'expected stderr warning about protectedBranches being project-only, got: ' + warnText
    );
  });
});

// 7. protectedBranches set in project config is respected
test('protectedBranches in project config is respected', () => {
  runWithTmpConfigs({
    globalConfig:  {},
    projectConfig: { protectedBranches: ['release', 'staging'] },
  }, (config) => {
    const merged = config.loadMerged();
    assert.deepStrictEqual(merged.protectedBranches, ['release', 'staging']);
  });
});

// 8. validate: valid object returns empty array
test('validate returns [] for valid config', () => {
  clearModuleCache();
  const { validate } = require(CONFIG_MODULE);
  clearModuleCache();

  const errors = validate({
    defaultDelay: 'auto',
    delayBuffer: '10m',
    warnAt: 75,
    maxRetries: 3,
    abortBehavior: 'continue',
    autoOvertime: true,
    customRules: ['rule1'],
    prTitlePrefix: 'wip: ',
    prBodyTemplate: '{{snapshot}}',
    protectedBranches: ['main'],
    editAllowGlobs: ['src/**'],
    editDenyGlobs: ['*.secret'],
  });

  assert.deepStrictEqual(errors, []);
});

// 9. validate: bad warnAt (out of range high)
test('validate rejects warnAt > 100', () => {
  clearModuleCache();
  const { validate } = require(CONFIG_MODULE);
  clearModuleCache();

  const errors = validate({ warnAt: 150 });
  assert.ok(errors.length > 0, 'expected validation error for warnAt=150');
  assert.ok(errors.some(e => e.includes('warnAt')), 'error should mention warnAt');
});

// 10. validate: bad warnAt (negative)
test('validate rejects warnAt < 0', () => {
  clearModuleCache();
  const { validate } = require(CONFIG_MODULE);
  clearModuleCache();

  const errors = validate({ warnAt: -5 });
  assert.ok(errors.length > 0, 'expected validation error for warnAt=-5');
  assert.ok(errors.some(e => e.includes('warnAt')));
});

// 11. validate: bad abortBehavior enum
test('validate rejects invalid abortBehavior', () => {
  clearModuleCache();
  const { validate } = require(CONFIG_MODULE);
  clearModuleCache();

  const errors = validate({ abortBehavior: 'restart' });
  assert.ok(errors.length > 0, 'expected validation error for unknown abortBehavior');
  assert.ok(errors.some(e => e.includes('abortBehavior')));
});

// 12. validate: non-array customRules
test('validate rejects non-array customRules', () => {
  clearModuleCache();
  const { validate } = require(CONFIG_MODULE);
  clearModuleCache();

  const errors = validate({ customRules: 'not-an-array' });
  assert.ok(errors.length > 0, 'expected validation error for customRules as string');
  assert.ok(errors.some(e => e.includes('customRules')));
});

// 13. malformed global JSON file → defaults + stderr warning
test('malformed global config file falls back to defaults with warning', () => {
  const tmpGlobal  = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-g-'));
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-p-'));

  // Write malformed JSON to the correct path (HOME/.claude/overtime-config.json)
  const badDir = path.join(tmpGlobal, '.claude');
  fs.mkdirSync(badDir, { recursive: true });
  fs.writeFileSync(path.join(badDir, 'overtime-config.json'), '{ this is not json !!', 'utf8');

  withTmpDirs({ globalDir: tmpGlobal, projectDir: tmpProject }, (config, stderrLines) => {
    const merged = config.loadMerged();

    assert.strictEqual(merged.defaultDelay, 'auto', 'defaults should be returned on malformed file');
    assert.strictEqual(merged.warnAt, 90);

    // The parse warning fires during _readFileConfig
    const warnText = stderrLines.join('');
    assert.ok(warnText.length > 0, 'expected some stderr output for malformed config');
  });
});

// 14. malformed project config → uses global + defaults (no throw)
test('malformed project config falls back gracefully', () => {
  const tmpGlobal  = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-g-'));
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-p-'));

  // Valid global config (HOME/.claude/overtime-config.json)
  const gDir = path.join(tmpGlobal, '.claude');
  fs.mkdirSync(gDir, { recursive: true });
  fs.writeFileSync(path.join(gDir, 'overtime-config.json'),
    JSON.stringify({ warnAt: 85 }, null, 2) + '\n', 'utf8');

  // Malformed project config
  const badProjectDir = path.join(tmpProject, '.claude');
  fs.mkdirSync(badProjectDir, { recursive: true });
  fs.writeFileSync(path.join(badProjectDir, 'overtime-config.json'), 'INVALID JSON {{{', 'utf8');

  withTmpDirs({ globalDir: tmpGlobal, projectDir: tmpProject }, (config) => {
    let merged;
    assert.doesNotThrow(() => { merged = config.loadMerged(); }, 'loadMerged must not throw on bad project config');
    assert.strictEqual(merged.warnAt, 85, 'global config warnAt should survive bad project config');
  });
});

// 15. set validates before write (bad value throws, file not created)
test('set rejects invalid value and does not write to disk', () => {
  runWithTmpConfigs({}, (config, _stderr, tmpGlobal) => {
    // GLOBAL_CONFIG_PATH = HOME/.claude/overtime-config.json
    const globalConfigPath = path.join(tmpGlobal, '.claude', 'overtime-config.json');

    assert.throws(
      () => config.set('global', 'abortBehavior', 'explode'),
      /Validation failed/,
      'set with bad abortBehavior value must throw'
    );

    assert.strictEqual(fs.existsSync(globalConfigPath), false,
      'config file should not be created on validation failure');
  });
});

// 16. set coerces string "true" to boolean for autoOvertime
test('set coerces string "true" to boolean for autoOvertime', () => {
  runWithTmpConfigs({}, (config, _stderr, tmpGlobal) => {
    // GLOBAL_CONFIG_PATH = HOME/.claude/overtime-config.json
    const globalConfigPath = path.join(tmpGlobal, '.claude', 'overtime-config.json');

    config.set('global', 'autoOvertime', 'true');

    const written = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'));
    assert.strictEqual(written.autoOvertime, true, 'autoOvertime should be stored as boolean true');
  });
});

// 17. set coerces string number for warnAt
test('set coerces string "75" to number for warnAt', () => {
  runWithTmpConfigs({}, (config, _stderr, tmpGlobal) => {
    // GLOBAL_CONFIG_PATH = HOME/.claude/overtime-config.json
    const globalConfigPath = path.join(tmpGlobal, '.claude', 'overtime-config.json');

    config.set('global', 'warnAt', '75');

    const written = JSON.parse(fs.readFileSync(globalConfigPath, 'utf8'));
    assert.strictEqual(written.warnAt, 75);
    assert.strictEqual(typeof written.warnAt, 'number');
  });
});

// 18. set refuses protectedBranches globally with warning
test('set(global, protectedBranches, ...) warns and does not write', () => {
  runWithTmpConfigs({}, (config, stderrLines, tmpGlobal) => {
    const globalConfigPath = path.join(tmpGlobal, '.claude', 'overtime-config.json');

    config.set('global', 'protectedBranches', '["main"]');

    assert.strictEqual(fs.existsSync(globalConfigPath), false,
      'no file should be written when setting protectedBranches globally');

    const warnText = stderrLines.join('');
    assert.ok(warnText.includes('protectedBranches'),
      'expected warning about protectedBranches being project-only');
  });
});

// 19. GLOBAL_CONFIG_PATH export is a string pointing into homedir
test('GLOBAL_CONFIG_PATH export reflects current homedir', () => {
  const tmpGlobal  = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-g-'));
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-p-'));

  withTmpDirs({ globalDir: tmpGlobal, projectDir: tmpProject }, (config) => {
    const p = config.GLOBAL_CONFIG_PATH;
    assert.ok(p.startsWith(tmpGlobal), 'GLOBAL_CONFIG_PATH should be inside tmpGlobal, got: ' + p);
    assert.ok(p.endsWith('overtime-config.json'));
  });
});

// 20. PROJECT_CONFIG_PATH() is a function returning path inside cwd
test('PROJECT_CONFIG_PATH() returns path inside cwd', () => {
  const tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-p-'));
  const tmpGlobal  = fs.mkdtempSync(path.join(os.tmpdir(), 'overtime-g-'));

  withTmpDirs({ globalDir: tmpGlobal, projectDir: tmpProject }, (config) => {
    const p = config.PROJECT_CONFIG_PATH();
    assert.ok(p.startsWith(tmpProject), 'PROJECT_CONFIG_PATH() should be inside cwd, got: ' + p);
    assert.ok(p.endsWith('overtime-config.json'));
  });
});

// ─── Summary ─────────────────────────────────────────────────────────────────

console.log('\n─────────────────────────────────────────');
console.log(`Results: ${passed} passed, ${failed} failed`);

if (failed > 0) {
  console.error('\nFailed tests:');
  failures.forEach(f => {
    console.error('  •', f.name);
    console.error('    ', f.error.message);
  });
  process.exit(1);
} else {
  console.log('All tests passed.');
  process.exit(0);
}

'use strict';
/**
 * lib/config.js — centralized config loader, validator, and writer for claude-overtime.
 *
 * Merge precedence (lower wins at conflict):
 *   defaults → global (~/.claude/overtime-config.json) → project (<cwd>/.claude/overtime-config.json)
 *
 * Special merge rules:
 *   - customRules: arrays CONCATENATE across layers (deduplicated by position, not value)
 *   - protectedBranches: project-only; if set in global config it is silently dropped + stderr warning
 *   - editAllowGlobs, editDenyGlobs: override (project wins over global)
 *   - all other scalars: override
 *
 * Malformed config files: return empty object for that layer + warn to stderr; never throw.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Paths ────────────────────────────────────────────────────────────────────

/**
 * GLOBAL_CONFIG_PATH is evaluated lazily via a getter so that tests can
 * redirect os.homedir() before the value is read.
 *
 * We expose it as a string-like property that is computed on first access
 * within each call-site. For the exported constant we use a getter on the
 * exports object (set at the bottom of the file).
 *
 * Internal usage must call _globalConfigPath() to get the current path.
 */
function _globalConfigPath() {
  return path.join(os.homedir(), '.claude', 'overtime-config.json');
}

/** Returns the absolute path to the project-level config for the current cwd. */
function PROJECT_CONFIG_PATH() {
  return path.join(process.cwd(), '.claude', 'overtime-config.json');
}

// Backwards-compatible string accessor (used by external callers that read
// the export at call time rather than module load time).
// The actual getter is attached to module.exports below.
const GLOBAL_CONFIG_PATH = _globalConfigPath();

// ─── Defaults ────────────────────────────────────────────────────────────────

const CONFIG_DEFAULTS = Object.freeze({
  defaultDelay:      'auto',
  delayBuffer:       '5m',
  warnAt:            90,
  maxRetries:        5,
  abortBehavior:     'stop',
  autoOvertime:      false,
  customRules:       [],
  prTitlePrefix:     'overtime: ',
  prBodyTemplate:    '{{log}}',
  protectedBranches: [],
  editAllowGlobs:    ['**/*'],
  editDenyGlobs:     ['node_modules/**', '.git/**', '**/.env*'],
});

// ─── Validation ──────────────────────────────────────────────────────────────

/**
 * validate(obj) — validates a raw config object (partial or full).
 * Returns an array of human-readable error strings; empty array = valid.
 */
function validate(obj) {
  const errors = [];

  if ('defaultDelay' in obj) {
    if (typeof obj.defaultDelay !== 'string') {
      errors.push('defaultDelay must be a string (e.g. "auto", "5h", "90m")');
    }
  }

  if ('delayBuffer' in obj) {
    if (typeof obj.delayBuffer !== 'string') {
      errors.push('delayBuffer must be a string (e.g. "5m", "10m")');
    }
  }

  if ('warnAt' in obj) {
    if (typeof obj.warnAt !== 'number' || isNaN(obj.warnAt)) {
      errors.push('warnAt must be a number (0–100 percentage)');
    } else if (obj.warnAt < 0 || obj.warnAt > 100) {
      errors.push('warnAt must be between 0 and 100 (percentage of 5h window)');
    }
  }

  if ('maxRetries' in obj) {
    if (typeof obj.maxRetries !== 'number' || isNaN(obj.maxRetries) || !Number.isInteger(obj.maxRetries)) {
      errors.push('maxRetries must be an integer');
    } else if (obj.maxRetries < 0) {
      errors.push('maxRetries must be >= 0');
    }
  }

  if ('abortBehavior' in obj) {
    if (!['stop', 'continue'].includes(obj.abortBehavior)) {
      errors.push('abortBehavior must be "stop" or "continue", got "' + obj.abortBehavior + '"');
    }
  }

  if ('autoOvertime' in obj) {
    if (typeof obj.autoOvertime !== 'boolean') {
      errors.push('autoOvertime must be a boolean');
    }
  }

  if ('customRules' in obj) {
    if (!Array.isArray(obj.customRules)) {
      errors.push('customRules must be an array of strings');
    } else if (!obj.customRules.every(r => typeof r === 'string')) {
      errors.push('customRules: every element must be a string');
    }
  }

  if ('prTitlePrefix' in obj) {
    if (typeof obj.prTitlePrefix !== 'string') {
      errors.push('prTitlePrefix must be a string');
    }
  }

  if ('prBodyTemplate' in obj) {
    if (typeof obj.prBodyTemplate !== 'string') {
      errors.push('prBodyTemplate must be a string (use {{log}} or {{snapshot}} as placeholders)');
    }
  }

  if ('protectedBranches' in obj) {
    if (!Array.isArray(obj.protectedBranches)) {
      errors.push('protectedBranches must be an array of strings');
    } else if (!obj.protectedBranches.every(b => typeof b === 'string')) {
      errors.push('protectedBranches: every element must be a string');
    }
  }

  if ('editAllowGlobs' in obj) {
    if (!Array.isArray(obj.editAllowGlobs)) {
      errors.push('editAllowGlobs must be an array of glob strings');
    } else if (!obj.editAllowGlobs.every(g => typeof g === 'string')) {
      errors.push('editAllowGlobs: every element must be a string');
    }
  }

  if ('editDenyGlobs' in obj) {
    if (!Array.isArray(obj.editDenyGlobs)) {
      errors.push('editDenyGlobs must be an array of glob strings');
    } else if (!obj.editDenyGlobs.every(g => typeof g === 'string')) {
      errors.push('editDenyGlobs: every element must be a string');
    }
  }

  return errors;
}

// ─── Internal helpers ────────────────────────────────────────────────────────

/**
 * Reads and parses a JSON config file. On any error returns {} and warns to stderr.
 */
function _readFileConfig(configPath) {
  try {
    if (!fs.existsSync(configPath)) return {};
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    process.stderr.write(
      'claude-overtime: Warning: could not parse config file ' + configPath + ' — ' + e.message + '\n' +
      '  Using defaults for this layer.\n'
    );
    return {};
  }
}

/**
 * Writes a config object to disk for the given scope.
 */
function _writeFileConfig(configPath, data) {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/**
 * Merges defaults, global config, and project config into one object.
 * Applies special merge rules (customRules concat, protectedBranches project-only).
 */
function _merge(globalCfg, projectCfg) {
  // Warn if global config tries to set protectedBranches (security policy: project-only)
  if ('protectedBranches' in globalCfg && Array.isArray(globalCfg.protectedBranches) && globalCfg.protectedBranches.length > 0) {
    process.stderr.write(
      'claude-overtime: Warning: protectedBranches is project-only and cannot be set globally.\n' +
      '  Set it in <project>/.claude/overtime-config.json instead. Ignoring global value.\n'
    );
  }

  // Start with defaults
  const merged = Object.assign({}, CONFIG_DEFAULTS);

  // Apply global scalars (excluding protectedBranches which is project-only)
  for (const key of Object.keys(globalCfg)) {
    if (key === 'protectedBranches') continue; // silently skip after warning above
    if (key === 'customRules') continue;        // handled separately
    merged[key] = globalCfg[key];
  }

  // Apply project scalars
  for (const key of Object.keys(projectCfg)) {
    if (key === 'customRules') continue; // handled separately
    merged[key] = projectCfg[key];
  }

  // Concatenate customRules: defaults(empty) + global + project
  const globalRules  = Array.isArray(globalCfg.customRules)  ? globalCfg.customRules  : [];
  const projectRules = Array.isArray(projectCfg.customRules) ? projectCfg.customRules : [];
  merged.customRules = [...globalRules, ...projectRules];

  // protectedBranches: project-only; use project value or default []
  merged.protectedBranches = Array.isArray(projectCfg.protectedBranches)
    ? projectCfg.protectedBranches
    : [];

  return merged;
}

// ─── Type coercion for `set` ─────────────────────────────────────────────────

/**
 * Parses a raw string value into the appropriate JS type for the given config key.
 * Throws a descriptive Error if coercion fails.
 */
function _coerce(key, rawValue) {
  // Determine expected type from defaults
  const defaultVal = CONFIG_DEFAULTS[key];

  if (typeof defaultVal === 'number') {
    // warnAt, maxRetries
    const n = key === 'maxRetries'
      ? parseInt(rawValue, 10)
      : parseFloat(rawValue);
    if (isNaN(n)) throw new Error(key + ' must be a number, got: ' + rawValue);
    return n;
  }

  if (typeof defaultVal === 'boolean') {
    // autoOvertime
    if (rawValue === 'true' || rawValue === '1') return true;
    if (rawValue === 'false' || rawValue === '0') return false;
    throw new Error(key + ' must be true or false, got: ' + rawValue);
  }

  if (Array.isArray(defaultVal)) {
    // customRules, protectedBranches, editAllowGlobs, editDenyGlobs
    if (rawValue.trimStart().startsWith('[')) {
      try {
        const parsed = JSON.parse(rawValue);
        if (!Array.isArray(parsed)) throw new Error('Expected JSON array');
        return parsed;
      } catch (e) {
        throw new Error('Could not parse JSON array for ' + key + ': ' + e.message);
      }
    }
    // Single string → return as single-element array
    // (callers that want append semantics should read first, then pass full array)
    return [rawValue];
  }

  // string (defaultDelay, delayBuffer, abortBehavior, prTitlePrefix, prBodyTemplate)
  return rawValue;
}

// ─── Public API ──────────────────────────────────────────────────────────────

/**
 * loadMerged() — loads both config files, merges, validates, and returns a frozen object.
 * On validation errors it emits stderr warnings and returns the merged (possibly partially
 * invalid) config anyway — sessions must continue, `config validate` is the strict gate.
 */
function loadMerged() {
  const globalCfg  = _readFileConfig(_globalConfigPath());
  const projectCfg = _readFileConfig(PROJECT_CONFIG_PATH());
  const merged = _merge(globalCfg, projectCfg);

  // Warn on validation errors but don't crash
  const errors = validate(merged);
  if (errors.length > 0) {
    process.stderr.write(
      'claude-overtime: Warning: merged config has validation errors:\n' +
      errors.map(e => '  • ' + e).join('\n') + '\n' +
      '  Run `claude-overtime config validate` for details.\n'
    );
  }

  return Object.freeze(merged);
}

/**
 * get(key?) — returns the value for key from the merged config, or the full merged config
 * if no key is supplied.
 */
function get(key) {
  const merged = loadMerged();
  if (key === undefined || key === null) return merged;
  return merged[key];
}

/**
 * set(scope, key, value) — validates and writes a config key.
 * scope: "global" | "project"
 * value: raw string (will be coerced) OR already-typed JS value.
 * Throws an Error if validation fails (does not write bad values to disk).
 */
function set(scope, key, value) {
  if (scope !== 'global' && scope !== 'project') {
    throw new Error('scope must be "global" or "project", got: ' + scope);
  }
  if (!(key in CONFIG_DEFAULTS)) {
    throw new Error('Unknown config key: ' + key + '. Valid keys: ' + Object.keys(CONFIG_DEFAULTS).join(', '));
  }

  const configPath = scope === 'global' ? _globalConfigPath() : PROJECT_CONFIG_PATH();

  // Coerce if raw string, otherwise accept typed value directly
  let coerced;
  if (typeof value === 'string') {
    coerced = _coerce(key, value);
  } else {
    coerced = value;
  }

  // Warn about protectedBranches in global scope — don't write it
  if (key === 'protectedBranches' && scope === 'global') {
    process.stderr.write(
      'claude-overtime: Warning: protectedBranches is project-only and cannot be set globally. Ignoring.\n'
    );
    return;
  }

  // Read existing, merge, validate, then write
  const existing = _readFileConfig(configPath);
  const updated = Object.assign({}, existing, { [key]: coerced });

  const errors = validate(updated);
  if (errors.length > 0) {
    throw new Error('Validation failed:\n' + errors.map(e => '  • ' + e).join('\n'));
  }

  _writeFileConfig(configPath, updated);
}

// ─── Exports ─────────────────────────────────────────────────────────────────

const exports_ = {
  loadMerged,
  get,
  set,
  validate,
  CONFIG_DEFAULTS,
  PROJECT_CONFIG_PATH,
};

// GLOBAL_CONFIG_PATH is a dynamic getter so external code reading it after
// os.homedir() has been redirected (e.g. in tests) gets the correct path.
Object.defineProperty(exports_, 'GLOBAL_CONFIG_PATH', {
  get: _globalConfigPath,
  enumerable: true,
});

module.exports = exports_;

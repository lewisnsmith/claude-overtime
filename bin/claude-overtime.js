#!/usr/bin/env node
/**
 * claude-overtime CLI
 * Usage:
 *   claude-overtime install          - install the /overtime command and rate limit hook
 *   claude-overtime uninstall        - remove everything
 *   claude-overtime status           - show current install state
 *   claude-overtime config init      - scaffold global config with defaults
 *   claude-overtime config get [key] - print merged config or a single key
 *   claude-overtime config set <key> <value> [--project] - update config
 *   claude-overtime config validate  - check config files for errors
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const SILENT = process.argv.includes('--silent');
const log = (...args) => { if (!SILENT) console.log(...args); };
const err = (...args) => console.error(...args);

const HOME = os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const COMMANDS_DIR = path.join(CLAUDE_DIR, 'commands');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');

const HOOK_SRC = path.join(__dirname, '..', 'hooks', 'rate-limit-warn.sh');
const HOOK_DEST = path.join(CLAUDE_DIR, 'hooks', 'claude-overtime-rate-limit-warn.sh');
const STATUSLINE_SRC = path.join(__dirname, '..', 'hooks', 'overtime-statusline.sh');
const STATUSLINE_DEST = path.join(CLAUDE_DIR, 'hooks', 'claude-overtime-statusline.sh');
const COMMAND_SRC = path.join(__dirname, '..', 'commands', 'overtime.md');
const COMMAND_DEST = path.join(COMMANDS_DIR, 'overtime.md');

const GLOBAL_CONFIG_PATH = path.join(CLAUDE_DIR, 'overtime-config.json');
const CONFIG_DEFAULTS = {
  defaultDelay: '5h',
  warnAt: 90000,
  maxRetries: 5,
  abortBehavior: 'stop',
  customRules: [],
  prTitlePrefix: 'overtime: ',
  prBodyTemplate: '{{log}}',
  protectedBranches: [],
};

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch (e) {
    err('Warning: could not parse', SETTINGS_PATH, '-', e.message);
  }
  return {};
}

function writeSettings(settings) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

function readConfig(scope) {
  const configPath = scope === 'global'
    ? GLOBAL_CONFIG_PATH
    : path.join(process.cwd(), '.claude', 'overtime-config.json');
  try {
    if (fs.existsSync(configPath)) {
      return JSON.parse(fs.readFileSync(configPath, 'utf8'));
    }
  } catch (e) {
    err('Warning: could not parse', configPath, '-', e.message);
  }
  return {};
}

function writeConfig(scope, data) {
  const configPath = scope === 'global'
    ? GLOBAL_CONFIG_PATH
    : path.join(process.cwd(), '.claude', 'overtime-config.json');
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function mergeConfigs(global, project) {
  const merged = Object.assign({}, CONFIG_DEFAULTS, global, project);
  merged.customRules = [
    ...(Array.isArray(global.customRules) ? global.customRules : []),
    ...(Array.isArray(project.customRules) ? project.customRules : []),
  ];
  merged.protectedBranches = Array.isArray(project.protectedBranches)
    ? project.protectedBranches
    : [];
  return merged;
}

function validateConfig(obj) {
  const errors = [];
  if ('defaultDelay' in obj && typeof obj.defaultDelay !== 'string') {
    errors.push('defaultDelay must be a string (e.g. "5h", "90m")');
  }
  if ('warnAt' in obj && (typeof obj.warnAt !== 'number' || isNaN(obj.warnAt))) {
    errors.push('warnAt must be a number');
  }
  if ('maxRetries' in obj && (typeof obj.maxRetries !== 'number' || isNaN(obj.maxRetries))) {
    errors.push('maxRetries must be a number');
  }
  if ('abortBehavior' in obj && !['stop', 'continue'].includes(obj.abortBehavior)) {
    errors.push('abortBehavior must be "stop" or "continue", got "' + obj.abortBehavior + '"');
  }
  if ('customRules' in obj && !Array.isArray(obj.customRules)) {
    errors.push('customRules must be an array of strings');
  }
  if ('prTitlePrefix' in obj && typeof obj.prTitlePrefix !== 'string') {
    errors.push('prTitlePrefix must be a string');
  }
  if ('prBodyTemplate' in obj && typeof obj.prBodyTemplate !== 'string') {
    errors.push('prBodyTemplate must be a string (use {{log}} as placeholder)');
  }
  if ('protectedBranches' in obj && !Array.isArray(obj.protectedBranches)) {
    errors.push('protectedBranches must be an array of strings');
  }
  return errors;
}

function configCmd(args) {
  const sub = args[0];

  if (sub === 'init') {
    const isProject = args.includes('--project');
    const force = args.includes('--force');
    const scope = isProject ? 'project' : 'global';
    const configPath = scope === 'global'
      ? GLOBAL_CONFIG_PATH
      : path.join(process.cwd(), '.claude', 'overtime-config.json');

    if (fs.existsSync(configPath) && !force) {
      console.log('Config already exists:', configPath);
      console.log('Use --force to overwrite with defaults.');
      return;
    }
    writeConfig(scope, CONFIG_DEFAULTS);
    console.log('Created', configPath);
    return;
  }

  if (sub === 'get') {
    const key = args[1];
    const merged = mergeConfigs(readConfig('global'), readConfig('project'));
    if (key) {
      if (!(key in merged)) {
        err('Unknown config key:', key);
        process.exit(1);
      }
      console.log(JSON.stringify(merged[key], null, 2));
    } else {
      console.log(JSON.stringify(merged, null, 2));
    }
    return;
  }

  if (sub === 'set') {
    const isProject = args.includes('--project');
    const scope = isProject ? 'project' : 'global';
    const filteredArgs = args.filter(a => a !== '--project');
    const key = filteredArgs[1];
    const rawValue = filteredArgs[2];

    if (!key || rawValue === undefined) {
      err('Usage: claude-overtime config set <key> <value> [--project]');
      process.exit(1);
    }
    if (!(key in CONFIG_DEFAULTS)) {
      err('Unknown config key:', key);
      err('Valid keys:', Object.keys(CONFIG_DEFAULTS).join(', '));
      process.exit(1);
    }

    const existing = readConfig(scope);
    let coerced;
    if (key === 'warnAt' || key === 'maxRetries') {
      coerced = parseInt(rawValue, 10);
      if (isNaN(coerced)) {
        err('Error:', key, 'must be a number');
        process.exit(1);
      }
    } else if (key === 'customRules' || key === 'protectedBranches') {
      if (rawValue.startsWith('[')) {
        try {
          coerced = JSON.parse(rawValue);
        } catch (e) {
          err('Error: could not parse JSON array:', e.message);
          process.exit(1);
        }
      } else {
        // Append mode: add single string to existing array
        const current = Array.isArray(existing[key]) ? existing[key] : [];
        coerced = [...current, rawValue];
      }
    } else {
      coerced = rawValue;
    }

    const updated = Object.assign({}, existing, { [key]: coerced });
    const errors = validateConfig(updated);
    if (errors.length > 0) {
      errors.forEach(e => err('Error:', e));
      process.exit(1);
    }
    writeConfig(scope, updated);
    console.log('Set', key, '=', JSON.stringify(coerced), 'in', scope, 'config');
    return;
  }

  if (sub === 'validate') {
    const globalCfg = readConfig('global');
    const projectCfg = readConfig('project');
    const allErrors = [];
    const ge = validateConfig(globalCfg);
    const pe = validateConfig(projectCfg);
    ge.forEach(e => allErrors.push('Global: ' + e));
    pe.forEach(e => allErrors.push('Project: ' + e));
    if (allErrors.length === 0) {
      console.log('Configs valid.');
    } else {
      allErrors.forEach(e => err(e));
      process.exit(1);
    }
    return;
  }

  err('Usage: claude-overtime config <init|get|set|validate>');
  process.exit(1);
}

function install() {
  log('Installing claude-overtime...\n');

  // 1. Copy slash commands
  fs.mkdirSync(COMMANDS_DIR, { recursive: true });
  fs.copyFileSync(COMMAND_SRC, COMMAND_DEST);
  log('  ✓ Installed /overtime command →', COMMAND_DEST);

  // 2. Copy hook script
  const hooksDir = path.join(CLAUDE_DIR, 'hooks');
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.copyFileSync(HOOK_SRC, HOOK_DEST);
  fs.chmodSync(HOOK_DEST, 0o755);
  log('  ✓ Installed rate-limit hook  →', HOOK_DEST);

  // 3. Register the Stop hook in settings.json
  const settings = readSettings();
  if (!settings.hooks) settings.hooks = {};
  if (!settings.hooks.Stop) settings.hooks.Stop = [];

  const hookEntry = {
    matcher: '',
    hooks: [
      {
        type: 'command',
        command: HOOK_DEST
      }
    ]
  };

  // Avoid duplicate entries
  const alreadyRegistered = (settings.hooks.Stop || []).some(
    h => JSON.stringify(h).includes('claude-overtime-rate-limit-warn')
  );

  if (!alreadyRegistered) {
    settings.hooks.Stop = [...(settings.hooks.Stop || []), hookEntry];
    log('  ✓ Registered Stop hook       →', SETTINGS_PATH);
  } else {
    log('  · Stop hook already registered in', SETTINGS_PATH);
  }

  // 4. Install status line script and register it
  fs.copyFileSync(STATUSLINE_SRC, STATUSLINE_DEST);
  fs.chmodSync(STATUSLINE_DEST, 0o755);
  log('  ✓ Installed status line script →', STATUSLINE_DEST);

  if (!settings.statusLine) {
    settings.statusLine = {
      type: 'command',
      command: STATUSLINE_DEST
    };
    log('  ✓ Registered status line       →', SETTINGS_PATH);
  } else {
    log('  · Status line already configured in', SETTINGS_PATH);
  }

  // Write all settings changes at once
  writeSettings(settings);

  log('\nclaude-overtime installed successfully.');
  log('  • You will be warned when ~95% of your hourly token limit is used.');
  log('  • Rate limit usage % shown in the status bar.');
  log('  • Run /overtime in any Claude Code session to activate overnight mode.');
  log('  • /overtime auto-retries on subsequent rate limits (up to 5x).');

  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) {
    log('\n  · No global config found. Run:');
    log('      claude-overtime config init');
    log('    to scaffold ~/.claude/overtime-config.json with defaults.');
  }
}

function uninstall() {
  log('Uninstalling claude-overtime...\n');

  // Remove commands
  if (fs.existsSync(COMMAND_DEST)) {
    fs.rmSync(COMMAND_DEST);
    log('  ✓ Removed /overtime command');
  }
  // Remove legacy /overtime-recursive if present from a prior install
  const legacyRecursiveDest = path.join(COMMANDS_DIR, 'overtime-recursive.md');
  if (fs.existsSync(legacyRecursiveDest)) {
    fs.rmSync(legacyRecursiveDest);
    log('  ✓ Removed legacy /overtime-recursive command');
  }

  // Remove hook script
  if (fs.existsSync(HOOK_DEST)) {
    fs.rmSync(HOOK_DEST);
    log('  ✓ Removed hook script');
  }

  // Remove status line script
  if (fs.existsSync(STATUSLINE_DEST)) {
    fs.rmSync(STATUSLINE_DEST);
    log('  ✓ Removed status line script');
  }

  // Remove hook entry and status line from settings.json
  if (fs.existsSync(SETTINGS_PATH)) {
    const settings = readSettings();
    if (settings.hooks && settings.hooks.Stop) {
      settings.hooks.Stop = settings.hooks.Stop.filter(
        h => !JSON.stringify(h).includes('claude-overtime-rate-limit-warn')
      );
      if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    }
    if (settings.statusLine && JSON.stringify(settings.statusLine).includes('claude-overtime-statusline')) {
      delete settings.statusLine;
    }
    writeSettings(settings);
    log('  ✓ Removed hook and status line from settings.json');
  }

  // Clean up state files
  const stateFile = path.join(CLAUDE_DIR, 'overtime-token-state.json');
  if (fs.existsSync(stateFile)) fs.rmSync(stateFile);
  try { fs.rmSync('/tmp/claude-overtime-warned'); } catch (_) {}

  log('\nclaude-overtime uninstalled.');
}

function status() {
  const commandInstalled = fs.existsSync(COMMAND_DEST);
  const hookInstalled = fs.existsSync(HOOK_DEST);
  const statuslineInstalled = fs.existsSync(STATUSLINE_DEST);
  const settings = readSettings();
  const hookRegistered = JSON.stringify(settings.hooks || {}).includes('claude-overtime-rate-limit-warn');
  const statuslineRegistered = !!(settings.statusLine && JSON.stringify(settings.statusLine).includes('claude-overtime-statusline'));

  console.log('claude-overtime status:');
  console.log(' ', commandInstalled    ? '✓' : '✗', '/overtime command:     ', commandInstalled    ? COMMAND_DEST    : 'not installed');
  console.log(' ', hookInstalled       ? '✓' : '✗', 'Hook script:           ', hookInstalled       ? HOOK_DEST       : 'not installed');
  console.log(' ', statuslineInstalled ? '✓' : '✗', 'Status line script:    ', statuslineInstalled ? STATUSLINE_DEST : 'not installed');
  console.log(' ', hookRegistered      ? '✓' : '✗', 'settings.json:         ', hookRegistered      ? 'hook registered'        : 'not registered');
  console.log(' ', statuslineRegistered ? '✓' : '✗', 'settings.json:         ', statuslineRegistered ? 'status line registered' : 'not registered');

  const stateFile = path.join(CLAUDE_DIR, 'overtime-token-state.json');
  if (fs.existsSync(stateFile)) {
    try {
      const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      console.log('\n  Session tokens tracked:', state.session_total, '(updated', state.updated + ')');
    } catch (_) {}
  }

  if (!commandInstalled || !hookInstalled || !hookRegistered) {
    console.log('\n  Run: claude-overtime install');
  }

  const globalCfg = readConfig('global');
  const projectCfg = readConfig('project');
  const merged = mergeConfigs(globalCfg, projectCfg);
  const globalExists = fs.existsSync(GLOBAL_CONFIG_PATH);
  const projectConfigPath = path.join(process.cwd(), '.claude', 'overtime-config.json');
  const projectExists = fs.existsSync(projectConfigPath);

  console.log('\nConfig (merged):');
  console.log('  defaultDelay:       ', merged.defaultDelay);
  console.log('  warnAt:             ', merged.warnAt);
  console.log('  maxRetries:         ', merged.maxRetries);
  console.log('  abortBehavior:      ', merged.abortBehavior);
  console.log('  customRules:        ', merged.customRules.length > 0 ? merged.customRules.length + ' rule(s)' : '(none)');
  console.log('  prTitlePrefix:      ', JSON.stringify(merged.prTitlePrefix));
  console.log('  protectedBranches:  ', merged.protectedBranches.length > 0 ? merged.protectedBranches.join(', ') : '(none)');
  console.log('  Global config:      ', globalExists ? GLOBAL_CONFIG_PATH : 'not found');
  console.log('  Project config:     ', projectExists ? projectConfigPath : 'not found');
}

const cmd = process.argv[2];
switch (cmd) {
  case 'install':   install();                        break;
  case 'uninstall': uninstall();                      break;
  case 'status':    status();                         break;
  case 'config':    configCmd(process.argv.slice(3)); break;
  default:
    console.log('Usage: claude-overtime <install|uninstall|status|config>');
    console.log('       claude-overtime config <init|get|set|validate>');
    if (cmd && cmd !== '--silent') process.exit(1);
    break;
}

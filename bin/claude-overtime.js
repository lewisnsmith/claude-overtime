#!/usr/bin/env node
/**
 * claude-overtime CLI
 * Usage:
 *   claude-overtime install   - install the /overtime command and rate limit hook
 *   claude-overtime uninstall - remove everything
 *   claude-overtime status    - show current install state
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
const ALLNIGHTER_SRC = path.join(__dirname, '..', 'commands', 'all-nighter.md');
const ALLNIGHTER_DEST = path.join(COMMANDS_DIR, 'all-nighter.md');

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

function install() {
  log('Installing claude-overtime...\n');

  // 1. Copy slash commands
  fs.mkdirSync(COMMANDS_DIR, { recursive: true });
  fs.copyFileSync(COMMAND_SRC, COMMAND_DEST);
  log('  ✓ Installed /overtime command    →', COMMAND_DEST);
  fs.copyFileSync(ALLNIGHTER_SRC, ALLNIGHTER_DEST);
  log('  ✓ Installed /all-nighter command →', ALLNIGHTER_DEST);

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
  log('\nTo set a custom warning threshold (tokens):');
  log('  export CLAUDE_OVERTIME_WARN_AT=80000');
}

function uninstall() {
  log('Uninstalling claude-overtime...\n');

  // Remove commands
  if (fs.existsSync(COMMAND_DEST)) {
    fs.rmSync(COMMAND_DEST);
    log('  ✓ Removed /overtime command');
  }
  if (fs.existsSync(ALLNIGHTER_DEST)) {
    fs.rmSync(ALLNIGHTER_DEST);
    log('  ✓ Removed /all-nighter command');
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
  const allnighterInstalled = fs.existsSync(ALLNIGHTER_DEST);
  const hookInstalled = fs.existsSync(HOOK_DEST);
  const statuslineInstalled = fs.existsSync(STATUSLINE_DEST);
  const settings = readSettings();
  const hookRegistered = JSON.stringify(settings.hooks || {}).includes('claude-overtime-rate-limit-warn');
  const statuslineRegistered = !!(settings.statusLine && JSON.stringify(settings.statusLine).includes('claude-overtime-statusline'));

  console.log('claude-overtime status:');
  console.log(' ', commandInstalled    ? '✓' : '✗', '/overtime command:     ', commandInstalled    ? COMMAND_DEST    : 'not installed');
  console.log(' ', allnighterInstalled ? '✓' : '✗', '/all-nighter command:  ', allnighterInstalled ? ALLNIGHTER_DEST : 'not installed');
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

  if (!commandInstalled || !allnighterInstalled || !hookInstalled || !hookRegistered) {
    console.log('\n  Run: claude-overtime install');
  }
}

const cmd = process.argv[2];
switch (cmd) {
  case 'install':   install();   break;
  case 'uninstall': uninstall(); break;
  case 'status':    status();    break;
  default:
    console.log('Usage: claude-overtime <install|uninstall|status>');
    if (cmd && cmd !== '--silent') process.exit(1);
    break;
}

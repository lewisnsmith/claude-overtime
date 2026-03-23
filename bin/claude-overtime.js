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
const COMMAND_SRC = path.join(__dirname, '..', 'commands', 'overtime.md');
const COMMAND_DEST = path.join(COMMANDS_DIR, 'overtime.md');

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

  // 1. Copy /overtime slash command
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
    writeSettings(settings);
    log('  ✓ Registered Stop hook       →', SETTINGS_PATH);
  } else {
    log('  · Stop hook already registered in', SETTINGS_PATH);
  }

  log('\nclaude-overtime installed successfully.');
  log('  • You will be warned when ~95% of your hourly token limit is used.');
  log('  • Run /overtime in any Claude Code session to activate overnight mode.');
  log('\nTo set a custom warning threshold (tokens):');
  log('  export CLAUDE_OVERTIME_WARN_AT=80000');
}

function uninstall() {
  log('Uninstalling claude-overtime...\n');

  // Remove command
  if (fs.existsSync(COMMAND_DEST)) {
    fs.rmSync(COMMAND_DEST);
    log('  ✓ Removed /overtime command');
  }

  // Remove hook script
  if (fs.existsSync(HOOK_DEST)) {
    fs.rmSync(HOOK_DEST);
    log('  ✓ Removed hook script');
  }

  // Remove hook entry from settings.json
  if (fs.existsSync(SETTINGS_PATH)) {
    const settings = readSettings();
    if (settings.hooks && settings.hooks.Stop) {
      settings.hooks.Stop = settings.hooks.Stop.filter(
        h => !JSON.stringify(h).includes('claude-overtime-rate-limit-warn')
      );
      if (settings.hooks.Stop.length === 0) delete settings.hooks.Stop;
      if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
      writeSettings(settings);
      log('  ✓ Removed hook from settings.json');
    }
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
  const settings = readSettings();
  const hookRegistered = JSON.stringify(settings.hooks || {}).includes('claude-overtime-rate-limit-warn');

  console.log('claude-overtime status:');
  console.log(' ', commandInstalled ? '✓' : '✗', '/overtime command:', commandInstalled ? COMMAND_DEST : 'not installed');
  console.log(' ', hookInstalled    ? '✓' : '✗', 'Hook script:      ', hookInstalled    ? HOOK_DEST     : 'not installed');
  console.log(' ', hookRegistered   ? '✓' : '✗', 'settings.json:    ', hookRegistered   ? 'hook registered' : 'not registered');

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

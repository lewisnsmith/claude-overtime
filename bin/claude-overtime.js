#!/usr/bin/env node
'use strict';
/**
 * claude-overtime v2 CLI
 *
 * Subcommands:
 *   install [--dry-run] [--force]
 *   uninstall
 *   status
 *   config <init|get|set|validate> [args] [--project] [--force]
 *   state <show|reset> [<session-id>|--all]
 */

const fs   = require('fs');
const path = require('path');
const os   = require('os');

// ─── Lib imports ─────────────────────────────────────────────────────────────

const config = require('../lib/config');
const state  = require('../lib/state');

// ─── Paths ───────────────────────────────────────────────────────────────────

const HOME        = os.homedir();
const CLAUDE_DIR  = path.join(HOME, '.claude');
const HOOKS_DIR   = path.join(CLAUDE_DIR, 'hooks');
const COMMANDS_DIR= path.join(CLAUDE_DIR, 'commands');
const SETTINGS_PATH = path.join(CLAUDE_DIR, 'settings.json');
const CACHE_PATH  = path.join(CLAUDE_DIR, 'overtime-statusline-cache.json');

// Repo root hook / command sources
const SRC_HOOKS   = path.join(__dirname, '..', 'hooks');
const SRC_COMMANDS= path.join(__dirname, '..', 'commands');

// Files installed by claude-overtime install
const INSTALLED_FILES = [
  {
    src:  path.join(SRC_COMMANDS, 'overtime.md'),
    dest: path.join(COMMANDS_DIR, 'overtime.md'),
    mode: null,
  },
  {
    src:  path.join(SRC_HOOKS, 'stop.sh'),
    dest: path.join(HOOKS_DIR, 'claude-overtime-stop.sh'),
    mode: 0o755,
  },
  {
    src:  path.join(SRC_HOOKS, 'session-start.sh'),
    dest: path.join(HOOKS_DIR, 'claude-overtime-session-start.sh'),
    mode: 0o755,
  },
  {
    src:  path.join(SRC_HOOKS, 'pre-tool-use.sh'),
    dest: path.join(HOOKS_DIR, 'claude-overtime-pre-tool-use.sh'),
    mode: 0o755,
  },
  {
    src:  path.join(SRC_HOOKS, 'overtime-statusline.sh'),
    dest: path.join(HOOKS_DIR, 'claude-overtime-statusline.sh'),
    mode: 0o755,
  },
];

// Hook registration specs for settings.json
const HOOK_REGISTRATIONS = [
  {
    hookType: 'Stop',
    command:  path.join(HOOKS_DIR, 'claude-overtime-stop.sh'),
    matcher:  '',
    tag:      'claude-overtime-stop',
  },
  {
    hookType: 'SessionStart',
    command:  path.join(HOOKS_DIR, 'claude-overtime-session-start.sh'),
    matcher:  '',
    tag:      'claude-overtime-session-start',
  },
  {
    hookType: 'PreToolUse',
    command:  path.join(HOOKS_DIR, 'claude-overtime-pre-tool-use.sh'),
    matcher:  'Bash|Edit|Write',
    tag:      'claude-overtime-pre-tool-use',
  },
];

const STATUS_LINE_CMD = path.join(HOOKS_DIR, 'claude-overtime-statusline.sh');

// ─── Utilities ───────────────────────────────────────────────────────────────

const SILENT = process.argv.includes('--silent');
const log  = (...a) => { if (!SILENT) process.stdout.write(a.join(' ') + '\n'); };
const warn = (...a) => process.stderr.write(a.join(' ') + '\n');

function readSettings() {
  try {
    if (fs.existsSync(SETTINGS_PATH)) {
      return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
    }
  } catch (e) {
    warn('Warning: could not parse', SETTINGS_PATH, '-', e.message);
  }
  return {};
}

function writeSettings(settings) {
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
}

/**
 * Read file content; return null if missing.
 */
function readFileSafe(p) {
  try { return fs.readFileSync(p, 'utf8'); } catch (_) { return null; }
}

/**
 * Compute a simple unified-style diff (--- a / +++ b) for two text blobs.
 * Suitable for printing; not git-format.
 */
function simpleDiff(label, before, after) {
  if (before === after) return null;
  const lines = [];
  lines.push(`--- a/${label}`);
  lines.push(`+++ b/${label}`);

  if (before === null) {
    lines.push('@@ new file @@');
    after.split('\n').forEach(l => lines.push('+' + l));
  } else {
    lines.push('@@ modified @@');
    // Show full before/after for settings.json; for binary-ish show summary
    before.split('\n').forEach(l => lines.push('-' + l));
    after.split('\n').forEach(l  => lines.push('+' + l));
  }
  return lines.join('\n');
}

// ─── install / uninstall helpers ─────────────────────────────────────────────

/**
 * Build the target settings.json that install would write.
 * Used for both dry-run (diff) and real install.
 */
function buildTargetSettings(settings) {
  const next = JSON.parse(JSON.stringify(settings)); // deep clone

  // Ensure hooks object
  if (!next.hooks) next.hooks = {};

  for (const reg of HOOK_REGISTRATIONS) {
    if (!next.hooks[reg.hookType]) next.hooks[reg.hookType] = [];

    const alreadyPresent = next.hooks[reg.hookType].some(entry =>
      JSON.stringify(entry).includes(reg.tag)
    );
    if (!alreadyPresent) {
      const entry = {
        matcher: reg.matcher,
        hooks: [{ type: 'command', command: reg.command }],
        _tag: reg.tag,
      };
      next.hooks[reg.hookType] = [...next.hooks[reg.hookType], entry];
    }
  }

  // Status line
  const statusAlreadySet =
    next.statusLine && JSON.stringify(next.statusLine).includes('claude-overtime-statusline');
  if (!statusAlreadySet) {
    next.statusLine = { type: 'command', command: STATUS_LINE_CMD };
  }

  return next;
}

// ─── Subcommand: install ──────────────────────────────────────────────────────

function cmdInstall(args) {
  const dryRun = args.includes('--dry-run');
  const force  = args.includes('--force');

  if (dryRun) {
    log('=== claude-overtime install --dry-run ===\n');
  } else {
    log('Installing claude-overtime...\n');
  }

  const diffs = [];
  let hasChanges = false;

  // ── File copies ──────────────────────────────────────────────────────────
  for (const { src, dest } of INSTALLED_FILES) {
    if (!fs.existsSync(src)) {
      warn(`  ! Source not found: ${src} — skipping`);
      continue;
    }

    const srcContent  = readFileSafe(src);
    const destContent = readFileSafe(dest);

    if (destContent !== null && destContent === srcContent) {
      // Already up to date
      if (dryRun) {
        log(`  = (no change) ${dest}`);
      } else {
        log(`  · Already up to date: ${dest}`);
      }
      continue;
    }

    if (destContent !== null && destContent !== srcContent && !force) {
      warn(`  ! ${dest} exists with different content. Use --force to overwrite. Skipping.`);
      continue;
    }

    hasChanges = true;
    const label = dest.replace(HOME, '~');

    if (dryRun) {
      const diff = simpleDiff(label, destContent, srcContent);
      if (diff) diffs.push(diff);
      log(`  + ${dest}`);
    } else {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      // Set mode for hook scripts
      const spec = INSTALLED_FILES.find(f => f.dest === dest);
      if (spec && spec.mode) fs.chmodSync(dest, spec.mode);
      log(`  ✓ ${dest}`);
    }
  }

  // ── settings.json ────────────────────────────────────────────────────────
  const currentSettings = readSettings();
  const targetSettings  = buildTargetSettings(currentSettings);
  const currentJson = JSON.stringify(currentSettings, null, 2) + '\n';
  const targetJson  = JSON.stringify(targetSettings, null, 2) + '\n';

  if (currentJson !== targetJson) {
    hasChanges = true;
    if (dryRun) {
      const diff = simpleDiff('~/.claude/settings.json', currentJson, targetJson);
      if (diff) diffs.push(diff);
      log(`  + ~/.claude/settings.json (hook registrations + status line)`);
    } else {
      writeSettings(targetSettings);
      log('  ✓ Updated settings.json (hook registrations + status line)');
    }
  } else {
    if (dryRun) {
      log('  = (no change) ~/.claude/settings.json');
    } else {
      log('  · settings.json already up to date');
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  if (dryRun) {
    if (diffs.length > 0) {
      log('\n--- Diffs ---\n');
      diffs.forEach(d => log(d + '\n'));
    } else if (!hasChanges) {
      log('\nNo changes would be made (already installed).');
    }
    log('\nDry run complete. Run without --dry-run to apply.');
  } else {
    if (!hasChanges) {
      log('\nclaude-overtime already installed and up to date. (Re-run with --force to overwrite files.)');
    } else {
      log('\nclaude-overtime installed successfully.');
      log('  Next steps:');
      log('    1. claude-overtime config init     # scaffold global config');
      log('    2. Restart Claude Code             # hooks take effect on next launch');
      log('    3. /overtime --help                # inside Claude Code');
    }
  }
}

// ─── Subcommand: uninstall ────────────────────────────────────────────────────

function cmdUninstall() {
  // Refuse if active state files exist
  const activeSessions = state.list();
  if (activeSessions.length > 0) {
    warn('claude-overtime: Refusing to uninstall — active sessions exist:');
    for (const s of activeSessions) {
      warn(`  session ${s._sessionId}  mode=${s.mode}  pid=${s.pid}  expires=${s.expires_at}`);
    }
    warn('  Run: claude-overtime state reset --all');
    process.exit(1);
  }

  log('Uninstalling claude-overtime...\n');

  // Remove installed files
  for (const { dest } of INSTALLED_FILES) {
    if (fs.existsSync(dest)) {
      fs.rmSync(dest);
      log(`  ✓ Removed ${dest}`);
    }
  }

  // Remove hook registrations + status line from settings.json
  if (fs.existsSync(SETTINGS_PATH)) {
    const settings = readSettings();

    for (const reg of HOOK_REGISTRATIONS) {
      if (settings.hooks && settings.hooks[reg.hookType]) {
        settings.hooks[reg.hookType] = settings.hooks[reg.hookType].filter(
          entry => !JSON.stringify(entry).includes(reg.tag) &&
                   !JSON.stringify(entry).includes(reg.command)
        );
        if (settings.hooks[reg.hookType].length === 0) {
          delete settings.hooks[reg.hookType];
        }
      }
    }
    if (settings.hooks && Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    if (settings.statusLine && JSON.stringify(settings.statusLine).includes('claude-overtime-statusline')) {
      delete settings.statusLine;
    }

    writeSettings(settings);
    log('  ✓ Removed hook registrations and status line from settings.json');
  }

  log('\nclaude-overtime uninstalled successfully.');
  log('  Config files (~/.claude/overtime-config.json) are preserved.');
  log('  To remove them: rm ~/.claude/overtime-config.json');
}

// ─── Subcommand: status ───────────────────────────────────────────────────────

function cmdStatus() {
  const pkg = require('../package.json');
  log(`claude-overtime v${pkg.version}`);
  log('');

  // Installation state
  const settings = readSettings();

  const commandDest = path.join(COMMANDS_DIR, 'overtime.md');
  const commandInstalled = fs.existsSync(commandDest);
  log('Installation:');
  log(`  ${commandInstalled ? '✓' : '✗'} /overtime command:          ${commandInstalled ? commandDest : 'not installed'}`);

  for (const { dest } of INSTALLED_FILES.filter(f => f.mode)) {
    const installed = fs.existsSync(dest);
    const label = path.basename(dest).padEnd(38);
    log(`  ${installed ? '✓' : '✗'} ${label} ${installed ? dest : 'not installed'}`);
  }

  // Hook registration checks
  log('');
  log('Hook registrations:');
  for (const reg of HOOK_REGISTRATIONS) {
    const registered = JSON.stringify(settings.hooks || {}).includes(reg.tag) ||
                       JSON.stringify(settings.hooks || {}).includes(reg.command);
    log(`  ${registered ? '✓' : '✗'} ${reg.hookType.padEnd(16)} ${registered ? 'registered' : 'not registered'}`);
  }
  const slRegistered = settings.statusLine &&
    JSON.stringify(settings.statusLine).includes('claude-overtime-statusline');
  log(`  ${slRegistered ? '✓' : '✗'} StatusLine         ${slRegistered ? 'registered' : 'not registered'}`);

  // Active sessions
  log('');
  const sessions = state.list();
  if (sessions.length === 0) {
    log('Active sessions: none');
  } else {
    log(`Active sessions: ${sessions.length}`);
    for (const s of sessions) {
      log(`  session ${s._sessionId}`);
      log(`    mode=${s.mode}  pid=${s.pid}  branch=${s.branch || 'n/a'}`);
      log(`    started=${s.started_at}  expires=${s.expires_at}`);
    }
  }

  // Rate-limit cache
  log('');
  const cacheContent = readFileSafe(CACHE_PATH);
  if (cacheContent) {
    try {
      const cache = JSON.parse(cacheContent);
      log(`Rate-limit cache (${CACHE_PATH}):`);
      log(`  used: ${cache.percentUsed !== undefined ? cache.percentUsed + '%' : 'n/a'}`);
      log(`  resets_at: ${cache.resetsAt || 'n/a'}`);
      log(`  updated: ${cache.updatedAt || 'n/a'}`);
    } catch (_) {
      log('Rate-limit cache: (parse error)');
    }
  } else {
    log('Rate-limit cache: not present');
  }
}

// ─── Subcommand: config ───────────────────────────────────────────────────────

function cmdConfig(args) {
  const sub = args[0];
  const isProject = args.includes('--project');
  const force      = args.includes('--force');
  const scope      = isProject ? 'project' : 'global';

  if (sub === 'init') {
    const configPath = isProject
      ? config.PROJECT_CONFIG_PATH()
      : config.GLOBAL_CONFIG_PATH;

    if (fs.existsSync(configPath) && !force) {
      log('Config already exists:', configPath);
      log('Use --force to overwrite with defaults.');
      return;
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config.CONFIG_DEFAULTS, null, 2) + '\n', 'utf8');
    log('Created', configPath);
    return;
  }

  if (sub === 'get') {
    const key = args.filter(a => !a.startsWith('--'))[1];
    const merged = config.loadMerged();
    if (key) {
      if (!(key in merged)) {
        warn('Unknown config key:', key);
        warn('Valid keys:', Object.keys(config.CONFIG_DEFAULTS).join(', '));
        process.exit(1);
      }
      process.stdout.write(JSON.stringify(merged[key], null, 2) + '\n');
    } else {
      process.stdout.write(JSON.stringify(merged, null, 2) + '\n');
    }
    return;
  }

  if (sub === 'set') {
    // Filter out flags first
    const positional = args.filter(a => !a.startsWith('--'));
    // positional[0] = 'set', [1] = key, [2] = value
    const key      = positional[1];
    const rawValue = positional[2];

    if (!key || rawValue === undefined) {
      warn('Usage: claude-overtime config set <key> <value> [--project]');
      process.exit(1);
    }

    try {
      config.set(scope, key, rawValue);
      log(`Set ${key} = ${JSON.stringify(rawValue)} in ${scope} config`);
    } catch (e) {
      warn('Error:', e.message);
      process.exit(1);
    }
    return;
  }

  if (sub === 'validate') {
    // Validate both layers individually + merged
    const { loadMerged, validate } = config;
    let anyErrors = false;

    const globalPath  = config.GLOBAL_CONFIG_PATH;
    const projectPath = config.PROJECT_CONFIG_PATH();

    for (const [label, p] of [['global', globalPath], ['project', projectPath]]) {
      if (!fs.existsSync(p)) continue;
      let obj;
      try {
        obj = JSON.parse(fs.readFileSync(p, 'utf8'));
      } catch (e) {
        warn(`${label}: JSON parse error: ${e.message}`);
        anyErrors = true;
        continue;
      }
      const errs = validate(obj);
      if (errs.length > 0) {
        errs.forEach(e => warn(`${label}: ${e}`));
        anyErrors = true;
      }
    }

    const mergedErrs = validate(loadMerged());
    if (mergedErrs.length > 0) {
      mergedErrs.forEach(e => warn(`merged: ${e}`));
      anyErrors = true;
    }

    if (!anyErrors) {
      log('Config valid.');
    } else {
      process.exit(1);
    }
    return;
  }

  warn('Usage: claude-overtime config <init|get|set|validate> [--project] [--force]');
  process.exit(1);
}

// ─── Subcommand: state ────────────────────────────────────────────────────────

function cmdState(args) {
  const sub = args[0];

  if (sub === 'show') {
    const sessions = state.list();
    if (sessions.length === 0) {
      log('No active overtime sessions.');
      return;
    }
    log(`${sessions.length} session(s):\n`);
    for (const s of sessions) {
      log(`Session: ${s._sessionId}`);
      log(`  mode:        ${s.mode}`);
      log(`  owner:       ${s.owner}`);
      log(`  pid:         ${s.pid}`);
      log(`  branch:      ${s.branch || 'n/a'}`);
      log(`  started_at:  ${s.started_at}`);
      log(`  expires_at:  ${s.expires_at}`);
      log(`  retryCount:  ${s.retryCount}`);
      log(`  projectRoot: ${s.projectRoot}`);
      log('');
    }
    return;
  }

  if (sub === 'reset') {
    const all       = args.includes('--all');
    const sessionId = args.filter(a => !a.startsWith('--'))[1]; // positional after 'reset'

    if (all) {
      // GC stale, then remove everything remaining
      const { removed: gcRemoved } = state.gcStale();
      if (gcRemoved.length > 0) {
        log(`GC removed ${gcRemoved.length} stale session(s): ${gcRemoved.join(', ')}`);
      }
      // Remove any still-active sessions forcibly
      const remaining = state.list();
      if (remaining.length === 0 && gcRemoved.length === 0) {
        log('No sessions to reset.');
        return;
      }
      for (const s of remaining) {
        // Restore settings backup before deleting
        if (s.settingsBackup !== undefined) {
          const settingsLocalPath = path.join(s.projectRoot || process.cwd(), '.claude', 'settings.local.json');
          try {
            if (s.settingsBackup !== null) {
              fs.mkdirSync(path.dirname(settingsLocalPath), { recursive: true });
              fs.writeFileSync(settingsLocalPath, JSON.stringify(s.settingsBackup, null, 2), 'utf8');
            } else {
              try { fs.unlinkSync(settingsLocalPath); } catch (_) {}
            }
          } catch (e) {
            warn(`Warning: could not restore settings for session ${s._sessionId}: ${e.message}`);
          }
        }
        state.remove(s._sessionId);
        log(`Removed session: ${s._sessionId}`);
      }
      log('All sessions reset.');
      return;
    }

    if (sessionId) {
      const s = state.read(sessionId);
      if (!s) {
        warn(`Session not found: ${sessionId}`);
        process.exit(1);
      }
      // Restore settings backup
      if (s.settingsBackup !== undefined) {
        const settingsLocalPath = path.join(s.projectRoot || process.cwd(), '.claude', 'settings.local.json');
        try {
          if (s.settingsBackup !== null) {
            fs.mkdirSync(path.dirname(settingsLocalPath), { recursive: true });
            fs.writeFileSync(settingsLocalPath, JSON.stringify(s.settingsBackup, null, 2), 'utf8');
            log(`Restored settings.local.json for session ${sessionId}`);
          } else {
            try { fs.unlinkSync(settingsLocalPath); } catch (_) {}
          }
        } catch (e) {
          warn(`Warning: could not restore settings: ${e.message}`);
        }
      }
      state.remove(sessionId);
      log(`Removed session: ${sessionId}`);
      return;
    }

    warn('Usage: claude-overtime state reset [<session-id>|--all]');
    process.exit(1);
  }

  warn('Usage: claude-overtime state <show|reset> [<session-id>|--all]');
  process.exit(1);
}

// ─── Main dispatcher ──────────────────────────────────────────────────────────

const cmd = process.argv[2];

switch (cmd) {
  case 'install':   cmdInstall(process.argv.slice(3));   break;
  case 'uninstall': cmdUninstall();                      break;
  case 'status':    cmdStatus();                         break;
  case 'config':    cmdConfig(process.argv.slice(3));    break;
  case 'state':     cmdState(process.argv.slice(3));     break;
  default:
    process.stdout.write([
      'Usage: claude-overtime <command> [options]',
      '',
      'Commands:',
      '  install [--dry-run] [--force]            Install hooks and commands into ~/.claude/',
      '  uninstall                                Remove hooks and commands',
      '  status                                   Show install state and active sessions',
      '  config <init|get|set|validate> [...]     Manage configuration',
      '  state <show|reset> [<id>|--all]          Inspect or reset session state',
      '',
      'Config subcommands:',
      '  config init [--project] [--force]        Scaffold config file with defaults',
      '  config get [<key>]                       Print merged config or a single key',
      '  config set <key> <value> [--project]     Set a config key',
      '  config validate                          Validate config files',
      '',
      'State subcommands:',
      '  state show                               List active sessions',
      '  state reset --all                        Reset all sessions (restore backups)',
      '  state reset <session-id>                 Reset one session',
    ].join('\n') + '\n');
    if (cmd && cmd !== '--silent' && cmd !== '--help' && cmd !== '-h') process.exit(1);
    break;
}

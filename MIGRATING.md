# Migrating from v1.4 to v2.0

## One-line upgrade

```bash
npm install -g claude-overtime@2 && claude-overtime install
```

`install` is idempotent — safe to re-run over an existing installation.

---

## Breaking changes

### `/all-nighter` removed

`/all-nighter` is gone. Use `/overtime --backlog` instead.

| v1.4 | v2.0 |
|---|---|
| `/all-nighter` | `/overtime --backlog` |
| `/all-nighter 3c` | `/overtime --backlog 3c` |
| `/all-nighter 6h` | `/overtime --backlog 6h` |
| `/all-nighter --resume` | `/overtime --resume` |
| `/all-nighter --fresh` | `/overtime --backlog` (state is GC'd automatically) |

### `npm install -g` no longer auto-installs hooks

v1.4 ran `claude-overtime install` as a `postinstall` npm script, mutating your `~/.claude/settings.json` silently. v2.0 removes this.

After upgrading, run `claude-overtime install` yourself. Use `--dry-run` first if you want to preview the changes:

```bash
claude-overtime install --dry-run
claude-overtime install
```

### `defaultDelay` default changed from `"5h"` to `"auto"`

In v1.4, the default delay was a fixed 5 hours. In v2.0 it is `"auto"`, which reads Claude Code's native `rate_limits.five_hour.resets_at` telemetry and computes exactly how long to sleep, plus a small buffer (`delayBuffer`, default `"5m"`).

If you had `defaultDelay: "5h"` in your config explicitly, it still works. If you relied on the implicit 5-hour default and want to keep it:

```bash
claude-overtime config set defaultDelay 5h
```

To adopt the new dynamic behavior, delete or unset `defaultDelay` from your config (the `"auto"` default applies).

### `warnAt` unit changed from token count to percentage (0–100)

v1.4 `warnAt` was a raw token count (e.g. `90000`). v2.0 `warnAt` is a percentage of the 5-hour window (e.g. `90` for 90%).

If your config has a numeric `warnAt` above 100, it will be rejected by `config validate` — update it:

```bash
# Old config: warnAt: 80000
# New config:
claude-overtime config set warnAt 80
```

The default is `90` (90%), equivalent to the old default of ~90,000 tokens.

---

## New state directory

v1.4 used a single flat file per command:

- `/tmp/claude-overtime-state.json`
- `/tmp/claude-all-nighter-state.json`

v2.0 uses a directory with one file per active session:

- `~/.claude/overtime-state/<session-id>.json`

The new SessionStart hook garbage-collects stale state on every Claude Code launch — you no longer need to delete state files manually.

If you have scripts or aliases that reference the old `/tmp` paths, update or remove them.

---

## New hooks registered by `install`

v1.4 registered one hook: `Stop`.

v2.0 registers three:

| Hook | Script | Purpose |
|---|---|---|
| `Stop` | `claude-overtime-stop.sh` | Rate-limit telemetry cache, warning banner, auto-schedule |
| `SessionStart` | `claude-overtime-session-start.sh` | GC stale state, restore permissions after a crash |
| `PreToolUse` | `claude-overtime-pre-tool-use.sh` | Mechanical safety guards on Bash and Edit/Write |

The old `claude-overtime-rate-limit-warn.sh` is removed by `uninstall` and replaced by the new `stop.sh`.

---

## New CLI subcommands

| Subcommand | What it does |
|---|---|
| `claude-overtime state show` | List active sessions and their status |
| `claude-overtime state reset [<id>\|--all]` | Restore settings backups and delete state |
| `claude-overtime config validate` | Strict validation; exits non-zero on any error |
| `claude-overtime install --dry-run` | Preview what `install` would write, no changes made |

---

## New config keys

The following keys are new in v2.0 — they have no v1.4 equivalent:

| Key | Default | Purpose |
|---|---|---|
| `delayBuffer` | `"5m"` | Safety margin added to the computed reset delay |
| `autoOvertime` | `false` | Stop hook auto-schedules `/overtime` at threshold |
| `editAllowGlobs` | `["**/*"]` | Write whitelist for the PreToolUse hook |
| `editDenyGlobs` | `["node_modules/**", ".git/**", "**/.env*"]` | Write denylist for the PreToolUse hook |

---

## Removed config keys

None — all v1.4 keys are preserved. `protectedBranches` was project-only in v1.4 and remains so.

---

## Summary checklist

- [ ] Run `npm install -g claude-overtime@2`
- [ ] Run `claude-overtime install --dry-run` to preview changes
- [ ] Run `claude-overtime install`
- [ ] Update `warnAt` in your config from a token count to a percentage (0–100)
- [ ] Replace any `/all-nighter` invocations with `/overtime --backlog`
- [ ] Delete or update any scripts that reference `/tmp/claude-overtime-state.json` or `/tmp/claude-all-nighter-state.json`
- [ ] Run `claude-overtime config validate` to confirm your config is valid

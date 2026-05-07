# claude-overtime

Stop losing your late-night Claude sessions to rate limits.

**claude-overtime** is a single command — `/overtime` — that captures your task context, waits for the rate-limit window to reset, then resumes your work unattended. Add `--backlog` to grind a whole queue of tasks overnight rather than just the one you were on.

---

## Install

```bash
npm install -g claude-overtime
```

`npm install` does **not** touch your Claude Code settings. You run the install step yourself:

```bash
claude-overtime install
```

This copies the slash command and hook scripts into `~/.claude/` and registers them in `~/.claude/settings.json`. It is idempotent — safe to run again.

To preview what `install` will do without making any changes:

```bash
claude-overtime install --dry-run
```

To remove everything:

```bash
claude-overtime uninstall
```

---

## Quick start

```
/overtime
```

Claude captures your task context, sleeps until the rate-limit window resets, then resumes unattended. No flags required.

---

## `/overtime` flag matrix

| Invocation | Mode | Delay |
|---|---|---|
| `/overtime` | single-task | computed from native rate-limit reset |
| `/overtime 1h` / `90m` / `2h30m` | single-task | explicit override |
| `/overtime --backlog` | backlog — full queue | computed |
| `/overtime --backlog 3c` | backlog, cap at 3 cycles | computed |
| `/overtime --backlog 6h` | backlog, soft 6-hour deadline | computed |
| `/overtime --resume` | resume from existing state | n/a |
| `/overtime --auto` | scheduled by Stop hook — not for manual use | computed |

**Time formats:** `Ns` (seconds, useful for testing), `Nm` or `Nmin` (minutes), `Nh` (hours), `NhMm` (e.g. `2h30m`), plain number = minutes.

---

## `/overtime --backlog`

<details>
<summary>Click to expand backlog mode details</summary>

Backlog mode runs an adaptive cycle loop rather than finishing a single task:

```
while not done and not rate-limited and not past deadline:
  audit → plan cycle → spawn parallel track agents (worktree-isolated)
    → review → test → integrate → open draft PR per track → next cycle
```

Each cycle's position (phase, cycle number, per-track status) is persisted to the state file so a mid-cycle rate-limit hit checkpoints and resumes cleanly. Completed tracks are skipped on resume.

**Flags:**

- `--backlog 3c` — cap at 3 cycles (default: 8).
- `--backlog 6h` — soft deadline; exits at next safe checkpoint past 6 hours.
- `--backlog 3c 6h` — both limits apply; whichever fires first wins.

**Track isolation:** each parallel sub-agent gets its own `git worktree`, making file conflicts physically impossible.

</details>

---

## Config

Two-tier config: global defaults in `~/.claude/overtime-config.json`, per-project overrides in `.claude/overtime-config.json`. Project values override global scalars; `customRules` arrays concatenate; `protectedBranches` is project-only (a project can't inherit a globally relaxed safety setting).

### Config keys

| Key | Type | Default | Notes |
|---|---|---|---|
| `defaultDelay` | string or `"auto"` | `"auto"` | `"auto"` computes from native rate-limit telemetry. |
| `delayBuffer` | string | `"5m"` | Added to the computed delay as a safety margin. |
| `warnAt` | number (0–100) | `90` | Percentage of the 5-hour window that triggers the warning. |
| `maxRetries` | number | `5` | Maximum retries per overtime run before giving up. |
| `abortBehavior` | `"stop"` or `"continue"` | `"stop"` | Behavior when a checkpoint commit fails. |
| `autoOvertime` | boolean | `false` | Stop hook auto-schedules `/overtime` when usage exceeds `warnAt`. |
| `customRules` | string[] | `[]` | Extra rules appended to the built-in session rules. |
| `prTitlePrefix` | string | `"overtime: "` | Prefix for draft PR titles. |
| `prBodyTemplate` | string | `"{{log}}"` | Template for PR body. Supports `{{log}}` and `{{snapshot}}`. |
| `protectedBranches` | string[] | `[]` | Branches beyond `main`/`master` that overtime cannot push to. Project config only. |
| `editAllowGlobs` | string[] | `["**/*"]` | Write whitelist for the PreToolUse safety hook. |
| `editDenyGlobs` | string[] | `["node_modules/**", ".git/**", "**/.env*"]` | Write denylist applied before the allowlist. |

### Config CLI

```bash
claude-overtime config init [--project] [--force]   # scaffold config file with defaults
claude-overtime config get [key]                     # print merged config or a single key
claude-overtime config set <key> <value> [--project] # write a value
claude-overtime config validate                      # strict validation; exits non-zero on errors
```

**Examples:**

```bash
# Global: enable auto-scheduling
claude-overtime config set autoOvertime true

# Global: warn at 80% instead of 90%
claude-overtime config set warnAt 80

# Project: protect the staging branch
claude-overtime config set --project protectedBranches staging

# Project: add a session rule
claude-overtime config set --project customRules "Never run database migrations in unattended sessions."

# Project: use a fixed delay instead of auto-compute
claude-overtime config set --project defaultDelay 1h
```

---

## Rate-limit telemetry and status line

### Native telemetry

Claude Code exposes `rate_limits.five_hour.used_percentage` and `resets_at` in the Stop hook JSON. `claude-overtime` reads this data natively — no token counting required. The `delayUntilReset()` function computes exactly how long to sleep before the window clears, plus the `delayBuffer` margin.

The Stop hook caches the latest telemetry to `~/.claude/overtime-statusline-cache.json` so the status line can read it without waiting for the next Stop event.

### Fallback

When native data is not present (e.g. the first response of a new session), `claude-overtime` falls back to a session counter stored in `~/.claude/overtime-fallback-counter.json`. The status line marks estimated values with a tilde:

```
overtime: ~72% [==============      ]
```

### Status line format

```
overtime: 72% [==============      ]
```

20-character bar, integer percent, no decimals. Updates automatically after each assistant response.

### Onboarding banner

The first time the status line renders after `install`, a one-time banner is appended to the next assistant turn explaining the bar, how to run `/overtime`, and what `autoOvertime` does. A marker file prevents it from showing again.

### Warning banner

When usage crosses `warnAt` (default 90%):

```
╔══════════════════════════════════════════════════════╗
║  ⚠️  claude-overtime: rate limit 90% reached         ║
║  Run /overtime to continue your session overnight.  ║
╚══════════════════════════════════════════════════════╝
```

Plus a desktop notification (macOS: Notification Center, Linux: `notify-send`).

---

## Safety model

Safety is mechanical, not prompted. Three layers:

**Layer 1 — Permissions config (`.claude/settings.local.json`)**

Written at the start of an overtime session; removed at the end. Grants only: `Bash(*)`, `Read`, `Edit`, `Write`, `Glob`, `Grep`, `Agent`, `TodoWrite`. No `WebFetch`, no MCP unless project config opts in.

**Layer 2 — PreToolUse hooks (cannot be talked out of)**

Block by regex before the model sees the tool result:

- Bash: `rm -rf /`, `rm -rf ~`, `git reset --hard`, `git clean -f`, `git push --force`, `git push` to anything not matching `overtime/*`, `git push` to any branch in `protectedBranches`.
- Edit/Write: any path outside the project root, any path matching `editDenyGlobs` (`node_modules/**`, `.git/**`, `**/.env*` by default).

**Layer 3 — Rules file (`.claude/overtime-rules.md`)**

Soft guidance read by the agent each cycle: incremental commits, scope drift checks, dependency audit, no placeholder TODOs. Anything that must not happen lives in layer 1 or 2 — not here.

---

## Crash safety and state

State is stored in `~/.claude/overtime-state/<session-id>.json` — one file per active session, keyed by session id. Schema:

```json
{
  "owner": "overtime",
  "mode": "single",
  "pid": 12345,
  "started_at": "2025-01-01T23:00:00Z",
  "expires_at": "2025-01-02T04:15:00Z",
  "branch": "overtime/20250101-230000",
  "settingsBackup": null,
  "cursor": null,
  "retryCount": 0
}
```

The **SessionStart hook** runs on every Claude Code launch and garbage-collects stale state: any file whose PID is dead or `expires_at` has passed triggers a restore of `settingsBackup` and deletion of the state file. A one-line summary is appended to `~/.claude/overtime-cleanup.log`.

**You never have to think about leftover state** — it is cleaned up automatically on the next launch.

To inspect or reset manually:

```bash
claude-overtime state show               # list active sessions
claude-overtime state reset [<id>|--all] # restore backups and delete state
```

---

## Uninstall

```bash
claude-overtime uninstall
```

Removes the slash command, hook scripts, and settings.json entries. Preserves any other keys in `settings.json`. Will refuse if active state files exist — run `claude-overtime state reset --all` first.

---

## Requirements

- [Claude Code](https://claude.ai/code) CLI
- Node.js 18+
- macOS (`caffeinate`) or Linux (`systemd-inhibit`)
- `gh` CLI (optional — required only for draft PR creation)

---

## The typical workflow

1. It is 11pm. You are deep in a feature.
2. The status bar reads `overtime: 87% [================    ]` — getting close.
3. The 90% warning banner fires.
4. You type `/overtime` (or `/overtime 1h` if you know the window).
5. Claude snapshots the task, writes session rules, starts `caffeinate`, and sleeps.
6. You go to sleep.
7. The timer fires. Claude reads `.claude/overtime-rules.md`, checkpoints git, and resumes work.
8. It commits incrementally, logs progress to `.claude/overtime-log.md`, and checks for scope drift every 3 commits.
9. On completion it pushes the branch and opens a draft PR.
10. You wake up. The feature is done. You review the log and merge when ready.

---

## Files written during a session

| File | Purpose |
|---|---|
| `~/.claude/overtime-state/<id>.json` | Session state, GC'd by SessionStart hook |
| `~/.claude/overtime-statusline-cache.json` | Latest rate-limit telemetry, read by status line |
| `~/.claude/overtime-fallback-counter.json` | Fallback token counter when native data is absent |
| `~/.claude/overtime-cleanup.log` | One-line entries written by the GC routine |
| `.claude/overtime-rules.md` | Task snapshot + session rules (removed on cleanup) |
| `.claude/overtime-log.md` | Incremental session log (gitignored) |
| `.claude/settings.local.json` | Temporary permissions (removed on cleanup) |

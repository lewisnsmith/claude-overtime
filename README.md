# claude-overtime

Stop losing your late-night Claude sessions to rate limits.

**claude-overtime** does two things:

1. **Warns you at ~95% of your hourly token limit** — a desktop notification + terminal banner so you always see it coming.
2. **`/overtime` command** — grants temporary unattended permissions, keeps your machine awake with `caffeinate`, and loops automatically to continue your session when the rate limit resets. No permission prompts to stall at 3am.

---

## Install

```bash
npm install -g claude-overtime
```

`postinstall` automatically runs `claude-overtime install`, which:
- Copies the `/overtime` slash command to `~/.claude/commands/overtime.md`
- Installs the rate-limit warning hook to `~/.claude/hooks/`
- Registers the `Stop` hook in `~/.claude/settings.json`

Or install manually:

```bash
claude-overtime install
```

---

## Usage

### `/overtime`

Run this in any Claude Code session when you're about to (or have just) hit your rate limit:

```
/overtime
```

Defaults to resuming in **5 hours**. Claude will:
- Grant temporary project-scoped permissions (so it doesn't stall on approval prompts overnight)
- Ask you to choose an abort-on-failure behavior (stop, warn-and-continue, or cleanup-and-exit)
- Snapshot the current task as a drift anchor
- Write session rules to `.claude/overtime-rules.md`
- Keep your machine awake
- Pick up the conversation exactly where it left off — following the session rules automatically

You can specify a custom delay:

```
/overtime 1h
/overtime 90m
/overtime 2h30m
```

Supported formats: `Nh` (hours), `Nm` (minutes), `NhMm` (combined), plain number = minutes.

### Rate limit warning

The warning fires automatically — you don't need to do anything. When you approach your limit you'll see:

```
╔══════════════════════════════════════════════════════╗
║  ⚠️  claude-overtime: rate limit ~95% reached        ║
║  Run /overtime to continue your session overnight.  ║
╚══════════════════════════════════════════════════════╝
```

Plus a desktop notification (macOS: Notification Center, Linux: `notify-send`).

---

## Configuration

Set a custom warning threshold (default: 90,000 tokens ≈ 95% of a typical hourly limit):

```bash
export CLAUDE_OVERTIME_WARN_AT=80000
```

Add this to your `.zshrc` / `.bashrc` to persist it.

---

## How it works

| Component | What it does |
|---|---|
| `hooks/rate-limit-warn.sh` | Runs on every Claude `Stop` event, tracks cumulative token usage for the session, fires warning at threshold |
| `commands/overtime.md` | The `/overtime` slash command — grants permissions, writes session rules, starts caffeinate, and loops |
| `bin/claude-overtime.js` | CLI for install / uninstall / status |

Token usage is accumulated in `~/.claude/overtime-token-state.json` and resets each new session.

### Unattended permissions

When you run `/overtime`, Claude writes a temporary `.claude/settings.local.json` in the project with broad tool permissions (`Bash(*)`, `Edit`, `Write`, etc.) so the resumed session can work without prompts.

**Safety rails:**
- Destructive commands are still denied (`rm -rf /`, `git reset --hard`, `git clean -f`)
- **All git push commands are blocked** — unreviewed overnight code never reaches remote
- Claude is scoped to only finish the in-progress task — no new work, no changes outside the project
- Permissions are **automatically removed** when the task completes
- If the file already existed, only the `permissions` key is removed on cleanup — your other settings are preserved

### Session rules

When you activate `/overtime`, Claude writes `.claude/overtime-rules.md` with 10 behavioral rules the resumed session must follow:

| Rule | What it enforces |
|---|---|
| **Git checkpoint** | Commits all uncommitted work before writing any new code |
| **Incremental commits** | Commits after each logical unit — never batches 3+ files |
| **Final commit** | Clean commit when all work is done |
| **Session log** | Appends structured entries to `.claude/overtime-log.md` (gitignored) after each module |
| **Architecture consistency** | Reads existing files first, matches their patterns (async style, exports, error handling) |
| **Structural integrity** | Every function handles null/empty/error cases — no dead code or placeholder TODOs |
| **Dependency audit** | Verifies packages exist in the manifest before using them |
| **Flight proxy** | Optional — routes HTTP through [Flight proxy](https://github.com/lewisnsmith/flight) when `FLIGHT_PROXY=true` |
| **Context drift prevention** | Every 3 commits, re-checks the task snapshot to stay on-scope |
| **Git push blocked** | All pushes denied — you review and push manually in the morning |

The rules file also contains a **task snapshot** (2-3 sentence summary of what you were working on) that acts as the drift anchor, and your chosen **abort behavior** for handling checkpoint failures.

---

## Uninstall

```bash
claude-overtime uninstall
```

Removes the command, hook, and settings.json entry cleanly.

---

## Requirements

- [Claude Code](https://claude.ai/code) CLI
- Node.js 18+
- macOS (uses `caffeinate`) or Linux with `systemd-inhibit`

---

## The typical workflow

1. It's 11pm. You're deep in a feature.
2. You see the `⚠️ 95%` warning.
3. You type `/overtime` (or `/overtime 1h` if you know your limit resets in an hour).
4. Claude asks your abort preference, snapshots the task, and writes session rules.
5. Claude starts `caffeinate` and sets a timer.
6. You go to sleep.
7. Timer fires. Claude reads `.claude/overtime-rules.md`, checkpoints git, and resumes.
8. It commits incrementally, logs progress to `.claude/overtime-log.md`, and checks for scope drift every 3 commits.
9. You wake up in the morning. The feature is done. `caffeinate` has been killed. You review the log and push when ready.

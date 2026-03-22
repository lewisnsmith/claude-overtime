# claude-overtime

Stop losing your late-night Claude sessions to rate limits.

**claude-overtime** does two things:

1. **Warns you at ~95% of your hourly token limit** — a desktop notification + terminal banner so you always see it coming.
2. **`/overtime` command** — saves your current plan, keeps your machine awake with `caffeinate`, and loops automatically to continue your session when the rate limit resets.

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

Claude will:
1. Save the current task + next steps to `.claude/overtime-plan.md`
2. Run `caffeinate` (macOS) or `systemd-inhibit` (Linux) to prevent your machine from sleeping
3. Set up a `/loop` that picks up the plan every 10 minutes until the rate limit resets and all work is done
4. Kill `caffeinate` automatically when the plan is complete

You can also pass context:

```
/overtime finish the auth refactor, we still need to write tests for the JWT middleware
```

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
| `commands/overtime.md` | The `/overtime` slash command — instructs Claude to snapshot the plan, start caffeinate, and loop |
| `bin/claude-overtime.js` | CLI for install / uninstall / status |

Token usage is accumulated in `~/.claude/overtime-token-state.json` and resets each new session.

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
3. You type `/overtime`.
4. Claude saves the plan and starts `caffeinate`.
5. You go to sleep.
6. Rate limit resets in ~1 hour. Claude picks up automatically.
7. You wake up in the morning. The feature is done. `caffeinate` has been killed.

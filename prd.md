# Claude Overtime — Product Requirements Document

> **Version:** 1.0  
> **Date:** 2026-03-15  
> **Author:** Lewis Smith  
> **Status:** Draft  

---

## 1. Executive Summary

**Claude Overtime** is a Claude Code plugin that introduces the `/overtime` slash command. It allows developers to queue long-running, unattended Claude Code sessions that survive rate limits and keep the host machine awake — so you can start a complex task, type `/overtime`, and go to sleep.

When activated, `/overtime`:

1. **Enables full-permission mode** (`--dangerously-skip-permissions`) so Claude can operate without confirmation prompts.
2. **Activates `caffeinate`** (macOS) or equivalent to prevent the computer from sleeping.
3. **Monitors for rate-limit hits** and automatically schedules a retry/resume loop that fires when the rate limit window resets.
4. **Accepts optional task prompts** (`/overtime <prompt>`) to queue additional work items for Claude to complete on "overtime."

There is **no plan mode** — everything runs in execution mode. This is an intentional tradeoff: maximum autonomy for maximum throughput when you're AFK.

---

## 2. Problem Statement

### The Pain

Developers using Claude Code on Pro/Max plans frequently hit rate limits during intensive coding sessions. When this happens:

- The session halts and the developer must manually wait and re-engage.
- If it's late at night, the developer either stays up or loses progress.
- The computer may go to sleep, killing background processes.
- Re-establishing context after a rate limit is tedious and error-prone.

### The Opportunity

Rate limits reset on predictable schedules (~5 hours for session limits, token-bucket continuous replenishment for API). By combining **caffeinate + scheduled retry + full-permission mode**, Claude can autonomously continue working through rate limit windows while the developer sleeps.

---

## 3. Target Users

| Persona | Description |
|---------|-------------|
| **Solo Developer** | Uses Claude Code heavily for personal projects; hits rate limits nightly |
| **Agency/Freelance Dev** | Needs to maximize billable output; wants Claude working overnight on client projects |
| **Open Source Maintainer** | Queues large refactors, migrations, or documentation passes to run unattended |

---

## 4. User Stories

### Core Flow
1. **As a developer**, I want to type `/overtime` so that Claude continues my current task through rate limits without me being present.
2. **As a developer**, I want to type `/overtime refactor the auth module to use JWT` so that Claude picks up a new task and works on it autonomously.
3. **As a developer**, I want my computer to stay awake automatically when overtime is active, so nothing halts while I sleep.
4. **As a developer**, I want to see a summary of what Claude did overnight when I return.

### Edge Cases
5. **As a developer**, I want overtime to gracefully handle multiple queued tasks in sequence.
6. **As a developer**, I want to be able to cancel overtime mode if I return early.
7. **As a developer**, I want overtime to log its activity so I can audit what happened.

---

## 5. Feature Specification

### 5.1 `/overtime` Slash Command

| Attribute | Detail |
|-----------|--------|
| **Invocation** | `/overtime` or `/overtime <task prompt>` |
| **Location** | `.claude/commands/overtime.md` (project-scoped) |
| **Scope** | Project-level, version-controllable |

**Behavior:**

- **No arguments:** Activates overtime mode for the *current* task/conversation. Claude continues working in full-permission mode with caffeinate enabled. If rate-limited, it schedules a resume.
- **With arguments:** Adds the provided prompt to the overtime task queue. If overtime isn't active, it activates and begins with the provided task.

### 5.2 Caffeinate Integration

| Platform | Mechanism |
|----------|-----------|
| **macOS** | `caffeinate -dimsu` (prevent disk, display, system, and user-idle sleep) |
| **Linux** | `systemd-inhibit` or `xdg-screensaver` |
| **Windows** | Not in MVP (macOS-first) |

**Lifecycle:**
- Starts when `/overtime` is invoked.
- The `caffeinate` process is tracked by PID in `.claude/overtime/caffeinate.pid`.
- **Killed automatically when all overtime tasks complete** — once the last queued task finishes (or all tasks fail), the daemon sends `SIGTERM` to the `caffeinate` process. With caffeinate gone, **your computer will go to sleep naturally** per its normal power settings.
- Also killed on: user cancellation (`/overtime --cancel`), daemon error, or max runtime exceeded.
- A cleanup trap (`trap ... EXIT`) ensures `caffeinate` is killed even if the daemon crashes or Claude exits unexpectedly.
- On macOS, the daemon also calls `pmset sleepnow` after a short delay (configurable, default 60s) to actively trigger sleep once overtime is done, rather than waiting for the idle timeout.

### 5.3 Rate Limit Detection & Retry Loop

**Detection Strategy:**
- Claude Code outputs rate limit messages to stderr/stdout. A wrapper script monitors for rate limit signals.
- When detected, the script:
  1. Logs the rate limit event with timestamp.
  2. Parses the reset time from the error message (Anthropic includes approximate reset info).
  3. Calculates a sleep duration (reset time + 60s buffer).
  4. Sleeps until the reset window.
  5. Re-launches Claude Code with the queued task/prompt using `--dangerously-skip-permissions` and `--resume` flags.

**Implementation:**
- A **daemon script** (`overtime-daemon.sh` / `overtime-daemon.js`) wraps the Claude Code process.
- It runs as a background process, detached from the terminal.
- It uses a state file (`.claude/overtime/state.json`) to track:
  - Active status
  - Queue of pending tasks
  - Caffeinate PID
  - Rate limit history
  - Session logs

### 5.4 Full Permission Mode

When overtime activates, Claude Code is re-launched (or the current session is configured) with:

```bash
claude --dangerously-skip-permissions --resume
```

> [!CAUTION]
> This bypasses all confirmation prompts. Users must understand that Claude will execute file writes, shell commands, and other operations without asking. This is the core tradeoff of overtime mode.

### 5.5 Task Queue

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | UUID for the task |
| `prompt` | string | The user-provided task description |
| `status` | enum | `pending`, `active`, `completed`, `failed`, `rate_limited` |
| `created_at` | ISO timestamp | When the task was queued |
| `started_at` | ISO timestamp | When execution began |
| `completed_at` | ISO timestamp | When execution finished |
| `log_file` | path | Path to the session log |

Tasks are stored in `.claude/overtime/queue.json` and processed sequentially (FIFO).

### 5.6 Logging & Summary

- All Claude Code output during overtime is tee'd to `.claude/overtime/logs/<task-id>.log`.
- When all queued tasks complete, a **summary report** is generated at `.claude/overtime/summary.md`.
- The summary includes:
  - Tasks completed / failed
  - Files modified (with diff stats)
  - Errors encountered
  - Rate limit events
  - Total runtime

### 5.7 Cancellation

- **From another terminal:** `claude /overtime --cancel` or a signal file `.claude/overtime/cancel`
- **Cleanup:** Kills caffeinate, stops the daemon, writes a partial summary.

---

## 6. Technical Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    User's Terminal                       │
│                                                         │
│  $ claude                                               │
│  > /overtime refactor auth to use JWT                   │
│                                                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              overtime.md (Slash Command)                 │
│                                                         │
│  1. Writes task to queue.json                           │
│  2. Launches overtime-daemon                            │
│  3. Starts caffeinate                                   │
│  4. Launches claude --dangerously-skip-permissions      │
│                                                         │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│              overtime-daemon.sh                          │
│                                                         │
│  • Monitors Claude Code process                         │
│  • Detects rate limit from exit code / output           │
│  • On rate limit:                                       │
│      - Calculates reset time                            │
│      - Sleeps until reset                               │
│      - Re-launches claude with --resume                 │
│  • On task complete:                                    │
│      - Pops next task from queue                        │
│      - Re-launches claude with new prompt               │
│  • On all tasks done:                                   │
│      - Kills caffeinate                                 │
│      - Generates summary.md                             │
│      - Sends desktop notification                       │
│                                                         │
└─────────────────────────────────────────────────────────┘
```

### File Structure

```
.claude/
├── commands/
│   └── overtime.md            # Slash command definition
├── skills/
│   └── overtime/
│       ├── SKILL.md           # Skill metadata & instructions
│       └── scripts/
│           ├── overtime-daemon.sh    # Main daemon loop
│           ├── caffeinate-mgr.sh     # Caffeinate lifecycle
│           ├── queue-mgr.sh          # Task queue CRUD
│           ├── rate-limit-parser.sh  # Parse rate limit info
│           └── summary-gen.sh        # Generate summary report
└── overtime/                  # Runtime state (gitignored)
    ├── state.json             # Daemon state
    ├── queue.json             # Task queue
    ├── logs/                  # Session logs
    │   └── <task-id>.log
    ├── summary.md             # Generated summary
    └── overtime.pid           # Daemon PID file
```

---

## 7. Risk Assessment

| Risk | Severity | Mitigation |
|------|----------|------------|
| Claude makes destructive changes overnight | **High** | Git auto-commit before each task; user accepts risk explicitly |
| Caffeinate drains laptop battery | **Medium** | Recommend plugging in; warn on battery power |
| Rate limit parsing breaks with API changes | **Medium** | Fallback to fixed 5-hour retry interval |
| Daemon crashes silently | **Medium** | PID file + heartbeat check; desktop notification on exit |
| Infinite loop / runaway process | **Low** | Max retry count (default: 10); max runtime (default: 8h) |

---

## 8. Configuration

Users can configure overtime via `.claude/overtime/config.json`:

```json
{
  "max_retries": 10,
  "max_runtime_hours": 8,
  "retry_buffer_seconds": 60,
  "fallback_retry_minutes": 300,
  "auto_commit": true,
  "auto_commit_prefix": "[overtime]",
  "notify_on_complete": true,
  "notify_on_error": true,
  "log_level": "info"
}
```

---

## 9. Success Metrics

| Metric | Target |
|--------|--------|
| Time from `/overtime` to daemon running | < 5 seconds |
| Successful rate-limit recovery rate | > 95% |
| Task completion rate (non-rate-limit failures) | > 80% |
| User returns to completed work | Qualitative success |

---

## 10. Out of Scope (v1)

- Windows support
- Web dashboard / UI
- Multi-machine orchestration
- Claude API key management (uses existing auth)
- Concurrent task execution (sequential only)
- Integration with CI/CD pipelines

---

## 11. Open Questions

1. Should overtime auto-commit to a separate git branch for safety?
2. Should there be a "dry run" mode that logs what Claude *would* do?
3. What's the best way to detect rate limits — exit codes, stderr parsing, or a combination?
4. Should the daemon support webhook notifications (e.g., Slack/Discord)?

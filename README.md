# Claude Overtime

> Type `/overtime`, go to sleep. Wake up to completed work.

**Claude Overtime** is a [Claude Code](https://docs.anthropic.com/en/docs/claude-code) plugin that enables unattended, rate-limit-resilient coding sessions. When activated via the `/overtime` slash command, it keeps your machine awake, monitors for rate limits, and automatically retries — so Claude keeps working while you're AFK.

---

## Features

- **🚀 `/overtime` Slash Command** — One command to enter autonomous mode
- **☕ Caffeinate Integration** — Prevents your Mac from sleeping while tasks run
- **🔄 Rate Limit Recovery** — Detects rate limits, waits for reset, and resumes automatically
- **📋 Task Queue** — Queue multiple prompts for sequential execution
- **📝 Session Summary** — Get a full report of what Claude did while you were away
- **🛡️ Git Safety Net** — Auto-commits to a branch before each task for easy rollback

## Installation

### 1. Clone this repo into your project

```bash
# From your project root
git clone https://github.com/lewisnsmith/claude-overtime.git .claude-overtime-tmp
cp -r .claude-overtime-tmp/.claude .claude
rm -rf .claude-overtime-tmp
```

### 2. Or copy the files manually

Copy the following directories into your project:

```
.claude/
├── commands/
│   └── overtime.md
└── skills/
    └── overtime/
        ├── SKILL.md
        └── scripts/
            ├── overtime-daemon.sh
            ├── caffeinate-mgr.sh
            ├── queue-mgr.sh
            ├── rate-limit-parser.sh
            └── summary-gen.sh
```

### 3. Prerequisites

- **macOS** (Linux support planned)
- **Claude Code** installed and authenticated
- **`jq`** for JSON processing: `brew install jq`

## Usage

### Start an overtime session

```
> /overtime
```

Activates overtime mode for your current task. Claude continues working through rate limits.

### Queue a specific task

```
> /overtime refactor the auth module to use JWT
```

Adds the task to the queue and begins processing.

### Check status

```bash
# From another terminal
./claude/skills/overtime/scripts/overtime-daemon.sh --status
```

### Cancel overtime

```bash
# From another terminal
./claude/skills/overtime/scripts/overtime-daemon.sh --cancel
```

## Configuration

Edit `.claude/overtime/config.json` to customize:

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

## ⚠️ Risk Acknowledgement

Claude Overtime runs with `--dangerously-skip-permissions`. This means Claude will **execute file writes, shell commands, and other operations without asking for confirmation**. This is the core tradeoff: maximum autonomy for maximum throughput when you're AFK.

**Recommended safeguards:**
- Always run on a dedicated git branch (overtime does this automatically)
- Review the generated summary and diffs when you return
- Set `max_runtime_hours` to a reasonable limit
- Plug in your laptop — caffeinate will keep it awake

## How It Works

```
You type /overtime
       │
       ▼
┌─────────────────────┐
│  overtime.md        │  Slash command activates the system
│  (Slash Command)    │
└────────┬────────────┘
         │
         ▼
┌─────────────────────┐
│  overtime-daemon.sh │  Background daemon monitors Claude
│  (Main Loop)        │  Detects rate limits, retries, queues
└────────┬────────────┘
         │
    ┌────┴────┐
    ▼         ▼
┌────────┐ ┌──────────┐
│caffeinate│ │queue.json│
│(awake)  │ │(tasks)   │
└────────┘ └──────────┘
```

## License

MIT — see [LICENSE](LICENSE).

---
description: Queue a long-running, unattended Claude Code session that survives rate limits.
allowed-tools:
  - Bash
  - Glob
  - Grep
  - LS
  - ReadFile
  - FileEdit
---

# Overtime Command

You are being asked to enter "Overtime Mode" or queue a task for Overtime.

If the user provided an argument: `$ARGUMENTS`

1. Delegate this command to the `overtime-daemon.sh` script to handle the queueing and launching of the overtime session.

```bash
!command
.claude/skills/overtime/scripts/overtime-daemon.sh --add "$ARGUMENTS"
```
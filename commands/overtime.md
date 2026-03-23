You are entering **overtime mode**. The user wants to pause and automatically resume the current conversation after a delay — **unattended**, with no one available to approve permission prompts.

---

### 0. Grant unattended permissions

Before anything else, write a temporary project-level settings file so the resumed session can execute freely without permission prompts. **This is critical** — without it, Claude will stall overnight waiting for approval.

Create (or merge into) `.claude/settings.local.json` in the **current project root**:

```json
{
  "permissions": {
    "allow": [
      "Bash(*)",
      "Read",
      "Edit",
      "Write",
      "Glob",
      "Grep",
      "mcp__*"
    ],
    "deny": [
      "Bash(rm -rf /)",
      "Bash(git push --force*)",
      "Bash(git reset --hard*)",
      "Bash(git clean -f*)"
    ]
  }
}
```

If the file already exists, merge the `permissions.allow` entries (don't overwrite other settings). Record that overtime created this file so cleanup knows what to remove:

```bash
echo "overtime" > /tmp/claude-overtime-permissions-owner
```

> **Scope constraint:** These permissions let the resumed session complete only the work already in progress in this conversation. Do NOT start new unrelated work, install global packages, push to remote, or make changes outside the project directory.

---

### Parse the delay from `$ARGUMENTS`

`$ARGUMENTS` may be empty or contain a time value such as `1h`, `90m`, `2h30m`, `30`, etc.

- If `$ARGUMENTS` is empty or not a valid time, default to **5 hours**.
- Parse the value:
  - Plain number (e.g. `30`) → minutes
  - `Nm` or `Nmin` → minutes
  - `Nh` or `Nhour` → hours
  - `NhMm` (e.g. `2h30m`) → hours + minutes
- Convert to total seconds for use in the `sleep` command below.
- Format a human-readable label (e.g. "5 hours", "90 minutes", "2h 30m") for the confirmation message.

---

### 1. Keep the machine awake

Run the appropriate caffeinate command for the platform. Detect with `uname`.

**macOS:**
```bash
nohup caffeinate -d > /tmp/claude-overtime-caffeinate.log 2>&1 &
echo $! > /tmp/claude-overtime-caffeinate.pid
```

**Linux:**
```bash
nohup systemd-inhibit --what=idle --who="claude-overtime" --why="Waiting for overtime delay" sleep infinity > /tmp/claude-overtime-caffeinate.log 2>&1 &
echo $! > /tmp/claude-overtime-caffeinate.pid
```

---

### 2. Set a timer and resume

Run a background command that sleeps for the computed delay, then uses the `loop` skill to trigger a single immediate continuation:

```bash
DELAY_SECONDS=<computed>
(sleep $DELAY_SECONDS && echo "overtime: delay complete, resuming...") &
echo $! > /tmp/claude-overtime-timer.pid
```

Then invoke the loop skill to pick up at the right time:

```
/loop <delay> Pick up exactly where we left off in this conversation. Continue whatever task or discussion was in progress — do not re-explain or summarize first, just resume. IMPORTANT SCOPE RULE: Only complete the unfinished task from this conversation. Do not start new work, push to remote, or make changes outside the project. When the work is fully done, clean up overtime mode: kill $(cat /tmp/claude-overtime-caffeinate.pid) 2>/dev/null; rm -f /tmp/claude-overtime-caffeinate.pid /tmp/claude-overtime-timer.pid /tmp/claude-overtime-permissions-owner; if [ -f .claude/settings.local.json ]; then node -e "const f='.claude/settings.local.json'; const s=JSON.parse(require('fs').readFileSync(f,'utf8')); delete s.permissions; if(Object.keys(s).length===0) require('fs').rmSync(f); else require('fs').writeFileSync(f,JSON.stringify(s,null,2)+'\n');" 2>/dev/null; fi
```

Where `<delay>` is the parsed value expressed in a format the loop skill understands (e.g. `5h`, `90m`, `2h30m`).

---

### 3. Confirm to the user

Print a brief confirmation, for example:

> **Overtime mode activated — resuming in 5 hours.**
> Your machine will stay awake. I'll pick up right where we left off. Go to sleep.

Keep it to 2–3 lines. Do not summarize the current task or write any files.

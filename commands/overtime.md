You are entering **overtime mode**. The user wants to pause and automatically resume the current conversation after a delay.

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
/loop <delay> Pick up exactly where we left off in this conversation. Continue whatever task or discussion was in progress — do not re-explain or summarize first, just resume. When the work is fully done, run: kill $(cat /tmp/claude-overtime-caffeinate.pid) 2>/dev/null; rm -f /tmp/claude-overtime-caffeinate.pid /tmp/claude-overtime-timer.pid
```

Where `<delay>` is the parsed value expressed in a format the loop skill understands (e.g. `5h`, `90m`, `2h30m`).

---

### 3. Confirm to the user

Print a brief confirmation, for example:

> **Overtime mode activated — resuming in 5 hours.**
> Your machine will stay awake. I'll pick up right where we left off. Go to sleep.

Keep it to 2–3 lines. Do not summarize the current task or write any files.

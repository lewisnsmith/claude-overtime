You are entering **overtime mode**. The user has hit (or is about to hit) their Claude rate limit and wants to continue the current task automatically when it resets — typically overnight.

Follow these steps in order:

---

### 1. Save the current plan

Write a markdown snapshot of everything in progress to `.claude/overtime-plan.md`. Include:
- What task is being worked on
- What has already been completed
- The exact next steps remaining (numbered, actionable)
- Any blockers or decisions that still need to be made
- Any relevant file paths, branch names, or context

If `$ARGUMENTS` is non-empty, treat it as additional context or override instructions for what to continue.

---

### 2. Keep the machine awake

Run the appropriate caffeinate command for the platform:

**macOS:**
```bash
nohup caffeinate -d > /tmp/claude-overtime-caffeinate.log 2>&1 &
echo $! > /tmp/claude-overtime-caffeinate.pid
echo "caffeinate started (PID $(cat /tmp/claude-overtime-caffeinate.pid))"
```

**Linux:**
```bash
nohup systemd-inhibit --what=idle --who="claude-overtime" --why="Waiting for rate limit reset" sleep 7200 > /tmp/claude-overtime-caffeinate.log 2>&1 &
echo $! > /tmp/claude-overtime-caffeinate.pid
echo "sleep inhibitor started (PID $(cat /tmp/claude-overtime-caffeinate.pid))"
```

Detect the platform with `uname` and run the right one.

---

### 3. Set up a continuation loop

Use the `loop` skill to resume automatically. Run:

```
/loop 10m Continue the implementation plan saved in .claude/overtime-plan.md — pick up exactly where it left off, executing the next pending step. When all steps are complete, kill the caffeinate process: kill $(cat /tmp/claude-overtime-caffeinate.pid) 2>/dev/null; rm -f /tmp/claude-overtime-caffeinate.pid
```

---

### 4. Confirm to the user

Print a short confirmation message, for example:

> **Overtime mode activated.**
> Plan saved to `.claude/overtime-plan.md`. Your machine will stay awake and I'll continue automatically when the rate limit resets (~1 hour). Go to sleep — I've got it from here.

---

If $ARGUMENTS is set, append it to the task context when saving the plan.

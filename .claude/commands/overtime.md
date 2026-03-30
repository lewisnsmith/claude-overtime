You are entering **overtime mode**. The user wants to pause and automatically resume the current conversation after a delay — **unattended**, with no one available to approve permission prompts.

**Critical difference from a simple timer:** You must capture the current task context and spawn a manager agent that will actively continue the work after the delay. Do NOT just set a timer and hope — you are responsible for ensuring work continues.

If the user provided an argument: `$ARGUMENTS`

---

### Step 0: Capture task context

Before doing anything else, figure out what work needs to be continued. Use **one** of these approaches:

**A) Plan file exists:** Glob for plan files at `~/.claude/plans/*.md`. If any exist, read the most recently modified one. Extract the incomplete/pending steps — these are the tasks the manager agent will execute.

**B) No plan file:** Write a concise task summary (3–5 bullet points) describing:
- What the user was working on in this conversation
- What steps remain to be done
- Any important context (branch name, key files, test commands)

Store this context mentally — you will pass it to the manager agent prompt in Step 3.

---

### Step 1: Grant unattended permissions

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
      "Agent",
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

If the file already exists, merge the `permissions.allow` entries (don't overwrite other settings). Record ownership:

```bash
echo "overtime" > /tmp/claude-overtime-permissions-owner
```

---

### Step 2: Parse the delay from `$ARGUMENTS`

- If `$ARGUMENTS` is empty or not a valid time, default to **5 hours**.
- Parse formats: plain number → minutes, `Nm`/`Nmin` → minutes, `Nh`/`Nhour` → hours, `NhMm` → hours + minutes, `Ns` → seconds (for testing).
- Convert to total seconds.
- Format a human-readable label (e.g. "5 hours", "90 minutes", "2h 30m").

---

### Step 3: Keep the machine awake

Detect platform with `uname`.

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

### Step 4: Confirm to the user

Print a confirmation message like:

> **Overtime mode activated — resuming in {delay_label}.**
>
> **Task context captured:**
> {show the 3-5 bullet point summary or plan steps}
>
> Your machine will stay awake. A manager agent will pick up the work automatically. Go to sleep.

---

### Step 5: Wait for delay, then spawn the manager agent

Run the delay as a foreground wait so the session stays alive:

```bash
DELAY_SECONDS=<computed>
echo "Overtime: sleeping for $DELAY_SECONDS seconds..."
sleep $DELAY_SECONDS
echo "Overtime: delay complete, spawning manager agent..."
```

Then immediately spawn an **Agent** (using the Agent tool) with the following prompt. Replace `{TASK_CONTEXT}` with the captured context from Step 0:

```
You are the **Overtime Manager Agent**. A previous session was paused due to
rate limits. Your job is to continue and complete the unfinished work.

## Task Context
{TASK_CONTEXT}

## Instructions

1. **Assess current state**: Run `git status` and `git diff --stat` to understand
   what has already been done. Read any key files mentioned in the task context.

2. **Execute remaining work**: Work through the incomplete tasks systematically.
   - Do coding work directly: read files, edit code, write new files, run tests.
   - For complex or independent sub-tasks, spawn worker Agent subagents to
     parallelize the work.
   - Run tests and fix any failures before considering a task complete.

3. **Track progress**: Use TodoWrite to track which tasks are done as you work
   through them.

4. **When all work is complete**, run cleanup:
   ```bash
   # Kill caffeinate
   if [ -f /tmp/claude-overtime-caffeinate.pid ]; then
     kill $(cat /tmp/claude-overtime-caffeinate.pid) 2>/dev/null
     rm -f /tmp/claude-overtime-caffeinate.pid
   fi
   rm -f /tmp/claude-overtime-timer.pid /tmp/claude-overtime-permissions-owner

   # Clean up temporary permissions
   if [ -f .claude/settings.local.json ]; then
     node -e "
       const f='.claude/settings.local.json';
       const s=JSON.parse(require('fs').readFileSync(f,'utf8'));
       delete s.permissions;
       if(Object.keys(s).length===0) require('fs').rmSync(f);
       else require('fs').writeFileSync(f,JSON.stringify(s,null,2)+'\n');
     " 2>/dev/null
   fi
   ```

5. **Print a completion summary** listing what was done.

## SCOPE RULES
- Only complete the tasks described above.
- Do NOT start new unrelated work.
- Do NOT push to remote or deploy.
- Do NOT make changes outside the project directory.
- If you are unsure about a task, skip it and note it in the summary.
```

**Important:** The Agent tool call should use `description: "Overtime manager agent"` and pass the full prompt above (with `{TASK_CONTEXT}` replaced by the actual captured context).

---

### That's it.

Do NOT use `/loop` — it does not reliably continue work. The Agent-based approach above ensures focused, context-aware continuation.

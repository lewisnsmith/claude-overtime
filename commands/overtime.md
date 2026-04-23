You are entering **overtime mode**. The user wants to pause and automatically resume the current conversation after a delay — **unattended**, with no one available to approve permission prompts.

Everything before the sleep must be mechanical bash — no summarization, no questions, no AI reasoning. All token-consuming work happens after the delay when the rate limit has reset.

---

### 0. Read config

Read and merge global and project overtime config. All subsequent steps use these values.

```bash
_OT_GLOBAL_CONFIG="$HOME/.claude/overtime-config.json"
_OT_PROJECT_CONFIG="$(pwd)/.claude/overtime-config.json"

_OT_CONFIG=$(node -e "
  const fs=require('fs');
  const D={defaultDelay:'5h',warnAt:90000,maxRetries:5,abortBehavior:'stop',
            customRules:[],prTitlePrefix:'overtime: ',prBodyTemplate:'{{log}}',protectedBranches:[]};
  function r(p){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){return {};}}
  const g=r(process.env._OT_GLOBAL_CONFIG||''), p=r(process.env._OT_PROJECT_CONFIG||'');
  const m=Object.assign({},D,g,p);
  m.customRules=[...(Array.isArray(g.customRules)?g.customRules:[]),...(Array.isArray(p.customRules)?p.customRules:[])];
  m.protectedBranches=['main','master',...(Array.isArray(p.protectedBranches)?p.protectedBranches:[])];
  console.log(JSON.stringify(m));
" 2>/dev/null || echo '{}')

_OT_DEFAULT_DELAY=$(node -e "try{console.log(JSON.parse(process.env._OT_CONFIG).defaultDelay||'5h')}catch(e){console.log('5h')}" 2>/dev/null || echo "5h")
_OT_MAX_RETRIES=$(node -e "try{console.log(JSON.parse(process.env._OT_CONFIG).maxRetries||5)}catch(e){console.log(5)}" 2>/dev/null || echo "5")
_OT_ABORT_BEHAVIOR=$(node -e "try{const b=JSON.parse(process.env._OT_CONFIG).abortBehavior||'stop';console.log(b.charAt(0).toUpperCase()+b.slice(1))}catch(e){console.log('Stop')}" 2>/dev/null || echo "Stop")
_OT_PR_TITLE_PREFIX=$(node -e "try{console.log(JSON.parse(process.env._OT_CONFIG).prTitlePrefix||'overtime: ')}catch(e){console.log('overtime: ')}" 2>/dev/null || echo "overtime: ")
_OT_PR_BODY_TEMPLATE=$(node -e "try{process.stdout.write(JSON.parse(process.env._OT_CONFIG).prBodyTemplate||'{{log}}')}catch(e){process.stdout.write('{{log}}')" 2>/dev/null || printf '{{log}}')
_OT_CUSTOM_RULES=$(node -e "try{const c=JSON.parse(process.env._OT_CONFIG);const r=c.customRules||[];console.log(r.join('\n\n'))}catch(e){console.log('')}" 2>/dev/null || echo "")
_OT_PROTECTED_BRANCHES=$(node -e "try{const c=JSON.parse(process.env._OT_CONFIG);const b=(c.protectedBranches||[]).filter(b=>b!=='main'&&b!=='master');console.log(b.join(' '))}catch(e){console.log('')}" 2>/dev/null || echo "")
```

---

### 1. Parse the delay from `$ARGUMENTS`

`$ARGUMENTS` may be empty or contain a time value such as `1h`, `90m`, `2h30m`, `30`, etc.

- If `$ARGUMENTS` is empty or not a valid time, default to **`$_OT_DEFAULT_DELAY`** (from config, initially 5 hours).
- Parse the value:
  - Plain number (e.g. `30`) → minutes
  - `Nm` or `Nmin` → minutes
  - `Nh` or `Nhour` → hours
  - `NhMm` (e.g. `2h30m`) → hours + minutes
  - `Ns` → seconds (useful for testing)
- Convert to total seconds for use in the `sleep` command below.
- Format a human-readable label (e.g. "5 hours", "90 minutes", "2h 30m") for the confirmation message.

---

### 2. Start caffeinate

Run the appropriate command for the platform. Detect with `uname`.

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

### 3. Write the state file

Generate a branch name and write the state file so the agent can find everything after waking up. Use the Bash tool:

```bash
PLAN_FILE=$(ls -t ~/.claude/plans/*.md 2>/dev/null | head -1)
PROJECT_ROOT="$(pwd)"
BRANCH="overtime/$(date +%Y%m%d-%H%M%S)"
DELAY_SECONDS=<computed from Step 1>
EXPIRY_AT=$(( $(date +%s) + DELAY_SECONDS + 3600 ))

node -e "
  require('fs').writeFileSync('/tmp/claude-overtime-state.json', JSON.stringify({
    plan_file: process.env.PLAN_FILE || null,
    project_root: process.env.PROJECT_ROOT,
    delay_seconds: parseInt(process.env.DELAY_SECONDS),
    expires_at: parseInt(process.env.EXPIRY_AT),
    branch: process.env.BRANCH,
    owner: 'overtime'
  }, null, 2) + '\n');
" 2>/dev/null

echo "overtime" > /tmp/claude-overtime-permissions-owner
```

---

### 4. Print confirmation and sleep

Print exactly:

> **Overtime activated. Resuming in [DELAY_LABEL]. Go to sleep.**

Then run a **foreground** sleep with a cleanup trap so permissions and state files are removed if the process is killed before the agent fires:

```bash
DELAY_SECONDS=<computed>

_overtime_cleanup() {
  if [ -f /tmp/claude-overtime-caffeinate.pid ]; then
    kill "$(cat /tmp/claude-overtime-caffeinate.pid)" 2>/dev/null || true
    rm -f /tmp/claude-overtime-caffeinate.pid
  fi
  rm -f /tmp/claude-overtime-state.json /tmp/claude-overtime-permissions-owner 2>/dev/null || true
}
trap _overtime_cleanup EXIT INT TERM HUP

echo "Overtime: sleeping for $DELAY_SECONDS seconds..."
sleep "$DELAY_SECONDS"
echo "Overtime: delay complete, spawning manager agent..."
trap - EXIT INT TERM HUP
```

---

### 5. Spawn the manager agent

Immediately after the sleep completes, invoke the **Agent tool** with the following prompt verbatim. The agent will read the state file to get everything it needs.

---

```
You are the **Overtime Manager Agent**. A previous Claude Code session was paused
due to rate limits. Your job is to set up the session and complete the work —
then create a draft PR for the user to review in the morning.

Read /tmp/claude-overtime-state.json first to get: plan_file, project_root, branch name.

---

## Step 1 — Read task context

If plan_file is set and the file exists, read it in full to understand the pending work.

If plan_file is null or missing, run:
  git log --oneline -20
  git status
  git diff --stat HEAD

Use that output to infer what was in progress. Produce a 2–3 sentence summary of: what the
goal is, what approach is being used, and what remains to be done.

---

## Step 2 — Write session rules

Write `.claude/overtime-rules.md` in the project root with this exact structure:

````markdown
# Overtime Session Rules

## Task snapshot

> <INSERT 2–3 SENTENCE SUMMARY FROM STEP 1>

This is the scope anchor. Every 3 commits, re-read this and confirm work is still on-scope.
If drift is detected, stop, log a note in `.claude/overtime-log.md`, and re-center.

## Abort behavior

On-failure mode: **$_OT_ABORT_BEHAVIOR**

---

## Rules

### 1. Pre-session git checkpoint
Before writing any file, run:
  git add -A && git commit -m "chore(overtime): checkpoint before unattended session [$(date +%Y%m%d-%H%M%S)]"
If this fails for any reason other than "nothing to commit", log the error to `.claude/overtime-log.md` and halt.

### 2. Per-module incremental commits
After completing each logical unit of work, commit before moving to the next.
Format: `feat(<module>): <one-line description>`. Never batch changes across 3+ files before committing.

### 3. Final commit on completion
When all work is done — before cleanup — make a final commit:
  chore(overtime): session complete — see .claude/overtime-log.md

### 4. Session log
After completing each module, append to `.claude/overtime-log.md`:
  ## [YYYY-MM-DD HH:MM] — <module name>
  **What was done:** ...
  **Files modified:** ...
  **Patterns used:** ...
  **Edge cases handled:** ...
  **Known limitations / follow-up needed:** ...

### 5. Architecture consistency
Before editing any existing file, read it in full first. Match existing patterns.
Before creating a new file, grep the codebase for dominant patterns and match them.

### 6. Structural integrity
Every function written must handle the null/empty/error case. No dead code, placeholder TODOs,
or half-finished branches may be committed.

### 7. Dependency audit
Before writing code, verify all packages exist in package.json / requirements.txt / pyproject.toml.
Never reference a package that hasn't been confirmed to exist.

### 8. Context drift prevention
Every 3 commits, re-read the Task snapshot above and confirm work is still on-scope.
Log any out-of-scope ideas as follow-ups in `.claude/overtime-log.md` — do not implement them.

### 9. Git push restriction
Only push the overtime branch. Never push main or master.

### 10. Rate limit — stop immediately
If you hit a rate limit error (HTTP 429, "token limit exceeded"), stop work at once.
Log what was completed and what remains in `.claude/overtime-log.md`.
Proceed directly to the final commit, PR creation, and cleanup. Do not retry.

$([ -n "$_OT_CUSTOM_RULES" ] && printf '%s' "$_OT_CUSTOM_RULES")
````

Also ensure `.claude/overtime-log.md` is in the project's `.gitignore`.

---

## Step 3 — Grant permissions

Create or merge into `.claude/settings.local.json` in the project root:

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
      "Bash(git push origin main*)",
      "Bash(git push origin master*)",
      $([ -n "$_OT_PROTECTED_BRANCHES" ] && for b in $_OT_PROTECTED_BRANCHES; do printf '      "Bash(git push origin %s*)",\n' "$b"; done)
      "Bash(git reset --hard*)",
      "Bash(git clean -f*)"
    ]
  }
}
```

If the file already exists, merge the `permissions` key — preserve any other keys.

Then update the state file with the settings path:

```bash
node -e "
  const f='/tmp/claude-overtime-state.json';
  const s=JSON.parse(require('fs').readFileSync(f,'utf8'));
  s.settings_path='$(pwd)/.claude/settings.local.json';
  require('fs').writeFileSync(f,JSON.stringify(s,null,2)+'\n');
" 2>/dev/null
```

---

## Step 4 — Create the overtime branch

```bash
BRANCH=<value from state file>
git checkout -b "$BRANCH"
```

---

## Step 5 — Git checkpoint

```bash
git add -A && git commit -m "chore(overtime): checkpoint before unattended session [$(date +%Y%m%d-%H%M%S)]"
```

If this fails for any reason other than "nothing to commit":
- Log the error to `.claude/overtime-log.md`
- Run the cleanup in Step 8
- Exit

---

## Step 6 — Execute remaining work

Work through the incomplete tasks from the plan or your inferred summary.

- Do coding work directly: read files, edit code, write new files, run tests.
- For complex or independent sub-tasks, spawn worker Agent subagents to parallelize.
- Run tests and fix failures before considering a task complete.
- After each logical unit, commit (Rule 2) and append to `.claude/overtime-log.md` (Rule 4).
- Every 3 commits, re-read the Task snapshot from `.claude/overtime-rules.md` and confirm scope.
- If you hit a rate limit at any point, follow Rule 10: stop immediately and proceed to Step 7.

---

## Step 7 — Final commit, push, and draft PR

When work is complete (or stopped due to rate limit):

```bash
# Final commit (if there are staged changes)
git add -A
git commit -m "chore(overtime): session complete — see .claude/overtime-log.md" 2>/dev/null || true

# Push the overtime branch
BRANCH=<value from state file>
git push -u origin "$BRANCH"

# Create draft PR
SUMMARY=<one-line task summary from Step 1>
_OT_LOG_CONTENT=$(cat .claude/overtime-log.md 2>/dev/null || echo 'Overtime session complete.')
_OT_PR_BODY=$(node -e "
  const t=process.env._OT_PR_BODY_TEMPLATE||'{{log}}';
  const l=process.env._OT_LOG_CONTENT||'';
  console.log(t.replace('{{log}}',l));
" 2>/dev/null || echo "$_OT_LOG_CONTENT")
gh pr create --draft \
  --title "${_OT_PR_TITLE_PREFIX}$SUMMARY" \
  --body "$_OT_PR_BODY"
```

Print the PR URL.

---

## Step 8 — Cleanup

```bash
PROJECT_ROOT=<value from state file>

# Kill caffeinate
if [ -f /tmp/claude-overtime-caffeinate.pid ]; then
  kill "$(cat /tmp/claude-overtime-caffeinate.pid)" 2>/dev/null || true
  rm -f /tmp/claude-overtime-caffeinate.pid
fi

# Remove state files
rm -f /tmp/claude-overtime-state.json /tmp/claude-overtime-permissions-owner 2>/dev/null || true

# Remove overtime permissions (preserve other settings)
SETTINGS="$PROJECT_ROOT/.claude/settings.local.json"
if [ -f "$SETTINGS" ]; then
  node -e "
    const f='$SETTINGS';
    try {
      const s=JSON.parse(require('fs').readFileSync(f,'utf8'));
      delete s.permissions;
      if(Object.keys(s).length===0) require('fs').rmSync(f);
      else require('fs').writeFileSync(f,JSON.stringify(s,null,2)+'\n');
    } catch(e) {}
  " 2>/dev/null
fi

# Remove rules file
rm -f "$PROJECT_ROOT/.claude/overtime-rules.md" 2>/dev/null || true
```

---

## SCOPE RULES
- Only complete the tasks described in the plan or inferred from git history.
- Do NOT start new unrelated work.
- Do NOT push to main or master.
- Do NOT make changes outside the project directory.
- If unsure about a task, skip it and note it in the log.
```

---

**Important:** Do NOT use `/loop` — it does not reliably continue work and provides no crash safety. The Agent-based approach above keeps full task context and handles cleanup correctly.

You are entering **overtime mode**. Parse `$ARGUMENTS` to determine mode and delay, then execute the corresponding lifecycle below.

---

## Flag Dispatch

| `$ARGUMENTS` | Mode | Delay |
|---|---|---|
| *(empty)* | single-task | computed from rate-limit reset |
| `1h` / `90m` / `2h30m` / `30s` | single-task | explicit |
| `--backlog` | backlog | computed |
| `--backlog 3c` | backlog, max 3 cycles | computed |
| `--backlog 6h` | backlog, soft 6h deadline | computed |
| `--resume` | resume from existing state | n/a |
| `--auto` | single-task (Stop-hook scheduled) | computed |

Parse now:

```bash
_OT_ARGS="${ARGUMENTS:-}"
_OT_MODE="single"
_OT_RESUME=no
_OT_BACKLOG_MAX_CYCLES=8
_OT_SOFT_DEADLINE=""

if echo "$_OT_ARGS" | grep -q -- "--resume"; then _OT_RESUME=yes; fi
if echo "$_OT_ARGS" | grep -q -- "--backlog"; then _OT_MODE="backlog"; fi

# Backlog cycle cap (e.g. "3c")
_OT_CYCLE_ARG=$(echo "$_OT_ARGS" | grep -oE '[0-9]+c' | head -1)
if [ -n "$_OT_CYCLE_ARG" ]; then
  _OT_BACKLOG_MAX_CYCLES=$(echo "$_OT_CYCLE_ARG" | grep -oE '[0-9]+')
fi

# Explicit delay arg (time string like 1h, 90m, 2h30m, 30s — NOT a cycle cap)
_OT_DELAY_ARG=$(echo "$_OT_ARGS" | grep -oE '[0-9]+h[0-9]*m?|[0-9]+m|[0-9]+h|[0-9]+s' | grep -v '[0-9]c' | head -1)

# Soft deadline for backlog (e.g. "6h" or "90m" when in backlog mode)
if [ "$_OT_MODE" = "backlog" ] && [ -n "$_OT_DELAY_ARG" ]; then
  _OT_SOFT_DEADLINE_SECS=$(node -e "
    const a='$_OT_DELAY_ARG';
    const hm=a.match(/^(\d+)h(\d+)?m?$/);
    const m=a.match(/^(\d+)m$/); const h=a.match(/^(\d+)h$/); const s=a.match(/^(\d+)s$/);
    if(hm) console.log((parseInt(hm[1])*3600)+(parseInt(hm[2]||0)*60));
    else if(h) console.log(parseInt(h[1])*3600);
    else if(m) console.log(parseInt(m[1])*60);
    else if(s) console.log(parseInt(s[1]));
    else console.log(0);
  " 2>/dev/null || echo "0")
  if [ "$_OT_SOFT_DEADLINE_SECS" -gt 0 ]; then
    _OT_SOFT_DEADLINE=$(( $(date +%s) + _OT_SOFT_DEADLINE_SECS ))
  fi
  _OT_DELAY_ARG=""  # not a sleep delay in backlog mode
fi
```

---

## Step 0 — Handle `--resume`

If `_OT_RESUME=yes`:

```bash
_OT_STATE_FILE="$HOME/.claude/overtime-state/$(ls -t "$HOME/.claude/overtime-state/" 2>/dev/null | head -1)"
if [ ! -f "$_OT_STATE_FILE" ]; then
  echo "No resumable overtime state found. Run /overtime to start fresh."
  exit 1
fi
```

Read the state file. If `mode` is `"single"`, jump to **Single-task Step 5 (spawn manager)**. If `mode` is `"backlog"`, print cursor summary and jump to **Backlog Step 5 (cycle loop)**, skipping already-completed tracks using `cursor.tracks[*].status === "done"`.

---

## Step 1 — Load merged config

All subsequent steps use these values.

```bash
node -e "
  const fs=require('fs');
  const D={
    defaultDelay:'auto', delayBuffer:'5m', warnAt:90, maxRetries:5,
    abortBehavior:'stop', customRules:[], prTitlePrefix:'overtime: ',
    prBodyTemplate:'{{log}}', protectedBranches:[],
    editAllowGlobs:['**/*'],
    editDenyGlobs:['node_modules/**','.git/**','**/.env*']
  };
  function r(p){try{return JSON.parse(fs.readFileSync(p,'utf8'));}catch(e){return {};}}
  const g=r(process.env.HOME+'/.claude/overtime-config.json');
  const p=r(process.cwd()+'/.claude/overtime-config.json');
  const m=Object.assign({},D,g,p);
  m.customRules=[...(Array.isArray(g.customRules)?g.customRules:[]),...(Array.isArray(p.customRules)?p.customRules:[])];
  m.protectedBranches=['main','master',...(Array.isArray(p.protectedBranches)?p.protectedBranches:[])];
  console.log(JSON.stringify(m));
" 2>/dev/null
```

Extract:
- `_OT_DEFAULT_DELAY` — `"auto"` or a time string
- `_OT_DELAY_BUFFER` — e.g. `"5m"`
- `_OT_MAX_RETRIES`
- `_OT_ABORT_BEHAVIOR` — `"stop"` | `"continue"`
- `_OT_PR_TITLE_PREFIX`
- `_OT_PR_BODY_TEMPLATE`
- `_OT_CUSTOM_RULES` — newline-joined
- `_OT_PROTECTED_BRANCHES` — space-joined (excludes main/master already in deny list)

---

## Step 2 — Compute delay (single-task only; backlog skips sleep)

If `_OT_MODE` is `"backlog"`, skip to **Backlog lifecycle** below.

```bash
if [ -n "$_OT_DELAY_ARG" ]; then
  # Explicit delay from $ARGUMENTS
  _OT_DELAY_SECONDS=$(node -e "
    const a='$_OT_DELAY_ARG';
    const hm=a.match(/^(\d+)h(\d+)?m?$/);
    const m=a.match(/^(\d+)m$/); const h=a.match(/^(\d+)h$/); const s=a.match(/^(\d+)s$/);
    if(hm) console.log((parseInt(hm[1])*3600)+(parseInt(hm[2]||0)*60));
    else if(h) console.log(parseInt(h[1])*3600);
    else if(m) console.log(parseInt(m[1])*60);
    else if(s) console.log(parseInt(s[1]));
    else console.log(18000);
  " 2>/dev/null || echo "18000")
else
  # Auto: call lib/rate-limit.js delayUntilReset; fall back to defaultDelay
  _OT_DELAY_SECONDS=$(node -e "
    try {
      const rl=require('./lib/rate-limit');
      const buf='$_OT_DELAY_BUFFER';
      const bufSec=buf.match(/(\d+)m/)?parseInt(buf)*60:buf.match(/(\d+)s/)?parseInt(buf):300;
      const d=rl.delayUntilReset({buffer:bufSec});
      if(d!==null) { console.log(d); process.exit(0); }
    } catch(e) {}
    // fallback to defaultDelay
    const dd='$_OT_DEFAULT_DELAY';
    if(dd==='auto') { console.log(18000); process.exit(0); }
    const hm=dd.match(/^(\d+)h(\d+)?m?$/);
    const m=dd.match(/^(\d+)m$/); const h=dd.match(/^(\d+)h$/);
    if(hm) console.log((parseInt(hm[1])*3600)+(parseInt(hm[2]||0)*60));
    else if(h) console.log(parseInt(h[1])*3600);
    else if(m) console.log(parseInt(m[1])*60);
    else console.log(18000);
  " 2>/dev/null || echo "18000")
fi

_OT_DELAY_LABEL=$(node -e "
  const s=parseInt('$_OT_DELAY_SECONDS');
  const h=Math.floor(s/3600); const m=Math.floor((s%3600)/60); const sec=s%60;
  if(h&&m) console.log(h+'h '+m+'m');
  else if(h) console.log(h+' hour'+(h===1?'':'s'));
  else if(m) console.log(m+' minute'+(m===1?'':'s'));
  else console.log(sec+' second'+(sec===1?'':'s'));
" 2>/dev/null || echo "$_OT_DELAY_SECONDS seconds")
```

---

## Step 3 — Start caffeinate

```bash
if [ "$(uname)" = "Darwin" ]; then
  nohup caffeinate -d > /tmp/claude-overtime-caffeinate.log 2>&1 &
else
  nohup systemd-inhibit --what=idle --who="claude-overtime" --why="Waiting for overtime delay" sleep infinity > /tmp/claude-overtime-caffeinate.log 2>&1 &
fi
echo $! > /tmp/claude-overtime-caffeinate.pid
```

---

## Step 4 — Write state file and settings

```bash
_OT_SESSION_ID="$(date +%Y%m%d-%H%M%S)-$$"
_OT_STATE_DIR="$HOME/.claude/overtime-state"
mkdir -p "$_OT_STATE_DIR"
_OT_STATE_FILE="$_OT_STATE_DIR/$_OT_SESSION_ID.json"

_OT_BRANCH="overtime/$_OT_SESSION_ID"
_OT_PROJECT_ROOT="$(pwd)"
_OT_PLAN_FILE=$(ls -t "$HOME/.claude/plans/"*.md 2>/dev/null | head -1)
_OT_EXPIRES_AT=$(( $(date +%s) + _OT_DELAY_SECONDS + 3600 ))

# Backup existing settings.local.json if present
_OT_SETTINGS_PATH="$_OT_PROJECT_ROOT/.claude/settings.local.json"
_OT_SETTINGS_BACKUP=""
if [ -f "$_OT_SETTINGS_PATH" ]; then
  _OT_SETTINGS_BACKUP=$(cat "$_OT_SETTINGS_PATH")
fi

node -e "
  const fs=require('fs');
  const state={
    owner:'overtime', mode:'$_OT_MODE', pid:parseInt('$(cat /tmp/claude-overtime-caffeinate.pid)'),
    started_at:new Date().toISOString(),
    expires_at:parseInt('$_OT_EXPIRES_AT'),
    branch:'$_OT_BRANCH',
    project_root:'$_OT_PROJECT_ROOT',
    plan_file:'$_OT_PLAN_FILE'||null,
    settings_path:'$_OT_SETTINGS_PATH',
    settingsBackup: process.env._OT_BACKUP || null,
    retryCount:0,
    cursor: '$_OT_MODE'==='backlog'?{phase:'audit',cycleN:0,tracks:[]}:null
  };
  fs.writeFileSync('$_OT_STATE_FILE', JSON.stringify(state,null,2)+'\n');
" _OT_BACKUP="$_OT_SETTINGS_BACKUP" 2>/dev/null
```

Write `.claude/settings.local.json`:

```bash
node -e "
  const fs=require('fs');
  const path='$_OT_SETTINGS_PATH';
  let s={};
  try{ s=JSON.parse(fs.readFileSync(path,'utf8')); }catch(e){}
  s.permissions={
    allow:['Bash(*)','Read','Edit','Write','Glob','Grep','Agent','TodoWrite'],
    deny:[
      'Bash(rm -rf /)', 'Bash(rm -rf ~)',
      'Bash(git push origin main*)', 'Bash(git push origin master*)',
      'Bash(git push --force*)', 'Bash(git reset --hard*)', 'Bash(git clean -f*)'
    ].concat(('$_OT_PROTECTED_BRANCHES'.trim().split(/\s+/).filter(Boolean).map(b=>'Bash(git push origin '+b+'*)')))
  };
  fs.mkdirSync(require('path').dirname(path),{recursive:true});
  fs.writeFileSync(path, JSON.stringify(s,null,2)+'\n');
" 2>/dev/null
```

---

# Single-Task Lifecycle

*(Skip to Backlog Lifecycle if `_OT_MODE=backlog`)*

## Step 5 (single) — Print confirmation and sleep

Print exactly:

> **Overtime activated. Resuming in [DELAY_LABEL]. Go to sleep.**

Then sleep with a cleanup trap:

```bash
_overtime_cleanup() {
  [ -f /tmp/claude-overtime-caffeinate.pid ] && kill "$(cat /tmp/claude-overtime-caffeinate.pid)" 2>/dev/null; rm -f /tmp/claude-overtime-caffeinate.pid
  node -e "
    const fs=require('fs');
    const f='$_OT_STATE_FILE';
    try { const s=JSON.parse(fs.readFileSync(f,'utf8')); /* restore settings */
      const sp=s.settings_path; if(!sp) return;
      if(s.settingsBackup) fs.writeFileSync(sp,s.settingsBackup);
      else { try{const c=JSON.parse(fs.readFileSync(sp,'utf8'));delete c.permissions;
        Object.keys(c).length?fs.writeFileSync(sp,JSON.stringify(c,null,2)+'\n'):fs.rmSync(sp);
      }catch(e){} }
      fs.rmSync(f);
    } catch(e) {}
  " 2>/dev/null
}
trap _overtime_cleanup EXIT INT TERM HUP
echo "overtime: sleeping for $_OT_DELAY_SECONDS seconds..."
sleep "$_OT_DELAY_SECONDS"
echo "overtime: delay complete, spawning manager agent..."
trap - EXIT INT TERM HUP
```

---

## Step 6 (single) — Spawn the manager agent

Immediately after sleep, invoke the **Agent tool** with this prompt:

---

```
You are the **Overtime Manager Agent** for a single-task unattended session.

Read the state file at: $_OT_STATE_FILE

It contains: plan_file, project_root, branch, settings_path, settingsBackup, retryCount.

---

### Step M1 — Read task context

If plan_file is set and exists, read it in full.
If not, run: git log --oneline -20 && git status && git diff --stat HEAD
Produce a 2–3 sentence summary: goal, approach, what remains.

---

### Step M2 — Write session rules

Write `.claude/overtime-rules.md` in project_root:

```markdown
# Overtime Session Rules

## Task snapshot

> <2–3 SENTENCE SUMMARY>

Re-read every 3 commits and confirm work is on-scope. If drift detected: log to
`.claude/overtime-log.md` and re-center.

## Abort behavior: $_OT_ABORT_BEHAVIOR

## Rules

### 1. Pre-session git checkpoint
git add -A && git commit -m "chore(overtime): checkpoint [$TIMESTAMP]"
If this fails (for any reason other than nothing-to-commit): log error → halt.

### 2. Incremental commits
One logical change → one commit → one log entry. Never batch >2 files without committing.
Format: feat(<module>): <description>

### 3. Final commit
chore(overtime): session complete — see .claude/overtime-log.md

### 4. Session log
After each module, append to `.claude/overtime-log.md`:
  ## [YYYY-MM-DD HH:MM] — <module>
  **What was done:** ...
  **Files modified:** ...
  **Edge cases handled:** ...
  **Known limitations / follow-up needed:** ...

### 5. Architecture consistency
Read any existing file before editing. Match patterns. Grep for dominants before creating new files.

### 6. Structural integrity
Every function handles null/empty/error. No dead code, placeholder TODOs, half-finished branches.

### 7. Dependency audit
Verify all packages exist in package.json / requirements.txt before referencing them.

### 8. Context drift prevention
Every 3 commits: re-read Task snapshot and confirm on-scope. Log out-of-scope ideas as follow-ups.

### 9. Git push restriction
Only push the overtime branch. Never push main, master, or protected branches.
(Also mechanically enforced by PreToolUse hook and the deny list in settings.local.json.)

### 10. Rate limit — stop immediately
On HTTP 429 / "token limit exceeded": stop work, log progress and remaining work to
`.claude/overtime-log.md`, proceed to Step M5 (final commit + PR + cleanup). Do NOT retry here;
the retry logic is in the outer loop.

$_OT_CUSTOM_RULES
```

Ensure `.claude/overtime-log.md` is gitignored.

---

### Step M3 — Create overtime branch and checkpoint

```bash
git checkout -b "$BRANCH"
git add -A && git commit -m "chore(overtime): checkpoint before unattended session [$(date +%Y%m%d-%H%M%S)]" || true
```

If the checkpoint commit fails for reasons other than "nothing to commit":
- If abortBehavior is "stop": log error to `.claude/overtime-log.md`, proceed to Step M5.
- If abortBehavior is "continue": log the failure, continue without checkpoint.

---

### Step M4 — Execute work

Work through incomplete tasks from the plan or inferred summary.

- Read files before editing. Match existing patterns.
- For independent sub-tasks, spawn worker Agent subagents in parallel.
- Run tests after each logical change. Fix failures before moving on.
- After each logical unit: commit (Rule 2) + log entry (Rule 4).
- Every 3 commits: re-read `.claude/overtime-rules.md` Task snapshot.
- On rate limit: update state retryCount, check against $_OT_MAX_RETRIES.
  - If retryCount < maxRetries: sleep until next reset (use lib/rate-limit.js or 5h fallback), increment retryCount in state file, resume.
  - If retryCount >= maxRetries: log exhausted retries, proceed to M5.

---

### Step M5 — Final commit, push, draft PR

```bash
git add -A
git commit -m "chore(overtime): session complete — see .claude/overtime-log.md" 2>/dev/null || true
git push -u origin "$BRANCH"

LOG=$(cat .claude/overtime-log.md 2>/dev/null || echo 'Overtime session complete.')
SUMMARY="<one-line task summary from M1>"
gh pr create --draft \
  --title "$_OT_PR_TITLE_PREFIX$SUMMARY" \
  --body "$LOG"
```

If `gh` is unavailable or fails: write prepared PR body to `.claude/overtime-pending-pr.md`,
print `git push -u origin $BRANCH` instructions. Never `--force`.

Print the PR URL (or branch name if PR creation failed).

---

### Step M6 — Cleanup (always)

```bash
# Kill caffeinate
[ -f /tmp/claude-overtime-caffeinate.pid ] && kill "$(cat /tmp/claude-overtime-caffeinate.pid)" 2>/dev/null
rm -f /tmp/claude-overtime-caffeinate.pid

# Restore or remove settings.local.json
node -e "
  const fs=require('fs');
  const f='$_OT_STATE_FILE';
  try {
    const s=JSON.parse(fs.readFileSync(f,'utf8'));
    const sp=s.settings_path;
    if(s.settingsBackup) fs.writeFileSync(sp, s.settingsBackup);
    else { try{const c=JSON.parse(fs.readFileSync(sp,'utf8'));delete c.permissions;
      Object.keys(c).length?fs.writeFileSync(sp,JSON.stringify(c,null,2)+'\n'):fs.rmSync(sp);
    }catch(e){} }
    fs.rmSync(f);
  } catch(e) {}
" 2>/dev/null

rm -f "$PROJECT_ROOT/.claude/overtime-rules.md" 2>/dev/null || true
```

---

### SCOPE RULES (single-task)
- Only the tasks from the plan or inferred from git history.
- No new unrelated work.
- No push to main, master, or protected branches. (Enforced mechanically — do not attempt.)
- No changes outside project_root.
- If unsure about a task, skip it and note in log.
```

---

# Backlog Lifecycle

*(Entered when `_OT_MODE=backlog`)*

Backlog mode does **not** sleep first. It starts immediately and runs an adaptive cycle loop. Rate-limit pauses are handled mid-loop.

## Step 5 (backlog) — Capture task spec

**A) Plan file exists** — read `$_OT_PLAN_FILE` if set and valid. Use as `TASK_SPEC`.

**B) No plan file** — spawn an Explore sub-agent:

```
Agent({
  subagent_type: "Explore",
  prompt: "Survey this repo. Identify 5–15 concrete actionable objectives: bugs, missing tests,
  incomplete features, docs gaps, dead code, perf issues. One line each, verb-first, file path if known.
  Do NOT implement. Return as a bulleted list. Cap at 500 words."
})
```

Write result to `.claude/overtime-spec.md`. Set as `TASK_SPEC`.

Ensure `.claude/overtime-spec.md` is gitignored.

---

## Step 6 (backlog) — Write backlog rules

Write `.claude/overtime-rules.md` in project_root with the 10 standard rules (same as single-task Step M2) **plus**:

### Rule 11 — Parallel-track scope lock
Each parallel track agent receives a file-glob whitelist. Editing outside that whitelist is forbidden.
Log violations to `.claude/overtime-log.md` as follow-ups and stop the track.

### Rule 12 — No force-push, no hook skip, no CI skip
Never use `--no-verify`, `--force`, or bypass pre-commit hooks or CI.
If a hook fails, diagnose and fix — do not bypass.

### Rule 13 — No self-modification
Do not edit files under any `claude-overtime` install path (`~/.claude/commands/`, `~/.claude/hooks/claude-overtime-*`).

Append `$_OT_CUSTOM_RULES` after Rule 13.

Ensure `.claude/overtime-log.md` is gitignored.

---

## Step 7 (backlog) — Cycle loop

You now act as the **Backlog Manager**. Update the state file's `cursor` at every phase boundary.

```
load state (cursor: {phase, cycleN, tracks:[]})

loop:
  if cursor.cycleN >= _OT_BACKLOG_MAX_CYCLES: break → clean exit
  if _OT_SOFT_DEADLINE set and now > _OT_SOFT_DEADLINE: break → clean exit

  # a) PLAN
  set cursor.phase = "plan"; save state
  Agent({
    subagent_type: "Plan",
    prompt: "Read TASK_SPEC at <path>. Read git log --oneline -20 and git status.
    Propose up to 4 DISJOINT tracks for cycle N. Each track = {id, goal, files: [globs], verification}.
    Tracks must not share file paths. Output strict JSON. Under 600 words."
  })
  → parse tracks[]; save to cursor.tracks

  if tracks is empty: break → clean exit (repo complete)

  # b) TRACKS (parallel)
  set cursor.phase = "tracks"; save state
  Send ONE message with N parallel Agent tool calls (one per track, worktree-isolated).
  Each track agent prompt:
    - "Your scope: {files}. Do NOT edit outside this list."
    - "Goal: {goal}. Verification: {verification}."
    - "Rules: commit per logical unit (feat/fix prefix), push branch, open DRAFT PR via gh pr create --draft."
    - Include inline contents of .claude/overtime-rules.md.
    - "On rate-limit: stop cleanly, report back."
  Collect results. Update cursor.tracks[i].status → done/failed/partial; record branch, pr_url.

  # c) REVIEW
  set cursor.phase = "review"; save state
  For each track with a PR, spawn a review agent:
    Agent({ prompt: "Review PR <url>. Post inline comments via gh pr comment for high-confidence blockers only. Return summary + blocker count." })
  Append high-confidence blockers to state history as follow-ups.

  # d) TEST
  set cursor.phase = "test"; save state
  Detect test command (package.json scripts, pyproject.toml, bun.lockb, Makefile, etc).
  Run it. On failure: spawn a fix agent scoped to failing track files. Commit fixes.

  # e) INTEGRATE
  set cursor.phase = "integrate"; save state
  If >=1 track passed review + tests:
    Create branch "overtime/cycle-N-$SESSION_ID" off main.
    Merge each green track branch in order.
    Run tests again.
    Open ONE draft PR: "overtime/cycle-N → main". Body = track summaries + verification.
    Record PR url in cursor.history.

  # f) CHECKPOINT
  cursor.cycleN += 1
  cursor.phase = "plan"
  cursor.tracks = []
  cursor.last_checkpoint = now ISO8601
  state.expires_at = now + 86400   # refresh
  append to cursor.history: {cycle, ts, pr_url, tracks_done, blockers}
  save state

  # g) RATE-LIMIT CHECK
  If any sub-agent returned rate-limit (HTTP 429):
    → go to paused exit (Step 8b)
```

Use TodoWrite to track per-cycle phase progress in real time.

---

## Step 8 (backlog) — Exit paths

### 8a — Clean exit (all cycles done / max reached / deadline / no tracks left)

```bash
[ -f /tmp/claude-overtime-caffeinate.pid ] && kill "$(cat /tmp/claude-overtime-caffeinate.pid)" 2>/dev/null
rm -f /tmp/claude-overtime-caffeinate.pid

node -e "
  const fs=require('fs'), f='$_OT_STATE_FILE';
  try {
    const s=JSON.parse(fs.readFileSync(f,'utf8'));
    const sp=s.settings_path;
    if(s.settingsBackup) fs.writeFileSync(sp,s.settingsBackup);
    else { try{const c=JSON.parse(fs.readFileSync(sp,'utf8'));delete c.permissions;
      Object.keys(c).length?fs.writeFileSync(sp,JSON.stringify(c,null,2)+'\n'):fs.rmSync(sp);
    }catch(e){} }
    fs.rmSync(f);
  } catch(e) {}
" 2>/dev/null

rm -f "$_OT_PROJECT_ROOT/.claude/overtime-rules.md" 2>/dev/null || true
```

Print completion report: cycles run, PRs opened, blockers captured, recommended next action.

### 8b — Paused exit (rate limit mid-cycle)

Do NOT delete the state file or `.claude/settings.local.json`. Cursor is already saved.
Kill caffeinate and remove the PID file only.

Update state:

```bash
node -e "
  const fs=require('fs'), f='$_OT_STATE_FILE';
  try {
    const s=JSON.parse(fs.readFileSync(f,'utf8'));
    s.cursor.last_checkpoint=new Date().toISOString();
    s.cursor.history=(s.cursor.history||[]).concat([{ts:s.cursor.last_checkpoint,event:'paused',reason:'rate_limit'}]);
    fs.writeFileSync(f,JSON.stringify(s,null,2)+'\n');
  } catch(e) {}
" 2>/dev/null
```

Print:

> **Overtime backlog paused at cycle N, phase X.**
>
> To resume: `/overtime --resume`
> To wait for rate-limit reset first: `/overtime 5h` then `/overtime --resume`
> To abandon and clean up: `claude-overtime state reset --all`

---

## SCOPE RULES (backlog)
- Only work defined by TASK_SPEC and tracks from the planner.
- Never push to main, master, or protected branches. (Enforced mechanically.)
- Never edit files under any `claude-overtime` install path.
- If planner emits 0 tracks: clean exit; print "repo objective appears complete."
- If a track is ambiguous: skip it, log to `.claude/overtime-log.md`, do not guess.

---

**Important:** Do NOT use `/loop` — it provides no crash safety and cannot handle cleanup. The Agent-based approach above keeps full context and handles cleanup correctly.

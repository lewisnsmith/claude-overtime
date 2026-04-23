You are entering **all-nighter mode**. The user wants an **adaptive overnight build loop** running on this repo: iterative cycles of audit → plan → parallel implementation → review → test → integrate → PR, resumable across rate limits.

This is distinct from `/overtime` (single task, single resume). `/all-nighter` keeps cycling until:
- the repo's objective is complete, OR
- `max_cycles` is reached, OR
- a rate limit / token-budget ceiling is hit (in which case state is checkpointed and the next `/all-nighter` invocation resumes from the exact cursor).

`$ARGUMENTS` may be empty or contain one of: `Nc` / `Ncycles` (cycle cap), `Nh` / `Nm` / `Ns` (soft deadline), `--resume` (force resume, error if no state), `--fresh` (ignore existing state).

---

### Step 0 — Detect resume

Run in Bash:

```bash
STATE_FILE=/tmp/claude-all-nighter-state.json
RESUME=no
if [ -f "$STATE_FILE" ]; then
  OWNER=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).owner||'')}catch(e){console.log('')}" 2>/dev/null)
  EXPIRY=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$STATE_FILE','utf8')).expires_at||0)}catch(e){console.log(0)}" 2>/dev/null)
  NOW=$(date +%s)
  if [ "$OWNER" = "all-nighter" ] && [ "$NOW" -lt "$EXPIRY" ]; then
    RESUME=yes
  fi
fi
echo "RESUME=$RESUME"
```

Argument override:
- If `$ARGUMENTS` contains `--fresh`: delete the state file (`rm -f $STATE_FILE`) and set `RESUME=no`.
- If `$ARGUMENTS` contains `--resume` and `RESUME=no`: print "No resumable all-nighter state found." and STOP.

If `RESUME=yes`: skip Steps 1–4 and jump to Step 5 (cycle loop). Print a one-line summary of where you're resuming from (cycle N, phase X).

---

### Step 1 — Capture task spec (first-run only)

Find the work to drive cycles against.

**A) Plan file exists** — Glob `~/.claude/plans/*.md`. If any exist, read the most recently modified one. Use it as `TASK_SPEC`.

**B) No plan file** — Spawn an Explore sub-agent to survey the repo and emit objectives:

```
Agent({
  subagent_type: "Explore",
  description: "Audit repo objectives",
  prompt: "Survey this repo (./). Identify 5–15 concrete, actionable objectives the repo would benefit from — bugs to fix, tests missing, incomplete features, docs gaps, dead code, performance issues. Each objective: one line, actionable verb-first, file path if known. Do NOT implement. Return as a bulleted list. Cap at 500 words."
})
```

Write the result to `.claude/all-nighter-spec.md` (create `.claude/` if needed). Use this as `TASK_SPEC`.

---

### Step 2 — Start caffeinate (skip if already running)

```bash
if [ ! -f /tmp/claude-overtime-caffeinate.pid ] || ! kill -0 "$(cat /tmp/claude-overtime-caffeinate.pid 2>/dev/null)" 2>/dev/null; then
  if [ "$(uname)" = "Darwin" ]; then
    nohup caffeinate -d > /tmp/claude-overtime-caffeinate.log 2>&1 &
  else
    nohup systemd-inhibit --what=idle --who="claude-all-nighter" --why="adaptive build loop" sleep infinity > /tmp/claude-overtime-caffeinate.log 2>&1 &
  fi
  echo $! > /tmp/claude-overtime-caffeinate.pid
fi
```

---

### Step 3 — Parse args and write state file

Parse `$ARGUMENTS`:
- `Nc` / `Ncycles` → `MAX_CYCLES=N`
- `Nh` / `Nm` / `Ns` → `SOFT_DEADLINE=<now + seconds>`
- neither → `MAX_CYCLES=8`, no deadline

Write state file:

```bash
PROJECT_ROOT="$(pwd)"
BRANCH_BASE="all-nighter/$(date +%Y%m%d-%H%M%S)"
EXPIRES_AT=$(( $(date +%s) + 86400 ))  # 24h buffer; refreshed each cycle

node -e "
  require('fs').writeFileSync('/tmp/claude-all-nighter-state.json', JSON.stringify({
    owner: 'all-nighter',
    project_root: process.env.PROJECT_ROOT,
    task_spec_path: process.env.TASK_SPEC_PATH,
    branch_base: process.env.BRANCH_BASE,
    cycle: 0,
    max_cycles: parseInt(process.env.MAX_CYCLES || '8'),
    soft_deadline: process.env.SOFT_DEADLINE ? parseInt(process.env.SOFT_DEADLINE) : null,
    phase: 'plan',
    tracks: [],
    last_checkpoint: null,
    expires_at: parseInt(process.env.EXPIRES_AT),
    history: []
  }, null, 2) + '\n');
"
```

Set `TASK_SPEC_PATH` to the plan path from Step 1A or `.claude/all-nighter-spec.md` from 1B.

---

### Step 4 — Grant unattended permissions

Create or merge into `.claude/settings.local.json` in `$PROJECT_ROOT`:

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
      "Bash(git reset --hard*)",
      "Bash(git clean -f*)",
      "Bash(git push --force*)"
    ]
  }
}
```

If the file exists, merge the `permissions` key only. Then update state with the settings path:

```bash
node -e "
  const f='/tmp/claude-all-nighter-state.json';
  const s=JSON.parse(require('fs').readFileSync(f,'utf8'));
  s.settings_path=process.cwd()+'/.claude/settings.local.json';
  require('fs').writeFileSync(f,JSON.stringify(s,null,2)+'\n');
"
```

Write `.claude/all-nighter-rules.md` with the `/overtime` 10 rules plus:

- **Rule 11 — Parallel-track scope lock.** Each parallel track agent receives a file-glob whitelist. Editing outside that whitelist is forbidden; if needed, log it to `.claude/all-nighter-log.md` as a follow-up and stop.
- **Rule 12 — No force-push, no hook skip, no CI skip.** Never use `--no-verify`, `--force`, or bypass pre-commit hooks. If a hook fails, diagnose and fix.
- **Rule 13 — No self-modification.** Do not edit files under any `claude-overtime` install path.

Ensure `.claude/all-nighter-log.md` is gitignored.

---

### Step 5 — Cycle loop (manager)

You now act as the **All-Nighter Manager**. The loop runs in the current session. Each cycle is one full pass: plan → tracks → review → test → integrate → checkpoint.

Pseudo-code — execute this loop directly, updating the state file at every boundary:

```
load state
loop:
  if state.cycle >= state.max_cycles: break cleanly
  if state.soft_deadline and now > state.soft_deadline: break cleanly

  # --- a) PLAN ---
  set state.phase = "plan"; save state
  Agent({
    subagent_type: "Plan",
    description: "Plan cycle N",
    prompt: "Read TASK_SPEC at <path>. Read git log --oneline -20 and git status. Propose up to 4 DISJOINT tracks for this cycle. Each track = { id: 'NA'/'NB'/'NC'/'ND', goal: one line, files: [glob list], verification: how to tell it's done }. Tracks must not share file paths. Output strict JSON. Under 600 words."
  })
  → parse tracks[]; save to state.tracks

  # --- b) TRACKS (parallel) ---
  set state.phase = "tracks"; save state
  Send ONE message with N parallel Agent tool calls, one per track, isolation: "worktree".
  Each track agent prompt:
    - "Your scope: {files}. Do NOT edit outside this whitelist."
    - "Goal: {goal}. Verification: {verification}."
    - "Rules: commit per logical unit (feat/fix prefix), push branch, open DRAFT PR via `gh pr create --draft`. On rate-limit: stop cleanly and report."
    - Include the contents of .claude/all-nighter-rules.md inline.
  Collect results. Update state.tracks[i].status → done/failed/partial and branch/pr_url.

  # --- c) REVIEW ---
  set state.phase = "review"; save state
  For each track with a PR:
    Agent({
      subagent_type: "feature-dev:code-reviewer",
      description: "Review track PR",
      prompt: "Review PR <url> for this repo. Post inline comments via `gh pr comment` for high-confidence issues only. Return summary + blocker count."
    })
  → append high-confidence blockers to state.history as follow-ups.

  # --- d) TEST ---
  set state.phase = "test"; save state
  Detect test command (check package.json scripts, pyproject.toml, bun.lockb, etc.).
  Run it. On failure: Agent({ description: "Fix failing tests in track X", prompt: "Test output: <X>. Scope: track X files only. Fix and commit." })

  # --- e) INTEGRATE ---
  set state.phase = "integrate"; save state
  If >=1 track passed review + tests:
    Create/reset branch phase/cycle-N off main.
    Merge each green track branch in order.
    Run test command again.
    Open ONE PR phase/cycle-N → main. Body = track summary + verification results.
  Store PR url in state.history.

  # --- f) CHECKPOINT ---
  state.cycle += 1
  state.phase = "plan"
  state.tracks = []
  state.last_checkpoint = now ISO8601
  state.expires_at = now + 86400
  append to state.history: { cycle, ts, pr_url, tracks_done, blockers }
  save state

  # --- g) RATE-LIMIT CHECK ---
  If any sub-agent returned "rate limit" / HTTP 429: go to Step 7 (paused exit).
```

Use `TodoWrite` to track progress **within a cycle**: one todo per phase, update in real time.

---

### Step 6 — Clean exit

When the loop exits cleanly (all cycles done, no work left, OR max_cycles / deadline reached):

```bash
# Final summary commit on the last cycle branch if pending changes
# (tracks already own their commits — nothing to do here unless the manager has its own edits)

# Kill caffeinate
if [ -f /tmp/claude-overtime-caffeinate.pid ]; then
  kill "$(cat /tmp/claude-overtime-caffeinate.pid)" 2>/dev/null || true
  rm -f /tmp/claude-overtime-caffeinate.pid
fi

# Remove state + rules
rm -f /tmp/claude-all-nighter-state.json 2>/dev/null || true
rm -f "$PROJECT_ROOT/.claude/all-nighter-rules.md" 2>/dev/null || true

# Strip permissions (preserve other settings)
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
```

Print a completion report: cycles run, PRs opened, blockers captured, next recommended action.

---

### Step 7 — Paused exit (rate limit / token ceiling)

Do NOT delete the state file. Keep `.claude/settings.local.json` permissions in place — the next `/all-nighter` (or auto-cleanup on expiry) will handle them.

```bash
node -e "
  const f='/tmp/claude-all-nighter-state.json';
  const s=JSON.parse(require('fs').readFileSync(f,'utf8'));
  s.last_checkpoint=new Date().toISOString();
  s.history.push({ts:s.last_checkpoint, event:'paused', reason:'rate_limit'});
  require('fs').writeFileSync(f,JSON.stringify(s,null,2)+'\n');
"
```

Print:

> **all-nighter paused at cycle N, phase X.**
>
> To resume: type `/all-nighter` (picks up where it left off).
> To wait for rate-limit reset first: type `/overtime 5h` and then `/all-nighter` afterward.
> To abandon and clean up: type `/all-nighter --fresh` then cancel.

---

### SCOPE RULES

- Only work defined by `TASK_SPEC` and tracks emitted by the planner.
- Never push to `main` / `master` (blocked by deny list; trust the rail).
- Never edit files under any `claude-overtime` install path.
- If the planner emits 0 tracks (nothing left to do), exit cleanly via Step 6 and print "repo objective appears complete."
- If a track is ambiguous, skip it and log to `.claude/all-nighter-log.md` — do not guess.

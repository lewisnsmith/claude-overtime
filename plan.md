# Claude Overtime — Development Plan

> **Parallelization Guide:** Phases 1-4 each contain independent tracks that can be attacked by separate agents simultaneously. Dependencies between phases are noted.

---

## Phase 0: Project Scaffolding ⏱️ ~15 min
> **Depends on:** Nothing  
> **Agents:** 1

- [ ] Create directory structure:
  ```
  .claude/commands/
  .claude/skills/overtime/scripts/
  .claude/overtime/logs/
  ```
- [ ] Create `.gitignore` to exclude `.claude/overtime/` runtime state
- [ ] Create `package.json` with project metadata (name, version, description, bin, scripts)
- [ ] Create `README.md` with project overview and installation instructions

---

## Phase 1: Core Components ⏱️ ~2 hours
> **Depends on:** Phase 0  
> **Agents:** Up to 4 (one per track)

### Track 1A: Slash Command Definition
**Files:** `.claude/commands/overtime.md`

- [ ] Write the slash command markdown with YAML frontmatter
- [ ] Define `allowed-tools` list
- [ ] Handle `$ARGUMENTS` for task prompt passthrough
- [ ] Include inline bash (`!command`) to trigger the daemon

### Track 1B: Caffeinate Manager
**Files:** `.claude/skills/overtime/scripts/caffeinate-mgr.sh`

- [ ] Implement `start()` — launch `caffeinate -dimsu` and store PID
- [ ] Implement `stop()` — kill caffeinate by PID
- [ ] Implement `status()` — check if caffeinate is running
- [ ] Add battery warning check (macOS `pmset -g batt`)
- [ ] Add cleanup trap (`trap cleanup EXIT`)
- [ ] Platform detection (macOS vs Linux fallback)

### Track 1C: Task Queue Manager
**Files:** `.claude/skills/overtime/scripts/queue-mgr.sh`

- [ ] `init()` — create `queue.json` if not exists
- [ ] `add(prompt)` — append task with UUID, timestamp, `pending` status
- [ ] `next()` — return and mark next pending task as `active`
- [ ] `complete(id)` — mark task as `completed`
- [ ] `fail(id, reason)` — mark task as `failed`
- [ ] `list()` — print queue status
- [ ] `clear()` — remove all tasks
- [ ] Use `jq` for JSON manipulation (check for dependency)

### Track 1D: Rate Limit Parser
**Files:** `.claude/skills/overtime/scripts/rate-limit-parser.sh`

- [ ] Parse Claude Code stderr/stdout for rate limit messages
- [ ] Extract reset timestamp from error output
- [ ] Calculate seconds until reset (+ configurable buffer)
- [ ] Provide fallback fixed interval (5h default) if parsing fails
- [ ] Output structured JSON: `{ "rate_limited": bool, "reset_at": timestamp, "wait_seconds": int }`

---

## Phase 2: Daemon & Orchestration ⏱️ ~3 hours
> **Depends on:** Phase 1 (all tracks)  
> **Agents:** Up to 2

### Track 2A: Main Daemon
**Files:** `.claude/skills/overtime/scripts/overtime-daemon.sh`

- [ ] Parse CLI arguments (start, stop, status, cancel)
- [ ] PID file management (`overtime.pid`) — prevent double-start
- [ ] State file management (`state.json`)
- [ ] Main loop:
  1. Read next task from queue
  2. Launch `claude --dangerously-skip-permissions -p "<prompt>" --output-format stream-json`
  3. Tee output to log file
  4. Monitor for rate limit signals
  5. On rate limit → call rate-limit-parser, sleep, retry
  6. On completion → mark task complete, process next
  7. On all done → cleanup and generate summary
- [ ] Signal handling (SIGTERM, SIGINT → graceful shutdown)
- [ ] Max retries / max runtime guards
- [ ] Heartbeat file (touch every 60s for liveness check)
- [ ] Desktop notification on completion (`osascript` on macOS)

### Track 2B: Summary Generator
**Files:** `.claude/skills/overtime/scripts/summary-gen.sh`

- [ ] Read `queue.json` for task statuses
- [ ] Parse log files for key events
- [ ] Run `git diff --stat` to summarize file changes
- [ ] Compile markdown summary report
- [ ] Write to `.claude/overtime/summary.md`
- [ ] Include rate limit events, errors, total runtime

---

## Phase 3: Skill Definition & Integration ⏱️ ~1 hour
> **Depends on:** Phase 1A, Phase 2A  
> **Agents:** Up to 2

### Track 3A: SKILL.md
**Files:** `.claude/skills/overtime/SKILL.md`

- [ ] YAML frontmatter (name, description)
- [ ] Full instructions for Claude on how to use overtime
- [ ] Document the scripts and their usage
- [ ] Include examples of `/overtime` usage

### Track 3B: Configuration & Settings
**Files:** `.claude/overtime/config.json`, `.claude/settings.json`

- [ ] Create default `config.json` with all configurable values
- [ ] Create a config loader in the daemon (with defaults + overrides)
- [ ] Document all configuration options
- [ ] Add optional hook definitions to `settings.json`:
  - `SessionStart` hook: check for stale overtime state
  - `Stop` hook: warn if overtime queue has pending tasks

---

## Phase 4: Safety & UX Polish ⏱️ ~2 hours
> **Depends on:** Phase 2A  
> **Agents:** Up to 3

### Track 4A: Git Safety Net
**Files:** `.claude/skills/overtime/scripts/git-safety.sh`

- [ ] Auto-create branch `overtime/<timestamp>` before starting
- [ ] Auto-commit with `[overtime]` prefix before each task
- [ ] Auto-commit on task completion
- [ ] Provide rollback instructions in summary

### Track 4B: Cancellation & Cleanup
**Files:** `.claude/skills/overtime/scripts/cleanup.sh`

- [ ] Watch for `.claude/overtime/cancel` sentinel file
- [ ] `overtime --cancel` CLI interface
- [ ] Graceful shutdown: finish current operation, don't start next task
- [ ] Kill caffeinate, remove PID files
- [ ] Generate partial summary

### Track 4C: User-Facing Polish
**Files:** `README.md`, `.claude/commands/overtime.md`

- [ ] Rich terminal output with colors and status indicators
- [ ] `--status` flag to check overtime state from another terminal
- [ ] Clear error messages for common issues (jq not found, etc.)
- [ ] Installation instructions (copy to project, or symlink)

---

## Phase 5: Testing & Validation ⏱️ ~2 hours
> **Depends on:** All previous phases  
> **Agents:** Up to 2

### Track 5A: Unit Tests
- [ ] Test queue manager (add, next, complete, fail, list)
- [ ] Test rate limit parser with sample error outputs
- [ ] Test caffeinate manager (mock process management)
- [ ] Test config loader (defaults, overrides, invalid input)
- [ ] Test summary generator with sample data

### Track 5B: Integration / E2E Tests
- [ ] Simulate full overtime flow with a trivial task
- [ ] Simulate rate limit hit with mock error
- [ ] Test cancellation mid-task
- [ ] Test multiple queued tasks
- [ ] Test caffeinate lifecycle (start → running → stop)
- [ ] Test on battery power (warning check)

---

## Phase 6: Documentation & Release ⏱️ ~1 hour
> **Depends on:** Phase 5  
> **Agents:** 1

- [ ] Finalize `README.md` with:
  - Installation (one-liner copy)
  - Usage examples
  - Configuration reference
  - Risk acknowledgement
  - FAQ
- [ ] Add `CHANGELOG.md`
- [ ] Add `CONTRIBUTING.md`
- [ ] Tag v0.1.0 release
- [ ] Publish to GitHub

---

## Dependency Graph

```
Phase 0 (Scaffold)
    │
    ├──→ Phase 1A (Slash Command)  ──┐
    ├──→ Phase 1B (Caffeinate)  ─────┤
    ├──→ Phase 1C (Queue Mgr)  ──────┼──→ Phase 2A (Daemon)  ──┬──→ Phase 3A (SKILL.md)
    └──→ Phase 1D (Rate Limit)  ─────┘          │               ├──→ Phase 3B (Config)
                                                 │               ├──→ Phase 4A (Git Safety)
                                                 │               ├──→ Phase 4B (Cancellation)
                                                 ├──→ Phase 2B (Summary Gen)
                                                 │               │
                                                 └───────────────┴──→ Phase 5 (Testing)
                                                                            │
                                                                            └──→ Phase 6 (Docs)
```

---

## Agent Assignment Cheatsheet

| Agent | Phase 0 | Phase 1 | Phase 2 | Phase 3 | Phase 4 | Phase 5 | Phase 6 |
|-------|---------|---------|---------|---------|---------|---------|---------|
| **Agent 1** | Scaffold | 1A: Slash Cmd | 2A: Daemon | 3A: SKILL.md | — | 5B: E2E | Docs |
| **Agent 2** | — | 1B: Caffeinate | 2B: Summary | 3B: Config | 4A: Git Safety | 5A: Unit | — |
| **Agent 3** | — | 1C: Queue Mgr | — | — | 4B: Cancel | — | — |
| **Agent 4** | — | 1D: Rate Limit | — | — | 4C: Polish | — | — |

> Each agent picks up its next track as soon as its dependencies are met. Phase 0 is a quick solo task, then all four agents fan out for Phase 1.

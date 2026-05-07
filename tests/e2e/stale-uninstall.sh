#!/usr/bin/env bash
# Scenario 8: Stale uninstall
# - Install claude-overtime
# - Create an active state file
# - Run uninstall → should refuse with stderr mentioning 'state reset --all'
# - Run state reset --all → succeeds
# - Run uninstall again → succeeds

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== Scenario 8: stale-uninstall ==="

setup_env

REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $REPO_ROOT_REAL/bin/claude-overtime.js"
STATE_DIR="$TMP_HOME/.claude/overtime-state"

# ── 8a. Install ───────────────────────────────────────────────────────────────
HOME="$TMP_HOME" $CLI install 2>&1 >/dev/null

assert_file_exists "install writes overtime.md" "$TMP_HOME/.claude/commands/overtime.md"
assert_file_exists "install writes stop.sh" "$TMP_HOME/.claude/hooks/claude-overtime-stop.sh"

# ── 8b. Create an active state file (live PID = $$) ──────────────────────────
FUTURE_EXPIRES=$(date -u -v+2H "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                 date -u -d "+2 hours" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                 echo "2099-01-01T00:00:00Z")

SESSION_ID=$(HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  node -e "
const state = require('$REPO_ROOT_REAL/lib/state');
const id = state.create({
  owner: 'overtime',
  mode: 'single',
  pid: $$,
  branch: 'overtime/active',
  expires_at: '$FUTURE_EXPIRES',
  settingsBackup: null,
  projectRoot: '$TMP_PROJECT',
  retryCount: 0,
  started_at: new Date().toISOString(),
});
process.stdout.write(id + '\n');
")

assert_file_exists "active state file exists" "$STATE_DIR/${SESSION_ID}.json"

# ── 8c. Uninstall should refuse ───────────────────────────────────────────────
UNINSTALL_STDERR=$(HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  $CLI uninstall 2>&1 >/dev/null || true)
UNINSTALL_EXIT=$(HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  $CLI uninstall 2>/dev/null; echo $?)

if [[ "$UNINSTALL_EXIT" -ne 0 ]]; then
  pass "uninstall refuses when active sessions exist (non-zero exit)"
else
  fail "uninstall should refuse when active sessions exist"
fi

assert_contains "uninstall refusal mentions state reset" "state reset" "$UNINSTALL_STDERR"

# Installed files should still be present (uninstall did not proceed)
assert_file_exists "stop.sh still present after refused uninstall" "$TMP_HOME/.claude/hooks/claude-overtime-stop.sh"

# ── 8d. state reset --all ─────────────────────────────────────────────────────
RESET_OUT=$(HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  $CLI state reset --all 2>&1)

assert_file_missing "state file removed" "$STATE_DIR/${SESSION_ID}.json"

# ── 8e. Uninstall now succeeds ───────────────────────────────────────────────
UNINSTALL2_EXIT=0
HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  $CLI uninstall 2>&1 >/dev/null || UNINSTALL2_EXIT=$?

assert_exit_code "uninstall succeeds after state reset" "0" "$UNINSTALL2_EXIT"

# Installed files removed
assert_file_missing "stop.sh removed" "$TMP_HOME/.claude/hooks/claude-overtime-stop.sh"
assert_file_missing "session-start.sh removed" "$TMP_HOME/.claude/hooks/claude-overtime-session-start.sh"
assert_file_missing "overtime.md removed" "$TMP_HOME/.claude/commands/overtime.md"

# settings.json should have no overtime entries
if [[ -f "$TMP_HOME/.claude/settings.json" ]]; then
  SETTINGS=$(cat "$TMP_HOME/.claude/settings.json")
  if printf '%s' "$SETTINGS" | grep -q "claude-overtime-stop"; then
    fail "settings.json has no overtime hooks after uninstall"
  else
    pass "settings.json has no overtime hooks after uninstall"
  fi
else
  pass "settings.json absent (no hooks) after uninstall"
fi

teardown_env

echo ""
print_summary

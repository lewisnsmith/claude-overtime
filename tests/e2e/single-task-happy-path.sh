#!/usr/bin/env bash
# Scenario 3: Single-task happy path (without real Claude session)
# Exercises lib/state.js lifecycle:
# - create state file (single mode)
# - write fake settings.local.json as "overtime-written"
# - simulate cleanup: state reset --all
# - confirm state file removed, settings.local.json handled

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== Scenario 3: single-task-happy-path ==="

setup_env

REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $REPO_ROOT_REAL/bin/claude-overtime.js"

# ── 3a. Create state file via lib/state.js ────────────────────────────────────
FUTURE_EXPIRES=$(date -u -v+2H "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "+2 hours" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2099-01-01T00:00:00Z")

SESSION_ID=$(HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  node -e "
const state = require('$REPO_ROOT_REAL/lib/state');
const id = state.create({
  owner: 'overtime',
  mode: 'single',
  pid: $$,
  branch: 'overtime/test',
  expires_at: '$FUTURE_EXPIRES',
  settingsBackup: {originalKey: 'original-value'},
  projectRoot: '$TMP_PROJECT',
  retryCount: 0,
  started_at: new Date().toISOString(),
});
process.stdout.write(id + '\n');
")

assert_file_exists "state file created" "$TMP_HOME/.claude/overtime-state/${SESSION_ID}.json"

# ── 3b. Confirm state show lists it ───────────────────────────────────────────
STATE_SHOW=$(HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  $CLI state show 2>/dev/null)
assert_contains "state show lists session" "$SESSION_ID" "$STATE_SHOW"
assert_contains "state show shows mode=single" "single" "$STATE_SHOW"

# ── 3c. Write a fake settings.local.json (as if overtime wrote it) ────────────
mkdir -p "$TMP_PROJECT/.claude"
cat > "$TMP_PROJECT/.claude/settings.local.json" <<'EOF'
{"permissions":{"allow":["Bash","Read","Edit","Write"]}}
EOF
assert_file_exists "fake settings.local.json written" "$TMP_PROJECT/.claude/settings.local.json"

# ── 3d. state reset --all triggers cleanup ────────────────────────────────────
RESET_OUT=$(HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  $CLI state reset --all 2>&1)

assert_file_missing "state file removed after reset" "$TMP_HOME/.claude/overtime-state/${SESSION_ID}.json"
assert_contains "reset output mentions session" "$SESSION_ID" "$RESET_OUT"

# ── 3e. Settings backup was restored ─────────────────────────────────────────
# settingsBackup was {originalKey: 'original-value'}, so settings.local.json should be restored
if [[ -f "$TMP_PROJECT/.claude/settings.local.json" ]]; then
  RESTORED=$(cat "$TMP_PROJECT/.claude/settings.local.json")
  assert_contains "settings.local.json restored from backup" "original-value" "$RESTORED"
else
  # If backup was null it would be removed; but we set a non-null backup
  fail "settings.local.json should be restored from backup"
fi

# ── 3f. No sessions left ──────────────────────────────────────────────────────
STATE_SHOW2=$(HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  $CLI state show 2>/dev/null)
assert_contains "no sessions after reset" "No active" "$STATE_SHOW2"

teardown_env

echo ""
print_summary

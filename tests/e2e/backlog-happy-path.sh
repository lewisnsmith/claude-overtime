#!/usr/bin/env bash
# Scenario 4: Backlog happy path
# - Create state with mode:"backlog" and a cursor showing one completed track
# - state show confirms output
# - state reset --all removes state, restores settingsBackup

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== Scenario 4: backlog-happy-path ==="

setup_env

REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $REPO_ROOT_REAL/bin/claude-overtime.js"

# ── 4a. Create backlog state file with cursor ─────────────────────────────────
FUTURE_EXPIRES=$(date -u -v+4H "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -u -d "+4 hours" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2099-01-01T00:00:00Z")

SETTINGS_BACKUP='{"permissions":{"allow":["Read"]}}'

SESSION_ID=$(HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  node -e "
const state = require('$REPO_ROOT_REAL/lib/state');
const id = state.create({
  owner: 'backlog',
  mode: 'backlog',
  pid: $$,
  branch: 'overtime/backlog-test',
  expires_at: '$FUTURE_EXPIRES',
  settingsBackup: {permissions:{allow:['Read']}},
  projectRoot: '$TMP_PROJECT',
  retryCount: 0,
  started_at: new Date().toISOString(),
  cursor: {
    phase: 'review',
    cycleN: 1,
    tracks: [{name:'track-A', status:'completed', branch:'overtime/track-a', prUrl:null}]
  }
});
process.stdout.write(id + '\n');
")

assert_file_exists "backlog state file created" "$TMP_HOME/.claude/overtime-state/${SESSION_ID}.json"

# ── 4b. state show confirms backlog mode and cursor ───────────────────────────
STATE_OUTPUT=$(HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  $CLI state show 2>/dev/null)
assert_contains "state show shows backlog mode" "backlog" "$STATE_OUTPUT"
assert_contains "state show shows session id" "$SESSION_ID" "$STATE_OUTPUT"

# Verify the raw state file has cursor data
RAW_STATE=$(cat "$TMP_HOME/.claude/overtime-state/${SESSION_ID}.json")
assert_contains "state file has cursor.phase" "review" "$RAW_STATE"
assert_contains "state file has completed track" "completed" "$RAW_STATE"
assert_contains "state file has track name" "track-A" "$RAW_STATE"

# ── 4c. state reset --all removes state + restores settings ───────────────────
# Write a settings.local.json as if overtime wrote it
mkdir -p "$TMP_PROJECT/.claude"
cat > "$TMP_PROJECT/.claude/settings.local.json" <<'EOF'
{"permissions":{"allow":["Bash","Read","Edit","Write","Grep","Glob"]}}
EOF

RESET_OUT=$(HOME="$TMP_HOME" OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state" \
  $CLI state reset --all 2>&1)

assert_file_missing "backlog state file removed" "$TMP_HOME/.claude/overtime-state/${SESSION_ID}.json"

# Settings should be restored to settingsBackup content (has "Read")
if [[ -f "$TMP_PROJECT/.claude/settings.local.json" ]]; then
  RESTORED=$(cat "$TMP_PROJECT/.claude/settings.local.json")
  assert_contains "settingsBackup restored after reset" "Read" "$RESTORED"
  # Should NOT have the overtime-written "Bash" (which was not in the backup)
  if printf '%s' "$RESTORED" | grep -q '"Bash"'; then
    # Bash was also in the backup-restore, check more carefully
    # The backup was {permissions:{allow:['Read']}} so Bash should not appear
    fail "settingsBackup restored correctly (Bash should not be in restored)"
  else
    pass "restored settings matches backup (no Bash)"
  fi
else
  # If settingsBackup was non-null, file should exist
  fail "settings.local.json should be restored from settingsBackup"
fi

# ── 4d. No sessions remain ────────────────────────────────────────────────────
REMAINING_COUNT=$(find "$TMP_HOME/.claude/overtime-state" -name "*.json" 2>/dev/null | wc -l | tr -d ' ')
assert_eq "no state files remain" "0" "$REMAINING_COUNT"

teardown_env

echo ""
print_summary

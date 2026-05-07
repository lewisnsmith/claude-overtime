#!/usr/bin/env bash
# Scenario 6: Crash safety
# - Create state file with dead PID (99999) and a settingsBackup
# - Write a settings.local.json to the project (simulating overtime's write)
# - Run hooks/session-start.sh
# - Confirm settings.local.json restored from backup
# - Confirm state file removed
# - Confirm cleanup log appended

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== Scenario 6: crash-safety ==="

setup_env

REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/../.." && pwd)"
SESSION_HOOK="$REPO_ROOT_REAL/hooks/session-start.sh"
STATE_DIR="$TMP_HOME/.claude/overtime-state"
CLEANUP_LOG="$TMP_HOME/.claude/overtime-cleanup.log"

# ── 6a. Create state file with dead PID ──────────────────────────────────────
DEAD_PID=99999

# Build a realistic state file
FUTURE_EXPIRES=$(date -u -v+2H "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                 date -u -d "+2 hours" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                 echo "2099-01-01T00:00:00Z")

SESSION_ID="test-crash-$(date +%s)"

BACKUP_CONTENT='{"permissions":{"allow":["Read","Glob"]}}'

cat > "$STATE_DIR/${SESSION_ID}.json" <<EOF
{
  "owner": "overtime",
  "mode": "single",
  "pid": $DEAD_PID,
  "branch": "overtime/crashed-run",
  "expires_at": "$FUTURE_EXPIRES",
  "settingsBackup": $BACKUP_CONTENT,
  "projectRoot": "$TMP_PROJECT",
  "retryCount": 0,
  "started_at": "$(date -u "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2099-01-01T00:00:00Z")"
}
EOF

assert_file_exists "state file written" "$STATE_DIR/${SESSION_ID}.json"

# ── 6b. Write overtime's settings.local.json (simulating what overtime wrote) ─
mkdir -p "$TMP_PROJECT/.claude"
cat > "$TMP_PROJECT/.claude/settings.local.json" <<'EOF'
{"permissions":{"allow":["Bash","Read","Edit","Write","Grep","Glob","Agent"]}}
EOF

# ── 6c. Verify PID 99999 is indeed dead ───────────────────────────────────────
if kill -0 99999 2>/dev/null; then
  # If somehow PID 99999 exists, skip this scenario
  echo "  SKIP: PID 99999 is alive on this system — skipping crash-safety test"
  teardown_env
  exit 0
fi

pass "PID 99999 is dead (pre-condition)"

# ── 6d. Run session-start.sh ──────────────────────────────────────────────────
HOME="$TMP_HOME" bash "$SESSION_HOOK" 2>/dev/null || true

# ── 6e. State file should be removed ─────────────────────────────────────────
assert_file_missing "state file removed by session-start.sh" "$STATE_DIR/${SESSION_ID}.json"

# ── 6f. settings.local.json should be restored from backup ───────────────────
if [[ -f "$TMP_PROJECT/.claude/settings.local.json" ]]; then
  RESTORED=$(cat "$TMP_PROJECT/.claude/settings.local.json")
  assert_contains "settings.local.json restored to backup content" '"Read"' "$RESTORED"
  assert_contains "settings.local.json restored (Glob present)" '"Glob"' "$RESTORED"
  # Original overtime-written "Bash" + "Write" should not be present (not in backup)
  # Actually backup has "Read" and "Glob" only
  RESTORED_CLEAN=$(printf '%s' "$RESTORED" | tr -d ' \n')
  if printf '%s' "$RESTORED_CLEAN" | grep -q '"Agent"'; then
    fail "settings.local.json backup restored correctly (Agent not in backup)"
  else
    pass "settings.local.json backup restored correctly (Agent absent)"
  fi
else
  fail "settings.local.json should exist (restored from backup)"
fi

# ── 6g. Cleanup log appended ──────────────────────────────────────────────────
assert_file_exists "cleanup log exists" "$CLEANUP_LOG"
LOG_CONTENT=$(cat "$CLEANUP_LOG")
assert_contains "cleanup log mentions GC" "session-start.sh" "$LOG_CONTENT"

teardown_env

echo ""
print_summary

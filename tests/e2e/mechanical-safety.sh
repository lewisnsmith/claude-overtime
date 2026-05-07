#!/usr/bin/env bash
# Scenario 7: Mechanical safety
# Tests hooks/pre-tool-use.sh with various tool call payloads.
# Requires an active state file to be present (hook is inert without one).
#
# Bash blocks: git push --force origin main, rm -rf ~, git push origin overtime/x (allow), git push origin v2/x (allow)
# Edit/Write blocks: write to node_modules/foo (block), write to project file (allow)

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== Scenario 7: mechanical-safety ==="

setup_env

REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/../.." && pwd)"
HOOK="$REPO_ROOT_REAL/hooks/pre-tool-use.sh"
STATE_DIR="$TMP_HOME/.claude/overtime-state"

# ── Plant an active state file (any live PID will do — use our own) ───────────
SESSION_ID="mech-safety-test-$$"
FUTURE_EXPIRES=$(date -u -v+2H "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                 date -u -d "+2 hours" "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || \
                 echo "2099-01-01T00:00:00Z")

cat > "$STATE_DIR/${SESSION_ID}.json" <<EOF
{
  "owner": "overtime",
  "mode": "single",
  "pid": $$,
  "branch": "overtime/test",
  "expires_at": "$FUTURE_EXPIRES",
  "settingsBackup": null,
  "projectRoot": "$TMP_PROJECT",
  "retryCount": 0,
  "started_at": "$(date -u "+%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || echo "2099-01-01T00:00:00Z")"
}
EOF

# ── Helper: pipe a PreToolUse JSON payload to the hook ────────────────────────
# Runs the hook with HOME=$TMP_HOME and cwd=$TMP_PROJECT, captures exit code
hook_exit_code() {
  local payload="$1"
  (
    cd "$TMP_PROJECT"
    printf '%s' "$payload" | HOME="$TMP_HOME" bash "$HOOK" 2>/dev/null
    exit $?
  )
  echo $?
}

# ── 7a. git push --force origin main → block (exit 2) ────────────────────────
PAYLOAD_FORCE='{"tool_name":"Bash","tool_input":{"command":"git push --force origin main"}}'
EC=$(hook_exit_code "$PAYLOAD_FORCE")
assert_exit_code "git push --force blocked" "2" "$EC"

# ── 7b. rm -rf ~ → block (exit 2) ────────────────────────────────────────────
PAYLOAD_RM='{"tool_name":"Bash","tool_input":{"command":"rm -rf ~"}}'
EC=$(hook_exit_code "$PAYLOAD_RM")
assert_exit_code "rm -rf ~ blocked" "2" "$EC"

# ── 7c. git push origin overtime/my-branch → allow (exit 0) ─────────────────
PAYLOAD_OT_PUSH='{"tool_name":"Bash","tool_input":{"command":"git push origin overtime/my-branch"}}'
EC=$(hook_exit_code "$PAYLOAD_OT_PUSH")
assert_exit_code "git push origin overtime/x allowed" "0" "$EC"

# ── 7d. git push origin v2/my-feature → allow (exit 0) ──────────────────────
PAYLOAD_V2_PUSH='{"tool_name":"Bash","tool_input":{"command":"git push origin v2/my-feature"}}'
EC=$(hook_exit_code "$PAYLOAD_V2_PUSH")
assert_exit_code "git push origin v2/x allowed" "0" "$EC"

# ── 7e. Write to node_modules/foo → block (exit 2) ───────────────────────────
NM_PATH="$TMP_PROJECT/node_modules/foo/index.js"
PAYLOAD_NM=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"evil"}}' "$NM_PATH")
EC=$(hook_exit_code "$PAYLOAD_NM")
assert_exit_code "Write to node_modules blocked" "2" "$EC"

# ── 7f. Write to project source file → allow (exit 0) ───────────────────────
SRC_PATH="$TMP_PROJECT/src/index.js"
PAYLOAD_SRC=$(printf '{"tool_name":"Write","tool_input":{"file_path":"%s","content":"ok"}}' "$SRC_PATH")
EC=$(hook_exit_code "$PAYLOAD_SRC")
assert_exit_code "Write to project file allowed" "0" "$EC"

# ── 7g. Edit outside project root → block (exit 2) ───────────────────────────
OUTSIDE_PATH="/tmp/evil-edit.sh"
PAYLOAD_OUT=$(printf '{"tool_name":"Edit","tool_input":{"file_path":"%s","old_string":"a","new_string":"b"}}' "$OUTSIDE_PATH")
EC=$(hook_exit_code "$PAYLOAD_OUT")
assert_exit_code "Edit outside project root blocked" "2" "$EC"

# ── 7h. git reset --hard → block (exit 2) ────────────────────────────────────
PAYLOAD_RESET='{"tool_name":"Bash","tool_input":{"command":"git reset --hard HEAD~1"}}'
EC=$(hook_exit_code "$PAYLOAD_RESET")
assert_exit_code "git reset --hard blocked" "2" "$EC"

# ── Cleanup: remove our state file ────────────────────────────────────────────
rm -f "$STATE_DIR/${SESSION_ID}.json"

teardown_env

echo ""
print_summary

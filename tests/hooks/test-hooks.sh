#!/usr/bin/env bash
# claude-overtime v2 — hook test harness
# Run with: bash tests/hooks/test-hooks.sh
# Exit 0 = all tests pass.

set -uo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HOOKS_DIR="$REPO_ROOT/hooks"

# ---- test scaffolding -------------------------------------------------------
PASS=0
FAIL=0
FAIL_MSGS=()

ok() {
  local name="$1"
  echo "  [PASS] $name"
  PASS=$((PASS + 1))
}

fail() {
  local name="$1" msg="$2"
  echo "  [FAIL] $name: $msg"
  FAIL=$((FAIL + 1))
  FAIL_MSGS+=("$name: $msg")
}

assert_eq() {
  local name="$1" got="$2" want="$3"
  if [[ "$got" == "$want" ]]; then
    ok "$name"
  else
    fail "$name" "got='$got' want='$want'"
  fi
}

assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    ok "$name"
  else
    fail "$name" "string '$needle' not found in output"
  fi
}

assert_file_exists() {
  local name="$1" path="$2"
  if [[ -f "$path" ]]; then
    ok "$name"
  else
    fail "$name" "file not found: $path"
  fi
}

assert_file_not_exists() {
  local name="$1" path="$2"
  if [[ ! -f "$path" ]]; then
    ok "$name"
  else
    fail "$name" "file should not exist: $path"
  fi
}

assert_exit() {
  local name="$1" got="$2" want="$3"
  assert_eq "$name (exit code)" "$got" "$want"
}

# ---- temp environment -------------------------------------------------------
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

export HOME="$TMP/home"
mkdir -p "$HOME/.claude/overtime-state"
mkdir -p "$HOME/.claude"

# Minimal global config
cat > "$HOME/.claude/overtime-config.json" <<'CFEOF'
{
  "warnAt": 90,
  "autoOvertime": false
}
CFEOF

# Export a fixed session ID so warn-marker is deterministic
export CLAUDE_SESSION_ID="test-session-$$"

# ============================================================================
echo ""
echo "=== stop.sh tests ==="
# ============================================================================

STOP="$HOOKS_DIR/stop.sh"

# --- native payload → cache with source=native ---
run_stop_native() {
  local payload='{"rate_limits":{"five_hour":{"used_percentage":72,"resets_at":"2026-05-06T08:00:00Z"}},"usage":{}}'
  bash "$STOP" <<< "$payload" 2>&1
}

CACHE="$HOME/.claude/overtime-statusline-cache.json"
rm -f "$CACHE"
out=$(run_stop_native)
assert_file_exists "stop/native: cache file written" "$CACHE"
if [[ -f "$CACHE" ]]; then
  SOURCE=$(python3 -c "import json; d=json.load(open('$CACHE')); print(d.get('source',''))" 2>/dev/null)
  assert_eq "stop/native: source=native" "$SOURCE" "native"
  PCT=$(python3 -c "import json; d=json.load(open('$CACHE')); print(d.get('percentUsed',''))" 2>/dev/null)
  assert_eq "stop/native: percentUsed=72" "$PCT" "72"
fi

# --- fallback payload → cache with source=fallback ---
run_stop_fallback() {
  local payload='{"usage":{"input_tokens":50000,"output_tokens":30000,"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}'
  bash "$STOP" <<< "$payload" 2>&1
}

rm -f "$CACHE" "$HOME/.claude/overtime-fallback-counter.json"
out=$(run_stop_fallback)
assert_file_exists "stop/fallback: cache file written" "$CACHE"
if [[ -f "$CACHE" ]]; then
  SOURCE=$(python3 -c "import json; d=json.load(open('$CACHE')); print(d.get('source',''))" 2>/dev/null)
  assert_eq "stop/fallback: source=fallback" "$SOURCE" "fallback"
fi

# --- warnAt threshold fires banner (once) ---
WARN_MARKER="/tmp/overtime-warned-${CLAUDE_SESSION_ID}"
rm -f "$WARN_MARKER"
# 95% usage (above default warnAt=90)
payload='{"rate_limits":{"five_hour":{"used_percentage":95,"resets_at":"2026-05-06T09:00:00Z"}},"usage":{}}'
OUT=$(bash "$STOP" <<< "$payload" 2>&1)
assert_contains "stop/warn: banner printed" "$OUT" "claude-overtime"
assert_file_exists "stop/warn: marker file created" "$WARN_MARKER"

# Second run must NOT print banner again
OUT2=$(bash "$STOP" <<< "$payload" 2>&1)
if echo "$OUT2" | grep -qF "╔"; then
  fail "stop/warn: banner printed twice (should be once)" "banner appeared on second run"
else
  ok "stop/warn: banner NOT printed twice"
fi

# --- stale state is cleaned up opportunistically ---
STALE_FILE="$HOME/.claude/overtime-state/stale-test.json"
PAST="2000-01-01T00:00:00Z"
cat > "$STALE_FILE" <<STEOF
{
  "pid": 99999999,
  "expires_at": "$PAST",
  "settingsBackup": null,
  "projectRoot": "$TMP/project"
}
STEOF
mkdir -p "$TMP/project/.claude"
touch "$TMP/project/.claude/settings.local.json"

bash "$STOP" <<< '{"usage":{}}' 2>&1 > /dev/null
assert_file_not_exists "stop/gc: stale state file deleted" "$STALE_FILE"

# ============================================================================
echo ""
echo "=== session-start.sh tests ==="
# ============================================================================

SESSION="$HOOKS_DIR/session-start.sh"

# --- stale state with dead PID is GC'd ---
STATE_DIR="$HOME/.claire/overtime-state"  # note: using main home dir
STATE_DIR="$HOME/.claude/overtime-state"
DEAD_PID=99999999  # definitely not running

STALE="$STATE_DIR/dead-pid.json"
cat > "$STALE" <<SSEOF
{
  "pid": $DEAD_PID,
  "expires_at": "2099-01-01T00:00:00Z",
  "settingsBackup": null,
  "projectRoot": "$TMP/project2"
}
SSEOF
mkdir -p "$TMP/project2/.claude"
touch "$TMP/project2/.claude/settings.local.json"

bash "$SESSION" 2>&1 > /dev/null
assert_file_not_exists "session-start/dead-pid: state file GC'd" "$STALE"

# --- settingsBackup restored when non-null ---
BACKUP_PROJECT="$TMP/project3"
mkdir -p "$BACKUP_PROJECT/.claude"
BACKUP_CONTENT='{"permissions":{"allow":["Read"]}}'

STATE_WITH_BACKUP="$STATE_DIR/with-backup.json"
# Create expired state so it gets GC'd
PAST="2000-01-01T00:00:00Z"
cat > "$STATE_WITH_BACKUP" <<SBEOF
{
  "pid": 99999999,
  "expires_at": "$PAST",
  "settingsBackup": $BACKUP_CONTENT,
  "projectRoot": "$BACKUP_PROJECT"
}
SBEOF

bash "$SESSION" 2>&1 > /dev/null
assert_file_not_exists "session-start/backup: state file deleted" "$STATE_WITH_BACKUP"
assert_file_exists "session-start/backup: settings.local.json restored" "$BACKUP_PROJECT/.claude/settings.local.json"
if [[ -f "$BACKUP_PROJECT/.claude/settings.local.json" ]]; then
  CONTENT=$(cat "$BACKUP_PROJECT/.claude/settings.local.json")
  assert_contains "session-start/backup: correct content restored" "$CONTENT" '"Read"'
fi

# ============================================================================
echo ""
echo "=== pre-tool-use.sh tests ==="
# ============================================================================

PTU="$HOOKS_DIR/pre-tool-use.sh"

# Set up an active overtime state file so hooks are NOT inert
ACTIVE_STATE="$HOME/.claude/overtime-state/active-session.json"
FUTURE="2099-01-01T00:00:00Z"
REAL_PID=$$
cat > "$ACTIVE_STATE" <<ASEOF
{
  "pid": $REAL_PID,
  "expires_at": "$FUTURE",
  "settingsBackup": null
}
ASEOF

# Helper: run pre-tool-use and capture exit code
run_ptu() {
  local payload="$1"
  bash "$PTU" <<< "$payload" 2>/dev/null
  echo $?
}

run_ptu_stderr() {
  local payload="$1"
  bash "$PTU" <<< "$payload" 2>&1 >/dev/null
}

# --- blocks git push --force ---
PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"git push --force origin overtime/test"}}'
CODE=$(run_ptu "$PAYLOAD")
assert_exit "ptu/blocks git push --force" "$CODE" "2"

# --- blocks rm -rf ~ ---
PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"rm -rf ~ /mydir"}}'
CODE=$(run_ptu "$PAYLOAD")
assert_exit "ptu/blocks rm -rf ~" "$CODE" "2"

# --- blocks git push origin main ---
PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"git push origin main"}}'
CODE=$(run_ptu "$PAYLOAD")
assert_exit "ptu/blocks git push origin main" "$CODE" "2"

# --- blocks write to node_modules ---
PAYLOAD="{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"${PWD}/node_modules/foo/bar.js\"}}"
CODE=$(run_ptu "$PAYLOAD")
assert_exit "ptu/blocks write to node_modules" "$CODE" "2"

# --- allows git push origin overtime/123 ---
PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"git push origin overtime/123"}}'
CODE=$(run_ptu "$PAYLOAD")
assert_exit "ptu/allows git push overtime/*" "$CODE" "0"

# --- allows git push origin v2/some-feature ---
PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"git push origin v2/some-feature"}}'
CODE=$(run_ptu "$PAYLOAD")
assert_exit "ptu/allows git push v2/*" "$CODE" "0"

# --- allows write to project file ---
PROJECT_FILE="$REPO_ROOT/src/example.js"
PAYLOAD="{\"tool_name\":\"Write\",\"tool_input\":{\"file_path\":\"$PROJECT_FILE\"}}"
# Set PWD to repo root for this check
CODE=$(cd "$REPO_ROOT" && bash "$PTU" <<< "$PAYLOAD" 2>/dev/null; echo $?)
assert_exit "ptu/allows write to project file" "$CODE" "0"

# --- inert when state dir empty ---
rm -f "$ACTIVE_STATE"
PAYLOAD='{"tool_name":"Bash","tool_input":{"command":"rm -rf /"}}'
CODE=$(run_ptu "$PAYLOAD")
assert_exit "ptu/inert when no active state" "$CODE" "0"

# ============================================================================
echo ""
echo "=== Summary ==="
echo "  Passed: $PASS"
echo "  Failed: $FAIL"
if [[ "${#FAIL_MSGS[@]}" -gt 0 ]]; then
  echo ""
  echo "Failures:"
  for m in "${FAIL_MSGS[@]}"; do
    echo "  - $m"
  done
  echo ""
  exit 1
fi
echo ""
echo "All tests passed."
exit 0

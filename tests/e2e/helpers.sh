#!/usr/bin/env bash
# Shared helpers for E2E test scenarios

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
MOCKS_DIR="$REPO_ROOT/tests/e2e/mocks"

# Inject mocks before system PATH
export PATH="$MOCKS_DIR:$PATH"

# ── Pass/Fail counters ────────────────────────────────────────────────────────
PASS=0
FAIL=0
FAILS=()

pass() {
  local name="$1"
  PASS=$((PASS + 1))
  printf "  \033[32mPASS\033[0m  %s\n" "$name"
}

fail() {
  local name="$1" msg="${2:-}"
  FAIL=$((FAIL + 1))
  FAILS+=("$name")
  printf "  \033[31mFAIL\033[0m  %s%s\n" "$name" "${msg:+: $msg}"
}

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    fail "$name" "expected='$expected' got='$actual'"
  fi
}

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF "$needle"; then
    pass "$name"
  else
    fail "$name" "expected to contain '$needle'"
  fi
}

assert_file_exists() {
  local name="$1" path="$2"
  if [[ -f "$path" ]]; then
    pass "$name"
  else
    fail "$name" "file not found: $path"
  fi
}

assert_file_missing() {
  local name="$1" path="$2"
  if [[ ! -f "$path" ]]; then
    pass "$name"
  else
    fail "$name" "file should not exist: $path"
  fi
}

assert_exit_code() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$expected" == "$actual" ]]; then
    pass "$name"
  else
    fail "$name" "expected exit=$expected got=$actual"
  fi
}

# ── Tmp environment setup ─────────────────────────────────────────────────────

# Creates a tmp HOME dir + a tmp git project dir.
# Sets: TMP_HOME, TMP_PROJECT, original HOME backup
# Exports HOME so Node/bash libs pick it up.
setup_env() {
  TMP_HOME="$(mktemp -d)"
  TMP_PROJECT="$(mktemp -d)"
  export HOME="$TMP_HOME"
  export MOCK_LOG="$TMP_HOME/mock-invocations.log"
  # Override OVERTIME_STATE_DIR so state.js uses tmp HOME
  export OVERTIME_STATE_DIR_TEST="$TMP_HOME/.claude/overtime-state"
  mkdir -p "$TMP_HOME/.claude/overtime-state"
  # Init git repo in tmp project
  git -C "$TMP_PROJECT" init -q
  git -C "$TMP_PROJECT" config user.email "test@example.com"
  git -C "$TMP_PROJECT" config user.name "Test"
  touch "$TMP_PROJECT/README.md"
  git -C "$TMP_PROJECT" add .
  git -C "$TMP_PROJECT" commit -q -m "init"
}

teardown_env() {
  rm -rf "$TMP_HOME" "$TMP_PROJECT"
}

# ── State file helpers ────────────────────────────────────────────────────────

# Write a state file directly (bypassing lib/state.js)
write_state_file() {
  local session_id="$1" json="$2"
  mkdir -p "$TMP_HOME/.claude/overtime-state"
  printf '%s\n' "$json" > "$TMP_HOME/.claude/overtime-state/${session_id}.json"
}

# Run lib/state.js create via Node
create_state() {
  # Usage: create_state <owner> <mode> <pid> <expires_at> [projectRoot]
  local owner="$1" mode="$2" pid="$3" expires_at="$4" project_root="${5:-$TMP_PROJECT}"
  node -e "
const state = require('$REPO_ROOT/lib/state');
const id = state.create({
  owner: '$owner',
  mode: '$mode',
  pid: $pid,
  branch: 'overtime/test',
  expires_at: '$expires_at',
  settingsBackup: null,
  projectRoot: '$project_root',
  retryCount: 0,
  started_at: new Date().toISOString(),
});
process.stdout.write(id + '\n');
"
}

# ── Summary ───────────────────────────────────────────────────────────────────

print_summary() {
  local total=$((PASS + FAIL))
  echo ""
  echo "  Results: $PASS/$total passed"
  if [[ "$FAIL" -gt 0 ]]; then
    echo "  Failed:"
    for f in "${FAILS[@]}"; do
      echo "    - $f"
    done
    return 1
  fi
  return 0
}

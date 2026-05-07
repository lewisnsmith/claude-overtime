#!/usr/bin/env bash
# Scenario 1: Install hygiene
# - npm pack + extract to tmp dir → node bin/claude-overtime.js writes nothing to ~/.claude/
# - install --dry-run prints diff without writing
# - install writes expected files
# - uninstall removes only what was added

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== Scenario 1: install-hygiene ==="

setup_env

REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/../.." && pwd)"

# ── 1a. Running the CLI with no subcommand writes nothing to ~/.claude/ ───────
# Record files before
mkdir -p "$TMP_HOME/.claude"
BEFORE_FILES=$(find "$TMP_HOME/.claude" -type f 2>/dev/null | sort)

# Run the CLI — should print help and write NOTHING to ~/.claude/
node "$REPO_ROOT_REAL/bin/claude-overtime.js" >/dev/null 2>&1 || true

AFTER_FILES=$(find "$TMP_HOME/.claude" -type f 2>/dev/null | sort)

if [[ "$BEFORE_FILES" == "$AFTER_FILES" ]]; then
  pass "bare CLI invocation writes nothing to ~/.claude/"
else
  DIFF=$(diff <(echo "$BEFORE_FILES") <(echo "$AFTER_FILES") || true)
  fail "bare CLI invocation writes nothing to ~/.claude/" "new files: $DIFF"
fi

# ── 1b. install --dry-run prints diff, writes nothing ─────────────────────────
BEFORE_FILES2=$(find "$TMP_HOME/.claude" -type f 2>/dev/null | sort)
DRY_OUTPUT=$(node "$REPO_ROOT_REAL/bin/claude-overtime.js" install --dry-run 2>&1 || true)
AFTER_FILES2=$(find "$TMP_HOME/.claude" -type f 2>/dev/null | sort)

assert_contains "dry-run produces output" "dry-run" "$DRY_OUTPUT"

if [[ "$BEFORE_FILES2" == "$AFTER_FILES2" ]]; then
  pass "install --dry-run writes nothing"
else
  fail "install --dry-run writes nothing" "files changed"
fi

# ── 1c. install writes expected files ─────────────────────────────────────────
SETTINGS_BEFORE=""
if [[ -f "$TMP_HOME/.claude/settings.json" ]]; then
  SETTINGS_BEFORE=$(cat "$TMP_HOME/.claude/settings.json")
fi

node "$REPO_ROOT_REAL/bin/claude-overtime.js" install >/dev/null 2>&1

EXPECTED_FILES=(
  "$TMP_HOME/.claude/commands/overtime.md"
  "$TMP_HOME/.claude/hooks/claude-overtime-stop.sh"
  "$TMP_HOME/.claude/hooks/claude-overtime-session-start.sh"
  "$TMP_HOME/.claude/hooks/claude-overtime-pre-tool-use.sh"
  "$TMP_HOME/.claude/hooks/claude-overtime-statusline.sh"
  "$TMP_HOME/.claude/settings.json"
)

for f in "${EXPECTED_FILES[@]}"; do
  assert_file_exists "install writes $(basename "$f")" "$f"
done

# settings.json should contain hook registrations
SETTINGS_CONTENT=$(cat "$TMP_HOME/.claude/settings.json" 2>/dev/null || echo "")
assert_contains "settings.json has Stop hook" "claude-overtime-stop" "$SETTINGS_CONTENT"
assert_contains "settings.json has SessionStart hook" "claude-overtime-session-start" "$SETTINGS_CONTENT"
assert_contains "settings.json has PreToolUse hook" "claude-overtime-pre-tool-use" "$SETTINGS_CONTENT"

# ── 1d. Re-running install is idempotent ───────────────────────────────────────
SETTINGS_AFTER_FIRST=$(cat "$TMP_HOME/.claude/settings.json")
node "$REPO_ROOT_REAL/bin/claude-overtime.js" install >/dev/null 2>&1
SETTINGS_AFTER_SECOND=$(cat "$TMP_HOME/.claude/settings.json")
assert_eq "install is idempotent (settings.json stable)" "$SETTINGS_AFTER_FIRST" "$SETTINGS_AFTER_SECOND"

# ── 1e. uninstall removes only what was added ─────────────────────────────────
# settings.json had no pre-existing hooks — after uninstall it should have no overtime entries
node "$REPO_ROOT_REAL/bin/claude-overtime.js" uninstall >/dev/null 2>&1

for f in "${EXPECTED_FILES[@]}"; do
  if [[ "$f" == *"settings.json" ]]; then
    # settings.json itself stays but overtime entries removed
    if [[ -f "$f" ]]; then
      REMAINING=$(cat "$f")
      if printf '%s' "$REMAINING" | grep -q "claude-overtime-stop"; then
        fail "uninstall removes Stop hook from settings.json"
      else
        pass "uninstall removes Stop hook from settings.json"
      fi
    else
      pass "uninstall removes Stop hook from settings.json"
    fi
  else
    assert_file_missing "uninstall removes $(basename "$f")" "$f"
  fi
done

teardown_env

echo ""
print_summary

#!/usr/bin/env bash
# Scenario 2: Config layering
# - global defaultDelay=auto + project defaultDelay=1h → config get shows 1h
# - customRules from both layers concatenate
# - protectedBranches in global is rejected with stderr warning

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== Scenario 2: config-layering ==="

setup_env

REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/../.." && pwd)"
CLI="node $REPO_ROOT_REAL/bin/claude-overtime.js"

# ── 2a. Global config init + project override ─────────────────────────────────
mkdir -p "$TMP_HOME/.claude"
mkdir -p "$TMP_PROJECT/.claude"

# Write global config: defaultDelay=auto, one customRule
cat > "$TMP_HOME/.claude/overtime-config.json" <<'EOF'
{
  "defaultDelay": "auto",
  "customRules": ["rule-from-global"],
  "protectedBranches": ["release"]
}
EOF

# Write project config: override defaultDelay, add another customRule
cat > "$TMP_PROJECT/.claude/overtime-config.json" <<'EOF'
{
  "defaultDelay": "1h",
  "customRules": ["rule-from-project"]
}
EOF

# Run config get from project dir
cd "$TMP_PROJECT"
DELAY_VAL=$(HOME="$TMP_HOME" $CLI config get defaultDelay 2>/dev/null | tr -d '"')
assert_eq "project defaultDelay overrides global" "1h" "$DELAY_VAL"

# ── 2b. customRules concatenate ───────────────────────────────────────────────
RULES_VAL=$(HOME="$TMP_HOME" $CLI config get customRules 2>/dev/null)
assert_contains "customRules includes global rule" "rule-from-global" "$RULES_VAL"
assert_contains "customRules includes project rule" "rule-from-project" "$RULES_VAL"

# ── 2c. protectedBranches in global triggers stderr warning ───────────────────
# lib/config.js should warn when global has protectedBranches and drop it
STDERR_OUT=$(HOME="$TMP_HOME" $CLI config get protectedBranches 2>&1 >/dev/null || true)
# The merged config should NOT have protectedBranches from global (it's project-only)
MERGED_PROTECTED=$(HOME="$TMP_HOME" $CLI config get protectedBranches 2>/dev/null || echo "")

# Either the value is empty (dropped) or stderr warned about it
if printf '%s' "$STDERR_OUT" | grep -qi "global\|protected\|warning\|ignored\|project-only"; then
  pass "global protectedBranches triggers stderr warning"
elif [[ -z "$MERGED_PROTECTED" || "$MERGED_PROTECTED" == "[]" || "$MERGED_PROTECTED" == "null" ]]; then
  pass "global protectedBranches is silently dropped (no value in merged output)"
else
  fail "global protectedBranches not properly handled" "got: '$MERGED_PROTECTED', stderr: '$STDERR_OUT'"
fi

# ── 2d. Scalar override: global warnAt default, project sets it ───────────────
cat > "$TMP_PROJECT/.claude/overtime-config.json" <<'EOF'
{
  "defaultDelay": "1h",
  "warnAt": 80,
  "customRules": ["rule-from-project"]
}
EOF

WARN_VAL=$(HOME="$TMP_HOME" $CLI config get warnAt 2>/dev/null)
assert_eq "project warnAt overrides global default" "80" "$WARN_VAL"

cd /

teardown_env

echo ""
print_summary

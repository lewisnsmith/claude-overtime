#!/usr/bin/env bash
# Tests for hooks/overtime-statusline.sh
# Run: bash tests/hooks/test-statusline.sh
# Exit 0 = all passed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STATUSLINE="${REPO_ROOT}/hooks/overtime-statusline.sh"

PASS=0
FAIL=0

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "${GREEN}PASS${NC}: $1"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}FAIL${NC}: $1"; echo "       Expected: $2"; echo "       Got:      $3"; FAIL=$((FAIL+1)); }

# Run the script with a temp HOME
run_statusline() {
  HOME="$TMP_HOME" bash "$STATUSLINE"
}

write_cache() {
  local pct="$1" src="$2"
  cat > "${TMP_HOME}/.claude/overtime-statusline-cache.json" <<EOF
{"percentUsed": ${pct}, "source": "${src}", "resetsAt": "2026-05-06T10:00:00Z", "updatedAt": "2026-05-06T09:00:00Z"}
EOF
}

# ----- Setup -----
TMP_HOME=$(mktemp -d)
mkdir -p "${TMP_HOME}/.claude"

cleanup() { rm -rf "$TMP_HOME"; }
trap cleanup EXIT

# -----------------------------------------------------------------------
# Test 1: Cache missing → empty output
# -----------------------------------------------------------------------
rm -f "${TMP_HOME}/.claude/overtime-statusline-cache.json"
rm -f "${TMP_HOME}/.claude/overtime-onboarded"

OUTPUT=$(run_statusline)
if [ -z "$OUTPUT" ]; then
  pass "Cache missing → empty output"
else
  fail "Cache missing → empty output" "" "$OUTPUT"
fi

# -----------------------------------------------------------------------
# Test 2: source=native → overtime: 72% [...]  (no tilde)
# -----------------------------------------------------------------------
rm -f "${TMP_HOME}/.claude/overtime-onboarded"
write_cache 72 "native"

OUTPUT=$(run_statusline)
# After first run, onboarding banner is printed first; get last line
STATUS_LINE=$(echo "$OUTPUT" | tail -1)
EXPECTED="overtime: 72% [=============="
if [[ "$STATUS_LINE" == "overtime: 72% ["* ]]; then
  # Verify no tilde
  if [[ "$STATUS_LINE" != *"~"* ]]; then
    pass "source=native → no tilde prefix"
  else
    fail "source=native → no tilde prefix" "no tilde" "$STATUS_LINE"
  fi
else
  fail "source=native format" "overtime: 72% [...]" "$STATUS_LINE"
fi

# -----------------------------------------------------------------------
# Test 3: source=fallback → overtime: ~72% [...] (tilde)
# -----------------------------------------------------------------------
rm -f "${TMP_HOME}/.claude/overtime-onboarded"
write_cache 72 "fallback"

OUTPUT=$(run_statusline)
STATUS_LINE=$(echo "$OUTPUT" | tail -1)
if [[ "$STATUS_LINE" == "overtime: ~72% ["* ]]; then
  pass "source=fallback → tilde prefix"
else
  fail "source=fallback → tilde prefix" "overtime: ~72% [...]" "$STATUS_LINE"
fi

# -----------------------------------------------------------------------
# Test 4: First run prints onboarding banner, subsequent runs don't
# -----------------------------------------------------------------------
rm -f "${TMP_HOME}/.claude/overtime-onboarded"
write_cache 50 "native"

FIRST_OUTPUT=$(run_statusline)
FIRST_LINE_COUNT=$(echo "$FIRST_OUTPUT" | wc -l | tr -d ' ')
FIRST_BANNER=$(echo "$FIRST_OUTPUT" | head -1)

if [[ "$FIRST_BANNER" == *"overtime installed"* ]]; then
  pass "First run: onboarding banner present"
else
  fail "First run: onboarding banner present" "[overtime installed — ...]" "$FIRST_BANNER"
fi

# Second run — marker file now exists
SECOND_OUTPUT=$(run_statusline)
SECOND_LINE_COUNT=$(echo "$SECOND_OUTPUT" | wc -l | tr -d ' ')
if [ "$SECOND_LINE_COUNT" -eq 1 ]; then
  pass "Second run: no onboarding banner"
else
  fail "Second run: no onboarding banner" "1 line" "$SECOND_LINE_COUNT lines: $SECOND_OUTPUT"
fi

# -----------------------------------------------------------------------
# Test 5: 0% → empty bar (20 spaces)
# -----------------------------------------------------------------------
rm -f "${TMP_HOME}/.claude/overtime-onboarded"
touch "${TMP_HOME}/.claude/overtime-onboarded"  # skip onboarding
write_cache 0 "native"

OUTPUT=$(run_statusline)
EXPECTED="overtime: 0% [                    ]"
if [ "$OUTPUT" = "$EXPECTED" ]; then
  pass "0% → empty bar"
else
  fail "0% → empty bar" "$EXPECTED" "$OUTPUT"
fi

# -----------------------------------------------------------------------
# Test 6: 100% → full bar (20 = chars)
# -----------------------------------------------------------------------
write_cache 100 "native"
OUTPUT=$(run_statusline)
EXPECTED="overtime: 100% [====================]"
if [ "$OUTPUT" = "$EXPECTED" ]; then
  pass "100% → full bar"
else
  fail "100% → full bar" "$EXPECTED" "$OUTPUT"
fi

# -----------------------------------------------------------------------
# Test 7: Bar character count is exactly 20 inside the brackets
# -----------------------------------------------------------------------
write_cache 72 "native"
OUTPUT=$(run_statusline)
# Extract content between [ and ]
INNER=$(echo "$OUTPUT" | sed 's/.*\[\(.*\)\]/\1/')
INNER_LEN=${#INNER}
if [ "$INNER_LEN" -eq 20 ]; then
  pass "Bar is exactly 20 chars wide (72%)"
else
  fail "Bar is exactly 20 chars wide (72%)" "20" "$INNER_LEN (inner='$INNER')"
fi

# Test a few more percents for bar width
for PCT_VAL in 0 25 50 75 100; do
  write_cache "$PCT_VAL" "native"
  OUT=$(run_statusline)
  INNER=$(echo "$OUT" | sed 's/.*\[\(.*\)\]/\1/')
  INNER_LEN=${#INNER}
  if [ "$INNER_LEN" -eq 20 ]; then
    pass "Bar exactly 20 chars at ${PCT_VAL}%"
  else
    fail "Bar exactly 20 chars at ${PCT_VAL}%" "20" "$INNER_LEN (inner='$INNER')"
  fi
done

# -----------------------------------------------------------------------
# Test 8: Cache missing after first successful run → empty output
# -----------------------------------------------------------------------
rm -f "${TMP_HOME}/.claude/overtime-statusline-cache.json"
OUTPUT=$(run_statusline)
if [ -z "$OUTPUT" ]; then
  pass "Cache removed mid-session → empty output"
else
  fail "Cache removed mid-session → empty output" "" "$OUTPUT"
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
echo ""
echo "Results: ${PASS} passed, ${FAIL} failed"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0

#!/usr/bin/env bash
# E2E test runner for claude-overtime v2
# Runs each scenario script, collects results, exits 0 if all pass.

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

SCENARIOS=(
  "$SCRIPT_DIR/install-hygiene.sh"
  "$SCRIPT_DIR/config-layering.sh"
  "$SCRIPT_DIR/single-task-happy-path.sh"
  "$SCRIPT_DIR/backlog-happy-path.sh"
  "$SCRIPT_DIR/rate-limit-mock.sh"
  "$SCRIPT_DIR/crash-safety.sh"
  "$SCRIPT_DIR/mechanical-safety.sh"
  "$SCRIPT_DIR/stale-uninstall.sh"
)

PASS_SCENARIOS=0
FAIL_SCENARIOS=0
FAILED_NAMES=()

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║   claude-overtime v2 — E2E Test Suite        ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

for scenario in "${SCENARIOS[@]}"; do
  name="$(basename "$scenario" .sh)"
  echo "────────────────────────────────────────────────"

  # Run each scenario in a subshell so set -e doesn't propagate
  if bash "$scenario"; then
    PASS_SCENARIOS=$((PASS_SCENARIOS + 1))
    printf "\n\033[32m✓ SCENARIO PASSED:\033[0m %s\n" "$name"
  else
    EC=$?
    FAIL_SCENARIOS=$((FAIL_SCENARIOS + 1))
    FAILED_NAMES+=("$name")
    printf "\n\033[31m✗ SCENARIO FAILED:\033[0m %s (exit %d)\n" "$name" "$EC"
  fi
  echo ""
done

echo "════════════════════════════════════════════════"
echo "  TOTAL: $((PASS_SCENARIOS + FAIL_SCENARIOS)) scenarios"
echo "  PASS:  $PASS_SCENARIOS"
echo "  FAIL:  $FAIL_SCENARIOS"

if [[ "$FAIL_SCENARIOS" -gt 0 ]]; then
  echo ""
  echo "  Failed scenarios:"
  for n in "${FAILED_NAMES[@]}"; do
    echo "    ✗ $n"
  done
  echo ""
  exit 1
fi

echo ""
echo "  All scenarios passed."
echo ""
exit 0

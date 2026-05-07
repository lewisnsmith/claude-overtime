#!/usr/bin/env bash
# Scenario 5: Rate-limit mock
# - Pipe fake stdin JSON to hooks/stop.sh simulating 95% native usage
#   → confirm cache file written with source:"native" and percentUsed:95
# - Pipe fallback JSON (no rate_limits field)
#   → confirm fallback cache written with source:"fallback"

set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/helpers.sh"

echo "=== Scenario 5: rate-limit-mock ==="

setup_env

REPO_ROOT_REAL="$(cd "$SCRIPT_DIR/../.." && pwd)"
STOP_HOOK="$REPO_ROOT_REAL/hooks/stop.sh"
CACHE_FILE="$TMP_HOME/.claude/overtime-statusline-cache.json"
FALLBACK_FILE="$TMP_HOME/.claude/overtime-fallback-counter.json"

# ── 5a. Native 95% usage ──────────────────────────────────────────────────────
NATIVE_PAYLOAD=$(cat <<'EOF'
{
  "rate_limits": {
    "five_hour": {
      "used_percentage": 95,
      "resets_at": "2099-01-01T10:00:00Z"
    }
  },
  "usage": {
    "input_tokens": 1000,
    "output_tokens": 500,
    "cache_read_input_tokens": 0,
    "cache_creation_input_tokens": 0
  }
}
EOF
)

printf '%s' "$NATIVE_PAYLOAD" | HOME="$TMP_HOME" bash "$STOP_HOOK" 2>/dev/null || true

assert_file_exists "cache file written after native payload" "$CACHE_FILE"

CACHE_CONTENT=$(cat "$CACHE_FILE" 2>/dev/null || echo "")
assert_contains "cache has source:native" "native" "$CACHE_CONTENT"

# percentUsed should be 95
PERCENT_VAL=$(node -e "
try {
  const c = JSON.parse(require('fs').readFileSync('$CACHE_FILE','utf8'));
  console.log(c.percentUsed);
} catch(e) { console.log('ERROR'); }
" 2>/dev/null)
assert_eq "cache percentUsed is 95" "95" "$PERCENT_VAL"

# ── 5b. Fallback path (no rate_limits field) ──────────────────────────────────
# Remove cache to get clean slate for fallback detection
rm -f "$CACHE_FILE"

FALLBACK_PAYLOAD=$(cat <<'EOF'
{
  "usage": {
    "input_tokens": 5000,
    "output_tokens": 3000,
    "cache_read_input_tokens": 2000,
    "cache_creation_input_tokens": 1000
  }
}
EOF
)

printf '%s' "$FALLBACK_PAYLOAD" | HOME="$TMP_HOME" bash "$STOP_HOOK" 2>/dev/null || true

assert_file_exists "cache file written after fallback payload" "$CACHE_FILE"
assert_file_exists "fallback counter file written" "$FALLBACK_FILE"

CACHE_CONTENT2=$(cat "$CACHE_FILE" 2>/dev/null || echo "")
assert_contains "cache has source:fallback" "fallback" "$CACHE_CONTENT2"

# Fallback counter should have total > 0
FALLBACK_TOTAL=$(node -e "
try {
  const f = JSON.parse(require('fs').readFileSync('$FALLBACK_FILE','utf8'));
  console.log(f.total > 0 ? 'positive' : 'zero');
} catch(e) { console.log('ERROR'); }
" 2>/dev/null)
assert_eq "fallback counter total is positive" "positive" "$FALLBACK_TOTAL"

# ── 5c. Re-pipe native — cache source flips back to native ───────────────────
printf '%s' "$NATIVE_PAYLOAD" | HOME="$TMP_HOME" bash "$STOP_HOOK" 2>/dev/null || true
CACHE_CONTENT3=$(cat "$CACHE_FILE" 2>/dev/null || echo "")
assert_contains "cache source returns to native" "native" "$CACHE_CONTENT3"

teardown_env

echo ""
print_summary

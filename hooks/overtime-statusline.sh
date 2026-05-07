#!/usr/bin/env bash
# claude-overtime v2: status line script
# Reads ~/.claude/overtime-statusline-cache.json and prints one line.
# No Node dependency — uses jq with python3 fallback.
# Exit 0 always.

CACHE_FILE="${HOME}/.claude/overtime-statusline-cache.json"
ONBOARD_MARKER="${HOME}/.claude/overtime-onboarded"

# Helper: parse JSON field from file using jq or python3
json_get() {
  local file="$1" field="$2"
  if command -v jq &>/dev/null; then
    jq -r "${field} // empty" "$file" 2>/dev/null
  else
    python3 -c "
import json, sys
try:
  d = json.load(open('${file}'))
  import functools, operator
  keys = '${field}'.lstrip('.').split('.')
  v = functools.reduce(operator.getitem, keys, d)
  print(v if v is not None else '')
except Exception:
  print('')
" 2>/dev/null
  fi
}

# If cache missing, print nothing and exit
if [ ! -f "$CACHE_FILE" ]; then
  exit 0
fi

# Parse fields
PERCENT_RAW=$(json_get "$CACHE_FILE" '.percentUsed')
SOURCE=$(json_get "$CACHE_FILE" '.source')

# Validate percentUsed is a number
if ! printf '%s' "$PERCENT_RAW" | grep -qE '^[0-9]+(\.[0-9]+)?$'; then
  exit 0
fi

# Round to integer 0-100 using python3 (handles proper rounding)
PCT=$(python3 -c "print(min(100, max(0, round(float('${PERCENT_RAW}')))))" 2>/dev/null)
if [ -z "$PCT" ]; then
  # bash fallback: truncate
  PCT=${PERCENT_RAW%%.*}
  [ "$PCT" -gt 100 ] 2>/dev/null && PCT=100
  [ "$PCT" -lt 0 ] 2>/dev/null && PCT=0
fi

# Build 20-char progress bar using python3 for proper Math.round(pct/5)
FILLED=$(python3 -c "print(round(${PCT}/5))" 2>/dev/null)
if [ -z "$FILLED" ]; then
  FILLED=$(( (PCT + 2) / 5 ))
fi
[ "$FILLED" -gt 20 ] && FILLED=20
[ "$FILLED" -lt 0 ] && FILLED=0
EMPTY=$(( 20 - FILLED ))

BAR=""
for ((i=0; i<FILLED; i++)); do BAR="${BAR}="; done
for ((i=0; i<EMPTY; i++)); do BAR="${BAR} "; done

# Determine prefix: tilde for fallback
if [ "$SOURCE" = "fallback" ]; then
  PREFIX="~"
else
  PREFIX=""
fi

# One-time onboarding banner (printed before the status line)
if [ ! -f "$ONBOARD_MARKER" ]; then
  touch "$ONBOARD_MARKER"
  echo "[overtime installed — run /overtime to schedule a resume, or set autoOvertime: true to auto-schedule near rate limit]"
fi

echo "overtime: ${PREFIX}${PCT}% [${BAR}]"
exit 0

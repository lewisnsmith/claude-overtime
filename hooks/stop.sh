#!/usr/bin/env bash
# claude-overtime: Stop hook (v2)
# Fires on every Claude Code Stop event.
# - Reads native rate-limit data or falls back to token counting.
# - Writes status-line cache file.
# - Warns at warnAt threshold (once per session, desktop + terminal).
# - Reports if auto-overtime would fire.
# - Opportunistically GCs stale overtime state files.
# No Node.js dependency — uses jq (preferred) or python3 fallback.
#
# Exit 0 always — Stop hooks must never block.

set -uo pipefail

# ---------------------------------------------------------------------------
# JSON helpers (jq preferred, python3 fallback)
# ---------------------------------------------------------------------------
_jq_available() { command -v jq &>/dev/null; }

json_get() {
  # json_get <json-string> <dotpath>  — e.g. json_get "$INPUT" '.foo.bar'
  local json="$1" path="$2"
  if _jq_available; then
    printf '%s' "$json" | jq -r "$path // empty" 2>/dev/null
  else
    python3 - "$path" <<PYEOF 2>/dev/null
import json, sys
obj = json.loads("""$json""")
keys = [k for k in sys.argv[1].lstrip('.').split('.') if k]
for k in keys:
    if isinstance(obj, dict):
        obj = obj.get(k)
    else:
        obj = None
    if obj is None:
        break
if obj is not None:
    print(obj)
PYEOF
  fi
}

json_get_int() {
  local val
  val=$(json_get "$1" "$2")
  printf '%s' "${val:-0}"
}

now_epoch() { date +%s; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# ---------------------------------------------------------------------------
# Read stdin once
# ---------------------------------------------------------------------------
INPUT=$(cat)

# ---------------------------------------------------------------------------
# Config — shallow merge global + project override
# ---------------------------------------------------------------------------
GLOBAL_CONFIG="${HOME}/.claude/overtime-config.json"
PROJECT_CONFIG="${PWD}/.claude/overtime-config.json"

_read_config_key() {
  local key="$1" default="$2"
  local val=""
  # Check project config first (higher priority)
  if [[ -f "$PROJECT_CONFIG" ]]; then
    val=$(json_get "$(cat "$PROJECT_CONFIG")" ".$key" 2>/dev/null)
  fi
  # Fall back to global config
  if [[ -z "$val" && -f "$GLOBAL_CONFIG" ]]; then
    val=$(json_get "$(cat "$GLOBAL_CONFIG")" ".$key" 2>/dev/null)
  fi
  printf '%s' "${val:-$default}"
}

WARN_AT=$(_read_config_key "warnAt" "90")
AUTO_OVERTIME=$(_read_config_key "autoOvertime" "false")

# ---------------------------------------------------------------------------
# Extract rate-limit data from payload
# ---------------------------------------------------------------------------
CACHE_DIR="${HOME}/.claude"
CACHE_FILE="${CACHE_DIR}/overtime-statusline-cache.json"
FALLBACK_FILE="${CACHE_DIR}/overtime-fallback-counter.json"

mkdir -p "$CACHE_DIR"
mkdir -p "${HOME}/.claude/overtime-state"

PERCENT_USED=""
RESETS_AT=""
SOURCE="native"

# Try native rate-limit fields
NATIVE_PERCENT=$(json_get "$INPUT" '.rate_limits.five_hour.used_percentage' 2>/dev/null)
NATIVE_RESETS=$(json_get "$INPUT" '.rate_limits.five_hour.resets_at' 2>/dev/null)

if [[ -n "$NATIVE_PERCENT" && "$NATIVE_PERCENT" != "null" ]]; then
  PERCENT_USED="$NATIVE_PERCENT"
  RESETS_AT="${NATIVE_RESETS:-}"
  SOURCE="native"
else
  # Fallback: accumulate token counts
  INPUT_TOKENS=$(json_get_int "$INPUT" '.usage.input_tokens')
  OUTPUT_TOKENS=$(json_get_int "$INPUT" '.usage.output_tokens')
  CACHE_READ=$(json_get_int "$INPUT" '.usage.cache_read_input_tokens')
  CACHE_WRITE=$(json_get_int "$INPUT" '.usage.cache_creation_input_tokens')
  THIS_TURN=$((INPUT_TOKENS + OUTPUT_TOKENS + CACHE_READ + CACHE_WRITE))

  # Read existing fallback counter
  PREV_TOTAL=0
  if [[ -f "$FALLBACK_FILE" ]]; then
    PREV_TOTAL=$(json_get_int "$(cat "$FALLBACK_FILE")" '.total' 2>/dev/null)
    PREV_TOTAL="${PREV_TOTAL:-0}"
  fi
  NEW_TOTAL=$((PREV_TOTAL + THIS_TURN))

  # Write updated fallback counter
  cat > "$FALLBACK_FILE" <<FBEOF
{
  "total": $NEW_TOTAL,
  "updated": "$(now_iso)"
}
FBEOF

  # 200000 tokens = nominal 5-hour window capacity
  PERCENT_USED=$(awk "BEGIN { printf \"%.1f\", ($NEW_TOTAL / 200000.0) * 100 }")
  RESETS_AT=""
  SOURCE="fallback"
fi

# Clamp to 100
PERCENT_INT=$(printf '%.0f' "$PERCENT_USED" 2>/dev/null || echo "0")
if [[ "$PERCENT_INT" -gt 100 ]]; then PERCENT_INT=100; fi

# Write status-line cache
cat > "$CACHE_FILE" <<CEOF
{
  "percentUsed": $PERCENT_INT,
  "resetsAt": "${RESETS_AT:-null}",
  "updatedAt": "$(now_iso)",
  "source": "$SOURCE"
}
CEOF

# ---------------------------------------------------------------------------
# Session-unique warn marker (once per Claude Code session)
# ---------------------------------------------------------------------------
# Use CLAUDE_SESSION_ID if exported, else fall back to process group / day
SESSION_ID="${CLAUDE_SESSION_ID:-$(date +%Y%m%d)}"
WARN_MARKER="/tmp/overtime-warned-${SESSION_ID}"

if [[ "$PERCENT_INT" -ge "$WARN_AT" && ! -f "$WARN_MARKER" ]]; then
  touch "$WARN_MARKER"

  RESET_MSG=""
  [[ -n "$RESETS_AT" && "$RESETS_AT" != "null" ]] && RESET_MSG=" (resets $RESETS_AT)"

  # Terminal banner
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  claude-overtime: rate limit ${PERCENT_INT}% reached${RESET_MSG}"
  echo "║  Run /overtime to continue your session overnight.  ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""

  NOTIFY_MSG="claude-overtime: rate limit ${PERCENT_INT}% reached${RESET_MSG}. Run /overtime to continue."
  if command -v osascript &>/dev/null; then
    osascript -e "display notification \"$NOTIFY_MSG\" with title \"claude-overtime\"" 2>/dev/null || true
  elif command -v notify-send &>/dev/null; then
    notify-send "claude-overtime" "$NOTIFY_MSG" 2>/dev/null || true
  fi
fi

# ---------------------------------------------------------------------------
# Auto-overtime advisory (does not actually invoke /overtime)
# ---------------------------------------------------------------------------
OVERTIME_STATE_DIR="${HOME}/.claude/overtime-state"
ACTIVE_COUNT=0
if [[ -d "$OVERTIME_STATE_DIR" ]]; then
  ACTIVE_COUNT=$(find "$OVERTIME_STATE_DIR" -name "*.json" -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
fi

if [[ "$AUTO_OVERTIME" == "true" && "$PERCENT_INT" -ge "$WARN_AT" && "$ACTIVE_COUNT" -eq 0 ]]; then
  echo "[claude-overtime] auto-overtime would fire here (usage ${PERCENT_INT}% >= warnAt ${WARN_AT}%). Invoke /overtime manually or set autoOvertime in config."
fi

# ---------------------------------------------------------------------------
# Opportunistic stale-state cleanup
# ---------------------------------------------------------------------------
CLEANUP_LOG="${HOME}/.claude/overtime-cleanup.log"
NOW_EPOCH=$(now_epoch)

if [[ -d "$OVERTIME_STATE_DIR" ]]; then
  for STATE_FILE in "$OVERTIME_STATE_DIR"/*.json; do
    [[ -f "$STATE_FILE" ]] || continue

    STATE_CONTENT=$(cat "$STATE_FILE" 2>/dev/null) || continue

    EXPIRES_AT_STR=$(json_get "$STATE_CONTENT" '.expires_at' 2>/dev/null)
    [[ -z "$EXPIRES_AT_STR" || "$EXPIRES_AT_STR" == "null" ]] && continue

    # Convert ISO to epoch
    if command -v gdate &>/dev/null; then
      EXPIRES_EPOCH=$(gdate -d "$EXPIRES_AT_STR" +%s 2>/dev/null || echo "0")
    else
      EXPIRES_EPOCH=$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$EXPIRES_AT_STR" +%s 2>/dev/null || \
                      date -d "$EXPIRES_AT_STR" +%s 2>/dev/null || echo "0")
    fi

    if [[ "$NOW_EPOCH" -gt "$EXPIRES_EPOCH" ]]; then
      # State is stale — attempt restore
      SETTINGS_BACKUP=$(json_get "$STATE_CONTENT" '.settingsBackup' 2>/dev/null)
      PROJECT_ROOT=$(json_get "$STATE_CONTENT" '.projectRoot' 2>/dev/null)

      if [[ -n "$PROJECT_ROOT" && "$PROJECT_ROOT" != "null" ]]; then
        SETTINGS_PATH="${PROJECT_ROOT}/.claude/settings.local.json"
        if [[ "$SETTINGS_BACKUP" == "null" || -z "$SETTINGS_BACKUP" ]]; then
          rm -f "$SETTINGS_PATH" 2>/dev/null || true
          echo "[$(now_iso)] stop.sh: deleted stale settings $SETTINGS_PATH (no backup)" >> "$CLEANUP_LOG"
        else
          mkdir -p "$(dirname "$SETTINGS_PATH")"
          printf '%s' "$SETTINGS_BACKUP" > "$SETTINGS_PATH"
          echo "[$(now_iso)] stop.sh: restored settings backup to $SETTINGS_PATH" >> "$CLEANUP_LOG"
        fi
      fi

      echo "[$(now_iso)] stop.sh: removed stale state $STATE_FILE (expired $EXPIRES_AT_STR)" >> "$CLEANUP_LOG"
      rm -f "$STATE_FILE" 2>/dev/null || true
    fi
  done
fi

exit 0

#!/usr/bin/env bash
# claude-overtime: SessionStart hook (v2)
# Fires on every Claude Code session boot.
# GCs stale overtime state files:
#   - Dead PID (kill -0 fails) OR expires_at < now → restore settingsBackup + delete state
# No Node.js dependency — uses jq (preferred) or python3 fallback.
#
# Exit 0 always — SessionStart hooks must never block.

set -uo pipefail

# ---------------------------------------------------------------------------
# JSON helpers (jq preferred, python3 fallback)
# ---------------------------------------------------------------------------
_jq_available() { command -v jq &>/dev/null; }

json_get() {
  local json="$1" path="$2"
  if _jq_available; then
    printf '%s' "$json" | jq -r "$path // empty" 2>/dev/null
  else
    python3 - "$path" <<PYEOF 2>/dev/null
import json, sys
data = """$json"""
try:
    obj = json.loads(data)
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
except Exception:
    pass
PYEOF
  fi
}

now_epoch() { date +%s; }
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

iso_to_epoch() {
  local ts="$1"
  if command -v gdate &>/dev/null; then
    gdate -d "$ts" +%s 2>/dev/null || echo "0"
  else
    date -j -f "%Y-%m-%dT%H:%M:%SZ" "$ts" +%s 2>/dev/null || \
    date -d "$ts" +%s 2>/dev/null || echo "0"
  fi
}

# ---------------------------------------------------------------------------
# GC stale state directory
# ---------------------------------------------------------------------------
OVERTIME_STATE_DIR="${HOME}/.claude/overtime-state"
CLEANUP_LOG="${HOME}/.claude/overtime-cleanup.log"

mkdir -p "$OVERTIME_STATE_DIR"

NOW_EPOCH=$(now_epoch)

for STATE_FILE in "$OVERTIME_STATE_DIR"/*.json; do
  [[ -f "$STATE_FILE" ]] || continue

  STATE_CONTENT=$(cat "$STATE_FILE" 2>/dev/null) || continue

  PID=$(json_get "$STATE_CONTENT" '.pid' 2>/dev/null)
  EXPIRES_AT_STR=$(json_get "$STATE_CONTENT" '.expires_at' 2>/dev/null)

  SHOULD_GC=false

  # Check if PID is dead
  if [[ -n "$PID" && "$PID" != "null" && "$PID" =~ ^[0-9]+$ ]]; then
    if ! kill -0 "$PID" 2>/dev/null; then
      SHOULD_GC=true
    fi
  fi

  # Check if expired
  if [[ -n "$EXPIRES_AT_STR" && "$EXPIRES_AT_STR" != "null" ]]; then
    EXPIRES_EPOCH=$(iso_to_epoch "$EXPIRES_AT_STR")
    if [[ "$NOW_EPOCH" -gt "$EXPIRES_EPOCH" ]]; then
      SHOULD_GC=true
    fi
  fi

  if [[ "$SHOULD_GC" == "true" ]]; then
    SETTINGS_BACKUP=$(json_get "$STATE_CONTENT" '.settingsBackup' 2>/dev/null)
    PROJECT_ROOT=$(json_get "$STATE_CONTENT" '.projectRoot' 2>/dev/null)

    # Restore or remove settings.local.json
    if [[ -n "$PROJECT_ROOT" && "$PROJECT_ROOT" != "null" ]]; then
      SETTINGS_PATH="${PROJECT_ROOT}/.claude/settings.local.json"

      if [[ -z "$SETTINGS_BACKUP" || "$SETTINGS_BACKUP" == "null" ]]; then
        # No backup — just delete the file if it exists
        if [[ -f "$SETTINGS_PATH" ]]; then
          rm -f "$SETTINGS_PATH" 2>/dev/null || true
          echo "[$(now_iso)] session-start.sh: deleted $SETTINGS_PATH (settingsBackup was null)" >> "$CLEANUP_LOG"
        fi
      else
        # Restore backup
        mkdir -p "$(dirname "$SETTINGS_PATH")"
        printf '%s' "$SETTINGS_BACKUP" > "$SETTINGS_PATH"
        echo "[$(now_iso)] session-start.sh: restored settings backup to $SETTINGS_PATH" >> "$CLEANUP_LOG"
      fi
    fi

    # Best-effort: kill caffeinate/sleep children of the PID
    if [[ -n "$PID" && "$PID" != "null" && "$PID" =~ ^[0-9]+$ ]]; then
      pkill -P "$PID" caffeinate 2>/dev/null || true
      pkill -P "$PID" sleep 2>/dev/null || true
    fi

    REASON=""
    if [[ -n "$EXPIRES_AT_STR" && "$EXPIRES_AT_STR" != "null" ]]; then
      EXPIRES_EPOCH=$(iso_to_epoch "$EXPIRES_AT_STR")
      if [[ "$NOW_EPOCH" -gt "$EXPIRES_EPOCH" ]]; then
        REASON="expired ($EXPIRES_AT_STR)"
      fi
    fi
    if [[ -n "$PID" && "$PID" != "null" ]]; then
      if ! kill -0 "$PID" 2>/dev/null; then
        REASON="${REASON:+$REASON, }dead pid $PID"
      fi
    fi

    echo "[$(now_iso)] session-start.sh: GC'd $STATE_FILE ($REASON)" >> "$CLEANUP_LOG"
    rm -f "$STATE_FILE" 2>/dev/null || true
  fi
done

exit 0

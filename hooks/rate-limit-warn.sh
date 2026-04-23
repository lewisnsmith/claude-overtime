#!/usr/bin/env bash
# claude-overtime: rate limit warning hook
# Fires on Claude Code Stop events. Reads the stop reason from stdin (JSON)
# and warns the user if they are near the rate limit.
#
# Install location: configured as a Stop hook in ~/.claude/settings.json
# See: install instructions in README.md

set -euo pipefail

# Read the hook input JSON from stdin
INPUT=$(cat)

# Parse token usage if available
TOKENS_USED=$(echo "$INPUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
    try {
      const o=JSON.parse(d);
      const u=o.usage||o.token_usage||{};
      const total=(u.input_tokens||0)+(u.output_tokens||0)+(u.cache_read_input_tokens||0);
      console.log(total);
    } catch(e){ console.log(0); }
  });
" 2>/dev/null || echo "0")

STATE_FILE="${HOME}/.claude/overtime-token-state.json"
WARN_FILE="/tmp/claude-overtime-warned"

# Track cumulative usage across the session
SESSION_TOTAL=0
if [[ -f "$STATE_FILE" ]]; then
  STORED=$(node -e "
    const fs=require('fs');
    try{ const d=JSON.parse(fs.readFileSync('$STATE_FILE','utf8')); console.log(d.session_total||0); }
    catch(e){ console.log(0); }
  " 2>/dev/null || echo "0")
  SESSION_TOTAL=$((STORED + TOKENS_USED))
else
  SESSION_TOTAL=$TOKENS_USED
fi

# Persist updated count
mkdir -p "$(dirname "$STATE_FILE")"
echo "{\"session_total\": $SESSION_TOTAL, \"updated\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\"}" > "$STATE_FILE"

# Claude Pro / API rate limits vary. Default threshold: warn at 90,000 tokens
# (roughly 95% of a typical ~95k hourly limit). Override with CLAUDE_OVERTIME_WARN_AT env var.
WARN_AT=$(node -e "
  try {
    const c=JSON.parse(require('fs').readFileSync(require('os').homedir()+'/.claude/overtime-config.json','utf8'));
    console.log(c.warnAt||process.env.CLAUDE_OVERTIME_WARN_AT||90000);
  } catch(e){ console.log(process.env.CLAUDE_OVERTIME_WARN_AT||90000); }
" 2>/dev/null || echo "${CLAUDE_OVERTIME_WARN_AT:-90000}")

if [[ "$SESSION_TOTAL" -ge "$WARN_AT" ]] && [[ ! -f "$WARN_FILE" ]]; then
  touch "$WARN_FILE"

  # Desktop notification (works on macOS and Linux with notify-send)
  NOTIFY_MSG="⚠️  Claude rate limit ~95% used (${SESSION_TOTAL} tokens). Run /overtime to continue automatically."

  if command -v osascript &>/dev/null; then
    # macOS
    osascript -e "display notification \"$NOTIFY_MSG\" with title \"claude-overtime\"" 2>/dev/null || true
  elif command -v notify-send &>/dev/null; then
    # Linux
    notify-send "claude-overtime" "$NOTIFY_MSG" 2>/dev/null || true
  fi

  # Also print to terminal
  echo ""
  echo "╔══════════════════════════════════════════════════════╗"
  echo "║  ⚠️  claude-overtime: rate limit ~95% reached        ║"
  echo "║  Run /overtime to continue your session overnight.  ║"
  echo "╚══════════════════════════════════════════════════════╝"
  echo ""
fi

# Clean up warning flag at start of new session (token count resets)
if [[ "$SESSION_TOTAL" -lt 1000 ]] && [[ -f "$WARN_FILE" ]]; then
  rm -f "$WARN_FILE"
fi

# Auto-cleanup stale overtime permissions
# If /overtime was active and the session crashed, clean up on the next Stop event
OT_STATE_FILE="/tmp/claude-overtime-state.json"
if [[ -f "$OT_STATE_FILE" ]]; then
  OT_EXPIRY=$(node -e "
    try {
      const s=JSON.parse(require('fs').readFileSync('$OT_STATE_FILE','utf8'));
      console.log(s.expires_at||0);
    } catch(e) { console.log(0); }
  " 2>/dev/null || echo "0")
  OT_NOW=$(date +%s)
  if [[ "$OT_NOW" -gt "$OT_EXPIRY" ]]; then
    OT_SETTINGS=$(node -e "
      try {
        const s=JSON.parse(require('fs').readFileSync('$OT_STATE_FILE','utf8'));
        console.log(s.settings_path||'');
      } catch(e) { console.log(''); }
    " 2>/dev/null || echo "")
    if [[ -n "$OT_SETTINGS" && -f "$OT_SETTINGS" ]]; then
      node -e "
        const f='$OT_SETTINGS';
        try {
          const s=JSON.parse(require('fs').readFileSync(f,'utf8'));
          delete s.permissions;
          if(Object.keys(s).length===0) require('fs').rmSync(f);
          else require('fs').writeFileSync(f,JSON.stringify(s,null,2)+'\n');
        } catch(e) {}
      " 2>/dev/null
    fi
    rm -f "$OT_STATE_FILE" /tmp/claude-overtime-permissions-owner \
          /tmp/claude-overtime-caffeinate.pid 2>/dev/null || true
  fi
fi

exit 0

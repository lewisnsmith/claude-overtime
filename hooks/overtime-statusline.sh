#!/usr/bin/env bash
# claude-overtime: status line script
# Displays rate limit usage percentage in the Claude Code status bar.
# Receives session JSON via stdin from Claude Code's status line system.

set -euo pipefail

INPUT=$(cat)

# Extract rate limit usage percentage (available after first API response)
PCT=$(echo "$INPUT" | node -e "
  let d=''; process.stdin.on('data',c=>d+=c).on('end',()=>{
    try {
      const o=JSON.parse(d);
      const rl=o.rate_limits||{};
      const fh=rl.five_hour||{};
      const pct=fh.used_percentage;
      if(pct!=null) console.log(Math.round(pct));
      else console.log('');
    } catch(e){ console.log(''); }
  });
" 2>/dev/null || echo "")

if [ -z "$PCT" ]; then
  # No rate limit data yet — check our own token state file as fallback
  STATE_FILE="${HOME}/.claude/overtime-token-state.json"
  WARN_AT="${CLAUDE_OVERTIME_WARN_AT:-90000}"
  if [ -f "$STATE_FILE" ]; then
    TOTAL=$(node -e "
      const fs=require('fs');
      try{ const d=JSON.parse(fs.readFileSync('$STATE_FILE','utf8')); console.log(d.session_total||0); }
      catch(e){ console.log(0); }
    " 2>/dev/null || echo "0")
    if [ "$TOTAL" -gt 0 ] 2>/dev/null; then
      PCT=$(( (TOTAL * 100) / WARN_AT ))
      echo "OT: ~${PCT}%"
    else
      echo "OT: 0%"
    fi
  else
    echo "OT: 0%"
  fi
else
  # Build a visual bar
  FILLED=$(( PCT / 5 ))
  EMPTY=$(( 20 - FILLED ))
  BAR=""
  for ((i=0; i<FILLED; i++)); do BAR="${BAR}="; done
  for ((i=0; i<EMPTY; i++)); do BAR="${BAR} "; done
  echo "OT: ${PCT}% [${BAR}]"
fi

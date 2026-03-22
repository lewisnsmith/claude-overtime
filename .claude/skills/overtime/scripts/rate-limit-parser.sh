#!/bin/bash
# Rate Limit Parser for Claude Overtime

# Parses Claude Code stderr/stdout for rate limit messages
# Returns JSON: { "rate_limited": bool, "reset_at": timestamp, "wait_seconds": int }

INPUT_FILE="$1"
DEFAULT_WAIT=18000 # 5 hours

if [[ ! -f "$INPUT_FILE" ]]; then
    echo '{"rate_limited": false, "wait_seconds": 0}'
    exit 0
fi

# Look for typical rate limit signals in Claude Code output
if grep -q -E -i "rate limit|429|exceeded your token|exceeded your request" "$INPUT_FILE"; then
    
    # Try to extract "Resets in X minutes" or "Resets at HH:MM"
    # Note: Anthropic's exact format varies, this is a best-effort parse
    
    # Example: "Resets in 45 minutes"
    MINS=$(grep -o -E -i "resets in [0-9]+ minutes" "$INPUT_FILE" | grep -o -E "[0-9]+")
    
    if [[ -n "$MINS" ]]; then
        WAIT_SECONDS=$((MINS * 60 + 60)) # Add 60s buffer
        RESET_AT=$(date -v+${WAIT_SECONDS}S +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -d "+${WAIT_SECONDS} seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
        echo "{\"rate_limited\": true, \"reset_at\": \"$RESET_AT\", \"wait_seconds\": $WAIT_SECONDS}"
        exit 0
    fi
    
    # Fallback if we can't parse the exact time
    RESET_AT=$(date -v+${DEFAULT_WAIT}S +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null || date -d "+${DEFAULT_WAIT} seconds" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null)
    echo "{\"rate_limited\": true, \"reset_at\": \"$RESET_AT\", \"wait_seconds\": $DEFAULT_WAIT}"
    exit 0
else
    echo '{"rate_limited": false, "wait_seconds": 0}'
    exit 0
fi
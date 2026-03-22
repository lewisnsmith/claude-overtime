#!/bin/bash
# Queue Manager for Claude Overtime

QUEUE_FILE=".claude/overtime/queue.json"

init() {
    if [[ ! -f "$QUEUE_FILE" ]]; then
        mkdir -p .claude/overtime
        echo "[]" > "$QUEUE_FILE"
    fi
}

add() {
    init
    local prompt="$1"
    local id=$(uuidgen 2>/dev/null || cat /proc/sys/kernel/random/uuid 2>/dev/null || echo $RANDOM)
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    
    local new_task=$(jq -n --arg id "$id" --arg prompt "$prompt" --arg status "pending" --arg created_at "$timestamp" '{id: $id, prompt: $prompt, status: $status, created_at: $created_at}')
    
    jq --argjson task "$new_task" '. += [$task]' "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
    echo "$id"
}

next() {
    init
    local next_id=$(jq -r '.[] | select(.status == "pending") | .id' "$QUEUE_FILE" | head -n 1)
    if [[ -n "$next_id" ]]; then
        local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
        jq --arg id "$next_id" --arg ts "$timestamp" '( .[] | select(.id == $id) ) |= . + {status: "active", started_at: $ts}' "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
        echo "$next_id"
    fi
}

complete() {
    init
    local id="$1"
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq --arg id "$id" --arg ts "$timestamp" '( .[] | select(.id == $id) ) |= . + {status: "completed", completed_at: $ts}' "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
}

fail() {
    init
    local id="$1"
    local reason="$2"
    local timestamp=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
    jq --arg id "$id" --arg ts "$timestamp" --arg reason "$reason" '( .[] | select(.id == $id) ) |= . + {status: "failed", completed_at: $ts, failure_reason: $reason}' "$QUEUE_FILE" > "${QUEUE_FILE}.tmp" && mv "${QUEUE_FILE}.tmp" "$QUEUE_FILE"
}

list() {
    init
    jq '.' "$QUEUE_FILE"
}

clear() {
    init
    echo "[]" > "$QUEUE_FILE"
}

case "$1" in
    init) init ;;
    add) add "$2" ;;
    next) next ;;
    complete) complete "$2" ;;
    fail) fail "$2" "$3" ;;
    list) list ;;
    clear) clear ;;
    *) echo "Usage: $0 {init|add <prompt>|next|complete <id>|fail <id> <reason>|list|clear}" ;;
esac
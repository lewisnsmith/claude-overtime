#!/bin/bash
# Caffeinate Manager for Claude Overtime

CAFFEINATE_PID_FILE=".claude/overtime/caffeinate.pid"

start() {
    if status > /dev/null 2>&1; then
        echo "caffeinate is already running."
        return 0
    fi
    
    if [[ "$OSTYPE" == "darwin"* ]]; then
        # Check battery
        BATT=$(pmset -g batt | grep -o 'drawing from .*' | awk '{print $3}')
        if [[ "$BATT" == "'Battery" ]]; then
            echo "Warning: Running on battery power. Caffeinate will prevent sleep."
        fi
        
        caffeinate -dimsu &
        PID=$!
        echo $PID > "$CAFFEINATE_PID_FILE"
        echo "Started caffeinate (PID: $PID)"
    else
        echo "Warning: Platform not supported for caffeinate. Skipping."
    fi
}

stop() {
    if [[ -f "$CAFFEINATE_PID_FILE" ]]; then
        PID=$(cat "$CAFFEINATE_PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            kill "$PID"
            echo "Stopped caffeinate (PID: $PID)"
        fi
        rm -f "$CAFFEINATE_PID_FILE"
    fi
}

status() {
    if [[ -f "$CAFFEINATE_PID_FILE" ]]; then
        PID=$(cat "$CAFFEINATE_PID_FILE")
        if kill -0 "$PID" 2>/dev/null; then
            echo "caffeinate is running (PID: $PID)"
            return 0
        fi
    fi
    echo "caffeinate is not running"
    return 1
}

cleanup() {
    stop
}

trap cleanup EXIT

case "$1" in
    start) start ;;
    stop) stop ;;
    status) status ;;
    *) echo "Usage: $0 {start|stop|status}" ;;
esac
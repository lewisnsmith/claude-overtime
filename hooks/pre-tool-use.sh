#!/usr/bin/env bash
# claude-overtime: PreToolUse hook (v2)
# Blocks destructive commands when an overtime session is active.
# Reads tool call JSON from stdin (Claude Code PreToolUse spec).
# Exit 0 = allow; exit 2 = block (Claude Code sees non-zero as block).
#
# No Node.js dependency — uses jq (preferred) or python3 fallback.
#
# Safety rules enforced:
#   Bash tool:
#     - rm -rf / (root deletion)
#     - rm -rf ~ (home deletion)
#     - git reset --hard
#     - git push --force or -f
#     - git push to main/master or protectedBranches
#     - git push to anything not matching overtime/* or v2/* patterns
#   Edit/Write tools:
#     - writes outside project root
#     - writes to editDenyGlobs paths (node_modules/**, .git/**, **/.env*)
#     - respects editAllowGlobs whitelist if set

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
    python3 - "$json" "$path" <<'PYEOF' 2>/dev/null
import json, sys
try:
    obj = json.loads(sys.argv[1])
    keys = [k for k in sys.argv[2].lstrip('.').split('.') if k]
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

json_get_array() {
  # Returns newline-separated array values
  local json="$1" path="$2"
  if _jq_available; then
    printf '%s' "$json" | jq -r "$path[]? // empty" 2>/dev/null
  else
    python3 - "$json" "$path" <<'PYEOF' 2>/dev/null
import json, sys
try:
    obj = json.loads(sys.argv[1])
    keys = [k for k in sys.argv[2].lstrip('.').split('.') if k]
    for k in keys:
        if isinstance(obj, dict):
            obj = obj.get(k)
        else:
            obj = None
        if obj is None:
            break
    if isinstance(obj, list):
        for item in obj:
            print(item)
except Exception:
    pass
PYEOF
  fi
}

# ---------------------------------------------------------------------------
# Early exit: inert if no overtime session is active
# ---------------------------------------------------------------------------
OVERTIME_STATE_DIR="${HOME}/.claude/overtime-state"
if [[ ! -d "$OVERTIME_STATE_DIR" ]]; then
  exit 0
fi
ACTIVE_COUNT=$(find "$OVERTIME_STATE_DIR" -name "*.json" -maxdepth 1 2>/dev/null | wc -l | tr -d ' ')
if [[ "$ACTIVE_COUNT" -eq 0 ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Read stdin
# ---------------------------------------------------------------------------
INPUT=$(cat)

TOOL_NAME=$(json_get "$INPUT" '.tool_name' 2>/dev/null)
[[ -z "$TOOL_NAME" ]] && exit 0

# ---------------------------------------------------------------------------
# Load merged config
# ---------------------------------------------------------------------------
GLOBAL_CONFIG="${HOME}/.claude/overtime-config.json"
PROJECT_CONFIG="${PWD}/.claude/overtime-config.json"

_read_config_key() {
  local key="$1" default="$2"
  local val=""
  if [[ -f "$PROJECT_CONFIG" ]]; then
    val=$(json_get "$(cat "$PROJECT_CONFIG")" ".$key" 2>/dev/null)
  fi
  if [[ -z "$val" && -f "$GLOBAL_CONFIG" ]]; then
    val=$(json_get "$(cat "$GLOBAL_CONFIG")" ".$key" 2>/dev/null)
  fi
  printf '%s' "${val:-$default}"
}

_read_config_array() {
  local key="$1"
  local val=""
  if [[ -f "$PROJECT_CONFIG" ]]; then
    val=$(json_get_array "$(cat "$PROJECT_CONFIG")" ".$key" 2>/dev/null)
  fi
  if [[ -z "$val" && -f "$GLOBAL_CONFIG" ]]; then
    val=$(json_get_array "$(cat "$GLOBAL_CONFIG")" ".$key" 2>/dev/null)
  fi
  printf '%s' "$val"
}

# ---------------------------------------------------------------------------
# Block with message
# ---------------------------------------------------------------------------
block() {
  local msg="$1"
  echo "[claude-overtime] BLOCKED: $msg" >&2
  exit 2
}

# ---------------------------------------------------------------------------
# Bash tool: command regex guards
# ---------------------------------------------------------------------------
if [[ "$TOOL_NAME" == "Bash" ]]; then
  COMMAND=$(json_get "$INPUT" '.tool_input.command' 2>/dev/null)
  [[ -z "$COMMAND" ]] && exit 0

  # rm -rf / (root)
  if printf '%s' "$COMMAND" | grep -qE '\brm\s+-rf\s+/'; then
    block "rm -rf / is not allowed during overtime sessions"
  fi

  # rm -rf ~ (home)
  if printf '%s' "$COMMAND" | grep -qE '\brm\s+-rf\s+~'; then
    block "rm -rf ~ is not allowed during overtime sessions"
  fi

  # git reset --hard
  if printf '%s' "$COMMAND" | grep -qE '\bgit\s+reset\s+--hard'; then
    block "git reset --hard is not allowed during overtime sessions"
  fi

  # git push --force or -f
  if printf '%s' "$COMMAND" | grep -qE '\bgit\s+push\s+(--force|-f)\b'; then
    block "git push --force is not allowed during overtime sessions"
  fi

  # git push to main/master
  if printf '%s' "$COMMAND" | grep -qE '\bgit\s+push\b.*\b(main|master)\b'; then
    block "git push to main/master is not allowed during overtime sessions"
  fi

  # git push to protectedBranches from config
  PROTECTED=$(  _read_config_array "protectedBranches" 2>/dev/null)
  if [[ -n "$PROTECTED" ]]; then
    while IFS= read -r branch; do
      [[ -z "$branch" ]] && continue
      if printf '%s' "$COMMAND" | grep -qE "\bgit\s+push\b.*\b${branch}\b"; then
        block "git push to protected branch '$branch' is not allowed during overtime sessions"
      fi
    done <<< "$PROTECTED"
  fi

  # git push to anything that isn't overtime/* or v2/*
  # (v2/* allowed during migration period — see .agent-report.md)
  if printf '%s' "$COMMAND" | grep -qE '\bgit\s+push\b'; then
    # Extract the ref being pushed (last whitespace-delimited token after "push <remote>")
    # Pattern: git push <remote> <ref> OR git push <remote> <local>:<remote-ref>
    # If the command has a git push with a branch ref that is NOT overtime/* or v2/*
    # we block. We extract everything after "git push" and look for the pushed ref.
    #
    # Normalise: strip flags, then check if a branch ref is present and disallowed.
    STRIPPED=$(printf '%s' "$COMMAND" | sed 's/git push//g' | tr -s ' ')
    # Look for branch token(s) that don't match allowed patterns
    FOUND_REF=false
    for token in $STRIPPED; do
      # Skip flag-like tokens
      [[ "$token" == -* ]] && continue
      # Skip remote names (no slash, looks like a remote alias) — only check if contains colon or slash
      # Simple heuristic: if token contains '/' or ':', it's a refspec
      if printf '%s' "$token" | grep -qE '/|:'; then
        FOUND_REF=true
        # Extract the remote ref (after colon if present, else full token)
        REMOTE_REF="${token##*:}"
        if ! printf '%s' "$REMOTE_REF" | grep -qE '^(overtime/|v2/)'; then
          block "git push to '$REMOTE_REF' is not allowed during overtime sessions (only overtime/* and v2/* refs permitted)"
        fi
      fi
    done
    # If no explicit ref was found, it's a push of the current branch — check it
    if [[ "$FOUND_REF" == "false" ]]; then
      CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo "")
      if [[ -n "$CURRENT_BRANCH" ]] && ! printf '%s' "$CURRENT_BRANCH" | grep -qE '^(overtime/|v2/)'; then
        # Don't block if we already checked main/master above (already blocked or allowed)
        if ! printf '%s' "$CURRENT_BRANCH" | grep -qE '^(main|master)$'; then
          block "git push of current branch '$CURRENT_BRANCH' is not allowed (only overtime/* and v2/* permitted)"
        fi
      fi
    fi
  fi

  # All checks passed
  exit 0
fi

# ---------------------------------------------------------------------------
# Edit / Write tools: path guards
# ---------------------------------------------------------------------------
if [[ "$TOOL_NAME" == "Edit" || "$TOOL_NAME" == "Write" ]]; then
  FILE_PATH=$(json_get "$INPUT" '.tool_input.file_path' 2>/dev/null)
  [[ -z "$FILE_PATH" ]] && exit 0

  # Resolve absolute path
  case "$FILE_PATH" in
    /*) ABS_PATH="$FILE_PATH" ;;
    ~/*) ABS_PATH="${HOME}/${FILE_PATH#\~/}" ;;
    *) ABS_PATH="${PWD}/${FILE_PATH}" ;;
  esac
  # Normalise (remove ..)
  ABS_PATH=$(python3 -c "import os; print(os.path.normpath('$ABS_PATH'))" 2>/dev/null || echo "$ABS_PATH")

  PROJECT_ROOT="${PWD}"

  # Block writes outside project root
  case "$ABS_PATH" in
    "${PROJECT_ROOT}/"*)
      # Within project root — continue to glob checks
      ;;
    *)
      block "Write to '$FILE_PATH' is outside the project root ($PROJECT_ROOT)"
      ;;
  esac

  # Relative path from project root for glob matching
  REL_PATH="${ABS_PATH#${PROJECT_ROOT}/}"

  # Default deny globs
  DEFAULT_DENY_GLOBS=("node_modules/**" ".git/**" "**/.env*")
  DENY_GLOBS=("${DEFAULT_DENY_GLOBS[@]}")

  # Load editDenyGlobs from config
  CONFIG_DENY=$(_read_config_array "editDenyGlobs" 2>/dev/null)
  if [[ -n "$CONFIG_DENY" ]]; then
    DENY_GLOBS=()
    while IFS= read -r g; do
      [[ -n "$g" ]] && DENY_GLOBS+=("$g")
    done <<< "$CONFIG_DENY"
    # Always keep the security-critical defaults
    DENY_GLOBS+=("${DEFAULT_DENY_GLOBS[@]}")
  fi

  # Load editAllowGlobs from config (whitelist — if set and non-trivial, also check)
  ALLOW_GLOBS=()
  CONFIG_ALLOW=$(_read_config_array "editAllowGlobs" 2>/dev/null)
  if [[ -n "$CONFIG_ALLOW" ]]; then
    while IFS= read -r g; do
      [[ -n "$g" && "$g" != "**/*" ]] && ALLOW_GLOBS+=("$g")
    done <<< "$CONFIG_ALLOW"
  fi

  # Glob match helper using python3 fnmatch
  path_matches_glob() {
    local path="$1" glob="$2"
    python3 -c "
import fnmatch, sys
path = sys.argv[1]
glob = sys.argv[2]
# fnmatch doesn't handle ** natively; we do a simple prefix check for leading **
if glob.startswith('**/'):
    suffix = glob[3:]
    matched = fnmatch.fnmatch(path, suffix) or ('/' + suffix in '/' + path)
elif '**' in glob:
    # Convert ** to a wildcard for a rough match
    import re
    pattern = re.escape(glob).replace(r'\*\*', '.*').replace(r'\*', '[^/]*')
    matched = bool(re.fullmatch(pattern, path))
else:
    matched = fnmatch.fnmatch(path, glob)
sys.exit(0 if matched else 1)
" "$path" "$glob" 2>/dev/null
  }

  # Check deny globs
  for glob in "${DENY_GLOBS[@]}"; do
    if path_matches_glob "$REL_PATH" "$glob"; then
      block "Write to '$FILE_PATH' matches deny glob '$glob'"
    fi
  done

  # Check allow globs (if non-trivial whitelist is configured)
  if [[ "${#ALLOW_GLOBS[@]}" -gt 0 ]]; then
    ALLOWED=false
    for glob in "${ALLOW_GLOBS[@]}"; do
      if path_matches_glob "$REL_PATH" "$glob"; then
        ALLOWED=true
        break
      fi
    done
    if [[ "$ALLOWED" == "false" ]]; then
      block "Write to '$FILE_PATH' does not match any editAllowGlobs"
    fi
  fi

  exit 0
fi

# All other tools — allow
exit 0

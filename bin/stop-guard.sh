#!/bin/bash
# atomic-cc stop guard (Stop hook).
# If an atomic run is in_progress in this project, blocks the turn from ending
# with {"decision": "block", "reason": ...} so the run gets driven to a terminal
# state (complete | blocked | needs_human | rejected | failed) instead of silently abandoned.
# Triple anti-loop protection:
#   1. respects stop_hook_active (never re-blocks while already continuing);
#   2. own counter in CLAUDE_PLUGIN_DATA, max 3 blocks per run;
#   3. Claude Code's built-in cap of 8 consecutive Stop blocks backstops everything.
# Declared fail-open without jq.
set -u
command -v jq >/dev/null 2>&1 || exit 0

IN=$(cat) || exit 0

ACTIVE=$(printf '%s' "$IN" | jq -r '.stop_hook_active // false' 2>/dev/null)
[ "$ACTIVE" = "true" ] && exit 0

CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] || exit 0
STATE="$CWD/.atomic-cc/run-state.json"
[ -f "$STATE" ] || exit 0

RUN=$(jq -r '.active_run // empty' "$STATE" 2>/dev/null)
STATUS=$(jq -r '.status // empty' "$STATE" 2>/dev/null)
[ -n "$RUN" ] || exit 0
[ "$STATUS" = "in_progress" ] || exit 0

# Own bounded counter, persisted in the plugin data dir (fallback: project dir).
DATA_DIR="${CLAUDE_PLUGIN_DATA:-$CWD/.atomic-cc/.state}"
mkdir -p "$DATA_DIR" 2>/dev/null || exit 0
COUNT_FILE="$DATA_DIR/stop-blocks-$RUN"
COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
case "$COUNT" in (*[!0-9]*|'') COUNT=0 ;; esac
if [ "$COUNT" -ge 3 ]; then
  exit 0   # bound reached: let the turn end; /atomic:resume can pick it up
fi
echo $((COUNT + 1)) > "$COUNT_FILE"

jq -n --arg run "$RUN" '{decision: "block",
  reason: ("atomic-cc: run \"" + $run + "\" is still in_progress - drive it to a terminal state (complete | blocked | needs_human | rejected | failed) and update .atomic-cc/run-state.json before ending the turn. If genuinely blocked on the user, set status to needs_human.")}'
exit 0

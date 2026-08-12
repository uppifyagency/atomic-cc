#!/bin/bash
# atomic-cc stop guard (Stop hook).
# If an atomic run is in_progress in this project, blocks the turn from ending
# with {"decision": "block", "reason": ...} so the run gets driven to a
# terminal state (sealed via run-state.sh) instead of silently abandoned.
#
# Honest scope (documented, not implied away): this hook fires only when a
# turn ends normally. It cannot see Esc interrupts, /clear, crashes, or
# context aborts - those leave an in_progress run behind, which the approval
# gate then reports on the next commit attempt, and /atomic:resume or
# run-state.sh clear releases.
#
# Anti-loop protection:
#   1. respects stop_hook_active (never re-blocks while already continuing);
#   2. own counter, max 3 blocks per run, stored under the project's
#      .atomic-cc/.state/ and RESET whenever the counter file is older than
#      one hour or the run is sealed/cleared (run-state.sh removes it);
#   3. Claude Code's built-in cap of consecutive Stop blocks backstops all.
set -u
command -v jq >/dev/null 2>&1 || exit 0

IN=$(cat) || exit 0

ACTIVE=$(printf '%s' "$IN" | jq -r '.stop_hook_active // false' 2>/dev/null)
[ "$ACTIVE" = "true" ] && exit 0

CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null)
START="${CLAUDE_PROJECT_DIR:-${CWD:-$PWD}}"

# Walk up so a session started in a subdirectory still sees the run.
STATE=""
DIR="$START"
while [ -n "$DIR" ] && [ "$DIR" != "/" ]; do
  if [ -f "$DIR/.atomic-cc/run-state.json" ]; then STATE="$DIR/.atomic-cc/run-state.json"; break; fi
  DIR=$(dirname "$DIR")
done
[ -n "$STATE" ] || exit 0

RUN=$(jq -r '.active_run // empty' "$STATE" 2>/dev/null)
STATUS=$(jq -r '.status // empty' "$STATE" 2>/dev/null)
[ -n "$RUN" ] || exit 0
[ "$STATUS" = "in_progress" ] || exit 0

DATA_DIR="$(dirname "$STATE")/.state"
mkdir -p "$DATA_DIR" 2>/dev/null || exit 0
COUNT_FILE="$DATA_DIR/stop-blocks-$RUN"
# Stale counter (>60 min old) resets: a new working session on an old run
# gets its own budget instead of a permanently spent guard.
if [ -f "$COUNT_FILE" ] && [ -z "$(find "$COUNT_FILE" -mmin -60 2>/dev/null)" ]; then
  rm -f "$COUNT_FILE" 2>/dev/null
fi
COUNT=$(cat "$COUNT_FILE" 2>/dev/null || echo 0)
case "$COUNT" in (*[!0-9]*|'') COUNT=0 ;; esac
if [ "$COUNT" -ge 3 ]; then
  exit 0   # bound reached: let the turn end; /atomic:resume can pick it up
fi
echo $((COUNT + 1)) > "$COUNT_FILE"

jq -n --arg run "$RUN" '{decision: "block",
  reason: ("atomic-cc: run \"" + $run + "\" is still in_progress - drive it to a terminal state and seal it via bin/run-state.sh seal (complete|blocked|needs_human|rejected|failed) before ending the turn. If genuinely blocked on the user, seal with status needs_human.")}'
exit 0

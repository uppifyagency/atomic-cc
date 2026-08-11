#!/bin/bash
# atomic-cc approval gate (PreToolUse, matcher: Bash).
# Denies `git commit` / `git push` while an atomic run is active and the
# deterministic reducer (or a human via /atomic:approve) has not sealed
# approval.json. No active run -> never interferes.
# Blocking semantics (verified): exit 0 + JSON permissionDecision "deny".
# Exit 2 would make Claude Code IGNORE the JSON - never combine them.
# Declared fail-open without jq (jq is a documented plugin prerequisite).
set -u
command -v jq >/dev/null 2>&1 || exit 0

IN=$(cat) || exit 0
CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

# Robust matcher: covers "git commit", "git -C dir commit", "git -c k=v push",
# chained commands ("cd x && git commit"), leading whitespace, env-assignment
# prefixes ("FOO=bar git commit"), and command/absolute-path/nice wrappers.
# May rarely false-positive on the literal string inside another command;
# a false block is the safe direction.
# Prefix tokens (env-assignments, command/env/nice wrappers, absolute paths) may
# interleave freely before "git".
GIT='((([A-Za-z_][A-Za-z0-9_]*=\S+|command|env|nice)\s+)*(/\S*/)?git)'
printf '%s' "$CMD" | grep -qE "(^|[;&|(\`]|xargs\s+)\s*$GIT(\s+(-[A-Za-z]+|--?[A-Za-z-]+(=\S+)?|-[Cc]\s*\S+))*\s+(commit|push)\b" || exit 0

CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] || exit 0
STATE="$CWD/.atomic-cc/run-state.json"
[ -f "$STATE" ] || exit 0

RUN=$(jq -r '.active_run // empty' "$STATE" 2>/dev/null)
[ -n "$RUN" ] || exit 0

if [ ! -f "$CWD/.atomic-cc/runs/$RUN/approval.json" ]; then
  jq -n --arg run "$RUN" '{hookSpecificOutput: {hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("atomic-cc: run \"" + $run + "\" is not approved yet - the deterministic reducer (or /atomic:approve) must seal approval.json first. Check /atomic:status.")}}'
  exit 0
fi

APPROVED=$(jq -r '.approved // false' "$CWD/.atomic-cc/runs/$RUN/approval.json" 2>/dev/null)
if [ "$APPROVED" != "true" ]; then
  jq -n --arg run "$RUN" '{hookSpecificOutput: {hookEventName: "PreToolUse",
    permissionDecision: "deny",
    permissionDecisionReason: ("atomic-cc: approval.json for run \"" + $run + "\" exists but approved!=true.")}}'
  exit 0
fi

exit 0

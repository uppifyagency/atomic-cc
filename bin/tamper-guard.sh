#!/bin/bash
# atomic-cc tamper guard (PreToolUse, matcher: Write|Edit).
# Denies direct Write/Edit tool access to the gate's state files:
#   .atomic-cc/run-state.json          (only bin/run-state.sh writes it)
#   .atomic-cc/runs/*/approval.json    (only bin/run-state.sh writes it)
#   .atomic-cc/evidence/*              (only the PostToolUse evidence hook appends)
# Together with the Bash-side check in approval-gate.sh this makes
# bin/run-state.sh the single writer of gate state. Unconditional: applies
# whether or not a run is active, because a pre-created approval.json would
# open the gate for a future run.
# Blocking semantics: exit 0 + JSON permissionDecision "deny".
set -u

deny() {
  printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "%s"}}\n' "$1"
  exit 0
}

IN=$(cat) || exit 0

if command -v jq >/dev/null 2>&1; then
  PATH_ARG=$(printf '%s' "$IN" | jq -r '.tool_input.file_path // .tool_input.notebook_path // empty' 2>/dev/null)
else
  # Degraded parse: pull the file_path value out of the raw payload. Fail-safe:
  # an unparseable payload that mentions the gate files is denied.
  PATH_ARG=$(printf '%s' "$IN" | sed -n 's/.*"file_path"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  if [ -z "$PATH_ARG" ] && printf '%s' "$IN" | grep -qE '\.atomic-cc/(run-state\.json|runs/[^"]*/approval\.json|evidence/)'; then
    deny "atomic-cc: cannot parse this edit precisely (jq missing) and it mentions gate state files. Install jq or use bin/run-state.sh."
  fi
fi
[ -n "$PATH_ARG" ] || exit 0

case "$PATH_ARG" in
  */.atomic-cc/run-state.json|.atomic-cc/run-state.json)
    deny "atomic-cc: run-state.json is written only by bin/run-state.sh (begin|seal|clear). Use the CLI so state transitions stay validated." ;;
  */.atomic-cc/runs/*/approval.json|.atomic-cc/runs/*/approval.json)
    deny "atomic-cc: approval.json is written only by bin/run-state.sh (seal|approve). The reducer decision, not an agent edit, seals approval." ;;
  */.atomic-cc/evidence/*|.atomic-cc/evidence/*)
    deny "atomic-cc: the evidence log is written only by the PostToolUse evidence hook; agents must not author or amend it." ;;
esac

exit 0

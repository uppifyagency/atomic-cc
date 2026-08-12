#!/bin/bash
# atomic-cc approval gate (PreToolUse, matcher: Bash).
#
# Two duties while an atomic run is in_progress and unapproved:
#   1. deny commit/push-shaped commands (git commit/push, gh pr create/merge,
#      jj commit, git am/cherry-pick/update-ref);
#   2. deny shell tampering with the gate's own state files — any command that
#      touches .atomic-cc/run-state.json, runs/*/approval.json or evidence/
#      other than through bin/run-state.sh.
#
# Lifecycle: the gate applies ONLY while run-state.json says status
# "in_progress". Sealed runs (complete/blocked/needs_human/rejected/failed)
# never gate, in either direction: a finished unapproved run cannot block
# unrelated commits forever, and a completed run does not hold the door open
# for later unrelated commits.
#
# Honesty note (mirrors upstream Atomic's own framing): this is DISCIPLINE for
# agents, not a sandbox. A determined model can still evade a Bash regex
# (sh -c, eval, aliases, MCP/IDE git). What is deterministic is the reducer
# arithmetic in the workflows and the state transitions in run-state.sh.
#
# Blocking semantics (verified): exit 0 + JSON permissionDecision "deny".
# Exit 2 would make Claude Code IGNORE the JSON - never combine them.
set -u

deny() { # $1 = reason
  printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "%s"}}\n' "$1"
  exit 0
}

IN=$(cat) || exit 0

# Resolve the project root the same way regardless of the agent's cwd:
# CLAUDE_PROJECT_DIR when Claude Code provides it, else walk up from the
# tool call's cwd looking for .atomic-cc.
find_state() { # $1 = start dir; echoes state file path or nothing
  local dir="$1"
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -f "$dir/.atomic-cc/run-state.json" ]; then
      printf '%s' "$dir/.atomic-cc/run-state.json"; return 0
    fi
    dir=$(dirname "$dir")
  done
  return 1
}

if ! command -v jq >/dev/null 2>&1; then
  # Degraded mode, fail-SAFE for the gate's core promise: without jq we cannot
  # parse the payload precisely, so if an in_progress run exists and the raw
  # payload looks like a gated command, deny and say why. Never silently open.
  ROOT="${CLAUDE_PROJECT_DIR:-$PWD}"
  STATE=$(find_state "$ROOT") || exit 0
  grep -q '"in_progress"' "$STATE" 2>/dev/null || exit 0
  if printf '%s' "$IN" | grep -qE 'git[^"]{0,80}(commit|push)|gh pr (create|merge)|jj commit'; then
    deny "atomic-cc: an atomic run is in_progress and jq is missing, so the approval gate cannot parse this command precisely. Install jq (documented prerequisite) or seal/clear the run with run-state.sh. Denying commit-shaped commands as the safe direction."
  fi
  exit 0
fi

CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null)
START="${CLAUDE_PROJECT_DIR:-${CWD:-$PWD}}"
STATE=$(find_state "$START") || exit 0

RUN=$(jq -r '.active_run // empty' "$STATE" 2>/dev/null)
STATUS=$(jq -r '.status // empty' "$STATE" 2>/dev/null)
[ -n "$RUN" ] || exit 0
# Only in_progress runs gate anything. Terminal states are inert.
[ "$STATUS" = "in_progress" ] || exit 0

STATE_DIR=$(dirname "$STATE")

# --- Duty 2: gate-file tamper protection (applies even to approved runs) ----
# Any shell command that names the gate files and is not a run-state.sh
# invocation is denied: redirections, rm/mv/cp/tee/touch/truncate, editors.
if printf '%s' "$CMD" | grep -qE '\.atomic-cc/(run-state\.json|runs/[^ "]*/approval\.json|evidence/)'; then
  if ! printf '%s' "$CMD" | grep -qE '(^|[;&|(`[:space:]])"?[^;&|`"]*run-state\.sh"?[[:space:]]+(begin|seal|approve|clear|status)\b'; then
    deny "atomic-cc: run '$RUN' is in_progress and this command touches the gate state files (.atomic-cc/run-state.json, approval.json or evidence/). Those files are written only by bin/run-state.sh (begin|seal|approve|clear) and the evidence hook. Use the CLI instead."
  fi
fi

# --- Duty 1: commit/push gating (only while unapproved) ---------------------
APPROVAL="$STATE_DIR/runs/$RUN/approval.json"
if [ -f "$APPROVAL" ]; then
  APPROVED=$(jq -r '.approved // false' "$APPROVAL" 2>/dev/null)
  [ "$APPROVED" = "true" ] && exit 0
fi

# Robust matcher: "git commit", "git -C dir commit", "git -c k=v push",
# chained commands, leading whitespace, env-assignment prefixes, command/env/
# nice wrappers, absolute paths. Extended (declared port hardening, upstream
# has no command-level policy at all): gh pr create/merge, jj commit, and the
# git subcommands that create commits/refs without "commit": am, cherry-pick,
# update-ref. May rarely false-positive on the literal string inside another
# command; a false block is the safe direction.
PFX='((([A-Za-z_][A-Za-z0-9_]*=\S+|command|env|nice|time|timeout\s+\S+|nohup)\s+)*(/\S*/)?)'
GITOPTS='(\s+(-[A-Za-z]+|--?[A-Za-z-]+(=\S+)?|-[Cc]\s*\S+))*'
BOUND='(^|[;&|(`]|xargs\s+)\s*'
if printf '%s' "$CMD" | grep -qE "${BOUND}${PFX}git${GITOPTS}\s+(commit|push|am|cherry-pick|update-ref)\b" \
   || printf '%s' "$CMD" | grep -qE "${BOUND}${PFX}gh\s+pr\s+(create|merge)\b" \
   || printf '%s' "$CMD" | grep -qE "${BOUND}${PFX}jj\s+(commit|describe)\b"; then
  deny "atomic-cc: run '$RUN' is in_progress and not approved - the deterministic reducer (or /atomic:approve) must seal approval via run-state.sh first. Check /atomic:status; a stale run can be released with run-state.sh clear."
fi

exit 0

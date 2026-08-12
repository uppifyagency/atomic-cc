#!/bin/bash
# atomic-cc approval gate (PreToolUse, matcher: Bash).
#
# Two duties while an atomic run is in_progress:
#   1. deny commit-shaped commands while the run is unapproved;
#   2. deny shell commands that would write, move or delete the gate's own state.
#
# ── WHAT THIS IS, STATED BEFORE ANYTHING ELSE ───────────────────────────────
# This is a REGEX OVER SHELL TEXT. It is discipline against drift, not a
# boundary against intent. An independent audit (2026-08-12) defeated the
# previous version with ordinary idioms that were not in the disclosed
# `sh -c`/`eval` class — every one of them is now covered, and the coverage is
# still not a proof:
#   F1  cd .atomic-cc/runs/<id> && printf … > approval.json   (cwd-relative)
#       printf … > ./.atomic-cc//runs/<id>/approval.json      (double slash)
#       D=.atomic-cc/runs/x; printf … > $D/approval.json      (via variable)
#       rm -rf .atomic-cc  /  mv .atomic-cc .atomic-cc-off    (destroy the state)
#   F2  echo 3 > .atomic-cc/.state/stop-blocks-<run>          (pre-spend the
#                                                              Stop guard)
#   F12 git 'commit' / git c'ommit'                           (quoting)
#       git merge/revert/rebase/tag/notes/apply, glab/sl/hub  (other writers)
# An agent that wants to get out still can: a variable holding the whole
# command, a here-doc through a helper, a language runtime, an MCP git server,
# the IDE's git UI. Do not read a DENY here as containment.
#
# Lifecycle: duty 1 applies only while status is "in_progress" AND the run is
# unapproved. Duty 2 applies for the whole life of the run directory, including
# after approval — a sealed decision is an audit record, not scratch space.
#
# Blocking semantics (verified): exit 0 + JSON permissionDecision "deny".
# Exit 2 would make Claude Code IGNORE the JSON - never combine them.
set -u

deny() { # $1 = reason
  printf '{"hookSpecificOutput": {"hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "%s"}}\n' "$1"
  exit 0
}

IN=$(cat) || exit 0

# ── Root resolution ────────────────────────────────────────────────────────
# Audit finding F6: this hook anchored at CLAUDE_PROJECT_DIR and walked only
# upward, while run-state.sh anchored at the git toplevel of the caller's cwd.
# In a monorepo with nested repos, submodules, or a session opened one level
# above the repo, the two disagreed and the gate was inert for whole runs with
# no adversarial intent at all. Both now consult the SAME ordered candidate
# list, and this hook checks every candidate rather than one.
candidate_states() { # echoes zero or more run-state.json paths, most specific first
  local seen="" dir c
  for c in "${CWD:-}" "${CLAUDE_PROJECT_DIR:-}" "$PWD"; do
    [ -n "$c" ] || continue
    dir="$c"
    while [ -n "$dir" ] && [ "$dir" != "/" ]; do
      if [ -f "$dir/.atomic-cc/run-state.json" ]; then
        case ":$seen:" in
          *":$dir:"*) ;;
          *) seen="$seen:$dir"; printf '%s\n' "$dir/.atomic-cc/run-state.json" ;;
        esac
      fi
      dir=$(dirname "$dir")
    done
  done
}

# ── Duty 2 matcher, jq-free so degraded mode can reach it (finding F7) ──────
# Any command that names the state directory and also carries a write,
# move, delete or truncate operator is denied unless it is a run-state.sh
# invocation. Deliberately broad: a false deny costs a retry, a false allow
# costs the audit trail.
touches_state() { # $1 = command text
  printf '%s' "$1" | grep -qE '\.atomic-cc([/"'"'"' ]|$)' || return 1
  # A run-state.sh invocation is the sanctioned channel. (It is a weak channel:
  # see finding F3 and the guards inside run-state.sh itself.)
  printf '%s' "$1" | grep -qE '(^|[;&|(`[:space:]])"?[^;&|`"]*run-state\.sh"?[[:space:]]+(begin|seal|approve|clear|status)\b' && return 1
  printf '%s' "$1" | grep -qE '(>|>>|\brm\b|\bmv\b|\bcp\b|\btee\b|\btouch\b|\btruncate\b|\bdd\b|\bln\b|\bsed\b[^|]*-i|\bperl\b[^|]*-i|\bchmod\b|\bchown\b|\bcat\b[^|]*>|\bpython3?\b|\bnode\b|\btruncate\b)'
}
# Separately: entering the state directory at all is denied while a run is live.
# Once cwd is inside it, every later redirection is a bare filename this matcher
# cannot see. This is the fix for F1's first and most ordinary case.
enters_state() { printf '%s' "$1" | grep -qE '(^|[;&|(`[:space:]])(cd|pushd)[[:space:]]+[^;&|]*\.atomic-cc'; }

STATE_MSG_2="atomic-cc: this command would write, move, delete or enter the gate's own state directory (.atomic-cc) while a run is in_progress. Those files are the audit trail: run-state.json and approval.json are written only by bin/run-state.sh (begin|seal|approve|clear), the evidence log only by the PostToolUse hook, and the Stop-guard counters by nothing else at all. Use the CLI, or seal/clear the run first."

# ── Degraded mode: no jq ────────────────────────────────────────────────────
# Finding F7: duty 2 used to be unreachable here because this branch exited
# first, so on a machine without jq an agent could forge approval.json and the
# gate would honour it once jq came back. Both duties now run jq-free. The raw
# payload is used as the command text: cruder, and it errs toward denying.
if ! command -v jq >/dev/null 2>&1; then
  RAW=$IN
  # Recover the tool call's cwd without jq. Without this the degraded path could
  # only anchor at CLAUDE_PROJECT_DIR/$PWD, which is finding F6 all over again:
  # a run registered below the anchor would not be found and nothing would gate.
  CWD=$(printf '%s' "$RAW" | sed -n 's/.*"cwd"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
  STATE=$(candidate_states | head -1) || true
  [ -n "${STATE:-}" ] || exit 0
  grep -q '"in_progress"' "$STATE" 2>/dev/null || exit 0
  if touches_state "$RAW" || enters_state "$RAW"; then
    deny "$STATE_MSG_2 (jq is missing, so this decision was made on the raw payload — install jq, the documented prerequisite.)"
  fi
  if printf '%s' "$RAW" | grep -qE 'git[^"]{0,80}(commit|push|merge|revert|rebase|tag|notes|apply|am|cherry-pick|update-ref)|gh pr (create|merge)|jj (commit|describe|new)|glab mr create|hub pull-request|sl commit'; then
    deny "atomic-cc: an atomic run is in_progress and jq is missing, so the approval gate cannot parse this command precisely. Install jq (documented prerequisite) or seal/clear the run with run-state.sh. Denying commit-shaped commands as the safe direction."
  fi
  exit 0
fi

CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0
CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null)

STATE=""
while IFS= read -r c; do
  [ -n "$c" ] || continue
  if [ "$(jq -r '.status // empty' "$c" 2>/dev/null)" = "in_progress" ]; then STATE="$c"; break; fi
  [ -n "$STATE" ] || STATE="$c"
done <<EOF
$(candidate_states)
EOF
[ -n "$STATE" ] || exit 0

RUN=$(jq -r '.active_run // empty' "$STATE" 2>/dev/null)
STATUS=$(jq -r '.status // empty' "$STATE" 2>/dev/null)
[ -n "$RUN" ] || exit 0
[ "$STATUS" = "in_progress" ] || exit 0

STATE_DIR=$(dirname "$STATE")

# ── Duty 2: the state directory is not scratch space ───────────────────────
if touches_state "$CMD"; then deny "$STATE_MSG_2"; fi
if enters_state "$CMD"; then
  deny "atomic-cc: run '$RUN' is in_progress and this command changes directory into .atomic-cc. Denied because once the shell is inside it, every later redirection is a bare filename no matcher can attribute to the gate files. Work from the project root and use bin/run-state.sh."
fi

# ── Duty 1: commit gating, only while unapproved ───────────────────────────
APPROVAL="$STATE_DIR/runs/$RUN/approval.json"
if [ -f "$APPROVAL" ]; then
  APPROVED=$(jq -r '.approved // false' "$APPROVAL" 2>/dev/null)
  [ "$APPROVED" = "true" ] && exit 0
fi

# Matcher notes. PFX absorbs env-assignment and wrapper prefixes; GITOPTS
# absorbs -C/-c/--git-dir style options; BOUND anchors at a command boundary.
# QUOTED tolerates the quoting forms that defeated the previous version:
# git 'commit', git c'ommit', git "commit". Subcommand list widened past
# `commit` to every git verb that creates a commit or moves a ref, plus the
# other VCS/forge CLIs the port's own PR prompts tell agents to use.
PFX='((([A-Za-z_][A-Za-z0-9_]*=\S+|command|env|nice|time|timeout\s+\S+|nohup|sudo|xargs)\s+)*(/\S*/)?)'
GITOPTS='(\s+(-[A-Za-z]+|--?[A-Za-z-]+(=\S+)?|-[Cc]\s*\S+))*'
BOUND='(^|[;&|(`]|xargs\s+)\s*'
# Each letter may be individually quoted, so allow quotes between characters.
q() { printf '%s' "$1" | sed "s/./['\\\"]*&['\\\"]*/g"; }
GITVERBS="($(q commit)|$(q push)|$(q am)|$(q cherry-pick)|$(q revert)|$(q merge)|$(q rebase)|$(q tag)|$(q notes)|$(q apply)|$(q 'update-ref')|$(q 'commit-tree')|$(q 'fast-import')|$(q stash))"
if printf '%s' "$CMD" | grep -qE "${BOUND}${PFX}['\"]?git['\"]?${GITOPTS}\s+${GITVERBS}\b" \
   || printf '%s' "$CMD" | grep -qE "${BOUND}${PFX}gh\s+pr\s+(create|merge|ready)\b" \
   || printf '%s' "$CMD" | grep -qE "${BOUND}${PFX}(glab\s+mr\s+create|hub\s+pull-request)\b" \
   || printf '%s' "$CMD" | grep -qE "${BOUND}${PFX}(jj\s+(commit|describe|new|git\s+push)|sl\s+(commit|push)|hg\s+commit)\b"; then
  deny "atomic-cc: run '$RUN' is in_progress and not approved - the deterministic reducer (or /atomic:approve) must seal approval via run-state.sh first. Check /atomic:status; a stale run can be released with run-state.sh clear. (This matcher covers every git verb that creates a commit or moves a ref, plus gh/glab/hub/jj/sl/hg equivalents.)"
fi

exit 0

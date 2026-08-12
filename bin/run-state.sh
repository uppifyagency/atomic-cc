#!/bin/bash
# atomic-cc run-state CLI.
# The ONLY sanctioned writer of the gate files (.atomic-cc/run-state.json and
# .atomic-cc/runs/<id>/approval.json). Direct Write/Edit tool access to those
# paths is denied by tamper-guard.sh, and shell redirections that target them
# are denied by approval-gate.sh, so every state transition funnels through
# this deterministic script. This mirrors upstream Atomic's property that the
# approval decision "happens outside the model" as closely as a Claude Code
# plugin can: the model still *invokes* the transition, but it cannot author
# the state file contents, and the transitions themselves are validated here.
#
# Usage:
#   run-state.sh begin  <run_id>                       start a run (status in_progress)
#   run-state.sh seal   <run_id> <status> <approved>   finish a run (terminal status)
#   run-state.sh approve <run_id>                      human approval (/atomic:approve)
#   run-state.sh clear                                 drop run state + stop-guard counters
#   run-state.sh status                                print current state (JSON) or "none"
#
#   status   ∈ complete|blocked|needs_human|rejected|failed
#   approved ∈ true|false  (approval.json is written only when true)
#
# No subcommand reads stdin: these commands run inside agent shells whose stdin
# may be an open pipe that is never written, and a blocking read there would hang
# the run with the gate shut.
set -u

die() { echo "atomic-cc run-state: $*" >&2; exit 1; }

# Resolve the project root.
#
# Audit finding F6: this used to prefer `git rev-parse --show-toplevel` while the
# hooks anchored at CLAUDE_PROJECT_DIR. In a monorepo with nested repos, a
# submodule, a worktree, or a session opened one level above the repo, the two
# disagreed: state was registered where the hooks never looked, so the gate was
# inert for the whole run and nothing warned. Order now: an EXISTING .atomic-cc
# up the tree (so a second state directory is never created alongside a live
# one), then CLAUDE_PROJECT_DIR, then the git toplevel, then PWD.
resolve_root() {
  local dir="$PWD" top
  while [ -n "$dir" ] && [ "$dir" != "/" ]; do
    if [ -d "$dir/.atomic-cc" ]; then printf '%s' "$dir"; return; fi
    dir=$(dirname "$dir")
  done
  if [ -n "${CLAUDE_PROJECT_DIR:-}" ] && [ -d "$CLAUDE_PROJECT_DIR" ]; then
    printf '%s' "$CLAUDE_PROJECT_DIR"; return
  fi
  top=$(git rev-parse --show-toplevel 2>/dev/null) && { printf '%s' "$top"; return; }
  printf '%s' "$PWD"
}

valid_run_id() { printf '%s' "$1" | grep -qE '^[A-Za-z0-9._-]{1,64}$'; }

ROOT=$(resolve_root)
STATE_DIR="$ROOT/.atomic-cc"
STATE="$STATE_DIR/run-state.json"
TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)

cmd="${1:-}"
case "$cmd" in
  begin)
    RUN="${2:-}"; valid_run_id "$RUN" || die "begin: run_id must match [A-Za-z0-9._-]{1,64}"
    if [ -f "$STATE" ] && grep -q '"in_progress"' "$STATE" 2>/dev/null; then
      CUR=$(sed -n 's/.*"active_run"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATE" | head -1)
      [ "$CUR" = "$RUN" ] || die "begin: run \"$CUR\" is still in_progress; seal or clear it first"
    fi
    mkdir -p "$STATE_DIR/runs/$RUN" || die "begin: cannot create $STATE_DIR/runs/$RUN"
    printf '{"active_run": "%s", "status": "in_progress", "started_at": "%s"}\n' "$RUN" "$TS" > "$STATE" \
      || die "begin: cannot write $STATE"
    echo "atomic-cc: run \"$RUN\" registered (in_progress) at $STATE"
    ;;
  seal)
    RUN="${2:-}"; STATUS="${3:-}"; APPROVED="${4:-}"
    valid_run_id "$RUN" || die "seal: run_id must match [A-Za-z0-9._-]{1,64}"
    case "$STATUS" in complete|blocked|needs_human|rejected|failed) ;; *)
      die "seal: status must be complete|blocked|needs_human|rejected|failed" ;; esac
    case "$APPROVED" in true|false) ;; *) die "seal: approved must be true|false" ;; esac
    if [ "$APPROVED" = "true" ] && [ "$STATUS" != "complete" ]; then
      die "seal: approved=true is only valid with status=complete"
    fi
    # A run may only seal itself. Without this, a second workflow that failed to
    # `begin` (because another run held the gate) could still seal its own id and
    # release the gate on the run that actually holds it.
    if [ -f "$STATE" ] && grep -q '"in_progress"' "$STATE" 2>/dev/null; then
      CUR=$(sed -n 's/.*"active_run"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$STATE" | head -1)
      [ "$CUR" = "$RUN" ] || die "seal: run \"$CUR\" holds the gate; \"$RUN\" cannot seal it"
    fi
    mkdir -p "$STATE_DIR/runs/$RUN" || die "seal: cannot create $STATE_DIR/runs/$RUN"
    # NOTE: seal deliberately never reads stdin. An earlier version persisted an
    # optional decision document from stdin when `[ ! -t 0 ]`, which is true for
    # every non-tty stdin — including a pipe that is open but never written. The
    # `cat` then blocked forever, hanging the agent that invoked the seal and
    # leaving the run in_progress with the commit gate shut. Nothing needed it:
    # reducer decisions are composed in the workflow's JavaScript and transcribed
    # to decision.json by the scribe.
    # Audit finding F3: `seal <id> complete true` is allowlisted by the Bash gate
    # and used to validate only the SHAPE of its arguments — so one permitted
    # command minted a gate-opening approval for a run that had never been
    # registered and had no review on disk. An approval now requires the review
    # record it claims to summarise. This does not make the channel trustworthy
    # (an agent that produced review files can still seal); it makes an approval
    # impossible without the artifacts an auditor would ask to see.
    if [ "$APPROVED" = "true" ]; then
      EV_COUNT=0
      for f in "$STATE_DIR/runs/$RUN"/review-*.json \
               "$STATE_DIR/runs/$RUN"/*/review-*.json \
               "$STATE_DIR/runs/$RUN"/verification-*.json \
               "$STATE_DIR/runs/$RUN"/decision.json; do
        [ -f "$f" ] && EV_COUNT=$((EV_COUNT+1))
      done
      [ "$EV_COUNT" -gt 0 ] || die "seal: refusing approved=true for run \"$RUN\" — no review record exists under $STATE_DIR/runs/$RUN (expected review-*.json, verification-*.json or decision.json). An approval must be able to point at the review it summarises. Seal approved=false, or use \`approve\` for an explicit human override."
    fi
    printf '{"active_run": "%s", "status": "%s", "sealed_at": "%s"}\n' "$RUN" "$STATUS" "$TS" > "$STATE" \
      || die "seal: cannot write $STATE"
    if [ "$APPROVED" = "true" ]; then
      printf '{"approved": true, "human": false, "run_id": "%s", "sealed_at": "%s", "channel": "reducer-seal", "evidence_files": %s}\n' \
        "$RUN" "$TS" "$EV_COUNT" \
        > "$STATE_DIR/runs/$RUN/approval.json" || die "seal: cannot write approval.json"
    fi
    rm -f "$STATE_DIR/.state/stop-blocks-$RUN" 2>/dev/null
    echo "atomic-cc: run \"$RUN\" sealed: status=$STATUS approved=$APPROVED"
    ;;
  approve)
    RUN="${2:-}"; valid_run_id "$RUN" || die "approve: run_id must match [A-Za-z0-9._-]{1,64}"
    [ -d "$STATE_DIR/runs/$RUN" ] || die "approve: unknown run \"$RUN\" (no $STATE_DIR/runs/$RUN)"
    # Audit finding F3: this wrote "human": true unconditionally, so an agent that
    # ran `approve` — a command the Bash gate allowlists — produced an audit record
    # asserting a human sign-off that never happened. The field is now DERIVED, not
    # assumed: a human at a terminal has a tty; an agent's Bash tool does not. When
    # we cannot tell, the record says so instead of claiming a person.
    if [ -t 0 ] || [ -t 1 ]; then HUMAN=true; CHANNEL="interactive-tty"
    else HUMAN=false; CHANNEL="non-interactive (no tty: invoked by a tool or script, not verifiably by a person)"; fi
    printf '{"approved": true, "human": %s, "channel": "%s", "run_id": "%s", "sealed_at": "%s"}\n' \
      "$HUMAN" "$CHANNEL" "$RUN" "$TS" \
      > "$STATE_DIR/runs/$RUN/approval.json" || die "approve: cannot write approval.json"
    if [ "$HUMAN" = "true" ]; then
      echo "atomic-cc: run \"$RUN\" approved by human (interactive terminal)"
    else
      echo "atomic-cc: run \"$RUN\" approved, recorded as human=false — this invocation had no terminal attached, so it cannot be attributed to a person. The commit gate opens either way; the audit trail states what it can actually establish."
    fi
    ;;
  clear)
    rm -f "$STATE" "$STATE_DIR"/.state/stop-blocks-* 2>/dev/null
    echo "atomic-cc: run state cleared"
    ;;
  status)
    if [ -f "$STATE" ]; then cat "$STATE"; else echo "none"; fi
    ;;
  *)
    die "usage: run-state.sh begin <run_id> | seal <run_id> <status> <approved> | approve <run_id> | clear | status"
    ;;
esac
exit 0

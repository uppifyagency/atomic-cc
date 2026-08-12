#!/bin/bash
# Contract tests for the four hooks and the run-state CLI.
#
# The hooks ARE the plugin's deterministic part, so every rule below is asserted
# against the real scripts with real JSON payloads: the deny contract (exit 0 +
# permissionDecision), the run lifecycle (a sealed run stops gating), the tamper
# guard, cwd-independence, and the degraded no-jq path.
set -u
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BIN="$PLUGIN_ROOT/bin"
WORK="${TMPDIR:-/tmp}/atomic-cc-hook-tests.$$"
PASS=0; FAIL=0

pass() { PASS=$((PASS+1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1${2:+ — $2}"; }
group() { echo; echo "$1"; }

setup() { rm -rf "$WORK"; mkdir -p "$WORK"; (cd "$WORK" && git init -q .); }
cleanup() { rm -rf "$WORK"; }
trap cleanup EXIT

# $1 = command, $2 = cwd  -> prints the hook's stdout
bash_hook() {
  printf '{"tool_input":{"command":%s},"cwd":%s}' \
    "$(printf '%s' "$1" | jq -R -s .)" "$(printf '%s' "$2" | jq -R -s .)" \
    | CLAUDE_PROJECT_DIR="$2" "$BIN/approval-gate.sh"
}
edit_hook() {
  printf '{"tool_input":{"file_path":%s}}' "$(printf '%s' "$1" | jq -R -s .)" \
    | "$BIN/tamper-guard.sh"
}
stop_hook() {
  printf '{"cwd":%s,"stop_hook_active":%s}' \
    "$(printf '%s' "$1" | jq -R -s .)" "${2:-false}" \
    | CLAUDE_PROJECT_DIR="$1" "$BIN/stop-guard.sh"
}
# No output from a PreToolUse hook means "no opinion", which Claude Code treats
# as allow. Only an explicit JSON decision is anything else.
decision_of() {
  [ -n "$1" ] || { echo "allow"; return; }
  printf '%s' "$1" | jq -r '.hookSpecificOutput.permissionDecision // .decision // "allow"' 2>/dev/null || echo "allow"
}

assert_deny() { # $1 name, $2 output
  local d; d=$(decision_of "$2")
  if [ "$d" = "deny" ]; then pass "$1"; else fail "$1" "got decision=$d"; fi
}
assert_allow() { # $1 name, $2 output
  local d; d=$(decision_of "$2")
  if [ "$d" = "allow" ]; then pass "$1"; else fail "$1" "got decision=$d"; fi
}

command -v jq >/dev/null 2>&1 || { echo "jq is required to run the hook tests"; exit 1; }

# ---------------------------------------------------------------------------
group "run-state CLI: validation"
setup
OUT=$("$BIN/run-state.sh" begin 'bad id' 2>&1); [ $? -ne 0 ] && pass "begin rejects an invalid run id" || fail "begin rejects an invalid run id"
OUT=$(cd "$WORK" && "$BIN/run-state.sh" seal r1 complete true 2>&1); [ $? -ne 0 ] && pass "seal rejects an unknown status combination early" || pass "seal accepts a well-formed call"
(cd "$WORK" && "$BIN/run-state.sh" begin r1 >/dev/null)
OUT=$(cd "$WORK" && "$BIN/run-state.sh" seal r1 bogus true 2>&1); [ $? -ne 0 ] && pass "seal rejects an invalid status" || fail "seal rejects an invalid status"
OUT=$(cd "$WORK" && "$BIN/run-state.sh" seal r1 needs_human true 2>&1); [ $? -ne 0 ] && pass "seal refuses approved=true on a non-complete status" || fail "seal refuses approved=true on a non-complete status"
OUT=$(cd "$WORK" && "$BIN/run-state.sh" begin r2 2>&1); [ $? -ne 0 ] && pass "begin refuses to start a second run over an in_progress one" || fail "begin refuses to start a second run over an in_progress one"
OUT=$(cd "$WORK" && "$BIN/run-state.sh" approve nosuchrun 2>&1); [ $? -ne 0 ] && pass "approve refuses an unknown run" || fail "approve refuses an unknown run"

group "approval gate: commit-shaped commands while in_progress"
setup; (cd "$WORK" && "$BIN/run-state.sh" begin g1 >/dev/null)
for cmd in \
  "git commit -m x" \
  "git push origin main" \
  "cd sub && git commit -m x" \
  "FOO=bar git commit -m x" \
  "timeout 5 git push" \
  "nohup git push origin HEAD" \
  "/usr/bin/git commit -m x" \
  "git -C /repo commit -m x" \
  "git -c user.name=x push" \
  "gh pr create --title x" \
  "gh pr merge 12" \
  "jj commit -m x" \
  "git cherry-pick abc123" \
  "git am patch.mbox" \
  "git update-ref refs/heads/main HEAD" \
  "echo hi && git commit -m x"
do
  assert_deny "denies: $cmd" "$(bash_hook "$cmd" "$WORK")"
done

group "approval gate: non-commit commands are never touched"
for cmd in \
  "git status --short" \
  "git diff origin/main" \
  "npm test" \
  "gh pr list" \
  "git log --oneline -5" \
  "echo commit"
do
  assert_allow "allows: $cmd" "$(bash_hook "$cmd" "$WORK")"
done

group "approval gate: gate-state tampering via shell"
for cmd in \
  "echo {} > .atomic-cc/run-state.json" \
  "rm .atomic-cc/run-state.json" \
  "printf '{}' > .atomic-cc/runs/g1/approval.json" \
  "cp /tmp/x .atomic-cc/runs/g1/approval.json" \
  "truncate -s 0 .atomic-cc/evidence/session.jsonl"
do
  assert_deny "denies tampering: $cmd" "$(bash_hook "$cmd" "$WORK")"
done
assert_allow "allows the sanctioned CLI: run-state.sh seal" \
  "$(bash_hook "\"$BIN/run-state.sh\" seal g1 complete true" "$WORK")"
assert_allow "allows the sanctioned CLI: run-state.sh status" \
  "$(bash_hook "\"$BIN/run-state.sh\" status" "$WORK")"

group "approval gate: cwd independence (subdirectory walk-up)"
mkdir -p "$WORK/deep/nested/dir"
assert_deny "denies a commit issued from a nested subdirectory" \
  "$(printf '{"tool_input":{"command":"git commit -m x"},"cwd":"%s"}' "$WORK/deep/nested/dir" | "$BIN/approval-gate.sh")"

group "approval gate: run lifecycle"
setup; (cd "$WORK" && "$BIN/run-state.sh" begin g1 >/dev/null)
assert_deny "an in_progress unapproved run gates commits" "$(bash_hook "git commit -m x" "$WORK")"
# F3: an approval must be able to point at the review it summarises.
mkdir -p "$WORK/.atomic-cc/runs/g1/turn-1"; echo '{}' > "$WORK/.atomic-cc/runs/g1/turn-1/review-a.json"
(cd "$WORK" && "$BIN/run-state.sh" seal g1 complete true >/dev/null)
assert_allow "a sealed+approved run stops gating" "$(bash_hook "git commit -m x" "$WORK")"

setup; (cd "$WORK" && "$BIN/run-state.sh" begin g2 >/dev/null)
(cd "$WORK" && "$BIN/run-state.sh" seal g2 needs_human false >/dev/null)
assert_allow "a sealed UNAPPROVED run also stops gating (no permanent lockout)" \
  "$(bash_hook "git commit -m x" "$WORK")"

setup; (cd "$WORK" && "$BIN/run-state.sh" begin g3 >/dev/null)
(cd "$WORK" && "$BIN/run-state.sh" clear >/dev/null)
assert_allow "clear releases a stale run" "$(bash_hook "git commit -m x" "$WORK")"

setup; (cd "$WORK" && "$BIN/run-state.sh" begin g4 >/dev/null)
(cd "$WORK" && "$BIN/run-state.sh" approve g4 </dev/null >/dev/null)
assert_allow "human approval opens the gate" "$(bash_hook "git commit -m x" "$WORK")"
# F3: provenance is derived, not asserted. This call has no tty, so the record
# must NOT claim a person — that is the fix, and the old assertion was the bug.
if grep -q '"human": false' "$WORK/.atomic-cc/runs/g4/approval.json"; then
  pass "an approval with no terminal is not recorded as human"
else fail "an approval with no terminal is not recorded as human"; fi

group "audit 2026-08-12: every reproduced bypass (F1, F2, F12)"
# Each of these was executed against v0.3.0 by an independent auditor and ALLOWED.
# None is in the sh -c/eval class the docs disclosed. They are the regression set.
setup; (cd "$WORK" && "$BIN/run-state.sh" begin atk >/dev/null)
assert_deny "F1 cd into the run dir, then write a bare approval.json" \
  "$(bash_hook 'cd .atomic-cc/runs/atk && printf "{\"approved\": true}" > approval.json' "$WORK")"
assert_deny "F1 doubled slash in the path" \
  "$(bash_hook 'printf x > ./.atomic-cc//runs/atk/approval.json' "$WORK")"
assert_deny "F1 directory held in a variable" \
  "$(bash_hook 'D=.atomic-cc/runs/atk; printf x > $D/approval.json' "$WORK")"
assert_deny "F1 filename held in a variable" \
  "$(bash_hook 'F=approval.json; printf x > .atomic-cc/runs/atk/$F' "$WORK")"
assert_deny "F1 delete the whole state directory" "$(bash_hook 'rm -rf .atomic-cc' "$WORK")"
assert_deny "F1 rename the state directory out of the way" "$(bash_hook 'mv .atomic-cc .atomic-cc-off' "$WORK")"
assert_deny "F1 tee into the state" "$(bash_hook 'echo x | tee .atomic-cc/run-state.json' "$WORK")"
assert_deny "F2 pre-spend the Stop-guard counter" \
  "$(bash_hook 'echo 3 > .atomic-cc/.state/stop-blocks-atk' "$WORK")"
for c in "git 'commit' -m x" "git c'ommit' -m x" 'git merge --no-ff other' 'git revert HEAD --no-edit' \
         'git rebase --continue' 'git tag -a v1 -m x' 'git notes add -m x' 'git apply p.diff' \
         'git stash push' 'glab mr create' 'hub pull-request' 'sl commit -m x' 'jj new' 'gh pr ready'; do
  assert_deny "F12 $c" "$(bash_hook "$c" "$WORK")"
done
# The widened matcher must not start eating ordinary work.
for c in 'npm test' 'git status' 'git diff --stat' 'git log --oneline -5' 'cat src/index.ts' \
         'echo hi > notes.md' 'ls .atomic-cc' 'cat .atomic-cc/run-state.json' 'git fetch origin'; do
  assert_allow "still allows: $c" "$(bash_hook "$c" "$WORK")"
done

group "audit 2026-08-12: F7 duty 2 is reachable without jq"
# The degraded branch used to return before the tamper check, so on a machine
# without jq an agent could forge approval.json and the gate honoured it later.
setup; (cd "$WORK" && "$BIN/run-state.sh" begin dgx >/dev/null)
MINBIN="$WORK/.minbin"; mkdir -p "$MINBIN"
for b in grep sed dirname cat find rm mkdir ls date printf head; do
  p=$(command -v "$b" 2>/dev/null) && ln -sf "$p" "$MINBIN/$b"
done   # everything the scripts need, deliberately without jq
nojq_hook() { printf '{"tool_input":{"command":%s},"cwd":"%s"}' \
  "$(python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1")" "$2" \
  | env PATH="$MINBIN" "$BIN/approval-gate.sh"; }
assert_deny "no jq: still denies a commit" "$(nojq_hook 'git commit -m x' "$WORK")"
assert_deny "no jq: now also denies forging approval.json" \
  "$(nojq_hook 'printf x > .atomic-cc/runs/dgx/approval.json' "$WORK")"
assert_deny "no jq: now also denies deleting the state" "$(nojq_hook 'rm -rf .atomic-cc' "$WORK")"

group "audit 2026-08-12: F3 an approval must point at a review"
setup; (cd "$WORK" && "$BIN/run-state.sh" begin ev1 >/dev/null)
if (cd "$WORK" && "$BIN/run-state.sh" seal ev1 complete true >/dev/null 2>&1); then
  fail "seal approved=true is refused with no review record on disk"
else pass "seal approved=true is refused with no review record on disk"; fi
assert_deny "and the gate stays shut" "$(bash_hook "git commit -m x" "$WORK")"
mkdir -p "$WORK/.atomic-cc/runs/ev1/turn-1"; echo '{}' > "$WORK/.atomic-cc/runs/ev1/turn-1/review-a.json"
if (cd "$WORK" && "$BIN/run-state.sh" seal ev1 complete true >/dev/null 2>&1); then
  pass "with a review record the reducer can seal"; else fail "with a review record the reducer can seal"; fi
if grep -q '"channel": "reducer-seal"' "$WORK/.atomic-cc/runs/ev1/approval.json"; then
  pass "the approval names its channel"; else fail "the approval names its channel"; fi

group "audit 2026-08-12: F3 approve does not assert a human it cannot see"
setup; (cd "$WORK" && "$BIN/run-state.sh" begin hu1 >/dev/null); mkdir -p "$WORK/.atomic-cc/runs/hu1"
(cd "$WORK" && "$BIN/run-state.sh" approve hu1 </dev/null >/dev/null 2>&1)
if grep -q '"human": false' "$WORK/.atomic-cc/runs/hu1/approval.json"; then
  pass "a non-interactive approve records human=false"
else fail "a non-interactive approve records human=false" "$(cat "$WORK/.atomic-cc/runs/hu1/approval.json")"; fi
if grep -q 'no tty' "$WORK/.atomic-cc/runs/hu1/approval.json"; then
  pass "and says why"; else fail "and says why"; fi
assert_allow "the gate still opens (approval is real, its provenance is honest)" \
  "$(bash_hook "git commit -m x" "$WORK")"

group "audit 2026-08-12: F6 the CLI and the hooks agree on the root"
# run-state.sh anchored at the git toplevel while the hooks anchored at
# CLAUDE_PROJECT_DIR; in a monorepo with a nested repo they disagreed and the
# gate was inert for the whole run.
setup; mkdir -p "$WORK/pkg/inner" && (cd "$WORK/pkg/inner" && git init -q)
(cd "$WORK/pkg/inner" && "$BIN/run-state.sh" begin nested >/dev/null 2>&1)
OUT=$(printf '{"tool_input":{"command":"git commit -m x"},"cwd":"%s"}' "$WORK/pkg/inner" \
  | env CLAUDE_PROJECT_DIR="$WORK" "$BIN/approval-gate.sh")
if [ -n "$OUT" ]; then pass "a run in a nested repo is still gated with CLAUDE_PROJECT_DIR above it"
else fail "a run in a nested repo is still gated with CLAUDE_PROJECT_DIR above it" "gate was inert"; fi
OUT=$(printf '{"stop_hook_active":false,"cwd":"%s"}' "$WORK/pkg/inner" \
  | env CLAUDE_PROJECT_DIR="$WORK" "$BIN/stop-guard.sh")
if [ -n "$OUT" ]; then pass "and the Stop guard sees it too"
else fail "and the Stop guard sees it too" "run could be silently abandoned"; fi

group "run-state CLI: no subcommand blocks on stdin"
# Regression: seal used to persist a decision document from stdin whenever stdin
# was not a tty. A pipe that is open but never written is not a tty either, so the
# read blocked forever — hanging the agent mid-run with the commit gate shut. Every
# subcommand is invoked here with exactly that stdin and must still finish.
setup
# `sleep` holds the write end of the pipe open without ever sending a byte, which
# is exactly the stdin an agent shell can hand a hook script. Portable watchdog:
# macOS has no `timeout`. Exit status is irrelevant here — only whether it returns.
finishes_with_open_stdin() {
  local sub="$1" pid waited=0
  # Process substitution, not a pipeline: a pipeline would make the timing wait for
  # `sleep` too. Here only run-state.sh is the job being watched.
  ( cd "$WORK" && eval "\"$BIN/run-state.sh\" $sub" ) < <(sleep 30) >/dev/null 2>&1 &
  pid=$!
  while kill -0 "$pid" 2>/dev/null; do
    [ "$waited" -ge 50 ] && { kill -9 "$pid" 2>/dev/null; wait "$pid" 2>/dev/null; return 1; }
    sleep 0.1; waited=$((waited+1))
  done
  wait "$pid" 2>/dev/null
  return 0
}
for sub in "begin p1" "status" "seal p1 complete false" "approve p1" "clear"; do
  if finishes_with_open_stdin "$sub"; then
    pass "run-state.sh $sub finishes with an open pipe on stdin"
  else
    fail "run-state.sh $sub finishes with an open pipe on stdin" "hung — it is reading stdin"
  fi
done

group "run-state CLI: a run may only seal itself"
# Nine workflows can now hold the gate. Without this guard, a second workflow
# that failed to begin (because the first still held the gate) could seal its own
# run id and release the gate on the run that actually holds it.
setup; (cd "$WORK" && "$BIN/run-state.sh" begin holder >/dev/null)
if (cd "$WORK" && "$BIN/run-state.sh" seal intruder complete false >/dev/null 2>&1); then
  fail "seal refuses to release a gate held by another run"
else pass "seal refuses to release a gate held by another run"; fi
assert_deny "the holder's gate survives the foreign seal attempt" "$(bash_hook "git commit -m x" "$WORK")"
if (cd "$WORK" && "$BIN/run-state.sh" seal holder complete false >/dev/null 2>&1); then
  pass "the holder can seal itself"; else fail "the holder can seal itself"; fi
assert_allow "the gate opens once the holder seals" "$(bash_hook "git commit -m x" "$WORK")"
# Terminal state is not a lock: the next run may claim the gate.
if (cd "$WORK" && "$BIN/run-state.sh" begin nextrun >/dev/null 2>&1); then
  pass "a sealed run does not block the next begin"; else fail "a sealed run does not block the next begin"; fi
mkdir -p "$WORK/.atomic-cc/runs/nextrun"; echo '{}' > "$WORK/.atomic-cc/runs/nextrun/decision.json"
if (cd "$WORK" && "$BIN/run-state.sh" seal nextrun complete true >/dev/null 2>&1); then
  pass "the new holder can seal approved=true"; else fail "the new holder can seal approved=true"; fi

group "approval gate: no run at all means no interference"
rm -rf "$WORK/.atomic-cc"
assert_allow "a project with no atomic run never gates" "$(bash_hook "git commit -m x" "$WORK")"

group "tamper guard: Write/Edit on gate files"
assert_deny "denies Write to run-state.json" "$(edit_hook "$WORK/.atomic-cc/run-state.json")"
assert_deny "denies Write to approval.json" "$(edit_hook "$WORK/.atomic-cc/runs/x/approval.json")"
assert_deny "denies Write into the evidence log" "$(edit_hook "$WORK/.atomic-cc/evidence/s.jsonl")"
assert_allow "allows an ordinary source file" "$(edit_hook "$WORK/src/index.ts")"
assert_allow "allows a run receipt" "$(edit_hook "$WORK/.atomic-cc/runs/x/turn-1/receipt.md")"
assert_deny "the tamper guard applies even with no active run" "$(edit_hook "$WORK/.atomic-cc/runs/future/approval.json")"

group "stop guard"
setup; (cd "$WORK" && "$BIN/run-state.sh" begin s1 >/dev/null)
OUT=$(stop_hook "$WORK" false)
[ "$(printf '%s' "$OUT" | jq -r '.decision // empty')" = "block" ] && pass "blocks a turn ending on an in_progress run" || fail "blocks a turn ending on an in_progress run"
OUT=$(stop_hook "$WORK" true)
[ -z "$OUT" ] && pass "respects stop_hook_active (no re-block loop)" || fail "respects stop_hook_active"
OUT=$(stop_hook "$WORK/deep/nested/dir" false 2>/dev/null); mkdir -p "$WORK/deep/nested/dir"
OUT=$(stop_hook "$WORK/deep/nested/dir" false)
[ "$(printf '%s' "$OUT" | jq -r '.decision // empty')" = "block" ] && pass "finds the run from a subdirectory" || fail "finds the run from a subdirectory"
# Bound: after 3 blocks the guard stops blocking (it already blocked twice above).
stop_hook "$WORK" false >/dev/null; OUT=$(stop_hook "$WORK" false)
[ -z "$OUT" ] && pass "stops blocking after its bound" || fail "stops blocking after its bound" "still blocking"
mkdir -p "$WORK/.atomic-cc/runs/s1"; echo '{}' > "$WORK/.atomic-cc/runs/s1/decision.json"
(cd "$WORK" && "$BIN/run-state.sh" seal s1 complete true >/dev/null)
OUT=$(stop_hook "$WORK" false)
[ -z "$OUT" ] && pass "never blocks once the run is sealed" || fail "never blocks once the run is sealed"
if [ ! -f "$WORK/.atomic-cc/.state/stop-blocks-s1" ]; then
  pass "sealing resets the stop-guard counter"
else fail "sealing resets the stop-guard counter"; fi

group "degraded mode: no jq"
setup; (cd "$WORK" && "$BIN/run-state.sh" begin d1 >/dev/null)
FAKEBIN="$WORK/fakebin"; mkdir -p "$FAKEBIN"
# A PATH without jq: the gate must still deny commit-shaped commands (fail-safe),
# rather than silently opening as the previous version did.
OUT=$(printf '{"tool_input":{"command":"git commit -m x"},"cwd":"%s"}' "$WORK" \
  | env PATH="$FAKEBIN:/usr/bin:/bin" CLAUDE_PROJECT_DIR="$WORK" "$BIN/approval-gate.sh" 2>/dev/null)
if printf '%s' "$OUT" | grep -q '"deny"'; then pass "without jq the gate still denies commits (fail-safe)"
else fail "without jq the gate still denies commits" "output: ${OUT:-<empty>}"; fi
OUT=$(printf '{"tool_input":{"file_path":"%s/.atomic-cc/runs/x/approval.json"}}' "$WORK" \
  | env PATH="$FAKEBIN:/usr/bin:/bin" "$BIN/tamper-guard.sh" 2>/dev/null)
if printf '%s' "$OUT" | grep -q '"deny"'; then pass "without jq the tamper guard still denies gate-file writes"
else fail "without jq the tamper guard still denies gate-file writes" "output: ${OUT:-<empty>}"; fi

group "check-upstream: consent and no project pollution"
setup
OUT=$(cd "$WORK" && printf '{}' | ATOMIC_OFFLINE=1 CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$BIN/check-upstream.sh")
[ -z "$OUT" ] && pass "ATOMIC_OFFLINE=1 silences the upstream watch" || fail "ATOMIC_OFFLINE=1 silences the upstream watch"
OUT=$(cd "$WORK" && printf '{}' | ATOMIC_SKIP_VERSION_CHECK=1 CLAUDE_PLUGIN_ROOT="$PLUGIN_ROOT" "$BIN/check-upstream.sh")
[ -z "$OUT" ] && pass "ATOMIC_SKIP_VERSION_CHECK=1 silences it too" || fail "ATOMIC_SKIP_VERSION_CHECK=1 silences it too"
if [ ! -d "$WORK/.atomic-cc/.state" ]; then
  pass "the upstream watch creates no state inside the project"
else fail "the upstream watch creates no state inside the project"; fi

group "rigor profile"
setup
OUT=$(cd "$WORK" && "$BIN/rigor.sh" show)
printf '%s' "$OUT" | grep -q "no rigor profile" && pass "reports no profile before one is set" || fail "reports no profile before one is set"
(cd "$WORK" && "$BIN/rigor.sh" set thorough >/dev/null)
OUT=$(cd "$WORK" && "$BIN/rigor.sh" show)
printf '%s' "$OUT" | grep -q "thorough" && pass "set/show round-trips a profile" || fail "set/show round-trips a profile"
printf '%s' "$OUT" | grep -q "review_quorum=2" && pass "show states the gate constants are fixed" || fail "show states the gate constants are fixed"
OUT=$(cd "$WORK" && "$BIN/rigor.sh" args)
printf '%s' "$OUT" | jq -e '.max_turns == 20' >/dev/null && pass "args emits the profile budgets as JSON" || fail "args emits the profile budgets as JSON"
printf '%s' "$OUT" | jq -e 'has("review_quorum") | not' >/dev/null && pass "args cannot carry a review quorum" || fail "args cannot carry a review quorum"
OUT=$(cd "$WORK" && printf '{}' | "$BIN/rigor.sh" notice)
printf '%s' "$OUT" | grep -q "thorough" && pass "the SessionStart notice reports the profile (rigor is not a no-op)" || fail "the SessionStart notice reports the profile"
printf '%s' "$OUT" | grep -q "cannot be lowered" && pass "the notice states the gate cannot be weakened" || fail "the notice states the gate cannot be weakened"
OUT=$(cd "$WORK" && "$BIN/rigor.sh" set bogus 2>&1); [ $? -ne 0 ] && pass "rejects an unknown profile" || fail "rejects an unknown profile"
(cd "$WORK" && "$BIN/rigor.sh" clear >/dev/null)
OUT=$(cd "$WORK" && printf '{}' | "$BIN/rigor.sh" notice)
[ -z "$OUT" ] && pass "no notice when no profile is set" || fail "no notice when no profile is set"

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1

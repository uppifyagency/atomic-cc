#!/bin/bash
# Structural contract tests: manifests, frontmatter, syntax, and cross-references.
# These catch the class of defect that silently disables a feature — a workflow
# referencing an agent that does not exist, a skill missing
# disable-model-invocation, an unreachable agent, a version skew between the two
# manifests.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PASS=0; FAIL=0
pass() { PASS=$((PASS+1)); echo "  ok   $1"; }
fail() { FAIL=$((FAIL+1)); echo "  FAIL $1${2:+ — $2}"; }
group() { echo; echo "$1"; }

command -v jq >/dev/null 2>&1 || { echo "jq is required"; exit 1; }
command -v node >/dev/null 2>&1 || { echo "node is required"; exit 1; }

group "syntax"
for f in "$ROOT"/workflows/*.js; do
  if node --check "$f" >/dev/null 2>&1; then pass "node --check $(basename "$f")"
  else fail "node --check $(basename "$f")"; fi
done
for f in "$ROOT"/bin/*.sh "$ROOT"/test/*.sh; do
  if bash -n "$f" 2>/dev/null; then pass "bash -n $(basename "$f")"
  else fail "bash -n $(basename "$f")"; fi
done
if jq -e . "$ROOT/hooks/hooks.json" >/dev/null 2>&1; then pass "hooks.json is valid JSON"; else fail "hooks.json is valid JSON"; fi

group "manifests"
PV=$(jq -r '.version' "$ROOT/.claude-plugin/plugin.json")
MV=$(jq -r '.plugins[0].version // .version // empty' "$ROOT/.claude-plugin/marketplace.json")
if [ -n "$PV" ] && [ "$PV" = "$MV" ]; then pass "plugin.json and marketplace.json versions agree ($PV)"
else fail "plugin.json and marketplace.json versions agree" "plugin=$PV marketplace=$MV"; fi
# The plugin's manifest name is the slash-command namespace: "atomic" yields
# /atomic:goal. Renaming it would break every documented command.
if jq -e '.name == "atomic"' "$ROOT/.claude-plugin/plugin.json" >/dev/null; then pass "plugin name is atomic (namespace /atomic:*)"; else fail "plugin name is atomic (namespace /atomic:*)"; fi

group "hooks wiring"
for pair in "PreToolUse:approval-gate.sh" "PreToolUse:tamper-guard.sh" "PostToolUse:evidence-logger.sh" "Stop:stop-guard.sh" "SessionStart:check-upstream.sh" "SessionStart:rigor.sh"; do
  EV="${pair%%:*}"; SC="${pair##*:}"
  if jq -e --arg ev "$EV" --arg sc "$SC" '.hooks[$ev] | tostring | contains($sc)' "$ROOT/hooks/hooks.json" >/dev/null 2>&1; then
    pass "$EV runs $SC"
  else fail "$EV runs $SC"; fi
done
# Every hook command must be quoted around CLAUDE_PLUGIN_ROOT: the plugin lives
# under a path with spaces on this machine, and an unquoted expansion breaks it.
UNQUOTED=$(jq -r '[.. | objects | select(has("command")) | .command] | map(select(contains("${CLAUDE_PLUGIN_ROOT}") and (startswith("\"${CLAUDE_PLUGIN_ROOT}\"") | not))) | length' "$ROOT/hooks/hooks.json")
if [ "$UNQUOTED" = "0" ]; then pass "every hook command quotes \${CLAUDE_PLUGIN_ROOT}"; else fail "every hook command quotes \${CLAUDE_PLUGIN_ROOT}" "$UNQUOTED unquoted"; fi
# Stop hooks do not support matchers.
if jq -e '.hooks.Stop | map(has("matcher")) | any | not' "$ROOT/hooks/hooks.json" >/dev/null; then
  pass "the Stop hook declares no matcher"; else fail "the Stop hook declares no matcher"; fi
for f in "$ROOT"/bin/*.sh; do
  if [ -x "$f" ]; then pass "executable: bin/$(basename "$f")"; else fail "executable: bin/$(basename "$f")"; fi
done

group "workflow conventions"
for f in "$ROOT"/workflows/*.js; do
  n=$(basename "$f")
  if [ "$(grep -c '^export const meta' "$f")" = "1" ]; then pass "$n has exactly one exported meta"
  else fail "$n has exactly one exported meta"; fi
  # The sandbox forbids these; using them breaks resume. Comments explaining the
  # prohibition are fine, so only non-comment lines count.
  if grep -vE '^\s*(//|\*|/\*)' "$f" | grep -qE '\bDate\.now\(|Math\.random\(|require\(|from .node:'; then
    fail "$n avoids Date.now/Math.random/require/node: imports"
  else pass "$n avoids Date.now/Math.random/require/node: imports"; fi
  # Gate files may be mentioned, but only as prohibitions or via the CLI.
  if grep -nE '(run-state\.json|approval\.json)' "$f" | grep -vqE 'run-state\.sh|[Nn]ever|not |no |denies|denied|skip|only by|instead|//'; then
    fail "$n never instructs an agent to write gate files" "$(grep -nE '(run-state\.json|approval\.json)' "$f" | grep -vE 'run-state\.sh|[Nn]ever|not |no |denies|denied|skip|only by|instead|//' | head -1)"
  else pass "$n never instructs an agent to write gate files"; fi
done

group "every workflow joins the run lifecycle"
# Every workflow drives write-capable agents (atomic:worker, or the default
# subagent, which also holds Edit/Write/Bash), so "this one only writes its own
# artifacts" is a prompt, not a permission. The invariant is therefore uniform:
# every workflow registers the run with the commit gate and seals a terminal
# status. Anything less leaves a run that can commit without a gate, or a gate
# left shut after the run ends.
for f in "$ROOT"/workflows/*.js; do
  n=$(basename "$f")
  if grep -q 'bin/run-state.sh' "$f"; then pass "$n uses the run-state CLI"
  else fail "$n uses the run-state CLI" "no gate registration"; fi
  if grep -qE '(begin \$\{A\.run_id\}|run-state\.sh" begin)' "$f"; then pass "$n registers the run (begin)"
  else fail "$n registers the run (begin)"; fi
  if grep -qE '(seal \$\{A\.run_id\}|run-state\.sh" seal)' "$f"; then pass "$n seals a terminal status"
  else fail "$n seals a terminal status"; fi
  # plugin_root is how the workflow learns where the CLI lives; without reading
  # it the two assertions above are dead template text.
  if grep -q 'A\.plugin_root' "$f"; then pass "$n reads plugin_root"
  else fail "$n reads plugin_root"; fi
done
# Only a workflow with an independent review gate may mint the approval receipt.
# goal (quorum of 2), ralph (2 reviewer seats), adversarial-verification (verifier
# + reducer) and loop-until-done (independent evaluator) review; the rest do not.
for n in tournament generate-and-filter open-claude-design fan-out-synthesize classify-and-act; do
  f="$ROOT/workflows/$n.js"
  if grep -qE 'seal \$\{A\.run_id\} [a-z]+ true|sealStage\('"'"'[a-z]+'"'"', true\)' "$f"; then
    fail "$n never seals approved=true (it has no review gate)"
  else pass "$n never seals approved=true (it has no review gate)"; fi
done

group "gate constants are not inputs"
if grep -q 'REVIEW_QUORUM = 2' "$ROOT/workflows/goal.js"; then pass "goal pins review quorum to 2"; else fail "goal pins review quorum to 2"; fi
if grep -qE 'A\.review_quorum|A\.verifier_count' "$ROOT/workflows/goal.js"; then
  fail "goal exposes no quorum/verifier_count input"; else pass "goal exposes no quorum/verifier_count input"; fi
if grep -q 'REVIEWER_COUNT = 2' "$ROOT/workflows/ralph.js"; then pass "ralph pins reviewer count to 2"; else fail "ralph pins reviewer count to 2"; fi
if grep -qE 'A\.verifier_count' "$ROOT/workflows/ralph.js"; then
  fail "ralph exposes no verifier_count input"; else pass "ralph exposes no verifier_count input"; fi

group "agents"
AGENTS=$(cd "$ROOT/agents" && ls *.md | sed 's/\.md$//')
for a in $AGENTS; do
  f="$ROOT/agents/$a.md"
  if head -1 "$f" | grep -q '^---$'; then pass "$a.md opens with frontmatter"; else fail "$a.md opens with frontmatter"; fi
  if grep -qE "^name: $a$" "$f"; then pass "$a.md name matches its filename"; else fail "$a.md name matches its filename"; fi
  if grep -qE '^tools: ' "$f"; then pass "$a.md declares tools"; else fail "$a.md declares tools"; fi
done
# The verifier judges the tree; it must not be able to rewrite it.
if grep -E '^tools: ' "$ROOT/agents/verifier.md" | grep -qE '\b(Edit|Write|NotebookEdit)\b'; then
  fail "the verifier has no write tools"; else pass "the verifier has no write tools"; fi
if grep -q 'model: opus' "$ROOT/agents/verifier.md"; then pass "the verifier pins a model (decorrelation)"; else fail "the verifier pins a model"; fi
if grep -qE 'ESCALATION REQUIRED|escalation' "$ROOT/agents/worker.md"; then pass "the worker has a structured escalation channel"; else fail "the worker has a structured escalation channel"; fi

group "agent references resolve"
for f in "$ROOT"/workflows/*.js "$ROOT"/commands/*.md; do
  for ref in $(grep -oE "atomic:[a-z-]+" "$f" | sort -u); do
    name="${ref#atomic:}"
    case "$name" in
      # skill/command namespaces, not agents
      goal|ralph|status|approve|resume|rigor|sync-upstream|parallel-review|review-loop|parallel-research|parallel-cleanup|parallel-context-build|parallel-handoff-plan|gather-context-and-clarify|adversarial-verification|classify-and-act|fan-out-synthesize|generate-and-filter|loop-until-done|open-claude-design|tournament) continue ;;
    esac
    if [ -f "$ROOT/agents/$name.md" ]; then pass "$(basename "$f") -> agents/$name.md exists"
    else fail "$(basename "$f") -> agents/$name.md exists" "missing agent"; fi
  done
done

group "no orphan agents (every agent is reachable)"
for a in $AGENTS; do
  if grep -rqlE "atomic:$a\b" "$ROOT/workflows" "$ROOT/commands" 2>/dev/null; then
    pass "$a is reachable from a workflow or command"
  else fail "$a is reachable from a workflow or command" "orphan"; fi
done

group "skills"
for d in "$ROOT"/skills/*/; do
  n=$(basename "$d")
  f="$d/SKILL.md"
  if grep -q '^disable-model-invocation: true' "$f"; then pass "$n is user-invocable only"
  else fail "$n is user-invocable only" "a model could invoke it autonomously"; fi
  if grep -qE '^(allowed-tools|tools): ' "$f"; then pass "$n declares its tools"; else fail "$n declares its tools"; fi
done

group "commands"
for f in "$ROOT"/commands/*.md; do
  n=$(basename "$f")
  if head -1 "$f" | grep -q '^---$'; then pass "$n opens with frontmatter"; else fail "$n opens with frontmatter"; fi
  if grep -qE '^description: ' "$f"; then pass "$n declares a description"; else fail "$n declares a description"; fi
done

group "docs honesty"
# The gate is discipline for agents, not a sandbox. Claiming otherwise is the
# one documentation defect that changes how a user behaves.
for f in "$ROOT/README.md" "$ROOT/docs/index.html"; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  if grep -qiE 'not a sandbox|discipline for agents|is not a security boundary' "$f"; then
    pass "$n states the gate is discipline, not a sandbox"
  else fail "$n states the gate is discipline, not a sandbox"; fi
  if grep -qiE 'happens outside the model' "$f"; then
    fail "$n does not claim approval happens outside the model" "that claim is true of the reducer, not of the token the hook checks"
  else pass "$n does not overclaim where approval happens"; fi
done
if [ -f "$ROOT/CHANGELOG.md" ]; then pass "CHANGELOG.md exists"; else fail "CHANGELOG.md exists"; fi

group "the landing page describes behaviour that exists"
# Four workflow descriptions survived the fidelity release describing the bugs
# rather than the fixes. These are the specific sentences that were wrong.
for pair in \
  "same blocking finding surviving three consecutive turns:goal aborts on a code finding" \
  "refine it into a spec with testable acceptance criteria:ralph authors the criteria" \
  "bounded repair loop that is handed only the blocking findings:ralph repairs instead of researching" \
  "records <code>needs_human</code> instead of guessing:classify-and-act does nothing" \
  "upstream.s own headless variant:open-claude-design is a port"; do
  claim="${pair%%:*}"; what="${pair##*:}"
  if grep -qiE "$claim" "$ROOT/docs/index.html"; then
    fail "index.html no longer claims $what" "stale sentence: $claim"
  else pass "index.html no longer claims $what"; fi
done
# Every shipped agent must appear in the subagent table.
for a in $AGENTS; do
  if grep -q "<td class=\"mono\">$a</td>" "$ROOT/docs/index.html"; then pass "the subagent table lists $a"
  else fail "the subagent table lists $a" "shipped but undocumented"; fi
done

group "the landing page does not advertise a configurable gate"
# It said goal's quorum was "configurable, 1–5 reviewers". It is a module constant,
# and advertising otherwise sells the one property the plugin exists to provide.
if grep -qiE 'reviewers approve \(configurable|configurable, 1.5 reviewers' "$ROOT/docs/index.html"; then
  fail "index.html does not call the review quorum configurable" "the quorum is a constant"
else pass "index.html does not call the review quorum configurable"; fi
# Every workflow should appear in the approval table, so a reader can see which
# ones certify and which only finish.
for w in "$ROOT"/workflows/*.js; do
  n=$(basename "$w" .js)
  if grep -q "<td class=\"mono\">$n</td>" "$ROOT/docs/index.html"; then pass "the approval table lists $n"
  else fail "the approval table lists $n" "a reader cannot tell whether it certifies"; fi
done

group "the landing page describes the hooks that exist"
# It advertised "six hooks hold the line" over a list of four, and told readers the
# gates fail open without jq — the one wrong claim that changes how someone behaves.
for h in "Evidence logger" "Approval gate" "Tamper guard" "Stop guard" "Rigor notice" "Upstream watch"; do
  if grep -q ">$h<" "$ROOT/docs/index.html"; then pass "index.html documents the $h hook"
  else fail "index.html documents the $h hook" "listed nowhere"; fi
done
if grep -qE 'enforcement hooks[^<]*fail open|no <code>jq</code>, no gate|hooks silently disable themselves' "$ROOT/docs/index.html"; then
  fail "index.html does not claim the gates fail open without jq" "they fail safe"
else pass "index.html does not claim the gates fail open without jq"; fi
# The landing quotes the assertion count; it must be the badge's number.
LANDING_N=$(grep -oE '[0-9]{3} assertions' "$ROOT/docs/index.html" | head -1 | grep -oE '^[0-9]+')
BADGE_N=$(grep -ohE 'tests-[0-9]+%20passing' "$ROOT/README.md" | head -1 | sed 's/tests-\([0-9]*\)%20passing/\1/')
if [ -z "$LANDING_N" ] || [ "$LANDING_N" = "$BADGE_N" ]; then
  pass "index.html quotes the same assertion count as the badge (${LANDING_N:-none})"
else fail "index.html quotes the same assertion count as the badge" "landing=$LANDING_N badge=$BADGE_N"; fi

group "one canonical site"
# The project had two live landing pages (github.io and vercel.app) advertising
# themselves as the same document: the HTML canonicalised to Vercel while every
# badge, homepage field and link pointed at Pages. Vercel is the canonical one.
CANON=$(grep -oE 'rel="canonical" href="[^"]+"' "$ROOT/docs/index.html" | sed 's/.*href="//; s/"$//')
if [ "$CANON" = "https://atomic-cc.vercel.app/" ]; then pass "the landing page canonicalises to Vercel"
else fail "the landing page canonicalises to Vercel" "found: $CANON"; fi
for f in "$ROOT/README.md" "$ROOT/docs/index.html" "$ROOT/.claude-plugin/plugin.json" "$ROOT/.claude-plugin/marketplace.json"; do
  n=$(basename "$f")
  if grep -q 'github\.io' "$f"; then
    fail "$n points at the canonical host only" "still links the retired Pages host"
  else pass "$n points at the canonical host only"; fi
done
for f in "$ROOT/.claude-plugin/plugin.json" "$ROOT/.claude-plugin/marketplace.json"; do
  H=$(jq -r '.homepage // .plugins[0].homepage // ""' "$f")
  if [ "$H" = "$CANON" ]; then pass "$(basename "$f") homepage is the canonical URL"
  else fail "$(basename "$f") homepage is the canonical URL" "found: $H"; fi
done

group "documented counts match the tree"
# The audit found README, the landing page and the marketplace description all
# advertising different, stale inventories. Counting them here is the only way
# they stay true after the next workflow or hook lands.
count_glob() { local n=0 p; for p in "$@"; do [ -e "$p" ] && n=$((n+1)); done; printf '%s' "$n"; }
N_WORKFLOWS=$(count_glob "$ROOT"/workflows/*.js)
N_AGENTS=$(count_glob "$ROOT"/agents/*.md)
N_SKILLS=$(count_glob "$ROOT"/skills/*/)
N_COMMANDS=$(count_glob "$ROOT"/commands/*.md)
N_SLASH=$((N_SKILLS + N_COMMANDS))
N_HOOKS=$(jq '[.hooks | to_entries[] | .value[] | .hooks[]] | length' "$ROOT/hooks/hooks.json")
word() { case "$1" in 1) echo one;; 2) echo two;; 3) echo three;; 4) echo four;; 5) echo five;; 6) echo six;; 7) echo seven;; 8) echo eight;; 9) echo nine;; 10) echo ten;; 11) echo eleven;; 12) echo twelve;; *) echo "$1";; esac; }
# The prose in README and on the landing page spells the numbers out.
for pair in "workflows:$N_WORKFLOWS" "subagents:$N_AGENTS" "slash commands:$N_SLASH" "hooks:$N_HOOKS"; do
  label="${pair%%:*}"; want="$(word "${pair##*:}")"
  for f in "$ROOT/README.md" "$ROOT/docs/index.html"; do
    [ -f "$f" ] || continue
    if grep -qi "$want $label" "$f"; then pass "$(basename "$f") says \"$want $label\""
    else fail "$(basename "$f") says \"$want $label\"" "count drifted from the tree"; fi
    # A different spelled-out number in front of the same noun is a stale claim.
    for n in one two three four five six seven eight nine ten eleven twelve; do
      [ "$n" = "$want" ] && continue
      if grep -qi "$n $label" "$f"; then fail "$(basename "$f") has no stale \"$label\" count" "found \"$n $label\""; break; fi
    done
  done
done
# The landing-page specsheet and the marketplace description use digits.
if [ -f "$ROOT/docs/index.html" ]; then
  for pair in "Workflows:$N_WORKFLOWS" "Subagents:$N_AGENTS" "Slash commands:$N_SLASH" "Hooks:$N_HOOKS"; do
    label="${pair%%:*}"; want="${pair##*:}"
    if grep -q "<dt>$label</dt><dd><span class=\"n\">$want<" "$ROOT/docs/index.html"; then
      pass "specsheet tile $label reads $want"
    else fail "specsheet tile $label reads $want" "tile drifted from the tree"; fi
  done
fi
MKT=$(jq -r '.plugins[0].description // .description // ""' "$ROOT/.claude-plugin/marketplace.json")
for pair in "workflows:$N_WORKFLOWS" "subagents:$N_AGENTS" "slash commands:$N_SLASH" "hooks:$N_HOOKS"; do
  label="${pair%%:*}"; want="${pair##*:}"
  if printf '%s' "$MKT" | grep -q "$want $label"; then pass "marketplace description says \"$want $label\""
  else fail "marketplace description says \"$want $label\"" "count drifted from the tree"; fi
done
# Every version string must be the manifest's. The landing page carried 0.2.0 in
# five places — wordmark, JSON-LD, two rules, and the limits section — through a
# release that had already shipped 0.3.0.
for f in "$ROOT/README.md" "$ROOT/docs/index.html"; do
  [ -f "$f" ] || continue
  n=$(basename "$f")
  # %20 inside badge URLs would otherwise glue itself onto the next number.
  STALE=$(sed 's/%20/ /g' "$f" | grep -oE '\b[0-9]+\.[0-9]+\.[0-9]+\b' | sort -u \
    | grep -v "^$PV$" | grep -vE '^2\.1\.' || true)
  if [ -z "$STALE" ]; then pass "$n quotes only the manifest version ($PV)"
  else fail "$n quotes only the manifest version ($PV)" "also found: $(echo "$STALE" | tr '\n' ' ')"; fi
done

# The badge and the prose must agree with what the suite actually asserts.
TEST_COUNT=$(grep -ohE 'tests-[0-9]+%20passing' "$ROOT/README.md" | head -1 | sed 's/tests-\([0-9]*\)%20passing/\1/')
if [ -n "$TEST_COUNT" ] && grep -q "$TEST_COUNT assertions" "$ROOT/README.md"; then
  pass "the test badge and the prose quote the same number ($TEST_COUNT)"
else fail "the test badge and the prose quote the same number" "badge=$TEST_COUNT"; fi

echo
echo "$PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ] || exit 1

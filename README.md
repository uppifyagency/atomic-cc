# atomic-cc

[![License: MIT](https://img.shields.io/badge/license-MIT-1d1c18)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.3.0-b8431f)](.claude-plugin/plugin.json)
[![Tests](https://img.shields.io/badge/tests-537%20passing-1d1c18)](test/run-tests.sh)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.154-1d1c18)](https://docs.claude.com/en/docs/claude-code)
[![Landing page](https://img.shields.io/badge/docs-landing%20page-b8431f)](https://atomic-cc.vercel.app/)

**A verification harness that runs inside Claude Code — as a plugin, and nothing else.** There is no
separate CLI to learn, no daemon to keep alive, no service to sign up for and no API key of its own.
You install it into the Claude Code session you already use, and nine workflows (all of Atomic's
builtins), eleven subagents, twelve slash commands and six hooks appear at the prompt.

Approval is **arithmetic in plain JavaScript**: the reviewers' `stop_review_loop` booleans are counted
by a reducer ported from Atomic, and no model decides the outcome. The state transition that opens
the commit gate goes through one small shell CLI (`bin/run-state.sh`) that validates it; agents can
invoke that CLI but cannot write the gate files themselves — a hook denies it. While a run is
in progress and unapproved, `git commit` is denied.

**This is discipline for agents, not a sandbox.** It is not a security boundary: a determined model
can still work around a shell matcher, and upstream Atomic makes the same disclaimer about itself.
What is genuinely deterministic is the reducer arithmetic and the validated state transitions —
see [Design guarantees (and honest limits)](#design-guarantees-and-honest-limits) for exactly where
the line sits.

Port of [Atomic](https://github.com/bastani-inc/atomic) (bastani-inc, MIT) into a native Claude Code plugin: schema-validated workflow stages, fresh-context adversarial verification, deterministic reducers, real-command evidence logs, and commit gates — all built on officially documented Claude Code primitives.

> **Independent port.** Not affiliated with, endorsed by, or supported by Bastani or Anthropic.
> Bundles no Atomic code. See [Licence & attribution](#license--attribution) and [`NOTICE`](NOTICE).

**[Landing page →](https://atomic-cc.vercel.app/)**

## What you get

| Piece | What it does |
|---|---|
| `/atomic:adversarial-verification` | worker → N fresh-context pass/fail verifiers → LLM reducer with unanimity override → bounded repair |
| `/atomic:goal` | bounded implementation loop with a persisted ledger, immutable acceptance criteria, three reviewer personas on decorrelated models, 2-of-3 quorum, an anti-loop that fires only on a repeated **environment** blocker, optional PR |
| `/atomic:ralph` | bounded **research** loop: refine research question → codebase + online research → implement → two decorrelated reviewers (unanimous gate) → re-research on failure → optional PR, opened as a **draft carrying the unresolved findings** when the budget runs out |
| `/atomic:fan-out-synthesize` | partition → bounded parallel branches, each writing a standalone artifact file → `manifest.json` barrier → synthesis that reads the artifact **files** (no truncated inline summaries) |
| `/atomic:classify-and-act` | classifier with confidence threshold → deterministic route → isolated action. Below threshold it still **acts**, falling back deterministically to the proposed category (as upstream does) and recording `fallback_used` |
| `/atomic:generate-and-filter` | N independent candidates → dedup + rubric filter → optional fresh judge → ranked shortlist |
| `/atomic:tournament` | independent whole-task attempts → balanced single-elimination judging bracket (byes, walkovers) → auditable winner + bracket.json |
| `/atomic:loop-until-done` | bounded iterate-and-evaluate loop with durable ledger; completion only on explicit evidence, exhaustion → `failed` |
| `/atomic:open-claude-design` | design brief → online reference discovery → self-contained HTML preview → bounded critic refinements → HTML handoff spec. **Partly original:** upstream requires a real browser and a human annotating a live preview; the critic loop here is a substitute, and the exported spec says so |
| 7 prompt-template commands | `/atomic:parallel-review` `/atomic:review-loop` `/atomic:parallel-research` `/atomic:parallel-cleanup` `/atomic:parallel-context-build` `/atomic:parallel-handoff-plan` `/atomic:gather-context-and-clarify` — ports of Atomic's `prompts/` layer, which is where the research and cleanup subagents earn their keep |
| subagents | worker, debugger, code-simplifier + 6 read-only research agents = the **9 subagents ported from Atomic**, plus 2 CC-specific ones: `verifier` (Atomic runs reviewers as workflow stages; CC needs a named `agentType`) and `scribe` (transcribes JS-composed audit artifacts verbatim, because workflow scripts have no filesystem access) |
| Evidence logger (hook) | every build/test/typecheck Bash call from ANY agent logged with real stdout/stderr to `.atomic-cc/evidence/` |
| Approval gate (hook) | commit-shaped commands (`git commit/push/am/cherry-pick/update-ref`, `gh pr create/merge`, `jj commit`) denied while a run is `in_progress` and unapproved — and shell tampering with the gate's own state files denied outright |
| Tamper guard (hook) | `Write`/`Edit` on `run-state.json`, `approval.json`, or the evidence log denied unconditionally: those are the CLI's files, not an agent's |
| Stop guard (hook) | turns can't silently end with a run `in_progress` (bounded, anti-loop, counter resets when the run is sealed) |
| `/atomic:status` `/atomic:approve` `/atomic:resume` `/atomic:rigor` | run inspection, human approval override, cross-session re-entry, rigor profiles (effort budgets only — a profile cannot weaken a review gate) |
| Upstream watch (hook) + `/atomic:sync-upstream` | SessionStart hook compares `bastani-inc/atomic` HEAD with `upstream.lock` (max one network check per 24h, stamped in your user cache — never inside your projects; silenced by `ATOMIC_OFFLINE=1` or `ATOMIC_SKIP_VERSION_CHECK=1`). On drift it prints a notice; the sync skill is **user-invoked only** and may not touch `bin/` or `hooks/` |
| Rigor notice (hook) | SessionStart injects this project's rigor profile so the budgets are actually seen and passed — `/atomic:rigor` is not a file nobody reads |

## Requirements

- Claude Code ≥ 2.1.154 (dynamic workflows), paid plan; on Pro enable workflows in `/config`.
- `jq` on PATH. Without it the two **gates fail safe, not open**: commit-shaped commands are denied with an explanatory reason, and gate-file writes stay denied. The evidence logger and the upstream watch do disable themselves without jq (a missing evidence log reads as "unverified" to the verifier, never as "clean").
- `node` on PATH to run the test suite (`test/run-tests.sh`); not needed at runtime.
- Workflows spawn real agents: an `adversarial-verification` run at standard rigor uses roughly 4–12 agent invocations.

## Install

This repository is its own single-plugin marketplace (`.claude-plugin/marketplace.json`), so a clone
is all Claude Code needs:

```bash
git clone https://github.com/uppifyagency/atomic-cc
claude plugin marketplace add ./atomic-cc
claude plugin install atomic@atomic-cc
```

Add `--scope project` to either command to record the choice in the repository's own settings
instead of your personal ones. To try it in a single session without registering anything:

```bash
claude --plugin-dir ./atomic-cc
```

## Usage

```
/atomic:adversarial-verification {"run_id": "av-login-fix-01", "task": "Fix the login redirect loop", "criteria": ["/login redirects authenticated users to /dashboard", "existing auth tests still pass"]}
```

Arguments are a **JSON object**. A slash command hands the workflow everything after the command name as one string, so the scripts parse the first `{…}` block out of it — trailing prose after the JSON is fine and ignored.

`run_id` is required, must be unique per run, and must match `[A-Za-z0-9._-]{1,64}` (it becomes a directory name). Workflow scripts cannot generate ids: `Date.now`/`Math.random` are unavailable by design — they would break resume.

**Running headless.** Dynamic workflows sit behind a review gate that needs interactive approval. In `claude -p` you must allowlist the tool explicitly, or the run dies before it starts:

```bash
claude -p '/atomic:goal {"run_id":"g-1","objective":"..."}' \
  --plugin-dir /path/to/atomic-cc \
  --allowedTools "Workflow,Bash,Read,Write,Edit,Grep,Glob" \
  --permission-mode acceptEdits
```

**Writing your own workflow:** `export const meta = {…}` must be the only `export` in the file. The rest of the script is wrapped in an async function, so a second top-level `export` is a parse error and the run never launches.

Run state lives in your project:

```
.atomic-cc/
├── run-state.json           # written ONLY by bin/run-state.sh; hooks deny every other writer
├── config.json              # rigor profile (bin/rigor.sh)
├── evidence/<session>.jsonl # real command logs written by the PostToolUse hook
└── runs/<run_id>/
    ├── goal-ledger.json     # receipts, reviews, blockers, reducer decisions, lifecycle events
    ├── turn-N/ | iter-N/    # per-round artifacts
    │   ├── orchestrator-receipt.md    # or orchestrator-report.md for ralph
    │   ├── review-<reviewer>.json     # one per reviewer, every round
    │   └── review-round-latest.json   # the round + its consolidated_findings batch
    ├── implementation-notes.md        # ralph
    ├── decision.json        # terminal decision: status, unresolved findings, escalation
    └── approval.json        # written ONLY by run-state.sh: reducer seal or /atomic:approve
```

`.atomic-cc/` is already in this repo's `.gitignore`; add it to your own project's unless you want
run history committed.

Inspecting a run: `/atomic:status`. Releasing a run abandoned by an interrupt the Stop hook cannot
see (Esc, `/clear`, a crash): `bin/run-state.sh clear`. Re-entering one across sessions:
`/atomic:resume`.

## Design guarantees (and honest limits)

**What is actually deterministic.** Convergence is ported from Atomic (`goal-reducer.ts`,
`ralph-review-gate.ts`, `review-convergence.ts`) and computed in plain JavaScript: the reviewer's
`stop_review_loop` boolean is the single authoritative approval signal, and the reducer completes on a
**quorum** of approving reviewers — goal 2 of 3, ralph unanimous over exactly 2, adversarial
unanimous. It never recomputes approval from findings or traceability, which Atomic deleted because
it deadlocked runs whose criteria referenced the review process itself. The finding-blocking rules
build the **repair payload** for the next turn, not the gate decision. goal's anti-loop fires only on
a repeated **environment** blocker (`dependency_unavailable`/`tool_failure` three turns running →
`blocked`); code findings always continue, so a stable P1 spends the budget it was given instead of
aborting at turn three. A crashed reviewer is synthesized into a non-approving record rather than
discarded, so one dead reviewer cannot cancel a quorum that was already reached. Review quorums are
module constants, not inputs: nothing a caller or a rigor profile passes can reduce a gate to a
single reviewer.

**Where the model still sits in the loop, stated plainly.** The state transition that opens the
commit gate is a validated shell CLI (`bin/run-state.sh`), and direct `Write`/`Edit` on
`run-state.json` / `approval.json` is denied by a hook — so an agent cannot forge the token the gate
checks. But an agent does *invoke* that CLI, and the Bash matcher that catches commit-shaped commands
is a regex: `sh -c`, `eval`, aliases, or an MCP/IDE git integration are not Bash calls the hook sees.
**This is discipline for agents, not a sandbox, and not a security boundary.** Upstream Atomic says
the same about itself ("no command-level allow/deny policy for bash"). What it prevents is a run
drifting into an unverified commit by ordinary momentum; what it cannot prevent is a model that sets
out to get around it. The audit trail is written by a `scribe` agent from bytes composed in the
workflow's JavaScript, which keeps it honest about content but still depends on that agent doing its
one job.

**Run lifecycle.** The gate applies only while a run is `in_progress`. Every terminal path seals the
run (`complete`/`blocked`/`needs_human`/`rejected`/`failed`), so a finished-but-unapproved run does
not hold unrelated commits hostage, and a completed run does not leave the door open for later
unrelated commits. `bin/run-state.sh clear` releases a run abandoned by an interrupt the Stop hook
cannot see (Esc, `/clear`, a crash). **All nine workflows register**, including the four that are
meant to produce nothing but artifacts (tournament, generate-and-filter, fan-out-synthesize,
open-claude-design): their stages run with write-capable tools, so "this one only writes its own
report" is a prompt, not a permission, and the gate covers them too. A run may only seal itself — the
CLI refuses to release a gate another run is holding.

**Which runs may mint an approval.** `approval.json` is the receipt that says *independently
reviewed*, so only a workflow with a review gate writes one: goal (quorum of 2 of 3), ralph (unanimous
over 2 seats), adversarial-verification (verifier plus reducer), and loop-until-done — the weakest of
the four, a single independent evaluator rather than an adversarial quorum. The other five seal
`complete` with `approved=false`. A judged tournament bracket picks the best of N attempts without
checking any of them against acceptance criteria; classify-and-act routes and acts but never reviews;
a shortlist ranks options; an investigation gathers evidence; a design critic is not a human in a
browser. Those runs finish, they just do not certify. `/atomic:approve` is how a human signs off on
one, and it is recorded as `"human": true`.

**What it cannot do:** prevent a model from reasoning badly — only stop bad reasoning from becoming
an unverified commit. **Known divergences from upstream, all deliberate:** no `context:"fork"`
stages, so later stages get artifact paths instead of a forked session; workflow resume with cached
results is same-session only (cross-session re-entry goes through `/atomic:resume` and persisted
artifacts); no mid-run human prompt, so classify-and-act falls back deterministically instead of
pausing and open-claude-design substitutes a critic for upstream's live browser QA (that one is
labelled as original work, not a port); Atomic's `ctx.task` file plumbing is emulated with project
files under `.atomic-cc/`; no `git_worktree_dir` input (CC worktree isolation would split run
artifacts from the hooks' project-cwd state, so an autonomous run mutates your checkout in place —
run it on a branch); upstream decorrelates reviewers **across vendors** (Anthropic + OpenAI chains)
while CC can only vary opus/sonnet/haiku plus charters, so correlated blind spots remain more likely
here than upstream; no playwright/tmux E2E or QA-video stage, so E2E guidance asks for the strongest
available proof instead.

**Tests.** `test/run-tests.sh` — 537 assertions across four suites: the hook contracts and run-state
lifecycle (real payloads against the real scripts, including the no-jq degraded path and the refusal
to seal a gate another run holds), the gate arithmetic (both reducers executed end to end with mocked
agents: quorum, crashed reviewers, the blocked trigger in both directions, escalation, criteria
immutability, draft handoff), the run lifecycle (every workflow executed against mocked agents to
prove it registers before its first write-capable stage, seals on every exit path — including
tournament's dead-attempt path — and never mints an approval it did not review), and the structural
contracts (manifests, frontmatter, agent references resolving, no orphan agents, no workflow
instructing an agent to write gate files, and every documented count and version matched against the
tree).

**Staying current with upstream:** the port records the upstream commit it was last synced against in `upstream.lock`. A SessionStart hook (`bin/check-upstream.sh`, at most one network check per 24h, fail-open) compares that SHA with `bastani-inc/atomic` HEAD and, on drift, tells the session to suggest `/atomic:sync-upstream` — a skill that reviews the upstream compare range, applies port-relevant behavior changes (workflows, agents, contracts), bumps the plugin version, and rewrites the lock.

**Verify on a first clean install** (undocumented or environment-dependent surface, so the test suite
cannot cover it): whether `agentType` wants the namespaced name (`atomic:verifier`) or the bare one —
the runtime error lists accepted names — whether the skills' `allowed-tools` frontmatter key loads
their tools as expected, and your plan's workflow availability. Run `test/run-tests.sh` first: if the
suite passes and one of these still misbehaves, the problem is the platform surface, not the port.

## License & attribution

MIT — see [`LICENSE`](LICENSE), © 2026 Vlad Vrinceanu.

This plugin is an **independent port** of concepts, contracts, and reducer rules from [Atomic by Bastani](https://github.com/bastani-inc/atomic) (MIT). It bundles no Atomic code; the reducer logic was re-derived from the published sources (`review-convergence.ts`, `goal-schemas.ts`) and the official docs at [docs.bastani.ai](https://docs.bastani.ai). The design being ported — the `stop_review_loop` approval contract, the quorum reducer, the finding classification, the blocker-threshold anti-loop, the pass/fail adversarial verifier with a fresh-context reducer — is Atomic's work, and the credit for it is theirs. If you want the original, go and read it.

**atomic-cc is not affiliated with, endorsed by, or supported by Bastani or Anthropic.** It is a
third-party community project. No Atomic logo, wordmark, brand colour or marketing copy is used
here. "Claude" and "Claude Code" are trademarks of Anthropic, used descriptively to say what this
software is: a plugin for Claude Code.

Full attribution in [`NOTICE`](NOTICE). The web fonts bundled under `docs/fonts/` (Newsreader, IBM
Plex Mono) are third-party software under the SIL Open Font License — see
[`docs/fonts/LICENSE.txt`](docs/fonts/LICENSE.txt).

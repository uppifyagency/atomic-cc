# Changelog

All notable changes to atomic-cc. Versions follow semver; the port's upstream
sync point is recorded in [`upstream.lock`](upstream.lock).

## 0.3.0 — 2026-08-12

Fidelity release. An independent audit compared the port line by line against
upstream `bastani-inc/atomic` and found the gate arithmetic faithful but the
machinery around it diverging. This release closes those divergences, and adds
the regression tests that would have caught them.

### Fixed — run lifecycle (the functional defect)

- **`active_run` is now always cleared.** Every workflow seals a terminal status
  on every exit path. Previously a run that ended `needs_human`/`blocked`/
  `rejected`/`failed` left `active_run` set forever, so `git commit` stayed
  denied in that project in every future session; symmetrically, a `complete`
  run left the gate open for later unrelated commits.
- **The gate applies only while a run is `in_progress`.** Terminal states are
  inert in both directions.
- **All 9 workflows now participate in the lifecycle** (previously 6 never wrote
  run state at all). The four artifact-only workflows — `tournament`,
  `generate-and-filter`, `fan-out-synthesize`, `open-claude-design` — register
  too: their stages run as `atomic:worker` or the default subagent, both
  write-capable, so "writes only its own report" was a prompt and not a
  permission. The invariant is now uniform and tested: every workflow registers
  and seals.
- **A run may only seal itself.** `run-state.sh seal` refuses when a different
  run holds the gate. Without it, a workflow that failed to `begin` (because
  another run held the gate) could still seal its own id and release the gate on
  the run that actually held it.
- **Only a workflow with a review gate mints `approval.json`.** `goal` (quorum
  2/3), `ralph` (unanimous over 2), `adversarial-verification` and
  `loop-until-done` (one independent evaluator — the weakest of the four) seal
  `approved=true`; the other five seal `complete` with `approved=false`.
  `classify-and-act` previously sealed `approved=true` with no review stage at
  all, minting the "independently reviewed" receipt for work no verifier read.
- Hooks now walk up the directory tree, so a session started in a subdirectory
  still sees the run. Previously neither gate found it.

### Fixed — the gate can no longer be opened by a single `Write`

- **New `bin/run-state.sh`**: the only sanctioned writer of `run-state.json` and
  `approval.json`, with validated transitions (`begin`/`seal`/`approve`/`clear`/
  `status`), a status enum, and a refusal to seal `approved=true` on any status
  other than `complete`.
- **New `bin/tamper-guard.sh`** (`PreToolUse: Write|Edit`): denies direct edits
  to `run-state.json`, `approval.json`, and the evidence log, unconditionally.
- The Bash gate additionally denies shell tampering with those files, and now
  catches `gh pr create/merge`, `jj commit`, `git am`, `git cherry-pick`,
  `git update-ref`, and `timeout`/`nohup`-style wrappers.
- **No workflow instructs an agent to write gate files any more**; audit
  artifacts are composed as exact bytes in the workflow's JavaScript and written
  by the new `scribe` agent, which is chartered to transcribe and never author.

### Fixed — `seal` no longer hangs the run

- `run-state.sh seal` read an optional decision document from stdin whenever
  stdin was not a tty. A pipe that is open but never written is not a tty either,
  so the `cat` blocked forever — hanging whichever agent invoked the seal and
  leaving the run `in_progress` with the commit gate shut, which is the one
  failure mode the lifecycle work was meant to eliminate. It was reproduced by
  running the suite under an inherited pipe. Nothing used the feature (reducer
  decisions are composed in JavaScript and transcribed by the scribe), so it is
  gone, and every subcommand is now tested against an open, never-written stdin.

### Fixed — fail-safe instead of fail-open

- Without `jq`, both gates now **deny** rather than silently disabling: the
  approval gate denies commit-shaped commands with an explanatory reason, and the
  tamper guard denies gate-file writes. The evidence logger still disables
  itself, and `verifier.md` now states that a missing evidence log means
  "unverified", never "no contrary evidence".

### Fixed — `goal`

- **`blocked` now fires on the right signal.** Upstream produces `blocked` only
  from a repeated *environment* blocker (`dependency_unavailable`/`tool_failure`);
  code findings always continue. The port had signed the anti-loop over the
  blocking-finding set, so a stable P1 aborted at turn 3 of 10, while three
  reviewers all failing on a missing dependency never tripped the guard at all.
  Both directions are now correct and covered by tests.
- **A crashed reviewer no longer cancels a reached quorum.** Upstream synthesizes
  a non-approving `reviewer_failure` decision and still counts N records: quorum
  is over approvals, not arrivals.
- The three upstream reviewer personas (completion / evidence / risk) are ported
  verbatim, on decorrelated models.
- The audit trail is real: per-reviewer `review-<reviewer>.json`,
  `review-round-latest.json` with `consolidated_findings`, and a
  `goal-ledger.json` with receipts, reviews, blockers, decisions and lifecycle
  events — all persisted, where previously reviewer JSON lived in a local
  variable and was discarded while a `ledger_path` was returned unverified.

### Fixed — `ralph`

- **The loop is a research loop again.** Refinement, research, implementation and
  review all sit inside the bounded iteration, as upstream's does. The port ran
  refine and research once and then only iterated verify→repair, so a run whose
  reviewers discovered the approach was wrong could only patch symptoms against a
  stale brief truncated to 4000 characters.
- **The contract is the user's, not the model's.** `acceptance_criteria` is an
  input defaulting to the raw prompt, injected verbatim into every stage; the
  refinement stage's schema has exactly one field (`research_question`) and no
  place to put criteria. Previously the refinement stage authored the criteria and
  was explicitly allowed to add to the user's.
- **Unapproved work is no longer stranded.** With `create_pr`, an exhausted
  budget opens a DRAFT handoff reproducing every unresolved blocking finding, as
  upstream's `unapprovedHandoff` does.
- `reviewer_count` is the upstream module constant 2 and is not an input.

### Fixed — `/atomic:rigor` is no longer a no-op

- Profiles are written by `bin/rigor.sh` and **injected into session context by a
  SessionStart hook**, so the assistant invoking a workflow actually sees them.
  Previously nothing read `config.json`, which manufactured false confidence in
  exactly the scenario the skill advertised.
- Profiles scale **effort budgets only**. `lean` can no longer reduce the review
  gate to a single reviewer: goal's quorum (2) and ralph's reviewer count (2) are
  constants, matching upstream, and `verifier_count` applies only to
  `adversarial-verification`.

### Fixed — agents

- `verifier`: pins a model (decorrelation), keeps its read-only tool set, and
  gains an explicit read-only discipline — no `--snapshot-update`, no
  `git checkout/restore/stash`, no writing the evidence log it is told to trust.
  The contradiction between "when in doubt, false" and the stage prompts is
  resolved in favour of upstream's derivation rules.
- `worker`: the escalation channel is now read. Escalations travel in structured
  output and route the run to `needs_human` instead of being reported into a void
  while reviewers grade deliberately incomplete work.
- New `scribe` agent for deterministic artifact transcription.
- The six locator/analyzer/researcher charters, `code-simplifier` and `debugger`
  are full ports of the upstream charters, including the prescribed output
  skeletons. Restored: `codebase-analyzer`'s prohibition on speculating about
  defects, `code-simplifier`'s deferral channel, `debugger`'s "never suppress a
  failing test" invariant, and `codebase-online-researcher`'s full-SHA permalink
  rule.

### Added

- **`commands/` — 7 slash commands** porting upstream's `prompts/` layer:
  `/atomic:parallel-review`, `/atomic:review-loop`, `/atomic:parallel-research`,
  `/atomic:parallel-cleanup`, `/atomic:parallel-context-build`,
  `/atomic:parallel-handoff-plan`, `/atomic:gather-context-and-clarify`. This is
  where the research and cleanup subagents earn their keep; five agents that no
  workflow could reach are now reachable.
- **`test/` — 537 assertions**, runnable with `test/run-tests.sh`: hook contracts
  and run-state lifecycle against the real scripts (including the no-jq path),
  gate arithmetic with both reducers executed end to end against mocked agents,
  and structural contracts (manifests, frontmatter, agent references, orphan
  agents, no workflow writing gate files).
- **CI** (`.github/workflows/ci.yml`) running the suite on every push and PR,
  and `test/run-tests.sh` now runs the same shellcheck command locally when the
  binary is present, so a lint failure costs seconds rather than a push. It
  caught two unreachable `case` patterns in the evidence logger on its first run:
  `*"go test"*` swallowed `*"cargo test"*`, and `*"npm test"*` swallowed
  `*"pnpm test"*`.
- Structural tests that count the tree and compare it against every documented
  inventory (README prose, the landing page's specsheet tiles and headings, the
  marketplace description, the test badge). The stale counts they caught on the
  way in — a 4-workflow / 10-subagent / 4-command specsheet, "five hooks" against
  six, `0.2.0` in the limits section — are the reason the check exists.
- `fan-out-synthesize`: upstream's `manifest.json` barrier and per-branch
  artifact files, replacing inline summaries truncated to 2000 characters.
- `classify-and-act`: upstream's deterministic fallback to the proposed category.
  It now always acts; previously it returned `needs_human` and did nothing.
- `ATOMIC_OFFLINE` / `ATOMIC_SKIP_VERSION_CHECK` honoured by the upstream watch,
  which no longer creates state inside your projects (it uses the user cache dir).

### Changed

- `sync-upstream` is now `disable-model-invocation: true` and forbidden from
  editing `bin/`, `hooks/`, or tool grants. It was the only model-invocable skill
  with write access to the gate scripts plus network fetch — the shortest path to
  rewriting the gate.
- `open-claude-design` is relabelled honestly: its critic loop is **original
  work**, not a port of upstream's headless variant. Upstream requires a browser
  and a human annotating a live preview, and exits early without one; the exported
  spec now states it was machine-reviewed only.
- `tournament`: bye assignment corrected (the code contradicted its own comment).
- **One canonical site.** The project served two live landing pages advertising
  themselves as the same document: the HTML canonicalised to `atomic-cc.vercel.app`
  while every badge, `homepage` field and link pointed at the GitHub Pages host.
  Vercel is now the single canonical URL everywhere, and a test enforces it.
- **The landing page was rewritten against the shipped behaviour.** It had
  survived the release describing the bugs rather than the fixes: goal aborting on
  a stubborn code finding, ralph authoring its own acceptance criteria and running
  a repair loop, classify-and-act recording `needs_human` and doing nothing,
  `open-claude-design` presented as upstream's headless variant. It also
  advertised goal's quorum as "configurable, 1–5 reviewers" — the one property the
  plugin exists to provide, sold as adjustable — listed four hooks under a heading
  saying six, told readers the gates fail *open* without `jq`, showed 5 of 12
  slash commands, omitted `scribe` from the subagent table, and claimed
  `sync-upstream` was model-invocable. Fixed, and each specific claim is now
  pinned by a test.
- README and the landing page no longer claim approval "happens outside the
  model" — true of the reducer, not of the token the hook checks — and both now
  state plainly that the gate is discipline for agents, not a sandbox.

## 0.2.0 — 2026-08-11

- All 9 upstream workflows ported (previously 4).
- `upstream.lock` and SessionStart drift detection.
- Landing page and README aligned on the same counts.

## 0.1.0

- Initial port: 4 workflows, 10 subagents, 3 hooks.

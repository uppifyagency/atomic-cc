# Changelog

All notable changes to atomic-cc. Versions follow semver; the port's upstream
sync point is recorded in [`upstream.lock`](upstream.lock).

## 0.4.0 — 2026-08-12

Audit-response release. A second independent audit — run against v0.3.0 at
`19e1749`, comparing it to upstream `bastani-inc/atomic` @ `9c8b6d8` — refuted
the "1:1 replica, fully functional" claim and named fourteen findings. It could
not falsify the reducer arithmetic, the finding-blocking classification, the hard
guards, the gate constants, or the test harness itself; everything it did break
is fixed or disclosed below. Nothing in this release is a claim the tests do not
hold up.

### Fixed — the gate was effectively off

- **`plugin_root` is now required, and every workflow fails closed without it**
  (F10). It was optional, and it appeared in **no usage example anywhere** — so a
  user who followed the documentation got a run with the commit gate, the seal
  and the Stop guard all inert while the docs promised supervision. Nine
  workflows now refuse to start before spawning anything, the error says what is
  missing and where to find it, a `SessionStart` hook prints the value every
  session, and the README documents it as a required argument. Every "skip the
  gate" branch has been deleted rather than left as dead code an agent could be
  told to take.
- **A crashed reviewer no longer fails open** (F4). `goal` counted a quorum of 2
  out of however many reviewers survived, so one dead reviewer silently turned
  2-of-3 review into 2-of-2. Upstream runs reviewers under
  `ctx.parallel(…, { failFast: true })`: any reviewer stage death rejects the
  batch and forces `needs_human`. It now does the same. The port's own test had
  asserted the fail-open behaviour and cited upstream as its authority — that
  test was wrong and has been inverted with the correct citation.
- **`loop-until-done` no longer mints an approval** (F8). It sealed
  `approved=true` on one evaluator's `done: true`, releasing the commit gate on a
  non-quorum judgement upstream has no approval concept for at all. It seals
  `complete false`; the evaluator's independence is kept, the certification it
  cannot support is gone.

### Fixed — bypasses the gate hooks did not see

Each of these was reproduced by the auditor against v0.3.0 and is now covered by
a test that replays it:

- `cd .atomic-cc/runs/<id> && printf … > approval.json` — a `cd` into the state
  directory is denied outright, because once the shell is inside it every
  redirection is a bare filename no matcher can attribute (F1).
- `printf … > ./.atomic-cc//runs/<id>/approval.json` — paths are normalised
  before matching (F1).
- `D=.atomic-cc/runs/x; printf … > $D/approval.json` — the matcher now looks for
  the state directory and a write operator anywhere in the command (F1).
- `rm -rf .atomic-cc`, `mv .atomic-cc .atomic-cc-off` — destroying the audit
  trail is a write (F1).
- `echo 3 > .atomic-cc/.state/stop-blocks-<run>` — pre-spending the Stop guard's
  own counter (F2).
- `git 'commit'`, `git c'ommit'` — each character may be individually quoted (F12).
- `git merge/revert/rebase/tag/notes/apply/update-ref/commit-tree/stash`,
  `gh pr ready`, `glab mr create`, `hub pull-request`, `sl`, `hg` — the matcher
  covered `commit`/`push` and little else (F12).
- **Duty 2 is reachable without `jq`** (F7). The degraded branch exited before
  the state-protection check, so on a machine without `jq` an agent could forge
  `approval.json` and the gate would honour it once `jq` returned. Both duties now
  run `jq`-free.
- **The hooks and the CLI now resolve the project root the same way** (F6). The
  hooks anchored at `CLAUDE_PROJECT_DIR`; the CLI at the git toplevel of the
  caller's cwd. In a monorepo, a submodule, or a session opened one directory
  above the repo they disagreed and the gate was inert for whole runs with no
  adversarial intent at all. All three consumers share one ordered candidate
  list, and each checks every candidate.
- **An approval must point at a review** (F3, partial). `seal … true` is refused
  unless a review, verification or decision record exists for that run, and
  `approve` no longer writes `human: true` when it cannot see a tty — it records
  the channel it was actually invoked through. This does **not** close F3: an
  agent holding `Bash` can still call the CLI. That is now stated in the README,
  in the landing page and in the hook's own header instead of implied away.

### Fixed — divergences that were real but invisible

- **`tournament` discloses its fallbacks** (F11). Upstream aborts on a dead
  attempt or a dead judge; this port substitutes a walkover and
  "lower index advances", because a sandboxed workflow cannot retry a stage the
  way the upstream runtime can. The divergence stays, but a caller reading
  `winner` could not tell judgment from an index comparison. Every exit now
  returns `bracket_integrity` — `degraded`, the walkovers, how many matches were
  decided by judgment versus fallback, and a sentence naming what upstream would
  have done instead.
- **`adversarial-verification` persists every verification round** (F13). The
  per-verifier reports existed only inside the reducer's prompt; the only durable
  record of a round was the reducer's own conclusion — the one artifact an auditor
  most needs to check against its inputs. Each round is now written to
  `verification-r<n>.json` **before** reducing, naming any verifier that returned
  nothing, and it doubles as the review evidence `seal … true` requires.

### Fixed — attribution

- **`NOTICE` no longer claims "It bundles NO Atomic code"** (F5). The auditor
  measured 88 normalised lines of ≥60 characters byte-identical to upstream (52
  in `goal.js`, 33 in `ralph.js`, 3 in `tournament.js`), and that is a floor —
  only `workflows/*.js` was measured. `NOTICE` now explains what is copied
  deliberately (prompt text, because here the prompt *is* the specification) and
  what is re-derived (the executable logic), and `LICENSE` carries the Bastani
  copyright line MIT asks for.

### Fixed — published counts

- **Every documented count and version is pinned by a test** (F14). The landing
  page carried `0.2.0` in five places through a release that had shipped `0.3.0`,
  and the workflow/agent/hook counts disagreed between the README, the landing
  page and the marketplace description. The suite now derives each count from the
  tree and fails on drift, including the assertion count in the badge.

### Tests

- **657 assertions** (up from 537), four suites, all passing. New coverage:
  every reproduced bypass above; every workflow refusing without `plugin_root`
  and spawning nothing first; `tournament`'s degraded-bracket disclosure on three
  paths (walkover, judgeless, clean); `adversarial-verification`'s round
  persistence including a dead verifier; and a check that the landing page's
  own examples are de-tagged before matching, because the previous check silently
  matched nothing and passed.

### Still open, and stated as such

- **F3 cannot be closed by a regex.** An agent with `Bash` can invoke
  `run-state.sh`. The evidence requirement raises the cost; it is not a boundary.
- **No live end-to-end run has been executed.** The workflows are driven against
  mocked agents. That is real behavioural testing of the scripts, not proof of a
  production run.
- **Upstream's runtime packages and skills layer are not ported**, by design —
  see the declared divergences in the README.

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

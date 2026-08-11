# atomic-cc

[![License: MIT](https://img.shields.io/badge/license-MIT-1d1c18)](LICENSE)
[![Version](https://img.shields.io/badge/version-0.1.0-b8431f)](.claude-plugin/plugin.json)
[![Claude Code](https://img.shields.io/badge/Claude%20Code-%E2%89%A5%202.1.154-1d1c18)](https://docs.claude.com/en/docs/claude-code)
[![Landing page](https://img.shields.io/badge/docs-landing%20page-b8431f)](https://uppifyagency.github.io/atomic-cc/)

**A verification harness that runs inside Claude Code — as a plugin, and nothing else.** There is no
separate CLI to learn, no daemon to keep alive, no service to sign up for and no API key of its own.
You install it into the Claude Code session you already use, and four workflows, ten subagents, four
slash commands and three enforcement hooks appear at the prompt. Approval is decided by a
deterministic reducer that lives outside the model, and `git commit` stays denied until that
approval is sealed.

Port of [Atomic](https://github.com/bastani-inc/atomic) (bastani-inc, MIT) into a native Claude Code plugin: schema-validated workflow stages, fresh-context adversarial verification, deterministic reducers, real-command evidence logs, and commit gates — all built on officially documented Claude Code primitives.

> **Independent port.** Not affiliated with, endorsed by, or supported by Bastani or Anthropic.
> Bundles no Atomic code. See [Licence & attribution](#license--attribution) and [`NOTICE`](NOTICE).

**[Landing page →](https://uppifyagency.github.io/atomic-cc/)**

## What you get

| Piece | What it does |
|---|---|
| `/atomic:adversarial-verification` | worker → N fresh-context pass/fail verifiers → LLM reducer with unanimity override → bounded repair |
| `/atomic:goal` | bounded implementation loop with ledger, immutable acceptance criteria, 2-of-3 reviewer quorum, blocker-threshold anti-loop, optional PR |
| `/atomic:ralph` | refine → parallel codebase research → implement → unanimous review gate → bounded repair → optional PR |
| `/atomic:fan-out-synthesize` | partition → bounded parallel branches (max_concurrency) → evidence synthesis barrier |
| subagents | worker, debugger, code-simplifier + 6 read-only research agents = the **9 subagents ported from Atomic**, plus 1 CC-specific `verifier` (Atomic runs verifiers as fresh-context workflow stages, not a named subagent; CC needs a named `agentType`) |
| Evidence logger (hook) | every build/test/typecheck Bash call from ANY agent logged with real stdout/stderr to `.atomic-cc/evidence/` |
| Approval gate (hook) | `git commit` / `git push` denied while a run is active and unapproved |
| Stop guard (hook) | turns can't silently end with a run `in_progress` (bounded, anti-loop) |
| `/atomic:status` `/atomic:approve` `/atomic:resume` `/atomic:rigor` | run inspection, human approval override, cross-session re-entry, rigor profiles |

## Requirements

- Claude Code ≥ 2.1.154 (dynamic workflows), paid plan; on Pro enable workflows in `/config`.
- `jq` on PATH (hooks fail open without it: the logger and gates silently disable — documented tradeoff).
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
├── run-state.json          # {"active_run": "...", "status": "in_progress|complete|needs_human|incomplete"}
├── evidence/<session>.jsonl# real command logs written by the PostToolUse hook
└── runs/<run_id>/
    ├── receipt-*.json      # worker receipts {turn, stage, artifact_path, summary}
    ├── ledger.jsonl        # goal-workflow ledger
    ├── decision.json       # last reducer decision when not complete
    └── approval.json       # written ONLY by the reducer on complete, or by /atomic:approve
```

Add `.atomic-cc/` to `.gitignore` unless you want run history in the repo.

## Design guarantees (and honest limits)

The enforcement is deterministic and lives OUTSIDE the model. Convergence is ported faithfully from Atomic (`goal-reducer.ts`, `ralph-review-gate.ts`): the reviewer's `stop_review_loop` boolean is the single authoritative approval signal, and the reducer completes on a **quorum** of approving reviewers (goal: 2 of 3; ralph and adversarial: unanimous) — it never recomputes approval from findings/traceability, which Atomic deleted because it deadlocked runs whose criteria referenced the review process itself. The finding-blocking rules (`isBlocking`, ported bit-for-bit from `review-convergence.ts`) build the **repair payload** handed to the next worker turn, not the gate. goal adds Atomic's blocker-threshold anti-loop (same blocker 3 turns → `blocked`) and its status set (`complete`/`blocked`/`needs_human`). A `reviewer_error` does not approve but never aborts the run. adversarial-verification uses Atomic's lean pass/fail verifier + fresh-context LLM reducer with a deterministic unanimity override. Schemas validate verifier output; hooks block unapproved commits and silent abandonment.

What it cannot do: prevent a model from reasoning badly — it can only prevent bad reasoning from becoming an unverified commit. Known gaps vs upstream Atomic (all deliberate CC adaptations): no `context:"fork"` stages; workflow resume with cached results is same-session only (cross-session re-entry goes through `/atomic:resume` + persisted artifacts); no mid-run human prompts (use `/atomic:approve` and phase-splitting instead); Atomic's file-based `ctx.task` artifact plumbing (`reads`/`output`) is emulated by having agents read/write project files under `.atomic-cc/`.

Two things to verify empirically on first run (undocumented API surface): whether `agentType` wants the namespaced name (`atomic:verifier`) or the bare one — the runtime error lists accepted names — and your plan's workflow availability.

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

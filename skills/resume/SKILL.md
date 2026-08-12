---
name: resume
description: Resume an interrupted or needs_human atomic run from its persisted state — ledger, receipts, and decision drive the re-entry.
disable-model-invocation: true
allowed-tools: Read, Glob, Bash, Workflow
---
Resume an atomic run in this project. The workflow runtime's own resume works only within the same session; this skill performs the cross-session logical re-entry from persisted artifacts.

Steps:

1. Run `"${CLAUDE_PLUGIN_ROOT}"/bin/run-state.sh status` (a run id in $ARGUMENTS overrides `active_run`). If the status is `complete`, report that there is nothing to resume and stop.
2. Reconstruct where the run stopped from `.atomic-cc/runs/<run_id>/`:
   - the highest-numbered `turn-*/` or `iter-*/` directory and its receipt/report = last completed implementation stage;
   - the latest `review-round-latest.json` = the last review round, its per-reviewer verdicts, and its `consolidated_findings`;
   - `decision.json` = the terminal decision, including unresolved blocking findings, unproven requirements, and any `escalation` or `failure_reason`.
3. Report the reconstruction to the user in 3–5 lines, and say explicitly which of the three terminal shapes this is, because they resume differently:
   - **escalation** — the worker stopped for a product/architecture/scope decision. Do NOT re-enter the workflow: put the question to the user, get the decision, and pass it as part of the objective on re-entry.
   - **blocked** — a repeated environment blocker (dependency or tool failure) tripped the threshold. Re-entering unchanged will reproduce it; fix or report the environment first.
   - **needs_human** — the budget ran out without the gate converging. Re-entry is meaningful.
4. Re-enter by invoking the SAME workflow the run came from (the ledger and decision record it; ask the user if ambiguous), passing:
   - the same `run_id`, so artifacts append instead of forking;
   - the ORIGINAL objective and acceptance criteria VERBATIM from `decision.json` / the ledger. Never re-derive or paraphrase the contract — a resumed run that re-authors its own criteria is a different run wearing the same id;
   - the unresolved blocking findings from the latest review round, so the first implementation turn targets them;
   - `plugin_root` set to `${CLAUDE_PLUGIN_ROOT}`, so the re-entered run can register and seal gate state.
5. If the run left state `in_progress` (an interrupted session: Esc, `/clear`, a crash — the Stop hook cannot see those), the gate is still holding commits for it. Re-entering is the normal fix; `bin/run-state.sh clear` is the escape hatch if the user wants to abandon the run instead.
6. If this same session previously ran the workflow, prefer the runtime's native resume (cached agent results) over a fresh invocation.

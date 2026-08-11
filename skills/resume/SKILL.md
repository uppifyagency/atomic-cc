---
name: resume
description: Resume an interrupted or needs_human atomic run from its persisted state — receipts, ledger, and decision drive the re-entry.
disable-model-invocation: true
allowed-tools: Read, Glob, Bash, Workflow
---
Resume an atomic run in this project. The workflow runtime's own resume only works within the same session; this skill performs the cross-session "logical" re-entry from persisted artifacts.

Steps:

1. Read `.atomic-cc/run-state.json` (run id from $ARGUMENTS overrides `active_run`). If the status is `complete`, report that there is nothing to resume.
2. Reconstruct where the run stopped from `.atomic-cc/runs/<run_id>/`:
   - the highest-numbered receipt (or last ledger line) = last completed implementation stage;
   - `decision.json` = the last reducer decision (blockers, unproven requirements, errors).
3. Report the reconstruction to the user in 3–5 lines.
4. Re-enter the run by invoking the SAME workflow the run came from (the ledger/receipts indicate it; ask the user if ambiguous), passing:
   - the same `run_id` (artifacts append rather than fork),
   - the ORIGINAL task/objective and criteria verbatim (find them in the first receipt or ledger line; ask the user if not recorded),
   - the open blockers from `decision.json` folded into the task description so the first worker turn targets them.
5. If this session previously ran the workflow, prefer the runtime's native resume (cached agent results) over a fresh invocation.

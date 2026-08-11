---
name: approve
description: Human approval gate — seal an atomic run as approved, unlocking the git commit gate. Only the user can invoke this.
disable-model-invocation: true
allowed-tools: Read, Write, Bash
---
Seal a HUMAN approval for an atomic run. This is the human override channel of the deterministic gate: it must never be invoked autonomously, only when the user explicitly ran `/atomic:approve`.

Steps:

1. Determine the run id: $ARGUMENTS if given, otherwise `active_run` from `.atomic-cc/run-state.json`. If neither exists, say there is nothing to approve and stop.
2. Show the user what they are approving BEFORE writing anything: the run's status from run-state, the latest decision from `.atomic-cc/runs/<run_id>/decision.json` if present (blockers and unproven requirements included), and the latest receipt summary.
3. If the run's own reducer did NOT reach "complete", state plainly that this approval overrides an unconverged verification — the blockers just listed will be committed unreviewed.
4. Write `.atomic-cc/runs/<run_id>/approval.json` with exactly:
   `{"approved": true, "human": true, "run_id": "<run_id>"}`
5. Confirm: the commit gate for this run is now open.

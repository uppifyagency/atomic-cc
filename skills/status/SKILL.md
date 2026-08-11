---
name: status
description: Show the state of atomic runs in this project — active run, status, receipts, decision, approval, and evidence log summary.
disable-model-invocation: true
allowed-tools: Read, Glob, Bash
---
Report the state of atomic-cc runs in the current project. Steps:

1. Read `.atomic-cc/run-state.json`. If missing, report "no atomic run in this project" and stop.
2. For the `active_run` (or the run id passed as $ARGUMENTS if given), inspect `.atomic-cc/runs/<run_id>/`:
   - list receipts (`receipt-*.json`) and the ledger (`ledger.jsonl`) if present, with their `summary` lines;
   - read `decision.json` if present: report blockers (title, path, priority, alignment) and unproven requirements;
   - check `approval.json`: report whether the run is approved and whether the approval was human (`"human": true`) or reducer-sealed.
3. Summarize `.atomic-cc/evidence/*.jsonl` if present: count entries per kind (build/test/typecheck) and report the last 3 entries (command + first line of stdout/stderr).
4. End with the practical state: what is blocked (e.g. "git commit is gated until approval"), and the next available action (`/atomic:approve`, `/atomic:resume`, or nothing).

Keep the report compact and factual — this is a status readout, not an analysis.

---
name: status
description: Show the state of atomic runs in this project — active run, status, receipts, decision, approval, rigor profile, and evidence log summary.
disable-model-invocation: true
allowed-tools: Read, Glob, Bash
---
Report the state of atomic-cc runs in the current project. Steps:

1. Run `"${CLAUDE_PLUGIN_ROOT}"/bin/run-state.sh status`. If it prints `none`, report "no atomic run registered in this project", still do step 5, and stop.
2. For the `active_run` (or the run id passed as $ARGUMENTS), inspect `.atomic-cc/runs/<run_id>/`:
   - the ledger (`goal-ledger.json`) and per-turn/per-iteration directories: report turns completed and the latest receipt summary;
   - `decision.json`: report the terminal status, unresolved blocking findings (title, path, priority, alignment), unproven requirements, and any `escalation` or `failure_reason`;
   - the latest `review-round-latest.json`: report each reviewer's verdict and whether the round met its gate (goal: quorum 2 of 3; ralph: unanimous 2 of 2);
   - `approval.json`: report whether the run is approved and whether the approval was human (`"human": true`) or reducer-sealed.
3. Summarize `.atomic-cc/evidence/*.jsonl` if present: count entries per kind (build/test/typecheck) and report the last 3 entries (command + first line of output). If the log is absent, say so explicitly — absent evidence is "unverified", not "clean".
4. Report the practical state: whether commits are currently gated (they are only while status is `in_progress` without approval), and the next available action (`/atomic:approve`, `/atomic:resume`, `bin/run-state.sh clear` for a stale run, or nothing).
5. Report the rigor profile: `"${CLAUDE_PLUGIN_ROOT}"/bin/rigor.sh show`.

Keep the report compact and factual — this is a status readout, not an analysis.

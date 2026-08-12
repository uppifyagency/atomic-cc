---
name: approve
description: Human approval gate — seal an atomic run as approved, unlocking the git commit gate. Only the user can invoke this.
disable-model-invocation: true
allowed-tools: Read, Glob, Bash
---
Seal a HUMAN approval for an atomic run. This is the human override channel of the gate: it must never be invoked autonomously, only when the user explicitly ran `/atomic:approve`.

Approval is written by `bin/run-state.sh approve`, never by an editor: the tamper-guard hook denies direct writes to `approval.json`, and that is deliberate — the CLI validates the run exists and stamps the human flag itself.

Steps:

1. Determine the run id: $ARGUMENTS if given, otherwise `active_run` from `"${CLAUDE_PLUGIN_ROOT}"/bin/run-state.sh status`. If there is no run, say there is nothing to approve and stop.
2. Show the user what they are approving BEFORE running anything: the run's status, the latest decision from `.atomic-cc/runs/<run_id>/decision.json` if present (including unresolved blocking findings and unproven requirements), and the latest receipt or ledger summary.
3. If the run's own reducer did NOT reach `complete`, state plainly that this approval overrides an unconverged verification, and list the blocking findings that will be committed unreviewed. Do not soften this.
4. Run: `"${CLAUDE_PLUGIN_ROOT}"/bin/run-state.sh approve <run_id>`
5. Confirm what changed: the commit gate for this run is now open, and the approval is recorded with `"human": true` so a later reader can tell it apart from a reducer-sealed one.

Note: a run sealed as `blocked`, `needs_human`, `rejected`, or `failed` no longer gates commits at all — the gate applies only while a run is `in_progress`. If the user wants to commit unrelated work and a stale run is in the way, `bin/run-state.sh clear` releases it without fabricating an approval; prefer that over approving work nobody reviewed.

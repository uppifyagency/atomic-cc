---
name: rigor
description: Set the rigor profile for atomic runs in this project — lean, standard, or thorough — scaling effort budgets (turns, loops, repairs) to task risk. Gate strength is not configurable.
disable-model-invocation: true
allowed-tools: Bash, Read
---
Set the atomic-cc rigor profile for this project. A profile scales EFFORT BUDGETS to the task's risk. It does not, and cannot, change how strong the review gate is.

| Profile | max_turns / max_loops | verifier_count* | max_repairs | When |
|---|---|---|---|---|
| lean | 5 | 1 | 1 | Small low-risk changes, prototypes |
| standard | 10 | 3 | 2 | Default engineering work |
| thorough | 20 | 5 | 4 | Money paths, auth, data migrations |

\* `verifier_count` applies only to `adversarial-verification`, whose upstream default is 3 (clamp 1–5). It does **not** apply to `goal` or `ralph`: goal's review quorum is 2 and ralph's reviewer count is 2, both module constants upstream and constants in this port. No profile can reduce either gate to a single reviewer — "unanimity 1/1" is not a gate, and a rigor setting that could weaken verification would be worse than no setting at all.

How the profile actually reaches a run (this is the part that used to be missing):

1. `bin/rigor.sh set <profile>` writes `.atomic-cc/config.json`.
2. The plugin's SessionStart hook (`bin/rigor.sh notice`) prints the active profile and its budgets into session context, so the assistant invoking a workflow sees them without reading any file.
3. When you invoke an atomic workflow in this project, pass those budgets as workflow args. `bin/rigor.sh args` prints the exact JSON fragment to merge.

Steps:

1. Parse $ARGUMENTS. With `lean`, `standard`, or `thorough`, run `"${CLAUDE_PLUGIN_ROOT}"/bin/rigor.sh set <profile>`. With no argument (or `show`), run `"${CLAUDE_PLUGIN_ROOT}"/bin/rigor.sh show` and report the current profile. With `clear`, run `"${CLAUDE_PLUGIN_ROOT}"/bin/rigor.sh clear`.
2. Report the resulting budgets to the user, and state plainly which knobs are effort-only and that the gate quorums are fixed.
3. Tell the user the profile takes effect for workflows invoked from a session that starts after this one (the notice is a SessionStart hook), or immediately if they pass the budgets explicitly now.

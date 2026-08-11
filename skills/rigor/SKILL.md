---
name: rigor
description: Set the rigor profile for atomic runs in this project — lean, standard, or thorough — scaling verifier count and repair budget to task risk.
disable-model-invocation: true
allowed-tools: Read, Write
---
Set the atomic-cc rigor profile for this project. Profiles scale the verification effort to the task's risk, like Atomic's and nWave's rigor settings.

| Profile | verifier_count | max_repairs | When |
|---|---|---|---|
| lean | 1 | 1 | Small low-risk changes, prototypes |
| standard | 3 | 2 | Default engineering work |
| thorough | 5 | 4 | Money paths, auth, data migrations |

Steps:

1. Parse $ARGUMENTS: one of `lean`, `standard`, `thorough`. With no argument, read `.atomic-cc/config.json` and report the current profile (default: standard).
2. Write `.atomic-cc/config.json` with:
   `{"rigor": "<profile>", "verifier_count": <n>, "max_repairs": <n>}`
3. Confirm to the user, and remind them the profile applies when workflows are invoked WITHOUT explicit `verifier_count`/`max_repairs` args — explicit args always win. When you later invoke an atomic workflow for this project, read this file and pass its values as workflow args.

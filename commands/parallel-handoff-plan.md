---
description: Parallel external + local atomic research builders into an implementation handoff plan
argument-hint: [request, URL, issue, PR, plan, or focus]
---

## Goal

Produce a grounded implementation handoff plan and implementation-ready meta-prompt by comparing applicable external evidence, local behavior, established patterns, and prior decisions.

Primary request, target, or focus:

$ARGUMENTS

## Constraints and tools

First read or fetch every URL, issue, PR, screenshot, plan, doc, or local file named in the request; these define primary scope. Then spawn the chosen specialists with the Agent tool as parallel calls in a single message; each runs with fresh context. Synthesize the results yourself rather than launching a synthesizer subagent.

Choose specialists by evidence need:

- Use `subagent_type: "atomic:codebase-online-researcher"` when external projects, libraries, docs, APIs, recent changes, or best practices could shape the plan. It should inspect linked projects, docs, issues, examples, source, or prompt guidance; identify behavior, APIs, implementation files, constraints, and transferable ideas; prefer direct fetches of primary sources (trying `/llms.txt` or markdown-friendly endpoints where available); persist high-value sources to `research/web/<YYYY-MM-DD>-<topic>.md`; and return links, repo paths, evidence, risks, and implementation implications.
- Use `"atomic:codebase-locator"` for non-trivial code changes to map relevant local files, tests, fixtures, and configs by purpose.
- Use `"atomic:codebase-analyzer"` when local behavior matters to trace the located implementation, control flow, transformations, and constraints with `file:line` citations. Locator and analyzer cover where the work lives and how it works without overlap.
- Add `"atomic:codebase-pattern-finder"` when analogous implementations or conventions could shape the plan; include useful snippets with `file:line` references.
- Add `"atomic:codebase-research-locator"` then `"atomic:codebase-research-analyzer"` when prior `research/` or `specs/` may apply. The locator finds relevant dated docs; the analyzer extracts current decisions, constraints, and lessons while flagging superseded guidance. Run them sequentially, or include both in the parallel step with distinct scopes when the dependency is already resolved (you already know which documents the analyzer should read).

Give each task a distinct evidence angle so contributions do not overlap, for example: external-reference, local-files, local-flow, local-patterns, prior-research. If the user wants the intermediate evidence persisted, write it under a `handoff/` directory outside the repository (session scratchpad); do not persist these artifacts in the repository unless the user explicitly requests it.

Delegate only independent work too large for a handful of tool calls; do not delegate auditing your own work, and prefer one subagent over several. Parallelize independent reads; stay sequential when one result determines the next; synthesize after retrieval. Keep work within the requested scope.

## Output

Compare external evidence with local architecture and write `handoff/final-handoff-plan.md` yourself, or summarize inline when no persisted artifact was requested. The downstream writer needs roughly 700–1,200 words covering: intended behavior; lessons from external references; local implications; recommended approach; likely files; constraints and non-goals; edge cases, validation commands, risks, and approval decisions; unresolved questions; and a compact implementation-ready meta-prompt.

Then give the user a concise summary with the recommendation, artifact paths, final meta-prompt, and remaining questions or assumptions. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition; stay readable rather than compressed into fragments.

Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.

## Stop rule

Done means discovery evidence has been compared, the final handoff exists at the requested destination or inline, and the user has the recommendation, paths, meta-prompt, and unresolved decisions. Do not start implementation unless the user explicitly asks.

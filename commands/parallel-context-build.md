---
description: Parallel atomic codebase specialists building handoff context for planning
argument-hint: [request, target, URL, issue, plan path, or focus]
---

## Goal

Build grounded, implementation-ready handoff context for the next planner or writer without starting implementation.

Primary request, target, or focus:

$ARGUMENTS

## Constraints and tools

Spawn the chosen specialists with the Agent tool as parallel calls in a single message; each runs with fresh context. Assign every task a distinct handoff angle so contributions do not overlap, such as:

- `where-it-lives` (locator)
- `how-it-works` (analyzer)
- `existing-patterns` (pattern-finder)
- `prior-research` (research locator + analyzer)

If the user wants persisted artifacts, write each specialist's handoff outside the repository (for example under a `context-build/` directory in the session scratchpad); do not persist context artifacts in the repository unless the user explicitly requests it.

Read or fetch any supplied URL, issue link, file path, plan path, or freeform request before assigning angles, and pass that target into every specialist task. Choose two to four specialists according to the request:

- **Locate — `subagent_type: "atomic:codebase-locator"`:** map every relevant file, directory, test, fixture, config, and doc by purpose, using full repo-root paths.
- **Analyze — `"atomic:codebase-analyzer"`:** trace entry points, control flow, data transformations, side effects, and error handling with `file:line` citations.
- **Pattern-find — `"atomic:codebase-pattern-finder"`:** provide comparable implementations, test patterns, conventions, and useful code snippets.
- **Prior research — `"atomic:codebase-research-locator"` then `"atomic:codebase-research-analyzer"`:** when `research/` or `specs/` history applies, run the locator first, then feed its findings to the analyzer to extract current decisions, constraints, and rationale. This pair is sequential; the other specialists can run in parallel with it.

For an issue or PR URL, include locator and analyzer coverage of mentioned files. For a plan, cover its files and their current behavior. For external API/library work, add `"atomic:codebase-online-researcher"` for current primary sources. For a large refactor, emphasize module-boundary and dependency-direction patterns. For UI/product work, cover analogous components and the surrounding render path.

Every specialist is read-only and produces a compact handoff containing only its unique contribution, ending with `## Open Questions`. Delegate only independent work too large for a handful of tool calls; do not delegate auditing your own work, and prefer one subagent over several. Parallelize independent reads; stay sequential when one result determines the next; synthesize after retrieval. Keep work within the requested scope.

## Output

Synthesize the specialists' handoffs for the downstream planner or writer into roughly 500–900 words: the most important context, a compact implementation-ready meta-prompt, open questions or assumptions, and artifact paths when artifacts were persisted. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition; stay readable rather than compressed into fragments.

Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.

## Stop rule

Done means the selected specialists have returned their distinct handoffs and the downstream synthesis names its evidence (and artifact paths, if persisted). Do not implement unless the user explicitly asks.

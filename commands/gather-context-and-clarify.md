---
description: Use atomic subagents to gather codebase context, then ask clarifying questions
argument-hint: [request or topic needing context]
---

## Goal

Build enough grounded codebase context to ask only the unresolved questions needed before planning or implementation. Use a small parallel fan-out, typically two or three specialists with distinct angles.

Additional request context:

$ARGUMENTS

## Constraints and tools

Spawn specialists with the Agent tool, choosing according to what is unknown: `subagent_type: "atomic:codebase-locator"` for relevant files, directories, tests, and configs; `"atomic:codebase-analyzer"` for current behavior with `file:line` references; `"atomic:codebase-pattern-finder"` for implementations or patterns to model; `"atomic:codebase-research-locator"` for relevant prior docs, tickets, notes, or specs in `research/` and `specs/`; `"atomic:codebase-research-analyzer"` for applicable historical decisions, constraints, and trade-offs; and `"atomic:codebase-online-researcher"` for authoritative external evidence only when it could materially change the answer.

Give each specialist a specific meta-prompt and keep every specialist read-only. Delegate only independent work too large for a handful of tool calls; do not delegate auditing your own work, and prefer one subagent over several. Launch independent specialists as parallel Agent calls in a single message; stay sequential when one result determines the next (issue the dependent Agent call only after the prior result returns); synthesize after retrieval. Keep work within the requested scope.

## Output

Synthesize a concise, user-facing brief of roughly 300–600 words: established facts with evidence, remaining implementation-relevant uncertainties, and focused questions. Then ask the user those unresolved questions directly in your reply so you reach shared understanding. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition; stay readable rather than compressed into fragments.

Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.

## Stop rule

Done means the specialists have returned concise findings and remaining clarification questions, their evidence has been synthesized, and the unresolved questions have been put to the user. Do not plan or implement in this step.

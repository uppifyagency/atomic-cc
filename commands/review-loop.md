---
description: Atomic specialist review/fix loop until clean (default cap 3 rounds)
argument-hint: [target, implementation request, max-iteration cap, or review focus]
---

## Goal

Run a parent-orchestrated review-and-fix loop for the requested work until the current scope is clean, blocked on an unapproved decision, or capped. You (the parent) control the loop and make final decisions; children receive concrete role-specific tasks and must not launch subagents or manage the loop.

Additional target, implementation request, max-iteration cap, or review focus from the slash command invocation:

$ARGUMENTS

## Constraints and tools

Spawn all children with the Agent tool using specialist roles rather than a generic worker or reviewer. Use one writer per pass: `subagent_type: "atomic:debugger"` for bugs, correctness/regression fixes, or behavior changes; `"atomic:code-simplifier"` for cleanup, refinement, or simplification. Reviewer options are `"atomic:codebase-analyzer"` for correctness and flow, `"atomic:debugger"` in inspect-only mode (explicitly instructed not to edit) for failure modes, `"atomic:codebase-pattern-finder"` for consistency, `"atomic:codebase-online-researcher"` for external conformance, and `"atomic:codebase-research-locator"` then `"atomic:codebase-research-analyzer"` for prior decisions.

Default to at most 3 review rounds unless the invocation sets another cap. A round is a fresh-context inspection of the current diff after a writer pass.

If the invocation requests implementation, first launch one writer for the approved scope: `"atomic:debugger"` for correctness-shaped work or `"atomic:code-simplifier"` for refinement-shaped work, and wait for its handoff before reviewing. If the current diff is already the target, begin with review. Because child launches are non-interactive, resolve open questions with the user first. Use one writer against the working tree at a time unless the user explicitly requests isolated worktrees.

Each review round uses fresh context: launch the chosen reviewers as parallel Agent calls in a single message. Reviewers inspect repository instructions, relevant files, and the current diff directly (`git diff`, `git status`, targeted reads), without main-conversation history, and must not edit; explicitly put `debugger` in inspect-only mode. Choose angles from the change. Common angles are correctness/regressions, failure modes, and pattern fit; add external-spec or prior-decision coverage when applicable. Prefer three strong reviewers over many vague ones.

Delegate only independent work too large for a handful of tool calls; do not delegate auditing your own work, and prefer one subagent over several. Parallelize independent reads; stay sequential when one result determines the next; synthesize after retrieval. Keep work within the requested scope.

After each round, synthesize blockers or scope/product/architecture decisions needing approval, fixes worth doing now, optional improvements, and feedback to ignore or defer with a short reason. Assess findings rather than applying them blindly. Pause for the user's approval before a writer acts on any unapproved product, scope, or architecture decision.

An implementation writer's handoff transitions into review; it is not final completion unless the user requested writer-only work, review-only output, or a stop after implementation. When implementation is authorized and fixes are worth doing now, launch one writer to apply only the synthesized fixes—`"atomic:debugger"` for correctness or `"atomic:code-simplifier"` for cleanup. Require it to preserve approved scope, run focused validation, and report changed files, commands with exit codes, validation evidence, surprises, and unfinished work.

Run another review round after a fix only when it made material changes or addressed non-trivial findings. Do not loop for optional polish, speculative improvements, or already deferred findings.

## Output

On completion, inspect the final diff and run or confirm appropriate focused validation. Return a concise, user-facing summary of roughly 300–700 words: why the loop stopped, rounds run, fixes applied, validation, remaining blockers or deferred items, and next steps. Lead with the outcome; keep facts, decisions, caveats, and next steps; drop background and repetition; stay readable rather than compressed into fragments.

Before reporting progress, audit each claim against a tool result from this session. Report only work you can point to evidence for; say so explicitly when something is unverified.

## Stop rule

Stop and summarize when reviewers find no blockers or fixes worth doing now; remaining feedback is optional, speculative, or intentionally deferred; an unapproved decision needs the user; or the review-round cap is reached. The loop is done only after the final diff and focused validation have been inspected or explicitly reported as unverified.

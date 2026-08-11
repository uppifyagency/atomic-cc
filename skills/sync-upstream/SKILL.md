---
name: sync-upstream
description: Sync the atomic-cc port with upstream bastani-inc/atomic — review upstream commits since the last synced SHA, apply behavior changes to the port, bump the plugin version, and update upstream.lock. Run when the SessionStart upstream watch reports drift, or on demand.
allowed-tools: Read, Grep, Glob, Edit, Write, Bash, WebFetch, Agent
---
Bring the atomic-cc port back in sync with upstream `bastani-inc/atomic`. The port is a
clean-room behavioral port, NOT a mirror: never copy upstream code verbatim — re-derive
behavior (inputs, defaults, clamps, gate rules, statuses, artifacts) and adapt it to the
Claude Code workflow constraints already used by the existing files.

The plugin root is the directory containing this skill's `../../.claude-plugin/plugin.json`
(resolve it via `${CLAUDE_PLUGIN_ROOT}` when set, else from this file's path).

Steps:

1. Read `upstream.lock` in the plugin root → `sha` is the last synced upstream commit.
2. Get upstream HEAD: `git ls-remote https://github.com/bastani-inc/atomic.git HEAD`.
   If it equals the lock's `sha`, report "already in sync" and stop.
3. Review what changed. Use the GitHub compare API (no clone needed):
   `https://api.github.com/repos/bastani-inc/atomic/compare/<synced_sha>...<head_sha>`
   (WebFetch, paginate if needed). Classify the changed files:
   - `packages/workflows/builtin/**` → PORT-RELEVANT (workflow behavior)
   - `packages/subagents/agents/**` → PORT-RELEVANT (agent definitions)
   - `packages/coding-agent/docs/workflows.md`, `docs/subagents.md` → PORT-RELEVANT (contracts)
   - releases/changelog entries mentioning workflow inputs/defaults/gates → PORT-RELEVANT
   - everything else (TUI, providers, sessions, compaction, intercom, natives, CI,
     dependabot) → runtime-level, NOT port-relevant; list it but do not act on it.
4. For each PORT-RELEVANT change, fetch the file at the new SHA
   (`https://raw.githubusercontent.com/bastani-inc/atomic/<head_sha>/<path>`), determine the
   behavioral delta (new/removed workflow, changed input/default/clamp, changed gate or
   status rule, changed agent contract), and apply the equivalent change to the port:
   - workflows → `workflows/<name>.js` (respect the house conventions: single `export const
     meta` literal, `atomicArgs()` shim, run_id validation, clamps with upstream defaults in
     comments, artifacts under `.atomic-cc/runs/<run_id>/`, no Date/Math.random/fs)
   - agents → `agents/<name>.md`
   - a brand-new upstream workflow → port it modeled on the closest existing port; for
     independent parallel porting work, spawn subagents.
   Validate every touched workflow with `node --check`.
5. Update the docs that state parity claims: README.md (workflow table, statuses,
   version badge) and, if workflow counts changed, `docs/index.html` claims.
6. Bump the plugin version (semver: patch for doc-only sync, minor for behavior changes) in
   BOTH `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.
7. Rewrite `upstream.lock` with the new `sha`, today's date as `synced_at`, the latest
   upstream release tag, and one-line `notes` on what the sync covered.
8. If the plugin root is a git repo, commit the sync on a branch or per the user's
   preference — ask before pushing. Remind the user to run `/plugin` reload or restart
   Claude Code so the new version is picked up.
9. Report: upstream range reviewed (short SHAs), port-relevant changes applied,
   runtime-level changes skipped, new version.

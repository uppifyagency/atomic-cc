#!/bin/bash
# atomic-cc gate notice (SessionStart, matcher: startup).
#
# Why this exists: every gating path in every workflow needs the plugin's install
# path (`plugin_root`) so it can invoke bin/run-state.sh. An independent audit
# (2026-08-12, finding F10) established that the gate was therefore effectively
# OPT-IN and that no usage example anywhere in the documentation passed it — so a
# user following the docs got a run that looked supervised and was not.
#
# Two changes closed that: the workflows now REFUSE to start without plugin_root,
# and this hook states the value at the top of every session so the assistant
# invoking a workflow always has it. Without this notice, failing closed would
# just mean failing.
#
# Deliberately unconditional and dependency-free: no jq, no network, no state. It
# prints the path and exits. The only thing it can get wrong is being silent.
set -u

cat >/dev/null 2>&1 || true   # drain the hook payload; never block on stdin

# Resolve our own install root rather than trusting the environment: this file
# lives at <plugin_root>/bin/gate-notice.sh.
ROOT=$(cd "$(dirname "$0")/.." 2>/dev/null && pwd) || exit 0
[ -n "$ROOT" ] || exit 0
[ -x "$ROOT/bin/run-state.sh" ] || exit 0

cat <<EOF
atomic-cc: this session's plugin root is
  $ROOT

EVERY /atomic:* workflow must be invoked with that path as "plugin_root", e.g.
  /atomic:goal {"run_id": "g-1", "objective": "...", "plugin_root": "$ROOT"}

It is not optional and not cosmetic: plugin_root is how a run registers with the
commit gate, seals a terminal status, and becomes visible to the Stop guard. The
workflows refuse to start without it, because a run that cannot register would
look supervised while being unsupervised.

Honest scope, so it is not mistaken for a sandbox: while a run is in_progress the
PreToolUse hooks deny commit-shaped Bash commands and the most direct writes to
the gate's own state files. They are a regex over shell text, and an agent that
holds Bash can still reach the state another way or invoke run-state.sh itself.
This is discipline against drift, not a boundary against intent.
EOF

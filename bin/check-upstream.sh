#!/bin/bash
# atomic-cc upstream watch (SessionStart hook).
# Compares upstream bastani-inc/atomic HEAD against the SHA this port was last
# synced to (upstream.lock in the plugin root, updated by /atomic:sync-upstream).
# At most one network check per 24h; on drift, prints a notice that Claude Code
# adds to the session context. Fail-open by design: no git, no network, no lock
# file -> exit 0 silently. Never blocks the session.
set -u
command -v git >/dev/null 2>&1 || exit 0

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LOCK="$PLUGIN_ROOT/upstream.lock"
[ -f "$LOCK" ] || exit 0

IN=$(cat 2>/dev/null) || IN=""
CWD=""
if command -v jq >/dev/null 2>&1; then
  CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null)
fi
DATA_DIR="${CLAUDE_PLUGIN_DATA:-${CWD:-$PWD}/.atomic-cc/.state}"
mkdir -p "$DATA_DIR" 2>/dev/null || exit 0

# Throttle: at most one ls-remote per 24h, keyed on the stamp file's mtime.
STAMP="$DATA_DIR/upstream-check.stamp"
if [ -f "$STAMP" ] && [ -n "$(find "$STAMP" -mtime -1 2>/dev/null)" ]; then
  exit 0
fi
touch "$STAMP" 2>/dev/null

UPSTREAM_URL="https://github.com/bastani-inc/atomic.git"
REMOTE_SHA=$(git ls-remote "$UPSTREAM_URL" HEAD 2>/dev/null | awk '{print $1}')
[ -n "$REMOTE_SHA" ] || exit 0

# Grep the synced SHA out of upstream.lock without requiring jq.
SYNCED_SHA=$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{7,40\}\)".*/\1/p' "$LOCK" | head -1)
[ -n "$SYNCED_SHA" ] || exit 0
[ "$REMOTE_SHA" = "$SYNCED_SHA" ] && exit 0

cat <<EOF
atomic-cc: upstream bastani-inc/atomic has new commits since this port was last synced.
  last synced SHA: $SYNCED_SHA
  upstream HEAD:   $REMOTE_SHA
To keep the port current, suggest the user run /atomic:sync-upstream (reviews upstream
changes since the synced SHA and updates the port where behavior diverged).
EOF
exit 0

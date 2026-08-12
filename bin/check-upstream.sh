#!/bin/bash
# atomic-cc upstream watch (SessionStart hook).
# Compares upstream bastani-inc/atomic HEAD against the SHA this port was last
# synced to (upstream.lock in the plugin root, updated by /atomic:sync-upstream).
#
# Consent & noise controls (mirrors upstream's ATOMIC_OFFLINE/ATOMIC_SKIP_VERSION_CHECK):
#   ATOMIC_OFFLINE=1 or ATOMIC_SKIP_VERSION_CHECK=1  -> no network, silent exit.
#   Throttle: at most one ls-remote per 24h, stamped in the user cache dir
#   (XDG_CACHE_HOME or ~/.cache) - this hook never creates files inside the
#   user's project.
# Fail-open by design for the WATCH only (no git, no network, no lock file ->
# silent exit): a missed drift notice is an acceptable failure, unlike a gate.
# On drift it prints a NOTICE for the user. It deliberately does not instruct
# the assistant to fetch or apply anything: /atomic:sync-upstream is
# user-invocable only.
set -u
[ "${ATOMIC_OFFLINE:-0}" != "1" ] || exit 0
[ "${ATOMIC_SKIP_VERSION_CHECK:-0}" != "1" ] || exit 0
command -v git >/dev/null 2>&1 || exit 0

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
LOCK="$PLUGIN_ROOT/upstream.lock"
[ -f "$LOCK" ] || exit 0

# Drain stdin (hook payload unused).
cat >/dev/null 2>&1 || true

CACHE_DIR="${XDG_CACHE_HOME:-$HOME/.cache}/atomic-cc"
mkdir -p "$CACHE_DIR" 2>/dev/null || exit 0
STAMP="$CACHE_DIR/upstream-check.stamp"
if [ -f "$STAMP" ] && [ -n "$(find "$STAMP" -mtime -1 2>/dev/null)" ]; then
  exit 0
fi
touch "$STAMP" 2>/dev/null

UPSTREAM_URL="https://github.com/bastani-inc/atomic.git"
REMOTE_SHA=$(git ls-remote "$UPSTREAM_URL" HEAD 2>/dev/null | awk '{print $1}')
[ -n "$REMOTE_SHA" ] || exit 0

SYNCED_SHA=$(sed -n 's/.*"sha"[[:space:]]*:[[:space:]]*"\([0-9a-f]\{7,40\}\)".*/\1/p' "$LOCK" | head -1)
[ -n "$SYNCED_SHA" ] || exit 0
[ "$REMOTE_SHA" = "$SYNCED_SHA" ] && exit 0

cat <<EOF
atomic-cc notice: upstream bastani-inc/atomic has new commits since this port was last synced
(synced: $SYNCED_SHA, upstream HEAD: $REMOTE_SHA). The user can run /atomic:sync-upstream to
review and apply the drift; do not fetch or apply upstream changes unless the user asks.
(Disable this check with ATOMIC_OFFLINE=1 or ATOMIC_SKIP_VERSION_CHECK=1.)
EOF
exit 0

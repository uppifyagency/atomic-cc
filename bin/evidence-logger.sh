#!/bin/bash
# atomic-cc evidence logger (PostToolUse, matcher: Bash).
# Logs build/test/typecheck commands WITH their real output to the project's
# evidence log, so verifiers can cross-check claims against reality.
# Declared fail-open: without jq the logger disables itself; other guarantees stand.
set -u
command -v jq >/dev/null 2>&1 || exit 0

IN=$(cat) || exit 0
CMD=$(printf '%s' "$IN" | jq -r '.tool_input.command // empty' 2>/dev/null) || exit 0
[ -n "$CMD" ] || exit 0

# Order matters: a longer runner name must come first or it is unreachable.
# "cargo test" contains "go test", and "pnpm test" contains "npm test", so the
# shorter pattern would swallow both and mislabel nothing but still hide intent.
case "$CMD" in
  *pytest*|*vitest*|*jest*|*"cargo test"*|*"go test"*|*"pnpm test"*|*"npm run test"*|*"npm test"*|*"yarn test"*|*phpunit*)
    KIND="test" ;;
  *tsc*|*typecheck*|*mypy*|*pyright*)
    KIND="typecheck" ;;
  *"npm run build"*|*"pnpm build"*|*"yarn build"*|*"cargo build"*|*"go build"*|*"make build"*|*compile*)
    KIND="build" ;;
  *)
    exit 0 ;;
esac

CWD=$(printf '%s' "$IN" | jq -r '.cwd // empty' 2>/dev/null)
[ -n "$CWD" ] && [ -d "$CWD" ] || exit 0
SESSION=$(printf '%s' "$IN" | jq -r '.session_id // "unknown"' 2>/dev/null)

DIR="$CWD/.atomic-cc/evidence"
mkdir -p "$DIR" 2>/dev/null || exit 0

TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
printf '%s' "$IN" | jq -c --arg kind "$KIND" --arg ts "$TS" \
  '{ts: $ts, kind: $kind, agent: (.agent_type // "main"),
    cmd: .tool_input.command,
    stdout: ((.tool_response.stdout // "") | tostring | .[0:2000]),
    stderr: ((.tool_response.stderr // "") | tostring | .[0:500]),
    interrupted: (.tool_response.interrupted // false)}' \
  >> "$DIR/$SESSION.jsonl" 2>/dev/null

exit 0

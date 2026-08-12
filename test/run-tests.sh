#!/bin/bash
# atomic-cc test suite. Run from anywhere: test/run-tests.sh
# Requires: bash, node (>= 18), jq, git.
set -u
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STATUS=0

echo "=============================================="
echo " atomic-cc test suite"
echo "=============================================="

echo
echo "### structure and contracts"
bash "$ROOT/test/structure.test.sh" || STATUS=1

echo
echo "### hook contracts and run-state lifecycle"
bash "$ROOT/test/hooks.test.sh" || STATUS=1

echo
echo "### gate arithmetic (goal + ralph reducers)"
node "$ROOT/test/reducers.test.mjs" || STATUS=1

echo
echo "### run lifecycle (every workflow registers, seals, and certifies honestly)"
node "$ROOT/test/lifecycle.test.mjs" || STATUS=1

echo
if [ "$STATUS" -eq 0 ]; then echo "ALL SUITES PASSED"; else echo "SOME SUITES FAILED"; fi
exit "$STATUS"

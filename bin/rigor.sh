#!/bin/bash
# atomic-cc rigor profile CLI + SessionStart notice.
#
# Why this exists as a script and a hook: a config file nobody reads is worse
# than no config file, because it manufactures confidence. The profile is
# therefore (a) written here, (b) printed back on demand, and (c) injected into
# session context by the SessionStart hook, so the assistant that invokes an
# atomic workflow actually sees the budgets it must pass.
#
# What a profile may and may not scale:
#   MAY   — effort budgets: max_turns / max_loops (goal, ralph),
#           max_repairs and verifier_count (adversarial-verification, whose
#           upstream default is 3 with a 1..5 clamp), candidate/branch counts.
#   MAY NOT — the review gate itself. goal's review quorum (2) and ralph's
#           reviewer count (2) are module CONSTANTS upstream, and they are
#           constants in the port too: no profile can reduce the gate to a
#           single reviewer, because "unanimity 1/1" is not a gate.
#
# Usage:
#   rigor.sh set <lean|standard|thorough>   write .atomic-cc/config.json
#   rigor.sh show                           print the profile and its budgets
#   rigor.sh args                           print the JSON arg fragment to pass
#   rigor.sh clear                          remove the profile (back to defaults)
#   rigor.sh notice                         SessionStart: print context notice, or nothing
set -u

resolve_root() {
  local top
  top=$(git rev-parse --show-toplevel 2>/dev/null) && { printf '%s' "$top"; return; }
  local dir="${CLAUDE_PROJECT_DIR:-$PWD}"
  while [ "$dir" != "/" ] && [ -n "$dir" ]; do
    if [ -d "$dir/.atomic-cc" ]; then printf '%s' "$dir"; return; fi
    dir=$(dirname "$dir")
  done
  printf '%s' "${CLAUDE_PROJECT_DIR:-$PWD}"
}

profile_budgets() { # $1 = profile; echoes "max_turns max_loops verifier_count max_repairs"
  case "$1" in
    lean)     echo "5 5 1 1" ;;
    standard) echo "10 10 3 2" ;;
    thorough) echo "20 20 5 4" ;;
    *)        return 1 ;;
  esac
}

ROOT=$(resolve_root)
CONFIG="$ROOT/.atomic-cc/config.json"

read_profile() {
  [ -f "$CONFIG" ] || return 1
  sed -n 's/.*"rigor"[[:space:]]*:[[:space:]]*"\([a-z]*\)".*/\1/p' "$CONFIG" | head -1
}

case "${1:-}" in
  set)
    P="${2:-}"
    BUDGETS=$(profile_budgets "$P") || { echo "atomic-cc rigor: profile must be lean|standard|thorough" >&2; exit 1; }
    set -- $BUDGETS
    mkdir -p "$ROOT/.atomic-cc" || { echo "atomic-cc rigor: cannot create $ROOT/.atomic-cc" >&2; exit 1; }
    cat > "$CONFIG" <<EOF
{
  "rigor": "$P",
  "max_turns": $1,
  "max_loops": $2,
  "verifier_count": $3,
  "max_repairs": $4,
  "note": "Effort budgets only. The goal review quorum (2) and ralph reviewer count (2) are gate constants and are NOT configurable."
}
EOF
    echo "atomic-cc: rigor profile \"$P\" written to $CONFIG (max_turns=$1 max_loops=$2 verifier_count=$3 max_repairs=$4)"
    ;;
  show)
    P=$(read_profile) || { echo "atomic-cc: no rigor profile set for this project (defaults: max_turns/max_loops 10, verifier_count 3, max_repairs 2)"; exit 0; }
    BUDGETS=$(profile_budgets "$P") || { echo "atomic-cc: $CONFIG contains an unknown profile \"$P\"" >&2; exit 1; }
    set -- $BUDGETS
    echo "atomic-cc rigor profile: $P (max_turns=$1 max_loops=$2 verifier_count=$3 max_repairs=$4)"
    echo "Gate constants (not configurable): goal review_quorum=2, ralph reviewer_count=2."
    ;;
  args)
    P=$(read_profile) || { echo '{}'; exit 0; }
    BUDGETS=$(profile_budgets "$P") || { echo '{}'; exit 0; }
    set -- $BUDGETS
    printf '{"max_turns": %s, "max_loops": %s, "verifier_count": %s, "max_repairs": %s}\n' "$1" "$2" "$3" "$4"
    ;;
  clear)
    rm -f "$CONFIG" 2>/dev/null
    echo "atomic-cc: rigor profile cleared (workflow defaults apply)"
    ;;
  notice)
    cat >/dev/null 2>&1 || true   # drain the hook payload
    P=$(read_profile) || exit 0
    BUDGETS=$(profile_budgets "$P") || exit 0
    set -- $BUDGETS
    cat <<EOF
atomic-cc: this project has rigor profile "$P". When invoking an atomic workflow here, pass its
effort budgets explicitly unless the user overrides them: max_turns=$1, max_loops=$2,
verifier_count=$3, max_repairs=$4. These are effort budgets only — goal's review quorum (2) and
ralph's reviewer count (2) are gate constants and cannot be lowered by a profile.
EOF
    ;;
  *)
    echo "usage: rigor.sh set <lean|standard|thorough> | show | args | clear | notice" >&2
    exit 1
    ;;
esac
exit 0

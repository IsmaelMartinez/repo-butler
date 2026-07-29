#!/usr/bin/env bash
# G13 verifier — the stalled-alert watcher.
#
# Three gates, each closing a way an earlier goal in this programme nearly
# passed without doing any work:
#
#   1. ADR-014 must exist AND carry the load-bearing evidence (the declined
#      dependabot-core issue). A stub with the right filename would satisfy a
#      bare `test -f`, and the whole point of that ADR is the evidence.
#   2. A floor of NAMED stalled-alert tests must actually run. `node --test
#      --test-name-pattern` exits 0 and reports "pass 1" when the target file is
#      ABSENT and zero tests match — measured on this repo. An exit code alone
#      would report this goal as already met before a line was written. That
#      trap has now caught two goals (G5 and G12); the floor is not optional.
#   3. The real-data fixture must be exercised. The live target
#      (teams-for-linux #153, open since 2026-06-24) may be fixed by someone
#      before G13 ships, so the committed capture is what keeps the goal
#      meaningful afterwards.
set -uo pipefail
cd "$(dirname "$0")/.."

ADR=docs/decisions/014-no-programmatic-dependabot-rescan.md
FIXTURE=src/fixtures/stalled-alert-live.json
MIN_TESTS=10

[ -f "$ADR" ] || { echo "G13 VERIFIER FAIL (missing $ADR)"; exit 1; }

# The declined issue is the fact the whole ADR rests on: it is the difference
# between "no API yet" and "no API, ever".
grep -q '6098' "$ADR" || {
  echo "G13 VERIFIER FAIL ($ADR does not cite the declined dependabot-core issue)"; exit 1; }

[ -f "$FIXTURE" ] || {
  echo "G13 VERIFIER FAIL (missing real-data fixture $FIXTURE)"; exit 1; }

OUT=$(node --test --test-name-pattern 'stalled-alert' \
        src/stalled-alert.test.js src/governance.test.js 2>&1) || {
  printf '%s\n' "$OUT" | tail -25
  echo "G13 VERIFIER FAIL (stalled-alert tests failed, or the test file does not exist yet)"
  exit 1
}

CLEAN=$(printf '%s\n' "$OUT" | sed 's/\x1b\[[0-9;]*m//g')
PASS=$(printf '%s\n' "$CLEAN" | grep -E '^. pass [0-9]+$' | grep -oE '[0-9]+$')

[ "${PASS:-0}" -ge "$MIN_TESTS" ] || {
  echo "G13 VERIFIER FAIL (only ${PASS:-0} named stalled-alert tests ran; >= ${MIN_TESTS} required)"
  exit 1
}

echo "G13 VERIFIER PASS (${PASS} named stalled-alert tests)"

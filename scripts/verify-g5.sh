#!/usr/bin/env bash
# G5/G6 verifier — the content-transformation trust model and the trimmer's
# deterministic core.
#
# The plan states G5's verifier as `test -f <adr> && npm test`, and then says of
# it, correctly: "a green `npm test` proves nothing about a feature that does not
# exist yet, which is precisely how the first draft's G5 verifier passed before
# any work was done." A whole-suite run is green today. So this verifier adds the
# two things that make it able to fail:
#
#   1. the ADR must exist AND carry the benign-worst-case analysis the plan
#      requires of it — not just be a file with the right name;
#   2. a floor of NAMED trimmer tests must actually run. `node --test
#      --test-name-pattern` exits 0 when zero tests match (measured: it reports
#      "pass 1" even when the target file is absent), so an exit code alone would
#      report this goal as already met.
set -uo pipefail
cd "$(dirname "$0")/.."

ADR=docs/decisions/013-content-transformation-writes.md
MIN_TESTS=20

[ -f "$ADR" ] || { echo "G5 VERIFIER FAIL (missing $ADR)"; exit 1; }

# The ADR's whole job is the worst-case argument; a stub with the right filename
# would otherwise satisfy a bare -f check.
grep -qi 'worst case' "$ADR" || {
  echo "G5 VERIFIER FAIL ($ADR has no worst-case analysis)"; exit 1; }

OUT=$(node --test --test-name-pattern 'trimmer' src/trimmer.test.js 2>&1) || {
  printf '%s\n' "$OUT" | tail -25
  echo "G5 VERIFIER FAIL (trimmer tests failed, or the test file does not exist yet)"
  exit 1
}

CLEAN=$(printf '%s\n' "$OUT" | sed 's/\x1b\[[0-9;]*m//g')
PASS=$(printf '%s\n' "$CLEAN" | grep -E '^. pass [0-9]+$' | grep -oE '[0-9]+$')

[ "${PASS:-0}" -ge "$MIN_TESTS" ] || {
  echo "G5 VERIFIER FAIL (only ${PASS:-0} named trimmer tests ran; >= ${MIN_TESTS} required)"
  exit 1
}

echo "G5 VERIFIER PASS (${PASS} named trimmer tests)"

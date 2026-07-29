#!/usr/bin/env bash
# G12 verifier — the Gold-ratchet's companion: does the butler notice when its
# OWN pull requests rot?
#
# Exits 0 only when the detector's named tests exist, run, and pass. Two
# properties are deliberate, both required of every verifier by
# docs/superpowers/2026-07-25-autonomous-garden-plan.md:
#
#   1. It must be able to FAIL before the work is done.
#   2. It must FAIL CLOSED when its inputs are unavailable.
#
# The test-count floor is what delivers BOTH, and it is not belt-and-braces.
# Measured 2026-07-29 on this repo: with src/butler-pr-audit.test.js absent AND
# zero tests matching the pattern, `node --test` reports "tests 1 / pass 1 /
# fail 0" and exits 0. A missing test file does not error. So exit code alone
# would have reported this goal as ALREADY MET before a single line was written
# — "a verifier that is green before the work starts is worse than none".
set -uo pipefail
cd "$(dirname "$0")/.."

MIN_TESTS=8

OUT=$(node --test --test-name-pattern 'stale-butler-pr' \
        src/butler-pr-audit.test.js src/governance.test.js 2>&1) || {
  printf '%s\n' "$OUT" | tail -25
  echo "G12 VERIFIER FAIL (tests failed, or the test file does not exist yet)"
  exit 1
}

# `node --test --test-name-pattern` exits 0 when ZERO tests match, so a passing
# exit code alone is not evidence. Read the summary line and require a floor,
# otherwise the verifier would go green the moment a test is renamed — the exact
# trap the plan flags. Strip ANSI first, and anchor on the summary line rather
# than grepping a bare "pass N", which would match a test name earlier in the
# stream.
CLEAN=$(printf '%s\n' "$OUT" | sed 's/\x1b\[[0-9;]*m//g')
PASS=$(printf '%s\n' "$CLEAN" | grep -E '^. pass [0-9]+$' | grep -oE '[0-9]+$')

[ "${PASS:-0}" -ge "$MIN_TESTS" ] || {
  echo "G12 VERIFIER FAIL (only ${PASS:-0} named tests ran; >= ${MIN_TESTS} required)"
  exit 1
}

echo "G12 VERIFIER PASS (${PASS} named tests)"

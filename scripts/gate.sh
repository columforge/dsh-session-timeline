#!/usr/bin/env bash
# ub-mode quality gates for session-timeline (targeted scope).
#
# Scope (why):
#   CRAP  -> src/parse.ts, src/lineage-infer.ts, src/geometry/*  (pure logic,
#            unit-tested; the plugin's business rules live here).
#   DRY   -> src/ (whole tree; UI duplication is still worth removing).
#   OUT   -> src/client/* and src/index.ts: host/UI boundary code with no
#            unit-level coverage yet. Measuring CRAP there would report 0%
#            coverage and force mock-heavy tests the skill itself avoids.
#            See docs/gates.md for the split and the follow-up.
#
# Requires on PATH (or via env): crapper, dryer. See docs/gates.md.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DSH_CHECKOUT="${DSH_CHECKOUT:-}"
if [ -z "$DSH_CHECKOUT" ]; then
  for candidate in "$HOME/dsh-harness" "$HOME/dsh" "$HOME/.dsh/dsh-harness"; do
    if [ -d "$candidate/packages" ]; then DSH_CHECKOUT="$candidate"; break; fi
  done
fi
if [ -z "$DSH_CHECKOUT" ] || [ ! -d "$DSH_CHECKOUT/packages" ]; then
  echo "gate: set DSH_CHECKOUT to the dsh source checkout (scripts/build.sh needs it)" >&2
  exit 1
fi

CRAPPER="${CRAPPER:-crapper}"
DRYER="${DRYER:-dryer}"
command -v "$CRAPPER" >/dev/null 2>&1 || { echo "gate: crapper not found on PATH (docs/gates.md)" >&2; exit 1; }
command -v "$DRYER" >/dev/null 2>&1 || { echo "gate: dryer not found on PATH (docs/gates.md)" >&2; exit 1; }

echo '== build =='
DSH_CHECKOUT="$DSH_CHECKOUT" bash scripts/build.sh

echo '== tests + LCOV coverage =='
if [ -n "${C8_BIN:-}" ]; then
  C8=("$C8_BIN")
elif [ -x node_modules/.bin/c8 ]; then
  C8=("node_modules/.bin/c8")
else
  C8=(npx --yes c8)
fi
"${C8[@]}" --reporter=lcov --reports-dir target/coverage/typescript node --test test/*.test.mjs

echo '== CRAP gate (ub-mode: every targeted function < 10) =='
"$CRAPPER" --use-existing-coverage src/parse.ts src/lineage-infer.ts src/geometry --threshold 10

echo '== duplication gate (ub-mode: no pair scoring >= 0.82) =='
DRY_OUT="$("$DRYER" --threshold 0.82 src)"
printf '%s\n' "$DRY_OUT"
if printf '%s\n' "$DRY_OUT" | grep -q '^DUPLICATE score='; then
  echo 'gate: structural duplicates at or above 0.82 found' >&2
  exit 1
fi

echo 'gate: OK'

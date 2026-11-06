# ub-mode quality gates

This repo runs three deterministic gates from [ub-mode](https://github.com/unclebob/ub-mode):
CRAP (complexity × coverage), duplication (dryer), and mutation testing (mutator).
`scripts/gate.sh` runs build → tests + LCOV → CRAP → duplication.

## Target scope (deliberate, not the whole tree)

| Area | Gate | Why |
| --- | --- | --- |
| `src/parse.ts`, `src/lineage-infer.ts`, `src/geometry/*` | CRAP < 10 | Pure logic; the plugin's lineage/parse/geometry rules; unit-tested directly. |
| `src/**/*.ts` | duplication score < 0.82 | Whole tree; UI duplication counts too. |
| `src/index.ts` (host routes, zstd scan, caches) | not gated yet | No route-level coverage: measuring CRAP would be 0% coverage and demand host mocks. Follow-up: add host route tests, then include it. |
| `src/client/index.ts` (panel UI, 1.5k lines) | not gated yet | No DOM/unit coverage. CRAP there is coverage arithmetic, not a design signal. Follow-up: component tests, then include pure helpers. |
| mutation testing | deferred | TS mutants re-run `npm test` (with `pretest` rebuild) per mutant; too slow for a pass. Adopt after the CRAP baseline is green. |

## Install the gate tools

The tools are separate repos (not PyPI); Python ≥ 3.11 is the nominal minimum.
On this machine they run under Python 3.10 with the interpreter check relaxed.
Offline installs need `tree-sitter-language-pack==0.7.0` (bundled grammars; its
`download` export does not exist, so the tools' `parser_for` must tolerate that).

```bash
git clone https://github.com/unclebob/crapper
git clone https://github.com/unclebob/dryer
python3 -m venv .venv-tools
.venv-tools/bin/pip install -e crapper -e dryer
export PATH="$PWD/.venv-tools/bin:$PATH"
```

## Coverage

CRAP uses LCOV. The repo has no `coverage` npm script on purpose: the gate runs
the test suite through `c8` itself, so coverage is one command and no extra
dependency lands in `package.json`.

```bash
npx --yes c8 --reporter=lcov --reports-dir target/coverage/typescript node --test test/*.test.mjs
```

`tsconfig.json` emits source maps, so c8 maps `lib/*.js` back to `src/*.ts`.

## Run

```bash
CRAPPER=/path/to/crapper DRYER=/path/to/dryer \
DSH_CHECKOUT=/path/to/deepseek-harness C8_BIN=/path/to/c8 \
bash scripts/gate.sh
```

## Current result (2026-11-06)

First run (scope above, 59 tests): 9 functions at or above CRAP 10; worst
`parseLog` 110.6 (CC 68), then `routeOrthogonal` 65.6 (CC 61), `computeLayout`
31.5, `laneNodeTop` 26.8 (coverage 16.7%), `routeEdgePath` 26.5,
`inferForkParents` 23.5, `computeLanesLayout` 17.1, `signatureLog` 15.1,
`segHitsObstacle` 12.0.

After splitting into one responsibility per function (and pinning the
uncovered lane/top branches with tests): all targeted functions are under 10,
worst `search` at 9.3; 63 tests pass; dryer reports no duplicate pair at or
above 0.82. `src/index.ts` and `src/client/index.ts` remain out of CRAP scope
(see the table above), so their complexity is not yet governed.

Behavior proof for the refactor: an old-vs-new differential (HEAD lib vs the
rebuilt lib) over all 697 local session logs (parse/signature), 21 workspace
buckets (fork attribution), and 900 deterministic random geometry cases
(layout/lanes/routing/edge routing) produced identical outputs.

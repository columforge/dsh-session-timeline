# ub-mode quality gates

This repo runs three deterministic gates from [ub-mode](https://github.com/unclebob/ub-mode):
CRAP (complexity × coverage), duplication (dryer), and mutation testing (mutator).
`scripts/gate.sh` runs build → tests + LCOV → CRAP → duplication.

## Target scope (deliberate, not the whole tree)

| Area | Gate | Why |
| --- | --- | --- |
| `src/parse.ts`, `src/lineage-infer.ts`, `src/geometry/*` | CRAP < 10 | Pure logic; the plugin's lineage/parse/geometry rules; unit-tested directly. |
| `src/**/*.ts` | duplication score < 0.82 | Whole tree; UI duplication counts too. |
| `src/index.ts` (host routes, zstd scan, caches) | partially gated | Route tests exist (test/routes.test.mjs) and the zstd scan region is compliant (readFrameHeader 6.0 / decodeFrameDescriptor 5.0 / walkBlocks 7.0 / scanZstdFrames 6.0). Sole blocker: `apply` (CC 196) — decomposition approved (L1 pure scanners + L2 assembly shell, all ≤10); include the whole file at threshold 10 once it lands. |
| `src/client/index.ts` (panel UI, 1.5k lines) | not gated yet | No DOM/unit coverage. CRAP there is coverage arithmetic, not a design signal. Follow-up: extract pure helpers (errorText/interpolate/formatters) into a tested module, then include them. |
| mutation testing (mutator) | periodic, single-file, **parallel OK (locally patched)** | Baseline 2026-11-06 on `src/parse.ts`: 126 sites; 85/41 killed with pins (test/parse-pins.test.mjs); the 41 survivors are triaged equivalents. Re-validated 2026-11-09: parallel (default workers) and serial produce identical per-site outcomes (126/126) in 26s vs 140s. Required because upstream mutator has two open defects: worker overlays symlinked the build output so worker builds wrote through to the real tree and raced (our local copy patches this — `lib` added to SKIP_LINK, test-runner dirs copied instead of linked; and `scripts/build.sh` makes its dependency links idempotent so worker builds never mutate the real `node_modules`), and differential `--since-last-run` snapshots inherit stale outcomes (#21) — **always delete `.metrics/mutate/<ns>.edn` for an authoritative run**, patched or not. |

## Quick gates (pre-commit + CI)

- **pre-commit** (activate once per clone: `git config core.hooksPath scripts/githooks`):
  seconds-fast, changed files only. CRAP real-threshold mode requires fresh LCOV
  (newer than both `src/**` and `lib/**`); otherwise it reports complexity without
  a threshold (stale coverage would fabricate 0% rows), and duplication always
  runs. Missing tools warn and pass. Full `gate.sh` stays the authority.
- **CI** (`.github/workflows/ci.yml`, push master + PRs): installs crapper/dryer
  from upstream, runs the suite under c8 (no build — `lib/` is committed), then
  the same CRAP/duplication thresholds. Known limitation: a PR that changes
  `src/` without rebuilding `lib/` tests stale artifacts; the local gate before
  merging is the backstop.

## Behavior differential (refactor guard)

`ST_DIFF=1 node --test test/diff.slow.test.mjs` compares the committed `lib/`
(HEAD, via `git archive`) against the working-tree `lib/`: parseLog /
signatureLog over every local session log, fork attribution per workspace
bucket, and 900 deterministic random geometry cases (fixed seed). Run it after
any rebuild that follows a refactor — identical output is the proof that
behavior did not change. Skips without `ST_DIFF`; the real-log segment skips
when no sessions root or zstd CLI exists.

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
rebuilt lib) over all local session logs (parse/signature), 21 workspace
buckets (fork attribution), and 900 deterministic random geometry cases
(layout/lanes/routing/edge routing) produced identical outputs.

## Second pass (2026-11-06, parallel batch)

- Host route coverage landed (22 tests) and the zstd frame scanner was split
  (readFrameHeader / decodeFrameDescriptor / walkBlocks); differential over all
  local logs (750-file superset of the original 697) proved the split
  byte-identical.
- Mutation trial on `src/parse.ts` produced the pins in test/parse-pins.test.mjs
  (12 survivors killed); the remaining 41 are documented equivalents (see the
  scope table).
- One behavior fix came out of the route tests: `assistantReasoning` now resets
  when formal text covers the reasoning fallback.

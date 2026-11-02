# Performance notes (branch `perf`)

## Method
- `examples/golden.rs <input.json> <output.json> [rounds]` runs a session `create` + `run`, prints wall time per round, and writes the response with `elapsedMs`/`stats` stripped. Diff outputs byte for byte against a golden taken from the unmodified engine.
- Inputs: gekiso bands 1_5, 3_73, 5_141 (song pools) and challenge_points. Release build, Raspberry Pi (aarch64, 4 cores).

## Baseline
| case | ms |
|---|---|
| gekiso_1_5 | 17595 |
| gekiso_3_73 | 13952 |
| gekiso_5_141 | 7095 |
| challenge_points | 304 |

User time was ~= wall time: the harness ran essentially single-threaded (the inputs have `goal.seeds = 0`, so the in-engine native parallel path, which needs `seeds >= 16`, is off).

## Hotspots
- The exact gauge-probability DP in `src/luck.rs` (block/shift/consume_block/axpy, `draw` Vec clones, row index lookups) is ~40-55% of the time.
- The per-song proofs are independent, but `Engine::run_inner` ran them sequentially.

## Changes
1. **Concurrent songs for deadline-free Gekiso runs** (`src/api.rs`, `gekiso_parallel`): each pending song is searched on a worker thread with its own view engine, serial inside. Results are assembled by the unchanged sequential loop, so order, chart-cache state and output are unchanged. Falls back to the sequential path when there is a deadline (per-song time apportioning), a progress callback (notification order), or trusted scores.
   - gekiso_1_5 17595 -> 6157 ms, gekiso_3_73 13952 -> 6569 ms, gekiso_5_141 7095 -> 2894 ms, challenge_points 304 -> 295 ms. Outputs byte-identical.

2. **Dense row index for small residue counts** (`src/luck.rs`): moduli <= 4 index rows in the pooled dense table instead of the hash map. Single core (`taskset -c 0`, gekiso_5_141): 21.1G -> 20.2G cycles (~-5%). Outputs byte-identical on all four cases.

## Single-thread findings (non-parallel leads)
- `luck` cost is dominated by per-call overhead of many short `block` calls (avg ~26 elements, ~2.5 points per row visit), not memory bandwidth.
- `rank_remainder` is ~34% of the time (1197 misses vs 16803 cache hits); chart-curve `luck::run` calls ~25%.
- Dead ends (measured or ruled out):
  - skipping identity notes: none exist (0 of ~9.9M row visits);
  - trimming zero edges of rows: slower;
  - sharing a DP prefix across `rank_remainder` runs: prefix is essentially empty and float association would differ;
  - `FxHashSet` for `observed` in `rank_remainder`: no measurable change (20.29G vs 20.2G cycles).
- Remaining untested: per-element divisions in `consume_block`'s tail loop, cheaper `Rows::at/position`, and the non-luck ~45% (`score_orders_selected` ~8-10%, `Model::frame` ~5-7%, condition updating).

## Caveats
- The reported "40 s CPU, parallel" does not match a serial harness; if the orchestrator already runs several bands/processes at once or uses `seeds >= 16`, the gain from change 1 will be smaller there (cores are already busy).
- Only the 4-core Pi was measured; speedup is bounded by core count and by the longest single song.

## Ideas not pursued yet
- `luck.rs`: avoid `draw` Vec clones on cache hits, cut hash/index lookups, skip exact-zero work. Must keep floating-point accumulation order bit-exact (no FMA, no reordering).
- Balance work across songs better (longest-first scheduling) since one slow song bounds the wall time.
- Share `luck::run` results across songs with equal curve signatures.

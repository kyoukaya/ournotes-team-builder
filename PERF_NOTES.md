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

3. **Prepare each luck range once per settlement** (`src/gekiso.rs`, `RemainderRange`): the members/judged lookup of a range is built once per settlement instead of per `rank_remainder` call, and the per-call std `HashSet` of observed notes became a flag vector. gekiso_5_141: 20.3-20.5G -> 19.5-19.9G cycles, 44.48G -> 43.13G instructions.

4. **Keep settled range remainders with their lottery record** (`Recorded::remainders`): the remainder of a range depends only on (record, range, residue signature), because scores enter the DP only as `(residue + score) % modulus`. The memo lives on the `Arc`-shared record (capped at 256 entries per record), so it survives across contexts. gekiso_5_141: 19.6-19.9G -> 15.5-15.7G cycles (-21%); gekiso_1_5 single core 19.0 s -> 14.2 s; gekiso_3_73 unchanged. A 1<<20 cap gives the same instruction count, and RSS is unchanged.

5. **Resume `Combo::at` from the previous index** (`src/full/core.rs`): 76% of queries hit the same partition point as the previous one and 9% the next, so check those before binary searching. gekiso_3_73: 58.2-58.5G -> 57.4-57.9G cycles.

6. **Dense note table in `Model`** (`src/full/model.rs`, `NoteIndex`): judged notes were looked up in an `FxHashMap<i32, LiveNote>`; chart ids are `1..=n`, so a table indexed by id answers the same lookups (sparse id sets keep the map). Frames with no due skill events skip the collect/sort/extend chain. The table is filled directly from the note list, because `Model::new` runs per context and building the map first cost ~3G instructions on 3_73. gekiso_3_73: 57.7-60.2G -> 54.2G cycles.

7. **Integer `core::frame` below 2^24 ms**: `ceil(f32(f32(ms) / 40))` equals `(ms + 39) / 40` for every `0 <= ms < 2^24` (checked exhaustively; the first mismatch is 16777241). Larger times keep the float path. gekiso_3_73: 57.3-59.7G -> 55.0-55.1G cycles (-4%).

Release (LTO) check at 75bf64d: outputs byte-identical on all four cases. Single core (`taskset -c 0`) against a release build from before changes 3-7 (pre-eb75026):
| case | cycles before | cycles after | instructions before | instructions after |
|---|---|---|---|---|
| gekiso_1_5 | 39.6G | 26.7G (-33%) | 85.3G | 57.5G |
| gekiso_5_141 | 16.8G | 12.6G (-25%) | 35.6G | 26.2G |
| gekiso_3_73 | 46.1G | 43.6G (-5%) | 114.8G | 111.5G |

4-core wall: gekiso_1_5 4951 ms, gekiso_5_141 2201 ms, gekiso_3_73 6639-6944 ms (pre-eb75026 6840-7334 ms; bounded by its longest song), challenge_points 305 ms.

Why `frame()` keeps the float fallback above 2^24 ms although no song is that long: the lottery replay sets `params.music_length = 0` (`src/full/model/lottery.rs:125`, likewise `src/gekiso_objective.rs:2150`), so effect finish times (`execute_ms.wrapping_add(ceil_i32(duration))`, `src/full/effects.rs:108`) are not clamped to the song and can reach `frame` through `add_factor`. `frame` is also `pub`. The branch is never taken on real inputs, so it costs nothing; `ceil_i32` itself is still needed by `effects.rs:108`, `play.rs:103` and `conditions.rs:1063`.

## WebAssembly
Many users run the engine in the browser, so every change is also checked on `wasm32-unknown-unknown`.
- Build: `rustup target add wasm32-unknown-unknown && cargo build --release --target wasm32-unknown-unknown` -> `target/wasm32-unknown-unknown/release/haneoka_team_engine.wasm`. Imports are only `env.haneoka_now_ms` and `env.haneoka_progress`.
- Run: `HANEOKA_FROZEN_CLOCK=1 node examples/wasm_golden.mjs <engine.wasm> <input.json> <output.json> [rounds]` (same request flow and stripping as `examples/golden.rs`). Compare with a native golden after JSON normalization (the native harness writes compact JSON, this one pretty-prints), e.g. `node -e 'const f=require("fs");const r=p=>JSON.stringify(JSON.parse(f.readFileSync(p)));console.log(r(process.argv[1])===r(process.argv[2])?"same":"DIFF")' a.json b.json`.
- Why the frozen clock: Gekiso seed probes stop after 150/300 ms of wall time (`src/api.rs:1060`, `:1092`). wasm is slower than native, so with a real clock the probes stop earlier and equal-score hits can come out in another order (gekiso_3_73 swaps two members with equal scores). This happens on unmodified `main` too. With `HANEOKA_FROZEN_CLOCK=1` the output is deterministic and equals the native golden.
- Timing: `taskset -c 0 node --no-liftoff` (optimizing tier only, single core), runs interleaved across builds.

Correctness: every commit on this branch (26acce7, 0e72393, eb75026, b9715a8, 3fa2884, e7a4af6, f298572, 75bf64d) and all three `eval/*` prototypes produce the native golden output in wasm on all four cases.

Speed, quiet machine, main (69a566b) vs 75bf64d, 2 runs each:
| case | main ms | 75bf64d ms |
|---|---|---|
| gekiso_5_141 | 13850/13584 | 10574/10742 (-22%) |
| gekiso_1_5 | 29397/29363 | 21141/20894 (-28%) |
| gekiso_3_73 | 34721/34417 | 32978/33162 (-4%) |
| challenge_points | 2183-2367 (5 runs, mean 2267) | 2206-2327 (5 runs, mean 2273) |

Per commit (2 runs each, ms; measured while builds ran on the other three cores, so absolute times are inflated and noisy, but runs were interleaved):
| case | main | 26acce7 | 0e72393 | eb75026 | b9715a8 | 3fa2884 | e7a4af6 | f298572 | 75bf64d |
|---|---|---|---|---|---|---|---|---|---|
| gekiso_5_141 | 16817/16822 | 16326/16170 | 15959/15497 | 15392/15427 | 13732/13095 | 13192/12523 | 13307/13193 | 12890/13680 | 13123/13130 |
| gekiso_1_5 | 32011/31218 | 31351/31401 | 30920/30884 | 29452/28997 | 23315/22656 | 22869/24148 | 22472/23572 | 22751/22536 | 22728/22240 |
| gekiso_3_73 | 43732/42172 | 43811/41051 | 41431/41763 | 43711/40927 | 42225/41177 | 41305/40830 | 40863/41578 | 40753/38262 | 39999/35782 |

No commit is slower in wasm. challenge_points looked noisy in that run (2.7-4.3 s); rechecked on a quiet machine, 5 runs each: main 2183-2367 ms (mean 2267), 75bf64d 2206-2327 ms (mean 2273), i.e. unchanged. Change 1 (threads) does nothing in wasm (single-threaded there; `gekiso_parallel` is native-only) and costs nothing.

## Public API candidates (evaluated, not merged)
Three changes need a public type to change. Each was prototyped on its own branch from 76dc27b and pushed to the fork (`https://github.com/kyoukaya/ournotes-team-builder`). All produce byte-identical output natively and in wasm on all four cases.

| branch | commit | public change |
|---|---|---|
| `eval/targets-bitset` | 896ac7c | `Range::targets: FxHashSet<i32>` -> `NoteSet` (bitset over the id span; `contains`, `len`, `is_empty`, `FromIterator<i32>`) |
| `eval/trigger-array` | ae98895 | `Effect::trigger` is moved out into `ConditionUpdater::triggers: Vec<Option<Checker>>` at construction (the field is left `None`) |
| `eval/incremental-arena` | 7992b13 | `Incremental::notes: Vec<Vec<NoteCommand>>` -> `FrameLists<NoteCommand>` (one pool plus per-frame linked lists; clone is a few memcpys); the private `factors` uses the same type |

Release (LTO) single core (`taskset -c 0`), 3 runs each interleaved with perf (52788d6; engine code identical to 76dc27b). Perf column: mean of its 9 runs; percentages are against the perf runs interleaved with that branch (cycles, instructions):
| case | perf cycles / instr | targets-bitset | trigger-array | incremental-arena |
|---|---|---|---|---|
| gekiso_3_73 | 42.89G / 111.48G | 43.03G / 111.11G (+0.2%, -0.3%) | 42.89G / 111.51G (0%, 0%) | 41.19G / 108.44G (-3.7%, -2.7%) |
| gekiso_5_141 | 12.19G / 26.18G | 12.29G / 26.14G (+0.2%, -0.2%) | 12.23G / 26.18G (+0.8%, 0%) | 12.08G / 26.02G (-0.9%, -0.6%) |
| gekiso_1_5 | 26.42G / 57.44G | 26.35G / 57.29G (-0.1%, -0.3%) | 26.43G / 57.44G (+0.1%, 0%) | 26.03G / 57.09G (-1.4%, -0.6%) |

wasm (frozen clock, 2 runs each, ms):
| case | 75bf64d | targets-bitset | trigger-array | incremental-arena |
|---|---|---|---|---|
| challenge_points | 2200/2339 | 2214/2226 | 2259/2202 | 2273/2252 |
| gekiso_5_141 | 10437/10344 | 10696/10476 | 10578/10682 | 10562/10404 |
| gekiso_3_73 | 33094/33333 | 33235/32905 | 33345/33168 | 32688/32890 |
| gekiso_1_5 | 21035/21205 | 20923/21020 | 21310/21047 | 21005/21319 |

Verdicts:
- `targets-bitset`: not worth an API change. -0.3% instructions, no cycle change native, none in wasm. The `FxHashSet` probe was not a real cost after all.
- `trigger-array`: dead end. No change native or wasm. The stall on the `trigger` tag only moves into `Checker::check`, because the checker data itself still lives behind the same cold memory; a win would need compiling checkers into a compact form, which is a much bigger change.
- `incremental-arena`: the only one with a real gain, -3.7% cycles on gekiso_3_73 and -1% on the others natively, about -1% (within noise) in wasm. Worth it only if changing `Incremental::notes` is acceptable to downstream users; otherwise a private-only version (factors only, `notes` unchanged) would keep perhaps a third of it (untested).

Reproduce (any of the branches; replace `<hash>`):
```
git checkout 76dc27b            # baseline
cargo build --release --example golden && cp target/release/examples/golden /tmp/golden-base
git checkout <hash>             # 896ac7c | ae98895 | 7992b13
cargo build --release --example golden && cp target/release/examples/golden /tmp/golden-eval
for i in 1 2 3; do for b in /tmp/golden-base /tmp/golden-eval; do
  perf stat -e cycles,instructions taskset -c 0 $b in_gekiso_3_73.json out_$(basename $b).json
done; done
cmp out_golden-base.json out_golden-eval.json   # identical
# wasm
cargo build --release --target wasm32-unknown-unknown
HANEOKA_FROZEN_CLOCK=1 taskset -c 0 node --no-liftoff examples/wasm_golden.mjs \
  target/wasm32-unknown-unknown/release/haneoka_team_engine.wasm in_gekiso_3_73.json out_wasm.json
```
(`examples/wasm_golden.mjs` exists from 76dc27b on; the eval branches include it. Use the frozen clock for wasm, see above.)

## Data structures (are hash sets the problem?)
Short answer: no longer. After the changes above, every hash/B-tree symbol together is ~3% of single-core cycles on both 3_73 and 5_141, spread over many small sites. The cases where a different structure paid off are done:
- luck rows: a dense `Vec<u32>` index instead of `FxHashMap` (change 2). Per DP pass only ~54 rows exist (keys spread over 2^18), so the touched index slots stay in cache; the rows themselves (~134 f64 each, two rows ~116 KB) are what exceeds L1. A small open-addressing or linear-probe table would not beat the dense index.
- observed notes in `rank_remainder`: a std `HashSet` -> a flag vector (change 3).
- notes by id in `Model::frame`: `FxHashMap` -> dense table (change 6).
- `Combo::at`: a binary search -> a remembered cursor (change 5).

Remaining hash/tree sites, all small:
- `gekiso_objective` memo keys hash whole `Vec<usize>` (`pattern_domains`, `Kernel::gain`, `Kernel::luck_base`): ~0.5% on 5_141. Interning the vectors or caching their hash would remove it.
- `Controller::update` probes `ranges[i].targets` (`FxHashSet`) per judged note and range: ~0.5% on 3_73. A per-range bitset over note ids would be cheaper, but `Range::targets` is a pub field of a pub type, so a cached copy could go stale if a caller mutates it. Changing the field type is a public API change; evaluated below (`eval/targets-bitset`): not worth it.
- `Incremental::fixed` (`BTreeMap`, a handful of rank bonuses) probed once per frame, plus master-data `BTreeMap`s (`note_percent`, member ranks): each <=0.6%.

The larger structural cost on 3_73 is memory layout, not hashing:
- `ConditionUpdater::prepare_triggers` (~6.4% self) stalls on the first load of each `effects[i].trigger` tag in 400-byte `Effect` records. Splitting hot checker state into a compact array (structure of arrays) would help, but `Effect` and its fields are pub. Evaluated below (`eval/trigger-array`): moving only the trigger out gains nothing.
- Model lifecycle (`Model::new` + `clone` + drop) is ~7.7%, much of it `Incremental`'s per-frame `Vec<Vec<NoteCommand>>` / `Vec<Vec<FactorCommand>>`: every clone allocates each non-empty frame and every drop walks all frames. One arena per kind with per-frame ranges or links would make clone a few memcpys. `factors` is private (about 1% to gain); `notes` is pub. Evaluated below (`eval/incremental-arena`): -3.7% cycles on 3_73.

## Single-thread findings (non-parallel leads)
- `luck` cost is dominated by per-call overhead of many short `block` calls (avg ~26 elements, ~2.5 points per row visit), not memory bandwidth.
- `rank_remainder` is ~34% of the time (1197 misses vs 16803 cache hits); chart-curve `luck::run` calls ~25%.
- Dead ends (measured or ruled out):
  - skipping identity notes: none exist (0 of ~9.9M row visits);
  - trimming zero edges of rows: slower;
  - sharing a DP prefix across `rank_remainder` runs: prefix is essentially empty and float association would differ;
  - `FxHashSet` for `observed` in `rank_remainder`: no measurable change (20.29G vs 20.2G cycles).
  - `Combo::at` with a bounded 8-step walk from the cursor (misses average a jump of ~2): 0.3G fewer instructions than the two-candidate check but no fewer cycles (branchier), so it was not kept;
  - integer division for `floor(f32(a) / f32(n))` in `Cumulative::update` (verified exact for `0 <= a < 2^23`, `0 < n < 2^24`): no change in instructions or cycles. The profile's 3.3% `floor_i32` under `Cumulative::update` is misattributed or latency-bound, not call volume;
  - duplicate `context_fixed`/`replay_orders` work: none once the chart is part of the key (4050 contexts on 3_73, ~171 per song across 22 per-song compilers, the converter cache never clears);
  - wider remainder memo (1<<20 entries): same instruction count as 256.
- Profile of gekiso_3_73 now (single core): `Model::frame` 19% self / 81% inclusive, reached via `ReplayTree::visit` (52%) and `converter_upper` -> `context_fixed` (37%); then `prepare_triggers` 6.4%, `update_active` 4.8%, `Incremental::calculate` 4%, `Checker::check` 3.2%, `Controller::before_update` 3%.
- Remaining untested: per-element divisions in `consume_block`'s tail loop, cheaper `Rows::at/position`, `Model::frame` per-frame clones (`results` clones each `LiveNote`, the luck record clones `controller.updates` per frame), and the layout items above.

## Caveats
- The reported "40 s CPU, parallel" does not match a serial harness; if the orchestrator already runs several bands/processes at once or uses `seeds >= 16`, the gain from change 1 will be smaller there (cores are already busy).
- Only the 4-core Pi was measured; speedup is bounded by core count and by the longest single song.

## Ideas not pursued yet
- `luck.rs`: avoid `draw` Vec clones on cache hits, skip exact-zero work. Must keep floating-point accumulation order bit-exact (no FMA, no reordering).
- Balance work across songs better (longest-first scheduling) since one slow song bounds the wall time.
- Share `luck::run` results across songs with equal curve signatures.

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

## Data structures (are hash sets the problem?)
Short answer: no longer. After the changes above, every hash/B-tree symbol together is ~3% of single-core cycles on both 3_73 and 5_141, spread over many small sites. The cases where a different structure paid off are done:
- luck rows: a dense `Vec<u32>` index instead of `FxHashMap` (change 2). Per DP pass only ~54 rows exist (keys spread over 2^18), so the touched index slots stay in cache; the rows themselves (~134 f64 each, two rows ~116 KB) are what exceeds L1. A small open-addressing or linear-probe table would not beat the dense index.
- observed notes in `rank_remainder`: a std `HashSet` -> a flag vector (change 3).
- notes by id in `Model::frame`: `FxHashMap` -> dense table (change 6).
- `Combo::at`: a binary search -> a remembered cursor (change 5).

Remaining hash/tree sites, all small:
- `gekiso_objective` memo keys hash whole `Vec<usize>` (`pattern_domains`, `Kernel::gain`, `Kernel::luck_base`): ~0.5% on 5_141. Interning the vectors or caching their hash would remove it.
- `Controller::update` probes `ranges[i].targets` (`FxHashSet`) per judged note and range: ~0.5% on 3_73. A per-range bitset over note ids would be cheaper, but `Range::targets` is a pub field of a pub type, so a cached copy could go stale if a caller mutates it. Changing the field type is a public API change and needs your call.
- `Incremental::fixed` (`BTreeMap`, a handful of rank bonuses) probed once per frame, plus master-data `BTreeMap`s (`note_percent`, member ranks): each <=0.6%.

The larger structural cost on 3_73 is memory layout, not hashing:
- `ConditionUpdater::prepare_triggers` (~6.4% self) stalls on the first load of each `effects[i].trigger` tag in 400-byte `Effect` records. Splitting hot checker state into a compact array (structure of arrays) would help, but `Effect` and its fields are pub.
- Model lifecycle (`Model::new` + `clone` + drop) is ~7.7%, much of it `Incremental`'s per-frame `Vec<Vec<NoteCommand>>` / `Vec<Vec<FactorCommand>>`: every clone allocates each non-empty frame and every drop walks all frames. One arena per kind with per-frame ranges or links would make clone a few memcpys. `factors` is private (about 1% to gain); `notes` is pub.

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

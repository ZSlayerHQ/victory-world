# Merge all of upstream, or port its speed work? (an Opus assessment, 2026-11-25 07:40Z)

A subagent's report, saved as it was returned on 2026-11-25. Figures come from this project's run logs and from
the sources it names; treat claims about other projects as it marks them.

**Don't merge all of upstream now. Port its constants change first, then an adapted version of the page-marking pair.** I ran the merge trial and then undid it. ds2 is back on `job/forks-2`, `git status --porcelain` is empty and `job/upstream-trial` is deleted. Paths are under `E:\this repository\victory\crates\`.

**1. Whole merge**
- **Size:** 53 paths, 462 conflict hunks, about 28,300 lines. Only 4 of upstream's 182 commits are already on our line.
- **Mechanical:** 54% of hunks, 48% of lines. These are insertions side by side and small edits made by both sides.
- **Same code changed two ways:** the other 46% of hunks and 52% of lines. That includes 15 items both sides wrote from scratch (`memory.rs`, `emit/rect.rs`, `sgd5.rs`).
- **The five hardest.** Each is two designs that can't coexist:
  1. `victory-gpu/src/watch.rs`: our journal of kernel write-watch calls (`writes`, `ask_ahead`) against upstream's page guards per copy, `Tracked::take/arm/saved` (c75fdba3).
  2. `shadow.rs` `Shadow` and `host.rs` settle: our copies in card memory, flights, relay and compare on the card, against upstream's CPU-mapped copies, snapshot segments and marks.
  3. Raw title memory, a shader ABI only one side can keep. `memory.rs` was added by both: our directory against upstream's page table with a dirty bitmap (27c3dc9d). `lower.rs` has a 404-against-51-line hunk (`memory_flat` against `raw_view`), and `draw.rs` `bind` conflicts too.
  4. Heap layout: `descriptor/host.rs` `HostHeap` (our allocator and `probe_view_limit` against upstream's stride and mark tables at `HEAP_VIEWS`), plus `draw.rs` `State::tables`.
  5. Host textures and depth twins (`resource.rs`, `texture.rs`): our `TwinUse` against upstream's `twin.rs` (13bbd6fe).
- **Estimate:** 10 to 15 working days until both fixture sets pass, then 1 to 2 weeks of world runs to get today's picture back.
- **Likely picture breaks:** tiled-lighting rectangles (upstream assumes v1 is the corner; ours finds the corner), shadows and material depth, ray-traced passes, skin and hair colour, and device removal on AMD.

**2. The copy-back pair**
- **Dependencies:** cd94d353 needs upstream's page guards on every copy and `withheld` (c75fdba3), snapshot segments (6d021fe3), `exact` (86a5ed6b), `raw_dword`/`MEMORY_SPACE` (27c3dc9d), `raw_view` (d71c3889) and `VIEW_STRIDES` (0b35b7fe). 940d32f6 is a two-line fix on top of it.
- **It can't be ported alone,** for three reasons:
  - Its one global bitmap assumes one submission runs at a time. Our flights overlap, so we'd need a bitmap per flight.
  - Our memory is write-watched, so a page can't be saved before the title writes it.
  - It adds two root descriptors to programs already at 64 dwords.
- **Adapted port:** about 1,000 to 1,500 lines, 5 to 8 days, high risk. It touches `lower.rs`, `shader.rs`, `emit/mod.rs`, `shadow.rs`, `watch.rs`, `descriptor/host.rs`, `draw.rs`, `host.rs`, `pipeline/host.rs` and `shader_cache.rs`.
- **Replace or feed:** it feeds our machinery. Compares and fetches would cover marked pages only; the relay and late wait stay.

**3. Upstream speed work we lack** (our equivalent after the dash)
- 683ad7a9, table constants read in place: a table's constant buffer is a raw view of its host copy, with no copy per draw — none on our side. `draw.rs` `tables` still copies at submission (`scratch` + `defer_fill`). Those fills trip `late_blocked`, which is cost (a).
- c75fdba3: page guards replace write-watch calls — none on our side; this is cost (c).
- 6d021fe3: one refresh per submission, and change checks no longer wait on the memory lock — partial.
- 27c3dc9d/0f637570: programs that use raw memory mark the pages they write — none. Our directory declares every copy written on each dispatch.
- 13bbd6fe, c47b5297 and 9c58a1c3: one texture per memory, shader warm-up, pipeline pre-build — partial.
- 705a2f63: faster detiling — none.

**4. Ours that must survive**
- Submission: late wait and flights, the relay, card copies.
- Change tracking: the write-watch journal and alias guards.
- Descriptors: the slot allocator, the AMD heap clamp, early textures.
- Textures: the packed upload queue, smaller-mip staging, our depth twins.
- Translator: lane-mask joins, doubles, permlane, mesh fixes, user-data spill, finding the rectangle's corner, BVH/intersect.
- Pipeline budget window, HLE file fixes, traces, caption, SGD5 tools.

**5. Recommendation**
Starting from upstream's head and bringing our fixes over has the same conflicts and loses our speed work. First three steps:
1. Write a `victory-shader` fixture (`VICTORY_WARP=1`) that reads a table constant buffer at an address not aligned to 256 through a raw view. It should fail today.
2. Port 683ad7a9, together with c75fdba3's raw view for `View::Constant`, behind a switch that keeps the copy path.
3. Hand run-analyst a world run that compares late waits, copies in ms and MB, and frame ms.

After that, decide which copy-back design to keep and record it, port the adapted marks, then repeat the merge trial.

Confidence: about 80% that a whole merge now would take more than two weeks and make the picture worse; about 60% that the constants port alone recovers most of the 180 ms.

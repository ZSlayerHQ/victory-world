# Where a frame's time goes: a play frame in an interior scene, about 370 ms

A subagent's report, saved as it was returned on 2026-11-25. Figures come from this project's run logs and from
the sources it names; treat claims about other projects as it marks them.

I've laid out the frame's time below. The card is the limit today, and our CPU work is the next limit after it. Source: newest build b8af600 (the ds2 HEAD), run `picture-picks`, the 5,000-draw interior room from 05:12:25 to 05:13:27 (62 s, 12 samples), given as median [10th–90th percentile]. The merged-play run (b069d991) and 8 minutes of fork-essentials (9c679a27, 265 ms a frame) have the same shape. All runs are diag builds with DRED on (the harness default). M means measured from a log line; I means inferred.

**What the lines actually measure (from the code)**
- **"preparing"** is `Host::submit` on the submitting thread, from after the settle until `ExecuteCommandLists`.
- **"on the GPU"** is not card time. It is the submitting thread waiting in `relay_wait` at the frame's one "settle" (a point where it must wait for every submission still in flight to finish and be copied back).
- **"copying back"** is the time of the relay thread (the thread that brings card results back into title memory). It runs alongside the frame and does not add to it. About 82% of it is waiting for its fetches, which go on the same queue as everything else.
- **The card clock** ("nothing of ours queued"): there is one direct queue and no queue-side waits, so "queued" is close to "busy". In the cutscene it agrees with PresentMon's GPU busy to within about 20%.
- **Sampling:** frame-line figures cover the last ~1 s before each 5-second line; the copystat lines (marked M* below) cover the whole 5 s on all threads.

**Frame time tree (play)**
```
Frame 371 [338–426] (M) — submitting thread, serial:
├─ title, between its 29 submissions ........... 54 [48–83] (M)
│   ├─ running ................................. 29 (M)
│   └─ blocked, on nothing named ................ 25 (I)
├─ our preparing ................................ 117 [108–130] (M)
│   ├─ copies (host copies brought up to date) .. 76 [72–89] (M)
│   │   ├─ GetWriteWatch + guards: 2,770 askings, 9.3 GB checked, 98% unchanged ... ~38 (M*)
│   │   ├─ ~14,000 kernel copies of ~500 B (buffer copies, fills) ................. ~29 (M*)
│   │   └─ reading changed pages (182 MB in all) ................................. ~9 (I)
│   ├─ textures ................................. 3 (M)
│   └─ unnamed: card sync list, ExecuteCommandLists, snapshots (2.4) ... ~37 (I)
├─ standing at the frame's one settle ............ 180 [139–211] (M)
│   ├─ card finishing its backlog ............... ~130–150 (I)
│   └─ relay merging the last flights ........... ~30–50 (I)
└─ gap between sampling windows ................. ~20 (I)
In parallel, not additive:
 card busy 284 [252–306] (M) = 77% of the frame; idle 85 [76–141] (M): 24 while we prepare, 61 while the title runs or the relay merges
   ├─ per-draw clamp, 5,117 a frame, each between two full waits ... 50–80 (I)
   ├─ our hash (370) and compare (102) passes ....................... 10–80 (I)
   ├─ 127 MB sent up, 89 MB fetched, depth twins .................... ~7–10 (I)
   └─ the title's own lists, incl. 713 barrier groups as full waits . ~120–215 (I, what is left)
 relay thread 288 [256–303] (M) = 6 fetch waits 236 [202–257] (M) + merging ~52 (I)
 5 recording threads: 131 each in our list calls (M), 57 of it DRED markers (M); not on the path in play
```

**Top five costs**

| Cost | ms | Mechanism | Scales with | Fix | Expected gain | Confidence |
|---|---|---|---|---|---|---|
| The title's own lists on the card | 120–215 | Translated programs; each of the title's 713 barrier groups becomes a full wait (`list.rs` barrier-group path) | Scene content, resolution | None yet; measure first | — | Low |
| The once-a-frame settle | Stands 180; its real cost is the card's 85 idle | `late_blocked`/`blocked_by` (host.rs) see a `Step::Fill` over a range a flight's shaders may write; `relay_wait` until every flight lands | Fixed, once a frame | #462 (constant-buffer fills on the card) | 40–80 (capped by the card's idle) | Medium |
| Per-draw clamp | 50–80 | `indirect::record_clamp_as`: global UAV barrier, dispatch, global UAV barrier before every ExecuteIndirect, then `indirect::done` | Draws, 11–16 µs each (slope across 6 runs; the code's own note says 14–16 µs per near-empty draw) | `VICTORY_INDIRECT_WINDOW=1` + #220 | 35–60 | Medium-low |
| Our preparing | 117; only ~24 is on the critical path | `run_deferred`/`Batch::flush`: one write-watch asking per range, guards, one syscall per small copy | Ranges asked, submissions, MB | `VICTORY_WIDE_REFRESH=1` (already on our line), #465's in-process copies | ≤24 now; 30–50 once the card is cut | Medium |
| Our hash and compare passes on card copies | 10–80 | `CARD_COMPARE` (host.rs): one thread walks each 64 KiB piece in 4,096 serial steps; `card_before` puts a transition between copies, so passes serialise per copy | Number of passes (ranges per submission), not MB | `VICTORY_CARD_HASH_WIDE=1` (#253) | 10–70 | Low |

**Is the card the limit, or are we?**
- **The card is the limit now.** It is busy 77% of the frame. We wait for it 180 ms at the settle; it waits for us 85 ms.
- **If the card's work were free,** the submitting thread alone takes about 54 + 117 + ~40 ≈ 200–210 ms (about 5 fps).
- **If our CPU work were free,** the frame is about 284 plus whatever of the title's 54 ms does not overlap: 285–340 ms.
- **What follows:** card-side savings come off the frame almost one for one, down to a ~200 ms floor set by our CPU. CPU-side savings pay at most ~24–85 ms until the card's work falls.
- **All known fixes together** reach about 200 ms (5 fps). 30 fps needs both the title's own card work and our serial CPU work cut about 6×, plus #462 so the two overlap.

**Cutscene and intro**
- **Cutscene:** 0.6–0.7 fps (1.4–1.8 s a frame). The card is busy only ~195 ms of that. The submitting thread waits 0.6–1.3 s between submissions for the recording threads.
- **Cutscene, first half:** the time goes to the once-a-frame heap pass in a recording thread (`heap_buffers` → `heap_textures`, draw.rs, staging up to 192 MB of textures a frame), 0.3–3.4 s a frame. In the second half it goes to texture refreshes waiting for title memory to hold still, 0.4–5.8 s a frame.
- **Intro (30 fps, 13 draws):** the title sleeps 31 ms of each 33.3 ms frame in its own frame waits. Our work is under 1 ms and the card's 0.8 ms.

**Other fixes and switches, not in the table**
- **`VICTORY_COPY_COMPARE=1`:** less sent up and fewer hash passes, but it adds 15–30 ms of compare work on our CPU. Net 0 to −40 ms, and it overlaps with `VICTORY_CARD_HASH_WIDE`.
- **`VICTORY_CARD_REHASH_RUNS=1`:** a partial version of `VICTORY_CARD_HASH_WIDE`.
- **`VICTORY_TEXTURE_NO_WAIT=1`:** worth seconds in the cutscene, nothing in play.
- **#465:**
  - Its copy-queue fetch is moot once #462 is in.
  - Its batched fetch buys little, because we already make only 6 fetches a frame.
  - Its in-process copies could save 15–25 ms of the kernel-copy time.
  - Its ray-tracing-off part saves about 0, because the builder is already off.
- **Release build (no DRED):** recording threads drop about 40%; the card saving is unknown.

**Not visible with today's lines, and the smallest instrument for each (largest unknown first)**
1. **The card's 284 ms, undivided.** Timestamp pairs around each sync list and check list in `Host::card_before`, around each title list at submission, and around each fetch. Read them when the relay lands each flight. Unlike `VICTORY_GPU_TIMING`, this keeps the relay and sending ahead on.
2. **~37 ms of preparing.** Timers around `card_before`, `ExecuteCommandLists` and `take_snapshots` in `Host::submit`.
3. **25 ms the submitting thread is blocked between submissions.** Time spent in our fence and event waits, added to the "thread … submitted" line.
4. **~52 ms of relay merging.** Split `card_merge_relay`, `hand_back` and the bottom-of-pipe writes.
5. **Recording-thread time by kind of list call.** Key `copystat::recorded` by method.

PresentMon only covers the cutscene today: it starts at the first heavy frame line and records for 60 s. Starting it on the play stretch would give an independent card-busy figure.

**Measurement plan**

Same keys and room each time, with `--heavy-seconds 300`. Read the 5,000-draw stretch (at least 10 frame lines). "Card busy" means ms/frame minus "nothing of ours queued" in the card's clock line.

Before any game run: the existing `bare_command_cost` test (real GPU, no game) gives a near-empty draw's cost with no change between draws ("nothing") and with a clamp between two waits. That says how much of the 11–16 µs per draw is ours.

1. **Hash passes.** The `job/speed-picks` build, rebased on b8af600, with `VICTORY_CARD_HASH_WIDE=1 VICTORY_TEXTURE_NO_WAIT=1`. Read card busy against 284. A drop of 40 ms or more means our hash passes were a top cost. In the cutscene, the wait for title memory should fall to near 0.
2. **Per-draw clamp.** Add `VICTORY_INDIRECT_WINDOW=1 VICTORY_BARRIER_TEST=indirect`. Read card busy against run 1. A drop of 30 ms or more says merge #220.
3. **The settle.** Add #462, cherry-picked. Read "settles" per frame (expect 0) and ms/frame. The frame should come down to run 2's card busy.
4. **CPU picks.** Add `VICTORY_WIDE_REFRESH=1 VICTORY_COPY_COMPARE=1`. Read "preparing" and the card's idle while we prepare, against run 3.
5. **The diagnostics build's own cost.** A release build of the same commit: no DRED, markers or counters. `VICTORY_BARRIER_TEST` is diagnostics-only, so the waits come back unless #220 is merged. Read ms/frame against run 4.

**Where the earlier reports don't hold up**
- **The speed-picks brief says ~200 ms goes to "reading back":** that is the relay thread, mostly waiting for the card, running alongside the frame. Its "130–200 ms preparing" is really 85–125 in play; 190–230 appears only in merged-forks, which ran with `VICTORY_WALLS_TRACE=1`.
- **The parallel-refresh pick adds nothing new:** `wide_refresh()` already exists on our line (host.rs:5498, off by default). The pick only flips the default and the follow-up commit flips it back. `VICTORY_WIDE_REFRESH=1` can be tried on `job/fork-essentials` with no extra branch.
- **The fork census says #462 "only shortens the CPU side":** it is the one fix that lets our work and the card's overlap. It also calls #462's target "a 52–80 ms settle". Ours stands 139–211 ms, and most of that is the card's backlog, which stays.
- **PresentMon "GPU busy ~150 ms" in the summaries and RUNS.md:** those are cutscene figures, not play.
- **The trexies report's "129 of 197 ms" for hashing:** that was measured on an AMD card (RX 6800) and another line. Ours is unmeasured (10–80).
- **The census's "#220 worth ~50 ms" holds** as a central estimate.

One slip: an early read of the merged-play log printed the line naming the game's folder in my tool output. It is not in this report.

The scripts and parsed data are in `<session scratchpad>/frametime/`: `parse.mjs` and `stats.mjs` for the numbers, `regress.py` for the per-draw slope, plus one parsed `.json` per run.

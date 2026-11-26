# One memory for CPU and GPU: what other projects do, and a ranked plan

A subagent's report, saved as it was returned on 2026-11-25. Figures come from this project's run logs and from
the sources it names; treat claims about other projects as it marks them.

**Unified memory on a PC: what the others do, and what we should change (research only; no files changed, no builds or runs)**

**The answer in plain words.** None of the other projects copies the card's results back to the console's memory after every submission, and only one checks memory per range the way we do. They keep a per-page "changed" flag, set by catching the first write to a protected page. They batch uploads into one staging area and copy them in the card's own order. The card's results stay on the card until the game actually reads them, or until an option asks for them. XCL is real (github.com/xcl-dev/xcl). It is built like VIctory and looks like the project the owner meant. Its runtime uses only one small 512 MB shared window and copies back only explicit memory operations. Our biggest single cost, the 180 ms settle, comes from doing card-order work on the CPU. The first change should move constant-buffer fills onto the card. In-place mapping is right only for small shared data.

**How others do it.** Tags: [src] read in source, [doc] from their documentation, [mem] from memory, unverified.

| Project | Finding CPU writes | GPU results back to the CPU | Direct mapping | Batching and sync |
|---|---|---|---|---|
| shadPS4 | Write faults on 4 KiB pages; per-16 MiB bitmaps; one protection call per run of pages. Its own copies go through an unprotected second view (`page_manager.cpp`, `region_manager.h`, `core/memory.cpp`) [src] | `readbacksMode` is Disabled by default. Relaxed/Precise download on a fault, waiting for the whole card (`BufferCache::ReadMemory`) [src]. About 7 ms/frame measured on a 5090 (#4316) [doc] | Host import was removed (PR #2819). Uses device-local sparse arenas and a GPU-written fault bitmap [src][doc] | Staging ring in stream order; small read-only binds go to a 128 MB stream buffer [src] |
| Xenia / Canary | 4 KB watch bits; invalidation widened to 256 KB because 4 KB gave 4 fps (`memory.cc`, `shared_memory.cc`) [src][doc] | Resolves and memexport stay on the card. Readback is off by default ("huge performance impact"). Canary's `fast` mode is one frame late [src] | No import. One 512 MB buffer in card memory, tiled [src] | Stale runs merged into one copy each; 3 frames in flight, no per-frame wait [src] |
| RPCS3 | Texture sections locked at 4 KiB, protect calls merged; vertex data untracked and re-uploaded [src] | Lazy on a fault, waiting only for that section's event; a predictor reads back early [src] | `VK_EXT_external_memory_host` for readback/DMA only, gated by vendor (`VKDMA.cpp`) [src] | Ring heaps; faults batched [src] |
| yuzu | Per-page CPU/GPU bitmaps; a page is untracked after its first write; invalidations batched per fence (`word_manager.h`) [src] | Async download at each fence; reactive flush on a CPU read waits for all card work [src] | None found [src] | Stream buffer; Normal accuracy does not hold the game at fences [src] |
| Ryujinx | Read-only tracking at 4 KiB; pages faulting 5 rounds in a row become "volatile" and stop being reprotected [src] | Lazy: written ranges are tagged with a sync number, and a CPU access waits only for that sync (`BufferModifiedRangeList.cs`) [src] | Import only for linear-texture flushes; `BufferBackingState` picks host or device memory per buffer from usage counts [src] | Staging ring [src] |
| Dolphin | Sampled texture hashes; vertices re-read every draw; page locking tried and dropped (PR #6128) [src][doc] | EFB copies stay texture-only by default; RAM copies deferred to sync points (Xenoblade 62 → 156 fps) [doc] | None [src] | Stream buffers [src] |
| XCL | `GetWriteWatch` per submit; only changed 64-byte chunks uploaded. A full scan cost 10 ms per submit, so it was cut to mapped tiles. Read-only guards rejected because `ReadFile` fails on them (`uma.rs`, `HANDOFF.md`) [src][doc] | Only explicit memory operations (Write32/64, Fill, copies, timestamps) and `Map` with a read range [src] | `OpenExistingHeapFromAddress` windows (at most 4095 MiB, must be fully committed); at runtime one 512 MB window. Sparse buffers backed by card memory otherwise [src] | Async staging ring; the title's queue waits on the upload fence on the card, so the CPU never stalls [src] |

Part of XCL's `uma.rs` I checked myself.

**Our mechanism, in the same columns**
- **Finding CPU writes:** `GetWriteWatch` per range, at 64 KiB, kept in a `BTreeMap` journal (`watch.rs` `writes`, `ask_once`, `ask_kernel`). The page pool's views use read-only guards and an exception handler instead (`guard`, `protect`).
- **GPU results back:** eager, of every range that was declared written, not what was actually written. Root UAVs declare to the end of their buffer (`draw.rs` `root_uav`). The raw-address pass declares every numbered copy whole (`memory.rs`). After each flight we snapshot or hash those ranges (`Shadow::writing`, `CARD_COMPARE` via `card_before`), then fetch and merge whole 64 KiB pieces (`relay_worker`, `card_merge_relay`).
- **Direct mapping:** experimental only (`inplace.rs`).
- **Batching:** `Batch::flush` merges refreshes per copy. But each title copy and each constant fill is its own kernel call (`copy_mapped` → `ReadProcessMemory`). A submission whose CPU-side steps read memory a flight may write waits for it (`late_blocked`, `blocked_by`, `relay_wait`).

**What causes our three big costs**
1. **The settle.** In every recent log the one settle per frame has the same reason, "a fill of upload memory": 151 ms (settled-trace run) and 187 ms (turn2-base). Constant buffers named in descriptor tables are copied by the CPU at submission (`defer_fill`). Their source lies inside the hugely over-declared write ranges, so the CPU must wait. The others read constants on the card, from the card's own copy.
2. **Copy-back volume.** This comes from eager copy-back of declared ranges. The hash pass also gives one thread a whole 64 KiB piece (4,096 loads one after another), and runs 514 such passes a frame. The others leave results on the card until a fault, a fence or an explicit read.
3. **Thousands of askings and copies.** `GetWriteWatch` cannot span allocations, and we ask over 9.3 GB of ranges. That total is padded by 4 MiB windows and by 625 windows asked without a length (2,500 MB). Each roughly 500-byte copy is a syscall. The others copy with a plain memcpy through an unprotected second view (shadPS4, RPCS3, Xenia).

**Why `VICTORY_INPLACE=1` placed no buffers, and whether in-place is the end state**
- **Zero buffers was by design.** Level 1 places only windows; `place_for` returns before buffers are counted. Level 2 handles buffers, and is documented unsafe with late wait, because placed buffers skip `gpu_writes` and the flight line never sees their writes.
- **The windows it placed** (80–81, 384–388 MB) are exactly the census's "private, committed whole" class (78 windows, 364 MB).
- **What it turned down** (691 to 1,037, counted over the whole run) is view memory and windows that overhang uncommitted pages. Of the 715 windows: 432 are view memory with unmapped pages (1,816 MB), 169 are private but not committed whole (692 MB), 33 are single runs of a section (164 MB).
- **Why views fail:** the page pool sections (6,236, 710 and 185 MB) are `SEC_RESERVE`, which `OpenExistingHeapFromFileMapping` refuses.
- **To open most ranges:**
  - Trim windows to the extent actually asked for.
  - Make the pool `SEC_COMMIT`, or several committed chunks. Opening by file mapping does not pin views.
  - Place buffers at a view's offset in its section.
  - At level 2, still declare placed buffers' writes to the flight line.
  - Scattered pages can never be one heap: tile mappings into such heaps remove the device.
- **Hazards the file lists:**
  - Committing 6.1 GB at once risks error 1450 on hosts with less commit headroom.
  - While a heap opened from an address stands, the title's `VirtualFree` and `VirtualProtect` fail with error 87. `title_memory_freeing` is not wired into those calls.
  - Write-watch is blind to the card's writes (the probe saw 0 of 16 pages), so other copies of the same bytes go stale.
- **Is it the end state?** Not for the bulk. The heap sits in PC memory (L0) and the card reads it over the bus. Our run 70 measured one skinning group taking 1.8 ms that way; moving copies to card memory took BVH skinning from 50.5 to 4.5 ms. Microsoft calls these heaps "special-purpose diagnostic" [doc]. shadPS4 dropped import, RPCS3 and Ryujinx use it only for readback, and XCL keeps one 512 MB window.
- **The target is a per-buffer choice, as Ryujinx's `BufferBackingState` does:**
  - in place: small CPU-written, read-once data (constants, per-draw arguments) and small results the CPU reads (counters, culling output, queries);
  - card memory with lazy sync: textures, the 174 MB heap and other hot buffers.

**The plan, ranked by gain against risk**
1. **Fill constants on the card** (`draw.rs`: the table `View::Constant` path and `root_view`).
   - *Change:* refresh the source range in its host copy. If the address is 256-aligned, point the constant-buffer view at the copy (`shadow.gpu`); otherwise record a card-side copy into a constant ring in card memory.
   - *Removes:* the settle and most of the 14,000 fills (29 ms).
   - *Expected:* about 370 → 285–300 ms. The frame then waits on the card, not the CPU.
   - *Fixture:* on WARP, a flight's UAV writes beside constants the title then writes; the next list reads both bytes, with zero "fill" settles.
   - *Effort and precedent:* days. Xenia, XCL, yuzu.
2. **Parallel compare pass** (`CARD_COMPARE`).
   - *Change:* a thread group per piece with a reduction, one dispatch per submission.
   - *Removes:* most of the 10–80 ms of card time our passes take.
   - *Fixture:* flags match a CPU reference at piece edges and offsets.
   - *Effort and precedent:* 1–2 days. No precedent: the others track writes instead of hashing.
3. **Lazy copy-back** (`shadow.rs`, `relay_land`, `watch.rs`).
   - *Change:* written pages stay newest on the card. Title pages become no-access; on a fault, wait only for that flight, then fetch. Pages that fault every frame go back to eager fetching.
   - *Removes:* most of the 89 MB fetched and most compares.
   - *Risk:* kernel reads of no-access pages fail rather than fault (`ReadFile`, DirectStorage); pages shared with command memory may fault constantly.
   - *Fixture:* a counter is read after the fence; a range nobody reads is never fetched.
   - *Effort and precedent:* weeks. Ryujinx, RPCS3, yuzu.
4. **Copies without the kernel** (`copy_mapped`, `read`, `write_mapped`).
   - *Change:* a plain copy whose faults the exception handler turns into a failure return, falling back to today's path.
   - *Removes:* about 25 ms of CPU.
   - *Fixture:* a decommitted page mid-range reads as zeros, with no crash.
   - *Effort and precedent:* days. Second-view memcpy in shadPS4, RPCS3, Xenia.
5. **One asking per allocation per submission, into a bitmap** (`watch.rs` journal), plus trimmed windows and sized root views.
   - *Removes:* most of the 38 ms.
   - *Effort and precedent:* about a week. Xenia, yuzu; XCL's cut to mapped tiles.
6. **In-place for small shared data** (level 2 with declared writes, committed pool chunks).
   - *Removes:* refreshes and copy-back for counters and constants.
   - *Effort and precedent:* weeks. XCL, RPCS3, Ryujinx.

Do item 1 first. One measurement confirms it: on the same save, the frame line's "fill of upload memory" settles go from 1.0 to 0.0, and the card's busy share rises from 77% to above 95%.

**Instruments we lack.** We need timestamp queries at the edges of:
- `card_before`'s sync list;
- the title's lists;
- the compare list;
- the relay's fetch list.

Resolve them into a readback buffer inside the compare list, read them in `relay_land`, and align them with `GetClockCalibration`. The smallest version is a ring of 8 timestamps per flight slot in `Host::submit`. We also lack counts of: fills under flight writes, aligned against unaligned constant buffers, askings per allocation, and bytes declared against bytes actually changed.

**Not established, and how sure I am**
- **Not established:**
  - which fill and buffer trigger the settle;
  - what the 41 ms "unnamed" part of preparing is (the turn2-base log shows "heap buffers … passes 123.8 ms");
  - how many constant buffers are 256-aligned;
  - how fast the 5090 reads constants over the bus (the probe only shows the card copying 64 MB out in 1.2–1.4 ms).
- **Sources:**
  - yuzu and Ryujinx were read from mirrors, because the originals were taken down.
  - XCL's star count and creation date are unverified.
  - Absence claims (for example "no host import found") are lower bounds over the files the agents opened.
- **Confidence:**
  - high on our code and on the settle's cause, which is in the logs;
  - medium-high on the other projects;
  - medium on the gain figures.

Source snapshots and the census numbers are in `<session scratchpad>/unified-memory/src/`. The census and the settle reasons come from `<project>/harness/logs/20261125-022058-fork-warm.log`, `<project>/harness/logs/20261125-055425-turn2-inplace.log`, `<project>/harness/logs/20261125-054844-turn2-base.log` and `<project>/harness/logs/20261125-060618-settled-trace.log`.

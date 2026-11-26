# 46 — Break down submission-time preparation per thread

- **Title:** Break down submission-time preparation per thread
- **Lane:** CPU threading (draw preparation across cores)
- **Goal:** A submission's preparation (about 96 ms a frame in the 2026-11-26 run, 59 ms of it memory copies) is one figure per frame. The parts before preparation are already split per thread; the preparation itself is not. Add named parts inside the submission and print them per submitting thread, so a stage can be chosen for moving off the thread with its cost in view.
- **Where the code is:** `crates/victory-gpu/src/copystat.rs`: `Part`, `Before`, `Submitter`, `submission_begins`, `submission_ends`, and the report loop that prints "thread {id} submitted"; `crates/victory-gpu/src/host.rs`: `Host::submit`, from `let started = std::time::Instant::now()` to `let prepared = ...`, including `list.run_deferred`, `crate::capture::targets_submitted`, `crate::shadow::take_snapshots`, `send_signals` and `card_before`.
- **Files owned:** `crates/victory-gpu/src/copystat.rs`, `crates/victory-gpu/src/host.rs` (the timing marks only)
- **Symptom:** The per-thread line accounts for the time from the call to preparing, and then reports only the thread's total running time. A 59 ms copy stage and a 5 ms bookkeeping stage look the same.
- **Evidence:** `Before` has six `Part`s and ends at `Part::Other` before `started`; `Submitter::before` holds only them. The frame line's "preparing" is summed across threads.
- **Ruled out:** The card's time, which the stamps measure; the copy-back, which has its own line.
- **Done when:** A test delays one new part and sees the delay in that part for that thread only; `cargo test -p victory-gpu` passes; a run with diagnostics prints the new parts per thread in the existing line. The parts sum to the preparation time within a small tolerance.
- **Test:** `host.rs` tests use the `HOOKS` steps; add one hook inside preparation and assert the new part. Keep `each_part_before_preparing_holds_its_own_delay` passing.
- **Out of scope:** Moving a stage; changing the frame line; the copy-back.
- **Size:** M
- **Needs:** none for the test; a copy of the title shows the line on a real frame.

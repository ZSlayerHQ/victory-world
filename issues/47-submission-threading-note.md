# 47 — Design note: move one preparation stage off the submitting thread

- **Title:** Design note: move one preparation stage off the submitting thread
- **Lane:** CPU threading (draw preparation across cores)
- **Goal:** Choose one named preparation stage, measure it, and write the design for moving it off the submitting thread behind a switch. The note must be enough for a second agent to implement it without re-deciding the ownership or the ordering.
- **Where the code is:** `crates/victory-gpu/src/host.rs` `Host::submit` and `HostList::run_deferred`; `crates/victory-gpu/src/copystat.rs` (`Before`, `Part` and the per-thread line added by task 46). The note is a new file `docs/design/submission-threading.md` in the runtime repository.
- **Files owned:** the new note; no code
- **Symptom:** The recommendation to port another fork's threaded recording was withdrawn because its gain was about 25 ms; the project's own one-thread preparation is now the main road, and no note compares the stages.
- **Evidence:** The frame line of the 2026-11-26 run and the per-thread line; the board's note that the one-thread preparation is about 96 ms a frame, 59 ms of it memory copies.
- **Ruled out:** The copy-back and the relay, which have their own measurement and work.
- **Done when:** The note names one stage (for example the deferred title-memory copies), gives a table of its cost per frame and per thread from a named run, lists what the move needs (ownership of the deferred work, the submission lock, ordering with shadow snapshots and the card's sends, visibility of the writes), names the switch and the fallback, and gives a step plan with a fixture for each step. A reviewer can follow it without the run.
- **Test:** None; this is a note. Say why in the pull request.
- **Out of scope:** Implementing the move; changing the switch defaults.
- **Size:** M
- **Needs:** a copy of the title for the measurements.

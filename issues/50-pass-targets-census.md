# 50 — Name each pass and its render targets

- **Title:** Name each pass and its render targets
- **Lane:** Upscaling (DLSS in place of the title's own temporal upscaler)
- **Goal:** The pass census names a pass by the title's list label or its first program, but not by what it draws to. Add the render targets bound at the pass's first call (count, format, width and height) to the pass name, so a capture can say "this is the resolve that writes 2560x1440" without reading a target dump.
- **Where the code is:** `crates/victory-gpu/src/passes.rs` (`By`, `PassName`, `name_text`, `lines`, `parts`); `crates/victory-gpu/src/capture.rs` (`note_target`, the target record); `crates/victory-gpu/src/draw.rs` (`State::bind`, where a pass begins).
- **Files owned:** `crates/victory-gpu/src/passes.rs`, `crates/victory-gpu/src/capture.rs`, `crates/victory-gpu/src/draw.rs`
- **Symptom:** Two passes with no label and the same first program are told apart only by fragment and place; their targets are not in the line, so a census cannot name the upscaler.
- **Evidence:** `name_text` prints a label hash or up to four program ids; `note_target` records a target only when target dumps are on.
- **Ruled out:** Naming every target of every pass forever; the line carries at most a few.
- **Done when:** A test with two synthetic passes to different targets asserts each name carries its target's format and size; a run with `VICTORY_GPU_PASSES=1` prints the targets in the pass line; `cargo test -p victory-gpu` and clippy pass.
- **Test:** `passes.rs` tests use a `call` helper and a fake list and pipeline; add a target record and assert the printed name. Keep the existing naming and median tests passing.
- **Out of scope:** The pass timing itself; target dumps; the upscaler replacement.
- **Size:** M
- **Needs:** none for the test; a copy of the title for the run line.

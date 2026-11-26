# 49 — Census the temporal upscaler's inputs over two frames

- **Title:** Census the temporal upscaler's inputs over two frames
- **Lane:** Upscaling (DLSS in place of the title's own temporal upscaler)
- **Goal:** The title renders at 2560x1440 and its own temporal upscaler writes the 1440p image before a spatial upscale to 2160p. Measure, across two consecutive frames, the inputs that a DLSS replacement needs: the colour, depth and velocity targets, the output, the jitter in pixels, and the motion-vector sign and scale.
- **Where the code is:** `crates/victory-gpu/src/capture.rs` (`note_target`, `dump_targets`, the target list); `crates/victory-gpu/src/passes.rs` (`label_hash`, `By::Label`, `parts`); `crates/victory-gpu/src/draw.rs` (`State::bind`, where a pass begins); `crates/victory-gpu/src/host.rs` (the frame line). The exact files are to be confirmed by the lead after the first capture.
- **Files owned:** `crates/victory-gpu/src/capture.rs`, `crates/victory-gpu/src/passes.rs`, `crates/victory-gpu/src/draw.rs`; ask before editing `host.rs`
- **Symptom:** The pass is not named in any public note, and the jitter and motion-vector convention are unmeasured, so a DLSS evaluate cannot be placed.
- **Evidence:** The upscaling scope notes; the title renders 2560x1440 for a 3840x2160 output through its own upscaler.
- **Ruled out:** The spatial upscale after the temporal one; it is not the replacement target.
- **Done when:** With a copy of the title, two consecutive frames are captured and the log prints one census line per frame naming the colour, depth and velocity targets by format and size, the output, the jitter x and y in pixels, and the velocity target's first non-zero values with their sign and scale. The note in the task gives the figures and says which are certain and which are inferred. `cargo test -p victory-gpu` passes and the census has a unit test on made-up values.
- **Test:** A unit test for the census record and its line: two synthetic frames, two jitters, a sign and a scale. The real run is the evidence.
- **Out of scope:** Writing the DLSS evaluate; changing the upscaler; judging image quality.
- **Size:** M
- **Needs:** a copy of the title and a capture run; an NVIDIA RTX GPU for the later replacement, not for this census.

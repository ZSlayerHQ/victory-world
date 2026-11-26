# 03 — Run the scissor test and capture both frames

- **Title:** Run the scissor test with heavy frames captured
- **Lane:** Native memory (moving off the console's shared memory model)
- **Files owned:** none; one run and its capture
- **Symptom:** the walls must be shown to be drawn and then cut, not absent, using the fork's own switch that ignores the title's scissor.
- **Evidence:** the switch `VICTORY_SCISSOR_TEST=full` exists in `crates/victory-gpu/src/draw.rs`; the scissor rectangles in run `fork-essentials` are exactly the window opening.
- **Ruled out:** —
- **Done when:** one run with the switch set and heavy frames 900 and 1100 captured shows the walls beside the window in depth and base colour; the summary is pasted with the run tag.
- **Size:** S

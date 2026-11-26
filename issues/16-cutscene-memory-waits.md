# 16 — Stop waiting for title memory to hold still in cutscenes

- **Title:** Stop waiting for title memory to hold still in the cutscenes
- **Lane:** Native memory (moving off the console's shared memory model)
- **Files owned:** the texture refresh path (`crates/victory-gpu/src/texture.rs`, `crates/victory-gpu/src/draw.rs`)
- **Symptom:** the cutscenes run at 0.4 to 0.7 frames a second while the card is only 6 to 23% busy; most of each frame goes to texture refreshes waiting for title memory to stop changing, up to 1,069 ms in one frame.
- **Evidence:** run `fork-caption` (the summary's frame breakdown and the texture-refresh waits).
- **Ruled out:** GPU load as the cutscenes' limit.
- **Done when:** a cutscene run's median frame falls with the picture unchanged, and the summary shows the wait gone or bounded; counts and times reported.
- **Size:** M

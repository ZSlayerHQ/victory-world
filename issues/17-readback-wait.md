# 17 — Cut the read-back wait in play

- **Title:** Cut the read-back wait in play
- **Lane:** CPU threading (draw preparation across cores)
- **Files owned:** `crates/victory-gpu/src/host.rs` (copy-back and submission), `crates/victory-gpu/src/queue.rs`
- **Symptom:** in the playable scene the card is about 76% busy and frames take 270 to 575 ms; reading results back takes 164 to 290 ms a frame, and about 350 ms a frame sits outside every listed phase.
- **Evidence:** runs `fork-caption` (copy-back 190.9 ms), `fork-essentials` (read-back 201.5 ms), `fork-wave-wide` (read-back 164.0 ms and 2.9 fps with the switch).
- **Ruled out:** —
- **Done when:** a run's play median frame falls with the picture unchanged, in the summary's own figures; the change stays behind a switch until a second run confirms it.
- **Size:** M

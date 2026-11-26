# 54 — Note what the rehydrate call receives

- **Title:** Note what the rehydrate call receives
- **Lane:** Ray tracing
- **Goal:** The rehydrate call is where the static world's geometry would be handed to a DXR build. With the logging shim on, capture what it actually receives in a run that streams the world, and write the note the first DXR task will start from.
- **Where the code is:** `crates/victory-hle/src/modules/bvh_builder.rs` (the rehydrate wrapper and its record parser); `crates/victory-hle/src/modules/mod.rs`; a new `docs/design/rehydrate-inputs.md`.
- **Files owned:** the shim and the new note; no behaviour change to the title
- **Symptom:** The shape of the rehydrate call is known from the library's own records, but no run has shown what the title passes: batch sizes, source structures, geometry kinds and formats, and whether primitive identity is present.
- **Evidence:** The scope notes say the rehydrate call has never been logged and that the static world's geometry at this call is the first gate.
- **Ruled out:** The build calls (task 52); dynamic objects; the trace programs.
- **Done when:** The note has a table of what one streaming run received: calls, elements per call, source and destination sizes, stream records, geometry kinds and flags, index and vertex formats and counts, and whether primitive identity is present. A unit test parses a synthetic rehydrate batch and produces the same table's fields. `cargo test -p victory-hle bvh_builder` passes.
- **Test:** A record-parsing test with made-up values; the run is the evidence.
- **Out of scope:** Building DXR structures; changing the rehydrate; deciding the static-world route.
- **Size:** S
- **Needs:** a copy of the title and a run that streams the world; the unit test needs none.

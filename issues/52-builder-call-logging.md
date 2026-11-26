# 52 — Merge-ready logging of the structure builder's calls

- **Title:** Merge-ready logging of the structure builder's calls
- **Lane:** Ray tracing
- **Goal:** A prototype shim logs the title's seven imports from its acceleration-structure library and forwards each call unchanged. Make it merge-ready: diagnostics builds only, bounded output, addresses as an allocation plus offset, no vertex or index data, tests for the served and unserved cases, and the forwarding path the loader needs.
- **Where the code is:** `crates/victory-hle/src/modules/bvh_builder.rs` (new; the maintainers hold a prototype on a branch and share it on the task); `crates/victory-hle/src/modules/mod.rs` (register the module); `crates/victory-hle/src/registry.rs` (`forwarded`, `prepare_forwarded`); `crates/victory-hle/src/lib.rs`; `apps/victory/src/run.rs` (`title_dll`, export registration).
- **Files owned:** the five files named above
- **Symptom:** The builder's calls are invisible; the structure work cannot start without knowing the call mix, the geometry formats and whether primitive identity arrives.
- **Evidence:** The scope notes name seven imports (constructor and destructor, the batched build, copy, prebuild info, the batched rehydrate, the Morton-code switch); the prototype logged them.
- **Ruled out:** Building DXR structures; changing the library's behaviour; logging every call forever.
- **Done when:** `cargo test -p victory-hle bvh_builder` passes (a forwarded library is served while all exports resolve and stops when one does not); `cargo xtask policy` passes; a run with `VICTORY_BVH_BUILD_LOG=1` prints the first calls in full and one summary a second, and the title runs as it did without the shim. With a copy of the title, the log shows the build and rehydrate calls of a streaming minute.
- **Test:** The served and unserved fixtures and a record-parsing test with a synthetic 0x50-byte element; no title data.
- **Out of scope:** The rehydrate note (task 54); DXR; changing the builder's on/off switch.
- **Size:** M
- **Needs:** a copy of the title and a run that streams the world; the unit tests need none.

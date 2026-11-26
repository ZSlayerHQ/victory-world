# 43 — Record the written range a mapped resource is unmapped with

- **Title:** Record the written range a mapped resource is unmapped with
- **Lane:** Native memory (moving off the console's shared memory model)
- **Goal:** The title maps a resource, writes part of it, and unmaps it with a `D3D12_RANGE` that names the bytes it wrote. The runtime's `Unmap` ignores the range, so writes through a title mapping are invisible to the texture refresh and the page-write path. Record the range and pass it to the existing written-memory path.
- **Where the code is:** `crates/victory-gpu/src/resource.rs`: `unmap` (the empty method at resource vtable slot 9, `RESOURCE_FUNCTIONS` `f[9]`) and `map` beside it; `crates/victory-gpu/src/watch.rs`: `title_memory_written(at, len, pages)`.
- **Files owned:** `crates/victory-gpu/src/resource.rs`
- **Symptom:** A title `Unmap` with a written range whose `End` is not zero drops the range. Place a texture in that memory and the refresh does not see the write; a later upload serves the old bytes.
- **Evidence:** `unmap` is `extern "system" fn unmap(_: This, _sub: u32, _written: *const c_void) {}`; `map` already says "memory is always mapped". `title_memory_written` is the path DirectStorage and kernel reads use.
- **Ruled out:** The read range passed to `Map`; it is a hint and is out of scope.
- **Done when:** A test maps a committed buffer, unmaps it with a range, and asserts the written bytes were reported once with the right start and length (the `WRITTEN` counters or the slot-due path); a zero-length range reports nothing; `cargo test -p victory-gpu` and `cargo clippy -p victory-gpu --all-targets -- -D warnings` pass.
- **Test:** `crates/victory-gpu/src/resource.rs` tests: a resource and a `D3D12_RANGE`; assert the written count or the texture-slot due count before and after.
- **Out of scope:** `Map`'s read range; mapping subresources separately; the unified-memory model.
- **Size:** S
- **Needs:** none.

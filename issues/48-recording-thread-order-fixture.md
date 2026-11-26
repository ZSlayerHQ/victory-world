# 48 — Stress fixture for ordering between recording threads

- **Title:** Stress fixture for ordering between recording threads
- **Lane:** CPU threading (draw preparation across cores)
- **Goal:** Lists are recorded on many threads and run in submission order; a list's texture-state prelude assumes the transitions of the list before it. Build a stress fixture that records lists on two or more threads against the same textures and buffer, submits them in both orders, and fails if the preludes or the values read do not follow the recorded order.
- **Where the code is:** `crates/victory-gpu/src/host.rs` tests (the submission and prelude path); `crates/victory-gpu/src/list.rs` (`States`, `State::replay`, the list prelude, `detach_parts`); `crates/victory-gpu/src/queue.rs` (`execute` order).
- **Files owned:** test code in `crates/victory-gpu/src/host.rs`, `crates/victory-gpu/src/list.rs`, `crates/victory-gpu/src/queue.rs`
- **Symptom:** The ordering rule is written in comments and tested one list at a time; nothing stresses two recording threads and a shared resource.
- **Evidence:** `HostList.states` says "Lists are recorded on many threads and run in submission order, so the transitions from a texture's real state are made at submission, in prelude."
- **Ruled out:** The title's own thread count; the fixture uses its own threads.
- **Done when:** The fixture runs 50 iterations with two threads and both submission orders, asserts every read sees the value and state its order requires, and passes on a normal run; an injected change that moves the prelude after its list makes it fail. `cargo test -p victory-gpu` passes.
- **Test:** The fixture itself; keep it deterministic with barriers, not sleeps.
- **Out of scope:** The title's recording; changing the submission lock.
- **Size:** M
- **Needs:** none.

# 36 — Count a direct target dump as card work

- **Title:** Count a direct target dump as card work
- **Lane:** Tools and harness
- **Files owned:** crates/victory-gpu/src/host.rs
- **Symptom:** The direct dump submission bypasses the card-sent accounting, so the GPU clock can count the dump as idle.
- **Evidence:** Review of the landing, second look, new fault 8.
- **Ruled out:** —
- **Done when:** The card-sent count is updated after enqueueing the dump, as a normal submission does; a test covers the clock.
- **Size:** S

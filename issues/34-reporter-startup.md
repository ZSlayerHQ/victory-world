# 34 — Reporter startup and rejected-count races

- **Title:** Reporter startup and rejected-count races
- **Lane:** Tools and harness
- **Files owned:** crates/victory-gpu/src/host.rs
- **Symptom:** The receiver can finish its last job before a producer increments a rejected count, then block in receive; a worker spawn failure also leaves the one-time initialization set to none for good.
- **Evidence:** Review of the landing, second look, new fault 5.
- **Ruled out:** —
- **Done when:** A timed receive checks the counter, and worker startup is retried off the completion path; tests cover both.
- **Size:** S

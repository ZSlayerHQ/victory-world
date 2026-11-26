# 37 — Bind caption updates to a window generation

- **Title:** Bind caption updates to a window generation
- **Lane:** Tools and harness
- **Files owned:** crates/victory-gpu/src/host.rs
- **Symptom:** The caption's owner checks compare thread and window ids. They can accept a handle recycled to another window on the same thread, and the handle can change between the check and the write; the presenter also refreshes the owner from its cached handle.
- **Evidence:** Review of the landing, second look, finding 10 (partly).
- **Ruled out:** —
- **Done when:** The caption is bound to a window generation when the presenter is created and checks it on the owner thread at the write; a test covers a recycled handle.
- **Size:** S

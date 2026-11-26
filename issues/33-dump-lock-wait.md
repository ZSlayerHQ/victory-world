# 33 — Release the submission lock before waiting for a target dump

- **Title:** Release the submission lock before waiting for a target dump
- **Lane:** Tools and harness
- **Files owned:** crates/victory-gpu/src/host.rs
- **Symptom:** The lock spans list allocation, recording and the queue fence for every target, so another frame's submission or the retirement helper can wait through older GPU work ahead of the dump.
- **Evidence:** Review of the landing, second look, new fault 4, and the fourth look's follow-up list.
- **Ruled out:** —
- **Done when:** State read, barrier recording and enqueue stay serialized, and the wait happens outside the lock on the dump's own fence.
- **Size:** M

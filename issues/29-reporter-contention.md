# 29 — A reporter batch can be dropped under sender-mutex contention

- **Title:** A reporter batch can be dropped under sender-mutex contention
- **Lane:** Tools and harness
- **Files owned:** crates/victory-gpu/src/host.rs
- **Symptom:** A producer can drop an entire batch while another producer briefly holds the sender mutex, even with an idle reporter and an empty channel. Recording also takes that mutex for every indirect report or deferred callback, and can wait behind thread creation while holding the list's state.
- **Evidence:** Review of the landing, fourth look, new fault 1: the sender lock and the try-lock paths are quoted there.
- **Ruled out:** —
- **Done when:** The started sender is published once and producers read it without locking; startup is retried off the completion path; a test covers the contention.
- **Size:** M

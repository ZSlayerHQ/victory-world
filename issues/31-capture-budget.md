# 31 — Reserve a shared byte budget before mapping capture readbacks

- **Title:** Reserve a shared byte budget before mapping capture readbacks
- **Lane:** Tools and harness
- **Files owned:** crates/victory-gpu/src/host.rs, crates/victory-gpu/src/capture.rs
- **Symptom:** For listed captures, a slow reporter can retain a very large queued CPU payload (hundreds of slots of multi-megabyte reports, plus one active report), even when the reports are later discarded.
- **Evidence:** Review of the landing, second look, new fault 2: the queue slots and the per-list limits are quoted there.
- **Ruled out:** —
- **Done when:** Queue slots and a shared byte budget are reserved before mapping and returned on drop or after reporting; a test covers the budget under a slow reporter.
- **Size:** M

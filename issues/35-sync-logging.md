# 35 — Keep the recorder's refusal logs off the list-state lock

- **Title:** Keep the recorder's refusal logs off the list-state lock
- **Lane:** Tools and harness
- **Files owned:** crates/victory-gpu/src/capture.rs, crates/victory-core/src/logging.rs, crates/victory-gpu/src/list.rs
- **Symptom:** Oversized or over-budget captures log synchronously under the recorder's list-state lock. With the trace target enabled, a blocked stderr sink can stop recording on those paths.
- **Evidence:** Review of the landing, second look, new fault 6.
- **Ruled out:** —
- **Done when:** The small refusal line goes through the same bounded reporter, and rejections are counted there; a test covers a blocked sink.
- **Size:** S

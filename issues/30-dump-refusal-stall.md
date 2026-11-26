# 30 — The target-dump refusal can stall recording

- **Title:** The target-dump refusal can stall recording
- **Lane:** Tools and harness
- **Files owned:** crates/victory-gpu/src/capture.rs
- **Symptom:** The target-dump refusal writes its warning to stderr inside OnceLock initialization. A render-target bind can enter it while holding list state, and other gate callers wait for initialization, so a blocked stderr sink can stall the title on its first refused request.
- **Evidence:** Review of the landing, fourth look, new fault 2, with the call path from the render-target bind.
- **Ruled out:** —
- **Done when:** The gate is evaluated and the refusal logged during diagnostics startup, before command recording and presentation, with a test for a blocked sink.
- **Size:** S

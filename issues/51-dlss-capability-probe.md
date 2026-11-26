# 51 — DLSS capability probe test

- **Title:** DLSS capability probe test
- **Lane:** Upscaling (DLSS in place of the title's own temporal upscaler)
- **Goal:** Add a diagnostics test that reports whether this machine can run DLSS super resolution: the card's DXR tier and shader model, and whether a DLSS runtime library can be loaded from the process or the system. It must skip cleanly on a machine without them, not fail the suite.
- **Where the code is:** a new `crates/victory-gpu/src/caps.rs` (the probe); `crates/victory-gpu/src/host.rs` (`create` and the `CheckFeatureSupport` calls); `crates/victory-gpu/src/lib.rs` (the module).
- **Files owned:** the new `crates/victory-gpu/src/caps.rs`, `crates/victory-gpu/src/host.rs`, `crates/victory-gpu/src/lib.rs`
- **Symptom:** The project has no line that says whether DLSS is possible on a contributor's machine; the first DLSS task would otherwise start by debugging the environment.
- **Evidence:** The host already queries `D3D12_FEATURE_DATA_D3D12_OPTIONS1`; a DXR tier query and a library probe are small additions.
- **Ruled out:** Linking or shipping DLSS; frame generation; Streamline.
- **Done when:** `cargo test -p victory-gpu dlss_capability -- --nocapture` prints one line with the DXR tier, the shader model and the DLSS library's presence, and passes by skipping where absent; on an RTX 5090 it reports tier 1.1. `cargo clippy` is clean.
- **Test:** The probe test itself; it must not fail without the library or below tier 1.1.
- **Out of scope:** Loading the library; creating a DLSS feature; any title code.
- **Size:** S
- **Needs:** none; an NVIDIA RTX GPU to see the positive case.

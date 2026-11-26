# 41 — Lower the cut-out programs' primitive-ordered preamble

- **Title:** Lower the cut-out programs' primitive-ordered preamble
- **Lane:** Shaders to 100% (61 of 25,758 programs still refused; picture faults)
- **Goal:** Ten pixel programs are character cut-out programs that open with the console's primitive-ordered section: they read a hardware SGPR the translator has no input for, select a packer, and sleep until earlier overlapping waves exit. Recognise and drop that preamble and declare the views it writes rasterizer-ordered, behind a host capability check, so the ten translate and draw.
- **Where the code is:** `crates/victory-shader/src/emit/lower.rs` `Lower::inputs` (the `Val::Missing("a hardware SGPR input")` arm); `crates/victory-shader/src/io.rs` (`Input` and the input raise); `crates/victory-shader/src/emit/shader.rs` (the root UAV metadata's rasterizer-ordered field); `crates/victory-gpu/src/host.rs` (the host device's feature query); `crates/victory-gpu/src/device.rs` (`OPTIONS` and `check_feature_support`, which is only what the console is told).
- **Files owned:** the five files named above.
- **Symptom:** Ten pixel programs are refused with "a hardware SGPR input is not supported"; they are the character cut-out family. They cannot simply be dropped: the preamble orders overlapping waves and the images they write.
- **Evidence:** The measured warm-up of 2026-11-26: 61 refused, 10 pixel with that reason. The preamble reads the hardware's collision word and selects a packer before the sample.
- **Ruled out:** A missing instruction lowering; a missing sampler; the view bindings.
- **Done when:** A synthetic fixture with the preamble fails before with "a hardware SGPR input" and translates after on a host that reports rasterizer-ordered views, and refuses with one clear reason on a host that does not; `cargo test -p victory-shader`, `cargo test -p victory-gpu` and `cargo clippy` pass; with a copy of the title, the warm-up refuses 51 instead of 61 and a run draws the cut-out characters.
- **Test:** A fixture for the preamble and one for a host without support; the first must fail before the change.
- **Out of scope:** Any other hardware-input program that differs; the twelve sampler programs; the wide-wave group.
- **Size:** L
- **Needs:** a copy of the title; a Direct3D 12 GPU that reports rasterizer-ordered views (the RTX 5090 does) to confirm.

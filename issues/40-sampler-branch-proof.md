# 40 — Prove the sampler branch behind a section of EXEC

- **Title:** Prove the sampler branch behind a section of EXEC
- **Lane:** Shaders to 100% (61 of 25,758 programs still refused; picture faults)
- **Goal:** Twelve pixel programs are refused because an immediate sampler sits behind a branch the proof does not accept: the branch is neither a proved constant-buffer flag nor the `s_cbranch_execz` of the sample's own EXEC section. Admit that one branch shape exactly, so the twelve translate without changing any other program.
- **Where the code is:** `crates/victory-shader/src/emit/sampler_choice.rs`: `Lower::immediate_choice`, `Lower::admit`, `Lower::flag_branch`, `Lower::run_of` and `Lower::hangs_on`; the refusal is `BEHIND`. The tests are beside it in `crates/victory-shader/src/emit/sampler_choice_tests.rs`.
- **Files owned:** `crates/victory-shader/src/emit/sampler_choice.rs`, `crates/victory-shader/src/emit/sampler_choice_tests.rs`
- **Symptom:** The warm-up refuses twelve pixel programs with "an immediate sampler chosen by control flow behind a branch neither a proved flag nor the section of its sample's EXEC is not supported"; with the paired 64-lane form on they are still refused.
- **Evidence:** The measured warm-up of 2026-11-26: 61 refused in all; the twelve are the pixel group with that reason. The proof's accepted forms are written at the top of `sampler_choice.rs`.
- **Ruled out:** The sampler pair itself (one clamped, one wrapped) and the pixel program form: the same form translates in the terrain programs the module already admits.
- **Done when:** A synthetic fixture with the new branch shape fails before the change with `BEHIND` and passes after; `cargo test -p victory-shader sampler_choice` passes; with a copy of the title, the warm-up refuses 49 instead of 61 with the paired form on, and none of the twelve carries that reason.
- **Test:** `sampler_choice_tests.rs`: a pixel program with the branch shape and a sample in the join; assert the `Why` before and the translated program after. Keep the existing `UNPROVED` cases refused.
- **Out of scope:** The other refusal classes; descriptors chosen among loaded samplers; the 64-lane forms.
- **Size:** M
- **Needs:** none for the fixture; a copy of the title to confirm the twelve in the warm-up.

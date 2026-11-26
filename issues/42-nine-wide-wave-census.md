# 42 — Name the nine wide-wave programs the paired form refuses

- **Title:** Name the nine wide-wave programs the paired form refuses
- **Lane:** Shaders to 100% (61 of 25,758 programs still refused; picture faults)
- **Goal:** The paired 64-lane form recovers eighteen of the twenty-seven wide-wave compute programs, leaving nine it refuses for reasons that are not yet named. Produce a per-program census of those nine and fix the largest single reason, with a fixture, without touching the eighteen that already work.
- **Where the code is:** `crates/victory-shader/src/emit/paired.rs` (`with_paired_lanes`, `PAIRED_LDS_APART`, `swap_lanes`, `both`, and the whole-wave section's `UNKNOWN` and float-sum `ORDER` reasons); `crates/victory-shader/src/emit/mod.rs` (`wide_on` and the `VICTORY_WAVE_WHY=1` output).
- **Files owned:** `crates/victory-shader/src/emit/paired.rs`, `crates/victory-shader/src/emit/paired_tests.rs`, `crates/victory-shader/src/emit/mod.rs`
- **Symptom:** With `VICTORY_WAVE_WIDE=1` nine compute programs that need 64-lane waves are still refused; the warm-up names the program and its reason, but no one has grouped them.
- **Evidence:** The measured warm-up of 2026-11-26: 61 refused, 42 with the paired form on; 27 wide-wave programs refuse without it, 9 remain with it.
- **Ruled out:** The eighteen the paired form already recovers; the three that need thread groups of several console waves (issue 12).
- **Done when:** A table in the task comment lists the nine by program id and reason (one reason per program, the first it stops at). A fixture for the largest reason fails before and passes after; `cargo test -p victory-shader paired` passes; with a copy of the title, the warm-up with the form on refuses fewer than 42 by the size of that class, and nothing is newly refused.
- **Test:** A synthetic 64-lane compute program for the chosen reason, in `paired_tests.rs`; assert the refusal before and the translation after. Keep `PAIRED_LDS_APART` covered.
- **Out of scope:** The other eight if their reasons differ; making the paired form the default; the exact masked-wave work (issue 10).
- **Size:** M
- **Needs:** a copy of the title for the census and the warm-up; the fixture needs none.

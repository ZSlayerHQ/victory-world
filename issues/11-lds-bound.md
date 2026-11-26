# 11 — Bound LDS accesses by the allocation

- **Title:** Bound LDS accesses by the title's allocation
- **Lane:** Shaders to 100% (61 of 25,758 programs still refused; picture faults)
- **Files owned:** `crates/victory-shader/src/emit/lower.rs`
- **Symptom:** one compute program reads past its LDS allocation; the access is fatal only when the driver's shader error reporting is on (Aftermath), but it is out of range in every run.
- **Evidence:** the Aftermath dump in run `exp-prs` pins the read to address `0x1200`, a zero base plus 4,608 bytes, in no bound resource; the older line's fix `98e61357` bounds accesses by the allocation (about 125 lines).
- **Ruled out:** as the cause of the mesh hang (fatal only under error reporting).
- **Done when:** a fixture with an access past the allocation fails before and passes after; a run under the driver's error reporting shows no fault.
- **Size:** M

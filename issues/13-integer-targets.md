# 13 — Integer render targets: drop blending or emulate it

- **Title:** Handle blending on an integer render target
- **Lane:** Shaders to 100% (61 of 25,758 programs still refused; picture faults)
- **Files owned:** pipeline creation and the blend translation (`crates/victory-gpu/src/pipeline`, `crates/victory-shader/src/emit`)
- **Symptom:** one mesh pipeline is refused every run: the title blends into an integer target, which the host refuses. By its place in the frame it is a small masked overlay, not room geometry.
- **Ruled out:** as a cause of the missing walls.
- **Evidence:** run `fork-caption` (8 host-refused, this one every run); the older line's fix `42475c19` handles it (about 100 lines).
- **Done when:** the pipeline is made, or its blending is dropped for integer targets with a note in the summary; a run reports no refusal for it.
- **Size:** S

# 12 — Write a wave form for programs with several thread groups

- **Title:** Write the wave form for thread groups of several console waves
- **Lane:** Shaders to 100% (61 of 25,758 programs still refused; picture faults)
- **Files owned:** `crates/victory-shader/src/emit`, `crates/victory-gpu/src/pipeline`
- **Symptom:** three compute programs are refused on a 32-lane host because their thread groups span several 64-lane console waves; the lowering has no form for them. They stay refused every run.
- **Evidence:** run `fork-caption` (8 host-refused), run `fork-wave-wide` (4 refused with the approximate form; the remaining three are these). The refusals come from pipeline creation with `E_INVALIDARG`.
- **Ruled out:** the four that `VICTORY_WAVE_WIDE=last` already translates.
- **Done when:** the three translate and their pipelines are made on a 32-lane host, with a fixture for one of them; a game run reports no refusal for any of the three.
- **Size:** L

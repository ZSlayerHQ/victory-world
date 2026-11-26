# 27 — Turn the ray-tracing structure builder back on

- **Title:** Turn the ray-tracing structure builder back on
- **Lane:** Ray tracing
- **Files owned:** crates/victory-gpu, crates/victory-hle, to be confirmed by the lead
- **Symptom:** The title's ray-tracing structure builder is switched off by default, so reflections and bounce light that depend on it are not drawn. Its resolve programs run and read nothing.
- **Evidence:** The frame line attributes the dropped draws to the builder's switched-off stage; no sheet shows reflections or bounce light.
- **Ruled out:** —
- **Done when:** The builder runs and a recorded run shows reflections and bounce light, with the frame line accounting for its draws.
- **Size:** L

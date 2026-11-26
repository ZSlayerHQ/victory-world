# 20 — Count the switched-off builder's drops apart

- **Title:** Count the switched-off structure builder's drops apart
- **Lane:** Tools and harness
- **Files owned:** the drop counters and the summary (`crates/victory-gpu/src/draw.rs`, `crates/victory-gpu/src/host.rs`, `harness/summarize-run.mjs`)
- **Symptom:** 315 to 1,767 dropped draws a frame (about 98%) belong to the ray-tracing structure builder, which ships switched off; they hide every other drop in the summary.
- **Evidence:** runs `fork-warm-2` and `fork-caption`.
- **Ruled out:** —
- **Done when:** the summary reports drops by pipeline family, the builder's line separate, so a run can say "no other drops" at a glance.
- **Size:** S

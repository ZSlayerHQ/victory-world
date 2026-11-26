# 04 — Mask mesh primitive indices to 9 bits

- **Title:** Mask mesh primitive indices to 9 bits
- **Lane:** Shaders to 100% (61 of 25,758 programs still refused; picture faults)
- **Files owned:** the mesh program translation (`crates/victory-shader/src/emit`)
- **Symptom:** a stray triangle stretches from the watchtower across the yard, and spikes appear in the sky. An index above what the mesh holds reads a neighbour's vertex data.
- **Evidence:** upstream commit `c0228d93` masks mesh primitive indices to 9 bits; the adopted fork has no mask; run `fork-caption` at 7:51 and 10:26.
- **Ruled out:** —
- **Done when:** a fixture with a primitive index above 511 fails before the change and passes after; a run shows no stretched shard or sky spikes.
- **Size:** S

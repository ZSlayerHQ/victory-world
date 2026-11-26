# 19 — Make the caption's GPU number a load or a wait

- **Title:** Make the caption's GPU number a load, or label it as a wait
- **Lane:** Tools and harness
- **Files owned:** the caption (`crates/victory-gpu/src/host.rs`)
- **Symptom:** the caption's "gpu N% busy" divides our wait for the card by the frame time, so it can read low while the card is busy; it is not a load figure.
- **Evidence:** in the same frame the caption and an independent GPU clock disagreed by a wide margin.
- **Ruled out:** —
- **Done when:** the caption either reports GPU-timestamp utilisation or says "wait"; a run's figure agrees with an independent clock within a few points.
- **Size:** S

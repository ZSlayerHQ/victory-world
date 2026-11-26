# 07 — Spans by true memory, and put back lost views

- **Title:** Make a placed texture's span the mips its view shows, and put back views nothing updates
- **Lane:** Native memory (moving off the console's shared memory model)
- **Files owned:** `crates/victory-gpu/src/resource.rs`, `crates/victory-gpu/src/descriptor/host.rs`, `crates/victory-gpu/src/draw.rs`
- **Symptom:** a placed texture taken as long as its description lies over its neighbours, and views the host lost sight of are never brought up to date.
- **Evidence:** parts of the sibling fork's commit `4436f8f1`: 109,638 views taken for stale in eight minutes on one machine; the sweep that finds views nothing updates.
- **Ruled out:** —
- **Done when:** a fixture makes two placed textures' spans overlap unless the view's first mip bounds the first, and another loses a view and finds it again; a game run shows no scrambled patches and no stale texture.
- **Size:** M

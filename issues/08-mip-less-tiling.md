# 08 — Tile mip-less textures over 64 KiB

- **Title:** Tile a mip-less texture over 64 KiB
- **Lane:** Native memory (moving off the console's shared memory model)
- **Files owned:** the tiling path (`crates/victory-gpu/src/xg.rs`, `crates/victory-gpu/src/resource.rs`)
- **Symptom:** a texture with one mip and a size above 64 KiB is tiled as one block, so its rows land wrong.
- **Evidence:** the fork-essentials audit reports the path present and untested (`xg.rs:58-68`, `resource.rs:150-157`), about 20 lines plus a test.
- **Ruled out:** —
- **Done when:** a fixture of a one-mip texture just over 64 KiB fails before and passes after; a run shows its surface right.
- **Size:** S

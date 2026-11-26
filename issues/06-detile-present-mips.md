# 06 — Stage and detile only the present mips

- **Title:** Stage and detile a streamed texture from its first present mip
- **Lane:** Native memory (moving off the console's shared memory model)
- **Files owned:** `crates/victory-formats/src/texture.rs`, `crates/victory-gpu/src/texture.rs`, `crates/victory-gpu/src/resource.rs`
- **Symptom:** blocky straight-edged patches on surfaces. A texture streamed in part — only its smaller mips in title memory, the next texture placed directly behind — is staged as if whole and detiled from the neighbour's bytes.
- **Evidence:** the sibling fork's commits `bddfb4a5` (a layout's bytes from a mip on, and detiling from that prefix) and the staging part of `4436f8f1` (a staging buffer sized from the view's first mip) are reported to cure it together; either alone is wrong. Its author counts 109,638 views taken for stale in eight minutes, and 700 KB read for the 12 KB present.
- **Ruled out:** —
- **Done when:** the layout fixture (a 9-mip block-compressed texture read from each present mip's prefix, one byte short refused) fails before and passes after; a game run shows no scrambled patches.
- **Size:** M

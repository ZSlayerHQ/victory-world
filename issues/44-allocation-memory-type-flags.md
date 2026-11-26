# 44 — Keep the memory-type flags of the title's allocations

- **Title:** Keep the memory-type flags of the title's allocations
- **Lane:** Native memory (moving off the console's shared memory model)
- **Goal:** The title asks for memory with console flags (graphics memory, 32-bit addresses, page size). `XMemVirtualAlloc` uses the address bits, and then `XMemVirtualQuery` reports graphics memory and no tag for every committed page. Keep each allocation's flags and return them from the query, so a title that asks what it allocated gets its own answer.
- **Where the code is:** `crates/victory-hle/src/modules/xmem.rs`: `XMemVirtualAlloc`, `XMemVirtualQuery`, `BasicInformation` (`flags`, `tag_code`, `tag`), `address_range`, and the constants `GRAPHICS` and `ADDRESS_32BIT`; `crates/victory-hle/src/modules/memory.rs`: `VirtualFree`, to forget a region.
- **Files owned:** `crates/victory-hle/src/modules/xmem.rs`, `crates/victory-hle/src/modules/memory.rs`
- **Symptom:** `XMemVirtualQuery` overwrites `flags` with `GRAPHICS` and zeroes the tag; the comment calls it a shortcut. A title that reads back a 32-bit or page-size flag sees a different allocation from the one it made.
- **Evidence:** The shortcut comment at `XMemVirtualQuery`; `address_range` already reads the flags at allocation.
- **Ruled out:** The tag is not set by any call seen; leave it zero unless a setter appears.
- **Done when:** A test allocates with `GRAPHICS | ADDRESS_32BIT`, queries the address, and sees the same flags; a second allocation with another flag word sees its own; `VirtualFree` removes the record; `cargo test -p victory-hle` and clippy pass.
- **Test:** `xmem.rs` tests: two allocations with different flags, a query of each, and a query after free.
- **Out of scope:** Changing the address range; the tag; the physical-page table.
- **Size:** S
- **Needs:** none.

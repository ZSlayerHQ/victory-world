# 01 — Port the view guard and its kernel-read fix

- **Title:** Port the sibling fork's view guard and kernel-read fix
- **Lane:** Room and portal decision (the missing walls)
- **Files owned:** `crates/victory-gpu/src/watch.rs`, `crates/victory-gpu/src/inplace.rs`, `crates/victory-hle/src/modules/dstorage.rs`, `crates/victory-hle/src/modules/files.rs`
- **Symptom:** in playable interiors the walls, ceiling and floor are absent while the room's wall draws run with work; the title clips the room to the window's rectangle as if the camera stood outside. A copy of title memory taken through one view of a page, while the title writes the same page through another, is the candidate for the stale value behind that decision.
- **Evidence:** the sibling fork's commits `c6dc4d8c` (guard every view of a guarded page) and `10ea38ed` (kernel reads land in a bounce buffer and are copied in) are reported to bring the walls back in two runs of two; the adopted fork's author sees walls missing in five runs of seven (run tags `fork-cell-walls`, `fork-essentials`); that same sibling fork's build (`joshuu/victory-amd` at `f25e7352`), run unmodified on an RTX 5090, drew walls, ceiling and floor in the first playable room and a later room in one launch (run `amd-fork`).
- **Ruled out:** pipelines made late, empty indirect executions, anything lost after the G-buffer (see `KNOWN-FAULTS.md`).
- **Done when:** the sibling's two-view page file fixture fails without the guard and passes with it; three runs of six minutes to the first playable room show walls in at least two; the kernel-read fix is in the same pull request, because DirectStorage and `fread` into guarded memory otherwise fail with `ERROR_INVALID_USER_BUFFER`.
- **Size:** M

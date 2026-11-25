# Known faults

Faults already diagnosed, with the evidence that settles them. Treat each as settled: link its issue, say what your
work adds, and spend your tokens on what is not here. Run tags are the names of the run logs the numbers came from;
the logs stay on the machines that made them.

## The building shell is missing in playable interiors

- **Symptom:** in every playable interior the walls, ceiling and floor are absent while characters, props, window
  frames and the view outside draw correctly. The opening cutscene's cell has its walls.
- **What it is:** the title's own scissor. In the playable room it sets one clip rectangle exactly over the window
  opening on almost the whole G-buffer and depth pass (432 and 1,919 operations in two frames), as if the camera
  stood outside looking in; the room's wall draws run with work and are cut by it. No single shader is responsible.
- **Ruled out:** pipelines made late (nothing was dropped while the world loaded, and the walls were already absent
  at the first playable frame); indirect executions arriving empty (1,571 of 2,266 over two frames had work; the
  empty ones are far-distance props and grass, and none were dropped); anything later in the frame (at frame 3651
  the depth and base-colour buffers are empty either side of the window frame).
- **Evidence:** run `fork-essentials`, frames 3651 and 3851; run `fork-cell-walls`, frame 2693 (exterior: full-width
  scissor, shell whole); the adopted fork's author reports it in five runs of seven; a sibling fork's view guard
  (commits `c6dc4d8c` with `10ea38ed`) is claimed to bring the walls back in two runs of two; a sibling fork's build
  (`joshuu/victory-amd` at `f25e7352`), run unmodified on an RTX 5090, drew walls, ceiling and floor in the first
  playable room and a later room in one launch (run `amd-fork`).
- **Issues:** [01](issues/01-view-guard.md), [02](issues/02-room-decision-inputs.md), [03](issues/03-scissor-run.md)

## Most dropped draws are one switched-off feature

- **Symptom:** 315 to 1,767 dropped draws a frame (about 98%) belong to the ray-tracing structure builder, which the
  runtime ships switched off (34 compute stages). This is expected; counting them apart is what lets real drops
  show.
- **Evidence:** runs `fork-warm-2` and `fork-caption`.
- **Issue:** [20](issues/20-count-builder-drops.md)

## Seven compute programs are refused by an NVIDIA driver

- **Symptom:** pipeline creation fails with `E_INVALIDARG`; every refused program uses 64-lane waves. Four translate
  for 32 lanes behind `VICTORY_WAVE_WIDE=last` (stable in one run, about a fifth slower, nothing visible gained in
  the playable scene). Three need a wave form not written yet: thread groups of several console waves each.
- **Evidence:** run `fork-wave-wide` (4 host-refused with the switch, 8 without); run `fork-caption` (8 refused).
- **Issues:** [10](issues/10-exact-wave-masks.md), [12](issues/12-multi-group-programs.md)

## Character lighting faults: black silhouette, orange band, black or white eyes

- **Symptom:** for a few seconds at a time. The tiled lighting's light clustering is wrong in the fork's
  approximate 32-lane form: each half-wave is offered only the lights its own half found. The exact form is behind
  `VICTORY_WAVE_WIDE=masks` (commit `24c762c9`), not yet seen in a game run.
- **Evidence:** run `fork-caption` at 2:48 and 9:52; the wave fixtures at `24c762c9` (the mask fixture passes, the
  approximate form's fixture fails as written).
- **Issue:** [10](issues/10-exact-wave-masks.md)

## A mesh pipeline is refused every run: the windshield-wiper mask

- **Symptom:** pipeline `f5e50eb2108c425b` is refused every run: the windshield-wiper mask's draw
  (`windshield_wipermask`), an integer render target with blending enabled, which the host refuses. Low value: a
  small overlay, not room geometry.
- **Ruled out:** as a cause of the missing walls.
- **Evidence:** run `fork-caption` (8 host-refused; this one every run).
- **Issue:** [13](issues/13-integer-targets.md)

## Scrambled straight-edged patches on surfaces

- **Symptom:** blocky patches; the size of the coarse grid behind the bounce lighting. A texture streamed in part
  (only its smaller mips present in title memory) is staged as if whole and detiled from the bytes of the texture
  placed right behind it. The fault is in texture staging and detiling, not in a shader.
- **Ruled out:** nothing.
- **Evidence:** in a sibling fork, commits `bddfb4a5` and the staging part of `4436f8f1` are reported to cure it
  together; either alone is wrong. Its author counts 109,638 views taken for stale in eight minutes on one machine.
- **Issue:** [06](issues/06-detile-present-mips.md)

## The caption's GPU figure is a wait, not a load

- **Symptom:** the caption's "gpu N% busy" divides time spent waiting for the card by the frame time, so it can read
  low while the card is busy. Treat it as wait time until it is changed.
- **Evidence:** the caption and an independent clock disagreed in the same frame.
- **Issue:** [19](issues/19-caption-gpu-number.md)

## The runtime's GPU test binary dies with an access violation

- **Symptom:** about one run in five to ten. It has not been tied to a fault in the runtime.
- **Evidence:** several test runs on one machine; no reproduction yet.
- **Issue:** [21](issues/21-gpu-test-crash.md)

## The cutscene: about 70 s of pure white and 25 s of stretched triangles

- **Symptom:** white-out for about 70 seconds, then screen-filling stretched triangles for about 25, at about half a
  frame a second. Not located yet; the first jobs are diagnosis only.
- **Ruled out:** nothing yet.
- **Evidence:** run `fork-caption`, video 2:55 to 3:42 and 4:20 to 4:41 (white); 3:43 to 4:05 (triangles).
- **Issues:** [14](issues/14-white-out.md), [15](issues/15-stretched-triangles.md)

## Stray triangles in play

- **Symptom:** a dark stretched shard across the yard, then spikes in the sky, for about twelve seconds. The suspect
  is the mesh primitive-index mask the adopted fork lacks (upstream commit `c0228d93` masks indices to 9 bits).
- **Ruled out:** nothing yet.
- **Evidence:** run `fork-caption` at 7:51 and 10:26.
- **Issue:** [05](issues/05-stray-triangle-diagnosis.md)

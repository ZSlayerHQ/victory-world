# 18 — Test a longer pipeline wait, visuals first

- **Title:** Test a longer pipeline wait against the dropped draws
- **Lane:** CPU threading (draw preparation across cores)
- **Files owned:** none; one run with a setting changed
- **Symptom:** the runtime waits at most 500 ms a frame for pipelines being made, then draws the frame without them; about 800 to 1,500 draws are dropped over ten minutes, mostly one reflection pass and ray-traced shading. This asks whether waiting longer brings picture back.
- **Evidence:** run `fork-caption`'s summary: about 835 "being made" drops over the run.
- **Ruled out:** as the cause of the missing walls (nothing was dropped while the world loaded).
- **Done when:** one run with the wait raised (for example `VICTORY_PIPELINE_WAIT_MS` at 2,000) pastes its summary with a run tag, and says whether the reflection and ray-traced shading appear and what loading cost.
- **Size:** S

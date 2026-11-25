# Diagnostics tools

the maintainer, the channel a message. In priority order. None is verified yet: **check each tool's docs before wiring it in**, for
every version, support or command-line claim below, and for what it needs installed.

1. **NVIDIA Nsight Aftermath (SDK).** A GPU crash dump at a hang or device removal that names the shader and
   instruction running. Serves the mesh hangs, H1 and H2 (Phase 2). Headless: the SDK decodes a dump to JSON. Needs
   the diagnostics build to link it and register each pipeline under its shader hash, so the dump names it.
2. **D3D12 debug layer with GPU-based validation.** Null or out-of-range descriptors and bad resource states, caught
   on the GPU. Serves Phase 1 (descriptor stride and synthesis) and H2. Already in the diagnostics build:
   `VICTORY_D3D12_DEBUG=1` plus `VICTORY_D3D12_GBV=1`. VIctory reads the debug layer's message queue into its log
   (`victory-gpu/src/host.rs`), so `rg` the run log. Slow: run it on short windows. Needs Windows' "Graphics
   Tools" optional feature.
3. **PIX on Windows.** GPU captures (every draw and dispatch, its translated shader, its inputs and outputs) and
   timing captures per pass. Headless: `pixtool` captures from the command line. Most useful once VIctory labels each
   console draw with its shader hash, so a capture maps onto the worklist. Today it sets a marker per command only
   while DRED is on (`note` in `host.rs`).
4. **RenderDoc.** One frame's draws, resources and shaders. Headless: its Python API opens a capture and pulls
   per-draw facts. Check its D3D12 mesh-shader support first: the world draws with mesh shaders.
5. **NVIDIA Nsight Graphics** (GPU Trace, the shader profiler). Per-pass and per-shader cost on the 5090. Serves
   Phase 7. Headless: whatever capture and export its command line offers.
6. **Differential translation.** Translator bugs found without running the game: translate the same console shader
   with VIctory and with a second reference translator and compare the results on fixtures; cross-check
   VIctory's decoder against LLVM's AMDGPU disassembler (`llvm-objdump` for the matching gfx10 target). Serves
   Phases 3 to 5. Headless by nature: text diffs. A game shader is compared on this PC only; nothing derived from
   it is committed.
7. **AMD's RDNA2 instruction set guide (PDF).** The reference for EXEC-mask, barrier, LDS and readfirstlane
   semantics. `shader-engineer` reads the section a job touches, from a copy kept under `tools/` (ignored).
8. **CPU side.**
   - Tracy (Rust crate `tracy-client`): VIctory's own frame-time costs, such as title-memory copies and streaming
     (Phase 7).
   - WinDbg with Time Travel Debugging: crashes in the title's code, replayed step by step; scripted through its
     command-line debugger.
   - Windows Performance Recorder and Analyzer: whole-system traces; `wpr` records, and the analyzer's exporter
     writes CSV.
9. **PresentMon.** Presented frame times, GPU busy time and latency, from outside VIctory: the plan's performance
   criterion. How to capture: the `world-run` skill (archived a gotcha).

**Proposed Phase 0b, diagnostics first** (for the maintainer, a message): items 1 to 3 wired into the diagnostics build as
`gpu-host-engineer` jobs, because they pinpoint the faults Phases 1 and 2 hunt for. STATE carries it.

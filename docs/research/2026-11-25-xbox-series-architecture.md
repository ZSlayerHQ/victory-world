# The console's architecture and what a PC host pays for each part of it (web research, sourced; ideas ranked at the end)

A subagent's report, saved as it was returned on 2026-11-25. Figures come from this project's run logs and from
the sources it names; treat claims about other projects as it marks them.

# Xbox Series X|S on a Windows PC: what the console gives a title, and what a PC host pays for

**How each claim is marked:** [MS] Microsoft documentation or slides; [AMD] AMD documentation; [NV] NVIDIA documentation; [ENG] a platform engineer in a talk or interview; [3P] measured or reported by a third party; [RE] reverse-engineered, or learned by an open-source project; [INF] my own inference, not a sourced fact; [none] I found no public source.

## 1. Memory

**What the console has**
- **Series X pool.** 16 GB of GDDR6 on 20 x16 channels at 14 Gbps. 10 GB is "high memory interleave" at 560 GB/s and 6 GB is "low interleave" at 336 GB/s [MS](https://hc32.hotchips.org/assets/program/conference/day1/HotChips2020_GPU_Microsoft_Jeff_Andrews_v2.pdf) [MS](https://news.xbox.com/en-us/2020/03/16/xbox-series-x-tech/).
- **What games get.** 13.5 GB: 10 GB "GPU optimal" and 3.5 GB "standard" [ENG, relayed](https://gamingbolt.com/xbox-series-x-allocates-13-5-gb-of-memory-to-games).
- **Series S pool.** 8 GB at 224 GB/s plus 2 GB at 56 GB/s [MS](https://www.xbox.com/en-us/consoles/xbox-series-s).
- **Fixed budget.** System processes allocate from a separate fixed-size partition, so a title knows exactly how much memory it has [MS](https://learn.microsoft.com/gaming/gdk/docs/gdk-dev/intro/introduction).
- **How titles allocate.**
  - Titles use the Win32 memory calls plus Xbox extensions (`XMemAlloc`) [MS](https://learn.microsoft.com/gaming/gdk/docs/gdk-dev/intro/introduction).
  - They can allocate 64 KB physical pages with `XMemAllocatePhysicalPages`, and DirectStorage reads straight into arrays of those pages [MS](https://learn.microsoft.com/gaming/gdk/docs/features/console/storage/directstorage/directstorage-overview).
  - Holding physical pages is what lets a streaming allocator remap memory to new virtual addresses instead of copying it [INF].
- **How the GPU addresses memory.**
  - The Series X GPU has a "three-level cache, TLB" [MS](https://hc32.hotchips.org/assets/program/conference/day1/HotChips2020_GPU_Microsoft_Jeff_Andrews_v2.pdf).
  - On Xbox One, the GPU's and I/O MMU's page tables were kept in step with the CPU's [3P](https://pc.watch.impress.co.jp/docs/column/kaigai/619784.html). Nothing public says the same of the Series consoles [none].

**What Windows does differently**
- An allocation's CPU and GPU virtual addresses "are independent". System memory is mapped to the GPU in 4 KB pages, and VRAM in 4 or 64 KB pages [MS](https://learn.microsoft.com/windows-hardware/drivers/display/gpummu-model).
- D3D12 GPUs "do not support page faulting" [MS](https://learn.microsoft.com/windows/win32/direct3d12/memory-management-strategies).

**PC equivalents**
- **Heap opened from an existing address.**
  - `OpenExistingHeapFromAddress` wraps a whole VirtualAlloc region as a system-memory heap [MS](https://learn.microsoft.com/windows/win32/api/d3d12/nf-d3d12-id3d12device3-openexistingheapfromaddress).
  - Microsoft says to use existing heaps only for diagnostics, "for a variety of performance and compatibility reasons" [MS](https://learn.microsoft.com/windows/win32/api/d3d12/ns-d3d12-d3d12_feature_data_existing_heaps).
  - GPU reads from such a heap cross PCIe 5.0 x16, about 64 GB/s each way [3P](https://www.anandtech.com/show/14447). The 5090's VRAM runs at 1,792 GB/s [3P](https://www.tomshardware.com/pc-components/gpus/nvidia-geforce-rtx-5090-review), and NVIDIA's tools flag "L2 misses to system memory" as a cost [NV](https://developer.nvidia.com/blog/optimizing-dx12-resource-uploads-to-the-gpu-using-cpu-visible-vram).
  - So a shader that reads title memory in place gets about a ninth of the console's 560 GB/s [INF, arithmetic].
- **GPU upload heaps.**
  - These are CPU-visible VRAM with write-combined CPU pages, and CPU reads from them are "inefficient" [MS](https://github.com/microsoft/DirectX-Specs/blob/master/d3d/D3D12GPUUploadHeaps.md).
  - They have been retail since Agility SDK 1.613 [MS](https://devblogs.microsoft.com/directx/agility-sdk-1-613-0/), and need Resizable BAR on a discrete card [MS](https://devblogs.microsoft.com/directx/preview-agility-sdk-1-710-0/).
  - They are the nearest PC match when the CPU writes and the GPU reads. They do nothing for the reverse direction [INF].
- **Reserved resources.** A reserved resource owns its own GPU address range, and `UpdateTileMappings` maps 64 KB tiles of it onto heap memory on the fly [MS](https://learn.microsoft.com/windows/win32/direct3d12/memory-management-strategies). This is the GPU-side version of remapping pages.
- **Remapping pages on the CPU.**
  - With AWE (Address Windowing Extensions), a physical page "cannot be simultaneously mapped at more than one virtual address" [MS](https://learn.microsoft.com/windows/win32/api/memoryapi/nf-memoryapi-allocateuserphysicalpages2).
  - Placeholders do allow it. Reserve with `VirtualAlloc2` and `MEM_RESERVE_PLACEHOLDER` [MS](https://learn.microsoft.com/windows/win32/api/memoryapi/nf-memoryapi-virtualalloc2), then map a pagefile-backed section into it with `MapViewOfFile3` and `MEM_REPLACE_PLACEHOLDER` [MS](https://learn.microsoft.com/windows/win32/api/memoryapi/nf-memoryapi-mapviewoffile3). A console "physical page" can then be a section offset mapped wherever the title asks [INF].
  - `OpenExistingHeapFromFileMapping` opens such a section as a D3D12 heap [MS](https://learn.microsoft.com/windows/win32/api/d3d12/nf-d3d12-id3d12device3-openexistingheapfromfilemapping).
- **Large pages** need SeLockMemoryPrivilege and are nonpageable. They must be reserved and committed in one call, and are best allocated once at start-up [MS](https://learn.microsoft.com/windows/win32/memory/large-page-support).
- **Write-watch.** `MEM_WRITE_WATCH` with `GetWriteWatch` lists the pages written since the last reset [MS](https://learn.microsoft.com/windows/win32/api/memoryapi/nf-memoryapi-getwritewatch). It needs no exception handler per page [INF].
- **Placing buffers at a chosen GPU address.** `RecreateAtGpuva` can create heaps and buffers at a chosen GPU address, but it is a tools interface that needs developer mode [MS](https://microsoft.github.io/DirectX-Specs/d3d/RecreateAtGpuva-public.html).

## 2. The graphics interface

The D3D12.X reference and Microsoft's "differences from PC" page are NDA-only [MS](https://learn.microsoft.com/gaming/gdk/docs/features/graphics/d3d12x/d3d12x-differences-from-pc). On Xbox, GDK titles can use only D3D12.x [MS](https://learn.microsoft.com/gaming/gdk/docs/gdk-dev/intro/introduction).

**What is public**
- **API built into hardware.**
  - For Xbox One X, an engineer said "We essentially moved Direct3D 12" into "the command processor of the GPU", and developers "cut their CPU rendering overhead by half" [ENG, relayed](https://gamingbolt.com/xbox-scorpios-directx-12-enhancements-and-benefits-explained-by-microsoft).
  - At Hot Chips, Microsoft called the Series X driver model "significantly more efficient than the PC" [ENG, relayed](https://hexus.net/tech/news/graphics/144871-microsoft-reveals-xbox-series-x-soc-details/).
  - The Series X GPU has "two independent virtualized command streams" for "different DX API levels" [MS](https://hc32.hotchips.org/assets/program/conference/day1/HotChips2020_GPU_Microsoft_Jeff_Andrews_v2.pdf).
- **Frame clock.** A title calls `ID3D12Device::WaitFrameEventX` to get a frame-pipeline token, then passes it to `PresentX` [MS](https://learn.microsoft.com/gaming/gdk/docs/features/common/game-streaming/game-streaming-latency-compensation-deep-dive).
- **Fences.** On Xbox, `ID3D12Fence::SetEventOnCompletion` spins on the fence and holds the hardware thread [MS](https://learn.microsoft.com/gaming/gdk/docs/features/console/storage/directstorage/directstorage-overview).

**What reproducing it costs on PC**
- **Barriers.**
  - Legacy barriers "can be expensive" because they force "cache flushes, memory layout changes" [MS](https://learn.microsoft.com/windows/win32/direct3d12/using-resource-barriers-to-synchronize-resource-states-in-direct3d-12).
  - Enhanced barriers control synchronisation, layout and cache flushing separately [MS](https://learn.microsoft.com/windows-hardware/drivers/display/enhanced-barriers).
  - A host that cannot see the title's real dependencies has to over-synchronise [INF].
- **Command-list memory writes.** `WriteBufferImmediate` takes 32-bit values "directly from the command stream" [MS](https://microsoft.github.io/DirectX-Specs/d3d/D3D12WriteBufferImmediate.html). It is the closest PC match.
- **Shader compiles.** Every translated shader goes through DXIL and then the driver's compiler.
  - Dolphin found that shader caches took hours of play to build and broke on driver updates. It settled on ubershaders that run while specialised shaders compile in the background [RE](https://dolphin-emu.org/blog/2017/07/30/ubershaders/).
  - Xenia found that long shaders "take a very long time to compile in the driver" [RE](https://xenia.jp/updates/2021/04/27/leaving-no-pixel-behind-new-render-target-cache-3x3-resolution-scaling.html).

## 3. The GPU

- **Series X GPU.** All from Microsoft's Hot Chips slides [MS](https://hc32.hotchips.org/assets/program/conference/day1/HotChips2020_GPU_Microsoft_Jeff_Andrews_v2.pdf):
  - 26 dual compute units (52 CUs) at 1.825 GHz, 12 TFLOPS, 5 MB L2.
  - Each CU does four texture or ray operations per clock.
  - The ray units peak at 380 G box tests and 95 G triangle tests a second. BVH traversal itself runs in shader code.
  - Sampler feedback adds hardware residency and request maps, worth "up to 60% I/O and memory savings".
- **Series S GPU.** 20 CUs at 1.565 GHz, 4 TFLOPS [MS](https://www.xbox.com/en-us/consoles/xbox-series-s).
- **Wave sizes on RDNA.** RDNA is "native Wave32 with support for Wave64 via dual-issue". Wave64 vector instructions "execute as 2x Wave32", and pixel shaders usually run as wave64 [AMD](https://gpuopen.com/download/RDNA_Architecture_public.pdf).
- **Ray-tracing instructions.** `image_bvh_intersect_ray` and `image_bvh64_intersect_ray` take a node address and a resource descriptor [AMD/LLVM](https://llvm.org/docs/AMDGPU/AMDGPUAsmGFX1013.html). The console's BVH is therefore plain memory in AMD's node format [INF].
- **Wave size on NVIDIA.** NVIDIA runs warps of 32 threads [NV](https://docs.nvidia.com/cuda/cuda-programming-guide/01-introduction/programming-model.html), and D3D12 reports the minimum and maximum wave size (`WaveLaneCountMin`/`Max`) [MS](https://learn.microsoft.com/windows/win32/api/d3d12/ns-d3d12-d3d12_feature_data_d3d12_options1). Wave64 code has to be emulated [INF].
- **Ray-tracing structures on PC.** DXR acceleration structures belong to the driver, and even serialized ones carry a driver-matching identifier [MS](https://learn.microsoft.com/windows/win32/api/d3d12/ns-d3d12-d3d12_serialized_data_driver_matching_identifier). NVIDIA's RT cores cannot consume an AMD-format BVH [INF].
- **Shared feature set.** DirectX 12 Ultimate was announced as a common target for PC and Series X [MS](https://devblogs.microsoft.com/directx/announcing-directx-12-ultimate/) [3P](https://anandtech.com/show/15637/microsoft-intros-directx-12-ultimate-next-gen-feature-set).

## 4. Storage and streaming

- **Drive and decompression rates.**
  - 2.4 GB/s raw, or 4.8 GB/s assuming 2:1 compression [MS](https://news.xbox.com/en-us/2020/07/14/a-closer-look-at-xbox-velocity-architecture/).
  - Sampler Feedback Streaming is worth "approximately 2.5x" in effective memory, because the GPU "often accesses less than 1/3" of the texture data that is loaded [MS](https://news.xbox.com/en-us/2020/07/14/a-closer-look-at-xbox-velocity-architecture/).
  - The decompression block has "2 general + texture decompression engines, total >6 GB/s output", saving "2+ Zen2 cores" [MS](https://hc32.hotchips.org/assets/program/conference/day1/HotChips2020_GPU_Microsoft_Jeff_Andrews_v2.pdf).
- **DirectStorage on the console.** All from Microsoft's public overview [MS](https://learn.microsoft.com/gaming/gdk/docs/features/console/storage/directstorage/directstorage-overview):
  - Target: 50,000 requests a second for 5 to 10% of one core.
  - The hardware writes straight into the title's buffer.
  - DEFLATE (zlib), BCPack (rANS coding of BCn texture data) and a swizzle stage can be combined, and run in place.
  - Destinations can be arrays of 64 KB physical pages.
  - A memory-to-memory queue doubles as a DMA copy engine.
  - 2.0 GB/s is guaranteed over any 250 ms window, and read performance tops out at 64 KiB per read.
- **DirectStorage on Windows.**
  - It decompresses GDeflate on the GPU [MS](https://github.com/microsoft/DirectStorage/blob/main/Docs/DeveloperGuidance.md), and since version 1.4 (March 2026) also Zstandard, on the CPU or GPU [MS](https://devblogs.microsoft.com/directx/directstorage-1-4-release-adds-support-for-zstandard/).
  - Requests to a system-memory destination always decompress on the CPU, and textures must be stored unswizzled on disk [MS](https://github.com/microsoft/DirectStorage/blob/main/Docs/DeveloperGuidance.md).
  - Neither page mentions zlib or BCPack [none]. The host has to decode both and undo the console swizzle, at drive speed [INF].

## 5. The CPU and the operating system

- **CPU.** Eight Zen 2 cores at 3.8 GHz, or 3.6 GHz with SMT, in two 4-core clusters with 4 MB of L3 each [MS](https://hc32.hotchips.org/assets/program/conference/day1/HotChips2020_GPU_Microsoft_Jeff_Andrews_v2.pdf). One core is reserved for the system, and titles choose whether SMT is on [ENG, relayed](https://www.tweaktown.com/news/71272/full-xbox-series-specs-3-8ghz-zen-2-cpu-16gb-gddr6-52cu-navi-gpu/index.html).
- **Hypervisor.** The title OS and the system OS run in separate virtual machines [MS](https://hc32.hotchips.org/assets/program/conference/day1/HotChips2020_GPU_Microsoft_Jeff_Andrews_v2.pdf).
- **Game OS.** Titles get explicit CPU, GPU and memory guarantees, use the `WINAPI_FAMILY_GAMES` API subset, and are each tied to a Game OS version [MS](https://learn.microsoft.com/gaming/gdk/docs/gdk-dev/intro/introduction). A fresh Game OS boots for each launch, and Quick Resume keeps up to three [RE](https://xboxoneresearch.github.io/wiki/games/launching).

## 6. What other projects learned

- **Xenia (Xbox 360, unified memory).**
  - It mirrors the console's RAM as a 512 MB D3D12 buffer indexed by guest address, backed on demand by 64 KB tiles [RE](https://github.com/xenia-project/xenia/blob/master/src/xenia/gpu/d3d12/d3d12_shared_memory.cc).
  - It write-protects uploaded pages. Faults are slow, so it invalidates 256 KB at a time: with per-page invalidation, Doom "ran at roughly 3 FPS" [RE](https://xenia.jp/updates/2021/04/27/leaving-no-pixel-behind-new-render-target-cache-3x3-resolution-scaling.html). The match with this host's 3 fps is suggestive, not proven [INF].
  - GPU-written ranges must be tracked exactly.
  - Waiting for GPU results puts the CPU and GPU in lock-step, so 16 ms of CPU work plus 16 ms of GPU work becomes a 32 ms frame.
  - Textures are converted out of the console's tiled layout by compute shaders.
  - The accurate path that emulates render targets in pixel shaders (ROV) was slower, so plain render targets are the default. All four points are from the same post [RE](https://xenia.jp/updates/2021/04/27/leaving-no-pixel-behind-new-render-target-cache-3x3-resolution-scaling.html).
- **shadPS4 (PS4).** A stream buffer that copied every binding was slow, partly because the GPU wasn't reading from VRAM. It was replaced by a buffer cache with a 4 KB dirty-page tracker. A CPU write elsewhere on a page can overwrite GPU-written data on that page [RE](https://shadps4.net/index.php/category/developing).
- **yuzu (Switch).** Per-page dirty bits and a flat page-to-buffer table gave up to 84% more speed (RTX 3070, OpenGL) [RE](https://yuzu-mirror.github.io/entry/yuzu-bcr).

## What the console gives for free, and what replaces it on a PC

| # | Console mechanism | What a PC host must do | Feature that helps most | How sure |
|---|---|---|---|---|
| 1 | GPU reads CPU writes at 560 GB/s from one pool | Mirror into VRAM, upload dirty pages | GPU upload heaps; a reserved buffer; write-watch | High on the problem, medium on the fix |
| 2 | CPU reads GPU output with no copy | Read back and wait | Copy queue; fences read a frame late | High |
| 3 | Title maps 64 KB physical pages anywhere | Track remaps on both CPU and GPU | Placeholders with `MapViewOfFile3`; `UpdateTileMappings` | Medium |
| 4 | One address works in CPU code, descriptors and commands | Translate addresses | One address-indexed buffer (`RecreateAtGpuva` is tools-only) | Medium |
| 5 | Command lists are hardware command buffers | Parse and replay them | `ExecuteIndirect`, `WriteBufferImmediate`, enhanced barriers | Medium |
| 6 | Shaders ship as machine code | Translate and compile | Disk cache, async compile, ubershader fallback | High |
| 7 | Native wave64 | Emulate on 32 lanes | Wave intrinsics | High |
| 8 | Ray units read AMD's BVH format | Emulate in shaders, or rebuild for DXR | DXR | Low |
| 9 | Hardware zlib, BCPack and swizzle | Decode and deswizzle | Compute shaders; DirectStorage (other formats only) | High |
| 10 | A texture is memory plus a descriptor | Create resources at load | Placed resources, created on background threads [MS](https://learn.microsoft.com/windows/win32/direct3d12/memory-management-strategies) | Medium |

## Ideas ranked for a 10x speed-up

All of these are my inference. Whether they reach 10x depends on where the 120 to 215 ms of GPU time and the per-frame wait actually go.

1. **Keep every shader read in VRAM** (rows 1, 4).
   - **Check:** Nsight's "L2 misses to system memory". Any large share is limited by PCIe and could explain much of the GPU time.
2. **Make VRAM the home of GPU-written pages**, and copy them back only when the CPU reads them (rows 1, 2).
   - **Safe if:** the CPU seldom reads GPU output.
   - **Check:** protect those pages for one run and count CPU faults per frame.
3. **Drop the per-frame wait** (row 2). Let the GPU run a frame behind, and serve CPU reads of GPU data one frame late.
   - **Safe if:** those reads tolerate lag, as queries, exposure and streaming feedback usually do.
   - **Check:** log each CPU read of a GPU-written page with its age in frames.
4. **Upload only dirty ranges**, found with write-watch and coarsened as Xenia does (rows 1, 3).
   - **Safe if:** the title's writes cluster.
   - **Check:** `GetWriteWatch` page counts per frame against the bytes copied today.
5. **Run wave64 shaders as two independent 32-lane halves** where nothing crosses lane 31/32, as AMD's hardware does (row 7).
   - **Check:** scan each translated shader for cross-half lane reads, ballots and whole-mask use.
6. **Pool texture creation** (row 10): placed resources in preallocated heaps, created on worker threads and cached by address and descriptor bits.
   - **Safe if:** texture descriptors repeat.
   - **Check:** the number of unique descriptors against creations per second during a load.
7. **Decompress and deswizzle on the GPU**, straight into the VRAM mirror (row 9).
   - **Safe if:** the title waits on DirectStorage fences or status blocks rather than watching memory.
   - **Check:** time from enqueue to completion per request.
8. **A persistent, versioned shader and pipeline-state cache** (row 6).
   - **Check:** compile misses on a second identical run.

## What I could not find a solid source for

- **D3D12.X details:** the descriptor rules, constant-buffer semantics, command-list memory functions and barrier behaviour are all NDA.
- **`XMemAlloc` details:** page sizes and memory types (write-combined, GPU read-only), and any physical-page mapping calls beyond `XMemAllocatePhysicalPages`.
- **Shared page tables:** whether the Series GPU shares the CPU's page tables.
- **Ray tracing and compression formats:** the console's acceleration-structure format and builder libraries, BCPack's bitstream, and the swizzle modes.
- **CPU and timers:** any console-only CPU instructions, and the timer frequency.
- **PC unknowns:** whether any public D3D12 heap can be placed at a caller-chosen CPU address, and whether NVIDIA supports the 64 KB standard swizzle layout.
- **Unreachable sources:**
  - Digital Foundry's articles would not load, so their quotes come through secondary reports.
  - The shadPS4 blog page no longer loads, and is cited from a search index.

Nothing was written to disk. The Hot Chips slides and AMD's RDNA slides were read in memory.

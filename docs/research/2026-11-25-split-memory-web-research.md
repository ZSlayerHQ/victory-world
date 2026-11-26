# One memory onto split memory: web research (DeepSeek, run by the stream session, 2026-11-25)

Saved as returned; its sources were checked by the stream session (111 read, 110 answering). Its emulator section is a second read
against `2026-11-25-one-memory-for-cpu-and-gpu.md`. One claim to check before relying on it: that GPU upload heaps need
developer mode (true of the preview SDK; later ones may not).

# Unified memory on a split-memory PC: direction for the Xbox Series X|S port

**Scope.** A recompiled Xbox Series X|S title, a D3D12-for-Xbox → D3D12/Vulkan translation layer, and a Windows 10/11 PC with an RTX 5090 (32 GB), 64 GB DDR5 and a 16-core CPU. The game assumes one pool of physical memory that both processors address directly; the PC has two. This report is about that gap, not about CPU recompilation or shader translation.

**Bottom line.** There is no PC equivalent of the console's single pool. On a PC, a physical page is either in VRAM or in system RAM; the other processor can reach it over PCIe, but only slowly. Every correct design therefore does one of three things per allocation: keep it where its heaviest user is (VRAM for GPU-heavy data, system RAM for CPU-heavy data), make it CPU-visible VRAM via the BAR (for data the CPU writes and the GPU reads), or keep a copy and track dirtiness. The fastest route for this title is a page-granular VRAM mirror for GPU-visible buffers, native host textures for textures, a BAR/upload ring for volatile CPU-written data, and fault-driven readback for the rare GPU-written pages the CPU reads. Trying to preserve the console's pointer identity is a dead end; address translation is unavoidable.

---

## 1. Direction

1. **Instrument the translation layer before changing policy.** Count bytes copied per frame in each direction, `Map`/`Unmap` calls, readbacks, fence waits, `UpdateTileMappings`/`vkQueueBindSparse` calls, and `QueryVideoMemoryInfo`/`VK_EXT_memory_budget` usage. *Reason:* at a few frames per second, one or two paths dominate; without the split you will optimise the wrong one.
2. **Replace every whole-resource copy with page/range dirty tracking.** Use 4 KB pages for CPU-side tracking and 64 KB tiles/blocks for GPU residency. *Reason:* Xenia, yuzu, Ryujinx, RPCS3 and shadPS4 all converged on this; even 1 GB per frame over PCIe is tens of milliseconds.
3. **Mirror the GPU-visible part of guest physical memory (buffers and texture source pages) into VRAM as a sparse/tiled buffer, not a flat 16 GB committed allocation.** D3D12: `CreateReservedResource` + `UpdateTileMappings`; Vulkan: sparse buffer + `vkQueueBindSparse`. *Reason:* only pages the GPU actually touches consume VRAM, and CPU-authored pages can be evicted and reloaded.
4. **Keep system RAM authoritative for CPU-written pages; treat the mirror as a cache for them.** *Reason:* CPU writes are already in the right place, and mirror pages can be dropped without a readback.
5. **Bind buffers directly to the mirror with a base offset; retile textures into host textures once per dirty epoch.** *Reason:* buffers are linear and can be consumed as-is; textures are tiled/swizzled and cannot be sampled as-is, but they only need conversion when the guest writes them.
6. **Put the most volatile CPU-written, GPU-read data in BAR VRAM.** On this machine Vulkan exposes a `DEVICE_LOCAL | HOST_VISIBLE | HOST_COHERENT` type; D3D12 has `D3D12_HEAP_TYPE_GPU_UPLOAD` and custom WRITE_COMBINE+L1 heaps. Use a per-frame ring. *Reason:* it removes the upload copy entirely for constant/vertex/index/streaming data.
7. **Classify the rest by use.** Render targets, depth and static textures → default heap; GPU-written + CPU-read → readback or GPU-side resolve; CPU-only → system RAM. *Reason:* this is Microsoft's public "classify, budget and stream" guidance, and Ryujinx's shipped `BufferBackingState` is a concrete example of the same idea.
8. **Stop trying to make GPU virtual addresses equal CPU pointers.** Translate at resource/descriptor creation; use placed resources and, where available, `SetNextAllocationAddress`/`ReserveGPUVARangesAtCreate` to pin *buffer* VAs. *Reason:* neither D3D12 nor Vulkan provides pointer identity; only capture/replay-style VA pinning exists, and then only for heaps and buffers.
9. **Resolve on the GPU into the mirror or a native-resolution copy, and read back only when the CPU actually touches the data, batched under one fence.** *Reason:* a readback is a pipeline sync; Xenia, RPCS3 and RT64 all defer it.
10. **Use `MEM_WRITE_WATCH`/`GetWriteWatch` for CPU-authored pages, and page protection only for GPU-authored pages the CPU reads.** *Reason:* write-watch is much cheaper than per-write faults; protection is only needed for the rare readback case.
11. **Budget VRAM explicitly with headroom and evict from caches; never rely on OS paging.** *Reason:* over-budget causes intermittent freezes, paging and creation failures, and the OS will not manage this for you.
12. **Treat GPU upload heaps, DirectStorage GPU decompression and tiled/sparse resources as optional fast paths with fallbacks.** *Reason:* GPU upload heaps are gated by full-BAR plus developer mode, DirectStorage needs repacked assets and VRAM staging, and sparse/tiled resources have tier and allocation limits.

---

## 2. Findings

### 2.1 How emulators and recompilers map unified memory (Q1)

There are four families of solution in the wild:

- **GPU mirror with page-dirty uploads** (Xenia): guest physical memory is copied into a GPU buffer; only invalid pages are uploaded; the GPU writes resolves back into the mirror; the CPU side is tracked so its writes invalidate pages.
- **Resource cache with guest-write tracking** (Ryujinx, yuzu, RPCS3, Dolphin): host textures/buffers are created from guest memory; CPU writes are detected by page protection, write-watch, or hashing; GPU writes are tracked per resource or per page; readback happens when the CPU or another resource needs the data.
- **OS-level physical-page mapping** (XValkyrie for Xbox One/Series): the guest's physical pages are backed by a 16 GiB section mapped in 64 KiB views, with dirty bitmaps; GPU resources are still host D3D12 resources, so copies remain for GPU use.
- **Direct guest RAM** (XenonRecomp/ReGPU, N64Recomp/RT64): recompiled code receives a base pointer to guest RAM; there is no MMU; the GPU layer reads RAM directly and writes back only when the game reads GPU-produced images.

The table summarises what each tracks and when it moves data. The details and file names follow.

| Project | Where guest memory lives | What it tracks | When it uploads | When it reads back |
|---|---|---|---|---|
| Xenia (Xbox 360) | System RAM + a 512 MB VRAM mirror (tiled/sparse) | Per-4 KB page `valid` and `valid_and_gpu_written` bits; watch ranges per texture/buffer | First GPU use after invalidation, dirty pages only (`RequestRange`/`UploadRanges`) | Only for frame traces (readback heap); normal GPU resolves stay in the mirror |
| Ryujinx (Switch) | System RAM + host buffers/textures | Page dirty bits (`MemoryTracking`/`RegionHandle`), per-buffer modified ranges, per-texture `_dirty` flags | CPU write → reload range; buffer `SynchronizeMemory` | CPU read of a GPU-written buffer (`Flush`) or texture (`GetTextureDataFromGpu`) |
| yuzu (Switch) | System RAM + host buffers/textures | Flat page→buffer table, per-page modified bit arrays, texture dirty flags | Only modified 4 KB pages | CPU read of a texture *(inference: the post describes dirty flags but not the readback trigger)* |
| shadPS4 (PS4; yuzu-style cache) | System RAM + sparse VRAM arenas | Per-page CPU/GPU modified bits, per-page read/write watchers, GPU fault bitmap | GPU fault or CPU write (`EnsureResident`, `SynchronizeMemory`) | `ReadMemory`/download ranges (configurable readback mode) |
| Dolphin (GameCube/Wii) | System RAM + host textures | Hash per texture use (`base_hash`, `hash`), overlap flags | Hash mismatch | EFB copies flushed to RAM at frame end |
| RPCS3 (PS3) | System RAM + host resources | Page protection (`rw`/`ro`/`no`) plus hash for sections < 4 KB; section flush/unprotect lists | Section use or access fault | CPU access fault, or surface readback |
| XValkyrie (Xbox One/Series) | 16 GiB section in system RAM + host D3D12 resources | `used`/`dirty` page bitmaps; write-watch on descriptor shadow memory | `XMemMapPhysicalPages` / `CreatePlacedResourceX` use | Copies through the host; no direct GPU→guest readback *(inference from the code)* |
| RT64 (N64) | RDRAM in host memory | Framebuffer addresses/dimensions, deferred RDP operations | Draw use | Native-resolution renderer syncs to RAM immediately |

#### Xenia (Xbox 360)

Xenia is the closest architectural match to this problem: the Xbox 360 also has one physical memory that the GPU and CPU share, and Xenia deliberately does **not** try to map it directly.

- `src/xenia/gpu/shared_memory.h` describes the class as managing memory "for unconverted textures, resolve targets, vertex and index buffers that can be accessed from shaders with Xenon physical addresses, with system page size granularity", and sets `kBufferSizeLog2 = 29` (512 MB).
- The same header defines `WatchMemoryRange` and `RegisterGlobalWatch`. A watch fires when the CPU invalidates a previously requested range (or when the GPU explicitly invalidates it, e.g. a resolve); the callback is cancelled after it fires.
- `src/xenia/gpu/shared_memory.cc` keeps `system_page_flags_` as 64-bit blocks of `valid` and `valid_and_gpu_written` bits. `RequestRange` finds invalid pages, allocates sparse host GPU memory if needed, and uploads only those ranges. `MakeRangeValid` sets the valid bits, marks GPU-written pages, and calls `Memory::EnablePhysicalMemoryAccessCallbacks` so later CPU writes are caught. `RangeWrittenByGpu` marks pages GPU-written and fires watches so cached textures are invalidated.
- **D3D12 backend** (`src/xenia/gpu/d3d12/d3d12_shared_memory.cc`): creates a 512 MB **reserved** buffer with `D3D12_RESOURCE_FLAG_ALLOW_UNORDERED_ACCESS`; maps 64 KB tiles (`D3D12_TILED_RESOURCE_TILE_SIZE_IN_BYTES`) to default-heap allocations in 4 MB granularity (`D3D12_HEAP_FLAG_ALLOW_ONLY_BUFFERS`) with `UpdateTileMappings`; uploads invalid pages from a `D3D12UploadBufferPool` with `CopyBufferRegion`. If tiled resources are unavailable (or PIX is attached, historically), it falls back to a single 512 MB default-heap buffer and says video memory use "may increase significantly".
- **Vulkan backend** (`src/xenia/gpu/vulkan/vulkan_shared_memory.cc`): creates a `VK_BUFFER_CREATE_SPARSE_BINDING_BIT | VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT` buffer, allocates device-local `VkDeviceMemory` in 4 MB chunks, and binds them with `VkSparseMemoryBind` through `vkQueueBindSparse`. It notes the "overall 4096 allocation count limit on Windows drivers" — a real limit when scaling 512 MB to 16 GB.
- **Textures** (`src/xenia/gpu/texture_cache.cc`): each `Texture` calls `MakeUpToDateAndWatch` for its base and mip ranges; `WatchCallback` marks the base or mips outdated; `RequestRange` uploads the pages; a compute shader untiles/converts into the host texture. Scaled resolves are kept in the shared-memory buffer itself, and `RangeWrittenByGpu` invalidates textures that alias them.
- **GPU writes**: `src/xenia/gpu/d3d12/d3d12_render_target_cache.cc` resolves EDRAM into the shared-memory buffer as a UAV (`shared_memory.UseForWriting()`, `D3DSetComputeRootUnorderedAccessView`), so a resolve does not need a CPU copy.
- **Readback** is only for traces: `InitializeTraceSubmitDownloads` copies GPU-written ranges into a `D3D12_HEAP_TYPE_READBACK` buffer; `PrepareForTraceDownload` collects the ranges. There is no general path that reads a GPU-written page back into guest RAM when the CPU reads it. *(Inference from the code: Xenia relies on the guest CPU rarely reading resolved render targets; a title that does will read stale system RAM.)*

**Lesson:** a VRAM mirror with page validity, dirty uploads and GPU-side resolves is proven at 512 MB. At 16 GB the same design needs eviction and a readback path.

#### Ryujinx (Switch)

Ryujinx has the most explicit "what should live in VRAM" policy of the emulators.

- The GPU MMU (`src/Ryujinx.Graphics.Gpu/Memory/MemoryManager.cs`) is a 14+14+12-bit page table (40-bit VA, 4 KB pages) with `PteUnmapped`; unmaps raise `MemoryUnmapped`, which the buffer cache, texture cache and counter cache handle.
- `BufferCache.cs` keeps `_dirtyCache` and `_modifiedCache`, and exposes `ForceDirty`, `CheckModified`, `SynchronizeBufferRange`. `Buffer.cs` keeps a `BufferModifiedRangeList` of GPU-modified ranges, a `RegionHandle` (or `MultiRegionHandle` above 4096 bytes) from `PhysicalMemory.BeginTracking`, and calls `Reprotect`, `QueryModified(..., SequenceNumber)` and `Flush` to write GPU-modified ranges back to guest memory. `SynchronizeMemory` reloads a buffer if the CPU wrote it; `PreciseAction` can punch holes in the modified list instead of flushing on every write.
- `BufferBackingState.cs` is the decision procedure: `HostMemory`, `DeviceMemory` or `DeviceMemoryWithFlush`. It starts a buffer device-local if it is > 256 KB or is a fragment-stage storage buffer; it counts sets, writes and flushes and switches to host memory for frequently `Set` buffers (constant buffers) or to device-local for frequently written storage buffers (thresholds 100 sets, 50 writes, 5 flushes, 100-cycle force expiry). `ChangeBacking` creates a new host buffer, copies, and migrates the modified ranges. The comment says the heuristics "appear to produce good performance in most software".
- Textures (`Image/Texture.cs`) have a `_dirty` flag and `SynchronizeMemory`/`SynchronizeFull` to reload from guest memory; `GetTextureDataFromGpu` is documented as "not cheap, avoid doing that unless strictly needed". Texture groups flush incompatible overlaps.
- CPU tracking (`src/Ryujinx.Memory/Tracking/MemoryTracking.cs`, `RegionHandle.cs`) is page-protection based: a handle's required permission is `Read` when clean and `ReadAndWrite` when dirty; a pre-action can block the access. On Windows, `src/Ryujinx.Cpu/Signal/NativeSignalHandler.cs` installs an `AddVectoredExceptionHandler` handler (sigaction on Unix) and dispatches faults to tracked ranges.

**Lesson:** classify per buffer, not per allocation size alone; expect to migrate; make "get data from the GPU" an explicit, expensive operation.

#### yuzu (Switch)

yuzu's public write-ups are useful because they describe the design goals, not just the code.

- The **Buffer Cache Rewrite** post (`https://yuzu-mirror.github.io/entry/yuzu-bcr/`) says buffers are forcibly aligned to 4 KB pages, the cache uses a flat 32 MiB array to translate a CPU page to the buffer that lives there, and each buffer has bit arrays marking which 4 KB pages were modified. Only modified pages are uploaded; the post says the same mechanism handles GPU updates of CPU-modified data, and by extension a GPU-written page can be tracked the same way *(inference)*. The bit arrays allow `std::countr_zero`/`std::countr_one` to process runs quickly.
- The **Texture Cache Rewrite** post (`https://yuzu-mirror.github.io/entry/yuzu-tcr/`) says textures used to be removed from the cache on CPU writes, but are now flagged dirty, which lets yuzu keep image views and render targets; multiple textures can coexist at one address; aliased images are emulated through copies on demand. It also notes Vulkan's contiguous-allocation requirement causes VRAM fragmentation, which blocked the "Texture Reaper" eviction work.

*(The post describes the dirty-bit bookkeeping but not how CPU writes are trapped; with the source unavailable, this report does not claim a specific trap mechanism for yuzu.)*

**Lesson:** page-granular dirty bits are the unit of work; don't invalidate whole textures on a CPU write.

#### shadPS4 (PlayStation 4; yuzu-style buffer cache)

shadPS4 is a live, modern implementation of the same family for another unified-memory console. It is the closest codebase to a 16 GB problem.

- `src/video_core/buffer_cache/buffer_cache.h` defines a 40-bit address space, 4 GB "arena pages", 16 KB minimum block and stream threshold, and exposes `ReadMemory` (flush GPU-modified ranges to CPU memory), `InvalidateMemory`, `MarkRegionAsGpuModified`, `EnsureResident`, `SubmitPendingArenaBinds` (sparse `vk::SparseMemoryBind`) and `SynchronizeMemory`.
- `src/video_core/buffer_cache/memory_tracker.h` keeps per-page `Type::CPU` and `Type::GPU` modified state with `StateOp::Set/Clear` and a Boost interval `RangeSet`; `readbacks_mode == Disabled` simply marks CPU-modified without flushing.
- `src/video_core/page_manager.cpp` tracks per-page read and write watcher counts and changes `Core::MemoryPermission` accordingly (`Protect`), with signal (`SignalImpl`) and Linux `userfaultfd` (`UffdImpl`) backends.
- `src/video_core/buffer_cache/fault_manager.cpp` + `host_shaders/fault_buffer_process.comp` implement a GPU-side fault bitmap: a device-local buffer with one bit per page is parsed by a compute shader into a compact list of faulted pages in a download buffer. `vk_rasterizer.cpp` binds this buffer as `Shader::BufferType::FaultBuffer`. *(Inference: the fault bits are produced by instrumented translated shader accesses that find a page non-resident; the shader-side producer is not in the files read, but the descriptor type and the compacting pass are.)*

**Lesson:** sparse VRAM arenas + page watchers + a GPU-side fault bitmap is a scalable version of Xenia's mirror, and it is the closest published design to what this port needs.

#### Dolphin (GameCube/Wii)

Dolphin is the hash-based extreme. `Source/Core/VideoCommon/TextureCacheBase.h` stores `base_hash`, `hash` (base hash XOR palette hash), `may_have_overlapping_textures` and `is_efb_copy` on each `TCacheEntry`. `TextureCacheBase.cpp` re-hashes the backing memory on use (`entry->base_hash == entry->CalculateHash()`); if the hash changed, it invalidates the entry. It short-circuits when `TMEM::IsCached(stage)` says the texture is still in the console's tiny texture memory. EFB copies are kept in VRAM and `FlushEFBCopies()` pushes them to RAM at frame end (`OnFrameEnd`).

**Lesson:** hashing is correct and simple, but it only works because GameCube memory is 24 MB and texture write rates are low. Re-hashing 16 GB, or a few GB of live textures, per frame is not viable.

#### RPCS3 (PlayStation 3)

RPCS3 is the clearest example of hybrid page-protection plus hashing.

- `rpcs3/Emu/RSX/Common/texture_cache.h` / `texture_cache.cpp`: each `buffered_section` has `cpu_range`, `locked_range`, `confirmed_range`, `protection` (`rw`/`ro`/`no`) and `protection_strat` (`lock` or `hash`). `min_lockable_data_size = 4096`; sections at least that large use `mm_protect` (`rsx::memory_protect`), smaller ones use a hash. A `thrashed_set` collects `sections_to_flush`, `sections_to_unprotect`, `fault_range` and `invalidate_range` for a fault. The cache keeps per-frame counters such as `m_flushes_this_frame`, `m_misses_this_frame` and `m_unavoidable_hard_faults_this_frame`.
- `rpcs3/Emu/RSX/RSXThread.cpp` installs `g_access_violation_handler`, which calls `rsx::mm_flush(address)` and the renderer's `on_access_violation(ctx, address, is_writing)`.
- `rpcs3/Emu/RSX/Common/surface_store.h` keeps separate render-target and depth/stencil ranged maps (0x400000 granularity), invalidates/splits/reuses surfaces, and tracks active memory use.

**Lesson:** page protection is the correctness backstop; hashing is the cheap path for small sections; flush on fault, then unprotect.

#### Xbox One / Xbox Series: XValkyrie

XValkyrie (`sammwyy/xvalkyrie`) is an experimental Xbox One and Series X|S translation layer, i.e. the closest thing to this team's project.

- `src/runtime/modules/memory.cpp` implements `XMemAllocatePhysicalPages`, `XMemFreePhysicalPages`, `XMemMapPhysicalPages`, `XMemMapPhysicalPagesScatter`, `XMemTransferMemory` and friends on top of a **16 GiB section** (`CreateFileMapping2`) mapped in **64 KiB views** over placeholders (`MapViewOfFile3`/`UnmapViewOfFile2`, `MEM_PRESERVE_PLACEHOLDER`/`MEM_REPLACE_PLACEHOLDER`). A guest page is named by the number of its first 4 KB frame; `used` and `dirty` are bitmaps. The accepted allocation flags include `MEM_WRITE_WATCH`, and protections include `PAGE_WRITECOMBINE`.
- `src/runtime/modules/d3d12x/device.cpp` and `docs/research/d3d12x.md`: `CreatePlacedResourceX` places a resource at an address in the title's memory, but on the host it becomes a **committed resource**. For textures that are not render targets, depth buffers or UAVs, the title's memory is tracked and uploaded through the console's tiling with the package's own `xg_x.dll`, on a command list that runs before the title's, on a direct queue only. Buffers are remembered by GPU address. Descriptor heaps get shadow memory below 4 GiB with write-watch. The notes admit: "the title writes a texture's memory, which the host does not give: what it writes there is lost" for some cases.

**Lesson:** even a direct Xbox translation layer with a physical-page allocator cannot place host textures on guest pages; it falls back to tracking plus copies. That is the core gap this project faces too.

#### Static recompilation: XenonRecomp, ReGPU, N64Recomp, RT64

- **XenonRecomp** (`hedge-dev/XenonRecomp`, README): recompiled functions take a `PPCContext` and a **base address pointer**; the Xbox 360 uses 32-bit pointers. Loads/stores are marked volatile and swap endianness. Indirect calls use a table placed after the valid XEX memory region in the base allocation; an earlier 8 GB virtual allocation caused too much memory pressure. XenonRecomp provides no runtime and no GPU.
- **ReGPU** (`zer0ducksgiven/ReGPU`, README): an Xbox 360 GPU (Xenos) on D3D12 for XenonRecomp ports. The host supplies `host.base` (the guest's 4 GB address space) and `host.alloc(physical, size, align)`; the game writes command packets into a ring buffer and calls the kernel's `Vd*` functions. The hook `resolveWriteback` exists specifically to "copy a resolved image back to memory because the game reads it on the CPU (screenshots, thumbnails, focus readback)". So the normal path keeps resolved images on the GPU; the CPU-read path is an explicit, per-game hook.
- **N64Recomp** (`N64Recomp/N64Recomp`, README): recompiled functions receive an `rdram` pointer (`LOOKUP_FUNC(ctx->r25)(rdram, ctx)`), so guest RAM is a host pointer; overlays are handled by runtime lookup tables; TLB relocations are planned. There is no MMU or protection.
- **RT64** (`rt64/rt64`, README): the N64 renderer used by native ports. It defers RDP operations, tracks framebuffer addresses/dimensions and whether their contents live in GPU memory, and uses **two renderers**: a native-resolution renderer that "synchronizes back immediately with the game running at its original rate" so the game sees correct data in RAM, and a high-resolution renderer that replays the frame. When another operation samples memory owned by a framebuffer, it copies the framebuffer region back only if the load/sample parameters line up.

**Lesson:** static recompilation gives you a flat guest address space and lets you instrument every access, but the GPU layer still needs a writeback policy. The cheapest policy is RT64's: keep a native-resolution copy that the game can read, and defer everything else.

#### What this means for a 16 GB guest

- No project maps 16 GB of guest memory directly into both CPU and GPU address spaces. The closest is XValkyrie's 16 GiB section, and it still copies into host D3D12 resources.
- Every project that supports arbitrary guest writes uses page/range tracking, not whole-resource copies.
- Hashing only survives at small memory sizes (Dolphin) or for small sections (RPCS3).
- Page protection is the correctness tool, but faults are expensive; write-watch is the cheap tool for CPU writes.
- GPU-side resolves into the mirror (Xenia, shadPS4) are the main trick for avoiding readback of render targets.

### 2.2 PC graphics features that shrink the gap (Q2)

The short answer: two features actually change the shape of the problem — **CPU-visible VRAM through the BAR** (removes copies for CPU-written data) and **sparse/tiled resources** (makes a page-granular 16 GB mirror affordable). The rest are either budgeting tools, correctness tools, or conveniences.

#### D3D12

**`D3D12_HEAP_TYPE_GPU_UPLOAD` (CPU-visible VRAM).** This is the D3D12 equivalent of "BAR memory as a heap". The enum value is 5 in the DirectX spec (the Learn enum page lists it but omits its value and description). Requirements and pitfalls:

- Query support with `CheckFeatureSupport(D3D12_FEATURE_D3D12_OPTIONS16, ...)` and read `GPUUploadHeapSupported`; creation fails if it is false. The spec says GPU upload heaps "can only be supported with developer mode enabled", and that `L1MemoryFullyCpuAccessible` is true on discrete GPUs when the *entire* frame buffer is CPU-visible. Treat this as a fast path, not a hard dependency, and verify on the shipping OS/driver.
- The page property is `D3D12_CPU_PAGE_PROPERTY_WRITE_COMBINE` and the pool is `D3D12_MEMORY_POOL_L1` (VRAM). The spec says "we usually do not want to read any of this memory back from GPU, because such reads are inefficient". It also falls back to system memory if VRAM is full, so it is not a residency guarantee.
- It does **not** support `D3D12_HEAP_FLAG_SHARED`, `SHARED_CROSS_ADAPTER` or `ALLOW_DISPLAY`. Textures are allowed, but for opaque swizzled layouts `Map` does not disclose a pointer; you must use `WriteToSubresource`, or use `D3D12_TEXTURE_LAYOUT_STANDARD_SWIZZLE`/`ROW_MAJOR` where supported.
- Atomics on a CPU-visible heap are only guaranteed with `D3D12_HEAP_TYPE_CUSTOM` plus `D3D12_HEAP_FLAG_ALLOW_SHADER_ATOMICS`, and the flag "might be a limited resource on some systems".
- Write-watch does not detect some writes to GPU upload heaps; the spec adds `D3D12_HEAP_FLAG_TOOLS_USE_MANUAL_WRITE_TRACKING` and `ID3D12ManualWriteTrackingResource::TrackWrite` so tools such as PIX can follow CPU writes. Without it, captures may show stale contents.

**Custom heaps.** `D3D12_HEAP_TYPE_CUSTOM` + `ID3D12Device::GetCustomHeapProperties` lets you ask the driver what a heap type means on this adapter. On a discrete GPU, `WRITE_COMBINE` + `L1` is equivalent to a GPU upload heap; `D3D12_HEAP_TYPE_UPLOAD` maps to `WRITE_COMBINE` + `L0` (system memory); `READBACK` maps to `WRITE_BACK` + `L0`. The spec says `WRITE_BACK` + `L1` is not currently supported. On heap tier 1, `CreateHeap` must use one of `D3D12_HEAP_FLAG_ALLOW_ONLY_BUFFERS`, `ALLOW_ONLY_NON_RT_DS_TEXTURES` or `ALLOW_ONLY_RT_DS_TEXTURES`, so buffers and the two texture classes cannot share a heap; placed resources also obey the 64 KB placement alignment (4 MB for MSAA). Heap creation is slow; the residency doc recommends creating heaps on background threads.

**Residency control.** `D3D12_HEAP_FLAG_CREATE_NOT_RESIDENT` creates a heap in a non-resident state; make it resident with `ID3D12Device::MakeResident` or `ID3D12Device3::EnqueueMakeResident`. Heaps cannot be made partially resident (reserved resources are the workaround), and `Evict` is unreliable when `MaxGPUVirtualAddressBitsPerProcess` is close to the budget.

**UMA / `CacheCoherentUMA` / `IsolatedMMU`.** Query `D3D12_FEATURE_DATA_ARCHITECTURE` (or `ARCHITECTURE1` for `IsolatedMMU`). The architecture doc is explicit: "Do not assume UMA means all GPU-accessible memory can be freely made CPU-accessible, because it doesn't." `CacheCoherentUMA` is the property that actually aligns with CPU/GPU coherent access; on a discrete GPU such as the RTX 5090 both are normally false *(inference; query `CheckFeatureSupport` to confirm on the target)*. `IsolatedMMU` is the subtle one: when true, the GPU honors CPU page-table properties such as `MEM_WRITE_WATCH` and `PAGE_READONLY`, and "GPU write operations might be coarser than the application expects ... certain write-watch pages might appear dirty, even when it isn't obvious how GPU writes may have affected them." Do not put write-watch pages under GPU write traffic and expect exact dirty bits.

**Placed and reserved resources; tiled resources.** `ID3D12Device::CreateHeap` + `CreatePlacedResource` gives you a resource at a known offset in a heap. `CreateReservedResource` gives you only a GPU virtual address range; `ID3D12CommandQueue::UpdateTileMappings` / `CopyTileMappings` map 64 KB tiles to heap memory. This is exactly the mechanism Xenia uses for its mirror. Pitfalls:

- Reserved resources require tiled-resource tier 1 or greater. On tier 1 there is no 1D/3D support, no 2/8/16-sample MSAA (4x only, except 128-bpp formats), mip levels whose dimensions are not multiples of the tile size are packed into a mip tail that must be mapped or unmapped as a unit, and access to a NULL-mapped tile is undefined (including device removal). Tier 2 gives defined reads (0), discarded writes and status feedback.
- Tiled resources cannot be `Map`ped; CPU access requires a copy. PIX support for tiled buffers has historically been poor (Xenia disables tiled shared memory when a graphics analysis tool is attached).
- A 16 GB reserved buffer needs 34 bits of GPU VA; check `D3D12_FEATURE_DATA_GPU_VIRTUAL_ADDRESS_SUPPORT::MaxGPUVirtualAddressBitsPerResource`, because the per-resource limit can be lower than the per-process limit.
- Tile mappings are queue operations; changing them per draw will stall. Batch per frame, and keep a fallback flat allocation for tools that cannot handle tiled resources.

**Write-combined memory and readback.** `D3D12_HEAP_TYPE_UPLOAD` is write-combined and the docs say its CPU address is "commonly not efficient for CPU reads"; GPU upload heaps share that page property and the spec says reads are inefficient. `D3D12_HEAP_TYPE_READBACK` is `WRITE_BACK` and is the heap for CPU reads. The practical rule: never read a mapped upload/GPU-upload pointer to fetch GPU results; copy to a READBACK buffer, fence, then `Map` with an explicit `D3D12_RANGE` covering the read. Also note that `Map` denies the GPU access to the subresource until `Unmap`, so do not hold a mapping across a submission.

**`WriteBufferImmediate`.** `ID3D12GraphicsCommandList2::WriteBufferImmediate` performs 32-bit writes from the command stream to a buffer; the destination must be in `D3D12_RESOURCE_STATE_COPY_DEST`. Modes are `MARKER_IN` (after previous commands have started), `MARKER_OUT` (after all previous commands have completed) and default. It is useful for GPU progress markers/timestamps and for cheap "this range is ready" signalling, but it is not a fence and `MARKER_OUT` may occur before caches are flushed. For CPU polling, put the destination in a READBACK heap; polling a BAR-mapped destination is a slow uncached read.

**DirectStorage with GPU decompression.** DirectStorage 1.1 adds GDeflate GPU decompression. The API surface is `IDStorageQueue2`, `IDStorageFactory::SetStagingBufferSize`, `DStorageCreateCompressionCodec`, and destinations such as `DSTORAGE_DESTINATION_BUFFER`, `DSTORAGE_DESTINATION_TEXTURE_REGION` and `DSTORAGE_DESTINATION_MULTIPLE_SUBRESOURCES_RANGE`. `IDStorageQueue2::GetCompressionSupport` distinguishes driver-optimized GPU decompression, the built-in GPU fallback shader, and CPU fallback, and says whether the work uses a compute or copy queue. The developer guidance says DirectStorage keeps two *additional* VRAM staging buffers for GPU decompression (input and output), each the size set by `SetStagingBufferSize`, and that an uncompressed request larger than the staging buffer fails. Important: DirectStorage only reads files. It does not make CPU and GPU memory coherent, and console assets compressed with a non-PC codec must be repacked before GPU decompression helps *(inference: the PC codecs are GDeflate/Zstd; console codecs differ)*.

**Write-watch.** `D3D12_HEAP_FLAG_ALLOW_WRITE_WATCH` (0x200) makes a heap support `MEM_WRITE_WATCH`/`GetWriteWatch`. It "can't be combined with `D3D12_HEAP_TYPE_DEFAULT` or `D3D12_CPU_PAGE_PROPERTY_UNKNOWN`", and "applications are discouraged from using this flag themselves because it prevents tools from using this functionality." This is a CPU-write tracker for CPU-accessible heaps only; it cannot tell you which pages the GPU wrote in a default heap. Combine it with the `IsolatedMMU` warning above.

**Shared heaps and cross-API.** `D3D12_HEAP_FLAG_SHARED` + `CreateSharedHandle`/`OpenSharedHandle` share a heap by NT handle; `SHARED_CROSS_ADAPTER` shares across adapters. The docs say shared heaps are **not** supported on CPU-accessible heaps (`UPLOAD`, `READBACK`, or `CUSTOM` without `NOT_AVAILABLE`). So you cannot share a GPU-upload heap with another process or API; plan on a copy or a non-CPU-visible shared resource.

**`RecreateAtGpuva`.** D3D12 has a tools-facing way to create heaps and buffers at a chosen GPU VA: `D3D12_FEATURE_DATA_D3D12_OPTIONS20::RecreateAtTier`, `ID3D12DeviceTools::SetNextAllocationAddress`, and `ID3D12Tools1::ReserveGPUVARangesAtCreate`. The spec says "D3D12 is only able to recreate heaps and buffers" — not textures. That is useful for preserving guest buffer VAs, but it is not a general address-identity mechanism. A texture placed at offset 0 in a pinned heap might inherit the heap's VA, but the spec does not promise per-texture create-at-VA *(inference/untested)*.

#### Vulkan

**`DEVICE_LOCAL | HOST_VISIBLE` memory.** Vulkan exposes memory types, not heap types; a type can be both device-local and host-visible. The Vulkan Guide describes this combination as the UMA case where "there is no need to create a staging buffer and the transfer overhead is greatly reduced", but warns that system memory is shared with the GPU and you must watch memory pressure. On a discrete GPU with a full BAR, the driver can expose a type like this for VRAM *(inference; confirmed by measurement on this machine below)*. Requirements/pitfalls:

- Pick it from `vkGetPhysicalDeviceMemoryProperties` by the two property bits, not by heap index. If `HOST_COHERENT` is absent, you must call `vkFlushMappedMemoryRanges` after CPU writes and `vkInvalidateMappedMemoryRanges` before CPU reads, and round ranges to `VkPhysicalDeviceLimits::nonCoherentAtomSize`. Unmapping non-coherent memory does **not** flush; unflushed writes may never be visible.
- `HOST_VISIBLE` does not imply `HOST_CACHED`. The spec says uncached host reads are slower than cached reads (though uncached memory is always host-coherent). A BAR type is typically uncached or write-combined: writes stream well, reads are slow.
- It is still VRAM: over-allocating it consumes the device-local budget and can trigger paging/eviction even though it is CPU-visible.

**`VK_EXT_external_memory_host`.** This imports an existing host allocation (e.g. a pinned guest-RAM block) into a Vulkan memory object. The extension's own issues list the traps: the memory type depends on the implementation and must be queried with `vkGetMemoryHostPointerPropertiesEXT`; both the host pointer and size must be multiples of `minImportedHostPointerAlignment`; the host allocation must not be freed while imported; `vkMapMemory` is allowed to return a *different* virtual address (same physical pages); the same host allocation must not be imported twice on the same device; and normal synchronization rules still apply. This is a way to let the GPU read guest RAM without a copy, but it does not make that RAM device-local, and the GPU pays PCIe latency/bandwidth for every access. Combined with sparse binding, an imported host allocation can back sparse image or buffer ranges: that is the only API path that gives the CPU and GPU the *same bytes* at arbitrary guest addresses (with different virtual addresses), at the cost of PCIe-bound GPU access. Treat it as a fallback for CPU-authored textures, not for sampled-hot data. *(Inference from the two extensions; untested.)*

**`VK_EXT_pageable_device_local_memory`.** This tells the application that the OS virtualizes device-local memory and pages it between device-local and host heaps. Enable `VkPhysicalDevicePageableDeviceLocalMemoryFeaturesEXT::pageableDeviceLocalMemory`; the implementation may then succeed where it would have returned `VK_ERROR_OUT_OF_DEVICE_MEMORY`, and `vkSetDeviceMemoryPriorityEXT` controls what gets paged out first. It is a budgeting/overcommit tool, not a sharing tool: it does not make memory host-visible and it does not avoid the stalls caused by paging.

**Buffer device address.** `vkGetBufferDeviceAddress` returns a 64-bit GPU VA for a buffer; shaders can use it as a pointer. It is not a CPU pointer. Capture/replay can reproduce addresses: `VkPhysicalDeviceBufferDeviceAddressFeatures::bufferDeviceAddressCaptureReplay`, `vkGetBufferOpaqueCaptureAddress`, `vkGetDeviceMemoryOpaqueCaptureAddress`. `VkBufferDeviceAddressCreateInfoEXT::deviceAddress` looks like it lets you choose an address, but the spec requires it to be "an address retrieved from an identically created buffer on the same implementation" — not an arbitrary guest address. So a translation layer can use one big buffer plus a base offset, or capture/replay addresses, but cannot force GPU VA == guest CPU pointer.

**Sparse binding.** `VK_BUFFER_CREATE_SPARSE_BINDING_BIT | VK_BUFFER_CREATE_SPARSE_RESIDENCY_BIT` plus `vkQueueBindSparse` is the Vulkan equivalent of D3D12 reserved resources. The queue must support `VK_QUEUE_SPARSE_BINDING_BIT`; most implementations use 64 KB blocks for buffers; `VkSparseMemoryBind` can rebind ranges during the resource's lifetime, but you must synchronize against GPU use, and `vkFreeMemory` does not unbind the resource — accessing it afterwards is invalid. This is the right mechanism for a 16 GB mirror with evictable pages.

**`VK_KHR_external_memory_win32`.** Exports/imports NT handles (`vkGetMemoryWin32HandleKHR`, `VkImportMemoryWin32HandleInfoKHR`), so a D3D12 allocation can be shared with Vulkan without a copy. Handle ownership transfers to the application on export; imported memory may need a dedicated allocation and compatible handle types. Use it only if the translation layer genuinely runs both APIs.

**`VK_EXT_memory_budget` and `VK_EXT_memory_priority`.** `VkPhysicalDeviceMemoryBudgetPropertiesEXT::heapBudget`/`heapUsage` are the Vulkan equivalent of DXGI's video-memory budget (guidelines, not guarantees); `VK_EXT_memory_priority` lets you mark allocations that should be paged out last. Both are reporting/eviction tools, not coherence mechanisms.

#### Measured on the target machine

These are not documentation claims; they were measured on the target PC with `nvidia-smi` and `vulkaninfo` (NVIDIA driver 621.14, Vulkan 1.4.357):

| Query | Result |
|---|---|
| GPU / VRAM | RTX 5090, 32607 MiB |
| BAR1 total / used / free | 32768 MiB / 32739 MiB / 29 MiB |
| Vulkan heap 0 | 31.43 GiB, `DEVICE_LOCAL`, budget 30.68 GiB |
| Vulkan heap 1 | 47.67 GiB, host, budget 46.92 GiB |
| Vulkan memory type 4 | `DEVICE_LOCAL | HOST_VISIBLE | HOST_COHERENT` (heap 0, no `HOST_CACHED`) |
| `minImportedHostPointerAlignment` | 4096 bytes |
| Sparse residency | `sparseResidencyBuffer`, `sparseResidencyImage2D/3D`, `sparseResidencyAliased` all true |
| Buffer device address | `bufferDeviceAddress`, `bufferDeviceAddressCaptureReplay` true |
| Relevant extensions | `VK_EXT_external_memory_host`, `VK_EXT_pageable_device_local_memory`, `VK_EXT_memory_budget`, `VK_EXT_memory_priority`, `VK_KHR_external_memory_win32`, `VK_KHR_buffer_device_address`, `VK_EXT_buffer_device_address` |

Interpretation: the full framebuffer is exposed through BAR1 (`32768 MiB` total), and Vulkan exposes a coherent host-visible device-local type, so the Vulkan BAR path is real on this machine, not theoretical. The BAR1 'used' value reflects the driver's mapping of the framebuffer, not game allocations; it is not a free-space counter, so test that a multi-GB host-visible allocation succeeds while the game is running. The type is coherent but not cached, so CPU reads from it will still be slow; writes should be streaming. D3D12 GPU upload heaps must still be queried at runtime (`D3D12_OPTIONS16::GPUUploadHeapSupported`), and the spec's developer-mode requirement should be tested on the shipping OS. If that gate is real in the shipping environment, the Vulkan host-visible device-local type is the practical BAR path *(inference: Vulkan has no equivalent developer-mode gate in the spec read)*.

#### Verdict for Q2

- **Actually shrink the gap:** CPU-visible VRAM (D3D12 GPU upload/custom WC+L1; Vulkan `DEVICE_LOCAL|HOST_VISIBLE`), sparse/tiled resources for a page-granular mirror, GPU-side resolves to avoid readback, `MEM_WRITE_WATCH` for CPU writes, and explicit budgets.
- **Help only at the edges:** `WriteBufferImmediate` (markers), DirectStorage (asset streaming, not sharing), `VK_EXT_external_memory_host` (GPU reads guest RAM over PCIe), `VK_EXT_pageable_device_local_memory` (overcommit, not sharing), `RecreateAtGpuva` (buffer VA pinning).
- **Do not change the hardware reality:** `UMA` flags, `CacheCoherentUMA` on a discrete GPU, or buffer device addresses. They are queries or addressing tools, not coherence.

### 2.3 What professional ports do (Q3)

#### Microsoft's public guidance: classify, budget, stream

The most directly usable public guidance is Microsoft's D3D12 "Memory Management Strategies" page. Its recommended strategy is literally **"classify, budget and stream"**:

- **Critical** (game UI, command allocators, queues, query heaps): non-pageable, always committed.
- **Scaled/optional** (level-specific models and textures, swap chains, sky boxes, player character): committed or placed/reserved; re-evaluate residency less than once per frame.
- **Re-used** (shadow buffers, deferred rendering resources, post-processing, lighting caches): overlapping placed resources on heaps with aliasing barriers; intra-frame reuse.
- **Streaming** (terrain, open-world textures and geometry): partial residency based on visibility/distance, re-evaluated every frame; free-threaded creation on background threads and copy queues.

The same page says heaps cannot be made partially resident (reserved resources are the workaround), UMA adapters have one memory segment while discrete adapters have two, and an application that exceeds its budget will be frozen/paged or get creation failures. The Residency page adds that heap creation is slow and should happen on background threads, and that `Evict` is unreliable when `MaxGPUVirtualAddressBitsPerProcess` is close to the budget. This is the budgeting framework a port should adopt, whether or not it uses D3D12.

#### Nixxes

The best evidence that this is a named workstream is the GDC 2023 Advanced Graphics Summit talk **"'Marvel's Spider-Man' Remastered: A PC Postmortem"** by Rebecca Fernandez OShea and Michiel Roza (Nixxes). The published abstract says the talk covers "Direct3D 12 pipeline state object creation and management, **non-unified memory management**, ray tracing, debugging device removal crashes and supporting widescreen and resolutions other than the television standard of 16:9." That is exactly this problem, from a studio that ports PlayStation titles. The talk itself is video-only on GDC Vault; no transcript or slides were accessible, so this report cannot quote their method, only confirm that they treat non-unified memory as a first-class topic. *(The GDC 2017 Nixxes talk by Jurjen Katsman, "How to Thrive on the Bleeding Edge Whilst Avoiding Death by 1,000 Paper Cuts", is a D3D12 porting talk; its abstract is also read, but it is older and not specific to unified memory.)*

Nixxes' public PC specifications show the budgeting mindset, not the implementation: Ratchet & Clank: Rift Apart lists 8 GB RAM minimum, 16 GB recommended/high/RT, and 32 GB for "Ultimate Ray Tracing"; Horizon Forbidden West lists 16 GB RAM at every tier and GPUs from a 4 GB GTX 1650 to an RTX 4080/RX 7900 XT. In other words, they budget by GPU VRAM class and keep system RAM as a separate, usually fixed, budget *(inference from the published tables)*. They do not publish per-allocation residency rules.

#### The console's own split matters

The Xbox Series X is not a flat 16 GB pool in bandwidth terms. Microsoft's spec page lists **16 GB GDDR6, 10 GB @ 560 GB/s and 6 GB @ 336 GB/s**. The Series S lists **10 GB GDDR6, 8 GB @ 224 GB/s and 2 GB @ 56 GB/s**. Console titles already partition allocations between a fast region and a slow region *(inference: the hardware split is public, but the per-title allocation policy is not)*. A port can exploit that: map the "fast" allocations to VRAM and the "slow" ones to system memory or a lower-priority heap, preserving the game's intent instead of treating all 16 GB as equally hot. *(Inference: the allocator's tags and APIs may not map cleanly to the fast/slow regions, so this requires classifying by size/usage or by instrumentation; the hardware split is from Microsoft's published specs.)*

#### A decision matrix for "what lives where"

The cleanest way to decide is by who writes and who reads:

| Writer → Reader | CPU reads | GPU reads |
|---|---|---|
| **CPU writes** | System RAM; no mirror at all | System RAM + dirty upload, or BAR VRAM if writes are frequent and GPU reads are not bandwidth-critical |
| **GPU writes** | VRAM + readback on CPU access (page-protect/readback), or a native-resolution CPU-visible copy | VRAM (mirror or host resource); never read back unless evicting |

*(Inference/synthesis from the emulator designs and the D3D12/Vulkan rules above.)* This matrix is more useful than a size threshold because it predicts the cost: a page that is written by the CPU and read once by the GPU is an upload; a page written by the GPU and read by the CPU is a readback; a page read by the GPU every frame belongs in VRAM.

An illustrative starting budget on the measured 30.68 GiB Vulkan heap 0: keep 4–6 GiB headroom for the OS, other apps and driver overhead; reserve 2–3 GiB for 4K render targets/depth; reserve 1–2 GiB for caches and staging; the remainder (roughly 20 GiB) is the texture/mirror pool. Rebalance after measuring; the 16 GB guest does not need to be fully resident, only its working set. *(Inference: these are planning numbers, not measurements.)*

#### What the translation-layer projects do

- XValkyrie backs guest physical pages with a 16 GiB section and maps 64 KiB views; it tracks dirty pages, but `CreatePlacedResourceX` becomes a committed resource and non-trivial textures are uploaded through the console tiling with `xg_x.dll`. That is "classify by whether the resource is a texture/RTV/DSV/UAV", implemented because the host cannot place a texture on the guest page.
- ReGPU reads guest memory directly for the GPU and exposes `resolveWriteback` for the specific case where the game reads a resolved image on the CPU. That is "copy only on the CPU-read path", implemented as a per-game hook.
- Ryujinx's `BufferBackingState` is the most explicit shipped heuristic: size (> 256 KB), stage (fragment storage), and use counts (sets/writes/flushes) decide host vs device memory, with migration. It is an emulator, not a port, but it is the decision procedure a port needs.

#### Gaps in the public record

- Microsoft's GDK "porting guide for Xbox One" is marked **Authorization required** on the GDK contents page; the console-specific porting guidance is not public. This report cannot cite it.
- No public Iron Galaxy technical writeup on unified-memory porting was found. Their porting work is visible in shipped titles and credits, not in accessible primary sources.
- The Nixxes GDC 2023 talk is video-only; the abstract is the only text.
- Xenia's source is public and detailed, but it is an Xbox 360 emulator with a 512 MB mirror, not a 16 GB production port; its lack of a general CPU-readback path should not be copied blindly.

### 2.4 Design options for the translation layer (Q4)

The five options in the brief are not mutually exclusive; they are layers. On this machine, capacity is not the binding constraint (32 GB VRAM is larger than the console's 16 GB pool); copy bandwidth, latency and the CPU/GPU access asymmetry are. The comparison table is in section 3; here is what each option actually means in this codebase.

**A. Mirror everything.** Allocate a GPU buffer covering the guest's physical memory, upload dirty pages, keep GPU writes in the mirror, and read back pages the CPU touches. Xenia is the proof of concept, but at 512 MB. At 16 GB the problems are: (a) the mirror plus host textures plus render targets can exceed 32 GB, (b) Xenia has no general CPU-readback path for GPU-written pages, so you must add one, and (c) 16 GB / 4 MB sparse allocations is 4096 allocations, at the Windows driver limit Xenia warns about. Use larger sparse allocations and evict CPU-authored pages. This is the right default for **buffers**, not for the whole address space.

**B. Put all GPU-visible allocations in BAR-mapped VRAM.** Allocate in `D3D12_HEAP_TYPE_GPU_UPLOAD`/custom WC+L1, or Vulkan `DEVICE_LOCAL|HOST_VISIBLE`. CPU writes go straight to VRAM; there is no mirror and no upload. It is the cheapest correct option for write-once/streaming data, and the measured Vulkan device supports it (type 4). It is a poor default for the whole game because: GPU reads from BAR go over PCIe rather than VRAM bandwidth *(inference: the BAR aperture is PCIe-served; it does not add VRAM bandwidth)*; CPU reads are uncached/write-combined and slow; GPU upload heaps may fall back to system memory when VRAM is full; opaque-swizzled textures cannot be mapped as linear bytes; atomics on CPU-visible heaps are restricted; and the heap cannot be shared. It is also gated by full-BAR plus developer mode on D3D12.

**C. Classify allocations by use.** Decide per allocation (or per heap) whether it is GPU-read-heavy, GPU-write-heavy, CPU-write-heavy or CPU-read-heavy, and place/migrate it accordingly. This is the end state, and Ryujinx's `BufferBackingState` is a working example of the heuristic. It requires telemetry: allocation size, stage/binding, write/read counts, and whether the resource is a texture, RT/DS, UAV or buffer. It also requires a migration path (create a new resource, copy, swap descriptors) and a policy for hysteresis so a resource does not thrash between heaps.

**D. Shadow copies with dirty tracking.** Keep the authoritative copy in system RAM (or in VRAM), keep a shadow in the other memory, and track dirty ranges. This is the general case of A and the only option for textures that must be retiled. The cost is the dirty-tracking mechanism: page protection (accurate, expensive), write-watch (cheap, CPU-write only), explicit API interception (cheapest, but misses direct writes), or hashing (simple, only for small ranges). The shadow can be per-resource rather than per-page, which is how Ryujinx and yuzu start; page granularity is what makes it scale.

**E. Catch CPU reads of GPU-written memory.** Protect GPU-written pages so the CPU cannot read them, take a fault, copy the GPU data back to guest RAM, unprotect, and retry. RPCS3 does this with `on_access_violation(ctx, address, is_writing)` and `mm_flush`; Ryujinx does it with `RegionHandle` pre-actions; shadPS4 does it with page watchers and a readback mode. It is the correctness backstop for A/D, not a standalone design: if the game reads GPU-written memory every frame, every read becomes a GPU sync, and performance collapses. Use it only for pages the GPU actually wrote, batch the readbacks, and prefer a GPU-side resolve into a CPU-readable copy for data the game reads often (RT64's native-resolution renderer is the extreme version).

A practical classification point: classify at the first **GPU use** (`CreatePlacedResourceX`, `XMemMapPhysicalPages`, resource creation), not at `XMemAllocatePhysicalPages`. The allocator hands out physical pages without saying who will use them; the placement/resource-creation call is where the usage becomes known. *(Inference from the XValkyrie design, where placement and resource creation are the calls that know the usage.)*

#### Recommended hybrid

1. **Guest RAM is authoritative** for CPU-written data. Classify allocations into: CPU-only (never mirrored), CPU-write/GPU-read (mirror or BAR), GPU-write/GPU-read (VRAM), GPU-write/CPU-read (VRAM + readback/native copy).
2. **Mirror only GPU-visible buffers** into a sparse VRAM buffer at 64 KB granularity; bind them with base offsets; upload dirty 4 KB pages on first use. Do not mirror pages that are only texture sources after retile; keep them in RAM and re-upload on dirty.
3. **Textures get host resources** in the default heap, created from the mirror/RAM and retiled once per dirty epoch; track dirty at 4 KB or at texture-subresource granularity. This is the yuzu/Ryujinx model and avoids doubling 16 GB of textures.
4. **Volatile CPU-written buffers go to BAR** (Vulkan type 4 on this machine; D3D12 GPU upload/custom WC+L1) with a per-frame ring; if BAR is unavailable, use an upload ring and batch copies.
5. **GPU-written data stays in VRAM**; resolves go into the mirror or a native-resolution copy; readback only on CPU access, batched, with one fence per batch.
6. **Track CPU writes with `MEM_WRITE_WATCH`** where the guest RAM is `VirtualAlloc`'d with that flag, and GPU-written pages with page protection. Do not use write-watch on pages the GPU writes (`IsolatedMMU` false positives). If guest RAM is a file-mapping section (XValkyrie-style), write-watch may not be available; fall back to page protection or a separate write-watch allocation.

Streaming fills in place are the worst case: the game writes a texture region and samples it in the next draw. Either map that region in BAR (if the format/layout allows), or upload only the dirty subresource and insert the copy before the sampling draw; never retile the whole texture. *(Inference: this follows from the dirty-tracking design; the right choice depends on the texture layout and how soon the next draw samples it.)*

#### The address-translation reality

The game assumes GPU addresses and CPU pointers refer to the same bytes. On PC they cannot, in general:

- D3D12's `ID3D12Resource::GetGPUVirtualAddress` and Vulkan's `vkGetBufferDeviceAddress` return GPU VAs; `Map`/`vkMapMemory` return CPU pointers; no API equates them.
- `CreatePlacedResourceX` is an Xbox API; on PC, `CreatePlacedResource` places a resource in a heap whose GPU VA the driver chooses. `SetNextAllocationAddress`/`ReserveGPUVARangesAtCreate` can pin heap/buffer VAs, but the spec limits `RecreateAtGpuva` to heaps and buffers, not textures (a texture placed in a pinned heap may inherit the VA; untested).
- Vulkan's `VkBufferDeviceAddressCreateInfoEXT::deviceAddress` cannot be an arbitrary guest address; it must come from an identically created buffer.

So the translation layer needs an explicit mapping from guest GPU VA ranges to host resources plus offsets, applied at descriptor creation, at command-buffer address arguments (`WriteBufferImmediate`, indirect draws, copies) and in shader address arithmetic (a base offset uniform is the simplest fix) *(inference)*. Trying to preserve pointer identity will consume the project; translation is the only general answer. *(Inference: the exact set of guest address arguments depends on the D3D12X command stream; the API rules above are read.)*

### 2.5 What causes the stalls and the few frames per second (Q5)

The symptom "reaches the world but runs at a few frames per second with heavy copying and stalls" is consistent with a small number of causes. Rank them by expected impact for this title:

1. **Whole-resource copies per frame.** Copying 16 GB per frame over PCIe is roughly a 0.5–1 second frame at practical PCIe 5.0 x16 throughput; even 1 GB/frame is tens of milliseconds. *(Inference: arithmetic from the measured PCIe 5.0 x16 link and typical achievable bandwidth; the exact number depends on the copy engine and transfer size.)* This alone explains "a few FPS".
2. **Readback through write-combined/BAR memory.** Reading GPU results from an upload/GPU-upload pointer is uncached and serializing; it can be much slower than a READBACK-heap copy *(inference: the docs say "inefficient", not by how much)*. The D3D12 docs explicitly say upload heap CPU reads are not efficient, and the GPU-upload spec says reads are inefficient.
3. **A GPU sync per readback or per resource.** Each `Map` of a READBACK buffer after a fence can drain the pipeline *(inference: it serializes the copy against the GPU; the exact cost depends on the driver)*. If the translation layer resolves or reads back per draw, the GPU never gets more than one draw deep.
4. **VRAM over budget.** If the mirror plus host resources plus render targets exceed the local budget, the OS pages/freezes the process; the DXGI docs warn of "stuttering, as they are intermittently frozen and paged-out", and D3D12 creation can fail. The measured Vulkan heap 0 budget is 30.68 GiB, not 32 GiB; headroom is smaller than the card's nominal size.
5. **Page-protection fault storms.** Per-write or per-read faults are context switches plus handler work plus often a GPU sync *(inference: the exact cost is OS- and driver-dependent)*. Xenia's memory header notes exceptions are expensive and recommends unprotecting a range rather than a single page; RPCS3 tracks "unavoidable hard faults" per frame for this reason.
6. **Small scattered copies and no batching.** Many tiny `CopyBufferRegion`/`vkCmdCopyBuffer` calls, one per draw, are driver- and queue-bound even when the byte count is small *(inference)*. Batch into one upload ring and one copy per resource per frame.
7. **Per-frame allocation, tiling or mapping changes.** `CreateHeap`/`CreateCommittedResource`, `UpdateTileMappings`, `vkQueueBindSparse` and `Map`/`Unmap` are not free; the residency doc says heap creation is slow and recommends background threads, and tile/sparse mapping changes are queue operations that must be synchronized.
8. **Texture retile per frame.** If a streaming texture is retiled every time it is sampled, the compute/convert cost and the extra bandwidth dwarf the sample cost *(inference)*. Retile once per dirty epoch, not per draw.
9. **DirectStorage misconfiguration.** GPU decompression keeps two VRAM staging buffers; an oversized request fails, and CPU fallback or the wrong queue can serialize the load *(inference)*. This is a load-time/streaming cost, not a per-frame one, unless the game streams every frame.
10. **Descriptor/heap shadow maintenance.** XValkyrie-style shadow descriptor heaps with write-watch are scanned per submission; if the scan is O(all descriptors) per frame, it becomes a CPU bottleneck *(inference)*. Scan only dirty pages.

#### How to measure it

**Start with the translation layer's own counters.** Per frame: bytes copied CPU→GPU and GPU→CPU, number of `Map`/`Unmap`, number of readbacks, total fence wait time, number of `UpdateTileMappings`/`vkQueueBindSparse`, number of page faults, number of heap/resource creations, and `QueryVideoMemoryInfo`/`VK_EXT_memory_budget` budget and usage. Log a histogram, not just a total; a single 500 MB copy and a million 4 KB copies need different fixes.

**PIX on Windows.**
- A **Timing Capture** can collect "residency operations", "memory allocations", GPU timings, CPU samples and context switches. Use it to see whether the frame is CPU-bound, GPU-bound, or waiting on residency/copies. The overview explicitly lists residency operations and memory allocations among the optional data.
- A **GPU Capture** gives per-event GPU duration, hardware counters from AMD/Intel/NVIDIA, and a **Mappings** tab for reserved resources and heaps; PIX also has a "View tile mappings in GPU Captures" page (seen in search; not read in full). This is the tool for a tiled/sparse mirror.

**GPUView / Windows Performance Toolkit.** GPUView reads an ETW merge (`Log.cmd` produces `Merged.etl`) and shows CPU context switches with stacks and reasons, kernel enters/exits, all DxgKrnl GPU events including command-buffer submissions and resource creation/destruction/lock/bind, driver command-buffer start/end times, and "many other system events that can affect performance, such as page faults." Use it when PIX is too intrusive or when the stall is outside the GPU queue.

**DXGI / Vulkan budget APIs.** `IDXGIAdapter3::QueryVideoMemoryInfo(0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, ...)` gives `Budget`, `CurrentUsage`, `AvailableForReservation`, `CurrentReservation`; `RegisterVideoMemoryBudgetChangeNotificationEvent` tells you when the budget changes. On Vulkan, `VK_EXT_memory_budget` gives `heapBudget`/`heapUsage` per heap. Log these once per second and correlate with frame-time spikes: if usage is at/over budget, you have found the stall.

**GPU timestamps and markers.** D3D12 timestamp queries (`D3D12_QUERY_HEAP_TYPE_TIMESTAMP`, `D3D12_QUERY_TYPE_TIMESTAMP`) and `WriteBufferImmediate` bracket the upload/resolve/readback passes. Put the destination in a READBACK buffer and read it after a fence; do not poll a BAR pointer. On Vulkan, `vkCmdWriteTimestamp`/`vkGetQueryPoolResults`.

**Vendor tools.** AMD Radeon GPU Profiler shows how command buffers were submitted to each queue, how graphics/async-compute/copy workloads synchronize, GPU memory cache utilisation, and which barriers flushed caches. NVIDIA Nsight Graphics reports hardware-unit throughput, cache hit rates and memory throughput, and its trace analysis identifies performance blockers; Nsight Systems gives a system-wide CPU/GPU timeline. These are the right tools once you know the bottleneck is inside the GPU rather than in the translation layer's copies.

**A/B experiments.** Run with the mirror disabled, with BAR disabled, with readbacks disabled, with texture retile disabled, and with the texture cache limited. A single-variable change that moves FPS by 10x identifies the dominant path faster than any profile.

---

## 3. Options compared

Ratings are relative to this project (16 GB guest, 32 GB VRAM, 64 GB RAM, D3D12X→D3D12/Vulkan). "Effort" means engineering effort to make it correct and fast, not to prototype.

| Option | Speed | Correctness risk | Effort | When to use |
|---|---|---|---|---|
| **A. Mirror everything** | Medium–high GPU-side; upload only dirty pages; can be very slow if the mirror doubles VRAM and forces eviction; readback on CPU access is a sync | Medium: must catch GPU writes (resolves/UAVs) and CPU reads; Xenia's model has no general readback | High: sparse/tiled allocation, page table, watches, eviction, readback | As the **buffer** path for all GPU-visible buffers; not for the whole 16 GB if host textures are also resident |
| **B. All GPU-visible allocations in BAR VRAM** | Low–medium for hot data: zero copies, but GPU reads over PCIe and CPU reads uncached; catastrophic for textures sampled every frame | Low–medium: coherent on the measured Vulkan type; non-coherent flush rules; opaque texture swizzle; GPU-upload fallback to system memory; atomics restricted | Low–medium: heap/type selection, ring allocator, feature queries | First experiment and diagnostic; dynamic/streaming buffers; write-once data; small allocations; never as a blanket policy |
| **C. Classify allocations by use** | High when the classification is right; avoids both copies and remote access; migration costs on change | Medium: misclassification and migration bugs; needs telemetry and hysteresis | Medium–high: per-allocation metadata, heuristics, migration, fallback | Production end state; start after instrumentation, not before |
| **D. Shadow copies with dirty tracking** | High for sparse updates; medium for full updates; readback still needed for CPU reads | Low–medium: dirty tracking must be complete (CPU and GPU writers) | Medium–high: page protection/write-watch, dirty ranges, upload/download | Textures and retiled resources; when BAR is unavailable; when VRAM is tight |
| **E. Catch CPU reads of GPU-written memory** | Very high until a read; then a full GPU sync and copy, which can spike frame time; frequent reads collapse it | Low (correct) but deadlock/reentrancy/perf risk | High: page protection, fault handler, readback batching, unprotect policy | Required complement to A/D; only for pages the GPU wrote; never as the only strategy |
| **Hybrid (recommended): mirror buffers + host textures + BAR ring + fault readback** | High if the split matches the workload; bounded copies per frame | Medium–low: the most complex, but each path is independently testable | High (combines C+D+E, with B as a fast path) | The production design for this port |

**Recommendation.** Build the hybrid in this order: (1) instrumentation, (2) page-granular dirty upload for buffers, (3) host texture cache with dirty epochs, (4) BAR ring for volatile buffers, (5) classification/migration, (6) fault-driven readback for GPU-written pages. Do not start with "mirror everything"; it is the easiest to prototype and the hardest to make fit in 32 GB.

---

## 4. Pitfalls and measurement (short list)

**Pitfalls**

- **Never read write-combined memory.** `UPLOAD` and `GPU_UPLOAD` are WRITE_COMBINE; use a `READBACK` buffer and a fence. The same applies to Vulkan host-visible device-local memory without `HOST_CACHED`.
- **Never copy whole resources per frame.** Copy dirty 4 KB pages / 64 KB tiles; batch into a ring.
- **Do not assume GPU upload heaps are resident.** They fall back to system memory when VRAM is full, and the spec gates them behind full-BAR + developer mode.
- **Do not use write-watch on pages the GPU writes.** `D3D12_HEAP_FLAG_ALLOW_WRITE_WATCH` cannot be combined with `D3D12_HEAP_TYPE_DEFAULT`, and `IsolatedMMU` can produce false-positive dirty pages under GPU writes.
- **Write-watch requires `VirtualAlloc(MEM_WRITE_WATCH)`.** `GetWriteWatch` only works on a region allocated that way; a file-mapping section is not enough. If the guest RAM is a section, use page protection or a separate allocation.
- **CPU and GPU writes to the same page are a race on PC.** The console's single pool tolerates (or hides) a CPU write to memory the GPU is reading; on PC, either put that page in BAR/coherent VRAM, double-buffer it, or synchronize. The translation layer also needs barriers for overlapping GPU reads/writes.
- **Tiled tier 1 is dangerous.** NULL-mapped tile access is undefined (including device removal), mip tails are packed, and only 4x MSAA is supported. Tier 2 is much safer.
- **Sparse allocation counts are finite.** Xenia's Vulkan path notes the 4096-allocation limit on Windows drivers; 16 GB / 4 MB is exactly 4096. Use larger allocations and a free list.
- **Sparse rebinding needs synchronization.** Freeing a `VkDeviceMemory` does not unbind it; rebinding while the GPU reads the range is invalid.
- **Non-coherent Vulkan memory must be flushed/invalidated**; unmapping does not flush, and ranges must respect `nonCoherentAtomSize`.
- **`VK_EXT_external_memory_host` has hard constraints:** alignment (`minImportedHostPointerAlignment`, 4096 here), memory types queried from the pointer, no freeing while imported, no double import, and `vkMapMemory` may return a different address.
- **BDA is not pointer identity.** `VkBufferDeviceAddressCreateInfoEXT::deviceAddress` must come from an identically created buffer; `RecreateAtGpuva` only does heaps and buffers.
- **Page-protection faults are expensive.** Unprotect ranges, not single pages; coalesce readbacks; keep a native-resolution copy for data the CPU reads often.
- **Do not fence per resource.** Batch readbacks and copies under one fence; a fence per draw serializes the GPU.
- **Do not create heaps/tile mappings on the render thread.** Heap creation is slow; tile/sparse mapping changes are queue operations.
- **Budget with headroom.** The measured local budget is 30.68 GiB, not 32 GiB; over-budget means paging/freezing or creation failure.
- **DirectStorage is file I/O, not coherence.** GPU decompression needs two VRAM staging buffers and a supported compressed format; console assets may need repacking.

**Measurement checklist**

- Per frame: bytes copied each direction, `Map`/`Unmap` count, readbacks, fence wait time, page faults, tile/sparse mapping changes, heap/resource creations.
- Per second: `QueryVideoMemoryInfo(LOCAL/NON_LOCAL)` or `VK_EXT_memory_budget` budget/usage; correlate with frame-time spikes.
- Size resources with `ID3D12Device::GetResourceAllocationInfo` or `vkGetImageMemoryRequirements`/`vkGetBufferMemoryRequirements`; alignment, tiling and MSAA can make the real cost much larger than the requested size.
- PIX Timing Capture for residency operations, memory allocations, GPU timings, CPU samples, context switches; PIX GPU Capture for per-event GPU time, hardware counters and the Mappings tab.
- GPUView/WPA for DxgKrnl submissions, resource creation/destruction/lock/bind, page faults and CPU context switches.
- RGP for queue submission, barriers/cache flushes and GPU memory caches; Nsight Graphics for cache hit rates and memory throughput; Nsight Systems for the CPU/GPU timeline.
- In-engine timestamps around upload/resolve/readback passes, with `WriteBufferImmediate` markers; never poll a BAR pointer.

---

## 5. Sources

Each entry is marked **read** (fetched and read) or **seen in search results only**. Raw GitHub source files are listed by repository path; the URL is the raw file that was fetched.

### Emulators and recompilers

| Source | URL | Status |
|---|---|---|
| Xenia `src/xenia/gpu/shared_memory.h` | https://raw.githubusercontent.com/xenia-project/xenia/master/src/xenia/gpu/shared_memory.h | read |
| Xenia `src/xenia/gpu/shared_memory.cc` | https://raw.githubusercontent.com/xenia-project/xenia/master/src/xenia/gpu/shared_memory.cc | read |
| Xenia `src/xenia/gpu/d3d12/d3d12_shared_memory.cc` | https://raw.githubusercontent.com/xenia-project/xenia/master/src/xenia/gpu/d3d12/d3d12_shared_memory.cc | read |
| Xenia `src/xenia/gpu/d3d12/d3d12_shared_memory.h` | https://raw.githubusercontent.com/xenia-project/xenia/master/src/xenia/gpu/d3d12/d3d12_shared_memory.h | read |
| Xenia `src/xenia/gpu/vulkan/vulkan_shared_memory.cc` | https://raw.githubusercontent.com/xenia-project/xenia/master/src/xenia/gpu/vulkan/vulkan_shared_memory.cc | read |
| Xenia `src/xenia/gpu/texture_cache.cc` | https://raw.githubusercontent.com/xenia-project/xenia/master/src/xenia/gpu/texture_cache.cc | read |
| Xenia `src/xenia/gpu/d3d12/d3d12_render_target_cache.cc` | https://raw.githubusercontent.com/xenia-project/xenia/master/src/xenia/gpu/d3d12/d3d12_render_target_cache.cc | read |
| Xenia `src/xenia/memory.h` | https://raw.githubusercontent.com/xenia-project/xenia/master/src/xenia/memory.h | read |
| Ryujinx `MemoryManager.cs` (fork `alula/Ryujinx`, branch `qlaunch`) | https://raw.githubusercontent.com/alula/Ryujinx/qlaunch/src/Ryujinx.Graphics.Gpu/Memory/MemoryManager.cs | read |
| Ryujinx `BufferCache.cs` | https://raw.githubusercontent.com/alula/Ryujinx/qlaunch/src/Ryujinx.Graphics.Gpu/Memory/BufferCache.cs | read |
| Ryujinx `Buffer.cs` | https://raw.githubusercontent.com/alula/Ryujinx/qlaunch/src/Ryujinx.Graphics.Gpu/Memory/Buffer.cs | read |
| Ryujinx `BufferBackingState.cs` | https://raw.githubusercontent.com/alula/Ryujinx/qlaunch/src/Ryujinx.Graphics.Gpu/Memory/BufferBackingState.cs | read |
| Ryujinx `Image/TextureCache.cs` | https://raw.githubusercontent.com/alula/Ryujinx/qlaunch/src/Ryujinx.Graphics.Gpu/Image/TextureCache.cs | read |
| Ryujinx `Image/Texture.cs` | https://raw.githubusercontent.com/alula/Ryujinx/qlaunch/src/Ryujinx.Graphics.Gpu/Image/Texture.cs | read |
| Ryujinx `MemoryTracking.cs` | https://raw.githubusercontent.com/alula/Ryujinx/qlaunch/src/Ryujinx.Memory/Tracking/MemoryTracking.cs | read |
| Ryujinx `RegionHandle.cs` | https://raw.githubusercontent.com/alula/Ryujinx/qlaunch/src/Ryujinx.Memory/Tracking/RegionHandle.cs | read |
| Ryujinx `NativeSignalHandler.cs` | https://raw.githubusercontent.com/alula/Ryujinx/qlaunch/src/Ryujinx.Cpu/Signal/NativeSignalHandler.cs | read |
| Ryujinx `WindowsSignalHandlerRegistration.cs` | https://raw.githubusercontent.com/alula/Ryujinx/qlaunch/src/Ryujinx.Cpu/Signal/WindowsSignalHandlerRegistration.cs | read |
| yuzu Buffer Cache Rewrite | https://yuzu-mirror.github.io/entry/yuzu-bcr/ | read |
| yuzu Texture Cache Rewrite | https://yuzu-mirror.github.io/entry/yuzu-tcr/ | read |
| shadPS4 `buffer_cache.h` | https://raw.githubusercontent.com/shadps4-emu/shadPS4/main/src/video_core/buffer_cache/buffer_cache.h | read |
| shadPS4 `fault_manager.h` | https://raw.githubusercontent.com/shadps4-emu/shadPS4/main/src/video_core/buffer_cache/fault_manager.h | read |
| shadPS4 `fault_manager.cpp` | https://raw.githubusercontent.com/shadps4-emu/shadPS4/main/src/video_core/buffer_cache/fault_manager.cpp | read |
| shadPS4 `page_manager.h` | https://raw.githubusercontent.com/shadps4-emu/shadPS4/main/src/video_core/page_manager.h | read |
| shadPS4 `page_manager.cpp` | https://raw.githubusercontent.com/shadps4-emu/shadPS4/main/src/video_core/page_manager.cpp | read |
| shadPS4 `memory_tracker.h` | https://raw.githubusercontent.com/shadps4-emu/shadPS4/main/src/video_core/buffer_cache/memory_tracker.h | read |
| shadPS4 `range_set.h` | https://raw.githubusercontent.com/shadps4-emu/shadPS4/main/src/video_core/buffer_cache/range_set.h | read |
| shadPS4 `fault_buffer_process.comp` | https://raw.githubusercontent.com/shadps4-emu/shadPS4/main/src/video_core/host_shaders/fault_buffer_process.comp | read |
| shadPS4 `vk_rasterizer.cpp` (fault-buffer binding snippet) | https://grep.app/api/search?q=GetFaultBuffer | seen via grep.app API (snippet only) |
| Dolphin `TextureCacheBase.h` | https://raw.githubusercontent.com/dolphin-emu/dolphin/master/Source/Core/VideoCommon/TextureCacheBase.h | read |
| Dolphin `TextureCacheBase.cpp` | https://raw.githubusercontent.com/dolphin-emu/dolphin/master/Source/Core/VideoCommon/TextureCacheBase.cpp | read |
| RPCS3 `texture_cache.h` | https://raw.githubusercontent.com/RPCS3/rpcs3/master/rpcs3/Emu/RSX/Common/texture_cache.h | read |
| RPCS3 `surface_store.h` | https://raw.githubusercontent.com/RPCS3/rpcs3/master/rpcs3/Emu/RSX/Common/surface_store.h | read |
| RPCS3 `texture_cache_utils.h` | https://raw.githubusercontent.com/RPCS3/rpcs3/master/rpcs3/Emu/RSX/Common/texture_cache_utils.h | read |
| RPCS3 `texture_cache.cpp` | https://raw.githubusercontent.com/RPCS3/rpcs3/master/rpcs3/Emu/RSX/Common/texture_cache.cpp | read |
| RPCS3 `RSXThread.cpp` | https://raw.githubusercontent.com/RPCS3/rpcs3/master/rpcs3/Emu/RSX/RSXThread.cpp | read |
| XValkyrie README | https://raw.githubusercontent.com/sammwyy/xvalkyrie/main/README.md | read |
| XValkyrie `src/runtime/modules/memory.cpp` | https://raw.githubusercontent.com/sammwyy/xvalkyrie/main/src/runtime/modules/memory.cpp | read |
| XValkyrie `src/runtime/modules/d3d12x/device.cpp` | https://raw.githubusercontent.com/sammwyy/xvalkyrie/main/src/runtime/modules/d3d12x/device.cpp | read |
| XenonRecomp README | https://raw.githubusercontent.com/hedge-dev/XenonRecomp/main/README.md | read |
| ReGPU README | https://raw.githubusercontent.com/zer0ducksgiven/ReGPU/main/README.md | read |
| N64Recomp README | https://raw.githubusercontent.com/N64Recomp/N64Recomp/main/README.md | read |
| RT64 README | https://raw.githubusercontent.com/rt64/rt64/main/README.md | read |

### Microsoft D3D12 / DXGI documentation

| Source | URL | Status |
|---|---|---|
| `D3D12_HEAP_TYPE` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ne-d3d12-d3d12_heap_type | read |
| `D3D12_HEAP_FLAGS` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ne-d3d12-d3d12_heap_flags | read |
| `D3D12_CPU_PAGE_PROPERTY` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ne-d3d12-d3d12_cpu_page_property | read |
| `D3D12_MEMORY_POOL` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ne-d3d12-d3d12_memory_pool | read |
| `D3D12_FEATURE_DATA_ARCHITECTURE` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ns-d3d12-d3d12_feature_data_architecture | read |
| `D3D12_FEATURE_DATA_ARCHITECTURE1` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ns-d3d12-d3d12_feature_data_architecture1 | read |
| `ID3D12Device::GetCustomHeapProperties` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12device-getcustomheapproperties(uint_d3d12_heap_type) | read |
| `D3D12_TILED_RESOURCES_TIER` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ne-d3d12-d3d12_tiled_resources_tier | read |
| `ID3D12Device::CreateReservedResource` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12device-createreservedresource | read |
| `ID3D12Device::CreateHeap` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12device-createheap | read |
| `ID3D12CommandQueue::UpdateTileMappings` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12commandqueue-updatetilemappings | read |
| Tiled resources tier 1 | https://learn.microsoft.com/en-us/windows/win32/direct3d11/tier-1 | read |
| Tiled resources tier 2 | https://learn.microsoft.com/en-us/windows/win32/direct3d11/tier-2 | read |
| `ID3D12GraphicsCommandList2::WriteBufferImmediate` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/nf-d3d12-id3d12graphicscommandlist2-writebufferimmediate | read |
| `D3D12_FEATURE_DATA_GPU_VIRTUAL_ADDRESS_SUPPORT` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ns-d3d12-d3d12_feature_data_gpu_virtual_address_support | read |
| `D3D12_FEATURE_DATA_D3D12_OPTIONS` | https://learn.microsoft.com/en-us/windows/win32/api/d3d12/ns-d3d12-d3d12_feature_data_d3d12_options | read |
| `GetWriteWatch` | https://learn.microsoft.com/en-us/windows/win32/api/memoryapi/nf-memoryapi-getwritewatch | read |
| UMA optimizations / CPU-accessible textures | https://learn.microsoft.com/en-us/windows/win32/direct3d12/default-texture-mapping | read |
| Shared heaps | https://learn.microsoft.com/en-us/windows/win32/direct3d12/shared-heaps | read |
| Residency | https://learn.microsoft.com/en-us/windows/win32/direct3d12/residency | read |
| Memory Management Strategies | https://learn.microsoft.com/en-us/windows/win32/direct3d12/memory-management-strategies | read |
| `IDXGIAdapter3::QueryVideoMemoryInfo` | https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_4/nf-dxgi1_4-idxgiadapter3-queryvideomemoryinfo | read |
| `DXGI_QUERY_VIDEO_MEMORY_INFO` | https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_4/ns-dxgi1_4-dxgi_query_video_memory_info | read |
| `DXGI_MEMORY_SEGMENT_GROUP` | https://learn.microsoft.com/en-us/windows/win32/api/dxgi1_4/ne-dxgi1_4-dxgi_memory_segment_group | read |

### DirectX specs and DirectStorage

| Source | URL | Status |
|---|---|---|
| D3D12 GPU Upload Heaps spec | https://raw.githubusercontent.com/microsoft/DirectX-Specs/master/d3d/D3D12GPUUploadHeaps.md | read |
| D3D12 WriteBufferImmediate spec | https://raw.githubusercontent.com/microsoft/DirectX-Specs/master/d3d/D3D12WriteBufferImmediate.md | read |
| D3D12 Recreate at GPUVA spec | https://raw.githubusercontent.com/microsoft/DirectX-Specs/master/d3d/RecreateAtGpuva-public.md | read |
| DirectStorage GDK overview | https://learn.microsoft.com/en-us/gaming/gdk/_content/gc/system/overviews/directstorage/directstorage-overview | read |
| DirectStorage 1.1 GPU decompression blog | https://devblogs.microsoft.com/directx/directstorage-1-1-now-available/ | read |
| DirectStorage samples README | https://raw.githubusercontent.com/microsoft/DirectStorage/main/README.md | read |
| DirectStorage Developer Guidance | https://raw.githubusercontent.com/microsoft/DirectStorage/main/Docs/DeveloperGuidance.md | read |
| `DSTORAGE_COMPRESSION_SUPPORT` | https://learn.microsoft.com/en-us/windows/win32/dstorage/dstorage/ne-dstorage-dstorage_compression_support | read |
| `DSTORAGE_DESTINATION_BUFFER` | https://learn.microsoft.com/en-us/windows/win32/dstorage/dstorage/ns-dstorage-dstorage_destination_buffer | read |
| `DSTORAGE_DESTINATION_TEXTURE_REGION` | https://learn.microsoft.com/en-us/windows/win32/dstorage/dstorage/ns-dstorage-dstorage_destination_texture_region | read |
| `DSTORAGE_DESTINATION_MULTIPLE_SUBRESOURCES` | https://learn.microsoft.com/en-us/windows/win32/dstorage/dstorage/ns-dstorage-dstorage_destination_multiple_subresources | read (stub) |
| `IDStorageQueue2` | https://learn.microsoft.com/en-us/windows/win32/dstorage/dstorage/nn-dstorage-idstoragequeue2 | read (stub) |

### Vulkan

| Source | URL | Status |
|---|---|---|
| `VK_EXT_external_memory_host` | https://registry.khronos.org/vulkan/specs/latest/man/html/VK_EXT_external_memory_host.html | read |
| `VK_EXT_pageable_device_local_memory` | https://registry.khronos.org/vulkan/specs/latest/man/html/VK_EXT_pageable_device_local_memory.html | read |
| `VkMemoryPropertyFlagBits` | https://registry.khronos.org/vulkan/specs/latest/man/html/VkMemoryPropertyFlagBits.html | read |
| `vkMapMemory` | https://registry.khronos.org/vulkan/specs/latest/man/html/vkMapMemory.html | read |
| `vkFlushMappedMemoryRanges` | https://registry.khronos.org/vulkan/specs/latest/man/html/vkFlushMappedMemoryRanges.html | read |
| `VK_EXT_memory_budget` | https://registry.khronos.org/vulkan/specs/latest/man/html/VK_EXT_memory_budget.html | read |
| `VK_EXT_memory_priority` | https://registry.khronos.org/vulkan/specs/latest/man/html/VK_EXT_memory_priority.html | read |
| `vkQueueBindSparse` | https://registry.khronos.org/vulkan/specs/latest/man/html/vkQueueBindSparse.html | read |
| Vulkan Guide: Sparse Resources | https://docs.vulkan.org/guide/latest/sparse_resources.html | read |
| Vulkan Guide: Memory Allocation | https://docs.vulkan.org/guide/latest/memory_allocation.html | read |
| `vkGetBufferDeviceAddress` | https://registry.khronos.org/vulkan/specs/latest/man/html/vkGetBufferDeviceAddress.html | read |
| `VK_KHR_buffer_device_address` | https://registry.khronos.org/vulkan/specs/latest/man/html/VK_KHR_buffer_device_address.html | read |
| `VkBufferDeviceAddressCreateInfoEXT` | https://registry.khronos.org/vulkan/specs/latest/man/html/VkBufferDeviceAddressCreateInfoEXT.html | read |
| `VK_KHR_external_memory_win32` | https://registry.khronos.org/vulkan/specs/latest/man/html/VK_KHR_external_memory_win32.html | read |
| `VkPhysicalDeviceExternalMemoryHostPropertiesEXT` | https://registry.khronos.org/vulkan/specs/latest/man/html/VkPhysicalDeviceExternalMemoryHostPropertiesEXT.html | read |
| `vkGetMemoryHostPointerPropertiesEXT` | https://registry.khronos.org/vulkan/specs/latest/man/html/vkGetMemoryHostPointerPropertiesEXT.html | read |

### Console specs, professional porting, and measurement

| Source | URL | Status |
|---|---|---|
| Xbox Series X specifications | https://www.xbox.com/en-US/consoles/xbox-series-x | read |
| Xbox Series S specifications | https://www.xbox.com/en-US/consoles/xbox-series-s | read |
| GDC 2023: "Marvel's Spider-Man Remastered: A PC Postmortem" (Nixxes) | https://gdcvault.com/play/1028914/Advanced-Graphics-Summit-Marvel-s | read (abstract only; video not transcribed) |
| GDC 2017: Nixxes D3D12 porting talk | https://gdcvault.com/play/1024384/Advanced-Graphics-Tech-How-to | read (abstract only) |
| GDC Vault search for Nixxes | https://gdcvault.com/search.php?keyword=Nixxes | read |
| Ratchet & Clank: Rift Apart PC specs/features | https://blog.playstation.com/2023/07/26/ratchet-clank-rift-apart-is-out-now-on-pc-what-to-expect/ | read |
| Horizon Forbidden West PC specs | https://blog.playstation.com/2024/03/05/horizon-forbidden-west-complete-edition-pc-specifications-revealed-out-march-21/ | read |
| About GPUView | https://learn.microsoft.com/en-us/windows-hardware/drivers/display/using-gpuview | read |
| PIX GPU captures overview | https://learn.microsoft.com/en-us/windows/pix/gpu-captures/gpu-captures-overview | read |
| PIX timing captures overview | https://learn.microsoft.com/en-us/windows/pix/timing-captures/timing-captures-overview | read |
| PIX manual write tracking | https://learn.microsoft.com/en-us/windows/pix/gpu-captures/manual-write-tracking-resources | read |
| AMD Radeon GPU Profiler | https://gpuopen.com/rgp/ | read |
| NVIDIA Nsight Graphics | https://developer.nvidia.com/nsight-graphics | read |
| NVIDIA Nsight Systems | https://developer.nvidia.com/nsight-systems | read |

### Seen in search results only / not accessible

| Source | URL | Status |
|---|---|---|
| PIX "View tile mappings in GPU Captures" | https://learn.microsoft.com/en-us/windows/pix/gpu-captures/view-tile-mappings | seen in search results only |
| GDK "Microsoft Game Development Kit porting guide for Xbox One" (authorization required) | https://learn.microsoft.com/en-us/gaming/gdk/docs/console-dev/porting/era/porting-guide-for-existing-era | constructed from the relative link on the GDK contents page; not readable (authorization required; the constructed URL returns 404) |
| GDK contents page (source of the porting-guide link) | https://learn.microsoft.com/en-us/gaming/gdk/docs/gdk-dev/get-started/get-started-home | read |

### Notes on sources

- The original Ryujinx and yuzu GitHub repositories are unavailable (HTTP 451, DMCA). Ryujinx code was read from the `alula/Ryujinx` fork (branch `qlaunch`); yuzu design details were read from the `yuzu-mirror.github.io` posts. The yuzu source tree itself was not available.
- `vulkaninfo` and `nvidia-smi` are local diagnostics, not web sources. Their outputs are reported in section 2.2 as measured on the target machine.
- GitHub API tree endpoints were used to discover file paths (e.g. `https://api.github.com/repos/xenia-project/xenia/git/trees/master?recursive=1`, read; navigation aid, not a factual source).
- The original repository endpoints `https://api.github.com/repos/ryujinx-mirror/ryujinx/git/trees/master?recursive=1` and `https://api.github.com/repos/yuzu-mirror/yuzu/git/trees/master?recursive=1` were attempted and returned HTTP 451 (unavailable for legal reasons); that is why the Ryujinx fork and the yuzu mirror site were used.
- The GDC Vault talk pages provide abstracts only; the videos were not transcribed. Claims about Nixxes' method are therefore limited to the abstract's list of topics.
- No public Iron Galaxy technical writeup on unified-memory porting was found; this is a gap in the public record, not an omission by choice.

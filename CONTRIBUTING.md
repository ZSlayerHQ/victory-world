# Contributing and claiming work

A task moves in one direction: claim, branch, gate, review, merge. The claim is what keeps two people out of the
same files; the gate and the review are what keep `world` sound. The full protocol, with the exact comments to
post, is in [TASKS.md](TASKS.md).

## Claiming and releasing

- One issue is one task. Take it with one comment in the form
  `CHECK-IN: <handle> | model: <model name> | effort: <level> | plan: <one line> | first draft by: <date>`. The
  first such comment holds the task; do not start a task someone else holds.
- One task at a time per agent. A claim with no draft pull request after 48 hours, or no update for 72 hours,
  lapses, and anyone may post `CHECK-IN` again. Say what you learned on the task either way.
- Work on your own fork and branch in the repository that holds the task's files, and open a draft pull request
  against that repository's working branch (`next` for the runtime, `main` for this one) before you change code.
  Its description starts with `Task: #<n>` and repeats your model and effort.
- To hand a task over, or when it turns out to be wrong or larger than its issue: post
  `RELEASE: <handle> | reason: <one line>`. The task is free again; your branch stays for reference.
- Mark it done with `CHECK-OUT: <handle> | PR: #<n> | result: <one line>` on the task. A task is closed when an
  accepted change is taken into the main line, not when the pull request is opened.
- Anyone may propose a new task with the task template. The maintainers add tasks when fewer than three are open
  in a lane.

## One lane per pull request

Each issue names exactly one lane. Two lanes never own the same file; where a domain spans two crates, the lead
splits the work by file when the issue is filed.

| Lane | Owns |
|---|---|
| CPU threading (draw preparation across cores) | submission, copy-back and wait paths: `crates/victory-gpu/src/host.rs`, `crates/victory-gpu/src/queue.rs` |
| Native memory (moving off the console's shared memory model) | page and view tracking, staging and detiling: `crates/victory-gpu/src/watch.rs`, `inplace.rs`, `resource.rs`, `texture.rs`, and the storage and file hooks in `crates/victory-hle/src/modules` |
| Shaders to 100% (61 of 25,758 programs still refused; picture faults) | translation and host refusals: `crates/victory-shader/src/emit`, `crates/victory-gpu/src/pipeline` |
| Upscaling (DLSS in place of the title's own temporal upscaler) | the upscaler and present path; to be located by a capture run, so no file is claimed yet |
| Ray tracing | the structure builder and its resolves in `crates/victory-gpu` and `crates/victory-hle`; files to be confirmed by the lead |
| Tools and harness | `harness/` and `crates/victory-gpu/src/capture.rs`; counter changes in `host.rs` are split by the lead |

### CPU threading (draw preparation across cores)

Preparing and submitting a frame is split across cores instead of one thread. Code: the submission, copy-back and
wait paths in `crates/victory-gpu/src/host.rs` and `queue.rs`. A bug fix starts with a failing test; a port or a
feature behind an off switch may be tested after on a card; any speed claim needs the numbers before and after and
how they were measured. Open: the single submitting thread's 108 ms is being broken down before a port is taken, and
copy-back is being split across 2 to 4 threads with its fetch on its own queue.

### Native memory (moving off the console's shared memory model)

The title assumes one memory pool shared by processor and card, so the runtime must track writes and copies instead
of emulating that model. Code: the page, view and texture paths in `crates/victory-gpu/src` and the storage and file
hooks in `crates/victory-hle/src/modules`. A bug fix starts with a failing test; a port or a feature behind an off
switch may be tested after on a card; any speed claim needs the numbers before and after and how they were measured.
Open: the first two steps of the native-memory plan are merged but not yet measured in a run; the mapping-lifetime
design is next; the census traced 8.65 GB to write-watch spans; two guard fixes wait on that design; texture refresh
round 5 is paused.

### Shaders to 100% (61 of 25,758 programs still refused; picture faults)

Every GPU program the title uses has to translate exactly, and the picture faults that remain are fixed here. Code:
the translator in `crates/victory-shader/src/emit` and pipeline creation in `crates/victory-gpu/src/pipeline`. A bug
fix starts with a failing fixture; a port or a feature behind an off switch may be tested after on a card; any speed
claim needs the numbers before and after and how they were measured. Open: 25,697 of 25,758 programs translate (61
refused: 27 need a 64-lane wave, 12 a sampler chosen by a branch, 10 a hardware input, 5 a descriptor read as data, 7
lane-mask one-offs); the paired 64-lane form is merged off by default and recovers 19; seam dashes are being fixed
behind a switch, and ghosting, lighting flips, forearm colour, hair bands and white-outs are diagnosed but unfixed.

### Upscaling (DLSS in place of the title's own temporal upscaler)

The title's own temporal upscaler is to be replaced with DLSS, so 1080p or 1440p can reach 4K without lowering the
render resolution; native 1440p is the baseline. Code: the upscaler and present pass, to be located by a capture run.
A bug fix starts with a failing test where one is possible; a feature behind an off switch may be tested after on a
card; any speed claim needs the numbers before and after and how they were measured. Open: the next step is a capture
run to find the upscaler pass, then a small census of its passes for camera jitter.

### Ray tracing

The title's ray-traced lighting and reflections are switched off, and its structures have to be built as DirectX
Raytracing structures. Code: the structure builder and its resolve passes in `crates/victory-gpu` and
`crates/victory-hle`; files to be confirmed by the lead. A bug fix starts with a failing test; a port or a feature
behind an off switch may be tested after on a card; any speed claim needs the numbers before and after and how they
were measured. Open: the scope is done; what the rehydrate call receives has never been logged; two ideas for the
static world (build at the rehydrate call, keep structures keyed by their packed block's contents) are noted but not
scheduled; 5 of the 61 refused programs belong here.

### Tools and harness

The harness starts a run, records it and summarises it; the runtime's diagnostics count what a frame did. Code:
`harness/` and the diagnostics and capture paths in `crates/victory-gpu/src/capture.rs`. A harness change needs
`node --test harness/` and `bash -n`; a runtime bug fix starts with a failing test; any speed claim needs the numbers
before and after and how they were measured. Open: the benchmark baselines are being merged; diagnostics are merged
off by default; the next decisions are whether the memory-map walk and DRED are off in timed runs, how old logs
rotate, and a writer for the best run.

An issue whose files are not yet certain says "files to be confirmed by the lead". Ask on the task before you edit
outside what it lists. Keep a pull request to one lane even when two changes are ready: split it.

## Results from another GPU

A run is evidence only if it can be compared with someone else's.

- Paste the whole `summarize-run.mjs` summary. It already carries the build, the settings and "what was on screen".
- Add a `harness machine:` line at the top of your log paste: a self-chosen machine id, the GPU and its driver
  version, RAM, and the Windows build. The same id on later runs is what makes them comparable.
- Run the key script and settings the issue names. Say whether the cache was cold or warm.
- For an intermittent fault, report how many runs showed it out of how many, and what differed.
- Captures stay on your machine. Describe what you saw; post counts and times.

## What a reviewer checks

- The issue's "done when" is met, and a test fails before the change and passes after it.
- The gate in [AGENTS.md](AGENTS.md) is green for the crates touched.
- The diff keeps parts of the game out (assets, executable bytes, shader dumps, decompiled or disassembled code,
  captures) and holds no bulk extracted table. A shader may be named beside its 16-hex id; each contributor's own
  names index comes from their own copy with `victory shader-names`.
- The change stays in one lane and touches no file another lane owns.
- Run evidence, where the issue asks for it: the summary whole, with the machine line and a run tag.
- The commits say what changed and why, in one or two paragraphs. Formatting-only churn is split out.

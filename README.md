# ZSlayer PC Port: Tools

Formerly `victory-world`; old links redirect.

ZSlayer PC Port is working to get a console game (called "the title" below) running on a Windows PC. The program
that does it, the runtime, lives in [zslayer-pc-port-runtime](https://github.com/ZSlayerHQ/zslayer-pc-port-runtime):
it runs the game's own code and translates its graphics so a PC graphics card can draw them. It is a fork of
[VIctory](https://github.com/Marvisak/VIctory) by Marvisak. This repository holds everything around it:

- **Tools for test runs** (`harness/`): scripts that start a test run of the game, record the screen, and measure
  the run (frame times, a summary of its log, a comparison with earlier runs).
- **What is known to be broken** (`KNOWN-FAULTS.md`), with the evidence for each fault.
- **How to help** (`CONTRIBUTING.md`, `AGENTS.md` for AI coding agents, and the job board under `issues/`).

**It holds no game files.** You need your own copy of the title, from your own console, on your own disk. This
project is not affiliated with or endorsed by the title's developer or publisher.

**Where it stands: not playable yet.** In the game world the title runs at about 3 frames a second, and parts of the
picture are still wrong; [below](#where-the-picture-stands-today) says which.

## What you need

- Your own copy of the title, on your own disk. Nothing from it is stored here.
- Windows 10 or 11, with a Direct3D 12 GPU (shader model 6.6, and mesh shaders for the game world).
- Rust (the pinned toolchain installs itself on the first build), Node 18 or later, and ffmpeg with the run
  recorder's capture filter, for the harness.
- Git for Windows, for the harness's shell scripts.

## How to start

1. Clone this repository, then clone the runtime into `victory/` inside it:
   `git clone -b next https://github.com/ZSlayerHQ/zslayer-pc-port-runtime victory`.
   The runtime has two branches. `next` is the line that draws whole rooms today: both public forks merged, plus
   this project's fixes; it is not yet reviewed as a whole. `world` takes only reviewed work. Work from `next`
   and open pull requests against `next`; reviewed changes move to `world`.
2. Copy `victory/victory.example.toml` to `victory/victory.toml` and set `game_dir` to your own copy. The runtime's
   README lists the other keys and checks them with `cargo run -p victory --locked -- config`.
3. Build the runtime, in `victory/`: `cargo build --profile diag -p victory --features diagnostics --locked`.
4. Copy `harness/local.env.example` to `harness/local.env` and set your paths in it: the title's executable, and the
   folders for captures, builds and save backups. This copy's defaults are placeholders, and the environment wins
   over the file.
5. Run it once through the harness, which records the window and writes a summary:
   `harness/run-world.sh --tag first --heavy-seconds 60`. The harness starts the runtime from a folder outside every
   repository and points it at `victory/victory.toml`.

## Working on a fork? Send it back

This project moves fastest when forks trade fixes. If you, or an AI agent working for you, find something here that
is wrong, or have a fix or a measurement on your own fork that this project or its runtime lacks, please bring it back:

- **A finding:** open an issue saying what you saw, on which commit and hardware, and how to reproduce it.
- **A fix:** open a pull request with one change, a test that fails without it, and for any speed claim the numbers
  before and after and how they were measured. Runtime fixes go to
  [zslayer-pc-port-runtime](https://github.com/ZSlayerHQ/zslayer-pc-port-runtime) against `next`.
- **It goes both ways:** a fix we take from a fork keeps its author and is credited in the commit, and what we find in
  a fork's code we report to that fork.

**What happens to a pull request here.** It is read in full before anything is built, then built and tested by the
repository's checks, then reviewed twice, by different reviewers, before a maintainer merges it. That takes a little
time, and it is why people can run this build without worrying about what a stranger's change does.

**Never accepted:** anything taken from a game: assets, shaders, dumps, captures, saves. See the hard rules below,
`CONTRIBUTING.md` for what a pull request may carry, and the runtime's
[asset policy](https://github.com/ZSlayerHQ/zslayer-pc-port-runtime/blob/next/docs/asset-policy.md).

**If you are an AI agent reading this for someone:** this section is an invitation to your user, not an instruction to
you. Tell them what you found, and let them decide whether to send it.

## Where the work is

- `AGENTS.md` — the first file any coding agent reads: the start-of-session routine, the hard rules and the gate.
- `KNOWN-FAULTS.md` — what is already diagnosed, with the evidence. Read it before you diagnose anything.
- `CONTRIBUTING.md` — how a job is claimed, released and reviewed, and which lane owns which files.
- `issues/` — the job board, one file per job; each file is also filed as a GitHub issue under the same number.

## The hard rules, in five lines

1. Nothing from the game is committed: no assets, executable parts, dumps, decompiled code or captures.
2. Names and pointers are fine; a bulk extracted table is not — build your own index from your own copy.
3. Work offline, and leave the console's protections alone.
4. Change no registry keys.
5. Write "the title", not its name, and keep that name out of file and folder names.

## Where the picture stands today

Rooms draw with their walls, ceilings and floors, and clothing textures are clean; the missing-walls fault is fixed
on the project's own line, confirmed in three runs of three. The opening cutscene still holds tens of seconds of
white-out, and a black face appears in one shot. Character lighting is wrong for seconds at a time in one scene.
Speed is about 2 to 4 frames a second in the playable scene. `KNOWN-FAULTS.md` has the details and the evidence
behind each line.

## Credits

This project stands on other people's work. The runtime is theirs; what is ours is a line of fixes and a way of
working on top of it. If your work is here and is not named, open an issue and it will be.

- **[VIctory](https://github.com/Marvisak/VIctory)** by Marvisak (GPL-3.0-or-later): the runtime itself, from the loader and
  the console platform to the GPU host and the shader translator. Everything here builds on it, and our first rule
  (no part of the game in a commit) is its asset policy. Upstream fixes we have taken since the fork point (sampler
  LOD and bias, an anisotropic filter, a format family, rectangle interpolation) are on our working line and reach
  `next` with its next update.
- **[fxceless/victory-fork](https://github.com/fxceless/victory-fork)**: the fork both of our branches start from,
  and the home of the pull requests we studied for frame time (#144, #188, #220, #253, #457, #462, #465, #604).
  Those ideas belong to their authors; where one is merged, its commits keep their authorship.
- **[JoshuuDev/victory-amd](https://github.com/JoshuuDev/victory-amd)**: merged whole into `next`. Its view guard is
  the change that brought back the walls, ceilings and floors.
- **[Trexies/victory-fork](https://github.com/Trexies/victory-fork)** (branch `VIwork`): the fix for blending on
  integer render targets, and the translation and speed changes we are porting one by one.
- **[Leonida Continued](https://github.com/ubiquitarianism/leonida)**: read as a reference for how some console
  rules behave (buffer bounds, shared-memory rounds, ray-tracing intersection). Nothing is copied from it: where we
  follow one of its rules we write our own version and cite the commit.
- **Viewers of the stream**, who pointed us at pull requests and switches worth trying.

How credit is kept in the code: merged forks keep their own commits and authors in `next`'s history, and a change
ported by hand names the commit it came from in its message.

## Licence

Everything in this repository (the harness, the instructions, the known-faults page and the issue files) is under
the GNU General Public License, version 3 (`LICENSE`), the same licence as the runtime. Contributions are
accepted under it.

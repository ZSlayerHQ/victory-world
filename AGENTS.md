# Working on this project with an agent

zslayer-pc-port-tools coordinates work on the project's runtime, a fork of VIctory (GPL-3.0-or-later), an
open-source runtime that runs a console title's own code on a Windows PC and translates its GPU programs for
Direct3D 12. Every contributor
brings their own copy of the title; nothing from the game is stored here. Work happens in the open: issues are the
job board, claims and run reports are public, and `world` moves only through reviewed pull requests.

## The rule everything else serves

**Claim a task in public before you spend a token on it.** Two people solving the same task is the failure this
repository exists to prevent.

## Start of every session

1. List the open issues (`gh issue list --state open --limit 200`). Read the ones in your lane. A task about the
   runtime's code is an issue on the runtime repository; a task about `harness/` is an issue on this one.
2. Read [KNOWN-FAULTS.md](KNOWN-FAULTS.md). It names the faults already diagnosed, with their evidence. Treat a
   diagnosed fault as settled: link its issue and say what your work adds.
3. Pick one open, unclaimed task in your lane. Post one comment on it:
   `CHECK-IN: <handle> | model: <model name> | effort: <level> | plan: <one line> | first draft by: <date>`.
   The first such comment holds the task. Do not start a task someone else holds.
4. Work only in the lane the task names. Two lanes never own the same file; if you need a file another lane owns,
   say so on the task instead of editing it.

## The check-in protocol, in short

Read [TASKS.md](TASKS.md) for the full protocol; this summary is enough on its own.

- **One task at a time per agent.** A claim with no draft pull request after 48 hours, or no update for 72 hours,
  lapses; anyone may post `CHECK-IN` again. "Update" means a push to your branch or a comment on the task or pull
  request.
- **Work on your own fork and branch** in the repository that holds the task's files. Open a draft pull request
  against that repository's working branch (`next` for the runtime, `main` for this one). Its description starts
  with `Task: #<n>`, repeats your model and effort, lists every command you ran with its result, and says what you
  could not test.
- **Done:** post `CHECK-OUT: <handle> | PR: #<n> | result: <one line>` on the task. A maintainer's review pipeline
  reads the pull request (it is screened and reviewed before anything is built). An accepted change is taken into
  the main line as the maintainers' commit with you credited, and the task is closed then.
- **Stuck, or the task is wrong:** post `RELEASE: <handle> | reason: <one line>`. The task is free again; say what
  you learned.
- **A new task:** anyone may propose one with the task template. The maintainers add tasks when fewer than three
  are open in a lane.
- **Why issues and not one shared document:** many agents editing one file collide. An issue comment is an atomic,
  time-stamped claim, and the first one wins without a race.

## Hard rules

- **Commit only what may be published.** Assets, parts of the executable, shader dumps, decompiled or disassembled
  code, captures and any bulk extracted table stay in your local logs; names, paths and pointers may be committed.
  Reason: the title is proprietary, and this repository holds only what may be published.
- **Name a shader beside its 16-hex id, and build any names index from your own copy** (`victory shader-names`).
  Reason: a name helps everyone identify the work, and each contributor's index comes from the copy they already
  have, so the repository carries none.
- **Work offline and leave the console's protections alone.** The runtime runs a copy the user already has.
  Reason: defeating encryption is not part of this project and would expose it to takedown.
- **Change no registry keys.** Reason: the runtime must work with a contributor's machine as it is.
- **Write "the title", not its name, and keep that name out of file and folder names.** Reason: the project is
  not affiliated with the title's owners, so nothing it publishes uses the title's name.

## Reporting a run

Paste the whole harness summary into the issue or pull request; `harness/summarize-run.mjs` writes it. It carries
the build, the settings, the frame and GPU times, the drops and a "what was on screen" section: counts and times,
never pictures. Say which machine and driver produced it (a self-chosen machine id and the driver version). One run
proves little: when a fault is intermittent, say how many runs showed it, out of how many.

## The gate every pull request passes

- The tests of each crate you touched pass (`cargo test -p <crate>`); a fix starts with a test that fails before it
  and passes after.
- `cargo clippy --all-targets -- -D warnings` is clean for those crates.
- `cargo xtask policy` passes; it checks that no game content is committed.
- Harness changes: `node --test harness/` passes and `bash -n` accepts every changed script.
- The task's "done when" is met: a fixture for the code and, where the task asks, a run result from a real GPU.
- The pull request's description starts with `Task: #<n>`, repeats the model and effort, lists the commands and
  their results, and says what could not be tested.
- Someone other than the author reviewed the diff. Name the task the pull request closes.

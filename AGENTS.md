# Working on this project with an agent

zslayer-pc-port-tools coordinates work on the project's runtime, a fork of VIctory, an open-source runtime that
runs a console title's own code on a Windows PC and translates its GPU programs for Direct3D 12. Every contributor
brings their own copy of the title; nothing from the game is stored here. Work happens in the open: issues are the
job board, claims and run reports are public, and `world` moves only through reviewed pull requests.

## The rule everything else serves

**Claim a job in public before you spend a token on it.** Two people solving the same issue is the failure this
repository exists to prevent.

## Start of every session

1. List the open issues (`gh issue list --state open --limit 200`). Read the ones in your lane.
2. Read [KNOWN-FAULTS.md](KNOWN-FAULTS.md). It names the faults already diagnosed, with their evidence. Treat a
   diagnosed fault as settled: link its issue and say what your work adds.
3. Pick one unclaimed issue. Comment on it with your name and the branch you will push, assign yourself, and open a
   draft pull request before you change code. A claim with no push for 24 hours is free again: the next claimant
   comments why and takes it.
4. Work only in the lane the issue names. Two lanes never own the same file; if you need a file another lane owns,
   say so on the issue instead of editing it.

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
- The issue's "done when" is met: a fixture for the code and, where the issue asks, a run result from a real GPU.
- Someone other than the author reviewed the diff. Name the issue the pull request closes.

# 56 — Answer --help before the recorder check

- **Title:** Answer --help before the recorder check
- **Lane:** Tools and harness
- **Goal:** `world-run.sh` checks whether the streaming recorder is running before it answers `--help`, so a contributor cannot read the usage while recording. Move the help answer ahead of that check: `--help` starts nothing, so the recorder is irrelevant to it.
- **Where the code is:** `harness/world-run.sh` (the `REAL_GPU` and `tasklist` block, and the `--help` loop after it); `harness/world-run.test.mjs` (the wrapper's tests); `harness/obs.test.mjs` (the check's spelling).
- **Files owned:** `harness/world-run.sh`, `harness/world-run.test.mjs`
- **Symptom:** With the recorder open, `bash harness/world-run.sh --help` exits 3 with the recorder refusal instead of printing usage. Every other refusal in `run-world.sh` already answers help first.
- **Evidence:** The `tasklist` check sits above the `for A in "$@"` help loop in `world-run.sh`.
- **Ruled out:** The run lock; the WARP path; the inner script's help handling.
- **Done when:** A test puts a fake `tasklist` on `PATH` that reports the recorder, runs `world-run.sh --help`, and gets exit 0 and the usage; a real run without `--help` still refuses. `node --test harness/world-run.test.mjs harness/obs.test.mjs` and `bash -n harness/world-run.sh` pass.
- **Test:** `harness/world-run.test.mjs`: a temporary `tasklist` script and a temporary capture folder; no game and no lock.
- **Out of scope:** The recorder's own help; the run lock; the WARP switch.
- **Size:** S
- **Needs:** none.

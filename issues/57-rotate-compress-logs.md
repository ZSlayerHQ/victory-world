# 57 — Rotate and compress old run logs

- **Title:** Rotate and compress old run logs
- **Lane:** Tools and harness
- **Goal:** The logs folder grows without limit (1.2 GB in 407 files at the last audit, one log of 112 MB). Add a tool that compresses old run logs and their summaries, keeps the newest and any log still cited, verifies each archive before removing the original, and never touches a run in progress.
- **Where the code is:** a new `harness/rotate-logs.mjs` and `harness/rotate-logs.test.mjs`; `harness/disk-guard.mjs` if a scheduled check belongs there; `harness/run-world.sh` names the folder as `$TOOLS/logs`.
- **Files owned:** the new script and test; `harness/disk-guard.mjs` only if it calls the tool
- **Symptom:** No rotation. Old logs stay uncompressed; the disk guard sees the total only when it is too late.
- **Evidence:** The logging audit's finding 20: 1.2 GB in 407 files, one of 112 MB; compress logs older than a day and keep the ones a run report cites.
- **Ruled out:** Deleting logs; uploading them; changing the log format.
- **Done when:** `node --test harness/rotate-logs.test.mjs` passes; `node harness/rotate-logs.mjs --dry-run <dir>` lists what it would compress and why; on a temporary folder with old and new logs, the old ones become `.gz` (a round-trip read matches) and the newest and the keep-listed stay; a folder with `run.lock` is refused. `node --test harness/` passes.
- **Test:** The new test: temporary folders, fixed modification times, a keep list, a lock file, and a gzip round trip.
- **Out of scope:** The disk guard's thresholds; the summary format; deleting anything.
- **Size:** S
- **Needs:** none.

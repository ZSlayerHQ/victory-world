# 55 — Make the load line's builder count truthful

- **Title:** Make the load line's builder count truthful
- **Lane:** Tools and harness
- **Goal:** The load line's `builders` figure can read zero while compilers run, because a failed or partial process query is reported as zero. Make the count cover the compiler processes a build starts and distinguish "none running" from "could not tell", so `--require-quiet` cannot pass on a busy machine.
- **Where the code is:** `harness/load-line.mjs`: `BUILDER_NAMES`, `countBuilders`, `processNamesFromTasklist`, `processNames`, `sample`, `formatLoadLine`, `LOAD_LINE_RE`, `loadFailures`; `harness/parse-run.mjs` and `harness/summarize-run.mjs` read the line.
- **Files owned:** `harness/load-line.mjs`, `harness/load-line.test.mjs`, `harness/parse-run.mjs`, `harness/parse-run.test.mjs`, `harness/summarize-run.mjs`, `harness/summarize-run.test.mjs`
- **Symptom:** A process query that fails returns an empty list, which `countBuilders` turns into 0. A build in progress can then look quiet. The count also misses names a build starts.
- **Evidence:** `processNames` returns the fallback answer or an empty list; `sample` always writes a number. The tests use made-up names, not a query that fails.
- **Ruled out:** The CPU and memory figures; the run lock; changing the thresholds' defaults.
- **Done when:** A test stubs a process list from a build tree and sees the count; a test stubs a failed query and sees `?` on the line, with `--require-quiet` refusing rather than passing; the parser and summary tests cover both. `node --test harness/` and `bash -n` pass. During a `cargo build` of the runtime, `node harness/load-line.mjs start --seconds 0` prints a count above zero.
- **Test:** `harness/load-line.test.mjs`, with injected process lists and a query that fails; `parse-run` and `summarize-run` tests for the new `?`.
- **Out of scope:** The sampling interval; the thresholds; the run itself.
- **Size:** M
- **Needs:** none; a runtime build to see a positive count.

# 32 — Snapshot a repeated list's records after each execution

- **Title:** Snapshot a repeated list's records after each execution
- **Lane:** Tools and harness
- **Files owned:** crates/victory-gpu/src/host.rs
- **Symptom:** When a list is repeated in one submission and each execution is timed and fenced separately, its buffer is snapped only after all groups, so both timing lines describe the last run.
- **Evidence:** Review of the landing, second look, new fault 3.
- **Ruled out:** —
- **Done when:** For a repeated list, the snapshot is taken after each execution's fence and before the list is reissued; a test covers two executions with different records.
- **Size:** S

# 21 — The GPU test binary's access violation

- **Title:** Find the GPU test binary's access violation
- **Lane:** Tools and harness
- **Files owned:** to be confirmed by the lead
- **Symptom:** the runtime's GPU test binary dies with an access violation about one run in five to ten. It has not been tied to a fault in the runtime.
- **Evidence:** several test runs on one machine; no reproduction yet.
- **Ruled out:** —
- **Done when:** a minimal reproduction (or a guard that turns the violation into a test failure with a name), and the suite runs ten times in a row without a crash.
- **Size:** S

# 10 — Make the exact masked wave forms the default

- **Title:** Make the exact masked wave forms the default
- **Lane:** Shaders to 100% (61 of 25,758 programs still refused; picture faults)
- **Files owned:** the wave lowering (`crates/victory-shader/src/emit`)
- **Symptom:** the approximate 32-lane lighting form offers each half-wave only the lights its own half found, so a character can go black for seconds, wear a hard orange band across the head, or show black or white eyes.
- **Evidence:** run `fork-caption` at 2:48 and 9:52; at commit `24c762c9` the exact form is behind `VICTORY_WAVE_WIDE=masks`: its fixture passes while the approximate form's fixture fails as written. It has not been seen in a game run.
- **Ruled out:** —
- **Done when:** a game run with the exact form keeps the character lit through a later room's exit; the run summary reports the cost against the approximate form.
- **Size:** M

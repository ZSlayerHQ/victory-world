# 23 — A character's forearms render as coloured noise

- **Title:** A character's forearms render as coloured noise
- **Lane:** Shaders to 100% (61 of 25,758 programs still refused; picture faults)
- **Files owned:** crates/victory-shader, to be confirmed by the lead
- **Symptom:** A character's forearms show coloured noise where tattoo or decal layers sit over skin.
- **Evidence:** The newest run's sheets, character close-ups. The tattoo-bake pass and the skin's decal pass translate and run; the generic decal effects build their colour passes too.
- **Ruled out:** Translation failures in the tattoo and decal effects: none failed or were refused in the newest run.
- **Done when:** A capture shows whether the decal layer reads a texture whose upload was skipped, and a run shows the noise gone.
- **Size:** M

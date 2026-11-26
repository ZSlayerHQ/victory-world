# 24 — Orange noise through interior windows

- **Title:** Orange noise through interior windows
- **Lane:** Shaders to 100% (61 of 25,758 programs still refused; picture faults)
- **Files owned:** crates/victory-gpu, crates/victory-shader, to be confirmed by the lead
- **Symptom:** Orange noise shows through interior windows where see-through glass and interior materials are drawn.
- **Evidence:** Sheets from an interior scene. Every glass and interior colour pass in the newest run translates and runs. The only refused shader on the see-through path is the alpha-transmission prefilter (the mip prefilter of the alpha-transmission buffer), refused at pipeline creation with E_INVALIDARG.
- **Ruled out:** Shader translation of the glass and interior effects themselves.
- **Done when:** A run with the prefilter translated shows the windows clean, or a capture names another pass that draws the noise.
- **Size:** M

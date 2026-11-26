# 22 — Skin on characters' arms is grey-green while faces are right

- **Title:** Skin on characters' arms is grey-green while faces are right
- **Lane:** Shaders to 100% (61 of 25,758 programs still refused; picture faults)
- **Files owned:** crates/victory-shader, to be confirmed by the lead
- **Symptom:** Skin on characters' arms renders grey-green in interior scenes while their faces are right.
- **Evidence:** A 20-minute session's 148 sheets, from several interior rooms. The project's shader map over the newest run shows the skin, cloth and subsurface effects translating and running, with no failed or refused shader among them.
- **Ruled out:** Shader translation and refusals: every skin and subsurface pass that ran translated cleanly.
- **Done when:** A capture names the pass and the value where the arms' colour departs from the face's, and a recorded run shows them match.
- **Size:** M

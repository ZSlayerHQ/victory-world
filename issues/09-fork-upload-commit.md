# 09 — Take the adopted fork's newer upload commit

- **Title:** Take the adopted fork's newer texture-upload commit (`310c6eb6`)
- **Lane:** Native memory (moving off the console's shared memory model)
- **Files owned:** what commit `310c6eb6` touches (texture upload handling, about 1,800 lines)
- **Symptom:** the adopted fork pushed a newer commit after the base this project took; it changes how texture uploads are handled and has not been run here.
- **Evidence:** commit `310c6eb6` on the adopted fork; the base is `c96b4f2b`.
- **Ruled out:** —
- **Done when:** the commit applies, the texture and pipeline suites pass, and one game run shows no texture regression; its summary is pasted.
- **Size:** M

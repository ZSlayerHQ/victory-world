# 02 — Trace what feeds the title's room decision

- **Title:** Trace the inputs of the title's room and portal decision
- **Lane:** Native memory (moving off the console's shared memory model)
- **Files owned:** to be confirmed by the lead
- **Symptom:** the title treats the playable room as viewed from outside and sets a scissor rectangle exactly over the window opening, so the room's own geometry is cut. Something the runtime hands back — a read-back, a stale buffer, a timing — makes that decision wrong.
- **Evidence:** run `fork-essentials`, frames 3651 and 3851, one rectangle (x 548 to 1753, y 0 to 1334) set on 432 and 1,919 G-buffer and depth operations; run `fork-cell-walls`, frame 2693, the same building from outside has a full-width rectangle and a whole shell.
- **Ruled out:** the title's decision failing on its own (the exterior shot of the same building is right), and everything the other three walls jobs have excluded.
- **Done when:** a trace names the value the decision reads and the pass of ours that writes it; a fixture reproduces a wrong decision from that input; a game run with the fix shows walls in the playable room.
- **Size:** L

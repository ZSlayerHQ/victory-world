# Issue board status

State of issues 1 to 21 against the runtime's `next` branch, as of 2026-11-25. "On next" means the change is in
that branch; "needs confirming" means no run on a second GPU has shown it yet. This is a draft for the lead to
correct before filing.

| Issue | State on next | What is needed |
|---|---|---|
| 01 — view guard | On next: it drew the missing walls in three launches of three | Confirming on another GPU |
| 02 — room decision inputs | Open | A trace of what feeds the room decision |
| 03 — scissor run | Open | The scissor test, both frames captured |
| 04 — mesh index mask | On next | Confirming on another GPU |
| 05 — yard shard and sky spikes | Open | A capture that names the geometry |
| 06 — stage and detile present mips | On next | Confirming on another GPU |
| 07 — spans and lost views | On next | Confirming on another GPU |
| 08 — mip-less tiling | On next | Confirming on another GPU |
| 09 — fork upload commit | On next | Confirming on another GPU |
| 10 — exact wave forms default | Not on next: it lives on a held branch | Review, then a game run with it |
| 11 — LDS bound | Open | A fix and a fixture |
| 12 — several thread groups | Partial: four forms translate on the held branch; three programs still have no form | The remaining three, with a fixture |
| 13 — integer render targets | On next: the integer-target pipeline is made and drawn | Confirming on another GPU |
| 14 — cutscene white-out | Partial: most of the white is gone; the shop scene has its own faults (issues 25 and 26) | A run that shows what white remains |
| 15 — screen-filling triangles | Open | A run that shows whether they still appear |
| 16 — cutscene memory waits | Open | A fix and a recorded cutscene |
| 17 — read-back wait | Open: a speed branch with three changes is prepared, each off by default | A recorded before-and-after run |
| 18 — pipeline wait | On next: the wait is a 12 s window per kind | Confirming on another GPU |
| 19 — caption GPU number | Needs checking: the caption now reports a card wait | A run that confirms the number's meaning |
| 20 — builder drops counted | On next: the frame line names the builder's stage | Confirming on another GPU |
| 21 — GPU test crash | Open: the tests run one at a time | A fix for the access violation |

The multi-wave work appears in two places on purpose: issue 10 is what runs by default, issue 12 is the programs
that still need a form.

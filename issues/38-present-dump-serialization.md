# 38 — Serialize present selection and the texture-state round trip for target dumps

- **Title:** Serialize present selection and the texture-state round trip for target dumps
- **Lane:** Tools and harness
- **Files owned:** crates/victory-gpu/src/capture.rs, crates/victory-gpu/src/queue.rs, crates/victory-gpu/src/resource.rs
- **Symptom:** A concurrent present can publish the copy-source state before its GPU transition is queued, so a target dump can skip the required source barrier; a later present reaching frame selection first can also discard the earlier frame's targets.
- **Evidence:** Review of the landing, second look, finding 9 (partly), and the fourth look's follow-up list.
- **Ruled out:** —
- **Done when:** Frame selection is serialized with present numbering, and the present's state round trip is recorded and submitted under the submission lock; failing that, target dumps stay disabled for landing.
- **Size:** M

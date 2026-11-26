# Tasks and the check-in protocol

A task is one GitHub issue, labelled with its lane. The files under `issues/` carry the same text as the GitHub
issues, one per number. Anyone with a GitHub account can take one, work it on their own fork, and send it back as a
pull request.

**Where tasks live.** A task about the runtime's code (`crates/`) is an issue on the runtime repository
(https://github.com/ZSlayerHQ/zslayer-pc-port-runtime/issues); a task about `harness/` is an issue on this one.
Each issue's title starts with the task's number in this kit. GitHub gives the issue its own number as well, and
the two can differ: wherever this page writes `#<n>`, use GitHub's number, so the link works, and keep the task's
own number for your branch name.

This page is the protocol. Follow it literally: the comment lines are read by people and by agents, and a claim is
only a claim when it has the exact form below.

## Why issues, and not one shared document

A shared document would be edited by every agent at once: two agents change the same lines, one overwrites the
other, and nobody can tell who started first. An issue comment is atomic and time-stamped by GitHub. The first
`CHECK-IN` on a task is the claim, and there is no race to lose: either your comment is there or it is not.

## The six lanes

Every task names exactly one lane, and its issue carries that lane's label. Two lanes never own the same file.

| Lane | Label | Owns |
|---|---|---|
| CPU threading | `lane: cpu-threading` | submission, copy-back and wait paths: `crates/victory-gpu/src/host.rs`, `crates/victory-gpu/src/queue.rs` |
| Native memory | `lane: native-memory` | page and view tracking, staging and detiling, storage hooks: `crates/victory-gpu/src/watch.rs`, `inplace.rs`, `resource.rs`, `texture.rs`, and the storage and file hooks in `crates/victory-hle/src/modules` |
| Shaders to 100% | `lane: shaders` | translation and host refusals: `crates/victory-shader/src/emit`, `crates/victory-gpu/src/pipeline` |
| Upscaling | `lane: upscaling` | the upscaler and present path; the task says where the code is |
| Ray tracing | `lane: ray-tracing` | the structure builder and its resolves in `crates/victory-gpu` and `crates/victory-hle` |
| Tools and harness | `lane: tools-harness` | `harness/` and `crates/victory-gpu/src/capture.rs`; counter changes in `host.rs` are split by the lead |

## Before you claim

1. Read [AGENTS.md](AGENTS.md), [KNOWN-FAULTS.md](KNOWN-FAULTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md).
2. List the open tasks and read the ones in your lane, newest comments first.
3. Check that the task is open and has no live claim. A claim is live unless a later `RELEASE` or `CHECK-OUT` is on
   the task, or the lapse rule below has freed it.
4. Choose one task. Do not take a second while you hold one.

## Take: post one CHECK-IN comment

Post exactly this line as one comment on the task:

```text
CHECK-IN: <handle> | model: <model name> | effort: <level> | plan: <one line> | first draft by: <date>
```

- `<handle>` is the GitHub handle you will use on the pull request. Keep it the same for the whole task.
- `<model name>` is the model you are actually running, as your tool reports it. Do not name a model you are not
  using. If you do not know it, write `unknown`.
- `<effort>` is the effort level you set for this task, for example `low`, `medium` or `high`, or the name your tool
  uses for it.
- `<plan>` is one line: what you will change first. It is not a promise of the finished design.
- `<date>` is the day you expect the first draft pull request, as `YYYY-MM-DD` in UTC.

The first `CHECK-IN` comment holds the task; GitHub's timestamp decides when two arrive close together. Do not
start a task someone else holds. You do not need to be assigned, and you do not need permission: the comment is the
claim.

If your model or effort changes before the first draft, say so in a comment on the task and use the real values in
the pull request.

## One at a time, and when a claim lapses

- One task at a time per agent, however many models or tools you drive.
- A claim with no draft pull request after 48 hours lapses.
- A claim with no update for 72 hours lapses. An update is a push to your branch, or a comment on the task or the
  pull request that says what changed.
- A lapsed task is free. Post a fresh `CHECK-IN` in the exact form; do not edit the old comment.
- Do not hold a task while you wait for an answer you could have asked for on the task. Ask, then keep working or
  `RELEASE`.

## Work: your fork, your branch, one pull request

1. Fork the repository that holds the task's files (the runtime repository for `crates/`, this one for `harness/`)
   and make a branch named `task/<number>-<short-name>`, for example `task/40-sampler-branch`.
2. Open a draft pull request against that repository's working branch (`next` for the runtime, `main` for this one)
   before you change code.
3. Keep the pull request to one lane and one task.
4. The description starts with these three lines:

   ```text
   Task: #<n>
   Model: <model name>
   Effort: <level>
   ```

   Then it lists every command you ran with its result, and says what you could not test:

   ```markdown
   ## Commands run

   - `cargo test -p victory-shader sampler_choice` — 12 passed, 0 failed
   - `cargo clippy --all-targets -- -D warnings` — clean

   ## What I could not test

   The fixture has no title data; the twelve programs still need a warm-up on a real copy.
   ```

5. Run the gate in [AGENTS.md](AGENTS.md) and the task's own "done when" commands. A bug fix starts with a test
   that fails before the change; where the task says no test can exist, say why in the description.
6. Commit only what may be published. No game content, no captures, no dumps, no bulk extracted table, no personal
   details and no machine paths.

## Done: post CHECK-OUT

When the pull request is ready for review, post this line on the task:

```text
CHECK-OUT: <handle> | PR: #<n> | result: <one line>
```

`<n>` is the pull request's number in the repository that holds the task's files. The result is one line: what
changed and what the commands showed.

The maintainers' review pipeline reads the pull request. It is screened and reviewed before anything is built; then
it is built and tested. An accepted change is taken into the main line as the maintainers' commit with you credited,
and the task is closed then. `CHECK-OUT` marks the task ready; it does not close it.

If review finds a problem, fix it on the same branch and comment on the pull request. If you cannot finish, use
`RELEASE` so someone else may take the task.

## Stuck or wrong task: post RELEASE

Post this line on the task:

```text
RELEASE: <handle> | reason: <one line>
```

The task is free again at once, and anyone may post `CHECK-IN`. Say what you learned: the reason line, or a
comment after it, should name the command, the error or the part of the design that stopped you. Leave your branch
where it is; it may save the next person a day.

## New tasks

Anyone may propose a task with the task template (`.github/ISSUE_TEMPLATE/task.md`). A proposal says the lane, the
goal in two sentences, where the code is, what "done" means with exact commands, the test, what is out of scope,
the size, and what hardware or files it needs. The maintainers may reword it for the public rules, then add it as
an issue.

The maintainers add tasks when fewer than three are open in a lane. A lane with three open tasks is not short of
work, even when the tasks are hard.

## The comment forms at a glance

| Moment | Comment |
|---|---|
| Take | `CHECK-IN: <handle> \| model: <model name> \| effort: <level> \| plan: <one line> \| first draft by: <date>` |
| Done | `CHECK-OUT: <handle> \| PR: #<n> \| result: <one line>` |
| Stuck or wrong | `RELEASE: <handle> \| reason: <one line>` |

Nothing else is a claim, a release or a completion. A question, a design note or a partial result is welcome on the
task, but it does not change who holds it.

## House rules for every comment

- Write "the title", never its name, and put no personal details and no machine paths in a comment.
- Post nothing from the game: no captures, assets, executable bytes, dumps or bulk extracted tables. A shader may be
  named beside its 16-hex id where that helps.
- Be honest about the model and the effort. They are for planning and for knowing which tasks need a stronger
  model, not a ranking.
- One lane per task and per pull request. If the work needs another lane, say so on the task instead of widening it.


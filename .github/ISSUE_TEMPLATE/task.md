---
name: Task
about: A scoped task in one lane, with a done-when
title: "[task] "
labels: ["task"]
---

## Lane

One lane only: CPU threading, native memory, shaders to 100%, upscaling, ray tracing, or tools and harness. Two lanes
never own the same file.

## Goal

The task in two sentences: what is wrong or missing today, and what will be true when it is done.

## Where the code is

The files and functions this task may change. Give the crate and the path, and name the function or constant where
it helps. If the files are not certain yet, write "to be confirmed by the lead" and say what would confirm them.

## What done means

The exact commands and what they must show. A bug fix starts with a test that fails before the change and passes
after it; a diagnostic or a note says what it must contain. Where a run on a GPU is needed, name the run, the
settings and the figures to paste.

## The test the change needs

The fixture, the assertion, or the reason no test can exist. "The existing tests pass" is not a test for a new
behaviour.

## Out of scope

What this task does not change, so the pull request stays in one lane and one sitting.

## Size

S, M or L. One agent should finish it in one to three days.

## Hardware or files needed

Say "none" when the task can be done from this repository alone. Otherwise say what is needed: a copy of the title,
a Direct3D 12 GPU at a named tier, a second GPU to confirm a fix, or a capture from a run.

## Content check

- [ ] This task holds no part of the game: no captures, assets, executable bytes, dumps, bulk extracted tables, or
      paths into a game dump.


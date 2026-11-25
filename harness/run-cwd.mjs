#!/usr/bin/env node
// Chooses the working folder a run starts `victory` from: never inside a git work tree (the runtime's data guard
// refuses to start the title there), and the same folder for everything that resolved relative to it before.
//
//   node harness/run-cwd.mjs choose --bin <victory.exe> --lane <VICTORY_DIR> --capture <dir>
//   node harness/run-cwd.mjs check <folder>          (exit 1 with one line when the folder is in a work tree)
//
// The choice: the binary's folder when it is outside every repository (a snapshot under /snapshots/), then
// the lane when it is; otherwise a `cwd/` folder under the run's capture folder, which lives outside every repo.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/// The first folder at or above `target` that holds a `.git` entry (a directory or a worktree's file), or null.
export function workTreeOf(target) {
  let at = path.resolve(target);
  for (;;) {
    if (fs.existsSync(path.join(at, '.git'))) return at;
    const up = path.dirname(at);
    if (up === at) return null;
    at = up;
  }
}

/// One clear line for the guard, or null when the folder is outside every work tree.
export function refusal(folder) {
  const tree = workTreeOf(folder);
  return tree === null ? null : `the working folder ${folder} is inside the git work tree ${tree}`;
}

/// The working folder for a run: the binary's folder or the lane when it is outside a work tree, else a fresh
/// `cwd` under the capture folder. `create` makes the chosen folder (and only a folder it names).
export function choose({ bin, lane, capture }, create = fs.mkdirSync) {
  const candidates = [bin ? path.dirname(bin) : null, lane ?? null];
  for (const candidate of candidates) {
    if (candidate && workTreeOf(candidate) === null) {
      create(candidate, { recursive: true });
      return candidate;
    }
  }
  const folder = path.join(capture, 'cwd');
  create(folder, { recursive: true });
  return folder;
}

function usage() {
  console.error('usage: node harness/run-cwd.mjs choose --bin <victory.exe> --lane <VICTORY_DIR> --capture <dir>');
  console.error('       node harness/run-cwd.mjs check <folder>');
}

function main(argv) {
  const [what, ...rest] = argv;
  if (what === 'check') {
    if (rest.length !== 1) {
      usage();
      return 2;
    }
    const text = refusal(rest[0]);
    if (text) {
      console.error(`run-cwd: ${text}`);
      return 1;
    }
    return 0;
  }
  if (what !== 'choose') {
    usage();
    return 2;
  }
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--bin') options.bin = rest[++i];
    else if (rest[i] === '--lane') options.lane = rest[++i];
    else if (rest[i] === '--capture') options.capture = rest[++i];
    else {
      console.error(`run-cwd: unknown argument ${rest[i]}`);
      return 2;
    }
  }
  if (!options.capture) {
    usage();
    return 2;
  }
  const folder = choose(options);
  const text = refusal(folder);
  if (text) {
    console.error(`run-cwd: ${text}`);
    return 1;
  }
  console.log(folder);
  return 0;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));

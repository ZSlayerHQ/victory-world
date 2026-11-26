#!/usr/bin/env node
// Where a run starts from: the dump that holds MicrosoftGame.Config, with the executable that manifest names beside
// it, and one sentence instead of a crash when either is not there.
//
//   node harness/game-dir.mjs prepare --exe <the title's executable> --stage <folder>
//                                    [--manifest <that dump's MicrosoftGame.Config>]
//   node harness/game-dir.mjs check <game_dir>
//
// `prepare` prints the executable to launch. The title reads its archives from the folder its executable sits in and
// its identity from the manifest beside it, so a dump whose executable lives in a sibling folder cannot start: the
// title id comes back 00000000, the storage quota 0 MB, title imports go missing, and System Init dies with
// `uncaught exception 0x80000003`. The README's setup steps never say the two have to be together, and three of three
// first runs on the machine that found this failed that way.
//
// Where the dump has no copy of the executable, `prepare` hardlinks every file of the dump and the executable into
// `<stage>/<the dump's folder name>` and launches from there. Hardlinks, never copies: the install is over a hundred
// gigabytes and a copy allocates it a second time. A source on another volume refuses, because a hardlink cannot
// cross one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/// The manifest that gives the title its id, its storage quota and the name of its executable.
export const MANIFEST = 'MicrosoftGame.Config';

/// The executable a manifest names, or null when it names none.
export function executableName(text) {
  const list = /<ExecutableList>([\s\S]*?)<\/ExecutableList>/i.exec(String(text));
  const body = list ? list[1] : String(text);
  const name = /<Executable\b[^>]*?\bName\s*=\s*"([^"]+)"/i.exec(body);
  return name ? name[1] : null;
}

/// The volume a path is on, as Windows spells it ("c:"), for the hardlink test.
export function volumeOf(target) {
  return path.parse(path.resolve(target)).root.toLowerCase();
}

/// `dir` and the folders directly inside it.
export function foldersIn(dir) {
  const folders = [dir];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return folders;
  }
  for (const entry of entries) if (entry.isDirectory()) folders.push(path.join(dir, entry.name));
  return folders;
}

/// The dump an executable belongs to: its own folder when the manifest is there, else the one folder beside it that has
/// one. Refuses rather than guessing between two.
export function dumpFor(exe) {
  const own = path.dirname(path.resolve(exe));
  if (fs.existsSync(path.join(own, MANIFEST))) return { dir: own };
  const root = path.dirname(own);
  const found = foldersIn(root).filter((dir) => fs.existsSync(path.join(dir, MANIFEST)));
  if (found.length === 1) return { dir: found[0] };
  if (found.length === 0) {
    return {
      refusal: `refused: no ${MANIFEST} in ${own} or in a folder beside it under ${root}; set GAME_MANIFEST to the dump's manifest`,
    };
  }
  return {
    refusal: `refused: ${found.length} folders under ${root} hold a ${MANIFEST} (${found.join('; ')}); set GAME_MANIFEST to the one this run starts from`,
  };
}

/// The executable the manifest names: beside the manifest, else the one this run was pointed at, else the only copy in
/// a folder beside the dump.
export function exeFor({ dir, name, hint }) {
  const beside = path.join(dir, name);
  if (fs.existsSync(beside)) return { exe: beside };
  const named = hint ? path.resolve(hint) : null;
  if (named && path.basename(named).toLowerCase() === name.toLowerCase() && fs.existsSync(named)) {
    return { exe: named };
  }
  const root = path.dirname(dir);
  for (const folder of foldersIn(root)) {
    const at = path.join(folder, name);
    if (fs.existsSync(at)) return { exe: at };
  }
  return {
    refusal: `refused: ${path.join(dir, MANIFEST)} names ${name}, and no such file is in ${dir} or in a folder beside it under ${root}; set GAME_EXE to the executable`,
  };
}

/// What a launch needs, as one sentence when it is not there: the manifest, the name it gives, and that file.
export function preflight(dir) {
  const manifest = path.join(dir, MANIFEST);
  if (!fs.existsSync(manifest)) {
    return {
      refusal: `refused: no ${MANIFEST} in ${dir}, so the title would start with no id and no storage quota; set GAME_MANIFEST to the dump's manifest`,
    };
  }
  const name = executableName(fs.readFileSync(manifest, 'utf8'));
  if (!name) {
    return { refusal: `refused: ${manifest} names no executable; set GAME_MANIFEST to a dump whose manifest names one` };
  }
  if (!fs.existsSync(path.join(dir, name))) {
    return {
      refusal: `refused: ${manifest} names ${name}, which is not in ${dir}; set GAME_EXE to the executable wherever it lives, so it can be staged beside the manifest`,
    };
  }
  return {};
}

/// Every file under `dir`, relative to it.
function filesUnder(dir, base = dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const at = path.join(dir, entry.name);
    if (entry.isDirectory()) filesUnder(at, base, out);
    else out.push(path.relative(base, at));
  }
  return out;
}

/// True when two paths are links to the same file.
function sameFile(one, two) {
  const a = fs.statSync(one, { bigint: true });
  const b = fs.statSync(two, { bigint: true });
  return a.dev === b.dev && a.ino === b.ino;
}

/// One hardlink, made or confirmed; true when this call made it. A name already linked to the source is left alone,
/// and anything else at that name is replaced, so a second dump in a reused stage folder cannot leave an archive of
/// the first behind.
function linkOnce(from, to) {
  const there = fs.existsSync(to);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (there && sameFile(from, to)) return false;
  if (there) fs.unlinkSync(to);
  fs.linkSync(from, to);
  return true;
}

/// A folder holding every file of the dump and the executable beside its manifest, without moving or changing a byte
/// of the install.
export function stage({ dir, exe, name, at }) {
  for (const [what, from] of [['the dump', dir], ['the executable', exe]]) {
    if (volumeOf(from) !== volumeOf(at)) {
      return {
        refusal: `refused: a hardlink cannot cross volumes, and ${what} at ${from} is on ${volumeOf(from)} while ${at} is on ${volumeOf(at)}; set GAME_STAGE to a folder on the dump's volume`,
      };
    }
  }
  const staged = path.resolve(at);
  let linked = 0;
  for (const relative of filesUnder(dir)) {
    if (linkOnce(path.join(dir, relative), path.join(staged, relative))) linked += 1;
  }
  if (linkOnce(exe, path.join(staged, name))) linked += 1;
  return { dir: staged, exe: path.join(staged, name), linked };
}

/// The executable a run should launch and the dump it starts from, staging the executable when the dump lacks it.
export function prepare({ exe, manifest, stage: stageRoot }) {
  let dir = null;
  if (manifest) {
    if (!fs.existsSync(manifest)) {
      return { refusal: `refused: GAME_MANIFEST names ${manifest}, which does not exist` };
    }
    dir = path.dirname(path.resolve(manifest));
  } else {
    const dump = dumpFor(exe);
    if (dump.refusal) return dump;
    dir = dump.dir;
  }
  const manifestAt = path.join(dir, MANIFEST);
  const name = fs.existsSync(manifestAt) ? executableName(fs.readFileSync(manifestAt, 'utf8')) : null;
  if (!name) return preflight(dir);
  const beside = path.join(dir, name);
  const found = fs.existsSync(beside) ? { exe: beside } : exeFor({ dir, name, hint: exe });
  if (found.refusal) return found;
  if (path.dirname(found.exe) === dir) return { dir, exe: found.exe, staged: false };
  if (!stageRoot) {
    return { refusal: `refused: the dump at ${dir} has no ${name}, and no --stage folder was given to hardlink it in from ${found.exe}` };
  }
  const staged = stage({ dir, exe: found.exe, name, at: path.join(stageRoot, path.basename(dir)) });
  if (staged.refusal) return staged;
  const checked = preflight(staged.dir);
  if (checked.refusal) return checked;
  return { ...staged, staged: true };
}

function usage() {
  console.error('usage: node harness/game-dir.mjs prepare --exe <exe> --stage <folder> [--manifest <MicrosoftGame.Config>]');
  console.error('       node harness/game-dir.mjs check <game_dir>');
}

function main(argv) {
  const [what, ...rest] = argv;
  if (what === 'check') {
    if (rest.length !== 1) {
      usage();
      return 2;
    }
    const checked = preflight(rest[0]);
    if (checked.refusal) {
      console.error(checked.refusal);
      return 1;
    }
    return 0;
  }
  if (what !== 'prepare') {
    usage();
    return 2;
  }
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--exe') options.exe = rest[++i];
    else if (rest[i] === '--stage') options.stage = rest[++i];
    else if (rest[i] === '--manifest') options.manifest = rest[++i];
    else {
      console.error(`game-dir: unknown argument ${rest[i]}`);
      return 2;
    }
  }
  if (!options.exe || !options.stage) {
    usage();
    return 2;
  }
  const prepared = prepare(options);
  if (prepared.refusal) {
    console.error(prepared.refusal);
    return 1;
  }
  if (prepared.staged) {
    console.error(`stage: ${prepared.linked} hardlinks under ${prepared.dir}, the executable among them`);
  }
  console.log(prepared.exe);
  return 0;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));

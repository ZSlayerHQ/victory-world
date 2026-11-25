#!/usr/bin/env node
// The title's save folder as a repeatable fixture: restore a named snapshot before a run, or take one after it.
//
//   node harness/save-snapshot.mjs restore <name> --config <victory.toml> [--snapshots <dir>] [--before <dir>]
//                                                [--lock <path>] [--stamp <text>]
//   node harness/save-snapshot.mjs save-as <name> --config <victory.toml> [--snapshots <dir>]
//
// The save folder is the title's config folder below the run's data_dir: <data_dir>/<title>/saves/<user>/<config>.
// Each level must hold exactly one folder, or the command refuses and says what it found.
//
// A snapshot (snapshots/<name>/) holds the container folders as the runtime lays them out. restore copies the
// current folder to before/<stamp>-<name>/ and verifies that copy (file count and total bytes) BEFORE anything is
// removed; only then are the folder's contents replaced by the snapshot's and verified against it. A backup that
// does not verify stops the restore with the saves untouched. No file contents are ever printed.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { loadLocalEnv } from './local-env.mjs';

// Snapshots live in <root>/snapshots and before-run backups in <root>/before-runs. VICTORY_SAVE_BACKUPS overrides the
// main PC's root, from the environment or harness/local.env (local-env.mjs); --snapshots and --before override both.
export const DEFAULT_SAVE_BACKUPS = '<drive>/the title-save-backups';

export function saveBackupsRoot(env = process.env) {
  const given = String(env.VICTORY_SAVE_BACKUPS ?? '').trim().split(String.fromCharCode(92)).join('/').replace(/\/+$/, '');
  return given || DEFAULT_SAVE_BACKUPS;
}

/// The `data_dir` of a victory.toml (single- or double-quoted; a double-quoted value unescapes backslashes).
export function dataDir(configPath) {
  const text = fs.readFileSync(configPath, 'utf8');
  const single = text.match(/^\s*data_dir\s*=\s*'([^']*)'/m);
  if (single) return single[1];
  const double = text.match(/^\s*data_dir\s*=\s*"((?:[^"\\]|\\.)*)"/m);
  if (double) return double[1].replace(/\\(.)/g, '$1');
  throw new Error(`no data_dir in ${configPath}`);
}

/// The one folder at `dir`, or an error naming what is there. `what` names the level in the message.
export function oneFolder(dir, what) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch (err) {
    throw new Error(`cannot list ${what} ${dir}: ${err.message}`);
  }
  if (entries.length !== 1) {
    const names = entries.map((e) => e.name).join(', ') || 'none';
    throw new Error(`expected exactly one ${what} under ${dir}, found ${entries.length}: ${names}`);
  }
  return path.join(dir, entries[0].name);
}

/// The title's save folder for a run config.
export function saveFolder(configPath) {
  const data = dataDir(configPath);
  const title = oneFolder(data, 'title folder');
  const saves = path.join(title, 'saves');
  const user = oneFolder(saves, 'user folder');
  return oneFolder(user, 'config folder');
}

/// A folder's file count and total bytes, recursively.
export function measure(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (at) => {
    for (const entry of fs.readdirSync(at, { withFileTypes: true })) {
      const full = path.join(at, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) {
        files += 1;
        bytes += fs.statSync(full).size;
      } else throw new Error(`not a plain file or folder: ${full}`);
    }
  };
  walk(dir);
  return { files, bytes };
}

const same = (a, b) => a.files === b.files && a.bytes === b.bytes;
const say = (m) => `${m.files} files, ${m.bytes} bytes`;

/// Copies `from`'s contents into `to` (which is made), then verifies the copy against the source.
export function copyVerified(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from)) {
    fs.cpSync(path.join(from, entry), path.join(to, entry), { recursive: true });
  }
  const source = measure(from);
  const copy = measure(to);
  if (!same(source, copy)) {
    throw new Error(`the copy of ${from} in ${to} does not match: ${say(source)} against ${say(copy)}`);
  }
  return copy;
}

export function restore(name, options = {}) {
  const snapshots = options.snapshots ?? `${saveBackupsRoot()}/snapshots`;
  const before = options.before ?? `${saveBackupsRoot()}/before-runs`;
  const lock = options.lock ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'run.lock');
  // The run that restores for itself holds the lock already (world-run.sh takes it before anything else): only
  // another run's lock refuses.
  if (!options.callerHoldsLock && fs.existsSync(lock)) {
    throw new Error(`refusing while ${lock} exists: a run holds the harness lock`);
  }
  const snapshot = path.join(snapshots, name);
  if (!fs.existsSync(snapshot) || !fs.statSync(snapshot).isDirectory()) {
    const names = fs.existsSync(snapshots)
      ? fs.readdirSync(snapshots).filter((n) => fs.statSync(path.join(snapshots, n)).isDirectory())
      : [];
    throw new Error(`no snapshot '${name}'; snapshots: ${names.join(', ') || 'none'}`);
  }
  const folder = saveFolder(options.config);
  const stamp = options.stamp ?? new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').replace('Z', '');
  const backup = path.join(before, `${stamp}-${name}`);
  if (fs.existsSync(backup)) throw new Error(`the backup ${backup} already exists: refusing to overwrite it`);

  // 1. Copy the current save folder whole and verify it. Until this succeeds, nothing is removed.
  const backedUp = copyVerified(folder, backup);

  // 2. Only now replace the folder's contents with the snapshot's.
  try {
    for (const entry of fs.readdirSync(folder)) {
      fs.rmSync(path.join(folder, entry), { recursive: true });
    }
    for (const entry of fs.readdirSync(snapshot)) {
      fs.cpSync(path.join(snapshot, entry), path.join(folder, entry), { recursive: true });
    }
    const want = measure(snapshot);
    const got = measure(folder);
    if (!same(want, got)) {
      throw new Error(`the restore does not match the snapshot: ${say(want)} wanted, ${say(got)} there`);
    }
  } catch (err) {
    throw new Error(
      `restore of '${name}' failed after the backup: ${err.message}; the previous save is in ${backup}`,
    );
  }
  return { folder, backup, files: backedUp.files, bytes: backedUp.bytes };
}

export function saveAs(name, options = {}) {
  const snapshots = options.snapshots ?? `${saveBackupsRoot()}/snapshots`;
  if (!/^[A-Za-z0-9._-]+$/.test(name)) throw new Error(`'${name}' is not a plain snapshot name`);
  const snapshot = path.join(snapshots, name);
  if (fs.existsSync(snapshot)) throw new Error(`the snapshot '${name}' already exists: refusing to overwrite it`);
  const folder = saveFolder(options.config);
  const copied = copyVerified(folder, snapshot);
  return { folder, snapshot, files: copied.files, bytes: copied.bytes };
}

function usage() {
  console.error(
    'usage: save-snapshot.mjs restore <name> --config <victory.toml> [--snapshots <dir>] [--before <dir>] [--lock <path>] [--caller-holds-lock] [--stamp <text>]',
  );
  console.error('       save-snapshot.mjs save-as <name> --config <victory.toml> [--snapshots <dir>]');
}

async function main(argv) {
  loadLocalEnv();
  const [what, name, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--config') options.config = rest[++i];
    else if (arg === '--snapshots') options.snapshots = rest[++i];
    else if (arg === '--before') options.before = rest[++i];
    else if (arg === '--lock') options.lock = rest[++i];
    else if (arg === '--caller-holds-lock') options.callerHoldsLock = true;
    else if (arg === '--stamp') options.stamp = rest[++i];
    else {
      console.error(`save-snapshot: unknown argument ${arg}`);
      usage();
      return 2;
    }
  }
  if (!['restore', 'save-as'].includes(what) || !name || !options.config) {
    usage();
    return 2;
  }
  try {
    if (what === 'restore') {
      const done = restore(name, options);
      console.log(`restored '${name}' into ${done.folder} (${say({ files: done.files, bytes: done.bytes })} backed up to ${done.backup})`);
    } else {
      const done = saveAs(name, options);
      console.log(`saved '${name}' from ${done.folder} into ${done.snapshot} (${say({ files: done.files, bytes: done.bytes })})`);
    }
    return 0;
  } catch (err) {
    console.error(`save-snapshot: ${err.message}`);
    return 1;
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

#!/usr/bin/env node
// The disk space of the volumes a run reads and writes, as header lines for the log.
//
//   node harness/disk-usage.mjs [--config <victory.toml>] game=<path> [cache=<path>] [data=<path>]
//
// One line per volume, named by drive letter only (no folder path): the game's volume always, the cache's and
// the data's when they are on different volumes. Free and total gigabytes, never a folder walk: a game folder is
// tens of gigabytes and walking it would cost seconds on every run.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GB = 1 << 30;

/// Free and total bytes of the volume `target` lives on, or null when the path or its volume is unreadable.
export function space(target) {
  try {
    const stats = fs.statfsSync(target);
    return { free: Number(stats.bavail) * Number(stats.bsize), total: Number(stats.blocks) * Number(stats.bsize) };
  } catch {
    return null;
  }
}

/// The drive letter a path names (`E:`), or the first path segment when it names none.
export function driveOf(target) {
  const resolved = path.resolve(target);
  const letter = resolved.match(/^([A-Za-z]:)/);
  return letter ? letter[1].toUpperCase() : path.parse(resolved).root || resolved;
}

/// `disk game: E: 812.3 GB free of 1863.0 GB`, or a line saying the volume cannot be read.
export function line(label, target, spaceOf = space) {
  const drive = driveOf(target);
  const found = spaceOf(target);
  if (!found) return `disk ${label}: ${drive} unreadable`;
  return `disk ${label}: ${drive} ${(found.free / GB).toFixed(1)} GB free of ${(found.total / GB).toFixed(1)} GB`;
}

/// The header lines for the given volumes: the game's always, the others only on a different drive.
export function linesFor(volumes, spaceOf = space) {
  const out = [];
  const seen = new Set();
  for (const [label, target] of Object.entries(volumes)) {
    if (!target) continue;
    const drive = driveOf(target);
    if (seen.has(drive)) continue;
    seen.add(drive);
    out.push(line(label, target, spaceOf));
  }
  return out;
}

/// `cache_dir` and `data_dir` from a victory.toml, either quoting style; null when absent.
export function configDirs(configPath) {
  const text = fs.readFileSync(configPath, 'utf8');
  const read = (name) => {
    const single = text.match(new RegExp(`^\\s*${name}\\s*=\\s*'([^']*)'`, 'm'));
    if (single) return single[1];
    const double = text.match(new RegExp(`^\\s*${name}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm'));
    return double ? double[1].replace(/\\(.)/g, '$1') : null;
  };
  return { cache: read('cache_dir'), data: read('data_dir') };
}

function main(argv) {
  const volumes = {};
  let config = null;
  const positional = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--config') config = argv[++i];
    else positional.push(argv[i]);
  }
  for (const arg of positional) {
    const at = arg.indexOf('=');
    if (at <= 0) {
      console.error(`disk-usage: expected label=path, not '${arg}'`);
      return 2;
    }
    volumes[arg.slice(0, at)] = arg.slice(at + 1);
  }
  if (!volumes.game) {
    console.error('usage: node harness/disk-usage.mjs [--config <victory.toml>] game=<path> [cache=<path>] [data=<path>]');
    return 2;
  }
  if (config) {
    try {
      const dirs = configDirs(config);
      if (!volumes.cache && dirs.cache) volumes.cache = dirs.cache;
      if (!volumes.data && dirs.data) volumes.data = dirs.data;
    } catch {
      // A config that cannot be read leaves the game's volume line only.
    }
  }
  for (const text of linesFor(volumes)) console.log(text);
  return 0;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));

#!/usr/bin/env node
// This machine's harness paths, from harness/local.env (git-ignored; harness/local.env.example shows the shape).
//
//   node harness/local-env.mjs pairs     prints NAME=value for each name the file sets and the environment does not
//
// The harness defaults are the main PC's E: drive. A second machine writes its own paths into local.env, one
// NAME=value a line (# comments, an optional "export ", one pair of surrounding quotes stripped). Only the names in
// LOCAL_ENV_NAMES are taken: the file holds paths, never a switch, so VICTORY_ALLOW_OBS (the maintainer's word for one stream
// only, a decision) can never come from it. The environment always wins over the file, and an empty variable counts as
// unset, as ${NAME:-default} does. VICTORY_LOCAL_ENV names another file (tests use it).
//
// Warnings give a line number and a name, never a value: the file holds this machine's folders, and the terminal is
// on stream. The shell scripts load it through local-env.sh, the node scripts by calling loadLocalEnv().
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const LOCAL_ENV_NAMES = Object.freeze([
  'GAME_EXE', // the title's executable in the dump (run-world.sh, run-queue.sh, game-dir.mjs)
  'GAME_MANIFEST', // the dump's MicrosoftGame.Config, when the executable's neighbours do not hold it (game-dir.mjs)
  'GAME_STAGE', // where a dump with no executable of its own is mirrored in hardlinks (game-dir.mjs)
  'VICTORY_CAPTURES', // the root each run's capture folder is made under (run-world.sh, presentmon.mjs)
  'VICTORY_BUILDS', // snapshot builds (snapshot-build.sh)
  'VICTORY_REPO', // the victory checkout snapshot-build.sh --list asks for commit subjects
  'VICTORY_WORKTREES', // the lane worktrees run-queue.sh looks a bare lane name up in
  'PRESENTMON_EXE', // PresentMon's executable (presentmon.mjs)
  'VICTORY_SAVE_BACKUPS', // the save snapshots and before-run backups (save-snapshot.mjs)
]);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/// The file to read: VICTORY_LOCAL_ENV, else harness/local.env.
export function localEnvPath(env = process.env) {
  return env.VICTORY_LOCAL_ENV || path.join(HERE, 'local.env');
}

/// { values: { NAME: value }, warnings: [text] } from local.env's text.
export function parseLocalEnv(text) {
  const values = {};
  const warnings = [];
  const lines = String(text).split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#')) return;
    const body = line.replace(/^export\s+/, '');
    const eq = body.indexOf('=');
    const name = eq > 0 ? body.slice(0, eq).trim() : '';
    if (!NAME_RE.test(name)) {
      warnings.push(`local.env line ${i + 1}: not NAME=value; skipped`);
      return;
    }
    if (!LOCAL_ENV_NAMES.includes(name)) {
      warnings.push(`local.env line ${i + 1}: ${name} is not a path this file may set; ignored`);
      return;
    }
    let value = body.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.endsWith(value[0])) {
      value = value.slice(1, -1);
    }
    values[name] = value;
  });
  return { values, warnings };
}

/// Sets each name the file gives and `env` lacks; returns the names it set. No file is no change.
export function loadLocalEnv({ file, env = process.env, warn = (w) => console.error(w) } = {}) {
  const where = file ?? localEnvPath(env);
  let text;
  try {
    text = fs.readFileSync(where, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const { values, warnings } = parseLocalEnv(text);
  for (const w of warnings) warn(w);
  const applied = [];
  for (const [name, value] of Object.entries(values)) {
    if (env[name] !== undefined && env[name] !== '') continue;
    env[name] = value;
    applied.push(name);
  }
  return applied;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  if (process.argv[2] !== 'pairs' || process.argv.length > 3) {
    console.error('usage: node harness/local-env.mjs pairs');
    process.exit(2);
  }
  const env = { ...process.env };
  for (const name of loadLocalEnv({ env })) process.stdout.write(`${name}=${env[name]}\n`);
}

#!/usr/bin/env node
// Runs one VIctory world run under Nsight Graphics' GPU Trace activity, headless.
//
//   node harness/gpu-trace.mjs run --bin <victory.exe> --dir <VICTORY_DIR> --game-args-file <file>
//        --env-file <file> --after-ms <ms> [--frames <n>] --out <dir>
//   node harness/gpu-trace.mjs print ... (the same options; prints the command instead of running it)
//
// `commandFor` assembles the argument list and is what the tests call; nothing here launches anything in a test.
// The game's own arguments and the environment come from files, one entry per line, so paths with spaces and
// quotes survive without shell quoting. Nsight's path is `VICTORY_NGFX`, else the newest `Nsight Graphics *`
// folder under Program Files.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_PROGRAM_FILES = '<drive>/Program Files';

/// The ngfx.exe to use: `VICTORY_NGFX`, else the newest `Nsight Graphics <version>` install, else null.
export function ngfxPath(programFiles = DEFAULT_PROGRAM_FILES, env = process.env, read = fs.readdirSync) {
  if (env.VICTORY_NGFX) return env.VICTORY_NGFX;
  const root = path.join(programFiles, 'NVIDIA Corporation');
  let names;
  try {
    names = read(root).filter((name) => /^Nsight Graphics /.test(name));
  } catch {
    return null;
  }
  if (!names.length) return null;
  names.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  return path.join(root, names[names.length - 1], 'host', 'windows-desktop-nomad-x64', 'ngfx.exe');
}

/// One argument of the game's command line, quoted for ngfx's single `--args` string.
export function quoteArg(arg) {
  return /[\s"]/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

/// The profiler's command: the file and its argument list (an argv array, so a path's spaces stay one element).
export function commandFor(options) {
  const { bin, dir, gameArgs, envPairs, afterMs, frames = 1, out } = options;
  if (!(Number(afterMs) > 0)) {
    throw new Error('--trace-after-ms is required: refusing to trace the loading screen');
  }
  const exe = options.exe ?? ngfxPath(options.programFiles, options.env);
  if (!exe) {
    throw new Error(
      'no Nsight Graphics found: set VICTORY_NGFX or install Nsight Graphics under "<drive>/Program Files/NVIDIA Corporation"',
    );
  }
  return {
    file: exe,
    args: [
      '--activity',
      'GPU Trace Profiler',
      '--exe',
      bin,
      '--dir',
      dir,
      '--args',
      gameArgs.map(quoteArg).join(' '),
      '--env',
      `${envPairs.join('; ')};`,
      '--start-after-ms',
      String(afterMs),
      '--limit-to-frames',
      String(frames),
      '--set-gpu-clocks',
      'unaltered',
      '--auto-export',
      '--output-dir',
      out,
    ],
  };
}

const lines = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');

function usage() {
  console.error(
    'usage: node gpu-trace.mjs run|print --bin <victory.exe> --dir <VICTORY_DIR> --game-args-file <file> ' +
      '--env-file <file> --after-ms <ms> [--frames <n>] --out <dir>',
  );
}

function parse(argv) {
  const [what, ...rest] = argv;
  const options = { what };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--bin') options.bin = rest[++i];
    else if (arg === '--dir') options.dir = rest[++i];
    else if (arg === '--game-args-file') options.gameArgsFile = rest[++i];
    else if (arg === '--env-file') options.envFile = rest[++i];
    else if (arg === '--after-ms') options.afterMs = Number(rest[++i]);
    else if (arg === '--frames') options.frames = Number(rest[++i]);
    else if (arg === '--out') options.out = rest[++i];
    else if (arg.startsWith('--')) throw new Error(`unknown argument ${arg}`);
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!['run', 'print'].includes(options.what)) throw new Error('expected run or print');
  for (const needed of ['bin', 'dir', 'gameArgsFile', 'envFile', 'out']) {
    if (!options[needed]) throw new Error(`--${needed.replace(/File$/, '-file')} is required`);
  }
  if (!Number.isFinite(options.frames ?? 1) || (options.frames ?? 1) < 1) {
    throw new Error('--frames needs a whole number of frames');
  }
  return options;
}

function main(argv) {
  let options;
  let command;
  try {
    options = parse(argv);
    command = commandFor({
      bin: options.bin,
      dir: options.dir,
      gameArgs: lines(options.gameArgsFile),
      envPairs: lines(options.envFile),
      afterMs: options.afterMs,
      frames: options.frames ?? 1,
      out: options.out,
    });
  } catch (err) {
    console.error(`gpu-trace: ${err.message}`);
    return 2;
  }
  if (options.what === 'print') {
    console.log([command.file, ...command.args].map(quoteArg).join(' '));
    return 0;
  }
  const result = spawnSync(command.file, command.args, { stdio: 'inherit' });
  if (result.error) {
    console.error(`gpu-trace: ${result.error.message}`);
    return 1;
  }
  return result.status ?? 1;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));

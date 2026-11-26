#!/usr/bin/env node
// The live-switch control file: what a run started with VICTORY_LIVE=<file> re-reads at a frame boundary.
//
//   harness/live.sh [--file <path>] set NAME=value [NAME=value ...]
//   harness/live.sh [--file <path>] unset NAME ...
//   harness/live.sh [--file <path>] show
//   harness/live.sh [--file <path>] clear
//   harness/live.sh names
//
// The path comes from VICTORY_LIVE, else --file. `names` needs no path: it prints the live registry that live.mjs
// and live-drive.mjs share (live-names.mjs), one name a line. The file is one NAME=value a line, `#` starts a
// comment and blank lines are ignored. set merges: an existing name keeps its line's place and trailing comment, a
// new one is appended,
// and every other line is left exactly as it was. unset removes only the named assignments (a trailing comment stays,
// as a comment of its own); clear empties the file. A write goes to a temporary file beside the control file and is
// renamed into place, so the runtime never reads half a file. Names are [A-Z0-9_]+; a value may not carry a newline
// or `#` (the runtime would read either as something else).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { LIVE_NAMES } from './live-names.mjs';

export const NAME_RE = /^[A-Z0-9_]+$/;

// A command-line fault, so main can tell it from a file error and answer with exit 2.
function invalid(message) {
  const err = new Error(message);
  err.exitCode = 2;
  return err;
}

/// Rejects a name the runtime's registry cannot spell.
export function checkName(name) {
  if (!NAME_RE.test(name)) {
    throw invalid(`not a switch name (A-Z, 0-9 and _ only): '${name}'`);
  }
}

/// Rejects a value the control file's line format would cut short.
export function checkValue(name, value) {
  if (/[\r\n]/.test(value)) throw invalid(`value for ${name} contains a newline`);
  if (value.includes('#')) throw invalid(`value for ${name} contains '#', which starts a comment`);
}

/// One line's assignment: its name, value, indentation and trailing comment; null for a comment, blank or a line
/// without `=`. The value is trimmed, as the runtime trims it.
export function parseAssignment(line) {
  const text = String(line);
  const hash = text.indexOf('#');
  const body = hash < 0 ? text : text.slice(0, hash);
  const eq = body.indexOf('=');
  if (eq < 0) return null;
  const name = body.slice(0, eq).trim();
  if (!name) return null;
  return {
    name,
    value: body.slice(eq + 1).trim(),
    indent: body.match(/^\s*/)[0],
    comment: hash < 0 ? '' : text.slice(hash),
  };
}

/// The control file's lines, without the final newline's empty tail. CRLF is read as LF, and the writer below always
/// ends a non-empty file with one newline.
function linesOf(text) {
  const normalized = String(text).replace(/\r\n/g, '\n');
  if (normalized === '') return [];
  const lines = normalized.split('\n');
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
}

/// Existing text with `set` ({ NAME: value }) merged and `unset` (names) removed. Comments and every unrelated line
/// stay as they were. A name may not be in both.
export function mergeControl(text, { set = {}, unset = [] } = {}) {
  const setNames = new Set(Object.keys(set));
  const unsetNames = new Set(unset);
  for (const name of setNames) {
    checkName(name);
    checkValue(name, set[name]);
    if (unsetNames.has(name)) throw invalid(`${name} is both set and unset`);
  }
  for (const name of unsetNames) checkName(name);

  const out = [];
  const replaced = new Set();
  for (const line of linesOf(text)) {
    const assignment = parseAssignment(line);
    if (assignment && setNames.has(assignment.name)) {
      out.push(
        `${assignment.indent}${assignment.name}=${set[assignment.name]}${
          assignment.comment ? ` ${assignment.comment}` : ''
        }`,
      );
      replaced.add(assignment.name);
    } else if (assignment && unsetNames.has(assignment.name)) {
      // The assignment goes; a trailing comment is still a comment, so keep it.
      if (assignment.comment) out.push(`${assignment.indent}${assignment.comment}`);
    } else {
      out.push(line);
    }
  }
  for (const name of setNames) {
    if (!replaced.has(name)) out.push(`${name}=${set[name]}`);
  }
  return out.length ? `${out.join('\n')}\n` : '';
}

/// Writes `text` to `file` through a temporary file in the same folder, then renames it into place. `operations`
/// exists for the test that watches the two steps; a real caller passes nothing.
export function writeAtomic(file, text, operations = fs) {
  const dir = path.dirname(file);
  const base = path.basename(file);
  const temporary = path.join(
    dir,
    `.${base}.tmp-${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
  );
  try {
    operations.writeFileSync(temporary, text);
    operations.renameSync(temporary, file);
  } catch (err) {
    try {
      operations.unlinkSync(temporary);
    } catch {
      // The temporary file may not have been made; the original file is untouched either way.
    }
    throw err;
  }
}

/// The control file's text, or null when it does not exist (a missing file means no switches, as in the runtime).
export function readControl(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

function usage(stream = process.stderr) {
  stream.write(
    'usage: live.sh [--file <path>] set NAME=value [NAME=value ...]\n' +
      '       live.sh [--file <path>] unset NAME ...\n' +
      '       live.sh [--file <path>] show\n' +
      '       live.sh [--file <path>] clear\n' +
      '       live.sh names\n',
  );
}

/// The command line. The control file is VICTORY_LIVE when it is set, else --file. Returns an exit code.
export function main(argv, env = process.env) {
  let file = '';
  let command = null;
  const operands = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file') {
      if (i + 1 >= argv.length) {
        console.error('live: --file needs a path');
        return 2;
      }
      file = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      usage(process.stdout);
      return 0;
    } else if (arg.startsWith('-')) {
      console.error(`live: unknown option ${arg}`);
      usage();
      return 2;
    } else if (command === null) {
      command = arg;
    } else {
      operands.push(arg);
    }
  }

  if (command === 'names') {
    if (operands.length) {
      console.error('live: names takes no arguments');
      return 2;
    }
    process.stdout.write(`${LIVE_NAMES.join('\n')}\n`);
    return 0;
  }

  const target = env.VICTORY_LIVE || file;
  if (!target) {
    console.error('live: no control file: set VICTORY_LIVE or pass --file <path>');
    return 2;
  }

  try {
    if (command === 'set') {
      if (!operands.length) {
        console.error('live: set needs at least one NAME=value');
        return 2;
      }
      const set = {};
      for (const pair of operands) {
        const eq = pair.indexOf('=');
        if (eq <= 0) {
          console.error(`live: set needs NAME=value, not '${pair}'`);
          return 2;
        }
        const name = pair.slice(0, eq);
        const value = pair.slice(eq + 1);
        checkName(name);
        checkValue(name, value);
        set[name] = value;
      }
      writeAtomic(target, mergeControl(readControl(target) ?? '', { set }));
      return 0;
    }
    if (command === 'unset') {
      if (!operands.length) {
        console.error('live: unset needs at least one NAME');
        return 2;
      }
      for (const name of operands) checkName(name);
      writeAtomic(target, mergeControl(readControl(target) ?? '', { unset: operands }));
      return 0;
    }
    if (command === 'show') {
      if (operands.length) {
        console.error('live: show takes no arguments');
        return 2;
      }
      process.stdout.write(readControl(target) ?? '');
      return 0;
    }
    if (command === 'clear') {
      if (operands.length) {
        console.error('live: clear takes no arguments');
        return 2;
      }
      writeAtomic(target, '');
      return 0;
    }
    console.error(command === null ? 'live: no command' : `live: unknown command ${command}`);
    usage();
    return 2;
  } catch (err) {
    console.error(`live: ${err.message}`);
    return err.exitCode || 1;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) process.exit(main(process.argv.slice(2)));

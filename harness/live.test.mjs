import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { checkValue, mergeControl, writeAtomic } from './live.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'live.sh');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// The developer's own VICTORY_LIVE must not decide a test's control file.
function env(extra = {}) {
  const out = { ...process.env };
  delete out.VICTORY_LIVE;
  return { ...out, ...extra };
}

function run(args, extra = {}) {
  return spawnSync('bash', [script, ...args], { encoding: 'utf8', env: env(extra) });
}

test('set merges: comments, other names and a trailing comment stay; a new name is appended', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'live.txt');
  fs.writeFileSync(
    file,
    '# the boat run\nVICTORY_KEEP_TEXTURES=on\nVICTORY_TEXTURE_LOW=70  # the low watermark\nLIVE_SKIP_DRAW=\n',
  );
  const result = run(['--file', file, 'set', 'VICTORY_TEXTURE_LOW=60', 'VICTORY_LATE_WAITS=yes']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
  assert.equal(
    fs.readFileSync(file, 'utf8'),
    '# the boat run\nVICTORY_KEEP_TEXTURES=on\nVICTORY_TEXTURE_LOW=60 # the low watermark\nLIVE_SKIP_DRAW=\nVICTORY_LATE_WAITS=yes\n',
  );
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes('.tmp-')),
    [],
    'no temporary file is left beside the control file',
  );
});

test('a CRLF control file is merged without losing its comments or the lines it does not name', () => {
  const merged = mergeControl('VICTORY_KEEP_TEXTURES=on\r\n# a note\r\nLIVE_SKIP_DRAW=1,2\r\n', {
    set: { VICTORY_KEEP_TEXTURES: 'off' },
  });
  assert.equal(merged, 'VICTORY_KEEP_TEXTURES=off\n# a note\nLIVE_SKIP_DRAW=1,2\n');
});

test('unset removes only the named assignment; a trailing comment survives as a comment', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'live.txt');
  fs.writeFileSync(file, 'VICTORY_TEXTURE_LOW=70 # the low watermark\nVICTORY_TEXTURE_HIGH=85\n');
  const result = run(['--file', file, 'unset', 'VICTORY_TEXTURE_LOW']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(file, 'utf8'), '# the low watermark\nVICTORY_TEXTURE_HIGH=85\n');
});

test('show prints the file exactly; clear empties it', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'live.txt');
  fs.writeFileSync(file, 'LIVE_SKIP_DRAW=12,34\n');
  const shown = run(['--file', file, 'show']);
  assert.equal(shown.status, 0, shown.stderr);
  assert.equal(shown.stdout, 'LIVE_SKIP_DRAW=12,34\n');
  const cleared = run(['--file', file, 'clear']);
  assert.equal(cleared.status, 0, cleared.stderr);
  assert.equal(fs.statSync(file).size, 0);
  const empty = run(['--file', file, 'show']);
  assert.equal(empty.status, 0, empty.stderr);
  assert.equal(empty.stdout, '');
});

test('a write goes to a temporary file beside its destination, then renames it into place', () => {
  const calls = [];
  const operations = {
    writeFileSync(file, text) {
      calls.push(['write', file, text]);
    },
    renameSync(from, to) {
      calls.push(['rename', from, to]);
    },
    unlinkSync() {
      calls.push(['unlink']);
    },
  };
  writeAtomic('/made/up/live.txt', 'VICTORY_KEEP_TEXTURES=on\n', operations);
  assert.equal(calls.length, 2);
  const [write, rename] = calls;
  assert.equal(write[0], 'write');
  assert.equal(write[2], 'VICTORY_KEEP_TEXTURES=on\n');
  assert.ok(path.basename(write[1]).startsWith('.live.txt.tmp-'), 'the write is not the destination itself');
  assert.equal(path.basename(path.dirname(write[1])), 'up', 'the temporary file is in the destination folder');
  assert.deepEqual(rename, ['rename', write[1], '/made/up/live.txt']);
});

test('a failed rename removes its temporary file and leaves the old control file alone', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'live.txt');
  fs.writeFileSync(file, 'VICTORY_KEEP_TEXTURES=on\n');
  const removed = [];
  assert.throws(
    () =>
      writeAtomic(file, 'VICTORY_KEEP_TEXTURES=off\n', {
        writeFileSync: () => {},
        renameSync: () => {
          throw new Error('rename refused');
        },
        unlinkSync: (temporary) => removed.push(temporary),
      }),
    /rename refused/,
  );
  assert.equal(removed.length, 1);
  assert.equal(fs.readFileSync(file, 'utf8'), 'VICTORY_KEEP_TEXTURES=on\n');
});

test('VICTORY_LIVE names the file; --file is the fallback and the environment wins', (t) => {
  const dir = tempDir(t);
  const fromEnv = path.join(dir, 'from-env.txt');
  const fromFlag = path.join(dir, 'from-flag.txt');
  const result = run(['--file', fromFlag, 'set', 'VICTORY_KEEP_TEXTURES=off'], { VICTORY_LIVE: fromEnv });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(fs.readFileSync(fromEnv, 'utf8'), 'VICTORY_KEEP_TEXTURES=off\n');
  assert.equal(fs.existsSync(fromFlag), false);
});

test('a value with a newline is refused before it can split the file into two lines', () => {
  assert.throws(() => checkValue('VICTORY_KEEP_TEXTURES', 'on\noff'), /contains a newline/);
  assert.throws(() => checkValue('VICTORY_KEEP_TEXTURES', 'on\noff'.replace('\n', '\r')), /contains a newline/);
  assert.equal(checkValue('LIVE_SKIP_DRAW', '12,34'), undefined);
});

test('names prints the shared live registry, one a line, and needs no control file', () => {
  const result = run(['names']);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.trim().split('\n'), [
    'VICTORY_KEEP_TEXTURES',
    'VICTORY_TEXTURE_LOW',
    'VICTORY_TEXTURE_HIGH',
    'VICTORY_LATE_WAITS',
    'LIVE_SKIP_DISPATCH',
    'LIVE_SKIP_DRAW',
  ]);
  const extra = run(['names', 'LIVE_SKIP_DRAW']);
  assert.equal(extra.status, 2);
  assert.match(extra.stderr, /names takes no arguments/);
});

test('the control file is refused when neither VICTORY_LIVE nor --file gives one', () => {
  const result = run(['set', 'VICTORY_KEEP_TEXTURES=off']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no control file: set VICTORY_LIVE or pass --file/);
});

test('a bad name, a missing name, a # and a malformed pair are all refused', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'live.txt');
  const cases = [
    [['set', 'lower=1'], /not a switch name/],
    [['set', 'VICTORY_KEEP_TEXTURES'], /set needs NAME=value/],
    [['set', 'VICTORY_KEEP_TEXTURES=a#b'], /starts a comment/],
    [['unset', 'lower'], /not a switch name/],
    [['set'], /set needs at least one NAME=value/],
    [['unset'], /unset needs at least one NAME/],
    [['nonsense'], /unknown command/],
  ];
  for (const [args, message] of cases) {
    const result = run(['--file', file, ...args]);
    assert.equal(result.status, 2, `${args.join(' ')}: ${result.stderr}`);
    assert.match(result.stderr, message, args.join(' '));
    assert.equal(fs.existsSync(file), false, `${args.join(' ')} writes nothing`);
  }
});

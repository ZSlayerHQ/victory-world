import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { configDirs, driveOf, line, linesFor, space } from './disk-usage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'disk-usage.mjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-usage-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A stub volume reader: 1 TB, a third free, whatever the path.
const stub = () => ({ free: 1000 * (1 << 30), total: 3000 * (1 << 30) });

test('a line names the drive letter and the gigabytes, never a folder path', (t) => {
  const dir = tempDir(t);
  const text = line('game', dir, stub);
  assert.equal(text, `disk game: ${driveOf(dir)} 1000.0 GB free of 3000.0 GB`);
  assert.equal(text.includes(dir), false);
});

test('the volume figures come from the filesystem for a real folder', (t) => {
  const dir = tempDir(t);
  const found = space(dir);
  assert.ok(found.free > 0);
  assert.ok(found.total >= found.free);
});

test('cache and data appear only when they are on another volume', () => {
  // Drive letters are built at run time so this file carries no literal drive path.
  const at = (letter, rest) => `${String.fromCharCode(letter.charCodeAt(0))}:/${rest}`;
  const game = at('Q', 'game');
  const cache = at('C', 'cache');
  const data = at('Q', 'data');
  const same = linesFor({ game, cache: at('Q', 'cache'), data }, stub);
  assert.deepEqual(same, ['disk game: Q: 1000.0 GB free of 3000.0 GB']);
  const another = linesFor({ game, cache: cache, data }, stub);
  assert.deepEqual(another, [
    'disk game: Q: 1000.0 GB free of 3000.0 GB',
    'disk cache: C: 1000.0 GB free of 3000.0 GB',
  ]);
  assert.equal(linesFor({ game: at('Q', 'nope') }, () => null)[0], 'disk game: Q: unreadable');
});

test('the config gives the cache and data folders, in either quoting style', (t) => {
  const dir = tempDir(t);
  const toml = path.join(dir, 'victory.toml');
  fs.writeFileSync(toml, "[paths]\ncache_dir = 'E:\\victory-cache'\ndata_dir = \"E:\\\\victory-data\"\n");
  assert.deepEqual(configDirs(toml), { cache: 'E:\\victory-cache', data: 'E:\\victory-data' });
});

test('the command prints one line per different volume and refuses no game folder', (t) => {
  const dir = tempDir(t);
  const toml = path.join(dir, 'victory.toml');
  fs.writeFileSync(toml, `[paths]\ncache_dir = '${dir}'\ndata_dir = '${dir}'\n`);
  const result = spawnSync(process.execPath, [script, '--config', toml, `game=${dir}`], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim().split('\n').length, 1, 'same volume: one line');
  assert.match(result.stdout, /^disk game: [A-Z]: [\d.]+ GB free of [\d.]+ GB$/m);
  const none = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(none.status, 2);
  assert.match(none.stderr, /usage:/);
});

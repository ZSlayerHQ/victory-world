import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { check, decide, endedMarker, freeGb, GB } from './disk-guard.mjs';
import { driveOf } from './disk-usage.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'disk-guard.mjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'disk-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const spaceOf = (gb) => () => ({ free: gb * GB, total: 100 * GB });

test('the start check refuses below the minimum and names the drive only', (t) => {
  const dir = tempDir(t);
  const low = check(dir, 30, spaceOf(29.4));
  assert.equal(low.ok, false);
  assert.match(low.text, /29\.4 GB free, below 30 GB/);
  assert.equal(low.text.includes(dir), false);
  assert.match(low.text, new RegExp(`^disk ${driveOf(dir)} `));
  const fine = check(dir, 30, spaceOf(30));
  assert.equal(fine.ok, true);
  assert.match(fine.text, /30\.0 GB free$/);
});

test('an unreadable volume refuses the start rather than passing it', (t) => {
  const found = check(tempDir(t), 30, () => null);
  assert.equal(found.ok, false);
  assert.match(found.text, /unreadable/);
});

test('the running guard ends only on a readable figure under the floor', () => {
  assert.equal(decide(4.9, 5), 'end');
  assert.equal(decide(5, 5), 'wait');
  assert.equal(decide(50, 5), 'wait');
  assert.equal(decide(null, 5), 'wait');
  assert.equal(endedMarker(5), 'harness: ended: disk below 5 GB');
});

test('freeGb reads a real folder through the injected reader', (t) => {
  assert.equal(freeGb(tempDir(t), spaceOf(41)), 41);
  assert.equal(freeGb(tempDir(t), () => null), null);
});

test('the check command exits 1 under the minimum and 0 above it, on a made-up figure', (t) => {
  const dir = tempDir(t);
  const low = spawnSync(process.execPath, [script, 'check', '--path', dir, '--min', '30', '--free-gb', '12.5'], {
    encoding: 'utf8',
  });
  assert.equal(low.status, 1, low.stderr);
  assert.match(low.stdout, /12\.5 GB free, below 30 GB/);
  const fine = spawnSync(process.execPath, [script, 'check', '--path', dir, '--min', '30', '--free-gb', '30.1'], {
    encoding: 'utf8',
  });
  assert.equal(fine.status, 0, fine.stderr);
  assert.match(fine.stdout, /30\.1 GB free/);
});

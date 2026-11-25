import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { choose, refusal, workTreeOf } from './run-cwd.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'run-cwd.mjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-cwd-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function repoAt(t, parent) {
  const repo = path.join(tempDir(t), parent ?? 'repo');
  fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
  return repo;
}

test('a work tree is found at the folder and at every folder below it', (t) => {
  const repo = repoAt(t);
  assert.equal(workTreeOf(repo), repo);
  const below = path.join(repo, 'crates', 'victory-gpu');
  fs.mkdirSync(below, { recursive: true });
  assert.equal(workTreeOf(below), repo);
  const outside = tempDir(t);
  assert.equal(workTreeOf(outside), null);
  assert.equal(refusal(below), `the working folder ${below} is inside the git work tree ${repo}`);
});

test('a snapshot folder outside a repository is the working folder', (t) => {
  const snapshot = path.join(tempDir(t), 'deadbeef-diag');
  fs.mkdirSync(snapshot);
  const capture = tempDir(t);
  const folder = choose({ bin: path.join(snapshot, 'victory.exe'), lane: repoAt(t, 'lane'), capture });
  assert.equal(folder, snapshot);
});

test('a lane inside a repository gives way to a fresh cwd under the capture folder', (t) => {
  const lane = repoAt(t, 'lane');
  const capture = tempDir(t);
  const folder = choose({ bin: path.join(lane, 'target', 'diag', 'victory.exe'), lane, capture });
  assert.equal(folder, path.join(capture, 'cwd'));
  assert.ok(fs.existsSync(folder));
});

test('the command prints the folder, and refuses one inside a work tree', (t) => {
  const lane = repoAt(t, 'lane');
  const capture = tempDir(t);
  let result = spawnSync(process.execPath, [script, 'choose', '--bin', path.join(lane, 'v.exe'), '--lane', lane, '--capture', capture], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(capture, 'cwd'));
  result = spawnSync(process.execPath, [script, 'check', lane], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is inside the git work tree/);
  result = spawnSync(process.execPath, [script, 'check', capture], { encoding: 'utf8' });
  assert.equal(result.status, 0);
});

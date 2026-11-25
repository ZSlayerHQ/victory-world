import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { readRoute, routeNames } from './route-keys.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'route-keys.mjs');

function runRoute(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'victory-routes-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a route reads its comments, its header and its entries, joined with commas', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(
    path.join(dir, 'sample.keys'),
    [
      '# sample: a route for the test.',
      '#',
      '# heavy-seconds: 42',
      '# settled-seconds: 75',
      '',
      '55:Enter',
      '65:Enter',
      '  70:J:8  # a held turn',
      '# a trailing comment only',
      '80:Backspace:4',
      '',
    ].join('\n'),
  );
  assert.deepEqual(readRoute(dir, 'sample'), {
    keys: ['55:Enter', '65:Enter', '70:J:8', '80:Backspace:4'],
    heavySeconds: '42',
    settledSeconds: '75',
  });
  assert.deepEqual(routeNames(dir), ['sample']);
});

test('the command prints the keys, or the heavy-seconds header', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'sample.keys'), '# heavy-seconds: 42\n# settled-seconds: 75\n55:Enter\n70:J:8\n');
  let result = runRoute(['keys', dir, 'sample']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '55:Enter,70:J:8');
  result = runRoute(['heavy-seconds', dir, 'sample']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '42');
  result = runRoute(['settled-seconds', dir, 'sample']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), '75');
});

test('an unknown route fails and lists the routes that exist', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'demo-turn.keys'), '55:Enter\n');
  fs.writeFileSync(path.join(dir, 'demo-skip.keys'), '55:Enter\n');
  const result = runRoute(['keys', dir, 'nowhere']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /no route 'nowhere'; routes: demo-skip, demo-turn/);
});

test('a route with no keys fails rather than running an empty key list', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'empty.keys'), '# heavy-seconds: 10\n# nothing else\n');
  const result = runRoute(['keys', dir, 'empty']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /route 'empty' has no keys/);
});

test('the harness refuses --keys and --route together, and lists routes for a missing one', () => {
  // The script exits at argument parsing for both, before any binary or game check, so nothing runs.
  const harness = path.join(here, 'run-world.sh');
  let result = spawnSync('bash', [harness, '--keys', '55:Enter', '--route', 'demo-turn'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /--keys and --route together/);
  result = spawnSync('bash', [harness, '--route', 'nowhere'], { encoding: 'utf8' });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /no route 'nowhere'; routes: .*example/);
});

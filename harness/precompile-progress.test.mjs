import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { etaFromRate, overlayJson, stateFrom, write } from './precompile-progress.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'precompile-progress.mjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precompile-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the summary gives the final counts; a progress line gives them while running', () => {
  let state = stateFrom(['progress translated 1200 of 26148'], { startedMs: 1000, nowMs: 3000 });
  assert.equal(state.state, 'running');
  assert.equal(state.done, 1200);
  assert.equal(state.total, 26148);
  assert.equal(state.percent, 4.6);
  assert.equal(state.elapsed_s, 2);
  assert.equal(state.eta_s, Math.round((2 * (26148 - 1200)) / 1200));

  state = stateFrom(['programs     25654 translated of 26148 (123 IR instructions)'], { startedMs: 0, nowMs: 1000 });
  assert.equal(state.state, 'done');
  assert.equal(state.done, 25654);
  assert.equal(state.total, 26148);
});

test("the translator's own progress lines give the total first, then the count", () => {
  const lines = ['progress total programs=26148 containers=25985', 'progress translated 1200 of 26148 refused=6 failed_validation=2'];
  const state = stateFrom(lines, { startedMs: 0, nowMs: 2000 });
  assert.equal(state.state, 'running');
  assert.equal(state.done, 1200);
  assert.equal(state.total, 26148);
  assert.equal(state.percent, 4.6);

  // The total alone is enough to draw a bar at zero.
  const before = stateFrom(['progress total programs=26148 containers=25985'], { startedMs: 0, nowMs: 1000 });
  assert.equal(before.done, 0);
  assert.equal(before.total, 26148);
  assert.equal(before.percent, 0);
});

test('the estimate comes from the rate over the last 30 seconds', () => {
  const samples = [
    { ms: 0, done: 0 },
    { ms: 10_000, done: 1000 },
    { ms: 20_000, done: 2000 },
    { ms: 30_000, done: 3000 },
  ];
  // At 40 s the reference is the 10 s point: 3000 programs in 30 s, 6000 left, 60 s to go.
  const eta = etaFromRate(4000, 10_000, 40_000, samples, 0);
  assert.equal(eta, 60);
  // An early burst does not count: the same run, once it slows, is estimated from the slow window only
  // (10 a second here, where the whole run's average would say 232 a second).
  const burst = [
    { ms: 0, done: 0 },
    { ms: 10_000, done: 9000 },
    { ms: 20_000, done: 9100 },
    { ms: 30_000, done: 9200 },
  ];
  assert.equal(etaFromRate(9300, 20_000, 40_000, burst, 0), 1070);
});

test('no movement inside the window means no estimate', () => {
  const samples = [
    { ms: 0, done: 0 },
    { ms: 20_000, done: 2000 },
    { ms: 40_000, done: 2000 },
  ];
  assert.equal(etaFromRate(2000, 10_000, 50_000, samples, 0), null);
  assert.equal(etaFromRate(10_000, 10_000, 50_000, samples, 0), null);
});

test('without a stated total the counts go up and the percentage is null', () => {
  const state = stateFrom(['shader translated stage="pixel" hash=0123456789abcdef', 'shader translated stage="compute" hash=fedcba9876543210'], {
    startedMs: 0,
    nowMs: 1000,
  });
  assert.equal(state.done, 2);
  assert.equal(state.total, null);
  assert.equal(state.percent, null);
  assert.equal(state.eta_s, null);
});

test('the end state is done or failed from the exit code', () => {
  const done = stateFrom(['programs 10 translated of 10'], { startedMs: 0, nowMs: 1000, exit: 0 });
  assert.equal(done.state, 'done');
  const failed = stateFrom([''], { startedMs: 0, nowMs: 1000, exit: 3 });
  assert.equal(failed.state, 'failed');
});

test('the written file holds numbers and the label only, and is complete', (t) => {
  const dir = tempDir(t);
  const out = path.join(dir, 'stream', 'precompile.json');
  write(out, stateFrom(['progress translated 5 of 10'], { startedMs: 0, nowMs: 1000 }));
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.deepEqual(Object.keys(parsed).sort(), ['done', 'elapsed_s', 'eta_s', 'label', 'percent', 'state', 'total', 'updated']);
  assert.equal(parsed.label, 'Shader pre-compile');
  assert.equal(JSON.stringify(parsed).includes(dir), false, 'no path in the file');
});

test('the file is written beside and renamed over, never written in place', () => {
  const out = '<drive>/overlay/precompile.json';
  const calls = [];
  const fake = {
    mkdirSync: (...a) => calls.push(['mkdir', ...a]),
    writeFileSync: (p, data) => calls.push(['write', p, data]),
    renameSync: (from, to) => calls.push(['rename', from, to]),
  };
  write(out, stateFrom(['progress translated 5 of 10'], { startedMs: 0, nowMs: 1000 }), fake);
  const writes = calls.filter((c) => c[0] === 'write');
  const renames = calls.filter((c) => c[0] === 'rename');
  assert.equal(writes.length, 1);
  assert.equal(writes[0][1], `${out}.tmp`);
  assert.equal(renames.length, 1);
  assert.deepEqual(renames[0].slice(1), [`${out}.tmp`, out]);
  assert.equal(calls.some((c) => c[0] === 'write' && c[1] === out), false, 'no write in place');
});

test('final writes the finished state from the command line', (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log.warm');
  fs.writeFileSync(log, 'containers   9 (0 duplicates skipped)\nprograms     10 translated of 12 (34 IR instructions)\n');
  const out = path.join(dir, 'precompile.json');
  const result = spawnSync(process.execPath, [script, 'final', '--log', log, '--out', out, '--started-ms', '0', '--exit', '0'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(parsed.state, 'done');
  assert.equal(parsed.done, 10);
  assert.equal(parsed.total, 12);
  assert.equal(parsed.percent, 83.3);
});

test('overlayJson keeps exactly the overlay fields', () => {
  const json = overlayJson({
    updated: 'now',
    state: 'running',
    label: 'Shader pre-compile',
    done: 1,
    total: null,
    percent: null,
    elapsed_s: 3,
    eta_s: null,
    finished: false,
  });
  assert.equal('finished' in json, false);
});

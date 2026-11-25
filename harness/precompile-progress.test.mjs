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
  // One bar across both phases: the translation is the bar's first 30% (see the shares in the script).
  assert.equal(state.percent, 1.4);
  assert.equal(state.phase, 'translating');

  // The total alone is enough to draw a bar at zero.
  const before = stateFrom(['progress total programs=26148 containers=25985'], { startedMs: 0, nowMs: 1000 });
  assert.equal(before.done, 0);
  assert.equal(before.total, 26148);
  assert.equal(before.percent, 0);
});

test('the two phases share one bar by their measured times', () => {
  const lines = [
    'progress total programs=100 containers=2',
    'progress translated 100 of 100 refused=0 failed_validation=0',
    'progress pipelines total=1000',
    'progress pipelines 250 of 1000 failed=0',
  ];
  const state = stateFrom(lines, { startedMs: 0, nowMs: 5000 });
  assert.equal(state.phase, 'pipelines');
  // 30% for the finished translation and 70% of a quarter of the pipelines: 47.5.
  assert.equal(state.percent, 47.5);
  assert.equal(state.done, 250);
  assert.equal(state.total, 1000);
  assert.equal(state.translate_done, 100);
  assert.equal(state.translate_total, 100);
  assert.equal(state.pipelines_done, 250);
  assert.equal(state.pipelines_total, 1000);
});

test('before the pipelines total arrives the bar tops out at the translate share', () => {
  const raw = ['progress total programs=100 containers=1', 'progress translated 100 of 100 refused=0 failed_validation=0'];
  let state = stateFrom(raw, { startedMs: 1000, nowMs: 11_000 });
  assert.equal(state.phase, 'translating');
  assert.equal(state.percent, 30);
  // It took 10 s to translate; the pipelines phase is estimated from the measured split.
  assert.equal(state.eta_s, Math.round((10 * 0.7) / 0.3));
  state = stateFrom([...raw, 'progress pipelines total=1000'], { startedMs: 1000, nowMs: 11_000 });
  assert.equal(state.phase, 'pipelines');
  assert.equal(state.percent, 30);
  assert.equal(state.eta_s, null, 'no pipelines count yet, so no rate');
});

test('a one-phase warm-up shows the whole bar over its translation', () => {
  const lines = ['progress total programs=100 containers=1', 'progress translated 50 of 100 refused=0 failed_validation=0'];
  const state = stateFrom(lines, { startedMs: 0, nowMs: 2000, onePhase: true });
  assert.equal(state.percent, 50);
  assert.equal(state.phase, 'translating');
  // A build that does print pipeline lines takes it back to the two-phase bar.
  const both = stateFrom(
    ['progress total programs=100 containers=1', 'progress translated 100 of 100 refused=0 failed_validation=0', 'progress pipelines total=1000', 'progress pipelines 500 of 1000 failed=0'],
    { startedMs: 0, nowMs: 2000, onePhase: true },
  );
  assert.equal(both.percent, 65);
  assert.equal(both.phase, 'pipelines');
});

test('the estimate is the rest of this phase plus the other phase at the measured split', () => {
  const lines = ['progress total programs=100 containers=1', 'progress translated 50 of 100 refused=0 failed_validation=0'];
  // 50 programs in 5 s: 5 s left here, plus the whole translation's time (10 s) at 70:30 for pipelines.
  const state = stateFrom(lines, { startedMs: 0, nowMs: 5000, samples: [{ ms: 0, translateDone: 0 }] });
  assert.equal(state.eta_s, 28);
});

test('a pipeline phase that stops moving gives no estimate', () => {
  const lines = [
    'progress total programs=1 containers=1',
    'progress translated 1 of 1 refused=0 failed_validation=0',
    'progress pipelines total=1000',
    'progress pipelines 500 of 1000 failed=0',
  ];
  const stalled = [{ ms: 0, pipelinesDone: 500 }, { ms: 20_000, pipelinesDone: 500 }, { ms: 30_000, pipelinesDone: 500 }];
  assert.equal(stateFrom(lines, { startedMs: 0, nowMs: 40_000, samples: stalled }).eta_s, null);
  // 300 pipelines in the 30-second window: 10 a second, 50 s for the rest.
  const moving = [{ ms: 10_000, pipelinesDone: 200 }];
  assert.equal(stateFrom(lines, { startedMs: 0, nowMs: 40_000, samples: moving }).eta_s, 50);
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
  const state = stateFrom(['shader translated stage="pixel" hash=0123456789abcdef', 'shader translated stage="compute" hash=76543210fedcba98'], {
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
  assert.deepEqual(Object.keys(parsed).sort(), [
    'done',
    'elapsed_s',
    'eta_s',
    'label',
    'percent',
    'phase',
    'pipelines_done',
    'pipelines_total',
    'state',
    'total',
    'translate_done',
    'translate_total',
    'updated',
  ]);
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
    phase: 'pipelines',
    done: 1,
    total: null,
    translate_done: 10,
    translate_total: 10,
    pipelines_done: 1,
    pipelines_total: null,
    percent: null,
    elapsed_s: 3,
    eta_s: null,
    finished: false,
  });
  assert.equal('finished' in json, false);
  assert.equal(json.phase, 'pipelines');
  assert.equal(json.translate_done, 10);
  assert.equal(json.pipelines_done, 1);
});

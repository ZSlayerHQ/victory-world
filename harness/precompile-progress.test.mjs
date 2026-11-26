import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { FALLBACK_EXPECTED, etaFromRate, expectedFromLogs, makeTicker, overlayJson, plain, stateFrom, write } from './precompile-progress.mjs';

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

test('a build that prints pipeline lines takes the bar to the two-phase form', () => {
  const state = stateFrom(
    ['progress total programs=100 containers=1', 'progress translated 100 of 100 refused=0 failed_validation=0', 'progress pipelines total=1000', 'progress pipelines 500 of 1000 failed=0'],
    { startedMs: 0, nowMs: 2000 },
  );
  assert.equal(state.percent, 65);
  assert.equal(state.phase, 'pipelines');
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

test('the log prefixes each line with its tracing header, and the counters still read', () => {
  // The shapes the warm-up actually wrote (2026-11-25 09:19:54, the first pre-compile with the bar).
  const lines = [
    '2026-11-25T09:19:54.011627Z  INFO victory::translate: progress total programs=25758 containers=26599',
    '2026-11-25T09:20:40.291874Z  INFO victory::translate: progress translated 12 of 25758 refused=0 failed_validation=0',
    '2026-11-25T09:20:46.339299Z  INFO victory::translate: progress translated 643 of 25758 refused=0 failed_validation=0',
  ];
  const state = stateFrom(lines, { startedMs: Date.parse('2026-11-25T09:18:56.000000Z'), nowMs: Date.parse('2026-11-25T09:22:10.000000Z') });
  assert.equal(state.translate_total, 25758);
  assert.equal(state.translate_done, 643);
  assert.ok(state.percent > 0 && state.percent < 3, `percent was ${state.percent}`);
});

test('a blocked overlay write is retried on the next tick and never throws; other failures are logged', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'precompile-feed-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, 'warm.log');
  fs.writeFileSync(log, '2026-11-25T09:19:54Z  INFO victory::translate: progress total programs=100 containers=2\n');
  const out = path.join(dir, 'precompile.json');

  let busy = 2;
  let failing = 0;
  const warnings = [];
  const fsOps = {
    mkdirSync: fs.mkdirSync,
    writeFileSync: (...args) => {
      if (failing > 0) {
        failing -= 1;
        const err = new Error('io');
        err.code = 'EIO';
        throw err;
      }
      return fs.writeFileSync(...args);
    },
    renameSync: (...args) => {
      if (busy > 0) {
        busy -= 1;
        const err = new Error('held by a reader');
        err.code = 'EBUSY';
        throw err;
      }
      return fs.renameSync(...args);
    },
  };
  const { tick } = makeTicker({ log, out, startedMs: 0, intervalMs: 0, fsOps, warn: (m) => warnings.push(m) });
  tick();
  tick();
  assert.equal(fs.existsSync(out), false, 'two blocked writes leave no file, and no exception escaped');
  assert.equal(warnings.length, 0, 'a reader holding the file is retried without noise');
  tick();
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).total, 100, 'the third tick writes');

  failing = 1;
  fs.rmSync(out);
  tick();
  assert.equal(fs.existsSync(out), false, 'a real failure leaves the file as it was');
  assert.match(warnings[0], /overlay write failed \(EIO\)/);
  tick();
  assert.equal(JSON.parse(fs.readFileSync(out, 'utf8')).total, 100, 'the loop carries on after a logged failure');
});

// What a warm log really holds (2026-11-26): ANSI-coloured tracing lines, one per program and per compute pipeline, no
// totals and no `progress` lines, and a closing `warm ...` line. The lines below are synthetic, in that shape.
const ESC = '\x1b';
const coloured = (level, target, message) =>
  `${ESC}[2m2026-11-26T04:24:51.988492Z${ESC}[0m ${level} ${ESC}[2m${target}${ESC}[0m${ESC}[2m:${ESC}[0m ${message}`;
const translatedLine = (stage = 'pixel') =>
  coloured(`${ESC}[32m INFO${ESC}[0m`, 'victory_gpu::pipeline', `shader translated ${ESC}[3mstage${ESC}[0m${ESC}[2m=${ESC}[0m"${stage}" ${ESC}[3mhash${ESC}[0m${ESC}[2m=${ESC}[0mabc`);
const refusedLine = () =>
  coloured(`${ESC}[33m WARN${ESC}[0m`, 'victory_gpu::pipeline', `shader does not translate; its pipelines' draws are dropped ${ESC}[3mstage${ESC}[0m${ESC}[2m=${ESC}[0m"mesh"`);
const pipelineLine = () =>
  coloured(`${ESC}[32m INFO${ESC}[0m`, 'victory_gpu::pipeline::host', `host pipeline ${ESC}[3mshaders${ESC}[0m${ESC}[2m=${ESC}[0m[compute abc]`);
const pipelineRefusedLine = () =>
  coloured(`${ESC}[33m WARN${ESC}[0m`, 'victory_gpu::pipeline::host', `host pipeline refused ${ESC}[3merror${ESC}[0m${ESC}[2m=${ESC}[0mx`);
const libraryLine = () =>
  coloured(`${ESC}[32m INFO${ESC}[0m`, 'victory_gpu::pipeline::library', `host pipeline library saved ${ESC}[3mbytes${ESC}[0m${ESC}[2m=${ESC}[0m5`);
const EXPECTED = { programs: 10, pipelines: 5 };

test('ANSI colour codes and the tracing header are stripped before a line is matched', () => {
  assert.equal(plain(translatedLine()), 'shader translated stage="pixel" hash=abc');
  assert.equal(plain(pipelineLine()), 'host pipeline shaders=[compute abc]');
  // The colour codes split `programs=100` and `pipelines=0` into pieces; the older progress lines still read.
  const split = [
    coloured(' INFO', 'victory::translate', `progress total ${ESC}[3mprograms${ESC}[0m${ESC}[2m=${ESC}[0m100 ${ESC}[3mcontainers${ESC}[0m${ESC}[2m=${ESC}[0m2`),
    coloured(' INFO', 'victory::translate', `progress translated 40 of 100 refused=0 failed_validation=0`),
  ];
  const state = stateFrom(split, { startedMs: 0, nowMs: 1000 });
  assert.equal(state.translate_total, 100);
  assert.equal(state.translate_done, 40);
  assert.equal(state.percent, 12);
});

test("today's log: every program and compute pipeline line counts, against the expected totals", () => {
  const lines = [translatedLine(), translatedLine('compute'), translatedLine('mesh'), refusedLine(), libraryLine()];
  let state = stateFrom(lines, { startedMs: 0, nowMs: 2000, expected: EXPECTED });
  assert.equal(state.state, 'running');
  assert.equal(state.translate_done, 4, 'translated and refused programs, not the library line');
  assert.equal(state.translate_total, 10);
  assert.equal(state.pipelines_done, null);
  assert.equal(state.phase, 'translating');
  assert.equal(state.percent, 12);
  // Two pipelines, one of them refused, are two of five: 30% of 0.4 and 70% of 0.4.
  state = stateFrom([...lines, pipelineLine(), pipelineRefusedLine()], { startedMs: 0, nowMs: 2000, expected: EXPECTED });
  assert.equal(state.phase, 'pipelines');
  assert.equal(state.pipelines_done, 2);
  assert.equal(state.pipelines_total, 5);
  assert.equal(state.percent, 40);
});

test('the bar rises with every stage of a warm-up and ends at 100 on the closing line', () => {
  const lines = [];
  const seen = [];
  const at = (extra) => {
    lines.push(...extra);
    seen.push(stateFrom([...lines], { startedMs: 0, nowMs: 5000, expected: EXPECTED }).percent);
  };
  at([translatedLine(), translatedLine()]);
  at([translatedLine(), refusedLine(), translatedLine()]);
  at([pipelineLine()]);
  at([translatedLine('compute'), pipelineLine(), pipelineLine()]);
  at([translatedLine(), translatedLine(), translatedLine('compute'), pipelineLine(), pipelineLine()]);
  for (let i = 1; i < seen.length; i += 1) assert.ok(seen[i] > seen[i - 1], `percent did not rise: ${seen.join(', ')}`);
  assert.ok(seen.every((p) => p !== null && p <= 100), seen.join(', '));
  const closing = 'warm         10 translated, 0 refused; 4 compute pipelines, 1 refused; 12 s';
  const done = stateFrom([...lines, libraryLine(), closing], { startedMs: 0, nowMs: 13_000, expected: EXPECTED });
  assert.equal(done.state, 'done');
  assert.equal(done.percent, 100);
  assert.equal(done.translate_done, 10);
  assert.equal(done.pipelines_done, 5);
  assert.equal(done.eta_s, null);
});

test('a warm-up larger than the expected totals grows them instead of passing 100', () => {
  const lines = [...Array(12).fill(0).map(() => translatedLine()), ...Array(7).fill(0).map(() => pipelineLine())];
  const state = stateFrom(lines, { startedMs: 0, nowMs: 1000, expected: EXPECTED });
  assert.equal(state.translate_total, 12);
  assert.equal(state.pipelines_total, 7);
  assert.equal(state.percent, 100);
});

test('the closing line is read through colour codes and gives the totals itself', () => {
  const closing = `${ESC}[2mwarm${ESC}[0m         25669 translated, 89 refused; 2695 compute pipelines, 1 refused; 261 s`;
  const state = stateFrom([closing], { startedMs: 0, nowMs: 1000 });
  assert.equal(state.state, 'done');
  assert.equal(state.translate_total, 25_758);
  assert.equal(state.pipelines_total, 2_696);
  assert.equal(state.percent, 100);
});

test('expected totals come from the newest earlier warm log with a closing line, else the fallback', (t) => {
  const dir = tempDir(t);
  const write = (name, text, ageSeconds) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, text);
    const when = new Date(Date.now() - ageSeconds * 1000);
    fs.utimesSync(file, when, when);
    return file;
  };
  assert.deepEqual(expectedFromLogs(dir), FALLBACK_EXPECTED, 'no warm logs');
  assert.deepEqual(expectedFromLogs(path.join(dir, 'missing')), FALLBACK_EXPECTED, 'no folder');
  write('a.log.warm', `${translatedLine()}\nwarm  70 translated, 30 refused; 8 compute pipelines, 2 refused; 9 s\n`, 300);
  write('b.log.warm', `${translatedLine()}\nwarm  1 translated, 0 refused; 0 compute pipelines, 0 refused; 1 s\n`, 200);
  write('c.log.warm', `${translatedLine()}\n`, 100);
  const current = write('d.log.warm', 'warm  5 translated, 5 refused; 5 compute pipelines, 5 refused; 1 s\n', 0);
  write('e.log', 'warm  9 translated, 9 refused; 9 compute pipelines, 9 refused; 1 s\n', 0);
  // The current log is never its own reference; a failed run (no closing line) and a pipeline-less one are passed over.
  assert.deepEqual(expectedFromLogs(dir, current), { programs: 100, pipelines: 10 });
});

test('final reads a failed run with no closing line against the earlier warm-up in its folder', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'earlier.log.warm'), 'warm  15 translated, 5 refused; 8 compute pipelines, 2 refused; 9 s\n');
  const log = path.join(dir, 'now.log.warm');
  fs.writeFileSync(log, [translatedLine(), translatedLine(), refusedLine(), pipelineLine()].join('\n'));
  const out = path.join(dir, 'precompile.json');
  const result = spawnSync(process.execPath, [script, 'final', '--log', log, '--out', out, '--started-ms', '0', '--exit', '3'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(fs.readFileSync(out, 'utf8'));
  assert.equal(parsed.state, 'failed');
  assert.equal(parsed.translate_done, 3);
  assert.equal(parsed.translate_total, 20);
  assert.equal(parsed.pipelines_done, 1);
  assert.equal(parsed.pipelines_total, 10);
  assert.equal(parsed.percent, 11.5);
});

test('the one-phase flag is gone from the script and from the run wrapper', () => {
  const result = spawnSync(process.execPath, [script, 'follow', '--log', 'x', '--one-phase'], { encoding: 'utf8' });
  assert.equal(result.status, 2, 'an unknown flag is refused, not ignored');
  assert.match(result.stderr, /unknown argument --one-phase/);
  const wrapper = fs.readFileSync(path.join(here, 'run-world.sh'), 'utf8');
  assert.equal(wrapper.includes('--one-phase'), false);
});

test('a feed that follows today-format lines writes a rising percentage', (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'warm.log');
  const out = path.join(dir, 'precompile.json');
  fs.writeFileSync(log, `${translatedLine()}\n${translatedLine()}\n`);
  const { tick } = makeTicker({ log, out, startedMs: 0, expected: EXPECTED, intervalMs: 0 });
  tick();
  const first = JSON.parse(fs.readFileSync(out, 'utf8')).percent;
  fs.appendFileSync(log, `${translatedLine()}\n${pipelineLine()}\n`);
  tick();
  const second = JSON.parse(fs.readFileSync(out, 'utf8')).percent;
  assert.ok(first > 0 && second > first, `${first} then ${second}`);
});

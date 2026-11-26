import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  formatDriveReport,
  loadTimeline,
  normalizePlan,
  occurrencesOf,
  reportRows,
  runPlan,
  timelinePath,
} from './live-drive.mjs';
import { parseAssignment, readControl } from './live.mjs';
import { LIVE_NAMES } from './live-names.mjs';
import { parseLiveLog } from './live-report.mjs';
import { isolatedEnv } from './test-isolation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'live-drive.mjs');

const sink = { write() {} };
const fast = { holdScale: 0.01, markerTimeoutMs: 1000, stallMs: 3000, pollMs: 10 };

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-drive-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function stateOf(file) {
  let text = '';
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    // A missing file means no assignments.
  }
  const state = {};
  for (const line of text.split(/\r?\n/)) {
    const assignment = parseAssignment(line);
    if (assignment && LIVE_NAMES.includes(assignment.name)) state[assignment.name] = assignment.value;
  }
  return state;
}

function sameState(state, wanted) {
  return LIVE_NAMES.every((name) => (state[name] ?? null) === (wanted[name] ?? null));
}

/// A stand-in for the runtime: whenever the control file's live values move, it closes the stretch that just
/// ended (a segment line) and then logs one marker per changed name. Frame lines keep the log growing.
function fakeGame(
  t,
  {
    log,
    control,
    baseline = {},
    answer = true,
    frames = true,
    stopAfterChanges = Infinity,
    failureLine = null,
    prelude = '',
    baselineMean = 20,
    stepMean = 10,
  },
) {
  fs.writeFileSync(log, `fake title log\n${prelude}`);
  let state = stateOf(control);
  let segment = 0;
  let frame = 1;
  let changes = 0;
  let stopped = false;
  let failureWritten = false;
  const timer = setInterval(() => {
    if (stopped) return;
    if (failureLine && !failureWritten) {
      fs.appendFileSync(log, `${failureLine}\n`);
      failureWritten = true;
    }
    if (frames) fs.appendFileSync(log, `frame ${frame}, 4.6 fps, 216.0 ms/frame\n`);
    if (!answer) return;
    const next = stateOf(control);
    const changed = LIVE_NAMES.filter((name) => (state[name] ?? null) !== (next[name] ?? null));
    if (!changed.length) return;
    segment += 1;
    const mean = sameState(state, baseline) ? baselineMean : stepMean;
    const inForce = LIVE_NAMES.map((name) => `${name}=${state[name] ?? ''}`).join(' ');
    fs.appendFileSync(
      log,
      `live segment ${segment}: frames ${frame}..${frame + 120}, mean ${mean.toFixed(1)}, ` +
        `p50 ${mean.toFixed(1)}, p95 ${(mean + 2).toFixed(1)}, skipped 0 draws and 0 dispatches, ` +
        `in force: ${inForce}\n`,
    );
    frame += 121;
    for (const name of changed) {
      fs.appendFileSync(
        log,
        `live: ${name} ${state[name] ?? ''} -> ${next[name] ?? ''} at frame ${frame}\n`,
      );
    }
    state = next;
    changes += 1;
    if (changes >= stopAfterChanges) stopped = true;
  }, 10);
  t.after(() => {
    stopped = true;
    clearInterval(timer);
  });
  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
    segmentCount() {
      return segment;
    },
  };
}

function appendShutdown(gameLog, inForce) {
  const last = parseLiveLog(fs.readFileSync(gameLog, 'utf8')).at(-1);
  const first = last ? last.lastFrame + 1 : 1;
  const text = LIVE_NAMES.map((name) => `${name}=${inForce[name] ?? ''}`).join(' ');
  fs.appendFileSync(
    gameLog,
    `live segment ${last ? last.segment + 1 : 1}: frames ${first}..${first + 120}, mean 20.0, ` +
      `p50 20.0, p95 22.0, skipped 0 draws and 0 dispatches, in force: ${text}\n`,
  );
}

function planFor(steps, extra = {}) {
  return {
    baseline: { VICTORY_KEEP_TEXTURES: 'on' },
    steps,
    ...extra,
  };
}

test('a plan is normalized: values become strings, booleans become on/off', () => {
  const plan = normalizePlan({
    baseline: { VICTORY_KEEP_TEXTURES: true, VICTORY_TEXTURE_LOW: 60 },
    steps: [{ label: ' one ', set: { LIVE_SKIP_DRAW: '12,34' }, hold_s: 30 }],
  });
  assert.deepEqual(plan.baseline, { VICTORY_KEEP_TEXTURES: 'on', VICTORY_TEXTURE_LOW: '60' });
  assert.equal(plan.steps[0].label, 'one');
  assert.equal(plan.repeat, 1);
});

test('the refusals: unknown names, over 40 steps, over 45 minutes, a bad hold, repeat or label', () => {
  const step = (label, hold = 30) => ({ label, set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: hold });
  const cases = [
    [
      { baseline: { NOT_A_SWITCH: '1' }, steps: [step('a')] },
      /baseline: 'NOT_A_SWITCH' is not a live switch/,
    ],
    [
      { baseline: {}, steps: [{ label: 'a', set: { lower: '1' }, hold_s: 30 }] },
      /not a switch name/,
    ],
    [
      { baseline: {}, steps: Array.from({ length: 41 }, (_, i) => step(`s${i}`, 10)) },
      /41 steps; the limit is 40/,
    ],
    [
      { baseline: {}, steps: [step('slow', 300)], repeat: 5 },
      /the limit is 45 minutes/,
    ],
    [{ baseline: {}, steps: [step('short', 9)] }, /between 10 and 300 seconds/],
    [{ baseline: {}, steps: [step('long', 301)] }, /between 10 and 300 seconds/],
    [{ baseline: {}, steps: [step('a')], repeat: 0 }, /repeat must be a positive integer/],
    [{ baseline: {}, steps: [step('a'), step('a')] }, /duplicate label 'a'/],
    [
      { baseline: {}, steps: [{ label: 'two\nlines', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 }] },
      /may not contain a newline/,
    ],
  ];
  for (const [plan, message] of cases) {
    assert.throws(() => normalizePlan(plan), message);
  }
});

test('the repeat reverses the list on the second pass and reverses back on the third', () => {
  const plan = normalizePlan({
    baseline: {},
    steps: [
      { label: 'a', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 },
      { label: 'b', set: { VICTORY_TEXTURE_HIGH: '85' }, hold_s: 10 },
    ],
    repeat: 3,
  });
  assert.deepEqual(
    occurrencesOf(plan).map((occurrence) => `${occurrence.label}:${occurrence.direction}`),
    ['a:forward', 'b:forward', 'b:reverse', 'a:reverse', 'a:forward', 'b:forward'],
  );
});

test('the runner brackets every step A, B, A, reverses the second pass, and ends at the baseline', async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  const control = path.join(dir, 'live.txt');
  const plan = planFor(
    [
      { label: 'low', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 },
      { label: 'skip', set: { LIVE_SKIP_DRAW: '12,34' }, hold_s: 10 },
    ],
    { repeat: 2 },
  );
  const game = fakeGame(t, { log, control, baseline: plan.baseline });

  const result = await runPlan(plan, {
    logFile: log,
    controlFile: control,
    out: sink,
    err: sink,
    ...fast,
  });

  assert.deepEqual(
    result.occurrences.map((occurrence) => occurrence.label),
    ['low', 'skip', 'skip', 'low'],
  );
  assert.deepEqual(
    result.occurrences.map((occurrence) => occurrence.direction),
    ['forward', 'forward', 'reverse', 'reverse'],
  );
  assert.deepEqual(stateOf(control), { VICTORY_KEEP_TEXTURES: 'on' }, 'the baseline is restored');

  for (let i = 0; i < result.occurrences.length; i += 1) {
    const occurrence = result.occurrences[i];
    assert.ok(occurrence.beforeSegment, `${occurrence.label}: a baseline segment before the step`);
    assert.ok(occurrence.stepSegment, `${occurrence.label}: a step segment`);
    assert.ok(occurrence.beforeSegment < occurrence.stepSegment, `${occurrence.label}: before is not the step`);
    if (i > 0) {
      assert.equal(
        result.occurrences[i - 1].afterSegment,
        occurrence.beforeSegment,
        'the A after one B is the A before the next',
      );
    }
  }
  assert.equal(result.occurrences.at(-1).afterSegment, null, 'the final baseline closes only when the title exits');

  game.stop();
  appendShutdown(log, plan.baseline);
  const segments = parseLiveLog(fs.readFileSync(log, 'utf8'));
  const timeline = loadTimeline(log);
  assert.equal(timeline.finishedAt != null, true);
  assert.equal(timeline.restored, true);
  assert.equal(timeline.stopped, null);

  const rows = reportRows(segments, timeline);
  assert.deepEqual(rows.map((row) => row.label), ['low', 'skip']);
  for (const row of rows) {
    assert.equal(row.mean, 10);
    assert.equal(row.baseline, 20);
    assert.equal(row.difference, -10);
    assert.equal(row.percent, -50);
    assert.equal(row.spread, 0);
    assert.equal(row.verdict, 'faster');
    assert.deepEqual(row.reason, []);
  }
  assert.match(formatDriveReport(rows, timeline), /\| low \| VICTORY_TEXTURE_LOW=60 \| 10\.0 \|/);
});

test('a marker that never appears stops the run, restores the baseline and keeps the file comments', async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  const control = path.join(dir, 'live.txt');
  fs.writeFileSync(control, '# keep me\nVICTORY_KEEP_TEXTURES=on # the baseline note\n');
  const plan = {
    baseline: { VICTORY_KEEP_TEXTURES: 'on' },
    steps: [{ label: 'low', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 }],
  };
  fakeGame(t, { log, control, baseline: plan.baseline, answer: false });

  await assert.rejects(
    runPlan(plan, { logFile: log, controlFile: control, out: sink, err: sink, ...fast, markerTimeoutMs: 200 }),
    /timed out after 200 ms waiting for the game to log VICTORY_TEXTURE_LOW; the game is not reading the control file/,
  );
  assert.equal(fs.readFileSync(control, 'utf8'), '# keep me\nVICTORY_KEEP_TEXTURES=on # the baseline note\n');
  const timeline = loadTimeline(log);
  assert.equal(timeline.restored, true);
  assert.match(timeline.stopped, /not reading the control file/);
});

test('a log that stops growing stops the run and restores the baseline', async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  const control = path.join(dir, 'live.txt');
  const plan = planFor([{ label: 'low', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 }]);
  fakeGame(t, { log, control, baseline: plan.baseline, stopAfterChanges: 1 });

  await assert.rejects(
    runPlan(plan, { logFile: log, controlFile: control, out: sink, err: sink, ...fast, stallMs: 200 }),
    /the run log has not grown for 200 ms; the game ended or hung/,
  );
  assert.deepEqual(stateOf(control), { VICTORY_KEEP_TEXTURES: 'on' });
  assert.match(loadTimeline(log).stopped, /has not grown/);
});

test('a device-removed line stops the run and restores the baseline', async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  const control = path.join(dir, 'live.txt');
  const plan = planFor([{ label: 'low', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 }]);
  fakeGame(t, {
    log,
    control,
    baseline: plan.baseline,
    failureLine: 'DXGI_ERROR_DEVICE_REMOVED: /made/up/private/title/file was open',
  });

  let caught = null;
  await assert.rejects(
    runPlan(plan, { logFile: log, controlFile: control, out: sink, err: sink, ...fast }),
    (err) => {
      caught = err;
      return /the log carries 'DXGI_ERROR'/.test(err.message);
    },
  );
  assert.equal(caught.message.includes('/made/up/private'), false, 'the raw log line is not echoed');
  assert.deepEqual(stateOf(control), { VICTORY_KEEP_TEXTURES: 'on' });
  assert.match(loadTimeline(log).stopped, /DXGI_ERROR/);
});

test('a step mean over five times the first baseline stops the run and restores the baseline', async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  const control = path.join(dir, 'live.txt');
  const plan = planFor([{ label: 'low', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 }]);
  fakeGame(t, { log, control, baseline: plan.baseline, stepMean: 200 });

  await assert.rejects(
    runPlan(plan, { logFile: log, controlFile: control, out: sink, err: sink, ...fast }),
    /over five times the first baseline's 20\.0 ms/,
  );
  assert.deepEqual(stateOf(control), { VICTORY_KEEP_TEXTURES: 'on' });
  assert.match(loadTimeline(log).stopped, /five times/);
});

test('an interrupt during a hold restores the baseline', async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  const control = path.join(dir, 'live.txt');
  const plan = planFor([{ label: 'low', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 }]);
  fakeGame(t, { log, control, baseline: plan.baseline });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60);
  t.after(() => clearTimeout(timer));

  await assert.rejects(
    runPlan(plan, {
      logFile: log,
      controlFile: control,
      out: sink,
      err: sink,
      ...fast,
      signal: controller.signal,
    }),
    (err) => err.exitCode === 130 && /interrupted/.test(err.message),
  );
  assert.deepEqual(stateOf(control), { VICTORY_KEEP_TEXTURES: 'on' });
  assert.equal(loadTimeline(log).restored, true);
});

function cannedSegments(entries) {
  const lines = entries.map((entry, index) => {
    const first = 1 + index * 200;
    const frames = entry.frames ?? 200;
    return (
      `live segment ${index + 1}: frames ${first}..${first + frames - 1}, mean ${entry.mean.toFixed(1)}, ` +
      `p50 ${entry.mean.toFixed(1)}, p95 ${(entry.p95 ?? entry.mean + 2).toFixed(1)}, skipped 0 draws and ` +
      `0 dispatches, in force: VICTORY_KEEP_TEXTURES=on`
    );
  });
  return parseLiveLog(lines.join('\n'));
}

function timelineFor(occurrences) {
  return { version: 1, occurrences };
}

function occurrence(label, set, beforeSegment, stepSegment, afterSegment, pass = 1) {
  return {
    label,
    set,
    pass,
    direction: pass === 1 ? 'forward' : 'reverse',
    beforeSegment,
    stepSegment,
    afterSegment,
  };
}

test('the report gives the four verdict words: faster, slower, no difference, unreliable', () => {
  const faster = reportRows(
    cannedSegments([{ mean: 20 }, { mean: 10 }, { mean: 20 }]),
    timelineFor([occurrence('fast', { VICTORY_TEXTURE_LOW: '60' }, 1, 2, 3)]),
  );
  assert.equal(faster[0].mean, 10);
  assert.equal(faster[0].baseline, 20);
  assert.equal(faster[0].difference, -10);
  assert.equal(faster[0].percent, -50);
  assert.equal(faster[0].verdict, 'faster');
  assert.deepEqual(faster[0].reason, []);

  const slower = reportRows(
    cannedSegments([{ mean: 20 }, { mean: 30 }, { mean: 20 }]),
    timelineFor([occurrence('slow', { VICTORY_TEXTURE_LOW: '80' }, 1, 2, 3)]),
  );
  assert.equal(slower[0].difference, 10);
  assert.equal(slower[0].percent, 50);
  assert.equal(slower[0].verdict, 'slower');

  const same = reportRows(
    cannedSegments([{ mean: 20 }, { mean: 21.5 }, { mean: 21 }, { mean: 22.5 }, { mean: 22 }]),
    timelineFor([
      occurrence('same', { VICTORY_TEXTURE_LOW: '65' }, 1, 2, 3, 1),
      occurrence('same', { VICTORY_TEXTURE_LOW: '65' }, 3, 4, 5, 2),
    ]),
  );
  assert.equal(same[0].mean, 22);
  assert.equal(same[0].baseline, 21);
  assert.equal(same[0].difference, 1);
  assert.equal(same[0].spread, 1);
  assert.equal(same[0].verdict, 'no difference');

  const short = reportRows(
    cannedSegments([{ mean: 20 }, { mean: 10, frames: 50 }, { mean: 20 }]),
    timelineFor([occurrence('short', { VICTORY_TEXTURE_LOW: '60' }, 1, 2, 3)]),
  );
  assert.equal(short[0].verdict, 'unreliable');
  assert.match(short[0].reason.join(' '), /step stretch is short \(50 frames\)/);
});

test('the report calls a drifted bracket unreliable when the baselines differ by more than the effect', () => {
  const rows = reportRows(
    cannedSegments([{ mean: 20 }, { mean: 24 }, { mean: 30 }]),
    timelineFor([occurrence('drift', { VICTORY_TEXTURE_LOW: '60' }, 1, 2, 3)]),
  );
  assert.equal(rows[0].difference, -1);
  assert.equal(rows[0].verdict, 'unreliable');
  assert.match(rows[0].reason.join(' '), /the two baselines differ by 10\.0 ms, more than the 1\.0 ms effect/);
});

test('a missing closing baseline is unreliable and named, and the table shows the verdict words', () => {
  const rows = reportRows(
    cannedSegments([{ mean: 20 }, { mean: 10 }]),
    timelineFor([occurrence('open', { VICTORY_TEXTURE_LOW: '60' }, 1, 2, null)]),
  );
  assert.equal(rows[0].verdict, 'unreliable');
  assert.match(rows[0].reason.join(' '), /baseline after the step is not in the log yet/);
  const text = formatDriveReport(rows, timelineFor([occurrence('open', {}, 1, 2, null)]));
  assert.match(
    text,
    /\| label \| set to \| mean \(ms\) \| p95 \(ms\) \| baseline \(ms\) \| difference \| repeat spread \(ms\) \| verdict \|/,
  );
  assert.match(text, /unreliable/);
});

test('report --log --json reads the sidecar beside the log', (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  fs.writeFileSync(log, [
    'live segment 1: frames 1..200, mean 20.0, p50 20.0, p95 22.0, skipped 0 draws and 0 dispatches, ' +
      'in force: VICTORY_KEEP_TEXTURES=on',
    'live segment 2: frames 201..400, mean 10.0, p50 10.0, p95 12.0, skipped 0 draws and 0 dispatches, ' +
      'in force: VICTORY_KEEP_TEXTURES=on',
    'live segment 3: frames 401..600, mean 20.0, p50 20.0, p95 22.0, skipped 0 draws and 0 dispatches, ' +
      'in force: VICTORY_KEEP_TEXTURES=on',
  ].join('\n'));
  fs.writeFileSync(
    timelinePath(log),
    JSON.stringify(timelineFor([occurrence('low', { VICTORY_TEXTURE_LOW: '60' }, 1, 2, 3)])),
  );
  const result = spawnSync(process.execPath, [script, 'report', '--log', log, '--json'], {
    encoding: 'utf8',
    env: isolatedEnv(),
  });
  assert.equal(result.status, 0, result.stderr);
  const rows = JSON.parse(result.stdout);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].label, 'low');
  assert.equal(rows[0].verdict, 'faster');
  const text = spawnSync(process.execPath, [script, 'report', '--log', log], {
    encoding: 'utf8',
    env: isolatedEnv(),
  });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /# live-drive report/);
  assert.match(text.stdout, /\| low \| VICTORY_TEXTURE_LOW=60 \| 10\.0 \|/);
});

function cli(args, extra = {}) {
  const env = isolatedEnv(extra);
  if (!('VICTORY_LIVE' in extra)) delete env.VICTORY_LIVE;
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env });
}

test('the command line refuses a missing plan, log or control file', (t) => {
  const dir = tempDir(t);
  const planFile = path.join(dir, 'plan.json');
  const logFile = path.join(dir, 'run.log');
  fs.writeFileSync(planFile, JSON.stringify(planFor([{ label: 'a', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 }])));
  fs.writeFileSync(logFile, '');

  assert.equal(cli([]).status, 2);
  const noPlan = cli(['run', '--log', logFile, '--file', path.join(dir, 'live.txt')]);
  assert.equal(noPlan.status, 2);
  assert.match(noPlan.stderr, /run needs a plan file/);
  const noLog = cli(['run', planFile, '--file', path.join(dir, 'live.txt')]);
  assert.equal(noLog.status, 2);
  assert.match(noLog.stderr, /run needs --log/);
  const noControl = cli(['run', planFile, '--log', logFile]);
  assert.equal(noControl.status, 2);
  assert.match(noControl.stderr, /no control file/);
});

test('the command line refuses an unknown live name before it writes the control file', (t) => {
  const dir = tempDir(t);
  const planFile = path.join(dir, 'plan.json');
  const logFile = path.join(dir, 'run.log');
  const control = path.join(dir, 'live.txt');
  fs.writeFileSync(logFile, '');
  fs.writeFileSync(
    planFile,
    JSON.stringify({ baseline: {}, steps: [{ label: 'bad', set: { NOT_A_SWITCH: '1' }, hold_s: 10 }] }),
  );
  const result = cli(['run', planFile, '--log', logFile, '--file', control]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /'NOT_A_SWITCH' is not a live switch/);
  assert.equal(fs.existsSync(control), false, 'a refusal touches nothing');
});

test('the command line refuses a plan that is not JSON and a report without a log', (t) => {
  const dir = tempDir(t);
  const planFile = path.join(dir, 'plan.json');
  const logFile = path.join(dir, 'run.log');
  fs.writeFileSync(planFile, '{not json');
  fs.writeFileSync(logFile, '');
  const badPlan = cli(['run', planFile, '--log', logFile, '--file', path.join(dir, 'live.txt')]);
  assert.equal(badPlan.status, 2);
  assert.match(badPlan.stderr, /cannot read the plan/);
  const noLog = cli(['report']);
  assert.equal(noLog.status, 2);
  assert.match(noLog.stderr, /report needs --log/);
  const missingLog = cli(['report', '--log', path.join(dir, 'missing.log')]);
  assert.equal(missingLog.status, 1);
  assert.match(missingLog.stderr, /cannot read the run log/);
});

test('a device-removed line already in the log stops before the baseline is measured', async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  const control = path.join(dir, 'live.txt');
  const plan = planFor([{ label: 'low', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 }]);
  fakeGame(t, {
    log,
    control,
    baseline: plan.baseline,
    prelude: 'an earlier line: DXGI_ERROR_DEVICE_HUNG\n',
  });

  await assert.rejects(
    runPlan(plan, { logFile: log, controlFile: control, out: sink, err: sink, ...fast }),
    /the log carries 'DXGI_ERROR'/,
  );
  assert.deepEqual(stateOf(control), { VICTORY_KEEP_TEXTURES: 'on' });
});

test('a baseline already in force needs no marker, and the first step still measures', async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  const control = path.join(dir, 'live.txt');
  fs.writeFileSync(control, 'VICTORY_KEEP_TEXTURES=on\n');
  const plan = planFor([{ label: 'low', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 }]);
  const game = fakeGame(t, { log, control, baseline: plan.baseline });

  const result = await runPlan(plan, {
    logFile: log,
    controlFile: control,
    out: sink,
    err: sink,
    ...fast,
  });
  assert.equal(result.occurrences[0].stepSegment != null, true);
  game.stop();
  appendShutdown(log, plan.baseline);
  const rows = reportRows(parseLiveLog(fs.readFileSync(log, 'utf8')), loadTimeline(log));
  assert.equal(rows[0].verdict, 'faster');
});

test('a control file the runtime would ignore is refused before anything is written', async (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  const control = path.join(dir, 'live.txt');
  fs.writeFileSync(log, 'fake title log\n');
  fs.writeFileSync(control, '# a comment\nnot an assignment\n');
  const plan = planFor([{ label: 'low', set: { VICTORY_TEXTURE_LOW: '60' }, hold_s: 10 }]);

  await assert.rejects(
    runPlan(plan, { logFile: log, controlFile: control, out: sink, err: sink, ...fast }),
    /control file line 2 is not NAME=value/,
  );
  assert.equal(fs.readFileSync(control, 'utf8'), '# a comment\nnot an assignment\n');
});

test('the shell wrapper forwards to the module', () => {
  const result = spawnSync('bash', [path.join(here, 'live-drive.sh'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /usage: live-drive\.sh run <plan\.json>/);
});

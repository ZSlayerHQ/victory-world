import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_FLOOR_FPS,
  DEFAULT_TIMEOUT_S,
  DEFAULT_WAITING,
  SETTLED_LINES,
  due,
  PIPELINE_QUIET_MS,
  frameLine,
  initialState,
  observe,
  settleEndMarker,
  settledMarker,
  timeoutMarker,
  UNSETTLED_NOTE_MS,
  unmetText,
  unsettledMarker,
} from './settled-watch.mjs';

// Frame lines as the runtime wrote them (run merged-forks, 2026-11-25), cut after the texture queue's count.
const EARLY =
  '2026-11-25T04:17:12.475238Z  INFO victory_gpu::host: 30.0 fps, 33.3 ms/frame (1.9 preparing: copies 1.7 ms 0.2 MB, textures 0.0 ms 0.0 MB; 0.0 on the GPU; 0.0 copying back 0.0 MB), 13 draws/frame, dropped 0 without a host pipeline (1094 being made) and 0 indirect; heap buffers 0.0 passes 0.0 ms;                  texture slots written so far: 1105 placed, 5258 of objects; textures picked by index: 562 uploaded so far (202 MB), 0 waiting, 0 passed over unmapped;';
const HEAVY_LOADING =
  '2026-11-25T04:18:50.941475Z  INFO victory_gpu::host: 0.7 fps, 1487.9 ms/frame (748.9 preparing: copies 167.3 ms 253.0 MB, textures 533.6 ms 129.0 MB; 25.6 on the GPU; 111.1 copying back 78.2 MB), 1684 draws/frame, dropped 974 without a host pipeline (0 being made) and 12 indirect; heap buffers 0.5 passes 398.0 ms;                  texture slots written so far: 166326 placed, 30527 of objects; textures picked by index: 36247 uploaded so far (2945 MB), 1212 waiting, 1277 passed over unmapped;';
const PLAYING =
  '2026-11-25T04:19:47.751794Z  INFO victory_gpu::host: 2.9 fps, 349.4 ms/frame (171.5 preparing: copies 134.5 ms 198.8 MB, textures 13.9 ms 42.4 MB; 50.2 on the GPU; 89.6 copying back 77.8 MB), 1373 draws/frame, dropped 653 without a host pipeline (0 being made) and 0 indirect; heap buffers 0.7 passes 220.8 ms;                  texture slots written so far: 265289 placed, 68969 of objects; textures picked by index: 76958 uploaded so far (6427 MB), 1558 waiting, 6754 passed over unmapped;';
const later = (line, mmss) => line.replace(/T\d\d:\d\d:\d\d\.\d+Z/, `T04:${mmss}.000000Z`);

test('a frame line with the runtime frame-number prefix parses the same figures', () => {
  const line =
    '2026-11-26T05:02:11.250000Z  INFO victory_gpu::host: frame 18432, 27.4 fps, 36.5 ms/frame ' +
    '(0.4 preparing: copies 0.3 ms 1.2 MB, textures hashed 0.2 ms 0.1 MB; 1.7 on the GPU; ' +
    '0.1 copying back 0.9 MB), 5000 draws/frame, dropped 3 without a host pipeline (1 being made) and 7 indirect';
  assert.deepEqual(frameLine(line), {
    at: Date.parse('2026-11-26T05:02:11.250000Z'),
    fps: 27.4,
    draws: 5000,
    dropped: 3,
    making: 1,
    waiting: null,
  });
});

test('a frame line gives its figures, or nothing for another line', () => {
  assert.deepEqual(frameLine(HEAVY_LOADING), {
    at: Date.parse('2026-11-25T04:18:50.941475Z'),
    fps: 0.7,
    draws: 1684,
    dropped: 974,
    making: 0,
    waiting: 1212,
  });
  assert.equal(frameLine('2026-11-25T04:18:50Z  INFO victory_gpu::pipeline: shader translated stage="pixel"'), null);
  assert.equal(frameLine('not a log line'), null);
});

test('the rate is the test: three consecutive heavy lines at or above the floor, whatever the queue holds', () => {
  assert.equal(DEFAULT_FLOOR_FPS, 1.5);
  assert.equal(DEFAULT_WAITING, null, 'no waiting ceiling unless one is asked for');
  assert.equal(SETTLED_LINES, 3);
  let state = initialState();
  for (const line of [EARLY, HEAVY_LOADING, PLAYING, later(PLAYING, '20:57')]) state = observe(state, line);
  assert.equal(state.heavyAt, Date.parse('2026-11-25T04:18:50.941475Z'));
  assert.equal(state.consecutive, 2);
  assert.equal(state.settledAt, null, 'two lines are not three');
  state = observe(state, later(PLAYING, '21:07'));
  assert.equal(state.settledAt, Date.parse('2026-11-25T04:21:07.000000Z'));
  assert.equal(state.settledWaiting, 1558, 'the queue count is reported, not required');
  assert.equal(state.settledFps, 2.9);
});

test('a waiting ceiling is optional and only applies when asked for', () => {
  let state = initialState();
  for (const line of [PLAYING, later(PLAYING, '20:57'), later(PLAYING, '21:07')]) state = observe(state, line, { waiting: 100 });
  assert.equal(state.settledAt, null, '1558 waiting is above a ceiling of 100');
  state = initialState();
  for (const line of [PLAYING, later(PLAYING, '20:57'), later(PLAYING, '21:07')]) state = observe(state, line, { waiting: 1600 });
  assert.notEqual(state.settledAt, null);
});

test('the marker says what the settle saw, and the clock ends or times out as asked', () => {
  let state = initialState();
  state = observe(state, HEAVY_LOADING);
  const heavy = state.heavyAt;
  assert.equal(due(state, { now: heavy + 1000, seconds: 75, timeout: DEFAULT_TIMEOUT_S }), 'wait');
  assert.equal(due(state, { now: heavy + 601_000, seconds: 75, timeout: 600 }), 'timeout');
  assert.equal(timeoutMarker(600), 'harness: ended by --settled-timeout after 600 s: the scene never settled');

  for (const line of [PLAYING, later(PLAYING, '20:57'), later(PLAYING, '21:07')]) state = observe(state, line);
  const since = Math.round((state.settledAt - state.heavyAt) / 1000);
  assert.equal(since, 136);
  assert.equal(settledMarker(since, state.settledWaiting, state.settledFps), 'harness: settled at 136 s (waiting 1558, 2.9 fps)');
  const settled = state.settledAt;
  assert.equal(due(state, { now: settled + 74_000, seconds: 75, timeout: 600 }), 'wait');
  assert.equal(due(state, { now: settled + 75_000, seconds: 75, timeout: 600 }), 'end');
  assert.equal(settleEndMarker(75), 'harness: ended by --settled-seconds after 75 s of settled scene');
  assert.equal(settledMarker(5, null, 3), 'harness: settled at 5 s (waiting ?, 3 fps)');
});

// The boat run's shapes (2026-11-25 09:12:56): heavy frames drawing fine while the recording threads wait hundreds
// of ms a frame for pipelines, and the frame line saying how many are being made.
const frameAt = (mmss, { fps = 3, draws = 5000, dropped = 0, making = undefined, waiting = 0 } = {}) =>
  `2026-11-25T04:${mmss}.000000Z  INFO victory_gpu::host: ${fps} fps, 333.0 ms/frame (0.0 preparing: copies 0.0 ms 0.0 MB, textures 0.0 ms 0.0 MB; 0.0 on the GPU; 0.0 copying back 0.0 MB), ${draws} draws/frame, dropped ${dropped} without a host pipeline${making === undefined ? '' : ` (${making} being made)`} and 0 indirect; heap buffers 0.0 passes 0.0 ms; textures picked by index: 0 uploaded so far (0 MB), ${waiting} waiting, 0 passed over unmapped;`;
const waitAt = (mmss, ms) =>
  `2026-11-25T04:${mmss}.000000Z  INFO victory_gpu::copystat: recording per frame (105 frames): 29 list calls 4.6 ms (all recording threads); ${ms} ms waiting for pipelines; dynamic slots: 3 tables asked, 0 refused, 0.0 ms searching`;

test('pipelines being made or waited for hold the settle off, however good the frames look', () => {
  assert.equal(PIPELINE_QUIET_MS, 5);
  let state = initialState();
  for (const line of [frameAt('00:00', { making: 654 }), frameAt('00:05', { making: 654 }), frameAt('00:10', { making: 654 })]) {
    state = observe(state, line);
  }
  assert.equal(state.consecutive, 0, 'three good frames while 654 pipelines are being made are not a settle');
  assert.equal(state.settledAt, null);

  for (const line of [waitAt('00:12', 630), waitAt('00:18', 600), waitAt('00:24', 550)]) state = observe(state, line);
  state = observe(state, frameAt('00:26', { making: 0 }));
  assert.equal(state.settledAt, null, 'a quiet frame is not enough while the wait samples say compiling');
  assert.equal(state.pipelineRun, 0);

  for (const line of [waitAt('00:30', 2.0), frameAt('00:31', { making: 0 }), waitAt('00:36', 1.2), waitAt('00:42', 0.4)]) {
    state = observe(state, line);
  }
  assert.equal(state.pipelineRun, 3);
  assert.equal(state.metPipelinesAt, Date.parse('2026-11-25T04:00:42.000000Z'));
  for (const line of [frameAt('00:43', { making: 0 }), frameAt('00:48', { making: 0 }), frameAt('00:53', { making: 0 })]) {
    state = observe(state, line);
  }
  assert.equal(state.settledAt, Date.parse('2026-11-25T04:00:53.000000Z'));
  assert.equal(
    settledMarker(53, state.settledWaiting, state.settledFps, state.settledDetail),
    'harness: settled at 53 s (waiting 0, 3 fps); waited: frame rate from 0 s, pipelines from 42 s (3 samples under 5.0 ms, none being made), textures not gated (0 waiting)',
  );
});

test('a build that prints neither pipeline line settles as it always did, and the marker says not checked', () => {
  let state = initialState();
  for (const line of [frameAt('10:00'), frameAt('10:05'), frameAt('10:10')]) state = observe(state, line);
  assert.equal(state.settledAt, Date.parse('2026-11-25T04:10:10.000000Z'));
  assert.match(state.settledDetail, /pipeline quiet not checked/);
  assert.match(
    settledMarker(10, state.settledWaiting, state.settledFps, state.settledDetail),
    /^harness: settled at 10 s \(waiting 0, 3 fps\); waited: frame rate from 0 s, pipeline quiet not checked, textures not gated/,
  );
});

test('an unsettled run names the condition still unmet, once a minute', () => {
  assert.equal(UNSETTLED_NOTE_MS, 60_000);
  let state = initialState();
  state = observe(state, frameAt('01:00', { making: 654 }));
  state = observe(state, waitAt('01:02', 340));
  const why = unmetText(state, {});
  assert.match(why, /0 of 3 quiet pipeline samples \(last 340\.0 ms, under 5\.0 needed\)/);
  assert.match(why, /654 pipelines being made/);
  assert.match(
    unsettledMarker(64, why),
    /^harness: not settled after 64 s: 0 of 3 quiet pipeline samples \(last 340\.0 ms, under 5\.0 needed\); 654 pipelines being made$/,
  );

  for (const line of [waitAt('02:00', 0.2), waitAt('03:00', 0.1), waitAt('04:00', 0.5), frameAt('04:05', { making: 0 })]) {
    state = observe(state, line);
  }
  assert.match(unmetText(state, {}), /1 of 3 settled frame lines so far/, 'quiet now, but the frame run has restarted');

  // A build that never prints the pipeline lines says so, and the frame rate is the only thing it names.
  let plain = observe(initialState(), frameAt('10:00', { fps: 0.5 }));
  assert.match(unmetText(plain, {}), /frame rate 0\.5 fps under 1\.5/);
  assert.doesNotMatch(unmetText(plain, {}), /pipeline/);
});

test('a settle held by time does not fire before its wait has passed, and the unmet line says so', () => {
  let state = initialState();
  state = observe(state, frameAt('10:00', { making: 0 }), { settleAfterS: 150 });
  for (const line of [frameAt('10:10', { making: 0 }), frameAt('10:20', { making: 0 })]) {
    state = observe(state, line, { settleAfterS: 150 });
  }
  assert.equal(state.settledAt, null, '20 s after the first heavy line is before a 150 s wait');
  assert.equal(state.consecutive, 0);
  assert.match(unmetText(state, { settleAfterS: 150 }), /settle held until 150 s after the first heavy line/);

  for (const line of [frameAt('12:30', { making: 0 }), frameAt('12:40', { making: 0 }), frameAt('12:50', { making: 0 })]) {
    state = observe(state, line, { settleAfterS: 150 });
  }
  assert.equal(state.settledAt, Date.parse('2026-11-25T04:12:50.000000Z'));
});

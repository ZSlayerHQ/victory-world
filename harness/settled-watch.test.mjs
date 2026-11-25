import assert from 'node:assert/strict';
import test from 'node:test';
import {
  DEFAULT_FLOOR_FPS,
  DEFAULT_TIMEOUT_S,
  DEFAULT_WAITING,
  SETTLED_LINES,
  due,
  frameLine,
  initialState,
  observe,
  settleEndMarker,
  settledMarker,
  timeoutMarker,
} from './settled-watch.mjs';

// Frame lines as the runtime wrote them (run merged-forks, 2026-11-25), cut after the texture queue's count.
const EARLY =
  '2026-11-25T04:17:12.475238Z  INFO victory_gpu::host: 30.0 fps, 33.3 ms/frame (1.9 preparing: copies 1.7 ms 0.2 MB, textures 0.0 ms 0.0 MB; 0.0 on the GPU; 0.0 copying back 0.0 MB), 13 draws/frame, dropped 0 without a host pipeline (1094 being made) and 0 indirect; heap buffers 0.0 passes 0.0 ms;                  texture slots written so far: 1105 placed, 5258 of objects; textures picked by index: 562 uploaded so far (202 MB), 0 waiting, 0 passed over unmapped;';
const HEAVY_LOADING =
  '2026-11-25T04:18:50.941475Z  INFO victory_gpu::host: 0.7 fps, 1487.9 ms/frame (748.9 preparing: copies 167.3 ms 253.0 MB, textures 533.6 ms 129.0 MB; 25.6 on the GPU; 111.1 copying back 78.2 MB), 1684 draws/frame, dropped 974 without a host pipeline (0 being made) and 12 indirect; heap buffers 0.5 passes 398.0 ms;                  texture slots written so far: 166326 placed, 30527 of objects; textures picked by index: 36247 uploaded so far (2945 MB), 1212 waiting, 1277 passed over unmapped;';
const PLAYING =
  '2026-11-25T04:19:47.751794Z  INFO victory_gpu::host: 2.9 fps, 349.4 ms/frame (171.5 preparing: copies 134.5 ms 198.8 MB, textures 13.9 ms 42.4 MB; 50.2 on the GPU; 89.6 copying back 77.8 MB), 1373 draws/frame, dropped 653 without a host pipeline (0 being made) and 0 indirect; heap buffers 0.7 passes 220.8 ms;                  texture slots written so far: 265289 placed, 68969 of objects; textures picked by index: 76958 uploaded so far (6427 MB), 1558 waiting, 6754 passed over unmapped;';
const later = (line, mmss) => line.replace(/T\d\d:\d\d:\d\d\.\d+Z/, `T04:${mmss}.000000Z`);

test('a frame line gives its figures, or nothing for another line', () => {
  assert.deepEqual(frameLine(HEAVY_LOADING), {
    at: Date.parse('2026-11-25T04:18:50.941475Z'),
    fps: 0.7,
    draws: 1684,
    dropped: 974,
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

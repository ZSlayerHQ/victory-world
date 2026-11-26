// The frame line's cost part under both labels: "on the GPU" (builds before job/frame-timers) and "host waits (...)"
// (builds from it on, where the figure is named for what it measures). The capture groups keep their positions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { COST_RE } from './parse-run.mjs';

const head = '12.5 preparing: copies 3.1 ms 4.2 MB, textures 5.3 ms 6.4 MB; ';
const tail = '; 8.6 copying back 9.7 MB';
const want = ['12.5', '3.1', '4.2', '5.3', '6.4', '7.5', '8.6', '9.7'];

test('the cost part parses with the old label', () => {
  const m = COST_RE.exec(`${head}7.5 on the GPU${tail}`);
  assert.ok(m);
  assert.deepEqual(m.slice(1), want);
});

test('the cost part parses with the host-waits label, into the same groups', () => {
  const waits = "7.5 host waits (for the relay 1.5, for flights' fence 2.0, synchronous submissions sent to retired 4.0)";
  const m = COST_RE.exec(`${head}${waits}${tail}`);
  assert.ok(m);
  assert.deepEqual(m.slice(1), want);
});

test('the cost part still parses when the copied-back bytes are followed by more text', () => {
  const m = COST_RE.exec(`${head}7.5 on the GPU${tail} merged, 3.0 MB fetched`);
  assert.ok(m);
  assert.deepEqual(m.slice(1), want);
});

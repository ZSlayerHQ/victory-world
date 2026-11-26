// The sent-ahead line and the settle line under both wordings: the old "waiting for the card" labels (builds before
// job/frame-timers) and the corrected "host time waiting for settles" ones. The capture groups keep their positions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { AHEAD_RE, SETTLE_MS_RE } from './run-lines.mjs';

test('the sent-ahead line parses with the old wording', () => {
  const m = AHEAD_RE.exec(
    'submissions sent ahead per frame: 28.5 in 3.2 settles (8.9 flights each time), 41.7 ms waiting for the card in them; settled for: a fill 2.1, a readback 1.1; more',
  );
  assert.ok(m);
  assert.deepEqual(m.slice(1), ['28.5', '3.2', '8.9', '41.7', 'a fill 2.1, a readback 1.1']);
});

test('the sent-ahead line parses with the corrected wording, into the same groups', () => {
  const m = AHEAD_RE.exec(
    'submissions sent ahead per frame: 28.5 in 3.2 settles (8.9 flights each time), 41.7 ms host time waiting for settles; settled for: a fill 2.1',
  );
  assert.ok(m);
  assert.deepEqual(m.slice(1), ['28.5', '3.2', '8.9', '41.7', 'a fill 2.1']);
});

test('with the relay landing flights there is no flights figure, and the rest keeps its place', () => {
  const m = AHEAD_RE.exec(
    'submissions sent ahead per frame: 28.5 in 3.2 settles (flights landed by the relay), 41.7 ms host time waiting for settles; settled for: a fill 2.1',
  );
  assert.ok(m);
  assert.deepEqual(m.slice(1), ['28.5', '3.2', undefined, '41.7', 'a fill 2.1']);
});

test('the settle line parses under both wordings', () => {
  for (const label of ['waiting for the card in settles', 'host time waiting for settles']) {
    const m = SETTLE_MS_RE.exec(`12.0 ms of the ${label}, per frame, by what settled: a fill 7.0, a readback 5.0`);
    assert.ok(m, label);
    assert.equal(m[1], 'a fill 7.0, a readback 5.0');
  }
});

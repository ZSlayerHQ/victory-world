import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { formatReport, parseLiveLog, SHORT_FRAMES } from './live-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'live-report.mjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'live-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const DIM = '\x1b[2m';
const RESET = '\x1b[0m';
const GREEN = '\x1b[32m';
const prefix = `${DIM}2026-11-26T10:00:00.000000Z${RESET} ${GREEN} INFO${RESET} ${DIM}victory_gpu::live${RESET}: `;

// The runtime's lines, with colour codes and CRLF. Segment 2 is 50 frames (short); its in-force lists are empty.
// The marker that cuts segment 3 has an empty old value, as a skip list that starts empty does.
const LOG = [
  `${prefix}live segment 1: frames 100..400, mean 16.7, p50 16.1, p95 21.3, skipped 0 draws and 0 dispatches, in force: VICTORY_KEEP_TEXTURES=on VICTORY_TEXTURE_LOW=70 VICTORY_TEXTURE_HIGH=85 VICTORY_LATE_WAITS=off LIVE_SKIP_DISPATCH= LIVE_SKIP_DRAW=`,
  `${prefix}live: VICTORY_TEXTURE_LOW 70 -> 60 at frame 401`,
  `${prefix}live segment 2: frames 401..450, mean 20.0, p50 19.2, p95 25.9, skipped 0 draws and 0 dispatches, in force: VICTORY_KEEP_TEXTURES=on VICTORY_TEXTURE_LOW=60 VICTORY_TEXTURE_HIGH=85 VICTORY_LATE_WAITS=off LIVE_SKIP_DISPATCH= LIVE_SKIP_DRAW=`,
  `${prefix}live: LIVE_SKIP_DRAW  -> 1234,5678 at frame 451`,
  `${prefix}live: VICTORY_KEEP_TEXTURES on -> off at frame 451`,
  `${prefix}live segment 3: frames 451..700, mean 12.4, p50 12.0, p95 14.8, skipped 3 draws and 0 dispatches, in force: VICTORY_KEEP_TEXTURES=off VICTORY_TEXTURE_LOW=60 VICTORY_TEXTURE_HIGH=85 VICTORY_LATE_WAITS=off LIVE_SKIP_DISPATCH= LIVE_SKIP_DRAW=1234,5678`,
  `${prefix}not a live line at all`,
].join('\r\n');

test('the segments and changes are read through colour codes and CRLF', () => {
  const segments = parseLiveLog(LOG);
  assert.equal(segments.length, 3);
  assert.deepEqual(segments[0], {
    segment: 1,
    frames: '100..400',
    firstFrame: 100,
    lastFrame: 400,
    frameCount: 301,
    mean: 16.7,
    p50: 16.1,
    p95: 21.3,
    skippedDraws: 0,
    skippedDispatches: 0,
    inForce: {
      VICTORY_KEEP_TEXTURES: 'on',
      VICTORY_TEXTURE_LOW: '70',
      VICTORY_TEXTURE_HIGH: '85',
      VICTORY_LATE_WAITS: 'off',
      LIVE_SKIP_DISPATCH: '',
      LIVE_SKIP_DRAW: '',
    },
    short: false,
    meanChange: null,
    changes: [],
  });
  assert.equal(segments[1].short, true, '50 frames is too few');
  assert.deepEqual(segments[1].changes, [
    { name: 'VICTORY_TEXTURE_LOW', old: '70', new: '60', frame: 401 },
  ]);
  assert.equal(segments[1].meanChange, 3.3);
  assert.deepEqual(
    segments[2].changes.map((change) => [change.name, change.old, change.new]),
    [
      ['LIVE_SKIP_DRAW', '', '1234,5678'],
      ['VICTORY_KEEP_TEXTURES', 'on', 'off'],
    ],
  );
  assert.equal(segments[2].inForce.LIVE_SKIP_DRAW, '1234,5678');
  assert.equal(segments[2].skippedDraws, 3);
  assert.equal(segments[2].meanChange, -7.6);
  assert.equal(SHORT_FRAMES, 120);
});

test('the table names every column, marks a short segment, and shows the change and the switches', () => {
  const text = formatReport(parseLiveLog(LOG));
  assert.match(text, /\| segment \| frames \| mean \| p50 \| p95 \| skipped draws \| skipped dispatches \| in force \| mean change \| changed \|/);
  assert.match(text, /\| 1 \| 100\.\.400 \| 16\.7 \| 16\.1 \| 21\.3 \| 0 \| 0 \|/);
  assert.match(text, /VICTORY_KEEP_TEXTURES=on VICTORY_TEXTURE_LOW=70 .* LIVE_SKIP_DISPATCH= LIVE_SKIP_DRAW= \|/);
  assert.match(text, /\| 2 \| 401\.\.450 \(short\) \| 20\.0 \| 19\.2 \| 25\.9 \| 0 \| 0 \|/);
  assert.match(text, /\+3\.3 ms/);
  assert.match(text, /VICTORY_TEXTURE_LOW 70 -> 60/);
  assert.match(text, /-7\.6 ms/);
  assert.match(text, /LIVE_SKIP_DRAW \(empty\) -> 1234,5678; VICTORY_KEEP_TEXTURES on -> off/);
  assert.match(text, /short: fewer than 120 frames/);
});

test('a segment of 120 frames is not short; one of 119 is', () => {
  const line = (last) =>
    `${prefix}live segment 1: frames 1..${last}, mean 10.0, p50 10.0, p95 10.0, skipped 0 draws and 0 dispatches, in force: LIVE_SKIP_DRAW=`;
  assert.equal(parseLiveLog(line(120))[0].short, false);
  assert.equal(parseLiveLog(line(119))[0].short, true);
});

test('a log without live lines reports no segments in text and an empty array in JSON', (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  fs.writeFileSync(log, `${prefix}a frame line the live report does not use\r\n`);
  assert.equal(formatReport(parseLiveLog(fs.readFileSync(log, 'utf8'))), 'no live segments');
  const result = spawnSync(process.execPath, [script, log, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('the command prints the same rows as objects with --json', (t) => {
  const dir = tempDir(t);
  const log = path.join(dir, 'run.log');
  fs.writeFileSync(log, LOG);
  const text = spawnSync(process.execPath, [script, log], { encoding: 'utf8' });
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /\| 2 \| 401\.\.450 \(short\) \|/);
  const json = spawnSync(process.execPath, [script, '--json', log], { encoding: 'utf8' });
  assert.equal(json.status, 0, json.stderr);
  const segments = JSON.parse(json.stdout);
  assert.equal(segments.length, 3);
  assert.equal(segments[1].short, true);
  assert.equal(segments[1].meanChange, 3.3);
  assert.deepEqual(segments[2].changes.map((change) => change.name), ['LIVE_SKIP_DRAW', 'VICTORY_KEEP_TEXTURES']);
});

test('the command refuses with usage when the log is missing', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage: node live-report\.mjs <log> \[--json\]/);
});

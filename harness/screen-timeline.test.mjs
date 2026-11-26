import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  clock,
  frameSamples,
  joinLog,
  recordingStart,
  sampleLuma,
  sheetsFor,
  timeline,
  totals,
} from './screen-timeline.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const summarize = path.join(here, 'summarize-run.mjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-timeline-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Five seconds black, five of an animated test pattern, five black.
function syntheticVideo(dir) {
  const file = path.join(dir, 'screen.mp4');
  const made = spawnSync(
    'ffmpeg',
    [
      '-hide_banner',
      '-v',
      'error',
      '-y',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x180:r=10:d=5',
      '-f',
      'lavfi',
      '-i',
      'testsrc=s=320x180:r=10:d=5',
      '-f',
      'lavfi',
      '-i',
      'color=c=black:s=320x180:r=10:d=5',
      '-filter_complex',
      '[0:v][1:v][2:v]concat=n=3:v=1:a=0',
      '-r',
      '10',
      '-pix_fmt',
      'yuv420p',
      file,
    ],
    { encoding: 'utf8' },
  );
  assert.equal(made.status, 0, made.stderr);
  return file;
}

function frameLine(at, fps, draws, dropped) {
  return `${at}  INFO victory_gpu::frame: ${fps} fps, 300.0 ms/frame (preparing: copies 1.0 ms 2.0 MB, textures 3.0 ms 4.0 MB; 5.0 on the GPU; 6.0 copying back 7.0 MB), ${draws} draws/frame, dropped ${dropped} without a host pipeline (0 being made) and 0 indirect`;
}

test('frame samples parse both frame-line forms, with and without the frame number', () => {
  const old = frameLine('2026-11-24T12:00:00.000000Z', 30, 12, 0);
  const fresh =
    '2026-11-26T05:02:11.250000Z  INFO victory_gpu::host: frame 18432, 27.4 fps, 36.5 ms/frame ' +
    '(0.4 preparing: copies 0.3 ms 1.2 MB, textures hashed 0.2 ms 0.1 MB; 1.7 on the GPU; ' +
    '0.1 copying back 0.9 MB), 5000 draws/frame, dropped 3 without a host pipeline (1 being made) and 7 indirect';
  const samples = frameSamples([old, fresh]);
  assert.deepEqual(
    samples.map((sample) => [sample.fps, sample.draws, sample.dropped]),
    [
      [30, 12, 0],
      [27.4, 5000, 3],
    ],
  );
});

test('a black, picture, black recording gives three stretches with the right kinds and times', (t) => {
  const dir = tempDir(t);
  const video = syntheticVideo(dir);
  const samples = sampleLuma(video);
  assert.equal(samples.length, 15);
  const stretches = timeline(samples);
  assert.deepEqual(
    stretches.map((s) => [s.kind, s.start, s.end]),
    [
      ['black', 0, 5],
      ['picture', 5, 10],
      ['black', 10, 15],
    ],
  );
  assert.ok(stretches[1].cuts >= 1, 'the change into the picture is a cut');
  const all = totals(stretches);
  assert.deepEqual(all.seconds, { black: 10, nearBlack: 0, picture: 5 });
  assert.deepEqual(all.longestBlack, { start: 0, end: 5 });
});

test('stretch kinds, cuts, clocks and sheet numbers follow the samples', () => {
  const samples = [0, 0, 8, 60, 60, 8, 8, 0].map((luma, i) => ({
    t: i,
    luma,
    diff: i === 3 ? 60 : 0,
  }));
  const stretches = timeline(samples);
  assert.deepEqual(
    stretches.map((s) => [s.kind, s.start, s.end, s.cuts]),
    [
      ['black', 0, 2, 0],
      ['near-black', 2, 3, 0],
      ['picture', 3, 5, 1],
      ['near-black', 5, 7, 0],
      ['black', 7, 8, 0],
    ],
  );
  assert.deepEqual(stretches[2].sheets, [1, 1]);
  assert.deepEqual(sheetsFor(8, 12), [1, 2]);
  assert.deepEqual(sheetsFor(72, 100), [9, 12]);
  assert.equal(clock(72), '1:12');
  assert.equal(clock(3672), '1:01:12');
});

test('the log joins each stretch by the recording start and the wall clock', () => {
  const start = Date.parse('2026-11-25T02:00:00.000Z');
  const lines = [
    'recording: started 2026-11-25T02:00:00.000Z',
    frameLine('2026-11-25T02:00:01.000000Z', '2.0', '4000', '100'),
    frameLine('2026-11-25T02:00:01.500000Z', '4.0', '6000', '300'),
    frameLine('2026-11-25T02:00:02.500000Z', '1.0', '9000', '500'),
  ];
  assert.equal(recordingStart(lines), start);
  assert.equal(frameSamples(lines).length, 3);
  const samples = [
    { t: 0, luma: 0, diff: null },
    { t: 1, luma: 0, diff: null },
    { t: 2, luma: 60, diff: 60 },
  ];
  const stretches = joinLog(timeline(samples), { start, frames: frameSamples(lines) });
  // The black stretch holds the 1 s and 1.5 s lines; the picture second holds the 2.5 s one.
  assert.equal(stretches[0].log.lines, 2);
  assert.equal(stretches[0].log.medianFps, 3);
  assert.equal(stretches[0].log.medianDraws, 5000);
  assert.equal(stretches[0].log.medianDropped, 200);
  assert.equal(stretches[1].log.lines, 1);
  assert.equal(stretches[1].log.medianFps, 1);
});

test('the summary opens with what was on screen', (t) => {
  const dir = tempDir(t);
  syntheticVideo(dir);
  const log = path.join(dir, '20261125-000000-names.log');
  fs.writeFileSync(
    log,
    [
      'harness build: abc profile=diag console=series-x',
      `capture: ${dir}`,
      'recording: started 2026-11-25T02:00:00.000Z',
      frameLine('2026-11-25T02:00:01.000000Z', '3.0', '4000', '100'),
      frameLine('2026-11-25T02:00:06.000000Z', '3.0', '4000', '100'),
      'harness: victory exit=0',
      '',
    ].join('\n'),
  );
  const result = spawnSync(process.execPath, [summarize, log], {
    encoding: 'utf8',
    env: { ...process.env, VICTORY_SHADER_NAMES: path.join(dir, 'none.txt') },
  });
  assert.equal(result.status, 0, result.stderr);
  const text = result.stdout;
  assert.match(text, /## What was on screen/);
  assert.match(text, /black 10 s, near-black 0 s, picture 5 s/);
  assert.match(text, /0:00-0:05 black \(sheet 1\)/);
  assert.match(
    text,
    /0:05-0:10 picture, 1 cut \(sheets 1-2\); median 3\.0 fps, 4000 draws\/frame, 100 dropped\/frame/,
  );
  assert.match(text, /0:10-0:15 black \(sheet 2\)/);
  const pictureAt = text.indexOf('## What was on screen');
  const worstAt = text.indexOf('## Worst frames');
  assert.ok(pictureAt >= 0 && worstAt > pictureAt, 'the picture section comes before the other sections');
});

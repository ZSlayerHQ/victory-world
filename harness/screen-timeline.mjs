#!/usr/bin/env node
// What was on screen in a run's recording: stretches of black, near-black and picture, with scene cuts, the contact
// sheet each stretch is on, and, with --log, the run's own frame figures for the same wall-clock time. One pass of
// ffmpeg at a sample a second. usage: node screen-timeline.mjs <screen.mp4> [--log <run log>] [--json]
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FRAME_RE, median, readLogLines } from './parse-run.mjs';

// screen.mp4 is limited-range yuv420p (black sits at 16, not 0), so luma and the frame difference are mapped to
// the 0-255 scale before classifying: a black second is under 4, a near-black one under 16, and a cut is a mean
// frame difference of 32 or more (measured on a synthetic video: 109 at a hard change, 6 to 8 inside a moving
// pattern).
export const BLACK = 4;
export const NEAR_BLACK = 16;
export const CUT = 32;
const Y_MIN = 16;
const Y_SCALE = 255 / 219;
// contact-sheets.mjs defaults: one tile a second, three by three, so one sheet shows nine seconds.
export const TILES_PER_SHEET = 9;

export const luma255 = (y) => Math.max(0, Math.min(255, (y - Y_MIN) * Y_SCALE));
export const diff255 = (y) => Math.max(0, y * Y_SCALE);

export function classify(luma) {
  if (luma < BLACK) return 'black';
  if (luma < NEAR_BLACK) return 'near-black';
  return 'picture';
}

// One sample a second from one ffmpeg pass: mean luma, and the mean frame difference from the previous second.
export function sampleLuma(video, ffmpeg = 'ffmpeg') {
  const result = spawnSync(
    ffmpeg,
    [
      '-hide_banner',
      '-v',
      'error',
      '-i',
      video,
      '-vf',
      'fps=1,signalstats,metadata=print:file=-',
      '-an',
      '-f',
      'null',
      '-',
    ],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    const why = (result.stderr || '').trim().split('\n')[0] || 'no error';
    throw new Error(`ffmpeg failed: ${why}`);
  }
  const raw = [];
  let current = null;
  for (const line of (result.stdout || '').split(/\r?\n/)) {
    const frame = line.match(/^frame:\d+\s+pts:\S*\s+pts_time:([\d.]+)\s*$/);
    if (frame) {
      if (current && current.yavg !== null) raw.push(current);
      current = { t: Number(frame[1]), yavg: null, ydif: null };
      continue;
    }
    const stat = line.match(/^lavfi\.signalstats\.(YAVG|YDIF)=([\d.]+)/);
    if (stat && current) current[stat[1].toLowerCase()] = Number(stat[2]);
  }
  if (current && current.yavg !== null) raw.push(current);
  return raw.map((s) => ({
    t: s.t,
    luma: luma255(s.yavg),
    diff: s.ydif === null ? null : diff255(s.ydif),
  }));
}

// Stretches of one kind. A cut counts on the second that starts it, so a change into the picture lands on the
// picture stretch; cuts are only shown for picture stretches.
export function timeline(samples) {
  const stretches = [];
  for (const sample of samples) {
    const kind = classify(sample.luma);
    const cut = sample.diff !== null && sample.diff >= CUT;
    const last = stretches[stretches.length - 1];
    if (last && last.kind === kind) {
      last.end = sample.t + 1;
      if (cut) last.cuts += 1;
    } else {
      stretches.push({ kind, start: sample.t, end: sample.t + 1, cuts: cut ? 1 : 0 });
    }
  }
  return stretches.map((s) => ({ ...s, sheets: sheetsFor(s.start, s.end) }));
}

// The contact sheets a stretch is on, from the sheet layout's nine seconds a sheet.
export function sheetsFor(start, end) {
  const first = Math.floor(start / TILES_PER_SHEET) + 1;
  const last = Math.floor((Math.max(start + 1, end) - 1) / TILES_PER_SHEET) + 1;
  return [first, last];
}

export function totals(stretches) {
  const seconds = { black: 0, nearBlack: 0, picture: 0 };
  let longestBlack = null;
  for (const stretch of stretches) {
    const length = stretch.end - stretch.start;
    if (stretch.kind === 'black') seconds.black += length;
    else if (stretch.kind === 'near-black') seconds.nearBlack += length;
    else seconds.picture += length;
    if (stretch.kind === 'black' && (!longestBlack || length > longestBlack.end - longestBlack.start)) {
      longestBlack = { start: stretch.start, end: stretch.end };
    }
  }
  return { seconds, longestBlack };
}

export const clock = (seconds) => {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
};

export const RECORDING_STARTED_RE = /^recording: started (\S+)\s*$/;

// The wall-clock time the recorder began, which record-screen.mjs writes to the run log.
export function recordingStart(lines) {
  const found = lines.map((line) => line.match(RECORDING_STARTED_RE)).find(Boolean);
  if (!found) return null;
  const at = Date.parse(found[1]);
  return Number.isNaN(at) ? null : at;
}

export function frameSamples(lines) {
  const frames = [];
  for (const line of lines) {
    const m = line.match(FRAME_RE);
    if (!m) continue;
    const at = Date.parse(m[1]);
    if (Number.isNaN(at)) continue;
    frames.push({
      at,
      fps: Number(m.groups.fps),
      draws: Number(m.groups.draws),
      dropped: Number(m.groups.dropped),
    });
  }
  return frames;
}

// Stamp each stretch with the frame lines logged between the recording's start and its end.
export function joinLog(stretches, { start = null, frames = [] } = {}) {
  return stretches.map((stretch) => {
    if (start === null || !frames.length) return { ...stretch, log: null };
    const from = start + stretch.start * 1000;
    const to = start + stretch.end * 1000;
    const within = frames.filter((frame) => frame.at >= from && frame.at < to);
    if (!within.length) return { ...stretch, log: null };
    return {
      ...stretch,
      log: {
        lines: within.length,
        medianFps: median(within.map((frame) => frame.fps)),
        medianDraws: median(within.map((frame) => frame.draws)),
        medianDropped: median(within.map((frame) => frame.dropped)),
      },
    };
  });
}

export function formatStretch(stretch) {
  const headline =
    stretch.kind === 'picture' && stretch.cuts
      ? `${stretch.kind}, ${stretch.cuts} cut${stretch.cuts === 1 ? '' : 's'}`
      : stretch.kind;
  const sheets =
    stretch.sheets[0] === stretch.sheets[1]
      ? `sheet ${stretch.sheets[0]}`
      : `sheets ${stretch.sheets[0]}-${stretch.sheets[1]}`;
  const figures = stretch.log
    ? `; median ${stretch.log.medianFps.toFixed(1)} fps, ${Math.round(stretch.log.medianDraws)} draws/frame, ${Math.round(stretch.log.medianDropped)} dropped/frame`
    : '';
  return `${clock(stretch.start)}-${clock(stretch.end)} ${headline} (${sheets})${figures}`;
}

export function formatTimeline(stretches) {
  const all = totals(stretches);
  const black = all.longestBlack
    ? `; longest black ${clock(all.longestBlack.start)}-${clock(all.longestBlack.end)}`
    : '';
  const header = `${all.seconds.black + all.seconds.nearBlack + all.seconds.picture} s: black ${all.seconds.black} s, near-black ${all.seconds.nearBlack} s, picture ${all.seconds.picture} s${black}`;
  return [header, ...stretches.map((stretch) => formatStretch(stretch))];
}

function main() {
  const args = process.argv.slice(2);
  const asJson = args.includes('--json');
  const logAt = args.indexOf('--log');
  const log = logAt >= 0 ? args[logAt + 1] : null;
  if (logAt >= 0) args.splice(logAt, 2);
  const video = args.find((arg) => !arg.startsWith('--'));
  if (!video) {
    console.error('usage: node screen-timeline.mjs <screen.mp4> [--log <run log>] [--json]');
    process.exit(2);
  }
  const samples = sampleLuma(video);
  let stretches = timeline(samples);
  if (log) {
    const lines = readLogLines(log);
    stretches = joinLog(stretches, { start: recordingStart(lines), frames: frameSamples(lines) });
  }
  if (asJson) {
    console.log(
      JSON.stringify({ video, seconds: samples.length, totals: totals(stretches), stretches }, null, 2),
    );
    return;
  }
  for (const line of formatTimeline(stretches)) console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

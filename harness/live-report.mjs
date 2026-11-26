#!/usr/bin/env node
// The live switches' changes and the frame-time segments they cut, from a run log.
//
//   node harness/live-report.mjs <log> [--json]
//
// The runtime logs `live: <NAME> <old> -> <new> at frame <n>` for every applied change and, when a change closes a
// stretch and for the last one at shutdown, `live segment <k>: frames <a>..<b>, mean <ms>, p50 <ms>, p95 <ms>,
// skipped <d> draws and <s> dispatches, in force: <NAME=value ...>`. A log line may carry ANSI colour codes, a CRLF
// ending and the timestamp, level and module before the text; all three are tolerated. A segment shorter than 120
// frames is marked `short`: its mean and percentiles are too few samples to trust.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { stripAnsi } from './parse-run.mjs';

export const SHORT_FRAMES = 120;
const DASH = '—';

// The segment's text, wherever it starts on the log line. `mean`, `p50` and `p95` are ms with one decimal.
const SEGMENT_RE =
  /live segment (\d+): frames (\d+)\.\.(\d+), mean ([\d.]+), p50 ([\d.]+), p95 ([\d.]+), skipped (\d+) draws and (\d+) dispatches, in force:\s*(.*)$/;
// A marker's old or new value may be empty (an empty skip list), hence the non-greedy possibly-empty groups.
const CHANGE_RE = /live: ([A-Z0-9_]+) (.*?) -> (.*?) at frame (\d+)(?=\s|$)/;

/// `NAME=value` pairs as the segment line prints them, in the runtime's fixed order. An empty list stays an empty
/// string, which is what `NAME=` says.
export function parseInForce(text) {
  const values = {};
  for (const token of String(text).trim().split(/\s+/)) {
    if (!token) continue;
    const eq = token.indexOf('=');
    if (eq <= 0) continue;
    values[token.slice(0, eq)] = token.slice(eq + 1);
  }
  return values;
}

/// One log line as a change or a segment, or null for anything else. The runner tails a log with this, so the
/// line shapes live here once: colour codes and a CRLF ending are tolerated, as in parseLiveLog.
export function parseLiveLine(raw) {
  const line = stripAnsi(raw).replace(/\r$/, '');
  const change = line.match(CHANGE_RE);
  if (change) {
    return {
      change: { name: change[1], old: change[2].trim(), new: change[3].trim(), frame: Number(change[4]) },
    };
  }
  const segment = line.match(SEGMENT_RE);
  if (!segment) return null;
  const first = Number(segment[2]);
  const last = Number(segment[3]);
  const count = last >= first ? last - first + 1 : 0;
  return {
    segment: {
      segment: Number(segment[1]),
      frames: `${first}..${last}`,
      firstFrame: first,
      lastFrame: last,
      frameCount: count,
      mean: Number(segment[4]),
      p50: Number(segment[5]),
      p95: Number(segment[6]),
      skippedDraws: Number(segment[7]),
      skippedDispatches: Number(segment[8]),
      inForce: parseInForce(segment[9]),
      short: count < SHORT_FRAMES,
      meanChange: null,
      changes: [],
    },
  };
}

/// The segments in a run log, with the changes that cut each from the one before it. A change applies at the frame
/// boundary that closes the previous segment and is logged just after that segment's line, so it belongs to the
/// segment that follows. `meanChange` is against the previous segment and null for the first.
export function parseLiveLog(text) {
  const segments = [];
  let pending = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const parsed = parseLiveLine(raw);
    if (!parsed) continue;
    if (parsed.change) {
      pending.push(parsed.change);
      continue;
    }
    const segment = parsed.segment;
    segment.changes = pending;
    segments.push(segment);
    pending = [];
  }
  // Markers after the last segment (a log cut before the next one) belong to no segment shown.
  segments.forEach((segment, i) => {
    if (i === 0) return;
    const delta = Math.round((segment.mean - segments[i - 1].mean) * 10) / 10;
    segment.meanChange = delta === 0 ? 0 : delta;
  });
  return segments;
}

const one = (value) => (Number.isFinite(value) ? value.toFixed(1) : '?');
const cell = (value) => String(value).replace(/\|/g, '\\|');

function changedText(changes) {
  return changes
    .map((change) => `${change.name} ${change.old || '(empty)'} -> ${change.new || '(empty)'}`)
    .join('; ');
}

/// The Markdown table: one row per segment. The change columns are dashes on the first row, because there is no
/// segment before it to compare with.
export function formatReport(segments) {
  if (!segments.length) return 'no live segments';
  const out = [
    '# live segments',
    '| segment | frames | mean | p50 | p95 | skipped draws | skipped dispatches | in force | mean change | changed |',
    '|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i];
    const frames = `${segment.frames}${segment.short ? ' (short)' : ''}`;
    const inForce = Object.entries(segment.inForce)
      .map(([name, value]) => `${name}=${value}`)
      .join(' ');
    const meanChange =
      i === 0 ? DASH : `${segment.meanChange > 0 ? '+' : ''}${one(segment.meanChange)} ms`;
    const changed = i === 0 ? DASH : segment.changes.length ? changedText(segment.changes) : DASH;
    out.push(
      `| ${segment.segment} | ${cell(frames)} | ${one(segment.mean)} | ${one(segment.p50)} | ${one(segment.p95)} | ` +
        `${segment.skippedDraws} | ${segment.skippedDispatches} | ${cell(inForce || DASH)} | ${meanChange} | ${cell(changed)} |`,
    );
  }
  if (segments.some((segment) => segment.short)) {
    out.push('', `short: fewer than ${SHORT_FRAMES} frames; the mean and percentiles are too few samples to trust.`);
  }
  return out.join('\n');
}

function usage() {
  console.error('usage: node live-report.mjs <log> [--json]');
}

/// Reads one log and prints its table (or, with `--json`, the same rows as objects). Returns an exit code.
export function main(argv) {
  let json = false;
  let log = null;
  for (const arg of argv) {
    if (arg === '--json') json = true;
    else if (arg === '--help' || arg === '-h') {
      usage();
      return 0;
    } else if (arg.startsWith('-')) {
      console.error(`live-report: unknown option ${arg}`);
      usage();
      return 2;
    } else if (log === null) log = arg;
    else {
      console.error(`live-report: one log at a time, not '${arg}'`);
      usage();
      return 2;
    }
  }
  if (log === null) {
    usage();
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(log, 'utf8');
  } catch (err) {
    console.error(`live-report: cannot read the log (${err.code || err.message})`);
    return 1;
  }
  const segments = parseLiveLog(text);
  if (json) console.log(JSON.stringify(segments, null, 2));
  else console.log(formatReport(segments));
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) process.exit(main(process.argv.slice(2)));

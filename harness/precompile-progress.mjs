#!/usr/bin/env node
// The shader pre-compile's progress, as a small JSON file the stream overlay reads.
//
//   node harness/precompile-progress.mjs follow --log <warm.log> --out <json> [--started-ms <ms>]
//   node harness/precompile-progress.mjs final  --log <warm.log> --out <json> --started-ms <ms> --exit <code>
//
// The file holds numbers and one label only: no paths, no program names. It is rewritten at most twice a second
// while following, then once at the end with `state: "done"` or `"failed"`. `total` comes from the translator's
// up-front `progress total programs=… containers=…` line; builds before that line set `total` and `percent` to
// null and `done` counts the per-program lines when a log has them. `eta_s` is the rate over the last 30 seconds.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_OUT = '<drive>/Users/<user>/.config/<account>/stream/precompile.json';
const LABEL = 'Shader pre-compile';

const RE = {
  // Printed once before translation starts.
  total: /^progress\s+total\s+programs=([\d,]+)\s+containers=([\d,]+)/,
  // Printed by the translator at most twice a second and once at the end.
  progress: /^progress\s+translated\s+([\d,]+)\s+of\s+([\d,]+)\s+refused=([\d,]+)\s+failed_validation=([\d,]+)/,
  // The older form, for builds made before the refused= and failed_validation= fields.
  progress_old: /^progress\s+translated\s+([\d,]+)(?:\s+of\s+([\d,]+))?/,
  // The end-of-run summary the log does print.
  summary: /^programs\s+([\d,]+) translated of ([\d,]+)/,
  // Per-program lines, if a later build prints them to the warm log.
  done_line: /^(?:shader translated|translated)\s/,
};
const num = (text) => Number(String(text).replace(/,/g, ''));
const WINDOW_MS = 30_000;

/// Seconds left at the rate of the last 30 seconds; null when the rate is unknown or nothing is moving.
export function etaFromRate(done, total, nowMs, samples = [], startedMs = 0) {
  if (!total || done <= 0 || done >= total) return null;
  const points = samples.filter((s) => Number.isFinite(s.ms) && Number.isFinite(s.done) && s.ms <= nowMs);
  const cutoff = nowMs - WINDOW_MS;
  // The newest point at or before the window's start; failing that, the oldest point (or the run's start).
  let ref = points.filter((p) => p.ms <= cutoff).reduce((a, b) => (!a || b.ms > a.ms ? b : a), null);
  if (!ref) ref = points.length ? points.reduce((a, b) => (a.ms <= b.ms ? a : b)) : { ms: startedMs, done: 0 };
  const span = (nowMs - ref.ms) / 1000;
  if (!(span > 0)) return null;
  const rate = (done - ref.done) / span;
  if (!(rate > 0)) return null;
  return Math.round((total - done) / rate);
}

/// The overlay state from the log's lines so far. `samples` are earlier `{ ms, done }` observations, for the
/// 30-second rate.
export function stateFrom(lines, { startedMs, nowMs, exit = null, samples = [] } = {}) {
  let done = 0;
  let total = null;
  let sawSummary = false;
  for (const line of lines) {
    let m;
    if ((m = line.match(RE.total))) {
      total = num(m[1]);
    } else if ((m = line.match(RE.progress))) {
      done = num(m[1]);
      total = num(m[2]);
    } else if ((m = line.match(RE.progress_old))) {
      done = num(m[1]);
      if (m[2]) total = num(m[2]);
    } else if ((m = line.match(RE.summary))) {
      done = num(m[1]);
      total = num(m[2]);
      sawSummary = true;
    } else if (RE.done_line.test(line)) {
      done += 1;
    }
  }
  const finished = exit !== null || sawSummary;
  const state = exit !== null ? (exit === 0 ? 'done' : 'failed') : sawSummary ? 'done' : 'running';
  const elapsed = startedMs ? Math.max(0, Math.round((nowMs - startedMs) / 1000)) : 0;
  return {
    updated: new Date(nowMs).toISOString(),
    state,
    label: LABEL,
    done,
    total,
    percent: total ? Math.round((done / total) * 1000) / 10 : null,
    elapsed_s: elapsed,
    eta_s: etaFromRate(done, total, nowMs, samples, startedMs),
    // Internal only; not written.
    finished,
  };
}

/// The JSON the overlay reads: numbers and the label, nothing else.
export function overlayJson(state) {
  return {
    updated: state.updated,
    state: state.state,
    label: state.label,
    done: state.done,
    total: state.total,
    percent: state.percent,
    elapsed_s: state.elapsed_s,
    eta_s: state.eta_s,
  };
}

export function write(out, state, fsOps = fs) {
  fsOps.mkdirSync(path.dirname(out), { recursive: true });
  const temporary = `${out}.tmp`;
  fsOps.writeFileSync(temporary, JSON.stringify(overlayJson(state)));
  fsOps.renameSync(temporary, out);
}

const readLines = (log) => {
  try {
    return fs.readFileSync(log, 'utf8').split(/\r?\n/);
  } catch {
    return [];
  }
};

/// Follows the log until stopped, writing at most twice a second; a SIGTERM writes one last running state.
export function follow({ log, out, startedMs, intervalMs = 500 }) {
  let last = 0;
  let history = [];
  const tick = () => {
    const now = Date.now();
    const state = stateFrom(readLines(log), { startedMs, nowMs: now, samples: history });
    // A minute of observations keeps a reference point past the 30-second window.
    history = [...history.filter((p) => now - p.ms <= 60_000), { ms: now, done: state.done }];
    if (now - last >= intervalMs || state.finished) {
      write(out, state);
      last = now;
    }
  };
  tick();
  return setInterval(tick, intervalMs);
}

function parse(argv) {
  const [what, ...rest] = argv;
  const options = { what };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--log') options.log = rest[++i];
    else if (rest[i] === '--out') options.out = rest[++i];
    else if (rest[i] === '--started-ms') options.startedMs = Number(rest[++i]);
    else if (rest[i] === '--exit') options.exit = Number(rest[++i]);
    else throw new Error(`unknown argument ${rest[i]}`);
  }
  if (!['follow', 'final'].includes(options.what)) throw new Error('expected follow or final');
  if (!options.log) throw new Error('--log is required');
  options.out = options.out ?? DEFAULT_OUT;
  if (options.what === 'final' && (!Number.isFinite(options.exit) || !Number.isFinite(options.startedMs))) {
    throw new Error('final needs --started-ms and --exit');
  }
  return options;
}

function usage() {
  console.error(
    'usage: node harness/precompile-progress.mjs follow --log <warm.log> --out <json> [--started-ms <ms>]',
  );
  console.error(
    '       node harness/precompile-progress.mjs final  --log <warm.log> --out <json> --started-ms <ms> --exit <code>',
  );
}

function main(argv) {
  let options;
  try {
    options = parse(argv);
  } catch (err) {
    console.error(`precompile-progress: ${err.message}`);
    usage();
    return 2;
  }
  if (options.what === 'final') {
    const state = stateFrom(readLines(options.log), {
      startedMs: options.startedMs,
      nowMs: Date.now(),
      exit: options.exit,
    });
    write(options.out, state);
    return 0;
  }
  const timer = follow({ log: options.log, out: options.out, startedMs: options.startedMs });
  const stop = () => {
    clearInterval(timer);
    const last = stateFrom(readLines(options.log), { startedMs: options.startedMs, nowMs: Date.now() });
    write(options.out, last);
    process.exit(0);
  };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  return null; // Runs until stopped.
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const code = main(process.argv.slice(2));
  if (code !== null) process.exit(code);
}

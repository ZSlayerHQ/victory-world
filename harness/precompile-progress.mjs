#!/usr/bin/env node
// The shader pre-compile's progress, as a small JSON file the stream overlay reads.
//
//   node harness/precompile-progress.mjs follow --log <warm.log> --out <json> [--started-ms <ms>]
//   node harness/precompile-progress.mjs final  --log <warm.log> --out <json> --started-ms <ms> --exit <code>
//
// The file holds numbers and one label only: no paths, no program names. It is rewritten at most twice a second
// while following, then once at the end with `state: "done"` or `"failed"`. The pre-compile has two phases — the
// translation and the pipeline creation that follows it — and the bar spans both as one 0-to-100 by the phases'
// measured wall time (see the shares below). `percent` is that bar; `phase` says which phase the bar is in, and
// `translate_done/total` and `pipelines_done/total` are each phase's own counts (`done`/`total` are the current
// phase's). A build that prints neither total nor pipeline lines keeps the older behaviour: the bar is the
// translation alone. `eta_s` is the current phase's rate over the last 30 seconds plus the other phase's estimate.
//
// What the warm log really holds (checked against a 2026-11-26 log): every line is a `tracing` line with ANSI colour
// codes (`ESC[3mstageESC[0mESC[2m=ESC[0m"pixel"`), one `shader translated` or `shader does not translate` line per
// program, one `host pipeline shaders=[compute ...]` (or `host pipeline refused`) line per compute pipeline, and one
// closing `warm N translated, M refused; P compute pipelines, Q refused; S s` line. It prints no totals and no
// `progress` lines, so the totals come from the newest earlier warm log's closing line (`expectedFromLogs`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripControl } from './parse-run.mjs';

export const DEFAULT_OUT = path.join(os.homedir(), '.config', 'victory-harness', 'stream', 'precompile.json');
const LABEL = 'Shader pre-compile';

// How the two phases share the bar, by measured wall time. A finished warm-up on 2026-11-25 printed
// `containers 25985 in 133.5 s: …` and `pipelines 28164 in the pack, 308.8 s: …` in its warm log
// (harness/logs/<stamp>-<tag>.log.warm): about 30% translating and 70% making pipelines. A newer warm-up's two
// summary lines are where a replacement comes from; update these two numbers together.
const TRANSLATE_SHARE = 0.3;
const PIPELINES_SHARE = 0.7;

// Totals for a warm-up whose log states none: the closing line of a 2026-11-26 warm-up (25,669 translated and 89
// refused programs; 2,695 compute pipelines made and 1 refused). Used only when no earlier warm log has a closing line.
export const FALLBACK_EXPECTED = { programs: 25_758, pipelines: 2_696 };

// The shared control-sequence stripper, and the `tracing` header in front of every message:
// `2026-11-26T04:24:51.988492Z  INFO victory_gpu::pipeline: `. Both are removed before a line is matched.
const HEADER = /^\d{4}-\d\d-\d\dT[\d:.]+Z\s+[A-Za-z]+\s+[\w:]+:\s*/;
export const plain = (line) => stripControl(line).replace(HEADER, '');

const RE = {
  // Printed once before translation starts.
  total: /progress\s+total\s+programs=([\d,]+)\s+containers=([\d,]+)/,
  // Printed by the translator at most twice a second and once at the end.
  progress: /progress\s+translated\s+([\d,]+)\s+of\s+([\d,]+)\s+refused=([\d,]+)\s+failed_validation=([\d,]+)/,
  // The older form, for builds made before the refused= and failed_validation= fields.
  progress_old: /progress\s+translated\s+([\d,]+)(?:\s+of\s+([\d,]+))?/,
  // The pipeline phase's lines, on a build that prints them.
  pipelines_total: /progress\s+pipelines\s+total=([\d,]+)/,
  pipelines: /progress\s+pipelines\s+([\d,]+)\s+of\s+([\d,]+)\s+failed=([\d,]+)/,
  pipelines_old: /progress\s+pipelines\s+([\d,]+)(?:\s+of\s+([\d,]+))?/,
  // The end-of-run summary the log does print.
  summary: /^programs\s+([\d,]+) translated of ([\d,]+)/,
  // `victory warm`'s closing line: translated and refused programs, compute pipelines made and refused, seconds.
  warm_summary: /^warm\s+([\d,]+) translated, ([\d,]+) refused; ([\d,]+) compute pipelines, ([\d,]+) refused;/,
  // One line per program the warm-up has finished with, translated or refused.
  done_line: /^(?:shader translated|shader does not translate|translated)\b/,
  // One line per compute pipeline made or refused (not the pipeline library's own lines).
  pipeline_line: /^host pipeline (?:refused\b|shaders=)/,
};
const num = (text) => Number(String(text).replace(/,/g, ''));
const round1 = (x) => Math.round(x * 10) / 10;
const WINDOW_MS = 30_000;

/// A rate per second for one sampled count over the last 30 seconds, or null when nothing moved.
function rateOf(done, nowMs, samples, key, startedMs) {
  const points = samples.filter((s) => Number.isFinite(s.ms) && Number.isFinite(s[key]) && s.ms <= nowMs);
  const cutoff = nowMs - WINDOW_MS;
  let ref = points.filter((p) => p.ms <= cutoff).reduce((a, b) => (!a || b.ms > a.ms ? b : a), null);
  if (!ref) ref = points.length ? points.reduce((a, b) => (a.ms <= b.ms ? a : b)) : { ms: startedMs, [key]: 0 };
  const span = (nowMs - ref.ms) / 1000;
  if (!(span > 0)) return null;
  const rate = (done - ref[key]) / span;
  return rate > 0 ? rate : null;
}

/// Seconds left at the rate of the last 30 seconds; null when the rate is unknown or nothing is moving.
export function etaFromRate(done, total, nowMs, samples = [], startedMs = 0) {
  if (!total || done <= 0 || done >= total) return null;
  const rate = rateOf(done, nowMs, samples.map((s) => ({ ms: s.ms, done: s.done })), 'done', startedMs);
  return rate ? Math.round((total - done) / rate) : null;
}

/// The current phase's rate gives its remaining time; the other phase is added from the measured split.
function etaFor(phase, translate, pipelines, nowMs, samples, startedMs) {
  if (phase === 'pipelines') {
    if (!pipelines.total || pipelines.done >= pipelines.total) return null;
    const rate = rateOf(pipelines.done, nowMs, samples, 'pipelinesDone', startedMs);
    return rate ? Math.round((pipelines.total - pipelines.done) / rate) : null;
  }
  // Translating. With a count and a rate, the rest of the translation plus the pipelines phase projected from the
  // whole translation's time at the measured split; at the end of the translation, from what it took.
  if (translate.total && translate.done > 0 && translate.done < translate.total) {
    const rate = rateOf(translate.done, nowMs, samples, 'translateDone', startedMs);
    if (!rate) return null;
    const remaining = (translate.total - translate.done) / rate;
    const whole = translate.total / rate;
    return Math.round(remaining + (whole * PIPELINES_SHARE) / TRANSLATE_SHARE);
  }
  const elapsed = startedMs ? Math.max(0, (nowMs - startedMs) / 1000) : 0;
  if (!elapsed) return null;
  return Math.round((elapsed * PIPELINES_SHARE) / TRANSLATE_SHARE);
}

/// The overlay state from the log's lines so far. `samples` are earlier `{ ms, translateDone, pipelinesDone }`
/// observations, for the 30-second rate. `expected` is `{ programs, pipelines }`, the totals a warm-up log does not
/// state itself: with it, the per-program and per-pipeline lines are counted against it and the bar spans both phases
/// from the first line.
export function stateFrom(lines, { startedMs, nowMs, exit = null, samples = [], expected = null } = {}) {
  const translate = { done: 0, total: null };
  const pipelines = { done: 0, total: null };
  let newFormat = false;
  let sawPipelines = false;
  let sawSummary = false;
  let counted = false;
  for (const raw of lines) {
    const line = plain(raw);
    let m;
    if ((m = line.match(RE.total))) {
      translate.total = num(m[1]);
      newFormat = true;
    } else if ((m = line.match(RE.progress))) {
      translate.done = num(m[1]);
      translate.total = num(m[2]);
      newFormat = true;
    } else if ((m = line.match(RE.progress_old))) {
      translate.done = num(m[1]);
      if (m[2]) translate.total = num(m[2]);
    } else if ((m = line.match(RE.pipelines_total))) {
      pipelines.total = num(m[1]);
      sawPipelines = true;
    } else if ((m = line.match(RE.pipelines))) {
      pipelines.done = num(m[1]);
      pipelines.total = num(m[2]);
      sawPipelines = true;
    } else if ((m = line.match(RE.pipelines_old))) {
      pipelines.done = num(m[1]);
      if (m[2]) pipelines.total = num(m[2]);
      sawPipelines = true;
    } else if ((m = line.match(RE.summary))) {
      translate.done = num(m[1]);
      translate.total = num(m[2]);
      sawSummary = true;
    } else if ((m = line.match(RE.warm_summary))) {
      translate.done = num(m[1]) + num(m[2]);
      translate.total = translate.done;
      pipelines.done = num(m[3]) + num(m[4]);
      pipelines.total = pipelines.done;
      newFormat = true;
      sawPipelines = true;
      sawSummary = true;
    } else if (RE.done_line.test(line)) {
      translate.done += 1;
      counted = true;
    } else if (RE.pipeline_line.test(line)) {
      pipelines.done += 1;
      sawPipelines = true;
      counted = true;
    }
  }
  // A log that states no total: its lines are counted against the totals of the last finished warm-up, and grow past
  // them if this one turns out larger.
  if (counted && expected) {
    if (translate.total === null) translate.total = Math.max(expected.programs, translate.done);
    if (pipelines.total === null) pipelines.total = Math.max(expected.pipelines, pipelines.done);
    newFormat = true;
  }
  const phase = sawPipelines ? 'pipelines' : 'translating';
  const finished = exit !== null || sawSummary;
  const state = exit !== null ? (exit === 0 ? 'done' : 'failed') : sawSummary ? 'done' : 'running';
  const elapsed = startedMs ? Math.max(0, Math.round((nowMs - startedMs) / 1000)) : 0;
  // One bar across both phases for a build that prints pipeline lines or a closing line, or whose totals are
  // expected; the translation alone otherwise.
  let percent = null;
  if (newFormat || sawPipelines) {
    const t = translate.total ? Math.min(1, translate.done / translate.total) : 0;
    const p = pipelines.total ? Math.min(1, pipelines.done / pipelines.total) : 0;
    percent = round1((TRANSLATE_SHARE * t + PIPELINES_SHARE * p) * 100);
  } else if (translate.total) {
    percent = round1((translate.done / translate.total) * 100);
  }
  const current = phase === 'pipelines' ? pipelines : translate;
  return {
    updated: new Date(nowMs).toISOString(),
    state,
    label: LABEL,
    phase,
    done: current.done,
    total: current.total,
    translate_done: translate.done,
    translate_total: translate.total,
    pipelines_done: sawPipelines ? pipelines.done : null,
    pipelines_total: pipelines.total,
    percent,
    elapsed_s: elapsed,
    eta_s:
      newFormat || sawPipelines
        ? etaFor(phase, translate, pipelines, nowMs, samples, startedMs)
        : etaFromRate(translate.done, translate.total, nowMs, samples, startedMs),
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
    phase: state.phase,
    done: state.done,
    total: state.total,
    translate_done: state.translate_done,
    translate_total: state.translate_total,
    pipelines_done: state.pipelines_done,
    pipelines_total: state.pipelines_total,
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

/// The totals for a warm-up whose log states none: the closing line of the newest earlier `*.log.warm` in `dir` that
/// has one (programs translated plus refused, pipelines made plus refused), else `FALLBACK_EXPECTED`. `exceptLog` is
/// the warm-up being followed, which is never its own reference.
export function expectedFromLogs(dir, exceptLog = null, fsOps = fs) {
  try {
    const skip = exceptLog ? path.resolve(exceptLog) : null;
    const files = fsOps
      .readdirSync(dir)
      .filter((name) => name.endsWith('.log.warm'))
      .map((name) => path.join(dir, name))
      .filter((file) => path.resolve(file) !== skip)
      .map((file) => ({ file, mtime: fsOps.statSync(file).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, 12);
    for (const { file } of files) {
      const text = readTail(file, 16_384, fsOps);
      for (const raw of text.split(/\r?\n/).reverse()) {
        const m = plain(raw).match(RE.warm_summary);
        if (!m) continue;
        const programs = num(m[1]) + num(m[2]);
        const pipelines = num(m[3]) + num(m[4]);
        if (programs > 0 && pipelines > 0) return { programs, pipelines };
        break;
      }
    }
  } catch {
    // An unreadable folder is the same as an empty one.
  }
  return FALLBACK_EXPECTED;
}

function readTail(file, bytes, fsOps) {
  const fd = fsOps.openSync(file, 'r');
  try {
    const size = fsOps.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    fsOps.readSync(fd, buffer, 0, buffer.length, start);
    return buffer.toString('utf8');
  } finally {
    fsOps.closeSync(fd);
  }
}

/// A failed overlay write with one of these codes means a reader held the file at that moment: retried on the next
/// tick, never thrown (a feed that died this way left the bar at a stale value on the 09:19 warm-up).
export const RETRYABLE_WRITE_CODES = new Set(['EBUSY', 'EPERM', 'EACCES']);

/// One tick of the feed: read the log, write the overlay when due. No exception escapes: a write a reader blocked
/// is retried next tick without noise, and any other failure is reported through `warn` and the loop carries on.
export function makeTicker({ log, out, startedMs, expected = null, intervalMs = 500, fsOps = fs, warn = (m) => console.error(m) }) {
  let last = 0;
  let history = [];
  const tick = () => {
    try {
      const now = Date.now();
      const state = stateFrom(readLines(log), { startedMs, nowMs: now, samples: history, expected });
      // A minute of observations keeps a reference point past the 30-second window. `done` is the translation's
      // count, for a build that prints no pipeline lines.
      history = [
        ...history.filter((p) => now - p.ms <= 60_000),
        { ms: now, done: state.translate_done, translateDone: state.translate_done, pipelinesDone: state.pipelines_done ?? 0 },
      ];
      if (now - last >= intervalMs || state.finished) {
        try {
          write(out, state, fsOps);
          last = now;
        } catch (err) {
          if (!RETRYABLE_WRITE_CODES.has(err?.code)) {
            warn(`precompile-progress: overlay write failed (${err?.code ?? err}); retrying next tick`);
          }
        }
      }
    } catch (err) {
      warn(`precompile-progress: ${err?.stack ?? err}`);
    }
  };
  return { tick, get last() { return last; } };
}

/// Follows the log until stopped, writing at most twice a second; a SIGTERM writes one last running state.
export function follow(options) {
  const { tick } = makeTicker(options);
  tick();
  return setInterval(tick, options.intervalMs ?? 500);
}

function parse(argv) {
  const [what, ...rest] = argv;
  const options = { what };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--log') options.log = rest[++i];
    else if (rest[i] === '--out') options.out = rest[++i];
    else if (rest[i] === '--started-ms') options.startedMs = Number(rest[++i]);
    else if (rest[i] === '--exit') options.exit = Number(rest[++i]);
    else if (rest[i] === '--expect-from') options.expectFrom = rest[++i];
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
    'usage: node harness/precompile-progress.mjs follow --log <warm.log> --out <json> [--started-ms <ms>] [--expect-from <logs dir>]',
  );
  console.error(
    '       node harness/precompile-progress.mjs final  --log <warm.log> --out <json> --started-ms <ms> --exit <code> [--expect-from <logs dir>]',
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
  // The log states no totals, so they come from the newest earlier warm-up in the same folder unless told otherwise.
  const expected = expectedFromLogs(options.expectFrom ?? path.dirname(options.log), options.log);
  if (options.what === 'final') {
    const state = stateFrom(readLines(options.log), {
      startedMs: options.startedMs,
      nowMs: Date.now(),
      exit: options.exit,
      expected,
    });
    write(options.out, state);
    return 0;
  }
  const timer = follow({ log: options.log, out: options.out, startedMs: options.startedMs, expected });
  const stop = () => {
    clearInterval(timer);
    const last = stateFrom(readLines(options.log), { startedMs: options.startedMs, nowMs: Date.now(), expected });
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

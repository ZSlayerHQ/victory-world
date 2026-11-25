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
// phase's). A build that prints no pipeline lines keeps the older behaviour: the bar is the translation alone.
// `eta_s` is the current phase's rate over the last 30 seconds plus the other phase's estimate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_OUT = path.join(os.homedir(), '.config', 'victory-harness', 'stream', 'precompile.json');
const LABEL = 'Shader pre-compile';

// How the two phases share the bar, by measured wall time. A finished warm-up on 2026-11-25 printed
// `containers 25985 in 133.5 s: …` and `pipelines 28164 in the pack, 308.8 s: …` in its warm log
// (harness/logs/<stamp>-<tag>.log.warm): about 30% translating and 70% making pipelines. A newer warm-up's two
// summary lines are where a replacement comes from; update these two numbers together.
const TRANSLATE_SHARE = 0.3;
const PIPELINES_SHARE = 0.7;

const RE = {
  // Printed once before translation starts.
  total: /^progress\s+total\s+programs=([\d,]+)\s+containers=([\d,]+)/,
  // Printed by the translator at most twice a second and once at the end.
  progress: /^progress\s+translated\s+([\d,]+)\s+of\s+([\d,]+)\s+refused=([\d,]+)\s+failed_validation=([\d,]+)/,
  // The older form, for builds made before the refused= and failed_validation= fields.
  progress_old: /^progress\s+translated\s+([\d,]+)(?:\s+of\s+([\d,]+))?/,
  // The pipeline phase's lines, on a build that prints them.
  pipelines_total: /^progress\s+pipelines\s+total=([\d,]+)/,
  pipelines: /^progress\s+pipelines\s+([\d,]+)\s+of\s+([\d,]+)\s+failed=([\d,]+)/,
  pipelines_old: /^progress\s+pipelines\s+([\d,]+)(?:\s+of\s+([\d,]+))?/,
  // The end-of-run summary the log does print.
  summary: /^programs\s+([\d,]+) translated of ([\d,]+)/,
  // Per-program lines, if a later build prints them to the warm log.
  done_line: /^(?:shader translated|translated)\s/,
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
/// observations, for the 30-second rate. `onePhase` says the warm-up has no pipeline phase of its own (our line's
/// `victory warm` translates and makes compute pipelines as it goes): the bar is then the translation alone, 0 to
/// 100, and pipeline lines, if a build ever prints them, take it back to the two-phase bar.
export function stateFrom(lines, { startedMs, nowMs, exit = null, samples = [], onePhase = false } = {}) {
  const translate = { done: 0, total: null };
  const pipelines = { done: 0, total: null };
  let newFormat = false;
  let sawPipelines = false;
  let sawSummary = false;
  for (const line of lines) {
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
    } else if (RE.done_line.test(line)) {
      translate.done += 1;
    }
  }
  const phase = sawPipelines ? 'pipelines' : 'translating';
  const finished = exit !== null || sawSummary;
  const state = exit !== null ? (exit === 0 ? 'done' : 'failed') : sawSummary ? 'done' : 'running';
  const elapsed = startedMs ? Math.max(0, Math.round((nowMs - startedMs) / 1000)) : 0;
  // One bar across both phases for a build that prints the new lines; the translation alone otherwise (and for a
  // one-phase warm-up until pipeline lines ever appear).
  let percent = null;
  if ((newFormat || sawPipelines) && !(onePhase && !sawPipelines)) {
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
      (newFormat || sawPipelines) && !(onePhase && !sawPipelines)
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

/// Follows the log until stopped, writing at most twice a second; a SIGTERM writes one last running state.
export function follow({ log, out, startedMs, onePhase = false, intervalMs = 500 }) {
  let last = 0;
  let history = [];
  const tick = () => {
    const now = Date.now();
    const state = stateFrom(readLines(log), { startedMs, nowMs: now, samples: history, onePhase });
    // A minute of observations keeps a reference point past the 30-second window. `done` is the translation's count,
    // for a build that prints no pipeline lines.
    history = [
      ...history.filter((p) => now - p.ms <= 60_000),
      { ms: now, done: state.translate_done, translateDone: state.translate_done, pipelinesDone: state.pipelines_done ?? 0 },
    ];
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
    else if (rest[i] === '--one-phase') options.onePhase = true;
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
    'usage: node harness/precompile-progress.mjs follow --log <warm.log> --out <json> [--started-ms <ms>] [--one-phase]',
  );
  console.error(
    '       node harness/precompile-progress.mjs final  --log <warm.log> --out <json> --started-ms <ms> --exit <code> [--one-phase]',
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
      onePhase: options.onePhase === true,
    });
    write(options.out, state);
    return 0;
  }
  const timer = follow({ log: options.log, out: options.out, startedMs: options.startedMs, onePhase: options.onePhase === true });
  const stop = () => {
    clearInterval(timer);
    const last = stateFrom(readLines(options.log), { startedMs: options.startedMs, nowMs: Date.now(), onePhase: options.onePhase === true });
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

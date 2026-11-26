#!/usr/bin/env node
// Drive an open live session from a plan, then read the stretches back.
//
//   live-drive.sh run <plan.json> --log <run log> [--file <control file>]
//   live-drive.sh report --log <run log> [--json]
//
// A plan is {"baseline": {NAME: value, ...}, "steps": [{"label": "...", "set": {NAME: value, ...}, "hold_s": 30}],
// "repeat": 2}. The runner applies the baseline, holds it once (the first baseline of the first bracket), then for
// every step: sets the switches, waits for the runtime's `live: <NAME> ...` marker (15 s, then it stops: the game
// is not reading the file), holds hold_s seconds, restores the baseline and holds hold_s more. So every step is
// bracketed A, B, A. A second pass runs the steps in reverse order, which cancels an order effect; a third pass runs
// forward again. The baseline is restored on success, on a stop and on SIGINT/SIGTERM.
//
// The runner stops early when the log stops growing for 20 s, when a line carries `device removed` or `DXGI_ERROR`,
// or when a stretch's mean is over five times the first baseline's. It refuses an unknown live name, more than 40
// steps and a plan over 45 minutes.
//
// The labels are not in the game's log, so the runner writes a small sidecar beside the log
// (<log>.live-drive.json) with the plan and the segment numbers each label produced. `report` uses it, the parser
// in live-report.mjs and the log's segment lines to give every label a mean, a baseline, the difference and one of
// faster, slower, no difference or unreliable.
//
// There is no `keys` subcommand: run-world.sh passes VICTORY_KEYS in the environment when the title starts, and a
// running process's environment cannot be changed from a shell. Sending keys after launch would need the runtime
// to re-read a key list at a frame boundary (like VICTORY_LIVE) or a helper that injects input into the title's
// window; neither exists, so this tool does not invent one.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkName, checkValue, mergeControl, parseAssignment, readControl, writeAtomic } from './live.mjs';
import { LIVE_NAMES, isLiveName } from './live-names.mjs';
import { parseLiveLine, parseLiveLog } from './live-report.mjs';
import { stripAnsi } from './parse-run.mjs';

export const MIN_HOLD_S = 10;
export const MAX_HOLD_S = 300;
export const MAX_STEPS = 40;
export const MAX_TOTAL_S = 45 * 60;
export const MARKER_TIMEOUT_MS = 15_000;
export const STALL_MS = 20_000;
export const POLL_MS = 250;
export const FAILURE_RE = /DXGI_ERROR|device[ _]removed/i;

const DASH = '—';

/// A plan or command-line fault: the runner stops before touching the control file, and the shell gets exit 2.
export class PlanError extends Error {
  constructor(message) {
    super(message);
    this.exitCode = 2;
  }
}

/// A reason the run stopped: the log stalled, a device was removed, a stretch broke, a marker never came, or the
/// operator interrupted. The baseline is restored before the shell sees this.
export class StopError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const average = (values) => (values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null);
const round1 = (value) => (Number.isFinite(value) ? Math.round(value * 10) / 10 : null);
const one = (value) => (Number.isFinite(value) ? value.toFixed(1) : DASH);
const seconds = (ms) =>
  ms >= 1000 ? `${(ms / 1000).toFixed(ms % 1000 === 0 ? 0 : 1)} s` : `${ms} ms`;
const cell = (value) => String(value).replace(/\|/g, '\\|');
const setText = (set) =>
  Object.entries(set)
    .map(([name, value]) => `${name}=${value === '' ? '(empty)' : value}`)
    .join(' ');

/// A JSON value as the control file spells it: strings stay, numbers print, booleans become on/off. The value may
/// not carry a newline or `#`, the same rule live.sh applies.
function valueText(name, value, where) {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') {
    throw new PlanError(`${where}: ${name} must be a string, number or boolean`);
  }
  const text = (typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value)).trim();
  checkValue(name, text);
  return text;
}

function switchMap(value, where, { nonEmpty = false } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new PlanError(`${where} must be an object of NAME: value`);
  }
  const out = {};
  for (const [name, raw] of Object.entries(value)) {
    checkName(name);
    if (!isLiveName(name)) {
      throw new PlanError(`${where}: '${name}' is not a live switch (live: ${LIVE_NAMES.join(', ')})`);
    }
    out[name] = valueText(name, raw, where);
  }
  if (nonEmpty && !Object.keys(out).length) throw new PlanError(`${where} needs at least one switch`);
  return out;
}

/// The plan with its values as strings and every rule checked. Throws PlanError (exit 2).
export function normalizePlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new PlanError('the plan must be a JSON object');
  }
  const baseline = input.baseline === undefined ? {} : switchMap(input.baseline, 'baseline');
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    throw new PlanError('the plan needs a non-empty steps array');
  }
  if (input.steps.length > MAX_STEPS) {
    throw new PlanError(`the plan has ${input.steps.length} steps; the limit is ${MAX_STEPS}`);
  }
  const labels = new Set();
  const steps = input.steps.map((step, index) => {
    const where = `step ${index + 1}`;
    if (!step || typeof step !== 'object' || Array.isArray(step)) {
      throw new PlanError(`${where} must be an object`);
    }
    if (typeof step.label !== 'string' || !step.label.trim()) {
      throw new PlanError(`${where} needs a non-empty label`);
    }
    const label = step.label.trim();
    if (/[\r\n]/.test(label)) {
      throw new PlanError(`${where}: the label may not contain a newline`);
    }
    if (labels.has(label)) {
      throw new PlanError(`${where}: duplicate label '${label}'; a label names one report row`);
    }
    labels.add(label);
    const set = switchMap(step.set, `${where} ('${label}') set`, { nonEmpty: true });
    if (typeof step.hold_s !== 'number' || !Number.isFinite(step.hold_s)) {
      throw new PlanError(`${where} ('${label}'): hold_s must be a number of seconds`);
    }
    if (step.hold_s < MIN_HOLD_S || step.hold_s > MAX_HOLD_S) {
      throw new PlanError(
        `${where} ('${label}'): hold_s is ${step.hold_s}; it must be between ${MIN_HOLD_S} and ${MAX_HOLD_S} seconds`,
      );
    }
    return { label, set, hold_s: step.hold_s };
  });
  const repeat = input.repeat === undefined ? 1 : input.repeat;
  if (!Number.isInteger(repeat) || repeat < 1) {
    throw new PlanError('repeat must be a positive integer (1 runs the list once)');
  }
  const plan = { baseline, steps, repeat };
  const total = totalSeconds(plan);
  if (total > MAX_TOTAL_S) {
    throw new PlanError(
      `the plan is ${(total / 60).toFixed(1)} minutes long; the limit is ${MAX_TOTAL_S / 60} minutes ` +
        '(the initial baseline and both holds for every step of every pass)',
    );
  }
  return plan;
}

/// Every step occurrence in run order: one pass forward, the next in reverse, and so on. `pass` is 1-based.
export function occurrencesOf(plan) {
  const out = [];
  for (let pass = 0; pass < plan.repeat; pass += 1) {
    const indices = plan.steps.map((_, index) => index);
    const reversed = pass % 2 === 1;
    if (reversed) indices.reverse();
    for (const index of indices) {
      const step = plan.steps[index];
      out.push({
        pass: pass + 1,
        direction: reversed ? 'reverse' : 'forward',
        index,
        label: step.label,
        set: step.set,
        hold_s: step.hold_s,
      });
    }
  }
  return out;
}

/// The holds the plan asks for: the initial baseline, then a step hold and a baseline hold for every occurrence.
/// Marker waits are not included; they are bounded by the 15 s timeout. Arithmetic, not a list of occurrences, so
/// a huge repeat is refused instead of built.
export function totalSeconds(plan) {
  const initial = plan.steps[0]?.hold_s ?? 0;
  const perPass = plan.steps.reduce((sum, step) => sum + 2 * step.hold_s, 0);
  return initial + plan.repeat * perPass;
}

/// A control file the runtime will ignore is worth refusing before the first write: the runtime ignores the whole
/// file until it changes again when a non-comment line is not NAME=value, so every marker wait would time out.
function checkControlText(text) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const body = lines[i].replace(/#.*$/, '').trim();
    if (!body) continue;
    if (!parseAssignment(lines[i])) {
      throw new PlanError(
        `the control file line ${i + 1} is not NAME=value; the runtime ignores the whole file and would never ` +
          'log a marker',
      );
    }
  }
}

/// The live assignments in a control file's text, later lines winning as the runtime does.
function assignmentsOf(text) {
  const out = {};
  for (const line of String(text).split(/\r?\n/)) {
    const assignment = parseAssignment(line);
    if (assignment && isLiveName(assignment.name)) out[assignment.name] = assignment.value;
  }
  return out;
}

/// The live names a state sets: the baseline, with a step's values on top. A name in neither is unset, so the
/// runtime falls back to the value it started with.
function targetOf(baseline, extra = {}) {
  const target = {};
  for (const name of LIVE_NAMES) {
    if (Object.hasOwn(baseline, name)) target[name] = baseline[name];
    if (Object.hasOwn(extra, name)) target[name] = extra[name];
  }
  return target;
}

/// Writes a state through live.mjs's atomic merge and returns the live names whose file value moved.
function writeState(file, target) {
  const text = readControl(file) ?? '';
  const before = assignmentsOf(text);
  const changed = LIVE_NAMES.filter((name) => before[name] !== target[name]);
  const unset = LIVE_NAMES.filter((name) => !Object.hasOwn(target, name));
  writeAtomic(file, mergeControl(text, { set: target, unset }));
  return changed;
}

/// The tail of a run log, starting where the runner started. It keeps only the parsed markers and segments, so a
/// long run's frame lines do not accumulate, and it notices the two failure strings on every line.
class LogWatcher {
  constructor(file, { now }) {
    this.file = file;
    this.now = now;
    const stat = fs.statSync(file);
    this.offset = stat.size;
    this.tail = '';
    this.seq = 0;
    this.markers = [];
    this.segments = [];
    this.pending = [];
    this.lastGrowthAt = now();
    this.failure = null;
    // A driver can be pointed at a title that already lost its device; check the log's recent tail once, without
    // keeping any of it, so the run stops before it measures a dead game.
    const tailStart = Math.max(0, stat.size - 64 * 1024);
    if (stat.size > tailStart) {
      const buffer = Buffer.alloc(stat.size - tailStart);
      const fd = fs.openSync(file, 'r');
      try {
        fs.readSync(fd, buffer, 0, buffer.length, tailStart);
      } finally {
        fs.closeSync(fd);
      }
      const failed = FAILURE_RE.exec(stripAnsi(buffer.toString('utf8')));
      if (failed) this.failure = /DXGI_ERROR/i.test(failed[0]) ? 'DXGI_ERROR' : 'device removed';
    }
  }

  poll() {
    let stat;
    try {
      stat = fs.statSync(this.file);
    } catch (err) {
      throw new StopError(`cannot read the run log (${err.code || err.message})`);
    }
    if (stat.size < this.offset) {
      this.offset = 0;
      this.tail = '';
    }
    if (stat.size === this.offset) return;
    const length = stat.size - this.offset;
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buffer, 0, length, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = stat.size;
    this.lastGrowthAt = this.now();
    const text = this.tail + buffer.toString('utf8');
    const lines = text.split('\n');
    this.tail = lines.pop();
    for (const line of lines) this.consume(line);
  }

  consume(raw) {
    this.seq += 1;
    const text = stripAnsi(raw).replace(/\r$/, '');
    const failed = this.failure ? null : FAILURE_RE.exec(text);
    if (failed) this.failure = /DXGI_ERROR/i.test(failed[0]) ? 'DXGI_ERROR' : 'device removed';
    const parsed = parseLiveLine(raw);
    if (!parsed) return;
    if (parsed.change) {
      const marker = { seq: this.seq, ...parsed.change };
      this.markers.push(marker);
      this.pending.push(parsed.change);
    } else {
      const segment = { seq: this.seq, ...parsed.segment, changes: this.pending };
      this.pending = [];
      this.segments.push(segment);
    }
  }

  markerAfter(seq, name) {
    return this.markers.find((marker) => marker.seq > seq && marker.name === name) ?? null;
  }

  markersAfter(seq, names) {
    return names.map((name) => this.markerAfter(seq, name));
  }

  /// The last segment line before `seq` and after `minSeq`: the stretch a change just closed.
  latestSegmentBefore(seq, minSeq = -1) {
    for (let i = this.segments.length - 1; i >= 0; i -= 1) {
      const segment = this.segments[i];
      if (segment.seq < seq && segment.seq > minSeq) return segment;
    }
    return null;
  }
}

function safetyCheck({ watcher, safety, stallMs, now }) {
  if (watcher.failure) throw new StopError(`the log carries '${watcher.failure}'`);
  if (stallMs != null && now() - watcher.lastGrowthAt > stallMs) {
    throw new StopError(`the run log has not grown for ${seconds(stallMs)}; the game ended or hung`);
  }
  for (; safety.checked < watcher.segments.length; safety.checked += 1) {
    const segment = watcher.segments[safety.checked];
    if (segment.seq <= safety.armedSeq) continue;
    if (safety.baselineMean == null) {
      safety.baselineMean = segment.mean;
    } else if (segment.mean > safety.baselineMean * 5) {
      throw new StopError(
        `segment ${segment.segment} means ${one(segment.mean)} ms, over five times the first baseline's ` +
          `${one(safety.baselineMean)} ms; something broke`,
      );
    }
  }
}

function checkAbort(signal) {
  if (signal?.aborted) throw new StopError('interrupted', 130);
}

async function hold(ctx, ms) {
  const end = ctx.now() + ms;
  for (;;) {
    checkAbort(ctx.signal);
    ctx.watcher.poll();
    safetyCheck(ctx);
    const left = end - ctx.now();
    if (left <= 0) return;
    await ctx.sleep(Math.min(ctx.pollMs, left));
  }
}

/// Waits for a marker for every changed name, after `mark`. Returns the markers in `names` order.
async function waitForMarkers(ctx, names, mark) {
  if (!names.length) return [];
  const deadline = ctx.now() + ctx.markerTimeoutMs;
  for (;;) {
    checkAbort(ctx.signal);
    ctx.watcher.poll();
    safetyCheck(ctx);
    const markers = ctx.watcher.markersAfter(mark, names);
    if (markers.every(Boolean)) return markers;
    if (ctx.now() >= deadline) {
      const missing = names.filter((_, index) => !markers[index]);
      throw new StopError(
        `timed out after ${seconds(ctx.markerTimeoutMs)} waiting for the game to log ` +
          `${missing.join(', ')}; the game is not reading the control file`,
      );
    }
    await ctx.sleep(Math.min(ctx.pollMs, Math.max(1, deadline - ctx.now())));
  }
}

/// Writes a state and, when `wait`, waits for every marker its changed names produce.
async function applyState(ctx, target, { wait = true } = {}) {
  ctx.watcher.poll();
  safetyCheck(ctx);
  const mark = ctx.watcher.seq;
  const changed = writeState(ctx.controlFile, target);
  if (!wait || !changed.length) return { changed, mark, markers: [], firstSeq: null };
  const markers = await waitForMarkers(ctx, changed, mark);
  const firstSeq = Math.min(...markers.map((marker) => marker.seq));
  return { changed, mark, markers, firstSeq };
}

function say(ctx, text) {
  ctx.out.write(`live-drive: ${text}\n`);
}

function describeSet(set) {
  return Object.entries(set)
    .map(([name, value]) => `${name}=${value === '' ? '(empty)' : value}`)
    .join(' ');
}

/// The sidecar's path: beside the log, so `report --log` finds it without another argument.
export function timelinePath(logFile) {
  return `${logFile}.live-drive.json`;
}

/// Runs a normalized plan against an open session. Returns { plan, occurrences, timeline }. Throws PlanError before
/// writing anything, and StopError after restoring the baseline.
export async function runPlan(input, options = {}) {
  const plan = normalizePlan(input);
  const opts = {
    logFile: options.logFile ?? null,
    controlFile: options.controlFile ?? null,
    markerTimeoutMs: options.markerTimeoutMs ?? MARKER_TIMEOUT_MS,
    stallMs: options.stallMs ?? STALL_MS,
    pollMs: options.pollMs ?? POLL_MS,
    holdScale: options.holdScale ?? 1,
    sleep: options.sleep ?? realSleep,
    now: options.now ?? Date.now,
    signal: options.signal ?? null,
    out: options.out ?? process.stdout,
    err: options.err ?? process.stderr,
    writeTimeline: options.writeTimeline ?? true,
  };
  if (!opts.logFile) throw new PlanError('no run log: pass --log <path>');
  if (!opts.controlFile) throw new PlanError('no control file: pass --file <path> or set VICTORY_LIVE');
  try {
    fs.accessSync(opts.logFile, fs.constants.R_OK);
  } catch (err) {
    throw new PlanError(`cannot read the run log (${err.code || err.message})`);
  }
  if (!(opts.holdScale > 0) || !Number.isFinite(opts.holdScale)) {
    throw new PlanError('holdScale must be a positive number');
  }
  const controlText = readControl(opts.controlFile);
  if (controlText != null) checkControlText(controlText);

  const watcher = new LogWatcher(opts.logFile, { now: opts.now });
  const safety = { baselineMean: null, checked: 0, armedSeq: Number.POSITIVE_INFINITY };
  const ctx = { ...opts, watcher, safety };
  const baselineTarget = targetOf(plan.baseline);
  const occurrences = occurrencesOf(plan);
  const timeline = {
    version: 1,
    plan,
    baseline: plan.baseline,
    startedAt: new Date().toISOString(),
    finishedAt: null,
    restored: false,
    stopped: null,
    occurrences: [],
  };
  let timelineWarned = false;
  const saveTimeline = () => {
    if (!opts.writeTimeline) return;
    try {
      writeAtomic(timelinePath(opts.logFile), `${JSON.stringify(timeline, null, 2)}\n`);
    } catch (err) {
      if (!timelineWarned) {
        timelineWarned = true;
        opts.err.write(
          `live-drive: warning: cannot write the timeline beside the log (${err.code || err.message}); ` +
            'report will have no labels\n',
        );
      }
    }
  };
  let failure = null;
  try {
    say(ctx, `baseline: ${describeSet(plan.baseline) || '(none)'}`);
    // No marker wait here: the baseline may set a value the title already has (the environment default), which logs
    // nothing. The initial baseline hold gives the runtime time to apply what did change; the first step's marker
    // is what proves the game is reading the file.
    const baselineWrite = await applyState(ctx, baselineTarget, { wait: false });
    const initialHoldMs = occurrences[0].hold_s * 1000 * opts.holdScale;
    say(ctx, `initial baseline hold: ${seconds(initialHoldMs)}`);
    await hold(ctx, initialHoldMs);

    // Arm after the baseline has had the whole first hold to be applied. A pre-baseline segment is before the
    // baseline markers; the A that closes at the first step is after them. If the baseline logged nothing (its
    // values were already in force), the write itself is the boundary.
    const baselineMarkers = watcher.markersAfter(baselineWrite.mark, baselineWrite.changed).filter(Boolean);
    const baselineSeq = baselineMarkers.length
      ? Math.max(...baselineMarkers.map((marker) => marker.seq))
      : baselineWrite.mark;
    safety.armedSeq = baselineSeq;
    safety.checked = watcher.segments.length;
    const associationMin = baselineSeq;
    saveTimeline();

    for (let i = 0; i < occurrences.length; i += 1) {
      const occurrence = occurrences[i];
      const record = {
        pass: occurrence.pass,
        direction: occurrence.direction,
        index: occurrence.index,
        label: occurrence.label,
        set: occurrence.set,
        hold_s: occurrence.hold_s,
        beforeSegment: null,
        stepSegment: null,
        afterSegment: null,
      };
      timeline.occurrences.push(record);
      saveTimeline();

      const where = `${i + 1}/${occurrences.length} '${occurrence.label}'`;
      say(ctx, `step ${where}: setting ${describeSet(occurrence.set)}`);
      const setResult = await applyState(ctx, targetOf(plan.baseline, occurrence.set), { wait: true });
      if (setResult.firstSeq != null) {
        const closing = watcher.latestSegmentBefore(setResult.firstSeq, associationMin);
        if (closing) {
          record.beforeSegment = closing.segment;
          if (i > 0) timeline.occurrences[i - 1].afterSegment = closing.segment;
        }
      }
      saveTimeline();

      const holdMs = occurrence.hold_s * 1000 * opts.holdScale;
      say(ctx, `step ${where}: holding ${seconds(holdMs)}`);
      await hold(ctx, holdMs);

      say(ctx, `step ${where}: restoring the baseline`);
      const restoreResult = await applyState(ctx, baselineTarget, { wait: true });
      if (restoreResult.firstSeq != null) {
        const closing = watcher.latestSegmentBefore(restoreResult.firstSeq, associationMin);
        if (closing) record.stepSegment = closing.segment;
      }
      saveTimeline();

      say(ctx, `step ${where}: baseline hold ${seconds(holdMs)}`);
      await hold(ctx, holdMs);
    }
    say(ctx, 'done');
    return { plan, occurrences: timeline.occurrences, timeline };
  } catch (err) {
    failure = err;
    throw err;
  } finally {
    let restoreError = null;
    try {
      writeState(opts.controlFile, baselineTarget);
      timeline.restored = true;
    } catch (err) {
      restoreError = err;
    }
    timeline.finishedAt = new Date().toISOString();
    if (failure) timeline.stopped = failure.message;
    saveTimeline();
    if (restoreError) {
      opts.err.write(`live-drive: could not restore the baseline (${restoreError.code || restoreError.message})\n`);
      if (!failure) {
        throw new StopError(`could not restore the baseline (${restoreError.code || restoreError.message})`);
      }
    } else {
      say(ctx, 'baseline restored');
    }
  }
}

// ----------------------------------------------------------------------------------------------------------------
// report

/// The sidecar beside a log, or null when there is none (or it is not JSON this version wrote).
export function loadTimeline(logFile) {
  try {
    const timeline = JSON.parse(fs.readFileSync(timelinePath(logFile), 'utf8'));
    return timeline && timeline.version === 1 ? timeline : null;
  } catch {
    return null;
  }
}

/// One occurrence with its three segments resolved against the log. Missing segments stay null.
function resolveOccurrence(occurrence, byNumber) {
  const step = byNumber.get(Number(occurrence.stepSegment)) ?? null;
  let before = byNumber.get(Number(occurrence.beforeSegment)) ?? null;
  let after = byNumber.get(Number(occurrence.afterSegment)) ?? null;
  if (!before && step) before = byNumber.get(step.segment - 1) ?? null;
  if (!after && step) after = byNumber.get(step.segment + 1) ?? null;
  return { ...occurrence, step, before, after };
}

/// Labels for a log without a sidecar: every segment a change cut, with the next segment as its baseline. A restore
/// also cuts a segment, so this fallback can list one row too many; the sidecar is what the runner writes.
function fallbackOccurrences(segments) {
  return segments
    .map((segment, index) => {
      if (!segment.changes.length) return null;
      const set = {};
      for (const change of segment.changes) set[change.name] = change.new;
      return {
        label: segment.changes.map((change) => `${change.name}=${change.new || '(empty)'}`).join(' '),
        set,
        pass: 1,
        direction: 'unknown',
        beforeSegment: segments[index - 1]?.segment ?? null,
        stepSegment: segment.segment,
        afterSegment: segments[index + 1]?.segment ?? null,
      };
    })
    .filter(Boolean);
}

function rowFor(label, resolved) {
  const steps = resolved.map((occurrence) => occurrence.step).filter(Boolean);
  // Adjacent steps share the baseline between them; count each stretch once in the row's baseline and spread.
  const baselineByNumber = new Map();
  for (const occurrence of resolved) {
    for (const segment of [occurrence.before, occurrence.after]) {
      if (segment) baselineByNumber.set(segment.segment, segment);
    }
  }
  const baselines = [...baselineByNumber.values()];
  const stepMean = average(steps.map((segment) => segment.mean));
  const p95 = average(steps.map((segment) => segment.p95));
  const baselineMean = average(baselines.map((segment) => segment.mean));
  const difference = stepMean != null && baselineMean != null ? stepMean - baselineMean : null;
  const percent = difference != null && baselineMean ? (difference / baselineMean) * 100 : null;
  const stepMeans = steps.map((segment) => segment.mean);
  const spread = stepMeans.length > 1 ? Math.max(...stepMeans) - Math.min(...stepMeans) : null;
  const baselineMeans = baselines.map((segment) => segment.mean);
  const baselineSpread =
    baselineMeans.length > 1 ? Math.max(...baselineMeans) - Math.min(...baselineMeans) : null;

  const reasons = [];
  for (const occurrence of resolved) {
    const pass = occurrence.pass ? `pass ${occurrence.pass}` : 'step';
    if (!occurrence.step) {
      reasons.push(`${pass}: the step stretch is not in the log`);
      continue;
    }
    if (occurrence.step.short) {
      reasons.push(`${pass}: the step stretch is short (${occurrence.step.frameCount} frames)`);
    }
    if (!occurrence.before || !occurrence.after) {
      const side = !occurrence.before ? 'before' : 'after';
      reasons.push(
        `${pass}: the baseline ${side} the step is not in the log yet` +
          (side === 'after' ? ' (the title logs it when it exits)' : ''),
      );
      continue;
    }
    if (occurrence.before.short) {
      reasons.push(`${pass}: the baseline before the step is short (${occurrence.before.frameCount} frames)`);
    }
    if (occurrence.after.short) {
      reasons.push(`${pass}: the baseline after the step is short (${occurrence.after.frameCount} frames)`);
    }
    const localBaseline = (occurrence.before.mean + occurrence.after.mean) / 2;
    const localEffect = occurrence.step.mean - localBaseline;
    const drift = Math.abs(occurrence.before.mean - occurrence.after.mean);
    if (drift > Math.abs(localEffect)) {
      reasons.push(
        `${pass}: the two baselines differ by ${one(drift)} ms, more than the ${one(Math.abs(localEffect))} ms effect`,
      );
    }
  }

  let verdict = 'unreliable';
  if (!reasons.length && difference != null) {
    if (baselineSpread != null && Math.abs(difference) <= baselineSpread) verdict = 'no difference';
    else verdict = difference < 0 ? 'faster' : 'slower';
  }

  return {
    label,
    set: resolved[0]?.set ?? {},
    mean: round1(stepMean),
    p95: round1(p95),
    baseline: round1(baselineMean),
    difference: round1(difference),
    percent: percent == null ? null : Math.round(percent * 10) / 10,
    spread: round1(spread),
    verdict,
    reason: reasons,
    repeats: resolved.map((occurrence) => ({
      pass: occurrence.pass,
      mean: round1(occurrence.step?.mean),
      p95: round1(occurrence.step?.p95),
      baseline:
        occurrence.before || occurrence.after
          ? round1(
              average([occurrence.before, occurrence.after].filter(Boolean).map((segment) => segment.mean)),
            )
          : null,
      difference:
        occurrence.step && (occurrence.before || occurrence.after)
          ? round1(
              occurrence.step.mean -
                average([occurrence.before, occurrence.after].filter(Boolean).map((segment) => segment.mean)),
            )
          : null,
    })),
  };
}

/// The report rows for parsed segments and a sidecar (or null). Exported for the tests and for the command.
export function reportRows(segments, timeline) {
  const byNumber = new Map(segments.map((segment) => [segment.segment, segment]));
  const occurrences = timeline?.occurrences?.length ? timeline.occurrences : fallbackOccurrences(segments);
  const groups = new Map();
  for (const occurrence of occurrences) {
    const resolved = resolveOccurrence(occurrence, byNumber);
    if (!groups.has(resolved.label)) groups.set(resolved.label, []);
    groups.get(resolved.label).push(resolved);
  }
  return [...groups.entries()].map(([label, resolved]) => rowFor(label, resolved));
}

function differenceText(row) {
  if (row.difference == null) return DASH;
  const sign = row.difference > 0 ? '+' : '';
  const percent = row.percent == null ? '' : ` (${sign}${row.percent.toFixed(1)}%)`;
  return `${sign}${row.difference.toFixed(1)} ms${percent}`;
}

export function formatDriveReport(rows, timeline) {
  if (!rows.length) return 'no live steps';
  const out = [
    '# live-drive report',
    '| label | set to | mean (ms) | p95 (ms) | baseline (ms) | difference | repeat spread (ms) | verdict |',
    '|---|---|---|---|---|---|---|---|',
  ];
  for (const row of rows) {
    out.push(
      `| ${cell(row.label)} | ${cell(setText(row.set) || DASH)} | ${one(row.mean)} | ${one(row.p95)} | ` +
        `${one(row.baseline)} | ${differenceText(row)} | ${row.spread == null ? DASH : one(row.spread)} | ${row.verdict} |`,
    );
  }
  const notes = rows.flatMap((row) => row.reason.map((reason) => `${row.label}: ${reason}`));
  if (notes.length) {
    out.push('', 'notes:');
    for (const note of notes) out.push(`- ${note}`);
  }
  if (timeline?.stopped) out.push('', `runner stopped: ${timeline.stopped}`);
  if (timeline?.restored === false) out.push('', 'the runner could not restore the baseline');
  if (!timeline) {
    out.push(
      '',
      'no <log>.live-drive.json beside the log; labels come from the segment changes (the runner writes that sidecar).',
    );
  }
  return out.join('\n');
}

// ----------------------------------------------------------------------------------------------------------------
// command line

function usage(stream = process.stderr) {
  stream.write(
    'usage: live-drive.sh run <plan.json> --log <run log> [--file <control file>]\n' +
      '       live-drive.sh report --log <run log> [--json]\n' +
      'The control file comes from --file, else VICTORY_LIVE. A plan is\n' +
      '  {"baseline": {NAME: value}, "steps": [{"label": "...", "set": {NAME: value}, "hold_s": 30}], "repeat": 2}\n',
  );
}

function reportCommand(argv) {
  let logFile = null;
  let json = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--log') {
      if (i + 1 >= argv.length) {
        console.error('live-drive: --log needs a path');
        return 2;
      }
      logFile = argv[(i += 1)];
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--help' || arg === '-h') {
      usage(process.stdout);
      return 0;
    } else {
      console.error(`live-drive: unknown option or extra argument '${arg}' for report`);
      usage();
      return 2;
    }
  }
  if (!logFile) {
    console.error('live-drive: report needs --log <run log>');
    usage();
    return 2;
  }
  let text;
  try {
    text = fs.readFileSync(logFile, 'utf8');
  } catch (err) {
    console.error(`live-drive: cannot read the run log (${err.code || err.message})`);
    return 1;
  }
  const segments = parseLiveLog(text);
  const timeline = loadTimeline(logFile);
  const rows = reportRows(segments, timeline);
  if (json) console.log(JSON.stringify(rows, null, 2));
  else console.log(formatDriveReport(rows, timeline));
  return 0;
}

async function runCommand(argv, env) {
  let planFile = null;
  let logFile = null;
  let controlFile = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--log') {
      if (i + 1 >= argv.length) {
        console.error('live-drive: --log needs a path');
        return 2;
      }
      logFile = argv[(i += 1)];
    } else if (arg === '--file') {
      if (i + 1 >= argv.length) {
        console.error('live-drive: --file needs a path');
        return 2;
      }
      controlFile = argv[(i += 1)];
    } else if (arg === '--help' || arg === '-h') {
      usage(process.stdout);
      return 0;
    } else if (arg.startsWith('-')) {
      console.error(`live-drive: unknown option '${arg}'`);
      usage();
      return 2;
    } else if (planFile === null) {
      planFile = arg;
    } else {
      console.error(`live-drive: one plan at a time, not '${arg}'`);
      usage();
      return 2;
    }
  }
  if (!planFile) {
    console.error('live-drive: run needs a plan file');
    usage();
    return 2;
  }
  if (!logFile) {
    console.error('live-drive: run needs --log <run log>');
    usage();
    return 2;
  }
  const target = controlFile || env.VICTORY_LIVE;
  if (!target) {
    console.error('live-drive: no control file: pass --file <path> or set VICTORY_LIVE');
    return 2;
  }
  let input;
  try {
    input = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  } catch (err) {
    console.error(`live-drive: cannot read the plan (${err.code || err.message})`);
    return 2;
  }
  let plan;
  try {
    plan = normalizePlan(input);
  } catch (err) {
    console.error(`live-drive: ${err.message}`);
    return err.exitCode || 2;
  }

  const controller = new AbortController();
  let signals = 0;
  const onSignal = () => {
    signals += 1;
    if (signals > 1) process.exit(130);
    controller.abort();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  try {
    await runPlan(plan, { logFile, controlFile: target, signal: controller.signal });
    return 0;
  } catch (err) {
    if (err instanceof StopError) {
      console.error(`live-drive: stopped: ${err.message}`);
      return err.exitCode;
    }
    console.error(`live-drive: ${err.message}`);
    return err.exitCode || 1;
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

/// The command line. Returns an exit code.
export async function main(argv, env = process.env) {
  if (!argv.length) {
    usage();
    return 2;
  }
  if (argv[0] === '--help' || argv[0] === '-h') {
    usage(process.stdout);
    return 0;
  }
  const [command, ...rest] = argv;
  if (command === 'run') return runCommand(rest, env);
  if (command === 'report') return reportCommand(rest);
  console.error(`live-drive: unknown command '${command}'`);
  usage();
  return 2;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (err) => {
      console.error(`live-drive: ${err.message}`);
      process.exitCode = 1;
    },
  );
}

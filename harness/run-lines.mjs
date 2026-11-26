#!/usr/bin/env node
// Parsers for the lines the speed work added on 2026-11-25, shared by compare-runs.mjs and summarize-run.mjs:
// host capabilities, the per-thread card clock, table constants, buffer copies, the settle reasons by kind, and
// the pipelines left out by reason.
//
// Shapes are taken from run logs where a line has appeared there (table constants, the settle lines, the
// dropped-pipeline lines) and from the engineers' written specifications where it has not yet (host capabilities,
// the thread clock, buffer copies). Each parser returns null
// for a line of another kind, so a build that does not print one simply contributes nothing.

import { median } from './parse-run.mjs';

const N = String.raw`([\d.]+)`;

// A log line carries a tracing prefix ("2026-11-25T08:01:57.353138Z INFO victory_gpu::constants: ..."), so no
// pattern is anchored at the start; each is distinctive enough to match anywhere in a line.
export const CAPABILITIES_RE = /host capabilities:\s*(.+)$/;
export const THREADS_RE = new RegExp(String.raw`card clock threads: frame=${N} \| (.*)$`);
export const TABLE_CONSTANTS_RE = new RegExp(
  String.raw`table constants per frame(?:\s*\(VICTORY_TABLE_CONSTANTS=1\))?: ${N} read in place, ${N} copied \((.*?)\)(?:;\s*${N} refreshes waited ${N} ms)?`,
);
export const BUFFER_COPIES_RE = new RegExp(
  String.raw`buffer copies per frame: ${N} on the card from host copies \(${N} MB\), ${N} read from title memory on the CPU \(${N} MB: (.*?)\), ${N} of them settled the flights in the air \(${N} MB\)`,
);
export const SETTLE_MS_RE = /of the (?:waiting for the card in settles|host time waiting for settles), per frame, by what settled:\s*(.*)$/;
export const LEFT_OUT_RE = new RegExp(String.raw`dropped ${N}/frame without a host pipeline: (.*)$`);
export const AHEAD_RE =
  /submissions sent ahead per frame: ([\d.]+) in ([\d.]+) settles \((?:([\d.]+) flights each time|flights landed by the relay)\), ([\d.]+) ms (?:waiting for the card in them|host time waiting for settles); settled for: (.*?)(?:;|$)/;

/// Splits a comma-separated list on its own commas, ignoring commas inside parentheses.
export function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let at = 0;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (c === '(') depth += 1;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(at, i));
      at = i + 1;
    }
  }
  parts.push(text.slice(at));
  return parts.map((part) => part.trim()).filter(Boolean);
}

/// "name N, name N" as { name: N }.
export function parseReasons(text) {
  const out = {};
  for (const part of splitTopLevel(text)) {
    const m = part.match(/^(.*?)\s+([\d.]+)$/);
    if (m) out[m[1].trim()] = Number(m[2]);
  }
  return out;
}

/// "host capabilities: a=1 b=0 c=-1" as { raw, fields }; the row is printed as the author wrote it.
export function parseCapabilities(line) {
  const m = line.match(CAPABILITIES_RE);
  if (!m) return null;
  const fields = {};
  for (const token of m[1].trim().split(/\s+/)) {
    const kv = token.match(/^(\w+)=(-\d+|\d+)$/);
    if (kv) fields[kv[1]] = Number(kv[2]);
  }
  return { raw: m[1].trim(), fields };
}

/// "card clock threads: frame=1.0 | \"name\" u k p | ... | other u k p | total u k p".
export function parseThreadClock(line) {
  const m = line.match(THREADS_RE);
  if (!m) return null;
  const out = { frame: Number(m[1]), threads: [], other: null, total: null };
  for (const segment of m[2].split(' | ').map((s) => s.trim()).filter(Boolean)) {
    const named = segment.match(/^"([^"]*)"\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)$/);
    if (named) {
      out.threads.push({ name: named[1], user: Number(named[2]), kernel: Number(named[3]), pct: Number(named[4]) });
      continue;
    }
    const sum = segment.match(/^(other|total)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)$/);
    if (sum) {
      const entry = { user: Number(sum[2]), kernel: Number(sum[3]), pct: Number(sum[4]) };
      if (sum[1] === 'other') out.other = entry;
      else out.total = entry;
    }
  }
  return out;
}

/// "table constants per frame (VICTORY_TABLE_CONSTANTS=1): N read in place, N copied (reasons); N refreshes ...".
export function parseTableConstants(line) {
  const m = line.match(TABLE_CONSTANTS_RE);
  if (!m) return null;
  return {
    inPlace: Number(m[1]),
    copied: Number(m[2]),
    reasons: parseReasons(m[3]),
    waited: m[4] === undefined ? null : Number(m[4]),
    waitedMs: m[5] === undefined ? null : Number(m[5]),
  };
}

/// "buffer copies per frame: N on the card (X MB), N on the CPU (X MB: reasons), N settled flights (X MB)".
export function parseBufferCopies(line) {
  const m = line.match(BUFFER_COPIES_RE);
  if (!m) return null;
  return {
    onCard: Number(m[1]),
    onCardMb: Number(m[2]),
    onCpu: Number(m[3]),
    onCpuMb: Number(m[4]),
    reasons: parseReasons(m[5]),
    settled: Number(m[6]),
    settledMb: Number(m[7]),
  };
}

/// "of the (?:waiting for the card in settles|host time waiting for settles), per frame, by what settled: reason ms, reason ms, ...".
export function parseSettleMs(line) {
  const m = line.match(SETTLE_MS_RE);
  if (!m) return null;
  const out = {};
  for (const part of splitTopLevel(m[1])) {
    const bare = part.replace(/\s+ms$/, '');
    const kv = bare.match(/^(.*?)\s+([\d.]+)$/);
    if (kv) out[kv[1].trim()] = Number(kv[2]);
  }
  return out;
}

/// The recording threads' per-frame wait for pipelines, from the copystat line ("…; 0.0 ms waiting for pipelines;").
const PIPELINE_WAIT_RE = /(?:^|\s)([\d.]+) ms waiting for pipelines/;

export function parsePipelineWait(line) {
  const m = line.match(PIPELINE_WAIT_RE);
  return m ? Number(m[1]) : null;
}

/// "dropped N/frame without a host pipeline: <reason>".
export function parseLeftOut(line) {
  const m = line.match(LEFT_OUT_RE);
  if (!m) return null;
  return { perFrame: Number(m[1]), reason: m[2].trim() };
}

/// One reason of the late line's "settled for:" list: "name N", or "name N (by a ... X, a ... Y)" with its parts.
export function parseReasonPart(part) {
  const withParts = part.match(/^(.*?)\s+([\d.]+)\s+\(by (.*?)\)$/);
  if (withParts) return { reason: withParts[1].trim(), count: Number(withParts[2]), by: parseReasons(withParts[3]) };
  const m = part.trim().match(/^(.*?)\s+([\d.]+)$/);
  return m ? { reason: m[1].trim(), count: Number(m[2]), by: {} } : null;
}

/// The same reason as both settle lines name it: the late line writes "256 lists in the air" and
/// "bottom-of-pipe writes (VICTORY_LATE_WAIT_WRITES=0)" where the milliseconds line writes "lists in the air" and
/// "bottom-of-pipe writes", so a count and its milliseconds join on this key.
export function reasonKey(reason) {
  return reason
    .replace(/^\d+\s+/, '')
    .replace(/\s+\(VICTORY_[A-Z0-9_]+(?:=[\w-]+)?\)\s*$/, '')
    .trim();
}

/// The late-submission line: flights, settles, the waiting inside them, and the reasons with their counts (and the
/// parts of a reason that carries its own breakdown).
export function parseAhead(line) {
  const m = line.match(AHEAD_RE);
  if (!m) return null;
  return {
    flights: Number(m[1]),
    settles: Number(m[2]),
    flightsEach: Number(m[3]),
    waiting: Number(m[4]),
    reasons: splitTopLevel(m[5]).map(parseReasonPart).filter(Boolean),
  };
}

/// "null magenta: frame=… substituted=… … examples=…": per-frame write counters for a view left null, plus up to a
/// few "slot:why" examples (or "-" when none). A line's counters run until a later frame first counts.
const NULL_MAGENTA_RE = new RegExp(
  String.raw`null magenta: frame=(\d+) substituted=(\d+) never_made=(\d+) waiting=(\d+) let_go=(\d+) ` +
    String.raw`cannot_make=(\d+) unmapped=(\d+) stale=(\d+) left_depth=(\d+) left_integer=(\d+) left_other=(\d+) ` +
    String.raw`left_no_view=(\d+) examples=(\S+)`,
);

export function parseNullMagenta(line) {
  const m = line.match(NULL_MAGENTA_RE);
  if (!m) return null;
  return {
    frame: Number(m[1]),
    substituted: Number(m[2]),
    neverMade: Number(m[3]),
    waiting: Number(m[4]),
    letGo: Number(m[5]),
    cannotMake: Number(m[6]),
    unmapped: Number(m[7]),
    stale: Number(m[8]),
    left: { depth: Number(m[9]), integer: Number(m[10]), other: Number(m[11]), noView: Number(m[12]) },
    examples: m[13] === '-' ? [] : m[13].split(','),
  };
}

/// The first-touch scoreboard, ending "…; health: N guards put on, N faults taken, N guards gone with no fault, N
/// pages passed over as a kernel write or the platform layer held them, N not armed for their protection, N
/// openings around our own kernel copies; the instrument's cost X.XXX ms a frame". A line whose silent count is
/// above zero starts "NOT CLEAN: N guards went with no fault (…)" and is logged as a warning.
const FIRST_TOUCH_RE = new RegExp(
  String.raw`(?:NOT CLEAN: (\d+) guards went with no fault[^;]*;\s*)?health: (\d+) guards put on, ` +
    String.raw`(\d+) faults taken, (\d+) guards gone with no fault, ` +
    String.raw`(\d+) pages passed over as a kernel write or the platform layer held them, ` +
    String.raw`(\d+) not armed for their protection, (\d+) openings around our own kernel copies; ` +
    String.raw`the instrument's cost ([0-9.]+) ms a frame`,
);

export function parseFirstTouch(line) {
  const m = line.match(FIRST_TOUCH_RE);
  if (!m) return null;
  return {
    clean: m[1] === undefined,
    silent: Number(m[1] ?? m[4]),
    guardsPutOn: Number(m[2]),
    faultsTaken: Number(m[3]),
    goneNoFault: Number(m[4]),
    passedOver: Number(m[5]),
    notArmed: Number(m[6]),
    openings: Number(m[7]),
    costMs: Number(m[8]),
  };
}

/// Everything the new lines say, aggregated as medians over the samples: the per-frame counters, the settle reasons
/// (count from the late line and milliseconds from the milliseconds line, joined on [`reasonKey`]), the pipelines
/// left out by reason, and the thread clock.
export function aggregate(extra) {
  const push = (map, key, value) => {
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(value);
  };
  const counts = new Map();
  const millis = new Map();
  const partsBy = new Map();
  for (const ahead of extra.aheads) {
    for (const part of ahead.reasons) {
      const key = reasonKey(part.reason);
      push(counts, key, part.count);
      for (const [sub, n] of Object.entries(part.by)) {
        if (!partsBy.has(key)) partsBy.set(key, new Map());
        push(partsBy.get(key), sub, n);
      }
    }
  }
  for (const sample of extra.settleMs) {
    for (const [reason, ms] of Object.entries(sample)) push(millis, reasonKey(reason), ms);
  }
  const settleReasons = {};
  for (const [reason, samples] of counts) settleReasons[reason] = { count: median(samples), ms: null, by: {} };
  for (const [reason, samples] of millis) {
    const entry = settleReasons[reason] ?? (settleReasons[reason] = { count: null, ms: null, by: {} });
    entry.ms = median(samples);
  }
  for (const [reason, subs] of partsBy) {
    for (const [sub, samples] of subs) settleReasons[reason].by[sub] = median(samples);
  }
  const leftOutSamples = new Map();
  for (const line of extra.leftOut) push(leftOutSamples, line.reason, line.perFrame);
  const leftOut = Object.fromEntries([...leftOutSamples].map(([reason, samples]) => [reason, median(samples)]));
  const namedSamples = new Map();
  const otherSamples = { user: [], kernel: [], pct: [] };
  const totalSamples = { user: [], kernel: [], pct: [] };
  for (const sample of extra.threads) {
    for (const thread of sample.threads) {
      if (!namedSamples.has(thread.name)) namedSamples.set(thread.name, { user: [], kernel: [], pct: [] });
      const entry = namedSamples.get(thread.name);
      for (const key of ['user', 'kernel', 'pct']) entry[key].push(thread[key]);
    }
    for (const [target, source] of [[otherSamples, sample.other], [totalSamples, sample.total]]) {
      if (!source) continue;
      for (const key of ['user', 'kernel', 'pct']) target[key].push(source[key]);
    }
  }
  return {
    capabilities: extra.capabilities,
    tableConstants: {
      inPlace: median(extra.tableConstants.map((x) => x.inPlace)),
      copied: median(extra.tableConstants.map((x) => x.copied)),
    },
    bufferCopies: {
      onCard: median(extra.bufferCopies.map((x) => x.onCard)),
      onCardMb: median(extra.bufferCopies.map((x) => x.onCardMb)),
      onCpu: median(extra.bufferCopies.map((x) => x.onCpu)),
      onCpuMb: median(extra.bufferCopies.map((x) => x.onCpuMb)),
      settled: median(extra.bufferCopies.map((x) => x.settled)),
      settledMb: median(extra.bufferCopies.map((x) => x.settledMb)),
    },
    settleReasons,
    leftOut,
    // The recording threads' wait for pipelines a frame, median over the window: high means the scene was still
    // compiling (a first visit) and the window is not a benchmark.
    pipelineWaitMs: extra.pipelineWaits.length ? median(extra.pipelineWaits) : null,
    // The latest null-magenta line (its counters are per frame), with the worst frame's substituted count, and the
    // first-touch line's last scoreboard with clean=false when ANY line said NOT CLEAN.
    nullMagenta: extra.nullMagenta.length
      ? {
          ...extra.nullMagenta[extra.nullMagenta.length - 1],
          worstSubstituted: Math.max(...extra.nullMagenta.map((s) => s.substituted)),
          lines: extra.nullMagenta.length,
        }
      : null,
    firstTouch: extra.firstTouch.length
      ? {
          ...extra.firstTouch[extra.firstTouch.length - 1],
          clean: extra.firstTouch.every((s) => s.clean),
          worstSilent: Math.max(...extra.firstTouch.map((s) => s.silent)),
          lines: extra.firstTouch.length,
        }
      : null,
    threads: {
      named: Object.fromEntries([...namedSamples].map(([name, samples]) => [name, threadMedian(samples)])),
      other: threadMedian(otherSamples),
      total: threadMedian(totalSamples),
    },
  };
}

const threadMedian = (samples) =>
  samples.user.length
    ? { user: median(samples.user), kernel: median(samples.kernel), pct: median(samples.pct) }
    : null;

/// Every new line of a log from `start` on, parsed; capabilities come from anywhere in the log (printed once, at
/// the start).
export function collect(lines, start = 0) {
  const out = {
    capabilities: null,
    tableConstants: [],
    bufferCopies: [],
    settleMs: [],
    leftOut: [],
    threads: [],
    aheads: [],
    nullMagenta: [],
    firstTouch: [],
    pipelineWaits: [],
  };
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!out.capabilities) out.capabilities = parseCapabilities(line);
    if (i < start) continue;
    const tc = parseTableConstants(line);
    if (tc) out.tableConstants.push(tc);
    const bc = parseBufferCopies(line);
    if (bc) out.bufferCopies.push(bc);
    const sm = parseSettleMs(line);
    if (sm) out.settleMs.push(sm);
    const lo = parseLeftOut(line);
    if (lo) out.leftOut.push(lo);
    const th = parseThreadClock(line);
    if (th) out.threads.push(th);
    const ahead = parseAhead(line);
    if (ahead) out.aheads.push(ahead);
    const nm = parseNullMagenta(line);
    if (nm) out.nullMagenta.push(nm);
    const ft = parseFirstTouch(line);
    if (ft) out.firstTouch.push(ft);
    const pw = parsePipelineWait(line);
    if (pw !== null) out.pipelineWaits.push(pw);
  }
  return out;
}

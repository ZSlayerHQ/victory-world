#!/usr/bin/env node
// Compare two or more VIctory world runs on the same fields and print Markdown tables (or JSON).
//
//   node harness/compare-runs.mjs [label=]<log> [label=]<log> ... [--json]
//
// A run is measured over the part that is worth comparing: the frame lines after the harness's
// "harness: settled at ..." line when the log carries one, otherwise the heavy frames from the first frame line
// at 1000 draws a frame (what --heavy-seconds and PresentMon start on). The table says which was used.
//
// Fields a build does not print are left blank; a missing field never fails the comparison. ANSI colour codes
// and CRLF are tolerated.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { COST_RE, FRAME_RE, HARNESS_SETTLED_RE, median, percentile, stripAnsi } from './parse-run.mjs';
import { findTrigger } from './presentmon.mjs';
import {
  aggregate,
  collect,
  parseBufferCopies,
  parseLeftOut,
  parseReasonPart,
  parseSettleMs,
  parseTableConstants,
  parseThreadClock,
  splitTopLevel,
} from './run-lines.mjs';

const DASH = '—';
const WAITING_RE = /textures picked by index: \d+ uploaded so far \(\d+ MB\), (\d+) waiting/;
// The late-submission line: "submissions sent ahead per frame: X in Y settles (...), W ms waiting ...; settled for:
// reason N, reason N, ...". The settles and the reasons are what this tool reports per frame.
const AHEAD_RE =
  /submissions sent ahead per frame: ([\d.]+) in ([\d.]+) settles \((?:([\d.]+) flights each time|flights landed by the relay)\), ([\d.]+) ms (?:waiting for the card in them|host time waiting for settles); settled for: (.*?)(?:;|$)/;
const REFUSED_RE = /host (?:mesh )?pipeline refused .*shaders=\[(.*?)\]/;
const CARD_CLOCK_RE = /card clock:\s*(.*)$/;
const CARD_CLOCK_FIELDS = [
  'sync_ms', 'title_ms', 'prelude_ms', 'compare_ms', 'fetch_ms', 'own_ms', 'sum_ms', 'wall_ms',
  'cpu_core_pct', 'cpu_all_pct', 'private_bytes', 'working_set_bytes',
  'io_read_bytes', 'io_read_ops', 'io_write_bytes', 'io_write_ops',
  'game_vol_free_bytes', 'game_vol_total_bytes',
];

function analyze(label, logPath) {
  const text = fs.readFileSync(logPath, 'utf8');
  const lines = text.split(/\r?\n/).map((line) => stripAnsi(line));
  const profiled =
    lines.some((line) => /^harness: profiled by Nsight GPU Trace/.test(line)) ||
    lines.some((line) => /^harness: captured by RenderDoc/.test(line));
  const settledAt = lines.findIndex((line) => HARNESS_SETTLED_RE.test(line));
  const trigger = settledAt >= 0 ? null : findTrigger(lines);
  const start = settledAt >= 0 ? settledAt + 1 : trigger ? trigger.index : lines.length;
  const used = settledAt >= 0 ? `settled${settleSeconds(lines[settledAt])}` : trigger ? 'heavy frames' : 'no frames';
  const window = profiled ? `${used} (profiled or captured; frame times not comparable)` : used;
  const frames = [];
  let block = null;
  for (let i = start; i < lines.length; i += 1) {
    const line = lines[i];
    const frame = line.match(FRAME_RE);
    if (frame) {
      const costs = line.match(COST_RE);
      const waitingOnFrame = line.match(WAITING_RE);
      block = {
        frame: frame.groups.frame === undefined ? null : Number(frame.groups.frame),
        fps: Number(frame.groups.fps),
        ms: Number(frame.groups.ms),
        draws: Number(frame.groups.draws),
        dropped: Number(frame.groups.dropped),
        making: Number(frame.groups.making),
        indirect: Number(frame.groups.indirect),
        preparing: costs ? Number(costs[1]) : null,
        copiesMs: costs ? Number(costs[2]) : null,
        copiesMb: costs ? Number(costs[3]) : null,
        texturesMs: costs ? Number(costs[4]) : null,
        texturesMb: costs ? Number(costs[5]) : null,
        gpuMs: costs ? Number(costs[6]) : null,
        backMs: costs ? Number(costs[7]) : null,
        backMb: costs ? Number(costs[8]) : null,
        waiting: waitingOnFrame ? Number(waitingOnFrame[1]) : null,
        settles: null,
        settleMs: null,
        settleReasonMs: null,
        reasons: {},
        reasonParts: [],
        leftOut: null,
        threads: null,
        tableConstants: null,
        bufferCopies: null,
      };
      frames.push(block);
      continue;
    }
    if (!block) continue;
    const clock = line.match(CARD_CLOCK_RE);
    if (clock) {
      const fields = {};
      for (const token of clock[1].split(/\s+/)) {
        const kv = token.match(/^(\w+)=([\d.]+)$/);
        if (kv) fields[kv[1]] = Number(kv[2]);
      }
      block.clock = fields;
    }
    const ahead = line.match(AHEAD_RE);
    if (ahead) {
      block.settles = Number(ahead[2]);
      block.settleMs = Number(ahead[4]);
      for (const part of splitTopLevel(ahead[5])) {
        // A reason can carry its own breakdown in parentheses ("title memory read 0.0 (by a ... 0.0, ...)"):
        // the count is the number before the parentheses, and the name is the reason without them.
        const parsed = parseReasonPart(part);
        if (!parsed) continue;
        block.reasons[parsed.reason] = (block.reasons[parsed.reason] ?? 0) + parsed.count;
        block.reasonParts.push(parsed);
      }
    }
    // The lines the speed work added: each is one sample per frame, kept on the frame it follows.
    const tableConstants = parseTableConstants(line);
    if (tableConstants) block.tableConstants = tableConstants;
    const bufferCopies = parseBufferCopies(line);
    if (bufferCopies) block.bufferCopies = bufferCopies;
    const settleReasonMs = parseSettleMs(line);
    if (settleReasonMs) block.settleReasonMs = settleReasonMs;
    const leftOut = parseLeftOut(line);
    if (leftOut) block.leftOut = { ...(block.leftOut ?? {}), [leftOut.reason]: leftOut.perFrame };
    const threads = parseThreadClock(line);
    if (threads) block.threads = threads;
  }
  const refused = new Set();
  for (const line of lines) {
    const m = line.match(REFUSED_RE);
    if (m) refused.add(m[1].trim());
  }
  const reasons = {};
  for (const frame of frames) for (const [reason, n] of Object.entries(frame.reasons)) reasons[reason] = (reasons[reason] ?? 0) + n;
  const clocks = frames.map((frame) => frame.clock).filter(Boolean);
  // The speed work's lines: samples per frame, reported as medians over the same window.
  const extra = collect(lines, start);
  const aggregated = aggregate(extra);
  return {
    label,
    path: logPath,
    window,
    profiled,
    frames,
    refused: [...refused].sort(),
    reasons,
    clocks,
    capabilities: aggregated.capabilities,
    settleReasons: aggregated.settleReasons,
    leftOut: aggregated.leftOut,
    nullMagenta: aggregated.nullMagenta,
    firstTouch: aggregated.firstTouch,
    pipelineWaitMs: aggregated.pipelineWaitMs,
    threads: aggregated.threads,
    stats: {
      fps: median(frames.map((f) => f.fps)),
      ms: median(frames.map((f) => f.ms)),
      msP10: percentile(frames.map((f) => f.ms), 0.1),
      msP90: percentile(frames.map((f) => f.ms), 0.9),
      preparing: med(frames, 'preparing'),
      copiesMs: med(frames, 'copiesMs'),
      copiesMb: med(frames, 'copiesMb'),
      texturesMs: med(frames, 'texturesMs'),
      texturesMb: med(frames, 'texturesMb'),
      gpuMs: med(frames, 'gpuMs'),
      backMs: med(frames, 'backMs'),
      backMb: med(frames, 'backMb'),
      draws: med(frames, 'draws'),
      settles: med(frames, 'settles'),
      settleMs: med(frames, 'settleMs'),
      waiting: med(frames, 'waiting'),
      dropped: med(frames, 'dropped'),
      tableInPlace: aggregated.tableConstants.inPlace,
      tableCopied: aggregated.tableConstants.copied,
      bufferOnCard: aggregated.bufferCopies.onCard,
      bufferOnCardMb: aggregated.bufferCopies.onCardMb,
      bufferOnCpu: aggregated.bufferCopies.onCpu,
      bufferOnCpuMb: aggregated.bufferCopies.onCpuMb,
      bufferSettled: aggregated.bufferCopies.settled,
      bufferSettledMb: aggregated.bufferCopies.settledMb,
    },
  };
}

const settleSeconds = (line) => {
  const m = line.match(HARNESS_SETTLED_RE);
  return m ? ` after ${m[1]} s` : '';
};

const finite = (x) => x !== null && x !== undefined && Number.isFinite(x);
const med = (frames, key) => median(frames.map((f) => f[key]).filter(finite));
const fmt = (x, digits = 1) => (finite(x) ? Number(x).toFixed(digits) : DASH);
const count = (x) => (finite(x) ? String(Math.round(x)) : DASH);
const PIPE = String.fromCharCode(92) + '|';
const mdCell = (value) => {
  if (value === null || value === undefined || value === '') return DASH;
  return String(value).split('|').join(PIPE).replace(/\r?\n/g, ' ');
};
const mdRow = (cells) => `| ${cells.map(mdCell).join(' | ')} |`;

// The table's rows: a label, and the value for one run (a number, or text for the window and reasons).
const clockMedian = (run, field) => median(run.clocks.map((clock) => clock[field]).filter(finite));

const ROWS = [
  ['Window', (r) => r.window, 'text'],
  ['Frame lines', (r) => r.frames.length, 'count'],
  ['fps median', (r) => r.stats.fps, 'number'],
  ['Frame ms median', (r) => r.stats.ms, 'number'],
  ['Frame ms p10', (r) => r.stats.msP10, 'number'],
  ['Frame ms p90', (r) => r.stats.msP90, 'number'],
  ['Preparing ms median', (r) => r.stats.preparing, 'number'],
  ['Copies ms median', (r) => r.stats.copiesMs, 'number'],
  ['Copies MB median', (r) => r.stats.copiesMb, 'number'],
  ['Textures ms median', (r) => r.stats.texturesMs, 'number'],
  ['Textures MB median', (r) => r.stats.texturesMb, 'number'],
  ['GPU ms median', (r) => r.stats.gpuMs, 'number'],
  ['Copy-back ms median', (r) => r.stats.backMs, 'number'],
  ['Copy-back MB median', (r) => r.stats.backMb, 'number'],
  ['Draws a frame median', (r) => r.stats.draws, 'count'],
  ['Settles a frame median', (r) => r.stats.settles, 'number'],
  ['Waiting in settles ms a frame median', (r) => r.stats.settleMs, 'number'],
  ['Top settle reasons', (r) => topReasons(r), 'text'],
  ['Textures waiting median', (r) => r.stats.waiting, 'count'],
  ['Dropped a frame median', (r) => r.stats.dropped, 'count'],
  ['Refused pipelines', (r) => refusedText(r), 'text'],
  ['host capabilities', (r) => r.capabilities?.raw ?? null, 'text'],
  ['Table constants read in place a frame', (r) => r.stats.tableInPlace, 'number'],
  ['Table constants copied a frame', (r) => r.stats.tableCopied, 'number'],
  ['Buffer copies on the card a frame', (r) => r.stats.bufferOnCard, 'number'],
  ['Buffer copies on the card MB', (r) => r.stats.bufferOnCardMb, 'number'],
  ['Buffer copies on the CPU a frame', (r) => r.stats.bufferOnCpu, 'number'],
  ['Buffer copies on the CPU MB', (r) => r.stats.bufferOnCpuMb, 'number'],
  ['Buffer copies that settled flights a frame', (r) => r.stats.bufferSettled, 'number'],
  ['Buffer copies that settled flights MB', (r) => r.stats.bufferSettledMb, 'number'],
  ['waiting for pipelines ms a frame (settled window)', (r) => pipelineWaitText(r), 'text'],
  ...CARD_CLOCK_FIELDS.map((field) => [`${field} median`, (r) => clockMedian(r, field), 'number']),
];

function topReasons(run) {
  return Object.entries(run.reasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([reason, n]) => `${reason} (${Number(n.toFixed(1))})`)
    .join('; ');
}

function refusedText(run) {
  if (!run.refused.length) return '0';
  const shown = run.refused.slice(0, 6).join(', ');
  const more = run.refused.length > 6 ? `, +${run.refused.length - 6}` : '';
  return `${run.refused.length}: ${shown}${more}`;
}

// The recording threads' wait for pipelines across the settled window. Above the quiet threshold the window was
// compile time (a scene's first visit), so the row says so outright: such a run is never a benchmark.
const PIPELINE_COMPILING_MS = 5;

function pipelineWaitText(run) {
  if (!finite(run.pipelineWaitMs)) return 'not printed';
  return run.pipelineWaitMs > PIPELINE_COMPILING_MS
    ? `${fmt(run.pipelineWaitMs)} ms — **compiling during the window**`
    : `${fmt(run.pipelineWaitMs)} ms`;
}

function difference(base, value) {
  if (!finite(base) || !finite(value)) return DASH;
  const absolute = value - base;
  const percent = base === 0 ? null : (absolute / base) * 100;
  const signed = (x, digits) => `${x >= 0 ? '+' : ''}${x.toFixed(digits)}`;
  return `${signed(absolute, 1)} (${percent === null ? DASH : `${signed(percent, 1)}%`})`;
}

function summary(runs) {
  const out = [];
  out.push(`| Field | ${runs.map((r) => mdCell(r.label)).join(' | ')} |`);
  out.push(`|${'---|'.repeat(runs.length + 1)}`);
  for (const [label, value, kind] of ROWS) {
    const cells = runs.map((run) => {
      const v = value(run);
      if (kind === 'text') return v;
      return kind === 'count' ? count(v) : fmt(v);
    });
    out.push(mdRow([label, ...cells]));
  }
  if (runs.length > 1) {
    out.push('');
    const name = (run) => (run.profiled ? `${run.label} (profiled)` : run.label);
    out.push(`| Difference against ${mdCell(name(runs[0]))} | ${runs.slice(1).map((r) => mdCell(name(r))).join(' | ')} |`);
    out.push(`|${'---|'.repeat(runs.length)}`);
    for (const [label, value, kind] of ROWS) {
      if (kind === 'text') continue;
      const base = value(runs[0]);
      out.push(mdRow([label, ...runs.slice(1).map((run) => difference(base, value(run)))]));
    }
  }
  for (const section of [settleReasonsSection(runs), leftOutSection(runs), runHealthSection(runs), threadsSection(runs)]) {
    if (section) out.push('', section);
  }
  return out.join('\n');
}

/// The two instrument lines: null-magenta writes (its counters are per frame; the worst frame is shown beside the
/// last line's) and the first-touch scoreboard, which says NOT CLEAN outright when any of its lines did.
function runHealthSection(runs) {
  if (!runs.some((run) => run.nullMagenta || run.firstTouch)) return '';
  const out = ['## Run health', `| Line | ${runs.map((run) => mdCell(run.label)).join(' | ')} |`, `|${'---|'.repeat(runs.length + 1)}`];
  out.push(
    mdRow([
      'null magenta: substituted a frame',
      ...runs.map((run) => {
        const nm = run.nullMagenta;
        if (!nm) return DASH;
        return `${fmt(nm.substituted)} (worst ${fmt(nm.worstSubstituted)})`;
      }),
    ]),
  );
  out.push(
    mdRow([
      'null magenta: never made, waiting',
      ...runs.map((run) => {
        const nm = run.nullMagenta;
        return nm ? `${fmt(nm.neverMade)}, ${fmt(nm.waiting)}` : DASH;
      }),
    ]),
  );
  out.push(
    mdRow([
      'null magenta: examples',
      ...runs.map((run) => {
        const nm = run.nullMagenta;
        if (!nm) return DASH;
        return nm.examples.length ? nm.examples.slice(0, 3).join(', ') : 'none';
      }),
    ]),
  );
  out.push(
    mdRow([
      'first touch',
      ...runs.map((run) => {
        const ft = run.firstTouch;
        if (!ft) return DASH;
        return ft.clean ? 'clean' : `**NOT CLEAN** (${fmt(ft.worstSilent)} silent)`;
      }),
    ]),
  );
  out.push(
    mdRow([
      'first touch: cost ms a frame',
      ...runs.map((run) => (run.firstTouch ? run.firstTouch.costMs.toFixed(3) : DASH)),
    ]),
  );
  return out.join('\n');
}

const reasonCell = (entry) => {
  if (!entry) return DASH;
  const parts = [];
  if (finite(entry.count)) parts.push(`${fmt(entry.count)} a frame`);
  if (finite(entry.ms)) parts.push(`${fmt(entry.ms)} ms`);
  return parts.length ? parts.join(', ') : DASH;
};

/// Every settle reason (not just the top three), with its count and its milliseconds, and the parts of a reason
/// that carries its own breakdown ("title memory read (by a buffer copy …)").
function settleReasonsSection(runs) {
  const names = new Set();
  for (const run of runs) for (const reason of Object.keys(run.settleReasons)) names.add(reason);
  if (!names.size) return '';
  const highest = (reason) => Math.max(...runs.map((run) => run.settleReasons[reason]?.count ?? 0));
  const rows = [...names].sort((a, b) => highest(b) - highest(a));
  const out = ['## Settle reasons', `| Reason | ${runs.map((run) => mdCell(run.label)).join(' | ')} |`, `|${'---|'.repeat(runs.length + 1)}`];
  for (const reason of rows) {
    out.push(mdRow([reason, ...runs.map((run) => reasonCell(run.settleReasons[reason]))]));
    const subs = new Set();
    for (const run of runs) for (const sub of Object.keys(run.settleReasons[reason]?.by ?? {})) subs.add(sub);
    for (const sub of subs) {
      out.push(mdRow([`↳ ${sub}`, ...runs.map((run) => fmt(run.settleReasons[reason]?.by?.[sub] ?? null))]));
    }
  }
  return out.join('\n');
}

/// Pipelines left out, by reason, as the frame line prints them.
function leftOutSection(runs) {
  const names = new Set();
  for (const run of runs) for (const reason of Object.keys(run.leftOut)) names.add(reason);
  if (!names.size) return '';
  const highest = (reason) => Math.max(...runs.map((run) => run.leftOut[reason] ?? 0));
  const rows = [...names].sort((a, b) => highest(b) - highest(a));
  const out = ['## Pipelines left out', `| Reason | ${runs.map((run) => mdCell(run.label)).join(' | ')} |`, `|${'---|'.repeat(runs.length + 1)}`];
  for (const reason of rows) {
    out.push(mdRow([reason, ...runs.map((run) => (finite(run.leftOut[reason]) ? `${fmt(run.leftOut[reason])} a frame` : DASH))]));
  }
  return out.join('\n');
}

/// The twelve busiest threads, by name, as medians of user+kernel milliseconds and percent of one core.
function threadsSection(runs) {
  const names = new Set();
  for (const run of runs) for (const name of Object.keys(run.threads.named)) names.add(name);
  if (!names.size) return '';
  const busy = (entry) => (finite(entry?.user) && finite(entry?.kernel) ? entry.user + entry.kernel : -1);
  const rank = (name) => Math.max(...runs.map((run) => busy(run.threads.named[name])));
  const rows = [...names].sort((a, b) => rank(b) - rank(a)).slice(0, 12);
  const cell = (entry) => (finite(entry?.user) ? `${fmt(entry.user + entry.kernel)} ms (${fmt(entry.pct)}%)` : DASH);
  const out = [
    '## Threads',
    `| Thread | ${runs.map((run) => mdCell(run.label)).join(' | ')} |`,
    `|${'---|'.repeat(runs.length + 1)}`,
  ];
  for (const name of rows) out.push(mdRow([name, ...runs.map((run) => cell(run.threads.named[name]))]));
  out.push(mdRow(['other', ...runs.map((run) => cell(run.threads.other))]));
  out.push(mdRow(['total', ...runs.map((run) => cell(run.threads.total))]));
  return out.join('\n');
}

function json(runs) {
  return {
    runs: runs.map((run) => ({
      label: run.label,
      path: run.path,
      window: run.window,
      profiled: run.profiled,
      frameLines: run.frames.length,
      fields: {
        ...run.stats,
        ...Object.fromEntries(CARD_CLOCK_FIELDS.map((field) => [field, clockMedian(run, field)])),
      },
      reasons: run.reasons,
      refused: run.refused,
      capabilities: run.capabilities?.raw ?? null,
      capabilityFields: run.capabilities?.fields ?? null,
      settleReasons: run.settleReasons,
      leftOut: run.leftOut,
      threads: run.threads,
    })),
    differences: runs.slice(1).map((run) => ({
      label: run.label,
      against: runs[0].label,
      fields: Object.fromEntries(
        ROWS.filter(([, , kind]) => kind !== 'text').map(([label, value]) => {
          const base = value(runs[0]);
          const v = value(run);
          return [
            label,
            {
              absolute: finite(base) && finite(v) ? v - base : null,
              percent: finite(base) && finite(v) && base !== 0 ? ((v - base) / base) * 100 : null,
            },
          ];
        }),
      ),
    })),
  };
}

function main(argv) {
  const args = [];
  let asJson = false;
  for (const arg of argv) {
    if (arg === '--json') asJson = true;
    else if (arg.startsWith('--')) {
      console.error(`compare-runs: unknown argument ${arg}`);
      return 2;
    } else args.push(arg);
  }
  if (args.length < 2) {
    console.error('usage: node harness/compare-runs.mjs [label=]<log> [label=]<log> ... [--json]');
    return 2;
  }
  const specs = args.map((arg) => {
    const at = arg.indexOf('=');
    if (at > 0) return { label: arg.slice(0, at), path: arg.slice(at + 1) };
    return { label: path.basename(arg).replace(/\.log$/i, ''), path: arg };
  });
  let runs;
  try {
    runs = specs.map((spec) => analyze(spec.label, spec.path));
  } catch (err) {
    console.error(`compare-runs: ${err.message}`);
    return 1;
  }
  console.log(asJson ? JSON.stringify(json(runs), null, 2) : summary(runs));
  return 0;
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));

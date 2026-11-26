#!/usr/bin/env node
// Condense a VIctory run log into one page.
// usage: node summarize-run.mjs <log> [--json]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import nodePath from 'node:path';
import { parseExtras, parseLogLines, readLogLines } from './parse-run.mjs';
import { aggregate, collect } from './run-lines.mjs';
import { presentMonCsvForLog, readPresentMon } from './presentmon.mjs';
import { annotate, defaultNamesFile, loadNames } from './name-hashes.mjs';
import {
  clock,
  formatStretch,
  frameSamples,
  joinLog,
  recordingStart,
  sampleLuma,
  timeline,
  totals,
} from './screen-timeline.mjs';

// The run's own screen recording and contact sheets, from the capture line run-world.sh writes.
function screenRecord(lines) {
  const capture = lines.map((line) => line.match(/^capture: (.+)$/)).find(Boolean);
  if (!capture) return { file: null, frames: 0, sheets: 0 };
  const file = nodePath.join(capture[1].trim(), 'screen.mp4');
  if (!fs.existsSync(file)) return { file: null, frames: 0, sheets: 0 };
  const sheetsDir = nodePath.join(nodePath.dirname(file), 'sheets');
  const sheets = fs.existsSync(sheetsDir)
    ? fs.readdirSync(sheetsDir).filter((name) => /^sheet-\d+\.jpg$/i.test(name)).length
    : 0;
  const probe = spawnSync(
    'ffprobe',
    ['-v', 'error', '-count_frames', '-select_streams', 'v:0', '-show_entries', 'stream=nb_read_frames', '-of', 'default=nw=1:nk=1', file],
    { encoding: 'utf8' },
  );
  const frames = Number((probe.stdout || '').trim());
  return { file, frames: Number.isFinite(frames) && frames > 0 ? frames : null, sheets };
}

const path = process.argv[2];
if (!path) {
  console.error('usage: node summarize-run.mjs <log> [--json]');
  process.exit(2);
}
const asJson = process.argv.includes('--json');

const lines = readLogLines(path);
const { summary: out, details, firstTs, lastTs } = parseLogLines(lines, path);
const extras = parseExtras(lines, firstTs, lastTs);
out.ending = extras.ending;
const presentmon = readPresentMon(presentMonCsvForLog(lines, path));
if (presentmon) out.presentmon = presentmon;

const duration = out.durationSeconds;
const last = out.lastFrameLine;
const worst = out.worstFrames;
const refused = out.refusedPipelines.hashes;
const refusedCount = out.refusedPipelines.count;
const translated = out.translated;
const slow = out.slowSubmissions;
const missingBy = out.missingTextures;
const driverEvents = out.driverEvents;
const failures = out.failures;
const { slowLists, slowCmds, hangs } = details;

// The speed work's lines (capabilities, thread clock, table constants, buffer copies, settle reasons, pipelines left
// out), over the same part of the run compare-runs measures: after the settle line, when there is one.
const settledAt = lines.findIndex((line) => /harness: settled at/.test(line));
const speed = aggregate(collect(lines, settledAt >= 0 ? settledAt + 1 : 0));
out.speedLines = speed;

if (asJson) {
  console.log(JSON.stringify(out, null, 2));
  process.exit(0);
}

// When a shader-name table exists, every hash in the readable output gains its shader's name. JSON keeps its
// exact hash strings (it exits above).
const names = loadNames(defaultNamesFile());
if (names.size) {
  const write = console.log;
  console.log = (...args) =>
    write(...args.map((arg) => (typeof arg === 'string' ? annotate(arg, names) : arg)));
}

const f = (x, d = 1) => (x === null || x === undefined ? '—' : Number(x).toFixed(d));
console.log(`# Run summary — ${path}`);
console.log(`comparable: ${out.comparable}`);
console.log(`observers on: ${out.observers ? out.observers.join(', ') : 'not in the log'}`);
if (out.switches.length) {
  console.log(
    `switches set: ${out.switches
      .map((entry) => `${entry.name}=${entry.value} (${entry.on ? 'on' : 'off'})`)
      .join(', ')}`,
  );
}
console.log(
  `Range: ${duration === null ? '—' : duration + ' s'}; last presented frame: ${out.lastFrame ? out.lastFrame.frame : '—'}`,
);
console.log(`Ending: ${out.ending.text}`);
const record = screenRecord(lines);
console.log(
  `Screen record: ${
    record.file
      ? `${record.file} (${record.frames === null ? '?' : record.frames} frames, ${record.sheets} sheets)`
      : 'none'
  }`,
);
console.log(
  `FPS: ${out.fps.samples} samples, median ${f(out.fps.median)}, min ${f(out.fps.min)}, max ${f(out.fps.max)}, last ${f(out.fps.last)}`,
);
if (presentmon) {
  console.log(
    `PresentMon: ${presentmon.frames} frames — median ${f(presentmon.medianMs)} ms, p95 ${f(presentmon.p95Ms)} ms, GPU busy median ${f(presentmon.gpuMedianMs)} ms`,
  );
}
if (out.costs) {
  console.log(
    `Last frame: ${last.frame === null ? '' : `frame ${last.frame}, `}${f(last.ms)} ms — preparing ${f(last.preparing)} (copies ${f(last.copiesMs)} ms / ${f(last.copiesMb)} MB, textures hashed ${f(last.texturesMs)} ms / ${f(last.texturesMb)} MB), GPU ${f(last.gpuMs)} ms, readback ${f(last.backMs)} ms / ${f(last.backMb)} MB; draws ${last.draws}, dropped ${last.dropped} (${last.making} being made), indirect ${last.indirect}`,
  );
}
if (out.copyStats) {
  const c = out.copyStats;
  const parts = [];
  if (c.descriptorCopySyncMs !== null) {
    parts.push(
      `descriptor-copy sync ${f(c.descriptorCopySyncMs, 2)} ms (${c.descriptorCopyRecords === null ? '—' : c.descriptorCopyRecords} records)`,
    );
  }
  if (c.askedAboutMb !== null) parts.push(`${f(c.askedAboutMb)} MB asked about`);
  if (c.distinctPages !== null)
    parts.push(`${c.distinctPages} distinct pages since the last present`);
  if (c.guardCount !== null) parts.push(`${c.guardCount} guards in ${f(c.guardsMs)} ms`);
  else if (c.guardsMs !== null) parts.push(`guards ${f(c.guardsMs)} ms`);
  if (parts.length) console.log(`Copy stats: ${parts.join(', ')}`);
}
// A run under a capture tool: its frame is not comparable, and its exit code is the tool's.
if (lines.some((line) => /^harness: captured by RenderDoc/.test(line))) {
  console.log("Captured: RenderDoc \u2014 the frame is not comparable, and the exit code is RenderDoc's.");
}
// A run under the GPU profiler: its frame times are the profiler's, and its exit code is Nsight's.
if (lines.some((line) => /^harness: profiled by Nsight GPU Trace/.test(line))) {
  console.log("Profiled: Nsight GPU Trace — frame times are not comparable, and the exit code is the profiler's.");
}
// The settle, when the run used the settled clock: when the scene was ready, or that it never was.
if (extras.settled) {
  console.log(
    `Scene settled: ${extras.settled.seconds} s after the first heavy line (waiting ${extras.settled.waiting}, ${extras.settled.fps} fps).`,
  );
} else if (extras.settledTimeout) {
  console.log('Scene never settled: the run hit --settled-timeout.');
}
// The picture first (a gotcha): what the recording shows, stretch by stretch, with the log's figures for the same
// wall-clock time. A heavy scene that is black can no longer pass as "world reached".
if (record.file) {
  console.log('\n## What was on screen');
  try {
    const samples = sampleLuma(record.file);
    const stretches = joinLog(timeline(samples), { start: recordingStart(lines), frames: frameSamples(lines) });
    const all = totals(stretches);
    const black = all.longestBlack
      ? `; longest black ${clock(all.longestBlack.start)}-${clock(all.longestBlack.end)}`
      : '';
    console.log(
      `- ${samples.length} s: black ${all.seconds.black} s, near-black ${all.seconds.nearBlack} s, picture ${all.seconds.picture} s${black}`,
    );
    for (const stretch of stretches) console.log(`- ${formatStretch(stretch)}`);
  } catch (error) {
    console.log(`- unavailable: ${error.message}`);
  }
}
console.log('\n## Worst frames');
for (const w of worst) {
  console.log(
    `- ${w.ts} ${f(w.fps)} fps / ${f(w.ms)} ms: copies ${f(w.copiesMs)} ms ${f(w.copiesMb)} MB, GPU ${f(w.gpuMs)} ms, draws ${w.draws}, dropped ${w.dropped}`,
  );
}
console.log('\n## Pipeline health');
console.log(`- refused: ${refusedCount}${refusedCount ? ' — ' + refused.slice(0, 8).join('; ') : ''}`);
console.log(
  `- translated this run: ${translated.total}${Object.keys(translated.byStage).length ? ' (' + Object.entries(translated.byStage).map(([k, v]) => `${k} ${v}`).join(', ') + ')' : ''}`,
);
if (slow.length) {
  const top = [...slow].sort((a, b) => b.ms - a.ms);
  console.log(`- slow submissions: ${slow.length} over 250 ms; worst:`);
  for (const s of top.slice(0, 8))
    console.log(`  - ${s.ms} ms, ${s.lists} lists, ${s.entries} pipelines`);
  if (top.length > 8) console.log(`  - … and ${top.length - 8} more`);
}
if (slowLists.length) {
  const top = [...slowLists].sort((a, b) => b.ms - a.ms).slice(0, 5);
  console.log('- slow host lists:');
  for (const s of top) console.log(`  - ${s.ms} ms, ${s.commands} commands`);
}
if (slowCmds.length) {
  const top = [...slowCmds].sort((a, b) => b.ms - a.ms).slice(0, 8);
  console.log('- slowest commands:');
  for (const c of top) console.log(`  - ${c.ms} ms: ${c.desc.slice(0, 150)}`);
}
if (Object.keys(speed.leftOut).length) {
  console.log('- left out:');
  for (const [reason, perFrame] of Object.entries(speed.leftOut).sort((a, b) => b[1] - a[1])) {
    console.log(`  - ${f(perFrame)} a frame: ${reason}`);
  }
}
// What the speed work's lines say per frame: the card's capabilities, the two counter lines, and every settle
// reason with its count and its milliseconds (not just the top three).
const settleReasons = Object.entries(speed.settleReasons).sort((a, b) => (b[1].count ?? 0) - (a[1].count ?? 0));
const hasSpeed =
  speed.capabilities ||
  speed.tableConstants.inPlace !== null ||
  speed.bufferCopies.onCard !== null ||
  settleReasons.length ||
  Object.keys(speed.threads.named).length;
if (hasSpeed) console.log('\n## Card and CPU per frame');
if (speed.capabilities) console.log(`- host capabilities: ${speed.capabilities.raw}`);
if (speed.tableConstants.inPlace !== null) {
  console.log(`- table constants: ${f(speed.tableConstants.inPlace)} read in place, ${f(speed.tableConstants.copied)} copied`);
}
if (speed.bufferCopies.onCard !== null) {
  console.log(
    `- buffer copies: ${f(speed.bufferCopies.onCard)} on the card (${f(speed.bufferCopies.onCardMb)} MB), ` +
      `${f(speed.bufferCopies.onCpu)} on the CPU (${f(speed.bufferCopies.onCpuMb)} MB), ` +
      `${f(speed.bufferCopies.settled)} settled flights (${f(speed.bufferCopies.settledMb)} MB)`,
  );
}
if (settleReasons.length) {
  console.log('- settle reasons:');
  for (const [reason, entry] of settleReasons) {
    const parts = [];
    if (entry.count !== null) parts.push(`${f(entry.count)} a frame`);
    if (entry.ms !== null) parts.push(`${f(entry.ms)} ms`);
    console.log(`  - ${reason}: ${parts.join(', ') || '—'}`);
    for (const [sub, n] of Object.entries(entry.by)) console.log(`    - by ${sub}: ${f(n)}`);
  }
}
// The two instrument lines: a view left null counted while it is written, and the first-touch scoreboard. A run
// whose first-touch line said NOT CLEAN says so here, in those words.
if (speed.nullMagenta || speed.firstTouch) console.log('\n## Run health');
if (speed.nullMagenta) {
  const nm = speed.nullMagenta;
  console.log(
    `- null magenta: ${f(nm.substituted)} substituted a frame (worst ${f(nm.worstSubstituted)}), ` +
      `${f(nm.neverMade)} never made, ${f(nm.waiting)} waiting, ${f(nm.cannotMake)} cannot make, ` +
      `${f(nm.unmapped)} unmapped, ${f(nm.stale)} stale`,
  );
  if (nm.examples.length) console.log(`  - examples: ${nm.examples.slice(0, 6).join(', ')}`);
}
if (speed.firstTouch) {
  const ft = speed.firstTouch;
  console.log(
    ft.clean
      ? `- first touch: clean (${f(ft.guardsPutOn)} guards put on, ${f(ft.faultsTaken)} faults taken), cost ${ft.costMs.toFixed(3)} ms a frame`
      : `- first touch: **NOT CLEAN** — ${f(ft.worstSilent)} guards went with no fault (${f(ft.guardsPutOn)} put on, ${f(ft.faultsTaken)} faults taken), cost ${ft.costMs.toFixed(3)} ms a frame`,
  );
}

const threads = Object.entries(speed.threads.named)
  .sort((a, b) => b[1].user + b[1].kernel - (a[1].user + a[1].kernel))
  .slice(0, 12);
if (threads.length) {
  console.log('\n## Threads');
  for (const [name, entry] of threads) console.log(`- ${name}: ${f(entry.user + entry.kernel)} ms (${f(entry.pct)}%)`);
  const total = speed.threads.total;
  if (total) console.log(`- total: ${f(total.user + total.kernel)} ms (${f(total.pct)}%)`);
}
if (Object.keys(missingBy).length) {
  console.log('\n## Textures with no host copy');
  for (const [k, v] of Object.entries(missingBy)) console.log(`- ${k} x${v}`);
}
if (hangs.length) {
  console.log('\n## Hung commands');
  for (const h of hangs) {
    const pipeline = h.pipelineUnknown
      ? `pipeline unknown (${h.pipelineUnknown})`
      : h.command;
    console.log(`- stopped at command ${h.at}/${h.of} (op ${h.op}): ${pipeline}`);
  }
}
console.log('\n## Driver events');
if (!driverEvents.total) {
  console.log('- none');
} else {
  console.log(`- MMU Fault: ${driverEvents.counts.mmuFault}`);
  console.log(`- Multiple Warp Errors: ${driverEvents.counts.multipleWarpErrors}`);
  console.log(`- other id 13 texts: ${driverEvents.counts.otherId13}`);
  console.log(`- id 153: ${driverEvents.counts.id153}`);
  for (const set of driverEvents.esrValueSets)
    console.log(`- ESR values: ${set.values.join(' ')} x${set.count}`);
}
if (failures.length) {
  console.log('\n## Failures');
  for (const x of failures) console.log(`- ${x}${x.length >= 300 ? '…' : ''}`);
}

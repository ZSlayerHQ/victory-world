#!/usr/bin/env node
// One markdown table of world runs (one row per log) plus a shader-translation-failure cross-tab.
// usage: node experiment-table.mjs [--json] <log>...
import { loadLocalEnv } from './local-env.mjs';
import { parseRunFile } from './parse-run.mjs';
import { presentMonCsvForLog, readPresentMon } from './presentmon.mjs';

// A log without a capture: line finds its PresentMon CSV under this machine's captures root.
loadLocalEnv();

const DASH = '—';
const args = process.argv.slice(2);
const asJson = args.includes('--json');
const paths = args.filter((arg) => arg !== '--json');
if (!paths.length) {
  console.error('usage: node experiment-table.mjs [--json] <log>...');
  process.exit(2);
}

function pathParts(file) {
  const base = file.split(/[\\/]/).pop();
  const m = base.match(/^(\d{8}-\d{6})-(.+)\.log$/);
  return m ? { stamp: m[1], tag: m[2] } : { stamp: base, tag: base.replace(/\.log$/, '') };
}

function build(file) {
  const { summary, extras, translationFailures, lines } = parseRunFile(file);
  const { stamp, tag } = pathParts(file);
  const presentmon = readPresentMon(presentMonCsvForLog(lines, file));
  const slowest = summary.slowSubmissions.reduce(
    (best, submission) => (!best || submission.ms > best.ms ? submission : best),
    null,
  );
  const last = summary.lastFrameLine;
  const hung = extras.hung;
  const run = {
    file,
    stamp,
    tag,
    seconds: summary.durationSeconds,
    lastFrame: summary.lastFrame ? summary.lastFrame.frame : null,
    medianFps: summary.fps.median,
    ended: extras.ending,
    hung: hung
      ? {
          list: hung.list,
          command: hung.command,
          total: hung.total,
          op: hung.op,
          pipelineHash: hung.pipelineHash,
          stage: hung.stage,
          pipelineUnknown: hung.pipelineUnknown,
          nullSlots: hung.nullSlots,
        }
      : null,
    dred: extras.dred,
    slowestSubmission: slowest ? { ms: slowest.ms, lists: slowest.lists } : null,
    droppedDraws: last ? last.dropped : null,
    settings: extras.settings,
  };
  if (presentmon) run.presentmon = presentmon;
  return { run, failures: translationFailures };
}

const runs = paths.map(build);
runs.sort((a, b) => {
  const sa = a.run.stamp;
  const sb = b.run.stamp;
  if (sa !== sb) return sa < sb ? -1 : 1;
  if (a.run.file !== b.run.file) return a.run.file < b.run.file ? -1 : 1;
  return 0;
});

const perRunReasons = runs.map(({ failures }) => {
  const byReason = new Map();
  for (const failure of failures) {
    if (!byReason.has(failure.reason)) byReason.set(failure.reason, new Set());
    byReason.get(failure.reason).add(failure.hash);
  }
  return byReason;
});
const reasons = new Set();
for (const byReason of perRunReasons) for (const reason of byReason.keys()) reasons.add(reason);
const crossTabRows = [...reasons]
  .map((reason) => {
    const counts = perRunReasons.map((byReason) => byReason.get(reason)?.size ?? 0);
    return { reason, counts, total: counts.reduce((a, b) => a + b, 0) };
  })
  .sort(
    (a, b) =>
      b.total - a.total ||
      (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
  );

const columns = runs.map(({ run }) => run.tag);
const withPresentMon = runs.some(({ run }) => run.presentmon);
const presentMonHeaders = ['median frame ms', 'p95 frame ms', 'GPU median ms'];
const headers = [
  'tag',
  'seconds',
  'last frame',
  'median fps',
  ...(withPresentMon ? presentMonHeaders : []),
  'ended',
  'hung list',
  'hung command',
  'hung op',
  'pipeline',
  'stage',
  'DRED last op',
  'DRED hung op',
  'null slots',
  'slowest submission',
  'dropped draws',
  'skip pipelines',
  'loop limit',
  'wave64',
  'GPU timing',
  'debug layer',
  'GBV',
];

const mdCell = (value) => {
  if (value === null || value === undefined || value === '') return DASH;
  return String(value).replace(/\|/g, '\|').replace(/\r?\n/g, ' ');
};
const mdRow = (cells) => `| ${cells.map(mdCell).join(' | ')} |`;
const setting = (value) => (value === null || value === undefined || value === '' ? '?' : value);

const pmCell = (value) => (value === null || value === undefined ? DASH : Number(value).toFixed(1));
const pipelineCell = (hung) => {
  if (!hung) return DASH;
  if (hung.pipelineHash) return hung.pipelineHash;
  return hung.pipelineUnknown ? `unknown (${hung.pipelineUnknown})` : DASH;
};

function rowFor(run) {
  const hung = run.hung;
  return [
    run.tag,
    run.seconds ?? DASH,
    run.lastFrame ?? DASH,
    run.medianFps === null ? DASH : run.medianFps.toFixed(1),
    ...(withPresentMon
      ? [
          run.presentmon ? pmCell(run.presentmon.medianMs) : DASH,
          run.presentmon ? pmCell(run.presentmon.p95Ms) : DASH,
          run.presentmon ? pmCell(run.presentmon.gpuMedianMs) : DASH,
        ]
      : []),
    run.ended.text,
    hung ? hung.list ?? DASH : DASH,
    hung ? `${hung.command}/${hung.total}` : DASH,
    hung ? hung.op ?? DASH : DASH,
    pipelineCell(hung),
    hung ? hung.stage ?? DASH : DASH,
    run.dred ? run.dred.lastCompletedOp ?? DASH : DASH,
    run.dred ? run.dred.hungOp ?? DASH : DASH,
    hung && hung.nullSlots.length ? hung.nullSlots.join(', ') : DASH,
    run.slowestSubmission
      ? `${run.slowestSubmission.ms} ms / ${run.slowestSubmission.lists} lists`
      : DASH,
    run.droppedDraws ?? DASH,
    setting(run.settings.skippedPipelines),
    setting(run.settings.loopLimit),
    setting(run.settings.wave64),
    run.settings.gpuTiming === null ? '?' : run.settings.gpuTiming ? 'on' : 'off',
    run.settings.d3d12Debug === null ? '?' : run.settings.d3d12Debug ? 'on' : 'off',
    run.settings.d3d12Gbv === null ? '?' : run.settings.d3d12Gbv ? 'on' : 'off',
  ];
}

if (asJson) {
  console.log(
    JSON.stringify(
      {
        runs: runs.map(({ run }) => run),
        crossTab: {
          columns,
          rows: crossTabRows.map(({ reason, counts }) => ({ reason, counts })),
        },
      },
      null,
      2,
    ),
  );
  process.exit(0);
}

console.log('# Experiment table');
console.log('');
console.log(mdRow(headers));
console.log(`| ${headers.map(() => '---').join(' | ')} |`);
for (const { run } of runs) console.log(mdRow(rowFor(run)));
console.log('');
console.log('## Translation failures — distinct hashes');
const crossHeaders = ['reason', ...columns];
console.log(mdRow(crossHeaders));
console.log(`| ${crossHeaders.map(() => '---').join(' | ')} |`);
for (const row of crossTabRows) console.log(mdRow([row.reason, ...row.counts]));

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'experiment-table.mjs');

function runTable(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function tables(stdout) {
  const found = [];
  let current = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (line.startsWith('|')) {
      const cells = line.slice(1, -1).split('|').map((cell) => cell.trim());
      if (!current) {
        current = { header: cells, rows: [] };
        found.push(current);
      } else if (cells.every((cell) => /^-+$/.test(cell))) {
        continue;
      } else {
        current.rows.push(cells);
      }
    } else {
      current = null;
    }
  }
  return found;
}

function objects(table) {
  return table.rows.map((row) => Object.fromEntries(table.header.map((name, i) => [name, row[i]])));
}

function frameLine(ts, fps, dropped = 0) {
  return `${ts}  INFO victory_gpu::host: ${fps.toFixed(1)} fps, 33.3 ms/frame (0.2 preparing: copies 0.1 ms 0.2 MB, textures 0.0 ms 0.0 MB; 0.9 on the GPU; 0.0 copying back 0.0 MB), 12 draws/frame, dropped ${dropped} without a host pipeline (0 being made) and 1 indirect`;
}

function presentLine(ts, frame) {
  return `${ts}  INFO victory_gpu::queue: frame presented (since the last line: draws and dispatches, and those run on the host) frame=${frame} draws=12 drawn=12 dispatches=0 dispatched=0`;
}

function failureLine(ts, stage, hash, reason) {
  return `${ts}  WARN victory_gpu::pipeline: shader does not translate; its pipelines' draws are dropped stage="${stage}" hash=${hash} error=converter shader.dxil v1: GFX10 code at 0x123: ${reason}`;
}

const removalLog = [
  'harness build: abc profile=diag console=series-x',
  'harness env: VICTORY_SKIP_PIPELINES=0123456789abcdef,fedcba9876543210',
  'harness env: VICTORY_SHADER_LOOP_LIMIT=64',
  'harness env: VICTORY_WAVE64_EMULATE=emulate',
  'harness env: VICTORY_GPU_TIMING=1',
  frameLine('2026-11-24T12:00:00.000000Z', 30.0, 1),
  presentLine('2026-11-24T12:00:00.500000Z', 20),
  frameLine('2026-11-24T12:00:01.000000Z', 24.0, 7),
  '2026-11-24T12:00:01.050000Z  WARN victory_gpu::host: slow host submission ms=250 lists=3 pipelines={"[mesh 0123456789abcdef, pixel fedcba9876543210]"}',
  '2026-11-24T12:00:01.060000Z  WARN victory_gpu::host: slow host submission ms=480 lists=5 pipelines={"[compute aaaaaaaaaaaaaaaa]"}',
  '2026-11-24T12:00:01.100000Z  WARN victory_gpu::shader_cache: VICTORY_SHADER_LOOP_LIMIT: translated loops stop sooner limit=64',
  '2026-11-24T12:00:01.200000Z  INFO victory_gpu::host: Wave64 compute lowering mode selected wave64_mode=Emulate',
  '2026-11-24T12:00:01.300000Z  INFO victory_gpu::host: VIctory settings: skipped pipelines=0123456789abcdef,fedcba9876543210 gpu timing=on',
  failureLine('2026-11-24T12:00:01.400000Z', 'compute', '0123456789abcdef', 'made-up reason one'),
  failureLine('2026-11-24T12:00:01.500000Z', 'pixel', 'bbbbbbbbbbbbbbbb', 'made-up reason one'),
  failureLine('2026-11-24T12:00:01.600000Z', 'vertex', 'cccccccccccccccc', 'made-up reason two'),
  '2026-11-24T12:00:09.900000Z  WARN victory_gpu::host: DRED: last completed op=41, hung op=42',
  '2026-11-24T12:00:10.000000Z ERROR victory_gpu::host: host GPU device removed after a submission of 2 lists; breadcrumbs (done/count, list) ["10/10 None", "5/20 Some(1)"]; a list stopped at command 5 of 20 (op 42), commands 4..6 between its barriers:; command 5 (op 42): mesh 1 [mesh 0123456789abcdef, pixel fedcba9876543210] | 0123456789abcdef: u8=0x1000 [heap 4096: null] u9=0x2000 u12=0x3000 [heap 32: null] root3=0x0 host Some(',
  '    ),',
  ') | fedcba9876543210: u8=0x4000 [heap 64: null] u15=0x5000 [heap 65: null] root3=0x0 host Some(',
  '',
].join('\n');

const cleanLog = [
  'harness build: abc profile=diag console=series-x',
  'harness env: VICTORY_D3D12_DEBUG=1',
  'harness env: VICTORY_D3D12_GBV=1',
  'harness env: VICTORY_SKIP_PIPELINES=none',
  'harness env: VICTORY_SHADER_LOOP_LIMIT=32',
  'harness env: VICTORY_WAVE64_EMULATE=emulate',
  'harness env: VICTORY_GPU_TIMING=0',
  'harness env: VICTORY_COPY_MODE=plain',
  'harness env: VICTORY_AFTERMATH=<drive>/captures/synthetic-clean',
  frameLine('2026-11-24T12:01:00.000000Z', 60.0, 0),
  presentLine('2026-11-24T12:01:00.500000Z', 300),
  '2026-11-24T12:01:01.000000Z  INFO victory_gpu::host: Wave64 compute lowering mode selected wave64_mode=Emulate',
  '2026-11-24T12:01:01.100000Z  INFO victory_gpu::host: VIctory settings: skipped pipelines=none',
  '2026-11-24T12:01:02.000000Z  INFO victory_gpu::host: VIctory settings: loop_limit=32 gpu_timing=off',
  '2026-11-24T12:01:05.000000Z  INFO victory_gpu::pipeline: shader translated stage="vertex" hash=aaaaaaaaaaaaaaaa user_data=0 samplers=0',
  'title exited with 0',
  '',
].join('\n');

const failureLog = [
  frameLine('2026-11-24T12:02:00.000000Z', 10.0, 2),
  presentLine('2026-11-24T12:02:00.500000Z', 42),
  failureLine('2026-11-24T12:02:01.000000Z', 'compute', 'dddddddddddddddd', 'made-up reason one'),
  '\x1b[33m' + failureLine('2026-11-24T12:02:01.100000Z', 'compute', 'dddddddddddddddd', 'made-up reason one') + '\x1b[0m',
  failureLine('2026-11-24T12:02:01.200000Z', 'pixel', 'eeeeeeeeeeeeeeee', 'made-up reason two'),
  failureLine('2026-11-24T12:02:01.300000Z', 'vertex', 'ffffffffffffffff', 'made-up reason two'),
  '2026-11-24T12:02:01.400000Z  INFO victory_gpu::pipeline: shader translated stage="compute" hash=aaaaaaaaaaaaaaaa user_data=1 samplers=0',
  '2026-11-24T12:02:03.000000Z  INFO victory_gpu::host: 10.0 fps, 100.0 ms/frame (0.2 preparing: copies 0.1 ms 0.2 MB, textures 0.0 ms 0.0 MB; 0.9 on the GPU; 0.0 copying back 0.0 MB), 12 draws/frame, dropped 2 without a host pipeline (0 being made) and 1 indirect',
  '',
].join('\n');

test('experiment table: one row per run, ending, hang, DRED, settings and cross-tab', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'experiment-table-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const removal = path.join(dir, '20261124-120000-removed.log');
  const clean = path.join(dir, '20261124-120500-clean.log');
  const failures = path.join(dir, '20261124-120900-fails.log');
  fs.writeFileSync(removal, removalLog);
  fs.writeFileSync(clean, cleanLog);
  fs.writeFileSync(failures, failureLog);

  const result = runTable([failures, removal, clean]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stderr, '');

  const markdown = tables(result.stdout);
  assert.equal(markdown.length, 2, 'one runs table and one cross-tab');

  const headers = [
    'tag', 'seconds', 'last frame', 'median fps', 'ended',
    'hung list', 'hung command', 'hung op', 'pipeline', 'stage',
    'DRED last op', 'DRED hung op', 'null slots', 'slowest submission',
    'dropped draws', 'skip pipelines', 'loop limit', 'wave64', 'GPU timing',
    'debug layer', 'GBV',
  ];
  assert.deepEqual(markdown[0].header, headers);
  assert.equal(markdown[0].rows.length, 3);

  const rows = objects(markdown[0]);
  assert.deepEqual(rows.map((row) => row.tag), ['removed', 'clean', 'fails'], 'stamp order');

  assert.deepEqual(rows[0], {
    tag: 'removed',
    seconds: '10',
    'last frame': '20',
    'median fps': '27.0',
    ended: 'device removed @ 10 s, after logged frame 20',
    'hung list': '1',
    'hung command': '5/20',
    'hung op': '42',
    pipeline: '0123456789abcdef',
    stage: 'mesh',
    'DRED last op': '41',
    'DRED hung op': '42',
    'null slots': 'u8, u12, u15',
    'slowest submission': '480 ms / 5 lists',
    'dropped draws': '7',
    'skip pipelines': '0123456789abcdef,fedcba9876543210',
    'loop limit': '64',
    wave64: 'emulate',
    'GPU timing': 'on',
    'debug layer': 'off',
    GBV: 'off',
  });

  assert.deepEqual(rows[1], {
    tag: 'clean',
    seconds: '5',
    'last frame': '300',
    'median fps': '60.0',
    ended: 'clean exit',
    'hung list': '—',
    'hung command': '—',
    'hung op': '—',
    pipeline: '—',
    stage: '—',
    'DRED last op': '—',
    'DRED hung op': '—',
    'null slots': '—',
    'slowest submission': '—',
    'dropped draws': '0',
    'skip pipelines': 'none',
    'loop limit': '32',
    wave64: 'emulate',
    'GPU timing': 'off',
    'debug layer': 'on',
    GBV: 'on',
  });

  assert.equal(rows[2].tag, 'fails');
  assert.equal(rows[2].seconds, '3');
  assert.equal(rows[2]['last frame'], '42');
  assert.equal(rows[2]['median fps'], '10.0');
  assert.equal(rows[2].ended, 'log ends');
  assert.equal(rows[2]['hung list'], '—');
  assert.equal(rows[2]['hung command'], '—');
  assert.equal(rows[2]['null slots'], '—');
  assert.equal(rows[2]['slowest submission'], '—');
  assert.equal(rows[2]['dropped draws'], '2');
  assert.equal(rows[2]['skip pipelines'], '?');
  assert.equal(rows[2]['loop limit'], '?');
  assert.equal(rows[2].wave64, '?');
  assert.equal(rows[2]['GPU timing'], '?');
  assert.equal(rows[2]['debug layer'], '?');
  assert.equal(rows[2].GBV, '?');

  assert.deepEqual(markdown[1].header, ['reason', 'removed', 'clean', 'fails']);
  const crossTab = objects(markdown[1]);
  assert.deepEqual(crossTab, [
    { reason: 'made-up reason one', removed: '2', clean: '0', fails: '1' },
    { reason: 'made-up reason two', removed: '1', clean: '0', fails: '2' },
  ]);

  const jsonResult = runTable(['--json', failures, removal, clean]);
  assert.equal(jsonResult.status, 0, jsonResult.stderr || jsonResult.stdout);
  const data = JSON.parse(jsonResult.stdout);

  assert.deepEqual(data.runs.map((run) => run.tag), ['removed', 'clean', 'fails']);

  const removed = data.runs[0];
  assert.equal(removed.stamp, '20261124-120000');
  assert.equal(removed.seconds, 10);
  assert.equal(removed.lastFrame, 20);
  assert.equal(removed.medianFps, 27);
  assert.deepEqual(removed.ended, { kind: 'device_removed', seconds: 10, frame: 20, text: 'device removed @ 10 s, after logged frame 20' });
  assert.deepEqual(removed.hung, {
    list: 1,
    command: 5,
    total: 20,
    op: 42,
    pipelineHash: '0123456789abcdef',
    stage: 'mesh',
    pipelineUnknown: null,
    nullSlots: ['u8', 'u12', 'u15'],
  });
  assert.deepEqual(removed.dred, { lastCompletedOp: 41, hungOp: 42 });
  assert.deepEqual(removed.slowestSubmission, { ms: 480, lists: 5 });
  assert.equal(removed.droppedDraws, 7);
  assert.deepEqual(removed.settings, {
    skippedPipelines: '0123456789abcdef,fedcba9876543210',
    loopLimit: 64,
    wave64: 'emulate',
    gpuTiming: true,
    d3d12Debug: false,
    d3d12Gbv: false,
    copyMode: null,
    aftermath: false,
    record: false,
  });

  assert.equal(data.runs[1].ended.kind, 'clean_exit');
  assert.equal(data.runs[1].hung, null);
  assert.deepEqual(data.runs[1].dred, null);
  assert.deepEqual(data.runs[1].settings, {
    skippedPipelines: 'none',
    loopLimit: 32,
    wave64: 'emulate',
    gpuTiming: false,
    d3d12Debug: true,
    d3d12Gbv: true,
    copyMode: 'plain',
    aftermath: true,
    record: false,
  });

  assert.equal(data.runs[2].ended.kind, 'log_ends');
  assert.equal(data.runs[2].seconds, 3);
  assert.equal(data.runs[2].lastFrame, 42);
  assert.deepEqual(data.runs[2].dred, null);
  assert.deepEqual(data.runs[2].settings, {
    skippedPipelines: null,
    loopLimit: null,
    wave64: null,
    gpuTiming: null,
    d3d12Debug: null,
    d3d12Gbv: null,
    copyMode: null,
    aftermath: null,
    record: null,
  });

  assert.deepEqual(data.crossTab.columns, ['removed', 'clean', 'fails']);
  assert.deepEqual(data.crossTab.rows, [
    { reason: 'made-up reason one', counts: [2, 0, 1] },
    { reason: 'made-up reason two', counts: [1, 0, 2] },
  ]);
});

test('experiment table: a stopped command with no marker has an unknown pipeline', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'experiment-table-nomarker-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, '20261124-121500-nomarker.log');
  fs.writeFileSync(
    log,
    [
      frameLine('2026-11-24T12:15:00.000000Z', 30.0, 1),
      '2026-11-24T12:15:10.000000Z ERROR victory_gpu::host: host GPU device removed after a submission of 2 lists; ' +
        'breadcrumbs (done/count, list) ["1/1 None"]; a list stopped at command 250 of 552 (op 5), commands 249..251 between its barriers:; ' +
        'command 250 (op 5): no marker; a list stopped at command 0 of 2 (op 46); list 2 of 11, of its 3: ' +
        'dispatch 33x33x6 [compute 0123456789abcdef] | 0123456789abcdef: u4=0x1 [heap 1: null]',
      '',
    ].join('\n'),
  );

  const result = runTable([log]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const row = objects(tables(result.stdout)[0])[0];
  assert.equal(row.pipeline, 'unknown (no marker)');
  assert.equal(row.stage, '—');
  assert.equal(row['hung command'], '250/552');
  assert.equal(row['null slots'], '—');

  const data = JSON.parse(runTable(['--json', log]).stdout);
  assert.equal(data.runs[0].hung.pipelineHash, null);
  assert.equal(data.runs[0].hung.stage, null);
  assert.equal(data.runs[0].hung.pipelineUnknown, 'no marker');
  assert.deepEqual(data.runs[0].hung.nullSlots, []);
});

test('experiment table: the debug layer and GBV come only from harness env header lines', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'experiment-table-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // The runtime's own failure text names both variables; it is not a record of what the run set.
  const failureText =
    '2026-11-24T12:03:01.000000Z ERROR victory_gpu::host: host GPU device removed; ' +
    'a diagnostics build with VICTORY_D3D12_DEBUG=1 names the command, and VICTORY_D3D12_GBV=1 validates it';
  const header = 'harness build: abc profile=diag console=series-x\nharness env: VICTORY_LOG=info';

  const off = path.join(dir, '20261124-120300-off.log');
  const on = path.join(dir, '20261124-120400-on.log');
  const noHeader = path.join(dir, '20261124-120500-noheader.log');
  fs.writeFileSync(off, [header, frameLine('2026-11-24T12:03:00.000000Z', 30.0), failureText, ''].join('\n'));
  fs.writeFileSync(
    on,
    [
      header,
      'harness env: VICTORY_D3D12_DEBUG=1',
      'harness env: VICTORY_D3D12_GBV=1',
      frameLine('2026-11-24T12:04:00.000000Z', 30.0),
      '',
    ].join('\n'),
  );
  fs.writeFileSync(
    noHeader,
    [frameLine('2026-11-24T12:05:00.000000Z', 30.0), failureText, ''].join('\n'),
  );

  const result = runTable([off, on, noHeader]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rows = Object.fromEntries(objects(tables(result.stdout)[0]).map((row) => [row.tag, row]));

  assert.equal(rows.off['debug layer'], 'off');
  assert.equal(rows.off.GBV, 'off');
  assert.equal(rows.on['debug layer'], 'on');
  assert.equal(rows.on.GBV, 'on');
  assert.equal(rows.noheader['debug layer'], '?');
  assert.equal(rows.noheader.GBV, '?');
});

test('experiment table: a title unhandled exception ends the run as title crashed', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'experiment-table-crash-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, '20261124-121600-crash.log');
  fs.writeFileSync(
    log,
    [
      frameLine('2026-11-24T12:16:00.000000Z', 30.0, 0),
      'VIctory: unhandled exception 0xc0000005 at victory-image-0123456789abcdef.dll+0x1 (write 0x0: nothing mapped there)',
      '',
    ].join('\n'),
  );

  const result = runTable([log]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(objects(tables(result.stdout)[0])[0].ended, 'title crashed');

  const data = JSON.parse(runTable(['--json', log]).stdout);
  assert.equal(data.runs[0].ended.kind, 'title_crashed');
  assert.equal(data.runs[0].ended.text, 'title crashed');
});

test('experiment table: a harness-ended run says how it ended', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'experiment-table-heavy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, '20261124-121500-heavy.log');
  fs.writeFileSync(
    log,
    [
      'harness build: abc profile=diag console=series-x',
      frameLine('2026-11-24T12:15:00.000000Z', 30.0, 0),
      'harness: ended by --heavy-seconds after 20 s of heavy scene',
      '',
    ].join('\n'),
  );

  const result = runTable([log]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const rows = objects(tables(result.stdout)[0]);
  assert.equal(rows[0].ended, 'ended by the harness after 20 s of heavy scene');

  const json = JSON.parse(runTable(['--json', log]).stdout);
  assert.equal(json.runs[0].ended.kind, 'harness_ended');
  assert.equal(json.runs[0].ended.seconds, 20);
});

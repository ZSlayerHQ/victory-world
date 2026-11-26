import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './test-isolation.mjs';

import {
  captureFolderFromLog,
  findTrigger,
  readPresentMon,
} from './presentmon.mjs';

// A VIctory 5-second frame line, the shape FRAME_RE in parse-run.mjs matches.
function frameLine(ts, draws, dropped = 0) {
  return `${ts}  INFO victory_gpu::host: 30.0 fps, 33.3 ms/frame (0.2 preparing: copies 0.1 ms 0.2 MB, textures 0.0 ms 0.0 MB; 0.9 on the GPU; 0.0 copying back 0.0 MB), ${draws} draws/frame, dropped ${dropped} without a host pipeline (0 being made) and 1 indirect`;
}

function presentLine(ts, draws) {
  return `${ts}  INFO victory_gpu::queue: frame presented (since the last line: draws and dispatches, and those run on the host) frame=2500 draws=${draws} drawn=${draws} dispatches=0 dispatched=0`;
}

function csvFile(t, name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentmon-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('watcher trigger: fires on the first frame line at or above the threshold, and not before', () => {
  const lines = [
    frameLine('2026-11-24T12:00:00.000000Z', 13),
    presentLine('2026-11-24T12:00:00.500000Z', 5000), // presents carry draws too; not a frame line
    frameLine('2026-11-24T12:00:01.000000Z', 999),
    frameLine('2026-11-24T12:00:02.000000Z', 1000),
    frameLine('2026-11-24T12:00:03.000000Z', 3496),
  ];

  assert.equal(findTrigger(lines.slice(0, 3), 1000), null, 'nothing at or above 1000 before index 3');
  assert.deepEqual(
    findTrigger(lines, 1000),
    { index: 3, draws: 1000, dropped: 0 },
    'first qualifying line, not the later one',
  );
  assert.deepEqual(findTrigger(lines, 999), { index: 2, draws: 999, dropped: 0 }, 'the threshold itself counts');
  assert.equal(findTrigger([frameLine('2026-11-24T12:00:00.000000Z', 999)]), null, 'default threshold is 1000');
  assert.deepEqual(findTrigger([frameLine('2026-11-24T12:00:00.000000Z', 1000)]), {
    index: 0,
    draws: 1000,
    dropped: 0,
  });

  // The log the watcher tails is raw: its lines still carry the console's ANSI colours.
  const coloured = '\x1b[2m' + frameLine('2026-11-24T12:00:04.000000Z', 1200) + '\x1b[0m';
  assert.deepEqual(findTrigger([coloured], 1000), { index: 0, draws: 1200, dropped: 0 });
});

test('watcher trigger: the runtime\'s "frame N, " prefix does not hide the frame line', () => {
  const line =
    '\x1b[2m2026-11-26T05:02:11.250000Z\x1b[0m \x1b[32m INFO\x1b[0m ' +
    '\x1b[2mvictory_gpu::host\x1b[0m\x1b[2m:\x1b[0m ' +
    'frame 18432, 27.4 fps, 36.5 ms/frame (0.4 preparing: copies 0.3 ms 1.2 MB, ' +
    'textures hashed 0.2 ms 0.1 MB; 1.7 on the GPU; 0.1 copying back 0.9 MB), ' +
    '5000 draws/frame, dropped 3 without a host pipeline (1 being made) and 7 indirect';
  assert.deepEqual(findTrigger([line], 1000), { index: 0, draws: 5000, dropped: 3 });
});

test('watcher trigger: draws plus dropped reach the threshold when most draws are dropped', () => {
  // The run this fixes: at most 145 drawn, 543 to 2,744 dropped. 145 draws alone never reaches 1000.
  const heavy = frameLine('2026-11-24T12:00:10.000000Z', 145, 2744);
  assert.deepEqual(findTrigger([heavy], 1000), { index: 0, draws: 145, dropped: 2744 }, '2798 draws+dropped');

  const before = frameLine('2026-11-24T12:00:00.000000Z', 145, 543);
  assert.equal(findTrigger([before], 1000), null, '688 draws+dropped stays below 1000');

  const light = frameLine('2026-11-24T12:00:05.000000Z', 900, 99);
  assert.equal(findTrigger([light], 1000), null, '999 draws+dropped stays below 1000');
  assert.deepEqual(findTrigger([light], 999), { index: 0, draws: 900, dropped: 99 }, 'the sum counts exactly');

  // A draws-heavy line still fires on its own; both shapes select the first qualifying line.
  const drawsHeavy = frameLine('2026-11-24T12:00:00.000000Z', 1200, 0);
  assert.deepEqual(
    findTrigger([drawsHeavy, heavy], 1000),
    { index: 0, draws: 1200, dropped: 0 },
    'the earlier draws-heavy line wins',
  );
  assert.deepEqual(
    findTrigger([light, heavy], 1000),
    { index: 1, draws: 145, dropped: 2744 },
    'drops alone cannot qualify, but they carry the line over the threshold',
  );
});

test('readPresentMon: 2.x FrameTime/GPUBusy header', (t) => {
  // 10 valid frames plus one NA row; median 19, p95 28, GPU median 5.5.
  const rows = [];
  for (let i = 0; i < 10; i += 1) {
    rows.push(`victory.exe,100,0x1,DXGI,0,0,1,Hardware Composed: Independent Flip,${i},NA,${10 + i * 2},1,${i + 1},0`);
  }
  rows.push('victory.exe,100,0x1,DXGI,0,0,1,Hardware Composed: Independent Flip,NA,NA,NA,NA,NA,NA');
  const csv = csvFile(
    t,
    'frame-time.csv',
    '﻿Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,TimeInMs,MsBetweenSimulationStart,FrameTime,CPUBusy,GPUBusy,GPUWait\r\n' +
      rows.join('\r\n') +
      '\r\n',
  );

  assert.deepEqual(readPresentMon(csv), {
    frames: 10,
    medianMs: 19,
    p95Ms: 28,
    gpuMedianMs: 5.5,
  });
});

test('readPresentMon: 2.x MsBetweenPresents/MsGPUBusy header', (t) => {
  // The 28-column header of the 2.6.0 capture: frame times 10/20/30/40, GPU 2/4/6/8.
  const header =
    '﻿Application,ProcessID,SwapChainAddress,PresentRuntime,SyncInterval,PresentFlags,AllowsTearing,PresentMode,TimeInMs,' +
    'MsBetweenSimulationStart,MsBetweenPresents,MsBetweenDisplayChange,MsInPresentAPI,MsRenderPresentLatency,MsUntilDisplayed,' +
    'CPUStartTimeInMs,MsBetweenAppStart,MsCPUBusy,MsCPUWait,MsGPULatency,MsGPUTime,MsGPUBusy,MsGPUWait,MsAnimationError,' +
    'AnimationTime,MsFlipDelay,MsAllInputToPhotonLatency,MsClickToPhotonLatency\r\n';
  const rows = [
    'victory.exe,100,0x1,DXGI,0,0,1,Hardware Composed: Independent Flip,0,NA,10,10,0.5,0.6,0.7,0,10,9,0.5,0.2,9,2,8,NA,0,NA,NA,NA',
    'victory.exe,100,0x1,DXGI,0,0,1,Hardware Composed: Independent Flip,10,NA,20,20,0.5,0.6,0.7,0,10,19,0.5,0.2,19,4,18,NA,10,NA,NA,NA',
    'victory.exe,100,0x1,DXGI,0,0,1,Hardware Composed: Independent Flip,30,NA,30,30,0.5,0.6,0.7,0,10,29,0.5,0.2,29,6,28,NA,30,NA,NA,NA',
    'victory.exe,100,0x1,DXGI,0,0,1,Hardware Composed: Independent Flip,60,NA,40,40,0.5,0.6,0.7,0,10,39,0.5,0.2,39,8,38,NA,60,NA,NA,NA',
  ];
  const csv = csvFile(t, 'ms-names.csv', header + rows.join('\r\n') + '\r\n');

  assert.deepEqual(readPresentMon(csv), {
    frames: 4,
    medianMs: 25,
    p95Ms: 40,
    gpuMedianMs: 5,
  });
});

test('readPresentMon: 1.x --v1_metrics header', (t) => {
  // 1.x names are lower-case and its GPU busy column is msGPUActive.
  const header =
    '\uFEFFApplication,ProcessID,SwapChainAddress,Runtime,SyncInterval,PresentFlags,Dropped,TimeInSeconds,' +
    'msInPresentAPI,msBetweenPresents,AllowsTearing,PresentMode,msUntilRenderComplete,msUntilDisplayed,' +
    'msBetweenDisplayChange,msFlipDelay,msUntilRenderStart,msGPUActive,msGPUVideoActive,msSinceInput,QPCTime,' +
    'msDisplayTime,FrameId\r\n';
  const rows = [
    'victory.exe,100,0x1,DXGI,0,0,0,0,0.5,16.7,1,Hardware Composed: Independent Flip,15,16,16.7,NA,14,8,NA,NA,0,16,1',
    'victory.exe,100,0x1,DXGI,0,0,0,0,0.5,33.3,1,Hardware Composed: Independent Flip,32,33,33.3,NA,31,16,NA,NA,0,33,2',
    'victory.exe,100,0x1,DXGI,0,0,0,0,0.5,50.0,1,Hardware Composed: Independent Flip,48,49,50.0,NA,47,24,NA,NA,0,50,3',
    'victory.exe,100,0x1,DXGI,0,0,0,0,0.5,16.7,1,Hardware Composed: Independent Flip,15,16,16.7,NA,14,8,NA,NA,0,16,4',
    'victory.exe,100,0x1,DXGI,0,0,0,0,0.5,33.3,1,Hardware Composed: Independent Flip,32,33,33.3,NA,31,16,NA,NA,0,33,5',
  ];
  const csv = csvFile(t, 'v1-names.csv', header + rows.join('\r\n') + '\r\n');

  assert.deepEqual(readPresentMon(csv), {
    frames: 5,
    medianMs: 33.3,
    p95Ms: 50,
    gpuMedianMs: 16,
  });
});

test('readPresentMon: missing file is null, header-only file is zero frames', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentmon-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.equal(readPresentMon(path.join(dir, 'absent.csv')), null);
  assert.equal(readPresentMon(null), null);

  const empty = path.join(dir, 'empty.csv');
  fs.writeFileSync(empty, '');
  assert.deepEqual(readPresentMon(empty), {
    frames: 0,
    medianMs: null,
    p95Ms: null,
    gpuMedianMs: null,
  });

  const headerOnly = path.join(dir, 'header-only.csv');
  fs.writeFileSync(headerOnly, 'Application,ProcessID,FrameTime,GPUBusy\r\n');
  assert.deepEqual(readPresentMon(headerOnly), {
    frames: 0,
    medianMs: null,
    p95Ms: null,
    gpuMedianMs: null,
  });
});

test('capture folder: capture: line first, then log file name', () => {
  assert.equal(
    captureFolderFromLog(
      ['harness build: abc profile=diag', 'capture: /captures/20261124-120000-alpha/'],
      '/tmp/20261124-120000-beta.log',
    ),
    '/captures/20261124-120000-alpha',
  );
  assert.equal(
    captureFolderFromLog(
      [
        'harness build: abc profile=diag',
        'harness env: VICTORY_CAPTURE=' + path.win32.join('/captures', '20261124-120000-gamma'),
      ],
      '/tmp/20261124-120000-beta.log',
    ),
    '/captures/20261124-120000-gamma',
  );
  assert.equal(
    captureFolderFromLog(['harness build: abc profile=diag'], '<project>/harness/logs/20261124-120000-beta.log'),
    '/captures/20261124-120000-beta',
  );
  assert.equal(captureFolderFromLog([], '/tmp/not-a-run.log'), null);
});

test('summaries read presentmon.csv from the log capture folder', (t) => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'presentmon-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  const capture = path.join(dir, 'capture');
  fs.mkdirSync(capture);
  const log = path.join(dir, '20261124-120000-pm.log');
  fs.writeFileSync(
    log,
    [
      'harness build: abc profile=diag console=series-x',
      `capture: ${capture}`,
      frameLine('2026-11-24T12:00:00.000000Z', 13),
      presentLine('2026-11-24T12:00:00.500000Z', 2500),
      'title exited with 0',
      '',
    ].join('\n'),
  );
  const csv = path.join(capture, 'presentmon.csv');
  fs.writeFileSync(
    csv,
    'Application,ProcessID,FrameTime,GPUBusy\r\n' +
      ['victory.exe,100,10,2', 'victory.exe,100,20,4', 'victory.exe,100,30,6', 'victory.exe,100,40,8']
        .join('\r\n') +
      '\r\n',
  );

  const run = (script, args) =>
    spawnSync(process.execPath, [path.join(here, script), ...args], { encoding: 'utf8', env: isolatedEnv() });

  const summary = run('summarize-run.mjs', [log]);
  assert.equal(summary.status, 0, summary.stderr);
  assert.ok(summary.stdout.includes('PresentMon: 4 frames — median 25.0 ms, p95 40.0 ms, GPU busy median 5.0 ms'), summary.stdout);

  const json = JSON.parse(run('summarize-run.mjs', [log, '--json']).stdout);
  assert.deepEqual(json.presentmon, { frames: 4, medianMs: 25, p95Ms: 40, gpuMedianMs: 5 });

  const table = run('experiment-table.mjs', [log]);
  assert.equal(table.status, 0, table.stderr);
  assert.ok(table.stdout.includes('| median frame ms | p95 frame ms | GPU median ms |'), table.stdout);
  assert.ok(table.stdout.includes('| pm | '), table.stdout);
  assert.ok(table.stdout.includes('| 25.0 | 40.0 | 5.0 |'), table.stdout);
  const tableJson = JSON.parse(run('experiment-table.mjs', ['--json', log]).stdout);
  assert.deepEqual(tableJson.runs[0].presentmon, { frames: 4, medianMs: 25, p95Ms: 40, gpuMedianMs: 5 });

  // No CSV: no new line, key or columns.
  fs.rmSync(csv);
  const plain = run('summarize-run.mjs', [log]);
  assert.equal(plain.status, 0, plain.stderr);
  assert.equal(plain.stdout.includes('PresentMon:'), false, plain.stdout);
  assert.equal('presentmon' in JSON.parse(run('summarize-run.mjs', [log, '--json']).stdout), false);
  const plainTable = run('experiment-table.mjs', [log]);
  assert.equal(plainTable.status, 0, plainTable.stderr);
  assert.equal(plainTable.stdout.includes('median frame ms'), false, plainTable.stdout);
  assert.equal('presentmon' in JSON.parse(run('experiment-table.mjs', ['--json', log]).stdout).runs[0], false);
});

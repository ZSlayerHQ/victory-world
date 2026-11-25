import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { parseExtras, parseLogLines, parseTranslationFailures } from './parse-run.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const HEAD =
  " WARN victory_gpu::pipeline: shader does not translate; its pipelines' draws are dropped";
const TS = '2026-11-24T20:27:48.000000Z';

const oldLine = (stage, hash, reason) =>
  `${TS}${HEAD} stage="${stage}" hash=${hash} error=converter shader.dxil v1: GFX10 code at 0x1234: ${reason}`;

const newLine = (stage, hash, reason, trailer = 'cached=false ms=9 user_ms=0 kernel_ms=0') =>
  `${TS}${HEAD} stage="${stage}" hash=${hash} error=GFX10 code at 0x288: ${reason} ${trailer}`;

test('old format: converter and GFX10 prefixes are stripped for every stage', () => {
  const ballot = 'a 64-lane wave ballot in divergent control flow is not supported';
  const reduction = 'a wave reduction in divergent control flow is not supported';
  const lds = 'LDS accesses without a uniform LDS fence in split wave64 is not supported';
  const crossLane = 'a cross-lane read in divergent control flow is not supported';

  const lines = [
    oldLine('compute', '0123456789abcdef', ballot),
    oldLine('mesh', 'bbbbbbbbbbbbbbbb', reduction),
    oldLine('pixel', 'cccccccccccccccc', lds),
    oldLine('vertex', 'dddddddddddddddd', crossLane),
  ];

  assert.deepEqual(parseTranslationFailures(lines), [
    { stage: 'compute', hash: '0123456789abcdef', reason: ballot },
    { stage: 'mesh', hash: 'bbbbbbbbbbbbbbbb', reason: reduction },
    { stage: 'pixel', hash: 'cccccccccccccccc', reason: lds },
    { stage: 'vertex', hash: 'dddddddddddddddd', reason: crossLane },
  ]);
});

test('new format: GFX10 prefix and cached/ms/user_ms/kernel_ms fields are stripped', () => {
  const reason = 'a 64-lane wave ballot in divergent control flow is not supported';
  const line = newLine('compute', '0123456789abcdef', reason);

  assert.deepEqual(parseTranslationFailures([line]), [
    { stage: 'compute', hash: '0123456789abcdef', reason },
  ]);
});

test('new format: any trailing run of word=value fields is stripped', () => {
  const reason = 'LDS accesses without a uniform LDS fence in split wave64 is not supported';
  const lines = [
    newLine('mesh', 'bbbbbbbbbbbbbbbb', reason, 'cached=true attempts=3 elapsed_ms=41'),
    newLine('pixel', 'cccccccccccccccc', reason, 'cached=false retries=0 note=a=b'),
  ];

  assert.deepEqual(parseTranslationFailures(lines), [
    { stage: 'mesh', hash: 'bbbbbbbbbbbbbbbb', reason },
    { stage: 'pixel', hash: 'cccccccccccccccc', reason },
  ]);
});

test('missing GFX10 prefix and missing converter prefix are both optional', () => {
  const ballot = 'a 64-lane wave ballot in divergent control flow is not supported';
  const reduction = 'a wave reduction in divergent control flow is not supported';

  const lines = [
    `${TS}${HEAD} stage="compute" hash=0123456789abcdef error=${ballot} cached=false ms=9`,
    `${TS}${HEAD} stage="pixel" hash=bbbbbbbbbbbbbbbb error=converter shader.dxil v1: ${reduction}`,
  ];

  assert.deepEqual(parseTranslationFailures(lines), [
    { stage: 'compute', hash: '0123456789abcdef', reason: ballot },
    { stage: 'pixel', hash: 'bbbbbbbbbbbbbbbb', reason: reduction },
  ]);
});

test('an = inside a reason is kept unless it is part of a trailing run', () => {
  const reason = 'operand x=y in divergent control flow is not supported';
  const line = `${TS}${HEAD} stage="compute" hash=0123456789abcdef error=GFX10 code at 0x10: ${reason} cached=false ms=1`;

  assert.deepEqual(parseTranslationFailures([line]), [
    { stage: 'compute', hash: '0123456789abcdef', reason },
  ]);
});

test('ANSI-coloured text input is still parsed', () => {
  const reason = 'a cross-lane read in divergent control flow is not supported';
  const line =
    '\x1b[2m' + newLine('compute', '0123456789abcdef', reason) + '\x1b[0m';

  assert.deepEqual(parseTranslationFailures(line), [
    { stage: 'compute', hash: '0123456789abcdef', reason },
  ]);
});

test('non-failure lines are ignored and failure order is kept', () => {
  const first = 'a 64-lane wave ballot in divergent control flow is not supported';
  const second = 'a wave reduction in divergent control flow is not supported';
  const lines = [
    `${TS}  INFO victory_gpu::pipeline: shader translated stage="compute" hash=aaaaaaaaaaaaaaaa user_data=0 samplers=0`,
    oldLine('compute', '0123456789abcdef', first),
    newLine('pixel', 'bbbbbbbbbbbbbbbb', second),
    `${TS}  INFO victory_gpu::host: 60.0 fps, 16.6 ms/frame`,
  ];

  assert.deepEqual(parseTranslationFailures(lines), [
    { stage: 'compute', hash: '0123456789abcdef', reason: first },
    { stage: 'pixel', hash: 'bbbbbbbbbbbbbbbb', reason: second },
  ]);
});

const SYNTH_TS = '2026-11-24T21:08:23.8243471Z';
const driverLine = (id, text) => `driver event: ${SYNTH_TS} id=${id} ${text}`;

test('driver events: a count per kind and distinct ESR value sets without register addresses', () => {
  const lines = [
    driverLine(13, 'Graphics SM Warp Exception on (GPC 1, TPC 4, SM 0): MMU Fault'),
    driverLine(13, 'Graphics SM Global Exception on (GPC 10, TPC 7, SM 0): Multiple Warp Errors'),
    driverLine(
      13,
      'Graphics Exception: ESR 0x555730=0x82a0017 0x555734=0x0 0x555728=0x1c813b60 0x55572c=0x1104',
    ),
    driverLine(
      13,
      'Graphics Exception: ESR 0x5ac730=0x82a0017 0x5ac734=0x0 0x5ac728=0x1c813b60 0x5ac72c=0x1104',
    ),
    driverLine(
      13,
      'Graphics Exception: ESR 0x5077b0=0x82d0017 0x5077b4=0x4 0x5077a8=0x1c813b60 0x5077ac=0x1104',
    ),
    driverLine(153, 'Error occurred on GPUID:'),
  ];

  const { summary } = parseLogLines(lines, 'synthetic.log');
  assert.deepEqual(summary.driverEvents, {
    total: 6,
    counts: { mmuFault: 1, multipleWarpErrors: 1, otherId13: 3, id153: 1 },
    // Registers differ per shader core; only the values are kept, and equal sets merge.
    esrValueSets: [
      { values: ['0x82a0017', '0x0', '0x1c813b60', '0x1104'], count: 2 },
      { values: ['0x82d0017', '0x4', '0x1c813b60', '0x1104'], count: 1 },
    ],
  });
});

test('settings come only from harness env header lines, never from matching body text', () => {
  const body = [
    `${TS}  WARN victory_gpu::shader_cache: VICTORY_SHADER_LOOP_LIMIT: translated loops stop sooner limit=999`,
    `${TS}  INFO victory_gpu::host: Wave64 compute lowering mode selected wave64_mode=Native`,
    `${TS}  INFO victory_gpu::host: VIctory settings: skipped pipelines=ffffffffffffffff gpu timing=on copy mode=none aftermath=off`,
    `${TS} ERROR victory_gpu::host: host GPU device removed; a diagnostics build with VICTORY_D3D12_DEBUG=1 names the command, and VICTORY_D3D12_GBV=1 validates it`,
  ];
  const header = [
    'harness build: abc profile=diag console=series-x',
    'harness env: VICTORY_SHADER_LOOP_LIMIT=32',
    'harness env: VICTORY_WAVE64_EMULATE=emulate',
    'harness env: VICTORY_SKIP_PIPELINES=0123456789abcdef',
    'harness env: VICTORY_GPU_TIMING=1',
    'harness env: VICTORY_COPY_MODE=plain',
    'harness env: VICTORY_AFTERMATH=<drive>/captures/synthetic',
    'harness env: record=on',
  ];

  assert.deepEqual(parseExtras([...header, ...body], null, null).settings, {
    skippedPipelines: '0123456789abcdef',
    loopLimit: 32,
    wave64: 'emulate',
    gpuTiming: true,
    d3d12Debug: false,
    d3d12Gbv: false,
    copyMode: 'plain',
    aftermath: true,
    record: true,
  });

  // A header with none of the flags records that they were off.
  const bareHeader = [
    'harness build: abc profile=diag console=series-x',
    'harness env: VICTORY_LOG=info',
  ];
  const bareSettings = parseExtras([...bareHeader, ...body], null, null).settings;
  assert.equal(bareSettings.d3d12Debug, false);
  assert.equal(bareSettings.d3d12Gbv, false);
  assert.equal(bareSettings.gpuTiming, false);
  assert.equal(bareSettings.aftermath, false);
  assert.equal(bareSettings.record, false);

  // No header at all: nothing is known, and body text is never a substitute.
  assert.deepEqual(parseExtras(body, null, null).settings, {
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
});

test('summarize-run: the Driver events section reports the counts and the ESR values', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-events-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, '20261124-210000-events.log');
  fs.writeFileSync(
    log,
    [
      driverLine(13, 'Graphics SM Warp Exception on (GPC 1, TPC 4, SM 0): MMU Fault'),
      driverLine(13, 'Graphics SM Global Exception on (GPC 10, TPC 7, SM 0): Multiple Warp Errors'),
      driverLine(
        13,
        'Graphics Exception: ESR 0x555730=0x82a0017 0x555734=0x0 0x555728=0x1c813b60 0x55572c=0x1104',
      ),
      driverLine(153, 'Error occurred on GPUID:'),
      '',
    ].join('\n'),
  );

  const result = spawnSync(process.execPath, [path.join(here, 'summarize-run.mjs'), log], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Driver events/);
  assert.match(result.stdout, /- MMU Fault: 1/);
  assert.match(result.stdout, /- Multiple Warp Errors: 1/);
  assert.match(result.stdout, /- other id 13 texts: 1/);
  assert.match(result.stdout, /- id 153: 1/);
  assert.match(result.stdout, /- ESR values: 0x82a0017 0x0 0x1c813b60 0x1104 x1/);

  const json = JSON.parse(
    spawnSync(process.execPath, [path.join(here, 'summarize-run.mjs'), log, '--json'], {
      encoding: 'utf8',
    }).stdout,
  );
  assert.equal(json.driverEvents.total, 4);
  assert.deepEqual(json.driverEvents.counts, {
    mmuFault: 1,
    multipleWarpErrors: 1,
    otherId13: 1,
    id153: 1,
  });
});

test('a title unhandled exception is a failure and ends the run as a title crash', () => {
  const lines = [
    '2026-11-24T12:00:00.000000Z  INFO victory_gpu::host: 30.0 fps, 33.3 ms/frame (0.2 preparing: copies 0.1 ms 0.2 MB, textures 0.0 ms 0.0 MB; 0.9 on the GPU; 0.0 copying back 0.0 MB), 12 draws/frame, dropped 0 without a host pipeline (0 being made) and 1 indirect',
    'VIctory: unhandled exception 0xc0000005 at victory-image-0123456789abcdef.dll+0x1 (write 0x0: nothing mapped there)',
  ];
  const { summary, firstTs, lastTs } = parseLogLines(lines, 'synthetic.log');
  assert.equal(summary.failures.length, 1);
  assert.match(summary.failures[0], /unhandled exception/);

  const extras = parseExtras(lines, firstTs, lastTs);
  assert.equal(extras.ending.kind, 'title_crashed');
  assert.equal(extras.ending.text, 'title crashed');
});

test('a stopped command with no marker reports an unknown pipeline, not a later dispatch hash', () => {
  const line =
    '2026-11-24T12:00:10.000000Z ERROR victory_gpu::host: host GPU device removed after a submission of 2 lists; ' +
    'breadcrumbs (done/count, list) ["1/1 None"]; a list stopped at command 250 of 552 (op 5), commands 249..251 between its barriers:; ' +
    'command 250 (op 5): no marker; a list stopped at command 0 of 2 (op 46); list 2 of 11, of its 3: ' +
    'dispatch 33x33x6 [compute 19e215b47ff9112a] | 19e215b47ff9112a: u4=0x1 [heap 1: null]';
  const { details, firstTs, lastTs } = parseLogLines([line], 'synthetic.log');
  assert.equal(details.hangs.length, 1);
  assert.equal(details.hangs[0].command, 'no marker');
  assert.equal(details.hangs[0].pipelineUnknown, 'no marker');

  const extras = parseExtras([line], firstTs, lastTs);
  assert.equal(extras.hung.pipelineHash, null);
  assert.equal(extras.hung.stage, null);
  assert.equal(extras.hung.pipelineUnknown, 'no marker');
  assert.deepEqual(extras.hung.nullSlots, []);
});

test('summarize-run: a markerless stopped command names no pipeline', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'no-marker-summary-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const log = path.join(dir, '20261124-210000-nomarker.log');
  fs.writeFileSync(
    log,
    [
      '2026-11-24T12:00:10.000000Z ERROR victory_gpu::host: host GPU device removed after a submission of 2 lists; ' +
        'breadcrumbs (done/count, list) ["1/1 None"]; a list stopped at command 250 of 552 (op 5), commands 249..251 between its barriers:; ' +
        'command 250 (op 5): no marker; a list stopped at command 0 of 2 (op 46); list 2 of 11, of its 3: ' +
        'dispatch 33x33x6 [compute 19e215b47ff9112a] | 19e215b47ff9112a: u4=0x1 [heap 1: null]',
      '',
    ].join('\n'),
  );

  const result = spawnSync(process.execPath, [path.join(here, 'summarize-run.mjs'), log], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stopped at command 250\/552 \(op 5\): pipeline unknown \(no marker\)/);
  assert.equal(result.stdout.includes('19e215b47ff9112a'), false, result.stdout);
});

test('a harness-ended run says so, ahead of a device removal or a crash in the same log', () => {
  const lines = [
    '2026-11-24T12:00:00.000000Z  INFO victory_gpu::host: 30.0 fps, 33.3 ms/frame (0.2 preparing: copies 0.1 ms 0.2 MB, textures 0.0 ms 0.0 MB; 0.9 on the GPU; 0.0 copying back 0.0 MB), 12 draws/frame, dropped 0 without a host pipeline (0 being made) and 1 indirect',
    '2026-11-24T12:00:09.000000Z ERROR victory_gpu::host: host GPU device removed after a submission of 2 lists',
    'VIctory: unhandled exception 0xc0000005 at victory-image-0123456789abcdef.dll+0x1',
    'harness: ended by --heavy-seconds after 30 s of heavy scene',
  ];

  const { summary, firstTs, lastTs } = parseLogLines(lines, 'synthetic.log');
  assert.equal(summary.durationSeconds, 9);
  const extras = parseExtras(lines, firstTs, lastTs);
  assert.deepEqual(extras.ending, {
    kind: 'harness_ended',
    seconds: 30,
    frame: null,
    text: 'ended by the harness after 30 s of heavy scene',
  });

  // Without the line the same log is a device removal, so the new line is what changes the ending.
  assert.equal(parseExtras(lines.slice(0, 3), firstTs, lastTs).ending.kind, 'device_removed');
});

test('a settled run carries its settle time and ends on the settled clock', () => {
  const lines = [
    '2026-11-24T12:00:00.000000Z  INFO victory_gpu::host: 30.0 fps, 33.3 ms/frame (0.2 preparing: copies 0.1 ms 0.2 MB, textures 0.0 ms 0.0 MB; 0.9 on the GPU; 0.0 copying back 0.0 MB), 12 draws/frame, dropped 0 without a host pipeline (0 being made) and 1 indirect',
    'harness: settled at 57 s (waiting 1558, 2.9 fps)',
    'harness: ended by --settled-seconds after 75 s of settled scene',
  ];
  const { firstTs, lastTs } = parseLogLines(lines, 'synthetic.log');
  const extras = parseExtras(lines, firstTs, lastTs);
  assert.deepEqual(extras.settled, { seconds: 57, waiting: 1558, fps: 2.9 });
  assert.equal(extras.settledTimeout, false);
  assert.equal(extras.ending.text, 'ended by the harness after 75 s of settled scene');

  const timedOut = [
    'harness: ended by --settled-timeout after 600 s: the scene never settled',
  ];
  const timeout = parseExtras(timedOut, firstTs, lastTs);
  assert.equal(timeout.settled, null);
  assert.equal(timeout.settledTimeout, true);
});

test('host mesh pipeline refused counts as a refused pipeline too', () => {
  const lines = [
    `${TS}  WARN victory_gpu::pipeline::host: host pipeline refused error=The parameter is incorrect. (0x80070057) shaders=[compute aaaaaaaaaaaaaaaa]`,
    `${TS}  WARN victory_gpu::pipeline::host: host mesh pipeline refused error=The parameter is incorrect. (0x80070057) shaders=[mesh 1111222233334444, pixel 5555666677778888]`,
    `${TS}  WARN victory_gpu::pipeline::host: host root signature refused error=The parameter is incorrect. (0x80070057) shaders=[pixel bbbbbbbbbbbbbbbb]`,
  ];
  const { summary } = parseLogLines(lines, 'synthetic.log');
  assert.equal(summary.refusedPipelines.count, 2);
  assert.deepEqual(summary.refusedPipelines.hashes, [
    'compute aaaaaaaaaaaaaaaa',
    'mesh 1111222233334444, pixel 5555666677778888',
  ]);
});

test('a title-chosen exit is its own ending and a failure when the code is not 0', () => {
  const lines = [
    `${TS}  WARN victory_hle::modules::kernel: title ended the process: call ExitProcess, code 127, from game.exe+0x1234`,
    'harness: victory exit=127',
  ];
  const { summary, firstTs, lastTs } = parseLogLines(lines, 'synthetic.log');
  assert.deepEqual(parseExtras(lines, firstTs, lastTs).ending, {
    kind: 'title_ended',
    seconds: null,
    frame: null,
    text: 'the title ended the process: ExitProcess, code 127',
  });
  assert.equal(summary.failures.length, 1);
  assert.match(summary.failures[0], /title ended the process: call ExitProcess, code 127/);
});

test('a title exit with code 0 is an ending of its own, not a failure', () => {
  const lines = [
    `${TS}  WARN victory_hle::modules::kernel: title ended the process: call exit, code 0, from game.exe+0x10`,
    'harness: victory exit=0',
  ];
  const { summary, firstTs, lastTs } = parseLogLines(lines, 'synthetic.log');
  assert.equal(summary.failures.length, 0);
  assert.equal(
    parseExtras(lines, firstTs, lastTs).ending.text,
    'the title ended the process: exit, code 0',
  );
});

test('runtime exit: code 0 is a clean exit beside the older exit code 0 form', () => {
  assert.equal(
    parseExtras([`${TS}  INFO victory: runtime exit: code 0`], null, null).ending.kind,
    'clean_exit',
  );
  assert.equal(
    parseExtras([`${TS}  INFO victory: exit code 0`], null, null).ending.kind,
    'clean_exit',
  );
});

test('a non-zero harness exit with no failure line is flagged, not "log ends"', () => {
  assert.deepEqual(parseExtras(['harness: victory exit=127'], null, null).ending, {
    kind: 'exited_without_a_failure_line',
    seconds: null,
    frame: null,
    text: 'exited with code 127 and no failure line: check what else was running',
  });
});

test('the harness exit does not overrule a failure line or a clean exit', () => {  // A crash with the same code keeps the crash's ending.
  assert.equal(
    parseExtras(
      [
        'VIctory: unhandled exception 0xc0000005 at victory-image-0123456789abcdef.dll+0x1',
        'harness: victory exit=127',
      ],
      null,
      null,
    ).ending.kind,
    'title_crashed',
  );
  // A deliberate end by --heavy-seconds still wins over its non-zero code.
  assert.equal(
    parseExtras(
      ['harness: ended by --heavy-seconds after 30 s of heavy scene', 'harness: victory exit=1'],
      null,
      null,
    ).ending.kind,
    'harness_ended',
  );
  assert.equal(parseExtras(['harness: victory exit=0'], null, null).ending.kind, 'clean_exit');
});

test('summarize-run: the screen record line names the video, its frames and its sheets', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'screen-record-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capture = path.join(dir, 'capture');
  fs.mkdirSync(path.join(capture, 'sheets'), { recursive: true });
  const made = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=2:duration=3', '-pix_fmt', 'yuv420p', path.join(capture, 'screen.mp4')],
    { encoding: 'utf8' },
  );
  assert.equal(made.status, 0, made.stderr);
  fs.writeFileSync(path.join(capture, 'sheets', 'sheet-001.jpg'), Buffer.from([0xff, 0xd8, 0xff]));

  const log = path.join(dir, '20261124-230000-record.log');
  fs.writeFileSync(
    log,
    [
      'harness build: abc profile=diag console=series-x',
      'harness env: record=on',
      `capture: ${capture}`,
      'harness: victory exit=0',
      '',
    ].join('\n'),
  );
  const result = spawnSync(process.execPath, [path.join(here, 'summarize-run.mjs'), log], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Screen record: .*screen\.mp4 \(6 frames, 1 sheets\)/);

  // No video in the capture folder: none.
  const other = path.join(dir, '20261124-230001-norecord.log');
  fs.writeFileSync(
    other,
    [
      'harness build: abc profile=diag console=series-x',
      'harness env: record=off',
      `capture: ${path.join(dir, 'empty')}`,
      'harness: victory exit=0',
      '',
    ].join('\n'),
  );
  const none = spawnSync(process.execPath, [path.join(here, 'summarize-run.mjs'), other], {
    encoding: 'utf8',
  });
  assert.equal(none.status, 0, none.stderr);
  assert.match(none.stdout, /Screen record: none/);
});

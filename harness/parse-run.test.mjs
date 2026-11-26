import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './test-isolation.mjs';
import { parseExtras, parseLogLines, parseTranslationFailures, stripControl } from './parse-run.mjs';

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

test('the shared stripper removes any control sequence, not only colour codes', () => {
  const codes = [
    '\x1b[0m', // colour reset
    '\x1b[38;5;196m', // 256-colour
    '\x1b[?25l', // cursor hide (private parameter)
    '\x1b]0;a window title\x07', // OSC, BEL-terminated
    '\x1b]2;a window title\x1b\\', // OSC, ST-terminated
    '\x1b(B', // ESC ( B, the default character set
    '\x1b[1;2H', // cursor position
    '\x9b31m', // 8-bit CSI
  ];
  assert.equal(stripControl(`hello${codes.join('')} world`), 'hello world');
  assert.equal(stripControl('no codes here'), 'no codes here');
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
    env: isolatedEnv(),
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
      env: isolatedEnv(),
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
    'dispatch 33x33x6 [compute fedcba9876543210] | fedcba9876543210: u4=0x1 [heap 1: null]';
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
        'dispatch 33x33x6 [compute fedcba9876543210] | fedcba9876543210: u4=0x1 [heap 1: null]',
      '',
    ].join('\n'),
  );

  const result = spawnSync(process.execPath, [path.join(here, 'summarize-run.mjs'), log], {
    encoding: 'utf8',
    env: isolatedEnv(),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /stopped at command 250\/552 \(op 5\): pipeline unknown \(no marker\)/);
  assert.equal(result.stdout.includes('fedcba9876543210'), false, result.stdout);
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

test('a log with no closing harness line is cut short, not "no failure line"', () => {
  assert.deepEqual(parseExtras(['2026-11-24T12:00:00.000000Z  INFO game: a frame'], null, null).ending, {
    kind: 'log_cut_short',
    seconds: null,
    frame: null,
    text: 'log cut short: no closing harness line',
  });
  // The harness's own end markers count as a closing line.
  for (const line of [
    'harness: victory exit=1',
    'harness: ended by --heavy-seconds after 30 s of heavy scene',
    'harness: ended by --settled-timeout after 600 s: the scene never settled',
    'harness: ended: disk below 5 GB',
  ]) {
    assert.notEqual(parseExtras([line], null, null).ending.kind, 'log_cut_short', line);
  }
});

test('the free-space guard end line is its own ending', () => {
  assert.deepEqual(parseExtras(['harness: ended: disk below 5 GB'], null, null).ending, {
    kind: 'disk_low',
    seconds: null,
    frame: null,
    text: 'ended: disk below 5 GB',
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
    env: isolatedEnv(),
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

const quietStart = 'harness: load at start: cpu 4% over 5 s, free memory 42.1 GB of 63.8, commit 38.2 of 64.0 GB, builders 0';
const quietEnd = 'harness: load at end: cpu 7% over 5 s, free memory 40.0 GB of 63.8, commit 39.0 of 64.0 GB, builders 0';

test('the load lines give the summary a comparable verdict', () => {
  assert.equal(parseLogLines([quietStart, quietEnd], 'run.log').summary.comparable, 'yes');
  assert.equal(
    parseLogLines(['harness: load at start: cpu 41% over 5 s, free memory 42.1 GB of 63.8, commit 38.2 of 64.0 GB, builders 0', quietEnd], 'run.log')
      .summary.comparable,
    'no (cpu 41% is over 25% at start)',
  );
  assert.equal(
    parseLogLines([quietStart, 'harness: load at end: cpu 7% over 5 s, free memory 9.2 GB of 63.8, commit 39.0 of 64.0 GB, builders 2'], 'run.log')
      .summary.comparable,
    'no (free memory 9.2 GB is under 12 GB at end; 2 builders is over 0 at end)',
  );
  assert.equal(parseLogLines([], 'run.log').summary.comparable, 'unknown (no load lines)');
});

test('the comparable thresholds are variables with the documented defaults', () => {
  const hot = 'harness: load at start: cpu 41% over 5 s, free memory 42.1 GB of 63.8, commit 38.2 of 64.0 GB, builders 0';
  const parsed = parseLogLines([hot, quietEnd], 'run.log', {
    env: { HARNESS_MAX_CPU: '50', HARNESS_MIN_FREE_MEM_GB: '12', HARNESS_MAX_BUILDERS: '0' },
  });
  assert.equal(parsed.summary.comparable, 'yes');
  assert.deepEqual(parsed.summary.load.limits, { maxCpu: 50, minFreeMemGb: 12, maxBuilders: 0 });
  assert.equal(parsed.summary.load.start.cpu, 41);
});

const OLD_FRAME =
  '2026-11-24T12:00:00.000000Z  INFO victory_gpu::host: 30.0 fps, 33.3 ms/frame ' +
  '(0.2 preparing: copies 0.1 ms 0.2 MB, textures 0.0 ms 0.0 MB; 0.9 on the GPU; ' +
  '0.0 copying back 0.0 MB), 12 draws/frame, dropped 0 without a host pipeline (0 being made) and 1 indirect';
// The text the runtime's frame-line format writes from job/honest-counters on, colour codes included.
const NEW_FRAME_COLOURED =
  '\x1b[2m2026-11-26T05:02:11.250000Z\x1b[0m \x1b[32m INFO\x1b[0m ' +
  '\x1b[2mvictory_gpu::host\x1b[0m\x1b[2m:\x1b[0m ' +
  'frame 18432, 27.4 fps, 36.5 ms/frame (0.4 preparing: copies 0.3 ms 1.2 MB, ' +
  'textures hashed 0.2 ms 0.1 MB; 1.7 on the GPU; 0.1 copying back 0.9 MB merged into ' +
  "title memory (host time, fetches included), 0.0 MB fetched from copies in the card's memory), " +
  '5000 draws/frame, dropped 3 without a host pipeline (1 being made) and 7 indirect';
const presentLine = (frame) =>
  `2026-11-24T12:00:00.500000Z  INFO victory_gpu::queue: frame presented (since the last line: draws and ` +
  `dispatches, and those run on the host) frame=${frame} draws=12 drawn=12 dispatches=0 dispatched=0`;

test('frame line: the old form parses, and its last presented frame is the present line fallback', () => {
  const { summary } = parseLogLines([OLD_FRAME, presentLine(8192)], 'old.log');
  const line = summary.lastFrameLine;
  assert.equal(line.frame, null);
  assert.equal(line.fps, 30);
  assert.equal(line.ms, 33.3);
  assert.equal(line.draws, 12);
  assert.equal(line.dropped, 0);
  assert.equal(line.making, 0);
  assert.equal(line.indirect, 1);
  assert.equal(line.texturesMs, 0);
  assert.equal(line.texturesMb, 0);
  assert.equal(summary.lastFrame.frame, 8192);
  assert.equal(summary.lastFrame.draws, 12);
});

test('frame line: the new form parses its frame number and "textures hashed" figures', () => {
  const { summary } = parseLogLines([stripControl(NEW_FRAME_COLOURED)], 'new.log');
  const line = summary.lastFrameLine;
  assert.equal(line.frame, 18432);
  assert.equal(line.fps, 27.4);
  assert.equal(line.ms, 36.5);
  assert.equal(line.draws, 5000);
  assert.equal(line.dropped, 3);
  assert.equal(line.making, 1);
  assert.equal(line.indirect, 7);
  assert.equal(line.preparing, 0.4);
  assert.equal(line.copiesMs, 0.3);
  assert.equal(line.copiesMb, 1.2);
  assert.equal(line.texturesMs, 0.2);
  assert.equal(line.texturesMb, 0.1);
  assert.equal(line.gpuMs, 1.7);
  assert.equal(line.backMs, 0.1);
  assert.equal(line.backMb, 0.9);
  // No "frame presented" line is needed: the frame line carries the count itself.
  assert.equal(summary.lastFrame.frame, 18432);
  assert.equal(summary.lastFrame.draws, null);
});

test('a log mixing both frame-line forms parses, and the newest numbered line wins', () => {
  const mixed = parseLogLines(
    [OLD_FRAME, presentLine(8192), stripControl(NEW_FRAME_COLOURED), OLD_FRAME],
    'mixed.log',
  ).summary;
  assert.equal(mixed.fps.samples, 3);
  assert.equal(mixed.lastFrameLine.frame, null, 'the last line is the old form');
  assert.equal(mixed.lastFrame.frame, 18432, 'the newest numbered line, not the old present line');
});

// The copystat lines exactly as copystat.rs formats them, old and new.
const OLD_COPIES =
  '2026-11-25T04:17:12.475238Z  INFO victory_gpu::copystat: copies per frame: 1.0 submissions; ' +
  '2 title copies 3.0 MB; table fills 4.0 MB asked, 5.0 MB filled in 0.10 ms; 6 refreshes 7.0 MB, ' +
  '8 skipped 9.0 MB; 10 runs 0.20 ms; 11 queries 0.30 ms, moves 0.40 ms, 12.0 MB unmapped; ' +
  '13 page faults; 14 watches 0.50 ms (1 failed 0.01 ms), 15.0 MB checked, 16.0 MB unchanged; ' +
  '18 fallbacks; 19 guard faults; 20 idle copies kept, 21 let go by pressure; textures 22.0 MB watched ' +
  'and changed, 23.0 MB hashed, 24.0 MB of them changed';
const NEW_COPIES =
  '2026-11-26T05:02:11.800000Z  INFO victory_gpu::copystat: copies per frame: 1.0 submissions; ' +
  '2 title copies 3.0 MB; table fills 4.0 MB asked, 5.0 MB filled in 0.10 ms; ' +
  'descriptor-copy sync 0.25 ms (12 records); 6 refreshes 7.0 MB, 8 skipped 9.0 MB; ' +
  '10 runs 0.20 ms; 11 queries 0.30 ms, moves 0.40 ms, 12.0 MB unmapped; 13 page faults; ' +
  '14 watches 0.50 ms (1 failed 0.01 ms), 15.0 MB asked about (repeats counted), 16.0 MB unchanged, ' +
  '17 distinct pages since the last present; 18 fallbacks; 19 guard faults; 20 idle copies kept, ' +
  '21 let go by pressure; textures 22.0 MB watched and changed, 23.0 MB hashed, 24.0 MB of them changed';
const OLD_RECORDING =
  '2026-11-25T04:17:12.475238Z  INFO victory_gpu::copystat: recording per frame (105 frames): ' +
  '29 list calls 4.6 ms (all recording threads); 0.0 ms waiting for pipelines; dynamic slots: ' +
  '3 tables asked, 0 refused, 0.0 ms searching; notes 0.0 ms; shader-written ranges: 0 steps in ' +
  '0 submissions, snapshots 0.0 ms, 0.0 MB compared back; sparse reads 0.0 ms; guards 0.7 ms; ' +
  '0.0 MB copied whole (memory not watched); 0.0 frame waits sleeping 0.0 ms (all threads); ' +
  'ranges of shaders that cannot store to buffers: 0 steps 0.0 MB left out';
const NEW_RECORDING =
  '2026-11-26T05:02:11.800000Z  INFO victory_gpu::copystat: recording per frame (105 frames): ' +
  '29 list calls 4.6 ms (all recording threads); 0.0 ms waiting for pipelines; dynamic slots: ' +
  '3 tables asked, 0 refused, 0.0 ms searching; notes 0.0 ms; shader-written ranges: 0 steps in ' +
  '0 submissions, snapshots 0.0 ms, 0.0 MB compared back; sparse reads 0.0 ms; ' +
  "42 guards in 0.7 ms (the fault handler's included); 0.0 MB copied whole (memory not watched); " +
  '0.0 frame waits sleeping 0.0 ms (all threads); ranges of shaders that cannot store to buffers: ' +
  '0 steps 0.0 MB left out';

test('copy stats: the old "MB checked" and "guards X ms" forms parse', () => {
  const { summary } = parseLogLines([OLD_COPIES, OLD_RECORDING], 'old-copystat.log');
  assert.deepEqual(summary.copyStats, {
    descriptorCopySyncMs: null,
    descriptorCopyRecords: null,
    distinctPages: null,
    guardCount: null,
    guardsMs: 0.7,
    askedAboutMb: 15,
  });
});

test('copy stats: the new forms parse the distinct pages, guard count and descriptor-copy sync', () => {
  const { summary } = parseLogLines([NEW_COPIES, NEW_RECORDING], 'new-copystat.log');
  assert.deepEqual(summary.copyStats, {
    descriptorCopySyncMs: 0.25,
    descriptorCopyRecords: 12,
    distinctPages: 17,
    guardCount: 42,
    guardsMs: 0.7,
    askedAboutMb: 15,
  });
});

test('copy stats: a log mixing the two copystat forms fills what each line carries', () => {
  const oldThenNew = parseLogLines([OLD_COPIES, NEW_RECORDING], 'mixed-copystat.log').summary;
  assert.equal(oldThenNew.copyStats.descriptorCopySyncMs, null);
  assert.equal(oldThenNew.copyStats.distinctPages, null);
  assert.equal(oldThenNew.copyStats.guardCount, 42, 'the new recording line');
  assert.equal(oldThenNew.copyStats.askedAboutMb, 15, 'the old "MB checked"');
  const newThenOld = parseLogLines([NEW_COPIES, OLD_RECORDING], 'mixed-copystat.log').summary;
  assert.equal(newThenOld.copyStats.descriptorCopySyncMs, 0.25);
  assert.equal(newThenOld.copyStats.distinctPages, 17);
  assert.equal(newThenOld.copyStats.guardCount, null);
  assert.equal(newThenOld.copyStats.guardsMs, 0.7, 'the old "guards X ms"');
});

test('observers and the switches set are read from their start-up lines', () => {
  const lines = [
    '2026-11-26T05:02:10.000000Z  INFO victory_gpu::host: observers on: the debug layer, ' +
      'GPU-based validation, DRED, GPU timing, the memory map walk, the counting allocator',
    '2026-11-26T05:02:10.100000Z  INFO victory_gpu::switches: diagnostic switch set ' +
      'switch=VICTORY_D3D12_DEBUG value=1 on=true',
    '2026-11-26T05:02:10.200000Z  INFO victory_gpu::switches: diagnostic switch set ' +
      'switch=VICTORY_MEMORY_MAP value=0 on=false',
  ];
  const { summary } = parseLogLines(lines, 'observers.log');
  assert.deepEqual(summary.observers, [
    'the debug layer',
    'GPU-based validation',
    'DRED',
    'GPU timing',
    'the memory map walk',
    'the counting allocator',
  ]);
  assert.deepEqual(summary.switches, [
    { name: 'VICTORY_D3D12_DEBUG', value: '1', on: true },
    { name: 'VICTORY_MEMORY_MAP', value: '0', on: false },
  ]);
});

test('a log without the observers or switch lines reports none of them', () => {
  const { summary } = parseLogLines([OLD_FRAME], 'plain.log');
  assert.equal(summary.observers, null);
  assert.deepEqual(summary.switches, []);
  assert.equal(summary.copyStats, null);
});

test('the speed work\'s "buffer copies per frame" line is not taken for a copystat line', () => {
  const bufferCopies =
    '2026-11-25T00:00:00.000000Z  INFO victory_gpu::host: buffer copies per frame: 5 on the card ' +
    'from host copies (2.0 MB), 1 read from title memory on the CPU (1.0 MB: the switch off 0), ' +
    '4 of them settled the flights in the air (0.8 MB)';
  const { summary } = parseLogLines([bufferCopies], 'buffer.log');
  assert.equal(summary.copyStats, null);
});

test('device removal: "after logged frame" uses the frame line number when the build prints it', () => {
  const removal =
    '2026-11-26T05:02:20.000000Z ERROR victory_gpu::host: host GPU device removed after a submission of 2 lists';
  const { summary, firstTs, lastTs } = parseLogLines([OLD_FRAME, presentLine(8192), stripControl(NEW_FRAME_COLOURED), removal], 'removed.log');
  assert.equal(summary.lastFrame.frame, 18432);
  assert.equal(parseExtras([OLD_FRAME, presentLine(8192), stripControl(NEW_FRAME_COLOURED), removal], firstTs, lastTs).ending.frame, 18432);
});

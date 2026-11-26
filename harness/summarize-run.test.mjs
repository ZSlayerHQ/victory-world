import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './test-isolation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'summarize-run.mjs');
const TS = '2026-11-25T00:00:00.000000Z  INFO victory_gpu::host: ';
const REASON = 'feeds or traces ray-tracing structures, which are not built; left out';

function frame({ fps = 30, ms = 33.4, draws = 5000, dropped = 0 } = {}) {
  return (
    `${TS}${fps} fps, ${ms} ms/frame (0.3 preparing: copies 0.1 ms 0.1 MB, textures 0.0 ms 0.0 MB; ` +
    `0.0 on the GPU; 0.0 copying back 0.0 MB), ${draws} draws/frame, dropped ${dropped} without a host pipeline ` +
    `(0 being made) and 0 indirect; heap buffers 0.0 passes 0.0 ms; texture slots written so far: 1 placed, ` +
    `1 of objects; textures picked by index: 1 uploaded so far (1 MB), 0 waiting, 0 passed over unmapped`
  );
}

function fixture(t, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'summarize-run-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'run.log');
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test("tonight's new lines reach the summary's sections", (t) => {
  const log = fixture(t, [
    'harness: settled at 75 s (waiting 40, 2.4 fps)',
    frame({ ms: 300 }),
    `${TS}host capabilities: gpu_upload_heaps=1 enhanced_barriers=1 tiled_tier=1 binding_tier=1 dedicated_video_bytes=1 local_budget_bytes=1`,
    // From the specified format: no thread clock in a log yet.
    `${TS}card clock threads: frame=1.0 | "victory-copy" 100.0 1.0 30.0 | "quiet" 2.0 0.0 1.0 | other 5.0 1.0 2.5 | total 107.0 2.0 33.5`,
    frame({ ms: 320 }),
    `${TS}card clock threads: frame=2.0 | "victory-copy" 120.0 1.0 30.0 | "quiet" 2.0 0.0 1.0 | other 5.0 1.0 2.5 | total 127.0 2.0 33.5`,
    `${TS}table constants per frame (VICTORY_TABLE_CONSTANTS=1): 13 read in place, 2 copied (memory read in place 0, no copy or past it 0, off 16 bytes in its copy 2, in pages rewritten under a reader 0); 0.0 refreshes waited 0.0 ms for a submission reading constants in place`,
    // From the specified format: not yet in a log.
    `${TS}buffer copies per frame: 5 on the card from host copies (2.0 MB), 1 read from title memory on the CPU (1.0 MB: the switch off 0, off 4 bytes 1, no host copy holding an end 0, memory the card reads in place 0, overlapping ends 0, no copy pipeline 0), 4 of them settled the flights in the air (0.8 MB)`,
    `${TS}submissions sent ahead per frame: 3.7 in 1.5 settles (0.0 flights each time), 120.0 ms waiting for the card in them; settled for: title memory read 8.0 (by a buffer copy 5.0, a fill of upload memory 2.0, a texture 1.0); 0.0 waits for memory values met by a flight's bottom-of-pipe write, 1.4 fence signals set behind flights`,
    `${TS}of the waiting for the card in settles, per frame, by what settled: a synchronous submission or present 0.5 ms, the card had run them 1.0, a wait for a memory value 0.0, title memory changed under shader writes 2.0, title memory read 7.0, a step of ours 0.0, lists in the air 0.0, bottom-of-pipe writes 0.0, a blocking fence wait 0.0`,
    `${TS}dropped 10.0/frame without a host pipeline: ${REASON}`,
  ]);
  const result = spawnSync(process.execPath, [script, log], { encoding: 'utf8', env: isolatedEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Pipeline health/);
  assert.match(result.stdout, /- left out:\n {2}- 10\.0 a frame: feeds or traces ray-tracing structures/);
  assert.match(result.stdout, /## Card and CPU per frame/);
  assert.match(result.stdout, /- host capabilities: gpu_upload_heaps=1 /);
  assert.match(result.stdout, /- table constants: 13\.0 read in place, 2\.0 copied/);
  assert.match(result.stdout, /- buffer copies: 5\.0 on the card \(2\.0 MB\), 1\.0 on the CPU \(1\.0 MB\), 4\.0 settled flights \(0\.8 MB\)/);
  assert.match(result.stdout, / {2}- title memory read: 8\.0 a frame, 7\.0 ms\n {4}- by a buffer copy: 5\.0/);
  assert.match(result.stdout, /## Threads/);
  assert.match(result.stdout, /- victory-copy: 111\.0 ms \(30\.0%\)/);
  assert.match(result.stdout, /- total: 119\.0 ms \(33\.5%\)/);
});

test('--json carries the same aggregates', (t) => {
  const log = fixture(t, [
    'harness: settled at 75 s (waiting 40, 2.4 fps)',
    frame({ ms: 300 }),
    `${TS}table constants per frame (VICTORY_TABLE_CONSTANTS=1): 13 read in place, 2 copied (off 16 bytes in its copy 2); 0.0 refreshes waited 0.0 ms`,
    `${TS}dropped 10.0/frame without a host pipeline: ${REASON}`,
  ]);
  const result = spawnSync(process.execPath, [script, log, '--json'], { encoding: 'utf8', env: isolatedEnv() });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.speedLines.tableConstants.inPlace, 13);
  assert.equal(parsed.speedLines.leftOut[REASON], 10);
});

test('a log without the new lines prints none of the new sections', (t) => {
  const log = fixture(t, [frame({ ms: 300 })]);
  const result = spawnSync(process.execPath, [script, log], { encoding: 'utf8', env: isolatedEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('## Card and CPU per frame'), false);
  assert.equal(result.stdout.includes('## Threads'), false);
});

test('the instrument lines reach Run health, and NOT CLEAN is said outright', (t) => {
  const clean = "2520 guards put on, 77 faults taken, 0 guards gone with no fault, 2 pages passed over as a kernel write or the platform layer held them, 0 not armed for their protection, 3 openings around our own kernel copies; the instrument's cost 0.038 ms a frame";
  const log = fixture(t, [
    frame({ ms: 300 }),
    `${TS}null magenta: frame=120 substituted=3 never_made=2 waiting=1 let_go=0 cannot_make=1 unmapped=1 stale=0 left_depth=1 left_integer=0 left_other=0 left_no_view=2 examples=0x10:waiting,0x20:unmapped`,
    `${TS}page shares: kernel 12%, platform 3%; health: ${clean}`,
    `${TS}NOT CLEAN: 4 guards went with no fault (2 unmapped, 2 lost); health: ${clean.replace('0 guards gone with no fault', '4 guards gone with no fault')}`,
  ]);
  const result = spawnSync(process.execPath, [script, log], { encoding: 'utf8', env: isolatedEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Run health/);
  assert.match(result.stdout, /- null magenta: 3\.0 substituted a frame \(worst 3\.0\), 2\.0 never made, 1\.0 waiting/);
  assert.match(result.stdout, /examples: 0x10:waiting, 0x20:unmapped/);
  assert.match(result.stdout, /- first touch: \*\*NOT CLEAN\*\* — 4\.0 guards went with no fault/);
  assert.match(result.stdout, /cost 0\.038 ms a frame/);
});

test('the summary opens with the comparable verdict, and --json carries it', (t) => {
  const quietStart = 'harness: load at start: cpu 4% over 5 s, free memory 42.1 GB of 63.8, commit 38.2 of 64.0 GB, builders 0';
  const quietEnd = 'harness: load at end: cpu 7% over 5 s, free memory 40.0 GB of 63.8, commit 39.0 of 64.0 GB, builders 0';
  const log = fixture(t, [quietStart, frame(), quietEnd, 'harness: victory exit=0']);
  const result = spawnSync(process.execPath, [script, log], { encoding: 'utf8', env: isolatedEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Run summary — .*\ncomparable: yes\n/);

  const json = spawnSync(process.execPath, [script, log, '--json'], { encoding: 'utf8', env: isolatedEnv() });
  assert.equal(json.status, 0, json.stderr);
  const parsed = JSON.parse(json.stdout);
  assert.equal(parsed.comparable, 'yes');
  assert.equal(parsed.load.start.cpu, 4);
  assert.equal(parsed.load.end.builders, 0);
});

test('a busy start makes the summary not comparable, and thresholds can move', (t) => {
  const hotStart = 'harness: load at start: cpu 41% over 5 s, free memory 42.1 GB of 63.8, commit 38.2 of 64.0 GB, builders 0';
  const quietEnd = 'harness: load at end: cpu 7% over 5 s, free memory 40.0 GB of 63.8, commit 39.0 of 64.0 GB, builders 0';
  const log = fixture(t, [hotStart, frame(), quietEnd, 'harness: victory exit=0']);
  const result = spawnSync(process.execPath, [script, log], { encoding: 'utf8', env: isolatedEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Run summary — .*\ncomparable: no \(cpu 41% is over 25% at start\)\n/);

  const moved = spawnSync(process.execPath, [script, log], {
    encoding: 'utf8',
    env: isolatedEnv({ HARNESS_MAX_CPU: '50' }),
  });
  assert.equal(moved.status, 0, moved.stderr);
  assert.match(moved.stdout, /^# Run summary — .*\ncomparable: yes\n/);
});

test('a log without the load lines says the verdict is unknown', (t) => {
  const log = fixture(t, [frame(), 'harness: victory exit=0']);
  const result = spawnSync(process.execPath, [script, log], { encoding: 'utf8', env: isolatedEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# Run summary — .*\ncomparable: unknown \(no load lines\)\n/);
  const json = JSON.parse(
    spawnSync(process.execPath, [script, log, '--json'], { encoding: 'utf8', env: isolatedEnv() }).stdout,
  );
  assert.equal(json.comparable, 'unknown (no load lines)');
});

// The frame line the runtime's format writes from job/honest-counters on, colour codes included.
const NEW_FRAME =
  '\x1b[2m2026-11-26T05:02:11.250000Z\x1b[0m \x1b[32m INFO\x1b[0m ' +
  '\x1b[2mvictory_gpu::host\x1b[0m\x1b[2m:\x1b[0m ' +
  'frame 18432, 27.4 fps, 36.5 ms/frame (0.4 preparing: copies 0.3 ms 1.2 MB, ' +
  'textures hashed 0.2 ms 0.1 MB; 1.7 on the GPU; 0.1 copying back 0.9 MB merged into ' +
  "title memory (host time, fetches included), 0.0 MB fetched from copies in the card's memory), " +
  '5000 draws/frame, dropped 3 without a host pipeline (1 being made) and 7 indirect';
const NEW_COPIES =
  '2026-11-26T05:02:11.800000Z  INFO victory_gpu::copystat: copies per frame: 1.0 submissions; ' +
  '2 title copies 3.0 MB; table fills 4.0 MB asked, 5.0 MB filled in 0.10 ms; ' +
  'descriptor-copy sync 0.25 ms (12 records); 6 refreshes 7.0 MB, 8 skipped 9.0 MB; ' +
  '10 runs 0.20 ms; 11 queries 0.30 ms, moves 0.40 ms, 12.0 MB unmapped; 13 page faults; ' +
  '14 watches 0.50 ms (1 failed 0.01 ms), 15.0 MB asked about (repeats counted), 16.0 MB unchanged, ' +
  '17 distinct pages since the last present; 18 fallbacks; 19 guard faults; 20 idle copies kept, ' +
  '21 let go by pressure; textures 22.0 MB watched and changed, 23.0 MB hashed, 24.0 MB of them changed';
const NEW_RECORDING =
  '2026-11-26T05:02:11.800000Z  INFO victory_gpu::copystat: recording per frame (105 frames): ' +
  '29 list calls 4.6 ms (all recording threads); 0.0 ms waiting for pipelines; dynamic slots: ' +
  '3 tables asked, 0 refused, 0.0 ms searching; notes 0.0 ms; shader-written ranges: 0 steps in ' +
  '0 submissions, snapshots 0.0 ms, 0.0 MB compared back; sparse reads 0.0 ms; ' +
  "42 guards in 0.7 ms (the fault handler's included); 0.0 MB copied whole (memory not watched); " +
  '0.0 frame waits sleeping 0.0 ms (all threads); ranges of shaders that cannot store to buffers: ' +
  '0 steps 0.0 MB left out';
const OBSERVERS =
  '2026-11-26T05:02:10.000000Z  INFO victory_gpu::host: observers on: the debug layer, ' +
  'GPU-based validation, DRED, GPU timing, the memory map walk, the counting allocator';
const SWITCHES =
  '2026-11-26T05:02:10.100000Z  INFO victory_gpu::switches: diagnostic switch set ' +
  'switch=VICTORY_D3D12_DEBUG value=1 on=true';

test('the first lines name the observers, and the new copystat fields reach the summary and --json', (t) => {
  const quietStart = 'harness: load at start: cpu 4% over 5 s, free memory 42.1 GB of 63.8, commit 38.2 of 64.0 GB, builders 0';
  const quietEnd = 'harness: load at end: cpu 7% over 5 s, free memory 40.0 GB of 63.8, commit 39.0 of 64.0 GB, builders 0';
  const log = fixture(t, [quietStart, OBSERVERS, SWITCHES, NEW_FRAME, NEW_COPIES, NEW_RECORDING, quietEnd, 'harness: victory exit=0']);
  const result = spawnSync(process.execPath, [script, log], { encoding: 'utf8', env: isolatedEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /^# Run summary — .*\ncomparable: yes\nobservers on: the debug layer, GPU-based validation, DRED, GPU timing, the memory map walk, the counting allocator\n/,
  );
  assert.match(result.stdout, /switches set: VICTORY_D3D12_DEBUG=1 \(on\)/);
  assert.match(result.stdout, /last presented frame: 18432/);
  assert.match(result.stdout, /Last frame: frame 18432, 36\.5 ms/);
  assert.match(result.stdout, /textures hashed 0\.2 ms \/ 0\.1 MB/);
  assert.match(
    result.stdout,
    /Copy stats: descriptor-copy sync 0\.25 ms \(12 records\), 15\.0 MB asked about, 17 distinct pages since the last present, 42 guards in 0\.7 ms/,
  );

  const json = JSON.parse(
    spawnSync(process.execPath, [script, log, '--json'], { encoding: 'utf8', env: isolatedEnv() }).stdout,
  );
  assert.equal(json.lastFrame.frame, 18432);
  assert.equal(json.lastFrameLine.frame, 18432);
  assert.deepEqual(json.copyStats, {
    descriptorCopySyncMs: 0.25,
    descriptorCopyRecords: 12,
    distinctPages: 17,
    guardCount: 42,
    guardsMs: 0.7,
    askedAboutMb: 15,
  });
  assert.equal(json.descriptorCopySyncMs, 0.25);
  assert.equal(json.descriptorCopyRecords, 12);
  assert.equal(json.distinctPages, 17);
  assert.equal(json.guardCount, 42);
  assert.deepEqual(json.observers, [
    'the debug layer',
    'GPU-based validation',
    'DRED',
    'GPU timing',
    'the memory map walk',
    'the counting allocator',
  ]);
  assert.deepEqual(json.switches, [{ name: 'VICTORY_D3D12_DEBUG', value: '1', on: true }]);
});

test('an old-form log keeps its summary, with the observers line named absent', (t) => {
  const log = fixture(t, [frame(), 'harness: victory exit=0']);
  const result = spawnSync(process.execPath, [script, log], { encoding: 'utf8', env: isolatedEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /observers on: not in the log/);
  const json = JSON.parse(
    spawnSync(process.execPath, [script, log, '--json'], { encoding: 'utf8', env: isolatedEnv() }).stdout,
  );
  assert.equal(json.lastFrameLine.frame, null);
  assert.equal(json.copyStats, null);
  assert.equal(json.observers, null);
  assert.deepEqual(json.switches, []);
});

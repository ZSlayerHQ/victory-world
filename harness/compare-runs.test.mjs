import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'compare-runs.mjs');
const TS = '2026-11-25T00:00:00.000000Z  INFO victory_gpu::host: ';

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function fixture(t, name, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-runs-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${name}.log`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// A frame line in the runtime's format; only the numbers passed in differ from a real one.
function frame({
  fps = 30,
  ms = 33.4,
  preparing = 0.3,
  copiesMs = 0.1,
  copiesMb = 0.1,
  texturesMs = 0.0,
  texturesMb = 0.0,
  gpu = 0.0,
  backMs = 0.0,
  backMb = 0.0,
  draws = 5000,
  dropped = 0,
  making = 0,
  indirect = 0,
  waiting = 0,
} = {}) {
  return (
    `${TS}${fps} fps, ${ms} ms/frame (${preparing} preparing: copies ${copiesMs} ms ${copiesMb} MB, ` +
    `textures ${texturesMs} ms ${texturesMb} MB; ${gpu} on the GPU; ${backMs} copying back ${backMb} MB), ` +
    `${draws} draws/frame, dropped ${dropped} without a host pipeline (${making} being made) and ${indirect} indirect; ` +
    `heap buffers 0.0 passes 0.0 ms; texture slots written so far: 1 placed, 1 of objects; ` +
    `textures picked by index: 1 uploaded so far (1 MB), ${waiting} waiting, 0 passed over unmapped`
  );
}

// The late-submission line: settles, the waiting inside them, and the reasons with their counts.
function ahead({ flights = 3.7, settles = 1.5, waiting = 120.0, reasons = [] } = {}) {
  const list = reasons.map(([reason, n]) => `${reason} ${n}`).join(', ');
  return (
    `${TS}submissions sent ahead per frame: ${flights} in ${settles} settles (0.0 flights each time), ` +
    `${waiting} ms waiting for the card in them; settled for: ${list}; 0.0 waits for memory values met by a ` +
    `flight's bottom-of-pipe write, 1.4 fence signals set behind flights`
  );
}

function refused(stage, hash) {
  return `2026-11-25T00:00:01.000000Z  WARN victory_gpu::pipeline::host: host pipeline refused error=The parameter is incorrect. (0x80070057) shaders=[${stage} ${hash}]`;
}

const SETTLED = 'harness: settled at 75 s (waiting 40, 2.4 fps)';

test('a settled log is measured after its settle line only', (t) => {
  const file = fixture(t, 'settled', [
    frame({ ms: 900, fps: 0.5 }),
    SETTLED,
    frame({ ms: 400, fps: 2.5, draws: 4000, waiting: 700 }),
    frame({ ms: 200, fps: 5, draws: 6000, waiting: 500 }),
    frame({ ms: 300, fps: 3, draws: 5000, waiting: 600 }),
  ]);
  const result = run([`a=${file}`, `b=${file}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| Window \| settled after 75 s \|/);
  assert.match(result.stdout, /\| Frame lines \| 3 \|/);
  assert.match(result.stdout, /\| Frame ms median \| 300.0 \|/);
  assert.match(result.stdout, /\| Frame ms p10 \| 200.0 \|/);
  assert.match(result.stdout, /\| Frame ms p90 \| 400.0 \|/);
  assert.match(result.stdout, /\| Textures waiting median \| 600 \|/);
});

test('without a settle line the heavy frames are used', (t) => {
  const file = fixture(t, 'heavy', [
    frame({ draws: 13, dropped: 0, ms: 33 }),
    frame({ draws: 4000, dropped: 900, ms: 300 }),
    frame({ draws: 5000, dropped: 0, ms: 400 }),
  ]);
  const result = run([`a=${file}`, `b=${file}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| Window \| heavy frames \|/);
  assert.match(result.stdout, /\| Frame lines \| 2 \|/);
  assert.match(result.stdout, /\| Frame ms median \| 350.0 \|/);
});

test('a field one build lacks is blank, and the comparison does not crash', (t) => {
  const full = fixture(t, 'full', [frame({ ms: 300, waiting: 500 }), ahead()]);
  const bare = fixture(t, 'bare', [
    '2026-11-25T00:00:00Z  INFO victory_gpu::host: 3.0 fps, 330.0 ms/frame, 5000 draws/frame, dropped 1 without a host pipeline (0 being made) and 0 indirect',
  ]);
  const result = run([`full=${full}`, `bare=${bare}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| Preparing ms median \| 0.3 \| — \|/);
  assert.match(result.stdout, /\| Textures waiting median \| 500 \| — \|/);
  assert.match(result.stdout, /\| Settles a frame median \| 1.5 \| — \|/);
});

test('ANSI colour codes and CRLF are tolerated', (t) => {
  const plain = fixture(t, 'ansi', [frame({ ms: 250 }), ahead()]);
  const decorated = fixture(t, 'crlf', [`\u001b[32m${frame({ ms: 250 })}\u001b[0m`, `\u001b[2m${ahead()}\u001b[0m`]);
  fs.writeFileSync(decorated, fs.readFileSync(decorated, 'utf8').replace(/\n/g, '\r\n'));
  const result = run([`plain=${plain}`, `decorated=${decorated}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| Frame ms median \| 250.0 \| 250.0 \|/);
  assert.match(result.stdout, /\| Settles a frame median \| 1.5 \| 1.5 \|/);
});

test('the settle reasons are split on their own commas and shown top three by count', (t) => {
  const file = fixture(t, 'reasons', [
    frame(),
    ahead({
      reasons: [
        ['title memory read', '10.0 (by a buffer copy 6.0, a fill of upload memory 3.0, a texture 1.0)'],
        ['a step of ours', 2.0],
        ['title memory changed under shader writes', 5.0],
        ['a wait for a memory value', 1.0],
      ],
    }),
  ]);
  const result = run([`a=${file}`, `b=${file}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /\| Top settle reasons \| title memory read \(10\); title memory changed under shader writes \(5\); a step of ours \(2\) \|/,
  );
  // The breakdown is shown under its reason in the full table, never as a reason of its own.
  assert.match(result.stdout, /\| ↳ a buffer copy \| 6\.0 \|/);
  assert.equal(/^\| a buffer copy \|/m.test(result.stdout), false, 'the breakdown inside parentheses is not a reason');
});

test('refused pipelines are distinct program ids, and the differences name the first run', (t) => {
  const a = fixture(t, 'a', [frame({ ms: 300 }), refused('compute', '0123456789abcdef'), refused('compute', '0123456789abcdef')]);
  const b = fixture(t, 'b', [frame({ ms: 330 }), refused('compute', 'fedcba9876543210'), refused('pixel', '89abcdef01234567')]);
  const result = run([`a=${a}`, `b=${b}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| Refused pipelines \| 1: compute 0123456789abcdef \| 2: compute fedcba9876543210, pixel 89abcdef01234567 \|/);
  assert.match(result.stdout, /\| Difference against a \| b \|/);
  assert.match(result.stdout, /\| Frame ms median \| \+30.0 \(\+10.0%\) \|/);
});

test('the card clock fields are optional rows, medians over the measured window', (t) => {
  const clock = (values) => `2026-11-25T00:00:00.000000Z  INFO victory_gpu::host: card clock: ${values}`;
  const withClock = fixture(t, 'clock', [
    frame({ ms: 300 }),
    clock('sync_ms=10.0 title_ms=50.0 io_read_bytes=1048576 io_read_ops=400 game_vol_free_bytes=267000000000'),
    frame({ ms: 320 }),
    clock('sync_ms=20.0 title_ms=70.0 io_read_bytes=2097152 io_read_ops=600 game_vol_free_bytes=267000000000'),
  ]);
  const without = fixture(t, 'nock', [frame({ ms: 310 })]);
  const result = run([`with=${withClock}`, `without=${without}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| sync_ms median \| 15.0 \| — \|/);
  assert.match(result.stdout, /\| title_ms median \| 60.0 \| — \|/);
  assert.match(result.stdout, /\| io_read_bytes median \| 1572864.0 \| — \|/);
  assert.match(result.stdout, /\| game_vol_free_bytes median \| 267000000000.0 \| — \|/);
  assert.match(result.stdout, /\| cpu_core_pct median \| — \| — \|/);
});

test('a profiled run is flagged and its frame times called out', (t) => {
  const plain = fixture(t, 'plain', [frame({ ms: 300 })]);
  const profiled = fixture(t, 'profiled', [
    'harness: profiled by Nsight GPU Trace; frame times are not comparable',
    frame({ ms: 900 }),
  ]);
  const result = run([`plain=${plain}`, `profiled=${profiled}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| Window \| heavy frames \| heavy frames \(profiled or captured; frame times not comparable\) \|/);
  assert.match(result.stdout, /\| Difference against plain \| profiled \(profiled\) \|/);
});

test("tonight's new lines become rows and sections", (t) => {
  const capabilities = (n) =>
    `${TS}host capabilities: gpu_upload_heaps=${n} enhanced_barriers=1 tiled_tier=1 binding_tier=1 ` +
    `dedicated_video_bytes=8152686592 local_budget_bytes=8000000000`;
  // From the specification (jobs/2026-11-25-card-clock/engineer-report-3.md): the thread clock has not appeared in
  // a log yet.
  const threadLine = (user) =>
    `${TS}card clock threads: frame=1.0 | "victory-copy" ${user} 1.0 30.0 | "quiet" 2.0 0.0 1.0 | ` +
    `other 5.0 1.0 2.5 | total ${user + 7} 2.0 33.5`;
  const table = (inPlace, copied) =>
    `${TS}table constants per frame (VICTORY_TABLE_CONSTANTS=1): ${inPlace} read in place, ${copied} copied ` +
    `(memory read in place 0, no copy or past it 0, off 16 bytes in its copy ${copied}, in pages rewritten under ` +
    `a reader 0); 0.0 refreshes waited 0.0 ms for a submission reading constants in place`;
  // From the specification (jobs/2026-11-25-card-copies/engineer-report.md): not yet in a log.
  const copies = (onCard, onCpu) =>
    `${TS}buffer copies per frame: ${onCard} on the card from host copies (2.0 MB), ${onCpu} read from title ` +
    `memory on the CPU (1.0 MB: the switch off 0, off 4 bytes ${onCpu}, no host copy holding an end 0, memory the ` +
    `card reads in place 0, overlapping ends 0, no copy pipeline 0), 4 of them settled the flights in the air (0.8 MB)`;
  const settleMs = (readMs) =>
    `${TS}of the waiting for the card in settles, per frame, by what settled: a synchronous submission or present ` +
    `0.5 ms, the card had run them 1.0, a wait for a memory value 0.0, title memory changed under shader writes ` +
    `2.0, title memory read ${readMs}, a step of ours 0.0, lists in the air 0.0, bottom-of-pipe writes 0.0, ` +
    `a blocking fence wait 0.0`;
  const leftOut = (n, reason) => `${TS}dropped ${n}/frame without a host pipeline: ${reason}`;
  const REASON = 'feeds or traces ray-tracing structures, which are not built; left out';
  const log = fixture(t, 'new-lines', [
    capabilities(1),
    frame({ ms: 300 }),
    threadLine(100.0),
    table(12, 3),
    copies(5, 2),
    ahead({
      reasons: [
        ['title memory read', '10.0 (by a buffer copy 6.0, a fill of upload memory 3.0, a texture 1.0)'],
        ['256 lists in the air', 4.0],
      ],
    }),
    settleMs('8.0'),
    leftOut(12.0, REASON),
    frame({ ms: 320 }),
    threadLine(120.0),
    table(14, 1),
    copies(6, 1),
    ahead({
      reasons: [
        ['title memory read', '6.0 (by a buffer copy 4.0, a fill of upload memory 1.0, a texture 1.0)'],
        ['256 lists in the air', 2.0],
      ],
    }),
    settleMs('6.0'),
    leftOut(8.0, REASON),
  ]);
  const result = run([`a=${log}`, `b=${log}`]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\| host capabilities \| gpu_upload_heaps=1 /);
  assert.match(result.stdout, /\| Table constants read in place a frame \| 13\.0 \|/);
  assert.match(result.stdout, /\| Table constants copied a frame \| 2\.0 \|/);
  assert.match(result.stdout, /\| Buffer copies on the card a frame \| 5\.5 \|/);
  assert.match(result.stdout, /\| Buffer copies on the CPU a frame \| 1\.5 \|/);
  assert.match(result.stdout, /\| Buffer copies that settled flights a frame \| 4\.0 \|/);
  // A reason's count and its milliseconds join across the two lines, though the late line also writes a leading
  // list count ("256 lists in the air") the milliseconds line does not.
  assert.match(result.stdout, /\| title memory read \| 8\.0 a frame, 7\.0 ms \|/);
  assert.match(result.stdout, /\| lists in the air \| 3\.0 a frame, 0\.0 ms \|/);
  assert.match(result.stdout, /\| ↳ a buffer copy \| 5\.0 \|/);
  assert.match(result.stdout, /\| feeds or traces ray-tracing structures, which are not built; left out \| 10\.0 a frame \|/);
  assert.match(result.stdout, /\| victory-copy \| 111\.0 ms \(30\.0%\) \|/);
  const parsed = JSON.parse(run([`a=${log}`, `b=${log}`, '--json']).stdout);
  assert.equal(parsed.runs[0].fields.tableInPlace, 13);
  assert.equal(parsed.runs[0].fields.bufferOnCard, 5.5);
  assert.match(parsed.runs[0].capabilities, /^gpu_upload_heaps=1 /);
  assert.equal(parsed.runs[0].settleReasons['title memory read'].count, 8);
  assert.equal(parsed.runs[0].settleReasons['title memory read'].ms, 7);
  assert.equal(parsed.runs[0].settleReasons['title memory read'].by['a buffer copy'], 5);
  assert.equal(parsed.runs[0].leftOut[REASON], 10);
  assert.equal(parsed.runs[0].threads.named['victory-copy'].user, 110);
});

test('--json prints the same numbers as objects', (t) => {
  const a = fixture(t, 'a', [frame({ ms: 300 }), ahead()]);
  const b = fixture(t, 'b', [frame({ ms: 330 }), ahead()]);
  const result = run([`a=${a}`, `b=${b}`, '--json']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.runs.length, 2);
  assert.equal(parsed.runs[0].fields.ms, 300);
  assert.equal(parsed.runs[1].fields.settles, 1.5);
  assert.deepEqual(parsed.differences[0].fields['Frame ms median'], { absolute: 30, percent: 10 });
});

test('the command line refuses one log, and reports a file it cannot read', (t) => {
  let result = run(['only-one.log']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /usage:/);
  result = run(['a=/nowhere/a.log', 'b=/nowhere/b.log']);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /compare-runs: /);
  result = run(['a=x.log', 'b=y.log', '--nope']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /unknown argument --nope/);
});

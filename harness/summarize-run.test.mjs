import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

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
  const result = spawnSync(process.execPath, [script, log], { encoding: 'utf8' });
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
  const result = spawnSync(process.execPath, [script, log, '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.speedLines.tableConstants.inPlace, 13);
  assert.equal(parsed.speedLines.leftOut[REASON], 10);
});

test('a log without the new lines prints none of the new sections', (t) => {
  const log = fixture(t, [frame({ ms: 300 })]);
  const result = spawnSync(process.execPath, [script, log], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('## Card and CPU per frame'), false);
  assert.equal(result.stdout.includes('## Threads'), false);
});

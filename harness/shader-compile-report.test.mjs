import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { asJson, missing, parse, parsePrograms, report } from './shader-compile-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'shader-compile-report.mjs');

function tempFile(t, name, lines) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shader-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

// Synthetic lines in the exact format `victory translate` prints.
const WARM = [
  'progress total programs=26148 containers=25985',
  'progress translated 25654 of 26148 refused=494 failed_validation=213',
  'containers   1234 (7 duplicates skipped)',
  'programs     25654 translated of 26148 (5151 IR instructions)',
  'DXIL         25000 emitted of 25500 vertex and pixel programs; 24900 validated, 24100 pipelines',
  '             500 emitted of 600 compute programs; 495 validated, 480 pipelines',
  '             54 emitted of 48 mesh programs; 46 validated, 44 pipelines',
  '    120  Unsupported instruction at 0x1c: v_writelane_b32  (e.g. PS_abc123)',
  '     42  A lane permute across two host waves  (e.g. compute 0123456789abcdef)',
  '     7  Shader bytecode ends before a literal  (e.g. VS_dead)',
];

test('the totals, stage table and ranked reasons come from the summary lines', (t) => {
  const file = tempFile(t, 'run.log.warm', WARM);
  const parsed = parse(file);
  assert.equal(parsed.containers, 1234);
  assert.equal(parsed.duplicates, 7);
  assert.equal(parsed.programs, 26148);
  assert.equal(parsed.translated, 25654);
  assert.deepEqual(parsed.vertexPixel, { emitted: 25000, programs: 25500, validated: 24900, pipelines: 24100 });
  assert.deepEqual(parsed.reasons.map((r) => r.count), [120, 42, 7]);
  const text = report(parsed);
  assert.match(text, /25654 translated of 26148 \(98\.1%\), 494 refused/);
  assert.match(text, /\| vertex \+ pixel \| 25500 \| 25000 \| 24900 \| 100 \| 24100 \|/);
  assert.match(text, /\| mesh \| 48 \| 54 \| 46 \| 8 \| 44 \|/);
  assert.match(text, /\| 120 \| Unsupported instruction at 0x1c: v_writelane_b32 \| PS_abc123 \|/);
});

test('--public drops the program names but keeps counts and reasons', (t) => {
  const file = tempFile(t, 'run.log.warm', WARM);
  const public_ = report(parse(file), { public: true });
  assert.equal(public_.includes('PS_abc123'), false);
  assert.match(public_, /\| 120 \| Unsupported instruction at 0x1c: v_writelane_b32 \| — \|/);
  const json = asJson(parse(file), { public: true });
  assert.equal(json.reasons[0].example, null);
});

test('a run log supplies the warm-up time and exit code', (t) => {
  const warm = tempFile(t, 'run.log.warm', WARM);
  const main = tempFile(t, 'run.log', ['warm-up: exit=0 after 812 s', 'harness env: x=1']);
  const parsed = parse(warm, main);
  assert.equal(parsed.warmExit, 0);
  assert.equal(parsed.warmSeconds, 812);
  assert.match(report(parsed), /warm-up: exit 0, 812 s/);
});

const PROGRAMS = [
  'name\tstage\toutcome\treason\tms\tdxil_bytes',
  'VS_a\tvertex\ttranslated\t\t3.2\t1000',
  'PS_b\tpixel\ttranslated\t\t10.5\t2000',
  'CS_c\tcompute\tfailed_validation\tshader must be launched with wave size 64\t8.0\t3000',
  'CS_d\tcompute\trefused\tUnsupported instruction at 0x1c: v_writelane_b32\t1.0\t0',
  'MS_e\tmesh\trefused\tUnsupported instruction at 0x1c: v_writelane_b32\t1.5\t0',
  'VS_f\tvertex\ttranslated\t\t0.5\t900',
];
const SMALL = [
  'progress total programs=6 containers=2',
  'progress translated 4 of 6 refused=2 failed_validation=1',
  'containers   2 (0 duplicates skipped)',
  'programs     4 translated of 6 (10 IR instructions)',
];

test('the progress lines give the refused and failed-validation counts and the pack total', (t) => {
  const parsed = parse(tempFile(t, 'run.log.warm', WARM));
  assert.equal(parsed.packPrograms, 26148);
  assert.equal(parsed.packContainers, 25985);
  assert.equal(parsed.refusedNow, 494);
  assert.equal(parsed.failedValidationNow, 213);
  const text = report(parsed);
  assert.match(text, /- failed validation: 213/);
  assert.match(text, /494 refused/);
  assert.equal(missing(parsed).join(' ').includes('a pack total printed'), false);
});

test('the report file gives vertex and pixel separately, every cause, and the slowest ten', (t) => {
  const warm = tempFile(t, 'run.log.warm', SMALL);
  const programs = tempFile(t, 'translate-report.txt', PROGRAMS);
  const rows = parsePrograms(programs);
  assert.equal(rows.length, 6);
  assert.deepEqual(rows[0], { name: 'VS_a', stage: 'vertex', outcome: 'translated', reason: '', ms: 3.2, dxilBytes: 1000 });
  const text = report(parse(warm), { programs: rows });
  assert.match(text, /\| vertex \| 2 \| 2 \| 0 \| 0 \|/);
  assert.match(text, /\| pixel \| 1 \| 1 \| 0 \| 0 \|/);
  assert.match(text, /\| compute \| 2 \| 0 \| 1 \| 1 \|/);
  assert.match(text, /\| mesh \| 1 \| 0 \| 1 \| 0 \|/);
  assert.match(text, /\| all \| 6 \| 3 \| 2 \| 1 \|/);
  // Both v_writelane refusals are one cause with two programs, not one example.
  assert.match(text, /\| 2 \| refused \| Unsupported instruction at 0x1c: v_writelane_b32 \| CS_d \|/);
  assert.match(text, /\| 1 \| failed_validation \| shader must be launched with wave size 64 \| CS_c \|/);
  assert.match(text, /\| 1 \| PS_b \| pixel \| translated \| 10\.5 \|/);
  assert.match(text, /\| 2 \| CS_c \| compute \| failed_validation \| 8 \|/);
  assert.doesNotMatch(text, /they disagree/);
});

test('a report file without a header is read in the stated column order', (t) => {
  const programs = tempFile(t, 'translate-report.txt', PROGRAMS.slice(1));
  const rows = parsePrograms(programs);
  assert.equal(rows.length, 6);
  assert.equal(rows[2].outcome, 'failed_validation');
});

test('a log and report file that count different programs say so', (t) => {
  const warm = tempFile(t, 'run.log.warm', SMALL);
  const programs = tempFile(t, 'translate-report.txt', PROGRAMS.slice(0, 3));
  const text = report(parse(warm), { programs: parsePrograms(programs) });
  assert.match(text, /the log says 4 translated; the report file has 2 rows that translated: they disagree/);
});

test('--programs on the command line prints the tables and --public hides the names', (t) => {
  const warm = tempFile(t, 'run.log.warm', SMALL);
  const programs = tempFile(t, 'translate-report.txt', PROGRAMS);
  let result = spawnSync(process.execPath, [script, warm, '--programs', programs], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Programs \(from the report file\)/);
  assert.match(result.stdout, /VS_a/);
  result = spawnSync(process.execPath, [script, warm, '--programs', programs, '--public'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.includes('VS_a'), false);
  assert.match(result.stdout, /Unsupported instruction at 0x1c: v_writelane_b32/);
});

test('what the log does not state is listed for the engineer', (t) => {
  const parsed = parse(tempFile(t, 'run.log.warm', WARM));
  const gaps = missing(parsed).join(' ');
  assert.match(gaps, /vertex and pixel programs separately/);
  assert.match(gaps, /per-program lines/);
  assert.match(gaps, /pipeline failures in warm mode/);
  assert.match(gaps, /total time inside the warm log/);
});

test('the command prints the report and refuses unknown arguments', (t) => {
  const warm = tempFile(t, 'run.log.warm', WARM);
  let result = spawnSync(process.execPath, [script, warm], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /## Shader translate/);
  assert.match(result.stdout, /Missing from the log:/);
  result = spawnSync(process.execPath, [script, warm, '--json'], { encoding: 'utf8' });
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.refused, 494);
  result = spawnSync(process.execPath, [script, '--nope'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
});

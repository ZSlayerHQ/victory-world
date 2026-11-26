import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { causes, readBaseline, regressions, report } from './shader-ratchet.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'shader-ratchet.mjs');
const HEADER = 'name\tstage\toutcome\treason\tms\tdxil_bytes';

function tsv(rows) {
  return [HEADER, ...rows.map(([name, stage, outcome, reason]) => `${name}\t${stage}\t${outcome}\t${reason}\t1.0\t0`)].join('\n') + '\n';
}

function fixture(t, name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shader-ratchet-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return file;
}

test('the causes count failing programs by outcome and reason', () => {
  const counts = causes([
    { outcome: 'refused', reason: 'a texture slot chosen by an if/else' },
    { outcome: 'refused', reason: 'a texture slot chosen by an if/else' },
    { outcome: 'failed_validation', reason: 'shader must be launched with wave size 64' },
    { outcome: 'translated', reason: '' },
  ]).counts;
  assert.equal(counts.get('refused: a texture slot chosen by an if/else'), 2);
  assert.equal(counts.get('failed_validation: shader must be launched with wave size 64'), 1);
  assert.equal(counts.size, 2);
});

test('a regression is a cause made worse or newly present; smaller and gone causes are fine', () => {
  const baseline = { counts: { 'refused: a': 2, 'refused: b': 1, 'refused: gone': 4 } };
  const now = new Map([
    ['refused: a', 1],
    ['refused: b', 3],
    ['refused: new', 1],
  ]);
  const worse = regressions(baseline, now);
  assert.deepEqual(worse.map((w) => [w.cause, w.before, w.now]), [
    ['refused: b', 1, 3],
    ['refused: new', 0, 1],
  ]);
  assert.equal(regressions(baseline, new Map([['refused: a', 1], ['refused: gone', 2]])).length, 0);
});

test('the table names each cause with its baseline and change', () => {
  const text = report({ counts: { 'refused: a': 2 } }, new Map([['refused: a', 3], ['refused: b', 1]]));
  assert.match(text, /\| 3 \| refused: a \| 2 \| \+1 \|/);
  assert.match(text, /\| 1 \| refused: b \| 0 \| \+1 \|/);
  assert.match(text, /failing programs: 4/);
});

test('check passes on an equal or smaller cause and fails on a worse one', (t) => {
  const baseline = fixture(t, 'baseline.json', JSON.stringify({ counts: { 'refused: a': 2, 'refused: b': 1 } }));
  const better = fixture(t, 'better.txt', tsv([['VS_1', 'vertex', 'refused', 'a']]));
  let result = spawnSync(process.execPath, [script, 'check', '--programs', better, '--baseline', baseline], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /no cause made worse/);

  const worse = fixture(t, 'worse.txt', tsv([['VS_1', 'vertex', 'refused', 'a'], ['VS_2', 'vertex', 'refused', 'a'], ['VS_3', 'vertex', 'refused', 'a']]));
  result = spawnSync(process.execPath, [script, 'check', '--programs', worse, '--baseline', baseline], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /regressed: refused: a: 2 -> 3/);
});

test('a cause the baseline does not know is a regression too', (t) => {
  const baseline = fixture(t, 'baseline.json', JSON.stringify({ counts: { 'refused: a': 1 } }));
  const now = fixture(t, 'now.txt', tsv([['VS_1', 'vertex', 'refused', 'brand new']]));
  const result = spawnSync(process.execPath, [script, 'check', '--programs', now, '--baseline', baseline], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /regressed: refused: brand new: 0 -> 1/);
});

test('update writes a smaller baseline, refuses a worse one unless forced, and creates a missing one', (t) => {
  const dir = path.dirname(fixture(t, 'keep.json', '{}'));
  const baseline = path.join(dir, 'baseline.json');
  fs.writeFileSync(baseline, JSON.stringify({ counts: { 'refused: a': 3 } }));
  const better = fixture(t, 'better.txt', tsv([['VS_1', 'vertex', 'refused', 'a']]));
  let result = spawnSync(process.execPath, [script, 'update', '--programs', better, '--baseline', baseline], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readBaseline(baseline).counts, { 'refused: a': 1 });

  const worse = fixture(t, 'worse.txt', tsv([['VS_1', 'vertex', 'refused', 'a'], ['VS_2', 'vertex', 'refused', 'a']]));
  result = spawnSync(process.execPath, [script, 'update', '--programs', worse, '--baseline', baseline], { encoding: 'utf8' });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing to record 1 cause/);
  assert.deepEqual(readBaseline(baseline).counts, { 'refused: a': 1 }, 'the refusal leaves the baseline alone');
  result = spawnSync(process.execPath, [script, 'update', '--programs', worse, '--baseline', baseline, '--force'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readBaseline(baseline).counts, { 'refused: a': 2 });

  const fresh = path.join(dir, 'ratchet', 'translator.json');
  result = spawnSync(process.execPath, [script, 'update', '--programs', worse, '--baseline', fresh], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readBaseline(fresh).counts, { 'refused: a': 2 });
});

test('the command line refuses what it cannot do', (t) => {
  const file = fixture(t, 'a.txt', tsv([]));
  for (const args of [[], ['check'], ['nonsense', '--programs', file], ['check', '--programs', file, '--nope']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 2, args.join(' '));
    assert.match(result.stderr, /shader-ratchet: /);
  }
});

test('one cause at two code addresses is one key, and the addresses stay as examples', () => {
  const parsed = causes([
    { outcome: 'refused', reason: 'converter shader.dxil v1: GFX10 code at 0x1020: an opaque lane mask is not supported' },
    { outcome: 'refused', reason: 'converter shader.dxil v1: GFX10 code at 0x13c8: an opaque lane mask is not supported' },
  ]);
  assert.deepEqual([...parsed.counts], [
    ['refused: converter shader.dxil v1: GFX10 code an opaque lane mask is not supported', 2],
  ]);
  assert.deepEqual(Object.fromEntries(parsed.examples.get([...parsed.counts.keys()][0])), { '1020': 1, '13c8': 1 });

  // A run whose cause moved to another offset is not a regression against a baseline naming the cause.
  const baseline = { counts: { 'refused: converter shader.dxil v1: GFX10 code an opaque lane mask is not supported': 2 } };
  assert.deepEqual(regressions(baseline, parsed.counts), []);
});

test('validation failures key by their message class, with the element and location kept as examples', () => {
  const rows = [
    { outcome: 'failed_validation', reason: "error: signature element TEXCOORD at location (7,1) size (1,1) has interpolation mode that differs from another element packed into the same row." },
    { outcome: 'failed_validation', reason: "error: signature element NORMAL at location (9,1) size (1,2) has interpolation mode that differs from another element packed into the same row." },
    { outcome: 'failed_validation', reason: "error: Container part 'Program Input Signature' does not match expected for module." },
    { outcome: 'failed_validation', reason: "Function: main: error: For shader 'main', vertex plus primitive output size is greater than 32768." },
  ];
  const parsed = causes(rows);
  assert.deepEqual(Object.fromEntries(parsed.counts), {
    'failed_validation: row interpolation modes differ': 2,
    'failed_validation: signature part mismatch': 1,
    'failed_validation: mesh output over 32768 bytes': 1,
  });
  const interp = parsed.examples.get('failed_validation: row interpolation modes differ');
  assert.equal(interp.size, 2, 'each location is an example');
  assert.match([...interp.keys()][0], /TEXCOORD at location \(7,1\)/);
  const signature = [...parsed.examples.get('failed_validation: signature part mismatch').keys()][0];
  assert.match(signature, /Program Input Signature/, 'a message whose class sentence is all of it keeps its whole text');

  const baseline = { counts: { 'failed_validation: row interpolation modes differ': 2 } };
  assert.deepEqual(regressions(baseline, parsed.counts).map((r) => r.cause), [
    'failed_validation: signature part mismatch',
    'failed_validation: mesh output over 32768 bytes',
  ]);
});

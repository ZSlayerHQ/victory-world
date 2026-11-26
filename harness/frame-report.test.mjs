import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

import {
  DEFAULT_HEAP_LIMIT,
  compare,
  nullsSection,
  parseListing,
  passes,
  passesSection,
  tableBasesSection,
  pastLimitSection,
  pngStats,
  report,
  zeroTargetsSection,
} from './frame-report.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'frame-report.mjs');

// The runtime's own line shapes, with invented ids: an indirect dispatch that reads a null slot (1007) and a slot
// past the limit (1178503), an indexed draw with a colour target and a depth target, and an alias op that carries no
// call. Continuation lines fold into their op, as the listing does.
const LISTING = [
  '1 list 0x0000000000000100 indirect kind 2 max 1 at 0x0000000000000200 [compute 0123456789abcdef] | 0123456789abcdef:',
  '  u4=0x1 [heap 1007: null] u5=0x2 [heap 1178503: Shader(1, Some([1, 2]))] u8=0x2a000000',
  '2 list 0x0000000000000100 indexed 3x1 [vertex fedcba9876543210, pixel 0011223344556677] targets ["0x0000000000000300 64x32 f10"] depth Some("0x0000000000000301 64x32 f19") state [depth true write 0]',
  '3 list 0x0000000000000200 alias copy of 0x1 into 0x2',
  '',
].join('\n');

test('the listing is read in its own line shapes: calls, shaders, targets, depth and every heap reference', () => {
  const ops = parseListing(LISTING);
  assert.equal(ops.length, 3);
  assert.equal(ops[0].kind, 'dispatch');
  assert.deepEqual(ops[0].shaders, [{ stage: 'compute', hash: '0123456789abcdef' }]);
  assert.deepEqual(ops[0].heapRefs.map((r) => [r.slot, r.what]), [
    [1007, 'null'],
    [1178503, 'Shader(1, Some([1, 2]))'],
  ]);
  assert.equal(ops[1].kind, 'draw');
  assert.deepEqual(ops[1].targets.map((t) => [t.size, t.format]), [['64x32', 'f10']]);
  assert.deepEqual([ops[1].depth.size, ops[1].depth.format], ['64x32', 'f19']);
  assert.equal(ops[2].kind, 'misc', 'an alias op carries no call');
});

test('passes group by list in submit order, and keep their targets, shaders, nulls and past-limit references', () => {
  const names = new Map([['0011223344556677', 'PS_FakeName_Wrapped']]);
  const effects = new Map([['0011223344556677', 'fake_effect/fake_technique']]);
  const parsed = passes(parseListing(LISTING), { heapLimit: DEFAULT_HEAP_LIMIT, names, effects });
  assert.equal(parsed.length, 2);
  const [first, second] = parsed;
  assert.equal(first.draws, 1);
  assert.equal(first.dispatches, 1);
  assert.deepEqual([...first.targets.keys()], ['0x0000000000000300 64x32 f10']);
  assert.equal(first.nulls.length, 1);
  assert.equal(first.pastLimit.length, 1);
  assert.equal(first.pastLimit[0].slot, 1178503);
  assert.equal(second.draws, 0);
  assert.equal(second.dispatches, 0);

  assert.match(passesSection(parsed), /\| 1 \| 000100 \| 1\.\.2 \| 1 \| 1 \| 0x0000000000000300 64x32 f10 \|/);
  assert.match(passesSection(parsed), /PS_FakeName_Wrapped \(fake_effect\/fake_technique\)x1/);
  assert.match(nullsSection(parsed), /- 000100: compute 0123456789abcdef @1007 x1/);
  assert.match(pastLimitSection(parsed, 1_000_000), /- 000100: compute 0123456789abcdef @1178503 x1/);
  const bases = tableBasesSection(parsed, 1_000_000);
  assert.match(bases, /^# table bases past 1000000 \(rebuilt per draw\)/);
  assert.match(bases, /^- 1 in this frame$/m);
  assert.match(nullsSection(passes([])), /^# null slots \(bound registers; a rebuilt table may make these unread slots\)\n- none$/);
});

// A PNG the report can decode: 8-bit RGBA, no interlacing, filter 0.
function png(width, height, [r, g, b, a]) {
  const chunk = (kind, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(kind, 4, 'latin1');
    data.copy(out, 8);
    const crc = zlib.crc32 ? zlib.crc32(Buffer.concat([Buffer.from(kind, 'latin1'), data])) : 0;
    out.writeUInt32BE(crc >>> 0, 8 + data.length);
    return out;
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const rows = [];
  for (let y = 0; y < height; y += 1) {
    rows.push(Buffer.from([0]));
    for (let x = 0; x < width; x += 1) rows.push(Buffer.from([r, g, b, a]));
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('an all-zero target shows as all zero, and a drawn one does not', () => {
  assert.deepEqual(pngStats(png(2, 2, [0, 0, 0, 0])), { width: 2, height: 2, channels: 4, zero: true });
  assert.equal(pngStats(png(2, 2, [0, 0, 0, 255])).zero, false, 'a black opaque pixel is not zero');
  const section = zeroTargetsSection('/capture', png(1, 1, [0, 0, 0, 0]) && ((file) => png(1, 1, [0, 0, 0, 0])), () => [
    'frame-1-0-64x32-f10.png',
    'frame-1-1-64x32-f10.png',
  ]);
  assert.equal(section.split('\n').length, 3, 'both synthetic images are zero');
});

test('compare lines two runs up per pass', () => {
  const a = passes(parseListing(LISTING), {});
  const b = passes(parseListing(LISTING.replace('[heap 1007: null] ', '')), {});
  const text = compare(a, b);
  assert.match(text, /\| 1 \| 1 \| 1 → 0 \| 1 \|/);
});

test('the command prints the report, refuses an --out inside a repository, and reads a capture folder', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'frame-report-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const capture = path.join(dir, 'capture');
  fs.mkdirSync(capture);
  fs.writeFileSync(path.join(capture, 'frame-1-ops.txt'), LISTING);
  fs.writeFileSync(path.join(capture, 'frame-1-0-64x32-f10.png'), png(1, 1, [0, 0, 0, 0]));
  const ok = spawnSync(process.execPath, [script, capture], { encoding: 'utf8', env: { ...process.env, VICTORY_LOCAL_ENV: path.join(dir, 'none.env') } });
  assert.equal(ok.status, 0, ok.stderr);
  assert.match(ok.stdout, /## frame-1/);
  assert.match(ok.stdout, /# all-zero targets\n- frame-1-0-64x32-f10\.png/);
  const insideRepo = spawnSync(process.execPath, [script, capture, '--out', path.join(here, 'report.txt')], { encoding: 'utf8' });
  assert.equal(insideRepo.status, 2, 'an --out inside the repository is refused');
  assert.match(insideRepo.stderr, /outside every repository/);
});

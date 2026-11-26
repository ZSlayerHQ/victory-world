#!/usr/bin/env node
// One frame's passes, from a capture's op listing and target images: what each pass submits, in submit order,
// where null slots and references past the host view heap land, which targets are all zero, and how two runs differ.
//
//   node harness/frame-report.mjs <capture folder> [--out <file>] [--heap-limit N] [--names <tsv>] [--effects <tsv>]
//   node harness/frame-report.mjs compare <capture A> <capture B> [--out <file>] [--heap-limit N]
//
// The listing is `frame-<n>-ops.txt` (the runtime's per-op dump: one operation per line, continuations folded in);
// the target images sit beside it. Names and effect/technique pairs are joined from references/shader-names.txt and
// references/effect-map.txt when they exist (they are private; the tool runs without them).
//
// A heap reference (`[heap N: …]`) describes what a register held at submit, NOT what the shader confirmed reading: a
// table that reaches past the host limit is rebuilt for the draw, and the listing's "null" notes describe slots those
// draws never read (2026-11-25, the engineers' reading of the code). Sections (b) and (c) are therefore leads to
// confirm against what a pass samples, never evidence of a fault on their own. Nothing is written
// inside a repository: the default output is stdout, and `--out` must point outside one.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_HEAP_LIMIT = 1_000_000;

/// One operation of a listing: its list (the pass), its call, shaders with their hashes, targets and depth, and
/// every view-heap reference it prints.
export function parseListing(text) {
  const records = [];
  let current = null;
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^(\d+) list (0x[0-9a-f]+) (.*)$/);
    if (m) {
      current = { op: Number(m[1]), list: m[2], body: m[3] };
      records.push(current);
    } else if (current) current.body += ` ${line.trim()}`;
  }
  return records.map((record) => operation(record));
}

function operation({ op, list, body }) {
  const out = { op, list, kind: 'misc', call: null, shaders: [], targets: [], depth: null, heapRefs: [], tableBases: [], raw: body };
  // The runtime's call words: `indirect kind K max M at 0x…`, `indexed NxM`, `draw <kind>`, `mesh N`, `dispatch <kind>`.
  // (`indexed` and `draw`/`mesh` are draws; `indirect`/`dispatch` are dispatches unless a pixel or vertex stage names them.)
  const call = body.match(/^((?:indirect|indexed|draw|mesh|dispatch) [^\[]*?) \[([^\]]*)\]/);
  if (call) {
    out.call = call[1].replace(/ at 0x[0-9a-f]+/, '').trim();
    out.shaders = call[2]
      .split(', ')
      .map((s) => s.split(' '))
      .filter((parts) => parts.length >= 2)
      .map(([stage, hash]) => ({ stage, hash }));
    out.kind = out.shaders.some((s) => s.stage === 'compute') ? 'dispatch' : 'draw';
    const targets = body.match(/targets \[([^\]]*)\]/);
    if (targets) out.targets = (targets[1].match(/"[^"]*"/g) || []).map((quoted) => target(quoted.slice(1, -1)));
    const depth = body.match(/depth (None|Some\("([^"]*)"\))/);
    if (depth && depth[2]) out.depth = target(depth[2]);
  } else if (body.startsWith('texture upload')) out.kind = 'upload';
  else if (body.startsWith('DROPPED')) out.kind = 'dropped';
  // A reference's description can carry one level of brackets of its own (`Shader(1, Some([1, 2]))`).
  for (const ref of body.matchAll(/\[heap (\d+): ((?:[^\[\]]|\[[^\]]*\])*)\]/g)) {
    out.heapRefs.push({ slot: Number(ref[1]), what: ref[2].trim() });
  }
  // A table base is a u-register holding a byte offset into a view heap, 32 bytes a view. The pattern cannot tell a
  // base from any other u-value of the same shape, so these are counted as a lead (the engineer's rule, 2026-11-25).
  for (const value of body.matchAll(/u\d+=0x([0-9a-f]+)/g)) {
    out.tableBases.push({ bytes: Number.parseInt(value[1], 16), view: Math.floor(Number.parseInt(value[1], 16) / 32) });
  }
  return out;
}

/// "0x1234 1920x1080 f10 …": the target's id, size and format as the listing prints them.
export function target(text) {
  const parts = String(text).trim().split(/\s+/);
  const [id, size = '', format = ''] = parts;
  return { id, size, format, text: String(text).trim() };
}

/// The frame's passes, in the order their lists first appear: each list's targets with the pass's draw and dispatch
/// counts and its shader names, and the null slots and past-limit references it makes.
export function passes(operations, { heapLimit = DEFAULT_HEAP_LIMIT, names = new Map(), effects = new Map() } = {}) {
  const order = [];
  const byList = new Map();
  for (const op of operations) {
    if (!byList.has(op.list)) {
      byList.set(op.list, { list: op.list, firstOp: op.op, lastOp: op.op, draws: 0, dispatches: 0, targets: new Map(), depth: new Map(), shaders: new Map(), nulls: [], pastLimit: [], tableBases: [] });
      order.push(op.list);
    }
    const pass = byList.get(op.list);
    pass.lastOp = op.op;
    if (op.kind === 'draw') pass.draws += 1;
    if (op.kind === 'dispatch') pass.dispatches += 1;
    for (const t of op.targets) remember(pass.targets, `${t.id} ${t.size} ${t.format}`);
    if (op.depth) remember(pass.depth, `${op.depth.id} ${op.depth.size} ${op.depth.format}`);
    for (const shader of op.shaders) {
      const key = `${shader.stage} ${shader.hash}`;
      if (!pass.shaders.has(key)) {
        pass.shaders.set(key, { stage: shader.stage, hash: shader.hash, count: 0, name: names.get(shader.hash) ?? null, effect: effects.get(shader.hash) ?? null });
      }
      pass.shaders.get(key).count += 1;
    }
    for (const ref of op.heapRefs) {
      const shader = op.shaders[0] ? `${op.shaders[0].stage} ${op.shaders[0].hash}` : '';
      if (ref.what === 'null' || ref.what.startsWith('null')) pass.nulls.push({ op: op.op, slot: ref.slot, shader });
      if (ref.slot >= heapLimit) pass.pastLimit.push({ op: op.op, slot: ref.slot, shader });
    }
    for (const base of op.tableBases) {
      if (base.view >= heapLimit) {
        const shader = op.shaders[0] ? `${op.shaders[0].stage} ${op.shaders[0].hash}` : '';
        pass.tableBases.push({ op: op.op, view: base.view, bytes: base.bytes, shader });
      }
    }
  }
  return order.map((list) => byList.get(list));
}

const remember = (map, key) => map.set(key, (map.get(key) || 0) + 1);

const shaderLabel = (shader) => {
  const name = shader.name ?? shader.hash;
  return shader.effect ? `${name} (${shader.effect})` : name;
};

/// (a) The passes in submit order, each with its targets, draw and dispatch counts and shader names.
export function passesSection(passes, names = new Map()) {
  const out = ['# passes', `| # | list | ops | draws | dispatches | targets | shaders |`, '|---|---|---|---|---|---|---|'];
  passes.forEach((pass, i) => {
    const targets = [...pass.targets.keys()].slice(0, 4).join('; ') + (pass.targets.size > 4 ? ` (+${pass.targets.size - 4})` : '');
    const shaders = [...pass.shaders.values()].sort((a, b) => b.count - a.count).slice(0, 4).map((s) => `${shaderLabel(s)}x${s.count}`).join('; ');
    out.push(`| ${i + 1} | ${pass.list.slice(-6)} | ${pass.firstOp}..${pass.lastOp} | ${pass.draws} | ${pass.dispatches} | ${targets || '—'} | ${shaders || '—'} |`);
  });
  return out.join('\n');
}

/// (b) Draws with a null slot, by pass, shader and slot: bound registers, not confirmed reads.
export function nullsSection(passes) {
  const out = ['# null slots (bound registers; a rebuilt table may make these unread slots)'];
  let total = 0;
  for (const pass of passes) {
    const by = new Map();
    for (const n of pass.nulls) {
      const key = `${n.shader || '—'} @${n.slot}`;
      by.set(key, (by.get(key) || 0) + 1);
      total += 1;
    }
    for (const [key, count] of [...by].sort((a, b) => b[1] - a[1])) out.push(`- ${pass.list.slice(-6)}: ${key} x${count}`);
  }
  if (!total) out.push('- none');
  return out.join('\n');
}

/// (c) Slot references at or past the heap limit, by pass, shader and slot — bound registers, not confirmed reads.
export function pastLimitSection(passes, heapLimit = DEFAULT_HEAP_LIMIT) {
  const out = [`# references at or past ${heapLimit} (bound registers, not confirmed reads)`];
  let total = 0;
  for (const pass of passes) {
    const by = new Map();
    for (const n of pass.pastLimit) {
      const key = `${n.shader || '—'} @${n.slot}`;
      by.set(key, (by.get(key) || 0) + 1);
      total += 1;
    }
    for (const [key, count] of [...by].sort((a, b) => b[1] - a[1])) out.push(`- ${pass.list.slice(-6)}: ${key} x${count}`);
  }
  if (!total) out.push('- none');
  return out.join('\n');
}

/// Table bases past the heap limit, by pass, shader and view: the runtime relocates these per draw, so this is a
/// count of registers holding such a base, not of reads.
export function tableBasesSection(passes, heapLimit = DEFAULT_HEAP_LIMIT) {
  const out = [`# table bases past ${heapLimit} (rebuilt per draw)`];
  let total = 0;
  for (const pass of passes) total += pass.tableBases.length;
  if (!total) return [...out, '- none'].join('\n');
  out.push(`- ${total} in this frame`);
  for (const pass of passes) {
    const by = new Map();
    for (const base of pass.tableBases) {
      const key = `${base.shader || '—'} @view ${base.view}`;
      by.set(key, (by.get(key) || 0) + 1);
    }
    for (const [key, count] of [...by].sort((a, b) => b[1] - a[1]).slice(0, 3)) out.push(`- ${pass.list.slice(-6)}: ${key} x${count}`);
  }
  return out.join('\n');
}

/// A PNG's pixels, for the all-zero test: 8-bit, non-interlaced, colour types 0, 2, 4 or 6. Returns
/// { width, height, channels, zero } where `zero` says every sample byte is 0 (alpha included; null when the image
/// is a shape this does not decode).
export function pngStats(bytes) {
  ensurePng(bytes);
  let at = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let type = 0;
  let interlace = 0;
  const idat = [];
  while (at + 8 <= bytes.length) {
    const length = bytes.readUInt32BE(at);
    const kind = bytes.toString('latin1', at + 4, at + 8);
    const data = bytes.subarray(at + 8, at + 8 + length);
    at += 12 + length;
    if (kind === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      type = data[9];
      interlace = data[12];
    } else if (kind === 'IDAT') idat.push(data);
    else if (kind === 'IEND') break;
  }
  if (depth !== 8 || interlace !== 0 || ![0, 2, 4, 6].includes(type)) {
    return { width, height, channels: null, zero: null };
  }
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[type];
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const image = unfilter(raw, height, stride, channels);
  let zero = true;
  for (let i = 0; i < image.length; i += 1) {
    if (image[i] !== 0) {
      zero = false;
      break;
    }
  }
  return { width, height, channels, zero };
}

function ensurePng(bytes) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(signature)) throw new Error('not a PNG');
}

function unfilter(raw, height, stride, channels) {
  const out = Buffer.alloc(height * stride);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[at];
    at += 1;
    const row = raw.subarray(at, at + stride);
    at += stride;
    const here = out.subarray(y * stride, (y + 1) * stride);
    const prior = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? here[x - channels] : 0;
      const b = prior ? prior[x] : 0;
      const c = prior && x >= channels ? prior[x - channels] : 0;
      let value = row[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) value += paeth(a, b, c);
      here[x] = value & 0xff;
    }
  }
  return out;
}

const paeth = (a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
};

/// (d) Targets whose image is all zero, from the images beside the listing.
export function zeroTargetsSection(capture, readFile = fs.readFileSync, readDir = fs.readdirSync) {
  const out = ['# all-zero targets'];
  let found = 0;
  for (const name of readDir(capture).sort()) {
    if (!name.toLowerCase().endsWith('.png')) continue;
    const stats = pngStats(readFile(path.join(capture, name)));
    if (stats.zero === true) {
      out.push(`- ${name}`);
      found += 1;
    }
  }
  if (!found) out.push('- none');
  return out.join('\n');
}

/// (e) `compare`: per pass, what differs between two runs in draw counts, null slots, references past the limit and
/// all-zero targets.
export function compare(passesA, passesB, heapLimit = DEFAULT_HEAP_LIMIT) {
  const out = [`# compare`, '| pass | draws | null slots | past the limit |', '|---|---|---|---|'];
  const width = Math.max(passesA.length, passesB.length);
  for (let i = 0; i < width; i += 1) {
    const a = passesA[i];
    const b = passesB[i];
    const cell = (x, y) => (x === y ? `${x}` : `${x} → ${y}`);
    out.push(
      `| ${i + 1} | ${cell(a ? a.draws : 0, b ? b.draws : 0)} | ${cell(a ? a.nulls.length : 0, b ? b.nulls.length : 0)} | ${cell(
        a ? a.pastLimit.length : 0,
        b ? b.pastLimit.length : 0,
      )} |`,
    );
  }
  return out.join('\n');
}

/// The names and effect/technique pairs the reports join on, when the private references exist.
export function referenceMaps(repoRoot = path.join(HERE, '..'), readFile = null) {
  const names = new Map();
  const effects = new Map();
  const read = readFile ?? ((file) => fs.readFileSync(file, 'utf8'));
  const nameFile = path.join(repoRoot, 'references', 'shader-names.txt');
  const effectFile = path.join(repoRoot, 'references', 'effect-map.txt');
  try {
    for (const line of read(nameFile).split(/\r?\n/)) {
      const parts = line.split('\t');
      if (parts[0]) names.set(parts[0], parts[parts.length - 1]);
    }
  } catch {
    // The references are private; the report runs without them.
  }
  try {
    for (const line of read(effectFile).split(/\r?\n/).slice(1)) {
      const parts = line.split('\t');
      if (parts.length < 4) continue;
      for (let i = 4; i + 1 < parts.length; i += 2) if (parts[i] && !effects.has(parts[i])) effects.set(parts[i], `${parts[1]}/${parts[2]}`);
    }
  } catch {
    // As above.
  }
  return { names, effects };
}

/// The whole report for one capture folder.
export function report(capture, options = {}) {
  const listings = fs.readdirSync(capture).filter((name) => name.endsWith('-ops.txt')).sort();
  const parts = [];
  for (const listing of listings) {
    const operations = parseListing(fs.readFileSync(path.join(capture, listing), 'utf8'));
    const framePasses = passes(operations, options);
    parts.push(`## ${listing.replace(/-ops\.txt$/, '')}`);
    parts.push(passesSection(framePasses));
    parts.push(nullsSection(framePasses));
    parts.push(pastLimitSection(framePasses, options.heapLimit ?? DEFAULT_HEAP_LIMIT));
    parts.push(tableBasesSection(framePasses, options.heapLimit ?? DEFAULT_HEAP_LIMIT));
    parts.push(zeroTargetsSection(capture));
  }
  return parts.join('\n\n');
}

function usage() {
  console.error(
    'usage: node frame-report.mjs <capture folder> [--out <file>] [--heap-limit N] [--names <tsv>] [--effects <tsv>]\n' +
      '       node frame-report.mjs compare <capture A> <capture B> [--out <file>] [--heap-limit N]',
  );
}

function insideRepository(file) {
  let at = path.resolve(file);
  for (;;) {
    if (fs.existsSync(path.join(at, '.git'))) return true;
    const next = path.dirname(at);
    if (next === at) return false;
    at = next;
  }
}

export function main(argv) {
  const positional = [];
  let out = null;
  let heapLimit = DEFAULT_HEAP_LIMIT;
  let namesFile = null;
  let effectsFile = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--out') out = argv[++i];
    else if (arg === '--heap-limit') heapLimit = Number(argv[++i]);
    else if (arg === '--names') namesFile = argv[++i];
    else if (arg === '--effects') effectsFile = argv[++i];
    else if (arg.startsWith('--')) {
      console.error(`frame-report: unknown argument ${arg}`);
      usage();
      return 2;
    } else positional.push(arg);
  }
  if (!positional.length || !Number.isFinite(heapLimit) || heapLimit < 0) {
    usage();
    return 2;
  }
  if (out && insideRepository(out)) {
    console.error('frame-report: --out must be outside every repository');
    return 2;
  }
  const lookups = referenceMaps(undefined, namesFile || effectsFile ? fileReader(namesFile, effectsFile) : null);
  const options = { heapLimit, names: lookups.names, effects: lookups.effects };
  let text;
  if (positional[0] === 'compare') {
    if (positional.length !== 3) {
      usage();
      return 2;
    }
    const a = capturePasses(positional[1], options);
    const b = capturePasses(positional[2], options);
    text = [compare(a, b, heapLimit), '', zeroTargetsSection(positional[1]), '', zeroTargetsSection(positional[2])].join('\n');
  } else {
    text = report(positional[0], options);
  }
  if (out) fs.writeFileSync(out, text + '\n');
  else console.log(text);
  return 0;
}

function fileReader(namesFile, effectsFile) {
  return (file) => {
    if (file.endsWith('shader-names.txt') && namesFile) return fs.readFileSync(namesFile, 'utf8');
    if (file.endsWith('effect-map.txt') && effectsFile) return fs.readFileSync(effectsFile, 'utf8');
    throw new Error('not read');
  };
}

const capturePasses = (capture, options) => {
  const listing = fs.readdirSync(capture).filter((name) => name.endsWith('-ops.txt')).sort()[0];
  return passes(parseListing(fs.readFileSync(path.join(capture, listing), 'utf8')), options);
};

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) process.exit(main(process.argv.slice(2)));

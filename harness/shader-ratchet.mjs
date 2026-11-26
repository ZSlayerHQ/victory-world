#!/usr/bin/env node
// The translator's failures by cause, held against a baseline that may only improve: a build fails the check when any
// cause has more programs than the baseline, or when a cause the baseline does not know appears.
//
//   node harness/shader-ratchet.mjs check  --programs <report.txt> [--baseline <file.json>]
//   node harness/shader-ratchet.mjs update --programs <report.txt> [--baseline <file.json>] [--force]
//
// The report file is the per-program report a translate writes when VICTORY_TRANSLATE_REPORT is set
// (name, stage, outcome, reason, ms, dxil_bytes; see shader-compile-report.mjs). `update` writes the smaller-or-equal
// counts back; with a cause made worse it refuses unless --force, so a regression cannot be recorded as normal by
// accident. The baseline lives wherever it is committed; it holds counts only, no program names.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parsePrograms } from './shader-compile-report.mjs';

export const DEFAULT_BASELINE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'ratchet', 'translator.json');
const FAILING = ['refused', 'failed_validation'];

/// `<outcome>: <reason>` per failing program of the report.
/// The three classes the DXIL validator's refusals fall into, keyed by the message in the middle of its text: the
/// element, row and location around it are a program's detail, not a cause of its own. Anything else keeps its
/// reason, an address taken out.
const VALIDATION_CLASSES = [
  [/Container part 'Program (?:Output|Input) Signature' does not match expected for module/i, 'signature part mismatch'],
  [/vertex plus primitive output size is greater than 32768/i, 'mesh output over 32768 bytes'],
  [/has interpolation mode that differs from another element packed into the same row/i, 'row interpolation modes differ'],
];

/// A validation failure's class, or null when its message is not one of the three.
export function validationClass(reason) {
  for (const [pattern, name] of VALIDATION_CLASSES) if (pattern.test(reason || '')) return name;
  return null;
}

/// The part of a validation message that names the element, row or location: an example, never a key.
export function validationExample(reason) {
  for (const [pattern, name] of VALIDATION_CLASSES) {
    if (pattern.test(reason || '')) {
      const rest = (reason || '').replace(pattern, '').replace(/^[\s:;,]+|[\s:;,]+$/g, '');
      // A message whose class sentence is all there was keeps its whole text: that is its only detail.
      return rest.replace(/[^A-Za-z0-9]/g, '').length >= 6 ? rest : reason || name;
    }
  }
  return null;
}

/// A cause's key: the outcome and the reason with the code address taken out (or, for a validation failure, its
/// message class), so two programs failing for one reason at different offsets or locations are one cause and a
/// cause that moves stays itself. The address and the detail remain examples, never part of the key.
export function causeKey(row) {
  if (row.outcome === 'failed_validation') {
    const name = validationClass(row.reason);
    if (name) return `${row.outcome}: ${name}`;
  }
  const reason = (row.reason || 'no reason stated').replace(/\s+at 0x[0-9a-f]+:/i, '');
  return `${row.outcome}: ${reason}`;
}

/// The address a reason names, if it names one.
export function causeAddress(row) {
  const m = (row.reason || '').match(/\sat 0x([0-9a-f]+):/i);
  return m ? m[1] : null;
}

/// The causes a report's rows name, with the addresses that carried each one (examples, not keys).
export function causes(rows) {
  const counts = new Map();
  const examples = new Map();
  for (const row of rows) {
    if (!FAILING.includes(row.outcome)) continue;
    const key = causeKey(row);
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const detail = row.outcome === 'failed_validation' ? validationExample(row.reason) : causeAddress(row);
    if (detail !== null) {
      if (!examples.has(key)) examples.set(key, new Map());
      const per = examples.get(key);
      per.set(detail, (per.get(detail) ?? 0) + 1);
    }
  }
  return { counts, examples };
}

/// The baseline as { counts: { key: n }, examples: { key: { address: n } } }; examples are detail only.
export function readBaseline(file) {
  if (!file || !fs.existsSync(file)) return { counts: {}, examples: {} };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  return { counts: parsed.counts ?? {}, examples: parsed.examples ?? {} };
}

/// Every cause made worse or newly present; an absent or smaller cause is an improvement, not a regression.
export function regressions(baseline, now) {
  const out = [];
  for (const [key, count] of now) {
    const before = baseline.counts[key] ?? 0;
    if (count > before) out.push({ cause: key, before, now: count });
  }
  return out.sort((a, b) => b.now - b.before - (a.now - a.before));
}

function parse(argv) {
  const options = { what: argv[0], programs: null, baseline: DEFAULT_BASELINE, force: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--programs') options.programs = argv[++i];
    else if (arg === '--baseline') options.baseline = argv[++i];
    else if (arg === '--force') options.force = true;
    else if (arg.startsWith('--')) throw new Error(`unknown argument ${arg}`);
    else throw new Error(`unexpected argument ${arg}`);
  }
  if (!['check', 'update'].includes(options.what)) throw new Error('expected check or update');
  if (!options.programs) throw new Error('--programs is required');
  return options;
}

/// The table of causes, largest now first, with the baseline beside it.
export function report(baseline, now) {
  const keys = [...new Set([...Object.keys(baseline.counts), ...now.keys()])].sort(
    (a, b) => (now.get(b) ?? 0) - (now.get(a) ?? 0),
  );
  const lines = ['| Count | Cause | Baseline | Change |', '|---|---|---|---|'];
  let total = 0;
  for (const key of keys) {
    const count = now.get(key) ?? 0;
    const before = baseline.counts[key] ?? 0;
    total += count;
    const change = count - before;
    lines.push(`| ${count} | ${key} | ${before} | ${change > 0 ? '+' : ''}${change} |`);
  }
  lines.push('', `failing programs: ${total}`);
  return lines.join('\n');
}

export function asJson(baseline, now) {
  return {
    failing: [...now.values()].reduce((a, b) => a + b, 0),
    counts: Object.fromEntries(now),
    baseline: baseline.counts,
    regressions: regressions(baseline, now),
  };
}

function usage() {
  console.error('usage: node harness/shader-ratchet.mjs check  --programs <report.txt> [--baseline <file.json>]');
  console.error('       node harness/shader-ratchet.mjs update --programs <report.txt> [--baseline <file.json>] [--force]');
}

function main(argv) {
  let options;
  try {
    options = parse(argv);
  } catch (err) {
    console.error(`shader-ratchet: ${err.message}`);
    usage();
    return 2;
  }
  let now;
  let examples;
  try {
    const parsed = causes(parsePrograms(options.programs));
    now = parsed.counts;
    examples = parsed.examples;
  } catch (err) {
    console.error(`shader-ratchet: ${err.message}`);
    return 1;
  }
  const existed = fs.existsSync(options.baseline);
  const baseline = readBaseline(options.baseline);
  const worse = regressions(baseline, now);
  console.log(report(baseline, now));
  if (options.what === 'update') {
    // A first capture has nothing to hold it against; any later write must not record a cause made worse.
    if (existed && worse.length && !options.force) {
      console.error(`shader-ratchet: refusing to record ${worse.length} cause(s) made worse; pass --force to override`);
      for (const w of worse) console.error(`  ${w.cause}: ${w.before} -> ${w.now}`);
      return 1;
    }
    fs.mkdirSync(path.dirname(options.baseline), { recursive: true });
    const counts = Object.fromEntries([...now].sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(options.baseline, JSON.stringify({ note: 'the translator failures by cause; a build may only improve on this', counts }, null, 2) + '\n');
    console.log(`baseline written: ${options.baseline}`);
    return 0;
  }
  if (worse.length) {
    for (const w of worse) console.error(`regressed: ${w.cause}: ${w.before} -> ${w.now}`);
    return 1;
  }
  console.log('no cause made worse');
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));

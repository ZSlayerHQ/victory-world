#!/usr/bin/env node
// Ranks what an ahead-of-time shader translate did, from its log (`run-world.sh --warm` writes `<run>.log.warm`).
//
//   node harness/shader-compile-report.mjs <warm.log> [--main <run.log>] [--programs <report.txt>] [--public] [--json]
//
// `--main` adds the warm-up's wall time and exit code (`warm-up: exit=… after … s`, written by run-world.sh into
// the run log). `--programs` reads the per-program report the translator writes when `VICTORY_TRANSLATE_REPORT` is
// set (tab-separated name, stage, outcome, reason, ms, dxil_bytes) and then prints vertex and pixel separately,
// the reasons ranked from every program rather than one example each, the slowest ten, and a cross-check against
// the log's own totals. `--public` prints counts and reasons but no program names.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const N = String.raw`([\d,]+)`;
const RE = {
  containers: new RegExp(`^containers\\s+${N} \\((\\d+) duplicates skipped\\)`),
  programs: new RegExp(`^programs\\s+${N} translated of ${N} \\(${N} IR instructions\\)`),
  vp: new RegExp(`^DXIL\\s+${N} emitted of ${N} vertex and pixel programs; ${N} validated, ${N} pipelines`),
  cs: new RegExp(`^\\s+${N} emitted of ${N} compute programs; ${N} validated, ${N} pipelines`),
  ms: new RegExp(`^\\s+${N} emitted of ${N} mesh programs; ${N} validated, ${N} pipelines`),
  reason: new RegExp(`^\\s+${N}\\s{2}(.*?)\\s{2,}\\(e\\.g\\. (.*?)\\)\\s*$`),
  warm: new RegExp(`^warm-up: exit=(-?\\d+) after (\\d+) s`),
  // The translator's up-front and running progress lines.
  total: new RegExp(`^progress\\s+total\\s+programs=${N}\\s+containers=${N}`),
  progress: new RegExp(`^progress\\s+translated\\s+${N}\\s+of\\s+${N}\\s+refused=${N}\\s+failed_validation=${N}`),
};

const num = (text) => (text === undefined ? null : Number(text.replace(/,/g, '')));

/// Everything the log states, as numbers; null where the log does not state it.
export function parse(warmLog, mainLog = null) {
  const lines = fs.readFileSync(warmLog, 'utf8').split(/\r?\n/);
  const out = { containers: null, duplicates: null, programs: null, translated: null, reasons: [] };
  const stage = (m) => ({ emitted: num(m?.[1]), programs: num(m?.[2]), validated: num(m?.[3]), pipelines: num(m?.[4]) });
  for (const line of lines) {
    let m;
    if ((m = line.match(RE.containers))) {
      out.containers = num(m[1]);
      out.duplicates = Number(m[2]);
    } else if ((m = line.match(RE.total))) {
      out.packPrograms = num(m[1]);
      out.packContainers = num(m[2]);
    } else if ((m = line.match(RE.progress))) {
      out.progressDone = num(m[1]);
      out.progressPrograms = num(m[2]);
      out.refusedNow = num(m[3]);
      out.failedValidationNow = num(m[4]);
    } else if ((m = line.match(RE.programs))) {
      out.translated = num(m[1]);
      out.programs = num(m[2]);
    } else if ((m = line.match(RE.vp))) out.vertexPixel = stage(m);
    else if ((m = line.match(RE.cs))) out.compute = stage(m);
    else if ((m = line.match(RE.ms))) out.mesh = stage(m);
    else if ((m = line.match(RE.reason))) out.reasons.push({ count: num(m[1]), reason: m[2], example: m[3] });
  }
  out.reasons.sort((a, b) => b.count - a.count);
  if (mainLog) {
    const text = fs.readFileSync(mainLog, 'utf8');
    const m = text.match(RE.warm);
    if (m) {
      out.warmExit = Number(m[1]);
      out.warmSeconds = Number(m[2]);
    }
  }
  return out;
}

/// The per-program report file: tab-separated name, stage, outcome, reason, ms, dxil_bytes; a header row is
/// accepted and columns are taken by name when it is there.
export function parsePrograms(file) {
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (!lines.length) return [];
  const cells = (line) => line.split('\t');
  let order = ['name', 'stage', 'outcome', 'reason', 'ms', 'dxil_bytes'];
  if (cells(lines[0])[0].trim().toLowerCase() === 'name') order = cells(lines.shift()).map((c) => c.trim().toLowerCase());
  const number = (text) => (text === undefined || text.trim() === '' ? null : Number(text));
  return lines.map((line) => {
    const parts = cells(line);
    const row = {};
    order.forEach((key, i) => {
      row[key] = parts[i] ?? '';
    });
    return {
      name: row.name.trim(),
      stage: row.stage.trim().toLowerCase(),
      outcome: row.outcome.trim().toLowerCase(),
      reason: row.reason.trim(),
      ms: number(row.ms),
      dxilBytes: number(row.dxil_bytes),
    };
  });
}

const STAGES = ['vertex', 'pixel', 'compute', 'mesh'];

/// Per-stage counts from the report file's rows. Translated + refused + failed validation = programs.
function tallyPrograms(rows) {
  const stages = new Map();
  for (const r of rows) {
    const s = stages.get(r.stage) ?? { programs: 0, translated: 0, refused: 0, failedValidation: 0 };
    s.programs += 1;
    if (r.outcome === 'translated') s.translated += 1;
    else if (r.outcome === 'refused') s.refused += 1;
    else if (r.outcome === 'failed_validation') s.failedValidation += 1;
    stages.set(r.stage, s);
  }
  return stages;
}

const stageOrder = (stages) => [...STAGES.filter((s) => stages.has(s)), ...[...stages.keys()].filter((s) => !STAGES.includes(s))];

/// Every cause in the report file, ranked by how many programs it hit.
export function programReasons(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (r.outcome === 'translated') continue;
    const key = `${r.outcome}\u0000${r.reason}`;
    const g = groups.get(key) ?? { outcome: r.outcome, reason: r.reason, count: 0, example: r.name };
    g.count += 1;
    groups.set(key, g);
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

/// The ten slowest programs by translate time.
export function slowest(rows, n = 10) {
  return rows
    .filter((r) => Number.isFinite(r.ms))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, n);
}

const pct = (part, whole) => (part === null || !whole ? null : (part / whole) * 100);
const fmt = (x, digits = 0) => (x === null ? '—' : Number(x).toFixed(digits));
const validationFailures = (s) => (s && s.emitted !== null && s.validated !== null ? s.emitted - s.validated : null);

/// The report as text; `public_` drops every program name.
export function report(parsed, { public: public_ = false, programs = null } = {}) {
  const refused = parsed.refusedNow ?? (parsed.programs !== null && parsed.translated !== null ? parsed.programs - parsed.translated : null);
  const out = [];
  out.push('## Shader translate', '');
  out.push(`- containers: ${fmt(parsed.containers)} (${fmt(parsed.duplicates)} duplicates skipped)`);
  out.push(
    `- programs: ${fmt(parsed.translated)} translated of ${fmt(parsed.programs)} (${fmt(pct(parsed.translated, parsed.programs), 1)}%), ${fmt(refused)} refused`,
  );
  if (parsed.failedValidationNow !== undefined) out.push(`- failed validation: ${fmt(parsed.failedValidationNow)}`);
  if (parsed.warmSeconds !== undefined) out.push(`- warm-up: exit ${parsed.warmExit}, ${parsed.warmSeconds} s`);
  out.push('');
  out.push('| Stage | Programs | Emitted | Validated | Failed validation | Pipelines |');
  out.push('|---|---|---|---|---|---|');
  const rows = [
    ['vertex + pixel', parsed.vertexPixel],
    ['compute', parsed.compute],
    ['mesh', parsed.mesh],
  ];
  for (const [name, s] of rows) {
    out.push(
      `| ${name} | ${fmt(s?.programs)} | ${fmt(s?.emitted)} | ${fmt(s?.validated)} | ${fmt(validationFailures(s))} | ${fmt(s?.pipelines)} |`,
    );
  }
  out.push('', '| Refusals | Reason | Example |', '|---|---|---|');
  if (!parsed.reasons.length) out.push('| — | none stated | — |');
  for (const r of parsed.reasons) out.push(`| ${fmt(r.count)} | ${r.reason} | ${public_ ? '—' : r.example} |`);
  if (programs) {
    out.push('', '## Programs (from the report file)', '');
    const stages = tallyPrograms(programs);
    out.push('| Stage | Programs | Translated | Refused | Failed validation |');
    out.push('|---|---|---|---|---|');
    const total = { programs: 0, translated: 0, refused: 0, failedValidation: 0 };
    for (const name of stageOrder(stages)) {
      const s = stages.get(name);
      for (const k of Object.keys(total)) total[k] += s[k];
      out.push(`| ${name} | ${s.programs} | ${s.translated} | ${s.refused} | ${s.failedValidation} |`);
    }
    out.push(`| all | ${total.programs} | ${total.translated} | ${total.refused} | ${total.failedValidation} |`);
    // The report file and the log count the same programs: they must agree.
    const translatedRows = total.translated + total.failedValidation;
    if (parsed.translated !== null && translatedRows !== parsed.translated) {
      out.push('', `- the log says ${parsed.translated} translated; the report file has ${translatedRows} rows that translated: they disagree`);
    }
    if (parsed.programs !== null && total.programs !== parsed.programs) {
      out.push(`- the log says ${parsed.programs} programs; the report file has ${total.programs} rows: they disagree`);
    }
    out.push('', '| Count | Outcome | Reason | Example |', '|---|---|---|---|');
    if (!programReasons(programs).length) out.push('| — | — | none stated | — |');
    for (const r of programReasons(programs)) out.push(`| ${r.count} | ${r.outcome} | ${r.reason} | ${public_ ? '—' : r.example} |`);
    out.push('', '| Slowest | Program | Stage | Outcome | ms |', '|---|---|---|---|---|');
    slowest(programs).forEach((r, i) => out.push(`| ${i + 1} | ${public_ ? '—' : r.name} | ${r.stage} | ${r.outcome} | ${r.ms} |`));
  }
  return out.join('\n');
}

export function asJson(parsed, { public: public_ = false, programs = null } = {}) {
  return {
    containers: parsed.containers,
    duplicates: parsed.duplicates,
    packPrograms: parsed.packPrograms ?? null,
    packContainers: parsed.packContainers ?? null,
    programs: parsed.programs,
    translated: parsed.translated,
    refused: parsed.refusedNow ?? (parsed.programs !== null && parsed.translated !== null ? parsed.programs - parsed.translated : null),
    failedValidation: parsed.failedValidationNow ?? null,
    vertexPixel: parsed.vertexPixel ?? null,
    compute: parsed.compute ?? null,
    mesh: parsed.mesh ?? null,
    reasons: parsed.reasons.map((r) => ({ count: r.count, reason: r.reason, example: public_ ? null : r.example })),
    warmExit: parsed.warmExit ?? null,
    warmSeconds: parsed.warmSeconds ?? null,
    programReport: programs
      ? {
          stages: Object.fromEntries(tallyPrograms(programs)),
          reasons: programReasons(programs).map((r) => ({ ...r, example: public_ ? null : r.example })),
          slowest: slowest(programs).map((r) => ({ name: public_ ? null : r.name, stage: r.stage, outcome: r.outcome, ms: r.ms })),
        }
      : null,
  };
}

/// What the log does not state, so an engineer knows what to add before the report can show it. `programs` says
/// the per-program report file was supplied, which covers the per-program and per-stage gaps.
export function missing(parsed, { programs = false } = {}) {
  const out = [];
  if (parsed.vertexPixel === undefined) out.push('vertex/pixel totals (the DXIL line)');
  if (!programs) {
    out.push('vertex and pixel programs separately (the log gives their sum only; pass --programs for the report file)');
    out.push('per-program lines (name, stage, outcome, reason, time) — the log prints one example per reason');
  }
  out.push('pipeline failures in warm mode (only the made count is printed)');
  if (parsed.warmSeconds === undefined) out.push('total time inside the warm log itself (run-world.sh prints it in the run log; pass --main)');
  if (parsed.packPrograms == null) out.push('a pack total printed before translation starts (for a live progress bar)');
  return out;
}

function usage() {
  console.error('usage: node harness/shader-compile-report.mjs <warm.log> [--main <run.log>] [--programs <report.txt>] [--public] [--json]');
}

function main(argv) {
  const positional = [];
  const options = { public: false, json: false, main: null, programs: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--public') options.public = true;
    else if (argv[i] === '--json') options.json = true;
    else if (argv[i] === '--main') options.main = argv[++i];
    else if (argv[i] === '--programs') options.programs = argv[++i];
    else if (argv[i].startsWith('--')) {
      console.error(`shader-compile-report: unknown argument ${argv[i]}`);
      return 2;
    } else positional.push(argv[i]);
  }
  if (positional.length !== 1) {
    usage();
    return 2;
  }
  let parsed;
  let programs = null;
  try {
    parsed = parse(positional[0], options.main);
    if (options.programs) programs = parsePrograms(options.programs);
  } catch (err) {
    console.error(`shader-compile-report: ${err.message}`);
    return 1;
  }
  const view = { public: options.public, programs };
  console.log(options.json ? JSON.stringify(asJson(parsed, view), null, 2) : report(parsed, view));
  if (!options.json) console.log(`\nMissing from the log: ${missing(parsed, { programs: Boolean(programs) }).join('; ')}.`);
  return 0;
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));

#!/usr/bin/env node
// The load a measured leg ran under: one line at its start and one at its end, so a frame time can be read with the
// machine that produced it in view.
//
//   node load-line.mjs <start|end> [--seconds N]
//   node load-line.mjs check "<load line>" [--max-cpu N] [--min-free-mem-gb N] [--max-builders N]
//
// The line is
//   harness: load at <start|end>: cpu <n>% over 5 s, free memory <n> GB of <n>, commit <n> of <n> GB, builders <n>
// CPU is the busy share of every logical processor over the sample; free memory is the OS's free physical memory;
// commit is Windows' committed virtual memory against its limit; builders counts the running cargo, rustc, link and
// cl processes by process name only (never their command lines). check prints the failed thresholds, one line, and
// exits 3 when the sample would make a run not comparable.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GB = 1 << 30;
export const DEFAULT_SECONDS = 5;
export const DEFAULT_MAX_CPU = 25;
export const DEFAULT_MIN_FREE_MEM_GB = 12;
export const DEFAULT_MAX_BUILDERS = 0;
export const BUILDER_NAMES = ['cargo', 'rustc', 'link', 'cl'];

// Built and read by run-world.sh, the summary and the tests. The commit figures are `?` when Windows cannot say.
export const LOAD_LINE_RE =
  /^harness: load at (start|end): cpu (\?|[\d.]+)% over (\?|[\d.]+) s, free memory (\?|[\d.]+) GB of (\?|[\d.]+), commit (\?|[\d.]+) of (\?|[\d.]+) GB, builders (\d+)\s*$/;

const numeric = (text) => (text === '?' ? null : Number(text));
const shown = (value) => (value === null || value === undefined || Number.isNaN(value) ? '?' : String(value));
const cpuShown = (value) =>
  value === null || value === undefined || Number.isNaN(value) ? '?' : Number(value).toFixed(1).replace(/\.0$/, '');
const one = (value) => (value === null || value === undefined || Number.isNaN(value) ? '?' : Number(value).toFixed(1));

export function formatLoadLine(load) {
  return (
    `harness: load at ${load.when}: cpu ${cpuShown(load.cpu)}% over ${shown(load.seconds ?? DEFAULT_SECONDS)} s, ` +
    `free memory ${one(load.freeGb)} GB of ${one(load.totalGb)}, ` +
    `commit ${one(load.commitGb)} of ${one(load.commitLimitGb)} GB, builders ${load.builders}`
  );
}

export function parseLoadLine(line) {
  const m = String(line).match(LOAD_LINE_RE);
  if (!m) return null;
  return {
    when: m[1],
    cpu: numeric(m[2]),
    seconds: numeric(m[3]),
    freeGb: numeric(m[4]),
    totalGb: numeric(m[5]),
    commitGb: numeric(m[6]),
    commitLimitGb: numeric(m[7]),
    builders: Number(m[8]),
  };
}

// Busy share between two os.cpus() samples: user, nice, sys and irq count as busy, idle does not.
export function cpuPercent(before, after) {
  let busy = 0;
  let total = 0;
  const n = Math.min(before.length, after.length);
  for (let i = 0; i < n; i += 1) {
    const b = before[i].times;
    const a = after[i].times;
    const bAll = b.user + b.nice + b.sys + b.idle + b.irq;
    const aAll = a.user + a.nice + a.sys + a.idle + a.irq;
    const dAll = aAll - bAll;
    const dIdle = a.idle - b.idle;
    if (dAll <= 0) continue;
    total += dAll;
    busy += Math.max(0, dAll - Math.max(0, dIdle));
  }
  return total > 0 ? (busy / total) * 100 : null;
}

// `tasklist /FO CSV /NH` or a bare process-name list; exact base names only, so clang is not cl.
export function countBuilders(names, wanted = BUILDER_NAMES) {
  const bases = new Set(wanted.map((name) => name.toLowerCase()));
  let count = 0;
  for (const name of names) {
    const base = String(name)
      .trim()
      .split(/[\\/]/)
      .pop()
      .toLowerCase()
      .replace(/\.exe$/, '');
    if (bases.has(base)) count += 1;
  }
  return count;
}

export function processNamesFromTasklist(text) {
  const names = [];
  for (const line of String(text).split(/\r?\n/)) {
    const m = line.match(/^"([^"]+)"/) || line.match(/^\s*([^\s",]+)/);
    if (m) names.push(m[1]);
  }
  return names;
}

// Win32_OperatingSystem's FreeVirtualMemory and TotalVirtualMemorySize are KiB.
export function parseCommitKb(text) {
  const [free, total] = String(text).trim().split(/\s+/).map(Number);
  if (!Number.isFinite(free) || !Number.isFinite(total) || total <= 0) {
    return { commitGb: null, commitLimitGb: null };
  }
  return { commitGb: (total - free) / (1024 * 1024), commitLimitGb: total / (1024 * 1024) };
}

function processNames() {
  const list = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], {
    encoding: 'utf8',
    timeout: 10_000,
    windowsHide: true,
  });
  if (!list.error && list.status === 0) return processNamesFromTasklist(list.stdout || '');
  // tasklist missing or refused: Get-Process still names every process, without a command line.
  const ps = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', 'Get-Process | Select-Object -ExpandProperty ProcessName'],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  return ps.error || ps.status !== 0 ? [] : processNamesFromTasklist(ps.stdout || '');
}

function commitFigures(run = spawnSync) {
  const result = run(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Get-CimInstance Win32_OperatingSystem | ForEach-Object { "{0} {1}" -f $_.FreeVirtualMemory, $_.TotalVirtualMemorySize }',
    ],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  if (result.error || result.status !== 0) return { commitGb: null, commitLimitGb: null };
  return parseCommitKb(result.stdout || '');
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function sample({
  when = 'start',
  seconds = DEFAULT_SECONDS,
  cpus = () => os.cpus(),
  sleepMs = sleep,
  freeBytes = () => os.freemem(),
  totalBytes = () => os.totalmem(),
  builders = processNames,
  commit = commitFigures,
} = {}) {
  const before = cpus();
  await sleepMs(Number(seconds) * 1000);
  const after = cpus();
  const commitValues = commit();
  return {
    when,
    cpu: cpuPercent(before, after),
    seconds: Number(seconds),
    freeGb: freeBytes() / GB,
    totalGb: totalBytes() / GB,
    commitGb: commitValues.commitGb,
    commitLimitGb: commitValues.commitLimitGb,
    builders: countBuilders(builders()),
  };
}

export function thresholds(env = process.env) {
  const number = (value, fallback) => {
    if (value === undefined || value === '') return fallback;
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  };
  return {
    maxCpu: number(env.HARNESS_MAX_CPU, DEFAULT_MAX_CPU),
    minFreeMemGb: number(env.HARNESS_MIN_FREE_MEM_GB, DEFAULT_MIN_FREE_MEM_GB),
    maxBuilders: number(env.HARNESS_MAX_BUILDERS, DEFAULT_MAX_BUILDERS),
  };
}

export function loadFailures(load, limits = thresholds()) {
  const failures = [];
  if (load.cpu !== null && load.cpu > limits.maxCpu) {
    failures.push(`cpu ${cpuShown(load.cpu)}% is over ${limits.maxCpu}%`);
  }
  if (load.freeGb !== null && load.freeGb < limits.minFreeMemGb) {
    failures.push(`free memory ${one(load.freeGb)} GB is under ${limits.minFreeMemGb} GB`);
  }
  if (load.builders > limits.maxBuilders) {
    failures.push(`${load.builders} builders is over ${limits.maxBuilders}`);
  }
  return failures;
}

export function quietVerdict(load, limits = thresholds()) {
  const failures = loadFailures(load, limits);
  return { quiet: failures.length === 0, reason: failures.join('; ') };
}

// The summary's verdict. Both ends must be present and quiet; a missing end is not evidence that it was.
export function comparableVerdict(load, limits = thresholds()) {
  const start = load.start || null;
  const end = load.end || null;
  if (!start && !end) return { verdict: 'unknown', text: 'unknown (no load lines)' };
  const reasons = [];
  for (const [when, oneLoad] of [
    ['start', start],
    ['end', end],
  ]) {
    if (!oneLoad) continue;
    for (const failure of loadFailures(oneLoad, limits)) reasons.push(`${failure} at ${when}`);
  }
  if (reasons.length) return { verdict: 'no', text: `no (${reasons.join('; ')})` };
  if (!start) return { verdict: 'unknown', text: 'unknown (no start load line)' };
  if (!end) return { verdict: 'unknown', text: 'unknown (no end load line)' };
  return { verdict: 'yes', text: 'yes' };
}

function usage() {
  console.error('usage: node load-line.mjs <start|end> [--seconds N]');
  console.error('       node load-line.mjs check "<load line>" [--max-cpu N] [--min-free-mem-gb N] [--max-builders N]');
}

function main() {
  const args = process.argv.slice(2);
  const mode = args.shift();
  if (mode !== 'start' && mode !== 'end' && mode !== 'check') {
    usage();
    process.exit(2);
  }
  const options = {};
  let line = null;
  while (args.length) {
    const arg = args.shift();
    if (arg === '--seconds' || arg === '--max-cpu' || arg === '--min-free-mem-gb' || arg === '--max-builders') {
      const value = args.shift();
      if (value === undefined) {
        usage();
        process.exit(2);
      }
      options[arg.slice(2)] = value;
    } else if (arg === '--line') {
      line = args.shift();
    } else if (line === null && !arg.startsWith('-')) {
      line = arg;
    } else {
      usage();
      process.exit(2);
    }
  }
  if (mode === 'check') {
    const load = line ? parseLoadLine(line) : null;
    if (!load) {
      console.log('the load line could not be read');
      process.exit(3);
    }
    const limits = thresholds({
      HARNESS_MAX_CPU: options['max-cpu'] ?? process.env.HARNESS_MAX_CPU,
      HARNESS_MIN_FREE_MEM_GB: options['min-free-mem-gb'] ?? process.env.HARNESS_MIN_FREE_MEM_GB,
      HARNESS_MAX_BUILDERS: options['max-builders'] ?? process.env.HARNESS_MAX_BUILDERS,
    });
    const verdict = quietVerdict(load, limits);
    if (!verdict.quiet) {
      console.log(verdict.reason);
      process.exit(3);
    }
    process.exit(0);
  }
  const seconds = options.seconds ?? DEFAULT_SECONDS;
  if (!Number.isFinite(Number(seconds)) || Number(seconds) < 0) {
    usage();
    process.exit(2);
  }
  sample({ when: mode, seconds })
    .then((load) => {
      console.log(formatLoadLine(load));
    })
    .catch((error) => {
      console.error(`load: could not read the load: ${error.message}`);
      process.exit(1);
    });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

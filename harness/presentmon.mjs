#!/usr/bin/env node
// PresentMon capture for VIctory world runs.
//
//   node harness/presentmon.mjs watch <log> <csv> [--threshold 1000] [--seconds 60]
//
// watch tails the growing run log and, when the heavy 3D scene starts (the first
// VIctory frame line whose draws plus dropped draws per frame reaches --threshold),
// starts PresentMon against victory.exe. It writes one line to the log and exits
// when PresentMon exits, or when the log stops growing for 30 seconds.
//
// readPresentMon(csv) reads PresentMon's CSV by header name and returns
// { frames, medianMs, p95Ms, gpuMedianMs }, or null when there is no file.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { loadLocalEnv } from './local-env.mjs';
import { FRAME_RE, stripAnsi } from './parse-run.mjs';

export const DEFAULT_THRESHOLD = 1000;
export const DEFAULT_SECONDS = 60;
export const IDLE_STOP_MS = 30_000;
// PRESENTMON_EXE overrides it, from the environment or harness/local.env (local-env.mjs).
export const DEFAULT_EXE = '<project>/tools/presentmon/PresentMon-2.6.0-x64.exe';
export const DEFAULT_CAPTURES = '/captures';

const POLL_MS = 200;
const BACKSLASH = String.fromCharCode(92);

// The watcher's trigger: the first VIctory 5-second frame line whose draws plus
// dropped draws per frame reaches the threshold. A heavy scene can drop most of
// its draws (one run: at most 145 drawn, 543 to 2,744 dropped a frame), so draws
// alone can stay far below the threshold while the scene is at its heaviest.
// Frame lines only; "frame presented" lines also carry draws.
export function findTrigger(lines, threshold = DEFAULT_THRESHOLD) {
  for (let i = 0; i < lines.length; i += 1) {
    const m = stripAnsi(lines[i]).match(FRAME_RE);
    if (!m) continue;
    const draws = Number(m[5]);
    const dropped = Number(m[6]);
    if (draws + dropped >= threshold) return { index: i, draws, dropped };
  }
  return null;
}

function normalizeFolder(value) {
  let s = String(value).trim();
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  s = s.split(BACKSLASH).join('/').replace(/\/+$/, '');
  return s || null;
}

// The root run-world.sh makes each run's capture folder under: VICTORY_CAPTURES, else the main PC's.
export function capturesRoot(env = process.env) {
  return (env.VICTORY_CAPTURES && normalizeFolder(env.VICTORY_CAPTURES)) || DEFAULT_CAPTURES;
}

// The capture folder: the log's "capture:" line, else its VICTORY_CAPTURE setting,
// else <captures root>/<stamp>-<tag> from the log's file name.
export function captureFolderFromLog(lines, logPath, root = capturesRoot()) {
  for (const line of lines || []) {
    const plain = stripAnsi(line);
    const m =
      plain.match(/^\s*capture:\s*(.+?)\s*$/i) ||
      plain.match(/^\s*harness env:\s*VICTORY_CAPTURE=(.+?)\s*$/i);
    if (!m) continue;
    const folder = normalizeFolder(m[1]);
    if (!folder) continue;
    if (/^[A-Za-z]:\//.test(folder) || folder.startsWith('/') || !logPath) return folder;
    return normalizeFolder(path.resolve(path.dirname(logPath), folder));
  }
  if (!logPath) return null;
  const base = path.basename(logPath);
  const m = base.match(/^(\d{8}-\d{6})-(.+)\.log$/i);
  return m ? `${normalizeFolder(root)}/${m[1]}-${m[2]}` : null;
}

export function presentMonCsvForLog(lines, logPath) {
  const folder = captureFolderFromLog(lines, logPath);
  return folder ? `${folder}/presentmon.csv` : null;
}

function splitCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quoted) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ',') {
      cells.push(cell);
      cell = '';
    } else {
      cell += ch;
    }
  }
  cells.push(cell);
  return cells;
}

function csvNumber(cell) {
  if (cell === undefined) return null;
  const s = cell.trim();
  if (!s || /^na$/i.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function median(xs) {
  if (!xs.length) return null;
  const sorted = [...xs].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Nearest-rank p95: the smallest sample with at least 95% of the samples at or below it.
function percentile(sorted, p) {
  if (!sorted.length) return null;
  const rank = Math.max(0, Math.ceil(p * sorted.length) - 1);
  return sorted[Math.min(rank, sorted.length - 1)];
}

const EMPTY = () => ({ frames: 0, medianMs: null, p95Ms: null, gpuMedianMs: null });

// PresentMon 2.x writes FrameTime/GPUBusy or MsBetweenPresents/MsGPUBusy;
// 1.x (--v1_metrics) writes msBetweenPresents/msGPUActive. Read the header first.
export function readPresentMon(csvPath) {
  if (!csvPath || !fs.existsSync(csvPath)) return null;

  const lines = fs.readFileSync(csvPath, 'utf8').split('\n');
  const headerIndex = lines.findIndex((line) => line.trim() !== '');
  if (headerIndex < 0) return EMPTY();

  const header = splitCsvLine(lines[headerIndex].replace(/^\uFEFF/, ''));
  const names = header.map((name) => name.trim().toLowerCase());
  const frameIndex = names.findIndex((name) => name === 'frametime' || name === 'msbetweenpresents');
  const gpuIndex = names.findIndex(
    (name) => name === 'gpubusy' || name === 'msgpubusy' || name === 'msgpuactive',
  );
  if (frameIndex < 0) return EMPTY();

  const frames = [];
  const gpus = [];
  for (let i = headerIndex + 1; i < lines.length; i += 1) {
    const line = lines[i].replace(/\r$/, '');
    if (!line.trim()) continue;
    const cells = splitCsvLine(line);
    const frame = csvNumber(cells[frameIndex]);
    if (frame === null) continue;
    frames.push(frame);
    if (gpuIndex >= 0) {
      const gpu = csvNumber(cells[gpuIndex]);
      if (gpu !== null) gpus.push(gpu);
    }
  }

  const sorted = [...frames].sort((a, b) => a - b);
  return {
    frames: frames.length,
    medianMs: median(frames),
    p95Ms: percentile(sorted, 0.95),
    gpuMedianMs: median(gpus),
  };
}

function appendToLog(logPath, line) {
  try {
    fs.appendFileSync(logPath, line + '\n');
  } catch {
    // The console line is still there; never take the watcher down over the log.
  }
}

export function watch(logPath, csvPath, options = {}) {
  const {
    threshold = DEFAULT_THRESHOLD,
    seconds = DEFAULT_SECONDS,
    exe = process.env.PRESENTMON_EXE || DEFAULT_EXE,
    idleMs = IDLE_STOP_MS,
    pollMs = POLL_MS,
  } = options;

  try {
    fs.mkdirSync(path.dirname(csvPath), { recursive: true });
  } catch (err) {
    console.error(`presentmon: cannot create ${path.dirname(csvPath)}: ${err.message}`);
    return Promise.resolve(1);
  }

  return new Promise((resolve) => {
    let pos = 0;
    let pending = '';
    let lastGrowth = Date.now();
    let child = null;
    let stopping = false;
    let timer = null;

    const cleanup = () => {
      if (timer) clearInterval(timer);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    };

    const stop = (code, killChild = true) => {
      if (stopping) return;
      stopping = true;
      cleanup();
      if (killChild && child && child.exitCode === null && child.signalCode === null) {
        try {
          child.kill();
        } catch {
          // Already gone.
        }
      }
      resolve(code);
    };

    const onSignal = () => stop(0);

    const startPresentMon = (hit) => {
      if (child || stopping) return;
      const line = `presentmon: started at ${hit.draws} draws + ${hit.dropped} dropped per frame (threshold ${threshold}), writing ${csvPath}`;
      console.log(line);
      appendToLog(logPath, line);
      const args = [
        '--process_name', 'victory.exe',
        '--output_file', csvPath,
        '--timed', String(seconds),
        '--terminate_after_timed',
        '--terminate_on_proc_exit',
        '--stop_existing_session',
        '--no_console_stats',
      ];
      try {
        child = spawn(exe, args, { stdio: 'inherit' });
      } catch (err) {
        console.error(`presentmon: cannot start ${exe}: ${err.message}`);
        stop(1);
        return;
      }
      child.on('error', (err) => {
        console.error(`presentmon: ${err.message}`);
        stop(1);
      });
      child.on('exit', (code, signal) => {
        stop(code === null ? (signal ? 1 : 0) : code, false);
      });
    };

    const readNew = () => {
      let size;
      try {
        size = fs.statSync(logPath).size;
      } catch {
        return; // The harness creates the log before it starts us; give it a moment.
      }
      if (size < pos) {
        pos = 0;
        pending = '';
      }
      if (size === pos) return;
      let data;
      try {
        const fd = fs.openSync(logPath, 'r');
        try {
          const buffer = Buffer.alloc(size - pos);
          fs.readSync(fd, buffer, 0, buffer.length, pos);
          data = buffer.toString('utf8');
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        return;
      }
      pos = size;
      lastGrowth = Date.now();
      if (child) return;
      pending += data;
      const lines = pending.split('\n');
      pending = lines.pop();
      const hit = findTrigger(lines, threshold);
      if (hit) startPresentMon(hit);
    };

    process.once('SIGINT', onSignal);
    process.once('SIGTERM', onSignal);
    timer = setInterval(() => {
      if (stopping) return;
      readNew();
      if (stopping) return;
      if (Date.now() - lastGrowth >= idleMs) {
        console.log(
          child
            ? `presentmon: log stopped growing for ${Math.round(idleMs / 1000)} s, stopping`
            : `presentmon: log stopped growing for ${Math.round(idleMs / 1000)} s, no capture started`,
        );
        stop(0);
      }
    }, pollMs);
    readNew();
  });
}

function usage() {
  console.error(
    'usage: node presentmon.mjs watch <log> <csv> [--threshold 1000] [--seconds 60] [--exe path] [--idle-ms 30000]',
  );
}

async function main(argv) {
  if (argv[0] !== 'watch') {
    usage();
    return 2;
  }
  loadLocalEnv();
  const positional = [];
  const options = {
    threshold: DEFAULT_THRESHOLD,
    seconds: DEFAULT_SECONDS,
    exe: process.env.PRESENTMON_EXE || DEFAULT_EXE,
    idleMs: IDLE_STOP_MS,
  };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--threshold') options.threshold = Number(argv[++i]);
    else if (arg === '--seconds') options.seconds = Number(argv[++i]);
    else if (arg === '--exe') options.exe = argv[++i];
    else if (arg === '--idle-ms') options.idleMs = Number(argv[++i]);
    else if (arg.startsWith('--')) {
      console.error(`presentmon: unknown argument ${arg}`);
      usage();
      return 2;
    } else {
      positional.push(arg);
    }
  }
  if (
    positional.length !== 2 ||
    !Number.isFinite(options.threshold) ||
    !Number.isFinite(options.seconds) ||
    !Number.isFinite(options.idleMs) ||
    options.threshold <= 0 ||
    options.seconds <= 0 ||
    options.idleMs <= 0 ||
    !options.exe
  ) {
    usage();
    return 2;
  }
  return watch(positional[0], positional[1], options);
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

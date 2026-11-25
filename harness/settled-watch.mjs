#!/usr/bin/env node
// Ends a VIctory world run N seconds after its scene is settled: frame lines whose draws plus dropped draws reach
// 1000 and whose frame rate is at or above a floor (cutscene loading runs near 0.5 fps), three in a row. The
// "textures picked by index: ... , K waiting" count is reported in the settle line; it is a ceiling only when
// --waiting says so, because on the 2026-11-25 runs it never fell below a few hundred in play and moved both ways.
//
//   node harness/settled-watch.mjs <log> <seconds> [--timeout 600] [--floor-fps 1.5] [--waiting K] [--poll-ms 250]
//                                  [--after-file <path>]
//
// It appends "harness: settled at <s> s (waiting K, <fps> fps)" when that happens, creates --after-file (the
// runtime's VICTORY_KEYS_AFTER sentinel, which starts the relative key entries), and N seconds later ends this
// run's victory.exe and appends "harness: ended by --settled-seconds after N s of settled scene". A scene that
// has not settled within --timeout seconds of the first heavy line ends the run with
// "harness: ended by --settled-timeout after N s: the scene never settled". A game that exits by itself is not
// touched, as in heavy-watch.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { stripAnsi } from './parse-run.mjs';

export const DEFAULT_POLL_MS = 250;
export const DEFAULT_FLOOR_FPS = 1.5;
export const DEFAULT_WAITING = null;
export const SETTLED_LINES = 3;
export const DEFAULT_TIMEOUT_S = 600;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRAME_RE =
  /^(\S+Z)\s+.*?([\d.]+) fps, ([\d.]+) ms\/frame.*?([\d.]+) draws\/frame, dropped ([\d.]+)/;
const WAITING_RE = /textures picked by index: \d+ uploaded so far \(\d+ MB\), (\d+) waiting/;

/// One frame line's figures, or null when the line is not the frame line.
export function frameLine(raw) {
  const line = stripAnsi(String(raw));
  const m = line.match(FRAME_RE);
  if (!m) return null;
  const at = Date.parse(m[1]);
  if (Number.isNaN(at)) return null;
  const waiting = line.match(WAITING_RE);
  return {
    at,
    fps: Number(m[2]),
    draws: Number(m[4]),
    dropped: Number(m[5]),
    waiting: waiting ? Number(waiting[1]) : null,
  };
}

/// A fresh state: no heavy line seen, no run of settled lines, no settle.
export function initialState() {
  return { heavyAt: null, consecutive: 0, settledAt: null, settledWaiting: null, settledFps: null };
}

/// The state after one more line: the first heavy line's time, the run of consecutive frame lines meeting the
/// rule, and the settle time once enough of them have. A `waiting` ceiling is optional; without one the rate is
/// the test, and the count is only reported.
export function observe(state, raw, options = {}) {
  const floorFps = options.floorFps ?? DEFAULT_FLOOR_FPS;
  const waiting = options.waiting ?? DEFAULT_WAITING;
  const next = { ...state };
  const frame = frameLine(raw);
  if (!frame) return next;
  const heavy = frame.draws + frame.dropped >= 1000;
  if (heavy && next.heavyAt === null) next.heavyAt = frame.at;
  const belowCeiling = waiting === null || (frame.waiting !== null && frame.waiting <= waiting);
  const meets = heavy && frame.fps >= floorFps && belowCeiling;
  next.consecutive = meets ? next.consecutive + 1 : 0;
  if (next.settledAt === null && next.consecutive >= SETTLED_LINES) {
    next.settledAt = frame.at;
    next.settledWaiting = frame.waiting;
    next.settledFps = frame.fps;
  }
  return next;
}

/// What the watcher does now: end N seconds after the settle; time out when the scene has not settled within the
/// cap after the first heavy line; otherwise wait.
export function due(state, { now, seconds, timeout }) {
  if (state.settledAt !== null) {
    return now - state.settledAt >= seconds * 1000 ? 'end' : 'wait';
  }
  if (state.heavyAt !== null && now - state.heavyAt >= timeout * 1000) return 'timeout';
  return 'wait';
}

export const settledMarker = (seconds, waiting, fps) =>
  `harness: settled at ${seconds} s (waiting ${waiting ?? '?'}, ${fps} fps)`;
export const settleEndMarker = (seconds) =>
  `harness: ended by --settled-seconds after ${seconds} s of settled scene`;
export const timeoutMarker = (seconds) =>
  `harness: ended by --settled-timeout after ${seconds} s: the scene never settled`;

// run-process.ps1's strict selection, one pid per line. null means PowerShell failed, which is not evidence that
// the game is gone.
function selectionPids(psFile) {
  const result = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psFile, '-Pids', '-Strict'],
    { encoding: 'utf8', timeout: 15_000, windowsHide: true },
  );
  if (result.error || result.status !== 0) return null;
  return (result.stdout || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^\d+$/.test(line))
    .map(Number);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// taskkill needs /F: a plain taskkill asks the window to close, and this title ignores that.
function endPid(pid) {
  const result = spawnSync('taskkill', ['/F', '/PID', String(pid)], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return result.status === 0;
}

export function watch(logPath, seconds, options = {}) {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const timeout = options.timeout ?? DEFAULT_TIMEOUT_S;
  const floorFps = options.floorFps ?? DEFAULT_FLOOR_FPS;
  const waitingCeiling = options.waiting ?? DEFAULT_WAITING;
  const afterFile = options.afterFile ?? null;
  const psFile = options.psFile ?? path.join(HERE, 'run-process.ps1');
  return new Promise((resolve) => {
    let pos = 0;
    let pending = '';
    let state = initialState();
    let announced = false;
    let pids = null;
    let seenGame = false;
    let lastSelection = 0;
    let stopping = false;
    let timer = null;

    const append = (line) => {
      try {
        fs.appendFileSync(logPath, `${line}\n`);
      } catch {
        // The console line below still says what happened; never take the watcher down over the log.
      }
      console.log(line);
    };

    const stop = (code) => {
      if (stopping) return;
      stopping = true;
      if (timer) clearInterval(timer);
      resolve(code);
    };

    const refreshPids = () => {
      lastSelection = Date.now();
      const found = selectionPids(psFile);
      if (found === null) return;
      pids = found;
      if (found.length) seenGame = true;
    };

    const gameAlive = () => {
      if (!seenGame) return true;
      if (!pids) return true;
      if (pids.some(isAlive)) return true;
      refreshPids();
      return pids ? pids.some(isAlive) : true;
    };

    const readNew = () => {
      let size;
      try {
        size = fs.statSync(logPath).size;
      } catch {
        return;
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
      pending += data;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) {
        state = observe(state, line, { floorFps, waiting: waitingCeiling });
        if (state.settledAt !== null && !announced) {
          announced = true;
          const since = Math.max(0, Math.round((state.settledAt - state.heavyAt) / 1000));
          append(settledMarker(since, state.settledWaiting, state.settledFps));
          if (afterFile) {
            try {
              fs.writeFileSync(afterFile, '');
            } catch {
              append(`harness: settled, but the keys-after file ${afterFile} could not be made`);
            }
          }
        }
      }
    };

    const killThisRun = () => {
      let alive = (pids || []).filter(isAlive);
      if (!alive.length) {
        refreshPids();
        alive = (pids || []).filter(isAlive);
      }
      if (!alive.length) {
        if (pids !== null) stop(0); // Already gone: it ended by itself.
        return false;
      }
      const ended = alive.filter(endPid);
      return ended.length > 0;
    };

    const tick = () => {
      if (stopping) return;
      readNew();
      if (!seenGame && Date.now() - lastSelection >= 1000) refreshPids();

      if (state.heavyAt === null) {
        if (seenGame && !gameAlive()) stop(0);
        return;
      }
      if (!gameAlive()) {
        stop(0);
        return;
      }
      const now = Date.now();
      const action = due(state, { now, seconds, timeout });
      if (action === 'wait') return;
      if (action === 'end') {
        if (!killThisRun()) return; // Gone by itself (stop(0) inside), or taskkill failed: retry next poll.
        append(settleEndMarker(seconds));
        stop(0);
        return;
      }
      if (!killThisRun()) return;
      append(timeoutMarker(Math.round((now - state.heavyAt) / 1000)));
      stop(0);
    };

    process.once('SIGINT', () => stop(0));
    process.once('SIGTERM', () => stop(0));
    refreshPids();
    timer = setInterval(tick, pollMs);
    tick();
  });
}

function usage() {
  console.error(
    'usage: node settled-watch.mjs <log> <seconds> [--timeout 600] [--floor-fps 1.5] [--waiting K] [--poll-ms 250] [--after-file <path>]',
  );
}

async function main(argv) {
  const positional = [];
  let pollMs = DEFAULT_POLL_MS;
  let timeout = DEFAULT_TIMEOUT_S;
  let floorFps = DEFAULT_FLOOR_FPS;
  let waiting = DEFAULT_WAITING;
  let afterFile = null;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--poll-ms') pollMs = Number(argv[++i]);
    else if (arg === '--timeout') timeout = Number(argv[++i]);
    else if (arg === '--floor-fps') floorFps = Number(argv[++i]);
    else if (arg === '--waiting') waiting = Number(argv[++i]);
    else if (arg === '--after-file') afterFile = argv[++i];
    else if (arg.startsWith('--')) {
      console.error(`settled-watch: unknown argument ${arg}`);
      usage();
      return 2;
    } else {
      positional.push(arg);
    }
  }
  const seconds = Number(positional[1]);
  const bad =
    positional.length !== 2 ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    !Number.isFinite(timeout) ||
    timeout <= 0 ||
    !Number.isFinite(floorFps) ||
    floorFps <= 0 ||
    !(waiting === null || (Number.isFinite(waiting) && waiting >= 0)) ||
    !Number.isFinite(pollMs) ||
    pollMs <= 0;
  if (bad) {
    usage();
    return 2;
  }
  return watch(positional[0], seconds, { pollMs, timeout, floorFps, waiting, afterFile });
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

#!/usr/bin/env node
// The free-space guard: refuse a run that starts with too little room, and end it if the drive falls below a floor
// while the game runs.
//
//   node harness/disk-guard.mjs check --path <folder> --min <GB>
//   node harness/disk-guard.mjs watch --log <run.log> --path <folder> --below <GB> [--poll-ms 5000]
//
// check prints one line naming the drive (never a folder path) and exits 1 when free space is under the minimum or
// the volume cannot be read. watch checks every poll, and when free space falls under the floor it appends
// `harness: ended: disk below <GB> GB` to the run log, ends this run's victory.exe (run-process.ps1, the selection
// heavy-watch.mjs and settled-watch.mjs use) and exits. It exits by itself once the game is gone.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { driveOf, space } from './disk-usage.mjs';

export const GB = 1 << 30;
export const DEFAULT_MIN_GB = 30;
export const DEFAULT_BELOW_GB = 5;
export const DEFAULT_POLL_MS = 5000;

export function freeGb(target, spaceOf = space) {
  const found = spaceOf(target);
  return found ? found.free / GB : null;
}

export function endedMarker(belowGb) {
  return `harness: ended: disk below ${belowGb} GB`;
}

/// What the guard says about the volume now: `ok` when it can read it and there is at least `minGb` free.
export function check(target, minGb, spaceOf = space) {
  const free = freeGb(target, spaceOf);
  const drive = driveOf(target);
  if (free === null) {
    return { ok: false, freeGb: null, text: `disk ${drive} unreadable: the free-space guard cannot check it` };
  }
  const ok = free >= minGb;
  return {
    ok,
    freeGb: free,
    text: `disk ${drive} ${free.toFixed(1)} GB free${ok ? '' : `, below ${minGb} GB`}`,
  };
}

/// End only on a readable figure under the floor; an unreadable volume is not evidence of a full one.
export function decide(free, belowGb) {
  return free !== null && free < belowGb ? 'end' : 'wait';
}

// run-process.ps1's strict selection, one pid per line. null means PowerShell failed, which is not evidence that the
// game is gone.
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

export function watch(logPath, target, options = {}) {
  const pollMs = options.pollMs ?? DEFAULT_POLL_MS;
  const belowGb = options.belowGb ?? DEFAULT_BELOW_GB;
  const spaceOf = options.spaceOf ?? space;
  const psFile = options.psFile ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'run-process.ps1');
  return new Promise((resolve) => {
    let pids = null;
    let seenGame = false;
    let lastSelection = 0;
    let stopping = false;
    let timer = null;

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
      if (!seenGame) return true; // Still starting: not yet evidence of a game, let alone a gone one.
      if (!pids) return true;
      if (pids.some(isAlive)) return true;
      refreshPids();
      return pids ? pids.some(isAlive) : true;
    };

    const tick = () => {
      if (stopping) return;
      if (!seenGame && Date.now() - lastSelection >= 1000) refreshPids();
      if (seenGame && !gameAlive()) {
        stop(0);
        return;
      }
      if (!seenGame) return;
      if (decide(freeGb(target, spaceOf), belowGb) !== 'end') return;

      let alive = (pids || []).filter(isAlive);
      if (!alive.length) {
        refreshPids();
        alive = (pids || []).filter(isAlive);
      }
      if (!alive.length) return; // Gone by itself, or PowerShell failed: try again next poll.
      if (!alive.filter(endPid).length) return; // taskkill failed while the process lives; retry next poll.
      const marker = endedMarker(belowGb);
      try {
        fs.appendFileSync(logPath, `${marker}\n`);
      } catch {
        // The console line below still says what happened; never take the watcher down over the log.
      }
      console.log(marker);
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
  console.error('usage: node harness/disk-guard.mjs check --path <folder> --min <GB>');
  console.error('       node harness/disk-guard.mjs watch --log <run.log> --path <folder> --below <GB> [--poll-ms 5000]');
}

async function main(argv) {
  const [what, ...rest] = argv;
  const options = { what };
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === '--path') options.path = rest[++i];
    else if (rest[i] === '--log') options.log = rest[++i];
    else if (rest[i] === '--min') options.min = Number(rest[++i]);
    else if (rest[i] === '--below') options.below = Number(rest[++i]);
    else if (rest[i] === '--poll-ms') options.pollMs = Number(rest[++i]);
    else if (rest[i] === '--free-gb') options.freeGb = Number(rest[++i]); // a test's made-up figure
    else {
      console.error(`disk-guard: unknown argument ${rest[i]}`);
      usage();
      return 2;
    }
  }
  if (!['check', 'watch'].includes(options.what) || !options.path) {
    usage();
    return 2;
  }
  const spaceOf =
    options.freeGb === undefined ? space : () => ({ free: options.freeGb * GB, total: 100 * GB });
  if (options.what === 'check') {
    const minGb = options.min ?? DEFAULT_MIN_GB;
    if (!Number.isFinite(minGb) || minGb < 0) {
      usage();
      return 2;
    }
    const result = check(options.path, minGb, spaceOf);
    console.log(result.text);
    return result.ok ? 0 : 1;
  }
  if (!options.log) {
    usage();
    return 2;
  }
  const belowGb = options.below ?? DEFAULT_BELOW_GB;
  if (!Number.isFinite(belowGb) || belowGb < 0 || !Number.isFinite(options.pollMs ?? DEFAULT_POLL_MS)) {
    usage();
    return 2;
  }
  return watch(options.log, options.path, { belowGb, pollMs: options.pollMs ?? DEFAULT_POLL_MS, spaceOf });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

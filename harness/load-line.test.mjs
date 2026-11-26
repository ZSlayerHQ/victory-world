import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  comparableVerdict,
  countBuilders,
  cpuPercent,
  formatLoadLine,
  loadFailures,
  parseCommitKb,
  parseLoadLine,
  processNamesFromTasklist,
  thresholds,
} from './load-line.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'load-line.mjs');

const quiet = {
  when: 'start',
  cpu: 7,
  seconds: 5,
  freeGb: 42.1,
  totalGb: 63.8,
  commitGb: 38.2,
  commitLimitGb: 64,
  builders: 0,
};
const quietLine = 'harness: load at start: cpu 7% over 5 s, free memory 42.1 GB of 63.8, commit 38.2 of 64.0 GB, builders 0';
const noisyLine = 'harness: load at end: cpu 41% over 5 s, free memory 9.2 GB of 63.8, commit 38.2 of 64.0 GB, builders 1';

// Two logical processors whose whole interval is 200 ticks each; 100 busy of 400 is 25%.
function cpuPair(busyEach, idleEach) {
  const snap = (busy, idle) => ({ times: { user: busy, nice: 0, sys: 0, idle, irq: 0 } });
  return [
    [snap(1000, 1000), snap(1000, 1000)],
    [snap(1000 + busyEach, 1000 + idleEach), snap(1000 + busyEach, 1000 + idleEach)],
  ];
}

test('the load line has the documented shape, with made-up numbers', () => {
  assert.equal(formatLoadLine(quiet), quietLine);
  assert.equal(
    formatLoadLine({ ...quiet, when: 'end', cpu: 41.2, freeGb: 9.24, builders: 2 }),
    'harness: load at end: cpu 41.2% over 5 s, free memory 9.2 GB of 63.8, commit 38.2 of 64.0 GB, builders 2',
  );
});

test('the parser reads both ends and keeps the numbers', () => {
  assert.deepEqual(parseLoadLine(quietLine), quiet);
  assert.equal(parseLoadLine(noisyLine).when, 'end');
  assert.equal(parseLoadLine('harness: load at start: nonsense'), null);
});

test('CPU is the busy share of both samples', () => {
  const [before, after] = cpuPair(50, 150);
  assert.equal(cpuPercent(before, after), 25);
  assert.equal(cpuPercent([], []), null);
});

test('builders are counted by exact process name, never a substring', () => {
  const names = [
    'cargo.exe',
    'rustc.EXE',
    'link.exe',
    'cl.exe',
    'clang.exe',
    'cargo-clippy.exe',
    'C:\\tools\\cl.exe',
    'svchost.exe',
  ];
  assert.equal(countBuilders(names), 5);
  assert.equal(countBuilders([]), 0);
  assert.equal(countBuilders(['notepad.exe']), 0);
});

test('tasklist CSV names and Windows commit figures are read', () => {
  assert.deepEqual(
    processNamesFromTasklist('"victory.exe","12","Console","1","100 K"\r\n"cargo.exe","13","Console","1","1 K"'),
    ['victory.exe', 'cargo.exe'],
  );
  const commit = parseCommitKb('1048576 4194304');
  assert.equal(commit.commitLimitGb, 4);
  assert.equal(commit.commitGb, 3);
  assert.deepEqual(parseCommitKb('not a figure'), { commitGb: null, commitLimitGb: null });
});

test('a value at the threshold is quiet; one past it names the failed threshold', () => {
  const limits = { maxCpu: 25, minFreeMemGb: 12, maxBuilders: 0 };
  assert.deepEqual(loadFailures({ ...quiet, cpu: 25, freeGb: 12 }, limits), []);
  assert.deepEqual(loadFailures({ ...quiet, cpu: 26.2 }, limits), ['cpu 26.2% is over 25%']);
  assert.deepEqual(loadFailures({ ...quiet, freeGb: 11.9 }, limits), ['free memory 11.9 GB is under 12 GB']);
  assert.deepEqual(loadFailures({ ...quiet, builders: 1 }, limits), ['1 builders is over 0']);
});

test('the thresholds are variables with the documented defaults', () => {
  assert.deepEqual(thresholds({}), { maxCpu: 25, minFreeMemGb: 12, maxBuilders: 0 });
  assert.deepEqual(thresholds({ HARNESS_MAX_CPU: '40', HARNESS_MIN_FREE_MEM_GB: '8', HARNESS_MAX_BUILDERS: '2' }), {
    maxCpu: 40,
    minFreeMemGb: 8,
    maxBuilders: 2,
  });
});

test('the summary verdict is yes only when both ends are present and quiet', () => {
  const limits = { maxCpu: 25, minFreeMemGb: 12, maxBuilders: 0 };
  assert.deepEqual(comparableVerdict({ start: null, end: null }, limits), {
    verdict: 'unknown',
    text: 'unknown (no load lines)',
  });
  assert.deepEqual(comparableVerdict({ start: quiet, end: { ...quiet, when: 'end' } }, limits), {
    verdict: 'yes',
    text: 'yes',
  });
  const noisyStart = comparableVerdict({ start: { ...quiet, cpu: 41 }, end: { ...quiet, when: 'end' } }, limits);
  assert.equal(noisyStart.verdict, 'no');
  assert.equal(noisyStart.text, 'no (cpu 41% is over 25% at start)');
  const noisyEnd = comparableVerdict({ start: quiet, end: { ...quiet, when: 'end', builders: 2 } }, limits);
  assert.equal(noisyEnd.text, 'no (2 builders is over 0 at end)');
  assert.deepEqual(comparableVerdict({ start: quiet, end: null }, limits), {
    verdict: 'unknown',
    text: 'unknown (no end load line)',
  });
});

test('check exits 3 with one line naming the failed threshold, and 0 for a quiet line', () => {
  const bad = spawnSync(process.execPath, [script, 'check', noisyLine], { encoding: 'utf8' });
  assert.equal(bad.status, 3, bad.stderr);
  assert.equal(bad.stdout.trim(), 'cpu 41% is over 25%; free memory 9.2 GB is under 12 GB; 1 builders is over 0');

  const good = spawnSync(process.execPath, [script, 'check', quietLine], { encoding: 'utf8' });
  assert.equal(good.status, 0, good.stderr);
  assert.equal(good.stdout.trim(), '');
});

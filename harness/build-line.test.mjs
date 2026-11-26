import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildLine, buildLines, probeVersion } from './build-line.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'build-line.mjs');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'build-line-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('a lane checkout names its commit', () => {
  const line = buildLine({
    dir: '<drive>/lane',
    bin: '<drive>/builds/x/victory.exe',
    profile: 'diag',
    console: 'series-x',
    gitCommit: () => 'abc1234',
  });
  assert.equal(line, 'harness build: abc1234 profile=diag console=series-x');
});

test('a snapshot build names its folder, commit, branch and profile from snapshot.txt', (t) => {
  const dir = tempDir(t);
  const bin = path.join(dir, 'victory.exe');
  fs.writeFileSync(bin, '');
  fs.writeFileSync(
    path.join(dir, 'snapshot.txt'),
    [
      'commit: 0123456789abcdef0123456789abcdef01234567',
      'branch: job/fork',
      'profile: release',
      'features: diagnostics',
      'date: 2026-11-25T02:00:00Z',
      'lane: <drive>/lane',
      '',
    ].join('\n'),
  );
  const line = buildLine({
    dir: '<drive>/builds/x',
    bin,
    profile: 'diag',
    console: 'series-x',
    gitCommit: () => null,
  });
  assert.equal(
    line,
    `harness build: ${path.basename(dir)} profile=release console=series-x branch=job/fork`,
  );
});

test('with neither, the line keeps the blank commit the experiment table already reads', () => {
  const line = buildLine({
    dir: '<drive>/not/there',
    bin: '<drive>/not/there/victory.exe',
    profile: 'release',
    console: 'series-s',
    gitCommit: () => null,
  });
  assert.equal(line, 'harness build:  profile=release console=series-s');
});

test('a snapshot binary wins over the checkout head, which is printed separately', (t) => {
  const dir = tempDir(t);
  const bin = path.join(dir, 'victory.exe');
  fs.writeFileSync(bin, '');
  fs.writeFileSync(
    path.join(dir, 'snapshot.txt'),
    'commit: 0123456789abcdef0123456789abcdef01234567\nbranch: job/fork\nprofile: release\n',
  );
  const lines = buildLines({
    dir: '<project>/victory',
    bin,
    profile: 'diag',
    console: 'series-x',
    gitCommit: () => 'abc1234',
  });
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`^harness build: ${path.basename(dir)} profile=release`));
  assert.equal(lines[0].includes('abc1234'), false, 'the checkout head is not the binary');
  assert.equal(lines[1], 'harness checkout: abc1234');
});

test('a binary that prints a version is labelled by it, and only under the builds root is asked', (t) => {
  const dir = tempDir(t);
  const bin = path.join(dir, 'victory.exe');
  fs.writeFileSync(bin, '');
  const calls = [];
  const run = (file, args) => {
    calls.push(args[0]);
    if (args[0] === '--help') return { status: 0, stdout: 'usage: victory [--version]\n' };
    return { status: 0, stdout: 'victory 1.2.3\n' };
  };
  assert.equal(probeVersion(bin, { buildsRoot: dir, run }), 'victory 1.2.3');
  assert.deepEqual(calls, ['--help', '--version']);
  // Outside the builds root nothing is executed.
  assert.equal(
    probeVersion(bin, {
      buildsRoot: path.join(dir, 'other'),
      run: () => {
        throw new Error('must not run');
      },
    }),
    null,
  );
  // A help text with no version flag is not probed further.
  assert.equal(
    probeVersion(bin, {
      buildsRoot: dir,
      run: () => ({ status: 0, stdout: 'usage: victory run <game>\n' }),
    }),
    null,
  );
  const line = buildLine({ dir: '<drive>/not/a/repo', bin, profile: 'diag', console: 'series-x', gitCommit: () => null, version: 'victory 1.2.3' });
  assert.equal(line, 'harness build: victory 1.2.3 profile=diag console=series-x');
});

test('the CLI prints only the build line when no checkout can be named', (t) => {
  const dir = tempDir(t);
  const bin = path.join(dir, 'victory.exe');
  fs.writeFileSync(bin, '');
  const result = spawnSync(process.execPath, [script, '<drive>/not/a/checkout', bin, 'diag', 'series-x'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'harness build:  profile=diag console=series-x');
});

test('the CLI prints the line run-world.sh writes into the log', (t) => {
  const dir = tempDir(t);
  const bin = path.join(dir, 'victory.exe');
  fs.writeFileSync(bin, '');
  fs.writeFileSync(
    path.join(dir, 'snapshot.txt'),
    'commit: 89abcdef0123456789abcdef0123456789abcdef\nbranch: job/laptop\nprofile: diag\n',
  );
  const result = spawnSync(process.execPath, [script, '<drive>/not/a/checkout', bin, 'diag', 'series-x'], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(
    result.stdout.trim(),
    `harness build: ${path.basename(dir)} profile=diag console=series-x branch=job/laptop`,
  );
});

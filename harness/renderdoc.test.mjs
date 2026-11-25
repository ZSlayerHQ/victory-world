import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { captureCommand, triggerScript } from './renderdoc.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'renderdoc.mjs');

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'renderdoc-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const OPTIONS = {
  renderdocDir: '<project>/tools/renderdoc/RenderDoc_1.47_64',
  bin: '<drive>/victory-work/target/diag/victory.exe',
  dir: '<drive>/victory-work',
  gameArgs: ['run', '<drive>/Games/the title/the title.exe', '--execute', '--console', 'series-x'],
  out: '/captures/20261125-080000-rdoc/rdoc',
  afterMs: 290000,
};

test('the capture command launches the run with the working directory, the template and the game arguments', () => {
  const command = captureCommand(OPTIONS);
  assert.equal(command.file, path.join(OPTIONS.renderdocDir, 'renderdoccmd.exe'));
  assert.deepEqual(command.args, [
    'capture',
    '-d',
    '<drive>/victory-work',
    '-c',
    path.join(OPTIONS.out, 'capture'),
    '-w',
    '<drive>/victory-work/target/diag/victory.exe',
    'run',
    '<drive>/Games/the title/the title.exe',
    '--execute',
    '--console',
    'series-x',
  ]);
});

test('a path with spaces stays one argument, and the delay is required', () => {
  const command = captureCommand({ ...OPTIONS, bin: '<drive>/a folder/victory.exe' });
  assert.equal(command.args[6], '<drive>/a folder/victory.exe');
  assert.throws(() => captureCommand({ ...OPTIONS, afterMs: undefined }), /--capture-after-ms is required/);
  assert.throws(() => triggerScript(0), /--capture-after-ms is required/);
});

test('the trigger script waits, finds the target control and captures one frame', () => {
  const source = triggerScript(290000);
  assert.match(source, /time\.sleep\(290000 \/ 1000\.0\)/);
  assert.match(source, /EnumerateRemoteTargets\('', 38920\)/);
  assert.match(source, /CreateTargetControl\('', targets\[0\], 'victory-harness', False\)/);
  assert.match(source, /TriggerCapture\(1\)/);
  assert.match(source, /NewCapture/);
});

test('the command line assembles the same capture line from files', (t) => {
  const dir = tempDir(t);
  const gameArgs = path.join(dir, 'game-args.txt');
  fs.writeFileSync(gameArgs, 'run\nvictory.exe\n--execute\n--console\nseries-x\n');
  const result = run([
    'print',
    '--renderdoc',
    OPTIONS.renderdocDir,
    '--bin',
    OPTIONS.bin,
    '--dir',
    OPTIONS.dir,
    '--game-args-file',
    gameArgs,
    '--out',
    OPTIONS.out,
    '--after-ms',
    '290000',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(
    result.stdout,
    /renderdoccmd\.exe capture -d .*victory-work -c .*capture -w .*victory\.exe run victory\.exe --execute --console series-x/,
  );
  const missing = run(['print', '--bin', 'x', '--dir', 'y', '--game-args-file', gameArgs, '--out', 'z']);
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--capture-after-ms is required/);
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { commandFor, ngfxPath, quoteArg } from './gpu-trace.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'gpu-trace.mjs');

function run(args, options = {}) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', ...options });
}

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gpu-trace-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A fake Program Files tree with the two installs named as Nsight names them.
function fakeProgramFiles(t) {
  const root = tempDir(t);
  for (const version of ['2025.1.0', '2026.4.0']) {
    fs.mkdirSync(path.join(root, 'NVIDIA Corporation', `Nsight Graphics ${version}`, 'host', 'windows-desktop-nomad-x64'), {
      recursive: true,
    });
  }
  return root;
}

const OPTIONS = {
  bin: '<drive>/victory-work/target/diag/victory.exe',
  dir: '<drive>/victory-work',
  gameArgs: ['run', '<drive>/Games/the title/the title.exe', '--execute', '--console', 'series-x'],
  envPairs: ['VICTORY_LOG=info', 'VICTORY_WAVE64_EMULATE=emulate', 'VICTORY_D3D12_DRED=1'],
  afterMs: 150000,
  out: '/captures/20261125-073000-trace/gputrace',
};

test('the command is Nsight GPU Trace around the run, with the environment joined as it wants', () => {
  const command = commandFor({ ...OPTIONS, exe: '<drive>/Program Files/NVIDIA Corporation/Nsight Graphics 2026.4.0/host/ngfx.exe' });
  assert.equal(command.file, '<drive>/Program Files/NVIDIA Corporation/Nsight Graphics 2026.4.0/host/ngfx.exe');
  assert.deepEqual(command.args, [
    '--activity',
    'GPU Trace Profiler',
    '--exe',
    '<drive>/victory-work/target/diag/victory.exe',
    '--dir',
    '<drive>/victory-work',
    '--args',
    'run "<drive>/Games/the title/the title.exe" --execute --console series-x',
    '--env',
    'VICTORY_LOG=info; VICTORY_WAVE64_EMULATE=emulate; VICTORY_D3D12_DRED=1;',
    '--start-after-ms',
    '150000',
    '--limit-to-frames',
    '1',
    '--set-gpu-clocks',
    'unaltered',
    '--auto-export',
    '--output-dir',
    '/captures/20261125-073000-trace/gputrace',
  ]);
});

test('a path with spaces is one argument, and only the game line needs quoting', () => {
  assert.equal(quoteArg('<drive>/Games/the title/the title.exe'), '"<drive>/Games/the title/the title.exe"');
  assert.equal(quoteArg('--execute'), '--execute');
  const command = commandFor({ ...OPTIONS, bin: '<drive>/a folder/victory.exe', exe: 'x/ngfx.exe' });
  assert.equal(command.args[3], '<drive>/a folder/victory.exe', 'argv keeps the path whole; no manual quoting');
});

test('without --trace-after-ms it refuses, rather than tracing the loading screen', () => {
  assert.throws(() => commandFor({ ...OPTIONS, afterMs: undefined, exe: 'x/ngfx.exe' }), /--trace-after-ms is required/);
  assert.throws(() => commandFor({ ...OPTIONS, afterMs: 0, exe: 'x/ngfx.exe' }), /refusing to trace the loading screen/);
});

test('the newest Nsight install under Program Files is found, and VICTORY_NGFX wins', (t) => {
  const root = fakeProgramFiles(t);
  assert.match(ngfxPath(root, {}), /Nsight Graphics 2026\.4\.0[/\\]host[/\\]windows-desktop-nomad-x64[/\\]ngfx\.exe$/);
  assert.equal(ngfxPath(root, { VICTORY_NGFX: 'tools/ngfx.exe' }), 'tools/ngfx.exe');
  const empty = tempDir(t);
  assert.equal(ngfxPath(empty, {}), null);
  assert.throws(() => commandFor({ ...OPTIONS, programFiles: empty, env: {} }), /no Nsight Graphics found/);
});

test('the command line refuses the same way and can print its command', (t) => {
  const dir = tempDir(t);
  const gameArgs = path.join(dir, 'game-args.txt');
  const envFile = path.join(dir, 'env.txt');
  fs.writeFileSync(gameArgs, 'run\nvictory.exe\n--execute\n--console\nseries-x\n');
  fs.writeFileSync(envFile, 'A=1\nB=2\n');
  const common = ['--bin', 'work/victory.exe', '--dir', 'work', '--game-args-file', gameArgs, '--env-file', envFile, '--out', path.join(dir, 'gputrace')];
  let result = run(['run', ...common]);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /--trace-after-ms is required/);
  result = run(['print', ...common, '--after-ms', '150000'], { env: { ...process.env, VICTORY_NGFX: 'tools/ngfx.exe' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /tools\/ngfx\.exe --activity "GPU Trace Profiler" --exe work\/victory\.exe/);
});

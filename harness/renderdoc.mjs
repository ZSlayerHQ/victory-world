#!/usr/bin/env node
// Runs one VIctory world run under RenderDoc and captures one frame after a delay, headless.
//
//   node harness/renderdoc.mjs print --renderdoc <dir> --bin <victory.exe> --dir <VICTORY_DIR>
//        --game-args-file <file> --out <dir> --after-ms <ms>
//   node harness/renderdoc.mjs script --after-ms <ms>        (prints the trigger script)
//
// `renderdoccmd capture` has no delay or frame-count option: it launches the application with RenderDoc loaded
// and captures when told to. The capture is triggered by a small Python script run by `qrenderdoc --python`,
// which connects to the running application's target control (port 38920) and calls TriggerCapture after the
// delay. This path is documented in RenderDoc's shipped help (`python_api/in_depth/launching_programs.html`,
// `renderdoc/capturing.html`) and is unverified until the first real capture.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DEFAULT_RENDERDOC = '<project>/tools/renderdoc/RenderDoc_1.47_64';

export function renderdocPaths(dir = DEFAULT_RENDERDOC) {
  return {
    cmd: path.join(dir, 'renderdoccmd.exe'),
    ui: path.join(dir, 'qrenderdoc.exe'),
  };
}

export function captureCommand(options) {
  const { renderdocDir, bin, dir, gameArgs, out } = options;
  const { cmd } = renderdocPaths(renderdocDir);
  if (!(Number(options.afterMs) > 0)) {
    throw new Error('--capture-after-ms is required: refusing to capture the loading screen');
  }
  return {
    file: cmd,
    args: ['capture', '-d', dir, '-c', path.join(out, 'capture'), '-w', bin, ...gameArgs],
  };
}

/// The script qrenderdoc runs: waits, triggers one capture on the running application, prints its path.
export function triggerScript(afterMs) {
  if (!(Number(afterMs) > 0)) throw new Error('--capture-after-ms is required');
  return `import sys
import time

import renderdoc

time.sleep(${Number(afterMs)} / 1000.0)
targets = renderdoc.EnumerateRemoteTargets('', 38920)
if len(targets) != 1:
    print(f'renderdoc: expected one target, found {len(targets)}', file=sys.stderr)
    sys.exit(1)
control = renderdoc.CreateTargetControl('', targets[0], 'victory-harness', False)
if control is None:
    print('renderdoc: could not connect to the target', file=sys.stderr)
    sys.exit(1)
control.TriggerCapture(1)
deadline = time.time() + 120
while time.time() < deadline:
    message = control.ReceiveMessage(100)
    if message is not None and message.type == renderdoc.TargetControlMessageType.NewCapture:
        print('capture:', message.newCapture.path)
        sys.exit(0)
print('renderdoc: no capture arrived', file=sys.stderr)
sys.exit(1)
`;
}

const lines = (file) =>
  fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .filter((line) => line.trim() !== '');

function usage() {
  console.error(
    'usage: node renderdoc.mjs print --renderdoc <dir> --bin <victory.exe> --dir <VICTORY_DIR> ' +
      '--game-args-file <file> --out <dir> --after-ms <ms> | script --after-ms <ms>',
  );
}

function main(argv) {
  const [what, ...rest] = argv;
  const options = { what };
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (arg === '--renderdoc') options.renderdocDir = rest[++i];
    else if (arg === '--bin') options.bin = rest[++i];
    else if (arg === '--dir') options.dir = rest[++i];
    else if (arg === '--game-args-file') options.gameArgsFile = rest[++i];
    else if (arg === '--out') options.out = rest[++i];
    else if (arg === '--after-ms') options.afterMs = Number(rest[++i]);
    else {
      console.error(`renderdoc: unknown argument ${arg}`);
      return 2;
    }
  }
  try {
    if (what === 'script') {
      console.log(triggerScript(options.afterMs));
      return 0;
    }
    if (!['print', 'run'].includes(what)) throw new Error('expected print, run or script');
    for (const needed of ['bin', 'dir', 'gameArgsFile', 'out']) {
      if (!options[needed]) throw new Error(`--${needed.replace(/File$/, '-file')} is required`);
    }
    const command = captureCommand({
      renderdocDir: options.renderdocDir,
      bin: options.bin,
      dir: options.dir,
      gameArgs: lines(options.gameArgsFile),
      out: options.out,
      afterMs: options.afterMs,
    });
    if (what === 'run') {
      const result = spawnSync(command.file, command.args, { stdio: 'inherit' });
      if (result.error) throw new Error(result.error.message);
      return result.status ?? 1;
    }
    const quote = (s) => (/[\s"]/.test(s) ? `"${s.replace(/"/g, '\\"')}"` : s);
    console.log([command.file, ...command.args].map(quote).join(' '));
    return 0;
  } catch (err) {
    console.error(`renderdoc: ${err.message}`);
    return 2;
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) process.exit(main(process.argv.slice(2)));

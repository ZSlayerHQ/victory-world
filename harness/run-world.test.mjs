import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { isolatedEnv } from './test-isolation.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'run-world.sh');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-world-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// A harness run needs an executable and a folder outside every work tree; the shell itself stands in for the game
// binary, and --print-env stops the script before anything is started.
function printEnv(t, args) {
  const dir = tempDir(t);
  const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(dir, 'victory.toml'), '');
  const result = spawnSync('bash', [script, ...args, '--print-env'], {
    encoding: 'utf8',
    env: isolatedEnv({
      VICTORY_BIN: bash,
      VICTORY_DIR: dir,
      VICTORY_CONFIG: path.join(dir, 'victory.toml'),
      GAME_EXE: path.join(dir, 'game.exe'),
      VICTORY_CAPTURES: path.join(dir, 'captures'),
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  return new Set(result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
}

test('--dump-targets sets the unsafe flag beside the targets and keeps the frame list', (t) => {
  const env = printEnv(t, ['--dump-targets', '--frames', '2400,2600']);
  assert.equal(env.has('VICTORY_DUMP_TARGETS=1'), true);
  assert.equal(env.has('VICTORY_DUMP_UNSAFE=1'), true, 'the runtime refuses the targets without it');
  assert.equal(env.has('VICTORY_CAPTURE_FRAMES=2400,2600'), true);
});

test('without --dump-targets neither dump variable is passed', (t) => {
  const env = printEnv(t, ['--frames', '2400,2600']);
  for (const line of env) assert.doesNotMatch(line, /^VICTORY_DUMP_/);
});

test('a direct run is refused unless it holds the lock; --print-env and --help are allowed', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'victory.toml'), '');
  const env = isolatedEnv({
    VICTORY_BIN: spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim(),
    VICTORY_DIR: dir,
    VICTORY_CONFIG: path.join(dir, 'victory.toml'),
    GAME_EXE: path.join(dir, 'game.exe'),
    VICTORY_CAPTURES: path.join(dir, 'captures'),
  });
  const refused = spawnSync('bash', [script, '--tag', 'lockless', '--no-record'], { encoding: 'utf8', env });
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /WORLD_RUN_HOLDS_LOCK=1/);
  const help = spawnSync('bash', [script, '--help'], { encoding: 'utf8', env });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /usage: run-world\.sh/);
  // --print-env is exercised by every test above without the lock.
  const envRun = spawnSync('bash', [script, '--print-env'], { encoding: 'utf8', env });
  assert.equal(envRun.status, 0, envRun.stderr);
});

test('a run refuses to start when the logs drive is below the minimum', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'victory.toml'), '');
  const result = spawnSync('bash', [script, '--tag', 'lowdisk', '--no-record'], {
    encoding: 'utf8',
    env: isolatedEnv({
      VICTORY_BIN: spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim(),
      VICTORY_DIR: dir,
      VICTORY_CONFIG: path.join(dir, 'victory.toml'),
      GAME_EXE: path.join(dir, 'game.exe'),
      VICTORY_CAPTURES: path.join(dir, 'captures'),
      WORLD_RUN_HOLDS_LOCK: '1',
      HARNESS_MIN_FREE_GB: '999999',
    }),
  });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /refused: disk .* below 999999 GB/);
});

test('the heartbeat reads only the log tail, not the whole file', () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /HEARTBEAT_TAIL_BYTES=65536/);
  assert.match(text, /tail -c "\$HEARTBEAT_TAIL_BYTES" "\$LOG"/);
  assert.equal(/grep -aE ' fps, [0-9.]+ ms\/frame' "\$LOG"/.test(text), false, 'not the whole log');
});

test('game output goes to the log only; the terminal goes through the public filter', () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.equal(/tee -a "\$LOG"/.test(text), false, 'no tee of the game output');
  assert.equal(text.includes('tail -2 "$LOG"'), false, 'a failed save reports the log, not its lines');
  assert.match(text, /\. "\$HERE\/public-lines\.sh"/);
  assert.match(text, /"\$BIN" run "\$GAME_EXE" --execute --console "\$CONSOLE"\) \\\n\s+>>"\$LOG" 2>&1/);
  assert.match(text, /--out "\$CAPTURE\/gputrace" \\\n\s+>>"\$LOG" 2>&1/);
  assert.match(text, /--out "\$CAPTURE\/rdoc" --after-ms "\$CAPTURE_AFTER_MS" \\\n\s+>>"\$LOG" 2>&1/);
  for (const line of ['log:', 'capture:', 'profile:'])
    assert.match(text, new RegExp(`say "${line}`), line);
  assert.match(text, /cat "\$LOG\.md" \| public_line/);
  assert.match(text, /heartbeat_loop &/);
  // The header records values, not private paths.
  assert.match(text, /harness_env_line "\$E"/);
  assert.match(text, /harness_env_line "\$NAME=\$\{!NAME\}"/);
  assert.match(text, /capture: \$\(harness_public_path "\$CAPTURE"\)/);
});

test('the warm-up exit code and seconds are written to the run log, not only the terminal', () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /WARM_LINE="warm-up: exit=\$WARM_RC after /);
  assert.match(text, /printf '%s\\n' "\$WARM_LINE" >>"\$LOG"/);
  assert.match(text, /\n  say "\$WARM_LINE"\n/);
});

test('the load is sampled before the game starts and after it ends', () => {
  const text = fs.readFileSync(script, 'utf8');
  const start = text.indexOf('load-line.mjs" start');
  const game = text.indexOf('"$BIN" run "$GAME_EXE"');
  const end = text.indexOf('load-line.mjs" end');
  assert.ok(start > 0, 'the start load line is written');
  assert.ok(game > start, 'the start load is taken before the game starts');
  assert.ok(end > game, 'the end load is taken after the game ends');
  assert.match(text, /printf 'harness: load start exit=%s\\n' "\$LOAD_START_RC"/);
  assert.match(text, /printf 'harness: load end exit=%s\\n' "\$\?"/);
});

test('--require-quiet refuses a busy start with exit 3 and is off by default', () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /--require-quiet\) REQUIRE_QUIET=1/);
  assert.match(text, /REQUIRE_QUIET=0/);
  assert.match(text, /load-line\.mjs" check "\$LOAD_START"/);
  assert.match(text, /say_err "refused: \$\{QUIET_REASON/);
  assert.match(text, /exit 3/);
  assert.match(text, /\[--require-quiet\]/);
});

test('each helper exit is recorded, and the summary is renamed into place', () => {
  const text = fs.readFileSync(script, 'utf8');
  for (const step of ['disk-usage', 'feed', 'driver-events', 'summary']) {
    assert.match(text, new RegExp(`harness: ${step} exit=`), step);
  }
  assert.match(text, /summarize-run\.mjs" "\$LOG" >"\$LOG\.md\.tmp"/);
  assert.match(text, /mv -f "\$LOG\.md\.tmp" "\$LOG\.md"/);
  assert.doesNotMatch(text, /driver-events\.ps1.*2>\/dev\/null/);
  assert.doesNotMatch(text, /disk-usage\.mjs[^\n]*\|\| true/);
  assert.doesNotMatch(text, /precompile-progress\.mjs" final[^\n]*\|\| true/);
});

test('both scripts are one main() read whole before it runs', () => {
  for (const name of ['run-world.sh', 'world-run.sh']) {
    const text = fs.readFileSync(path.join(here, name), 'utf8');
    assert.match(text, /^main\(\) \{$/m, `${name} wraps its body in main()`);
    assert.match(text, /^main "\$@"$/m, `${name} calls main with the arguments`);
  }
});

test('--live creates an empty control file in the run capture folder and passes its path', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-world-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(dir, 'victory.toml'), '');
  const result = spawnSync('bash', [script, '--live', '--print-env'], {
    encoding: 'utf8',
    env: isolatedEnv({
      VICTORY_BIN: bash,
      VICTORY_DIR: dir,
      VICTORY_CONFIG: path.join(dir, 'victory.toml'),
      GAME_EXE: path.join(dir, 'game.exe'),
      VICTORY_CAPTURES: path.join(dir, 'captures'),
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  const liveLine = result.stdout.split(/\r?\n/).find((line) => line.startsWith('VICTORY_LIVE='));
  assert.ok(liveLine, 'the runtime receives VICTORY_LIVE');
  assert.match(liveLine, /\/live\.txt$/, 'the control file is in the capture folder');
  assert.match(result.stdout, /^live:\s+live\.txt$/m, 'the terminal sees the file name only');

  const captures = path.join(dir, 'captures');
  const folders = fs.readdirSync(captures);
  assert.equal(folders.length, 1);
  const control = path.join(captures, folders[0], 'live.txt');
  assert.equal(fs.existsSync(control), true, 'the control file is created before the run');
  assert.equal(fs.statSync(control).size, 0, 'it starts empty');
});

test('--live writes the header line with the control file name, as the other switches do', () => {
  const text = fs.readFileSync(script, 'utf8');
  assert.match(text, /--live\) LIVE=1/);
  assert.match(text, /LIVE_FILE=\$\{CAPTURE%\/\}\/live\.txt/);
  assert.match(text, /: >"\$LIVE_FILE"/);
  assert.match(text, /ENV_ARGS\+=\("VICTORY_LIVE=\$LIVE_FILE"\)/);
  assert.match(text, /say "live: +\$\(basename "\$LIVE_FILE"\)"/);
  assert.match(text, /echo "harness env: live=\$\(basename "\$LIVE_FILE"\)"/);
  assert.match(text, /\[--live\]/);
});

test('--gpu-trace prints the Nsight command it would run, and the run starts the game under it', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-world-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const bash = spawnSync('bash', ['-c', 'command -v bash'], { encoding: 'utf8' }).stdout.trim();
  fs.writeFileSync(path.join(dir, 'victory.toml'), '');
  const result = spawnSync('bash', [script, '--gpu-trace', '--trace-after-ms', '330000', '--print-env'], {
    encoding: 'utf8',
    env: isolatedEnv({
      VICTORY_BIN: bash,
      VICTORY_DIR: dir,
      VICTORY_CONFIG: path.join(dir, 'victory.toml'),
      GAME_EXE: path.join(dir, 'game.exe'),
      VICTORY_CAPTURES: path.join(dir, 'captures'),
      VICTORY_NGFX: 'tools/ngfx.exe',
    }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gpu-trace: tools\/ngfx\.exe --activity "GPU Trace Profiler" --exe /);
  assert.match(result.stdout, /--start-after-ms 330000/);
  assert.match(result.stdout, /--output-dir .*gputrace/);
});

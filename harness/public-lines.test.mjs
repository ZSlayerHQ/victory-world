import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const library = path.join(here, 'public-lines.sh').replaceAll('\\', '/');

// Runs a bash script with public-lines.sh sourced. Stdout and stderr come back separately.
function bash(t, body, env = {}) {
  const file = path.join(os.tmpdir(), `public-lines-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, `set -u\n. '${library}'\n${body}\n`);
  t.after(() => fs.rmSync(file, { force: true }));
  const result = spawnSync('bash', [file], {
    encoding: 'utf8',
    env: { ...process.env, HOME: '/made/up/home', USERPROFILE: 'C:\\made\\up\\home', ...env },
  });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return { out: result.stdout, err: result.stderr };
}

test('public_line drops game output and any line carrying a drive path or the home folder', (t) => {
  const lines = [
    '2026-11-26T00:00:00Z INFO victory: storage at <drive>/Games/the title/foo',
    '2026-11-26T00:00:00Z INFO victory: token <drive>/Users/someone/token',
    'a line under /made/up/home/.config',
    'a line the allow-list does not name',
    'harness: victory exit=0',
    'heartbeat: 30.0 fps, 33.3 ms/frame, 12 draws, dropped 0',
    'FPS: 4 samples, median 30.0',
    'Screen record: none',
    '',
  ];
  const { out } = bash(t, `cat <<'LINES' | public_line\n${lines.join('\n')}\nLINES`);
  assert.equal(out, 'harness: victory exit=0\nheartbeat: 30.0 fps, 33.3 ms/frame, 12 draws, dropped 0\nFPS: 4 samples, median 30.0\nScreen record: none\n\n');
});

test('say and say_err put one line through the same filter', (t) => {
  const { out, err } = bash(t, "say 'harness: one'; say_err 'refused: two'; say 'game line <drive>/Games/x'; say_err 'game line <drive>/Games/y'");
  assert.equal(out, 'harness: one\n');
  assert.equal(err, 'refused: two\n');
});

test('the heartbeat is built from the frame-rate line and carries only its numbers', (t) => {
  const frame =
    '\x1b[2m2026-11-26T04:56:35.501134Z\x1b[0m \x1b[32m INFO\x1b[0m ' +
    '\x1b[2mvictory_gpu::host\x1b[0m\x1b[2m:\x1b[0m 30.0 fps, 33.3 ms/frame ' +
    '(0.2 preparing: copies 0.1 ms 0.2 MB, textures 0.0 ms 0.0 MB; 0.9 on the GPU; 0.0 copying back 0.0 MB), ' +
    '12 draws/frame, dropped 3 without a host pipeline (0 being made) and 1 indirect';
  const { out } = bash(t, `read -r line <<'FRAME'\n${frame}\nFRAME\nheartbeat_line "$line"`);
  assert.equal(out, 'heartbeat: 30.0 fps, 33.3 ms/frame, 12 draws, dropped 3\n');
});

test('the heartbeat reads the frame line that starts with its frame number too', (t) => {
  const frame =
    '\x1b[2m2026-11-26T05:02:11.250000Z\x1b[0m \x1b[32m INFO\x1b[0m ' +
    '\x1b[2mvictory_gpu::host\x1b[0m\x1b[2m:\x1b[0m ' +
    'frame 18432, 27.4 fps, 36.5 ms/frame (0.4 preparing: copies 0.3 ms 1.2 MB, ' +
    'textures hashed 0.2 ms 0.1 MB; 1.7 on the GPU; 0.1 copying back 0.9 MB), ' +
    '5000 draws/frame, dropped 3 without a host pipeline (1 being made) and 7 indirect';
  const { out } = bash(t, `read -r line <<'FRAME'\n${frame}\nFRAME\nheartbeat_line "$line"`);
  assert.equal(out, 'heartbeat: 27.4 fps, 36.5 ms/frame, 5000 draws, dropped 3\n');
});

test('the header keeps values under the three roots and replaces every other path', (t) => {
  const body = [
    "harness_env_line 'VICTORY_CONFIG=<project>/victory/victory.toml'",
    "harness_env_line 'VICTORY_BUILD=/snapshots/snapshot-a'",
    "harness_env_line 'VICTORY_CAPTURE=E:\\victory-captures\\20261126-000000-run'",
    "harness_env_line 'VICTORY_PRIVATE=<drive>/Users/someone/private'",
    "harness_env_line 'VICTORY_SAVE=<drive>/saves/title'",
    "harness_env_line 'VICTORY_COPY_MODE=none'",
    "harness_env_line 'VICTORY_KEYS=55:Enter'",
  ].join('; ');
  const { out } = bash(t, body);
  assert.equal(
    out,
    [
      'harness env: VICTORY_CONFIG=<project>/victory/victory.toml',
      'harness env: VICTORY_BUILD=/snapshots/snapshot-a',
      'harness env: VICTORY_CAPTURE=E:\\victory-captures\\20261126-000000-run',
      'harness env: VICTORY_PRIVATE=set, outside the repository',
      'harness env: VICTORY_SAVE=set, outside the repository',
      'harness env: VICTORY_COPY_MODE=none',
      'harness env: VICTORY_KEYS=55:Enter',
      '',
    ].join('\n'),
  );
});

test('a path outside the roots is replaced, and one under a root is not', (t) => {
  const { out } = bash(t, "harness_public_path '/captures/run'; echo; harness_public_path '<drive>/Users/me/run'; echo");
  assert.equal(out, '/captures/run\nset, outside the repository\n');
});

test('the summary\'s comparable line reaches the terminal', (t) => {
  const { out } = bash(t, "printf '%s\n' 'comparable: no (cpu 41% is over 25% at start)' | public_line");
  assert.equal(out, 'comparable: no (cpu 41% is over 25% at start)\n');
});

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { LOCAL_ENV_NAMES, loadLocalEnv, parseLocalEnv } from './local-env.mjs';
import { captureFolderFromLog, capturesRoot } from './presentmon.mjs';
import { saveBackupsRoot } from './save-snapshot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BS = String.fromCharCode(92);

function tempFile(t, name, text) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, text);
  return { dir, file };
}

// An environment with none of the names local.env may set, so the machine's own settings cannot leak into a test.
function bareEnv(extra = {}) {
  const env = { ...process.env };
  for (const name of LOCAL_ENV_NAMES) delete env[name];
  delete env.VICTORY_LOCAL_ENV;
  return { ...env, ...extra };
}

test('parse: comments, blanks, export, quotes, spaces, = and backslashes in a value', () => {
  const text = [
    '# this machine',
    '',
    'GAME_EXE="<drive>/Games/Some Title/game.exe"',
    "export VICTORY_CAPTURES='<drive>/caps'",
    `VICTORY_BUILDS=D:${BS}builds${BS}`,
    'VICTORY_REPO=<drive>/x=y/victory   ',
  ].join('\r\n');
  const { values, warnings } = parseLocalEnv(text);
  assert.deepEqual(values, {
    GAME_EXE: '<drive>/Games/Some Title/game.exe',
    VICTORY_CAPTURES: '<drive>/caps',
    VICTORY_BUILDS: `D:${BS}builds${BS}`,
    VICTORY_REPO: '<drive>/x=y/victory',
  });
  assert.deepEqual(warnings, []);
});

test('parse: a name outside the list is ignored, and the warning gives the line and name, never the value', () => {
  const { values, warnings } = parseLocalEnv('PATH=<drive>/secret-folder\nGAME_EXE=<drive>/g.exe\n');
  assert.deepEqual(values, { GAME_EXE: '<drive>/g.exe' });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /line 1/);
  assert.match(warnings[0], /PATH/);
  assert.doesNotMatch(warnings[0], /secret-folder/);
});

test('parse: VICTORY_ALLOW_OBS can never come from the file (a decision)', () => {
  const { values, warnings } = parseLocalEnv('VICTORY_ALLOW_OBS=1\n');
  assert.deepEqual(values, {});
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /VICTORY_ALLOW_OBS/);
  assert.equal(LOCAL_ENV_NAMES.includes('VICTORY_ALLOW_OBS'), false);
});

test('parse: a malformed line is skipped with its line number only', () => {
  const { values, warnings } = parseLocalEnv('just a path <drive>/private\n9BAD=x\n');
  assert.deepEqual(values, {});
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /line 1/);
  assert.match(warnings[1], /line 2/);
  for (const w of warnings) assert.doesNotMatch(w, /private/);
});

test('load: the environment wins, an empty variable counts as unset, and the applied names come back', (t) => {
  const { file } = tempFile(t, 'local.env', 'GAME_EXE=<drive>/file.exe\nVICTORY_CAPTURES=<drive>/caps\nVICTORY_BUILDS=<drive>/builds\n');
  const env = { GAME_EXE: '<drive>/from-env.exe', VICTORY_CAPTURES: '' };
  const applied = loadLocalEnv({ file, env, warn: () => {} });
  assert.deepEqual(applied.sort(), ['VICTORY_BUILDS', 'VICTORY_CAPTURES']);
  assert.equal(env.GAME_EXE, '<drive>/from-env.exe');
  assert.equal(env.VICTORY_CAPTURES, '<drive>/caps');
  assert.equal(env.VICTORY_BUILDS, '<drive>/builds');
});

test('load: no file is no change and no error', () => {
  const env = {};
  assert.deepEqual(loadLocalEnv({ file: path.join(os.tmpdir(), 'no-such-dir-xyz', 'local.env'), env }), []);
  assert.deepEqual(env, {});
});

test('load: VICTORY_LOCAL_ENV names the file', (t) => {
  const { file } = tempFile(t, 'other.env', 'PRESENTMON_EXE=<drive>/pm.exe\n');
  const env = { VICTORY_LOCAL_ENV: file };
  assert.deepEqual(loadLocalEnv({ env }), ['PRESENTMON_EXE']);
  assert.equal(env.PRESENTMON_EXE, '<drive>/pm.exe');
});

test('shell loader: values arrive literally, the environment wins, and nothing is expanded', (t) => {
  const value = `<drive>/My Games/a $HOME b${BS}c/game.exe`;
  const { file } = tempFile(t, 'local.env', `GAME_EXE=${value}\nVICTORY_CAPTURES=<drive>/caps\nVICTORY_BUILDS=<drive>/b\n`);
  const script = [
    `. "${here.split(BS).join('/')}/local-env.sh"`,
    `load_local_env "${here.split(BS).join('/')}"`,
    'printf "%s\\n" "$GAME_EXE" "$VICTORY_CAPTURES" "$VICTORY_BUILDS"',
  ].join('\n');
  const result = spawnSync('bash', ['-c', script], {
    encoding: 'utf8',
    env: bareEnv({ VICTORY_LOCAL_ENV: file, VICTORY_BUILDS: '<drive>/env-wins' }),
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(result.stdout.split(/\r?\n/).slice(0, 3), [value, '<drive>/caps', '<drive>/env-wins']);
});

test('run-world.sh builds the capture folder under VICTORY_CAPTURES', (t) => {
  const { dir } = tempFile(t, 'unused', '');
  const caps = path.join(dir, 'caps').split(BS).join('/');
  const result = spawnSync('bash', [path.join(here, 'run-world.sh'), '--tag', 'localenvtest', '--no-record'], {
    encoding: 'utf8',
    env: bareEnv({
      VICTORY_LOCAL_ENV: path.join(dir, 'none.env'),
      VICTORY_CAPTURES: caps,
      VICTORY_BIN: path.join(dir, 'no-such-victory.exe'),
    }),
  });
  assert.equal(result.status, 2, 'stops at the missing binary');
  const made = fs.readdirSync(caps);
  assert.equal(made.length, 1);
  assert.match(made[0], /^\d{8}-\d{6}-localenvtest$/);
});

test('capture root: VICTORY_CAPTURES, else /captures, used for the log-name fallback', () => {
  assert.equal(capturesRoot({}), '/captures');
  assert.equal(capturesRoot({ VICTORY_CAPTURES: `D:${BS}caps${BS}` }), `D:${'/'}caps`);
  assert.equal(
    captureFolderFromLog(['harness build: abc'], '<drive>/r/harness/logs/20261124-120000-beta.log', '<drive>/caps/'),
    '<drive>/caps/20261124-120000-beta',
  );
  // A capture: line still wins over any root.
  assert.equal(
    captureFolderFromLog(['capture: /captures/20261124-120000-alpha'], 'x/20261124-120000-beta.log', '<drive>/caps'),
    '/captures/20261124-120000-alpha',
  );
});

test('save backups root: VICTORY_SAVE_BACKUPS, else <drive>/the title-save-backups', () => {
  assert.equal(saveBackupsRoot({}), '<drive>/the title-save-backups');
  assert.equal(saveBackupsRoot({ VICTORY_SAVE_BACKUPS: `D:${BS}saves${BS}` }), `D:${'/'}saves`);
});

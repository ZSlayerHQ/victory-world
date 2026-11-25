import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { dataDir, measure, oneFolder, restore, saveAs, saveFolder } from './save-snapshot.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'save-snapshot.mjs');
const GUID = '0f0f0f0f-0000-4000-8000-000000000000';

function runSnapshot(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

// A data folder laid out as the runtime makes it, with one container in the config folder.
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'victory-saves-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const data = path.join(root, 'data');
  const folder = path.join(data, '0000ABCD', 'saves', '0009000000000001', GUID);
  writeFile(path.join(folder, 'SAVE0001~0123456789abcdef', 'v1', 'manifest'), 'a-manifest');
  writeFile(path.join(folder, 'SAVE0001~0123456789abcdef', 'v1', '0'), 'save-data');
  writeFile(path.join(folder, 'SAVE0001~0123456789abcdef', 'v1', '1'), 'save-header');
  const toml = path.join(root, 'victory.toml');
  writeFile(toml, `[paths]\ndata_dir = '${data}'\n`);
  const snapshot = path.join(root, 'snapshots', 'example-start');
  writeFile(path.join(snapshot, 'Player~fedcba9876543210', 'v3', 'manifest'), 'other-manifest');
  writeFile(path.join(snapshot, 'Player~fedcba9876543210', 'v3', '0'), 'other-data');
  return { root, data, folder, toml, snapshot, snapshots: path.join(root, 'snapshots'), before: path.join(root, 'before') };
}

test('the config gives the save folder: one title, one user, one config, or a refusal naming what is there', (t) => {
  const f = fixture(t);
  assert.equal(dataDir(f.toml), f.data);
  assert.equal(saveFolder(f.toml), f.folder);
  fs.mkdirSync(path.join(f.data, '0000ABCD', 'saves', '0009000000000002'));
  assert.throws(() => saveFolder(f.toml), /expected exactly one user folder/);
  const second = fixture(t);
  fs.mkdirSync(path.join(second.folder, '..', '11111111-1111-1111-1111-111111111111'));
  assert.throws(() => saveFolder(second.toml), /expected exactly one config folder/);
  assert.throws(() => oneFolder(path.join(f.root, 'nope'), 'title folder'), /cannot list/);
});

test('a restore backs up the old save and replaces it with the snapshot, both verified', (t) => {
  const f = fixture(t);
  const old = measure(f.folder);
  const done = restore('example-start', {
    config: f.toml,
    snapshots: f.snapshots,
    before: f.before,
    lock: path.join(f.root, 'absent.lock'),
    stamp: 'stamp',
  });
  assert.equal(done.folder, f.folder);
  assert.equal(done.backup, path.join(f.before, 'stamp-example-start'));
  const now = measure(f.folder);
  const want = measure(f.snapshot);
  assert.deepEqual(now, want);
  assert.deepEqual(measure(done.backup), old, 'the backup holds what was there before');
  assert.deepEqual(fs.readdirSync(f.folder), ['Player~fedcba9876543210']);
  assert.equal(
    fs.readFileSync(path.join(f.folder, 'Player~fedcba9876543210', 'v3', '0'), 'utf8'),
    'other-data',
  );
});

test('a restore refuses before touching the saves: a held lock, an unknown name, an existing backup', (t) => {
  const f = fixture(t);
  const before = measure(f.folder);
  const lock = path.join(f.root, 'run.lock');
  writeFile(lock, '');
  assert.throws(
    () => restore('example-start', { config: f.toml, snapshots: f.snapshots, before: f.before, lock }),
    /a run holds the harness lock/,
  );
  assert.throws(
    () => restore('nowhere', { config: f.toml, snapshots: f.snapshots, before: f.before, lock: path.join(f.root, 'a.lock') }),
    /no snapshot 'nowhere'; snapshots: example-start/,
  );
  writeFile(path.join(f.before, 'taken-example-start', 'keep'), 'x');
  assert.throws(
    () => restore('example-start', { config: f.toml, snapshots: f.snapshots, before: f.before, lock: path.join(f.root, 'a.lock'), stamp: 'taken' }),
    /already exists: refusing to overwrite/,
  );
  assert.deepEqual(measure(f.folder), before, 'a refusal leaves the save folder as it was');
});

test('a backup that cannot be made stops the restore with the saves untouched', (t) => {
  const f = fixture(t);
  const before = measure(f.folder);
  const notAFolder = path.join(f.root, 'before-is-a-file');
  writeFile(notAFolder, 'x');
  assert.throws(
    () => restore('example-start', { config: f.toml, snapshots: f.snapshots, before: notAFolder, lock: path.join(f.root, 'a.lock') }),
    /does not match|cannot list|ENOTDIR|EEXIST|not a directory|exist/i,
  );
  assert.deepEqual(measure(f.folder), before);
});

test('save-as makes a new snapshot of the folder and refuses an existing name', (t) => {
  const f = fixture(t);
  const done = saveAs('captured', { config: f.toml, snapshots: f.snapshots });
  assert.equal(done.snapshot, path.join(f.snapshots, 'captured'));
  assert.deepEqual(measure(done.snapshot), measure(f.folder));
  assert.throws(() => saveAs('captured', { config: f.toml, snapshots: f.snapshots }), /already exists/);
  assert.throws(() => saveAs('example-start', { config: f.toml, snapshots: f.snapshots }), /already exists/);
  assert.throws(() => saveAs('../escape', { config: f.toml, snapshots: f.snapshots }), /not a plain snapshot name/);
});

test('the command line restores and saves with the paths it is given', (t) => {
  const f = fixture(t);
  const lock = path.join(f.root, 'absent.lock');
  let result = runSnapshot([
    'restore',
    'example-start',
    '--config',
    f.toml,
    '--snapshots',
    f.snapshots,
    '--before',
    f.before,
    '--lock',
    lock,
    '--stamp',
    'cli',
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /restored 'example-start' into /);
  assert.ok(fs.existsSync(path.join(f.before, 'cli-example-start')));
  result = runSnapshot(['save-as', 'other', '--config', f.toml, '--snapshots', f.snapshots]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(measure(path.join(f.snapshots, 'other')), measure(f.folder));
  result = runSnapshot(['restore', 'missing', '--config', f.toml, '--snapshots', f.snapshots, '--before', f.before, '--lock', lock]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no snapshot 'missing'/);
});

test('a run that holds the lock itself restores under it', (t) => {
  const f = fixture(t);
  const lock = path.join(f.root, 'run.lock');
  writeFile(lock, '');
  const done = restore('example-start', {
    config: f.toml,
    snapshots: f.snapshots,
    before: f.before,
    lock,
    callerHoldsLock: true,
    stamp: 'own',
  });
  assert.deepEqual(measure(f.folder), measure(f.snapshot));
  assert.equal(done.backup, path.join(f.before, 'own-example-start'));
});

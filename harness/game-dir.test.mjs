import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { MANIFEST, dumpFor, executableName, preflight, prepare, volumeOf } from './game-dir.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.join(here, 'game-dir.mjs');

const MANIFEST_TEXT = [
  '<?xml version="1.0" encoding="utf-8"?>',
  '<Game configVersion="1">',
  '  <TitleId>00000000</TitleId>',
  '  <ExecutableList>',
  '    <Executable Name="title.exe" Id="Game" TargetDeviceFamily="Scarlett" />',
  '  </ExecutableList>',
  '  <PersistentLocalStorage>',
  '    <SizeMB>2048</SizeMB>',
  '  </PersistentLocalStorage>',
  '</Game>',
].join('\n');

/// A temp folder, removed after the test.
function tempDir(t, name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name ?? 'game-dir-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/// A dump folder holding a manifest, one top-level archive and one inside a subfolder.
function dump(t, parent, manifestText = MANIFEST_TEXT) {
  const dir = path.join(parent, 'dump');
  fs.mkdirSync(path.join(dir, 'pack'), { recursive: true });
  fs.writeFileSync(path.join(dir, MANIFEST), manifestText);
  fs.writeFileSync(path.join(dir, 'data.rpf'), 'archive');
  fs.writeFileSync(path.join(dir, 'pack', 'inner.rpf'), 'archive');
  return dir;
}

/// An executable of a plausible size in a folder of its own.
function exeIn(parent, name = 'title.exe') {
  const dir = path.join(parent, 'sibling');
  fs.mkdirSync(dir, { recursive: true });
  const exe = path.join(dir, name);
  fs.writeFileSync(exe, 'MZ' + '\0'.repeat(64));
  return exe;
}

function run(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
}

test('the manifest names the executable the launch needs', () => {
  assert.equal(executableName(MANIFEST_TEXT), 'title.exe');
  const first = '<ExecutableList><Executable Name="a.exe" /><Executable Name="b.exe" /></ExecutableList>';
  assert.equal(executableName(first), 'a.exe');
  assert.equal(executableName('<ExecutableList></ExecutableList>'), null);
  assert.equal(executableName('<Game></Game>'), null);
});

test('a dump whose executable is absent is refused in one line that names it, the folder and the override', (t) => {
  const dir = dump(t, tempDir(t));
  const refused = preflight(dir).refusal;
  assert.ok(refused, 'a dump without its executable must not pass');
  assert.equal(refused.split('\n').length, 1, `one line, not many: ${refused}`);
  assert.match(refused, /^refused: /);
  assert.match(refused, /names title\.exe/);
  assert.ok(refused.includes(dir), `names the folder it looked in: ${refused}`);
  assert.match(refused, /GAME_EXE/);
  assert.equal(fs.existsSync(path.join(dir, 'title.exe')), false);
});

test('the same folder passes once the executable is hardlinked in', (t) => {
  const root = tempDir(t);
  const dir = dump(t, root);
  const exe = exeIn(root);
  assert.ok(preflight(dir).refusal);
  fs.linkSync(exe, path.join(dir, 'title.exe'));
  assert.deepEqual(preflight(dir), {});
  assert.equal(fs.statSync(path.join(dir, 'title.exe')).ino, fs.statSync(exe).ino, 'a link, not a copy');
});

test('a manifest that names nothing, and a folder with no manifest, are each refused with one line', (t) => {
  const root = tempDir(t);
  const empty = dump(t, root, '<Game><ExecutableList></ExecutableList></Game>');
  const bare = path.join(root, 'bare');
  fs.mkdirSync(bare);
  const noName = preflight(empty).refusal;
  const noManifest = preflight(bare).refusal;
  assert.match(noName, /names no executable/);
  assert.match(noManifest, new RegExp(`no ${MANIFEST.replace('.', '\\.')} in ${bare.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}`));
  assert.match(noManifest, /GAME_MANIFEST/);
  assert.equal(noManifest.split('\n').length, 1);
});

test('the check command exits 1 with that line, and 0 once the executable is beside the manifest', (t) => {
  const root = tempDir(t);
  const dir = dump(t, root);
  let result = run(['check', dir]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^refused: .*names title\.exe/);
  result = run(['check', path.join(root, 'nowhere')]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^refused: no MicrosoftGame\.Config in /);
  fs.linkSync(exeIn(root), path.join(dir, 'title.exe'));
  result = run(['check', dir]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '');
});

test('the dump is found from its executable, and a sibling folder with no manifest is not a dump', (t) => {
  const root = tempDir(t);
  const dir = dump(t, root);
  const exe = exeIn(root);
  assert.deepEqual(dumpFor(exe), { dir });
  assert.deepEqual(dumpFor(path.join(dir, 'title.exe')), { dir });
  const noDump = dumpFor(path.join(root, 'sibling', 'elsewhere', 'title.exe'));
  assert.match(noDump.refusal, /no MicrosoftGame\.Config/);
  const second = dump(t, tempDir(t));
  assert.notEqual(second, dir);
  fs.writeFileSync(path.join(path.dirname(dir), 'another'), '');
  const crowded = dumpFor(exe);
  assert.deepEqual(crowded, { dir });
});

test('two dumps beside one executable refuse rather than choose', (t) => {
  const root = tempDir(t);
  dump(t, root);
  const other = path.join(root, 'second dump');
  fs.mkdirSync(other);
  fs.writeFileSync(path.join(other, MANIFEST), MANIFEST_TEXT);
  const refused = dumpFor(exeIn(root));
  assert.match(refused.refusal, /2 folders under .* hold a MicrosoftGame\.Config/);
  assert.ok(refused.refusal.includes(other));
});

test('prepare stages the executable beside the manifest when the dump has no copy', (t) => {
  const root = tempDir(t);
  const dir = dump(t, root);
  const exe = exeIn(root);
  const stageRoot = path.join(tempDir(t), 'game');
  const prepared = prepare({ exe, stage: stageRoot });
  assert.equal(prepared.refusal, undefined, prepared.refusal);
  assert.equal(prepared.staged, true);
  assert.equal(prepared.dir, path.join(stageRoot, 'dump'));
  assert.equal(prepared.exe, path.join(stageRoot, 'dump', 'title.exe'));
  assert.equal(prepared.linked, 4, 'the three files of the dump and the executable');
  for (const relative of ['data.rpf', path.join('pack', 'inner.rpf')]) {
    assert.equal(
      fs.statSync(path.join(prepared.dir, relative)).ino,
      fs.statSync(path.join(dir, relative)).ino,
      `${relative} is a link, not a copy`,
    );
  }
  assert.equal(fs.statSync(prepared.exe).ino, fs.statSync(exe).ino);
  assert.deepEqual(preflight(prepared.dir), {});
  assert.equal(fs.existsSync(path.join(dir, 'title.exe')), false, 'the install gains nothing');
});

test('a second prepare reuses the links it already made', (t) => {
  const root = tempDir(t);
  dump(t, root);
  const exe = exeIn(root);
  const stageRoot = path.join(tempDir(t), 'game');
  prepare({ exe, stage: stageRoot });
  const again = prepare({ exe, stage: stageRoot });
  assert.equal(again.staged, true);
  assert.equal(again.linked, 0);
  assert.deepEqual(preflight(again.dir), {});
});

test('an executable already beside its manifest launches from the dump, with no stage folder', (t) => {
  const root = tempDir(t);
  const dir = dump(t, root);
  fs.writeFileSync(path.join(dir, 'title.exe'), 'MZ');
  const stageRoot = path.join(root, 'game');
  const prepared = prepare({ exe: path.join(dir, 'title.exe'), stage: stageRoot });
  assert.equal(prepared.staged, false);
  assert.equal(prepared.dir, dir);
  assert.equal(prepared.exe, path.join(dir, 'title.exe'));
  assert.equal(fs.existsSync(stageRoot), false);
});

test('the manifest can name the dump outright, and a manifest that is not there is refused', (t) => {
  const root = tempDir(t);
  const dir = dump(t, root);
  const exe = exeIn(root);
  const stageRoot = path.join(tempDir(t), 'game');
  const prepared = prepare({ exe: path.join(root, 'nowhere', 'title.exe'), manifest: path.join(dir, MANIFEST), stage: stageRoot });
  assert.equal(prepared.exe, path.join(stageRoot, 'dump', 'title.exe'));
  assert.equal(path.basename(prepared.dir), 'dump');
  const refused = prepare({ manifest: path.join(root, 'missing', MANIFEST), stage: stageRoot });
  assert.match(refused.refusal, /GAME_MANIFEST names .*missing.*, which does not exist/);
});

test('a stage folder on another volume refuses rather than copying', { skip: process.platform !== 'win32' }, (t) => {
  const root = tempDir(t);
  const dir = dump(t, root);
  const exe = exeIn(root);
  const other = volumeOf(root).startsWith('c:') ? 'D:' : 'C:';
  const refused = prepare({ exe, stage: path.join(other, 'game') });
  const dumpAt = refused.refusal ?? prepare({ exe, manifest: path.join(dir, MANIFEST), stage: path.join(other, 'game') }).refusal;
  assert.match(dumpAt, /a hardlink cannot cross volumes/);
  assert.match(dumpAt, /GAME_STAGE/);
});

test('the prepare command prints the executable to launch and the links it made', (t) => {
  const root = tempDir(t);
  dump(t, root);
  const exe = exeIn(root);
  const stageRoot = path.join(tempDir(t), 'game');
  const result = run(['prepare', '--exe', exe, '--stage', stageRoot]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), path.join(stageRoot, 'dump', 'title.exe'));
  assert.match(result.stderr, /stage: 4 hardlinks under .*dump/);
  const idle = path.join(tempDir(t), 'idle');
  fs.mkdirSync(idle);
  const refused = run(['prepare', '--exe', path.join(idle, 'nowhere.exe'), '--stage', stageRoot]);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /^refused: no MicrosoftGame\.Config in /);
  assert.equal(run(['prepare', '--exe', exe]).status, 2);
});

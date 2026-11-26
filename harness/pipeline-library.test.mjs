import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const library = path.join(here, 'pipeline-library.sh').replaceAll('\\', '/');

function tempCache(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pipeline-library-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir.replaceAll('\\', '/');
}

// Runs a bash script with the library sourced and CACHE set; the script's stdout and stderr come back together.
function bash(t, cache, body, env = {}) {
  const file = path.join(os.tmpdir(), `pipeline-library-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
  fs.writeFileSync(file, `set -u\n. '${library}'\nCACHE='${cache}'\n${body}\n`);
  t.after(() => fs.rmSync(file, { force: true }));
  const result = spawnSync('bash', [file], {
    encoding: 'utf8',
    env: { ...process.env, PIPELINE_LIBRARY_RETRIES: '1', ...env },
  });
  return { status: result.status, out: `${result.stdout}${result.stderr}` };
}

const read = (cache, ...parts) => fs.readFileSync(path.join(cache, ...parts), 'utf8');
const names = (dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).sort() : []);

test('each build keeps its own files and gets them back; the folder is empty between runs', (t) => {
  const cache = tempCache(t);
  const run = bash(
    t,
    cache,
    `
pipeline_library_enter "$CACHE" a-diag || exit 1
printf 'library of a' >"$CACHE/pipelines/host-pipelines.bin"
printf 'early of a' >"$CACHE/pipelines/early-pipelines.txt"
pipeline_library_leave
pipeline_library_enter "$CACHE" b-diag || exit 1
printf 'library of b' >"$CACHE/pipelines/host-pipelines.bin"
pipeline_library_leave
pipeline_library_enter "$CACHE" a-diag || exit 1
`,
  );
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /pipeline library: a-diag none stored, starting empty/);
  assert.match(run.out, /pipeline library: b-diag none stored, starting empty/);
  assert.match(run.out, /pipeline library: a-diag restored \(0 MB\)/);
  assert.equal(read(cache, 'pipelines', 'host-pipelines.bin'), 'library of a');
  assert.equal(read(cache, 'pipelines', 'early-pipelines.txt'), 'early of a');
  assert.equal(read(cache, 'pipelines', 'library-build.txt').trim(), 'a-diag');
  assert.equal(read(cache, 'pipelines-by-build', 'b-diag', 'host-pipelines.bin'), 'library of b');
  assert.deepEqual(names(path.join(cache, 'pipelines-by-build')), ['b-diag']);
});

test('a run that was killed outright leaves its files marked; the next build sets them aside under its name', (t) => {
  const cache = tempCache(t);
  const run = bash(
    t,
    cache,
    `
pipeline_library_enter "$CACHE" a-diag || exit 1
printf 'library of a' >"$CACHE/pipelines/host-pipelines.bin"
pipeline_library_enter "$CACHE" b-diag || exit 1
`,
  );
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /pipeline library: b-diag none stored, starting empty, a-diag set aside \(0 MB\)/);
  assert.equal(read(cache, 'pipelines-by-build', 'a-diag', 'host-pipelines.bin'), 'library of a');
  assert.deepEqual(names(path.join(cache, 'pipelines')), ['library-build.txt']);
});

test('files with no marker are set aside as unmarked, not taken for the build\'s', (t) => {
  const cache = tempCache(t);
  fs.mkdirSync(path.join(cache, 'pipelines'));
  fs.writeFileSync(path.join(cache, 'pipelines', 'host-pipelines.bin'), 'old');
  const run = bash(t, cache, 'pipeline_library_enter "$CACHE" a-diag || exit 1');
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /a-diag none stored, starting empty, unmarked-\d{8}-\d{6} set aside/);
  const [aside] = names(path.join(cache, 'pipelines-by-build'));
  assert.match(aside, /^unmarked-/);
  assert.equal(read(cache, 'pipelines-by-build', aside, 'host-pipelines.bin'), 'old');
  assert.equal(names(path.join(cache, 'pipelines')).includes('host-pipelines.bin'), false);
});

test('only the six most recently used builds are kept', (t) => {
  const cache = tempCache(t);
  const run = bash(
    t,
    cache,
    `
for n in 1 2 3 4 5 6 7 8; do
  pipeline_library_enter "$CACHE" "build$n" || exit 1
  printf "library $n" >"$CACHE/pipelines/host-pipelines.bin"
  pipeline_library_leave
  touch -d "2026-11-25 10:0$n:00" "$CACHE/pipelines-by-build/build$n/.last-used"
done
pipeline_library_enter "$CACHE" build3 || exit 1
printf 'more' >>"$CACHE/pipelines/host-pipelines.bin"
touch -d "2026-11-25 11:00:00" "$CACHE/pipelines-by-build/build8/.last-used"
pipeline_library_leave
`,
  );
  assert.equal(run.status, 0, run.out);
  // build3 was taken out and stored again just now, so it is the newest; the oldest beyond six go.
  const left = names(path.join(cache, 'pipelines-by-build'));
  assert.equal(left.length, 6, left.join(','));
  assert.equal(left.includes('build3'), true);
  assert.equal(left.includes('build1'), false);
  assert.equal(left.includes('build2'), false);
  assert.match(run.out, /build1 dropped/);
});

test('a kill or an error still stores the library: the EXIT trap', (t) => {
  const cache = tempCache(t);
  const run = bash(
    t,
    cache,
    `
pipeline_library_enter "$CACHE" a-diag || exit 1
trap pipeline_library_leave EXIT
trap 'exit 130' INT TERM
printf 'written during the run' >"$CACHE/pipelines/host-pipelines.bin"
kill -TERM $$
sleep 5
`,
  );
  assert.equal(run.status, 130, run.out);
  assert.equal(read(cache, 'pipelines-by-build', 'a-diag', 'host-pipelines.bin'), 'written during the run');
  assert.deepEqual(names(path.join(cache, 'pipelines')), []);
});

test('the exit status of the script survives the trap, and a second leave does nothing', (t) => {
  const cache = tempCache(t);
  const run = bash(
    t,
    cache,
    `
pipeline_library_enter "$CACHE" a-diag || exit 1
trap pipeline_library_leave EXIT
printf 'x' >"$CACHE/pipelines/host-pipelines.bin"
pipeline_library_leave
pipeline_library_leave
exit 7
`,
  );
  assert.equal(run.status, 7, run.out);
  assert.equal(read(cache, 'pipelines-by-build', 'a-diag', 'host-pipelines.bin'), 'x');
});

test('a run is refused when the other build\'s files cannot be set aside', (t) => {
  const cache = tempCache(t);
  // The store's folder for the build in place is a file, so nothing can move into it.
  fs.mkdirSync(path.join(cache, 'pipelines'));
  fs.mkdirSync(path.join(cache, 'pipelines-by-build'));
  fs.writeFileSync(path.join(cache, 'pipelines', 'library-build.txt'), 'a-diag\n');
  fs.writeFileSync(path.join(cache, 'pipelines', 'host-pipelines.bin'), 'a');
  fs.writeFileSync(path.join(cache, 'pipelines-by-build', 'a-diag'), 'in the way');
  const run = bash(t, cache, 'pipeline_library_enter "$CACHE" b-diag');
  assert.equal(run.status, 1, run.out);
  assert.match(run.out, /could not set a-diag aside; run refused/);
  assert.equal(read(cache, 'pipelines', 'host-pipelines.bin'), 'a');
});

test('output names builds and sizes, never the cache folder', (t) => {
  const cache = tempCache(t);
  const run = bash(
    t,
    cache,
    `
export PIPE_LOG="$CACHE/log.txt"
pipeline_library_enter "$CACHE" a-diag || exit 1
head -c 3145728 /dev/zero >"$CACHE/pipelines/host-pipelines.bin"
pipeline_library_leave
pipeline_library_enter "$CACHE" a-diag || exit 1
`,
  );
  assert.equal(run.status, 0, run.out);
  assert.match(run.out, /pipeline library: a-diag restored \(3 MB\)/);
  assert.equal(run.out.includes(path.basename(cache)), false, 'the folder name is in the output');
  const log = read(cache, 'log.txt');
  assert.match(log, /^harness: pipeline library: a-diag restored \(3 MB\)$/m);
  assert.equal(log.includes(path.basename(cache)), false);
});

test('the build key: a snapshot folder, a lane checkout, a WARP run, and a name made safe', (t) => {
  const cache = tempCache(t);
  const run = bash(
    t,
    cache,
    `
pipeline_library_key /snapshots/ff89fa6-diag/victory.exe; echo
pipeline_library_key <project>/worktrees/ds3/target/diag/victory.exe; echo
pipeline_library_key <project>/victory/target/release/victory.exe; echo
VICTORY_D3D12_WARP=1 pipeline_library_key /snapshots/ff89fa6-diag/victory.exe; echo
pipeline_library_key '/snapshots/a b/victory.exe'; echo
`,
  );
  assert.equal(run.status, 0, run.out);
  assert.deepEqual(run.out.trim().split(/\r?\n/), [
    'ff89fa6-diag',
    'lane-ds3-diag',
    'lane-victory-release',
    'ff89fa6-diag-warp',
    'a_b',
  ]);
});

test('the cache folder: VICTORY_CACHE_DIR first, then the config file, quoted either way', (t) => {
  const cache = tempCache(t);
  const config = path.join(cache, 'victory.toml');
  fs.writeFileSync(config, `[paths]\ncache_dir = '<drive>/from-toml/literal'\n`);
  const fromFile = bash(t, cache, `pipeline_library_cache_dir '${config.replaceAll('\\', '/')}'`, { VICTORY_CACHE_DIR: '' });
  assert.equal(fromFile.out, '<drive>/from-toml/literal');
  fs.writeFileSync(config, `[paths]\ncache_dir = "<drive>/from-toml/basic"\n`);
  const basic = bash(t, cache, `pipeline_library_cache_dir '${config.replaceAll('\\', '/')}'`, { VICTORY_CACHE_DIR: '' });
  assert.equal(basic.out, '<drive>/from-toml/basic');
  const fromEnv = bash(t, cache, `pipeline_library_cache_dir '${config.replaceAll('\\', '/')}'`, { VICTORY_CACHE_DIR: '<drive>/from-env' });
  assert.equal(fromEnv.out, '<drive>/from-env');
});

test('a copy sourced from the capture folder finds its helper module through PIPE_TOOLS', (t) => {
  const dir = tempCache(t);
  const copied = path.join(dir, 'pipeline-library.sh');
  fs.copyFileSync(path.join(here, 'pipeline-library.sh'), copied);
  const toml = path.join(dir, 'victory.toml');
  fs.writeFileSync(toml, "[paths]\ncache_dir = '/made/cache'\n");
  const script = path.join(dir, 'probe.sh');
  fs.writeFileSync(
    script,
    `set -u\nPIPE_TOOLS='${here.replaceAll('\\', '/')}'\n. '${copied.replaceAll('\\', '/')}'\npipeline_library_cache_dir '${toml.replaceAll('\\', '/')}'\n`,
  );
  const result = spawnSync('bash', [script], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '/made/cache');
});

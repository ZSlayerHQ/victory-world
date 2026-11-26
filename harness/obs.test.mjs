import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const library = path.join(here, 'obs.sh').replaceAll('\\', '/');

// Runs a bash script with obs.sh sourced. `obs` stands in for the tasklist check ("up" or "down"), so no test depends
// on whether OBS is running on the machine that runs it. Stdout comes back.
function bash(t, body, { obs = 'down', env = {} } = {}) {
  const file = path.join(os.tmpdir(), `obs-${process.pid}-${Math.random().toString(36).slice(2)}.sh`);
  const stub = obs === 'up' ? 'obs_running() { return 0; }' : 'obs_running() { return 1; }';
  fs.writeFileSync(file, `set -u\n. '${library}'\n${stub}\n${body}\n`);
  t.after(() => fs.rmSync(file, { force: true }));
  const environment = { ...process.env, ...env };
  if (env.VICTORY_WARM_GENTLE === undefined) delete environment.VICTORY_WARM_GENTLE;
  const result = spawnSync('bash', [file], { encoding: 'utf8', env: environment });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  return result.stdout.trim();
}

const decide = (t, obs, gentle) =>
  bash(t, 'warm_mode_decide; echo "$WARM_MODE|$WARM_WHY"', { obs, env: { VICTORY_WARM_GENTLE: gentle } });

test('with OBS running the warm-up is gentle; without it, raised as before', (t) => {
  assert.equal(decide(t, 'up', undefined), 'gentle|OBS is running');
  assert.equal(decide(t, 'down', undefined), 'raised|OBS is not running');
});

test('VICTORY_WARM_GENTLE=1 forces gentle and =0 forces raised, whatever OBS is doing', (t) => {
  assert.equal(decide(t, 'down', '1'), 'gentle|VICTORY_WARM_GENTLE=1');
  assert.equal(decide(t, 'up', '1'), 'gentle|VICTORY_WARM_GENTLE=1');
  assert.equal(decide(t, 'up', '0'), 'raised|VICTORY_WARM_GENTLE=0');
  assert.equal(decide(t, 'down', '0'), 'raised|VICTORY_WARM_GENTLE=0');
});

test('any other value, or an empty one, leaves the choice to OBS', (t) => {
  assert.equal(decide(t, 'up', 'yes'), 'gentle|OBS is running');
  assert.equal(decide(t, 'down', ''), 'raised|OBS is not running');
});

test('gentle runs half the logical processors, at least one', (t) => {
  const jobs = (n) => bash(t, 'warm_jobs', { env: { NUMBER_OF_PROCESSORS: n } });
  assert.equal(jobs('32'), '16');
  assert.equal(jobs('12'), '6');
  assert.equal(jobs('5'), '3');
  assert.equal(jobs('1'), '1');
  // A count that is not a number falls back to what the shell itself can count, still at least one.
  assert.ok(Number(jobs('many')) >= 1);
});

test('the run prints one line that says which mode it used and why', (t) => {
  const line = (obs, gentle) =>
    bash(t, 'warm_mode_decide; warm_mode_line', { obs, env: { NUMBER_OF_PROCESSORS: '32', VICTORY_WARM_GENTLE: gentle } });
  assert.equal(line('up', undefined), 'warm-up mode: gentle (OBS is running): below-normal priority, 16 jobs of 32 logical processors');
  assert.equal(line('down', undefined), 'warm-up mode: raised (OBS is not running): above-normal priority, every core');
  assert.equal(line('down', '1').split('\n').length, 1);
});

test('the OBS check is spelled the same as the one world-run.sh makes before a real-GPU run', () => {
  const check = 'tasklist //FI "IMAGENAME eq obs64.exe" //NH 2>/dev/null | grep -qi \'^obs64\\.exe\'';
  assert.ok(fs.readFileSync(path.join(here, 'world-run.sh'), 'utf8').includes(check), 'world-run.sh');
  assert.ok(fs.readFileSync(path.join(here, 'obs.sh'), 'utf8').includes(check), 'obs.sh');
});

test('run-world.sh lowers the warm-up through obs.sh and passes --jobs only when gentle', () => {
  const wrapper = fs.readFileSync(path.join(here, 'run-world.sh'), 'utf8');
  assert.match(wrapper, /\. "\$HERE\/obs\.sh"\n\s+warm_mode_decide\n\s+warm_mode_line\n/);
  assert.match(wrapper, /if \[ "\$WARM_MODE" = gentle \]; then\n\s+WARM_ARGS=\(--jobs "\$\(warm_jobs\)"\)\n\s+WARM_PS_FLAGS="-Translate -Gentle"\n\s+fi/);
  assert.match(wrapper, /raise-priority\.ps1" \$WARM_PS_FLAGS /);
  assert.match(wrapper, /"\$BIN" warm \$\{WARM_ARGS\[@\]\+"\$\{WARM_ARGS\[@\]\}"\} /);
});

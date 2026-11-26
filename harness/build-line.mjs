#!/usr/bin/env node
// The `harness build:` line run-world.sh writes at the top of a run log, and the `harness checkout:` line beside it.
// The build line names the binary that will run: a snapshot build (snapshot.txt beside VICTORY_BIN, which
// snapshot-build.sh writes) names its folder, branch and profile; a binary that prints a version when asked
// names that instead; a lane build names the checkout's commit. The checkout line always names the checkout's head,
// separately, so a snapshot run cannot hide which checkout supplied the scripts.
// usage: node build-line.mjs <victory-dir> [<victory-bin> <profile> <console>]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CONTROL_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)?|[ -/]*[@-~])/g;

export function commitAt(dir) {
  if (!dir) return null;
  const result = spawnSync('git', ['-C', dir, 'log', '-1', '--format=%h'], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const sha = (result.stdout || '').trim();
  return /^[0-9a-f]{7,}$/.test(sha) ? sha : null;
}

// snapshot.txt: one `name: value` a line, as snapshot-build.sh writes it.
export function readSnapshot(file) {
  if (!file || !fs.existsSync(file)) return null;
  const fields = {};
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(commit|branch|profile|features|date|lane): (.*)$/);
    if (m) fields[m[1]] = m[2].trim();
  }
  return fields.commit ? fields : null;
}

// What the binary says it is, when it supports --version. The probe is only made for a binary under the builds
// root (the snapshot builds), never an arbitrary executable and never a run of the game.
export function probeVersion(
  bin,
  { buildsRoot = process.env.VICTORY_BUILDS || '/snapshots', run = spawnSync } = {},
) {
  if (!bin || !fs.existsSync(bin)) return null;
  const file = path.resolve(bin);
  const root = path.resolve(buildsRoot);
  const relative = path.relative(root, file);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null;
  // A test's stand-in can be a .cmd; a real snapshot is a .exe.
  const shell = /\.(?:cmd|bat)$/i.test(file);
  const help = run(bin, ['--help'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, shell });
  if (help.error) return null;
  const helpText = `${help.stdout || ''}\n${help.stderr || ''}`;
  if (!/(?:^|[\s,[(])(?:-V|--version)(?:[\s,\]):]|$)/m.test(helpText)) return null;
  const result = run(bin, ['--version'], { encoding: 'utf8', timeout: 15_000, windowsHide: true, shell });
  if (result.error) return null;
  const first = `${result.stdout || ''}\n${result.stderr || ''}`
    .replace(CONTROL_RE, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean);
  return first ? first.slice(0, 160) : null;
}

export function buildLine({ dir, bin, profile, console, gitCommit = commitAt, version = null }) {
  // The binary's own snapshot first: VICTORY_BIN can point at another build while VICTORY_DIR is a lane checkout,
  // and then the checkout's head is not the binary that runs.
  const snapshot = bin ? readSnapshot(path.join(path.dirname(bin), 'snapshot.txt')) : null;
  if (snapshot) {
    const folder = path.basename(path.dirname(bin));
    const branch = snapshot.branch ? ` branch=${snapshot.branch}` : '';
    return `harness build: ${folder} profile=${snapshot.profile || profile} console=${console}${branch}`;
  }
  if (version) return `harness build: ${version} profile=${profile} console=${console}`;
  const sha = gitCommit(dir);
  if (sha) return `harness build: ${sha} profile=${profile} console=${console}`;
  // Today's line for a run whose build cannot be named; the experiment table already reads it.
  return `harness build:  profile=${profile} console=${console}`;
}

export function checkoutLine({ dir, gitCommit = commitAt }) {
  const sha = gitCommit(dir);
  return sha ? `harness checkout: ${sha}` : null;
}

// The header's lines: the binary's build first, then the checkout's own head when it has one.
export function buildLines(options) {
  const gitCommit = options.gitCommit || commitAt;
  const sha = gitCommit(options.dir);
  const lines = [
    buildLine({ ...options, gitCommit: () => sha }),
  ];
  const checkout = checkoutLine({ dir: options.dir, gitCommit: () => sha });
  if (checkout) lines.push(checkout);
  return lines;
}

function main() {
  const [dir, bin = '', profile = 'diag', consoleName = 'series-x'] = process.argv.slice(2);
  if (!dir) {
    console.error('usage: node build-line.mjs <victory-dir> [<victory-bin> <profile> <console>]');
    process.exit(2);
  }
  const snapshot = bin ? readSnapshot(path.join(path.dirname(bin), 'snapshot.txt')) : null;
  const version = snapshot ? null : probeVersion(bin);
  for (const line of buildLines({ dir, bin, profile, console: consoleName, version })) console.log(line);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();

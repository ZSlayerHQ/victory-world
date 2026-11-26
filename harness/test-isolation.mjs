// A harness test that spawns a harness process must never read this machine's harness/local.env: the tests point
// the loader at a file that does not exist, so a developer's checkout behaves like CI. Tests that exercise the
// loader itself pass their own VICTORY_LOCAL_ENV explicitly (harness/local-env.test.mjs).
import os from 'node:os';
import path from 'node:path';

export const NO_LOCAL_ENV = path.join(os.tmpdir(), 'victory-harness-no-such-local.env');

/// The environment for a spawned harness process: this process's own environment, with the loader pointed away
/// from the machine's file. Extra names win over both.
export function isolatedEnv(extra = {}) {
  return { ...process.env, VICTORY_LOCAL_ENV: NO_LOCAL_ENV, ...extra };
}

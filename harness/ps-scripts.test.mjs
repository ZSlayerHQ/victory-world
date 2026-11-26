import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function powershell(script) {
  return spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', script], {
    encoding: 'utf8',
  });
}

test('every harness PowerShell script parses', () => {
  const files = fs.readdirSync(here).filter((file) => file.endsWith('.ps1'));
  assert.ok(files.length > 0);
  for (const name of files) {
    const file = path.join(here, name).replace(/'/g, "''");
    const script =
      `$errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${file}', [ref]$null, [ref]$errors) | Out-Null; ` +
      `if ($errors.Count -gt 0) { $errors | ForEach-Object { $_.Message }; exit 1 }`;
    const result = powershell(script);
    assert.equal(result.status, 0, `${name}: ${result.stdout}${result.stderr}`);
  }
});

// run-process.ps1's top-level param block resets a dot-sourcing caller's switches of the same names. That is the
// open fault; raise-priority.ps1 avoids it by dot-sourcing inside a child scope with the value captured first.
// These run PowerShell only: the dot-sourced path never reaches the process selection (a gotcha).
test('dot-sourcing run-process.ps1 resets a caller switch of the same name', () => {
  const runProcess = path.join(here, 'run-process.ps1').replace(/'/g, "''");
  const result = powershell(`$Translate = $true; . '${runProcess}'; if ($Translate) { 'after=on' } else { 'after=off' }`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /after=off/);
});

// -Translate never falls back to another victory.exe, and without a warm-up start time it selects nothing, so the
// gentle switch can be run here without touching any process.
test('raise-priority.ps1 -Translate -Gentle with no warm-up started lowers nothing', () => {
  const file = path.join(here, 'raise-priority.ps1').replace(/'/g, "''");
  const result = powershell(`Remove-Item Env:RUN_WORLD_WARM_STARTED_EPOCH -ErrorAction SilentlyContinue; & '${file}' -Translate -Gentle`);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^priority: no victory\.exe raised \(\d+ found\)/);
});

test('the child-scope wrapper keeps the caller switch', () => {
  const runProcess = path.join(here, 'run-process.ps1').replace(/'/g, "''");
  const result = powershell(
    `$Translate = $true; ` +
      `$inner = & { param($UseTranslate) . '${runProcess}'; if ($UseTranslate) { 'inner=on' } else { 'inner=off' } } $Translate; ` +
      `if ($Translate) { 'after=on' } else { 'after=off' }; $inner`,
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /inner=on/);
  assert.match(result.stdout, /after=on/);
});

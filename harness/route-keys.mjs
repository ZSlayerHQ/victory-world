#!/usr/bin/env node
// A named key route for the harness: harness/routes/<name>.keys, one <seconds>:<key>[:<hold>] entry per line,
// `#` comments, and `# heavy-seconds: N`, `# settled-seconds: N` or `# settled-after: N` headers that run-world.sh
// uses unless given.
// usage: node route-keys.mjs keys|heavy-seconds|settled-seconds <routes dir> <name>
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/// The route's keys (joined into VICTORY_KEYS' comma list) and its heavy- or settled-seconds header; null for no
/// such route.
export function readRoute(dir, name) {
  let text;
  try {
    text = fs.readFileSync(path.join(dir, `${name}.keys`), 'utf8');
  } catch {
    return null;
  }
  let heavySeconds = null;
  let settledSeconds = null;
  let settledAfter = null;
  const keys = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    const heavy = line.match(/^#\s*heavy-seconds:\s*([0-9]+(?:\.[0-9]+)?)\s*$/i);
    if (heavy) {
      heavySeconds = heavy[1];
      continue;
    }
    const settled = line.match(/^#\s*settled-seconds:\s*([0-9]+(?:\.[0-9]+)?)\s*$/i);
    if (settled) {
      settledSeconds = settled[1];
      continue;
    }
    const after = line.match(/^#\s*settled-after:\s*([0-9]+(?:\.[0-9]+)?)\s*$/i);
    if (after) {
      settledAfter = after[1];
      continue;
    }
    const entry = line.replace(/#.*$/, '').trim();
    if (entry) keys.push(entry);
  }
  return { keys, heavySeconds, settledSeconds, settledAfter };
}

/// The route names in `dir`, sorted; empty when the folder is missing.
export function routeNames(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((file) => file.endsWith('.keys'))
      .map((file) => file.slice(0, -'.keys'.length))
      .sort();
  } catch {
    return [];
  }
}

function main() {
  const [what, dir, name] = process.argv.slice(2);
  if (!['keys', 'heavy-seconds', 'settled-seconds', 'settled-after'].includes(what) || !dir || !name) {
    console.error('usage: node route-keys.mjs keys|heavy-seconds|settled-seconds|settled-after <routes dir> <name>');
    process.exit(2);
  }
  const route = readRoute(dir, name);
  if (!route) {
    console.error(`no route '${name}'; routes: ${routeNames(dir).join(', ') || 'none'}`);
    process.exit(2);
  }
  if (what === 'keys') {
    if (!route.keys.length) {
      console.error(`route '${name}' has no keys`);
      process.exit(2);
    }
    console.log(route.keys.join(','));
  } else if (what === 'heavy-seconds') {
    if (route.heavySeconds) console.log(route.heavySeconds);
  } else if (what === 'settled-after') {
    if (route.settledAfter) console.log(route.settledAfter);
  } else if (route.settledSeconds) {
    console.log(route.settledSeconds);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

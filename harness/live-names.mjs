#!/usr/bin/env node
// The live switches the runtime registers, in one place: live.mjs prints them for live.sh, and live-drive.mjs
// refuses a plan that names anything else. The order is the runtime's own (the segment line's in-force order may
// differ); the shortest way to see it is `harness/live.sh names`.
export const LIVE_NAMES = Object.freeze([
  'VICTORY_KEEP_TEXTURES',
  'VICTORY_TEXTURE_LOW',
  'VICTORY_TEXTURE_HIGH',
  'VICTORY_LATE_WAITS',
  'LIVE_SKIP_DISPATCH',
  'LIVE_SKIP_DRAW',
]);

const LIVE_NAME_SET = new Set(LIVE_NAMES);

/// True for a name the runtime's live registry knows.
export function isLiveName(name) {
  return LIVE_NAME_SET.has(name);
}

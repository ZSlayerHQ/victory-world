#!/bin/sh
# The only way to start the game: one run at a time, and no real-GPU run while OBS is up (a GPU hang resets the
# display driver and blacks out every monitor). Arguments go to run-world.sh unchanged; VICTORY_DIR picks the build.
HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/.." && { pwd -W 2>/dev/null || pwd; })
LOCK="$HERE/run.lock"
# This machine's paths (harness/local.env, if there is one). It holds paths only: the OBS switch below never comes
# from it.
. "$HERE/local-env.sh"
load_local_env "$HERE"

REAL_GPU=1
[ "${VICTORY_D3D12_WARP:-}" = 1 ] && REAL_GPU=0
PREV=
for A in "$@"; do  # WARP works only in a diagnostics build; a release build ignores the variable
  [ "$PREV" = --profile ] && [ "$A" != diag ] && REAL_GPU=1
  PREV=$A
done
if [ "$REAL_GPU" = 1 ] && tasklist //FI "IMAGENAME eq obs64.exe" //NH 2>/dev/null | grep -qi '^obs64\.exe'; then
  # VICTORY_ALLOW_OBS=1 is the maintainer's word for one stream only (a decision); it is never set in a file or a default.
  if [ "${VICTORY_ALLOW_OBS:-}" = 1 ]; then
    echo "warning: OBS is running and VICTORY_ALLOW_OBS=1: a GPU hang will black out the stream." >&2
  else
    echo "refused: OBS is running, and a GPU hang would black out the stream." >&2
    echo "Run on WARP instead, with the diag profile: VICTORY_D3D12_WARP=1 $0 <args>" >&2
    exit 3
  fi
fi

if ! mkdir "$LOCK" 2>/dev/null; then
  echo "refused: another run holds $LOCK:" >&2
  cat "$LOCK/owner" >&2 2>/dev/null
  echo "If tasklist shows no victory.exe, the lock is stale: rm \"$LOCK/owner\" && rmdir \"$LOCK\"" >&2
  exit 4
fi
trap 'rm -f "$LOCK/owner"; rmdir "$LOCK" 2>/dev/null' EXIT
trap 'exit 130' INT TERM
printf 'pid %s, started %s, VICTORY_DIR=%s, args: %s\n' "$$" "$(date '+%F %T')" "${VICTORY_DIR:-victory}" "$*" >"$LOCK/owner"

# A lane worktree has no victory.toml of its own (it is git-ignored), so every run reads the main one.
VICTORY_CONFIG=${VICTORY_CONFIG:-$ROOT/victory/victory.toml}
export VICTORY_CONFIG
# This wrapper holds the lock from here on: a save restore in the run below is this run's own.
export WORLD_RUN_HOLDS_LOCK=1
bash "$HERE/run-world.sh" "$@"

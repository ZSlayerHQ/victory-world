#!/usr/bin/env bash
# One VIctory world run, with the diagnostics that matter, condensed at exit.
# usage: run-world.sh [--timing] [--volume N|off] [--no-record] [--presentmon] [--aftermath] [--warm] [--frames 2400,2600] [--keys '55:Enter,...']
#                     [--route <name>] [--dump-targets] [--print-env] [--settled-seconds N] [--settled-after-s N]
#                     [--settled-timeout N]
#                     [--settled-fps F] [--settled-waiting K]
#                     [--console series-x|series-s] [--profile diag|release]
#                     [--copy-mode plain|none] [--heavy-seconds N] [--tag name] [--require-quiet]
# VICTORY_BIN overrides the binary (default $VICTORY_DIR/target/$PROFILE/victory.exe). GAME_EXE, VICTORY_CAPTURES (the
# root each run's capture folder goes under; CAPTURE names one run's folder outright) and VICTORY_SAVE_BACKUPS come
# from the environment, else harness/local.env on a machine that has one, else the main PC's E: paths below.
# VICTORY_WARM_GENTLE=1 or 0 forces the --warm warm-up gentle or raised; unset, it is gentle while OBS is running (obs.sh).
# The body is one function, called once at the end, so bash has read every line before it runs anything: an edit to
# this file during a run cannot change the rest of that run (world-run.sh runs a copy of it, too).
usage() {
  printf '%s\n' "usage: run-world.sh [--timing] [--volume N|off] [--no-record] [--presentmon] [--aftermath] [--warm] [--require-quiet]" \
    "                     [--frames 2400,2600] [--keys '55:Enter,...'] [--route <name>] [--dump-targets]" \
    "                     [--print-env] [--settled-seconds N] [--settled-after-s N] [--settled-timeout N]" \
    "                     [--settled-fps F] [--settled-waiting K] [--console series-x|series-s]" \
    "                     [--profile diag|release] [--copy-mode plain|none] [--heavy-seconds N] [--tag name]" \
    "                     [--require-quiet]" \
    | public_line
}

# A heartbeat from the game's own frame-rate line, about every ten seconds while it runs. Built here, so only the
# frame line's numbers reach the terminal, never the line itself. The log is read from its last 64 KiB only: a long
# run's log is many megabytes, and the newest frame line is always in the tail.
HEARTBEAT_TAIL_BYTES=65536
heartbeat_loop() {
  local line beat
  while sleep 10; do
    line=$(tail -c "$HEARTBEAT_TAIL_BYTES" "$LOG" 2>/dev/null | grep -aE ' fps, [0-9.]+ ms/frame' | tail -1)
    [ -n "$line" ] || continue
    beat=$(heartbeat_line "$line")
    [ -n "$beat" ] && printf '%s\n' "$beat" | public_line
  done
}
main() {
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
# world-run.sh runs a copy of this script beside copies of the files it sources; TOOLS is the harness checkout those
# copies came from, where the helpers, routes and logs stay.
TOOLS=${WORLD_RUN_HARNESS_DIR:-$HERE}
. "$HERE/local-env.sh"
load_local_env "$TOOLS"
# The terminal is streamed: one filter (public-lines.sh) decides what may reach it, and the header's path rule.
. "$HERE/public-lines.sh"
VICTORY_DIR=${VICTORY_DIR:-$TOOLS/../victory}
GAME_EXE=${GAME_EXE:-"<game executable>"}
PROFILE=diag
TIMING=0
PRESENTMON=0
AFTERMATH=0
WARM=0
FRAMES=""
KEYS=""
ROUTE=""
CONSOLE=series-x
COPY_MODE=""
LOOP_LIMIT=""
SKIP=""
DUMP_TARGETS=""
PRINT_ENV=""
HEAVY_SECONDS=""
SETTLED_SECONDS=""
SETTLED_AFTER=""
SETTLED_TIMEOUT=""
SETTLED_FPS=""
SETTLED_WAITING=""
TAG="run"
RECORD=1
DRED=1
VOLUME=4
REQUIRE_QUIET=0
SAVE=""
SAVE_AS=""
GPU_TRACE=0
TRACE_AFTER_MS=""
TRACE_FRAMES=1
RENDERDOC=0
CAPTURE_AFTER_MS=""
HELP=0
# Free space on the logs' drive: refuse to start below MIN_FREE_GB, and end the run below STOP_FREE_GB.
MIN_FREE_GB=${HARNESS_MIN_FREE_GB:-30}
STOP_FREE_GB=${HARNESS_STOP_FREE_GB:-5}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) HELP=1; shift ;;
    --timing) TIMING=1; shift ;;
    --presentmon) PRESENTMON=1; shift ;;
    --aftermath) AFTERMATH=1; shift ;;
    --warm) WARM=1; shift ;;
    --frames) FRAMES=$2; shift 2 ;;
    --keys) KEYS=$2; shift 2 ;;
    --route) ROUTE=$2; shift 2 ;;
    --console) CONSOLE=$2; shift 2 ;;
    --profile) PROFILE=$2; shift 2 ;;
    --copy-mode) COPY_MODE=$2; shift 2 ;;
    --loop-limit) LOOP_LIMIT=$2; shift 2 ;;
    --skip) SKIP=$2; shift 2 ;;
    --dump-targets) DUMP_TARGETS=1; shift ;;
    --print-env) PRINT_ENV=1; shift ;;
    --heavy-seconds) HEAVY_SECONDS=$2; shift 2 ;;
    --settled-seconds) SETTLED_SECONDS=$2; shift 2 ;;
    --settled-after-s) SETTLED_AFTER=$2; shift 2 ;;
    --settled-timeout) SETTLED_TIMEOUT=$2; shift 2 ;;
    --settled-fps) SETTLED_FPS=$2; shift 2 ;;
    --settled-waiting) SETTLED_WAITING=$2; shift 2 ;;
    --tag) TAG=$2; shift 2 ;;
    --require-quiet) REQUIRE_QUIET=1; shift ;;
    --no-record) RECORD=0; shift ;;
    --no-dred) DRED=0; shift ;;
    --volume) VOLUME=$2; shift 2 ;;
    --save) SAVE=$2; shift 2 ;;
    --gpu-trace) GPU_TRACE=1; shift ;;
    --renderdoc) RENDERDOC=1; shift ;;
    --capture-after-ms) CAPTURE_AFTER_MS=$2; shift 2 ;;
    --trace-after-ms) TRACE_AFTER_MS=$2; shift 2 ;;
    --trace-frames) TRACE_FRAMES=$2; shift 2 ;;
    --save-as) SAVE_AS=$2; shift 2 ;;
    *) say_err "unknown argument: $1"; exit 2 ;;
  esac
done

# --help is a question, not a run: it answers before the lock, the binary or anything else is needed.
if [ "$HELP" = 1 ]; then
  usage
  exit 0
fi

# --route: a named key route from harness/routes/<name>.keys, and its default --heavy-seconds or --settled-seconds
# unless given. The route file is one <seconds>:<key>[:<hold>] entry per line with # comments (route-keys.mjs
# reads it).
if [ -n "$ROUTE" ] && [ -n "$KEYS" ]; then
  say_err "--keys and --route together: give one or the other"
  exit 2
fi
if [ -n "$ROUTE" ]; then
  KEYS=$(node "$TOOLS/route-keys.mjs" keys "$TOOLS/routes" "$ROUTE") || exit 2
  ROUTE_HEAVY=$(node "$TOOLS/route-keys.mjs" heavy-seconds "$TOOLS/routes" "$ROUTE") || exit 2
  if [ -z "$HEAVY_SECONDS" ] && [ -n "$ROUTE_HEAVY" ]; then
    HEAVY_SECONDS=$ROUTE_HEAVY
  fi
  ROUTE_SETTLED=$(node "$TOOLS/route-keys.mjs" settled-seconds "$TOOLS/routes" "$ROUTE") || exit 2
  if [ -z "$SETTLED_SECONDS" ] && [ -n "$ROUTE_SETTLED" ]; then
    SETTLED_SECONDS=$ROUTE_SETTLED
  fi
  ROUTE_AFTER=$(node "$TOOLS/route-keys.mjs" settled-after "$TOOLS/routes" "$ROUTE") || exit 2
  if [ -z "$SETTLED_AFTER" ] && [ -n "$ROUTE_AFTER" ]; then
    SETTLED_AFTER=$ROUTE_AFTER
  fi
fi

# A profiled or captured run is one at a time, and its delay is the flag's: without it the trace or capture would
# begin during the loading screen, so it refuses.
if [ "$GPU_TRACE" = 1 ] && [ "$RENDERDOC" = 1 ]; then
  say_err "--gpu-trace and --renderdoc together: give one or the other"
  exit 2
fi
if [ "$RENDERDOC" = 1 ] && [ -z "$CAPTURE_AFTER_MS" ]; then
  say_err "--renderdoc needs --capture-after-ms <ms>: refusing to capture the loading screen"
  exit 2
fi
if [ "$RENDERDOC" = 1 ] && ! [[ "$CAPTURE_AFTER_MS" =~ ^[0-9]+$ ]]; then
  say_err "--capture-after-ms needs a whole number, not '$CAPTURE_AFTER_MS'"
  exit 2
fi
if [ "$GPU_TRACE" = 1 ] && [ -z "$TRACE_AFTER_MS" ]; then
  say_err "--gpu-trace needs --trace-after-ms <ms>: refusing to trace the loading screen"
  exit 2
fi
if [ "$GPU_TRACE" = 1 ]; then
  for PAIR in "trace-after-ms:$TRACE_AFTER_MS" "trace-frames:$TRACE_FRAMES"; do
    NAME=${PAIR%%:*}
    VALUE=${PAIR#*:}
    if ! [[ "$VALUE" =~ ^[0-9]+$ ]] || [ "$VALUE" -lt 0 ]; then
      say_err "--$NAME needs a whole number, not '$VALUE'"
      exit 2
    fi
  done
fi

# A run ends by one clock: the heavy scene's age or the settled scene's. Never both.
if [ -n "$SETTLED_SECONDS" ] && [ -n "$HEAVY_SECONDS" ]; then
  say_err "--settled-seconds and --heavy-seconds together: give one or the other"
  exit 2
fi

# A run holds the harness lock in world-run.sh; calling this script directly would skip it and the OBS refusal.
# --print-env starts nothing and --help answers a question, so both are allowed without it.
if [ "$PRINT_ENV" != 1 ] && [ "${WORLD_RUN_HOLDS_LOCK:-}" != 1 ]; then
  say_err "refused: run this through world-run.sh, which holds the run lock (WORLD_RUN_HOLDS_LOCK=1); --print-env and --help work directly"
  exit 2
fi

SAVE_CONFIG=${VICTORY_CONFIG:-$TOOLS/../victory/victory.toml}
SAVE_CONFIG_DIR=$(cd "$(dirname "$SAVE_CONFIG")" && { pwd -W 2>/dev/null || pwd; })
SAVE_CONFIG="$SAVE_CONFIG_DIR/$(basename "$SAVE_CONFIG")"
export VICTORY_CONFIG="$SAVE_CONFIG"

STAMP=${WORLD_RUN_STAMP:-$(date +%Y%m%d-%H%M%S)}
LOG_DIR=$TOOLS/logs
LOG=$LOG_DIR/$STAMP-$TAG.log
CAPTURES=${VICTORY_CAPTURES:-/captures}
CAPTURE=${CAPTURE:-${CAPTURES%/}/$STAMP-$TAG}
mkdir -p "$LOG_DIR" "$CAPTURE"

BIN=${VICTORY_BIN:-$VICTORY_DIR/target/$PROFILE/victory.exe}
if [ ! -x "$BIN" ]; then
  say_err "no victory binary for profile $PROFILE — build it: (cargo build --profile $PROFILE -p victory --features diagnostics)"
  exit 2
fi
BIN_DIR=$(cd "$(dirname "$BIN")" && { pwd -W 2>/dev/null || pwd; })
BIN="$BIN_DIR/$(basename "$BIN")"
# The runtime's data guard refuses to start the title from inside a git work tree: run from the snapshot folder
# when the binary is in one, otherwise from a fresh folder under the capture folder, and refuse loudly if neither
# is outside a work tree.
RUN_CWD=$(node "$TOOLS/run-cwd.mjs" choose --bin "$BIN" --lane "$VICTORY_DIR" --capture "$CAPTURE") || exit 2

if [ -n "$HEAVY_SECONDS" ] && ! [[ "$HEAVY_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  say_err "--heavy-seconds needs a number, not '$HEAVY_SECONDS'"
  exit 2
fi
for PAIR in "settled-seconds:$SETTLED_SECONDS" "settled-after-s:$SETTLED_AFTER" "settled-timeout:$SETTLED_TIMEOUT" "settled-fps:$SETTLED_FPS" "settled-waiting:$SETTLED_WAITING"; do
  NAME=${PAIR%%:*}
  VALUE=${PAIR#*:}
  if [ -n "$VALUE" ] && ! [[ "$VALUE" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    say_err "--$NAME needs a number, not '$VALUE'"
    exit 2
  fi
done

ENV_ARGS=(VICTORY_LOG=info "VICTORY_WAVE64_EMULATE=emulate" "VICTORY_CONFIG=$SAVE_CONFIG")
# DRED (the card's crash breadcrumbs) is on unless --no-dred, a timing diagnostic: a hang in such a run leaves no
# breadcrumbs. The runtime turns DRED on when the variable is set at all, so it is left out, not set to 0.
[ "$DRED" = 1 ] && ENV_ARGS+=("VICTORY_D3D12_DRED=1")
[ "$TIMING" = 1 ] && ENV_ARGS+=("VICTORY_GPU_TIMING=1")
ENV_ARGS+=("VICTORY_CAPTURE=$CAPTURE")
[ -n "$FRAMES" ] && ENV_ARGS+=("VICTORY_CAPTURE_FRAMES=$FRAMES")
[ -n "$KEYS" ] && ENV_ARGS+=("VICTORY_KEYS=$KEYS")
# The settled watcher's sentinel: VICTORY_KEYS_AFTER names it, and a "+..." entry in VICTORY_KEYS counts from its
# first appearance (job/keys-after in the runtime). A stale one from an earlier run would start the clock at launch.
AFTER=""
if [ -n "$SETTLED_SECONDS" ]; then
  AFTER="$CAPTURE/keys-after"
  rm -f "$AFTER"
  ENV_ARGS+=("VICTORY_KEYS_AFTER=$AFTER")
fi
[ -n "$COPY_MODE" ] && ENV_ARGS+=("VICTORY_COPY_MODE=$COPY_MODE")
[ -n "$LOOP_LIMIT" ] && ENV_ARGS+=("VICTORY_SHADER_LOOP_LIMIT=$LOOP_LIMIT")
[ -n "$SKIP" ] && ENV_ARGS+=("VICTORY_SKIP_PIPELINES=$SKIP")
[ -n "$DUMP_TARGETS" ] && ENV_ARGS+=("VICTORY_DUMP_TARGETS=1" "VICTORY_DUMP_UNSAFE=1")
# --print-env: a test's view of what the run would get; nothing is started.
# Aftermath (diag build, NVIDIA): the crash dump, its JSON and the shader debug info land in the capture folder.
# Markers are on with it: a hang run is for the dump, not for frame times.
if [ "$AFTERMATH" = 1 ]; then
  ROOT=$(cd "$TOOLS/.." && { pwd -W 2>/dev/null || pwd; })
  ENV_ARGS+=("VICTORY_AFTERMATH=$CAPTURE" "VICTORY_AFTERMATH_MARKERS=1"
    "VICTORY_AFTERMATH_DLL=${VICTORY_AFTERMATH_DLL:-$ROOT/tools/nsight-aftermath-sdk-2026.3/lib/x64}")
fi

say "log:     $LOG"
say "capture: $CAPTURE"
say "profile: $PROFILE  console: $CONSOLE  timing: $TIMING  presentmon: $PRESENTMON"
say ""

# --print-env: what the run would get, then stop before anything is started. The tests use it to pin the env, and
# with a capture flag it also prints the command that tool would run.
if [ -n "$PRINT_ENV" ]; then
  printf '%s\n' "${ENV_ARGS[@]}"
  printf '%s\n' run "$GAME_EXE" --execute --console "$CONSOLE" > "$CAPTURE/game-args.txt"
  printf '%s\n' "${ENV_ARGS[@]}" > "$CAPTURE/env.txt"
  if [ "$GPU_TRACE" = 1 ]; then
    printf 'gpu-trace: '
    node "$TOOLS/gpu-trace.mjs" print --bin "$BIN" --dir "$VICTORY_DIR" \
      --game-args-file "$CAPTURE/game-args.txt" --env-file "$CAPTURE/env.txt" \
      --after-ms "$TRACE_AFTER_MS" --frames "$TRACE_FRAMES" --out "$CAPTURE/gputrace"
  fi
  if [ "$RENDERDOC" = 1 ]; then
    printf 'renderdoc: '
    node "$TOOLS/renderdoc.mjs" print --bin "$BIN" --dir "$VICTORY_DIR" \
      --game-args-file "$CAPTURE/game-args.txt" --out "$CAPTURE/rdoc" --after-ms "$CAPTURE_AFTER_MS"
  fi
  exit 0
fi

# Free space is guarded twice: a run that starts on a drive with too little room would lose its log first, so it is
# refused here; disk-guard.mjs then watches every poll while the game runs.
if ! DISK_CHECK=$(node "$TOOLS/disk-guard.mjs" check --path "$LOG_DIR" --min "$MIN_FREE_GB" 2>&1); then
  say_err "refused: ${DISK_CHECK:-the free-space check failed}"
  exit 2
fi

# The log starts with what the run was, one setting per line, so experiment-table.mjs can read it back.
{
  # The build line: a lane checkout's commit, or, for a snapshot build, the commit, branch and profile from
  # snapshot.txt beside VICTORY_BIN (build-line.mjs says why).
  node "$TOOLS/build-line.mjs" "$VICTORY_DIR" "${VICTORY_BIN:-}" "$PROFILE" "$CONSOLE"
  for E in "${ENV_ARGS[@]}"; do harness_env_line "$E"; done
  [ -n "${VICTORY_BIN:-}" ] && harness_env_line "VICTORY_BIN=$VICTORY_BIN"
  # A warm-up's bar feed writes its own errors to a file beside its log, never to null (a feed that died silently
  # left the bar stale on the 09:19 warm-up).
  [ "$WARM" = 1 ] && echo "harness: the warm feed's errors go to $LOG.warm.feed"
  # A variable given on the command line (VICTORY_D3D12_DEBUG=1 ./run-world.sh) is passed through to the game
  # but is not in ENV_ARGS; record every other VICTORY_* variable too so the experiment table can tell runs apart.
  SET_NAMES=" VICTORY_BIN "
  for E in "${ENV_ARGS[@]}"; do SET_NAMES+="${E%%=*} "; done
  for NAME in $(compgen -e | sort); do
    case "$NAME" in VICTORY_*) ;; *) continue ;; esac
    case "$SET_NAMES" in *" $NAME "*) continue ;; esac
    harness_env_line "$NAME=${!NAME}"
  done
  echo "capture: $(harness_public_path "$CAPTURE")"
  echo "harness env: cwd=$(harness_public_path "$RUN_CWD")"
  # The volumes the run reads and writes, once: the game's, and the cache's and data's when on other drives.
  # Each helper's exit is recorded in the log; a failure is a line to read, not a silence to blame on the game.
  node "$TOOLS/disk-usage.mjs" --config "$SAVE_CONFIG" "game=$(dirname "$GAME_EXE")" 2>&1
  echo "harness: disk-usage exit=$?"
  [ -n "$ROUTE" ] && echo "harness env: route=$ROUTE"
  [ -n "$SETTLED_SECONDS" ] && echo "harness env: settled-seconds=$SETTLED_SECONDS"
  [ -n "$SETTLED_TIMEOUT" ] && echo "harness env: settled-timeout=$SETTLED_TIMEOUT"
  [ -n "$SETTLED_FPS" ] && echo "harness env: settled-fps=$SETTLED_FPS"
  [ -n "$SETTLED_WAITING" ] && echo "harness env: settled-waiting=$SETTLED_WAITING"
  [ "$GPU_TRACE" = 1 ] && echo "harness env: gpu-trace=after ${TRACE_AFTER_MS} ms, ${TRACE_FRAMES} frames, output $(harness_public_path "$CAPTURE")/gputrace"
  [ "$RENDERDOC" = 1 ] && echo "harness env: renderdoc=after ${CAPTURE_AFTER_MS} ms, output $(harness_public_path "$CAPTURE")/rdoc"
  if [ "$RECORD" = 1 ]; then echo "harness env: record=on"; else echo "harness env: record=off"; fi
  echo "harness env: volume=$VOLUME"
} >"$LOG"

# --save: the title's save folder is made to hold exactly the named snapshot before the game starts. The current
# folder is copied to <VICTORY_SAVE_BACKUPS, default $HOME/victory-save-backups>/before-runs/<stamp>-<name> and verified
# first; save-snapshot.mjs
# refuses while a run holds the harness lock, and removes nothing it has not just copied and verified.
if [ -n "$SAVE" ]; then
  say "restore: $SAVE"
  if ! node "$TOOLS/save-snapshot.mjs" restore "$SAVE" --config "$SAVE_CONFIG" --lock "$TOOLS/run.lock" ${WORLD_RUN_HOLDS_LOCK:+--caller-holds-lock} >>"$LOG" 2>&1; then
    say_err "save restore failed; the saves were left as they were; see the log"
    exit 2
  fi
fi

# One pipeline library per build (pipeline-library.sh says why and how). This build's own is put in place now, whatever
# build ran last, and put away when the run ends: below once the game has ended, and by the EXIT trap if the harness is
# stopped or fails first. It prints one line, and refuses to start if the folder cannot be made this build's.
PIPE_TOOLS=$TOOLS
. "$HERE/pipeline-library.sh"
PIPE_LOG=$LOG
pipeline_library_enter "$(pipeline_library_cache_dir "$SAVE_CONFIG")" "$(pipeline_library_key "$BIN")" || exit 2
trap pipeline_library_leave EXIT
trap 'exit 130' INT TERM

# --warm: run the title's own pre-compile (`victory warm`) so every shader is in the cache this run reads and its
# compute pipelines are made on this GPU, before the game starts. The loop limit and the wave mode are part of a
# translation, so they are the run's own.
if [ "$WARM" = 1 ]; then
  # The per-program report the translator writes (name, stage, outcome, reason, ms, DXIL bytes), read by
  # `shader-compile-report.mjs --programs`; a stale file from an earlier run is removed first.
  REPORT_TSV="$CAPTURE/translate-report.txt"
  rm -f "$REPORT_TSV"
  WARM_ENV=(VICTORY_LOG=info "VICTORY_WAVE64_EMULATE=emulate" "VICTORY_TRANSLATE_REPORT=$REPORT_TSV" "VICTORY_CONFIG=$SAVE_CONFIG")
  [ -n "$LOOP_LIMIT" ] && WARM_ENV+=("VICTORY_SHADER_LOOP_LIMIT=$LOOP_LIMIT")
  WARM_T0=$(date +%s)
  PRECOMPILE_JSON=${VICTORY_PRECOMPILE_JSON:-$HOME/.config/victory-harness/stream/precompile.json}
  say "warm-up: warm (see the log)"
  # The stream overlay reads this file: progress at most twice a second while the warm-up runs, then its end
  # state from `final` with the warm-up's exit code. The warm log prints no totals, so the bar counts its
  # per-program and per-pipeline lines against the newest earlier warm log in this folder (precompile-progress.mjs).
  FEED_LOG="$LOG.warm.feed"
  node "$TOOLS/precompile-progress.mjs" follow --log "$LOG.warm" --out "$PRECOMPILE_JSON"     --started-ms "$((WARM_T0 * 1000))" >"$FEED_LOG" 2>&1 &
  PRE_PID=$!
  # Raised, as the game is: other lanes' compilers starve the warm-up at normal priority (852 s against 682 s).
  # While OBS is running it is gentle instead (obs.sh): below normal and half the logical processors, so the stream
  # does not stutter; VICTORY_WARM_GENTLE=1 or 0 forces either. The selection shares run-process.ps1's rules and
  # matches only a victory.exe created after this warm-up began whose command line has " warm ", so it can never
  # select a real game.
  . "$HERE/obs.sh"
  warm_mode_decide
  warm_mode_line
  WARM_ARGS=()
  WARM_PS_FLAGS=-Translate
  if [ "$WARM_MODE" = gentle ]; then
    WARM_ARGS=(--jobs "$(warm_jobs)")
    WARM_PS_FLAGS="-Translate -Gentle"
  fi
  ( sleep 4; RUN_WORLD_WARM_STARTED_EPOCH="$WARM_T0" \
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TOOLS/raise-priority.ps1" $WARM_PS_FLAGS >&2 ) > >(public_line) 2>&1 &
  WARM_RAISER=$!
  (cd "$VICTORY_DIR" && env "${WARM_ENV[@]}" "$BIN" warm ${WARM_ARGS[@]+"${WARM_ARGS[@]}"} "$(dirname "$GAME_EXE")") >"$LOG.warm" 2>&1
  WARM_RC=$?
  wait "$WARM_RAISER" 2>/dev/null
  kill -0 "$PRE_PID" 2>/dev/null && kill "$PRE_PID" 2>/dev/null
  wait "$PRE_PID" 2>/dev/null
  node "$TOOLS/precompile-progress.mjs" final --log "$LOG.warm" --out "$PRECOMPILE_JSON"     --started-ms "$((WARM_T0 * 1000))" --exit "$WARM_RC" >>"$FEED_LOG" 2>&1
  printf 'harness: feed exit=%s\n' "$?" >>"$LOG"
  WARM_LINE="warm-up: exit=$WARM_RC after $(( $(date +%s) - WARM_T0 )) s"
  printf '%s\n' "$WARM_LINE" >>"$LOG"
  say "$WARM_LINE"
fi

# The load this leg runs under, so a frame time can be read with the machine that produced it in view. One line just
# before the game starts and one when it ends; load-line.mjs samples CPU over five seconds, free and committed
# memory, and the builders running by name. Each helper's exit is recorded like the others'. The check runs before
# any watcher starts, so a refusal leaves nothing behind.
LOAD_START=$(node "$TOOLS/load-line.mjs" start 2>>"$LOG")
LOAD_START_RC=$?
printf '%s\n' "$LOAD_START" >>"$LOG"
printf 'harness: load start exit=%s\n' "$LOAD_START_RC" >>"$LOG"
# --require-quiet: refuse before the game starts when the start sample is not comparable (exit 3), naming the
# threshold that failed. Off by default.
if [ "$REQUIRE_QUIET" = 1 ]; then
  if [ "$LOAD_START_RC" != 0 ]; then
    say_err "refused: the start load could not be read"
    exit 3
  fi
  if ! QUIET_REASON=$(node "$TOOLS/load-line.mjs" check "$LOAD_START" 2>>"$LOG"); then
    say_err "refused: ${QUIET_REASON:-the start load is not quiet}"
    exit 3
  fi
fi

# PresentMon starts on its own when the heavy 3D scene begins, so it cannot miss the window.
PM_PID=""
if [ "$PRESENTMON" = 1 ]; then
  node "$TOOLS/presentmon.mjs" watch "$LOG" "$CAPTURE/presentmon.csv" > >(public_line) 2>&1 &
  PM_PID=$!
fi

# The game is raised to above-normal priority so other lanes' compilers cannot starve its pipeline workers
# (raise-priority.ps1 says why, picks this run's process, and prints one line saying what it raised).
RUN_STARTED=$(date +%s)
( sleep 4; RUN_WORLD_GAME_EXE="$GAME_EXE" RUN_WORLD_STARTED_EPOCH="$RUN_STARTED"     powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TOOLS/raise-priority.ps1" >&2 ) > >(public_line) 2>&1 &

# The game plays at 4% in Windows' mixer unless told otherwise (--volume N, or --volume off to leave it alone):
# the title is loud and the PC is streaming. set-volume.ps1 touches only this run's game, each audio session once.
if [ "$VOLUME" != off ]; then
  ( sleep 4; RUN_WORLD_GAME_EXE="$GAME_EXE" RUN_WORLD_STARTED_EPOCH="$RUN_STARTED"       powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TOOLS/set-volume.ps1" -Percent "$VOLUME" >>"$LOG" 2>&1 ) &
fi

# Every run records its own window at two frames a second, into its capture folder; --no-record turns it off.
# record-screen.mjs selects only this run's game (run-process.ps1 -Strict) and ends only its own ffmpeg child.
REC_PID=""
if [ "$RECORD" = 1 ]; then
  RUN_WORLD_GAME_EXE="$GAME_EXE" RUN_WORLD_STARTED_EPOCH="$RUN_STARTED" \
    node "$TOOLS/record-screen.mjs" "$CAPTURE/screen.mp4" >>"$LOG" 2>&1 &
  REC_PID=$!
fi

# --heavy-seconds: end the game N seconds after the first frame line that is heavy (draws + dropped >= 1000).
# It appends "harness: ended by --heavy-seconds ..." to the log before the summary below reads it.
HEAVY_PID=""
if [ -n "$HEAVY_SECONDS" ]; then
  RUN_WORLD_GAME_EXE="$GAME_EXE" RUN_WORLD_STARTED_EPOCH="$RUN_STARTED" \
    node "$TOOLS/heavy-watch.mjs" "$LOG" "$HEAVY_SECONDS" > >(public_line) 2>&1 &
  HEAVY_PID=$!
fi
SETTLE_PID=""
if [ -n "$SETTLED_SECONDS" ]; then
  SETTLE_ARGS=(--after-file "$AFTER")
  [ -n "$SETTLED_TIMEOUT" ] && SETTLE_ARGS+=(--timeout "$SETTLED_TIMEOUT")
  [ -n "$SETTLED_FPS" ] && SETTLE_ARGS+=(--floor-fps "$SETTLED_FPS")
  [ -n "$SETTLED_WAITING" ] && SETTLE_ARGS+=(--waiting "$SETTLED_WAITING")
  [ -n "$SETTLED_AFTER" ] && SETTLE_ARGS+=(--settle-after-s "$SETTLED_AFTER")
  RUN_WORLD_GAME_EXE="$GAME_EXE" RUN_WORLD_STARTED_EPOCH="$RUN_STARTED" \
    node "$TOOLS/settled-watch.mjs" "$LOG" "$SETTLED_SECONDS" "${SETTLE_ARGS[@]}" > >(public_line) 2>&1 &
  SETTLE_PID=$!
fi

# The free-space guard: every poll, and under the floor it appends "harness: ended: disk below N GB" and ends this
# run's game. It exits by itself once the game is gone.
DISK_PID=""
if [ "$STOP_FREE_GB" != off ]; then
  RUN_WORLD_GAME_EXE="$GAME_EXE" RUN_WORLD_STARTED_EPOCH="$RUN_STARTED" \
    node "$TOOLS/disk-guard.mjs" watch --log "$LOG" --path "$LOG_DIR" --below "$STOP_FREE_GB" > >(public_line) 2>&1 &
  DISK_PID=$!
fi

# The terminal's heartbeat, from the game's own frame-rate line, while the game runs.
heartbeat_loop &
HEARTBEAT_PID=$!

# A capture flag runs the game under its tool, with the same arguments and environment, written to files so paths
# with spaces survive. Without one, the game starts directly.
if [ "$GPU_TRACE" = 1 ] || [ "$RENDERDOC" = 1 ]; then
  printf '%s\n' run "$GAME_EXE" --execute --console "$CONSOLE" > "$CAPTURE/game-args.txt"
  printf '%s\n' "${ENV_ARGS[@]}" > "$CAPTURE/env.txt"
fi
# The game's output goes to the log only; the terminal sees the heartbeat and the harness's own filtered lines.
if [ "$GPU_TRACE" = 1 ]; then
  node "$TOOLS/gpu-trace.mjs" run --bin "$BIN" --dir "$VICTORY_DIR" \
    --game-args-file "$CAPTURE/game-args.txt" --env-file "$CAPTURE/env.txt" \
    --after-ms "$TRACE_AFTER_MS" --frames "$TRACE_FRAMES" --out "$CAPTURE/gputrace" \
    >>"$LOG" 2>&1
  RC=$?  # ngfx.exe's own exit code, which is the traced game's
elif [ "$RENDERDOC" = 1 ]; then
  node "$TOOLS/renderdoc.mjs" run --bin "$BIN" --dir "$VICTORY_DIR" \
    --game-args-file "$CAPTURE/game-args.txt" --out "$CAPTURE/rdoc" --after-ms "$CAPTURE_AFTER_MS" \
    >>"$LOG" 2>&1
  RC=$?
else
  (cd "$VICTORY_DIR" && env "${ENV_ARGS[@]}" "$BIN" run "$GAME_EXE" --execute --console "$CONSOLE") \
    >>"$LOG" 2>&1
  RC=$?  # victory.exe's own exit code
fi

# The game has ended: its library is stored under its build's name before the slow part below (the EXIT trap is the
# same call, for a run that never gets here). The end load is taken first, while the leg's own processes are gone.
node "$TOOLS/load-line.mjs" end >>"$LOG" 2>&1
printf 'harness: load end exit=%s\n' "$?" >>"$LOG"
pipeline_library_leave

# The watchers end the game themselves, so give them a moment to record that in the log before the summary.
if [ -n "$DISK_PID" ]; then
  for _ in $(seq 1 50); do
    kill -0 "$DISK_PID" 2>/dev/null || break
    sleep 0.1
  done
  kill -0 "$DISK_PID" 2>/dev/null && kill "$DISK_PID" 2>/dev/null
  wait "$DISK_PID" 2>/dev/null
fi
if [ -n "$HEARTBEAT_PID" ]; then
  kill -0 "$HEARTBEAT_PID" 2>/dev/null && kill "$HEARTBEAT_PID" 2>/dev/null
  wait "$HEARTBEAT_PID" 2>/dev/null
fi
if [ -n "$HEAVY_PID" ]; then
  for _ in $(seq 1 50); do
    kill -0 "$HEAVY_PID" 2>/dev/null || break
    sleep 0.1
  done
  kill -0 "$HEAVY_PID" 2>/dev/null && kill "$HEAVY_PID" 2>/dev/null
  wait "$HEAVY_PID" 2>/dev/null
fi
if [ -n "$SETTLE_PID" ]; then
  for _ in $(seq 1 50); do
    kill -0 "$SETTLE_PID" 2>/dev/null || break
    sleep 0.1
  done
  kill -0 "$SETTLE_PID" 2>/dev/null && kill "$SETTLE_PID" 2>/dev/null
  wait "$SETTLE_PID" 2>/dev/null
fi

if [ -n "$PM_PID" ]; then
  kill -0 "$PM_PID" 2>/dev/null && kill "$PM_PID" 2>/dev/null
  wait "$PM_PID" 2>/dev/null
fi

# The recorder ends when the game process does; give it its clean stop (and its own last line) before the summary.
if [ -n "$REC_PID" ]; then
  for _ in $(seq 1 150); do
    kill -0 "$REC_PID" 2>/dev/null || break
    sleep 0.1
  done
  kill -0 "$REC_PID" 2>/dev/null && kill "$REC_PID" 2>/dev/null
  wait "$REC_PID" 2>/dev/null
fi
# The sheets are what an agent opens to review a run; a failure here never fails the run.
if [ "$RECORD" = 1 ] && [ -f "$CAPTURE/screen.mp4" ]; then
  node "$TOOLS/contact-sheets.mjs" "$CAPTURE/screen.mp4" >>"$LOG" 2>&1 || say_err "contact sheets: failed"
fi

# --save-as: the save folder as the run left it becomes a new snapshot; never overwrites an existing name.
if [ -n "$SAVE_AS" ]; then
  if node "$TOOLS/save-snapshot.mjs" save-as "$SAVE_AS" --config "$SAVE_CONFIG" >>"$LOG" 2>&1; then
    say "saved: $SAVE_AS"
  else
    say_err "save-as failed; see the log"
  fi
fi

# The driver's own account of a GPU fault is in the Windows System log; append it before the summary reads the log.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$TOOLS/driver-events.ps1" "$RUN_STARTED" "$(date +%s)" >>"$LOG" 2>>"$LOG"
printf 'harness: driver-events exit=%s\n' "$?" >>"$LOG"

# The game's own exit code, before the parser reads the log: a non-zero code with no failure line is a run
# something else stopped, not a log that simply ends.
echo "harness: victory exit=$RC" >>"$LOG"

say ""
# The summary is written to a temporary file and renamed, so a crash cannot leave half of one; its exit is recorded.
SUMMARY_RC=1
if node "$TOOLS/summarize-run.mjs" "$LOG" >"$LOG.md.tmp" 2>>"$LOG"; then
  if mv -f "$LOG.md.tmp" "$LOG.md"; then SUMMARY_RC=0; fi
fi
rm -f "$LOG.md.tmp"
printf 'harness: summary exit=%s\n' "$SUMMARY_RC" >>"$LOG"
[ "$SUMMARY_RC" = 0 ] && cat "$LOG.md" | public_line
say "victory exit=$RC"
[ "$GPU_TRACE" = 1 ] && say "profiled: this code is Nsight's, not the title's"
[ "$RENDERDOC" = 1 ] && say "captured: this code is RenderDoc's, not the title's"
exit "$RC"
}
main "$@"
exit

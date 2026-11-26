#!/usr/bin/env bash
# One VIctory world run, with the diagnostics that matter, condensed at exit.
# usage: run-world.sh [--timing] [--volume N|off] [--no-record] [--presentmon] [--aftermath] [--warm] [--frames 2400,2600] [--keys '55:Enter,...']
#                     [--route <name>] [--settled-seconds N] [--settled-timeout N]
#                     [--settled-fps F] [--settled-waiting K]
#                     [--console series-x|series-s] [--profile diag|release]
#                     [--copy-mode plain|none] [--heavy-seconds N] [--tag name]
# VICTORY_BIN overrides the binary (default $VICTORY_DIR/target/$PROFILE/victory.exe). GAME_EXE, VICTORY_CAPTURES (the
# root each run's capture folder goes under; CAPTURE names one run's folder outright) and VICTORY_SAVE_BACKUPS come
# from the environment, else harness/local.env on a machine that has one, else the main PC's E: paths below.
set -u

# Windows paths throughout: node is a native program, and under a Capy terminal (MSYS_NO_PATHCONV=1 and
# MSYS2_ARG_CONV_EXCL=*) a /c/... argument reaches it as C:\c\... so every `node "$HERE/..."` below fails to load.
HERE=$(cd "$(dirname "$0")" && { pwd -W 2>/dev/null || pwd; })
. "$HERE/local-env.sh"
load_local_env "$HERE"
VICTORY_DIR=${VICTORY_DIR:-$HERE/../victory}
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
HEAVY_SECONDS=""
SETTLED_SECONDS=""
SETTLED_TIMEOUT=""
SETTLED_FPS=""
SETTLED_WAITING=""
TAG="run"
RECORD=1
VOLUME=4
SAVE=""
SAVE_AS=""
GPU_TRACE=0
TRACE_AFTER_MS=""
TRACE_FRAMES=1
RENDERDOC=0
CAPTURE_AFTER_MS=""

while [ $# -gt 0 ]; do
  case "$1" in
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
    --heavy-seconds) HEAVY_SECONDS=$2; shift 2 ;;
    --settled-seconds) SETTLED_SECONDS=$2; shift 2 ;;
    --settled-timeout) SETTLED_TIMEOUT=$2; shift 2 ;;
    --settled-fps) SETTLED_FPS=$2; shift 2 ;;
    --settled-waiting) SETTLED_WAITING=$2; shift 2 ;;
    --tag) TAG=$2; shift 2 ;;
    --no-record) RECORD=0; shift ;;
    --volume) VOLUME=$2; shift 2 ;;
    --save) SAVE=$2; shift 2 ;;
    --gpu-trace) GPU_TRACE=1; shift ;;
    --renderdoc) RENDERDOC=1; shift ;;
    --capture-after-ms) CAPTURE_AFTER_MS=$2; shift 2 ;;
    --trace-after-ms) TRACE_AFTER_MS=$2; shift 2 ;;
    --trace-frames) TRACE_FRAMES=$2; shift 2 ;;
    --save-as) SAVE_AS=$2; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

# --route: a named key route from harness/routes/<name>.keys, and its default --heavy-seconds or --settled-seconds
# unless given. The route file is one <seconds>:<key>[:<hold>] entry per line with # comments (route-keys.mjs
# reads it).
if [ -n "$ROUTE" ] && [ -n "$KEYS" ]; then
  echo "--keys and --route together: give one or the other" >&2
  exit 2
fi
if [ -n "$ROUTE" ]; then
  KEYS=$(node "$HERE/route-keys.mjs" keys "$HERE/routes" "$ROUTE") || exit 2
  ROUTE_HEAVY=$(node "$HERE/route-keys.mjs" heavy-seconds "$HERE/routes" "$ROUTE") || exit 2
  if [ -z "$HEAVY_SECONDS" ] && [ -n "$ROUTE_HEAVY" ]; then
    HEAVY_SECONDS=$ROUTE_HEAVY
  fi
  ROUTE_SETTLED=$(node "$HERE/route-keys.mjs" settled-seconds "$HERE/routes" "$ROUTE") || exit 2
  if [ -z "$SETTLED_SECONDS" ] && [ -n "$ROUTE_SETTLED" ]; then
    SETTLED_SECONDS=$ROUTE_SETTLED
  fi
fi

# A profiled or captured run is one at a time, and its delay is the flag's: without it the trace or capture would
# begin during the loading screen, so it refuses.
if [ "$GPU_TRACE" = 1 ] && [ "$RENDERDOC" = 1 ]; then
  echo "--gpu-trace and --renderdoc together: give one or the other" >&2
  exit 2
fi
if [ "$RENDERDOC" = 1 ] && [ -z "$CAPTURE_AFTER_MS" ]; then
  echo "--renderdoc needs --capture-after-ms <ms>: refusing to capture the loading screen" >&2
  exit 2
fi
if [ "$RENDERDOC" = 1 ] && ! [[ "$CAPTURE_AFTER_MS" =~ ^[0-9]+$ ]]; then
  echo "--capture-after-ms needs a whole number, not '$CAPTURE_AFTER_MS'" >&2
  exit 2
fi
if [ "$GPU_TRACE" = 1 ] && [ -z "$TRACE_AFTER_MS" ]; then
  echo "--gpu-trace needs --trace-after-ms <ms>: refusing to trace the loading screen" >&2
  exit 2
fi
if [ "$GPU_TRACE" = 1 ]; then
  for PAIR in "trace-after-ms:$TRACE_AFTER_MS" "trace-frames:$TRACE_FRAMES"; do
    NAME=${PAIR%%:*}
    VALUE=${PAIR#*:}
    if ! [[ "$VALUE" =~ ^[0-9]+$ ]] || [ "$VALUE" -lt 0 ]; then
      echo "--$NAME needs a whole number, not '$VALUE'" >&2
      exit 2
    fi
  done
fi

# A run ends by one clock: the heavy scene's age or the settled scene's. Never both.
if [ -n "$SETTLED_SECONDS" ] && [ -n "$HEAVY_SECONDS" ]; then
  echo "--settled-seconds and --heavy-seconds together: give one or the other" >&2
  exit 2
fi

SAVE_CONFIG=${VICTORY_CONFIG:-$HERE/../victory/victory.toml}
SAVE_CONFIG_DIR=$(cd "$(dirname "$SAVE_CONFIG")" && { pwd -W 2>/dev/null || pwd; })
SAVE_CONFIG="$SAVE_CONFIG_DIR/$(basename "$SAVE_CONFIG")"
export VICTORY_CONFIG="$SAVE_CONFIG"

STAMP=$(date +%Y%m%d-%H%M%S)
LOG_DIR=$HERE/logs
LOG=$LOG_DIR/$STAMP-$TAG.log
CAPTURES=${VICTORY_CAPTURES:-/captures}
CAPTURE=${CAPTURE:-${CAPTURES%/}/$STAMP-$TAG}
mkdir -p "$LOG_DIR" "$CAPTURE"

BIN=${VICTORY_BIN:-$VICTORY_DIR/target/$PROFILE/victory.exe}
if [ ! -x "$BIN" ]; then
  echo "no $BIN — build it: (cd '$VICTORY_DIR' && cargo build --profile $PROFILE -p victory --features diagnostics)" >&2
  exit 2
fi
BIN_DIR=$(cd "$(dirname "$BIN")" && { pwd -W 2>/dev/null || pwd; })
BIN="$BIN_DIR/$(basename "$BIN")"
# The title reads its id and storage quota from the MicrosoftGame.Config beside its executable, so the two have to be
# in one folder; without the manifest it reaches System Init with title id 00000000 and dies. GAME_EXE names the
# executable wherever it lives, and game-dir.mjs finds the dump it belongs to: when the dump has no copy it hardlinks
# the executable in beside the manifest, under a stage folder, and one clear sentence replaces the crash when the dump
# or the executable cannot be found. GAME_MANIFEST names the dump outright and GAME_STAGE the stage folder.
GAME_BEFORE=$GAME_EXE
GAME_ARGS=(--exe "$GAME_EXE" --stage "${GAME_STAGE:-${CAPTURES%/}/game}")
[ -n "${GAME_MANIFEST:-}" ] && GAME_ARGS+=(--manifest "$GAME_MANIFEST")
GAME_EXE=$(node "$HERE/game-dir.mjs" prepare "${GAME_ARGS[@]}") || exit 2
# The runtime's data guard refuses to start the title from inside a git work tree: run from the snapshot folder
# when the binary is in one, otherwise from a fresh folder under the capture folder, and refuse loudly if neither
# is outside a work tree.
RUN_CWD=$(node "$HERE/run-cwd.mjs" choose --bin "$BIN" --lane "$VICTORY_DIR" --capture "$CAPTURE") || exit 2

if [ -n "$HEAVY_SECONDS" ] && ! [[ "$HEAVY_SECONDS" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  echo "--heavy-seconds needs a number, not '$HEAVY_SECONDS'" >&2
  exit 2
fi
for PAIR in "settled-seconds:$SETTLED_SECONDS" "settled-timeout:$SETTLED_TIMEOUT" "settled-fps:$SETTLED_FPS" "settled-waiting:$SETTLED_WAITING"; do
  NAME=${PAIR%%:*}
  VALUE=${PAIR#*:}
  if [ -n "$VALUE" ] && ! [[ "$VALUE" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
    echo "--$NAME needs a number, not '$VALUE'" >&2
    exit 2
  fi
done

ENV_ARGS=(VICTORY_LOG=info "VICTORY_WAVE64_EMULATE=emulate" "VICTORY_D3D12_DRED=1" "VICTORY_CONFIG=$SAVE_CONFIG")
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
[ -n "$DUMP_TARGETS" ] && ENV_ARGS+=("VICTORY_DUMP_TARGETS=1")
# Aftermath (diag build, NVIDIA): the crash dump, its JSON and the shader debug info land in the capture folder.
# Markers are on with it: a hang run is for the dump, not for frame times.
if [ "$AFTERMATH" = 1 ]; then
  ROOT=$(cd "$HERE/.." && { pwd -W 2>/dev/null || pwd; })
  ENV_ARGS+=("VICTORY_AFTERMATH=$CAPTURE" "VICTORY_AFTERMATH_MARKERS=1"
    "VICTORY_AFTERMATH_DLL=${VICTORY_AFTERMATH_DLL:-$ROOT/tools/nsight-aftermath-sdk-2026.3/lib/x64}")
fi

echo "log:     $LOG"
echo "capture: $CAPTURE"
echo "profile: $PROFILE  console: $CONSOLE  timing: $TIMING  presentmon: $PRESENTMON"
echo

# The log starts with what the run was, one setting per line, so experiment-table.mjs can read it back.
{
  # The build line: a lane checkout's commit, or, for a snapshot build, the commit, branch and profile from
  # snapshot.txt beside VICTORY_BIN (build-line.mjs says why).
  node "$HERE/build-line.mjs" "$VICTORY_DIR" "${VICTORY_BIN:-}" "$PROFILE" "$CONSOLE"
  for E in "${ENV_ARGS[@]}"; do echo "harness env: $E"; done
  [ -n "${VICTORY_BIN:-}" ] && echo "harness env: VICTORY_BIN=$VICTORY_BIN"
  # A variable given on the command line (VICTORY_D3D12_DEBUG=1 ./run-world.sh) is passed through to the game
  # but is not in ENV_ARGS; record every other VICTORY_* variable too so the experiment table can tell runs apart.
  SET_NAMES=" VICTORY_BIN "
  for E in "${ENV_ARGS[@]}"; do SET_NAMES+="${E%%=*} "; done
  for NAME in $(compgen -e | sort); do
    case "$NAME" in VICTORY_*) ;; *) continue ;; esac
    case "$SET_NAMES" in *" $NAME "*) continue ;; esac
    echo "harness env: $NAME=${!NAME}"
  done
  echo "capture: $CAPTURE"
  echo "harness env: cwd=$RUN_CWD"
  # The volumes the run reads and writes, once: the game's, and the cache's and data's when on other drives.
  node "$HERE/disk-usage.mjs" --config "$SAVE_CONFIG" "game=$(dirname "$GAME_EXE")" || true
  # The stage folder, when the executable had to be hardlinked beside the manifest: the launch reads from there, not
  # from the folder GAME_EXE named.
  if [ "$GAME_EXE" != "$GAME_BEFORE" ]; then echo "harness env: game-staged=$GAME_EXE"; fi
  [ -n "$ROUTE" ] && echo "harness env: route=$ROUTE"
  [ -n "$SETTLED_SECONDS" ] && echo "harness env: settled-seconds=$SETTLED_SECONDS"
  [ -n "$SETTLED_TIMEOUT" ] && echo "harness env: settled-timeout=$SETTLED_TIMEOUT"
  [ -n "$SETTLED_FPS" ] && echo "harness env: settled-fps=$SETTLED_FPS"
  [ -n "$SETTLED_WAITING" ] && echo "harness env: settled-waiting=$SETTLED_WAITING"
  [ "$GPU_TRACE" = 1 ] && echo "harness env: gpu-trace=after ${TRACE_AFTER_MS} ms, ${TRACE_FRAMES} frames, output $CAPTURE/gputrace"
  [ "$RENDERDOC" = 1 ] && echo "harness env: renderdoc=after ${CAPTURE_AFTER_MS} ms, output $CAPTURE/rdoc"
  if [ "$RECORD" = 1 ]; then echo "harness env: record=on"; else echo "harness env: record=off"; fi
  echo "harness env: volume=$VOLUME"
} >"$LOG"

# --save: the title's save folder is made to hold exactly the named snapshot before the game starts. The current
# folder is copied to <VICTORY_SAVE_BACKUPS, default $HOME/victory-save-backups>/before-runs/<stamp>-<name> and verified
# first; save-snapshot.mjs
# refuses while a run holds the harness lock, and removes nothing it has not just copied and verified.
if [ -n "$SAVE" ]; then
  echo "restore: $SAVE"
  if ! node "$HERE/save-snapshot.mjs" restore "$SAVE" --config "$SAVE_CONFIG" --lock "$HERE/run.lock" ${WORLD_RUN_HOLDS_LOCK:+--caller-holds-lock} >>"$LOG" 2>&1; then
    echo "save restore failed; the saves were left as they were (log: $LOG)" >&2
    tail -2 "$LOG" >&2
    exit 2
  fi
fi

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
  echo "warm-up: warm (log: $LOG.warm; programs: $REPORT_TSV)"
  # The stream overlay reads this file: progress at most twice a second while the warm-up runs, then its end
  # state from `final` with the warm-up's exit code. `--one-phase`: our line's `warm` translates and makes
  # compute pipelines as it goes, with no separate pipeline phase, so its bar is the translation's own.
  node "$HERE/precompile-progress.mjs" follow --log "$LOG.warm" --out "$PRECOMPILE_JSON"     --started-ms "$((WARM_T0 * 1000))" --one-phase >/dev/null 2>&1 &
  PRE_PID=$!
  # The warm-up is raised as the game is: other lanes' compilers starve it at normal priority (852 s against
  # 682 s). The selection shares run-process.ps1's rules and matches only a victory.exe created after this
  # warm-up began whose command line has " warm ", so it can never select a real game.
  ( sleep 4; RUN_WORLD_WARM_STARTED_EPOCH="$WARM_T0" \
      powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HERE/raise-priority.ps1" -Translate >&2 ) 2>&1 &
  WARM_RAISER=$!
  (cd "$VICTORY_DIR" && env "${WARM_ENV[@]}" "$BIN" warm "$(dirname "$GAME_EXE")") >"$LOG.warm" 2>&1
  WARM_RC=$?
  wait "$WARM_RAISER" 2>/dev/null
  kill -0 "$PRE_PID" 2>/dev/null && kill "$PRE_PID" 2>/dev/null
  wait "$PRE_PID" 2>/dev/null
  node "$HERE/precompile-progress.mjs" final --log "$LOG.warm" --out "$PRECOMPILE_JSON"     --started-ms "$((WARM_T0 * 1000))" --exit "$WARM_RC" --one-phase >/dev/null 2>&1 || true
  echo "warm-up: exit=$WARM_RC after $(( $(date +%s) - WARM_T0 )) s"
fi

# PresentMon starts on its own when the heavy 3D scene begins, so it cannot miss the window.
PM_PID=""
if [ "$PRESENTMON" = 1 ]; then
  node "$HERE/presentmon.mjs" watch "$LOG" "$CAPTURE/presentmon.csv" &
  PM_PID=$!
fi

# The game is raised to above-normal priority so other lanes' compilers cannot starve its pipeline workers
# (raise-priority.ps1 says why, picks this run's process, and prints one line saying what it raised).
RUN_STARTED=$(date +%s)
( sleep 4; RUN_WORLD_GAME_EXE="$GAME_EXE" RUN_WORLD_STARTED_EPOCH="$RUN_STARTED"     powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HERE/raise-priority.ps1" >&2 ) 2>&1 &

# The game plays at 4% in Windows' mixer unless told otherwise (--volume N, or --volume off to leave it alone):
# the title is loud and the PC is streaming. set-volume.ps1 touches only this run's game, each audio session once.
if [ "$VOLUME" != off ]; then
  ( sleep 4; RUN_WORLD_GAME_EXE="$GAME_EXE" RUN_WORLD_STARTED_EPOCH="$RUN_STARTED"       powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HERE/set-volume.ps1" -Percent "$VOLUME" >>"$LOG" 2>&1 ) &
fi

# Every run records its own window at two frames a second, into its capture folder; --no-record turns it off.
# record-screen.mjs selects only this run's game (run-process.ps1 -Strict) and ends only its own ffmpeg child.
REC_PID=""
if [ "$RECORD" = 1 ]; then
  RUN_WORLD_GAME_EXE="$GAME_EXE" RUN_WORLD_STARTED_EPOCH="$RUN_STARTED" \
    node "$HERE/record-screen.mjs" "$CAPTURE/screen.mp4" >>"$LOG" 2>&1 &
  REC_PID=$!
fi

# --heavy-seconds: end the game N seconds after the first frame line that is heavy (draws + dropped >= 1000).
# It appends "harness: ended by --heavy-seconds ..." to the log before the summary below reads it.
HEAVY_PID=""
if [ -n "$HEAVY_SECONDS" ]; then
  RUN_WORLD_GAME_EXE="$GAME_EXE" RUN_WORLD_STARTED_EPOCH="$RUN_STARTED" \
    node "$HERE/heavy-watch.mjs" "$LOG" "$HEAVY_SECONDS" &
  HEAVY_PID=$!
fi
SETTLE_PID=""
if [ -n "$SETTLED_SECONDS" ]; then
  SETTLE_ARGS=(--after-file "$AFTER")
  [ -n "$SETTLED_TIMEOUT" ] && SETTLE_ARGS+=(--timeout "$SETTLED_TIMEOUT")
  [ -n "$SETTLED_FPS" ] && SETTLE_ARGS+=(--floor-fps "$SETTLED_FPS")
  [ -n "$SETTLED_WAITING" ] && SETTLE_ARGS+=(--waiting "$SETTLED_WAITING")
  RUN_WORLD_GAME_EXE="$GAME_EXE" RUN_WORLD_STARTED_EPOCH="$RUN_STARTED" \
    node "$HERE/settled-watch.mjs" "$LOG" "$SETTLED_SECONDS" "${SETTLE_ARGS[@]}" &
  SETTLE_PID=$!
fi

(cd "$VICTORY_DIR" && env "${ENV_ARGS[@]}" "$BIN" run "$GAME_EXE" --execute --console "$CONSOLE") \
  2>&1 | tee -a "$LOG"
RC=${PIPESTATUS[0]}  # victory.exe's own exit code; tee's would always be 0

# The watcher ends the game itself, so give it a moment to record that in the log before the summary.
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
  node "$HERE/contact-sheets.mjs" "$CAPTURE/screen.mp4" >>"$LOG" 2>&1 || echo "contact sheets: failed" >&2
fi

# --save-as: the save folder as the run left it becomes a new snapshot; never overwrites an existing name.
if [ -n "$SAVE_AS" ]; then
  if node "$HERE/save-snapshot.mjs" save-as "$SAVE_AS" --config "$SAVE_CONFIG" >>"$LOG" 2>&1; then
    echo "saved: $SAVE_AS"
  else
    echo "save-as failed (log: $LOG)" >&2
    tail -2 "$LOG" >&2
  fi
fi

# The driver's own account of a GPU fault is in the Windows System log; append it before the summary reads the log.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$HERE/driver-events.ps1" "$RUN_STARTED" "$(date +%s)" 2>/dev/null >>"$LOG"

# The game's own exit code, before the parser reads the log: a non-zero code with no failure line is a run
# something else stopped, not a log that simply ends.
echo "harness: victory exit=$RC" >>"$LOG"

echo
node "$HERE/summarize-run.mjs" "$LOG" | tee "$LOG.md"
echo "victory exit=$RC"
[ "$GPU_TRACE" = 1 ] && echo "profiled: this code is Nsight's, not the title's"
[ "$RENDERDOC" = 1 ] && echo "captured: this code is RenderDoc's, not the title's"
exit "$RC"

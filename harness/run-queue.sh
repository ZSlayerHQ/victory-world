#!/usr/bin/env bash
# Run experiments one after another: read a queue file, run each line through the world-run
# wrapper, wait for it, record what happened, and print one table at the end.
#
# usage: run-queue.sh [--max-seconds N] [--dry-run] <queue file>
#
# A queue line is: <tag> <snapshot folder or lane> [flags passed to world-run.sh...]
# A hash sign starts a comment. A snapshot folder (one with snapshot.txt, made by
# snapshot-build.sh) gives VICTORY_BIN and VICTORY_DIR; a lane path or bare lane name
# (looked up under <project>/worktrees) gives VICTORY_DIR and clears any inherited
# VICTORY_BIN. One line failing does not stop the next. --dry-run prints the commands and
# runs nothing. --max-seconds N (default 1,500) stops a run that is still going: it kills
# the victory.exe whose command line has run and the game path (GAME_EXE, same default as
# run-world.sh), lets the wrapper finish for RUN_QUEUE_KILL_GRACE seconds (default 10),
# then kills its tree. The table (tag, binary, exit code, how it ended, log path) also goes
# to <queue file>.result.md. How it ended is read from summarize-run.mjs --json; a timeout
# is exit 124.
#
# The real-GPU switch is not the queue to give: world-run.sh refuses a real-GPU run while
# the streaming program is open unless VICTORY_ALLOW_OBS=1 is in the environment of the
# command. The queue passes its own environment through and never sets that variable itself.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
# VICTORY_WORKTREES and GAME_EXE: the environment, else harness/local.env, else the main PC's paths below.
. "$HERE/local-env.sh"
load_local_env "$HERE"
WRAPPER=${RUN_QUEUE_WRAPPER:-$HERE/world-run.sh}
WORKTREES=${VICTORY_WORKTREES:-<project>/worktrees}
GAME_EXE=${GAME_EXE:-}
if [ -z "$GAME_EXE" ] && [ -f "$HERE/run-world.sh" ]; then
  # Keep the timeout's process selection on the same game path as the wrapper.
  GAME_EXE=$(sed -n 's/^GAME_EXE=\${GAME_EXE:-"\(.*\)"}$/\1/p' "$HERE/run-world.sh" | head -n 1)
fi
GAME_EXE=${GAME_EXE:-"<game executable>"}
MAX_SECONDS=1500
DRY_RUN=0
QUEUE=

usage() {
  sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  echo "run-queue: $*" >&2
  exit 2
}

winpath() {
  if command -v cygpath >/dev/null 2>&1; then
    cygpath -m -- "$1" 2>/dev/null || printf '%s' "$1"
  else
    printf '%s' "$1"
  fi
}

abspath() {
  (cd "$1" 2>/dev/null && { pwd -W 2>/dev/null || pwd; })
}

profile_from_flags() {
  local p=diag prev= f
  for f in "$@"; do
    if [ "$prev" = --profile ]; then p=$f; fi
    case "$f" in --profile=*) p=${f#*=} ;; esac
    prev=$f
  done
  printf '%s' "$p"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --max-seconds)
      [ $# -ge 2 ] || die "--max-seconds needs a count"
      MAX_SECONDS=$2
      shift 2
      ;;
    --max-seconds=*)
      MAX_SECONDS=${1#*=}
      shift
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    -*)
      die "unknown option: $1"
      ;;
    *)
      [ -z "$QUEUE" ] || die "one queue file at a time"
      QUEUE=$1
      shift
      ;;
  esac
done

case "$MAX_SECONDS" in
  ''|*[!0-9]*) die "--max-seconds needs a whole number" ;;
esac
KILL_GRACE=${RUN_QUEUE_KILL_GRACE:-10}
case "$KILL_GRACE" in
  ''|*[!0-9]*) die "RUN_QUEUE_KILL_GRACE needs a whole number" ;;
esac

[ -n "$QUEUE" ] || { usage >&2; exit 2; }
[ -f "$QUEUE" ] || die "no queue file: $QUEUE"

R_TAG=()
R_BIN=()
R_RC=()
R_END=()
R_LOG=()

KIND=
VBIN=
VDIR=
BINARY=
FLAGS=()

resolve_target() {
  local t=$1 p
  KIND=unknown
  VBIN=
  VDIR=
  BINARY=
  if [ -d "$t" ]; then
    VDIR=$(abspath "$t")
    [ -n "$VDIR" ] || return 1
    if [ -f "$t/snapshot.txt" ]; then
      KIND=snapshot
      VBIN="$VDIR/victory.exe"
      BINARY=$VBIN
      [ -f "$t/victory.exe" ] || return 1
    else
      KIND=lane
      p=$(profile_from_flags "${FLAGS[@]}")
      BINARY="$VDIR/target/$p/victory.exe"
    fi
  elif [ -d "$WORKTREES/$t" ]; then
    KIND=lane
    VDIR=$(abspath "$WORKTREES/$t")
    [ -n "$VDIR" ] || return 1
    p=$(profile_from_flags "${FLAGS[@]}")
    BINARY="$VDIR/target/$p/victory.exe"
  else
    return 1
  fi
  return 0
}

# Ends the game this queue line started, and no other: the victory.exe with " run " and the game's path on its
# command line that was created after the line began. Without the time test this killed a live game run that
# another session had started (2026-11-25, the queue's own test did it).
stop_game() {
  [ -n "$GAME_EXE" ] || return 0
  RUN_QUEUE_GAME_EXE="$GAME_EXE" RUN_QUEUE_LINE_STARTED="${line_started:-$(date +%s)}" powershell.exe -NoProfile -NonInteractive -Command '
    $game = $env:RUN_QUEUE_GAME_EXE -replace "/", "\"
    $started = [long]$env:RUN_QUEUE_LINE_STARTED
    $all = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -eq "victory.exe" })
    $mine = @($all | Where-Object {
      $_.CommandLine -and $_.CommandLine -match " run " -and
      ($_.CommandLine -replace "/", "\").IndexOf($game, [StringComparison]::OrdinalIgnoreCase) -ge 0 -and
      $_.CreationDate -and ([DateTimeOffset]$_.CreationDate).ToUnixTimeSeconds() -ge ($started - 2)
    })
    foreach ($c in $mine) {
      Stop-Process -Id $c.ProcessId -Force -ErrorAction SilentlyContinue
      Write-Output ("stopped victory.exe pid " + $c.ProcessId)
    }
    if ($mine.Count -eq 0) { Write-Output "no victory.exe matched; stopping the wrapper" }
  ' 2>/dev/null | sed 's/^/  /'
}

# Kills a process and its children, deepest first. taskkill takes Windows PIDs while a
# shell has MSYS PIDs, so walk the shell's own process table instead.
kill_tree() {
  local root=$1 sig=${2:-KILL} child
  for child in $(ps -ef 2>/dev/null | awk -v p="$root" '$3==p {print $2}'); do
    kill_tree "$child" "$sig"
  done
  kill -s "$sig" "$root" 2>/dev/null || true
}

# Ends a run that passed --max-seconds, then lets the wrapper clean up its lock.
stop_run() {
  local rcfile=$1 i=0
  stop_game
  while [ ! -s "$rcfile" ] && kill -0 "$pid" 2>/dev/null && [ "$i" -lt "$KILL_GRACE" ]; do
    sleep 1
    i=$((i + 1))
  done
  if [ ! -s "$rcfile" ] && kill -0 "$pid" 2>/dev/null; then
    kill_tree "$pid" TERM
    sleep 1
    kill_tree "$pid" KILL
  fi
}

render_cmd() {
  local -a parts=("${EF[@]}" bash "$WRAPPER" --tag "$tag" "${FLAGS[@]}")
  local first=1 a
  for a in "${parts[@]}"; do
    [ "$first" = 1 ] && first=0 || printf ' '
    printf '%q' "$a"
  done
  printf '\n'
}

ending_from_json() {
  node -e '
    const fs = require("fs");
    const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
    const text = (s.failures || []).join("\n");
    let how;
    if (/device removed/i.test(text)) how = "device removed";
    else if (/panic|assertion failed|gpu failure|unhandled exception/i.test(text)) how = "crashed";
    else if (s.fps && s.fps.samples > 0) how = "reached the scene (" + s.fps.samples + " fps samples)";
    else if (s.durationSeconds !== null && s.durationSeconds !== undefined) how = "log ends after " + s.durationSeconds + " s";
    else how = "no frames";
    const events = s.driverEvents ? s.driverEvents.total : 0;
    if (events) how += "; " + events + " driver event" + (events === 1 ? "" : "s");
    process.stdout.write(how);
  ' "$1"
}

run_one() {
  local tag=$1 target=$2
  shift 2
  FLAGS=("$@")
  local rc ended log logfile json err out rcfile pid started deadline timed_out=0
  local -a EF

  if ! resolve_target "$target"; then
    if [ "$DRY_RUN" = 1 ]; then
      echo "run-queue: cannot resolve $target (no lane or snapshot folder)" >&2
    else
      R_TAG+=("$tag")
      R_BIN+=("$target")
      R_RC+=("—")
      R_END+=("unknown target (not a lane or snapshot folder)")
      R_LOG+=("—")
    fi
    return
  fi

  if [ "$KIND" = snapshot ]; then
    EF=(env "VICTORY_BIN=$VBIN" "VICTORY_DIR=$VDIR")
  else
    EF=(env -u VICTORY_BIN "VICTORY_DIR=$VDIR")
  fi

  if [ "$DRY_RUN" = 1 ]; then
    render_cmd
    return
  fi

  printf '\n== %s — %s\n' "$tag" "$BINARY"

  out=$(mktemp "${TMPDIR:-/tmp}/run-queue.XXXXXX") || {
    R_TAG+=("$tag"); R_BIN+=("$BINARY"); R_RC+=("—")
    R_END+=("cannot make a temporary file"); R_LOG+=("—")
    return
  }
  rcfile="$out.rc"
  : >"$out"

  (
    "${EF[@]}" bash "$WRAPPER" --tag "$tag" "${FLAGS[@]}" >"$out" 2>&1
    printf '%s' "$?" >"$rcfile"
  ) &
  pid=$!
  line_started=$(date +%s)
  started=$(date +%s)
  if [ "$MAX_SECONDS" -gt 0 ]; then
    deadline=$((started + MAX_SECONDS))
  else
    deadline=0
  fi

  while [ ! -s "$rcfile" ]; do
    if [ "$deadline" -gt 0 ] && [ "$(date +%s)" -ge "$deadline" ]; then
      timed_out=1
      echo "run-queue: '$tag' still running after ${MAX_SECONDS}s; stopping it" >&2
      stop_run "$rcfile"
      break
    fi
    sleep 0.5
  done
  wait "$pid" 2>/dev/null
  if [ "$timed_out" = 1 ]; then
    rc=124
  else
    rc=$(cat "$rcfile" 2>/dev/null)
    [ -n "$rc" ] || rc=1
  fi

  cat "$out"

  log=$(sed -n 's/^log:[[:space:]]*//p' "$out" | tail -n 1 | tr -d '\r')
  ended=
  if [ -z "$log" ]; then
    ended="no log line"
  else
    logfile=$(winpath "$log")
    if [ ! -f "$logfile" ]; then
      ended="log missing"
    elif json="$out.json" && node "$HERE/summarize-run.mjs" "$logfile" --json >"$json" 2>"$out.err"; then
      ended=$(ending_from_json "$json" 2>/dev/null) || ended="summary unreadable"
      [ -n "$ended" ] || ended="summary empty"
    else
      ended="summary failed"
      sed -n '1,3p' "$out.err" >&2
    fi
  fi
  if [ "$timed_out" = 1 ]; then
    ended="timed out after ${MAX_SECONDS} s"
  fi

  R_TAG+=("$tag")
  R_BIN+=("$BINARY")
  R_RC+=("$rc")
  R_END+=("$ended")
  R_LOG+=("${log:-—}")
  rm -f "$out" "$out.rc" "$out.json" "$out.err"
}

cell() {
  printf '%s' "$1" | tr '\n' ' ' | sed 's/|/\\|/g'
}

emit_table() {
  local i
  printf '# Run queue — %s\n\n' "$QUEUE"
  printf '| tag | binary | exit | how it ended | log |\n'
  printf '| --- | --- | ---: | --- | --- |\n'
  for i in "${!R_TAG[@]}"; do
    printf '| %s | %s | %s | %s | %s |\n' \
      "$(cell "${R_TAG[$i]}")" "$(cell "${R_BIN[$i]}")" "$(cell "${R_RC[$i]}")" \
      "$(cell "${R_END[$i]}")" "$(cell "${R_LOG[$i]}")"
  done
}

line_no=0
while IFS= read -r raw || [ -n "$raw" ]; do
  line_no=$((line_no + 1))
  raw=${raw%$'\r'}
  clean=${raw%%#*}
  if [ -z "${clean//[[:space:]]/}" ]; then
    continue
  fi
  set -f
  if eval "TOKENS=($clean)" 2>/dev/null; then
    parse_ok=1
  else
    parse_ok=0
  fi
  set +f
  if [ "$parse_ok" != 1 ] || [ "${#TOKENS[@]}" -lt 2 ]; then
    echo "run-queue: line $line_no: expected <tag> <snapshot or lane> [flags]: $raw" >&2
    continue
  fi
  tag=${TOKENS[0]}
  target=${TOKENS[1]}
  flags=("${TOKENS[@]:2}")
  run_one "$tag" "$target" "${flags[@]}"
done <"$QUEUE"

if [ "$DRY_RUN" = 1 ]; then
  exit 0
fi

RESULT="$QUEUE.result.md"
emit_table | tee "$RESULT"
exit 0

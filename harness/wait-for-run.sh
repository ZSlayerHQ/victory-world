#!/usr/bin/env bash
# Wait for the run lock before a build. A build started under a measured leg compiles with the game and pushes the
# leg's frame times up, so other workers call this first.
#
# usage: wait-for-run.sh [--max-seconds N] [--poll-seconds N] [--lock PATH]
#
# It returns at once, silently, when harness/run.lock is absent. While the lock is held it prints one line when it
# starts waiting, checks every 30 seconds (--poll-seconds changes that for a test), and prints one line with the
# seconds waited when the lock goes. --max-seconds N gives up with exit code 4. HARNESS_RUN_LOCK and
# HARNESS_WAIT_POLL_SECONDS name another lock and poll for the tests.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
LOCK=${HARNESS_RUN_LOCK:-$HERE/run.lock}
MAX_SECONDS=
POLL_SECONDS=${HARNESS_WAIT_POLL_SECONDS:-30}

usage() {
  printf '%s\n' "usage: wait-for-run.sh [--max-seconds N] [--poll-seconds N] [--lock PATH]"
}

die() {
  printf 'wait-for-run: %s\n' "$*" >&2
  exit 2
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
    --poll-seconds)
      [ $# -ge 2 ] || die "--poll-seconds needs a count"
      POLL_SECONDS=$2
      shift 2
      ;;
    --poll-seconds=*)
      POLL_SECONDS=${1#*=}
      shift
      ;;
    --lock)
      [ $# -ge 2 ] || die "--lock needs a path"
      LOCK=$2
      shift 2
      ;;
    --lock=*)
      LOCK=${1#*=}
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "unknown option: $1"
      ;;
  esac
done

case "$POLL_SECONDS" in
  ''|*[!0-9]*|0) die "--poll-seconds needs a positive whole number" ;;
esac
if [ -n "$MAX_SECONDS" ]; then
  case "$MAX_SECONDS" in
    ''|*[!0-9]*) die "--max-seconds needs a whole number" ;;
  esac
fi

# The lock is a folder world-run.sh makes; either kind of entry counts as held.
[ -e "$LOCK" ] || exit 0

STARTED=$(date +%s)
printf 'waiting for the run lock (checking every %s s)\n' "$POLL_SECONDS"
while [ -e "$LOCK" ]; do
  NOW=$(date +%s)
  ELAPSED=$((NOW - STARTED))
  if [ -n "$MAX_SECONDS" ] && [ "$ELAPSED" -ge "$MAX_SECONDS" ]; then
    printf 'gave up after %s s: the run lock is still held\n' "$ELAPSED"
    exit 4
  fi
  WAIT=$POLL_SECONDS
  if [ -n "$MAX_SECONDS" ]; then
    LEFT=$((MAX_SECONDS - ELAPSED))
    [ "$LEFT" -lt "$WAIT" ] && WAIT=$LEFT
  fi
  [ "$WAIT" -gt 0 ] || WAIT=1
  sleep "$WAIT"
done
printf 'waited %s s for the run lock\n' "$(( $(date +%s) - STARTED ))"

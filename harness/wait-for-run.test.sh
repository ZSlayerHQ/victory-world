#!/usr/bin/env bash
# Tests wait-for-run.sh against a temporary lock folder. No run, game, GPU or real harness lock is touched.
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT="$HERE/wait-for-run.sh"
TMP=$(mktemp -d "${TMPDIR:-/tmp}/wait-for-run-test.XXXXXX") || exit 1
trap 'rm -rf "$TMP"' EXIT

PASS=0
FAIL=0
ok() { PASS=$((PASS + 1)); printf 'ok - %s\n' "$1"; }
bad() { FAIL=$((FAIL + 1)); printf 'not ok - %s\n' "$1"; }

LOCK="$TMP/run.lock"
OUT="$TMP/out.txt"
ERR="$TMP/err.txt"

# 1. No lock: return at once, silently.
START=$(date +%s)
bash "$SCRIPT" --lock "$LOCK" >"$OUT" 2>"$ERR"
RC=$?
ELAPSED=$(( $(date +%s) - START ))
[ "$RC" = 0 ] && ok "no lock: exit 0" || bad "no lock: exit $RC"
[ "$ELAPSED" -le 2 ] && ok "no lock: returned at once" || bad "no lock: took ${ELAPSED}s"
[ -s "$OUT" ] && bad "no lock: printed something" || ok "no lock: silent"
[ -s "$ERR" ] && bad "no lock: wrote stderr" || ok "no lock: no stderr"

# 2. Lock released while waiting: one waiting line, then the seconds waited.
mkdir "$LOCK"
START=$(date +%s)
bash "$SCRIPT" --lock "$LOCK" --poll-seconds 1 >"$OUT" 2>"$ERR" &
PID=$!
for _ in $(seq 1 10); do
  grep -q '^waiting for the run lock' "$OUT" 2>/dev/null && break
  sleep 0.2
done
sleep 2
rmdir "$LOCK"
wait "$PID"
RC=$?
ELAPSED=$(( $(date +%s) - START ))
[ "$RC" = 0 ] && ok "released: exit 0" || bad "released: exit $RC"
grep -q '^waiting for the run lock (checking every 1 s)$' "$OUT" && ok "released: waiting line" || bad "released: no waiting line"
grep -Eq '^waited [0-9]+ s for the run lock$' "$OUT" && ok "released: seconds waited line" || bad "released: no seconds line"
[ "$ELAPSED" -ge 2 ] && ok "released: waited ${ELAPSED}s" || bad "released: returned after ${ELAPSED}s"
[ -s "$ERR" ] && bad "released: wrote stderr" || ok "released: no stderr"

# 3. --max-seconds gives up with exit code 4 while the lock stays.
mkdir "$LOCK"
bash "$SCRIPT" --lock "$LOCK" --poll-seconds 1 --max-seconds 2 >"$OUT" 2>"$ERR"
RC=$?
[ "$RC" = 4 ] && ok "timeout: exit 4" || bad "timeout: exit $RC"
grep -Eq '^gave up after [0-9]+ s: the run lock is still held$' "$OUT" && ok "timeout: gave-up line" || bad "timeout: no gave-up line"
rmdir "$LOCK"

# 4. --help answers without a lock.
bash "$SCRIPT" --help >"$OUT" 2>"$ERR"
RC=$?
[ "$RC" = 0 ] && ok "help: exit 0" || bad "help: exit $RC"
grep -q '^usage: wait-for-run\.sh' "$OUT" && ok "help: usage" || bad "help: no usage"

printf '%s passed, %s failed\n' "$PASS" "$FAIL"
[ "$FAIL" = 0 ]

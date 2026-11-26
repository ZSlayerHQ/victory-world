#!/usr/bin/env bash
# Is the streaming program (OBS) running, and how hard the warm-up may therefore push the PC. Sourced by run-world.sh
# (bash). The warm-up (`victory warm`) takes every core for one to four minutes; at raised priority that starves OBS and
# the stream stutters, so while OBS is up it runs gentle: below-normal priority and half the logical processors.
#
#   VICTORY_WARM_GENTLE=1   gentle whether or not OBS is running
#   VICTORY_WARM_GENTLE=0   today's raised, all-core warm-up whether or not OBS is running
#   (unset, or anything else)  gentle exactly while OBS is running

# The check world-run.sh makes before a real-GPU run, spelled the same (obs.test.mjs keeps the two alike).
obs_running() {
  tasklist //FI "IMAGENAME eq obs64.exe" //NH 2>/dev/null | grep -qi '^obs64\.exe'
}

# Sets WARM_MODE (gentle or raised) and WARM_WHY (the reason, for the one line the run prints).
warm_mode_decide() {
  case "${VICTORY_WARM_GENTLE:-}" in
    1) WARM_MODE=gentle; WARM_WHY="VICTORY_WARM_GENTLE=1" ;;
    0) WARM_MODE=raised; WARM_WHY="VICTORY_WARM_GENTLE=0" ;;
    *)
      if obs_running; then
        WARM_MODE=gentle; WARM_WHY="OBS is running"
      else
        WARM_MODE=raised; WARM_WHY="OBS is not running"
      fi
      ;;
  esac
}

# Half the logical processors, at least one (`victory warm --jobs`). NUMBER_OF_PROCESSORS is Windows' own count.
warm_jobs() {
  local n=${NUMBER_OF_PROCESSORS:-}
  case "$n" in '' | *[!0-9]*) n=$(nproc 2>/dev/null || echo 4) ;; esac
  case "$n" in '' | *[!0-9]*) n=4 ;; esac
  echo $(((n + 1) / 2))
}

# The one line a run prints about the warm-up's mode (after warm_mode_decide).
warm_mode_line() {
  local line
  if [ "$WARM_MODE" = gentle ]; then
    line="warm-up mode: gentle ($WARM_WHY): below-normal priority, $(warm_jobs) jobs of ${NUMBER_OF_PROCESSORS:-?} logical processors"
  else
    line="warm-up mode: raised ($WARM_WHY): above-normal priority, every core"
  fi
  if declare -F public_line >/dev/null 2>&1; then
    printf '%s\n' "$line" | public_line
  else
    printf '%s\n' "$line"
  fi
}

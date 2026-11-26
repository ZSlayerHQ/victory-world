# Sourced by run-world.sh: one filter for everything the terminal sees, and the log header's path rule.
#
# public_line reads lines on stdin and prints only the line kinds the terminal is allowed to show, and only when the
# line carries no drive path and no home folder. The game's own lines are never on the list; the heartbeat, the
# harness's own lines and the summary are. `say` and `say_err` put one line through it.
#
# The log is private; its header is not. For a variable whose value is a path, harness_env_line prints the value
# only when it is under one of the repository's three roots, and `set, outside the repository` otherwise.

# The three roots a path may be named under (public-lines.test.mjs overrides this for made-up paths).
HARNESS_PATH_ROOTS=${HARNESS_PATH_ROOTS:-'<project> /snapshots /captures'}

harness_path_allowed() {
  local value root
  value=${1//\\//}
  value=${value,,}
  for root in $HARNESS_PATH_ROOTS; do
    root=${root//\\//}
    root=${root,,}
    case "$value" in
      "$root"|"$root"/*) return 0 ;;
    esac
  done
  return 1
}

# A path for the log header: unchanged under an allowed root, the phrase otherwise.
harness_public_path() {
  if harness_path_allowed "$1"; then
    printf '%s' "$1"
  else
    printf '%s' 'set, outside the repository'
  fi
}

# One `harness env: NAME=VALUE` header line. A value with a drive, a slash or a backslash is a path: outside the
# three roots its value is replaced; every other value is printed as written.
harness_env_line() {
  local pair=$1 name=${1%%=*} value=${1#*=}
  case "$value" in
    *[A-Za-z]:[\/]*|*\*|*/*)
      if ! harness_path_allowed "$value"; then
        printf 'harness env: %s=set, outside the repository\n' "$name"
        return
      fi
      ;;
  esac
  printf 'harness env: %s=%s\n' "$name" "$value"
}

# The allow-list and the path drop. Anything not named here is dropped, whatever it says.
public_line() {
  local line home=${HOME:-} profile=${USERPROFILE:-}
  while IFS= read -r line; do
    case "$line" in
      *[A-Za-z]:[\/]*) continue ;;
    esac
    if [ -n "$home" ]; then
      case "$line" in *"$home"*) continue ;; esac
    fi
    if [ -n "$profile" ]; then
      case "$line" in *"$profile"*) continue ;; esac
    fi
    case "$line" in
      ''|\
      'harness: '*|'heartbeat: '*|'log: '*|'capture: '*|'profile: '*|'restore: '*|'saved: '*|\
      'warm-up: '*|'warm-up mode: '*|'live: '*|'victory exit='*|'gpu-trace: '*|'renderdoc: '*|\
      'pipeline library: '*|'refused: '*|'warning: '*|'unknown argument: '*|'--'*|'no '*|\
      'contact sheets: '*|'save-as failed'*|'usage: '*|\
      '# Run summary'*|'Range: '*|'Ending: '*|'Screen record: '*|'FPS: '*|'PresentMon: '*|\
      'comparable: '*|'Last frame: '*|'Captured: '*|'Profiled: '*|'Scene '*|'## '*|'- '*|'  - '*)
        printf '%s\n' "$line"
        ;;
    esac
  done
}

say() { printf '%s\n' "$*" | public_line; }
say_err() { printf '%s\n' "$*" | public_line >&2; }

# One game frame line as the terminal's heartbeat: its numbers only, never the line itself.
heartbeat_line() {
  printf '%s\n' "$1" \
    | sed $'s/\x1b\\[[0-9;?]*[ -/]*[@-~]//g' \
    | sed -n 's/.*[^0-9.]\([0-9][0-9.]*\) fps, \([0-9][0-9.]*\) ms\/frame.*[^0-9]\([0-9][0-9]*\) draws\/frame, dropped \([0-9][0-9]*\).*/heartbeat: \1 fps, \2 ms\/frame, \3 draws, dropped \4/p'
}

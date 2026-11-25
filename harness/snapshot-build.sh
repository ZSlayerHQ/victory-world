#!/usr/bin/env bash
# Freeze one lane commit's binary as a snapshot a run can use.
#
# usage: snapshot-build.sh <lane> [--profile diag|release]
#        snapshot-build.sh --list
#        snapshot-build.sh --prune N
#
# Builds the lane's current commit (cargo build --profile <profile> -p victory
# --features diagnostics --locked) unless the snapshot already exists, then copies what a run
# loads from <lane>/target/<profile>/ to /snapshots/<short sha>-<profile>/: victory.exe,
# every top-level *.dll beside it, and victory.pdb. deps/, build/, incremental/, *.d and the
# other *.pdb files stay behind. A lane with uncommitted changes is refused: a snapshot is a
# commit. --list prints snapshots newest first with their commit subjects; --prune N keeps the
# newest N. VICTORY_BUILDS overrides /snapshots (tests use it); VICTORY_REPO is the
# repository --list asks for commit subjects when a snapshot's lane is gone.
set -u

HERE=$(cd "$(dirname "$0")" && pwd)
# VICTORY_BUILDS and VICTORY_REPO: the environment, else harness/local.env, else the main PC's paths below.
. "$HERE/local-env.sh"
load_local_env "$HERE"
BUILDS=${VICTORY_BUILDS:-/snapshots}
REPO=${VICTORY_REPO:-<project>/victory}
PROFILE=diag
LANE=
ACTION=build
PRUNE_N=

usage() {
  sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
}

die() {
  echo "snapshot-build: $*" >&2
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

while [ $# -gt 0 ]; do
  case "$1" in
    --profile)
      [ $# -ge 2 ] || die "--profile needs a value"
      PROFILE=$2
      shift 2
      ;;
    --profile=*)
      PROFILE=${1#*=}
      shift
      ;;
    --list)
      ACTION=list
      shift
      ;;
    --prune)
      [ $# -ge 2 ] || die "--prune needs a count"
      ACTION=prune
      PRUNE_N=$2
      shift 2
      ;;
    --prune=*)
      ACTION=prune
      PRUNE_N=${1#*=}
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
      [ -z "$LANE" ] || die "one lane at a time"
      LANE=$1
      shift
      ;;
  esac
done

case "$PROFILE" in
  diag|release) ;;
  *) die "unknown profile: $PROFILE (diag or release)" ;;
esac

snapshot_dirs() {
  [ -d "$BUILDS" ] || return 0
  find "$BUILDS" -mindepth 1 -maxdepth 1 -type d -printf '%T@\t%p\n' 2>/dev/null |
    sort -rn | cut -f2-
}

field() {
  sed -n "s/^$1: //p" "$2" 2>/dev/null | head -n 1
}

case "$ACTION" in
  list)
    [ -z "$LANE" ] || die "--list does not take a lane"
    found=0
    while IFS= read -r dir; do
      [ -f "$dir/snapshot.txt" ] || continue
      found=$((found + 1))
      commit=$(field commit "$dir/snapshot.txt")
      branch=$(field branch "$dir/snapshot.txt")
      profile=$(field profile "$dir/snapshot.txt")
      date=$(field date "$dir/snapshot.txt")
      lane=$(field lane "$dir/snapshot.txt")
      subject=
      if [ -n "$lane" ] && [ -d "$lane" ] && [ -n "$commit" ]; then
        subject=$(git -C "$lane" log -1 --format=%s "$commit" 2>/dev/null)
      fi
      if [ -z "$subject" ] && [ -d "$REPO" ] && [ -n "$commit" ]; then
        subject=$(git -C "$REPO" log -1 --format=%s "$commit" 2>/dev/null)
      fi
      [ -n "$subject" ] || subject='(commit subject not found)'
      printf '%-28s %-20s %-8s %-8s %s\n' "$(basename "$dir")" "$date" "$branch" "$profile" "$subject"
    done < <(snapshot_dirs)
    [ "$found" -gt 0 ] || echo "no snapshots in $BUILDS"
    ;;

  prune)
    [ -z "$LANE" ] || die "--prune does not take a lane"
    case "$PRUNE_N" in
      ''|*[!0-9]*) die "--prune needs a whole number" ;;
    esac
    kept=0
    while IFS= read -r dir; do
      [ -f "$dir/snapshot.txt" ] || continue
      kept=$((kept + 1))
      if [ "$kept" -gt "$PRUNE_N" ]; then
        echo "pruned $(basename "$dir")"
        rm -rf -- "$dir"
      fi
    done < <(snapshot_dirs)
    ;;

  build)
    [ -n "$LANE" ] || { usage >&2; exit 2; }
    LANE_ARG=$LANE
    LANE=$(abspath "$LANE") || die "no lane folder: $LANE_ARG"
    [ -n "$LANE" ] || die "no lane folder: $LANE_ARG"

    git -C "$LANE" rev-parse --is-inside-work-tree >/dev/null 2>&1 ||
      die "$LANE is not a git worktree"

    if [ -n "$(git -C "$LANE" status --porcelain --untracked-files=normal)" ]; then
      echo "refused: $LANE has uncommitted changes; a snapshot must be a commit:" >&2
      git -C "$LANE" status --short >&2
      exit 3
    fi

    FULL=$(git -C "$LANE" rev-parse HEAD) || die "cannot read $LANE's commit"
    SHORT=$(git -C "$LANE" rev-parse --short=7 HEAD) || die "cannot shorten $LANE's commit"
    BRANCH=$(git -C "$LANE" rev-parse --abbrev-ref HEAD)
    DEST="$BUILDS/$SHORT-$PROFILE"

    if [ -d "$DEST" ] && [ -f "$DEST/victory.exe" ]; then
      if [ -f "$DEST/snapshot.txt" ]; then
        SNAP_COMMIT=$(field commit "$DEST/snapshot.txt")
        [ -z "$SNAP_COMMIT" ] || [ "$SNAP_COMMIT" = "$FULL" ] ||
          die "$DEST holds $SNAP_COMMIT, not $FULL; remove it or pick another build root"
      fi
      echo "snapshot: $DEST (already built)"
      printf 'VICTORY_BIN=%s\n' "$DEST/victory.exe"
      exit 0
    fi

    echo "building $SHORT ($BRANCH) in $LANE"
    echo "  cargo build --profile $PROFILE -p victory --features diagnostics --locked"
    if ! (cd "$LANE" && cargo build --profile "$PROFILE" -p victory --features diagnostics --locked); then
      echo "snapshot-build: cargo build failed; no snapshot written" >&2
      exit 1
    fi

    SRC="$LANE/target/$PROFILE"
    [ -f "$SRC/victory.exe" ] ||
      die "cargo finished but $SRC/victory.exe is missing"

    mkdir -p "$DEST" || die "cannot create $DEST"
    COPIED=(victory.exe)
    cp -f "$SRC/victory.exe" "$DEST/victory.exe" || die "cannot copy victory.exe"

    # A build script that copies a runtime DLL puts it beside the exe; the Windows loader
    # looks there first. This tree's build scripts copy none today, but the rule keeps a
    # snapshot complete if one appears.
    while IFS= read -r dll; do
      cp -f "$dll" "$DEST/" || die "cannot copy $(basename "$dll")"
      COPIED+=("$(basename "$dll")")
    done < <(find "$SRC" -maxdepth 1 -type f -iname '*.dll' -print 2>/dev/null)

    if [ -f "$SRC/victory.pdb" ]; then
      cp -f "$SRC/victory.pdb" "$DEST/victory.pdb" || die "cannot copy victory.pdb"
      COPIED+=(victory.pdb)
    fi

    {
      printf 'commit: %s\n' "$FULL"
      printf 'branch: %s\n' "$BRANCH"
      printf 'profile: %s\n' "$PROFILE"
      printf 'features: diagnostics\n'
      printf 'date: %s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
      printf 'lane: %s\n' "$LANE"
    } >"$DEST/snapshot.txt" || die "cannot write $DEST/snapshot.txt"

    echo "snapshot: $DEST"
    echo "copied: ${COPIED[*]}"
    printf 'VICTORY_BIN=%s\n' "$DEST/victory.exe"
    ;;
esac

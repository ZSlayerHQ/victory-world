#!/usr/bin/env bash
# The live-switch control file's shell interface; live.mjs does the work.
# usage: live.sh [--file <path>] set NAME=value ... | unset NAME ... | show | clear
#        live.sh names
# The control file is VICTORY_LIVE when set, else --file. names needs no file and prints the live registry.
HERE=$(cd "$(dirname "$0")" && pwd)
exec node "$HERE/live.mjs" "$@"

#!/usr/bin/env bash
# Drive an open live session: live-drive.mjs does the work.
# usage: live-drive.sh run <plan.json> --log <run log> [--file <control file>]
#        live-drive.sh report --log <run log> [--json]
# The control file comes from --file, else VICTORY_LIVE.
HERE=$(cd "$(dirname "$0")" && pwd)
exec node "$HERE/live-drive.mjs" "$@"

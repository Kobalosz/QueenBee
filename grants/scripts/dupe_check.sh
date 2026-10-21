#!/bin/bash
# Duplicate check for ONE funder or program. Run this BEFORE writing a word of an application.
#   ./scripts/dupe_check.sh "Acme Foundation" ["Growth Grant"] [cycle-or-opportunity-id]
#
# Exit 0 = no record anywhere. Exit 1 = hits: read them, then decide whether this cycle is already
# covered (one application per program per cycle) or the funder already got one this run.
# Exit 3 = the funder is on targets.skip_funders: hard skip.
# RULE: search EVERY record. The log's ### headers are not the whole record; summaries, the queue and
# screenshots are too.
set -uo pipefail
cd "$(dirname "$0")/.."
[ $# -ge 1 ] || { echo "usage: $0 \"<Funder>\" [\"<Program>\"] [cycle-or-id]" >&2; exit 2; }
NAME="$1"; PROGRAM="${2:-}"; CYCLE="${3:-}"
hit=0
sec () { printf '\n=== %s ===\n' "$1"; }
slug () { echo "$1" | tr '[:upper:]' '[:lower:]' | tr -cs 'a-z0-9' '-' | sed 's/^-//;s/-$//'; }

if python3 - "$NAME" <<'PY'
import json, sys
try:
    skip = json.load(open("config/settings.json")).get("targets", {}).get("skip_funders", [])
except Exception:
    skip = []
n = sys.argv[1].lower()
sys.exit(0 if any(s.lower() in n or n in s.lower() for s in skip if s) else 1)
PY
then
  echo "★★★ \"$NAME\" is on targets.skip_funders. HARD SKIP."
  exit 3
fi

# Match on the first word too: the log may say "Acme" where the page says "Acme Community Foundation".
FIRST="${NAME%% *}"
PAT="$NAME"; [ ${#FIRST} -ge 5 ] && PAT="$FIRST"

for f in logs/grants-log.md data/queue.md state/status.md; do
  sec "$f — grep \"$PAT\""
  [ -f "$f" ] && grep -in -- "$PAT" "$f" && hit=1
done

sec "applications/ — docs and package folders"
ls applications applications/files 2>/dev/null | grep -i -- "$(slug "$PAT")" && hit=1

sec "screenshots/ — an independent record; a submit can exist ONLY here"
ls screenshots 2>/dev/null | grep -i -- "$(slug "$PAT")" && hit=1

if [ -n "$PROGRAM" ]; then
  sec "program \"$PROGRAM\" across every record"
  grep -rin -- "$PROGRAM" logs/ data/queue.md state/ applications/ 2>/dev/null | head -40 && hit=1
fi
if [ -n "$CYCLE" ]; then
  sec "cycle / id \"$CYCLE\" across every record"
  grep -rin -- "$CYCLE" logs/ data/queue.md state/ applications/ 2>/dev/null | head -40 && hit=1
fi

printf '\n'
if [ "$hit" -eq 1 ]; then
  echo "★ HITS FOUND for \"$NAME\". READ THEM. Same program in the same cycle = SKIP. An AWARDED or DECLINED"
  echo "  line tells you how this funder treated the client last time; note it in the run summary."
  exit 1
fi
echo "No record of \"$NAME\" anywhere. Clean."

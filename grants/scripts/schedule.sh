#!/usr/bin/env bash
# QueenBee grants — install / remove the recurring run.
# Usage: ./scripts/schedule.sh [install|uninstall|status]
# Frequency comes from config/settings.json -> schedule.frequency (and schedule.hour).
#
# Each checkout gets its OWN launchd label and cron tag, derived from its path, so two clones
# (one per client, say) can be scheduled at the same time and neither overwrites the other.
set -uo pipefail
cd "$(dirname "$0")/.."

REPO="$(pwd -P)"

SLUG_BASE="$(basename "$REPO" | tr -c 'A-Za-z0-9' '-' | sed 's/-*$//')"
SLUG_HASH="$(printf '%s' "$REPO" | shasum 2>/dev/null | cut -c1-8)"
[ -z "$SLUG_HASH" ] && SLUG_HASH="$(printf '%s' "$REPO" | cksum | cut -d' ' -f1)"
LABEL="com.queenbee.grants.${SLUG_BASE}.${SLUG_HASH}"
AGENT_DIR="$HOME/Library/LaunchAgents"
PLIST="$AGENT_DIR/$LABEL.plist"
CRON_TAG="# queenbee-grants:${SLUG_HASH}"
ACTION="${1:-status}"

freq() {
  python3 -c "import json;print(json.load(open('config/settings.json')).get('schedule',{}).get('frequency','manual'))" 2>/dev/null
}

hour() {
  python3 -c "import json;print(int(json.load(open('config/settings.json')).get('schedule',{}).get('hour',9)))" 2>/dev/null || echo 9
}

# Grants move on a scale of weeks, not hours, so the cadences are coarser than a job search's.
cron_for() {
  local h; h="$(hour)"
  case "$1" in
    daily)         echo "0 $h * * *" ;;
    weekdays)      echo "0 $h * * 1-5" ;;
    twice-weekly)  echo "0 $h * * 1,4" ;;
    weekly)        echo "0 $h * * 1" ;;
    *)             echo "" ;;
  esac
}

# Weekday numbers for launchd; empty means every day, "x" means unknown.
weekdays_for() {
  case "$1" in
    daily)         echo "" ;;
    weekdays)      echo "1 2 3 4 5" ;;
    twice-weekly)  echo "1 4" ;;
    weekly)        echo "1" ;;
    *)             echo "x" ;;
  esac
}

# A plist is ours only if it is BOTH named com.queenbee.grants.* AND runs this project's
# scheduled_run.sh. Nothing here may unload or delete a LaunchAgent belonging to anything else.
is_ours() {
  [ -f "$1" ] || return 1
  grep -q 'scripts/scheduled_run\.sh' "$1" 2>/dev/null
}

plist_owner() {
  sed -n 's:.*<key>WorkingDirectory</key><string>\(.*\)</string>.*:\1:p' "$1" 2>/dev/null | head -1
}

install_launchd() {
  local f="$1" days h plist_schedule d
  days="$(weekdays_for "$f")"; h="$(hour)"
  [ "$days" = "x" ] && { echo "Unknown frequency '$f'." >&2; return 1; }
  if [ -z "$days" ]; then
    plist_schedule="  <key>StartCalendarInterval</key>
  <dict><key>Hour</key><integer>$h</integer><key>Minute</key><integer>0</integer></dict>"
  else
    plist_schedule="  <key>StartCalendarInterval</key>
  <array>"
    for d in $days; do
      plist_schedule+="
    <dict><key>Weekday</key><integer>$d</integer><key>Hour</key><integer>$h</integer><key>Minute</key><integer>0</integer></dict>"
    done
    plist_schedule+="
  </array>"
  fi

  mkdir -p "$AGENT_DIR" logs
  cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>$REPO/scripts/scheduled_run.sh</string>
  </array>
  <key>WorkingDirectory</key><string>$REPO</string>
$plist_schedule
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$REPO/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>$REPO/logs/launchd.err.log</string>
</dict>
</plist>
EOF

  launchctl unload "$PLIST" 2>/dev/null
  if launchctl load "$PLIST" 2>/dev/null; then
    echo "Installed launchd job '$LABEL' ($f at ${h}:00)."
    echo "  repo:  $REPO"
    echo "  plist: $PLIST"
    echo "  log:   $REPO/logs/scheduled-run.log"
    case "$REPO" in
      "$HOME/Desktop"/*|"$HOME/Documents"/*|"$HOME/Downloads"/*)
        echo
        echo "  NOTE: macOS privacy blocks background jobs from reading Desktop, Documents,"
        echo "  and Downloads. Either move this folder somewhere else (e.g. ~/QueenBee), or"
        echo "  grant Full Disk Access to /bin/bash in System Settings > Privacy & Security."
        ;;
    esac
  else
    echo "launchctl load failed. Falling back to cron." >&2
    install_cron "$f"
  fi
}

install_cron() {
  local f="$1" spec
  spec="$(cron_for "$f")"
  [ -z "$spec" ] && { echo "Unknown frequency '$f'." >&2; return 1; }
  local line="$spec cd $REPO && /bin/bash scripts/scheduled_run.sh $CRON_TAG"
  ( crontab -l 2>/dev/null | grep -v "$CRON_TAG"; echo "$line" ) | crontab -
  echo "Installed cron entry ($f):"
  echo "  $line"
}

uninstall_this() {
  local removed=0
  if [ -f "$PLIST" ] && is_ours "$PLIST"; then
    launchctl unload "$PLIST" 2>/dev/null
    rm -f "$PLIST"; echo "Removed launchd job '$LABEL'."; removed=1
  fi
  if crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
    crontab -l 2>/dev/null | grep -v "$CRON_TAG" | crontab -
    echo "Removed cron entry."; removed=1
  fi
  [ "$removed" = "0" ] && echo "Nothing scheduled for this checkout."
  return 0
}

show_status() {
  echo "Repo:      $REPO"
  echo "Label:     $LABEL"
  echo "Frequency: $(freq) at $(hour):00  (config/settings.json -> schedule)"
  if [ -f "$PLIST" ]; then
    echo "launchd:   installed ($PLIST)"
    launchctl list 2>/dev/null | grep "$LABEL" | sed 's/^/           /'
  else
    echo "launchd:   not installed for this checkout"
  fi
  if crontab -l 2>/dev/null | grep -q "$CRON_TAG"; then
    echo "cron:      $(crontab -l 2>/dev/null | grep "$CRON_TAG" | head -1)"
  else
    echo "cron:      not installed for this checkout"
  fi
  local p any=0
  for p in "$AGENT_DIR"/com.queenbee.grants.*.plist; do
    is_ours "$p" || continue
    [ "$any" = "0" ] && { echo; echo "All QueenBee grant schedules on this Mac:"; any=1; }
    if [ "$(plist_owner "$p")" = "$REPO" ]; then echo "  * $(plist_owner "$p")   <- this checkout"
    else echo "    $(plist_owner "$p")"; fi
  done
}

case "$ACTION" in
  install)
    F="$(freq)"
    [ "$F" = "manual" ] && { echo "schedule.frequency is 'manual'. Set it in config/settings.json first."; exit 0; }
    if [ "$(uname -s)" = "Darwin" ]; then install_launchd "$F"; else install_cron "$F"; fi
    ;;
  uninstall) uninstall_this ;;
  status)    show_status ;;
  *) echo "Usage: $0 [install|uninstall|status]"; exit 1 ;;
esac

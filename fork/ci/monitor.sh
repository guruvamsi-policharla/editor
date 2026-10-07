#!/usr/bin/env bash
# Resource monitor for CI builds. `monitor.sh start <log>` samples memory/swap/disk every 20 s in the background;
# `monitor.sh summary <log> <workdir>` prints peak usage (written to the job summary by the workflow).
set -uo pipefail
cmd=$1; log=$2
case "$cmd" in
  start)
    (
      while true; do
        ts=$(date +%s)
        if [[ "$(uname -s)" == "Linux" ]]; then
          read -r used avail < <(free -m | awk '/^Mem:/ {print $3, $7}')
          swap=$(free -m | awk '/^Swap:/ {print $3}')
        else
          used=$(( $(vm_stat | awk '/Pages active|Pages wired/ {gsub("\\.","",$NF); s+=$NF} END {print s}') * $(pagesize) / 1048576 ))
          avail=$(( $(vm_stat | awk '/Pages free|Pages inactive/ {gsub("\\.","",$NF); s+=$NF} END {print s}') * $(pagesize) / 1048576 ))
          swap=$(sysctl -n vm.swapusage | sed -E 's/.*used = ([0-9.]+)M.*/\1/' | cut -d. -f1)
        fi
        disk=$(df -Pk "${3:-/}" | awk 'NR==2 {print int($3/1048576)}')
        echo "$ts used=$used avail=$avail swap=$swap diskGB=$disk"
        sleep 20
      done
    ) >> "$log" 2>&1 &
    echo $! > "$log.pid"
    ;;
  summary)
    kill "$(cat "$log.pid")" 2>/dev/null || true
    awk '{for(i=2;i<=NF;i++){split($i,a,"="); v=a[2]+0; if(!(a[1] in mx)||v>mx[a[1]])mx[a[1]]=v; if(!(a[1] in mn)||v<mn[a[1]])mn[a[1]]=v}}
      END {printf "peak RAM used: %d MB, min available: %d MB, peak swap used: %d MB, peak disk used: %d GB\n", mx["used"], mn["avail"], mx["swap"], mx["diskGB"]}' "$log"
    ;;
esac

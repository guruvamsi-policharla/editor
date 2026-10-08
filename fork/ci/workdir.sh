#!/usr/bin/env bash
# Print the build directory: the mounted volume with the most free space (on Linux runners /mnt is often bigger).
set -euo pipefail
best="${RUNNER_TEMP:-/tmp}"; bestfree=$(df -Pk "$best" | awk 'NR==2 {print $4}')
# shellcheck disable=SC2043 # one candidate today; more mounts can be added
for d in /mnt; do
  if [[ -d "$d" ]] && sudo -n true 2>/dev/null; then
    free=$(df -Pk "$d" | awk 'NR==2 {print $4}')
    if (( free > bestfree )); then sudo mkdir -p "$d/build" && sudo chown "$(id -u):$(id -g)" "$d/build"; best="$d/build"; bestfree=$free; fi
  fi
done
echo "$best"

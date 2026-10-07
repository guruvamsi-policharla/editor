#!/usr/bin/env bash
# Add swap on Linux runners (gulp peaks at ~7.3 GB RSS; the free private-repo runner has 8 GB RAM).
# Usage: add-swap.sh <GB>. Uses the disk with the most free space. macOS swaps dynamically: no-op.
set -euo pipefail
GB="${1:-10}"
[[ "$(uname -s)" == "Linux" ]] || { echo "swap: not Linux, skipping"; exit 0; }
best=/; bestfree=0
for d in / /mnt; do
  [[ -d "$d" ]] || continue
  free=$(df -Pk "$d" | awk 'NR==2 {print $4}')
  (( free > bestfree )) && { best=$d; bestfree=$free; }
done
file="${best%/}/swapfile.ci"
sudo swapoff -a || true
sudo rm -f /mnt/swapfile /swapfile || true
sudo fallocate -l "${GB}G" "$file"
sudo chmod 600 "$file"
sudo mkswap "$file" >/dev/null
sudo swapon "$file"
free -m

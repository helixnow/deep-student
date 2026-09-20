#!/usr/bin/env bash
# Linux hosted runners only. Add capacity without disabling existing/active swap.
set -euo pipefail

for name in RELEASE_SWAP_GIB RELEASE_MIN_RAM_GIB RELEASE_FREE_DISK_GIB; do
  value="${!name:-}"
  if [[ -n "$value" && ! "$value" =~ ^[0-9]+$ ]]; then
    echo "::error::$name must be a non-negative integer" >&2
    exit 1
  fi
done
SWAP_GIB=$((10#${RELEASE_SWAP_GIB:-12}))
RAM_GIB=$((10#${RELEASE_MIN_RAM_GIB:-12}))
DISK_GIB=$((10#${RELEASE_FREE_DISK_GIB:-16}))
(( SWAP_GIB <= 1048576 && RAM_GIB <= 1048576 && DISK_GIB <= 1048576 )) || { echo "::error::Resource budget is unreasonably large" >&2; exit 1; }
# Override paths support hermetic tests; workflows use the kernel/default paths.
MEMINFO="${RELEASE_MEMINFO_PATH:-/proc/meminfo}"
SWAP_PATH="${RELEASE_SWAP_PATH:-/mnt/deepstudent-release.swap}"
read_kib() { awk -v key="$1:" '$1 == key { print $2; found=1; exit } END { if (!found) exit 1 }' "$MEMINFO"; }
RAM_KIB="$(read_kib MemTotal)"
SWAP_KIB="$(read_kib SwapTotal)"
[[ "$RAM_KIB" =~ ^[0-9]+$ && "$SWAP_KIB" =~ ^[0-9]+$ ]] || { echo '::error::Invalid kernel memory counters' >&2; exit 1; }
TARGET_KIB=$((SWAP_GIB * 1024 * 1024))
if (( RAM_KIB < RAM_GIB * 1024 * 1024 )); then
  echo "::error::Runner RAM is below the configured ${RAM_GIB}GiB release budget (${RAM_KIB}KiB available total)" >&2
  exit 1
fi
ADD_MIB=0
if (( SWAP_KIB < TARGET_KIB )); then
  # Round up and allow a small mkswap header margin so the final capacity passes.
  ADD_MIB=$(((TARGET_KIB - SWAP_KIB + 1023) / 1024 + 4))
fi
echo "Release resource plan: RAM=${RAM_KIB}KiB swap=${SWAP_KIB}KiB target=${TARGET_KIB}KiB add=${ADD_MIB}MiB"
if [[ "${1:-}" == '--plan' ]]; then exit 0; fi
[[ $# -eq 0 ]] || { echo 'usage: prepare-linux-release.sh [--plan]' >&2; exit 1; }

PARENT="$(dirname "$SWAP_PATH")"
[[ -d "$PARENT" ]] || { echo "::error::Swap directory does not exist: $PARENT" >&2; exit 1; }
FREE_BYTES="$(df -B1 --output=avail "$PARENT" | awk 'NR==2 {print $1}')"
[[ "$FREE_BYTES" =~ ^[0-9]+$ ]] || { echo '::error::Cannot measure free disk capacity' >&2; exit 1; }
NEEDED_BYTES=$((ADD_MIB * 1024 * 1024 + DISK_GIB * 1024 * 1024 * 1024))
if (( FREE_BYTES < NEEDED_BYTES )); then
  echo "::error::Insufficient disk for swap plus ${DISK_GIB}GiB build reserve: free=$FREE_BYTES required=$NEEDED_BYTES" >&2
  exit 1
fi

created=0
activated=0
cleanup() {
  # Never remove an existing file or unlink swap that has already been activated.
  if (( created == 1 && activated == 0 )); then sudo rm -f -- "$SWAP_PATH"; fi
}
trap cleanup EXIT
if (( ADD_MIB > 0 )); then
  if [[ -e "$SWAP_PATH" || -L "$SWAP_PATH" ]]; then
    echo "::error::Refusing to overwrite an existing swap path: $SWAP_PATH" >&2
    exit 1
  fi
  # noclobber + privileged shell closes the check/create race; do not follow links.
  sudo bash -c 'set -o noclobber; : > "$1"' _ "$SWAP_PATH"
  created=1
  sudo chmod 600 "$SWAP_PATH"
  if ! sudo fallocate -l "${ADD_MIB}M" "$SWAP_PATH"; then
    sudo dd if=/dev/zero of="$SWAP_PATH" bs=1M count="$ADD_MIB" status=none
  fi
  sudo mkswap "$SWAP_PATH"
  # A failed swapon is fatal, not a warning followed by an unprotected build.
  sudo swapon "$SWAP_PATH"
  activated=1
fi
FINAL_KIB="$(read_kib SwapTotal)"
if (( FINAL_KIB < TARGET_KIB )); then
  echo "::error::Swap capacity check failed: ${FINAL_KIB}KiB < ${TARGET_KIB}KiB" >&2
  exit 1
fi
echo "Release swap capacity verified: ${FINAL_KIB}KiB"
free -h
swapon --show
df -h "$PARENT" .

#!/usr/bin/env bash
# Stream diagnostics DURING a long build; post-job hooks cannot help a lost runner.
# Preserve the wrapped command's exit status. Never log env values or process args.
set -uo pipefail
[[ $# -gt 0 ]] || { echo 'usage: with-resource-monitor.sh command [args...]' >&2; exit 2; }
INTERVAL="${RELEASE_METRICS_INTERVAL_SECONDS:-30}"
if ! [[ "$INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]] || ! awk -v value="$INTERVAL" 'BEGIN { exit !(value > 0) }'; then
  echo 'Invalid metrics interval' >&2
  exit 2
fi
LOG_DIR="${RUNNER_TEMP:-${TMPDIR:-/tmp}}"
mkdir -p "$LOG_DIR"
LOG_FILE="$LOG_DIR/release-resource-metrics.log"
metrics() {
  {
    echo "=== release resource sample $(date -u '+%Y-%m-%dT%H:%M:%SZ') ==="
    free -m || true
    df -h . || true
    if [[ -r /sys/fs/cgroup/memory.events ]]; then cat /sys/fs/cgroup/memory.events; fi
    if [[ -r /proc/pressure/memory ]]; then cat /proc/pressure/memory; fi
    ps -eo pid,ppid,comm,rss --sort=-rss | head -n 12 || true
  } 2>&1 | tee -a "$LOG_FILE"
}
monitor() {
  sleeper=''
  trap 'if [[ -n "$sleeper" ]]; then kill "$sleeper" 2>/dev/null || true; wait "$sleeper" 2>/dev/null || true; fi; exit 0' TERM INT
  while :; do
    metrics
    sleep "$INTERVAL" & sleeper=$!
    wait "$sleeper" || true
    sleeper=''
  done
}
command -v setsid >/dev/null || { echo "setsid is required to isolate the build process group" >&2; exit 2; }
monitor & monitor_pid=$!
child_pid=''
cleanup() {
  kill "$monitor_pid" 2>/dev/null || true
  wait "$monitor_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'if [[ -n "$child_pid" ]]; then kill -TERM -- "-$child_pid" 2>/dev/null || true; fi' TERM INT
if [[ -x /usr/bin/time ]]; then
  setsid --wait /usr/bin/time -f 'build_exit=%x peak_rss_kib=%M elapsed_seconds=%e major_faults=%F' "$@" & child_pid=$!
else
  setsid --wait "$@" & child_pid=$!
fi
wait "$child_pid"
status=$?
# If wait was interrupted by a signal, reap the child before leaving.
if kill -0 "$child_pid" 2>/dev/null; then wait "$child_pid"; status=$?; fi
cleanup
trap - EXIT
metrics
echo "Wrapped build exit status: $status" | tee -a "$LOG_FILE"
exit "$status"

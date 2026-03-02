#!/bin/bash
# 重启 Android 模拟器并检测网络连通性
# 用法: bash scripts/dev/restart-emulator.sh [avd_name]
#   avd_name  可选，不传则重启当前运行中的模拟器

set -e

# ── 颜色 ──
GREEN='\033[1;32m'
YELLOW='\033[1;33m'
RED='\033[1;31m'
CYAN='\033[1;36m'
BOLD='\033[1m'
RESET='\033[0m'

say()  { echo -e "${GREEN}==>${RESET} $*"; }
warn() { echo -e "${YELLOW}[warn]${RESET} $*"; }
die()  { echo -e "${RED}[error]${RESET} $*" >&2; exit 1; }
info() { echo -e "${CYAN}[info]${RESET} $*"; }

# ── 环境 ──
if [[ -z "${ANDROID_HOME:-}" ]]; then
    for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
        [[ -d "$candidate" ]] && export ANDROID_HOME="$candidate" && break
    done
fi
[[ -z "${ANDROID_HOME:-}" ]] && die "未设置 ANDROID_HOME"

EMULATOR="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"

[[ -x "$EMULATOR" ]] || die "未找到 emulator: $EMULATOR"
[[ -x "$ADB" ]]      || die "未找到 adb: $ADB"

AVD_NAME="${1:-}"

# ── 关闭已运行的模拟器 ──
say "检查运行中的模拟器..."
RUNNING_DEVICES=$("$ADB" devices 2>/dev/null | grep "emulator-" | awk '{print $1}' || true)

if [[ -n "$RUNNING_DEVICES" ]]; then
    for device in $RUNNING_DEVICES; do
        say "关闭模拟器: $device"
        "$ADB" -s "$device" emu kill 2>/dev/null || true
    done
    say "等待模拟器完全退出..."
    sleep 5

    if "$ADB" devices 2>/dev/null | grep -q "emulator-"; then
        warn "模拟器进程仍在运行，尝试强制终止..."
        pkill -f "qemu-system" 2>/dev/null || true
        pkill -f "emulator" 2>/dev/null || true
        sleep 3
    fi
    say "✓ 旧模拟器已关闭"
else
    info "没有正在运行的模拟器"
fi

# ── 选择 AVD ──
if [[ -z "$AVD_NAME" ]]; then
    mapfile -t AVDS < <("$EMULATOR" -list-avds 2>/dev/null)

    if [[ ${#AVDS[@]} -eq 0 ]]; then
        die "没有可用的 AVD"
    fi

    if [[ ${#AVDS[@]} -eq 1 ]]; then
        AVD_NAME="${AVDS[0]}"
    else
        echo ""
        echo -e "${BOLD}可用的 AVD:${RESET}"
        for i in "${!AVDS[@]}"; do
            echo "  $((i + 1))) ${AVDS[$i]}"
        done
        echo ""
        read -rp "请选择 [1-${#AVDS[@]}] (默认 1): " choice
        choice="${choice:-1}"
        AVD_NAME="${AVDS[$((choice - 1))]}"
    fi
fi

# ── 重启 ADB 服务 ──
say "重启 ADB 服务..."
"$ADB" kill-server 2>/dev/null || true
sleep 1
"$ADB" start-server
say "✓ ADB 服务已重启"

# ── 启动模拟器 ──
say "启动模拟器: $AVD_NAME"
"$EMULATOR" -avd "$AVD_NAME" -no-snapshot-load -gpu auto &
EMULATOR_PID=$!

say "等待模拟器完全启动..."
WAIT_SECONDS=120
ELAPSED=0
while [[ $ELAPSED -lt $WAIT_SECONDS ]]; do
    if "$ADB" shell getprop sys.boot_completed 2>/dev/null | grep -q "1"; then
        break
    fi
    sleep 2
    ELAPSED=$((ELAPSED + 2))
    printf "\r  启动中... %ds / %ds" "$ELAPSED" "$WAIT_SECONDS"
done
echo ""

if [[ $ELAPSED -ge $WAIT_SECONDS ]]; then
    warn "模拟器启动超时 (${WAIT_SECONDS}s)，继续进行网络检测..."
else
    say "✓ 模拟器已启动 (${ELAPSED}s)"
fi

# ── 网络诊断 ──
echo ""
say "开始网络连通性诊断..."

check_network() {
    local desc="$1" target="$2"
    if "$ADB" shell ping -c 1 -W 3 "$target" &>/dev/null; then
        echo -e "  ✅ $desc ($target)"
        return 0
    else
        echo -e "  ❌ $desc ($target)"
        return 1
    fi
}

NETWORK_OK=true

check_network "Google DNS"          "8.8.8.8"           || NETWORK_OK=false
check_network "Cloudflare DNS"      "1.1.1.1"           || NETWORK_OK=false
check_network "阿里 DNS"            "223.5.5.5"         || NETWORK_OK=false
check_network "宿主机 (10.0.2.2)"   "10.0.2.2"          || NETWORK_OK=false

echo ""

# DNS 解析测试
say "DNS 解析测试..."
if "$ADB" shell ping -c 1 -W 5 "www.baidu.com" &>/dev/null; then
    echo -e "  ✅ DNS 解析正常 (www.baidu.com)"
else
    echo -e "  ❌ DNS 解析失败 (www.baidu.com)"
    NETWORK_OK=false
fi

echo ""

if [[ "$NETWORK_OK" == true ]]; then
    say "✓ 网络诊断全部通过"
else
    warn "部分网络检测失败。常见解决方法："
    echo "  1. 在模拟器设置中检查 Wi-Fi 是否连接"
    echo "  2. 重启模拟器: bash $0"
    echo "  3. 冷启动模拟器: \$ANDROID_HOME/emulator/emulator -avd $AVD_NAME -no-snapshot -wipe-data"
    echo "  4. 检查宿主机防火墙/VPN 设置"
fi

# ── 设备信息 ──
echo ""
say "模拟器设备信息:"
echo "  AVD:         $AVD_NAME"
echo "  Android:     $("$ADB" shell getprop ro.build.version.release 2>/dev/null || echo '未知')"
echo "  SDK:         $("$ADB" shell getprop ro.build.version.sdk 2>/dev/null || echo '未知')"
echo "  架构:        $("$ADB" shell getprop ro.product.cpu.abi 2>/dev/null || echo '未知')"
echo "  分辨率:      $("$ADB" shell wm size 2>/dev/null | awk '{print $NF}' || echo '未知')"
echo ""
say "模拟器已就绪，可以运行: npx tauri android dev"

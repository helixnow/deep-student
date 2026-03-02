#!/bin/bash
# 一键启动 Android 模拟器 + Tauri 开发环境
# 用法: bash scripts/dev/start-android-dev.sh [avd_name]
#   avd_name  可选，指定模拟器名称；不传则自动选择第一个可用 AVD

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

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

# ── 环境检查 ──
if [[ -z "${ANDROID_HOME:-}" ]]; then
    for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk" "/usr/local/lib/android/sdk"; do
        if [[ -d "$candidate" ]]; then
            export ANDROID_HOME="$candidate"
            break
        fi
    done
fi
[[ -z "${ANDROID_HOME:-}" ]] && die "未设置 ANDROID_HOME，也未在常见路径找到 Android SDK"

EMULATOR="$ANDROID_HOME/emulator/emulator"
ADB="$ANDROID_HOME/platform-tools/adb"

[[ -x "$EMULATOR" ]] || die "未找到 emulator: $EMULATOR"
[[ -x "$ADB" ]]      || die "未找到 adb: $ADB"

command -v npx >/dev/null 2>&1 || die "缺少 npx，请先安装 Node.js"

# ── 检查 Rust Android 目标 ──
if ! rustup target list --installed 2>/dev/null | grep -q "aarch64-linux-android"; then
    warn "未安装 aarch64-linux-android 目标，正在安装..."
    rustup target add aarch64-linux-android
fi

# ── 确保 Android 项目已初始化 ──
if [[ ! -d "$REPO_ROOT/src-tauri/gen/android" ]]; then
    say "Android 项目未初始化，正在执行 tauri android init..."
    (cd "$REPO_ROOT" && npx tauri android init) || die "tauri android init 失败"
    say "✓ Android 项目初始化完成"
fi

# ── 选择 AVD ──
AVD_NAME="${1:-}"

if [[ -z "$AVD_NAME" ]]; then
    mapfile -t AVDS < <("$EMULATOR" -list-avds 2>/dev/null)

    if [[ ${#AVDS[@]} -eq 0 ]]; then
        die "没有可用的 AVD。请先通过 Android Studio Device Manager 或 avdmanager 创建一个模拟器"
    fi

    if [[ ${#AVDS[@]} -eq 1 ]]; then
        AVD_NAME="${AVDS[0]}"
        info "自动选择唯一的 AVD: $AVD_NAME"
    else
        echo ""
        echo -e "${BOLD}可用的 AVD 列表:${RESET}"
        for i in "${!AVDS[@]}"; do
            echo "  $((i + 1))) ${AVDS[$i]}"
        done
        echo ""
        read -rp "请选择模拟器编号 [1-${#AVDS[@]}] (默认 1): " choice
        choice="${choice:-1}"
        if [[ "$choice" -lt 1 || "$choice" -gt ${#AVDS[@]} ]] 2>/dev/null; then
            die "无效选择: $choice"
        fi
        AVD_NAME="${AVDS[$((choice - 1))]}"
    fi
fi

say "使用 AVD: $AVD_NAME"

# ── 检查模拟器是否已运行 ──
EMULATOR_ALREADY_RUNNING=false
if "$ADB" devices 2>/dev/null | grep -q "emulator-"; then
    info "检测到模拟器已在运行"
    EMULATOR_ALREADY_RUNNING=true
fi

# ── 启动模拟器（后台） ──
if [[ "$EMULATOR_ALREADY_RUNNING" == false ]]; then
    say "启动模拟器..."
    "$EMULATOR" -avd "$AVD_NAME" -no-snapshot-load -gpu auto &
    EMULATOR_PID=$!

    say "等待模拟器启动..."
    WAIT_SECONDS=120
    ELAPSED=0
    while [[ $ELAPSED -lt $WAIT_SECONDS ]]; do
        if "$ADB" shell getprop sys.boot_completed 2>/dev/null | grep -q "1"; then
            break
        fi
        sleep 2
        ELAPSED=$((ELAPSED + 2))
        printf "\r  等待中... %ds / %ds" "$ELAPSED" "$WAIT_SECONDS"
    done
    echo ""

    if [[ $ELAPSED -ge $WAIT_SECONDS ]]; then
        warn "模拟器启动超时（${WAIT_SECONDS}s），将继续尝试..."
    else
        say "✓ 模拟器已就绪 (${ELAPSED}s)"
    fi
else
    say "✓ 模拟器已在运行，跳过启动"
fi

# ── 网络连通性检查 ──
say "检查模拟器网络..."
if "$ADB" shell ping -c 1 -W 3 8.8.8.8 &>/dev/null; then
    info "✓ 模拟器网络连通"
else
    warn "模拟器可能无法访问外网，部分功能可能受限"
fi

# ── 获取本机 IP（供模拟器内 WebView 连接 dev server） ──
HOST_IP=""
if command -v ipconfig >/dev/null 2>&1; then
    HOST_IP=$(ipconfig getifaddr en0 2>/dev/null || true)
fi
if [[ -z "$HOST_IP" ]]; then
    HOST_IP=$(hostname -I 2>/dev/null | awk '{print $1}' || true)
fi
if [[ -n "$HOST_IP" ]]; then
    info "本机 IP: $HOST_IP （模拟器可通过 10.0.2.2 访问宿主机）"
fi

# ── 启动 Tauri Android Dev ──
say "启动 Tauri Android 开发模式..."
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║  Deep Student Android Dev                    ║${RESET}"
echo -e "${BOLD}║  模拟器: $AVD_NAME"
echo -e "${BOLD}║  按 Ctrl+C 停止开发服务器                    ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"
echo ""

cd "$REPO_ROOT"
npx tauri android dev

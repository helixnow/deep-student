#!/bin/bash
# Android logcat 前端控制台调试（多种模式）
# 用法: bash scripts/dev/debug-android-console.sh [mode]
#
# 模式:
#   all       显示所有日志（默认）
#   webview   仅 WebView / Chromium 日志
#   tauri     仅 Tauri 框架日志
#   rust      仅 Rust 后端日志
#   app       应用相关日志（综合过滤）
#   crash     仅崩溃和 ANR 日志
#   network   网络请求相关日志
#   clear     清除 logcat 缓冲区后退出

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

# ── 环境 ──
if [[ -z "${ANDROID_HOME:-}" ]]; then
    for candidate in "$HOME/Library/Android/sdk" "$HOME/Android/Sdk"; do
        [[ -d "$candidate" ]] && export ANDROID_HOME="$candidate" && break
    done
fi
[[ -z "${ANDROID_HOME:-}" ]] && die "未设置 ANDROID_HOME"

ADB="$ANDROID_HOME/platform-tools/adb"
[[ -x "$ADB" ]] || die "未找到 adb: $ADB"

if ! "$ADB" devices 2>/dev/null | grep -qE "device$"; then
    die "未检测到已连接的 Android 设备/模拟器。请先启动模拟器"
fi

APP_PACKAGE="com.deepstudent.app"
MODE="${1:-all}"

show_help() {
    echo ""
    echo -e "${BOLD}Android 日志调试工具${RESET}"
    echo ""
    echo "用法: $0 [mode]"
    echo ""
    echo "可用模式:"
    echo "  all       显示所有日志（默认）"
    echo "  webview   仅 WebView / Chromium 日志（前端 console.log）"
    echo "  tauri     仅 Tauri 框架日志"
    echo "  rust      仅 Rust 后端日志"
    echo "  app       应用相关日志（综合过滤）"
    echo "  crash     仅崩溃和 ANR 日志"
    echo "  network   网络请求相关日志"
    echo "  clear     清除 logcat 缓冲区"
    echo ""
}

case "$MODE" in
    all)
        say "模式: 全部日志 (Ctrl+C 停止)"
        "$ADB" logcat -v time
        ;;
    webview)
        say "模式: WebView 日志 — 显示前端 console.log / console.error (Ctrl+C 停止)"
        "$ADB" logcat -v time | grep -iE "chromium|WebView|console|INFO:CONSOLE"
        ;;
    tauri)
        say "模式: Tauri 框架日志 (Ctrl+C 停止)"
        "$ADB" logcat -v time | grep -iE "tauri|wry|tao"
        ;;
    rust)
        say "模式: Rust 后端日志 (Ctrl+C 停止)"
        "$ADB" logcat -v time | grep -iE "RustStdoutStderr|deep.student|deepstudent"
        ;;
    app)
        say "模式: 应用综合日志 (Ctrl+C 停止)"
        APP_PID=$("$ADB" shell pidof "$APP_PACKAGE" 2>/dev/null || true)
        if [[ -n "$APP_PID" ]]; then
            info "应用 PID: $APP_PID"
            "$ADB" logcat -v time --pid="$APP_PID"
        else
            warn "应用未运行，退回到关键词过滤模式"
            "$ADB" logcat -v time | grep -iE "deepstudent|tauri|chromium|CONSOLE|wry"
        fi
        ;;
    crash)
        say "模式: 崩溃 / ANR 日志 (Ctrl+C 停止)"
        "$ADB" logcat -v time | grep -iE "FATAL|AndroidRuntime|crash|ANR|SIGSEGV|SIGABRT|backtrace|panic"
        ;;
    network)
        say "模式: 网络请求日志 (Ctrl+C 停止)"
        "$ADB" logcat -v time | grep -iE "OkHttp|http|fetch|network|ConnectivityManager|DNS|SSL|reqwest"
        ;;
    clear)
        say "清除 logcat 缓冲区..."
        "$ADB" logcat -c
        say "✓ 已清除"
        exit 0
        ;;
    -h|--help|help)
        show_help
        exit 0
        ;;
    *)
        die "未知模式: $MODE（使用 --help 查看可用模式）"
        ;;
esac

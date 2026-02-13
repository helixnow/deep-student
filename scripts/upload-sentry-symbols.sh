#!/bin/bash
# 上传 debug symbols 到 Sentry，使崩溃堆栈可读
#
# 前置条件:
#   1. 安装 sentry-cli: npm i -g @sentry/cli  或  brew install getsentry/tools/sentry-cli
#   2. 设置环境变量: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT
#   3. Release 构建时 strip = "debuginfo" 而非 strip = true（保留符号文件）
#
# 使用方法: ./scripts/upload-sentry-symbols.sh [platform]
# platform: macos, windows, linux (默认: 当前平台)

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info() { echo -e "${GREEN}[INFO]${NC} $1"; }
log_warn() { echo -e "${YELLOW}[WARN]${NC} $1"; }
log_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# 检查 sentry-cli 是否安装
if ! command -v sentry-cli &> /dev/null; then
    log_error "sentry-cli 未安装。请运行: npm i -g @sentry/cli"
    exit 1
fi

# 检查环境变量
if [ -z "$SENTRY_AUTH_TOKEN" ]; then
    log_error "请设置 SENTRY_AUTH_TOKEN 环境变量"
    exit 1
fi

if [ -z "$SENTRY_ORG" ] || [ -z "$SENTRY_PROJECT" ]; then
    log_error "请设置 SENTRY_ORG 和 SENTRY_PROJECT 环境变量"
    exit 1
fi

SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_DIR="$PROJECT_ROOT/src-tauri/target/release"

# 从 Cargo.toml 读取版本号
APP_VERSION=$(grep '^version' "$PROJECT_ROOT/src-tauri/Cargo.toml" | head -1 | sed 's/.*"\(.*\)".*/\1/')
BUILD_NUMBER=$(git -C "$PROJECT_ROOT" rev-list --all --count 2>/dev/null || echo "0")
BUILD_NUMBER=$((9000 + BUILD_NUMBER))
SENTRY_RELEASE="${APP_VERSION}+${BUILD_NUMBER}"

log_info "Sentry Release: ${SENTRY_RELEASE}"
log_info "Target Dir: ${TARGET_DIR}"

# 创建 Sentry release
log_info "创建 Sentry release..."
sentry-cli releases new "$SENTRY_RELEASE"

# 上传 debug symbols (dSYM / PDB / debug info)
log_info "上传 debug symbols..."
sentry-cli debug-files upload \
    --include-sources \
    "$TARGET_DIR"

# 标记 release 已完成
sentry-cli releases finalize "$SENTRY_RELEASE"

log_info "✅ Debug symbols 已上传至 Sentry release: ${SENTRY_RELEASE}"

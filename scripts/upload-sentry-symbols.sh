#!/bin/bash
# 上传 debug symbols 到 Sentry，使崩溃堆栈可读
#
# 前置条件:
#   1. 安装 sentry-cli: npm i -g @sentry/cli  或  brew install getsentry/tools/sentry-cli
#   2. 设置环境变量: SENTRY_AUTH_TOKEN, SENTRY_ORG, SENTRY_PROJECT
#   3. Release profile 启用 debug/split-debuginfo，生成独立 dSYM/PDB/debug 文件
#
# 使用方法: ./scripts/upload-sentry-symbols.sh [artifact-directory]
# 默认读取 CARGO_TARGET_DIR/CARGO_BUILD_TARGET，未设置时使用 src-tauri/target/release

# -u/-o pipefail: 未定义变量和管道失败必须显式暴露, 不允许静默半成功
set -euo pipefail

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

# 打印工具 manifest（CI 中版本由 workflow 固定安装）
log_info "sentry-cli version: $(sentry-cli --version)"

# 检查环境变量
if [ -z "${SENTRY_AUTH_TOKEN:-}" ]; then
    log_error "请设置 SENTRY_AUTH_TOKEN 环境变量"
    exit 1
fi

if [ -z "${SENTRY_ORG:-}" ] || [ -z "${SENTRY_PROJECT:-}" ]; then
    log_error "请设置 SENTRY_ORG 和 SENTRY_PROJECT 环境变量"
    exit 1
fi

SCRIPT_DIR="$(dirname "$0")"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
TARGET_ROOT="${CARGO_TARGET_DIR:-$PROJECT_ROOT/src-tauri/target}"
if [ -n "${1:-}" ]; then
    TARGET_DIR="$1"
elif [ -n "${CARGO_BUILD_TARGET:-}" ]; then
    TARGET_DIR="$TARGET_ROOT/$CARGO_BUILD_TARGET/release"
else
    TARGET_DIR="$TARGET_ROOT/release"
fi

if [ ! -d "$TARGET_DIR" ]; then
    log_error "原生符号目录不存在: $TARGET_DIR"
    exit 1
fi

# 与前端和 Rust 共用内部 build number；Android versionCode 独立管理。
SENTRY_RELEASE=$(node "$PROJECT_ROOT/scripts/generate-version.mjs" --print-sentry-release)

log_info "Sentry Release: ${SENTRY_RELEASE}"
log_info "Target Dir: ${TARGET_DIR}"

# 创建 Sentry release
log_info "创建 Sentry release..."
if ! sentry-cli releases new "$SENTRY_RELEASE"; then
    log_warn "Release 可能已由前端 source map 上传阶段创建，继续上传原生符号"
fi

# 上传 debug symbols (dSYM / PDB / debug info)
log_info "上传 debug symbols..."
sentry-cli debug-files upload \
    --include-sources \
    "$TARGET_DIR"

# 标记 release 已完成
sentry-cli releases finalize "$SENTRY_RELEASE"

log_info "✅ Debug symbols 已上传至 Sentry release: ${SENTRY_RELEASE}"

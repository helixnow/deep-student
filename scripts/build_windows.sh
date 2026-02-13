#!/usr/bin/env bash
set -Eeuo pipefail

# macOS 交叉编译 Windows (NSIS) 构建脚本
# 使用 cargo-xwin 自动处理 Windows SDK
#
# 前置要求（首次运行前需安装）:
#   brew install nsis llvm
#   rustup target add x86_64-pc-windows-msvc
#   cargo install --locked cargo-xwin
#   # 将 LLVM 添加到 PATH: export PATH="/opt/homebrew/opt/llvm/bin:$PATH"
#
# 用法:
#   bash ./scripts/build_windows.sh
#
# 可选环境变量:
#   SKIP_FRONTEND_BUILD=true  # 跳过前端构建
#   XWIN_CACHE_DIR=~/.xwin    # Windows SDK 缓存目录（避免重复下载）

SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)

# 颜色输出
say() { echo -e "\033[1;32m==>\033[0m $*"; }
warn() { echo -e "\033[1;33m[warn]\033[0m $*"; }
die() { echo -e "\033[1;31m[error]\033[0m $*" >&2; exit 1; }

require_cmd() { 
  command -v "$1" >/dev/null 2>&1 || die "缺少命令: $1\n请运行: $2"
}

# 检查必要工具
say "检查构建环境..."

require_cmd npm "brew install node"
require_cmd rustup "curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh"
require_cmd makensis "brew install nsis"
require_cmd cargo-xwin "cargo install --locked cargo-xwin"

# 检查 LLVM/lld
if ! command -v lld-link >/dev/null 2>&1; then
  # 检查 Homebrew LLVM 路径
  LLVM_BIN="/opt/homebrew/opt/llvm/bin"
  if [[ -d "$LLVM_BIN" ]]; then
    export PATH="$LLVM_BIN:$PATH"
    say "已添加 LLVM 到 PATH: $LLVM_BIN"
  else
    die "找不到 lld-link。请安装 LLVM:\n  brew install llvm\n  并将以下内容添加到 ~/.zshrc:\n  export PATH=\"/opt/homebrew/opt/llvm/bin:\$PATH\""
  fi
fi

# 检查 Windows 目标是否已安装
if ! rustup target list --installed | grep -q "x86_64-pc-windows-msvc"; then
  say "安装 Windows Rust 目标..."
  rustup target add x86_64-pc-windows-msvc
fi

cd "$REPO_ROOT"

# 设置 xwin 缓存目录（避免每次重新下载约 1GB 的 Windows SDK）
export XWIN_CACHE_DIR="${XWIN_CACHE_DIR:-$HOME/.xwin-cache}"
say "Windows SDK 缓存目录: $XWIN_CACHE_DIR"

# 构建前端
if [[ -z "${SKIP_FRONTEND_BUILD:-}" ]]; then
  say "生成版本信息..."
  node scripts/generate-version.mjs || die "版本信息生成失败"
  
  say "构建前端 (npm run build)..."
  npm run build || die "前端构建失败"
else
  warn "跳过前端构建 (SKIP_FRONTEND_BUILD=true)"
fi

# 交叉编译 Windows
say "开始交叉编译 Windows (x86_64-pc-windows-msvc)..."
say "首次运行会下载 Windows SDK (~1GB)，请耐心等待..."

# 创建 Windows 专用配置（只打 NSIS 包）
WINDOWS_CONFIG='{"bundle":{"targets":["nsis"]}}'

# 修复 CI 环境变量兼容性问题
unset CI

cd src-tauri
cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc --config "$WINDOWS_CONFIG"
cd ..

# 查找构建产物
OUTPUT_DIR="src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis"
if [[ -d "$OUTPUT_DIR" ]]; then
  say "构建成功！"
  say "输出目录: $OUTPUT_DIR"
  echo ""
  say "构建产物:"
  ls -lh "$OUTPUT_DIR"/*.exe 2>/dev/null || warn "未找到 .exe 文件"
  
  # 复制到 build-windows 目录
  BUILD_DIR="$REPO_ROOT/build-windows"
  mkdir -p "$BUILD_DIR"
  cp "$OUTPUT_DIR"/*.exe "$BUILD_DIR/" 2>/dev/null || true
  say "已复制到: $BUILD_DIR"
else
  die "构建失败，未找到输出目录: $OUTPUT_DIR"
fi

say "Windows 构建完成！"
echo ""
warn "注意: 交叉编译的安装程序未签名，用户安装时可能会看到 Windows SmartScreen 警告。"
warn "如需签名，请在 Windows 机器上使用 signtool 进行签名。"

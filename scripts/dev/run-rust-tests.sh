#!/bin/bash
# Rust 后端测试运行脚本
# 用法: bash scripts/dev/run-rust-tests.sh

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
TAURI_DIR="$REPO_ROOT/src-tauri"

echo "🧪 运行 Deep Student Rust 后端测试套件"
echo "=================================="

# 切换到 src-tauri 目录
if [ ! -f "$TAURI_DIR/Cargo.toml" ]; then
    echo "❌ 错误: 未找到 $TAURI_DIR/Cargo.toml"
    exit 1
fi

cd "$TAURI_DIR"

echo "📋 运行单元测试..."
cargo test --lib

echo ""
echo "🔧 运行集成测试..."
cargo test --test '*'

echo ""
echo "🔍 运行代码质量检查..."
cargo clippy -- -D warnings

echo ""
echo "📝 检查代码格式..."
cargo fmt --check

echo ""
echo "✅ 所有测试完成!"
echo "=================================="

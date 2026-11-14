#!/bin/bash
# 测试模板功能
# 用法: bash scripts/dev/test-templates.sh <database_path>

set -e

DB_PATH="${1:-}"

if [[ -z "$DB_PATH" ]]; then
    echo "用法: bash scripts/dev/test-templates.sh <database_path>"
    echo "示例: bash scripts/dev/test-templates.sh ~/Library/Application\\ Support/com.deepstudent.app/mistakes.db"
    exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
    echo "❌ 数据库文件不存在: $DB_PATH"
    exit 1
fi

echo "测试模板功能..."
echo "数据库: $DB_PATH"
echo ""

echo "=== 数据库中的模板 ==="
sqlite3 "$DB_PATH" "SELECT COUNT(*) as total, SUM(is_built_in) as builtin FROM custom_anki_templates;"
echo ""

echo "=== 所有模板列表 ==="
sqlite3 "$DB_PATH" "SELECT id, name, is_built_in FROM custom_anki_templates;"
echo ""

echo "=== 检查 anki_connect_enabled 设置 ==="
sqlite3 "$DB_PATH" "SELECT * FROM settings WHERE key = 'anki_connect_enabled';"
echo ""

echo "=== 模拟获取所有模板 ==="
sqlite3 "$DB_PATH" "SELECT id, name, description, is_built_in FROM custom_anki_templates WHERE is_active = 1;"

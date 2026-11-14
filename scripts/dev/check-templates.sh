#!/bin/bash
# 检查内置模板状态
# 用法: bash scripts/dev/check-templates.sh [db_path]
# 默认数据库路径为 AppData 目录下的 mistakes.db

set -e

DB_PATH="${1:-}"

if [[ -z "$DB_PATH" ]]; then
    echo "用法: bash scripts/dev/check-templates.sh <database_path>"
    echo "示例: bash scripts/dev/check-templates.sh ~/Library/Application\\ Support/com.deepstudent.app/mistakes.db"
    exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
    echo "❌ 数据库文件不存在: $DB_PATH"
    exit 1
fi

echo "检查内置模板状态..."
echo "数据库: $DB_PATH"
echo ""

echo "当前数据库版本："
sqlite3 "$DB_PATH" "SELECT version FROM schema_version ORDER BY version DESC LIMIT 1;"
echo ""

echo "模板总数："
sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM custom_anki_templates;"
echo ""

echo "内置模板数量："
sqlite3 "$DB_PATH" "SELECT COUNT(*) FROM custom_anki_templates WHERE is_built_in = 1;"
echo ""

echo "所有模板列表："
sqlite3 "$DB_PATH" "SELECT id, name, is_built_in FROM custom_anki_templates;"

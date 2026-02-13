# 数据库迁移目录

本目录包含所有数据库的迁移脚本，由 [Refinery](https://github.com/rust-db/refinery) 框架管理。

## 目录结构

```
migrations/
├── vfs/           # VFS 虚拟文件系统数据库
├── chat_v2/       # Chat V2 对话历史数据库
├── mistakes/      # Mistakes 错题本数据库
└── llm_usage/     # LLM Usage 使用统计数据库
```

## 迁移文件命名规范

### 格式：时间戳 + 序号

```
V{YYYYMMDD}_{NNN}__{description}.sql
```

- **YYYYMMDD**: 日期（如 `20260130`）
- **NNN**: 当日序号，三位数字（如 `001`, `002`）
- **description**: 小写字母 + 下划线，描述迁移内容

### 示例

```
V20260130_001__init.sql              # 2026-01-30 第1个迁移：初始化
V20260130_002__add_sync_fields.sql   # 2026-01-30 第2个迁移：添加同步字段
V20260201_001__create_index.sql      # 2026-02-01 第1个迁移：创建索引
```

### 为什么使用时间戳？

1. **避免版本冲突**：多人协作时不会抢占版本号
2. **自然排序**：按时间顺序排列，易于追踪
3. **Refinery 兼容**：支持此命名格式

## 重要规则

1. **已应用的迁移不可修改**：修改会导致 checksum 验证失败
2. **回滚通过新增迁移实现**：如需回滚，创建新的迁移来撤销变更
3. **每个迁移必须声明验证配置**：表、列、索引的预期结果

## 迁移文件内容规范

```sql
-- migrations/vfs/V20260130_002__add_sync_fields.sql

-- 添加同步相关字段
ALTER TABLE resources ADD COLUMN device_id TEXT;
ALTER TABLE resources ADD COLUMN local_version INTEGER DEFAULT 0;
ALTER TABLE resources ADD COLUMN sync_version INTEGER DEFAULT 0;
ALTER TABLE resources ADD COLUMN updated_at TEXT DEFAULT (datetime('now'));
ALTER TABLE resources ADD COLUMN deleted_at TEXT;  -- tombstone

-- 创建索引
CREATE INDEX IF NOT EXISTS idx_resources_local_version ON resources(local_version);
CREATE INDEX IF NOT EXISTS idx_resources_sync_version ON resources(sync_version);
```

## 迁移定义（Rust 侧）

每个迁移需要在 Rust 中配套验证配置：

```rust
// src-tauri/src/data_governance/migration/definitions.rs

use super::MigrationDef;

pub const VFS_MIGRATIONS: &[MigrationDef] = &[
    MigrationDef::new(
        20260130_001,
        "20260130_001__init",
        include_str!("../../../migrations/vfs/V20260130_001__init.sql"),
    )
    .with_expected_tables(&["resources", "units", "segments"])
    .with_expected_indexes(&["idx_resources_type"]),
    
    MigrationDef::new(
        20260130_002,
        "20260130_002__add_sync_fields",
        include_str!("../../../migrations/vfs/V20260130_002__add_sync_fields.sql"),
    )
    .with_expected_columns(&[
        ("resources", "device_id"),
        ("resources", "local_version"),
        ("resources", "sync_version"),
    ])
    .with_expected_indexes(&[
        "idx_resources_local_version",
        "idx_resources_sync_version",
    ]),
];
```

## 本地测试迁移

```bash
# 运行迁移测试
cargo test --test migration_tests

# 验证 schema 一致性
cargo xtask verify-schema
```

## 参考文档

- [数据治理系统重构方案](../../docs/数据治理系统重构方案.md)
- [Refinery 文档](https://docs.rs/refinery/)
- [SQLite Backup API](https://www.sqlite.org/backup.html)

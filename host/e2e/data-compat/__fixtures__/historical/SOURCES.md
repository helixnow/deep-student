# WP-013：非 refinery 历史 SQL 来源

这些文件仅截取历史 Rust raw string 的 SQL 正文；没有调用 Host schema/migrator 生成旧库。
执行器沿用 `../fixtures.ts` 的 better-sqlite3、显式 seed、全列 safeIntegers 快照模式。
对比历史正文时仅忽略文件两端空白（raw-string 分隔符不属于 SQL），内部 SQL 原样。

| SQL | 固定 Git 来源 | 版本事实 |
|---|---|---|
| `audit.sql` | `1813b3c9c16eff57768ad884d96b6f5a9b447a54:src-tauri/src/data_governance/audit/mod.rs:182-198`，`CREATE_TABLE_SQL` | 初始发布已有此 schema；历史 `git log --follow -G 'CREATE TABLE\|ALTER TABLE\|user_version'` 只有初始创建。无编号版本链，不能伪造 V1 或 refinery history。当前 `dstu-storage/src/audit/mod.rs:193-209` 相同。 |
| `sync-state.sql` | `de1159c149c2b6064532443d87189ab3b56ed768:src-tauri/src/data_governance/sync/state.rs:59-107`，`init` | 是 `8a68823ec5517c998a794ebf1f3cd239efc0e745` 的父提交；后者增加 `tombstone_event_publish`。选择前一实际六表 schema；没有编号版本，`user_version` 保持 0。 |
| `workspace-v1.sql` | `41a5ca8f1ff92f761eabd7594b676bcbc75d9e04:src-tauri/src/chat_v2/workspace/database.rs:13-122`，`WORKSPACE_SCHEMA` | 同文件 `:124` 明确版本 1，`:142-144` 设置 user_version；`ccee0f518` / `6f2642c42` 改为 2。fixture 依原路径设置 user_version=1，绝不附加 refinery history。 |

workspace V1 的真实建表 SQL **已经有** `initial_task/started_at/completed_at/result_summary`。
因此本样本验证重复 ALTER 的兼容处理、version 1→2、全列及 sqlite_sequence 不变；不声称覆盖
`task_content` 回填分支。当前 Rust `database.rs:170-205` 虽有该分支，但不能把 chat_v2.db 的
同名表 DDL 挪来冒充 ws 库的历史版本。

真实文件位置与版本机制：

- audit：活动槽 `databases/audit.db`，`dstu-storage/src/migration/coordinator.rs:264`。
- sync_state：`<dataLocalDir>/deep-student/sync/sync_state.db`，`dstu-sync/src/data_governance/sync/state.rs:22-37`，不在槽中。
- workspace：活动槽 `workspaces/ws_<workspace_id>.db`，`dstu-agent/src/chat_v2/workspace/database.rs:230-244,300-302`；ID 自带 `ws_` 时文件名也有双前缀（本样本 `ws_ws_old.db`）。
- `dstu-storage/src/schema_registry.rs:43-63,85-94` 的治理枚举仅有四核心库，明确豁免 `ws_*.db`。
- `<app_data_dir>/superagent/superagent.db` 是不同的废弃实验库；当前迁移仅读 `sa_kv.enabled` 并改名 `.legacy`，不导入历史，见 `dstu-agent/src/chat_v2/super_session/state.rs:978-1032`。本包不构造别名 `workspace.db` 或 `superagent.db`。

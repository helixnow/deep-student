# 0824 发布审计：数据库 / 持久化 schema 升级盘点（v0.9.44 → 30fc858b）

隔离枝：`cursor/0824-rel-schema-cde6`（基于 `origin/cursor/0824-cde6` @ `30fc858b`）。

任务：盘点 `v0.9.44` → 发布枝的全部 schema / 持久化升级，找出尚未被
Step 18/19 与已开 rel 枝覆盖的真实升级洞。只修会导致**升级失败、丢数据、
或读写分叉**的问题。

## 结论总览

发现 **1 个未被任何枝覆盖的洞**（已在本枝修复），其余项目 SAFE 或已由
既有提交 / rel 枝覆盖（SKIP，不重复造轮子）。

| # | 项目 | 结论 |
|---|------|------|
| 1 | `migration-lock.json` 缺 `vfs/V20260824__note_props.sql` 条目 | **FIXED（本枝）** |
| 2 | vfs `V20260824__note_props.sql`（注册、pre-repair、CAS/LWW、搜索下推） | SKIP（`cursor/0824-rel-vfs-cde6` 已硬化，待官方 cherry-pick） |
| 3 | llm_usage `V20260824__add_cache_write_tokens.sql` | SAFE（官方 `920dd665`） |
| 4 | mistakes `V20260824__normalize_anki_card_optional_json.sql` | SAFE（官方 `0105a7eb`） |
| 5 | main VFS missing-tables backfill（含 `notes.props` 列恢复） | SAFE（官方 `5f324e1f`） |
| 6 | chat_v2 schema（头 20260806） | SAFE |
| 7 | browser schema（停在 20260711） | SAFE（确认为故意，升级安全） |
| 8 | Zustand persist（finder / workbench / composer） | SAFE（Step 18） |
| 9 | `dstu-auto-sync` persist（新 key，v2 + 防御性 migrate） | SAFE |
| 10 | 其余 localStorage key 变更 | SAFE（全部净新增或清理） |
| 11 | 云存储配置 SSOT（localStorage → settings 表一次性迁移） | SAFE |
| 12 | DSTU 类型（TS / Rust 序列化契约） | SAFE |
| 13 | chat_v2 workspace DB（`user_version = 2`） | SAFE（自 tag 起未变更） |

## 修复项：migration-lock 缺 vfs 20260824 条目（FIXED）

### 现象

发布枝 `30fc858b` 上 `node scripts/check-migrations.mjs` 失败，共 2 个问题：

```text
- 迁移文件未锁定: vfs/V20260824__note_props.sql（新增迁移需运行 --update 更新 manifest）
- vfs/V20260824__note_props.sql: 缺少对应的 Rust MigrationDef（vfs.rs 中未发现 include_str! 引用）
```

该脚本是 L1 静态迁移门禁，由 `reusable-migration-gate.yml`（PR / push）
和 `migration-nightly.yml` 直接执行——发布枝当前 CI 红。

三个 0824 新迁移中，llm_usage / mistakes 落地时同步更新了 lock manifest，
唯独 vfs 的 `V20260824__note_props.sql` 漏了；`cursor/0824-rel-vfs-cde6`
修复了第二个错误（补 Rust `MigrationDef` 注册），但**没有**触及
`migration-lock.json`，即使官方 cherry-pick 了 rel-vfs，门禁仍然红。

### 修复

本枝用规范流程 `node scripts/check-migrations.mjs --update` 重新生成
manifest，唯一变化是补上缺失的 vfs 条目（sha256 锁定，`dangers: []`——
裸的可空 `ADD COLUMN` 不触发任何静态危险规则；文件内 `@danger-ack`
注解已说明重跑收敛路径）。

### 验证

- 本枝单独：门禁从 2 个错误降到 1 个（剩余错误正是 rel-vfs 负责的
  `MigrationDef` 注册）。
- 本枝 + `origin/cursor/0824-rel-vfs-cde6` 合并演练（临时 worktree，
  未推送）：`check-migrations.mjs` 与 `check-migrations.mjs --base-ref
  v0.9.44`（对 tag 的不可变性 + 乱序校验）双双通过（111 个迁移文件）。

## 各项审计明细

### 2. vfs `V20260824__note_props.sql`（SKIP，rel-vfs 已覆盖）

执行机制核实：`MigrationCoordinator` 通过
`refinery::embed_migrations!("migrations/vfs")`（编译期目录嵌入）执行迁移，
静态 registry（`migration/vfs.rs` 的 `VFS_MIGRATIONS`）只用于迁移后契约
验证、`VFS_SCHEMA_VERSION` / `CURRENT_SCHEMA_VERSION` 常量推导，以及
**备份恢复的版本上限**。因此官方枝当前（未注册状态）的实际后果是
embed/registry 分叉：

- 运行时 embed 会执行 note_props，`refinery_schema_history` 头 = 20260824；
- registry 头停在 20260808 → `backup/mod.rs` 恢复兼容检查
  `backup_schema_version (20260824) > latest_version (20260808)` 直接
  `VersionIncompatible`——**应用拒绝恢复自己刚创建的备份**；
- `vfs/database.rs` 中 `CURRENT_SCHEMA_VERSION` 相关断言 / 单测同样失败。

以上均由 rel-vfs 的 `V20260824_NOTE_PROPS` 注册修复（连同 coordinator
pre-repair、NULL/{} 归一、CAS/LWW、搜索下推硬化），本枝不重复。
`repair_refinery_checksums` 按 embed runner 迭代，对"史册里有、registry
里没有"的版本不会 fail-close，已确认不构成额外升级失败路径。

### 3. llm_usage `V20260824__add_cache_write_tokens.sql`（SAFE）

注册（`llm_usage.rs` 头 20260824）、lock 条目、`CURRENT_SCHEMA_VERSION =
20260824` 三者一致；coordinator `pre_repair_llm_usage_schema` 显式收敛
"列已加但 history 未落盘"的中断态；列可空、NULL ≠ 0 读侧语义已由官方
`920dd665` 落地。旧库升级 = 单条 ADD COLUMN，重跑由 pre-repair 兜底。

### 4. mistakes `V20260824__normalize_anki_card_optional_json.sql`（SAFE）

注册 + lock 齐全；UPDATE 仅命中 NULL / 空串（`WHERE ... IS NULL OR
trim(...) = ''`），天然幂等，有效 `_qa_flags` / `_occlusion` payload
不受影响；`v0944_anki_library` 种子已进 migration-compat fixtures 回归。

### 5. main VFS missing-tables backfill（SAFE）

官方 `5f324e1f` 的 `apply_vfs_init_missing_tables` 只补建缺失表（跳过
V20260214 已删除的 `notes_versions`），并在 `V20260824` 已记账时恢复
`notes.props` 列，先于 `__change_log` 触发器重放，避免旧库
`no such table: main.questions`。

### 6. chat_v2（SAFE）

v0.9.44 → 头之间**无新增 chat_v2 SQL**；registry 头 20260806 =
`CURRENT_SCHEMA_VERSION` = lock 头，三方一致。

### 7. browser（SAFE，确认故意）

browser 目录仍只有 `V20260711__init.sql`，模块内独立
`embed_migrations!`（lock 锁定但豁免 MigrationDef 检查，符合门禁注释约定）。
`src-tauri/src/browser/` 自 v0.9.44 起**零代码变更**，没有任何读写方
期待 20260711 之后的列 / 表；`CURRENT_SCHEMA_VERSION = 20260711` 一致。
停版是故意的，升级安全。

### 8–10. 前端持久化（SAFE）

- finder / workbench(persistedSettings, windowStore, DockPinned) / composer
  persist 迁移属 Step 18 范畴；`normalizeRestoredComposerState` 已在
  `restoreActions.ts` 接管 v0.9.44 payload（缺键、退役的 rag/search/learn
  键、畸形导入），并有专测。
- `syncStatusStore` 新增 `dstu-auto-sync` persist：key 为净新增（v0.9.44
  无此 key），version 2 + `migrateAutoSyncPersisted` 对缺字段补默认值，
  不把 Partial 当完整快照。
- `desktopStore`（`learning-hub-desktop`）只新增 action
  （prune/restoreShortcuts），持久化形状未变。
- 其余自 tag 起新增的 localStorage 访问全部是净新增 key（onboarding 标志、
  权限预设、graph depth、epub 阅读状态、每日目标、pdf 资产地址）或对
  `essay_draft_*` 的清理性 removeItem，无旧数据换格式的读写分叉。

### 11. 云存储配置 SSOT（SAFE）

`resolveCloudStorageConfig` 以后端 settings 表（既有 KV 表，无需新迁移）
为唯一权威；localStorage 仅在后端未配置时参与一次性迁移（legacy key
`cloud_storage_config` → v2 → 后端），凭据先进安全存储再发布非敏感记录，
`cloud_storage_ssot_migrated_v1` 标志防止陈旧缓存复活已清除的配置。

### 12. DSTU 类型（SAFE）

TS `src/dstu/types.ts` 仅把模板文案改为 i18n getter（无序列化契约变化）；
Rust `src-tauri/src/dstu/types.rs` 自 v0.9.44 起无变更。
`metadata.props` 透传属 rel-vfs（见第 2 项）。

### 13. chat_v2 workspace DB（SAFE）

`workspace/database.rs` 的 `user_version = 2` 及迁移路径自 tag 起未变；
`custom_agents.rs` 的变更不含任何 DDL / 持久化格式变化。

## 给官方写手的合入提示

1. 本枝（lock 条目）与 `cursor/0824-rel-vfs-cde6`（MigrationDef 注册 +
   硬化）是同一个洞的两半，**需一起合入**，任一单独合入门禁仍红。
2. 两枝无文件交集（本枝只改 `migration-lock.json` + 本文档），
   cherry-pick 顺序无关，无冲突。
3. 审计期间官方本地已 cherry-pick rel-vfs 的注册硬化
   （`fix(vfs): harden note props release upgrade` 等）；对该状态实测
   `check-migrations.mjs` 只剩本枝负责的 1 个错误
   （`迁移文件未锁定: vfs/V20260824__note_props.sql`），合入本枝的
   lock 条目后门禁即绿。

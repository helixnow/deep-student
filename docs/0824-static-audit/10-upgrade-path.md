# 0824 相对 v0.9.44 / main 的升级路径静态审计

## 结论

**PASS（静态审计）**。0824 已具备从 `v0.9.44` 直接升级所需的持久化水合、数据库
补表/迁移中断修复、可空字段兼容、恢复 fail-closed、i18n 与旧加密仓库口令验证。
`main` tip `b2a85a69` 的相关 VFS backfill 已按单提交语义端口到 0824；**不要把
`b2a85a69` 所在 main 整支 merge 回 0824**。当前未发现需要产品修复的升级阻断项。

本轮不改代码（仅写本审计文档）。本结论是源码与既有回归契约审阅，不重复执行
Tauri/真实云端/私人数据库验证。

## 基线与合入策略

- `v0.9.44` 的精确核心 schema tuple 是
  `vfs=20260808 / chat_v2=20260806 / mistakes=20260724 /
  llm_usage=20260525`；仓库有 release-labelled fixture，并断言旧 usage 行升级后
  `cache_write_tokens IS NULL`（
  `src-tauri/tests/fixtures/migrations/manifest.json:137-152`）。
- Anki 另有同一 tuple 的可空 JSON fixture，断言空值归一化且 `_qa_flags`、
  `_occlusion` 原样保留（
  `src-tauri/tests/fixtures/migrations/manifest.json:156-172`）。
- `b2a85a69` 对应的 main 修复原本不在 0824 祖先链（
  `docs/dev/0824-rel-vfs.md:17-26`），但其缺表 backfill 已端口为 0824 的
  `5f324e1f`（`docs/0824-MERGE-PLAN.md:861-866`），现树实现见
  `src-tauri/src/data_governance/migration/coordinator.rs:2275-2289`。
  main 最终合入只需保留该语义超集；不要整支反向 merge，也不要再重放
  `3d3516c3`。

## Step 18：Finder / Workbench persist

- **Finder PASS**：只恢复 `viewMode/sortBy/sortOrder/quickAccessCollapsed`，
  逐字段校验枚举与类型；坏 JSON 回默认，新 host 桶可继承 v0.9.44 单例偏好（
  `src/features/learning-hub/stores/finderStore.ts:427-515`）。Zustand 二次水合也走
  同一白名单，不能把已拒值重新注入（
  `src/features/learning-hub/stores/finderStore.ts:1235-1249`）；旧单例、分桶优先级、
  损坏值与二次水合均有契约（
  `tests/vitest/learning-hub/finder-host-buckets.test.ts:185-264`）。
- **Workbench PASS**：壁纸只接受合法对象，模糊/暗度限幅；平铺边距逐字段回退并
  限制为 `0..32`（
  `src/features/workbench/core/persistedSettings.ts:31-75`）。启动读取和设置变更事件
  都经过解析器（
  `src/features/workbench/components/WorkbenchDesktop.tsx:306-344`），v0.9.44 合法值、
  损坏形状与越界值有回归（
  `tests/vitest/workbench/workbench-persisted-settings.test.ts:10-60`）。
- 同步附带的 Composer 旧状态也安全：保留字符串草稿，只接受现行 panel 的布尔值，
  丢弃退役 `rag/search/learn` 并补 `skill` 默认值（
  `src/features/chat/core/store/composerStateMigration.ts:16-35`；
  `src/features/chat/core/store/__tests__/composerStateMigration.test.ts:4-80`）。

## Step 19：数据库 backfill、NULL 语义、Anki、ZIP restore

### VFS backfill

- 稀疏旧库只要已有 `resources`，先从 V20260130 契约补缺表，再执行
  `ensure_change_log_table`，因此不会在 trigger 回放时报
  `no such table: main.questions`（
  `src-tauri/src/data_governance/migration/coordinator.rs:2275-2289`）。
- 回归实际构造仅含 `resources/notes` 的库，并断言 `questions` 先于
  `__change_log` 出现（
  `src-tauri/src/data_governance/migration/coordinator.rs:5794-5853`）。

### llm_usage：`cache_write_tokens` NULL≠0

- **必须保持 `cache_write_tokens` NULL≠0**：SQL 列可空，`NULL` 是“未测量”，
  `0` 是“已测量且未写缓存”，绝不能互相折叠（
  `src-tauri/migrations/llm_usage/V20260824__add_cache_write_tokens.sql:1-14`；
  `src-tauri/src/llm_usage/types.rs:171-179`）。
- 中断于 `ALTER` 已落盘/history 未写入时，coordinator 只在 predecessor
  V20260525 已记录且列已存在时补精确 history（
  `src-tauri/src/data_governance/migration/coordinator.rs:3815-3855`）；绕过
  coordinator 的直接 initializer 也有同样窄修复（
  `src-tauri/src/llm_usage/database.rs:485-569`）。
- Model2 按“字段存在”保留显式 0，缺字段才是 `None`（
  `src-tauri/src/llm_manager/model2_pipeline.rs:7720-7766`），并有
  `Some(0)` 对 `None` 回归（
  `src-tauri/src/llm_manager/model2_pipeline.rs:2716-2735`）。落库/回读也断言
  未测量必须为 NULL（`src-tauri/src/llm_usage/repo.rs:735-778`），前端类型以
  optional 表达同一语义（`src/api/llmUsageApi.ts:73-80`）。

### Anki 可空 metadata

- V20260824 只把 NULL/空串的 `tags_json`、`images_json`、
  `extra_fields_json` 分别归一为 `[]/[]/{}`；非空 payload 不改写（
  `src-tauri/migrations/mistakes/V20260824__normalize_anki_card_optional_json.sql:1-31`）。
- 读路径先按 `Option<String>` 取值再安全解析，旧库即使迁移前读取也不会因 NULL
  崩溃（`src-tauri/src/database/mod.rs:242-270`）。迁移定义明确幂等并进入
  mistakes schema head（
  `src-tauri/src/data_governance/migration/mistakes.rs:275-284,413-439`）。

### ZIP / 整槽恢复 fail-closed

- 后端先拒绝非完整快照、跳过资产和完整性失败，再进入替换阶段（
  `src-tauri/src/data_governance/commands_restore.rs:454-490`）；若 A/B
  `DataSpaceManager` 不可用，在磁盘预算、清槽和任何数据库写入前立即终止（
  `src-tauri/src/data_governance/commands_restore.rs:639-670`）。
- 云端 ZIP 导入后先检查 `recovery_kind/restorable`，再检查磁盘，最后才调用
  restore（`src/features/settings/components/CloudStorageSection.tsx:1089-1145`）。
  本地部分归档直接提示并且不弹误导性确认框（
  `tests/vitest/data-governance/r09-ux-backup-tab.test.tsx:202-236`）。

## Step 20：i18n / auto-sync / VFS props / schema / Chat / cloud

- **i18n PASS**：release 升级契约逐源码检查复用键，并要求 zh-CN/en-US 都存在且
  非空，同时禁止旧缺失键重新出现（`src/__tests__/releaseUpgradeI18n.test.ts:11-112,131-155`）。
- **auto-sync PASS**：旧/损坏持久化值逐字段迁移；坏 envelope 删除后以关闭状态、
  `15m` 默认档水合，运行时失败计数不持久化（
  `src/stores/syncStatusStore.ts:345-438,440-477`；
  `src/stores/__tests__/autoSyncStore.test.ts:360-415`）。
- **VFS `notes.props` PASS**：新增列可空且不回填，历史 note 的无属性状态仍是 SQL
  NULL（`src-tauri/migrations/vfs/V20260824__note_props.sql:1-21`）。
  显式 pre-repair 同时收敛“有 history 无列”和“有列无 history”，两者都缺时才交
  Refinery 正常执行（
  `src-tauri/src/data_governance/migration/coordinator.rs:2329-2375`）。
  v0.9.44 正常升级、中断重跑、反向 schema gap 均有回归（
  `src-tauri/src/data_governance/migration/coordinator.rs:5316-5390`）。
- **migration-lock PASS**：三个新迁移均已锁 hash：
  llm_usage（`src-tauri/migrations/migration-lock.json:268-274`）、
  mistakes/Anki（`:459-465`）、VFS note_props（`:940-946`）。
  CI 对 PR 使用 `--base-ref`，禁止已锁迁移被改写/删除（
  `scripts/check-migrations.mjs:3-24`；
  `.github/workflows/ci.yml:750-768`）。
- **Chat / GenUI 边界 PASS**：scoped HPIAS bridge 对缺失、非字符串、错
  `session_id` 一律拒收（
  `src/features/generative-ui/bridge/hpiasEventBridge.ts:96-121`；
  `tests/vitest/generative-ui/hpiasEventBridge.test.ts:36-62`）。
  `guardedListen` 仅精确放行 `hpias_event`，不放行相似名称（
  `src/utils/guardedListen.ts:26-47`；
  `tests/vitest/guardedListenAllowlist.test.ts:8-24`）；Rust ingress 仍只接受 18
  种 GenUI block（
  `src-tauri/src/chat_v2/tools/generative_ui_executor.rs:19-42,105-118`）。
- **无 marker 的 v0.9.44 旧加密仓库 PASS**：首次升级客户端不会直接用输入口令
  固化 v2 verifier，而是先下载并试解既有 DSBK 备份；历史明文 ZIP 才允许从此
  开启 E2EE（
  `src-tauri/src/cloud_storage/sync_manager.rs:640-672,738-816`）。
  错口令、损坏 marker、v2 缺 verifier 均在写任何备份对象前 fail-closed（
  `src-tauri/src/cloud_storage/sync_manager.rs:674-735`）。

## Step 21：移动端更多 i18n

- zh-CN/en-US 同时具备顶层 `common:more` 与 `common:actions.more`（
  `src/locales/zh-CN/common.json:78-148`；
  `src/locales/en-US/common.json:74-144`）。
- 附件面板继续使用已经翻译的顶层 `common:more`，没有回退到竞争性旧修法（
  `src/features/chat/components/input-bar/AttachmentPanelBody.tsx:151-164`）。
  契约扫描 InputBar/Composer/附件拆分文件的全部字面量命名空间键，要求两种
  locale 同时可解析，并单独锁定 more/close（
  `tests/vitest/mobile-uiux/inputBarSplitI18nKeys.contract.test.ts:22-34,70-112`）。

## 禁止回放与最终门禁

- 不重放已落地源 SHA：Step 18 的 `9176740b`/`0a6344e1`，Step 19 的
  `3d3516c3`/`c4a3382c`/`ef991061`/`e97b89ff`/`92c487f8`/`2ba5522d`；
  既有处置记录也明确禁止这些重放（
  `docs/0824-MERGE-PLAN.md:943-948`）。Step 20 的 13 个源提交、#177 已移植
  SHA、Step 21 的 `1901780e`/`8c7f8415` 同理均已落地，不再 replay；
  `2bfe7c31` 是明确禁整支 merge 的 VFS merge commit（
  `docs/0824-MERGE-PLAN.md:916-936,943-948,965-993`）。
- 合入 main 后应在最终合成树重跑 `check-migrations`（含 base-ref 不可变性）、
  v0.9.44 fixture upgrade、typecheck/build 与 Rust migration/restore 定向测试。
  0824 Step 21 终树已有四项门禁通过记录（
  `docs/0824-MERGE-PLAN.md:1000-1005`）；这属于最终落地主分支的重复确认，不是
  当前静态审计发现的修复项。

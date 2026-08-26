# 0824 静态审计 19：llm_usage `cache_write_tokens` 的 NULL≠0 契约

## 结论

**PASS（静态审计，附 5 条非阻断观察）**。`llm_usage` 迁移 V20260824 只含一条可空
`ADD COLUMN`，锁文件 SHA-256 实测一致；「NULL = 无测量 ≠ 0 = 测得未写入」契约在
三处 usage 解析器、两个生产 INSERT、三层记录 API、行级回读、报表脚本与 fixture
oracle 中全部闭环，且有针对 `Some(0)` vs `None` 的显式回归。V20260824 位于通用
兼容重放边界（V20260801）之后的「列已落盘、history 未记账」中间态，coordinator
与直连初始化器各有一份窄修复并有测试锚定。对照 v0.9.44 精确 schema tuple
（`llm_usage=20260525`）的 release-labelled fixture 断言旧行升级后保持 NULL、
列型 INTEGER、history 恰好一行。未发现需要产品修复的阻断项。

本轮不改代码（仅写本审计文档）。本轮未执行 cargo 测试与任何 git/gh 操作；
涉及 v0.9.44 旧二进制行为的部分以现树源码 + `docs/dev/0824-rel-llmusage.md`
的已归档分析为据，未重新 checkout 复核。

## 审计范围与基线

- 迁移本体：`src-tauri/migrations/llm_usage/V20260824__add_cache_write_tokens.sql`
- 基线：`v0.9.44`（tag `1cf6cabc`），其核心 schema tuple 为
  `vfs=20260808 / chat_v2=20260806 / mistakes=20260724 / llm_usage=20260525`
  （`src-tauri/tests/fixtures/migrations/manifest.json:140`、
  `docs/dev/0824-rel-llmusage.md:8-12`）。即 v0.9.44 的 `llm_usage_logs`
  没有 `cache_write_tokens` 列，V20260824 是该库唯一的增量。
- 交叉引用：`10-upgrade-path.md` 已从升级路径角度引用过本 fixture；本篇聚焦
  NULL≠0 语义链路本身的完整性。

## 1. 迁移本体与锁文件

- SQL 只有一条语句，列刻意不带 `NOT NULL`/`DEFAULT`：

```12:14:src-tauri/migrations/llm_usage/V20260824__add_cache_write_tokens.sql
-- 列可空：NULL = 无测量（适配器未上报该字段），不等于 0（真实测得未写入）。
-- 与 cached_tokens 的 NULL≠0 语义保持一致。
ALTER TABLE llm_usage_logs ADD COLUMN cache_write_tokens INTEGER;
```

- 锁文件记录 `dc7fc74c894296bb9d95d65975608104e7ca2c238e5c141b9bd757367cee6bc2`
  （`src-tauri/migrations/migration-lock.json:268-275`，`dangers: []`）；本轮对
  文件实测 `sha256sum` 结果一致，与 `docs/dev/0824-rel-llmusage.md:83-84` 的
  声明相符。
- 迁移定义带列存在性校验且不标 `idempotent`（重放会 duplicate column，正确交由
  §3 的修复路径处理）：`src-tauri/src/data_governance/migration/llm_usage.rs:140-145`；
  迁移集共 7 条、`latest_version()==20260824`，pending 序列有逐版本单测
  （同文件 166-174、229-272）。
- 同日 `vfs` V20260824（note_props）与 `mistakes` V20260824
  （normalize_anki_card_optional_json）与本迁移同版本号但各库 refinery history
  独立，互不冲突（`migration-lock.json:461-463、941-945`）。

## 2. NULL≠0 写侧链路（提取 → 记录 API → INSERT）

「字段存在即测量、显式 0 保留为 `Some(0)`、缺失才是 `None`」在三处解析器一致：

1. Chat V2 `parse_api_usage`：Anthropic `cache_creation_input_tokens`、Responses
   `input_tokens_details.cache_write_tokens`、网关顶层 `cache_write_tokens` 三源
   `max()` 归一、`min(u32::MAX)` 截断（
   `src-tauri/src/chat_v2/pipeline/llm_adapter.rs:127-153`）。回归：
   `src-tauri/src/chat_v2/pipeline_tests.rs:1576-1595`（`Some(0)` vs `None`）、
   `1546-1573`（网关重复格式取 max、纯写入场景）。
2. Provider 层 `build_usage_event`：同三源提取，JSON 输出里未测量落 `null` 而非
   0（`src-tauri/src/providers/mod.rs:3367-3389、3412-3413`）。回归：
   `providers/mod.rs:5935-5952`（观测到的 0 保留、缺失为 null）、
   `5914-5932`（Responses details 抬顶层）。Anthropic 流式的
   `message_start`/`message_delta` 字段级合并防止终态覆盖丢失缓存字段
   （`providers/mod.rs:2156-2172`，回归 `5858-5887`）。
3. Model2 `extract_usage_tokens`：返回五元组，第五元素即 cache_write
   （`src-tauri/src/llm_manager/model2_pipeline.rs:7733-7766`）。回归：
   `model2_pipeline.rs:2717-2736`（测得 0 → `Some(0)`，缺失 → `None`）。

记录 API 三层语义明确：`record_llm_usage` → `record_llm_usage_ext`（文档注明
「不携带缓存写入量，落库 NULL = 无测量」）→ `record_llm_usage_cache_ext`
（`src-tauri/src/llm_usage/mod.rs:109-198`，注释 144-145、180-182）。能拿到
测量的调用方均已走 cache_ext：Chat V2 成功轮与失败轮
（`src-tauri/src/chat_v2/pipeline/tool_loop.rs:1378-1395、1453-1461`）、Model2
流式非 chat_v2 上下文（`model2_pipeline.rs:5713-5739`）、Model2 raw-prompt
非流式（`7311-7336`）。仍走 ext 的调用方（`rag_extension.rs:1082、1240`、
`exam_engine.rs:698`、model2 两处解析失败分支 `7260、7282`）本身没有缓存测量，
落 NULL 语义正确。

落库两处 INSERT 都显式绑定 `Option<u32>` 至 `?12`，`None` 进 SQLite 即 NULL：
`src-tauri/src/llm_usage/repo.rs:43-77`（及事务版 146-183）、
`src-tauri/src/llm_usage/collector.rs:259-304`（293 行注释重申 ≠0）。类型层
`UsageRecord.cache_write_tokens: Option<u32>` 带契约注释与 builder
（`src-tauri/src/llm_usage/types.rs:175-179、284-288`）。

## 3. 迁移中断修复（列已落盘、history 缺失）

V20260824 晚于 `make_alter_columns_safe` 的通用重放冻结边界 V20260801，不能依赖
通用防御，因此有两份窄修复，判据相同且保守——仅当「V20260824 未记账 ∧ 前驱
V20260525 已记账 ∧ `cache_write_tokens` 列已存在」时按嵌入迁移的 name/checksum
补一行 history（迁移只此一条语句，列存在即 DDL 全部生效的充分证明）：

- coordinator 路径：`src-tauri/src/data_governance/migration/coordinator.rs:3841-3855`
  （函数头注释 3815-3821）；端到端回归
  `coordinator.rs:8240-8276`（`test_llm_usage_v20260824_recovers_column_without_history_and_reruns`）。
- 直连初始化器路径（测试与独立消费者不经 coordinator）：
  `src-tauri/src/llm_usage/database.rs:461-483`（`ensure_schema` 先修复再跑
  runner）、`490-570`（`repair_cache_write_migration_residue`）；回归
  `database.rs:639-691`：构造 V20260525 库 + 旧式 INSERT + 手工执行 ALTER 后
  直接 `LlmUsageDatabase::new`，断言 history 恰好一行且旧行读回 `None`。
- 幂等性：`database.rs:620-637`（重开重跑版本不变）；正常升级/重跑/降级/恢复
  四象限分析见 `docs/dev/0824-rel-llmusage.md:85-92`，与现树实现相符。

## 4. 读侧兼容

- 行级回读：`get_recent_usage_page` SELECT 列表含 `cache_write_tokens`（第 18
  列），映射回 `Option<u32>`，NULL 原样透出（`src-tauri/src/llm_usage/repo.rs:448-506`）。
  回归 `repo.rs:736-779`：measured `Some(250)` / unmeasured `None` 双向断言，
  含「无测量必须落 NULL 而不是 0」的显式消息。
- Agent 工具读路径：`llm_usage_executor` 的测试库同样应用 V20260824 后走
  `get_recent_usage_page`（`src-tauri/src/chat_v2/tools/llm_usage_executor.rs:785-796`）。
- 报表脚本：`scripts/cache-hit-report.py:70-78` 先探
  `pragma_table_info('llm_usage_logs')`，老库缺列时以 `NULL AS cache_write_tokens`
  占位，不崩溃；聚合层区分 measured/unmeasured，全 NULL 桶渲染「无测量」，
  显式 0 渲染 `0`（`107-150`）。脚本单测覆盖老库缺列、全 NULL、测得 0、
  token 加权 write/read 比、纯写入桶（`scripts/test_cache_hit_report.py:93-165`）。
- 前端类型：`src/api/llmUsageApi.ts:77-79` 声明
  `cacheWriteTokens?: number`，注释「Omitted means unmeasured; an explicit 0 is a
  measured no-write result」，与 Rust `skip_serializing_if = "Option::is_none"`
  的序列化行为对齐。
- 老式写入方（降级场景）：新列可空无默认，v0.9.44 风格的显式列名 INSERT 仍
  合法且新列得 NULL——由 §5 的生产 smoke 直接断言。

## 5. Fixture 与测试断言

release-labelled case `release_v0_9_44_llm_usage`
（`src-tauri/tests/fixtures/migrations/manifest.json:136-154`）：

- `schema_tuple` 钉死 v0.9.44 全部四库版本；seed 复用
  `seeds/partial_history_gap_20260523/llm_usage.sql`（该文件本就是
  `@ schema V20260525` 的旧式显式列 INSERT，无新列），manifest 以 SHA-256 锚定，
  哈希漂移会让 harness 显式失败（`migration_compat_tests.rs:179-193`）。
- 四条 oracle：旧行存活；`SELECT cache_write_tokens ... = "NULL"`；
  `pragma_table_info` 断言列型 INTEGER；history 恰有一行
  `version=20260824 AND name='add_cache_write_tokens'`（manifest 148-153）。
  `"NULL"` 字面量能精确命中 SQL NULL：oracle 执行器把 `Value::Null` 映射为字符
  串 `"NULL"`（`src-tauri/src/data_governance/migration_compat_tests.rs:395-404`、
  `629-649`），整数 0 会渲染成 `"0"`，因此该断言**能区分 NULL 与 0**，不是弱断言。
- 升级流水线附带：integrity/foreign_key check、history 与嵌入迁移集精确一致
  （版本/名称/checksum 非空非 "0"，`591-627`）、语义 schema snapshot 与
  fresh→HEAD 一致、幂等重跑、生产读写 smoke。smoke 用**不带新列**的旧式 INSERT
  写入后断言 `cache_write_tokens IS NULL`（「未携带新列的旧式 INSERT 必须保持
  NULL（无测量）」，`761-788`）——这同时覆盖了升级后旧写入方兼容与 NULL≠0。
- 集合层面回归清单：解析器 `Some(0)`/`None`（三处，§2）、collector 落库
  NULL（`collector.rs:749-783`）、repo 落库/回读（`repo.rs:736-779`）、中断
  修复（coordinator + 直连，§3）、幂等重跑（`database.rs:620-637`）、fixture
  oracle（本节）。链路上没有依赖「默认 0」的断言。

## 6. 对照 v0.9.44

- v0.9.44 的 `llm_usage` HEAD 是 V20260525（drop_daily_change_log_triggers），
  其 `llm_usage_logs` 的 `cached_tokens` 本就是可空 INTEGER、NULL=无测量
  （`src-tauri/migrations/llm_usage/V20260130__init.sql:43-44`）；V20260824 让
  `cache_write_tokens` 与之同构，契约陈述见迁移头注释与
  `docs/dev/0824-rel-llmusage.md:13-16`。
- 升级方向：fixture（§5）+ coordinator 端到端测试（§3）覆盖正常升级、中断
  残留、幂等重跑三态。
- 降级方向（新库回退 v0.9.44 二进制）：显式列名的读写不受多出的可空列影响；
  history 中多出的 20260824 行依赖旧二进制 refinery runner 的
  `set_abort_missing(false)` 容忍（现树直连初始化器即如此配置，
  `database.rs:469-472`）。`docs/dev/0824-rel-llmusage.md:89-91` 判定降级可用；
  本轮未 checkout v0.9.44 复核其 runner flags，记为已归档假设而非本轮实证。

## 7. 非阻断观察（本轮均不修）

1. **汇总 API 在聚合层抹掉 NULL≠0**：`get_usage_summary` 用
   `COALESCE(SUM(cached_tokens), 0)`（`src-tauri/src/llm_usage/repo.rs:347-348`），
   `UsageSummary` 也无 cache_write 字段（`types.rs:555-561`）。这是 V20260824
   之前就有的模式，且 write/read 报表刻意走原始行 + Python 脚本；仅当未来把
   write/read 比搬进应用内汇总时需要补 measured 位。
2. **`llm_usage_daily` 与 `DailySummary` 不聚合 cache_write**：日表无对应列
   （`V20260130__init.sql:106-116`），`DailySummary::accumulate` 不累计
   （`types.rs:400-410`）。与 1 同源，属刻意留白。
3. **chat 前端 `TokenUsage` 类型缺 `cacheWriteTokens` 声明**：Rust 侧
   `chat_v2::types::TokenUsage` 会以 camelCase 序列化该字段且 `add()` 正确
   累加（`src-tauri/src/chat_v2/types.rs:204-210、340-345`），但
   `src/features/chat/core/types/common.ts:339-347` 只声明到 `cachedTokens`。
   字段经 IPC 到达前端后处于未类型化状态；聊天 UI 目前不渲染它，无 NULL→0
   显示路径，风险仅是未来消费时的类型盲区（`llmUsageApi.ts` 一侧已补齐）。
4. **`LlmUsageDatabaseStats.schema_version` 硬编码**：`get_statistics` 返回
   常量 `CURRENT_SCHEMA_VERSION=20260824` 而非查 history（`database.rs:21-23、
   452-458`），注释已声明仅展示用；真实版本以 `get_schema_version()` 为准。
5. **直连修复器要求前驱 20260525 已记账**（`database.rs:533-541`）：history
   整体缺失的 legacy 库不在直连路径修复范围内——该形态由 coordinator 的
   legacy-baseline 流程负责（fixture case `legacy_20260130_first_epoch` 覆盖），
   保守判据合理，不视为缺口。

## 证据摘要

| 环节 | 位置 |
| --- | --- |
| 迁移 SQL + 契约注释 | `migrations/llm_usage/V20260824__add_cache_write_tokens.sql:12-14` |
| 锁文件（SHA 实测一致） | `migrations/migration-lock.json:268-275` |
| 迁移定义/序列单测 | `data_governance/migration/llm_usage.rs:140-145、229-272` |
| 三处解析器 Some(0) 回归 | `chat_v2/pipeline_tests.rs:1576-1595`；`providers/mod.rs:5935-5952`；`model2_pipeline.rs:2717-2736` |
| 写侧 INSERT | `llm_usage/repo.rs:43-77`；`llm_usage/collector.rs:259-304` |
| 记录 API 分层 | `llm_usage/mod.rs:109-198` |
| coordinator 修复 + 测试 | `migration/coordinator.rs:3841-3855、8240-8276` |
| 直连修复 + 测试 | `llm_usage/database.rs:490-570、639-691` |
| 行级回读 | `llm_usage/repo.rs:448-506、736-779` |
| 报表脚本缺列探测 | `scripts/cache-hit-report.py:70-78`；`scripts/test_cache_hit_report.py:93-122` |
| 前端可选契约 | `src/api/llmUsageApi.ts:77-79` |
| v0.9.44 fixture + oracle | `tests/fixtures/migrations/manifest.json:136-154`；`migration_compat_tests.rs:395-404、761-788` |

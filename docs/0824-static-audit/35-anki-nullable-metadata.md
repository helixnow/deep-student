model=gpt-5.6-sol-xhigh-fast
# 35 — Step 19 Anki 可空 metadata 读侧与迁移审计

## 结论

**WARN。**

对 `v0.9.44` 的直接升级链本身成立：Anki 并没有单独名为 `metadata` 的列，相关可空
元数据是 `anki_cards.tags_json`、`images_json`、`extra_fields_json`。新增的
V20260824 迁移会把历史 NULL/空白值归一为 `[]`、`[]`、`{}`，且不改写非空
`_qa_flags`、`_occlusion`；迁移已进入 mistakes head、声明幂等并有
`v0.9.44` schema tuple fixture。

但“读侧 + 迁移双重兼容”只能判为**部分成立**。卡库、Agent/CAS 和主要 FSRS 查询已
防御 NULL；仍有任务/文档/ID/最近卡片等高频读取把 `tags_json`、`images_json`
直接取成 `String`。迁移能修复升级当时已有的 NULL，却不能兜住迁移后由历史导入或
RowSync 再次写入的 NULL。因此 Step 19 的“`v0.9.44` 存量库可升级”可判 PASS，
“所有 Anki 读路径均可直接读取可空 metadata”不可判 PASS，整体记 **WARN**，需要
后续产品修复并补齐回归。

**本轮不改代码。**

## 1. `v0.9.44` 基线

- `src-tauri/tests/fixtures/migrations/manifest.json:156-165` 将
  `v0944_anki_library` 标为 `v0.9.44`，核心 schema tuple 中 mistakes head 为
  `20260724`，即尚未包含 V20260824 归一化迁移。
- 基础 schema 的三个字段只有默认值，没有 `NOT NULL`：
  `src-tauri/migrations/mistakes/V20260130__init.sql:180-195`。所以默认值并不阻止
  历史写手、导入或同步显式写入 SQL NULL。
- fixture 确实构造了一张三列均为 NULL 的卡片，并另放一张带 `_qa_flags`、
  `_occlusion` 的非空卡片（
  `src-tauri/tests/fixtures/migrations/seeds/v0944_anki_library/mistakes.sql:15-32`）。
- 该对照是通过历史迁移脚本和 seed 确定性重建的 `bootstrap_sql` fixture，不是真实
  发行版二进制数据库；harness 明确说明当前没有 `release_binary` fixture（
  `src-tauri/src/data_governance/migration_compat_tests.rs:9-16`）。它足以锁定 schema
  与目标数据形状，但不能替代私人真实卡库抽样。

## 2. 迁移侧：PASS

- `src-tauri/migrations/mistakes/V20260824__normalize_anki_card_optional_json.sql:11-21`
  仅将 NULL 或 `trim(...)=''` 的三列分别更新为 `[]`、`[]`、`{}`；非空 JSON
  不命中 UPDATE，因此有效扩展元数据不会被迁移重写。`:23-31` 还把历史可空的
  `source_type/source_id` 归一为空串。
- `src-tauri/src/data_governance/migration/mistakes.rs:275-284,413-439` 将迁移注册为
  `20260824 / normalize_anki_card_optional_json`、标记幂等，并放在 mistakes
  迁移集末尾；`:682-697` 锁定名称、幂等标记、关键 SQL 与 latest version。
- `src-tauri/migrations/migration-lock.json:459-465` 已锁定迁移路径和 SHA-256。
- `src-tauri/tests/fixtures/migrations/manifest.json:167-172` 的 oracle 断言 NULL
  三列升级后为 `[]/[]/{}`，同时 `_qa_flags` 与 `_occlusion` 的值仍在；兼容
  harness 会走生产 `MigrationCoordinator::run_all()`、校验 oracle、幂等重跑和
  重开连接（
  `src-tauri/src/data_governance/migration_compat_tests.rs:18-29,857-955`）。

边界：迁移不修复非空但损坏的 JSON，这是其“只补缺失值、不擅自改写 payload”的
刻意范围，不属于本项缺陷。

## 3. 读侧：已覆盖部分

- 公共卡片映射器把三列读取成 `Option<String>`，NULL 与坏 JSON 均降级为空集合（
  `src-tauri/src/database/mod.rs:242-270`）；Agent/卡库记录映射同样处理，并把空
  来源定位符折叠为 `None`（`:275-323`）。
- 这些映射器覆盖 session-owned 读取、单卡读取、CAS/删除冲突回读、重套模板及
  Agent 卡库分页（例如 `src-tauri/src/database/mod.rs:4994-5015,5077-5157,
  5263-5281,5407-5449,7597-7627`）。
- 普通卡库分页额外在 SQL 层 `COALESCE` 三列，并在 Rust 层继续按
  `Option<String>` 安全解析（`src-tauri/src/database/mod.rs:7705-7746`）。
- FSRS 入队快照、到期卡片和反馈回流查询在 SQL 层对三个 JSON 字段使用
  `COALESCE`（`src-tauri/src/fsrs_review_service.rs:1073-1158,1460-1492,
  1937-1958`）。
- 定向回归会在**已迁移数据库**中再次把三列强制置 NULL，验证普通卡库、Agent
  卡库与 FSRS enqueue 均能读成空集合（
  `src-tauri/src/database/mod.rs:8706-8778`）。这证明上述路径有迁移后的防御，
  但没有覆盖下面的遗留读取。

## 4. 读侧缺口：WARN

以下方法直接选择原始 `tags_json/images_json`，随后用
`row.get::<_, String>` 读取；SQL NULL 会在 JSON 解析前就产生 rusqlite 类型错误：

- `get_cards_for_task`（`src-tauri/src/database/mod.rs:4865-4914`）；
- `get_cards_for_document`（`:4917-4966`）；
- `get_cards_by_ids`（`:5018-5074`）；
- `get_recent_anki_cards`（`:7463-7505`）。

这不是冷门路径：文档读取被 ChatAnki 状态/保存链多处调用（
`src-tauri/src/chat_v2/tools/chatanki_executor.rs:2213-2217,5771-5774,
6070-6076`），三种导出选择分别走 ID、任务或文档读取（
`src-tauri/src/enhanced_anki_service.rs:867-885`），最近卡片读取则直接暴露为恢复
命令（`src-tauri/src/commands.rs:5712-5716`）。

另有一个较窄缺口：`FsrsReviewService::get_card_tags` 的变量虽然写成
`Option<String>`，但这是 `.optional()` 表示“无行”；闭包仍把列取成 `String`。
行存在而 `tags_json IS NULL` 时仍会报错，而不是按注释返回空数组（
`src-tauri/src/fsrs_review_service.rs:1903-1920`）。

风险不会被一次性迁移永久消除：`anki_cards` 三列 schema 仍可空，且该表属于
RowSync；`images_json/extra_fields_json` 采用行级 LWW（
`src-tauri/src/data_governance/sync/classification.rs:662-674`）。旧设备或外来行在
V20260824 已执行后到达时，不会自动重跑迁移。源码自己的公共映射器注释也明确把
historical/imported/synced NULL 视为需要读侧兼容的输入（
`src-tauri/src/database/mod.rs:242-247`）。

## 5. 后续产品修复建议

1. 让上述四个数据库读取统一复用 `map_anki_card_row`，或在 SELECT 中对
   `tags_json/images_json/extra_fields_json` 全部 `COALESCE`；修正
   `get_card_tags` 对“无行”和“列为 NULL”的区分。
2. 扩展现有 NULL 回归，至少覆盖任务、文档、ID、最近卡片、FSRS tags 五条路径，
   并保留迁移后再次注入 NULL 的场景，防止只靠一次性 backfill 获得假绿。
3. 保留 `v0.9.44` fixture 的迁移 oracle；如要把“真实发行版升级”提升为强保证，
   再补一份脱敏的 release-binary 卡库 fixture。

以上修复留待产品分支；**本轮不改代码**。

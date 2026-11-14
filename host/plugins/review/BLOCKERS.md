# L15 阻塞（2026-11-04 v2 接手）

## WP-159：insight_list 分页供方已在 main

2026-11-06 开工正常 merge 至 `b17264b88`，其包含 WP-158 `9f5a99787`。
已亲核 `memory/api.ts:8,12` 重导出的公开 `InsightCommandService`：
`listInsights(status: string | null, limit: IpcInteger, offset: IpcInteger)`。
F1 argsJson 精确解码及 F3 bigint 绑定也已在 main；本包无接口阻塞。
本域消费/证据见 SPEC 的 WP-159 节，GUI/F2精度仍归WP-135。

复用158测试时发现外域夹具冷启动问题：Electron job `20261105212144-1e4664`
本域新增3例通过，但 `memory/tests/insight-pagination.test.ts:27` 六例失败。
`memory/tests/fixtures/migrated-schema.ts:75` 冷builder返回完整MigrationReport，
`:55` 热cache返回success/error两字段；原测试toEqual两字段因额外字段失败，
实际迁移success=true/error=null。原始log在 `/home/dsdev/.oc-jobs/done/20261105212144-1e4664.log`。
已通知C1-app及L17，需L17统一夹具返回形状；未修改其断言或把热cache结果当冷路径修复。

## C1 SW 增量：anki_decks 写归 L16（旧稳定 ID 沿原报告，不另编号）

固定 SW 快照 `1c8239f67` / main `4525e11ac` / 规则 `6002c7fbd` 指出的两写点：
`repository/fsrs.ts` 默认 `INSERT OR IGNORE` 与配置 `UPDATE`。
接受 C2 的 L16 owner 裁定，不按 FSRS 业务归属主张整表写权限。

原核 main 与 L16 候选 `b5589fa3b` 缺本地同 conn 接口；L16 现已在
`474e38f29` 从 `anki/api.ts` 正式发布：
- `ensureDefaultFsrsDeckWithConn(conn, now)`；Rust fsrs_review_service.rs:1346–1353。
- `writeFsrsDeckConfigWithConn(conn, deckId, configJson, now)`；Rust :3634–3644 / :3680–3690。

L15 已消费两个同步函数，传原调用方 tx/conn；owner 不开启事务、
不换连接，保默认字段、INSERT OR IGNORE 不复活 deleted 行、UPDATE deleted 过滤、
SQL `local_version + 1`。owner 只抛底层 StorageError，L15 保留原 try/catch 与
JSON.stringify 位置、Database 前缀，已删除两处自写 SQL，无 fallback。

L16 API 已进 main（5b1b19055），L15 消费已重新应用。

`tests/deck-owner-transaction.test.ts` 预置生产命令回归：ensure 随后续 FSRS 写失败
回滚、ensure/config 同事务与错误前缀、已有字段/精确 SQL 版本/deleted 行不变。
先前单独绿只是原行为基线；消费后验证必须包含真实 L16 候选，最终仍待正常 main 独立复验。

> 2026-11-05：L16 `474e38f29` 已随联合合入 `5b1b19055` 进 main，77c4bef2a 已重新应用（cherry-pick 44c08e870），本项阻塞解除。

## R3：原接口阻塞已解除，5 条映射仍 pending

WP-053 恢复时只读核实 main `67295bdb5`：`git show main:host/plugins/anki/api.ts`
已含 `cards` / `documents`、`deleteAnkiCardForLibrary`、`listAnkiAgentLibraryCards`、
`listAnkiAgentLibraryPage` 及版本化 session CRUD。旧“未进 main”原因已过时。
本包仅交场景，不重映射原测试；下列 5 行仍需独立逐断言复核，不以接口存在代签。

保持 pending：
- `soft_deleted_card_is_hidden_from_agent_crud_and_fsrs`
- `soft_deleted_document_task_is_hidden_and_cannot_be_recovered_or_mutated`
- `chatanki_versioned_delete_cas_cleans_fsrs_without_cleanup_trigger_and_conflict_preserves_it`
- `legacy_null_anki_json_fields_do_not_break_library_reads_or_enqueue`（缺 agent page 原断言）
- `agent_library_delete_conflicts_when_user_rates_after_preflight`

## R4：事务消费已在 main，待完整链独立复核

本 lane 已发布 `cleanupCardDeletionInTx` / `cleanupTaskDeletionInTx` /
`cleanupDocumentDeletionInTx` / `enqueueImportedCardsInTx`（`api.ts:115-122`）。
WP-053 只读核 main `67295bdb5`：L16 `repository/anki-cards.ts:202,214,227` 已调用三个
cleanup 接缝，`src/apkg-import-persist.ts:194` 已调用 enqueue 接缝。旧“仍直接写 FSRS 表”
描述过时；本包的外层创建/删除语料仍未 A/B 重放，不以静态接线代替真实链验收。

## R5：原生训练器接口阻塞已解除（以下为历史记录）

WP-053 核实 main `67295bdb5` 的 `host/platform/native/fsrs/index.ts` 已实现
`optimize` / `evaluate`（`card_ids` 以精确十进制字符串传 WASM）；L15 已注册优化命令，
TESTMAP 两条 optimizer 行为 ported。旧 7 pending 实际已为 5，本包不修改 TESTMAP 表头。
动态训练差分仍需跨日历史语料，不把该项误报为 provider 缺失。

缺同一个预编译绑定中的 fsrs-rs **6.6.2 训练数学 + `card_ids: Some(card_ids)` +
evaluate**，以及数值验证。`host/platform/native/fsrs/api.ts` 的可选 `optimize?`
不是 provider；`index.ts` 没有训练/evaluate 实现。
`binding@0.6.0` 数学不等价；beta.2 无 cardIds。证据见 `native-needs.md:25-49`，
F7 2026-11-04 07:31Z 来信。`fsrs_optimize_parameters` 不注册；两 optimizer 测试
保留 pending，不安装包、不运行 Rust、不用近似替代。

2026-11-04 14:50Z 再核 nativeFsrs API/NEEDS，缺口仍在；已投递 F7 并 escalate
`2026-11-04T145048523Z-L15-review-analytics.md`。Rust 入口 `cmd/fsrs_review.rs:573`
只 spawn_blocking，无进度事件/取消入口；绑定还需 evaluate(log_loss, rmse_bins)，
且训练传 card_ids、enable_short_term、num_relearning_steps。未以挂名注册冲 A 级。

## 复核证据文件（已恢复）

旧记录“合并 main 后不存在 `host/plugins/review/ACCEPTANCE.md`”已过时：main 已含该文件
（`c5b295b33`、`f0e3af3ce`、`b572b9bcf`）。本 lane 仍不创建或修改验收报告。

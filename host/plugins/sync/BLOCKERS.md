# L20-sync · WP-004 阻塞与范围

- `mastery` 无发布阻塞：main `host/plugins/review/api.ts:68-70` 提供 `recomputeAllStatesWithConn(conn): number`、`syncAllLearnerProfiles(): number`；`review/index.ts:173` 只 inject storage。既有 `c2536fc6b` 已在 `sync/index.ts:88` 声明依赖。
- 旧 R4-SYNC-05 “缺 merger”已解除：main `host/plugins/memory/api.ts:60` 公开 `mergeProfileJsonForSync`。原测试保留 pending，剩余 L20 接线/向量映射按 brief 不在本包扩做。
- `openStartupDatabase` 已在 main `host/platform/storage/api.ts` 发布，startup 已接公共面；不重做 D18。
- 历史 `ca99bb4f9` 的19个 sync-providers 与1个 sync-support 文件曾被范围门禁拒绝（原文/清单及 `c0fb1512d` / base `b55af5d85` 旧证据见 WP-004 报告）。WP-179 窄恢复已依 C2 精确20路径决议正常 merge main `c60c4bf4d`，提交 `8216f80ca`；只对这20个冲突采用该 main 的已审 owner 内容，外域净 diff 已清零。
- owner 等待前置已解除：20/20 main blob 与 L23 `804ca52c3` / L20b `58f68140f` 相同，恢复后 tip 亦逐文件相同；证据 `/tmp/opencode/l20-wp179-recovery-evidence.json`。保留真实 review / throwing unused，未保留历史空 mastery stub。完整门禁及 main 集成仍以本次报告和 C2 回执为准。
- 历史 typecheck、boundaries、自有 sync 测试均 exit 0（jobs `20261105152132-e06761`、`20261105152132-4fc1c0`、`20261105152132-ac0744`；435 passed / 0 failed / 0 skipped）；这些原证据保留，不代替本次合并后的直接 lane-gate。
- WP-032 报告的“L20 公开面缺 `mergeField`”已由 WP-179 在本分支解除：`api.ts` 重导出 `src/field-merge.ts` 的同一 `mergeField(tableName, columnName, localValue: DbJson | undefined, remoteValue: DbJson | undefined, profileMerger?: LearnerProfileMerger | null): MergeResult`（`[value, wasMerged, isConflict]`，Rust `field_merge.rs:95`），并导出 `MergeResult` / `LearnerProfileMerger` 类型；未加入 `SyncService`。引用同一性与 index→apply-batch/apply-guard→mergeField 证据见 `tests/field-merge-api.test.ts`。L23 八条 pending 待其后续包经该出口移植；main 是否已含以协调者合入为准。
- WP-262（X7 G2“B 启动即有 sync_state.db”）：Rust 的 `SyncStateStore::open_default` 只在同步命令路径、启动期清理标记（lib.rs:1015-1021）和恢复激活标记（commands_restore.rs:144-189）下懒打开。B 的打开点是 L20b `host/plugins/sync-support/index.ts:51` 在插件 apply 时调用 `ctx.storage.database('sync_state')` 并建表（探针作业 `20261106042758-9d700f`）。L20 自己的 `startup.ts` 只在清理标记下打开，`index.ts` 只通过闭包取 state，都不是打开点。修复归 L20b（把 state 改为首次使用时再打开），L20 不改。
- TESTMAP 另一个 pending `file_and_snapshot_keys_are_neutral_ids` 留后续包核对活跃 blob manifest 断言；snapshot 子义已批准退休，不是缺 snapshot 实现。

自检、测试和最终交付状态见 `WP-004-REPORT.md`。

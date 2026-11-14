结论：部分完成，mastery 修复与自有验证完成，但集成范围门禁实际拒绝20个历史外域差异；最新 main 合并后仍需 C2/owner 组合。

## 提交与基线

- 开始工作树干净；并行测试进程存在，所有检查均走全局 jobs。
- 开始 `git merge --no-edit main` → `12463c9ec`（main `967f43c75`）。随后 main 更新导致首次 lane-gate exit 2，正常再次 merge → `4250709aa`（main `a49c10587`）。
- 既有注入修复：`c2536fc6b`，`host/plugins/sync/index.ts:88` 显式 inject mastery；`mutation-commands.ts:26` 与 index 的公开 apply 均获取该真实服务。
- 本包提交：`99593ca93`（协调者自动保存：五项真实集成测试与依赖文档）、`7c6d25541`（协调者自动保存：mastery 错误转换、SPEC/TESTMAP 证据）、`226c52e20`（LANE 更新）。自动检查点没有丢失改动，未改写历史。
- 报告初稿自动检查点 `1ae9c9563`；最后正常 merge main → `87cafbb7b`（main `1f3d621f0`，含真实 backup 依赖更新），随后提交测试临时目录的平台兼容修正并重新自检。最终提交/自检见交付附录。
- 业务改动仅 `repository/apply-databases.ts` 两个 mastery catch：Rust `AppError::Display`（`src-tauri/crates/dstu-core/src/models.rs:1038-1041`）只输出 message，真实 review 返回的 CommandError.value 为 AppError envelope，原 `.message` 是整份 JSON。现只在这两处提取 value.message，保留原前后缀、调用与事务顺序。

## 依赖实核

- `git show main:host/plugins/review/api.ts`：`recomputeAllStatesWithConn(conn): number`、`syncAllLearnerProfiles(): number` 已发布；`git show main:host/plugins/review/index.ts`：只 inject storage，无 sync↔review 硬依赖环。
- `git show main:host/platform/storage/api.ts`：openStartupDatabase 与多库 worker/文件公共接口均已发布；本包不重做 D18。
- `git show main:host/plugins/memory/api.ts`：第60行公开 mergeProfileJsonForSync。旧“缺 merger/待main”已更正为 L20 后续消费与原向量验证，本包不扩做该映射。

## 测试与原始证据

所有日志位于 `/home/dsdev/.oc-jobs/done/<job>.log`，对应 `.json` 保存命令、工作目录、退出码。自有测试无 skipped，无运行器 Errors 行；组合测试有20项 L23 既有 skipped，原样保留。

| 检查 | job | 结果 |
|---|---|---|
| 起点 typecheck:host | 20261105140223-f827cd | exit 0 |
| 起点 host/plugins/sync/ | 20261105140223-8db0a5 | 54 files / 430 passed / 0 failed / 0 skipped，exit 0 |
| 新增真实 mastery 集成，修复前 | 20261105140610-fecc37 | 3 passed / 2 failed / 0 skipped，exit 1；错误全文把 AppError JSON 拼进字符串 |
| 新增真实 mastery 集成，修复后 | 20261105141238-da18a2 | 5 passed / 0 failed / 0 skipped，exit 0 |
| typecheck:host（修复后） | 20261105141238-7ce39e | exit 0 |
| Electron：mastery-integration + shared-permit-ipc | 20261105141238-94abf6 | 2 files / 10 passed / 0 failed / 0 skipped，exit 0 |
| ledger --check --no-write | 20261105140951-da1753 | exit 0 |
| wiring --lane sync | 20261105140953-371a49 | exit 0，但有1条既有未接入警示 |
| boundaries:strict | 20261105140953-7c4e9a | 0 violation(s)，exit 0 |
| 组合 sync + sync-providers + sync-support | 20261105142411-2ec9c0 | 134 passed files / 1 skipped file；1517 passed / 0 failed / 20 skipped，exit 0（自有 sync 55 files / 435 passed） |

Node / Electron 原始摘要：

```text
 Test Files  54 passed (54)
      Tests  430 passed (430)
[作业 20261105140223-8db0a5] 退出码 0

 Test Files  1 failed (1)
      Tests  2 failed | 3 passed (5)
[作业 20261105140610-fecc37] 退出码 1

 Test Files  1 passed (1)
      Tests  5 passed (5)
[作业 20261105141238-da18a2] 退出码 0

 Test Files  2 passed (2)
      Tests  10 passed (10)
[作业 20261105141238-94abf6] 退出码 0
```

新增五项测试均在 `host/plugins/sync/tests/mastery-integration.test.ts`，安装真实 review、sync、backup 和真实 SQLite（直接执行四个原 mastery SQL 迁移）；仅 memory 扩展 sink 是观察/故障端口，mastery 没有 provide 替身：

1. `import_sync_data injects real mastery...`：IPC 默认策略导入3条证据，断言响应全部五字段、真实掌握度 total/wrongCount/streak/lastSignalAt、无本地待上传 echo、无事件；sink 看到已提交事件和非事务连接，许可可重新获取。
2. `public multi-database apply...`：公开 sync 服务插入后删除，真实 mastery 状态从1归零、score=0.5、lastSignalAt=null，profile remove 收到原概念。
3. `import_sync_data preserves rebuild error...`：真实 SQLite trigger 拒绝 mastery_states 写；IPC 精确错误与 Rust Display 一致；源事件已提交、聚合未写、许可释放。
4. `import_sync_data preserves profile error...`：画像扩展失败经真实 review 上抛；精确 IPC 前后缀，事件与聚合已提交，许可释放。
5. `import_sync_data keeps invalid-strategy...`：策略错误精确字符串、零事件落库、许可可重取，随后合法重试成功。

Rust 对应 `commands_sync.rs:2570-2753`、`commands_backup.rs:374-617`、`dstu-learning/src/mastery/service.rs:630-760`；重建位于 apply COMMIT 后，画像回流位于原连接释放后，不改成跨库/整段原子事务。

## 自检

首次 lane-gate 原文（exit 2，尚未创建检查 job）：

```text
分支没有包含最新的 main：先 git merge --no-edit main（解决冲突并提交）再自检——集成时就是对最新 main 合并后测试的。
```

重新合并 main 后自检 `4250709aa`：typecheck job `20261105142411-cbb102`、boundaries `20261105142411-818b36`、strict(changed) `20261105142411-e5e9e7`、importable `20261105142411-307e88`、tests `20261105142411-2ec9c0`，五项均 exit 0。lane-gate 总 exit 0；本版脚本未因 foreign diff 拒绝，不能据此宣称 ownership 组合已完成。

```text
L20-sync：自检 5 项（typecheck、boundaries、boundaries-strict(changed)、importable、tests），经作业队列执行……
✅ 自检全部通过（4250709aa，基线 main a49c10587）。可以标记完成，集成时会优先测试你的分支。
boundaries: scanned 25 files, 0 violation(s), 0 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
importable: ok
 Test Files  134 passed | 1 skipped (135)
      Tests  1517 passed | 20 skipped (1537)
```

最新 main 带来 backup 依赖变更，因此按协议再跑最终 lane-gate，结果在交付附录记录，不把前一基线结果当作最新组合结果。

## ledger / wiring / strict 原始输出

```text
ledger: commands 1058 (A 100% B 0% C 0%), tests 8109 (A 90% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 15 (unknown 3673, not vetoed)

sync                   ported  256  未接入    1  state.test.ts×1
合计 ported 256，其中所测模块未从 index.ts 接入 1（0.4%）

boundaries: scanned 3035 files, 0 violation(s), 231 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
```

ledger 全仓所有命令 A=100%，包含本 lane 24/24；B=0%，本 lane 无独立 ACCEPTANCE，不自行签收 B。脚本登记不等于完整同步功能验收。

strict 本 lane 原始行：

```text
(allowed) host/plugins/sync/repository/apply-refcounts.ts:256:7 [empty-catch]
(allowed) host/plugins/sync/repository/apply-shared.ts:110:5 [empty-catch]
(allowed) host/plugins/sync/repository/apply-shared.ts:141:5 [empty-catch]
(allowed) host/plugins/sync/repository/conflict-resolver.ts:87:7 [empty-catch]
(allowed) host/plugins/sync/repository/deletion-queues.ts:30:7 [empty-catch]
(allowed) host/plugins/sync/repository/sqlite-values.ts:327:7 [empty-catch]
(allowed) host/plugins/sync/repository/workspace-files.ts:11:3 [empty-catch]
(allowed) host/plugins/sync/repository/workspace-files.ts:22:5 [empty-catch]
(allowed) host/plugins/sync/repository/workspace-files.ts:35:5 [empty-catch]
(allowed) host/plugins/sync/repository/workspace-files.ts:38:5 [empty-catch]
(allowed) host/plugins/sync/src/asset-sync.ts:126:7 [empty-catch]
(allowed) host/plugins/sync/src/blob-sync.ts:103:3 [empty-catch]
(allowed) host/plugins/sync/src/blob-sync.ts:150:7 [empty-catch]
(allowed) host/plugins/sync/src/download-changes.ts:48:3 [empty-catch]
(allowed) host/plugins/sync/src/download-changes.ts:152:5 [empty-catch]
(allowed) host/plugins/sync/src/file-transfer.ts:24:3 [empty-catch]
(allowed) host/plugins/sync/src/manifest-upload.ts:88:5 [empty-catch]
(allowed) host/plugins/sync/src/manifest-upload.ts:166:3 [empty-catch]
(allowed) host/plugins/sync/src/manifest-upload.ts:171:5 [empty-catch]
(allowed) host/plugins/sync/src/prune-gap.ts:34:9 [empty-catch]
(allowed) host/plugins/sync/src/transfer-commands.ts:84:9 [empty-catch]
(allowed) host/plugins/sync/src/transfer-commands.ts:100:9 [empty-catch]
(allowed) host/plugins/sync/src/transfer-commands.ts:215:5 [empty-catch]
(allowed) host/plugins/sync/src/upload-changes.ts:107:7 [empty-catch]
(allowed) host/plugins/sync/src/workspace-sync.ts:38:3 [empty-catch]
(allowed) host/plugins/sync/src/workspace-sync.ts:171:7 [empty-catch]
```

## TESTMAP 前后计数与未完成

- pending **2 → 2**；ported **256 → 256**；merged **0 → 0**；approved obsolete **5 → 5**；总数263。本包没有去向列改动，新增测试为补充集成证据，不冒用 Rust 测试 ID。
- `crates/dstu-sync/src/data_governance/sync/mod.rs::tests::file_and_snapshot_keys_are_neutral_ids`（L13778）：后续包核对活跃 blob manifest 断言；snapshot 子义已按 D8 退休，不申请新 obsolete，不实现死路径。
- `src/sync_app_tests.rs::field_merge_app_tests::regression_j8c_resources_data_merges_learner_profiles`（L13）：main API 已公开，剩余 L20 消费/原向量验证按 brief 留后续包。
- wiring 既有警示：`state.rs::tests::tombstone_sequence_waits_for_writer_before_reading` → `sync/tests/state.test.ts:24` 直接调用本目录 `repository/state.ts`，非生产 syncSupport owner；本包未改去向或该用例，需后续工作包按真实 owner 与 Rust writer 握手复核。不能把 wiring exit 0 称作全部接入。

## 历史 foreign diff 交 C2 组合

以下20路径来自既有 `ca99bb4f9`，本包未编辑/回退。集成范围门禁已实际以“拒绝合入，改动超出范围：”拒绝下列全部路径。L23 WP-010 / L20b WP-011 的正式修复采用真实 review / throwing unused，与旧空对象并非相同文本；更正此前“merge main 即自动消去”的假设，必须由 C2/owner 组合保留 owner 版本。

```text
host/plugins/sync-providers/tests/adversarial_sync.test.ts
host/plugins/sync-providers/tests/business_tables_sync.test.ts
host/plugins/sync-providers/tests/chaos_sync.test.ts
host/plugins/sync-providers/tests/cloud_mark_scenarios_sync.test.ts
host/plugins/sync-providers/tests/comprehensive_sync.test.ts
host/plugins/sync-providers/tests/delete_hardening_sync.test.ts
host/plugins/sync-providers/tests/hardening_sync.test.ts
host/plugins/sync-providers/tests/integration_deep_sync.test.ts
host/plugins/sync-providers/tests/pathological_pragma_sync.test.ts
host/plugins/sync-providers/tests/pathological_sync.test.ts
host/plugins/sync-providers/tests/proptest_sync.test.ts
host/plugins/sync-providers/tests/real_flow_smoke_sync.test.ts
host/plugins/sync-providers/tests/real_schema_sync.test.ts
host/plugins/sync-providers/tests/realistic_scenarios_sync.test.ts
host/plugins/sync-providers/tests/realistic_sync_harness.ts
host/plugins/sync-providers/tests/regression_sync.test.ts
host/plugins/sync-providers/tests/scenarios_sync.test.ts
host/plugins/sync-providers/tests/weird_batch_sync.test.ts
host/plugins/sync-providers/tests/weird_sync.test.ts
host/plugins/sync-support/tests/service-host.ts
```

供抽检：① `mastery-integration.test.ts` 的 SQLite 重建失败（精确错误、提交边界、许可）；② 同文件公开多库 apply 的远端删除（真实 owner 归零与 profile remove）。无新增 API/依赖，无 Rust 执行，无 X1/外域文件改动。

## 协调者指令1：范围拒绝后的复核（2026-11-05）

- 开始 HEAD `7b8b23fe7`，工作树干净。执行 `git merge --no-edit main` 得 `c0fb1512d`，基线 `b55af5d85`；没有冲突，也未手动编辑外域文件。
- `git diff --name-only main HEAD -- host/plugins/sync-providers host/plugins/sync-support` 仍列出上方20个路径。`git merge-base --is-ancestor <owner-sha> main` 确认 WP-010 的 `8f9ed7788`、`d686dfcc0` 与 WP-011 的 `80db0f00b`、`d1faceeba` 尚未进入 main。
- 已通过 coord queue 向 C2-platform 投递精确 owner 提交及差异说明：先合 owner，再组合 L20；不为消除历史范围差异越权回退或改写历史。WP-010 还登记了新 `delete_resolve_sync.test.ts` / `quarantine_replay_sync.test.ts` 的 mastery 宿主接线需求，归 owner 后继包。
- 按本次反馈指定的三个命令通过 jobs 重跑，未修改实现或测试：

```text
[作业 20261105152132-e06761] npm run typecheck:host
[作业 20261105152132-e06761] 退出码 0

boundaries: scanned 3042 files, 0 violation(s), 220 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
[作业 20261105152132-4fc1c0] npm run migration:boundaries
[作业 20261105152132-4fc1c0] 退出码 0

 Test Files  55 passed (55)
      Tests  435 passed (435)
[作业 20261105152132-ac0744] npx vitest run -c vitest.host.config.ts host/plugins/sync/
[作业 20261105152132-ac0744] 退出码 0
```

- 自有测试 failed 0 / skipped 0 / 无 Errors。TESTMAP 未改，pending 2 → 2；ported 256 / merged 0 / approved obsolete 5。
- 上文两次 lane-gate 通过只对应所记录 tip/base，不代表本次范围拒绝已解除。本次按协调者要求复跑三项，没有以重复全量自检替代 ownership 修复。需要 C2/owner 完成允许路径之外的组合后才能重新接纳；本包不声称已合 main 或全绿。

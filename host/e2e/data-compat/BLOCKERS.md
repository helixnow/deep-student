# X3-data-compat 阻塞与历史记录

## WP-116 恢复核对（2026-11-06 UTC）

本包 seed 供给无阻塞。前会话正式 selfgate `da1f23e39` 已通过：tests `20261105195049-6fca48`
71 passed / 0 failed / 0 skipped，typecheck 与普通/严格边界均 exit 0（审计报告列全作业号）。
main 新增 `scripts/electron-migration/record/scenario-v0.mjs:38-55` 的 `prepareScenarioRun`，
已按 `scenario.seed` 调用 resolveSeed/copySeed，并设副本 HOME/XDG；下文“runner 不解析 seed”是旧基线记录。
后续由 X7/L15/L24 接入真实工具调用和 A1/A2/B 录制；X7 `WP-043-runtime-blockers.md:3-7,14-17`
仍记录缺 PDFium、无 A binary。此项不阻塞 SQL seed 交付，也不构成业务 CAS 或资格恢复证据。

WP-044 比对器独立验收 12 passed，job `20261105160805-7e4ed6` exit 0，无 Errors。
CLI 两条实际 Node 入口验收 job `20261105161500-ecc220` 同样通过，exit 0，无 Errors。
本包基线 job `20261105155554-826f3d` 38 passed / 1 failed / 0 skipped，Errors 0，exit 1，
下面同一原失败仍在；整体组合 gate 由 C2 管理，L05 WP-063 修复后再用原断言签收。
X7 可先消费 `SCENARIO-V0.md` 的 API。真实 A 发布 seed 等 WP-043 后续接入；本包仅 SQL 构造。

最终 gate 子测试 `20261105163939-5acb94`：52 passed / 1 failed / 0 skipped，Errors 0，exit 1，
同一 X3-L05-02；typecheck `20261105163939-d7d6ac` exit 0。父 gate `20261105163025-e1de5e`
最终 128/SIGTERM；普通/严格边界 `20261105163939-974465` / `20261105163939-28916f`
随后均 exit 0、0 violation。四子项均有原件，不再记录为仍排队；无正式成功 selfgate。

## WP-116 初版记录（恢复时已由上节更新）

- `l15-review-cas-tombstone-w0` 已就绪，同一阻塞：runner 不解析 `scenario.seed`（X7）。L15/L24 新增引用该 seed 的场景须等 runner 支持；
  X3 不改 L15/L24 语料。字段归属更正：reviewVersion 是 `COALESCE(fsrs_card_states.local_version,0)`，不是独立列。

## WP-115 更新

- X3-L05-02 不再复现：合并 main（含 L05 WP-063 `33e266809`）后，原测试未改，全目录基线 job `20261105182339-e61a0e`
  60 passed / 0 failed / 0 skipped，exit 0，`workspace: persisted unread inbox is restored…` 通过。正式组合签收仍归 C2。
- `l22-temp-sessions-w0` 与 `skill-zip-v0` 同一阻塞：runner 不解析 `scenario.seed`（X7）。L22 场景仍在 `pending-seed/`，
  移到顶层由 L22 在 runner 支持后进行；seed 名未改，场景字段无需改。

## WP-094：`skill-zip-v0` 无法被当前 runner 消费（blocked，owner X7）

- 文件已就绪：`createSeed('skill-zip-v0', catalog)` → `<seed>/home/w0-zip-seeds/*.zip`，列表见 `SCENARIO-V0.md`。
- v0 场景没有引用 seed 目录的占位符；`scripts/electron-migration/record/replay.mjs:15-24` 只复制
  `fixtures/db/<scenario.snapshot>` 并只传 `dataDir`，不解析 `scenario.seed`、不设置 HOME。
- 解除条件：X7 runner 支持 `scenario.seed` → `copySeed`，并对两端设 HOME=`<副本>/home`（或经 C2 批准的
  seed 路径占位符）；随后 L07 新增 `zipPath: "~/w0-zip-seeds/<文件>"` 的场景。X3 不改 runner/v0 格式/L07 语料。

## X3-L05-02（已由 L05 WP-063 解除，以下为历史记录）：旧 workspace 的 unread inbox 未恢复到实际使用的队列

- owner：L05-agent-workspace。首次复现基线 main `967f43c75`。
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/workspace/coordinator.rs:994-1011,1059-1066` 恢复的 `inbox_manager` 同时交给 router 和 WorkspaceInstance；`:586-605` 明确旧库 lazy-load 后 peek 可见 unread 项。
- Host：`host/plugins/agent-workspace/src/workspace/coordinator.ts:576-584` 恢复局部 `inboxManager`，随后 `buildInstance()` 的 `:545-550` 创建另一空队列，丢弃恢复结果。
- 复现：`owner-databases.test.ts` 用历史 Rust V1 SQL 建 `workspaces/ws_ws_old.db`，保留一条 inbox。真实 F3 + WorkspaceCoordinator 升级后 `pendingInboxCount=1`，`peekInbox=[]`，预期为原完整消息。不是 SQL 行丢失，也不是缺接口。
- 队列作业 `20261105142528-6d4c3d`：3 passed / 1 failed / 0 skipped，Errors 0，exit 1。初次发现作业 `20261105142007-f209ef`。
- 最终 gate tests `20261105150116-3326d4`（代码 tip `0b6c7bbd8`）：全目录 38 passed / 1 failed / 0 skipped，Errors 0，exit 1，同一回归仍失败。门禁其他三子项均通过；父 gate 因共享执行器重启中断，详见审计报告。
- 解除条件：L05 使 loadInstance 返回的实例和 router 共享已恢复队列；main 合入后原断言通过且重复 peek 不改变任何旧行。本 lane 仅提交回归，未改业务实现。
- 其他证据：audit 与 sync_state 的 owner 初始化/升级、重开幂等，以及 workspace V1→V2 的全列保留独立用例均已通过。

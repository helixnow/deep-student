# L22-app-commands：集成测试与命令收口

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L22-app-commands（集成测试与命令收口） |
| 目录 | `host/plugins/integration/` |
| Rust 范围（lanes.md） | tests/ 的跨域 e2e 与 ACL、tests/sync_r1x_*、commands.rs 收口 |
| 主要提供 | — |
| 主要消费 | 全部 |
| 特别注意 | 对 50 个前端调用但 Rust 未定义的命令，复现 Tauri 的"command not found"；对 292 个前端未调用的命令做 dead-proven 审计 |
| 规模（本目录） | 25771 行 · 40 个文件 · 0 个命令（前端调用 0） · 243 个测试 |
| 规模（整条 lane，inventory） | 25771 行 · 40 个文件 · 0 个命令（前端 0） · 243 个测试 |
| 契约 | [`contracts/ipc/L22-app-commands.json`](../../../contracts/ipc/L22-app-commands.json)（F5 尚未生成，生成后 `npm run migration:scaffold -- --refresh` 更新本表） |
| 服务草稿 | [`contracts/services/DRAFT-L22-app-commands.md`](../../../contracts/services/DRAFT-L22-app-commands.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/src/cmd/helpers.rs` | 17 | 0 |  |
| `src-tauri/src/cmd/mod.rs` | 30 | 0 |  |
| `src-tauri/src/commands.rs` | 8760 | 30 |  |
| `src-tauri/tests/app_command_acl.rs` | 82 | 1 |  |
| `src-tauri/tests/dstu_canvas_executor_e2e.rs` | 452 | 0 |  |
| `src-tauri/tests/generative_ui_executor_e2e.rs` | 633 | 10 |  |
| `src-tauri/tests/mod.rs` | 35 | 1 |  |
| `src-tauri/tests/phase5_tool_execution_e2e.rs` | 814 | 0 |  |
| `src-tauri/tests/phase7_system_executor_e2e.rs` | 433 | 0 |  |
| `src-tauri/tests/phase8_9_executor_e2e.rs` | 601 | 0 |  |
| `src-tauri/tests/session_executor_e2e.rs` | 295 | 0 |  |
| `src-tauri/tests/sync_r10_android.rs` | 531 | 11 |  |
| `src-tauri/tests/sync_r10_chaos_clock.rs` | 361 | 4 |  |
| `src-tauri/tests/sync_r10_chaos_idempotent.rs` | 392 | 3 |  |
| `src-tauri/tests/sync_r10_chaos_lease.rs` | 147 | 2 |  |
| `src-tauri/tests/sync_r10_chaos_mixed_e2ee.rs` | 376 | 4 |  |
| `src-tauri/tests/sync_r10_chaos_truncation.rs` | 347 | 3 |  |
| `src-tauri/tests/sync_r10_download.rs` | 518 | 6 |  |
| `src-tauri/tests/sync_r10_protocol_locks.rs` | 251 | 6 |  |
| `src-tauri/tests/sync_r10_provider_contract.rs` | 309 | 4 |  |
| `src-tauri/tests/sync_r10_verifier.rs` | 478 | 10 |  |
| `src-tauri/tests/sync_r11_autosync.rs` | 310 | 6 |  |
| `src-tauri/tests/sync_r11_history.rs` | 806 | 9 |  |
| `src-tauri/tests/sync_r11_lease.rs` | 407 | 8 |  |
| `src-tauri/tests/sync_r11_repo_check.rs` | 628 | 11 |  |
| `src-tauri/tests/sync_r12_backup_lease.rs` | 497 | 7 |  |
| `src-tauri/tests/sync_r12_conflict_fast_path.rs` | 326 | 2 |  |
| `src-tauri/tests/sync_r12_decoded_dead.rs` | 121 | 3 |  |
| `src-tauri/tests/sync_r12_delta_format.rs` | 356 | 15 |  |
| `src-tauri/tests/sync_r12_delta_gc.rs` | 1071 | 9 |  |
| `src-tauri/tests/sync_r12_delta_inventory.rs` | 471 | 7 |  |
| `src-tauri/tests/sync_r12_delta_restore.rs` | 1070 | 12 |  |
| `src-tauri/tests/sync_r12_delta_upload.rs` | 918 | 11 |  |
| `src-tauri/tests/sync_r12_neutral_names.rs` | 380 | 7 |  |
| `src-tauri/tests/sync_r12_record_path_names.rs` | 460 | 7 |  |
| `src-tauri/tests/sync_r12_v1_marker_trust.rs` | 528 | 8 |  |
| `src-tauri/tests/sync_r13_migration_change_log_propagation.rs` | 373 | 3 |  |
| `src-tauri/tests/tool_pack_integration_tests.rs` | 839 | 14 |  |
| `src-tauri/tests/tools_integration_tests.rs` | 257 | 8 |  |
| `src-tauri/tests/windows_shell_helper_e2e.rs` | 91 | 1 |  |

### 命令（0）

本目录没有 `#[tauri::command]`；职责是向其他插件提供服务（见服务草稿）。

### 发出的事件（4）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `csv_import_progress` | 字面量 | src/commands.rs:1757 (emit) |
| `mistake_status_update` | 字面量 | src/commands.rs:969 (emit)<br>src/commands.rs:999 (emit) |
| `qbank://changed` | 字面量 | src/commands.rs:1378 (emit)<br>src/commands.rs:1446 (emit)<br>src/commands.rs:1523 (emit)<br>src/commands.rs:1569 (emit)<br>src/commands.rs:1605 (emit)<br>src/commands.rs:1626 (emit) |
| `question_import_progress` | 字面量 | src/commands.rs:1186 (emit)<br>src/commands.rs:1324 (emit) |
<!-- END GENERATED:lane -->

## 备注

## v2 接手盘点（2026-11-04，新负责人 GPT-6.1 Sol）

恢复基线 `4e90cf5e8`，已 merge 正常 main `2ee9a9cbe`；未从头移植。
本目录没有 `ACCEPTANCE.md`、原先也没有 `BLOCKERS.md`；不能据此自签独立验收。
以下是自查，不把旧 wiring 的 155/0 当作 v2 行为等价证明。

| 命令 / 模块 | v2 问题类型 | 自查结论与证据（接手时行号） |
|---|---|---|
| IPC 命令 | 1.1 接线 | `index.ts:8` 命令为空，inventory 为 0；不补那 50 个 Rust 未定义命令。`tests/command-surface.test.ts` 经 kernel invoke 核验 ACL。 |
| `appCommandState.activeDatabase` | 1.1 / 1.2 | `index.ts:9,13` 真正提供；F3 `storage/index.ts:179` 动态消费，不要求平台 inject 业务插件（D2）。仅内存字段，无 SQL。 |
| `appCommandState.withTempSessions` / `modifyTempSession` | 1.2 / 1.3 | Map 值为完整 StreamContext；`modifyTempSession` 按 `commands.rs:248-285` 回读/持久化（`repository/temp-sessions.ts` + `src/stream-context.ts`），见 SPEC。`temp_sessions` 单写者归属待 C2 改判（BLOCKERS）。 |
| `appCommandState` 错误与日志 | 1.4 | Rust `commands.rs:185-200` 无日志；TS `src/app-state.ts:13-16` 非法日期异常属于内部类型前置条件。`SPEC.md:91` 所称 Promise 会抛错不属实，需更正文档，不凭空发明 Rust 错误。 |
| 缓存驱逐测试 | 1.5 / 1.6 | `tests/app-state.test.ts:34-55` 只有每例一个集合断言；虽表达了结果，未逐条对应 Rust `commands.rs:5989-6040` 的长度/成员断言，需补齐而不删除原断言。 |
| 缓存排序/生命周期 | 1.7 | `src/app-state.ts:14,27` 用共享纳秒解析和 UTF-8 字节序；`tests/app-state.test.ts:59-87` 纳秒与卸载覆盖。继续核对相等时刻/非 ASCII 排序。无网络、计时或取消任务。 |
| L20 / L23 生产集成 | 1.1 / 1.5 / 1.7 | 基线 job `20261104093123-fa00f4` exit 1：9 文件失败、27 用例失败、33 未执行，根因均为旧 paths 夹具缺 `dataSpaceDeviceId`。L22 自有夹具改用真实 paths；L20 `tests/test-db.ts:38`、`host-fixture.ts:23` 的过期夹具不能在本 lane 修改。 |
| 跨 lane 访问与断言类型 | 1.2 / 1.3 | `tests/sync-history-behavior.test.ts:3-10,68-95` 仍直接 import 仓储、`as never` 构造变化；改用已发布 SyncService 方法和 EngineChange 类型。测试建表仅隔离 fixture，不是生产越权写表。 |
| fast-path / history 已交付（WP-114） | 1.5 / 1.8 | main `4dc4c8ed9` `sync/index.ts:219-221` 已注册两个写命令；`tests/sync-conflict-fast-path.test.ts`、`tests/sync-history-e2e.test.ts` 走真实 F3 storage、L21 备份许可、L20 冲突守卫与命令表，竞争窗口用 worker 线程第二连接复现。TESTMAP 4 行 ported。 |
| 其他跨 lane pending / 复核闭环 | 1.6 / 1.8 | 31 行逐项见 `REPORT.md:248-357`，新 `BLOCKERS.md` 记录当前符号与 owner。无本 lane 独立 finding ID，先修自查项；所有自查修复仍待独立复验，不自行改 ACCEPTANCE。 |

处理顺序：先修测试装配退化并跑最小失败集；再补缓存逐断言证据、纠正文档；
逐项重新查阅 31 条 pending（Codex 2 条已解除，现 29 条） 的 main 公开面。只有真实 API 发布后才恢复/移植，不用替身
冒充被测业务。类型检查基线 job `20261104093122-e85a17` exit 0。

### 当前真实跨 lane 阻塞

详见 `BLOCKERS.md`：L20 4 条命令注册待 main、L13/C1 9 条 generative UI、L06 14 条
tool pack、L19 1 条错误详情、L05 1 条 Windows helper。L02 2 条 Codex OAuth 已于 2026-11-04 解除并移植
（`tests/llm-codex-connection.test.ts`，经 `test_api_connection` + 真实 L01/L02）。
另有本次 merge 暴露的 L20 测试装配缺失，不把它伪装成 Linux 不支持 SQLite。

### R1 补审（`ACCEPTANCE.md`，R1 提交 `bf6479dc8`）处理

- R1-IN-01 表头失真：`TESTMAP.md:12` 手工更正为逐行实数 merged 4 / obsolete 53 / pending 29 /
  ported 157（只改本 lane 生成区块的计数行，未跑全仓 `scaffold --refresh`）。
- Codex 2 条：已按真实公共入口 `test_api_connection`（真实 L01 + L02）移植，旧“L01 认证 API
  未发布”描述已从 LANE/BLOCKERS/REPORT 删除（`3c76312fd`）。其余 29 条 pending 的当前
  owner 证据见 `BLOCKERS.md`。
- SPEC Promise 回调声明：`3b657447c` 已改为“API 约定，实现不检测”，未新增锁框架。

### v2 排雷清单：X6 报告 `0119143715`（源码 `2ee9a9cbe`；PR=0 AP=21 LP=4，report-only）

逐条按语义对照 Rust，不为计数补 expect：

| ID | 结论 | 处理 |
|---|---|---|
| X6-AP-0233 | 真遗漏：`before` 取在驱逐之后 | `7c8ac2eef` 改为临界区内驱逐前取键（commands.rs:5987-5991） |
| X6-AP-0234/0235/0236 | 旧快照；`3b657447c` 已逐条补齐 | 不重复修 |
| X6-AP-0237 | Rust 断言 `ErrorKind::InvalidData`/`PermissionDenied`；F3 `data-space.ts:180-188` 只抛普通 `Error`，无 kind | TS 已断言精确文案；kind 区分属 F3 生产缺口，不在测试里伪造 |
| X6-AP-0238 | 真遗漏：缺 <500ms、明文拒绝、逐字节快照（原比对键集合） | `296638cc0`/`7c8ac2eef` 补齐（sync_r10_verifier.rs:303-326） |
| X6-AP-0239/0240 | 真遗漏：Rust 同时锁后端 busy 文案/try_acquire 与引擎“未配置加密密码” | 补 `sync/src/run-sync.ts`、`payload.ts`、`file-transfer.ts` 源码锁 |
| X6-AP-0241/0242/0243 | 等价：`toEqual([0,8])` 覆盖 len+元素；两个 `if Ok` 臂合为一个循环 | 无改动 |
| X6-AP-0244..0249 | 真遗漏：源码锁只测了 WebDAV 键 | 新增 `tests/delta-source-scan.ts`，按 Rust 锁定 sync_manager 整 ZIP、生产引用集合（api.ts re-export 对应 `pub mod`）、模块文档与无写/删 |
| X6-AP-0250/0251 | 真遗漏：版本数=1、`version.id`；前置无 backups/ 对象 | 已补 |
| X6-AP-0252 | 真遗漏：`error` 为空、`usage.elapsed_ms` | 已补 |
| X6-AP-0253 | `host/kernel/tests/error-details.test.ts` 属 kernel，非 L22 文件 | 不修改，归 kernel owner |
| X6-LP-0142..0145 | commands.rs 的 18 warn!/26 error! 属其他 lane 的命令；L22 切片（:170-240）只有 `remove_temp_session` 的 1 条 `error!`，属未交付的 DB 持久层 | 已在 SPEC 作未勾选缺口，不补假日志 |

定向复验：job `20261104130405-839561`（4 文件 / 43 用例）exit 0。

### 已完成（2026-11-04 续派自查）

后续新增任务（架构师转 L18）：临时会话 `modifyTempSession` 的 DB 回读/持久化面。
2026-11-04 已交付（api.ts 服务 1.1.0；`tests/temp-session-modify.test.ts` 8 条，job
`20261104150720-4609ab` 15/15 exit 0）。Rust 中该表唯一调用方是 commands.rs，故仓储放在本
lane；`temp_sessions` 单写者归属改判请求见 BLOCKERS。

标准 v2 §1 自查 `src/app-state.ts` / `index.ts` / `api.ts`：
- 1.7 发现并修复：回调抛错时跳过驱逐导致超 cap（`bebf02f02`，新增回归用例；job
  `20261104134257-3717ec` 7/7 exit 0）。
- 1.1 `appCommandState` 由 `index.ts` provide；`activeDatabase` 生产消费方为 F3
  `platform/storage/index.ts:198-267`。`withTempSessions` 暂无生产消费方，对应 SPEC 中未勾选的
  StreamContext 持久层缺口（F3 仓储未发布）。
- 1.2 本插件无 SQL 写入；1.3 无 IPC/持久化入站结构（命令 0 条）；1.4 唯一相关 `error!`
  属持久层缺口（见 X6-LP）。
阻塞复查（main `16a254adf`）：L20 两命令、L13 executor、L06 execute、L19 details、L05 helper 均仍未在 main。

### 无剩余工作（2026-11-04）

`lane-gate.mjs` 自检全部通过（`fbfe0c612`，基线 main `d84e29565`：typecheck、boundaries、
boundaries-strict(changed)、importable、tests）。TESTMAP 157 ported / 4 merged / 53 obsolete /
29 pending；29 条全部依赖其他 owner 尚未进入 main 的公开入口（`BLOCKERS.md`）：L20 2 个命令
（候选 `340e81ada`）、L13 `GenerativeUiExecutor`（候选 `ds-mig/L13-vfs-api` `c986d4aaf`）、
L06 `ToolPackExecutor.execute`、L19 `call_tool_with_details`、L05 Windows helper 入口。
本 lane 范围内没有可在不替身被测对象的前提下继续移植的测试；任一入口进入 main 后再恢复。

## 既有拆分说明（历史记录，以下进度须结合 v2 盘点）

AppState 拆分接口见 `api.ts::APP_STATE_OWNERS`（逐字段对应 `commands.rs:681-719`）。
只保留 `ctx.appCommandState` 的活动数据库标识和临时会话内存；数据库、业务服务和各域取消表
由所属 lane 提供，消费者使用其 `api.ts` + Cordis inject，不构造聚合服务或复制共享实例。
`withTempSessions` 回调必须同步（等价持有 Rust Mutex 的临界区），不得返回 Promise。
临时会话持久层：`modifyTempSession` 回读/持久化（见 SPEC），DB 是完整数据源。
`DailyActivityDetails` / `LearningActivity` 直接复用生成的 L14 wire 类型。默认适配器选项的
JSON 投影由 L16 anki 的真实实现与测试持有（`host/plugins/anki/src/model-adapters.ts`），
本 lane 不再复制一份“供命令 owner 复用”的实现。

`commands.rs` 的模板规则与连接探活纯函数分别由 L16 anki、L02 llm 的生产实现持有；
本 lane 曾在 `src/template-rules.ts` / `src/provider-probe.ts` / `src/model-adapters.ts`
复制过同批逻辑，质量自查时已删除（见 `REPORT.md` §5）。L22 只保留 `ctx.appCommandState`。

初始工作树没有根 `AGENTS.md`，按全局注入纪律操作。L22 没有 IPC 命令，故没有生成的
`contracts/ipc/L22-app-commands.json` / `generated/L22-app-commands.ts`；不自行造契约。

## 命令收口审计（`audit/commands.json`，由 `tests/command-audit.mjs` 生成）

- 50 个前端 invoke 但 Rust 未定义的命令名：`audit.undefinedCommands`，逐名断言 debug
  `"<cmd> not allowed. Command not found"`、release `"Command <cmd> not allowed by ACL"`，
  并断言不在任何 `contracts/ipc/*.json` 中（`tests/command-surface.test.ts`）。
- 292 个 `frontend: "none"` 定义（290 个不同命令名）：全部记录定义点、`generate_handler!`
  注册点、cfg、生产/测试 Rust 引用、生产/测试/demo 前端字符串引用。**没有一个**被标为
  `approvedDead`；`approvals.json` 的 `deadProven` 仍为空。
- 审计发现 inventory 的 `frontend` 列只识别字面量 `invoke('cmd')`：143 个被标为
  `none` 的命令名以字符串形式出现在前端命令表/包装器里（例如 `src/features/browser/browserApi.ts`
  的包装 invoke），不能当作死命令。115 个仍是候选，需协调者按 cfg/动态调用复核后批准。
- 审计是保守的名字级证据（命令名全局唯一假设），不做类型解析；`limitation` 字段已写明。

## 未完成测试的真实阻塞（按 owner）

下表中的 pending 测试文件虽然由本 lane 拥有，但**被测对象**位于其他 lane 的 Rust 模块
（`crates/dstu-sync`、`crates/dstu-mcp`、`crates/dstu-agent`、`crates/dstu-storage`、
`crates/dstu-vfs` 等），这些模块在 Host 侧尚未发布实现，或已发布但缺少命令注册。
用测试替身替换被测对象会让测试只验证替身，不能作为迁移证据；本 lane 也不重写他们的算法。
TESTMAP 保持 pending 并在最终报告记录证据。

`commands.rs` 的 30 个测试中，8 个模板规则测试已由 L16 anki 的
`tests/templates.test.ts` 迁移，3 个探活测试已由 L02 llm 的
`tests/connection_test.test.ts` 迁移，13 个端点/字段/ASR/探活体测试由本 lane
`tests/llm-probe-helpers.test.ts` 直接调用 L02 生产实现迁移（含 Qwen/MiMo 方言 2 条），
4 个 `temp_session_cap` 测试在本 lane 的 `tests/app-state.test.ts` 按真实
`ctx.appCommandState` 路径迁移；2 个 Codex OAuth 测试在 L02 删除固定 throw、改用 L01
`llmCodexAuth` 后移植到 `tests/llm-codex-connection.test.ts`：谓词
`isOpenaiCodexOauthTest` 仍私有，测试经生产命令 `test_api_connection` 观察其结果
（true → 本地 Codex responses 端点 + OAuth 令牌；false → apiBase + 请求密钥）。
`cmd/helpers.rs` 只有两个无测试的委托/路径函数，其中 `sanitize_file_path` 直接委托 F3 的
`sanitize_for_legacy`。
`tests/app_command_acl.rs` 已用 kernel 的 `CapabilityAcl.fromDirectory` 和真实
`src-tauri/capabilities` / `permissions` 移植到 `tests/app-command-acl.test.ts`，覆盖
remote/local × browser/main 四种调用来源；不再需要 F1 补 ACL 建模。

| 测试文件 | 条数 | 阻塞点 |
|---|---|---|
| `tests/sync_r12_conflict_fast_path.rs`、`tests/sync_r11_history.rs`、`tests/sync_r10_protocol_locks.rs`（P2-3） | 4 | **已解除（WP-114，2026-11-06）**：main `4dc4c8ed9` `host/plugins/sync/index.ts:219-221` 真实注册 `data_governance_resolve_record_conflict` / `data_governance_rollback_sync_snapshot_batch`；4 行 ported 到 `tests/sync-conflict-fast-path.test.ts` / `tests/sync-history-e2e.test.ts`。原阻塞证据（作业 `20261104074740-f10f19`，`Command not found`）只对旧基线 `2ee9a9cbe` 成立。 |
| `tests/generative_ui_executor_e2e.rs` | 9 | 属 **L13/C1** 的 generative UI 执行主链（不是 L04）；`host/plugins/agent-skills/api.ts` 只有 skills/MCP/workshop 执行器，main 的 `host/kernel/agent-roster.ts` 仅列名称；L13 候选已实现但未进 main：分支 `ds-mig/L13-vfs-api`（tip `acb015f93`，实现提交 `c986d4aaf`）的 `host/plugins/vfs/src/tools/generative-ui.ts:105-111` 有 `GenerativeUiExecutor.execute`，`vfs/index.ts:202` 经 `agentTools.registerToolExecutors` 注册；main 上无该实现。候选合入 main 后按真实注册入口移植。依赖的 L06/L10/L18/L19 chat_v2/VFS/notes/media 服务未发布 |
| `tests/tool_pack_integration_tests.rs` | 14 | L06 只发布 `tool-pack.ts` 常量/admission（无 `ToolPackExecutor.execute`）；L19 `AgentToolExecutorRegistry` 是普通执行器注册表，不是 Rust 的并发/取消/超时/聚合语义；L07 `registerToolExecutors` 不能替代 |
| `tests/tools_integration_tests.rs` | 1 | 仅 `test_tool_error_details_generation`：Host `ToolRegistry.callTool` 返回 6 元组，没有 Rust 的 `call_tool_with_details` / `ToolNotFound` details；F4 `ErrorDetailsBuilder.tool_not_found` 已存在但 L19 registry 未接。其余 3 条已移植到 `tests/tools-registry.test.ts` |
| `tests/windows_shell_helper_e2e.rs` | 1 | L05 已在 `src/tools/shell-sandbox-windows.ts` 实现 `payloadRoot`/`readWindowsPayload`/`HELPER_ARG`，但尚未从 `host/plugins/agent-workspace/api.ts` 导出；L22 不能 import 其他 lane 的 `src/`。Electron 主进程也没有接线 helper 入口，无法复现 `CARGO_BIN_EXE_deep-student` 子进程 e2e |

合计：**pending 29** = 4 条 L20 命令 wiring + 9 条 L13/C1 generative UI executor
+ 14 条 L06 tool pack + 1 条 L19 tool error details + 1 条 L05 Windows helper。
另有 **53 条 obsolete 已获批准并写入 approvals**：4 条 mobile-only + 49 条 delta
（43 条行为测试 + 6 条 inventory）。delta 零接线审计与证据见
`OBSOLETE-REQUEST-delta.md`；5 条 source-lock 保留 `ported`。
**157 条 ported + 4 条 merged** 已可在 vitest 报告中验证（Linux 本机 29 个文件 / 269 个
用例全部通过）。原 source-lock/事务锁用例已按协调者批复迁到 TS 侧：
`tests/frontend-source-locks.test.ts`（5）、`tests/sync-r12-locks.test.ts`（8）、
`tests/restart-ordering.test.ts`（1）；`tests/sync-conflict-fast-path.test.ts` 的
2 条已于 WP-114 恢复为 live 用例（L20 命令已在 main `4dc4c8ed9` 注册）。

`tests/sync_r10_protocol_locks.rs::r01_p2_filename_length_is_clamped_fail_closed` 已并入
L20 的 `host/plugins/sync/tests/asset-filenames.test.ts::segment_and_total_path_limits_fail_closed_without_truncation`：
两条测试都断言超长文件名段与完整资产 key 总长在编码阶段 fail-closed、不截断；L20 实现已迁移。
TESTMAP 记 `merged:`。`sync_r10_android.rs` 的 2 条切槽租约测试已对照 F3 的
`DataSpaceManager` 移植到 `tests/data-space-cutover.test.ts`；
content:// 入队 persist 测试由本 lane `tests/android-saf.test.ts` 直接移植
（`queuePersistableSafUri` / `persistableSafQueueFile`，3 条断言），F3
`unified-file-manager.test.ts` 保留更强的同函数覆盖。

另有 5 个本 lane 的 `harness = false` e2e 二进制（`dstu_canvas_executor_e2e`、
`session_executor_e2e`、`phase5_tool_execution_e2e`、`phase7_system_executor_e2e`、
`phase8_9_executor_e2e`）没有 `#[test]` 注册，inventory/TESTMAP 均为 0 行；它们实际断言
L04/L06/L10/L13/L18/L19 的 executor，同样因这些服务未发布而无法迁移。Rust 侧用 `fn main`
手工运行并打印测试结果，`cargo test` 不会把它们计入测试数。

2026-11-04 在 Linux 工作树重新验证 `npm run migration:ledger -- --check --no-write`
（job `20261104080004-aa9e0b`，退出码 0，全局与 L22 均 0 条 problem）。4 条 mobile-only
+ 49 条 delta 审批已写入 approvals，因此本 lane 当前 A = **212/243 = 87.2%**
（155 ported + 4 merged + 53 obsolete）；其余 31 条 pending 全部有上述跨 lane 缺失符号
证据，不伪造替身迁移。本 lane 自身测试文件中的 A 级用例在
`npx vitest run -c vitest.host.config.ts host/plugins/integration` 中全部通过
（job `20261104080004-ada020`，29 文件 / 269 用例，退出码 0）；merged 目标由目标 lane
的测试套件覆盖。
2026-11-04 最新 merge main 为 `14c53a53d`（含 L20/L21/L19 公开面）。按协调者归属：
L20 4 条命令 wiring、L13/C1 9 条 generative UI、L06 14 条 tool pack、L19 1 条错误详情、
L05 1 条 Windows helper（L01/L02 2 条 Codex OAuth 已移植）。delta format/upload/restore/GC 的
43 条行为测试 + 6 条 inventory 已获批准 `obsolete:dead-in-rust experimental`
（21 ported + 14 merged + 8 pending 全部转入），5 条 source-lock 保留 ported；
未接线 delta 不进入生产。

## Rust 契约问题与语义歧义（只记录，不在本 lane 修改 Rust）

1. **`qbank://changed` 存在两种互不兼容的载荷**：五处是 `{exam_id, reason}`，但
   `qbank_update_material`（`commands.rs:1442-1449`）发 `{reason:"material_updated", material_id}`，
   没有 `exam_id`。前端监听器若统一读 `exam_id`，材料更新事件会拿到 `undefined`。已写入
   `SPEC.md` 事件节；迁移时必须保留该形状，除非协调者决定修 Rust 契约。
2. **`rename_exam_sheet_session` 的 `None` 语义与注释相反**：`commands.rs:991-992` 注释说
   “None 表示不改名”，代码却 `unwrap_or_default()` 成 `Some("")` 传给服务；服务以
   `exam_name.is_some()` 判断是否改名、空串表示清空（`dstu-vision/src/exam_sheet_service.rs:334,791-795`）。
   因此请求缺省 `exam_name` 会清空名称，而不是保持原名。未改 Rust，交 L18/协调者确认。
3. **inventory 的 `frontend` 列只匹配字面量 `invoke('cmd')`**：143 个标为 `none` 的命令实际
   出现在前端命令表/包装器（如 `src/features/browser/browserApi.ts`），不能据此判死。
4. **任务文本的 292 与实时 inventory 不一致**：当前 inventory 有 1066 个定义，其中
   `frontend:"none"` 294 个定义、290 个不同命令名；测试不再硬编码数量，改为与实时集合比对。
5. **50 个“前端调用但未定义”包含测试专用调用**：`write` 仅出现在
   `src/features/notes/noteHostCoordinator.lease.test.ts`；生产包装器中的例子有
   `fix_database_schema`、`get_storage_info`、`cleanup_orphaned_images`。ACL 复现对两者都成立，
   但“生产前端 bug”数量应小于 50。

# L07-agent-skills-ptc：技能、PTC、MCP 工具

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L07-agent-skills-ptc（技能、PTC、MCP 工具） |
| 目录 | `host/plugins/agent-skills/` |
| Rust 范围（lanes.md） | skill_*、skill_taps，以及 ptc、mcp_*、connector、fetch、canvas、workbench 工具 |
| 主要提供 | `agentSkills`、`agentTools` 注册表 |
| 主要消费 | F7 starlark、L19 |
| 特别注意 | PTC 走 starlark wasm；fetch 的 SSRF 校验顺序 |
| 规模（本目录） | 32040 行 · 27 个文件 · 22 个命令（前端调用 17） · 351 个测试 |
| 规模（整条 lane，inventory） | 32040 行 · 27 个文件 · 22 个命令（前端 17） · 351 个测试 |
| 契约 | [`contracts/ipc/L07-agent-skills-ptc.json`](../../../contracts/ipc/L07-agent-skills-ptc.json) |
| 服务草稿 | [`contracts/services/DRAFT-L07-agent-skills-ptc.md`](../../../contracts/services/DRAFT-L07-agent-skills-ptc.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-agent/src/chat_v2/skill_market_client.rs` | 2354 | 20 | 4 |
| `src-tauri/crates/dstu-agent/src/chat_v2/skill_replay.rs` | 2538 | 22 | 4 |
| `src-tauri/crates/dstu-agent/src/chat_v2/skill_requires.rs` | 914 | 13 | 1 |
| `src-tauri/crates/dstu-agent/src/chat_v2/skill_taps.rs` | 1086 | 8 | 2 |
| `src-tauri/crates/dstu-agent/src/chat_v2/skill_updates.rs` | 643 | 5 | 2 |
| `src-tauri/crates/dstu-agent/src/chat_v2/skill_usage.rs` | 2149 | 20 | 1 |
| `src-tauri/crates/dstu-agent/src/chat_v2/skills.rs` | 3331 | 43 | 7 |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/canvas_tools.rs` | 910 | 11 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/connector_executor.rs` | 2019 | 21 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/fetch_executor.rs` | 2143 | 27 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/general_executor.rs` | 301 | 3 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/injector.rs` | 104 | 3 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/legacy_tool_provider.rs` | 221 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/llm_usage_executor.rs` | 1083 | 7 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/mcp_content_materializer.rs` | 744 | 6 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/mcp_manage_executor.rs` | 1326 | 18 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/mcp_propose_executor.rs` | 1037 | 14 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/mcp_settings_store.rs` | 141 | 2 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/ptc_executor.rs` | 1157 | 15 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/ptc_runtime.rs` | 1843 | 33 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_install_executor.rs` | 624 | 7 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_lifecycle_executor.rs` | 776 | 5 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/skill_workshop_executor.rs` | 1632 | 13 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/skills_executor.rs` | 916 | 8 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs` | 1033 | 16 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/workbench_executor.rs` | 985 | 11 |  |
| `src-tauri/src/chat_v2/skill_taps.rs` | 30 | 0 | 1 |

### 命令（22）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `chat_v2_list_skill_candidates` | `crates/dstu-agent/src/chat_v2/skill_replay.rs:1263` | async | none | — | (status?: string \| null, limit?: integer(u32) \| null) → SkillCandidateSummary[] ! string |
| `chat_v2_promote_skill_candidate` | `crates/dstu-agent/src/chat_v2/skill_replay.rs:1308` | async | none | — | (candidateId: string) → SkillCandidatePromotion ! string |
| `chat_v2_record_skill_activation` | `crates/dstu-agent/src/chat_v2/skill_usage.rs:1101` | async | none | — | (skillId: string, sessionId?: string \| null) → null ! string |
| `chat_v2_replay_skill_candidate` | `crates/dstu-agent/src/chat_v2/skill_replay.rs:1287` | async | none | — | (candidateId: string) → ReplayReport ! string |
| `chat_v2_rollback_skill_candidate` | `crates/dstu-agent/src/chat_v2/skill_replay.rs:1331` | async | none | — | (candidateId: string) → SkillCandidateRollback ! string |
| `skill_check_updates` | `crates/dstu-agent/src/chat_v2/skill_updates.rs:354` | async | app | src/features/chat/skills/api.ts:305 | (skillIds?: string[] \| null) → SkillUpdateCheckResult[] ! string |
| `skill_create` | `crates/dstu-agent/src/chat_v2/skills.rs:646` | async | app | src/features/chat/skills/api.ts:91 | (basePath: string, skillId: string, content: string) → SkillFileContent ! string |
| `skill_delete` | `crates/dstu-agent/src/chat_v2/skills.rs:796` | async | app | src/features/chat/skills/api.ts:117 | (path: string) → null ! string |
| `skill_export_tap` | `src/chat_v2/skill_taps.rs:17` | async | app | src/features/chat/skills/api.ts:204 | (skillIds: string[], destPath: string) → TapExportResult ! string |
| `skill_import_zip` | `crates/dstu-agent/src/chat_v2/skills.rs:2320` | async | app | src/components/skills-management/SkillsManagementPage.tsx:856<br>src/components/skills-management/SkillsManagementPage.tsx:900 | (zipPath: string, basePath: string, overwrite: boolean, dryRun?: boolean \| null) → SkillImportZipResult ! string |
| `skill_list_directories` | `crates/dstu-agent/src/chat_v2/skills.rs:370` | async | app | src/features/chat/skills/api.ts:61<br>src/features/chat/skills/loader.ts:172 | (path: string) → SkillDirectoryEntry[] ! string |
| `skill_list_package_files` | `crates/dstu-agent/src/chat_v2/skills.rs:565` | async | app | src/features/chat/skills/api.ts:81<br>src/features/chat/skills/loader.ts:132 | (path: string) → SkillPackageFileEntry[] ! string |
| `skill_market_download_and_scan` | `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1277` | async | app | src/features/chat/skills/api.ts:430 | (slug: string, version?: string \| null, install?: boolean \| null, overwrite?: boolean \| null, expectedPackageSha256?: string \| null, tempZipPath?: string \| null, declaredRiskLevel?: string \| null) → SkillMarketDownloadScanResult ! string |
| `skill_market_search` | `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1196` | async | app | src/features/chat/skills/api.ts:396 | (q?: string \| null, limit?: integer(u32) \| null, nonSuspiciousOnly?: boolean \| null, sort?: string \| null) → SkillMarketSearchResponse ! string |
| `skill_market_skill_detail` | `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1237` | async | app | src/features/chat/skills/api.ts:405 | (slug: string) → SkillMarketSkillDetail ! string |
| `skill_market_verify` | `crates/dstu-agent/src/chat_v2/skill_market_client.rs:1252` | async | app | src/features/chat/skills/api.ts:412 | (slug: string, version?: string \| null) → SkillMarketVerifyResult ! string |
| `skill_probe_requires` | `crates/dstu-agent/src/chat_v2/skill_requires.rs:87` | async | app | src/features/chat/skills/requiresGating.ts:58 | (bins?: string[] \| null, env?: string[] \| null, pythonPackages?: string[] \| null) → SkillRequiresProbe |
| `skill_read_file` | `crates/dstu-agent/src/chat_v2/skills.rs:595` | async | app | src/features/chat/skills/api.ts:71<br>src/features/chat/skills/loader.ts:188<br>src/features/chat/skills/loader.ts:440 | (path: string) → SkillFileContent ! string |
| `skill_tap_catalog` | `crates/dstu-agent/src/chat_v2/skill_taps.rs:462` | async | app | src/features/chat/skills/api.ts:168 | (repoUrl: string) → TapCatalog ! string |
| `skill_tap_install` | `crates/dstu-agent/src/chat_v2/skill_taps.rs:489` | async | app | src/features/chat/skills/api.ts:181 | (zipUrl: string, subdir: string, overwrite: boolean, dryRun?: boolean \| null, expectedPackageSha256?: string \| null) → SkillImportZipResult ! string |
| `skill_update` | `crates/dstu-agent/src/chat_v2/skills.rs:743` | async | app | src/features/chat/skills/api.ts:105 | (path: string, content: string) → SkillFileContent ! string |
| `skill_update_from_source` | `crates/dstu-agent/src/chat_v2/skill_updates.rs:414` | async | app | src/features/chat/skills/api.ts:328 | (skillId: string) → SkillUpdateApplyResult ! string |

### 发出的事件（4）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `acr:bridge-cancel` | 常量 `ACR_BRIDGE_CANCEL` | crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:237 (emit) |
| `acr:bridge-request` | 常量 `ACR_BRIDGE_REQUEST` | crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:401 (emit) |
| `chat_v2://settings_changed` | 常量 `SETTINGS_CHANGED_EVENT` | crates/dstu-agent/src/chat_v2/tools/mcp_settings_store.rs:93 (emit) |
| `skill-lifecycle-bridge-request` | 常量 `BRIDGE_REQUEST_EVENT` | crates/dstu-agent/src/chat_v2/tools/skill_lifecycle_executor.rs:214 (emit) |

### 契约中的事件（4，`contracts/ipc/L07-agent-skills-ptc.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `chat_v2://settings_changed` | 否 | object | crates/dstu-agent/src/chat_v2/tools/mcp_settings_store.rs:93 (emit) |
| `acr:bridge-cancel` | 否 | AcrBridgeCancel | crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:237 (emit) |
| `acr:bridge-request` | 否 | AcrBridgeRequest | crates/dstu-agent/src/chat_v2/tools/workbench_bridge.rs:401 (emit) |
| `skill-lifecycle-bridge-request` | 否 | object | crates/dstu-agent/src/chat_v2/tools/skill_lifecycle_executor.rs:214 (emit) |
<!-- END GENERATED:lane -->

## 备注

- `agentTools` 已发布执行器注册入口 `registerToolExecutors` / `toolExecutors`
  （`src/tools/executor-registry.ts`），对齐 L24 `ChatAnkiToolRegistration` 与
  L10/L21 的待接线项；派发、超时、审批继续由 L04 `ToolExecutorRegistry` 负责。
  L24 已在 `apply` 中经 `ctx.inject(['agentTools'])` 调用该方法；L10/L21 需在自己的
  `apply` 中调用 `ctx.agentTools.registerToolExecutors(...)`，L04 组装派发时读取
  `ctx.agentTools.toolExecutors()`。

### 2026-11-04 收尾验证（Linux）

- `host/plugins/agent-skills`：30 个测试文件 / 408 条用例通过（TESTMAP 351 条全部
  `ported`，另有 57 条命令/接线补充用例）。
- `migration:ledger`（附本 lane vitest JSON）：命令 A 22/22（100%）、测试 A 351/351
  （100%）、测试 B 351/351（100%）；命令 B 0 仅因交叉审读阶段的
  `ACCEPTANCE.md` 尚未产生（decisions.md §B 级说明）。
- `migration:wiring -- --lane agent-skills`：ported 351，未接入 0。
- `migration:boundaries:strict`：本 lane 0 违规；全仓剩余 20 条均在其他 lane。
- `importable.mjs host/plugins/agent-skills/index.ts`：ok。
- `typecheck:host`：本 lane 无错误；main 的 `scripts/electron-migration/accounts.test.ts`
  缺少 `lib/accounts.mjs` 类型声明（其他 lane 的新增文件，未在本 lane 修改）。

### 2026-11-04 R1 独立验收修复（Linux）

- **L07-01**：`index.ts apply` 实例化 `PtcToolExecutor`（内部真实 `PtcExecutor` +
  F7 Starlark），注册进 `agentTools`；新增适配器把 L04 `ExecutionContext` 映射为
  `PtcExecutionContext`，每次脚本 `call()` 经 `admitted_tool_dispatcher` 回到中央
  准入，并派生 `${block}-ptc-${seq}`、继承 session/runId、清除 shell 审批。
  `tests/ptc-production-wiring.test.ts` 走真实插件 `apply` 与中央 dispatcher。
  L04 仍需在其组装处消费 `ctx.agentTools.toolExecutors()`（其分支
  `createExecutorRegistry` 已具备），本 lane 不复制 L04 注册表。
- **L07-02**：`PreparedSkillPackage.dispose()` 对应 Rust `StagedSkillDirectory::Drop`；
  tap install、market install、update-from-source、package install 的 prepare 后
  所有提前返回/异常均由 `finally` 释放 staging。market 校验失败与成功路径均验证
  无 `.staging-*` 残留。
- **L07-03**：market `installedAt` 改用 `platform/time` 的 `now().rfc3339`
  （chrono AutoSi，UTC `+00:00`），market 安装测试断言不出现 `Z`。
- **L07-04**：`SkillFiles` 接收插件 logger，恢复路径遍历与“路径不是目录”
  Warn 分支；`index.ts` 注入 `ctx.logger`。
- **L07-05**：新增 `src/workers/zip-pool.ts` + `zip-worker.ts` 有界
  `worker_threads` 池（平台尚无 worker 池；后续可替换为平台池而不改调用点）。
  catalog 扫描、tap 重打包、export 归档、技能包 scan 全部移入 worker；C1 续审后
  **market GitHub handoff** 与 **update-from-source tap** 两条遗漏生产路径也改为
  `runZipTask('repackSkillSubdir', …)`，生产代码不再同步调用 `repackSkillSubdir`
  （仅 worker 内执行）。worker 启动/退出/postMessage/池不可用统一抛
  `ZipWorkerInfrastructureError`，catalog/install/package scan 按 Rust join 失败
  映射 `IO_ERROR`（`Catalog scan task failed` / `Repack task failed` /
  `Zip import task failed`），worker 内 ZIP 内容失败仍为 `INVALID_INPUT`；market
  handoff 的 join 失败消息为 `Handoff repack task failed`，内容失败为
  `Handoff repack failed`，沿用 Rust `map_skill_market_err` 分类。
- **L07-06**：本地 ZIP 改为 `openSync` + `readSync` 循环，最多读 `limit+1` 字节，
  打开/读取错误分别保留 `Failed to open zip` / `Failed to read zip` 阶段文案；
  新增本地 open 失败（chmod 000）与本地 read 失败（Linux `/proc/self/mem` EIO）
  回归用例。平台不适用时用 `it.skipIf` 显式跳过并在用例名写明原因（Windows
  permission bits / 非 Linux EIO），不再用早退 `return` 冒充 passed。
  `skill-package-local-read.test.ts` 注入 `readSync` 模拟 stat 后文件持续增长，
  记录每次请求长度与实际返回总量，断言累计请求/返回恰为 `MAX+1`、最后一次
  只请求 1 字节、越过上限后无再读，并同时断言 `Zip grew beyond …` 错误文案。
- **L07-07**：`FetchSkillMarketTransport` 对整个重定向链只创建一次
  `AbortSignal.timeout`；新增真实 fetch transport 测试（同 signal 跨 302 复用、
  abort 传播）。
- **Connector ledger**：`repository/connector-ledger.ts` 改为 rusqlite 风格严格
  列读取（TEXT/INTEGER，保留原列类型错误分类），get/list/pending/session-summary
  分别保留 read/parse 级错误前缀；L04 分支 11 条 `connector-ledger.test.ts` 在本
  分支全部通过，表 DDL/索引继续由 `platform/storage` 唯一维护，本 lane 不复制表。
- **D3 精确 i64（C1 纠正后）**：`expires_at_ms` 读取改用
  `defineQuery(..., { options: { safeIntegers: true } })`，`ConnectorOperation.expiresAtMs`
  为 `bigint | null`；写侧接受完整 i64 bigint（`NewConnectorOperation` 也兼容精确
  safe number），不再拒绝合法 >2^53 值，也不把不安全 number 静默舍入；
  `operationExpired` 用 BigInt 比较；仅 confirm 结果的 JSON/IPC 边界用 `Number()`
  输出（与 Rust serde JSON 数字语义一致）。新增
  `d3_i64_expiry_roundtrips_and_compares_without_number_rounding`（2^53+1 与
  i64::MAX）与 `d3_i64_converts_to_json_number_only_at_the_tool_boundary`。
  实测 `connector-executor.test.ts` 24/24、本 lane 全套 32 文件 429/429，
  exit 0；L04 分支 11 条与 chat-pipeline `completion-finalizer` 4/4 亦通过。

**仍未完成/跨平台未验证**：

- L04 `ToolExecutorRegistry` 尚未在 main 组装并消费 `toolExecutors()`；本 lane
  只提供生产注册对象与 dispatcher 适配，不复制 L04 逻辑。
- worker 路径仅在 Linux/Node 26 验证；macOS/Windows/Electron utilityProcess 未运行。
- Android `content://` 虚拟 ZIP 通道仍按桌面行为明确拒绝（`native-needs.md`）。

### 2026-11-04 C1 唤醒补充（F4 manifests9 / X4 W08）

#### F4 `dstu-core/src/task_objects.rs` 9 条

来源按 F4 TESTMAP 的 Rust ID 逐条核对（`migration/testmap/F4-security.md:62,64-65,75-80`），
不是按文件名/manifest 字符串归档。此前 16 条已由 F4 契约测试覆盖；本次把剩余 9 条
生产实现发布到 `agent-skills/api.ts`，测试调用生产实现，不复制业务逻辑：

| Rust 测试 ID | 生产 API | TS 断言 |
|---|---|---|
| `incomplete_batch_cannot_claim_complete_success` | `canClaimCompleteSuccess`、`deserializeBatchManifest` | `tests/task-objects-manifests.test.ts` 同名用例 |
| `derived_edge_serializes_v2_and_reads_legacy_string` | `deserializeDerivedEdge` | 同名用例 |
| `schema_v1_handle_with_string_lineage_still_validates` | `deserializeTaskObjectHandle`、`validateTaskObjectHandle` | 同名用例 |
| `corpus_manifest_paginates_without_dropping_any_file` | `buildCorpusManifest`、`deserializeCorpusManifest`、`validateCorpusManifest` | 同名用例 |
| `corpus_manifest_keeps_same_name_files_as_distinct_entries` | `buildCorpusManifest` | 同名用例 |
| `corpus_manifest_dedupes_repeated_refs_and_keeps_ref_count` | `buildCorpusManifest` | 同名用例 |
| `corpus_manifest_notice_states_totals_and_readback_path` | `corpusManifestModelNotice` | 同名用例 |
| `corpus_manifest_pages_are_snapshot_immutable_after_source_change` | `buildCorpusManifest` | 同名用例 |
| `corpus_manifest_validate_rejects_bad_shape` | `buildCorpusManifest`、`validateCorpusManifest` | 同名用例 |

实测：`npx vitest run -c vitest.host.config.ts host/plugins/agent-skills/tests/task-objects-manifests.test.ts`
→ 9/9 通过，exit 0；F4 原 16 条 `host/platform/util/tests/task-objects.test.ts`
仍 16/16 通过。未修改 F4 的 TESTMAP。

#### X4 W08：PTC 经 Context 的 `nativeStarlark`

- 生产代码已移除 `host/platform/native/starlark/index.ts` 的具体实现 import；
  `ptc-runtime.ts` 只依赖 `NativeStarlark` 接口。
- `index.ts` 注册的 `PtcToolExecutor` 传入 `ctx.get('nativeStarlark')` 解析器；
  `PtcExecutor` 每次执行时解析服务，而不是在 apply 时冻结实现，因此 profile
  替换后下一次 PTC 执行立即生效。
- 脚本、取消、wall-clock deadline、子调用准入与结果封装语义保持不变；
  `tests/ptc-production-wiring.test.ts > resolves nativeStarlark from Context on every execution...`
  用替换服务记录 `evaluate` 调用，实测通过。

### 2026-11-04 C1 续审：L07-05 两个遗漏生产调用

- `src/skill-market.ts` 的 GitHub handoff 重打包改为
  `runZipTask('repackSkillSubdir', …)`，不再在 Host 事件循环同步 inflate/deflate；
  worker 基础设施失败保留 Rust join 文案 `Handoff repack task failed: …`（IO_ERROR），
  ZIP 内容失败保留 `Handoff repack failed: …`，再按 Rust `map_skill_market_err`
  的 Invalid/Unsupported/Incomplete 规则分类。
- `src/skill-updates.ts` 的 tap 来源更新同样改走 worker；join 失败保留
  `Repack task failed: …`，外层的重新取包错误仍按 Rust 统一 IO_ERROR。
- `src/workers/zip-pool.ts` 新增 `ZipWorkerInfrastructureError`：worker spawn/
  postMessage/error/exit/池不可用均标记为基础设施失败；catalog scan、tap install、
  package scan 将其映射 `IO_ERROR`，worker 内 ZIP 内容异常仍为 `INVALID_INPUT`。
  export 原本就全部映射 IO_ERROR，现也区分 `Export task failed` 前缀。
- 新增回归：market handoff 内容失败上下文、tap refetch worker 重打包、
  worker 传输失败 vs ZIP 内容失败分类；L07-06 增加本地 open 失败（chmod 000）
  与本地 read 失败（Linux `/proc/self/mem` EIO）用例。
- 实测（全局作业队列）：
  - `20261104063846-17dc05` tsc，退出码 0；
  - `20261104063846-c35091` skill-market，26/26，退出码 0；
  - `20261104063846-7ed7f0` skill-updates，6/6，退出码 0；
  - `20261104063846-85a3a2` skill-package，36/36，退出码 0；
  - `20261104063846-5f137a` zip-pool，2/2，退出码 0；
  - `20261104063846-85701f` skill-taps，10/10，退出码 0；
  - 定向新用例 `20261104064028-4562e4`、`20261104064028-307ba8`、
    `20261104064028-6df9c0`、`20261104064139-aa41c2`（有界增长）均退出码 0。
  - C1 07:19 复核后：`20261104073038-f5442f` skill-package 36/36、
    `20261104073038-9acac1` local-read 1/1、`20261104073038-e537ac` tsc，
    均退出码 0；本轮 Linux 非 root 下两个平台条件用例实际执行而非跳过。
- 仍未闭合：PTC 的真实 L04 `toolExecutors()` 消费未在 main 组装；worker 仅在
  Linux/Node 26 测试宿主验证，Electron `utilityProcess`、macOS/Windows 未运行。

## v2 接手盘点（2026-11-04）

以下是按 `standard-v2.md` §1 组织的接手盘点，不是逐函数重新验收。
命令语义结论继承 SPEC 和 R1 明确审过的范围，不能把“复核未报残差”解释成八类全部通过。
`ACCEPTANCE.md` 是独立复核文档，本节不改其结论；以末尾续作记录更新运行证据。

| 命令/模块 | 问题类型 | 证据与当前结论 |
|---|---|---|
| `chat_v2_list_skill_candidates` | 1.1/1.2/1.3/1.4/1.5/1.6/1.7 | `index.ts:194–202` 声明、`src/skill-replay.ts:783–804` 列表实现；历史分支说明见 `SPEC.md:36–42`，不扩大为本轮逐分支审读。 |
| `chat_v2_promote_skill_candidate` | 1.3/1.4/1.6/1.7 | `src/skill-replay.ts:572,587` 暂存清理与晋升入口；历史分支说明见 `SPEC.md:54–61`；独立 runner 证据仍待。 |
| `chat_v2_record_skill_activation` | 1.2/1.3/1.6 | `repository/skill-usage.ts` 只写本 lane 的 `skill_usage`；生产命令和对应 Rust 测试已接线。 |
| `chat_v2_replay_skill_candidate` | 1.3/1.6/1.7 | `src/skill-replay.ts` 先完成探针再做 guarded transition；生产入口测试已 ported，复核未报残差。 |
| `chat_v2_rollback_skill_candidate` | 1.3/1.6/1.7 | `src/skill-replay.ts` 退役 rename 后更新状态；错误路径保持 published；独立 runner 证据仍待。 |
| `skill_check_updates` | 1.1/1.3/1.6/1.7 | `src/skill-updates.ts` 经 `index.ts` 命令入口读取 provenance，tap 重打包走 `runZipTask`（`skill-updates.ts:156`）；worker 跨平台仍待验证。 |
| `skill_create` | 1.3/1.4/1.6 | `src/files.ts` 保留 Rust 校验顺序和 `ctx.logger`；文件命令 warning 回归在 `tests/files.test.ts`，独立运行待。 |
| `skill_delete` | 1.3/1.4/1.6 | `src/files.ts:250+` 走生产命令入口；路径越界/非目录 warning 已恢复；独立运行待。 |
| `skill_export_tap` | 1.3/1.6/1.7 | `src/skill-taps.ts:465` 经 `runZipTask('exportTap')`，worker 失败映射 IO_ERROR；utilityProcess/打包/三平台未验证。 |
| `skill_import_zip` | 1.3/1.6/1.7 | `src/skill-package.ts:readZipBytes` 使用 `fs/promises` stat/open/FileHandle.read，保留 MAX+1 与 open/read 分段错误；L07-05 两处 Host IO 残差已获 R1/C1 签收，平台范围不扩。 |
| `skill_list_directories` | 1.3/1.4/1.6 | `src/files.ts` 路径校验、缺失目录和 warning 对应 Rust 分支；生产测试已 ported，独立 runner 待。 |
| `skill_list_package_files` | 1.3/1.4/1.6 | `src/files.ts` 深度/数量/隐藏目录/symlink 分支保留；生产测试已 ported，独立 runner 待。 |
| `skill_market_download_and_scan` | 1.2/1.3/1.6/1.7 | `src/skill-market.ts:959+` 以 finally 释放 prepared，provenance 用 `currentInstant().rfc3339`；worker handoff 失败分类已分离，实跑待。 |
| `skill_market_search` | 1.3/1.6/1.7 | `src/skill-market.ts:FetchSkillMarketTransport` 在 redirect 链外只建立一个 deadline；无网络经生产入口 <1s 返回 IO_ERROR（G1，`tests/skill-market-offline.test.ts`，Node/Electron-Node）；三平台待。 |
| `skill_market_skill_detail` | 1.3/1.6/1.7 | 同一 market transport 和严格 slug/detail 解码；生产入口测试已 ported，独立 runner 待。 |
| `skill_market_verify` | 1.3/1.6/1.7 | 同一 market transport 和 verify 默认值/错误映射；生产入口测试已 ported，独立 runner 待。 |
| `skill_probe_requires` | 1.3/1.6/1.7 | `src/requires.ts` 逐类探测、5 秒超时和错误转 found=false 对应 Rust；生产入口测试已 ported。 |
| `skill_read_file` | 1.3/1.4/1.6 | `src/files.ts` 严格 UTF-8、路径 warning、错误信封经生产入口；独立 runner 待。 |
| `skill_tap_catalog` | 1.3/1.6/1.7 | `src/skill-taps.ts:362` 扫描走 worker，基础设施失败映射 IO_ERROR、ZIP 内容失败映射 INVALID_INPUT；Electron/打包/三平台待。 |
| `skill_tap_install` | 1.2/1.3/1.6/1.7 | `src/skill-taps.ts:395+` prepare 后所有退出路径 finally dispose，重打包走 worker，设置失败 rollback；独立 runner 待。 |
| `skill_update` | 1.3/1.6 | `src/files.ts` 保留原地覆盖和输入校验顺序；生产入口测试已 ported。 |
| `skill_update_from_source` | 1.2/1.3/1.6/1.7 | `src/skill-updates.ts:156` tap repack 走 worker，prepare 生命周期由 finally 覆盖；独立 runner 待。 |
| `agentSkills` 服务/技能注册表 | 1.1/1.2/1.3/1.4/1.6/1.7 | `index.ts:219–222` 经 Cordis Service 构造注册；R1 `ACCEPTANCE.md:31,35` 确认服务声明及所抽查 SQL 所有权；不是全量 serde 审计证明。 |
| `agentTools`/`builtin-ptc_run` | **1.1（外部阻塞）**、1.7 | `index.ts:222+` 已实例化并注册真实 `PtcToolExecutor`，但全 host 仍无 L04 `ToolExecutorRegistry` 对 `toolExecutors()` 的生产消费；`tests/ptc-production-wiring.test.ts` 是提供方接线 seam，不能替代真实消费。 |
| ZIP worker / market transport 横切服务 | 1.7 | `src/workers/zip-pool.ts` 已区分基础设施错误和 ZIP 内容错误；Linux/Node 测试宿主已覆盖，Electron `utilityProcess`、打包路径、macOS/Windows 原生验证未提供。 |

### 复核未勾选项处理计划

- L07-01：保留提供方真实注册；等待/推动 L04 在生产组装处消费 `agentTools.toolExecutors()`，在该消费存在前不把 PTC 相关复核项宣称闭合。
- L07-02/03/04/06/07 与 D3 指定修复：R1 已在正常 main 独立签收（`a72ef7dee`/`bf6479dc8`；C1 作业 `20261104105922-ff769c` 8 pass、`20261104111742-4e66b9` 5 pass，均 exit 0）。
- L07-05：R1 指出的两处 Host 同步 IO 残差（见下方“L07-05 续作”）已由 R1 在正常 main 独立签收（`ce6bab375`，ACCEPTANCE §12；C1 亲取作业 `20261104131936-08027e` 7 passed / 42 过滤 skip / exit 0 / 无 Errors，Linux 非 root 下 open/read 用例实际执行）。utilityProcess/打包/三平台仍未验证。
- Linux 之外的 worker、Electron `utilityProcess`、打包和 Windows/macOS 原生验证属于当前环境外的真实阻塞；不以 helper 测试替代。

### 真实跨 lane 阻塞

1. L04/L03 尚未在 main 的生产组装中读取 `agentTools.toolExecutors()` 并交给真实中央 dispatcher；缺少具体消费调用点，L07 无法在本插件内伪造闭环。
2. Electron `utilityProcess`/打包与 macOS/Windows runner 不在本 lane 或当前 Linux 环境中；需要协调者提供对应作业与平台证据。

### 八类规则的证据边界与续作结果

| v2 规则 | 本次核实/处理 | 未闭合范围 |
|---|---|---|
| 1.1 生产接线 | `index.ts:222–236` 的真实 PTC 注册仍在；全 host 检索没有生产消费 `toolExecutors()` | L07-01/B1；48 条 PTC 去向降回 pending |
| 1.2 单一所有者 | SQL 写语句集中在 `repository/skill-usage.ts:88,112,242–285`、`repository/connector-ledger.ts:222–419`；settings 经 `index.ts:210–212` 的公开服务 | 沿用 R1 `ACCEPTANCE.md:35` 的抽查结论，不签收其他 lane |
| 1.3 serde / D3 | R1 `ACCEPTANCE.md:215–218` 已核对 connector 精确 i64；本会话全套包含其真实数据库往返测试 | 不把该向量外推为所有 JSON/整数边界均完成新审计 |
| 1.4 日志/错误 | `src/files.ts:160,179` 两个 warn；worker join/内容错误区分见 R1 `ACCEPTANCE.md:235–237` | 未额外声称全部 info/debug 审计完成 |
| 1.5 测试真实性 | PTC 48 条断言保留且实跑，只有记账降为 pending；R1 已确认 06 的平台 skip/MAX+1 证据修复 | 当前测试 dispatcher 是 seam，真实 L04 消费待验证 |
| 1.6 完整性 | 22 命令已有 SPEC；复核指定缺陷 02～07 不重做，续作以 R1 §6～9 的证据范围为限 | 旧 SPEC 七项不自动等于 v2 九项；全量重审不宣称完成 |
| 1.7 运行时 | Node / Electron-Node 均 436/436；有界读取、Drop 替代和 worker 定向用例通过 | utilityProcess/打包/三平台、ZIP 字节与 rename fallback 裁定见 BLOCKERS |
| 1.8 复验闭环 | 02/03/04/06/07、D3 已由 R1 签收；05 两处 Host 同步 IO 残差 R1 main 复验签收（`ce6bab375`，ACCEPTANCE §12，作业 `20261104131936-08027e` 7 passed） | 01 与 05 平台部分（utilityProcess/打包/三平台）未闭合 |

| 作业 | 命令/范围 | 结果 |
|---|---|---|
| `20261104095436-a151fe` | `npm run typecheck:host` | exit 0 |
| `20261104105829-041dfc` | 合并最新 main（`eab01c0f3`）后类型检查 | exit 0 |
| `20261104095438-4c7508` | 8 文件定向回归 | 97 passed，exit 0，无 Errors 行 |
| `20261104095818-a7d497` | Node 本插件全套 | 34 文件、436 passed，exit 0，无 Errors 行 |
| `20261104103803-87f052` | `test:host:electron` 本插件全套 | 34 文件、436 passed，exit 0，无 Errors 行；仅 Electron-Node 模式 |
| `20261104103803-e71c36` | Node 原生类型擦除加载插件 | `importable: ok`，exit 0 |
| `20261104095823-d591c5` | strict boundaries | exit 1，4 条均属于 vfs；本 lane 无输出行 |

截至本次续作：TESTMAP 303 ported / 48 pending / 0 merged / 0 obsolete；旧文档中的
351 ported 是历史快照。48 条逐项及统一消费阻塞见 TESTMAP 与 BLOCKERS B1。
未新增生产代码或修改测试断言；按 C1 08:21Z 指令，在外部消费/平台证据仍缺失时收尾上报。

### 本次账本与门禁原始输出

`20261104105717-3f51da`（exit 0，`npm run migration:ledger -- --check --no-write`）：

```text
ledger: commands 1058 (A 92.8% B 5.9% C 0%), tests 8036 (A 79.9% B 1.6%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

`20261104105830-f35c3e` 只读执行同一 ledger 计算并打印本 lane 的 summary（未写生成文件，exit 0）：

```json
{"commands":22,"cmdA":22,"cmdB":0,"cmdC":0,"tests":351,"testA":303,"testB":0,"pctCmdA":100,"pctCmdB":0,"pctCmdC":0,"pctTestA":86.3,"pctTestB":0}
```

这是旧机械门禁的计算结果，不是 v2 完成声明；本次未传 vitest JSON，因此测试 B 为 0。
命令没有未达机械 A 的条目，B 仍受独立验收未决项约束。

`20261104105717-fbdb99`（exit 0，`migration:wiring -- --lane agent-skills`）：

```text
合计 ported 303，其中所测模块未从 index.ts 接入 0（0.0%）
```

`20261104095823-d591c5`（exit 1，`migration:boundaries:strict`）没有本 lane 输出行；
原始汇总如下，4 条违规均是 `BLOCKERS.md` 已列出的 vfs 文件：

```text
boundaries: scanned 2337 files, 4 violation(s) {"empty-catch":3,"console-log":1}, 184 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
```

接口仍为 `agentSkills@1` 与 `agentTools@1`（Cordis 键 `agentSkills`/`agentTools`），
本轮无 API 变化、无新 DRAFT 差异或 npm 依赖申请。Rust 的路径规范化已知行为保持原样
（`SPEC.md:406–410`）；ZIP 字节及目录交换语义裁定继续列在 BLOCKERS，未自行批准。

### L07-05 续作：剩余两个 Host 同步 IO 点（R1 复核反例）

| 位置 | Rust | 修复 |
|---|---|---|
| `src/skill-package.ts` `readZipBytes` 本地分支 | `skills.rs:2378-2413` 用 `tokio::fs` metadata/open + `take(MAX+1).read_to_end` | 改为 `fs/promises` `stat`/`open`/`FileHandle.read` 循环；每次最多读 `MAX+1-total`，打开失败 `Failed to open zip …`、读取失败 `Failed to read zip …` 分开，`finally` 关闭句柄（关闭失败 warn） |
| `src/skill-taps.ts` `writeTapExportZip`（`exportTap` worker 返回后） | `skill_taps.rs:690-732` 在 `spawn_blocking`（`:762-884`）内写目标/暂存 | 改为 async `writeFile`/`mkdir`/`rm`；本地直写、虚拟目标暂存→`writeVirtual`→`finally` 删除暂存，错误文案与 Rust 相同；`exportTap` 中 `await` |

测试改动（断言不变）：`tests/skill-taps.test.ts` 的 `tap_export_virtual_destination_goes_through_staging_and_cleans_up`、
`tap_export_local_destination_writes_directly` 因函数变为 async 改为 `await` / `rejects.toThrow`，对应 Rust 断言
（目标=URI、暂存字节、暂存目录清空、provider 错误传播、本地直写且不建暂存）逐条保留；
`tests/skill-package-local-read.test.ts` 的外部注入点从 `readSync` 改为 `FileHandle.read`，MAX+1 累计请求/返回、
末次 1 字节、越限后无再读、失败后不再调用的断言不变。新增两个 L07-05 向量：生产 `readZipBytes`
与 `writeTapExportZip` 完成前先让出事件循环（`setImmediate` 先执行；旧同步实现下为 false）。
仍未验证：Electron utilityProcess、打包路径、macOS/Windows。

作业：`20261104114750-ece318` typecheck:host exit 0；`20261104115144-605733` 本插件全套 34 文件 / 438 passed，
exit 0，无 Errors 行、无 skipped（Linux 非 root 下 open/read 阶段用例实际执行）；`20261104115234-a388c6`
strict boundaries 无 agent-skills 命中（全仓 4 条仍属 vfs，exit 1）。

## v2 排雷清单（X6 存量，基线 `2ee9a9cbe`；核验 SHA 见各节）

来源：`git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`。
这是候选清单，不是当前缺陷全集；info、assert/log 计数只作线索，逐处对照 Rust 后判定。
single-writer、prod-reachable：本插件 0 候选。

### unchecked-decode（核验于 `ee651a7f1`）

| ID（C2 稳定 ID） | 位置（基线行） | Rust 证据 | 判定 | 状态 |
|---|---|---|---|---|
| X6-UD-0004（= X6-unchecked-decode-agent-skills-skill-workshop-executor-453） | `readProposalMeta` `JSON.parse(text) as Record` | `skill_workshop_executor.rs:47-75,530-535` serde `ProposalMeta`：7 个 String 必填、Option 可 null、Vec/u64 带默认且类型严格 | 缺陷：旧 TS 对缺字段/错类型静默转 `''`/`[]`，`files` 项未校验 | 已修 `ee651a7f1`：`decodeProposalMeta` 按输入顺序报类型错、再报缺字段，文案沿用 serde；新增向量 |
| X6-UD-0005（= …-skill-workshop-executor-754） | `proposeUpdate` marker `JSON.parse(...) as { packageVersion }` | `:94-108,797-802` 整体解码 `AgentWorkshopMarker`，失败→旧版本 0 | 缺陷：旧 TS 只看 `packageVersion`，缺必填字段时仍沿用版本 | 已修 `ee651a7f1`：`decodeAgentWorkshopMarkerVersion`，失败仍进原 catch→0 |
| X6-UD-0006（= …-workbench-executor-197） | `extractErrorCode` | `workbench_executor.rs:351-357` `Value::get("code").and_then(as_str)` | 行为等价（以 `{` 开头的 JSON 只能是对象），仅去掉无校验断言 | 已修 `ee651a7f1` |
| ptc-runtime.ts:633 double-assertion[info] | `object_handle: handle as unknown as StarlarkJson` | `ptc_runtime.rs:933-945` `serde_json::to_value(&handle)` 出站序列化 | 出站/内部类型转换，非入站解码；不改 | 无需修 |

本插件无跨 owner 写调用（single-writer 0 候选），D1 的 `*WithConn` 要求在本插件不适用。

### assert-parity（核验于 `aabc9b735`，逐条 Rust 断言对照）

| ID / 候选 | Rust | 判定 | 状态 |
|---|---|---|---|
| X6-AP-0022（= X6-assert-parity-agent-skills-skill-usage-508） | `skill_usage.rs:1916` `assert_eq!(rows.len(), 1)`（outcome_unknown 段） | 缺口：TS 只查 `[0].outcome`，多余行不会被发现 | 已修 `4ecc6bac7`：补 `toHaveLength(1)`，原断言不变 |
| X6-AP-0014/0015/0016/0017 requires.test.ts:14/31/42/51 | `skill_requires.rs:667/690/707/726` | 单个整对象 `toEqual` 覆盖多条 `assert_eq!`/`is_empty`，且更严格 | 已覆盖 |
| X6-AP-0018/0019/0020/0021 requires.test.ts:57/82/107/125 | `:743/790/841/894` | 循环逐对 `toBe`/`toContain`；`toHaveLength(5)` 对应 invalid 数；平台分支用 `pythonPresent` 对应 | 已覆盖 |
| X6-AP-0023/0024/0025 files.test.ts:14/17/32 | `skills.rs:2784/2797/2832` | 3 条命令循环各断言一次；TS 用空 base，deny 判定更严 | 已覆盖 |
| X6-AP-0026/0027 canvas-tools.test.ts:17/95 | `canvas_tools.rs:772/836` | 门禁配错 TS 用例；对应用例在 `:8`（4 条）与 `:57`（7 工具） | 已覆盖 |
| X6-AP-0028/0029 fetch-executor.test.ts:98/258 | `fetch_executor.rs:1691/1968` | 门禁配错；对应用例在 `:74`（11 条）与 `:237`（4 条） | 已覆盖 |
| X6-AP-0030 workbench-executor.test.ts:317 | `workbench_executor.rs:877` | 门禁配错；`:130` 逐条 16 条 | 已覆盖 |

### log-parity（核验于 `318032c85`，逐个 Rust warn!/error! 位置对照；全部是 info 线索）

C2 稳定 ID 来自冻结报告 `0119143715c0`；修复提交写稳定 ID。

| C2 ID | Rust 位置 | 判定 | 状态 |
|---|---|---|---|
| X6-LP-0018 | `skills.rs:310,391,2085,2105` | 已对应 `files.ts:160,179`、`skill-package.ts:467,487` | 已覆盖 |
| X6-LP-0018 | `skills.rs:2042` 交换成功后删除 backup 失败 | Node 无 `renamex_np`，TS 只有 rename fallback，没有该分支（BLOCKERS 待裁定项） | 不适用，随目录交换裁定 |
| X6-LP-0019 | `skills.rs:2123` error!（`Drop` 中回滚失败） | JS 无 Drop；各调用方显式 `rollback()/finalize()`，失败随错误抛出（`SPEC.md:21`） | 不适用 |
| X6-LP-0020 | `connector_executor.rs:641,809,839,949,964,1048,1084,1108,1120` | 已对应 `connector-executor.ts:683,693,841,988,1015`、`connector-reconcile.ts:73,85,110,125` | 已覆盖 |
| X6-LP-0020/21/22/23/25/26/29/30 | 各执行器 `execute()` 包装里的 `Failed to save tool block`（`connector:1276`、`fetch:1546,1566`、`general:158,185`、`llm_usage:758`、`mcp_manage:975,990`、`mcp_propose:765,780`、`skill_install:501,519`、`skill_lifecycle:610,646`） | TS 这些类只发布路由/敏感度或 `executeX` 辅助函数，没有 `execute(call, ctx)`；`index.ts:226-236` 只注册 PTC。保存工具块的包装尚未移植 | 未移植路径，归 B1 同根（L04 registry 消费方/执行器包装）；不补空日志 |
| X6-LP-0021 | `fetch_executor.rs:1004` DeepSeek 失败回退本地 | `execute_fetch` 主流程未移植，同上 | 同上 |
| X6-LP-0021 | `fetch_executor.rs:1389` html2text 失败 | TS 正则转换没有失败分支 | 不适用 |
| X6-LP-0022 | `general_executor.rs:127,167` | 同上，`general-executor.ts:5-7` 只做路由 | 未移植，同上 |
| X6-LP-0024 | `llm_usage_executor.rs:95` error! | `llm-usage-executor.ts:505` | 已覆盖 |
| X6-LP-0024 | `llm_usage_executor.rs:711` error! 连接失败 | TS 接收已打开的 `SqlExecutor`，无连接步骤；`execute` 未移植 | 未移植，同上 |
| X6-LP-0025/26 | `mcp_manage:671,677`、`mcp_propose:663` | `mcp-manage-executor.ts:430,640`、`mcp-propose-executor.ts:387` | 已覆盖 |
| X6-LP-0027 | `ptc_executor.rs:101,105,114,438,714` | `ptc-executor.ts:54,56,67,270,469` | 已覆盖 |
| X6-LP-0027 | `ptc_executor.rs:501,524` 子调用保存失败 warn | 缺陷：TS 只用 `ctx.logger`，生产 `PtcToolExecutor` 不传，日志丢失 | 已修 `318032c85`：回退到执行器 logger，新增向量 |
| X6-LP-0027 | `ptc_executor.rs:536` error! 子调用 panic | Rust 区分准入拒绝（`Ok(Err)`，合成失败块）与 panic（只记 error、不落块）；L04 `AdmittedToolDispatcher`（`chat/api.ts:94-96`）只返回 `Promise<ToolResultInfo>`，两者都是 rejection，无法区分 | 阻塞：向 L04 申请接口（见 BLOCKERS B1） |
| X6-LP-0028 | `ptc_runtime.rs:1027` 解释器限额拒绝 | 已移到平台层 `host/platform/native/wasm/src/starlark_engine.rs:236-241` | 不适用（平台 owner） |
| X6-LP-0029 | `skill_install_executor.rs:340` | `execute_install`/`persist_provenance` 未移植 | 未移植，同上 |
| X6-LP-0031 | `skills_executor.rs:534,617,626,635` | 会话技能状态/消息快照持久化未移植（`skills-executor.ts:5-7` 只返回回执） | 未移植，同上 |
| X6-LP-0032 | `workbench_executor.rs:627,645` | `workbench-executor.ts:521` 成功/失败共用一次保存 | 已覆盖 |
| X6-LP-0033/0034 | 插件总数 | 由上表逐处解释；不按数量补日志 | 线索，无独立修复 |

验证：`20261104130452-f38faf` typecheck exit 0；`20261104130452-e22a3f` ptc-executor + ptc-production-wiring 19 passed exit 0；
`20261104124924-85cedb` skill-workshop + workbench 36 passed；`20261104125429-6f674d` skill-usage 21 passed。
上述修复待 main 后 R1 独立复验，复验前不算完成。

### L07-05 签收（R1）

R1 在 main 复验并签收两处 Host 同步 IO 残差：`ce6bab375`（ACCEPTANCE §12），作业 `20261104131936-08027e`
7 passed（42 条按过滤跳过），exit 0，无 Errors。实现为 `ddcd6dde9`。签收范围不含 utilityProcess、打包和三平台；
L07-01 中央 dispatcher 消费仍未决。C1 已亲取该作业确认。`ce6bab375` 尚未进入本分支所见的 main，以 R1/C1 消息为据记录。

### 本轮收尾（无剩余自有工作）

自检 `62706c802`（基线 main `ad11a8394`）5 项全部通过。剩余均为外部阻塞：B1（L04/L03 生产 registry/dispatcher
消费 `toolExecutors()`，含 X6-LP-0027 panic/拒绝区分接口、未移植执行器 `execute` 包装）、B2（utilityProcess/打包/三平台）、
ZIP 字节与目录交换待裁定。X6 清单修复（`ee651a7f1`、`4ecc6bac7`、`318032c85`）待 R1 main 后复验。

### 自动续派：X6-UD-0004/0005 精确整数与流式读取续修（2026-11-04）

本轮先合并正常 main `4525e11ac`，无 lane 源码增量；该 HEAD 的正式自检两项
（typecheck、boundaries）全部通过，**当时无分支差异，因此未执行插件测试**。
L04 的 `createExecutorRegistry` / `toolExecutors()` 生产消费仍未合入；不恢复停放的 L04。

对未签 UD 原修复继续核差，发现实际残留，不是重新派一套编号：

| 原 ID / Rust 依据 | 原残留 | 本轮修复及证据 |
|---|---|---|
| X6-UD-0004，`skill_workshop_executor.rs:49-80,530-535` | `JSON.parse` 先舍入 u64/usize；`1.0`/`1e0`/`-0` 被当整数；重复字段被 last-wins；后部语法错掩盖前部字段错 | 直接消费 F4 正式 `platform/util/api.ts` 的 `JsonReader`，已知字段逐个读取、检测重复；unknown 字段跳过并检查语法；错误保留 `Invalid PROPOSAL.json: …` 与 serde 位置 |
| X6-UD-0004，`:155-190` 的 revision 使用整数小端字节 | 先转 Number 会让相邻合法整数产生相同 revision | 安全整数保持 number，超过安全范围保留 bigint；revision、manifest 比较、状态重写均不经过 Number；磁盘写回用原始 JSON 数值 token，不写字符串 |
| X6-UD-0005，`:797-802,830` | marker 先舍入；漏 `previous_version.saturating_add(1).max(1)`，u64::MAX 导致后续写哈希字节溢出 | marker 直接用同一 reader；无效仍沿原 catch→0；版本递增用 bigint 饱和到 u64::MAX，marker/provenance 文件也保留精度 |

内部 `ProposalFileMeta.size`、`ProposalMeta/AgentWorkshopMarker/SkillWorkshopProvenance.packageVersion`
类型改为 `number | bigint`（原安全 number 调用继续有效）。原提交曾在工具返回对象中投影 Number，
这一点经 C1 指正不是真实 wire，已在下方“内部返回值纠正”续修；不能据此称完整 D3。
无新增依赖、无 foreign owner 写入、无 API 服务版本变更。

新增 `tests/workshop-json.test.ts` 10 条，直接调用实际文件读写/审批哈希/`propose_update` 主逻辑：
2^53+1 与 u64::MAX 往返、相邻版本 revision 不同、浮点词法/溢出拒绝、重复已知字段（含 null Option）、
未知字段重复保留忽略语义、首个字段错优先、marker 无效回退和版本饱和。
原测试断言、TESTMAP 去向均未修改；此文件由协调者检查点 `82564b117` 保存。

| 作业 | 范围 | 结果 / Errors |
|---|---|---|
| `20261104153902-27684a` | 新增文件，旧实现 | 10 failed，exit 1；均为预期回归反例，不是通过证据 |
| `20261104154422-9d0ad1` | 新文件 + 原 skill-workshop-executor 文件 | 26 passed，exit 0，无 Errors 行 |
| `20261104154422-1d2f9c` | typecheck:host | exit 0，无 Errors 行 |
| `20261104155020-7128b8` | Electron-Node 仅新增文件（验证 reader/原始 JSON 数值写回能力） | 10 passed，exit 0，无 Errors 行；不代表 utilityProcess/打包/三平台 |

本轮 v2 八类核差边界：1.1 仍无真实消费，不升级 pending；1.2 现有 SQL 所属
skill_usage/skill_candidates/connector_operations 未变；1.3 修复上述 UD/D3；1.4 保错误前缀并由公共 reader
恢复首错/位置，LP-0027 panic 分类仍等 L04；1.5 新测试先红后绿、不动旧断言；1.6 补全这条文件解码→版本递增→
哈希→持久化链的分支，不宣称所有 executor 已实现；1.7 原 IO/清理签收不重开，新增测试 finally/afterEach 清理临时文件，
保留 Rust 墙钟 createdAt；1.8 本轮仅提供方证据，仍待 main 后 R1 独立复验。

### 本轮已完成及停止自动续派的证据

已完成本轮可实施的 X6-UD-0004/0005 续修：源码/说明提交 `3d6108625`，新增回归由 `82564b117` 保存。
`3d6108625` 合并 main `1e893eb61` 后正式 lane-gate 五项全部通过（含本插件 tests）；
定向 Node 26 passed、Electron-Node 10 passed、typecheck exit 0，作业与反例记录见上表。
不把此处“已完成”解释成整 lane 验收：新旧 X6 修复仍待 R1 正常 main 后最小独立复验；
48 条 PTC pending、L04/L03 消费/异常分类、utilityProcess/打包/三平台及 ZIP/目录交换裁定保持原状态。
以上是当轮收尾状态；后续 C1 指出的两项 serde 残差与内部返回值续修见下节。后续仅在协调者给出新指令、正常 main 解除依赖或具体复核反例到达时继续，
不因自动续派重复旧 AP/05 矩阵，不解除停放的 L04。

### C1 复核续作：X6-UD-0004/0005 内部返回值纠正（2026-11-05）

**更正范围声明：`3d6108625` 不是完整 serde/D3。** 元数据读取、revision hash、marker/文件写回和
u64 饱和的已修部分保留；另有以下精确未关闭残差（亦记 BLOCKERS B4）：

1. `serdeStruct` 的 unknown 分支仍调用 `reader.skipValue()`；当前 F4 实现用 `readValue()`，
   不等同 serde `IgnoredAny`。F4 候选 `b6dc607f7` 已发布公开 `skipIgnoredValue`，当前 main
   祖先检查 exit 1，状态改为“候选待 main”；不是缺实现。R1 `c7bd5d5ce` 已独立确认差异。
   正常 main 合入后显式消费新方法，只验证触及差异；不复制 parser、不用旧 `skipValue` 降级，
   也不与工具返回值的 wire 边界一并关闭；
   已有 unknown 重复字段测试只证明该向量，不证明完整忽略语义。
2. `serdeStruct` 仅 `beginObject`，没有实现 serde struct 的序列输入形式；这是 L07 自有未实现分支，
   不是 F4 外部缺口，也不以现有 map 向量代替验证。

**实际调用点 / wire 核查：**

- `api.ts:216` 仅 re-export `SkillWorkshopExecutor`。`src/tools/skill-workshop-executor.ts` 的
  `propose`→`proposeUpdate` / `list` 及 `apply` 返回 `Record<string, unknown>`，没有序列化调用。
- 全仓 TS/TSX 检索只有本 lane 测试实际构造该类，生产没有该类的执行包装；
  `host/kernel/agent-roster.ts:63` 是名称字符串，不是调用。
  `index.ts:194-202` 的 IPC 清单及 `contracts/ipc` 均没有 workshop 命令。
- 所以当前 **不存在可指认的 workshop Host 最终 IPC/wire 落点**。不得把内部对象名为 JSON receipt
  当成舍入许可；未来 registry/执行包装、事件、持久化与真正 wire 的精度合同仍须在接线时核对。
  Rust 对照 `skill_workshop_executor.rs:1264-1302`：`output` 仍进入 end 事件、ToolResultInfo 和落块，
  不是 `execute_propose` / `execute_apply` 返回时就结束所有内部消费。

本次仅删除三个 `package_version: Number(...)` 和 list 的 `files.size` Number 映射；
propose/list/apply 返回精确 `number | bigint`，不改全局 JSON、元数据、hash、marker 或饱和实现。
新增两条 `internal receipts` 用例直接检查 propose→list→apply 的返回版本及 list 的大整数 size；
原有 10 条与旧移植断言不改。只按名称过滤这两条，不重复 26 条或整 lane。

| 作业 | 范围 | 结果 / Errors |
|---|---|---|
| `20261104160540-285c73` | 新增 `internal receipts` 两条，修复前 | 2 failed / 10 过滤 skipped，exit 1，确认提前 Number 转换丢精度 |
| `20261104160847-32b8db` | 同两条，修复后 | 2 passed / 10 过滤 skipped，exit 0，无 Errors 行；未执行的 10 条不计 pass |
| `20261104160847-fd6792` | typecheck:host | exit 0，无 Errors 行 |

当时未继承 `a5e1e41b6` 的正式自检结论。随后 C1 明确“不得重复全 26 / 整 lane”仅限制额外手动验证，
不豁免 §5；据此提交→merge→官方 lane-gate 已完成：`38e43cbfe` / main `677f6727c` 五项全通过。
未改脚本/过滤条件，也不把正式门禁通过解释为完整 serde/D3 或 R1 独立签收。
新增两条内部返回值回归由协调者检查点 `811c5a83c` 保存；旧 10 条与原移植断言未改。

### 自动续派：struct sequence 的精确依赖核差（2026-11-05）

R1 `710e46227` ACCEPTANCE §14 已静态确认 `38e43cbfe` 撤销四处提前 Number 化，
receipt 原缺陷不再返工；仍未独立运行、未授整 lane/最终 wire 签收。
本轮正常 merge main 后，F4 `skipIgnoredValue` 仍未出现在当前公共 reader，保持候选待 main。

对 sequence 分支先核项目锁定的 serde 源码（只读 Cargo registry，不编译 Rust）：

- `serde_derive-1.0.228/src/de/struct_.rs:70-95` 为无 flatten struct 生成 visit_seq；
  `src/de.rs:451-550,805-835` 按声明顺序读取，只有显式 `#[serde(default)]` 的字段缺项才默认，
  否则报 `invalid length N, expected struct NAME with K elements`。
- 本项目 `ProposalMeta` 前 7 字段必填，其余有显式默认；`ProposalFileMeta` 三字段均必填。
  `AgentWorkshopMarker.previousPackageSha256` 虽为 Option，但没有显式 default，
  map 缺失与 sequence 缺项不能混同；sequence 中必须占位（可为 null）。
- `serde_json-1.0.149/src/de.rs:1837-1846` 在 visitor 后执行 `end_seq`（`:1072-1087`）：
  字段已读完时，多余元素不解码，直接按 trailing characters/trailing comma 优先级和 peek 位置报错。
  F4 当前 `nextItem` 自动吃掉逗号或 `]`，且没有固定长度数组收尾方法，无法只靠现有公开面精确实现该步骤。

已给 F4 精确请求：公开 `JsonReader.endArray(): void`（名字由 owner 定），只提供上述 end_seq 收尾；
L07 自己实现字段顺序/default/短序列/嵌套 file struct，不要求 F4 代写业务解码器。
不增加第二套 parser、不碰私有 index，不把近似顺序的实现说成通过。
本轮没有改生产代码、没有新增假绿测试或改原断言；序列分支仍未关闭，unknown/receipt/wire 各自独立记账。

本轮核差与精确接口请求已完成：合并后的 `49a741c9c`（main `fb463060d`）官方自检五项全通过；
receipt 专项仍仅引用 `20261104160847-32b8db` 的 2 passed / 10 过滤 skipped，不新增独立签收。
当前无可在已有公共接口下独立完成的下一单元；待 F4 方法正常 main 后继续本 lane 消费，
不解除停放的 L04/L03，不升级 48 条 PTC pending，不称完整 serde/D3 已完成。

### F4 reader 接缝候选更新（2026-11-05）

F4 已在 `a1c87c360` 发布 `endArray(): void`，同 reader 亦包含 `b6dc607f7` 的显式
`skipIgnoredValue()`；固定长度读完后直接 endArray，不先 nextItem。F4 同时修正 peek 的 UTF-8
字节位置，提供方作业 `20261104164901-d6491a` 28 passed / exit 0 仅作接口候选证据，不算 L07 验收。
已核对当前 main `fb463060d` 无这两个方法，`a1c87c360` 仅 F4 分支包含，故两个依赖均改记“候选待 main”。
本轮只更新依赖状态，不摘取候选、不复制 parser、不新增/重复测试；序列字段逻辑仍由 L07 在正常 main 后实现。

### 已完成本轮可执行核差（自动续派收尾，2026-11-05）

`git merge --no-edit main` 返回 Already up to date：main 仍为 `fb463060d`，本分支为
`f346c8996`，工作区干净且没有未自检提交。`f346c8996` 官方 lane-gate 五项全部通过；
新增 receipt 的专项证据仍是 `20261104160847-32b8db` 2 passed / 10 过滤 skipped / exit 0，
没有本轮新增测试或独立验收结果。

§1 八类问题沿用上方已记录的源码核差/证据边界：自上轮没有新源码或主线变化，
没有理由重跑已签项、旧 AP 矩阵或再制造一轮计数审计。已完成本轮可执行核差，
不是宣称整 lane、完整 serde/D3 或生产消费已完成。
后续工作仍需 F4 两个候选方法正常进入 main，以及原 L04/L03/平台依赖或复核人具体反例；
这些条件尚未变化，暂没有可独立实施的新单元。保留 unknown/sequence 未关闭状态与 48 条 PTC pending，
不摘候选、不恢复停放 lane。请在依赖变化或有新指令时再续，不因自动续派重复已完成项。

## W02 — 可撤销 executor 登记正式合同（2026-11-05，C1 定向新任务）

只补 L07 提供方接缝，不改 L05/L04/L03；不宣称 PTC、admitted dispatcher 或全 roster 已接通。

- 正式 API：`AgentToolsService.registerToolExecutors(executors: readonly AgentToolExecutor[]): Disposer`，
  在本插件 `api.ts` 发布，返回类型来自 `host/kernel/api.ts` 的既有 `Disposer`。
  `ToolingService` 原样传回 registry 的 disposer。
- `AgentToolExecutorRegistry` 复用内核 `HookSet<readonly AgentToolExecutor[]>`：一次调用一个登记身份；
  输入数组即刻复制，`all()` 仍按调用先后及批内顺序返回新的扁平快照。重复项仍重复追加。
  disposer 只撤销该次批次，幂等；不按名称/执行器对象删除，不影响其他批次或旧快照，
  旧 disposer 不能撤销后续同名/同对象的重新登记。没有新建通用框架。
- caller 可 `scope.add(registration)`（内核 Scope），或在 Cordis `ctx.effect` 返回的清理函数中
  `registration.dispose()`。旧 caller 忽略返回值仍兼容，但**没有因此自动接入卸载清理**；
  L05 应在提供方正常 main 后绑定自己的生命周期。
- Rust 原追加语义依据 `chat_v2/tools/executor_registry.rs:201-207`；Host 的撤销身份语义按本次 C1 正式合同，
  复用 `kernel/primitives.ts` 的 HookSet symbol 登记和 Disposer 幂等消费，不改分发/权限/取消责任。

新增两条 W02 测试在 `tests/agent-tools-registry.test.ts`：真实 registry 的批次身份/顺序/重复/快照，
以及 `createTestHost` 安装两个注入真实 agentTools 的插件，绑定实际 `ctx.effect`→卸载→重装→旧 disposer 再次调用。
它们分别登记重复同对象与同名异对象，检查 peer/legacy 登记保留；不伪造 service/registry 或执行器分发。
原有两个正确测试和全部断言原样保留；TESTMAP 不变。

| 作业 | 范围 | 结果 / Errors |
|---|---|---|
| `20261105011855-53af62` | 新增 W02 两条，旧实现 | 2 failed / 2 过滤 skipped，exit 1；返回 undefined 捕获真实缺口 |
| `20261105012031-11326d` | registry 单文件含原两条 | 4 passed，exit 0，无 Errors 行 |
| `20261105012031-1f5444` | typecheck:host | exit 0，无 Errors 行 |

提供方验证不等于 L05 已消费或独立签收；旧 48 PTC pending、workshop reader 残差和平台限制保持原状。
源码/service/测试已被协调者检查点 `0e285101f` 保存；后继提交补 API 正式签名、文档及 Rust 引用订正，
必须连同检查点整体审阅，不把后继单个 diff 当作全部实现。

### W02 提供方已完成及正常 main 状态（2026-11-05）

正式自检 `b7b15fbdc`（main `536aad095`，已包含 L17 fixture `783aab5f7`）五项全部通过。
此前 `eb1f08b32` / `fe7f1c573` 的唯一 memory fixture typecheck 失败属当时前置，保留历史回执，
不把旧 4/455 提供方结果代替这次正式 gate。

本轮 merge 后 main 为 `dd564e12f`、HEAD 为 `a215c9820`；`eb1f08b32` 已是 main 祖先，
本插件相对 main 无差异，W02 提供方的公开合同/实现/测试已正常集成。
已完成本指定提供方接口单元，L05 消费可由 C1 沿既定安排推进；没有修改任何旧 caller，
不宣称其已绑定 disposer 或自动清理，也不签 dispatcher/PTC/全 roster。
现有定向回归证据为上表 4 passed / exit 0；本轮不额外手动重跑旧矩阵。
F4 `a1c87c360` 仍非 main 祖先，`skipIgnoredValue`/`endArray` 仍待正常 main，
unknown/sequence、48 条 PTC pending 与平台限制保持未关闭；当前没有新的可独立实施单元。

## WP-030 — workshop 持久化结构精确 serde 消费（2026-11-05）

关闭 B4 / X6-UD-0004/0005 的 IgnoredAny 与 visit_seq 两项残差。F4 的 `skipIgnoredValue`/`endArray`
已在 main（`b3264ae78`，`a1c87c360` 为祖先），BLOCKERS B4 的“候选待 main”已更正。

| 原结构（`skill_workshop_executor.rs`） | 字段顺序 / 缺省 | 生产入口证据（`tests/workshop-json.test.ts` WP-030） |
|---|---|---|
| `ProposalMeta` `:47-75` | 13 字段；前 7 必填，Option×3 与 Vec×2 `default`，`packageVersion` `default_package_version` | 序列形式 list→apply→状态改写保留 u64::MAX；7 元素序列用默认值 apply；reject 改写；6/0/14 元素、尾逗号、EOF、错类型、浮点 u64、标量的错误文案与列 |
| `ProposalFileMeta` `:77-83` | 3 字段全必填 | 嵌套序列 2 元素 invalid length、4 元素 trailing characters 及列 |
| `AgentWorkshopMarker` `:94-108` | 9 字段；`packageSha256`/`files` `default`，`packageVersion` 默认 1；`previousPackageSha256` 无 default（序列中必填） | propose_update 读取：序列 u64 饱和、缺 Option 占位/缺尾字段/多余元素→回退 0→版本 1；占位 null→42；map 缺 Option→42 |
| unknown 字段（三者 map 形式） | serde `IgnoredAny`（`de.rs:1102-1281`） | 200 层嵌套、孤立 `\ud800`、`1e400` 被接受；`[1,]` 报 `expected value`；坏 `\u` 报 invalid escape；marker 深嵌套 unknown 仍读出版本 |

既有断言更正一处：`tests/skill-workshop-executor.test.ts` 的
`X6-unchecked-decode proposal meta decodes like serde ProposalMeta` 原断言 `['not','a','map']`
得 `invalid type: sequence`，这正是本包要修的缺陷（serde struct 接受序列）；改为 Rust 实际的
`invalid length 3, expected struct ProposalMeta with 13 elements at line 1 column 17`，另补标量
`7` 的 `invalid type: integer \`7\`, expected struct ProposalMeta` 以保留“非结构输入报 invalid type”的覆盖。
其余断言、TESTMAP 去向不变（本包不涉及 TESTMAP 行变化）。

未扩本包：`writeProposalMeta` 未实现 `skip_serializing_if = "Vec::is_empty"`；`SkillWorkshopExecutor`
的 `agentTools` 登记与 `execute` 包装已由 WP-146 补上（见 BLOCKERS.md B4）；PTC 中央 dispatcher（B1）仍独立 blocked；WP075 trim/limit 另后继。

## WP-125 — WP-075 activation/replay trim 与实际 u32 边界（恢复包）

承接 `f5dc69067`、检查点 `e386a989c`（activation 修复 + 7 条 IPC 测试）及未提交的 replay/status
trim 修复。历史先红后绿作业已经存在，恢复会话读取原日志，不重复造反证。

- `git show main:host/platform/util/index.ts` / `text.ts` 已确认 F4 公开 `rustTrim`，包含 U+0085、
  不含 U+FEFF。activation、candidate ID、list status 三处消费此正式实现；UTF-8 字节长度、
  255 上限、错误字符串、sessionId 原值及 repository 写入保持原行为。candidate helper 同用于
  replay/promote/rollback（Rust `skill_replay.rs:1292,1313,1336`）。
- 实际 u32 边界正确：正式契约 `L07-agent-skills-ptc.json:14-49` + kernel `checkArgs` 在 handler 前
  拒绝负数/小数/超 u32，不能把直接 helper 的 clamp 当成 IPC 漏检；只更正误导性注释，不重造校验。
- `tests/skill-candidates-ipc.test.ts` 仍走真实 `host.invoke`、默认正式契约、真实迁移 SQLite。
  原 7 条断言未改；增补 3 条验证激活全列/重复行/无候选无事件、类型/业务错误次序、501 行列表的
  default/null=50、0、500/501/MAX=500、候选表无写入。只 seed 本 lane 自有表，不冒充 A/B 场景 seed。
- SPEC 与 equivalence README 已更正实际 IPC 结论；TESTMAP 仅更正文末过时统计，去向列零变化：
  310 ported / 41 pending（PTC runtime 28 + workshop 13），不恢复 workshop 资格。
- B1 早期“main 无 registry 消费”描述已过时：本次 main 有 L04 registry 和 L03
  `src/tool-executor-binding.ts`，但不以存在这些实现签收整 roster/独立复核。

| 作业 | 证据范围 | 结果 |
|---|---|---|
| `20261105195531-e3d4db`（承接） | 原 7 条，修前真实入口反证 | 6 failed / 1 passed / 0 skipped，exit 1；u32 一直正确 |
| `20261105195640-e59af7`（承接） | 原 7 条 + skill-usage 21 + skill-replay 22 | 50 passed / 0 failed / 0 skipped，exit 0，无 Errors |
| `20261105195640-665f76`（承接） | typecheck:host | exit 0，无 Errors |
| `20261105203213-f9d5a9` | 扩充后 IPC 10 条，Linux Node | 10 passed / 0 failed / 0 skipped，exit 0，无 Errors |
| `20261105203213-a1ddc9` | 扩充后 IPC 10 条，Linux Electron-Node | 10 passed / 0 failed / 0 skipped，exit 0，无 Errors |

本包仅修上述已证实输入差异；F1 result budget、WP-152 空 Vec、全域 trim 和场景 normalize 不变。
仍无 A/B golden，不计 C 级；实际 utilityProcess/打包/三平台不由 Electron-Node 结果替代。
提交并 merge main 后直接调用官方 lane-gate，其作业回执与最终 tip 随 WP-125 报告交付。
恢复源码/测试/规格已由协调者检查点 `769f0dce9` 保存；应连同 `e386a989c` 和最终收尾提交整体审阅。

## G1：`skill_market_search {}` 超出 5s 预算（2026-11-06）

归因：不是挂起。X1 冒烟机器有真实网络，`{}` 走 `GET /api/v1/skills` + `POST /security-verdicts`
两次串行真实请求；本机冷连接实测 2509 ms + 1763 ms，历次冒烟 1051–4993 ms 成功、5000 ms 处超预算。
Rust 同样串行两次请求、reqwest 10 s 超时，未改超时，也未加全局超时。

无网络时 DNS 立即失败（`unshare -rn` 下 fetch 214 ms 得 `EAI_AGAIN`），promise 正常 reject。
本次修正的是错误文本：transport 原先吐出 undici 的 `fetch failed`，现按 reqwest 0.11 `Error` Display
输出 `error sending request for url (<url>): <source>`，deadline 触发时 source 为 `operation timed out`。
OS 层 source 文本（Node `getaddrinfo EAI_AGAIN clawhub.ai` 与 hyper `dns error: …`）仍不同，属平台残差。

| 作业 | 证据范围 | 结果 |
|---|---|---|
| `20261106023923-95512f` | offline 生产入口 + skill-market 26 条，Linux Node | 27 passed，exit 0；`{}` 127.6 ms |
| `20261106024116-3017d1` | 同上，Linux Electron-Node | 27 passed，exit 0；`{}` 101.1 ms |
| `20261106024206-a05a3a` | tsc tsconfig.host.json | exit 0 |

错误值：`{"code":"IO_ERROR","message":"IO error: Community skill marketplace request failed: error sending request for url (https://clawhub.ai/api/v1/skills?sort=trending&limit=24&nonSuspiciousOnly=true): getaddrinfo EAI_AGAIN clawhub.ai"}`。
冒烟要稳定通过需由 X1 断网运行网络命令或给市场命令单独窗口；本 lane 不调整预算。

## quality.md §2.4：`skill-workshop-executor.ts` 按职责拆分（2026-11-06）

原 1255 行按职责拆为三份，函数体逐字搬移，未改行为：
- `src/tools/skill-workshop-package.ts`（264 行）：包路径布局、大小限制、内容校验、包哈希、风险评估。
- `src/tools/skill-workshop-proposals.ts`（421 行）：`skill_proposals` 存储、serde 兼容的元数据解码、proposal id、审批 revision 校验。
- `src/tools/skill-workshop-executor.ts`（606 行）：`SkillWorkshopExecutor` propose/apply 与工具名判定。

`api.ts` 导出名单不变，只改来源文件；测试与 `skill-workshop-tool-executor.ts` 改为从新文件导入。

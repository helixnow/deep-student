# L07 v2 续作阻塞（2026-11-04）

WP-125 恢复核对：本包 activation/list/replay trim 与 u32 边界无外部依赖阻塞；F4 `rustTrim`
已在 main，直接消费公开 `platform/util/index.ts`。本文早期 B1 的“main 无 registry 消费”不是
当前全仓状态：L04 已发布 registry，WP-146 已有真实 registry.execute 测试，当前 main 亦含
L03 `src/tool-executor-binding.ts`。整 roster/独立复核仍未闭合，本包不据此升级资格。
TESTMAP 实际 pending 41（PTC runtime 28 + workshop 13），下文 48 为历史记录。

## B1 — L04/L03 生产 registry/dispatcher 消费（其他 lane 未发布）

- 已发布：`api.ts:326–328` 的 `registerToolExecutors` / `toolExecutors`；
  `index.ts:222–236` 注册真实 `PtcToolExecutor`，适配器在
  `src/tools/ptc-tool-executor.ts:54–88,108–129` 传递中央准入与子上下文。
- 所需消费：L04 的生产 registry 接收 `agentTools.toolExecutors()`，L03 在实际
  tool loop 中使用该 registry 并提供 `ExecutionContext.admitted_tool_dispatcher`。
  Rust 对照：`src-tauri/crates/dstu-agent/src/chat_v2/pipeline.rs:153–196`。
- 当前证据：合并 `main` 基线 `2ee9a9cbe` 后，检索 `host/**/*.ts` 的
  `toolExecutors(`，除定义/注释外只有测试调用；`chat/api.ts:94–106` 仅发布
  dispatcher/executor 接口，未发布实际 registry；`host/kernel/agent-wiring.ts:41–49`
  也是明确等待 L04 的只读接口。
- 最新 main 合并提交 `eab01c0f3` 未带入 chat 的 registry 实现；L03 的
  `host/plugins/chat-pipeline/BLOCKERS.md:14` 记录 L04 分支 `1a056a918` 已有
  `createExecutionContext/createExecutorRegistry`。这里阻塞的是 **main 可消费的生产组装**，
  不是声称 L04 分支从未实现；L03 的真实准入 dispatcher 仍由其负责。
- 影响：TESTMAP 中 `ptc_executor.rs` 15 行、`ptc_runtime.rs` 33 行均改为 pending；
  原测试文件和全部断言保留。`tests/ptc-production-wiring.test.ts:106–111` 从列表直接
  调用执行器，其 dispatcher 是外部 seam，不是 L04 生产消费证明。
- 解锁：L04/L03 消费方合入 main 后，走实际 registry/dispatcher 的调用验证审批、
  预算、超时和取消；由 R1 复验签收。不能在 L07 复制中央准入作为替代。

- X6-LP-0027 接口请求（给 L04）：Rust `ptc_executor.rs:496-538` 用 `catch_unwind` 区分
  准入拒绝（`Ok(Err(msg))`：合成失败块、发事件、落库）与执行器 panic（`Err(panic)`：仅
  `log::error!("[Ptc] Sub-tool dispatch panicked: …")`，返回 `task panicked: …`，不落块）。
  `chat/api.ts:94-96` 的 `dispatchWithAdmission(): Promise<ToolResultInfo>` 把两者都表现为
  rejection。需要 L04 约定其一：准入拒绝用可识别的错误类型/码（如 `AdmissionRejected`），
  或以 `{ rejected: string }` 结果返回；其余异常视为 panic。L07 在接口到来前不猜测分类。
- 多个执行器的 `execute()` 包装（保存工具块失败 warn 等，见 LANE.md log-parity）尚未移植，
  与本阻塞同根：等 L04 registry 的执行器接口落地后一并接入。

## B2 — 平台执行与打包证据（协调者暂缓）

- C1 08:21Z 指令明确：确认外部阻塞后休息，PTC 真实消费、Electron/打包、Windows
  原生验证尚未具备，不用增加 helper 测试闭合；正常 main 或具体复核反例到达再续。
- 本次新增 Linux Electron-Node 证据：作业 `20261104103803-87f052`，
  `npm run test:host:electron -- host/plugins/agent-skills --maxWorkers=1`，
  34 文件 / 436 passed，exit 0，输出没有 Errors 行。它使用 `ELECTRON_RUN_AS_NODE=1`，
  **不是** utilityProcess、打包、macOS 或 Windows 验证。
- 剩余：实际 utilityProcess 内 ZIP worker 入口可加载、打包资源路径、Windows/macOS
  原生文件行为；需要 F2/C2/协调者提供目标宿主与 runner。
- 当前 pool 是 lane 自有 `worker_threads` 池（`src/workers/zip-pool.ts:9–12`），
  不宣称已接平台统一池。需要平台方确认池接口/归属及目标宿主支持。

## B3 — 独立复验

- R1 已在正常 main 独立签收 02/03/04/06/07 及 D3 指定修复（`a72ef7dee`/`bf6479dc8`）。
- L07-05 两处 Host 同步 IO 残差：R1 main 复验签收（`ce6bab375`，ACCEPTANCE §12）。
  01 与平台验证不随之升级。

## B4 — X6-UD-0004/0005 精确残差（不称完整 serde/D3）

- **已关闭（WP-030）**：原“候选待 main”已过时。`skipIgnoredValue` 与 `endArray` 已在 main
  `b3264ae78` 的 `host/platform/util/json-exact.ts:368,390`（`git merge-base --is-ancestor a1c87c360 main`
  exit 0），经 `platform/util/api.ts` 公开的 `JsonReader` 消费，未复制 parser。
  `src/tools/skill-workshop-executor.ts` 的 `serdeStruct` 现按 serde_json `deserialize_struct`
  （`de.rs:1820-1866`）分派：map 形式的 unknown 字段走 `skipIgnoredValue`（IgnoredAny，
  `de.rs:1102-1281`：无递归上限、不配对 `\u` 代理项、不检查数字范围，只查词法）；
  序列形式按 serde_derive `deserialize_seq`/`expr_is_missing_seq`（`de.rs:451-550,805-835`）
  的声明顺序读取，耗尽时用显式 `#[serde(default)]`，否则 `invalid length N, expected struct X with K elements`，
  读满后 `endArray` 报尾随元素/逗号/EOF。`AgentWorkshopMarker.previousPackageSha256` 无 default：
  map 缺失为 None，序列中必须占位。u64/usize 经 `readUnsigned` bigint，不经 Number。
  证据：`tests/workshop-json.test.ts` “WP-030 …” describe，经生产 `SkillWorkshopExecutor` 的
  list/reject/apply/propose_update 真实文件读写。
- 未扩本包：`writeProposalMeta` 序列化未实现 Rust `skip_serializing_if = "Vec::is_empty"`
  （空 `files`/`previousFiles` 仍写出 `[]`）；读侧等价不受影响，另起后继。
- 生产接线（WP-146 更正，原“尚未登记”已过时）：`index.ts` 在 `registerToolExecutors` 中登记
  `SkillWorkshopToolExecutor`（`src/tools/skill-workshop-tool-executor.ts`），即 Rust
  `pipeline/roster.rs:72` 的 App roster 条目，`execute` 照 `skill_workshop_executor.rs:1263-1323`
  （start→end/error、`ToolResultInfo` success/failure、截断毫秒 duration、save_tool_block 失败 warn；
  `window_ref()` panic 只留 start 事件不落块）。证据：`tests/skill-workshop-production-wiring.test.ts`
  装官方 profile，`agentTools` 恰一个该执行器，经 `chatSession.createExecutorRegistry` + 
  `createExecutionContext` 的 `registry.execute` 跑 propose/list/reject/apply 与 WP-030 解码；
  去掉登记后同测在 `toHaveLength(1)` 失败（反证）。provenance 经 F4 `settings.*WithConn(main_db, …)`。
  完整 App 花名册仍缺其他 lane 执行器（`MissingExecutorError`），L03 真实 tool loop 消费仍属 B1；
  需 C2 独立复核后才能关闭本生产接线缺口，本包不自签。
- workshop 的 `propose/list/apply` 返回 Host 内部对象，不是最终 IPC。
  已撤销其中 `packageVersion/files.size` 的提前 Number 转换；正式 wire 尚无生产调用点可核验，
  WP-146 执行包装只在 `ToolResultInfo.output` 边界把 bigint 投影为原生 `JSON.rawJSON` 原子：
  `tool_output_json` 与事件 `payloadJson` 保留 `18446744073709551615` 原数字，内部返回值仍为 bigint。
  残留：kernel `applyToolResultBudget` 在超 30000 字符截断时用 `Object.entries` 遍历，会破坏原子
  （仅在含 >2^53 值且超预算时），归 kernel/L04，不在本 lane 改。
  调用证据和专项测试见 LANE.md“内部返回值纠正”；48 条 PTC pending 不变。

## 待裁定语义差异（不自行批准）

沿用 `ACCEPTANCE.md:125–130`，不是本轮新增能力：

- ZIP 的 zlib / Rust miniz_oxide 压缩字节可能不同，影响包 SHA256（`SPEC.md:386`）；
  需要 F7/F4 同字节实现/向量或架构师明确裁定，现有 level=6 不能证明等价。
- 原子目录交换使用 Rust fallback 的 live→backup→staging→live，Node 无 renamex_np；
  不声称 crash/并发读原子性等同 exchange（`SPEC.md:205`）。接受范围需裁定。
- 当前无新 npm 依赖申请；F7 Starlark 引擎已满足，不把它列为缺失依赖。

## 仓库级门禁（不属于本 lane 实现）

作业 `20261104095823-d591c5` 的 strict boundaries exit 1；4 个违规分别是
`host/plugins/vfs/repository/create.ts:41`、`folders.ts:22`、`resources.ts:126`、
`update.ts:33`。完整输出没有 `host/plugins/agent-skills/` 命中。

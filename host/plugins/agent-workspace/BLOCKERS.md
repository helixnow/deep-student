# L05 续派盘点：剩余跨 lane 接口与消费方

## WP-063 当前边界（2026-11-05）

- 当前 TESTMAP 实际为 370 ported / 10 pending / 21 obsolete；下文 359/21 和 outbox 9、
  false/OCR 2 尚未接入是旧阶段记录。56c84575c 的 9+2 映射保持原状，独立抽检另行进行。
- X3-L05-02 原证据 `/home/dsdev/.oc-jobs/done/20261105142528-6d4c3d.{json,log}`：
  exit 1，3 passed / 1 failed，历史 count=1 而 peek=[]。本包复用恢复 InboxManager 到
  instance/router；新增真实 Host 重装测试只证明生产恢复链，不冒充历史发行版差分。
- 历史 seed 等待已解除：C2 `20261105164200-825edc` exit0，产物
  `/tmp/opencode/c2-wp063-seed-20261105-1643/historical-wp013-v1/app-data/slots/slotA/workspaces/ws_ws_old.db`
  已只读复制至 `tests/fixtures/wp063/ws_ws_old.db`。V1 八业务表及 sequence、
  ws_old/worker_old/message_old/unread1 已核；来源 `41a5ca8f1`，SQL 构造非 A 产物。
  Host 测试只打开临时副本，Node/Electron 两项均通过（job 20261105172756-1c1da7/80830b）。
  X3 原测试仍在其分支，C2/X3 可组合本包精确 tip 验收；不再等待其红灯先合 main。
- v0 正式格式只有 cmd；peek/drain 为服务方法，无对应 IPC。已补现有 L04 IPC 触达本域的
  两个场景；本包历史 Host 服务回归已实跑，原 X3/C2 组合签收及后继 A/B 仍独立进行。
  A/B 尚未运行，不计 C。C2 合 main 后独立签收仍未完成。

本轮合并 main 后检查公开 api.ts 与实际生产调用点。12/12 IPC 命令均为 A，
wiring 的 ported 测试需结合 X6 的符号可达核对；TESTMAP 现为 359 ported / 21 pending /
21 obsolete（C1 已逐 ID 批准，ledger 分片读取已合入）。新增接缝测试不更改原 Rust 行的状态。

## 待接入方（11 pending）

| 缺什么 | 提供/消费 lane | 影响 | 当前证据与本 lane 已完成部分 |
|---|---|---|---|
| L04 非多模态 resolver 调用 | L04 | `test_non_multimodal_image_request_downgrades_to_ocr`、`test_non_multimodal_pdf_image_request_downgrades_to_ocr` 2 项 pending | L03 history 单元本次已合入 main；`index.ts:172–174,374`、`src/history-vfs-context.ts:98` 真实消费 `resolveContextRefDataToContent(data,true)`，10 项已改 ported。两个 false/OCR 分支仍需 L04 variant 调用，逐项证据见 TESTMAP。 |
| 完成闭包入账、自投递后收敛，以及租约 dispatcher | L04 | `workspace/completion_outbox.rs` 9 个测试 pending；完成通知重启恢复 | chat 中无 `CompletionOutbox` / dispatcher 消费。`agentCompletionOutbox` 已从 index 发布，api.ts 提供状态/输入类型与 `completionMessageExists`。F3 chat_v2 V20260908 负责 schema。不得在 L05 复制 L04 调度链路。 |

以上服务已装配并测试真实 kernel 生命周期；L03 消费代码已合入 main，L04 false/OCR 与 outbox 消费方仍缺失。
L18 已发布 `DocsCordisService.extractTextFromBase64`，此前“docs provider 未发布”阻塞已解除。

另外 X6-PR-agent-workspace-workspace-injector-1 已核实 5 项未接入：Rust pipeline/tool_loop.rs:483,2384–2396
使用的 InjectionThrottle/WorkspaceInjector 在当前 Host L03 尚无调用。L05 已从 api.ts 公开原实现和
最小 WorkspaceInjectionCoordinator；5 行 TESTMAP 改 pending，待 L03 复用每次 pipeline 的同一 throttle。
已解除（WP-149）：L03 WP-061/623da2d24 已在 main，`chat-pipeline/src/tool-loop.ts:224,650` 每次 executeWithTools
共用一个 throttle，`src/execute.ts:362` idle 另建；5 行改回 ported，调用链与 job 见 TESTMAP。

## 其他真实跨 lane 阻塞

W02 WorkspaceFs唯一等待已解除：main `dd564e12f` 含L07正式注册Disposer，L05已实现
单个真实贡献适配和同scope释放候选。真实profile定向job `20261105033649-067eb3` exit0，
不含provide替身，degraded=[]且恰一WorkspaceFs execute；权限/窗口/取消与卸载重装证据见SPEC/LANE。
其余执行器工厂、完整chatToolRuntime与全52/57 roster不在本单元签收范围。

回执解码已补typed from_value字段/enum/seq/u64规则；Host对象输入中的number按前端JSON
十进制表示解释，内部bigint精确保留。但上游若已把模型JSON的1.0/1e0转换成JS number 1，
当前JsonValue类型不保留原lexeme，L05不能还原Rust arbitrary_precision Number的词法区别。
此项需上游值模型合同确认，不以本次decoder回归宣告raw模型数字全域等价；详情见SPEC。

ACL/helper进一步审读确认具体接口缺口，已送F7/C1/C2：DACL读取需返回原保护位，普通grant/revoke
写入必须支持保留继承状态，SetEntriesInAcl/ACE构造与SID比较需正式native面，createProfile需
接收原capability列表；Host/Electron尚无helper早期分发/stdio/取消桥接。Rust行号与请求详见
native-needs.md最新节。没有在L05猜ACL二进制或以provider存在代替完整沙箱；四项AppContainer/
取消原测试继续pending。原生身份候选与Windows目标平台验证也仍单列。

R2-W3 root identity 新候选：已移除Windows的Node dev/ino身份近似，改用Context F7
runtimeRootIdentity并透传至授权/重验/信任/审批绑定。L04/L19直接调用公开settings型helpers时
需传末尾windowsFiles；RuntimeRootDeps须携带该服务，RuntimeRootsService消费者无需改形状。
本lane工厂已绑定按次getter；Windows目标平台验证与ACL/helper仍缺，原五pending不改。

C1 最新基线确认：main `ccba04837` 已含 `52fb28a22`，preview index 配套缺口解除。
本轮 workspace-change-set 读流增量遵循其自己的 Rust OpenOptions 策略：Windows
没有 preview 的 reparse flags，不把不存在的原生步骤引入迁移；复用 RuntimeReadFile
读取/清理，同时修复已确认的 missing expected_current_hash 错误优先级。
root identity、ACL/helper 与目标Windows验证仍是未完成项。

F3 owner 注册等待已解除：main `80dcc5291` 已公开正式接口，本轮 `index.ts` 已用
`ctx.effect` 接入并随 scope 释放。此前四项删除测试失败涉及缺少该注册；本轮补齐
生产 apply 与 standalone fixture 的真实 owner，保留原失败/恢复断言。

R2-W3 后续单元已接入 preview 的 F7 opened-handle 有界读取（候选，Windows 尚未运行）；
root identity、backup/workspace reader 及 ACL/helper 尚未闭合。新增 Windows IPC 测试按
目标平台运行，不改变五项 pending 或独立 ACCEPTANCE 的判断。

接续增量已把 shared reader 连接到 backup/restore/hash 与 workspace read/edit（候选待门禁）；
root identity、workspace-change-set 独立 reader、ACL/helper 仍为实现余项。C1 核验
`01c074ecf` 仅含 preview 读取实现，缺 `52fb28a22` 的 index 配套 hunk；须正常集成完整
候选才可认为命令链路接通，Linux 通过与分支实现不替代 main/Windows 证据。

| 缺什么接口 | 责任 lane | 影响命令/测试 | 判定依据与当前行为 |
|---|---|---|---|
| 同步 `governance.tryAcquireOperationGuard('delete_propagation')`（提供方已合入） | L21（D2 唯一许可） | R2-W2 的共享许可子项 | main 已合入 L21 正式 API/真实 provider；L05 index 绑定同步 try 方法，忙锁立即失败，保留 Error.message 字符串，finally release。不是等待型 acquireOperation，也不使用其他 kind/本地锁。 |
| `chatSession.deleteSessionV2(sessionId)` 候选合入 | L04／协调者集成 | 删除工作区后 worker ChatSession / runtime root 清理 | 候选 b0ed6a135 的 api.ts 已声明、src/service.ts:90 在 immediate 事务调用真实 deleteSessionHard；当前 main 仍缺该方法。L05 已绑定按需取 chatSession 的消费接缝，先 runtimeRootCleanup 再业务删除；不直接写 chat 表。未据候选声明整链通过。 |
| executor roster 注册/审批上下文透传（WorkspaceFs单项已补候选） | L04／各executor owner | 本 lane其余executor及完整聊天工具组合 | WorkspaceFs已用L07正式scope registration贡献真实execute，L04公开context/registry消费测试通过；其余factory不铺空注册，完整chatToolRuntime仍单列。 |
| 接受 `SqlExecutor` 的 deletion-journal 接口（提供方已解除） | F3 | 工作区 DB 删除、恢复与队列重放 | main storage/API.md §10 已正式公开该端口。L05 本轮移除本地 journal 写入副本、改用共享函数；chat_v2 journal 借用连接按 Rust Drop 全路径关闭，真实 SQLite 回归验证失败不删 metadata/file 与重建取消 ready。 |
| L05 Windows 策略/handle 适配与目标平台验证 | L05／Windows 验证环境 | SPEC 未勾选 Windows IO 文案；Windows runtime-root/shell 5 项 pending | F7 正式 readAt/refreshInformation/runFullAccessJob/acquireAclMutex 已随 main 合入；L05 同 handle 读/复核、ACL保护子树/helper协议尚未装配，不能把 primitive 存在当完整策略。Linux Context adapter 已真实验证，不代替 Windows 验证。见 native-needs.md。 |
| chatanki 消费本 lane 卡面只读 scope 注册表 | L24 | worker 对 coordinator 卡面的只读访问 | chatanki/src/card-access.ts 仍持有自己的 Map；L05 api.ts 已发布 installWorkspaceCardReadScope/workspaceCardReadScope。 |
| 21 个 dead-adapter obsolete 审批（已解除） | C1／协调者 | R2-W4 审批子项 | 本轮提交前已合入 migration/approvals.d/C1-app.json 与 ledger 分片读取，21 项机器可核验、ledger --check 退出 0。本 lane 未改审批文件；仅审批子项解除，不宣告 B。 |

## 本轮自有单元

- artifact/backup/restore的同类短写与错误上下文修复：共用本lane writeAll，保留各Rust
  调用点的错误前缀和临时文件/backup清理顺序。原单元workspace staging继续用同一函数。
  当前main `5b1b19055` 已含L24 index.ts:319异步agentTransformSandbox消费；仅记录实际
  生产引用，不以接口存在或Linux其它测试代替L24端到端/Windows验证。

- 自查新增workspace staging修复：原Rust write_all/sync_all前缀及短写/Interrupted/零写语义。
  此单元仅修改workspace-change-set原子写入与回归，不重复preview/native身份，也不改变
  ACL/helper待正式接口的状态。跨lane请求由C1集中留交接，不再重复投递F7/C2。

- `c76e58868`：VFS resolver 生产服务装配，缺依赖明确报错；验证 docs 延迟加载/卸载。
- `3876393ff`：删除恒成功治理守卫，保留 Rust 先获取操作权再删除的顺序。
- `196c6c487`：outbox 生产服务、按操作重新借用 active DB、平台固定毫秒 UTC 时间；验证幂等/owner guard/切库。

剩余 SPEC 未勾选项只涉及上述 Windows 原生错误文案。无本 lane 未达 A 的 IPC 命令。

## 2026-11-04 Linux 恢复与验证

- `a27fa6c10`：resolver 消费 L11 的 `vfsRepo`；测试先复现旧服务名导致的错误再修复。
- `90d38983c`（协调者自动检查点）：LSP 真实 initialize 测试恢复，5 秒 version 探测与
  20 秒初始化超时；终止等待进程退出。Linux 未安装 rust-analyzer，沿用 Rust 的早退分支。
- 去除 Seatbelt 的额外环境变量 opt-in，按 Rust macOS cfg 执行；Windows 测试仅按平台
  跳过，不再以原生能力恒不可用掩盖失败；补回网络测试的无 TCP 连接断言。
- 以下 5 行从 ported 校正为 pending（F7 未发布能力，非本 lane 自有实现阻塞）：
  1. `windows_runtime_root_and_file_identities_use_handle_information`：CreateFileW / GetFileInformationByHandle / opened-handle reparse 检查。
  2. `appcontainer_writes_only_inside_selected_cwd`：AppContainer profile、SID/ACL 与受限进程启动。
  3. `appcontainer_blocks_protected_subdirectory_writes`：同上，含 protected subtree ACL。
  4. `appcontainer_denies_network_without_capability`：SECURITY_CAPABILITIES 网络权限。
  5. `cancellation_prevents_late_process_launch`：原生 cancellation event 与 Job Object；当前测试内运行时注入仅验证 L05 分支，不算原生端到端完成。
- 本次 typecheck 通过；Node 与 Electron 均为 33 文件、396 passed / 21 平台 skipped。
  未增加 npm 依赖；未修改 IPC/api.ts 对外形状；保留既有 Rust 行为，无新增 Rust bug/语义歧义。
- ledger 计算：命令 A 12/12（100%）、B 0/12（0%，review 缺失；delete_artifact SPEC 6/7）；
  Rust 测试 A 354/401（88.3%）。21 个 obsolete 尚未批准，全仓 ledger 退出 1。
- strict boundaries：本 lane 0 条未豁免违规，全仓因其他 lane 违规退出 1；wiring 354 ported / 0 未接线；importable: ok。
- TESTMAP 生成表头仍是旧计数，按禁止改 GENERATED 区的要求保留；实际行状态与区外统计为准，待协调者刷新。

## C1 04:25Z / R2 续作修复与复核

独立 `ACCEPTANCE.md` 已随 main 合入，保持验收人勾选原样；以下仅为实现方修复证据。
协调者检查点在验证期间自动保存了代码，因此同一单元的代码与行为记录分属下列提交。

| 编号 | 修复提交 | 真实生产入口 | 回归测试 |
|---|---|---|---|
| C1 liveExecutor receiver | `6c25d23f3`、`bf1620ea0` | index 提供 agentWorkspace → createWorkspace/Repo → liveExecutor；每次借用后 apply(target,args)。同一 SQLite 回归还修复 enterMaintenanceMode 设置 flag 后自我拒绝 checkpoint 连接的问题 | tests/workspace-storage-wiring.test.ts（F3 真实 SQLite；创建、消息、维护拒绝、重开、关闭） |
| R2-W1 | `e6d8cce50`、`04b3b0db0`、`36432c7f8` | index 的 roots/authorize/set/reset/trust/read IPC → runtime-roots.ts → runtime-root-records.ts | tests/runtime-root-errors.test.ts（13 项，注入底层失败后断言完整 IPC 字符串；缺字段/错误类型/重复字段/默认/enum map/序列结构） |
| R2-W5 | `0f6b51ed1`、`4c990bf9b` | chat_v2_list_runtime_directory → parseRuntimeDirectoryCursor → listRuntimeDirectoryPage | tests/runtime-directory-cursor.test.ts（2^53、2^53+1、usize::MAX 合法；越界/负数/尾随换行非法；目录耗尽空页） |
| C1 L04 公共 manager/event API | `353a994fc`、`72cf6669f` | agentWorkspace.getTaskManager/getSleepManager/emitWarning/emitCoordinatorAwakened | tests/public-api-wiring.test.ts（真实 F3 数据库与 kernel 事件，类型从 api.ts 消费） |
| C1 L03/L19 公共授权面 | `353a994fc`、`72cf6669f` | api.ts 导出 immutableShellCommandGuard、HEADLESS_ALLOWED_TOOLS、runtimeRootById/revalidateRuntimeRoot/authorizeRuntimeRootPath；同一实现已在 shell executor/runtime-root IPC 调用 | tests/public-api-wiring.test.ts（guard 决策、白名单不含 browser、只读授权及撤销后拒绝） |

最新验证（本工作树，Linux）：

- `npm run typecheck:host`：退出 0。
- `npx vitest run -c vitest.host.config.ts host/plugins/agent-workspace --maxWorkers=2`：退出 0，37 文件，413 passed / 21 平台 skipped。
- `npm run test:host:electron -- host/plugins/agent-workspace --maxWorkers=2`：退出 0，同为 37 文件，413 passed / 21 平台 skipped。
- `npm run migration:boundaries:strict`：全仓退出 1；`DSTU_BOUNDARY_STRICT=1 node scripts/electron-migration/boundaries.mjs host/plugins/agent-workspace`：退出 0，116 文件、0 violation、15 suppressed。
- `npm run migration:ledger -- --check --no-write`：提交前合入审批读取后退出 0；本 lane 命令 A=12/12、B=0/12，测试 A=375/401（93.5%）、B=21/401（5.2%，来自已批准 obsolete）。
- `npm run migration:wiring -- --lane agent-workspace`：退出 0，354 ported、0 未接线。
- `node scripts/electron-migration/importable.mjs host/plugins/agent-workspace/index.ts`：退出 0，importable: ok。

仍未完成：R2-W2 的 chatSession.deleteSessionV2 候选合入及三插件整链验证（L21 同步许可已在后续 main 提供并由 L05 接入）；
R2-W3 的 Windows native 5 项、IO 文案未闭合；R2-W4 的 26 pending、生成表头与独立复验未闭合（审批分片读取已解除）。
L03 history 文件在其分支，但本树当前 main 仍无该文件；12 resolver 状态不变，两个 false/OCR 分支继续等 L04。
本次未运行 Windows/macOS，未验证当地原生能力；LSP 的真实 server 握手在 Linux 无 server 时按 Rust 早退。
未申请新 npm 依赖；无新增 Rust bug/语义裁定，修复均对齐所列 Rust。

W1 收尾随新合入 D3 一并校正：按声明顺序重建 identity，JSON 键重排不再误判 stale；
u64 记录读取、写回与既有授权摘要保留大整数（2^53+1、u64::MAX 回归通过），
不把这些数值经 Number 舍入。此项没有消除 Windows 原生来源/打开句柄校验的 W3 阻塞。

## C1 04:40Z / 05:20Z 续作

- 已完成单元不重做：receiver `bf1620ea0`；W1 `e6d8cce50/04b3b0db0/8aeccc36b`；
  W5 `0f6b51ed1/4c990bf9b`；公共 `HEADLESS_ALLOWED_TOOLS`、`runtimeRootById`、
  `revalidateRuntimeRoot`、`immutableShellCommandGuard` 在 `api.ts`，`353a994fc/72cf6669f`。
- L13 具体端口对齐：`git show ds-mig/L13-vfs-api:host/plugins/vfs/src/tools/dstu-executor.ts`
  的 DstuUploadRoots 是 rootById(rootId,ctx)/revalidate(root)，消费方 inject `runtimeRoots`。
  `99e430bd5` 新增真实 `runtimeRoots` provider、api 类型和两项 Host 回归；提供当前 session_id、
  skill_package_roots，create=false，依赖当前 settings，不只是路径类型导出。
  L13 消费仍只在其分支，不据此宣告 DSTU 上传生产注册已完成。
- X4 W08：代码 `f6c5c2964`、行为记录 `b064628b3`。index → agentWorkspaceTools.createCodeNavigation
  → executor 逐次获取 Context nativeRegex，compile/captures 经同一可替换提供方；不再直接导入
  native/regex/index.ts。公开方法已由 F7 提供，无新增平台 API 阻塞。
- 首次并行全插件验证 Node/Electron 均退出 1：两个真实迁移夹具超过原 30000ms；未改超时或断言，
  降为 maxWorkers=1 且串行运行后均退出 0（39 文件、416 passed / 21 平台 skipped，无 Errors 行）。
  首次 typecheck 达 120s 被终止，扩大命令等待上限到 300s 后退出 0。
- L03 main 接线复核：`npx vitest run -c vitest.host.config.ts host/plugins/chat-pipeline/tests/history-vfs-context.test.ts --maxWorkers=1`
  退出 0，5 passed，无 Errors 行；据 C1 指令解除 10 项 resolver 接线阻塞，剩余 16 pending。
- D2 仍依赖唯一 L21 操作许可；D1 删除调用仍等 L04 业务方法，不写 chat 表；
  D3 cursor/identity 已保留内部精度。Windows opened-handle/reparse/沙箱仍未验证且未闭合。

本次最新完整验证：typecheck 退出 0；Node/Electron 单 worker 两次均 39 文件、416 passed、
21 平台 skipped，退出 0，无 Errors 行。L03 历史集成 5 passed / exit 0。
ledger --check --no-write 退出 0，本 lane 命令 A 100% / B 0%，测试 A 385/401（96%）/
B 21/401（5.2%，已批准 obsolete）；wiring 364 ported / 0 未接线 / exit 0；importable: ok / exit 0。
全仓 strict exit 1；本 lane strict exit 0（118 文件、0 violation、15 suppressed）。
TESTMAP 当前 364 ported / 21 approved obsolete / 16 pending，不修改独立验收勾选。

## C1 05:34Z / 06:00Z：W1 错误顺序与 F7 候选

- W1 组合非法字段+截断：`a41769ee4`（代码检查点）/ `0dc99b5df`（行为记录），
  `readRecord` 在消费每个 map/sequence 字段时验证；重复键在读键后立即拒绝，authorized 数组逐项验证。
  真实 `chat_v2_list_runtime_roots` 回归包含 `{"path":null,"label":`，现在返回 path 类型错误而非尾部 EOF；
  原有效值、默认、u64 精度、声明顺序断言保持。独立 W1 勾选仍归 R2。
- F7 候选接口已逐文件核对（最近相关提交 `81f67a962`，见 native-needs.md）；当前 main 未合入，
  不再记“F7 无实现”。本 lane 自有 bwrap/Seatbelt descriptor 和策略已经通过公开 api.ts 发布；
  `agentTransformSandbox` 经 Context 获取候选 nativeSandbox，缺失时 capability/spawn 明确拒绝。
- L24 最小对齐要求：其 `runTransformScript` 先 `await capability()`，再准备解释器/job；
  在已有 setup try/catch 中 `await spawn()`，成功后启动 drain/wait timeout。新接口
  `AsyncTransformSandboxBackend` 不冒充旧同步接口，避免 pid 占位、启动错误错位与取消丢失。
  `TransformSandboxNativePort` 仅是 F7 候选 probe/spawn 的消费子集，原生实现未复制。
- Linux 实测 probe 作业 `20261104063952-a829d0` 退出 0（status=0、stderr=""）；
  `transform-sandbox-linux.test.ts` 真实执行本 lane 生成的 bwrap descriptor，确认 job 内可写、
  `.git` 保护子树与外部目录不可写、网络 namespace 不同。不是只测参数/可执行路径。
  adapter 接缝测试仅替换 F7 未合入的原生端口，验证 await 启动、完整 env、signal 原样传递、回收转发；
  不因此闭合 L24 7 项 e2e 或 Windows 5 项。

队列运行记录（重任务均由全局 jobs/job.mjs submit）：

| 作业 | 命令/范围 | result 退出码 |
|---|---|---|
| `20261104063247-a1230c` | W1 新回归，修复前 | 1，13 passed / 1 failed，复现 EOF 优先级错误 |
| `20261104063608-7cba5d` | Node runtime-root-errors | 0，14 passed，无 Errors 行 |
| `20261104063810-b3f324` | Electron runtime-root-errors + runtime-roots | 0，47 passed / 1 Windows skipped，无 Errors 行 |
| `20261104063810-52bbd5` | typecheck:host（W1） | 0 |
| `20261104064301-cab314` | L24 adapter，修复前 | 1，未提供服务导致 capability 失败 |
| `20261104064839-dc963d` | Node transform-sandbox-wiring + transform-sandbox-linux | 0，2 passed，无 Errors 行 |
| `20261104064839-384318` | typecheck:host（adapter） | 2，测试 vi.fn 泛型推断错误；已加公开端口签名修复，后续作业复核 |
| `20261104065253-765a2b` | typecheck:host（修复测试类型后） | 0 |
| `20261104065253-7be04c` | Electron transform-sandbox-wiring + transform-sandbox-linux | 0，2 passed，无 Errors 行 |
| `20261104065253-823440` | migration:ledger --check --no-write | 0，commands/tests/orphan problems 均 0 |
| `20261104065253-0c358c` | migration:boundaries:strict 全仓 | 1，14 violation（其他 lane）；本 lane 单独检查 121 文件、0 violation、exit 0 |

Windows/macOS 未目标平台验证；F7 合入后必须用真实 Context provider 重跑，不将候选接口或测试端口标为完成。

## C1 同步 DeletePropagation 纠正 / L04 b0ed6a135 候选

- L21 正式提供方已在 main（api 最近提交 `0980d8552`）：
  `governance.tryAcquireOperationGuard(kind)` 同步调用唯一 operations.tryAcquire，
  `acquireOperationGuard` 是同步同义入口，等待型 `acquireOperation(kind, timeoutMs)` 是另一方法。
  本删除路径只用 `tryAcquireOperationGuard('delete_propagation')`，按 Rust coordinator.rs:266–271 立即失败。
- L05 `531160218/ee5b57e54`（代码检查点）与 `e540fbb61`（行为/阻塞记录）：
  index 的 operationGuard 回调读取当前 governance、保留 provider Error.message 为字符串错误；
  Worker 列表/close/删除 DB/index/runtimeRootCleanup/deleteChatSession 顺序不变，finally 释放。
  没有文案猜测 busy/IO、没有局部锁、没有等待型请求或错误 kind 替代。
- L04 `b0ed6a135:api.ts` 的 ChatSessionService.deleteSessionV2 与 `src/service.ts:90` 的
  immediate 事务是真候选，当前 main 未合入。L05 `WorkspaceChatSessionDeletion` 只是精确消费子接口；
  index 按需调用 `ctx.get('chatSession').deleteSessionV2(sessionId)`，缺方法明确失败，不写 chat 表。
  真实整链验收仍待该候选合入，不以测试中的 L04 回调替身签署 W2。
- `workspace-delete-wiring.test.ts` 使用真实 kernel、F3 SQLite/迁移、L21 provider/共享许可、文件系统；
  仅 L04 候选端口替身。验证忙锁时 sleep/根目录/workspace 仍原状；成功删除时只清 worker，
  callback 时 DB 文件与 runtime roots 已删除，另一 backup/restore 请求仍被 DeletePropagation 阻挡；
  callback 抛错后其余 worker 仍处理且许可已释放。聚合错误沿用 Rust。

| 作业号 | 命令 / 范围 | result 退出码与结果 |
|---|---|---|
| `20261104071839-abafc0` | Node workspace-delete-wiring（接线前） | 1，3 failed，复现仍走缺 guard 默认路径 |
| `20261104072053-160558` | Node workspace-delete-wiring（接线后） | 0，3 passed，无 Errors 行 |
| `20261104072053-89f421` | typecheck:host | 0 |
| `20261104072437-19f7a8` | Electron workspace-delete-wiring | 0，3 passed，无 Errors 行 |
| `20261104072437-eb1e13` | Node workspace-coordinator + workspace-storage-wiring | 0，7 passed，无 Errors 行 |
| `20261104072437-074290` | migration:ledger --check --no-write | 0，command/test/orphan problems 均 0 |
| `20261104072438-3f9b19` | migration:boundaries:strict 全仓 | 1，4 条其他 lane 违规（3 empty-catch / 1 console-log） |
| `20261104073213-21bdb5` | 合并新 main 后 typecheck:host | 0 |
| `20261104073214-f56053` | strict 本 lane | 0，122 文件，0 violation，15 suppressed |

本轮未重做已经修复的 receiver、W1/W5；独立验收勾选保持原样。16 pending 与跨平台未验证状态未改。

## v2 自动续派 / F3-V2-05 / X6 冻结 ID

本轮优先合并已解除的 F3 SqlExecutor journal 接口，删除本地386行文件编排/队列表写副本。
`WorkspaceDatabase` 失败/早返/正常路径均关闭借用 journal，foreign_keys 配置失败恢复 Rust 独立前缀。
api.ts 新增既有 `deleteWorkspaceIndexWithConn(conn: SqlExecutor, workspaceId: string): void` 同义出口：
不另开事务/连接，不做物理删除，缺记录成功，底层 StorageError 原样透传。

F3 已以 `1c7e85967` 回执确认 `registerWorkspaceIndexDeletionOwner(owner): Disposer`，回调位置为
同一 SAVEPOINT 的 prepared INSERT 后、RELEASE 前，异常包装为 DeletionJournalError.Database 并回滚。
候选尚未 main；待其正式导出合入后 L05 index 用 ctx.effect 注册/释放，不直接依赖候选实现或静默跳过。

已将 C2 `0119143715c0bab2d8f698b7c1d58651358e85be` 冻结 ID 映射到 LANE.md「v2 排雷清单」。
本轮额外确认并修复 X6-AP-0032（原风险判定缺失）、X6-AP-0037（原外层预算 no-op 未真正调用）；
其余 assert 计数线索逐向量/tuple核对，不以数量添加重复断言。X6-PR-0005/0006/0007 确认缺生产消费，
已公开原 Injector/Throttle 与最小 coordinator 依赖；5 个原测试改 pending，待 L03 tool loop 复用执行级 throttle。
此变更不迁移 L03 tool loop、不新增假调用，当前 **359 ported / 21 pending / 21 approved obsolete**。
UD/LP 待核项保留清单，不宣告已经整改；独立验收勾选不变。

| 作业 | 范围 | result 结果 |
|---|---|---|
| `20261104120527-e2020d` | 初始 lane-gate，d84e29565=main | exit 0，2 项通过（无本轮新改动） |
| `20261104121041-76cfd1` | 新 journal 回归，改动前 | exit 1，2 failed：失败句柄未关闭、FK 错误前缀错误 |
| `20261104122422-a881e6` | Node database/journal/delete wiring | exit 0，10 passed，无 Errors 行 |
| `20261104122422-fb92c0` | typecheck | exit 0 |
| `20261104123920-f15554` / `20261104123920-ec0e34` | 新 owner 错误类型断言 | exit 1：底层确为 StorageError，测试曾错误期望 Error；已改为检查原 StorageError + 精确 message/code/sqliteCode，未改业务实现 |
| `20261104124629-fd8a10` | Node journal/owner 事务回归 | exit 0，2 passed，无 Errors 行 |
| `20261104124629-32c3cf` | Electron journal/owner 事务回归 | exit 0，2 passed，无 Errors 行 |
| `20261104125627-b79985` | injector + runtime-roots + utf8-paged-read | exit 0，48 passed / 1 Windows skipped，无 Errors 行 |
| `20261104125627-4981f9` | typecheck | exit 0 |

按 standard-v2 §5 在提交全部变更、merge main 后运行最终 lane-gate；最终结果按其提交记录，
不以初始两项自检或以上定向结果替代整轮门禁。

阶段自检 `20261104131838-f969a3` 已通过：提交 `13fda6cf7`、main 基线 `ad11a8394`，
typecheck/boundaries/changed-strict/importable/tests 五项全部通过，退出 0。
该次 merge 同时合入 F7 正式 sandbox/windows API，后续单元将 transform 输入/probe 类型改为正式 API
并取消 Context 候选断言；新增真实 F7 Linux provider 的 env/限额/cancel/reap 集成验证：
Node `20261104132844-614751` exit 0 / 3 passed，Electron `20261104133602-f67041` exit 0 / 3 passed，
均无 Errors 行；typecheck `20261104132844-c05157` exit 0。Windows 原生补充能力与本 lane 适配仍未完成。

C04-03/X5：按 L04 请求，api.ts 仅重导出既有 `escapeXmlContent(value:string):string`；
原 test_escape_xml_content 的三条断言不变，只改为公共导入。作业 `20261104133350-5fc17d`
exit 0 / 12 passed，无 Errors 行。未复制 goal runtime 或转义实现。

## C1 08:21Z / 08:28Z 精确公开面

- L04：api.ts 直接重导出既有
  `validatePersonaModelConfig(modelId: string, configs: readonly PersonaModelConfig[]): void`。
  configs 来自调用方当前运行时模型目录，最小字段 id/enabled/isEmbedding?/isReranker?/isImageGeneration?；
  modelId Rust trim 后匹配首个配置 id（不是 model 显示名）；错误顺序为 NOT_FOUND → DISABLED → UNSUPPORTED。
  抛出 Error，message 保留三个 PERSONA_MODEL_* 完整 Rust 字符串。没有复制实现或新增配置加载逻辑。
- L03：api.ts 直接重导出既有
  `isLocalShellExecuteTool(toolName: string, args: JsonValue): boolean`，仍调用 classification.ts:117。
  namespace 与 semantic short name 按 Rust approval_scope.rs:52–85,104–109,141–145 处理，
  MCP 别名不因 command 参数/内嵌 builtin 名称变成本地 shell；不迁 tool loop。
- 原 Rust 测试标题与断言保留，测试改从公开 api.ts 调用上述函数，并补齐精确错误、Rust 空白、
  非 chat 三标记、首个配置优先和 builtin/local/MCP 名称边界；TESTMAP 行状态不变。
- 复核作业：persona 公开出口修复前 `20261104083614-216661` exit 1（10 passed / 1 failed，缺导出）；
  修复后 `20261104085918-1c8d95` exit 0（两文件 77 passed，无 Errors 行）；
  `20261104085918-91dca0` typecheck exit 0。没有重跑 sandbox/receiver 或全量套件。
  合并新 main 后 `20261104091648-3b0e5a` typecheck exit 0，
  `20261104091648-e14b43` ledger --check --no-write exit 0（command/test/orphan problems 均 0）。
- W2 给 R2 的实际实现 hash 仍为 `531160218/ee5b57e54`，说明 `e540fbb61/127cfcb25`。
  index 绑定真实 main 的 governance.tryAcquireOperationGuard('delete_propagation')；
  deleteSessionV2 是 L04 b0ed6a135 候选，当前 main 未合入。测试里的 L21/F3/文件清理真实，
  仅 L04 回调替身；Node `20261104072053-160558` 和 Electron `20261104072437-19f7a8` 均 exit 0 / 3 passed，
  不能据此勾选三方整链 W2。独立复验仍归 R2，Windows 5 项仍保持真实阻塞。

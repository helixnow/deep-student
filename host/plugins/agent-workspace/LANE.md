# L05-agent-workspace：工作区与审批

## WP-063 / X3-L05-02 历史收件队列恢复

- 开工合 main `4dc4c8ed9`，本树 `78edf93d0`；storage/repository 接口已核实存在于 main。
- Rust coordinator.rs:994–1011、1059–1067 把恢复对象同时交给实例和 router；TS 原 buildInstance
  无条件新建导致恢复丢失。现接收已有 InboxManager，新建路径使用默认空队列，补非空恢复 info。
- 起点定向 job `20261105163021-16a409` exit0 / 7 passed；新增真实 Host/F3 重装回归
  `20261105163321-41e4ca` exit1 / 1 failed，精确复现 count=1、peek=[]。
- v0 两场景覆盖正式 IPC 下历史读取与路由，所有 DB/事件捕获、normalize=[]；peek/drain 由
  真实 owner 测试验证。C2 历史 seed 已到，独立组合复验边界见 BLOCKERS。
- 本包不改原 X3 用例、不改 9+2 候选映射；实际 pending 10→10。仅执行 WP-063，结束按
  WORKER.md v3 交付，不采用下文旧自动续派条款。
- 新会话保留 `3cc20d5ed/2449e4563/dc630e63f`，接续未提交的历史测试；复制 C2
  `20261105164200-825edc` 已关闭 V1 库至 `tests/fixtures/wp063/`，未重造 SQL。
  首轮 `20261105172614-f5fc20` 为 7 passed / 1 failed：夹具遗漏生产启动的 F3 迁移，
  报 `no such table: __file_deletion_journal`；补齐 runAll 后保全部断言。
- 历史库与既有重装测试：Node `20261105172756-1c1da7`、Electron
  `20261105172756-80830b` 均 exit0 / 2 passed / 0 failed / 0 skipped，无 Errors。
  V1→V2 后 count=1、连续 peek=message_old、八表与 sequence 旧行不变；drain 精确标记，
  send 可见且旧 message 状态保留，再次重装不重放。恢复生产代码无新增修改。
  最终精确 tip 门禁与交付见 WP-063 正式报告；原 X3 组合签收仍由 C2/X3 执行。

## 2026-11-05 C1 W02 / WorkspaceFs单执行器贡献

- 合并 `dd564e12f` 后亲核L07 api/service返回内核Disposer，registry用HookSet批次身份。
  index仅登记一个WorkspaceFsContribution，持有原factory产生的业务实例；同inject/effect
  scope持实际registration并释放，未改L04/L07或填其它缺失executor。
- L04 context映射保方法receiver与事件元数据，读取group默认root时复用caller conn的正式
  session/group owner函数；显式root跳过查询。输入类型扩展为unknown只为接受L04正式ToolCall，
  原字段检查/输出体不变，无scanner/JSON重编码；shared类型泛型保原默认，旧duration测试仅改类型。
- 窗口审读修正：Rust window_ref是panic，支持工具emit-start后、root解析前检查；异常向真实
  registry传播，不生成普通失败工具块。取消由registry原precheck/token/watchdog负责，不造默认权限。
- 初始profile job `20261105032217-151709` exit0；强化故障回归job `20261105033044-ebee89`
  exit1：测试注入普通Error却期望L04 StorageError包装前缀。改为正式F3 StorageError故障类型，
  保原期望，未改业务日志。当前job `20261105033649-067eb3` exit0：1个真实profile集成用例通过，
  无Errors/Unhandled；degraded=[]，恰一真实execute贡献；同conn group选择/失败warn、显式root、
  真实读/只读写拒、窗口异常传播、预取消无副作用、技能信任/撤销、unload/reinstall与旧disposer
  不伤新登记均已验证。独立typecheck `20261105032217-570a26` exit0，最终仍须本提交selfgate。
- 只证明WorkspaceFs贡献/绑定这一子项；未签全52/57 roster、完整chatToolRuntime、Windows/ACL/helper，
  旧receipt/write/timing证据未重做或改判。

## 2026-11-05 自动续派 / V2-1.3 workspace receipt解码

- 开工main无新增，`493d2dcf5`已5/5自检。对照Rust MutationReceipt/ChangeSet和本机缓存的
  serde_json1.0.149/serde_derive1.0.228源码（只读，未运行Rust），修复u64无上界/高位丢失、
  map字段错误顺序、unit enum map与struct sequence缺失、ChangeSet伪造子路径错误前缀。
- bigint只在kernel出站边界转换；原生成文件bytes保持number类型，解码回执允许精确u64。
  未复制其它lane私有decoder，使用kernel公开unexpectedOf，原8个Rust回滚断言不改。
- 定向job `20261104212908-05ac42` exit0：45/45通过，无Errors。新增4项包含生产IPC/工具
  实际回滚和None/unknown字段输出、错误优先级、u64::MAX及超界；typecheck
  `20261104212908-99b84e`已提交，最终以selfgate为准。
- 原始模型数字lexeme若已被上游JS number擦除，本lane无法恢复；已记SPEC/BLOCKERS，
  不把typed object/IPC回归等同raw JSON差分结果。Windows/ACL/helper等pending不变。

## 2026-11-05 自动续派 / V2-1.7 executor单调耗时

- 合并新main后 `afd72bc68` / `9c2c60db1` 已5/5 selfgate。核对新L03 variant增量，
  尚无WorkspaceInjector/InjectionThrottle消费，resolver生产仍固定true；pending不改标。
  （WP-149 更正：L03 WP-061 已 main 并真实消费 Injector/Throttle，injector 5 行已改 ported，见 TESTMAP。）
- 九类executor（workspace/workspace-fs/git/file-manager/code/LSP/root-request/shell/preflight）
  的duration由Date.now差值改为performance.now差值截断毫秒，对齐各Rust Instant::elapsed。
  shell spawn→drain的output.duration_ms也对齐；profile/payload mtime清理及持久化时间保留墙钟。
- 定向job `20261104210705-b3fdef` exit0：31 passed / 4 skipped，无Errors。新4项经真实
  工厂/执行器验证回拨1小时、前跳1天时返回/存储/事件duration仍为单调整数，含真实artifact
  写入与Linux shell进程。原移植断言未变。typecheck `20261104210705-d24a65`已提交。
- ACL/helper仍待正式平台合同，不重投已交接请求；Windows五pending与独立验收保持原状。

## 2026-11-05 自动续派 / artifact与backup write_all

- 新main合并后 `53a811c4e` / `5b1b19055` 5/5自检通过。已核L24生产index异步消费
  agentTransformSandbox；L03 injector/L04消费者仍缺，未把这次合并当Windows/e2e签收。
- 按Rust runtime_roots.rs:2142–2174、2341–2368和workspace_fs_executor.rs:443–474，
  将已修复write_all逻辑提取为本lane file-write.ts，共用于workspace变更、backup、artifact
  覆盖和restore。修复剩余单次writeSync短写丢字节及各路径的create/write/sync错误上下文；
  hash/bytes在完整写入后累计，原检查/替换顺序与finally、backup回收逻辑保留。
- 定向 `20261104204503-c26c05` exit0：22/22通过，无Errors；新增10个真实executor/IPC
  用例覆盖多块backup→覆盖→restore的Interrupted/短写，以及三路径故障/原文保留/stage关闭。
  原Rust测试断言未改。Typecheck `20261104204503-abfc78`已提交，最终以selfgate为准。
- Windows、ACL/helper原语/正式入口等仍pending，按C1集中留交接，未重投既有请求。

## 2026-11-05 自动续派 / workspace staging write_all

- 合并新main后 `323fff85f` / `7528428c5` 已通过5/5自检；L03 injector和L04
  outbox/工具消费者仍未在本树出现，ACL/helper按C1集中交接，未重复请求parked/failed lane。
- 按v2写入/错误/清理语义审读workspace_change_set.rs:347–355，确认单次writeSync无法
  对齐write_all，且stage open/write/sync缺原前缀。现短写推进offset、EINTR重试、零写
  返回Rust WriteZero文本；stage创建/写入/sync上下文恢复。checkpoint、目标替换与finally
  清理顺序保留，原8个Rust测试断言不变。
- 定向 `20261104202218-7597ef` exit0：18/18通过，无Errors；新增6项生产executor真文件
  回归覆盖短写、Interrupted和open/write/zero/sync失败，验证完整内容/哈希、原目标和stage。
  typecheck `20261104202218-23f823`已提交，最终交付以selfgate为准。
- 此为Linux行为证据；不签Windows，不关闭ACL/helper与原五pending，不宣告无剩余工作。

## 2026-11-05 自动续派 / ACL接口审读与move回执修复

- 开工main无新增，`9facec212`已5/5自检，不重复该单元。沿Windows余项审读发现F7
  readDacl不返回继承保护位、writeDacl布尔值缺“保持状态”、createProfile缺capability参数，
  ACL构造/SID原语与helper早期入口/stdio/Job取消桥接仍缺正式面。已向F7/C1/C2送精确
  Rust行号与需求，细节见native-needs.md；不猜原生二进制或把API存在记为沙箱完成。
- 独立已锁反例：Rust workspace_change_set.rs:571–573在move成功后metadata失败仍返回
  bytes=0回执，TS此前抛错丢回执。修复保持原nextChangeId顺序和best-effort无日志语义。
  新生产executor→目标metadata失败→IPC undo测试确认实际内容移动、bytes=0与可回滚。
- 定向job `20261104194323-439fcc` exit0：12/12通过，无Errors；原8个Rust测试断言未改。
  Typecheck `20261104194323-14f921`已提交；完成条件仍以最终selfgate为准。
- Windows原五pending、原生目标环境验证与ACL/helper实现仍未完成，不满足“无剩余工作”。

## 2026-11-05 自动续派 / R2-W3 Windows root identity

- 起点 `3b56093b9` 已过5/5 selfgate，开工merge main为Already up to date。
  继续本lane剩余原生身份接线：runtimeRootIdentity保留Rust :569–574元数据/目录检查，
  Windows :585–600使用正式F7目录handle信息，删除Node dev/ino近似。bigint file_index
  全链保留，沿既有exact encoder存储；授权/重验/信任/root token/shell绑定共享同一来源。
- index及executor工厂透传当前Context服务；纯helpers新增末尾windowsFiles依赖，
  RuntimeRootDeps已有该字段，直接消费方需绑定。没有全局可变native单例。
- 原Windows测试 :2618,2633–2635 的4个Rust断言恢复为真handle数据：两次目录身份相同、
  同volume、file index与root不同、reparse bit=0。其它原测试仅提供真实Windows依赖，
  fixture序列化改用exact encoder以保留u64；原断言值/方向不变。
- 定向job `20261104192033-c86124` exit0：56 passed / 2 Windows skipped，无Errors。
  新 `runtime-identity-windows.test.ts` 为真实Host/F7→IPC持久化/重验→executor/approval→
  卸载/重装/目录替换测试，Linux未执行。typecheck `20261104192033-4c021f`已提交。
- 原五Windows pending、目标平台复验和ACL/helper仍未关闭；本候选与正常main集成分开记录。

## 2026-11-05 C1 指派 / workspace-change-set reader

- 本轮从 `5b38c8c96` 续作；保留 preview `52fb28a22` 已正常集成的状态，未重写接线。
- 源码判定：Rust workspace_change_set.rs:287–305 的打开策略不同于 runtime_roots；
  Windows 无 OPEN_REPARSE_POINT/额外身份复核，Unix 有 O_NOFOLLOW。保留既有 lstat→
  file/type→size→open 与原错误前缀；将已打开fd交给共享 RuntimeReadFile，并与 edit
  共用 read_to_end。成功/失败close，EOF后增长限额及checkpoint/跨卷move调用顺序不变。
- 已锁定并修复 :455–466 错误优先级：缺 expected_current_hash 必须在读取旧文件前失败。
  新稀疏超限＋缺hash用例经真实executor证明；给了非法hash时仍先报读取前size错误。
- 定向 `20261104185152-593fb4` 退出0，36/36通过，无Errors；原 workspace-change-set
  8项未修改断言。新3项覆盖优先级、多块短读→checkpoint→IPC恢复、open/read错误与关闭、
  失败前不创建checkpoint/不写入。typecheck `20261104185152-cae745` 已提交待实际结果。
- 证据为Linux生产入口测试＋Rust逐分支审读，Windows目标平台结果仍未取得；原五项pending、
  root identity/ACL/helper及L03/L04消费者余项不因此关闭。

## 2026-11-05 自动续派 / R2-W3 shared reader

- 合并 main 后 `b241c9c55` / `01c074ecf` 已过 5/5 selfgate。C1 纠正：该 main
  只含 `a457d0aff` preview 读取实现，不能据此宣告 `52fb28a22` index 配套已集成。
  本分支保留这两行正式接线，不重复修复/宣称 Windows 已验证。
- 新增量：`openRuntimeReadFile` 统一顺序读取/metadata/close，Windows 使用 F7
  `readAt` bigint 游标和 `refreshInformation`，不重开路径；Unix 使用原 fd。
  连接 preview、backup、hash、restore、workspace read/edit。index undo 按次取 native；
  executor 工厂 getter 在每次 execute 取服务，原上下文不修改。
- Rust `runtime_roots.rs:2147–2150,2188–2199,2252–2254,2343–2344` 与
  `workspace_fs_executor.rs:288–307,708–720` 的 metadata/read 错误前缀恢复。
  既有移植测试只追加真实 Windows provider 参数，原断言数量、期望与方向均不变。
- 定向 job `20261104182258-adb7e5` 退出 0：72 passed / 3 Windows skipped，无 Errors。
  新测试经生产 executor → 多块文件读取/覆盖备份 → IPC undo 验证原文、完整哈希与恢复字节数；
  Linux 真文件注入 read 错误验证前缀、close 和 stage 清理。Windows 同 handle 短读/metadata
  失败测试待目标平台，未据 Linux 结果关闭五项 pending。
- 下一余项：Windows root identity、workspace-change-set 自有 reader、ACL/helper 与平台验证；
  L04 completion/false-OCR/工具组合根与 L03 injector 消费仍待正常集成。

## 2026-11-05 自动续派 / R2-W3 preview 子项

- `ec004c43b` 已通过上一轮 5/5 自检；本轮 main 合并结果为 Already up to date。
  继续已解除 F7 API 等待的工作：`chat_v2_read_runtime_file` Windows 分支按次从 Context
  获取 `nativeWindowsFiles`，使用 `openRegularFileNoFollow` + 同 handle `readAt`，
  保留 limit+1、EOF/短读、lossy UTF-8、`Failed to read file:` 及 finally close。
- 新增真实 F7 Windows provider 的 IPC 测试，覆盖有界短读、错误关闭与卸载后不复用服务；
  本机 Linux 不执行该测试，不能据此签收 W3。既有 round-trip/W1 测试仅补 Windows
  provider 安装/对应 readAt 故障注入，原预览结果与完整错误断言不变。
- 定向 job `20261104174954-8ddf4d` 退出 0：47 passed / 2 Windows skipped，无 Errors。
  Typecheck job `20261104174954-5d133c` 已提交，结果以实际作业与最终 selfgate 为准。
- 剩余：root identity 的原生来源、backup/workspace reader 同 handle 适配、ACL/helper
  与 Windows 目标平台验证；TESTMAP 五项 Windows pending 保持原样。

## 2026-11-05 F3-V2-05 / R2-W2 集成失败修复

- 合并 main 后接入 F3 正式 workspace owner：`index.ts::apply` 的 `ctx.effect`
  注册 `deleteWorkspaceIndexWithConn` 并释放 Disposer；代码由协调者检查点 `16f1bfd3e` 保存。
  保留 F3 prepared SAVEPOINT、同连接 DELETE、错误回滚与文件操作顺序。
- job `20261104170202-c452ca`（全目录）退出 1：四项反馈失败全部恢复，
  workspace-database 5、workspace-delete-wiring 3、workspace-journal-wiring 3 均通过；
  另发现新 gate 测试 3 项失败（总计 437 passed / 21 skipped），未视为门禁通过。
- 修复 gate 的 env facts snake_case→camelCase 接缝；allow 测试使用 Rust 可降级的
  `pwd`，保留 `git status` 不降级断言。job `20261104170525-de84af` 退出 0，4/4 通过。
- typecheck job `20261104170202-332a8f` 退出 2，唯一错误即上述 env facts 类型不匹配，
  已修复，最终结果以随后 lane-gate 为准。boundaries job `20261104170202-700092`
  退出 0：2755 文件、0 violation。以上都是 Linux 验证。
- ChatToolRuntime owner exports 已具备；L04 仍须绑定同步 authorityState/session group
  preferredRuntimeRootId 和组合根。`analyzeShellCommand` 直接导出原 owner 分析器供 L06 使用。
- 最终 lane-gate：`696b09a38` / main `fb463060d`，5/5 通过（退出 0）。
  子作业 `20261104170850-1210cb` typecheck、`-2212d7` boundaries、`-ff0fa1`
  changed strict、`-a37c76` importable、`-eb6fde` tests 全为退出 0；tests 47 文件、
  440 passed / 21 skipped，无 Errors。四项反馈失败已恢复，仍不宣告 Windows/macOS 验证或 main 集成。

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L05-agent-workspace（工作区与审批） |
| 目录 | `host/plugins/agent-workspace/` |
| Rust 范围（lanes.md） | workspace、approval_*、runtime_roots、vfs_resolver、adapters，以及 shell、git、lsp、fs 工具 |
| 主要提供 | `agent.workspace@1`、`agent.approval@1` |
| 主要消费 | F4、L13 |
| 特别注意 | shell 沙箱跨平台；审批键 canonical 化（`canonical_scope_value`） |
| 规模（本目录） | 41075 行 · 37 个文件 · 12 个命令（前端调用 11） · 401 个测试 |
| 规模（整条 lane，inventory） | 41075 行 · 37 个文件 · 12 个命令（前端 11） · 401 个测试 |
| 契约 | [`contracts/ipc/L05-agent-workspace.json`](../../../contracts/ipc/L05-agent-workspace.json) |
| 服务草稿 | [`contracts/services/DRAFT-L05-agent-workspace.md`](../../../contracts/services/DRAFT-L05-agent-workspace.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-agent/src/chat_v2/adapters/llm_adapter.rs` | 800 | 12 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/adapters/mod.rs` | 28 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/adapters/tool_adapter.rs` | 720 | 5 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/adapters/vfs_rag_adapter.rs` | 426 | 4 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/approval_manager.rs` | 2043 | 21 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/approval_scope.rs` | 5262 | 66 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs` | 3704 | 47 | 12 |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/code_navigation_executor.rs` | 693 | 5 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/file_manager_executor.rs` | 1055 | 6 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/git_executor.rs` | 1091 | 16 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/local_shell_execute_executor.rs` | 3595 | 45 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/local_shell_preflight_executor.rs` | 934 | 10 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/lsp_navigation_executor.rs` | 842 | 5 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/runtime_root_request_executor.rs` | 284 | 5 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/shell_sandbox.rs` | 1343 | 14 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/shell_sandbox/windows.rs` | 2427 | 13 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/utf8_paged_read.rs` | 367 | 9 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs` | 1010 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/tools/workspace_fs_executor.rs` | 1405 | 23 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/vfs_resolver.rs` | 3040 | 12 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/agent_profile.rs` | 728 | 11 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/card_read_scope.rs` | 106 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/completion_outbox.rs` | 714 | 9 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/config.rs` | 22 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/coordinator.rs` | 1403 | 4 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/custom_agents.rs` | 836 | 14 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/database.rs` | 741 | 5 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/emitter.rs` | 299 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/inbox.rs` | 218 | 3 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/injector.rs` | 310 | 5 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/mod.rs` | 50 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/repo.rs` | 650 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/router.rs` | 125 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/sleep_manager.rs` | 1492 | 8 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/subagent_task.rs` | 1064 | 16 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace/types.rs` | 291 | 0 |  |
| `src-tauri/crates/dstu-agent/src/chat_v2/workspace_change_set.rs` | 957 | 8 |  |

### 命令（12）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `chat_v2_authorize_runtime_root` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1871` | async | app | src/features/settings/components/mcp-tools/useToolPermissions.tsx:378 | (path: string, label?: string \| null, sessionId?: string \| null) → RuntimeRoot[] ! string |
| `chat_v2_delete_artifact` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1965` | async | none | — | (sessionId: string, relativePath: string) → Value ! string |
| `chat_v2_list_runtime_directory` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1785` | async | app | src/features/chat/api/taskWorkspaceApi.ts:42 | (sessionId: string, rootId?: string \| null, relativePath?: string \| null, cursor?: string \| null, limit?: integer(usize) \| null) → RuntimeDirectoryPage ! string |
| `chat_v2_list_runtime_roots` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1673` | async | app | src/features/chat/components/groups/GroupEditorDialog.tsx:223<br>src/features/settings/components/mcp-tools/useToolPermissions.tsx:126 | (sessionId?: string \| null) → RuntimeRoot[] ! string |
| `chat_v2_read_runtime_file` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:2551` | async | app | src/features/chat/components/agent-task/ChangesSection.tsx:89<br>src/features/chat/components/agent-task/ChangesSection.tsx:96<br>src/features/chat/components/agent-task/ChangesSection.tsx:177 | (sessionId: string, rootId: string, relativePath: string, maxBytes?: integer(u64) \| null) → RuntimeFilePreview ! string |
| `chat_v2_reset_workspace_root` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1854` | async | app | src/features/settings/components/mcp-tools/useToolPermissions.tsx:413 | (sessionId?: string \| null) → RuntimeRoot[] ! string |
| `chat_v2_resolve_runtime_path` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1941` | async | app | src/features/chat/components/AgentTaskPanel.tsx:328<br>src/features/chat/components/AgentTaskPanel.tsx:346 | (sessionId: string, rootId?: string \| null, relativePath: string) → string ! string |
| `chat_v2_revert_artifact_write` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:2454` | async | app | src/features/chat/components/agent-task/ChangesSection.tsx:128 | (sessionId: string, relativePath: string, backupRef?: string \| null, expectedAfterHash: string) → Value ! string |
| `chat_v2_revert_workspace_change` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:2510` | async | app | src/features/chat/components/agent-task/ChangesSection.tsx:123 | (sessionId: string, receipt: Value) → Value ! string |
| `chat_v2_revoke_runtime_root` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1884` | async | app | src/features/settings/components/mcp-tools/useToolPermissions.tsx:424 | (rootId: string, sessionId?: string \| null) → RuntimeRoot[] ! string |
| `chat_v2_set_skill_trust` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1601` | async | app | src/features/chat/skills/skillTrustStorage.ts:156<br>src/features/chat/skills/skillTrustStorage.ts:162 | (skillId: string, packageRoot?: string \| null, trusted: boolean) → SkillTrustState ! string |
| `chat_v2_set_workspace_root` | `crates/dstu-agent/src/chat_v2/runtime_roots.rs:1813` | async | app | src/features/chat/api/taskWorkspaceApi.ts:50<br>src/features/settings/components/mcp-tools/useToolPermissions.tsx:396 | (path: string, label?: string \| null, access?: RuntimeRootAccess__De \| null, sessionId?: string \| null) → RuntimeRoot[] ! string |

### 发出的事件（9）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `workspace_agent_joined` | 常量 `AGENT_JOINED` | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:184 (emit) |
| `workspace_agent_left` | 常量 `AGENT_LEFT` | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:204 (emit) |
| `workspace_agent_status_changed` | 常量 `AGENT_STATUS_CHANGED` | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:218 (emit) |
| `workspace_closed` | 常量 `WORKSPACE_CLOSED` | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:246 (emit) |
| `workspace_coordinator_awakened` | 常量 `COORDINATOR_AWAKENED` | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:279 (emit) |
| `workspace_document_updated` | 常量 `DOCUMENT_UPDATED` | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:234 (emit) |
| `workspace_message_received` | 常量 `MESSAGE_RECEIVED` | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:171 (emit) |
| `workspace_warning` | 常量 `WORKSPACE_WARNING` | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:293 (emit) |
| `workspace_worker_ready` | 常量 `WORKSPACE_WORKER_READY_EVENT` | crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs:373 (emit) |

### 契约中的事件（9，`contracts/ipc/L05-agent-workspace.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `workspace_worker_ready` | 否 | object \| object \| object \| object | crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs:373 (emit) |
| `workspace_agent_joined` | 否 | WorkspaceAgentEvent | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:184 (emit) |
| `workspace_agent_left` | 否 | WorkspaceAgentEvent | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:204 (emit) |
| `workspace_agent_status_changed` | 否 | AgentStatusEvent | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:218 (emit) |
| `workspace_closed` | 否 | WorkspaceClosedEvent | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:246 (emit) |
| `workspace_coordinator_awakened` | 否 | CoordinatorAwakenedEvent | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:279 (emit) |
| `workspace_document_updated` | 否 | WorkspaceDocumentEvent | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:234 (emit) |
| `workspace_message_received` | 否 | WorkspaceMessageEvent | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:171 (emit) |
| `workspace_warning` | 否 | WorkspaceWarningEvent | crates/dstu-agent/src/chat_v2/workspace/emitter.rs:293 (emit) |
<!-- END GENERATED:lane -->

## 备注

（本 lane 自行记录。）

### 与其他 lane / 平台层的集成缺口（不改变本 lane 行为）

- **删除 journal 公开端口已到位**：main 的 `storage/API.md` §10 已发布接受
  `SqlExecutor` 的 `host/platform/storage/file-deletion-queue.ts` 四个 workspace 操作。
  本轮改为消费该公开端口并移除 `repository/deletion-journal.ts` 副本；journal/outbox 位于
  活动槽 `chat_v2.db`，与 workspace_index 删除同 SAVEPOINT。借用连接在所有退出路径关闭，
  对齐 Rust Connection Drop；详情与验证见 SPEC/BLOCKERS。
- **L04**：`WorkspaceCoordinator.deleteWorkspace` 需要 `ChatV2Repo::delete_session_v2`
  清理 worker 会话；L04 b0ed6a135 已有真实候选方法，当前 main 未合入。L05 已绑定按需业务调用，
  不直接写 chat 表，未将 callback 替身回归当三插件删除整链验收。
  另外 L04 的工具花名册尚未注册本 lane 发布的 `WorkspaceToolExecutor` /
  `getWorkspaceToolSchemas()`，注册时需透传 `ctx.logger` 作为 `warn`/`info`，
  并在卸载时调用 `LspNavigationExecutor.dispose()`。
- **L21 许可已接入**：生产 WorkspaceCoordinator 使用已合 main 的
  `governance.tryAcquireOperationGuard('delete_propagation')` 同步立即失败语义，finally release；
  真实 L21/F3 回归已验证忙锁前无副作用以及回调失败释放，W2 整链仍待 L04 方法合入。
- **L24**：chatanki 仍保留卡面只读作用域的本地副本；应改为引用
  `agent-workspace/api.ts` 的 `installWorkspaceCardReadScope`。
- **服务更名（ARCHITECTURE 附录 A）**：本 lane 已把 `agent.workspace@1` /
  `agent.approval@1` 改为 `agentWorkspace` / `agentApproval`，并新增
  `agentWorkspaceTools`。合并 main 后 chat 已通过 `ctx.get('agentApproval')` 消费。
  生成的 lane 表仍列旧名，等 `npm run migration:scaffold -- --refresh` 更新。
- **VFS 解引用**：`api.ts` 发布 `createVfsResolver(vfs, { vfsRepo, docs }, logger)`；
  所有资源类型已实现，L03/L04 需要在历史加载/发送/重试路径消费异步入口。
  L18 已提供 docs；本 lane 已在 index 发布 `agentVfsResolver` 与 `agentCompletionOutbox`。
  L03 历史消费已合 main，10 个 resolver 原测试已 ported；两个 false/OCR 分支及 9 个 outbox 测试待 L04。
- **质量修复报告**：职责拆分、平台复用、门禁结果和 obsolete 审批 ID 见
  [MIGRATION-REPORT.md](MIGRATION-REPORT.md)。
- **续派剩余项**：接口、责任 lane、影响命令/测试与判定依据见 [BLOCKERS.md](BLOCKERS.md)。

### v2 自动续派（2026-11-04）

- 初始自检：作业 `20261104120527-e2020d`，提交/基线 `d84e29565`，typecheck + boundaries 退出 0。
  当时分支等于 main，门禁只选择两项；不把此结果当后续 journal 改动的验证。
- 本轮发现并修复的自有问题：旧 journal 副本尚未切换已发布端口；配置/准备失败漏关连接；
  foreign_keys 失败丢失独立错误前缀。新增真实 F3 SQLite 回归；原 Rust 测试断言未修改。
- **未完成**：21 pending（原 16 项加已确认未接入的 injector 5 项）；W1/W2/W3/W4 独立验收仍由 R2 处理。
  因此不能标记“已完成”或“无剩余工作”。

## v2 排雷清单（C1/X6，基线 2ee9a9cbe）

原始索引：`git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`。
当前核验快照 `a9ba8107b`（包含本轮 journal 改动）；候选行号仍保留基线，不因移动行号重建 ID。
以下简称 ID `X6-<gate>-agent-workspace-<文件短名>-<基线行>`；同一文件多行逐个保留后缀。
`UD=unchecked-decode`、`PR=prod-reachable`、`AP=assert-parity`、`LP=log-parity`、`SW=single-writer`。
info/计数不是判定失败；未逐条复核的条目写“待核”，不为数字补断言或日志。

### 单写者 / 当前优先单元

| ID/基线位置 | 当前核验 / Rust 证据 | owner 请求与状态 |
|---|---|---|
| F3-V2-05；X6-SW-agent-workspace-deletion-journal-129 | 本地 `repository/deletion-journal.ts` 386 行已删除，workspace/database.ts 调用已合 main 的 F3 SqlExecutor 端口；Rust workspace/database.rs:237–242,474–477 也是调用共享 file_deletion_queue | api.ts 已公开 deleteWorkspaceIndexWithConn（原 repository/chat-v2-repository.ts:21）。已核 F3 候选 d4b27824f 的 registerWorkspaceIndexDeletionOwner(owner):Disposer：同 conn、prepared 后/RELEASE 前调用，错误包装、Slot生命周期一致；main 尚无注册导出，待集成后 index 绑定；不复制文件编排或绕过 owner |

### 数据边界候选（23 个基线位置）

| ID / 基线位置 | 当前核验 / 原 Rust | 状态、owner |
|---|---|---|
| R2-W1；runtime-root-records.ts:39,255,266,276 | 当前有 token 读取、逐字段校验、默认/枚举/u64 精度；Rust runtime_roots.rs:148–200,648,982,1270；后 3 项是验证后的结构转换，不是未解析输入 | 复用 W1，不重写已修主线；string token 的 `JSON.parse as string` 待按 unknown 收窄，不声称缺记录解码算法；L05 |
| X6-UD-agent-workspace-code-navigation-{560,566} | 当前是已构造 TextSearchOutput/SymbolOutlineOutput 转出站 JsonValue；Rust code_navigation_executor.rs:531–570 的工具输出 | info，非入站 JSON；保留为出站形状人工核对线索，L05 |
| X6-UD-agent-workspace-lsp-navigation-552 | LspSession.readMessage 的 JSON.parse as JsonValue 仍存在；Rust lsp_navigation_executor.rs 的 read_message 解析 serde_json::Value | 待 unknown→JSON value 边界核对（含数字/错误），L05；不能改成更窄 JSON-RPC schema |
| X6-UD-agent-workspace-shell-execute-{286,336} | change receipt / sandbox report 转 JsonValue，属内部结构出站；Rust local_shell_execute_executor.rs execute 输出 | info，待逐字段出站核对，L05 |
| X6-UD-agent-workspace-workspace-fs-{588,605} | Node fs 编码与 Buffer Dirent 类型适配，不是 JSON.parse | info，核对 Rust read_dir 的原生字节文件名语义后再决定是否改，L05 |
| X6-UD-agent-workspace-workspace-fs-{772,773,779,1041,1042,1059} | ChangeSet/MutationReceipt/rollback 结果出站；Rust workspace_fs_executor.rs 的 write/revert 与 workspace_change_set.rs 类型 | info，待结构字段核对，L05 |
| X6-UD-agent-workspace-pdf-110 | parsePreviewJson 在断言后已有 pages/uint/字符串/Option 字段检查；Rust vfs_resolver.rs:751–753,1707–1709 是 PdfPreviewJson 反序列化失败取 None | 待去掉过早类型断言并核对既有验证；不虚报缺整个 decoder，L05（类型定义来源 L11） |
| X6-UD-agent-workspace-resources-231 | mindmap 的 JSON.parse as Record；Rust vfs_resolver.rs:1536 起 resolve_mindmap 读取 Value.root，失败回原文 | 待 unknown 对象收窄并保持回退，L05 |
| C1 receiver；coordinator.ts:{76,81} | liveExecutor 的方法转发重载适配；实际 receiver 已由 apply(target,args) 保留，真实 F3 回归通过 | info，不是数据解码；不重做 receiver，L05 |
| X6-UD-agent-workspace-repo-{36,44} | parseMetadata/parseContextValue 断言仍存在；Rust workspace/repo.rs:523,552,580 及 row_to_context 解析通用 Value，失败 respectively None/Null | 待 unknown/JSON value 校验，保留既有失败回退；L05，不套不相关业务 schema |

### 生产可达（3 个候选 / 5 个原测试）

| ID | 当前核验 / Rust / 消费方 | 状态 |
|---|---|---|
| X6-PR-agent-workspace-workspace-injector-1（InjectionThrottle） | Rust pipeline/tool_loop.rs:483 持有跨检查点 throttle；当前 Host L03 未引用此符号 | 已公开 api.ts 原类/类型；L03 消费仍缺失，5 行改 pending；不是 dead-in-rust |
| 同索引（WorkspaceInjector） | Rust tool_loop.rs:2384–2396 构造并调用注入/格式化；当前本 lane 仅模块与测试引用 | 已公开最小 coordinator 消费面并保留原算法；5 行 pending；不以出口存在冒充真实调用 |
| 同索引（MAX_INJECTED_MESSAGE_CHARS） | Rust workspace/injector.rs 的截断上限，由上面格式化路径消费 | 与同根 injector 接线合并，不独立补假调用 |

WP-149 更新上表三行：L03 `chat-pipeline/src/tool-loop.ts:224,650`、`src/execute.ts:362`、
`src/workspace-injection.ts:23,31` 已在 main 生产消费 Throttle/Injector/格式化，5 行改回 ported（证据见 TESTMAP）。

### assert-parity（9 个候选）

| ID / 基线位置 | 原 Rust / 当前核验 | 状态 |
|---|---|---|
| X6-AP-agent-workspace-runtime-paths-52 | runtime_roots.rs:2782；TS 对 3 个路径逐项循环断言，不是仅 1 个输入 | 计数误报候选，保留原循环，不加无意义 expect |
| X6-AP-agent-workspace-runtime-paths-67 | runtime_roots.rs:3403–3431；TS 4 critical + 2 broad + 1 safe 与原 7 个向量逐项相同 | 已核对同义循环，未为计数展开 |
| X6-AP-agent-workspace-runtime-roots-95 | runtime_roots.rs:2868 明确 assert risk=Critical；TS 原先只断言 RW 拒绝/RO 接受 | 已补缺失的真实风险分类断言，原两条不变 |
| X6-AP-agent-workspace-runtime-roots-270 | runtime_roots.rs:3188–3250；TS 对同样 6 个 backupRef（绝对、上跳、区内上跳、loose、目录本身、缺文件）逐项循环拒绝 | 已逐值核对同义，不展开循环凑数 |
| X6-AP-agent-workspace-runtime-roots-287 | runtime_roots.rs:3254–3281；TS 经 loadWorkspaceRecord 对同样 Unix/Windows/canonical_path 值循环验证 | 已核对三分支及字段值，不加重复 expect |
| X6-AP-agent-workspace-runtime-roots-363 | runtime_roots.rs:3513–3536；TS 由 6 个真实 root helper 生成 kind 后整体比对六项 | 已核对全部六类；仅把 skill fixture 移至 os.tmpdir 来源的 appDataDir，不改断言 |
| X6-AP-agent-workspace-utf8-paged-read-27 | utf8_paged_read.rs:311–315 原先只有注释说外层 no-op，未调用外层 | 已补真实 F1 api.applyToolResultBudget 后结果相等的原断言，非重复长度检查 |
| X6-AP-agent-workspace-vfs-resolver-{135,142} | vfs_resolver.rs:3002/3014 分别断言 hash、mime；TS 两元素 tuple.toEqual 同时验证这两个值 | 已核对同义，不拆成两个 expect 凑数 |

### log-parity（24 个 info 候选）

每行 ID 为 `X6-LP-agent-workspace-<文件短名>-1`，warn/error 分项保留在括号；只有逐位置核实后才签结论。

| 文件 / 分项 | Rust 证据范围 | 当前状态 / owner |
|---|---|---|
| approval-manager.ts（warn,error） | approval_manager.rs 的业务警告与 Mutex poison 分支 | 待逐位；JS 无 Mutex poison 不能机械补 error；L05 |
| runtime-root-records.ts（warn,error） | runtime_roots.rs，当前记录 decoder 本身无 Rust warn/error | 同 R2-W1，需与 runtime-paths/runtime-roots 分拆日志汇总核对；L05 |
| executors.ts（execute warn/error、preflight warn、root-request warn、workspace warn、workspace-fs warn） | 对应 tools/*_executor.rs 的执行/持久化失败日志 | 工厂不承载全部日志，需追到具体 executor；计数不是缺陷结论；L05 |
| shell-sandbox-windows.ts（warn） | shell_sandbox/windows.rs 的资源回收告警 | 与 W3 Windows 接线合并，未在目标平台验证；L05/F7 |
| vfs-resolver-repository.ts（warn） | vfs_resolver.rs 各资源查询/解析分支 | 查询与 logger 分拆，待逐位；L05 |
| card-read-scope.ts（error） | workspace/card_read_scope.rs Mutex poison | Node 无 Mutex poison；对应作用域恢复不变量仍需行为证据；L05 |
| index.ts（error） | workspace/coordinator.rs 的锁毒化分支 | 需在 coordinator 本体核对，不在 index 凑日志；L05 |
| schema.ts（warn,error） | workspace/database.rs:252–278 损坏恢复及 pool lock poison | 损坏恢复 warning 在 src/workspace/database.ts；pool poison 不直接平移；待全位置核对；L05 |
| emitter.ts（warn） | workspace/emitter.rs 缺句柄/发射失败 | 单方法共享日志可能覆盖多发送点，待逐路径核对；L05 |
| workspace-repository.ts（warn,error） | workspace/repo.rs 行解码/时间回退/锁分支 | 日志大部分在 src/workspace/repo.ts；待逐位；L05 |
| sleep-repository.ts（warn,error） | workspace/sleep_manager.rs 持久化/恢复/锁分支 | 需与 src/workspace/sleep-manager.ts 对齐；L05 |
| subagent-task-repository.ts（warn） | workspace/subagent_task.rs 状态/恢复分支 | 需与 src/workspace/subagent-task.ts 对齐；L05 |
| LANE.md（plugin warn/error 总量） | 上述原 Rust 模块汇总 | 仅人工索引，不以总量补日志或修改 TESTMAP |

### C2 冻结 ID 对照（0119143715c0bab2d8f698b7c1d58651358e85be）

以下稳定 ID 覆盖上面的临时文件索引，保留原 R2/F3 finding 对应，不另开重复整改。
来源为 C1 `C1-app-2026-11-04T124916977Z.md` 的 L88–93、L329–364；owner 裁定以
`037376b1e / X6-OWN-C2-20261104` 为准。后续修复提交使用这些稳定 ID。

| 稳定 ID | 既有条目 / 当前状态 |
|---|---|
| X6-UD-0007 | R2-W1 / runtime-root-records:39，已有词法与字段校验，余下类型收窄待核 |
| X6-UD-0008 | UD-lsp-navigation-552，通用 JSON Value 边界待核 |
| X6-UD-0009 | UD-pdf-110，已有预览字段验证，过早断言待清理 |
| X6-UD-0010 | UD-resources-231，mindmap unknown 对象边界待核 |
| X6-UD-0011 | UD-repo-36，metadata Value 解码待核 |
| X6-UD-0012 | UD-repo-44，context Value 解码待核 |
| X6-PR-0005 | PR-workspace-injector-1 / InjectionThrottle，已公开原类，消费待 L03 |
| X6-PR-0006 | PR-workspace-injector-1 / WorkspaceInjector，已公开原类，5 行 pending |
| X6-PR-0007 | PR-workspace-injector-1 / MAX_INJECTED_MESSAGE_CHARS，同根跟踪 |
| X6-AP-0031 | AP-runtime-paths-52，3 路径循环同义，未改断言 |
| X6-AP-0032 | AP-runtime-roots-95，已补 Rust:2868 的 Critical 判定 |
| X6-AP-0033 | AP-runtime-roots-270，6 refs 循环已逐值核对，未改原断言 |
| X6-AP-0034 | AP-runtime-roots-287，三种 identity 值已逐项核对 |
| X6-AP-0035 | AP-runtime-paths-67，7 个风险向量已逐项核对 |
| X6-AP-0036 | AP-runtime-roots-363，6 个真实 root helper 的线上 kind 同义 |
| X6-AP-0037 | AP-utf8-paged-read-27，已补 Rust:311–315 的真实外层 budget 断言 |
| X6-AP-0038 | AP-vfs-resolver-135，tuple 同时比对 hash/mime，不拆断言凑数 |
| X6-AP-0039 | AP-vfs-resolver-142，同上 |
| X6-LP-0035 / X6-LP-0036 | approval-manager warn/error，按既有 LP 表逐位待核 |
| X6-LP-0037 / X6-LP-0038 | runtime-root-records warn/error，同 R2-W1 与拆分模块映射 |
| X6-LP-0039 / X6-LP-0040 | executors / local_shell_execute warn/error，待核具体 executor |
| X6-LP-0041 | executors / local_shell_preflight warn，待核 |
| X6-LP-0042 | executors / runtime_root_request warn，待核 |
| X6-LP-0043 | shell-sandbox-windows warn，同 W3 |
| X6-LP-0044 | executors / workspace_executor warn，待核 |
| X6-LP-0045 | executors / workspace_fs_executor warn，待核 |
| X6-LP-0046 | vfs-resolver-repository warn，待核分拆资源模块 |
| X6-LP-0047 | card-read-scope error，锁毒化/恢复不变量待核 |
| X6-LP-0048 | index/coordinator error，锁毒化分支待核 |
| X6-LP-0049 / X6-LP-0050 | schema/database warn/error，损坏恢复与锁毒化分开核对 |
| X6-LP-0051 | emitter warn，共享发送函数逐路径待核 |
| X6-LP-0052 / X6-LP-0053 | workspace-repository warn/error，行映射在 src/workspace/repo.ts |
| X6-LP-0054 / X6-LP-0055 | sleep-repository warn/error，与 sleep-manager 对齐待核 |
| X6-LP-0056 | subagent-task-repository warn，待核 |
| X6-LP-0057 / X6-LP-0058 | plugin warn/error 总量，仅索引，不作为失败结论 |

F3-V2-05 的注册契约已由 F3 `1c7e85967` 明确回执：
`registerWorkspaceIndexDeletionOwner(owner: (conn: SqlExecutor, workspaceId: string) => void): Disposer`，
重复抛 SlotOccupied，dispose 幂等且不清后继；当前 main 未合入该导出。
待正常集成后在 index 用 ctx.effect 注册/释放现有 deleteWorkspaceIndexWithConn，
不直接 import 候选实现或复制 F3 编排。

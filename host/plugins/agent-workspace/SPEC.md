# L05-agent-workspace 行为规格（`host/plugins/agent-workspace/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 12 个 · 发出事件 9 种 · 契约：`contracts/ipc/L05-agent-workspace.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：`RuntimeDirectoryEntry.size_bytes` 目录为 `null`；`SkillTrustState.package_sha256` 撤销信任时为 `null`；其余 Option 参数按契约省略或 `null`，见各命令（runtime_roots.rs:1746–1749,1601–1668）。
- [x] u64/i64 超过 2^53 的表示：`size_bytes`/`max_bytes` 用 JS number；超过 2^53 会丢精度（本 lane 预览上限 1 MiB，实际安全），属 JS 运行时限制。
- [x] 字段顺序（serde_json preserve_order）：TS 对象字面量按 Rust 结构体声明顺序构造；本 lane 无整数键对象，不会触发 JS 数值键重排。
- [x] f32 精度：本 lane 无 `f32` 字段。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：Rust `Err(String)` → `throw new CommandError(message)`，IPC 以字符串拒绝；无 panic 路径，错误文案逐条保留（index.ts:24–31）。
- [x] 取消：本 lane 12 个命令没有 `CancellationToken`，不会产生取消结果。
- [x] 并发：Rust `runtime_root_settings_guard` / `artifact_mutation_guard` 的互斥临界区在 TS 中为同步 read-modify-write（单 tick 完成，无 await 交错），与 Host 单写者语义一致（runtime_roots.rs:242–254）。
- [x] 时间与 ID：`trusted_at` 为 RFC3339 UTC；authorized root id = `authorized_` + sha256(canonical) 前 16 hex；session 目录 `v2-<≤96 ASCII 小写前缀>-<sha256 前 32hex>`；备份名 `<millis>_<4 位序号>_<安全文件名>`（runtime_roots.rs:904–907,1248–1259,256–309）。
- [x] 不对含 HashMap 的结构做序列化后比对：本 lane 不序列化 HashMap。
- [x] 日志（quality.md §7）：Rust `warn!/error!/info!` 逐条经插件 logger（`ctx.logger`）或仓储函数的 logger 参数记录；
  Node 没有 Rust `Mutex` 毒化分支，对应 `Mutex poisoned` 日志不适用。工作中区/工具执行器把 `warn`/`info` 注入
  `WorkspaceExecutorContext`、`GitExecutionContext` 等执行上下文；`WorkspaceDatabase`、`WorkspaceRepo`、
  `SleepManager`、`CustomAgents`、`VfsResolver` 均接收 logger，默认静默仅用于单元测试。
- [x] 生产代码无 `console.*`：日志只经 kernel logger / 注入接缝（boundaries strict `console-log` 本 lane 0 条）。

## 服务与跨 lane 接线

### RF-S01-shell-environment-failure：本地 shell 执行环境失败
- 契约与消费方见 `src/tools/shell-execute/README.md`；移动端不提供（插件仅桌面）。
- 测试：`tests/shell-environment-failure.test.ts`、`tests/local-shell-git-contribution.test.ts`。
- 现状：分类与报错文本在 `src/tools/shell-execute/environment-failure.ts`（前缀 `LOCAL_SHELL_ENVIRONMENT_FAILURE (stage=…)`，
  阶段为 `resource_limits`、`sandbox_setup`、`spawn`、`process_io`），与命令自身的非零退出、超时、取消分开报告。

### WP-063 / X3-L05-02：历史 inbox 恢复

- Rust `workspace/coordinator.rs:986–1011,1059–1067`：磁盘实例读取 workspace，构造一个
  InboxManager，以 repo.get_all_unread_inbox 恢复后，同一个对象同时交给 router 和 instance。
  新建实例仍为空队列；恢复不改 message/inbox 行。非空恢复记录 info（数量、workspace ID）。
- `workspace/repo.rs:380–395`：只取 unread，按 priority DESC/id ASC 恢复；
  `inbox.rs:26–44`：按 session 分队列、message ID 去重。加载后新投递按 FIFO 追加。
- `coordinator.rs:542–624`：peek 不出队、不标记；drain 只标实际出队 message 对应的 unread
  行为 processed，message 状态不改；pendingInboxCount 仍以 DB 为准。重开不重放已消费项。
- 本包只修构造对象传递，保留仓储、队列、drain 算法；真实 Host/F3 的卸载重装回归验证
  count=1、两次 peek 全列不变、后续 router 投递可见、精确 drain 与二次重开。
- 历史 V1 seed 直接复制 C2 已关闭产物；Host 按生产先迁移 F3 共享库，再惰性打开工作区。
  新历史测试比较八业务表与 sqlite_sequence 全列，旧纳秒/JSON TEXT/i64 保留，
  drain 只把原 inbox 行标 processed；后续 send 不改变旧 message，再次重装不重放。

- W02 / 单个 WorkspaceFsExecutor 贡献：L07 `eb1f08b32` 的正式 Disposer 合同在 main 后，
  index 在 `ctx.inject(['agentTools'])` 的同scope `ctx.effect` 中登记唯一
  `WorkspaceFsContribution(toolExecutors.createWorkspaceFs())`，退出时调用实际registration.dispose。
  适配对象只转发name/canHandle/sensitivity/resultBudget和原execute，不复制文件操作或补其它roster。
  L04 ExecutionContext 的session/block/services/skill roots与事件/保存方法按次映射、箭头保receiver；
  参数保持unknown原值由原业务字段解析处理，不通过scanner或JSON重编码。
  Rust workspace_fs_executor.rs:80–94,483–493 的window_ref在支持工具的开始事件后、root解析前
  执行，缺窗口错误向registry传播（executor.rs:232–236为panic），不转成普通业务失败保存。
  runtime_roots.rs:1435–1499 的group首选根仅在读工具省略显式root时查询：同caller getConnSafe
  连接经L04 getSessionWithConn/getGroupWithConn，保trim、三类warn/None和本地不可解析回退。
  root只读/可写及skill trust仍由原业务体校验；取消/timeout沿L04真实registry，无默认authority。
  正式profile测试无provide替身，验证恰一可执行贡献、L04实际registry/上下文/保存与事件、
  group选择及失败日志、显式root免查询、只读写拒、windowless、预取消、技能授权/撤销、
  unload/reinstall及旧Disposer不影响新登记。旧贡献快照按L07原合同保留，不宣告全roster/
  chatToolRuntime或Windows完成；完整测试结果见LANE。

- V2-1.3 / MutationReceipt、ChangeSet from_value边界：`workspace_change_set.rs:18–48`，
  命令runtime_roots.rs:2517–2519与工具workspace_fs_executor.rs:911–937。
  新domain value decoder按输入map顺序验证已出现字段，最后按Rust声明顺序报missing；
  支持9/2元素结构体数组、单key unit-enum map、Option null/缺省与unknown字段忽略。
  输出None字段省略；change-set内部错误不添加Rust没有的changes[index]前缀。
  u64范围0..MAX显式校验，高位以bigint保留，生成文件回执仍保持安全number；泛型bytes仅区分
  本地生成与解码输入的精确表示。IPC出站继续由kernel D3转换，不在解码或回滚内Number降精度。
  文案/顺序依据serde_json-1.0.149 value/de.rs:182–210,234–258,482–495,556–560、
  number.rs:592–598（桌面arbitrary_precision数字parse失败为invalid number），及serde_derive
  1.0.228的struct visitor。复用kernel公开unexpectedOf，未复制其它lane decoder或JSON文本解析器。
  输入number以Host/frontend JSON的十进制表示解释，bigint直接保留；已丢失的原始数值lexeme
  （模型JSON的1.0/1e0等）需要上游值模型保留，不能由本unknown对象解码器恢复。
  新IPC/工具回归验证错误优先级、完整u64、map/seq回滚、None省略与wire转换；原Rust断言未改。

- V2-1.7 / 执行耗时：九类executor的Rust `Instant::now/elapsed().as_millis()` 改用
  `performance.now()` 采样与 `Math.trunc(end-start)`，保持成功/失败事件和ToolResultInfo
  的整数毫秒。原计时边界不变：入口emit-start之前开始，dispatch完成后、save block之前结束；
  shell实际进程的output.duration_ms另保留spawn前至drain完成的独立区间。
  Rust定位（tools/）：workspace_executor.rs:755–773、workspace_fs_executor.rs:999–1016、
  git_executor.rs:705–731、file_manager_executor.rs:878–886、code_navigation_executor.rs:534–544、
  lsp_navigation_executor.rs:676–685、runtime_root_request_executor.rs:178–182、
  local_shell_preflight_executor.rs:654–660、local_shell_execute_executor.rs:2076–2168,2355–2361。
  profile/payload按mtime清理仍对应SystemTime，持久化时间与ID不改用单调时钟。
  新生产工厂回归在emit-start期间模拟墙钟前跳/回拨，验证九executor返回/存储/事件使用
  单调整数毫秒；另覆盖实际artifact成功与Linux真实shell进程输出耗时。原Rust断言不变。

- V2-1.4/1.7 / artifact与backup write_all：复用上一单元的短写/EINTR/WriteZero处理，
  提取本lane `file-write.ts::writeAll`，由workspace-change-set、write-backups和workspace-fs
  三个真实写入入口调用。Rust runtime_roots.rs:2142–2174对应backup create/write/sync/persist，
  :2341–2368对应restore create/copy/sync/persist；workspace_fs_executor.rs:443–474对应
  artifact create/write/sync/recheck/persist。各自保留不同错误前缀（write staged backup、
  stage artifact content、stage artifact），不合并为泛化错误。备份完整写入后才累计hash/bytes，
  restore完整写入后才累计copy字节；finally关闭和stage清理、失败时撤回多余backup、保留
  restore源backup及目标原文的顺序不变。新增真实executor→backup→IPC restore多块短写回归，
  以及三条路径的open/write/zero/sync故障矩阵；不修改原Rust断言和平台pending状态。

- V2-1.4/1.7 / workspace staging：`workspace_change_set.rs:347–355` 的
  NamedTempFile→write_all→sync_all 原顺序保留。创建stage、写入、同步失败分别映射
  `Failed to stage workspace write/content`、`Failed to sync workspace content`。
  单次writeSync替换为write_all语义：短写继续剩余切片、Interrupted重试、WriteZero报
  `failed to write whole buffer`；空内容不调用write。成功后仍先sync再persist，失败走既有
  finally关闭/删除stage，不改变原checkpoint创建及rename/noclobber策略。
  新executor真文件测试覆盖短写/Interrupted、open/write/zero/sync四种失败，验证回执哈希、
  完整内容、原目标未覆盖和stage清理；原8个Rust测试断言不变。

- V2-1.4 / workspace move 回执：`workspace_change_set.rs:562–573` 在移动已成功后，
  目标metadata读取失败使用bytes=0，仍返回带路径/hash的可撤销回执。TS此前直接statSync
  抛错会把成功移动报告成失败并丢掉回执；现按Rust best-effort回零，无额外warn。
  新真实executor→注入目标stat失败→IPC回滚测试验证内容已移动、bytes=0与回滚恢复。

- R2-W3 / Windows directory identity：`runtimeRootIdentity` 保留 Rust
  runtime_roots.rs:569–574 的 metadata/目录校验顺序，Windows :585–600 改调正式 F7
  `runtimeRootIdentity`（access=0 + BACKUP_SEMANTICS → GetFileInformationByHandle → finally
  CloseHandle），不再用 Node dev/ino 构造 Windows volume/index。file_index 保留 bigint，
  沿既有 exact encoder 写入 JSON 数字；open/inspect 原前缀直接由 F7 保留。
  Context 服务沿 set/authorize/list/revalidate/skill trust、root token、host cwd 和完整shell
  approval binding 显式传递；executor 工厂给 shell/preflight/file-manager/code/LSP/root-request
  传按次 getter，workspace-fs 沿已有 getter，不修改调用者上下文或设置服务接口。
  公共 settings型 helpers 新增末尾可选 windowsFiles 参数；RuntimeRootDeps 消费者在Windows
  必须传真实服务。缺服务拒绝身份读取；list中的stale/is_ok分支保留原规则。
  原 Windows 测试按 :2618,2633–2635 恢复真实handle断言：两次目录身份相同、同卷、文件/目录
  index不同、FILE_ATTRIBUTE_REPARSE_POINT为0；移除 Node ino/lstat 替代断言。其它测试仅
  注入真实Windows provider并用exact encoder准备记录，期望值/方向不变。新增真实Windows
  IPC→持久化→executor→审批绑定→卸载/重装/替换目录测试；Linux跳过，五项pending不改。

- C1 / R2-W3 workspace-change-set reader：对照 `workspace_change_set.rs:287–317`，
  本模块先 symlink_metadata → 常规文件检查 → 64MiB 检查 → OpenOptions.open；
  仅 Unix 设置 O_NOFOLLOW，Windows 原 Rust 没有 runtime_roots 的 OPEN_REPARSE_POINT
  或 opened-handle identity 复核。TS 保留本模块打开策略/错误顺序，打开的 fd 交给
  既有 `RuntimeReadFile` 的 `runtimeReadFileFromFd`，不误用 F7 preview 的更强打开策略。
  read_and_hash 与 workspace edit 共用 `readRuntimeFileToEnd`；EOF 后再判增长超限，
  读取失败固定 `Failed to read workspace file:`，成功/失败均 finally close。
  :407–421 checkpoint、:513–527 跨卷 move 的读取仍经过同一 read_and_hash；无第二套流。
  :455–466 覆盖顺序修正：确认常规文件后先要求 expected_current_hash，再读取旧内容，
  最后 verify_current_hash；不把 oversized/read 错误提前覆盖 missing-hash 错误。
  新生产 executor/IPC 回归覆盖稀疏超限＋缺hash的错误优先级、多块短读＋checkpoint恢复、
  open/read错误前缀、fd关闭及失败前无checkpoint/写入。原8个Rust测试断言不改；
  Windows原5项、root identity和ACL/helper仍pending。

- R2-W3 / shared file reader 增量：`openRuntimeReadFile` 对应 Rust `File` 的顺序 Read、
  `metadata()` 和 Drop。Windows 使用正式 F7 no-follow handle、bigint readAt 游标和
  `refreshInformation().size`；Unix 继续使用原 no-follow fd。预览、备份、恢复、哈希验证、
  `workspace_file_read` 与 edit 全文读取共用该入口，均在 finally 关闭。备份仍 64KiB 分块，
  edit 保留 Rust read_to_end 后限额检查，不在读取器缓存整个文件。
  Rust 映射：runtime_roots.rs:2183–2199（备份 metadata/限额）、2246–2261（哈希流）、
  2303–2397（校验先于恢复、临时文件后原子替换）；workspace_fs_executor.rs:283–365、707–730。
  同步读取故障恢复原前缀 `Failed to read backup source/artifact/file`、metadata 前缀和
  `Failed to stage artifact content`；没有新增 DB 写入或日志。index 按次传 native 服务给 undo，
  executor 工厂持有 Context getter，每次 execute 取得当前服务，卸载后不使用旧引用。
  普通原 Rust 测试只新增真实 Windows provider 参数，全部断言保持原值/方向；新增多块覆盖→
  备份→IPC恢复与读取失败关闭/删除stage测试。Windows 短读/metadata异常测试待目标平台运行。

- R2-W3 / runtime preview 原生接线（Windows 子项，未目标平台签收）：
  `index.ts` 每次 IPC 从 Context 读取 `nativeWindowsFiles`，传入 `RuntimeRootDeps.windowsFiles`。
  `runtime_roots.rs:2560–2568` 路径校验和 maxBytes clamp 保留；`:2569` 的 Windows
  no-follow open 由正式 F7 `openRegularFileNoFollow` 执行（同 handle 的 reparse 检查）；
  `:2570–2573` 的 take(limit+1)/read_to_end 对应同 handle `readAt(BigInt(total),remaining)`，
  短读继续至 EOF/limit+1，错误保留 `Failed to read file:`；finally 关闭唯一 handle。
  `:2574–2582` 截断和 UTF-8 lossy 输出不变。无 DB 写入、无新增日志；缺失/卸载 native 服务
  明确报错，不转回 Node 路径重开。新增真实 Windows provider 的 IPC 测试覆盖有界短读、
  错误清理及卸载；Linux 仅验证原分支并编译该测试。root identity、backup/workspace reader
  与 ACL/helper 仍待后续接入，五个原 Windows TESTMAP 行继续 pending。

- F3-V2-05 / R2-W2：`index.ts::apply` 通过 `ctx.effect` 注册正式
  `registerWorkspaceIndexDeletionOwner(deleteWorkspaceIndexWithConn)`，卸载时释放 Disposer。
  对齐 Rust file_deletion_queue.rs:261–289：F3 在 prepared 写入后、既有 SAVEPOINT 释放前
  调用 L05 原 workspace_index DELETE；沿用 caller conn，无额外事务。owner SQL 失败使
  prepared 和 metadata 同时回滚，文件保留；缺 ID 成功。真实 Host 测试覆盖 apply/卸载、
  后继注册、trigger 失败回滚与借用句柄全路径关闭，standalone fixture 显式注册同一 owner。

- ChatToolRuntime shell 绑定补全：runtime_roots.rs:1132–1229 的 shell_runtime_approval_binding。
  full-access 绝对 cwd 直接走已有 host cwd 绑定；否则先解析/重验 selected root，再校验 cwd 在根内且为目录。
  聚合配置 roots、会话 artifact/temp、已加载技能 roots 及支持目录，按 canonical path 去重、UTF-8 排序；
  原 root binding、cwd identity、完整 readable 集合进入既有 SHA256 绑定，不序列化 HashMap。
  保留 true 创建会话根、错误前缀、readonly 支持根与原字段/顺序。Windows identity 源仍属 W3 未验证。

- ChatToolRuntime 新指派的 effectiveSensitivity/isExternalMcp：按 tool_approval_policy.rs:24–143
  提供精确来源/域规则解析；按 scoped tool→legacy tool→source→domain→global bypass→base 顺序，
  无效设置继续下一级；precise runtime-authority 工具不可被 broad low 降级（保留原 base，包括 null）。
  原 Rust 六个测试迁入本 lane 验证公共 API；原 inventory 归 L04，通知协调者对齐去向，不越权改 L04 TESTMAP。
  函数只使用注入的 getSetting，无日志/写库；组合根需保留 Rust settings.get().ok().flatten()。

- ChatToolRuntime / L05 现有审批面：api.ts 公开已有 approval_scope 分类、脱敏、root binding、scope key/scope
  函数。ApprovalManager 的 registerWithPermissionPreset（原 Rust approval_manager.rs:240）实现已存在，
  本次补齐公开接口；实例 generateDescription 转发同一静态实现（原 Rust generate_description）。
  保留 cautious/high 禁止记忆、其它 preset 仅会话记忆、调用方负责超时/取消、无额外 DB 写入。
  L04 负责组合根，L03 保留 gate 顺序；不在此复制执行器花名册。

- 架构师 / L04 chat_v2_wake_session：api.ts 同时重导出已有 escapeXmlContent 和 escapeXmlAttr，
  不复制实现。Rust vfs_resolver.rs:2868–2880 的 test_escape_xml_attr（4 条）与
  test_escape_xml_content（3 条）均经公共 api.ts 调用，输入与原断言不变。

- C04-03/X5 goal steering 复用口：api.ts 重导出既有 `escapeXmlContent(value: string): string`，
  仍由 vfs-resolver/model.ts 实现，按 Rust vfs_resolver.rs 转义 & / < / >；无状态/日志/副作用。
  原 test_escape_xml_content 仅改从公共 api.ts 导入，三个原断言不变；不复制 L04 goal runtime 或转义实现。
- F7 nativeSandbox 已合 main：transform-sandbox 的 probe/launch 类型改为引用正式 sandbox/api.ts，
  index 从 Context 取真实服务而不做候选类型断言。保留既有可空管道出口兼容 L24；新增真实 Linux
  Context provider 验证 env 白名单、CPU/文件/进程数限额、AbortSignal 终止与回收，不签收 Windows/macOS。

- X6-AP 两项已确认遗漏的原断言补齐：runtime_roots.rs:2868 的风险分类必须为 Critical，
  以及 utf8_paged_read.rs:311–315 调用真实外层 apply_tool_result_budget 后结果不变。
  分别通过原生产 helper 和 F1 api.ts 的 applyToolResultBudget 验证；不改变原输入、已有断言或业务实现，
  其余 loop/tuple 计数线索不以机械增加 expect 处理。

- X6-PR-agent-workspace-workspace-injector-1：按 Rust workspace/injector.rs:16–144 发布既有
  WorkspaceInjector/InjectionThrottle/MAX_INJECTED_MESSAGE_CHARS，构造依赖收窄到公共 coordinator
  的 hasPendingMessages/drainInbox（运行逻辑不变）。原 5 个 Rust 测试只改公开导入路径，断言不变。
  tool_loop.rs:483 要求每次执行复用一个 throttle，2384–2396 为生产检查点；当前 L03 尚未接入，
  5 行 TESTMAP 保持 pending，不以单纯出口存在宣称可达。

- v2 / F3 journal 阻塞解除：`storage/API.md` §10 已公开接受 SqlExecutor 的
  recoverWorkspaceDeletions/prepareWorkspaceDeletion/finishWorkspaceDeletion/cancelReadyWorkspaceDeletion。
  按 Rust `workspace/database.rs:237–242,433–499` 直接使用平台端口；不再复制 journal/outbox 写入。
  prepared+workspace_index 删除同 SAVEPOINT 提交后才物理删除，ready/published 重复删除幂等，重建取消 ready。
  journal 连接在成功/错误/早返时均 finally close（对应 Rust Connection Drop）；配置失败也关闭。
  busy_timeout 错误为 `Failed to configure workspace deletion journal:`，foreign_keys 独立错误为
  `Failed to enable workspace deletion foreign keys:`，保留底层 Display；本段 Rust 无额外日志。
- F3-V2-05 owner 接缝：公开 `deleteWorkspaceIndexWithConn(conn: SqlExecutor, workspaceId: string): void`，
  是已有 repository/chat-v2-repository.ts:21 的同义导出（Rust workspace/coordinator.rs 的 remove_from_index，
  以及 dstu-storage/file_deletion_queue.rs:238 的 prepared SAVEPOINT 内同一 DELETE）。缺记录成功，
  底层 SQL 错误原样传播；不启动/提交事务、不删文件、不发事件。F3 应在 prepared 后/RELEASE 前调用，
  平台→owner 注册接口与生命周期已向 F3 请求确认；没有用测试替身宣称该注册已接通。

- C1 08:28Z L03 分类口：api.ts 直接重导出 `isLocalShellExecuteTool(toolName: string, args: JsonValue): boolean`，
  实现仍在 `approval-scope/classification.ts:117`，对照 Rust `approval_scope.rs:52–85,104–109,141–145`。
  只认 source 为 builtin/local 且 semantic short name 为 local_shell_execute；MCP 包装名仍是外部来源，
  不能因有 command 参数或看似 builtin 的后缀当成本地 shell。无日志/副作用，不改策略、不迁 tool loop。

- C1 08:21Z persona 校验公开面：从 api.ts 直接重导出已有 `validatePersonaModelConfig`，
  对应 Rust `workspace/agent_profile.rs:425–451`；configs 是调用方提供的当前运行时模型配置列表，
  最小字段 `id/enabled/isEmbedding?/isReranker?/isImageGeneration?`（已有 PersonaModelConfig）。
  modelId 按 Rust trim 后精确匹配第一个 config.id，不按显示模型名匹配；依序检查存在、enabled、
  三种非 chat 模型标记，成功 void，失败 Error.message 是 Rust Err(String) 的完整原文。
  无日志/副作用；L04 的命令边界按其原契约传播该字符串，不复制校验实现。

- R2-W2 / C1 同步许可：`coordinator.rs:266–292` 使用 try_acquire（不是等待），
  index 每次调用真实 `governance.tryAcquireOperationGuard('delete_propagation')`。
  provider 的业务错误按其 Error.message 原文转为本服务 Err(String) 语义，不按文案猜 busy/IO，
  不透传不符字符串契约的 CommandError(AppError)。许可取得后才取 worker 列表、close、删除 DB/index、
  逐 worker 先清理 runtime roots 再调 L04 deleteSessionV2；finally release 覆盖所有失败路径。
  L04 方法在 b0ed6a135 候选分支真实实现，当前 main 尚未合入；本 lane 仅定义消费子接口，
  缺方法显式报错且不直接写 chat 表。真实 L21/F3 测试验证忙锁、整个清理期间的许可及异常释放；
  L04 回调用替身，不冒充三插件永久删除整链验收。

- L24 沙箱适配（`chatanki_transform_script.rs:1115–1180`）：policy/解释器/job/env 由
  原所属逻辑构造，L05 使用既有 bwrap/Seatbelt descriptor，F7 只处理原生进程启动与回收。
  发布异步 `agentTransformSandbox`：capability await 真实 probe；spawn await 原生成功确认，
  失败时清理 L05 profile/payload 并传播原错误，成功后仅返回实际 pid/streams，取消信号直传。
  cleanupResources 在原生清理后 finally 清理 L05 descriptor。L24 需在原 setup try/catch 内
  `await backend.spawn`，在解释器/job 创建前 `await capability`；不能以 Promise 占位 child
  冒充同步 TransformSandboxBackend，否则 spawn 失败会变成 wait 失败且启动耗时混入执行超时。
  Windows 仍待 F7 合入及 L05 ACL/helper 接线，不以 primitive spawn 代替完整策略。

- R2-W1 06:00Z 补充：Rust `runtime_roots.rs:148–200,648,982,1270` 对记录逐字段
  Deserialize，已消费的非法字段应先于后续 JSON 截断失败；重复字段在读到键时即拒绝。
  Host 改为在 map/sequence 读取过程中调用字段解码，authorized 数组逐条完成记录校验，
  未知字段仍按 JSON 规则跳过，完整有效记录保持默认值、枚举、u64 精度和声明顺序。
  生产 roots IPC 回归组合 null/错误类型/重复键/前条缺字段与后部截断，不改独立验收勾选。

- X4 W08：`code_navigation_executor.rs:431–498` 先校验 query/regex/case_sensitive，
  使用 Rust RegexBuilder 编译（错误前缀 `Invalid search regex:`），再校验路径并搜索。
  Host 生产代码仅引用 F7 regex/api.ts 类型，index 从 Context 按调用取得 nativeRegex，
  compile/captures 使用同一个服务实例；不直接导入 regex/index.ts，不回退到 JS RegExp。
  Unicode/命名组/字符列、大小写参数及 lookaround 拒绝语义保持；服务卸载时明确失败，
  重装后既有 executor 使用新提供方。只读 outline 不强制要求 regex 服务。

- C1 L13 `DstuUploadRoots` 接线：原 Rust `src/chat_v2/tools/dstu_executor.rs:302–312`
  传入当前 session_id/skill_package_roots、create_session_roots=false，再调用 revalidate_runtime_root。
  新发布 `runtimeRoots.rootById(rootId, context)` / `revalidate(root)`，复用已导出的真实实现；
  Record 技能映射只适配为 Rust HashMap 对应的 Map，不查找或授权调用方未提供的技能根。
  上下文缺 session_id 显式拒绝，禁止默认合并到共享 session；不改变原根权限、目录创建或错误顺序。
  仅闭合根定位/授权服务，L13 上传文件打开与 Windows opened-handle/reparse 能力未因此完成。

- C1 公共 API：补全已有 `getTaskManager/getSleepManager/emitWarning/emitCoordinatorAwakened`
  合约签名（Rust `workspace/coordinator.rs:740,774,908,1071`），暴露原 manager/factory 和事件入参类型。
  L03 从 api.ts 引用 `immutableShellCommandGuard`（`approval_scope.rs:2671`），不复制策略。
  L19 从 api.ts 引用 HEADLESS_ALLOWED_TOOLS 与 `runtimeRootById/revalidateRuntimeRoot/authorizeRuntimeRootPath`
  （`runtime_roots.rs:930,1030,1350`）；授权仍只读，撤销后重验证报原错误，headless 不新增 browser 权限。
  只增补导出与类型；实际实现继续通过现有 agentWorkspace/index 和 runtime-root IPC 使用。

- R2-W5：`runtime_roots.rs:1698–1801` 的 cursor 是桌面 64-bit usize，接受可选 `+` 和
  ASCII 十进制数字（含前导零），拒绝符号负数/空白/小数/溢出。Host 使用 bigint 保留
  0..=18446744073709551615，迭代器提前耗尽即返回 scanned=0 空页，不按数值大小空转。
  next_cursor 用饱和相加后十进制字符串返回，JSON 返回形状不包含 bigint，无新日志/副作用。

- R2-W1：按 `runtime_roots.rs:639–664,973–994,1266–1271,1617–1652,1860–1865,2573`
  分别保留 load/save/serialize/reset/trust revoke/persist/read 的完整前缀；底层错误 Display 作为后缀。
  持久化 WorkspaceRootRecord/AuthorizedRootRecord/SkillTrustRecord 按 Rust 字段顺序解码，
  必填字段/类型/重复字段报错，忽略未知字段；workspace 缺 access 默认 read_only，缺 identity 为 null，
  不把未知 access、非数组 authorized JSON 静默降级。错误包含 serde 的行列。
  identity 字段按 Rust 变体声明顺序重建，持久化 JSON 的键顺序变化不会使同一文件系统对象误判为 stale；
  回归通过真实 roots IPC 验证重排后的 workspace 仍 configured=true。
  本轮新合入 D3 后，记录中的 u64 identity 在超过 2^53 时保留 bigint，写 settings 与计算
  Rust 既有授权摘要时用 Node 24 raw JSON 数字，不把它转换为舍入的 number 或字符串。
  实际 stat 读取也保留大整数；Windows handle/reparse 原生能力仍属 W3 未闭合项。
  这些错误路径无 Rust warn/error 日志，不增写日志或吞错误；settings 失败时不继续返回 roots。

- C1 receiver 修复：Rust `workspace/coordinator.rs:178–180,225–226` 将真实 DB 交给 repo，
  Host 的 liveExecutor 每次从 WorkspaceDatabase 借用当前连接，再保留该连接作为调用 receiver。
  不提前绑定旧连接：维护期间继续拒绝借用，退出后访问重开的连接；不改变 SQL/事务/日志。
  通过 index 发布的 agentWorkspace 与真实 F3 SQLite 验证创建、收件箱、维护、重开及关闭落库。
  同一测试还复现了设置 maintenance=true 后通过公共 getConnection 借用自身 checkpoint 连接
  导致必失败的问题：按 Rust `workspace/database.rs:380–395` 保留内部 checkpoint 连接，
  在同步临界区内阻止新的公共借用后 checkpoint/close，失败时恢复 flag 并传播原错误。

- LSP 原测试恢复（`lsp_navigation_executor.rs:800–839`）：找不到 rust-analyzer 或
  `--version` 在 5 秒内未成功时早退；可用时在临时 Cargo 工程调用生产 `LspSession.start`，
  20 秒内完成 `initialize` / `initialized`，随后 SIGKILL 并等待进程退出。
  初始化沿用 Rust 禁用 build scripts/proc macros/diagnostics/checkOnSave 的参数；本测试无日志。
  平台测试只按原 Rust cfg 限制执行，Seatbelt 测试不再额外要求环境变量开关。
- Windows native 测试核对（`shell_sandbox/windows.rs:2309–2424`、`runtime_roots.rs:2608–2636`）：
  网络测试必须监听本机 TCP 连接并断言 4 秒观察期内未连接；原移植漏掉了该断言，现已恢复。
  AppContainer 三项/原生取消一项及文件 handle 身份一项仍缺 F7 原生接口，TESTMAP 改回 pending；
  不再用 `windowsNativeSandboxAvailable() === false` 跳过 Windows 上应失败的测试。

- 服务描述（`docs/plugins/ARCHITECTURE.md` 附录 A）：`agentApproval`（`ApprovalManager`）、
  `agentWorkspace`（`WorkspaceCoordinator`）、`agentWorkspaceTools`
  （`AgentWorkspaceToolExecutors`），以及 `agentVfsResolver`、`agentCompletionOutbox`、`runtimeRoots`、
  `agentTransformSandbox`（异步 L24 policy/backend 适配），
  均在 `index.ts` 中 `provide` 并写入 `meta.provides`。
- 工具花名册：`agentWorkspaceTools` 暴露本 lane 的 9 个 executor 构造入口与 8 个
  `workspace_*` schema；Rust `AppExecutorRoster` 归 app 层，Host 侧归 L04。
  `待接线：agentWorkspaceTools（L04 花名册尚未注册这些 executor）`。
- 工作区删除：Rust `WorkspaceCoordinator::delete_workspace` 调用
  `ChatV2Repo::delete_session_v2` 清理 worker 会话；L04 b0ed6a135 已发布真实候选，main 尚未集成。
  Host index 已绑定按需取 `chatSession.deleteSessionV2` 的接缝，缺方法时在原 worker 清理阶段
  聚合明确错误；不绕过 runtimeRootCleanup、不写 chat 表。`待集成：chatSession.deleteSessionV2`。
- 操作权守卫：Rust 删除/回滚路径通过 `DataGovernanceOperationGuard` 与备份/恢复串行化；
  L21 正式 API/provider 已合入，工作区删除严格使用同步立即失败的
  `governance.tryAcquireOperationGuard('delete_propagation')`（Rust :266–271），不调用等待型 acquireOperation。
  不自建锁或复用其他 kind；取得真实 guard 后沿用 try/finally release。
- 卡面只读作用域：`installWorkspaceCardReadScope` 已从 `api.ts` 发布，
  `待接线：agent-workspace/api.ts（L24 chatanki 仍保留本地副本，应改为引用本 lane）`。
- 审批服务消费方：合并 main 后 L04 `host/plugins/chat/index.ts:93` 已改为
  `ctx.get('agentApproval')`，服务更名接缝已对齐。
- 已移植但未有生产消费方的模块/分支（TESTMAP 对应 11 行为 `pending`）：
  L04 `handlers/variant_handlers.rs` 的非多模态 resolver 调用尚未接入（2 行）；L04
  `completion_dispatcher.rs`、`handlers/workspace_handlers.rs` 尚未消费
  `CompletionOutbox`。三个 `adapters/*` 按协调者裁定改标 21 行 `obsolete:dead-in-rust`，
  TS 模块与测试已删除；完整 ID 见 `MIGRATION-REPORT.md`，C1 已在
  `migration/approvals.d/C1-app.json` 逐 ID 批准，ledger 分片读取已合入；不据此签署 B。
- 协调者指令 1 复核：L03 `4354a8b13` 已接入
  `history-vfs-context.ts:98` → `agentVfsResolver.resolveContextRefDataToContent(data, true)`，
  对应 Rust `pipeline/history.rs:671`；本次 main 已合入，生产服务方法位于 `chat-pipeline/index.ts:172–174`。
  TESTMAP 已记录 12 项逐项接线依据，并解除其中 10 项阻塞；
  `test_non_multimodal_image_request_downgrades_to_ocr` 与
  `test_non_multimodal_pdf_image_request_downgrades_to_ocr` 仍待 L04 的 false 调用。
- VFS：`api.ts` 已发布 `createVfsResolver(vfs, { vfsRepo, docs }, logger)`。
  2026-11-04 接线核对：Rust `vfs_resolver.rs:111–124` 从当前 VFS 连接与仓储解析资源；
  Host 对应读取 L11 已发布的 `vfsRepo` 服务（`vfs-repos/api.ts` 的服务名），每次调用重新获取；
  保留缺依赖错误、docs 延迟加载/卸载行为及全部解析分支，不缓存已卸载服务。
  Image/File/PDF/Note/Essay（含 session）/Translation/MindMap/InsightCard 分支已实现；
  文件读取调用 `vfsRepo.files.getContent`，文档解析调用 `DocsService.extractTextFromBase64`。
  main 已发布真实 docs provider，本 lane `index.ts` 已装配 `agentVfsResolver`，
  每次请求从 ctx 获取真实 vfs/vfsRepo/docs，缺失时报错，不返回占位结果。入口返回 Promise，L03/L04 须 await。
- Outbox：`index.ts` 发布 `agentCompletionOutbox`，每次操作重新借用 F3 的 chat_v2 句柄；
  schema 由 F3 V20260908 迁移提供。L04 仍需完成完成闭包/dispatcher 的实际消费，9 个测试保持 pending。
- 当前剩余项及接口责任人统一见 [BLOCKERS.md](BLOCKERS.md)；ledger 已确认 12/12 命令均达 A，
  SPEC 仅 `chat_v2_delete_artifact` 的 Windows 原生错误文案一项未勾选。
- 平台复用：时间/字符串语义直接引用 F4 `time/index.ts`、`util/index.ts`；
  用户输入正则经 Context 的 `nativeRegex.compile/captures` 使用 F7 Rust 引擎
  （异步搜索、UTF-16 偏移转字符列），生产模块仅 import regex/api.ts 类型。
  删除死适配器后本 lane 没有 HTTP 出站地址校验路径，无需复制 `net-policy`。

## 命令 `chat_v2_authorize_runtime_root`

<!-- BEGIN GENERATED:cmd:chat_v2_authorize_runtime_root -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:1871` · async
- 前端：app（1 处，例 `src/features/settings/components/mcp-tools/useToolPermissions.tsx:378`）
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：path: string, label?: string | null, sessionId?: string | null
  - 结果：RuntimeRoot[] · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_authorize_runtime_root -->

- [x] 输入：`path` trim 后必填并 canonicalize；`label` trim 非空优先，否则目录名，再否则 canonical 路径（runtime_roots.rs:931–982,899–906）。
- [x] 输出：返回 `chat_v2_list_runtime_roots` 的完整列表：workspace、authorized（按 label/path 排序）、artifacts、temp（981–982,1660–1671）。
- [x] 错误：`Path is required`、`Failed to resolve authorized runtime root: …`、identity 失败等原文透传（899–906,936）。
- [x] 事件：不发射事件（1871–1881）。
- [x] DB 读写：settings `runtime_roots.authorized` JSON 数组；path+identity 已存在时幂等返回不写；否则剔除同 id/同 path 后追加，按 label、path 排序保存（941–974）。
- [x] 取消/并发：无取消点；同步 read-modify-write 单 tick 完成，对应 settings mutex（242–247,941）。
- [x] 时间/ID：`id = authorized_` + sha256(canonical 字符串) 前 16 hex；authorized root 固定 `read_only`（904–907,985–1000）。

## 命令 `chat_v2_delete_artifact`

<!-- BEGIN GENERATED:cmd:chat_v2_delete_artifact -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:1965` · async
- 前端：none
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：sessionId: string, relativePath: string
  - 结果：Value · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_delete_artifact -->

- [x] 输入：sessionId、relativePath；trim 后规范化相对路径，拒绝绝对路径、任意 ..、空路径（runtime_roots.rs:523–549,1973–1976）。
- [x] 输出：{deleted:true,root_id:"artifacts",relative_path}，路径分隔符转 /（1982–1986）。
- [ ] 错误：Rust Err(String)，已保留业务文案；F7 Windows ioError 已合入，L05 路径/句柄调用链适配与目标平台验证仍待闭合，Unix 由 libuv errno 映射（1973–1981,2272–2301,2402–2431）。
- [x] 事件：不发射事件（1965–1987）。
- [x] DB 读写：注入的 _state 不使用；仅移除指定文件或符号链接本身，不删除目录（2402–2431）。
- [x] 取消/并发：Rust 没有取消点；mutation/session 锁临界区在 Host 同步执行，无 await 交错（1972,318–321）。
- [x] 时间/ID：session 目录为 v2-<最多96字符ASCII小写前缀>-<原ID SHA256前32hex>，只迁移无歧义旧目录（256–309）。

## 命令 `chat_v2_list_runtime_directory`

<!-- BEGIN GENERATED:cmd:chat_v2_list_runtime_directory -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:1785` · async
- 前端：app（1 处，例 `src/features/chat/api/taskWorkspaceApi.ts:42`）
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：sessionId: string, rootId?: string | null, relativePath?: string | null, cursor?: string | null, limit?: integer(usize) | null
  - 结果：RuntimeDirectoryPage · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_list_runtime_directory -->

- [x] 输入：`rootId` 默认 `"workspace"`；`relativePath` 经 `normalize_runtime_relative_path`（空或 `"."` → 根；拒绝绝对路径与 `..`）；`cursor` 默认 `"0"` 并解析为 usize，非法报 `Invalid runtime directory cursor`；`limit` 默认 40，clamp 到 1..=100（1785–1811,1701–1716,523–549）。
- [x] 输出：`{root_id, relative_path("/" 分隔), entries[{name, relative_path, kind:"directory"|"file", size_bytes|null}], next_cursor(string|null), truncated, scanned}`；按 kind 再按小写 name 排序（1738–1783）。
- [x] 错误：目标不存在/越界/非目录、read_dir/entry 读取失败均按 Rust 文案（1703–1736）。
- [x] 事件：不发射事件（1785–1811）。
- [x] DB 读写：读 settings 解析并重校验 root（`runtime_root_by_id` + `revalidate_runtime_root`）；不写。
- [x] 取消/并发：无取消点；同步目录扫描，单页最多扫描 1000 条原始 entry（1712,1723）。
- [x] 时间/ID：next_cursor 为已扫描条数的十进制字符串；`has_more = 满页或扫描达上限`，假阳性续页会返回空页并终止（1752–1756）。

## 命令 `chat_v2_list_runtime_roots`

<!-- BEGIN GENERATED:cmd:chat_v2_list_runtime_roots -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:1673` · async
- 前端：app（2 处，例 `src/features/chat/components/groups/GroupEditorDialog.tsx:223`）
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：sessionId?: string | null
  - 结果：RuntimeRoot[] · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_list_runtime_roots -->

- [x] 输入：`sessionId` trim 非空，否则 `"session-preview"`（1676–1683）。
- [x] 输出：固定顺序 workspace、authorized（label/path 排序）、artifacts、temp；`RuntimeRoot` 字段为 snake_case：id/kind/path/access/label/description/session_scoped/configured（1660–1671）。
- [x] 错误：settings 读取、JSON 解析、root 解析失败按原文透传（708–737,985–1030）。
- [x] 事件：不发射事件（1673–1685）。
- [x] DB 读写：只读 settings 的 workspace record 与 authorized records；不创建 session 目录（`create_artifact_root=false`）。
- [x] 取消/并发：无取消点，只读。
- [x] 时间/ID：workspace record 含 identity（Unix dev/inode、Windows volume/file index）；绑定失效时 `configured=false`，authorized 描述改为需重新授权（708–737,985–1000）。

## 命令 `chat_v2_read_runtime_file`

<!-- BEGIN GENERATED:cmd:chat_v2_read_runtime_file -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:2551` · async
- 前端：app（3 处，例 `src/features/chat/components/agent-task/ChangesSection.tsx:89`）
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：sessionId: string, rootId: string, relativePath: string, maxBytes?: integer(u64) | null
  - 结果：RuntimeFilePreview · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_read_runtime_file -->

- [x] 输入：`sessionId`、`rootId`、`relativePath`（规范化同上）；`maxBytes` 默认 65536，clamp 到 1..=1048576（2551–2570）。
- [x] 输出：`{content, truncated}`；最多读取 `max+1` 字节判断截断，非 UTF-8 字节按 lossy 替换（2566–2576）。
- [x] 错误：`runtime root does not exist`、`Target path does not exist or cannot be resolved: …`、`Path escapes the selected runtime root`、读取失败原文；打开时拒绝符号链接与非普通文件（1911–1938,2570）。
- [x] 事件：不发射事件（2551–2577）。
- [x] DB 读写：读 settings 解析并重校验 root；不写。
- [x] 取消/并发：无取消点；同步读取有界字节数。
- [x] 时间/ID：无时间/ID 生成。

## 命令 `chat_v2_reset_workspace_root`

<!-- BEGIN GENERATED:cmd:chat_v2_reset_workspace_root -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:1854` · async
- 前端：app（1 处，例 `src/features/settings/components/mcp-tools/useToolPermissions.tsx:413`）
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：sessionId?: string | null
  - 结果：RuntimeRoot[] · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_reset_workspace_root -->

- [x] 输入：`sessionId` 可选（1854–1869）。
- [x] 输出：删除 settings key 后返回最新 roots 列表（1865–1869）。
- [x] 错误：删除失败报 `Failed to reset workspace runtime root: …`（1862–1865）。
- [x] 事件：不发射事件。
- [x] DB 读写：删除 `runtime_roots.workspace`（`WORKSPACE_ROOT_KEY`）；不动 authorized records 与文件系统。
- [x] 取消/并发：无取消点；同步删除，对应 settings mutex。
- [x] 时间/ID：删除后 workspace 回到 fallback（进程 cwd、read_only、configured=false）（708–737）。

## 命令 `chat_v2_resolve_runtime_path`

<!-- BEGIN GENERATED:cmd:chat_v2_resolve_runtime_path -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:1941` · async
- 前端：app（2 处，例 `src/features/chat/components/AgentTaskPanel.tsx:328`）
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：sessionId: string, rootId?: string | null, relativePath: string
  - 结果：string · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_resolve_runtime_path -->

- [x] 输入：`sessionId`、`rootId` 可选（默认 `"workspace"`）、`relativePath` 规范化；不创建 session 目录（1941–1956,1911–1938）。
- [x] 输出：canonical 绝对路径字符串，保留原生分隔符（Rust `to_string_lossy`）；目标必须已存在且位于 root 内（1927–1938）。
- [x] 错误：`runtime root does not exist`、`Target path does not exist or cannot be resolved: …`、`Path escapes the selected runtime root`（1919–1935）。
- [x] 事件：不发射事件。
- [x] DB 读写：读 settings 解析 root；不写。
- [x] 取消/并发：无取消点。
- [x] 时间/ID：无时间/ID 生成。

## 命令 `chat_v2_revert_artifact_write`

<!-- BEGIN GENERATED:cmd:chat_v2_revert_artifact_write -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:2454` · async
- 前端：app（1 处，例 `src/features/chat/components/agent-task/ChangesSection.tsx:128`）
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：sessionId: string, relativePath: string, backupRef?: string | null, expectedAfterHash: string
  - 结果：Value · 错误：string · 注入：app-handle
<!-- END GENERATED:cmd:chat_v2_revert_artifact_write -->

- [x] 输入：`sessionId`、`relativePath` 规范化且非空、`expectedAfterHash` 必须为 64 hex、`backupRef` trim 后非空才视为恢复（2454–2480）。
- [x] 输出：有 backupRef → `{reverted:true, mode:"restored", root_id:"artifacts", relative_path, bytes_restored}`；无 → `{reverted:true, mode:"deleted", root_id:"artifacts", relative_path}`（2482–2505）。
- [x] 错误：`A relative artifact path is required`、`No artifacts exist for this session yet`、哈希不匹配/备份不存在/路径越界原文（2454–2505）。
- [x] 事件：不发射事件。
- [x] DB 读写：不写 DB；读写 artifacts 根文件与 temp 根 `.write_backups` 备份区（2467–2483）。
- [x] 取消/并发：无取消点；artifact mutation 互斥临界区在 Host 同步执行（249–254）。
- [x] 时间/ID：备份引用为 `.write_backups/<millis>_<4 位序号>_<安全文件名>`；恢复前校验当前文件哈希等于 `expectedAfterHash`，用户后续修改不会被覆盖（2454–2505）。

## 命令 `chat_v2_revert_workspace_change`

<!-- BEGIN GENERATED:cmd:chat_v2_revert_workspace_change -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:2510` · async
- 前端：app（1 处，例 `src/features/chat/components/agent-task/ChangesSection.tsx:123`）
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：sessionId: string, receipt: Value
  - 结果：Value · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_revert_workspace_change -->

- [x] 输入：`receipt` 反序列化为 `MutationReceipt`；`root_id` 必须为 `"workspace"`；workspace 必须 configured 且 read_write（2510–2536）。
- [x] 输出：`{reverted:true, root_id:"workspace", change_id, receipt}`（2540–2545）。
- [x] 错误：`Invalid workspace mutation receipt: …`、`Mutation receipt does not belong to the workspace root`、`Workspace root is not configured`、`Workspace root is read-only`、rollback 哈希绑定错误原文（2510–2538）。
- [x] 事件：不发射事件。
- [x] DB 读写：读 settings 校验 workspace root；不写 DB，按 receipt 回滚文件系统（2519–2538）。
- [x] 取消/并发：无取消点；同步回滚。
- [x] 时间/ID：`change_id` 来自 receipt；回滚前校验当前内容哈希，避免覆盖用户后续编辑（2510–2538）。

## 命令 `chat_v2_revoke_runtime_root`

<!-- BEGIN GENERATED:cmd:chat_v2_revoke_runtime_root -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:1884` · async
- 前端：app（1 处，例 `src/features/settings/components/mcp-tools/useToolPermissions.tsx:424`）
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：rootId: string, sessionId?: string | null
  - 结果：RuntimeRoot[] · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_revoke_runtime_root -->

- [x] 输入：`rootId` 与 authorized record id 精确匹配；`sessionId` 可选（1884–1899）。
- [x] 输出：更新后的 roots 列表（1897–1899）。
- [x] 错误：未匹配报 `Authorized runtime root not found`（1891–1893）。
- [x] 事件：不发射事件。
- [x] DB 读写：从 settings `runtime_roots.authorized` 移除记录并保存；未匹配时不写（1885–1896）。
- [x] 取消/并发：无取消点；同步 read-modify-write，对应 settings mutex（242–247）。
- [x] 时间/ID：无时间/ID 生成。

## 命令 `chat_v2_set_skill_trust`

<!-- BEGIN GENERATED:cmd:chat_v2_set_skill_trust -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:1601` · async
- 前端：app（2 处，例 `src/features/chat/skills/skillTrustStorage.ts:156`）
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：skillId: string, packageRoot?: string | null, trusted: boolean
  - 结果：SkillTrustState · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_set_skill_trust -->

- [x] 输入：`skillId` trim 后非空且只含 ASCII 字母数字、`-`、`_`；`trusted=false` 时撤销；`trusted=true` 要求 `packageRoot` trim 非空（1601–1633）。
- [x] 输出：`{skill_id, trusted, package_sha256}`；撤销时 `package_sha256=null`，信任时为当前包哈希（1655–1668）。
- [x] 错误：`Invalid skill id for trust record`、`package_root is required when trusting a skill`、`Failed to resolve skill package: …`、`Failed to persist skill trust: …`（1608–1656）。
- [x] 事件：不发射事件。
- [x] DB 读写：settings key `chat_v2.skill_trust.<skillId>` 保存 JSON 记录或删除（29,1248–1250,1615–1624,1646–1656）。
- [x] 取消/并发：无取消点；同步读写。
- [x] 时间/ID：`trusted_at` 为 `chrono::Utc::now().to_rfc3339()`；包哈希 = 排序路径后逐文件 `u64le(pathLen)||path||u64le(bytesLen)||bytes` 的 sha256（1637–1645,1252–1259）。

## 命令 `chat_v2_set_workspace_root`

<!-- BEGIN GENERATED:cmd:chat_v2_set_workspace_root -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/runtime_roots.rs:1813` · async
- 前端：app（2 处，例 `src/features/chat/api/taskWorkspaceApi.ts:50`）
- 契约：`contracts/ipc/L05-agent-workspace.json`
  - 参数：path: string, label?: string | null, access?: RuntimeRootAccess__De | null, sessionId?: string | null
  - 结果：RuntimeRoot[] · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_set_workspace_root -->

- [x] 输入：`path` trim 后必填并 canonicalize；`access` 默认 `read_only`，`read_write` 时拒绝 critical 位置；`label` trim 非空优先，否则目录名，再否则 `"Workspace"`（1813–1836,696–706,899–906）。
- [x] 输出：保存后返回 roots 列表（1851）。
- [x] 错误：`Path is required`、`Failed to resolve workspace runtime root: …`、`Critical filesystem locations cannot be configured as a read-write agent workspace`、保存失败原文（899–906,696–706,1838–1849）。
- [x] 事件：不发射事件。
- [x] DB 读写：settings `runtime_roots.workspace` 保存 `{path,label,access,identity}` JSON（1838–1849）。
- [x] 取消/并发：无取消点；同步 read-modify-write，对应 settings mutex（242–247）。
- [x] 时间/ID：identity 为 Unix dev/inode 或 Windows volume/file index；无时间字段（runtime-roots.ts:runtimeRootIdentity）。

## 事件 `workspace_agent_joined`

<!-- BEGIN GENERATED:event:workspace_agent_joined -->
- 事件名 `workspace_agent_joined`，常量 `AGENT_JOINED`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/workspace/emitter.rs:184`（emit）
<!-- END GENERATED:event:workspace_agent_joined -->

- [x] 载荷：`{workspace_id, agent:{session_id, role, status, skill_id|null, joined_at, last_active_at}}`；枚举取小写名，时间为 RFC3339（emitter.rs:51–73,178–189）。
- [x] 触发时机与顺序：`register_agent` 保存 agent 后立即发射（coordinator.rs:321–334）。
- [x] 节流/合并：无节流，每次注册一条事件。
- [x] 是否在事务提交后：`repo.save_agent` 返回成功后发射（coordinator.rs:330–334）。
- [x] 目标窗口：Rust 全局 `emit`；Host 由注入 sink 转发（emitter.rs:178–189）。

## 事件 `workspace_agent_left`

<!-- BEGIN GENERATED:event:workspace_agent_left -->
- 事件名 `workspace_agent_left`，常量 `AGENT_LEFT`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/workspace/emitter.rs:204`（emit）
<!-- END GENERATED:event:workspace_agent_left -->

- [x] 载荷：`{workspace_id, agent:{session_id, role:"", status:"left", skill_id:null, joined_at:"", last_active_at:""}}`；其余字段为固定占位（emitter.rs:191–209）。
- [x] 触发时机与顺序：`unregister_agent` 先清 inbox、删 agent，再发射（coordinator.rs:338–345）。
- [x] 节流/合并：无节流，每次注销一条事件。
- [x] 是否在事务提交后：`repo.delete_agent` 返回成功后发射（coordinator.rs:341–345）。
- [x] 目标窗口：Rust 全局 `emit`；Host 由注入 sink 转发（emitter.rs:191–209）。

## 事件 `workspace_agent_status_changed`

<!-- BEGIN GENERATED:event:workspace_agent_status_changed -->
- 事件名 `workspace_agent_status_changed`，常量 `AGENT_STATUS_CHANGED`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/workspace/emitter.rs:218`（emit）
<!-- END GENERATED:event:workspace_agent_status_changed -->

- [x] 载荷：`{workspace_id, session_id, status}`；`status` 为小写枚举名（emitter.rs:75–80,211–226）。
- [x] 触发时机与顺序：`update_agent_status` 落库后发射；终态（completed/failed/cancelled/closed）随后检查并发射 `coordinator_awakened`（coordinator.rs:349–390）。
- [x] 节流/合并：无节流，每次状态更新一条事件。
- [x] 是否在事务提交后：`repo.update_agent_status` 返回成功后发射（coordinator.rs:353–362）。
- [x] 目标窗口：Rust 全局 `emit`；Host 由注入 sink 转发（emitter.rs:211–226）。

## 事件 `workspace_closed`

<!-- BEGIN GENERATED:event:workspace_closed -->
- 事件名 `workspace_closed`，常量 `WORKSPACE_CLOSED`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/workspace/emitter.rs:246`（emit）
<!-- END GENERATED:event:workspace_closed -->

- [x] 载荷：`{workspace_id}`（emitter.rs:104–107,241–253）。
- [x] 触发时机与顺序：`close_workspace` 更新实例状态、移除实例/DB、更新 workspace_index 后最后发射（coordinator.rs:245–261）。
- [x] 节流/合并：无节流。
- [x] 是否在事务提交后：在状态更新与索引更新成功之后发射（coordinator.rs:247–261）。
- [x] 目标窗口：Rust 全局 `emit`；Host 由注入 sink 转发（emitter.rs:241–253）。

## 事件 `workspace_coordinator_awakened`

<!-- BEGIN GENERATED:event:workspace_coordinator_awakened -->
- 事件名 `workspace_coordinator_awakened`，常量 `COORDINATOR_AWAKENED`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/workspace/emitter.rs:279`（emit）
<!-- END GENERATED:event:workspace_coordinator_awakened -->

- [x] 载荷：`{workspace_id, coordinator_session_id, sleep_id, awakened_by, awaken_message|null, wake_reason}`（emitter.rs:109–118,255–289）。
- [x] 触发时机与顺序：三处——消息匹配唤醒（`send_message` 后）、agent 终态唤醒（`update_agent_status` 后）、handler 主动调用（coordinator.rs:383–390,506–514,774–783）。
- [x] 节流/合并：无节流，每个被唤醒的 sleep 一条事件。
- [x] 是否在事务提交后：`sleep_manager` 返回唤醒结果后发射，晚于状态/消息落库（coordinator.rs:380–390,504–514）。
- [x] 目标窗口：Rust 全局 `emit`；无 app_handle 时仅告警不发射；Host 无 sink 时静默丢弃（emitter.rs:281–288）。

## 事件 `workspace_document_updated`

<!-- BEGIN GENERATED:event:workspace_document_updated -->
- 事件名 `workspace_document_updated`，常量 `DOCUMENT_UPDATED`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/workspace/emitter.rs:234`（emit）
<!-- END GENERATED:event:workspace_document_updated -->

- [x] 载荷：`{workspace_id, document:{id, doc_type, title, version, updated_by, updated_at}}`；`doc_type` 小写、`version` 为 u32、时间为 RFC3339（emitter.rs:82–102,228–239）。
- [x] 触发时机与顺序：`save_document` 落库后立即发射（coordinator.rs:705–711）。
- [x] 节流/合并：无节流，每次保存一条事件。
- [x] 是否在事务提交后：`repo.save_document` 返回成功后发射（coordinator.rs:707–711）。
- [x] 目标窗口：Rust 全局 `emit`；Host 由注入 sink 转发（emitter.rs:228–239）。

## 事件 `workspace_message_received`

<!-- BEGIN GENERATED:event:workspace_message_received -->
- 事件名 `workspace_message_received`，常量 `MESSAGE_RECEIVED`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/workspace/emitter.rs:171`（emit）
<!-- END GENERATED:event:workspace_message_received -->

- [x] 载荷：`{workspace_id, message:{id, sender_session_id, target_session_id|null, message_type, content, status, created_at}}`；枚举取小写 Debug 名，`created_at` 为 RFC3339（emitter.rs:23–50,165–176）。
- [x] 触发时机与顺序：`send_message` 落库并路由成功后发射；随后处理 inbox 溢出警告与睡眠唤醒检查（coordinator.rs:474–515）。
- [x] 节流/合并：无节流，每次发送一条事件（emitter.rs:165–176）。
- [x] 是否在事务提交后：`repo` 写入返回成功后发射，事件晚于 DB 写（coordinator.rs:474–494）。
- [x] 目标窗口（emit / emit_to / emit_filter）：Rust `app_handle.emit` 广播所有窗口；Host 由注入 `WorkspaceEventSink` 转发（emitter.rs:165–176）。

## 事件 `workspace_warning`

<!-- BEGIN GENERATED:event:workspace_warning -->
- 事件名 `workspace_warning`，常量 `WORKSPACE_WARNING`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/workspace/emitter.rs:293`（emit）
<!-- END GENERATED:event:workspace_warning -->

- [x] 载荷：`{workspace_id, code, message, agent_session_id|null, message_id|null, retry_count|null, max_retries|null}`（emitter.rs:120–129,291–299）。
- [x] 触发时机与顺序：inbox 溢出时在 `message_received` 之后发射 `inbox_full_rejected`；也允许 handler 直接构造发射（coordinator.rs:496–499,864–910）。
- [x] 节流/合并：无节流；同一溢出批次合并为一条警告（coordinator.rs:864–903）。
- [x] 是否在事务提交后：消息/路由已完成后发射（coordinator.rs:494–499）。
- [x] 目标窗口：Rust 全局 `emit`；Host 由注入 sink 转发（emitter.rs:291–299）。

## 事件 `workspace_worker_ready`

<!-- BEGIN GENERATED:event:workspace_worker_ready -->
- 事件名 `workspace_worker_ready`，常量 `WORKSPACE_WORKER_READY_EVENT`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/tools/workspace_executor.rs:373`（emit）
<!-- END GENERATED:event:workspace_worker_ready -->

- [x] 载荷：`{workspace_id, agent_session_id, skill_id, runtime_managed:true}`（workspace_executor.rs:361–375）。
- [x] 触发时机与顺序：worker backend 调度成功、拿到 `run.message_id` 后发射；随后返回完整 agent 快照（workspace_executor.rs:352–389）。
- [x] 节流/合并：无节流，每次 worker 启动一条事件。
- [x] 是否在事务提交后：`run_workspace_agent_backend` 成功后发射（workspace_executor.rs:352–375）。
- [x] 目标窗口：Rust `window.emit`（当前窗口）；Host 由注入 sink 转发（workspace_executor.rs:373–375）。

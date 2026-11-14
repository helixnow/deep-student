# L05 原生接口需求（F7 / F4）

依据 `runtime_roots.rs:210–233,585–600,2039–2068`、`tools/shell_sandbox/windows.rs`、
`tools/local_shell_execute_executor.rs` 与 `tools/lsp_navigation_executor.rs`。
F7 的 sandbox/windows 原生 API 已随本轮 main 合入；本 lane 不引入原生模块或新 npm 依赖。
下文候选记录保留为历史证据，当前进展以本节更新为准。

## 当前 main 接入进展（v2 续作）

### ACL / helper 逐分支复核后的具体缺口（2026-11-05）

已向 F7/C1/C2 发送精确请求；以下不是“完全没有原生API”，而是现有API不足以表达Rust语义：

- `windows.rs:1025–1036` 要读取 `SE_DACL_PROTECTED`，`:1150–1185` 撤销时按原值恢复继承。
  当前 `readDacl(path)` 只返回 bytes/null，丢失该位；需要公开原保护状态。
- `:1233–1240` 普通grant/revoke只带DACL_SECURITY_INFORMATION，不改变继承保护。
  当前 `writeDacl(...,protect:false)` 强制UNPROTECTED；需支持保留原状态的写入。
- `:1192–1253` 用SetEntriesInAclW执行GRANT_ACCESS/REVOKE_ACCESS；`:1038–1115`
  用InitializeAcl/AddAccessDeniedAceEx/AddAccessAllowedAceEx/GetAce/EqualSid/AddAce
  剥离sandbox SID旧ACE再写deny/可选read，须保留原生错误/路径上下文。
  L05负责根选择、rights、先保护再grant、只读失败warn及逆序revoke；不在插件引入koffi或猜ACL字节。
- `:1344–1360` create_profile必须接收capabilities（与:1713–1718及runAppContainer同源）。
  现F7 createProfile(name)固定null/0，需增加SID列表参数；display name应按Rust固定文本。
- `:2026–2044` 的helper早期分发在当前host/electron无消费者；现描述符是process.execPath
  加helper flag，而Node/Electron自身不承诺识别该flag。C1/C2需提供正式launcher/dispatch入口；
  stdin/stdout/stderr、env、Job取消/退出须可桥接。F7 Promise<number>且默认继承Host stdio
  不等于现有ChildProcess管道接口。不能仅根据exe文件存在宣告AppContainer已执行。

对应W3原Windows项保持pending；现有readAt/refreshInformation/full-access Job/mutex能力不重复请求。

- 新 R2-W3 root-identity 候选已沿 Context 接入正式 F7 directory identity；Windows
  分支不再把 Node dev/ino 当 volume/index。settings记录、重验、技能信任及审批root token
  共用同一实际 native身份；index与executor工厂负责按次取服务。原Windows测试恢复真正的
  handle信息断言，目标平台未运行，不能把实现接线等同签收。ACL/helper仍未实现。

- C1 指派的 workspace-change-set 独立 reader 已审读并开始接入共享 `RuntimeReadFile`。
  与 preview 不同，原 Rust workspace_change_set.rs:287–305 在 Windows 只是普通
  OpenOptions.read/open（没有 FILE_FLAG_OPEN_REPARSE_POINT）；必须保留此前置lstat/
  文件类型/大小检查及错误上下文，而非复制 preview 的 Windows 打开策略。
  采用原fd→共享reader→共享read_to_end，Linux定向验证与Windows结果分别记录。
  root identity 与 ACL/helper 原生接线不受此子项完成影响。

- 后续 W3 候选把 preview 的同 handle 顺序读取共用到备份/恢复/哈希、workspace read/edit。
  index 的 undo 和 executor 工厂传递当前 F7 Context 服务；64KiB 读块、bigint 偏移、
  refreshInformation 大整数大小和全路径 close 已接线。root identity、workspace-change-set
  自有 reader 与 ACL/helper 仍待处理。目标平台未验证，原五项 pending 不改标。
- C1 已指出 `01c074ecf` 只含 preview 读取实现而缺 `52fb28a22` 的 index 配套 hunk；
  不再以 `a457d0aff` 为祖先宣称整条 preview 已接通，须核对配套提交实际集成。

- R2-W3 新候选先接通 `chat_v2_read_runtime_file`：index 按次取得 F7 Context 服务；
  Windows no-follow 打开与 limit+1 有界短读均用同一 native handle，`readAt` 使用 bigint
  偏移，finally 关闭。真实 Windows provider IPC 测试已写，Linux 按平台跳过，尚未签收。
  当前 root identity、backup/workspace reader、ACL/helper 仍为 L05 剩余实现工作。

- nativeSandbox 已正常集成。L05 transform-sandbox.ts 引用正式 sandbox/api.ts 的 NativeSandbox/SandboxLaunch，
  index 直接从 Context 取服务，不再以本地候选形状断言；原 L24 可空管道返回契约保留。
- 真实 F7 Context provider 的 Linux 验证：`20261104132844-614751`，3 passed / exit 0，
  除已有允许根/保护子树/网络 namespace 检查外，新增实际 env 白名单、130s CPU/4GiB文件/2048进程限额、
  AbortSignal kill/reap 验证。`20261104132844-c05157` typecheck exit 0。macOS/Windows 未目标平台验证。
- nativeWindowsFiles 正式 API 已合入：`readAt(offset:bigint,maxBytes:number)` 在同一 opened handle
  偏移读取，`refreshInformation()` 重新读取该 handle 信息；`read(maxBytes)` 保留 offset0 语义。
  write-backups.ts 的分块流读和 workspace-fs.ts 的偏移读取/句柄复核仍需 L05 接线。
  L05 不重开路径冒充句柄校验，也不把大文件无界缓存替代原流式行为。
- nativeWindowsSandbox 的 AppContainer primitive、`runFullAccessJob` 与
  `acquireAclMutex(signal?)` 均已合入正式 API。ACL 策略、保护子树、可信 shell/helper 仍归 L05，
  不能把 primitive 提供视为这套策略完成。Windows 5 项保持 pending。

## 2026-11-04 F7 候选接口与 L24 接线

只读核对 `ds-mig/F7-native`（相关最近提交 `81f67a962`）：

- `sandbox/api.ts`：`nativeSandbox.probe(backend,program?)` / `spawn(launch)`；成功启动后返回
  pid/stdout/stderr/wait/terminateProcessGroup/cleanupFinishedProcessGroup/cleanupResources。
  env 是完整白名单，signal 在启动前/确认后均检查，原生层负责进程组与 reap。
- `windows/api.ts`：`nativeWindowsFiles.runtimeRootIdentity/openRegularFileNoFollow/ioError`，
  file_index/size 为 bigint，安全打开返回 handle-bound read/close。
- `windows/sandbox-api.ts`：`nativeWindowsSandbox.createProfile/deriveCapabilitySids/readDacl/writeDacl/runAppContainer/systemDirectory`。
- `native/index.ts` 已提供三服务，`NEEDS.md` 记录 Linux 原生隔离测试通过，但 macOS/Windows 未目标平台验证。
  本工作树 main 未含这三个 API 文件；不得 import 不存在的文件或把分支服务记为当前已集成。

L05 新发布 `agentTransformSandbox`（api.ts 的 `AsyncTransformSandboxBackend`），经 Context 按需
获取 nativeSandbox，最小接口 `TransformSandboxNativePort` 镜像 F7 候选的 probe/spawn 消费子集。
policy/backend 构造面同时从 api.ts 导出；构造 bwrap/Seatbelt 参数、protected roots 与
L05 profile 清理，不复制平台 spawn。缺真实服务时 capability 明确不可用，spawn 明确拒绝。

L24 现有 `TransformSandboxBackend` 是同步 capability/spawn，不能无损强制转换为新异步接口。
具体调用方改动需求：在 `runTransformScript` 的解释器/job 创建前 await capability；在已有
`Failed to spawn sandboxed transform script:` setup try/catch 内 await spawn；成功得到真实 child 后
再排 stdout/stderr drain 和执行 timeout；报告 duration 的起点仍应置于 spawn 调用前
（Rust :1149），wait 超时窗口仅在成功取得 child 后开始（:1180）。
AbortSignal 原样传给 native spawn；超时走原来的整组终止。
不能先返回空 pid/延迟 streams，把 startup error 留给 wait，也不能阻塞 Node 等待异步事件。
L24 的契约及生产消费待其 lane 接入，未把其 7 项 sandbox e2e 标为完成。

### F7 最新通知核验（提供方作业，非本 lane 整链结果）

已读取下列 `job.mjs result` 完整输出，三个 runner 均退出 0：

- `20261104072356-504ba1`：`nativeSandbox.probe('linux_bwrap')` 返回
  `{"available":true,"program":"/usr/bin/bwrap"}`，不需要临时 F7_TEST_BWRAP。
- `20261104072032-9b559b`：F7 Node sandbox.test.ts，2 passed / 1 macOS skipped，无 Errors 行。
- `20261104072032-c86741`：F7 Electron 同文件，2 passed / 1 macOS skipped，无 Errors 行。

重新逐签名核对 sandbox/api.ts 与 L05 `TransformSandboxNativePort` 的 probe/spawn 消费子集一致；
现有 `agentTransformSandbox` 已 await spawn、透传完整 env/signal，返回真实进程并转发 group kill/reap/cleanup。
Windows 文件接口实际路径为 `host/platform/native/windows/api.ts`，信息/identity 的 u64 为 bigint；
Windows 沙箱接口为 `windows/sandbox-api.ts`。候选仍未合 main，不通过直接导入实现绕过集成。
这些提供方结果不闭合 L24 消费链，也不签收 Windows 5 项；macOS/Windows 目标平台仍未验证。

Windows 仍需 L05 ACL SID 授予/保护子树与 helper 协议装配；F7 DACL/进程原语不等于这套策略。
候选 `runAppContainer(profile,launch)` 必须带 profile，不能拿它冒充原 Rust full-access 的
unsandboxed Job 分支；该分支仍需与 F7 对齐独立 Job 启动/限额接口。现有 L05 同步
WindowsSandboxRuntime 与 F7 Promise 启动面的桥接也尚未接入，不把 API 名称相近当等价。
文件 API 返回 WindowsRegularFile handle，不是 Node fd：runtime preview/backup 打开读取适配待 F7
正常合入后接 Context，不能用 path lstat 替代 opened-handle 属性检查。5 个 Windows pending 不改标。

## Windows 文件身份与安全打开

- F7：目录/文件身份读取须以 `CreateFileW(access=0, FILE_FLAG_BACKUP_SEMANTICS)` +
  `GetFileInformationByHandle` 返回 `{volume_serial_number:u32, file_index:u64}`。
   `file_index` 必须无损跨 JS 边界；本轮依 D3 将记录/授权摘要中的大 identity 整数保留为
   bigint 并用 raw JSON 数字写回，旧 settings 的 JSON 数字格式不变。
   这只闭合精度问题，不代替 F7 的 Windows handle information 来源。
- F7：只读文件打开须支持 `FILE_FLAG_OPEN_REPARSE_POINT`，并能读取 handle 的
  `attributes`，拒绝 DIRECTORY/REPARSE_POINT；不能以路径 `lstat` 代替 opened-handle
  校验。`workspace_change_set` 的符号链接穿越拒绝同样依赖该能力。
- F4/F7：Windows `io::Error::Display` 需要原始 Win32 错误码和 `FormatMessage` 文案；
  libuv 仅保留 UV 错误，不能还原所有原始 Win32 错误。当前 Unix IO 映射使用 libuv errno。

## Windows shell 沙箱

`tools/shell-sandbox-windows.ts` 只实现纯契约（payload 校验、PowerShell/git-bash
启动命令、argv quoting、Job Object 限额数值、AppContainer 能力报告）；以下原生调用
本 lane 尚未装配，`windowsNativeSandboxAvailable()` 恒为 `false`，执行入口给出缺失原生运行时错误。
F7 候选已覆盖底层原语，以下是 L05 仍需接线的具体策略/协议（非声称 F7 无实现）：

- `CreateAppContainerProfile` / `DeleteAppContainerProfile` 与 capability SID
  （网络能力的唯一授予通道；无 capability 时必须拒绝网络）。
- 对 payload 根与所选 cwd 的 ACL 重写（仅允许 AppContainer SID 写 cwd，保护
  `.git`、`.deep-student` 等受保护子目录）。
- Job Object 创建与 `JOB_OBJECT_LIMIT_*` 设置（CPU、活动进程数、内存），以及
  `AssignProcessToJobObject` / `TerminateJobObject`。
- `CreateProcessW` 启动 helper payload、`PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES`
  传递 AppContainer、启动失败后的 payload 清理。
- 取消与超时后的进程树终止（Job Object 终止语义）；当前 Node 侧仅 `child.kill()`。
- 受信任 PowerShell 路径探测依赖 `GetSystemDirectoryW` / `current_exe` 的原生语义；
  TS 侧按固定候选路径实现，无法覆盖企业重定向。

## macOS / Linux 沙箱

- macOS Seatbelt 使用 `/usr/bin/sandbox-exec` 与私有临时 profile 文件，纯参数/profile
  构建已移植；真实写入/网络拦截测试与 Rust 一样仅按 macOS cfg 执行，无额外 opt-in。
- Linux bwrap 需可执行文件与 namespace 权限；参数构建已移植。队列作业
  `20261104063952-a829d0` 真实启动 ro-bind/unshare-net/unshare-pid probe 返回 status=0，
  stderr 为空、runner 退出 0；这不是 F7 provider 已合入的证明。
- `20261104064839-dc963d`（Node）与 `20261104065253-7be04c`（Electron）均 exit 0，
  真 bwrap 验证允许根写入、保护子树/外部写拒绝、独立 network namespace；macOS/Windows 未运行。

## LSP

- `tools/lsp-navigation.ts` 实现 JSON-RPC/stdio 客户端、初始化与文档同步；
  `rust_analyzer_completes_initialize_handshake_when_installed` 恢复 Rust 的真实握手：
  locate/5 秒 version 探测不可用时早退，否则 20 秒内 initialize 并 kill/reap。
  Linux 当前未安装 rust-analyzer，按 Rust 原测试的可用性分支早退。
- `clientInfo.version` 使用模块常量 `0.11.0` 镜像 `dstu_core::APP_VERSION`；版本升级
  需同步该常量或注入应用版本。
- 子进程关闭沿用 Rust `kill_on_drop(true)` + `Child::kill().await` 的 SIGKILL 语义；
  `LspNavigationExecutor.dispose()` 负责释放缓存会话（组合根需在插件卸载时调用）。

## Rust regex（F7 `nativeRegex`）

- 已接入 Context `nativeRegex` 服务（仅依赖 `native/regex/api.ts`）；`workspace_text_search` 的用户正则编译与匹配
  均使用 Rust regex 引擎，删除 JS `new RegExp` 用户输入路径。搜索入口改为异步，
  原 Rust 测试标题保留，并增加 Unicode 类/命名组/字符列与 lookaround 拒绝验证。
- X4 W08 修复后，index 每次调用重新获取可替换服务，使用公开 `compile` / `captures`；
  缺失时明确报错，未复制原生实现或回退 JS 正则。Host 集成测试覆盖卸载与替换后的既有 executor。
- `symbolPatterns()` 是代码内部固定正则，已把 `\s` 改为
  `\p{White_Space}` + `u` 对齐 Rust 的 Unicode White_Space；不涉及用户输入。

## F4 `host/platform/time` / `util`

- 时间本地函数副本已删除：workspace 时间读取直接组合平台 `parseRfc3339` /
  `toRfc3339`；file-manager 时间和任务对象血缘直接使用 `toRfc3339`。
- 已直接使用 F4 `time/index.ts` 的 `chronoRfc3339`（AutoSi）及 `util/index.ts`
  的 `rustTrim`/`charCount`/`takeChars`/`isRustWhitespace`。
- `ioMessage` 仍从平台 `paths/compat.ts` 引入：该 IO 文案能力尚未迁入 util；
  字符串和时间模块的旧 re-export 已不再使用。

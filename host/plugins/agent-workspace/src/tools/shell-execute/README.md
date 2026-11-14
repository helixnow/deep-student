# 本地 shell 执行环境失败（RF-S01-shell-environment-failure）

`builtin-local_shell_execute` 与经同一执行器运行的 `builtin-git_*` 工具，把**命令没能跑起来**和**命令跑了但失败**分成两种结果。前者是本文说的执行环境失败，后者（非零退出、超时、取消）仍是带 `exit_code` 的结构化结果，文本不变。

实现：`environment-failure.ts`（`ShellEnvironmentFailure`、`sandboxSetupFailure`），抛出点在 `../shell-execute.ts`。

## 错误文本契约

```
LOCAL_SHELL_ENVIRONMENT_FAILURE (stage=<阶段>[, code=<errno>]): <原错误文本>
This is a failure of the local shell execution environment, not of the command. <结果> <建议>
```

- 前缀 `LOCAL_SHELL_ENVIRONMENT_FAILURE` 固定，供模型和日志识别（导出为 `SHELL_ENVIRONMENT_FAILURE_PREFIX`）。
- 冒号后是原错误文本，一字不改；带 errno 号的 IO 错误按 Rust `io::Error` 的写法给出 `<strerror> (os error N)`。
- `code` 只在底层错误带 `E…` 形式的 errno code 时出现；`ERR_*` 这类 Node 内部 code 不算。
- 结果：`process_io` 写“进程已被终止、没有退出码和输出”，其余阶段写“命令没有运行、没有退出码和输出、没有改动任何东西”。
- 建议：`EAGAIN`、`EMFILE`、`ENFILE`、`ENOMEM`、`EBUSY`、`ETXTBSY` 属于会自行恢复的资源耗尽，提示等待后最多重试一次，再失败就告诉用户；其余一律提示“原样重试会同样失败，不要原样重试，告诉用户本地 shell 环境不可用并引用上面的原因”。

| 阶段 | 触发点 | 典型原因 |
| --- | --- | --- |
| `resource_limits` | `resourceLimiter()` | `nativeSandbox` 服务缺失，拿不到 RLIMIT CPU/FSIZE/NPROC 启动器 |
| `sandbox_setup` | `sandboxBackend.command` / `commandForGit` | Seatbelt profile 写不进 TMPDIR、找不到 bwrap、Windows 缺 F7 原生 helper（受限档与 Full Access 档都拒绝） |
| `spawn` | 启动器或 `/bin/sh` 的 spawn | `EAGAIN`（进程数耗尽）、`ENOENT`、`EACCES` |
| `process_io` | spawn 之后 | 进程没有 pid，或 stdout/stderr 管道拿不到；进程会被终止 |

## 消费方

失败结果 `success: false`、`output: null`，错误文本原样进入：

- 模型：chat 执行器把 `ToolResultInfo.error` 作为 `Error: …` 交给模型（`host/plugins/chat/src/execution-context.ts`）；
- 工具卡片：`chat_v2_event_{sessionId}` 上的 `tool_call` error 事件，以及 `chat_v2_blocks` 中 `status = 'error'` 的块；前端 `src/features/chat/plugins/blocks/mcpTool.tsx` 的 `ToolError` 直接显示该文本；
- `git_*`：`GitToolFailure.plain` 原样包装，`git_commit` 第二步加前缀 `git add succeeded but git commit could not start: `。

## 语言与前端

错误文本面向模型，固定英文，与其它工具错误和 Rust 一致，不做 zh-CN/en-US 本地化。工具卡片上给用户的本地化提示（按前缀识别、显示“执行环境故障，命令未运行”）属于前端 `mcpTool.tsx`，不在本插件范围，已作为交接提出，尚未实现；未实现时卡片显示原英文文本。

## 移动端

不提供。`agent-workspace` 插件没有声明 `meta.platforms`（默认仅桌面），也不在 `host/profiles/mobile.json` 中，移动端不注册本地 shell 与 `git_*` 工具，模型看不到这些工具，因此不会出现这类错误。

## 回退与边界

- 只在上表四个准备阶段失败时生效；命令正常执行（含非零退出、超时、取消）时结果与改动前完全一致。
- 已知未分类：启动器已经起来之后才发生的失败（bwrap 建命名空间失败、`prlimit` 或 macOS `ulimit` 包装失败、`sandbox-exec` 应用 profile 失败）目前表现为命令的非零退出，而不是执行环境失败。区分它们需要原生启动器回报准备阶段状态：已交接给 `nativeSandbox`（W01）的方案是给子进程加 fd 3 就绪管道（`stdio: ['ignore','pipe','pipe','pipe']`），`SandboxedProcess` 增加 `ready: Promise<boolean>`，沙箱内脚本开头写 `printf R >&3; exec 3>&-;`；fd 3 没收到字节就关闭，说明 `prlimit`/`ulimit`/bwrap/`sandbox-exec` 中有一个失败，报 `sandbox_setup`。不用 bwrap 的 `--info-fd`/`--json-status-fd`：它们在命名空间设置完成之前就写出 child-pid，证明不了准备成功。W01 落地前保持现状。

## 测试

- `tests/shell-environment-failure.test.ts`：四个阶段、errno 与建议的区分、无 errno code 时保留原文、命令自身非零退出与超时不受影响、Windows 缺 helper 与 Linux 缺 bwrap 的完整文本。
- `tests/local-shell-git-contribution.test.ts`：经真实 profile 注册的贡献端到端，覆盖工具结果、`tool_call` error 事件、`chat_v2_blocks.error`、Seatbelt profile 清理和 `git_*` 通道。
- `tests/shell-resource-limits.test.ts`：缺 `nativeSandbox` 时拒绝执行（`resource_limits`）。

# 沙箱写保护：Host 插件目录（RF-S01-shell-host-plugin-dir-protected）

Host 启动时以完整 Node 权限导入 `<数据目录>/plugins` 里的 `user.profile.json` 和插件模块。读写工作区可以包含数据目录（例如 `~/Library/Application Support`），所以沙箱 shell 必须挡住对这个目录的写入，也要挡住改名或替换通往它的目录。实现是 `context.ts` 的 `protectHostPluginDir`，在 `buildSandboxPolicy` 确定可写根（即解析后的 cwd）之后调用。

| 可写根与插件目录路径的关系 | 行为 |
| --- | --- |
| 没有可写根（只读根、`forceReadOnly` 的 git 读工具） | 直接返回，不读数据目录 |
| 不相交（包括数据目录里 `plugins` 之外的临时根，如 artifacts、temp） | 策略与 Rust 相同 |
| 等于或包含真实数据目录（如 cwd 是包含数据目录的工作区根） | 在任何后端运行之前拒绝，错误文本为 `HOST_PLUGIN_DIR_CWD_REFUSAL` |
| 等于或包含 `plugins` 的真实目标（`plugins` 是指向别处的链接时） | 同上 |
| 等于或包含 `pathHolders(<数据目录>/plugins)` 里的任一目录：路径每一段所在的真实目录，链接逐跳展开（数据目录或 `plugins` 的路径上有符号链接、junction 时，包含任一链接所在目录就能替换它） | 同上 |
| 就是 `plugins` 或在其中（如 `cwd: app-data/plugins/<id>`） | 同上 |

- 数据目录和 `plugins` 都取 realpath（`plugins` 不存在时用拼出的路径），所以符号链接比较的都是真实目标。`pathHolders`（`snapshots.ts`，导出给 W02 的工作区设置检查复用；放在这里是因为它已登记 `fs`、`path` 的可移植性基线，又只值引入 `runtime-paths.ts`，`runtime-roots.ts` 引入它不会成环）按配置写法逐段 `lstat`，遇到链接就按 `readlink` 的结果从链接所在目录继续逐段展开，合计最多 40 跳（POSIX `SYMLOOP_MAX`），超过报 `ELOOP`；遇到不存在的条目就停，它所在的目录仍计入（悬空链接的目标由可写根新建同样能改道）。只沿配置路径解析时，两跳链接 `outer/link1 → ws/link → real` 里持有中间链接的 `ws` 会漏掉（A15 复核 `S01-c7d3c08e` 第 1.6 节）。规范化失败（`plugins` 的 `ENOENT` 以外，含 `ELOOP`）时报错、不执行。
- 覆盖范围只到 `<数据目录>/plugins` 这一级。`plugins` 里面用户自建的链接（把开发中的插件目录或 `user.profile.json` 链到工作区）不在覆盖范围，这需要用户自己建链接。路径同一性除了 realpath 字符串还按 `(dev, ino)` 比较（`withinByIdentity`，inode 为 0 时只按路径），所以 macOS `/System/Volumes/Data` 的 firmlink、bind mount、casefold 目录这类 realpath 保留不同写法的别名也会被拒。
- 为什么包含数据目录也要拒绝：第 4 轮曾把 `plugins` 列为受保护写根、命令照常执行，但它和可写根之间的数据目录本身不受保护。沙箱命令可以 `mv app-data app-data.old`，再在原路径上建符号链接（macOS，Seatbelt 按路径匹配）或新建目录（Linux，被挂载的只是 `plugins`），Host 下次启动顺着原路径读到种下的 profile（A07 复核 `S01-71ace0de` 第 1.2 节）。要保护整条路径就得把数据目录和所有可写的祖先都设为只读，那就等于拒绝。
- 拒绝而不是只读执行的其它好处：结果不依赖后端挂载语义，各平台一致；模型拿到明确原因，不会对着 `Operation not permitted` / `Read-only file system` 反复改写命令重试。代价是在包含数据目录的工作区里，cwd 要用不包含数据目录的子目录。Full Access 档不经过这里。
- 其它受保护写根（各根下的 `.git`、技能目录、home 凭据路径）是无条件加入的，不做方向判断；cwd 位于其中时靠后端规则顺序盖住可写根：Seatbelt 的 `deny` 排在 `allow` 之后；bwrap 后来的父目录 `--ro-bind` 叠在先前子目录的 `--bind` 之上，挂载源取自 `/oldroot`、递归绑定，`mount_setattr` 作用在重新打开的目标上，所以子目录也是只读（已对照 bubblewrap 上游 `bubblewrap.c`、`bind-mount.c` 确认）。`.git/hooks` 作为 cwd 的用例验证了这一点。
- 文件工具（`workspace_fs` 的写、编辑、移动、删除）不经过这里，不受这条保护，见 `.reports/reviews/S01-security-r3.md` L1。

测试在 `tests/shell-host-plugin-dir.test.ts`。策略层用例直接调用 `protectHostPluginDir`，不依赖工作区设置和沙箱，所有平台都跑：plugins 之内、包含数据目录、plugins 链接及其目标的祖先、数据目录路径上的链接、两跳链接的中间持有目录、plugins 链接目标路径上的链接、悬空的 plugins 链接、不相交和临时根、没有可写根；`buildSandboxPolicy` 的接线用例直接构造读写的 workspace 根调用它，不经过 `workspaceRoot`，所以 Host 怎么降级已保存的记录都不影响它；另有 `pathHolders` 的单元用例（相对链接里的 `..`、缺失条目、环路 `ELOOP`，Windows 上跳过，相对符号链接要特权）。依赖工作区设置的 e2e 用例：cwd 在 `plugins` 内（两种 cwd）、工作区根作为 cwd 时整条命令被拒、工作区持有数据目录路径上的链接（一跳、两跳）时改名或替换链接被拒，这些不需要沙箱；改名数据目录种 profile、cwd 在 `.git/hooks` 时不能写入钩子、与数据目录不相交时 cwd 是子目录照常执行，这三条需要 POSIX 沙箱。“包含数据目录”和“持有链接”两组按 Host 实际给出的 access 期望精确的拒绝文本：记录保持读写时是策略层拒绝，Host（W02 RF-W02-workspace-contains-data-dir）把它降为只读时是只读根拒绝。

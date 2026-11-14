# S01 进度（执行器安全）

路径归属见 `WAVE2-BRIEF.md` §6 的 S01 行。审查报告在 `.reports/reviews/S01-security-r{2,3}.md`。

## 第 9 轮（2026-11-07 16:19 起，F 趟：A15 §1.6/§2/§3/§4 跟进、A16 复核 `S01-76965bac`、A07 §1.1 的 (dev, ino)）

| 项 | 状态 | 提交 |
| --- | --- | --- |
| INT 仍是 `1d1fdb78`，已在分支内，无需合并 | — | |
| A15 §1.6：`pathHolders` 逐跳收集 `<dataDir>/plugins` 解析经过的每个条目所在的真实目录（链接沿 readlink 展开，40 跳上限报 ELOOP，缺失条目的所在目录也计入），`protectHostPluginDir` 拒绝包含其中任一目录的可写根。修复前红：两跳链接的中间持有目录、plugins 链接目标路径上的链接、悬空 plugins 链接都放行；端到端两跳拓扑 `[true, true]`（链接被替换、profile 被种下） | 完成 | `4de1f17d`、`4a360176`（挪进 `snapshots.ts`，可移植性基线 0 新增） |
| A15 §2：端到端“工作区持有数据目录路径上的链接”（一跳、两跳；先写脚本再 `sh` 执行，绕过只看命令行的操作数校验）与“不相交时 cwd 是子目录照常执行”。无 W02 三组都是 read_write；套上 W02 `a89513a1` 后一跳和包含数据目录是 read_only、两跳仍是 read_write（S01 策略层拒绝），两种状态都全绿 | 完成 | `8b439bcf` |
| A15 §3/§4 RF 文本：plugin-dir RF 的 behavior/title/userVisible/evidence/tests；windows RF 第 (3) 条“三档都不可用、Windows 发布必须带 helper”。“~/Library 等可设为读写工作区”那句等 W02 进 INT 再改 | 完成 | `7c0ff484` |
| 交接 W02：`workspaceOverlapsDataDir` 改用 `pathHolders`（`.reports/S01-handoffs/W02-path-holders.md`，补丁已在本机套 W02 末端验证） | 完成 | |
| A16 复核：必须修无。§4 接线测试（直接调 `buildSandboxPolicy`，删掉调用即红）；§4/§5 RF 文本 | 完成 | `54b0cdc9`、`f2d8fc38` |
| A07 §1.1：路径同一性同时按 `(dev, ino)` 比较。修复前红（macOS `/System/Volumes/Data` firmlink 别名）：`[null, null, null]` | 完成 | `2565c07d`、`f46ffa0a` |
| A07：技能基础目录与 home 凭据路径的“改名祖先”；审批预判提示拒绝 | 未做，见交付报告 | |

## 第 8 轮（2026-11-07 15:50 起，E 趟小修复：与 W02 `be279661` 同趟的测试兼容、LA-12、A15 复核）

| 项 | 状态 | 提交 |
| --- | --- | --- |
| 合 INT `1d1fdb78`，无冲突；`test_local_shell_execute_registered_before_general_executor` 等本线用例都在 | 完成 | `171f23dc` |
| `shell-host-plugin-dir.test.ts`：通用端到端（`.git/hooks`）的数据目录改成工作区的兄弟目录；“工作区包含数据目录”的三条预置一条旧版本持久化的读写记录，按生效的 access 期望精确拒绝文本（无 W02 是读写，策略层拒绝；有 W02 降为只读，只读根拒绝），数据目录、profile、插件文件的断言不变。无 W02、临时套上 W02（8e6c23d7、f8edd486）两种状态都 6 通过 | 完成 | `774c0682` |
| LA-12：语料里没有执行 `local_shell_execute` / `git_*` 的场景，`*local_shell*` 匹配不到、`*git_*` 只匹配 `automation.create.daily_time_single_digit_hour`；RF-S01-shell-environment-failure 改为 `g3.affects=false`，evidence 写明原因（approved 条目内容变化，请主编排确认） | 完成 | `17311df8` |
| A15 复核 `S01-c7d3c08e`：必须修无；第 1.6 节多跳链接、第 2 节链接拓扑端到端与“cwd 是子目录时照常执行”、第 3/4 节 RF 文本补充 | 下一轮，见交付报告 | |

## 第 7 轮（2026-11-07 起，A07 复核 `S01-71ace0de` 的必须修与交付后跟进）

| 项 | 状态 | 提交 |
| --- | --- | --- |
| INT 仍是 `2be7ed80`，已在分支内，无需合并 | — | |
| I2：Windows Full Access 保留 helper 的 Job Object 后端（`unsandboxed_job`，Rust `direct_host_unrestricted`），登记 RF-S01-windows-unrestricted-job-backend（proposed），行为不变，补断言 backend 值的测试 | 完成 | `faec2790` |
| A07-1：可写根等于或包含数据目录、包含 plugins 的真实目标、或包含数据目录路径上的任一目录（含符号链接的词法祖先）时一律拒绝，删掉“列为受保护写根”分支（方案 B）；可写根为空时提前返回。修复前红：macOS 上改名 `app-data` 再 `ln -s evil app-data` 种下 `user.profile.json`（`[true, true]`） | 完成 | `e5523481` |
| A07 附注：“cwd 在 plugins 里”的 e2e 用例移出 `skipIf`；RF 的 title/behavior/evidence/userVisible/tests 与 README 表格随修法改 | 完成 | `e5523481` |
| bwrap 父目录 `--ro-bind` 是否盖住先前子目录 `--bind`：对照上游源码确认会盖住（与 A07 第 5 节一致），不改代码 | 结论 | |
| Full Access 的 spawn 报错保留 errno 号，按 Rust 写作 `<strerror> (os error N)`；EAGAIN 注入改用 `os.constants.errno.EAGAIN` | 完成 | `70447f31` |
| README 的准备阶段回报方案统一为交接给 W01 的 fd 3 就绪管道 | 完成 | `70447f31` |
| 测试按 argv 找子进程时改用随机 `sleep` 参数，不再用 pid 加偏移 | 完成 | `669ba6fe` |
| `web_fetch` 的 DeepSeek 前置检查吞掉非 `HttpError`，URL 未经检查就交给 DeepSeek；改为照 Rust 终止调用 | 完成 | `4dd25829` |
| A07 交付后跟进：按 `(dev, ino)` 比较、技能目录与 home 凭据的“改名祖先”（Rust 相同）、审批预判提示拒绝 | 未做，见交付报告 | |

## 第 6 轮（2026-11-07 15:05 起，A04 复核 `S01-9f646f54` 的必须修）

| 项 | 状态 | 提交 |
| --- | --- | --- |
| 开工合并 INT `2be7ed80`（无冲突） | 完成 | `a86ef625` |
| RF-S01-shell-host-plugin-dir-protected 漏了“可写根在 plugins 里面”：cwd 在 `<dataDir>/plugins` 内（含就是 plugins）时策略阶段拒绝执行；plugins 已存在时取 realpath。修复前红：`cwd: app-data/plugins/community.demo` 改写了 `index.mjs` | 完成 | `622520b2`、`05c73926` |
| 同类自查：其它受保护写根（`.git`、技能目录、home 凭据）无条件加入、无方向判断；补 `.git/hooks` 作为 cwd 时不能写入的用例 | 完成 | `622520b2` |
| RF 登记（行为、证据、3 条测试）与 README 一节 | 完成 | `61438552` |
| r3 L1：`workspace_fs` 写、编辑、移动、删除仍能写 `<dataDir>/plugins`（静态确认） | 交接 W02 | |
| Linux 上 `.git/hooks` 用例（bwrap 父目录 `--ro-bind` 遮住子目录 `--bind`） | 本机无法验证，待服务器 | |

## 第 5 轮（2026-11-07 起）

| 项 | 状态 | 提交 |
| --- | --- | --- |
| 开工合并 INT `390f244b`（无冲突） | 完成 | `22cd888b` |
| Linux 门禁自查：沙箱子进程按 argv 查找（bwrap `--unshare-pid` 下 `$!` 是命名空间 PID，原回收断言恒真）、僵尸算已退出、沙箱可用性改为真实探测并打印跳过原因、`git init` 不用 `-b`（git < 2.28） | 完成 | `e14aed1c` |
| D3 完备性：经注册贡献的端到端（工具结果、`tool_call` error 事件、`chat_v2_blocks.error`、Seatbelt profile 清理、`git_*` 通道）；无 errno code 时保留原文 | 完成 | `103c7352` |
| Windows/Linux fail-closed 文案（缺 F7 helper 两档拒绝、缺 bwrap）作为模型看到的完整文本测试 | 完成 | `4142d194` |
| D3 README（`src/tools/shell-execute/README.md`） | 完成 | `ebc5e7ee` |
| D3 启动器起来之后的准备失败（bwrap 命名空间、prlimit/ulimit、sandbox-exec 应用 profile）分类 | 仅设计：需 `nativeSandbox` 回报准备阶段状态（W01） | |
| D3 前端本地化提示（`mcpTool.tsx`，zh-CN/en-US） | 仅设计：前端归 W09 | |

## 第 4 轮（2026-11-07 14:00 起）

| 项 | 状态 | 提交 |
| --- | --- | --- |
| 开工合并 INT `fe5feb68`（两处测试冲突取 INT 的 `NPROC_PROBE`） | 完成 | `2a28b798` |
| W14 交接：`web_fetch` 的 DeepSeek 前置检查改为 `ctx.http.checkPublicPinned`（不再依赖“已中止 signal 的请求先解析后看 abort”） | 完成 | `d959b5c6` |
| 第三轮安全审查（`S01-security-r3.md`）：中 3（M3 已修）、低 2、信息 2，无高 | 完成 | 报告不在仓库内 |
| r3 M3：工作区包含 Host 数据目录时，沙箱 shell 保护 `<dataDir>/plugins`（RF-S01-shell-host-plugin-dir-protected） | 完成 | `77d00cbb` |
| W02 交接：`shell-sandbox.ts` 的 io 失败（`capability()`、Seatbelt profile、策略路径规范化）改用 Rust `io::Error` 文本 | 完成 | `752131fa` |
| W02 交接：Windows unrestricted 用 `DirectHostShellBackend` | 未做：需要进程内 Job Object + 挂起创建（原生能力），本机无法验证 Windows；安全上等价，交主代理（r3 I2） | |
| W28：可选的 NPROC 前置检查 | 未做：W28 写明由主代理决定 | |
| V09 P2-2（S01 部分） | 第 3 轮已完成（RF-S01-shell-orphaned-on-unload） | |
| V10 P2-5（`ulimit -u` 在 dash 下非法） | 已被 INT `4ec53a7b` 的 `NPROC_PROBE` 取代，本分支两处测试都用它 | |

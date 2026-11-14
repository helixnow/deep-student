# W02 进度（Agent 核心）

分支 `assault/W02-agent-core`。本文件记录本轮的调查结论、证据和未完成项；交接以文件 + 行号给出。

## D6（WAVE2-BRIEF §8）：重启、会话分支、审批无人应答

逐项对照 Rust `src-tauri` 与 TS 实现。

| 场景 | Rust | TS | 结论 |
|---|---|---|---|
| 工具审批超时 | `approval_manager.rs:171` 默认 300 秒；超时按拒绝处理，`hooks.rs:846-850` 阻断工具 | `agent-workspace/src/approval-manager.ts:150` 同为 300 秒；`chat-pipeline/src/approval-gate.ts:217,259,343-347` 超时即阻断 | 一致 |
| 计划闸门超时 | `hooks.rs:644` | `approval-gate.ts` 同一路径 | 一致 |
| 目标续跑遇到审批超时 | `goal/runtime.rs:128-395`：回合 Ok 续跑，Cancelled 暂停，Err 阻塞；最多 20 次续跑并受 token 预算约束 | `chat/src/goal-runtime.ts` 同一状态机；`chat/src/send-message.ts:200-221` 发送与唤醒都接了目标钩子 | 一致；未获批准的工具不会被执行 |
| 自动化 headless 运行 | `headless.rs:77-110,351-408` 运行期间安装 trusted 配置，结束后撤销 | `agent-orchestration/index.ts:97-117,326-333` 没有 headless runner（B2），`headless.ts:104-129` 的 `installTrustedAutomationSession` 没有生产调用方 | TS 关闭失败（fail-closed）：自动化运行时遇到审批会等待/超时而不是自动放行；B2 落地时必须安装并撤销 trusted guard |
| 重启：目标 | 不自动恢复（`goal_handlers.rs:150-168` 需要用户触发） | 同 | 一致 |
| 重启：待决审批、trusted 配置 | 均在内存，重启后丢失 | 同 | 一致 |
| 重启：过期自动化运行与补跑 | `automations.rs:5179-5293` `recover_stale_automation_runs`；补跑批量 5、默认重试 2（`:44-48`） | `agent-orchestration/repository/automation-runs.ts:470-505`、`automation-runtime.ts:28-31`；`automation-request.ts:54` 缺省 `run_once` | 一致 |
| 会话分支 | `manage_session.rs:1578-1686` 复制会话 metadata（authority/plan 绑定），不复制目标 | `chat/src/session-branch.ts:159-185` 同 | 一致。已记住的审批、trusted 配置都不会被分支继承。残留：计划绑定在 metadata 里，源会话消费之前，分支理论上可再用一次；两边相同，记录不改 |
| `goal_resume` | 恢复后调用 `spawn_goal_continuation_if_idle` | `chat/src/register.ts:353-359` 只改状态，不续跑（注释已过时） | 不一致，chat 归 W10，见交接 |
| super inbox 投递回合结束 | `inbox.rs:940-973` 与普通发送同一套目标收尾 | 原先不收尾 | 已修：`0d1d72cd`（`agent-orchestration/src/super-inbox-drain.ts`）。`SendMessagePipeline` 新增 `spawnGoalContinuation` / `settleActiveGoal`，chat 发布 `chat.send@1` 时需实现 |

D6 的修正都是向 Rust 对齐，不涉及 Rust bug，没有新 RF。

## #32 `record_injection_presence`

`cc51bee4` 改为从 `listCategorySummariesWithMembers()` 取成员 id（prompt.rs:290-400），按小时节流。先红后绿复核（本轮）：

- 把 `chat-pipeline/src/execution-capabilities.ts`、`execution-runtime.ts` 还原到 `cc51bee4^`：`execution-capabilities.test.ts` + `execution-runtime-production.test.ts` 共 8/32 失败，其中生产测试 `injected category members get the memory owner _last_injected tag` 失败。
- 恢复 HEAD：32/32 通过。

## chat 的可移植入口（W10 交接）

新增 `agent-workspace/portable.ts`、`agent-orchestration/portable.ts`、`agent-skills/portable.ts`，各有 `tests/portability.test.ts`：闭包不触达 Node，且每个导出与 `api.ts` 同一对象。

`node scripts/portability/scan.mjs --mobile-readiness`（同一 INT 基线）：

| | 网关合计 | chat 网关 | chat 经 agent-skills/api.ts | 经 agent-orchestration/api.ts | 经 agent-workspace/api.ts |
|---|---|---|---|---|---|
| 改动前 | 151 | 13 | 108 个 Node 文件 | 108 | 108 |
| 本分支（chat 未切换） | 151 | 13 | 108 | 108 | 108 |
| 模拟 chat 切到 portable.ts | 150 | 12 | 消失 | 78 | 73 |

本分支另外把 agent-orchestration、agent-skills、agent-workspace 的 own Node 文件各减 1（15→14、30→29、39→38）。

chat 切换后仍留下的值导入都依赖文件系统或存储，不是可移植逻辑：

- `agent-workspace/api.ts`：`tempRoot`、`artifactRoot`、`cleanupSessionRuntimeRoots`、`normalizeRuntimeRelativePath`（`runtime-paths.ts`）、`listCustomAgentFiles`。
- `agent-orchestration/api.ts`：`loadPersistedTodoListWithConn`、`restoreTodoListFromDbWithConn`（等 W14 的可移植 `defineQuery`）；`atomicWrite`、`resolvePersonaPath`、`validatePersonaContent`、`withCustomAgentFileLock`（`custom-agent.ts`，与 `atomicWrite` 同文件，单拆纯函数不减网关）。

## 审计台账（2026-11-07，INT `390f244b`）

| 项 | 提交 | 红 → 绿 |
|---|---|---|
| V04-02 Host 驻留入口 `agentAutomation.backgroundResidency()`（`meta.remote`），退出时由 Host 自己标记 | `37847c93` | `tests/background-residency.test.ts` 9/9 红（`service.backgroundResidency is not a function`；`plugin:host|call` 被拒）→ 9/9 绿 |
| V09-P1-5 卸载/退出取消在途自动化 run，调度状态改为每实例（`AutomationSchedulerState`），订阅 `host/exiting` | `6f7c442e` | `tests/automation-lifecycle.test.ts` 3/3 红 → 绿 |
| V09-P1-3 重装后 F3 拒绝重复名/晚注册时改为等 startup gate 执行 | `6f7c442e` | `tests/automation-commands.test.ts` 三条 V09 用例红 → 绿；两条原本断言该缺陷的用例已改名并订正 |
| V01-02 `chat.send@1` 由 chat-pipeline 发布，Super 收件箱可投递 | `7458fca8` | `tests/super-inbox-delivery-profile.test.ts` 2/2 红（`expected undefined to be defined`；`Command not found`）→ 绿 |
| V10-P1-2 `syncDirectory` 在 win32 直接返回 | `c9b6263f` | `agent-skills/tests/skill-package-win32-fsync.test.ts` 2/3 红（`Failed to fsync staged directory … EPERM`）→ 3/3 绿 |

交接文件（根仓库未跟踪）：`.reports/W02-handoffs/background-residency-host.md`（W06）、`.reports/W02-handoffs/chat-send-provider-W10.md`（W10）。

## 中低危与交接（INT `2be7ed80`）

| 项 | 提交 | 证据 |
|---|---|---|
| V09 P2-6：卸载时关闭 workspace 数据库句柄 | `e4ec95a7` | `agent-workspace/tests/coordinator-unload.test.ts` 红（去掉 dispose effect：`expected 2 to be +0`）→ 1/1 绿 |
| S01 r3 L1/L2：读写工作区不得包含、位于或等于 app data dir（RF-W02-workspace-contains-data-dir，deliberate/proposed） | `8e6c23d7`、`f8edd486` | `agent-workspace/tests/workspace-root-data-dir.test.ts` 红（设置被接受、`access: 'read_write'`）→ 3/3 绿；两份旧测试只把读写工作区夹具挪出 dataDir |
| V01-03：mistakes.db 维护期间不读 main_db 的工具照常执行 | `f8f45c88` | `chat-pipeline/tests/tool-binding-maintenance.test.ts` 红（`StorageError … tool-executor-binding.ts:20:42`）→ 2/2 绿 |
| V04-09 webhook 连接器暂不移植（RF-W02-webhook-connector-unported，deliberate/proposed） | `5220ba4f` | `connector-chat-executor.test.ts` 5/5 |
| 合并两份 `extractCitedMemoryNoteIds`（u64 解析与 persistence.rs:265 一致） | `dcf86018` | `persistence.test.ts` 红（`expected [] to deeply equal ['exact']`）→ 39/39 |
| 技能下载改用调用方的 `ctx.http`（public-pinned），删除桌面默认传输；无 `ctx.http` 报 UNSUPPORTED_ON_PLATFORM | `e7f3a14a` | agent-skills 目录 53 文件 625 通过 1 跳过 |
| V08-06：注册表统一 `toAgentJson`（RF-W02-agent-json-bigint，deliberate/proposed） | `024953f4` | `chat-pipeline/tests/tool-result-agent-json.test.ts` 红（`Do not know how to serialize a BigInt`）→ 2/2 绿 |
| S01 交接：SuperSessionExecutor 显式映射敏感度，未知值按 high | `0f5f8fc4` | `subagent-executor.test.ts` 4/4 |
| W22 交接：发布 `agentCardReadScope` | `aaf0874b` | `workspace-card-read-scope.test.ts` 5/5（新用例在改动前 `host.ctx.agentCardReadScope` 为 undefined） |
| V09 P3-2：卸载时结束 zip 池的空闲 worker | `0836d441` | `zip-pool.test.ts` 3/3 |

不改的项与理由：

- V10 P3-7（代码搜索按名字排序）：TS 与 Rust 都用 readdir 原序，同一文件系统上两边结果相同；排序后在 ext4 上反而与 Rust 不同，需要 deliberate RF，收益只是测试稳定。留给主代理决定。
- V10 P3-1 / P3-2（Windows 上 LSP 只杀直接子进程、`cmd /D /S /C` 引号）：与 Rust 写法相同，本机无法验证 Windows。
- S01 #8 子代理数量上限：与 Rust 相同，加上限属于产品决策。
- W07 `ioMessageFor`：W02 的调用点（`agent-workspace/src/runtime-paths.ts`、`workspace-change-set.ts`，`agent-skills/src/files.ts` 自带一份）都在直接用 `node:fs` 的桌面文件里，换掉 `ioMessage` 不会减少网关。
- V08-06 后各执行器自己的 bigint 转换保留：connector 的 `i64ToIpcNumber` 还服务 IPC 返回；workshop 用 rawJSON 原子保精度；automation-executor:271 是比较，不是输出转换；todo 的 `timestamp` 决定输出类型。

## 本轮其它已完成

- web_fetch 重定向上限 9（`7915198e`）。
- `local_shell_preflight` 复用后端 `capability()`（`d117bdcd`）。
- `skill_scan` 指向本机的 URL 提为 High（`8942e065`，RF-W02-skill-scan-loopback-approval，proposed）。
- 边界违规清零（`5fb29109`）。
- shell 策略受信目录判断按 Unix `Path::parent`（`54554e7c`）：`/usr/bin//grep`、`/usr/bin/./grep` 与 Rust 同为 allow，`/usr//bin/grep` 仍为 ask。

## 未完成

- **W22 建议的 `bigint` 容错**（`host/kernel/agent-api.ts:156`、`history.ts:63`）：不在这几处单独容错；改为 V08-06 在注册表出口统一转换一次（`024953f4`），预算、history、持久化拿到的都是转换后的 output。
- **`agent-orchestration/src/session-tool-executor.ts:15`** 改导入 `vfs/portable.ts`：等 W09 让 `isPublishedApi` 接受 `portable.ts`（INT 上 `boundary-rules.mjs:48-50` 仍只认 `api.ts`）。
- ~~**`skill-market.ts:72`** 仍用全局 `fetch`~~：已改走 `ctx.http`（`95fb5469`）。
- ~~**`agent-skills/index.ts:302`** 给 `runtimeRootById` 的依赖里没有 `windowsFiles`~~：已补（`6513e39e`，A22-M1）。skill_scan / skill_install 的 `source.root_id` 只收 temp 和 artifacts（`skill-install-executor.ts:119-121`，Rust `skill_install_executor.rs:170`），这两种根不查 native identity，所以这一项在现有工具里走不到，补上是为了与其它调用点一致。

## E 趟后一轮（A11 复核 `W02-be279661`，INT `1d1fdb78`）

- A11-M1：`7714217e`（background-residency 两次 host 调用带 caller，夹具走 require）。
- F-02 符号链接缺口：`7ed29e7d`（数据目录路径上的每一级按 realpath(父目录)+basename 再判一次）；A11 跟进 5 的纯函数大小写测试：`e5e0a03d`。
- W07 交接（rename 重试）：`b6e48d5a`；S01 交接（SPEC 小节）：`ab4435fa`、`44bb991f`。
- 跟进：skill market 走 `ctx.http`（`95fb5469`）；`WorkspaceDatabaseManager.remove` 关句柄（`cf0bd9d2`）；卸载时停 sleep 超时计时器、行保持 `sleeping`（`788814a8`）。

## F 趟轮（A22 复核 `W02-a89513a1`，INT `1d1fdb78`）

- A22-M1：`6513e39e`，`skill-install-runtime-root-wiring.test.ts` 改前 `windowsFiles` 为 undefined，改后 1/1。
- A22-M2 / F-02：与 S01 `76965bac` 临时组合实跑（未提交），`shell-host-plugin-dir.test.ts` 6 passed、0 skipped，`workspace-root-data-dir.test.ts` 6/6（macOS）。数据目录被包含的三条走降级后的只读拒绝分支。S01 不需要再改，交接已结清。Linux 上要 prlimit 和可用的 bwrap，否则跳过 2 条；`workspace-root-data-dir` 在 Linux 上 5 passed、1 skipped。
- 未做：A22 N1（两跳符号链接链漏判，W02 `runtime-roots.ts` 与 S01 `context.ts` 两侧都漏），按冻结规则申请进台账，复现路径见 A22 §1.2。

## 交接

- **W09**：
  - `scripts/electron-migration/boundary-rules.mjs:48-50` `isPublishedApi` 接受 `host/plugins/<p>/portable.ts`，否则 chat 无法不加 boundary-allow 地导入。
  - `scripts/electron-migration/gate-checks/import-cycles-baseline.json` 有 2 条过期环（`agent-profile.ts` ↔ `custom-agents.ts` 已拆），需 `--write-baseline`。
- **W10**：
  - chat 切到 portable.ts（逐文件）：`index.ts:25`、`src/workspace-actions.ts:13`、`src/workspace-run-agent.ts:12-21`、`src/tool-policy.ts:4-5`、`src/workspace-profiles.ts:5-10`、`src/attachment-stage.ts:20-25`、`src/completion-dispatcher.ts:20`、`src/attachment-stage-executor.ts:7-9`、`src/continue-actions.ts:10-13`。
  - `chat/src/register.ts:353-359`：`goal_resume` 恢复后调用 `GoalRuntime.spawnContinuation`（Rust `goal_handlers.rs:150-168`）。
  - ~~发布 `chat.send@1`~~：已由 chat-pipeline 发布（`7458fca8`）；去重建议与 `chat/BLOCKERS.md:53-54` 订正见 `.reports/W02-handoffs/chat-send-provider-W10.md`。
- **W14**：`scripts/portability/baseline.json` 有 3 条已消除（`scan.mjs --check`：0 new, 3 resolved），可删：`agent-orchestration/src/todo.ts`、`agent-skills/src/tools/task-objects.ts`、`agent-workspace/src/workspace/util.ts` 各自的 `node-builtin:crypto`。
- **W14**：可移植的 `defineQuery`（`host/platform/storage/api.ts:224` 本身无逻辑，但 `api.ts` 闭包含 13 个 Node 文件），之后 `agent-orchestration/repository/todo.ts` 才能可移植。
- **S01**：`agent-workspace/src/tools/shell-sandbox.ts` 的 `capability()` 用 `messageOf` 而 Rust 用 io 错误文本；TS Windows unrestricted 用 `UnsandboxedShellBackend`，Rust 是 `DirectHostShellBackend`。
- **主代理**：`host/platform/http/PINNED.md:69` 仍提到已删除的 `pinnedNodeGet`。
- ~~**S01**：`agent-workspace/tests/shell-host-plugin-dir.test.ts:52` 的 setup 正好配置了 L1/L2 拒绝的场景~~：S01 `774c0682` 已按实际生效的 access 选拒绝文本，组合实跑 6/6，见 `.reports/W02-handoffs/S01-shell-host-plugin-dir-test.md` 顶部“现状”。
- **W04 / W05**：V08-06 已落地（`024953f4`），vfs-index 的 `pdf-preview.ts:128`、`pdf-runtime.ts:601`、`ocr-recovery.ts:275`、`pdf-processing.ts:202` 与 W05 的手写 bigint 转换可以删除；注意注册表转成 number，超过 2^53 的整数会舍入（RF-W02-agent-json-bigint）。
- **W22**：`agentCardReadScope` 已发布（`aaf0874b`），`chatanki/src/card-access.ts:6` 可改为纯类型导入，`:34` 改用 `ctx.get('agentCardReadScope')?.lookup(...) ?? null`。
- **W10**：chat 用到的运行时根目录、自定义 agent 文件、todo 持久化：运行时根目录已有 `runtimeRoots` 服务；其余都是桌面专用（直接读写文件或等 W14 的可移植 `defineQuery`），见上文“chat 切换后仍留下的值导入”。
- **B2 headless runner 的 owner**：运行期间调用 `installTrustedAutomationSession`（`agent-orchestration/src/headless.ts:104-129`），结束时撤销，对应 `headless.rs:77-110`。

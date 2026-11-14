# L06 agent-orchestration：WAVE0 v0 等价场景语料（WP-049）

本目录是 `board/WAVE0-EQUIVALENCE.md` §3 v0 格式的场景语料，覆盖 L06 的 17 个前端可达命令。
A 侧（Rust/Tauri）是判定基准；B 侧（Electron Host）按同一场景重放后逐项比对。

- `super-session.json`：6 个 `super_session_*` / `chat_v2_super_deliver_inbox` 命令，41 个场景，83 步。
- `automations.json`：11 个 `chat_v2_automation_*` 命令，242 个场景，560 步。

当前状态：**只写了语料，未运行**。`scripts/electron-migration/record/` 存在于 X7 分支
（`ds-mig/X7-differential`，如 `record/batch.mjs`），尚未进入 main；可执行的真实 A 侧运行器未交付，
因此本目录不代表任何命令达到 C 级。语料覆盖不等于 C 级，也不证明每个分支都已充分覆盖。

## 格式约定

- 两个文件 `domain` 都是 `agent-orchestration`，场景 id 分别以 `super.` / `automation.` 开头，全局唯一。
- 所有场景 `seed: "empty"`，`normalize: []`，`capture: {"events": true, "db": ["*"]}`。只读命令也抓 DB 与事件，
  因为 Rust 调度器启动时会补建心跳自动化（`automations.rs:4230` 起，`id = auto_heartbeat_default`），
  空库下的列表和摘要结果依赖它。
- 步骤只用 `cmd` / `args` / `expect` 三个键。`expect: "error"` 只是注释，表示按 Rust 源码推断这一步返回 Err；
  比对时以 A 侧实际结果为准，不预填期望值。
- 跨步引用写成 `${n.path}`，`n` 总是小于当前步序号：
  - `chat_v2_automation_create` → `${n.automation.id}`；
  - notify 类型的 `chat_v2_automation_run_now` → `${n.runId}`；agent_turn 类型的 run_now 不返回 runId，
    通过后续 `chat_v2_automation_runs` 的 `${n.runs.0.id}` 取；
  - `super_session_set_enabled` / `super_session_ensure` → `${n.sessionId}`、`${n.workspaceId}`；
  - `chat_v2_create_session` → `${n.id}`。
- 固定日期：未来 `2099-12-31`，过去 `2000-01-01`；不使用真实 API key 或外网地址。
- 参数形状照抄前端：`automationSettingsApi.ts` 的 `createAutomation()`（`serializeSchedule` 在 `:365`）
  生成 camelCase 请求；serde 边界场景（未知字段、snake_case 字段、类型错误、u64/u8 越界）单独列出。

### 借用的跨域命令（不在 `commands` 里）

| 命令 | 用途 | owner |
|---|---|---|
| `chat_v2_create_session` | 造普通会话、伪造重复/子代理 Super 元数据 | L04 chat-session |
| `workspace_send_message` | 向 Super 会话收件箱投递一条消息 | L04（workspace） |
| `workspace_create` / `workspace_create_agent` | 造满员工作区（WP-274 `g3w-agent-orchestration-01.json`） | L04（workspace） |
| `chat_v2_emergency_stop` | 触发 AgentKillSwitch | L04 |
| `chat_v2_resume_agents` / `chat_v2_resume_automations` | 解除 kill switch / 恢复调度器 | L04 |

B 侧重放这些场景时，上述命令必须由对应 lane 在 Host 上注册；否则这些场景整体 B-blocked。

## 逐命令覆盖

前端位置是 `invoke(...)` 调用行；Rust 位置是 `#[tauri::command]` 函数（来自 `contracts/ipc/L06-agent-orchestration.json`）。
步数统计按“调用该命令的步骤”计：成功步 / `expect: "error"` 步。

### super_session

| 命令 | 前端 | Rust | 场景（id 前缀） | 步数 成功/错误 |
|---|---|---|---|---|
| `super_session_get_state` | `src/features/chat/superSession/api.ts:69`、`src/stores/superAgentEnabledStore.ts:37` | `super_session/commands.rs:17` → `state.rs:736` | `super.get_state.*` 3 | 8 / 0 |
| `super_session_set_enabled` | `superSession/api.ts:73`、`superAgentEnabledStore.ts:38` | `commands.rs:23` → `state.rs:760` | `super.set_enabled.*` 7 | 25 / 3 |
| `super_session_ensure` | `superSession/api.ts:77` | `commands.rs:32` → `state.rs:712` | `super.ensure.*` 4 | 5 / 0 |
| `super_session_get_settings` | `superSession/api.ts:81`、`src/features/settings/components/SuperAgentConfigPanel.tsx:31` | `commands.rs:42` → `state.rs:244` | `super.get_settings.*` 1 | 6 / 0 |
| `super_session_set_settings` | `superSession/api.ts:86`、`SuperAgentConfigPanel.tsx:32` | `commands.rs:48` → `state.rs:254` | `super.set_settings.*` 9 | 7 / 4 |
| `chat_v2_super_deliver_inbox` | `src/features/chat/adapters/tauri/sendOperations.ts:329` | `commands.rs:58` → `inbox.rs:817` | `super.deliver.*` 17 | 9 / 8 |

分支覆盖：

- `get_state`：命令本身无 Err（`Ok(state::get_state(&app))`）。覆盖：未启用默认值（`fresh_disabled`）、
  启用后自愈且幂等（`enabled_self_heals_idempotent`）、关闭后（`after_disable`）。
- `set_enabled`：开启新建会话 + 工作区（`enable_creates_session`）、重复开启复用会话（`enable_twice_reuses_session`）、
  无会话时关闭（`disable_without_session`）、关闭设 hidden 再开启去 hidden（`disable_hides_then_reenable_unhides`）、
  serde 错误：缺 `enabled` / 字符串 / null（`args_*`）。
- `ensure`：未启用返回默认（`disabled_returns_default`）、启用后发 `super_session_changed`（`enabled_emits_changed`）、
  多个活跃 Super 只留最新、其余退役（`retires_duplicate_active`，对应 `state.rs:432-447`）、关闭后仍是默认（`after_disable_stays_default`）。
- `get_settings` / `set_settings`：默认空、trim 往返、4000 字符截断（多字节）、全空白存空串、空对象取默认、未知字段忽略，
  以及 serde 错误：`settings` 为 null / 缺失、`instructions` 为 null / 数字。
- `deliver_inbox`（`inbox.rs:817-888`）每个早退分支：
  - `:827` 会话 id 不以 `sess_` 开头 → Err（`invalid_session_prefix`）；
  - `:832` userMessageId / assistantMessageId 为空白 → Err（`blank_user_message_id`、`blank_assistant_message_id`）；
  - `:840` 设置未启用 → `Disabled`（`setting_disabled`）；
  - `:845` 会话不存在 → `Disabled`（`enabled_unknown_session`）；
  - `:847-852` 非活跃 Super / 已 hidden / 已退役 → `Disabled`（`enabled_non_super_session`、`hidden_super_session`、`retired_super_session`）；
  - `:853` `ensure_session_writable` 拒绝子代理会话 → Err（`subagent_metadata_read_only`）；
  - `:854` kill switch 已触发 → Err（`kill_switch_tripped`）；
  - `prepare_delivery` 收件箱为空 → `Empty`（`empty_inbox`、`empty_inbox_force`、`options_omitted_defaults`）；
  - 收件箱有消息 → 进入发送（`started_after_inbox_message`）。空库没有配置模型，A 侧会在发送管线里报错并发事件，这正是要比对的内容；
  - serde 错误：缺 `assistantMessageId`、`force` 类型错、缺 `request`。

### automations

| 命令 | 前端（`automationSettingsApi.ts`） | Rust（`automations.rs`） | 场景（id 前缀） | 步数 成功/错误 |
|---|---|---|---|---|
| `chat_v2_automation_list` | `:436` | `:4424` | `automation.list.*` 2 | 189 / 0 |
| `chat_v2_automation_create` | `:540` | `:4435` → `create_automation` `:1113` | `automation.create.*` 140 | 116 / 110 |
| `chat_v2_automation_set_enabled` | `:476` | `:4474` → `set_automation_enabled` `:1302` | `automation.set_enabled.*` 13 | 9 / 8 |
| `chat_v2_automation_update` | `:509` | `:4498` → `update_automation_full` `:1444` | `automation.update.*` 40 | 16 / 27 |
| `chat_v2_automation_delete` | `:553` | `:4816` → `delete_automation` `:1716` | `automation.delete.*` 10 | 4 / 9 |
| `chat_v2_automation_runs` | `:618` | `:4553` → `list_automation_runs` `:2020` | `automation.runs.*` 10 | 17 / 3 |
| `chat_v2_automation_retry_run` | `:627` | `:4641` → `retry_automation_run` `:4569` | `automation.retry_run.*` 3 | 3 / 3 |
| `chat_v2_automation_cancel_run` | `:632` | `:4657` → `cancel_automation_run` `:4596` | `automation.cancel_run.*` 3 | 3 / 3 |
| `chat_v2_automation_summary` | `:637` | `:4673` → `:4685` | `automation.summary.*` 4 | 8 / 0 |
| `chat_v2_automation_set_background_enabled` | `:661` | `:4794` | `automation.background.*` 3 | 3 / 2 |
| `chat_v2_automation_run_now` | `:567` | `:4959` → `run_automation_now_core` `:4839` | `automation.run_now.*` 12 | 16 / 8 |

另有 `automation.run_lifecycle.*` 2 个多命令组合场景（run_now → runs → cancel/retry → summary → delete → list）。
`list` 的 189 步大多是其他场景末尾用来抓最终状态的 `chat_v2_automation_list`。

错误形状（UI 路径，`automation_command_error` `:185`）：字符串化 JSON `{"code": …, "message": …}`；
版本冲突 `code = AUTOMATION_VERSION_CONFLICT`，带 `expectedVersion` / `currentVersion` / `current`（`:120-135`）；
活跃 run 冲突 `code = AUTOMATION_RUN_ALREADY_ACTIVE`（`:2857`）。

分支覆盖：

- `create`：
  - `validate_automation_fields`（`:916`）：name 空白 / 101 字符、prompt 空白 / 4001 字符；边界 100 / 4000 字符多字节成功；
  - `validate_schedule`（`:761`）：daily / weekly / weekdays / monthly / interval / once 每种 kind 的必填缺失、多余字段、
    取值越界（weekday 7、day 0/32、interval 4/1441、weekdays 空/重复/越界）、时间格式（单数字小时、`24:00`、空、缺失）、
    once 的日期缺失 / 空白 / 格式错 / 非法日历日 / 过去时间、非法时区；
  - 数值范围（`:1120-1132`）：maxRetries 11、retryBackoff 4 / 86401、timeout 29 / 3601，以及 0/上限边界成功；
  - 校验顺序：`order_name_before_schedule`、`order_schedule_before_retries`（多个字段同时非法时，看哪条错误先报）；
  - agent 字段只允许在 agent_turn 上（`agent_fields_on_notify_*`、`trusted_requires_agent_turn`）；
  - trusted profile `seal` / `validate`（`:330`、`:338`）：schemaVersion、hash 长度/不匹配/非十六进制、
    allowedTools 空/未排序/未 trim/不可用、shell 前缀未排序/不安全（`|`、`$(`）/缺失、网络域名重复/大写/通配/前导点/非法字符、
    runtime roots 空/未排序/id 含 `/` 或未 trim/不支持/读写权限、maxToolRounds 0/31、timeout 29/3601、maxOutputBytes 0/超 4 MiB、
    写工具或读写 root 缺 rollback；空 `profileHash` 由 seal 计算（`agent_turn_trusted_profile_sealed`）；
  - 数量上限 `MAX_AUTOMATIONS = 20`（`:1209`，`limit_reached`，含心跳）；
  - serde：未知字段、snake_case 字段、缺 name/schedule/prompt、schedule 未知字段/kind 错/缺 kind、
    actionType / catchUpPolicy / sessionMode 枚举错、u8/u64 越界与负数、小数、布尔类型错、trusted profile 未知/缺失字段、缺 request。
- `set_enabled`：开关往返、同值 no-op 不涨版本、not found（Validation，`:1330`）、版本冲突、更新后旧版本、
  `expectedVersion` 0（`:1311`）/ 2^63 / 负数 / 字符串、缺 `enabled`、心跳开关、once 未来时间重新启用。
- `update`：各字段 trim 与重算 next_run_at、notify ↔ agent_turn 切换与字段清理、notify 上拒绝 agent 字段、
  无可编辑字段（`:1467` 附近）、只传 null 的 name 视为缺省、所有 create 侧的数值/长度/schedule/trusted 校验、
  校验顺序、版本冲突与连续版本、not found（`:1554`）、`automationId` 空白 / 带空格的心跳 id、`expectedVersion` 0（`:1453`，含无字段时的先后顺序）、
  serde 错误。
- `delete`：成功、二次删除 not found（`:1743`）、更新后用新版本删、版本冲突、`expectedVersion` 0（`:1724`）/ 2^63、
  心跳不可删（`:1751`）及“版本冲突先于心跳检查”、缺 `expectedVersion`；有活跃 run 时拒绝（在 `run_lifecycle.cancel_retry_cancel_delete` 里）。
- `runs`：空库、参数缺省 / null、未知 automation、limit 0 → 1 与 1000 → 200 截断（`:2070`）、按 automation 过滤、
  serde 错误：负数 / 小数 limit、数字 automationId。
- `run_now`（`:4839` 起）：notify started、已禁用仍可运行、agent_turn started、心跳手动运行、
  not found（NotFound 类型，和其他命令的 Validation 不同）、版本冲突（含 0 / 2^63）、agent_turn 连续两次 → `AUTOMATION_RUN_ALREADY_ACTIVE`、
  notify 连续两次、kill switch：`emergency_stop` 后被 `automation_dispatch_allowed()`（`:4855`）拒绝，
  `resume_agents` 后仍被调度器暂停拒绝，`resume_automations` 后成功；缺 `expectedVersion`。
- `retry_run`：not found 与运行中都报 `Run is not retryable`（`:4591`，`changed != 1`）；cancelled / error 状态可重试（在 `run_lifecycle.*` 里）。
- `cancel_run`：not found 报 `Run is not cancellable`（`:4611`）；取消 notify run、二次取消报错（在 `run_lifecycle.*` 里）。
- `summary`：空库、启用/禁用计数、后台关闭、notify run 之后。命令本身只有 DB 错误分支。
- `set_background_enabled`：关闭再打开（发 `chat_v2://automations_changed` action `background`）；serde：缺参数、字符串。

## 未写成场景的分支

| 分支 | 原因 | 需要谁 |
|---|---|---|
| `deliver_inbox` → `Paused`（`inbox.rs:699`，连续 ≥20 条自动入站） | 空库下要造 20 条连续入站消息，需要非 empty 的 seed | X3（seed 机制） |
| `deliver_inbox` → `Busy`（`inbox.rs:865`，已有流在跑） | 需要并发长流或慢速 mock LLM 才能稳定复现 | X5（mock LLM / 并发步骤） |
| `deliver_inbox` 第二次 `admit_or_block` 失败后的回滚 | 两次检查之间的竞态，无法确定性触发 | **未覆盖**，待 C2 审定是否列为 G3 例外（不自行记为不可达） |
| `run_now` 通过调度器检查、却被 `admit_or_block_from_app`（`:4861`）拒绝 | 触发 kill switch 总会同时暂停调度器，而 `resume_automations` 要求先解除 kill switch，所以前一道检查总先命中 | 无（记为不可达） |
| `set_enabled(false)` 取消排队 / retrying 中的 run；update 遇到 once 已完成 | 需要调度器把 run 推到对应状态，依赖时间 | X7（runner `waitFor`） |
| 所有 DB 错误分支（`db_error(...)`）、`主数据库未初始化` | 需要故障注入，v0 语料未覆盖 | **未覆盖**，待 C2 逐项审定是否列为 G3 例外；本 lane 不以“前端不可达”自行免除 |

## G3 错误判定（WP-274）

`g3w-agent-orchestration-01.json` 只收 Rust 侧可达的业务 Err。下表 5 条命令逐条判定；
“不可达”指只有 DB/IO/锁/join/序列化故障或 Tauri State 未注册才会出现的 Err。5 条命令都没有参数，不存在参数反序列化 Err。

| 命令 | 判定 | 依据 |
|---|---|---|
| `chat_v2_automation_list` | 无可达 Err | `automations.rs:4424-4433` → `automation_list_response` `:1790-1802` → `load_automations` `:1270-1281`：只有 `db_error`（打开连接/prepare/query/decode）和 `spawn_blocking` join 错误 `:4421`。decode 失败（`row_to_automation` `:960` 起的 `schedule_json` 等）要求库里有命令写不出的坏行，空 seed 下不可达 |
| `chat_v2_automation_summary` | 无可达 Err | `automations.rs:4673-4679` → `automation_summary_response_inner` `:4685-4777`：6 条 `query_row` 都是 `db_err`；`automation_background_enabled` `:4779-4785` 吞错取默认 `true`；其余同上 join 错误 `:4421` |
| `super_session_get_state` | 无可达 Err | `super_session/commands.rs:17-20` 固定 `Ok(state::get_state(&app))`；`state.rs:736-756` 把 `ensure` 的 Err 记 warn 后返回兜底状态 |
| `super_session_get_settings` | 无可达 Err | `commands.rs:42-46` 唯一 Err 是 `主数据库未初始化`（`main_db_from_app` `state.rs:262-264`，`Arc<Database>` 未 manage，正常启动不可达）；`read_settings` `state.rs:244-252` 吞 `get_setting` 错误取空串 |
| `super_session_ensure` | `g3w.agent-orchestration.super_session_ensure.err_register_agent_quota` | 见下 |

`super_session_ensure`（`commands.rs:32-40` → `state::ensure` `state.rs:712-734` → `ensure_core` `:433-457` → `ensure_workspace_locked` `:386-428`）：

- 可达：`ensure_workspace_locked` `:394-403` 对 metadata 中已存在且 Active 的工作区，若本会话不是该工作区成员就 `register_agent`；
  `coordinator.rs:321-326` 在非终态 agent 数 ≥ `MAX_AGENTS_PER_WORKSPACE`（`config.rs:5`，10）时返回
  `Workspace has reached maximum active agent limit: 10`，经 `?` 原样返回前端（Rust 测试 `register_agent_quota_ignores_terminal_agents`，`coordinator.rs:1360` 同一分支）。
  场景：普通会话 → `workspace_create` → `workspace_create_agent` ×10（`src/features/chat/workspace/api.ts:128`、`:189`，参数照 `CreateAgentCard.tsx:73`，不带 `initial_task`，agent 停在 Idle）
  → `super_session_set_enabled(true)`（先建真 Super，避免这一步就撞上限）→ `chat_v2_create_session` 伪造更新的活跃 Super 元数据并指向该工作区
  → `super_session_ensure`。`list_active_super_ids` `:278` 按 `created_at DESC` 取伪造会话为保留者，真 Super 被退役（`:440-444`，副作用在 Err 前已落库）。
- 不可达：`chat_db_from_app` / `coordinator_from_app`（`state.rs:639-649`，State 未注册）；`list_active_super_ids` `:278-294`、
  `create_super_session` `:322-331`、`set_hidden`/`ensure_workspace_locked` 的 `update_session_v2`、`create_workspace`（`coordinator.rs:169-183`，DB 创建/写入/索引同步）均为 DB/IO；
  `load_session` 的 `Session not found` `:316-320` 只在 `list_active_super_ids` 读出 id 之后被并发硬删时出现（`ENSURE_LOCK` 不覆盖删除路径），无法确定性触发；
  `get_agent` / `register_agent` 的 `get_instance`（`coordinator.rs:953`）在 `get_workspace` 已返回 Active 后只剩 DB 打开失败。
  `retire_session` 失败 `:441-443` 只记 warn，不返回 Err。

## 依赖时间的场景

这些场景的结果取决于后台任务（notify 投递、headless run、调度器补建心跳）在下一步之前是否已推进。
建议 X7 给 runner 加 `waitFor` / 轮询原语；在那之前，比对时要把这些场景的差异单独归类，不能直接判为不等价：

- `automation.cancel_run.notify_run_after_run_now`
- `automation.run_lifecycle.cancel_retry_cancel_delete`、`automation.run_lifecycle.agent_error_then_retry`
- `automation.retry_run.running_not_retryable`
- `automation.run_now.agent_turn_twice_active_conflict`、`automation.run_now.notify_twice`
- `automation.runs.limit_0_clamps_to_1`
- 依赖心跳已补建的场景：`automation.list.fresh`、`automation.summary.fresh`、`automation.create.limit_reached`、
  `automation.run_now.heartbeat_agent_turn`、`automation.delete.heartbeat_*`、`automation.set_enabled.heartbeat_toggle`、
  `automation.update.automation_id_trimmed_heartbeat`

## normalize 候选（未启用）

`normalize` 目前全是 `[]`。首次 A/B 运行后，下列字段大概率需要归一，届时按实际差异再加，不提前猜：

- id：`auto_<毫秒>_<4位>`、`run_<uuid>`、`sess_…`、`ws_…`、消息 id；
- 时间：`createdAt` / `updatedAt` / `lastRunAt` / `nextRunAt` / `startedAt` / `finishedAt` / `retired_at`、run 的 `next_attempt_at` / `lease_expires_at`；
- trusted profile 的 `profileHash` 在输入相同时应一致，不应归一。

## B 侧已知阻塞

| 阻塞 | 影响的场景 | owner |
|---|---|---|
| B1：`chat.send@1` 未在 main 发布，`chat_v2_super_deliver_inbox` 不注册（`BLOCKERS.md` §1） | 全部 `super.deliver.*`（17 个） | L04 chat-session |
| B2：headless runner（`runHeadlessAgentTurn`）未接通，agent_turn run 在 B 侧以 `error` 收尾 | `automation.run_now.agent_turn_*`、`heartbeat_agent_turn`、`retry_run.running_not_retryable`、`run_lifecycle.*` | L03 + L04，高层 L06 |
| 跨域命令（上表）未在 Host 注册 | 所有使用这些命令的场景 | L04 |
| A/B 场景 runner 不存在 | 全部 | X7 |

B 侧缺功能的场景照样保留，作为 B 实现后的验收输入，不能因为 B 侧还做不到就删掉。

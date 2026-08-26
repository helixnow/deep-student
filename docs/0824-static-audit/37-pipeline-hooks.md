model=gpt-5.6-sol-xhigh-fast
# 37 — PipelineHook 四切点、生产调用与旁路审计

审计范围：`ChatV2Pipeline` 的 hook 注册与四个切点、单/多变体工具环、桌面交互、
headless、workspace worker、变体重试、压缩入口，以及绕开
`execute_single_tool` 的生产执行器路径。本文是静态审计，不把“默认 hook 已注册”
等同于“所有生产路径都经过 hook”。

## 结论

**FAIL。存在 1 条真实的写权限旁路，另有 2 类 hook 覆盖缺口。**

1. **真实权限旁路：`tool_pack` 可把 Medium 写工具
   `webpage_save` 包在 Low 顶层调用中，子调用直接进入
   `ToolExecutorRegistry::execute`，不经过 `ApprovalGateHook::before_tool`。**
   因此 Ask 的写操作硬拦截、Plan gate、Cautious/其他需审批档位的
   `ApprovalManager` 均不作用于该子调用。这不是只缺一条审计日志：
   `webpage_save` 会写入 VFS、记录来源并排队索引。
2. **`before_turn` 只覆盖单变体 `execute_with_tools`，生产多变体及其单/批量重试
   使用另一套工具循环，完全不调用它。** 当前内置实现仅写 debug 日志，所以当下
   不直接放宽权限；但 trait 允许 `before_turn` 返回错误中止整轮，故任何追加的
   回合级 gate 都会被多变体生产路径绕过。
3. **`before_compaction` 不是全局压缩切点，只覆盖单变体工具环内压缩。**
   回合末兜底、历史 overflow、多变体 fan-out 前压缩和手动压缩均直接调用
   `run_compaction*`。当前内置实现仅写日志，属于审计/扩展面漏记，不是现有
   授权旁路，但“流水线压缩前 hook”不能被理解成全生产覆盖。

顶层工具调用方面，单变体与多变体最终共享 `execute_tool_calls`，正常都会进入
`execute_single_tool`，所以 `before_tool` / executor `Ok` 分支的 `after_tool`
对**顶层调用**接线完整。默认链也确实由唯一生产 Pipeline 构造路径注册，未发现
生产代码删除、替换或重排默认 hook。

**需要产品修复。** P0 应先消除 `tool_pack → webpage_save` 的 Authority/
Approval 绕行；随后统一单/多变体的回合切点，并明确 `before_compaction`
究竟是“仅环内”还是“所有压缩入口”的契约。**本轮不改代码。**

## 一、注册链与生产实例

### 默认链不可从现有 builder 移除

- `src-tauri/src/chat_v2/pipeline.rs:147-199`：`hooks` 是
  `ChatV2Pipeline` 私有字段。
- `src-tauri/src/chat_v2/pipeline.rs:212-244`：`new()` 无条件设置
  `hooks: hooks::default_pipeline_hooks()`。
- `src-tauri/src/chat_v2/pipeline/hooks.rs:138-144`：默认顺序固定为
  `ApprovalGateHook → TaskAuditHook`。
- `src-tauri/src/chat_v2/pipeline.rs:247-253`：`with_pipeline_hook` 只能复制
  既有链并在末尾追加，不能前插、替换或清空；当前生产代码也没有调用该方法。
- `src-tauri/src/chat_v2/pipeline/hooks.rs:37-52`：`ToolAdmission` 的权限证据字段
  私有，追加 hook 无法伪造审批结论。

### 唯一生产构造与依赖注入

`src-tauri/src/lib.rs:1292-1344` 是检出的唯一非测试
`ChatV2Pipeline::new`：应用先构造共享 `ApprovalManager`，再以
`with_approval_manager`、`with_kill_switch`、`with_workspace_coordinator`
补齐生产依赖，最后 `app.manage(chat_v2_pipeline)`。其余 `new()` 命中均在
Rust 测试 harness。

因此“生产 Pipeline 忘记注册默认 hook”不是问题；真正的问题是部分生产控制流
没有经过相应切点，及嵌套执行器绕过 Pipeline 级工具切点。

## 二、四个切点逐项核对

| 切点 | 实际位置 | 单变体 | 多变体 | 旁路判断 |
| --- | --- | --- | --- | --- |
| `before_turn` | `tool_loop.rs:342-347`，每轮最前，doom-loop/轮次上限/LLM 前 | 覆盖 | 不调用 | 有覆盖缺口 |
| `before_tool` | `tool_loop.rs:3173-3195`，构建 `ExecutionContext` 前 | 顶层覆盖 | 顶层覆盖 | `tool_pack` 子调用旁路 |
| `after_tool` | `tool_loop.rs:3267-3275`，registry 返回 `Ok` 后 | 顶层覆盖 | 顶层覆盖 | `tool_pack` 子调用旁路 |
| `before_compaction` | `tool_loop.rs:465-470`，仅环内 `run_compaction` 前 | 仅环内覆盖 | 不调用 | 多个生产压缩入口旁路 |

### 1. `before_turn`

单变体 `execute_with_tools` 在循环体第一条动作遍历 hook
（`tool_loop.rs:342-347`），位置早于 doom-loop、递归上限、环内压缩和 LLM。
`before_turn` 返回 `ChatV2Result<()>`
（`hooks.rs:102-109`），所以它不只是 observer，而是可中止回合的 gate。

多变体走独立循环：`multi_variant.rs:1382-1408` 从取消检查直接进入技能审计，
随后 `1408-1431` 构造 LLM 调用；文件内没有 PipelineHook 的
`before_turn` 调用。初始多变体由 `pipeline.rs:540-593` 的生产分支进入；
变体单次/批量重试还分别由
`handlers/variant_handlers.rs:708-746`、`1015-1045` 直接进入
`execute_variant_retry` / `execute_variants_retry_batch`。这些都是真实生产路径，
不是测试特例。

### 2. `before_tool`

`execute_tool_calls` 是单/多变体共用的工具批执行函数
（`tool_loop.rs:2549-2612`）。单变体在 `tool_loop.rs:1680-1706` 调用它；
多变体在 `multi_variant.rs:1557-1584` 调用它。每个实际尝试最终进入
`execute_single_tool`，并在 `ExecutionContext` 构造和 registry 执行前遍历
`before_tool`（`tool_loop.rs:3173-3195`）。

默认第一个 `ApprovalGateHook` 在该点依次执行 Kill Switch、运行时 allowlist、
trusted automation 校验、功能开关、灾难命令守卫、用户命令规则、runtime-root
审批绑定、敏感度、AuthorityGate、人工审批、等待后的权限复核及 Plan binding
原子消费（`hooks.rs:234-947`）。拒绝会返回完整失败工具结果，不进入 executor。

自动重试不会复用一次旧准入：`tool_loop.rs:2865-2919` 每次尝试都重新调用
`execute_single_tool`，因而每次重跑完整 `before_tool`。

### 3. `after_tool`

registry 返回 `Ok(mut result)` 后才遍历 `after_tool`
（`tool_loop.rs:3267-3275`）；`before_tool` 拦截和 registry `Err` 不调用。
这与 trait 注释“executor 成功返回后”一致。执行器以
`Ok(ToolResultInfo { success: false })` 表达的业务失败仍会进入该切点。

内置 `TaskAuditHook` 在这里给特定 external MCP 结果补
`external_mcp_security_boundary`，并给 trusted automation 预授权结果补
`trusted_automation_preauthorized`（`hooks.rs:975-1036`）。但该保证只对经过
`execute_single_tool` 的顶层调用成立。

### 4. `before_compaction`

当前名字实际表示“**单变体工具环内、因 `ctx.needs_compaction` 触发的压缩前**”：
只有 `tool_loop.rs:465-470` 调用它。以下生产压缩均不调用：

- 回合末兜底：`pipeline.rs:1061-1087`；
- 历史 overflow：`pipeline/history.rs:609-621`；
- 多变体 fan-out 前：`pipeline/multi_variant.rs:248-318`；
- 用户手动压缩：`handlers/block_actions.rs:51-101`。

trait 的当前签名返回 `()`（`hooks.rs:129-135`），不能否决压缩；内置
`TaskAuditHook` 也只记录 `in_loop_compaction_start`
（`hooks.rs:1039-1051`）。所以这里首先是可观测性和扩展契约不完整，而不是
现有权限放行。

## 三、生产调用面

### 会进入单变体 `execute_with_tools` 的路径

- 普通发送与 wake 经
  `handlers/send_message.rs:295-335` 的公共封装调用 `pipeline.execute`；
- retry、edit-and-resend、continue 分别在
  `handlers/send_message.rs:1074-1078`、`1517-1521`、`2057-2068`
  调用同一 `execute`；
- workspace worker 在
  `handlers/workspace_handlers.rs:1740-1749` 调用同一 `execute`；
- headless 从托管状态取同一个生产 Pipeline，并经
  `headless.rs:1676-1690` 复用 `run_send_message_pipeline`。

这些路径若请求不含 2 个以上并行模型，都会由
`pipeline.rs:980-992` 进入 `execute_with_tools`，四切点中的单变体接线按上文
生效。

### 多变体路径

请求含至少两个模型时，`pipeline.execute` 在 `pipeline.rs:540-593` 提前返回
`execute_multi_variant`。每个变体使用 `multi_variant.rs:1059-1864` 的独立
LLM/tool loop。它仍通过共享 `execute_tool_calls` 获得顶层
`before_tool/after_tool`，但没有 `before_turn`，也没有环内
`before_compaction`。

变体 retry/batch retry 不经过 `pipeline.execute` 的单/多变体分派，直接进入同一
变体执行核心，覆盖缺口相同。

## 四、已确认的工具执行旁路：ToolPack

### 旁路链

1. `ToolPackExecutor` 已注册在生产 registry
   （`pipeline.rs:404-410`），前端动态 builtin skill 公开
   `builtin-tool_pack`（`src/features/chat/skills/builtin-tools/tool-pack.ts:22-34,81-89`），
   因而是可达生产能力。
2. 顶层 `tool_pack` 自报 **Low**
   （`tools/tool_pack_executor.rs:873-875`），所以 Ask/Plan 将其视为只读；
   `authority_mode.rs:49-57,162-193` 明确只有 effective Medium/High/unknown
   才是写操作。
3. pack 子调用没有回到 `ChatV2Pipeline::execute_single_tool`，而是在自建
   `ExecutionContext` 后直接调用
   `registry_clone.execute(&sub_call, &sub_ctx)`
   （`tool_pack_executor.rs:82-124,557-560`）。
4. pack 自己复制了 allowlist、功能开关、shell 用户 Deny 和 effective
   sensitivity 检查（`360-514`），但没有调用 AuthorityGate、Plan gate 或
   ApprovalManager。
5. 它又显式例外放行 effective Medium 的 `webpage_save`
   （`56-67,463-518`）。该工具在真实 executor 中定义为 Medium
   （`index_webpage_executor.rs:548-557`），并实际保存页面到 VFS、更新元数据、
   排队索引（同文件 `335-474,700-728`）。

所以在 Ask 模式或任何本应要求 Medium 审批的会话中，模型可提交 Low 的
`tool_pack`，由其执行 Medium 的 `webpage_save`，而不会触发该子调用本应经过的
Authority/Approval 流程。单 permit 和内容哈希去重只控制并发/重复，不等价于用户
授权。

### 旁路边界

- 其他 effective Medium/High/unknown 子工具默认 fail-closed；本报告没有把
  “所有 ToolPack 子工具”误报成可写旁路。
- 本地 shell 的 guard admission 不继承到子调用
  （`tool_pack_executor.rs:114-117`），且当前 shell 高敏感度会被 sensitivity
  检查挡住；未发现借 ToolPack 直接执行 shell 的现成路径。
- headless 已明确隔离 `tool_pack`：
  `headless.rs:523-524` 将其列为 write-risk，trusted automation profile 测试也
  拒绝 `builtin-tool_pack`（`automations.rs:7213-7219`）。因此本缺口主要落在
  普通交互、多变体和 workspace 会话，不应扩写成 headless 绕过。
- emergency stop 会取消全部 active stream
  （`kill_switch.rs:167-193`），取消 token 会传播到 pack 子任务；未发现
  ToolPack 绕过“一键断电”的证据。

## 五、测试与修复建议

当前直接 hook 测试只锁定默认名字顺序
（`hooks.rs:1479-1487`）及若干 ApprovalGate 内部安全事实；未见一个记录型自定义
hook 对四切点、单/多变体、retry、compaction 各入口的调用次数/顺序契约测试，也
未见 Ask/Plan 下 `tool_pack(webpage_save)` 必须拒绝的回归测试。

建议最小收口：

1. **先修权限旁路**：不要由 Low 的 pack 私自例外执行 Medium 写工具。可将
   `webpage_save` 移出 pack；或让 pack 在展开后把每个子调用送回统一的 Pipeline
   准入 API。不能仅再复制一份 Authority/Approval 逻辑，否则仍会继续漂移。
2. **统一回合 hook**：抽出单/多变体共用的 hook runner；多变体每个真实 LLM
   round 也必须调用 `before_turn`，并明确是按 variant 还是按共享 turn 计数。
3. **明确压缩契约**：若名义上是全局 `before_compaction`，把调用收敛到
   `run_compaction_for_session` 的唯一入口；若只想覆盖环内，应重命名并另设全局
   压缩审计点，避免调用方误判覆盖范围。
4. 新增生产形态测试：单/多变体各验证四切点；顶层工具与 pack 子工具验证
   AuthorityGate/Approval 一致；手动、overflow、fan-out、回合末四种压缩验证
   明确的 hook 契约。

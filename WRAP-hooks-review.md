# WI-13 PipelineHook wrap-up 安全复查

复查范围：`pipeline/hooks.rs`、`pipeline/tool_loop.rs` 的四个调用点、
`ChatV2Pipeline` 默认注册与生产构造路径，以及本地 shell executor 的最终守卫。

## 结论

- 安全绕过：**0 个**。未发现漏注册或默认顺序错误。
- 明显行为回归：**1 个**。已批准的 Plan binding 会在执行前二次审批复核中
  被误判为未满足审批，现已修复。
- 复查发现：**5 个**（1 个可扩展性安全缺口、1 个 Plan 行为回归、
  3 个测试缺口），均已修复。
- `ApprovalGateHook` 仍由 `ChatV2Pipeline::new` 默认注册在第一位；
  `TaskAuditHook` 第二，自定义 hook 只能追加。
- 生产初始化在 `src-tauri/src/lib.rs` 中继续注入共享
  `ApprovalManager` 与 `ChatV2State.kill_switch`。`ChatV2Pipeline::new`
  保留可选依赖是测试/组合接口行为，不代表生产路径关闭安全闸。

## 调用点与顺序

| 切点 | 位置 | 复查结果 |
| --- | --- | --- |
| `before_turn` | 工具环每轮开头，doom-loop/轮次上限及 LLM 调用前 | 已注册 |
| `before_compaction` | 环内 `run_compaction` 前 | 已注册 |
| `before_tool` | `ExecutionContext` 构建及 executor 调用前 | 已注册；默认先执行审批闸 |
| `after_tool` | executor `Ok` 后、结果回喂前 | 已注册；审计注记保留 |

## 安全核对

### 审批 fail-closed

- Authority 状态首次读取或执行前复核失败均返回拦截结果。
- 策略要求审批但 `ApprovalManager` 缺失时拒绝执行。
- 拒绝、超时、通道关闭、取消均不进入 executor。
- 本地 shell 的 runtime-root 绑定在审批后再次解析并比对；Plan binding
  在执行前原子消费。
- 新增真实 `execute_single_tool` 回归测试，确认审批服务缺失时 executor 调用数
  保持为 0；既有 AuthorityGate 与 C4 集成测试继续覆盖其余主路径。

### Kill Switch

- `ApprovalGateHook::before_tool` 首先检查 Kill Switch。
- 等待 Plan/工具审批后再次检查，避免等待期间断电失效。
- `tool_loop.rs` 在上下文构建完成、executor 调用前保留最终检查，关闭最后的
  TOCTOU 窗口。
- 既有 C4 测试覆盖 Craft、已批准 Plan、pending approval drain 与 resume。

### 不可覆盖灾难命令守卫

- 默认审批 hook 在用户命令规则、remembered approval 与权限 preset 之前对
  backend local shell 执行灾难命令检查；`Deny` 直接拦截。
- local shell executor 在 spawn 前使用真实 cwd/runtime roots 再检查一次；
  外部 MCP 明确不宣称受本地解析器保护。

## 发现与修复

1. **安全扩展缺口**：`ToolAdmission` 的安全证据字段原为公开可写，
   追加 hook 可在审批闸之后改写 `immutable_guard_asks` /
   `approval_requirement_satisfied`，伪造传给 executor 的 shell guard
   admission。现已封装字段与构造器，仅向 `tool_loop` 暴露只读派生结果。
2. **默认链测试缺口**：新增 `default_hooks_keep_approval_gate_first`，
   锁定 `approval_gate -> task_audit`，防止后续漏注册或重排。
3. **灾难守卫接线测试缺口**：提取纯分类函数并新增
   `catastrophe_guard_is_wired_only_to_backend_local_shell`，锁定本地灾难命令
   为 `Deny`，同时锁定外部 MCP 不被错误标记为本地守卫覆盖。
4. **Plan 二次复核回归**：有效 Plan binding 已替代本次二级工具审批，但执行前
   复核只调用 `requires_tool_approval`，会在 binding 原子消费前误拦截所有正常
   Plan 写工具。现于当前 authority 状态上重新验证同一 binding，再决定是否需要
   二级审批；新增真实 executor 路径测试并确认 binding 在执行前被消费。
5. **fail-closed 行为测试缺口**：原测试只验证敏感度分类 helper，没有通过
   `ApprovalGateHook` 证明缺失 `ApprovalManager` 时 executor 不运行。新增
   Cautious/Medium 真实调用测试，锁定拦截原因和零执行次数。

本轮未做第二轮模块拆分。

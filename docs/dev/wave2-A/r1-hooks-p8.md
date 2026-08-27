# Wave2-A 第 1 轮 #6 锚定员-hooks：P8 四小件落地报告

- 基线：`origin/cursor/0824-cde6` @ `061b4815`（Step 23）
- 本枝：`cursor/0824-wave2-agent-cache-a875`
- 改动文件：仅 `src-tauri/src/chat_v2/pipeline/hooks.rs`（本轮独占）
- diff 量级：**+76 / -26**（1 文件；其中约 50 行为 rustdoc/注释与新增小测试，纯逻辑改动约 ±15 行）
- 铁律遵守：未执行 npm / cargo / rustc / rustfmt / tsc / vite / 任何测试 / CI；未 commit / push；
  未触碰 coordinator.rs、tool_loop.rs、multi_variant.rs、providers/mod.rs、executors、前端。

---

## 1. 删除只写字段 `ToolAdmission.approval_arguments`

**改了什么**

- 删除字段定义（原 `:41`）、`new()` 内的初始化 `approval_arguments: arguments.clone()`
  （原 `:57`）、`ApprovalGateHook::before_tool` 末尾的回写
  `admission.approval_arguments = approval_arguments;`（原 `:937`）。
- 全仓复核无读点后删除；`ToolAdmission::new` 不再对工具参数做任何 clone。

**签名兼容决策（重要）**

`ToolAdmission::new` 的唯一调用点在 `tool_loop.rs:3189`
（`let mut admission = ToolAdmission::new(&tool_call.arguments);`），该文件本轮禁改。
按任务卡的兼容优先指令，保留签名 `pub(super) fn new(_arguments: &Value) -> Self`，
参数改名 `_arguments` 并忽略，函数上方 rustdoc 说明了保留缘由（`hooks.rs:62-65`）。
后续某轮若允许改 `tool_loop.rs`，可把调用点改为 `ToolAdmission::new()` 并去掉参数。

**没改什么**

- `ApprovalGateHook::before_tool` 内的**局部变量** `approval_arguments`（现 `:449`）
  原样保留，仍用于 resolve 绑定（`:464/:469`）、plan gate（`:579`）、
  never-remember 判定（`:719`）、session remember（`:736`）、审批请求（`:780`）。
- `request_tool_approval` / `request_plan_gate` 的 `approval_arguments: &Value` 形参不变。

**grep 自证**

```text
rg -n 'approval_arguments' src-tauri/src/chat_v2/pipeline/hooks.rs
  62:  （rustdoc，说明字段已删）
  449/464/469/500/579/719/736/780/825:  before_tool 局部变量及引用（保留）
  1126/1202/1227/1231/1235/1245/1356/1397:  resolve 函数与两个 request_* 的形参（保留）
```

`ToolAdmission` 结构体（现 `:44-59`）上 `approval_arguments` 字段为**零**。
`rg -n 'ToolAdmission::new' --type rust` 全仓仅 `tool_loop.rs:3189` 一个调用点（未改）。

## 2. 文档化 + 断言「准入先于审计」的隐式依赖

**改了什么**

- 文件头 module doc 新增段落（`hooks.rs:14-20`）：写明
  `TaskAuditHook::after_tool` 消费 `ApprovalGateHook::before_tool` 写入的
  `authority_admission` / `is_external_mcp` / `trusted_automation_preauthorized`；
  顺序颠倒时这些字段停留在 fail-closed 初始值，安全注记会静默丢失。
- `default_pipeline_hooks` rustdoc 展开（`:152-158`）：「顺序敏感：准入必须先于审计」
  + 链首位由测试 `default_hooks_keep_approval_gate_first` 锁定。
- 现有测试 `default_hooks_keep_approval_gate_first`（现 `:1517`）**原样保留**，
  其上新增 doc 注释（`:1510-1514`）说明依赖链。
- 旁边新增小测试 `audit_consumed_admission_fields_start_fail_closed`（`:1531`）：
  断言 `ToolAdmission::new` 产出的三个审计依赖字段初始为
  `authority_admission=None` / `is_external_mcp=false` /
  `trusted_automation_preauthorized=false`，锁定「初始值不可伪造准入证据」。
  （只写不跑。）

**没改什么**：`TaskAuditHook::after_tool` 的审计行为一行未动（external MCP 注记逻辑
`:1003-1036`、trusted automation 标记 `:1041-1054` 与迁移前逐字一致）。

## 3. trait `PipelineHook` 各切点失败语义 rustdoc

trait 文档重写（`hooks.rs:100-111`），逐切点写明：

- `before_turn`：返回 `ChatV2Result`，`Err` 中断整个回合（错误向上传播）；
- `before_tool`：不走 `Result`，拦截用 `ToolGateOutcome::Block`（携带失败
  `ToolResultInfo` 回喂模型），`Proceed` 放行并写入 `ToolAdmission`；
- `after_tool`：无返回值，不可失败，只能注记结果 / 打审计日志；
- `before_compaction`：无返回值，不可失败，只能观察 / 打日志，不能阻止 compaction。

方法签名与默认实现零改动。

## 4. 两个同构 `tokio::select!` 等待器收敛

**改了什么**

- 新增文件级私有函数 `wait_oneshot_with_optional_cancel`（`hooks.rs:1089-1102`）：

```rust
async fn wait_oneshot_with_optional_cancel<F: std::future::Future>(
    rx: F,
    timeout_duration: std::time::Duration,
    cancellation_token: Option<&CancellationToken>,
) -> Option<Result<F::Output, tokio::time::error::Elapsed>>
```

  泛型 `F: Future` 是因为两处 oneshot receiver 的响应类型不同
  （ApprovalManager 审批响应 vs PlanGate 响应）；返回三层语义
  `None`=取消 / `Some(Err)`=超时 / `Some(Ok(..))`=收到结果（含通道关闭），
  与原两处 `wait_result` 的形状逐位一致。

- 两处原 `tokio::select!` 块（原 `:1231-1237` 与 `:1380-1386`）删除，替换为调用：
  - `request_tool_approval`：现 `hooks.rs:1274-1275`
  - `request_plan_gate`：现 `hooks.rs:1418-1419`

**没改什么**：等待之后的 `let Some(timeout_result) = wait_result else`（现 `:1277` /
`:1421`）与 Approved / Rejected / Timeout / ChannelClosed / Cancelled 各业务分支
逐字保留，两处未做任何业务逻辑合并。

**grep 自证**

```text
rg -n 'tokio::select!' src-tauri/src/chat_v2/pipeline/hooks.rs
  1095:  （仅剩 helper 内一处）
rg -n 'wait_oneshot_with_optional_cancel' src-tauri/src/chat_v2/pipeline/hooks.rs
  1089:  定义
  1275:  request_tool_approval 调用点
  1419:  request_plan_gate 调用点
```

---

## 禁改区自证（未动）

- **十五段准入序列**：`ApprovalGateHook::before_tool`（`:254-967`）的顺序、条件、
  fail-closed 全部未动——Kill Switch → 运行时 allowlist → trusted automation 校验 →
  memory/RAG/WebSearch 开关 → 灾难命令守卫 → 用户命令规则 → 审批作用域绑定 →
  敏感度解析 → AuthorityGate（Ask/Plan/Craft）→ 审批要求判定 → trusted automation
  预授权 → ApprovalManager 人工审批 → 重绑定复核 → 执行前权限复核（TOCTOU）→
  计划批准原子消费。唯一 diff 是删除末尾 `admission.approval_arguments` 一行赋值。
- **TOCTOU 三段**：kill switch 复核（`:861-868`）、取消复核（`:869-873`）、authority
  复核 + plan binding 原子消费（`:874-955`）语义逐字未动。
- **`ApprovalGateHook` 链首位**：`default_pipeline_hooks`（`:159-164`）顺序未动，
  测试 `default_hooks_keep_approval_gate_first` 仍在（`:1517`）。
- **既有测试**：`catastrophe_guard_is_wired_only_to_backend_local_shell`、
  `missing_approval_manager_is_fail_closed_for_non_low_sensitivity`、
  `phase9_*`、`phase2_phase3_and_phase8_*` 全部一字未改。
- 未运行 rustfmt；新增代码手工对齐周围 4 空格缩进风格。

## 验收对照

| 验收项 | 状态 |
| --- | --- |
| `ToolAdmission` 上 `approval_arguments` 字段为零 | ✅（结构体 `:44-59` 无此字段） |
| 两处 select 块消失、改为函数调用 | ✅（仅剩 helper 内 `:1095` 一处 select） |
| `default_hooks_keep_approval_gate_first` 仍在 | ✅（`:1517`） |
| 切点失败语义文档化 | ✅（trait rustdoc `:100-111`） |
| 只写不跑测试 | ✅（新增 1 个测试源码，未执行任何构建/测试命令） |

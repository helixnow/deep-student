# Wave2-A 第 2 轮审阅 #8：hooks 准入语义与 TOCTOU 三段

- 审阅员：r2 #8「审阅员-语义」（claude-fable-5-thinking-high）
- 审阅对象：第 2 轮工作区改动（`pipeline.rs` / `helpers.rs` / `tool_loop.rs` / `multi_variant.rs`，均未提交）
  相对 `HEAD = d0505bc6`，及 hooks.rs 相对基线 `origin/cursor/0824-cde6` 的累计差异
- 结论：**确认**（本轮改动不影响 hooks 准入序列与 TOCTOU 三段；hooks.rs 第 2 轮零改动，
  相对基线只有第 1 轮 P8 一个提交）

> ⚠️ 行号快照说明：审阅期间工作区正被并行实现代理持续写入（`tool_loop.rs` 的
> diff 在两次读取之间从 +77 行涨到 +96 行）。本文所有 `tool_loop.rs` 行号为
> **审阅时刻快照**，随后续插入可能继续下移；`hooks.rs` 本轮零改动，行号稳定。
> 判定不依赖行号，依赖「本轮 diff 是否包含调用点行」的 grep 证据（见 §5-D）。

---

## 1. 验收结论总表

| 验收项 | 结论 | 证据 |
| --- | --- | --- |
| `git diff origin/cursor/0824-cde6 -- hooks.rs` 只有第 1 轮 P8 | ✅ 确认 | §2 |
| hooks.rs 第 2 轮（工作区 vs HEAD）零改动 | ✅ 确认（diff 0 行） | §2 |
| `default_pipeline_hooks` ApprovalGateHook 首位 | ✅ 确认 | §3 |
| 十五段准入序列未被触及 | ✅ 确认 | §3 |
| TOCTOU 三段完整（入口 Kill Switch / 审批后复核 / tool_loop 执行前终检） | ✅ 确认 | §4 |
| tool_loop.rs 四个 hooks 调用点控制流未被改动 | ✅ 确认（仅行号下移） | §5 |
| multi_variant.rs 不绕过 ApprovalGateHook | ✅ 确认（走 `execute_tool_calls` → `execute_single_tool`） | §6 |

无翻案项。

---

## 2. hooks.rs：第 2 轮零改动，基线差异全部属于第 1 轮 P8

工作区 hooks.rs 相对 HEAD **零差异**；相对基线的全部 102 行差异来自唯一提交
`167eb104`（第 1 轮 P8）：

```
$ git diff HEAD -- src-tauri/src/chat_v2/pipeline/hooks.rs | wc -l
0
$ git log --oneline origin/cursor/0824-cde6..HEAD -- src-tauri/src/chat_v2/pipeline/hooks.rs
167eb104 feat(wave2-A): land P8 hooks hygiene and close round-1 ledger
$ git diff origin/cursor/0824-cde6 --stat -- src-tauri/src/chat_v2/pipeline/hooks.rs
 src-tauri/src/chat_v2/pipeline/hooks.rs | 102 ++++++++++++++++++++++++--------
```

逐段核对基线 diff 内容，均在 `r1-hooks-p8.md` 声明的 P8 范围内：

1. 删除只写字段 `ToolAdmission.approval_arguments`（字段定义、`new()` 初始化、
   `before_tool` 末尾赋值三处；`new(_arguments)` 签名保留兼容 `tool_loop.rs` 调用点）；
2. 模块级/`default_pipeline_hooks` 文档注释强化（准入先于审计的字段依赖说明）；
3. `PipelineHook` trait 四切点失败语义文档化；
4. 两个同构 `tokio::select!` 等待器收敛为 `wait_oneshot_with_optional_cancel`
   （P8 文档 §4，`request_tool_approval` / `request_plan_gate` 业务分支不变）；
5. 新增测试 `audit_consumed_admission_fields_start_fail_closed` 及
   `default_hooks_keep_approval_gate_first` 的注释强化。

**无任何第 2 轮（prefix generation / schema digest / ToolFaceBaseline）相关内容混入。**

---

## 3. 准入序列：ApprovalGateHook 首位 + 十五段完整

`default_pipeline_hooks` 保持 ApprovalGateHook 首位（顺序由测试
`default_hooks_keep_approval_gate_first` 锁定，hooks.rs:1517）：

```159:164:src-tauri/src/chat_v2/pipeline/hooks.rs
pub(crate) fn default_pipeline_hooks() -> Arc<Vec<Arc<dyn PipelineHook>>> {
    Arc::new(vec![
        Arc::new(ApprovalGateHook) as Arc<dyn PipelineHook>,
        Arc::new(TaskAuditHook) as Arc<dyn PipelineHook>,
    ])
}
```

`ApprovalGateHook::before_tool`（hooks.rs:254-967）十五段准入逐段核对，顺序与
基线一致（本轮零改动，行号即当前行号）：

| # | 段 | hooks.rs 行 |
| --- | --- | --- |
| 1 | Kill Switch 入口（先于一切 Ask/Plan/Craft） | 279-329 |
| 2 | 运行时执行 allowlist | 334-352 |
| 3 | trusted automation profile 工具调用校验 | 353-364 |
| 4 | memory 功能开关 | 375-379 |
| 5 | RAG 功能开关（含 unified/multimodal_search） | 380-384 |
| 6 | WebSearch 功能开关 | 385-389 |
| 7 | 不可覆盖灾难命令守卫 Deny（仅后端本地 shell） | 399-410 |
| 8 | 用户 shell 命令规则 Deny | 414-444 |
| 9 | 本地终端审批作用域绑定（后端解析 root，绑定预期 scope key） | 449-471 |
| 10 | 敏感度解析（基础 + 规则升级 + 命令规则套用） | 474-495 |
| 11 | AuthorityGate Ask/Plan/Craft（Ask 拦截 / Plan gate 等待） | 497-621 |
| 12 | 审批要求判定 + trusted automation 预授权旁路（fail-closed） | 623-693 |
| 13 | ApprovalManager 人工审批 / session remember（缺管理器 fail-closed） | 696-823 |
| 14 | 审批后 runtime-root 绑定复核（重解析比对 binding + scope key） | 824-859 |
| 15 | 执行前 TOCTOU 复核段（Kill Switch 二检 / 取消令牌 / 权限复核 / Plan 原子消费） | 861-955 |

准入证据写入 `ToolAdmission`（957-965）后 `Proceed`。第 2 轮工作区四个文件的
diff 中不含以上任何一段（grep 证据见 §5-D、§6）。

---

## 4. TOCTOU 三段：全部在位

**第一段 — 入口 Kill Switch**（hooks.rs:279-329）：`before_tool` 第一个检查，
`kill_switch.ensure_allowed()` 失败即 Block，先于授权/审批。

**第二段 — 审批后复核**（hooks.rs:824-955）：plan gate / 人工审批可能长时间等待
用户，等待期间的紧急停止与模式变更必须生效。复核依次为：

- runtime-root 绑定重解析比对（824-859，binding 或 scope key 变化 → 要求重审批）；
- Kill Switch 二检（864-868）；
- cancellation token 检查（869-873）；
- 会话权限重读 + `requires_tool_approval` 重判（874-913，策略收紧且未满足 → Block）；
- AuthorityGate 重评 + Plan 批准原子消费（914-955，`consume_session_plan_binding`
  失败/不匹配 → Block）。

**第三段 — tool_loop 执行前终检**（tool_loop.rs:3336-3351 快照行号）：位于
`before_tool` 链放行之后、`ExecutionContext` 构建（含 Plan 消费后的上下文装配）
之后、`executor_registry.execute`（:3354）之前：

```3348:3363:src-tauri/src/chat_v2/pipeline/tool_loop.rs
        // Final admission point: Plan consumption/context construction above
        // must not leave a window where emergency stop can still start effects.
        if let Some(kill_switch) = &self.kill_switch {
            if let Err(message) = kill_switch.ensure_allowed() {
                return Ok(preflight_blocked_result(&hook_ctx, message));
            }
        }
        if cancellation_token
            .as_ref()
            .is_some_and(|token| token.is_cancelled())
        {
            return Ok(preflight_blocked_result(
                &hook_ctx,
                "流已取消，工具执行中止".to_string(),
            ));
        }
```

（注：上方引用块行号取自审阅时另一次读取快照 3348-3363，与 §5-C grep 快照
3336-3351 的偏差即并行写入导致的漂移，内容一致。）

三段均不在本轮任何 diff hunk 内。

---

## 5. tool_loop.rs：调用点仅行号下移，控制流未变

**A. 当前调用点快照**（审阅时刻）：

```
$ rg -n "hook\.before_turn|hook\.before_compaction|ToolAdmission::new\(&tool_call|hook\.before_tool|hook\.after_tool|Final admission point|executor_registry\.execute\(tool_call" src-tauri/src/chat_v2/pipeline/tool_loop.rs
412:                hook.before_turn(self, ctx, recursion_depth).await?;
534:                    hook.before_compaction(self, ctx, recursion_depth).await;
3276:        let mut admission = ToolAdmission::new(&tool_call.arguments);
3278:            match hook.before_tool(self, &hook_ctx, &mut admission).await {
3336:        // Final admission point: ...
3354:        match self.executor_registry.execute(tool_call, &ctx).await {
3359:                    hook.after_tool(self, &hook_ctx, &admission, &mut result)
```

HEAD 版本对应行号为 346 / 468 / 3189 / 3191 / （终检段） / （executor） / 3272 ——
本轮在 `execute_with_tools` 头部与 freeze 段插入代码导致**整体下移**，调用点
代码本身逐字节未变。

**B. 本轮 diff hunk 位置**（4 个，全部在工具面数据层）：

```
$ git diff HEAD -- src-tauri/src/chat_v2/pipeline/tool_loop.rs | rg "^@@"
@@ -102,6 +102,9 @@   merge_frozen_tool_schema_order_baseline 文档注释
@@ -131,6 +134,59 @@  新增纯函数 tool_schema_digest / freeze_tool_face_for_prompt_cache
@@ -322,13 +378,23 @@ execute_with_tools 头部：基线加载改走 load_session_tool_face_prefix
@@ -982,13 +1048,34 @@ freeze 段：digest 计算 + 变更日志 + 写回
```

四个 hunk 均在 `execute_with_tools` 的 tools 前缀冻结数据层：
`before_turn`（:412）在 hunk 3（结束于 ~:401）之后、hunk 4（起于 ~:1048）之前，
未被触及；`execute_single_tool`（:3237 起，含 before_tool / 终检 / after_tool）
完全在所有 hunk 之外。

**C. 新增代码无控制流逃逸**：hunk 2 的两个新纯函数只有函数内部 early return；
hunk 3/4 的环内新增代码为局部变量赋值 + `log::info!`，**无** `return` /
`continue` / `break` / `?`，不可能截断工具环或跳过任何 hook 调用。

**D. 本轮 diff 不含任何 hook / 准入相关行**：

```
$ git diff HEAD -- src-tauri/src/chat_v2/pipeline/tool_loop.rs | rg -c "hook\.|ToolAdmission|ToolGateOutcome|kill_switch|Final admission"
0 (无匹配)
```

**结论：tool_loop 调用点未被意外改控制流，仅行号下移。**

---

## 6. multi_variant.rs：不绕过 ApprovalGateHook

**工具执行入口不变**：变体环工具执行仍唯一走 `execute_tool_calls`
（multi_variant.rs:1605 快照行号）→ `execute_single_tool_with_transient_retry`
（tool_loop.rs:2940+）→ `execute_single_tool`（tool_loop.rs:3237+），
即每个变体的每次工具调用都完整经过 `before_tool` 十五段准入 + `after_tool` 审计
+ 执行前终检。本轮 diff 不含任何 hook / 准入相关内容：

```
$ git diff HEAD -- src-tauri/src/chat_v2/pipeline/multi_variant.rs | rg -c "before_tool|after_tool|ApprovalGate|TaskAudit|kill_switch|ToolAdmission"
0 (无匹配)
```

本轮 multi_variant.rs 改动全部是工具面前缀代际（方案 A）数据流：fan-out 入口
统一快照 `ToolFaceBaseline`（Arc 分发）、变体环内只推本地 `frozen_tool_schema_order`
克隆（删除两处中途 `store_session_frozen_tool_schema_order` 写回）、变体结束写
`VariantMeta.tool_face_prefix`、join 后 `converge_session_tool_face_prefix` 收敛。
删除的两处中途写回是**会话级缓存写操作**，不在准入路径上；变体内
`hooks_guard` / `registered_hooks` 是 `LLMStreamHooks`（流事件钩子），与
`PipelineHook` 无关。

**既有已知差异（非本轮回归）**：变体环自带循环，不调用 `PipelineHook::before_turn`
/ `before_compaction`（基线 `origin/cursor/0824-cde6` 上 grep 同样无匹配）。这两个
切点是审计日志性质（TaskAuditHook），不承担准入；准入切点 `before_tool` /
`after_tool` 多变体路径完整覆盖。维持基线现状，不构成翻案。

---

## 7. 附带核对

- `pipeline.rs` 本轮改动仅 `frozen_tool_schema_orders` 值型
  `Vec<String>` → `helpers::ToolFaceBaseline` 及注释（+23/-x 行），单锁结构不变，
  与 hooks 无交集。
- `helpers.rs` 本轮 +174/-30 行为 `ToolFaceBaseline` / load / converge / 持久化
  三键（`frozenToolSchemaOrder` + `toolFacePrefixGeneration` + `toolSchemaDigest`），
  diff 中 grep `hook|Hook|admission|Admission|approval|Approval|kill|Kill`
  为 0 匹配。
- hooks.rs 顺序锁测试 `default_hooks_keep_approval_gate_first`（:1517）与
  fail-closed 初值测试 `audit_consumed_admission_fields_start_fail_closed`
  （:1531）在位未动。

## 8. 最终判定

**确认。** 第 2 轮改动（prefix generation / schema digest / ToolFaceBaseline
数据层）完全不触及 hooks 准入序列与 TOCTOU 三段：hooks.rs 本轮零改动且相对
基线只有第 1 轮 P8 提交 `167eb104`；tool_loop.rs 四个 hook 调用点与执行前终检
仅行号下移、控制流逐字节不变；multi_variant.rs 工具执行仍全量经过
ApprovalGateHook，删除的中途写回不在准入路径上。

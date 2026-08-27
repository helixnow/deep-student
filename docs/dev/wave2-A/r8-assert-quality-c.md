# Wave2-A 第 8 轮 #9：断言质量静态复核 C

- 模型：`gpt-5.6-sol-xhigh-fast`
- 基线：`cursor/0824-wave2-agent-cache-a875` @ `c1cde7e3`
- 范围：只复核
  `src-tauri/src/utils/model_special_tokens.rs` 与
  `src-tauri/src/chat_v2/pipeline/hooks.rs` 的内联 `#[cfg(test)]` 模块
- 方法：只做源码静态阅读与符号引用核对；**未运行测试、未构建、未格式化**
- 规模：`model_special_tokens` 17 条，`hooks` 6 条，共 23 条测试

## 1. 总结

| 套件 | 结论 | 主要依据 |
|---|---|---|
| `model_special_tokens` | **较强（A-）** | 17 条几乎都对完整输出做精确相等断言；正例、保守保留反例、任意分块、flush、Markdown、reset 和大块输入均有覆盖。主要缺口是公共 helper 把每次 `process` 输出与 `flush` 输出拼接后才断言，因而大部分测试不能锁定“及时流式发出”的时序合同；大块用例也只锁语义，不锁复杂度。 |
| `hooks` | **偏弱（C）** | 默认链顺序、准入初值和灾难命令分类三条有明确生产符号锚点；但其余 3 条所谓“缺 ApprovalManager 时 fail-closed”测试只调用仅供测试使用的 `approval_manager_required`。该 helper 在产品路径无调用，且其断言与前一条 `sensitivity != Low` 逻辑重复，因此真实 `ApprovalGateHook::before_tool` 即使错误放行，这 3 条仍可全绿。 |

最需要修复的不是断言写法，而是 `hooks` 的**生产路径耦合**：测试名声称验证
“无审批管理器时拦截”，实际只验证“若敏感度不是 Low，则一个测试旁路 helper
返回 true”。

## 2. `model_special_tokens` 断言质量

### 2.1 强项

1. **oracle 精确，几乎没有宽松匹配。**  
   `filter_chunks`（`:628-636`）统一收集所有 `process` 返回值并追加 `flush`；
   各用例使用 `assert_eq!` 比较完整字符串，不使用 `contains`、只比长度或只断言
   “不 panic”。这能发现 token 泄漏、正文丢失、空白变化、顺序变化和重复输出。

2. **正反例成对，能约束“保守过滤”。**  
   - 删除：token-only 行、外层 wrapper、bare continuation header、流尾 closer；
   - 保留：正文中的字面 token、代码中的 token、非 bare role 行、后续仍有正文的
     mid-stream closer。  
   尤其 `strips_tail_glued_closer_followed_by_blank_lines_at_flush`
   与 `preserves_mid_stream_glued_closer_when_content_follows` 把“仅余空白”和
   “后来出现实质内容”两侧边界都钉住，反例质量高。

3. **分块回归不是只测 happy path。**  
   - `strips_torn_outer_wrappers` 把 token 从内部撕开；
   - continuation header 用例另做逐字符分块；
   - Markdown 用例对整段输入逐字符分块；
   - 大块输入同时比较单块与两个大块。  
   这些断言能抓到 prefix hold、跨 chunk 状态丢失、重复/漏发字节等错误。

4. **空白和 Markdown 断言是逐字节敏感的。**  
   尾部空格、单/双空行、空白行、围栏、行内代码和未配对反引号均通过完整字符串
   比较，换行是否被吞掉也在 oracle 内，不只是检查 token 是否消失。

5. **循环用例有诊断上下文。**  
   `strips_continuation_header_for_all_known_roles` 为失败附带 `role: {role}`；
   大多数其他失败由 `assert_eq!` 自带左右值 diff，诊断性足够。

### 2.2 逐组评价

| 测试/组 | 质量 | 静态判断 |
|---|---|---|
| `policy_is_limited_to_glm_and_qwen_routes` | B | 精确断言三个启用样例和一个禁用样例，但没有把 provider type、provider scope、model 三个判定来源隔离成正交表；例如当前 `siliconflow + Qwen` 样例只证明 model 命中，不能证明 scope 判定。别名、大小写/空白、`qwq/qvq` 和近似名称误命中也未钉。 |
| `disabled_policy_preserves_even_a_token_only_stream` | A- | 同时钉 `process` 原样返回和 `flush` 空返回，直接观察增量 API；样例只有单块，但合同明确。 |
| token-only / torn outer wrapper 两条 | A | 完整输出、残留行、跨 token 内部分块和两种 wrapper family 均有实质断言。 |
| prose / inline / fenced code 两条 | A | 删除规则的关键保守反例；Markdown 还逐字符喂入，能暴露状态机边界错误。 |
| `reset_discards_partial_candidate_from_failed_attempt` | B+ | 真正观察 reset 前后的 `process`，但只覆盖 incomplete-token 状态；未证明 reset 同时清掉已开 wrapper、inline/fence、role suffix、tail hold 等其他状态。 |
| continuation header 五条 | A | 覆盖正文后、流头、flush、尾随空白、三种 role、配对 closer 及多个非 header 反例；输出均全等。 |
| tail-glued closer 三条 | A | flush 删除、空白保留、多个 closer、跨空行继续 hold、实质内容到来后原样释放均有精确 oracle。 |
| unpaired backtick | A | 回归原因与同一测试中的正常 inline-code 对照明确，避免只修一侧。 |
| `large_single_chunk_keeps_semantics_with_cursor_consumption` | B+ | 对 2,000 行内容做完整相等，并比较单块/双块，语义回归能力强；但它不会使 O(n²) 前端 drain 实现必然失败，所以只能证明 cursor 改写的语义，不能充当复杂度回归测试。测试名使用 “keeps semantics” 是诚实的。 |

### 2.3 仍可全绿的错误实现

1. **把正常输出长期缓存到 `flush`。**  
   除 disabled 和 reset 等少数用例外，公共 `filter_chunks` 只比较
   `process(...) + flush()` 的最终拼接。一个在 `process` 中过度缓存、到 flush
   才一次吐出相同全文的实现，可能让绝大多数用例继续全绿，却破坏模块注释声明的
   正常文本即时流式输出。

2. **复杂度退回 O(n²)。**  
   大块测试无时间、操作次数或结构约束；只要最终字节正确，逐字符 front-drain
   也能通过。

3. **只在未覆盖的分割点损坏。**  
   当前有几个高价值撕裂样例，但没有对每个 special token 的所有合法 UTF-8
   分割点做系统化 partition-invariance 表。某一 token 或 marker 的特定边界仍可漏测。

4. **reset 只清 incomplete prefix。**  
   现有 reset 测试无法发现其他状态字段未清造成的下一次尝试污染。

### 2.4 建议补强

- 增加增量 trace 断言：逐次比较每个 `process` 的返回值和最终 `flush`，至少覆盖
  普通正文即时发出、疑似 token prefix 暂存、确认是字面量后立即释放、tail closer
  在后续正文到来时按原顺序释放。
- 表驱动枚举 `MODEL_SPECIAL_TOKENS`，对每个 token 的每个 char boundary 比较
  单块基准与两块/逐字符结果，避免只抽样几个 token。
- reset 分别从 open wrapper、fenced code、inline code、role suffix、tail hold
  状态切断，再喂同一正常回答，断言与 fresh filter 完全一致。
- 性能合同不要用易抖动 wall-clock 单测；若必须防 O(n²) 回归，使用 benchmark、
  可计数的消费原语或独立性能门槛。现有大块测试继续保留为语义测试即可。

## 3. `hooks` 断言质量

### 3.1 三条有生产锚点的测试

| 测试 | 质量 | 静态判断 |
|---|---|---|
| `default_hooks_keep_approval_gate_first` | A- | 对完整 hook 名称向量做精确相等，因而同时锁住顺序、数量和默认注册项，比只断言 first 更强。它只锁注册表形状，不证明相应 hook 行为，符合该测试本身的窄目标。 |
| `audit_consumed_admission_fields_start_fail_closed` | B+ | 直接构造生产 `ToolAdmission`，精确检查审计消费的三个字段初值；能防伪造初始准入证据。但没有调用 `TaskAuditHook::after_tool`，所以字段即使不再被审计消费、JSON 注记丢失，测试仍绿。 |
| `catastrophe_guard_is_wired_only_to_backend_local_shell` | B+ | 直接打生产分类 helper；本地 `rm -rf /` 必须得到 `Deny`，同名 external MCP 必须为 `None`，正反边界清楚。测试未进入 `ApprovalGateHook::before_tool`，不能证明 Deny 最终变成 `ToolGateOutcome::Block`，名称中的 “wired” 略强于实际覆盖。 |

### 3.2 三条 fail-closed 测试存在断言脱靶

`approval_manager_required` 定义于 `hooks.rs:1075-1077`：

```rust
fn approval_manager_required(sensitivity: Option<ToolSensitivity>) -> bool {
    sensitivity != Some(ToolSensitivity::Low)
}
```

静态引用核对显示，它只在本测试模块的 `:1566-1569`、`:1615`、`:1620`、
`:1723`、`:1739` 被调用，**真实 `ApprovalGateHook::before_tool` 不调用它**。
因此：

| 测试 | 质量 | 问题 |
|---|---|---|
| `missing_approval_manager_is_fail_closed_for_non_low_sensitivity` | D | 只验证上述一行纯函数的 truth table；没有 pipeline、没有缺失的 ApprovalManager、没有 `ToolGateOutcome`，也没有 executor 零调用断言。测试名声称的行为完全未执行。 |
| `phase9_non_low_tools_enter_the_fail_closed_approval_path` | D | 生产耦合只到各 executor 的 `sensitivity_level`。先 `assert_ne!(sensitivity, Low)`，再断言 `approval_manager_required(Some(sensitivity))`；对三值 enum 而言后一个断言是前一个断言的逻辑重复，并未证明进入审批路径。 |
| `phase2_phase3_and_phase8_non_low_tools_fail_closed_without_approval_manager` | D | 与上一条相同；长工具清单有分类清册价值，但 “fail closed without manager” 部分仍由测试专用 helper 自证。Low 对照也只是同一谓词的反面。 |

这不是单纯“覆盖不够”，而是明显的**假阳性通道**：删除或反转
`before_tool` 中“`approval_required && approval_manager.is_none()` 时 Block”的生产分支，
上述三条仍可全部通过。

### 3.3 hooks 测试当前没有锁住的核心行为

- 没有一条测试实际调用 `ApprovalGateHook::before_tool`；
- 没有断言 Medium / High / unknown sensitivity 且 ApprovalManager 缺失时返回
  `ToolGateOutcome::Block`；
- 没有 Low 工具在相同 fixture 下 `Proceed` 的控制组；
- 没有计数 executor 证明被拦截调用的执行次数为 0；
- 没有调用 `TaskAuditHook::after_tool` 验证 external MCP security boundary 与
  trusted automation 标记的精确 JSON；
- 没有测试审批等待 helper 的 response / channel-close / timeout / cancellation
  四种结果；
- 默认链测试按 hook 的 `name()` 判型，若未来错误实现仍返回同名，顺序测试本身
  无法识别；需要行为测试与之互补，而不是削弱现有精确向量断言。

### 3.4 建议补强

1. 用最小 pipeline fixture 直打 `ApprovalGateHook::before_tool`；至少做
   Low / Medium / High / unknown 四档，在 `approval_manager=None` 下精确断言
   `Proceed` 或 `Block`，并核对错误文本/结构。
2. 若已有真实 `execute_single_tool` fixture，增加 counting executor，断言
   非 Low 且审批服务缺失时 `calls == 0`。这才与三个测试名中的 fail-closed
   合同一致。
3. 保留 Phase 2/3/8/9 工具表作为**敏感度分类测试**，但删除逻辑重复的
   `approval_manager_required` 断言，或把测试改名为
   `phase*_tool_sensitivities_are_non_low`；审批路径另由真实行为测试负责。
4. 直打 `TaskAuditHook::after_tool`：对 external/non-external、Craft
   FullAccess/其他 preset、trusted preauthorized true/false、object/non-object
   output 建表，比较完整 JSON，证明准入字段确实被消费。
5. 灾难命令用例增加 through-hook 断言：本地命令得到 `Block`，external MCP
   不被**本地**灾难守卫冒充保护；后者仍应由其自身审批策略决定，避免把
   “不受本地 guard”误写成“应放行”。

## 4. 优先级

1. **P0：替换 hooks 的测试专用 fail-closed oracle。**  
   三条 D 级测试当前会提供错误安全感；先建立真实 `before_tool` /
   `execute_single_tool` 拦截证据。
2. **P1：给 token filter 增加逐次输出 trace。**  
   现有最终字节 oracle 很强，但流式时序是其最大盲区。
3. **P1：补 `TaskAuditHook::after_tool` 行为测试。**  
   当前只锁字段初值与默认顺序，没有锁最终审计产物。
4. **P2：系统化 token 分割矩阵与完整 reset 状态矩阵。**

## 5. 验证状态

本报告所有“应通过/仍可能通过”均为源码静态推演。遵照任务要求，本席没有执行
任何测试或构建命令；也没有修改上述两个 Rust 文件。

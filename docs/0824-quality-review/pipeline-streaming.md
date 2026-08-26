# Deep Student 0824 pipeline hooks / 流式字节层 / 特殊 token 深评

对照 `v0.9.44`（`1cf6cabc`）→ `origin/cursor/0824-cde6 @ 2d41ea8b`；本枝产品代码与 `2d41ea8b` 零差异，下文行号按当前树引用。Chat/Composer 总评见 `chat-composer.md`，它对本块已有结论（hooks 迁移等价 + 修在售 bug、字节层修复真实、过滤器召回缺口两处）。本文不复写聊天面，只做这一块本身的深读：对总评的关键裁决逐一独立复核（确认三处、修正一处），并补充六个总评未触及的发现。判断方法是源码静态阅读 + 与 v0.9.44 的逐检查点对照 + 提交历史回溯；按任务约定未跑编译与门禁。

## 结论

**hooks 迁移与 Responses 流式增强够 PASS 标准；字节层与 special-token 过滤器要各降半档。**两处降档的性质相同：改动本身无害甚至有益，但**提交所声称的"修好了什么"与代码实际能修什么之间有缺口**——

1. issue #122（聊天乱码）的修复接错了层：被替换的 v0.9.44 实现**构造上产生不了**提交信息所描述的故障模式，该 issue 至今仍 OPEN，真实病灶未定位；
2. special-token 过滤器对 stop-token 失效的**最高频泄漏形态（`<|im_start|>assistant` 续写头）清理是半截的**，比总评已指出的尾粘 closer 更常见。

这两条都不是回退，用户可见行为不劣于 v0.9.44。但如果把它们记账为"已修复"，下次同症状复发会浪费一整轮重新诊断。

## 一、hooks 迁移：独立复核通过，补三个设计层面的问题

### 1.1 等价性与修复，独立确认

我把 v0.9.44 `execute_single_tool`（2809–3745 行）的内联准入序列与 `ApprovalGateHook::before_tool` 逐检查点对照：Kill Switch → 运行时 allowlist → trusted automation 校验 → memory/RAG/WebSearch 开关 → 灾难命令守卫（仅 backend local shell，HOME 兜底 root）→ 用户命令规则 → 审批作用域绑定 → 敏感度解析 → AuthorityGate/plan_gate → trusted-automation 旁路 → ApprovalManager（remembered → 请求-等待）→ runtime-root 重绑定复核 → kill-switch/取消复查 → authority 复查 → plan binding 原子消费，共十五段，顺序、日志文案、事件 payload、fail-closed 分支全部一致；executor `Ok` 后的 external-MCP 审计与 trusted-automation 标记同样逐字对应 `TaskAuditHook::after_tool`。唯一语义差异就是执行前复核补了 plan binding 重验（v0.9.44 该处裸调 `requires_tool_approval`，对 plan 批准的写工具必然误拦）：

```880:893:src-tauri/src/chat_v2/pipeline/hooks.rs
        let current_approval_required = !current_plan_binding_covers_tool_approval
            && super::authority_mode::requires_tool_approval(
                &current_authority,
                sensitivity,
                effective_sensitivity,
                immutable_guard_asks,
                is_external_mcp,
                privilege_escalation,
            );
        if current_approval_required && !approval_requirement_satisfied {
            return ToolGateOutcome::Block(build_preflight_blocked_result(
                "会话审批策略在执行前发生变化，当前调用需要重新审批".to_string(),
            ));
        }
```

总评"修的是 v0.9.44 在售 bug 而非迁移回归"的判断成立（v0.9.44 源码 `tool_loop.rs` 提取后第 705 行可复核）。配套测试是真集成路径而非 helper 单测：`approved_plan_binding_reaches_executor_without_secondary_approval` 断言 executor 恰好调用 1 次且 binding 在执行前被消费（`tool_loop.rs:4668-4706`），`missing_approval_manager_blocks_required_tool_before_executor` 断言 executor 0 次调用 + 中文 fail-closed 文案（`tool_loop.rs:4709-4742`）；这类测试**只有在 hook 化之后才可能写**——旧内联版无法注入 `approval_manager = None` 的 pipeline 走真实 `execute_single_tool`。可测性收益是这次抽取最实的回报。多变体路径经 `execute_tool_calls → execute_single_tool` 同走 hook 链（`multi_variant.rs:1560`），无旁路；hook Proceed 后 tool_loop 保留 ExecutionContext 构建完成处的最终 kill-switch/取消检查（`tool_loop.rs:3249-3264`），TOCTOU 窗口与迁移前相同。

### 1.2 新发现：两个内置 hook 的"独立性"是假的

`TaskAuditHook::after_tool` 的全部判断依赖 `ToolAdmission` 里由 `ApprovalGateHook` 填写的私有字段（`authority_admission` / `is_external_mcp` / `trusted_automation_preauthorized`，`hooks.rs:984-1035`）。若 ApprovalGateHook 未运行，`ToolAdmission::new` 的默认值让 external-MCP 审计与预授权标记**静默不落**——不是安全失效（工具照样直通，这是文档写明的"零钩子=无准入门"理论态），而是审计失效，且没有任何日志提示审计被跳过。两个"hook"实际是共享隐式状态的固定两段序列，trait 表面暗示的可独立注册性并不存在。`default_hooks_keep_approval_gate_first` 锁了顺序算部分缓解，但建议在 `TaskAuditHook` 文档或断言里显式声明"依赖 approval_gate 的 admission 产出"，防止后续有人单独复用它。

### 1.3 新发现：`ToolAdmission.approval_arguments` 是只写字段

`ToolAdmission::new` 对每次工具调用 clone 一份 `arguments` 初始化该字段（`hooks.rs:57`），`ApprovalGateHook` 末尾再赋值为 scope 绑定后的版本（`hooks.rs:937`），此后**全库无任何读取方**——tool_loop 零引用，`after_tool` 不消费，对外只暴露 `shell_guard_admitted()` 与 `authority_admission()` 两个派生。这是按"未来 hook 可能要用"预留的搬运重量：多一次每调用 clone，多一个让读者以为 executor 会拿到改写参数的误导面（实际注释明确 executor 只收原始 ToolCall）。建议删字段，等真有消费方再加。

### 1.4 新发现：切点错误语义不对称，扩展纪律没写下来

`before_turn` 返回 `ChatV2Result<()>` 且调用处 `?` 直接传播（`tool_loop.rs:345-347`）——追加 hook 若在此 Err，整个 send 以管线错误终止，没有工具级/回合级的用户可读事件；而 `before_compaction`、`after_tool` 是不可失败签名，`before_tool` 有结构化的 Block 通道。当前两个内置 hook 从不 Err，所以无现实行为，但 trait 是 `pub(crate)` 敞口，这种"哪个切点允许失败、失败落到用户哪里"的差异只存在于实现里。WI-13 文档§5 还计划把 live workspace injection 迁进 `before_turn`——届时这个不对称就会变成真实决策。建议在 trait 文档写明各切点的失败语义，或统一为不可失败 + Block 通道。

### 1.5 结构评价

`hooks.rs` 现在 1694 行，同时装着 trait、两个内置 hook、审批等待协议（`request_tool_approval` / `request_plan_gate` 各约 160 行）和 scope 绑定 helper；`before_tool` 是单个 700 行方法。抽取让 `tool_loop.rs` 从 5507 减到 4171 行，但复杂度是被移动而不是被消解——这个判断总评已下（"一个使用方的框架"），我补充的量化风险是：下一刀若继续把横切逻辑塞进本文件，hooks.rs 会复刻 tool_loop 的巨石问题。等待协议（两个 `tokio::select!` 等待器结构完全同构）适合先在文件内收敛为一个泛型等待函数再谈新增切点。

## 二、流式字节层：改动无害，但 issue #122 的层位诊断不成立

### 2.1 关键证据链

`bb5a98bb`（"fix(llm): wire Utf8StreamDecoder into SSE byte-chunk decoding (#122)"）声称：多字节字符被 TCP 分帧切断后会被 lossy 解码成 U+FFFD，现在改为增量解码。但对 v0.9.44 实现的复核表明**旧代码产生不了这个故障**：

- v0.9.44 `SseEventBuffer` 缓冲原始字节、按 `0x0A` 字节扫描切行、只对完整行做严格 `from_utf8`（失败才 lossy 并 warn）。UTF-8 连续字节域为 `0x80-0xBF`、多字节前导 `≥0xC2`，`0x0A` 不可能出现在多字节序列内部——行完成时该行的所有字符必然完整，跨 chunk 切断的字符只会推迟行完成，不会被解码。
- 六条流式管线（model2、翻译、作文/题库评分、Anki、VLM grounding）在 v0.9.44 就全部走 `process_bytes` 原始字节入口（逐一核对，如 `streaming_anki_service.rs` v0.9.44 第 921 行）；全库 grep 无任何逐 chunk `from_utf8_lossy` 前置解码。MCP 传输走 `reqwest_eventsource` 库内解析，也不在此故障面上。
- `Utf8StreamDecoder` 在 v0.9.44 是零引用死代码（仅 `pub mod` 声明）。

即：这次改动把一个死模块接进了一个本来就没有该 bug 的缓冲器。改动后行为与旧实现在切分字符、非法字节、截断 flush 三种场景下**逐一等价**（新增的每字节切分点回归测试同样能在旧实现上通过）。作为架构收紧（解码集中一处、语义有测试锚定）它是净收益；作为 #122 的修复它不成立——该 issue（"正常聊天都会有乱码"）在 GitHub 上仍 OPEN，真实病灶（上游网关自己 lossy 重分帧、模型输出本身、或某个非 SSE 路径）没有被定位。**风险是记账错误**：症状复发时团队会从"已修过的层"重新排查。建议在 issue 上明确标注"该提交是防御性收紧，不是根因修复"，并向报告者要一次带 provider/模型信息的复现。

顺带一个小观测性退步：旧版对真非法字节有 "SSE event contained invalid UTF-8" 的 warn，新版静默替换。若要排查上游网关送坏字节（恰是 #122 的候选病灶），这条日志值得加回 `Utf8StreamDecoder` 的 invalid 分支。

### 2.2 其余字节层改动，方向都对

- `Utf8StreamDecoder` 本体实现正确：pending ≤3 字节由 UTF-8 规则保证，`error_len()` 区分 invalid/incomplete 准确，`decode` 无残留时借用零拷贝，flush 的 lossy 语义（"此时确实丢了数据"）文档清楚。溢出路径 `clear()` 保留（`sse_buffer.rs:176`）；`drain(..=newline)` 的字节索引落在 ASCII `\n` 上必是字符边界。
- Responses 流式增强是真实的正确性修复：reasoning item 从单值缓存改为 Vec 按流序相邻配对（`llm_adapter.rs:191-198` 注释直接写明"禁止把所有 item 绑到本批第一个 tool id"），配套 `tool_round_reasoning_items_pair_by_tool_call_id` 等配对/降级测试（`tool_loop.rs:4058-4110`）；`web_search_call` 完整 item 按 id 去重落库重放；variant 侧对 Responses 双 start 事件补了幂等（`variant_adapter.rs:488-498`）。
- 流终态错误归一化（`provider_stream_failure_message`，`model2_pipeline.rs:414-500`）把 `max_output_tokens` / `content_filter` / `response.incomplete` 等 reason 分类成用户可读中文并保留上游 message（截断防爆），生产接线于 SafetyBlocked → `terminal_failure`（`model2_pipeline.rs:5234`），四组分类测试齐。这是前端孤儿 preparing 块能显示真实原因（总评§3）的后端一半。
- `file_stream_protocol`（#59）：白名单包含判定统一复用 `pdf_protocol::path_is_within`（Windows `\\?\` verbatim 归一），`canonicalize` 失败保留原路径而非静默丢目录，隐藏段判定无法确定相对关系时 fail-closed，中文路径百分号编码回归测试。这是媒体文件流协议而非 LLM 字节层，但消除了两个协议对同一路径给出不同 403 判定的双标,方向正确。

## 三、special-token 过滤器：结构是对的，召回清单要按产品目标重算

过滤器的保守设计（只删外层包装/token 独占行/已删 opener 的配对 closer，代码块永放行）本身是对的取舍，误删率被压到极低且有负例测试锁定。政策路由双通道（provider 名 + 模型名词元级匹配，`model_special_tokens.rs:28-52`）核对无误：主环每轮按 `resolve_active_api_config` 解析（`tool_loop.rs:549-559`），变体按各自 `model_id` 解析（`multi_variant.rs:810/1188`），重试 `reset_stream_state` 重置过滤器,`finalize` 把过滤器尾巴先并回 think 缓冲再统一冲刷，事件流与落库同源。前端无平行清理逻辑，不存在双层清理相互作用。

总评已指出两处召回缺口（尾粘 `<|im_end|>`、流中段 box 对）与 reasoning 通道不过滤，复核均成立。需要补充的是缺口清单没列全,而漏掉的这条恰恰最常见：

### 3.1 新发现：`<|im_start|>assistant` 续写头整体漏出

stop-token 配置失效时的标准症状是模型冲过自己的回合继续生成：`…正文<|im_end|>\n<|im_start|>assistant\n继续的正文…`。逐段过一遍状态机：尾粘的 `<|im_end|>` 漏出（总评已述）；独占行的 `<|im_end|>` 能清；但 `<|im_start|>assistant` 这一行——token 位于行首进入候选，同行跟着 `assistant` 文字触发 `begin_literal_content`，此时 `stream_has_substantive_text` 已为真，`candidate_is_leading_wrapper` 不成立，token 与 "assistant" 一起原样放行（`model_special_tokens.rs:296-318`）。用户最终看到 `<|im_start|>assistant` 加一段本不该存在的续写。也就是说,对这个最高频故障,过滤器只清得掉三分之一（独占行的 closer），核心的续写头一个字符都清不掉。要覆盖它不需要放宽全局规则：`stream_has_substantive_text` 为真之后、行首候选 token 为 opener 且**紧跟已知角色词（`assistant` / `user` / `system`）+ 行尾**的组合，字面引用概率趋近于零，可以作为一条独立的窄规则。建议与总评提的 flush 尾粘启发式做成同一次改动，并把"清什么/不清什么"的完整矩阵写进文件头——现在的头注释只写了清什么。

### 3.2 新发现：单个未配对反引号让过滤器永久静默失效

`process_marker_run` 把任意宽度的反引号 run 当 inline code 开闸（`model_special_tokens.rs:282-288`），且**没有任何行边界重置**：CommonMark 的 inline code span 不跨段落，但这里一旦进入 `Inline{ticks:1}` 状态，只有等到同宽反引号 run 才退出。LLM 输出里孤立反引号并不罕见（截断、口语化标注），之后整个流的所有 token 都按代码字面量放行——过滤器对该消息剩余部分整段失效,无日志无痕迹。失效方向是安全的（保留而非误删），与保守哲学一致，但修复成本极低：`process_newline` 时若 `code` 是 `Inline` 则清除（CommonMark 语义本来如此,fenced 不受影响）。

### 3.3 新发现：覆盖边界与实现边角

- **覆盖边界是"chat 的两个适配器"而非"GLM/Qwen 的所有出口"。**翻译、作文/题库评分同样可选 GLM/Qwen 模型走流式管线，无任何等价清理；非流式统一出口 `call_unified_model_2`（knowledge_executor / RAG 内部问答用）也不过滤。这些面的泄漏影响低于聊天正文，但"同一个模型同一种泄漏，出现在聊天被清、出现在翻译不清"与 reasoning 通道那条是同一种无原则不一致，值得在下一轮统一挂接时一并盘点。Anki 的独立算法（丢纯 token 残片/剥完整卡 JSON 外包装）语义不同应保留，但两份 `MODEL_SPECIAL_TOKENS` 常量表就在同一个 crate 里（`utils/model_special_tokens.rs:8` 与 `streaming_anki_service.rs:45`），一个 `pub(crate)` 引用就能消除漂移面——总评记了维护税，实际修复比它评估的还便宜。
- **逐字符前缀 `drain` 是 O(n²)**（`consume_prefix`，`model_special_tokens.rs:206-208`）：每消费一个字符就整体前移剩余缓冲。SSE delta 小到无感，但任何一次性大 chunk（网关整段打包重发、未来非流式接入）会平方放大。改游标制或按 `\n` 批处理即可,低优先级。
- 前导包装剥离时保留候选行内空白（`begin_literal_content` 只滤出 whitespace 回填）,消息可能以一个空格开头；UI 渲染基本不可见,记录备查。

## 四、与 chat-composer 总评的差异汇总

确认：hooks 迁移等价性与 Plan 修复定性、三段式 TOCTOU 检查未变、`utf8_stream` 从死代码转正、过滤器接线位置与多变体按各自模型解析、尾粘 closer 与 box 对缺口、reasoning 通道不过滤。

修正/收紧两处：

1. 总评§3 称字节层"修复真实"——修复的**代码**真实,但作为 issue #122 的闭环不成立（§2.1 证据链），验收上应记为"防御性收紧 + 病灶未定位"，issue 保持 OPEN 是正确状态。
2. 总评把过滤器召回缺口概括为"有意取舍的残余风险"——对尾粘/box 对成立,但 `<|im_start|>assistant` 续写头（§3.1）不在负例测试记录的"有意保留"清单里,更像盲区而非取舍：它与已有测试 `preserves_literal_tokens_in_prose` 保护的场景（行内字面引用）在启发式上完全可分。

## 五、建议顺序

1. **issue #122 重新定性**：在 issue 上标注 bb5a98bb 为防御性改动，向报告者索取 provider/模型/是否中转的复现信息；给 `Utf8StreamDecoder` invalid 分支补回 warn 日志作为下次复发的定位探针。
2. **过滤器补两条窄规则一起做**：`<|im_start|>` + 角色词行（§3.1）、flush 尾粘 closer（总评 P2）；同时 `process_newline` 重置 inline-code 状态（§3.2）；文件头补"不清什么"矩阵。reasoning 通道挂独立过滤器实例可并入同一改动。
3. **hooks 卫生三小件**：删 `approval_arguments` 只写字段；`TaskAuditHook` 文档化对 approval_gate 产出的依赖；trait 文档写明各切点失败语义。均为小改,可在下一次触碰 hooks.rs 时顺手完成。
4. 共享 token 常量表（一行引用）；翻译/评分/非流式出口的过滤覆盖盘点放入下一轮统一流处理核心的范围（与总评建议 3 合并）。

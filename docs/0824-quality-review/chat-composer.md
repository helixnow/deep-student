# Deep Student 0824 Chat V2 / Composer / 流式 质量评审

对照范围：`v0.9.44`（tag @ `1cf6cabc`）→ `origin/cursor/0824-cde6 @ 2d41ea8b`。本枝（static-audit）相对基座产品代码零差异，实测 `git diff --stat 2d41ea8b..HEAD` 只有 docs。本文不是普查（普查见 `docs/0824-static-audit/01-chat-composer.md`），而是独立的改造质量判断：重点深读了 pipeline hooks 迁移、prompt-cache 冻结链、`model_special_tokens` 流式过滤器、SSE/UTF-8 字节层、前端适配器增量与 Composer 拆分，并对能跑的部分实际复跑了测试。

## 结论

**PASS，质量高于本轮多数主题面**。这块改造的共同特征是「字节级、并发级、降级路径」三件事都想在了前面，且关键裁决有注释、有测试把关。四个大动作（hooks 抽取、H cache 全链、流式字节修复、Composer 拆分）没有发现语义回退或坏合成；相反，hooks 迁移的收尾复查还顺手修掉了一个 v0.9.44 就在售的 Plan 模式误杀。剩余问题集中在三类：过滤器的召回缺口（有意取舍但有残余风险）、技能目录快照缺失效机制（有一个零成本的刷新点没用上）、以及双适配器/双 token 表这类平行实现的维护税。均不阻塞发布。

## 为什么这个结论站得住

### 1. hooks 迁移不是搬家，是搬家 + 修了一个在售 bug

`ApprovalGateHook::before_tool`（约 700 行）与 v0.9.44 `execute_single_tool` 的内联准入序列做归一化 diff 后，逐段等价：Kill Switch → 运行时 allowlist → trusted automation 校验 → 功能开关 → 灾难命令守卫 → 用户命令规则 → 审批作用域绑定 → AuthorityGate → ApprovalManager → 执行前复核，顺序与文案全部保持。真正的语义差异只有一处，而它是修复而不是回退：

v0.9.44 的执行前复核用裸 `requires_tool_approval` 判定（`git show v0.9.44:src-tauri/src/chat_v2/pipeline/tool_loop.rs` 第 3513/3521 行），而 Plan 模式下该函数对非 Low 工具恒返回需审批；plan gate 批准的调用因为跳过了 ApprovalManager，`approval_requirement_satisfied` 恒为 false——两者相与，**v0.9.44 里每一个经 plan gate 批准的写工具都会在复核处被「会话审批策略在执行前发生变化」误拦**。0824 在复核时把 plan binding 证据重新纳入：

```868:893:src-tauri/src/chat_v2/pipeline/hooks.rs
        // An approved Plan binding replaces the secondary tool approval for
        // this exact call. Re-evaluate that evidence together with the current
        // authority state; checking `requires_tool_approval` alone would reject
        // every valid Plan call before its binding can be atomically consumed.
        let current_plan_binding_covers_tool_approval =
            super::authority_mode::plan_binding_satisfies_tool_approval(
                &current_authority,
                &plan_binding_key,
                privilege_escalation,
                plan_gate_just_approved,
                chrono::Utc::now(),
            );
        let current_approval_required = !current_plan_binding_covers_tool_approval
            && super::authority_mode::requires_tool_approval(
                // ... 与首次判定相同的六参 ...
            );
        if current_approval_required && !approval_requirement_satisfied {
            return ToolGateOutcome::Block(build_preflight_blocked_result(
                "会话审批策略在执行前发生变化，当前调用需要重新审批".to_string(),
            ));
        }
```

修复出处是 `517dc9df`（WRAP-hooks-review.md 发现 4），同一提交还把 `ToolAdmission` 的安全证据字段私有化（防追加 hook 在审批闸后伪造 shell guard admission，`hooks.rs:36-52`）并加了 `default_hooks_keep_approval_gate_first` / `catastrophe_guard_is_wired_only_to_backend_local_shell` 两个顺序/接线锁测试（`hooks.rs:1480/1490`）。需要指出：WRAP 文档把这算作「迁移引入的回归」，但按 v0.9.44 源码它是存量 bug——迁移复查的净效果是**修好了 v0.9.44 发布版里的问题**，这对迁移质量是加分而非中性。

迁移后 TOCTOU 窗口也没有变大：hook 链拦截后，`tool_loop` 在 ExecutionContext 构建完成、executor 调用前仍保留最终 Kill Switch + 取消检查（`tool_loop.rs:3249-3264`），三段式检查（准入首查、审批等待后复查、spawn 前终查）与迁移前一致。

### 2. prompt-cache 链把「字节稳定」当成一等公民，且闭环是真的

这条链的难点不在单点，而在 live == replay 的一致性。三处关键设计都对：

- **system 只留稳定前缀**，turn-volatile（检索命中/画像/待办/Canvas）迁入当前 user 消息的 `<injected_context>`；而且 volatile 内容随 `compiled_current_user_message` 冻结并经 `llm_content` 落库（`context.rs:390-395`），下一轮历史回放的是同一字节——没有这一步，缓存前缀照样会在上一条 user 处断裂。这一点被 `prefix_snapshot_tests.rs:86-139` 用字节级断言锁住（system 跨轮逐字节相等 + 动态标签不得泄漏进 system + tools 序列化字节是后续轮次的严格前缀）。
- **tools 冻结分了三层**：会话级 append-only 名字序基线（经 session.metadata 持久化，重启后 provider 缓存仍可命中）、窗口级 schema 字节冻结（同名 schema 中途变化时本窗口继续发首见字节，`tool_loop.rs:89-131`）、并行变体写回用 append-only 合并保证单调（`helpers.rs:1038-1046`，锁外读库、entry 只补缺失名）。降级语义统一是「写库失败只打日志、绝不阻断发送」，方向正确。
- **provider 门控口径分得细**：`prompt_cache_key` 与 `prompt_cache_retention` 两个口径分开（后者只写官方 OpenAI 端点，第三方网关不写以防 400，`model2_pipeline.rs:3178-3196`）；后台任务无 session_id 时用固定串兜底、明令禁止随机 UUID（`model2_pipeline.rs:3163-3176`），这条注释直接点破了「随机 key 让路由亲和永远 0 命中」的坑。

`availableSkillsSnapshot` 的跨进程冻结（前端首次生成 → 后端 first-write-wins → 多窗口竞争用生效值回灌内存，`TauriAdapter.ts:5323-5340`）与上面同一哲学，闭环成立。它的失效问题见下文缺陷节。

### 3. 流式字节层与前端收尾：修复真实、增量克制

`SseEventBuffer` 从「字节缓冲 + 整行解码」改为「增量 UTF-8 解码 + 文本行切分」（`sse_buffer.rs:128/182`），配了「一个汉字拆两个 chunk 不得出现 U+FFFD」的锚点测试；flush 时对真被网络截断的半截字符按 lossy 补 U+FFFD 并注明「此时确实丢了数据，不是解码错误」——语义边界写得很清楚。

前端 `TauriAdapter.ts` 相对 v0.9.44 的增量只有约 75 行，全部是净改善：`completeStream('error')` 补传归一化终态错误，使孤儿 preparing 块显示后端真实原因而不是通用兜底文案（配合 `streamActions.ts:111-145` 的 reason 一致性处理——success 收尾移除未执行的 preparing 块、error 收尾优先展示传入错误）；写死英文的 `reconnect...(1/5)` 全局 toast 被整个删掉，重连状态改为消息级 meta（`TauriAdapter.ts:2319-2321`），可 i18n、随消息渲染，不再打断全局。

`model_special_tokens` 过滤器的接线位置也对：`on_content_chunk` 在 `<think>` 解析与 `accumulated_content` 累积**之前**过滤（`llm_adapter.rs:1116-1140`），事件流与落库内容同源；外层重试 `reset_stream_state` 会重置过滤器；主环与多变体各按本轮实际生效的 provider/model 解析策略（`tool_loop.rs:549-559`、`multi_variant.rs:810-820`），OpenAI 兼容中转跑 Qwen/GLM 也能命中。

### 4. Composer 拆分是诚实的受控组件拆分，行为收敛带了真测试

3919 行的 InputBarUI 拆出 ComposerToolbar（934）/ComposerTextarea（323）/AttachmentPanelBody（400）+ 三个 helper，检查结果：样式常量没有双份（`coarseHitAreaClass` 等只在 ComposerToolbar），子组件无隐藏 store 耦合（ComposerToolbar 自身只有菜单搜索词一个 `useState`），交互副作用全部回调上抛。散落六处的 `disabledSend` 收敛为 `computeSendAvailability` 单一出口（`sendAvailability.ts:53-76`），优先级显式、原因码可本地化，注释明确「与旧 sendBlockedReason 逐字一致」并为 empty/busy 补了新文案——这是拆分顺手还债的正确姿势。

本轮在此 VM 实测复跑了范围内 6 个测试文件共 43 个用例（`sendAvailability`、`InputBarUI.sendBlockedHint`、`mobileSplitContract`、`tauri.streamLifecycle`、`chatV2SendButtonContract`、`chatV2ComposerPanelTokensContract`），全部通过。

## 缺陷与风险

### P2 — wrap-token 过滤器对最常见的 stop-token 泄漏形态没有召回

过滤器的删除规则被刻意压到三种形态：流首外层包装、token 独占逻辑行、先前已删 opener 的配对 closer（`model_special_tokens.rs:1-6`）。这换来了极低的误删率（正文/代码块里字面引用 token 全部保留，有负例测试锁定），但代价是：

- **粘在正文尾部的 `<|im_end|>` / `<|endoftext|>` 不会被清理**。stop-token 配置失效时最常见的泄漏形态恰恰是 `…回答完毕<|im_end|>`（无换行直接粘尾）：此时行内已有正文，closer 没有已删 opener 配对，走 `process_token` 的 pass-through 分支（`model_special_tokens.rs:224-233`）原样漏出。
- **流中段的 `<|begin_of_box|>答案<|end_of_box|>`（同行有正文且流中已有实质文本）也整体漏出**——`begin_literal_content` 的 leading-wrapper 剥离以 `!stream_has_substantive_text` 为前提（`model_special_tokens.rs:296-305`）。

`preserves_literal_tokens_in_prose`（`model_special_tokens.rs:440-447`）表明「行尾字面 token 保留」是有意选择——泄漏与字面引用在这个位置确实无法区分。**但流 flush 时是可以区分的**：flush 时若最后一个非空白 span 恰是闭合类 token 且不在代码块内，是泄漏的概率远高于字面引用（用户正文极少以裸 `<|im_end|>` 收尾）。建议下一轮给 flush 加这条终态启发式，能以极小误删风险覆盖掉最高频的泄漏形态；同时建议在文件头把「不清什么」写进文档——现在的注释只写了清什么，后续维护者容易误以为覆盖是全量的。

### P2 — reasoning 通道完全不过滤，与 content 通道行为不一致

两个适配器的 `on_reasoning_chunk` 都直接透传（`llm_adapter.rs:1142-1176`、`variant_adapter.rs:451-473`），GLM/Qwen 经中转以原生 reasoning 字段回流时，泄漏 token 会原样进思维链 UI 并随 `accumulated_reasoning` 落库。危害低于正文（思维链默认折叠、不参与导出），但「同一模型同一泄漏，出现在 content 被清、出现在 reasoning 不清」是无原则的不一致。给 reasoning 通道挂同一个过滤器实例的成本很低（各自独立实例即可，注意不要与 content 共享行状态）。

### P2 — availableSkillsSnapshot 冻结无任何失效机制，有一个零成本刷新点没用

目录快照按 session 终身冻结（`progressiveDisclosure.ts:630-667`），设计动机（system 第 0 字节稳定）成立，但两个后果值得权衡：

1. 中途安装/启用的技能对已有会话**永久**不可发现——模型的技能发现完全依赖目录，不在目录里的技能连 `load_skills` 的 id 都无从得知。这不是「缓存窗口内的延迟」，是会话生命周期级的丢失，长寿会话（学习场景很常见）受影响最大。
2. 中途禁用/撤信任的技能描述字节仍随每轮 system 发出。执行会被 admission 拦住（安全性不破），但模型会持续尝试并收到失败结果，白烧轮次。

compaction 发生时历史前缀反正要重建，provider 缓存必然断——**这是刷新目录快照的零成本时机**，当前实现没有利用。建议在 compaction 落盘的同一事务里按 live registry 重生成快照并更新 metadata；不需要 TTL，也不破坏两次 compaction 之间的字节稳定。

### P3 — 平行实现的维护税（三处）

1. **双 token 表**：`MODEL_SPECIAL_TOKENS`（`utils/model_special_tokens.rs:8-14`）与 `streaming_anki_service.rs:41-51` 各一份。两处算法语义确实不同（流式包装过滤 vs 卡片正文保留），不能合并实现，但**常量表可以共享**——新增泄漏 token 时现在要记得改两处，漂移无任何机制兜底。
2. **双适配器**：`ChatV2LLMAdapter` 与 `VariantLLMAdapter` 平行维护 think 标签解析、wrap 过滤、args delta 节流、活动时间戳四套逻辑，0824 给两边各加了过滤器，使平行面更宽。#213 拆模动了 compaction/context_compiler，没动这块。将来任何流式修复都要写两遍、测两遍，建议下一轮抽公共 stream-processing 核心。
3. **hooks 抽象目前是「一个使用方的框架」**：默认链只有两个内置 hook，`before_tool` 是单个 700 行方法，trait 为 `pub(crate)` 且树内无生产扩展方。它换来的可测性（真实 `execute_single_tool` 路径的 fail-closed 测试）与证据封装是实打实的，但要警惕后续把更多横切逻辑「hook 化」变成纯搬家——本次 admission 字段私有化说明作者意识到了伪造风险，这个纪律需要保持。

### P3 — 源码 grep 型契约测试是脆闩

`InputBarUI.mobileSplitContract.source.test.ts:37-56` 断言的是源码里的 class 字符串（如 `[@media(pointer:coarse)]:!h-11` 出现次数 ≥5），不是渲染结果。作为合并期防拆分回退的结构闩是合理的便宜手段，但它锁的是「字符串还在」而非「热区真有 44px」，一次无害的 Tailwind 重构就会红，且红了不代表行为坏。建议保留所有权断言（ContextWindowUsageRing 归属、legacy 弃用），把尺寸类断言逐步换成 CT/渲染层校验。

## 未发现的问题（找过，没有）

审批准入在 `tool_loop` 无残留旁路副本；hook 链拦截路径不进 executor；`utf8_stream` 不是死代码（`SseEventBuffer` 内嵌，生产消费点覆盖全部 LLM 流式管线）；`<injected_context>` live/replay 字节不一致（已随消息落库闭环）；Composer 拆分无状态回流/双份常量；多变体的 wrap 策略按各自模型解析而非沿用主环模型；`frozen_tool_schema_orders`/`microcompact_anchors` 的并发合并无覆盖写。

## 验证情况

- 前端：本 VM 实测 `vitest run` 范围内 6 文件 43 用例全过（本文第 4 节列出清单）。
- Rust：本 VM 无法编译 `src-tauri`（build.rs 需要 `resources/pdfium/libpdfium.so`，环境未提供），`hooks.rs`/`tool_loop.rs`/`model_special_tokens.rs` 的判断基于静态阅读 + 与 v0.9.44 的归一化 diff；单测存在性均已核对（`model_special_tokens.rs:387-475`、`prefix_snapshot_tests.rs`、`hooks.rs:1480+`）。
- v0.9.44 Plan 复核误杀的结论由源码推演得出（`plan_binding_covers_tool_approval` 置 `approval_required=false` → ApprovalManager 跳过 → `approval_requirement_satisfied=false` → 复核裸判必拦），未做 v0.9.44 实机复现；若要坐实可在旧 tag 上跑 `plan_binding_is_consumed_exactly_once_under_concurrency` 一类集成路径。

## 建议的后续顺序

1. flush 终态启发式清理尾随闭合 token + reasoning 通道挂过滤器（同一改动面，一起做）。
2. compaction 时刷新 availableSkillsSnapshot（零缓存成本，产品收益明确）。
3. 共享 token 常量表；规划双适配器的公共流处理核心（可与下一轮拆模合并）。
4. 逐步把源码 grep 契约换成渲染断言（不紧急，随触碰随换）。

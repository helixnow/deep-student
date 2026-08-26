# 生成式 UI / HPIAS / 技能改造质量评审

评审对象：`v0.9.44` → `origin/cursor/0824-cde6 @ 2d41ea8b`。本文只判断这块改造的真实质量：加法式吸收做得是否干净、安全边界是加强还是削弱、哪些是实打实的缺陷。不把"新增了多少文件和测试"当成完成度。

体量参考：`src/features/generative-ui` 为全新目录（114 个文件、约 1.28 万行），Rust 侧新增 `generative_ui_executor.rs`（1055 行）、`src-tauri/src/hpias`（7 个模块约 1200 行）与带真实 Tauri 窗口的 e2e（559 行）；技能侧是约 30 个 builtin-tools 描述瘦身、目录快照机制和管理 UI 打磨。三块在 v0.9.44 中均不存在或仅存残迹（`researchStore` 在旧版只被 mcp-debug 注册，没有任何事件源）。

## 结论

**分块判定：生成式 UI 本体 PASS（少量收口项）；技能侧 PASS；HPIAS 后端 WARN，不能按"深度研究能力已接入"验收。**

生成式 UI 是这次 0824 里少见的、从第一天就按"模型输出不可信"设计的新增面。它没有削弱任何既有安全边界——它为一类原本不存在的能力（模型驱动 UI）建立了本来就该有的边界。HPIAS 则相反：事件协议、多会话切片、面板架子质量不错，但默认后端是一个无标识的演示剧场，真实检索后端锁在普通用户摸不到的环境变量后面，研究结果既不回流对话也不持久化。

## 加法式吸收评估

吸收方式非常克制，接触面小且形状正确：

- Rust 侧只在执行器注册表追加一项，并在工具名到块类型的映射中加一个分支（`src-tauri/src/chat_v2/pipeline.rs:347,451`；`context.rs:1062`），不碰任何既有执行器语义；
- 前端通过既有 `blockRegistry` / `eventRegistry` 插件机制注册 `generative_ui` 块（`src/features/chat/plugins/blocks/generativeUI.tsx:155-159`；`plugins/events/generativeUI.ts:67`），不修改 chat 核心；
- HPIAS 复用了 v0.9.44 遗留的 `useHpiasStore` 而不是另起炉灶，新增 `sessions` 多会话切片时保留顶层字段供旧的全页研究 UI 继续读（`src/stores/hpiasSessionSlice.ts:1-4`），外会话事件只写切片不顶掉活跃会话；
- 工具本身通过 `generative-ui` 技能的 `embeddedTools` 暴露，不装载技能就不出现在工具面，符合渐进披露架构。

回放路径也想清楚了：Rust 落库的 `ToolResultInfo.output` 只有 `{"status":"rendered","blockCount":N}`（省 token），重载会话时前端按 `toolOutput.intent → content → toolInput.intent` 三级回退取意图（`src/features/generative-ui/bridge/chatBlockBridge.ts:41-96`），重载后静态块仍可渲染。这是"tool result 给模型的"和"UI 要渲染的"两条通道分离的正确做法。

一处例外要点名：`src/features/generative-ui/prompts.ts` + `prompts/fewShotExamples.ts`（合计约 550 行）构建的系统提示只被 Style Lab demo 消费，生产模型的真实指导来自技能正文 `builtin-tools/generative-ui.ts`。两套 prompt 源并存，`registryPromptSync.contract` 只锁 prompts.ts 一侧，技能正文里手写的 18 个 type 列表没有合同测试钉住，存在漂移空间。

## 安全边界评估：是加强，不是削弱

这一块值得展开，因为它是全仓对"模型输出进 DOM / 触发副作用"防御最完整的实现：

1. **双端白名单入口。** Rust 在工具执行入口先验：18 种块类型白名单、32 块上限、256k 字符上限、`intent.version` 只认 `"1"/"1.1"`（`generative_ui_executor.rs:19-42,106-131`）。前端 zod 再验一遍整体结构 + 逐块 props schema，`z.object` 默认剥未知键，模型无法经 props 注入 `className`/`style`；布局 class 只从受控 token 表输出，不透传模型字符串（`schema.ts:89-109`）。

2. **动作系统按"注册表 fail-closed"设计。** Chat 块始终传入 handler 注册表，此时未注册的 action id 直接不渲染按钮；确认弹窗展示宿主注册的 trusted label 而非模型 label，阻断"按钮写着查看详情、实际执行删除"的伪装（`components/ActionBarBlock.tsx:30-36,66-71`）；有效风险级取 `max(模型声明, handler 声明)`，模型不能自降风险（`actions.ts:101-109`）；high 走 alert dialog、medium 双击确认；handler 统一包 rate-limit（400ms）+ timeout（15s）+ telemetry；handler 查找用 `Object.hasOwn` 防原型键冒充。`actionBarSecurity.test.tsx` 直接按这个威胁模型写断言，不是覆盖率凑数。

3. **Notes 写入是真 HITL，不是自我声明。** intent 含 `apply-note-edit` 时 Rust 强制要求 `noteEdit` 参数并白名单化字段、拒绝 `isRegex`、256KiB 上限（`generative_ui_executor.rs:169-230`）；前端 zod 同规格再验（`utils/extractNoteEditPayload.ts`）；`dispatchCanvasAIEditRequest` 在派发前第三次校验，防止绕过提取层的直接调用者把模型控制的正则送进编辑器（`utils/dispatchCanvasAIEditRequest.ts:57-65`）；最终落盘由编辑器的 diff 确认面板承接。工具本身标 `ToolSensitivity::Low` 是对的——执行器纯发事件无副作用，副作用全部在前端 HITL 之后。

4. **Markdown / URL 消毒有纵深。** markdown 块在进入已挂 rehype-sanitize 的 `MarkdownRenderer` 之前，先做一层同 allowlist 的剥离：script/style/iframe 连内容剥、事件属性和 `style`/`srcdoc` 剥、URL 属性与 markdown 链接/引用定义/autolink 全部过 scheme allowlist、`srcset` 逐项过滤、围栏代码保留原文（`utils/sanitizeGenerativeMarkdown.ts`）。URL 判定处理了空白/C0/C1 混淆（`java\tscript:`）、协议相对 `//`、并把 `data:image/svg+xml` 排除在安全位图之外（`utils/sanitizeGenerativeUrl.ts:10-46`）。文本叶子统一剥控制字符后才进 schema（`schema.ts:237`）。

5. **会话 id 与事件桥。** `researchSessionId` 双端同规格消毒（首字符字母数字、128 上限、仅 `._-`），路径穿越和 `javascript:` 形态进不来；hpias 事件桥按 session 过滤时 fail-closed——缺失或非字符串 `session_id` 的事件不再污染请求会话（`bridge/hpiasEventBridge.ts:106-117`，注释明确记录了修掉的旧洞）。

6. **资源与降级护栏。** 流式缓冲 256k 硬上限双端一致，超限整段拒绝而不是截尾污染 last-good（`utils/streamBufferGuard.ts:20-35`）；解析走"严格 → 恢复（丢非法块、id 去重）→ 部分意图"三级降级，块级校验失败渲染警告块而不是整卡崩溃，外面再包 ErrorBoundary。

技能管理 UI 侧还有一处主动补强：恢复内置默认从"点击即执行"改为与删除同级的行内确认流（`SkillsManagementPage.tsx` 的 `handleRequestResetToDefault` 链），这是对既有破坏性操作边界的加强。

**结论：没有发现任何被削弱的既有边界；新增边界的实现质量高于仓库平均水平。**

## 主要缺陷与风险

### 高 — HPIAS 默认后端向用户展示捏造的研究过程，且无任何演示标识

后端工厂默认 `stub`（环境变量缺省即 stub，`src-tauri/src/hpias/service.rs:23-39`）。stub 时间线的数字是编的：`fetched = queries.len() * 21`、`selected = queries.len() * 6`、`citations: {"items": []}`、每个子代理固定汇报"子代理 N 已完成检索与摘要"（`payloads.rs:266-306`）。intent 没带 `research-report` 正文时，综合结论回落到一段硬编码的医学影像文案加假引用 `[review-1]`（`payloads.rs:253-258`）——用户问的是别的主题也照发。

而技能规则 7 要求模型见到 research 块就必须传 `researchSessionId`，前端见到合法 id 就挂研究面板并用实时事件顶掉静态块。也就是说**默认配置下的正常使用路径必然触发这场剧场**：面板显示"检索 42 / 精选 12 / 子代理完成"，但检索从未发生。真实的 `RetrievalHpiasResearchService`（VFS UnifiedRetriever + LLM synthesis，实现质量尚可）锁在 `DEEP_STUDENT_HPIAS_BACKEND=retrieval` 后面，桌面用户没有入口。

这不是安全漏洞，是可信性缺陷，性质比一般 bug 重：UI 向用户声称完成了并未发生的工作。收口方向二选一：deps 可用时默认走 retrieval（工厂已有回退逻辑，改默认值即可）；或给 stub 面板打显式 demo 标记并删掉硬编码医学正文。

### 高 — 研究结果不回流对话、不持久化，管线是射后不理

执行器发完块事件后 spawn 管线立即返回 `{"status":"rendered"}`（`generative_ui_executor.rs:427-458`）。synthesis 与子代理摘要只进 zustand store：模型在后续轮次看不到任何研究产物，无法引用或续写；会话重载后实时面板消失（事件不落库），只剩模型当时自己编的静态 research 块。retrieval 模式下真实检索 + 一次 LLM synthesis 的成本花完，产物在进程内存里蒸发。

HPIAS 与对话当前是两个不相交的世界。至少应把最终 synthesis 持久化进块（回放可见），更进一步应以后续 tool result 或尾部注入把结论交还模型。

### 中高 — 同一 researchSessionId 重复渲染会并发 spawn 管线，无去重、无取消

`start_research_session` 每次调用无条件 spawn（`retrieval_backend.rs:216-230`；stub 同），hpias 模块里没有任何 in-flight 会话表。技能 few-shot 明确鼓励"research-plan 先出、research-report 后出"的多次渲染节奏，模型复用同一 session id 时：retrieval 模式双倍检索 + 双次 LLM 计费；两条管线事件交错写同一切片，而 `synthesis_updated` 是追加语义（`hpiasSessionSlice.ts:172-177`），正文会重复拼接；executor 每次先 emit `session_started` 又会把切片清零重放。需要 backend 侧按 session id 幂等或先取消旧管线。

### 中 — 契约与实现的三处名不副实

1. `contracts/hpiasLifecycleContract.ts:1-6` 声称顺序"必须与 Rust payloads 一致"，且序列把 `retrieval_completed` 排在 subagent 之前；retrieval 后端实际把 `retrieval_completed`/`selection_completed` 发在全部 subagent 之后（`retrieval_backend.rs:171-183`）。断言函数只查覆盖不查顺序，契约文件的承诺比测试强。
2. stub 子代理引用 `json!([["paper-{}", sub_id]])` 是未插值的字面量——`json!` 不做 format，前端会收到引用 id 为字符串 `"paper-{}"`（`payloads.rs:298-305`）。
3. synthesis 的 LLM 调用借道 `call_with_config_id_raw_prompt("_hpias_synthesis_", …)`，该 config id 不存在，必然走"未找到，回退 Model2 默认"的 warn 分支，且 usage 遥测被标为 `compaction` 用途（`model2_pipeline.rs:6856-6886`）——HPIAS 的成本在账面上不可见。

### 中 — 流式基础设施在聊天主链上闲置

后端在工具参数收齐后一次性 `emit_chunk` 完整 JSON（`generative_ui_executor.rs:424-426`），chat 主链上不存在渐进流。前端约 700 行的流式解析、stream registry、`coercePartialIntent`、乱序恢复实际只被 Style Lab demo 和测试驱动。作为前瞻设计可以接受，但它和 prompts.ts 一样制造了"能力已存在"的观感；若要兑现，需要在 tool-call 参数增量阶段就发 chunk，否则应在文档标注 demo-only。

### 低 — 若干小项

- `parse_intent` 先 `serde_json::from_str` 再查长度，超大字符串会先完整进内存（`generative_ui_executor.rs:56-77`）；上游有 LLM 输出长度约束，实害有限。
- intent 在 chunk、end payload、`ToolResultInfo.input` 三处重复传输与落库，接近上限时单次渲染约 3×256KB。
- `service.rs` 的 `from_env` 测试在并行测试进程里 set/remove 全局环境变量（`service.rs:119-136`），与同二进制其他用例存在偶发竞态。
- ActionBar 在无注册表模式下点击 action 即播报成功 live 文案（`ActionBarBlock.tsx:159-160`），即便没有任何 handler 执行；chat 路径恒有注册表，仅影响裸用方。
- `strip_tool_namespace` 会剥 `mcp_` 前缀，名为 `mcp_render_generative_ui` 的外部 MCP 工具会被内置执行器接管——这是既有模式的共性问题，非本次引入，但新执行器加入后接管面又大了一格。

## 技能侧评审

变化分四类，整体是低风险的加法：

1. **generative-ui 技能本体**（`builtin-tools/generative-ui.ts`）：正文规则密度高且方向正确——禁 HTML/JSX/inline style、副作用只能经 action-bar 声明、高风险必须带 riskLevel、HITL 与 researchSessionId 的强制条款、flashcard-preview 只读（入库统一交 anki_cards 管线，与 wrap-up 裁决一致）。JSON Schema 对 `noteEdit`/`layout` 用了 `additionalProperties: false` 收紧。缺一个把正文 type 清单钉在 registry 上的合同测试（见上文漂移风险）。
2. **约 30 个 builtin-tools 描述瘦身**：如 `ask-user.ts` 把"【必填】"等冗词压掉，语义无损的 token 节省，配合 H 冻结按会话代际生效，是干净的改动。
3. **目录快照机制**（`progressiveDisclosure.ts` 移除 `excludeLoaded` + 会话级 `availableSkillsSnapshot`）：属于 prompt-cache 改造的一部分，其并发首发与长期陈旧问题已在 `prompt-cache.md` 评审详述，此处不重复；从技能视角补一句——目录冻结意味着中途安装的技能对旧会话模型不可见，与技能市场"即装即用"的产品叙事有张力，需要产品层面明确预期。
4. **管理 UI 与可达性**：reset 确认流（补强边界）、`/` 聚焦搜索带 workbench 窗口焦点门禁、SkillsList 键盘操作（Enter 打开、E 切换启停、Delete 走确认横幅）并配了 `SkillsList.a11y.test`、aria-label 从英文硬编码转 i18n、44px 触控目标、编辑器 Android 返回键加保活可见性守卫防止隐藏层吞键。全部是打磨性加法，未见回归面。键盘 `E` 即时切换启停无任何反馈提示，误触不易察觉，建议补 toast。

`docs/research/anki-ai-native/agents/skills/*/SKILL.md` 三个文件是研究文档中的示例技能，不进运行时，不构成风险。

## 测试质量判断

这块的测试不是摆设：前端 124 个测试文件覆盖到消毒（URL 混淆用例）、动作安全（标签伪装、风险上取）、流式降级、i18n/locale、a11y、undo 隔离，另有 registry/prompt/payload/action-handler 四类 contract 测试防漂移；Rust 有入口验证单测和带真实 Tauri 窗口 + 事件捕获的 e2e（含 33 块拒绝、version 2 拒绝、hpias session_started 断言）。

缺口与上文缺陷一一对应：

1. 没有"同一 session id 重复 render"的并发管线测试——正好绕开了最现实的使用节奏；
2. 生命周期契约只测覆盖不测顺序，测不出 retrieval 后端的顺序分叉；
3. `hpiasPipelineRuntime.integration` 测的是 stub 时间线，retrieval 后端（真正有价值的那个）没有任何集成测试，可以用 fake retriever 补；
4. 没有断言"stub 综合结论不含硬编码正文"之类的反剧场用例——因为剧场本身是设计意图；
5. chat 主链无流式端到端（因为不存在流式），streaming 测试全部在 demo 语境。

## 建议的收口顺序

1. **先处理 HPIAS 可信性。** 默认后端在 deps 可用时切 retrieval，或给 stub 面板加显式 demo 标记并删除硬编码医学正文与假数字公式。
2. **给管线加 session 幂等/取消。** 同 id in-flight 表，二次请求要么幂等要么先取消。
3. **让研究产物回流。** 最终 synthesis 持久化进块（回放可见），并设计交还模型的通道。
4. **补契约。** 顺序断言接到两个后端；技能正文 type 清单与 registry 建合同测试；修 `paper-{}` 插值；synthesis 调用换独立 caller/purpose 标识。
5. **决断流式与 prompts.ts。** 接通参数增量流，或明确标注 demo-only，避免下一个评审者再花时间确认"它到底流不流"。

## 最终判断

生成式 UI 本体与技能侧是高质量的加法式吸收：接触面小、回放通道分离、双端白名单一致、动作/写入/渲染三条链都按"模型不可信"建边界，测试直指威胁模型。**没有削弱任何安全边界，反而树立了一个可供其他模块参照的范本。**

HPIAS 是短板：架子（事件协议、fail-closed 桥、多会话切片、面板映射）质量不差，但默认交付的是无标识的演示剧场，真实后端不可达，产物不回流、不持久化、无并发治理。按当前状态，它适合被描述为"研究面板的前端基建 + 一个未启用的检索后端原型"，而不是"深度研究已接入"。上面收口清单的前三项做完之前，不建议在产品叙事中宣称 HPIAS 能力。

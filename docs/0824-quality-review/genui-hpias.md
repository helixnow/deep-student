# 生成式 UI / HPIAS / 技能 改造质量评审

## 结论

对照 `v0.9.44` 与 `origin/cursor/0824-cde6 @ 2d41ea8b`。本文不做逐项吸收对账（05 号静态审计已做完），只回答三个问题：加法式吸收的**工程质量**如何、有没有削弱安全边界、还埋着哪些缺陷与优化空间。

**总判定：WARN。GenUI 渲染协议层与技能接入是本次合成里质量最高的一块，接近可直接背书；但 HPIAS「深度研究」链在默认配置下是一场无标注的表演，且研究结果既不落库也不回流模型——这是产品诚实性问题，不是打磨问题。**

分面：

- **GenUI 协议层（executor + schema + 渲染 + action 安全）：PASS。** 双侧硬上限、三层会话过滤、HITL 写入链、注册表安全模式全部在位，且相对 #214 tip 是多处收紧（本轮独立复核了关键 diff 方向）。
- **HPIAS 研究链：FAIL（产品完整性），非安全性 FAIL。** 默认 stub 后端伪造检索计数、子代理进度和综合结论并以真实研究的文案呈现给用户；真实 retrieval 后端只能靠终端用户不可达的环境变量开启；无论哪种后端，研究产出都是易失的、与模型对话断开的。
- **技能面：PASS。** `generative-ui` 技能走既有注册/门控/本地化机械，目录快照冻结（prompt cache）设计成熟。

## 一、加法式吸收的工程质量：这块做得确实好

### 1. 结构上是真加法，不是「新旧两套并存」

`src/features/generative-ui/` 全部 114 个文件相对 v0.9.44 是纯新增（12771 行插入、0 删除）；Chat 侧接入只通过既有插件注册表完成（`eventRegistry.register` / `blockRegistry.register`，见 `src/features/chat/plugins/events/generativeUI.ts` 与 `plugins/blocks/generativeUI.tsx`），没有侵入 chat core。Rust 侧同样：`GenerativeUiExecutor` 按既有 ToolExecutor 协议注册在 catch-all 之前，`hpias` 是独立新模块。

更值得肯定的是状态容器的选择：0824 没有为 HPIAS 新写一个 store，而是复活了 v0.9.44 里已休眠的 `researchStore`（当时仅 `mcp-debug/registerStores.ts` 引用），只加 90 行（多会话切片 + 两处审计修复），并把并发隔离逻辑拆进纯函数模块 `src/stores/hpiasSessionSlice.ts`。这是正确的「吸收进已有体系」而非「旁路再造」。

### 2. 防御栈是双侧、纵深、且被测试钉死的

本轮独立复核，以下每层都在树上且相互一致：

- **入口双侧对称**：Rust 入口 256k intent / 32 块 / 18 型白名单 / 版本字面量校验（`src-tauri/src/chat_v2/tools/generative_ui_executor.rs:51-132`）；前端 Zod 同限 + 流式 buffer 同 256k 上限（`schema.ts`、`utils/streamBufferGuard.ts`——后者甚至为避免热路径大字符串分配写了不构造副本的预算估算器）。
- **文本/URL/Markdown 清洗**：控制字符剥离在 `validateBlockProps` 入口统一做；URL scheme allowlist 处理了空白/C0 混淆（`java\tscript:`）、`data:` 仅放行静态位图并明确排除 `svg+xml`、协议相对 `//` 拒绝（`utils/sanitizeGenerativeUrl.ts:24-46`）；Markdown 清洗保留围栏代码、剥 on* / style / srcdoc、重写 href/src/srcset/ping/background，并覆盖 GFM autolink 与引用定义（`utils/sanitizeGenerativeMarkdown.ts`）。
- **Action 安全模式**：Chat 始终传入 handler 表 → 未注册 action 不渲染不可点；展示 label 以 handler 注册为准（模型 label 仅兜底）；有效风险级取 max(模型声明, handler 声明)，high 走对话框、medium 走两击确认；handler 表用 `Object.create(null)` + `Object.hasOwn` 防原型仿冒；统一套 rate-limit（400ms）/ timeout（15s）/ telemetry / 撤销栈（`actions.ts:77-109`、`ActionBarBlock.tsx:66-71,195-215`）。
- **Notes 写入 HITL**：noteId 取自用户自己打开的 canvas（`modeState.canvasNoteId`），模型不可指定目标笔记；regex 在 Rust 入口、TS schema、派发口三层禁死；一切写入经 `canvas:ai-edit-request` 建议通道，无直写后端路径。
- **流式解析器**：块级提交 + last-good + 恶意切片前进不卡死 + id 去重 + 截断告警（`parser.ts`），配 124 个测试文件覆盖 a11y、RTL、contrast、reduced-motion、截断、恢复、隔离等维度。

这一层的完成度显著高于「能用」，达到了它自己文档（SOTA_CHECKLIST）声称的水准。

### 3. 相对 #214 tip 的取舍方向经得起独立复核

本轮直接跑了 `git diff origin/Generative-UI-0824 2d41ea8b` 的关键文件：定向桥确认为 fail-closed 收紧版（缺失/非字符串 `session_id` 一律丢弃，#214 tip 会穿透）；`migrateIntentToV11` 确认为深拷贝无损升级（#214 是丢字段白名单重建）；闪卡 `save-to-library` 保存链确认未吸收，闪卡块保持纯展示——入库统一归 `anki_cards` QA 管线。这三处「不吸收/改造后吸收」的裁决都让边界更清楚，不是偷懒。

## 二、安全边界：没有削弱，但有两处非对称值得记录

结论先行：**未发现任何相对 v0.9.44 或 #214 的边界放宽**。以下两条是新增面自身的非对称，不是回归：

### 1. research-plan 步骤数：前端封顶 12，Rust 后端不封顶

前端 schema 把 `research-plan.steps` 限制在 1–12（`ResearchPlanBlock.tsx:17`），但 Rust 的 `extract_plan_queries_from_intent` 取**全部** step label 不设上限也不去重（`src-tauri/src/hpias/payloads.rs:57-85`）。256k 的 intent 足以塞进数千个短 step。在默认 stub 模式下这只是多发一串事件；但在 retrieval 模式下，每个 label 触发一次完整的 `VfsUnifiedRetriever::search`（含向量检索链路，`retrieval_backend.rs:108-169`），是模型可控的 N 倍资源放大。retrieval 是 opt-in 环境变量，所以现在是低危；一旦按第五节建议把后端转正，这条必须先补。

### 2. researchSessionId 的所有权在模型手里

会话 id 由模型自由指定，Rust/TS 双侧只做字符集与长度清洗（`generative_ui_executor.rs:143-153`），不做唯一性约束，也不与 tool call / block 绑定。模型偏好复用相似 id（如 `research-1`）：同一 chat 的两次研究、甚至两个 chat 会话复用同一 id 时，两个块会钉在同一个 store 切片上，后一次的 `session_started` 会清空前一次的切片（`hpiasSessionSlice.ts:106-107`），前一个面板随即显示后一次运行的数据。三层过滤解决的是「不同 id 不串台」，没有解决「同 id 本就不该属于两次运行」。技能正文只说「必须传 researchSessionId」（`builtin-tools/generative-ui.ts:68`），没有唯一性指引。正确做法是执行器用 `block_id` 派生并回写权威 id，模型传入仅作参考。

另有两条既有观察维持原判、不再展开：`guardedListen` 白名单仅 dev 断言（全仓既有设计）；`normalizeHpiasEventPayload` 只校验 `type` 为字符串，在「事件只来自本进程 Rust」的信任模型下可接受。

## 三、HPIAS 链的核心问题：默认配置是无标注的研究表演

这是本评审最重要的发现，此前的静态审计（05 号）验证了「stub 管线接线正确、事件序列与 Style Lab 对齐」，但没有从产品视角问一句：**用户看到的是什么？**

### 事实链

1. 后端由 `DEEP_STUDENT_HPIAS_BACKEND` 选择，默认与未知值都落 stub（`src-tauri/src/hpias/service.rs:23-39`）。这个环境变量没有任何设置界面，打包桌面应用的终端用户**必然**运行 stub。
2. 技能主动引导模型触发它：intent 含 research 块时「必须传 researchSessionId」，于是每个默认安装里，模型一做研究类回答就会拉起 stub 管线。
3. stub 推送的内容（`src-tauri/src/hpias/payloads.rs:236-317`）：
   - 检索计数是编造的：`fetched = 查询数 × 21`、`selected = 查询数 × 6`（`:266-267`）；
   - 子代理摘要是固定话术「子代理 N 已完成检索与摘要。」（`:303`）；
   - 「综合结论」要么把模型自己在 research-report 块里写的正文原样回放（`extract_synthesis_from_intent`，`:88-106`），要么在模型没写报告时回退到一段与用户问题无关的硬编码医学影像文案，还带着假引用 `[review-1]`（`:253-258`）。
4. 前端把这些渲染成「深度研究进度 / 文献检索 / 入选引用」的仪表盘（`src/locales/zh-CN/generativeUi.json` hpias 节 + `buildHpiasResearchDashboardIntent.ts:78-95`），唯一的标注是通用的「AI 生成内容」徽章。没有任何「演示 / 未执行真实检索」的提示。

合成效果：用户提出研究问题 → 看到一个声称检索了 42 篇文献、筛选了 12 条引用、两个子代理完成调研的进度面板 → 「综合报告」其实是模型闭卷写的那段话被伪装成检索产物回放。这不是打磨欠缺，是**伪造过程证据**。Style Lab 里演示时间线是合理的；把同一条时间线接进真实 Chat 而不改语义标注，是本次合成里最大的判断失误。

### 即使打开真实后端，链路也没有闭环

设 `DEEP_STUDENT_HPIAS_BACKEND=retrieval` 后检索是真的（VFS UnifiedRetriever + LLM synthesis，失败回退确定性拼接，工程上没问题），但两个断点仍在：

1. **结果不回流模型。** 执行器发完 `emit_end` 就立刻返回 `{"status":"rendered", "blockCount":…}`（`generative_ui_executor.rs:427-458`），管线在后台 spawn，产出只走 `hpias_event` 进 UI。模型永远看不到检索命中与综合结论，它的文字回答不可能引用这些证据——「研究面板」与「助手回答」是两个互不知情的世界。
2. **结果不落库。** `researchStore` 无持久化（仅 devtools 中间件）；chat 块的 `toolOutput.intent` 在管线运行**之前**就已保存。应用重启后切片消失，前端正确回退渲染静态块（`plugins/blocks/generativeUI.tsx:61-74`，这个降级本身写得对）——但静态 research-report 是模型当初的闭卷稿，真正的检索综合已经蒸发。用户不复制导出就等于白跑。

所以对 HPIAS 链的公允评价是：**事件协议、并发隔离、降级路径都建成了，唯独「研究」这个产品承诺本身还不存在。** 把它当成已交付能力对外描述是不成立的。

## 四、确定性缺陷清单（按修复优先级）

1. **`export-plan` 一个 id 两种语义，且标签撒谎。** workbench 基线 handler 里 `export-plan` 的实现是 `workbenchBus.launch({typeId:'learning-hub'})`——一个叫「导出计划」的按钮实际行为是打开 Learning Hub 窗口（`handlers/workbenchLearningHandlers.ts:47-54`）；只有 intent 含研究块时才会被真正的剪贴板导出 handler 覆盖（`bridge/resolveGenerativeUIChatActionHandlers.ts:89-138`）。few-shot 恰好教模型在**非研究**的学习仪表盘里放 `export-plan`（`prompts/fewShotExamples.ts:46-54`），命中的正是「标签说导出、行为是导航」的分支。信任标签体系（trustedLabel 取 handler 注册 label）在这里被 handler 自己击穿了。
2. **synthesis 长度与 research-report 上限冲突。** store 侧 synthesis 是无上限累加的（`subagent_completed` best-effort 追加小节 + `synthesis_updated` 拼接，`src/stores/researchStore.ts:418-446`），而 `research-report` 块 schema 硬限 12000 字符，`buildHpiasResearchDashboardIntent.ts:138-147` 传入前不裁剪——超限时块级校验失败，报告位置直接变成校验错误告警（copy-report 仍可用，因为它读 store 不读块）。
3. **研究报告把 Markdown 当纯文本渲染。** synthesis prompt 明确要求输出 `## 综合结论` 起头的 Markdown（`src-tauri/src/hpias/synthesis.rs:45-58`），stub 的硬编码文案也带 `**` 强调；而 `ResearchReportBlock` 用 `whitespace-pre-wrap` 的 span 渲染正文（`ResearchReportBlock.tsx:20-58`），用户看到的是字面 `##` 与 `**`。仓库里现成的 `sanitizeGenerativeMarkdown + MarkdownRenderer` 组合（markdown 块就在用）没有被复用。
4. **stub 引用格式化 bug。** `json!([["paper-{}", sub_id]])` 忘了 `format!`，产物是字面 `"paper-{}"`（`payloads.rs:304`）——任何渲染 citations 的界面都会显示占位符原文。这个 bug 恰好说明 stub 内容从未被人当真看过。
5. **HPIAS synthesis 的 LLM 用量记错账。** 传入伪 config id `"_hpias_synthesis_"` 走 `call_with_config_id_raw_prompt`，该方法找不到配置时按设计回退 Model2 默认并打 `[compaction]` warn 日志，用量按 `CallerType::ChatV2` / purpose `"compaction"` 入账（`synthesis.rs:72-77`、`llm_manager/model2_pipeline.rs:6856-6889`）。每次研究综合都伪装成一次压缩调用：日志噪音 + 用量归因失真。
6. **查询兜底字面量。** 问题为空时 retrieval 后端拿字符串 `"research query"` 去检索用户的 VFS（`retrieval_backend.rs:57-67`），必然返回无关命中并流入 synthesis。应当直接跳过检索走空态。
7. **`session_failed` 无 id 时误伤活跃会话**（潜在）：该事件 `session_id` 可选，缺失时走顶层分支把当前活跃会话的 running 子代理标记为 failed。当前两个后端都不发这个事件，属休眠缺陷。

## 五、技能面：干净，且有一个值得表扬的设计

- `generative-ui` 技能是标准加法：定义 + `builtinToolSkills` 注册 + 双语词条 + 本地化契约测试，`allowedTools` 走既有 `builtin-` 门控。技能正文与执行端约束逐条对得上（18 型清单、32 上限、HITL noteEdit 禁 regex、闪卡只读、研究块须带 session id），并有契约测试锁定正文必须引用 `MAX_GENERATIVE_UI_BLOCKS`。模型看到的承诺与后端强制的行为一致——这正是 05 号审计验证过的，本轮无新发现。
- **available_skills 目录会话级冻结**（`progressiveDisclosure.ts:647-693`）是本区间技能面最有含金量的改动：目录首帧冻结 + `session.metadata` 持久化 + 重启回灌 + 多窗口 first-write-wins，杜绝了「中途装技能 → system 第 0 字节变化 → 整段 prompt cache 失效」。代价（中途安装的技能不进当前会话目录，只能靠 `load_skills` tool result 与瞬态消息表达）在注释里写得清清楚楚，是自觉的取舍而非疏忽。
- 一个无害但值得知道的事实：`prompts/fewShotExamples.ts` 与 `buildGenerativeUISystemPrompt` **不在生产提示链上**（仅 Style Lab 与契约测试消费），真正面向模型的只有技能正文。这层「假提示词层」被十几个契约测试供养着；不算缺陷，但它教出来的 `export-plan` 用法与第四节第 1 条的语义冲突同源，收敛时应一起处理。
- `skills-management/index.ts` 的转导出收敛（实现留在历史路径、出口统一）是合理的最小改动策略。

## 六、优化顺序

1. **先诚实，再谈能力。** 短期二选一：stub 模式下面板显著标注「演示数据，未执行真实检索」，并去掉编造的检索/入选计数与医学影像兜底文案；或者默认根本不 spawn stub 管线（研究块只渲染静态内容），把 stub 完整保留给 Style Lab。这是发布阻断项。
2. **会话 id 收归系统。** 执行器以 `block_id` 派生权威 researchSessionId 并写回 `emit_end` payload；模型传入的 id 降级为展示别名。同时消除同 id 串台与复用污染。
3. **闭环研究产出。** synthesis 完成后把报告写回 chat 块（追加块更新事件并入库），并考虑以第二阶段 tool result 或后续消息把综合结论交还模型引用。做不到闭环之前，「深度研究」不应出现在用户可见的能力描述里。
4. **Rust 侧补对称上限**：plan queries 封顶 12 并去重（对齐前端）；synthesis 传入 research-report 前裁剪至 12000；顺手修 `format!` 引用 bug。
5. **`export-plan` 语义拆分**：workbench 导航 action 改名（如 `open-learning-hub`），或非研究 intent 不注册 `export-plan`；few-shot 同步更新。
6. **研究报告改用 Markdown 渲染**（`sanitizeGenerativeMarkdown` + `MarkdownRenderer`），引用徽章可在渲染后正则替换保留。
7. **后端开关产品化**：`DEEP_STUDENT_HPIAS_BACKEND` 升级为设置项或按 VFS/LLM 可用性自动选择；HPIAS synthesis 申请独立的 usage caller/purpose。

## 发布判断

GenUI 协议层、块生态、action 安全与技能接入可以按当前状态背书——这部分的吸收改造展示了这套「加法式 + 双侧契约 + 测试钉死」方法论的上限。但只要默认安装里还存在「无标注的假研究进度」这一条，就不应把 `2d41ea8b` 的 HPIAS 面描述为已完成合成的产品能力；它目前的准确定位是「事件协议与 UI 已就绪、后端为演示桩、产出未闭环」的基础设施。建议以第六节第 1 条为发布门槛，第 2–3 条为转正门槛。

本评审为只读静态复核：结论基于源码、双向 git diff（含与 `origin/Generative-UI-0824` tip 的方向核对）与既有测试文本，未运行测试或实机管线。

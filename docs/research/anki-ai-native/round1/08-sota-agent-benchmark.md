# Round 1 · 子报告 #8 — SOTA Agent 制卡方案对标

> 调研时间：2026-08-24 ｜ 对标对象：Cursor / Devin / Mem0 / Anki AI 插件生态 / AI 闪卡产品 / 2025-2026 学术前沿
> 交付物：对标矩阵 + 按 ROI 排序的可落地实践清单

## TL;DR

1. **行业公认痛点被量化了**：Memory Machines（2026）用 ~1500 条标注卡片基准证明，最强模型（GPT-5.2）生成的卡片仍有 **~36% 不可用**；且 rubric/few-shot/微调都教不会模型区分「看似合理但复习时劣化」的 T1 卡。唯一有效的是 **grounded judge**（用同源标注样例做相对比较），可把验收精确率从 56% 提到 78%、误放行从 52% 降到 17%。
2. **DeepStudent 的 Agent 编排层（28 工具闭环）已达到或超过 Anki 插件生态的水平**，但在四个维度落后于 2026 SOTA：生成内核无内置质检（judge/lint）、无复习数据回流（FSRS-aware 生成）、无用户偏好记忆、结构化输出仍用自定义分隔符。
3. **十条实践按 ROI 排序**，前五条（原生结构化输出、确定性质检 lint、grounded judge、FSRS 回流、sidekick 模型分层）均可复用现有基础设施，改动集中在 `streaming_anki_service.rs` 与 `chatanki_executor.rs`。

---

## 1. 调研范围与方法

- **Agent 平台范式**：Cursor（Plan Mode / Skills / Subagents / 沙箱终端）、Devin（DAG 规划 / Fusion 模型分层 / Playbooks & Knowledge / managed Devins）、Anthropic 程序化工具调用（code mode）。
- **记忆层**：Mem0 2026 新算法（单次 ADD-only 抽取、多信号检索、时间推理）。
- **制卡垂直生态**：AnkiBrain、Smart Notes、LLM Card Fill、Limbiks AI Image Occlusion、AnkiHub（Mistral OCR）、RemNote AI、AnkiDecks/Flica/Laxu 等原生 AI 闪卡应用。
- **学术前沿**：Memory Machines srs-prompts 基准（2026）、Memdora（arXiv 2607.25096）、LLM 检索练习题实证研究（arXiv 2507.05629）、LECTOR（arXiv 2508.03275）。
- **本仓核实**：`src/features/chat/skills/builtin/index.ts`（28 个 chatanki 工具）、`src-tauri/src/streaming_anki_service.rs`（分隔符协议、无质检 pass、无 FSRS 引用）、`src-tauri/src/providers/mod.rs`（已有 json_schema strict 设施）、模板「提取规则」（字段级 AI 指令已存在）。

## 2. SOTA 方案速览

### 2.1 Memory Machines（2026）— 制卡质量的定量天花板

- 四级质量分类：T0 偏题 / **T1 看似合理但复习时劣化（最危险）** / T2 需打磨但成立 / T3 优秀。
- 关键结论：
  - 最强模型 GPT-5.2 的不可用率（T0+T1）仍 ~36%；GPT-4o 为 71%。
  - 绝对判断不可靠：无模型二分类精度超 70%；rubric 中机器可判的只有「缺上下文」（F1 0.85-0.87），「多个合法答案」等关键项 F1 仅 0.32-0.50。
  - 对比选择也不可靠：把 T3 卡混在 2-4 个候选中，模型只有 ~40-50% 选中，且 ~30-40% 选中 T1。
  - **Grounded judge 是唯一有效手段**：给 judge 提供同一素材下已标注的参照卡，做相对排位而非绝对评分 → 可用性判断精确率 56%→78%，误放行 52%→17%，人机一致性 κ=0.61。
  - 0.6B 小分类器可达到 frontier 模型同等的 precision-recall（更便宜的 judge，而非更好的 judge）。
- **启示**：制卡管线必须「生成→筛选」两阶段；judge 必须 grounded（带同源金标样例）；验收要保守（宁可少放行）。

### 2.2 LLM 检索练习题实证研究（arXiv 2507.05629）— 失败模式清单

约 2/3 的 LLM 生成题不达标，失败可归为 12 类：选项含答案提示、幻觉、题干泄露答案、重复选项、答案有歧义、干扰项过弱、考察琐碎知识、选项格式不一致、干扰项全为否定式、双概念题、错误前提、（题干本身缺陷）。**其中大半可用确定性规则或廉价分类器拦截，无需 frontier LLM。**

### 2.3 Memdora（arXiv 2607.25096）— 认知科学驱动的卡型体系

17 种认知交互卡型 × FSRS-6 调度；强调 **可编辑、透明的 AI 输出 + 一键重生成** 以保持学习者的「认知所有权」（SmartFlash 2026 用户研究同样结论）。

### 2.4 LECTOR（arXiv 2508.03275）— 语义干扰感知

用 LLM 语义相似度评估卡片间干扰，调度时避免语义相近卡片互相混淆；模拟实验成功率 90.2% vs 最强基线 88.4%。**启示：制卡阶段就应检测同批/同库的语义near-duplicate 与易混对，主动合并或生成对比卡。**

### 2.5 Devin（Cognition，2026）— 规划、分层与知识沉淀

- **DAG 规划 + 动态重规划**：计划是带依赖的图而非线性清单，遇阻塞追加子任务。
- **Interactive Planning 检查点**：全自主模式 SWE-bench 仅 13.86% → 在昂贵动作前设人工审批点成为产品核心。
- **Devin Fusion**：frontier 主 agent 只做决策（规划、歧义裁决、终审），routine 工作交给廉价 sidekick 模型；轻量分类器在执行中动态判断是否升级模型；模型切换与上下文压缩合并以复用缓存。
- **Playbooks / Knowledge**：可复用的流程包（目标、步骤、规格、纠正模型先验的建议、禁止事项），跨会话持久。
- **Managed Devins**：父 agent 读子 agent 完整轨迹来改进下一次任务分解。

### 2.6 Cursor（2026）— Plan Mode / Skills / 沙箱

- Plan Mode：研究→澄清→出计划→人审→执行；计划可存 `.cursor/plans/` 成为团队文档。
- Skills：按需动态加载的领域知识+脚本包（vs Rules 常驻上下文）；单一用途任务用 skill 而非 subagent。
- Subagents：独立上下文窗口、可并行、可指定廉价模型。
- 沙箱终端：Landlock/seccomp 文件系统与网络限制。

### 2.7 Anthropic 程序化工具调用（code mode，2025-11 → 2026-01）

模型在沙箱内写 Python 编排工具调用（循环/过滤/聚合在本地完成，中间结果不进上下文）：BrowseComp 类基准 +11%、输入 token -24%，链式批量场景推理成本可降 ~80%。**这正是本仓 README 提出的「Agent 现写脚本」差距的行业标准答案。**

### 2.8 Mem0（2026）— 用户偏好记忆层

单次 ADD-only 抽取（不覆写、保时间线）→ 哈希去重 → 向量+BM25+实体三信号并行检索融合 → 时间推理排序。LoCoMo 92.5、token 节省 90%+。记忆按 user/session/agent 维度隔离。**启示：用户的制卡偏好（卡片长度、语言、出处要求、模板偏好）应作为跨会话记忆自动抽取并在制卡时注入。**

### 2.9 Anki 插件与原生闪卡产品

| 方案 | 核心机制 | 值得借鉴 |
|------|---------|---------|
| AnkiBrain | Anki 内高亮选文即时生成；BYOK | 上下文小、长 PDF 弱——DeepStudent 已领先 |
| Smart Notes | **字段级生成**：给「笔记类型×字段」绑定 prompt，复习时/批量自动补全字段 | 惰性字段补全（review-time generation）|
| LLM Card Fill | 复习界面一键让 LLM 重写/补全当前卡字段 | 复习中即时修卡入口 |
| Limbiks AI Image Occlusion | VLM 自动画遮挡框 + 自定义遮挡指令 | AI 图像遮挡制卡 |
| RemNote | AI 自动遮挡图示标签并 OCR 底层文本作为背面答案（支持打字判分） | 遮挡+答案双生成 |
| AnkiHub | Mistral OCR 升级文档解析质量 | 专用 OCR 供应商 |
| AnkiDecks/Flica/Laxu | PDF/YouTube/音频 → 卡片 <2min；自动图像遮挡 | 输入模态广度 |

## 3. 对标矩阵

评分：● 完备 ◐ 部分 ○ 缺失 —（不适用）。「行业最佳」列指该维度当前 SOTA 做法及出处。

| 维度 | DeepStudent 现状 | Cursor | Devin | Mem0 | Anki 插件/闪卡产品 | 行业最佳（出处） |
|------|-----------------|--------|-------|------|-------------------|------------------|
| **1. Agent 工具闭环**（生成→验收→修正→交付） | ● 28 工具 + CAS 锁 + 双作用域 | ●（通用工具） | ●（自验证+测试） | — | ○ 多为单发生成 | DeepStudent 在垂直域已属第一梯队 |
| **2. 规划与检查点** | ◐ run/wait 固定流程，无 plan 产物、无人审点 | ● Plan Mode，计划可存档 | ● DAG+动态重规划+Interactive Planning | — | ○ | 计划先行 + 昂贵动作前检查点（Devin/Cursor） |
| **3. 生成内质检** | ○ 无 rubric/judge/lint；仅事后 Agent get_cards 巡检 | —（linter/test 反馈闭环） | ●（测试即 judge） | — | ○ 基本没有 | **生成→grounded judge 筛选**（Memory Machines） |
| **4. 结构化输出** | ○ `<<<ANKI_CARD_JSON_END>>>` 分隔符协议（providers 层已有 json_schema strict 但未用） | ● | ● | ● | ◐ | JSON Schema strict / 工具调用式输出（行业默认） |
| **5. Script-native / code mode** | ○ 沙箱存在但未接入 chatanki，无 transform 工具 | ● Skills 带脚本 + 沙箱终端 | ● Devbox 全能力 | — | ○ | 程序化工具调用：批量变换一轮完成、token -24%（Anthropic PTC） |
| **6. 成本/模型分层** | ◐ 路由分 simple/vlm_light/vlm_full，但无按任务难度的模型分层 | ◐ subagent 可指定廉价模型 | ● Fusion：frontier 决策 + sidekick 执行 + 分类器动态升级 | — | ○ | Devin Fusion 模式 |
| **7. 复习数据回流生成** | ○ FSRS 数据、review_stats 工具俱在，但不进制卡 prompt | — | — | — | ◐ LECTOR/Memdora 为研究原型 | FSRS-aware 生成 + 语义干扰检测（LECTOR） |
| **8. 用户偏好记忆** | ○ 编辑/删卡信号未沉淀，跨会话无偏好注入 | ◐ Rules/Memories | ● Knowledge 跨会话 | ● 全自动抽取-检索管线 | ○ | Mem0 extract→consolidate→retrieve |
| **9. 知识/流程沉淀** | ◐ skill 体系存在；无制卡 playbook（学科×模板×规范） | ● Skills 动态加载 | ● Playbooks（含禁止事项、先验纠正） | — | ○ | Devin Playbooks |
| **10. 多模态制卡** | ◐ VLM 读图/OCR 有；**无图像遮挡卡型** | — | — | — | ● RemNote/Limbiks/AnkiDecks 自动遮挡 | VLM 自动遮挡 + OCR 背面答案（RemNote） |
| **11. 字段级/惰性生成** | ◐ 模板「提取规则」已是字段级 prompt；无复习时惰性补全 | — | — | — | ● Smart Notes smart fields | 字段绑定 prompt + review-time 生成 |
| **12. 质量评估基准** | ○ 无制卡质量 eval/回归测试 | ●（内部 evals） | ●（SWE-bench 等） | ● LoCoMo/LongMemEval | ○ | 分层标注集 + grounded judge 回归（Memory Machines srs-prompts） |
| **13. 断点续传/任务持久化** | ● 分段持久化+暂停恢复+失败重试 | ◐ | ● | — | ○ | DeepStudent 已达 SOTA |
| **14. 人工微调体验**（认知所有权） | ● 逐卡编辑/撤销/批量操作/3D 预览 | — | — | — | ◐ | 可编辑+一键重生成（Memdora）；DeepStudent 缺「单卡重生成」 |

**结论**：DeepStudent 在 1/13/14（编排闭环、任务持久化、微调体验）已是第一梯队；核心落差集中在 **3/4/7/8**（生成内质检、结构化输出、复习回流、偏好记忆），其次是 **5/6/10**（code mode、模型分层、图像遮挡）。

## 4. 可落地实践清单（按 ROI 降序）

ROI = 预期收益 ÷ 实施成本。成本按需改动的子系统与侵入度评估。

### P1. 原生结构化输出替换分隔符协议 ｜ ROI ★★★★★

- **做什么**：`streaming_anki_service.rs` 的卡片流改用 providers 层已有的 `response_format: json_schema (strict)`（Gemini/OpenAI/Anthropic 均已在 `providers/mod.rs` 支持转换），卡片 schema 从模板字段定义自动生成；流式场景可按「每卡一个 JSON 对象的 NDJSON/数组增量解析」处理。
- **为什么（SOTA 依据）**：结构化输出是 2025 起的行业默认；本仓「错误卡」的截断/解析失败类根因即分隔符协议。
- **成本**：低——providers 设施已在，改动集中在 `streaming_anki_service.rs` 的 prompt 与解析器；需处理不支持 strict schema 的供应商降级路径。
- **收益**：直接消灭一类错误卡；下游 P2/P3 质检建立在可靠 JSON 之上。

### P2. 确定性质检 lint（12 类失败模式规则化） ｜ ROI ★★★★★

- **做什么**：入库前跑零 LLM 成本的规则检查：空/截断字段、正背面重复、题干泄露答案（背面串包含于正面）、双概念题（正面含多问号/「和」并列）、选项重复、格式不一致、字段超长、克漏语法非法、同批 near-duplicate（嵌入相似度阈值）。违规卡标记为「待修复」而非静默入库。
- **为什么**：arXiv 2507.05629 的 12 类失败大半机器可判；Memory Machines 证明「缺上下文」类缺陷规则可达 F1 0.85+。这是所有质检手段中成本最低的一层。
- **成本**：低——纯 Rust 实现，挂在 `chatanki_executor` 卡片入库钩子上；嵌入去重可复用 VFS 索引的 embedding 设施。
- **收益**：以近零成本拦截 20-30% 低质卡；给 Agent 验收循环提供结构化违规原因（现在 Agent 只能盲翻 get_cards）。

### P3. 生成→筛选两阶段：grounded judge 验收 pass ｜ ROI ★★★★☆

- **做什么**：生成后、入库前增加一个 judge pass：对每张（或抽样）卡片，提供**同模板类型的金标参照卡对**（好卡+其劣化变体，每模板 5-10 对，人工标注一次性成本），让廉价模型做相对排位（T0-T3），T0/T1 打回重生成或标记。judge 结果写入卡片元数据供 Agent 决策。
- **为什么**：Memory Machines 定量证明绝对评分和无参照对比都不可靠，**grounded 相对判断**是唯一把误放行从 52% 压到 17% 的手段；judge 可用小模型（0.6B 分类器即匹配 frontier precision-recall）。
- **成本**：中——需建金标卡对库（可从现有用户编辑记录里挖：用户改前=劣化变体，改后=金标）；judge pass 加一次廉价 LLM 批量调用。
- **收益**：直击「36% 不可用卡」行业痛点，是本清单中对卡片质量提升幅度最大的单项。

### P4. FSRS 复习数据回流制卡（个性化难度闭环） ｜ ROI ★★★★☆

- **做什么**：
  1. 制卡 prompt 注入用户复习画像摘要（高 lapse 卡的共性特征、平均 desired retention、易忘主题）；
  2. 对库内 lapses 超阈值的卡,由 Agent 自动建议「拆分为多张原子卡 / 追加助记 / 生成对比卡」（新工具 `chatanki_suggest_card_fixes` 或纳入现有 update 流程）；
  3. 同批生成时做语义干扰检测（LECTOR 思路），易混概念主动生成 A-vs-B 对比卡。
- **为什么**：LECTOR 证明语义干扰感知提升留存成功率；Memdora 将 FSRS-6 与卡型联动列为方向。**本仓 rs-fsrs 数据与 `review_stats` 工具俱在，只差接线**——这是全行业几乎没人做到、而 DeepStudent 基础设施最接近的差异化机会。
- **成本**：中——Rust 端聚合复习画像 + prompt 注入；干扰检测复用嵌入。
- **收益**：从「生成得快」升级为「记得住」，形成产品护城河。

### P5. Sidekick 模型分层（Devin Fusion 模式） ｜ ROI ★★★★☆

- **做什么**：`decide_route` 从「内容路由」扩展为「内容×模型」二维路由：批量生成/字段补全/lint 修复用廉价模型，规划、歧义裁决、judge 终审、失败段重试升级 frontier 模型；执行中按失败率动态升级（轻量启发式即可起步）。
- **为什么**：Devin Fusion 证明「主 agent 只决策、sidekick 执行、分类器动态升级」在保质前提下大幅降本;code mode 数据同向（token -24%）。
- **成本**：低-中——多供应商/多模型配置已在，主要是路由表与升级策略。
- **收益**：大批量制卡成本可降 50%+，为 P3 judge pass 腾出预算（judge 用省下的钱）。

### P6. 用户制卡偏好记忆（Mem0 模式） ｜ ROI ★★★☆☆

- **做什么**：从用户行为流（编辑 diff、删卡、模板切换、显式指令）单次 ADD-only 抽取偏好事实（「卡片背面 ≤2 句」「医学卡须附出处」「偏好中英双语」），按 user 维度存储；每次制卡前多信号检索 top-k 注入 prompt。
- **为什么**：Mem0 2026 证明该管线以 90% token 节省实现跨会话个性化；Smart Notes 的成功也源于「一次设置、处处生效」。
- **成本**：中——需偏好抽取 pass + 存储（可复用 VFS/向量设施）+ prompt 注入点。
- **收益**：老用户制卡「越用越懂你」，减少重复微调；与 P3 金标库形成数据飞轮（用户编辑既是偏好信号又是 judge 参照样本）。

### P7. Code-mode 批量变换工具（script-native 补课） ｜ ROI ★★★☆☆

- **做什么**：新增 `builtin-chatanki_transform`：Agent 提交一段脚本（沙箱内运行，复用已有 `local_shell_execute` + Seatbelt/bwrap/AppContainer 沙箱），对选中卡片集做批量变换（挖空改写、字段重排、格式统一、正背互换），变换结果走 change-set 审计与预览后应用。
- **为什么**：Anthropic PTC/code mode 是「Agent 现写脚本」的行业标准答案（批量场景推理成本 -80%）；直接回应本研究 README 的核心问题。现在 Agent 做 50 张卡的统一格式修正需 50 次 `update_card` 往返。
- **成本**：中——沙箱已在,主要是卡片数据的脚本 IO 契约（读 JSON 进沙箱、写回校验）与安全审计。
- **收益**：批量修正从 O(N) 次 LLM 往返降为 1 次；解锁「自定义挖空策略」等长尾需求。

### P8. 制卡 Playbook 沉淀（Devin Playbooks / Cursor Skills 模式） ｜ ROI ★★★☆☆

- **做什么**：把「学科×模板×目标」的成功制卡配置沉淀为用户可编辑的 playbook 文档（期望产出、分段建议、字段规范、禁止事项、纠正模型先验的提示），存为 skill 资源；Agent 制卡前按学科/素材类型检索加载。
- **为什么**：Devin Playbooks 与 Cursor Skills 的共同经验：把「重复任务的隐性知识」显式化后按需加载，比堆长 system prompt 有效且省 token。
- **成本**：低-中——skill 体系已在，主要是 playbook 模板设计与检索触发。
- **收益**：跨会话质量一致性；高级用户可自助调优而不等版本更新。

### P9. 制卡质量评估基准（eval harness） ｜ ROI ★★☆☆☆（长期 ★★★★）

- **做什么**：仿 Memory Machines srs-prompts 建 100-300 张分层标注集（按模板类型×学科×素材模态），CI 中以 grounded judge 自动回归：prompt/路由/模型变更后跑生成，报告 T0/T1 率与字段合规率的漂移。
- **为什么**：本仓 prompt 与管线迭代频繁但无质量回归防护;Memory Machines 证明 grounded 评估稳定到可作为基准（κ=0.61）。
- **成本**：中-高——标注集建设 + CI 集成 + API 费用。
- **收益**：短期不可见，长期是所有上述优化「敢改不怕退化」的前提。

### P10. AI 图像遮挡制卡 ｜ ROI ★★☆☆☆

- **做什么**：新增图像遮挡卡型：VLM 检测图中标签→自动画遮挡框（支持自定义遮挡指令,如「只遮神经名称」）→OCR 被遮文本作为背面答案（支持打字判分）；导出映射到 Anki 原生 Image Occlusion 卡型。
- **为什么**：RemNote/Limbiks/AnkiDecks 均已标配,医学/解剖/地理等视觉学科刚需；DeepStudent VLM 管线已在（vlm_full 路由），缺的是卡型与编辑器。
- **成本**：高——新卡型、遮挡编辑器 UI、APKG 导出兼容、移动端适配。
- **收益**：打开视觉学科用户群；但对现有文本制卡质量无提升,故排最后。

## 5. 落地顺序建议

- **第一批（质量地基）**：P1 + P2 同一 PR 序列（P2 依赖 P1 的可靠 JSON）；P5 可并行。
- **第二批（质量跃迁）**：P3（judge）+ P9 最小版（先 50 张标注集给 P3 当金标,顺手成为回归集雏形）。
- **第三批（差异化）**：P4（FSRS 回流）+ P6（偏好记忆），两者共享「用户信号抽取」设施。
- **第四批（范式与扩品类）**：P7（code mode）、P8（playbook）、P10（图像遮挡）。

## 6. 参考资料

- Memory Machines — Evaluating LLM-generated flashcards（2026）: https://memory-machines.com/report
- Enhancing Student Learning with LLM-Generated Retrieval Practice Questions（arXiv 2507.05629）
- Memdora: Cognitively-Grounded Flashcard Interactions（arXiv 2607.25096）
- LECTOR: LLM-Enhanced Concept-based Test-Oriented Repetition（arXiv 2508.03275）
- Devin Fusion（Cognition）: https://cognition.com/blog/devin-fusion ；Devin can now Manage Devins: https://cognition.ai/blog/devin-can-now-manage-devins
- Cursor — Best practices for coding with agents: https://cursor.com/blog/agent-best-practices ；Plan Mode / Subagents docs
- Anthropic — Programmatic tool calling: https://platform.claude.com/docs/en/agents-and-tools/tool-use/programmatic-tool-calling
- Mem0 — State of AI agent memory 2026: https://mem0.ai/blog/state-of-ai-agent-memory-2026
- Smart Notes（GitHub adventurerok/anki-smart-notes）、LLM Card Fill（AnkiWeb 2043082246）、Limbiks AI Image Occlusion、RemNote Image Occlusion Help、AnkiHub 2026-04 更新

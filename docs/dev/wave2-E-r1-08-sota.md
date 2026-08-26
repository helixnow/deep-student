# 0824 Wave2-E R1：Anki/记忆产品 SOTA 对标调研（调研员-SOTA）

> 日期：2026-08-26
> 轮次：Wave2-E 第 1 轮「调研员-SOTA」
> 方法：只读本仓库现码 + Web 行业调研；未编译、未测试、未改产品代码。
> 对照基线：`docs/research/anki-ai-native/wrapup/18-sota-status.md`（现码 8.5/10 口径）、
> `docs/anki-agent-tools.md`（29 个 ChatAnki 工具）、
> `src/features/chat/skills/builtin-tools/qbank-tools.ts` 与 `src-tauri/src/chat_v2/tools/qbank_executor.rs`、
> `src/features/flashcards/*`（复习/统计/设置）、`src/components/anki/utils/imageOcclusion.ts`。

---

## 0. 调研对象与本产品现状快照

### 调研对象

| 竞品 | 定位 | 本轮关注点 |
|---|---|---|
| Anki 桌面（23.10+ / 25.x） | 开源 SRS 事实标准 | note type/模板语言、FSRS 参数暴露、复习按键流、统计、官方 Image Occlusion |
| AnkiHub | Anki 协作/AI 增值层 | 协作牌组 suggestion 流、Smart Search（讲义→卡匹配）、AI chatbot |
| SuperMemo | 增量阅读发源地 | extract→cloze 流水线、优先级队列、auto-postpone |
| Quizlet | 大众化学习平台 | Magic Notes / Smart Assist AI 制卡、Learn 自适应模式、Q-Chat（已退役） |
| RemNote | 笔记+SRS 一体 | AI 制卡交互（选中→配置→预览→Need to Learn 队列）、AI Tutor、PDF Reader |

### 本产品已有（现码事实，只列本轮相关）

- **复习按键流**（`ReviewSessionScreen.tsx` / `RatingBar.tsx`）：Space/Enter 翻面（已翻面时评 Good）、
  1–4 评分（含 Numpad）、Z 或 Ctrl/Cmd+Z 撤销、E 编辑、S 跳过；四键带 FSRS 预测间隔
  （`RatingPreviews` + `formatInterval`）、keycap 提示、按压高亮；`POINTER_RATE_GUARD_MS=280ms`
  防翻面误评；移动端 swipe 评分（`useSwipeRating`）；session 秒级时钟（`useSessionClock`）与连击 streak。
- **FSRS 暴露面**（`SchedulerSettingsSection.tsx`）：仅每日新卡上限 / 每日复习上限 /
  目标保持率（0.5–0.99）三项；FSRS 画像回流为隐私 opt-in（`enableFsrsFeedback`，本轮不动）。
- **统计**（`StatisticsScreen.tsx`）：热力图、14 天每日柱状、评分分布、状态构成 donut、streak；
  前端基于「每张卡最近一次复习」的诚实近似并有标注。
- **模板/Cloze**：`chatanki_list_templates` 输出字段契约；`retemplate` 支持 `fill_missing_llm`；
  前端 `cloze.ts` 支持 `{{cN::answer::hint}}` 解析与揭示渲染；复习面用模板渲染卡面。
- **制卡交互**：ChatAnki 29 工具闭环（run→wait→get_cards→update/batch/transform/retemplate→export/sync），
  QA lint 26 码 `_qa_flags` 留痕，critic 公开 opt-in（默认关），偏好记忆回流，划词制卡走 `CardAgent.startGeneration`。
- **图像遮挡**：`_occlusion` 草稿协议（`{imageRef, boxes:[{x,y,w,h,label,clozeIndex}]}`，0–1 归一化、
  ≤12 盒、label ≤48 字符），`ImageOcclusionOverlay` 预览可交互揭罩；无编辑器、无真实视觉 grounding、
  不接 APKG/AnkiConnect 导出（见 18-sota-status.md「条件接线」节）。
- **qbank 工具面**：bounded output（2000 字符截断 + `<field>_truncated`/`fieldsTruncated` 标记）、
  OCC（`expected_updated_at`）、`previous` + reversible 分级 undo、`qbank_get_question_history`
  返回 `field_name`/`old/new_value`/`operator`/`reason`/`changed_at`。

---

## 1. 竞品能力事实（带来源）

### 1.1 Anki 桌面

**复习按键流与用时**（[Studying - Anki Manual](https://docs.ankiweb.net/studying.html)）：

- Space 翻面；翻面后 Space/Enter 等价 Good（键 3）；1–4 对应 Again/Hard/Good/Easy；S 返回牌组概览；
  T 打开统计；I 查看单卡信息；Ctrl+Z 撤销上次评分。
- 手册明确指导「大多数卡用 Space 答，食指留在 1 上应对遗忘」，且支持只用 Again/Good 双键的简化流。
- 每次作答的 **用时（毫秒）写入 revlog**，用于统计但不影响调度；默认 60 秒上限防走神污染数据
  （[Statistics - Anki Manual](https://docs.ankiweb.net/stats.html) Manual Analysis 节：`time` 字段）。

**统计**（[Statistics - Anki Manual](https://docs.ankiweb.net/stats.html)）：

- Future Due、日历热力图、Reviews、Card Counts、**Review Time（逐日复习用时）**、Review Intervals、
  Card Ease，以及 FSRS 三态分布图：**Card Stability / Card Difficulty / Card Retrievability**、
  Hourly Breakdown、**Answer Buttons（按新/young/mature 分层的四键分布与正确率）**、True Retention 表。

**FSRS 参数暴露**（[Deck Options - Anki Manual](https://docs.ankiweb.net/deck-options.html)、
[fsrs4anki tutorial](https://github.com/open-spaced-repetition/fsrs4anki/blob/main/docs/tutorial.md)、
[DeepWiki: FSRS Parameter Optimization](https://deepwiki.com/ankitects/anki/4.2-fsrs-parameter-optimization)）：

- Desired Retention 为「最重要设置」，默认 90%；参数与 retention 均为 **preset 级**（不同难度学科分 preset）。
- **FSRS Parameters 文本框直接可见可编辑**（17–22 个浮点参数）；Optimize 按钮从复习史梯度下降优化，
  内置 log-loss 门（新参数不优于旧参数则丢弃）与 relearning steps 健康检查。
- Compute Minimum Recommended Retention（<25.07）给出最小推荐保持率；**Simulator** 用真实记忆状态
  （difficulty/stability/retrievability）+ 当前参数模拟未来负载，改 retention 前可先看曲线
  （[The Optimal Retention wiki](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Optimal-Retention)）。

**note type/模板能力**（[Card Generation](https://docs.ankiweb.net/templates/generation.html)、
[Field Replacements](https://docs.ankiweb.net/templates/fields.html)、
[Adding/Editing](https://docs.ankiweb.net/editing.html)）：

- Mustache 风格字段替换 + **条件替换** `{{#Field}}/{{^Field}}/{{/Field}}`，条件放正面可控制「是否生成该卡」；
- 特殊字段 `{{Tags}} {{Deck}} {{Subdeck}} {{Card}} {{CardFlag}} {{FrontSide}}`；hint 字段 `{{hint:Field}}`；
  打字比对 `{{type:Field}}` / `{{type:cloze:Text}}`；TTS 与 `cloze-only` 过滤器；
- Cloze note type 单模板多卡（按 `{{cN::…}}` 序号生成）；`{{#c1}}…{{/c1}}` 按当前 cloze 序号条件显示提示；
  2.1.56+ 支持 **嵌套 cloze** 与单一 cloze 出现在多卡的语法。

**官方 Image Occlusion（23.10+ 内置）**（[Adding/Editing - Image Occlusion 节](https://docs.ankiweb.net/editing.html)、
[Changes in 23.10](https://changes.ankiweb.net/changes/23.10.html)、
[rslib notetype.rs](https://github.com/ankitects/anki/blob/57e67f84/rslib/src/image_occlusion/notetype.rs)、
[to-cloze.ts](https://github.com/ankitects/anki/blob/57e67f84/ts/routes/image-occlusion/shapes/to-cloze.ts)、
[imageocclusion.rs](https://github.com/ankitects/anki/blob/57e67f84/rslib/src/image_occlusion/imageocclusion.rs)）：

- IO 是 **cloze 的特例**：note type kind 为 `Cloze`（`OriginalStockKind::ImageOcclusion`），
  五个字段 **Occlusion / Image / Header / Back Extra / Comments**，前四个 `prevent_deletion`；
  正面模板即 `{{cloze:Occlusion}}` + `{{Image}}` + 前端 mask 渲染脚本。
- 形状序列化为 cloze 文本存进 Occlusion 字段：
  `{{c1::image-occlusion:rect:left=.1:top=.2:width=.4:height=.5}}`；
  shape 支持 `rect / ellipse / polygon / text`（text 不生卡），属性含 `left/top/width/height/rx/ry/points/angle/fill/scale/fs`，
  坐标为 0–1 归一化；`oi=1` 表示 occludeInactive（Hide All 模式）；**同一序号多形状 = 同卡分组**。
- 编辑器提供选择/缩放/矩形/椭圆/多边形/文本工具，两种出题模式（Hide One/Guess One 与 Hide All），
  每个形状（或组）生成一张卡，复习流与普通 cloze 完全一致（含 Toggle Masks 按钮）。

### 1.2 AnkiHub

（[AnkiHub 官网](https://www.ankihub.net/)、[Smart Search 社区帖](https://community.ankihub.net/t/smart-search/558434)、
[Smart Search 改版帖](https://community.ankihub.net/t/did-the-smart-search-feature-change/607271)）

- 核心是 **协作牌组**：订阅共享牌组，用户提交增/改/删 suggestion，管理员审批后自动推送全体订阅者——
  即「卡片的 PR + review 流」。
- **Smart Search**：上传讲义/PPT/PDF/纯文本，AI 匹配大型社区牌组中相关卡并帮助 unsuspend；
  2026 改版为按资源（resource）组织，移除相关度百分比滑杆。
- AI chatbot 内嵌 Anki：答疑 + 关联相关卡 + 生成练习题（Generate a Question 等 prompt）。

### 1.3 SuperMemo（增量阅读）

（[help.supermemo.org: Incremental reading](https://help.supermemo.org/wiki/Incremental_reading)、
[Priority queue](https://help.supermemo.org/wiki/Priority_queue)）

- 流水线：导入文章 → 阅读中 **extract** 重要片段 → 片段渐进转 **cloze 问答** → 进 SRS 复习；
  「被动重读在 200–300 天间隔以上召回不足，必须转 cloze」是其核心论断。
- **优先级队列**：每元素 0%（最高）–100% 优先级，逾期复习按优先级 auto-sort，超载时 auto-postpone
  牺牲低优先级材料，保证高优先级材料的目标保持率；子元素可 Priority:Spread 批量摊派。

### 1.4 Quizlet

（[Quizlet AI study tools](https://quizlet.com/features/ai-study-tools)、
[AI Study Era 博客](https://quizlet.com/blog/ai-study-era)）

- **Magic Notes / Smart Assist**：上传笔记/PPT/PDF 一键生成大纲 + 闪卡 + 练习测验 + 相关资源，
  全部可编辑再保存；生成物直接进 Learn/Test/Match 等模式。
- Learn 模式自 2017 年起做自适应掌握度调度（非 FSRS 系）。
- **Q-Chat AI tutor 已于 2025-06-30 退役**——纯对话式 tutor 独立入口被验证不可持续，AI 收敛回
  「生成→编辑→既有学习模式」工作流。这是对「AI 交互要挂在既有学习闭环上」的反面印证。

### 1.5 RemNote

（[Generating Flashcards with AI](https://help.remnote.com/en/articles/10102901-generating-flashcards-with-ai)、
[RemNote Reader](https://help.remnote.com/en/articles/6690975-learning-from-pdfs-and-files-with-the-remnote-reader)、
[AI Flashcards 特性页](https://www.remnote.com/feature/ai-flashcards)）

- AI 制卡交互范式：**选中内容 → Create AI Cards → 配置屏（模型档位/卡型/深度）→ 逐卡预览可编辑 →
  接受入库**；明确告知「小模型问题更直白、可能更合适」这种档位取舍。
- 关键调度决策：**AI 生成的卡不直接进 due 队列，而是进「Need to Learn」独立队列**，用户按 Learn new
  自主决定何时引入大批新材料——生成量与复习负载解耦。
- Reader 内：高亮→制卡、逐段「主旨候选卡」一键采纳、按标题/全文 Bulk Create、AI Tutor 回答可直接转卡、
  自带图像遮挡工具；portal 机制减少跨来源重复卡。

---

## 2. 差距清单（能力 × 竞品 × 我们现状 × 优先级）

优先级口径：P0 = 直接影响核心复习/制卡体验且可低成本追平；P1 = 明确差距、需要中等投入；
P2 = 战略级/需实机或后端大改；`—` = 我们已持平或领先。

| # | 能力 | 竞品标杆 | 我们现状 | 差距 | 优先级 |
|---|---|---|---|---|---|
| 1 | 复习四键 + 快捷键 + 预测间隔 | Anki（1–4/Space/Enter，按钮显示下次间隔） | RatingBar 四键 + 1–4/Space + 间隔预览 + keycap + swipe | 基本持平；Anki 有「双键简化流（只用 Again/Good）」与 I 键单卡信息，我们无 | P1（双键模式/卡片信息面板可静态做） |
| 2 | 单卡作答用时记录 | Anki revlog 逐次记录 time(ms)，60s 上限，供 Review Time 图 | 仅前端 session 总时钟，逐卡用时不落库 | 统计与 FSRS 模拟的底层数据缺失 | P1（前端可先做逐卡用时显示；落库属后端） |
| 3 | 撤销深度 | Anki Ctrl+Z 多步撤销链 | 单步 `undo_last_review`（前端 Z 键） | 多步撤销缺失，但单步已够主流程 | P2 |
| 4 | FSRS 参数可见/可编辑 | Anki 参数文本框 + Optimize + log-loss 门 + 健康检查 | 只暴露 3 项（新卡/复习上限、目标保持率）；参数黑盒 | 参数只读可视化都没有 | **P0**（只读可视化可静态做；Optimize 属后端） |
| 5 | FSRS 记忆态分布图 | Anki Stats：Stability/Difficulty/Retrievability 三分布 + True Retention + Answer Buttons 分层 | 热力图/评分分布/状态 donut，无记忆态分布 | 差三张核心 FSRS 图 | **P0**（数据已在 FSRS store，可静态做） |
| 6 | 负载模拟器 | Anki Simulator（真实记忆态 + 参数模拟未来负载） | 无 | 改 desiredRetention 前无预估 | P2（简化版可用现有参数纯前端模拟，列为候选） |
| 7 | 模板条件替换/特殊字段 | Anki `{{#Field}}`、`{{hint:}}`、`{{type:}}`、`{{FrontSide}}`、TTS | 模板字段契约 + cloze hint 渲染；无条件替换、无 type-in、无 FrontSide | 模板语言表达力差一代 | P1（能力矩阵文档 + hint/type-in 渐进） |
| 8 | Cloze 高级语法 | Anki 嵌套 cloze、单 cloze 多卡、`{{#c1}}` 按序号条件提示 | `{{cN::answer::hint}}` 基础解析 | 嵌套/多卡语法不支持 | P2 |
| 9 | AI 制卡交互（配置→预览→采纳） | RemNote 配置屏 + 逐卡预览编辑 + Need to Learn 隔离队列 | chat 内预览块 + agent 工具编辑；生成卡入队走显式 enqueue 确认 | 交互范式已接近；缺「生成卡默认隔离、Learn new 显式引入」的队列语义表达 | P1 |
| 10 | 讲义→已有卡匹配 | AnkiHub Smart Search（资源→卡匹配 + unsuspend） | 无（有库级搜索 `list_library_cards`） | 「以资源为中心反查已有卡」缺失 | P2（需嵌入检索） |
| 11 | 协作/审批流 | AnkiHub suggestion→审批→推送订阅者 | 单机；但有 OCC 版本、`_original_generation`、history 链，具备审计基座 | 多人协作非当前目标 | P2（不建议本期做） |
| 12 | 增量阅读 | SuperMemo extract→cloze + 0–100% 优先级队列 + auto-postpone | 无 extract 流；FSRS 队列无优先级维度 | 战略缺口；RemNote Reader 是现代化参照 | P2 |
| 13 | AI 生成物多形态 | Quizlet Magic Notes（大纲+卡+测验一次产出） | Anki 卡 + qbank 题分属两条 skill | 已有双形态，缺一键联动 | P2 |
| 14 | 对话式 tutor | Quizlet Q-Chat（已退役）；AnkiHub chatbot；RemNote AI Tutor | Chat 主产品本身即对话入口，工具面完整 | 我们架构反而是正解（Q-Chat 退役佐证） | — |
| 15 | Image Occlusion 完整闭环 | Anki 内置 IO：编辑器 + cloze 序列化 + 可复习可导出 | `_occlusion` 草稿 + 预览揭罩；无编辑器/grounding/导出 | 详见第 5 节 | **P0（第 2 轮真闭环）** |
| 16 | Agent 工具契约（bounded output/OCC/undo） | 无竞品对标（Anki 生态无 agent 工具面） | qbank/chatanki 双工具面，OCC+undo+截断标记成体系 | 我们领先；剩余是契约精确化 | P1（见第 4 节） |
| 17 | 确定性 QA + critic | AnkiHub 靠人肉审批；RemNote 提示用户手工编辑 | 26 码 QA lint + 查重 + grounded critic opt-in | 我们领先 | — |

---

## 3. 可静态落地子集（第 5 轮可做、不需实机）

以下各项均满足：纯前端/文档层、不动隐私 opt-in（`enableFsrsFeedback` 缺省行为不变）、
不依赖真机 Anki/AnkiConnect、可用现有 store/后端命令数据静态渲染与单测验证。

### S1. FSRS 记忆态可视化（对标 Anki Stats 三分布 + True Retention）——P0

- 在 `StatisticsScreen` 增加 Stability / Difficulty / Retrievability 直方图与 True Retention 表；
  数据源为现有 `getFsrsStats` / 卡片 `reviewState`（如后端聚合字段不足，先做「基于最近一次复习的诚实近似」，
  沿用该页既有的近似标注惯例）。
- 在调度设置区旁增加 **FSRS 参数只读展示**（参数向量 + 每参数一句话语义），对标 Anki 参数文本框的
  「可见性」而非「可编辑性」；不新增任何数据回传，不触碰 opt-in 开关。

### S2. 复习按键流补齐（对标 Anki Studying）——P0

- 双键简化模式（只显示 Again/Good，Space=Good），设置项本地持久化；
- I 键单卡信息面板（复习史、当前 stability/difficulty、下次到期）——数据来自现有 reviewState 与
  `review_stats`/get_cards 已返回字段；
- 逐卡作答用时的 **前端显示**（翻面耗时 + 评分耗时，60s 封顶显示，对齐 Anki 语义），先不落库；
- 评分后 toast 内联「撤销」入口（现有 Z 键能力的可发现性包装）。

### S3. 卡片模板能力矩阵 + hint 渐进（对标 Anki 模板语言）——P1

- 文档层：产出「本产品模板语言 vs Anki 模板语言」能力矩阵（条件替换/特殊字段/type-in/TTS/嵌套 cloze），
  作为 `list_templates` 字段契约的延伸章节；
- 前端层：cloze hint（`::hint`）在复习面未揭示态显示占位提示（`cloze.ts` 已解析 hint，仅差渲染分支确认/补齐），
  纯函数 + 组件级可单测。

### S4. 制卡交互「隔离队列」语义（对标 RemNote Need to Learn）——P1

- 静态可做部分：在闪卡 Today/Library 界面把「已生成未入队」的卡显式呈现为 **待学习（Need to Learn）**
  分组，与 due 队列视觉分离；「加入复习」按钮即现有 `enqueue_review` 的既有确认流，不改任何调度语义。
- Skill 文档层同步：明确「生成 ≠ 入队」的产品语义，与现有「入队须确认」的破坏性操作规则互为印证。

### S5. qbank 工具描述契约回补（见第 4 节）——P1

纯 schema 描述字符串修订 + vitest 契约快照对齐，无运行时行为变化。

**候选（第 5 轮若有余量）**：S6 简化版负载模拟器（纯前端用现有 desiredRetention 与卡片记忆态做
未来 30 天 due 曲线预估，标注为近似）；S7 评分分布按新/young/mature 分层（对标 Anki Answer Buttons）。

---

## 4. Agent 原生结合：qbank-tools bounded output 契约回补建议

### 现码事实（`qbank_executor.rs`）

仓库内实际存在 **三种截断标记形态**，工具描述未区分：

1. **question 对象**（`question_to_bounded_value`）：字段原位截断到 2000 字符 +
   同级布尔 `<field>_truncated: true` + `options[i].content_truncated` + 顶层 `fieldsTruncated: string[]`
   （含递归 `truncate_json_strings` 对嵌套 JSON 的路径式记录，如 `structured_data.pairs[0].left`）。
2. **submissions**（`qbank_get_submissions`）：`user_answer` 截断 + 同级布尔 `user_answer_truncated`。
3. **history**（`qbank_get_question_history`，`bounded_optional_text`）：`old_value`/`new_value` 是
   **对象 `{text: string, truncated: boolean}`，字段为空时为 `null`**——与前两种形态完全不同。

而 `qbank-tools.ts:600-613` 的工具描述只写「返回 history（field_name、old/new_value、operator、reason、
changed_at）」，未说明 old/new_value 的对象形状、null 语义与截断标记位置。Agent 按 question 对象的惯例
（同级 `_truncated` 布尔）理解时，会把 `{text, truncated}` 误当字符串直接拼接，或漏判 null。

### 回补建议（只精确化，不恢复大段重复说明）

原则：每条工具描述已有「2000 字符截断」总述，本次只补 **形状差异** 这一句话级信息；
截断上限、OCC 流程等通用规则不在单条描述里重复（这些已在 skill 系统提示的通用契约段落）。

1. **`builtin-qbank_get_question_history`** 描述追加一句：
   「`old_value`/`new_value` 为 `{text, truncated}` 对象（超 2000 字符时 `truncated=true` 且 `text` 已截断），
   字段无历史值时为 `null`；不使用 `<field>_truncated` 同级标记」。
2. **`builtin-qbank_get_submissions`** 描述现已写明 `user_answer` 超限截断，建议精确为
   「同级 `user_answer_truncated` 布尔标记」，与 question 形态的表述用词对齐（当前写法是对的，只统一措辞）。
3. **`fieldsTruncated` 语义精确化**（涉及 update/create/toggle 等返回 bounded question 的工具，共用一句）：
   现描述写「fieldsTruncated 标明截断」，建议精确为「顶层 `fieldsTruncated` 数组列出全部被截断字段路径
   （含嵌套 `structured_data` 内路径）」——递归路径记录是现码已有行为，但描述未提，agent 会漏检嵌套截断。
4. **不建议做**：把 history 的 `{text, truncated}` 改成同级布尔形态以统一三种形状——这是运行时行为
   变更（本轮禁改产品代码），且会破坏已有消费者；契约回补应以「描述如实反映现状」为界。
5. 配套：`docs/anki-agent-tools.md` 式的 qbank 工具面文档若后续建立，三种截断形态应立表说明；
   vitest 端已有 schema 契约测试的话同步快照（第 5 轮执行时确认测试文件位置）。

这一条与竞品无直接对标（Anki 生态没有 agent 工具面），属于我们领先位上的守成动作：
bounded output + 精确截断标记是防止 agent「以截断输出为源盲写回」的第一道防线
（chatanki 侧已有 `patch_value_suspected_truncated_source` 防御，qbank 侧靠描述精确性）。

---

## 5. 图像遮挡：Anki 官方 IO / Cloze overlay vs 我们 `_occlusion` 草稿

### 形态对比

| 维度 | Anki 官方 IO（23.10+） | 我们 `_occlusion` 草稿 |
|---|---|---|
| 数据落点 | Occlusion 字段内 cloze 文本：`{{cN::image-occlusion:rect:left=.1:top=.2:width=.4:height=.5}}` | `extra_fields["_occlusion"]` JSON：`{imageRef, boxes:[{x,y,w,h,label,clozeIndex}]}` |
| note type | Cloze kind 特例（`OriginalStockKind::ImageOcclusion`），5 字段：Occlusion/Image/Header/BackExtra/Comments | 不改 front/back/text，草稿附着在普通卡上 |
| 形状 | rect/ellipse/polygon/text（text 不生卡），含 angle/fill/scale 等属性 | 仅轴对齐矩形（x,y,w,h） |
| 坐标 | 0–1 归一化 | 0–1 归一化（一致，好迁移） |
| 分组/模式 | 同序号多形状 = 同卡；Hide One vs Hide All（`oi=1`） | clozeIndex 有序号语义但未用于生成多卡；单一揭罩模式 |
| 生卡 | 每形状（或组）一张真卡，进正常 cloze 复习流 | 附着于分段首张成功卡，不拆卡 |
| 编辑器 | 完整 mask 编辑器（选择/缩放/多边形/分组） | 无 |
| 坐标来源 | 用户手绘 | LLM 文字描述→启发式网格框（无视觉 grounding） |
| 导出 | 原生 APKG/同步即可复习 | 不进 APKG/AnkiConnect 导出 |

来源：[Anki Manual - Image Occlusion](https://docs.ankiweb.net/editing.html)、
[notetype.rs](https://github.com/ankitects/anki/blob/57e67f84/rslib/src/image_occlusion/notetype.rs)、
[to-cloze.ts](https://github.com/ankitects/anki/blob/57e67f84/ts/routes/image-occlusion/shapes/to-cloze.ts)、
本仓库 `src/components/anki/utils/imageOcclusion.ts`、`wrapup/18-sota-status.md`。

### 对第 2 轮「真闭环」方案选择的支撑结论

**应对标 Anki 的 IO-as-Cloze 形态（Cloze 特例），而不是自造独立 IO note 形态，也不是普通 Cloze 文本 overlay。**理由：

1. **导出兼容是闭环的定义**：真闭环 = 用户能在桌面 Anki 里复习遮挡卡。Anki 端唯一原生可复习形态就是
   IO note type（Cloze kind + Occlusion 字段 cloze 序列化）。导出时把 `_occlusion.boxes` 逐盒转成
   `{{c{clozeIndex}::image-occlusion:rect:left=…:top=…:width=…:height=…}}` 是**纯文本序列化**，
   我们的 0–1 坐标系与 Anki 完全同构，`clozeIndex` 直接映射 cloze 序号，转换器可先行（甚至可静态单测）。
2. **普通 Cloze（文本）overlay 不成立**：文本 cloze 无法携带几何信息，Anki 端渲染不出遮罩；
   只有 IO note type 的模板内置 mask 渲染脚本。
3. **内部预览协议不必迁移**：`_occlusion` 作为草稿协议保留（预览、编辑器的存储层），
   闭环缺的是三段：真实视觉 grounding（VLM 输出实体框而非文字→网格启发式）、遮挡框编辑器
   （对标 Anki mask editor 的最小子集：拖动/缩放/删除矩形即可，暂不做多边形）、
   APKG 导出端的 IO note type 生成（含 Image 字段媒体打包）。
4. **模式取舍**：第一版只做 Hide One（每盒一卡，不带 `oi`），Hide All（`oi=1`）与形状分组作为二期；
   这与我们 `clozeIndex` 现有语义（缺失补号、显式序号保留）最贴合。
5. **AnkiHub/RemNote 佐证**：两者的遮挡能力也都收敛在「矩形遮罩 + 既有复习流」上，
   多边形/花式形状不是差异化重点；差异化在「AI 自动出框的准确率」（我们的 grounding 缺口）。

---

## 6. 来源清单

- Anki Manual - Studying: https://docs.ankiweb.net/studying.html
- Anki Manual - Statistics: https://docs.ankiweb.net/stats.html
- Anki Manual - Deck Options (FSRS): https://docs.ankiweb.net/deck-options.html
- Anki Manual - Card Generation / 条件替换 / Cloze: https://docs.ankiweb.net/templates/generation.html
- Anki Manual - Field Replacements / 特殊字段: https://docs.ankiweb.net/templates/fields.html
- Anki Manual - Adding/Editing（Image Occlusion、嵌套 cloze）: https://docs.ankiweb.net/editing.html
- Anki 23.10 Changes（内置 IO 发布）: https://changes.ankiweb.net/changes/23.10.html
- Anki 源码 - IO note type 定义: https://github.com/ankitects/anki/blob/57e67f84/rslib/src/image_occlusion/notetype.rs
- Anki 源码 - 形状→cloze 序列化: https://github.com/ankitects/anki/blob/57e67f84/ts/routes/image-occlusion/shapes/to-cloze.ts
- Anki 源码 - IO cloze 解析: https://github.com/ankitects/anki/blob/57e67f84/rslib/src/image_occlusion/imageocclusion.rs
- FSRS4Anki tutorial: https://github.com/open-spaced-repetition/fsrs4anki/blob/main/docs/tutorial.md
- FSRS Optimal Retention wiki: https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Optimal-Retention
- DeepWiki - Anki FSRS Parameter Optimization: https://deepwiki.com/ankitects/anki/4.2-fsrs-parameter-optimization
- AnkiHub 官网: https://www.ankihub.net/
- AnkiHub Smart Search 社区帖: https://community.ankihub.net/t/smart-search/558434
- AnkiHub Smart Search 改版帖: https://community.ankihub.net/t/did-the-smart-search-feature-change/607271
- SuperMemo - Incremental reading: https://help.supermemo.org/wiki/Incremental_reading
- SuperMemo - Priority queue: https://help.supermemo.org/wiki/Priority_queue
- Quizlet AI study tools: https://quizlet.com/features/ai-study-tools
- Quizlet AI Study Era（含 Q-Chat 退役声明）: https://quizlet.com/blog/ai-study-era
- RemNote - Generating Flashcards with AI: https://help.remnote.com/en/articles/10102901-generating-flashcards-with-ai
- RemNote - Reader（PDF/AI Tutor/遮挡工具）: https://help.remnote.com/en/articles/6690975-learning-from-pdfs-and-files-with-the-remnote-reader
- RemNote - AI Flashcards 特性页: https://www.remnote.com/feature/ai-flashcards

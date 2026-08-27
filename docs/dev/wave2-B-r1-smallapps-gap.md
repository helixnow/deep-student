# Wave2-B 第 1 轮调研：四个小应用对标 SOTA 的差距清单

调研员报告（0824 Wave2-B r1）。仓库基线 `061b4815`（工作分支 `cursor/0824-wave2-desktop-subapps-a875`）。按约束：纯静态阅读 + WebSearch 外部对标，未编译、未跑测试、未改任何产品代码。

外部基准来源：Todoist 官方帮助（recurring dates / Quick Add / 2026 changelog）、Things 3.23 重复任务改版（2026-08 发布）、XMind 文件格式（content.json 多 sheet + resources/manifest 图片打包，含官方 xmind-sdk-js 的 manifest 写入约定）、DeepL（术语表/正式度/备选译法/文档翻译）与沉浸式翻译类逐段对照、Grammarly（AI Grader 自定义 rubric）与 Cambridge Write & Improve（CEFR 定级 + 句级高亮 + 多轮重交 + 进度图）。

## Step 22 已落地项复核（不重做）

两项均已确认在现码中生效，本报告不再将其列为差距：

1. **mindmap 解压预算 `5ffd4900`**：`src/features/mindmap/utils/importers.ts:180-198` 三条预算常量（单图 256 KiB / 数量 128 / 累计解压 8 MiB / 累计内联 8 MiB），`:250-302` `tryEmbedImage` 先按 advertised size 前置拒绝、再经 `readZipEntryWithLimit` 流式硬中断，`:310-328` `resolvePendingImages` 整次导入共享一份预算，超限降级为备注占位并计入导入报告。测试 `src/features/mindmap/utils/__tests__/xmindFormatImport.test.ts` 已覆盖。
2. **recite 统计 `1a0a7442`**：`reciteSrs` 已改名 `src/features/mindmap/utils/reciteStats.ts`，头注释明确「错误率排序，不是 SRS」（`:1-21`）；会话事件模型 `presented/missed/bulkRevealed` 粘性置位（`:38-49`），`commitReciteSession` 只对实际呈现/作答的空计样本、零翻开的全对会话也提交成功样本、删除节点/越界索引忽略（`:102-138`）；存储键改为 `mindmap-recite-stats:` 弃读旧失真数据（`:58-62`）。

但 Step 22 只修了统计模型本身，同文件族的**导航残留**仍在：`src/features/mindmap/components/shared/ReciteStatusBar.tsx:9-16` 复习导航仍用全局 `document.querySelector('[data-node-id="…"]')`，既未 `CSS.escape`（导入 id 含引号即非法 selector），也未限域到本实例容器（分屏/保活多实例可能滚错棵树）——画布键盘导航已按 `containerRef` 限域（`hooks/useMindMapKeyboard.ts`），此处应复用同一原则。列入下文残项 M5。

---

## 一、待办 + 模板（对标 Things 3.23 / Todoist）

### 现码能力基线

- 自然语言快速添加 `src/features/todo/quickAddParser.ts`（1075 行纯函数）：日期/时间/优先级/重复/提醒/#标签/~@清单/时长八类 token，中文优先 + 常用英文，全角归一 1:1 位置对齐、掩码涂空保稳定偏移、`tokens` 数组供输入框高亮（`:49-94`）。高亮回显这一点已与 Todoist Quick Add 的「识别即红色高亮」同档。
- 重复模型 `src/features/todo/types.ts:262-273`：`{freq: daily|weekly|monthly|yearly|weekdays, interval, byWeekday?}`；单步推进 `stepRepeatDate`（`:523-555`）、逾期跳过 `nextRepeatOccurrence`（`:563-578`），与后端 `compute_next_due_date` 对齐，纯固定日程制。
- 自动化域另有 `automationNlParser.ts` / `AutomationScheduleEditor`，与任务重复是两套并行语法。

### 差距清单

| # | 差距 | 外部基准 | 现码落点 |
|---|------|---------|---------|
| T1 | **无「完成后重复」（completion-based）模式**。现码只能从 `dueDate` 固定推进；「每次完成后 3 天」类任务（浇花、理发）会在逾期后被 `nextRepeatOccurrence` 的跳过逻辑排到错误的固定格点 | Todoist `every!` 语法；Things 区分 fixed schedule / after completion 两种模型 | `types.ts:523-578` 无 completion 锚点；`quickAddParser.ts:559-678` 无对应语法 |
| T2 | **重复规则无起止边界**。不支持 `starting/ending/for N weeks/until` | Todoist `every 2 weeks starting 3 Jan ending 31 Dec`、`everyday for 3 weeks` | `TodoRepeatRule` 无 `until`/`count` 字段（`types.ts:264-273`） |
| T3 | **月级重复不能锚定多日/特殊日**。`monthly` 只会从当前到期日 clamp 推进，无「每月 1 号和 15 号」「每月最后一个工作日」 | Todoist `every 1st and 15th`、`every last workday` | `stepRepeatDate` monthly 分支（`types.ts:543-544`）；解析侧 `matchRepeat` 无月内日语法（`quickAddParser.ts:559-678`） |
| T4 | **重排语义单一**。改期只改本次 `dueDate`，等价于永远「Make Exception」；没有「Update Rule」（把每周一改成每周二时同步改规则）的选择 | Things 3.23 的 Make Exception / Update Rule 双选 | `RescheduleMenu.tsx` 只写 `dueDate`；规则编辑与改期是两个不相通的入口 |
| T5 | **提前完成重复任务的语义未对标**。Things 3.23 刚把重复任务改成普通勾选框（提前完成→按规则生成下一次）；现码完成重复任务的滚动行为依赖后端 `step_due_date`，前端无「提前完成」与「Create Next Copy（提前起草下一次）」概念 | Things 3.23 | 前端无对应 UI；`nextRepeatOccurrence` 仅预览 |
| T6 | **NL 日期词汇覆盖差一档**：无 `end of month`/`mid January`/时段词独立使用（`in the morning`=09:00）/`someday`/`next weekday`；「6pm 已过则取明天」的就近语义也没有 | Todoist dates and time 帮助页 | `matchDate`（`quickAddParser.ts:291-484`）、`matchTime`（`:711-776`） |
| T7 | **无 deadline 与 due 的双日期区分**（Todoist 2024+ 把「开始做」与「最后期限」分开）| Todoist Deadlines | `TodoItem` 只有 `dueDate/dueTime`（`types.ts:23-44`） |
| T8 | 任务重复与自动化重复两套 NL 语法并存（`quickAddParser.matchRepeat` vs `automationNlParser`），词表演进容易漂移 | — | `quickAddParser.ts:559-678`；`automationNlParser.ts` |

### 本波可静态落地子集

1. **T6 词表扩展**：`matchDate`/`matchTime` 加 `end of month`、`月底/月末`、`中午` 独立词、`someday` 类；纯函数 + 既有测试范式（`__tests__` 目录已有同类测试），零契约变更。
2. **T2/T3 的解析层先行**：`matchRepeat` 识别 `每月1号和15号` / `every 1st and 15th` / `直到 X` 并在 `TodoRepeatRule` 增加可选 `byMonthDay?: number[]` / `until?: string`——序列化侧旧后端忽略未知字段自然降级（`parseRepeatRule` 的白名单需同步放行，`types.ts:277-305`）；但**推进语义**（`stepRepeatDate` 与后端 `compute_next_due_date` 对齐）属跨波，本波只做前端解析+展示+预览，不宣称后端生效。
3. **T4 的 UI 半步**：改期菜单在检测到 `repeatJson` 时给出文案提示「仅本次生效，重复规则不变」，把隐式语义变显式；真正的 Update Rule 需要写规则,可后置。
4. T1（completion-based）需要后端新增锚点字段与滚动逻辑，明确列为跨波项，不在本波静态落地。

### Agent 结合点

- `todo-tools` / `user-todo-tools` 技能已存在；agent 批量建任务时应复用 `parseQuickAddInput` 同一口径（把用户口语直接透传给 parser，而非让 LLM 自行猜 `dueDate` 格式），保证 chip 预览与 agent 创建结果一致。
- Todoist 2026 已把任务经 MCP 暴露给 agent；本仓库对应物是 `todoDriver` + agent 工具。差距项 T1/T2 落地后，工具 schema 的 `repeatJson` 说明需同步（`template-designer` 同理）。
- 「每周回顾」类 agent 剧本可直接消费 `TodoActiveSummary`（`types.ts:49-70`）与 recite/番茄统计,无需新后端。

---

## 二、思维导图（对标 XMind）

### 现码能力基线

导入面已较宽：`.xmind`（JSON/XML）、`.mm`、OPML、Markdown、`.mmap` 基础拓扑；图片带三重预算内联（见 Step 22 复核）；多 sheet 以 `meta.sheets` + `viewRootId` 切换器呈现（`MindMapContentView.tsx:500-510, 1089-1118`；`utils/sheetTabs.ts`）。

### 差距清单（均为 Step 22 后仍未修残项）

| # | 差距 | 现码落点 |
|---|------|---------|
| M1 | **应用内复制丢图**：结构化剪贴板白名单重建节点时只接 `note/collapsed/completed/style/blankedRanges/refs`，没有 `images` 字段——复制含图节点，图片无提示消失；Markdown 文本载体也无图片占位行 | `src/features/mindmap/utils/clipboardCodec.ts:200-215`（`sanitizeNode`）；对照 `refs` 有 `sanitizeRefs`（`:160-176`），`images` 无对应清洗函数 |
| M2 | **XMind 导出降级**：`buildXmindContentJson` 固定单 sheet（`id: 'sheet-1'`），注释明言不导出图片/图标/挖空/refs/折叠；不写 `resources/` 目录、`manifest.json` 的 `file-entries` 只登记 content/metadata 两项。「XMind 导入 → 编辑 → XMind 导出」丢图片并把多 sheet 压扁,且导出前无任何降级提示 | `src/features/mindmap/utils/exporters.ts:252-291`（`buildXmindContentJson` + `exportToXmindZip`） |
| M3 | **大纲窗口化固定 36px**：`OUTLINE_ESTIMATED_ROW_HEIGHT = 36` 直接用于 `floor(scrollTop/36)` 求首行、spacer 高度与目标定位；行实际含多行正文/备注/48px 图片缩略图时系统性偏差，深滚动定位错行、滚动总高度随窗口移动漂移 | `src/features/mindmap/views/outline/outlineVirtual.ts:22, 57-118, 124-130`；调用侧 `views/OutlineView.tsx`（拖拽时关窗口化、关 scroll anchoring 的保护仍在，但无实测高度缓存） |
| M4 | **JSON 导入图片无运行时清洗**：`importFromJson` 的 `ensureIds` 用对象展开保留任意字段（含 `images`），`image.src` 未做 data URL MIME/体积校验、无 http(s) allowlist，渲染器直接交给 `<img>`——本地 JSON 可借远程图片产生非预期网络请求 | `src/features/mindmap/utils/importers.ts:1176-1191`（`ensureIds` 展开）；渲染 `components/mindmap/nodes/NodeContent.tsx`、`views/outline/SortableOutlineNode.tsx` |
| M5 | **背诵导航未限域/未转义**：全局 `querySelector` 无 `CSS.escape`，多实例可滚错树（详见 Step 22 复核节末尾） | `components/shared/ReciteStatusBar.tsx:9-16` |
| M6 | **`MindMapImage` 未走公共类型出口**：`types/index.ts` 无该导出（本轮 grep 确认 0 命中），模型扩展未过公共 API 边界 | `src/features/mindmap/types/index.ts` |
| M7 | **多 sheet 仍是导航器而非独立画布**：所有 sheet 共树、共历史、共导出；对照 XMind 的 content.json 顶层 sheet 数组语义，当前是可接受的最小侵入形态，但需在导出（M2）与产品文案上明示降级 | `MindMapContentView.tsx:500-510`；`utils/sheetTabs.ts:17-41` |

外部对照要点：XMind 格式中图片属 `resources/`（旧版 `Attachments/`）且必须在 manifest 登记（官方 xmind-sdk-js 要求 `topic.image()` 后显式 `updateManifestMetadata(key, buffer)`），因此 M2 的图片回导技术路径清晰：收集 `node.images` 的 data URL → 解 base64 写 `resources/<hash>.<ext>` → topic 写 `image.src = "xap:resources/…"` → manifest 补 file-entries。多 sheet 回导可按 `meta.sheets` 逐个一级子树生成 sheet 对象。

### 本波可静态落地子集

1. **M1**：`clipboardCodec.ts` 增加 `sanitizeImages`（校验 `data:image/*;base64` 前缀 + 单图/累计体积上限，可直接复用 `importers.ts` 的 `MAX_INLINE_IMAGE_BYTES` 口径），`sanitizeNode` 白名单补 `images`；纯函数,单测即可锁定。剪贴板载荷版本号（`MINDMAP_CLIPBOARD_VERSION`，`clipboardCodec.ts:34`）向后兼容（新增可选字段不必升版）。
2. **M4**：抽同一个图片清洗函数供 `importFromJson` 复用——data URL 白名单 + 拒绝 `http(s)` 或经确认对话放行；纯函数。
3. **M5**：`CSS.escape(nodeId)` + 从 store 实例可达的容器 ref 限域；改动约十行。
4. **M2 的最小半步**：导出前检测 `doc` 含 images 或 `meta.sheets.length > 1` 时弹一次性降级提示（i18n 文案 + 既有导出对话框链路）；完整图片/多 sheet 回导（写 resources + manifest）是纯前端 JSZip 工作,量中等,可作为本波第二档。
5. **M6**：`types/index.ts` 补导出,一行。
6. **M3** 需要实测高度缓存 + 前缀和（或引入 variable-size virtualizer），改动面在 `outlineVirtual.ts` + `OutlineView.tsx` 两处且需覆盖拖拽启停/scroll restore,列为本波末档或下一轮。

### Agent 结合点

- agent 生成/追加导图已有 Markdown 粘贴真源（`pasteMarkdown.ts` 的 `markdownListToNodes`）,是 agent 产出结构的天然入口；M1 修复后 agent 复制/移植子树才不丢图。
- recite 统计（`reciteStats.ts` 的 `buildReviewQueue`）是现成的「难点画像」数据源：agent 可按 `smoothedErrorRate` 高的节点生成针对性问答或 Anki 卡（制卡链路已存在于作文侧 `generateCardsFromText`,可平移）。
- 多 sheet 元数据（`meta.sheets`）可作为 agent 的文档摘要锚点（「第 2 个 sheet 讲什么」）,无需新后端。

---

## 三、翻译（对标 DeepL / 沉浸式翻译）

### 现码能力基线

语向清单/对齐/会话偏好/prompt 判定已提成纯模块（`src/translation/*`）;术语表（`glossary: Array<[string,string]>`）、正式度、领域预设、流式翻译、双语对照（ComparisonView）、只读查看器、DSTU 持久化与保存失败重试条（`TranslationContentView.tsx:408-445`）均在。对照 DeepL：缺备选译法（点选单词换译并自动调整上下文）、文档格式保留翻译；对照沉浸式翻译：逐段对照有,但边界脆（见 F3）。

### 差距清单（按本轮侧重排序）

**F1 — isActive 收口不完整**（侧重项）

- 已收口的:document 级快捷键 `isActive === false` 不注册（`src/components/TranslateWorkbench.tsx:995-1037`,注释对齐 MindMap 守卫）；`autoFocusSource={isActive !== false}`（`:1156`）；作文侧同款守卫也在（对照组,见第四节）。
- 未收口的三处:
  1. **自动翻译 effect 无 isActive 守卫**（`TranslateWorkbench.tsx:795-809`）:非活跃保活标签页依赖「状态不变→签名不变」间接不触发,但恢复历史会话时 prompt 异步补签名（`:473-489, 492-528`）存在时序窗口——若 prompt 加载晚于其它参数变化,非活跃页也会发起流式翻译。守卫应显式而非巧合。
  2. **流桥快照无所有权/阶段语义**（评审已列,仍未修）:`useTranslationStream.ts:552-562` 任意 state（含初始空闲态）都发布,`:564-569` 卸载无条件清同 key——注释声称「无活跃流时返回 null」（`translationStreamBridge.ts:54-60`）与实现不符;同 key 双实例（分屏同一资源）任一卸载会清掉另一实例的快照。快照结构 `TranslationStreamSnapshot`（`translationStreamBridge.ts:10-18`）无 `phase`/`ownerToken`。
  3. **事件注册范式不统一**:翻译手写 `document.addEventListener`（`:1035-1036`）,作文用 `useEventRegistry` 声明式数组（`EssayGradingWorkbench.tsx:1266-1271`）。isActive 收口应统一走一个 helper,否则每个 workbench 各自把守卫写对一遍。

**F2 — prompt 来源状态仍是文案比对**（侧重项）

- `isPromptCustomized` 靠 trim 后命中已知模板字符串判定（`src/translation/promptPresets.ts:25-31`）;模板文案改版即把旧默认误判为自定义并作为 `prompt_override` 覆盖后端领域预设,反向则吞掉恰好雷同的自定义。
- 前端展示模板只有 5 域（`promptPresets.ts:13-19`）,后端另有 legal/medical 专属 system prompt（`src-tauri/src/translation/pipeline.rs:713-724`）:选法律/医学时编辑器回落显示通用模板,实际执行的却是后端专属模板;在这个「非实际 prompt」上改一个字即整段 override,行为跳变。
- 组件侧消费点:`TranslateWorkbench.tsx:239-256`（`knownDefaultPrompts` 集合、领域切换）、`:492-528`（会话加载）、`:759-761`（恢复默认）。

**F3 — 分段边界理想化**（侧重项）

- `splitParagraphs` 仅 `/\n{2,}/`（`src/translation/segmentation.ts:12-13`）:CRLF 的 `\r\n\r\n`、含空格空行 `\n  \n` 都不断段;
- `splitSentences` 把任意英文句点当终止符（`:19-22`）,小数/缩写/URL 误切;分桶用空格拼回（`:66-79`）丢 CJK 原始间距与 Markdown 换行;
- 测试只覆盖纯 LF 与规则标点（`translationBehavior.test.ts:54-79`）,较多一侧被分桶的核心路径无用例。
- 对照沉浸式翻译类产品:逐段对照是核心体验,分段错位直接可见。

**F4 — 其余对标缺口**（非本轮侧重,列存档）:无备选译法/点选替换（DeepL alternatives）;无术语表的语法感知应用（DeepL 术语表会按语境变形,现码 glossary 是字面对传给后端）;`languages.ts` 清单非 `as const`、`resolveSessionPrefs` 对持久化输入仅 truthy 回退（`sessionPrefs.ts:29-33`）,无白名单归一。

### 本波可静态落地子集

1. **F3 全量**:纯函数修复——先 `replace(/\r\n?/g,'\n')` 归一,段落正则改 `/(?:\n[ \t]*){2,}/`,句子切分加小数/缩写保护（负向断言或最小状态机）,可行时 `Intl.Segmenter` 优先、现规则兜底;补 CRLF/带空格空行/小数/无标点长句/句数悬殊/空文本用例。全部在 `segmentation.ts` + 测试,零组件改动。
2. **F2 结构化来源的纯模块层**:`promptPresets.ts` 新增 `type PromptSource = { kind:'domain-default'; domain:string } | { kind:'custom'; text:string }` 与迁移函数（旧字符串→一次性比对归类）,补 legal/medical 的展示模板 key（i18n 文案可先行,即使只是后端 prompt 的译文摘要,也消除「显示通用、执行专属」的错觉）;组件接线可同波做（`TranslateWorkbench.tsx:239-256, 492-528` 三个消费点集中）。
3. **F1 的 2**:流桥加 `phase: 'idle'|'streaming'|'done'|'error'` 与 `ownerToken`,`clear` 校验所有权;`useTranslationStream.ts:552-569` 发布/清理同步带 token。纯 zustand 模块 + hook,测试可覆盖挂载/开始/完成/切 key/卸载/同 key 双发布者。
4. **F1 的 1**:自动翻译 effect 加 `if (isActive === false) return;` 一行 + deps 补 `isActive`。
5. F1 的 3（事件注册范式统一）建议与作文侧一起收（共享 helper）,本波可做可缓。

### Agent 结合点

- 观察投影已注册:`TranslationContentView.tsx:475-491`（字数/段落数/保存态）。缺**动作**声明——`startTranslation`/`cancel`/`setGlossaryEntries` 是低风险动作候选,落点在同一 `registerContentAgentSurface` 调用。
- F2 修好后,agent 才能安全地替用户改 prompt（结构化来源可区分「agent 设置的领域预设」与「用户手写」,不会互相覆盖）。
- glossary 是 agent 的天然接口:从用户术语库/历史译文生成 `Array<[string,string]>` 直接注入,无需后端变更;DeepL 的「备选译法保存进术语表」交互可由 agent 对话式替代。

---

## 四、作文批改（对标 Grammarly / Write & Improve）

### 现码能力基线

多轮批改（rounds + 轮次切换守卫 `essayContentState.ts:74-85`）、维度分（`overall_score` + `dimension_scores_json`,`EssayGradingWorkbench.tsx:1052-1059`）、模式/模型/文体/学段/自定义 Prompt 五参配置（`essayGradedSnapshot`,`essayContentState.ts:51-60`）、多模态图片批改 + OCR、建议应用/撤销（`:1450-1474`）、存为笔记（`:1477-1512`）、生成 Anki 卡（`:1516+`）。对照 Grammarly AI Grader 的「自定义 rubric 评分」,五参配置已接近;对照 Write & Improve,缺 CEFR 类标准化定级与跨轮进度图,句级 inline 高亮的结构化程度也不明（批改结果是 Markdown 文本）。

### 差距清单（按本轮侧重排序）

**E1 — dirty 注册与保存入口分裂**（侧重项,本域最高优先）

- **只注册了 dirty checker,没注册 save handler**:`EssayGradingWorkbench.tsx:233-239` 调 `registerContentDirtyChecker('essay', …)`,但全文件无 `registerContentSaveHandler`。关窗确认链路里 `createContentApp.tsx:62-67` 以 `hasContentSaveHandler` 决定是否提供「保存并关闭」（`contentDirtyRegistry.ts:85-87`）——作文永远 `offerSave=false`,用户面对脏内容只有「放弃修改」一个正路,与翻译侧（`TranslateWorkbench.tsx:423-429` 注册了 save handler）行为分裂。
- **保存入口散在四处、语义各异**:
  1. 正文/题目/图片的**正式落盘只发生在批改成功后**:`finalizeCompletedGrading` 写轮次 → 题目/图片 context 存 settings KV（`essaySessionContextKey`,`EssayGradingWorkbench.tsx:1019-1035`）→ `dstuMode.onSessionSave`（`:1064-1074`）→ 基准修正（`:1075-1085`,含「上下文保存失败保留 dirty」的正确处理）。**不批改就没有任何显式保存入口**。
  2. 草稿兜底:localStorage debounce 1s（`:508-512`,键 `essay_draft_<sessionId>` / `essay_draft_new`）,批改成功且 context 落盘后才清（`:1036-1043`）。草稿是隐式恢复通道,不消 dirty、不参与关窗决策。
  3. `handleSavePrompt` 单独保存 Prompt 到 settings + sessionMeta（`:1321-1337`）。
  4. `handleSaveAsNote` 是导出而非保存（`:1477-1512`）。
- 后果:用户写了题目、传了图,不想立即批改,关窗时只能「放弃」（实际有草稿兜底但 UI 宣称丢弃）——语义错误且吓人。
- 附带核对项:dirty 基准重置 effect（`:223-231`）在 `initialSession?.id` 变化时把题目/图片基准清空,依赖 `restoreFromDstu` 时序再修正（注释已说明）;save handler 落地时要与该时序共同验证,避免「保存并关闭」存了空题目。

**E2 — 批改结果缺结构化句级反馈**:W&I 的核心体验是句级高亮 + 逐条错误反馈 + 修改重交闭环;现码 `gradingResult` 是整段 Markdown,建议应用/撤销（`:1450-1474`）说明已有某种局部建议机制,但无稳定的「错误span→类型→建议」结构,agent 与 UI 都难以精确消费。这是 prompt/协议层工作,跨波。

**E3 — 无跨轮进度可视化**:`overall_score`/`dimension_scores_json` 已按轮存储,W&I 式「最近 10 次提交的分数折线」纯前端即可。

**E4 — 无标准化定级锚点**:W&I 输出 CEFR;现码分数无外部标尺。可先在模式说明/结果头部由 prompt 约定输出学段/CEFR 参考,轻量。

### 本波可静态落地子集

1. **E1 主修**:注册 `registerContentSaveHandler('essay', …)`——保存动作 = 「context KV 落盘（复用 `serializeSessionContext`,`essayContentState.ts:155-163`）+ 正文存入草稿或 sessionMeta + `patchPersistedBaseline` 消 dirty」,不触发批改。落点集中:`EssayGradingWorkbench.tsx:233-239` 旁新增一个 effect,保存闭包经 ref 每帧更新（照抄翻译侧 `saveCurrentSessionRef` 范式,`TranslateWorkbench.tsx:398-429`）。测试范式已有:`contentDirtyIntegration.test.tsx` 用翻译工作台做过同链路集成测试,可平移。
2. **E3**:轮次分数折线/维度雷达,消费既有 `dimension_scores_json`,纯前端组件。
3. E2/E4 涉及批改 prompt 与结果协议,列为下一波（需要与 LLM 输出格式共同设计,不宜静态硬啃）。

### Agent 结合点

- 观察投影已注册:`EssayContentView.tsx:202`（essay agent surface）;命令面板事件 `LEARNING_GRADE_ESSAY` / `LEARNING_ESSAY_SUGGESTIONS` 已带 targetResourceId 定向 + isActive 广播过滤（`EssayGradingWorkbench.tsx:1273-1317`）,agent 触发批改的通路是现成的。
- E1 修好后 agent 才能实现「替用户保存进度」;E2 的结构化反馈落地后,agent 可按错误类型统计生成个性化练习（对齐 Grammarly 的 insights 方向）,并与 Anki 制卡链路（`:1516+`）串联成「错误→卡片」闭环。

---

## 附:四应用共性观察

1. **isActive/保活守卫各写各的**:翻译手写 listener、作文 useEventRegistry、mindmap containerRef 限域、todo 的 workbench 聚焦门禁（`todoShellNav.ts`）——四种范式解决同一个「多实例保活谁响应」问题。收敛为 workbench 导出的统一 helper 是横切性价比最高的一项（与 `docs/0824-quality-review/todo-templates.md` 的既有建议一致）。
2. **「保存并关闭」能力不均**:翻译有、作文无、mindmap/todo 各有自己的脏检查体系。`contentDirtyRegistry` 的 checker/save 双注册应成为内容型 workbench 的验收基线。
3. 本报告所有行号基于 `061b4815`;引用的三份评审文档中,mindmap 篇的 P0（解压预算）与 P1 之一（recite 统计）已由 Step 22 消解,其余结论经本轮逐条复核仍与现码一致。

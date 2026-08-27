# Wave2-E 第 3 轮审阅 · UI（09）

- 审阅角色：0824 Wave2-E R3「审阅员-UI」。模型 claude-fable-5-thinking-high。
- 约束遵守：未改产品代码、未跑测试、未 commit。
- 审阅对象：`AnkiQaFlagBadge.tsx`、`ankiCardsBlock.tsx` 挂载区、
  `AnkiCriticSummaryBanner.tsx`（本轮新建）、locale `agent.critic.*`、r1-09 基线报告。
- **快照声明**：本审阅基于工作区未提交状态（tip `17446b1f` + 第 3 轮各角色的
  working-tree 改动）。审阅期间同轮实现者仍在落码——审阅前半程 grep 到
  `CriticSummary` 前端零命中，后半程 `AnkiCriticSummaryBanner` 已挂载；
  文中行号均为快照时点实测（Read 核对），若后续再有改动以最终 diff 为准。
  已确认在场的第 3 轮 UI 相关改动：`AnkiCriticSummaryBanner.tsx`（新建）、
  `ankiCardsBlock.tsx`（import + 挂载 + `AnkiCardsBlockData` 增字段）、
  `TauriAdapter.ts`（CriticSummary/GenerationStats 分支）、
  `ankiCardsBlockState.ts`（类型 + 归一化函数）、双语 locale
  `agent.critic.persistFailures` 新增、后端 `emit_critic_summary` 改
  serde 序列化补齐 5 字段。

---

## 1. QA badge 卡级语义 vs 任务级 summary：**未混淆，badge 契约零触碰**

### 1.1 badge 本体未被触碰（硬证据）

`AnkiQaFlagBadge.tsx` **不在 git status 修改列表中**，与 r1-09 §3.2 记录的契约
逐项比对一致：

- 单卡徽标仍是 button，`aria-expanded` / `aria-controls`（useId 防同屏重复）、
  `data-testid="chatanki-qa-flag-badge"` + `data-severity`、严重度形状+文本双通道
  （Info 圆 / Warning 三角 / WarningOctagon 八角）、点击 `stopPropagation`
  （卡片本体点击是翻面/编辑）——全部原样。
- `AnkiQaFlagsSummaryChip` 仍为 `role="note"` +
  `data-testid="chatanki-qa-flags-summary"`，仅 `flaggedCardCount > 0` 渲染。
- 三个卡级挂载点（编辑头部 :800、模板渲染卡下方、纯文本卡）与块级 chip 挂载
  （:3112-3116）均未改动语义，仅因上方插入 banner 行号整体下移。
- `ankiQaFlags.ts` 未改：`parseCardQaFlags` 仍只读 `_qa_flags`，
  `CRITIC_QA_FLAG_CODES`（`llm_critic` / `llm_critic_revised`）与后端
  `anki_critic.rs` 常量一致。

### 1.2 banner 与 badge/chip 的语义切分（判定：清晰，符合 r1-09 §3.2 红线）

新建 `AnkiCriticSummaryBanner`（挂载于 :3108-3109，chip **之前**）：

- **通道独立**：banner 消费 `toolOutput.criticSummary`（任务级事件载荷），
  badge/chip 消费卡片 `extra_fields._qa_flags`（卡级留痕）。r1-09 明令的三条
  红线全部守住——没改 badge 的 testid/aria 契约、没把 summary 塞进
  `_qa_flags` 通道、没抢占 chip 的 testid（banner 用独立的
  `chatanki-critic-summary` + `chatanki-critic-{sentence,degraded,skipped,gold,persist-failures}` 子 testid）。
- **文案自区分**：banner 首行带 `agent.critic.title`（"AI 质检终审"）前缀，
  与 chip 的"N 张卡片带质检标记 · 建议复查后再导出"不会读混。
- **事件层无污染**：TauriAdapter 新分支只 patch `toolOutput.criticSummary /
  generationStats`，不动 status/progress/cards，且不在 `retryRelevantEvent`
  白名单内（r3-08 §6.1 预警的误触 retry reconcile 未发生）。
- banner 与 chip 都用 `role="note"`：两个相邻 note 在 ARIA 语义上合法
  （note 非唯一性 landmark），不构成"抢占"。

### 1.3 两个"设计内分歧"场景（记录，非破坏）

1. **`enable_qa_pass=false`（"不要 QA 留痕"契约）**：`_qa_flags` 不落盘 →
   badge/chip 均不渲染，但 critic 裁决统计照常执行 → banner 仍会显示
   "标记 {{flagged}}"。用户会看到任务级"标记 3 张"却找不到任何带徽标的卡。
   这是后端契约（留痕关、观测不关）的忠实呈现，不是 UI bug；若后续有困惑
   反馈，可在 banner 追加一行"已按你的设置关闭卡面留痕"类提示（新词条）。
2. **口径不同源**：chip 的 `flaggedCardCount` 统计**一切** `_qa_flags`
   （lint + critic），banner 的 `flagged` 只统计 critic flag 裁决数，两个数字
   本就可以不同；另外 `GenerationStats.flagged_cards` 反映 critic **前**的
   lint 计数（r3-08 §6.3 已预警）——目前 generationStats 无 UI 消费者，
   未来渲染时勿与 banner 的 `flagged` 混排。

### 1.4 badge 相关的后端 wire 变化核对（第 2 轮遗留）

第 2 轮新增的 `_content_provenance`（`anki_gold_set.rs:53`，JSON 字符串值）
对 badge 零影响：`parseCardQaFlags` 只读 `_qa_flags`；`isInternalAnkiField`
的 `_` 前缀谓词自动把新字段挡在编辑列表与正文之外；聊天块编辑保存
（`handleSave` 以 `toStringRecord(card.extra_fields)` 为基底、编辑列表已滤
`_` 字段）会把 `_qa_flags` 与 `_content_provenance` 原样带回，不会冲掉。
连带确认一个审计语义：用户在聊天块改完 critic 修订卡后，badge 仍显示
"由 AI 终审自动修订"——这是留痕（历史事实）语义，非破坏。

**结论：badge 卡级语义未被破坏；卡级/任务级两条通道无混淆。**

---

## 2. 孤儿词条是否接上：**agent.critic.* 全部接上；agent.occlusion.* 仍孤儿**

对照 r1-09 §4 清单逐条核对（快照时点 grep + Read 实证）：

| 词条 | r1 状态 | 本轮快照状态 |
|---|---|---|
| `agent.critic.flaggedFlag` / `revisedFlag` | 已消费（badge） | 不变，仍由 `AnkiQaFlagBadge.tsx:40-43` 消费 |
| `agent.critic.title` / `summary` / `skippedOverBudget` / `goldReferences` / `degraded` | ❌ 孤儿 | ✅ **全部由 banner 消费**（AnkiCriticSummaryBanner.tsx :119/:125/:136/:141/:122） |
| `agent.critic.persistFailures` | 不存在 | ✅ 本轮双语新增且立即消费（:146），中英对称（diff 核对） |
| `agent.critic.goldReferences` 的 wire 数据 | 无（后端 emit 缺字段） | ✅ 后端 `build_critic_summary_event` 改为对 struct 整体 serde 序列化，`gold_references` 等 5 字段随之上 wire；adapter 归一化 `goldReferences` 后 banner `>0` 才显示——链路打通 |
| `agent.occlusion.*` 全家（含 `imageAlt` / `revealBox`） | ❌ 孤儿 | ❌ **仍孤儿**：occlusion 预览 `<img alt="">`（ankiCardsBlock.tsx:553）未接 `imageAlt`；`ImageOcclusionOverlay.tsx:123` 仍硬编码中文 aria-label（`revealBox` 备而未用）。r1-09 §7 插入点 4 在本快照未落 |
| `chatV2.json` occlusion 四键 | ❌ 孤儿 | ❌ 仍孤儿（两套语义重复继续都没人用） |

补充：`localeKeys.test.ts` 只钉词条**存在性/中英对称**，不代表消费——
`agent.occlusion.invalidSpec` 在测试里被钉但 `src/` 零消费者，勿误读为已接线。

**结论：本轮任务范围内的 critic 词条孤儿已全部接上（且新增词条无新孤儿）；
occlusion a11y 词条在快照时点仍未接，若本轮无人认领应记回台账。**

---

## 3. 只读预览边界：**仍完好，无写回流**

对 r1-09 §5 的四道证据在当前快照逐一复核：

1. `FlashcardPreviewBlock.tsx`（`src/features/generative-ui/components/`）：
   **不在修改列表**，全文复读确认仍是纯展示（zod schema + Card/Badge 渲染，
   零 action、零 invoke、零回写）。
2. `generative-ui.ts`（`src/features/chat/skills/builtin-tools/`）第 8 条硬约束
   原文在位（:69）："flashcard-preview 仅用于展示；禁止添加保存 action。
   制卡、QA/critic 与入库统一交给 anki_cards 管线。"
3. `ChatV2AnkiAdapter`：`src/` 下仍无该模块文件；守护测试
   `cardGenerationSurfaces.source.test.ts`（遍历 src/ 断言无同名文件 +
   三处入口源码 `not.toMatch` import）与 `pdfSelectionToolbar.source.test.ts`
   均未被改动。
4. **本轮新增代码不引入写路径**：banner 组件零 invoke、零 action（仅
   useTranslation + 图标 + cn）；TauriAdapter 新分支只写块 `toolOutput`
   观测字段（前端展示态，非持久化）；`ankiCardsBlockState.ts` 新增的是
   类型与纯归一化函数。聊天块内既有写点（卡编辑 `update_anki_card` :2331、
   `saveCardsToLibrary` / 导出）均属 anki_cards 管线自身职能，与
   flashcard-preview 无关，且本轮未动。occlusion 预览的
   `invoke('vfs_resolve_resource_refs')` 为只读资源解析。

`startGeneration` 双入口（不变量 8）顺带复核：`selectionCardGeneration.ts` 与
`generateCardsFromText.ts` 均不在修改列表，守护测试在位，完好。

---

## 4. 非阻断观察项（建议记入台账，供第 4 轮清理）

1. **挂载处注释已过时 + 冗余 cast**：`ankiCardsBlock.tsx:3108` 注释与 r3-04
   文档均称"字段尚未收进 `AnkiCardsBlockData`"，但同轮 adapter 角色已把
   `criticSummary?: AnkiCriticSummary` 正式收进接口（:191-201 区）。挂载处的
   `(data as { criticSummary?: unknown } | undefined)?.criticSummary` cast
   已无必要，可直接传 `data?.criticSummary`。两位实现者时序交错所致，
   纯清理项，不影响运行语义。
2. **同一载荷三套解析器**：adapter 内联 `pickNum/pickStr`、
   `ankiCardsBlockState.normalizeAnkiCriticSummary`（快照时点**零运行时消费者**，
   连同 `normalizeAnkiGenerationStats` 为死导出）、banner 自带
   `parseAnkiCriticSummary`。三处 snake/camel 兼容逻辑重复，存在漂移风险；
   建议收敛为 adapter 调用 `normalizeAnkiCriticSummary`（其注释本就自称
   "契约以 ankiCardsBlockState 为准"），banner 保留自己的展示层收紧即可。
3. **负数口径不一致（无实害）**：adapter 的 `pickNum` 放行任何有限数
   （含负数），banner 的 `readCount` 收紧为 `>0` 取整。最终展示由 banner
   把关，无实害；若未来别处直接读 `toolOutput.criticSummary` 需自行防负。
4. **generationStats 已入 toolOutput 但无 UI**、`TaskCompleted` 新带
   `completed_with_warnings` 但块 UI 未渲染专属文案（"带警告完成"词条依旧
   不存在，与 r1-09 §4 判断一致）——均属"先接数据后做呈现"的预埋，非缺陷。
5. **degraded 态隐藏统计句**是刻意设计（降级时全部视同 keep，统计无意义），
   与后端语义一致，不要当 bug 修。

---

## 5. 结论速览

| 审阅问题 | 判定 |
|---|---|
| QA badge 卡级语义是否被任务级 summary 破坏/混淆 | **否**——badge 文件零触碰、契约逐项比对一致；banner 走独立数据通道 + 独立 testid + 自带标题前缀，两个设计内分歧场景（qa_pass=false、flagged 口径）已记录为契约呈现而非缺陷 |
| 孤儿词条是否接上 | **critic 全家已接上**（含 goldReferences 的 wire 数据补齐、persistFailures 新增即消费）；**agent.occlusion.* 仍孤儿**（alt="" / 硬编码 aria-label 未修，快照时点） |
| 只读预览是否仍无写回流 | **是，边界完好**——FlashcardPreviewBlock/守护测试/硬约束全部未动，本轮新增代码零持久化路径 |

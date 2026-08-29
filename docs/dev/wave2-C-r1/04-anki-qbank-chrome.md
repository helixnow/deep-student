# 0824 Wave2-C R1 扫描台账 04 — anki 任务台 + 题库/练习 移动 chrome

- 扫描员：anki+qbank 移动 chrome（第 1 轮，静态审阅）
- 分支：`cursor/0824-wave2-mobile-uiux-a875`（HEAD `29ca02d9`），基线对照 `v0.9.44`
- 红线遵守：只评移动 chrome（顶栏/返回/右侧动作数/触控目标/桌面组件滥用/可达回退）。未触碰 FSRS/出题/评分/store 服务层。
- 闪卡只读不变量核验：`ankiCardsBlock.tsx` 内 **无** `save_to_library` 写回流（grep 全文件 0 命中；该串只出现在 locales、`selectionCardGeneration`、`generateCardsFromText` 等 E 域文件）；`ChatV2AnkiAdapter` 仅存在于 `src/features/chat/debug/chatAnkiIntegrationTestPlugin.ts`（debug 目录），无生产挂载。✅

## 机制基线（判定依据）

- `DsButton` 尺寸契约（`src/components/ui/buttonPrimitiveContract.ts:64-84`）：**所有尺寸在 <lg 断点默认 `h-[var(--touch-target-size)]` = 44px**（`shadcn-variables.css:41-42`），仅 `lg:` 压缩为桌面 28–36px。
- `Input` 基元（`src/components/ui/shad/Input.tsx:15`）：自带 `min-h-[var(--touch-target-size)]` + `[@media(pointer:coarse)]:!min-h-[...]`。
- `SegmentedControl`（`src/components/ui/SegmentedControl.tsx:40,42`）：item 自带 `[@media(pointer:coarse)]:!min-h-11`（含 important）。
- `Checkbox` 基元（`src/components/ui/shad/Checkbox.tsx:15`）：**只有 h-4 w-4，无 coarse 热区** —— 调用点必须各自手补 `before:-inset-3.5`。
- 结论：调用点上大量 `[@media(pointer:coarse)]:!min-h-11` 散点，多数是「先用无条件 `h-6/h-7/!h-auto` 打掉基元 44px 默认，再用 coarse important 补回」的对症补丁。

---

## 页 1：聊天卡片块（`src/features/chat/plugins/blocks/ankiCardsBlock.tsx`，仅移动 UI 壳）

| # | 核验项 | 结论 | 依据 file:line |
|---|---|---|---|
| 1 | 顶栏 | ✅ 不适用（内容块，无自绘顶栏；编辑头部 L784 为块内局部条） | ankiCardsBlock.tsx:784 |
| 2 | 返回 | ✅ 展开/折叠对称（底部工具条「收起」L2874-2883 + 主按钮 L1546-1554），无死路 | ankiCardsBlock.tsx:1546,2878 |
| 3 | 右侧动作数 | ⚠️ 卡片右上触屏常显 3 个 44px 悬浮钮（引用/编辑/删除），手机上占 ~140px 宽遮卡面右上角；底部交付条已把低频动作（导出/同步）收进 AppMenu ✅ | ankiCardsBlock.tsx:882-936（isTouchPrimary 常显），1616-1649（菜单收纳） |
| 4 | 触控目标 | ❌ 展开列表批量选择 `Checkbox` 16px 裸用、无 coarse 热区扩展（对照 QuestionBankManageView:686 的 `before:-inset-3.5` 模式缺失）；布局切换钮 `!h-8 !w-8` 靠 `after:-inset-1.5` 手工凑 44 | ankiCardsBlock.tsx:2971-2977（违规），2867（手工 hack） |
| 5 | 桌面组件滥用 / 可达回退 | ✅ 牌组名走 Popover（触屏可用）L1586-1614；触屏 hover 依赖均有 coarse 常显回退（L1037 `coarse:opacity-60`、L893/911/928 常显分支） | ankiCardsBlock.tsx:1037,891-913 |

仅 chrome 违规：
1. **[触控目标] ankiCardsBlock.tsx:2971-2977** —— 批量选择 Checkbox 无热区扩展。**v0.9.44 既有债**（选择流 + Checkbox 在 0.9.44 已存在，当时也没热区）。
2. **[散点债] ankiCardsBlock.tsx:1465,1505,1519,1533,1550,1562,1579,1591,2879,3014,3025,3035（`min-h-10 coarse:!min-h-11` ×12）；2902,2912,2924,2940（`min-h-8 coarse:!min-h-11` ×4）** —— DsButton <lg 默认已 44px，这批 min-h 全是冗余散点。**0824 回归引入的模式债**（该文件 coarse 命中 1→24，来自 `651d5852`/`e206237b` "enlarge leftover" 系列与 G 波合并 `79362482`）。

## 页 2：制卡任务台（`src/features/anki-tasks/`）

| # | 核验项 | 结论 | 依据 file:line |
|---|---|---|---|
| 1 | 顶栏 | ✅ `useMobileHeader('task-dashboard')` 注册，标题/菜单统一；小屏抑制 subtitle；workbench 嵌入时不接管（`!workbenchWindowId` enabled 位，0824 新修）；页内 `wb-at-header` 有 `!isSmallScreen` 守卫，无双顶栏（与 INVENTORY L27 销案一致） | AnkiTasksApp.tsx:450-459,506 |
| 2 | 返回 | ✅ 顶级视图走 showMenu 汉堡 + MobileSlidingLayout 抽屉（承载统一应用导航），无孤立分区标签 | AnkiTasksApp.tsx:453-456,466-483 |
| 3 | 右侧动作数 | ✅ 顶栏 0 动作；排序/刷新/恢复 3 钮下放到列表工具条（可 flex-wrap 换行），纯图标钮均带 aria-label/文案 | AnkiTasksApp.tsx:747-763 |
| 4 | 触控目标 | ⚠️ 主行 `min-h-[44px]` ✅（SessionRow:262）；移动端行内 24px 图标簇已隐藏、操作收入展开区 44px 钮 ✅（SessionRow:304,404-445）；但桌面工具条/属性区 `h-7`/`h-6` 无条件覆盖打掉基元默认再 coarse 补回（见下） | SessionRow.tsx:262,404-445；AnkiTasksApp.tsx:513-528,559,593 |
| 5 | 桌面组件滥用 / 可达回退 | ✅ CommonTooltip 仅桌面分支；移动端「恢复卡住任务」补了可见文案（触屏无 hover tooltip 的诚实回退）；列表底部预留手势安全区；加载失败≠空态，均有重试钮 | AnkiTasksApp.tsx:756-762,500-503,767-781 |

仅 chrome 违规：
1. **[反机制覆盖] AnkiTasksApp.tsx:513,518,523,559,593,737；FailedTasksPanel.tsx:131,155,171** —— 无条件 `h-7`/`h-6`/`h-5 w-5` 打掉 DsButton/Input 的 <lg 44px 默认，再逐点 `coarse:!h-11` 补回。缺 44px 是 **v0.9.44 既有债**（当时 coarse 命中 0/0/1），散点补法是 **0824 引入的模式债**（0→15/18/3）。
2. **[冗余散点] AnkiTasksApp.tsx:694-701** —— SegmentedControl item 再叠 `coarse:!min-h-11`，基元 L40/42 已带同款 important 类；注释所述 app.css 冲突已由基元解决。0824 回归。
3. **[微目标] AnkiTasksApp.tsx:740** —— 搜索清除钮 `!h-auto !w-auto !p-0`（12px 图标）在 fine-pointer 小屏无热区；coarse 已补 44。低危，v0.9.44 结构 + 0824 补丁。

## 页 3：题库管理（`src/components/QuestionBankManageView.tsx`）

| # | 核验项 | 结论 | 依据 file:line |
|---|---|---|---|
| 1 | 顶栏 | ✅ 无自绘顶栏（宿主 ExamContentView/learning-hub 统一提供）；工具栏为页内条 | QuestionBankManageView.tsx:477-531 |
| 2 | 返回 | ✅ 宿主注册硬件返回（非根态先页内返回再收右屏，overlay 档） | ExamContentView.tsx:1692-1716 |
| 3 | 右侧动作数 | ⚠️ 选中态吸底条右侧最多 6 钮（难度/标签/重置/删除/分隔/取消），<sm 时全部退化为纯图标 + `hidden sm:inline` 文案，可访问名随 display:none 丢失，仅剩 title（触屏无效） | QuestionBankManageView.tsx:1107-1162（尤其 1143-1161） |
| 4 | 触控目标 | ✅ 移动卡片分支整体达标：全选行 min-h 44（L651）、卡片「⋯」`!h-11 !w-11`（L738）、行内展开 4 宫格 44px（L751-800）、Checkbox 手补 `-inset-3.5` 热区（L686,812,843）、清除搜索 `-inset-3` 热区（L500）、分页 coarse 44（L1176,1189） | 同左 |
| 5 | 桌面组件滥用 / 可达回退 | ✅ <768 表格换卡片列表（明确注释「hidden md: 列在窄屏信息残缺」）；确认/批量面板均为吸底内联条而非模态；安全区 padding L646,1095；≥768 coarse（iPad）表格分支的 AppMenu 触发钮有 coarse 44 | QuestionBankManageView.tsx:640-649,937-1008,890 |

仅 chrome 违规：
1. **[可访问名] QuestionBankManageView.tsx:1143-1161（及 1122,1139 同模式）** —— 吸底条图标钮 <sm 无 aria-label（文案 `hidden` 不进可访问树，title 触屏不可达）。**v0.9.44 既有债**（该条 0.9.44 已存在）。
2. **[拼写不一致] 全文件 `coarse:!min-h-[44px]`（L513,519,527,539,548,560,573,967,983,1026,1039,1066,…）vs 其他文件 `!min-h-11`** —— 同值两写法，逃逸 grep/lint 归一。既有债 + 0824 增量（18→32）延续了旧拼写。

## 页 4：题目内联编辑器（`src/components/QuestionInlineEditor.tsx`，仅移动 chrome）

| # | 核验项 | 结论 | 依据 file:line |
|---|---|---|---|
| 1 | 顶栏 | ✅ 无自绘顶栏；底部操作栏钉底不随滚动 | QuestionInlineEditor.tsx:1266 |
| 2 | 返回 | ✅ 取消走未保存内联确认条（非模态），放弃/继续编辑 44px | QuestionInlineEditor.tsx:1234-1263 |
| 3 | 右侧动作数 | ✅ 底栏 2 钮（取消/保存）+ 左侧预览切换，克制 | QuestionInlineEditor.tsx:1267-1301 |
| 4 | 触控目标 | ⚠️ 达标但全靠散点：加选项 `h-5` + coarse !h-11（L825）、删选项 `!w-4 !h-4` hover 显 + coarse 44 常显（L870）、标签删除 chip coarse h-7 + `after:-inset-y-2` 纵向凑 44，**横向 inset-x-0 不扩，窄 chip 宽度可 <44**（L1039） | 同左 |
| 5 | 桌面组件滥用 / 可达回退 | ✅ 输入均带 `coarse:text-[16px]` 防 iOS 缩放（L764,867,976,1004,1018,1172,1185）；hover-only 控件均有 coarse 常显回退（L870 opacity-70、L1113 opacity-100） | 同左 |

仅 chrome 违规：
1. **[触控目标-横向] QuestionInlineEditor.tsx:1039** —— 标签删除 chip 热区只纵向扩展。低危。**0824 增量**（16→20 中的新点）。
2. **[散点债] L825,1018,1026,1078,1147,1249,1257,1271,1283,1291** —— 同「打掉默认再补回」模式。既有债（16 点）+ 0824 增量（4 点）。

## 页 5：练习页（`src/components/practice/` + `ReviewQuestionsView.tsx`）

| # | 核验项 | 结论 | 依据 file:line |
|---|---|---|---|
| 1 | 顶栏 | ✅ 无自绘顶栏，宿主 ExamContentView Tab 栏 + learning-hub 统一顶栏承载 | ExamContentView.tsx:2376-2430 |
| 2 | 返回 | ✅ 页内返回钮（tag 选择器 L471-481、高级模式 L512-522，icon 尺寸=基元 44）+ 宿主硬件返回 overlay 档（practice→launcher→list 逐级） | PracticeLauncher.tsx:471,512；ExamContentView.tsx:1703-1715 |
| 3 | 右侧动作数 | ✅ 启动台无右上动作堆叠；模式卡 2×2 栅格 min-h-[76px] | PracticeLauncher.tsx:423-458 |
| 4 | 触控目标 | ✅ 整体达标：AnswerSheetGrid 无条件 `min-h-11`（唯一机制化写法，AnswerSheetGrid.tsx:105）；CountStepperRow 有注释说明的 coarse 守卫（CountStepperRow.tsx:7,66,85）；Daily/Timed/Mock/PaperGenerator 各钮均 44 达标 | 同左 |
| 5 | 桌面组件滥用 / 可达回退 | ✅ 数字输入 `coarse:text-[16px]`（TimedPracticeMode.tsx:336,366；MockExamMode.tsx:433,449）；启动台安全区 padding（PracticeLauncher.tsx:373）；ReviewQuestionsView 展开钮 hover 透明在 coarse 有 `text-muted-foreground/40` 常显回退（ReviewQuestionsView.tsx:355） | 同左 |

仅 chrome 违规：
1. **[冗余散点] practice 全目录 ~30 处 `coarse:!min-h-11`（DailyPracticeMode.tsx:313,321,340,423,450,456；TimedPracticeMode.tsx:345,388,474,500,518,543,551；MockExamMode.tsx:385,397,519,577,597,641,649；PaperGenerator.tsx:257,263,394,421,462,493；PracticeLauncher.tsx:478,494,519；ReviewQuestionsView.tsx:435,673,687,706,723,742,775）** —— 未覆盖高度的 DsButton 本就 44，这批全部冗余；覆盖了高度的（`h-9`/`!h-auto min-h-8`）属反机制覆盖。**全部为 0824 回归引入**（各文件 coarse 命中 0→3/0→6/…，见 `2dfa532f`、`d8ef992b`、`228d7524`、`8a12f125`）。

## INVENTORY.md 相关行核对

- `docs/dev/mobile-uiux-unify/INVENTORY.md:11` task-dashboard 行备注「页内仍有 `wb-at-header`」已过时——L27 销案（小屏守卫）与代码（AnkiTasksApp.tsx:506 `!isSmallScreen`）一致。建议下轮把 L11 备注改为「wb-at-header 已加小屏守卫」，避免误报。
- learning-hub / chat-v2 行覆盖了练习页与卡片块的宿主顶栏，本次核验未见与清单矛盾。

## 机制化建议（不改域逻辑，只收敛 chrome 写法）

1. **走 DsButton 默认，桌面压缩改用 `lg:` 前缀**：契约已保证 <lg 全尺寸 44px。调用点凡 `h-6/h-7/!h-auto !py-1` 无条件覆盖的，改成 `lg:h-7`/`lg:!py-1`（移动默认存活），随后**整批删除配对的 `[@media(pointer:coarse)]:!min-h-11` 散点**（本台账标注的 ~90 处中约 2/3 可直接删）。首批收益最大文件：AnkiTasksApp、SessionRow、QuestionBankManageView、ankiCardsBlock 交付条、practice 全目录。
2. **Checkbox 基元补 coarse 热区**：在 `shad/Checkbox.tsx:15` 加 `relative [@media(pointer:coarse)]:before:content-[''] ...before:-inset-3.5`，删掉 QuestionBankManageView:686,812,843 的手抄，并顺带修掉 ankiCardsBlock:2972 的裸 16px（本轮唯一硬违规）。
3. **iOS 缩放守卫下沉基元**：`coarse:text-[16px]` 散布在 QuestionInlineEditor/Timed/Mock 等 ~10 处，应进 `Input`/`Textarea` 基元（Input 已有 min-h 先例）。
4. **禁止新增散点 `!min-h-11`**：仿照现有 `ds-components/no-arbitrary-font-size`（buttonPrimitiveContract.ts:28 注释）加 eslint 规则，拦截调用点新写 `[@media(pointer:coarse)]:!min-h-11|!min-h-\[44px\]`，并把两种拼写归一为 token（`min-h-[var(--touch-target-size)]`）。
5. **卡片右上悬浮 3 钮（ankiCardsBlock:882-936）**：建议触屏收敛为「编辑 + ⋯」两钮（引用/删除入 AppMenu），与交付条 L1616 的收纳原则一致。仅壳层调整，不动卡片数据流。

## 既有债 vs 0824 回归 总表

| 项 | 定性 |
|---|---|
| ankiCardsBlock 批量 Checkbox 无热区（2972） | v0.9.44 既有债 |
| QuestionBankManageView 吸底条 <sm 可访问名丢失（1143-1161） | v0.9.44 既有债 |
| `!min-h-[44px]` 拼写分裂 | v0.9.44 既有债（0824 延续） |
| anki-tasks / practice / ankiCardsBlock 的 coarse 散点模式（0→15/18/24/30） | 0824 回归引入（G 波 "enlarge leftover" 系列：症状修对了，机制走偏） |
| QuestionInlineEditor 标签 chip 横向热区不足（1039） | 0824 增量 |
| INVENTORY.md L11 备注过时 | 文档陈旧（0824 修复后未回写行备注） |

无一项建议触碰 FSRS、出题、评分、store 服务层；闪卡只读不变量完好。

# 0824 G 总攻：Anki / 练习 / 作文域收口

日期：2026-08-25  
分支：`cursor/0824-g-fix-anki-cde6`  
基线：`origin/cursor/0824-cde6` @ `362dd2dfc`

## 结论

0824 已按域摘入 Generative UI 的核心实现，但不是
`origin/Generative-UI-0824` 的直接后代。当前域不再整体合并 G 分支，而是在最新
0824 上修复后续 D/F/卡库提交覆盖掉的 G 触控约束。未修改或推送 `main`、
`cursor/0824-cde6`。

本次采用逐块并集：

- D：保留 Anki QA、critic、图像遮挡、特殊 token/模板装配语义；
- F：保留作文建议撤销、存为笔记、锚定替换和安全脏基准；
- G：恢复本域 coarse-pointer 下 44px 最小热区；
- 新入口：错题与作文的制卡继续统一走 `cardAgent.startGeneration`。

## 关键裁决

### 制卡入口与 GenUI 边界

- `generateCardsFromText`、`selectionCardGeneration` 均调用
  `cardAgent.startGeneration`，非阻塞启动
  `start_enhanced_document_processing`。
- 不恢复 `ChatV2AnkiAdapter`、`anki_tool_call` 或阻塞收集式 UI 路径。
- `flashcard-preview` 保持只读；GenUI 不注册 `save-to-library` handler。
- 持久化、QA/critic 与审计继续由 `anki_cards` 管线负责。

### ReviewQuestionsView

- 保留 D 的错题选择、行内展开、行内二次确认和现有 44px 操作栏结构。
- 生成卡片只处理已选错题，调用共享 `generateCardsFromText`。
- 补回展开卡片中“快速重做”的 44px coarse-pointer 热区。

### EssayGradingWorkbench / GradingMain / ResultPanel

- 保留 F 三件套：
  - 建议采纳后的反向锚定撤销；
  - 批改结果存为笔记；
  - `before`/`after` + 稳定 key 的建议锚定签名。
- 保留 D 的“生成卡片”常显入口，输入为原文与批改结果，不另建制卡管线。
- 恢复结果栏轮次、复制、存笔记、导出、重试和制卡动作的 44px 触控语义；
  工具栏在 coarse pointer 下同步升至 44px，避免命中框与布局高度冲突。

### AnkiCardsBlock / 遮挡预览

- `_qa_flags` 继续结构化渲染且不拼入卡背；critic 的
  `llm_critic` / `llm_critic_revised` 审计 code 不变。
- `_occlusion` 继续 fail-closed 解析；支持 data/HTTPS、本地 asset 与 VFS 图片，
  同 clozeIndex 成组揭开，鼠标与键盘操作不冒泡到翻面/编辑动作。
- 保留 CardAgent 的模板集合、字段规则、token 估算和特殊 token 边界。
- 恢复卡片编辑、删除、引用和更多操作的 44px coarse-pointer 热区。

### Library / Today / practice

- Library 保留手动建卡与 `.apkg` 导入，导入继续调用
  `import_apkg_to_library`，成功后刷新卡库和到期队列。
- 恢复搜索、筛选/排序、批量动作、空态 CTA 与分页的 44px 触控热区。
- Today 空卡库保持建库引导和 0% 进度，不误显示“今日全部完成”或 100%。
- streak 优先使用完整复习日志，后端不可用时才回退每卡最近复习记录；提示文案与
  该真实/回退语义对齐。
- PracticeLauncher / DailyPracticeMode 保留空题库引导、按题库隔离的每日进度与
  打卡数据，并恢复目标、月份导航、重试和启动动作的 44px 热区。

## 回归覆盖

新增或补强：

- ReviewQuestionsView 已选错题 → 共享制卡入口；
- ResultPanel 锚定采纳/撤销 + 存笔记 + 制卡组合；
- Library 空态 `.apkg` 导入、后端参数、刷新与成功反馈；
- Today 空卡库不是伪完成态；
- streak 的今天/昨天补齐、断档与历史最长连续日。

验证命令：

```bash
npx vitest run \
  tests/vitest/generative-ui/flashcardDisplayOnly.test.ts \
  src/components/anki/utils/__tests__/imageOcclusion.test.ts \
  src/components/anki/__tests__/ImageOcclusionOverlay.test.tsx \
  tests/vitest/chat-v2/plugins/blocks/AnkiCardsOcclusionPreview.test.tsx \
  tests/vitest/chat-v2/plugins/blocks/AnkiCardsQaMedia.test.tsx \
  src/features/anki/__tests__/generateCardsFromText.test.ts \
  src/features/chat/services/__tests__/selectionCardGeneration.test.ts \
  tests/vitest/anki/cardforge/CardAgent.test.ts \
  src/components/__tests__/ReviewQuestionsView.confirmation.test.tsx \
  src/components/essay-grading/__tests__/ResultPanel.actions.test.tsx \
  src/essay-grading/essayContentState.test.ts \
  src/essay-grading/suggestionAnchors.test.ts \
  src/essay-grading/ocrPlaceholders.test.ts \
  src/essay-grading/textStats.test.ts \
  src/essay-grading/markerParser.test.ts \
  src/features/workbench/apps/content/__tests__/contentDirtyIntegration.test.tsx \
  tests/vitest/question-bank-ai-grading-stream.test.tsx \
  tests/vitest/flashcards/LibraryScreen.test.tsx \
  tests/vitest/flashcards/TodayScreen.emptyLibrary.test.tsx \
  tests/vitest/flashcards/reviewActivityStreak.test.ts
npm run typecheck
```

结果：

- Vitest：20 个测试文件、189 个用例全部通过；
- TypeScript：`tsc --noEmit -p tsconfig.json` 通过。

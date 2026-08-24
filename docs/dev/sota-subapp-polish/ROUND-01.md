# Round 01 — 竞品对标审阅与落地

- 开始：2026-08-23
- 审阅模型：`claude-fable-5-thinking-xhigh`
- 实现模型：`claude-fable-5-thinking-high`
- 状态：12/12 审阅完成；P0 落地进行中

## 本轮 12 个审阅席位

| 席位 | 模块 | 竞品 | 状态 |
|------|------|------|------|
| R1-01 | files / Learning Hub Finder | Finder / Explorer / Obsidian | 完成 |
| R1-02 | notes 工作区 | Obsidian / Notion / Typora | 完成 |
| R1-03 | chat | ChatGPT / Claude / Cursor | 完成 |
| R1-04 | mindmap | XMind / MindMaster / Canvas | 完成 |
| R1-05 | textbook / PDF / 阅读 | Preview / Acrobat / MarginNote | 完成 |
| R1-06 | exam / 题库练习 | Quizlet / 作业帮 | 完成（[报告](./R1-06-exam.md)） |
| R1-07 | translation | DeepL / 沉浸式翻译 | 完成 |
| R1-08 | essay | Grammarly / 批改网 | 完成 |
| R1-09 | flashcards / Anki | Anki / SuperMemo / Quizlet | 完成（[报告](./R1-09-flashcards.md)） |
| R1-10 | workbench 桌面壳 | macOS Tahoe / Sequoia | 完成 |
| R1-11 | todo / pomodoro / 系统工具 | Things / Forest / Linear | 完成 |
| R1-12 | preview / media / browser / sandbox | Quick Look / VLC / Safari / CodePen | 完成 |

## 审阅结论摘要（P0）

已确认、本轮优先落地：

1. **files**：右键菜单把 `image`/`file` 映射成 `note`（`LearningHubSidebar.tsx` 一处 switch 漏修），打开走错应用、删除/还原风险。
2. **textbook**：`previewPersistence.mergeBase` 全量带上 `highlights`，触发后端 OCC，阅读进度不落盘、书签保存必弹假错。
3. **translation**：默认 `customPrompt` 作为 `prompt_override` 永久覆盖领域预设，7 种领域实际失效。
4. **essay**：轮次导航静默覆盖未批改修改稿，1s 后草稿被冲掉（数据丢失）。
5. **workbench**：`pointerEngine` 武装阈值 1px，与标题栏 3px 注释不一致，双击 zoom 易被吞、最大化易误撕出。
6. **todo**：`TodoMainPanel` 仍用 legacy `currentView === 'todo'` 门禁，学习桌面下 j/k、`/`、`n`、Space 等全部失效。
7. **exam**（R1-06 补发）：每日一练进度死数据——后端 `get_daily_practice` 恒返 `completed_count: 0`，前端 `setDailyPractice` 无调用方，进度条 / 达标庆祝 / 续练全链路失效。

## 关键 P1（本轮尽量落地）

- chat 命令 `visibleInViews` 未含 `workbench`，桌面模式下快捷键整体不可用。
- notes 宽/中窗 `mod+\` 切换侧栏是空操作。
- notes `parseInitialResource` 回退用了不存在的 `mindmap_` 前缀（真前缀 `mm_`）。
- Finder `Cmd+A` 遇 Caps Lock 失效；`enterFolder` 面包屑竞态。
- essay 脏基准被 `initialSession` effect 重置，批改成功后关窗误报未保存。
- 双页 PDF 翻页只步进 1 页，同 spread 无视觉变化。
- 番茄多重投影 + 结束无切闪卡/回待办联动。
- PDF 壳层搜索与阅读器全文搜索双轨分叉。
- exam 打卡达标硬编码 `>=10` 题、自评 `markCorrect` 重复提交双计、限时/模拟考不持久化。
- flashcards 调度设置藏在统计页且 guide 13 仍称"不可调"；`fsrs_rate` 不上报作答用时；撤销仅单级。

## 落地席位（实现代理，文件互斥）

| 席位 | 范围 | 独占写权 |
|------|------|----------|
| I1 | files 类型映射 + 键盘 + enterFolder | `LearningHubSidebar.tsx`、`FinderFileList.tsx`、`finderStore.ts`、类型工具 |
| I2 | textbook 进度/书签持久化 | `previewPersistence.ts` 及测试 |
| I3 | translation 领域预设管线 | `TranslateWorkbench.tsx` 及测试 |
| I4 | essay 轮次确认 + 脏基准 | `EssayGradingWorkbench.tsx` 及相关 |
| I5 | 拖拽武装阈值 | `pointerEngine.ts`、相关测试 |
| I6 | todo 快捷键门禁 | `TodoMainPanel.tsx` 及相关 |
| I7 | chat 命令 workbench 可见 | `chat.commands.ts` 及相关 |
| I8 | notes 侧栏 + 导图前缀 | `NotesWorkspaceApp.tsx` 及相关 |
| I9 | PDF 双页步进 | `EnhancedPdfViewer.tsx` 及相关 |
| I10 | 番茄投影收敛 + 休息期联动 | 番茄窗/全局药丸/状态栏（互斥于 I6） |

复审席位待落地后派出（`claude-fable-5-thinking-xhigh`）。

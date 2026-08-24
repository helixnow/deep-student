# 子应用 SOTA 对标打磨中枢

- 日期：2026-08-23 启动，2026-08-24 完成 Round 01 合流
- 分支：`cursor/sota-subapp-polish-2399`
- 状态：Round 01 已收尾（审阅 12/12、落地全部合流入中枢）；Round 02 计划已排（见 [ROUND-02.md](./ROUND-02.md)）
- 目标：把学习资源管理器全部子应用的功能、UI/UX、以及学习桌面（Workbench）表现，对标真实竞品打磨到 SOTA。

## 范围

覆盖 workbench 已注册应用与其背后的 learning-hub / feature 实现：

| 模块 | typeId | 主要竞品对标 |
|------|--------|----------------|
| 资源库 / 访达 | `files` | macOS Finder、Windows 资源管理器、Obsidian 文件树 |
| 笔记工作区 | `notes` | Obsidian、Notion、Typora、Logseq |
| AI 对话 | `chat` | ChatGPT、Claude Desktop、Cursor Chat |
| 知识导图 | `mindmap`（经 notes 打开） | XMind、MindMaster、Obsidian Canvas |
| 教材 / PDF | `textbook` | Preview.app、Acrobat、MarginNote、LiquidText |
| 题目集 / 练习 | `exam` | Quizlet、Anki 练习面、作业帮 |
| 翻译精读 | `translation` | DeepL、沉浸式翻译、欧路词典 |
| 作文批改 | `essay` | Grammarly、批改网 |
| 图片 / 普通文件 | `image` / `file` | Preview.app、Photos |
| 文件预览 | `file-preview` | Quick Look、Preview.app |
| 闪卡 | `flashcards` | Anki、SuperMemo、Quizlet |
| 待办 | `todo` | Things 3、Todoist、Reminders |
| 番茄钟 | `pomodoro` | Forest、Focus To-Do |
| 任务看板 | `taskDashboard` | Linear、Things 今日视图 |
| 模板 / 技能 / 设置 | `templates` / `skills` / `settings` | Notion templates、Cursor Settings |
| 沙箱 | `sandbox` | CodePen、JSFiddle |
| 内置浏览 | `browser` | Safari、Arc |
| 桌面壳层 | Dock / 窗口 / Exposé / Apps | macOS Tahoe / Sequoia |

## 轮次纪律

1. 每轮至少 10 个只读审阅子代理（`claude-fable-5-thinking-xhigh`），按模块对标竞品，产出缺陷 / bug / 优化清单。
2. 落地修复由实现子代理执行（`claude-fable-5-thinking-high`），文件写权互斥；跨席共享文件（如 `EnhancedPdfViewer.tsx`、`LearningHubSidebar.tsx`）由中枢合并代理收口。
3. 修复后由独立复审子代理（`claude-fable-5-thinking-xhigh`）核对回归与遗漏。
4. 进度、方案、竞品差距写入本目录，并持续提交到专属分支 PR。
5. 用户未明确说停止前，继续下一轮。

## 分支模型

- 中枢分支 `cursor/sota-subapp-polish-2399` 为唯一集成真源，文档只在中枢改。
- 卫星席位在 `cursor/<seat>-<hash>` 分支上开发，完成后由中枢合并代理 fetch + merge（保双方功能，不丢测试），冲突在中枢解。
- Round 01 已合流卫星：`cursor/learning-hub-finder-polish-a9c5`（files 十项）、`cursor/deepstudent-reader-landing-d033`（PDF/教材阅读）、`cursor/preview-media-browser-polish-8dd9`（preview/browser/media）。

## 进度索引

- [ROUND-01.md](./ROUND-01.md) — 第 1 轮审阅与落地（已收尾，含各席完成状态与提交清单）
- [ROUND-02.md](./ROUND-02.md) — 第 2 轮计划（11 个席位，待派发）
- [BACKLOG.md](./BACKLOG.md) — 跨轮积压与优先级（Round 01 已完成项已勾除）
- [R1-06-exam.md](./R1-06-exam.md) / [R1-09-flashcards.md](./R1-09-flashcards.md) — 专项审阅报告

## 已知残留（不阻塞 Round 02 开工）

- workbench 子集存在 7 个**中枢历史遗留**红灯测试（合并前后完全一致，非本次合流引入）：
  `workbenchWindowsChromeLayoutContract`（2）、`p11-workbench-desktop` 快照恢复、`DockContextMenu` 键盘、`DockWindowList` 焦点、`StatusBar` Windows inset、`NotesSearchOverlay` quick-open 分组。已列入 Round 02 R2-11 席位清零。

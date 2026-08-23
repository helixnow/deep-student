# 子应用 SOTA 对标打磨中枢

- 日期：2026-08-23
- 分支：`cursor/sota-subapp-polish-2399`
- 状态：持续进行（用户未明确停止前不中断）
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
2. 落地修复由实现子代理执行（`claude-fable-5-thinking-high`），文件写权互斥。
3. 修复后由独立复审子代理（`claude-fable-5-thinking-xhigh`）核对回归与遗漏。
4. 进度、方案、竞品差距写入本目录，并持续提交到专属分支 PR。
5. 用户未明确说停止前，继续下一轮。

## 进度索引

- [ROUND-01.md](./ROUND-01.md) — 第 1 轮审阅与落地
- [BACKLOG.md](./BACKLOG.md) — 跨轮积压与优先级

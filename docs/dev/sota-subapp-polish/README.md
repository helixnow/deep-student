# 子应用 SOTA 对标打磨中枢

- 日期：2026-08-23 启动，2026-08-24 完成合流与 W10 总检
- 分支：`cursor/sota-subapp-polish-2399`
- 状态：Round 01 与合流后第二波补强已收尾；审阅 12/12、落地与文档同步完成
- 交付：**可交付**。类型检查无业务错误，变更相关测试无新增红灯；4 个中枢基线失败与剩余产品风险已显式登记
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
- 已合流卫星：
  - `cursor/learning-hub-finder-polish-a9c5`（files 十项，`1d9a6287`）
  - `cursor/deepstudent-reader-landing-d033`（PDF / 教材阅读，`f5f658e6`）
  - `cursor/preview-media-browser-polish-8dd9`（preview / browser / media，`f11356c0`）
  - `cursor/files-preview-fixes-901a`（补扫归并，`63d74b95`）
  - `cursor/workbench-shell-wave2-98eb`（桌面壳第二波，`1d73d793`）

## 进度索引

- [ROUND-01.md](./ROUND-01.md) — 第 1 轮审阅、落地、第二波补强与 W10 最终验证
- [ROUND-02.md](./ROUND-02.md) — 第 2 轮初始计划（部分项目已在第二波落地，最终状态以 BACKLOG 为准）
- [BACKLOG.md](./BACKLOG.md) — 跨轮积压与优先级（W10 已按最终中枢代码勾除完成项）
- [R1-06-exam.md](./R1-06-exam.md) / [R1-09-flashcards.md](./R1-09-flashcards.md) — 专项审阅报告

## W10 验证与交付结论

- `npx tsc --noEmit`：生成被忽略的 `src/version.ts` 后 0 错误。
- 最终 rebase 后变更相关 vitest：108 文件 / 1168 用例，1167 通过；唯一失败是已知 `StatusBar` Windows inset。chat 合流暴露的 5 个旧契约红灯已清零。
- 已知基线红灯定向复核：3 文件 / 43 用例，39 通过 / 4 失败。
- 结论：当前分支达到本轮「可交付」标准；没有为过检查删除功能，也未改动无关业务模块。

## 剩余风险

- 4 个**中枢历史遗留**测试失败：`workbenchWindowsChromeLayoutContract`（2）、`DockContextMenu` 键盘焦点、`StatusBar` Windows inset；均非本轮新增，继续列入 R2-11。
- Exposé 活体 DOM 缩放的 heap OOM 根因尚未消除，目前只有重窗降级 / 停绘止血。
- 限时练习 / 模拟考试仍缺重启续考与多窗口会话隔离；Finder 网格仍缺统一缓存缩略图管线。
- W10 未运行仓库全量 vitest、Tauri / Rust 全量测试及桌面端性能手测；完整清单见 [BACKLOG.md](./BACKLOG.md)。

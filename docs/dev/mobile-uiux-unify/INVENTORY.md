# 移动端视图清单（第 0 轮盘点）

`CurrentView`（`src/types/navigation.ts`）与 `useMobileHeader` 注册情况。

| viewId | 入口 | 已注册 useMobileHeader | 备注 |
|---|---|---|---|
| chat-v2 | 抽屉 · 学习 | 是 | 三屏；空态可 floating 菜单 |
| learning-hub | 抽屉 · 学习 | 是 | 三屏；面包屑/右屏预览 |
| todo | 抽屉 · 学习 | 是 | 两屏 + 详情全屏 |
| skills-management | 抽屉 · 管理 | 是 | 列表 + 右屏编辑器 |
| task-dashboard | 抽屉 · 管理 | 是 | 页内仍有 `wb-at-header` |
| template-management | 抽屉 · 管理 | 是 | 页内仍有 `wb-tm-panel-header` |
| settings | 抽屉 · 管理 | 是 | 两级导航 |
| ui-lab | 抽屉（需显式开启） | 是（Round 2） | showMenu + 统一抽屉 |
| dashboard | 命令面板 / 抽屉快捷 | 是 | 桌面图表组件（recharts） |
| data-management | 命令面板 | 是 | 桌面 HeaderTemplate 应已隐藏 |
| pdf-reader | 命令面板 / 学习资源 | 是 | |
| sandbox-workbench | 聊天右屏 / 独立视图 | 是 | 小屏应隐藏自绘 toolbar |
| template-json-preview | 模板管理跳转 | 是 | |
| crepe-demo | DEV | 是 | |
| chat-v2-test | DEV | 是（Round 2） | 自绘 header 仅桌面 |
| llm-playground | DEV | 是（Round 2） | 自绘 header 仅桌面 |
| notes（组件 `NotesHome`） | 学习资源内嵌 | 是，但 viewId=`notes` | **不是 CurrentView**，配置隔离可能失效 |

## 第 0 轮已看到的违规信号（待子代理核实）

- 页内自绘顶栏/工具栏：`AnkiTasksApp` `wb-at-header`、`TemplateInlinePanels` `wb-tm-panel-header`、`SkillsManagementPage` sticky toolbar、`Settings` `<header>`、flashcards `wb-fc-header`、`SessionSidebarContent` h-11 header、`LLMOutputPlayground` / `IntegrationTest` header。
- `NotesHome` 使用错误 viewId `notes`。
- `ui-lab` / `llm-playground` / `chat-v2-test` 未走统一顶栏。
- 多处 hover-only 操作（部分已有 `pointer:coarse` 补偿，需逐页确认）。
- 统计页使用 recharts / Card 桌面密度；DimensionManagement 使用 sticky Table。

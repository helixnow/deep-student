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
| notes（组件 `NotesHome`） | 已下线 | — | Round 11 已删组件与非法 viewId |

## 核实后状态

- `wb-at-header` / `wb-tm-panel-header` / `wb-fc-header`：已销案（小屏守卫或桌面壳独占）。
- Skills sticky：Round 2 已删死 class。
- DEV 双顶栏：Round 2 已收进统一顶栏。
- `NotesHome`：Round 11 已删（组件 + notes-home.css + barrel + 契约 allowlist）。
- Settings 小屏标题、GradingMain 640–767：Round 3 已修；Sheet 底安全区 / overlay 返回：Round 10–11 已修。
- 引擎分区触控、数据治理宽表操作钮、Todo 嵌入 workbench 的 header enabled、消息搜索条测试与返回键：Round 4 已修。
- 导图工具条 40→44、热力图年份/刷新 coarse 44、`shad/Table` 横滚：Round 11 已修。
- **仍开（有意折衷）**：内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28、FinderToolbar 视觉 40、WorkbenchSidebar 桌面壳分区头、翻译 COARSE_HIT 图标属 #161。生产路径收尾见 ROUND-90-FIXES.md 与 WRAP-UP.md。

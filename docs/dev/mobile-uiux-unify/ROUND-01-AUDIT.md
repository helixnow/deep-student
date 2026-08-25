# Round 1 审查结论（claude-fable-5-thinking-xhigh）

10 个只读子代理已回。另 6 个因并发上限未启动，Round 2 补扫。

## P0（必须修）

1. **`template-json-preview` 死视图**：`TemplateManagementApp` 把 `onOpenJsonPreview` 改名为 `_onOpenJsonPreview` 后丢弃，全仓无入口。
2. **聊天补全浮层吞返回键**：`ModelMentionPopover`、`SkillSlashPopover` 未注册 `registerBackHandler`。chat-v2 栈底时系统返回直接把应用退到后台，浮层不关。

## P1

1. chat-v2 `MessageSearchBar` 小屏 `fixed` 未 portal，落在三屏 track 外。
2. `IndexStatusView` 的「更多」自绘菜单未接 Android 返回。
3. `pdf-reader` / `sandbox-workbench` 左侧未设 `showBackArrow`，落到「后退+前进」双按钮。
4. `DataImportExport` 在 Settings 统计页以同一 viewId `data-management` 注册，会覆盖/清空独立数据管理顶栏。
5. `ui-lab` / `chat-v2-test` / `llm-playground` 未 `useMobileHeader`；后两者自绘第二顶栏。
6. 模板代码编辑右屏没有非手势入口（违反 MobileSlidingLayout 契约）。
7. 数据恢复壳无条件渲染桌面 `WindowControls`。
8. `VideoPreview` 控制栏仅 hover，触屏与暂停抢 tap。
9. `MessageTouchActionBar` 未接返回键。
10. 技能市场面板打开不滚回顶部；触控目标普遍 <44px。

## P2（抽样）

- 分组编辑器保存不在顶栏；资源预览「在学习中心打开」移动丢失。
- 顶栏返回硬编码回 chat-v2，与系统返回（历史）分叉。
- ExamContentView 子模式硬件返回直接收右屏。
- GradingMain 640–767 落入桌面分栏；ReviewPlanView hover 按钮。
- 契约测试未锁「每个 CurrentView 必须注册 useMobileHeader」。

## 已销案

- `wb-at-header` / `wb-tm-panel-header` 有小屏守卫或只是卡片段落头，不是第二导航顶栏。
- Skills `study-shell-toolbar` 不是第二顶栏（sticky 是死 class）。
- 16 个 CurrentView 均有某种回退兜底，无硬性死胡同（除 JSON 预览不可达）。

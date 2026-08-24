# Round 2 落地（claude-fable-5-thinking-xhigh）

## 已修

- 聊天：@模型 / 斜杠技能补全、长按操作条接 Android 返回；搜索条 portal 到 body；coarse 遮罩。
- 模板：恢复 JSON 预览入口；代码模式顶栏右屏开关；编辑返回与系统返回对齐；选择模式小屏可取消。
- 学习资源：IndexStatus 更多菜单返回 + 触控；面包屑 44px；VideoPreview 触屏先出控制栏；题库子模式硬件返回。
- 次级页：`useMobileHeader(..., enabled)`；嵌入统计不再覆盖 data-management；pdf/sandbox 返回箭头；导出 disabled。
- DEV/ui-lab：统一顶栏；IntegrationTest 可滚动；playground 小屏面板不并排。
- 恢复壳：小屏隐藏 WindowControls + 安全区。
- 技能市场：滚回顶部、触控 44px、返回关面板。
- 契约：`tests/vitest/mobile-uiux/*` 锁住 CurrentView 注册、废弃 MobileHeader、可达性三桶。

## Round 2 补扫新队列（Round 3）

- Settings 小屏 Sheet 自绘顶栏无可见标题；返回 handler 未 gate `isActive`。
- GradingMain 640–767 用容器断点导致桌面分栏 + 设置页返回丢失。
- Todo / NoteContentView 保活视图 stale 返回键。
- DimensionManagement / input-bar 提示条 / VerticalResizable 触控。
- 闪卡移动 no-op 无提示。

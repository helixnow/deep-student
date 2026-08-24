# Round 36 落地（claude-fable-5-thinking-xhigh）

## 已修

- TestControls 8 个 native 操作钮 coarse min-h-11
- PlaygroundControlPanel tabs / 快捷操作 / 状态 / 场景行
- LLMOutputPlayground、ProfilerPanel、EvalPanel 可交互钮
- IntegrationTest 运行钮；StoreInspector 展开行与刷新/复制
- 作文去图徽章 COARSE_HIT_BADGE inset-3→3.5（40→44）
- ankiCardsBlock 12 处 min-h-10 + coarse min-h-11
- WebSearchAdvancedConfig top-k / 深度选择
- ModernSidebar 会话重命名 h-7→coarse h-11
- WallpaperManagerDialog blur/dim 滑轨
- SessionBrowser 标题编辑/桌面搜索；TagNavigation 重命名钮 36→44

## 仍开（Round 37+）

- PlaygroundControlPanel 渲染模式钮仍 py-0.5
- 内联引用 chip 设计未决；MiniCalendar/TabBar 宽 28 有意折衷
- ShortcutSettings 属 #166 不碰
- Epub / ImmersiveFocus / Workbench dock 滑轨已覆盖，勿重做

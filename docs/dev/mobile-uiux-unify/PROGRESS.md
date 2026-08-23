# 进度

- **分支**：`cursor/mobile-uiux-unify-0888`
- **目标**：覆盖全部移动页面的顶栏统一、桌面组件收敛、可达/可回退，持续打磨到 SOTA。
- **轮次**：Round 2–18 已落地；当前队列见下。
- **PR**：https://github.com/helixnow/deep-student/pull/172

## 轮次日志

| 轮 | 模型 | 动作 | 结果 |
|---|---|---|---|
| 0 | 父代理 cursor-grok-4.6-high-fast | 建分支、列视图、划边界、写方案 | 见 INVENTORY.md |
| 1 | claude-fable-5-thinking-xhigh ×10 | 全页只读审查（6 个因并发上限未启动） | 见 ROUND-01-AUDIT.md |
| 2 | claude-fable-5-thinking-xhigh ×10 | 落地 P0/P1 + 补扫 | 见 ROUND-02-FIXES.md |
| 3 | claude-fable-5-thinking-xhigh ×10 | Settings 标题、作文断点、stale 返回、触控 | 见 ROUND-03-FIXES.md |
| 4 | claude-fable-5-thinking-xhigh ×4 | 搜索条测试/返回、Todo enabled、引擎/治理触控 | 已落地并提交（无独立文档） |
| 5 | claude-fable-5-thinking-xhigh | 选择器触控、桌面-only 开关、overlay 返回 | 见 ROUND-05-FIXES.md |
| 6 | claude-fable-5-thinking-xhigh | 面包屑热区、callout 折叠、coarse caret | 已落地（清单见 ROUND-05 残留节） |
| 7 | claude-fable-5-thinking-xhigh | Popover 返回、沙箱 chrome、PDF stale 守卫 | 见 ROUND-07-FIXES.md |
| 8 | claude-fable-5-thinking-xhigh | 导图子屏藏工具条、热力图 tap | 已落地（见 git `6da7a82e`） |
| 9 | claude-fable-5-thinking-xhigh | 灯箱返回、作文/翻译 isActive、Sheet 去 safe-top | 见 ROUND-09-FIXES.md |
| 10 | claude-fable-5-thinking-xhigh | skills/anki enabled、改期守卫、Settings overlay 返回 | 见 ROUND-10-FIXES.md |
| 11 | claude-fable-5-thinking-xhigh ×10 | 导图 44px、删 NotesHome/VideoPreview、Sheet 底安全区、Table 横滚 | 见 ROUND-11-FIXES.md |
| 12 | claude-fable-5-thinking-xhigh ×10 | 侧栏 hover、自动化顶栏、保活 isActive、MCP/插件返回、触控补齐 | 见 ROUND-12-FIXES.md |
| 13 | claude-fable-5-thinking-xhigh ×10 | 子屏顶栏接管、Resizable fixed、Epub isActive、预览死代码、触控 | 见 ROUND-13-FIXES.md |
| 14 | claude-fable-5-thinking-xhigh ×10 | 笔记窄窗返回、侧栏/备份 hover、题库/制卡/分屏手柄 44 | 见 ROUND-14-FIXES.md |
| 15 | claude-fable-5-thinking-xhigh ×10 | 搜索/图片保活、compact 分屏冻结、手柄 44、删 Header 孤儿 | 见 ROUND-15-FIXES.md |
| 16 | claude-fable-5-thinking-xhigh ×10 | 搜索条保活、闪卡 hover、引用选择器/标签 X 44、删 Sidebar 孤儿 | 见 ROUND-16-FIXES.md |
| 17 | claude-fable-5-thinking-xhigh ×10 | 大纲/访达/Anki 行/查看器 44、ContextRefs hover、删搜索孤儿 | 见 ROUND-17-FIXES.md |
| 18 | claude-fable-5-thinking-xhigh ×10 | 笔记 tab/手柄、收藏、题库头、PDF 侧栏、输入栏 chip、设置 44 | 见 ROUND-18-FIXES.md |

## 进行中的修复队列（Round 19+）

- TranslationPopover 交换/重试 24；generic 块复制钮
- NotesCrepeEditor pane 工具栏 28；FolderPickerDialog 展开 20
- 作文 InputPanel 轮次导航 24
- notes 可能孤儿：reference-selector、DndFileTree、InvalidReferenceOverlay

## 已落地

- 本目录方案与清单
- Round 2–11：顶栏契约、可达契约、废弃 MobileHeader 禁令；聊天/设置/沙箱/PDF/导图/热力图/Anki/Todo 移动 chrome；死代码 NotesHome / VideoPreview / AudioPreview / PreviewPanel
- 契约测试：`tests/vitest/mobile-uiux/*`（非法 viewId allowlist 已清空）

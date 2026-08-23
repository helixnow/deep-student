# 进度

- **分支**：`cursor/mobile-uiux-unify-0888`
- **目标**：覆盖全部移动页面的顶栏统一、桌面组件收敛、可达/可回退，持续打磨到 SOTA。
- **轮次**：Round 2–7 已全部落地并提交（含契约测试）；当前仅剩导图子屏、热力图触屏、Settings 安全区三项（Round 8+）。
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

## 进行中的修复队列（Round 8+）

- 导图子屏：双 chrome；工具条按钮 40px 不达标
- 题库统计热力图：单元格 tooltip 仅 hover 可达（触屏无入口）；图表 28px 小钮
- Settings Sheet：底部安全区死区；view 级返回键被 Radix 抢先

## 已落地

- 本目录方案与清单
- Round 2（原 P0/P1 队列全部销案）：恢复 JSON 预览入口；聊天 @/斜杠补全接返回键；搜索条 portal 到 body；IndexStatus 更多菜单返回；pdf/sandbox 返回箭头；data-management 顶栏键冲突；DEV/ui-lab 统一顶栏；模板右屏按钮；恢复壳；VideoPreview 触屏控制栏；技能市场触控
- 契约测试：`tests/vitest/mobile-uiux/*` 锁住「每个 CurrentView 必须 useMobileHeader」、废弃 MobileHeader、可达性三桶
- Round 3：Settings Sheet 标题、GradingMain 断点、stale 返回键守卫、触控放大
- Round 4：MessageSearchBar placement 测试改查 body + 搜索条接返回键；TodoContentView `enabled: !inWorkbenchWindow`；引擎分区/数据治理触控
- Round 5–7：见 ROUND-05-FIXES.md / ROUND-07-FIXES.md

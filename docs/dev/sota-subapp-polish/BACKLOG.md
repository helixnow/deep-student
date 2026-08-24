# 跨轮积压

来源：Round 01 审阅（R1-01..12，R1-06 / R1-09 已回填）。2026-08-24 W10 总检已按中枢最终代码再次勾除第二波完成项；未勾选项为交付后仍存在的产品风险或基线工程债，括注对应后续席位。

## P0 — 阻断学习主路径

- [x] exam 每日一练真实进度、目标阈值与自评改判去重（`eabd8fa0`）
- [ ] Exposé 活体 DOM 缩放 heap OOM：Round 01 仅做非焦点重窗降级止血，根因（缩放渲染活体窗口）未消（→ R2-06）
- [x] files 右键 `image`/`file` → `note` 类型映射错误（`2c08ce69`）
- [x] textbook 阅读进度 / 书签 `dstu.setMetadata` 被 highlights OCC 打断（`3dbf5be7` 进度通道白名单）
- [x] translation 七种领域预设被 `prompt_override` 静默覆盖（`b8f23462` override 门控）
- [x] essay 轮次导航覆盖未保存修改稿并冲草稿（`2ef52ca3` + `fd11a821` 确认对话框）
- [x] workbench 拖拽武装 1px vs 标题栏 3px，双击 zoom 被吞（`2ef52ca3`，`ffef12c3` 补测试）
- [x] todo 学习桌面键盘操作全部失效（`99b9e77a`）

## P1 — 对标竞品的明显缺口

- [ ] exam：限时练习 / 模拟考试不持久化、多窗练习会话单槽互顶；组卷 PDF / DOCX 真导出仍未实现（当前已明确置灰）（→ R2-01）
- [ ] flashcards：调度设置仍位于统计页；牌组 / 标签组限额、leech 检测、卡片信息面板等仍缺（→ R2-01）
- [x] notes：本地图谱（`4a25b41b`，局部 1 / 2 度图谱 + 虚节点 + 节点跳转）
- [x] mindmap：多 sheet 消费端（`3f456e29` / `f0b876cf`，切换器 + 导入回归）
- [ ] PDF：划词出题 / 制卡已落地（`672f90b8` / `008eca0a`）；高亮跨 node 串写仍待复核（→ R2-02 顺带）
- [ ] translation：全局术语库（→ 轮次待排）
- [x] chat：InputBar 按编辑核 / 工具条 / 附件面板拆分，并收敛发送可用性 selector（`e40e3a98`）
- [x] files：Quick Look（空格 `ea41e92c`+`923e5932`）、移动/重命名撤销（`e884df5f`）、工具栏 compact（`a672f741`）
- [x] notes：转为链接（`4fa3a735`）、重命名回写 wikilink（`dc3a2851`）、资源 1000 截断（`dc3a2851`）
- [x] chat：workbench 命令可见（`208cb624`）、`navigate-to-session` 三连发（`705833ba`）、权限文档失配（`84556ae7`）
- [x] mindmap：`mm_` 前缀回退（`9f2c1a5f`）、`.mmap` 能力面（`6f75fcec`）
- [x] PDF：划词复制/引用到对话/做笔记（`cb7181f6`+`8d781f7d`）、划词翻译（`62f5619b`）、双页步进（`b460421f`）
- [x] translation：语向偏好恢复（`b8f23462`）、阅读器内划词翻译（`62f5619b`）
- [x] essay：脏基准漂移（`01578cdf`）、OCR 乱序（`01578cdf`）、题目/图片持久化（`01578cdf`）
- [x] 系统工具：番茄结束切闪卡（`f8e1b47a`）、⌘1..8 焦点泄漏（`c7145b1d`）、投射抢焦点（`05425509`）
- [x] preview：PDF 双搜索（`4ee1f0c6`）、浏览器停止加载（`5bfa9ec4`）、快捷键修饰键劫持（`30ba1854`）

## P2 — 手感 / 视觉 / 无障碍

- [ ] 中枢遗留红灯 4 个：`workbenchWindowsChromeLayoutContract` ×2、`DockContextMenu` 键盘焦点、`StatusBar` Windows inset（→ R2-11）
- [ ] 仓库全量 vitest / Tauri / Rust 测试未在 W10 运行；最终 rebase 后已覆盖变更相关 108 文件 / 1168 用例（1167 通过，唯一失败为已知 `StatusBar` 基线项），基线红灯定向集 39 通过 / 4 失败
- [x] 原 7 个遗留红灯中的 `p11-workbench-desktop`、`DockWindowList`、`NotesSearchOverlay` 已在补扫复核中转绿
- [ ] Quick Look 缩略图：Finder/preview 壳 Quick Look 已通（`ea41e92c`/`00aef429`），网格视图与 Quick Look 内缺真缩略图（→ R2-02）
- [ ] 无障碍横切：焦点陷阱、roving tabindex、aria-live、对比度全面审计（→ R2-08）
- [ ] 移动端经典壳（非 workbench）：导航/手势/安全区问题清单化（→ R2-09；「不做移动端 workbench」纪律不变）
- [x] 设置搜索体验：键盘选择、空态、内容区定位与高亮（`450fa4cc`）；别名扩展可后续迭代
- [x] 文档全面同步：`ceaa6af2`、`54dba801`、`71f88269` 及 W10 小修，详见 `DOCS-SYNC.md`
- [x] files 复制 / 粘贴 / 副本（`8e2a021f`）、网格框选命中修正（`35033ab5`）
- [ ] chat 幽灵命令已补活（`bf8fc6dc`）；`ChatSessionSurface` 挂载策略仍待复核
- [ ] exam：导出格式选择器未实现项应置灰、handoff 目标上限 20 vs UI 50、超时双轨、日历动效重播（→ R2-01 顺带）
- [ ] flashcards：leech 检测、自定义学习/提前学、FSRS 参数优化、卡片信息面板（S/D/R）、库内 .apkg 直达、兄弟卡埋藏（→ R2-01 顺带）
- [x] files 桌面悬挂快捷方式清理/恢复（`d019b199`）
- [x] notes 默认窗宽背链覆盖（`dc3a2851` 并排背链）、建文件夹 onBlur 丢输入（`dc3a2851`）
- [x] chat MutationObserver 开销（`03e0343a`）
- [x] 桌面壳：上/下半屏热区 + 角热区比例化（`ffef12c3`）、cheatsheet 修饰键（`a0688c74`）、Exposé 宣告（`1973383b`）
- [x] 文档过期：笔记（`9cf129aa`）、对话权限（`84556ae7`）、翻译三标签（`c394fa40`）、效率工具（`5fb86645`）及第二波功能已同步

## 刻意不做

沿用 `docs/dev/workbench-progress/COORDINATION.md`：

- 不恢复 Dock 指示点呼吸、废纸篓 / Poof / Force Quit、Genie 真 mesh、Spaces、Stage Manager
- 不把全部应用默认钉进 Dock
- 不做移动端 workbench（移动端经典壳打磨不受此限）

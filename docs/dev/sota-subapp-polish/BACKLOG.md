# 跨轮积压

来源：Round 01 审阅（R1-01..12，R1-06 / R1-09 已回填）。Round 01 合流（2026-08-24）后已勾除完成项；剩余项按 Round 02 优先级重排，括注对应席位。

## P0 — 阻断学习主路径

- [ ] exam 每日一练进度死数据：后端 `get_daily_practice` 恒返 `completed_count: 0`，前端 `setDailyPractice` 无调用方，进度条/达标庆祝/续练全链路失效（→ R2-01）
- [ ] Exposé 活体 DOM 缩放 heap OOM：Round 01 仅做非焦点重窗降级止血，根因（缩放渲染活体窗口）未消（→ R2-06）
- [x] files 右键 `image`/`file` → `note` 类型映射错误（`2c08ce69`）
- [x] textbook 阅读进度 / 书签 `dstu.setMetadata` 被 highlights OCC 打断（`3dbf5be7` 进度通道白名单）
- [x] translation 七种领域预设被 `prompt_override` 静默覆盖（`b8f23462` override 门控）
- [x] essay 轮次导航覆盖未保存修改稿并冲草稿（`2ef52ca3` + `fd11a821` 确认对话框）
- [x] workbench 拖拽武装 1px vs 标题栏 3px，双击 zoom 被吞（`2ef52ca3`，`ffef12c3` 补测试）
- [x] todo 学习桌面键盘操作全部失效（`99b9e77a`）

## P1 — 对标竞品的明显缺口

- [ ] exam：打卡达标硬编码 `>=10`、自评 `markCorrect` 重复提交双计、限时/模拟考不持久化、多窗练习会话单槽互顶、组卷 PDF 导出（→ R2-01）
- [ ] flashcards：调度设置移出统计页 + guide 13 Q6 文档漂移、`fsrs_rate` 上报作答用时、多级撤销、牌组/标签组限额（→ R2-01）
- [ ] notes：本地图谱视图缺失（→ R2-03）
- [ ] mindmap：多 sheet 元数据已落库（`6f75fcec` 第一步），消费端（sheet 切换/展示/导出）未接（→ R2-05）
- [ ] PDF：划词「出题」入口（复制/引用/笔记/翻译已齐）；高亮跨 node 串写复核（→ R2-02 顺带）
- [ ] translation：全局术语库（→ 轮次待排）
- [ ] chat：InputBar 巨石组件拆分（附件/命令/引用/语音耦合一文件，改动即回归）（→ R2-04）
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

- [ ] 中枢遗留红灯 7 个：`workbenchWindowsChromeLayoutContract` ×2、`p11-workbench-desktop` 快照恢复、`DockContextMenu`、`DockWindowList`、`StatusBar` Windows inset、`NotesSearchOverlay`（→ R2-11）
- [ ] Quick Look 缩略图：Finder/preview 壳 Quick Look 已通（`ea41e92c`/`00aef429`），网格视图与 Quick Look 内缺真缩略图（→ R2-02）
- [ ] 无障碍横切：焦点陷阱、roving tabindex、aria-live、对比度全面审计（→ R2-08）
- [ ] 移动端经典壳（非 workbench）：导航/手势/安全区问题清单化（→ R2-09；「不做移动端 workbench」纪律不变）
- [ ] 设置搜索体验：结果高亮、跳转定位、别名命中（`2093722c` 只做了聚焦快捷键）（→ R2-10）
- [ ] 文档全面同步：作文图例、exam/flashcards 指南、Round 01 新增能力（划词菜单/Quick Look/停止加载等）未进用户指南（→ R2-07）
- [ ] files 复制/副本、网格框选
- [ ] chat 幽灵命令、ChatSessionSurface 未挂载
- [ ] exam：导出格式选择器未实现项应置灰、handoff 目标上限 20 vs UI 50、超时双轨、日历动效重播（→ R2-01 顺带）
- [ ] flashcards：leech 检测、自定义学习/提前学、FSRS 参数优化、卡片信息面板（S/D/R）、库内 .apkg 直达、兄弟卡埋藏（→ R2-01 顺带）
- [x] files 桌面悬挂快捷方式清理/恢复（`d019b199`）
- [x] notes 默认窗宽背链覆盖（`dc3a2851` 并排背链）、建文件夹 onBlur 丢输入（`dc3a2851`）
- [x] chat MutationObserver 开销（`03e0343a`）
- [x] 桌面壳：上/下半屏热区 + 角热区比例化（`ffef12c3`）、cheatsheet 修饰键（`a0688c74`）、Exposé 宣告（`1973383b`）
- [x] 文档过期（部分）：笔记（`9cf129aa`）、对话权限（`84556ae7`）、翻译三标签（`c394fa40`）、效率工具（`5fb86645`）

## 刻意不做

沿用 `docs/dev/workbench-progress/COORDINATION.md`：

- 不恢复 Dock 指示点呼吸、废纸篓 / Poof / Force Quit、Genie 真 mesh、Spaces、Stage Manager
- 不把全部应用默认钉进 Dock
- 不做移动端 workbench（移动端经典壳打磨不受此限）

# 跨轮积压

来源：Round 01 审阅（R1-01..12，R1-06 / R1-09 已回填）。

## P0 — 阻断学习主路径

- [ ] files 右键 `image`/`file` → `note` 类型映射错误
- [ ] textbook 阅读进度 / 书签 `dstu.setMetadata` 被 highlights OCC 打断
- [ ] translation 七种领域预设被 `prompt_override` 静默覆盖
- [ ] essay 轮次导航覆盖未保存修改稿并冲草稿
- [ ] workbench 拖拽武装 1px vs 标题栏 3px，双击 zoom 被吞
- [ ] todo 学习桌面键盘操作全部失效
- [ ] exam 每日一练进度死数据（后端恒返 `completed_count: 0`，前端无回写路径）
- [ ] Exposé 活体 DOM 缩放 heap OOM（已知失败测试，本轮评估后决定是否动）

## P1 — 对标竞品的明显缺口

- [ ] files：Quick Look（空格）、移动/重命名撤销、工具栏 compact 折叠
- [ ] notes：转为链接未实现、重命名不回写 wikilink、资源 1000 截断、无图谱
- [ ] chat：workbench 下命令不可见、`navigate-to-session` 三连发、权限文档失配
- [ ] mindmap：`mm_` 前缀回退、`.mmap` 能力面不一致
- [ ] PDF：划词无「笔记/出题/翻译/引用」、双页步进、跨 node 串写
- [ ] translation：语向偏好死代码、阅读器内无划词翻译、无全局术语库
- [ ] essay：脏基准漂移、OCR 乱序、题目/图片不持久化
- [ ] 系统工具：番茄结束无切闪卡、⌘1..8 焦点泄漏、投射抢焦点
- [ ] preview：PDF 双搜索、浏览器无停止加载、快捷键修饰键劫持
- [ ] exam：打卡达标硬编码 `>=10`、`markCorrect` 双计、限时/模拟考不持久化、多窗练习会话单槽互顶、组卷 PDF 导出
- [ ] flashcards：调度设置移出统计页 + guide 13 Q6 文档漂移、`fsrs_rate` 上报作答用时、多级撤销、牌组/标签组限额

## P2 — 手感 / 视觉 / 无障碍

- [ ] files 复制/副本、网格框选、桌面悬挂快捷方式
- [ ] notes 默认窗宽背链永远覆盖、建文件夹 onBlur 丢输入
- [ ] chat 幽灵命令、MutationObserver 开销、ChatSessionSurface 未挂载
- [ ] 桌面壳：上/下半屏热区、角热区比例化、cheatsheet 修饰键、Exposé 宣告
- [ ] 文档过期：笔记 / 对话权限 / 翻译三标签 / 作文图例 / 效率工具 legacy 布局
- [ ] exam：导出格式选择器未实现项应置灰、handoff 目标上限 20 vs UI 50、超时双轨、日历动效重播
- [ ] flashcards：leech 检测、自定义学习 / 提前学、FSRS 参数优化、卡片信息面板（S/D/R）、库内 .apkg 直达、兄弟卡埋藏

## 刻意不做

沿用 `docs/dev/workbench-progress/COORDINATION.md`：

- 不恢复 Dock 指示点呼吸、废纸篓 / Poof / Force Quit、Genie 真 mesh、Spaces、Stage Manager
- 不把全部应用默认钉进 Dock
- 不做移动端 workbench

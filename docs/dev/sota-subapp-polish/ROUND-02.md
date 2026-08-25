# Round 02 — 计划（待派发）

- 排期：2026-08-24 起
- 前置：Round 01 已合流（见 [ROUND-01.md](./ROUND-01.md)），中枢 `cursor/sota-subapp-polish-2399` 类型检查绿、learning-hub/pdf/browser 子集全绿
- 纪律：沿用中枢 README——卫星分支开发、中枢合并收口、文件写权互斥；每席交付必须带测试
- 席位模型：实现 `claude-fable-5-thinking-high`，复审 `claude-fable-5-thinking-xhigh`

## 席位总表

| 席位 | 主题 | 优先级 | 独占写权（冲突预告） |
|------|------|--------|----------------------|
| R2-01 | 题库 / 闪卡纵深 | P0+P1 | `question_bank_service.rs`、`questionBankStore.ts`、flashcards 面板 |
| R2-02 | Quick Look 缩略图管线 | P1 | Finder 网格/QuickLook、preview 壳 quickLook、缩略图 worker |
| R2-03 | 笔记本地图谱 | P1 | notes 图谱新模块（新文件为主） |
| R2-04 | chat InputBar 拆分 | P1 | `InputBar` 及其子组件目录（重构，锁全目录） |
| R2-05 | 导图多 sheet 消费端 | P1 | mindmap sheet 切换 UI、`.mmap`/导出链路 |
| R2-06 | Exposé OOM 再压 | P0 | Exposé 渲染层、窗口快照缓存 |
| R2-07 | 文档全面同步 | P2 | `docs/user-guide/**`（只动文档） |
| R2-08 | 无障碍横切审计 | P1 | 各壳层 aria/焦点（跨文件小改，需与各席对表） |
| R2-09 | 移动端经典壳打磨 | P1 | 移动布局/手势/安全区（不含 workbench） |
| R2-10 | 设置搜索体验 | P2 | settings 搜索索引/高亮/跳转 |
| R2-11 | 中枢红灯清零 | P0（工程健康） | 7 个失败测试对应组件与测试文件 |

## 席位说明

### R2-01 题库 / 闪卡纵深（Round 01 全额结转）

exam：
1. 修每日一练死数据：后端 `get_daily_practice` 按当日作答记录聚合真实 `completed_count`；前端接 `setDailyPractice` 回写，进度条/达标庆祝/续练恢复。
2. 打卡达标阈值改配置（去 `>=10` 硬编码）；`markCorrect` 幂等（重复提交不双计）。
3. 限时练/模拟考会话持久化（刷新/重开恢复）；多窗练习会话槽位隔离（去单槽互顶）。
4. 组卷 PDF 导出（复用 preview 保存双通道 `7e529b3d`）；导出格式选择器未实现项置灰。

flashcards：
5. 调度设置从统计页迁到独立设置入口，guide 13 Q6 同步改写。
6. `fsrs_rate` 上报真实作答用时；复习撤销改多级栈（可参考 finder `finderUndoStack.ts` 的模式）。
7. 牌组/标签组限额、leech 检测、卡片信息面板（S/D/R）择两项落地，其余回填 BACKLOG。

验收：每日一练全链路手测 + 后端聚合单测；`fsrs_rate` 参数契约测试；撤销栈单测。

### R2-02 Quick Look 缩略图管线

1. 为 `image`/`pdf`/`video` 生成并缓存缩略图（首页渲染/首帧抽取），落 VFS 附件或本地缓存目录，带失效策略（内容 hash）。
2. Finder 网格视图与 `FinderQuickLook`、preview 壳 `quickLook.tsx` 统一消费同一缩略图源。
3. 大文件/损坏文件降级到现有类型图标，不阻塞列表滚动（生成放 worker/异步命令）。
4. 顺带复核 PDF 高亮跨 node 串写（R1 遗留复核项）。

验收：缩略图缓存命中/失效单测；网格滚动无长任务（性能采样记录进席位报告）。

### R2-03 笔记本地图谱

1. 新增图谱视图（wikilink + 引用边），基于现有背链数据源；力导向或分层布局二选一，节点点击跳笔记。
2. 局部图（当前笔记 1-2 跳）优先于全局图；全局图懒加载 + 节点上限保护。
3. 与 notes 工作区集成：侧栏入口 + 命令面板命令；workbench 窗口 size class 适配。

验收：图数据构建纯函数单测（边去重/自环/孤点）；1000 笔记规模构建耗时记录。

### R2-04 chat InputBar 拆分

1. 把 InputBar 巨石组件按职责拆分：文本编辑核、附件条、命令弹层、引用 chips、发送/停止控制，各自独立文件 + props 契约。
2. 拆分为纯重构：行为快照先行（现有测试 + 补关键交互测试），拆后逐一对表。
3. 输出各子组件的写权边界，供后续轮次并行改造（这是本席的主要目的）。

验收：拆分前后交互测试全绿；无新增 re-render（React Profiler 抽查记录）。

### R2-05 导图多 sheet 消费端

1. 接 `6f75fcec` 落的多 sheet 元数据：sheet 切换 UI（标签条或下拉）、当前 sheet 持久化。
2. `.mmap`/XMind 多 sheet 导入映射到该结构；导出保留 sheet 结构。
3. 引用（`mm_`）跳转带 sheet 定位。

验收：多 sheet 导入/切换/导出回归测试；单 sheet 文档零回归（`880e56ad` 的测试保持绿）。

### R2-06 Exposé OOM 再压

1. 根因方向：Exposé 缩放渲染活体窗口 DOM → 改为窗口快照（canvas/位图）+ 焦点窗保活；`1973383b` 的降级作为兜底保留。
2. 建立 heap 基线测量脚本（打开 N 重窗 → Exposé 进出 × 10 → heap 增量），先量后改。
3. 快照失效策略：窗口内容变更事件驱动重拍，节流。

验收：基线对比数据进席位报告；已知 OOM 失败测试转绿或给出剩余量化差距。

### R2-07 文档全面同步

1. 全量比对 `docs/user-guide/**` 与 Round 01 落地行为：PDF 划词菜单/翻译、Finder Quick Look/撤销/compact、浏览器停止加载、媒体快捷键、保存并关闭、番茄三态等逐条核对。
2. 作文批改图例、exam/flashcards 指南（结合 R2-01 改动后一次写对）。
3. 建「行为-文档」对照清单进本目录，后续轮次强制随行为提交更新。

验收：对照清单全绿；`check:i18n` 通过（文档内截图/键名同步）。

### R2-08 无障碍横切审计

1. 审计范围：workbench 壳（Dock/Exposé/窗口 chrome）、Finder、PDF/EPUB 阅读器、chat、settings。
2. 重点：对话框焦点陷阱与还原、菜单 roving tabindex、aria-live 使用一致性（对齐 `1973383b` 的模式）、图标按钮可达名称、对比度（暗色 token 抽查）。
3. 产出问题清单分级（阻断/严重/建议），阻断项当席修复，其余回填 BACKLOG。
4. 与各功能席对表写权：只做点状小改，成片重构移交对应席位。

验收：axe 自动扫描 + 手动键盘走查记录；阻断项修复带回归测试。

### R2-09 移动端经典壳打磨

1. 范围限经典移动壳（App shell ≤768），**不做移动端 workbench**（纪律不变）。
2. 审计导航栈返回一致性（对齐 androidBackCoordinator 优先级模型）、底栏/safe-area、触控目标 ≥44px、PDF/EPUB 阅读器移动形态（Round 01 已做内联子屏，补手势与工具栏收纳）。
3. 媒体播放器移动端控制条与横屏适配。

验收：ui:audit-mobile 三件套跑通并归档报告；关键路径截图对比。

### R2-10 设置搜索体验

1. 在 `2093722c`（聚焦快捷键）基础上：搜索结果高亮命中词、点击结果跳转并滚动定位到具体设置项、支持别名/同义词命中（中英混输）。
2. 建搜索索引（label + 描述 + 别名），i18n 两语言同源生成。
3. 空结果给引导（推荐常用设置）。

验收：索引构建与命中排序单测；两语言命中一致性测试。

### R2-11 中枢红灯清零（工程健康）

逐一修复 7 个中枢遗留失败测试（合并前基线 `32658194` 即失败）：

1. `workbenchWindowsChromeLayoutContract` ×2（Windows chrome 宽度共享 / macOS 规则独立）
2. `p11-workbench-desktop` 快照恢复（hydrate 后窗口恢复超时）
3. `DockContextMenu` 键盘打开聚焦首项
4. `DockWindowList` 关闭被拒后焦点不回抢
5. `StatusBar` Windows menubar chrome inset
6. `NotesSearchOverlay` quick-open 空查询分组

原则：先判断是实现回归还是测试过时——契约类（1/5）疑似 Round 01 桌面壳样式迁移后测试未跟；行为类（2/3/4/6）需逐个 bisect。修实现优先于改断言，改断言必须写明理由。

验收：`tests/vitest/workbench src/features/workbench` 子集 0 失败。

## 合流顺序建议

1. R2-11（先清红灯，还各席一个可信基线）
2. R2-01 / R2-03 / R2-05 / R2-10（互不重叠，可并行）
3. R2-04（InputBar 拆分需独占 chat 目录，避开与其他 chat 改动同期）
4. R2-02 / R2-06（都碰渲染性能层，先 02 后 06）
5. R2-08 / R2-09 / R2-07（横切与文档收尾，压轴合流）

# Round 01 — 竞品对标审阅与落地（已收尾）

- 开始：2026-08-23；合流收尾：2026-08-24
- 审阅模型：`claude-fable-5-thinking-xhigh`；实现模型：`claude-fable-5-thinking-high`
- 状态：审阅 12/12、落地与第二波补强全部合流；W10 跨模块总检完成
- 交付结论：**可交付**。本轮变更相关类型检查与测试无新增红灯；4 个已知失败均为中枢基线问题，另有产品级遗留风险列于文末与 [BACKLOG.md](./BACKLOG.md)
- 已合并卫星分支：
  - `cursor/learning-hub-finder-polish-a9c5` → `1d9a6287`
  - `cursor/deepstudent-reader-landing-d033` → `f5f658e6`
  - `cursor/preview-media-browser-polish-8dd9` → `f11356c0`
  - `cursor/files-preview-fixes-901a`（tip `9cfd3c34`）→ `63d74b95`
  - `cursor/workbench-shell-wave2-98eb`（tip `7c73fbb2`）→ `1d73d793`
  - `cursor/w6-workbench-finalize-4a4c`（tip `40684e3a`）→ `0c7936f6`
  - `cursor/w8-preview-browser-media-20f9`（tip `14740791`）→ `ec03458b`

## 本轮 12 个审阅席位

| 席位 | 模块 | 竞品 | 状态 |
|------|------|------|------|
| R1-01 | files / Learning Hub Finder | Finder / Explorer / Obsidian | 完成 |
| R1-02 | notes 工作区 | Obsidian / Notion / Typora | 完成 |
| R1-03 | chat | ChatGPT / Claude / Cursor | 完成 |
| R1-04 | mindmap | XMind / MindMaster / Canvas | 完成 |
| R1-05 | textbook / PDF / 阅读 | Preview / Acrobat / MarginNote | 完成 |
| R1-06 | exam / 题库练习 | Quizlet / 作业帮 | 完成（[报告](./R1-06-exam.md)） |
| R1-07 | translation | DeepL / 沉浸式翻译 | 完成 |
| R1-08 | essay | Grammarly / 批改网 | 完成 |
| R1-09 | flashcards / Anki | Anki / SuperMemo / Quizlet | 完成（[报告](./R1-09-flashcards.md)） |
| R1-10 | workbench 桌面壳 | macOS Tahoe / Sequoia | 完成 |
| R1-11 | todo / pomodoro / 系统工具 | Things / Forest / Linear | 完成 |
| R1-12 | preview / media / browser / sandbox | Quick Look / VLC / Safari / CodePen | 完成 |

## 落地席完成状态（按模块）

### files / Finder — 完成（卫星 `cursor/learning-hub-finder-polish-a9c5`，合并 `1d9a6287`）

- `2c08ce69` 抽取 `mapDstuTypeToFolderItemType` 共用映射并锁测试（修 P0：右键 `image`/`file` → `note` 走错应用）
- `634fcf66` `finderStore.enterFolder` 乐观导航 + 面包屑回填（修 P1 竞态）
- `e884df5f` Finder 最近操作撤销栈（移动/重命名）；`d019b199` desktopStore 按目标资源清理/恢复快捷方式
- `ea41e92c` FinderQuickLook 空格快速预览浮层；`a672f741` FinderToolbar 窄窗 compact 收纳
- `923e5932` Sidebar 集成 QuickLook / Cmd+Z 撤销 / 键盘梳理 / 收藏徽标真数据
- 合流补丁：`56865ccc` sidebar 集成测试 dstu mock 补 `list`（收藏徽标挂载即查询）

### textbook / PDF / 阅读 — 完成（中枢 + 卫星 `cursor/deepstudent-reader-landing-d033`，合并 `f5f658e6`）

- 中枢先行：`b460421f` 双页按 spread ±2 翻页；`62f5619b` 选区工具条接入划词翻译（TranslationPopover + 前后文消歧）
- 卫星：`3dbf5be7` previewPersistence 进度通道白名单 + 创建时快照 metadata（修 P0：OCC 打断进度/书签落盘）
- 卫星：`cb7181f6` 划词动作菜单（复制/引用/笔记）+ 高亮点击改色/删除 + 菜单视口钳位 + 键盘/滑杆无障碍
- 卫星：`8a0c9f9d` EPUB 章节级进度写资源 metadata；`8d781f7d` 划词引用到对话/做笔记上层接线 + EPUB 进度接线
- 合流冲突解法：`EnhancedPdfViewer` 划词菜单同时保留 4 色高亮（`canPersistAnnotations` 门控）+ 复制/引用/笔记 + 翻译入口；`pendingHighlight` 采用 reader 的锚点钳位结构并保留中枢的 `context` 消歧字段

### preview / media / browser — 完成（卫星 `cursor/preview-media-browser-polish-8dd9`，合并 `f11356c0`）

- `4ee1f0c6` 壳层 ⌘F 对 PDF 转发内嵌全文搜索（`pdf-preview-open-search` 事件），`canSearch=false` 不再空吞按键（修 P1 双搜索分叉）
- `5bfa9ec4` loading 期 reload 变停止按钮，解锁 back/forward 改道；`00aef429` preview 壳可复用 Quick Look 浮层 API
- `30ba1854` 媒体单键快捷键放行 ⌘/Ctrl/Alt 组合；进度提交降频 ~10Hz；`fe4c8116` 音视频扩展名/MIME 单一真源
- `7e529b3d` 保存链路 blob→base64 双通道共享实现；`1309ba9f` 压缩包清单语言中立机器标记
- `2d375ffb` 补测试：快捷键守卫 / 扩展名 SSOT / 停止加载 / 保存双通道 / 清单标记

### 补扫卫星收口 — 完成

- `cursor/files-preview-fixes-901a`（tip `9cfd3c34`，合并 `63d74b95`）：类型映射、Cmd+A、乐观导航、进度 metadata 白名单均已被后续指定卫星的更完整实现覆盖；四个冲突文件保留中枢版本，只补齐分支历史归并。
- `cursor/workbench-shell-wave2-98eb`（tip `7c73fbb2`，合并 `1d73d793`）：合入 Ctrl+Tab 让位、窗口崩溃冷却、Dock 触屏容差/⌥角标、Exposé 停绘占位、TITLEBAR 单一来源、genie 源点修复及对应测试。
- `DockItem.tsx` 冲突同时保留中枢的触屏 tooltip 驻留，并采用卫星 `dockGestures` 的 pointer-type 分档容差；删除被共享手势常量替代的局部 5px 常量。
- `cursor/w6-workbench-finalize-4a4c`（tip `40684e3a`，合并 `0c7936f6`）：已合入 snap zone 边界、窗口标题栏双击守卫、badge bus 与 StatusBar 回归补强；自动合并无冲突。
- `cursor/w8-preview-browser-media-20f9`（tip `14740791`，合并 `ec03458b`）：已合入浏览器 session 持久化与 archive manifest 媒体识别补强；自动合并无冲突。

### translation — 完成（中枢直落）

- `b8f23462` 领域预设 override 门控（修 P0：`prompt_override` 静默覆盖 7 种领域）+ 语向/正式度偏好恢复 + 本地保存去离线拦截
- `da613621` 对照视图与只读查看器共享 segmentation；`ee19a4da` 分栏比例持久化 + 语言列表对齐；`bf256ab2` 五类回归测试

### essay — 完成（中枢直落）

- `2ef52ca3` / `fd11a821` 轮次导航确认改 DsAlertDialog（修 P0 冲草稿）
- `0d4eaa48` 内容态/OCR 占位符/建议锚定三个纯函数模块（44 例单测）
- `01578cdf` 工作台整合：脏基准结构化、题目图片持久化、OCR 顺序回填、建议应用/撤销、存为笔记
- `3bbb65eb` ScoreCard 徽章与进度条颜色同源；雷达图英文维度宽度感知换行

### notes — 完成（中枢直落）

- `9f2c1a5f` 宽/中窗侧栏真折叠 + 冷启动导图前缀 `mm_`（修 P1 两项）
- `4fa3a735` 未链接提及一键转双链（OCC 写回）+ 背链/提及精确定位
- `dc3a2851` 重命名自动回写 `[[wikilink]]` + 资源分页去静默截断 + 默认窗宽并排背链 + 建夹 onBlur 防误取消
- `9cf129aa` 用户指南补齐 8 模板与笔记工作区能力

### chat — 完成（中枢直落）

- `208cb624` 命令在 workbench 作用域可见（修 P1）；`705833ba` navigate-to-session 三连发握手化
- `540c7a52` handleBranch 统一走 `store.branchSession`；`e8b8040a` context-ref/pdf-ref 失败可见 toast
- `03e0343a` titlebar slot MutationObserver 收窄；`73ad394f` 删除死代码；`84556ae7` 权限文档更正 4 档

### mindmap — 完成第一步（中枢直落）

- `6f75fcec` 空间导航限实例容器 + Esc 放行 + `.mmap` 导入 + 分支批量挖空 + 导入占位/进度 + 多 sheet 元数据第一步
- `880e56ad` `mm_`/`mv_` 引用与资源库打开回归 + 隔离测试
- 剩余：多 sheet 元数据的消费端（切换/展示）→ Round 02 R2-05

### todo / pomodoro / 系统工具 — 完成（中枢直落）

- `99b9e77a` 学习桌面窗口内恢复列表快捷键（修 P0）；`c7145b1d` mod+1..8 视图热键按窗口焦点门控（修焦点泄漏）
- `f8e1b47a` 番茄投影收敛 + 休息期切闪卡复习；`05425509` 背景投影窗 + 关窗余韵；`b09658ff` 置顶迷你窗时隐藏浮动药丸
- `ec949f01` / `a0688c74` 状态栏番茄三态文案与样式迁移；`ad3731a4` 侧栏宽度仅宽窗持久化；`5fb86645` 用户指南同步

### workbench 桌面壳 — 完成（中枢直落）

- `2ef52ca3` 拖拽武装阈值 1px→3px（修 P0 双击 zoom 被吞）；`ffef12c3` 上/下半屏平铺热区与快捷键 + 角热区比例化
- `73b55016` 关窗确认「保存并关闭」（保存挂点注册表 + 三态对话框）
- `1973383b` Exposé 非焦点重窗降级 + aria-live 宣告；`2c88b771` Dock 角标 badgeBus 推送为主
- `a0688c74` 速查表修饰键技巧与 tour 再入口；`47408ba0` / `32658194` 测试补齐

### settings / skills — 完成（中枢直落）

- `2093722c` workbench 窗内 cmd/ctrl+F 聚焦设置搜索；`d616701e` skills 消费窗口 size class + `/` 搜索快捷键

## 合流后的第二波补强

- exam：`eabd8fa0` 修每日一练真实进度、目标阈值与自评改判去重；`8e2a47f9` 补限时总结卡，并把未实现的 PDF / DOCX 组卷导出明确置灰。
- flashcards：`d55c1b82` 补真实作答用时、多级撤销，并确保统计加载失败时调度设置仍可用。
- Finder / 阅读：`8e2a021f` 补复制、粘贴与制造副本；`bfefd639` 补 Quick Look 图片原图 / PDF 首页；`672f90b8`、`008eca0a` 补 PDF 视图状态、封面偏移、增量搜索及划词出题 / 制卡。
- mindmap：`3f456e29`、`f0b876cf` 落地多 sheet 切换、背诵 SRS、大纲窗口化与图片内嵌。
- notes：`4a25b41b`、`b48abe77` 落地局部图谱、搜索分页 / 操作符、任意属性及集成测试。
- chat：`e40e3a98` 拆分 InputBar；`bf8fc6dc`、`8967fd99` 补会话轻窗、命令监听与安全权限默认值。
- settings / templates / tasks / a11y：`450fa4cc`、`6d76b876`、`978310ed`、`cb0aa10e` 等补搜索定位、键盘链路、任务空态与焦点管理。
- 用户指南：`ceaa6af2`、`54dba801`、`71f88269` 等已同步上述实际能力；W10 另补移动端 PDF 划词动作清单。
- W10 最终 rebase 纳入 `813d0a8c`、`24a0f6c4`、`f318ae83`、`00b6760b`、`14eee4af`、`80db7611`、`24d884e5`、`6421a4ec`、`ac2e8477`：Finder、翻译、作文、闪卡窗口门控，以及 PDF / EPUB 阅读状态与选区菜单的收口修复。
- chat 最终收口：`a11e652b`、`051de3aa` 完成标准导航握手、命令监听与 titlebar observer 隔离；W10 以 `fe6c0d34` 对齐重复旧测试契约，未回退新功能。

## 本轮未落地（结转 Round 02）

1. **Exposé OOM**：目前有非焦点重窗降级与停绘占位，但活体 DOM 缩放造成 heap OOM 的根因未消（→ R2-06）。
2. **exam 会话隔离**：限时练习 / 模拟考试仍不支持重启后断点续考，多窗口会话仍可能单槽互顶（→ R2-01）。
3. **flashcards 设置与限额**：调度设置仍位于统计页；牌组 / 标签组限额、leech 检测等深水能力未落地（→ R2-01）。
4. **Finder 缩略图**：Quick Look 已有图片原图 / PDF 首页，但网格视图仍缺统一的缓存缩略图管线（→ R2-02）。
5. **中枢遗留红灯 4 个**（非本次合流引入）：`workbenchWindowsChromeLayoutContract` ×2、`DockContextMenu` 键盘焦点、`StatusBar` Windows inset（→ R2-11）；`p11-workbench-desktop`、`DockWindowList`、`NotesSearchOverlay` 已转绿。

## W10 最终验证记录（2026-08-24）

- `npx tsc --noEmit`：初次仅因被忽略的生成文件 `src/version.ts` 缺失而报 3 个模块解析错误；执行 `npm run version:generate` 后 **0 错误**，无业务类型错误。
- 变更相关 vitest 子集：108 文件 / 1168 用例，**1167 通过 / 1 失败**；唯一失败为已知基线项 `StatusBar` Windows inset；最终 chat 合流曾暴露的 5 个契约红灯已由 `fe6c0d34` 清零。
- 基线红灯定向复核：3 文件 / 43 用例，39 通过 / 4 失败；失败精确为 `workbenchWindowsChromeLayoutContract` ×2、`DockContextMenu`、`StatusBar`。
- 用户指南抽查：PDF、Finder、notes、mindmap、exam、flashcards 与实现对照；修正移动端 PDF 划词工具条漏列复制 / 引用 / 笔记。
- W6 / W8 收尾合并追加验证：workbench pointer / snap / tiling 及关联回归 11 文件 / 232 用例全部通过；browser / archive 相关回归 12 文件 / 95 用例全部通过；`npx tsc --noEmit` 0 错误。
- 剩余验证风险：未运行仓库全量 vitest、Tauri / Rust 全量测试及桌面端手工性能压测；Exposé OOM 需专项量化。

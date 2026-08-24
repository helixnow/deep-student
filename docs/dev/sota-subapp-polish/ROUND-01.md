# Round 01 — 竞品对标审阅与落地（已收尾）

- 开始：2026-08-23；合流收尾：2026-08-24
- 审阅模型：`claude-fable-5-thinking-xhigh`；实现模型：`claude-fable-5-thinking-high`
- 状态：审阅 12/12 完成；落地席全部合流入中枢 `cursor/sota-subapp-polish-2399`
- 集成方式：中枢直落 + 3 个卫星分支合并（`learning-hub-finder-polish-a9c5`、`deepstudent-reader-landing-d033`、`preview-media-browser-polish-8dd9`），合并提交 `1d9a6287` / `f5f658e6` / `f11356c0`

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

## 本轮未落地（结转 Round 02）

1. **exam P0**：每日一练进度死数据——`question_bank_service.rs` 仍恒返 `completed_count: 0`，`setDailyPractice` 无调用方（→ R2-01）
2. **exam P1**：打卡达标硬编码 `>=10`、`markCorrect` 双计、限时/模拟考不持久化、多窗练习会话单槽互顶、组卷 PDF 导出（→ R2-01）
3. **flashcards P1**：调度设置移出统计页 + guide 13 文档漂移、`fsrs_rate` 作答用时、多级撤销、牌组/标签组限额（→ R2-01）
4. **Exposé OOM**：本轮只做了非焦点重窗降级（`1973383b`），活体 DOM 缩放 heap OOM 根因未消（→ R2-06）
5. **notes 图谱**：本地图谱视图完全缺失（→ R2-03）
6. **中枢遗留红灯 7 个**（合并前后一致，非合流引入）：`workbenchWindowsChromeLayoutContract` ×2、`p11-workbench-desktop` 快照恢复、`DockContextMenu` 键盘、`DockWindowList` 焦点、`StatusBar` Windows inset、`NotesSearchOverlay` quick-open 分组（→ R2-11）

## 合流验证记录（2026-08-24）

- `tsc --noEmit`：0 错误（`src/version.ts` 需先 `npm run version:generate` 生成，属环境准备非代码问题）
- vitest 子集 `src/features/learning-hub src/features/pdf tests/vitest/learning-hub tests/vitest/browser`：38 文件 207 用例全绿（含 1 处合流修复 `56865ccc`）
- vitest 子集 `tests/vitest/workbench src/features/workbench`：1964 通过 / 7 失败；7 个失败在合并前基线 `32658194` 上逐一复现为同名失败，确认为中枢历史遗留，与本次合流无关

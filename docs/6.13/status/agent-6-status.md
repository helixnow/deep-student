# 代理 6 状态文档（round 2）—— 笔记·导图·翻译·作文批改

> 第一轮上下文见 `docs/6.12/status/agent-6-status.md`（A6-01~A6-30，已修 17）。本文档只记录 round 2。
> feed 会话：`feed_id=F-XBRYD`（MCP mcp-feedback-enhanced）。

## 任务目标

按 `docs/6.13/agent-6.md` 优先级推进本域剩余项：P1 低风险直接做+验证；P2 低风险做、大重构出方案；P3 产品取舍出方案待用户拍板。仅改本域文件；共享文件只改本域相关段落并登记；未经用户要求不 commit/push；不使用子代理。

## 当前进度（2026-06-13）

### ✅ 已完成并验证（P1）

- **A6-30**（作文批改评分解析失败降级提示）
  - `src/essay-grading/GradingStreamRenderer.tsx`：新增 `scoreParseFailed`（仅当 `!isStreaming && contentHasScore && !contentHasInlineMarkers && !parseResult.score` 时为真），非批注分支渲染降级提示卡片。
  - `src/components/essay-grading/StreamingAnnotatedText.tsx`：导入 `hasScoreMarker`，新增 `scoreParseFailed`（`showScore && !isStreaming && !score && hasScoreMarker(text)`），评分卡片位渲染降级提示。
  - i18n 新增 `essay_grading:score.parse_failed`（zh-CN/en-US）。
  - **设计取舍**：未采用任务原文的宽条件 `!isStreaming && content && !score`，改为「确有 `<score>` 标签但解析不出」才提示——避免对本就无评分的作文误报（更精确，无误伤）。
  - 验证：`tsc` EXIT 0；`check:i18n` essay_grading 键一致；改动文件 0 eslint error。

- **A6-29**（作文批改 Ctrl/Cmd+Enter 提交快捷键）
  - `src/components/EssayGradingWorkbench.tsx`：新增 `isActive?` prop + document keydown 监听（`isActive===false` 不注册，对齐 A6-28 翻译范式），Ctrl/Cmd+Enter 触发 `handleGrade`（内部已含离线/isGrading/空文本/未改动守卫）。
  - `src/features/learning-hub/apps/views/EssayContentView.tsx`：从 `ContentViewProps` 透传 `isActive`。
  - 验证：`tsc` EXIT 0；改动文件 0 eslint error（仅 1 条 `document.addEventListener` warning，与 TranslateWorkbench A6-28 同范式，属既有约定）。

- **A6-16**（`window.confirm` → `NotionAlertDialog`）
  - `src/components/TranslateWorkbench.tsx`：清空确认改声明式（`showClearConfirm` + `doClear` + `handleClearRequest` + `handleConfirmClear`），移除 `window.confirm`。
  - `src/features/mindmap/MindMapContentView.tsx`：导入未保存确认改声明式（`showImportConfirm`，`handleImport` 拆出 `doImport`/`handleConfirmImport`），移除 `window.confirm`。
  - i18n 新增 `translation:confirm.clear_title`、`mindmap:import.unsavedTitle`/`unsavedConfirm`（zh/en）。
  - 验证：`tsc` EXIT 0；`check:i18n` 三命名空间键一致；eslint **净减 2 个 `no-alert` error**，0 新增。

- **A6-14 群剩余死代码（前端，已删）**
  - `essayGradingApi.listSessions`：函数 + `EssayGradingAPI` 导出项 + 迁移注释行删除（`GradingSessionListItem` 仍被 essayDstuAdapter 使用，**保留**；孤儿 i18n key `api_errors.list_sessions_failed` 按 A6-10 先例未动）。
  - 导图旧拆分 store：删除 `src/features/mindmap/store/{documentStore,uiStore,historyStore}.ts`；清理 `src/mcp-debug/registerStores.ts`（移除 mindmapUI/mindmapHistory/mindmapDocument 三项，保留整合版 mindmap）；清理 `src/features/mindmap/store/index.ts`（移除 historyStore 再导出块；`useDocumentStore`/`useUIStore` 别名仍指向 mindmapStore，保留）。
  - 核实：`useHistoryStore`/`HistoryItem` 等仅被 barrel 再导出 + registerStores 引用，无真实消费者；三文件仅 registerStores（+historyStore 的 barrel）引用 → 确为死代码。
  - 验证：`tsc` EXIT 0；改动文件 0 eslint error；`vitest` mindmap-store-lifecycle 6/6、markerParser 5/5 通过。

### ✅ 已实施并验证（P2 perf）

- **A6-23**（P2 perf）`notes_exporter.rs` 导出附件由「全量字节载内存」改「流式逐个读盘写 zip」。
  - 改动 6 处（同一文件）：`ExportAttachmentInternal` 结构体 `bytes: Vec<u8>` → `absolute_path: PathBuf`；3 个 producer（`collect_all_notes_bundle` SQLite、subject collect、`collect_all_notes_bundle_vfs`）改为只存路径（保留 `exists()` 校验，subject 变体由「读失败 continue」改「不存在 continue」）；2 个 consumer（`export_unified_zip`、`export_single_zip`）改为 `fs::read(absolute_path)` 后立即 `write_all`，读失败 `log::warn + continue`（不再整体中断）。
  - 内存峰值由「全部附件字节」降为「单个附件」。manifest 与 per-note `ExportAttachment` 记录不依赖字节（仅 count/relative_path/mime/size），不受影响。
  - **验证通过**：`cargo check` EXIT 0（全量重编 3m02s），`notes_exporter.rs` 零警告，总警告数 ~100 = 基线不变（无新增）。**未做 commit。**

### ✅ 已实施并验证（批次2，用户"都做做彻底"指令后）

- **note_links 子系统清理（A6-14 群，后端）** — 删除 6 处确认死代码：`get_note_links` + 结构体 `NoteOutgoingLink`/`NoteBacklinkHit`/`NoteLinksResult` + 私有助手 `normalize_link_target`/`build_simple_snippet`（约 166 行）。活跃的 `rebuild_note_links_tx`/`extract_note_links`/`update_inbound_link_targets_tx` 保留。验证：`cargo check` EXIT 0，警告 98（≤基线，无新增）。

- **A6-24（P2 ux-data-loss）导图保存冲突"恢复我的修改"** — 纯增量实现：`mindmapStore` 新增 `conflictSnapshot` 字段 + `restoreConflictSnapshot()`/`dismissConflictSnapshot()`；save 冲突分支重载服务端后暂存本地快照；save 成功/reset 清快照；`MindMapContentView` 加非阻断 banner（恢复我的修改 / 采用服务端版本）。i18n: `mindmap:store.conflictSnapshotKept/conflictBannerTitle/conflictRestoreMine/conflictDismiss`(zh+en)。验证：tsc EXIT0、mindmap-store-lifecycle 6/6、改动文件 0 eslint error、check:i18n 一致。

- **A6-11（P2 perf）事件增量化（本域：essay + 独立 translation）** — `GradingStreamData`/`TranslationStreamData` 移除 `accumulated` 字段；`emit_data` 仅用 accumulated 计算 char/word count、payload 只发 `chunk`；前端 `useEssayGradingStream`/`useTranslationStream` 改为按 chunk 自行累加（start* 已重置文本为空，complete 事件仍回传权威全文兜底）。IPC 由 O(n²) 降为 O(n)。验证：cargo EXIT0 + tsc EXIT0 + 改动文件 0 新 error。

- **A6-12（P3 产品→已实施）作文超分按比例换算** — `streamingMarkerParser.ts::parseScoreFromText`：`total > maxTotal` 时按「百分制」语义比例换算到模式满分（雅思 85→7.65 而非 clamp 成 9），仍兜底夹 `[0,maxTotal]`；未超分保持原值。（`markerParser.ts::parseScore` 为测试/非展示路径，未动。）验证：tsc + markerParser 5/5。

- **A6-13（P3 产品→已实施）纯图作文批改放行** — 后端 `build_grading_prompts` 新增 `has_essay_images` 参数；空文本 + 有作文图时不再报错，user prompt 用「正文见原图」占位（多模态模型直接读图）；前端 `EssayGradingWorkbench.handleGrade` 空文本守卫放宽为「无文本且无图片」才拦。验证：cargo EXIT0 + tsc EXIT0。

### 📋 仍待用户决策

- **A6-15（P3 产品，大重构，建议先定方案）长文翻译分段 + 同步滚动对齐**
  - 现状：`useTranslationStream` 围绕**单次** stream session 构建；`TranslationMain` 同步滚动用纯高度比例映射（`scrollTop/scrollableHeight`，textarea↔渲染 div）。
  - 这是两块**较大且无测试覆盖**的核心改造：① 分段=把单流改为「按段落切分→顺序多请求→拼接译文+进度」，要重写 hook 的流式/取消/自动保存/与 A6-11 累加的交互；② 段落锚点对齐需源端（textarea）暴露每段像素偏移（需镜像元素），非平凡。
  - **未盲改**（避免动到可用的翻译主链路）。**推荐方案待你确认**：(a) 分段在**前端**顺序做（复用现有后端、改 hook，UX 加分段进度）还是**后端**做（新命令、契约改动更大）；(b) 同步滚动是否接受「段落锚点（需源端镜像测距）」的成本。**你确认方向后我立即实现 + 验证。**

### 📋 跨组/后续（登记，归属他人或需额外铺垫）

- **A6-11 / chat_popover（→ 与代理1边界）** `translation/chat_popover.rs` 用独立 `ChatTranslationEvent::Chunk{delta,accumulated}`，同款 O(n²)，但其前端消费方 `features/chat/components/TranslationPopover.tsx` 位于 chat 域、且 popover 上限仅 8K 字符（影响小）。改它需同改 features/chat 文件（跨边界），登记待协调。
- **A6-13 文本模型「图片被忽略」提示（前端）** 需 `ModelInfo` 暴露多模态能力位（当前仅 id/name/model/is_default），涉及 `get_models` 后端 + 前端联动，登记为后续。
- **A6-21**（→代理1）`notes_manager` canvas AI 工具无乐观锁，提供笔记侧上下文（见上）。

## 共享文件改动登记

- `src/mcp-debug/registerStores.ts`：移除导图三个旧 store 注册项（本域死代码清理，已与导图域一致）。
- i18n locales（本域命名空间，新增键，已跑 check:i18n 通过）：
  - `essay_grading.json` zh/en：`score.parse_failed`
  - `translation.json` zh/en：`confirm.clear_title`
  - `mindmap.json` zh/en：`import.unsavedTitle`、`import.unsavedConfirm`、`store.conflictSnapshotKept`、`store.conflictBannerTitle`、`store.conflictRestoreMine`、`store.conflictDismiss`
- 后端本域类型（非共享 models.rs）：`essay_grading/types.rs`、`translation/types.rs` 各移除 `accumulated` 字段（A6-11）；`notes_manager.rs` 删除 note_links 死代码（A6-14）；`essay_grading/pipeline.rs` `build_grading_prompts` 增参（A6-13）；`notes_exporter.rs` 附件流式化（A6-23）。均属各自本域文件。

## 环境备忘

- 本机 `eslint-plugin-react-hooks` 未安装（node_modules 缺失，疑似 E 盘满事件后遗留）→ 凡含 `// eslint-disable-next-line react-hooks/exhaustive-deps` 的文件 eslint 会报 "Definition for rule ... was not found"（环境性，非本轮引入）。已用未改动的 `TranslateWorkbench.tsx` 比对确认为既有基线。本轮以「改动文件不新增 error」为准绳（A6-16 还净减了 2 个 no-alert error）。
- PowerShell 不支持 `&&`，命令用 `;` 或分开执行。E 盘空间紧张，写文件前注意。

# 代理 6（round 2）—— 笔记·导图·翻译·作文批改

> 先读 `docs/6.13/README.md`，再通读 `docs/6.12/status/agent-6-status.md`（A6-01–A6-30，17 已修）。

## 已完成（勿重做）
- 第一轮：A6-01~10、A6-18/19/20/22/25/26/28。
- 收尾会话：A6-27（`builtin_resource_executor` 改 text 清 `blankedRanges` + `add_node` 去重 id）；删死组件 `AnnotatedText.tsx`、`TranslationHistory.tsx`、`GradingHistory.tsx`、`NoteEditorView.tsx`。

## 本轮任务（按优先级）

### P1 — UX 低风险（直接做 + 验证）
- [ ] **A6-30** 作文批改 `parseScore` 解析失败时总分区静默缺失：在 `GradingStreamRenderer.tsx`（`ScoreCard score={scoreOnly}` 分支，~L221）与 `StreamingAnnotatedText.tsx`（~L262）补：`!isStreaming && content && !score` 时渲染"评分解析失败，请查看下方批改正文"降级提示（新增 i18n key `essay_grading:score.parse_failed`，zh-CN + en-US）。
- [ ] **A6-29** 作文批改加 `Ctrl/Cmd+Enter` 提交快捷键（对齐翻译；触发 `EssayGradingWorkbench.handleGrade`，注意输入框聚焦/`isGrading` 守卫，参考 `TranslateWorkbench` 的 isActive 守卫范式避免多标签互踩）。
- [ ] **A6-16** `window.confirm` → `NotionAlertDialog`：`TranslateWorkbench`（清空确认）、`MindMapContentView`（导入未保存确认）。改成声明式对话框（需加 state + onConfirm）。

### P1 — 死代码清理（A6-14 群剩余）
- [ ] `essayGradingApi.listSessions`（返回类型与注释不符、无人调用）；导图旧拆分 store `store/documentStore.ts`/`historyStore.ts`/`uiStore.ts`（被合并版 `mindmapStore` 取代，仅 `mcp-debug/registerStores.ts` 动态引用——核实后删并清理 registerStores）；`notes_manager.rs` 的 `note_links` 子系统（extract/rebuild/inbound/get_note_links ~200 行，前端已注明 VFS 模式不维护、命令不存在）。

### P2 — 性能/数据（含跨组）
- [ ] **A6-23** `notes_exporter.rs:collect_all_notes_bundle_vfs`：全部笔记内容 + 附件字节一次性载内存再打 zip。改流式写入 zip。
- [ ] **A6-24** `mindmapStore.ts:save` 冲突分支：清本地草稿后自动重载服务端版本，静默丢用户未保存编辑。对齐笔记域的冲突对话框（冲突时暂存本地快照 + 提供"恢复我的修改"入口）。

### P2 — 大重构 / 跨组（先出方案）
- [ ] **A6-11** `events.rs:emit_data`：每 chunk 重发全量 accumulated 文本 → IPC O(n²)。改发增量需前后端事件契约同改（chat_popover、双 hook 等所有消费方）。出方案，与代理 1（聊天主链路同款 SSE 隐患）协同。
- [ ] **A6-21**（→ 代理 1）：`notes_manager` canvas AI 工具无乐观锁，与用户编辑并发互踩。已在代理 1 任务登记，本组提供笔记侧上下文。

### P3 — 产品取舍（出方案）
- [ ] **A6-12** 超分 clamp vs 按比例换算（业务）。
- [ ] **A6-13** 纯图作文批改被后端 `input_text` 非空强制挡（多模态模型应允许纯图；文本模型应提示图片被丢弃）。
- [ ] **A6-15** 长文（≤50K 字符）单次请求无分段；双栏同步滚动长段对不齐。

## 验证
`npm run typecheck`；`npm run lint`；`npx vitest run src/essay-grading/markerParser.test.ts` 与 mindmap 相关；`cargo check`（notes_manager 改动后）。i18n 改 key 后 `npm run check:i18n`。

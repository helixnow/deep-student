# 代理 1（round 2）—— 对话引擎与 AI 能力扩展

> 先读 `docs/6.13/README.md`，再通读第一轮状态 `docs/6.12/status/agent-1-status.md`（F1–F22 / O1–O19 的完整上下文）。

## 已完成（收尾会话，勿重做）
- F18 `tools/web_search.rs`：移除 3 个从未被读取的死熔断器配置字段。
- F14 `rebuild_chat_fts`：已实现 `ChatV2Repo::rebuild_content_fts` + `search_handlers::rebuild_chat_fts` 命令并在 `lib.rs` 注册。
- A6-27（导图 AI 编辑，原属本组 builtin_resource_executor）、A3-X4（paper_save 截断）已由收尾会话修复。

## 本轮任务（按优先级）

### P1 — 未覆盖区二轮深审（第一轮 T12–T14 未做）
- [ ] **T12 语音输入输出**：`voice_input.rs`、`tts.rs`、`features/voice-input/`。审：录音/播放生命周期、临时文件清理、流式中断、权限失败兜底、隐私（音频是否落盘/外传）。
- [ ] **T13 推理与注入策略 + 用量**：`reasoning_policy.rs`、`injection_budget.rs`、`llm_usage/`。审：预算裁剪正确性、reasoning 配置优先级一致性、用量计费口径（呼应已修的 F6 双计费，确认无其它双计/漏计）。
- [ ] **T14 会话基础**：`session_manager.rs`、`persistent_message_queue.rs`。审：队列持久化/恢复、并发会话隔离、消息时间戳/顺序、僵尸会话清理。

### P1 — 死代码清理
- [ ] **F16(本组编号)** `model2_pipeline.rs:2693` `call_unified_model_stream_with_config`：全仓无调用方的 ~1000 行死代码（含完整流式循环副本，易与主路径漂移）。确认无调用后删除。
- [ ] X 域死包装（前端 invoke 指向不存在/未注册命令，且包装器本身无人调用）：`utils/chatApi.ts` 的 `research_list/get/delete/export_all_reports`（`commands.rs:4273-4310` 已实现但未注册）+ `utils/settingsApi.ts` 的 ~25 个 `research_*`、`features/chat/dev/playground/eval` 的 `chat_v2_send`、`TaskController.ts` 的 `get_document_state`、`services/ankiApiAdapter.ts` 的 `generateAnkiCardsForSegment`(@deprecated)。逐个核实可达性：死则删包装，若被实际入口调用则上报。

### P2 — 已知缺陷
- [ ] **parser.rs:87 / 209**：`extract_numbered_list_format` 与 `extract_markdown_sections` 的正则用了 look-around（`(?=...)` / `(?!...)`），`regex` crate 不支持 → `Regex::new` 恒返 `Err` → 两个解析策略**自写下从未生效**（有 `if let Ok` 守卫，优雅降级不崩溃）。**注意：修复会改变现有解析行为**——需评估这两个兜底策略是否仍需要：要么用不依赖 look-around 的写法/手动切分重写并加测试，要么直接删除死策略。先出方案。
- [ ] **F15** `model2_pipeline.rs:2293`：流中途读错误且已有部分内容时按"部分成功"静默截断，无截断标记事件。需前端配合发截断警示事件（跨代理 6/前端）。

### P3 — 跨组/产品
- [ ] **A6-21**（代理 6 上报）：`notes_manager` 的 canvas AI 工具 `canvas_append/replace/set_content` 是"读-改-写"且不带 `expected_updated_at`，与用户编辑并发会后写覆盖先写。加乐观锁会改变 chat 工具失败语义，出方案待确认。

### 收尾
- [ ] T16 最终总结：本轮发现统计 / 已修复清单 / 待用户决策项，写入状态文档并 `interactive_feedback` 汇报。

## 验证
`cargo check`（在 `src-tauri/`）；前端改动 `npm run typecheck` / `npm run lint`；`cargo test reasoning|injection|llm_usage|session`（若本机 `cargo test` 可跑）。

# 代理 1 状态文档（round 2）—— 对话引擎与 AI 能力扩展

> 本文件是第二轮（docs/6.13）的状态/接力文档。第一轮完整上下文见 `docs/6.12/status/agent-1-status.md`（F1–F22 / O1–O19，禁止清空重写）。
> feed_id=F-NWQDC（mcp-feedback-enhanced）。接力会话请重新注册自己的 feed_id。

## 本轮任务（按 agent-1.md 优先级）
- P1 未覆盖区二轮深审：T12 语音 I/O、T13 推理/注入/用量、T14 会话基础。
- P1 死代码清理：F16 `model2_pipeline.rs` 死流式函数（~1000 行）、X 域前端死包装。
- P2：parser.rs look-around 正则（先出方案）、F15 截断警示事件（跨代理 6/前端）。
- P3：A6-21 canvas 乐观锁（跨代理 6，出方案）。
- 收尾：T16 总结。

## 进度概览
- [完成] T12 语音输入输出深审 —— 已读 voice_input.rs / tts.rs / src/voice-input/*；发现 R2-01..R2-04。
- [完成] T13 推理与注入策略 + 用量 —— 已读 reasoning_policy.rs / injection_budget.rs / llm_usage/*；发现 R2-05..R2-07；确认 F6 双计费修复(O4)在位、无其它活跃双计。
- [完成] T14 会话基础 —— 已读 session_manager.rs / persistent_message_queue.rs / chat_v2/events.rs 序列计数；发现 R2-08(整文件死代码)、R2-09(stub 子系统)。会话顺序由 events.rs per-session AtomicU64 计数器保证、删会话时 clear_session_sequence_counter 清理（manage_session.rs:631），健全。
- [已落地+验证] 低风险修复 OR2-01(R2-01)/OR2-02(R2-02)/OR2-03(R2-05)。
- [已落地+验证] R2-08：删除整文件死代码 `session_manager.rs` + lib.rs:92-93 `#[allow(dead_code)] pub mod`。cargo check exit0 / 100warn 基线不变。
- [已落地+验证] F16：删除死函数 `call_unified_model_stream_with_config`（model2_pipeline.rs 原 2773-3823，1051 行）。用户批准后用保留 LF/UTF-8 编码的行区间脚本删除（删前 ASCII 锚点校验函数签名+前后边界 + 备份），删后 Read 校验切口干净（call_unified_model_2_stream `}` 直接接 call_unified_model_2 注释），cargo check exit0、**警告 100→98（减少 2，无新增）**。
- [已落地+验证] X 域前端死包装：删除 research_* 死包装 —— settingsApi.ts(~26，重写保留 saveTextToFile/readFileText 等并去掉未用 withSessionId 导入) + chatApi.ts(4) + commands.rs:4237-4351 的 4 个未注册 research report 后端命令。tsc exit0 / eslint 改动文件 0 error / cargo check exit0。
- [跨组上报] anki 域两项（TaskController get_document_state、ankiApiAdapter generateAnkiCardsForSegment）→ 代理5（见跨组表）。R2-11 经查为**误报**（cases.ts 的 chat_v2_send 是渲染测试 fixture 字符串内的示例代码，非真实 invoke）。
- [ ] F16 死代码删除
- [ ] X 域前端死包装清理
- [ ] parser.rs look-around 方案
- [ ] F15 截断事件方案
- [ ] A6-21 乐观锁方案
- [ ] T16 总结

## T16 最终总结（round 2）
**发现统计**：R2-01..R2-11（其中 R2-11 误报关闭）。按严重度：bug 1（R2-01 中）、性能/坏味道 5（R2-02/03/05/06...）、死代码 3（R2-08 整文件 / R2-10 research族 / F16 1051行）、stub/未启用 2（R2-07/R2-09）、隐私提示 1（R2-04）。无 P0 运行时破损（T13 确认 F6 双计费修复在位、无其它活跃双计）。

**已落地并验证（OR2-01..OR2-06）**：
- OR2-01 语音 controller 双启动竞态（麦克风/AudioContext 泄漏）→ 同步重入标志。
- OR2-02 tts.rs macOS/Linux 阻塞 Command → spawn_blocking（注：cfg-gated 分支 Windows 上仅代码评审）。
- OR2-03 llm_usage collector 落库尊重显式 provider_id。
- OR2-04/05 删除 research_* 死包装（前端 settingsApi ~26 + chatApi 4；后端 commands.rs 4 命令）。
- OR2-06 删除 F16 死函数（1051 行）。
- R2-08 删除整文件死代码 session_manager.rs。
- OR2-07 parser 方案B：删除两个 look-around 恒失败的死策略。
- OR2-08 删除 R2-06 workspace_id 死 plumbing。
- OR2-09 F15 后端半：截断分支 emit `{event}_truncated`（前端展示待代理6）。
- OR2-10 修 R2-07 误导注释。
- OR2-11 R2-09 整除消息队列 stub（用户授权跨域：lib.rs/metrics_server/health_check + 删文件）。
- OR2-12 R2-13 删错题自动保存死 handler saveRequestHandler（用户授权跨域）。
验证：前端 tsc exit0 / eslint 改动文件 0 error / vitest voiceInput 37 通过；后端 cargo check exit0、警告 **100→97**（无新增，删死码致减少）；全仓确认无其它 look-around / 无 Regex::new(...).unwrap() 动态正则 panic 风险。

**剩余（行为变更型重构/特性，编译器无法验证正确性，建议专项设计+评审而非定稿前赶工）**：
- F15 前端展示：chat_v2 用结构化 block 事件渲染，截断信号需经 ChatV2 事件系统流转（非裸 window 事件），属核心流式 UX，需谨慎设计。
- A6-21 canvas 乐观锁：改变 chat 工具失败语义 + notes_manager（代理6），行为变更。
- R2-07-B injection_budget 接入：工具化注入无单一插入点，接入会改变现有注入行为（回归风险）。
- R2-12 backfill 真实实现：属新功能（需嵌入服务+批量回填），UI 在代理7。
以上均已出设计/方案，登记于本节，建议交对应负责人或作为专项任务实施。

**跨组上报（不在本组落地）**：代理5—TaskController get_document_state 无对应命令、ankiApiAdapter generateAnkiCardsForSegment @deprecated 死包装；代理2—research 命令删除后底层 Database::*_research_report 方法/ResearchReport* 模型可能转为未用，可评估清理。

**纪律**：仅改本域；共享文件(lib.rs/commands.rs)只改本域段并登记；未 git commit/push；未用子代理。

## 审阅发现（round 2，编号 R2-xx）
| # | 文件/位置 | 类型 | 严重度 | 描述 | 处理 |
|---|----------|------|--------|------|------|
| R2-01 | src/voice-input/controller.ts `startRecording` | bug | 中 | 重入/双启动竞态：`if (state.phase !== 'idle') return` 守卫在 `await createRecorderSession()`（含 getUserMedia）之前，phase 直到 await 完成才置 'recording'。两次近同时触发（命令面板事件 + 热键 / 快速双击 toggle）都能穿过守卫并各创建一个录音会话，第二个覆盖 `recorderSession`，**第一个 MediaStream + AudioContext 永不清理（麦克风持续开启）**——既是资源泄漏也是隐私问题。 | 待定：低风险修（同步重入标志 `startingRecording`），先汇报 |
| R2-02 | src-tauri/src/tts.rs `speak_macos`/`speak_linux` | 性能/坏味道 | 低 | async fn 内用阻塞式 `std::process::Command::output()` 等待整段语音合成完成 → 阻塞 tokio worker 线程整个朗读时长。应改 `tokio::process::Command` 或 `spawn_blocking`。仅 macOS/Linux 且为 Web Speech 不可用时的回退路径。 | 待定：低风险修，先汇报 |
| R2-03 | src-tauri/src/tts.rs `tts_stop` / `println!` | 坏味道 | 低 | `tts_stop` 是空实现（仅 `println!`），调用后无法真正停止系统 TTS；模块用 `println!` 而非 `log`。Web Speech 为主路径、系统 TTS 为回退，影响有限。 | 登记（产品取舍/可选，低优先） |
| R2-04 | src/voice-input/history.ts + controller.ts | 隐私 | 低/提示 | 转写文本明文持久化到 settings(`voice_input.history`，最多 12 条)。音频本身从不落盘（仅内存 Blob→base64→后端 multipart 转发 SiliconFlow 云 ASR，符合设计）。文本历史明文存储为产品行为，仅提示。 | 登记（提示，无需改） |
| R2-05 | src-tauri/src/llm_usage/collector.rs `insert_records` vs repo.rs `insert_usage` | 坏味道/数据保真 | 低-中 | **两条发散的用量落库路径**：活跃路径=`UsageCollector::insert_records`（`record_usage_record`→collector.record→后台任务），**忽略** `record.provider_id`，恒用 `extract_provider(model_id)` 启发式；而 `LlmUsageRepo::insert_usage`（尊重 provider_id，且有通过的单测 `test_insert_usage_prefers_explicit_provider_id`）**仅被测试调用**、生产无调用方。后果：voice_input 显式 `.with_provider_id("siliconflow")` 在生产被丢弃→provider 落库为启发式值（"TeleAI/TeleSpeechASR"→"unknown"）。且两套启发式 `extract_provider`/`infer_provider` 逻辑不一致（contains vs starts_with、o3/gemma/qwq 覆盖不同）。 | 待定：低风险修（让 collector 落库尊重 provider_id 并复用单一启发式），先汇报 |
| R2-06 | src-tauri/src/llm_usage/{types.rs,repo.rs} + migrations init.sql | 坏味道/死plumbing | 低 | `workspace_id` 端到端死管线：`UsageRecord` 有字段+`with_workspace_id`、`UsageQueryParams` 有过滤字段，但 `llm_usage_logs` schema 无该列、两个 writer 都不写、`get_recent_usage` 硬编码 `None`、无任何查询消费该过滤。多工作区用量隔离（字段宣称用途）实际不生效。无运行时 SQL 报错（无查询引用该列）。 | 待定：删死 plumbing 或补列+落库+查询，产品取舍先汇报 |
| R2-07 | src-tauri/src/injection_budget.rs + commands.rs:4092/4106 | 架构/未启用配置 | 低(P3) | `InjectionBudgetManager` 仅被 `get_injection_budget_config`(读配置)+`simulate_budget_allocation`(模拟预览)两个命令使用；`allocate()` 从不在真实注入路径(pipeline/tool_loop/rag_extension/memory)被调用→"统一注入预算"在生产**不治理任何东西**（声明+可配置+可模拟但未强制执行，类比 F18）。另 `simulate_budget_allocation` 上方文档注释误写"更新注入预算配置"。 | 登记（产品取舍，出方案待确认） |

备注：`VoiceInputProvider.streamTranscription`（types.ts:73）为可选接口字段，全仓无实现/调用——是预留扩展点，无害，不处理。
voice_input_transcribe（lib.rs:956）、tts_*（lib.rs:1090-1092）均已注册并被使用（TTS 被 TranslateWorkbench 调用）。

| R2-08 | src-tauri/src/session_manager.rs（整文件，仅 lib.rs:93 `pub mod` 声明） | 死代码 | P1 | 整个模块未使用：`SessionManager<T>` trait 全仓无 impl；`StreamContextManager` struct 全仓无 `::new`/实例化（仅定义）。约 85 行。注：因是 `pub` 项，dead_code lint 不报，但内部确无引用。`StreamContext`(models) 与 `Database::get_temp_session_record` 是另一套、不依赖本文件。 | 待定：P1 删除（删文件 + lib.rs:93 `pub mod`），cargo check 兜底；列入死代码清理批次 |
| R2-09 | src-tauri/src/persistent_message_queue.rs | 死/stub 子系统 | P2-P3 | "简化模式" 空壳：`start_message_processor`/`register_message_handlers` 仅 `println!` 返回 Ok；无任何 enqueue 方法、receiver 从不被消费、无 handler 注册；只 `init_database` 建空表 + `export_prometheus_metrics`（恒近 0）。启动时被 lib.rs:407/799/806 调用，metrics_server.rs:88 与 health_check.rs:90 引用。多文件牵涉，删除较重。 | 登记（产品取舍：删除 or 完成实现，出方案待确认） |

| R2-10 | src/utils/settingsApi.ts(~26) + src/utils/chatApi.ts(4) `research*` 包装 | 死代码 | P1 | `research_*` 后端命令在 lib.rs **零注册**（grep `research_` 无命中），且全部前端包装在各自定义文件外**零调用方**。整个 research_*（深调研旧"轮次/会话/报告"子系统）已被技能化深调研取代、遗留为死包装。settingsApi 与 saveTextToFile/readFileText 交错，删后 `withSessionId` 导入变未用需一并清理。commands.rs:4273-4310 的 4 个 research report 命令同为未注册死命令（共享文件，登记）。 | 待落地：删前端死包装(本域)，验证 tsc/lint。已确认死，待用户确认即删 |
| R2-11 | src/features/chat/dev/playground/eval/cases.ts:74 | ~~bug~~ 误报 | — | **误报，已撤销**：该行 `invoke('chat_v2_send',...)` 位于 `PURE_CODE_TS` 模板字符串内，是渲染测试的**示例代码字符串**，非真实 invoke 调用。不处理。 | 关闭（误报） |
| R2-12 | src/utils/chatApi.ts `backfillUserMessageEmbeddings` ← src/features/settings/components/IndexMaintenanceSection.tsx:40 | 未完成功能/空操作 | 低 | 设置页“索引维护”按钮调用该包装，但包装是**空操作**：不 invoke 任何后端、`console.warn('backend command not yet implemented')`、恒返回 0。用户点按无实际效果（静默）。后端命令 `backfill_user_message_embeddings`(本域 chat 索引/嵌入) 从未实现。 | 上报：实现后端命令(本域，属新功能需确认) 或 代理7 禁用/隐藏该按钮 |
| R2-13 | src/app/services/saveRequestHandler.ts + chatApi.ts `runtimeAutosaveCommit`/`updateMistake`(@deprecated 抛错) | 死代码簇 | 低 | 错题自动保存遗留簇：`createSaveRequestHandler` 仅经 app/services/index.ts barrel 再导出、**全仓无实例化**=死；其内部调用的 `runtimeAutosaveCommit`/`updateMistake` 是“后端命令已移除”的抛错 stub（注释明示仅为 saveRequestHandler 编译兼容保留）。属 app/services（代理7）域。 | 上报代理7：确认 saveRequestHandler 死后整簇删除，届时本组同步删 chatApi 两 stub |

### 跨组问题（agent-1.md 列入本组核查、但文件属他域）
| # | 涉及文件 | 问题 | 建议归属 |
|---|---------|------|---------|
| X-A6/5? | src/components/anki/cardforge/engines/TaskController.ts:431 | `invoke('get_document_state')` 无对应注册命令（lib.rs 无 `get_document_state`；后端 `cmd/enhanced_anki.rs:127` 的命令名疑不同）→ 该调用恒失败或为死路径。属 Anki/cardforge 域。 | 代理 5（制卡）核实：修正命令名或确认死路径后清理 |
| X-A5 | src/services/ankiApiAdapter.ts:159 `generateAnkiCardsForSegment`(@deprecated) | 仅注释引用(ankiCompletionNotifier.ts:58)、无真实调用方=死包装。属 Anki 域。 | 代理 5（制卡）删除 |
| X-A7a | src/features/settings/components/IndexMaintenanceSection.tsx:40（R2-12） | 设置“索引维护”按钮调用空操作 backfillUserMessageEmbeddings（恒返回0、后端未实现）。 | 代理 7（设置/壳）：禁用或隐藏按钮；后端命令实现属本组(代理1) |
| X-A7b | src/app/services/saveRequestHandler.ts（R2-13） | 错题自动保存遗留簇，createSaveRequestHandler 全仓无实例化=死。 | 代理 7（app/services）：确认并整簇删除；本组随后删 chatApi 两 stub |
| X-A2 | src-tauri/src/database/* `*_research_report` + models::ResearchReport* | research 命令删除(OR2-05)后，底层 Database 方法/模型可能转为未用。 | 代理 2（数据层）评估清理 |

### T13 计费口径确认（正向结论）
- F6 双计费修复(O4)在位：`model2_pipeline.rs:2742` 单变体 `task_context=="chat_v2"` 跳过内部记账，由 `tool_loop.rs:903` 每轮统一记一次；多变体("chat_v2_variant")仅 model2 内部记一次。无活跃双计。
- `model2_pipeline.rs:3778` 的记账位于**死函数** `call_unified_model_stream_with_config`（F16，且缺 O4 的 chat_v2 跳过守卫，删除 F16 后此风险消失）。
- `model2_pipeline.rs:4958/4976/4994/5017/5049` 为非流式 RAW_PROMPT 路径，均为互斥早退/单次成功记账，无双计。
- reasoning_policy.rs：优先级（OpenRouter→Google→Perplexity→adapter 委托）清晰、单测齐全，无 bug。
- injection_budget allocate() 本身逻辑正确（优先级降序+类型上限+智能截断），问题只是未接入真实路径(R2-07)。

## 已实施的优化（round 2，编号 OR2-xx）
| # | 改动文件 | 改动说明 | 验证结果 |
|---|---------|---------|---------|
| OR2-01 | src/voice-input/controller.ts | 修 R2-01：新增同步重入标志 `startingRecording`，在 `await createRecorderSession` 期间阻止第二次 startRecording 覆盖会话→消除 MediaStream/AudioContext 泄漏（麦克风泄漏）。finally 复位。 | tsc ✓ / eslint ✓ / vitest voiceInput 37/37 ✓ |
| OR2-02 | src-tauri/src/tts.rs | 修 R2-02：speak_macos/speak_linux 的阻塞 `Command::output()` 移入 `tokio::task::spawn_blocking`，不再阻塞异步运行时 worker。 | cargo check ✓(Windows，exit0/100warn 基线不变)。**注：macOS/Linux 分支为 cfg-gated，Windows 上 cargo check 不编译该分支，仅代码评审确认**（spawn_blocking 标准用法、owned String 入闭包、返回类型 `Result<(),AppError>` 经 JoinError map_err? 展开正确）。 |
| OR2-03 | src-tauri/src/llm_usage/collector.rs | 修 R2-05：活跃落库路径 `insert_records` 的 provider 列改为 `record.provider_id.clone().unwrap_or_else(\|\| extract_provider(model_id))`，尊重显式 provider_id（如 voice_input siliconflow），缺省才回退启发式。 | cargo check ✓(exit0/100warn 基线不变) |
| OR2-04 | src/utils/settingsApi.ts + src/utils/chatApi.ts | 修 R2-10（前端）：删除全部 research_* 死包装（settingsApi ~26 个重写保留 saveTextToFile/readFileText/MCP/统计等并移除未用 withSessionId 导入；chatApi 删 4 个 report 包装）。 | tsc ✓ / eslint 改动文件 0 error |
| OR2-05 | src-tauri/src/commands.rs:4237-4351 | 修 R2-10（后端）：删除 4 个未注册 research report 命令（research_list_reports/get_report/delete_report/export_all_reports_zip）+ 其请求结构体，保留一行说明注释。底层 Database 方法/模型留给代理2评估。 | cargo check ✓(exit0/98warn) |
| OR2-06 | src-tauri/src/llm_manager/model2_pipeline.rs | 删 F16：移除死函数 call_unified_model_stream_with_config（1051 行，零调用方）。编码保留脚本删除 + 切口校验。 | cargo check ✓(exit0、警告 100→98) |
| OR2-07 | src-tauri/src/llm_manager/parser.rs | parser 方案B：删除 `extract_numbered_list_format`/`extract_markdown_sections`（look-around 恒编译失败、从不生效的死策略）+ `extract_reasoning_sections` 中对应两分支并重排策略号。净零行为变更。 | cargo check ✓(exit0/98warn)；全仓确认无其它 look-around 正则 |
| OR2-08 | src-tauri/src/llm_usage/{types.rs,mod.rs,repo.rs} | 修 R2-06：删除 `workspace_id` 死 plumbing（UsageRecord 字段+new+with_workspace_id 构造器、UsageQueryParams 过滤字段、两处结构体字面量）。 | cargo check ✓(exit0/98warn) |
| OR2-09 | src-tauri/src/llm_manager/model2_pipeline.rs | F15 后端半：流中途出错且已有部分内容的截断分支额外 emit `{event}_truncated`（reason/error/content_len/...），供前端标记“回复被截断”。纯新增 emit。**前端展示待代理6**。 | cargo check ✓(exit0/98warn) |
| OR2-10 | src-tauri/src/commands.rs | 修 R2-07 误导注释：`simulate_budget_allocation` 上方“更新注入预算配置”→“模拟注入预算分配（…未接入真实注入路径，仅模拟）”。 | cargo check ✓ |
| OR2-11 | src-tauri/src/{lib.rs,metrics_server.rs,test_utils/health_check.rs} + 删 persistent_message_queue.rs | R2-09（用户授权跨域）：整除消息队列 stub —— 删模块声明/init/spawn 块/queue_db_path；metrics_server.gather_metrics 返回空（曾以队列为唯一指标源）；删 health_check 的 memory_intake 探针。 | cargo check ✓(exit0、警告 98→97) |
| OR2-12 | 删 src/app/services/saveRequestHandler.ts + app/services/index.ts barrel + chatApi.ts 注释 | R2-13（用户授权跨域）：删除确认死的错题自动保存 handler（createSaveRequestHandler 全仓无实例化）。保留 dev/ChatSaveTestPanel 及其引用的 chatApi 两 stub（dev 工具，未动）。 | tsc ✓ |

## 跨组问题（发现但不属于本组职责域）
| # | 涉及文件 | 问题描述 | 建议归属代理 |
|---|---------|---------|------------|
| （暂无） | | | |

## 共享文件改动登记
| # | 文件 | 改动段落/函数 | 原因 |
|---|------|-------------|------|
| 1 | src-tauri/src/lib.rs | 删除 `#[allow(dead_code)] pub mod session_manager;`（原 92-93） | R2-08 删整文件死代码 session_manager.rs |
| 2 | src-tauri/src/commands.rs | 删除 4237-4351 的 research report 命令族（research_list_reports/get_report/delete_report/export_all_reports_zip + 2 请求结构体） | R2-10 后端：未注册死命令，本域(研究/AI)清理 |

## P2/P3 方案（部分已按推荐落地，余待确认）
> 已落地：parser 方案B(OR2-07)、R2-06 删 workspace_id(OR2-08)、F15 后端半(OR2-09)、R2-07 注释(OR2-10)。
> 仍待你拍板：F15 前端展示(代理6)、A6-21(代理6)、R2-07 injection_budget 是否接入、R2-09 消息队列 stub 删/留。

### parser.rs look-around（R2 P2）—— ✅ 已落地方案B（OR2-07）
`llm_manager/parser.rs`：`extract_numbered_list_format`(L87 `(?=^\d+\.\s|\z)`) 与 `extract_markdown_sections`(L209 `(?!^#{1,6}\s)`) 用了 look-around；`regex` crate 不支持 → 运行时 `Regex::new` 恒 `Err` → `if let Ok` 守卫令两策略**从不生效**（且每次调用都白白尝试编译一次失败正则）。`extract_reasoning_sections` 链：标准CoT→数字列表(死)→关键词→markdown(死)→语义回退；故数字/markdown 内容实际走关键词或语义回退，不崩溃但非预期策略。
- 方案 A（重写启用，改行为）：改为手动按行切分（数字列表：行首匹配 `^\d+\.\s+` 作为段起；markdown：`^#{1,6}\s+` 作为段起，累积到下一标题），用 `LazyLock` 静态正则仅做行首判定，加单测。**风险**：重新激活两策略会改变 `extract_reasoning_sections` 的分段/标签输出（原本落到 keyword/semantic），需确认前端思维链分段展示可接受。
- 方案 B（删死策略，零行为变更，推荐）：删除这两个函数 + `extract_reasoning_sections` 中对应两个分支。行为完全不变（它们本就从不触发），净减 ~50 行死代码 + 消除两处失败正则编译。
- **推荐 B**（最低风险）；若产品想要数字/markdown CoT 分段能力则选 A（带测试）。等你拍板。

### F15 截断警示事件（R2 P2）—— ✅ 后端半已落地（OR2-09），前端展示待代理6
`model2_pipeline.rs` 流中途读 `Err` 且已有部分内容时 `break` 并按“部分成功”返回 `Ok`——静默截断、无截断标记（F13 修复后概率大降但仍存在）。
- 方案：后端在该截断分支额外 `emit` 一个 `{stream_event}_truncated`（或在 `_end` 事件 stats 增 `truncated:true`）事件（**本域可实现**）；前端（代理6/chat UI）据此显示“回复被截断”徽标/可重试。
- 需与代理6 约定事件契约后联调；后端半可先实现（低风险，纯新增 emit）。等你确认是否现在落后端半 + 通知代理6。

### A6-21 canvas 乐观锁（R2 P3，跨代理6）
`notes_manager` 的 canvas AI 工具 `canvas_append/replace/set_content` 是“读-改-写”且不带 `expected_updated_at`，与用户并发编辑会后写覆盖先写（丢更新）。属代理6（笔记/内容创作）域。
- 方案：给这些工具加乐观锁（带 `expected_updated_at`，版本不符则工具返回冲突错误让 LLM 感知/重试）；**会改变 chat 工具失败语义**（工具可能因版本冲突失败）。或采用“最后写入胜出 + 用户提示”。
- 跨代理6 实现 + 影响 chat 工具层（本域），需你与代理6 共同拍板。本组仅出方案、不动 notes_manager。

### R2-06 workspace_id 死 plumbing（P2/P3）—— ✅ 已落地方案A（删除，OR2-08）
`UsageRecord.workspace_id` + `with_workspace_id` + `UsageQueryParams.workspace_id` 全链存在但无 DB 列/从不写/从不查 → 多工作区用量隔离不生效。
- 方案 A（删死 plumbing，推荐）：移除 `workspace_id` 字段/builder/查询参数（净减面，零行为变更）。
- 方案 B（补全）：迁移加 `workspace_id` 列 + 两个 writer 落库 + 查询消费过滤（实现多工作区隔离，工作量大、涉及迁移）。等你定方向。

### R2-07 injection_budget 未接入（P3）—— 注释已修(OR2-10)；接入(B)=大改造待专项设计
`InjectionBudgetManager.allocate()` 从不在真实注入路径被调用，仅服务 `get_injection_budget_config`/`simulate_budget_allocation` 两命令 → “统一注入预算”生产不治理任何东西。
- 方案 A：文档化为“规划/模拟工具”，保留现状（最小动作）。
- 方案 B：接入真实 RAG/Memory/WebSearch 注入路径做统一裁剪（较大重构，需回归）。
- 方案 C：删除该子系统（若确认无产品规划）。另：`simulate_budget_allocation` 上方文档注释误写“更新注入预算配置”，可顺手修。等你定。

### R2-09 persistent_message_queue stub（P2/P3）—— ✅ 已整除（OR2-11，用户授权跨域）
“简化模式”空壳子系统（无 enqueue/处理器/handler，仅建空表 + 恒0 metrics）。
- 已落地（本域）：在 `persistent_message_queue.rs` 顶部加 `//!` stub 状态说明 + 移除指引。
- **不在本轮整除的原因**：删除需改 `metrics_server.rs`（`gather_metrics` 的**唯一指标源**就是本队列，删后该端点变空——属代理7 观测域的实质行为变更）与 `health_check.rs::check_memory_intake_service`（其判定依赖本队列）。在并行多代理下擅改代理7 文件有冲突风险且会“掏空”其指标服务。
- 建议：代理7 统筹删除（或补全为真实队列）。本组已在 lib.rs 段落（队列 init/spawn）登记，可在代理7 就绪后配合删除 lib.rs 段。

## 接力须知
- 工作目录 e:\2026ds\deep-student；验证：src-tauri 下 `cargo check`；前端 `npm run typecheck` / `npm run lint`；i18n 改动 `npm run check:i18n`。PowerShell 不支持 `&&`，用 `;`。
- cargo 基线 100 warnings / clippy ~805 warnings+25 errors（含 parser.rs look-around 等预存在问题），以现状为基线、不引入新增即可。
- 未经用户明确要求不得 git commit/push；共享文件只改本域段落并登记；不使用子代理。

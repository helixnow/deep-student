# 代理 1 状态文档 —— 对话引擎与 AI 能力扩展

## 任务目标
全面深入审阅 Chat V2 对话全链路(后端 Pipeline ↔ 前端界面)+ 所有"给 AI 接能力"的扩展层:
模型供应商(9 家)、技能系统、MCP、联网搜索/深度调研、智能记忆、语音输入输出。
识别 bug/坏味道/性能隐患/安全风险/体验问题;域内实施低风险优化(高风险方案只登记、等用户确认);
全程维护本状态文档以便接力。

## 当前状态
T1/T2/T3 已审完,发现 F1-F10。用户已授权全部修复("同意所有修复,继续干,全修好")。O1-O6 已验证通过;O7-O10(F2/F5/F7/F9)代码已写完,cargo check 验证中。下一步 T4 供应商适配一致性。最后更新:2026-06-12 23:55

## TODO 计划
- [x] T1 后端 Pipeline 全链路审阅(2026-06-12):pipeline.rs/tool_loop.rs/llm_adapter.rs/send_message.rs/state.rs 全读;发现 F1-F5
- [x] T2 工具执行器与审批机制(2026-06-12):approval_manager/approval_scope/approval_handlers 全读;敏感度默认 fail-closed(None≠Low 需审批)、scope 键 v2 按 server 隔离、防通配桶污染,设计良好,无新发现
- [x] T3 多模型并行(变体对比)与多 Tab 并发(2026-06-12):variant_context.rs/multi_variant.rs/approval链路/事件通道/前端 queue 全读;发现 F6(计费重复)、F8(变体审批失效)、F9(session_id 污染)、F10(队列引用丢失);事件通道按 session 隔离设计良好,变体取消级联(child_token)正确
- [x] T4 9 家供应商适配一致性(2026-06-13):13 个 RequestAdapter 全读(注册表/聚合平台跳过/scope优先设计良好,各家参数差异处理到位且有单测);providers/mod.rs 4 个 ProviderAdapter 流式解析全读(per-request 实例化无跨流污染);model2_pipeline HTTP 重试(429 Retry-After/5xx 退避/401403 直返)设计良好;发现 F11-F16,修复 F11-F14
- [x] T5 技能三级加载与 Token 节省(2026-06-13):chat_v2/skills.rs(路径验证 canonicalize+逻辑规范化双层防遍历,设计良好)、前端 loader/registry/progressiveDisclosure 全读(三级覆盖=Map 后写胜出,project>global>builtin 顺序正确;load_skills 依赖递归含环检测;XML 注入有 escape+CDATA);后端 build_transient_skill_messages 预算裁剪带审计;skills_executor 变体分支用 branch_local_skills 隔离(与 F9 修复配合正确)。无新发现,仅注:progressiveDisclosure LRU 仅按创建序淘汰(后端为权威源,影响极小)
- [x] T6 MCP 连接生命周期(2026-06-13):活跃链路=前端 McpService(SDK)+ 后端经 mcp-bridge-request 事件桥接(tools/mod.rs call_frontend_mcp_tool);前端重连机制完善(keepalive ping 失败阈值触发重连/被动断连最多5次退避/ensureConnected 调用前快速重连/连接错误自动重试一次);后端 src-tauri/src/mcp/ 全局客户端为遗留路径(stdio 优雅关闭/分帧自动回退设计尚可)。发现 F17(桥接超时不匹配+监听器泄漏),已修复 O15
- [x] T7 搜索引擎与深度调研(2026-06-13):web_search.rs 7 引擎适配(google_cse/serpapi/tavily/brave/searxng/zhipu/bocha)全读;上层 WebSearchTool 有 key 预过滤+单/多引擎聚合(do_aggregated_search 并发+去重+融合,全失败才报错)+force_engine 优先级;per-provider 策略(超时/重试/并发/限速/缓存)设计良好;ChatV2 builtin_retrieval 路径带取消 select(口径:单引擎,无聚合,合理)。深度调研=内置技能(todo-tools+web_search+笔记),中断恢复靠 todo 持久化(F4 修复已加固)。发现 F18(熔断器死配置,登记)、修复 F19→O16(无差别重试)
- [x] T8 记忆系统(2026-06-13):write_smart 链路(幂等键 reserve/cache/finalize+相似搜索降级+LLM决策降级ADD+低置信度降级NONE+fact硬拒绝+审计日志)设计完整;隐私模式阻断验证:search/search_with_embedding/search_with_rerank 直接返回空、auto-extract 单变体(persistence.rs:982)+多变体(multi_variant.rs:586)双路径 gate 一致、write_smart 本地标题去重+安全降级新增、category refresh gate、evolution 纯本地 SQLite 无外呼;敏感信息过滤三处入口(auto_extractor/memory_executor 工具/write_smart)一致。发现并修复 F20(幂等预留泄漏)→O17
- [x] T9 敏感信息泄漏排查(2026-06-13):发现高危泄漏链 F21——Gemini/google_cse/serpapi/searxng 把 key 放 URL query,而①LLM_AUDIT 审计日志+调试落盘+前端 chat_v2_llm_request_body 事件裸打 url;②test_connection 的 debug 日志+用户可见错误消息带完整 URL;③reqwest::Error Display 自带完整 URL,8 处 send().map_err 直接格式化;④web_search ToolError::Http 同因。已全部修复(O18)。其余检查:MCP env 日志已 [REDACTED]、test_connection 仅打 key 长度、data_governance 同步无凭证日志、前端 console 无 key 打印、embedding/reranker 测试 key 在 header 无虞
- [x] T10 前端 store 内存审阅(2026-06-13):sessionManager LRU(上限10,淘汰前保存,streaming/in-flight 块不淘汰,pendingEvictions 防双清),destroy 全套清理(adapter/eventBridge/chunkBuffer/autoSave/skills/订阅/变体防抖计时器);附件 Blob URL revoke + pdfProcessingStore 清理到位;chunkBuffer 有 max size+flush。发现并修复 F22(淘汰路径 blockingInteractionUnsubscribers Map 条目泄漏)→O19
- [x] T11 流式渲染性能(2026-06-13):渲染层已系统性优化——MessageList 虚拟化(tanstack-virtual)/直接渲染双模式、MessageItem React.memo 自定义比较屏障、hasActiveBlock 布尔选择器防 Set 引用击穿、useBlocksByIds ref 稳定化、chunkBuffer 写入节流(WINDOW_MS+MAX_SIZE)、MarkdownRenderer memo+useMemo(remark/katex 配置)+流式平滑(streamingSmoothing)。无新发现,不需改动
- [ ] T12 语音输入输出(voice_input.rs、tts.rs、features/voice-input)
- [ ] T13 推理与注入策略(reasoning_policy.rs、injection_budget.rs)、用量追踪(llm_usage/)
- [ ] T14 会话基础(session_manager.rs、persistent_message_queue.rs)
- [ ] T15 域内低风险优化实施 + 验证(穿插进行,集中登记)
- [ ] T16 最终总结:发现统计/已修复清单/待用户决策项

## 审阅发现
| # | 文件/位置 | 类型 | 严重度 | 描述 | 处理 |
|---|----------|------|--------|------|------|
| F1 | chat_v2/pipeline/tool_loop.rs:690-782 | bug | 中 | 外层 LLM 重试(timeout/连接错误)复用同一 adapter(Arc)，register_stream_hooks 不会重置累积状态。若 600s 超时时已流出部分内容(timeout 丢弃 future 但 adapter 已累积)，重试会把第二次响应追加到第一次的部分内容后 → 内容重复(UI+DB)。注释"重新注册 hooks 以清理累积状态"不成立 | 已修复(见 O1) |
| F2 | chat_v2/pipeline/constants.rs:38 + tool_loop.rs:677 | 体验 | 低 | LLM_STREAM_TIMEOUT_SECS=600 是整个流的总时长而非空闲超时；长 agentic 生成(>10min)即使流式健康也会被强制超时。model2_pipeline 内部无空闲超时补偿 | 已修复(见 O7) |
| F3 | chat_v2/handlers/send_message.rs:1384-1393,1452-1455 | bug | 低 | find_preceding_user_message* 用 timestamp<=查找前序用户消息;若相邻消息时间戳相同(同毫秒)，可能选错消息。retry/edit 删除逻辑已改为 index-based(P0修复)但查找逻辑未同步 | 已修复(见 O2) |
| F4 | chat_v2/handlers/send_message.rs:1652-1693 | bug | 低 | chat_v2_continue_message 在 try_register_stream 之前就执行 restore_todo_list_from_db 修改内存 TodoList;若会话已有活跃流,注册失败返回错误但内存状态已被覆盖 | 已修复(见 O3) |
| F5 | chat_v2/pipeline/tool_loop.rs:48-70 | 坏味道 | 低 | has_heartbeat 检查 ctx.tool_results 全量历史而非本轮结果;一次 coordinator_sleep continue_execution=true 后所有后续轮次都被视为有心跳(直到50上限)。有 MAX_HEARTBEAT_COUNT+ABSOLUTE_MAX_RECURSION 兜底,风险有限 | 已修复(见 O8) |
| F6 | llm_manager/model2_pipeline.rs:2657 + chat_v2/pipeline/tool_loop.rs:861 | bug | 中 | Token 用量双重计费:call_unified_model_2_stream 仅被 chat_v2 调用,函数内部 record_llm_usage 一次,tool_loop 每轮成功后又记一次 → 单变体每轮 LLM 调用在 llm_usage_logs 写入 2 条(token 统计 2 倍);多变体路径(task_context="chat_v2_variant")只记内部 1 次,口径不一致 | 已修复(见 O4) |
| F7 | chat_v2/approval_manager.rs + tool_loop.rs request_tool_approval | 坏味道 | 低 | 用户取消流时审批 future 被 select! 丢弃,pending sender 残留(只在 timeout/channel-closed 分支调用 cancel_with_session);之后用户对残留 UI 响应会触发 remember 持久化(意图明确,可接受),pending 条目在 respond 时被弹出,无累积泄漏路径,影响极小 | 已修复(见 O9) |
| F8 | multi_variant.rs:1141,1307 + tool_loop.rs execute_single_tool | bug | 高 | 多变体审批完全失效:multi_variant 以复合键 "{session}:{variant}" 作为 session_id 注册审批 pending,但前端 BlockingApprovalBar 响应时传真实 session_id,ApprovalManager.respond 按 (session,tool_call_id) 精确匹配 → 永远找不到等待者,返回 approval_expired;用户点"允许"无效,工具只能等 60s 超时被拒。"本会话允许"(session_remembered) 同理写入真实键、读取复合键,永远不命中 | 已修复(见 O5) |
| F9 | multi_variant.rs:1307 → ExecutionContext.session_id | bug | 高 | 多变体下 ExecutionContext.session_id 是复合键 "{session}:{variant}",所有按 session 查库的工具在变体模式下失效:subagent_executor get_session 查不到会话、attachment_executor 校验 param_session_id != ctx.session_id 拒绝访问、skills_executor load_session_state_v2 读写到不存在的会话、chatanki/workspace 所有权校验失败。todo_executor 依赖复合键做变体间内存隔离(复查:sleep_executor 实际按 workspace_id 隔离、且需要真实 session_id 写库,复合键反而破坏它) | 已修复(用户授权,见 O10) |
| F10 | features/chat/core/store/queueActions.ts maybeDequeue | bug | 中 | 队列出队发送丢弃入队时快照的 contextRefs:send 链路从 store.pendingContextRefs 现值读取引用 → ①用户流式期间改草稿引用会被错误附到队列消息上(串扰);②首条出队后非 sticky 引用被清空,后续队列项全部丢引用 | 已修复(见 O6) |
| F11 | llm_manager/adapters/moonshot.rs:96 | bug | 低 | K2.5 路径 enable_thinking.unwrap_or(true) 忽略模型配置中保存的 enable_thinking/thinking_enabled——用户在配置里关闭思考无效;与其他 8 家适配器的 resolve_enable_thinking 优先级不一致 | 已修复(见 O11) |
| F12 | providers/mod.rs OpenAIAdapter::parse_stream + utils/sse_buffer.rs | bug | 中 | OpenAI 兼容解析器严格要求 "data: "(带空格)前缀,SSE 规范允许 "data:" 无空格(部分供应商/中转站省略)→ 这类流所有数据行被静默丢弃,表现为"连接正常但无任何输出";Responses/Anthropic 解析器是宽容的,口径不一致。check_done_marker 同样问题 | 已修复(见 O12) |
| F13 | llm_manager/mod.rs create_http_client_with_fallback + model2_pipeline.rs | bug | 高 | reqwest 0.11 的 ClientBuilder::timeout(300s) 覆盖「连接+整个响应体下载」——流式响应总时长 >300s 时被 reqwest 中途强杀(早于 Pipeline 600s 超时,实际有效上限是 300s!)。长 agentic 生成必死;之前因 F15 的"部分成功"语义被掩盖成静默截断 | 已修复(见 O13) |
| F14 | providers/mod.rs OpenAIResponsesAdapter::parse_stream | bug | 中 | response.failed / error 事件被吞掉只发 Done:供应商返回的失败原因(配额不足/参数错误)完全丢失,前端只看到空响应,无日志可查 | 已修复(见 O14) |
| F15 | model2_pipeline.rs:2293-2299 流读取 Err 分支 | 体验 | 低 | 流中途读错误且已有部分内容时 break 并按"部分成功"返回 Ok——内容被静默截断,用户无感知(无截断标记事件);F13 修复后触发概率大幅下降。建议:发截断警示事件供前端标记,需前端配合,登记待后续 | 登记(改动涉及前后端协作,暂不动) |
| F16 | model2_pipeline.rs:2693 call_unified_model_stream_with_config | 坏味道 | 低 | 全仓无调用方的死代码(~1000 行,含完整流式循环副本),与主路径双份维护易漂移(本次 SafetyBlocked 修复就要同步改两处) | 登记(删除属大改动,待用户确认) |
| F17 | tools/mod.rs call_frontend_mcp_tool | bug | 中 | ①桥接默认超时 60s 与 executor_registry 给 MCP 工具的 180s 不匹配,慢工具(60-180s)在桥接层被提前掐断误报超时;②外层超时 drop 本 future 时手动 unlisten 不执行,每次外层超时在 window 残留一个事件监听器(长会话+不稳定 MCP 服务器会累积泄漏) | 已修复(见 O15) |
| F18 | tools/web_search.rs ProviderStrategy | 坏味道 | 低 | circuit_breaker_enabled/failure_threshold/recovery_timeout_ms 三个熔断器配置字段全仓无读取方——声明了熔断能力但从未实现,SerpAPI 默认 enabled=true 也是空话 | 登记(实现熔断器属新功能,待用户确认) |
| F19 | tools/web_search.rs do_search retry | 坏味道 | 低 | backon retry 无 .when() 条件——ConfigMissing/400/401/403/404 等不可恢复错误也会按 max_attempts 重试,浪费时延且可能重复打 4xx 接口 | 已修复(见 O16) |
| F20 | memory/service.rs write_smart_with_source | bug | 中 | 幂等键 reserve 成功后,decision 主路径之前的 Err 早退点(Note/Study 分支 write_explicit_memory?、is_privacy_mode?、隐私分支 4 个?)不清理 in_progress 预留——一次 DB 偶发错误会把该幂等键卡死到 TTL(数小时),期间同 key 请求全部 Conflict | 已修复(见 O17) |
| F21 | model2_pipeline.rs + tools/web_search.rs | 安全 | 高 | API Key 经 URL query 的供应商(Gemini ?key=、google_cse、serpapi、searxng)密钥泄漏:LLM_AUDIT 日志/调试落盘/前端调试事件裸打 url;test_connection 错误消息含完整 URL 上抛到 UI;reqwest::Error Display 自带 URL,所有 send() 错误格式化点(8处)+流读取错误事件都会带出;web_search ToolError::Http 同因进 ToolResult.error | 已修复(见 O18) |
| F22 | core/session/sessionManager.ts finalizeEviction | bug | 低 | LRU 淘汰路径只清 streamingUnsubscribers,blockingInteractionUnsubscribers 的 Map 条目永久残留(与 destroy 路径不一致);长期使用+频繁切换会话缓慢累积 | 已修复(见 O19) |

## 已实施的优化
| # | 改动文件 | 改动说明 | 验证结果 |
|---|---------|---------|---------|
| O1 | chat_v2/pipeline/llm_adapter.rs + tool_loop.rs | 新增 ChatV2LLMAdapter::reset_stream_state();外层重试前显式重置累积内容/工具调用/think标签缓冲,保留块ID避免前端孤儿块(修复F1) | cargo check 通过 |
| O2 | chat_v2/handlers/send_message.rs | 新增 locate_preceding_user_message() index-based 查找,替换两处 timestamp<= 查找(修复F3) | cargo check 通过 |
| O3 | chat_v2/handlers/send_message.rs | chat_v2_continue_message:try_register_stream 提前到 restore_todo_list_from_db 之前,后续错误路径补 remove_stream(修复F4) | cargo check 通过 |
| O4 | llm_manager/model2_pipeline.rs | call_unified_model_2_stream 内部 record_llm_usage 仅在 task_context!="chat_v2" 时执行,消除单变体双重计费;多变体/其他调用方不受影响(修复F6) | cargo check 通过 |
| O5 | chat_v2/pipeline/tool_loop.rs | execute_single_tool 审批链路新增 approval_session_id:剥离 ":{variant}" 后缀还原真实 session_id(修复F8)。注:O10 实施后 session_id 本身已是真实值,该后缀剥离逻辑已被 O10 撤销简化 | cargo check 通过(后被 O10 取代) |
| O6 | features/chat/core/store/queueActions.ts | maybeDequeue 发送前将 pendingContextRefs 临时替换为队列项快照(保留草稿 sticky),发送后若用户未在窗口内修改(dirty=false)则恢复草稿引用(修复F10) | queueActions 29 项单测通过 + tsc typecheck 通过 |
| O7 | chat_v2/pipeline/constants.rs + helpers.rs + llm_adapter.rs + variant_adapter.rs + tool_loop.rs + multi_variant.rs | LLM 流式超时语义从「总时长600s」改为「空闲600s + 绝对上限2h」:adapter 增加 last_activity_at/touch_activity/idle_elapsed(所有 hook 回调刷新);helpers 新增 wait_llm_stream_with_idle_timeout(每10s轮询空闲时长);4 处调用点(单变体主调用/重试、变体首轮/工具轮)全部改造,超时错误消息区分 idle/total(修复F2) | cargo check 验证中 |
| O8 | chat_v2/context.rs + chat_v2/pipeline/tool_loop.rs | PipelineContext 新增 last_round_heartbeat 字段;has_heartbeat 改读该字段(仅最近一轮),每轮工具执行后更新(修复F5) | cargo check 验证中 |
| O9 | chat_v2/pipeline/helpers.rs + tool_loop.rs | ApprovalOutcome 新增 Cancelled;request_tool_approval 接收 cancellation_token,select! 同时监听审批响应与取消信号,流取消时立即 cancel_with_session 清理 pending 并发 approval_cancelled 事件(修复F7) | cargo check 验证中 |
| O10 | chat_v2/pipeline/multi_variant.rs + chat_v2/tools/todo_executor.rs + tool_loop.rs | F9 结构性修复:multi_variant 给 execute_tool_calls 传真实 session_id(变体隔离由 variant_id 参数承担);todo_executor 内部组合 session_id:variant_id 作为内存 TodoList 隔离键;tool_loop 审批链路撤销 O5 的后缀剥离逻辑、直接用真实 session_id。子代理/附件/技能状态/chatanki/workspace 所有权校验在变体模式下恢复正常(修复F9)。复查确认 sleep_executor 按 workspace_id 隔离、需要真实 session_id 写库,本修复顺带修好它 | cargo check 验证中 |
| O11 | llm_manager/adapters/moonshot.rs | K2.5 thinking 解析改为 enable_thinking.or(config.enable_thinking).unwrap_or(true):尊重配置开关,保持 K2.5 默认启用(修复F11) | cargo check 验证中 |
| O12 | providers/mod.rs + utils/sse_buffer.rs | OpenAIAdapter::parse_stream 改用 strip_prefix("data:") + 可选空格,兼容无空格 SSE;check_done_marker 同步兼容 "data:[DONE]";新增单测 openai_adapter_parse_stream_accepts_data_prefix_without_space(修复F12) | cargo check 验证中 |
| O13 | llm_manager/model2_pipeline.rs | 新增 STREAMING_REQUEST_TIMEOUT_SECS=7200,call_unified_model_2_stream 的请求 builder 按请求覆盖 .timeout(2h),解除 reqwest 客户端 300s 总超时对流式响应的截杀;挂起防护由 Pipeline 层空闲超时(O7)负责;非流式调用不受影响(修复F13,与O7配套) | cargo check 验证中 |
| O14 | providers/mod.rs + llm_manager/model2_pipeline.rs | Responses 解析器 response.failed/error 事件:记录错误日志 + 以 SafetyBlocked(type=provider_error) 上抛;model2 SafetyBlocked 分支区分 provider_error 与安全阻断,错误事件不再误标为"安全策略阻断"(修复F14) | cargo check 验证中 |
| O15 | tools/mod.rs call_frontend_mcp_tool | 桥接默认超时 60s→180s(对齐 executor_registry 的 MCP 工具超时);监听器注销改为 RAII guard(Drop 时 unlisten),外层超时 drop future 也不再泄漏监听器(修复F17) | cargo check 验证中 |
| O16 | tools/web_search.rs | do_search 重试加 .when(is_retryable):Config/4xx(400/401/403/404)不重试,网络错误/429/5xx 才重试(修复F19) | cargo check 验证中 |
| O17 | memory/service.rs | write_smart_with_source 新增 cleanup_on_err 闭包,预留后主路径前的全部 Err 早退点(Note/Study/隐私分支共 7 处?)套 .map_err 清理幂等预留(修复F20) | cargo check 验证中 |
| O18 | llm_manager/model2_pipeline.rs + tools/web_search.rs | 密钥泄漏修复:①新增 sanitize_url_for_log(query 中 key/api_key/apikey/token/access_token/secret → [REDACTED]),log_llm_request_audit/log_and_emit_llm_request 统一脱敏后再日志/落盘/发前端;②test_connection 6 处 URL 输出改用脱敏值;③8 处 send() map_err + 流读取错误分支改用 e.without_url();④web_search 新增 redact_url_secrets 正则,err_from_tool_error 入口统一脱敏;新增 2 个单测(修复F21) | cargo check 验证中 |
| O19 | core/session/sessionManager.ts | finalizeEviction 补齐 blockingInteractionUnsubscribers 清理,与 destroy 路径对齐(修复F22) | tsc 待验证 |

## 跨组问题(发现但不属于本组职责域)
| # | 涉及文件 | 问题描述 | 建议归属代理 |
|---|---------|---------|------------|

## 共享文件改动登记
| # | 文件 | 改动段落/函数 | 原因 |
|---|------|-------------|------|

## 接力须知
- 本会话通过 mcp-feedback-enhanced 与用户交互,feed_id=F-GLUT9;接力会话应重新注册自己的 feed_id。
- 工作目录 e:\2026ds\deep-student;验证命令见 docs/6.12/README.md 3.4(Windows PowerShell 5,不支持 &&,用 ; 分隔)。
- 未经用户明确要求不得 git commit/push;共享文件(commands.rs/lib.rs/models.rs/App.tsx/locales)只改本域段落并登记。
- 审阅顺序按 TODO 编号;每完成一个单元立即更新本文档。

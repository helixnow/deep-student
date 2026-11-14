# L02-llm-manager：LLM 管理与翻译

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L02-llm-manager（LLM 管理与翻译） |
| 目录 | `host/plugins/llm/`（同 lane 另有 `host/plugins/translation/`，文件划分见 `scripts/electron-migration/lib/lanes.mjs` 的 DIR_SPLIT） |
| Rust 范围（lanes.md） | dstu-llm 的 llm_manager、dstu-tutor、translation-core、src/translation，以及 translation 和 settings_models 工具 |
| 主要提供 | **`llm@1`（H16 里程碑）**、`translation@1` |
| 主要消费 | L01、F3、F4 |
| 特别注意 | 吸收现有 `src/plugins/translation` 及其三方对照；模型配置冻结、llm_usage、路由、单次流式 |
| 规模（本目录） | 49799 行 · 49 个文件 · 20 个命令（前端调用 11） · 667 个测试 |
| 规模（整条 lane，inventory） | 56347 行 · 70 个文件 · 26 个命令（前端 13） · 709 个测试 |
| 契约 | [`contracts/ipc/L02-llm-manager.json`](../../../contracts/ipc/L02-llm-manager.json) |
| 服务草稿 | [`contracts/services/DRAFT-L02-llm-manager.md`](../../../contracts/services/DRAFT-L02-llm-manager.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-llm/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-llm/src/anki_model_routing.rs` | 836 | 23 |  |
| `src-tauri/crates/dstu-llm/src/config_recovery.rs` | 219 | 0 | 2 |
| `src-tauri/crates/dstu-llm/src/deepseek_ocr_parser.rs` | 414 | 8 |  |
| `src-tauri/crates/dstu-llm/src/lib.rs` | 44 | 0 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/anthropic.rs` | 1138 | 35 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/deepseek.rs` | 1005 | 23 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/doubao.rs` | 338 | 11 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/ernie.rs` | 507 | 20 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/gemini.rs` | 488 | 15 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/generic_openai.rs` | 1026 | 26 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/grok.rs` | 451 | 15 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/mimo.rs` | 76 | 0 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/minimax.rs` | 370 | 11 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/mistral.rs` | 358 | 12 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/mod.rs` | 648 | 13 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/moonshot.rs` | 1398 | 29 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/qwen.rs` | 566 | 16 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/streaming_harness.rs` | 733 | 28 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/adapters/zhipu.rs` | 541 | 17 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/builtin_vendors.rs` | 1902 | 19 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/compaction_budget.rs` | 5 | 0 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/exam_engine.rs` | 1714 | 4 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/mod.rs` | 8964 | 70 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs` | 10081 | 91 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/ocr_models.rs` | 74 | 0 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/opencode_go.rs` | 640 | 9 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/parser.rs` | 533 | 0 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/provider_quirks.rs` | 422 | 4 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/question_authoring.rs` | 465 | 7 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/rag_extension.rs` | 1916 | 1 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/reasoning_level_map.rs` | 487 | 16 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/routing.rs` | 1402 | 27 | 2 |
| `src-tauri/crates/dstu-llm/src/llm_manager/single_shot_stream.rs` | 1591 | 14 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/transient_messages.rs` | 30 | 0 |  |
| `src-tauri/crates/dstu-llm/src/llm_manager/web_search_fallback.rs` | 61 | 0 |  |
| `src-tauri/crates/dstu-llm/src/ocr_circuit_breaker.rs` | 384 | 11 |  |
| `src-tauri/crates/dstu-llm/src/reasoning_policy.rs` | 734 | 34 |  |
| `src-tauri/crates/dstu-llm/src/vendors/mod.rs` | 12 | 0 |  |
| `src-tauri/crates/dstu-llm/src/vendors/siliconflow.rs` | 172 | 0 |  |
| `src-tauri/crates/dstu-tutor/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-tutor/src/essay_grading/custom_modes.rs` | 761 | 5 |  |
| `src-tauri/crates/dstu-tutor/src/essay_grading/events.rs` | 168 | 0 |  |
| `src-tauri/crates/dstu-tutor/src/essay_grading/mod.rs` | 600 | 0 |  |
| `src-tauri/crates/dstu-tutor/src/essay_grading/pipeline.rs` | 2037 | 24 |  |
| `src-tauri/crates/dstu-tutor/src/essay_grading/text_stats.rs` | 319 | 13 |  |
| `src-tauri/crates/dstu-tutor/src/essay_grading/types.rs` | 1092 | 3 |  |
| `src-tauri/crates/dstu-tutor/src/lib.rs` | 23 | 0 |  |
| `src-tauri/src/chat_v2/tools/settings_models_executor.rs` | 2018 | 13 |  |

另有命令定义在其他 lane 拥有的文件里（按命令名分派）：`src-tauri/src/commands.rs`——只迁移下表列出的命令。

### 命令（20）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `call_llm_for_boundary` | `src/commands.rs:4051` | async | app | src/components/anki/cardforge/engines/CardAgent.ts:907<br>src/features/chat/components/ExplainPopover.tsx:94 | (prompt: string) → Value ! AppError |
| `cancel_stream` | `src/commands.rs:341` | async | app | src/essay-grading/useEssayGradingStream.ts:288<br>src/essay-grading/useEssayGradingStream.ts:499<br>src/essay-grading/useEssayGradingStream.ts:545<br>…共 9 处 | (streamEventName: string) → boolean ! AppError |
| `check_api_config_status` | `crates/dstu-llm/src/config_recovery.rs:192` | async | none | — | (（无）) → Value ! string |
| `estimate_tokens` | `src/commands.rs:316` | async | none | — | (request: EstimateTokensRequest) → Value ! AppError |
| `fetch_vendor_models` | `src/commands.rs:3106` | async | none | — | (vendorId: string) → FetchedVendorModel[] ! AppError |
| `get_api_configurations` | `src/commands.rs:2127` | async | app | src/components/NoTagTreeShadPanel.tsx:90<br>src/components/WebSearchAdvancedConfig.tsx:156<br>src/components/onboarding/WelcomeOnboardingDialog.tsx:85<br>…共 15 处 | (（无）) → ApiConfig[] ! AppError |
| `get_injection_budget_config` | `src/commands.rs:6913` | async | none | — | (（无）) → Value ! AppError |
| `get_model_assignments` | `src/commands.rs:2175` | async | app | src/components/NoTagTreeShadPanel.tsx:91<br>src/components/WebSearchAdvancedConfig.tsx:151<br>src/features/chat/adapters/tauri/modelSelection.ts:158<br>…共 14 处 | (（无）) → ModelAssignments ! AppError |
| `get_model_profiles` | `src/commands.rs:2206` | async | app | src/features/chat/components/input-bar/InputBarV2.tsx:783<br>src/features/chat/hooks/useFavoriteChatModels.ts:51<br>src/utils/configApi.ts:135 | (（无）) → ModelProfile[] ! AppError |
| `get_vendor_configs` | `src/commands.rs:2193` | async | app | src/features/chat/components/input-bar/ModelPicker.tsx:182<br>src/features/chat/components/input-bar/RuntimeModelMenu.tsx:100<br>src/features/chat/plugins/chat/ModelPanel.tsx:108<br>…共 4 处 | (（无）) → VendorConfig[] ! AppError |
| `llm_get_failover_policy` | `crates/dstu-llm/src/llm_manager/routing.rs:781` | async | none | — | (（无）) → FailoverPolicy ! AppError |
| `llm_set_failover_policy` | `crates/dstu-llm/src/llm_manager/routing.rs:789` | async | none | — | (policy: FailoverPolicy__De) → null ! AppError |
| `opencode_go_get_usage` | `src/commands.rs:3311` | async | none | — | (vendorId?: string \| null) → OpenCodeGoUsage ! AppError |
| `restore_default_api_configs` | `crates/dstu-llm/src/config_recovery.rs:166` | async | none | — | (（无）) → string ! string |
| `save_api_configurations` | `src/commands.rs:2149` | async | app | src/utils/configApi.ts:108 | (configs: ApiConfig__De[]) → null ! AppError |
| `save_model_assignments` | `src/commands.rs:2182` | async | app | src/features/chat/components/input-bar/ModelPicker.tsx:363<br>src/features/chat/plugins/chat/ModelPanel.tsx:266<br>src/features/chat/readiness/autoAssignModel.ts:402<br>…共 4 处 | (assignments: ModelAssignments__De) → null ! AppError |
| `save_model_profiles` | `src/commands.rs:2211` | async | app | src/features/chat/hooks/useFavoriteChatModels.ts:130<br>src/utils/configApi.ts:144 | (profiles: ModelProfile__De[]) → null ! AppError |
| `save_vendor_configs` | `src/commands.rs:2198` | async | app | src/utils/configApi.ts:126 | (configs: VendorConfig__De[]) → null ! AppError |
| `simulate_budget_allocation` | `src/commands.rs:6927` | async | none | — | (testItems: Value[]) → Value ! AppError |
| `test_api_connection` | `src/commands.rs:3321` | async | app | src/features/settings/components/ShadApiEditModal.tsx:853<br>src/features/settings/components/useSettingsVendorState.tsx:145<br>src/utils/settingsApi.ts:250 | (apiKey: string, apiBase: string, apiProtocol?: string \| null, supportsOpenaiResponses?: boolean \| null, providerType?: string \| null, providerScope?: string \| null, authMode?: string \| null, modelAdapter?: string \| null, model?: string \| null, vendorId?: string \| null, headers?: object \| null, isEmbedding?: boolean \| null, isReranker?: boolean \| null, isImageGeneration?: boolean \| null, isReasoning?: boolean \| null, supportsReasoning?: boolean \| null, enableThinking?: boolean \| null, thinkingBudget?: integer(i32) \| null, includeThoughts?: boolean \| null, reasoningEffort?: string \| null, reasoningMode?: string \| null, maxOutputTokens?: integer(u32) \| null, maxTokensLimit?: integer(u32) \| null, geminiApiVersion?: string \| null) → ConnectionTestOutcome ! AppError |

### 发出的事件（24）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `chat_v2_llm_request_body` | 字面量 | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4002 (emit) |
| `chat_v2://model_assignments_changed` | 常量 `MODEL_ASSIGNMENTS_CHANGED_EVENT` | src/chat_v2/tools/settings_models_executor.rs:412 (emit) |
| `chat_v2://model_profiles_changed` | 常量 `MODEL_PROFILES_CHANGED_EVENT` | src/chat_v2/tools/settings_models_executor.rs:616 (emit) |
| `chat_v2://settings_changed` | 常量 `SETTINGS_CHANGED_EVENT` | src/chat_v2/tools/settings_models_executor.rs:234 (emit) |
| `deepseek_ocr_log` | 字面量 | crates/dstu-llm/src/llm_manager/exam_engine.rs:458 (emit) |
| `llm-failover` | 常量 `FAILOVER_EVENT_NAME` | crates/dstu-llm/src/llm_manager/routing.rs:709 (emit) |
| `mcp-bridge-tools-request` | 字面量 | crates/dstu-llm/src/llm_manager/mod.rs:8240 (emit) |
| `stream_error` | 字面量 | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7179 (emit) |
| `{}_cancelled` | 动态（format!） | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6728 (emit) |
| `{}_error` | 动态（format!） | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7045 (emit) |
| `{}_id` | 动态（format!） | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6614 (emit) |
| `{}_memory_sources` | 动态（format!） | crates/dstu-llm/src/llm_manager/mod.rs:5350 (emit)<br>crates/dstu-llm/src/llm_manager/mod.rs:5409 (emit)<br>crates/dstu-llm/src/llm_manager/model2_pipeline.rs:5997 (emit) |
| `{}_rag_sources` | 动态（format!） | crates/dstu-llm/src/llm_manager/mod.rs:5338 (emit)<br>crates/dstu-llm/src/llm_manager/mod.rs:5397 (emit) |
| `{}_reasoning` | 动态（format!） | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6831 (emit)<br>crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7410 (emit) |
| `{}_safety_blocked` | 动态（format!） | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7019 (emit) |
| `{}_start` | 动态（format!） | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6284 (emit) |
| `{}_usage` | 动态（format!） | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6980 (emit) |
| `{}_web_search` | 动态（format!） | crates/dstu-llm/src/llm_manager/mod.rs:5324 (emit)<br>crates/dstu-llm/src/llm_manager/mod.rs:5384 (emit)<br>crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7004 (emit) |
| `channel` | 动态（表达式） | crates/dstu-llm/src/llm_manager/mod.rs:126 (emit) |
| `error_event` | 动态（表达式） | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7175 (emit) |
| `Self::event_name(stream_session_id)` | 动态（表达式） | crates/dstu-tutor/src/essay_grading/events.rs:39 (emit)<br>crates/dstu-tutor/src/essay_grading/events.rs:66 (emit)<br>crates/dstu-tutor/src/essay_grading/events.rs:86 (emit)<br>crates/dstu-tutor/src/essay_grading/events.rs:146 (emit)<br>crates/dstu-tutor/src/essay_grading/events.rs:160 (emit) |
| `session_channel` | 动态（表达式） | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:5152 (emit) |
| `stream_event` | 动态（表达式） | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6810 (emit)<br>crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7390 (emit) |
| `truncated_event` | 动态（表达式） | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7155 (emit) |

### 契约中的事件（21，`contracts/ipc/L02-llm-manager.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `chat_v2://model_assignments_changed` | 否 | object | src/chat_v2/tools/settings_models_executor.rs:412 (emit) |
| `chat_v2://model_profiles_changed` | 否 | object | src/chat_v2/tools/settings_models_executor.rs:616 (emit) |
| `chat_v2://settings_changed` | 否 | object | src/chat_v2/tools/settings_models_executor.rs:234 (emit) |
| `chat_v2_llm_request_body` | 否 | object | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4002 (emit) |
| `chat_v2_session_{}` | 是 | object \| object \| Value | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:5152 (emit) |
| `deepseek_ocr_log` | 否 | object | crates/dstu-llm/src/llm_manager/exam_engine.rs:458 (emit) |
| `essay_grading_stream_{}` | 是 | GradingStreamCancelled \| GradingStreamComplete \| GradingStreamData \| GradingStreamError \| GradingStreamProgress | crates/dstu-tutor/src/essay_grading/events.rs:39 (emit)<br>crates/dstu-tutor/src/essay_grading/events.rs:66 (emit)<br>crates/dstu-tutor/src/essay_grading/events.rs:86 (emit)<br>crates/dstu-tutor/src/essay_grading/events.rs:146 (emit)<br>crates/dstu-tutor/src/essay_grading/events.rs:160 (emit) |
| `llm-failover` | 否 | object | crates/dstu-llm/src/llm_manager/routing.rs:709 (emit) |
| `mcp-bridge-tools-request` | 否 | object | crates/dstu-llm/src/llm_manager/mod.rs:8240 (emit) |
| `stream_error` | 否 | object | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7179 (emit) |
| `{}_cancelled` | 是 | object | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6728 (emit) |
| `{}_error` | 是 | object \| Value | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7045 (emit)<br>crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7175 (emit) |
| `{}_id` | 是 | object | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6614 (emit) |
| `{}_memory_sources` | 是 | object \| object | crates/dstu-llm/src/llm_manager/mod.rs:5350 (emit)<br>crates/dstu-llm/src/llm_manager/mod.rs:5409 (emit)<br>crates/dstu-llm/src/llm_manager/model2_pipeline.rs:5997 (emit) |
| `{}_rag_sources` | 是 | object | crates/dstu-llm/src/llm_manager/mod.rs:5338 (emit)<br>crates/dstu-llm/src/llm_manager/mod.rs:5397 (emit) |
| `{}_reasoning` | 是 | Value | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6831 (emit)<br>crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7410 (emit) |
| `{}_safety_blocked` | 是 | Value | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7019 (emit) |
| `{}_start` | 是 | object | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6284 (emit) |
| `{}_truncated` | 是 | object | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7155 (emit) |
| `{}_usage` | 是 | Value | crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6980 (emit) |
| `{}_web_search` | 是 | object \| object \| object | crates/dstu-llm/src/llm_manager/mod.rs:5324 (emit)<br>crates/dstu-llm/src/llm_manager/mod.rs:5384 (emit)<br>crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7004 (emit) |
<!-- END GENERATED:lane -->

## 备注

### WP-209 · HPIAS 无会话 config-id raw prompt

公开增补 `LlmRawPrompt.callWithConfigIdRawPrompt(configId:string,prompt:string,signal?:AbortSignal):Promise<StandardModel2Output>`。
消费方从 `api.ts` 导入 `llmRawPromptService`，inject 其 name，再调用
`ctx.llmRawPrompt.callWithConfigIdRawPrompt('_hpias_synthesis_', prompt, signal)`；读取 `assistant_message`。
`index.ts:121–126` 原 provide 直接发布，两个config-id出口共用 `withConfigIdScoped`；无会话传null。
id优先→model名→Model2及原WARN、无JSON强制、caller chat_v2/task compaction、usage/审计/错误均复用。
signal中止实际HTTP及两层重试，拒绝值为原signal.reason；L17/WP-211负责90秒timeout/drop/fallback。
起点main `df2cd30a1cacf598df851f40d643bb12ceacc7f2` 已含213/131/088/108；
起点类型job `20261105230458-e8ffa4` exit0，相关三文件job `20261105230459-2660ec` 34/0/0、exit0、Errors0。
新入口本地HTTP证据与最终稳定tip/base、正式门禁原件见WP-209交付报告；不借WP-213旧证。
TESTMAP保持706 ported/3 pending，本包资格变化0，不签收HPIAS消费整链或C。

### WP-213 · policy_precision 正指数期望窄修

正常合入 main `be646f2522f1028ae6e6553f5afeb201b05e76c4` 得 `e1ff84d3e007ef4003bcf1ce09a8a688200825ca`。
起点单文件 `20261105221508-21dac7` raw1、4 passed/1 failed/0 skipped、Errors0，
原106:29全文 WARN 的 `e19`/`e+19` 差异复现（177ms）。按 Cargo.lock 锁定的
serde_json 1.0.149 error.rs:471–475 → zmij 1.0.21 lib.rs:1100–1105，
仅将原96/101两个 expected 改为 `1.8446744073709552e+19`，附来源注释。
六原输入、完整 WARN toEqual、column39/42、整 policy 回退60秒、真实 HTTP401/
冷却截止/下一请求 fail-fast 与原预算均保留；最后非法 backoff 的 keyCooldownSecs:9 仍整体丢弃。
修后 Node `20261105221603-894f8f`、Electron `20261105221603-0a6a29` 均5/0/0、raw0、Errors0，
六向量均执行完毕（目标用例998ms/666ms）。TESTMAP 706 ported/3 pending 去向不变。
正式门禁的 tip/base、子job/raw 见 WP-213 交付报告。

### WP-131 · 持久化 FailoverPolicy u64 冷却

承接 `6089a1b73` 测试、`ef4603a18` decoder/消费者和 `0a10945e9` 正式接线。
F4 main `util/api.ts::JsonReader` typed `readUnsigned` 保留两个 u64 字段为 bigint；
`LlmControl.getFailoverPolicyExact` 直接供 embedding 原冷却消费者在 1..3600 clamp 后转 number。
对外既有 `FailoverPolicy` number 投影保留。Rust 分支与证据见 SPEC / TESTMAP。
原定向71条、两插件全测及旧门禁均已有通过原件；恢复会话仅补 Electron SQLite 验证、
本节证据和最新 main 上正式门禁。最终 job/raw/提交见 WP-131 交付报告。

### WP-088 · memory_decision 角色 raw prompt 供方（D36）

`llmRawPrompt@1` 增补方法（`api.ts`，既有方法签名不变）：

```ts
callMemoryDecisionRawPrompt(prompt: string, signal?: AbortSignal): Promise<StandardModel2Output>;
// L17: inject llmRawPromptService.name，再从 ctx.llmRawPrompt 调用
const output = await ctx.llmRawPrompt.callMemoryDecisionRawPrompt(prompt, signal);
const text = output.assistant_message; // wire 字段保持 snake_case
```

对应 Rust `call_memory_decision_raw_prompt`（model2_pipeline.rs:8842）：memory_decision_model → model2、
force_json=true、caller `memory`、task `memory_decision`、非流式无图片、failover。
消费边界：方法在 `ctx.llmRawPrompt` 上，**不在** `ctx.llm`（LLMManager）上；结果是原 `StandardModel2Output`，
不是 L17 当前 `MemoryDecisionCompletion` 的 `{ assistantMessage }`。字段映射由 L17 消费方完成，L02 不加包装。
缺配置抛 `CommandError`，其 `value` 为 `{error_type:'Configuration',message:'没有已启用的有效记忆决策模型（禁止使用嵌入/重排序模型）',details:null}`；
HTTP 错误为原 RAW_PROMPT AppError 值。取消以调用方 `signal.reason` 拒绝（`AbortSignal.timeout` 为 TimeoutError），
不另造 manager 错误：Rust 此处无令牌，超时 Elapsed 属调用方。

### WP-108 · 文本 model2 raw prompt 可取消供方

`llmRawPrompt@1` 的既有公开方法兼容增补第五参（`api.ts`）：

```ts
callModel2RawPromptOpts(
  prompt: string, forceJson: boolean, callerType: LlmCallerType,
  task: string, cancellation?: AbortSignal,
): Promise<StandardModel2Output>;
// L18: inject llmRawPromptService.name，再从 ctx.llmRawPrompt 调用
const output = await ctx.llmRawPrompt.callModel2RawPromptOpts(
  prompt, jsonMode, { other: 'media_handout' }, 'media_handout', runController.signal,
);
```

signal 从文本入口贯穿同一 failover/attempt 到 `llmHttp.fetch`（普通 HTTP 与 L01 Codex SSE bridge），
并中止内部瞬态/外部429退避。预取消在配置读取前失败；取消错误精确为
`{error_type:'Validation',message:'cancelled',details:null}`（handout.rs:41–62），其他错误原样抛出。
原四参调用、model2选择、task fallback、forceJson、caller和成功usage保留。
入口直接等待 transport/timer unwind，无 Promise.race 取消包装；取消后不产生后续请求、usage或成功返回。

Node 新回归 `20261105174045-bdb2f4`：10 passed / 0 failed / 0 skipped，exit0，Errors0。
真实 HTTP 覆盖 headers、JSON body、错误body和Codex SSE中止（peer close 100ms内），
503/429退避取消、task fallback、12轮成功+400错误同signal监听不增长。
起点类型 `20261105173534-eb0c7b` exit0，既有raw/context入口 `20261105173534-94a0d7` 32/0/0 exit0。
最终 Electron/门禁证据见 WP-108 交付报告。L18 handout registry/监听消费接线由L18负责，待合main后消费；
本包供方测试使用公开API独立consumer，不宣称 handout 命令端到端或C级通过。

### WP-022 · 2026-11-06 · 文本 embedding 供方

已发布 `api.ts::TextEmbeddingService` / `embeddingService`，实际 provider 名为字面量
`embedding@1`（不是只在说明中加版本）。L12 `runtime-adapter.ts:99,139,331` 的
`ctx.get('embedding@1').callEmbeddingApi(texts, modelId)` 可直接取到它；L19 同样通过此正式 API 消费。

```ts
import { embeddingService, type TextEmbeddingService } from '../llm/api.ts';
// inject: [embeddingService.name]
const embeddings: TextEmbeddingService = ctx['embedding@1'];
const batch = await embeddings.callEmbeddingApi(texts, modelConfigId);
const single = await embeddings.generateEmbedding(text);
```

源→入口：rag_extension.rs:1009→generateEmbedding，:1025→callEmbeddingApi，:1113→私有raw；
模型默认选择继续由同一llmEmbeddingModels提供，但补齐异步配置重新读取、Rust排序与日志顺序。
L01分块器/MeanPooling、L02共享llmHttp/keyCooldowns、F4 JSON/UTF8、F3 recordLlmUsageExt均直接复用。
WP-002 llmContextCompiler供方保持原接线。

空batch无I/O；响应按数组顺序（不按index排序），f32窄化；HTTP错误保两个结构化标签；
Retry-After内部为number或bigint，冷却只在1..3600秒clamp；成功且数量核验后才记录usage。
服务启动时正式provide；自定义Host缺llmUsage时发送前明确报错，不静默漏记。
多模态embedding与rerank仍由WP-023/024负责，未声称整个D07闭合。

证据：起点 `20261105161452-9ee33c` rag 2 passed/0 failed/0 skipped；typecheck
`20261105161452-30b14b` exit0（排队至后续编辑时才执行，不把它称为冻结起点快照）。
首轮定向 `20261105162657-a4c8a9` 59pass/3fail/exit1；修正Host强制provide及无key夹具authMode后，
`20261105164129-2f4261` 默认/传输66pass，真实F3组合1fail（50次请求期间collector的5秒timer先落42条，
末8条尚在队列）。新测试保50条断言，等待原5秒flush区间；后续回执见WP-022正式报告。
这是TS本地HTTP/真实provider证据，无Rust实录，不计C。底层诊断精度剩余项见BLOCKERS。

### WP-002 · 2026-11-05 · L03 ContextCompiler 高层服务

本节更新下方历史快照：`ContextCompilerLlmOwner` 已作为 `llmContextCompiler@1` 正式提供，
descriptor `llmContextCompilerService`、Cordis `ctx.llmContextCompiler`、meta.provides 与 provider 一致。
直接复用 rawPrompt/ocrPages 的两方法，不新增请求管线。调用失败原样抛 AppError 值。
raw 取消已贯穿普通 HTTP 与真实 L01 Codex bridge，取消后停止退避/后续请求与用量记录。

给 L03 的精确用法（在 chat-pipeline/index.ts 中）：

```ts
import { llmContextCompilerService, type ContextCompilerLlmOwner } from '../llm/api.ts';
// definePlugin({ ..., inject: [...existingDependencies, llmContextCompilerService.name], apply(ctx) { ... } })
const owner: ContextCompilerLlmOwner = ctx.llmContextCompiler;
const output = await owner.callRawPromptWithConfigIdAndImagesCancellable(
  frozenAuxiliaryConfigId,
  '请直接观察图片并给出忠实、紧凑的视觉描述，包含与对话相关的文字、结构、对象和关系。不要臆测。',
  selectedImages.map(image => ({ mime: image.mime_type, base64: image.base64 })),
  'chat_v2',
  stageCancellation.signal,
);
// 独立 OCR 阶段：L03 按 context_compiler.rs:832–859 解码图片、建临时文件，并在 finally 清理。
const text = await owner.callDedicatedOcrFreeTextWithFallback(tempImagePath, ocrStageCancellation.signal);
```

- raw：返回 StandardModel2Output（assistant_message/raw_response/chain_of_thought_details/cancelled）；
  冻结 id 或 model 精确匹配，无跨模型 failover；取消为 `{error_type:'LLM',message:'visual observation cancelled',details:null}`。
- OCR：仅 dedicated 候选，排除 GLM4V/GenericVlm；返回字符串；取消为同形状 `message:'OCR cancelled'`。
  本服务不是 llmFileOcr 的 CommandError 包装；错误应按 AppError.message 交 L03 阶段处理。
- L03 保留原 run_preprocess_stage 超时/轮次预算及降级日志；调用者需在阶段取消时 abort，
  仅 Promise.race 超时而不 abort 不等价于 Rust drop。
- main `967f43c75` 核实 F3 `llmUsage`/`fileManagerPaths`、F7 image、F4 decoder 均已公开；
  `20261105140113-910e05` typecheck exit 0；起点 `20261105140114-097901` 26 passed / 0 failed / 0 skipped、Errors 0，
  含原 exact tokenizer 命令，旧缺包阻塞已解除。后文旧“仅类型/缺包/usage未发布”不再代表现状。
- 新生产入口测试 `tests/context_compiler_owner.test.ts` 安装真实 L01/L02 和按正式名 inject 的消费插件；
  使用真实配置服务、受控 HTTP/SSE、文件图片与原 OCR 对冲，验证 payload、caller、错误、日志、socket 关闭与探针释放。
  L03 实际消费接线由 WP-001/L03 完成。
- 定向验证 `20261105141742-feeeaa`：2 files / 32 passed / 0 failed / 0 skipped、Errors 0、exit 0，
  新增 owner 18 条 + 既有 raw 14 条。首轮 `20261105140648-d08611` 为 11 passed / 1 failed、exit 1：
  新 OCR 错误期望误用了 StatusCode Display；按 Rust single_shot_stream.rs:267 的 u16 状态与
  exam_engine.rs:187 包装改成完整精确错误断言，未改生产错误语义或既有测试断言。

### 当前状态与下一步（2026-11-04 新会话）

- 已发布候选：配置/profile/failover、供应商适配器、单次及统一model-2流、OCR候选准备/对冲、RAG翻译/题目解析、消息构建、owner hooks、MCP和Anki路由。F4流过滤/SSE/Window target已接。R1已签L02-01（含异步Model2与OCR共享Codex准备），不再按旧快照返工。
- 剩余：03 raw usage与08完整L16消费组合尚未闭合；L03 context compiler所需精确raw-MM取消入口和dedicated文件OCR高层组合仍为自有工作。TESTMAP函数级pending与SPEC清单继续逐项处理，不能用现有unified/singleShot猜替这两个策略。
- 真实跨lane阻塞：F3 budget严格serde/精度与usage公共入口；F4 base64/EncryptedData公共decoder；F7 root tiktoken依赖未安装、图片编码依赖审批及D5证据/原生OCR。F7 resizeTriangleJpeg符号已合main，F1 Window target已解除，不再列为缺符号。
- 复核边界：R1 8782f77ae/786d4cbc2已签01，03转换与08路由提供已验；02依赖/完整token精度、03落库、04budget、05serde、06剩余日志、07接线及08完整消费仍开放。translation高危保存委托与中央caller也未闭合。
- 下一步顺序：先处理main-red依赖协调与复核反馈、完成本轮translation owner调用点；再做L03要求的raw-MM/dedicated-OCR高层组合及已解阻端口消费；之后继续v2排雷清单。已签收专项不重复跑。

### 接管批次（2026-11-04 夜，provider 发布）

- 批 1+2（af5867ec2，lane-gate 通过，基线 main 879e0a56b）：`llmRawPrompt@1`（callModel2RawPrompt/Opts、
  callRawPromptWithConfigIdAndImages(+Cancellable)，真实 L01 适配器 + 共享 prepare/Codex + failover + RAW_PROMPT 审计 +
  F3 用量端口）、`llmQuestionAuthoring@1`（runQuestionJson 走 llmStreaming.singleShotCompletion + buildDebugPersistConfig）；
  call_llm_for_boundary 改走 callModel2RawPrompt，删除私有 completion.ts。
- 批 3+4+6：`llmOcrPages@1`（callOcrPageWithFallback / testOcrWithEngine / callOcrFreeTextWithFallback /
  callDedicatedOcrFreeTextWithFallback）、`llmFileOcr@1`（CommandError 包装）；translation 注册 `ocr_extract_text`
  （F4 decodeBase64Standard 已公开；F3 fileManagerPaths 缺失时按 Rust 规则用活动数据目录）。

### 统一流交接 L03 / C1（2026-11-04 11:18Z）

- 已提供 `ctx.llmModel2Streaming.callUnifiedModel2Stream(input)` 与 `callUnifiedModel2StreamWithConfig(config, retries, input)`；参数/输出类型均在 `api.ts`。输入对应 Rust `tool_loop.rs:1364–1374`，`taskContext: 'chat_v2'` 时 usage 由 L03 记录，L02 通过 `onUsage` 保留原 API 载荷（含测量为 0 的 cache 字段）。
- 调用前在 `ctx.llmStreamEvents.registerStreamHooks(input.streamEvent, owner)` 登记原 L03 adapter，调用后沿用 `unregisterStreamHooksIfOwner`；生产流使用同一 registry，不在内部抢占 hook owner。
- 真实 HTTP 证据：`tests/unified_stream.test.ts` 覆盖真实配置存取/模型选择/override、无窗口完整流、工具调用 + usage + complete 顺序、取消关闭 socket 与 replacement owner、不完整 EOF 报错、适配后 DeepSeek 请求在审计开关前后结构相同及落盘。`codex_streaming_integration.test.ts` 安装真实 L01+L02 并消费统一入口。
- 检查：`20261104111422-436815` typecheck exit 0；`20261104111422-04343e` 82 files / 869 tests passed，exit 0，无 Errors；两插件 importable exit 0。TESTMAP 更新为 llm 666 ported/1 pending，translation 40 ported/2 pending。这些是本分支候选证据，尚不代表 main 消费完成。
- 真实阻塞仍为 F3 用量记录（公开最小 `Model2UsageRecorder` 端口；非 chat_v2 与开启 cache debug 的路径缺提供者时明确失败），F7 OCR 编码与 F4 base64。F1 Window target 与 F4 SSE 已在主线解除，旧阻塞描述由本节取代。
- 新合入 R1 §6 已确认 Anki 路由提供/实际 L16 候选消费，后续只需集成组合证据，不再重复实现路由。下一步为 OCR async Codex 预验证、raw 非Codex预取、剩余 Codex桥公开路径测试和 SPEC 清单。

### 后续小单元

- OCR async Codex 预验证与 raw/essay/RAG 非Codex预取已完成候选接线，检查点 `87607ecdc` / `cfbfd8256`；真实 Codex OCR prepare/run 与原流/连接/raw组合测试通过。Electron SQLite 9 tests passed / exit 0（`20261104111739-0d1f8c`）。
- X7-TOKEN-01 三个正式 finding（HANGUL-A/B/COMPAT）已修范围与 f32 累计；新增25个静态源码向量，与 input_guard、统一流和MCP生产接线共47 tests passed / exit 0（`20261104113105-d8e2bc`）。属于静态证据，等待 X7/R1 复核，不标 C 级。

C1后续回执：X7独立作业131237-6d2fa8已按原输入/预期复验HANGUL-A/B/COMPAT三项3/3一致，指定静态源码+TS生产向量闭环；不扩张为C级或全部token精度签收，不重复修复/单跑这三项。

### 当前检查与剩余（准备 standard-v2 §5 自检）

- 统一流交付 `ccd8c907f`；X7 finding交付 `5f0539fdd`（实现检查点`4b3563b8e`）；后续共享HTTP/翻译反馈修复见translation/LANE.md。
- 最新全量两目录 `20261104115934-4efe36`：83 files / 904 passed，exit0，无Errors；类型检查 `20261104115934-cb2200` exit0；Electron SQLite `20261104111739-0d1f8c`：9 passed，exit0。
- ledger计算（`20261104113319-d1e779`，只读执行原计算、附lane摘要）：本lane26命令，25 A=96.2%，B=0%；唯一非A命令ocr_extract_text（F7/F4依赖）。R1-TR-07登记后TESTMAP现为llm666/1、translation39/3，共705 ported/4 pending；不能以全量测试绿灯替代未完成项。
- strict全仓仍4个VFS违规（create.ts:41、folders.ts:22、resources.ts:126、update.ts:33），本lane无违规；wiring分别666/39 ported，未从index接入0。独立复核仍未签收，未宣告整lane完成。
- 其他自有续作保持开放：SPEC逐分支/日志清单、配置serde错误精度、RAG完整请求/usage组合；相关外部边界与未验收事实详见BLOCKERS。下一轮先收复验反馈与主线新提供面，再做这些剩余项。

## v2 排雷清单

### C2 固定编号映射（冻结报告 0119143715c0bab2d8f698b7c1d58651358e85be）

本节只映射C1 13:00消息的固定编号到下面已登记条目；旧文件短名ID保留为别名，不再新编、不另建整改队列。源码候选基线仍为2ee9a9cbe；本轮恢复基线c6f4233a2已对main44b66353c通过五项lane-gate。owner裁定按037376b1e / X6-OWN-C2-20261104；以下PR/AP/LP仍是人工线索，原testIds见冻结报告/原消息。

| 固定ID | 对应既有finding / 旧条目 | 当前处理 |
|---|---|---|
| X6-UD-0027、X6-UD-0028 | L02-04，index:226/243预算解析 | 旧断言已移除；F3 serde/精度父项仍开放 |
| X6-UD-0029 | L02-05/06，config_profiles:47 | 本轮已补hidden Vec<string>、Rust trim、解析warn，DB读取失败保持静默；生产命令6测试通过（20261104131336-90686e，exit0）；父项诊断精度仍开放 |
| X6-UD-0030 | L02-05，config_store:111 | 新核验：F4 isEncryptedFormat已调用严格parseEncryptedData，不能声称完全无校验；但第二次裸JSON断言未归一serde数组形式。F4已有parseEncryptedData实现未公开，需公开返回EncryptedData/null供L02消费，避免复制密码载荷decoder |
| X6-UD-0031 | L02-01，config_store:132 | 已改为共享活跃Codex状态，不重复修复 |
| X6-UD-0032 | L02-05，config_store:162 | legacy ApiConfig[] bootstrap仍待字段解码 |
| X6-UD-0033 | L02-05，config_store:787 | 2ecc0a476已去断言并保已有decoder；五项自检通过 |
| X6-UD-0034、X6-UD-0035 | X6-UD-llm-question_parsing_service-44/-59 | 同原增量JSON值边界待核 |
| X6-UD-0036 | L02-03，rag_service:48 | 响应JSON值边界/usage原队列 |
| X6-UD-0037、X6-UD-0038 | X6-UD-llm-single_shot_stream-311/-700 | 同原JSON值边界待核 |
| X6-UD-0039 | X6-UD-llm-tool_calls-81 | 同原工具参数JSON边界待核 |

PR逐符号映射（对应下方既有生产路径证据，不据粗关联整文件降A）：

- X6-PR-0017=checkRequestInputBudget、0018=chatMessagesRequireMultimodal、0019=deepseekV41ImageTokens、0020=effectiveRequestInputLimit、0021=estimateRequestInputTokens、0022=inlineImageTokenBudget：并入L02-07/X5，统一流候选已接。
- X6-PR-0023=awaitVisualObservationOrCancel：并入原visual子项，真实生产接线pending。
- X6-PR-0024=redactSkillInstructionBlocksInText、0025=redactUserProfileBlocksInText、0026=sanitizeRequestBodyForAudit、0027=sanitizeUrlForLog：并入L02-07/X5审计子项，候选已接。
- X6-PR-0028=applyRuntimeReasoningOverrides、0029=extractUsageTokens：并入L02-07/X5，候选已接；F3落库父项独立。
- X6-PR-0030=buildToolsWithMcp、0034=logAndEmitLlmRequest：已接MCP/统一流；0031=bridgeCodexNonstreamResponse、0032=normalizeCodexErrorResponse、0033=readCodexResponseBodyLimited：L02-01/07旧副本测试待切L01公共面；0035=NoopStreamSink、0036=flushPendingDebugLogWrites：保持原测试工具/日志生命周期待核。
- X6-PR-0037=ASSIGNMENT_SLOTS、0038=MAX_MODEL_CONFIG_ID_CHARS、0039=MAX_TOOL_STRING_CHARS、0040=MAX_USIZE、0041=MODEL_ASSIGNMENTS_SET_FIELDS、0042=MODEL_PROFILE_ADD_FIELDS、0043=SETTINGS_GET_FIELDS、0044=SettingsModelsToolExecutor、0045=argumentsObject、0046=argumentsObjectAllowingCredentials、0047=boundJsonStrings、0048=boundedString、0049=containsSensitiveIdentifier、0050=isSafeSettingKey、0051=optionalPositiveInteger、0052=parseAssignmentSlot、0053=profileCapabilityFlags、0054=redactCredentialArguments、0055=requiredNullableString、0056=safeModelJson、0057=updateModelAssignmentAtomic、0058=urlsSameOrigin、0059=validateBaseUrl、0060=validateModelForSlot、0061=validateProviderType、0062=validateSettingValue：全部映射原X6-PR-llm-settings_models_executor-1自有接线/OCC单元，不是26套整改。

AP映射：X6-AP-0254→anthropic-12；0255→anthropic-22；0256→ernie-90；0257→moonshot-51；0258→zhipu-47；0259→zhipu-67；0260→exam_engine-89；0261→config_store-433；0262→llm_manager_reasoning-298；0263→model2_pipeline_input_guard-202；0264→model2_pipeline_generation-19；0265→routing-40；0266→routing-80；0267→routing-71；0268→routing-118；0269→reasoning_policy-61；0270→reasoning_policy-209；0271→reasoning_policy-213。0254/0255/0264已逐输入/字段确认计数误报；其余维持原待核，不机械补expect。

LP映射：X6-LP-0146→anthropic-1；0147→generic_openai-1；0148→exam_engine-1；0149/0150→base-1 warn/error；0151/0152→anki_routing_service-1 model2 warn/error；0153→deepseek_ocr_parser-1；0154/0155→embedding_defaults-1 warn/error；0156→anki_model_routing-1；0157→ocr_circuit_breaker-1；0158→anki_routing_service-1 essay warn；0159→settings_models_arguments-1；0160/0161→connection_test-1 warn/error；0162/0163→LANE-1 plugin warn/error。沿原分支索引审读，不按宏数量闭合。

### 核验锚点与规则

- C1 本次候选基线：`2ee9a9cbe`；当前核验 SHA：`29f0fb473`（包含已自检通过的 `053498e16`）。原 JSON 按 `git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json` 读取，读取时 X6 tip=`f5822bce6`。报告分支会继续更新，以下保留 C1 给定的旧行号/符号索引，不把它当当前行号。
- 简称：UD=unchecked-decode，PR=prod-reachable，AP=assert-parity，LP=log-parity。已有 R1/L02 finding 优先复用；无既有 ID 的行采用 `X6-<简称>-llm-<文件短名>-<基线行>`。同一文件同一基线行的多个符号/日志种类列在一个条目下，逐子项处理。
- 状态“候选待逐断言/日志核对”仅是人工线索，不等于测试或业务失败；不按数量补 expect/log，不批量重标 TESTMAP，不重开 obsolete/query_rewriter。仅使用原 Rust 行为证明修复。D1 所有者缺口先要求带原连接的业务 API，禁止改 SQL 拼写/挪文件规避门禁。
- 当前优先顺序：承接 L02-05 配置解码（先处理已有严格 decoder 后多余断言这一最小单元）；后续处理实际未接入的 settings-models/visual observation；AP/LP 按下表原位置审读。跨 owner 翻译写入归同 lane 的 `../translation/LANE.md`，不另造第二个修复。

### UD：18 个 llm 候选（另 1 个在 translation）

路径相对本插件；R=`src-tauri/crates/dstu-llm/src/llm_manager/`，C=`src-tauri/src/commands.rs`。

| finding / 旧索引 | 当前 SHA 核验结果、Rust 依据 | 状态 / owner 请求 |
|---|---|---|
| L02-04 · index.ts:226,243 | 当前入口227–229委托budget_commands；JSON先入unknown，再校验6字段、枚举/Map；C:6913–6995、dstu-storage/injection_budget.rs:436–448 | 旧裸断言已消除；完整usize/serde诊断/日志仍待F3 `injectionBudget.fromDatabaseConfig`，不关闭父项 |
| X6-UD-llm-capabilities-39 | 双断言仍在；输入是src/data/model_capability_registry.ts静态常量，不是持久化JSON；R/mod.rs能力注册表逻辑 | info；类型形状审读待办，未发现入站decoder缺失证据 |
| X6-UD-llm-config_builtins-72 | 双断言仍在；src/data/gemini_model_registry.ts静态常量；R/builtin_vendors.rs Gemini目录 | info；同上，不据此新增运行时校验 |
| L02-05/06 · config_profiles.ts:47 | 核验基线缺显式解码/原warn；本轮按R/mod.rs:4666–4684改为unknown→Vec<string>，保整体失败回空、Rust trim和原warn | 合并至固定X6-UD-0029，生产命令回归6/6通过；数据库读取失败仍静默回空，语法错误详细Display仍属父finding待办 |
| X6-UD-llm-config_resolution-106 | mergeBuiltinProfileUserAware仍有双断言，操作已解码profile的字段赋值；R/mod.rs:6220–6403 | info；内部赋值，不是假报入站解析 |
| L02-05 · config_store.ts:111 | 当前112仍将加密payload断言为结构，后交F4 crypto；R/mod.rs decrypt_api_key_if_needed与EncryptedData | 待字段解码；调用F4解密，不复制密码算法 |
| L02-01 · config_store.ts:132 | 原hasUsableCodexSession读凭据JSON已移除；当前调用注入的活跃llmCodexAuth.status；R/mod.rs:6417–6428 | 已修候选65c796fab，后续053498e16自检通过；不重做存储副本 |
| L02-05 · config_store.ts:162 | 当前145的legacyRaw仍断言ApiConfig[]，bootstrap迁移需真实ApiConfig serde解码；R/mod.rs:5650–5721配置bootstrap/flatten | 自有待修，保先迁移/再保存与错误顺序 |
| L02-05 · config_store.ts:787 | 核验时770在JSON断言后立即调用modelAssignmentsFromDe；其serdeRecord/optionalString已验证已知字段；R/mod.rs:7881–7887 | 本单元已去多余断言，decoder改接unknown；既有生产命令测试3/3通过（20261104123422-0760cb，exit0）。不宣称缺少模型分配校验算法；父finding其他项仍开放 |
| X6-UD-llm-mod_compat-290 | 静态MODEL_CAPABILITY_REGISTRY_DOCUMENT→RegistryDocument双断言仍在；R/mod.rs能力推断 | info，内部静态注册表审读待办 |
| X6-UD-llm-protocol-27 | 静态PROVIDER_PROTOCOL_REGISTRY_DOCUMENT→Document仍在；R/mod.rs协议解析 | info，内部静态注册表审读待办 |
| X6-UD-llm-question_parsing_service-44 / -59 | feed/finalize仍JSON.parse as JsonValue；R/mod.rs IncrementalJsonArrayParser | 自有待核：Rust接收任意serde_json::Value，不得擅加题目struct限制；需要unknown→JSON值边界 |
| L02-03 · rag_service.ts:48 | 当前50仍响应JSON断言；后经协议归一读取content；R/rag_extension.rs:896–1004 | 请求已接真实adapter；响应JSON值边界待修，用量等待F3公开collector |
| X6-UD-llm-single_shot_stream-311 / -700 | 当前277/666仍JSON值断言；R/single_shot_stream.rs finish_reason_from_block/非流响应解析 | 自有待核：字段按原Option链读取，不能因缺字段新增错误；未知JSON值验证与精确数值需区分 |
| X6-UD-llm-tool_calls-81 | parseJson仍JSON.parse as JsonValue；R/model2_pipeline.rs convert_openai_tool_call | 自有待核；保任意参数JSON、空串空白→{}及原修复路径 |

### PR：46 个 llm 候选（另 1 个在 translation）

| finding / 旧测试索引（均:1） | 子项索引与当前核验 | Rust 证据 / 状态 / 接口请求 |
|---|---|---|
| L02-07 / X5 · model2_pipeline_input_guard | checkRequestInputBudget、effectiveRequestInputLimit、estimateRequestInputTokens、inlineImageTokenBudget、deepseekV41ImageTokens、chatMessagesRequireMultimodal现经index→llmModel2Streaming→model2_request/input_guard可达 | R/model2_pipeline.rs:5238–5240,5329–5331,6137–6143；ccd8c907f组合接线与生产HTTP测试已交，不因旧报告重做 |
| X6-PR-llm-model2_pipeline_input_guard-1（visual子项） | awaitVisualObservationOrCancel仍只有定义/测试，统一流接入未调用此函数 | 原测试visual_observation_cancellation_drops_the_provider_future及对应非流视觉观察入口；自有未接线，pending核对，不冒充F7阻塞 |
| L02-07 / X5 · model2_pipeline_audit | redactSkillInstructionBlocksInText、redactUserProfileBlocksInText→sanitizeRequestBodyForAudit；sanitizeUrlForLog现经统一流审计可达 | R/model2_pipeline.rs:3957–4004；ccd8c907f/053498e16及unified_stream审计开关/落盘向量；候选已接 |
| L02-07 / X5 · model2_pipeline_generation | applyRuntimeReasoningOverrides、extractUsageTokens现由model2_streaming_service调用 | R/model2_pipeline.rs:5261–5266,7467–7478；已接，F3写入缺口独立保留 |
| L02-07 / X5 · model2_pipeline_completion（工具/审计子项） | buildToolsWithMcp经llmMcpTools；logAndEmitLlmRequest经统一流；NoopStreamSink、flushPendingDebugLogWrites仍仅测试直接调用 | R/mod.rs:137,7989–8285、R/model2_pipeline.rs:6269–6281；前两项已接；后两项需区分测试工具与F4日志生命周期，不按同文件整体闭合 |
| L02-01/07 · model2_pipeline_completion（Codex子项） | 本地bridgeCodexNonstreamResponse、normalizeCodexErrorResponse、readCodexResponseBodyLimited仍是旧测试副本；生产已走L01 auth sender | R/model2_pipeline.rs:2525–2605,5037–5051；该TESTMAP行仍pending。向L01请求公开bounded-reader(response,limit,context)以保留原8字节上限断言，不能用固定256KiB上限替换 |
| X6-PR-llm-settings_models_executor-1 | SettingsModelsToolExecutor当前仍无index提供/中央调用；下列26符号均归此真实接线单元（不是26次独立改造）：ASSIGNMENT_SLOTS、MAX_MODEL_CONFIG_ID_CHARS、MAX_TOOL_STRING_CHARS、MAX_USIZE、MODEL_ASSIGNMENTS_SET_FIELDS、MODEL_PROFILE_ADD_FIELDS、SETTINGS_GET_FIELDS、SettingsModelsToolExecutor、argumentsObject、argumentsObjectAllowingCredentials、boundJsonStrings、boundedString、containsSensitiveIdentifier、isSafeSettingKey、optionalPositiveInteger、parseAssignmentSlot、profileCapabilityFlags、redactCredentialArguments、requiredNullableString、safeModelJson、updateModelAssignmentAtomic、urlsSameOrigin、validateBaseUrl、validateModelForSlot、validateProviderType、validateSettingValue | src-tauri/src/chat_v2/tools/settings_models_executor.rs:118,1503–1588,1623–2018；自有provider接线待做。F4当前已发布getWithConn(conn,key)→string/null、saveWithConn(conn,key,value)→void，不能继续说缺API：L02需在F3 immediate事务中传同连接实现原OCC，并保锁/起事务/读取/解析/写入/提交错误顺序。中央分发请求L04/L03的fromVec(executors)/getExecutor(name)→executor/None，L07仅roster不能替代 |

### AP：18 个计数候选，全部只作人工线索

ID前缀统一 `X6-AP-llm-`；原测试原文以右列为索引。当前SHA文件/测试均存在；未逐子断言审完者维持“待核”，不为补计数而添无意义expect，不修改TESTMAP。

| ID尾部 / 旧测试位置 | Rust索引（src-tauri/crates/dstu-llm/src/） | 当前处理 |
|---|---|---|
| anthropic-12 / anthropic.test.ts:12 | llm_manager/adapters/anthropic.rs:490–525 test_claude_generation_new_models_are_adaptive | 已逐项确认：Rust8个模型与TS循环8个相同输入/Adaptive断言一致；8/1是循环计数误报，不改测试 |
| anthropic-22 | 同文件:529–572 test_claude_generation_legacy_models_are_manual | 已逐项确认：8个Manual输入在循环，4.6的2个Adaptive单列；10/3是循环计数误报，不改测试 |
| ernie-90 | llm_manager/adapters/ernie.rs:439 test_is_thinking_model | 待核6个输入与循环 |
| moonshot-51 | llm_manager/adapters/moonshot.rs:706 test_k25_model_detection | 待核15个输入 |
| zhipu-47 / zhipu-67 | llm_manager/adapters/zhipu.rs:332 test_supports_thinking；:381 test_supports_reasoning_effort | 待核15/7个输入 |
| exam_engine-89 | llm_manager/exam_engine.rs:1545 cancelled_hedge_engine_drops_its_stream | 待核取消、连接关闭、请求计数四项，不仅数expect |
| config_store-433（关联L02-05） | llm_manager/mod.rs:1293 auth_mode_defaults_for_legacy_serialized_configs | 待核vendor/API两结构缺省断言 |
| llm_manager_reasoning-298 | llm_manager/mod.rs:2582 non_reasoning_fields_stay_byte_identical_across_matrix | 待核矩阵及字段集合，不用序列化HashMap比较替代 |
| model2_pipeline_input_guard-202 | llm_manager/model2_pipeline.rs:1467 deepseek_v41_image_budget_is_scoped_to_official_vision_models | 待核官方与非官方输入两个方向 |
| model2_pipeline_generation-19 | llm_manager/model2_pipeline.rs:2746–2762 numbered_web_search_sources_aligns_with_retrieval_block_schema | 已逐字段确认：TS两个toMatchObject覆盖Rust全部7个字段断言并另验snippet；7/2为对象匹配计数误报，不增expect |
| routing-40 / routing-80 / routing-71 / routing-118 | llm_manager/routing.rs:908 provider_body_context_window_detection；:1080 text_requests_allow_multimodal_fallbacks_but_images_require_them；:1143 purpose_model_resolution；:1324 auth_failed_only_rotates_keys_within_same_model | 四项分别待核消息样例、模态组合、purpose回退、key/model切换限制；不按5/2、6/3等静态数判失败 |
| reasoning_policy-61 / -209 / -213 | reasoning_policy.rs:345 test_deepseek_v3；:693 test_openrouter_gpt5 | 待核测试名包含关系导致的归并（v3_no_reasoning、gpt5_pro、gpt5_instant）；不把前缀匹配误算为断言缺失 |

### LP：18 个 llm 计数候选（translation另3项）

所有条目均为info；ID前缀 `X6-LP-llm-`。来源是报告按注释归集的文件级计数，不是逐日志证明；当前已读真实日志出口，以下保留待逐Rust位置核对的索引。

| ID尾部 / 旧路径:1 | Rust来源 | 当前核验 / 合并任务 |
|---|---|---|
| anthropic-1 · adapters/anthropic.ts | R/adapters/anthropic.rs（4 warn） | warn位置逐条待核；自有 |
| generic_openai-1 · adapters/generic_openai.ts | R/adapters/generic_openai.rs（2 warn） | 同上 |
| exam_engine-1 | R/exam_engine.rs（8 warn） | 当前日志分布在ocr_hedge_service/ocr_regions_service，候选文件不代表独占；OCR接线单元内逐项核 |
| base-1（warn/error） · adapters/base.ts | R/mod.rs（33 warn/7 error） | 文件级映射过宽；L02-06已修配置保存/缺vendor/failover日志，剩余在对应函数核，不向base空添日志 |
| anki_routing_service-1（model2 warn/error、essay warn三子项） | R/model2_pipeline.rs（44/20）；dstu-tutor/essay_grading/pipeline.rs（14 warn） | 模块名pipeline歧义；统一流已有model2_transport日志，Anki路由本身按mod.rs:7734–7749。分别并入X5/L02-06和essay原分支，待核其余 |
| deepseek_ocr_parser-1 | R/parser.rs（1 warn，报告映射） | TS实际移植deepseek_ocr_parser.rs；须核实引用映射，不能把通用JSON清洗warn加到OCR grounding |
| embedding_defaults-1（warn/error） | R/rag_extension.rs（10/7） | 当前翻译日志在rag_service，完整embedding请求/usage仍开放；并入L02-03/F3 collector请求 |
| anki_model_routing-1 | R/routing.rs（5 warn，报告映射） | 实际纯Anki路由与failover routing应分开核；L02-06已有control.warn，不凭数量关闭其他分支 |
| ocr_circuit_breaker-1 | dstu-llm/src/ocr_circuit_breaker.rs（4 warn） | 同文件仍3处logWarn；需逐状态转换/日志文本核，暂未判哪个分支缺失 |
| settings_models_arguments-1 | src/chat_v2/tools/settings_models_executor.rs（1 warn） | 当前warn在settings_models_executor.ts:96，原持久化工具block失败分支；算法文件无warn不是证据，PR接线仍pending |
| connection_test-1（warn/error） | C（18/26） | C是多lane共享文件；当前connection_test和index已有日志。只核LANE拥有的20命令，不补其他命令日志 |
| LANE-1（plugin warn/error） | 跨文件总计154/67 | 人工汇总线索，无独立失败判据；以上分支审读后再汇总 |

修复状态更新与自检 hash 追加在本节，不改变生成块；当前既有候选交付 `ccd8c907f` / `5f0539fdd` / `053498e16`，最后一项在main基线`d84e29565`上lane-gate五项通过。

LP原日志位置索引（只定位，未全部审完）：anthropic warn213/224/234/338；generic_openai warn235/365；exam_engine warn750/779/832/835/935/965/1034/1150/1197、error459；parser warn501；rag_extension warn192/240/355/477/483/676/876/1125/1232/1692、error654/814/972/1211/1393/1510/1647；routing warn559/635/641/648/704；ocr_circuit_breaker warn85/121/159/168；settings_models_executor warn742。宏计数与注释/分散实现可能不同，仍以具体分支和日志语义决定修复。

当前只读跨host调用核验：SettingsModelsToolExecutor/createSettingsModelsToolExecutor除本模块与测试外，只在kernel/agent-roster.ts出现名称字符串（非实例）；awaitVisualObservationOrCancel也仅定义/测试。因此这两项的真实生产接线仍pending，不能用旧wiring文件级0未接入结论关闭。其余AP/LP未决只是待核线索，不据报告批量修改TESTMAP。

本轮X6-UD-0029新增公开命令向量：NEL裁剪/BOM保留、有效列表只读不归一化写回、任一坏元素整组回空并warn、语法错误warn、缺失/DB失败无warn。首轮测试夹具误用profile.isBuiltin选择目录项（目录原始profile为false，builtin_vendors.rs:1185；isBuiltin不是该列表的身份判据），修为原隐藏profile测试使用的稳定id后6/6通过；未修改既有Rust断言或内置字段行为。解码器与错误日志的修复仍等独立复验，不宣告L02-05整体完成。

### 本轮提交与集成阻塞

修复提交 `2c23a5f90`（实现/测试检查点b4d042a02、9350618b1、788b22aa2）。提交→合并main得`f59e27b31`→lane-gate：4/5通过，tests exit1，唯一摘要失败为桌面精确token命令缺 `tiktoken` 模块（F7新main实现；根包仅js-tiktoken）。该失败不能靠修改本lane断言/改启发式绕过，已通知C1/F7需求；本分支本轮不声明自检通过。F7同时合入了resizeTriangleJpeg公共面，旧“只有dimensions/decodeRgba”阻塞已订正；其未批准编码依赖与D5像素证据仍待F7，详见BLOCKERS。

R1后续签收8782f77ae/786d4cbc2：L02-01所列共享认证/主要发送/异步Model2与OCR候选阻断已闭环；03请求转换、08提供方已验；raw usage、L16未main组合和02正式tokenizer缺包仍开放。原独立整作业131022为exit1/2273pass/1fail/3skip，保留边界，不重跑已通过专项。

L03 13:53请求的两个context compiler高层出口已由 WP-002 正式组合为 llmContextCompiler@1，精确用法见本文件 WP-002 节；旧仅类型状态已解除。

main-red 16a254adf反馈已按要求通过coord.mjs escalate上报架构师，回执`2026-11-04T141043082Z-L02-llm-manager.md`。确因为F7新require('tiktoken')与root仅js-tiktoken不匹配，需要C1/F7补正式依赖；不改精确token断言。13:59反馈中的两个hidden-list失败是旧isBuiltin夹具快照，当前已按稳定ID修复并在90686e的6个生产命令测试通过，未重跑。14:04 gate-excerpt工具错误按架构师指令忽略，不改业务代码规避。

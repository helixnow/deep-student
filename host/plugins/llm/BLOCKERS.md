# L02 remaining migration ledger

## WP-209 config-id raw prompt supplier

无会话出口已增补至 `api.ts::LlmRawPrompt.callWithConfigIdRawPrompt(configId:string,prompt:string,signal?:AbortSignal):Promise<StandardModel2Output>`，
经 `index.ts:121–126` 原provide可达，复用agent compaction同一scoped实现，agentSessionId=null。
L02侧不再缺该供方；L17/WP-211在本包合main后消费，保留synthesis.rs:73–104的90秒timeout/drop/fallback。
错误原样传播，取消实际HTTP/重试并抛signal.reason；不会将失败转成功。
源码`:4883–4894`允许用户手动配置非Agent Go，原任务身份保留，不伪造Agent授权。
其共享prepare分支现TS缺原非Agent INFO日志（prepared_request.ts:98–102），仍属既有日志对齐待办，
本包不扩签Go全链。其他历史未闭项保持原归属，TESTMAP无资格变化。

## WP-213 policy_precision 组合期望纠正

WP-212 的锁源归因已获 C2 新复验支持：`/tmp/opencode/c2-l02-policy-2203-evidence/`
保存 input.json/job.json/job.log/vitest.json，base=`b17264b88b951bd611fc7e9100d7b2d6697ac026`、
tip=`9ebd8fe2963d1be88cfabbb5717459bcbdf4a5cd`、combo=`7d94b9b14e04dbdbef936831d51eda6638811114`；
job `20261105220600-c8a051` raw1、4/1/0、Errors0，原106:29首向量只差正指数加号（124ms）。
本包按锁定 serde_json/zmij 修正两处旧 expected；main 的 F4 formatter 已符合该 Rust 来源。
历史 auto 完整失败栈/code 未保存的缺口仍保留；上述是新复验，不替代原 auto 原件，旧绿也不代表新组合通过。
WP-213已由merge `53039e2f63294785d6f04bf109b2a3966759d484` 进入main；WP-209起点
`df2cd30a1`已含该依赖，旧等待131/213main条件解除。WP-209供方的新证据以本包报告为准。

## WP-131 persisted policy cooldown

WP-022 报告第43行的 policy 子项已有候选修复：`policy.ts` 经 F4 JsonReader 精确读取
keyCooldownSecs/rateLimitBackoffMs；真实 embedding 冷却消费在原 clamp(1,3600) 前不投影 Number。
原红 `20261105191119-82872c` 明确 MAX→60，修后 `20261105191724-0cd87d` 71/0/0、raw0。
范围是持久化策略解码和文本 embedding 冷却；既有公开 number DTO、通用 routing 的超长 timer
运行时等价性不据此签收。WP-132 HTTP诊断、EncryptedData、rerank/多模态仍分别跟踪。

## WP-088 memory_decision raw prompt (D36)

本分支供方已实现 `LlmRawPrompt.callMemoryDecisionRawPrompt(prompt:string, signal?:AbortSignal):Promise<StandardModel2Output>`，
经 index.ts 原 `llmRawPrompt` provide 发布；精确语义与消费边界见 LANE。L02 侧不再缺 memory_decision 角色出口。
L17 `host/plugins/memory/src/service.ts:853` 仍从 `ctx.llm` 探测并期待 `{ assistantMessage }`，
需改为 inject `llmRawPrompt` 并读取 `assistant_message`；本包未修改该域，消费等供方合 main 后另派。

## WP-108 text model2 cancellation

本分支供方已实现 `LlmRawPrompt.callModel2RawPromptOpts(prompt,forceJson,callerType,task,cancellation?:AbortSignal)`，
通过 index.ts 原 `llmRawPrompt` provide 直接发布。复用main已存在的 llmHttp AbortSignal与L01 Codex发送；
不再缺文本HTTP取消供方，精确调用与错误形状见LANE。Node真实HTTP10条回归通过（job20261105174045-bdb2f4）。
L18 `src/handout-llm.ts` 仍需将run token对应signal传入第五参并自行清理registry/监听；本包未修改该域。
供方拥有的signal/退避监听测试覆盖重复成功/业务错误与在途取消；不以此关闭L18监听泄漏finding。
其余WP-023及旧精度/配置问题不属于本包（WP-088见上节）。

## WP-022 text embedding (2026-11-06)

正式文本供方已可用：`embedding@1` / `TextEmbeddingService`（api.ts）提供
`callEmbeddingApi(texts:string[],modelConfigId:string):Promise<number[][]>` 与
`generateEmbedding(text:string):Promise<number[]>`。index.ts真实provide，L12已用同名动态消费口；
F3用量按调用获取，缺失时发送前明确失败。请求、分块/聚合、响应顺序、f32、HTTP分类、
Retry-After与冷却和usage均已接生产路径；旧“只有模型选择，没有文本传输”被本节取代。

严格逐字节诊断仍有未闭合项（不把源码审读或TS绿灯计作Rust差分）：

- `rag_extension.rs:1196` 的 reqwest 0.11.27 `Display` 含hyper/rustls/OS错误链。
  当前保Network类型、establish/network标签与发送上下文，并透传Node底层cause；
  **底层cause文案不是Rust逐字一致**，URL builder错误也尚未按reqwest Builder/Request细分。
  这是L02共享HTTP错误映射的自有后续，不冒称缺外部transport；分类/重试决策已可消费。
- `rag_extension.rs:1245` 的 `.json()` 使用serde_json::from_slice；F4现公开
  `parseJsonDocument(text)` + `decodeUtf8Strict(bytes)`，正常JSON语法错误已经保reqwest Decode前缀及serde位置。
  非法UTF8已严格拒绝，但文案是Utf8Error，尚非serde的`invalid unicode code point`及原位置；
  body中断保原Body错误层级，但底层来源仍是Node诊断。F4需要提供同源字节JSON公共入口
  `parseJsonDocumentBytes(bytes:Uint8Array):JsonNode`（含serde读取顺序/位置），L02需接入并对齐底层错误链。
  不在本lane复制JSON扫描器来掩盖该缺口。
- 既有配置层EncryptedData数组式serde归一（L02-05）仍依赖F4公开`parseEncryptedData`；
  普通对象加密key已通过真实F4保存→读取→发送测试覆盖，不据此签收全配置decoder。
- WP-023/024多模态embedding、rerank仍未提供；L19完整检索与L12多模态调用不得据本包关闭。

TESTMAP：llm pending 1→1，translation pending 2→2，整lane pending 3→3；
仅四条默认模型测试从旧纯helper用例转指正式Host入口（见TESTMAP逐断言说明）。

## Confirmed external dependencies

- **Resolved: F7 tokenizer dependency** (WP-002, main `967f43c75`). D11 approves and
  package.json declares `tiktoken@1.0.22`; queued baseline job `20261105140114-097901`
  passes the original exact-token command test (26/26 related tests, exit 0, no Errors).
  The historical `f59e27b31` / `16a254adf` missing-package failure no longer blocks L02.

- F1 target correction is now merged: `host/kernel/events.ts:80–89` subscribes by Window target,
  not source. Existing L02 MCP integration tests pass with the corrected Host.

- **F3 injection budget serde/logging/precision**: L02 now calls public `injectionBudget`
  rather than owning a second allocator. The service needs `fromDatabaseConfig`/strict BudgetConfig
  decoding (Rust injection_budget.rs:436–448), precise usize arithmetic, f32 summary percentages
  and original add/allocate debug/info logs (:193,212,240,293,310). Current F3 API only exposes
  defaultConfig/createManager/newItem and number-based Maps. L02 maps enums/Maps/timestamp wire
  shapes and rejects malformed stored structures, but full serde parse diagnostics and u64
  fidelity cannot be claimed until the shared boundary supplies them. Affects both budget commands.

- **F7 native image / native OCR**: merge `f59e27b31` now exposes
  `nativeImage.resizeTriangleJpeg(bytes,maxWidth,maxHeight,quality)` and `ImageOperationError.stage`.
  The old missing-symbol blocker is superseded. D10 now approves `pngjs@7.0.0`/`jpeg-js@0.4.4`;
  D5 Rust-output PSNR/tolerance evidence remains a separate F7 verification item.
  `prepare_segmentation_image_data` (`exam_engine.rs:350–394`) is now integrated on that export
  (C2 reports F7 9252ace96 switched to approved sharp; Rust-output PSNR evidence is still F7's).
  Native system OCR: L01 `performSystemOcr` still needs the F7 platform binding (macOS/Windows);
  L02 calls it unchanged. F4 strict base64 is now public (`platform/util` decodeBase64Standard).
- **L16 consumer wiring**: use `ctx.llmStreaming.singleShotCompletion` exported through
  `host/plugins/llm/api.ts`; this matches Rust `single_shot_completion`, not the much larger
  `call_unified_model_2_stream`. Adapter metadata is `ctx.llmAdapterInfos.listAdapterInfos`.
  L16's current `model-adapters.ts` still asks for `llm.adapter-infos@1` and needs the agreed rename.
- **Resolved: F3 usage public boundary**: main `967f43c75` has `LlmUsageService`
  (`storage/api.ts:688`) and real `llmUsage` provider (`storage/index.ts:157–165`), including
  `cacheDebugEnabled` and `recordLlmUsageCacheExtWithIdentity`. Existing raw/OCR injection
  already consumes this name. Full usage precision/end-to-end persistence is outside WP-002.
- **Resolved: F4 strict base64**: `platform/util/api.ts` exports `decodeBase64Standard`,
  consumed by registered `ocr_extract_text`. Translation TESTMAP already has both decoder
  rows ported to `tests/ocr_command.test.ts` (40 ported / 2 unrelated pending).

## L02 work still required (not external blockers)

### L03 context compiler exact high-level ports

WP-002 publishes `llmContextCompiler@1` with `ContextCompilerLlmOwner` in api.ts,
matching `context_compiler.rs:727/857`. index.ts binds the two existing real raw/OCR methods;
Cordis type, descriptor, meta.provides and runtime provider use `llmContextCompiler`.
Exact L03 usage is in LANE.md. The previous type-only description is superseded.

- **Published (llmRawPrompt@1)**: `callRawPromptWithConfigIdAndImagesCancellable` plus
  `callRawPromptWithConfigIdAndImages`, `callModel2RawPrompt` and `callModel2RawPromptOpts`
  (`src/raw_prompt_service.ts`, model2_pipeline.rs:8570–9346). They compose the L01 adapter,
  shared request preparation/Codex single refresh, failover (model2 exits only), RAW_PROMPT audit
  log and usage records. Production-entry tests: `tests/raw_prompt_service.test.ts`.
  Usage rows are written through the optional F3 `llmUsage` recorder (`LlmUsageRecorder` in api.ts);
  F3 has published it on main. If an isolated Host omits the recorder, the existing warn remains
  and the request itself is not failed (Rust recording never fails a call).
- **Published (llmOcrPages@1 / llmFileOcr@1)**: `callDedicatedOcrFreeTextWithFallback` and
  `callOcrFreeTextWithFallback` (exam_engine.rs:876–1067: probe acquired before candidate lookup,
  lookup errors → empty, dedicated filter excludes GLM4V/GenericVlm, probe released on config/image/
  prebuild failures, single prepared image, progressive hedging via the shared executor without a
  second allowRequest), `callOcrPageWithFallback` (:685–843) and `testOcrWithEngine` (mod.rs:7394).
  Image preparation uses F7 `nativeImage.resizeTriangleJpeg` (>1.5MB → Triangle/JPEG85 within 1600²).
  `llmFileOcr` wraps failures as CommandError(value=AppError). Tests: `tests/ocr_pages_service.test.ts`,
  `translation/tests/ocr_command.test.ts`, `translation/tests/ocr_extract_default_paths.test.ts`.
- **Resolved: F3 FileManager path seam**: main `storage/api.ts:707` and `storage/index.ts`
  publish `fileManagerPaths` (resolve_image_path / get_writable_app_data_dir).
  L02 already reads it via reflect when installed; otherwise it applies the same
  Rust rules (`src/ocr_pages_service.ts resolveImagePath`, `translation/src/ocr_extract.ts
  writableAppDataDir`) to `ctx.app.dataDir` (= active data dir passed to build_app_state).
- (resolved) OCR image preparation, file-based FreeOCR composition and structured page requests: see llmOcrPages above.
  Registered `translation/src/ocr_extract.ts` preserves the temporary-file lifecycle.
- `llmModel2Streaming.callUnifiedModel2Stream` now composes model selection/failover, request preparation,
  HTTP/SSE, cancellation, terminal checks, tool/usage hooks and final completion. L03 can consume this
  public service with its existing `llmStreamEvents` owner guard. Task `chat_v2` deliberately leaves
  database usage recording to L03, as Rust :7497–7501 requires. Variants/legacy use F3's now-published
  recorder; the minimum `Model2UsageRecorder` interface is exported from L02 api.ts, and those calls
  fail explicitly before sending when an isolated Host omits the owner service. Full L03 consumer
  integration remains independently tracked.
- Text embedding request/usage now runs through `embedding@1` (WP-022); remaining exact transport diagnostics are listed above.
  Boundary detection now runs on `llmRawPrompt.callModel2RawPrompt`
  (caller `other:boundary_detection`) and records usage through the F3 recorder port.
- Remaining SPEC semantic checkboxes and RAG tag-extraction output-filter integration.

### Function-level TESTMAP reconciliation

The static wiring checker works at test-file/module granularity. Mixed test files concealed
some helpers with no production caller. No assertions were removed; these remain pending:

- `codex_transport_bridges_sse_and_maps_usage_limit_404`: L01 now publishes and consumes its
  authoritative bridge through `llmCodexAuth`; L02's old test still targets its local duplicate.
  Shared bridge/HTTP normalization can be tested via the live sender, but the original final assertion
  calls `read_codex_response_body_limited(response, 8, ...)` on nine bytes. L01's equivalent
  `src/openai-codex/response.ts:30` exists but is not exported by `llm-providers/api.ts`.
  Request that exact bounded-reader public export (or same owner service method) to preserve the
  eight-byte assertion rather than substituting the sender's fixed 256KiB/32MiB limits. Until then
  retain pending; moving the other assertions to the shared live sender remains L02 reconciliation.
- `decode_payload_infers_png_from_signature` and
  `decode_payload_prefers_data_url_mime_when_signature_is_insufficient` (translation TESTMAP):
   now point to registered-command tests; neither is pending (translation TESTMAP:60–61).
- `deepseek_chat_audit_toggle_does_not_change_the_final_request` and
  `stream_with_noop_sink_completes_without_window` now run through `llmModel2Streaming` + real HTTP;
  job `20261104111051-db93ae` passed all seven integration tests, exit 0.

## Verified surfaces

- L01 Codex port is now on main. ConfigStore uses the active `llmCodexAuth.status` rather than
  parsing persisted credentials. Single-shot and connection-test paths use the shared prepare/send/
  one-refresh implementation; a real L01+L02 Host test verifies refresh and logout visibility.
  Raw-prompt and essay/RAG now also call the shared port. `prepareModel2Async`, unified streaming and
  OCR candidate prevalidation use that same manager; OCR candidate execution is covered by the live
  L01/L02 integration test. Plain raw/essay/RAG now await shared remote-image preparation as well.

- `llmMcpTools`: F1's main-branch `listenWindow` is now consumed by the live bridge/cache/tool
  service; real Host frontend events verify window targeting and cached advertisement.

- F4 `create_model_wrap_token_filter` is now on main and used at the essay/translation
  stream content outlet. Completed/Incomplete flush pending text; cancellation/errors do not.

- `llmStreaming.singleShotCompletion`: live adapter construction, HTTP/SSE transport, retry,
  stream rejection fallback, cancellation, response disposal, partial result semantics.
- `llmEmbeddingModels`: text/VL default resolution and writeback, adopt/heal default dimension.
- `llmOcrModels`: candidates and read-only availability, settings migrations (Paddle/GLM/priority),
  model/engine resolution, fallback diagnostics and thinking toggle; serde uses camelCase in settings.
- `llmRag.translateText`: nonstream translation, shared prompt builders, provider normalization,
  model/output budget, HTTP failure redaction and Rust logs; Codex uses L01 authenticated sending.
- `llmOcrRegions.parse`: adapter parsing, normalized/pixel cards, full-page threshold,
  legacy DeepSeek fallback, f32 coordinates and debug events; image dimensions use F7 nativeImage.
- `llmOcrHedge.prepareCandidates/runPrepared`: real single-shot engine transport, progressive race,
  cancellation/socket disposal, circuit breaker and request preparation from an already prepared image.
  Does not claim the file-based OCR commands are complete.
- `llmQuestionParsing.parse/parseStreaming`: explicit/default model lookup, original question prompt,
  incremental JSON array parsing and callback stop/partial-result semantics.
- `llmModel2Messages.build`: legacy history/multimodal/tool round conversion, provider reasoning
  replay, transient barriers and current-user injection; consumed by unified model-2 execution.
- `llmProviderRequests.prepareModel2`: protocol conversion, stable session identity and post-adapter
  cache diagnostics (the caller supplies the original cache-debug enable result).
- `llmStreamEvents`: content/reasoning/tool/usage/search/safety event collection, Done/EOF tool-call
  aggregation and owner-aware hook registration; unified transport now performs termination checks
  before invoking pending-tool and complete callbacks. F3 usage persistence is owned by the now-published llmUsage service.
- `llmAnkiRouting.probeAnkiRoutingSlots/resolveAnkiRoleDecision`: live configuration reads call
  the original `buildSlots/planRouting/logDebugPlan/planDecision` implementations; read failures
  retain Rust debug logs and empty-slot fallback. Public `parseRoutingMode/planRouting` exports
  allow L16 to replace its copied routing helper. L02-08's provider-side wiring now has integration tests.
- HTTP proxy: `createLlmHttpClient` now owns the real dispatcher used by single-shot,
  essay streaming and boundary completion. HTTP absolute-form, HTTPS CONNECT, NO_PROXY,
  redirect limit and shutdown are exercised in `tests/mod_proxy.test.ts`. `undici@7.30.1`
  is now a direct dependency on main (decisions.md D5); the package request is resolved.
- `streaming_harness.rs` is a Rust test harness. Its TS fixture driver now lives under `tests/`;
  it still executes the real L01 provider parsers. No test assertions were removed.

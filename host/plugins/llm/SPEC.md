# L02-llm-manager 行为规格（`host/plugins/llm/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 20 个 · 发出事件 24 种 · 契约：`contracts/ipc/L02-llm-manager.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

### 已提交代码审查：翻译配置可用性

`getTranslationModelConfig` 保留翻译专用分配优先、仅未分配时回退 model2 的选择规则。
选中的配置必须启用，且不是 embedding、reranker 或 image-generation 配置；否则在发送原文前报
`翻译模型已禁用或不支持文本调用`。这是对旧实现仅检查 id 存在、仍向已禁用模型发送请求的缺陷修复，
不再保留旧 Rust 分支忽略 enabled 的行为。`tests/translation_model_selection.test.ts` 经真实
`translate_text_stream` 命令及本地 HTTP 验证配置修改后的拒绝、零请求及正常回退；
`tests/recovery.test.ts` 同步验证服务层错误。

### WP-209：无会话 config-id raw prompt

`LlmRawPrompt.callWithConfigIdRawPrompt(configId:string,prompt:string,signal?:AbortSignal):Promise<StandardModel2Output>`，
由 `index.ts:121–126` 原 `createRawPromptService` → `ctx.provide('llmRawPrompt', rawPrompt)` 发布。

| Rust model2_pipeline.rs 分支 | TS raw_prompt_service.ts 落点 / 行为 |
|---|---|
| :8682–8699 | 两公开出口均委托 `withConfigIdScoped`；无会话入口传 null，agent入口传原 session |
| :8708–8713 | 真实 manager 配置读取；两次 find 保 id 优先于 model 名，不加 enabled/类型预筛选 |
| :8715–8723 | 未命中原全文 WARN 后读取 Model2；读取失败原样传播，不返回空成功 |
| :8726–8739 | forceJson=false、disableThinking=false、images=null、caller=chat_v2、task=compaction |
| :8950–8984 | 同一 withFailover/attempt/llmHttp；原 key/model fallback、usage、审计及错误语义 |
| :9300–9346 | 原四字段输出，包括空内容/空白；不 trim、不加 HPIAS fallback |
| synthesis.rs:73–104 | L17 拥有90秒超时/drop及空输出/错误降级；供方 signal 到实际 HTTP/body/重试等待，取消以 signal.reason 拒绝，等待 transport unwind |

无新增 SQL、配置存储格式或入站结构；string 参数与原 Rust &str 对应，返回既有 snake_case DTO。
Go 权限不改变：`:4883–4894` 的实际分支允许手动配置的非Agent Go，沿原 caller 的任务标识；
无会话入口不会伪造 agentSessionId。该共享准备分支原 INFO 日志在现 TS 中缺失，仍为既有日志对齐待办，
本包仅复用 transport，不据本出口签收整条 Go 准备链。
测试 `tests/config_id_raw_prompt.test.ts` 经真实L01/L02、独立注入消费者与本地HTTP；
既有 `raw_prompt_service.test.ts` 的agent断言及20秒重试预算保持。无此出口专属Rust测试，不变更原TESTMAP资格。

### WP-022：文本 embedding 正式传输

入口 `api.ts::TextEmbeddingService`，descriptor 和实际 Cordis 名称均为 **`embedding@1`**。
`index.ts` 正式 provide，发送前按调用获取 F3 `llmUsage`（缺失明确配置错误，不发送）；L12 已有 `ctx.get('embedding@1')`
与 `callEmbeddingApi(texts, modelId)` 可直接消费。`generateEmbedding(text)` 先解析默认配置，
再按该配置 id 调批量入口；错误是 AppError 值，包含原 details，不包 CommandError。

| Rust rag_extension.rs 分支 | TS 落点 / 原行为 |
|---|---|
| :31–127 | rag_extension.ts：auth/rate_limited/invalid_request/server/network/unknown；同时保留 establish 标签；Retry-After 仅 u64 秒数（允许 +，不接受日期/小数/溢出），大整数内部 bigint |
| :129–147 | embedding_transport.ts raw / embedding_defaults.ts：vendor 非空优先，否则 base URL；复用 routing 全局 keyCooldowns/keyFingerprint；内置缺 key 不参与默认模型选择 |
| :169–215 | embedding_defaults.ts + embedding_service.ts：设置读取先于配置读取；无效默认 id 按进程级 last-warned 去重；首次配置快照用于最终查找及能力校验 |
| :223–298 | 同上：经 llm.getModelAssignments 读取并验证分配；可用分配优先，随后重新读取配置自动检测；用户配置优先，名称/id 按 UTF-8 顺序；回写失败静默，维度读取/自动检测配置错误按原 if-let 忽略；原 debug/info/warn 保留 |
| :1009–1044 | embedding_transport.ts：generate 返回首向量/No embedding returned；空批次在配置读取前返回 []；严格 id 查找及 enabled/embedding/non-MM/non-rerank 校验 |
| :1047–1109 | 复用 L01 api.ts 的 EmbeddingTokenLimits/EmbeddingChunker/batchChunkTexts，展开一次 HTTP，0 块零向量（首返回维度或1024）、1块复制、多块 MeanPooling；原五处分块日志，L01 logger 同时接入 |
| :1118–1157 | 解密先于冷却，冷却先于 Claude 拒绝；冷却返回带429标签的 LLM 错误；openai/general/其他均相同 input/encoding_format=float |
| :1160–1203 | 共享 llmHttp.fetch 客户端（原代理、超时、10次重定向）；仅去 URL 末尾斜线后加 /embeddings；固定六个请求头，Origin/Referer 不含端口；不转发 config.headers/extraBody，也不走聊天适配器 |
| :1205–1242 | HTTP body读取前取Retry-After，按MIME charset无损/替换解码（无效charset默认UTF8），读取失败空字符串；完整 body error 日志而用户消息脱敏；401/403/429 读取 policy（失败默认60秒），仅冷却值clamp 1..3600，details保原Retry-After；不内部重试 |
| :1245–1275 | F4 parseJsonDocument/objectLastWins，Value任意未知字段/重复键last-wins；data/embedding 必须数组，每项as_f64后f32，保溢出Infinity/下溢和浮点负零；忽略index，不排序、不额外限制维数；先数据错误再数量不符 |
| :1277–1309 | prompt_tokens 存在时（含null/坏值）不回退 total_tokens；as_u64后按Rust as u32 截低32位；成功才调 F3 recordLlmUsageExt，caller=embedding，completion=0，四个Option=null，adapter=openai_embeddings，实测含0→api，否则heuristic；随后成功info |

不拥有新表或文件；唯一写入经 F4 settings、F3 llmUsage。冷却用共享单调时钟；HTTP完整消费
响应，读取失败由共享 fetch body 释放。Rust本入口无CancellationToken参数，未附加取消/重试策略。
生产入口测试 `tests/embedding_transport.test.ts` 安装真实L02并通过独立inject消费者发本地HTTP；
配置存取走真实LLMManager（settings/secrets/usage外部端口受控），不替换本lane算法。
证据为源码审读与TS生产入口测试，无Rust运行实录，不计C。多模态embedding/rerank仍属WP-023/024。

### WP-088 / D36：memory_decision 角色 raw prompt

`llmRawPrompt.callMemoryDecisionRawPrompt(prompt: string, signal?: AbortSignal): Promise<StandardModel2Output>`。

| Rust 分支 | TS 落点 / 必须保留的行为 |
|---|---|
| model2_pipeline.rs:8842–8855 | `getMemoryDecisionModelConfig()`（mod.rs:6960，memory_decision_model_config_id → model2_config_id，resolve_enabled_text_model 跳过禁用/嵌入/重排序） |
| :8909–8929 call_raw_prompt_with_config | 旧入口默认 `force_json=true`、`disable_thinking=false`、无图片、caller `memory`、task `memory_decision` |
| :8950–8984 | 同一 withFailover（BackgroundTask、非 pinned、无 agent session，因此不允许 OpenCode Go） |
| mod.rs:6972 | 无可用模型：`CommandError(AppError.configuration('没有已启用的有效记忆决策模型（禁止使用嵌入/重排序模型）'))`，不发 HTTP、无 usage |

返回值是原 `StandardModel2Output`（snake_case：`assistant_message`/`raw_response`/`chain_of_thought_details`/`cancelled`），
不做 camelCase 包装。HTTP/解析错误保持 RAW_PROMPT AppError 原 error_type/message/details。
Rust 入口没有取消令牌；消费方以 drop future 取消（semantic_dedup.rs:335 `tokio::time::timeout`），取消结果属于调用方。
TS `signal` 为可选：预取消在模型选择前、在途取消中止真实 fetch 与重试/429 等待，均以 `signal.reason` 拒绝，
之后不再请求、不记 usage。不传 signal 时行为与 Rust 相同。
测试：`tests/memory_decision_raw_prompt.test.ts`，真实 L01/L02 插件、独立公开 API 消费插件、真实本地 HTTP。
此出口无独立 Rust 单测；属源码分支回归，不新增或重标原 TESTMAP 行，不计 C。

### Anki 角色路由 raw prompt

`llmRawPrompt.callAnkiRoutedRawPrompt(decision: RoleDecision | null, task: string, prompt: string, images: ImagePayload[] | null, signal?: AbortSignal): Promise<StandardModel2Output>`。
消费方：chatanki analyze 的 Planner（`chatanki.plan_route`）与 Vlm 路由、anki 终审（`anki_critic.run_critic_pass`）。

| Rust 分支 | TS 落点 / 必须保留的行为 |
|---|---|
| model2_pipeline.rs:8639–8648 | `getApiConfigs()` 失败按空表（`.ok()`）；按 `decision.configId` 找已启用且非嵌入/重排序/生图的配置 |
| :8649–8658 → :8898 call_raw_prompt_with_config | 找到：`force_json=true`、caller `anki`、task 为调用方传入值、withFailover（BackgroundTask、非 pinned、无 agent session）、图片原样传入 |
| :8660–8664 | 未找到：debug `[ANKI_ROUTING] {role} 角色配置 {configId} 已不可用，回退 model2` |
| :8667–8672 → :8570 | decision 为 null 或未找到：`callModel2RawPrompt(prompt, images, 'anki')`，task `utility` |

`signal` 语义同 memory_decision 出口（Rust 调用方以 `tokio::time::timeout` drop future）。
测试：`tests/anki_routed_raw_prompt.test.ts`，真实 L01/L02 插件、真实 `llmAnkiRouting` 决策、真实本地 HTTP；
用 task 专属 fallback 链与 `llm-failover` 事件观察 task。

### WP-108 / D1-L18-M01：文本 raw prompt 取消

`llmRawPrompt.callModel2RawPromptOpts` 增补第五参 `cancellation?: AbortSignal`。
Rust `src/cmd/handout.rs:45–62,84–92` 在取消时 drop 整个 model2 future；TS 必须中止真实 HTTP。

| Rust 分支 | TS 落点 / 必须保留的行为 |
|---|---|
| handout.rs:49–53 | 文本入口预取消在模型选择前返回 `AppError.validation('cancelled')`；在途取消也返回同形状 |
| model2_pipeline.rs:8590–8609 | 仍取 model2，原 caller/task/forceJson 原样传给同一 withFailover/attempt |
| :8950–8984 / routing.rs:581–761 | 原 task fallback、key轮换、事件与建立预算；signal 贯穿 attempt 与429退避，取消停止后续候选/通知 |
| :9143–9274 | 同一 L01 adapter、共享 llmHttp / Codex sendWithSingleRefresh；signal 到实际 fetch，涵盖 headers、JSON body、错误body、Codex SSE |
| :9285–9293 | 原300ms指数退避，取消释放 timer/listener，不发送下一次请求 |
| :9300–9346 | 成功形状/usage 不变；取消后不记录成功或解析失败 usage，不返回晚结果 |

取消是结构化 AppError（Validation/cancelled/details:null），其余错误保原 error_type/message/details。
本入口不注册 handout 事件/监听，不持有 request-id registry；L18 负责将同一 run 的 signal 传入。
用量仍仅经 F3 recorder，审计及原 warn/debug 保留；没有本域新 SQL。
测试先写于 `tests/raw_prompt_cancellation.test.ts`：真实 L01/L02、独立公开 API 消费插件、真实本地 HTTP；
覆盖预取消、headers/body/error-body/Codex取消与socket关闭、两层退避、task fallback、成功/业务错与重复监听清理。
handout 对应范围无独立 Rust 单测；这是源码分支回归，不新增或重标原 TESTMAP 行，不计 C。

### WP-002 / B2-D08：ContextCompilerLlmOwner 正式组合

入口：`llmContextCompiler@1` / `ContextCompilerLlmOwner`，在 index.ts 直接绑定已有
`rawPrompt.callRawPromptWithConfigIdAndImagesCancellable` 与
`ocrPages.callDedicatedOcrFreeTextWithFallback`。原调用点为
`dstu-agent/src/chat_v2/pipeline/context_compiler.rs:727/857`。

| Rust 分支 | TS 落点 / 必须保留的行为 |
|---|---|
| model2_pipeline.rs:8766–8838 | raw_prompt_service：预取消优先；非空图片→配置 id/model→enabled→多模态语言模型校验；冻结配置，不切模型；force_json=false |
| :8996–9131 | 同一 raw attempt：user 文本后追加全部 data URL；原 generation/reasoning、L01 prepare/Codex、RAW_PROMPT 图片计数及审计日志 |
| :9136–9297 | 同一 raw attempt：HTTP 错误保 status/establish/context-window；解析失败先记录失败 usage，再按原 300ms 指数退避重试；warn 文案保留 |
| :9300–9345 | 原 StandardModel2Output 四字段（两个 Option 为 null）；caller=chat_v2 原样传 F3 usage 端口 |
| :417–430 / :8774 | 取消丢弃整个 provider future：HTTP 与 Codex bridge 使用同一 AbortSignal；取消后不再重试、审计或记录解析失败/成功用量；释放监听及退避计时器 |
| exam_engine.rs:867–924 | ocr_pages_service.freeText：先 acquire probe，再 best-effort 读取候选、过滤非 dedicated（含 GLM4V/GenericVlm）；无候选/文件错误释放 probe，不计引擎失败；图片只准备一次 |
| :926–1061 | 原 ocr_hedge_service.prepareCandidates：原图系统 OCR，解密/构造失败 warn 后跳过，全失败 Configuration；F7 >1.5MB Triangle/JPEG85 保现实现 |
| :1063–1208 | 原 executeAcquired：10s 渐进对冲，第一成功胜出，取消真实流并释放 probe；失败 warn、末错误原样 LLM；取消为 LLM `OCR cancelled` |

高层服务只转发原 AppError 值，不使用 llmFileOcr 的 IPC CommandError 包装；不添加二次候选选择、图片转换、熔断、用量统计。
L03 负责阶段超时/全轮预算、临时文件生命周期及降级日志。服务内部消费现有配置与 F3 usage；无新增表/文件所有权。
生产入口证据：`tests/context_compiler_owner.test.ts` 安装真实 L01/L02 与独立注入消费者，实际配置存取、真实 HTTP/JSON/SSE、文件读取和原 raw/OCR 算法；外部 settings/secrets/日志/usage 用受控端口。

### 统一流请求准备接缝（2026-11-04 续作）

`model2_pipeline.rs:4869–5015,6195–6267`：每次请求使用独立有状态 provider adapter；实际解析协议为权威值；remote image 下载/缓存/data URL 改写在同步 buildRequest 前 await L01。普通请求仍执行 L02 DeepSeek/OpenCode Go 归一和自定义头合并；Codex 仅经共享活跃 manager 准备，保留 generation/sessionId，交共享 stream sender 单次刷新，不能把非流式 JSON 桥当 SSE。会话从 stream event 解析，依次回退 messageId、chat_stream；cache debug 在适配后运行，不改请求体。新增异步 `prepareModel2Async`，保留原同步公开方法签名供既有纯转换消费者使用。此单元不宣告整个统一流执行器完成。

### D4 llm-replay 接线（WAVE2-BRIEF §8）

`src/replay_fetch.ts::withLlmReplay` 包住内部 `http.fetch`（同时是 `llmHttp` 服务）与 `test_api_connection` / `fetch_vendor_models` 的直连 fetch：
只有 URL 的 origin 是 `http://llm-replay.invalid`、且此刻挂载了 `llmReplay` 服务（`ctx.reflect.get('llmReplay', false)`，每次请求查一次，
与挂载顺序无关）时才交给回放；其余请求原样交给原 fetcher，未挂载时回放源请求也原样交给原 fetcher。回放失败以回放的错误抛出，不回落到网络。
无 Rust 对应物；生产 profile 不含回放插件，行为不变。回放 provider 本身的规格见 llm-providers SPEC「D4」。

## 验收问题处理（续作记录）

### L14 runQuestionJson 正式服务组合

`question_authoring.rs:166–247` 的兼容缓存、request_body、JSON拒绝一次重试及完整JSON校验沿用现有runQuestionJson；公开 `llmQuestionAuthoring.runQuestionJson(config,systemPrompt,userContent,cancel?)`，fetch/解密由本插件提供，AppError以原value包装CommandError。Rust :193–203确实调用manager.single_shot_completion，因此生产deps注入现有llmStreaming，去除旧私有传输副本；不是用singleShot替代上层JSON策略。保max_retries=0、输出推导字节上限、取消drop、Codex共享认证与响应usage。

同时公开 `buildDebugPersistConfig():{log_dir:string}|null`：model2_pipeline.rs:5095–5112仅设置值严格等于true字符串时启用；读取失败与未开启返回null；优先平台日志根，否则dataDir/logs；ensure目录失败按debug_log_service.rs:303–308忽略并返回路径。该公共方法仅返回配置，qbank仍自行按原步骤调用响应日志所有者。

### L02-05/06：隐藏内置模型列表（X6 UD config_profiles:47）

Rust `mod.rs:4666–4699`：settings读取缺失或失败直接空HashSet且不记解析warn；存在的JSON必须整体反序列化为Vec<String>，任一非字符串/非数组/语法错误均warn `[VendorModel] 解析隐藏内置模型列表失败，回退为空列表: {err}` 后整体回空，不保留部分合法ID。成功后每个ID按Rust Unicode White_Space trim、删除空项、去重；读取本身不写回归一化结果。后续reconcile按原snapshot/当前model条件独立决定是否写回；save仅筛空项，不trim非空ID，排序后保存。源码要求的语法错误serde_json Display仍属于既有L02-05共享诊断缺口，不以本次字段/日志修复宣称整个finding闭合。

固定编号X6-UD-0029。验证：`20261104130559-652345` 32 passed/2 failed、exit1，失败发生于新夹具错误按isBuiltin选原始profile（没有进入被测隐藏列表步骤）；修正夹具稳定ID、不改生产内置字段后，`20261104131336-90686e` 6 passed、exit0，无Errors。此前28条config_store测试通过，既有断言未改。恢复基线c6f4233a2/main44b66353c已通过五项lane-gate；本单元提交后再按§5自检。

### L02-05：X6 UD config_store.ts 旧787行

当前已有 `modelAssignmentsFromDe`→`serdeRecord`→`optionalString` 的字段解码；本单元只将存储JSON读取声明为unknown，并让解码器入口接受unknown，移除“解析前已是ModelAssignments__De”的无校验断言。错误包装、字段默认、未知字段忽略与数据库访问顺序均沿现实现。Rust依据mod.rs:7881–7887；既有 `tests/config_decode.test.ts` 经生产命令验证数字model id拒绝、null合法与未知字段忽略。不凭此宣称整个L02-05的错误诊断/精度问题闭合。

### X7-TOKEN-01 / X7-L02-HANGUL-A / X7-L02-HANGUL-B / X7-L02-HANGUL-COMPAT

`dstu-util/src/utils/token_budget.rs:8–32,170–174` 是独立启发式函数，不是桌面 feature 的 `estimate_tokens_with_model`。Hangul 保留 AC00–D7AF、1100–11FF、A960–A97F、D7B0–D7FF，不包含 3130–318F；每个系数与每次累加都按 f32 舍入，最后正数 round/max(1)，空输入0。ASCII 空白沿 Rust `is_ascii_whitespace`（TAB/LF/FF/CR/space，不含 VT）。生产消费者为统一流 usage fallback 与 input_guard。

静态向量：A960×3=3、D7B0×3=3、3130×3=2；`.`×15 的 f32和为0x40900000→5，space×30为0x3fbffffd→1；100000个`.`/space/emoji分别为30028/4999/79988。依据源码与IEEE754 binary32复算，不是C级Rust运行差分。测试保留常量预期，不在测试中重写累加算法；不改F7精确tokenizer。

- X5/L02-01/07：统一流已提供并通过真实 HTTP 最小集，作业 `20261104111051-db93ae` 7 passed / exit 0；后续全量 `20261104111422-04343e` 869 passed / exit 0。类型检查首轮 `20261104110715-fe06a6` exit 2（取消/超时联合类型未拆分），已修为可判别联合，`20261104111422-436815` exit 0。Rust 无窗口原三条断言（全文、未取消、调用1次）全部保留在新生产入口测试；请求审计原字段/不变/落盘断言均保留并增强为真实 HTTP 对照。旧测试未删除，TESTMAP 指向真实入口测试。
- R1 §6：异步 `prepareModel2Async` 与统一流修复原 provider_requests 消费缺口；同步 plain helper 仍保持拒绝 OAuth 的原不变量。OCR prepareCandidates、raw usage 仍未闭合；不会以本次单变体 chat usage hook 证据替代 F3 落库证据。
- 后续 OCR 预验证已接共享异步 prepare，并由真实 L01+L02 插件测试覆盖 prepareCandidates→isCodex→runPrepared；raw/essay/RAG 非Codex准备也复用异步预取。`20261104112351-cc4215` typecheck exit 0；`20261104112351-a813ad` 82 files / 869 tests passed，exit 0，无 Errors。`20261104111739-0d1f8c` Electron 真实 SQLite 作文测试 9 passed，exit 0。F1广播/target与clear-preheat对照由 `20261104113105-d8e2bc` 验证。
- 统一请求源码续核：`Option<&Value>::or_else` 遇到显式 null 不取别名值（mod.rs:8691–8701、pipeline:5938–5955），新增真实请求向量覆盖；request_bytes 先计算、后移除工具互斥 thinking 字段（:6191/:6209）；使用 collector 的只读 ended 状态避免每个网络块复制全文。Codex Network AppError 仍读取原 message，不转成 `[object Object]`。

### L02-01 OCR 异步预验证续作

`exam_engine.rs:1021–1051` 在候选入队前 await manager.prepare_provider_request，失败只 warn 并继续下一个候选；成功的 `is_codex` 决定 local 非 Send 对冲分支。TS 预验证改为同一异步共享准备（含远程图片），不再把 Codex 传给 plain helper；runPrepared 的 Codex 分支继续用共享 single-shot sender。本项只接已准备图片的对冲服务，不冒充文件 OCR 命令完成。

### F4 SSE 公共实现消费

`single_shot_stream.rs:42,445,466,521,632` 与 `model2_pipeline.rs:6598,6750` 均使用同一个 `SseEventBuffer`。主线已包含 F4 公开实现后，移除 `single_shot_stream.ts` 和 `stream_validation.ts` 的本地类，直接 import/re-export `platform/util/api.ts`；旧 API 导出仅转发，未增加解析算法。生产错误日志由 F4 `dstu.platform.log` 绑定 `setSseBufferLogger`，保留 10MiB 溢出和非法/不完整 UTF-8 日志。既有 EOF、JSONL、metadata、取消与释放断言保持；补充真实生产 single-shot HTTP 输入对 CRLF 和无尾换行验证。

### 统一 model-2 流执行行为清单

- `5191–5290`：review/tag/default 路由、原 failover/key 轮换、所有候选推理覆盖；最终总是 clearCancelArtifacts。
- `5328–6267`：推理/多模态校验，图谱与无 tools 预取注入，历史转换，工具 schema/MFJS/Qwen 规则，generation/passback/budget 预检；不裁剪历史；取消预注册；异步共享 provider 准备。
- `6269–6577`：适配后审计不改变请求体；start 在 HTTP 前；7200s 单次 POST；建连/429/5xx 重试（4000–5000ms；Retry-After ≤120s）；401/403 分类、context-window 打标；取消中止实际 socket。Codex 共享 stream sender 保留一次刷新。
- `6579–7292`：F4 SSE 保留 metadata/EOF/JSONL；adapter.finishStream 只在 EOF；600s idle，取消同时唤醒；读失败完整/部分事件不同；终止失败先于 tool finalize；取消跳过终止/空载荷校验，仍 finalize pending tools；所有出口释放响应。
- `7321–7556`：最终 tool hooks、非取消 complete hook/legacy 完成事件；取消输出空 assistant_message 且 cancelled=true；chain-of-thought 原三策略；usage 经 hook，taskContext=chat_v2 不重复写 F3，其余路径需要 F3 所有者 record 端口。该记录接口尚未发布，接缝必须显式表达，不能静默跳过。

- 集成通知的 `preparePlainProviderRequest` / `providerAdapterForConfig` 缺失：当前提交链已包含两者公开 re-export；主线合并 `84f3f7904` 后两个插件均 `importable: ok`。本 lane 不更改 translation 的公开 API 导入为私有路径。
- 新增异步准备测试首轮失败（作业 `20261104090404-c89097` exit 1，3 failed）：测试初稿错误假定 SSRF 拒绝抛错、OpenAI Chat 不要求终止标记、无 `_var_` 的 `_run_` 能剥离。对读 `fetch.rs` Option、`providers/mod.rs:3958` 与现有 stream_scope 原测试后修正新夹具：真实外部图片响应改为可观察 data URL 转换，SSRF 验证无 HTTP；Chat 要求终止；Codex 采用真实 variant/run 事件格式。原 Rust 移植断言未改。
- L02-01：新公开异步准备消费活跃认证，single-shot 也复用同一准备路径；真实 L01+L02 入口测试继续覆盖共享 401 刷新。统一 model-2 发送/收尾仍在续作。
- 基线检查：`20261104085642-35dec0` typecheck exit 0；`20261104085643-be240e` 81 files / 860 tests passed，exit 0；`20261104085643-63fde2` ledger exit 0。合并新主线后 strict 发现四个 `host/plugins/vfs/` 既有违规，本 lane 零违规，非 strict exit 0。
- 合并后门禁：`20261104090922-385899` typecheck exit 0；`20261104090922-54827e` 全量 lane 79 files passed，2 failed（新测试错误使用允许的 loopback 做拒绝样例；VFS 测试路径替身缺新公开 dataSpaceDeviceId）。按 Rust fetch.rs:9–10/125–129 改用明确被拒绝的 10.0.0.8，并更新外部 paths 替身；`20261104092132-4ad225` 两文件 12 tests passed，exit 0，无 Errors；`20261104092132-f9e3f7` ledger exit 0。两插件 importable exit 0，wiring 分别 664/40 ported、未接入 0。实现及夹具修复已由 `d9d4f5569` / `0013475dd` / `5cf9a50f0` 检查点保留。

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [ ] Option → null 还是缺省（`skip_serializing_if`）：
- [ ] u64/i64 超过 2^53 的表示：
- [ ] 字段顺序（serde_json preserve_order）：
- [ ] f32 精度：
- [ ] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：
- [ ] 取消：CancellationToken / drop → AbortSignal，取消点一致：
- [ ] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：
- [ ] 时间与 ID：生成方式、格式、时区：
- [ ] 不对含 HashMap 的结构做序列化后比对：

## 命令 `call_llm_for_boundary`

<!-- BEGIN GENERATED:cmd:call_llm_for_boundary -->
- Rust：`src-tauri/src/commands.rs:4051` · async
- 前端：app（2 处，例 `src/components/anki/cardforge/engines/CardAgent.ts:907`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：prompt: string
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:call_llm_for_boundary -->

- [x] 输入：`prompt` 原样作为 user prompt，不构造 system 消息（commands.rs:4051-4071；model2_pipeline.rs:9010-9031）。
- [x] 输出：`{assistant_message, input_tokens: 0, output_tokens: 0}`；文本从各协议非流式响应提取（commands.rs:4066-4071）。
- [x] 错误：模型未配置/未启用、网络失败、HTTP 非 2xx、响应解析失败均原样返回 `AppError`（LLM/Network/Configuration）。
- [x] 事件：不 emit。
- [x] DB 读写：只读模型分配与 API 配置。
- [x] 取消/并发：不注册取消通道；请求随 `ctx` 生命周期结束。
- [x] 时间/ID：本命令不生成时间或 ID。
- [x] 已知缺口：未移植 Failover/key 轮换与 usage 统计；Codex OAuth 配置返回配置错误（已写入交接报告）。

## 命令 `cancel_stream`

<!-- BEGIN GENERATED:cmd:cancel_stream -->
- Rust：`src-tauri/src/commands.rs:341` · async
- 前端：app（9 处，例 `src/essay-grading/useEssayGradingStream.ts:288`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：streamEventName: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:cancel_stream -->

- [x] 输入：`streamEventName` 字符串，不 trim（commands.rs:342）。
- [x] 输出：任何事件名均返回 true（commands.rs:352）。
- [x] 错误：业务无 Err 分支，参数错误由内核处理。
- [x] 事件：不 emit；仅通知已有 watch 通道（mod.rs:5467）。
- [x] DB 读写：无，只有进程内取消注册表。
- [x] 取消/并发：先通知当前通道，后插入一次性取消标记；重复订阅替换 sender，清通道不清 pending（mod.rs:5458-5546）。命令不因调用窗口关闭而停止。
- [x] 时间/ID：调用方提供事件名，不生成时间或 ID。
- [x] 日志：commands.rs:343–351 的进入/调用/成功与 mod.rs:5460–5501 的通知、写备用标记、消费标记日志按顺序记录；AbortSignal 持有期间没有 Rust watch receiver 被 drop 后 send 失败的可观察分支。

## 命令 `check_api_config_status`

<!-- BEGIN GENERATED:cmd:check_api_config_status -->
- Rust：`src-tauri/crates/dstu-llm/src/config_recovery.rs:192` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：（无）
  - 结果：Value · 错误：string · 注入：state
<!-- END GENERATED:cmd:check_api_config_status -->

- [x] 输入：无参数（config_recovery.rs:192–199）。
- [x] 输出：config_count、enabled_count、has_assignments、needs_recovery；只有 model2/review-analysis 任一 Some 算有分配，配置为空才 needs_recovery（:201–215）。
- [x] 错误：配置读取失败字符串 `获取配置失败: {e}`；分配读取失败忽略且 has_assignments=false，无 warn（:199–208）。
- [x] 事件：无。
- [x] DB 读写：依序 get_api_configs/get_model_assignments；读取触发的既有配置迁移照 store 行为保留，命令无新增写入（:196–201）。
- [x] 取消/并发：依序 await，无取消点，不受窗口关闭影响。
- [x] 时间/ID：命令不生成时间/ID；无命令级日志。

## 命令 `estimate_tokens`

<!-- BEGIN GENERATED:cmd:estimate_tokens -->
- Rust：`src-tauri/src/commands.rs:316` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：request: EstimateTokensRequest
  - 结果：Value · 错误：AppError
<!-- END GENERATED:cmd:estimate_tokens -->

- [x] 输入：request.texts 按序逐项估算，model 可省略/null；空文本/空数组保留（commands.rs:309–326）。
- [x] 输出：{total, per_message, precise:true, tokenizer:"tiktoken"}；桌面 tokenizer_tiktoken feature 开启，调用 F7 nativeTokenizer，不再冒充移动端启发式构建（commands.rs:328–337）。
- [x] 错误：原命令无业务 Err，参数由内核 serde 契约校验。
- [x] 事件：无；无命令级日志。
- [x] DB 读写：无；F7 缓存 BPE 编码器。
- [x] 取消/并发：同步 token 计算，无取消点，不响应窗口关闭取消。
- [x] 时间/ID：无时间、ID 生成。

## 命令 `fetch_vendor_models`

<!-- BEGIN GENERATED:cmd:fetch_vendor_models -->
- Rust：`src-tauri/src/commands.rs:3106` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：vendorId: string
  - 结果：FetchedVendorModel[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:fetch_vendor_models -->

- [x] 输入：`vendorId` trim 后查 `vendor_config_for_runtime`；OpenCode Go 直接返回内置目录（commands.rs:3106-3128）。
- [x] 输出：`FetchedVendorModel[]`，按 id 升序；探测 `context_length|context_window|max_context_length|max_model_len` 与 `max_output_tokens|max_completion_tokens|top_provider.max_completion_tokens`（commands.rs:2918-2950、3285-3297）。
- [x] 错误：无 key、Base URL 无效、请求头无效、网络/HTTP/解析失败均返回 Rust 文案（commands.rs:2952-3104、3133-3143）。
- [x] 事件：不 emit。
- [x] DB 读写：只读供应商配置，不写设置。
- [x] 取消/并发：无取消通道；单次最多 20 页，分页游标为 gemini `nextPageToken`、anthropic `after_id`、openai `last_id/after`。
- [x] 时间/ID：超时 `default_timeout_ms` 默认 30000，clamp 1000–120000；不生成 ID。
- [x] 网络细节：GET、禁止重定向、错误体截断 2048 字符，与 `vendor_model_response_json` 一致。

## 命令 `get_api_configurations`

<!-- BEGIN GENERATED:cmd:get_api_configurations -->
- Rust：`src-tauri/src/commands.rs:2127` · async
- 前端：app（15 处，例 `src/components/NoTagTreeShadPanel.tsx:90`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：（无）
  - 结果：ApiConfig[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_api_configurations -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_injection_budget_config`

<!-- BEGIN GENERATED:cmd:get_injection_budget_config -->
- Rust：`src-tauri/src/commands.rs:6913` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_injection_budget_config -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_model_assignments`

<!-- BEGIN GENERATED:cmd:get_model_assignments -->
- Rust：`src-tauri/src/commands.rs:2175` · async
- 前端：app（14 处，例 `src/components/NoTagTreeShadPanel.tsx:91`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：（无）
  - 结果：ModelAssignments · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_model_assignments -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_model_profiles`

<!-- BEGIN GENERATED:cmd:get_model_profiles -->
- Rust：`src-tauri/src/commands.rs:2206` · async
- 前端：app（3 处，例 `src/features/chat/components/input-bar/InputBarV2.tsx:783`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：（无）
  - 结果：ModelProfile[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_model_profiles -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_vendor_configs`

<!-- BEGIN GENERATED:cmd:get_vendor_configs -->
- Rust：`src-tauri/src/commands.rs:2193` · async
- 前端：app（4 处，例 `src/features/chat/components/input-bar/ModelPicker.tsx:182`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：（无）
  - 结果：VendorConfig[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_vendor_configs -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `llm_get_failover_policy`

<!-- BEGIN GENERATED:cmd:llm_get_failover_policy -->
- Rust：`src-tauri/crates/dstu-llm/src/llm_manager/routing.rs:781` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：（无）
  - 结果：FailoverPolicy · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:llm_get_failover_policy -->

- [x] 输入：无（routing.rs:782）。
- [x] 输出：camelCase 策略；缺失、空白、反序列化失败回默认；默认 enabled=true、autoDegradeChat=false、空链/映射、60 秒冷却、1500 毫秒退避（routing.rs:78-90,550-564）。

WP-131 持久化精度分支（生产入口测试与源码审读，非 Rust 动态差分）：

| Rust | TS 落点 | 保留行为 |
|---|---|---|
| routing.rs:55–90 serde struct/default | policy.ts:17–84 | camelCase、对象/顺序数组、缺字段默认、未知字段 IgnoredAny、重复字段报错、map 重复键 last-wins |
| routing.rs:73–75 u64 | policy.ts:51–52 | keyCooldownSecs/rateLimitBackoffMs 经 F4 readUnsigned 精确读取；MAX合法，越界/负数/小数/指数按 typed 错误废弃 |
| routing.rs:550–565 | control.ts:49–62 | 读取失败原 Database；空/缺失默认；解码失败原 warn 后整份默认，不写回 |
| rag_extension.rs:1222–1234 | index.ts:150 → embedding_transport.ts:96–103 | 真实 exact 策略回调，读取失败默认；Retry-After 优先；原 1..3600 clamp 后 Number，原冷却状态与 warn |

测试 `policy_precision.test.ts` 使用真实 settings 持久化与 HTTP 401；通过单调时钟截止值和
下一次调用冷却错误验证时长，不真实等待。原 API 的 number 出站投影与取消/HTTP请求路径保留。

- [x] 错误：读失败 AppError Database，`读取 Failover 策略失败: {error}`，details=null；损坏 JSON 不返回错误。
- [x] 事件：无。
- [x] DB 读写：经 settings 读 `llm_failover_policy`，不写回默认。
- [x] 取消/并发：同步读，无取消点。
- [x] 时间/ID：无。

## 命令 `llm_set_failover_policy`

<!-- BEGIN GENERATED:cmd:llm_set_failover_policy -->
- Rust：`src-tauri/crates/dstu-llm/src/llm_manager/routing.rs:789` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：policy: FailoverPolicy__De
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:llm_set_failover_policy -->

- [x] 输入：policy 各缺省字段用 FailoverPolicy::default；未知字段丢弃（routing.rs:57-88）。
- [x] 输出：null（Rust unit）。
- [x] 错误：序列化失败 Configuration `序列化 Failover 策略失败: {error}`；写失败 Database `保存 Failover 策略失败: {error}`；details=null（routing.rs:568-573）。
- [x] 事件：无。
- [x] DB 读写：settings.save `llm_failover_policy`，camelCase JSON。
- [x] 取消/并发：同步写，无取消点。
- [x] 时间/ID：设置更新时间由 F4 settings.save 处理。

## 命令 `opencode_go_get_usage`

<!-- BEGIN GENERATED:cmd:opencode_go_get_usage -->
- Rust：`src-tauri/src/commands.rs:3311` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：vendorId?: string | null
  - 结果：OpenCodeGoUsage · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:opencode_go_get_usage -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `restore_default_api_configs`

<!-- BEGIN GENERATED:cmd:restore_default_api_configs -->
- Rust：`src-tauri/crates/dstu-llm/src/config_recovery.rs:166` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：（无）
  - 结果：string · 错误：string · 注入：state
<!-- END GENERATED:cmd:restore_default_api_configs -->

- [x] 输入：无参数；两条默认配置及全 None 分配由 config_recovery.rs:11–161 定义。
- [x] 输出：`✅ 默认API配置已恢复！请填入您的API密钥并启用相应配置。`（:188）。
- [x] 错误：保存配置失败字符串 `保存默认配置失败: {e}`；保存分配失败字符串 `保存模型分配失败: {e}`（:174–186）。
- [x] 事件：无。
- [x] DB 读写：先保存全部默认配置，成功后保存默认分配；两步不包事务，第二步失败保留第一步写入（:173–186）。
- [x] 取消/并发：两步依次 await，无窗口取消点；无命令级日志。
- [x] 时间/ID：默认模型 ID 固定 openai-gpt4/claude-sonnet；设置更新时间由平台 settings 服务记录。

## 命令 `save_api_configurations`

<!-- BEGIN GENERATED:cmd:save_api_configurations -->
- Rust：`src-tauri/src/commands.rs:2149` · async
- 前端：app（1 处，例 `src/utils/configApi.ts:108`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：configs: ApiConfig__De[]
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:save_api_configurations -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `save_model_assignments`

<!-- BEGIN GENERATED:cmd:save_model_assignments -->
- Rust：`src-tauri/src/commands.rs:2182` · async
- 前端：app（4 处，例 `src/features/chat/components/input-bar/ModelPicker.tsx:363`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：assignments: ModelAssignments__De
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:save_model_assignments -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `save_model_profiles`

<!-- BEGIN GENERATED:cmd:save_model_profiles -->
- Rust：`src-tauri/src/commands.rs:2211` · async
- 前端：app（2 处，例 `src/features/chat/hooks/useFavoriteChatModels.ts:130`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：profiles: ModelProfile__De[]
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:save_model_profiles -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `save_vendor_configs`

<!-- BEGIN GENERATED:cmd:save_vendor_configs -->
- Rust：`src-tauri/src/commands.rs:2198` · async
- 前端：app（1 处，例 `src/utils/configApi.ts:126`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：configs: VendorConfig__De[]
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:save_vendor_configs -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `simulate_budget_allocation`

<!-- BEGIN GENERATED:cmd:simulate_budget_allocation -->
- Rust：`src-tauri/src/commands.rs:6927` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：testItems: Value[]
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:simulate_budget_allocation -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `test_api_connection`

<!-- BEGIN GENERATED:cmd:test_api_connection -->
- Rust：`src-tauri/src/commands.rs:3321` · async
- 前端：app（3 处，例 `src/features/settings/components/ShadApiEditModal.tsx:853`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：apiKey: string, apiBase: string, apiProtocol?: string | null, supportsOpenaiResponses?: boolean | null, providerType?: string | null, providerScope?: string | null, authMode?: string | null, modelAdapter?: string | null, model?: string | null, vendorId?: string | null, headers?: object | null, isEmbedding?: boolean | null, isReranker?: boolean | null, isImageGeneration?: boolean | null, isReasoning?: boolean | null, supportsReasoning?: boolean | null, enableThinking?: boolean | null, thinkingBudget?: integer(i32) | null, includeThoughts?: boolean | null, reasoningEffort?: string | null, reasoningMode?: string | null, maxOutputTokens?: integer(u32) | null, maxTokensLimit?: integer(u32) | null, geminiApiVersion?: string | null
  - 结果：ConnectionTestOutcome · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:test_api_connection -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 事件 `chat_v2_llm_request_body`

<!-- BEGIN GENERATED:event:chat_v2_llm_request_body -->
- 事件名 `chat_v2_llm_request_body`
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:4002`（emit）
<!-- END GENERATED:event:chat_v2_llm_request_body -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `chat_v2://model_assignments_changed`

<!-- BEGIN GENERATED:event:chat_v2://model_assignments_changed -->
- 事件名 `chat_v2://model_assignments_changed`，常量 `MODEL_ASSIGNMENTS_CHANGED_EVENT`
- 发送点：`src-tauri/src/chat_v2/tools/settings_models_executor.rs:412`（emit）
<!-- END GENERATED:event:chat_v2://model_assignments_changed -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `chat_v2://model_profiles_changed`

<!-- BEGIN GENERATED:event:chat_v2://model_profiles_changed -->
- 事件名 `chat_v2://model_profiles_changed`，常量 `MODEL_PROFILES_CHANGED_EVENT`
- 发送点：`src-tauri/src/chat_v2/tools/settings_models_executor.rs:616`（emit）
<!-- END GENERATED:event:chat_v2://model_profiles_changed -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `chat_v2://settings_changed`

<!-- BEGIN GENERATED:event:chat_v2://settings_changed -->
- 事件名 `chat_v2://settings_changed`，常量 `SETTINGS_CHANGED_EVENT`
- 发送点：`src-tauri/src/chat_v2/tools/settings_models_executor.rs:234`（emit）
<!-- END GENERATED:event:chat_v2://settings_changed -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `deepseek_ocr_log`

<!-- BEGIN GENERATED:event:deepseek_ocr_log -->
- 事件名 `deepseek_ocr_log`
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/exam_engine.rs:458`（emit）
<!-- END GENERATED:event:deepseek_ocr_log -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `llm-failover`

<!-- BEGIN GENERATED:event:llm-failover -->
- 事件名 `llm-failover`，常量 `FAILOVER_EVENT_NAME`
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/routing.rs:709`（emit）
<!-- END GENERATED:event:llm-failover -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `mcp-bridge-tools-request`

<!-- BEGIN GENERATED:event:mcp-bridge-tools-request -->
- 事件名 `mcp-bridge-tools-request`
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:8240`（emit）
<!-- END GENERATED:event:mcp-bridge-tools-request -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `stream_error`

<!-- BEGIN GENERATED:event:stream_error -->
- 事件名 `stream_error`
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7179`（emit）
<!-- END GENERATED:event:stream_error -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `{}_cancelled`

<!-- BEGIN GENERATED:event:fmt:{}_cancelled -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6728`（emit）
<!-- END GENERATED:event:fmt:{}_cancelled -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `{}_error`

<!-- BEGIN GENERATED:event:fmt:{}_error -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7045`（emit）
<!-- END GENERATED:event:fmt:{}_error -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `{}_id`

<!-- BEGIN GENERATED:event:fmt:{}_id -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6614`（emit）
<!-- END GENERATED:event:fmt:{}_id -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `{}_memory_sources`

<!-- BEGIN GENERATED:event:fmt:{}_memory_sources -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:5350`（emit）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:5409`（emit）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:5997`（emit）
<!-- END GENERATED:event:fmt:{}_memory_sources -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `{}_rag_sources`

<!-- BEGIN GENERATED:event:fmt:{}_rag_sources -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:5338`（emit）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:5397`（emit）
<!-- END GENERATED:event:fmt:{}_rag_sources -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `{}_reasoning`

<!-- BEGIN GENERATED:event:fmt:{}_reasoning -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6831`（emit）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7410`（emit）
<!-- END GENERATED:event:fmt:{}_reasoning -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `{}_safety_blocked`

<!-- BEGIN GENERATED:event:fmt:{}_safety_blocked -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7019`（emit）
<!-- END GENERATED:event:fmt:{}_safety_blocked -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `{}_start`

<!-- BEGIN GENERATED:event:fmt:{}_start -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6284`（emit）
<!-- END GENERATED:event:fmt:{}_start -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `{}_usage`

<!-- BEGIN GENERATED:event:fmt:{}_usage -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6980`（emit）
<!-- END GENERATED:event:fmt:{}_usage -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `{}_web_search`

<!-- BEGIN GENERATED:event:fmt:{}_web_search -->
- 动态事件名（format! 模板）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:5324`（emit）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:5384`（emit）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7004`（emit）
<!-- END GENERATED:event:fmt:{}_web_search -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `channel`

<!-- BEGIN GENERATED:event:expr:channel -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/mod.rs:126`（emit）
<!-- END GENERATED:event:expr:channel -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `error_event`

<!-- BEGIN GENERATED:event:expr:error_event -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7175`（emit）
<!-- END GENERATED:event:expr:error_event -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `Self::event_name(stream_session_id)`

<!-- BEGIN GENERATED:event:expr:Self::event_name(stream_session_id) -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-tutor/src/essay_grading/events.rs:39`（emit）
- 发送点：`src-tauri/crates/dstu-tutor/src/essay_grading/events.rs:66`（emit）
- 发送点：`src-tauri/crates/dstu-tutor/src/essay_grading/events.rs:86`（emit）
- 发送点：`src-tauri/crates/dstu-tutor/src/essay_grading/events.rs:146`（emit）
- 发送点：`src-tauri/crates/dstu-tutor/src/essay_grading/events.rs:160`（emit）
<!-- END GENERATED:event:expr:Self::event_name(stream_session_id) -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `session_channel`

<!-- BEGIN GENERATED:event:expr:session_channel -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:5152`（emit）
<!-- END GENERATED:event:expr:session_channel -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `stream_event`

<!-- BEGIN GENERATED:event:expr:stream_event -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:6810`（emit）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7390`（emit）
<!-- END GENERATED:event:expr:stream_event -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `truncated_event`

<!-- BEGIN GENERATED:event:expr:truncated_event -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:7155`（emit）
<!-- END GENERATED:event:expr:truncated_event -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：
# 跨插件请求策略 API

## L16 流式调用面

### HTTP 客户端（mod.rs:5549–5602、8872–8962）

- [x] 生产流式/普通调用共用客户端：默认 Accept-Encoding=identity、300 秒总超时、30 秒连接超时、TLS 验证开启；跟随重定向上限 10，代理读取 HTTP(S)_PROXY/ALL_PROXY 与 NO_PROXY。
- [x] HTTP 代理使用绝对请求行，HTTPS 经 CONNECT；代理认证由成熟 undici ProxyAgent 处理，禁止全局修改 dispatcher。插件卸载销毁连接池。
- [x] 保留 Rust 客户端初始化成功日志（原文的 120s/15s 与实际配置 300s/30s 不一致，照原样保留）；构建失败按原顺序降级并输出相同 warn。
- [x] 原 `http_client_honors_proxy_environment` 测试改为实际客户端；额外经流服务验证代理真正收到请求、HTTPS CONNECT 与 NO_PROXY。

使用 `undici@7.30.1`；main 已按 decisions.md D5 提升为直接依赖，
本 lane 未修改 package.json/lockfile。
单次请求的 requestTimeoutMs 对应 reqwest RequestBuilder::timeout；single-shot 将本次预算
传入以覆盖 manager 的300秒默认，长流不会被共享客户端默认值提前截断。

`api.ts` 发布 `LlmStreamingService`、`llmStreamingService`（1.0.0）；
生产调用为 `ctx.llmStreaming.singleShotCompletion(config, requestBody, apiKey, sessionId,
buildErrorContext, opts, onDelta)`，参数顺序对应 Rust
`llm_manager/single_shot_stream.rs:998 LLMManager::single_shot_completion`。
`requestBody` 为 OpenAI 形状且不修改原值，适配器由 `ctx.llmAdapters` 创建。
`SingleShotOptions` 时间单位为毫秒，取消通过 `cancel: AbortSignal`；回调返回 false
停止交付并返回 `aborted=true`。输出后失败返回 `interrupted`，不得重复交付重试。
失败/超时/取消/完成均关闭实际响应流。Codex OAuth 等待 L01 请求刷新接口。

另导出 `defaultSingleShotOptions`、`runSingleShot`、`bodyForMode`、
`runStreamingCompletion` 及对应类型，供自有传输或 sink 的调用方使用。
这不是 `call_unified_model_2_stream` 的替代：后者的工具循环/上下文编排仍须独立接线。

`ctx.llmEmbeddingModels` 发布文本/VL 默认模型解析及 adopt/heal 默认维度操作，
复用 settings 持久化和运行时模型配置；`ctx.llmAdapterInfos.listAdapterInfos()`
按 Rust 主 ID 顺序返回去重后的显示元数据。剩余工作与外部接口缺口见 `BLOCKERS.md`。

## 2026-11-04 质量整改

- 时间调用直接使用 F4 `toRfc3339` / `toRfc3339Opts`；删除本地 `time.ts` 和
  `chronoRfc3339`。注入预算保留 serde 的 AutoSi + Z；审计日志保留本地时区偏移。
- `settings_models_executor.ts` 按参数白名单/校验、模型能力/分配、执行调度拆分；
  既有导出和工具事件、错误、凭据脱敏、同步 OCC 顺序保持不变。
- 构造函数显式声明字段并赋值；`GradingStage` 使用 const 对象和同名类型。
  `llm/index.ts`、`translation/index.ts` 均纳入 Node 原生类型擦除导入验证。

`api.ts` 稳定导出 `applyReasoningConfig`、`applyGenerationParams`、
`applyOfficialDeepseekGenerationParams`、`resolveQuirks` 供 L01 经发布边界复用。
前三者只改写调用方请求体，`resolveQuirks` 只读取配置；无网络、存储或服务定位副作用。

## OCR 配置与候选服务（mod.rs:3250–3415、7006–7388、7587–7709）

- 输入 settings 的 `ocr.available_models` 使用 camelCase serde 字段，必须有
  configId/model/engineType/name，isFree=false、enabled=true、priority=0；解析失败回退 legacy，
  有效空数组/禁用列表禁止只读探测回退原生 OCR。只读探测不触发 OCR 迁移。
- 候选按 priority 稳定排序后按任务类型稳定分组；原生 OCR 仅 FreeText 且平台支持时加入一次。
  过滤 disabled/non-multimodal/停服模型；引擎验证、推断复用 L01 OcrAdapterFactory。
- `getOcrModelConfig` 保留 Rust 不检查 config.enabled 的行为（候选列表会检查）；全部失败后
  查询 exam_sheet_ocr_model_config_id，保留逐条 skip warn、fallback warn/info 和原错误文案。
- 迁移顺序：Paddle 1.5（显式 v1 除外）→ 按 siliconflow/bigmodel 迁移 GLM 及关联 API 配置
  → 旧单选引擎 priority 重排 → settings 保存。原 `let _ = save` 不传播失败，原 info/println 经 logger。
- `isOcrThinkingEnabled` 仅忽略大小写等于 true，不 trim；getOcrEngineType 缺省 Paddle 1.5。
  服务发布为 `ctx.llmOcrModels`，不注册尚缺图像处理原生接口的 OCR 命令。

## RAG 非流式翻译（rag_extension.rs:868–1004）

- 模型选择优先 translation_model_config_id，否则 model2 并 warn；不检查 enabled。
  解密密钥后复用 translation-core prompt（空 session、无 formality/glossary/domain）。
- 请求 system/user 两条消息，temperature=0.3，max_tokens=min(configured, limit)，stream=false。
  使用 L01 provider adapter 和统一请求准备（自定义头/缓存/Go），不重试。
- HTTP 失败先读取 body（读取失败用空字符串）、完整 error 日志；401/403/429/5xx/其他
  分别映射 Rust 用户文案；响应读取/JSON 解析失败保留各步骤上下文。归一化后只接受 string content。
- 起止 info 的长度为 UTF-8 字节数；不写 usage/DB、不 emit、无取消入口。
- 发布 `llmRag.translateText(text, srcLang, tgtLang, customPrompt)`。
  Codex OAuth 与 single-shot 相同，仍缺 L01 prepare/send-with-single-refresh 端口。

## OCR 页面组装（exam_engine.rs:1233–1479）

- 发布 `llmOcrRegions.parse(content, imageBytes, imagePath, pageIndex, engineOverride)`；
  文件读取由调用方完成，尺寸经 F7 nativeImage.dimensions（image 同源 wasm）读取。
  engineOverride 缺省时读取 llmOcrModels.getOcrEngineType。
- adapter 使用 Grounding；有有效坐标优先返回 cards，归一化坐标优先于像素坐标，
  每坐标 clamp 0..1 后 f32，丢弃非正宽高。标签 trim 为空时用区域{原始索引}。
- adapter 成功但无坐标：markdown_text（即使空串）优先，否则 content；trim 后 UTF-8 长度
  >10 才生成 fp_p{page}_r0 全页卡片。adapter 失败才调用旧 DeepSeek parser，保留 ds_ 前缀、
  metadata=null、旧投影不 clamp 的行为。没有 spans 时回退全文。
- deepseek_ocr_log 保留 level/stage/page_index/message/data（None→null）；发送失败 error 日志；
  调试日志同时经 logger。无 DB/时间/随机 ID；所有卡片 ID 按原始索引构造。

## 已准备 OCR 请求的对冲执行（exam_engine.rs:127–305、1063–1208）

- `llmOcrHedge.runPrepared` 接受已经完成图片准备/密钥解密/请求预校验的候选。
  空候选为配置错误，不计熔断失败；原始路径的准备步骤与 `ocr_extract_text` 尚待独立接入。
- 立即启动第一项，每 10s 添加下一项；已启动项全部失败则立即追加。任一成功即返回
  （远端成功空串也保留）；总失败记录一次熔断失败，取消只释放 HalfOpen 探针。
- 普通远端使用真正 single-shot 传输：0 次重试、头60s/idle45s/total300s/nonstream180s，
  外层总485s。Codex 走本地 future 集合，普通请求/原生 OCR 走结果队列，关闭队列不饿死 Codex。
- 原生 OCR 超时60s，空文本按 Rust 错误；成功不 trim 返回。赢家/失败/取消均 abort 未完请求，
  关闭真实响应流；保持 Spawned/hedging/winner/failed/succeeded 日志。

## 题目解析服务（mod.rs:3017–3130、8717–8867）

- 指定 model_config_id 时从所有配置按 ID 查找，不额外校验 enabled；缺失用
  `找不到指定的模型配置: {id}`。未指定则 getModel2Config，随后解密 API key。
- system prompt 固定题目解析助手；user 为原 prompt；temperature=0.3，输出预算仅由模型
  maxOutputTokens/maxTokensLimit 限制，applyReasoningConfig 后交 single-shot（长响应走流式）。
- `llmQuestionParsing.parse` 返回完整 content；`parseStreaming` 将每个增量送入原状态机，
  每完整 JSON 对象立即回调，回调 false 中止且该对象不加入结果。流中断 warn 后保留已解析题目，
  仅未 aborted 时 finalize；finalize 回调 false 只忽略该项，不提前停止其他项。
- 增量状态机允许数组外对象，忽略无法解析的完整对象，残缺对象不修复；跨 chunk 保留转义、
  字符串、brace_depth（有符号）状态。无 DB 写入、无事件、无 usage 记录。

## model-2 历史消息组装（model2_pipeline.rs:5350–5818、6109–6122）

- `llmModel2Messages.build` 接受 Rust snake_case 历史与已收集的注入片段，保留 system 的
  content-array/ephemeral cache_control；默认教学提示词与 LATEX_OUTPUT_BRIEF 一致。
- 连续工具调用按原合并规则组装，保留空 thinking_content、thought_signature 和 Responses
  reasoning item；遵循适配器自定义格式与 DeepSeek/ReasoningDetails 回传分支，各分支 debug 原样。
- user 优先 multimodal_content，其次 content+doc_attachments+image_base64；消息级图片不使用
  会话级回退、不重新压缩，旧 base64 格式检测保留只解码前100字节及失败→jpeg 的行为。
- 普通 assistant 保留 provider 要求的 thinking 与 replay items；tool 有 tool_result 才发送
  tool_call_id，否则降级 assistant。未知 role 按原分支忽略。输入结构不被改写。
- 连续 user 合并遵守隐藏技能/请求锚点屏障。注入每段 trim/最多1600字符，总20000字符，
  原算法无分隔符拼接；只写最后真实 user 的 escaped injected_context，不写 system。
- 这是统一请求中的消息组装单元；完整网络建立、stream hooks、工具执行、usage 仍由后续单元接入。

## model-2 provider 请求与缓存诊断（model2_pipeline.rs:4128–4580、6202–6267）

- `llmProviderRequests.prepareModel2` 对最终 OpenAI-shaped body 进行 L01 协议转换，按 streamEvent
  推导 session / agent scope，无 scope 时 messageId→chat_stream；返回真实请求和终止标记要求。
- 调用方传入原 cache_debug_enabled 的结果，仅启用时对 **post-adapter** body 记录诊断。
  此开关由原管线决定，不修改请求体；Codex 仍依赖 L01 已记录的 OAuth 准备端口。
- scope=session::variant（无 variant 为 -），非 chat_v2 直接事件名；跨 run 保留快照。
  首次 baseline、全同 none、否则前缀顺序首个变化段。新 scope 且已有256项时清空后插入。
- 两条 info 日志保留段哈希/字符数、历史首尾锚点、tools 增量前8名、roles排序和首条变化消息；
  哈希为 Rust 原有诊断行为，不用于业务判定。生成后缀按 u64 校验，大整数不经过有损 Number 转换。

## model-2 流事件收集（model2_pipeline.rs:6794–7111、7217–7279）

- `llmStreamEvents` 发布 manager 作用域的 owner-aware hooks 注册表和每次请求独立的 collector。
  dispatch 接收 L01 一个 SSE block 的事件列表；内容/思考有 hook 时不直接 emit，usage/web_search
  同时走 hook 与兼容事件。每次事件重新查 hook，旧 owner 不能删除 replacement。
- index 工具片段保留原 i64→i32 转换、id重置/unknown补名/无id但有name的synthetic id分支；
  首片只发start，后续arguments发delta；非字符串JSON参数按原规则序列化并warn。
- Done 聚合待完成调用并结束当前block；SafetyBlocked写终止失败且发safety/provider错误事件，
  其后同block事件仍遵守原循环。EOF fallback由调用者在终止验证后显式调用finishPending。
- 空/空白参数为{}；作者工具截断不修复；解析失败生成_truncation_error标记，字数保留UTF-8长度。
  所有原warn/error/info日志保留，stdout简洁进度通过插件logger记录。完整EOF/取消/usage落库外层仍待接入。

## MCP 前端桥广告（mod.rs:7989–8285）

- 缓存TTL取无trim u64设置，默认300000ms；缓存命中只在非空且elapsed<=原缓存TTL，空列表总是重取。
  headless即使已有缓存也不读MCP；selected优先于advertise_all/白名单，黑名单最后覆盖。
- UUID v4 correlationId，先Window监听mcp-bridge-tools-response:{id}再广播请求；最多15s，收到首个
  JSON值后清监听；tools反序列化失败整体空列表，input_schema默认null、description默认null。
- 桥失败warn然后缓存空列表；clear缓存后info。原emit失败在timeout/unlisten之前返回，存在监听遗留，
  此Rust行为保留，不能在迁移中悄悄改成finally清理。
- F1 BackendEvents.listenWindow 已进入main并提供定向过滤/disposer；`llmMcpTools` 实际provide，
  生产服务集成测试通过真实前端事件验证错误窗口被忽略、正确响应清理监听、缓存复用。

## Anki 槽位探测与角色决策（审查 L02-08）

`llmAnkiRouting.probeAnkiRoutingSlots/resolveAnkiRoleDecision` 对应 mod.rs:7734–7749 与
model2_pipeline.rs:8616–8624。先读模型分配，再读配置；任一步失败按原 debug 文案返回空槽位，
不额外写配置或发网络请求。解析后调用既有 buildSlots/planRouting/logDebugPlan/planDecision，
返回单角色决策副本；无可用槽位返回null。该服务在index.ts实际provide，原23个纯函数测试
之外新增生产服务集成测试。路由后的raw prompt完整请求/usage路径仍是独立剩余项。

## 审查 L02-06 日志补齐

- routing.rs:559：损坏Failover JSON回默认前warn，缺失/纯Rust空白仍不warn。
- commands.rs:2154–2169：保存配置请求入口、数量/ID/名称、成功info与失败error恢复；
  错误仍经同一CommandError映射原样传播。
- mod.rs:6431：模型条目关联的供应商缺失时warn再跳过，继续解析其余条目。

## 审查 L02-05 存储字段校验

ModelAssignments 的已知字段仅接受string/null/缺失，未知字段忽略。Vendor/Profile 区分
Option(null合法)与serde(default)(仅缺失使用默认，null或错误类型报错)，Vec<String>/headers
不丢弃错误元素；数值按u32/i32/u64/f32字段种类校验，contextWindow/context_window同时出现
是duplicate field。对应mod.rs:3554–3707、7881–7887，错误继续经ConfigError→Configuration传播。
原始JSON语法错误的V8/serde诊断文字与u64大值内部表示仍需共享codec/契约精度接口，不能据此
把L02-05整项声明为完成。

## 审查 L02-04 预算命令与F3单一实现

删除本lane `injection_budget.ts` 算法副本，默认值/newItem/分配/summary经公开
`ctx.injectionBudget`；L02只保留commands.rs:6913–6995入参、存储解码与wire转换。
BudgetConfig要求全部6字段；type_limits与priority_weights验证Rust枚举键，
priority输出还原Critical/High/Medium/Low/Optional，Map输出对象，DateTime serde输出UTC Z。
命令不接受learner_profile（配置类型仍可包含LearnerProfile）；错误上下文统一
Failed to load/parse injection budget config，再加两个命令各自中文前缀。
F3目前尚缺fromDatabaseConfig的完整serde诊断/usize精度与原分配日志，见BLOCKERS；
当前显式结构校验不代表这些共享语义已闭合。

## Codex 活跃认证接线（审查 L02-01）

L01已在main发布llmCodexAuth。ConfigStore不再读取/解析凭据JSON，生产deps调用同一
ctx.llmCodexAuth.status().hasUsableSession，登录/注销即时可见。single-shot的Codex请求
经prepareRequest和sendStreamWithSingleRefresh/sendWithSingleRefresh，传入L02权威协议、
session、key override与错误上下文；响应仍经原single-shot解析，取消信号组合到底层fetch，
保留401仅一次刷新及非流SSE桥由L01实现。其他旧调用面逐项接入，不以此宣称全部Codex已完成。

## raw prompt请求整改（审查 L02-03）

移除Anthropic/Gemini/Responses手写提前返回请求；先统一content-parts、reasoning验证/配置、
generation参数与max_total_tokens，再经L01实际adapter/prepare转换。HTTP保留JSON-only Accept、
identity编码、非Go浏览器身份与Origin/Referer；错误体脱敏，context-window附稳定码。
归一化失败与JSON解析失败同属establish重试，重试warn保留；usage接缝仍等待F3并保持未完成声明。

## 作文批改服务（L15 消费）

`essayGrading@1` 在 `llm/index.ts` 等待 `vfsDatabase`、`vfs.repo.core@1`、
`llmAdapters` 后提供；接口与 review 命令消费方一致。会话、轮次持久化经
`ctx['vfs.repo.core@1'].essays`，适配器经 `ctx.llmAdapters`；自定义模式使用
`custom_grading_modes.json`。管线保留流会话互斥、请求重试、90 秒空闲超时、
取消后禁止保存、评分解析、落库后完成事件，以及 error 事件与 invoke reject 双通道。
`pipeline.rs` 的 24 个测试和 `text_stats.rs` 的 13 个测试复用已有移植，新增生产
服务 → review 命令 → 真正 VFS 仓储集成测试。

未接入的外部能力：L01 Codex OAuth 请求/刷新接口。
F4 GLM/Qwen `create_model_wrap_token_filter` 已发布并接入作文流式content出口；
Done/Incomplete在返回前flush，取消/错误不flush，过滤后的文本同时供事件与score落库解析。

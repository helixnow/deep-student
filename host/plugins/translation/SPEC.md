# L02-llm-manager 行为规格（`host/plugins/translation/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 6 个 · 发出事件 7 种 · 契约：`contracts/ipc/L02-llm-manager.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

### R1-TR-03 / X6-SW-0092–0094：L02 调用点接缝

与U2只读方案4eb41c761 §16.7对齐：本lane只改tool_executor.ts调用点与自己的测试，repository/translations.ts留给获授权后的独立存储单元。`TranslationToolContext`逐调用携带L11真实translations实例；persist helpers首参显式接owner，create调用已公开createTranslationInFolder(conn,params,folderId??null)，metadata调用待L11发布的updateTranslationMetadata(conn,id,JsonValue)，无模块全局binder/本地SQL回落。

Rust translation_executor.rs:1313–1458：L11 `VfsRepositoryError(VFS_NOT_FOUND,{resourceType:'Folder',id})`必须映射原FOLDER_NOT_FOUND、原hint、retryable=false，其他错误保持TRANSLATION_SAVE_FAILED可重试；缺VFS/owner在取连接和写入前DEPENDENCY_UNAVAILABLE。保存成功后消费缓存，metadata失败仍返回已保存结果/metadata_persisted=false并warn1416；watch仍发生在metadata尝试之后。owner返回省略的title/updatedAt在工具json输出处恢复null（原json! Option），不改变owner的实体serde表示。

此接缝与公开toolExecutor.save消费者测试不代表中央save caller已完成接线；L11 metadata方法当前main/候选均未发布，测试只能对该外部端口提供明确夹具，相关原保存TESTMAP继续pending至真实owner组合。禁止以新增Context字段单独关闭R1-TR-03/07。

检查：`20261104135047-1f6b90` Node两文件23 passed/exit0；`20261104135047-f5897e` typecheck exit0；`20261104135621-1355db` Electron同两文件23 passed/exit0，均无Errors。原save_repo测试所有字段/metadata/缺行/缺Folder断言保留，创建和读取改走真实L11，metadata端口明确标夹具且TESTMAP保持pending；新增同一executor双Host owner隔离、cache claim释放、消费后metadata失败及warn顺序断言。本单元未改预留repository文件。

### 验收问题处理：R1-TR-01 / R1-TR-02

依据 R1 `bf6479dc8`（报告只读）：`pipeline.rs:754–755,908–932` 使用同一个真实 provider adapter，只消费 ContentChunk/Done/SafetyBlocked，Gemini thought 不作正文；`:767–887` 仅建立阶段重试，`:974` 读取失败直接传播，所有退出`:1032`清通道。按原顺序建立一次取消订阅，取消退避等待立即结束；读取在重试循环之外，失败/取消均释放 reader/socket。SSE 统一用 F4，不再在 translation 实现第四份 buffer。

源码语义歧义（原行为保留，待R1确认）：`:909–910` 在 provider parser 前对原始 `[DONE]` 直接返回 true；`:996–1003` 仅 flush SSE，不调用 adapter.finish_stream。因此 DeepSeek length + EOF 为 Incomplete；length + `[DONE]` 原Rust翻译仍Completed，虽然直接调用L01 parser的终止事件是SafetyBlocked。不能用后者替代前者的实际调用顺序。回归用例分别验证两种输入；不修改Rust。

原TS额外协议测试曾错误断言Chat finish_reason立即Done、OpenAI错误帧只Safety而无Done、Gemini STOP立即Done。按真实L01与Rust providers源码改成精确事件序列，并保留DONE终止断言；成功命令夹具补真实DONE，新增length+EOF失败向量防止掩盖不完整流。未改任何Rust命名的请求预算/分段/策略断言。

R1-TR-05：生产translation注入新公开 `llmHttp.fetch`，复用LLMManager代理/重定向/默认300s客户端超时；只有原Codex路径覆盖为min(totalTimeout,300s)。流总时长/空闲用performance.now单调时钟，created_at仍由独立UTC时间源生成。R1-TR-06：events.rs:56–57、candidates.rs:67–70、chat_popover.rs:198–201通知失败各自warn后继续；两个start info恢复。测试从公开命令注入事件投递故障，成功返回不可变成拒绝。

R1-TR-03仍未闭合：L11公开TranslationRepository已有createTranslationInFolder(conn,...)，但缺原executor `persist_translation_metadata` 对应的owner同连接方法。需要 `persistTranslationMetadataWithConn(conn,id,metadata)`（原SQL在translation_executor.rs:1293–1311）。不能用独立连接补写或省略metadata保存，也不能据现有repo副本通过单元测试签收。

验证记录：`20261104115038-edb397` 初次接共享parser：6 failed / 22 passed / exit1（旧额外测试与缺DONE成功夹具，见上方依据）；`20261104115557-9dccc3` 1 failed / 29 passed / exit1（旧Gemini错误载荷期待safety_error，实际Rust gemini-openai-converter.rs:1163为prompt_blocked且保留details）；修正精确向量后 `20261104115934-4efe36` 83 files / 904 tests passed / exit0，无Errors。类型检查`20261104115934-cb2200` exit0；两插件importable exit0。正式复验与main接线签收仍归R1/C1。

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省：`translation_stream_*` 事件中 `detected_lang/segment_index/segment_total` 仅在存在时输出（engine.ts emitChunk/complete），与 wire.rs `skip_serializing_if` 一致；`TranslationCandidatesResponse.detected_lang` 显式 null。
- [x] u64/i64 超过 2^53 的表示：`char_count/word_count` 源于 100000 字符上限，Number 安全整数足够（engine.rs:27-55）。
- [x] 字段顺序：TS 对象按插入序输出；事件字段顺序不作为前后端契约，ledger 不做序列化后比对。
- [x] f32 精度：温度 0.2/0.3/0.5/0.7 以双精度表示并按 JSON 数值字面量发送，与 Rust f32 输出的十进制一致（pipeline.rs:100-106）。
- [x] 错误形状：命令错误统一 `throw new CommandError(AppError.*)`；事件错误保留 `message/code/retriable`（engine.ts、transport.ts）。
- [x] 取消：每个流事件名一个 `AbortController` + 一次性 pending 集合，`consumePendingCancel` 在分段间隙履行（control.ts、engine.ts、pipeline.rs:838-861）。
- [x] 并发：多候选用 `Promise.all` 对应 `join_all`，候选事件按 candidate_index 分桶互不干扰（candidates.rs:120-230）。
- [x] 时间与 ID：`session_id/request_id` 由前端提供；`created_at` 用 UTC RFC3339 并输出 `+00:00`（毫秒精度为 Node 限制，Rust chrono 可能输出 0/3/6/9 位小数）。
- [x] HashMap：本 lane 不做含 HashMap 结构的序列化后比对；候选/事件均为固定字段。

## 命令 `cancel_translation_candidates`

<!-- BEGIN GENERATED:cmd:cancel_translation_candidates -->
- Rust：`src-tauri/src/translation/candidates.rs:33` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：sessionId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:cancel_translation_candidates -->

- [x] 输入：`sessionId` 原样使用，不 trim；对 `translation_candidates_{sessionId}__c0..2` 广播取消（candidates.rs:333-355）。
- [x] 输出：恒为 `true`。
- [x] 错误：无业务错误分支。
- [x] 事件：不 emit，只通知取消通道。
- [x] DB 读写：无。
- [x] 取消/并发：`requestCancelStream` 先 abort 当前通道，再写入一次性 pending 标记。
- [x] 时间/ID：不生成。

## 命令 `ocr_extract_text`

<!-- BEGIN GENERATED:cmd:ocr_extract_text -->
- Rust：`src-tauri/src/cmd/translation.rs:90` · async
- 前端：app（1 处，例 `src/utils/testApi.ts:142`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：imagePath?: string | null, imageBase64?: string | null
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:ocr_extract_text -->

- [x] 输入：path/base64 都是 None 时 Validation；base64（包括空串）优先于path；先建立temp目录再解码；粗判与解码后均20MiB上限（translation.rs:44–113）。
- [x] 输出：FreeOCR fallback 文本原样返回（:121–127）。
- [x] 错误：Validation文案按源码；IO→FileSystem `文件系统错误: {io::Error}`；底层OCR错误原样传播。base64需要F4的base64 0.22 STANDARD解码器，已删除本lane宽松Buffer替代实现。
- [x] 事件：命令本身不emit、无日志。
- [x] DB 读写：不写DB；base64文件位于get_writable_app_data_dir()/temp，UUID v4文件名；写成功后建立guard，OCR成功/失败均删除，删除错误按Rust Drop静默忽略；path输入不删除（:100–125）。
- [x] 取消/并发：命令不监听窗口取消，等待底层OCR；独立临时文件不共享。
- [x] 时间/ID：ocr_temp_{uuidv4}.{extension}；签名优先于声明MIME，未知png（:19–84、105）。
- [x] 生产接线：69fbbb8ee已在index声明/注册ocr_extract_text，公开translation.ocrExtractText调用同一实现；F4 util/api的decodeBase64Standard→临时文件→llmOcrPages.callOcrFreeTextWithFallback→候选/单探针/对冲/真实adapter。`ocr_command.test.ts`通过kernel invoke测试，失败/成功均清理临时文件，已有路径不删除；大图实际调用F7 resizeTriangleJpeg(1600,1600,85)，不自编编码器。D5/C像素等价与跨平台仍独立待验。

2026-11-05 OCR入口验证：实现由并发写者提交69fbbb8ee，测试6029c2ac3/70278cd4e；采用其正式llmOcrPages合同后，20261104154626-f3d816为5 passed/exit0，无Errors。此前152209-7d12fd的4失败与typecheck152209-ffc195 exit2来自中间态旧llmFileOcr名称，已对齐；不是改业务断言过门禁。F7原始能力探针153912-5152aa同样exit0，1,500,001字节PNG→613字节JPEG→实际尺寸1×1。

额外按exam_engine.rs:358–359,932–935核对：文件读取Err的Display须经现有F4 ioMessage保留Rust上下文，不能直接输出Node带路径的ENOENT串。新增公开命令missing-file向量；生产只修读取试卷图片失败及System OCR原图read warn这两处，其他页面OCR逻辑未扩改。

回归证据：20261104161000-bb0d5c为missing-file红例（exit1，实际错误混入Node的open路径）；20261104162840-ba6ff1为修复后完整六项生产入口测试（6 passed，exit0）。

## 命令 `stream_chat_translation_aligned`

<!-- BEGIN GENERATED:cmd:stream_chat_translation_aligned -->
- Rust：`src-tauri/src/translation/chat_popover.rs:16` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：request: ChatTranslationRequest
  - 结果：null · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:stream_chat_translation_aligned -->

- [x] 输入：`request_id/source/src_lang/tgt_lang/context_before/context_after`；request_id 非空、source ≤8000、上下文截断 200 字符（chat_popover.rs:79-89、231-252）。
- [x] 输出：`null`。
- [x] 错误：空结果/不完整/传输错误 emit error 后 `AppError.llm`（chat_popover.rs:300-340）。
- [x] 事件：`chat_translation_{request_id}` 的 chunk/complete/error/cancelled；chunk 只带 delta（chat_popover.rs:54-72）。
- [x] DB 读写：无。
- [x] 取消/并发：通用 `cancel_stream` 传同一事件名；空闲 30s、总 120s、最多 2 次尝试（chat_popover.rs:74-96）。
- [x] 时间/ID：request_id 由前端生成；不生成 created_at。

## 命令 `stream_chat_translation_plain`

<!-- BEGIN GENERATED:cmd:stream_chat_translation_plain -->
- Rust：`src-tauri/src/translation/chat_popover.rs:26` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：request: ChatTranslationRequest
  - 结果：null · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:stream_chat_translation_plain -->

- [x] 输入：同 aligned，prompt 为纯译文单栏模式（chat_popover.rs:158-185）。
- [x] 输出：`null`。
- [x] 错误/事件/DB/取消/时间：与 aligned 相同，仅 system prompt 不同（chat_popover.rs:26-33、300-340）。

## 命令 `translate_text_candidates`

<!-- BEGIN GENERATED:cmd:translate_text_candidates -->
- Rust：`src-tauri/src/translation/candidates.rs:21` · async
- 前端：none
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：request: TranslationRequest, numCandidates?: integer(u32) | null
  - 结果：TranslationCandidatesResponse · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:translate_text_candidates -->

- [x] 输入：session_id 非空、text 非空且 ≤8000 字符；`numCandidates` 默认 2、clamp 1..3（candidates.rs:22-47）。
- [x] 输出：`{session_id, candidates, detected_lang, cancelled, created_at}`；失败候选 `text=''`、`error=message`（candidates.rs:280-330）。
- [x] 错误：模型/密钥失败分别 emit `model_not_configured` / `api_key_error` 后 `AppError.llm`；全部候选失败 emit error 后 `AppError.llm`（candidates.rs:96-118、300-318）。
- [x] 事件：`translation_candidates_{session}` 的 candidate_data/candidate_complete/candidate_error/complete/cancelled/error。
- [x] DB 读写：无。
- [x] 取消/并发：候选并发；任一候选 cancelled 则整体 cancelled；每候选独立 `__c{index}` 事件名（candidates.rs:120-230）。
- [x] 时间/ID：`created_at` UTC RFC3339；session_id 来自请求。

## 命令 `translate_text_stream`

<!-- BEGIN GENERATED:cmd:translate_text_stream -->
- Rust：`src-tauri/src/translation/mod.rs:35` · async
- 前端：app（1 处，例 `src/translation/useTranslationStream.ts:399`）
- 契约：`contracts/ipc/L02-llm-manager.json`
  - 参数：request: TranslationRequest
  - 结果：TranslationResponse | null · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:translate_text_stream -->

- [x] 输入：`request.text/src_lang/tgt_lang/session_id/prompt_override/formality/domain/glossary`；空文本、>100000 字符直接失败（engine.rs:88-96）。
- [x] 输出：完成时 `{id: session_id, translated_text, created_at, session_id}`；取消时 `null`（engine.rs:201-215）。
- [x] 错误：结构化 `StreamFailure` 先 emit error 再以 `AppError.llm(message)` 拒绝（pipeline.rs:165-180）。
- [x] 事件：`translation_stream_{session_id}` 的 `data/complete/error/cancelled`；cleanup 在 error 之前（engine.rs:63-77）。
- [x] DB 读写：不写数据库；持久化由前端 DSTU 适配器负责（engine.rs:210）。
- [x] 取消/并发：进入时消费 pending；分段间隙检查；流内 cancel 返回 cancelled；总超时 600s（engine.rs:103-120）。
- [x] 时间/ID：`created_at` 为 UTC RFC3339；id/session_id 用前端值。

## 事件 `event`

<!-- BEGIN GENERATED:event:expr:event -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-tutor/src/translation/candidates.rs:69`（emit）
- 发送点：`src-tauri/crates/dstu-tutor/src/translation/chat_popover.rs:199`（emit）
<!-- END GENERATED:event:expr:event -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `Self::event_name(session_id)`

<!-- BEGIN GENERATED:event:expr:Self::event_name(session_id) -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-tutor/src/translation/events.rs:56`（emit）
- 发送点：`src-tauri/crates/dstu-tutor/src/translation/events.rs:98`（emit）
- 发送点：`src-tauri/crates/dstu-tutor/src/translation/events.rs:120`（emit）
- 发送点：`src-tauri/crates/dstu-tutor/src/translation/events.rs:143`（emit）
- 发送点：`src-tauri/crates/dstu-tutor/src/translation/events.rs:154`（emit）
<!-- END GENERATED:event:expr:Self::event_name(session_id) -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `stats.event(chunk, lang, info)`

<!-- BEGIN GENERATED:event:expr:stats.event(chunk,lang,info) -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-translation-core/src/engine.rs:157`（emit）
<!-- END GENERATED:event:expr:stats.event(chunk,lang,info) -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `stats.event(segment.separator.clone(), None, info)`

<!-- BEGIN GENERATED:event:expr:stats.event(segment.separator.clone(),None,info) -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-translation-core/src/engine.rs:188`（emit）
<!-- END GENERATED:event:expr:stats.event(segment.separator.clone(),None,info) -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `TranslationEvent::Cancelled`

<!-- BEGIN GENERATED:event:expr:TranslationEvent::Cancelled -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-translation-core/src/engine.rs:117`（emit）
- 发送点：`src-tauri/crates/dstu-translation-core/src/engine.rs:163`（emit）
<!-- END GENERATED:event:expr:TranslationEvent::Cancelled -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `TranslationEvent::Complete { id: request.session_id.clone(), translated_text: text.clone(), created_at: created_at.clone(), detected_lang: detected, }`

<!-- BEGIN GENERATED:event:expr:TranslationEvent::Complete{id:request.session_id.clone(),translated_text:text.clone(),created_at:created_at.clone(),detected_lang:detected,} -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-translation-core/src/engine.rs:204`（emit）
<!-- END GENERATED:event:expr:TranslationEvent::Complete{id:request.session_id.clone(),translated_text:text.clone(),created_at:created_at.clone(),detected_lang:detected,} -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `TranslationEvent::Error { message: f.message.clone(), code: f.code.clone(), retriable: f.retriable, }`

<!-- BEGIN GENERATED:event:expr:TranslationEvent::Error{message:f.message.clone(),code:f.code.clone(),retriable:f.retriable,} -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-translation-core/src/engine.rs:70`（emit）
<!-- END GENERATED:event:expr:TranslationEvent::Error{message:f.message.clone(),code:f.code.clone(),retriable:f.retriable,} -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：
# 平台格式化复用（2026-11-04）

翻译事件时间直接调用 F4 `toRfc3339()`；仓储时间直接调用
`toRfc3339Opts(nowEpochNanos(), 'Millis', true)`，保留 Rust 固定毫秒 + Z 的落库形状。
删除本地 `rfc3339Now`、`nowIso` 副本。

## L01/L02 统一请求准备

`buildTranslationRequestBody` 使用L02公开applyReasoningConfig；删除本地三协议手写请求分支，
API-key请求由L01真实adapter加L02 preparePlainProviderRequest构建。Codex经同一活跃
llmCodexAuth.prepareRequest/sendStreamWithSingleRefresh，传入streamEvent作为会话作用域，
超时min(totalTimeout,300000)，取消透传到底层fetch。原三条翻译调用面共用streamTranslate。

## GLM/Qwen 输出过滤（pipeline.rs:895–1023）

F4 `create_model_wrap_token_filter` 在每次成功HTTP响应后创建，按providerType/providerScope/model
选择策略。content经process后仅非空才回调；Completed与Incomplete均在终止检查后flush；
供应商错误优先于Done，错误/取消不释放尾部。主翻译、候选、popover共用此出口。

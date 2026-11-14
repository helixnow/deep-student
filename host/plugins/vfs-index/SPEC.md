# L12-vfs-index 行为规格（`host/plugins/vfs-index/`）

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 3 个 · 发出事件 7 种 · 契约：`contracts/ipc/L12-vfs-index.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

### WP-222 · D33 by-source 消费 AttachmentPreview

`multimodal_service.rs:1378` 的类型是 L01 `page_indexer.rs:17-50` 的
AttachmentPreview，不是本 lane 的 PdfPreviewJson。main `029292123` 的 L01
`api.ts:81` 已公开 `parseAttachmentPreviewJson(text): AttachmentPreview`，直接传业务表原文。

| Rust 分支 | 本包消费落点（src/multimodal-service.ts:indexResourceBySource） |
|---|---|
| :1376-1379 | 公开文本 parser；仅从 Error.cause 的公开 JsonSyntaxError 取原 message，加 `Failed to parse preview_json: `；保 code/line/column，不取 L01 的附加上下文。解码失败在任何业务 mm 状态/Unit/Segment/Lance 写之前。 |
| page_indexer.rs:17-50 | map 必填 pages/page_index；其余 Option 缺省/null。snake/camel alias 共槽，重复拒绝；preview sequence 至少 pages，page sequence 至少 page_index/blob_hash（后四项 default）。全部解码归 L01。 |
| :1383-1404 | blob_hash 只有 None 跳过，Some(空串)进入原索引链；mime_type 只有 None 默认 image/png，空串保留。page_index bigint 精确截低32位到 i32；compressed_blob_hash 此处不替代原 blob_hash。 |
| :1405-1448 | 无 preview 的 image 原图 fallback、成功 INFO/缺 blob WARN，以及非 image 缺 preview WARN 保持。 |
| :1457-1499 | 空页清旧索引→disabled/零结果；非空页业务 indexing→真实索引链→indexed/failed，原日志与副作用顺序保持。 |

测试增量放在 `tests/lance-store.test.ts`，复用既有 MemoryConnection 向量叶边界和
外部 embedding 输入夹具，调用真实 `host.ctx.vfsIndex.multimodal.indexResourceBySource`。
实际执行 L12 parser 消费/页转换/索引/Lance store 与 L11 的 SQLite 资源、业务表、Unit、
Segment 写链；不替换这些被测方法。校验最小/snake/camel/sequence/Option/空串、完整
usize→i32、首错/位置/零写以及原 fallback 日志。原大整数与 PdfPreviewJson 测试保留。
本节是生产入口测试+源码审读范围，不提升009全域独验或其他多模态输送/所有权资格。

### WP-205 · R3 N1 续修（消费 WP-204）

前置已核：main `a3bcecd4e` 第二父为 `ac734a62b`，`media/api.ts:11` 直接重导出
生产 `MediaError`；正常 merge 后消费，不复制 payload serializer。

| Rust pdf_processing_service.rs | 本包目标落点与分支 |
|---|---|
| :983-997 | `pdf-runtime.ts:runMedia` 在每条已消费 progress 回调前保存原始 stage，初值 queued；L18 同步回调在 promise settle 前已消费。 |
| :999-1007；transcriber_hook.rs:126-140 | 仅捕获公开 MediaError，cancelled 保 INFO、成功结束，无 error/completed 事件或状态写；其他异常继续原外层。 |
| :1008-1016 | WARN 使用 display，setError 使用原 toPayloadString() 与 processingStageFromString(current_stage)，仅当前 generation 可写。 |
| :1017-1030 | 二次写失败 ERROR `Failed to set media error status` 后仍 emit 原 payload、原 current_stage；以成功结束，不触发 completed/Pipeline failed。 |
| :799-805、:2862-2892 | 内层处理后保 outer Ok 的 Pipeline completed INFO；setError 写成功才记原 Debug stage ERROR，最后 progress 不变。 |

新增 `tests/media-failure-integration.test.ts` 安装真实 L18/L13/L11/L12/notes：缺 ASR
配置、真实 F7 WAV 解码→VAD→HTTP 401、SQLite trigger 拒绝 error 写、真实排队取消、
旧代配置失败隔离、非 MediaError 的真实 SQLite 异常。日志/事件/DB/返回按 RAW 行保全。
原 WP-192 全部 N2/N3、真实 PDF 外层与取消/drain/u64 断言保持；此处不改变旧映射资格。

### WP-192 · R3 N1–N3 媒体失败分支

源码为 `src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs`，审读输入为
`WP-C2-VERIFY-013.report.md`。本包只覆盖以下窄分支：

| Rust | TS 落点 / 行为 |
|---|---|
| :707-716 generation fetch_add 后遇 Occupied | `pdf-service.ts:startPipeline` 仍消耗 u64 generation，WARN `Pipeline already running for file: …` 后返回成功；不改状态、不再启动 transcriber。 |
| :724-735 写起始阶段后 `tokio::spawn` | `pdf-service.ts:startPipeline` 同步占用 running、写起始阶段、登记 task；`runTask` 推迟到下一个宏任务（`setTimeout(0)`）。调用方返回时流水线尚未推进，`media_transcript_import`（`dstu-media/src/media/commands.rs:470-478`）返回 `queued`/0%（`media/tests/transcript-import-change-log.test.ts`）。 |
| :2862-2892 set_error | `pdf-service.ts:setError` 仍由 L11 owner 写 status/error/completed_at，保留最后 progress；写成功后 ERROR 中 stage 使用 Rust Debug 变体名（如 OcrProcessing），事件仍 snake_case。 |
| :799-848 外层 Err | `pdf-service.ts:runTask` 保留 ERROR `Pipeline failed`、初始阶段；set_error 失败再 ERROR `Failed to set error status`，仍发原错误，新旧 PDF 事件都发。测试以真实 PDF runtime 最终状态写入触发器制造该错误。 |
| :983-1030 内层转写失败 | **N1 阻塞待消费 L18 公开错误面**。应跟踪 current_stage；cancelled 为 Ok；其余 WARN display，再 set_error(payload)、emit_error(payload,current_stage) 并返回 Ok，不能再发 completed。当前 runMedia 仍直接 await 并传播至外层。 |

N1 所需原错误映射在 `dstu-media/src/media/transcriber_hook.rs:126-140`：cancelled
payload 为空，其余 payload 为 `MediaError.to_payload_string()`。main `media/api.ts`
未导出对应 TS `MediaError`（实现 `media/src/errors.ts:9-21`），请求见
`WP-192-dependency.md`。不复制序列化器、不从 Error.message 猜 JSON。
Rust :1017 的二次 set_error 失败日志为 **ERROR**，转写失败 :1010 才为 WARN。
本节为源码分支表；动态回执另记报告，不宣称全域 accepted/B 或 Rust 实录。

### R12-01/06 Lance-disabled索引分支

Rust indexing.rs:4452-4455在Lance未编译时先返回(0,0)，不能drain孤儿队列或claim资源。
单资源入口:2393只在Lance可用时mark_indexing；:2477-2500仍保留初始Unit同步/OCR恢复，
成功恢复OCR后再次同步文本账本，然后在chunk/embedding前返回(0,0)，不把资源标failed。
接线使用已有lanceLifecycle.enabled，不增加用户配置开关；每次调用取当前提供方状态，
不能把启动时的false永久缓存。独立构造的原生store默认代表Lance-enabled构建。

生产插件回归验证无vector时claim未调用、孤儿意图未删除、资源保持pending；安装真实F7
provider后下一轮恢复cleanup/claim。另验证单资源无Lance仍创建可检索的文本Unit且不需要
embedding配置。batch原成功断言保留，补Rust:4475-4478/4496-4499/4532-4535的INFO顺序。

PDF OCR补充回归走真实VfsOcrRecovery/Unit builder/L11存储，仅外部L02提供识别文本；
断言初始同步后OCR写入，再次真实syncUnits使文本进入pending Unit，整个入口返回(0,0)
且没有Segment。现有withTimestamp owner缓存的时间表示缺口仍见B12-03，不借此签收。
OCR尝试/成功（UTF-8字节长度）/无内容/失败及Lance-less文本刷新日志按:2446-2498补齐。

按Rust每轮稳定的feature条件，已claim批次中的资源沿用该轮enabled决定；单资源调用
则各自取一次当前状态。L02 owner-error回归须处于Lance-enabled分支，因此夹具增真实
vector provider，原三条错误/无Segment断言不改，不能靠错误的disabled路径继续求绿。
底层禁用写入的Error仍保持InvalidState：lance_store_stub.rs:31-35与error.rs:235-236
要求`INVALID_STATE: `前缀；原三项失败文案断言保留，额外校验完整code/message。

### R12-06 primary元数据失败后的恢复/清理错误优先级

Rust indexing.rs:2846-2901：元数据savepoint失败后，Unit批量pending/failed标记写入失败
只WARN（即使retryable时文案仍写failed）；接着ERROR记录原metadata错误，然后尝试
discard_uncommitted_rows。清理失败用ERROR记录；普通错误则将“原错误; rollback failed:
清理错误”写入资源failed并返回VfsError::Other，InvalidState则不替换原错误，资源pending
后返回原InvalidState。清理成功时资源failed/pending后返回原sync_err。资源状态setter的
失败仍按?传播，不能把所有恢复错误统一吞掉。无新SQL/事务/事件或重试。

回归从生产VfsFullIndexingService.indexResource进入：普通错误由真实L11 Segment INSERT
触发器产生，重试冲突由L11 profile依赖故障接缝注入；真实SQLite触发器拒绝恢复标记，
Lance依赖记录discard并可拒绝。四组合断言原错误身份/合并错误code与文案、Unit/Segment
回滚、资源调度状态以及WARN→ERROR→清理ERROR顺序；不修改已核additional分支测试。

### R12-06 primary/additional元数据状态写的不同错误策略

Rust indexing.rs:2745-2764：primary先set_index_profile（失败传播），随后将text_state写为
indexing/清error/设置dimension；这一条SQL失败仅warn，继续同savepoint里的Segment替换和
最终indexed状态写入。additional对应:3124-3140的同一条状态SQL则使用?，失败回滚该Unit
metadata、discard本次向量，再按:3190-3222写failed并继续后续Unit（InvalidState仍另走
pending/传播）。不能将两个分支统一成fail-fast，也不能全局吞状态写失败。

shared syncSegmentMetadata增加明确的primary/additional调用角色，只有primary捕获该条
状态更新；profile、Segment、最终indexed等其它错误仍原样传播。primary维度范围WARN
补回:2716-2719，additional不增加原本没有的该日志。无新SQL、事务、事件或API。
新增生产VfsFullIndexingService.indexResource回归用真实L11/SQLite触发器分别拒绝primary/additional的
indexing状态，断言primary继续提交与WARN、additional回滚/丢弃/failed及later继续；
原R3已核的additional向量失败测试不改。

### R12-08 PdfPreviewJson精确读取与回写

Rust types.rs:2849-2897：preview必填pages/renderDpi(u32)/totalPages(usize)/renderedAt，
isTruncated缺省false、maxRenderedPages(usize)缺省0；page必填pageIndex(usize)、blobHash、
width/height(u32)、mimeType，compressedBlobHash为Option且None不序列化。无snake别名，
未知字段忽略；已知重复字段（即使前值null）拒绝。serde struct序列按声明顺序读取，preview
最少4项、最多6项，page序列必须6项（末尾Option无serde default）；类型/词法/溢出失败
按原调用点回到None，不能保留半条数据。usize保留number|bigint，u32可精确number。

生产落点：pdf-runtime压缩前读preview、压缩后经files owner写回；OCR结果页码保全精度并
按数值排序，索引OCR回写相同。multimodal_service.rs:1395明确usize as i32，但其输入类型
为 AttachmentPreview，现由 WP-222 单独消费 L01 parser；截低32位而非提前Number舍入。
无新日志/事件/事务；保既有调用方失败策略与owner写顺序。
测试先覆盖纯解码词法/重复/数组及真实插件压缩回写的2^53+1/u64::MAX；不改原PDF wire断言。

读取与序列化集中在本lane `src/pdf-preview.ts`，pdf-runtime原导出保持可用。既有preview
解析失败仍为null；初建preview按Rust repos/pdf_preview.rs:263-269总是写isTruncated与
maxRenderedPages=config.max_pages，不能省略未截断时的配置值。既有运行时测试仅补强此
断言，原断言保留。额外生产消费回归覆盖PDF OCR、索引OCR的高页码排序/精确持久化，以及
multimodal source→Unit/Lance的usize as i32截断；不拿格式helper单测代替这些调用链。

**未知字段精确IgnoredAny已在正式固定联合树闭合**。main F4 skipValue 是 Value 解码，
和 Rust serde_json de.rs::ignore_value 的词法跳过多不同：未知 1e400 应跳过。本 lane
`src/pdf-preview.ts`/`src/pdf-processing.ts` 已消费 F4 公开 `skipIgnoredValue`
（5615f2e3e），固定树含 F4 `30747990c` 后全 lane 286/286、preview+wire 17/17 通过，
原成功预期回归保留。R3 已确认 snapshot 最短期望正确；唯一补测在
`pdf-status-boundary.test.ts` 用生产 `parseProcessingProgress` 保留三条 raw f32 断言并
验证 1e40 内部 Infinity（snapshot null 仍由原 wire assert 覆盖），防止后续 helper 以
`Math.fround` 掩盖 parser 未窄化。该证据不代替正常 main 集成，也不据其余已知字段/
精度测试签收整个 preview 或 R12-08；详见 B12-15/BLOCKERS。

大页码OCR回写夹具使用无resource_id的历史文件，仍走公开pdf.startPipeline和真实files
owner写回。原因：Rust ocr_utils.rs:154-157按page_index+1扩展稠密Vec；若再进入资源索引，
2^53页索引本就要求无法分配的容器。首次夹具带resource触发该后续路径超时，修正输入以
单独验证OCR持久化，不缩小页码、不改raw数值/排序断言，也不替原Rust修稠密数组行为。

### R12-02 L02 owner错误Display（R3 2026-11-05增量）

Rust embedding_service.rs:114-130先获取模型配置，失败加“获取嵌入模型配置失败: ”；
:138-148批后重读失败加“重新读取嵌入模型配置失败: ”；:169-176单次transport失败加
“生成嵌入向量失败: ”；:343-389批次失败保留400/800ms重试及warn，终止文案包含批次与
“已重试 3 次”。所有{e}均采用AppError Display，即models.rs:1038-1041只输出message。
L02真实模型解析返回CommandError(AppError)，不能取其Error.message中的envelope JSON。
L12仅在此错误文本消费点解开CommandError.value；不改L02类型/契约，不重新解析错误JSON。
真实L01/L02/L11/L12/notes/vfs组合回归覆盖首次配置、查询模型ID及批后重读的逐字错误，
并确认错误后没有Segment提交。远端embedding transport仍未发布；其现有同一message
消费点按同一规则修复，不以外部transport替身宣称整链等价。

### X6-UD-0090：搜索标题保留原文（2026-11-05）

Rust `indexing.rs:5014-5026` 仅用 `trim().is_empty()` 判断 metadata title 是否可用，
非空时返回原字符串，不裁剪。为空时依次回退源对象显示名、source_id、resource id；
此判断没有日志、事件或写库。`searchWithResourceInfo` 与
`searchCrossDimensionWithResourceInfo` 共用该富化步骤。公开插件服务回归用真实 SQLite
词法检索验证两入口的带空白标题、Rust White_Space 空标题以及 BOM 非空标题。
此子项不关闭 metadata 完整 typed 解码：L11 resource owner 仍未公开精确 decoder。

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [x] Option → null 还是缺省（`skip_serializing_if`）：`Option<T>` 参数缺省与 `null` 都按 `None` 处理（`commands.rs:2088-2093` 的 `older_than_days/delete_unverified/force`）；结果无 `Option` 字段的三个命令均返回 `null`/固定对象。TS 侧用 `?? null` / `?? true` 对齐（`host/plugins/vfs-index/index.ts`）。
- [x] u64/i64 超过 2^53 的表示：Tauri 以 JSON number 传递 `u64`/`i64`，JS 侧同样用 `number`；`clear_message_embeddings` 的 `messageIds` 是字符串，TS 用 `BigInt` 校验 i64 全范围并全程保留 `bigint`（解析、排序、去重、Lance 参数字符串、SQLite 绑定均不经 `Number`），因此超过 2^53 的 id 不会丢精度。`older_than_days` 不做额外范围检查。
- [x] 字段顺序（serde_json preserve_order）：Rust 结构体按声明顺序序列化；TS 返回对象按 `api.ts` 字段声明顺序构造。IPC 消费方不得依赖键顺序，测试用结构相等而非 JSON 字符串比对。
- [x] f32 精度：Lance 向量/距离为 f32，读入 JS 后是精确的 f64 扩展；RRF 在 Rust 用 `f64` 累加（`retrieval_planner.rs:835`），TS 的 JS number 也是 f64，公式与常量（K=60）逐字一致（`src/retrieval-planner.ts:162`）。BM25 同样以 f64 计算（`lexical_bm25.rs`）。
- [x] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：命令错误经 kernel `CommandError(AppError)` 输出稳定 code（如 `VFS_STORAGE`，`vfs/error.rs:104-123`）与文案；`clear_message_embeddings` 的 Lance 失败文案为 `清空向量失败: {err}`（`commands.rs:2072`），稳定 token 查询失败为 `AppError::database(e.to_string())`（`commands.rs:2043-2052`）。Rust 的 panic 会变成 kernel 内部错误；TS 对无 panic 的错误路径抛 `Error`/`CommandError`。**Rust panic 的精确等价**：`plan_retrieval` 先 `top_k.max(1)`，再调用 `.clamp(top_k, 500)`（`retrieval_planner.rs:507-510`），当 `top_k > 500` 时 `Ord::clamp` 以 `assertion failed: min <= max` panic；Host 中非 `CommandError` 异常等同 Rust panic（kernel 记录日志且不回复，前端 Promise 永不 settle），因此 TS 在 `topK > 500` 时抛 `RangeError('assertion failed: min <= max')`，不得转成 `CommandError`、不得 clamp 到 500。
- [x] 取消：CancellationToken / drop → AbortSignal，取消点一致：这三个命令在 Rust 均无 `CancellationToken`，TS 也不引入取消点。全 lane 唯一取消语义在 `compress_image_path`（读取前与编码后各检查一次，`pdf_processing_service.rs:464-491`），TS 用 `AbortSignal` 在相同两个点检查（`src/pdf-processing.ts`）。
- [x] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：`clear_message_embeddings`/`optimize_chat_embeddings_table` 每次调用新建短生命周期 store，Rust 以进程级 `KB_MUTATION_LOCK`/聊天表写锁协调；TS `ChatLanceStore` 与遗留 KB 宽表共享进程级 `KB_MUTATION_LOCK` 串行化删除/优化与写入（`src/kb-mutation-lock.ts`、`src/chat-embeddings.ts`），SQLite 访问由 storage 服务串行化。await 交错下不持有跨 await 的 SQLite 游标。
- [x] 时间与 ID：生成方式、格式、时区：三个命令均不生成业务 ID。`optimize_chat_embeddings_table` 的节流时间戳由 Rust `Utc::now().to_rfc3339()` 写入设置（chrono AutoSi：0/3/6/9 位小数，UTC 写 `+00:00`），TS 用 F4 `host/platform/time` 的 `toRfc3339()` 生成、`parseRfc3339()` 解析（`src/chat-embeddings.ts`、`repository/chat-lance.ts`）；`optimize_lance_database` 的 `duration_ms` 恒为 0，不读时钟。
- [x] 不对含 HashMap 的结构做序列化后比对：融合结果的 `HashMap` 在输出前按 `rrf_score`、`resource_id`、`chunk_index`、`page_index` 显式排序（`retrieval_planner.rs:868-892`），TS 使用同一排序键（`src/retrieval-planner.ts:176-180`）；测试只比较排序后的数组或结构字段，不比较 map 迭代顺序。

## 命令 `clear_message_embeddings`

### v2 分支与证据（R12-06 / 入口整改）

- [x] 入口：Rust `commands.rs:2012` → `index.ts` 注册 `src/commands.ts:createChatCommands.clearMessageEmbeddings`。
- [x] 分支：`:2017` 空输入、`:2024-2033` trim/空串/i64/stable、`:2036-2054` stable 查询与行错误忽略、`:2057` 无匹配 warn、`:2062-2065` 排序去重、`:2069` store 构造失败忽略、`:2070-2077` 删除错误或成功 info、`:2080` 数据库删除仅 error；对应 src/commands.ts 与 repository/chat-lance.ts 的同名操作，顺序不变。
- [x] 边界：kernel 按 `Vec<String>` 解码；i64 使用 bigint；空结果 null；错误用 AppError.database 且 details:null。
- [x] 日志：warn 无匹配；error 清空失败；info 已清空数量（去重后）；error DB 标记失败。新增 kernel 入口测试断言级别、完整文案及先成功后 best-effort 错误顺序。
- [x] 错误：stable 查询错误先传播；构造失败不传播；Lance 删除错误加 `清空向量失败: `；数据库标记错误不改变结果。
- [ ] 所有权：mistakes.chat_messages 只读，chat_user_embeddings 删除仍待 owner 精确接缝；settings 已委托 F4 saveWithConn，legacy RAG 表按 C2 裁定归本 lane。见 BLOCKERS；不以 repository 目录自动认定单写者成立。
- [x] 运行时：没有新增取消；KB_MUTATION_LOCK 沿用；此命令不生成时刻。Lance await 在数据库 marker 之前。
- [x] 测试/证据：`tests/commands.test.ts` 经 kernel，原断言保留；新增 R12-06 日志与失败不继续用例。证据等级为生产入口测试 + Rust 审读，非差分。

<!-- BEGIN GENERATED:cmd:clear_message_embeddings -->
- Rust：`src-tauri/src/commands.rs:2012` · async
- 前端：app（1 处，例 `src/utils/testApi.ts:67`）
- 契约：`contracts/ipc/L12-vfs-index.json`
  - 参数：messageIds: string[]
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:clear_message_embeddings -->

- [x] 输入：`message_ids: Vec<String>`；空数组直接返回（`commands.rs:2015-2017`）；逐项 Rust `trim`（Unicode White_Space，不剥 BOM），空串跳过；能解析为 i64 的按数值 id，其余作为 `stable_id`（`commands.rs:2019-2034`）。TS 用 `host/platform/util` 的 `rustTrim` 与 `BigInt` 校验并保留 i64 全精度（`index.ts` 的 `parseI64` 返回 `bigint`）。
- [x] 输出：始终返回 `null`；无匹配 id 时仅 `warn!` 并返回（`commands.rs:2056-2059`）。
- [x] 错误：稳定 token 查询失败 → `AppError::database(e.to_string())`；Lance 删除失败 → `AppError::database("清空向量失败: {err}")`（`commands.rs:2043-2052,2069-2075`）。`LanceVectorStore::new` 失败被 `if let Ok` 静默跳过（`commands.rs:2065`）；DB 标记删除失败只 `error!` 日志，命令仍成功（`commands.rs:2078-2083`）。
- [x] 事件：无（`commands.rs:2012-2086`）。
- [x] DB 读写：`chat_messages` 按 `stable_id` 或 `persistent_stable_id` 查询 id（`commands.rs:2045`）；`delete_chat_embeddings_by_ids` 更新/删除聊天 embedding 重试标记（`commands.rs:2078`）；Lance 侧按 id 删除聊天向量（`commands.rs:2068`）。TS 使用 mistakes 库并原样保留 `persistent_stable_id` 列缺失时的 DB 错误行为（`repository/chat-lance.ts`）。
- [x] 取消/并发：无取消 token；解析、Lance 删除、DB 标记顺序 await。每次调用新建 store；聊天表删除通过进程级读写锁串行化（`src/chat-embeddings.ts`）。
- [x] 时间/ID：不生成时间或 ID；id 按 `sort_unstable` 升序后 `dedup`（`commands.rs:2061-2062`），TS 用 `bigint` 升序 + 相邻去重，Lance 参数为十进制字符串（`commands.rs:2064`），SQLite 绑定保持 `bigint`。

## 命令 `optimize_chat_embeddings_table`

### v2 分支与证据（R12-06 / 入口整改）

- [x] 入口：Rust `commands.rs:2088` → `src/commands.ts:optimizeChatEmbeddingsTable`，index.ts 只注册。
- [x] 分支：`:2096-2101` 构造/优化错误映射 AppError.database；`:2099` force None→true；`:2102-2104` optimized=0 输出原 debug 文案。feature-disabled store 的 0 同样触发该日志。
- [x] 边界/错误：kernel 的 Option<u64>/Option<bool> 解码；结果 null；无额外 safe-integer 拒绝；底层错误前缀按 ChatLanceStore 原样保留。
- [x] 日志/运行时：零优化 debug 已补；表错误 error 后继续；open_table 失败跳过；锁及 1800 秒持久节流沿用 Rust；无取消。
- [ ] 所有权：settings 写入已接 F4 owner 的 saveWithConn；F7 独立 compact/prune/index 能力仍未集成，不能签收真实优化链。
- [x] 测试/证据：kernel 参数与顺序测试保留，新增 zero-optimized debug 断言（logger exporter 开启 debug）；生产入口测试 + 审读。

<!-- BEGIN GENERATED:cmd:optimize_chat_embeddings_table -->
- Rust：`src-tauri/src/commands.rs:2088` · async
- 前端：none
- 契约：`contracts/ipc/L12-vfs-index.json`
  - 参数：olderThanDays?: integer(u64) | null, deleteUnverified?: boolean | null, force?: boolean | null
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:optimize_chat_embeddings_table -->

- [x] 输入：`older_than_days: Option<u64>`、`delete_unverified: Option<bool>`、`force: Option<bool>`；`force` 缺省按 `true`（`commands.rs:2100`）；`older_than_days=0` 在 `optimize_table_internal` 中转为不按天数 prune（`lance_vector_store.rs:817-823`）。
- [x] 输出：返回 `null`；优化表数量只在 `optimized > 0` 时记日志，`0` 时记 debug，不返回给前端（`commands.rs:2101-2104`）。
- [x] 错误：`LanceVectorStore::new` 或 `optimize_chat_tables` 失败 → `AppError::database(e.to_string())`（`commands.rs:2095-2103`）。单表优化失败在 group 内记录并继续，整体仍成功（`lance_vector_store.rs:907-920`）。
- [x] 事件：无（`commands.rs:2088-2105`）。
- [x] DB 读写：读 `lance.optimize.last.chat` 判断 30 分钟节流窗口（`lance_vector_store.rs:884-897,207`）；写同一 key 的 RFC3339 UTC 时间戳，即使没有表被优化也写（`lance_vector_store.rs:922-928`）；Lance 侧枚举 `chat_embeddings_v2_d*`、`chat_embeddings_d*` 与 `chat_embeddings`，执行 Compact/Prune/Index（`lance_vector_store.rs:940-965`）。
- [x] 取消/并发：无取消 token；优化与删除共享进程级 `KB_MUTATION_LOCK`（`src/kb-mutation-lock.ts`），避免与 `clear_message_embeddings` / KB `add_chunks` / `clear_all` 交错。
- [x] 时间/ID：节流时间戳为 UTC RFC3339（chrono `to_rfc3339()` AutoSi），由 `host/platform/time` 的 `toRfc3339()` 写入、`parseRfc3339()` 解析（`src/chat-embeddings.ts`）；最小间隔 `1800s`（`lance_vector_store.rs:207`）。不生成业务 ID。

<!-- BEGIN GENERATED:cmd:optimize_lance_database -->
- Rust：`src-tauri/src/commands.rs:6898` · async
- 前端：app（1 处，例 `src/utils/systemApi.ts:150`）
- 契约：`contracts/ipc/L12-vfs-index.json`
  - 参数：parallelism?: integer(usize) | null, force?: boolean | null
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:optimize_lance_database -->

### v2 分支与证据

- [x] 入口/分支：Rust `commands.rs:6898-6910` → `src/commands.ts:optimizeLanceDatabase`，唯一分支返回固定对象。
- [x] 数据边界/错误：kernel 校验可选参数，业务忽略它们；无业务 Err，固定字段和中文文案逐一对应。
- [x] 日志/所有权/运行时：原函数无日志、SQL、副作用、取消、锁和时钟，TS 相同。
- [x] 测试/证据：kernel `tests/commands.test.ts` 覆盖缺省/null/显式参数同结果；生产入口测试 + 审读。

- [x] 输入：parallelism/force 可缺省或 null；Rust 两个参数均未使用（commands.rs:6899-6903）。
- [x] 输出：{success:true, optimized_tables:0, duration_ms:0, message:"Lance 优化已跳过"}（commands.rs:6904-6909）。
- [x] 错误：函数无 Err 分支；参数反序列化由 kernel 处理（commands.rs:6899-6910）。
- [x] 事件：无（commands.rs:6899-6910）。
- [x] DB 读写：无；原函数明确跳过优化（commands.rs:6899-6910）。
- [x] 取消/并发：无等待点/取消点/锁（commands.rs:6899-6910）。
- [x] 时间/ID：无生成，duration_ms 固定 0（commands.rs:6907）。

## 事件 `media-processing-completed`

<!-- BEGIN GENERATED:event:media-processing-completed -->
- 事件名 `media-processing-completed`
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:1108`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3229`（emit）
<!-- END GENERATED:event:media-processing-completed -->

- [x] 载荷：`MediaProcessingCompletedEvent { fileId, readyModes, stage, mediaType }`；转写完成时与 `MediaTranscriptionCompletedEvent` 共用通道，后者额外含 `completedSegments`/`totalSegments`（`contracts/ipc/L12-vfs-index.json`；`pdf_processing_service.rs:434-435,3229`）。
- [x] 触发时机与顺序：PDF/图片在 `update_processing_status(Completed)` 之后先发本事件，再仅对 PDF 补发 `pdf-processing-completed`（`pdf_processing_service.rs:3229-3238`）；音视频在转写完成落库后发送（`pdf_processing_service.rs:1108`）。TS 在 `PdfProcessingService.runTask` 中同样先 `media-processing-completed`、后（仅 PDF）`pdf-processing-completed`（`src/pdf-service.ts`）。
- [x] 节流/合并：无节流，每次任务完成一条。
- [x] 是否在事务提交后：状态更新为自动提交的 `UPDATE`，事件在更新完成后发送；无跨语句事务。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` → 全部监听者；TS `ctx.backendEvents.emit`。
## 事件 `media-processing-error`

<!-- BEGIN GENERATED:event:media-processing-error -->
- 事件名 `media-processing-error`
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:826`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3270`（emit）
<!-- END GENERATED:event:media-processing-error -->

- [x] 载荷：`MediaProcessingErrorEvent { fileId, error, stage, mediaType }`（`contracts/ipc/L12-vfs-index.json`；`pdf_processing_service.rs:826,3270`）。
- [ ] 触发时机与顺序：外层失败先尝试 `set_error`，即使写失败仍发原错误，最后仅对 PDF 补发 `pdf-processing-error`（`:806-848`）；此分支已有真实 PDF 回归。音视频转写内层须用 current_stage + MediaError payload、WARN 并返回 Ok（`:1008-1030`），当前尚未对齐，依赖公开错误面见 WP-192。
- [x] 节流/合并：无节流。
- [x] 是否在事务提交后：错误状态 `UPDATE` 提交后发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` → 全部监听者；TS `ctx.backendEvents.emit`。
## 事件 `media-processing-progress`

<!-- BEGIN GENERATED:event:media-processing-progress -->
- 事件名 `media-processing-progress`
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3825`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:931`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3188`（emit）
<!-- END GENERATED:event:media-processing-progress -->

- [x] 载荷：`MediaProcessingProgressEvent { fileId, status: ProcessingProgress, mediaType }`；音视频转写用 `MediaTranscriptionProgressEvent`（`contracts/ipc/L12-vfs-index.json`；`pdf_processing_service.rs:931,3188`；`indexing.rs:3825`）。
- [x] 触发时机与顺序：PDF 每个阶段/页进度回调后先发本事件，再仅对 PDF 补发 `pdf-processing-progress`（`pdf_processing_service.rs:3186-3200`）；auto-OCR 成功后额外用本通道回传 `readyModes`（`indexing.rs:3825-3826`）。TS `emitProgress` 顺序相同，事件 `status.mediaType` 按 Rust 只加在事件副本上（持久化 JSON 不含该字段）。
- [x] 节流/合并：无显式节流；由 native 阶段回调频率决定（每页/每阶段）。
- [x] 是否在事务提交后：进度 `UPDATE` 是自动提交；事件在状态写库后发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` → 全部监听者；TS `ctx.backendEvents.emit`。
## 事件 `pdf-processing-completed`

<!-- BEGIN GENERATED:event:pdf-processing-completed -->
- 事件名 `pdf-processing-completed`
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3238`（emit）
<!-- END GENERATED:event:pdf-processing-completed -->

- [x] 载荷：本通道复用 `MediaProcessingCompletedEvent { fileId, readyModes, stage, mediaType }`（`pdf_processing_service.rs:3238`；`contracts/ipc/L12-vfs-index.json`）。
- [x] 触发时机与顺序：`update_processing_status(Completed)` 之后、`media-processing-completed` **之后**发送，且仅当 `mediaType == Pdf`（`pdf_processing_service.rs:3229-3238`）。
- [x] 节流/合并：无。
- [x] 是否在事务提交后：状态 `UPDATE` 完成后发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` → 全部监听者；TS `ctx.backendEvents.emit`。
## 事件 `pdf-processing-error`

<!-- BEGIN GENERATED:event:pdf-processing-error -->
- 事件名 `pdf-processing-error`
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:837`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3279`（emit）
<!-- END GENERATED:event:pdf-processing-error -->

- [x] 载荷：复用 `MediaProcessingErrorEvent { fileId, error, stage, mediaType }`（`pdf_processing_service.rs:837,3279`；`contracts/ipc/L12-vfs-index.json`）。
- [x] 触发时机与顺序：错误状态写入后，先 `media-processing-error`，后仅对 PDF 补发 `pdf-processing-error`（`pdf_processing_service.rs:3270-3279`）。
- [x] 节流/合并：无。
- [x] 是否在事务提交后：错误状态 `UPDATE` 完成后发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` → 全部监听者；TS `ctx.backendEvents.emit`。
## 事件 `pdf-processing-progress`

<!-- BEGIN GENERATED:event:pdf-processing-progress -->
- 事件名 `pdf-processing-progress`
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3826`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/pdf_processing_service.rs:3197`（emit）
<!-- END GENERATED:event:pdf-processing-progress -->

- [x] 载荷：复用 `MediaProcessingProgressEvent { fileId, status: ProcessingProgress, mediaType }`（`pdf_processing_service.rs:3197`；`indexing.rs:3826`）。
- [x] 触发时机与顺序：与 `media-processing-progress` 同点、先媒体通道后仅对 PDF 补发本通道（`pdf_processing_service.rs:3186-3200`）。
- [x] 节流/合并：无显式节流；由阶段回调驱动。
- [x] 是否在事务提交后：进度写库后发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` → 全部监听者；TS `ctx.backendEvents.emit`。
## 事件 `vfs-index-progress`

<!-- BEGIN GENERATED:event:vfs-index-progress -->
- 事件名 `vfs-index-progress`
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3562`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3683`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3729`（emit）
- 发送点：`src-tauri/crates/dstu-vfs/src/vfs/indexing.rs:3837`（emit）
<!-- END GENERATED:event:vfs-index-progress -->

- [x] 载荷：仅 auto-OCR 三类对象：`{type:'auto_ocr_started', resourceId, fileId, totalPages, message}`、`{type:'auto_ocr_page', resourceId, fileId, currentPage, totalPages, successCount, percent, message}`、`{type:'auto_ocr_completed', resourceId, fileId, success, successCount, failCount, totalPages, textLength?, message}`（`indexing.rs:3562-3570,3683-3695,3730-3741,3837-3846`；`contracts/ipc/L12-vfs-index.json`）。
- [x] 触发时机与顺序：`try_auto_ocr_pdf_pages` 读取 preview 后先发 started；每页 OCR 完成发 page；写 `ocr_pages_json`/合并文本并回传 `media-processing-progress`+`pdf-processing-progress` 后再发 completed（失败时 `success:false` 且无 `textLength`）。TS 通过注入的 `OcrRecovery.recover(resource, emit)` 接收并原样转发到 `vfs-index-progress`（`src/full-indexing.ts`）；F7/L02 OCR 缺失时不发事件。
- [x] 节流/合并：无；每页一条 page 事件，AUTO_OCR_CONCURRENCY=3 并发完成顺序不保证，按页号排序写库（`indexing.rs:3575-3710`）。
- [x] 是否在事务提交后：OCR 文本写库 (`UPDATE files SET ocr_pages_json`, `resources.ocr_text`) 为自动提交，completed 在写库之后发送。
- [x] 目标窗口（emit / emit_to / emit_filter）：`app.emit` → 全部监听者；TS `ctx.backendEvents.emit`。
## 服务与跨插件接线（2026-11-03）

本 lane 用 ARCHITECTURE.md 附录 A 的新服务名，并在 `api.ts` 导出
`lanceEngineService` / `retrievalService` / `vfsIndexService` 版本描述。

- `meta.provides: ['lanceEngine', 'retrieval', 'vfsIndex']`，`apply` 中分别
  `ctx.provide`。`lanceEngine` 由 `src/lance-engine.ts` 实现：F7 `vector.connect(path)`
  返回原生 `LanceConnection` 时直接转发；返回 `VectorConnection` 时适配
  `tableNames/openTable/createTable/dropTable/hasTableDirectory`、`countRows/add/delete`、
  `query`（含 `scanMetadata` 的 metadata 扫描）、`createTableWithSchema`、
  `search`/`fullTextSearch` 的原始 `_distance`/`_score` 业务映射，以及扩展成员
  `schema/addColumns/createIndex/optimizeAll/vectorSearch/ftsSearch`。
  缺失成员抛明确错误，不静默成功。
- F7 的真实 provider `host/platform/vector/index.ts` 现已合入 main；L12 在
  `index.ts` 使用 `ctx.inject(['vector'])` 绑定/卸载同一生命周期的 engine/store。
  F1 的官方 profile 尚无 dstu.vector，不能以 feature-disabled 测试宣称桌面链已通。
- F7 `vector`（真实 provider `host/platform/vector/index.ts` 与正式 api.ts 已在 main）：服务为
  `vector.connect(path): Promise<VectorConnection>`。provider 提供
  `createTableWithSchema(name, columns: readonly VectorColumn[])`、
  `hasTableDirectory(name)`、`openTable`（缺表抛库错）、`table.add` 普通 append、
  `query({ filter?, columns?, limit? })`（可无向量扫描）、
  `search(vector, { column, metric, limit, filter?, columns?, bypassVectorIndex?, refineFactor? })`
  （返回原始 `_distance`）、`fullTextSearch(text, { columns?, filter?, limit })`
  （返回原始 `_score`）、`schema()`、`addColumns([[name, valueSql]])`、
  `createIndex(columns, kind)`（`btree` / `bitmap` / `fts-ngram` / `cosine-ivf-pq`）与
  `optimizeAll({ olderThanDays?, deleteUnverified? })`。
  L12 的既有公共名 `LanceVectorColumn` 现在是 F7 `VectorColumn` 的类型别名，
  由调用方传完整 schema：
  `vfsLanceTableColumns(dim)` 对应 Rust `build_schema`（`lance_store.rs:882-901`），
  `legacyKbTableColumns(dim)` 对应 `ensure_wide_table`（`lance_vector_store.rs:1295-1311`）；
  不再探测旧 `createTable(name, dimension)`，缺失 `createTableWithSchema` 时明确报错。
  `openTable` 先查 `tableNames()`，把 F7 的“缺表抛错”转成 `null`。
- search 分数按 Rust `extract_search_results_hybrid` 顺序
  `_relevance_score` → `1 - _distance` → `_score` → `0.0`；F7 的 `_distance`/`_score`
  都是原始列，`metadata`→`metadata_json` 与业务结果映射由 L12 负责。F7
  `fullTextSearch` 只投影 `SEARCH_RESULT_COLUMNS`，缺少 `_score` 时映射 0.0。
  Int64 列（如 `generation`）在 Node 绑定中是 `bigint`；L12 内部保持 `bigint`
  精确表示，generation 匹配/比较/过滤全程不经 `Number`，也不拒绝合法 i64。
  `generation` 不是 IPC 字段，只有真正的 IPC 边界才转 `Number`。`chunk_index`
  按 Rust `i32` 字段独立校验范围，不复用 i64 的安全整数规则。
- `scanMetadata()` 走 F7 `query({ columns: ['metadata'] })`（无向量扫描），不再要求
  provider 提供专用 scan 方法。
- `optimizeAll` 是 F7 原生绑定唯一暴露的优化动作（npm 0.22.1 `native.d.ts` 只有
  `all`，独立 compact/prune/index 缺口已上报 C2）；因此只用于整表 all-actions
  （prune 7 天、`delete_unverified=false`）。只有 `optimizeAll` 的 provider 收到单
  `compact/prune/index` 时明确报错，不把三种动作映射成 all。legacy chat/KB 带 prune
  参数的独立优化路径因此在 F7 上显式失败并记录 warn，待 C2 原生绑定补齐。
- F1 仍需生成 `dstu.vector` profile；F7 provider/API 已 main，L12 同名结构 schema
  经生命周期注入传递，实际桌面 profile/native 组合未签收。
- 缺失能力时建表/写索引/优化/FTS 查询明确报错；`vector` 整体缺失时本 lane 退回
  `VfsLanceDisabled`（读空、删除 0、写入 `VFS_INVALID_OPERATION`，对齐
  `lance_store_stub.rs`）。
- L02/media（已接线，2026-11-04）：模型选择走 `llmEmbeddingModels`
  （文本 `getEmbeddingModelConfig()`、多模态 `getVlEmbeddingModelConfig()`，元数据含
  transport 字段并参与 fingerprint）；OCR 走 `llmOcrModels` 的
  `getFreeTextOcrCandidatesByPriority()` + `llmOcrHedge.prepareCandidates/runPrepared`
  （`call_ocr_page_with_fallback`），图片观察走 `llmStreaming.singleShotCompletion`
  （`call_raw_prompt_with_config_id_and_images` 的最小消息体）。所有服务都在调用时
  解析，L02 在 L12 之后加载也能生效。真正的 embedding 调用仍取决于 `embedding@1`
  （`callEmbeddingApi` / `callMultimodalEmbeddingApi`）是否被 L10/L02 发布；缺失时
  向量/多模态索引显式失败，FTS/词法检索继续可用。L02 目前未发布 rerank API；
  `llmRerank` 是结构化能力名，已配置 reranker 但 provider 缺失时记录显式 warn 并保留
  RRF 顺序（Rust 失败分支），未配置时按 Rust debug 语义跳过。
- L11（已接线）：`vfsRepo` 为唯一表所有者入口。`repository/owners.ts` 以
  `WeakMap<SqlExecutor, VfsReposService>` 按具体数据库句柄绑定；生产 `index.ts` 在
  `ctx.inject(['vfsRepo'])` 中绑定 `storage.database('vfs')`。绑定后 `resources`、
  `vfs_embedding_dims`、`vfs_index_profiles` 的写入优先委托 L11；
  `vfs_index_units/segments` 的 Unit/Segment/维度维护已由
  `vfsUnitBuilder`/`vfsIndexMaintenance` 走 L11。`repository/pdf.ts` 与
  `repository/multimodal-source.ts` 的 L11 表写入已改为 **owner 必需**：缺少对应
  setter 时明确报“待 `ds-mig/L11-vfs-repos` 合入”，不再降级为本地 SQL。其余仍带
  standalone fallback 的 helper 见下节。
- PDF/图片阶段（已接线）：`pdf@1` 不是 `PdfStageRuntime` provider。L12 自建
  `NativePdfStageRuntime`（`src/pdf-runtime.ts`）直接使用 F7 `nativePdfium`、L02 OCR、
  L11 `vfsRepo` 与 L12 full indexer，按 Rust `pdf_processing_service.rs` 执行文本提取、
  50 页/1200×1600/150dpi 预览、页压缩、OCR（并发 4）、向量索引与
  `backfill_missing_previews`。缺失 `nativePdfium` 时明确报 “PDF 功能不可用”，
  不再静默跳过 native 阶段。
- 消费方：已合入的 L13b `vfs-handlers` 和 L18 `media/index.ts` 使用 `vfsIndex`；
  L18 正式 `mediaTranscriber` 已进入 main，L12 runtime 直接消费其 `api.ts` 类型并懒取服务。
  旧 CAPABILITIES 的“均无消费者”记录已过期；L13 完整 mediaIndex/unitIndex 候选仍待集成。
- 平台复用：RFC3339 生成/解析统一用 `host/platform/time`（`toRfc3339`/`parseRfc3339`/`now`），
  Rust `str::trim` 与 UTF-8 字节长度统一用 `host/platform/util`（`rustTrim`/`utf8ByteLength`）；
  本 lane 不做 IP/SSRF 判定，故未使用 `host/platform/net-policy`。

## Q4 表所有者写操作交接（L12 部分，2026-11-04）

按单写者原则，本 lane 接收 L13b 交接中属于 Unit/Segment/维度计数/Lance 清理的部分；
资源/文件/题目集索引状态与路径缓存仍归 L11 `vfsMaintenance`。

- 新增 `vfsUnitBuilder`（`api.ts:vfsUnitBuilderService`，`1.0.0`）：
  `syncResourceUnits(input: UnitBuildInput): VfsIndexUnit[]`。
  对应 `index_service.rs:131-188` 与 `unit_builder/{trait_def,builders,registry}.rs`；
  表写入经 L11 `vfsRepo.embeddingUnits.syncUnits`（同一连接、savepoint、孤儿队列入队），
  成功后仅当返回 units 非空时把资源置 `index_state = 'pending'`；类型无 builder 时抛
  `Invalid argument 'resource_type': Unsupported resource type: {type}`。
  `file` 资源优先使用 `media_index.rs::transcript_units_for_resource` 的 ~90 秒/800 字时间窗
  （`text_source = 'transcript'`），无转写时回退通用 builder。
- 新增 `vfsIndexMaintenance`（`api.ts:vfsIndexMaintenanceService`，`1.0.0`）：
  - `resetUnitIndex(unitId, mode)`：对应 `index_service.rs:285-354`，一个 `IMMEDIATE` 事务；
    Unit 缺失抛 `Unit not found: {id}`，非法 mode 抛
    `unsupported index reset mode '{mode}'; expected text, mm, or both`；text/mm 仅在
    `text_required` / (`mm_required` 且 `image_blob_hash` 非空) 时置 pending，否则 disabled，
    并在 pending 时同事务抬升资源调度状态；任一步失败整体回滚（`tests/unit-maintenance.test.ts`
    的 `rolls unit changes back...`）。
  - `deleteResourceIndex(resourceId)`：对应 `index_service.rs:357-414`，收集 Lance row IDs、
    `purge_index_artifacts_by_resource`（同连接入 `__lance_orphan_queue` 后删除 units/segments）、
    `refresh_counts_from_segments`；返回 `DeleteIndexResult {resourceId, deletedUnitCount, lanceRowIds}`。
    调用方（L13b）随后按模态清 Lance，失败只 warn 并返回 retryable，不在本方法内做网络/Lance 写。
- 背景索引器已接线：`VfsFullIndexingService` 的 `unitSync` 使用
  `syncResourceUnitsForResource(resourceId)`；全量索引路径改用异步
  `syncResourceUnitsForResourceAsync`。输入按 `indexing.rs:2066-2167` 从 resources/files
  行构造。旧版多页 PDF（`extracted_text` 无 `\f`）在异步路径用 F7 `nativePdfium`
  从 blob 重提逐页文字后再建 unit；L11 分支的 `updatePdfExtractedText` 按 file id 且
  会改 `page_count`，与 Rust `WHERE resource_id` 的回写不同，因此仍待 L11 发布
  `setExtractedTextByResource`；重提结果只用于本次同步并记录待回写 warn，不伪造写
  成功。exam 的规范上下文已通过 L11 `questions.canonicalQuestions/canonicalText`
  接线；L11 未发布 `provenance_json` 与 qbank group 版本的原始读取，
  `canonicalExamDocument` 用 `source_refs` / 首个 material 版本近似，**该近似未完成**，
  待 L11/L14 发布完整 context 后替换，R12 不关闭。
- 另补 `vfsIndex.multimodal.processPendingBatch(limit)`：对应
  `multimodal_service.rs:1103-1223` 的 claim/逐资源/批次末尾计数刷新与失败恢复；
  页面嵌入流水线仍依赖 L02 `embedding@1` 多模态实现，缺失时按 Rust 失败路径计入 failed
  并 `mark_mm_failed`，不伪造成功。
- 对应 Rust 测试已在 `tests/unit-builders.test.ts`（11 项，标题沿用 builders/registry 测试名）
  与 `tests/unit-maintenance.test.ts`（`sync_resource_units_uses_single_pool_connection`、
  4 个 `reset_unit_index_*` 及回滚/删除）移植；这些测试在 inventory 中归 L13，
  由协调者决定是否在 L13 TESTMAP 标记为 merged 到本目录测试。

## R3 验收整改与剩余所有者缺口（2026-11-04）

### R12-09 generation 精确写链（新增复核）

Rust `lance_store.rs:289-311`：按 modality 读 unit i64，再 saturating_add(1)，缺 unit
与非法 modality 分别保留原错误。L12 `nextUnitGenerationValue/nextUnitGeneration`
现在返回 bigint；api 的 VfsLanceRow、IndexChunksResult、pipeline store 与 metadata 同步
参数增补 number|bigint，合法 i64 不拒绝、不经 Number。文本 Lance row 直接保留 bigint；
多模态 metadata 用 Node JSON.rawJSON 写十进制 JSON 数字，不能 JSON.stringify(bigint)
报错或把 generation 改成字符串。Unit 读取也用 safeIntegers，非安全范围返回 bigint。

Unit profile 写入经 L11 `setIndexProfile`；WP-009 已用 `git show main` 确认
`vfs-repos/types/indexing.ts:97,123` 的公开 generation 为 number|bigint。
`IndexUnitProfileWrites` 直接 Pick 正式 owner 类型，删除过期的临时接口副本。
Segment 替换继续调用真正的 L11 owner；其 safeIntegers/绑定已随 main 到位。

新增测试 `tests/lance-store.test.ts` 经 createTestHost 提供的
`vfsIndex.indexing.indexResource` 与 `vfsIndex.multimodal.indexResourcePages`：
只替换 L02 外部嵌入响应/F7 低层向量 transport，不替换 L12 pipeline 或 L11 owner；
验证 2^53+1 与 i64::MAX 饱和、Lance行、Unit/Segment 精确持久化、多模态 JSON 数字。
历史 job `20261104120704-aeeb2a` 在真实 Segment 值断言失败（2 failed/13 由 -t 过滤，exit1）。
WP-009 merge main 后 job `20261105140049-cbcdad` 原三例及整个 lance-store 文件通过
（16 passed），同批 pdf-status-wire 4 passed，exit0，无 Errors/Unhandled。

#### WP-009 PDF 任务生命周期 / u64（行为依据）

- Rust `pdf_processing_service.rs:586-590,705-721`：运行表代号及 AtomicU64 用 u64，
  fetch_add 按 u64 回绕，重复启动也先取代号；区别于 Lance/Unit 的 i64 saturating_add。
  TS 使用 bigint 代号、`BigInt.asUintN(64, counter + 1n)`，不经 number。
- Rust `:729-762`：后台 future 持有 Arc<Self>，CleanupOnDrop 只移除同 generation；
  `:2946-2961` cancel 先移表再取消，旧任务不能删除重启后的任务。
  Host 卸载须先取消并等待已接受 pipeline future（包含用户已 cancel 的旧代），再解绑 owner；
  单清 running 表不能代替 future 结束。两个 Cordis 清理入口均等待同一任务集合。
- Rust `:2588-2636` 的文件 OCR 没有可中断的远端 await；临时文件依赖 Drop 清理。
  卸载沿用现有 signal，不用 Promise.race 伪造任务结束，等待 runtime 的 finally 删除临时文件。
- Rust `:806-846`：pipeline 失败记 ERROR，set_error 失败另记
  `[MediaProcessingService] Failed to set error status: {db_err}` 后仍发原失败事件；
  TS 保留原错误内容及 finally 清理，不让后台 Promise 因二次状态写错误成为 Unhandled。
- 补测 `tests/pdf-lifecycle.test.ts` 经真实 plugin/service/runtime/L11，只控制 L02 OCR
  和 L18 transcriber 外部结果；覆盖在途成功/失败、已 cancel 的旧代、u64 回绕与
  cancel+restart、SQLite trigger 拒绝错误状态写。原 wire 与移植测试断言/超时保持。
  首红 `20261105140704-b0e6b5`：5 failed、Errors 1、exit1，实际暴露提前卸载和二次写异常。
  新增日志断言随后按真实 VfsError Display 补全 `Database error: ` 前缀，未改原移植断言。

### R12-03/06 缺接口与 best-effort 缓存补正

#### R12-06.additional-unit / X6-LP-0281、0282

Rust `indexing.rs:3006-3247`：附加 Unit 开始/完成各 info；pipeline Err(InvalidState)
尽力写 pending 后返回**原错误**，其他 Err 尽力写 failed、warn（unit/resource/原错误）
后继续后续 Unit。3072/3078/3115/3212/3218 的状态 UPDATE 全为 `let _`，不为其失败
另造日志或替换原错误；ID数不匹配的 discard 也无日志忽略，metadata rollback 的
discard 失败才 warn。实现通过专用 additional-unit best-effort 方法调用真实 owner。

同时把原过宽的 try/catch 收窄到 `pipeline.indexChunks`，对应 Rust match 的 Err arm
(`2969-3001`)；后续 additional 返回的 InvalidState 仅按 `2928-2941` 抬资源 pending，
不能再次把已提交 primary Unit 批量重排或让另一条状态写错误盖掉原异常。
primary错误的 Unit标记失败与完成后维度计数刷新按Rust warn继续；资源状态setter的
`?` 仍传播。冲突判定使用公开 VFS error code+InvalidState标记，embedding assignment
变化也用同一构造器；普通Other错误包含文字INVALID_STATE不等于Rust枚举InvalidState。

新增既有 indexResource 入口测试：真实L11仓储+SQLite UPDATE trigger拒绝第二Unit状态
更新；普通向量失败仍warn并处理第三Unit，InvalidState保同一error对象/primary已indexed/
第三Unit未执行，资源回pending。原SW-0179断言不改；仅外部向量写失败被注入，未替换
L12 pipeline或L11状态算法；沿用既有Lance端口夹具，不将此状态机用例当Lance/profile
完整链证明（完整写链由R12-09公开入口另测）。该修复不扩大为整个R12-03/06签收。

X6-SW-0179（原基线 index-units.ts:277）：无 embeddingDim 的 setUnitTextState
分支改为调用已发布 L11 `embeddingUnits.setTextState`，同一个 SqlExecutor，不再本地
UPDATE。Rust `index_unit_repo.rs:485-507` 对 pending/failed 保留已有 text_indexed_at，
仅 indexed 时更新它，维度不变；owner 实现一致。生产调用点为 full-indexing 的附加
Unit 失败/重排分支。新增通过实际 VfsFullIndexingService.indexResource 的外部向量写入
失败测试，断言真实 owner 被调用、失败状态/错误、原 indexed_at/维度和资源业务时间
保持，未替换 owner 实现。带 embeddingDim 的 SW-0178 仍需精确 owner 接缝，未关闭。

条件/无时间戳 OCR setter 缺失现在抛明确缺能力错误，恢复 owner 缺失也抛错，不再
虚报缓存成功/恢复0条。`resolveIndexableContent` 与 `VfsOcrRecovery` 的 Rust
`indexing.rs:1081-1089,3353-3363,3484-3490,3776-3786,3948-3958` 缓存失败只 warn
后保留已提取文本；错误不会把成功 OCR 变成失败。这是失败策略恢复，不是接口已发布。
相关旧“缺 owner 无操作”用例改为明确拒绝 + 仍未写入，增加 warn/文本保留/完成事件断言；
原 Rust 测试断言未删除或放宽。

本节记录 `ds-mig/R3-review-vfs` 的 R12-01…R12-08 / W07 整改结果；不改变上文由
scaffold 生成的命令/事件清单。

### 已接线的生产路径

#### R12-08 v2 进度解码补正

**X6-UD-0089 / F4 reader 接入增量**：F4 JsonReader 已 main 后，ProcessingProgress/
ProcessingIssue 改为逐字段消费；已知字段及 alias 的重复在读第二值之前拒绝，未知字段
仍按 IgnoredAny 校验并忽略。usize 用 readUnsigned 精确保留大值；原始 `-0`、小数与
指数不能被 JSON.parse 合并成合法整数。数组形式按 serde struct 字段顺序读入，只有
显式 default 的末字段可缺省；非法值整个回退 Default。失败不对外报告 JSON 错误，
所以内部缺字段/长度错误仅用于 Default 分支，不作为 wire 错误文本承诺。
percent 直接按 ParserNumber 转 f32：整数先做24位 ties-to-even舍入，避免 bigint→f64→f32
在2^63中点双重舍入。大页码仅在IPC最终转换，ProcessingProgress内部类型增补
number|bigint；需L13b状态命令使用本lane内部DTO而非生成的wire类型（已通知）。
OCR readiness与PDF状态写回通过 serializeProcessingProgress 保留大整数JSON token及
负零。新 getStatus 边界与 OCR生产回写用例保留大值/重复字段/数组/default 的原断言。
状态查询的 startedAt/completedAt 现在也以 safeIntegers 读 SQLite，合法 i64 大值保留
bigint，安全范围保持 number；只读查询不生成新时刻或改变DB值。

已静态核实隐式crate语义（未编译/运行Rust）：serde 1.0.228
`serde_derive/src/de.rs::expr_is_missing_seq` 在字段/容器均无 default 时生成 invalid_length，
Option字段也不能在sequence中任意省略；`serde_core/src/de/impls.rs` 的 f32 visitor
对i64/u64用 num_as_self、对f64用 num_as_copysign_self，直接cast而非中间f64。
serde_json 1.0.149 `src/ser.rs::serialize_f32` 将 Infinite/NaN 写 null。
`ProcessingProgressSnapshot` 在状态和事件出站显式进行此转换，不让非有限number进入
kernel；生成的wire契约percent仍只有number，已作为 B12-11 提交给契约owner，不自改。

固定feature来源：Rust `f3958900d` 的 workspace Cargo.toml:101 是 preserve_order，
dstu-vfs/Cargo.toml:47-50 显式 arbitrary_precision；Cargo.lock:11347-11358 锁
serde_json 1.0.149。其 Cargo.toml:68 默认仅std；float_roundtrip是独立feature，
仓库及现有缓存依赖manifests未发现启用（metadata.playground不是产品feature）。
`de.rs:345-353,623-635` 表明若启用float_roundtrip，1e40会在f32解析时out-of-range；
`:638-672` 默认路径先读有限f64再由serde visitor转f32。因此1e40回归限定可见声明的
非float_roundtrip路径，未运行cargo确认完整编译feature统一图，也不声称Rust差分通过。
另 `number.rs:323-338` / `value/ser.rs` 的 arbitrary_precision 保留 f32 最短十进制；
当前Snapshot有限percent仍使用扩展到JS的二进制f32，最短JSON数值投影已交F4（B12-12），
不把null子义正确外推成全部有限f32 wire等价。Rust输出成功nullable问题仍独立留给F5。

Rust `pdf_processing_service.rs:215-251,2896-2943`：stage/percent/readyModes 必填；
optional usize 非 null 时必须为非负 64 位整数；camelCase 与 alias 同时出现属于 duplicate
field，整份 progress 解码失败并回退 Default，不单独丢弃坏字段；未知字段忽略，
ProcessingIssue.retriable 仅缺省时 false，null 是错误。状态外层 stage 不受 progress
回退影响。此路径无日志或写入副作用，错误 JSON 按 Rust `.ok().unwrap_or_default()`
不向调用者抛出。回归经插件公开 `vfsIndex.pdf.getStatus` 读取 SQLite，见
`tests/pdf-status-boundary.test.ts`，不替换解码或仓储实现。

`PdfPreviewJson/PdfPagePreview`（Rust `types.rs:2851-2898`）还要求 pages、renderDpi、
totalPages、renderedAt 与每页 pageIndex/blobHash/width/height/mimeType 全部必填；
仅 isTruncated/maxRenderedPages 有 serde default=false/0，compressedBlobHash 为 Option。
`src/pdf-runtime.ts:parsePreviewJson` 已删除页号猜测、数字/字符串强转与“当前时间”补值，
按结构解码；缺字段/坏类型整份失败，unknown 字段忽略。测试直接调用该生产流水线使用的
解码器，不调整原 PDF 流水线断言。原始 JSON 数字词法/重复同名键/usize 大整数仍待完整
精确解码，当前不把本节当全部 serde 等价签收。

OCR settings 的 `ocr.pdf_text_threshold` 对照 Rust `pdf_processing_service.rs:354-357`
使用完整 `+?digits` 与 usize64 范围检查，拒绝空白、小数、指数、后缀和溢出；不是 parseInt
前缀解析。安全范围内 number，超过范围保持 bigint 参与长度比较，不拒绝合法 u64。
`tests/pdf-status-boundary.test.ts` 经真实 Host context 的生产配置加载器验证上限及默认值。

- **R12-01 PDF/图片/多模态**：`NativePdfStageRuntime` 覆盖文本提取、预览渲染与压缩、
  PDF 页 OCR、图片 OCR/压缩、向量索引、历史 PDF preview backfill；索引期
  `VfsOcrRecovery` 复用 `preview_json` 页做自由文本 OCR（并发 3），写
  `files.ocr_pages_json` / `resources.ocr_text` 并补 `readyModes=['ocr']`。
  `VfsMultimodalService` 实现非空页与 `indexResourceBySource`：blob 持久化、
  L11 Unit 同步、按 `EMBED_READ_BATCH=8` 分批读取原图、冻结 VL 配置并按完整
  `ApiConfig` fingerprint 校验、Lance append 后提交 Segment 账本、延迟清理旧 generation、
  失败时回写 Unit/资源/业务表状态。`processPendingBatch` 使用 Rust 的
  `forceRebuild=false, refreshCounts=false` 路径，成功/失败计数后统一刷新维度计数。
- **图片编码 owner 接线（R12-01，运行依赖仍阻塞）**：F3/F7 API 均已 main，
  `src/pdf-runtime.ts` 现在对渲染 RGBA 调 `nativeImage.encode(...,{format:'png'})`，
  对压缩调用正式 `imageQuality.adjustImageQualityBytes(bytes,quality,nativeImage)`。
  生产按调用时解析 provider，缺 provider 显式失败；本地 PNG/CRC/zlib、sharp linear/
  白底 flatten 及并行 qualityParams 实现已全部随 `src/image-codec.ts` 删除。
  Rust `pdf_processing_service.rs:464-490` 的读前/编码后取消与 permit finally 释放保留，
  F3 负责 high/auto/小图/失败保原策略，F7 负责图像计算与 worker 编码。
  `tests/native-pdfium.test.ts` 新增真实插件 PDF 调度→Pdfium→F7 PNG→F3/F7 JPEG→L11
  blob/preview 持久化用例，保留图像就绪、PNG签名、JPEG格式/768尺寸断言。
  当前因 F7 worker 所需 pngjs/jpeg-js 缺包而红，不以已接线当能力通过；D5 PSNR 未验。
  原 pdf-runtime 测试改用真实共享策略/codec，原断言保留；后台预览回填改等待实际 DB
  状态（有界10秒）而非100毫秒睡眠，以适应真实异步 worker，未给业务新增超时。
- **R12-02 模型配置/fingerprint**：文本与多模态嵌入配置均来自 L02
  `llmEmbeddingModels`，不是手写模型名；fingerprint 使用完整 transport 字段。
- **R12-04 rerank**：`createRerankRuntime` 读取 `ModelAssignments.reranker_model_config_id`；
  未配置返回原顺序（debug 跳过），已配置则调用结构化 `llmRerank`，失败由
  `VfsFullSearchService` warn 后保留 RRF，不再静默省略。
- **R12-05 接线/TESTMAP**：`compressImagePath`、`ProcessingSlots`、
  `imageExtensionForMime`、`hasRetriableFailure`、`searchExecutionBackend`、
  `shouldDisableIndexForMissingNote` 已接到 PDF/索引/搜索生产路径；`tokenize`/
  `bm25Idf`(`idf`)/`bm25Scores` 从 `api.ts` 导出既有 `src/lexical-bm25.ts` 实现，
  供 L13 的七个词法测试直接复用，不复制算法。
- **R12-06 日志**：索引同步成功 debug/失败 warn、embedding 重试 warn、不可重试 PDF
  状态 warn、多模态批次失败 warn、rerank 不可用 warn 均已恢复。
- **R12-07 `open_table`**：Lance `open_table` 缺失/不可用按 best-effort 处理，读取空表
  不阻断词法检索；写入仍显式失败。
- **R12-08 PDF 可选字段/进度**：`parseProcessingProgress()` 兼容 snake_case/camelCase
  与 Rust serde 默认；`getStatus()` 省略 `null` 可选字段；`percent` 为 f32。
- **W07 生命周期**：`LifecycleLanceEngine` + `createLifecycleLanceStore()` 让
  `vector` 的加载/卸载可重复绑定；`legacyKb` 是同一生命周期的 getter，不会永久缓存
  `undefined`。L02 的 OCR/embedding/观察能力同样在调用时解析。

### 表所有者写入状态（2026-11-04 更新）

#### R12-03 vfs_indexing_config副本清理（2026-11-05续派）

Rust配置仓储归L11（embedding_repo.rs:911-1055）；真实L13b配置命令已经通过
vfsRepo.indexingConfig.setConfig消费。L12 repository/index-state.ts的setConfig与
validateConfig未从公开api导出、全host只有本lane测试调用，不能为扫描器将其接回生产。
删除这份验证/写SQL/额外IMMEDIATE事务副本，L12只保留实际索引器用到的配置读取。
Rust set_config_with_conn本来是在调用方连接上validate→写入，并未自行开启事务。

原附加配置回归保留十项逐字错误、合法值写后读取及IndexingConfig投影断言，改为真实
L11 owner输入后测L12读取；Error类从本地副本改为公开VfsRepositoryError，并额外断言
同一Rust VFS_INVALID_ARGUMENT/param。未删除/减少断言，未改变79条Rust TESTMAP。
本变更不自签L11完整配置解码语义，也不新增命令或为未使用副本造生产调用点。

#### R12-03 settings单写者（2026-11-05续派）

F4 SettingsWithConn已main（settings/api.ts:44-59），本lane迁移原本地saveSetting副本：
Rust lance_vector_store.rs:788-793在优化结束后写lance.optimize.last.{scope}，即使没有表
被优化也写（:922-927）；写失败只warn并仍返回优化数。强制优化/非强制节流与原顺序不变。
rag.lance.path无效回退（:739-745）及归一化（:722-725）的save_setting失败则用?传播。
两类写入均把原mistakes连接交F4 saveWithConn，F4负责时间戳与同值不更新，不拆事务。
getSetting只读查询继续保留；本lane不再有settings写SQL。ChatLanceStore与LegacyKbStore
工厂增补可选owner参数，生产调用点传真实ctx.settings，缺写owner明确失败，不保留SQL
fallback。测试通过kernel及真实F4仓储验证两个path入口、时间戳写入与故障warn/传播。

三处设置读取的错误策略同时按原源码核对：lance_vector_store.rs:709-715、767-772、801-804
都对get_setting用.ok().flatten()，读取失败等同缺值、无日志；因此本lane只读getSetting
捕获SQL读取错误返回undefined。真实临时库移除settings表的回归仍应按默认路径/不节流/
delete_unverified=false优化，最后的时间戳写入失败才warn，不把读错误升级为整命令失败。

main 已在 `7b7136676` 合入 L11 的 PDF/媒体 owner setters（`updatePdf*`、
`saveOcrTextForFile`、`cancelProcessing`、`markProcessingRecovered`、
`applyProcessingStatus`、`files/exams.applyMultimodalIndexState` 等）；L12 按具体
`SqlExecutor` 绑定 `vfsRepo`（`repository/owners.ts`）。`repository/pdf.ts` 与
`repository/multimodal-source.ts` 的 L11 表写入 **必须** 有对应 owner 方法：
`requirePdfFileOwnerMethod` / `requirePdfExamOwnerMethod` 在缺方法时抛出明确的
“待 `ds-mig/L11-vfs-repos` 合入”错误，**不保留本地 SQL fallback**，也不把生产写入
降级到 owner 表之外。**R12-03 仍 pending：PDF setter 已到位，但条件 OCR、无时间戳
OCR、启动恢复 reset、`setExtractedTextByResource` 与 `canonicalContext` 尚未发布。**

- `repository/pdf.ts`：`updatePdfExtractedText`、`updatePdfPreview`、
  `updatePdfPreviewOnly`、`updatePdfOcrPages`、`updateCompressedBlobHash`、
  `updateProcessingProgress`、`applyProcessingStatus`、`setProcessingError`、
  `cancelProcessing`、`markProcessingRecovered` 全部直接调用 main L11 setter。
  `resources.ocr_text` 的 OCR 回写必须走 L11
  `resources.saveOcrTextForFile(conn, fileId, ocrText)` 并保留 `rows_affected`；
  不存在本地 SQL fallback。
- 索引期 `resources.ocr_text` 缓存按 Rust 的 5 个写入点区分：
  - 条件缓存（`indexing.rs:1082`、`3485`）SQL 为
    `UPDATE resources SET ocr_text = ?1 WHERE id = ?2 AND (ocr_text IS NULL OR ocr_text = '')`，
    不更新 `updated_at`，必须保持单条 UPDATE 的原子性。L11 尚未发布该精确
    `WithConn` 方法；L12 已请求 `resources.saveOcrTextIfEmptyWithConn(conn, resourceId, ocrText)`，
    在它出现前 **跳过** 这个 best-effort 缓存，不使用 `getOcrText` + `saveOcrText`
    （后者会新增 `updated_at` 并丢失条件写原子性），也不写本地 SQL。
  - 图片 OCR 无条件缓存（`indexing.rs:3354`、`3949`）SQL 为
    `UPDATE resources SET ocr_text = ?1 WHERE id = ?2`，**不更新** `updated_at`。
    L11 尚未发布该精确 `WithConn` 方法；L12 已请求
    `resources.saveOcrTextWithoutTimestampWithConn(conn, resourceId, ocrText)`，缺失时
    **跳过** best-effort 缓存，不用会写 `updated_at` 的 `saveOcrText` 强拼。
  - 合并页文本缓存（WP-202，`indexing.rs:3756-3790`）：L11 WP-201 已在 main
    `be646f252` 发布 `resources.saveOcrTextWithSqlTimestampWithConn(conn, resourceId, text)`。
    `updateResourceOcrTextRow` 仅委托该公开方法，原连接/调用方事务、resource id、文本原文
    直接传入；只有 `ocr_text` 与 `updated_at=datetime('now')` 更新，缺行成功。
    原生 SQL 失败交给 `cacheResourceOcrText` 的原 WARN（resource id + 原错误文，无
    `Database error:` 前缀），随后继续 ready_modes、completed 成功事件与 OCR 文本返回。
    通用 `saveResourceOcrText(..., false)` 仍对应 `resource_repo.rs:922-938` 毫秒语义。
    `tests/ocr-cache-owner.test.ts` 走公开 indexing→真实 recovery/L11/F3，使用 TEMP
    trigger RAISE(ABORT) 产生失败；另以真实事务 TEMP 观察器、主连接隔离与回滚验证同 conn。
    `ocr-recovery.test.ts` 原缓存失败断言改由真实 TEMP trigger 驱动，补 ready_modes/文件写后继续。
  - 上传期 PDF OCR 按 file id 回写（`pdf_processing_service.rs:2663`）走
    `resources.saveOcrTextForFile`（`datetime('now')` + `rows_affected`）。
- `repository/multimodal-source.ts`：`files` / `exam_sheets` 的 `mm_*` 写入直接调用
  `files.applyMultimodalIndexState` / `exams.applyMultimodalIndexState`；资源侧状态
  始终走已发布的 `indexStates`。业务表不再保留本地 SQL fallback。
- 仍未发布、已单列给 L11 owner 的方法：
  - `FileRepository.setExtractedTextByResource(conn, resourceId, extractedText)`：
    Rust `indexing.rs:1853-1858`（旧 PDF 重提逐页文字按 `resource_id` 回写）。
    分支现有 `updatePdfExtractedText` 按 file id 且同时改 `page_count`，语义不同；
    当前 `reextractLegacyPdf` 只把重提文本用于本次 sync 并记录“待回写”warn。
  - `ResourceRepository.saveOcrTextIfEmptyWithConn(conn, resourceId, ocrText)`：
    Rust `indexing.rs:1082` / `3485`，条件写且不改 `updated_at`；缺失时条件缓存
    跳过，R12-03 不关闭。
  - `ResourceRepository.saveOcrTextWithoutTimestampWithConn(conn, resourceId, ocrText)`：
    Rust `indexing.rs:3354` / `3949`，图片 OCR 无条件写且不改 `updated_at`；缺失时
    跳过缓存，不用 `saveOcrText` 代替。
  - `QuestionRepository.canonicalContext(conn, examId)`：完整 qbank context（含
    provenance / group 版本）。当前 `canonicalExamDocument` 用 `source_refs` 与首个
    material 版本近似，**该近似未完成**，R12 不能关闭。
  - `MaintenanceRepository.recoverStuckIndexingWithConn(conn, at): number`：
    Rust `indexing.rs:1978-2046` 的三条 reset UPDATE（`vfs_index_units` 文本/多模态 +
    `resources` 调度状态）。C2 08:35 已把该 reset 表 owner 派给 L11；L12 只保留
    启动调度入口 `VfsFullIndexingService.recoverStuckIndexing`，缺失 owner 时返回 0，
    **不再写第二份 reset SQL**。
- **R12-03 v2 增量**：`index-state.ts` 的资源状态/claim/revive/requeue/count，
  `embedding-dim.ts` 的注册/ANN，以及 `index-units.ts` 的资源 mm 状态与维度计数，
  现均要求 L11 owner，已删除 standalone SQL fallback。事务期间把相同 owner 绑定到
  F3 事务句柄，finally 恢复原绑定；不拆分 Rust 的原子更新。
  Rust `embedding_repo.rs:398-426,453-481,487-535,561-586` 对应 L11
  `indexStates` 的同名方法（revive/requeue 是 deferred，claim 是 immediate）。
  原索引/profile/检索测试仅增加真实 L11 provider 夹具，不改断言；新增生产服务入口
  断言缺 owner 时抛错且资源状态未改变。旧 primary unit/placeholder/批量文本状态等
  精确 API 仍待 L11，需求见 BLOCKERS，R12-03 **未全部关闭**。
  后续同组将 `setTextIndexed`、`purgeIndexArtifactsByResource`、`clearMultimodalIndex`、
  `setMmState`、`embeddingSegments.replaceByUnitAndModality/batchCreate/enqueueLanceOrphan`
  委托已发布 owner；Segment ID 恢复 owner 的 `seg_*` 生成，不再错误地用 Lance row ID
  当 SQLite segment ID。输入 contentHash 缺省转 null，返回字段不重造。

### v2 单调时钟

`lance_store.rs:2446-2462`：节流在优化前记录 Instant，失败也不立即再试；满 1800 秒
才再优化 text→multimodal。`src/lance-store.ts:maybeOptimizeAll` 用 performance.now，
而持久化 last optimize 时间仍保持 Rust 的墙钟。新增生产方法测试调整两个独立时钟，
断言墙钟跳变不能提前放行或延长锁定。

`unified_retriever.rs:36-41` 的熔断时钟同样是 Instant elapsed，`:563,667,771` 的
路由/派生耗时也是 Instant。`retrieval-service.ts` 改用 performance.now，毫秒取 floor
保持 `as_millis() as u64`；追加通过真实 retriever.search/inspectCapabilities 触发熔断、
墙钟前后跳及 30 秒单调冷却的测试，未替换熔断算法。

### L12 增补接线（2026-11-04）

#### R12-05 图片OCR临时扩展名（C2 续派）

已核Rust真实调用点 `pdf_processing_service.rs:2549-2625`，并非死代码：blob读取后，
创建前检查取消/旧代，临时文件前缀ds-attachment-ocr-，suffix来自image_extension_for_mime，
写原图字节后将绝对文件路径交给L02 call_ocr_free_text_with_fallback。创建/写入错误分别
加Create OCR temp image failed/Write OCR temp image failed；OCR错误warn并加
OCR API call failed。原四个MIME断言保留，实际入口尚未接通时该TESTMAP行改为pending。
文件在OCR成功或失败后Drop删除；调用期间取消不会中断非cancellable OCR，返回后检查
取消再写DB。非空OCR文本只用trim判空，原文本原样保存。不能仅调用suffix函数后仍传
data URL来伪造生产接线；图片必须消费L02已公开的llmOcrPages文件入口，PDF页OCR另循原路径。
Rust的全局ocr_semaphore来自LLMManager，L02公开API尚未提供该permit接缝；不另建本地
并发锁冒充同一实例，此共享许可仍需L02发布，不能由扩展名接线签收整条OCR流水线。

接线完成：`NativePdfStageRuntime.ocrImageFile`创建独占0600文件，文件名保留前缀、随机
6字符与MIME后缀；Node用mkdtemp隔离目录，finally关闭文件并删除该目录，清理失败按Rust
NamedTempFile Drop忽略。生产adapter调用L02 llmOcrPages.callOcrFreeTextWithFallback，
不再将图片走PDF页data URL重试路径。AppError Display取message（models.rs:1038-1041）。
`image-ocr-temp.test.ts`走真实插件、真实L11/blob/状态，外部L02只记录收到的文件；四种MIME、
文件字节、调用后删除、原文保存及OCR失败清理通过 `20261105012116-eaaaf0`（5 passed，exit0）。
最初观察器误把backendEvents.listen的void返回当取消函数导致测试超时，已修测试观察器；
没有据超时宣称业务反例。原四断言未改；真实调用接通后TESTMAP恢复ported，待R3复核。

#### R12-01 媒体检索富化（2026-11-05）

Rust `unified_retriever.rs:348-355`：归一化 route weights → RRF fusion →
multimodal scope filter → `media_index::attach_media_time_ranges` → prepend circuit failures。
L12 在同一点委托已发布的 L13 `vfs.mediaIndex.attachMediaTimeRanges`，按调用时解析服务。
L13 保持 `media_index.rs:263-315` 的空命中早退、仅 file/未知类型、每资源读取一次窗口、
metadata 范围优先于 page_index 对应窗口、同时回填 file sourceId；读取失败 debug 后返回
原有命中。无写库、事件、取消、重试或新时钟。缺 L13 时同样 debug 说明富化不可用，
不让本来的 best-effort 阶段阻断词法检索。真实 L11/L13/L12 组合测试覆盖窗口回填和
segment metadata 优先级，未替换规划、检索或富化算法。

写链对照 `indexing.rs:2605-2613,2787-2788,3033-3045,3163-3164`：primary transcript
在 embedding 前读取窗口0；additional units 第一次遇到非空 transcript chunks 时读取
整资源窗口、该轮循环复用。读取错误按 `?` 传播，尚未提交该unit向量；无range时metadata
为NULL。range的JSON由L13 segmentMetadataJson生成，再随原L11 Segment事务写入。
primary与additional都不把time range放进Lance行，而保留原page_index标签。新增公开
indexResource测试使用真实L11/L13/F7，只有L02远端embedding提供固定向量，并断言
两窗口metadata、Unit/Segment与原生Lance的2^53+1 generation。

真实F7首跑 `20261105004523-4c3a10` 暴露append错误：`metadata_json` 不在schema。
Rust `lance_store.rs:889,1081-1083` 的build_batch将DTO metadata_json放进Arrow metadata列；
TS writeChunks现于table.add前做同一映射，其余字段与bigint保持原值。既有MemoryTable
夹具按实际表列读取metadata，不再替生产代码暗中完成DTO转换；原测试断言均保留。

F7查询的page_index/source_id同样从metadata列解出（`lance_store.rs:2299-2315`），
并不存在独立Arrow列。两种查询共用parseLanceMetadataFields，原静态parseMetadataFields
入口委托同一函数。这里是Value而非typed struct：使用原生JSON.parse的reviver source读取
page_index原始数字token，按原生last-wins处理重复键，避免JS number舍入；其余字段只做
结构检查。dstu-vfs启用arbitrary_precision，未消费字段的1e400不能令合法metadata失效；
F4现有readValue会拒绝该值，故不用于此Value投影。as_i64后按Rust as i32截低32位，
其中裸-0按固定serde_json 1.0.149 de.rs:937-953的arbitrary_precision分支先解析为
I64(0)，与ProcessingProgress typed usize拒绝-0的路径不同。
非法metadata返回两项None，不新增日志。原生组合断言查询页码0/1；adapter向量/FTS回归
覆盖大整数截断、i64溢出、浮点拒绝、重复键与非法JSON。

- **`vfsIndex.getStatusSummary()`**：对应 `index_service.rs::get_status_summary`，
  返回 `{ totalUnits, textStats, mmStats, dimensions }`（camelCase，`StateStats` 五态 +
  `DimensionStat[]`）。生产实现 `VfsUnitIndexService.getStatusSummary()` 只读 L11
  `embeddingUnits.getStats(conn)` 与 `embeddingSegments.getModalityDimStats(conn)`，不写
  SQL、不复制统计口径；`index.ts` 把它挂到 `vfsIndex`。L13b 现有
  `vfs-handlers/src/index-admin.ts` 的 `getStatus()` 应改为复用该方法，不再自行拼
  `embeddingUnits.getStats`。
- **L18 媒体转写挂钩**：`api.ts` 发布 `MediaTranscriberService` /
  `MediaTranscriptionRequest` / `MediaTranscriptionResult`，并声明可选
  `Context.mediaTranscriber`。`pdf-runtime.ts::runMedia` 对齐
  `pdf_processing_service.rs:941-1105` 与 `hooks.rs::MediaTranscriber`：音频/视频进入
  `queued` 后解析 provider、读取 `mediaTranscripts.planInfo` 判断字幕导入、透传
  `onProgress`（含 `completedSegments/totalSegments`，进度字段走
  `MediaTranscriptionProgressEvent`，完成事件对音视频带同一对段数），转写出非空文本后调用
  `indexing.indexResource` 刷新时间窗索引；`failedSegments>0` 返回可重试的 ASR issue。
  L18 责任分支已发布候选 `MediaTranscriberCordisService`（`fdb013829`/`cadffc2e7`），
  公开签名与 L12 `api.ts` 一致：`transcribe({fileId,tempDir,imported,signal,onProgress})`
  返回 `{transcriptChars,doneSegments,totalSegments,failedSegments}`，`onProgress` 含
  `stage/percent` 与可选 `segments`；`index.ts` provide `mediaTranscriber` 并注册
  `media_transcribe_start`。main 尚未合入，因此当前运行仍走“provider 缺失明确失败”，
  不伪造成功。C1 的 2 文件 25 passed 不作为真实 L12 组合证据。合入后直接接真实转写；
  `refresh_transcript_index` 仍归 L13，最终 `indexResource` 归本 lane，不复制 ASR/持久化。
- **F7 `nativePdfium` 真实 Node 路径**：`tests/native-pdfium.test.ts` 用
  `@embedpdf/pdfium` WASM 生成两页 PDF，断言 `Page One\fPage Two`、`pageCount=2` 与
  第二页文本；不是测试替身。该能力可在 Node/utility 使用，不依赖 Electron。
- **R12-03 仍未关闭**：以上 owner 写入缺口未补齐前，R12-03 只能保持 pending，不能用
  “本地 fallback 可运行”当作完成。

### L11 表所有者仅剩缺口（已单列）

`ds-mig/L11-vfs-repos` 的 PDF/媒体 setter 已随 `7b7136676` 进入 main（见上节），无需
再按同义方法名索要。以下五项在 main 上确实不存在，L12 无法用现有 owner 方法等价表达：

| L11 方法 | Rust 写入点 | L12 当前行为 |
|---|---|---|
| `ResourceRepository.saveOcrTextIfEmptyWithConn(conn, resourceId: string, ocrText: string): void` | `indexing.rs:1082` / `3485`：`UPDATE resources SET ocr_text = ?1 WHERE id = ?2 AND (ocr_text IS NULL OR ocr_text = '')`，不改 `updated_at` | 条件缓存跳过（best-effort），不写本地 SQL、不拼接 `getOcrText` + `saveOcrText` |
| `ResourceRepository.saveOcrTextWithoutTimestampWithConn(conn, resourceId: string, ocrText: string): void` | `indexing.rs:3354` / `3949`：`UPDATE resources SET ocr_text = ?1 WHERE id = ?2`，不改 `updated_at` | 图片 OCR 缓存跳过（best-effort），不用会写 `updated_at` 的 `saveOcrText` |
| `FileRepository.setExtractedTextByResource(conn, resourceId: string, extractedText: string): void` | `indexing.rs:1853-1858`（`reextract_pdf_page_text`，`WHERE resource_id`，不更新 `page_count`/`updated_at`） | `src/unit-sync-service.ts::reextractLegacyPdf` 仅使用重提结果并记录待回写 warn |
| `QuestionRepository.canonicalContext(conn, examId: string): { schemaVersion: number; examId: string; materials: unknown[]; groups: unknown[]; questions: unknown[] } \| null` | `qbank_read.rs::context_with_conn` 完整返回 | `canonicalExamDocument` 用 `source_refs` / 首个 material 版本近似；**未完成**，R12 不关闭 |
| `MaintenanceRepository.recoverStuckIndexingWithConn(conn, at: number): number` | `indexing.rs:1978-2046`：`vfs_index_units.text_state/mm_state='indexing' → 'pending'`，`resources.index/mm_index_state='indexing' → 'pending'` 并清 retry | L12 调度入口返回 0（不写本地 reset SQL），待 L11 发布 |

#### L11 PDF/媒体 owner 逐方法签名、Rust 写点与接入顺序

按 C2 06:30 请求单列；顺序即 L12 流水线实际调用顺序（不是提交顺序），参数均与
`repository/owners.ts` 的结构化绑定逐字一致。Rust 侧事务/`updated_at` 语义由 L11
owner 自己实现，L12 不再写第二份 SQL。

| # | L11 方法（分支签名） | Rust 写点 | 关键语义 |
|---|---|---|---|
| 1 | `files.markProcessingRecovered(conn, fileId): number` | `pdf_processing_service.rs:3072-3080` | 启动恢复：卡住任务回 `pending`，返回 affected rows |
| 2 | `files.cancelProcessing(conn, fileId): number` | `pdf_processing_service.rs:874-879` | 仅取消 `queued/decode/vad/asr/indexing/pending`，清 `processing_error` |
| 3 | `files.applyProcessingStatus(conn, fileId, stage, progressJson, completedAt, now, issueSummary): void` | `pdf_processing_service.rs:2774/2801/2820/2831` | 四个 stage 分支；`completed` 清 error；`completed_with_issues` 用 `COALESCE`；不碰业务 `updated_at` |
| 4 | `files.updateProcessingProgress(conn, fileId, progressJson): void` | `pdf_processing_service.rs:2705` | 仅进度（OCR `ready_modes`），不改 `updated_at` |
| 5 | `files.setProcessingError(conn, fileId, error, completedAt): void` | `pdf_processing_service.rs:2878-2885` | `status='error'`，不重写 `processing_progress` |
| 6 | `files.updatePdfExtractedText(conn, fileId, extractedText, pageCount: number \| null): void` | `pdf_processing_service.rs:4281`（backfill 同时写 preview/text/page_count） | 文本提取阶段；L12 拆成 text 与 preview 两次 owner 调用 |
| 7 | `files.updatePdfPreview(conn, fileId, previewJson, pageCount): void` | `pdf_processing_service.rs:4281` / `attachment_repo.rs:809` | 渲染页后写 `preview_json/page_count` |
| 8 | `files.updatePdfPreviewOnly(conn, fileId, previewJson): void` | `pdf_processing_service.rs:2508` | 页压缩只更新 `preview_json` |
| 9 | `files.updatePdfOcrPages(conn, fileId, ocrPagesJson): void` | `pdf_processing_service.rs:4053-4057` | `ocr_pages_json` + `updated_at` |
| 10 | `files.updateCompressedBlobHash(conn, fileId, blobHash): void` | `pdf_processing_service.rs:2242` | 图片压缩 hash + `updated_at` |
| 11 | `files.applyMultimodalIndexState(conn, fileId, state, indexedPagesJsonOrError): void` | `multimodal_service.rs:1634-1670` | files 业务表 `mm_*` |
| 12 | `exams.applyMultimodalIndexState(conn, examId, state, indexedPagesJsonOrError, embeddingDim): void` | `multimodal_service.rs:1648-1656` | exam_sheets `mm_*` + `mm_embedding_dim/mm_indexed_at` |
| 13 | `resources.saveOcrTextForFile(conn, fileId, ocrText): number` | `pdf_processing_service.rs:2663-2669` | 上传期 PDF OCR，`datetime('now')`，`rows_affected` 必须保留 |
| 14 | `resources.saveOcrText(conn, resourceId, ocrText): void` | `indexing.rs:3778` | 合并页文本缓存，更新 `updated_at` |
| 15 | `resources.saveOcrTextIfEmptyWithConn(conn, resourceId, ocrText): void` | `indexing.rs:1082` / `3485` | 条件写，不改 `updated_at`；缺失时跳过 |
| 16 | `resources.saveOcrTextWithoutTimestampWithConn(conn, resourceId, ocrText): void` | `indexing.rs:3354` / `3949` | 图片 OCR 无条件写，不改 `updated_at`；缺失时跳过 |
| 17 | `files.setExtractedTextByResource(conn, resourceId, extractedText): void` | `indexing.rs:1853-1858` | 旧 PDF 重提按 `resource_id` 回写；缺失时仅本次使用 + warn |
| 18 | `questions.canonicalContext(conn, examId): {...} \| null` | `qbank_read.rs::context_with_conn` | 完整 provenance/group；缺失时当前为近似，R12 不关闭 |
| 19 | `maintenance.recoverStuckIndexingWithConn(conn, at): number` | `indexing.rs:1978-2046` | 启动恢复重置 Unit/资源调度状态；C2 08:35 归 L11，L12 仅调度 |

L11 合入 main 且发布 `saveOcrTextIfEmptyWithConn` /
`saveOcrTextWithoutTimestampWithConn` 后，L12 直接使用这些 owner setter，
并在 `reextractLegacyPdf` 成功后调用
`setExtractedTextByResource`、删除“待回写”warn；`tests/unit-source.test.ts` 增加
owner setter 调用断言。`repository/owners.ts` 已按分支的真实签名做结构化绑定，
`tests/owner-writes.test.ts` 记录逐参数转发与缺失 owner 的 pending 错误，不复制
L11 的 `updated_at`/事务语义测试。

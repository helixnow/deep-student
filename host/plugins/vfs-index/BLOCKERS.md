# L12 v2 跨 lane 阻塞（2026-11-04 接手）

以已合并 main 的公开接口为依据；本 lane 的 SQL fallback、解码、入口和日志缺陷是自有工作，不列为阻塞。

## WP-222 · D33 提供方核实（2026-11-05）

- 开工正常 fast-forward 至 main `0292921234955ff14c6f105d2595acc958ccb5da`。
  `git show main:host/plugins/llm-providers/api.ts` 确认 :81 公开同一生产
  `parseAttachmentPreviewJson(text): AttachmentPreview`，类型 :10-27 的 page_index 为 bigint。
  不再将 D33 归为“L01 未供”：剩余问题是本 lane by-source 错用 PdfPreviewJson。
- L01 `page-indexer.ts:68-80,119-128` 的两个错误包装分支均保留原 JsonSyntaxError
  cause；F4 `util/api.ts` 公开该类，message/code/line/column 已足以还原原 serde Display。
  本包仅消费 cause.message 加 Rust 前缀，不复制 parser、不解析/剥离 L01 上下文字符串。
- 既有 L11 资源/业务 mm 状态、Unit/Segment 方法可用于本包真实 SQLite 回归；索引链
  使用既有向量叶边界和外部 embedding 输入夹具。此证据不裁定 L02 多模态输送或其它所有权缺口。
- 两份 foreign `migration/LEDGER.md` / `migration/ledger.json` 开工已 dirty，保留给 C2。
  正式 lane-gate 结果另见 WP-222 交付报告；009 全域仍 pending independent acceptance。

## WP-219 最新核实（2026-11-05 23:24Z，覆盖旧 embedding 供方描述）

- 固定 main `df2cd30a1cacf598df851f40d643bb12ceacc7f2` 已正式提供 L02
  `TextEmbeddingService.callEmbeddingApi(texts: string[], modelConfigId: string): Promise<number[][]>`，
  `api.ts:77-88` / `index.ts:146`；B12-01 的“text embedding transport 未发布”已过时。
  本包不裁定该历史行的 multimodal/rerank 其余部分。
- 官方2240仅留新增失败文件名，WP-202 集成仍 blocked。修前 job
  `20261105232019-f83490` 原exit1/1 failed suite/3 skipped 已定位本 lane 夹具与真实
  L02 重复注册 `embedding@1`，不是 OCR owner 缺失或已证超时/CPU/RPC 问题。
  C2 更早且已结束的 `20261105231336-8c00a8` 原件同错，未冒充官方原栈。
- 本包仅窄修测试装配，原三错误断言与重读阶段保留，配置/HTTP/错误全部走真实 L02。
  Node `20261105232258-3bd9fe` / Electron `20261105232338-4596c5` 均3 passed/exit0，
  failed/skipped/Errors 均0；typecheck `20261105232259-f49720` exit0。正式 gate 仍仅
  foreign 账本前置exit2/无子job，原文见 `WP-219.report.md`。
- 两份 foreign `migration/LEDGER.md` / `migration/ledger.json` 仍由 C2 处理，未提交、
  覆盖或还原；新候选交 C2 清洁组合。WP-202 未签完整集成，009 全域独验仍未关闭。

## WP-202 当前依赖核实（2026-11-05）

- main `be646f2522f1028ae6e6553f5afeb201b05e76c4` 已含 WP-201 owner；开工正常
  merge `51651c5d8`。`api.ts` 重导 `PdfResourceOwner`，公开
  `saveOcrTextWithSqlTimestampWithConn(conn, resourceId, text): void`，实现
  `resources.ts:432-437` 只按 resource id 写 OCR 与 SQLite datetime('now')，不包装错误。
- 下方 WP-028 中观察到的 withTimestamp 差异由本包消费该方法修复。真实 TEMP trigger
  首红 `20261105221154-4f29a4`、首绿 `20261105221240-8aa0fe`，原件同时含公开入口
  DB/事件/日志/返回；不再依赖 spy 抛错来证明错误文案。此处只关闭接口等待，独立验收另计。
- 两份 foreign `migration/LEDGER.md` / `migration/ledger.json` 开工仍 dirty，
  正式绝对 lane-gate 的结果与完整组合交 C2；009 全域 pending independent acceptance 保留。

## WP-205 前置解除（2026-11-05 20:49Z）

`git show main:host/plugins/media/api.ts` 已核 :11 重导出同一个生产 MediaError；
`a3bcecd4e` 的第二父为 WP-204 `ac734a62b`，本分支正常 merge 为 `6f548a302`。
因此下方 WP-192 的公开错误面阻塞已解除，N1 由本包窄续修；历史部分交付仍保留。
原 `migration/LEDGER.md` / `migration/ledger.json` dirty 前置独立记账。

## WP-192 当前依赖核实（2026-11-06）

- R3 N1 所需 `MediaTranscriberService.transcribe` 已在 main，但 `media/api.ts` 未公开
  `MediaError` / `toPayloadString(): string` 或同义 failure mapper。真实提供方抛出该类，
  `src/errors.ts:19-21` 为 payload 唯一实现。请 L18 重导出同一个类（含 code/message），
  或提供 `mediaTranscriptionFailure(error: unknown): { cancelled: boolean; display: string; payload: string }`，
  语义对应 `dstu-media/src/media/transcriber_hook.rs:126-140`。具体请求已交 C1/C2/L18，
  见 `WP-192-dependency.md`；不得私引实现/复制 serializer。
- Rust `pdf_processing_service.rs:1010` 转写失败为 WARN，:1017 二次状态写失败为 ERROR；
  两者都继续 emit 原 payload 并返回 Ok。N1 的 current_stage/Ok 编排仍是本 lane 待办，
  依赖未公开不表示该问题已修；本包先修 N2/N3 与 PDF 外层测试归属。
- C1 回执确认需求成立，L18 **WP-204** 负责最窄重导出同一生产类；main 后由新包恢复
  L12 消费，本包部分交付、不空等。C1 同时确认二次 set_error 失败 ERROR 为正确语义，
  brief 中 WARN 是笔误；未知异常不可统一吞为 MediaError。009 仍 pending independent acceptance。
- storage/vfsRepo 已在 main：L11 files.setProcessingError/applyProcessingStatus 为现有真实
  owner；本包通过该 owner + SQLite 触发器测失败，不变更 OCR owner。
- B12-09 的两份范围外 migration 账本开工仍 dirty；正式 gate 前置结果按本包实测交付。

## WP-028 依赖核实（2026-11-06，覆盖下方 B12-03 中 OCR/恢复三项）

- L11 WP-001 `a8af0619c` 是 HEAD 祖先；main `vfs-repos/repository/resources.ts:422,428`
  已有 `saveOcrTextIfEmptyWithConn` / `saveOcrTextWithoutTimestampWithConn`，
  `maintenance.ts:110` 已有 `recoverStuckIndexingWithConn`。B12-03 中这三项不再缺失；
  `setExtractedTextByResource`、`canonicalContext` 及下方 R12-03 精确 owner 需求未在本包核对。
- `tests/index-service.test.ts` 中旧的“未集成/no-op”前提已改为真实 owner 断言（`5ce344aba`）；
  缺 provider 契约改用显式 `unbindVfsTableOwners` 夹具保留。
- WP-151：`tests/support/l11-branch-owner.ts`（复制两条 OCR UPDATE + Proxy 混合 owner）已删除；
  pdf-service/pdf-runtime/ocr-recovery/multimodal-index 与 index-service 中手写 resources owner
  改用正式 L11 provider（`real-owner.ts` / 宿主 `vfsRepo`），同一连接绑定。pdf-runtime、
  ocr-recovery 仅 blobs 仍为测试本地临时文件夹具（非 OCR owner 替身）。
- 历史观察（WP-202 已消费专用 owner，见顶部）：Rust indexing.rs:3777-3779 直接 `conn.execute(... updated_at = datetime('now'))`，
  失败 warn 为 rusqlite 原文；TS `updateResourceOcrTextRow` 走 L11 `saveOcrText`（`updated_at=Date.now()`
  毫秒，失败包装为 `Database error: …`）。ocr-recovery 缓存失败用例因此以 spy 注入原文错误；
  对齐需 L11 提供与该 Rust 写法一致的 WithConn 方法。

## WP-009 当前依赖核实（覆盖下方历史描述）

- 已正常 merge main；`git show main:host/plugins/vfs-repos/types/indexing.ts` 的
  `setIndexProfile:97`、`VfsIndexSegment:123` 均为 number|bigint。B12-08/D3 的旧
  “等 L11 generation 类型”已解除，L12 改直接引用正式类型，精度不退回 number。
  原 R12-09 三例包含于 job `20261105140049-cbcdad`（20 passed/exit0，无 Errors）。
- F1 raw-json 出口、F4 `JsonReader`/`f32ToJsonNumber` 已 main；同一 job 的原
  pdf-status-wire 四例全部通过；typecheck `20261105140049-471a44` exit0。
- D22 旧“BM25 未公开”不成立：main `vfs-index/api.ts:447-449` 已导出 tokenize、
  bm25Idf/idf、bm25Scores。无需重复实现或发布。
- D03 OCR 三方法 WP-001 尚未交付，依本包 brief 不消费、不作为 WP-009 依赖。
- B12-09 仍实际存在：开工继承两份 migration 账本 dirty，已通过 coord 通知 C2
  处理归属；本 lane 不提交或还原范围外生成物。

## 原会话恢复交接（2026-11-05，冻结代码d77bd5dbd）

最新原作业六项已全部取回，精确命令/作业号/后继入口见LANE.md顶部“恢复后冻结交接”。
Node本lane283 passed/3 failed，Electron定向43 passed；三失败仍为IgnoredAny和两项f32
wire，类型检查仅L13上传DTO。源码/config固定，恢复本身不计绿灯。
本文件下方D10/pngjs、旧generation、旧provider发布状态均保留其历史时间与提交语境，
不能当作本次Linux新复现；当前依赖是否解除须由新健康会话核对实际main公开API。

## 2026-11-05 新健康会话：正式固定联合树已通过本 lane 检查

本 lane 提交 5615f2e3e（preview/progress 用 `skipIgnoredValue`、percent 用
`f32ToJsonNumber`）、ec39ebe7d（内部 `ProcessingProgress.percent` 保 number、snapshot
为 number|null）、8b252cf5b（三个状态断言改为 serde 最短出站值；原三失败断言未改）。
按正常 merge 引入真实 owner 提交：F4 `71f7a3d10`→`30747990c`、F5
`b4a033c65`→`f87ae5d7a`→`052ac9759`→`845e26b4d`（最终，含 main `65f668842`；
f87-only 旧组合作废）、L13 `6913a03e5`→`0c2348a3f`、L18 `5e37aeae1`。845 merge 后
已复核 L13 upload/F4 qbank/L18 atom/F5 percent nullable 均未丢失。

最终固定 tip（845 组合）：全 lane `20261105101523-7624a3` 30 文件 286/286 passed、
exit0；typecheck `20261105101523-3bf580` 0；importable `20261105101523-0b5b46` ok；
boundaries 0 violation（`20261105101523-f44206`）；wiring ported77/未接入0
（`20261105101523-466c8e`）；ledger `20261105101933-869cdf` exit0。旧 f87 组合的
286（`...100324-4cb20e`）不外推到本组合。B12-15/B12-12/B12-11/B12-13 的代码阻塞在
本固定树已解除，**不等于 main 已集成**。

R3 已确认 8b 三处 snapshot 最短期望正确、不回改；唯一补测 `bebb5ea64` 在现有
`pdf-status-boundary.test.ts` 直接用生产 `parseProcessingProgress` 断言
`Math.fround(33.333333333333336)`、`2**63+2**40`、`Math.fround(12.3456789)` 与
1e40 内部 Infinity，snapshot null 仍由原 wire assert 覆盖；作业
`20261105102806-4359c5` 1 passed/11 filtered、exit0。本会话重复用例已由
`bd61095ee` 撤回。补测后 parser/status 小集 `20261105103110-33ed17` 41 passed、
exit0，typecheck `20261105103110-21c7a0` exit0。

F4/L18 最终闭包仍待纳入：L18 `f9d949d43` 已交 F4，L14 仍在最后 f64 高精度修正；
本树仍是 845+F4 307+L18 5e 的已验证组合，不把未确认 Value 语义合入 main；raw atom
IPC `{rawJSON}` 属 F1 边界，L12 不私修 kernel。

正式 lane-gate 仍被两份非本 lane 的 `migration/LEDGER.md`、`migration/ledger.json`
dirty 前置阻断，需 C2 安排归属；本 lane 不隐藏、删除或提交它们。L02 共享 OCR 许可、
L11 精确 owner 等跨域条目仍按下方保持。

## 2026-11-05 Linux 续作：当前门禁（覆盖下方历史状态）

**C2裁定已main：两条旧KB Rust测试**。正常merge 977c14fba后e4680aa8a祖先检查exit0，
审批分片:5-6已可见；TESTMAP仅精确两行改为obsolete:dead-in-rust，原TS测试/断言仍保留。
VectorStore维护模式
说明在vector_store.rs:1-9，唯一旧迁移公开入口在lance_vector_store.rs:3633-3642明确
deprecated死入口。活跃维度解析和chat/KB优化不属于申请范围。现有TS旧KB addChunks
仍有metadata_json未映射Arrow metadata的缺口（legacy-kb-store.ts:218-228），MemoryKbTable
不校验schema，不能以该测试绿色签native兼容；审批仅退休精确两测试，不为其制造生产调用。

**B12-16 / L11配置跨字段读取差异（静态证据，未签运行）**：真实配置入口归L13b→
vfsRepo.indexingConfig。L11 embedding-repo.ts:151-154/161/170读取已存i32时使用
`/^-?\d+$/` + Number，没有接受+号或校验i32边界；Rust embedding_repo.rs:960-964、
980-982、992-994使用parse::<i32>().ok()。例：owner setConfig(chunking.chunk_size,"+16")
可合法写入；随后chunk_overlap="16"在Rust必须拒绝（应小于16），现owner会按缺省512接受。
请L11在自身仓储修正；本lane不保留另一份validator来掩盖该差异。此次清理未改变生产
命令调用方向，也没有将十项普通配置回归通过当作L11完整语义签收。

R12-03 settings写入阻塞已解除：`ddae869ff` / `7a99ffb2a`将聊天优化时刻、聊天与legacy KB
的rag.lance.path回退写入委托F4 SettingsWithConn.saveWithConn，删除本地settings写SQL。
读失败按Rust.ok().flatten()使用缺省值，时间戳写失败仍warn成功，路径写失败仍传播。
Electron `20261105033357-8ea842` 原命令及新增真实owner回归19 passed、exit0；不能由此
关闭剩余chat_user_embeddings owner/F7独立优化能力或整个R12-03。
Node全lane `20261105033357-86edf7` 274 passed/3 failed，仍只原两wire与B12-15；
R3反馈的WARN观察已用显式exporter和逐字断言验证（033948-b294f4，1 passed/18过滤，exit0）。

**B12-15 / F4精确IgnoredAny仍待main**：preview typed decoder的已知字段/序列/usize
消费已完成，但未知字段须按serde_json de.rs::ignore_value忽略数字范围。当前main
JsonReader.skipValue调用readValue，会把未知futureField:1e400拒绝。F4分支已发布候选
`JsonReader.skipIgnoredValue()`（json-exact.ts:384起明确区别Value丢弃与IgnoredAny），
main未有此方法；需正常集成后将preview/progress未知字段分支改用该方法，不复制扫描器。
`tests/pdf-preview.test.ts`保留该合法preview预期成功的回归，未把它改为应失败。
实测Node `20261105024831-7c5d18`（269 passed/3 failed）与Electron
`20261105024831-90682e`（27 passed/1 failed）均复现该反例、exit1；其它preview精度
路径通过。所读F4候选HEAD为ba6ef98a3，不以该分支代码冒充main已消费。

R12-05增量：imageExtensionForMime已接 `pdf-runtime.ts:ocrImageFile` 的真实临时文件suffix，
文件交L02已公开llmOcrPages.callOcrFreeTextWithFallback；5个真实插件回归通过，未以无用
调用消指标。仍需 **B12-14 / L02共享OCR许可**：Rust pdf_processing_service.rs:608从
LLMManager取得同一ocr_semaphore，:2588在临时文件前获取并保持到API返回；当前L02 api.ts
没有该许可出口。需求为可取消等待的acquireOcrPermit(signal)→release/null，且必须与L02
现有OCR共享同一实例；不在L12重造锁或把本地图像处理slots冒充它。

自动续派增量：main `80851cc18` 仍无F4 f32ToJsonNumber，F5/L13原门禁问题未消除。
L13 mediaIndex发布后，L12已接unitTimeRanges/rangeForUnit/segmentMetadataJson及
attachMediaTimeRanges；旧B12-05“provider尚未发布”和下段“时间范围尚待消费”不再成立。
真实F7写链曾暴露metadata_json/metadata列映射缺陷，已在L12修复；Electron最小集
`20261105004857-0235ea` 17 passed、exit0，不外推剩余PDF wire/owner缺口或B级签收。

追加最终结果：Node全lane `20261105004857-1ab90d` 为245 passed/2 failed、exit1，
仍仅原PDF wire两例；Electron `20261105005442-26c126` 为3文件22 passed、exit0，
覆盖native查询页码与generation、媒体富化和真实缺表best-effort。无Errors/unhandled。

正常合并 main `e9df01a3c`，合并提交 `b97f237e2`。当前不能交付全绿：

- **R12-09 / B12-08 已解除旧 owner 阻塞**：`9006bc168` 是 main 祖先；全 lane
  作业 `20261105000316-0d8e42` 中三个既有公开 text/mm 大 generation 回归均通过，
  Lance/Unit/Segment 与 mm metadata 原精度断言未改。真实 F7 向量组合与独立复核另计。
- **B12-12 仍阻塞（F4）**：`0fb54cdde` 不是 main 祖先，`host/platform/util/api.ts`
  尚无 `f32ToJsonNumber`。同一作业的有限 f32 wire 例仍得到
  `33.33333206176758`，期望 `33.333332`。需 F4 正常集成共享投影后接入
  `src/pdf-processing.ts:processingProgressSnapshot`，不复制其 formatter。
- **B12-11 仍阻塞（F5）**：`contracts/ipc/_shared.json:1302-1305` 的 percent
  输出 schema 仍是 number。现有溢出用例的服务结果为 null，但真实
  `vfs_get_pdf_processing_status` invoke 被契约拒绝。需输出允许 null，输入仍拒绝 null。
- **新增 B12-13（L13 消费 DTO）**：typecheck 作业 `20261105000315-7b7e06` exit 2，
  唯一错误 `host/plugins/vfs/src/upload-attachment.ts(209,7)`：number|null 无法赋给
  number|undefined。请 L13 按 Rust 出站语义适配 processingPercent；L12 不把合法 null
  改为 0/省略，也不越界改 L13 文件。
- **B12-09 仍存在**：开工已有 migration/LEDGER.md、migration/ledger.json dirty，
  不在允许路径；lane-gate 的全树 clean 前置条件须协调者处理。

基线全量 Node 为 **25 文件：24 passed / 1 failed；233 测试：231 passed / 2 failed；
exit 1，无 Errors/unhandled**。两失败均为上述 R12-08 wire 例。首次直接运行的类型检查、
测试因 120 秒工具超时未完成，以上结果来自项目队列重新执行，不把超时称为通过。

已到位的接缝：F1 desktop profile 含 dstu.vector；L13 api.ts 已发布 mediaIndex/unitIndex，
因此 B12-04 的 profile、B12-05 的“尚未发布”已过期。L12 对媒体时间范围/segment metadata
的消费仍须继续完成，是自有接线工作。F7 图片与 PDF 的现有真实组合测试在上述 Node
作业通过；不据此签 D5 像素容差或三平台。ACCEPTANCE.md 已随 main 到位，B12-06 关闭。

Electron 作业 `20261105000802-4969bd`：234 passed / 2 failed（236），exit1，
同两项wire失败，无Errors/unhandled；其中新增标题回归已通过。strict 作业
`20261105000821-84141e`：2949 files、0 violations、exit0。ledger 作业
`20261105000802-d564c4` exit0（本lane命令/测试A100%、B0%）；不代表集成门禁已通过。

L11 精确 owner 缺口仍在：全目录检索无 saveOcrTextIfEmptyWithConn、
saveOcrTextWithoutTimestampWithConn、recoverStuckIndexingWithConn、
setExtractedTextByResource、canonicalContext；下方精确 primary/placeholder/批量状态需求
仍需 owner 发布。TESTMAP 的 79 ported / 0 pending 不代表这些 v2 问题已签收。

| ID | 所有者 / 缺失能力 | 当前证据 / 所需接缝 |
|---|---|---|
| B12-01 | L02 embedding transport、rerank | `host/plugins/llm/api.ts:54-60` 仅公开模型选择；没有 `callEmbeddingApi` / `callMultimodalEmbeddingApi` / rerank transport。L12 最小需求在 `src/runtime-adapter.ts:36-39,390-393`，需正式 provider+api，不能以 `embedding@1`/`llmRerank` 结构声明算发布。 |
| B12-02 | D10编码依赖已解除；D5证据仍pending | main1e893eb61有D10根声明，实际worker解析pngjs7.0.0/jpeg-js0.4.4到共享root node_modules；L12真实PDF与codec回归 Node155007-dafcd7/Electron155007-467a6f各7passed、exit0，保所有原断言。实际backend为pngjs/jpeg-js，未使用撤回的sharp切换；仅WASI warning，无GLib critical/Errors/Unhandled。旧缺包条件关闭，D5 PSNR/F6、目标平台与整R12-01仍未签。 |
| B12-03 | L11 精确 owner setters | 全 `host/plugins/vfs-repos` 无 `saveOcrTextIfEmptyWithConn` / `saveOcrTextWithoutTimestampWithConn` / `recoverStuckIndexingWithConn` / `setExtractedTextByResource` / `canonicalContext`。签名与 Rust 语义见 `repository/owners.ts:42-74`、SPEC Q4；题库需要 provenance_json/group context，不能用 source_refs 近似。 |
| B12-04 | F1 vector profile / F7 独立优化能力 | F7 vector provider 与 bigint/schema API 已在 main，L12 生命周期注入会消费；host/profiles 中仍无 dstu.vector/platform/vector，需 F1 正式生成接线。F7 optimizeAll 仍不能代替带独立 compact/prune/index 的旧聊天/KB路径，能力缺口不算已解决；真实 native 组合仍待验证。 |
| B12-05 | L13 媒体索引刷新（候选已发布待集成） | L18 `mediaTranscriber` 已随 `ebc4a083e` 合入，L12 懒取正式 provider，类型改从 L18 api.ts 消费。main `host/plugins/vfs/index.ts:97` 仍只 provide `{version,database}`，L18 `index.ts:759` 缺 `vfs.mediaIndex/unitIndex` 则跳过刷新。C2 已亲读 L13 候选 `index.ts:194` 含正式 `mediaIndex`（src/media-index.ts）与 `unitIndex`，待 main 集成；不复制刷新算法或以替身签三 lane 完整链。 |
| B12-06 | 复核人报告未入分支 | 本目录/main 无 ACCEPTANCE.md；已按派发 R12-01…08 与补充两项整改。请协调者提供完整报告并在 main 集成后安排复验。 |
| B12-07 | F4 reader 阻塞已解除；消费候选待复核 | 正常 merge main `6a7715d6e` 已带入 JsonReader。L12 ProcessingProgress/Issue 已逐字段消费，覆盖词法整数、重复/alias、struct序列、default、f32及精确回写；Node/Electron各40例通过（142353-b18abd/03dd4f）。Preview 精确 reader 是本 lane 后续自有工作，不再列为缺 F4 接口；无第三 parser/新 npm 依赖，无 Rust 差分签收。 |
| B12-08 / R12-09 | L11 Segment generation 写链 | 全量 `20261104121518-2e26d3`：215 passed / 3 failed，exit1；三处都在 Segment 精度断言。text/mm 的 9007199254740993n→9007199254740992n；text i64::MAX→9223372036854776000（number）。next、Lance、Unit 与 mm metadata 的前置断言通过。main `repository/index-segments.ts:176-198` 普通 SELECT + readInteger/number cache；需要 safeIntegers、bigint 缓存/绑定/返回与公开类型增补。已交 L11；不写第二份 SQL、不放宽断言。F7 vector bigint API 在候选 api.ts，仍待 main/native 组合。 |
| B12-09 | lane-gate 前置条件 / 范围冲突 | 开工就存在的 migration/LEDGER.md、migration/ledger.json 未提交生成物不在本 lane 允许路径。新 lane-gate.mjs:28-31 对全部 dirty 拒绝，L12 无权提交或还原它们；已请 C2 处理生成物/由协调者修 gate 规则。本 lane 只提交自己的文件。 |
| B12-10 | L13b DTO 修复候选待 main | 两处旧tree TS2322（src/pdf.ts:57,116）已有独立候选 `f6a9907e2`：ProcessingStatus改从L12 api导入，运行时无改，owner五项lane-gate通过；C2已收到集成请求，当前main未含。不再称其候选未修；大页码/状态时间保持bigint，kernel最后转number。 |
| B12-11 | F5 出站 f32 nullable 契约 | serde_json 1.0.149 ser.rs::serialize_f32 对 Infinite/NaN 写 null；persisted percent=1e40 被 f32 visitor接受后出站null，1e400则JSON decode失败→Default。L12状态/事件快照已显式处理，生产入口测试覆盖；generated _shared.ts:245仍percent:number，可能使L13状态命令debug结果验证拒null。已交C2/F5核输出schema，输入null仍应拒绝；未修改contracts。 |
| B12-12 | F4 f32 出站投影候选待 main | F4最新 `0fb54cdde`（前序`159eb035f`/实现`c0e797350`）已从util/api.ts发布f32ToJsonNumber(value):number|null，owner报告五项lane-gate通过；Node151601-6fcbaf/Electron151448-fff7fe各4过。精确中点区间选最短roundtrip十进制、最近/偶数舍入、保返回-0，非有限→null；无Rust差分，不签L12。待正常main后仅接统一processingProgressSnapshot（状态/事件/持久化共用），内部运算/输入decoder不改。已加真实invoke有限33.333332回归；负零文本由L12 serializer保留，不重造formatter/依赖、不扩全契约。 |

R12-09 owner 最新交接：L11 `9006bc168`（含 `e0cee4a6e/63b02ec7d/f1006fd19`）
已修 unit/segment generation 的 safeIntegers 查询、缓存、绑定、返回与公开 number|bigint
类型；安全范围仍 number，大值 bigint，owner 报20例通过/tsc通过。已只读候选 diff，
`git merge-base --is-ancestor 9006bc168 main` 当前为 false，**尚不覆盖 B12-08 的真实
主线反例**。待正常集成后只跑已有 lance-store.test.ts 的 R12-09 三例，不重造 owner 或
将候选本地混入测试树。F4基础JsonReader已随后进入main并被消费；新的f32输出投影
`0fb54cdde` 仍候选，不能混同这两个交付。

L11 补充告知旧消费者会因 generation:number 出现 TS2322。L12 已将固定消费者
`5aaf3bc8a` 标为 **与 9006bc168 同批的 main-ready 候选**；其 number|bigint DTO、
生成/写链与三例回归均已存在。选择该固定候选时后继图片单元缺依赖；现在D10已解除
且图片最小复验通过。当前HEAD还含新的reader DTO/契约接面，仍不能将整棵HEAD宣称
可单独过门禁，R12-09继续按其独立联合owner验证。

更新：F3 imageQuality 与 F7 encode/resizeAndEncodeJpeg、vector provider 现均已 main；
图片链已消费。历史作业 `20261104132400-895c66` 的
`page_rendering: Cannot find module 'pngjs'` 曾对应审批记录
`2026-11-04T074046118Z-F7-native.md`，现已由D10根批准/安装及155007双运行时通过
解除，不再沿用“未批准/缺包”作为当前条件。F1 vector profile仍待；D5 PSNR等待
F6 Rust向量，不能由L12当前尺寸/格式断言代签。
F7 提到的两处 Pdfium fixture diagnostics 缺失已由 `35c63591d` 修复，亦包含于
联合候选 `5aaf3bc8a`；当前 pdf-runtime.test.ts:126-130 与 unit-source.test.ts:73-77
都有必需方法，未降低正式 NativePdfium 契约。
B12-06 完整复核现已只读 `git show ds-mig/R3-review-vfs:host/plugins/vfs-index/ACCEPTANCE.md`
（含 §6/R12-09），不修改复核人的文件。

## R12-03 精确 owner 增补需求（接手亲读）

资源状态与 profile 注册已有接口，本 lane 正在删除对应 fallback；以下现有 L11 通用
方法**不能等价替代** L12 所有 Rust 索引器中的直接写入，请 L11 发布 WithConn：

- primary unit 创建：`indexing.rs` 的 `ensurePrimaryUnit` / 旧 index_resource 插入空文本
  但 `text_required=1,text_state='indexing'`、mm disabled；L11 `create` 会按空文本判为
  text disabled 并额外计算 content_hash（`repository/index-units.ts:165-174`）。需
  `ensureIndexingPrimaryUnitWithConn(conn,resourceId)`；旧入口指定 unitId/at 的版本也需
  `insertIndexingUnitWithConn(conn,{unitId,resourceId,at})`。
- placeholder segment：旧 index_resource 使用传入 seg ID / lanceRow ID / 起止位置与同一 at，
  不读取 unit generation。需 `insertPlaceholderSegmentWithConn(conn,input,at)`，
  不能用当前 `embeddingSegments.create` 的随机 ID / profile 继承冒充。
- 批量文本状态：`setTextState` 没有 embeddingDim 参数；需按资源批量更新 state/error、
  可选 requiredOnly、可选清空 embeddingDim，且一次取时刻。需求对应
  L12 `repository/index-units.ts:249-321`；`clearTextIndexRowsForResource` 同事务清
  segments/orphan 入队/保留非空非 primary required units 为 pending 的精确操作也缺。
- D3 generation 已解除：当前 main `types/indexing.ts:97,123` 为 number|bigint，
  原公开写链三例在 WP-009 基线通过；历史 Segment 断点见 B12-08，不再列为当前阻塞。
- orphan 队列删除/重试更新：目前 L11 只有 enqueue/count，没有
  `deleteLanceOrphanWithConn(conn,rowId)` / `updateLanceOrphanRetryWithConn(conn,rowId,nextRetryAt,error)`；
  需确认 `__lance_orphan_queue` 唯一所有者，避免 L11 enqueue/L12 delete 分裂。
- legacy mistakes 库：`chat_user_embeddings` 删除、settings 及 rag 表写入尚需 F3/F4/L04
  确认 owner 接缝（`repository/chat-lance.ts`）；当前不是 v2 完成项。

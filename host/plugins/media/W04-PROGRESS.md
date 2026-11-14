# W04 第三轮进度

## 1. G3 `__change_log` 写序（完成）

- [x] 定位：G3 `media.transcript.import_formats_and_errors` step 8 `__change_log#10`
  Rust=`resources`，TS=`files`（triage table_name 组 3443 次，代表样本）。
  官方 profile + 真实迁移库实测，上传后 TS 序列为
  `files(text), resources(units), files(start queued), files(queued progress), files(text), resources, …`。
  Rust `transcriber_hook.rs` 进度走 mpsc + `select!`，导入分支无 await，`transcribe_resource`
  首次 poll 即完成，`Queued` 只在 `try_recv` 排空时落库，应为
  `files, resources, files(start), files(text), resources, files(queued), files(92%)`。
- [x] 修复 `8c49196`：`src/media-transcriber.ts` `ProgressChannel`（微任务投递 + 完成后排空）。
  测试 `tests/transcript-import-change-log.test.ts`（先红后绿，红时差异与 G3 样本一致）。
- [x] 教材导入（txt + 目标文件夹）：`blobs I, resources I, files I, folder_items I`，与 Rust 一致。
- [x] 损坏 PDF 导入：`blobs I, resources I, files I, …`，前缀与 Rust 一致；
  triage 中 `textbooks.add.pdf_render_error_recorded` resources 行差异无法由源码复现（交接）。
- [x] B 站 create / 字幕导入：命令级写序与 Rust `upsert_link_item_finalized` 一致。
- [x] `.bilibili` 上传：Rust `vfs_upload_file` 与 `FileBuilder` 同样建占位 unit；
  triage `bili.link_item.offline_descriptor` step16 多出的 `vfs_index_units` 行源码层面不成立（交接）。

## 2. PDF 页图读取去重（完成 `08bfbdf`）

- vfs-handlers `src/pdf.ts` 抽出 `readPdfPageImageBytes(source, resourceId, pageIndex, maxBytes)`
  （Rust `read_pdf_page_image_bytes`），`getPdfPageImage` 改为其薄包装；`api.ts` 导出。
- media `pdf_page_image` 改用它；删除 `src/tools/pdf-page-source.ts` 与 `repository/pdf-page-preview.ts`。
- 新增 vfs-handlers 测试覆盖 maxBytes 分支。

## 3. media 热路径异步化（完成 `1abaae6`）

- 改为 `fs/promises`：音频转写工具源读取/产物写入、docx/pptx/xlsx/office-fidelity 源读取、
  题目集归档复制与尺寸读取、`get_image_as_base64` 与笔记导出图片内嵌。
- 保留同步（判据：载荷 ≤64KB/一次性启动读取/纯元数据或路径校验/跨 lane 同步契约/原生同步回调）：
  B 站描述符读取、bridge 资源缓存、pdfium 库探测、OCR 测试小图、转写临时目录清扫、
  realpath/isFile 授权校验、页图 `loadPageImageBytes`（qbank 同步端口）、PCM spool（解码 sink 同步回调）、
  内联媒体临时文件（inline 仅小数据）、zip/gunzip（受条目/响应上限约束的 CPU 操作）。

## 4. 终检（完成）

- media：550 通过 / 1 已知环境失败（bridge assets byte-for-byte）/ 2 跳过。
- translation + vfs-handlers：316/316。
- 全量 tsc：0 错误。boundaries（media/translation/vfs-handlers）：0 违规。

## 交接

- L12 vfs-index：`processing_progress` 的 percent 序列化 TS 为 `92`/`1`，Rust serde f32 为 `92.0`/`1.0`
  （triage files.processing_progress 组）；`serializeProcessingProgress` 归 L12。
- C2：`textbooks.add.pdf_render_error_recorded`（resources 行）与 `bili.link_item.offline_descriptor`
  step16（vfs_index_units 行）需 A/B trace 才能定位，本地无 runs 目录。
- media 未注册 Rust `MediaResourceCreatedHook`（短音频上传自动转写）；`autoTranscribeEligible` 已移植但无调用方。

# W04 第四轮进度

## 1. 自动转写钩子（完成 `88d6287`）

- `src/auto-transcribe.ts` 移植 `spawn_auto_transcribe_if_short_audio`，`index.ts` 经 `vfs.resourceCreatedHooks`
  注册（`ctx.effect` 释放），对应 `transcriber_hook.rs::install_vfs_hooks`。
- 语义：`setImmediate` 对应 `tauri::async_runtime::spawn`；vfs/pipeline/llm 任一缺失静默返回；
  `resolveAsrEndpoint` 失败 info 日志后跳过（Rust 无独立设置开关，ASR 槽位可解析即开关）；
  资格（仅音频、无字幕段、时长 < 10 分钟、无时长头 ≤ 10 MB）出错按 false；
  `startPipeline(id, null)` 失败 warn。并发/排队沿用 pipeline 运行中去重与 `mediaTranscriptionLock`。
- 触发点与 Rust 一致：`vfs_upload_file` 仅 `created && media_kind`；附件上传仅媒体。
- Rust 事实：`vfs_upload_file` 只对图片或 ≥ 1 MiB 落 blob，更小的非图片文件既无 blob 也无 `resources.data`，
  `resolve_media_source` NotFound → 不自动转写。G3 step 13 的 4844 字节 wav 在 Rust 中也未转写。
- 测试 `tests/auto-transcribe-hook.test.ts`（官方 profile）：G3 step 13 写序
  `resources I, files I, folder_items I, resources U` 与 Rust A1/A2 一致；≥ 1 MiB 短音频触发且首写为
  `files U(Queued)`；长音频/内联小音频/文本不触发。去掉注册后后两条为红。

## 2. percent 序列化（完成 `55b0b69`）

- vfs-index `serializeProcessingProgress`：percent 走 f32 最短位数 + zmij f32 布局（定点区间 [-6, 12]，
  整数补 `.0`），以 `JSON.rawJSON` 原子输出：`92.0`、`1.0`、`100.0`、`33.333332`、`1e-7`。

## 3. 两个差异（完成）

- `textbooks.add.pdf_render_error_recorded`：resources 行差异是归一化占位符编号随 `__change_log` 次序漂移的连带结果。
  实际差异：Rust 12 行、TS 11 行；TS 多记 `text_extraction` 失败并发出 2% 事件，缺 75/85/95 与 completed 事件。
  media 侧修复 `1f25604`：教材 PDF 流水线推迟到命令返回后启动（Rust `tokio::spawn`）。其余归 vfs-index（交接）。
- `bili.link_item.offline_descriptor` step 16：新 unit 25 列中只有 `id` 不同。A1 的随机主键排序位置与 A2 不同，
  所以 id 保持字面值，B 端被归一化成占位符。属归一化伪差异，非行为差异（交接）。

## 4. 终检（完成）

- media + translation + vfs-handlers + vfs-index：1192 通过 / 1 已知环境失败 / 2 跳过（153 文件）。
- 全量 tsc 0 错误；boundaries（四个目录）0 违规。

## 交接（第四轮）

- L12 vfs-index `pdf-runtime.ts`：Rust `run_pdf_pipeline_internal` 无 Stage 1 文本提取与 Stage 1.5 预览渲染；
  TS 在 `extracted_text` 为空时仍执行，多一次 files 写入、多一个 `text_extraction` failedStage 和 2% 事件。
  另外 `indexFile` 缺 Rust 85% 进度，总写入次数仍少 Rust 一次，需逐笔对齐 `update_processing_status`/`emit_progress`。
- X7 G3 归一化：按主键排序配对随机 id 时，A1/A2 位置不同会让 id 保持字面值，产生伪差异。
- 通用 f64 序列化：建议把 kernel `formatF64` 与 vfs-index f32 布局合并成 platform/util 的 `serdeF64Token`/`serdeF32Token`
  加一个 rawJSON 替换器，anki `config_json` 等落库 JSON 统一使用。sync-providers 现有同名副本，可一并收敛。

# 第五轮

## 1. vfs-index PDF 流水线对齐 Rust（`cbedb157`、`43c52b24`）

- 红测 `vfs-index/tests/pdf-pipeline-write-order.test.ts`（官方 profile，G3 `textbooks.add.pdf_render_error_recorded` 损坏 PDF）：
  `__change_log` 12 行 = `blobs I, resources I, files I, files U×4（Ocr 状态, Vector 状态, 75, 85）, resources U×3（index_resource）, files U×2（95, completed）`；
  事件 75/85/95 各一对 media-/pdf-progress，随后发 completed 一对；`processing_progress` 逐字节对齐 Rust。修复前为 11 行（红）。
- `pdf-runtime.ts`：删除 Stage 1 和 Stage 1.5，以及 `extractPdfText` 与索引后补的 `text` 模式；拆分 `callbacks.status`
  （`update_processing_status`，只落库）与 `callbacks.progress`（`emit_progress`）。压缩阶段写 status 两次后发 5%；
  OCR 阶段先写 status，再发 20%；向量阶段先写 status。`indexFile` 依 `stage_vector_indexing` 实现：
  `indexing.enabled` 门控、单元 indexing 跳过、无 resource 记为 issue、75/85/95；`index_resource` 出错只告警。
  image 向量阶段要求 `resource_id`；完成事件带上 `totalPages`/`mediaType`。
- 现有测试改写，按 Rust 语义：`pdf-runtime.test.ts` 首例原先断言流水线内会提取文本、渲染预览，
  现改为预览来自上传/backfill；压缩、OCR、索引断言全部保留，另加断言：status 写序、75/85/95、不出现 text_extraction/page_rendering。
  `native-pdfium.test.ts` R12-01 先经 `backfillMissingPreviews` 生成预览，PNG、压缩断言保持不变。

## 2. X7 补丁 vfs-index 部分复核（`e6d8d44f`、`43c52b24`）

- 吸收：`optimize_kb_tables`（放进与 Rust 同一 struct 对应的 `ChatLanceStore`，复用现有节流/优化 helper，
  不另复制一份 100 行代码）；`requeue_paged_pdfs_once`；`lib.rs:1646` 6 s 维护（建基础 RAG 表、chat/kb 优化）。
- 不吸收：
  - 把三件事放进 pre-ready finalizer。Rust 是 6 s 后后台执行，从不阻塞 ready。X7 的做法会让启动后、聊天流中提前出现 `rag_documents`，
    与已锁定的 WP-264 测试矛盾；Lance compact/prune 也会拖慢启动。
  - 无条件 requeue。Rust 只在 Lance 编译且 VfsLanceStore 初始化成功时才执行（`lib.rs:3534`）。
  - 在 `LegacyKbStore` 重复实现一份优化逻辑。
- 测试 `tests/startup-maintenance.test.ts`：有/无 Lance 两种情况；5999 ms 时仍无表；dispose 会取消定时器；kb 表只优化 `kb_chunks_v2_d*`，节流独立。

## 3. 可移植性扫描：跳过（worktree 中没有 `scripts/portability/scan.mjs` 和 `host/platform/{crypto,files}`）。

## 4. 终检

- 四个目录：1197 通过 / 1 已知环境失败（bilibili bridge）/ 2 跳过（155 文件）；全量 tsc 0 错误；boundaries 0 违规。
- `git status --ignored`：负责目录下只有 WP-219 旧日志被忽略，没有缺失的夹具。

## 交接（第五轮）

- X7/W13：B 端 runner 若需要 6 s 维护后的状态（`lance.optimize.last.*`、rag 表），应像 A 端一样等待该任务结束后再采集，
  不应把业务逻辑提前到 ready 之前。
- TS 仍没有 `start_vfs_index_worker` 的常驻消费循环（只补了它启动时的 requeue），需由 L12 owner 排期。

# 第九轮

## 1. W14 入口棘轮（`6fa52026`）

- `translation/index.ts`：`decodeBase64Standard` 改从 `platform/util/node.ts` 取（util 名单 `entries.test.ts` 那一行）。
- `media/src/textbooks-add.ts`：`extractFileName, getFileSize, hashFileSha256, isOpaqueDocumentId, readAllBytesBounded,
  resolveFileInfo` 改从 `platform/storage/node.ts` 取，`SqlExecutor` 仍按类型从 `api.ts` 取（storage 名单那一行）。
- 两份名单测试现在都因多出这两行而红，等 W14 收缩名单。

## 2. G3 `media.transcript.import_formats_and_errors` 进度竞速（未落地，只写设计）

本地 B 端复录（`g3-run-b.mjs`，需 `DEEP_STUDENT_BUILD_NUMBER`）加 11-06 triage 的结论如下。

- step 8/9/10 的返回值（A `percent 0`，B `92`）不是采集时机的问题，任何等待都改不了。Rust `start_pipeline`
  在写入 `queued` 后用 `tokio::spawn` 启动任务，`build_view` 读到的是 `queued`。TS `PdfProcessingService.startPipeline`
  则在同一调用栈内同步执行 `runTask`，命令返回前流水线已经跑到 `indexing 92`。
  修复办法：`runTask` 推迟到宏任务（与 `1f25604` 教材流水线同理）。代价是 `pdf-lifecycle.test.ts`
  的 WP-009/WP-192×3/WP-205×2 和 `media-failure-integration.test.ts` WP-205 共 7 条锁定测试要改。
  它们在 `startPipeline` 返回后立即断言 `requests`，或只用一次 `setImmediate` 冲刷。另外可移植的
  `setTimeout(0)` 排在 `setImmediate` 之后。断言本身不用改，但要改调度方式，所以这一项交给主代理审。
- step 9 之后和 step 17 的差异来自 A 端 `index_resource` 长时间停在 `indexing`（85）：A `resources.index_state=indexing`，
  B 立即 `failed`（`获取嵌入模型配置失败: 未配置默认嵌入维度`）。N-013 quiesce 只看 SQLite 文件和事件数，
  A 端安静地卡住时 quiesce 已判定稳定。
- 现有 `waitAfter` 表达不了"等这次流水线到终态"，原因有两个：
  1. `eventMatches` 只比较 `payload.eventType` 或 `type:phase`，而 `media-processing-completed` 的载荷两样都没有；
     省略 `event` 时 `undefined === undefined` 能碰巧匹配，但这不是文档化的用法。
  2. `waitForEvent` 匹配的是"已录制事件中任意一条"，所以同一场景只有第一次完成事件能当屏障，step 9/10 的等待会被 step 8 的完成事件提前满足。
  另外 A 端 15 s 内能否完成索引无法在本地验证，等不到就会把整个场景变成 runner-error。

# 第十轮

## 1. `startPipeline` 推迟到调用方返回之后（`3a4e6115`，已批）

- `vfs-index/src/pdf-service.ts:startPipeline`：同步占用 `running`、写起始阶段、登记 task，`runTask` 推迟一个宏任务
  （可移植的 `setTimeout(0)`），对应 Rust `pdf_processing_service.rs:724-735` 写起始阶段后 `tokio::spawn`。
  `media_transcript_import`（`dstu-media/src/media/commands.rs:470-478`）因此返回 `queued`/0%，第九轮 step 8/9/10 的返回值差异消失。
- 新测 `media/tests/transcript-import-change-log.test.ts`「subtitle import returns the queued view before the spawned pipeline runs」：
  官方 profile，返回值、DB 行、`isRunning`、返回时无进度事件；修复前红（`expected 'running' to be 'queued'`）。SPEC `:724-735` 一行已补。
- 7 条锁定测试只加了 `await spawnedTaskTurn()`（一个 `setTimeout(0)`，即被 spawn 的任务开始运行的那一轮），断言一字未改：
  - `pdf-lifecycle.test.ts:102` WP-009 新旧代次：两次 `startPipeline` 后各等一轮（:118、:122），旧任务进入 OCR 后才取消，`requests`/代次断言与原来同一时点。
  - `pdf-lifecycle.test.ts:164` WP-192 外层失败 ×2：`startPipeline` 后等一轮（:181），再走原有 `setImmediate`。
  - `pdf-lifecycle.test.ts:203` WP-192 重复启动：第一次启动后等一轮（:220），`before = getStatus` 读到的是已在运行的任务。
  - `pdf-lifecycle.test.ts:239` WP-205 最后原始进度 ×2：等一轮（:252）后再走原有 `setImmediate`。
  - `media-failure-integration.test.ts:232` WP-205 过期配置失败：两次启动后各等一轮（:242、:245）。
  修改前它们失败的原因都是"任务尚未开始"（`requests[0]` 为 undefined、`runningCount` 1≠0、`isRunning` 仍 true、reads 0≠2），不是行为变化。

## 2. RF-W04-rag-search-rerank-flag（`8d63f281`，proposed）

- `vfs-index/src/search-service.ts:searchCrossDimension` 只看请求的 `enableReranking`，不再要求初始迁移写成 'false'、没有界面能改的
  `search.enable_reranking`（Rust `indexing.rs:5221`、`:5249`）。没分配重排模型时与 Rust 相同；重排失败保留 RRF 序。
- 测试 `vfs-handlers/tests/search.test.ts` 两条（修复前红）。G3 无场景分配重排模型，不登记选择器。

## 3. `lance.optimize.last.*` 写入时机：源码已与 Rust 一致，未改代码

- 逐项对照 `chat-embeddings.ts`（先查节流，循环结束后不论有无表都记时间戳，同 Rust :922-927）、`startup-maintenance.ts`
  （启动后 6 s，先 chat 后 kb，`lanceEnabled()` 对应 `cfg(feature="lance")`）、`commands.ts:77-90`（`force ?? true`）、
  时间戳格式（chrono AutoSi，`+00:00`）。`tests/startup-maintenance.test.ts` 已覆盖 6 s 前不写、6 s 后两键、无 Lance 不写、kb 节流独立。
- 唯一差异：TS 的 6 s 从存储 finalizer（`index.ts:226-263`，ready 前）起算，Rust 从 setup 的 spawn 起算，量级相同。
- G3 中只有 A 端出现的 `lance.optimize.last.*` 行来自 runner：A 启动后等 8 s（`g3-run-a.mjs:155-159`），B 不等（`g3-run-b.mjs:121-127`）。交接 W13。

## 4. S01 的 S4：生图下载逐跳校验 + 25 MB 上限（`e25bd7a6`，RF-W04-image-download-redirect-cap，proposed）

- Rust `image_generation_executor.rs:611` 只校验第一跳；客户端（:172-175）默认跟随 10 跳不复检，`response.bytes()`（:657-661）不限大小。
- `media/src/tools/image-generation-executor.ts`：第一跳校验与报错不变；下载改走 `ctx.http.fetch(url, { destination: 'public' })`，
  每跳请求前复检（回环照旧放行），被拒报"生图 URL 指向被封锁的内网地址"；体积先看 Content-Length、读取中复核，超 25 MB 报
  "生成图片超过 25MB 上限"。没有 `ctx.http` 时 URL 结果明确失败，不退回不复检的客户端。没用 `public-pinned`：它不走代理，Rust 走代理。
- 测试 `media/tests/media-image-tool-executors.test.ts` 两条：302 到 `0.0.0.0:<端口>`（系统会路由到本机，修复前真的请求到了 `/secret`）、
  分块与声明长度两种超限。修复前两条均红；原有下载用例断言不变。

## 5. 其余事项

- 第五轮交接的常驻索引消费循环已有 `vfs-index/src/index-worker.ts`，关闭。
- office 交付在 `agentWorkspace` 未发布写入器时的显式报错（`media/src/tools/office-delivery.ts:121-124`）保留，作为移动端等无工作区宿主的降级。

## 交接（第十轮）

- W13：`scripts/electron-migration/record/g3-run-b.mjs:121-127` 应像 `g3-run-a.mjs:155-159` 在 ready 后等启动维护（6 s 任务）结束再采集，
  否则 A 侧独有的 `lance.optimize.last.*` 行会一直是 runner 造成的差异。第九轮第 2 项的录制侧问题（`waitAfter` 无法等"这次流水线到终态"）仍归 W13。
- W12：RF-W04-rag-search-rerank-flag 批准后，`host/e2e/smoke/__tests__/golden/10-vfs-index-worker.spec.ts:130-132` 可删掉写
  `search.enable_reranking=true` 的绕行。
- 残留（与 Rust 相同，记录不交接）：`public` 目标不防 DNS rebinding，只解析到回环的域名也放行；`public-pinned` 能防但不走代理。

# 第十一轮

## 1. 移动端入口：barrel → 可移植入口（`504d8d87`、`3bda654b`）

- 四个插件里取自 `platform/util/{index,api,node}.ts` 的导入全部改为 `platform/util/portable.ts`（同值，不含 ZIP/QR）；
  media 的 `extractFileName`/`isVirtualUri` 改取 `storage/file-names.ts`，`StorageError` 改取叶子 `storage/errors.ts`，`SqlExecutor` 改为 type 导入。
- `vfs-index/src/unified-retriever.ts`：`node:path` 的 `join` 换成字节等价的 `platform/util/path.ts`。
- `vfs-index/repository/embedding-dim.ts`：两个指纹函数改用 `platform/crypto/sync.ts` 的 `createHasherSync('SHA-256')`；
  新测 `tests/embedding-dim-fingerprint.test.ts` 对照 `node:crypto` 参考实现（ASCII、CJK + baseUrl 归一、空值、profileId 共 4 条），摘要逐字节相同。
- 保留：`media/src/bilibili-account.ts:9` 的 `util/qr.ts`（依赖 zlib，二维码只在桌面登录用）；`translation/src/ocr_extract.ts:7` 的 `paths/compat.ts`（文件本身就用 node:fs，等任务 4 一起处理）。
- `--mobile-readiness`（改前 → 改后）：media 网关 12 → 9；translation 7 → 4；vfs-index 网关 5 → 3、own 11 → 9；vfs-handlers 4 → 2；全部插件网关合计 151 → 138。
  剩余的 `storage/api.ts` 网关是因为 `defineQuery` 定义在 `storage/api.ts:224`，要 W14 挪到可移植叶子（W03 也提过）。

## 2. #27 检索可取消性：vfs-index 侧已修好，冒烟实测

- W24 的 `retrievalCancellable` 接线（`68b2ad7a`）已在 INT；`vfs-index/index.ts:154-157` 经 `untilAborted` 提供，
  `vfs/index.ts` 的 BuiltinRetrievalExecutor 注入依赖齐全。vfs-index/vfs-handlers 无需再改，W10 侧也无需改。
- 真实 Electron 冒烟（把 W12 分支的 ⑬ 与 support 文件临时放进工作区，跑完已恢复，未提交）：
  - ⑬「answer citing unified_search memory hit as [记忆-N]」去掉 `test.fail` 后通过（`[记忆-2]`，`unified_search:success`）。
  - ⑩ 第 4 条（chat unified_search 重排）：工具被提供并执行，发出 1 次 `/rerank`，`rerank:{requested:true,applied:true}`，分数 `[0.9,0.45]` 按重排序。
    唯一失败是用例读 `sources[].metadata.resourceId`，而 TS 与 Rust（`builtin_retrieval_executor.rs:1082-1107` `build_numbered_sources`）都把 `resourceId` 放在顶层——用例问题，交 W12。
  - ⑥ 没有 #27 的 `test.fail`（它的是 #25），无需动。
  - 复跑 ⑩（用例改读顶层 `resourceId`、删掉第 4 条的 `test.fail`、同时删掉第 3 条写 `search.enable_reranking=true` 的绕行）：4/4 通过。
    第 3 条不靠绕行通过，即 RF-W04-rag-search-rerank-flag 在真实宿主上生效。

## 3. W05 交接：ASR 走 `llmHttp`，不再用全局 fetch（`d5865dc3`）

- `media/src/voice-input.ts:sendAsrRequest` 增加必填的 `fetcher`，`transcribeWithEndpoint`/`transcribeVoiceInput`/`HttpAsrBackend` 逐层传入；
  生产由 `plugin-deps.ts` 的 `asrFetch` 每次请求时取 `llmHttp`（`voice_input_transcribe`、`media_transcribe` 工具、媒体转写后端三处共用）。
  进程内 LLM 回放因此能拦截 ASR；`llmHttp` 是 reqwest 等价的代理/重定向客户端，比原来的全局 fetch 更接近 Rust
  `dstu-media/src/voice_input.rs:445-451` 的默认 reqwest 客户端。调用方给的 90 s / 120 s 超时照旧生效（`proxy.ts` 用 `AbortSignal.any` 合并，仍报 `TimeoutError`）。
- 没有 `llmHttp` 时按网络错误失败（`network-failed`，"ASR request failed: LLM HTTP 服务不可用（需要 llmHttp）"），不发请求、不退回全局 fetch。
- 测试：`voice-input.test.ts` 新增「只经注入的 fetch 发送」（`.invalid` 回放地址）与「无 llmHttp 时网络错误且服务器零请求」，宿主用例断言请求经过 `llmHttp`；
  `storage-inject.test.ts` 两条宿主用例断言服务器收到的每个请求都经过 `llmHttp`；其余用例只补传 fetch，断言未改。
  W25 的真实 B 宿主用例 `host/e2e/streaming/wave0/llm-routes-b.test.mjs`（/audio/transcriptions 成功 + http-500）通过。
- 同类未改：`media/src/question-import-vision.ts:63` 的 VLM DOCX 抽取也默认全局 fetch。Rust（`dstu-vision/src/vlm_grounding_service.rs:771-775`）
  该客户端只设 30 s 连接超时、没有总超时（流式），而 `llmHttp` 总会加 300 s 总超时（`platform/http/proxy.ts:161`），直接换会截断长文档。交 W14 提供"无总超时"选项后再换。

## 4. 原先等 INT 的两项：INT 前进到 `fe5feb68` 后已做（合入 `0b11cfc5`）

- 任务 3（`31fbb292`）：`vfs-handlers/tests/command-error-settle.test.ts` 改用内核 `unsettledCommandErrors`（W01），保留 `EXTERNAL` 排除；
  `eslint-rules/command-error-settle.json` 的 guards 加 `host/plugins/translation`，`--update` 后它不再列在 unguarded。
- 任务 4（`54dd3ea4`）：`translation` 的 `ocr_extract_text` 临时目录和 `media` 的 `pdf_ocr_temp` 改用 F3 `fileManagerPaths.getTempAppDataDir()`，
  pdf_ocr_temp 落在活动槽目录，与 Rust `commands.rs:876-900` 一致。

## 5. 审计分派（INTEGRATION-NOTES 12:58）与自查 `.reports/reviews/`

- V03-01（`7fd7e072`）：自动 OCR 完成后按 `indexing.rs:3789-3833` 第 10 步写 `ready_modes += ocr`，并发 `media-processing-progress` / `pdf-processing-progress`
  （先于 `auto_ocr_completed`；`ocr` 已就绪也照发）。新增严格解析 `tryParseProcessingProgress`：进度 JSON 坏了就不写回、不发事件（`indexing.rs:3799` `if let Ok`）。
- V01-04（`9cab28c5`）：附件根目录命令改走 `ctx.vfs.attachmentConfig`（L17 `memoryConfig`），删掉 `vfsAttachmentConfig` 占位、测试 provider 和 lane 内的 `memory_config` SQL；
  测试改用真实 memory 插件。LANE.md 的 X6-SW-0140/0141 标为"已按 D1 改，待 R 复验"。
- #27：见第 2 节，已实测。
- V03-03（`f6898a34`）：转写的 `media-processing-progress` 顶层带 `stage`（`MediaTranscriptionProgressEvent`），键序与 Rust 相同。
- V03-05（`c848f6ef`）：教材监听事件和翻译流/候选事件改为全局广播（Tauri 2 `Window::emit`），删掉 window 透传；`dstu:change:*` 的 warn 文案对齐 Rust。
- S01 L4（`0a31f641`）：`tts.ts` 在朗读文本前加 `--`，以 `-` 开头的文本不再被 say/espeak 当成选项。新 RF：**RF-W04-tts-text-option-injection（proposed）**。
- V09 P2-5（`171e80e5`）：bilibili 浏览器桥 `start()` 绑定中途 `close()` 时丢弃晚到的 server，端口不再残留；之后 `start()` 仍可用。
- V09 P3-3（`d0f5acb8`）：`vfs-index/index.ts` 启动 finalizer 重复注册的注释改为实际行为（DUPLICATE / LATE_REGISTRATION）。与 W29 分支 merge-tree 无冲突。
- ASR 测试补 `llmHttp`（`c3ec083e`、`c848f6ef`）：`d5865dc3` 之后 media-failure-integration 和 L18-M05 的宿主缺 `llmHttp`，补上记录型替身并断言请求经过它。
- 不由 W04 做：V04-03/04 归 W29；V05 的两处文案等 W01 的 V05-02 根因修复；V08-06 等 W02 的 `toAgentJson`；V08-08 等 V08-01 根因修复（审计台账"待派"）。

## 6. W29 交接（`95a2fbca`，`.reports/agent-final/W29-1340-768b668f.md:120-133`）

- `recoverStuckTasks` 逐行复位：单行失败按 `pdf_processing_service.rs:3078` `.unwrap_or(0)` 跳过，其余照常复位；补齐 `Found N stuck tasks` / `Reset stuck file … to pending` 日志。
- 删掉没有生产调用方的 `resumeRecoveredTasks`（`pdf-service.ts`、`vfs-index/api.ts`），续跑由 W29 的 `resumeRecoveredTasksScoped` 负责。
- 预览回填登记进服务的 `tasks`：`dispose()` 先 abort 生命周期信号再等待；回填循环在文件之间检查信号，渲染也带同一信号，关停最多等当前这一页。
- 验证：临时套上 W29 分支的 diff 跑 `startup-recovery.test.ts` + `startup-maintenance.test.ts` 10/10 通过，随后已还原。

## 7. W07 交接（`b929338d`）

- `translation/src/ocr_extract.ts` 的 `ioMessage`（`paths/compat.ts`）换成 `ioMessageFor(error, posix)`，`posix` 由 `index.ts` 按 `ctx.app.platform !== 'win32'` 传入；
  `writableAppDataDir` 同样加 `posix` 参数。测试断言 POSIX 文案 `Not a directory (os error 20)`，另测非 POSIX 保留宿主原文。
- `vfs-handlers/src/upload-file.ts` 的 `decodeBase64Standard` 改从 `platform/util/portable.ts` 导入（结果随即复制成 `Uint8Array`，值相同）。
- `ocr_payload.ts:7`（W05 交接）、`getTempAppDataDir`、`pdf_ocr_temp` 三项此前已完成。

## 8. 终检（交付前一次，W04 tip 基于 INT `fe5feb68`）

- boundaries 0 违规；import-cycles 0 new / 0 stale；rust-fixes 64 条（approved 62、proposed 2）0 错误；portability `--check` OK（baseline 0 new、3 resolved）；
  `contracts:check` OK；heavy `tsc --noEmit -p tsconfig.host.json` 0 错误。
- `--mobile-readiness`（INT `fe5feb68` → W04）：全部插件 own 447 → 445、网关 98 → 95；media 网关 8 → 7，translation 3 → 1，vfs-index own 11 → 9；其余插件不变，无回退。

## 交接（第十一轮）

- W12（行号按 `assault/W12-desktop-smoke` 当前版本）：
  - `host/e2e/smoke/__tests__/golden/10-vfs-index-worker.spec.ts:130-132`：删掉 `vfs_set_indexing_config search.enable_reranking` 绕行（RF 已批）。
  - 同文件 `:145-148`：删掉 #27 注释和 `test.fail()`；`:149` 类型、`:165` 注解、`:169` 断言把 `s.metadata?.resourceId` 改成顶层 `s.resourceId`
    （Rust `builtin_retrieval_executor.rs:1082-1107` 的形状）。
  - `host/e2e/smoke/__tests__/golden/13-memory-roles.spec.ts:187-188`：删掉 #27 注释和 `test.fail()`。
- W14：
  - `host/platform/storage/api.ts:224` 的 `defineQuery` 挪到可移植叶子，四个插件剩余的 `storage/api.ts` 网关随之消失。
  - `host/platform/http/proxy.ts:161`：`requestTimeoutMs` 需要能显式表示"无总超时"（reqwest 不设 `timeout` 的客户端），
    之后 W04 才能把 `media/src/question-import-vision.ts:63` 的 VLM 流式请求从全局 fetch 换到 `llmHttp`。
  - `scripts/portability/baseline.json`：`--check` 报 3 条 resolved，可收紧（W04 不改 baseline）。
  - `host/platform/storage/index.ts:193-194` 的注释（"getPersistentAppDataDir / getTempAppDataDir 尚未在 api.ts 声明"）已过时，`ccabdba1` 已在 INT。
- W10：#27 无需改；`retrieval-rerank.ts:76` 的 `ctx.vfsDatabase` 问题上轮已交。
  另：`vfs/portable.ts` 在 INT 上还不存在。四个插件剩下的 `host/plugins/vfs/api.ts` 网关来自值导入 `VfsError`（vfs-handlers 11 处、
  `translation/src/tool_executor.ts:23`、`translation/repository/translations.ts:14`）、`createdEvent`（`translation/index.ts:14`、`media/src/register-bilibili.ts:6`）、
  `translationToDstuNode`（`translation/src/tool_executor.ts:22`）、`attachmentToDstuNode`（`media/src/register-bilibili.ts:6`）。
  W10 把这四个值放到可移植叶子后，W04 改导入即可（类型导入不影响）。
- W13：第十轮两项仍有效。

## 交接（第十一轮追加）

- W29：`vfs-index/src/pdf-service.ts` 已删 `resumeRecoveredTasks`（`vfs-index/api.ts` 同步删除），续跑只走 `startup-recovery.ts` 的 `resumeRecoveredTasksScoped`；
  `recoverStuckTasks` 现在自带 Rust 的两条 info 日志，W29 若另记日志会重复。`vfs-index/index.ts:258-260` 注释已改，与 W29 在 finalizer 注册块后的插入行 merge-tree 无冲突。
- W01：V05-02 根因修复覆盖 `media/src/tools/image-generation-executor.ts:180-181`（`errorText(error)`）和 `media/src/voice-input.ts:118`（`(error as Error).message`）；
  若 W01 决定改调用点而不是根因，交回 W04。
- W01（V08-01 根因）：修好后 `media/src/notes-export-docx.ts:66` 的 `structuredClone(spec)`（V08-08）自然消失；否则 W04 改用认识原子的克隆。
- W02：V08-06 的 `toAgentJson` 落地后，W04 删掉手写的 bigint replacer（当前行号：`vfs-index/src/pdf-preview.ts:128`、`pdf-runtime.ts:601`、`ocr-recovery.ts:275`、`pdf-processing.ts:202`）。
- W07 / 各 lane：`ioMessage` → `ioMessageFor` 的 17 处中，W04 的生产代码已改完；`translation/tests/ocr_command.test.ts:17` 是测试，不在扫描范围。

# 第十二轮（INT `390f244b`，合入 `552c8cf8`）

## 1. 交接收集

- W07 `7aff719f` 把 `ioMessageFor` 的第二个参数改成平台名：`translation/src/ocr_extract.ts` 与 `index.ts` 改传 `ctx.app.platform`（`ed0aa1d3`）。
  原来的布尔值在 win32 上也会套 POSIX 文案；测试用 `'linux'`，"非 POSIX"一例改用 `'win32'`。
- W29 复核 F2（`audit/reviews/W29-5e5cecd2.md:108`）：`95a2fbca` 的逐行 `catch` 把"owner 缺失"也吞掉，回收静默变成 0 行，
  启动处的 `[AppSetup] Failed to recover stuck tasks` 不再出现。改为循环前解析一次 owner（Rust `get_conn_safe()?`，`pdf_processing_service.rs:3035`），
  缺失就整体抛出；单行 SQL 失败仍按 `:3078 unwrap_or(0)` 跳过（`be3ef9ec`）。新测 `pdf-service.test.ts`「fails as a whole without the L11 files owner」，旧代码上红。
- W05（`agent-final/W05-1441-6f7bcaef.md:92`）：`translation/index.ts:100-103` 第十一轮已改用 `getTempAppDataDir()`（`54dd3ea4`），
  四个插件不再调用 `getWritableAppDataDir`，W05 可以删。
- W07（`agent-final/W07-1450-616d4a12.md:119`）`lance.optimize.last.*`：源码与 Rust 一致（第十轮第 3 节）；本地没有第七轮之后的录制，仍无法在录制上判断。
- 未做（依赖未进 INT）：W29 复核 F1（`startup-recovery.ts` / `index.ts` 的 finalizer 改 `late: 'skip'` + signal，需 W10 `5f4df9a8`）；
  F3（续跑循环接 signal，需 W01 的 `spawn(task(signal))`）；AL-10（`unified-retriever.ts:711` 复用 `safeBlobPath`，需 W10 先导出）。
- W13 的 `media.transcript.import_formats_and_errors` `waitAfter`：不加。第九轮分诊里 A 端停在 indexing 85，15 s 等不到会把整个场景变成 runner-error。

## 2. vfs 值导入改走 `vfs/portable.ts`：被边界规则挡住，改为补丁

- `vfs/portable.ts` 已在 INT，但 `scripts/electron-migration/lib/boundary-rules.mjs:47-50` 的 `isPublishedApi` 只认 `api.ts`/`api/index.ts`/`api.d.ts`，
  直接改导入会产生 17 条 cross-plugin-impl。补丁 `.reports/W04-handoffs/W04-vfs-portable-imports.patch`（17 个文件各 1 行，已按本轮拆分后的
  `tool_executor.ts:22`、`tool_save.ts:3` 重新生成）在 W09 放行 `portable.ts` 后直接 `git apply`。套上补丁的树 tsgo 无新错。
- `--mobile-readiness`（当前 → 套补丁）：全部插件网关 94 → 91；media 7 → 6，translation 1 → 0，vfs-handlers 2 → 1；own 不变。

## 3. 等前置的五项：INT 前进到 `2be7ed80`（合入 `f2eba58d`）后做了一项，其余四项仍未具备

- `defineQuery`（`4ca10b2b`）：W14 `45b3692a` 已进 INT，`defineQuery` 在可移植叶子 `platform/storage/query.ts`。六个仓储模块
  （`media/repository/media-ledger.ts`、`vfs-index/repository/{pdf,index-units,chat-lance}.ts`、`vfs-handlers/repository/{pdf,refs}.ts`）改从那里取值，
  类型仍 `import type` 自 `api.ts`。同一个函数（`api.ts` 原样重导出）。
- V05-02（`media/src/tools/image-generation-executor.ts:180-181`、`voice-input.ts:118`）：`kernel/error-model.ts:14-24` 的 `CommandError` 仍是 JSON 文本。
- V08-06：INT 没有 `toAgentJson`；手写 bigint replacer 现在在 `vfs-index/src/pdf-preview.ts:128`、`pdf-runtime.ts:427`、`ocr-recovery.ts:275`、`pdf-processing.ts:202`。
- V08-08（`media/src/notes-export-docx.ts:66`）：V08-01 根因修复未进 INT。
- `media/src/question-import-vision.ts:63` 换 `llmHttp`：`platform/http/proxy.ts:161` 仍无"无总超时"选项。
- 合并 INT `2be7ed80` 只有 `translation/src/ocr_extract.ts` 一处注释冲突：INT 的 `63d4a14e` 做了与 `ed0aa1d3` 相同的改动，取 INT 文案，四个文件与 INT 逐字节相同。

## 3a. `--mobile-readiness`（INT `2be7ed80` → W04 tip）

- 全部插件 own 411 → 411、网关 93 → 90；media 7 → 6，vfs-handlers 2 → 1，vfs-index 1 → 0（均来自 `defineQuery`）；其余插件不变，无回退。
- 再套 `.reports/W04-handoffs/W04-vfs-portable-imports.patch`（第 2 节，需 W09 先放行）还能再降：media、translation、vfs-handlers 各 −1。

## 4. Rust 对照与加固

- `translate_text` 分段（`678e370b`）：每遇到换行就把前缀 `join` 一次来判断段落结尾，O(n²)。80k 个换行密集字符在 Host 事件循环上阻塞 21.6 s，
  50 万字符上限时是分钟级。改为原地比对后缀，线性；Rust `split_translation_text` 本身是线性的，属移植缺陷，不登记 RF。
  新测：500 组随机输入与 `prefix.endsWith` 参考实现逐段相同；`'a\n'×250k` 切成 5 段 100k；`\r\n\r\n` 段尾。
- `SegmentCheckpoint::fail`（`translation_executor.rs:873-935`）：部分结果放不下时补上 Rust 的 warn 文案；两条测试覆盖"部分结果可读"和"checkpoint_unavailable + warn"。
- Rust `{:.N}` 正好落在 .5 时按偶数舍入，JS `toFixed` 向上（本机 rustc 1.98.1 验证）。影响的文案只在精确平局时出现：
  `media/src/document-guards.ts`（ZIP Bomb 各条）、`textbooks-add.ts:252`、`vfs-handlers/src/resources.ts:100`、`upload-file.ts:267`、
  `vlm-grounding-service.ts:356-357`（仅日志）。需要一个共享的 Rust 格式化函数，交 W14。

## 5. 拆分超长文件（行为不变，每个拆分单独提交）

| 原文件 | 行数 | 新文件 | 提交 |
|---|---|---|---|
| `translation/src/tool_executor.ts` | 1200 → 478 | `tool_args.ts`、`tool_segments.ts`、`tool_result_cache.ts`、`tool_save.ts` | `68002934` |
| `media/src/document-parser.ts` | 1362 → 836 | `document-errors.ts`、`document-xml.ts`、`xlsx-bounds.ts`、`document-guards.ts`、`document-epub.ts` | `b413c09b` |
| `vfs-index/src/pdf-runtime.ts` | 975 → 802 | `pdf-runtime-deps.ts`、`media-stage.ts` | `0f11c3a1` |
| `vfs-index/src/full-indexing.ts` | 942 → 756 | `full-indexing-types.ts`、`question-indexing.ts`（顺带删掉约 40 个早已不用的 import） | `0413204c` |
| `media/src/pdf-ocr-service.ts` | 890 → 773 | `pdf-ocr-sync.ts`（watch / 有界 mpsc / Semaphore / JoinSet） | `72a64cc3` |

- 原文件继续重导出原有的全部导出，类的公开方法保留为薄包装；`docx-images.ts`、`xlsx-formulas.ts` 改为直接导入新模块，顺带去掉它们与 `document-parser.ts` 的循环导入。
- 可移植性（`89c640e9`）：搬到新文件的 Node 用法会被 `--check` 当成 NEW（基线按文件记）。`document-guards.ts` 改用 `decodeUtf8Lossy`、结构化读 `code`，
  `xlsx-bounds.ts` 改用 `utf8ByteLength`（2 万组随机串与 `Buffer.byteLength` / `Buffer#toString` 的 `/Encrypt` 判定逐一相同）；
  输出 Buffer 的 `BoundedCursor` 留在 `document-parser.ts`，依赖 fs/os/crypto 的图片阶段和 `readBlob` 留在 `pdf-runtime.ts`。`--check` 0 new。
- 未拆（812–850 行，接近阈值）：`media/src/exam-sheet-service.ts` 850、`vfs-index/src/multimodal-service.ts` 849、`lance-store.ts` 836、
  `vfs-handlers/repository/refs.ts` 822、`media/src/bilibili-bridge-server.ts` 812。

## 6. 终检（交付前一次，W04 tip `4ca10b2b` 基于 INT `2be7ed80`）

- boundaries 0 违规；import-cycles 0 new / 0 stale；rust-fixes 85 条（approved 83、proposed 2）0 错误；portability `--check` OK（baseline 0 new、1 resolved）；
  `contracts:check` OK；heavy `tsc --noEmit -p tsconfig.host.json` 0 错误。
- heavy vitest（media、translation、vfs-index、vfs-handlers）：162 文件 / 1274 用例通过；唯一红是已知环境项
  `bilibili-bridge-server.test.ts` 的 `pair.html`（工作树没有 `src-tauri/`）。
- `--mobile-readiness` 见第 3a 节。

## 交接（第十二轮）

- W09：`scripts/electron-migration/lib/boundary-rules.mjs:47-50` 的 `isPublishedApi` 加上 `portable\.ts`（并补 boundaries 测试），之后 W04 套
  `.reports/W04-handoffs/W04-vfs-portable-imports.patch`。
- W14：`{:.N}` 的偶数舍入格式化放进 `platform/util`（见第 4 节）；`proxy.ts:161` 的"无总超时"；
  `vfs-handlers/src/pdf.ts` 经 `vfs-handlers/api.ts` 重导出带进 `node:fs`，移动端网关仍有这一条。
- W10：`vfs/src/upload-file.ts:111` 注释说 `toFixed` 与 Rust 相同，平局时不成立；`5f4df9a8` 进 INT 后 W04 改 finalizer 注册；`safeBlobPath` 导出后 W04 改 `unified-retriever.ts:711`。
- W01：V05-02、V08-01 根因修复仍需要。W02：`toAgentJson`。
- W13：`lance.optimize.last.*` 与 `waitAfter` 两项仍归录制侧。

# 第十三轮（INT `2be7ed80`，开工时已是祖先，无需合并）

## 1. 交接收集

- 上一任交付（15:24）之后新增的、提到 W04 的只有 A10（`agent-final/A10-1524-363970f0.md:15`）与 AL-13 的同一条：
  `vfs-index/index.ts:219-222` 索引 worker 在启动门超时后不启动 → 第 5 节已修。
- B 趟分诊 `server/land-test-B-16w/TRIAGE.md`：没有归 W04 的条目（host 6 例、fe 12 例都不在四个插件里）。
- R01 L3：上一任报告 `W04-1524-8ac02ad3.md` 第 144-170 行混入了英文过程文字（与 R01 指出的 `W04-1358` 同类）。已交付的报告不改，本轮报告不再出现。

## 2. AL-10 blob 相对路径越界（`c9560dd8`，RF-W04-blob-relative-path-escape，proposed）

- INT 上 `safeBlobPath` 仍是 `vfs-repos/repository/blobs.ts:125` 的模块内函数，`vfs`/`vfs-repos` 的 api.ts 都没导出，所以内联等价检查。
- `vfs-index/src/blob-path.ts` `containedBlobPath(blobsDir, rel, realpath?)`：拒绝空值、NUL、POSIX/盘符/UNC 绝对路径、`C:` 前缀、
  任一分隔符下的 `..`；拼接后必须严格在 `blobsDir` 内；给了 `realpath` 时再按真实路径比较（目标不存在保留词法结果，其余 realpath 错误拒绝）。
  经 `vfs-index/api.ts` 导出（media、vfs-handlers 原本就依赖 vfs-index/api.ts，不新增依赖方向）；只依赖 `platform/util/path.ts`，realpath 由调用方注入。
- 四个直接拼接点：`unified-retriever.ts` 词法与向量两条路由（命中保留，`imageUrl` 为 null；`runtime-adapter.ts` 注入 `fs.realpathSync`）、
  `vfs-handlers/src/attachments.ts` 的 `img_` 读取（warn 后跳过，最终 found:false）、`media/src/vfs-blob-path.ts`（`vfs_get_file_blob_path` 返回 null）。
  后两个文件顺带去掉了 `node:path`（portability resolved 1 → 3）。
- Rust 原有缺陷：删除路径有 `safe_blob_path`（`blob_repo.rs:894`），读路径没有；`Path::join` 遇绝对路径整段替换。登记 RF。
- 测试：`blob-path.test.ts` 5 例；`unified-retriever.test.ts` 词法、向量各 1 例（`../outside.txt`、绝对路径、符号链接，旧代码红）；
  `attachments.test.ts`、`vfs-blob-path.test.ts` 各 1 例。
- 其余经 `repos.blobs.getBlobPath`（W10，`vfs-repos/repository/blobs.ts:291`）读文件的地方（vfs-index 的 OCR/多模态/unit-sync，vfs-handlers 的 files/refs/pdf/upload，
  media 的 vfs-source/office-fidelity/figure-extractor，以及 chat-pipeline、qbank、vfs 等约 30 处）应在源头修，写交接给 W10。

## 3. AL-13 / AL-11 F2 与 W29 补丁对照（`14b09746`）

- 补丁的 `recoveredPendingMarker` = 本分支 `be3ef9ec` 的 `recoveredPendingWriter`（同一实现，名字不同），不重复加。
- 语义差异：W29 在查询卡住任务之前解析 owner，`be3ef9ec` 在查询和“Found N”日志之后。Rust `recover_stuck_tasks` 第一行就是 `get_conn_safe()?`（:3035），
  无卡住任务时也会整体报错、且不打“Found N”。按 Rust 改为最先解析。旧测试第 296 行断言“owner 缺失且无卡住任务返回 []”，断言的是偏差，已纠正为抛错，并断言无 info 日志。
- 补上 W29 的验证测试（`decode` 阶段、先解绑再构造 service）。

## 4. FM-08 bilibili 桥 `close()` 不清 `starting`（`7167ad77`）

- `close()` 只加 generation；关闭进行中再 `start()`，`??=` 复用注定被丢弃的 `listen()`，得到“浏览器桥已关闭”。`close()` 里清空 `starting`。
  新测“start() issued while close() is still pending …”，旧代码红。

## 5. A10：索引 worker 启动门超时后照样启动（`80c273fc`）

- Rust 在 setup 里无条件启动 worker（`lib.rs:3535`）。门 120 s 未就绪或报错时改为 warn 后启动，与 W29 `22c55626` 对续跑的处理一致。移植缺陷，不登记 RF。
  `index-worker-e2e.test.ts` 新增超时、报错两例（资源最终 indexed 且有 warn），旧代码红。
- `startup-recovery.ts` 的 `spawnResume` 同类改动在 W29 `22c55626`（D 趟），本轮不动该文件以免冲突。

## 6. 等前置（INT 前进到 `1d1fdb78`，合入 `c64ca50a`，四个插件无改动、无冲突）

- 合并后复查：W10 `5f4df9a8`、W14 `0aa2b2a8`/`d8656a26` 仍不是 INT 的祖先；`boundary-rules.mjs:48-50` 的 `isPublishedApi` 未放行 `portable.ts`；
  INT 无 `toAgentJson`；W01 `spawn(task(signal))` 未进；`host/kernel/error-model.ts:14-23` 的 `CommandError` 对非字符串值仍是 JSON 文本（V05-02）。
  F1、F3、`question-import-vision.ts` 换 `llmHttp`、vfs portable 导入、V05-02、V08-06、V08-08 本轮都不具备。
- `server/land-test-B-16w/TRIAGE.md`（15:59 版）仍没有归 W04 的条目。
- W32 的 RF-W32-blob-relative-path-traversal 修的是同步下载写入侧（dstu-sync `mod.rs:11328`），与第 2 节的读取侧互补，已在 RF notes 里写明（`12253865`）。

## 7. 拆分超长文件（行为不变，每个拆分单独提交）

| 原文件 | 行数 | 新文件 | 提交 |
|---|---|---|---|
| `media/src/bilibili-bridge-server.ts` | 814 → 624 | `bilibili-bridge-probe.ts`（能力探测） | `1f3c0237` |
| `vfs-handlers/repository/refs.ts` | 823 → 701 | `src/ref-injection.ts`（OCR 页解析、XML 转义、注入模式） | `dbb1ef08` |
| `media/src/exam-sheet-service.ts` | 850 → 721 | `exam-sheet-projection.ts`（存储行 → 会话详情投影） | `4135ec8d` |
| `vfs-index/src/multimodal-service.ts` | 849 → 775 | `multimodal-rows.ts`（Lance 行与 provenance）、`multimodal-progress.ts`（进度事件） | `417de4db` |
| `vfs-index/src/lance-store.ts` | 836 → 736 | `lance-maintenance.ts`（optimize / stats / schema 诊断） | `d1d90f70` |

- 原文件继续重导出原有导出；新文件只依赖可移植模块，portability `--check` 每次 0 new，import-cycles 0 new，tsc 0 错误。上一轮列出的五个接近阈值的文件全部拆完。

## 8. Rust 对照修复（均为移植缺陷，不登记 RF）

- `rasterize_images` 图片列表解析失败（`bb9bf747`）：Rust `serde_json::from_str::<Vec<String>>` 的 Display 是 `<code> at line L column C`，
  TS 原来用 `JSON.parse` 的 V8 文案。改用 `platform/util/json-exact.ts` 的 `JsonReader` 逐项读字符串。新测覆盖 `[1,`、`[`、`["a",]`、`[x]`、`["a"] x`、`[null]` 六例，旧代码红。
- bilibili 账号接口（`d4bd5b6b`）：Rust `AuthClient` 经 `BiliAttempt::native` 发请求（`bilibili_auth.rs:309-332`：15 s 截止、2 MiB 上限、严格 URL/DNS、
  浏览器头、只有 nav 带 cookie、信封严格 UTF-8）。TS 原来直接 `fetch`，无超时、无上限，错误文案是 `B 站请求失败（HTTP …）` / `B 站请求失败: …`。
  新增 `BiliAttempt.native()`，`AuthClient` 改为注入它；非 200 统一为 `B 站账号接口返回 HTTP ${status}`，`exit` 吞掉所有错误。
  测试改用真实 native attempt（`tests/helpers/bili-native-auth.ts` 只把域名重写到本地 fixture），新测覆盖头部、cookie、503、BOM 与非法 UTF-8、超限、断网文案。
  旧代码没有 `BiliAttempt.native`，无法在旧代码上跑出红。
- `try_auto_ocr_pdf_pages` 的 preview_json 边界（`76cfc27c`，`indexing.rs:3526-3551`）：Rust 对空白 preview 记 info 后跳过，解析失败返回
  `Failed to parse preview_json for file {id}: {serde}`，0 页单独记 info 后跳过。TS 原来三种情况都静默返回 null。
  `pdf-preview.ts` 拆出会抛 `JsonSyntaxError` 的 `decodePreviewJson`（`parsePreviewJson` 行为不变）。两边的调用方都只记日志，差异只在日志和错误文本。新测旧代码红。
- 只记录、不改：`pdf-runtime` 的"OCR 模型未配置或不可用"对 Rust `Failed to get OCR model config: {e}`（TS 是多引擎链，属架构差异）；
  `ocr-recovery` 多一次 `provider.available()` 预检；`page-rasterizer` 的位图转换合并进 `render`，所以没有 Rust `:146` 的"转换页面 N 位图失败"。

## 9. 终检（交付前一次，W04 tip `76cfc27c` 基于 INT `1d1fdb78`）

- boundaries 0 违规；`plugins/check-boundaries` 通过；import-cycles 0 new / 0 stale；rust-fixes 95 条（approved 92、proposed 3）0 错误；
  portability `--check` OK（baseline 0 new、3 resolved）；`contracts:check` OK；heavy `tsc --noEmit -p tsconfig.host.json` 0 错误。
- `--mobile-readiness`：INT `1d1fdb78` 与 W04 tip 的输出逐行相同，无回退。
- heavy vitest（media、translation、vfs-index、vfs-handlers）：165 文件 / 1293 用例，1290 通过、2 跳过；唯一红是已知环境项
  `bilibili-bridge-server.test.ts` 的 `pair.html`（工作树没有 `src-tauri/`）。另单跑 `qbank/tests/exam-sheet-session-commands.test.ts` 3/3 通过。

## 交接（第十三轮）

- W10：`vfs-repos/repository/blobs.ts:291` `getBlobPath` 直接 `join(blobsDir, blob.relativePath)`，约 30 处读文件经它走（第 2 节）。
  应在这里套 `safeBlobPath`（`:125`）的检查，并加 realpath 包含判断（逻辑见 `vfs-index/src/blob-path.ts:33-55`），越界返回 null；
  导出后 W04 把 `unified-retriever.ts:632/715`、`attachments.ts:81`、`media/src/vfs-blob-path.ts:57` 的 `containedBlobPath` 换成它。
  `vfs/src/upload-file.ts:111` 注释说 `toFixed` 与 Rust 相同，平局时不成立。`5f4df9a8` 进 INT 后 W04 改 finalizer（F1）。
- W09：`boundary-rules.mjs:48-50` `isPublishedApi` 放行 `portable\.ts`，之后 W04 套 `.reports/W04-handoffs/W04-vfs-portable-imports.patch`。
- W14：`proxy.ts:161` 的"无总超时"（`requestTimeoutMs: null`）；`{:.N}` 偶数舍入格式化；`vfs-handlers/src/pdf.ts` 带进 `node:fs`。
- W01：V05-02（`host/kernel/error-model.ts:14-23`）、V08-01 根因、`spawn(task(signal))`（F3）。W02：`toAgentJson`（V08-06）。
- W13：`lance.optimize.last.*` 与 `waitAfter` 仍归录制侧。W05：四个插件已不调用 `getWritableAppDataDir`。
- W29：`startup-recovery.ts` 的 `spawnResume`（`22c55626`）与第 5 节 worker 启动门的处理一致，W04 未动该文件。

# 第十四轮（接手 `ce495497`，INT `065a68f3`）

| 提交 | 内容 |
| --- | --- |
| `070cb3f4` | AL-17：保留 `containedBlobPath`，`blob-path.ts` 头注释改为按 AL-17；FTS / Lance 两条路由补目录符号链接行，并用插件装配和 `createRetrievalService` 各验一次生产 realpath |
| `a0ee7b3f` | L05：分段线性读次数测试（每码点 ≤ 4 次，旧实现 50-1500 次）；前两轮拆分的导出键快照；`checkpointFailure` 注释指向 `translation_executor.rs:928` |
| `e1774a32` | D4：translation `commands` / `ocr_command` 测试改用 llm-replay（Gemini thought 与读流失败两例仍用 stub，原因见提交） |
| `2c4c3cee` | 合 INT `065a68f3` |
| `0d101273` | AL-15 / F1：vfs-index 两个启动 finalizer 改 `{ late: 'skip', signal }`，去掉 `finalizerNames()` 守卫；卸载前未运行时由重装实例执行，启动后重装静默跳过 |
| `a5c518cc` | AL-16：`tools/runtime.ts` 的 `errorText` 改为 `errorDisplay`（W01 补丁的纯 re-export 没有本地绑定，改为 import + export）；`voice-input.ts:118` 同 |
| `42983c29` | `question-import-vision` 的 DOCX 流式请求改走 `llmHttp`，普通分支传 `requestTimeoutMs: null`（`vlm_grounding_service.rs:771-775` 不设总超时；Codex 分支照 Rust 用默认超时）；测试改用 llm-replay |
| `779738c0` | AL-11 F3：续跑循环接 `backgroundTasks.spawn` 的 signal，abort 时唤醒 2 s 等待并停止 |
| `929fc451` | AL-17 补充：office 工具读 `original_path` 时只接受与 `files.sha256` 一致的字节（`RF-W04-office-original-path-content`，proposed）；`RF-W04-blob-relative-path-escape` 的 notes 改为按 AL-17 |
| `8ada9cef` | W14 交接补丁：`vfs-handlers/src/pdf.ts` 读页图 blob 改走 `ctx.files` |

- AL-14 未做：四处 replacer 写的是库列（`preview_json`、`ocr_pages_json`、处理进度），按 serde 保留完整整数；`toAgentJson` 超过 2^53 会舍入，
  现有测试（pdf-preview、ocr-recovery、pdf-processing、pdf-lifecycle）钉住了精确数字。INT 里没有通用的精确 bigint 序列化（只有按 schema 的 `toRustJson`）。
- 已知差异：vfs-index 在启动后被重装时，`late: 'skip'` 让新实例的索引 worker 不启动（改前因 FINALIZER_LATE_REGISTRATION 同样不启动）。
  生产里 vfs-index 只 inject `storage`，只有显式重载插件才会遇到；要修需把 worker 启动拆成单独的 `late: 'run'` finalizer。
- Linux D 趟（`land-test-D`）四个插件无红。
- 待依赖：W14 `formatRustFixed`（`eb6f18ec` 未进 INT）；W09 `portable.ts` 放行未进 INT（`W04-vfs-portable-imports.patch` 在 `8ada9cef` 后需要重做 pdf.ts 一段）。

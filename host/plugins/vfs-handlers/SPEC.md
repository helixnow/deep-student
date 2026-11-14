# L13b 行为清单与接线状态（工作协议 v2）

## 文件上传主体准备（尚未生产注册，不计完成）

| Rust分支 | TS落点 |
|---|---|
| handlers.rs:2141-2185 OCR配置/严格base64/白名单/大小/hash | upload-file.ts::loadOcrStrategy/uploadFileInner；usize设置保持bigint，不先Number |
| 2197-2251 active复用/按旧文件类型判断压缩 | uploadFileInner/pdfPreviewNeedsCompression/imageNeedsCompression；Option状态字段省略，不发null |
| 2254-2269 根目录解析在保存点外 | rootFolder调用后重新获取conn |
| 2285-2423 PDF best-effort/zip清单/分页→整篇fallback | uploadFileInner，所有处理委托L11公开adapter；同源默认值等owner公开 |
| 2425-2499 同conn保存点/主blob阈值/文件三表/rollback/并发去重补偿 | saveUploadedFile/UploadSaga/repository/upload-savepoint.ts |
| upload_saga.rs:43-94 保存点开启/释放/rollback错误 | repository/upload-savepoint.ts，同原命名和错误前缀，无数据表SQL |
| upload_saga.rs:100-200 预览hash/压缩hash去重/逆序引用回退 | UploadSaga：仅本调用+1；缺失blob继续、错误warn、归零cleanup |
| 2524-2540 仅created时写ocr_pages_json | writeUploadOcrPages依赖，不能拿同时改updated_at的PDF写接口代替；待L11窄WithConn发布 |
| 2545-2668 OCR UTF-8阈值/Units/markFailed/状态文本 | uploadFileInner，ocrStatus/indexStatus/skipReason按skip_serializing_if省略 |
| 2670-2713 仅created通知媒体钩子/PDF图片后台pipeline/结果 | uploadFileInner/startPipelineLater；接口委托，未宣称spawn_blocking等价 |

入参仍计划经kernel的生成契约解码；当前未注册，因此没有实际IPC入站/返回验收。准备测试仅覆盖真实L11保存/补偿分支，不能当完整生产invoke；不增加TESTMAP ported。阻塞/待main接口见native-needs。后续按owner签名接真实ctx.vfsRepo.attachmentProcessing、mediaKind和ctx.vfs.attachmentConfig，再验证完整invoke与DstuUploadPort共用流程。

## ResourceCreatedHook（生产vfsHooks公开面）

Rust hooks.rs:118-136 → api.ts::ResourceCreatedHook/VfsHandlersHooks、src/hooks.ts::registerResourceCreatedHook/notifyResourceCreated。按每次注册独立身份和注册顺序快照；回调内增删仅影响下一次通知；错误不吞。生产provider仍由index.ts提供同一HookSet，无独立事件替身。L18实际短媒体回调以及上传通知尚待接线。

## pre-vector文件原语接真（main e60e7a771）

L11 `clearMediaCache(params,beforeVectorClear?)`已进入main，本lane将既有`clearVectorCacheDirectory`以第二参数接入，类型直接引用所有者API；原语仅按owner传入目录执行，时序由owner安排在OCR后、vector SQL前。依据Rust `handlers.rs:7161-7178,7295-7309`：不存在返回零、递归统计、统计失败取0后仍删除、删除错误传播给所有者warn继续，只有删除成功才计目录/字节。真实invoke回归验证阶段采样、缺列错误前已删除、删除失败warn后继续、成功计数及无目录。内部计长bigint，返回遵循已发布number字段；不添加大小拒绝策略。TESTMAP不增加条目，线程pending保持原状态。

## L11 main维护服务接线（9c13dfc39，最新）

- `vfsMaintenance`作为必需依赖，接口直接引用`vfs-repos/api.ts`的八方法；所有者实际provider负责连接获取及SQL。删除本地`repository/embedding.ts`、`repository/paths.ts`、media-cache中的清理/OCR写实现和`src/paths.ts`候选算法。
- `tests/harness.ts`不再安装维护替身；L11新依赖`paths`由F4真实`createPaths`提供，设备标识及所有路径固定在测试临时目录。三条路径原测试及重置/cache/OCR/子任务用例均经真实命令调用L11；子树失败触发器验证整事务回滚。
- Rust核对：路径读缓存→重算→1000 UTF-8字节内回写，批量路径BEGIN→更新→COMMIT/ROLLBACK（handlers.rs:1044-1228）；AI子任务一个SAVEPOINT、提交后才emit（todo_handlers.rs:1099-1140）；清理缓存的SQL仍由L11按顺序执行。
- `memory_config`附件根配置不属于这八方法。旧提议`vfsAttachmentConfig`当前尚未接线，测试替身仅附件配置测试显式安装。C2后续已确认L17候选`memoryConfig.get/set`和L13候选`vfs.attachmentConfig`现有业务层足够；集成后复用后者并删除旧提议/参考SQL，不再要求L17重造高级方法。候选提交及Rust无跨表事务的顺序见BLOCKERS。
- worker虽已随main出现，但未闭合F3维护屏障/日志传播，不消费`vfsWorker`，两线程保证继续pending。

## R3 修复续作（优先于历史待发布说明）

- R13-05 §6 EOF反例修复：对照serde_json 1.0.149 `de.rs::MapAccess.next_value_seed/next_key_seed`、`SeqAccess.next_element_seed`、`parse_object_colon`、数字解析。仅在JSON.parse报告EOF时扫描已消费词法token和容器栈：冒号/逗号后及未完整标量为Value，容器内完整成员之后为Object/List，未闭合字符串为String。引号内的括号/冒号和转义引号不改变容器状态。不再用整段首字符猜测；沿用UTF-8字节列和行定位。真实invoke测试覆盖R3三个精确反例、嵌套容器、键后缺冒号、逗号后截断、指数截断、中文与换行、exam前缀。

- R13-01：L12 `vfsIndexMaintenance` 和 `vfsUnitBuilder` 作为必需依赖直接接线；mm批量索引使用已发布 `vfsIndex.multimodal.processPendingBatch`。4个reset和1个single-pool原测试改走真实服务；单连接测试让后续 `storage.database()` 获取直接失败，验证sync命令不再借连接。
- R13-03：`index_service.rs:423-445` 的文件删除全链为SQLite删除/入outbox/刷新计数→text Lance→mm Lance；任一步错误传播给文件仓储命令，warn后仍软删。text失败不运行mm，符合Rust的`?`。`vfs_delete_resource_index`独立命令仍按其Rust要求逐模态warn继续，不与文件删除混用。
- R13-03定向验证：`vfs_delete_file`真实invoke三路径（成功/text失败/mm失败）；Lance回调仅采样持久化状态，全部断言移至invoke之后，避免业务catch吞掉断言失败。非零维度计数必须在首个Lance前归零；outbox包含准确row ID；soft-delete在其后；资源indexed/retry计数不变且旧full-indexing入口零调用。
- R13-04：`validate_id_format_any`先调用F4 `sanitize_unicode`，变化则以`ID contains invalid Unicode characters`拒绝，再检查前缀。batch记录warn并跳过，其他状态/取消/retry/start均不触碰下游。
- R13-05：Blob/PDF的连接、资源、来源表查询、blob元数据、路径和文件读取保留各步骤错误前缀；SQL NULL预览保持String读取错误；无行时source_table显示None/Some。PDF按types.rs:2851-2897全部必填字段/整数范围校验，仅接受camelCase；exam按models.rs:396-492的snake_case/default/Option结构解析，错误有exam专用前缀，Some("") hash保留为空值走blob查询。
- R13-06：删除本地LLM模型筛选、排序和默认回写副本，调用L02 `llmEmbeddingModels.getEmbeddingModelConfig/adoptDefaultMultimodalEmbedding`。AppError/CommandError取Rust Display的message字段；真实L02插件测试覆盖assignment读取失败、默认回写失败仍自动探测成功以及稳定字符串排序。
- R13-02仍不满足线程隔离。两条TESTMAP撤销错误的ported声明，CRUD/命令错误测试保持但重命名为补充测试。L11 `36a41507d` 完整树已有 `vfsWorker` 候选，待集成及F3维护屏障/主线程日志传递闭合；note搜索另等L10。具体签名和接入前提见BLOCKERS，不将主线程同步调用包装成Promise冒充修复。

## Q1 平台字符串/时间语义

- 来源：`handlers.rs::validate_file_size/parse_timestamp/vfs_get_all_index_status/vfs_debug_index_status/vfs_clear_resource_ocr`；`ref_handlers.rs::extract_file_text_with_strategy/get_essay_session_content_with_conn`；`todo_handlers.rs` AI 标题解析。
- 输入校验：Rust trim 使用 Unicode White_Space，U+0085 是空白、U+FEFF 不是；文件/笔记阈值、OCR length/charCount 使用 UTF-8 字节；会话截断按 Unicode 标量而不是 UTF-16 code units。
- 分支：OCR 与解析结果按字节数取长者；不足 1000 字节才调用文档解析；题目文本保持原文；非法 RFC3339 在列表排序映射为 0；索引总览额外接受无时区 SQL 时间并按 UTC 解释。
- 返回：沿用现有 generated DTO 字段及 null/缺省规则。时间读取使用 F4 `now()`；OCR 清理的 Rust 固定毫秒 `...Z` 使用 `toRfc3339Opts(...,'Millis',true)`，诊断时间使用固定毫秒加 ` UTC`，不替换成 AutoSi。
- 副作用：工具替换不移动现有写入、事务、事件位置；耗时统计对应 Rust Instant，使用单调时钟，不用墙钟差。
- 日志：纯 trim/计长/时间解析不新增日志；原命令日志仍在原分支。错误继续交现有 CommandError 映射。
- 测试：`tests/compatibility.test.ts` 走生产解析/校验函数，验证 U+0085/U+FEFF、闰秒、非法日期、字节长度。

## Q2 服务命名与装配

- 本插件提供 `vfsHooks`，版本描述 `vfsHooksService`，删除前 capture、成功删除后按顺序执行 continuation。
- 依赖按架构新名：`vfsDatabase`, `vfsRepo`, `notes`, `vfsIndex`, `retrieval`, `settings`, `docs`；LLM、题库、向量及尚未发布的专用服务必须显式声明为可选注入，不能以未声明 ctx.get 依赖隐藏接线。
- 提供者尚未更名时不能在生产设置旧名回退；需报告缺失的新名。测试可以显式适配真实提供者到待发布的新名，不能以替身冒充生产已接线。
- 导图与附件读取/删除已接 `vfsRepo`（Q6）；`vfsUnitBuilder` 和题库规范上下文读取仍按 HANDOFF 中最小接口逐项待接线。

## Q3 日志与测试真实性审计

- `ref_handlers.rs` OCR JSON 解析失败、无 pages、图片 OCR 查询失败、预览 JSON 解析失败：记录对应 warn 后返回 None/空结果；`.ok()`/`unwrap_or` 本身无日志处保持原本静默回退，不以 void catch 规避检查。
- `index_handlers.rs` Lance text/mm 删除失败：各记 warn，继续另一模态，返回独立成功标志与 retryable。SQLite 删除失败只更新返回 warnings 并提前返回（Rust 未发 warn）。
- `handlers.rs::vfs_get_attachment_content` 普通附件读取失败：记 error 后返回 `{content:null,found:false,error}`；img blob 读取失败记 warn 继续搜索；ID 格式错误记 error 后拒绝；超 maxBytes 直接拒绝。
- 原有序列化测试必须从生产函数/命令获得结果后断言 JSON 字段，不能只序列化测试自己构造的 DTO。
- 接线报告必须注明：本 lane 的权威 TESTMAP 仍由协调者维护在 `host/plugins/vfs/TESTMAP.md`；扫描空的本地 TESTMAP 不能证明 63 个待登记映射通过。

## 待接线与阻塞证据

见 `HANDOFF.md` 的逐项符号表及本轮报告。三条未注册上传命令仍要求真实的上传/预览/staged-file 能力；不得以注册后永远抛错或将整个命令改名为一个未实现服务的方法来完成计数。

本次协调者维护接线指令的实际合并状态见 `BLOCKERS.md`：main `8176f4199` 已解除 notes 装配阻塞，但 L11 的维护发布提交仍仅在 L11 分支。本 lane 保留相关 pending/参考实现，待真实提供者进入 main 后替换；测试真实插件入口导入已移除不再需要的 boundary-allow。

## Q7 question_sync_service 生效范围核对

- Rust 文件头 `:1-16`、`:2009-2010` 与 `src-tauri/src/lib.rs:3071-3074` 明确注销题库冲突 IPC，要求不得重新添加；真正冲突走 data_governance。全仓引用核对显示冲突策略、merge_versions、apply_keep_local 只在该退役模块及测试内使用。按 quality §8 不复活该功能；三个原测试申请 obsolete，批准前保持 pending。
- 生效部分是 `compute_content_hash`（`:471-517`）、`mark_as_modified_with_conn`（`:1518-1530`）和 `update_content_hash_with_conn`（`:1540-1556`）。L11 最新 `QuestionRepository.updateQuestion/submitAnswer` 已在真实写路径内实现同步状态和内容哈希，不在本 lane 重复写 questions。
- 哈希字段按 Rust 顺序：content、可选 options/answer/explanation、question_type、可选 difficulty、tags、非空 images、非空 structured_data；学习进度不参与。mark 只把 synced 改为 modified，其他状态保留；原函数无日志、无额外事务。
- `tests/question-sync.test.ts::test_content_hash_consistency` 用原 Rust 核心内容，经真实公开仓储重算并读取持久化哈希，验证重复计算相同、user_answer/attempt_count 变化不影响、题干变化会改变。不以测试中计算的哈希替代被测逻辑。
- L14 grading 等调用者若需要独立 `markAsModified/updateContentHash`，L11 当前仅发布 update/submit 包含的原子行为，仍需增补独立连接绑定符号；不能通过重写题干模拟此能力。

## Q6 Linux 续作：L11 导图与附件仓储接线

- main 已发布 `vfsRepo.mindmaps` / `vfsRepo.attachments`。11 个导图及 3 个附件读取/删除命令绑定这些真实仓储，不再等待提议的 `vfsMindmaps` / `vfsAttachments` 服务名。
- Rust 对照：`handlers.rs:5088-5351,1721-1978`。保留创建默认内容、50MB UTF-8 内容限制、mm_/mv_ 前缀、版本分页 1..500/默认100、manual/auto 白名单及非法来源 warn；缺失元数据/内容返回 null，仓储错误原文映射 CommandError。查询 debug 日志也恢复。
- 更新/恢复/删除的事务与版本快照完全由 L11 执行；调用层不拼接 SQL、不改变事务边界。附件 res_ 归一化失败拒绝，普通读取失败 error 后返回 found:false，img_ 超限仍直接拒绝；metadata 接受 att_/file_，删除仅接受 att_。
- 测试先补真实仓储接线用例：`tests/repository-wiring.test.ts` 经 Host invoke 验证持久化、历史快照、恢复备份、并发冲突不改内容、收藏/删除、附件 blob/资源别名/大小限制。保留原适配器测试的全部断言，替身改挂在公开仓储方法上。
- 保留 Rust 快照别名缺陷：`mindmap_repo.rs:1557` 的 snapshot 按 hash 复用当前 resource，而 `:670/:1987` 的 COW 判定只计导图，不计版本。单导图更新会让旧版本读到新内容；restore_backup 也可能随原地恢复一起改变。集成测试明确断言这两个事实，不修 Rust bug。共享导图走 COW 的旧版本内容保持不变。
- 附件 metadata 查询 `attachment_repo.rs:1874` 不过滤 deleted_at；内联 Base64 bounded 读取 `:2085` 使用 trim 后长度乘3除4的保守上界（忽略 padding），均按原行为测试。

## Q4 表所有者写操作交接（新协议优先于旧任务的本地 SQL 许可）

- 生产命令改为依赖 `vfsMaintenance`，最小业务接口在 `src/maintenance-needs.ts`；缺失时抛出明确待接线错误。没有旧 SQL 的生产回退。
- `repository/embedding.ts`、`repository/index-admin.ts` 的写实现及路径缓存写算法保留为待交接实现，由 `tests/pending-maintenance-provider.ts` 显式测试提供者调用。测试继续验证原状态/事务/孤儿队列，不能据此宣称生产已接线。
- 待 L11/L12 接收的各方法及语义：
  - `resetDisabledToPending`：仅 disabled→pending，清错误、重试次数和退避；返回更新数。
  - `resetIndexedWithoutEmbeddings`：indexed 且无 Unit/Segment 关联→pending；相同重试清零。
  - `resetAllIndexStateRows`：调用方先清 text/mm Lance，再按 Rust 顺序清 segments、units、维度计数和资源/文件/题目集索引状态；返回各阶段计数，失败不得改变已完成阶段的错误传播规则。
  - `resetUnitIndex`：读 Unit、校验模式 text/mm/both，required 模态才 pending，否则 disabled；资源调度状态与 Unit 必须在同一 IMMEDIATE 事务内更新，错误整体回滚。
  - `deleteResourceIndex`：收集行 ID、入 orphan queue、purge artifacts、刷新维度统计；调用方随后逐模态清 Lance，失败 warn 后继续并返回 retryable。
  - `clearMediaCache`：preview/compressed/OCR/vector 四独立分支，保留 reference-size 计数、先 decrement 再清扫、readiness 按模式删减；Rust 忽略的副作用错误不转成命令失败。
  - `clearResourceOcr`：资源 OCR→NULL，文件 resource_id 查不到时用 source_id，固定毫秒 UTC 更新时间；调用方 best-effort pending 失败记 warn。
  - `getResourcePath/updatePathCache`：路径以标题结束，1000 UTF-8 字节内缓存；子树批量更新一事务，失败 error/rollback；无 cache 或过长返回重算路径。
  - `setAttachmentRootFolderId/createAttachmentRootFolder/getOrCreateAttachmentRootFolder`：memory_config 旧键，fld_+10 位 ID，默认“附件”、根层、expanded=true/favorite=false；失效配置重建，不擅自添加事务或改变错误。
- 提供者尚未发布这些方法。当前 `vfs-repos/api.ts` 只提供分立 SQL-connection 仓储；`vfs-index/api.ts` 的 `VfsIndexingApi` 没有此组原子维护方法。此前 4 个 reset 和 3 个路径 Rust 测试去向改回 pending（保留全部测试断言）。
- L11 已发布 `vfsRepo`；测试中 `pending-provider-names.ts` 仅保留 L10 `notes@1`→`notes` 的真实服务转发，生产不安装该插件。L10 新名未发布前仍是生产装配阻塞。

## Q5 日志恢复单元的分支清单

| 单元 / Rust 来源 | 进入与成功日志 | 失败分支与副作用顺序 |
|---|---|---|
| note create/update/delete, handlers.rs:465/498/522/554/651 | title/id/content_len；成功 created/updated | 进入日志在参数验证前；delete capture→delete→continuation，不移动提交后动作 |
| refs, ref_handlers.rs:52-303 | sourceIds/includeFolderContents/maxItems；Got refs/totalCount/truncated；resolve 数量/找到数量；ref count id/count | 文件夹计数 unwrap_or(0) 无 warn；读取 refs 失败 warn 后继续；resolve 每条失败 warn+found:false；已解析的条目保留 |
| image OCR + OCR JSON, ref_handlers.rs:1313-1471, ocr_utils.rs:44-164 | image OCR 查询、找到长度与截断预览 | JSON 错误/无 pages warn 后空页；图片 OCR 空白/NULL/查询失败 warn 后 None；纯 SQL `.ok()` 的其他位置不凭空增加警告 |
| attachment content, handlers.rs:1726-1933 | START、res→file、img hash/字节数、metadata、SUCCESS/长度 | 无效 ID error+拒绝；未关联 file warn+not found；blob 不在库/文件丢失/读取失败 warn 继续；普通内容读取 error 后 envelope；img maxBytes 仍拒绝 |
| index status, handlers.rs:4234-4789 | folder/type/state；返回资源数；聚合总数/indexed/pending/stateFilter | index_state 缺列 warn+空结果；查询错误 error 后传播；不能把聚合过滤改成 stateFilter |
| index deletion/batch, index_handlers.rs:69-280 | mode/limit/raw limit、批量成功失败数、删除 resourceId | SQLite 失败只返回 warnings；text/mm Lance 失败各 warn 后尝试下一模态；删除结果保持独立标志 |
| dimension/defaults, handlers.rs:3287-3822 | toggle id与状态迁移、创建/绑定/删除/设置默认 dim/modality/model | 客户端模型名不可信 warn；无模型绑定设置默认前后各 warn；悬空默认 warn 后清；Lance 删除失败 warn 不阻止 DB 删除结果 |
| batch/reindex/reset, handlers.rs:3162-3199/3868-3887/5863-6014 | reindex id、批量 size/读配置/claim前后、reset 前后数量和清 Lance 模态计数 | 已 indexing warn+拒绝；embeddingDim 非空 warn 后忽略；逐资源失败 warn+失败事件；向量不可用在 claim 前拒绝 |
| PDF state/retry/list, handlers.rs:6512-6778 | id、start stage、batch count、list limit和结果数 | 无效 batch id、getStatus 失败 warn 跳过；畸形文件行 warn 跳过，不使整批失败 |
| cache/OCR/chunks, handlers.rs:6817-7899 | stats 开始/各计数、clear flags/释放量、OCR id/完成、chunks id/条数 | 按 Rust best-effort pending failure warn；清目录失败 warn 后继续 SQL；不得将整个 processing_progress 清空 |
| mindmap, handlers.rs:5093-5337 | create title/folder、restore/update/delete id、favorite | versionSource 非 manual/auto warn 后转 manual；存储异常原样映射字符串 |

日志使用插件 logger；仓储解析/诊断函数接收 logger 参数。测试验证附件内容读取失败的 error 日志和 Lance 部分删除失败的 warn 日志，并保留继续处理/返回形状断言。

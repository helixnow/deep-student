# L12-vfs-index 独立验收（R3-review-vfs，2026-11-04）

结论：不通过

**卸载错误候选复核（2026-11-05）**：7847ae733＋ab947994d在解绑L11 owner前abort/clear当前媒体任务，已有isCurrent检查阻止晚到状态回调；owner guard及测试断言保留。亲取原上传5例及联合181文件1609通过/2跳过，均exit0，无Unhandled；限定候选通过，尚非main，见§23。

**R12-08最小补测条件已满足（2026-11-05）**：bebb5ea64直接调用生产parser保留三raw f32值及1e40→Infinity；原snapshot/wire期望未变，重复补测已撤回。已亲取原102806一例及103110四文件41例全绿/type0，当前ccd402ae7目标闭包无未提交diff。R3对本条L12语义/测试边界的合入条件解除；全F4/L18 Value最终组合仍待C1，整lane及主线16组不连带签收，见§22补证。

**R12-08待合闭包静态复核（2026-11-05，0442f61e6）**：5615公开IgnoredAny/f32消费、ec39内部number与出站nullable分离正确；8b三条getStatus最短十进制期望应保留。已亲取原Node286/286及typecheck0，不重跑。当前缺生产parser的raw f32独立断言，已要求L12仅补原三输入raw值及1e40→Infinity，保现有snapshot/wire期望；结论为该最小补测后可合限定闭包，非全F4/L18或整R12签收，见§22。

**R12-01 Lance-disabled限定复核（2026-11-05，d77bd5dbd）**：独立源码/断言核对及复用原始075942回执确认：batch在drain/claim前返回(0,0)，单资源保文本/OCR及OCR后二次Unit同步，晚到vector可被下一轮识别；L02错误夹具真实vector-enabled。只签该候选子项；Node仍283通过/3失败、typecheck仍L13 nullable错误，整组与16组主线未决不变，详见§21。

**B12-16已独立确认并归L11（2026-11-05）**：真实主线`vfs_set_indexing_config`反例`20261105060922-2be279`确认合法chunk_size="+16"后overlap="16"被错误接受，普通"16"则正确拒绝。正式编号R11-07，详见vfs-repos ACCEPTANCE §12；不撤销本页配置副本移除的候选结论，也不在R12重复计组。L12仍8组，跨lane总未决现16组。

**R12-06 primary恢复错误顺序候选（2026-11-05）**：固定ca2ac9d5d，本人`20261105052749-1f0863`四分支通过（4passed/33过滤、exit0、无Errors），确认恢复标记失败不覆盖sync错误，只有非retryable＋discard失败合并错误，WARN/ERROR顺序保留。候选非main、整组仍开，见§20。两旧KB审批e4680aa8a现已main，仅限原两ID，由L12更新去向。

**R12-06 marker策略候选通过（2026-11-05，9888d2148）**：本人`20261105050113-cc676f`两个新触发器用例通过（2passed/31过滤、exit0、无Errors），确认primary indexing标记失败WARN后仍提交、additional同一步失败回滚其metadata并请求discard后继续。仅候选子项，未签实际原生discard或全部日志；主线15组不变，见§19。

**R12-05候选账本纠正（2026-11-05，a7cf18fbf）**：两条旧KB测试退回pending、全部断言保留，候选实际77ported/2pending/0obsolete；尚无approvals.json批准。独立Rust引用核查支持限定dead-in-rust申请，交C2裁定。维度解析改测活跃ChatLanceStore，原六项输入/期望不变，本人`20261105043638-b9fe1a`一例通过。该纠正不等B闭合，见§18。

**R12-03配置副本移除候选（2026-11-05）**：固定99da3ecec（实现3e087ab85/185b88eb9），L12删除仅测试使用的配置写SQL/validator副本；测试改用真实L11公开仓储，原文案/成功读回断言保留并加强code/param检查。本人`20261105041644-ae0fe8`为1passed/30过滤、exit0、无Errors。只确认该所有权子项，候选非main、整组未决，见§17。

**R12-03 settings-owner固定小集补齐（2026-11-05）**：按C2请求，复用同c28e272d4的精确WARN/read-failure两例，只补跑其余四例，`20261105040042-379c36`为4passed/15过滤、exit0、无Errors。现在六条要求均有固定候选独立证据，不再借WIP四绿签收；仅settings写归属/所测路径失败与节流子项候选通过，整组及main状态不变，见§16末。

**settings-owner红项复核（2026-11-05）**：固定c28e272d4，原WARN失败与新增settings读失败默认值两例经本人`20261105035112-044faf`通过（2passed/17过滤、exit0、无Errors）。原buffer默认阈值滤掉WARN，现显式exporter保留原条件并增加精确文案；不是删除日志断言。候选未main、R12-03整组仍开，详见§16。

**R12-06.additional-unit候选通过（2026-11-05）**：固定ee05933a9目标闭包，本人`20261105024831-a11588`两分支通过（2passed/29过滤、exit0、无Errors）：真实状态UPDATE失败不覆盖InvalidState原错误，普通Other继续并保留WARN及后续Unit处理。只签候选该子项，依赖Lance store故障接缝不冒称原生故障或kernel覆盖；main未集成，整组不关闭，见§14。

**C2限定5+1候选复核（2026-11-05）**：同61a2e77c4实现闭包，新增OCR临时文件五例＋真实F7媒体索引一例经本人`20261105020149-da37c7`通过，2文件6passed、exit0、无Errors。确认MIME helper生产调用、字节/清理/文本落库，以及Linux真实Lance metadata回读和primary/additional的i64链。候选未main；共享ocr_semaphore、完整LLM及三平台未签，原组数不变，详见§13。

**最新候选复核（2026-11-05，61a2e77c4）**：R12-02.owner-error三例与R12-09真实owner/consumer联合写链三例均经本人作业`20261105014804-945753`通过，6passed/13过滤、exit0、无Errors。候选现已同时含9006bc168和5aaf3bc8a；main f2d5b6c46仍缺消费修复，两个主线勾选保持未决。F7原生vector、PDF wire缺口不连带签收，详见§12。

**R12-02最新主线复核（2026-11-05）**：五个transport字段的批次再校验作业`20261105011329-b19913`通过，真实L02默认优先级/不可用配置回退写回/唯一模型探测在`20261105011609-a4c169`通过。但同一公开索引入口复现 **R12-02.owner-error**：无模型时把AppError JSON而非Rust message拼入错误，整组仍未决。详见§11；总未决仍15组。

**R12-07主线复验（2026-11-05，main a9683a43b）**：本人真实L12插件/SQLite公开服务及kernel命令断言作业`20261105004229-9531a3` exit0，确认open失败跳过、null样本补齐、scan失败容忍、schema错误仍传播、chat优化遇坏表继续。关闭本编号原已发现差异；外部Lance为脚本化故障供应商，不宣称F7原生流或整个索引等价。原编号未决从9降至8，详见§10。

**Linux续作基线（2026-11-05，main e9df01a3c）**：已同步main。9006bc168为祖先，5aaf3bc8a不是祖先；因此尚无双方修复的联合树。L11 unit/segment精确读写已集成，但当前`repository/index-units.ts:501-513`仍把i64饱和加一结果`Number(next)`，经`src/lance-store.ts:163-169`和`src/embedding.ts:121-127`进入生产写链。R12-09保持未决，不能以owner测试通过关闭消费者精度缺口。26b85c095、0fb54cdde、21e8175c2也尚非该main祖先，§8–9候选结论不自动升级。本轮运行结果统一见R3汇总的“Linux续作”节。

**R12-03新子项（X6-SW-0179）**：21e8175c2无embeddingDim的状态写分支已委托真实L11，同conn保留indexed_at/维度/资源业务时间；本人20261104154913-89292e为1通过/28过滤、exit0。只确认所有权与所测状态语义，additional-unit路径缺warn及状态写错误未按Rust忽略仍归R12-06，详见§9。main1e893eb61已有显式transaction Scope owner传递及原fallback删除，不再把早期WeakMap自动丢失描述当作当前所有路径事实。

**R12-08新候选及wire缺口**：26b85c095已接F4 JsonReader，服务读取/进度写回最小作业20261104142645-d02d0a为9通过/6过滤、exit0、无Errors。但真实kernel探针20261104143042-824c5b发现 **R12-08.wire-percent**：合法f64输入1e40在f32溢出后服务输出percent:null，debug命令结果却被仅允许number的契约拒绝。组级不关闭；已回派L12/C2协调F5成功响应契约，详见§8。

**R12-09 owner候选增量（9006bc168）**：L11 generation读/缓存/绑定/返回改为精确number|bigint；本人20261104125122-2d4f6f真实仓储测试1通过/4过滤、exit0、无Errors，覆盖2^53+1和i64::MAX。仅确认unit→segment owner子链，L12公开text/mm写链与F7组合尚未在包含双方修复的树上独立跑通；R12-09不整组关闭，详见§7。

**v2主线增量（eeaf5bdc7）**：指定7f827f303/b49b0e913/6116ded59已在main；PDF/multimodal的局部SQL fallback删除确认，R12-03仍有unit/segment及事务句柄owner丢失路径。OCR条件写接口缺失仍静默跳过，不能称原子缓存已完成。generation读取过滤子链通过，但生成/写segment仍Number丢精度，新增R12-09，详见§6。R12-08正在修复，本轮不连带签收。

**提供状态登记（不签收）**：协调者通知 `675eb70ff` 完整树新增summary、PDF重提与MediaTranscriber候选；已确认提交存在（该提交自身为媒体完成segment counts增补）。本轮仅审L13b维护消费，不据此关闭L12 owner重复写表、exam近似或其他原未决项，不新增L12重测试；待具体消费入口/剩余修复证据再定向审读。

**D1/D4 更新（C2 05:14 指令）**：按 main `e30395712` 中 `d1b03dff9` 的裁定，所有者业务API接受/传递SqlExecutor本身合规；§5对新维护方法的所有者调用方向确认继续有效。R12-03 的剩余依据是 L12 **直接写 L11 表的SQL副本**，不是事务参数，所以不因该裁定关闭。其余组未在本轮扩大复核。

**定向复核更新（C2 04:25 指令）**：读取 main 固定快照 `29bc10a470c9d50ed80671cfb232c0bdee972b1b` 后，R12-01/03/06 部分子项已有修复，详见 §5。以下原始清单和亲跑结果属于首次基线；其中“没有 unitSync/缺 unitSync 日志”等旧描述由 §5 更新，不再代表新快照。8个组级必须修复项仍未闭合。

审读基线：`f23c9870282cc95907661df6dae3cdf6cb232fa1`。原无 ACCEPTANCE。`R/` = `src-tauri/crates/dstu-vfs/src/vfs/`，`T/` = `host/plugins/vfs-index/`，`H/` = `host/plugins/vfs-handlers/`。实现者说明只用于查找已登记差异，不作为等价证明。

## 必须修复

- [ ] **R12-01（高，部分实现）生产索引/PDF/多模态流水线未完成。** `embedding@1`、`pdf@1` 没有实际提供方；apply 仅依赖 storage，启动时捕获可选服务。`createIndexingServices` 没有传 unitSync/ocrRecovery/多模态 embedding；缺 unitSync 直接 return，缺 OCR 跳过恢复，可将无文本资源标 indexed；多模态两个索引方法即使传 embedding 也无条件 throw。PDF 启动成功返回后只能发“runtime unavailable”错误。这些是未实现业务而非平台等价降级。应接真实提供方并补原阶段；未完成能力不能算已迁移。（证据：`T/index.ts:58-66,166-175`、`T/src/runtime-adapter.ts:46-49,198-242`、`T/src/full-indexing.ts:142-154,245-266`、`T/src/multimodal-service.ts:159-179`、`T/src/pdf-service.ts:196-222`；Rust：`R/indexing.rs:2169-2199,2452`、`R/multimodal_service.rs:216-339,1283`、`R/pdf_processing_service.rs:2969-3000`。）
- [ ] **R12-02（原指纹/选择子项通过，owner错误边界仍须修复）**：主线已委托完整LLM配置，五个transport字段变化均被公开索引入口发现，真实默认优先级/回退及写回场景已通过。剩余**R12-02.owner-error**：`src/embedding.ts:7,26-29`读取CommandError.message，把整个AppError JSON拼入“获取嵌入模型配置失败”；`llm/src/embedding_service.ts:15-18`实际抛此envelope，`kernel/api.ts:88-94`的Error.message是JSON。Rust `embedding_service.rs:125-130`应使用AppError Display，即`dstu-core/src/models.rs:1038-1041`的message。本人`20261105011609-a4c169`通过真实L02/L12公开服务复现，需保留步骤前缀并消费原message；再读取失败/embedding transport同类包装也需沿调用点核对。详见§11，不再按旧“完全丢endpoint”派修。
- [ ] **R12-03（高，架构）重复实现并写入 L11 拥有的表。** resources、files、vfs_index_units/segments、vfs_embedding_dims/profiles 的写入在 L12 另有 SQL，而 L11 已提供对应仓储。SQL 放在 repository 并不等于符合“单表一个写插件”。应调用 L11 api 的原子操作，缺少的方法由所有者补齐。（证据：`T/repository/index-state.ts:276-295,410-451,473-482`、`T/repository/embedding-dim.ts:502-551`、`T/repository/pdf.ts:59-65,86-131`；所有者 `host/plugins/vfs-repos/index.ts:11-16,35-41`；规范 `docs/plugins/ARCHITECTURE.md:61-65`；Rust 原逻辑 `R/repos/embedding_repo.rs`、`R/repos/embedding_dim_repo.rs`、`R/pdf_processing_service.rs:2896-2939`。）
- [ ] **R12-04（高，静默省略）启用 reranking 后仍静默保留 RRF。** 生产构造没有注入 rerank；`enableReranking && config.enableReranking` 时因 undefined 跳过调用及失败日志。Rust 会实际调用 reranker，失败才 warn 后保留 RRF。（证据：`T/src/runtime-adapter.ts:223-242`、`T/src/search-service.ts:226-243`；Rust：`R/indexing.rs:5205-5234`。）
- [ ] **R12-05（高，测试/接线）module-level wiring 绿灯掩盖 symbol-level 未接入。** 全 host 检索显示 `compressImagePath`、`new ProcessingSlots`、`imageExtensionForMime` 仅被测试调用；`hasRetriableFailure` 仅定义/再导出/测试。`searchExecutionBackend`、`shouldDisableIndexForMissingNote` 也只有定义和测试，生产另写判断。其 TESTMAP 仍 ported。保留同义断言，并接到真实调用点或暂改 pending；不能用 api 再导出证明真实使用。（证据：`T/TESTMAP.md:25,31-32,47-58`、`T/src/pdf-processing.ts:16-35,80-98`、`T/api.ts:180-183`、`T/src/indexing.ts:67-68`、`T/src/full-indexing.ts:208-219`；Rust 原测试 `R/pdf_processing_service.rs:4370-4534`、`R/indexing.rs:5280,5355-5399`；扫描器只判断“至少一个所测模块可达”：`scripts/electron-migration/wiring.mjs:75-79`。）
- [ ] **R12-06（中，日志）Rust warn/error 分支被静默化。** clear_message_embeddings 的 Lance 删除错误只抛 envelope、没有 error；embedding 重试只有 sleep；unit sync 通用失败空有注释、没有 warn；PDF 不可重试阶段直接 return 无 warn。应恢复各分支原日志，不改变传播策略。（证据：`T/index.ts:112-117`、`T/src/embedding.ts:40-46`、`T/src/full-indexing.ts:142-153`、`T/src/pdf-service.ts:294-300`；Rust：`src-tauri/src/commands.rs:2069-2072`、`R/embedding_service.rs:363-387`、`R/indexing.rs:2192-2198`、`R/pdf_processing_service.rs:3002-3007`。）
- [x] **R12-07（main原差异复验通过）**：`T/src/lance-store.ts:714-773`恢复open失败跳过、count失败默认0、scan失败继续、null样本补齐，schema失败保留原前缀并传播；`T/src/chat-embeddings.ts:208-225`跳过打不开的表并继续优化。本人`20261105004229-9531a3`经真实插件公开服务和kernel命令逐项断言通过，exit0。Rust对照`R/lance_store.rs:2466-2487,2507-2512,2533-2564`、`src-tauri/crates/dstu-vfs/src/lance_vector_store.rs:903-919`。范围及供应商边界见§10；初审问题描述保留于审计历史。
- [ ] **R12-08（中，wire/持久数据兼容）PDF 状态可选字段及进度解析不等价。** getStatus 总是返回 `error/startedAt/completedAt:null`，Rust 为 None 时省略；进度用 JSON.parse 后强转类型，合法 JSON 的 `null`/`{}` 不回退默认，旧 snake_case alias 不转 camelCase，percent 未做 f32。应按 Rust serde 类型读入并按 skip_serializing_if 输出。（证据：`T/src/pdf-service.ts:146-166`、`T/repository/pdf.ts:28-42`；Rust：`R/pdf_processing_service.rs:225-250,283-300,2925-2939`；契约 `contracts/ipc/_shared.json:1270-1344`。）

新增必须修复（D3增量，非既有八组自动扩大通过）：

- [ ] **R12-09（高，i64 generation写链仍丢精度）**：`repository/index-units.ts:643-655` 在safeIntegers读取并+1后仍 `Number(next)`；`:399-422` batchCreateSegments普通查询generation并经integer/Number回写。`src/lance-store.ts:163-169`、embedding.ts:121-127实际生产写链使用前者。main队列探针20261104111425-0a593d实测next(9007199254740992)返回9007199254740992，unit=9007199254740993时segment写成9007199254740992。应让生成→Lance行→unit/segment→比较全链精确，不靠拒绝合法i64解决。（Rust `src-tauri/crates/dstu-vfs/src/vfs/lance_store.rs:289-311,374-389`；D3/standard-v2 §1.3。）

## 建议

- [ ] 更新已过期的缺依赖说明：`T/SPEC.md:198-209` 仍说 L11 未改名/服务无消费者，与当前 L11/L13b index 相反。
- [ ] `T/index.ts:31-151` 的解析和业务分支移入 src，入口只接线（规范 `quality.md:51`）；无需新增通用框架。

## 已核实通过

- [x] **复核确认**：三个自有 IPC 名称及 null/固定对象形状匹配契约；`clear_message_embeddings` 对字符串 i64 用 bigint 排序去重，未经过 Number。（`contracts/ipc/L12-vfs-index.json:5-117`；`T/index.ts:31-40,70-101,189-195`；`T/repository/chat-lance.ts:105-120`。）
- [x] **复核确认**：三个服务 lowerCamelCase 名、版本、meta.provides 与 ctx.provide 对应。（`T/api.ts:16-18`；`T/index.ts:56,67,176-177`。）
- [x] **复核确认**：生产 import 未直接跨入其他插件实现，未见 console 或 tests 导入；但这不能抵消 R12-01/R12-03。
- [x] **复核确认**：选取的分块、Markdown/translation 提取、RRF 标度测试真实调用 TS 函数，断言未弱于原 Rust（明细如下）。
- [x] **复核确认**：79 条 TESTMAP 全为 ported，无实际 obsolete/merged，未借审批跳过测试；运行146条测试通过，但 ported 的生产接入状态仍有 R12-05。

## 1. 命令调用链抽查（15 条）

本 lane 自有命令仅3条，已全部审读；另沿12条 L13b 命令审 L12 服务。不能把这些消费方命令改计为 L12 自有命令。

| 命令 | 结论 / 核对重点 | TS 证据 | Rust 证据 |
|---|---|---|---|
| clear_message_embeddings | 问题 R12-06；空数组、trim、i64、stable id、去重、初始化失败跳过、DB删除失败 error 后成功均对齐 | `T/index.ts:70-127`; `T/repository/chat-lance.ts:105-130` | `src-tauri/src/commands.rs:2013-2084` |
| optimize_chat_embeddings_table | 问题 R12-07：开表错误未跳过；force=true、days=0、优化动作失败error继续、30分钟节流保留 | `T/index.ts:130-151`; `T/src/chat-embeddings.ts:116-222` | `src-tauri/src/commands.rs:2089-2105`; `src-tauri/crates/dstu-vfs/src/lance_vector_store.rs:884-965` |
| optimize_lance_database | 通过：保留原命令明确 no-op，4个固定字段；未擅自优化 | `T/index.ts:189-195` | `src-tauri/src/commands.rs:6899-6910` |
| vfs_search | 通过所查薄层：空白拒绝，topK默认10，FTS结果字段/score=1 | `H/src/search.ts:51-59`; `T/src/search-service.ts:63-75` | `R/handlers.rs:3133-3151` |
| vfs_rag_search | 问题 R12-04；统一规划、scope、RRF归一化路径保留，但生产 rerank 缺失 | `H/src/search.ts:62-93`; `T/src/search-service.ts:195-243` | `R/handlers.rs:4940-4966`; `R/indexing.rs:5151-5234` |
| vfs_get_lance_stats | 问题 R12-07；text默认和过滤空表保留，打开表失败策略不同 | `H/src/search.ts:96-103`; `T/src/lance-store.ts:699-709` | `R/handlers.rs:4971-4986`; `R/lance_store.rs:2466-2487` |
| vfs_optimize_lance | 通过所查服务逻辑：默认text，全部 dim/queryable profile 表；错误传播 | `H/src/search.ts:105-112`; `T/src/lance-store.ts:677-684` | `R/handlers.rs:4990-5005`; `R/lance_store.rs:2404-2433` |
| vfs_diagnose_lance_schema | 问题 R12-07：错误容忍和 null sample 不同 | `H/src/search.ts:115-122`; `T/src/lance-store.ts:711-756` | `R/handlers.rs:6473`; `R/lance_store.rs:2493-2587` |
| vfs_inspect_retrieval_capabilities | 问题 R12-01：inspect(false)只读路径存在，但运行时模型/OCR依赖未真实接齐 | `H/src/search.ts:125-133`; `T/src/retrieval-service.ts:330-333`; `T/src/runtime-adapter.ts:46-76` | `R/handlers.rs:6355-6368` |
| vfs_multimodal_index | 问题 R12-01：生产页索引无实现 | `H/src/search.ts:256-280`; `T/src/multimodal-service.ts:159-169` | `R/handlers.rs:6081`; `R/multimodal_service.rs:216-339` |
| vfs_multimodal_index_resource | 问题 R12-01：来源索引无实现 | `H/src/search.ts:283-302`; `T/src/multimodal-service.ts:171-179` | `R/handlers.rs:6420`; `R/multimodal_service.rs:1283-1303` |
| vfs_get_pdf_processing_status | 问题 R12-08：缺行null正确，存在行的Option/旧JSON不等价 | `H/src/pdf.ts:49-57`; `T/src/pdf-service.ts:146-166` | `R/handlers.rs:6505-6524`; `R/pdf_processing_service.rs:2896-2943` |
| vfs_cancel_pdf_processing | 通过L12所查取消语义：无任务false；abort+删除，generation防旧任务覆盖；L13校验另有问题 | `H/src/pdf.ts:59-67`; `T/src/pdf-service.ts:263-285` | `R/handlers.rs:6534-6552`; `R/pdf_processing_service.rs:2947-2961` |
| vfs_retry_pdf_processing | 问题 R12-01/06；允许四状态、缺文件文案、媒体起始阶段对齐，但无执行阶段/拒绝重试warn | `H/src/pdf.ts:69-78`; `T/src/pdf-service.ts:294-306` | `R/handlers.rs:6559-6578`; `R/pdf_processing_service.rs:2969-3012` |
| vfs_start_pdf_processing | 问题 R12-01；stage默认/解析存在，但 native执行空缺 | `H/src/pdf.ts:80-94`; `T/src/pdf-service.ts:196-222`; `T/src/pdf-processing.ts:9-12` | `R/handlers.rs:6593-6619`; `R/pdf_processing_service.rs:190-209` |

## 2. ported 测试逐条复核（20 条）

Rust 文件前缀 R/，TS 测试前缀 T/tests/。“断言通过、接入问题”不是 B 通过：纯函数本身可正确，生产仍未用它。

| 原测试 | Rust 文件:行 | TS 文件:行 | 结论 |
|---|---|---|---|
| legacy_cross_dimension_flag_always_selects_unified_profile_planner | `indexing.rs:5280` | `indexing.test.ts:4` | 断言同义；函数只供测试，R12-05 |
| compatibility_scores_preserve_weighted_rrf_order_and_chat_thresholds | `indexing.rs:5292` | `indexing.test.ts:8` | 通过：1/.5/0/NaN分支 |
| test_chunk_fixed_size | `indexing.rs:5301` | `indexing.test.ts:15` | 通过：同输入/配置、非空、UTF-8最小长度 |
| test_chunk_semantic | `indexing.rs:5317` | `indexing.test.ts:21` | 通过：同段落配置；原测试亦仅非空 |
| test_extract_markdown | `indexing.rs:5332` | `indexing.test.ts:27` | 通过：去图/粗体 |
| test_extract_translation | `indexing.rs:5343` | `indexing.test.ts:33` | 通过：含源文和译文 |
| test_missing_note_with_inline_data_keeps_indexable_fallback | `indexing.rs:5355` | `indexing.test.ts:38` | 断言同义；函数只供测试，R12-05 |
| test_missing_note_without_inline_data_disables_index | `indexing.rs:5379` | `indexing.test.ts:44` | 断言同义；函数只供测试，R12-05 |
| ocr_temp_image_extension_follows_mime | `pdf_processing_service.rs:4370` | `pdf-processing.test.ts:4` | 断言同义；未接生产 OCR，R12-05 |
| cancelled_compression_does_not_read_or_decode_the_file | `pdf_processing_service.rs:4382` | `pdf-processing.test.ts:76` | 真实测待移植函数且额外断言不读；但无生产调用，R12-05 |
| processing_slots_are_shared_and_waits_are_cancellable | `pdf_processing_service.rs:4397` | `pdf-processing.test.ts:10` | 同占满/取消/释放断言与100ms超时；无生产调用，R12-05 |
| cancelled_processing_does_not_consume_a_free_slot | `pdf_processing_service.rs:4428` | `pdf-processing.test.ts:21` | 同不占permit断言；无生产调用，R12-05 |
| test_processing_stage_as_str | `pdf_processing_service.rs:4440` | `pdf-processing.test.ts:26` | 值断言同义；仅identity helper，不证明实际序列化 |
| test_processing_stage_from_str | `pdf_processing_service.rs:4447` | `pdf-processing.test.ts:31` | 通过：pending/OCR/unknown；命令真实调用 |
| test_processing_stage_order | `pdf_processing_service.rs:4463` | `pdf-processing.test.ts:36` | 所抽3组顺序同义；排序helper未被生产阶段调度使用 |
| test_processing_progress_default | `pdf_processing_service.rs:4470` | `pdf-processing.test.ts:41` | 值同义；生产getStatus另写defaultProgress，R12-05/08 |
| test_has_retriable_failure_with_retriable_ocr_issue | `pdf_processing_service.rs:4480` | `pdf-processing.test.ts:45` | 断言同义；生产未消费，R12-05 |
| test_has_retriable_failure_without_issues | `pdf_processing_service.rs:4494` | `pdf-processing.test.ts:50` | 断言同义；生产未消费，R12-05 |
| test_has_retriable_failure_ignores_non_retriable | `pdf_processing_service.rs:4506` | `pdf-processing.test.ts:54` | 断言同义；生产未消费，R12-05 |
| test_has_retriable_failure_from_persisted_json | `pdf_processing_service.rs:4522` | `pdf-processing.test.ts:59` | 该有效fixture断言同义；未覆盖生产serde默认/alias，R12-05/08 |

## 3. 亲自运行（原始输出摘要）

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/vfs-index
Test Files  14 passed (14)
     Tests  146 passed (146)
  Duration  17.46s
REVIEW EXIT: vfs-index 0

$ node scripts/electron-migration/importable.mjs host/plugins/vfs-index/index.ts
importable: ok
$ node scripts/electron-migration/wiring.mjs --lane vfs-index
合计 ported 79，其中所测模块未从 index.ts 接入 0（0.0%）
```

测试全部通过不证明流水线完成。例如 `T/tests/pdf-service.test.ts:62-71,90-115` 用显式 runtime 替身测状态机，并且另测“无 runtime 必然报错”；这两者均不能作为真实 PDF 执行证据。

## 4. 架构与语义差异分类

- **通过**：命名/提供对应、跨插件 import 边界、无生产 console/测试目录导入、Node入口可导入。
- **问题**：R12-01/02/04 是省略步骤或错误的配置替代；R12-03 违反单表所有权；R12-06/07 改变错误和可观测性；R12-08 改变持久JSON与wire形状；R12-05 是接线/TESTMAP证据失实。
- **已登记的平台/能力差异**：`T/SPEC.md:183-207` 登记无 vector/embedding/OCR/PDF 阶段，`VfsLanceDisabled` 对应 Rust 无 lance feature 的空读/拒写分支。它只证明 feature-disabled 子集，不能代替有 lance 的桌面能力，也不批准 R12-01 的业务省略。`decisions.md:52-59` 的时钟精度是平台已决事项；`SPEC.md:20` 的 panic 契约有 `decisions.md:13-15` 支持。本轮不重审内核。
- **测试/审批**：无本 lane obsolete/merged 审批需求；79个 ported 的模块扫描为绿，符号实际使用仍有上表问题，B 级不成立。

## 5. C2 定向复核：unit builder / maintenance / 日志（2026-11-04）

### 新证据基线与方法

固定审读 `29bc10a470c9d50ed80671cfb232c0bdee972b1b`（开始复核时的 main），不随 main 后续移动更新证据。通过 `git show <SHA>:<path>` 读取；本节所有 TS 行号均指该快照。已读提供方相关提交及其祖先树：`56f3e9f1d`、`4355749d9`、`d0df9e65f`，新增实现/测试还包含于 `3812e7927`、`c6168c499`、`97f65704c` 等检查点。特别核实 `56f3e9f1d` 本身仅改 api.ts 一行，不能单凭提交标题声称整套服务在该 diff 中实现。

本轮是**提交对象的静态定向复核**，阅读真实入口与测试断言；未将这些实现取出覆盖本工作树，未运行旧工作树测试冒充新 SHA 测试，未采信提供方报告的通过数。首次 Vitest 结果只证明首次基线。下面的“确认”不包含本轮动态通过声明。

### R12-01 子项

- **静态确认修复：生产 unitSync 已接入。** `T/index.ts:176-190` 创建 `VfsUnitIndexService`，经 `repositories: () => ctx.get('vfsRepo')` 延迟取真实所有者，提供 `vfsUnitBuilder`/`vfsIndexMaintenance`，并把同一实例传给 `createIndexingServices`；`T/src/runtime-adapter.ts:203-223` 将 `syncResourceUnitsForResource(...).length` 注入 full indexer。旧“生产没有传 unitSync”撤销。
- **静态确认已有真实仓储调用链**：`T/src/unit-sync-service.ts:89-104` 构建 unit → `repos.embeddingUnits.syncUnits` → 非空时 `repos.indexStates.setIndexState`，复用同一数据库句柄；对应 Rust `R/index_service.rs:124-181`。这确认接线与所查编排，不是对全部资源 builder 的无条件等价验收。
- **静态确认修复：空 pages 分支先于 embedding 可用性判断。** `T/src/multimodal-service.ts:238-253` 在 pages=[] 时先清理再返回 `{indexed_pages:0,dimension:0,failed_pages:[]}`；对应 Rust `R/multimodal_service.rs:260-286`。其清理调用 `:210-227` 的 SQLite→Lance best-effort→disabled 顺序，与 Rust `:919-949` 的阶段顺序一致；旧“两个索引方法始终 throw”应收窄为“非空页及 source 索引仍 throw”。所有权/事务实现仍见 R12-03，不因这一分支修复获批。
- **新增 batch 接口已有生产消费者，但不是已完成多模态索引。** `T/src/multimodal-service.ts:145-207` 实现取样/资源去重/claim/失败回退；`H/index.ts:307-308` 会取得该方法，`H/src/index-admin.ts:98-101` 调用。`unit-maintenance.test.ts:211-238` 只证明预期的缺能力失败路径，不证明成功写向量。非空页 `:250-253` 和 source 索引 `:256-264` 仍硬抛错；batch 也尚未实现 Rust `force_rebuild=false, refresh_counts=false` 的内部索引 options 路径（Rust `R/multimodal_service.rs:1163-1175`）。
- **仍未修复**：`T/src/runtime-adapter.ts:214-232` 未传 OCR recovery/多模态 embedding；PDF runtime 仍为 `pdf@1` 可选查找。新输入解析还省略 Rust 两个现有分支：`T/repository/unit-sync.ts:52-68` 不做旧多页 PDF 分页重提（Rust `R/indexing.rs:2093-2103`）；`:71-82` 的 exam 直接用 resource.data、OCR=null，而 Rust `:2127-2153` 读取 qbank canonical document/context_text。特别是 `T/src/unit-builders.ts:228-231` 的 exam builder 消费 OCR pages 而不消费 data，不能把这个 fallback 认作 canonical 接线。均保留在 R12-01 原“省略阶段/分支”组内。

### R12-03 子项

- **静态确认新交接方法符合所有者调用方向**：`T/src/unit-sync-service.ts:114-136` 在 IMMEDIATE transaction 内通过 L11 的 unit/state 方法完成 reset；`:140-156` 按 getUnits→收集row IDs→L11 purge（含孤儿队列）→L11 refreshCounts 顺序完成 SQLite 删除，返回 `{resourceId,deletedUnitCount,lanceRowIds}`。对应 Rust `R/index_service.rs:285-354,375-414`。新 `repository/unit-sync.ts:29-95` 仅含读取SQL。
- **组级未修复**：`repository/index-state.ts`、`repository/embedding-dim.ts`、`repository/pdf.ts` 在首次基线与新 SHA 间 **无 diff**；原 resources/files/profile 等重复写入仍在。新 `multimodal-service.ts:210-227` 的清理也继续使用 L12 的 SQL 副本。不能把发布维护服务等同于所有写路径已迁至 L11。
- 新服务描述 `T/api.ts:20-22` 只有 name、缺 version；旧三服务的命名/版本通过结论不自动覆盖这两项新声明，需按 ARCHITECTURE §3 补齐。

### R12-06 子项

- **静态确认修复 unitSync 日志分支**：`T/src/full-indexing.ts:142-159` 成功记录同步数量 debug，普通失败 warn 后继续，unsupported resource_type 仍标 disabled 后抛出；`T/src/runtime-adapter.ts:221-222` 确保真实注入回调返回数量。对应 Rust `R/indexing.rs:2169-2199`，日志恢复不改变错误传播顺序。
- **其余保留**：clear_message_embeddings 的 Lance error、embedding 重试 warn、不可重试 PDF 状态 warn 的原缺失仍在；相关 `src/embedding.ts`/`src/pdf-service.ts` 与首次基线无 diff。R12-06 不整组勾选。

### 实际测试入口/断言审读

| 新快照测试证据 | 真实入口及断言 | 本轮确认范围 |
|---|---|---|
| `T/tests/unit-maintenance.test.ts:51-65,101-118` | 安装真实 reposPlugin/index 插件；从 ctx 取 vfsUnitBuilder；sync后验证1条unit、更新文本、资源pending、未再取storage.database | 是真实服务路径，不是手写Unit字面量；未亲跑新快照，也不把 spy 等同于 Rust 线程/连接池饱和测试的全部保证 |
| 同文件 `:131-169` | ctx.vfsIndexMaintenance 的 text/mm/both及非法模式，断言4个持久状态 | 覆盖真实新reset编排；不证明L13命令已消费它 |
| 同文件 `:171-180` | SQLite trigger拒绝资源状态更新，断言unit/resource四状态均回滚 | 有意义的原子性断言；本轮静态核对 |
| 同文件 `:185-206` | ctx维护服务删unit，断言orphan row_1及维度计数0 | 证明测试目标是SQLite部分；未断言后续text/mm调用顺序 |
| 同文件 `:211-238` | 真实vfsIndex.multimodal.processPendingBatch，断言[0,1]/failed/缺L02错误 | 仅失败回退；不能据此关闭多模态成功路径 |

在所读 `unit-maintenance.test.ts`、`multimodal-service.test.ts`、`index-service.test.ts` 中未找到针对新空页分支或 unitSync warn/debug 的专门断言；本轮不新增测试文件，也不将静态恢复描述为动态回归已通过。

**结论**：R12-01/03/06 有上述已确认子项；R12-02/04/05/07/08 保持原未决结论，未重审成“已修”。组级计数仍为8，B仍不成立。

## 6. R12-03 / D3 已保存单元与 main复验（2026-11-04）

指定静态起点 **6116ded597d01e0b47b65c3844508d9501bba37d**（含7f827f303、b49b0e913）。中断期间提供方继续提交da6219572等，最终主线固定 **eeaf5bdc7ae95a336c34b3a75b19f844726fe064**，由审计提交57b8270c6合入当前工作树；非审计实现保持与该main一致。本节最终结论以main为准，不把整棵WIP失败归责给三个单元。

### 通过的局部修改与仍未决的所有权

- `repository/pdf.ts` 的cancel/recover/error/preview/extracted/OCR/progress等setter已改为requirePdfFileOwnerMethod；multimodal-source.ts:73-96必须经files/exams所有者，不存在旧“无owner即直接UPDATE”分支。**确认这批fallback已删除**；不是仅在owner存在时调用一次后仍保留写副本。
- main L11 `types/files.ts:65-77` / `repository/files.ts:786-862` 已有cancel/status等真实实现，不再用初始6116树“main没有这些符号”的旧注释判当前状态。
- **R12-03仍开**：`repository/index-units.ts:194-246,350-435` 的ensurePrimaryUnit/setUnitIndexProfile/replaceSegments/batchCreateSegments直接写L11 unit/segment/orphan表，生产 `src/full-indexing.ts:578-600` 实际调用，不是孤立测试副本；index-content.ts的clearTextIndexRowsForResource同样保留。chat-lance.ts:94-102写F4 settings、:123-130删chat_user_embeddings也未走对应owner API。
- **事务接缝不能靠WeakMap掩盖**：owners.ts在db对象上绑定；index.ts:165-173只绑定vfsDb；F3 `database.ts:408-434` 事务传入新Scope对象。embedding-dim.ts:411-438和index-state.ts:284-300在tx对象查不到owner仍回到本地SQL。D1允许传递同一事务执行器，不允许因为执行器对象不同自动变成第二写者。应改为显式所有者业务方法/携带owner，不改变Rust事务边界。

### OCR原条件、更新时间与错误策略

Rust indexing.rs:1078-1086、3483-3489都是**单条**`UPDATE resources SET ocr_text=? WHERE id=? AND (ocr_text IS NULL OR ocr_text='')`，不动updated_at；写失败warn后仍返回提取文本。b49b0e913取消了“先读getOcrText、再调用会改updated_at的saveOcrText”的非原子替代，接口方向正确。

但main `repository/index-content.ts:181-196` 缺saveOcrTextIfEmptyWithConn时直接return；全L11检索无该方法。owner-writes测试用recording owner证明参数委托，**不证明原条件/DB时间/并发原子性**。缺方法静默不缓存是未完成，不是已批准的平台差异。新image无timestamp写也类似（:214-224）；恢复例程缺owner返回0不能作为恢复完成。当前R12-01/03保留。

还须保持失败warn而非传播：`src/indexing-content.ts:149-153` 直接调用条件setter，`src/ocr-recovery.ts:324-340` 也未在该缓存步骤恢复Rust warn/继续。接口存在后写失败会改变内容提取/OCR结果，此子义归原R12-06，不能只凭“走owner”关闭。

### generation：读过滤正确，写链未闭合

6116ded59将lance-engine requiredGeneration保留bigint，chunk/page index独立i32校验；unitGenerationState用safeIntegers读取，retainActiveUnitGenerations用generationEquals/zero。对应Rust lance_store.rs:314-395。main测试对2^53+1与邻值的过滤通过，**这一子链确认**。

仍有R12-09的生成和segment回写断点。测试 `lance-store.test.ts:588-613` 手动把大值同时种到SQLite/Lance fixture，绕过nextUnitGeneration及真实segment提交，所以不能证明写链精确。Lance engine测试用F7替身、store测试用MemoryConnection，所测L12生产函数是真实的，但不等于F7原生组合通过。

### 实际运行与来源说明

最早提供方作业20261104085738-0f3ce3得11通过/18过滤、exit0；执行中提供方从0701778aa继续到22d4ddb76，owner-writes由5增为6用例，故**不将它归为不可变070快照证明**。随后按v2在正常main代码重新跑同一最小集：

```text
job.mjs result 20261104111143-638e4a --tail 120
Test Files  3 passed (3)
     Tests  11 passed | 18 skipped (29)
  Duration  6.48s
[作业 20261104111143-638e4a] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104111143-638e4a.log
```

命令：`npx vitest run -c vitest.host.config.ts host/plugins/vfs-index/tests/owner-writes.test.ts host/plugins/vfs-index/tests/lance-engine.test.ts host/plugins/vfs-index/tests/lance-store.test.ts -t "L11 PDF/media owner writes|generation|chunk_index as i32" --maxWorkers=1 --no-cache`，通过全局队列。原输出无Errors/unhandled errors；18条为-t过滤。owner tests仅证明委托/缺接口行为，不把替身DB算法算成实际所有者等价。

```text
job.mjs result 20261104111425-0a593d --tail 80
next expected=9007199254740993 actual=9007199254740992 type=number
segment=9007199254740992
[作业 20261104111425-0a593d] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104111425-0a593d.log
```

main生产VfsLanceStore.nextUnitGeneration和batchCreateSegments、真实临时SQLite；未调用native向量查询。exit0表示反例探针完成，**不是D3等价通过**。全部脚本保留在job result命令字段。修复时应经实际索引写入口覆盖大generation，而非只增加另一纯helper测试。

### 集成失败摘录的复核

合并main后，原提到unit-maintenance九失败的文件现11例：作业 **20261104105931-0aa514**，1文件11通过、21.97s、exit0，无Errors；因此本基线未复现旧失败，不改实现/测试“修绿”。typecheck作业20261104105931-ea5d18 exit0；boundaries作业20261104105931-12f575 exit0（2382 files、0 violations、178 suppressions）。机械通过不抵消上述语义问题。F3图片正式策略/F7 vector真组合、R12-08持久解码仍独立pending，不在本轮闭合。

## 7. R12-09 L11 owner精确generation子链（2026-11-04）

固定L11修复 **9006bc16865fc93979026071cab1d527b0cb0eab**，包含63b02ec7d/f1006fd19的unit类型/查询改动。`repository/index-segments.ts` single/batch读unit profile用safeIntegers，generation缓存、INSERT绑定、返回及getById/getByUnit/getByUnitAndModality保留大bigint；`repository/index-units.ts`真实unit查询同样safeIntegers；`types/indexing.ts`公开number|bigint。`sql-integers.ts`仅将安全范围bigint转number，大值不经Number。对照Rust index_segment_repo.rs的unit generation→segment继承与原i64类型。

本人作业 **20261104125122-2d4f6f**：`npx vitest run --root /home/dsdev/dev/ds-mig/L11-vfs-repos -c /home/dsdev/dev/ds-mig/L11-vfs-repos/vitest.host.config.ts host/plugins/vfs-repos/tests/index-segments.test.ts -t "R12-09 segment writes and reads" --maxWorkers=1 --no-cache`，1文件、**1passed/4过滤、14.65s、exit0，无Errors/unhandled errors**，已取result。真实F3临时库和L11仓储，种入9007199254740993n与9223372036854775807n，断言unit读取、mm replace返回/SQL回读/getByUnitAndModality，以及text create返回/SQL回读均精确；未把测试自身Number转换算作证据。

运行前仅范围外migration账本dirty；完成后owner正在编辑index.ts维护注册及worker-service测试（后者随后检查点b3978297e），涉及worker能力探测移除，与generation仓储/类型/本用例无diff。故本证据限定这些固定目标文件，**不声称整棵执行树是不可变9006bc168快照**，更不借此签R11-05维护组合。

L12 **e665f4ae2**（含5aaf3bc8a）静态确认nextUnitGenerationValue删除Number(next)、保持i64饱和加一；text/mm传递generation、mm metadata写精确JSON数字，segment改经L11 owner。该L12树不含9006bc168（祖先检查exit1）。其1ca9397b5如实记录全量20261104121518-2e26d3的215passed/3failed、exit1，三处Segment精度失败；不能将L11单元绿测自动改写成这三个公开入口已通过。

下一必要证据是双方修复进入同一组合树后的L12公开text/mm写入口最小复验；F7原生vector组合仍独立待验。R12-09及R12-03整组保持未决，旧main反例不撤销。日志`/home/dsdev/.oc-jobs/done/20261104125122-2d4f6f.log`；没有运行Rust或重复已签R11身份/pragma测试。

## 8. R12-08共享精确解码候选与真实IPC反例（2026-11-04）

静态固定 **26b85c09597221184d15afcd047cb1b1f129b00d**（含2b1fc7217）。main **8d7b05d14**已有F4 JsonReader/JsonSyntaxError原语，L12候选才消费。执行树随后到01e0338b5，仅pdf-processing.ts类型签名调整；另有status timestamp safeIntegers/API/测试与SPEC WIP。原进度解码算法、serializer、所执行八条status/一条OCR断言不变，故证据限定这些子链；不将新增timestamp断言计入本人9例或声称整棵执行树冻结。

### 已核实的候选子链

- `src/pdf-processing.ts`使用公开JsonReader按字段读入，不先JSON.parse丢重复键/整数词法。known field含snake alias重复拒绝，未知字段可重复并skip；optional usize接受null/省略，按u64上界读取且大值保留bigint，0.0/1e0/-0拒绝；ProcessingProgress/ProcessingIssue序列按Rust字段顺序及尾部default读取。失败整体回到Default，不保留半条记录。
- percent按serde整数visitor直接舍入f32，避免先转f64的double rounding；f64输入1e40→f32 Infinity，serialized snapshot按Rust JSON形状输出null，而1e400在读取时失败回Default。`getStatus`通过processingProgressSnapshot输出None省略；内部页码精度不提前舍入。
- 原始Rust依据 `pdf_processing_service.rs:215-250,253-264,283-300,2896-2943`。本轮未运行Rust；共享解析器整体认证与所有serde错误文案不在此子项扩大签收。
- `tests/pdf-status-boundary.test.ts`真实L12插件服务读取实际SQLite processing_progress，覆盖重复字段/别名、数字token、usize最大值、struct sequence、整数f32舍入及溢出。OCR readiness用真实VfsOcrRecovery和SQLite驱动生产parse/serialize，断言写回保留2^53+1、u64::MAX和percent=-0.0；**其OCR/provider与owner SQL存在测试fixture**，只证明序列化调用链，不证明真实L11条件缓存或完整OCR。

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L12-vfs-index -c /home/dsdev/dev/ds-mig/L12-vfs-index/vitest.host.config.ts host/plugins/vfs-index/tests/pdf-status-boundary.test.ts host/plugins/vfs-index/tests/ocr-recovery.test.ts -t "R12-08 Rust ProcessingProgress|X6-UD-0089 OCR readiness writeback" --maxWorkers=1 --no-cache
job.mjs result 20261104142645-d02d0a --tail 110
Test Files  2 passed (2)
     Tests  9 passed | 6 skipped (15)
  Duration  21.03s
[作业 20261104142645-d02d0a] 退出码 0
```

已取result，无Errors/unhandled errors，6条为过滤；日志`/home/dsdev/.oc-jobs/done/20261104142645-d02d0a.log`。

### R12-08.wire-percent（原组子项，未决）

服务测试没有跨kernel结果契约。本轮另经真实createTestHost、paths/settings/storage及notes/vfs-repos/vfs-index/vfs/media/vfs-handlers插件，使用真实file与持久JSON，调用`vfs_get_pdf_processing_status`：

```text
job.mjs result 20261104143042-824c5b --tail 100
service 25 page=9007199254740993 percent=25
wire 25 {"fileId":"file_ffglkSDTU4","stage":"pending","progress":{"stage":"ocr_processing","currentPage":9007199254740992,"percent":25,"readyModes":[]}}
service 1e40 page=9007199254740993 percent=null
wire 1e40 REJECT [dstu-host] command "vfs_get_pdf_processing_status" returned a value that violates its contract (L13-vfs-api.json): must be number at /progress/percent
[作业 20261104143042-824c5b] 退出码 0
```

正常25证明内部bigint→IPC number符合D3边界；不是把wire舍入认作内部精度bug。1e40分支则在默认debug宿主发生真实拒绝：`contracts/ipc/_shared.json:1302-1304`的ProcessingProgress.percent仅number/x-float:f32，`host/kernel/commands.ts:249-255`在结果校验时拒绝null。该问题限定debug结果校验路径，未宣称关闭校验的release同样拒绝。脚本包含服务值断言、对invoke结果/拒绝打印观察；**exit0仅表示反例执行完成，不是IPC等价通过**，无未处理异常。完整脚本在job result命令字段，日志`/home/dsdev/.oc-jobs/done/20261104143042-824c5b.log`。

已通过coord回派L12/C2协调F5：仅对齐Rust可序列化的成功响应形状，保留输入f32约束、debug校验与真实invoke断言；不改回Infinity或允许任意输出。R12-08保持未决，不新增重复组。R12-09的L12树仍未包含9006bc168（祖先检查exit1），本轮没有重跑已知缺owner的完整text/mm链。

### F4出站f32候选补充（C2限定范围）

固定 **0fb54cddeff280cad5fe5f6096707665b5d9394f**，其本提交仅新增向量/报告；实际`host/platform/util/f32-json.ts`及正式api来自c0e797350/159eb035f。对照main **4525e11ac**候选仍非祖先（exit1）。F4/C2回执20261104151601-6fcbaf为4passed/exit0、Electron20261104151448-fff7fe为4passed/exit0，均为他方证据，本轮未重复运行或独立签收该算法。

正式`f32ToJsonNumber(number):number|null`只用于内部f32到出站snapshot的最短十进制数值投影，不是输入decoder，不改变内部运算/f64格式化，不放宽输入null。候选声称保留midpoint区间、shortest及tie-even；静态向量/roundtrip不是Rust差分，也不能单凭roundtrip证明唯一最短选择。普通JSON.stringify负零拼写不属该数值helper保证。

**后续独立复验严格限定**：F4与L12消费者均进入正常main后，仅复验既有有限值`33.333332`、`1.1`及非有限f32的`null`三类真实`host.invoke`出站结果；不重跑未变的服务9例，不增加第一34-ID oracle的Rust编译入口。nullable成功响应契约仍归F5/contract owner，本补充不撤销20261104143042-824c5b的debug拒null反例，不关闭R12-08.wire-percent或整组。

## 9. R12-03状态写owner子项与剩余错误语义（2026-11-04）

本轮main **1e893eb61f96b46b313ea859a98ed1a22c3bbdac**。固定实现 **21e8175c22548b895fc1b1e4cd88b55852508448**，审读树 **3f57ac79d52332d8309adfe7674661d11a8d55dd**，执行后继 **4e4b713c92670ac9e6d94f14427fcd552f79c62c**。提供方执行中合并新main，但目标index-units/full-indexing/indexing-content实现、index-service测试、real-owner fixture及L11 index-units均无diff；不是把整棵树认成旧固定快照。21e8175c2尚非main祖先，候选通过待main。

### X6-SW-0179 / R12-03.state-owner

`repository/index-units.ts:setUnitTextState`仅在embeddingDim===undefined分支调用`requireVfsTableOwners(db).embeddingUnits.setTextState(db,unitId,state,error)`；原对应本地UPDATE已删。L11 `index-units.ts:318-328`只更新state/error/updated_at，非indexed状态用COALESCE保留indexed_at、不写embeddingDim，符合Rust index_unit_repo.rs:485-507及indexing.rs:3078-3080所需字段范围。带embeddingDim的本地写仍在（X6-SW-0178），不据本子项关闭R12-03。

`tests/index-service.test.ts:309-337`通过真实VfsFullIndexingService.indexResource、真实F3迁移库和真实L11仓储，外部embedding/Lance为测试传输。第二个Unit向量写失败，透明spy确认owner收到同一db及failed/error；回读仍有textIndexedAt=777、textEmbeddingDim=128，资源仍indexed且业务updated_at=1。不是复制owner SQL的替身或只断言调用参数。

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L12-vfs-index -c /home/dsdev/dev/ds-mig/L12-vfs-index/vitest.host.config.ts host/plugins/vfs-index/tests/index-service.test.ts -t "X6-SW-0179 additional unit failure" --maxWorkers=1 --no-cache
job.mjs result 20261104154913-89292e --tail 85
Test Files  1 passed (1)
     Tests  1 passed | 28 skipped (29)
  Duration  12.72s
[作业 20261104154913-89292e] 退出码 0
```

已读取result，无Errors/unhandled errors，28条为过滤；完整日志`/home/dsdev/.oc-jobs/done/20261104154913-89292e.log`。不证明F7原生写入或R12-09大generation链。

### 原Scope问题的当前main更正（静态）

main `src/indexing-content.ts:352-368`在实际transaction回调中把db绑定的owner显式带到tx，并在finally恢复此前绑定/删除临时绑定；`repository/index-state.ts:280,296,328,360,365,384`与`embedding-dim.ts:330,339,358`已require owner，不再回退本地SQL。因此§6的eeaf5bdc7旧WeakMap/Scope回退描述仅为历史，不能继续给这些已修改调用点重复派修。本轮确认明确传递及fallback删除；其他直接写表、缺窄owner API和所有事务错误分支仍独立保留。

### R12-06.additional-unit（静态差异，保持未决）

候选`src/full-indexing.ts:623-629`在附加Unit向量写失败后直接调用setUnitTextState然后continue，没有Rust indexing.rs:3082-3085的warn；Rust:3071-3080在InvalidState/一般错误下的状态UPDATE均为`let _`，TS状态setter若抛错则覆盖原InvalidState或将原continue变成向外失败。此差异不因owner委托正确消失。本轮未宣称有独立状态写故障动态反例，已按静态源码向L12回派：保留原warn与best-effort状态写策略，在既有真实追加Unit用例注入状态UPDATE失败验证错误顺序；不新增组、不改变原Rust语义。

本轮先前标准自检tip5d6708d33/base1e893eb61的作业20261104154440-641559为24文件213通过、exit0、无Errors；typecheck5fa2c7/boundariesde2359/importable734500（同时间前缀）均exit0。这些main门禁结果不替候选子项或原R12-06签收。R11-05仍候选未main、R12-09消费者尚不含9006bc168、F4 0fb54cdde未main，未重复各自已过/已知失败的测试。

## 10. Linux续派：R12-07关闭与旧描述收敛（2026-11-05）

固定main **a9683a43b8b9001e5c73fea04cc1263fb35401b6**，执行树 **84c0847a71c0585bdb7296aee8eaae5435d56f19**。本轮主线L12实现无未提交改动。没有重测未集成的5aaf3bc8a/26b85c095/0fb54cdde/21e8175c2组合。

### R12-07：原必须修复项通过

- `src/lance-store.ts:714-729`按Rust `lance_store.rs:2466-2487`跳过open错误、count错误不计表；`:740-773`按Rust`:2507-2564`跳过open失败、schema错误前缀后传播、scan拒绝不使诊断失败、按null总数补None样本。
- `src/chat-embeddings.ts:208-225`按Rust `lance_vector_store.rs:903-919`逐表打开，失败continue，优化失败error后继续；本轮动态断言覆盖open失败后仍优化下一张表。
- 既有`tests/lance-store.test.ts:687-739`确实调用生产store并验证坏表略过/null返回，已包含在上一轮213条L12通过中。为补公开接线与不同失败阶段，本轮仅追加一份内联node strict断言脚本，经真实`createTestHost([vfs-index])`、真实F3迁移临时库、`ctx.vfsIndex.lance`和`host.invoke('optimize_chat_embeddings_table')`执行。
- 向量外部供应商只提供确定的表/故障输入，不替换L12 store、adapter、命令或错误逻辑。断言：64维open失败只返回128维统计；三个null样本和计数3保留；scan失败返回空样本不抛；schema失败仍`获取 schema 失败: schema fault`；chat坏表跳过且健康表优化一次、命令null。

```text
job 20261105004229-9531a3: node --input-type=module -e <公开入口strict断言脚本>
R12-07 production plugin: open failure skipped; null samples retained; scan failure tolerated; schema failure propagated; chat optimization continued PASS
退出码 0
```

完整命令及日志`/home/dsdev/.oc-jobs/done/20261105004229-9531a3.log`；无未处理异常。没有执行Rust，也不是差分结果。关闭原R12-07，不将此证据扩大到F7原生流中途失败后已读批次保留或整个vector能力；后者需原生组合证据，属于既有R12-01范围。

### 仍未决项的当前源码说明（不再按初审旧代码回派）

- **R12-02**：`runtime-adapter.ts:322-345`现委托`llmEmbeddingModels.getEmbeddingModelConfig`并保留完整config，`unified-retriever.ts:214-222`包含baseUrl/provider/scope/protocol/adapter；原“空endpoint重造”已从此处消失。仍待正式生产组合验证模型回退与batch期间配置改变，不冒称本轮已经动态签收。
- **R12-04**：`runtime-adapter.ts:397-412,478-483`已注入rerank包装，缺实际llmRerank时throw交`search-service.ts:248-255`warn后保留RRF。原“完全没有注入”不再成立；正式transport/模型分派等价仍未确认，整组保留。
- **R12-05**：`pdf-runtime.ts:206,595,813`已真实消费slots/compress，`search-service.ts:237`和`full-indexing.ts:240`已消费backend/missing-note helper；不再称这些符号仅供测试。`imageExtensionForMime`全host仍只有定义和测试（`pdf-processing.ts:104`；`tests/pdf-processing.test.ts:4-8`），原`ocr_temp_image_extension_follows_mime`仍标ported，因此整组保留。
- **R12-06**：embedding retry WARN已在`embedding.ts:55-57`；additional-unit的`:623-629`仍无Rust原warn，状态setter失败仍会改变错误/continue策略，沿§9保留。

当前L12原编号未决8组（01–06、08–09）。静态确认部分旧缺口消失，不以存在调用点、过时owner自述或机械绿灯关闭其他整组。

## 11. R12-02生产指纹再校验（2026-11-05）

main仍为a9683a43b，本轮执行树61e9c7b4b仅增加审计文档。本人作业 **20261105011329-b19913，exit0**：真实F3/paths/L11/L12插件，经`ctx.vfsIndex.indexing.indexResource`驱动正常文本分块、模型查询、嵌入返回后配置再校验。外部`llmEmbeddingModels`和embedding transport提供确定输入；未替换L12 runtime adapter、fingerprint、pipeline或状态仓储。

分别只修改baseUrl/providerType/providerScope/apiProtocol/modelAdapter，保留相同id/model，五次均拒绝为`INVALID_STATE: Text embedding assignment changed while the batch was running: cfg_same/embed-same -> cfg_same/embed-same`；资源回pending、segments仍0，共五次transport调用与十次模型读取。未提供vector，因此验证的是向量写入前的校验/退出分支，不是向量持久化成功路径。

源码：`runtime-adapter.ts:322-345`→`unified-retriever.ts:214-222`→`repository/embedding-dim.ts:162-189`；`embedding.ts:26-39,119-125`在写前重新读取并比较。Rust对照`embedding_service.rs:125-165,551-585`及`embedding_dim_repo.rs:196-241`，五个transport字段均参与带NUL分隔的原哈希格式，不能只比较id/model。

```text
R12-02 same id/model mutation detected before write: baseUrl
R12-02 same id/model mutation detected before write: providerType
R12-02 same id/model mutation detected before write: providerScope
R12-02 same id/model mutation detected before write: apiProtocol
R12-02 same id/model mutation detected before write: modelAdapter
R12-02 public indexing -> runtime adapter -> production fingerprint/revalidation PASS; L02 selector is an external scripted provider
[作业 20261105011329-b19913] 退出码 0
```

完整命令/日志`/home/dsdev/.oc-jobs/done/20261105011329-b19913.log`，无未处理异常；此证据使原“endpoint被丢弃、同id/model变化不能发现”子项正式主线闭合，不据脚本化selector签收真实L02配置优先级和错误边界，R12-02整组保持未决。

### 真实L02选择服务与R12-02.owner-error

另运行 **20261105011609-a4c169**，安装真实L01/L02/notes/vfs/repos/index，真实F4设置与临时SQLite。仅将`ctx.llm.getApiConfigs`的外部模型列表设为确定输入；`llmEmbeddingModels`、默认解析器、settings写回、L12消费者均为生产实现。断言确认：有效default优先于assignments；missing/disabled/multimodal default回退到合法assigned并写回；悬空assignments时唯一合法模型被自动选中并写回。此范围与Rust `rag_extension.rs:169-247`一致，不将未测配置载入/所有LLM分支一并签收。

随后令模型列表为空，经真实`vfsIndex.indexing.indexResource`触发L02无配置错误，结果为：

```text
R12-02 real L02 selector: default priority, unusable default fallback/writeback, unique auto-detect PASS
Rust expected inner error: 获取嵌入模型配置失败: 未配置默认嵌入维度。请在「模型分配 > 嵌入维度管理」中设置默认维度。
TS actual inner error: 获取嵌入模型配置失败: {"error_type":"Configuration","message":"未配置默认嵌入维度。请在「模型分配 > 嵌入维度管理」中设置默认维度。","details":null}
R12-02 real owner missing-config Display mismatch reproduced (exit0 means observed mismatch, not parity)
[作业 20261105011609-a4c169] 退出码 0
```

日志`/home/dsdev/.oc-jobs/done/20261105011609-a4c169.log`，无未处理异常。脚本显式断言实际值不等于Rust文案且含Configuration envelope，**exit0是反例观察成功，不是错误等价通过**。初次作业`20261105011533-0b8144` exit1，因审计宿主漏装vfsDatabase提供者导致LLM启动失败；补真实notes/vfs插件后才得到上述业务反例，未修改实现或测试，不将首个装配失败归责产品。

修复责任在L12的消费边界：保留Rust两处配置步骤前缀，按正式AppError message显示，不让kernel envelope的JSON字符串替代Rust Display；回归仍走真实L02→L12入口。原R13-06已处理其消费边界（`vfs-handlers/src/embedding.ts:57-60`），不因此重开L13b或要求L02改变契约。R12-02保留一个未决组，不另计新组。

## 12. 新候选定向审读：owner-error与generation联合（2026-11-05）

固定L12代码树 **61a2e77c4**（含363f3f72d，其实际实现/测试在939686562）。9006bc168和5aaf3bc8a均为该树祖先；main f2d5b6c46仍不含363f3f72d/5aaf3bc8a。因此这次有实际owner+consumer联合可验，但不是正常main修复。原main反例及未决勾选保留。

- `src/embedding.ts:8-14`识别kernel CommandError并取value.message，其余普通Error也取message；首次模型info/id及batch之后重读保留各自步骤前缀。`tests/embedding-owner-errors.test.ts:64-85`经真实L02/L12公开indexResource/generateQueryEmbedding，模型列表是输入夹具，缺配置异常由真实selector产生；第三例由progress回调移除配置，证明错误发生在嵌入完成后的实际重读。三例逐字验证前缀+message，无测试内重造异常算法；两写入入口另断言segments仍0。
- `repository/index-units.ts:492-504`删除Number(next)，保持bigint及i64::MAX饱和；`src/embedding.ts:94-105`携带number|bigint；`multimodal-service.ts:451-477`metadata使用rawJSON保留整数token，`:503-519`将同一generation交给owner Unit与Segment提交链。Rust对应lance_store.rs:289-311、embedding_service.rs:548-588、multimodal_service.rs:619-684,717-744。
- `tests/lance-store.test.ts:364-438`走真实插件公开text indexResource（2^53→2^53+1、i64::MAX饱和）及mm indexResourcePages；真实L11实例来自`tests/support/real-owner.ts:17-37`，未复制仓储SQL。断言公开next值、Unit/Segment safeIntegers回读、内存Lance append行均精确，mm metadata包含原整数token。外部embedding/vector为测试供应商，不代表F7 Arrow/磁盘原生组合已签。

从R3工作目录提交最小作业`20261105014804-945753`，只读L12现有工作树作为测试输入，`--no-cache --maxWorkers=1 -t 'R12-02|R12-09 public'`，仅上述两个文件。开跑前相对61a2e77c4的host/contracts/package/config差异仅BLOCKERS/LANE文档，既存migration生成改动未触碰；不把他方持续写文档的工作树宣称成整树冻结快照。运行结果及运行后目标文件一致性另记。

运行后再次对照61a2e77c4，差异仍仅两份文档，相关实现/测试/契约/config未漂移；提供方HEAD前进a5d37cc39不改变本次目标代码。本人已取结果：

```text
✓ host/plugins/vfs-index/tests/lance-store.test.ts (16 tests | 13 skipped)
✓ host/plugins/vfs-index/tests/embedding-owner-errors.test.ts (3 tests)
Test Files  2 passed (2)
     Tests  6 passed | 13 skipped (19)
  Duration  32.33s
[作业 20261105014804-945753] 退出码 0
```

无Errors/unhandled errors，13条为名称过滤，未改skip；完整命令及日志`/home/dsdev/.oc-jobs/done/20261105014804-945753.log`。**R12-02.owner-error修复候选通过、R12-09上述精确公开写链联合候选通过**。不再按旧“L12树未含9006、三条必失败”描述当前候选；正常main仍未包含消费修复，主线未决组数8不变。两wire缺口及F7原生vector组合保持独立未决，不依据内存append断言代签。

## 13. C2限定：OCR临时文件与真实F7媒体写链（2026-11-05）

固定实现闭包 **61a2e77c4**，提供方执行HEAD **a5d37cc39**；运行前后host/contracts/package/vitest配置相对固定树差异均仅BLOCKERS/LANE文档。该候选仍非main f2d5b6c46祖先。按C2仅亲跑`image-ocr-temp.test.ts`五例和`media-index-write.test.ts`一例，没有重复§12六例、adapter二十例或425/711目录门禁。

### R12-05：MIME helper真实调用子项候选通过

- 入口为`ctx.vfsIndex.pdf.startPipeline(file.id,'ocr_processing')`，经真实PDF服务/runtime→`ocrImageFile`；`src/pdf-runtime.ts:862-874`创建`ds-attachment-ocr-`临时目录和带`imageExtensionForMime(mime)`后缀的文件，写入原blob字节，调用`runtime-adapter.ts:194-197`正式llmOcrPages文件入口。helper `pdf-processing.ts:178`按Rust trim＋ASCII小写分派，原Rust `pdf_processing_service.rs:495-504,2601-2615`与测试`:4370-4377`对应。
- `tests/image-ocr-temp.test.ts:61-72`对jpeg/大写WEBP/png/未知MIME分别断言suffix、prefix、provider实际读到的bytes、完成后文件不存在、原带空白OCR文本精确持久化、readyModes含ocr。不是孤立helper输出或测试自身构造路径的断言。
- `:74-82`由外部OCR provider抛LLM envelope，真实pipeline记failedStages并保持ocr_text为null，临时文件仍删除。`pdf-runtime.ts:875-883`记录原WARN/步骤前缀后finally清理；`:886-898`才检查空文本/写owner并确认rows affected。对照Rust`:2617-2625,2649-2687`。此五例不覆盖全部DB时间格式、日志sink、取消/过代写入路径。
- **边界**：llmOcrPages/模型可用性仍为外部输入替身，未签完整OCR引擎fallback。Rust`:2588-2592`使用L02共享ocr_semaphore，候选此调用前尚未共享准入；该已知并发缺口保持。只关闭“helper无真实生产调用”的候选子项，不把R12-05整组或OCR并发完整性勾选。

### R12-01/09：Linux真实F7 primary/additional链候选通过

- `tests/media-index-write.test.ts:25-29`安装真实`platform/vector/index.ts`；`vector/service.ts:3-4,90-105`实际加载`@lancedb/lancedb`/Arrow并连接临时磁盘目录，非MemoryTable。LLM配置/embedding transport仍为确定的外部供应商。
- 通过真实L11 imported segments及L13 unitIndex建立两个时间窗口；初始generation=2^53，经公开`vfsIndex.indexing.indexResource`执行primary与additional写入。`:45-50`回读两Unit/Segment均为2^53+1，Segment metadata分别为0–20000ms、100000–120000ms。`full-indexing.ts:322-327,374-377,654-659,692-695`使用正式mediaIndex范围/序列化服务，对照Rust `indexing.rs:2605-2621,2787-2788,3031-3044,3163-3164`。
- `lance-store.ts:292-294`把DTO metadata_json映射为实际Arrow metadata列；generation采用Int64。Rust对应`lance_store.rs:892,1082-1092`。测试`:52-65`从真实vector表查询两行generation bigint及unit_id，再经生产vectorSearchProfileFull回读page_index=[0,1]与精确generation，证明metadata不再在append时丢失。
- **边界**：只证明当前Linux/Node原生Lance组合的两窗口写入/读取；不签三平台、在线嵌入、ASR或整个索引流水线，不扩大到此前未测的mm原生大generation/所有事务故障。R12-01/09仍待正常main及各自剩余范围。

### 本人原始结果

```text
job 20261105020149-da37c7:
npx vitest run --root /home/dsdev/dev/ds-mig/L12-vfs-index -c /home/dsdev/dev/ds-mig/L12-vfs-index/vitest.host.config.ts host/plugins/vfs-index/tests/image-ocr-temp.test.ts host/plugins/vfs-index/tests/media-index-write.test.ts --maxWorkers=1 --no-cache
✓ host/plugins/vfs-index/tests/image-ocr-temp.test.ts (5 tests)
✓ host/plugins/vfs-index/tests/media-index-write.test.ts (1 test)
Test Files  2 passed (2)
     Tests  6 passed (6)
  Duration  21.52s
退出码 0
```

无Errors/unhandled errors；原生Lance输出一条`_distance`自动投影行为将来改变的deprecation WARN，保留原日志，不计作测试失败或三平台证明。完整日志`/home/dsdev/.oc-jobs/done/20261105020149-da37c7.log`。这是本次新增5+1，不重复计算§12的先前六例；主线8组未决维持，F5两个wire缺口不连带关闭。

## 14. R12-06.additional-unit候选定向复核（2026-11-05）

本轮main dd564e12f，R3合并树bad0ecb3b；L12候选目标固定 **ee05933a9**。本节目标full-indexing、lance-types、index-service测试及真实owner支持与61a2e77c4一致，但此前独立六例/5+1均未执行此错误分支。没有把先前native成功写入当失败语义证据。

`src/full-indexing.ts:629-636,668-675`仅吞additional-unit状态写失败：真正InvalidState重抛原对象；其它错误记原WARN后继续。`lance-types.ts:67-69`使用code+前缀识别，普通错误正文含INVALID_STATE不走该分支。调用方`:407-425`分别将resource置pending或继续完成，不回到primary向量失败处理；Rust对应`indexing.rs:3071-3086,2926-2945`。

`tests/index-service.test.ts:341-378`两个参数场景使用真实L11 Unit/Segment仓储、真实SQLite UPDATE触发器拒绝secondary状态写。断言该owner确实抛错；InvalidState保留原错误对象、later未执行；普通Other（正文含INVALID_STATE）仍继续later并仅记一条原WARN；已成功primary保持indexed。该测试直接构造生产VfsFullIndexingService并调用indexResource，所测catch/分支/状态逻辑没有被替身替换；Lance store与embedding runtime为依赖故障接缝，logger为记录函数，不能因此宣称真实F7故障、kernel invoke或日志exporter已验证。

仅排作业`20261105024831-a11588`运行该文件`-t R12-06.additional-unit --maxWorkers=1 --no-cache`，两例。运行前差异仅BLOCKERS；期间提供方新增文档及另一个未参与本作业的pdf-preview测试，目标实现/测试/依赖配置无变化。本轮不改任何实现或测试，结果及范围以该最小作业为准。

运行后再次对照固定树，仍仅上述文档/无关pdf-preview测试差异，目标闭包未漂移，候选仍非main祖先。原始结果：

```text
✓ host/plugins/vfs-index/tests/index-service.test.ts (31 tests | 29 skipped)
Test Files  1 passed (1)
     Tests  2 passed | 29 skipped (31)
  Duration  18.43s
[作业 20261105024831-a11588] 退出码 0
```

无Errors/unhandled errors，29为名称过滤，未改skip。完整命令/log为`/home/dsdev/.oc-jobs/done/20261105024831-a11588.log`。R12-06.additional-unit所查状态写失败/错误类型分派/WARN继续子项候选通过；原R12-06整组及主线8组未决维持，正式main后再按变化点闭环。

## 15. R12-03 settings-owner探索结果：暂不签收（2026-11-05）

新测试提交9433c0563增加真实F4同连接settings写入/失败语义回归；启动探索作业时，对应index/chat-lance/chat-embeddings/commands/legacy-kb-store五实现仍为未提交改动，随后自动保存到ddae869ff。期间新增了另一条settings读取失败测试，本作业未执行该新用例。因此明确记为探索证据，不冒称启动时已有完整冻结提交或候选已验收。

静态方向：`repository/chat-lance.ts:95-98`删除settings本地INSERT副本，委托F4 saveWithConn；chat/legacy path及优化时间戳传原mistakes连接。Rust `lance_vector_store.rs:717-745,788-793,925-928`分别要求路径回写错误传播、时间戳失败WARN后继续。F4公开方法在main已存在，无需重造owner。

```text
job 20261105032744-2c0383:
npx vitest run --root /home/dsdev/dev/ds-mig/L12-vfs-index -c /home/dsdev/dev/ds-mig/L12-vfs-index/vitest.host.config.ts host/plugins/vfs-index/tests/commands.test.ts -t 'R12-03|throttles non-forced' --maxWorkers=1 --no-cache
FAIL R12-03 timestamp owner failure warns after optimization and remains successful
AssertionError: expected false to be true
tests/commands.test.ts:267:78（WARN buffer谓词）
Test Files  1 failed (1)
     Tests  1 failed | 4 passed | 13 skipped (18)
  Duration  17.11s
退出码 1；无单独Errors/unhandled errors汇总
```

失败前的invoke=null、优化一次、save一次、设置无值断言均已通过；失败点仅为WARN包含原前缀和`timestamp rejected`的观察。尚未确定是日志内容、记录接缝或其它原因，不能直接断言生产没有WARN。另四例覆盖empty scope真实owner写回、KB/chat路径同连接、路径写失败先于优化、原非force节流。未弱化断言，未用四绿抵消exit1；已回派L12，待固定实现/实际WARN证据后最小复验。完整原始日志`/home/dsdev/.oc-jobs/done/20261105032744-2c0383.log`。R12-03整组保持未决，不据此新增main缺陷组。

## 16. c28e272d4：settings-owner WARN与读取默认值候选通过

固定候选 **c28e272d4b04a356bb8eb6bacb6517d658a79b5f**，运行前后host/contracts/package/config相对该树均只有BLOCKERS文档差异，目标实现/测试无漂移；候选不是main f2c6d46c4祖先。

已独立定位§15的观察失败：安装的Cordis `lib/index.js:457-474`把warn设为level2，未设置level的exporter默认为1；`:598-604`默认buffer没有level覆盖，因此不收该WARN。候选`tests/commands.test.ts`为两个场景添加`levels.default=4` exporter，原WARN包含条件保留，原失败场景另要求精确`[Lance优化] 记录 chat 上次优化时间失败: timestamp rejected`。未改生产日志以迎合测试，也未放宽断言；该归因只针对本条日志观察，不用于解释历史onTaskUpdate超时。

新增`repository/chat-lance.ts:90-97`仅将settings读取失败变为undefined，匹配Rust `lance_vector_store.rs:709-714,766-773,801-806`的`.ok().flatten()`；写路径仍经F4并保原错误策略。新用例DROP真实settings表，实际command以默认路径/未节流/默认prune策略继续优化，最后时间戳写失败只WARN。原trigger场景继续验证优化已执行、失败保存不落值、返回null和精确WARN，Rust`:788-793,925-928`对应。

本人只复验这两条变化点，没有重跑先前四绿例：

```text
job 20261105035112-044faf:
commands.test.ts -t 'R12-03 timestamp owner failure|R12-03 settings read failures' --maxWorkers=1 --no-cache
Test Files  1 passed (1)
     Tests  2 passed | 17 skipped (19)
  Duration  24.20s
退出码 0；无Errors/unhandled errors
```

完整命令/log`/home/dsdev/.oc-jobs/done/20261105035112-044faf.log`；17是名称过滤。原032744作业exit1保留为历史，其余四绿只保原执行证据，不冒称本次重新运行。候选两分支通过，R12-03整体、其它表写所有权及正常main集成仍未决，总组数不变。

### C2补验：固定候选其余四例（2026-11-05）

按后续C2指令复用上述已独立完成的两例，不重复执行；对c28e272d4补跑四个此前只有WIP探索结果的场景。运行前后目标实现、commands测试、host依赖、契约及配置相对固定树差异仍只有BLOCKERS文档，HEAD仍c28e272d4。

- `commands.test.ts:254-264`：空scope也经真实F4 saveWithConn回写原mistakes连接，时间为RFC3339 `+00:00`；Rust即使optimized=0也记录时间（lance_vector_store.rs:922-927）。
- `:291-306`：legacy KB与chat回退路径均交同一F4连接，chat按path→timestamp顺序写；Rust路径写回`:717-745`。未用路径函数替身取代消费者。
- `:310-323`：真实settings INSERT触发器拒绝路径写回，kernel返回Database错误且向量表未优化，旧路径不变；保Rust路径保存的`?`传播。
- `:369-379`：强制调用后经真实持久时间戳，非force调用不新增优化；对照Rust`:757-784`。只改变fixture接真实settings，原throttle断言保留。

```text
job 20261105040042-379c36:
npx vitest run --root /home/dsdev/dev/ds-mig/L12-vfs-index -c /home/dsdev/dev/ds-mig/L12-vfs-index/vitest.host.config.ts host/plugins/vfs-index/tests/commands.test.ts -t 'R12-03 uses the real F4|R12-03 both legacy KB|R12-03 path owner failure|throttles non-forced' --maxWorkers=1 --no-cache
Test Files  1 passed (1)
     Tests  4 passed | 15 skipped (19)
  Duration  13.07s
退出码 0；无Errors/unhandled errors
```

完整log`/home/dsdev/.oc-jobs/done/20261105040042-379c36.log`。本次4＋原固定2覆盖C2要求的六条，不把WIP探索四绿冒充冻结候选证据；旧exit1留存。Lance为外部供应商fixture，真实F4仅所测方法/分支获验证，非全F4验收。候选仍未main、两wire与R12-03其它表写缺口继续保留，主线总未决15组；遵照限定范围不追加目录全套。

## 17. R12-03.config-copy：配置写入副本移除候选

固定代码树99da3ecec（3e087ab85删除副本/调整测试、185b88eb9清理残余helper），相对c28e272d4仅本单元生产/测试变化。运行前后host/contracts/package/config差异仅BLOCKERS/LANE文档，目标闭包未漂移。

`repository/index-state.ts`删除本地setConfig/validateConfig及仅供它们使用的写SQL/事务/解析helper；候选全L12 TS对setConfig/validateConfig/getF64的检索只剩测试调用真实owner，生产不再有第二份配置写入。实际IPC早已由`vfs-handlers/src/embedding.ts:571-574`委托L11，因此这是移除测试支撑副本，不冒称新接通此前缺失的生产命令。

`tests/index-service.test.ts:189-214`原十个非法输入的精确错误文案及成功25读回均保留，改调`bindRealOwner(db).indexingConfig.setConfig`，并新增VFS_INVALID_ARGUMENT及data.param断言；不是删除测试/降低预期。真实L11 `repository/embedding-repo.ts:515-519`在同连接校验后INSERT OR REPLACE，对照Rust `embedding_repo.rs:911-1021,1044-1054`。用例标题虽称every key，本次证据只覆盖实际十个非法样本及一个成功样本，不宣称全部键/输入全域验证。

```text
job 20261105041644-ae0fe8:
index-service.test.ts -t 'validates every published configuration key' --maxWorkers=1 --no-cache
Test Files  1 passed (1)
     Tests  1 passed | 30 skipped (31)
  Duration  10.25s
退出码 0；无Errors/unhandled errors
```

从R3 cwd只读运行L12工作树，完整命令/log`/home/dsdev/.oc-jobs/done/20261105041644-ae0fe8.log`。30为名称过滤、未改skip；没有重复settings六例或其它旧集合。该配置副本移除子项候选通过，正常main/其它单写者缺口保持未决，主线15组不变。

## 18. R12-05旧KB测试记账纠正与维度helper

**审批后续状态**：main6d759e81c已包含e4680aa8a，`migration/approvals.d/C2-platform.json:5-6`精确批准下列两ID；ledger.mjs:207-213读取审批分片。已通知L12在同步后更新去向，R3未代改TESTMAP或重复两个旧测试。以下“尚无批准”是首次复核基线，现以此更新为准；不扩大到活跃维度/维护路径。

固定候选a7cf18fbf；运行前后host/contracts/package/config相对该树差异仅BLOCKERS文档，目标测试/实现未漂移。TESTMAP两行由ported改pending，原TS测试体及断言没有删改/skip，未自行标obsolete。候选正文统计77ported/2pending/0obsolete，生成标头仍79/0并在标记外说明；当前main未因此自动改账。

独立引用核对支持提交C2裁定以下**仅两个**ID（此处不是批准）：

- `rows_to_retrieved_input_dedup_semantics`：Rust `lance_vector_store.rs:4689-4705`的前置排序去重断言；rows_to_retrieved只有同文件3199/3220/3301/3304的旧VectorStore检索实现使用。全src-tauri的VectorStore类型引用仅trait声明、该实现及import，相关search调用也仅该impl内部，未找到外部生产调用。
- `clear_all_success_means_sqlite_and_every_lance_table_are_empty`：Rust`:4709-4784`，无参`.clear_all()`全仓只在该测试；`.add_chunks()`仅该测试及`:3851`旧迁移内部。迁移公开入口`:3633-3642`已deprecated且全文检索无调用；`vector_store.rs:1-9`维护模式说明与此引用结果相符。不能据此退役VFS带modality的clear_all或仍活跃的chat/KB优化。

`migration/approvals.json`未包含上述两个ID，保持pending正确；无需为凑ported人为增加调用，也不把本lane公开legacyKb属性等同Rust有生产使用。

维度解析仍活跃：Rust`:388-407`被existing_dim_tables使用；TS `src/chat-embeddings.ts:68-83,93,127-128`用于聊天删除/优化枚举。新测试只把LegacyKbStore目标改为真实ChatLanceStore helper，原Rust`:4654-4684`的1024/1792/2560及三类拒绝输入与期望逐字保留。

```text
job 20261105043638-b9fe1a:
lance-vector-store.test.ts -t parse_dim_from_table_name_accepts_any_dim_and_rejects_others --maxWorkers=1 --no-cache
Test Files  1 passed (1)
     Tests  1 passed | 2 skipped (3)
  Duration  7.61s
退出码 0；无Errors/unhandled errors
```

只运行改接目标的一例，另两例本次名称过滤未执行，不宣称另两条动态通过。完整命令/log`/home/dsdev/.oc-jobs/done/20261105043638-b9fe1a.log`。确认所测六项同义及可达性，不宣称parse_dim所有usize输入全域等价；保留R12-05整组、候选非main及协调者审批边界，主线15组不变。

## 19. R12-06 primary/additional indexing标记策略

固定候选9888d2148（实际实现/测试caa36b7ce、917812ea6），运行前后host/contracts/package/config相对固定树仅BLOCKERS文档差异。候选非main eaa17bc7e祖先；此前additional向量错误两例保持原证据，本轮未重复。

`src/full-indexing.ts`的两个syncSegmentMetadata调用明确传primary/additional：setIndexProfile后写indexing标记，只有primary吞该标记错误并记录WARN，其余profile/segment/final-state错误仍传播。对照Rust `indexing.rs:2745-2764`的primary `if let Err→warn`与`:3124-3140,3190-3222`的additional `?→rollback/discard`，不能把两者统一best-effort。

新增`tests/index-service.test.ts`两参数用例均用真实L11仓储和SQLite触发器，仅拒绝目标Unit进入indexing：primary最终indexed、generation3、一个Segment、无discard且精确WARN；additional的profile/generation回滚为null/0、无Segment，记录对应向量ID的discard请求并将该Unit置failed，后续Unit和resource仍完成。Lance store/embedding及logger是故障/记录接缝，所测生产编排和SQL未替换；只证明discard请求，不证明真实Lance物理回收。新增越界dimension WARN本用例没有触达，不扩大动态签收。

```text
job 20261105050113-cc676f:
index-service.test.ts -t 'R12-06 indexing-state marker failure' --maxWorkers=1 --no-cache
Test Files  1 passed (1)
     Tests  2 passed | 31 skipped (33)
  Duration  14.01s
退出码 0；无Errors/unhandled errors
```

完整命令/log`/home/dsdev/.oc-jobs/done/20261105050113-cc676f.log`；31为名称过滤，未改skip。该marker差异子项候选通过，R12-06整组及main集成仍未决；主线15组保持。

## 20. R12-06 primary元数据失败后的恢复优先级

固定候选ca2ac9d5d（实际实现/测试e206b37dc、dd01a32e6），运行前后host/contracts/package/config差异仅BLOCKERS文档，目标闭包未漂移；候选非main6d759e81c祖先。

对照Rust indexing.rs:2846-2901：Unit恢复标记失败仅WARN，随后记录metadata失败ERROR并尝试discard；discard失败再ERROR，只有非InvalidState合并`sync; rollback failed: cleanup`并标resource failed/抛Other；InvalidState即使discard失败仍保原错误并标pending。候选`full-indexing.ts`的primary metadata catch按此顺序恢复，未将marker失败提前返回或覆盖原异常。

新增四例覆盖retryable×rollbackFailure：非retryable由真实SQLite Segment INSERT触发器抛错，恢复标记UPDATE也由真实trigger拒绝；retryable两例在真实L11 setIndexProfile接缝注入VfsRepositoryError，不能当作实际并发profile冲突测试。真实SQL回读确认profile/generation回滚、Segment为空，错误对象/合并message/code、resource状态与WARN→ERROR→可选ERROR逐项断言。Lance store和logger仍为故障/记录接缝，只签编排/错误优先级，不签原生discard、并发CAS或完整sink。

```text
job 20261105052749-1f0863:
index-service.test.ts -t 'R12-06 primary metadata recovery preserves error ordering' --maxWorkers=1 --no-cache
Test Files  1 passed (1)
     Tests  4 passed | 33 skipped (37)
  Duration  12.11s
退出码 0；无Errors/unhandled errors
```

完整命令/log`/home/dsdev/.oc-jobs/done/20261105052749-1f0863.log`，33为名称过滤，未改skip。只执行此新增四例，没有重复已签marker/追加Unit向量错误等旧集合。该恢复优先级子项候选通过，R12-06整组/正常main集成仍未决，主线15组不变。

## 21. C2限定：Lance-disabled真实生命周期候选

固定代码树 **d77bd5dbdd79b640e6cd8e6a85563c9cf602394e**：运行时0bba255b8，新增PDF OCR回归c007d461a，d77为规格收尾。审读前后host/contracts/package/vitest配置与固定树的差异仅BLOCKERS/LANE文档；c007至d77所涉实现/测试/依赖配置无新提交差异。候选仍非main。本轮按C2复用指定已完成作业，没有新提交测试任务，以下为直接取得的原回执，不冒称本人另跑Node/Electron。

### 生产接线与Rust分支

- `index.ts:32-34,57-68,88`将真实lanceLifecycle.enabled回调传入runtime-adapter；后者:450-472交给VfsFullIndexingService。`lance-disabled.ts:34-50`按当前store身份判断，不缓存初始undefined；provider安装/移除会切换store。写入禁用态按Rust `lance_store_stub.rs:28-34`抛InvalidState，保原code及Display前缀。
- `full-indexing.ts:819-827`先判断availability，再drain orphan、读config、claim；对应Rust `indexing.rs:4452-4478`。已准入批次:840显式把本轮true传给indexResourceWithOptions，不让后续单资源调用重新按disabled跳过已claim工作；下一轮重新读回调。此批内快照结论来自明确参数/调用链审读，不虚报provider在途移除的动态测试。
- 单资源:204-208取得availability，:265只在enabled时markIndexing；仍执行初次syncUnits和实际VfsOcrRecovery。:284-318在OCR成功（含Some空串对应的非null）后，disabled分支再次syncUnits，然后在chunk/embed及空文本indexed标记之前返回[0,0]，保pending；对应Rust`:2439-2500`。不是在入口整体return而遗漏词法数据更新。

### 测试真实性及既有结果范围

- `tests/index-service.test.ts:316-335`真实插件/owner种pending资源及orphan行，disabled批次不claim且队列整行不变；安装真实vectorPlugin后下一轮batchSize=0会进入claim并清理原orphan，资源仍pending。这证明晚到provider被识别，不把零批次扩签为完整向量索引。
- `:338-356`单资源disabled仍创建文本Unit，资源/Unit pending、无Segment，并经真实retrieval.search取得该资源；没有embedding provider也成功，避免用空替身隐藏错误生成。
- **新增c007例**`:359-386`走实际PDF preview/blob、VfsOcrRecovery和L11 files/Unit持久化；外部OCR候选/hedge提供确定文本。断言syncUnits两次、OCR文字进入pending Unit和ocr_pages_json、resource pending/retry0、无Segment。它证明OCR后真实二次同步，不签在线LLM/OCR并发许可；没有把此前缺此例的42条回执当证据。
- `tests/embedding-owner-errors.test.ts:48,65-86`新增真实vectorPlugin，三条首读/查询/重读错误和无Segment断言均保留。缺配置必须走原错误链，不能因disabled早退而假绿。

```text
job 20261105075942-9653ee（提供方原Electron作业，本轮直接取result）:
index-service.test.ts (40 tests)，新增PDF OCR例592ms
embedding-owner-errors.test.ts (3 tests)
Test Files  2 passed (2)
     Tests  43 passed (43)
退出码 0；无Errors/unhandled errors

job 20261105075942-a9b47d（提供方原Node目录作业）:
原log128/131：index-service 40tests通过，新增PDF OCR例618ms
原log145：embedding-owner-errors 3tests通过
Test Files  2 failed | 28 passed (30)
     Tests  3 failed | 283 passed (286)
退出码 1；无单独Errors/unhandled errors汇总

job 20261105075942-9b5805:
host/plugins/vfs/src/upload-attachment.ts(209,7): error TS2322:
Type 'number | null' is not assignable to type 'number | undefined'.
退出码 2
```

完整日志`/home/dsdev/.oc-jobs/done/<job>.log`均已读取。Node三失败分别是preview未知字段IgnoredAny溢出、f32最短小数及成功响应percent:null被契约拒绝，均保留失败预期和原exit1；没有以43通过代替整目录或类型门禁通过。结论为R12-01 Lance-disabled所查子链候选通过，非整个桌面向量能力已完成；两wire/共享decoder、L13类型错误、共享OCR许可、R11-07及正常main集成仍分别未决，主线总数16。

## 22. C2限时静态复核：R12-08 raw f32与snapshot测试边界

固定候选0442f61e6（代码40e4b150b，含5615f2e3e/ec39ebe7d/8b252cf5b）。当前提供方HEAD8470b46a8相对该树虽有其它lane改动，所审L12、F4 util、contracts、kernel commands和L13b pdf消费链无diff；不把后继全树当原运行快照。本轮只读源码/测试并复用指定原result，没有新增测试任务。

### 三处期望修改的结论

Rust `pdf_processing_service.rs:225-250`的percent为内部f32，`:2928-2940`先serde反序列化为typed ProcessingProgress再返回ProcessingStatus；`handlers.rs:6505-6523`在命令返回时进入序列化。TS内部`parseProcessingProgress`应保留精确binary32在JS number中的值；对外snapshot则投影为serde最短十进制number/null。

`pdf-service.ts:161-165`在8b之前已执行parse→processingProgressSnapshot，三条旧断言调用的getStatus并非raw parser（测试helper名rawStatus也只写DB再getStatus）。5615将snapshot从Math.fround改用公开f32ToJsonNumber；8b更新的是这个已存在的出站边界，不能要求继续返回widened binary32。ec39的`api.ts:3-12`明确内部percent:number，只有ProcessingProgressSnapshot为number|null，方向正确。

| 原输入 | 内部parser应保留的raw值 | getStatus/snapshot应观察的值 |
|---|---|---|
| 33.333333333333336 | Math.fround(33.333333333333336) | 33.333332 |
| JSON整数token (1n<<63n)+(1n<<39n)+1n | 2**63+2**40 | 9223373000000000000 |
| 12.3456789 | Math.fround(12.3456789) | 12.345679 |
| 1e40 | Infinity（仍为number） | null |

整数新期望仍与错误双重舍入后的9223372000000000000不同，未丢掉这个区分。三处原测试是TS追加serde回归，不是原Rust测试中直接比较这三个字面量；对应Rust类型/序列化语义才是判断依据。保留三条新snapshot期望是正确修订，不判成必须回退的弱化。

### 最小必补测试（尚待owner交付）

全L12测试检索未发现直接调用parseProcessingProgress验证这些raw percent的断言。`pdf-processing.ts:25-38`当前静态实现确实按f32读取；但snapshot的`f32ToJsonNumber`自身又Math.fround（F4 f32-json.ts:27-30），因此现有出站绿测会掩盖parser先返回未窄化f64的回归，不能单凭ec39类型number证明binary32不变量。

已向L12/C2发最小修订：在现有pdf-status-boundary测试导入生产parseProcessingProgress，补上述三个原输入的raw精确相等断言及1e40 raw===Infinity；整数用原BigInt拼JSON token，不先Number。保留现有getStatus及host.invoke的最短值/null断言，不把内部类型改nullable，不用helper往返替代raw断言。只需新增小集运行和固定提交，不需重跑286全集。

### 已复用的生产结果与合入边界

- `20261105100324-4cb20e`：Node **30文件286测试通过，108.93s，exit0**；原preview IgnoredAny、finite f32 wire与null成功响应三失败均真实通过，原预期未删除/反转。无Errors/unhandled errors。
- `20261105100324-766ff5`：`npm run typecheck:host` **exit0**。原日志均在`/home/dsdev/.oc-jobs/done/<job>.log`，已直接取result，非本人另跑。
- 5615在preview两未知字段分支及progress/issue未知字段分支消费公开skipIgnoredValue，已知字段仍走typed读取；snapshot消费公开f32ToJsonNumber，不复制共享算法。此处不扩大认证F4整个Value parser或最短算法的全域证明。

**明确建议：完成上述最小raw补测后，可合入本次L12限定语义/测试闭包；当前先保该补测条件。** Node全绿不是放弃raw不变量的理由，也不要求重做已正确的snapshot期望。该候选包含的F4旧307/L18 5e不覆盖C1尚待交付的最终Value高精度修正；不以type0签收L18。整R12-08、R12-01及主线16组未随此自动关闭。

### 补证结论：R3最小修订条件解除

已独立读取**bebb5ea64**新增的单一测试：`tests/pdf-status-boundary.test.ts:48-57`直接导入生产parseProcessingProgress，三原输入分别严格等于Math.fround(33.333333333333336)、2**63+2**40、Math.fround(12.3456789)，整数仍以原BigInt拼JSON token；1e40内部严格为Infinity。没有使用snapshot/helper回算raw，原三snapshot最短值和wire成功null断言均未改。

提供方曾另加重复用例2b798d6a0，后由bd61095ee精确撤回；最终pdf-processing.test.ts与原候选相同，所要求raw用例仍完整保留，不是撤回所需覆盖。当前固定**ccd402ae7**相关L12实现/API、F4 util及原snapshot/wire测试与0442f61e6无diff，仅增加上述raw测试和文档；当前工作树对该固定树host/contracts/package/config无diff，外来ledger未触碰。

直接复用原始结果，未新增runner：

| job | 原始结果 |
|---|---|
| 20261105102806-4359c5 | 新raw用例1passed/11名称过滤，14.76s，exit0 |
| 20261105103110-33ed17 | pdf-processing13＋boundary12＋service12＋wire4，4文件41passed，25.99s，exit0 |
| 20261105103110-21c7a0 | typecheck:host exit0 |

均无Errors/unhandled errors，日志`/home/dsdev/.oc-jobs/done/<job>.log`已亲取。旧286全绿仍仅属于原组合，不把后继其它owner变化写成原286重新验证。

**限定合入意见：可合本次L12 R12-08语义/测试改动，R3要求的raw覆盖已完成，不再以8b三预期变更阻挡。** 这不是批准整个夹带分支不经联合门禁合入：F4/L18最终Value高精度闭包、raw atom IPC边界仍由C1/F4/F1另行交付和验收；未新增实现修改或扩大R12整组签收。后续正常main集成按对应finding闭环，不重跑已确认的小集。

## 23. C2定向复核：媒体任务晚到错误与owner卸载顺序

候选**7847ae733＋ab947994d**相对ccd402ae7仅改`index.ts`和`src/pdf-service.ts`，测试、owner guard及原raw parser闭包未改。C2报告原联合运行1609个断言通过但有2个Unhandled，来自upload-file图片任务卸载后调用setError；该历史失败不得因后继绿测改写成通过，也不是L11未提供owner。

独立静态核对：`index.ts:46-52`的owner注入清理先disposePdf再unbind，`:99-100`另注册插件清理；`pdf-service.ts:328-331`对当前running逐一abort再clear。既有runTask在进度回调、await返回和catch写setError前检查isCurrent（`:231-237,264-266`）；该检查同时核对generation和未取消signal（`:278-280`）。所以本次卸载后的晚到成功/错误不再访问owner，正常在途错误的setError及日志路径保留；没有新增catch吞异常或放松所有权校验。Rust的generation隔离/任务清理与cancel token来源仍为`pdf_processing_service.rs:736-797,2947`；此结论限于已观察的Host卸载错误，不扩称全部运行时取消/worker语义等价。

原始JSON与日志亲取，两个job cwd均为`/tmp/opencode/l12-integ-fix`：

| job | 结果 |
|---|---|
| 20261105112148-f1df31 | upload-file原5例通过，19.39s，exit0 |
| 20261105112214-96592b | 原qbank/vfs/vfs-index组合181文件、1609通过/2跳过，1324.52s，exit0；upload-file5例包含其中，无Errors/Unhandled |

读取时该临时树HEAD为**3005fe6aa**（merge ab947994d），工作树干净，所审L12及upload-file测试与ab947994d无diff。job JSON本身未记录git SHA，运行时固定组合由C2提供，本次静态一致性核查不冒充历史快照证明。C2另报type/importable/boundaries为0，本轮未独立索取这些job，不冒称本人另跑。

**结论：本次teardown集成错误在指定候选组合中闭合，可继续正常集成。** 查验时ab947994d尚非main祖先；不将这次修后结果归到19:30的固定23c679e40全测，也不新增重复联合测试。R12-08既有raw/snapshot结论保持；主线16组与F4/L18最终Value边界仍分别等待对应复验。

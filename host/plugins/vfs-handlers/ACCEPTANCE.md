# L13b-vfs-handlers 独立验收（R3-review-vfs，2026-11-04）

结论：不通过

**当前官方门禁已全绿（2026-11-05）**：84c0847a7 / main a9683a43b四项自检通过。本人读取底层测试作业`20261105004018-600c88`：81文件、711测试通过，668.57s、exit0，无Errors/unhandled errors；其中L13b 24文件212测试通过，覆盖原embedding双Host失败。该集成验证阻塞正式解除，原710通过/1失败保留为修复前历史。按C2最新指令复用官方覆盖，不再追加embedding专项；R13-01/02及R12两个wire/generation缺口不连带关闭。

**门禁修复已main（2026-11-05，a9683a43b）**：`tests/embedding.test.ts:239-241`在第二次open前await销毁withoutLlm并移出afterEach列表；原两环境readiness/默认写回断言全部保留。这是测试生命周期修复，不改变被测配置算法或全局Slot单占用规则。已合并到84c0847a7并执行正式自检；下条710通过/1失败为修复前证据，修复后结果另记。

**修复前门禁红灯（2026-11-05，历史）**：main e9df01a3c全目录作业`20261105000156-58ee8e`为80文件通过/1失败、710测试通过/1失败、exit1，无Errors汇总；唯一失败为`tests/embedding.test.ts:233-240`的双Host装配。首个Host未销毁，第二个Host在L10注册F3模块级journal Slot时抛`SlotOccupied`，尚未执行第二组readiness断言。证据：`host/plugins/notes/index.ts:212-215`、`host/platform/storage/deletion-journal-owner.ts:32-34`、`host/kernel/primitives.ts:31-33`。当时已回C2协调L13b/F3/L10，现由上述711全绿证据解除；原R13-06配置委托签收没有被误判成算法错误。修复保留两组readiness断言并调整宿主生命周期，R3未代改实现或测试。

**Linux续作基线（2026-11-05，main e9df01a3c）**：R13-01/02仍未决。真实生产仍可选注入`vfsAttachmentConfig`（`index.ts:204-205`），全host仅测试提供该服务；`src/todo.ts:113-127`和`src/pomodoro.ts:44-63`仍直接同步调用仓储，未消费已main的vfsWorker。两个原线程测试正确保留pending（`TESTMAP.md:76-77`）；F3/L11接口已可用，剩余是消费者改造，不应再回派提供方重造接口。当前wiring为63条ported、未接入0；附件配置依赖和线程保证不能由该扫描推定通过。本轮运行结果统一见R3汇总的“Linux续作”节。

**最新main复验（bec9c35ba）**：已合并到32db28051，非审计代码与该main一致。本人20261104140133-86dbcd为4文件、18通过/21过滤、exit0、无Errors，原11条门禁失败已解除；R13-03、R13-06正式主线签收，R13-01.path-file与cache-vector文件阶段主线子项通过。R13-01仅保留附件根配置真实提供方缺口，R13-02线程消费仍未决；两个组不整组关闭，详见§12。早期“候选未集成/11失败”均为历史基线。

**最新门禁修复候选复核（6aac21c84）**：原11失败的三个文件已定向验证：files/paths作业20261104125015-4270f0为4通过/13过滤，embedding作业20261104125236-85de51为10通过/8过滤，均exit0、无Errors。修复保留业务断言，补真实LLM依赖、legacy tb夹具及Lance外部故障注入；新增X1 AppError Display用例亦通过。候选尚未进入main44b66353c，详见§11；审计分支的旧main门禁失败仍有效。

**§5自检更新（main d84e29565）**：审计树675d7e838的标准lane-gate仅tests失败；完整作业20261104120753-d134c8为3文件失败/83通过、11失败/813通过、exit1，无Errors/unhandled errors。7条embedding缺LLM必需服务，1条paths夹具前缀不符，3条files在Proxy方法的vi.spyOn准备阶段失败，未进入outbox断言。详见§10；不据截断门禁摘要遗漏后四条。

**v2 main门禁定向复现（eeaf5bdc7）**：作业20261104111754-3096fa仅跑paths/embedding：**8失败、17通过、exit1**，没有Errors汇总行；7失败因真实LLM新增必需依赖injectionBudget/llmCodexAuth未由测试宿主装配，1失败因paths.test.ts:69仍期望`/教材.pdf`，生产已改为Rust `/file_<id>`。R13-01.path-file的实现差异已修，测试错误期望仍需owner按Rust证据更新；不回退实现迎合旧断言。R13-06原分支委托通过记录保留，但该main的组合验证受宿主缺依赖阻塞，不能引用旧52绿测当当前main全绿。详见§9。

**最新 R13-01 子项复核**：固定修复树 `dea54622fc9ff749c80acc65007460ccc6b763ee`；共享harness已移除pending-maintenance-provider，八方法走真实L11。本人队列 `20261104072739-1c8f16`：3文件16通过/10过滤、exit0、无Errors；确认路径缓存/子树回滚、普通cache/OCR和AI子任务事务接线。仍有附件根配置缺提供方、cache vector缺文件阶段，以及本轮发现的`file_`路径标题额外分支；R13-01不整组勾选，R13-02保持未决，见§8。

**最新 R13-05 定向复核**：修复树 `10ffe5ba89024da238ec941b384d281f797776da`（代码/测试在前置 `0e6614b14`）的剩余EOF分类/位置已复核通过，**待main集成**。本人最小作业 `20261104064143-3b9fe2`：1通过、11因`-t`过滤未执行，exit0，无Errors；运行树`00a2c54f6`的相关PDF实现/测试与修复树相同，详见§7。当前本lane仅R13-01/02未决；R13-03/04/06沿用原验收，不重复全套。

**后续worker候选核对**：已读取 L11分支 `f470e5c89` 的vfsWorker并通过队列亲跑4条服务测试；线程/独立连接确有实现，但其连接绕过维护纳管、线程内logger未绑定，且该固定树未见L13b消费vfsWorker。R13-02保持未决；维护模式下worker仍可返回业务结果的生产service反例记于L11 ACCEPTANCE §6 / R11-05。没有重跑本lane先前已过的52例，也没有修改线程测试或D8映射。

**最新定向复核（C2 05:14 指令）**：已审读并亲跑分支 `ds-mig/L13b-vfs-handlers` 固定树 **`062b316fc5060276092e7f46496cdda9f6b739a8`**。R13-03/04/06 在该分支复核通过，**尚待集成 main**；R13-01 部分修复，R13-02/05 仍未决。分支未决组数为3；本次读取的 main `e30395712` 未包含该修复树，不能宣称 main 的相应3组已关闭。入口、52条最小测试、R13-05剩余反例见 §6。

**定向复核更新（C2 04:25 指令）**：新 main 快照 `29bc10a470c9d50ed80671cfb232c0bdee972b1b` 已补14条导图/附件真实仓储接线和 unitBuilder 提供方。R13-01 部分子项确认，R13-03 的文件删除调用链尚未修复，详见 §5。以下首次清单/测试结果保留为历史基线；旧“导图/附件只有替身”的描述不再适用于新接线。6个组级必须修复项仍未闭合。

审读基线：`f23c9870282cc95907661df6dae3cdf6cb232fa1`。原无 ACCEPTANCE。`R/` = `src-tauri/crates/dstu-vfs/src/vfs/`，`T/` = `host/plugins/vfs-handlers/`，`I/` = `host/plugins/vfs-index/`。本 lane 使用 `contracts/ipc/L13-vfs-api.json`；index 的 lane 字段仍为 L13-vfs-api，不另造契约。

## 必须修复

- [ ] **R13-01（main子项通过，附件配置仍未决）**：bec9c35ba已真实接入L11维护；path-file分派和cache-vector的OCR→磁盘→SQL阶段经本人20261104140133-86dbcd确认，详见§12，不再派修已闭合两子项。`vfsAttachmentConfig`三个根目录写方法仍无生产提供方，只有测试pending provider；故整组保持未决。普通路径/cache/AI持久化历史证据见§5–8。
- [ ] **R13-02（高，测试弱化/线程语义）“DB 不在异步运行线程”被改成 CRUD 成功。** Rust 测试比较线程 ID，两个 blocking runner 都必须异线程；TS 注释反而称 inline 执行等价，实际只断言创建和读取。生产 todo/pomodoro 也直接同步调用仓储；search_all 的四类 spawn_blocking 并行搜索同样变为同步串行。应保留非阻塞执行保证并测同一不变量，不能以测试标题保留替代线程断言。（证据：`T/tests/todo.test.ts:12-25`、`T/src/todo.ts:113-127`、`T/src/pomodoro.ts:44-63`、`T/src/resources.ts:260-324`；Rust：`R/todo_handlers.rs:77-103,1263-1291`、`R/handlers.rs:843-922`；`T/TESTMAP.md:72-73`。）
- [x] **R13-03（main复验通过）**：bec9c35ba真实invoke三场景经20261104140133-86dbcd通过，原SQLite outbox→text→multimodal→失败warn后软删顺序、维度计数、不调用旧full-indexing及不markPending断言保留。测试修复对Lance生命周期Proxy的外部故障注入，不再卡在spy准备阶段。Rust对照`R/index_service.rs:375-436`、`R/repos/file_repo.rs:1755-1793`；历史候选见§6，主线证据见§12。
- [x] **R13-04（修复分支复核通过，待集成 main）**：`062b316fc` 的 `T/src/pdf.ts:40-50` 恢复sanitize_unicode→前缀顺序；`T/tests/pdf.test.ts:27-47` 已经由真实invoke亲跑，检查四命令拒绝且下游未调用、批量warn并跳过。Rust对照 `R/handlers.rs:168-188,6517-6518,6546-6547,6571-6572,6609-6610,6648-6655`。
- [x] **R13-05（修复分支复核通过，待集成 main）**：步骤前缀/结构校验/None与Some/exam分支已有§6的真实测试证据；剩余EOF错误分类在 `10ffe5ba8:src/pdf-preview.ts:97-151` 改按当前token/容器判定。`tests/pdf.test.ts:169-196` 经真实invoke逐字断言value列9/24、object/list/string、嵌套、中文UTF-8列与换行、exam前缀；本人队列20261104064143-3b9fe2通过。Rust对照 `R/handlers.rs:3030-3031`、锁定serde_json1.0.149的de.rs:323-327,1741-1745,1941-1957,1991-2013与read.rs:421-429。仅关闭本编号已发现差异，不宣称所有serde语法全域已证明；旧反例保留为修复前历史，详见§7。
- [x] **R13-06（main复验通过）**：bec9c35ba的真实LLM provider/预算依赖已在测试宿主接入；20261104140133-86dbcd覆盖dimension组10例，包含assignments读取/默认回写同时失败仍按Rust顺序选配置，旧7条宿主启动失败解除。生产继续委托llmEmbeddingModels，不恢复本地fallback/localeCompare。Rust对照`R/handlers.rs:4199-4221`及LLM rag_extension.rs:169-247；仅签本lane委托/原差异，非LLM全功能，详见§12。

## 建议

- [ ] 更新 TESTMAP 标头：正文是56条 ported + 8条 pending，不是开头所称的7条 pending；亲跑为157 tests，不是153。（`T/TESTMAP.md:4-7,14,34-44`。）协调者需将本地 destinations 同步到权威 `host/plugins/vfs/TESTMAP.md`，不能把当前局部副本视为整个 L13 闭合。
- [ ] 将 `repository/embedding.ts`、`repository/index-admin.ts`、`src/paths.ts:46-47,96-97` 的待交接写实现随 R13-01 迁给表所有者；当前仅测试调用这些写函数，不能把模块可达算作生产已调用。

## 已核实通过

- [x] **复核确认**：note create/update 保留5MiB UTF-8限制，先大小再title/ID；tags默认[]，expectedUpdatedAt透传；删除先capture、成功后continuation。（`T/src/notes.ts:44-87,127-148`；`R/handlers.rs:461-555,647-668`。）
- [x] **复核确认**：资源/文件常规读取、无资源时null、内容缺失时 `{content:null,found:false}`，UTF-8大小规则未替换成JS字符串长度。（`T/src/resources.ts:76-113,151-189`、`T/src/files.ts:70-94`；`R/handlers.rs:241-273,356-444,2783-2838`。）
- [x] **复核确认**：refs样本真正调用生产SQL/提取函数，null/空白/OCR与解析文本取长者的核心断言同义，使用独立测试库。（`T/tests/refs.test.ts:11-27,31-107`；`R/ref_handlers.rs:2066-2349`。）
- [x] **复核确认**：`vfsHooks` 版本/声明/提供一致，跨插件 import 仅 api.ts；生产目录未见 console 或测试目录导入。（`T/api.ts:17-27`、`T/index.ts:196,266-267`；非tests TS import/console扫描。）
- [x] **复核确认**：157条测试和Node入口导入通过；不以此替代 R13-01 的实际依赖证明。

## 1. 命令等价抽查（18 条）

表中“通过”是本 lane 所查薄层分支；其他 lane 的已知依赖缺陷不因此被豁免。返回数字精度以依赖仓储为界，另见 L11/L12；本 lane 多模态 score 显式 Math.fround 对应 Rust f32。

| 命令 | 结论/重点 | TS 证据（T/） | Rust 证据（R/） |
|---|---|---|---|
| vfs_create_note | 通过：5MiB→空title顺序，tags=[]，错误字符串 | `src/notes.ts:53-70` | `handlers.rs:461-500` |
| vfs_update_note | 通过：大小→ID，content/title/tags/OCC完整传递 | `src/notes.ts:72-88` | `handlers.rs:517-556` |
| vfs_get_note | 通过：ID校验后取仓储，缺行null | `src/notes.ts:90-98` | `handlers.rs:568-579` |
| vfs_list_notes | 通过：缺省params、search=null、limit=50/offset=0 | `src/notes.ts:108-125` | `handlers.rs:615-634` |
| vfs_delete_note | 通过所查顺序：capture→deleteWithFolderItem→continuation；失败不执行后续 | `src/notes.ts:127-149`; `src/hooks.ts` | `handlers.rs:647-668` |
| vfs_create_or_reuse | 通过核心分支：类型/字节上限，sourceTable=null，返回hash/isNew | `src/resources.ts:123-143` | `handlers.rs:301-344` |
| vfs_search_all | 问题 R13-02：并行阻塞任务改为同步串行；空白拒绝/cap50/warn继续/排序分页保留 | `src/resources.ts:249-334` | `handlers.rs:811-1014` |
| vfs_get_blob_base64 | 问题 R13-05；正常base64、mime默认image/jpeg、size保留 | `src/files.ts:97-119` | `handlers.rs:2859-2900` |
| vfs_delete_file | 问题 R13-03；file_限制与warn继续存在，调用的删除算法不同 | `index.ts:329`; `src/files.ts:124-145` | `handlers.rs:2751-2773`; `repos/file_repo.rs:1755-1793` |
| vfs_get_pdf_processing_status | 问题 R13-04；下游还存在R12-08 wire形状问题 | `src/pdf.ts:39-57` | `handlers.rs:6505-6524` |
| vfs_get_pdf_page_image | 问题 R13-05；压缩图优先/jpeg规则正常，解析/错误不等价 | `src/pdf.ts:150-228` | `handlers.rs:2957-3102,3106` |
| vfs_get_resource_path | 问题 R13-01：实际命令仅requireMaintenance；测试跑候选实现 | `src/paths.ts:41-47` | `handlers.rs:1044-1127` |
| vfs_sync_resource_units | 问题 R13-01：合法input无builder提供方 | `src/index-admin.ts:77-81`; `index.ts:297-311` | `index_handlers.rs`; `index_service.rs:14-280` |
| vfs_create_mindmap | 问题 R13-01：默认content/view存在，但无实际service | `src/mindmaps.ts:21-40`; `index.ts:212-216` | `handlers.rs:5089-5123` |
| vfs_get_embedding_readiness | 问题 R13-06：配置回退错误策略不同；返回可空字段外形正确 | `src/embedding.ts:150-205` | `handlers.rs:4199-4221` |
| todo_create_list | 问题 R13-02：字段/default/成功后事件正确，阻塞隔离丢失 | `src/todo.ts:113-127`; `index.ts:367` | `todo_handlers.rs:77-92,232` |
| todo_ai_breakdown | 问题 R13-01：解析标题有真实函数，但保存依赖测试provider | `src/todo.ts:715`; `tests/todo.test.ts:128-149` | `todo_handlers.rs:1008,1096-1140` |
| vfs_multimodal_search | 通过薄层：query模式/原始字段传递、topK=10、flatten结果、f32 score/null字段 | `src/search.ts:155-217` | `handlers.rs:6200-6221,6253-6333` |

## 2. ported 测试真实性抽查（23 条）

前17条位于 `T/TESTMAP.md:45-61`，后6条位于 `:72-77`。Rust/TS源均读过断言。refs fixture相对原Rust换了较长OCR字符串，但仍保留长短关系、两页标签和相同关键词，不视为断言弱化。

| 原测试 | Rust（R/） | TS（T/tests/） | 结论/同一行为 |
|---|---|---|---|
| test_extract_file_text_ocr_priority | `ref_handlers.rs:2066` | `refs.test.ts:31` | 通过：OCR更长、两页标记 |
| test_extract_file_text_extracted_fallback | `ref_handlers.rs:2092` | `refs.test.ts:38` | 通过：无OCR取原解析文本 |
| test_extract_file_text_empty_ocr | `ref_handlers.rs:2108` | `refs.test.ts:43` | 通过：null/空OCR回退 |
| test_extract_file_text_no_content | `ref_handlers.rs:2130` | `refs.test.ts:47` | 通过：null |
| test_extract_file_text_nonexistent_file | `ref_handlers.rs:2142` | `refs.test.ts:51` | 通过：缺行null |
| test_extract_file_text_by_resource_id | `ref_handlers.rs:2152` | `refs.test.ts:52` | 通过：res_别名查询 |
| test_extract_file_text_longer_wins | `ref_handlers.rs:2173` | `refs.test.ts:56` | 通过：解析更长且无OCR页标签 |
| test_extract_file_text_whitespace_only_extracted | `ref_handlers.rs:2198` | `refs.test.ts:61` | 通过：忽略空白取OCR |
| test_get_ocr_pages_text_valid | `ref_handlers.rs:2225` | `refs.test.ts:65` | 通过：3页内容和标签 |
| test_get_ocr_pages_text_with_nulls | `ref_handlers.rs:2244` | `refs.test.ts:73` | 通过：保留1/3页，不含2/4页 |
| test_get_ocr_pages_text_empty_array | `ref_handlers.rs:2265` | `refs.test.ts:81` | 通过：[]→null |
| test_get_ocr_pages_text_all_empty | `ref_handlers.rs:2277` | `refs.test.ts:85` | 通过：空白/null→null |
| test_get_ocr_pages_text_invalid_json | `ref_handlers.rs:2289` | `refs.test.ts:89` | 通过：坏JSON→null |
| test_get_extracted_text_valid | `ref_handlers.rs:2305` | `refs.test.ts:93` | 通过：读取原字符串 |
| test_get_extracted_text_empty | `ref_handlers.rs:2323` | `refs.test.ts:97` | 通过：空串→null |
| test_get_extracted_text_whitespace_only | `ref_handlers.rs:2334` | `refs.test.ts:101` | 通过：空白→null |
| test_get_extracted_text_none | `ref_handlers.rs:2345` | `refs.test.ts:105` | 通过：SQL NULL→null |
| database_work_does_not_run_on_the_async_runtime_thread | `todo_handlers.rs:1264` | `todo.test.ts:12` | 问题 R13-02：线程ID断言完全消失 |
| blocking_runner_preserves_business_error_contracts | `todo_handlers.rs:1277` | `todo.test.ts:27` | 问题：只测业务错误形状，无blocking runner；错误fixture也改为InvalidArgument |
| parses_plain_string_array | `todo_handlers.rs:1295` | `todo.test.ts:43` | 通过函数行为：3个原中文标题 |
| parses_fenced_and_object_array | `todo_handlers.rs:1301` | `todo.test.ts:47` | 通过函数行为：围栏/object.title |
| extracts_array_from_surrounding_text | `todo_handlers.rs:1308` | `todo.test.ts:52` | 通过函数行为：从周边文本抽数组 |
| rejects_garbage_and_filters_empty | `todo_handlers.rs:1314` | `todo.test.ts:57` | 通过函数行为：垃圾→[]、过滤空标题 |

refs 被 `index.ts:24,260-265` 的真实命令消费；解析标题函数也在 AI 命令中调用，但整条 AI 功能仍因 R13-01 不可用。没有把这4个纯解析测试当成端到端AI证明。

审批：本地64行没有 obsolete/merged。`migration/approvals.json:37-39` 批准的是已退役 question_sync_service 的3条测试，不批准本页线程弱化或8条pending。

## 3. 亲自运行（原始输出摘要）

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/vfs-handlers
Test Files  17 passed (17)
     Tests  157 passed (157)
  Duration  59.32s
REVIEW EXIT: vfs-handlers 0
(node:...) ExperimentalWarning: WASI is an experimental feature and might change at any time

$ node scripts/electron-migration/importable.mjs host/plugins/vfs-handlers/index.ts
importable: ok
$ node scripts/electron-migration/wiring.mjs --lane vfs-handlers
合计 ported 56，其中所测模块未从 index.ts 接入 0（0.0%）
```

所有测试为迁移库模板的临时副本，`T/tests/harness.ts:31-56`；没有编译/运行Rust。

## 4. 架构与语义差异分类

- **通过**：版本化 vfsHooks 真实提供；生产跨插件引用经 api.ts；notes 等表写通过所有者仓储；SQL位于repository；未把 pendingMaintenanceProvider 导入生产。
- **问题**：R13-01 未实现服务把“已经注册”与“应用可运行”混淆；R13-03 以相似名字的另一删除算法替代；R13-06 本地复制LLM选择逻辑。维护写实现留在本插件但只被测试调用，不能作为生产表所有权合格的完成证据。
- **应修语义差异**：上述 R13-01–06；下游 L12 的缺 runtime、reranking、PDF Option 与持久JSON错误也会从本 lane 命令暴露，修复归对应所有者，不在此重复计数。
- **已登记的平台差异/缺口**：`T/SPEC.md:3-11` 的共享Unicode/时间实现确实被导入；`SPEC.md:18,28-47` 登记了未接线能力，但登记缺口不等于批准功能缺失。`decisions.md:34-35` 接受的少量诊断细节不包括删掉整个步骤错误前缀，也不包括结构化DTO的null/缺省改变。
- **五项清单最终结论**：命令等价有问题；测试真实性有问题且TESTMAP未闭合；Vitest/importable通过；架构接线有问题；已发现差异均按上述编号/平台记录列出。B级不成立。

## 5. C2 定向复核：真实仓储接线与删除接口（2026-11-04）

新基线固定为 `29bc10a470c9d50ed80671cfb232c0bdee972b1b`，通过 git 对象只读审阅；本节 TS 行号属于新 SHA。已读取 `169a4256b` 及相关检查点的实际实现/测试、`fdaf6ca5a` 的提交差异；后者仅更新报告，本次不以它的自述证明接线。Rust 对照文件与首次基线无变化。

### R13-01：已确认的子项

**静态确认14条命令的缺失服务接线已修复**：`T/index.ts:211-253` 直接将持有的 `ctx.vfsRepo.mindmaps/attachments` 适配给命令层，复用 `database.getConnSafe()`，没有安装 vfsMindmaps/vfsAttachments 假提供方，也不再等待这两个服务名。

| 命令组（逐条列出） | 真入口/所有者 |
|---|---|
| `vfs_create_mindmap`, `vfs_get_mindmap`, `vfs_get_mindmap_content`, `vfs_get_mindmap_versions`, `vfs_restore_mindmap_version`, `vfs_get_mindmap_version_content`, `vfs_get_mindmap_version`, `vfs_update_mindmap`, `vfs_delete_mindmap`, `vfs_list_mindmaps`, `vfs_set_mindmap_favorite` | `T/index.ts:213-238` → `T/src/mindmaps.ts:35-90` → repos.mindmaps；所有者为L11真实仓储 |
| `vfs_get_attachment`, `vfs_get_attachment_content`, `vfs_delete_attachment` | `T/index.ts:240-255` → `T/src/attachments.ts:58-111` → repos.attachments；content保留res_→file alias/bounded读取 |

只关闭“依赖未发布服务而不可达”的子项，不扩大为14条全部分支/整套仓储已严格等价。

**静态确认 unitBuilder 已有提供者和消费点**：L12 `I/index.ts:176-190` provide vfsUnitBuilder；本 lane `T/index.ts:310-324` 注入并注册 sync命令，`T/src/index-admin.ts:77-81` 调用。原 TESTMAP `:20` 的“L12尚未发布真正builder”理由在该新 SHA 已过期；是否改ported仍应补新命令路径/原连接保证的验证，不能借本次静态确认直接改账本。

**仍未修复的子项**：本 lane `T/index.ts:202-205,296-305` 仍查找 `vfsMaintenance`，而L12发布的是 **vfsIndexMaintenance**。两者并未适配。`T/src/index-admin.ts:73-75,107-111` 的 reset/SQLite delete仍调用 requireMaintenance；路径、总重置、媒体cache/OCR、附件根目录写入、AI子任务同样依赖未发布的vfsMaintenance。L11仅分支上的接口不算该main快照证据。`T/tests/harness.ts:17,60-61` 仍默认安装 `tests/pending-maintenance-provider.ts:14-51`，不能用这些维护命令的旧绿测证明生产接齐。R13-01保留未勾选。

### R13-03：新接口的顺序与实际调用方

1. **提供方 SQLite 子阶段静态确认正确**：`I/src/unit-sync-service.ts:140-156` 是 getUnits→收集Lance IDs→L11 purgeIndexArtifactsByResource→refreshCounts，返回结果；Rust `R/index_service.rs:375-414` 同顺序。它不触碰Lance，不额外markPending。
2. **提供接口尚不构成 full deletion**：`I/api.ts:45-52` 的 `VfsIndexMaintenanceService.deleteResourceIndex` 只承诺SQLite部分；Rust full方法在上述阶段后 text→multimodal（`R/index_service.rs:423-436`）。消费者必须把这个顺序接完。
3. **文件删除命令仍未修复**：新 `T/index.ts:336-343` 的 `deleteIndex` 仍指向 `indexService.indexing.deleteResourceIndex`；`I/src/full-indexing.ts:669-682` 仍为 multimodal→text→SQLite→markPending。`T/src/files.ts:124-145` 未变，仍在该错误后warn并继续软删。故首个Lance错误时仍不能先留下原Rust的SQLite孤儿队列意图。R13-03整项未关闭。
4. **索引管理删除也未切服务名**：`T/src/index-admin.ts:107-121` 虽写了SQLite→text→multimodal次序，SQLite入口仍是vfsMaintenance；这与文件删除是不同命令，不能拿它或新provider的单测替代文件删除接线证据。

### 真测试入口与断言（本轮为源码审读）

- `T/tests/repository-wiring.test.ts:5-8` 通过 createVfsHost/host.invoke；harness `:11-16,60-61` 装真实L11/L12/notes/vfs和本插件。
- `repository-wiring.test.ts:11-55` 真实创建导图/文件夹，读取内容；写时复制保持另一导图不变；版本读取/恢复、过期OCC拒绝、收藏/软删均通过命令调用并检查持久结果。`:57-67` 专门保留Rust已有snapshot alias行为，不擅自修原行为。
- 同文件 `:70-87` 使用真实附件upload作fixture，invoke元数据/内容/删除；断言res_别名返回base64、6字节预算可读/5字节按保守上界拒绝、缺资源not found、软删后仍可读元数据。这3条命令的被测仓储没有stub掉。
- `I/tests/unit-maintenance.test.ts:185-206` 通过ctx新服务验证删unit、orphan队列和维度计数，但没有执行 `vfs_delete_file`，也没有后续text/mm顺序断言；因此不能关闭R13-03。
- 此轮不执行旧工作树的Vitest，不引用实现者报告的“161通过”作为亲跑证据；上节157通过仍仅对应首次基线。新快照接线确认是静态证据，动态回归结果尚未由本验收人取得。

**结论**：R13-01 部分修复，R13-03 尚未修复；R13-02/04/05/06 保留原未决项。组级计数仍为6，B级不成立。

## 6. C2 05:14 修复分支复核与最小实测（2026-11-04）

### SHA、集成状态与测试来源

- 固定修复树：`062b316fc5060276092e7f46496cdda9f6b739a8`，包含 `a19f8348e` 及前序检查点；062b316fc本身是报告提交，新增断言实际在前序检查点中，已按完整树读过。
- 固定政策/main树：`e303957124ac220f55bee1b04cca5d3937983b92`。`git merge-base --is-ancestor 062b316fc e30395712` exit **1**；两个树的llm/vfs-index/vfs-repos目录无diff，但本lane修复尚未集成。因此这里区分“分支代码复核通过”与“main已可用”。
- 所有shell从本审计工作目录发起；Vitest使用提供方目录作为只读测试输入（`--root`/绝对config），关闭cache。运行前提供方worktree干净；运行后对固定SHA的 `host contracts vitest.host.config.ts package.json` diff为空、status干净。未改实现/测试，未取出覆盖本工作树文件。

### R13-01：进一步确认的子项，整组保留

`T/index.ts:198` 将vfsIndexMaintenance/vfsUnitBuilder列为必需注入，`:309-314` 直接交给indexDeps，`src/index-admin.ts` 的reset/SQLite删除不再借vfsMaintenance。`tests/index-admin.test.ts:27-40` 通过真实 `vfs_sync_resource_units`，禁止额外数据库获取后仍验证unit文本与资源pending；`:42-78` 经真实公开维护服务验证text/mm/both、非法模式、触发器回滚和退避清零。上述本轮已跑；`repository-wiring.test.ts` 3条真实导图/附件用例也已跑。

剩余：`T/index.ts:202-205` 仍可选注入vfsMaintenance，路径、总重置、cache/OCR、根目录、AI子任务尚依赖它；harness继续安装测试维护provider。该provider已移除resetUnitIndex/deleteResourceIndex，不影响已确认的L12维护/文件删除修复，但其余绿色用例不能证明main接线。R13-01不整组关闭。

### R13-03/04/06：关闭原分支缺陷的证据

| 编号 | 入口/断言核实 | 结果 |
|---|---|---|
| R13-03 | files.test.ts:96-134 的invoke成功/text失败/mm失败；Lance回调只采样持久状态，断言放在invoke返回后，避免被生产best-effort catch吞掉；断言calls顺序、unit为空、outbox row存在、维度计数0、Lance阶段文件仍active、最后deleted、旧delete未调用、index_state/retry保持indexed/4、失败warn | 3场景通过；分支原删除问题关闭，待集成 |
| R13-04 | pdf.test.ts:27-47 的零宽/全角/BOM输入；先Unicode错误，不调用status/cancel/retry/start；批量只查有效ID且warn | 通过；分支原校验问题关闭，待集成 |
| R13-06 | embedding.test.ts:13-21装真实LLM插件，未替换getEmbeddingModelConfig；:236-247注入settings读取/回写失败，命令仍返回ready=true/modelConfigId=a；:228-234验证reason为字符串、非panic或挂起 | 通过；分支原复制/错误回退问题关闭，待集成 |

### R13-05：大部分已修，仍有可达的解析错误差异

已确认 `T/src/files.ts:97-123` 恢复connection/metadata/path前缀；`T/repository/pdf.ts:34-43` 恢复来源查询前缀及SQL NULL错误；`T/src/pdf.ts:143-218` 使用结构解析，None/Some文案、exam前缀、可选空hash处理对齐。`tests/pdf.test.ts:142-207` 和 `tests/files.test.ts:71-82` 已跑，对必需字段、数值范围、exam默认/必需字段、错误前缀有真实行为断言。部分底层故障注入直接调用生产handler函数，常规结果/校验和新增反例均另经host.invoke核实。

**剩余缺陷（仍归R13-05）**：`T/src/pdf-preview.ts:95-111` 根据整段JSON的第一个字符决定EOF错误种类，丢掉实际解析位置。给真实files.preview_json写入截断值再invoke `vfs_get_pdf_page_image`，观察到：

```text
{"raw":"{\"pages\":","error":"解析 preview_json 失败: EOF while parsing an object at line 1 column 9"}
{"raw":"{\"pages\":[]","error":"解析 preview_json 失败: EOF while parsing an object at line 1 column 11"}
{"raw":"{\"pages\":[],\"renderDpi\":","error":"解析 preview_json 失败: EOF while parsing an object at line 1 column 24"}
```

第一/三项 Rust 应为 **EOF while parsing a value**（列9/24），第二项是object。依据 `R/handlers.rs:3030-3031` 的typed serde_json::from_str，以及仓库锁定 `src-tauri/Cargo.lock:11347-11349` 的serde_json **1.0.149** 源码：`src/de.rs:2027-2033` 读冒号后委托字段解析、`:1737-1745` 的sequence和`:323-327` 的数字在无值时返回EofWhileParsingValue。读取对应[锁定版本源码](https://github.com/serde-rs/json/blob/v1.0.149/src/de.rs)，未编译/执行Rust。这是已有损坏持久JSON错误分支的迁移差异，不要求新防御算法。

补充探针使用真实repos/notes/index/vfs/media/handlers插件、临时迁移库，**未安装pendingMaintenanceProvider**，经host.invoke获得上述字符串；Node脚本正常退出0，只表示探针执行成功，不代表等价通过。应保留原错误分类；本轮不把R13-05整组勾选。

### 亲跑最小测试原始摘要

```text
$ npx vitest run --root /home/dsdev/dev/ds-mig/L13b-vfs-handlers -c /home/dsdev/dev/ds-mig/L13b-vfs-handlers/vitest.host.config.ts host/plugins/vfs-handlers/tests/files.test.ts host/plugins/vfs-handlers/tests/pdf.test.ts host/plugins/vfs-handlers/tests/embedding.test.ts host/plugins/vfs-handlers/tests/index-admin.test.ts host/plugins/vfs-handlers/tests/repository-wiring.test.ts --maxWorkers=1 --no-cache
 RUN  v3.2.7 /home/dsdev/dev/ds-mig/L13b-vfs-handlers
 ✓ host/plugins/vfs-handlers/tests/repository-wiring.test.ts (3 tests)
 ✓ host/plugins/vfs-handlers/tests/files.test.ts (9 tests)
 ✓ host/plugins/vfs-handlers/tests/pdf.test.ts (11 tests)
 ✓ host/plugins/vfs-handlers/tests/index-admin.test.ts (12 tests)
 ✓ host/plugins/vfs-handlers/tests/embedding.test.ts (17 tests)
 Test Files  5 passed (5)
      Tests  52 passed (52)
   Start at  13:28:46
   Duration  25.22s
```

退出码 **0**；原输出**没有 Errors 汇总行，也没有 unhandled errors**；有WASI ExperimentalWarning。本轮只亲跑Node最小集，不以owner的Node/Electron171通过报告替代本次结果，未重跑Electron/全lane。

`T/TESTMAP.md:4-7,76-77` 已将两条blocking-runner测试退回pending；本轮没有因此关闭R13-02，线程保证仍缺。当前分支状态：R13-01/02/05未决，R13-03/04/06修复复核通过待main集成；整个lane仍不通过。

## 7. R13-05 剩余 EOF 分类/位置复核（2026-11-04）

### 基线与集成边界

- 修复固定树：`10ffe5ba89024da238ec941b384d281f797776da`。该提交仅改QUALITY-REPORT，实际44行EOF分类与30行测试位于 `0e6614b14`，已读完整diff，不以报告自述签收。
- 本人运行固定树：`00a2c54f6113e8705c6f7c60e0a3b0b9e770285b`。此树晚于修复、包含部分平台settings等变化；`src/pdf-preview.ts`、`src/pdf.ts`、`repository/pdf.ts`、`tests/pdf.test.ts`、`tests/harness.ts`、`index.ts` 及相关Rust/Cargo.lock/kernel command路径与10ffe5ba8无diff。故明确区分修复来源与执行树，不虚称执行了旧完整树。
- main对照固定为 `9c13dfc39f2c29aaffda6c61f7dedee2273197f5`；修复树/运行树均非其祖先（exit1）。仍只签收分支修复，main可用性待集成；工作树测试输入与固定执行树无diff。

### 分类、位置和真实性

`T/src/pdf-preview.ts:97-130` 跟踪嵌套object/list容器，跳过字符串内转义，冒号/逗号或未完成scalar对应value；完整成员后仍未闭合的容器对应object/list；未结束字符串对应string。仅在JSON.parse已报告EOF后调用（`:138-151`），不改变有效JSON业务解析。`location(:72-74)` 对最后一行按UTF-8字节计列、换行后从0计列。

对照仓库锁定serde_json **1.0.149** 源码（只读，未运行Rust）：de.rs:2027-2033从冒号进入字段反序列化；数字/sequence缺值分别在:323-327/:1741-1745报Value；SeqAccess空容器:1941-1943报List、逗号后:1952-1957报Value；MapAccess完整成员后:1991-1994报Object、逗号后:2007-2013报Value。read.rs:421-429按byte index相对最后换行求列，和共享位置输出一致。

新增测试 `T/tests/pdf.test.ts:169-196` 不替换parsePreview或handler：真实仓储创建file/exam，更新各自preview_json，再调用注册的 `vfs_get_pdf_page_image`。12个PDF输入逐字断言错误字符串，另1个exam断言前缀；期望种类/行/列写成固定值，不复用被测分类算法。其中首次反例明确为：`{"pages":` → value/1:9；`{"pages":[],"renderDpi":` → value/1:24；`{"pages":[]` → object/1:11。还含嵌套数组/对象、半个指数、未结束字符串、中文同一行/换行和尾换行3:0。

### 作业证据

本人发起的最小复验（所有重任务走全局job.mjs；只执行新增用例，不重跑原52例）：

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L13b-vfs-handlers -c /home/dsdev/dev/ds-mig/L13b-vfs-handlers/vitest.host.config.ts host/plugins/vfs-handlers/tests/pdf.test.ts -t "reports serde EOF at the actual persisted-preview parse position through invoke" --maxWorkers=1 --no-cache
job.mjs result 20261104064143-3b9fe2 --tail 180
 ✓ host/plugins/vfs-handlers/tests/pdf.test.ts (12 tests | 11 skipped)
 Test Files  1 passed (1)
      Tests  1 passed | 11 skipped (12)
   Start at  14:41:44
   Duration  14.34s
[作业 20261104064143-3b9fe2] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104064143-3b9fe2.log
```

11个skipped来自本次`-t`选择，不是修改测试为skip或删除原断言。原输出无Errors汇总行、无unhandled errors；有WASI ExperimentalWarning。

另亲自读取协调者提供的已完成job result，作为**他方发起的补充运行证据**而非本人重复执行：

```text
job.mjs result 20261104061303-8b0f39 --tail 160
 Test Files  1 passed (1)
      Tests  12 passed (12)
   Duration  21.65s
[作业 20261104061303-8b0f39] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104061303-8b0f39.log

job.mjs result 20261104061303-a752e9 --tail 160
> ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run -c vitest.host.config.ts host/plugins/vfs-handlers/tests/pdf.test.ts
 Test Files  1 passed (1)
      Tests  12 passed (12)
   Duration  20.85s
[作业 20261104061303-a752e9] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104061303-a752e9.log
```

两份原输出均无Errors汇总行/无unhandled errors，有WASI警告。它们未内嵌源码SHA，修复归属仍以本轮固定树静态比对和本人最小复验为准。

**更新**：R13-05分支复核通过待集成。R13-01/02仍未决；R13-03/04/06沿用已签收结果，没有追加全套或重审。L11 worker维护/日志、S04形状探测以及Q8消费链状态保持上轮，不因接口新增或本测试通过改变。

## 8. R13-01 真实维护接线与事务定向复核（2026-11-04）

### 基线与真正生产入口

修复树固定 `dea54622fc9ff749c80acc65007460ccc6b763ee`（该提交只改报告，代码在前序检查点）；本人运行树固定 `1bb65a4bc0aa824dc02fed298df9d629dd03d354`。两树的vfs-handlers/vfs-repos/vfs-index、paths/storage、contracts与vitest配置无diff；后续其他插件变化不冒称为旧完整树。运行期间仅有提供方报告文档变化，被测实现/测试与固定树一致。本节行号指dea54622f。

main固定对照 `679fd3e4d3bdaff9d38188aab851704e952b9ac0`：L11 index/api/maintenance仓储/service与修复树无diff，确认**提供方已在main**；dea54622f不是该main祖先（exit1），**消费者新接线仍只按分支签收**。

`T/index.ts:198-201` 必需注入真实vfsMaintenance；`src/maintenance-needs.ts:1-8` 直接引用L11 api而非本地13方法大接口。L11 `src/maintenance-service.ts:32-61` 的8方法分别委托同一个 `repos.maintenance`，`:64-73` 优先走真实vfsDatabase.getConnSafe/blobsDir。共享 `T/tests/harness.ts:58-65` 使用真实paths和插件集合，没有pending-maintenance-provider。旧 `repository/embedding.ts`、`repository/paths.ts`、media-cache写算法及paths候选实现已删除；未以测试提供者重写业务主体。

### 已确认的子项

| 子项 | 源码/Rust对应 | 亲跑断言及限定结论 |
|---|---|---|
| path查询/缓存 | `T/src/paths.ts:18-26`→L11 maintenance.ts:98-137；Rust handlers.rs:1044-1127 | 真invoke验证根路径、嵌套路径、已有缓存优先、UTF-8超1000不缓存；确认接入和这些分支，前缀差异见下 |
| path批量事务 | L11 maintenance.ts:141-185 BEGIN→逐项写→COMMIT；失败ROLLBACK/error；Rust handlers.rs:1144-1227 | paths.test.ts:152-164用第二条UPDATE触发器失败，断言两条cache均NULL；移除故障再调用成功且返回2。不是只测替身rollback |
| preview/压缩/OCR普通清理 | `T/src/media-cache.ts:27-46`→L11 maintenance.ts:340-397,415-442,450-480；Rust handlers.rs:7000-7158,7208-7282,7793-7827 | media-cache.test.ts:34-43,60-84真invoke验证source-id回退与pending、snake/camel preview、计数26字节/3项、只移除对应readyModes、压缩hash=原图不减ref；仅签收所查普通分支，不含vector |
| AI子任务持久化 | `T/src/todo.ts:714-719`→L11 service:32-33→maintenance.ts:236-250→todo-utils.ts的withSavepoint；Rust todo_handlers.rs:1096-1140 | todo.test.ts:128-169真invoke；LLM返回作为外部输入替身，持久化全是真owner。第二条INSERT触发器拒绝时返回VFS_STORAGE、只剩父任务、无todo事件；去故障后两子任务与create事件。事件在owner RELEASE成功返回后发出 |

八方法接线不是八方法全分支等价证明。AI此次只签收数据库事务/提交后事件，不据LLM测试输入宣称整条在线模型调用与非阻塞保证已闭合。

### 剩余差异（仍计R13-01，不另造已闭合结论）

1. **附件根配置仍缺生产provider**：`T/index.ts:202-205` 可选vfsAttachmentConfig；`src/attachment-config-needs.ts:2-8` 的三方法未发布。仅attachments.test.ts显式装 `tests/pending-attachment-config-provider.ts:7-16`，共享harness不装；paths.test.ts:167-172验证无provider明确拒绝。不能把其他方法的真实接线覆盖这三条。
2. **cache vector仍漏中间文件阶段**：Rust handlers.rs:7161-7178先计算lance/vfs目录大小、删除目录，失败warn后继续，成功设置vectorIndexCleared/totalBytesFreed，再`:7180-7203`删SQLite/清状态。L11 maintenance.ts:399-413直接从SQLite DELETE开始，`T/src/media-cache.ts:27-33`也没有补该阶段。即使末尾vector_indexed_at缺列同样报错，之前磁盘副作用仍不等价；继续由L11/索引所有者协调，保留本轮未决，不重复跑已知缺分支。
3. **本轮发现路径`file_`分支额外替代**：L11 maintenance.ts:215-218把`file`与`tb`一起查file_name；Rust handlers.rs:1259-1303只对`tb`查文件名，`file_`落`_ => None`后回退source_id。`T/tests/paths.test.ts:68-69` 用真实textbooks.createTextbook（L11 textbooks.ts:201生成`file_`）断言`/教材.pdf`，因此现有绿测实际固定了这处差异。应保留Rust `/file_<id>` 行为，不以“教材同样能显示标题”替代。此问题归L11路径owner，记录为 **R13-01.path-file** 跨lane子项，不撤销其余路径回滚/缓存通过项。

三条路径TESTMAP已标ported，源测试为Rust handlers.rs:8178-8218；它们现在真走命令，不再依赖测试专用parser。但`test_source_id_prefix_parsing`中大量不存在ID的fallback不能证明每种前缀选择，且file_额外期望不同于Rust生产分支，须修该行为证据；不能以“63 ported”宣布B成立。

### 队列最小结果

```text
job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L13b-vfs-handlers -c /home/dsdev/dev/ds-mig/L13b-vfs-handlers/vitest.host.config.ts host/plugins/vfs-handlers/tests/paths.test.ts host/plugins/vfs-handlers/tests/media-cache.test.ts host/plugins/vfs-handlers/tests/todo.test.ts -t "path cache|OCR and media cache|todo_ai_breakdown" --maxWorkers=1 --no-cache
job.mjs result 20261104072739-1c8f16 --tail 160
 ✓ host/plugins/vfs-handlers/tests/todo.test.ts (12 tests | 10 skipped)
 ✓ host/plugins/vfs-handlers/tests/media-cache.test.ts (6 tests)
 ✓ host/plugins/vfs-handlers/tests/paths.test.ts (8 tests)
 Test Files  3 passed (3)
      Tests  16 passed | 10 skipped (26)
   Start at  15:27:41
   Duration  30.16s
[作业 20261104072739-1c8f16] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104072739-1c8f16.log
```

原输出无Errors汇总行/无unhandled errors。10条来自`-t`过滤，未改skip或断言。本人没有重复03–06或全套。

同时直接读取他方发起的原job result（补充证据，不冒称本人重跑；日志不内嵌SHA）：

| 作业 | 原摘要 | result退出码/Errors |
|---|---|---|
| `20261104065517-40f060` Node | 5文件48通过，59.92s | 0；无Errors汇总行/无unhandled errors |
| `20261104065904-a00652` Node todo回滚新增后 | 1文件12通过，38.90s | 0；无Errors汇总行/无unhandled errors |
| `20261104065904-ba478c` Electron | 5文件49通过，63.76s | 0；无Errors汇总行/无unhandled errors |

**结论**：R13-01的真实维护接线、路径已查普通/回滚、cache普通分支、AI事务子项确认，剩余上述3子项不勾选；R13-02继续等待真实worker维护/logger组合。03–06签收维持，本lane仍2个未决组、不通过。

## 9. v2 main门禁失败定向定位（2026-11-04）

按用户门禁指令已合并main固定eeaf5bdc7，未修改实现/测试。此前“unit-maintenance 9失败”在该main变为11例通过（L12报告§6）；新的L13b失败摘录单独验证，不将WIP/历史失败归到审计文档。

```text
job.mjs result 20261104111754-3096fa --tail 160
FAIL .../embedding.test.ts > validates model bindings and refuses a lone modelName
PluginLifecycleError: plugin "dstu.llm" did not start: required services not available: "injectionBudget", "llmCodexAuth"
（同原因共7条）
FAIL .../paths.test.ts > test_source_id_prefix_parsing
Expected: "/教材.pdf"
Received: "/file_YADRs0Vl_m"
Test Files  2 failed (2)
     Tests  8 failed | 17 passed (25)
  Duration  28.14s
[作业 20261104111754-3096fa] 退出码 1；完整输出 /home/dsdev/.oc-jobs/done/20261104111754-3096fa.log
```

命令经队列：`npx vitest run -c vitest.host.config.ts host/plugins/vfs-handlers/tests/paths.test.ts host/plugins/vfs-handlers/tests/embedding.test.ts --maxWorkers=1 --no-cache`。原输出无独立Errors汇总行，但存在上述8条失败，**不是通过**。

回派：L13b更新embedding.test.ts:13-19真实插件装配所需的新提供方（不要stub被测模型选择逻辑）；path测试:68-69根据已读Rust handlers.rs:1259-1303改为正确file_回退行为，并在修复提交说明原断言对应关系。当前不是“生产返回ID还需修成标题”，这是§8指出的错误期望被旧测试固定后的集成暴露。

该发现作为R13-01接线/真实性子项记录，R13-02仍待维护/worker日志真组合；不扩大发布R13-03/04/05修复的重复测试，也不关闭缺提供方的附件配置。类型检查与旧boundaries为绿并不覆盖这些测试宿主依赖；复核人只写结论，不在此代改实现/测试。

## 10. standard-v2 §5 自检完整结果（2026-11-04）

审计文档提交32829daf8后按新流程执行`git merge --no-edit main`，合并提交 **675d7e8381c777e0bc245723aab79932ab5f8461**，固定main **d84e29565f06f233f8ea6787487a5f9a11e17743**；相对main仅五份授权审计文档不同。运行指定`node /home/dsdev/dev/deep-student/scripts/electron-migration/lane-gate.mjs`，其检查通过全局队列执行，结果总exit1、失败项tests。未手动增跑R11已签身份/pragma用例；标准门禁按触及目录自动包含四插件全套。

| 检查 | job | result原结果 |
|---|---|---|
| typecheck | 20261104120753-ee7eff | exit0，tsc无错误 |
| boundaries | 20261104120753-e84b54 | exit0，2430文件、0 violations、167 suppressed；普通模式 |
| importable | 20261104120753-b67fad | exit0，四插件入口ok |
| tests | 20261104120753-d134c8 | **exit1**，3文件失败/83通过，11失败/813通过，504.13s；无Errors/unhandled errors |

四项均已读取job.mjs result；原日志在`/home/dsdev/.oc-jobs/done/<job>.log`。门禁tests实际命令：`npx vitest run -c vitest.host.config.ts host/plugins/vfs-handlers host/plugins/vfs-index host/plugins/vfs-repos host/plugins/vfs`。不得把813通过写为全套通过。

### 三类失败及最小回派

1. **embedding.test.ts:13-19，7条**：`PluginLifecycleError: plugin "dstu.llm" did not start: required services not available: "injectionBudget", "llmCodexAuth"`。仍需L13b补测试宿主真实提供方，保留模型绑定/默认值/失败回退全部断言；不是生产模型选择结果不符。
2. **paths.test.ts:68-69，1条**：expected `/教材.pdf`，received `/file_rbdNEeOH2o`。Rust handlers.rs:1259-1303只在tb分支查标题，现代工厂生成file_；生产IDfallback正确。L13通知同构service-wiring修法：用真实legacy tb_def456夹具保留标题断言，另断言现代工厂file_回退，方向正确；该候选未进入此main，不能据通知关闭本文件失败。
3. **files.test.ts:109，3条null/text/multimodal**：`Error: deleteByResource does not exist`发生在`vi.spyOn(vfs.host.ctx.vfsIndex.lance, 'deleteByResource')`，在`:124` invoke及`:125-133`业务断言前。L12 `src/lance-disabled.ts:34-42`公开的是空target、仅get trap的Proxy，普通属性访问会转发到current（disabled实现`:86-87`存在deleteByResource），但spy所需属性描述符/原型上没有该方法。**不能将此错误报告成实际删除漏写outbox或生产方法不存在**。回派L13b在实际生产调用的Lance接缝注入外部失败，仍保留outbox先持久化、计数清零、file提交顺序及失败warn断言；不要为spy增加生产Proxy兼容层。L12/L13b需要对齐真实服务可观测测试接缝。

本轮只写审计，不越权代改实现/测试。R13-01/02整组结论不变。F3 registry/maintenance/worker已在本main，但L13b线程消费仍待后继；R11-05等owner真实组合交付后最小复核。L11 2ac0e0a9a报告的PDF字段/范围修复不能代表duplicate/parser顺序闭合。

## 11. 门禁三类失败的候选修复独立复核（2026-11-04）

审读起点88184728c包含files/paths修复及此前LLM依赖修复；随后 **6aac21c84ca07aa86f20c5f6af1204ee8ef19ef9**提交原未保存的embedding AppError映射，本轮以此固定候选。files/paths运行期间只有该embedding映射变动，不在其调用路径；embedding运行时实现已提交。最终740c954ca相对6aac21c84仅LANE/QUALITY-REPORT变化，相关生产代码、测试及配置无diff。候选不是main45c3250b0祖先；新main44b66353c仅调度脚本更新，亦未含这些插件修复。

### 修复真实性与边界

- `tests/embedding.test.ts:13-28`装真实llm-providers/llm插件，预算服务对象使用F3同一InjectionBudgetManager/defaultBudgetConfig/newInjectionItem实现，不再提供空llmAdapters掩盖依赖。原getApiConfigs输入控制仍保留；原模型绑定/默认值/失败回退断言没有删除。真实llmCodexAuth提供方及预算能力使7条旧失败可进入被测逻辑。
- `tests/paths.test.ts:68-79`真实插入legacy tb_def456并保留`/教材.pdf`标题断言，同时验证现代工厂file_前缀与ID回退。对应Rust handlers.rs:1259-1303与textbook_repo.rs:136-137；没有修改生产标题策略。
- `tests/files.test.ts:109-119,142`只替换宿主`vfsIndex.lance`的deleteByResource外部调用面并在finally恢复；其余方法仍转发真实owner。生产`index.ts:342`每次调用读取该对象，原SQLite owner/outbox逻辑真实执行。原断言仍验证units为空、orphan入队、维度计数0、Lance期间file active、最终file deleted、resource状态不被擅改、失败warn与两模态调用顺序。没有为vi.spyOn扩展生产Proxy或删业务断言；三种null/text/mm场景均通过。
- **X1增量**：`src/embedding.ts:81-99`仅将真实LLM `CommandError.value.message`转换为命令字符串，assign/create先await apiConfigs再做维度操作。Rust handlers.rs:3415-3418/3512-3515使用AppError.to_string，dstu-core/models.rs:1038-1041 Display仅message。新增测试删除真实settings表，先确认owner仍返回AppError，再经两条invoke逐字断言错误、维度未写；通过的是实际失败边界，不是只构造错误对象。

### 本人队列最小结果

| job | 命令筛选 | 原结果 |
|---|---|---|
| 20261104125015-4270f0 | files.test.ts + paths.test.ts，`-t "persists deletion outbox\|test_source_id_prefix_parsing"` | 2文件、4passed/13过滤、37.20s、exit0 |
| 20261104125236-85de51 | embedding.test.ts，`-t "embedding dimension commands"` | 1文件、10passed/8过滤、39.90s、exit0 |

均经`job.mjs submit -- npx vitest run --root /home/dsdev/dev/ds-mig/L13b-vfs-handlers -c /home/dsdev/dev/ds-mig/L13b-vfs-handlers/vitest.host.config.ts ... --maxWorkers=1 --no-cache`执行，已取result，原输出无Errors/unhandled errors；完整命令与日志`/home/dsdev/.oc-jobs/done/<job>.log`。过滤不是改skip。

**结论**：11条旧门禁失败在该候选对应最小集已解除，另有新增AppError等用例通过；不是本lane全套、main或R13-01/02整组签收。已存的主线自检20261104123821-fc0bc3仍11failed/813passed、exit1；须owner修复集成后在正常main复验，不能靠审计分支改测试制造集成绿色。

## 12. 正常main门禁修复与cache-vector子项闭环（2026-11-04）

自动续派首先合并固定main **bec9c35ba26d42a31c0b2f035a2f9c8e4ad5be96**，审计合并提交 **32db2805141c379b0466250b06f0d320979851c5**。6aac21c84已为main祖先（exit0）；本工作树host/contracts/src-tauri相对main仅三份ACCEPTANCE不同，未编辑实现或测试。原11失败对应代码/夹具修复已正常集成，不再只引用候选结果。

### 原门禁三类问题

本人在正常main代码最小复验embedding dimension组10例、files outbox三场景、paths前缀1例，均通过。真实LLM服务缺口已补；legacy tb_def456保留标题断言、现代file_明确回退ID；Lance测试通过外部接缝注入失败，SQL/outbox/调用顺序/失败warn断言均保留。§11的测试真实性与Rust对应仍适用，新增X1 AppError Display顺序也在该main通过。

**主线状态更新**：R13-03/06正式签收，R13-01.path-file子项闭合；这不是将此前11失败日志改写为绿，旧job证据仍完整保留。

### R13-01.cache-vector文件阶段

生产`src/media-cache.ts:28-32`将真实clearVectorCacheDirectory传给L11维护；`vfs-repos/repository/maintenance.ts:543-585`先OCR清理，再调用磁盘阶段，最后DELETE segments/units、维度计数归零及原vector_indexed_at UPDATE。`src/vector-cache-files.ts`实际遍历临时目录计数并删除，计算失败取0仍尝试删除，删除失败由owner warn后继续SQL。对照Rust handlers.rs:7150-7205，不能因最后原缺列错误就跳过先前磁盘副作用。

新增`tests/vector-cache-invoke.test.ts`四条均经真实kernel、L11仓储和临时磁盘目录；fs.rmSync及db.run的spy只捕获时序并透传真实操作（失败用例在目录删除边界注入错误），快照断言在调用后执行，不会被best-effort catch吞掉：

1. 实际缺vector_indexed_at列：保留原错误，仍观测OCR先清、磁盘删除在vector SQL前，随后units/segments/计数已清。
2. 有legacy列成功分支：真实文件3字节＋中文6字节，删除后才计9字节与vectorIndexCleared=1。
3. 删除失败：真实Cordis exporter收warn及注入错误字段，目录保留，SQL继续，释放字节/清除数均0。
4. 目录不存在：无删除事件和磁盘计数，vector SQL照常执行。

确认原“缺失整个磁盘阶段”子项在main闭合，不扩大成整个cache命令所有数值/日志或F7原生引擎已完整验收。`vfsAttachmentConfig`仍只在tests/pending-attachment-config-provider.ts提供，生产仍可选inject；R13-01整组保留。index.ts仍无vfsWorker消费，R13-02继续未决。

### 本人最小队列结果

```text
job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/vfs-handlers/tests/embedding.test.ts host/plugins/vfs-handlers/tests/files.test.ts host/plugins/vfs-handlers/tests/paths.test.ts host/plugins/vfs-handlers/tests/vector-cache-invoke.test.ts -t "embedding dimension commands|persists deletion outbox|test_source_id_prefix_parsing|real vfs_clear_media_cache pre-vector file stage" --maxWorkers=1 --no-cache
job.mjs result 20261104140133-86dbcd --tail 110
Test Files  4 passed (4)
     Tests  18 passed | 21 skipped (39)
  Duration  29.77s
[作业 20261104140133-86dbcd] 退出码 0
```

无Errors/unhandled errors，21条为-t过滤；完整日志`/home/dsdev/.oc-jobs/done/20261104140133-86dbcd.log`。未重跑旧R11身份/pragma或新候选generation子链；本轮只修改授权审计文档。L13b主线未决仍2组。

# L13b 工作协议 v2 整改报告

## 上传主体准备与资源创建钩子（最新；三命令仍未完成）

- `src/upload-file.ts`准备Rust `handlers.rs:2108-2713`共用主体和`createDstuUploadService`。尚未在index.ts注册`vfs_upload_file`或provide`dstuUpload`，附件上传/论文下载同样未注册；不变更157/160或63P/2Q/3O的完成计数。
- `UploadSaga/saveUploadedFile`经L11仓储写blob/三表，同一conn的命名SAVEPOINT只在本lane repository层控制；补偿为逆序回退本次+1和归零cleanup，rollback后清孤立物理blob。没有复制owner写SQL或处理适配器。
- 修正草稿中`DatabaseHandle.savepoint`误用：F3该方法仅在TransactionScope上。按upload_saga.rs:43-94移植命名SAVEPOINT及开启/释放/rollback错误上下文（repository/upload-savepoint.ts）。首轮typecheck `20261104145427-d3d1ad` exit2、TS2339；首轮测试`20261104145643-17950b` exit1（6失败2通过）同因，未弱化断言。
- `api.ts`已公开`ResourceCreatedHook/VfsResourceCreatedHooks`；生产`ctx.vfsHooks`提供快照通知/按注册序调用/独立可注销的重复注册。保留原`VfsHandlersHooks`的note-only消费类型，Context使用两能力交集，避免要求L17 note-only测试实现媒体回调。初版把新方法加进旧接口导致`20261104150053-c1a53f` exit2（仅memory/tests/l13-ports.ts缺方法），已按实际消费边界拆分，无需改其他lane。
- `20261104150053-68d5cb`：准备的upload-save 8 + 生产provider resource-created-hooks 2，共10通过，exit0，无Errors/Unhandled。上传测试是真实迁移库/SQLite故障触发器/L11仓储，但没有完整命令invoke，因此不计ported；hooks测试走真实ctx.vfsHooks。后补SAVEPOINT异常分支等待最终门禁验证。
- `20261104145054-60d571` ledger exit0，problems全0；恢复时importable ok。最终以提交后lane-gate结果为准。

剩余精确接缝已通知L11/L18：L11 `0a3d703ad`的attachmentProcessing/mediaKind待main，同源PDF默认配置及不更新updated_at的上传ocr_pages_json WithConn写回待公开；L13 attachmentConfig待main。资源创建hook的L18转写回调仍待其消费。PDF编码最佳努力失败保持warn继续；HTTPS差异已核90秒/10跳/无缓存/无显式body上限，不用F4的10秒缓存下载替代，详情native-needs。

## X1 assign错误形状 + 集成门禁11条失败（最新）

- X1：`vfs_assign_dimension_model`/`vfs_create_dimension`中`get_api_configs`错误按Rust `map_err(to_string)`，即AppError Display=`message`（models.rs:1038-1041），返回字符串`检测供应商配置失败: no such table: settings`；其他错误原样交`fail`。真实dstu.llm + DROP settings回归在`tests/embedding.test.ts`。SHA `6aac21c84`。
- embedding 7条：真实LLM插件缺依赖。测试宿主现安装L01 `llm-providers`（llmAdapters/llmCodexAuth）和F3同款injectionBudget对象；harness改收`TestPluginEntry`。
- paths 1条：legacy `tb_def456`行保留`/教材.pdf`；现代`file_`回退ID（textbook_repo.rs:136-137，handlers.rs:1259-1303 `_ => None`）。实现未改。
- files 3条：L12 `vfsIndex.lance`改为生命周期Proxy，`vi.spyOn`无法挂载；命令每次读取`vfsIndex.lance`，测试改为临时替换包装对象，断言不变。
- 作业`20261104123719-90d533`：files/embedding/paths 35通过，exit 0；`20261104124547-3ab9cd` typecheck exit 0。

## C2 pre-vector接真（main e60e7a771，最新）

`vfs_clear_media_cache`已把`clearVectorCacheDirectory`作为`clearMediaCache`第二参数传给L11所有者；类型直接用所有者`BeforeVectorClear`，无强转。新增`tests/vector-cache-invoke.test.ts`经真实invoke验证：OCR已清→目录删除→vector SQL；缺列错误前目录已删；删除失败warn后继续SQL且不计字节；成功计`vectorIndexCleared=1,totalBytesFreed=9`；无目录不计数。

- `20261104110542-750277`：vector-cache-invoke 4 / vector-cache-files 5 / media-cache 6 全通过，exit 0，无Errors/Unhandled。
- `20261104110542-fc6bb5`：typecheck:host exit 0。
- `20261104105524-ba7b92`：ledger exit 0，problems 0。

TESTMAP不变（63P/2Q/3O）；线程两项仍等F3维护纳管，附件高级面仍等L13 attachmentConfig。

## L12 getStatusSummary接真

合并main后`vfsIndex.getStatusSummary`已由L12生产提供；`vfs_unified_index_status`改为只委托该入口，删除本lane统计组装，缺方法明确拒绝。见BLOCKERS。

- `20261104112627-c77bbf`：index-admin 13 / vector-cache-invoke 4 / media-cache 6 / vector-cache-files 5，共28通过，exit 0，无Errors/Unhandled（合并后复跑）。
- `20261104112627-2299f5`：typecheck exit 2，新测试对可选方法`vi.spyOn`推断为never（2处TS2339）；测试改为spy `Required<VfsIndexService>`后`20261104113107-fc8c13` exit 0，`20261104113107-2cd6bd` index-admin 13通过 exit 0。
- `20261104112250-ac7005`：ledger exit 0，problems 0。

## C2 07:31 pre-vector候选接缝准备（最新）

已核对L11 `c5123fa46/d173333a0`完整树的精确二参接口与调用时序，当前main仍是一参。`clearVectorCacheDirectory`有限文件原语及临时目录测试已准备；main可消费后再接callback并验证真实invoke中间阶段。当前不计接线完成、不变更63/2/3映射。`dependency-needs.ts`的Context已直接import所有者API类型，不强转签名。详情和后续阶段断言见BLOCKERS。

队列记录：`20261104074505-3233b9` ledger exit0、无命令/测试映射问题；`20261104074821-28b682`类型检查exit0；`20261104074821-918910`strict exit1（全仓4违规，本lane零违规零豁免）。首轮原语测试`20261104074821-aeec97` exit1，3通过2失败：Node ESM namespace不可spy；已改用Node fs默认对象注入底层读取/删除故障，保留全部断言。原生入口`importable: ok`，wiring63 ported/0未接入；新增准备性测试不加入TESTMAP。

```text
[作业 20261104075207-f5e245] npx vitest run -c vitest.host.config.ts host/plugins/vfs-handlers/tests/vector-cache-files.test.ts
Test Files  1 passed (1)
     Tests  5 passed (5)
[作业 20261104075207-f5e245] 退出码 0
```

最终最小测试无Errors/Unhandled；覆盖递归计长/删除、缺目录、regular-file保留、计长失败后仍删除、删除失败原样交给所有者。没有重跑已通过的EOF、导图/附件或全套测试。

## C2后续候选核对（最新）

- L12 `675eb70ff`的`vfsIndex.getStatusSummary`已在分支提供，main尚无；集成后本lane只保留命令错误映射，生产缺成员不得按测试double的可选标记静默漏能力。
- L17 `961a15b11`已有`memoryConfig.get/set`及SQLite datetime('now')；L13核对树`e684609e8`已有`vfs.attachmentConfig`高级业务层。撤回“等待L17重造附件根高级方法”的旧请求，改为等待这两候选集成后委托现有业务层，无需新增高级原子接口。Rust此处folder创建→config设置没有跨表事务，错误/空串/默认标题/日志按原业务层保留。
- 以上是只读分支/API/Rust核对及文档修正，没有复制提供方代码，没有新增平行memory_config SQL；main可用性、接线步骤和准确签名见BLOCKERS。

## C2 06:38：main L11维护八方法接真（最新）

- 已合入`9c13dfc39`，`index.ts`必需注入实际`vfsMaintenance`，类型引用L11 `api.ts`；共享harness不再安装维护替身。`repository/embedding.ts`、`repository/paths.ts`、media-cache清理/OCR参考写实现、paths候选算法已删除。
- 附件根配置三个写方法另属L17，拆为`vfsAttachmentConfig`最小接口。仅附件测试显式安装`pending-attachment-config-provider.ts`，不覆盖L11服务；共享harness验证缺该配置provider时正确拒绝。
- 三条路径Rust测试现经真实invoke/L11 provider通过，改ported；补子树触发器失败后整事务回滚。AI子任务新增第二条插入失败回滚及零事件、重试成功后才发create事件的真实invoke验证；LLM回答可用测试外部提供者，持久化主体不替换。
- TESTMAP **63 ported / 2 pending / 3 approved obsolete**，请协调者同步`TESTMAP-report.md`至L13权威表。两线程测试仍pending：vfsWorker已main，但维护屏障/日志纳管尚未闭合，生产不消费。
- 清理缓存的vector文件阶段仍需所有者阶段接缝，见BLOCKERS：目录删除不能挪到整次clear调用之前/之后。本轮真实验证preview/compressed/OCR和索引状态重置，不把缺失vector文件阶段计为完整等价。

队列结果（均使用`job.mjs result`读取退出码与完整输出）：

| 作业 | 验证 | 结果 |
|---|---|---|
| `20261104065517-40f060` | Node paths/media-cache/embedding/todo/attachments最小相关集 | 5文件48测试，exit 0，无Errors/Unhandled |
| `20261104065904-a00652` | Node todo新增回滚回归 | 1文件12测试，exit 0，无Errors/Unhandled |
| `20261104065904-ba478c` | Electron上述5文件最终集合 | 5文件49测试，exit 0，无Errors/Unhandled |
| `20261104065517-42fdcc` | typecheck:host | exit 0 |
| `20261104070116-807b49` | 新增todo回滚断言后的typecheck:host | exit 0 |
| `20261104065904-d6a27f` | strict boundaries | exit 1，全仓14违规；本lane零违规零豁免 |
| `20261104070116-006b9a` | ledger --check --no-write | exit 0 |

`importable: ok`；`合计 ported 63，其中所测模块未从 index.ts 接入 0（0.0%）`。

```text
ledger: commands 1058 (A 92% B 7.2% C 0%), tests 8036 (A 78.2% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

## R3 eb6e6e0f7 §6：R13-05 截断JSON定向修复

本次仅修改 EOF 诊断和 `tests/pdf.test.ts` 的真实invoke回归；R13-03/04/06已通过复核的算法不重复修改。

- `{"pages":` → `解析 preview_json 失败: EOF while parsing a value at line 1 column 9`。
- `{"pages":[],"renderDpi":` → `解析 preview_json 失败: EOF while parsing a value at line 1 column 24`。
- `{"pages":[]` → `解析 preview_json 失败: EOF while parsing an object at line 1 column 11`。
- 用实际token/容器栈区分等待值与容器结束；覆盖键后、逗号后、嵌套数组/对象、未闭合字符串/指数和中文换行字节列。exam同一截断值保留`解析 exam preview_json 失败`前缀。
- 依据只读审阅的[serde_json v1.0.149 de.rs](https://github.com/serde-rs/json/blob/v1.0.149/src/de.rs)：`MapAccess`读冒号后委托字段反序列化；`SeqAccess/MapAccess`逗号后EOF返回Value，完整成员后EOF返回List/Object；数字/标识符未完成返回Value。未编译或执行Rust。

全局作业队列验证（仅运行本次受影响的PDF测试文件）：

```text
[作业 20261104061303-8b0f39] npx vitest run -c vitest.host.config.ts host/plugins/vfs-handlers/tests/pdf.test.ts
Test Files  1 passed (1)
     Tests  12 passed (12)
[作业 20261104061303-8b0f39] 退出码 0
[作业 20261104061303-a752e9] npm run test:host:electron -- host/plugins/vfs-handlers/tests/pdf.test.ts
Test Files  1 passed (1)
     Tests  12 passed (12)
[作业 20261104061303-a752e9] 退出码 0
```

两份`job.mjs result`完整输出均无Errors汇总/Unhandled；有WASI ExperimentalWarning。原生导入`importable: ok`，wiring仍为60 ported、0未接入。

```text
[作业 20261104061303-7f4327] npm run typecheck:host
[作业 20261104061303-7f4327] 退出码 0
[作业 20261104061358-4cf5e6] npm run migration:ledger -- --check --no-write
ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 76.9% B 0.8%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
[作业 20261104061358-4cf5e6] 退出码 0
[作业 20261104061358-2d119c] npm run migration:boundaries:strict
[作业 20261104061358-2d119c] 退出码 1
```

strict全仓仍14违规（13 empty-catch、1 console-log）；本lane零违规零豁免。EOF实现/真实invoke回归已由检查点 `0e6614b14` 保存；请R3以本次后续提交完整树复核R13-05。

## C2 / R3 §5 定向复核证据（基线29bc10a47之后）

生产修复已包含在 `a19f8348e` 及其前置检查点：`index.ts` 的文件 `deleteIndex` 绑定 `files.deleteIndexFull(ctx.vfsIndexMaintenance, indexService.lance, ...)`，不再指向 `indexService.indexing.deleteResourceIndex`。`src/files.ts::deleteIndexFull` 先调用L12 SQLite维护，再按text→multimodal顺序删除；Lance首错返回文件删除边界，warn后仍执行真实L11软删。reset/管理删除使用的也是 `vfsIndexMaintenance`。

`tests/files.test.ts::persists deletion outbox before Lance and soft deletes after %s failure` 三组用例都直接 `host.invoke('vfs_delete_file', { fileId })`：

1. fixture是真实file/resource/unit/segment，Lance行ID为`delete_row`，维度计数预设7、resource状态indexed/retry=4。
2. 只在外部Lance删除边界注入成功/text失败/mm失败；每次Lance调用采样SQLite状态。**invoke返回后**断言所有采样均为units空、outbox含准确的delete_row、计数0、file仍active，避免断言异常被业务warn/continue吞掉。
3. 成功及mm失败路径调用顺序为`text,multimodal`；text失败只调用`text`。失败路径必须出现原warn；三种路径最后均soft-delete文件。
4. spy确认旧full-indexing入口从未调用；resource仍为indexed/retry=4，证明没有额外markPending。

`getStatusSummary` 尚不在本次main的L12公开api中；其发布后改为复用所有者入口，不在本lane新增统计实现。请求R3以本次修复后提交亲跑上述生产invoke回归，再复核R13-03；旧基线§5的未修复结论不作为本次新基线证据。

强化断言已保存于 `fa5e0ea44`。本次验证原始输出摘录（null表示无失败注入）：

```text
✓ host/plugins/vfs-handlers/tests/files.test.ts > vfs/handlers.rs file and blob commands > persists deletion outbox before Lance and soft deletes after null failure
✓ host/plugins/vfs-handlers/tests/files.test.ts > vfs/handlers.rs file and blob commands > persists deletion outbox before Lance and soft deletes after text failure
✓ host/plugins/vfs-handlers/tests/files.test.ts > vfs/handlers.rs file and blob commands > persists deletion outbox before Lance and soft deletes after multimodal failure
Test Files  19 passed (19)
     Tests  171 passed (171)
```

Node完整运行 exit 0（106.30s）；Electron完整运行同为19文件171通过，exit 0（105.67s）；两份输出均没有Errors/Unhandled行。类型检查exit 0，原生导入`importable: ok`，wiring为60 ported/0未接入。本lane strict零违规零豁免；全仓14违规、strict exit 1。ledger本次exit 0：

```text
ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 76.6% B 0.7%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

## R3 / C2 续作修复（最新）

| 审查项 | 本轮处理 | 仍未关闭部分 |
|---|---|---|
| R13-01 | L12 Unit builder、原子reset/SQLite删除、mm批量索引接真；删除本地index-admin参考实现及替身方法；5原测试改ported | L11八方法尚未集成main，3路径测试仍pending；14导图附件接线已有真实测试，请R3复核 |
| R13-02 | 撤销2条不真实的ported；保留CRUD/错误形状补充测试及全部断言 | L11分支36a41507d已有真实vfsWorker候选，待集成及F3维护屏障/主线程日志传递闭合；note搜索等L10，详见BLOCKERS |
| R13-03 | 文件删除使用SQLite/outbox/计数→text→mm；Lance失败warn后软删，text失败按Rust不继续mm；三条失败/成功顺序回归 | 请求复核 |
| R13-04 | 统一ID校验先sanitize_unicode；批量warn跳过；回归验证无下游调用 | 请求复核 |
| R13-05 | Blob/PDF步骤前缀；来源表Option Debug显示；SQL NULL字符串读取错误；两种预览完整结构校验与默认值，保留空hash语义 | 请求复核；JSON语法诊断映射使用当前Node错误位置，尚无Rust动态golden（C级暂缓） |
| R13-06 | 移除本地模型回退/排序，消费L02 llmEmbeddingModels；真实L02插件覆盖assignment读失败、默认回写失败和Z/z排序 | 请求复核 |

TESTMAP 当前 **60 ported / 5 pending / 3 approved obsolete**。三个question_sync退役项已按main审批更新，协调者须将 `TESTMAP-report.md` 的新增/回退去向同步至 L13 权威TESTMAP。
三条上传命令仍未注册：F3 staged-upload消费API未公开；F7 raw PDF渲染已具备，但RGB8→JPEG/PNG编码、低质量压缩及L11异步processing adapter接线仍缺；逐项签名/Rust调用点见 `native-needs.md`。L12 Unit builder不再列为上传阻塞。

验证：`typecheck:host`通过；Node/Electron均19文件171测试通过；`importable: ok`；`合计 ported 60，其中所测模块未从 index.ts 接入 0（0.0%）`。本lane strict零违规零豁免。全仓strict仍有14违规（13 empty-catch、1 console-log）。

```text
ledger: commands 1058 (A 91.5% B 7.2% C 0%), tests 8036 (A 76.3% B 0.4%); problems: commands 0, tests 21, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

## Linux 续作更新（优先于下方历史结果）

- main 已合并；L11 已发布 `vfsRepo`，新增的 `mindmaps` / `attachments` 仓储现已绑定到本插件的 11 个导图命令和 3 个附件读取/删除命令。下方这 14 个旧服务符号阻塞已解除；不再注入 `vfsMindmaps` / `vfsAttachments`。
- Node 与 Electron 各 **19 文件 / 161 passed**；无跳过。类型检查通过。新增真实仓储集成测试在 `tests/repository-wiring.test.ts` 和 `tests/question-sync.test.ts`。原适配器测试全部保留，替身移至公开仓储方法边界。
- 原生入口检查：`importable: ok`；wiring：`合计 ported 57，其中所测模块未从 index.ts 接入 0（0.0%）`。
- strict：本 lane 0 违规、0 豁免；全仓 20 违规（18 empty-catch / 2 console-log），退出1。
- ledger：`ledger: commands 1058 (A 88.8% B 1.8% C 0%), tests 8036 (A 70.3% B 0.4%); problems: commands 0, tests 250, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）`。
- 保留并验证 Rust 原有缺陷：mindmap 快照 hash 去重后可能别名当前资源，只有一个导图引用时的原地更新/恢复会同步改变历史版本/restore_backup 内容。证据 `mindmap_repo.rs:628-690,1557-1564,1975-2004`；详见 SPEC Q6。
- main `8176f4199` 已发布 L10 `notes` 并解除 notes/vfsRepo 循环依赖；测试旧名桥接已由协调者删除，此项阻塞解除。
- 上传阻塞更新：L11 已提供 `upload*WithFolderConn/maxUploadSizeBytes/uploadMediaStreamFinalized`，旧“上传仓储完全缺失”说法作废；但 `AttachmentRepo` 默认未安装 `AttachmentProcessingAdapter`，仍需 L18/F7 的 PDF/文档处理接线，F3 staged-upload 的公开服务契约及 L12 Unit builder。不能将仅普通文本上传成功视为三条上传命令完成。
- question_sync 续作：生效的内容哈希测试已通过 L11 真实 update/submit 路径移植；`test_conflict_strategy_conversion`、`test_merge_versions`、`test_apply_keep_local_keeps_pending_push_and_recomputes_hash` 申请 `obsolete:dead-in-rust`，批准前 pending。证据为原文件头退役声明、`:2009-2010` 禁止恢复命令声明及 `lib.rs:3071-3074` 注销说明；全仓调用仅留在退役模块/测试。TESTMAP 现在 57 ported / 11 pending（含这3项申请），merged/已批准 obsolete 均0。
- 最新平台接口需求见 `native-needs.md`。`api.ts` 本轮未改变对外 hook 契约，仍为 `vfsHooks` 的注册/删除前捕获与删除后 continuation；没有新增 npm 依赖。
- 使用同一 ledger 生成器在内存读取详细计算（未写 migration/）：L13 总 lane 为命令 A 191/214（89.3%）、B0；测试 A128/381（33.6%）、B0。筛选本 lane 的160个非DSTU命令为 A157/160（98.1%）、B0；未达A为 `vfs_upload_attachment`、`vfs_upload_file`、`vfs_download_paper`。无 dstu-vfs 测试映射错误；本地57个映射仍须协调者同步到权威 TESTMAP。账本静态A不代表下表依赖缺口已解决。

### 仍有效的依赖缺口

- L17 `vfsHooks.registerNoteDeleteHook` 消费注册。
- L11/L12 `vfsMaintenance` 的13个业务方法（下方逐项表）；本地待交接SQL实现只由测试提供者使用。对应3个路径测试与4个unit-reset测试仍 pending。
- L12 `vfsUnitBuilder.syncResourceUnits`（对应单连接测试 pending）、`multimodal.processPendingBatch`，以及 L02/L12 的 page/source embedding pipeline。
- L14 `qbank.contextForRefs` 的规范JSON上下文；L02 `callModel2RawPrompt`、`getEmbeddingModelConfig`、`adoptDefaultMultimodalEmbedding`。
- F7 运行时 `vector` 提供者（当前 `host/platform/vector/` 仅 api.ts）；上传的 F3/L11/L18/F7 接口详见 `native-needs.md`。
- 协调者审批3项退役冲突测试的 obsolete 申请（逐条 id 在 TESTMAP）；不新增已注销命令来证明接线。

### 协调者维护接线指令的合并前置阻塞

已核对 L11 分支 `031f217f2` 的维护实现和 api.ts 八个方法，但当前 main `3eda92215` 尚未包含该提交（`git branch --contains` 仅有 L11 分支）。本 lane 不能越权合并 L11 分支或删除仍在使用的参考实现。待协调者合入 main 后才能接真实维护服务并改 TESTMAP；详见 `BLOCKERS.md`。已移除 harness 的五条过期 cross-plugin-impl 豁免，真实插件直接导入。合并后类型检查及 Node/Electron 的19文件161测试通过，原生导入通过；TESTMAP仍为57 ported / 11 pending。

## 本轮结果

- 已合并 main；改动仅在 `host/plugins/vfs-handlers/`。
- 服务提供名改为 `vfsHooks`，`api.ts` 导出 `vfsHooksService`；生产消费名为 `vfsRepo`、`notes`、`qbank`、`vfsIndex`、`retrieval`、`docs`。
- 必需依赖列在插件 inject；可选/未发布依赖通过 `ctx.inject([...], scoped => ...)` 获取真实服务并随作用域释放，不再使用未声明的 `ctx.get` 快照。
- 平台工具统一：删除本地 trim/字符计数/截断/时间解析副本；使用 F4 util/time，RFC3339 闰秒、Unicode White_Space 和 UTF-8 字节阈值有生产路径测试。无本地 IP/SSRF 判定实现；本轮没有需要自行替代的 npm 库，未修改依赖清单。
- 补回附件读取 error、Lance 部分失败 warn、OCR 解析 warn、原始内容/注入分支诊断及命令开始/完成日志。静默 `.ok()` 回退保持原语义，不用 void catch。仓储日志通过参数接收。
- 原 DTO 字面量序列化测试已改为获取生产函数/命令输出；引用参数测试用文件夹展开和真实 maxItems 截断证明输入确实被消费。
- 按表所有权要求，维护写操作改为 `vfsMaintenance` 接口调用；没有生产 SQL 回退。原实现保留为所有者接收候选，由显式测试提供者调用；不据此宣称已生产接线。
- `typecheck:host` 通过；17 文件 / **157 passed, 0 failed, 0 pending**；Node 原生导入 `importable: ok`。证据：`vitest-results.json`。
- `TESTMAP.md` 是 lane 本地 wiring 输入；L13 权威 TESTMAP 仍在协调者目录。7 个旧拟 ported 项已退回 pending，单连接 unit-builder 测试继续 pending。未删除或跳过测试。

## 原样门禁输出

```text
ledger: commands 1058 (A 88.4% B 1.8% C 0%), tests 8036 (A 66.3% B 0.4%); problems: commands 0, tests 341, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）
```

```text
> deep-student@0.11.0 migration:wiring
> node scripts/electron-migration/wiring.mjs --lane vfs-handlers

合计 ported 56，其中所测模块未从 index.ts 接入 0（0.0%）
```

```text
(allowed) host/plugins/vfs-handlers/tests/harness.ts:12:23 [cross-plugin-impl]
(allowed) host/plugins/vfs-handlers/tests/harness.ts:14:28 [cross-plugin-impl]
(allowed) host/plugins/vfs-handlers/tests/harness.ts:16:25 [cross-plugin-impl]
(allowed) host/plugins/vfs-handlers/tests/harness.ts:18:28 [cross-plugin-impl]
(allowed) host/plugins/vfs-handlers/tests/harness.ts:20:25 [cross-plugin-impl]
```

本 lane strict 违规 0；五条豁免均为测试装配真实提供者。全仓仍 249 个违规（213 console-log、36 empty-catch），所以 strict 全局退出 1。ledger 全局退出 1；不修改其他 lane 的问题或去向以使门禁变绿。

## 能力目录只读检查

执行 `node scripts/plugin-catalog/generate.mjs --check`：

```text
CAPABILITIES.md 已过期：运行 node scripts/plugin-catalog/generate.mjs
```

用同一生成器在内存中计算、未写 docs/plugins，相关问题为：

```text
服务 `notes` 被 dstu.memory, dstu.vfs-handlers 使用，但没有提供方
服务 `notes` 已提供，但没有任何插件在运行时消费它（其他插件可能只在测试替身里用了它的接口，生产路径未接线）
服务 `vfsHooks` 已提供，但没有任何插件在运行时消费它（其他插件可能只在测试替身里用了它的接口，生产路径未接线）
服务 `vfsRepo` 被 dstu.memory, dstu.vfs-handlers 使用，但没有提供方
```

证据：`host/plugins/notes/api.ts:95` 仍声明 `notes`，`host/plugins/vfs-repos/api.ts:1098` 仍声明 `vfs.repo.core@1`。
测试的 `pending-provider-names.ts` 显式转发这些**真实旧提供者**；生产没有该桥接，必须由 L10/L11 完成新名发布。
`vfsHooks` 的 L17 消费方仍需注册 NoteDeleteHook；不能把测试注册当成真实消费方。

## TESTMAP 八项 pending（逐条证据）

下列路径前缀均为 `crates/dstu-vfs/src/vfs/`，模块为 `tests`。

| 测试 | 阻塞证据 |
|---|---|
| `handlers.rs::test_source_id_prefix_parsing` | 生产路径计算转交表所有者；`vfsMaintenance.getResourcePath` 未提供，候选算法仅在测试 provider 中调用 |
| `handlers.rs::test_path_length_constraint` | `vfsMaintenance.getResourcePath/updatePathCache` 未提供；不能以本 lane 直接更新 folder_items 代替 |
| `handlers.rs::test_path_format` | `vfsMaintenance.getResourcePath` 未提供；保留测试但不计生产接线 |
| `index_service.rs::reset_unit_index_text_mode_updates_unit_and_resource_atomically` | `vfsMaintenance.resetUnitIndex` 未提供；L11 `IndexUnitRepository` (`api.ts:812`) 仅有分立状态修改，无资源+Unit 原子操作 |
| `index_service.rs::reset_unit_index_mm_mode_updates_unit_and_resource_atomically` | 同一缺失符号；mm Unit 与资源调度状态必须同事务 |
| `index_service.rs::reset_unit_index_both_mode_updates_all_four_states` | 同一缺失符号；四状态原子更新不能由命令方拼接 |
| `index_service.rs::reset_unit_index_unknown_mode_writes_nothing` | 同一缺失符号；所有者事务及模式验证尚未实际接入 |
| `index_service.rs::sync_resource_units_uses_single_pool_connection` | L12 未发布 `vfsUnitBuilder.syncResourceUnits`，测试替身不证明唯一池连接可用时仍成功 |

## 待提供业务符号（逐项，不计完整迁移）

所有最小接口均在本 lane `src/`；缺失时明确报错。提供方缺失的证据是其当前 api.ts/interface 清单及能力目录，不是“做了很多”或本 lane 算法未写。

| 所有者 | 缺失符号 | 影响 |
|---|---|---|
| L11 | `vfsMaintenance.createTodoSubtasks` | `todo_ai_breakdown` 的 savepoint 写入；调用方仍在成功后发 todo 事件 |
| L11 | `vfsMaintenance.resetDisabledToPending` | `vfs_reset_disabled_to_pending` |
| L11/L12 | `vfsMaintenance.resetIndexedWithoutEmbeddings` | `vfs_reset_indexed_without_embeddings` |
| L11/L12 | `vfsMaintenance.resetAllIndexStateRows` | `vfs_reset_all_index_state`；先确认接口可用，再清 Lance |
| L11/L12 | `vfsMaintenance.resetUnitIndex` | `vfs_reindex_unit` 与上表四个事务测试 |
| L11/L12 | `vfsMaintenance.deleteResourceIndex` | `vfs_delete_resource_index` 的 SQL/orphan-queue 阶段 |
| L11/L12 | `vfsMaintenance.clearMediaCache` | `vfs_clear_media_cache`，含 blob 生命周期和 readiness |
| L11 | `vfsMaintenance.clearResourceOcr` | `vfs_clear_resource_ocr` |
| L11 | `vfsMaintenance.getResourcePath` | `vfs_get_resource_path` 缓存写入 |
| L11 | `vfsMaintenance.updatePathCache` | `vfs_update_path_cache` 原子子树更新 |
| memory_config 表所有者（协调者分配） | `vfsMaintenance.setAttachmentRootFolderId` | `vfs_set_attachment_root_folder` |
| 同上 | `vfsMaintenance.createAttachmentRootFolder` | `vfs_create_attachment_root_folder` |
| 同上 | `vfsMaintenance.getOrCreateAttachmentRootFolder` | `vfs_get_or_create_attachment_root_folder` |
| L11 | `vfsMindmaps.createMindmapInFolder` | `vfs_create_mindmap` |
| L11 | `vfsMindmaps.getMindmap` | `vfs_get_mindmap` |
| L11 | `vfsMindmaps.getMindmapContent` | `vfs_get_mindmap_content` |
| L11 | `vfsMindmaps.getVersionsPaged` | `vfs_get_mindmap_versions` |
| L11 | `vfsMindmaps.restoreVersion` | `vfs_restore_mindmap_version` |
| L11 | `vfsMindmaps.getVersionContent` | `vfs_get_mindmap_version_content` |
| L11 | `vfsMindmaps.getVersion` | `vfs_get_mindmap_version` |
| L11 | `vfsMindmaps.updateMindmap` | `vfs_update_mindmap` |
| L11 | `vfsMindmaps.deleteMindmap` | `vfs_delete_mindmap` |
| L11 | `vfsMindmaps.listMindmaps` | `vfs_list_mindmaps` |
| L11 | `vfsMindmaps.setFavorite` | `vfs_set_mindmap_favorite` |
| L11 | `vfsAttachments.getById` | `vfs_get_attachment` |
| L11 | `vfsAttachments.resolveFileId/getContent/getContentBounded` | `vfs_get_attachment_content` 的文件/资源路径；img_ 自有命令查询仍已实现 |
| L11 | `vfsAttachments.deleteAttachment` | `vfs_delete_attachment` |
| L12 | `vfsUnitBuilder.syncResourceUnits` | `vfs_sync_resource_units` |
| L12 | `vfsIndex.multimodal.processPendingBatch` | `vfs_unified_batch_index` 的 mm/both 阶段 |
| L14/L16 | `qbank.contextForRefs` | exam 规范 JSON 引用上下文；`qbank/api.ts` 没有该方法，不能用 canonicalText 冒充 |
| L02 | `llm.callModel2RawPrompt` | todo AI 拆解；`llm/api.ts:35-59` 未发布 |
| L02 | `llm.getEmbeddingModelConfig/adoptDefaultMultimodalEmbedding` | 仍需将历史本地回退链交给 L02；当前 api.ts 未发布这两方法 |
| L02/L12 | 多模态 page/source embedding pipeline | `multimodal-service.ts:166-179` 明确抛出缺流水线错误，两个 multimodal index 命令不能称为端到端完成 |
| F7 | 运行时 `vector` provider | `host/platform/vector/` 只有 api.ts，缺提供者；向量写命令在 claim 前拒绝 |

L11 证据：`VfsReposService` (`host/plugins/vfs-repos/api.ts:1037-1059`) 无 mindmaps/attachments/maintenance 字段；`FileRepository:963-994` 无附件的 bounded 内容和上传服务；L12 `VfsIndexingApi` 无同步 Unit builder 与上述原子维护方法。

## 尚未注册的三个上传命令

1. `vfs_upload_attachment`：L11 未提供 `uploadWithFolder/uploadBytesWithFolder/uploadMediaStreamWithFolder/maxUploadSizeBytes`；F2 staged-upload take/readBounded/disposal 仍缺发布接口。Rust `handlers.rs:1377-1438` 明确要求暂存优先和媒体流式上传，不能改为 base64-only。
2. `vfs_upload_file`：缺 L11/L18 `renderPdfPreview` 的事务/blob saga 接口。Rust `handlers.rs:2135-2136,2302` 调用该能力；L18 `DocsService` 仅有文档文本提取，没有预览写入/补偿服务。
3. `vfs_download_paper`：同一 PDF preview/blob saga 接口缺失；Rust `handlers.rs:7394,7434,7501-7527` 要求失败补偿和并发去重回退，不能忽略。

跨表实现接收不在本 lane 写入授权范围。已尝试询问协调方式，非交互运行不支持提问，故采用“协调者安排表所有者接收”方案；没有擅自修改 L11/L12/L17 目录或给全局 TESTMAP 改状态。

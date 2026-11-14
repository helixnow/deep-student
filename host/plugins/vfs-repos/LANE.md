# L11-vfs-repos：VFS 仓储

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L11-vfs-repos（VFS 仓储） |
| 目录 | `host/plugins/vfs-repos/` |
| Rust 范围（lanes.md） | vfs 的 repos（非笔记部分） |
| 主要提供 | `vfs.repo.*@1`（H16 里程碑） |
| 主要消费 | F3 |
| 特别注意 | vfs.db 多写入方；id_alias 与 path_cache 语义 |
| 规模（本目录） | 42031 行 · 23 个文件 · 0 个命令（前端调用 0） · 158 个测试 |
| 规模（整条 lane，inventory） | 42031 行 · 23 个文件 · 0 个命令（前端 0） · 158 个测试 |
| 契约 | [`contracts/ipc/L11-vfs-repos.json`](../../../contracts/ipc/L11-vfs-repos.json)（F5 尚未生成，生成后 `npm run migration:scaffold -- --refresh` 更新本表） |
| 服务草稿 | [`contracts/services/DRAFT-L11-vfs-repos.md`](../../../contracts/services/DRAFT-L11-vfs-repos.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-vfs/src/vfs/repos/attachment_repo.rs` | 3641 | 21 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/blob_repo.rs` | 1399 | 10 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/embedding_dim_repo.rs` | 2017 | 9 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/embedding_repo.rs` | 1329 | 6 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/essay_repo.rs` | 1598 | 1 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/exam_repo.rs` | 2400 | 3 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/file_repo.rs` | 2096 | 6 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/folder_repo.rs` | 3649 | 13 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/id_alias.rs` | 65 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/index_segment_repo.rs` | 1014 | 4 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/index_unit_repo.rs` | 1420 | 6 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/media_transcript_repo.rs` | 773 | 5 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/mindmap_repo.rs` | 2052 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/mod.rs` | 113 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/path_cache_repo.rs` | 1255 | 7 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/pdf_preview.rs` | 388 | 1 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/pomodoro_repo.rs` | 1443 | 10 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/question_repo.rs` | 4185 | 11 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/resource_repo.rs` | 1243 | 6 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/review_plan_repo.rs` | 1217 | 1 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/textbook_repo.rs` | 2289 | 6 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/todo_repo.rs` | 5057 | 27 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/translation_repo.rs` | 1388 | 5 |  |

### 命令（0）

本目录没有 `#[tauri::command]`；职责是向其他插件提供服务（见服务草稿）。

### 发出的事件（0）

无（静态未检出 `emit` / `emit_to` / `emit_filter` 调用）。
<!-- END GENERATED:lane -->

## 备注

### WP-216：条件解析回填（2026-11-05）

保留 WP-215 `6236c57e8`，开工正常 merge main `302226342ad4e28b995b33bde9e3b372b2f4d061`。
经 `git show main` 核实 F3 `SqlExecutor.run(...).changes` 与 L11 真实 QuestionRepository 已发布，
本包无外部接口等待。新增 `fillExplanationIfEmpty(conn,id,explanation): number`，
SQL/所有权/错误与消费者职责的分支表在 SPEC「WP-216」；现有 api barrel 与 provider 直接公开同一实例。
真实 Host/SQLite 新增7例，先红 job `20261105225628-6c4648`（7 failed、exit1，方法缺失），
实现只增7行原 SQL；保留 schema 时间戳触发器并核完整行、资源索引、history、外层事务及原错误。
实现后 job `20261105225709-54e1bc` passed7/failed0/skipped0/Errors0/exit0。
Electron 同时运行本包7例与旧 owner/typed 95例，job `20261105225709-088ee6`
passed102/failed0/skipped0/Errors0/exit0；保持原 Node/Electron 时限。
基线旧 owner/typed 完整95例 job `20261105225457-6958d8` passed95/failed0/skipped0/Errors0/exit0。
TESTMAP 原158条去向不变，pending **0 → 0**、新增映射资格 **0**；此处只交付供方原语，
L14 消费顺序由 WP-217 另验。最终 tip/base/jobs/raw 见 WP-216 正式交付报告。

（本 lane 自行记录。）

### 历史状态与下一步（2026-11-04，旧会话记录；以文末 v2 盘点为准）

已完成：

- 23 个 Rust 仓储文件全部迁移；`TESTMAP.md` 158 行全部 `ported`，`pending` 0；本 lane 0 条 IPC 命令。
- Q8 题目表唯一写者接缝、L12 PDF/多模态窄写入口、`vfsMaintenance` 8 方法、
  `clearMediaCache(params, beforeVectorClear)` 的 OCR 后/vector SQL 前文件阶段接缝均已发布。
- `api.ts` 已按职责拆分为 `types/*`（barrel 16 行，各文件 <800 行）。
- R11-06：`tableHasColumn` 探测失败按 false，业务 UPDATE 失败仍传播；已获 R3 定向复核通过。
- R11-01 调用面：`index.ts` 只调用 F4 正式入口 `paths.dataSpaceDeviceId()`，无 legacy 回退。
- R11-05：`src/worker-entry.ts` 回传仓储日志，`src/worker-service.ts` 提供
  `pauseAndDrain`/`resume`；`index.ts` 按 F3 已发布签名注册维护参与者。
- `918b252fd` 之前的 `deviceId()` 回退已删除（`9d16e6544`/`af77b9365`）。

剩余（按处理顺序）：

1. **R13-01.path-file（必须修复）**：`repository/maintenance.ts` 的 `resourceTitle`
   对 `file_` 前缀额外查 `files.file_name`；Rust `handlers.rs:1252-1303` 只对 `tb`
   查文件名，`file_` 落默认分支返回 `source_id`。改回 Rust 行为并用本 lane 测试固定；
   L13b `tests/paths.test.ts:71` 当前锁定旧偏差，需通知其同步修改。
2. **ACCEPTANCE 建议：恢复 Rust info/debug 日志**（`pomodoro_repo.rs:212,301`、
   `resource_repo.rs:128,164,177,191` 等），不改变业务行为。
3. **SPEC 陈旧自述**：`SPEC.md:32`“其余仓储仍未迁移”、`:60`“保持 pending”等与
   TESTMAP 0 pending 矛盾，改为当前事实。
4. **R11-04**：在本机用全局作业队列跑一次本 lane 全套，取得无 `onTaskUpdate`
   errors 的原始退出码。
5. **R11-01 / R11-05 真实组合门禁**：main 的 `paths`/`storage` 仍无 F4
   `dataSpaceDeviceId()` 与 F3 `registerMaintenanceParticipant`；只有对应分支合入
   main 后才能签收，当前保持“调用面/接线已验证、真实组合待集成”。

验证统一经 `job.mjs submit/result`，只提交与变更相关的最小集，并保留 job ID/退出码。

## v2 接手盘点（2026-11-04，GPT-6 Astra）

基线 `cc45114ac`，已执行 `git merge --no-edit main`（main `2ee9a9cbe`，Already up to date）。
本目录无 ACCEPTANCE.md，已只读 `ds-mig/R3-review-vfs:host/plugins/vfs-repos/ACCEPTANCE.md`；
验收文件由 R3 所有。旧文档“全部迁移”只代表原台账状态，不能代表 v2 八类规则已逐分支通过。
TESTMAP 原158行 ported、pending 0；本 lane 无 IPC 命令，审查对象为三个公开服务及其仓储。

### 八类初查（文件均相对本目录；未充分核实的项不标通过）

| 命令/模块 | 问题类型/初查结果 | 证据与下一步 |
|---|---|---|
| 全仓储 `vfsRepo` | §1.1 可达，§1.5 仍需逐断言核实 | `index.ts:53-127,171` 提供所有仓储；原158测试名不构成语义验收 |
| idAlias/pathCache | §1.6/1.7 事务、循环、字节长度已有回归；余分支待逐条复核 | `repository/id-alias.ts`、`repository/path-cache.ts`；`tests/path-cache.test.ts` |
| questions | §1.3 JSON 值强断言待清理，§1.5 真实竞争已由R3签分支 | `repository/question-row.ts:14-36`；`tests/questions.test.ts:127` |
| todos | §1.3 repeat 有显式校验；§1.7 本地日界/跨DST仍需核实 | `repository/todos-helpers.ts:153-185`；`repository/todos.ts:797,847,873` |
| folders | §1.2 note 级联已走owner；§1.3 tags/历史时间待复核 | `index.ts:78-82`；`repository/folders.ts` |
| blobs | §1.7 journal/Drop已有生产测试；同步文件IO/跨worker锁仍需逐路径核实 | `tests/blobs.test.ts`；`repository/blobs.ts` |
| files/textbooks | §1.3 PDF解码缺u32上界；bigint→number违反D3的可达列待追踪 | `repository/files.ts:174-218`；`repository/textbooks.ts:67-75` |
| resources | §1.1 L16只读API已发布；§1.4 创建日志已补 | `repository/resources.ts:164-226`；`tests/resources.test.ts:52-67` |
| attachments/PDF | **V2-PDF-JSON**：§1.3 仅验证pages数组，会对Rust拒绝的预览递减blob引用 | `repository/attachment-utils.ts:344-353` → `repository/attachments.ts:549-558`；Rust `types.rs:2851-2898`、`attachment_repo.rs:2485-2509` |
| PDF preview | **V2-PDF-TEXT**：§1.4/1.6 JS `\\s` 与Rust空白不同，日志length不是UTF-8字节 | `repository/pdf-preview.ts:74-95`；Rust `pdf_preview.rs:154-165` |
| embeddingDims/dimensions/indexStates/indexingConfig | §1.3/1.6 数值宽度、配置解析待逐分支核实 | `repository/embedding-dims.ts`、`repository/embedding-repo.ts` |
| embeddingUnits/embeddingSegments | §1.3/1.7 generation精度需审；同步失效已有测试 | `repository/index-units.ts:67-75`；`tests/index-units.test.ts`、`tests/index-segments.test.ts` |
| mediaTranscripts | §1.3/1.7 i64时间与plan_version比较待审 | `repository/media-transcripts.ts`；`tests/media-transcripts.test.ts` |
| pomodoros | R11-06探测容错已分支复核；§1.4 info已补；日界仍需审 | `repository/pomodoros.ts:322,366`；`tests/sync-pomodoro-counts.test.ts` |
| translations | R11-01调用已改正式F4；§1.3泛JSON断言、i64列待审 | `index.ts:160-161`；`repository/translations.ts:71-99` |
| reviewPlans | §1.3/1.7 时间、数值转换待逐列核实 | `repository/review-plans.ts:44-100` |
| essays/mindmaps | §1.3泛JSON及数值文本表示待审，已有COW/版本测试不等于全域等价 | `repository/essays.ts:43`；`repository/mindmaps.ts:76,169` |
| exams | **V2-OWNER-QBANK**：候选ca2ea6e34已消费正式同连接API并删七写副本，待main复核 | `ctx.get('qbank').examCascade`；实现检查点086580775 |
| maintenance/vfsMaintenance | §1.6 pre-vector、恢复旧schema/回滚已交付，需复核签收 | `repository/maintenance.ts:344`；`src/maintenance-service.ts:75`；`tests/maintenance.test.ts` |
| vfsWorker | 原R11-05已获真实main独立签收；R13-02消费者线程覆盖仍独立 | R3 f9e10ed4c / ACCEPTANCE§11，main fd925aa05，job20261104163651-79f860 exit0 |
| 全服务 | 原R11六编号未决0（03撤销，其余已签）；不是整lane v2验收通过 | R12-09、R13-02、SW与后续接口消费仍分别跟踪 |

### 原 R11 签收记录与后续自查

- R11-01/06：R3已正式签收，不再列为未决；保留原F4身份与pragma错误语义。
- R11-04：R3 ACCEPTANCE§10已以正常main完整运行证据关闭；不再要求重复旧全套来关闭同一项。
- R11-05：R3 `f9e10ed4c` / ACCEPTANCE§11在固定main `fd925aa05` 独立签收，
  `20261104163651-79f860` strict断言exit0（真实F3+notes/repos、在途todo/短search排空、拒绝新借用、
  release后thread1→3与真实WARN）。`513aac879`非main祖先仅是直接注册清理的交付状态，
  不另造功能阻塞。原R11未决0；不重跑同项测试，也不凭此关闭跨域finding。
- SPEC pending旧描述已部分纠正，但历史F4/PDF段与新实现仍矛盾，按当前源码统一。
- pomodoro/resource建议日志已补；补生产入口级别/位置断言。附件purge日志仍需补齐。
- R13-01.path-file已在 `547cad37c` 前实现并有测试，不重做；L16 getLiveResource、L21恢复owner、PDF异步接缝已在 `76e44dd07`，从这些代码继续审读。

### 真正跨lane阻塞与自有待办

- F3原R11-05真实组合缺口已由上述main独立签收解除。F7/Office能力按当前正式API与实际支持分支逐项核实，不沿用旧“全部缺失”结论。
- L14四个同连接面已正式main，候选ca2ea6e34已消费；剩余SW journal等待L10已发布候选正式合入，不重发旧qbank请求。
- 其余上表“待审”是本lane自有工作，不是依赖阻塞。先修已证实数据边界与日志，再依次核实数值、所有权、运行时；不得因TESTMAP为0 pending宣布v2完成。
- 基线类型检查：`20261104094500-4e038e` exit 0。ledger：`20261104100803-eb876a` exit 0，problems全0；生成账本两文件为既存改动，未纳入提交。

## v2排雷清单（X6报告 0119143715c0bab2d8f698b7c1d58651358e85be，源码基线 2ee9a9cbe）

编号与顺序按原报告固定，不重排复用。状态：未修 / 候选已修待复核（写SHA与真实入口）/ 误报待复核（写证据）。
main合入且对应R复验前均不算完成。检测器为report-only，计数不自动定罪。

### SW 新固定基线关联（main 4525e11ac，报告 b8a466a20cd9aaf05121193cdd329e0e2649e137）

11 个明确阻断写点仍按原 `011914371…` 的条目关联。原报告中这些是 duplicate-repository/info，
不是当时的阻断项；同一表生命周期下新增操作关联旧条目，不按新报告数组 153–163 重新编号。

| 原条目 | 新快照 file:line / table / operation | Rust 依据 | 当前候选状态 |
|---|---|---|---|
| X6-SW-0204（旧info） | blobs.ts:229 / __file_deletion_journal / UPDATE（重建取消） | blob_repo.rs:372 | 仍在；已向L10请求纯journal owner面 |
| X6-SW-0204（同生命周期） | blobs.ts:343 / __file_deletion_journal / INSERT（prepared） | blob_repo.rs:656 | 仍在；同上 |
| X6-SW-0204（同生命周期） | blobs.ts:388 / __file_deletion_journal / UPDATE（内容冲突取消） | blob_repo.rs:822 | 仍在；同上 |
| X6-SW-0204（同生命周期） | blobs.ts:404 / __file_deletion_journal / UPDATE（ready） | blob_repo.rs:861 | 仍在；同上 |
| X6-SW-0297（旧info） | exams.ts:422 / qbank_sources / INSERT | exam_repo.rs:2139 | V2-OWNER-QBANK候选实现086580775已删除本地写，生产exams经ctx.get('qbank').examCascade委托；待main/复验 |
| X6-SW-0295（旧info） | exams.ts:425 / qbank_materials / INSERT | exam_repo.rs:2140 | 同上；正式copyAuthoringEntitiesWithConn |
| X6-SW-0299（旧info） | exams.ts:428 / qbank_groups / INSERT | exam_repo.rs:2141 | 同上；正式copyAuthoringEntitiesWithConn |
| X6-SW-0295（同生命周期） | exams.ts:438 / qbank_materials / UPDATE | exam_repo.rs:2150-2157 source_refs重映射 | 同上；ID映射返回后L11仅改自己的questions引用 |
| X6-SW-0301（旧info） | exams.ts:452 / qbank_group_materials / INSERT | exam_repo.rs:2161-2175 | 同上；正式copyAuthoringEntitiesWithConn |
| X6-SW-0308（旧info） | exams.ts:769 / qbank_practice_attempts / UPDATE（软删） | exam_repo.rs:909-911 | 同上；正式softDeleteForExamWithConn |
| X6-SW-0308（同生命周期） | exams.ts:889 / qbank_practice_attempts / UPDATE（恢复） | exam_repo.rs:1252-1254 | 同上；正式restoreForExamWithConn |

表归属按 C2 `X6-OWN-C2-20261104`，不将“Rust在本文件使用”当作跨owner写豁免。
vfs journal 的 target_kind 是 blob/asset，不与 chat_v2 的 workspace 同名表混用；
L10 目前未公开 blob journal 的四个同连接写面，F3 实现不是 notes 所有权授权。
具体请求在 BLOCKERS.md；不改 parked consumer，不重复派已经发布的 qbank 接口。

V2-OWNER-QBANK证据：`tests/exams.test.ts` 安装真实vfs-repos+qbank，原三例断言不变，新增四例验证
复制/重映射、owner触发器失败的资源/blob/题目回滚、批次删除/恢复以及snapshot保留blob；
`20261104162348-930820` 7passed/exit0，无Errors。`20261104162348-843242` typecheck exit2仅L12
generation联合类型旧差异，无L11错误；L14已收到需要真实owner的测试组合接线通知。

### UD（unchecked decode，16）

共同背景：均为 `serde_json::Value` 或typed结构的JSON读取。JS `JSON.parse` 对>2^53整数取近似、重复键后值覆盖；
完整无损/重复键原语由F4（R12-08）提供，L11不另写通用parser。逐行先核Rust目标类型与数据流再决定是否需typed校验。

| ID | 位置（基线） | 入口 | 状态 |
|---|---|---|---|
| X6-UD-0091 | repository/attachments.ts:311 | AttachmentRepo.getProcessingStatus | 未修，待核Rust progress结构 |
| X6-UD-0092 | repository/essays.ts:43 | parseJson | 未修 |
| X6-UD-0093 | repository/exams.ts:56 | parseJsonValue | 未修 |
| X6-UD-0094 | repository/exams.ts:386 | ExamRepo.copyQuestions | 未修 |
| X6-UD-0095 | repository/exams.ts:435 | ExamRepo.copyAuthoringEntities | 候选086580775删除本地解析/SQL，改调L14正式examCascade；owner/shared JSON差异不以删副本冒充全链解码已验 |
| X6-UD-0096 | repository/exams.ts:467 | ExamRepo.collectExamBlobHashes（preview） | 未修；PdfPreviewJson可复用 repository/pdf-preview-json.ts（V2-PDF-JSON） |
| X6-UD-0097 | repository/exams.ts:488 | ExamRepo.collectExamBlobHashes（images_json） | 未修 |
| X6-UD-0098 | repository/exams.ts:504 | ExamRepo.collectExamBlobHashes（images_json） | 未修 |
| X6-UD-0099 | repository/exams.ts:517 | ExamRepo.collectExamBlobHashes（descriptor_json） | 未修 |
| X6-UD-0100 | repository/exams.ts:533 | ExamRepo.refreshCanonicalPreview | 未修；与qbank management.ts:372重复实现，待与L14确认合并 |
| X6-UD-0101 | repository/exams.ts:554 | ExamRepo.refreshCanonicalPreview（descriptor） | 同上 |
| X6-UD-0102 | repository/mindmaps.ts:76 | parseSettings | 未修 |
| X6-UD-0103 | repository/mindmaps.ts:169 | MindmapRepo.normalizeContent | 未修；L13要求错误文案对齐serde（`expected ident at line 1 column 2`），待F4 Rust JSON decoder |
| X6-UD-0104 | repository/question-row.ts:16 | parseJson | 未修 |
| X6-UD-0105 | repository/textbooks.ts:434 | TextbookRepo.replaceHighlightsIfVersion | 未修 |
| X6-UD-0106 | repository/translations.ts:90 | parseMetadata | 未修 |

### AP（断言计数候选，5；逐语义对照，不补重复expect）

| ID | 位置 | Rust | 状态 |
|---|---|---|---|
| X6-AP-0456 | tests/folders.test.ts:106 test_folder_depth_limit | folder_repo.rs:3229（2 vs 1） | 已审读同义：未抛错时 message='' 导致包含断言失败；抛错还必须包含 FOLDER_DEPTH_EXCEEDED（详下文），待独立复核 |
| X6-AP-0457 | tests/path-cache.test.ts:72 test_stats | path_cache_repo.rs:1218（3 vs 1） | 已审读同义：一个完整对象 toEqual 同时核 totalCount=3 / folderCount=1 / resourceCount=2，不补重复 expect |
| X6-AP-0458 | tests/questions.test.ts:157 list_and_single_reads_hydrate_group_materials… | question_repo.rs:3934（10 vs 8） | 已审读同义：materials[0] 的 toMatchObject 合并 id/version/content 三条原断言；其余七条均有对应 |
| X6-AP-0459 | tests/resources.test.ts:78 test_concurrent_create_same_hash | resource_repo.rs:1173（6 vs 5） | 已审读同义：每项 outcome.ok=false 则抛错，等价 Rust result.is_ok；其他五类断言均在，不重复补 expect |
| X6-AP-0460 | tests/todos.test.ts:184 test_step_due_date_weekly_by_weekday_interval | todo_repo.rs:4573（4 vs 2） | 未核 |

### LP（日志计数候选，7；以分支级warn/error/字段/时序为准）

| ID | 位置 | 候选 | 状态（初核） |
|---|---|---|---|
| X6-LP-0291 | repository/blobs.ts | blob_repo.rs error! 6 > 3 | 候选修复 6df492b73；temp create/write/flush/rename 分开错误分支，红20261104134129-571ee7 exit1，绿20261104132920-925a84 38 passed；待main/独立复核 |
| X6-LP-0292 | repository/files.ts | file_repo.rs error! 8 > 7 | 未核（当前files.ts有8处logError，需逐分支对照） |
| X6-LP-0293 | api.ts（path_cache_repo.rs） | warn! 2 > 0 | 初核疑误报：warn在repository/path-cache.ts（5处logWarn），检测器归因到api.ts；待逐条对照 |
| X6-LP-0294 | repository/pdf-preview.ts | warn! 6 > 0 | 初核疑误报：pdf-preview.ts有7处logWarn；待逐条对照 |
| X6-LP-0295 | repository/textbooks.ts | error! 6 > 0 | 候选修复 bf99c3fbb（代码94bc6bdac），实际六处error!为145/280/405/1049/1210/1229（1819不是error!）；绿20261104130816-d8e7d2 24 passed，待main/独立复核 |
| X6-LP-0296 | repository/todo-queries.ts | todo_repo.rs error! 1 > 0 | 初核疑误报：唯一error!在todos.ts:494已对应（spawn next recurrence）；待核 |
| X6-LP-0297 | 插件合计 | error! 31 > 25 | 随0291/0295修复后复核 |

### X6 新基线关联（不重新编号）

报告 `a07019791e219c91f89fc3960ef5644846486b94` 的 `handoff-8d7b05d14.md`、
源码基线 main `8d7b05d14` 的四条 AP 对应旧稳定 ID 如下。旧报告/源码基线保留于本节标题。

- **X6-AP-0456** → `crates/dstu-vfs/src/vfs/repos/folder_repo.rs::tests::test_folder_depth_limit`。
  Rust :3266 `is_err()` 和 :3268 错误含关键字：TS `tests/folders.test.ts` 捕获异常写 message，
  没抛错则空串不可能含关键字；不是丢失错误断言。创建第11层的生产服务调用不变。
- **X6-AP-0457** → `crates/dstu-vfs/src/vfs/repos/path_cache_repo.rs::tests::test_stats`。
  Rust :1250/1251/1252 的 3/1/2 分别对应 TS :74 完整对象的三个字段；没有漏字段。
- **X6-AP-0458** → `crates/dstu-vfs/src/vfs/repos/question_repo.rs::tests::list_and_single_reads_hydrate_group_materials_without_duplicating_membership`。
  Rust :3968 对应 TS :162 长度2；:3974/3975 对应 :164 group_id/group_label；:3976 对应 :165
  材料长度1；:3977/3978/3979 同时对应 :166 `{id:'m1',version:3,content:'共享文章正文'}`；
  :3984/3989 对应 :168 single材料长度1/group_position=1；:4002 对应 :169 无question_ids列。
- **X6-AP-0459** → `crates/dstu-vfs/src/vfs/repos/resource_repo.rs::tests::test_concurrent_create_same_hash`。
  Rust :1206 对应 TS :111 十个结果；:1208 对应 :112-115 每个outcome失败立即throw，成功取value；
  :1216/1220 对应 :117-120 循环逐个核resourceId/hash；:1228 对应 :121 唯一isNew；
  :1240 对应 :122 SQL记录数1。测试仍为十个独立连接并发，不改生产并发模型。

上述四项仅做逐语义审读，没有为机械计数增加重复expect；
`20261104150152-e588fc` 完整生产服务套件32文件/268测试exit0，无Errors，包含这四例。
不将审读/本地测试代替main后的独立复验。原X6-AP-0460仍保留历史待核，不因新报告少一项而删除。

## 下游所有者接口（2026-11-05）

WP-001（B1/D03）增补 L12 的两条精确 OCR owner 写入与
`maintenance.recoverStuckIndexingWithConn(conn, at)`，Rust 分支与生产测试映射见 SPEC。
基线已合 main `967f43c75`；`generation: number | bigint` 已在 L12/main，旧 TS2322
阻塞更正于 BLOCKERS（基线 typecheck `20261105140040-f3ccd8` exit0）。
`resetRebuildableIndex` 已发布，保持原实现。本包不改 TESTMAP 的158条去向（pending 0）。
新增生产服务测试先红 `20261105140554-4a2e06`（11 failed，方法缺失），实现后
`20261105141203-a48d9e`（11 passed / 0 failed / 0 skipped / Errors 0，exit0）。
原相关三文件基线 `20261105140040-9bdfeb` 为35 passed / exit0。
发现 L12 现有 OCR 调用点缺局部 cache-failure warn/继续分支，已在 BLOCKERS 写明源码证据，
属于后续消费者工作包，不扩大本包修改范围。最终门禁与完整交付记录见 WP-001 报告。

已发布并在 SPEC.md「下游所有者接口登记」一节登记：`attachmentProcessing.renderPdf(..., config?, progress?)`（L18）、`textbooks.updateTextbookOcrPagesJson` / `textbooks.markTextbookRenderError`（L18 textbooks_add）、`files.ensureFileForBlobWithConn`（L14）。L04 需要的 `attachmentProcessing`、`mediaKind`、`attachments.getInlineDataWithConn` 原本已在分支上。

**已知 Rust 缺陷（2026-11-07 起已修复，登记 `RF-W10-ensure-file-for-blob-sha256`，主代理批准）**：`ensure_vfs_file_for_blob`（question_import_service.rs:3758-3812）的 `INSERT OR IGNORE` 不写 sha256，而 `files.sha256 TEXT NOT NULL UNIQUE`（V20260130__init.sql:109）。OR IGNORE 会连 NOT NULL 冲突一起忽略，所以 Rust 的 INSERT 永远不落行，返回的 file id 没有对应的 files 行，每次调用都会生成新 id。此前经协调者裁定按 Rust 原样保留；按 08:01 的 Rust 缺陷政策，现在 sha256 写 blob_hash，同内容被软删除的行会恢复（与 `create_file` 去重语义一致）。`tests/files.test.ts` 改为 RF 测试。

## WP-215：同步题目三列 typed JSON 原文读取

基线正常合入 main `33d1323a9df2205f3c13cacf89f157242ada9b90`；依赖经 `git show main` 核实：
WP-021/178 的真实 `questions.updateContentHash(conn,id)` 与 F4 `JsonReader`/`JsonSyntaxError` 已发布，
`skipIgnoredValue`/`endArray` 可用。沿用四个 owner 公开签名，L14 WP-165 可直接消费。

### 锁源与行为分支（只签同步读三列）

- `question_sync_service.rs:1628-1636,1660-1664`：原文分别读 `Vec<QuestionOption>`、`Vec<String>`、
  `Vec<QuestionImage>`；任一元素/语法/尾部失败丢弃整 Vec。options 为 None，tags/images 为 []，均无日志。
  → `repository/question-sync-json.ts` 的三个窄入口，由 `rowToSyncQuestion` 原列顺序调用。
- `question_repo.rs:248-268`：Option 的 key/content 和 Image 的 id/name/mime/hash 都是必填 String；
  role 是 `#[serde(default, skip_serializing_if="Option::is_none")] Option<String>`。
  → map/seq 都接受；Option seq 恰两项；Image seq 四或五项，role 缺省/null 均省略，空串保留。
- Cargo.lock 锁定 serde/serde_derive 1.0.228、serde_json 1.0.149。
  registry `serde_derive-1.0.228/src/de/struct_.rs:72-95,236-324`：已知键出现第二次即失败（role 首次
  null 也算已见），未知键 `IgnoredAny`；`de.rs:451-551,763-835`：seq 按声明顺序，只有 default
  字段可在短 seq 缺省。→ F4 流式读取，重复键不经过 JSON.parse 丢失；显式 `skipIgnoredValue`。
- registry `serde-1.0.228/src/core/de/impls.rs:688-694,870-927,1135-1176`：String/Option/Vec；
  `serde_json-1.0.149/src/de.rs:1737-1766,1820-1866,1910-1915,2497-2507`：根 Vec 必须数组、
  struct map/seq、收尾及完整文档。未知字段 `ignore_value:1102-1281` 接受超 f64/深嵌套/未配对
  surrogate（`read.rs` 的 ignore_str），但仍拒绝坏转义/数字/结构。→ shared reader，不新造 parser。
- catch 仅把 `JsonSyntaxError` 转 None；reader 运行时故障继续传播。SHA256 分段/顺序、SQL UPDATE、
  NotFound/VFS_STORAGE 映射、调用方事务和 WP-178 structured_data WARN 的原位置沿用现有代码。

### 生产回归与边界

`tests/question-sync-owner-writes.test.ts` 的 WP-215 分组通过真实 Host 安装的 vfsRepo 和迁移后 SQLite，
将原始文本插入 questions，再调用公开 `updateContentHash` 并核返回 hash、落库整行及日志。
表中期望是按上述 Rust 类型审读得出的字面 serde 片段；测试仅用 node:crypto 对这些片段求摘要，
不调用 decoder 求期望、不执行哈希测试副本冒充生产输出。已有事务、错误和 WP-178 用例继续运行。

| Rust 输入/断言来源 | TS 标题/分组 |
|---|---|
| Option map/seq、两项必填、重复 key/content、Vec 任一项失败 → None | `options: %s`（21例） |
| Image map/seq、role default/null/Some、长度/类型/尾部错误 → [] | `images: %s`（23例） |
| Image 四个必填键缺失/null/重复，前面合法元素也丢弃 | `images required/duplicate field %s`（4例，每例3输入） |
| Vec<String> 顺序/重复/Unicode、类型/语法错误整批 → [] | `tags Vec<String>: %s`（11例） |
| 未知键 IgnoredAny：重复未知、深嵌套、超f64/代理项与非法词法 | `unknown fields: %s`（6例） |
| :1673 WARN 在三列静默回退后、UPDATE 失败前 | `typed failures stay silent before structured_data WARN...` |
| .ok() 仅解码失败，无 hash UPDATE 的运行时故障传播 | `non-serde reader exceptions propagate...` |

TESTMAP 去向保持 pending **0 → 0**、ported **158 → 158**、新增/改派 **0**。以上为源码审读＋生产入口
回归证据，不是 Rust 动态差分。公开 `rowToQuestion` 的 structured_data 精度、X6-UD-0104 及其它 JSON
路径仍单列未闭；本包仅处理同步读这三列。无新供方阻塞。

验证原件：基线 typecheck `20261105223502-b217e9` exit0；原测试文件
`20261105223502-51a483` 28 passed / failed0 / skipped0 / Errors0。新用例先红
`20261105223756-a18b66`：19 failed / 48 passed / 28 skipped（`-t WP-215` 筛掉原28例，未新增 skip），
Errors0、exit1。原实现可复现 duplicate/seq/known-surrogate 差异。
首次完整候选 Node `20261105224002-a42ff3` 与 Electron `20261105224002-f17bd8` 均95 passed，
但各有 `Errors 1 error`、exit1：`[vitest-worker]: Timeout calling "onTaskUpdate"`，不记为通过。
新分组的同步 SQLite/Host 微任务链超过 RPC 固定预算；在每例 afterEach 用 `setImmediate` 交还事件循环，
允许 worker 收到确认，保留原测试/RPC时限及全部断言。原件位于 `/home/dsdev/.oc-jobs/done/<job>.log`。
修正 fixture 调度后，同一完整95例：Node `20261105224204-84b9e5`（72.79s）、Electron
`20261105224204-33eef4`（62.60s）均95 passed / failed0 / skipped0 / Errors0、exit0。
typecheck `20261105224002-a2dfae` exit0；strict `20261105224013-5b71ac` 全域0违规；
wiring `20261105224013-ddd8b6`：`合计 ported 158，其中所测模块未从 index.ts 接入 0（0.0%）`。
提交后正常 merge main，再直接执行官方 lane-gate；最终 tip/base 与门禁各 job 原件见 WP-215 交付报告。

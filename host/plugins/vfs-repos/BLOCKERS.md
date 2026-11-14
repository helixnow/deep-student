# L11-vfs-repos 跨 lane 阻塞与交接

## 当前集成接缝（以最新独立签收回执覆盖历史）

- **WP-216 / L14 条件解析回填**：本 lane 已增补
  `QuestionRepository.fillExplanationIfEmpty(conn: SqlExecutor, id: string, explanation: string): number`，
  经既有 `api.ts` 和真实 `ctx.vfsRepo.questions` 公开。只执行 `pipeline.rs:682-686` 的条件 UPDATE，
  返回原 changes；SQLite 错误原样交 L14 在 :688 包 `写入解析失败: …`。
  :677 输入 Rust trim 判空、:689 的 changes 判断、:692-701 history，以及随后 mark/hash 均由 L14
  保持原顺序；不能拿通用 updateQuestion 代替。schema updated_at/FTS/change_log 触发器保留。
  本包无供方接口等待；真实消费者 WP-217 由协调者在供方实际 main 后另派，owner 测试绿不签消费顺序。
  WP-215 四方法签名与 typed 三列读取保持原样，公开 rowToQuestion 精度/X6-UD-0104 仍未闭。

- **WP-100 / D1-L18-M02 media_progress i64（2026-11-06，增补兼容）**：`mediaTranscripts.getProgress/setProgress`
  内部改为 safeIntegers 读取、BigInt 合并与绑定写入，993+1 持久化为 994，饱和到 i64::MAX。
  公开返回 `MediaProgressRow` 仍为 number（D3 线上投影），L18 现有 `media-commands.ts:91,173,195,206,209-218`、
  `pipeline.ts:221` 无需修改即可编译，线上输出与 kernel BigInt→number 投影相同。
  需要进程内精确值的消费者改用增补的 `getProgressExact/setProgressExact(conn, resourceId[, update]):
  MediaProgressRowExact`（i64 字段为 bigint）。L18 `repository/media-library.ts:83`、
  `repository/media-ledger.ts:186` 自行 SELECT media_progress，不经本接口，精度未在本包处理。
  WP-162（R2 VERIFY009 N1）：`media-transcripts.ts` 的 `valueKind` 在 safeIntegers 读取中把任何 number 报为
  `Real`（rusqlite 0.40.1 `row.rs:288-293` 报 `value.data_type()`），1e20/-1e19 这类整数值 REAL 不再误报 `Integer`。
  L18 `watchedMinutes` 整除（N2）不在本包。

- **R12-09 旧类型集成阻塞已解除（WP-001，2026-11-05）**：`git show main:host/plugins/vfs-index/repository/index-units.ts`
  在本包基线 main `967f43c75` 的 :74 已为 `generation: number | bigint`；L11
  `types/indexing.ts:123` 同型。基线 typecheck job `20261105140040-f3ccd8` exit 0，
  原 :338/:348 TS2322 不再存在。不据此宣称 L12 其他 generation 数据流已复验。
- **R13v-03 接口兼容裁定更新**：原必需 `getBreadcrumbs` 使
  `host/plugins/memory/tests/support.ts:246` 的既有实现报 TS2741（`20261104143849-2f8cfc`）。
  按架构师最新指令，公共声明改为可选能力；生产 FolderRepo 保留完整实现，消费者必须显式
  检查，缺失时报错，不复制 SQL 或回退算法。L17 的 fixture 更新候选为 `9803605a6`，
  但不再以消费方更新作为此接口类型兼容的前提；L11 未改 memory 文件。
- **C1 U2/U4 两个写面**已在检查点 `f55aedcee` / `b3a999135`：
  `translations.setMetadataJsonOnlyWithConn` 仅写 metadata_json，0 行抛 Rust 原文；
  `textbooks.setOriginalPathWithConn` 仅写 original_path + updated_at，不新开事务、0 行返回 0。
  `20261104144515-dfd4f5`：2 文件 / 15 测试 exit 0，无 Errors。
- **原R11已全部处置**：R3 `f9e10ed4c` / ACCEPTANCE§11已在固定main `fd925aa05`
  正式签收R11-05，作业 `20261104163651-79f860` strict断言exit0；真实F3+notes/repos组合
  覆盖todo/短search在途排空、拒新借用、release后thread1→3和真实WARN。原R11未决0。
  `513aac879`非main祖先只是注册清理候选状态，不再是原05功能阻塞。下文旧F3阻塞/重复复验要求
  均为已被本次签收覆盖的历史；不将此结论外推至R12-09/R13-02/SW或整lane。

## v2 自查新增：V2-OWNER-QBANK（2026-11-04）

更新：main `677f6727c` 已包含正式 `QbankService.examCascade`（`qbank/api.ts:48-57`），
支持复制/软删/恢复/retainsAsset 同连接方法。候选实现 `086580775` 已删除下面的写入/retainsAsset
副本，生产 `index.ts` 给 ExamRepo 注入懒解析 `ctx.get('qbank').examCascade`，不静态 inject。
旧“接口未发布”不再是当前阻塞，不能用历史 BLOCKERS 继续要求 L14 重发相同接口。

真实组合 `20261104162348-930820`：7 测试 passed、exit 0、无 Errors；原三例断言未改，
新增四例核重映射/跨owner同事务/错误与快照引用保留。直接构造 `new ExamRepo()` 的旧测试宿主
若执行生命周期写操作，须提供真实 QbankExamCascade resolver 或安装真实 qbank 插件；读/创建
仍不依赖 qbank。缺 owner 明确报错、无本地 SQL 回退。L14 已获接线通知，L11 不改其测试文件。

历史证据：`repository/exams.ts:412-457` 原本地复制 Rust `qbank_helpers::copy_authoring_entities`，
写 `qbank_sources/materials/groups/group_materials`；`:766-769,886-889` 级联软删/恢复
也写这些表及 `qbank_practice_attempts`。按D1这些表归L14，目录在repository不构成豁免。
main `8f2a9823b` 的 `host/plugins/qbank/api.ts` 尚未公开以下同连接业务面：

- 复制 authoring entities（返回 source/group/material ID映射，并在同一事务内重映射 source_refs）。
- exam级联软删除/恢复（保留 `deletion_batch`/`deleted_at` 分支及 practice_attempts 条件）。
- qbank资产保留判断 `retainsAsset(conn, id)`（读取语义应由owner统一提供）。

请求L14发布对应Rust `qbank_helpers.rs` / `exam_repo.rs` 步骤的窄 `*WithConn`
方法。L11保留 `questions`/`exam_sheets`/blob写入、事务编排，取得接口后删除本地qbank
SQL副本。此前SPEC称“本地移植、不跨插件导入”不是v2合规结论。最新候选已按上述委托，尚未main独立签收。

历史 `8f2a9823b` 中F3/F7未发布的结论不再代表当前main：F3原05组合已如上签收；
F7按当前正式能力逐项核实。已发布的L16/L21接口不重造。

## X6-SW-0204：vfs blob deletion journal 的 notes owner 接缝

C2 新快照 main `4525e11ac`/报告 `b8a466a20…` 中四个 blobs.ts 写点，对应 Rust
`blob_repo.rs:372/656/822/861`；owner 为 notes。已向 L10 请求四个使用调用方 conn、无事务/文件I/O的业务面：

- 重建 blob 时取消匹配 hash 的 prepared/ready journal（只 target_kind='blob'，固定 last_error）。
- 插入 blob prepared intent 八列（operation_id/target_kind/entity_key/local_path/expected_hash/size/state/prepared_at）。
- 仅按 operation_id 且 state='prepared' 取消内容冲突操作，写入 caller 的时间/last_error。
- 仅按 operation_id 且 state IN('prepared','ready') 前进 ready，清 last_error，返回 changes。

L11 保留 hash/文件隔离删除、blobs 和 __blob_deletion_queue 的写入、savepoint 与 changes 判断；
不会把 blob 算法迁给 notes，也不调用任意 SQL 口。main 的 notes/api.ts 暂无此能力；
F3 file-deletion-queue 的现有实现不能替代 notes 正式owner面。未闭合，不声明SW已清零。

## v2 持久化JSON：共享无损解析器请求（V2-PDF-JSON）

Node source-aware reviver已足够保留PdfPreviewJson中的usize整数词法/宽度，业务结构校验由L11负责。
但 `JSON.parse` 在reviver前已覆盖对象重复键，Rust serde派生结构体遇已知字段重复会失败；
泛 `serde_json::Value` 则允许后值覆盖，不能用统一“所有重复键拒绝”改变后者。
当前平台没有可保留对象成员序列的JSON解码API，package.json也没有lossless-json/jsonc-parser。
请求F4发布共享原语或协调者批准成熟解析库（需保留数字字面量、重复成员位置）；L11仅消费并
按Rust类型决定重复键拒绝，不在仓储另写通用JSON parser。具体生产触点为附件purge以及
文件/教材copy、purge使用的PdfPreviewJson。此子项未完成，不能以当前字段校验称全域serde等价。

本次字段/范围修复验证（只新增回归，不改原断言）：
- 红测 `20261104105344-7bf6ce` exit1：附件缺字段错误递减blob、文件copy的u32溢出错误增加引用。
- 修复后 `20261104110225-ac0725`：4文件/37测试 passed，exit0，无Errors/unhandled errors。
- Electron `20261104110509-cede67`：4测试 passed，exit0，无Errors/unhandled errors。
- typecheck `20261104110225-7dbde1`、importable `20261104110509-87fb21`、wiring `20261104110509-e05d00`、ledger `20261104110509-629096` 均exit0。
- strict `20261104110225-11afcb` exit1：4个既有违规全部在 `host/plugins/vfs/repository/{create,folders,resources,update}.ts`；本lane无违规，仅原pomodoros.ts:420的已批准探测catch。

本 lane 的 Rust 测试去向已闭合：`TESTMAP.md` 158 行全部 `ported`，`pending` 0；命令 0；
`migration:ledger` 记录的测试为 158 / 100% A。以下条目不是本 lane 可独立完成的 Rust 测试，
而是需要其他 lane 发布接口后才能接入的生产路径。

## R11-01 依赖变更（需其他测试宿主适配）

`dstu.vfs-repos` 现在 `inject: ['storage', 'paths']`：`apply` 启动时从 F4 解析一次
持久设备身份，再注入 `TranslationRepo`。生产 kernel 由 F4 平台插件提供 `paths`；
任何直接安装本插件、但没有安装 F4 的测试宿主（例如
`host/plugins/vfs-handlers/tests/harness.ts`、L15/L03 中安装本插件的集成测试）必须
额外 `provide` 一个 `paths` 服务（真实 F4 插件或等价设备身份测试替身），否则
kernel 会以 `required services not available: "paths"` 拒绝启动本插件。
不得回退 `process.env.DEVICE_ID`。

**R11-01 已闭合（2026-11-04，main 已含 F4 身份）**：main `081b3426d`（含
`e60e7a771`）的 `host/platform/paths/api.ts:125` 已正式提供
`ctx.paths.dataSpaceDeviceId()`，实现位于 `host/platform/paths/index.ts:386`，即
`translation_repo.rs:65-70` 所调 `data_space::device_id::get_device_id` 的
env → primary → legacy 规范化 + 原子持久化入口。L11 `index.ts` 只调用该正式方法，
不做能力探测回退；`main` 的 `paths` 服务上插件可正常 apply，`translations` /
`folder_items` 的 `device_id` 取同一身份。不得回退 legacy-root-first `deviceId()`：
旧 root 与 env 并存时它给出不同身份，继续用会写错同步列；本 lane 也不复制 F4 的
解析、规范化或临时身份缓存。

验证：全局作业 `20261104092703-363010` 通过 `host/platform/paths/tests/device-id.test.ts`
6 例（env 优先并规范化、primary、legacy 迁移、无源生成持久化、旧根包装区分、生产
logger）与 L11 `tests/device-identity.test.ts` 1 例（生产 `index.ts` 只取正式入口，
legacy/authoritative 两个不同身份）、`tests/translations.test.ts` 6 例，共 5 文件 /
43 测试、退出码 0、无 Errors。此处为早期owner证据；R11-01后续已由R3正式签收，原编号不再未决。

## 已发布、等待消费方接入

| 服务 | 方法 | 消费方 | 状态 |
|---|---|---|---|
| `vfsRepo` | 全部仓储方法（含 Q8 题目写入口） | L13b / L14 / L15 / L02 等 | main 已同步到新服务名；本 lane 生产只发布 `vfsRepo` |
| `vfsRepo.files/resources/exams` | PDF/多模态写入口（见下文 L12 节） | L12-vfs-index | 已发布并由 `tests/pdf-owner-writes.test.ts` 验证；等待 L12 删除本地 SQL |
| `vfsMaintenance` | `createTodoSubtasks`、`resetDisabledToPending`、`resetIndexedWithoutEmbeddings`、`resetAllIndexStateRows`、`clearMediaCache`、`clearResourceOcr`、`getResourcePath`、`updatePathCache` | L13b | 已发布并由 `tests/maintenance.test.ts` 从真实 `ctx.vfsMaintenance` 验证；L13b 已收到接入通知 |
| `vfsWorker` | `runTodoOperation`、`runPomodoroOperation`、`runResourceSearch`、`workerThreadId`、`pauseAndDrain`、`resume`、`dispose` | L13b | 服务已发布并测试；维护参与者接线已就绪，但 main 尚无 F3 注册方法，生产接入仍待 F3 合入后的真实组合验证 |

`vfsMaintenance` 的 provider 在 `src/maintenance-service.ts`：优先使用 `vfsDatabase.getConnSafe()/blobsDir()`，
未安装 `vfsDatabase` 时回退 `storage.database('vfs')` 与 `activeDir/vfs_blobs`。服务描述符在
`api.ts:vfsMaintenanceService`，`index.ts` 的 `meta.provides` 同时列出 `vfsRepo`、
`vfsMaintenance` 与 `vfsWorker`。

R11-03 处理范围：本次新增的是消费者实际需要的原子业务方法
（S04 `recomputeCompletedPomodorosForSyncBatch`，以及已发布的 8 个 `vfsMaintenance` 方法），
没有新增通用连接包装层，也没有为了“去掉 `SqlExecutor`”而改写既有仓储签名。按 main
`docs/dev/electron-migration/decisions.md` D1/D4：表所有者发布与 Rust `*_with_conn`
一一对应的业务方法，签名带调用方的 `SqlExecutor`；调用方只传递事务执行器、不用它
执行任意 SQL。本 lane 的公开面即这一接缝，不做批量改名，也不暴露“原始连接 + 任意 SQL”
通道。

## `clearMediaCache` 向量文件阶段（已发布，L13b 接入用）

对应 `handlers.rs:7161-7178`：OCR 清理后、`DELETE vfs_index_segments/units` 前，
计算 `lance/vfs` 目录大小并 `remove_dir_all`；失败 warn 后继续，成功累计
`vectorIndexCleared=1` 与 `totalBytesFreed`。即使后面的 `resources.vector_indexed_at`
缺列失败，目录删除也必须已经发生。

L11 公开接缝（`api.ts:VfsMaintenanceService`）：

```ts
clearMediaCache(
  params: ClearMediaCacheParams,
  beforeVectorClear?: (lanceDir: string) => {
    existed: boolean;
    removed: boolean;   // remove_dir_all 成功才为 true
    bytesFreed: number; // calculate_dir_size(...).unwrap_or(0)
  },
): ClearMediaCacheResult;
```

L13b 接线时必须传入文件原语（可直接复用 L12/L13b 的 `existsSync + directorySize +
rmSync`），由 L11 在准确阶段调用；目录不存在返回 `{existed:false,removed:false,bytesFreed:0}`。
`existed && !removed` 或回调抛错时，L11 记 warn 后继续后续 SQL，不移动/不吞掉
`vector_indexed_at` 的既有缺列错误。不要把这步放到 `clearMediaCache` 整次调用之前或
之后。`tests/maintenance.test.ts` 用真实临时目录覆盖“OCR 已清、segments 仍存在时回调”、
“后续缺列失败但目录已删除”、“成功累计字节”和“删除失败 warn 后继续 SQL”。

## S04 / L20b 同步批次派生计数接口（已发布，等待 L20b 接入）

表所有者入口（`api.ts:PomodoroRepository`）：

```ts
ctx.vfsRepo.pomodoros.recomputeCompletedPomodorosForSyncBatch(
  conn,                          // apply 事务自身的 SqlExecutor，不得另开连接
  changedTables,                 // 本批变更表名，如 changes.map(c => c.table_name)
): void;
```

调用位置：L20b 同步 apply 的 `BEGIN IMMEDIATE` 事务内、所有单条 SAVEPOINT 之后、
提交之前；每批调用一次。`changedTables` 不含 `pomodoro_records`/`todo_items` 时直接返回。
调用方不得拆分/另开事务，不得直接写 `todo_items.completed_pomodoros`，也不得在
vfs 上再调用自己那份重算（会重复写回声）。

接线注意：L20 的 `host/plugins/sync/index.ts` 目前 `inject: ['storage', 'paths']`，
接入本方法时需增加 `vfsRepo`（或由已持有 apply 事务的协调层调用）；`sync-support`
本身不持有 vfs 事务，不应在 `src/pomodoro.ts` 里继续保留 vfs 重算副本。

与 `host/plugins/sync-support/src/pomodoro.ts` 现有实现的差异：

| 项 | L20b 旧实现 | L11 所有者方法 |
|---|---|---|
| SQL/口径所有权 | `sync-support/repository/pomodoro.ts` 持有 | `vfs-repos/repository/pomodoros.ts` 持有 |
| 入参 | `SyncChangeWithData[]`（跨 lane 类型） | 仅 `readonly string[]` 表名 |
| `pre_log_max` | `Number()`，>2^53 丢精度 | `safeIntegers` 读 bigint，按 i64 绑定 |
| 错误 | `SyncError::Database` 包装 | `VfsRepositoryError('VFS_STORAGE', '重算/清零…失败: …')` |
| 形状守卫 | L20b 本地 `tableHasColumn` | L11 本地 PRAGMA 守卫（缺表/列及 prepare/query 失败静默跳过） |
| 幂等/回声 | 相同 SQL | 相同 SQL；第二次调用为 no-op，既有未同步日志不被误标 |

L20b 接入后应删除对 vfs 库的 `pomodoroCountsSupport.recompute*` 调用，只保留
“本批是否触及相关表”的筛选或直接传表名列表；`chat_v2`/`mistakes` 等无
`todo_items` 的库由调用方跳过或由 L11 形状守卫静默返回。该接缝符合 main
`decisions.md` D1（所有者 `*WithConn` 业务方法）与 D4（`SqlExecutor` 只作事务传递）；
本 lane 不新增通用连接/事务包装层，只发布这一条窄业务方法。

**R11-06 形状探测容错**：Rust `sync/mod.rs:8147-8159` 的 `table_has_column` 在
identifier 校验、`prepare`、`query_map` 失败时都返回 false，`pomodoro_counts.rs:91-97`
随后静默跳过。L11 的 `tableHasColumn` 已同样用 try/catch 把 PRAGMA 查询失败降为
false；重算与清零两条真实 `UPDATE` 仍分别包装为 `VFS_STORAGE` 并抛出，不扩大
catch 范围。`tests/sync-pomodoro-counts.test.ts` 新增“探测失败不抛且不改计数”与
“重算/清零 UPDATE 失败均传播”对照测试。

## Q8 / L14 题目表唯一写者接缝（已发布，等待 L14 接入）

按 C2 `05:14` D1/D4 裁定与 R5-Q8：`questions` / `question_history` /
`question_bank_stats` / `answer_submissions` 只由 L11 `ctx.vfsRepo.questions`
写入。L14 只做业务编排：把 apply/提交事务的 `SqlExecutor`（`DatabaseHandle` 或
`SyncTransaction`）传入下列方法，不再保留同表 SQL 副本；L14 仍独占
`qbank_*` / `exam_sheets` / `qbank_import_jobs` 等自有表。

### 已有可直接复用的连接绑定方法

`getQuestion`、`getQuestionByCardId`、`getQuestionsByIds`、`listQuestions`、
`searchQuestions`、`rebuildFtsIndex`、`countByType`、`getStats`、`refreshStats`、
`getHistory`、`recordHistory`、`createQuestion`、`batchCreateQuestions`、
`updateQuestion`、`deleteQuestion`、`deleteQuestionIfVersion`、
`batchDeleteQuestions`、`submitAnswer`（= L14 `submitAnswerState`）、
`insertSubmission`、`getSubmissions`、`getSubmissionsWithSnapshots`、
`getSubmissionByClientRequest`、`getSubmissionSnapshot`、
`buildSubmissionSnapshots`、`updateSubmissionCorrect`、
`deleteSubmissionsByQuestion`、`deleteSubmissionsByExam`。

### 本次新增的缺口方法（L11 `api.ts` / `repository/questions.ts`）

```ts
// 答题事实 + submission + 题目计数/状态 + sync 标记/内容哈希（不含 stats/mastery）
applySubmissionVerdict(conn, questionId, submissionId, isCorrect, gradingMethod, now)
  : VerdictApplyOutcome; // { changed, updated_question, submission }

// submission 读取与提交后 best-effort 当日进度
getSubmissionById(conn, submissionId): AnswerSubmission | null;
dailyProgressRows(conn, examId, date): { ids: string[]; correct: number };

// Rust reset_progress / reset_questions_progress 的 L11 表写入
resetExamProgress(conn, examId, now): QuestionBankStats;   // 含 submissions 删除 + stats
resetQuestionProgress(conn, questionId, now): string;      // 返回 exam_id，含 submissions 删除

// 出题/迁移/题组/重解析的其余 questions 写入
applyQuestionMetadata(conn, questionId, {
  card_id?, group_id?, group_position?, source_key?, provenance?,
  answer_origin?, parent_id?
}): Question;
bindQuestionCard(conn, examId, cardId, questionId, now): number;
mergeQuestionProvenance(conn, questionId, patch: JsonValue): number;
replaceQuestionForReparse(conn, examId, questionId, expectedUpdatedAt,
  params: ReparseQuestionParams, now): number;
updateQuestionGroupMembership(conn, questionId, {
  group_id, group_position, exam_id?, expected_group_id?, allow_existing_group?
}): number;
softDeleteQuestionInGroup(conn, questionId, examId, now): number;
```

`applySubmissionVerdict` 与 Rust `question_bank_service.rs:820-957` 的 L11 段一一对应：
同向重放短路、严格绑定 `submission_id + question_id`、按 submission 旧值算
`correct_count` 增量、只对“最近一次 submission”改题目 `is_correct/status`、
`answer_submissions.updated_at/local_version+1`、题目 `sync_status/content_hash`。
它**不**写 stats、不写 L15 mastery。

### L14 必须保持的事务顺序

`submit_answer`（含 manual override 合并与 `regrade_submission`）：

1. `getQuestion` / `getSubmissionByClientRequest` / `getSubmissions`（同一 `conn`）。
2. 首判：`submitAnswer` → `insertSubmission` → **L15**
   `recordQbankAnswerWithConn(conn, submissionId, ...)` → `refreshStats`；
   或改判：`applySubmissionVerdict` → **L15** `recordQbankAnswerWithConn` /
   `recordQbankVerdictCorrectionWithConn` → `refreshStats`。
3. 任一步（含 L15 mastery）抛错，整个事务回滚；不得把 mastery 放到提交后。
4. commit 后：`dailyProgressRows` 读快照（失败只 warn 并返回 null）、
   SM-2 复习计划、`syncLearnerProfile` 都是 best-effort，位置保持在 commit 之后；
   `needs_review_plan = !newIsCorrect`。

`reset_progress`：在 L14 的 `BEGIN IMMEDIATE` 内调用 `resetExamProgress`，
返回的 `QuestionBankStats` 直接作为命令结果；`reset_questions_progress`：外层事务内
逐题 `savepoint(sp => resetQuestionProgress(sp, id, now))`，收集 exam_id 后
`refreshStats`，错误文案仍为 `<questionId>: not found`。Rust `reset_progress`
的 `info!` 在 commit 之后；L11 仓储层不记 info，L14 若尚未保留应在 commit 后补回
`[QuestionBankService] Reset progress for exam_id=...`，不要移到事务内。

### 出题 / 迁移 / 题组写入映射

| L14 现有 SQL | L11 所有者入口 |
|---|---|
| `authoring.ts:364-366` | `applyQuestionMetadata({card_id: id, group_id, group_position, source_key, provenance, answer_origin})` |
| `authoring.ts:377` | `applyQuestionMetadata({parent_id})` |
| `legacy.ts:349-350` | `bindQuestionCard` |
| `legacy.ts:356-358`、`855-856` | `mergeQuestionProvenance` |
| `legacy.ts:831-844` | `replaceQuestionForReparse` |
| `management.ts:170/207/222/274` | `updateQuestionGroupMembership`（按原条件传 `expected_group_id` / `allow_existing_group`） |
| `management.ts:288-291` | `softDeleteQuestionInGroup` |
| `repository/questions.ts` 其余 CRUD/submission/stats/history | 上文“已有可直接复用”清单 |
| `qbank/repository/questions.ts` `updateAiFeedback` / `updateAiAnalysis` / `markAsModified` / `updateContentHash` | 同名 `ctx.vfsRepo.questions` 方法（WP-021，见下节） |

### WP-021：AI 缓存与同步标记四个原子方法（已发布，等待 L14 删除本地副本）

L14 `qbank/BLOCKERS.md`「L11 vfs-repos：Q8 剩余原子方法」请求的四个方法已发布到
`QuestionRepository`（`types/questions.ts`），签名与 L14 现有同名函数一致，L14 可直接替换调用、
删除 `qbank/repository/questions.ts` 中的本地实现与 `contentHash` 副本：

```ts
updateAiFeedback(conn, questionId, feedback, score: number | null, now): number; // changes
updateAiAnalysis(conn, questionId, feedback, now): number;                        // changes
markAsModified(conn, questionId): void;
updateContentHash(conn, questionId): string;                                      // hash
```

| 方法 | Rust 来源 | 写入列 | 错误 |
|---|---|---|---|
| `updateAiFeedback` | `dstu-qbank/src/qbank_grading/pipeline.rs:596-601`（`persist_grading_result` Grade 分支内联 SQL） | `ai_feedback, ai_score, ai_graded_at=now, updated_at=now`，`deleted_at IS NULL` | 原始 `StorageError`（不加前缀）；调用方按 `:608` 包 `保存 AI 反馈失败: …`，`0` 行按 `:609-613` 报 not_found |
| `updateAiAnalysis` | 同上 `:602-607`（Analyze 分支） | `ai_feedback, ai_graded_at=now, updated_at=now`，保留 `ai_score` | 同上 |
| `markAsModified` | `dstu-vfs/src/vfs/question_sync_service.rs:1518-1531` `mark_as_modified_with_conn` | `sync_status`：仅 `synced→modified`，仅未删除行 | `VFS_STORAGE` / `Database error: …` |
| `updateContentHash` | 同文件 `:1540-1556` `update_content_hash_with_conn`；读题 `:1612-1718` `get_question_by_id`；算法 `:471-517` `compute_content_hash` | 只写 `content_hash`（不过滤 `deleted_at`，与 Rust 相同） | 题目缺失/已删/列转换失败 → `VFS_NOT_FOUND` / `question not found: <id>`；prepare 或 UPDATE 失败 → `VFS_STORAGE` |

- Rust `question_repo.rs` 没有这四个函数（brief 中的名字是请求方按行为起的）；准确来源是上表两处。
- 四个方法都只用传入的 `conn`，不开事务、不提交；L14 持有事务并负责 mastery/统计编排。
- `markAsModified` / `updateContentHash` 的 UPDATE 会触发 schema `trg_questions_updated_at`，
  `updated_at` 补为 `datetime('now')`，与 Rust 同库行为一致。
- `updateContentHash` 复用 L11 已有的 `computeQuestionContentHash`，不改算法。读题改为照
  `get_question_by_id` 的 30 列与解码规则（options/tags/images 解析失败静默取默认，
  `structured_data` 解析失败 warn `[QuestionSyncService] Failed to parse structured_data`，
  不做 group/material 补全）。L11 内部 `updateQuestion`/`submitAnswer`/改判/重置原本调用的
  也是同一 Rust 函数，因此一起使用该读法。
- L14 注意：`grading-service.ts` 现在把 `updateContentHash` 失败也包成
  `标记同步状态失败: …`；Rust `pipeline.rs:632-636` 对它用的是 `更新内容哈希失败: …`，
  替换调用时应分开两个 `map_err`。L11 不改 L14 文件。
- WP-178：dstu-vfs 的 serde_json 启用 `arbitrary_precision`（`dstu-vfs/Cargo.toml:50`）与工作区
  `preserve_order`（`src-tauri/Cargo.toml:101`）。`updateContentHash` 读 `structured_data` 改用 F4
  `parseJsonDocument`，哈希段用 `stringifyJsonValue`（raw 数字、`e+` 规范化、`-0`→`0`、首次键位 last-wins），
  warn 文案为 serde `JsonSyntaxError` Display。只改内部 `SyncQuestion` 类型（`repository/question-row.ts`），
  公开 `Question` 与 contract 不变，`loadSyncQuestion` 是唯一调用者。WP-215 接续修复同步读取的
  `options_json`/`tags`/`images_json`：直接消费 F4 `JsonReader`，保留 struct map/seq、已知重复字段
  拒绝、未知 `IgnoredAny` 与整 Vec 失败回退；只捕获 `JsonSyntaxError`，无额外日志。
  公开读取 `rowToQuestion` 的 `structured_data` 精度与 X6-UD-0104 仍未闭合；本包不授全域 JSON 等价。

验证：`tests/question-sync-owner-writes.test.ts` 经真实 `host.ctx.vfsRepo.questions`
覆盖：各方法只改所列列与 timestamp/hash、已删/缺失行、hash 与按 serde 字段顺序手算的
期望值一致（含选项/图片字段重排、`role: null` 省略、非法 JSON 默认值）、NotFound 映射、
UPDATE 失败传播（AI 两方法为原始 `StorageError`，同步两方法为 `VFS_STORAGE`）、
异步事务内可见/外连接不可见/回滚后不变/提交后可见、同步事务后续失败整体回滚。

`updateQuestionGroupMembership` / `softDeleteQuestionInGroup` 只返回
`sqlite3_changes()`，L14 保留原有的 conflict/validation 判定与 `recordHistory`
调用；这样业务错误与日志位置不变。`questions` 的 `trg_questions_updated_at`
触发器在列值未变时仍会补时间戳，和 L14 原 SQL 行为一致。

### 验证

`tests/question-owner-writes.test.ts` 经 `ctx.vfsRepo.questions` 覆盖：改判计数/
状态/`updated_at`/`local_version`、同向重放、旧 submission 改判只加计数不改状态、
mastery 失败整事务回滚、整库/单题重置、当日进度、出题元数据/题组条件、迁移卡片/
来源补丁/重解析 OCC 与图片保留。全套结果见文末验证记录（27 文件 / 219 测试）。

## L12 PDF / 多模态表所有者接缝（已发布，等待 L12 接入）

L12 `repository/pdf.ts` / `repository/multimodal-source.ts` 当前仍直接写 `files` /
`resources` / `exam_sheets`。L11 按 Rust 写点发布以下连接绑定业务方法；L12 只传自己的
事务执行器，不保留同表 SQL 副本，也不要求 L11 暴露任意列 setter。

### `files`（`ctx.vfsRepo.files`）

```ts
updatePdfExtractedText(conn, fileId, extractedText, pageCount: number | null): void;
// pdf_processing_service.rs text extraction:
// UPDATE files SET extracted_text=?1, page_count=?2, updated_at=datetime('now') WHERE id=?3

updatePdfPreview(conn, fileId, previewJson, pageCount: number): void;
// page rendering: preview_json=?1, page_count=?2, updated_at=datetime('now')

updatePdfPreviewOnly(conn, fileId, previewJson): void;
// page compression: preview_json=?1, updated_at=datetime('now')

updatePdfOcrPages(conn, fileId, ocrPagesJson): void;
// update_file_ocr / indexing OCR: ocr_pages_json=?1, updated_at=datetime('now')

updateCompressedBlobHash(conn, fileId, blobHash): void;
// image compression: compressed_blob_hash=?1, updated_at=datetime('now')
// 只执行调用方事务内的这一条 UPDATE；blob store/ref 变更仍由 L12 在同一事务先后完成。

cancelProcessing(conn, fileId): number;
// 仅当 processing_status IN ('queued','decode','vad','asr','indexing','pending')
// 置 'cancelled' 并清 processing_error；返回 changes。

markProcessingRecovered(conn, fileId): number;
// 启动恢复：status='pending', error='recovered: interrupted by app restart'；返回 changes。

setProcessingError(conn, fileId, error, completedAt): void;
// set_error：status='error', error, completed_at；不改 processing_progress。

updateProcessingProgress(conn, fileId, progressJson): void;
// 只写 processing_progress；不改业务 updated_at。

applyProcessingStatus(conn, fileId, stage, progressJson, completedAt, now, issueSummary): void;
// update_processing_status 四分支：
// completed / completed_with_issues(COALESCE issue) / error(不写 completed_at) / 其它
// (processing_started_at=COALESCE(existing, now))；全部不碰业务 updated_at。

applyMultimodalIndexState(conn, fileId, state, indexedPagesJsonOrError: string | null): void;
// multimodal_service.rs files 分支：indexed 写 mm_indexed_pages_json，failed 写
// mm_index_error，其他只写 state；三分支都按 Rust %.3fZ 推进 updated_at。
```

### `resources`（`ctx.vfsRepo.resources`）

```ts
saveOcrTextForFile(conn, fileId, ocrText): number;
// pdf_processing_service.rs:2663:
// UPDATE resources SET ocr_text=?1, updated_at=datetime('now')
// WHERE id=(SELECT resource_id FROM files WHERE id=?2)
// 返回 changes；L12 保留 rows_affected==0 的 Rust 报错。
```

注意：已有 `resources.saveOcrText(conn, resourceId, text)` 是
`resource_repo.rs:922-938` 的语义（`updated_at` 为毫秒整数），不能拿它替代
`saveOcrTextForFile` 的 `datetime('now')`。索引期不改时间戳的两个 OCR 写点由
WP-001 补齐，见下节；L12 调 owner，不保留资源 SQL 副本。

### WP-001 / B1-D03：精确索引缓存与启动恢复（2026-11-05）

公开面均从 `api.ts` 获取：

```ts
ctx.vfsRepo.resources.saveOcrTextIfEmptyWithConn(conn: SqlExecutor, resourceId: string, ocrText: string): void;
ctx.vfsRepo.resources.saveOcrTextWithoutTimestampWithConn(conn: SqlExecutor, resourceId: string, ocrText: string): void;
ctx.vfsRepo.maintenance.recoverStuckIndexingWithConn(conn: SqlExecutor, at: number): number;
```

- Rust `indexing.rs:1082/3485` 的空是 NULL 或精确空串，不包括空白；`:3354/3949` 无条件写。
  两者不改 updated_at，SQL 失败原样抛给 L12 原调用点记录 cache warn 后继续。
- Rust `recover_stuck_indexing(db: &VfsDatabase) -> VfsResult<usize>`（:1978-2053）
  拿连接后按 text units → mm units → resources 顺序更新；每条失败独立 warn/计0并继续。
  返回三条 changes 之和，保留正数汇总 warn/零 debug；resources 不改 updated_at。
- 使用调用方同一连接，不开事务、不提交；传事务时跟随调用方回滚。
  `index.ts` 现有 ResourceRepo / MaintenanceRepo 实例直接发布方法。
- L12 的 `repository/index-content.ts:192-193,223-224,367-370` 已有结构化探测和调用点，
  合入后可自动取得真实方法；本 lane 不改 L12 文件。生产服务测试见
  `tests/indexing-owner-writes.test.ts`，逐分支证据见 SPEC 对应小节。
- `resetRebuildableIndex` 已在 `MaintenanceRepository` 和 `VfsMaintenanceService`，
  它是备份恢复的派生索引重置，非本包崩溃中间状态恢复，不重复实现。

**WP-001 审读发现的下游缺口（L12 另包处理）**：main `967f43c75` 的
`vfs-index/src/indexing-content.ts:153`、`src/ocr-recovery.ts:126,151,327-340`
直接调用 OCR owner，没有 Rust `indexing.rs:1084-1086,3356-3362,3487-3489,3951-3957`
的局部 cache-failure warn 后继续返回文本分支。新 owner 是精确 `conn.execute` 接缝，SQL
失败原样抛出；L12 需在这些调用点补 `try/catch`、原文 warn 并返回既有文本，不能让缓存失败
丢失已抽取/OCR 的结果。本包范围不允许改 L12，交付供协调者续派；不声称 OCR 整链失败语义已闭合。

### WP-020 / D01·D02：browser metadata 与 media 写入口（2026-11-05）

更正 L19 `browser/BLOCKERS.md:12` 与 L18 `media/BLOCKERS.md:8`（L18-B01）中"L11 未发布"的
说法：三个写点的 owner 入口均已从 `api.ts` 的 `VfsReposService` 公开，真实 provider 为
`index.ts` 现有 `ResourceRepo` / `FileRepo` / `TextbookRepo` 实例。消费者删除本地 SQL 后改调：

```ts
// D01 L19：index_webpage_executor.rs:720-729（serialize → now → UPDATE → unit sync）
ctx.vfsRepo.resources.updateResourceMetadataWithConn(
  conn: SqlExecutor, resourceId: string, metadataJson: string, updatedAtMs: number): void;
// 替换 browser/src/index-webpage-executor.ts:647 的 updateResourceMetadata(...)：
try {
  repos.resources.updateResourceMetadataWithConn(conn, resourceId, JSON.stringify(metadata), Date.now());
} catch (error) { throw backendError('WEBPAGE_SAVE_FAILED', messageOf(error), true); }

// D02a L18：pipeline.rs:331-341 write_transcript_text、bilibili.rs:1011-1014 / 1044-1047
ctx.vfsRepo.files.setMediaExtractedTextWithConn(conn: SqlExecutor, fileId: string, text: string | null): void;
// 替换 media/repository/media-commands.ts:41 setFileExtractedText 的三个调用点
// （src/pipeline.ts:313、src/media-commands.ts:185、src/bilibili-link-items.ts:199）：
repos.files.setMediaExtractedTextWithConn(conn, fileId, text === '' ? null : text);

// D02b L18：src/cmd/textbooks.rs:746-753 textbooks_relink —— 已有同义 owner，不另发 files setter
ctx.vfsRepo.textbooks.setOriginalPathWithConn(conn: SqlExecutor, textbookId: string, originalPath: string): number;
// 替换 media/index.ts:709 的 updateTextbookOriginalPath(conn, id, newPath, utcMillisTimestamp())：
try { repos.textbooks.setOriginalPathWithConn(conn, id, newPath); }
catch (error) { throw new CommandError(AppError.database(`更新 original_path 失败: ${messageOf(error)}`)); }
```

语义（三者相同处）：只执行 Rust 原句，绑定顺序与 Rust 相同；不开事务、不提交，传入
`SyncTransaction`/`AsyncTransaction` 时随调用方提交或回滚；0 行（缺行）不报错；
不查存在性、不发事件、不刷新索引；SQL 错误原样抛 `StorageError`（不加 `Database error:`
前缀），调用方保留各自 Rust 包装（`WEBPAGE_SAVE_FAILED` / `MediaError` / `更新 original_path 失败: {e}`）。

- `updateResourceMetadataWithConn`：`metadata_json`、`updated_at`（毫秒整数）原样写入；
  序列化与时间戳由调用方先完成，保持 Rust 序列化错误先于 SQL 的顺序。不改 data/hash/
  ref_count/ocr_text/index_state。与 `textbooks.rs` 批注写（`resource_changed != 1` 报 NotFound）
  不同，Rust 网页保存不查 changes，故返回 void。
- `setMediaExtractedTextWithConn`：只写 `extracted_text`；`null` 写 SQL NULL，空串按给定值写入
  （空→NULL 是 `pipeline.rs:335` 调用方逻辑）。不改 `updated_at`、不过滤 `deleted_at`。
  `updatePdfExtractedText` 额外写 page_count/updated_at，不能替代。
- `textbooks.setOriginalPathWithConn`（C1 U2/U4 已发布，`types/content.ts:41-47`）：同一 UPDATE，
  `updated_at` 在 UPDATE 前一刻按 `%Y-%m-%dT%H:%M:%S%.3fZ` 生成，对应 Rust `now` 的计算位置；
  返回 changes（Rust 忽略，0 行不报错）。L18 当前本地传入的 `utcMillisTimestamp()` 同格式，
  切换后可删去。Rust 此处 UPDATE 与后续 `attach_blob_if_missing_with_conn` 同连接但无事务，
  UPDATE 先自动提交；L18 不应为此新包事务。
- L18 需自核的消费差异（不属 owner 语义）：Rust `bilibili.rs:1011,1044` 写 `cues.join("\n")`
  原值（空串不转 NULL），而 L18 `bilibili-link-items.ts:199` 当前做 `'' → null`；在 cues 非空时
  两者等价，空 cues 是否可达由 L18 按 `parse_subtitle` 核定。

验证：`tests/consumer-owner-writes.test.ts` 经真实 `host.ctx.vfsRepo`（真实迁移 schema）覆盖
整行快照仅目标列变化、相邻行不变、缺行 no-op、NULL/空串、soft-deleted 行仍写、独占异步事务
内可见且主连接不可见、rollback 恢复、同步事务后续失败撤销、BEFORE UPDATE RAISE(ABORT)
错误原文与 `StorageError` 类型且行不变。L11 未改 L18/L19 文件，消费者迁出由其 lane 完成。

### `exam_sheets` 多模态字段（`ctx.vfsRepo.exams`）

```ts
applyMultimodalIndexState(conn, examId, state, indexedPagesJsonOrError, embeddingDim): void;
// indexed: mm_indexed_pages_json + mm_embedding_dim + mm_indexed_at=updated_at
// failed : mm_index_error + updated_at
// 其他   : mm_index_state + updated_at
```

资源侧的 `resources.mm_index_state/mm_index_error` 继续由 L12 调
`ctx.vfsRepo.indexStates.setMmIndexState/markMmFailed`（已有方法），不要回退到直接
SQL；`applyMultimodalIndexState` 只负责业务表本身，避免一次调用重复写资源。

验证：`tests/pdf-owner-writes.test.ts` 从 `ctx.vfsRepo` 覆盖各写点的
`updated_at` 是否推进、page_count、OCR 文本 affected rows、processing 状态分支不改
业务时间、压缩 hash 在调用方事务内可回滚、file/exam 三类 mm 分支。

## R13-02 跨线程业务执行入口（已发布，等待 L13b 接入）

按 R13b `BLOCKERS.md` 的两个选项，L11 选择“所有者业务执行服务”。新增
`ctx.vfsWorker`（`api.ts::VfsWorkerService`，`src/worker-service.ts` +
`src/worker-entry.ts`）：

```ts
runTodoOperation<T>(method, args?): Promise<T>;
runPomodoroOperation<T>(method, args?): Promise<T>;
runResourceSearch<T>('exam' | 'translation' | 'essay', query, limit, offset?): Promise<T>;
workerThreadId(): Promise<number>;   // 诊断/测试用真实 threadId
pauseAndDrain(timeoutMs?): Promise<void>; // 拒绝新操作 → 等待在途/短寿命 worker → 关闭连接
resume(): void;                      // 退出 maintenance 后恢复
dispose(): Promise<void>;
```

实现约束：

- `todo`/`pomodoro` 使用一个持久 worker；每条命令在 worker 线程里通过
  `new SqliteDatabase({ path: ctx.storage.pathOf('vfs'), profile: PROFILES.vfs })`
  打开**自己的** F3 连接，再调用现有生产仓储方法。主线程的 `DatabaseHandle`/Cordis
  service 不跨线程传递，也没有同步 Promise 包装。
- `runResourceSearch` 每次启动短生命周期 worker，使 exam/translation/essay 三类搜索
  可以像 Rust `spawn_blocking`（`handlers.rs:843-922`）一样并行，而不是在一个 worker
  里排队。短寿命 worker 也登记在 `oneShots`，维护排空时必须一并等待/关闭。
  `notes` 搜索属于 L10，L11 不能替他 lane 发布；L13b 仍须从 L10 获取 note 搜索入口，
  不能把四类搜索都算作本接缝已完成。
- `pauseAndDrain` 先置 paused 拒绝新请求，再等待已准入请求、pending 响应和全部
  one-shot worker；超时则拒绝在途 Promise、终止 worker 并抛错，调用方不得在超时后
  继续切换数据库文件。`resume` 只清 paused，下一次请求重新打开 worker 连接。
- 成功值按 structured clone 回传；失败回传原 `name/message/code/data/stack`，主线程
  重建 `VfsRepositoryError`（保留 `code`/`data`），业务错误不降级成通用字符串。
- `worker-entry.ts` 调用 `setRepositoryLogger`，把 worker 内 `logError/logWarn/logInfo/
  logDebug` 经 `parentPort` 回传主线程，由 `VfsWorker` 转发到
  `ctx.logger('dstu_vfs::repos')`；日志转发失败只 warn，不影响任务结果。
- 120s 超时只拒绝调用方 Promise，**不是取消**：持久 worker 上的操作可能继续执行并
  写入；短寿命搜索 worker 超时后保持运行并继续被维护排空跟踪，直到自行退出或
  `pauseAndDrain`/`dispose` 终止它。错误文案明确“may still be running / not cancelled”。
- `dispose()` 拒绝在途请求并终止持久/短寿命 worker；插件卸载时 `ctx.effect` 先撤销
  F3 维护参与者注册，再调用 dispose。
- 该入口是窄业务执行面：只允许 `TodoRepo`/`PomodoroRepo` 的原型方法，不接受任意
  SQL 或任意函数。L13b 仍在主线程做命令参数校验、`CommandError` 映射和提交成功后的
  事件发送；它只把仓储调用换成 `await vfsWorker.run*`。

## 历史 F3 维护参与者接线（原组合阻塞已由 R3 §11 解除）

以下 `f37426009` 时点与最早替身验证记录仅保留历史；R3已在真实main `fd925aa05` 签收
原R11-05，见本文顶部。下文旧的接入禁令和“必须重跑”不是当前要求，不重复派同项测试。

F3 候选 `9f8c773876` 在 `host/platform/storage/api.ts` 公开发布：

```ts
registerMaintenanceParticipant(
  name: string,
  participant: {
    databases?: readonly DatabaseName[];
    enterMaintenance(): void | Promise<void>;
    exitMaintenance(): void;
  },
): () => void;
```

F3 先拒绝新借用，再按注册顺序调用参与者 `enterMaintenance`，最后 drain/checkpoint/
关闭主线程连接；release 时逆序同步调用 `exitMaintenance`。enter 失败时 F3 只释放已成功
进入的参与者，不调用失败参与者自己的 exit。

L11 的接线（`index.ts`，能力探测，不新增平行注册接口）：

- 存在该方法时注册 `vfs-worker`，`databases: ['vfs']`；enter `await pauseAndDrain()`，
  失败（含超时强制终止）时先 `resume()` 再原样抛出，避免 storage 已回滚而 worker 永久
  停在暂停态；exit 同步 `resume()`；卸载时调用返回的 unregister。
- main `f37426009` 的旧 `StorageService` 尚无该方法，生产 apply 会走未注册旧路径；
  此时 worker 连接仍不受 `enterMaintenance` 冻结，**L13b 不得把生产命令切到
  `vfsWorker`**。这是待 F3/main 集成状态，不是 L11 已完成的组合验证。
- `tests/maintenance-registration.test.ts` 用已发布签名的最小注册替身（只做注册/撤销，
  不复制 F3 的维护屏障）走生产 `index.ts`，验证注册形状、真实 worker 的在途排空、
  新请求拒绝、exit 恢复、enter 失败自行恢复与卸载撤销。该测试证明 L11 接线，但不能
  替代 F3 `enterMaintenance`/`release` 的真实组合门禁；F3 合入 main 后必须在该版本上
  重跑备份/恢复路径。
- L11 在 worker 内直接使用 F3 已发布的实现类 `SqliteDatabase` + `PROFILES.vfs`，没有
  复制连接/PRAGMA 逻辑；若 F3 后续发布 worker 工厂，L11 只替换 `worker-entry.ts` 的
  打开方式，服务签名不变。

验证：`tests/worker-service.test.ts` 使用真实 `worker_threads`，断言事件线程
`threadId` 与主线程不同、todo 写入在主库可见、pomodoro 派生计数落库、exam 搜索经
短生命周期 worker、业务 `VFS_NOT_FOUND` 原样返回、`pauseAndDrain` 等待已准入请求且
拒绝新请求后 `resume` 可恢复、短寿命搜索被排空跟踪、worker 仓储 warn 日志回传、
dispose 后拒绝新操作。

## 仍缺提供方（不由 L11 写他 lane 的表）

| 缺什么 | 责任 lane | 影响 | 判定依据 |
|---|---|---|---|
| `vfsMaintenance.resetUnitIndex`、`vfsMaintenance.deleteResourceIndex` | L12-vfs-index | L13b 的 `vfs_reset_unit_index` / `vfs_delete_index` 生产命令 | 操作 `vfs_index_units`/`vfs_index_segments`/`vfs_embedding_dims` 与 Lance 清理，按协调者分工归 L12；L11 已有连接绑定仓储但不能替他 lane 发布 |
| `vfsMaintenance.setAttachmentRootFolderId`、`createAttachmentRootFolder`、`getOrCreateAttachmentRootFolder` | L17-memory（或协调者指定） | L13b 附件根文件夹命令 | `attachment_config.rs` 复用 `memory_config` 表，现有写实现在 `host/plugins/memory/repository/config.ts`；L11 不直接写该表 |
| F7 pdfium / NativeImage.encode / 二进制 Office 解析 | F7 | PDF 附件上传/修复、`pdf_preview` 渲染；docx/xlsx/pptx 等文本 | **已更正（2026-11-04 C2 08:26）**：main 已发布 `nativePdfium.open/extractText/page/render/close` 与 `nativeImage` 基础解码；F7 分支 `f00fd62c1`+ 另发布 `NativeImage.encode`。L11 已实现异步 PDF preview 生产组装并注入这两个服务（`src/attachment-processing.ts`），缺 `encode` 时只退回 text-only、不伪造预览；完整二进制 Office 文本解析仍未交付（F7 只提供 `nativeOfficeText`/writer），与已交付的 CSV/XLSX 分支分开 |
| `qbank.questionSync.*` | L14-qbank | 无（已解除对 L11 的阻塞） | `updateQuestion`/`submitAnswer` 的同步副作用只写本 lane 的 `questions` 列，已完整实现；不再等待该接口 |

L13b 的临时接口 `host/plugins/vfs-handlers/src/maintenance-needs.ts` 仍是完整 13 方法形状。
协调者拆分/接线前，L13b 对缺失方法应保留明确的待接线错误，不能用 L11 的替身掩盖。
本 lane 的 `api.ts` 暂不 `declare module` 扩展 `Context.vfsMaintenance`，因为该临时接口已声明同名属性，
声明合并要求类型完全一致；等接口拆分后由本 lane 接管 8 方法子集的声明。

## 已知 Rust 缺陷（按原样保留）

`handlers.rs:7193-7200` 的 `vfs_clear_media_cache` 向量分支引用 `resources.vector_indexed_at`，
但 vfs 迁移从未创建该列。SQLite 上该分支会先删除 segments/units、清零 `record_count`，
随后在计数/更新时失败。`tests/maintenance.test.ts` 用
`clear media cache vector branch preserves the Rust missing-column failure after deleting rows`
记录该部分生效后失败的顺序；未修复，也未改成“更合理”的行为。

## 验证记录（2026-11-04，worker 维护/日志与 L12 PDF 接缝后）

- 当前 typecheck（全局作业队列）：`20261104065146-db0e76`，
  `npx tsc -p tsconfig.host.json --noEmit` → **退出码 0**。
  旧报告中 `accounts TS7016` / 全局 250 错误是 main 合入前的基线；main 已补
  `scripts/electron-migration/lib/accounts.d.mts`，本轮不再出现。新增
  `PdfResourceOwner` 也未改他 lane 测试替身，当前全局 typecheck 无新增错误。
- 本轮最小相关测试（全局作业队列）：`20261104064942-26c47a`，
  `npx vitest run -c vitest.host.config.ts --pool=threads --maxWorkers=1
  host/plugins/vfs-repos/tests/pdf-owner-writes.test.ts
  host/plugins/vfs-repos/tests/worker-service.test.ts`
  → **退出码 0**，2 个文件 / **14** 个测试通过。覆盖 PDF 各写点 `updated_at`、
  page_count、resource OCR affected rows、processing 四分支不改业务时间、
  compressed hash 调用方事务回滚、file/exam mm 分支；以及真实 threadId、独立连接、
  `pauseAndDrain`/`resume`、短寿命搜索排空跟踪、worker 日志回传、dispose。
- postMessage 失败清理回归（全局作业队列）：`20261104065147-2a3094`，
  `host/plugins/vfs-repos/tests/worker-service.test.ts` → **退出码 0**，1 个文件 /
  **7** 个测试通过；确认 worker 终止/发送失败不会泄漏准入计数或 pending 项。
- Q8/R13-02 的完整历史基线仍是 27 个测试文件 / **219** 个测试、退出码 0；本轮按
  “只跑变更相关最小集”规则没有重跑全套。测试沿用共享已迁移 schema 模板、每个测试
  复制独立 DB，不改变断言；跨线程测试由真实 worker_threads + 独立连接执行。
- 接线/边界/ledger 的此前基线（本轮未重跑；本次变更只新增 owner 方法、测试与文档，
  未改命令、依赖注入或 ledger 数据）：`importable: ok`；`migration:wiring` 合计
  ported 158 / index.ts 未接入 0（0.0%）；`migration:boundaries:strict` 本 lane 0 违规
  （全局其他 lane 20 条；本 lane 唯一 empty-catch 在 `pomodoros.ts`，已 boundary-allow）；
  `migration:ledger -- --check --no-write` L11 158 测试 / 100% A、0 pending。

## 验证记录（2026-11-04，api.ts 拆分与 F3 参与者接线）

- 契约拆分：`api.ts` 从 1328 行降为 16 行 barrel，职责模块为 `types/common.ts`(17)、
  `types/core.ts`(233)、`types/content.ts`(543)、`types/indexing.ts`(219)、
  `types/files.ts`(137)、`types/questions.ts`(213)、`types/services.ts`(134)；
  `api.ts` 的旧导出名全部保留，另把原先仅内部使用的题库 wire 类型经 barrel 重新导出。
- 全局 typecheck（作业 `20261104070631-b16783`）：
  `npx tsc -p tsconfig.host.json --noEmit` → **退出码 0**。
  该轮之前的 `20261104070420-00708d` 暴露测试文件 `ReturnType<Promise>` 取 `storage`
  的 TS2339（已改 `Awaited<...>`）；更早 `20261104070153-ded75f` 暴露
  `content.ts` 动态导入相对路径仍按旧位置写（已改 `../repository/pdf-preview.ts`）。
- 维护接线最小测试（作业 `20261104070459-b55d2b`）：
  `npx vitest run -c vitest.host.config.ts --pool=threads --maxWorkers=1
  host/plugins/vfs-repos/tests/maintenance-registration.test.ts
  host/plugins/vfs-repos/tests/worker-service.test.ts`
  → **退出码 0**，2 个文件 / **10** 个测试通过。新增 3 个测试覆盖生产 `index.ts`
  的 `vfs-worker`/`vfs` 注册与卸载撤销、真实 worker 在途排空/新请求拒绝/exit 恢复、
  enter 失败自行恢复；既有 worker 7 个测试继续覆盖真实 threadId、独立连接、短寿命
  搜索排空、worker warn 日志回传与 dispose。该作业早于测试文件上一条仅类型标注的
  `Awaited` 修正，运行时断言未变；修正后 typecheck 已通过。
- **未完成门禁**：main `f37426009` 的 storage 没有 `registerMaintenanceParticipant`，
  上述测试使用已发布签名的最小注册替身，不是 F3 组合验证。与 F3 配合仍需在
  `9f8c773876` 合入后的 storage 上跑真实 `enterMaintenance`/`release`，确认参与者
  先于主线程 handle drain、备份/恢复期间 worker 写入被冻结。
- importable 运行时检查（作业 `20261104070809-c41ae4`）：
  `node scripts/electron-migration/importable.mjs host/plugins/vfs-repos/index.ts`
  → **退出码 0**，`importable: ok`；确认 barrel 拆分未引入 Host 类型擦除不支持的语法。

## 验证记录（2026-11-04，R11-06 与 F4 身份调用面）

- R11-06 修复：`repository/pomodoros.ts` 的 `tableHasColumn` 仅对 PRAGMA 形状探测
  使用 try/catch → false，对应 `sync/mod.rs:8147-8159`；重算/清零 UPDATE 仍分别
  转成 `VFS_STORAGE` 并抛出。新增测试：
  `shape_probe_query_failure_is_treated_as_missing_column`（探测失败不抛、计数不变）
  与 `recompute_and_zero_update_failures_still_propagate`（两条业务 UPDATE 失败均传播）。
- R11-01 调用面：`index.ts` 只调用 `ctx.paths.dataSpaceDeviceId()`，不提供旧
  `deviceId()` 回退；不复制 F4 resolver/规范化/临时缓存。`tests/support/paths-service.ts`
  同时提供两个入口，`tests/device-identity.test.ts` 用 legacy/authoritative 两个不同
  身份验证生产 `index.ts` 只取正式入口。
- 全局 typecheck（作业 `20261104071314-2a42c0`）：
  `npx tsc -p tsconfig.host.json --noEmit` → **退出码 0**。
- L11 最小测试（作业 `20261104071314-fbc6d8`）：
  `npx vitest run -c vitest.host.config.ts --pool=threads --maxWorkers=1
  host/plugins/vfs-repos/tests/sync-pomodoro-counts.test.ts
  host/plugins/vfs-repos/tests/device-identity.test.ts
  host/plugins/vfs-repos/tests/translations.test.ts`
  → **退出码 0**，3 个文件 / **13** 个测试通过，无 Errors 汇总行。
- F4 候选真实身份分支（临时 worktree `d85995b4b`，作业 `20261104071333-30282e`）：
  `npx vitest run -c vitest.host.config.ts --pool=threads --maxWorkers=1
  host/platform/paths/tests/device-id.test.ts`
  → **退出码 0**，1 个文件 / **6** 个测试通过；覆盖 env 优先并规范化、primary 优先、
  legacy 迁移、无源生成并持久化、旧根优先包装分开、生产 logger。该结果证明 F4
  候选入口语义，不改变“main 尚未合入、L11 只走正式入口故待集成”的状态。
- **R11-01 已在 main 合入后闭合**：main `081b3426d` 已提供
  `ctx.paths.dataSpaceDeviceId()`；本节记录的候选分支结果由上方
  “R11-01 已闭合（2026-11-04）”一节的真实 main 作业 `20261104092703-363010`
  取代。R11-06 已完成实现与对照回归，可提交 R3 复核；不重跑 R11-02/R11-05 已确认
  或未修复的同基线。

## 验证记录（2026-11-04，clearMediaCache 向量文件阶段）

- 新增 `BeforeVectorClear` 接缝后，`tests/maintenance.test.ts` 从 14 增至 **17** 个测试：
  真实临时 `lance/vfs` 目录下断言回调在 OCR 清理后、segments 删除前执行；后续
  `vector_indexed_at` 缺列失败时目录已删除；成功路径累计
  `vectorIndexCleared=1`/`totalBytesFreed`；`removed:false` 时 warn 且后续 SQL 继续。
- 全局 typecheck（作业 `20261104073117-7ac00c`）：
  `npx tsc -p tsconfig.host.json --noEmit` → **退出码 0**。
  该轮之前的 `20261104072925-1fe388` 暴露测试调用 `ctx.vfsMaintenance` 时仍按
  L13b 旧单参数声明解析（`TS7006` 隐式 any、`TS2554` Expected 1 arguments），已用
  `VfsMaintenanceService` 显式类型调用；产品代码无类型错误。
- 维护测试（作业 `20261104072925-579ccc`）：
  `npx vitest run -c vitest.host.config.ts --pool=threads --maxWorkers=1
  host/plugins/vfs-repos/tests/maintenance.test.ts`
  → **退出码 0**，1 个文件 / **17** 个测试通过，无 Errors 汇总行。该作业早于测试
  文件仅类型标注的服务 cast，运行时断言未变；修正后 typecheck 已通过。
- 未修改 L13b 文件；其 `src/media-cache.ts` 需把现有文件原语包成
  `beforeVectorClear(lanceDir)` 传给 `vfsMaintenance.clearMediaCache`，不能把目录删除
  移到整次调用前后。

## 验证记录（2026-11-04，移除 F4 身份回退）

- `index.ts` 已删除 `deviceId()` 回退：只 `await ctx.paths.dataSpaceDeviceId()`；
  `tests/support/paths-service.ts` 默认同时提供两个入口且可取不同值，保证测试仍能
  证明生产没有误用 legacy-root-first 包装。
- 全局 typecheck（作业 `20261104074425-30be44`）：
  `npx tsc -p tsconfig.host.json --noEmit` → **退出码 0**。
- 身份最小集（作业 `20261104074425-f83a84`）：
  `npx vitest run -c vitest.host.config.ts --pool=threads --maxWorkers=1
  host/plugins/vfs-repos/tests/device-identity.test.ts
  host/plugins/vfs-repos/tests/translations.test.ts`
  → **退出码 0**，2 个文件 / **7** 个测试通过，无 Errors 汇总行。
- main `081b3426d` 的 `paths` 服务已提供 `dataSpaceDeviceId()`；R11-01 的真实
  main 证据见前文“R11-01 已闭合（2026-11-04）”，不再保持未闭合。

## R13-01.path-file：路径标题 `file_` 前缀已按 Rust 回退（2026-11-04 续作）

R3 在 vfs-handlers ACCEPTANCE §8 指出：L11 `repository/maintenance.ts` 把 `file` 与 `tb` 一起查
`files.file_name`，而 Rust `handlers.rs:1252-1303` 的 match 只有 `note`/`tb`/`exam`/`tr`/`essay`，
`file_` 落 `_ => None` 后 `unwrap_or_else(|| source_id)`，路径标题就是原始 ID。L11 已删除
`file` 分支并在 `tests/maintenance.test.ts` 固定：`file_` → `/{folder}/file_<id>`、`tb_` →
`/{folder}/<file_name>`。

跨 lane 影响：L13b `host/plugins/vfs-handlers/tests/paths.test.ts:71` 仍断言教材路径为
`/教材.pdf`（其教材 ID 由本 lane `textbooks.createTextbook` 生成 `file_` 前缀）。该测试锁定的是
Rust 中不存在的“file_ 显示文件名”行为，需要 L13b 在本 lane 合入后同步改为
`/${textbook.id}`；本 lane 不得修改他 lane 测试，也不因此恢复偏差分支。

## 验证记录（2026-11-04，R13-01.path-file 与 R11-04 全套）

- R13-01.path-file 修复后的最小集（全局作业队列）：`20261104084136-eeab4d`，
  `npx vitest run -c vitest.host.config.ts --pool=threads --maxWorkers=1
  host/plugins/vfs-repos/tests/maintenance.test.ts
  host/plugins/vfs-repos/tests/resources.test.ts
  host/plugins/vfs-repos/tests/pomodoros.test.ts`
  → **退出码 0**，3 个文件 / **34** 个测试通过，无 Errors 汇总行。
- 全局 typecheck（作业 `20261104084136-67e809`）：
  `npx tsc -p tsconfig.host.json --noEmit` → **退出码 0**。
- **R11-04 全套运行已取得干净结果**（作业 `20261104084231-139884`）：
  `npx vitest run -c vitest.host.config.ts --pool=threads --maxWorkers=1 --no-cache
  host/plugins/vfs-repos` → **退出码 0**，**30 个测试文件 / 239 个测试**全部通过，
  `Duration 369.95s`，输出无 `Errors` 汇总行、无 `onTaskUpdate` / unhandled errors。
  该结果使用本机 `.lane.tsbuildinfo` 之外的真实临时库，不读取用户正式数据库。
  文件数比早期 23 个多，是因为本 lane 合并 main 后新增了 R11-02 竞争测试、R13-02 worker、
  F3 维护注册与 Q8/PDF owner 测试；测试总数 188 → 239。

## L21 恢复：`vfsMaintenance.resetRebuildableIndex(targetDir)`（已发布）

对应 `dstu-sync/src/data_governance/backup/mod.rs:2307 reset_rebuildable_vfs_index`。
L21 的 `repository/vfs-restore.ts` 临时 SQL 与 L12 的派生目录调度都应改为调用本入口；
L11 是 vfs 表的唯一所有者，L12 只负责 `<targetDir>/databases/lance/vfs` 之外的派生目录与调度。

```ts
ctx.vfsMaintenance.resetRebuildableIndex(targetDir: string): void;
```

顺序与 Rust 一致：

1. `<targetDir>/databases/lance/vfs` 存在时先 `rm -rf`；失败抛
   `无法清理恢复目标中的陈旧 Lance 索引 <path>: <error>`，**不继续** SQLite 重置。
2. `<targetDir>/databases/vfs.db` 不存在时直接成功。
3. 存在时打开该库（`plain` profile，等价裸 `Connection::open`），在
   `BEGIN IMMEDIATE` 内按 `PRAGMA table_info` 只重置现有列：
   `vfs_index_segments` 删除；`vfs_index_units` 文本/多模态状态按 `*_required`
   回 `pending`/`disabled` 并清错误/时间/维度/profile/generation；`vfs_embedding_dims`
   记录数清零、`last_used_at=created_at`、ann 归零；`vfs_index_profiles` 按
   `active_profile_id` 标 `active`/`retired`；`resources` 保留 `disabled`、其余回
   `pending` 并清 mm 字段；`files`/`exam_sheets` 的 mm 三态规则；
   清空 `__lance_orphan_queue`。任一步失败整体回滚。
4. 幂等；重复调用结果相同。

仓储侧同时发布 `maintenance.resetRebuildableIndex(conn: SqlExecutor)`，供 L12 在已有
`BEGIN IMMEDIATE` 中复用同一执行器（不另开连接）；无连接调用方只使用上面的 service
方法。`tests/maintenance.test.ts` 的 `reset rebuildable index (L21 handoff)` 覆盖真实
Lance 目录删除、全列重置、disabled/NULL 保留、幂等，以及旧 schema + 迟到失败时整体回滚。

## 附件 PDF 异步处理接缝（已发布，待 F7 `NativeImage.encode` 进 main）

`AttachmentProcessingAdapter.renderPdf` 已改为异步（对应 `pdf_preview.rs` 的同步
pdfium-render）。生产组装在 `src/attachment-processing.ts`：

- **页预览/文本提取（上传期）归 L11**：`nativePdfium.extractText` 提取整篇文本
  （`\f` 页分隔保留），`nativePdfium.open/page/render` + `nativeImage.encode`
  逐页渲染；JPEG/PNG 与 `compressionEnabled`、`targetWidth=1200`/`maxHeight=1600`、
  `maxPages=50`、页码截断和逐页失败 warn 均照 `pdf_preview.rs`。
- **加密检查归 L18 `docs`（DocumentParser）**：上传前调用
  `docs.checkPdfEncryptionBytes`，错误转 `InvalidArgument { param: 'content' }`；
  `pdf_preview` 内部也做同一检查，命中时按 Rust 返回空预览/空文本并 warn。
- **非 PDF 文本**：CSV/纯文本/代码经 F7 `nativeOfficeText`；epub 页级拆分经
  L18 `docs.extractEpubPagesFromBytes`；docx/xlsx/xls/pptx/rtf 等二进制格式仍缺
  F7 解析器，L18 当前对它们抛 `UnsupportedFormat`，上传按 Rust 的提取失败分支
  warn 后继续入库，不伪造文本。pptx 页级拆分同样待 F7。
- **索引期 PDF 流水线（L12）不重复**：L12 `pdf-runtime.ts` 自己的 preview/backfill
  继续由其 owner 负责；L11 只处理上传/修复时 `attachment_repo` 的
  `render_pdf_preview` 调用，两者共用 F7 服务但不共享本地 SQL。
- 若 main 尚无 F7 `NativeImage.encode`，`renderPdf` 逐页失败后返回
  `previewJson:null, pageCount:0` 并保留文本，上传仍成功；不会把缺失能力伪装成已渲染。
  F7 正式合入后无需改 L11 调用面，只需 main 提供 `nativeImage.encode`。

`tests/attachment-processing.test.ts` 覆盖真实 `index.ts` 组装的两条路径：PDF 上传后
`files.preview_json/extracted_text/page_count/processing_status`，以及加密 PDF 在
建行前被拒绝；另覆盖截断、form-feed 文本、逐页失败 text-only、PNG 分支与适配器委派。

## L16 只读资源存活面：`getLiveResource`（已发布）

C1/L16 的 `chatanki_executor.rs:10642-10653` LEFT JOIN 需要区分“资源存在且未软删”与
“资源已软删”。`VfsResource` wire DTO 不新增 `deletedAt`，普通 `getResource` 的
“包含软删行、按 id 原样返回”语义也不改；新增最小同义读方法：

```ts
ctx.vfsRepo.resources.getLiveResource(conn, resourceId): VfsResource | null;
```

- `deleted_at IS NULL` 时返回与 `getResource` 完全相同的 DTO；missing 或软删返回 `null`。
- 不按 `files`/来源表状态过滤：source file 软删但 resource 未删时仍返回 resource，
  与 Rust LEFT JOIN 的 `r.deleted_at IS NULL` 判据一致；L16 只据此拒绝已删资源。
- `tests/resources.test.ts` 的
  `get_live_resource_keeps_deleted_at_out_of_the_dto_and_source_file_deletion_independent`
  覆盖 live / deleted / missing / source file deleted 四种情况。
- L16 直接调用该 owner 方法，不复制 SQL、不新增聚合 resolver。

## 验证记录（2026-11-04 最新代码状态：main 合并 + 本 lane 三项交付）

- 合并 main `081b3426d` 后全量 typecheck（作业 `20261104092703-e74f09`）：
  `npx tsc -p tsconfig.host.json --noEmit` → **退出码 0**。
- 合并后全 lane 测试（作业 `20261104092941-6d1783`）：
  `npx vitest run -c vitest.host.config.ts --pool=threads --maxWorkers=1 --no-cache
  host/plugins/vfs-repos` → **退出码 0**，**31 个测试文件 / 252 个测试**全部通过，
  `Duration 217.79s`，无 `Errors` 汇总行、无 unhandled errors。该套运行覆盖
  `resetRebuildableIndex`（真实 Lance 目录 + 旧 schema 回滚）、异步 PDF 上传/修复
  生产组装、`getLiveResource` 四态、F3 维护注册、worker 与既有全部仓储测试。
- 迁移静态门禁：`scripts/electron-migration/importable.mjs
  host/plugins/vfs-repos/index.ts` → `importable: ok`；
  `migration:wiring -- --lane vfs-repos` → ported 158、未从 index.ts 接入 0（0.0%）；
  `migration:boundaries:strict` → 全局 4 条违规均不在本 lane（本 lane 仅
  `repository/pomodoros.ts:420` 的 `empty-catch` 在 allow 列表）；
  `migration:ledger -- --check --no-write` → commands A 92% / B 5.9%、tests
  A 80.4% / B 1.6%、problems 0。

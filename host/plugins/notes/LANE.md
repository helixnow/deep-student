# L10-notes：笔记

## WP-174：恢复 WP-084 interval 的 Burst 分项（2026-11-05）

- 恢复前核对 `baa0cca6b`（WP-084）、`1dbe5929e` / `1307d2f79`（WP-139）与原报告；原 jobs `20261105183006-e1ae78`（305 passed）、`20261105193336-2a2059`（317 passed）、`20261105193336-b2b24a`（typecheck）均保留 exit 0。共享 `migration/LEDGER.md` / `migration/ledger.json` 开工前已 dirty，归协调者，不纳入本 lane 提交。
- 合并最新 main 后，起点 `20261105203056-924d07` 为原生命周期 **6 passed / 0 failed / 0 skipped / exit 0**，typecheck `20261105203056-fca94d` exit 0。main 的 F3 `StorageError` / 维护入口和 F1 `host/window` / scope 生命周期均可消费，本包无接口阻塞。
- 本包只修 `scheduleNoteEditorLeaseCleanup` 的 5 秒默认 Burst；源码依据与测试矩阵见 `SPEC.md` 的 WP-174 节。新增五例的旧实现反证 `20261105203406-97fb3c`：**3 failed / 2 passed / 0 skipped / exit 1**（首 tick 迟到、后续多周期迟到、Burst 失败继续均只跑一次而非三次）。同步 IO / 启动失败域、Started 消费（WP-091）、export / 键序由各自工作包处理。下文历史“无剩余工作/自动续派”条款以 WORKER.md 的单包交付后结束为准。
- 修后最小集 `20261105203557-cf4c91`：**2 files / 11 passed / 0 failed / 0 skipped / exit 0**；原 WP-084 六例全部断言与 120s setup 预算保留。typecheck `20261105203557-a9390a` exit 0；本包三源码文件 strict `20261105203557-049646` exit 0（0 违规/0 豁免）。新增测试由协调者检查点 `f5d8ca3ae` 保存；SPEC、调度实现及原测试时钟控制由 `6b022e734` 保存。
- `224f532e5` 提交、合并 main 后直接绝对路径 lane-gate：**raw exit 2**，仅原有两份 foreign ledger dirty，未创建正式 selfgate 回执。同清单分项经 jobs：typecheck `20261105204123-58c25b`、boundaries `20261105204123-2aae35`、strict(changed，10 文件) `20261105204123-596b83`、importable `20261105204124-bf33cd`、Node tests `20261105204124-c64950` 全部 exit 0。
- Node 上述 tests 与 Electron `20261105204123-5ba9da` 均 **33 files / 322 passed / 0 failed / 0 skipped / exit 0**，无 Errors 行。wiring `20261105203704-ce1cb9`：134 ported、未接入 0 / exit 0；ledger `--check --no-write` `20261105203704-cf67b6` exit 0；全局 strict `20261105203704-d2ae11`：3111 文件、0 违规、242 全局豁免、notes 无违规/豁免 / exit 0。TESTMAP 仍 134 ported / 1 pending，未改映射；不以分项绿替代 main 集成与独立复验签收。

## 2026-11-05 续派：L10-V2-09 typed history tags（候选）

- 按续派先 merge main；仅其他 lane 测试变化。再次执行指定绝对路径 lane-gate，仍 **exit 2**：原有 `migration/LEDGER.md` / `migration/ledger.json` dirty，未清理、代提交或绕过。旧 N2 已签，不重做；N5/V2-08 仍为此前候选，不因本项验证扩大签收。
- 审读 `note_revision_repo.rs:303-311,327-336` 发现历史 tags 的 `Vec<String>` 错误分支不等价：先全串语法扫描/JSON.parse 后类型检查，导致类型错误缺 UTF-8 位置、整数/浮点误分类、后面的语法错误覆盖先出现的 typed 错误。本候选只将 `revisions.ts::decodeStringArray` 改用 F4 公共 JsonReader；保留 NoteSerializationError/Database envelope、get 只读、set_pinned 先解码再写的顺序；其他资产 struct/props/worker 不随此项签收。
- 测试先行 `20261105010413-a47888`：**8 failed / 3 passed / 3 标题过滤 skipped / exit 1**；原 3 个 V2-08 未单独重跑，过滤不是新增 skip。修后最小 `20261105010529-6d44f8`：**11 passed / 3 标题过滤 skipped / exit 0**。后补 1.0/1e0/-0 三个数字分类向量，由本轮全量检查覆盖，不冒充已包含在该 11 条最小回执中。
- 实现及 14 条新增回归由检查点 `41fb9cb5f` 保存。typecheck `20261105010530-45e398` exit 0；Node `20261105010618-e0d47b`、Electron `20261105010619-7f8670` 均 **31 files passed / 293 tests passed / exit 0**，无 Errors 行，含三个补充数字向量及所有既有用例。
- scoped strict `20261105010530-56f728`：82 文件、0 违规、0 豁免、exit 0；全局 strict `20261105010634-a75bd7`：2952 文件、0 违规、233 全局豁免、exit 0；importable `20261105010619-0c9ee8`：`importable: ok` / exit 0；wiring `20261105010619-172bcf`：ported 134、未接入 0 / exit 0；ledger `20261105010619-b0919b` exit 0，末行同下方原样 ledger 行（commands 1058 / tests 8109 / problems 全 0）。本 lane 命令 A 81/81（100%）、B 0%；TESTMAP 134 ported / 1 pending（MFJS），不改为 obsolete。
- C1 最新限定指令已收：不再重复启动同一共享 ledger dirty 前置的 §5，不清理/stash/reset/代提交，不为等待制造无差异文档 tip。以上都是候选普通检查，不冒充 official 或 R5 签收；旧 N2 不重做，N5/history 原红绿证据保留。
- **本轮可执行事项：无剩余工作。** 仅限定本轮 N5/history 及收到停止扩展指令前已在途的 V2-09 交付；不是全 N5/全部 notes 完成。MFJS、Lance、reverse blob、sync-log、其他 owner 缺口与自有未审项全部保留；只待确切新条件再恢复，正常集成及 main 后 R5 窄复验由 C1 安排。

本轮 scoped strict 原样末行：

```text
boundaries: scanned 82 files, 0 violation(s), 0 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
```

## 2026-11-05 Linux 续作（优先于下方历史状态）

- 本工作树 `ds-mig/L10-notes` 已合并 main（最后 merge `f67e0cbc7`，仅增加其他 lane/协调者改动，无 notes 生产代码变化）。默认 merge 因环境自动 stash 失败而退出；显式 `--no-autostash` 合并成功，未执行 stash/还原/配置修改。原有 `migration/LEDGER.md` / `migration/ledger.json` dirty 保留未动，未纳入本 lane 提交。
- L17 SlotOccupied 紧急反馈已由旧提交 `95ec4695b` / `4d363afa4` 实现及补测，main 当前也含 Disposer 修复；不重写、不清 Slot、不 resetModules，保留 live duplicate 报错。Linux 基线 `20261105000054-12d367`：29 文件 / 272 passed、exit 0（含真实 install→dispose→新 host install 三个生命周期测试）；typecheck `20261105000054-16d690` exit 0。
- N5 的 L11 六个正式 owner 面已到达 main（发布提交 `78b205e51`，源实现检查点 `705cbfcb2`），本候选消费 source_id、两处资源单行删除、membership 软删/最新恢复、unit 禁用、维护标志。每次调用传原 SqlExecutor，不另开事务；`tests/note-owner-consumption.test.ts` 为新增生产入口回归。实现由协调者检查点 `dfe011e1f` 保存，最小真实 owner 验证 `20261105000758-ef681e` **4 passed / exit 0**；不把 N3/Lance、reverse blob、sync-log 顺带关闭。
- L10-V2-08 新发现并修复：历史摘要长度表达式缺 `content_bytes` 别名导致 NaN；list seq 与 restore_current 的 MAX(seq) 曾经过 Number；set_pinned 展开完整 revision 导致额外字段契约失败。原始红灯：`20261105000919-d6256e` **276 passed / 3 failed / exit 1**（三个新历史反例均命中）；第一次修后 `20261105001305-eb3200` **2 passed / 1 failed / exit 1**（额外字段反例）；最终最小 `20261105001657-4e010c` **3 passed / exit 0**。`api.ts` 增补精确 `NoteHistorySequence` / `ExactNoteHistoryPage`，内部游标支持 bigint，线上仍交 kernel 转 JSON number，原生成契约未改。
- 修复后本 lane 全量：Node `20261105001734-110042` 与 Electron `20261105001000-0cb05f` 均 **31 files passed / 279 tests passed / exit 0**，无 Errors 行；包含原有测试与新增 N5 / L10-V2-08 回归，不删除或 skip 测试。typecheck `20261105000918-f459d7` exit 0；严格边界 `20261105000919-34c852` exit 0（2951 files、0 violation、232 全局豁免，无 notes 违规）；ledger `20261105000641-f7bb07` exit 0；importable `20261105001108-343937` 为 `importable: ok` / exit 0；wiring `20261105001108-ceedc8` exit 0，原样输出见下方。
- §5：已提交 `ea0b8e45d` → `git merge --no-edit main`（Already up to date）→ 本工作树执行 `node scripts/electron-migration/lane-gate.mjs`，**exit 2**，仅被开工前已有的两份共享 ledger dirty 拒绝。未清理、代提交、藏改动或绕过前置条件；未获 commit-based 自检签收。对应实现检查点 `dfe011e1f`（N5）、`8bb3f0baf` / `f3d0a947b`（历史及 pending 登记）、`4ee7d7ed3`（最后注释/回执）。N5 待独立复验，非整个 notes v2 验收结论。

本次 ledger `--check --no-write` 原样末行（非写回共享生成文件）：

```text
ledger: commands 1058 (A 100% B 0% C 0%), tests 8109 (A 87.8% B 1.9%); problems: commands 0, tests 0, orphan registrations 0; checkCoverage（host/kernel/coverage.ts）; prod-reachable unreachable 15 (unknown 3633, not vetoed)
```

```text
> deep-student@0.11.0 migration:wiring
> node scripts/electron-migration/wiring.mjs --lane notes

合计 ported 134，其中所测模块未从 index.ts 接入 0（0.0%）
```

strict 完整输出没有 `host/plugins/notes/` 行（无违规、无豁免）；全局原样末行：

```text
boundaries: scanned 2951 files, 0 violation(s), 232 suppressed via boundary-allow; rules: native-import, tauri-import, cross-plugin-impl, electron-imports-plugin, sql-outside-repository, test-double, todo-marker, empty-catch, erasable-syntax, console-log
```
- `B-MFJS / X6-PR-0113`：保留测试与原断言，但测试内 MFJS 算法副本不再登记为移植完成；TESTMAP 当前 **134 ported / 1 pending / 0 merged / 0 obsolete**。pending 精确测试/缺失 L02 入口/待 C1-C2 裁定见 `MFJS-EVIDENCE.md`，不自行 obsolete，不为过接线扫描造假调用。
- L04 的具体 ChatExecutionContext / registry 已到 main；旧“main 没有 execution-context.ts”的描述失效。仍缺的是 F1 Agent ExecutionContext 与 Chat 上下文之间的真实装配适配（窗口、生命周期），不是 L04 方法未实现，详见当前 `BLOCKERS.md`。
- 尚未把旧机械 A=100% 当 v2 签收；历史 seq 的本次修复与其余 SPEC/日志/断言审计、非阻塞 ZIP/文件 IO 分开，后者仍是本 lane 自有工作，不能包装为跨 lane 阻塞。

> 由 `npm run migration:scaffold` 生成；生成区块由 `--refresh` 维护，不要手改区块内部。
> 本目录只放本 lane 自己编写的 `manifest.ts`、`src/`、`repository/`、`tests/`（依据 `host/kernel/api.ts`）。

<!-- BEGIN GENERATED:lane -->
| 项 | 内容 |
|---|---|
| Lane | L10-notes（笔记） |
| 目录 | `host/plugins/notes/` |
| Rust 范围（lanes.md） | vfs 的 note_* 仓储、dstu-notes、cmd/notes，以及 canvas、user_todo、notes_import 工具 |
| 主要提供 | `notes@1` |
| 主要消费 | F3、L11 |
| 特别注意 | 修订、租约、历史恢复；pulldown-cmark 块边界要找等价解析器，用向量对照 |
| 规模（本目录） | 23834 行 · 26 个文件 · 81 个命令（前端调用 60） · 135 个测试 |
| 规模（整条 lane，inventory） | 23834 行 · 26 个文件 · 81 个命令（前端 60） · 135 个测试 |
| 契约 | [`contracts/ipc/L10-notes.json`](../../../contracts/ipc/L10-notes.json) |
| 服务草稿 | [`contracts/services/DRAFT-L10-notes.md`](../../../contracts/services/DRAFT-L10-notes.md) |
| 规格 / 测试去向 | [SPEC.md](SPEC.md) · [TESTMAP.md](TESTMAP.md) |

### 拥有的 Rust 文件

| 文件 | 行 | 测试 | 命令 |
|---|---|---|---|
| `src-tauri/crates/dstu-notes/build.rs` | 18 | 0 |  |
| `src-tauri/crates/dstu-notes/src/lib.rs` | 23 | 0 |  |
| `src-tauri/crates/dstu-notes/src/notes_exporter.rs` | 4408 | 14 |  |
| `src-tauri/crates/dstu-notes/src/notes_manager.rs` | 2335 | 11 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_columns_tests.rs` | 242 | 4 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_format_repo.rs` | 329 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_history_integration_tests.rs` | 353 | 5 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_history_restore.rs` | 223 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_lease_repo.rs` | 544 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_lease_tests.rs` | 349 | 7 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_relation_repo.rs` | 245 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_repo.rs` | 4365 | 32 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_review_repo.rs` | 121 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_review_tests.rs` | 126 | 2 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_revision_repo.rs` | 534 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_revision_tests.rs` | 421 | 10 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_state_repo.rs` | 175 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_storage_tests.rs` | 553 | 12 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_structure.rs` | 127 | 0 |  |
| `src-tauri/crates/dstu-vfs/src/vfs/repos/note_transfer_repo.rs` | 257 | 0 |  |
| `src-tauri/src/chat_v2/handlers/canvas_handlers.rs` | 63 | 0 | 2 |
| `src-tauri/src/chat_v2/tools/canvas_executor.rs` | 2296 | 11 |  |
| `src-tauri/src/chat_v2/tools/notes_import_executor.rs` | 224 | 2 |  |
| `src-tauri/src/chat_v2/tools/user_todo_executor.rs` | 1842 | 9 |  |
| `src-tauri/src/cmd/notes.rs` | 3498 | 14 | 79 |
| `src-tauri/src/notes_app_tests.rs` | 163 | 2 |  |

### 命令（81）

| 命令 | Rust | async | 前端 | 前端调用点 | 契约（参数 → 结果 ! 错误） |
|---|---|---|---|---|---|
| `canvas_note_append` | `src/cmd/notes.rs:1385` | async | app | src/utils/notesApi.ts:375 | (subject?: string \| null, noteId: string, content: string, section?: string \| null) → null ! AppError |
| `canvas_note_read` | `src/cmd/notes.rs:1363` | async | app | src/utils/notesApi.ts:361 | (subject?: string \| null, noteId: string, section?: string \| null) → string ! AppError |
| `canvas_note_replace` | `src/cmd/notes.rs:1410` | async | app | src/utils/notesApi.ts:392 | (subject?: string \| null, noteId: string, search: string, replace: string, isRegex?: boolean \| null) → integer(u32) ! AppError |
| `canvas_note_set` | `src/cmd/notes.rs:1437` | async | app | src/utils/notesApi.ts:404 | (subject?: string \| null, noteId: string, content: string) → null ! AppError |
| `chat_v2_canvas_edit_ack` | `src/chat_v2/handlers/canvas_handlers.rs:49` | sync | app | src/features/notes/aiReview.ts:222<br>src/features/notes/hooks/useCanvasAIEditHandler.ts:394<br>src/features/notes/hooks/useCanvasAIEditHandler.ts:448 | (requestId: string) → null ! string |
| `chat_v2_canvas_edit_result` | `src/chat_v2/handlers/canvas_handlers.rs:28` | sync | app | src/features/notes/aiReview.ts:29<br>src/features/notes/hooks/useCanvasAIEditHandler.ts:147<br>src/features/notes/hooks/useCanvasAIEditHandler.ts:522 | (result: CanvasAIEditResult) → null ! string |
| `notes_assets_bulk_delete` | `src/cmd/notes.rs:2167` | async | app | src/utils/notesApi.ts:290 | (paths: string[]) → integer(usize) ! AppError |
| `notes_assets_index_scan` | `src/cmd/notes.rs:1972` | async | app | src/utils/notesApi.ts:284 | (subject?: string \| null, noteId: string) → integer(usize) ! AppError |
| `notes_assets_scan_orphans` | `src/cmd/notes.rs:2004` | async | app | src/utils/notesApi.ts:287 | (subject?: string \| null) → string[] ! AppError |
| `notes_create` | `src/cmd/notes.rs:1206` | async | none | — | (subject?: string \| null, note: NewNotePayload) → NoteItem ! AppError |
| `notes_db_stats` | `src/cmd/notes.rs:2960` | async | app | src/utils/notesApi.ts:229 | (（无）) → NotesDbStats ! AppError |
| `notes_db_vacuum` | `src/cmd/notes.rs:3020` | async | app | src/utils/notesApi.ts:232 | (（无）) → boolean ! AppError |
| `notes_delete` | `src/cmd/notes.rs:1342` | async | none | — | (subject?: string \| null, id: string) → boolean ! AppError |
| `notes_delete_asset` | `src/cmd/notes.rs:1898` | async | app | src/utils/notesApi.ts:201 | (relativePath: string) → boolean ! AppError |
| `notes_editor_begin` | `src/cmd/notes.rs:397` | async | app | src/features/notes/noteHostCoordinator.ts:215 | (participantId: string, operationId: string, noteIds: string[]) → LeaseStatus ! AppError |
| `notes_editor_finish` | `src/cmd/notes.rs:478` | async | app | src/features/notes/noteHostCoordinator.ts:247 | (lease: NoteLeaseAuth) → LeaseStatus ! AppError |
| `notes_editor_flush` | `src/cmd/notes.rs:457` | async | none | — | (lease: NoteLeaseAuth, noteId: string, capabilities?: string[] \| null) → LeaseNote ! AppError |
| `notes_editor_freeze_ack` | `src/cmd/notes.rs:428` | async | app | src/features/notes/noteHostCoordinator.ts:242 | (lease: NoteLeaseAuth, draft: FrozenDraft) → LeaseStatus ! AppError |
| `notes_editor_heartbeat` | `src/cmd/notes.rs:368` | async | app | src/features/notes/noteHostCoordinator.ts:67 | (participantId: string) → ParticipantStatus ! AppError |
| `notes_editor_lease_status` | `src/cmd/notes.rs:421` | async | app | src/features/notes/noteHostCoordinator.ts:223<br>src/features/notes/noteHostCoordinator.ts:250<br>src/features/notes/noteHostCoordinator.ts:254 | (token: string) → LeaseStatus \| null ! AppError |
| `notes_editor_refresh_ack` | `src/cmd/notes.rs:493` | async | app | src/features/notes/noteHostCoordinator.ts:296 | (lease: NoteLeaseAuth, updatedAt: string) → LeaseStatus ! AppError |
| `notes_editor_register` | `src/cmd/notes.rs:350` | async | app | src/features/notes/noteHostCoordinator.ts:60 | (noteId: string) → ParticipantStatus ! AppError |
| `notes_editor_release` | `src/cmd/notes.rs:509` | async | app | src/features/notes/noteHostCoordinator.ts:139<br>src/features/notes/noteHostCoordinator.ts:229<br>src/features/notes/noteHostCoordinator.ts:257 | (lease: NoteLeaseAuth, cancel: boolean) → LeaseCancellation ! AppError |
| `notes_editor_unregister` | `src/cmd/notes.rs:380` | async | app | src/features/notes/noteHostCoordinator.ts:62<br>src/features/notes/noteHostCoordinator.ts:85 | (participantId: string) → LeaseCancellation[] ! AppError |
| `notes_empty_trash` | `src/cmd/notes.rs:1595` | async | app | src/utils/notesApi.ts:263 | (subject?: string \| null) → integer(usize) ! AppError |
| `notes_enable_columns` | `src/cmd/notes.rs:628` | async | app | src/features/notes/noteEditorHost.ts:144 | (noteId: string, expectedUpdatedAt: string, lease?: NoteLeaseAuth \| null) → NoteFormatStatus ! AppError |
| `notes_export` | `src/cmd/notes.rs:2363` | async | app | src/utils/notesApi.ts:304 | (request: NotesExportCommandRequest) → NotesExportCommandResponse ! AppError |
| `notes_export_single` | `src/cmd/notes.rs:2447` | async | app | src/utils/notesApi.ts:325 | (request: NotesExportSingleCommandRequest) → NotesExportCommandResponse ! AppError |
| `notes_get` | `src/cmd/notes.rs:1327` | async | none | — | (subject?: string \| null, id: string) → NoteItem ! AppError |
| `notes_get_backlinks` | `src/cmd/notes.rs:3384` | async | none | — | (subject?: string \| null, noteId: string) → NoteBacklink[] ! AppError |
| `notes_get_format` | `src/cmd/notes.rs:595` | async | app | src/features/notes/noteEditorHost.ts:46 | (noteId: string) → NoteFormatStatus ! AppError |
| `notes_get_outgoing_links` | `src/cmd/notes.rs:3403` | async | none | — | (subject?: string \| null, noteId: string) → NoteOutgoingLink[] ! AppError |
| `notes_get_pref` | `src/cmd/notes.rs:2326` | async | app | src/features/notes/NotesContext.tsx:474<br>src/utils/notesApi.ts:215 | (key: string) → string \| null ! AppError |
| `notes_get_subject_rag_config` | `src/cmd/notes.rs:2230` | async | none | — | (subject: string) → NotesSubjectRagConfig ! AppError |
| `notes_hard_delete` | `src/cmd/notes.rs:1462` | async | app | src/utils/notesApi.ts:266 | (subject?: string \| null, id: string) → boolean ! AppError |
| `notes_history_current` | `src/cmd/notes.rs:926` | async | app | src/utils/notesApi.ts:163 | (noteId: string) → NoteHistoryCurrent ! AppError |
| `notes_history_get` | `src/cmd/notes.rs:1032` | async | app | src/utils/notesApi.ts:148 | (noteId: string, versionId: string) → NoteRevision ! AppError |
| `notes_history_get_retention` | `src/cmd/notes.rs:934` | async | app | src/utils/notesApi.ts:171 | (（无）) → NoteHistoryRetention ! AppError |
| `notes_history_list` | `src/cmd/notes.rs:1002` | async | app | src/utils/notesApi.ts:144 | (noteId: string, cursor?: integer(i64) \| null, limit?: integer(u32) \| null, pinnedOnly?: boolean \| null) → NoteHistoryPage ! AppError |
| `notes_history_restore_copy` | `src/cmd/notes.rs:1077` | async | app | src/utils/notesApi.ts:160 | (noteId: string, versionId: string) → DstuNode ! AppError |
| `notes_history_restore_current` | `src/cmd/notes.rs:972` | async | app | src/utils/notesApi.ts:168 | (noteId: string, versionId: string, expectedUpdatedAt: string, selection?: NoteHistorySelection \| null, lease?: NoteLeaseAuth \| null) → DstuNode ! AppError |
| `notes_history_restore_selection_copy` | `src/cmd/notes.rs:952` | async | app | src/utils/notesApi.ts:159 | (noteId: string, versionId: string, selection: NoteHistorySelection) → DstuNode ! AppError |
| `notes_history_set_pinned` | `src/cmd/notes.rs:1054` | async | app | src/utils/notesApi.ts:152 | (noteId: string, versionId: string, pinned: boolean) → NoteRevisionSummary ! AppError |
| `notes_history_set_retention` | `src/cmd/notes.rs:941` | async | app | src/utils/notesApi.ts:174 | (policy: NoteHistoryRetention__De) → NoteHistoryRetention ! AppError |
| `notes_import` | `src/cmd/notes.rs:2544` | async | app | src/utils/notesApi.ts:341 | (request: NotesImportCommandRequest) → NotesImportCommandResponse ! AppError |
| `notes_import_markdown` | `src/cmd/notes.rs:2668` | async | app | src/dstu/adapters/notesDstuAdapter.ts:225 | (request: NotesImportMarkdownRequest) → DstuNode ! AppError |
| `notes_import_markdown_batch` | `src/cmd/notes.rs:2722` | async | app | src/dstu/adapters/notesDstuAdapter.ts:248 | (request: NotesImportMarkdownBatchRequest) → NotesImportMarkdownBatchResponse ! AppError |
| `notes_invalidate_resource_refs` | `src/cmd/notes.rs:914` | async | none | — | (resourceId: string) → integer(usize) ! AppError |
| `notes_list` | `src/cmd/notes.rs:1110` | async | none | — | (subject?: string \| null, limit?: integer(u32) \| null, offset?: integer(u32) \| null) → NoteItem[] ! AppError |
| `notes_list_advanced` | `src/cmd/notes.rs:1162` | async | none | — | (subject?: string \| null, options: NotesListAdvancedOptions) → NotesListAdvancedResponse ! AppError |
| `notes_list_assets` | `src/cmd/notes.rs:1879` | async | app | src/utils/notesApi.ts:193 | (subject?: string \| null, noteId: string) → Value[] ! AppError |
| `notes_list_deleted` | `src/cmd/notes.rs:1782` | async | app | src/utils/notesApi.ts:260 | (subject?: string \| null, page?: integer(i64) \| null, pageSize?: integer(i64) \| null) → NotesListAdvancedResponse ! AppError |
| `notes_list_meta` | `src/cmd/notes.rs:1128` | async | none | — | (subject?: string \| null) → NoteItem[] ! AppError |
| `notes_list_referencing_resource` | `src/cmd/notes.rs:835` | async | app | src/features/pdf/components/PdfRelatedPanel.tsx:28 | (resourceIds: string[]) → NoteReferencingResource[] ! AppError |
| `notes_list_tags` | `src/cmd/notes.rs:3040` | async | app | src/utils/notesApi.ts:236 | (subject?: string \| null) → string[] ! AppError |
| `notes_mentions_search` | `src/cmd/notes.rs:3202` | async | app | src/utils/notesApi.ts:278 | (subject?: string \| null, keyword: string, limit?: integer(u32) \| null) → NotesMentionSearchResponse ! AppError |
| `notes_migrate_blocks` | `src/cmd/notes.rs:677` | async | none | — | (noteId: string, expectedUpdatedAt: string, content: string, lease?: NoteLeaseAuth \| null) → VfsNote ! AppError |
| `notes_rag_rebuild_fts_index` | `src/cmd/notes.rs:2212` | async | none | — | (（无）) → integer(usize) ! AppError |
| `notes_rebuild_links` | `src/cmd/notes.rs:3435` | async | none | — | (subject?: string \| null, batchSize?: integer(u32) \| null) → NotesRebuildLinksResponse ! AppError |
| `notes_reference_status` | `src/cmd/notes.rs:899` | async | app | src/features/notes/noteRelations.ts:49 | (resourceId: string, locator: NoteLocator__De) → NoteReferenceStatus ! AppError |
| `notes_relation_delete` | `src/cmd/notes.rs:888` | async | app | src/features/notes/noteRelations.ts:45 | (id: string, expectedRevision: integer(i64)) → boolean ! AppError |
| `notes_relation_get` | `src/cmd/notes.rs:730` | async | none | — | (id: string) → NoteRelation \| null ! AppError |
| `notes_relation_list` | `src/cmd/notes.rs:744` | async | app | src/features/notes/noteRelations.ts:38 | (noteId: string) → NoteRelation[] ! AppError |
| `notes_relation_put` | `src/cmd/notes.rs:874` | async | app | src/features/notes/noteRelations.ts:40 | (request: NoteRelationPut) → NoteRelation ! AppError |
| `notes_resolve_asset_path` | `src/cmd/notes.rs:1926` | async | app | src/utils/notesApi.ts:206 | (relativePath: string) → string ! AppError |
| `notes_restore` | `src/cmd/notes.rs:1836` | async | app | src/utils/notesApi.ts:269 | (subject?: string \| null, id: string) → boolean ! AppError |
| `notes_review_save_as` | `src/cmd/notes.rs:648` | async | app | src/features/notes/noteReviewHost.ts:92 | (operationId: string, sourceNoteId: string, markdown: string, expectedUpdatedAt?: string \| null, capabilities?: string[] \| null, lease?: NoteLeaseAuth \| null) → ReviewSaveResult ! AppError |
| `notes_save_asset` | `src/cmd/notes.rs:1858` | async | app | src/components/crepe/features/imageUpload.ts:161<br>src/features/media-handout/api.ts:63<br>src/utils/notesApi.ts:182 | (subject?: string \| null, noteId: string, base64Data: string, defaultExt?: string \| null) → Value ! AppError |
| `notes_search` | `src/cmd/notes.rs:3129` | async | app | src/utils/notesApi.ts:252 | (subject?: string \| null, keyword: string, limit?: integer(i64) \| null) → NotesSearchHit[] ! AppError |
| `notes_set_favorite` | `src/cmd/notes.rs:1310` | async | none | — | (subject?: string \| null, id: string, favorite: boolean) → NoteItem ! AppError |
| `notes_set_pref` | `src/cmd/notes.rs:2313` | async | app | src/features/notes/NotesContext.tsx:1407<br>src/utils/notesApi.ts:212 | (key: string, value: string) → boolean ! AppError |
| `notes_state_delete` | `src/cmd/notes.rs:720` | async | app | src/features/notes/aiReviewPersistence.ts:34<br>src/features/notes/noteDraftPersistence.ts:52 | (request: NoteStateDelete) → NoteState ! AppError |
| `notes_state_get` | `src/cmd/notes.rs:696` | async | app | src/features/notes/aiReviewPersistence.ts:26 | (request: NoteStateKey) → NoteState \| null ! AppError |
| `notes_state_list` | `src/cmd/notes.rs:703` | async | app | src/features/notes/aiReviewPersistence.ts:29<br>src/features/notes/noteDraftPersistence.ts:37 | (request: NoteStateList) → NoteState[] ! AppError |
| `notes_state_put` | `src/cmd/notes.rs:710` | async | app | src/features/notes/aiReviewPersistence.ts:31<br>src/features/notes/noteDraftPersistence.ts:26 | (request: NoteStatePut) → NoteState ! AppError |
| `notes_transfer_blocks` | `src/cmd/notes.rs:556` | async | none | — | (request: TransferBlocksRequest, lease?: NoteLeaseAuth \| null) → TransferResult ! AppError |
| `notes_undo_transfer` | `src/cmd/notes.rs:572` | async | none | — | (operationId: string, expectedSourceUpdatedAt: string, expectedTargetUpdatedAt: string, lease?: NoteLeaseAuth \| null) → TransferResult ! AppError |
| `notes_unlinked_mentions` | `src/cmd/notes.rs:3469` | async | none | — | (subject?: string \| null, noteId: string, limit?: integer(u32) \| null) → NotesSearchHit[] ! AppError |
| `notes_update` | `src/cmd/notes.rs:1245` | async | app | src/features/learning-hub/apps/views/NoteContentView.tsx:602<br>src/features/notes/NotesCrepeEditor.tsx:857<br>src/features/notes/noteEditorHost.ts:30 | (subject?: string \| null, note: UpdateNotePayload, lease?: NoteLeaseAuth \| null) → NoteItem ! AppError |
| `notes_update_subject_rag_config` | `src/cmd/notes.rs:2260` | async | none | — | (subject: string, cfg: NotesSubjectRagConfig__De) → boolean ! AppError |
| `rag_rebuild_fts_index` | `src/cmd/notes.rs:2203` | async | none | — | (（无）) → integer(usize) ! AppError |

### 发出的事件（9）

| 事件名 | 类型 | 发送点 |
|---|---|---|
| `canvas:ai-edit-request` | 字面量 | src/chat_v2/tools/canvas_executor.rs:1742 (emit) |
| `notes-import-progress` | 字面量 | src/cmd/notes.rs:2580 (emit) |
| `notes:format-changed` | 字面量 | src/cmd/notes.rs:644 (emit)<br>src/cmd/notes.rs:691 (emit) |
| `notes:lease-changed` | 字面量 | src/cmd/notes.rs:364 (emit)<br>src/cmd/notes.rs:418 (emit)<br>src/cmd/notes.rs:454 (emit)<br>src/cmd/notes.rs:490 (emit)<br>src/cmd/notes.rs:506 (emit) |
| `notes:lease-ended` | 字面量 | src/cmd/notes.rs:393 (emit)<br>src/cmd/notes.rs:448 (emit)<br>src/cmd/notes.rs:522 (emit)<br>src/cmd/notes.rs:548 (emit) |
| `notes:review-saved` | 字面量 | src/cmd/notes.rs:673 (emit) |
| `notes:state-changed` | 字面量 | src/cmd/notes.rs:717 (emit)<br>src/cmd/notes.rs:727 (emit) |
| `notes:transfer-completed` | 字面量 | src/cmd/notes.rs:568 (emit)<br>src/cmd/notes.rs:591 (emit) |
| `todo://changed` | 字面量 | src/chat_v2/tools/user_todo_executor.rs:274 (emit) |

### 契约中的事件（9，`contracts/ipc/L10-notes.json`）

| 事件名 | 动态名 | 载荷 | 发送点 |
|---|---|---|---|
| `todo://changed` | 否 | object \| object \| object | src/chat_v2/tools/user_todo_executor.rs:274 (emit) |
| `canvas:ai-edit-request` | 否 | CanvasAIEditRequest | src/chat_v2/tools/canvas_executor.rs:1742 (emit) |
| `notes-import-progress` | 否 | dstu_notes__notes_exporter__ImportProgress | src/cmd/notes.rs:2580 (emit) |
| `notes:format-changed` | 否 | NoteFormatStatus \| VfsNote | src/cmd/notes.rs:644 (emit)<br>src/cmd/notes.rs:691 (emit) |
| `notes:lease-changed` | 否 | LeaseStatus | src/cmd/notes.rs:364 (emit)<br>src/cmd/notes.rs:418 (emit)<br>src/cmd/notes.rs:454 (emit)<br>src/cmd/notes.rs:490 (emit)<br>src/cmd/notes.rs:506 (emit) |
| `notes:lease-ended` | 否 | LeaseCancellation \| UNRESOLVED(payload type of `event` not determinable statically) | src/cmd/notes.rs:393 (emit)<br>src/cmd/notes.rs:448 (emit)<br>src/cmd/notes.rs:522 (emit)<br>src/cmd/notes.rs:548 (emit) |
| `notes:review-saved` | 否 | ReviewSaveResult | src/cmd/notes.rs:673 (emit) |
| `notes:state-changed` | 否 | NoteState | src/cmd/notes.rs:717 (emit)<br>src/cmd/notes.rs:727 (emit) |
| `notes:transfer-completed` | 否 | TransferResult | src/cmd/notes.rs:568 (emit)<br>src/cmd/notes.rs:591 (emit) |
<!-- END GENERATED:lane -->

## 备注

- 已发布 `api.ts`：同步 `notes` 仓储类型（默认 VFS 连接；可传同一事务的 `SqlExecutor`），历史/格式/状态接口；`apply` 内以 `notes` 服务名注册，并导出 `notesService = { name: 'notes', version: '1.0.0' }`（ARCHITECTURE.md 附录 A）。
- 跨插件接线（ARCHITECTURE.md 附录 A）：依赖 L11 资源/索引/文件夹仓储的点改为 `inject: ['storage', 'vfsRepo']` 并经 `ctx.get('vfsRepo')` 调用真实服务；L11 当前仍提供旧名 `vfs.repo.core@1`，待其按附录 A 更名后本插件才能在生产 profile 启动（待接线：`vfsRepo`）。
- 工具执行器接线：`src/canvas-tool.ts` / `src/user-todo-tool.ts` / `src/notes-import-tool.ts` 已由 `index.ts` 实例化，随 `notes.tools` 暴露，并在 L07 `agentTools` 可用后通过 `registerToolExecutors` 注册（含晚注入路径）；`tests/agent-tools-registration.test.ts` 从真实 `notes` 插件入口断言三名执行器与首个 `canHandle` 派发。L04 的 `ToolExecutorRegistry` 目前只在 `ds-mig/L04-chat-session`，未合入 `main`，因此真实聊天派发仍未验证。
- 服务更名过渡：运行时只 `provide('notes')`；`api.ts` 额外保留 `@deprecated` 的 `'notes@1'` **类型键**（不提供旧服务），用于 L17-memory / L13b-vfs-handlers 尚未更名的旧注入声明通过 typecheck。待这些消费方迁移后删除该类型别名。
- F5 契约阻塞已由 foundation 修复：`NoteStatePut/Delete` 现为扁平 schema，`notes_state_put/delete` 可直接接收 `value/expected_revision`；`tests/state.test.ts` 增加扁平请求的正向覆盖。
- `user_todo_executor.rs::mfjs_schema_tests::mfjs_normalizes_real_rust_builtin_tool_schemas` 已按 Rust 移植并使用本 lane 真实 `get_user_todo_schemas()`（`src/user-todo-schemas.ts`）；测试内的 MFJS 规范化替身只覆盖 L02 尚未经 `llm/api.ts` 发布的子集。TESTMAP 现为 135 行全部 `ported`、0 `pending`。
- 跨 lane 缺口：`chat_v2_canvas_edit_ack/result` 的 pending 注册表暂无 chat executor 消费方；`notes_import`/`user_todo`/`canvas` 执行器已实现并注册到 L07 `agentTools`，但 L04 的消费端 `ToolExecutorRegistry` 仍未合入 `main`（见 `host/plugins/chat/TESTMAP.md` 中 `executor_registry.rs` 行）。Canvas 的 ACR 委托已按 L07 `acrBridgeCall` 实现；前端桥可达性仍未证实，相关前端测试保持 `pending`。
- 根目录没有 `AGENTS.md`（glob 也未找到）；遵守注入的全局纪律及 foundation 规则。
- X2 复核（2026-11-04）：`notes_list_deleted` 的真实前端调用仍传 `page_size`（src/utils/notesApi.ts:260），而契约/Host 键是 `pageSize`，经真实入口只验证了 `pageSize` 分支（tests/notes-commands.test.ts:250）；前端未改，属 X2 待修。`notes_save_asset` 的 `imageUpload.ts:161` 同时传 snake_case 与 camelCase 别名，契约键为 `noteId/base64Data/defaultExt`，多传键被忽略、功能不受影响（X2 仍标 redundant-alias）。`canvas:ai-edit-request` 载荷已由 `buildCanvasAIEditRequest` 按契约验证；Rust 该 emitter 仅保留 suggestion 路径且 `execute` 不再调用，Host 因此不发送该事件（X2 的 payload-mismatch/emitter-unproven 不构成运行时缺陷）。X2 08:06 定向复核把 `CanvasAIEditRequest` 的 5 条 omit payload-mismatch 定为 X2 `compareShapes` source 侧误报并已由 X2 扫描器修复，不是 F5 契约收窄，也无需 L10 改 Host/契约。
- 抽检整改（2026-11-04）：`repository/revisions.ts` 与 `relations.ts` 的 `tags_json`/`asset_refs_json`/`locator_json` 改为 `decodeJson`（serde 兼容消息）+ 形状校验，失败映射 `Serialization error: …`；`repository/transfer.ts` 的 `asset_refs_json` 修正为 `{kind,value}` 对象数组（此前误写字符串，导致资产引用漏计）；`notes_history_list/get/set_pinned/restore_copy` 按 Rust 手工 `AppError::database(Display)` 映射；`notes_set_favorite` 的两段错误前缀拆分；dstu watch 事件同时发送 `dstu:change:<path>` 与 `dstu:change`，并经 `emitTo(Window)` 限定调用窗口；`notes_import` 进度事件同样限定窗口。
- F4 集成已完成：删除 `repository/time.ts`，统一改用 `host/platform/time`（`now`/`toRfc3339`/`toRfc3339Opts`/`nowEpochNanos`，同一时刻只采样一次）；生产代码的 `trim`/字符计数/UTF-8 字节数/字符截断统一改用 `host/platform/util`（`rustTrim*`/`charCount`/`utf8ByteLength`/`takeChars`），并修复 optional-chain 语义（`assets`/`import`/`exporter`/`notes` 的 `?.trim()` 分支）。
- F7 集成已完成：`canvas_note_replace` 的 `isRegex=true` 经 `Context.nativeRegex` 取 F7 `regex` crate wasm 引擎，用 `compile`/`findIter().length`/`replaceAll`；`index.ts` 以惰性解析器注入命令与 `CanvasToolExecutor`，profile 可替换引擎，生产源码不再直接导入平台正则实现；编译失败映射 `Validation: 无效的正则表达式: <regex::Error Display>`，缺失引擎显式报错而不回退 JS RegExp。`tests/markdown.test.ts` 的 `test_regex_replace` 在组合根注入真实 wasm 引擎。
- D1 删除同事务接缝（更新）：`NoteRepository` 已公开 `purgeNoteWithConn(conn,id)` 与 `purgeDeletedNotesWithConn(conn)`。N3 候选 `2b7786b43` 已移除 raw 适配，hardDelete/emptyTrash 按原 SAVEPOINT 在同一 SqlExecutor 上 purge+prepare，RELEASE 成功后 finish；不改成 IMMEDIATE 事务。main `80dcc5291` 的 F3 注册面已到达，本候选将现有 journal SQL owner 与 retention 的 Disposer 绑定插件 scope。Lance、N5 及 F3 SQL 委托消费仍分别复验，不以连接/注册接口存在替代业务闭环。
- D2 删除许可（2026-11-04，L21 已合入 `main`）：`notes_hard_delete` / `notes_empty_trash` / `notes_delete_asset` / `notes_assets_bulk_delete` 经 `withDeletePropagation` 从 L21 唯一 `governance.tryAcquireOperationGuard('delete_propagation')` 取得 guard（立即 try，非等待型 `acquireOperation`），并在 `finally` 释放（失败路径同样释放），未新建本地锁、未解析错误文案。L21 的 `OperationGuardError` 以 `CommandError` 携带 Rust 同形 AppError value 原样传播：busy→Validation、lock_io→FileSystem；缺 provider 时命令以 Configuration 明确拒绝。测试用同形状 provider 与真实 `OperationGuardError` 断言 acquire/release 及两类业务错误经真实命令入口 settle。
- 删除剩余缺口：Lance `delete_resource_index_full`、N5 的剩余单写者面和 F3 对已注册 SQL owner 的实际委托仍未整体闭合。F3 SqlExecutor / 注册 / 公共 worker 接口均已进 main，不再称其尚未发布；L21 许可入口也已可用。
- 第二轮自查（2026-11-04）：`notes_export` 的 README 导出时间改为 chrono UTC 文本并补齐 `## 跨软件兼容性`；`_versions/documents.json` 省略空 `notes`/`revisions` 并加单文档 64 MiB 上限；偏好按 Rust `BTreeMap`（UTF-8 字节序）排序；`sanitize_filename` 改为 UTF-8 100 字节截断并用 `isRustWhitespace`；DSTU `parse_timestamp` 补齐纯数字时间戳、SQLite 小数秒与解析失败 warn 回退；导出收集错误的 VfsError Display 前缀与历史版本桶 `trunc` 对齐 Rust。
- 同步/格式/属性公开面（2026-11-04）：`notes.format.blocks(content)` 直接复用 `src/structure.ts` 的根 Markdown 解析并原样抛出解析错误；`notes.sync.prepareRelation/retargetNoteRelations/applyRevision` 覆盖 `note_history.rs` 的关系 CAS、目标块失效、不可变版本校验与 pin 仅升；`notes.sync.updateInferredFormat` 在正文推断格式变化时保留 `ds-columns-v1` 能力并清空 `updated_at`。`api.ts` 另公开 `isOperatorSearchableKey/parsePropsCell/malformedPropsTotal/snippet`，均由现有 `repository/props.ts` 单一实现导出，不新建计数器。L20/L13 的消费方删除各自重复实现不在本 lane 权限内。
- D3 同步精度（2026-11-04）：`notes.sync.prepareRelation` 的 relation revision 与 `applyRevision` 的本地历史行改用 F3 `defineQuery(..., safeIntegers: true)`，i64 不经过 Number；`*_json` 比较使用 L20 `sync/api.ts` 导出的 `parseJsonLossless`/`dbJsonEquals`，嵌套 `DbJson` 写入使用 `stringifyJsonLossless`，未在 L10 复制第二套 parser；只 import `sync/api.ts` 的纯函数，不新增 `inject`，`sync` 仍单向消费 `notes`。`9007199254740992` 与 `9007199254740993` 不再被判相等；新增 `notes.sync` 真实入口回归：大 revision 精确 +1、不可变 props_json 重排相等/不同大整数冲突、调用方事务回滚。
- 门禁统计（`migration:ledger -- --check --no-write`）：本 lane 命令 81（A 81，100%），测试 135（A 135，100%，0 pending）；`npx tsc -p tsconfig.host.json`、Node `host/plugins/notes`（25 文件 / 215 用例）与 Electron（25 文件 / 215 用例）均通过；`migration:boundaries` 本 lane 0 违规；全局 `migration:scaffold:check`/`boundaries:strict` 仍因其他 lane 漂移退出 1。
- 执行器实现（2026-11-04 续作）：`UserTodoExecutor` 14 个工具、`NotesImportExecutor.execute` 与 `CanvasToolExecutor.execute` 已按 Rust 迁移；`NotesService.tools` 暴露三者并经 L07 `agentTools` 注册。`CanvasToolExecutor` 覆盖 read/list/search/create/delete/update_tags/write_backend，写入走 `probe → apply_ops`（L07 `acrBridgeCall`/超时/不确定回执）或 OCC 后端 CAS；ACR 事件适配器 `src/canvas-bridge.ts` 把 kernel `BackendEvents.listenWindow(window, event, receive): disposer` 映射为 L07 `BridgeEventBus`：response 与 progress 都按调用窗口定向订阅，进度原样转工具 chunk，结束时释放两个 disposer；不再使用 app 级 `acr:bridge-response` 广播，也不再丢弃进度。调用窗口由 `executionWindow(ctx)` 读取 `ExecutionContext.tryWindow()`；L04 候选已在 `host/plugins/chat/api.ts:143` 与 `host/plugins/chat/src/execution-context.ts:70` 实现该字段，但候选尚未合入 `main`，因此正式 ACR 消费待 L04 候选合入，不是提供方未发布。F1 target 语义已随 `main 902d86ee3` 合入（`listenWindow` 按 Tauri EventTarget 路由）；`tests/canvas-bridge-kernel.test.ts` 用正式 `BackendEvents`（`createTestHost`）验证请求定向调用窗口、广播响应可达、其他窗口目标不泄漏、终止/取消后 disposer 清理；原 fake 测试仍覆盖桥接形状。补充测试 `tests/canvas-execute.test.ts`（11）、`tests/agent-tools-registration.test.ts`（1）、`tests/user-todo-execute.test.ts`（10）与 `tests/notes-import-execute.test.ts`（8）。前端 ACR 桥可达性仍未证实，相关既有前端测试保持 `pending`；`CanvasToolExecutor.search` 与 Rust 一致：`canvas_executor.rs::execute_search` 在 VFS 模式下经 `notes_manager.rs:618-632` 短路到 `search_notes_vfs`，后者（`:717-737`）调用 `VfsNoteRepo::search_notes_with_snippets`，即 FTS5 bm25 优先、LIKE 兜底；Host 复用同一仓储方法，保留 `page/page_size`（1..20，默认 10）、`search_limit`（`page*page_size+1`，上限 201）、`folder_id` 成员过滤、2,000 字符摘要截断与 `搜索笔记失败: …` 错误前缀。此处不是“缺 Lance 所以改 FTS”。

## 历史状态（2026-11-04T09:20Z；后续 v2 记录优先）

### 已完成与门禁

- 基线：`main 081b3426d`（F1 target：`902d86ee3`）；本分支已 merge main（`b1e21a331`）。
- 命令 81/81 A；测试 135/135 A、0 pending（`migration/ledger.json` 按 lane 过滤复核）。
- `migration:wiring -- --lane notes`：ported 135，未从 `index.ts` 接入 0。
- `tsc -p tsconfig.host.json` 退出码 0；上一轮 `vitest run -c vitest.host.config.ts host/plugins/notes` 25 文件 / 215 用例全过（经作业队列）。本轮按指令不重跑 215，仅跑 `tests/canvas-bridge.test.ts` + `tests/canvas-bridge-kernel.test.ts`：2 文件 / 7 用例全过，退出码 0。
- `migration:boundaries:strict` 本 lane 0 违规；全局 4 条分别属 sync/translation/vfs-repos，非本 lane。
- 无 `ACCEPTANCE.md`、无 `BLOCKERS.md`。复核项：X2-R02/R03/R04/R05 已逐项处置（R02 前端冗余别名、R03 前端 `page_size` 键名、R04 omit 为 X2 扫描器误报、R05 HEIC 属 Host 接线/二进制边界，均无需 L10 改契约/前端）；C1 曾指出的 ACR 丢弃进度/广播响应已由 `6c4916dcb` 修掉。
- R4 `43d0fc773` 的四个 JSON 反例针对 `sync-support` 自有 `jsonFieldEquals`/`computeDataHash`；其中第 4 条经公开 `noteHistory.applyRevision` 的 `9007199254740992`/`9007199254740993` 不可变冲突，本 lane 已在 `3cb9e7770` 用 L20 `parseJsonLossless`/`dbJsonEquals` 修复，并由 `tests/note-sync.test.ts::apply_revision preserves large JSON integers and rolls back caller transactions` 经真实仓储入口覆盖（本轮 215 用例内通过）。若 R4 另有针对 L10 的新反例，需给出输入与期望。

### 真实跨 lane 阻塞（均在 main 复核，不是本 lane 自有代码）

1. **F3 SqlExecutor journal（旧阻塞已解除）**：连接面由 `526512c2c` 到达，L10 `2b7786b43` 已移除 raw 适配并保持原 SAVEPOINT；注册/公共 worker 面由 main `80dcc5291` 到达，本候选最小消费见下方 F3 章节。此项不再作为等待提供方发布的理由。
2. **L04 运行时 tryWindow**：main `host/plugins/chat/api.ts:82` 仅有接口声明，`host/plugins/chat/src/execution-context.ts` 在 main 不存在（候选 `ds-mig/L04-chat-session a10d72024` 的 `:70` 才实现；main 只有 `src/events.ts:698` 的 emitter 版本）。ACR 真实窗口派发无法在 main 端到端验证，保留 fake ExecutionContext 单测。
3. **Lance 硬删除**：`delete_resource_index_full` 仍无 Host 公开面，`notes_hard_delete` 目前只清 SQLite 元数据/资源行。

已解除：F1 target 已由 `main 902d86ee3` 合入（`listenWindow` 按 Tauri EventTarget 路由）；本 lane 新增 `tests/canvas-bridge-kernel.test.ts`，用正式 `BackendEvents`（`createTestHost`）验证 ACR 请求只发往调用窗口、广播响应可达、其他窗口目标不泄漏、终止/取消后 disposer 清理。完整聊天 ACR 仍需 L04 运行时 `tryWindow`，不以 fake ExecutionContext 签收。

### 下一步（依赖到达后按序，未到达前不改代码）

1. F3 候选入 main：`hardDelete`/`emptyTrash` 改用 `conn.transaction(tx => purge + prepare)` 并传 `SqlExecutor`，删除 raw 适配器；仅在有真实消费方时公开业务 `*WithConn`。
2. L04 候选入 main：以真实 `ExecutionContext` 跑 ACR 端到端（窗口/token/进度/取消）。
3. Lance 公开面到达后接硬删除索引清理。
4. 以上依赖未到前不重复全量门禁，不猜改。

## v2 接手盘点（2026-11-04，新会话）

基线 `main 2ee9a9cbe`；保留 `0cb5a238e` 的正式 BackendEvents 证据，不重做 215 用例。旧账本 A=100% 仅是旧机械指标，**不是 v2 验收结论**。本目录尚无独立 `ACCEPTANCE.md`；不得自行签收。以下为源码自查，未逐分支完成的模块不以“无问题”代替未验证。

| 命令/服务模块（命令全集见上方逐条清单） | v2 问题类型与结论 | 证据（本目录路径省略前缀） |
|---|---|---|
| 全部 81 命令；`notes` 服务 | §1.1 接线可达；§1.8 无独立签收。注册不等于语义完成 | `index.ts:63-91,140-149,194-645`；`SPEC.md:16-24` 全局清单仍空 |
| CRUD/收藏/软删/恢复、`notes.repository` | **L10-V2-01 §1.2**：仍直接写 L11 的 resources/folder_items/vfs_index_units/vfs_indexing_config，已有 createOrReuse/markPending 接缝不能覆盖这些写入；必须请求同连接业务面，不能拆事务 | `repository/notes.ts:385,469,735-739,785,813-830,847,1076`；L11 `types/files.ts:98-124` 缺 source_id 绑定与资源硬删，`types/core.ts:192-233` 缺软删/恢复指定最新 membership |
| list/meta/advanced/deleted/tags/search/backlinks/outgoing/rebuild/unlinked/mentions/stats/vacuum | §1.3/1.4/1.6：存在 JSON fallback、错误 fallback、同步扫描；尚不能称逐分支复核完成 | `repository/notes-manager.ts:43,85`；`repository/notes.ts:580,601,673-683`；`repository/stats.ts:20-58` |
| editor 11 命令、format/migrate、transfer/undo/review | §1.1 仓储生产可达；§1.3 i64 revision 仍需全域精度审查；§1.7 租约墙钟是 Rust 纪元秒，不应机械换单调时钟；失败回滚已有测试，尚未逐条重审 | `index.ts:316-491`；`repository/state.ts:62-63`；`repository/leases.ts:24,77-95`；`tests/note-lease.test.ts` |
| state/relation/reference/referencing | §1.3/1.6：N1 已修 state 的无损值/revision；L10-V2-07 独立修 relation i64 回读/CAS（见下方）。持久化 locator 严格解码、reference 的各分支和历史 seq 精度仍需分别审查，不能用 sync 的 bigint 测试签整个模块 | `repository/relations.ts`；`repository/state.ts`；`repository/revisions.ts` |
| history 10 命令、`notes.revisions` | **L10-V2-03 §1.7/D3**：history 合并策略以 Date.parse 比较纳秒时间，丢掉子毫秒差异；seq 仍 Number。§1.5 原测试需逐 assert 复核 | `repository/revisions.ts:215-220,409-410`；Rust `note_revision_repo.rs:197-207` |
| `notes.sync` | §1.3 大 revision/嵌套 JSON 已用正式 lossless API；§1.2 本模块仅写 note 自有表；§1.5 当前证据有效但不推广到别的仓储 | `repository/sync.ts:75,169,228-263`；`tests/note-sync.test.ts`；既有 `3cb9e7770` |
| canvas_note_*、canvas ACK/result | §1.3 nativeRegex 已接；§1.4 ACK/result 日志和错误 JSON 字符串需逐分支核实；§1.6 SPEC 大部分空白 | `index.ts:494-507,595-615`；`repository/canvas-edits.ts`；`SPEC.md:43-149` |
| save/list/delete/resolve/scan 资产、hard_delete/empty_trash | §1.2/1.7：F3 raw journal 真实阻塞仍在；Lance 硬删仍缺接口。§1.7 同步文件扫描/哈希尚未移出 Host，不能称 v2 完成 | `src/trash-commands.ts:42`；`repository/assets.ts:78-101,223-229`；F3 `file-deletion-queue.ts:131-160` |
| export/export_single/import、Markdown 单/批导入 | §1.3 已有 decodeJson 与档案形状校验，但未全量逐字段重审；§1.7 ZIP、文件读取/写入仍在 Host；§1.5 原断言对应审查未完成 | `repository/import-archive.ts:80-116`；`repository/export-archive.ts:357-431`；`repository/import.ts:39` |
| pref get/set、subject RAG get/update、两个废弃 FTS 命令 | **L10-V2-02 §1.3**：存储配置 JSON.parse 断言 + typeof number 接受小数/越界 i32；**L10-V2-01 §1.2**：直接 UPDATE rag_configurations，公开 owner API 未找到。废弃命令返 0 与 Rust 相符，不是空实现 | `repository/rag-config.ts:38-49,93-99`；Rust `cmd/notes.rs:2222-2257,2290-2308`；`index.ts:554-579` |
| canvas/user_todo/notes_import 三执行器 | **L10-V2-03 §1.7**：Instant.elapsed 误用 Date.now；**L10-V2-04 §1.1/1.4/1.6**：execute 未发 start/end/error、未 save_tool_block，Rust 三者均要求。F1 Agent ExecutionContext 无这些方法，L04 接口有声明但具体实现未 main，需正式适配接口，不造生产替身 | `src/canvas-tool.ts:325-342`；`src/user-todo-tool.ts:596-617`；`src/notes-import-tool.ts:119-138`；Rust 三执行器 `execute`；F1 `agent-api.ts:308-340`；L04 `api.ts:82-91` |
| ACR bridge | §1.1/1.7 target/广播/进度/disposer 最小集已有正式内核测试；L04 完整聊天调用仍 blocked，不以 fake ctx 签收 | `src/canvas-bridge.ts:25-51`；`tests/canvas-bridge-kernel.test.ts`；既有 `0cb5a238e` |
| 存储 JSON 单元格（笔记 tags、todo tags_json/repeat_json） | **L10-V2-06 §1.3**（已修）：`JSON.parse` 接受 serde 拒绝的孤立代理转义；repeat_json 曾接受 `2.0`/`1e0`/重复字段并拒绝序列形式。现统一用 `decodeJson`（+ `parseJsonLossless`）。repeat 规则 owner 为 L11，见 BLOCKERS `B-L11-repeat-rule` | `repository/notes.ts`、`notes-manager.ts`、`mentions.ts`；`src/user-todo-tool.ts`；`tests/v2-boundaries.test.ts` |
| TESTMAP 135 ported | **L10-V2-05 §1.5**：旧登记非 v2 断言审计；`mfjs_normalizes_real_rust_builtin_tool_schemas` 的规范化主体是测试内副本，需要 L02 正式面后才能签该事实。N4 的 L11 SQL 替身已分批替换为真实插件；逐 Rust assert 审计仍独立未闭合 | `tests/user-todo-executor.test.ts`；`TESTMAP.md:166-168`；下方 N4 续项 |

### 已发布给他人的 D1 接缝（v2）

- `notes.blobDeletionJournal?: BlobDeletionJournalRepository`（L11 新 N5 请求；`api.ts` 正式接口，`repository/deletion-journal.ts` 实现并由生产插件 provide）：四个纯同连接方法 `cancelBlobDeletionsForRecreatedBlob`、`insertPreparedBlobDeletion`、`cancelPreparedBlobDeletion`、`markBlobDeletionReady` 对应 Rust `blob_repo.rs:372/656/822/861`。独立可选能力保留旧六方法提供方兼容性；L11 检查一次能力后直接调用，不改旧 resources/folders 接口。方法不读时钟、不扫描、不自开事务、不写 blobs 或 outbox；SQL 错误原样传播、重复 INSERT 不忽略、ready 返回 affected rows。size 为原 `Option<i64>` 的 bigint|null，时间戳由调用方传入。测试 `tests/blob-journal-owner.test.ts` 真实 notes+L11+SQLite，覆盖状态/hash/target 过滤、精确字段/尺寸/时间、重复 id、行数、调用方回滚和真实 SQL 错误身份。此为提供方候选，不代表 L11 消费已接通。

- `notes.repository.rewriteTagsWithoutTouchingUpdatedAtWithConn(conn, noteId, tagsJson)`（应 L17 / C1 `X6-SW-MEM-01` 请求）：只执行 `UPDATE notes SET tags = ?1 WHERE id = ?2`，与 Rust `dstu-memory` `service.rs:3518-3521,4416-4419,4476,4555`、`evolution.rs:284,377,637`、`semantic_dedup.rs:484,536` 相同。它不改 `updated_at`、资源或 CAS，不过滤 `deleted_at`，不自开事务，SQL 错误原样抛出。读取、过滤和衰减逻辑仍由 L17 负责。测试见 `tests/v2-boundaries.test.ts`，覆盖调用方事务提交与回滚、软删行、缺失 id 为 0 行，以及触发器报错时原样抛出。
- `notes.leases.authorized<T>(conn, auth: NoteLeaseAuth, webview, now, commit, work: () => T): T`、`notes.leases.checkWrite(conn, noteId)`、`notes.leases.now()`（应 L13 X6/D1 请求，`api.ts` `NoteLeaseRepository`，生产实现即 `repository/leases.ts` 的 `noteLeaseRepository`）：对应 Rust `note_lease_repo.rs:307-361` 与 `:302-303`。在 `note_history_write` savepoint 内依次插入 grant，校验 participant/lease/ready，`commit` 时校验冻结稿，再执行 `work`，`commit` 时刷新冻结稿，最后释放 grant。任一步出错都整体回滚，`notes.*` 错误 key 和 work 异常原样抛出。L13 `vfs/repository/update.ts` 的 `authorizedNoteLeaseWrite` 与 `notes.lease_conflict` 守卫副本应删除，改为调用这三个方法。测试见 `tests/v2-boundaries.test.ts` 的 `L13 seam notes.leases.authorized`。
- `getNoteContent` 资源缺失时：Rust `note_repo.rs:1012-1031` 不做自愈。它先 `warn!`，再返回 `Database("Missing resource for note <id>")`；存在性查询本身失败也按缺失处理。Host 已补上这条 warn 和查询失败分支，并测试确认笔记行不会被改动。L17 只用 JOIN 读并返回空，会丢掉这条错误，应改为调用 `notes.repository.getNoteContent`。

### 处理顺序

1. 无既有独立 finding ID；以上使用 L10-V2-* 自查 ID。先修 L10-V2-02 的 serde 数据边界、L10-V2-03 的单调时钟与纳秒策略；先补生产入口测试，不削弱既有断言。
2. L10-V2-01/04：把缺失业务接缝与精确 Rust SQL/生命周期需求记入 `BLOCKERS.md` 并上报；已有公开面应消费，不复制 owner SQL。缺失接口不冒充已完成。
3. SPEC 的未勾项是**本 lane 自有工作**，不是依赖阻塞；按每个修复单元补 v2 §2 分支/错误/日志/所有权/测试证据。旧 A/B 数值与 v2 未闭合事实分开报告。
4. §1.5 逐测试原 assert 对照尚未完成，不因标题匹配一律签收；不重跑旧 215 用例充当审计。

## v2 排雷清单（X6 基线 `2ee9a9cbe` 候选，2026-11-04 按当前 HEAD 核验）

X6 报告只作线索，info、assert 计数和 log 计数不直接判失败。原始 JSON 见 `git show ds-mig/X6-gate-checks:scripts/electron-migration/gate-checks/reports/<gate>.json`。

| 门禁 / 位置 | 当前核验 | 对应 finding | 状态 |
|---|---|---|---|
| single-writer resources / folder_items / vfs_index_units / vfs_indexing_config（→ L11） | 新 SW 快照 12 操作/11 SQL 写点已沿旧 ID 补全；三处 membership DELETE 改为正式 owner 面，其他缺口见清单 | L10-V2-01、R5 N5、X6-SW-0017..0020 | `OWNER-SEAMS.md` 给出完整 Rust/接口映射；不再把 folder_items/config 当 info 例外 |
| single-writer info：`import-archive.ts` notes / revisions / relations、`format.ts:60`、`leases.ts:77,79` | 都是 L10 自有表，在本插件 repository 内多文件写入；Rust 也在 dstu-vfs 的多个 note_*_repo 内 | — | 不是越权，无需改 |
| single-writer `revisions.ts:239` `__change_log`（→ sync） | C1/C2 已裁定 owner；原 Rust 本地写不构成例外 | N5 / B-sync-history-logs | 缺精确同连接清理面，已记 `OWNER-SEAMS.md`，只交 C1/C2，不派单 parked L20 |
| unchecked-decode `rag-config.ts:38` | `662d93935` 已改为 `decodeJson` + `parseJsonLossless` 严格字段解码 | L10-V2-02 | 已修 |
| unchecked-decode `asset-retention.ts:89`、`trash-commands.ts:42` | N3 单元已删除 raw 连接适配和双重断言 | R5 N3 | 本轮修复（见提交） |
| unchecked-decode `deletion-permit.ts:26` | `ctx.get('governance')` 服务查找后紧跟 `typeof` 方法检查，没有从数据做断言 | — | 保留 |
| unchecked-decode `export-common.ts:297`、`structure.ts:56`、`import-archive.ts:96` | 前两处是 mdast 库返回类型收窄，第三处读 JSZip 私有 `_data`（uncompressedSize/crc32） | — | 前两处保留；`_data` 依赖私有字段，复审 ZIP 时另核 |
| prod-reachable `tests/user-todo-executor.test.ts` `getUserTodoSchemas` | Rust `get_user_todo_schemas`（`user_todo_executor.rs:441`）只有测试 `:1823` 调用，生产无调用 | B-MFJS | 与 Rust 一致，不是接线缺口 |
| assert-parity `exporter`/`markdown`/`notes-repo`/`note-storage`/`canvas-executor`/`import-markdown` 测试 | 需逐个原 assert 对照 | L10-V2-05、R5 N4 | 未做；N4 先做 markdown FTS 生产入口 |
| log-parity `export-archive`/`notes`/`canvas-edits`/`notes-import-tool`/`user-todo-schemas`/`index.ts` | 只是计数线索 | — | 随各单元逐个日志位置核对 |

#### C2 稳定 ID 映射（冻结报告 `0119143715c0`，基线 `2ee9a9cbe`）

| 稳定 ID | 对应上表条目 / 既有 finding | 状态 |
|---|---|---|
| X6-SW-0017/0018/0019/0020（`notes.ts:385,469,739,830`） | L10-V2-01、R5 N5、B-L11-note-writes | 阻塞：需 L11 先发布同连接接口，L10 再消费 |
| X6-UD-0053（`rag-config.ts:38`） | L10-V2-02 | 已修 `662d93935` |
| X6-PR-0113（`getUserTodoSchemas`） | B-MFJS | Rust `:441` 定义仅测试 `:1823` 调用；新规则下该精确行不计 A，保留测试，见 `MFJS-EVIDENCE.md` 待 C1/C2 裁定，不自行关闭 |
| X6-AP-0351..0364（exporter / markdown / notes-repo / note-storage / canvas-executor / import-markdown） | L10-V2-05、R5 N4 | 已逐项审读，见下表；0356/0357 补原断言，其他保留循环/组合比较，待 R5 复验 |
| X6-LP-0225..0235（warn/error 计数） | 随各单元逐个日志位置核对 | 人工线索，未判失败 |

### F3-V2-05 deletion journal owner SQL（注册依赖已解除）

`notes.deletionJournal`（`api.ts` `DeletionJournalRepository`，`repository/deletion-journal.ts`）实现 F3 已确认的六个方法：insertPreparedIntent（返回 null 表示 DuplicateOperation）、listPreparedIntents、cancelRetainedIntent、cancelConflictIntent、markReady（含 `SAVEPOINT file_deletion_ready`，返回 false 表示 InvalidState）、cancelReadyWorkspaceDeletion（含 `SAVEPOINT workspace_deletion_recreated`）。size 用 bigint，写入时按 Rust `as i64` 换算。原矩阵见 `tests/v2-boundaries.test.ts`。main `80dcc5291` 已发布注册面，本候选在 apply 经公共 api 注册实际仓储和 retention，各由独立 ctx.effect 持有 Disposer；不重跑已签 SQL 矩阵，不改变原 caller conn。F3 文件编排的 SQL 委托仍需提供方接用复验，不把注册本身当全链闭合。

### F3 正式接口已进 main：N2 / F3-V2-05 最小消费

- N2：`index.ts` 的 `createDatabaseWorkerPool` 与 `src/worker-tasks.ts` 的 task 类型已改从 `platform/storage/api.ts` 导入；不复制池、不增加扫描/连接或重写 pause/resume/close。卸载后重装的真实 notes_list_tags 入口验证公共 worker import 可运行。
- F3-V2-05：两注册均返回真实 Disposer；本候选各用独立 ctx.effect 在注册成功后立即绑定清理。若 retention SlotOccupied 导致 apply 失败，先前的 journal 注册会随 scope rollback 释放，已有其他 scope 的 guard 不被清理。notes-app 测试删除多余的手工二次注册，只用真实插件 apply，原业务断言未改。
- `tests/journal-registration.test.ts` 覆盖实际 F3 Slot/Disposer、保留资产的真实 prepare 拒绝、同 conn 的实际已注册仓储调用、卸载释放、旧 disposer 不清替代注册、重装与 apply 失败回滚。blobDeletionJournal 独立保持，不接入 F3 asset/workspace 注册面。
- 最小证据：`20261104164350-a2802b` 两文件 **4 passed / exit 0**（新增生命周期 2 例 + notes-app 原 2 例），typecheck `20261104164350-ac2027` exit 0，严格边界 `20261104164350-f0257c` 五文件 0 违规 / 0 豁免 / exit 0。N5 / sync history logs / Lance 各自仍开。
- L17 紧急 gate `20261104164359-2a1224` 的后续安装 SlotOccupied 与旧 main 丢 retention disposer 同根，修复实现已在候选 `95ec4695b`（检查点 `5f9082dbf` / `51ec310bd`），尚不能以候选替代 main。补充精确 **install → await host.dispose → 新 host install** 两轮真实插件回归，保留 live duplicate 报错、末次 dispose 后两 slot 均能重新注册；`20261104165946-f80d67` **1 passed / 2 标题过滤 skipped / exit 0**，未清 Slot、未 resetModules、未删原用例。

### N4 续项：清除剩余 L11 SQL 替身（2026-11-04）

- `notes-commands`、`notes-extra-commands`、`notes-export-commands`、`note-storage`、`state`、`agent-tools-registration` 改为安装真实 `paths` / `vfs-repos` / `notes` 插件，不再 provide 自写的 vfsRepo。
- `exporter.test.ts` 安装真实 L11 owner，经公开同连接方法处理源/目标 fixture；`import-markdown.test.ts` 本来只测纯函数和文件清理，删除无用途的 L11 替身配置。
- 原测试断言保留；移除已无消费者的 `tests/test-vfs-repos.ts`。这只关闭 N4 的测试内 L11 SQL 副本，不代表 X6-AP-0351..0364 逐断言审计、N5 单写者或 Lance 清理已经关闭。
- 证据：`20261104145218-d2da3e`（7 文件 56/56）、`20261104145351-8a66ff`（exporter 17/17），均退出 0。前七个文件及 exporter 设置已由协调者检查点 `cc7e49000` 保存，后续提交补 agent 注册测试、删除替身和本节说明。
- 自检 `20261104145034-400256` 仍以退出码 2 拒绝启动：已有 `migration/LEDGER.md`、`migration/ledger.json` dirty，不提交、不还原、不遮蔽。

### X6-AP-0351..0364 断言核对（基于 `3102525cb`，不以静态 expect 数作结论）

| ID | Rust 原断言 → 当前 TS 对应 | 结论 / 修复 |
|---|---|---|
| 0351 | `notes_exporter.rs:4227-4230` 四种绝对路径 → `exporter` 同名测试逐项循环 | 4 个原输入均断言 false；无需改 |
| 0352 | `notes_manager.rs:2106-2122` 九种标题行 → `markdown` 的九个 `[text, level]` 向量 | 全对应，无需展开成九个重复 expect |
| 0353 | `notes_manager.rs:2144-2172` 存在性、子章节、正文包含/排除、缺失与忽略大小写 → `markdown::test_extract_section_content` 的 12 个断言 | 已在当前代码中完整；报告误关联到 without_hash 不需倒改 |
| 0354 | `note_repo.rs:3154-3157` id/title/tags/favorite → `notes-repo::test_create_note` 四断言 | 正确测试已覆盖；报告粗关联到 links 测试无需改 |
| 0355 | `note_repo.rs:3605-3623` 正文 targets 和三个代码区域例子的长度/目标 → `notes-repo` 四个完整数组相等断言 | 数组相等同时约束长度和唯一目标，语义不缺 |
| 0356 | `note_repo.rs:3806-3816` 出链数、解析目标、反链数、反链来源身份 | 原缺最后一项，补 `backlinks.every(sourceId === source.id)` |
| 0357 | `note_review_tests.rs:101-124` 初次失败、notes/operations/folder_items 计数、撤触发器后同 operation 重试成功 | 原缺最后一步，补 DROP TRIGGER 后 `saveAs` 不抛错；不弱化前四项 |
| 0358 | `canvas_executor.rs:2093-2113` 14 个可处理名称和 3 个拒绝名称 → `canvas-executor::test_can_handle` 两个逐项循环 | 17 原输入/方向均一致 |
| 0359/0360 | `cmd/notes.rs:2837-2846` BOM 解码正文与编码名称 → `import-markdown` 二元数组完全相等 | 同时覆盖两个字段，无需拆 expect |
| 0361 | `cmd/notes.rs:2879-2882` 四种非 leading-H1 → `import-markdown` 同四输入循环 | 均 null |
| 0362 | `cmd/notes.rs:2905-2908` 四种占位标题 → 同四输入循环 | 均 true |
| 0363 | `cmd/notes.rs:2913-2917` 五种不透明文档 id → 同五输入循环 | 均 true |
| 0364 | `cmd/notes.rs:2922-2925` 四种真实标题 → 同四输入循环 | 均 false |

这里只核对这些稳定 ID 的原断言，不代表全部 135 个 Rust 测试、prod-reachable 或 LP 日志审计完成。0356/0357 在安装真实 L11 的测试上补齐，提交后交 R5 复验。

### X6-LP-0228：create/update SAVEPOINT 错误分支（候选待复验）

- Rust `note_repo.rs:493-500,669-676` 在 SAVEPOINT 开启失败时记录 error 并返回 `Database("Failed to create savepoint: …")`；`:573-581,885-893` 在 RELEASE 失败时记录 error 并返回 `Database("Failed to release savepoint: …")`，不进入正文失败的回滚分支。
- 原 TS 无这四条 error 日志、无对应错误前缀，且把 RELEASE 放进正文 try/catch 导致额外回滚。本轮只修这两种操作的对应分支，不宣称 purge 等其他 LP 分支全部核完。
- `tests/v2-boundaries.test.ts` 新增真实 kernel 命令 + 延迟外键约束回归（create/update 各一项）：未修时 `20261104150509-1a22ed` 2 failed，修后 `20261104150640-e055c4` 3 文件 80/80；检查日志/错误前缀、失败 RELEASE 保留调用方事务、显式回滚恢复、解除约束后重试。typecheck `20261104150640-4bd8fc` 退出 0。

### L10-V2-07：本地 relation revision/CAS 精度（独立于 sync 与 N1）

- 实际缺口：`relations.ts::get` 以默认 number 读取 i64 再 `Number(row.revision)`，`9007199254740993` 被舍入；i64::MAX 自增被 SQLite 提升为 REAL 后，回读也未像 Rust `get::<i64>` 一样报错回滚。
- 修复：命名查询开启 safeIntegers，双边安全区间外保持 bigint；内部 put/delete CAS 类型允许精确 i64。保留 SQL 原自增语句及保存点，REAL 回读按 Rust 列类型错误失败，IPC 数字转换交给 kernel（D3）。不改生成契约，不拒绝合法负 i64，不新增事务/兼容框架。
- 证据：`20261104152212-93979d` 新增 3 例先失败（40 条按标题过滤 skip）；`20261104152437-478299` 3 文件 64/64 全过，typecheck `20261104152437-69df08` 退出 0。覆盖真实插件命令输出、真实 SQLite 的大正/负 revision、相邻 CAS、调用方事务回滚、i64 溢出回滚；旧断言未改。
- 补充 IPC 已舍入 CAS 的 Conflict（非新增 Validation）断言后，`20261104153104-11ad0e` 为 **3 passed / 40 标题过滤 skipped / exit 0**；`20261104153104-3312f4` 改动四文件严格边界检查 0 违规、0 豁免、exit 0。实现及测试已由协调者 `3f876059f` / `7deba2c66` 保存。按 C1 新指令，ledger dirty 前置条件未变，不重复排同一 lane-gate；两份生成文件保留未动。
- `SPEC.md` 四条 relation 命令仅补本次 D3 分支证据，未将 locator serde/worker/取消等剩余项一并勾完；历史 seq 与纳秒审查仍各自保留。

### N5 增量：SW `1c8239f67` 核差及现有接口消费

- 按旧 X6-SW-0017..0020 和 N5 归组补全 `OWNER-SEAMS.md`：12 个报告操作对应 11 个写点（INSERT OR REPLACE 只算一项）；folder_items / vfs_indexing_config 归 L11，__change_log 归 sync，不再沿旧 info / Rust 本地写的理由排除。
- 三处 folder_items DELETE（孤立 membership、正常 purge、purge wrapper）改用已有 `folders.removeItemByItemId`，保持孤立行 rows>0 的成功分支、原同连接保存点、先 membership 后 note 的错误顺序。未改 resource 删除、软删/恢复或回填标志等剩余 SQL 来躲扫描。
- 纠正旧接口判断：普通 `indexingConfig.setConfig` 校验白名单，不接受维护 key；Rust `note_repo.rs:3087-3089` 也明确绕过它。已向 active L11 请求专用同连接标志写入等六面；sync 的精确 history log 清理面只给 C1/C2 登记，不派给 parked L20。
- 证据：`20261104155331-e53196` **4 passed / 73 标题过滤 skipped / exit 0**，typecheck `20261104155331-67feaf` exit 0；补 owner SQL 错误优先顺序后 `20261104155635-42b783` **2 passed / 43 标题过滤 skipped / exit 0**。strict `20261104155635-692a0b` 三文件 0 违规/0 豁免/exit 0。均安装真实 L11+notes，覆盖调用方 rollback、孤立行/NotFound 和失败重试。N5/Lance 未整体关闭。

### WP-084 / D005-01：租约启动重置、5 秒 TTL、窗口销毁（页面加载分项仍 open）

- 生产入口 `src/lease-lifecycle.ts`，由 `index.ts` apply 在仓储配置后调用：
  - 启动：`cleanup(vfs, 9223372036854775807n, null, null)`，对应 lib.rs:1340-1346。i64::MAX 用 bigint 精确绑定，结果丢弃、不发事件；失败抛 `Notes lease startup cleanup: {VfsError Display}`，插件安装失败（对应 setup `?`）。
  - 定时：WP-084 初版是 `setImmediate` 一次 + `setInterval(5000)`；WP-174 将其修为单调截止点递增 5000ms 的 Burst（首 tick 仍立即），每次用 `NoteLeaseRepo::now()` 纪元秒；随 ctx.effect 清理。
  - 销毁：只认 `host/window` 的 `destroyed`，传 `ref.window`、webview=null，对应 lib.rs:704-712；close-requested/blurred 不清理。
  - cmd/notes.rs:526-553：成功时逐条 `notes:lease-ended`；失败只 warn `Notes editor lease cleanup: {e}`，维护中显示 `MAINTENANCE_MODE: vfs is temporarily unavailable`。
- 测试 `tests/note-lease-lifecycle.test.ts`：真实 kernel + paths + vfs-repos + notes + 迁移后 SQLite，不手动调用 cleanup。去掉启动接线时 5/6 失败，去掉定时/销毁接线时 4/6 失败。
- 与 Rust 的差异：初版 Node setInterval 不补发的缺口由 WP-174 修复（见顶部证据）；Rust 走 spawn_blocking，TS 在主线程同步执行（N2 旧限制）。插件安装失败只让 notes 降级，不像 Tauri setup 失败那样终止整个应用（kernel 按插件隔离）。
- 未做：`PageLoadEvent::Started`（lib.rs:487-491）对应的 `page-load-started` 清理由 WP-091 在 F2 真实发送后接入，D005-01 不关闭；R5 原反证待 C2 复验。

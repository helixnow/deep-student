# L10-notes 等价场景 v0

WP-051（§1–§8：历史读取/恢复与编辑器租约）和 WP-230（§9：G3 命令语料 v1，46 条前端可达命令），格式均为 WAVE0 §3 v0。本目录只放场景源文件，不含答案：A（Rust/Tauri）是答案机，B（Electron 宿主）重放后由 X7 比较器比对。**两个包都没有执行任何 A/B 重放，没有一条命令因此成为 C。**

| 文件 | 场景 | 步骤 | 覆盖命令 |
|---|---|---|---|
| `history.json` | 10（H1–H10） | 180 | 9 条 `notes_history_*` |
| `lease.json` | 10（L1–L10） | 215 | 10 条 `notes_editor_*` |
| WP-230 七个文件 | 22 | 534 | 46 条，另补 `notes_history_get_retention`（见 §9.1） |

全部场景：`seed:"empty"`、`capture {events:true, db:["*"]}`、`normalize: []`。`expect:"error"` 只是标注，不是判定依据；没有写任何期望返回值。

## 1. 运行器约定（交 X7 确认）

1. **步骤引用** `${n.path}`：`n` 是同一场景内 0 起的步骤下标，只引用更早且未标 `expect:"error"` 的步骤；`path` 为点分路径，数字段是数组下标（如 `${5.items.2.version_id}`）。本目录所有引用都是**整串引用**，应替换为原始类型值（字符串、数字或 `null`），不做字符串拼接。`${n.next_cursor}` 可能是 `null` 或 i64。
2. **大整数**：`history.json` 中 `9007199254740993`、`9223372036854775807`、`9223372036854775808`、`-9223372036854775808`、`-9223372036854775809` 以 JSON 数字原样写入。普通 `JSON.parse` 会把它们改写（`9007199254740993→9007199254740992`，i64 边界→`9223372036854776000`），这样 H5 第 3–9 步会塌成同一个值，i64 溢出错误分支也会消失。运行器必须用无损数字解析读取场景，并以原始数字文本送入 IPC；做不到时，H5 应报“运行器不支持”，不能当作通过。
3. **辅助步骤**不计入本包覆盖，只用来搭建状态：
   - `dstu_create {path:"/", options:{type:"note",name,content}}`：L13-vfs-api，前端 `src/dstu/api.ts:336`，Rust `crates/dstu-vfs/src/dstu/handlers.rs:726`。返回的 DstuNode `id` 是 note id，`path` 给 `dstu_delete` 用；DstuNode `updatedAt` 是毫秒整数，不能当作 `expected_updated_at`。
   - `dstu_delete {path}`：L13-vfs-api，前端 `src/dstu/api.ts:444`，Rust `handlers.rs:1663`。
   - `notes_update {note:{id,content_md,expected_updated_at,capabilities:["ds-columns-v1"]}, lease?}`：本 lane 命令，Rust `src/cmd/notes.rs:1245`。前端 `src/features/notes/noteEditorHost.ts:30`、`src/features/notes/NotesCrepeEditor.tsx:857`、`src/features/learning-hub/apps/views/NoteContentView.tsx:602` 都带 `capabilities:['ds-columns-v1']`，场景只用这条前端路径。它返回 NoteItem，其中字符串 `updated_at` 用于后续 CAS。notes_update 自身的分支完整覆盖留给后续包。
   - 字符串 `updated_at` 来自 `notes_history_current`、`notes_update` 或 `notes_editor_flush` 的返回值。
4. 每个场景先执行 `notes_history_set_retention {edit_bucket_seconds:0,max_edit_versions:null}`，关闭时间桶合并，让版本数与时钟无关。H10 例外，它使用 86400 秒桶来测合并。
5. 所有 v0 步骤都发自同一个 webview/窗口。下文 §5 列出 v0 表达不了的分支。

## 2. 命令、调用点与可达 Err/早退

Rust 路径相对 `src-tauri/`。仓储文件：`crates/dstu-vfs/src/vfs/repos/` 下的 `note_revision_repo.rs`（rev）、`note_history_restore.rs`（hr）、`note_lease_repo.rs`（lease）。

所有命令共有的错误：参数 serde 反序列化失败（IPC 层，缺键、类型错误、`deny_unknown_fields`）；`AppError::configuration("VFS database not configured")`；`get_conn_safe` 失败映射为 `database`；`spawn_blocking` join 失败映射为 `internal`。后三类在空库正常启动下不可达。

错误映射有两种。走 `note_storage`（`cmd/notes.rs:300-325`）的命令：`VfsError::Conflict{key}` 映射为 `AppError::conflict("<key>: Stored revision changed; reload before retrying")`，`InvalidArgument` 映射为 `validation(reason)`，其余映射为 `database(to_string)`。history list/get/set_pinned/restore_copy 自己调用 `spawn_blocking`（`:1002-1103`），**所有**仓储错误一律映射为 `database(to_string)`，包括 NotFound `Note revision (missing or pruned)`（rev `:108-113`）。

### 2.1 历史（history.json）

| 命令 | 前端 | Rust | 可达 Err / 早退（仓储行） |
|---|---|---|---|
| `notes_history_current` | `src/utils/notesApi.ts:163` | `cmd/notes.rs:926` | validation `Current note missing or deleted`（hr `:35-38`，不存在或已软删）；缺 `noteId` |
| `notes_history_get_retention` | `notesApi.ts:171` | `:934` | 无可达 Err（hr `:40-51`；逐条理由见 §10） |
| `notes_history_set_retention` | `notesApi.ts:174` | `:941` | `max_edit_versions:0` 归一为 null（早改写，hr `:57-59`）；validation `Retention interval must be 0..86400; version budget must be null or 1..100000`（`:60-68`）；IPC：policy 缺失/null、未知字段、缺 `edit_bucket_seconds`、i64 溢出、小数。缺 `max_edit_versions` 按 serde `Option` 规则视为 None |
| `notes_history_list` | `notesApi.ts:144` | `:1002` | `limit` 缺省 30、`pinnedOnly` 缺省 false（`:1022-1023`）；`limit.clamp(1,100)`（rev `:252`）；`next_cursor` 仅在多出一行时给出（`:264-268`）；note 不存在返回空页（不是 Err）；IPC：cursor 超 i64、小数、字符串，limit 超 u32 或为负，pinnedOnly 非 bool，缺 noteId |
| `notes_history_get` | `notesApi.ts:148` | `:1032` | database NotFound（note/version 不匹配或不存在，rev `:290-299`）；tags/props/asset_refs 的 Serialization（`:303-311`，需损坏种子）；IPC：缺 versionId / null |
| `notes_history_set_pinned` | `notesApi.ts:152` | `:1054` | database NotFound（rev `:328`）；IPC：pinned 非 bool、缺失 |
| `notes_history_restore_copy` | `notesApi.ts:160` | `:1077` | 等同 `restore_selection_copy(None)`（rev `:361-363`）：database NotFound（`:372`）；`ensure_supported`/格式信封/columns 能力错误（`:373-381`，hr `:89-103`，需种子）；成功后 emit DstuWatchEvent created（`:1098-1101`）；软删笔记的历史仍可复制 |
| `notes_history_restore_selection_copy` | `notesApi.ts:159` | `:952` | validation（经 `note_storage`）：NotFound 映射为 database；hr `selected_content` 的 `History line selection is out of range`（`:110-115`）、全文快捷返回（`:121-123`，早退）、`Select the full document when it contains reference definitions`（`:128-132`）、`Incomplete history structure`（`:142-144`）、`Select complete root blocks; the range cuts a Markdown or columns structure`（`:145-152`）、选区再检测/blocks（`:154-157`）；成功后 emit created（`:965-968`）；IPC：selection 缺失/null、负数（usize）、未知字段 |
| `notes_history_restore_current` | `notesApi.ts:168` | `:972` | 经 `note_write_storage`（`:327-348`）。传 lease 时先走 `NoteLeaseRepo::authorized`（lease `:307-361`）：`participant_expired`、`lease_expired`、`lease_owner_mismatch`、`lease_not_ready`、`lease_flush_required`。随后 hr `restore_current`（`:161-217`）：`Current note missing or deleted`、`notes.conflict`（CAS，`:170-172`）、格式错误（`:173-175`，需种子）、NotFound（`:176`，映射为 database）、selected_content 全部分支（`:177`）；无 lease 但目标笔记处于租约中时，由写检查/触发器报 `notes.lease_conflict`（lease `:302-305`，迁移 `V20260924__note_editor_leases.sql:51-72`）；成功后 emit updated（`:994-997`）；IPC：缺 expectedUpdatedAt、selection 缺键/未知字段、lease 缺键 |

### 2.2 租约（lease.json）

所有租约命令都取 `webview.label()`，参与者按 `(id, webview_label, expires_at>now)` 识别（lease `:62-66`）。`required`（`:99-106`）：token 不存在、`expires_at<=now`、或任一 ACK 参与者已不存在或过期时，报 `notes.lease_expired`。`owned`（`:108-120`）依次为 participant → required → `notes.lease_owner_mismatch`。

| 命令 | 前端 | Rust | 可达 Err / 早退（lease 行） |
|---|---|---|---|
| `notes_editor_register` | `src/features/notes/noteHostCoordinator.ts:60` | `cmd/notes.rs:350` | validation `Note missing`（`:130-132`，不存在或已软删）；笔记已有租约时加入 ACK 并把 ready 退回 pending（`:145-152`），且 emit `notes:lease-changed`（cmd `:363-365`）；缺 noteId |
| `notes_editor_heartbeat` | `noteHostCoordinator.ts:67` | `:368` | `notes.participant_expired`（`:171`）；只给非 pending 的自有租约续期（`:177`）；缺 participantId |
| `notes_editor_unregister` | `noteHostCoordinator.ts:62,85` | `:380` | 无业务 Err；id 不存在时删 0 行，再 `cleanup(now)`（`:525-538`），返回取消列表；每个取消项 emit `notes:lease-ended`（cmd `:392-394`）；缺 participantId |
| `notes_editor_begin` | `noteHostCoordinator.ts:215` | `:397` | `participant_expired`（`:202`）；validation `Operation and note IDs required`（空列表或空白 operation，`:204-206`）；同 operation 已存在时走 `owned`，再报 `notes.lease_operation_mismatch`（`:224-232`）或幂等返回（`:233`，早退）；`Note missing`（`:241-243`）；`notes.lease_conflict`（`:244-250`）；validation `Owner note must be in note_ids`（`:258`）；`Lease missing`（`:259`）不可达；成功后 emit lease-changed；noteIds 用 BTreeSet 去重 |
| `notes_editor_lease_status` | `noteHostCoordinator.ts:223,250,254` | `:421` | token 不存在返回 `null`（`:72-74`，早退，不是 Err）；缺 token |
| `notes_editor_freeze_ack` | `noteHostCoordinator.ts:242` | `:428` | `participant_expired`、`lease_expired`、`notes.lease_phase`（refreshing，`:273-275`）、validation `Note missing`（`:276-277`，参与者存活而其笔记已软删；该笔记不在任何租约中时软删不受触发器阻挡）、`notes.lease_stale_draft`（`:278-280`）、`notes.lease_divergent_drafts`（`:286-292`）；后两者在 cmd `:440-450` 删除整个租约并 emit `notes:lease-ended`（reason 为该 key）；`notes.lease_participant_mismatch`（`:294`，参与者不在本租约 ACK 中）；全部 ACK 后进入 ready（`:295`）；IPC：draft/lease 未知字段或缺键 |
| `notes_editor_flush` | `noteHostCoordinator.ts:159`（经 invokeWithLease） | `:457` | `authorized(commit=false)`：`participant_expired`、`lease_expired`、`lease_owner_mismatch`、`lease_not_ready`；`notes.lease_scope`（`:394-401`）；无草稿但在范围内时返回当前 updated_at（`:402-406`，早退）；草稿等于当前内容时不写（`:411-415`）；否则 `update_note_with_capabilities`（`:417-426`，其 CAS/能力错误）；`capabilities` 缺省为空（cmd `:472`）；缺 noteId |
| `notes_editor_finish` | `noteHostCoordinator.ts:247` | `:478` | `owned` 三类；`notes.lease_not_ready`（pending 或 refreshing，`:371-373`）；成功后进入 refreshing 并 emit lease-changed；缺 lease |
| `notes_editor_refresh_ack` | `noteHostCoordinator.ts:296` | `:493` | `participant_expired`、`lease_expired`、`notes.lease_phase`（非 refreshing，`:448-450`）、`notes.lease_stale_refresh`（`:451-457`）；`notes.lease_participant_mismatch`（`:458`）**v0 不可达**：status.notes 只含本租约笔记，而能通过 `:451-457` 的参与者必然在本租约 ACK 中，需种子构造 ACK 缺行；缺 updatedAt |
| `notes_editor_release` | `noteHostCoordinator.ts:139,229,257` | `:509` | `owned` 三类；`notes.lease_refresh_pending`（`cancel=false` 且非 refreshing 或仍在等待，`:472-474`）；reason `cancelled`/`released`（`:478`）；emit lease-ended（cmd `:522`）；IPC：cancel 非 bool、缺失 |

**契约差异（只报告，未改）**：`contracts/ipc/L10-notes.json` 标记 `notes_editor_flush` 为 `frontend: none`，但 `src/features/notes/noteHostCoordinator.ts:159` 实际经 `invokeWithLease` 调用它。

## 3. 每命令覆盖表

“步骤”指场景内 0 起的下标。成功/错误计数由 §8 所述校验得出（作业 20261105154706-631434，exit 0）。

场景代号：
- H1 `notes.history.chain.create_edit_list_get_restore_current`
- H2 `notes.history.copy.full_selection_and_errors`
- H3 `notes.history.selection.root_block_boundaries_and_reference_definitions`
- H4 `notes.history.list.pagination_limits_and_cursor`
- H5 `notes.history.list.integer_boundaries_near_2p53_and_i64`
- H6 `notes.history.get_and_set_pinned.success_and_errors`
- H7 `notes.history.trash.history_survives_soft_delete`
- H8 `notes.history.retention.get_set_validation`
- H9 `notes.history.retention.coalescing_deferred_policy_and_budget`
- H10 `notes.history.restore_current.cas_selection_lease_and_missing_branches`
- L1 `notes.lease.single_editor.full_lifecycle_commit`
- L2 `notes.lease.two_editors.barrier_fence_owner_and_refresh`
- L3 `notes.lease.freeze_ack.divergent_stale_phase_shape_and_mismatch`
- L4 `notes.lease.begin.validation_idempotency_conflict_and_owner`
- L5 `notes.lease.participant.register_heartbeat_unregister_branches`
- L6 `notes.lease.late_registration_reopens_barrier`
- L7 `notes.lease.unregister_cancels_whole_lease`
- L8 `notes.lease.flush.scope_unopened_note_and_lease_errors`
- L9 `notes.lease.flush_then_restore_current_under_fence`
- L10 `notes.lease.finish_refresh_release.phase_branches`

| 命令 | 成功/错误步数 | 成功与早退分支（场景:步骤） | 错误分支（场景:步骤） |
|---|---|---|---|
| `notes_history_current` | 21/3 | 正常读取 H1:2,7,9；CAS 来源 H4:2、H10:2,16,19、L1:2 等 | 软删 H7:5；不存在 H7:12；IPC 缺 noteId H7:13 |
| `notes_history_get_retention` | 5/0 | 默认值 H8:0；设置后回读 H8:2,4,8,19（无业务 Err） | 无可达 Err，见 §10 |
| `notes_history_set_retention` | 25/10 | 正常 H8:1；`max_edit_versions:0→null` H8:3；上界 86400/100000 H8:5；下界 1 H8:6；缺 max H8:7；各场景前置 0 桶；合并桶 H9:0；预算 H9:7 | 区间：-1 H8:9、86401 H8:10、100001 H8:11、-1 预算 H8:12；IPC：i64 溢出 H8:13、小数 H8:14、未知字段 H8:15、缺 edit_bucket_seconds H8:16、缺 policy H8:17、policy null H8:18 |
| `notes_history_list` | 47/8 | 全量 H1:5,10；pinnedOnly H1:11、H2:11、H6:11,14、H4:17；分页 limit 2 加 next_cursor H4:6-8；clamp 0→1 H4:9、101→100 H4:10、u32 上界 H5:12；缺省 H4:11、null H4:12；note 不存在返回空页 H4:13；cursor 1/0/-1 H4:14-16；cursor 近 2^53 与 i64 边界 H5:3-6,8；软删后仍列出 H7:6；合并与预算 H9:6,8,10,12；副本历史 H2:9 | 缺 noteId H4:18；cursor 超 i64 H5:7、低于 i64 下界 H5:9、小数 H5:10、字符串 H5:11；limit 超 u32 H5:13、负数 H5:14；pinnedOnly 非 bool H5:15 |
| `notes_history_get` | 5/4 | 读取 H1:6,13、H6:5,19；软删笔记历史 H7:7 | note/version 不匹配 H6:6；version 不存在 H6:7；缺 versionId H6:8；versionId null H6:9 |
| `notes_history_set_pinned` | 4/4 | 取消固定 H6:10；固定 H6:12；重复固定 H6:13；软删笔记 H7:8 | note 不匹配 H6:15；version 不存在 H6:16；pinned 非 bool H6:17；缺 pinned H6:18 |
| `notes_history_restore_copy` | 3/3 | 复制 H2:3；同名副本再复制（标题去重）H2:4；软删笔记 H7:9 | version 不存在 H2:12；副本 note 与原 version 不匹配 H2:13；缺 versionId H2:14 |
| `notes_history_restore_selection_copy` | 10/13 | 部分选区 H2:5,6；全文快捷早退 H2:7；空行选区 H2:8；完整代码块 H3:6；完整列表 H3:7；标题 H3:8；尾段 H3:9；含引用定义全文 H3:13；软删笔记 H7:10 | 越界：0 H2:15、end<start H2:16、超行数 H2:17；IPC：负数 H2:18、未知字段 H2:19、null H2:20、缺失 H2:21；version 不存在 H2:22；切断代码块 H3:3,4、切断列表 H3:5；引用定义在前 H3:12；引用定义在后（Incomplete history structure）H3:16 |
| `notes_history_restore_current` | 4/18 | 整版恢复 H1:8；选区恢复 H10:15；缺 selection 键 H10:18；租约内恢复 L9:14 | `notes.conflict`：旧 token H1:12、H10:5、空串 H10:22；软删 H7:11；note 不存在 H10:20；NotFound H10:6；选区：切断 H10:7、0 H10:8、越界 H10:9、未知字段 H10:10、缺 end_line H10:11；lease：participant_expired H10:12、lease 缺 token H10:13、`lease_not_ready` L9:8、`lease_expired` L9:9、无 lease 而遇租约写栅栏 `lease_conflict` L9:11、`lease_flush_required` L9:12；缺 expectedUpdatedAt H10:21。`lease_owner_mismatch` 走同一个 `authorized`，在 L2:11（flush）覆盖 |
| `notes_editor_register` | 16/3 | 首次注册 L1:3 等；加入已有租约，ready→pending 并 emit lease-changed L6:8；注册到另一笔记 B L3:28 | 不存在 L5:4；软删 L5:5；缺 noteId L5:6 |
| `notes_editor_heartbeat` | 4/3 | 续期 L1:4、L5:8；租约 ready 时续期 L6:6,9 | 不存在 L5:9；缺 participantId L5:10；注销后 L5:14 |
| `notes_editor_unregister` | 18/1 | id 不存在返回空列表 L5:11；正常 L5:12；重复 L5:13；非 owner 注销取消整个租约 L7:7；owner 注销取消租约 L7:12；其余为场景收尾 | 缺 participantId L5:15 |
| `notes_editor_begin` | 15/9 | 新租约 L1:5 等；noteIds 去重 L4:10；同 operation 幂等早退 L4:11；多笔记租约 L8:6 | participant_expired L4:5；空 noteIds L4:6；空白 operation L4:7；`Owner note must be in note_ids` L4:8；`Note missing` L4:9；`lease_operation_mismatch` L4:12；`lease_conflict` L4:13；同 operation 非 owner（`lease_owner_mismatch`）L4:15；缺 noteIds L4:16 |
| `notes_editor_lease_status` | 10/1 | pending L1:6；refreshing L1:12、L2:19；释放后 null L1:14；token 不存在 null L4:17；分歧/过期草稿删除后 null L3:8,13；迟到注册后 pending L6:7；注销后 L7:8,13 | 缺 token L4:18 |
| `notes_editor_freeze_ack` | 13/11 | 首个 ACK L1:7；第二人 ACK 进入 ready L2:9；幂等 L3:18,19；迟到者 ACK L6:12；含未保存草稿 L9:10 | `lease_divergent_drafts`（删除租约并 emit lease-ended）L3:7；`lease_stale_draft` L3:12；IPC：draft 未知字段 L3:15、draft 缺字段 L3:16、lease 未知字段 L3:17；token 不存在 L3:21；participant_expired L3:22；`lease_phase` L3:24；`lease_participant_mismatch` L3:30；参与者笔记已软删 `Note missing` L3:32；租约因注销被取消后 `lease_expired` L7:9 |
| `notes_editor_flush` | 7/6 | 草稿等于当前，不写 L1:8、L2:13、L6:13；未打开的范围内笔记早退 L8:8；capabilities null L8:10、缺省 L8:11；有草稿差异时写入 L9:13 | `lease_owner_mismatch` L2:11；`lease_not_ready` L6:10；`lease_scope` L8:9；token 不存在 L8:12；participant_expired L8:13；缺 noteId L8:14 |
| `notes_editor_finish` | 6/6 | ready→refreshing L1:10、L2:15、L3:23、L8:15、L9:17、L10:17 | 非 owner L2:12；pending 时 `lease_not_ready` L10:5；participant_expired L10:14；缺 lease L10:16；refreshing 时 `lease_not_ready` L10:18；释放后 `lease_expired` L10:23 |
| `notes_editor_refresh_ack` | 5/6 | owner L1:11、L2:18、L8:16、L9:18；第二编辑器 L2:20 | `lease_stale_refresh` L2:17；pending 时 `lease_phase` L10:6、ready 时 L10:9；participant_expired L10:15；缺 updatedAt L10:19；释放后 `lease_expired` L10:22。`lease_participant_mismatch` v0 不可达（§4 第 6 条） |
| `notes_editor_release` | 10/9 | released L1:13、L2:21、L8:17、L9:19；cancelled L3:25,33、L4:19,20、L6:14、L10:20 | 非 owner `lease_owner_mismatch` L2:10；仍有人未 refresh 时 `lease_refresh_pending` L2:16；pending L10:7；ready L10:10；token 不存在 L10:11；cancel 非 bool L10:12；缺 cancel L10:13；释放后 `lease_expired` L10:21；owner 注销后 participant_expired L7:14 |

辅助命令 `notes_update` 的错误步骤（不计覆盖）：无 lease 写租约中笔记 `lease_conflict` L2:7；pending 时带 lease 写 `lease_not_ready` L2:8、L6:11。

合计（19 条目标命令）：成功步骤 228，错误标注步骤 118；全部 395 步中其余 49 步为辅助步骤。

## 4. 需要种子的场景（X3 种子 owner，X7 运行器 owner）

这些场景不放进可执行 JSON，以免在空库里伪造覆盖。

1. **seq 接近 2^53 的分页游标**。种子：`vfs` 库 `sqlite_sequence` 中 `note_document_revisions` 的 seq 设为 `9007199254740990`。步骤：create 后连续三次 notes_update（retention 0 桶），得到 seq 991–994；`notes_history_list {limit:2}` 返回 `next_cursor=9007199254740993`。JS 宿主若经 `JSON.parse`/`Number` 往返，会变成 `...992`，下一页 `seq < 992` 会跳过 seq 992 那一行。A 端应返回 992、991。
2. **D005-02 props 精确整数**。种子：带 `props_json='{"n":9007199254740993}'` 的笔记及其 created 历史行（v0 没有前端可达的命令能写任意 props 整数）。步骤：notes_update 改正文 → `notes_history_restore_current` 回到该版本 → `notes_history_get` 新版本，加 db 捕获。A 端保持 `9007199254740993`。
3. **D005-03(a) 已持久化 draft_json 多余字段**。种子：`note_editor_lease_acks.draft_json` 中写入带额外字段的 FrozenDraft。flush（lease `:408-409`）与 authorized（`:333-334`）在 A 端报 validation。v0 只能经 IPC 送草稿，IPC 层已拒绝多余字段（L3 第 15、17 步覆盖 IPC 层）。
4. **格式信封/列能力分支**：hr `:89-103`、`:173-175`；需要不支持的 `note_document_formats` 行，或内容与格式信封不一致的历史行。
5. **损坏的历史 JSON**：rev `:303-311`，tags/props/asset_refs 非法时报 Serialization（映射为 database）。
6. **refresh_ack `notes.lease_participant_mismatch`**（lease `:458`）：需要删除某参与者的 ACK 行但保留参与者，v0 不可达。

## 5. v0 表达不了的生命周期分支（交 X7 扩展）

Rust 生命周期入口：
- `src/lib.rs:487-491`：`on_page_load` 收到 `PageLoadEvent::Started` 时调用 `cleanup_note_editor_leases(app, None, Some(webview_label))`。
- `src/lib.rs:704-712`：`WindowEvent::Destroyed` 时调用 `cleanup_note_editor_leases(app, Some(window_label), None)`。
- `src/lib.rs:1340-1354`：启动时 `NoteLeaseRepo::cleanup(&conn, i64::MAX, None, None)`，失败则启动报错 `Notes lease startup cleanup: …`；之后每 5 秒 `cleanup_note_editor_leases(app, None, None)`。
- `src/cmd/notes.rs:526-553`：cleanup 在阻塞线程运行，每个取消项 emit `notes:lease-ended`（reason `participant_closed_or_expired`，lease `:506-523`），失败只 `log::warn!("Notes editor lease cleanup: {}")`。
- TTL：`PARTICIPANT_TTL=45`、`LEASE_TTL=30` 秒（lease `:13-14`），时钟为 `chrono::Utc::now().timestamp()`（`:58-60`），不可注入。

v0 步骤只有 `{cmd,args,expect?}`，全部发自同一个 webview，没有窗口、重载、重启或时钟动作，所以以下 R5 D005-01 主场景**不能**写成可执行 JSON。也不能用 invoke 冒充窗口事件。需要的最小扩展：

| 扩展步骤（建议形态） | 用途 | A 端实现要点 |
|---|---|---|
| `{"window":"open","label":"notes-2"}`，并在普通步骤上加 `"webview":"notes-2"` | 第二个编辑器真正位于另一个 webview/窗口；也可覆盖“别的 webview 用同一 participant_id”的 `participant_expired` | 真实创建 Tauri 窗口；按步骤选择发起调用的 webview |
| `{"window":"destroy","label":"notes-2"}` | 窗口销毁清理（`lib.rs:704-712`） | 关闭真实窗口，并等待 `notes:lease-ended` 或超时 |
| `{"webview":"reload","label":"notes-2"}` | 页面重载清理（`lib.rs:487-491`） | 只能由驱动在外部触发；重载自身 harness 所在页面会杀死 harness JS |
| `{"app":"restart"}` | 启动清理 `cleanup(i64::MAX)`（`lib.rs:1340-1347`） | 保留数据目录重启进程；重启前后各取 db 捕获 |
| `{"clock":"sleep","seconds":36}` / `{"await":"event","name":"notes:lease-ended","timeoutMs":10000}` | TTL 到期与 5 秒轮询（`lib.rs:1348-1353`） | 真实等待（A 端时钟不可注入）；事件规范化要保留 reason |

扩展后应补的场景（每个都要求 `capture {events:true, db:["*"]}`）：
- W1 窗口销毁：主窗口 register → `notes-2` register → begin（owner 在主窗口）→ 两边 freeze_ack → destroy `notes-2` → 等待 lease-ended → `lease_status` 为 null → 无租约 `notes_update` 成功。
- W2 owner 所在 webview 重载：同上，但 reload owner webview；随后旧 participant 的 heartbeat 报 `participant_expired`。
- W3 重启：租约处于 ready 时重启，之后 lease_status 为 null，写入不再被挡。
- W4 租约 TTL：begin 后不再 ACK，等待超过 30 秒加一个轮询周期。
- W5 参与者 TTL：register 后不再 heartbeat，等待超过 45 秒。

## 6. R5 D005 映射（只用于排优先级，本包不修实现）

| R5 发现 | 本目录处理 |
|---|---|
| D005-01 租约生命周期清理未接入 | §5 的 W1–W5 需要 X7 扩展；可执行部分只到显式 unregister 取消整个租约（L7）和迟到注册重开屏障（L6） |
| D005-02 props 精确整数恢复被改写 | §4 第 2 条需要 X3 种子；H5 覆盖 IPC 层整数边界 |
| D005-03(a) FrozenDraft 多余字段 | IPC 层见 L3；已持久化路径见 §4 第 3 条 |
| D005-03(b)(c)、D005-04 relation / revisions 解码 | 不在本包 19 条命令范围（relation 命令属于剩余命令） |
| D005-05 第二连接保证 | v0 单连接，不可表达；属于测试去向问题，不属于差分场景 |
| D005-06 rollback 失败日志 | 双故障路径，v0 不可触发 |

## 7. 剩余命令与阻塞

L10 契约共 81 条命令。WP-051 覆盖 19 条，WP-230 覆盖 46 条（§9）。仍无目标场景的 16 条：

- 前端可达（1）：notes_update（两个包都只当辅助步骤）。
- 契约标记 `frontend: none`（15）：notes_create, notes_delete, notes_get, notes_get_subject_rag_config, notes_invalidate_resource_refs, notes_list, notes_list_advanced, notes_list_meta, notes_rag_rebuild_fts_index, notes_rebuild_links, notes_relation_get, notes_set_favorite, notes_unlinked_mentions, notes_update_subject_rag_config, rag_rebuild_fts_index。

WP-051 时列在 `frontend: none` 下的 notes_get_backlinks、notes_get_outgoing_links、notes_migrate_blocks、notes_transfer_blocks、notes_undo_transfer 实际有前端调用点，已由 WP-230 覆盖（§9.8）。

本包内仍未覆盖、需要后续处理的分支：
- 历史中带 columns 能力的格式（`notes_enable_columns` 后的历史选区、`History format lacks required columns capability`），留给覆盖 notes_enable_columns 的包。
- §4 的种子场景（owner X3）。
- §5 的窗口/重载/重启/TTL 场景（owner X7 运行器扩展，A 端由 X7 答案机实现）。

## 8. 复核方法

场景 JSON 由临时生成脚本输出，脚本不提交。最小校验（经作业队列运行）检查：JSON 可解析；顶层与场景键严格符合 WAVE0 §3 v0；id 全局唯一；每步 cmd 在 L10/L13 契约中；成功步骤的参数键是契约键的子集且必填齐全（只有 `expect:"error"` 步骤允许故意多键/缺键）；`${n.…}` 只指向更早的非错误步骤；capture/normalize 固定；`history.json` 原文保留 `9007199254740993`。

## 9. WP-230：G3 命令语料 v1（46 条前端可达命令）

命令清单来自 `.oc-runs/board/corpus/WP-230-L10-notes.md`（46 条）。另外按任务要求给 `notes_history_get_retention` 补了 2 个成功步骤；这条命令没有可达的业务 Err（§9.4）。本包只新增场景 JSON 和本节，没有改实现、契约、TESTMAP、运行器或 ledger。

### 9.1 文件与场景

| 文件 | 场景代号 | 步骤 | 目标命令 |
|---|---|---|---|
| `canvas.json` | C1–C4 | 76 | canvas_note_read/append/replace/set，chat_v2_canvas_edit_ack/result |
| `assets.json` | A1–A3 | 72 | notes_save_asset、list_assets、resolve_asset_path、delete_asset、assets_index_scan、assets_scan_orphans、assets_bulk_delete |
| `trash.json` | T1–T2 | 38 | notes_list_deleted、restore、hard_delete、empty_trash |
| `format_transfer.json` | F1–F4、V1 | 124 | notes_get_format、enable_columns、migrate_blocks、transfer_blocks、undo_transfer、review_save_as |
| `state_relations.json` | S1、R1 | 91 | notes_state_get/list/put/delete，notes_relation_list/put/delete，list_referencing_resource，reference_status |
| `import_export.json` | I1–I3 | 64 | notes_export、export_single、import、import_markdown、import_markdown_batch |
| `search_links_prefs.json` | Q1–Q3 | 69 | notes_search、list_tags、mentions_search、get_backlinks、get_outgoing_links、get_pref、set_pref、db_stats、db_vacuum、history_get_retention |

场景代号：
- C1 `notes.canvas.read_append_sections_and_missing_notes`
- C2 `notes.canvas.replace_literal_regex_and_errors`
- C3 `notes.canvas.format_guards_columns_blocks_and_markers`
- C4 `notes.canvas.chat_edit_ack_and_result_without_pending_request`
- A1 `notes.assets.save_list_resolve_delete_and_segment_validation`
- A2 `notes.assets.reference_guard_orphans_and_bulk_delete`
- A3 `notes.assets.history_reference_keeps_asset`
- T1 `notes.trash.list_restore_hard_delete`
- T2 `notes.trash.empty_trash`
- F1 `notes.format.get_and_enable_columns_under_lease`
- F2 `notes.format.migrate_blocks_validation_and_success`
- F3 `notes.transfer.move_replay_undo_and_errors`
- F4 `notes.transfer.id_collision_present_block_and_deleted_page`
- V1 `notes.review.save_as_replay_update_and_conflicts`
- S1 `notes.state.put_get_list_delete_revisions`
- R1 `notes.relations.put_list_delete_reference_status`
- I1 `notes.export.full_single_and_errors`
- I2 `notes.import.zip_strategies_and_errors`
- I3 `notes.import_markdown.single_batch_encodings_and_errors`
- Q1 `notes.search.keyword_tags_limits_and_list_tags`
- Q2 `notes.links.mentions_backlinks_outgoing`
- Q3 `notes.prefs_db_and_retention_read`

合计：22 个场景、534 步。其中目标命令成功步骤 193、错误标注步骤 201、辅助步骤 140。47 条目标命令（46 条加 retention 读取）每条至少有 1 个真实成功步骤；没有把“命令不存在”或空参数失败算作成功。

和 WP-051 有一处写法差异：WP-230 文件的顶层 `commands` 列出了该文件用到的**全部**命令，包括辅助命令（与 WAVE0 §3 示例一致）；WP-051 的 `history.json`/`lease.json` 只列目标命令。覆盖口径以本节表格为准，辅助命令出现在 `commands` 里不代表本包覆盖了它。

### 9.2 写法约定（在 §1 基础上补充）

1. 每个有写操作的场景，第 0 步都是 `notes_history_set_retention {policy:{edit_bucket_seconds:0,max_edit_versions:null}}`。
2. blocks 文档：每块写成 `<!-- ds:block-id=<id> -->\n<正文>\n`，块之间用 `\n` 连接。对应的旧格式文档是同样的正文加 `\n` 再以 `\n` 连接。所以去掉标记后与旧文本逐字节相等，`notes_migrate_blocks` 的成功步骤（F2:12）依赖这一点。
3. 导入用的文件不是外部夹具：先用 `notes_save_asset` 把 base64 写进应用数据目录，再把返回的 `absolute_path`（整串引用）传给 `notes_import*`。“文件不存在”分支是先 save 再 `notes_delete_asset`，然后传原路径。I2 的 zip 来自同场景 `notes_export` 返回的 `output_path`。
4. `absolute_path`/`output_path` 含每个场景各自的数据目录，A 端两次录制会不同，应由“录两次自动规范化”处理；`normalize` 仍为空。
5. 带 lease 的成功步骤（F1:15）用 `notes_editor_register/begin/freeze_ack/flush/release/unregister` 搭租约，这些都算辅助步骤。“伪 lease”错误步骤用不存在的 participant_id，期望 A 端报 `notes.participant_expired`。
6. `notes_list_deleted` 的成功步骤里有一步保留前端原形状 `{subject,page,page_size}`（T1:8）。其余步骤用契约键 `pageSize`，见 §9.8。

### 9.3 每命令覆盖表

Rust 路径相对 `src-tauri/`。仓储简称同 §2：hr = `note_history_restore.rs`。所有命令共有的 `VFS database not configured`、`get_conn_safe` 失败、`spawn_blocking` join 失败，在空库正常启动下不可达，表中不再重复。

| 命令 | 前端 | Rust | 成功/错误步数 | 成功与早退分支（场景:步骤） | 错误分支（场景:步骤） | 未覆盖分支与理由 |
|---|---|---|---|---|---|---|
| `canvas_note_read` | `src/utils/notesApi.ts:361` | `cmd/notes.rs:1363` | 11/6 | 全文（无 section） C1:2；空白 section 视为全文 C1:3；标题文本匹配（忽略 ATX 收尾 #） C1:4；带 # 前缀同级、忽略大小写 C1:5；追加后回读 C1:12；设置后回读 C1:15；空笔记追加后回读 C1:18；替换后回读 C2:8；columns 页读取不受能力限制 C3:11；blocks 页章节读取 C3:19；导入后回读（canvas 读，不计 import 覆盖） I2:10 | `#` 前缀级别不同 `章节 … 未找到` C1:6；代码块内伪标题不算章节 C1:7；章节不存在 C1:8；不存在 `笔记不存在或已被删除` C1:19；软删 C1:23；IPC 缺 noteId C1:26 | — |
| `canvas_note_append` | `src/utils/notesApi.ts:375` | `cmd/notes.rs:1385` | 3/7 | 全文追加（trim_end+空行） C1:9；章节追加 C1:10；空笔记追加即设置 C1:17 | 章节不存在 C1:11；不存在 C1:20；软删 C1:24；IPC 缺 content C1:27；旧格式追加 columns `Enable ds-columns-v1 explicitly…` C3:3；columns 页无能力 C3:9；blocks 页追加无标记段 C3:16 | — |
| `canvas_note_replace` | `src/utils/notesApi.ts:392` | `cmd/notes.rs:1410` | 7/8 | 字面替换（计数 2） C2:2；isRegex 缺省按字面 C2:3；0 处匹配不写 C2:4；正则捕获组替换 C2:5；正则 0 处匹配 C2:6；正则元字符按字面 C2:7；blocks 页保留标记的替换 C3:17 | `搜索内容不能为空` C2:9；空搜索先于笔记查找 C2:10；`无效的正则表达式`（括号不配对） C2:11；`无效的正则表达式`（lookahead 不支持） C2:12；不存在 C2:13；软删 C2:15；IPC 缺 replace C2:16；columns 页无能力 C3:10 | — |
| `canvas_note_set` | `src/utils/notesApi.ts:404` | `cmd/notes.rs:1437` | 3/8 | 整体设置 C1:13；相同内容再次设置 C1:14；blocks 页写入完整块文档 C3:18 | 不存在 C1:21；软删 C1:25；IPC 缺 content C1:28；旧格式写入带标记内容 `Use notes_migrate_blocks…` C3:2；未知 ds: 头 `Unsupported note schema/marker` C3:4；容器外列分隔符 `Column delimiter outside a container` C3:5；columns 页无能力 `This page requires the ds-columns-v1 writer capability` C3:8；blocks 页写入无标记内容（blocks 解析错） C3:15 | — |
| `chat_v2_canvas_edit_ack` | `src/features/notes/hooks/useCanvasAIEditHandler.ts:394,448`、`src/features/notes/aiReview.ts:222` | `chat_v2/handlers/canvas_handlers.rs:49` | 1/3 | 无挂起回调返回 Ok C4:0 | `request_id must not be empty` C4:1；空白 requestId C4:2；IPC 缺 requestId C4:3 | 有挂起回调时的送达分支需 chat_v2 管线/LLM 模拟发出 `canvas:ai-edit-request`（owner X5 + chat 域） |
| `chat_v2_canvas_edit_result` | `useCanvasAIEditHandler.ts:147,522`、`aiReview.ts:29` | `canvas_handlers.rs:28` | 2/4 | 成功结果，无挂起回调 C4:4；失败结果（前端 aiReview 拒绝路径） C4:5 | 空 requestId C4:6；空白 requestId C4:7；IPC 缺 success C4:8；IPC 缺 result C4:9 | 同 ack：挂起回调被消费的分支需管线模拟 |
| `notes_assets_bulk_delete` | `src/utils/notesApi.ts:290` | `cmd/notes.rs:2167` | 3/5 | 删除 1 个孤儿 A2:14；空列表返回 0 A2:15；不存在计 0 A2:16 | 被引用 `批量删除资产安全链失败` A2:13；非原子：先删前项再报 `资产路径无效` A2:17；空路径 `资产路径无效` A2:18；IPC 缺 paths A2:19；保留历史引用阻挡批删 A3:9 | — |
| `notes_assets_index_scan` | `src/utils/notesApi.ts:284` | `cmd/notes.rs:1972` | 2/2 | 计数 A1:9；目录不存在为 0 A1:10 | `非法` A1:35；IPC 缺 noteId A1:36 | 单段 `含非法路径成分` 在 Linux 上不可达（分隔符与 `..` 先被拦） |
| `notes_assets_scan_orphans` | `src/utils/notesApi.ts:287` | `cmd/notes.rs:2004` | 5/1 | 列出未被引用资产 A2:8；subject 缺省 _global A2:9；无文件返回空 A2:10；软删笔记仍算引用 A2:22；保留历史中的引用不算孤儿 A3:7 | IPC subject 非字符串 A2:11 | subject 未校验（`..` 穿越）只报缺陷，不写成场景；目录读失败需故障注入 |
| `notes_db_stats` | `src/utils/notesApi.ts:229` | `cmd/notes.rs:2960` | 3/0 | 空库统计 Q3:12；有笔记后统计 Q3:15；VACUUM 后统计 Q3:17 | — | 无业务 Err，只有连接/查询失败（空库不可达） |
| `notes_db_vacuum` | `src/utils/notesApi.ts:232` | `cmd/notes.rs:3020` | 1/0 | VACUUM Q3:16 | — | 无业务 Err，只有连接/VACUUM 失败（空库不可达） |
| `notes_delete_asset` | `src/utils/notesApi.ts:201` | `cmd/notes.rs:1898` | 5/6 | 删除未引用资产 A1:17；已删除再删返回 false A1:18；不存在返回 false A1:19；前导 / 被剥离 A1:20；删除剩余孤儿 A2:24 | `拒绝删除：资产路径无效`（空） A1:21；`拒绝删除：资产路径无效`（..） A1:22；IPC 缺 relativePath A1:23；被引用 `删除资产安全链失败` A2:12；软删笔记的引用仍阻挡删除 A2:23；保留历史引用阻挡删除 A3:8 | 删除队列/文件系统失败需故障注入 |
| `notes_empty_trash` | `src/utils/notesApi.ts:263` | `cmd/notes.rs:1595` | 3/1 | 空回收站返回 0 T2:1；清空 2 条 T2:7；subject 缺省 T2:9 | IPC subject 非字符串 T2:10 | — |
| `notes_enable_columns` | `src/features/notes/noteEditorHost.ts:144` | `cmd/notes.rs:628` | 3/6 | 带 lease 启用（前端 noteEditorHost 路径），emit format-changed F1:15；已启用早退（不写） F1:19；blocks 页启用（serializer blocks-v1+ds-columns-v1） F1:28 | `notes.conflict` F1:5；`Note missing` F1:6；IPC 缺 expectedUpdatedAt F1:7；租约中无 lease `notes.lease_conflict` F1:13；伪 lease `notes.participant_expired` F1:14；软删 `Note missing` F1:32 | — |
| `notes_export` | `src/utils/notesApi.ts:304` | `cmd/notes.rs:2363` | 4/4 | 全量导出到 exports 目录（output_path 缺省） I1:4；不含版本 I1:5；指定 app data 内输出路径（覆盖已存在文件） I1:6；subjects 参数 I1:7 | 空库 `没有可导出的笔记` I1:1；空 output_path `路径不能为空` I1:8；IPC 缺 request I1:9；只剩软删笔记 `没有可导出的笔记` I1:17 | 写 zip 失败需故障注入 |
| `notes_export_single` | `src/utils/notesApi.ts:325` | `cmd/notes.rs:2447` | 2/4 | 单篇导出 I1:10；subject 缺省、不含版本 I1:11 | `未找到要导出的笔记` I1:12；空 output_path I1:13；IPC 缺 note_id I1:14；软删笔记不可单篇导出 I1:16 | 同上 |
| `notes_get_backlinks` | `src/features/workbench/apps/notes/backlinksBackend.ts:47` | `cmd/notes.rs:3384` | 3/3 | 别名与小节链接，代码内链接忽略 Q2:9；无反链 Q2:10；移除链接后 Q2:18 | 不存在 `查询反链失败` Q2:13；IPC 缺 noteId Q2:14；目标软删 `查询反链失败` Q2:20 | — |
| `notes_get_format` | `noteEditorHost.ts:46`、`src/components/crepe/blockTransfer/service.ts:148` | `cmd/notes.rs:595` | 6/2 | 旧格式 F1:2；启用后 required_capabilities F1:20；写入 columns 内容后 F1:23；blocks+columns F1:29；软删笔记仍可读格式 F1:31；markdown-blocks F2:13 | `Note not found` F1:3；IPC 缺 noteId F1:4 | 不支持的格式行需种子（X3） |
| `notes_get_outgoing_links` | `backlinksBackend.ts:54` | `cmd/notes.rs:3403` | 3/1 | 出链（含未解析目标） Q2:11；不存在笔记返回空（无存在性检查） Q2:12；软删笔记出链 Q2:21 | IPC 缺 noteId Q2:15 | — |
| `notes_get_pref` | `src/utils/notesApi.ts:215`、`src/features/notes/NotesContext.tsx:474` | `cmd/notes.rs:2326` | 4/1 | 不存在返回 null Q3:0；回读 Q3:2；读空值 Q3:5；读空键 Q3:7 | IPC 缺 key Q3:11 | — |
| `notes_hard_delete` | `src/utils/notesApi.ts:266` | `cmd/notes.rs:1462` | 4/1 | 彻底删除回收站项 T1:20；再次删除返回 false T1:21；不存在返回 false T1:22；活动笔记也被彻底删除（缺陷候选） T1:23 | IPC 缺 id T1:26 | — |
| `notes_import` | `src/utils/notesApi.ts:341` | `cmd/notes.rs:2544` | 6/4 | 策略缺省（skip），emit notes-import-progress I2:3；skip I2:4；merge_keep_newer（本地更新，保留本地） I2:7；overwrite I2:8；未知策略按 skip I2:9；原笔记已彻底删除，重新导入 I2:12 | 非 zip `读取归档文件失败` I2:14；`文件不存在` I2:17；`路径不能为空` I2:18；IPC 缺 file_path I2:19 | zip 内条目损坏/清单错误需构造 zip 种子（X3） |
| `notes_import_markdown` | `src/dstu/adapters/notesDstuAdapter.ts:225` | `cmd/notes.rs:2668` | 7/4 | 前导 H1 作标题并从正文移除 I3:9；titleHint 作标题 I3:10；无 H1 无提示，用文件名 I3:11；UTF-8 BOM I3:12；UTF-16LE BOM I3:13；GBK I3:14；空白 titleHint 与 folderId 归一为 None I3:15 | `Markdown 文件路径不能为空` I3:16；`文件不存在` I3:17；文件夹不存在 `导入 Markdown 笔记失败` I3:18；IPC 缺 filePath I3:19 | — |
| `notes_import_markdown_batch` | `notesDstuAdapter.ts:248` | `cmd/notes.rs:2722` | 3/3 | 空 items 早退 I3:20；两项成功 I3:21；逐项失败进入 failed（文件夹不存在） I3:22 | 空白路径整批 Err I3:23；文件不存在整批 Err I3:24；IPC 缺 items I3:25 | — |
| `notes_list_assets` | `src/utils/notesApi.ts:193` | `cmd/notes.rs:1879` | 4/3 | 列出资产 A1:7；目录不存在返回空 A1:8；删除后列出 A1:24；批删后列出（o2 已被前项删除） A2:20 | `不允许包含路径分隔符` A1:32；subject `非法` A1:33；IPC 缺 noteId A1:34 | 同 save_asset；noteId 段是否经 `resolve_note_assets_dir` 校验以 A 端实际结果为准 |
| `notes_list_deleted` | `src/utils/notesApi.ts:260` | `cmd/notes.rs:1782` | 9/1 | 空回收站 T1:1；前端形状（page_size 被 Tauri 忽略，按缺省 20） T1:8；pageSize 2 第 0 页 T1:9；pageSize 2 第 1 页 T1:10；全部缺省（page 0 / 20） T1:11；负 page 经 u32 回绕（缺陷候选） T1:12；负 pageSize 经 u32 回绕（缺陷候选） T1:13；操作后列表 T1:24；清空后列表 T2:8 | IPC page 非整数 T1:14 | `page*pageSize` 乘法溢出只报缺陷，不写成场景 |
| `notes_list_referencing_resource` | `src/features/pdf/components/PdfRelatedPanel.tsx:28` | `cmd/notes.rs:835` | 4/1 | 经关系匹配 R1:24；空白跳过、无匹配 R1:25；空列表 R1:26；排除软删的源笔记 R1:47 | IPC 缺 resourceIds R1:27 | `props._origin` 匹配没有前端命令能写入，需种子（X3） |
| `notes_list_tags` | `src/utils/notesApi.ts:236` | `cmd/notes.rs:3040` | 4/1 | 空库 Q1:1；标签列表 Q1:20；subject 缺省 Q1:21；软删后标签 Q1:25 | IPC subject 非字符串 Q1:22 | — |
| `notes_mentions_search` | `src/utils/notesApi.ts:278` | `cmd/notes.rs:3202` | 5/2 | 笔记命中（并查 mistakes 表） Q2:3；limit 0→1 Q2:4；limit 100→40 Q2:5；空白关键词返回缺省空响应 Q2:6；软删后提及 Q2:22 | IPC 缺 keyword Q2:7；IPC limit 负数（u32） Q2:8 | 错题命中需 mistakes 表种子（owner chat/mistakes 域） |
| `notes_migrate_blocks` | `blockTransfer/service.ts:159` | `cmd/notes.rs:677` | 1/11 | 迁移成功（前端 blockTransfer service 路径），emit format-changed F2:12 | `notes.conflict` F2:3；`Note missing` F2:4；无标记 `Every root Markdown node requires a block marker` F2:5；重复 id `Duplicate or consecutive block marker` F2:6；尾段无标记 `Unmarked Markdown content` F2:7；尾部空标记 `Incomplete block document` F2:8；改正文 `Migration may only insert root block markers` F2:9；伪 lease `participant_expired` F2:10；IPC 缺 content F2:11；`Page already uses stable blocks` F2:15；软删 `Note missing` F2:17 | — |
| `notes_reference_status` | `src/features/notes/noteRelations.ts:49` | `cmd/notes.rs:899` | 7/3 | 块存在 R1:15；块不存在 R1:16；资源不存在 R1:17；note 资源 page 定位为 false R1:18；card 定位查 Anki 库（空库 false/false） R1:19；question 定位（空库 false） R1:20；目标软删后 resource_exists=false R1:51 | IPC page 负数（u32） R1:21；IPC 未知 locator 类型 R1:22；IPC 缺 locator R1:23 | card 定位为 true 需 Anki 库种子（`document_tasks`/`anki_cards`）；question 为 true 需 mistakes 种子；page 为 true 需 files/exam 种子 |
| `notes_relation_delete` | `noteRelations.ts:45` | `cmd/notes.rs:888` | 1/4 | 删除 R1:41 | 旧 revision `notes.relation_conflict` R1:40；重复删除 R1:42；不存在 R1:43；IPC 缺 expectedRevision R1:44 | — |
| `notes_relation_list` | `noteRelations.ts:38` | `cmd/notes.rs:744` | 5/1 | 空列表 R1:7；按 id 排序列表 R1:13；不存在笔记返回空 R1:14；删除后列表 R1:45；源软删后仍按 note_id 列出 R1:48 | IPC 缺 noteId R1:52 | — |
| `notes_relation_put` | `noteRelations.ts:40` | `cmd/notes.rs:874` | 3/15 | 整篇 source 关系 R1:8；按 revision 改为块定位 R1:10；type 映射形式（列表按 id 排序在前） R1:12 | 仅创建重复 `notes.relation_conflict` R1:9；旧 revision `notes.relation_conflict` R1:11；`Relation ID required` R1:28；card 关系配 whole `card/mistake relations require the corresponding typed locator` R1:29；mistake 关系配 block R1:30；`Owner note missing` R1:31；`Owner block missing` R1:32；`Referenced resource or locator missing`（资源） R1:33；定位块不存在 R1:34；page 0 R1:35；card 定位在空 Anki 库 R1:36；question 定位不存在 R1:37；IPC 未知字段（deny_unknown_fields） R1:38；IPC 缺 resource_id R1:39；源软删 `Owner note missing` R1:49 | card/question/page 定位成功需同上种子；本场景只写正确的 A 输入并在空库下得到 `Referenced resource or locator missing` |
| `notes_resolve_asset_path` | `src/utils/notesApi.ts:206` | `cmd/notes.rs:1926` | 3/3 | 相对路径解析 A1:11；app data 内绝对路径 A1:12；不存在的子树内路径返回拼接路径 A1:13 | `拒绝访问：路径包含上级目录跳转` A1:14；`拒绝访问：超出应用数据目录` A1:15；IPC 缺 relativePath A1:16 | — |
| `notes_restore` | `src/utils/notesApi.ts:269` | `cmd/notes.rs:1836` | 2/3 | 恢复 T1:15；同名冲突改名为 “回收乙 (1)” T1:19 | 已恢复再恢复 `VFS 恢复笔记失败` T1:16；不存在 T1:17；IPC 缺 id T1:25 | — |
| `notes_review_save_as` | `src/features/notes/noteReviewHost.ts:92` | `cmd/notes.rs:648` | 5/12 | 首次另存（标题去重为 “（AI 审阅副本） (1)”），emit review-saved V1:3；相同请求重放返回回执 V1:4；带上次 token 更新副本（revision 2） V1:6；columns 结果带能力 V1:15；源软删后重放已有回执 V1:21 | 同 (op, step) 不同请求 `notes.review_request_reused` V1:5；已有 op、旧 token（CAS `notes.conflict`） V1:7；同 op 不同源 `notes.operation_id_reused` V1:9；无 op 却带 token `notes.review_conflict` V1:10；空白 operationId V1:11；空 token `Review operation ID and a nonempty update token are required` V1:12；`Review source note missing` V1:13；`Review result requires ds-columns-v1 capability` V1:14；未知 ds: 头 `Unsupported note schema/marker` V1:16；伪 lease `participant_expired` V1:17；IPC 缺 markdown V1:18；源已软删 `Review source note missing` V1:20 | 已有 op 且 token 为 null 的 `notes.review_conflict` 在 v0 不可达（需种子） |
| `notes_save_asset` | `src/utils/notesApi.ts:182` | `cmd/notes.rs:1858` | 10/7 | data URL png（忽略 defaultExt） A1:2；纯 base64 + defaultExt md A1:3；defaultExt 缺省 jpg A1:4；空白 subject 归一为 _global A1:5；不校验笔记是否存在（缺陷候选） A1:6；被引用资产 A2:2；孤儿资产 1 A2:3；孤儿资产 2 A2:4；孤儿资产 3 A2:5；历史版本引用的资产 A3:2 | `base64解码失败` A1:25；`note_id 不能为空` A1:26；`不允许包含路径分隔符` A1:27；`非法`（..） A1:28；subject `含盘符前缀` A1:29；ext 未校验，`写入资源失败`（缺陷候选） A1:30；IPC 缺 base64Data A1:31 | 单段 `含非法路径成分` 在 Linux 上不可达 |
| `notes_search` | `src/utils/notesApi.ts:252` | `cmd/notes.rs:3129` | 11/2 | FTS 关键词（≥3 字符） Q1:8；短词回退 LIKE Q1:9；单标签 Q1:10；多标签 AND Q1:11；标签加文本 Q1:12；只有 `tag:` Q1:13；空白关键词返回 [] Q1:14；limit 0→1 Q1:15；limit 1000→200 Q1:16；limit 缺省 50 Q1:17；软删后不再命中 Q1:24 | IPC 缺 keyword Q1:18；IPC limit 非整数 Q1:19 | — |
| `notes_set_pref` | `src/utils/notesApi.ts:212`、`NotesContext.tsx:1407` | `cmd/notes.rs:2313` | 4/3 | 写入（前端 NotesContext 形状） Q3:1；覆盖 Q3:3；空值 Q3:4；空键（无校验） Q3:6 | IPC 缺 value Q3:8；IPC 缺 key Q3:9；IPC value 非字符串 Q3:10 | — |
| `notes_state_delete` | `src/features/notes/aiReviewPersistence.ts:34`、`src/features/notes/noteDraftPersistence.ts:52` | `cmd/notes.rs:720` | 1/5 | 删除留墓碑，emit state-changed S1:13 | 旧 revision 删除 `notes.state_conflict` S1:12；删除不存在的键 `notes.state_conflict` S1:19；`Note missing or deleted` S1:27；IPC 缺 expected_revision S1:32；软删 S1:37 | — |
| `notes_state_get` | `aiReviewPersistence.ts:26` | `cmd/notes.rs:696` | 3/4 | 不存在返回 null S1:2；读取 S1:10；墓碑可读（value null, deleted true） S1:14 | get 空键 S1:23；`Note missing or deleted` S1:24；IPC 未知字段（deny_unknown_fields） S1:28；软删 `Note missing or deleted` S1:34 | — |
| `notes_state_list` | `aiReviewPersistence.ts:29`、`noteDraftPersistence.ts:37` | `cmd/notes.rs:703` | 4/3 | 空列表 S1:3；include_deleted 缺省 S1:11；列表隐藏墓碑 S1:15；include_deleted 显示墓碑 S1:16 | `Note missing or deleted` S1:25；IPC 未知字段 S1:29；软删 S1:35 | — |
| `notes_state_put` | `aiReviewPersistence.ts:31`、`noteDraftPersistence.ts:26` | `cmd/notes.rs:710` | 6/9 | 首次写入 revision 1，emit state-changed S1:4；按 revision 更新 S1:6；review 类型，expected_revision 缺省 S1:8；type 映射形式 S1:9；按墓碑 revision 复活 S1:18；512 字节键边界 S1:22 | 已存在但 revision null `notes.state_conflict` S1:5；旧 revision `notes.state_conflict` S1:7；墓碑上以 null 新建 `notes.state_conflict` S1:17；空键 `State key must contain 1..512 bytes` S1:20；513 字节键 S1:21；`Note missing or deleted` S1:26；IPC type 非 review/draft S1:30；IPC 缺 value S1:31；软删 S1:36 | — |
| `notes_transfer_blocks` | `blockTransfer/service.ts:194,211` | `cmd/notes.rs:556` | 3/19 | 搬移成功，emit transfer-completed F3:24；相同请求重放返回回执 F3:25；撤销后重放搬移返回撤销结果 F3:35 | 未迁移 `Migrate both pages to stable blocks first` F3:5；空白 operation_id `Operation ID, distinct pages and both OCC tokens are required` F3:10；源=目标 F3:11；空 OCC token F3:12；`notes.conflict` F3:13；`Transfer page missing or deleted` F3:14；`block_ids must be nonempty and unique`（空） F3:15；`block_ids must be nonempty and unique`（重复） F3:16；`Selected block missing in source or already present in target` F3:17；改变目标顺序 `Transfer must preserve every block body, identity and relative order` F3:18；改动块正文 F3:19；source_content 无标记（blocks 解析错） F3:20；伪 lease `participant_expired` F3:21；IPC 未知字段（deny_unknown_fields） F3:22；IPC 缺 block_ids F3:23；同 operation 不同请求 `notes.operation_id_reused` F3:26；未选中块 id 冲突 `Source and target block IDs collide` F4:9；所选块已在目标 `Selected block missing in source or already present in target` F4:10；目标已软删 `Transfer page missing or deleted` F4:12 | — |
| `notes_undo_transfer` | `blockTransfer/service.ts:221` | `cmd/notes.rs:572` | 2/5 | 撤销恢复原字节 F3:33；撤销重放幂等 F3:34 | `Transfer operation missing` F3:29；搬移前 token `notes.undo_conflict` F3:30；伪 lease `participant_expired` F3:31；IPC 缺 expectedTargetUpdatedAt F3:32；IPC 缺 operationId F4:13 | — |
| `notes_history_get_retention` | `src/utils/notesApi.ts:171` | `cmd/notes.rs:934` | 2/0 | 读取保留策略（无业务 Err） Q3:18；多余参数被 Tauri 忽略，仍成功 Q3:19 | — | 无业务 Err（hr `:40-51` 只读默认值或已存策略）；Tauri 忽略多余参数，Q3:19 记录这一点。不加伪造的错误步；逐条文件:行见 §10 |

### 9.4 没有错误步骤的命令

| 命令 | 理由 |
|---|---|
| `notes_history_get_retention` | 处理函数 `cmd/notes.rs:934` 只读已存策略或返回默认值（hr `:40-51`），没有业务 Err；命令无必填参数，Tauri 会忽略多余参数（Q3:19 记录了这一点）。只剩上面那些共有的基础设施错误，空库下不可达。因此不加伪造的错误步骤（逐条文件:行见 §10） |
| `notes_db_stats` | `cmd/notes.rs:2960` 只有连接和统计查询失败两种 Err，空库下不可达 |
| `notes_db_vacuum` | `cmd/notes.rs:3020` 只有连接和 `VACUUM` 执行失败两种 Err，空库下不可达 |

### 9.5 辅助步骤（不计覆盖，共 140）

| 命令 | 步数 | 用途 |
|---|---|---|
| `dstu_create` | 36 | 建笔记（L13-vfs-api，见 §1 第 3 条） |
| `notes_history_current` | 29 | 取字符串 `updated_at` 作 CAS token |
| `notes_history_set_retention` | 21 | 每个写场景的第 0 步 |
| `dstu_delete` | 18 | 软删笔记，测“已软删”分支 |
| `notes_save_asset` | 9 | 写导入用的源文件（I2、I3） |
| `notes_migrate_blocks` | 8 | 把页面迁成 blocks，供 transfer/canvas/format 场景使用 |
| `notes_update` | 8 | 改正文，制造 CAS 冲突或历史版本 |
| `notes_editor_*`（register/begin/freeze_ack/flush/release/unregister） | 6 | F1 的租约 |
| `notes_delete_asset` | 2 | 构造“文件不存在” |
| `notes_enable_columns`、`notes_hard_delete`、`notes_export` | 各 1 | 搭状态（columns 页、彻底删除后重新导入、导出 zip） |

### 9.6 需要其他 owner 的种子或模拟

这些分支在空库里得不到成功结果。场景中仍按前端真实形状写了正确的 A 输入，A 端在空库下的实际返回就是答案。

| 分支 | 需要 | owner |
|---|---|---|
| `notes_mentions_search` 命中错题 | mistakes 表种子 | chat/mistakes 域 + X3 |
| `notes_reference_status`/`notes_relation_put` 的 `card` 定位为真 | Anki 库种子（`document_tasks`、`anki_cards`） | Anki 域 + X3 |
| `question` 定位为真 | mistakes/exam 种子 | chat/mistakes、exam 域 + X3 |
| `page` 定位为真（PDF/文件资源） | files/exam 资源种子 | files 域 + X3 |
| `notes_list_referencing_resource` 经 `props._origin` 匹配 | 带 `_origin` 的 props；没有前端命令能写入 | X3 |
| `chat_v2_canvas_edit_ack/result` 消费挂起回调 | chat_v2 管线发出 `canvas:ai-edit-request`，需 LLM 模拟 | X5 + chat 域 |
| `notes_review_save_as` 已有 op 且 token 为 null 的 `notes.review_conflict` | v0 构造不出这个状态 | X3 |
| `notes_get_format` 不支持的格式行 | 不支持的 `note_document_formats` 行 | X3 |
| `notes_import` 损坏条目/清单错误 | 手工构造的 zip | X3 |
| 资产删除/导出写失败 | 文件系统故障注入 | X7 |

运行器前提同 §1：整串引用替换为原始类型值，数字无损读取（owner X7）。

### 9.7 缺陷候选（只报告，未改实现，未写成场景的已注明）

1. `notes_save_asset` 不检查笔记是否存在：对不存在的 noteId 也会写盘（A1:6）。
2. `notes_save_asset` 的 `defaultExt` 未校验：`sub/md` 会拼进文件名，最后报 `写入资源失败`（A1:30），而不是参数校验错误。
3. `notes_list_deleted` 的负数 `page`/`pageSize` 经 `as u32` 回绕成很大的数（T1:12、T1:13）；`page*pageSize` 还可能乘法溢出。溢出那一步**没有**写成场景，避免 A 端 panic 污染录制。
4. `notes_hard_delete` 不要求笔记在回收站：活动笔记也会被彻底删除（T1:23）。
5. `notes_assets_scan_orphans` 不校验 `subject`（`cmd/notes.rs:2020`，`base_dir.join("notes_assets").join(&subject)`）：`..` 或绝对路径可以让它递归遍历资产根以外的目录。返回值只保留 `strip_prefix(base_dir)` 成功的路径，所以数据目录外的文件不会被列出，但仍会被遍历和读取目录项。**没有**写成场景。
6. `notes_assets_bulk_delete` 不是原子操作：前面的路径已被删除后，后面的非法路径才报 `资产路径无效`（A2:17、A2:20）。
7. 前端 `notesApi.ts:260` 给 `notes_list_deleted` 传 `page_size`，Rust 参数名是 `pageSize`，所以前端的每页条数被静默忽略，固定为缺省 20（T1:8）。

### 9.8 契约差异（只报告，未改 `contracts/`）

- `contracts/ipc/L10-notes.json` 把以下 5 条标为 `frontend: none`，但它们都有前端调用点：`notes_get_backlinks`（`backlinksBackend.ts:47`）、`notes_get_outgoing_links`（`:54`）、`notes_migrate_blocks`（`blockTransfer/service.ts:159`）、`notes_transfer_blocks`（`:194,211`）、`notes_undo_transfer`（`:221`）。
- `notes_list_deleted`：契约键 `pageSize`，前端实际发送 `page_size`（§9.7 第 7 条）。
- §2.2 已报告的 `notes_editor_flush` 标记问题仍存在。

### 9.9 复核方法

- 生成：`/tmp/opencode/wp230-gen.mjs`（临时脚本，不提交）。生成时自检：顶层与场景键符合 v0；id 全局唯一；`${n.…}` 只用整串引用，且只指向更早的非错误步骤；每条目标命令至少 1 个成功步骤；按标签汇总成功/错误步数。作业 20261106024342-b907c6，exit 0，errors 为空。
- 独立校验：`/tmp/opencode/wp230-check.mjs` 读取本目录全部 9 个 JSON（42 个场景、929 步），检查 domain、seed、capture、normalize、`expect` 取值、id 跨文件唯一、引用规则。作业 20261106025100-93cb6a，exit 0，errors 为空。
- 没有执行 A/B 重放，也没有跑 Rust 或前端测试。

## 10. notes_history_get_retention 不写错误场景的理由（WP-267；原分支 §9，合并 main 的 §9 后顺延）

`notes_history_get_retention` 没有前端可达的业务 Err 或提前返回，所以本目录不加 `expect: "error"` 场景。Rust 路径相对 `src-tauri/`。

- **命令入口** `src/cmd/notes.rs:934-939`：只有 `State<AppState>`，没有可反序列化的参数；前端 `src/utils/notesApi.ts:171` 也不传参数。多余键或错类型都会被忽略，不存在参数错误。
- **仓储** `crates/dstu-vfs/src/vfs/repos/note_history_restore.rs:40-51`：只有一次 `query_row`，没有 `invalid(..)`/`conflict(..)`，也没有提前返回。`?` 只传播 rusqlite 错误，经 `crates/dstu-vfs/src/vfs/error.rs:269-273` 变成 `VfsError::Database`，再由 `note_storage`（`src/cmd/notes.rs:313-321`）映射为 `AppError::database`。这类错误只在 DB 故障时出现：
  - 行缺失（`QueryReturnedNoRows`）：迁移 `migrations/vfs/V20260923__note_history_integration.sql:8` 以 `INSERT OR IGNORE` 写入 id=1 行，`id` 有 `CHECK (id = 1)`（`:3`）。非测试代码里没有 `DELETE FROM note_history_retention`；唯一写入 `set_retention`（`note_history_restore.rs:70`）只做 `UPDATE ... WHERE id=1`。迁移校验还把这条查询列为 expected query（`crates/dstu-storage/src/migration/vfs.rs:1052-1055`）。同步分类为 BackupOnly（`crates/dstu-sync/src/data_governance/sync/classification.rs:662-670`），同步不会改这行。
  - 列类型不符（`InvalidColumnType`）：`edit_bucket_seconds` 为 `INTEGER NOT NULL CHECK (BETWEEN 0 AND 86400)`，`max_edit_versions` 为 `INTEGER CHECK (BETWEEN 1 AND 100000)` 可空（迁移 `:4-5`），与 `i64` / `Option<i64>` 一致。只有手工损坏的库才会触发。
- **`note_storage` 共有错误**（`src/cmd/notes.rs:300-325`）：
  - `VFS database not configured`（`:305-308`）：`vfs_db` 只在 `src/lib.rs:3799` 赋值为 `Some(vfs_db)`，`VfsDatabase::new` 失败时 `src/lib.rs:3506-3509` 直接 panic，应用不启动。不可达。
  - `get_conn_safe` 失败（`:310-312`，`crates/dstu-vfs/src/vfs/database.rs:191-196` 维护模式、连接池错误）：维护模式只在备份/恢复/同步期间由 `enter_maintenance_mode`（`database.rs:283`）开启，并在流程结束时关闭；v0 场景串行执行且不含这些流程，属于锁/连接池故障。不可达。
  - `spawn_blocking` join 失败（`:324`）：只在任务 panic 时出现。不可达。
- **Tauri State 提取**：`State<'_, AppState>` 取不到时报 `state not managed for field \`state\` on command \`notes_history_get_retention\`…`（tauri-2.11.5 `src/state.rs:62-67`）。`AppState` 在 setup 的 `src/lib.rs:1336` 注册，只有进入恢复启动模式（`src/lib.rs:959`、`:972`、`:986`、`:1043`、`:1053`、`:1062`、`:1317` 的提前 `return Ok(())`）时才不注册。`seed: "empty"` 不会进入这些模式，做法同 WP-246（`host/plugins/llm-providers/equivalence/README.md`），需要 X3 提供恢复模式种子后才能加一步 `{ "cmd": "notes_history_get_retention", "expect": "error" }`。本包不写。

成功路径（默认值、`set_retention` 后回读）已由 `history.json` H8 第 0、2、4、8、19 步覆盖，本包不重复。

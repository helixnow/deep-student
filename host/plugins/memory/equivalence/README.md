# memory 等价场景（WAVE0 首包 WP-067；G3 v1 补全 WP-235）

功能组：记忆配置（根目录、隐私、自动建子目录、默认分类、自动提取频率）、记忆 CRUD（读/写/列表/树/按 ID 更新/删除/移动/批量删除）、关联（添加/移除/查询）、标签（更新/读取）。
格式为 `board/WAVE0-EQUIVALENCE.md` §3 v0。这些场景**尚未在 A/B 上运行，没有 golden，不计 C 级**。

| 文件 | 场景数 | 步骤数 | 标注 `expect:error` | 命令 |
|---|---|---|---|---|
| `memory-config.json` | 19 | 99 | 25 | memory_get_config、memory_create_root_folder、memory_set_root_folder、memory_set_privacy_mode、memory_set_auto_create_subfolders、memory_set_default_category、memory_set_auto_extract_frequency（另用 memory_list、memory_get_tree 读回） |
| `memory-crud.json` | 42 | 285 | 74 | memory_write、memory_read、memory_list、memory_get_tree、memory_update_by_id、memory_delete、memory_move_to_folder、memory_batch_delete（另用配置/关联/标签命令做前置与读回） |
| `memory-relations-tags.json` | 13 | 95 | 29 | memory_add_relation、memory_remove_relation、memory_get_related、memory_update_tags、memory_get_tags（另用 memory_write/delete/list/create_root_folder） |
| `memory-batch-export-search.json`（WP-235） | 30 | 165 | 32 | memory_batch_move、memory_restore_stale、memory_restore_archived、memory_export_all、memory_get_profile、memory_get_audit_logs、memory_to_anki_document、memory_search；另补 memory_get_config、memory_get_tree 的多余参数场景 |
| `memory-smart-write.json`（WP-235） | 14 | 71 | 27 | memory_write_smart、memory_write_batch |
| `quick-assistant.json`（WP-235，domain `quick-assistant`） | 4 | 17 | 4 | quick_assistant_show、quick_assistant_hide、quick_assistant_apply_enabled |

WP-067 部分：74 个场景、479 个步骤、20 条命令。WP-235 新增 48 个场景、253 个步骤、13 条命令。全目录合计 122 个场景、732 个步骤、33 条本 lane 命令（没有外 lane 命令）、191 个 `expect:error`。`expect:error` 只是说明，以 A 端实际结果为准。所有场景 `seed:"empty"`；所有写场景都 `capture.events=true`、`db=["*"]`；`normalize` 全部为 `[]`。

## 运行器前提（X7 / X3）

1. **步骤引用只取对象字段**：`${n.noteId}`、`${n.memoryRootFolderId}`。`memory_create_root_folder` 返回裸字符串，场景不引用它，根目录 ID 一律从紧随其后的 `memory_get_config` 取。
2. **写类命令后台任务需等静默再拍 db 快照**。`memory_write`、`memory_update_by_id`、`memory_delete`、`memory_batch_delete`（succeeded>0 时）在返回前派发了两个 fire-and-forget 任务：
   - `trigger_immediate_index`（`handlers.rs:125`，调用点 `:324`、`:600`）：需要嵌入模型；没配置时只 warn，不影响返回值，但会改 index_state 行。
   - `spawn_post_write_maintenance`（`service.rs:726-790`）：画像刷新（建 `__system__` 文件夹、`__user_profile__` 笔记）、隐私模式关闭时的 LLM 分类刷新、自进化/晋升、语义去重。
   
   快照若不等它们结束，A/B 两边 db 终态会随调度时机变化。LLM 端点必须指向本地 mock，不得连外网。`memory.config.privacy.toggle` 之外的场景都处在默认隐私模式（关闭），即分类刷新路径会被触发。
3. **事件**：只有 `memory://changed`，负载 `{source:"user", action, entityIds}`（`handlers.rs:82`）。action 取值 write/update/delete/batch_delete/move/add_relation/remove_relation/update_tags。配置命令、读命令不发事件。
4. normalize 候选（等 A 端录两次后再定，现在不预先忽略）：
   - note/folder/resource ID（随机生成）以及返回值、事件 entityIds、错误文案中出现的这些 ID；
   - `updated_at`；
   - `FOLDER_DEPTH_EXCEEDED: {folder_id} …`（`dstu-vfs/src/vfs/error.rs:212`）中的新文件夹 ID；
   - `memory_list` 在 `updated_at` 同秒时的相对顺序。

## 命令入口与分支覆盖

前端行号相对仓库根 `src/`；Rust 行号相对 `src-tauri/crates/dstu-memory/src/memory/`；TS 注册行号相对 `host/plugins/memory/index.ts`。场景引用写作 `场景id[步骤下标]`，省略前缀 `memory.`。

“无 UI 调用”表示前端 wrapper 在 `src/api/memoryApi.ts` 中有 invoke，但当前 `src/` 下没有组件调用它；按约定仍算前端可达。

“参数反序列化”指 Tauri 在进入 handler 前因缺参/类型错误返回的 Err，在每条命令的 `bad_args` 场景中覆盖。

| 命令 | 前端 invoke / UI 调用 | Rust 入口 | TS 注册 | 可达 Err / 提前返回 → 场景 |
|---|---|---|---|---|
| memory_get_config | `api/memoryApi.ts:116`；`MemoryView.tsx:221`、`MemorySettingsSection.tsx:72,97,116`、`MemoryFolderBanner.tsx:109,134` 等 | `handlers.rs:175` → `service.rs:607` | `:128` | 无业务 Err。未配置根 → `config.get.fresh`；`memory_list` 引导建根后再读 → `config.get.after_list_bootstrap`；多余参数被忽略 → `config.get.unexpected_args_ignored`、`config.get.bad_shape_ignored`（WP-235）。**无可达错误场景**：handler 不接收任何参数，没有可反序列化失败的入参；`service.rs:607-631` 只有配置读取与 `get_folder` 的 `?` 传播（DB 故障注入才能触发），配置的根不存在时走 `(None, None)` 返回 Ok |
| memory_set_root_folder | `:120`；`MemoryView.tsx:1003`、`MemorySettingsSection.tsx:96` | `handlers.rs:185` → `service.rs:633` | `:130` | 文件夹不存在 `service.rs:635` → `config.set_root.not_found[0][1]`（含空串）；保留名 `__*` `:642`（`trim_start` 后判断，`service.rs:444`）→ `config.set_root.reserved_title[5][9]`；成功切换/重复设置 → `config.set_root.switch_back`；参数反序列化 → `config.set_root.missing_arg` |
| memory_set_privacy_mode | `:124`；`MemorySettingsSection.tsx:175` | `handlers.rs:198` → `service.rs:698` → `config.rs:437` | `:267` | 无业务 Err。开/重复开/关 → `config.privacy.toggle`；参数反序列化（缺参、字符串、数字、null）→ `config.privacy.bad_args` |
| memory_create_root_folder | `:140`；`MemoryView.tsx:1021`、`MemorySettingsSection.tsx:115`（前端先 trim） | `handlers.rs:209` → `service.rs:704` → `config.rs:403` | `:132` | 不校验标题：空串、全空白、`__` 前缀、含 `/`、同名重复全部成功 → `config.create_root.unvalidated_titles`；成功并切换根 → `config.create_root.basic`；参数反序列化 → `config.create_root.missing_title` |
| memory_set_auto_create_subfolders | `:128`；`MemorySettingsSection.tsx:133` | `handlers.rs:630` → `config.rs:450` | `:269` | 无业务 Err。→ `config.auto_create_subfolders.toggle`；参数反序列化 → `.bad_args`；关闭后的写入/移动效果 → `write.auto_create_disabled`、`move.ignores_auto_create_flag` |
| memory_set_default_category | `:132`；`MemorySettingsSection.tsx:147` | `handlers.rs:643` → `config.rs:457` | `:271` | 无业务 Err、不 trim、不校验 `__`。空串被 `config.rs:163-173` 读回过滤，回落 `通用`（`config.rs:444`）→ `config.default_category.values[7]`；空白值、`__system__` → `[5][9]`；空白默认分类下写入 → `write.whitespace_default_category`；参数反序列化 → `.bad_args` |
| memory_set_auto_extract_frequency | `:136`；`MemoryView.tsx:991`、`MemorySettingsSection.tsx:161`、`MemoryFolderBanner.tsx:133` | `handlers.rs:656` → `config.rs:532` | `:273` | 非法值 `handlers.rs:666-671`（文案带 trim+小写后的值）→ `config.auto_extract_frequency.invalid[0-3]`；trim+不区分大小写的合法值 → `.valid`、`.invalid[4]`；参数反序列化 → `.bad_args` |
| memory_read | `:153`；`MemoryView.tsx:533,799` | `handlers.rs:250` → `service.rs:962` | `:136` | 笔记不存在 → `Ok(None)` `service.rs:966` → `read.missing_and_outside_root[0][1]`；不在当前根 → `Ok(None)` `:970` → `[6]`，切回原根后可读 → `[8]`；返回绝对 folderPath（`get_note_folder_path` `:3278`）→ `write.create_then_read[1]`；参数反序列化 → `read.bad_args` |
| memory_write | `:162`；**无 UI 调用**。前端 wrapper（`:156-168`）不发送 `noteId` | `handlers.rs:277` → `service.rs:978/988` | `:138` | 标题和内容同时为空 `handlers.rs:288` → `write.empty_title_content[0][1]`；标题空 `service.rs:998` → `[2][3]`；标题保留前缀 `:499` → `write.reserved_names[0][1]`；路径保留段 `:509`（分隔符规整后逐段判断）→ `[3-5]`；敏感信息 `:1008`（`auto_extractor.rs:399-447`：手机号、身份证、邮箱、密码、私钥、零宽/不可见字符，含标题命中）→ `write.sensitive_patterns`；Fact 内容超 200 字（按 `chars().count()`）`:1015` → `write.fact_length_boundary[1][3]`（emoji 探测 UTF-16 差异）；关闭自动建子目录时路径不存在 `:2900` → `write.auto_create_disabled[3][4]`；目录深度超限（`dstu-vfs/.../folder_repo.rs:330`，前面的段已建出）→ `write.folder_depth_limit[1]`；模式按 to_lowercase 解析、未知模式回落 Create（`service.rs:328-338`）→ `write.modes_by_title`；路径规整（`记忆/` 前缀、反斜杠、全角分隔、空段、`.`）→ `write.folder_path_normalization`；空路径与默认分类（`:2880-2891`）→ `write.empty_folder_path_default_category`。**契约边界输入**（前端不发）：`noteId` 分支 `handlers.rs:296-316` → `write.by_note_id`（不存在 → update_by_id NotFound `[8][9]`、保留标题 `[10]`、超长 `[11]`）；Append 对空内容的拼接差异（handler 判空、service 恒拼 `\n\n`）→ `write.append_empty_content`；显式 null → `write.explicit_nulls`；参数反序列化 → `write.bad_args` |
| memory_list | `:175`；`MemoryView.tsx:237,260` | `handlers.rs:338` → `service.rs:2627/2673` | `:154` | 无业务 Err。limit 缺省 100、clamp 1..500 `handlers.rs:347` → `list.pagination_clamp`；未知 folderPath 返回 `[]`（`service.rs:2689`）→ `list.folder_filter[6][7]`；首次调用建根 → `list.empty_bootstrap`；参数反序列化（负数、超 u32、小数、字符串）→ `list.bad_args` |
| memory_get_tree | `:183`；`MemoryView.tsx:280`、`MemoryTreePreview.tsx:205` | `handlers.rs:354` → `service.rs:2771` | `:157` | 无可达 Err。首次调用建根 → `tree.fresh_bootstrap`；嵌套目录 → `tree.nested_after_writes`；多余参数被忽略 → `tree.unexpected_args_ignored`（WP-235）。**无可达错误场景**：handler 无参数；`ensure_root_folder_id` 先保证根存在，`service.rs:2776` 的 `None` 分支不可达；其余只有 DB `?` 传播 |
| memory_update_by_id | `:265`；`MemoryView.tsx:794`（只传 content） | `handlers.rs:585` → `service.rs:3299` | `:218` | title、content 同时缺省 `service.rs:3317` → `update_by_id.validation[1][2][3]`（先于存在性检查，`[3]` 笔记不存在也报此错）；笔记不存在/不在根 `:3324`→`:4167-4182` → `validation[4]`、`update_by_id.outside_root_and_deleted[4][7]`；标题空白 `:3329` → `validation[5]`；标题保留前缀 `:3334` → `[6]`，且先于内容检查 → `[10]`；标题敏感 `:3336` → `[7]`；内容敏感 `:3345` → `[8]`；内容超 200 字 `:3352` → `[9][13]`；成功（只传 content、只传 title、空内容）→ `update_by_id.frontend_content_only`、`.title_only_and_empty_content`；参数反序列化 → `update_by_id.bad_args` |
| memory_delete | `:274`；`MemoryView.tsx:633` | `handlers.rs:615` → `service.rs:3411` | `:225` | 不存在/已删除/空串 `:3423`→`:4171` → `delete.basic_and_repeat[4-6]`；不在当前根 `:4177` → `delete.outside_root[3]`；删除后清理入向 `_ref:` 标签（`service.rs:3495`）→ `delete.cleans_incoming_refs`；参数反序列化 → `delete.bad_args` |
| memory_move_to_folder | `:256`；**无 UI 调用** | `handlers.rs:567` → `service.rs:4040` | `:212` | 笔记不存在（先于路径校验，且不建目录）`:4041`→`:4171` → `move.errors[2][3]`；保留路径段 `:4062` → `[1]`；深度超限 → `[5]`；不在当前根 → `move.outside_root[3]`；忽略 auto_create 开关（`ensure_folder` 恒建）→ `move.ignores_auto_create_flag`；空路径移回根、`记忆/` 前缀规整 → `move.paths`；参数反序列化 → `move.bad_args` |
| memory_batch_delete | `:242`；`MemoryView.tsx:699` | `handlers.rs:479` | `:193` | 无整体 Err，逐条失败计入 errors，最多 5 条，格式 `"{id}: {e}"`（`:501-503`）→ `batch_delete.empty_and_all_fail[2]`；succeeded=0 不发事件不跑维护 `:508` → `[0][2]`；混合（不存在、重复 ID）→ `batch_delete.mixed`；不在当前根 → `batch_delete.outside_root`；参数反序列化 → `batch_delete.bad_args` |
| memory_add_relation | `:187`；**无 UI 调用** | `handlers.rs:365` → `service.rs:3588` | `:159` | 先检查两端存在且在根（`service.rs:3589-3590`）→ `relation.add_errors[2-5]`、`relation.outside_root[4]`，再判自关联 `:3615` → `add_errors[1]`；幂等与反向重复 → `relation.add_idempotent_and_order`；参数反序列化 → `relation.bad_args[0][1]` |
| memory_remove_relation | `:191`；**无 UI 调用** | `handlers.rs:383` → `service.rs:3708` | `:165` | 先检查两端存在且在根（`service.rs:3709-3710`）→ `relation.remove_noop_and_errors[4][5]`、`relation.one_sided_ref_after_delete[5]`、`relation.outside_root[5]`，再判自关联 InvalidArgument `:3733` → `remove_noop_and_errors[3]`；无关联时 no-op 成功 → `[2]`；参数反序列化 → `relation.bad_args[2]` |
| memory_get_related | `:195`；**无 UI 调用** | `handlers.rs:401` → `service.rs:3837` | `:171` | 不存在/空串 → `related.missing`；不在当前根 → `relation.outside_root[6]`；已删除笔记 → `relation.one_sided_ref_after_delete[6]`；对端删除后入向 ref 已清理 → `[4]`；参数反序列化 → `relation.bad_args[3]` |
| memory_update_tags | `:199`；**无 UI 调用** | `handlers.rs:413` → `service.rs:3854` | `:173` | 不存在 `:3855`→`:4171` → `tags.errors[0]`；不在当前根 → `tags.errors[6]`；`_` 开头的用户标签被丢弃、已有系统标签保留在前 → `tags.system_tags_preserved`、`tags.study_type_tag_preserved_via_note`；去重/空串/emoji → `tags.update_and_get`；参数反序列化 → `tags.bad_args[1-4]` |
| memory_get_tags | `:213`；**无 UI 调用** | `handlers.rs:467` → `service.rs:4034` | `:179` | 不存在/空串 → `tags.errors[1][2]`；不在当前根 → `tags.errors[7]`；参数反序列化 → `tags.bad_args[5]` |

### 本包没有覆盖的分支（逐条说明原因）

- 只能靠故障注入触发：连接池/SQLite 错误（每条命令的 `?` 传播）、`mark_pending`/`remove_incoming_refs` 失败（只 warn）、memory_config 写失败。
- `memory_get_tree` 根文件夹不存在返回 `None`（`service.rs:2776`）：`ensure_root_folder_id` 先保证根存在，命令路径不可达。
- 配置的根文件夹被删除后的回落/认领同步根（`config.rs:193-227`）：需要 L13 的 `dstu_folder_delete` 或 X3 的种子数据，本包只用本 lane 命令。
- `MAX_FOLDERS_COUNT`=500（`dstu-vfs/.../folder_repo.rs:340`）：要先建 500 个文件夹，场景步骤数不现实，留给 X3 种子。
- OCC 冲突（`service.rs:3575-3580`）：命令内部先读后写，单线程场景无法插入并发写。
- Study 4000 字、Note 2000 字上限（`service.rs:168-174`）：这些命令只写 Fact 类型，类型标签 `_type:*` 又会被 `update_tags` 丢弃，用户命令无法造出非 Fact 笔记。

## WP-235：G3 命令语料 v1（剩余 13 条命令）

文件 `memory-batch-export-search.json`、`memory-smart-write.json`、`quick-assistant.json`。约定同上：前端行号相对仓库根 `src/`；Rust 行号相对 `src-tauri/crates/dstu-memory/src/memory/`（quick_assistant 相对 `src-tauri/src/`）；TS 注册行号相对 `host/plugins/memory/index.ts`；场景引用省略前缀 `memory.`。

### 逐命令 成功 / 错误 / 理由

| 命令 | 前端 invoke / UI 调用 | Rust 入口 | TS 注册 | 成功场景 | 错误 / 提前返回场景 | 理由与未覆盖分支 |
|---|---|---|---|---|---|---|
| memory_batch_move | `api/memoryApi.ts:249`；**无 UI 调用** | `handlers.rs:522` → `service.rs:4040` | `:204` | `batch_move.basic`（移入新路径、空路径回根、`记忆/` 前缀规整） | 逐条失败计入 `errors`（最多 5 条，`"{id}: {e}"`，`handlers.rs:544-548`）→ `batch_move.empty_and_all_fail[1][2]`；succeeded=0 不发事件 `:553` → `[0][1]`；混合（不存在、重复 ID、保留段、深度超限）→ `batch_move.mixed_and_reserved`；不在当前根 → `batch_move.outside_root[4]`；参数反序列化 → `batch_move.bad_args` | 命令本身无整体 Err；与 `memory_batch_delete` 不同，成功后不跑 `spawn_post_write_maintenance`，事件 action 为 `batch_move` |
| memory_restore_stale | `:204`；`MemoryView.tsx:665` | `handlers.rs:430` → `service.rs:3930` | `:181` | 未标记 → `Ok(false)` 不发事件 `service.rs:3932` → `restore.not_marked_returns_false[1]`、`restore.user_underscore_tags_dropped[3]`；切回原根后可恢复 → `restore.outside_root[7]` | 笔记不存在/空串/已删除 `service.rs:4170` → `restore.missing_and_deleted[0][1][6]`；不在当前根 `:4176` → `restore.outside_root[4]`；参数反序列化 → `restore.bad_args[0][1]` | **返回 true 的分支未覆盖**：需带 `_stale` 标签的笔记，只有 evolution 按时间降级会打该标签，`memory_update_tags` 会丢弃 `_` 开头的用户标签（`user_underscore_tags_dropped` 证明这一点）。需要 X3 种子（owner：X3） |
| memory_restore_archived | `:209`；`MemoryView.tsx:681` | `handlers.rs:447` → `service.rs:3984` | `:187` | 同上 → `restore.not_marked_returns_false[2]`、`restore.user_underscore_tags_dropped[4]`、`restore.outside_root[8]` | 不存在/空串/已删除 → `restore.missing_and_deleted[2][3][7]`；不在当前根 → `restore.outside_root[5]`；参数反序列化 → `restore.bad_args[2][3]` | **返回 true 的分支未覆盖**（摘 `_archived`、`mark_pending`、审计 `ARCHIVE_RESTORE`）：同上，需要带 `_archived` 标签的 X3 种子（owner：X3）。`mark_pending` 失败只 warn，需故障注入 |
| memory_export_all | `:294`；`MemoryFolderBanner.tsx:193` | `handlers.rs:688` | `:232` | 空库（首次调用建根）→ `export_all.empty`；多目录、空内容 → `export_all.with_notes`；只导出当前根 → `export_all.only_current_root` | 无可达错误场景 | handler 无参数；`list(None,500,0)` 与 `read` 只有 DB `?` 传播；`read` 返回 `None` 时 `unwrap_or_default`。500 条截断需 500 条种子，未写 |
| memory_get_profile | `:290`；`MemoryFolderBanner.tsx:151` | `handlers.rs:721` | `:234` | 未配置根 → `[]` 提前返回 `handlers.rs:730` → `get_profile.no_root[0]`；有根无画像 → `get_profile.root_without_profile`；写入后（后台维护生成画像/分类摘要）→ `get_profile.after_writes`、`get_profile.privacy_mode_after_writes` | 无可达错误场景 | handler 无参数，只有 DB `?` 传播。分类摘要分支（`handlers.rs:742`）与画像回落分支（`:752`）取决于后台维护任务产物：需 L02 的本地 mock LLM（owner：L02）且运行器等后台静默后再读（见上文运行器前提 2） |
| memory_get_audit_logs | `:355`；`MemoryFolderBanner.tsx:165` | `handlers.rs:947` → `audit_log.rs:307` | `:280` | 空表、limit 缺省 50 并 clamp 1..200 `handlers.rs:956`、显式 null → `audit_logs.empty_and_clamp`；写入后按 source/operation/success 过滤、分页、超大 offset、过滤值区分大小写 → `audit_logs.filters_after_writes` | 参数反序列化（负数、超 u32、小数、字符串、错误类型）→ `audit_logs.bad_args` | `query_audit_logs` 无业务 Err，只有 DB `?` 传播 |
| memory_to_anki_document | `:227`；**无 UI 调用** | `handlers.rs:973` | `:236` | 空库（`document_content` 为空串）→ `to_anki.empty`；目录过滤、未知目录、purpose 过滤、limit 缺省 200 并 clamp 1..1000 `handlers.rs:983`、空内容用标题 → `to_anki.with_notes_and_filters`；跳过 `__` 开头标题（画像笔记）`:994` → `to_anki.skips_system_notes` | 参数反序列化 → `to_anki.bad_args` | 无业务 Err。`document_name` 含本地日期 `记忆卡片_%Y%m%d`：A/B 同日录制一致，跨日为 normalize 候选 |
| memory_search | `:147`；`MemoryView.tsx:362` | `handlers.rs:233` → `service.rs:2586` → `:836` | `:283` | 隐私模式提前返回 `[]` `service.rs:2592` → `search.privacy_mode_short_circuit`；topK 缺省 5、clamp 1..100 `handlers.rs:242`、空查询 → `search.basic`；空库 → `search.empty_store` | 参数反序列化（缺 query、null、数字、负 topK、字符串 topK）→ `search.bad_args` | `search.basic` 需本地确定性 embedding 端点，未配置时检索器的行为以 A 端为准。`Rerank failed`（`service.rs:2622`）需本地 rerank mock 返回错误（owner：L02/F 模型配置）；`top_k==0` 分支被 handler clamp 屏蔽，不可达 |
| memory_write_smart | `:307`；`MemoryFolderBanner.tsx:271` | `handlers.rs:761` → `service.rs:1739` | `:239` | study / note 直接写入（含大小写、空白 purpose、systemic→memorized、study 同名 upsert）→ `write_smart.study_and_note`；隐私模式 fact 本地标题去重 `service.rs:1943` → `write_smart.fact_privacy_local_dedup`；非隐私 fact 走 LLM 决策 → `write_smart.fact_llm_decision` | 标题空 `handlers.rs:775`、内容空 `:778` → `write_smart.handler_validation[0-3]`；非法 memory_type `handlers.rs:99` → `[4][5]`；非法 memory_purpose `:115` → `[6]`；保留标题/路径段 → `write_smart.reserved_names`；FILTERED 提前返回（敏感 `service.rs:1822`、超长 `:1840`、fact 知识类硬拒绝 `:448`）→ `write_smart.filtered_outputs`；幂等键命中缓存、空白键视为无键 → `write_smart.idempotency_key`；参数反序列化 → `write_smart.bad_args` | `fact_llm_decision` 需 L02 本地 mock LLM（owner：L02），无 mock 时走 decision_unavailable 降级路径，以 A 为准。幂等 `Conflict`（`service.rs:1798`）需同键并发请求，单线程场景不可达。服务层“内容为空 → NONE”（`:1768`）被 handler 先行拦截，此命令不可达，改由 write_batch 覆盖 |
| memory_write_batch | `:323`；`MemoryFolderBanner.tsx:240` | `handlers.rs:815` | `:254` | 空 items 提前返回全 0 `handlers.rs:834` → `write_batch.empty_and_too_many[0]`；默认 Study、目录/类型逐条覆盖、空内容、敏感内容 → `write_batch.default_study_and_overrides`；隐私模式 fact（同名去重、空内容 NONE）→ `write_batch.fact_privacy` | 超过 200 条 `handlers.rs:827` → `write_batch.empty_and_too_many[1]`；非法默认类型/目的 `:850-853` → `write_batch.invalid_defaults`；中途某条类型/目的非法或保留标题时整体 Err，但前面条目已写入（无事务回滚、不发事件、不跑维护）→ `write_batch.invalid_item_mid_batch`；参数反序列化 → `write_batch.bad_args` | 幂等 `Conflict` 同上不可达 |
| quick_assistant_show | `quick-assistant/window.ts:29`；`NotesCrepeEditor.tsx:2438`、`GeneralTab.tsx`、`NotesWorkspaceApp.tsx` | `quick_assistant.rs:256` → `:174` | `:288` | 首次显示（懒建窗口）、重复显示 → `quick_assistant.show_hide_cycle`；销毁后重建 → `quick_assistant.apply_enabled_cycle[6]` | 无可达错误场景 | 命令返回 `()`，无入参。建窗失败 `:177` 只 `log::error!` 后返回 Ok，需故障注入。事件 `quick-assistant://shown` 发往小窗 |
| quick_assistant_hide | `window.ts:39`；`QuickAssistantWindow.tsx:329,449` | `quick_assistant.rs:264` → `:196` | `:290` | 窗口不存在提前返回 `:198` → `quick_assistant.hide_before_window`、`apply_enabled_cycle[4]`；显示后隐藏（持久化 bounds 到设置库）→ `show_hide_cycle[2][3]` | 无可达错误场景 | 返回 `()`，无入参；`save_setting` 失败被忽略 |
| quick_assistant_apply_enabled | `window.ts:103`（`initializeQuickAssistantGlobalShortcut` 内，`.catch(()=>{})`） | `quick_assistant.rs:273` → `:243` | `:292` | enabled=true no-op、false 销毁并持久化 bounds、重复 false → `quick_assistant.apply_enabled_cycle` | 参数反序列化（缺参、字符串、数字、null）→ `quick_assistant.apply_enabled.bad_args` | 无业务 Err |

### WP-235 运行器前提与依赖 owner

- `quick-assistant.json` 依赖外壳窗口层：A 端是 Tauri webview 窗口，B 端按全局快捷键约定由外壳转发。数据库差异只在设置表的 bounds 键（`persist_bounds`，`quick_assistant.rs:115`），位置/尺寸依赖显示器，为 normalize 候选，待双录后由 C2 定。
- 需要本地 mock 的场景：`write_smart.fact_llm_decision`、`get_profile.after_writes`、所有非隐私模式写入后的维护任务（owner：L02 本地 mock LLM）；`search.basic` 需本地 embedding 端点（owner：L02/F 模型配置）。未就绪时照常录 A，以 A 为准，不连外网。
- 需要 X3 种子：`restore_stale`/`restore_archived` 的 true 分支（带 `_stale`/`_archived` 标签的笔记）、`export_all` 500 条截断。
- normalize 候选（不预先忽略）：新增场景里的 note/resource ID、`updatedAt`、审计 `timestamp`/`durationMs`、`to_anki` 的 `documentName` 日期。

## WP-272：Rust 可达 Err 判定（g3w 错误场景）

下面 6 条命令都没有 Rust 侧可达的业务 Err 或提前返回 Err，所以不写 `g3w-memory-NN.json` 错误场景。Rust 行号：memory 四条相对 `src-tauri/crates/dstu-memory/src/memory/`，`config.rs`/`folder_repo.rs` 另注；quick_assistant 两条相对 `src-tauri/src/`。

共同前提：这 6 条命令都没有业务参数（前端调用点 `api/memoryApi.ts:116,183,290,294`、`quick-assistant/window.ts:29,39` 都不传 args），没有参数反序列化错误。memory 四条取 `State<Arc<VfsDatabase>>`、`State<Arc<VfsLanceStore>>`、`State<Arc<LLMManager>>`，只有两种情况会出现 “state not managed” 错误：setup 进入恢复模式时在 `lib.rs:1321` 的 `build_app_state` 之前 return（`lib.rs:953-1062`、`:1317`），或者 `VfsLanceStore::new` 初始化失败降级（`lib.rs:3517-3527`，属 IO 故障）。seed `empty` 不会走到这两条路径，处理同 WP-246。

| 命令 | 判定 | Rust 文件:行与原因 |
|---|---|---|
| memory_export_all | 无可达 Err | `handlers.rs:689-712`：`list(None,500,0)`（:695）和 `read`（:700）的 `?` 只传播 DB 错误；`read` 返回 `None` 时 `unwrap_or_default()`（:703），不报错。`list_internal`（`service.rs:2673-2763`）在路径未解析、无子目录时都返回 `Ok(vec![])`，其余是 SQL/连接 `?`。`ensure_root_folder_id`（`service.rs:717`）→ `get_or_create_root_folder`（`config.rs:193-229`）只在没有有效根时才建根，建根时 `create_folder` 的 `FolderCountExceeded`（`dstu-vfs/src/vfs/repos/folder_repo.rs:339-345`，上限 500）要求库里已有 500 个文件夹且没有有效根。本 lane 命令建的文件夹都挂在已配置的根下，造不出这种状态，seed `empty` 不可达 |
| memory_get_config | 无可达 Err | `handlers.rs:175-182` → `service.rs:607-631`：只读配置，不建根。配置的根不存在时返回 `(None, None)`（:612-613）；`config.rs:163-173` 的 `get` 对查询失败用 `.ok()`，只有 `get_conn_safe()?` 会出错；`get_auto_extract_frequency` 用 `from_str_lossy`（`config.rs:525-530`）兜底非法值；`VfsFolderRepo::get_folder` 只传播 DB 错误 |
| memory_get_profile | 无可达 Err | `handlers.rs:722-759`：未配置根时提前返回 `Ok(vec![])`（:730），这是成功返回（`get_profile.no_root` 已覆盖）。`get_root_folder_id`（`service.rs:4251` → `config.rs:185`）只读配置、不建根；`load_all_category_summaries`（`category_manager.rs:374-419`）、`get_profile_summary`（`service.rs:4222-4248`，内部 `find_system_folder_id` :436、`find_note_by_title` :3174 用 `.ok()` 吞查询错误）找不到时都返回空或 `None`，最后落到 `Ok(vec![])`（:757）。只有 DB `?` 传播 |
| memory_get_tree | 无可达 Err | `handlers.rs:354-361` → `service.rs:2771-2788`：`ensure_root_folder_id` 先保证根存在，`get_folder` 返回 `None` 时是 `Ok(None)`（:2776），不是 Err；`build_subtree`、`list_items_by_folder` 只传播 DB 错误。建根时的 `FolderCountExceeded` 同 memory_export_all，seed `empty` 不可达 |
| quick_assistant_hide | 无可达 Err | `quick_assistant.rs:264-270`：命令返回 `()`，没有 `Result`，序列化后只会是 `null`。`desktop::hide`（:196-226）窗口不存在时直接 `return`（:197-199，属于成功返回，`quick_assistant.hide_before_window` 已覆盖）；`persist_bounds`（:115-134）的取值失败走 `if let` 跳过，`save_setting` 结果被忽略；`hide`/`minimize` 都是 `let _ =`。非桌面平台是 no-op（:268-269） |
| quick_assistant_show | 无可达 Err | `quick_assistant.rs:256-262`：命令返回 `()`，没有 `Result`。`desktop::show`（:174-194）建窗失败时只 `log::error!` 后 `return`（:177-180），前端收到的仍是成功；其余 `show`/`set_focus`/`emit` 都是 `let _ =`。建窗失败本身也只会在 webview 创建故障时出现。非桌面平台是 no-op（:260-261） |

## 剩余命令（本 lane，未纳入场景）

- `memory_get_or_create_root_folder`：前端无 invoke，Rust 注册在 `src-tauri/src/lib.rs:2957`，不在 G3 清单内。

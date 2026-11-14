# L04-chat-session 等价场景 v0：会话/消息基础 CRUD 与列表

WP-072（WAVE0 §3 v0）。本目录只放场景源文件，不含答案：A（Rust/Tauri）是答案机，B（Electron 宿主 `host/plugins/chat`）重放后由比较器比对。**本包没有执行任何 A/B 重放，没有一条命令因此成为 C。**

| 文件 | 场景 | 步骤 | 覆盖命令 |
|---|---|---|---|
| `sessions.json` | 14 | 184 | 10 条会话命令 |
| `messages.json` | 10 | 163 | 8 条消息/历史命令 |

WP-226（G3 命令语料 v1）在本目录新增 9 个文件，覆盖另外 35 条命令，并给 8 条已有成功场景的命令补错误场景，见 [§8](#8-wp-226g3-命令语料-v135-条命令--8-条补错误)。

全部场景：`seed:"empty"`、`capture {events:true, db:["*"]}`、`normalize: []`。`expect:"error"` 只是标注，不是判定依据；没有写任何期望返回值。

本包刻意避开 L03 注入语料组（WP-061）：不含 `send_message`、`wake_session`、`retry`、`edit_and_resend`、`continue` 及任何流式执行。

## 1. 运行器约定（交比较器 owner 确认）

1. **步骤引用** `${n.path}`：`n` 是同一场景内 0 起的步骤下标，只引用更早且未标 `expect:"error"` 的步骤；`path` 为点分路径，数字段是数组下标（如 `${7.messages.0.id}`）。所有引用都是**整串引用**，替换为原始值，不做字符串拼接。
2. **会话 ID 全部来自返回值**（`create_session` / `branch_session` / `create_group` 的 `id`，Rust 侧随机生成）。消息 ID `msg_*` 与块 ID `blk_*` 由调用方给定（`upsert_streaming_block` 返回 `()`），因此在 A/B 两侧是确定值；`branch_session` 复制出的消息/块/变体 ID 是新生成的，只能经 `${n.messages.k.id}` 引用。
3. **大整数**：`messages.json` 中 `tailLimit: 4294967295`（u32 上界）、`sessions.json` 中 `offset: 4294967296`（u32 溢出）以 JSON 数字原样写入，普通 `JSON.parse` 可以无损表示，无需特殊处理。
4. **无 LLM 造消息**：消息全部经 `chat_v2_upsert_streaming_block` 带 `sessionId` 写入，后端自动建 assistant 占位消息（`ba:900-946`）。这条路径造不出 `user` 角色消息，所以 `get_message_summary.user_messages` 在本包始终为 0；用户消息需要 send 路径（L03 组）或种子。
5. **辅助步骤**不计入本包覆盖，只用来搭状态（同属 L04，但分组命令归后续包）：
   - `chat_v2_create_group {request:{name}}`：前端 `src/features/chat/hooks/useGroupManagement.ts:49`，Rust `handlers/group_handlers.rs:146`。返回 SessionGroup，`id` 供 `groupId` 引用。会在 VFS 建课题文件夹（`ensure_group_folder`），因此 `db:["*"]` 会看到 vfs 侧行变化。
   - `chat_v2_update_group {groupId, request:{persistStatus:"archived"|"deleted"}}`：前端 `useGroupManagement.ts:70`、`src/components/ModernSidebar.tsx:714`，Rust `group_handlers.rs:198`。`archived` 会连带归档组内活跃会话并写 `groupArchivedBy`（`repo:827-885`）；`deleted` 只改分组状态（`group_handlers.rs:271-280`）。
6. 18 条命令都不 emit Tauri 事件；`events:true` 用来确认两侧都没有多发事件。数据库副作用在 `chat_v2_sessions` / `chat_v2_messages` / `chat_v2_blocks` / `chat_v2_session_state` 及 change_log 触发器表。

## 2. 命令、调用点与可达 Err/早退

Rust 路径相对 `src-tauri/crates/dstu-agent/src/chat_v2/`：`ms` = `handlers/manage_session.rs`，`ba` = `handlers/block_actions.rs`，`repo` = `repo.rs`。前端路径相对仓库根；`sc` = `src/features/chat/adapters/tauri/sessionCommands.ts`，`hl` = `src/features/chat/adapters/tauri/historyLoading.ts`。

错误线格式：`Err(String)` 是 JSON 字符串 `{"code":"…","message":"<Display>"}`（`error.rs:164`）。所有命令共有：参数 serde 反序列化失败（IPC 层：缺必填键、类型错误、整数越界）；`get_conn_safe` 失败映射为 `DATABASE_ERROR`（空库正常启动下不可达）。下表“前缀校验”指 `sess_|agent_|subagent_`。

### 2.1 会话（sessions.json）

| 命令 | 前端 | Rust | 可达 Err / 早退（按执行顺序） |
|---|---|---|---|
| `chat_v2_create_session` | `sc:80`（`{mode,title,metadata:null}`）、`src/features/chat/core/session/createSessionWithDefaults.ts:46`（`{mode,title??null,metadata??null,groupId??null}`）、`src/quick-assistant/service.ts:150` | `ms:330`，写库 `ms:1187` | VALIDATION `Invalid session mode: X. Valid modes: ["chat","analysis","review","textbook","bridge","general_chat"]`（`:354-360`）；空白 `groupId` 归一为 None（`:363-364`，早改写）；GROUP_NOT_FOUND `gid (inactive)`（分组非 active，`:371-376`）；GROUP_NOT_FOUND `gid`（`:378-380`）；`title_locked = title.is_some()`（`:1197`）；metadata 原样落库，不剥权威键；runtime roots 失败只 warn（`:388-397`，文件系统，不可构造） |
| `chat_v2_get_session` | `src/features/chat/pages/ensureActiveChatSession.ts:58`、`src/features/chat/pages/useChatPageEvents.ts:185`、`src/features/chat/superSession/useSuperSessionEntry.ts:81` | `ms:414` | VALIDATION `Invalid session_id format: X`（前缀，`:420-425`，注意小写 `session_id`）；不存在返回 `null`（早退，不是 Err） |
| `chat_v2_update_session_settings` | `sc:98`、`sc:171`、`src/components/ModernSidebar.tsx:547` | `ms:449`，事务 `ms:1222` | VALIDATION 前缀（`:460-466`）；SESSION_NOT_FOUND（`:1235-1236`）；VALIDATION `只能归档活跃会话，当前状态: Archived`（非 active，Debug 格式，`:1238-1243`）；`title` 缺省/null 保留原标题，`Some` 时 `title_locked=true`（`:1248-1254`）；metadata 补丁 `ms:1296`：缺省不动、`null` 清空普通键保留权威键、对象剥掉权威键与 null 值后替换、标量在无权威键时替换/有权威键时忽略并 warn、空结果变 None |
| `chat_v2_freeze_available_skills_snapshot` | `src/features/chat/adapters/tauri/availableSkillsSnapshot.ts:144` | `ms:489`，`repo:3068` | VALIDATION 前缀（`:494-501`）；SESSION_NOT_FOUND（`repo:3087-3088`）；已冻结时返回既有值（`repo:3099`，早退，空串也算已冻结）；不推进 `updated_at` |
| `chat_v2_archive_session` | `sc:114`、`ModernSidebar.tsx:576`、`src/features/chat/pages/useSessionEdit.ts:155` | `ms:523`，`ms:1351` | VALIDATION 前缀（`:532-538`）；SESSION_NOT_FOUND（`:1353-1354`）；VALIDATION `Super-agent 会话不能归档。…`（`super_agent.active===true`，`:1357-1362`）；无状态检查（已归档可再归档，覆盖 `manuallyArchivedBy.archivedAt`）；metadata 缺省或非对象时变为 `{manuallyArchivedBy:{archivedAt}}` |
| `chat_v2_restore_session` | `src/features/settings/components/data-governance/ChatSessionArchiveTab.tsx:157` | `ms:846`，`ms:1435` | VALIDATION 前缀（`:857-864`）；SESSION_NOT_FOUND（`:1440-1441`）；移除 `manuallyArchivedBy`/`groupArchivedBy`；活跃 Super 且另有活跃 Super 时退役（`retire_metadata`：`super_agent={active:false,retired_at}`、删 `pinned`，`:1451-1462`）；GROUP_NOT_FOUND（分组行不存在，`:1465-1467`）；VALIDATION `该会话属于已归档课题，…`（`:1470-1474`）；GROUP_NOT_FOUND（分组 deleted，`:1476-1477`）；无状态检查（active 也可恢复）；之后重建 skill state（写 `chat_v2_session_state`，`:1501`） |
| `chat_v2_delete_session` | `src/features/chat/hooks/useSessionManagement.ts:202`、`src/features/chat/pages/useSessionLifecycle.ts:310`、`ChatSessionArchiveTab.tsx:191` | `ms:893` | OTHER `Cannot delete session while streaming…`（`:907-913`，v0 不可达）；OTHER `Cannot delete session while ChatAnki generation is still running…`（`anki_cards` 块 status ∈ pending/running，`:915-921`，查询 `:300-313`；reaper 阈值 2 分钟，新块必然阻塞）；VALIDATION 前缀（`:924-931`，在 anki 检查之后）；IO_ERROR runtime roots 清理失败（`:936-937`，不可构造）；SESSION_NOT_FOUND（`repo:555-557`，删除 0 行）；级联删消息/块/状态；带 `super_agent` 标记时触发 `on_session_removed`（`:959-961`，本包不删 Super 会话） |
| `chat_v2_list_sessions` | `src/features/chat/stores/sessionListStore.ts:99`（`groupId:'*'`）、`:102`（`groupId:''`）、`useSessionManagement.ts:131`、`src/hooks/useChatV2Stats.ts:143` | `ms:598`，`repo:583` | 无业务 Err。`limit` 缺省 50、`offset` 缺省 0；`groupId:''` → `IS NULL`、`'*'` → `IS NOT NULL`；status 任意字符串精确匹配；排除 `mode='agent'`、`chatV2Draft.hidden=1`、`superagent IS NOT NULL`（JSON `null` 视为 NULL，可见）、`super_agent.hidden=1`（`repo:220-228`）；`updated_at DESC` |
| `chat_v2_count_sessions` | `useSessionLifecycle.ts:65`、`:259`、`:260` | `ms:642`，`repo:646` | 同 list 过滤，无业务 Err |
| `chat_v2_save_session` | `sc:60` | `ms:563`，`ms:2045` | SESSION_NOT_FOUND（`:2051-2052`；无前缀校验）；存储键是参数 `sessionId`，不是 `sessionState.sessionId`；skill 合并 `ms:2070`：`skillStateJson` 可解析则用之，否则用已有状态（都没有时不写 skill 字段，早退）；未用 `skillStateJson` 时 `manualPinnedSkillIds` 取自 `activeSkillIdsJson`（解析失败为 `[]`），变化则 `version+1`；`legacyMigrated` 强制 false，清空 branch-local；`SessionState__De` 不拒未知键 |

### 2.2 消息与历史（messages.json）

| 命令 | 前端 | Rust | 可达 Err / 早退（按执行顺序） |
|---|---|---|---|
| `chat_v2_load_session` | `hl:65`（`tailLimit`）、`hl:268`（全量） | `handlers/load_session.rs:38` | VALIDATION `Invalid session ID: empty or whitespace-only`（`:51-55`，只拒空白，不校验前缀）；`tailLimit` 缺省/null/0 → 全量（无 `totalMessageCount`）；否则尾窗（`repo:2550`，预算 2 MiB、至少 2 条），`total <= window` 时退回全量；SESSION_NOT_FOUND（`repo:2425-2426` / `:2558-2559`）；`authorityMode`/`authority_mode` 为 plan/ask 时持久化为 craft（`load_session.rs:90-94`，同时写两种键并推进 `updated_at`） |
| `chat_v2_load_messages_page` | `hl:217`、`hl:427` | `handlers/load_messages_page.rs:33` | VALIDATION 空白（`:42-46`）；`offset` 缺省 0，`limit` 缺省 100 并 clamp 到 1..500（`:48-49`）；会话不存在返回空页（不是 Err）；`nextOffset` 只在本页非空且未取完时给出（`:72-77`） |
| `chat_v2_upsert_streaming_block` | `sc:199`、`src/features/chat/plugins/events/toolCall.ts:562`、`src/features/chat/workspace/events.ts:405` | `ba:690` | VALIDATION `Invalid block ID format`（`:714-718`）；VALIDATION `Invalid message ID format`（`:721-725`）；LIMIT_EXCEEDED payload > 8 MiB（`:728-737`，见 §5）；VALIDATION `Message X does not belong to session Y`（已有消息属他会话且声明了非空 sessionId，`:741-760`）；VALIDATION `Invalid tool_input_json: …` / `Invalid tool_output_json: …`（`:763-782`）；消息不存在且 sessionId 非空时建 assistant 占位（`ba:900-946`），sessionId 缺省/空串只 warn（`:910-918`）；占位/块插入 FK 失败 → DATABASE_ERROR（`ba:980-1016`，`foreign_keys=ON`）；空 `content` 存 NULL；`status` 缺省 `running`；ON CONFLICT 改写 `message_id`（块可迁移）并 COALESCE `started_at`/`first_chunk_at` |
| `chat_v2_update_block_content` | `sc:150` | `ba:442` | VALIDATION 前缀（`:455-459`）；BLOCK_NOT_FOUND（`:465`）；MESSAGE_NOT_FOUND（`:471`，FK 下不可达）；VALIDATION `Subagent sessions are read-only; …`（`handlers/mod.rs:29-47`：`mode=='subagent'` 或 `metadata.is_subagent` 为布尔 true）；OTHER streaming（`:478-482`，v0 不可达）；空串存 `""`；使压缩失效 |
| `chat_v2_update_block_tool_output` | `src/features/chat/plugins/blocks/ankiCardsBlock.tsx:2263` | `ba:500` | VALIDATION 前缀（`:511-515`）；VALIDATION `Invalid tool_output_json: …`（`:517-523`，在查块之前）；BLOCK_NOT_FOUND（`:528`）；MESSAGE_NOT_FOUND（`:531`，不可达）；VALIDATION 只读（`:532`）；使压缩失效（`:538`） |
| `chat_v2_delete_message` | `src/features/chat/adapters/tauri/messageOperations.ts:243` | `ba:196`，`ba:300` | VALIDATION 只读（`:207`，会话不存在时放行）；OTHER streaming（`:211-217`，v0 不可达）；VALIDATION `Invalid message ID format`（`:220-225`）；SESSION_NOT_FOUND（`:310-311`）；MESSAGE_NOT_FOUND（`:314-315`）；VALIDATION `Message X does not belong to session Y`（`:318-323`）；删除后重建 skill state |
| `chat_v2_branch_session` | `sc:129`、`src/features/chat/core/store/sessionActions.ts:797` | `ms:711`，`ms:1578` | VALIDATION `Invalid source session_id format`（`:724-732`）；VALIDATION 只读（`:733`）；SESSION_NOT_FOUND（`:1589-1590`）；VALIDATION `Source session is not active (status: Archived): id`（`:1593-1598`）；MESSAGE_NOT_FOUND `X (not found in session S)`（`:1604-1611`，含他会话消息）。新会话：`mode="chat"`、标题 `T (branch)`（无标题保持 None）、`title_locked=true`、`branchedFrom={sessionId,messageId,compactionId:null,branchedAt}`、复制 `group_id`、去掉 `super_agent` 与 `pinned`；消息/块/变体换新 ID，工具 JSON 中整串等于旧 ID 的值被重映射；状态只保留 chatParams/features/modeState |
| `chat_v2_get_message_summary` | `src/hooks/useChatV2Stats.ts:215`（无参） | `ms:1110` | 无业务 Err（只有 DATABASE_ERROR，不可达）；返回 snake_case `{total_messages,user_messages,assistant_messages}`，统计全库 |

## 3. 覆盖表（场景:步骤）

步骤号为 0 起下标。`S` = `sessions.json`，`M` = `messages.json`；场景名省略公共前缀 `chat.session.` / `chat.message.`。

| 命令 | 成功步骤（代表） | 错误/早退步骤 → 分支 |
|---|---|---|
| create_session | S create.modes_title_metadata_group:1-7（6 种合法 mode、title 缺省/null/空串、metadata null/对象/标量/数字、groupId 空白/空串/有效）；另 22 个场景用于搭状态 | S create.errors_mode_and_group:4 `agent`、5 `subagent`、6 `Chat`（大小写）、7 空串 → 非法 mode；8 → 分组不存在；9 → 分组 archived；10 → 分组 deleted；11 → IPC 缺 `mode` |
| get_session | S get.found_null_and_prefix_errors:1；2-4 → 不存在返回 null（三种前缀）；另 12 个场景用于读回 | S get…:5 → 前缀；6 → 空串前缀；7 → IPC 缺 `sessionId` |
| update_session_settings | S update_settings.title_metadata_patch_rules:2 空设置、3 改名、4 `title:null`、5 对象剥权威键、7 标量被忽略、9 `metadata:null`、11 空串标题+空对象、14 标量替换、15 全 null 对象→None | S update_settings.errors:2 → 非 active；3 → 不存在；4 → 前缀；5 → IPC 缺 `settings` |
| freeze_available_skills_snapshot | S update_settings.title_metadata_patch_rules:1；S freeze_snapshot…:1 首写、2 → 已冻结早退、5 空串首写、6 → 空串已冻结早退 | S freeze_snapshot…:8 → 不存在；9 → 前缀 |
| archive_session | S archive_restore.roundtrip_metadata_shapes:1 对象、5 重复归档、9 无 metadata、12 标量、17 已退役 Super；另 4 个场景搭状态 | S archive.errors_super_missing_prefix:1 → 活跃 Super；3 → 不存在；4 → 前缀；5 → IPC 缺参 |
| restore_session | S archive_restore…:6 归档后恢复、13 标量 metadata、15 active 直接恢复；S restore.group_active_and_super_retire:3 分组 active、5 唯一活跃 Super 不退役、7 → 另有活跃 Super 时退役 | S restore.errors_group_missing_prefix:4 → 分组 archived；6 → 分组 deleted；8 → 不存在；9 → 前缀 |
| delete_session | S delete.cascade_and_errors:4 级联删除；S delete.running_anki_blocks:6 anki 块 success 后可删 | S delete.running_anki_blocks:2 → anki running（status 缺省）、4 → anki pending；S delete.cascade_and_errors:8 → 删 0 行（已删）、9 → 不存在、10 → 前缀、11 → IPC 缺参 |
| list_sessions | S list_count.filters_visibility_paging:9 全缺省、10 全 null、11 active、12 archived、13 deleted、14 未知 status、15 `groupId:''`、16 `'*'`、17 指定组、18 不存在组、19-21 分页（含越界 offset）、22 `limit:0`；另 5 个场景 | S list_count…:31 → IPC `limit:-1`；32 → IPC `offset` u32 溢出 |
| count_sessions | S list_count…:23-30（与 list 同口径的 8 种过滤）；另 3 个场景 | S list_count…:33 → IPC `status` 类型错误 |
| save_session | S save_load_state.roundtrip_and_skill_merge:1 全字段且无既有 skill state、3 合法 `skillStateJson`、5 非法 `skillStateJson` 回落到 `activeSkillIdsJson`、7 内层 sessionId 不同+未知键；S delete.cascade_and_errors:2；M branch_session…:5 | S save_load_state…:9 → 会话不存在；10 → IPC 缺 `updatedAt`；11 → IPC features 值非 bool；12 → IPC `maxTokens:-1`；13 → IPC 缺 `sessionState` |
| load_session | M load_session.tail_full_and_authority:5 缺省、6 null、7 `0`、8 `1`（低于最小 2 条）、9 `2` 尾窗、10 `3` 退回全量、11 u32 上界、13 空会话、15 plan→craft、18 ask→craft（尾窗路径）、21 未知 authority；另 8 个场景用于读回 | M load_session…:22 → 非标准前缀且不存在、23 → 不存在（全量）、24 → 不存在（尾窗）、25 → 空串、26 → 空白、27 → IPC `tailLimit:-1` |
| load_messages_page | M load_messages_page.paging_and_errors:4 缺省、5 全 null、6-8 分页与 `nextOffset` 边界、9 越界 offset、10 `limit:0` clamp 到 1、11 `501` clamp 到 500、12 → 不存在返回空页、13 非标准前缀空页；另 2 个场景 | M load_messages_page…:14 → 空串、15 → 空白、16 → IPC `offset:-1` |
| upsert_streaming_block | M upsert.placeholder_update_and_tool_fields:1 建占位、2 同块续写、3 空 content、4 无 sessionId 追加到已有消息+工具字段+`"null"` 输出、5 `sessionId:""`、6 第二条消息+`status:null`；M upsert.block_moves_between_messages:2 块迁移；另 10 个场景搭状态 | M upsert.errors:3 → 块前缀；4 → 消息前缀；5 → 跨会话；6 → 非法 tool_input_json；7 → 空串 tool_output_json；8 → 新消息无 sessionId（FK）；9 → 会话不存在（FK）；10 → IPC 缺 `content` |
| update_block_content | M update_block_content.success_and_errors:2 多行、4 空串、8 `is_subagent:"true"`（字符串不算只读） | M update_block_content…:11 → 子代理只读；12 → 前缀；13 → 块不存在；14 → IPC 缺 `content` |
| update_block_tool_output | M update_block_tool_output.success_and_errors:2 对象、4 `"null"` | M update_block_tool_output…:8 → 子代理只读；9 → 前缀；10 → 非法 JSON；11 → 非法 JSON 优先于块不存在；12 → 块不存在 |
| delete_message | M delete_message.success_and_errors:6 | M delete_message…:9 → 已删消息不存在；10 → 他会话消息；11 → 消息前缀；12 → 会话不存在；13 → 会话不存在时前缀先报；16 → 子代理只读；17 → 只读先于前缀；18 → IPC 缺 `messageId` |
| branch_session | M branch_session.copy_remap_and_errors:6 截断+工具 JSON 重映射、10 分支的分支（引用新消息 ID）、14 无标题、18 Super 源 | M branch_session…:20 → 前缀；21 → 不存在；22 → 消息不存在；23 → 他会话消息；27 → 源已归档；30 → 子代理只读；31 → IPC 缺 `upToMessageId` |
| get_message_summary | M get_message_summary.empty_and_counts:0 空库（`{}`）、1 无 args、5 两条后；S delete.cascade_and_errors:3/7 级联前后；M upsert…:9、M delete_message…:8 | 无可达 Err |

合计：24 个场景、347 步，18 条命令；本包命令的成功步骤 256 条、错误步骤 80 条（另有辅助步骤 11 条）。

## 4. 非确定字段（normalize 候选，未启用）

按 v0 协议 `normalize` 保持 `[]`；以下只作候选，待 A1/A2 双录后由 C2 按 scenario+JSONPath 定规则：

- 会话/分组/分支产物 ID：`sess_*`（`ChatSession::generate_id`）、分组 ID、分支复制出的 `msg_*`/`blk_*`/变体 ID。需保持跨返回值、引用和 FK 的一致性，不能单纯抹掉。
- 时间：`createdAt`、`updatedAt`、`manuallyArchivedBy.archivedAt`、`groupArchivedBy.archivedAt`、`super_agent.retired_at`、`branchedFrom.branchedAt`、消息 `timestamp`、块 `startedAt`/`endedAt`/`firstChunkAt`、change_log 时间列。
- 同毫秒排序：`list_sessions` 只按 `updated_at DESC` 排序，同一毫秒内创建的会话顺序依赖 SQLite 计划；消息按 `timestamp, rowid` 排序，同毫秒时 rowid 决定，确定。
- `SessionState.features` 是 `HashMap`，序列化键序不确定（contract `x-key-order: unspecified`）。
- `chatParams` 的 `temperature`/`topP` 是 f32，`0.7`、`0.9` 回读为 f32 加宽值；这是需要原样比对的精度行为，不应被 normalize 掉。
- 错误 `message` 中的 serde 位置信息（`Invalid tool_input_json: key must be a string at line 1 column 2`）和 IPC 反序列化错误文本，B 侧需逐字对齐。

## 5. v0 不可达 / 需种子或运行器扩展

| 分支 | 原因 | 需要 |
|---|---|---|
| delete_session / delete_message / update_block_content 的 `has_active_stream` | 需要正在进行的流 | send/流式（L03 组 WP-061 范围），本包不碰 |
| upsert `LIMIT_EXCEEDED`（> 8 MiB） | 8 MiB 字面量放进场景 JSON 不现实 | 运行器支持参数生成（如 `{"$repeat":["x",8388609]}`），owner：比较器/运行器 |
| create_session runtime roots warn、delete_session `IO_ERROR` | 文件系统故障注入 | 运行器故障注入 |
| restore_session 分组行不存在（`ms:1465-1467`） | 前端可达路径无法让会话引用缺失分组 | 种子：会话 `group_id` 指向不存在分组 |
| update_block_content / update_block_tool_output 的 MESSAGE_NOT_FOUND | `foreign_keys=ON` 下块必有消息 | 种子：关 FK 写孤儿块 |
| list/count 排除 `mode='agent'` | `create_session` 不接受 `agent` mode | 种子，或 L04 后续包的 `chat_v2_list_agent_sessions` 路径 |
| delete_session 的 anki reaper（超过 2 分钟的 running 块被标 failed） | 依赖时钟 | 种子：`started_at` 设为旧时间 |
| `get_message_summary.user_messages > 0` | 无 LLM 时造不出 user 消息 | send 路径或种子 |
| upsert 追加 `block_ids_json` 的 NULL / 非 `Vec<String>` JSON / 读失败分支（`ba:842-897`，解析失败回退 `[]`，读错只 warn） | 前端可达路径写出的 `block_ids_json` 总是合法数组；本包只覆盖“已有合法数组追加、重复不追加、块迁移”三种情况 | 种子：直接写坏 `block_ids_json`。**本语料不能当作 B 侧 `appendBlockIdToMessageWithConn`（`json_insert`）在 NULL/坏 JSON/缺行下已等价的证据**，也不覆盖 workspace 注入追加（`pipeline/tool_loop.rs:2718-2768`，归 WP-097） |
| 所有 `DATABASE_ERROR`（连接失败） | 正常空库不可达 | 不计 |

## 6. 剩余命令（不在本包）

> WP-226 之后：导入导出、`edit_and_resend`、`continue_message`、变体删除/取消、分组、标签、目标、`plan_gate_respond`、压缩、RAG scope、`list_sessions_referencing`、`list_agent_sessions`、anki 查询已进入 §8；下列清单保留为 WP-072 当时的记录。

L04 contract 中仍未进入 v0 语料的命令，按后续包分组：

- 导入导出：`chat_v2_export_session`、`chat_v2_export_session_jsonl`、`chat_v2_export_session_messages`、`chat_v2_export_session_meta`、`chat_v2_import_session`（等 C04-01 解码器）。
- 无前端调用：`chat_v2_soft_delete_session`、`chat_v2_empty_deleted_sessions`、`chat_v2_session_message_count`、`chat_v2_copy_block_content`。
- 流式/发送/变体（L03 组）：`chat_v2_send_message`、`chat_v2_retry_message`、`chat_v2_retry_variant(s)`、`chat_v2_edit_and_resend`、`chat_v2_continue_message`、`chat_v2_wake_session`、`chat_v2_workspace_send_message`、`chat_v2_workspace_manual_wake` 及变体命令。
- 分组、标签、目标、工作区、权限/授权（`set_authority_mode`、`set_permission_preset`、`plan_gate_respond`）、压缩（`compact_session`、`undo_compaction`）、RAG scope、`list_sessions_referencing`、`list_agent_sessions`、anki 查询等。分组命令 `create_group`/`update_group` 本包只作辅助步骤使用。

## 7. 校验记录

最小 JSON/契约检查（临时脚本，未提交）：JSON 可解析；顶层键与场景键严格；scenario id 唯一；`seed`/`capture`/`normalize` 固定；`cmd` 在 `contracts/ipc/L04-chat-session.json` 中，有 Rust `#[tauri::command]`，并在 `host/plugins/chat/src/register.ts` 注册；成功步骤参数键是 contract 键的子集且含全部必填键；`${n}` 只指向更早的非错误步骤且为整串引用；每条本包命令至少一个成功步骤，除 `get_message_summary` 外至少一个错误步骤。

结果：作业 `20261105164613-854d5c`，退出码 0（`files=2 scenarios=24 steps=347 owned_commands=18`，`CHECK OK`）。L04 contract 共 107 条命令，本包覆盖 18 条。

## 8. WP-226（G3 命令语料 v1）：35 条命令 + 8 条补错误

工作包 WP-226，命令清单见 `.oc-runs/board/corpus/WP-226-L04-chat-session.md`（35 条，按 D-059 全部编写，不受 20 条 / 单功能组上限约束）。另外 8 条已有成功场景的命令补错误场景：`create_group`、`get_message_summary`、`tool_approval_respond`、`update_group`、`workspace_create`、`workspace_list_agents`、`workspace_list_messages`、`workspace_send_message`。**同样没有执行任何 A/B 重放。** `TESTMAP` 未改动。

| 文件 | 场景 | 步骤 | 被测命令 |
|---|---|---|---|
| `tags.json` | 2 | 41 | add_tag、remove_tag、get_tags_batch、list_all_tags |
| `goals.json` | 2 | 33 | goal_get/pause/resume/edit/clear（空库：无目标分支与只读守卫） |
| `control.json` | 7 | 68 | plan_gate_respond、tool_approval_respond、ask_user_respond、clear_approval_history、emergency_stop、kill_switch_status、has_active_stream、migrate_legacy_chat、check_migration_status |
| `groups.json` | 4 | 79 | create/update/delete/get/list_groups、move_session_to_group |
| `snapshot-export.json` | 4 | 66 | export_session、export_session_meta、export_session_messages、import_session |
| `session-misc.json` | 7 | 101 | get_rag_scope、list_sessions_referencing、list_agent_sessions、compact_session、get_anki_cards_from_block_by_document_id、perform_ocr |
| `resend-variant.json` | 5 | 79 | delete_variant、cancel_variant、edit_and_resend、continue_message |
| `workspace-errors.json` | 1 | 34 | workspace_create、workspace_list_agents、workspace_list_messages、workspace_send_message |
| `goals-todos.seeded.json` | 4 | 47 | goal_*（有目标的状态机）、continue_message（有 TodoList） |
| `l04-wp226-goal-todo.sql` | — | — | 种子规格：9 行 `chat_v2_goals`、5 行 `chat_v2_todo_lists` 及其会话/消息/块 |

合计 36 个场景、548 步（成功 346 / `expect:"error"` 202），顶层 8 个文件 32 个场景用 `seed:"empty"`；`pending-seed/` 下 4 个场景用 `seed:"l04-wp226-goal-todo"`，沿用 L22 做法（`host/plugins/integration/equivalence/README.md`）：在 X3 的种子机制就绪前不放入顶层，避免 runner 遇到未知 seed。

### 8.1 运行器约定（在 §1 之上新增）

1. **无 LLM 造用户消息与变体**：`chat_v2_import_session` 吃手写快照 JSON（字符串，`snapshotJson`），能造 user 消息、多变体消息（含 `streaming`/`error` 状态变体）和只读会话；导入会重新生成会话/消息/块/变体 ID，所以紧跟 `chat_v2_load_session`，后续经 `${n.messages.k.id}`、`${n.messages.k.variants.j.id}` 引用。
2. **只读会话**：`create_session {metadata:{is_subagent:true}}` 或导入 `mode:"subagent"`；`metadata.is_subagent:"true"`（字符串）不算只读（`handlers/mod.rs:29-47`），`goals.json` 用它作对照。
3. **模拟 LLM（owner X5）**：经 `save_api_configurations` 写入 `baseUrl: http://127.0.0.1:18461/v1`、`apiKey:""`、`authMode:"none"` 的配置，模型名即 X5 脚本名：
   - `wp226-resend`：普通 SSE 文本回答（edit_and_resend 成功）。
   - `wp226-continue`：普通 SSE 文本回答（continue_message 成功）。
   - `wp226-hang`：收到请求后一直不返回，直到客户端断开（制造"流进行中"；场景最后用 `chat_v2_cancel_stream` 或 `chat_v2_emergency_stop` 收尾）。
   - `wp226-ocr`：`isMultimodal:true`，返回一段固定识别文本（perform_ocr 成功）。
   模拟服务未就绪时这些步骤在 A 侧会得到连接错误，A 的实际结果仍是答案；不连互联网、不用真实 key。
4. **全局急停状态**：kill switch 是进程级状态。每个触发 `chat_v2_emergency_stop` 的场景都以 `chat_v2_resume_agents` + `chat_v2_resume_automations` 收尾（前端 `src/features/workbench/components/AgentControlCenter.tsx:394,410`），runner 若复用进程也不会污染后续场景。
5. **辅助命令**（不计入覆盖，均为前端可达）：`create_session`、`upsert_streaming_block`、`archive_session`、`delete_session`、`get_session`、`list_sessions`、`save_session`、`load_session`、`cancel_stream`、`set_rag_scope`（`src/features/chat/kbScope/kbScope.ts:37`）、`save_setting`/`get_setting`（L19）、`save_api_configurations`（L02）、`workspace_create_agent`、`resume_agents`/`resume_automations`。
6. **事件**：goal 状态变化在 `chat_v2_session_{id}` 上 emit `goal_updated`；`tool_approval_respond` 超时会 emit 一条 `approval_expired` 错误事件；流式命令（edit_and_resend / continue / hang）产生完整流事件序列。`events:true` 全部保留，不抹顺序和数量。

### 8.2 命令、调用点与可达 Err / 早退

Rust 路径相对 `src-tauri/crates/dstu-agent/src/chat_v2/`：`sh` = `handlers/search_handlers.rs`，`gh` = `handlers/goal_handlers.rs`，`grp` = `handlers/group_handlers.rs`，`exh` = `handlers/export_handlers.rs`，`snh` = `handlers/snapshot_handlers.rs`，`ms` = `handlers/manage_session.rs`，`ba` = `handlers/block_actions.rs`，`ocr` = `handlers/ocr.rs`，`sm` = `handlers/send_message.rs`，`vh` = `handlers/variant_handlers.rs`，`ap` = `handlers/approval_handlers.rs`，`au` = `handlers/ask_user_handlers.rs`，`ks` = `kill_switch.rs`，`mig` = `handlers/migration.rs`，`wh` = `handlers/workspace_handlers.rs`，`wc` = `workspace/coordinator.rs`，`wdb` = `workspace/database.rs`。前端路径相对 `src/`。"只读守卫" = `ensure_session_writable`（`handlers/mod.rs:29`，会话不存在时放行）。错误线格式同 §2：除特别注明外为 `{"code","message"}` JSON；`wh`/`wc` 的错误是**裸字符串**，`export_session_meta` 的 SessionNotFound 用 `.to_string()`（Display 文本，不是 JSON），`import_session` 落库阶段的错误也是裸字符串。所有命令还有 IPC 反序列化错误（缺必填键、类型错、整数越界），表中不重复列。

| 命令 | 前端 | Rust | 可达 Err / 早退（按执行顺序） |
|---|---|---|---|
| add_tag | `features/chat/hooks/useSessionTags.ts:76` | `sh:117` | 前缀校验 `Invalid session ID format` VALIDATION（`sh:12-20`）→ `Tag must not be empty`（trim 后，`sh:125`）→ 会话不存在时 FK 失败 DATABASE_ERROR；存储 trim 后的标签，重复 `INSERT OR IGNORE` |
| remove_tag | `useSessionTags.ts:93` | `sh:132` | 前缀校验 → `Tag must not be empty`（trim 判空，`sh:140`）；删除按原串，0 行也 Ok |
| get_tags_batch | `useSessionTags.ts:55` | `sh:107` | 无业务 Err；空数组返回 `{}`，不校验 ID |
| list_all_tags | `useSessionTags.ts:44` | `sh:147` | 无业务 Err；只计活跃会话，`cnt DESC, tag ASC` |
| goal_get | `features/chat/core/store/sessionActions.ts:492` | `gh:75` | 无业务 Err（不做前缀校验，无目标返回 null） |
| goal_pause | `sessionActions.ts:503` | `gh:85` | 只读守卫 → `cannot pause goal because this session has no goal`（`gh:97`）；仅 active/waiting_user 生效，其他状态原样返回 |
| goal_resume | `sessionActions.ts:510` | `gh:126` | 只读守卫 → `…cannot resume goal… no goal`（`gh:140`）；仅 paused/blocked/budget_limited/usage_limited 生效 |
| goal_edit | `sessionActions.ts:517` | `gh:174` | 只读守卫 → `objective 不能为空`（`gh:187`）→ `token_budget 必须是正整数`（`gh:193`）→ `…cannot edit goal… no goal`（`gh:203`）→ `cannot edit a completed goal…`（`gh:208`） |
| goal_clear | `sessionActions.ts:528` | `gh:231` | 只读守卫；无目标静默 Ok |
| create_group | `features/chat/hooks/useGroupManagement.ts:49`、`quick-assistant/service.ts:130` | `grp:145` | `defaultRuntimeRootId` 为绝对路径 VALIDATION（`grp:124`）→ 运行时根 id 解析失败 VALIDATION；空白 id 视为未设置 |
| update_group | `useGroupManagement.ts:70,92`、`components/ModernSidebar.tsx:714` | `grp:197` | GroupNotFound（`grp:209`）、`defaultRuntimeRootId` 同 create 的两条 |
| delete_group | `features/settings/components/data-governance/ChatSessionArchiveTab.tsx:210` | `grp:285` | GroupNotFound（`grp:295`）→ 活跃课题 `请先归档课题，再从归档页永久删除。`（`grp:298`）→ 组内会话在流中 OTHER（`grp:306`）→ 组内会话有运行中 anki 块 OTHER（`grp:314`） |
| get_group | `features/chat/core/store/restoreActions.ts:1086` | `grp:368` | 无业务 Err，缺失返回 null |
| list_groups | `ChatSessionArchiveTab.tsx:68-73`、`quick-assistant/service.ts:122` | `grp:398` | 无业务 Err |
| move_session_to_group | `features/chat/pages/useSessionEdit.ts:319`、`ModernSidebar.tsx:653` | `grp:438` | 目标组非 active GroupNotFound（`grp:453`）、组不存在 GroupNotFound（`grp:456`）；会话不存在不报错（0 行 Ok） |
| export_session | `features/chat/api/sessionBrowserApi.ts:36` | `exh:56` | 空/空白 ID `Invalid session ID: empty or whitespace-only`（`exh:18-27`）→ 前缀校验 → `Invalid export format`（区分大小写，`exh:66`）→ SessionNotFound（`exh:76`） |
| export_session_meta | `sessionBrowserApi.ts:86` | `snh:82` | SessionNotFound，Display 文本（`snh:91`） |
| export_session_messages | `sessionBrowserApi.ts:90` | `snh:116` | 无业务 Err（缺失会话返回空分页）；`offset`/`limit` 必填 u32 |
| import_session | `sessionBrowserApi.ts:94` | `snh:189` | 大于 50 MiB（`snh:195`）→ `Invalid snapshot JSON: …`（含缺字段、枚举值非法，`snh:203`）→ `Unknown snapshot format`（`snh:208`）→ `Unsupported snapshot version`（`snh:215`）→ 事务内落库失败，裸字符串（`snh:462-485`） |
| get_rag_scope | `features/chat/kbScope/kbScope.ts:28` | `ms:2980` | 无业务 Err（`unwrap_or_default`，`ms:2985`） |
| list_sessions_referencing | `features/pdf/components/PdfRelatedPanel.tsx:29` | `ms:2938` | 无业务 Err；`limit` 默认 20，夹到 1..100（`ms:2948`） |
| list_agent_sessions | `features/chat/workspace/api.ts:542` | `ms:671` | 无业务 Err；`limit` 默认 50（`ms:683`） |
| compact_session | `features/chat/components/input-bar/InputBarV2.tsx:1022` | `ba:56` | 只读守卫（`ba:65`）→ `modelConfigId is required`（trim 判空，`ba:67`）→ 流中返回 Ok `skipped/streaming`（`ba:78-85`）；短会话 `sessionTooShort`、可用窗口小于 4096 `usableTooSmall` 均为 Ok |
| get_anki_cards_from_block_by_document_id | `features/anki-tasks/components/SessionRow.tsx:177` | `ba:552` | `documentId is required`（trim 判空，`ba:560`） |
| perform_ocr | `features/chat/plugins/modes/analysis.ts:164`、`quick-assistant/service.ts:223` | `ocr:44` | `At least one image is required`（`ocr:56`）→ 系统 OCR 路径：`Failed to parse image N`（`ocr:70`）→ `System OCR failed`（Linux 不可用，`ocr:80`）；VLM 路径：`Failed to parse image N`（`ocr:97`）→ 无可用 OCR 模型 / 上游失败 `OCR failed: …` LLM（`ocr:116`） |
| delete_variant | `features/chat/adapters/tauri/variantOperations.ts:57` | `vh:224` | 只读守卫（`vh:236`）→ MessageNotFound（`vh:254`）→ `Permission denied: cannot delete variant for message in another session`（`vh:1144` 模板）→ 无变体 VariantNotFound（`vh:261`）→ 最后一个 VariantCannotDeleteLast（`vh:265`）→ VariantNotFound（`vh:272`）→ `Cannot delete a streaming variant…`（`vh:280`） |
| cancel_variant | `variantOperations.ts:190` | `vh:1085` | 无只读守卫；`Variant X does not belong to session Y`（`vh:1167`，变体不存在也走此条）；其他情况 Ok |
| edit_and_resend | `features/chat/adapters/tauri/messageOperations.ts:365` | `sm:1267` | 只读守卫（`sm:1292`）→ `New content cannot be empty`（`sm:1296`）→ MessageNotFound → `Can only edit user messages`（`sm:1305`）→ `Message X does not belong to session Y`（`sm:1311`）→ 急停 `admit_or_block`（`sm:1317`）→ 会话已有流 |
| continue_message | `messageOperations.ts:439` | `sm:2010` | 只读守卫（`sm:2030`）→ `Failed to load TodoList: …` OTHER（`sm:2035`）→ `No incomplete TODO list found. Cannot continue execution.`（`sm:2044`）→ messageId 不一致只 warn（`sm:2051`）→ `TODO list is already complete. No need to continue.`（`sm:2063`）→ 急停（`sm:2076`）→ 会话已有流 |
| has_active_stream | `features/chat/adapters/tauri/sendOperations.ts:52,376`、`features/chat/workspace/events.ts:265` | `sm:890` | 无 Err（同步 bool） |
| plan_gate_respond | `features/chat/components/PlanGateCard.tsx:71` | `ms:2185` | 无等待中的 gate 或 planId 不匹配：TIMEOUT `plan_gate_expired: no waiting plan gate for tool_call_id=X`（`ms:2209`） |
| tool_approval_respond | `features/chat/components/ToolApprovalCard.tsx:189`、`input-bar/BlockingApprovalBar.tsx:203` | `ap:39` | `tool_call_id must not be empty` INVALID_INPUT（trim 判空，`ap:54`）→ 无等待审批 TIMEOUT `approval_expired: …` 并 emit 错误事件（`ap:85-95`） |
| ask_user_respond | `features/chat/components/input-bar/BlockingAskUserBar.tsx:138`、`plugins/blocks/askUserBlock.tsx:188` | `au:44` | `tool_call_id must not be empty`（trim 判空，`au:53`）→ source 不在 `user_click|custom_input|mixed|timeout|channel_closed`（区分大小写）INVALID_INPUT（`au:56`）；无等待中的 ask 时 Ok |
| clear_approval_history | `features/settings/components/mcp-tools/useToolPermissions.tsx:355` | `ap:178` | 只有 DATABASE_ERROR（`ap:189-196`），不可达。前缀删除走 SQL `LIKE`，`_` 是通配符且不区分大小写 |
| emergency_stop | `features/workbench/components/AgentControlCenter.tsx:377` | `ks:194` | 无业务 Err；重复急停幂等，`reason` 可缺省 |
| kill_switch_status | `AgentControlCenter.tsx:284` | `ks:290` | 无 Err |
| migrate_legacy_chat | `api/dataGovernance.ts:1208` | `mig:35` | 只有取连接 DATABASE_ERROR，不可达；内部失败返回 Ok + `status: Failed` |
| check_migration_status | `api/dataGovernance.ts:1200` | `mig:18` | 只有取连接 DATABASE_ERROR，不可达 |
| get_message_summary | `sc`（见 §2.2） | `ms:1109` | 只有 DATABASE_ERROR，不可达 |
| workspace_create | `features/chat/workspace/api.ts:128` | `wh:606` | 只有 DB / 文件系统失败，空库正常启动下不可达 |
| workspace_list_agents | `workspace/api.ts:198` | `wh:866` | 非成员 `Permission denied: session is not a workspace member`（`wc:831`）、`Workspace not found: X`、非法 workspace_id `[A-Za-z0-9_-]` / 长度（`wdb:143,153`） |
| workspace_list_messages | `workspace/api.ts:225` | `wh:935` | 同 list_agents 三条 |
| workspace_send_message | `workspace/api.ts:211` | `wh:902` | `Broadcast message must not specify target_session_id`（`wh:917`）→ 非成员 `Permission denied: sender is not a workspace member`（`wc:452`）→ `Target agent not found: X`（`wc:456`）→ 工作区不存在 / 非法 ID；请求体键为 snake_case |

### 8.3 覆盖表（场景#步骤）

步骤号 0 起；场景名省略公共前缀 `chat.`。成功列只算未标 `expect` 的步骤（不含 not-found 或空参数失败）；错误列按分支列出，末尾 "IPC" 为反序列化错误补充，不计入处理函数分支。

| 命令 | 成功步骤 | 错误 / 早退步骤 → 分支 |
|---|---|---|
| add_tag | `tag.crud_trim_batch_archive#2-7`（trim、重复、多标签） | 前缀 `tag.errors_prefix_empty_fk#1,2,5`；空标签 `#3,4`；FK `#6`；IPC `#7` |
| remove_tag | `tag.crud_trim_batch_archive#12,14-16`（含不存在标签 0 行） | 前缀 `tag.errors_prefix_empty_fk#8,11`；空标签 `#9,10`；IPC `#12` |
| get_tags_batch | `tag.crud_trim_batch_archive#8-10,13,17,21,23`；`tag.errors_prefix_empty_fk#15` | 无业务 Err；IPC `tag.errors_prefix_empty_fk#13,14` |
| list_all_tags | `tag.crud_trim_batch_archive#11,18,20,24`（含归档后不计） | 无业务 Err（`sh:147`） |
| goal_get | `goal.no_goal_get_clear_and_errors#1-4`；`goal.subagent_readonly_guard#2`；`seeded.goal.pause_resume_states#0,12`（孤立目标）；`seeded.goal.edit_clear#8,10` | 无业务 Err；IPC `goal.no_goal_get_clear_and_errors#20` |
| goal_pause | `seeded.goal.pause_resume_states#1,2,5,7,10,13`（active、重复、waiting_user、budget 不变、complete 不变、孤立目标） | 只读 `goal.subagent_readonly_guard#3`；无目标 `goal.no_goal_get_clear_and_errors#7,16`、`goal.subagent_readonly_guard#7`（字符串 "true" 非只读）、`seeded.goal.edit_clear#12`（clear 后）；IPC `goal.no_goal_get_clear_and_errors#21` |
| goal_resume | `seeded.goal.pause_resume_states#3,4,6,8,9,11` | 只读 `goal.subagent_readonly_guard#4`；无目标 `goal.no_goal_get_clear_and_errors#8`；IPC `#22` |
| goal_edit | `seeded.goal.edit_clear#0-4`（trim、只改描述、预算置 null、2^53-1、paused 可编辑） | 只读 `goal.subagent_readonly_guard#5`；空 objective `goal.no_goal_get_clear_and_errors#10,11,14`、`seeded.goal.edit_clear#6`；预算非正 `goal.no_goal_get_clear_and_errors#12,13`、`seeded.goal.edit_clear#7`（预算先于完成态）；无目标 `goal.no_goal_get_clear_and_errors#9,15`；已完成 `seeded.goal.edit_clear#5`；IPC `goal.no_goal_get_clear_and_errors#17-19` |
| goal_clear | `goal.no_goal_get_clear_and_errors#5,6`（无目标、会话不存在）；`goal.subagent_readonly_guard#8`；`seeded.goal.edit_clear#9,11,13` | 只读 `goal.subagent_readonly_guard#6`；IPC `goal.no_goal_get_clear_and_errors#23` |
| create_group | `group.lifecycle_get_list_move_delete#0-3`；`group.create_update_errors#2,3`（空白根 id）等 11 步 | 绝对路径 `group.create_update_errors#0`；未知根 `#1`；IPC `#4-6` |
| update_group | `group.create_update_errors#15-18`；`group.lifecycle_get_list_move_delete#24`；`group.delete_errors_and_deleted_status#6,14` 等 10 步 | GroupNotFound `group.create_update_errors#8,9`；绝对路径 `#10`；未知根 `#11`；IPC `#12-14` |
| delete_group | `group.lifecycle_get_list_move_delete#27`；`group.delete_errors_and_deleted_status#11,15`（archived、deleted 状态） | 活跃课题 `group.delete_errors_and_deleted_status#1`；GroupNotFound `#2,3,12`；运行中 anki 块 `#7,9`；流中 `resend.hanging_stream_conflicts#10`；IPC `group.delete_errors_and_deleted_status#16` |
| get_group | `group.lifecycle_get_list_move_delete#6-8,25,28`；`group.create_update_errors#19` | 无业务 Err（`grp:368`） |
| list_groups | `group.lifecycle_get_list_move_delete#9-15,26,30`；`group.create_update_errors#7` | 无业务 Err（`grp:398`） |
| move_session_to_group | `group.lifecycle_get_list_move_delete#16-23`（移入、移出 null、会话不存在 no-op）；`resend.hanging_stream_conflicts#4` | 组不存在 `group.move_errors#2,8`；组 archived `#4`；组 deleted `#7`；IPC `#9` |
| export_session | `export.markdown_json_meta_pages#3-6,18,19`（markdown / json / 含思维链） | 空/空白 `export.errors#0,1`；格式 `#3,4,5`（html、大小写、空串）；SessionNotFound `#6`；前缀 `#7`；格式先于存在性 `#8`；IPC `#9` |
| export_session_meta | `export.markdown_json_meta_pages#7,20,22`；`snapshot.import_roundtrip#9` | SessionNotFound `export.errors#10,11`；IPC `#12` |
| export_session_messages | `export.markdown_json_meta_pages#8-10,12-16`（分页、越界 offset）；`snapshot.import_roundtrip#10` | 无业务 Err；IPC `export.errors#13-15` |
| import_session | `snapshot.import_roundtrip#0,2,4,6,8`；另 8 步作其他场景的前置 | 非 JSON `snapshot.import_errors#0,1`；未知格式 `#2,5`（格式先于版本）；版本 `#3,4,10`；缺字段 / 枚举非法 `#6,7,8,9`；重复消息 ID `#11`（落库阶段）；IPC `#12,13` |
| get_rag_scope | `misc.rag_scope#1,3,5,7-9`（无 scope、设置后、清空、会话不存在） | 无业务 Err；IPC `misc.rag_scope#10,11` |
| list_sessions_referencing | `misc.sessions_referencing#6-18,20`（默认 20、limit 0/1/100/101 夹取、空数组、导入会话） | 无业务 Err；IPC `misc.sessions_referencing#21-23` |
| list_agent_sessions | `misc.list_agent_sessions#5-12,14,15` | 无业务 Err；IPC `misc.list_agent_sessions#16,17` |
| compact_session | `misc.compact_session_no_llm_outcomes_and_errors#1,2,4-6`（sessionTooShort、u32 上界、会话不存在）；流中 skipped `resend.hanging_stream_conflicts#8` | 空 modelConfigId `misc.compact_session_no_llm_outcomes_and_errors#7,8`；只读 `#10,11`（只读先于空 id）；IPC `#12,13` |
| get_anki_cards_from_block_by_document_id | `misc.anki_cards_by_document_id#7-13` | 空 / 空白 documentId `#14,15`；IPC `#16,17`（snake_case 键、缺键） |
| perform_ocr | `misc.perform_ocr_mock_vlm#2,3`（data URL、裸 base64 + jpeg） | 空数组 `misc.perform_ocr_errors_no_model#0`；解析失败 `#1,2,3`、`misc.perform_ocr_mock_vlm#4`（第 2 张坏图）；无 OCR 模型 `misc.perform_ocr_errors_no_model#4`；系统 OCR 失败 `#8`；系统 OCR 路径解析失败 `#9`；IPC `#5,6` |
| delete_variant | `variant.delete_cancel_no_llm#9,10` | 流中变体 `variant.delete_cancel_no_llm#2`；VariantNotFound `#5`；最后一个变体 `#6,12`；无变体消息 `#7`；MessageNotFound `#8,23`；跨会话 `#14`；只读 `#22`；IPC `#18` |
| cancel_variant | `variant.delete_cancel_no_llm#3,17,24`（流中变体、非流中、只读会话无守卫） | 不属于会话 `variant.delete_cancel_no_llm#4,15,16`；IPC `#19` |
| edit_and_resend | `resend.edit_and_resend_mock_llm#3,5`（X5 `wp226-resend`）；`resend.hanging_stream_conflicts#5`（X5 `wp226-hang`） | 空内容 `resend.edit_continue_errors_no_llm#2,3`；MessageNotFound `#4,5`；非 user 消息 `#6`；跨会话 `#8,9`；只读 `#12`（只读先于空内容）；急停 `killswitch.blocks_edit_and_resend#3`；已有流 `resend.hanging_stream_conflicts#7`；IPC `resend.edit_continue_errors_no_llm#13,14` |
| continue_message | `seeded.continue.mock_llm_success#1,3`（X5 `wp226-continue`；#3 为 messageId 不一致只 warn）；`seeded.continue.errors_and_conflicts#9`（X5 `wp226-hang`） | 无 TodoList `resend.edit_continue_errors_no_llm#15,16,17`、`seeded.continue.errors_and_conflicts#1`（is_all_done=1）；只读 `resend.edit_continue_errors_no_llm#18`；坏 steps_json `seeded.continue.errors_and_conflicts#2`；已全部完成 `#0,5`（#5 在急停中，完成检查先于急停）；急停 `#4`；已有流 `#11`；IPC `resend.edit_continue_errors_no_llm#19` |
| has_active_stream | `has_active_stream.idle_values#1-4`；流中 `resend.hanging_stream_conflicts#6`、`seeded.continue.errors_and_conflicts#10`；急停后 `resend.hanging_stream_conflicts#12` | 无 Err；IPC `has_active_stream.idle_values#5,6` |
| plan_gate_respond | **无**（见 §8.4） | 无等待 gate TIMEOUT `plan_gate.respond_no_waiting_gate#0,1,2`；IPC `#3,4` |
| tool_approval_respond | 已有：`host/plugins/chatanki/equivalence/library-cards.json`（L24 场景，真实审批流） | 空 / 空白 tool_call_id `approval.respond_errors#0,1`；无等待审批 TIMEOUT + 错误事件 `#2,3,4`；IPC `#5,6,7` |
| ask_user_respond | `ask_user.respond_sources_and_errors#0-4`（5 种合法 source，无等待中的 ask 时 Ok） | 空 / 空白 tool_call_id `#5,6,9`（id 先于 source）；非法 source `#7,8`；IPC `#10,11,12` |
| clear_approval_history | `approval.clear_history_prefix_like#0,7,12`（空库、v1/v2 前缀、大写键、`_` 通配、清后再清） | 无可达 Err（只有 DATABASE_ERROR，`ap:189-196`） |
| emergency_stop | `killswitch.trip_retrip_resume#1,3,7,9,11`（重复、空白、null、缺省 reason）；另 3 步作前置 | 无业务 Err；IPC `killswitch.trip_retrip_resume#16` |
| kill_switch_status | `killswitch.trip_retrip_resume#0,2,4,6,12,15`；`killswitch.blocks_edit_and_resend#4,8` | 无 Err |
| migrate_legacy_chat | `migration.check_and_migrate_fresh_db#1,3`（空库、重复执行） | 无可达 Err |
| check_migration_status | `migration.check_and_migrate_fresh_db#0,2` | 无可达 Err |
| get_message_summary | 已有：§3 中 `S`/`M` 的 7 步 | 无可达 Err：只有 DATABASE_ERROR（`ms:1109` 起，取连接与查询），空库正常启动下不可达 |
| workspace_create | `workspace.member_routing_errors#0,29,30`；`misc.list_agent_sessions#0,2` | 无可达业务 Err（只有 DB / 文件系统失败，`wh:606`）；IPC `workspace.member_routing_errors#31-33` |
| workspace_list_agents | `workspace.member_routing_errors#2,3` | 非成员 `#4`；工作区不存在 `#5`；非法 ID `#6,7`；IPC `#8` |
| workspace_list_messages | `workspace.member_routing_errors#9,14-16` | 非成员 `#25`；工作区不存在 `#26`；非法 ID `#27`；IPC `#28` |
| workspace_send_message | `workspace.member_routing_errors#10-13`（广播、点对点、creator 与成员） | 广播带 target `#17`；非成员 `#18,22`；目标不存在 `#19`；工作区不存在 `#20`；非法 ID `#21`；IPC `#23,24`（缺键、camelCase 键） |

### 8.4 不可达 / 需种子或外部服务

| 分支 / 命令 | 原因 | 需要（owner） |
|---|---|---|
| goal_* 有目标的全部分支；continue_message 的 TodoList 分支 | 目标只能由模型工具 `goal_update` 写入（`tools/goal_executor.rs:209`），TodoList 只能由模型 todo 工具写入；没有前端可达 IPC | 种子 `l04-wp226-goal-todo`（`l04-wp226-goal-todo.sql`，已在全部 chat_v2 迁移之上验证可应用）及 seed 目录机制（X3）。场景已写在 `goals-todos.seeded.json` |
| edit_and_resend / continue_message 成功、流中冲突；compact_session 流中；delete_group 流中；perform_ocr 成功 | 需要模拟 LLM / VLM | X5 在 `127.0.0.1:18461` 提供 `wp226-resend`、`wp226-continue`、`wp226-hang`、`wp226-ocr` 四个脚本（§8.1） |
| plan_gate_respond 成功 | 需要 Plan 模式下由模型发起写工具调用并停在 gate；`planId` 是运行时随机生成、只出现在 `plan_gate` 事件和会话 metadata 中，静态步骤无法引用；另外 `load_session` 会把非 Craft 模式改回 Craft（`handlers/load_session.rs:88-94`，产品 UI 已移除 Ask/Plan） | X5 脚本化写工具调用 + runner 支持"等待事件并引用事件字段"（runner owner）；先确认该功能是否仍需等价（C1） |
| tool_approval_respond 成功（本目录） | 需要等待中的审批，同上需模型发起敏感工具调用 | 已由 L24 `chatanki/equivalence/library-cards.json` 覆盖 |
| compact_session `compacted` | 需要足够长的会话与模型摘要 | X5 摘要脚本 + 长会话种子 |
| migrate_legacy_chat / check_migration_status 有旧数据 | 需要 `mistakes.db` 中旧 `chat_messages` + `mistakes` 行 | 种子（X3） |
| import_session 大于 50 MiB | 字面量放进场景不现实 | 运行器参数生成（同 §5） |
| clear_approval_history、migrate_*、get_message_summary、workspace_create 的 DATABASE_ERROR / IO | 故障注入 | 运行器故障注入 |
| delete_group 运行中 anki 块之外的"另一个会话在流中" | 已用 `wp226-hang` 覆盖一条；多会话并发不再展开 | — |

待 A 判定的语义点（不预写答案）：`import_session` 快照内重复消息 ID 时，ID 映射会把两条消息映射到同一个新 ID（`snh:228-230`），落库是 PK 冲突回滚还是覆盖由 A 决定；`perform_ocr` 在没有任何 OCR 配置时走 paddle 回退引擎（非系统 OCR），所以 `misc.perform_ocr_errors_no_model#1` 在解析阶段就失败；`goal_edit` 预算校验先于"已完成"检查（`seeded.goal.edit_clear#7`）。

### 8.5 校验记录

临时脚本（`/tmp/opencode/wp226/validate.mjs`，未提交），检查本目录全部 11 个 JSON（含 WP-072 的两个）：JSON 可解析；顶层 / 场景 / 步骤键严格；scenario id 全局唯一；写步骤 `capture {events:true, db:["*"]}`、`normalize: []`；`cmd` 在 `contracts/ipc/*.json` 中；成功步骤参数键是 contract 键的子集且含全部必填键；`${n.path}` 为整串引用、只指向更早的非错误步骤；35 条命令全部在某文件 `commands` 中声明，除 `plan_gate_respond` 外都有成功步骤；除上表"无可达 Err"的命令外都有错误步骤；8 条补错误命令中除 `get_message_summary`、`workspace_create` 外都有错误步骤。全部 43 条命令在 `host/plugins/chat/src/register.ts` 注册。

结果：作业 `20261106022333-fa8aa5`，退出码 0（`files=11 scenarios=60 steps=895 C35=35`，`OK`）。种子 SQL：作业 `20261106022634-acea9c`，在内存库按序应用全部 `migrations/chat_v2/V*.sql` 后执行，退出码 0（13 会话 / 10 消息 / 10 块 / 9 目标 / 5 TodoList）。

计数：新增 36 场景 / 548 步 / 42 条被测命令声明（35 条清单命令 + 7 条补错误命令；`get_message_summary` 无可达分支，不声明）；成功步骤 346，错误步骤 202。35 条中有成功步骤 34 条（缺 `plan_gate_respond`），有处理函数错误分支步骤 20 条，其余 15 条无可达业务 Err（get_tags_batch、list_all_tags、goal_get、get_group、list_groups、export_session_messages、get_rag_scope、list_sessions_referencing、list_agent_sessions、has_active_stream、clear_approval_history、emergency_stop、kill_switch_status、migrate_legacy_chat、check_migration_status）。8 条补错误命令中 6 条有错误分支步骤，`get_message_summary`、`workspace_create` 无可达分支（理由见 §8.3）。

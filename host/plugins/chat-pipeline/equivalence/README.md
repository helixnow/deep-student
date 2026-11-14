# WP-061 工作区注入语料（WAVE0 v0）

只选5个真实前端命令。L03无IPC；聊天与工作区外层命令归L04，实际工作区提供方为L05。
本目录语料未运行 A/B、未计 C；normalize=[]，无伪造 expected。
Node-only命令冒烟已由真实kernel执行全部5场景（job 20261105154717-23e585，同文件22测试通过）；
其中idle/empty实际等待会话终态并验证队列/块，不能代替A端golden或桌面B重放。

| 命令 | owner | 前端 | Rust（相对src-tauri/） |
|---|---|---|---|
| save_api_configurations | L02 | src/utils/configApi.ts:108 | src/commands.rs:2150 |
| workspace_create | L04→L05 | src/features/chat/workspace/api.ts:128 | crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:607 |
| workspace_create_agent | L04→L05 | 同文件:189 | 同Rust文件:681 |
| chat_v2_send_message | L04→L03 | src/features/chat/adapters/tauri/sendOperations.ts:166–188 | crates/dstu-agent/src/chat_v2/handlers/send_message.rs:462 |
| chat_v2_cancel_stream | L04 | src/features/chat/adapters/tauri/messageOperations.ts:80 | 同Rust文件:860 |

契约分别为 contracts/ipc/L02-llm-manager.json 与 L04-chat-session.json。
工作区命令归属按真实注册与契约，不按provider目录推断为L05。

## 成功前置与参数化离线服务器

seed=empty。通过公开 workspace_create_agent(role=coordinator) 同时创建真实可写的 agent ChatSession
及 workspace member；initial_task 自动从 creator 发往该 agent 的 inbox（workspace_handlers.rs:769–780）。
coordinator 角色不触发 worker 自动派发（:817），因此不依赖另一条后台Agent流；没有假seed/私有IPC。
空队列场景显式 initial_task=null；错误场景保留 role 缺省、缺省与null、非法session前缀。

JSON的 `http://127.0.0.1:18461/v1` 是**待X5启动的参数化环回地址**，不是已运行服务器。
录制时将所有 baseUrl 同步替换为X5实际端点，两后端用同一端点，不访问互联网、无需API key。
所需HTTP脚本（由模型名选择）：
- `wp061-idle`：第1/2次请求分别SSE正文 `first answer` / `after workspace`，usage=9/3/12，finish_reason=stop、[DONE]。
- `wp061-empty`：只一轮正文 `empty queue answer`，同usage及结束标记。
- `wp061-cancel`：保持请求未完成直到取消；不能用立即EOF替代取消。

`send`返回的是异步任务准入ID，不能当终态成功。X7/X5运行器须捕获到stream_complete/error/cancelled并等待
tracked task清理后再采DB；当前v0只有顺序steps，没有事件屏障，不能声称精确取消检查点已录制。
本包源码测试的before-injection、工具内取消、continuation取消已有独立证据，A/B阶段时序仍待X5/X7。

## 场景及分支

| 场景ID（前缀chat-pipeline.workspace.） | 分支/观察 |
|---|---|
| idle | 配置→工作区→coordinator+initial_task→send；真实注入/出队/第二次HTTP请求/块事件/最终库 |
| empty | initial_task=null；空队列不续跑、不创建workspace_injection块 |
| cancel | 有待处理消息→send→cancel；取消成功+另一无活跃流session错误；精确取消时机待事件屏障 |
| send-errors | 非法ID、空内容、并发active stream；随后取消清理；保留IPC拒绝与异步终态区分 |
| owner-errors | create_agent非法成员/不存在workspace；配置缺必填字段（serde），cancel无活跃流；正常create/create_agent前置亦保留 |

已列显式错误：send_message.rs:520无效ID、:535空内容、:633活跃流；cancel_stream:881无活跃流；
create_agent:689成员检查（不存在workspace/无权限）；API配置缺字段为框架serde错误。
其余可达错误/提前返回及owner如下，**未以这些5场景宣称全命令覆盖**：
- L04 send:ensure_session_writable数据库异常、subagent只读(:41)、admit_or_block(:541)及注册时kill-switch(:631)；
  需要L04语料包提供kill-switch/subagent前置，受本包5命令范围限制未加入。
- L04 create_agent：coordinator/worker默认选择已覆盖coordinator；worker初始任务后台派发、:709取连接、
  :718 requester查询、:757会话写入、:761注册（配额）、:774投递、:832后台run Err需L04/L05的故障/额度场景；
  本包不加入10+agent循环来凑覆盖。
- L05 coordinator create_workspace:178开库、:180写workspace、:183索引同步失败；L02保存配置的敏感存储/DB错误；
  需X3隔离故障seed或owner故障入口，empty seed不能合法制造，未运行。
- L03两个注入点错误语义：工具check Err无日志继续、idle check Err warn继续；块写/append/getConn失败warn，
  已在真实execute生产测试对owner故障注入验证。v0无故障注入协议，不能冒充A/B已覆盖。

工具检查点的同throttle两批/50ms冷却、task_completed前注入、新执行重置由
`tests/workspace-injection-entry.test.ts` 通过真实execute/真实L05证明；其无关tool executor使用明确owner端口夹具，
完整桌面chatToolRuntime仍归L04/L05/L06组合，未声称已有真实桌面工具派发。
历史workspace恢复队列缺陷归L05（X3-L05-02）；本语料只新建workspace。

---

# WP-227 chat-session 前端可达命令语料（WAVE0 v0，作者 L03，归属 L04）

清单：`.oc-runs/board/corpus/WP-227-L03-chat-pipeline.md`（35 条）。`domain` 统一为 `chat-session`；
`commands` 只列清单命令，`create_session`/`send_message`/`workspace_create` 等辅助命令只出现在 steps。
本包未运行 A/B、未计 C；`normalize=[]`，`expect:"error"` 只是标注，没有伪造 expected。TESTMAP/SPEC/业务代码未改。

| 文件 | 场景 | 命令 | 说明 |
|---|---|---|---|
| `wp227-session-settings.json` | 18 | 10 | 分组、权限模式/档位、RAG 范围、会话标题搜索、kill switch 恢复、附件物化、迁移回滚（empty） |
| `wp227-workspace.json` | 12 | 17 | workspace_* 与 agent 档案文件 |
| `wp227-chat-llm.json` | 9 | 8 | 需要离线 LLM 的重试/变体/压缩撤销/唤醒，以及内容搜索与 FTS 重建 |
| `wp227-harness.sidecar.json` | 10 条绑定 / 26 个等待 | — | v0 表达不了的 LLM 路由与异步等待，按场景 id + step 索引 |
| `wp227-rollback.seeded.json` | 2 | 1 | 种子 `wp227-legacy-chat-w0`（W21 `slot-seeds.ts`） |
| `wp227-legacy-chat-w0.sql` | — | — | 3 行 `mistakes`、6 行旧 `chat_messages`；已在全部 mistakes 迁移 + `foreign_keys=ON` 的内存库上执行通过 |

合计 41 场景、35 命令；清单命令步骤中成功调用 145 个、标注错误 161 个。场景 id 前缀均为 `chat-session.wp227.`，下表省略。

## 逐命令覆盖

“成功”= 带真实前置并返回业务结果的调用；命令不存在、全参数缺失不计成功。前端路径相对仓库根；Rust 路径相对 `src-tauri/crates/dstu-agent/src/chat_v2/`（未写目录的在 `handlers/` 下，kill_switch.rs 在根下），行号取自清单。

| 命令 | 前端 | Rust | 成功场景 | 错误场景（覆盖的分支） |
|---|---|---|---|---|
| chat_v2_reorder_groups | src/components/ModernSidebar.tsx:831 | group_handlers.rs:427 | reorder_groups.basic | reorder_groups.bad_args（缺参/null/类型错） |
| chat_v2_restore_group | src/features/settings/components/data-governance/ChatSessionArchiveTab.tsx:171 | group_handlers.rs:341 | restore_group.archived_with_sessions | restore_group.not_found_and_deleted（不存在、空 id、缺参） |
| chat_v2_resume_agents | src/features/workbench/components/AgentControlCenter.tsx:394 | kill_switch.rs:255 | kill_switch.resume_cycle、kill_switch.default_reason_trip | 无：函数体只有 `Ok`（reset+snapshot），没有 Err 分支 |
| chat_v2_resume_automations | AgentControlCenter.tsx:410 | kill_switch.rs:272 | kill_switch.resume_cycle、kill_switch.default_reason_trip | 同两场景（kill switch 仍触发时拒绝） |
| chat_v2_retry_message | src/features/chat/adapters/tauri/messageOperations.ts:153 | send_message.rs:918 | retry_message.success_and_model_switch（500 后换模型、thinking） | retry_message.errors（MessageNotFound、用户消息、跨会话无前置用户消息、kill switch、活跃流、subagent 只读、缺参） |
| chat_v2_retry_variant | src/features/chat/adapters/tauri/variantOperations.ts:116 | variant_handlers.rs:401 | variants.switch_and_retry（error 变体）、variants.streaming_and_readonly_guards（cancelled 变体） | 同两场景（success 变体不可重试、VariantNotFound、非助手消息、跨会话、活跃流、subagent 只读） |
| chat_v2_retry_variants | variantOperations.ts:165 | variant_handlers.rs:446 | variants.switch_and_retry（含重复 id 去重、允许 success） | 同两场景（空列表、VariantNotFound、MessageNotFound、非助手、跨会话、活跃流、subagent、缺参） |
| chat_v2_rollback_migration | src/api/dataGovernance.ts:1216 | handlers/migration.rs:52 | rollback_migration.migrate_noop_then_rollback；seeded.migrate_rollback_remigrate、seeded.rollback_keeps_user_sessions（待种子） | rollback_migration.empty_no_legacy_column、seeded 首步（`migrated_to_v2` 列尚未懒建） |
| chat_v2_search_content | src/features/chat/hooks/useContentSearch.ts:55 | search_handlers.rs:30 | search_content.filters_and_rebuild（会话/日期/归档/limit 0·500/引号与运算符/空查询早退）、bad_args_and_empty_rebuild | 同两场景（非法 sessionId 前缀、反序列化错误） |
| chat_v2_search_sessions | src/features/chat/api/sessionBrowserApi.ts:53 | search_handlers.rs:71 | search_sessions.title_like_and_archive | search_sessions.bad_args |
| chat_v2_set_authority_mode | src/features/chat/core/store/sessionActions.ts:400 | manage_session.rs:2127 | set_authority_mode.transitions | set_authority_mode.errors（非法模式、空、会话不存在、缺参） |
| chat_v2_set_permission_preset | sessionActions.ts:424 | manage_session.rs:2153 | set_permission_preset.transitions | set_permission_preset.errors（危险档未确认、非法档位、会话不存在、类型错） |
| chat_v2_set_rag_scope | src/features/chat/kbScope/kbScope.ts:37 | manage_session.rs:2988 | set_rag_scope.set_trim_clear | set_rag_scope.errors（会话未落库、缺参） |
| chat_v2_stage_context_attachments | src/features/chat/adapters/attachmentMaterialization.ts:161 | tools/attachment_stage_executor.rs:1848 | stage_context_attachments.text_and_failure（含单项失败） | stage_context_attachments.errors（空/空白 sessionId、缺字段、缺参） |
| chat_v2_switch_variant | variantOperations.ts:25 | variant_handlers.rs:153 | variants.switch_and_retry、variants.streaming_and_readonly_guards | 同两场景（error 变体不可激活、VariantNotFound、MessageNotFound、用户消息、跨会话、subagent、缺参） |
| chat_v2_undo_compaction | src/features/chat/plugins/blocks/compactionSummary.tsx:130 | block_actions.rs:118 | undo_compaction.compact_then_undo（手动压缩后撤销） | 同场景 + no_compaction + streaming_and_readonly_guards（无活动压缩、非活动 id、重复撤销、活跃流、subagent、缺参） |
| chat_v2_wake_session | src/features/chat/adapters/tauri/sendOperations.ts:270 | send_message.rs:717 | wake_session.success_and_errors（显式模型、默认 model2） | 同场景 + streaming_and_readonly_guards（空白内容、非法前缀、空 id、kill switch、活跃流、subagent、缺参） |
| rebuild_chat_fts | src/utils/chatApi.ts:374 | search_handlers.rs:89 | search_content.filters_and_rebuild、bad_args_and_empty_rebuild（空库） | 无：只有取连接/SQL 失败，empty 种子不可达 |
| workspace_cancel_agent | src/features/chat/workspace/api.ts:498 | workspace_handlers.rs:2139 | 空闲返回 false（run_agent_idle_and_noop_controls）；运行中返回 true（cancel_running_worker）；close 后（close_cancels_running_worker） | membership_and_roles、invalid_and_missing_ids |
| workspace_cancel_sleep | api.ts:648 | workspace_handlers.rs:2308 | run_agent_idle_and_noop_controls（未知 sleep → false） | membership_and_roles、invalid_and_missing_ids |
| workspace_close | api.ts:167 | workspace_handlers.rs:642 | creator_lifecycle（含重复 close）、close_cancels_running_worker | membership_and_roles（非创建者、coordinator 成员）、invalid_and_missing_ids |
| workspace_delete | api.ts:177 | workspace_handlers.rs:661 | creator_lifecycle、delete_active_with_agents | creator_lifecycle（二次删除）、membership_and_roles、invalid_and_missing_ids |
| workspace_delete_agent_profile_file | src/features/settings/components/SubagentProfilesSection.tsx:556 | workspace_handlers.rs:2789 | agent_profiles.crud、model_checks | crud（PROFILE_FILE_NOT_FOUND）、file_name_errors |
| workspace_get | api.ts:157 | workspace_handlers.rs:622 | creator_lifecycle、membership_and_roles 等 5 个 | creator_lifecycle（删除后）、membership_and_roles、invalid_and_missing_ids（`../`、空格、空 id、不存在） |
| workspace_get_context | api.ts:257 | workspace_handlers.rs:972 | creator_lifecycle（对象/字符串/null/缺失键）、membership_and_roles | membership_and_roles、invalid_and_missing_ids |
| workspace_get_document | api.ts:285 | workspace_handlers.rs:1008 | creator_lifecycle、membership_and_roles（只到 Ok(null)） | membership_and_roles、invalid_and_missing_ids |
| workspace_list_agent_profiles | SubagentProfilesSection.tsx:425 | workspace_handlers.rs:2638 | agent_profiles.* 4 个 | 无：建目录失败只 warn，函数总返回 Ok |
| workspace_list_all | api.ts:296 | workspace_handlers.rs:1021 | creator_lifecycle、delete_active_with_agents、membership_and_roles、invalid_and_missing_ids | invalid_and_missing_ids（缺 sessionId）；取连接/SQL 失败不可达 |
| workspace_list_documents | api.ts:271 | workspace_handlers.rs:985 | creator_lifecycle、membership_and_roles（空列表） | membership_and_roles、invalid_and_missing_ids |
| workspace_manual_wake | api.ts:625 | workspace_handlers.rs:2274 | run_agent_idle_and_noop_controls（未知 sleep → success:false） | membership_and_roles、invalid_and_missing_ids |
| workspace_read_agent_profile_file | SubagentProfilesSection.tsx:487 | workspace_handlers.rs:2709 | agent_profiles.crud、model_checks | crud、file_name_errors（空、非 .md、空 stem、大写、`../`、下划线、>64 字符、Windows 保留名 con） |
| workspace_restore_executions | api.ts:589 | workspace_handlers.rs:2413 | creator_lifecycle、run_agent_idle_and_noop_controls、run_agent_reminder_answer、cancel_running_worker | membership_and_roles、invalid_and_missing_ids |
| workspace_run_agent | api.ts:469 | workspace_handlers.rs:1075 | idle 空 inbox（run_agent_idle_and_noop_controls）、reminder 真实运行（run_agent_reminder_answer）、运行中重复触发（cancel_running_worker） | run_agent_idle_and_noop_controls（coordinator 不可运行、Agent not found）、membership_and_roles、invalid_and_missing_ids |
| workspace_save_agent_profile_file | SubagentProfilesSection.tsx:515 | workspace_handlers.rs:2742 | agent_profiles.crud（新建/覆盖/CRLF/同名第二文件）、model_checks（绑定可用模型） | crud（PROFILE_FILE_EXISTS）、file_name_errors、content_errors（空、无/未闭合 frontmatter、无/空白/非法 name、内建名、非内建 base、permissions/contextInheritance、reasoning_effort）、model_checks（NOT_FOUND/DISABLED/UNSUPPORTED） |
| workspace_set_context | api.ts:241 | workspace_handlers.rs:960 | creator_lifecycle（创建者）、membership_and_roles（coordinator） | membership_and_roles（局外人、worker 成员）、invalid_and_missing_ids |

## 参数化 LLM 与 sidecar

- ApiConfig.baseUrl 写成字面量 `http://127.0.0.1:18461/s/<scriptId>/v1`，scriptId 只用 X5 内建脚本：
  `success.answer`、`success.thinking`、`error.http-500`、`interrupt.hold-after-partial`。runner 只把 origin 换成 X5 实际地址。
  没写 `${llm.baseUrl}`，因为 strict v0（`scenario-v0.mjs` resolveReferences）禁止部分插值。
- 一个场景可用多个 config id 绑定多个脚本（例：多变体用 answer + http-500 制造 success/error 两个变体）。
- `wp227-harness.sidecar.json` 沿用 chatanki sidecar 的 `llm` / `steps[].waitAfter{event,channelPrefix,messageId}` 形状，新增三个键：
  - `variantId` / `variantIds`：变体重试只发 `variant_end`（`chat_v2_event_*` 通道），不发 `stream_complete`；
  - `sessionId`：workspace worker 的 assistant message id 由后端生成，只能按会话等；
  - `event: "stream_start"`：hold 脚本下一步要验证“活跃流”拒绝，需先确认流已注册。
  sidecar 里 `${n.path}` 与 v0 同规则整值解析，只引用该步及之前的成功步骤。
- 变体 id 取 `chat_v2_load_session` 的 `${k.messages.0.variants.i.id}`（tailLimit:1）；压缩 id 取 `${k.blocks.0.toolOutput.compactionId}`
  （tailLimit:1，摘要消息时间戳最新）。路径不成立时 runner 会报 `missing reference field`，不会静默。
- 多变体依赖 `CHAT_V2_MULTI_VARIANT_ENABLED` 未被设为 false（默认启用）。变体顺序假设与 `parallelModelIds` 一致，A 端若不同以 A 为准。

## 种子与 owner

| 需求 | 场景 | owner |
|---|---|---|
| `wp227-legacy-chat-w0`：旧 mistakes.db `chat_messages` 行（无前端命令能写入）。SQL 已写好，需按 X3 机制应用到“启动过一次、已停止”的数据目录 | pending-seed/wp227-rollback.seeded.json（2） | X3 |
| X5 内建脚本路由 `/s/<scriptId>/v1` 与 sidecar 新增键（variantId/variantIds/sessionId/stream_start） | sidecar 中 10 个场景 | X5 / runner |
| `stage_context_attachments` 前置用 `vfs_upload_attachment`（VFS 域命令） | stage_context_attachments.text_and_failure | VFS owner（只作辅助步骤） |

## 未覆盖 / 部分覆盖

| 命令 / 分支 | 原因 |
|---|---|
| workspace_manual_wake 成功唤醒、workspace_cancel_sleep 返回 true、restore_executions 的 `has_active_sleeps=true` | 睡眠只能由 coordinator 的 LLM 工具调用 `coordinator_sleep` 创建，v0 无法注入工具轮；需要 X5 工具轮脚本（同 chatanki w0.directive 机制）或 sleep 种子（owner X3/X5） |
| workspace_get_document 返回正文、workspace_list_documents 非空 | 没有前端命令创建工作区文档，只有 worker 工具写入；同上依赖工具轮或种子 |
| workspace_restore_executions 恢复中断任务（`subagent_tasks_restored>0`） | 需要“进程重启前任务处于 running”的数据目录，v0 单进程内无法制造；需 X3 种子 |
| resume_agents / list_agent_profiles 的错误分支 | 源码无 Err 分支 |
| rebuild_chat_fts、workspace_list_all 的取连接/SQL 失败；workspace_delete 的 DataGovernance 锁冲突；save_agent_profile_file 的 catalog 不可读警告与落盘失败 | 需故障注入或并发数据治理操作，v0 无对应协议 |
| save_agent_profile_file 内容 >64KiB | 需要 64KiB 以上字面量，未写入语料，避免文件膨胀；分支在源码 custom_agent_executor.rs:205 |
| retry_message / wake_session 的 ensure_session_writable 数据库异常 | 需故障注入 |

# ChatAnki WAVE0 等价语料：模板 / 库卡 CRUD+CAS 工具组（WP-056）

本目录只放语料，不含实现。场景格式为 WAVE0 v0（`board/WAVE0-EQUIVALENCE.md` §3），以真实 A（Rust/Tauri）结果为 oracle。`expect` 只写在本 README 的分支注释里，场景 JSON 不带期望值。

- `templates.json`：`builtin-template_*` 九个工具，86 个场景。
- `library-cards.json`：库卡与会话卡 CRUD/CAS 五个工具，42 个场景。
- `harness.sidecar.json`：v0 表达不了的 runner 绑定（mock LLM 脚本、发送后的等待条件），按场景 id 索引。

状态：**全部场景未运行 A/B replay，未计 C**。B 侧阻塞见下文“阻塞”。

## 外层命令（9 条，均为前端真实 invoke）

本组是工具场景：域内工具只能由 LLM tool_call 触发，没有自有 IPC。场景用下表的外层命令串联，不新增测试 IPC。

| 命令 | owner | 前端调用点 | Rust 入口 |
|---|---|---|---|
| `save_api_configurations` | L02 | `src/utils/configApi.ts:108` | `src-tauri/src/commands.rs:2150` |
| `save_model_assignments` | L02 | `src/features/chat/components/input-bar/ModelPicker.tsx:363`、`src/utils/configApi.ts:163` | `src-tauri/src/commands.rs:2183` |
| `chat_v2_create_session` | L04 | `src/features/chat/adapters/tauri/sessionCommands.ts:80` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:330` |
| `chat_v2_send_message` | L04 | `src/features/chat/adapters/tauri/sendOperations.ts:186` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:462` |
| `chat_v2_tool_approval_respond` | L04 | `src/features/chat/components/ToolApprovalCard.tsx:189` | `src-tauri/crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:40`（注册 `src-tauri/src/lib.rs:2488`） |
| `create_custom_template` | L16 | `src/data/ankiTemplates.ts:267` | `src-tauri/src/commands.rs:4304` |
| `get_all_custom_templates` | L16 | `src/data/ankiTemplates.ts:53` | `src-tauri/src/commands.rs:4280` |
| `list_anki_library_cards` | L16 | `src/features/notes/components/NoteRelationTargetPicker.tsx:33` | `src-tauri/src/cmd/enhanced_anki.rs:478` |
| `save_anki_cards` | L16（contracts 同列 L15/L24） | `src/services/ankiApiAdapter.ts:127` | `src-tauri/src/cmd/anki_connect.rs:926` |

外层命令只用于建前置状态和读回状态。它们自身的错误分支归各自 owner 的语料包，本包不覆盖。

## 本域工具目标

| 工具 | Rust 实现 | 敏感度 | 审批 |
|---|---|---|---|
| `builtin-template_list` | `template_executor.rs:734` | Low | 自动放行 |
| `builtin-template_get` | `template_executor.rs:829` | Low | 自动放行 |
| `builtin-template_validate` | `template_executor.rs:907` | Low | 自动放行 |
| `builtin-template_create` | `template_executor.rs:949` | Medium | Craft+Relaxed 默认放行 |
| `builtin-template_update` | `template_executor.rs:1029` | Medium | 同上 |
| `builtin-template_fork` | `template_executor.rs:1230` | Medium | 同上 |
| `builtin-template_preview` | `template_executor.rs:1334` | Low | 自动放行 |
| `builtin-template_delete` | `template_executor.rs:1446` | High（`:1673`） | 恒走审批 |
| `builtin-template_set_default` | `template_executor.rs:1557` | Medium | 默认放行 |
| `builtin-chatanki_list_library_cards` | `chatanki_executor.rs:3562` | Low | 自动放行 |
| `builtin-chatanki_update_library_card` | `chatanki_executor.rs:3656` | High（`:1953`） | 恒走审批 |
| `builtin-chatanki_delete_library_card` | `chatanki_executor.rs:4059` | High（`:1950`） | 恒走审批 |
| `builtin-chatanki_update_card` | `chatanki_executor.rs:2448` | Low | 自动放行 |
| `builtin-chatanki_delete_card` | `chatanki_executor.rs:2593` | Low | 自动放行 |

模板工具的参数辅助函数在 `template_executor.rs:186–630`，分发在 `:1651`。卡工具的参数归一化在 `chatanki_executor.rs:1278–1444`，会话归属检查在 `load_owned_chatanki_card`（`:12117`），库卡 preflight 在 `:13341–13392`。

## 场景结构

每个场景都以三步前缀开头：

0. `save_api_configurations`：配置 `w0-chatanki-config`，`baseUrl: "${llm.baseUrl}"`，`apiKey: ""`，`authMode: "none"`。
1. `save_model_assignments`：`model2_config_id` 指向该配置。
2. `chat_v2_create_session`：后续用 `${2.id}` 引用会话。

之后视需要用外层命令建前置状态（`create_custom_template` / `save_anki_cards`），再用 `chat_v2_send_message` 触发工具，高敏工具接 `chat_v2_tool_approval_respond`，最后用 `get_all_custom_templates` / `list_anki_library_cards` 读回 DB 状态。所有场景 `seed: "empty"`，`capture: { events: true, db: ["*"] }`，`normalize: []`。

`chat_v2_send_message` 的请求字段照抄前端 `sendOptions.ts:321,341,455` 的形状：`mcpToolSchemas` 是从前端 TS 原样切出的工具 schema，`activeSkillIds` 为 `["template-designer"]` 或 `["chatanki"]`。

### 确定性 LLM：`w0.directive`

用户消息内容是 `W0_DIRECTIVE {"v":1,"rounds":[[{"id","name","arguments"}],...],"final":"W0_DONE"}`。mock 规则：设 k 为最后一条 user 消息之后 assistant tool_calls 消息的条数，k < rounds.length 时回 `rounds[k]` 的 tool_calls，否则回 `content=final, finish=stop`。tool_call id 固定为 `call_w0_NNN`，便于审批步骤引用。

X5 的 `llm-service.ts` 目前没有该模式（它的工具脚本只调用第一个可用工具并用固定参数），需要 X5 补一个 `w0.directive` 脚本。

### 动态值与跨步引用

- 自建模板 id：`create_custom_template` 返回字符串，用 `${n}` 引用。
- 卡片内容版本：取 `list_anki_library_cards` 的 `${n.items.0.version}`（版本即 `updated_at` RFC3339）。
- 卡片与文档 id 固定为 `w0-card-1` / `w0-doc-1`（`save_anki_cards` 保留非临时卡 id）。
- 内置模板用 `design-lab`，版本 `3.0.4`（`src-tauri/src/data/builtin-templates.json`）。空库时内置模板在首次 list 时自动导入（`template_executor.rs:765`），所以涉及内置模板的场景先调一次 `template_list`。
- 引用嵌在 directive 字符串内部（如 `"templateId":"${4}"`），runner 需要做子串替换。X5 的 `runner.ts:63` 支持子串替换，X1 的 `scenario-v0.ts:32` 只认整值替换。

### sidecar（`harness.sidecar.json`）

- `llm: "w0.directive"`：该场景使用的 mock 脚本。
- `steps[].waitAfter`：`chat_v2_send_message` 是 fire-and-forget（`spawn_tracked`，返回 assistant message id），下一步之前必须等到：
  - 默认：`chat_v2_session_*` 通道上该 assistant message 的 `stream_complete|stream_error|stream_cancelled`；
  - 下一步是审批时：带指定 `toolCallId` 的 `tool_approval_request`；审批响应后再等终态事件。

## 偏离与假设

- `mcpToolSchemas` 只放 `load_skills` 和目标 skill 的工具，省略前端会附带的 `ask-user` / `learning-resource` 依赖工具。Rust 管线不做参数 schema 校验，前端路径上 `execution_allowed_tools` 为 None，因此省略不改变工具执行。
- 卡片场景只放 chatanki 工具的子集（list/update/delete library card、get/update/delete card），其余 chatanki 工具不在本包范围。
- 审批按 Craft+Relaxed 默认预设：High 恒审批，Medium/Low 自动放行。若 A 的默认预设不同，以 A 实际事件为准。

## 阻塞

### B 侧（逐场景 blocked，不用假业务替身验收）

| 范围 | 原因 | owner |
|---|---|---|
| 全部 128 个场景 | X5 L03/L04 真实工具轮未签收；B 侧 `chat_v2_send_message` 尚不能驱动域内工具 | X5 / L04 |
| `templates.json` 全部 86 个 | `host/plugins/chatanki/src/template-executor.ts:215` 需要 `ctx.mainDb ?? ctx.ankiDb`，当前未注入，执行即返回“数据库不可用”。L16 模板 CRUD（WP-015）已在 main（1e6488f6a），`ctx.anki.templates.{list,get,create,update,delete}` 可公开消费，但本 executor 尚未改为消费它；生成 facade 仍 open | L16 / L24 |
| `library.update.*`（13）、`library.delete.*`（8）共 21 个 | B 侧没有 `chatanki_update_library_card` / `chatanki_delete_library_card` 执行器，只在 `src/tool-metadata.ts:13–15` 登记名字 | L24 后续包 |
| `library.list.*` 共 8 个 | 执行器在 `library-list-executor.ts:31,50` 需要 `libraryCards` 与 `libraryReviewStates`；`index.ts:326–335` 仅在 L16 `listAnkiAgentLibraryPage` / L15 `getReviewStatesForLibrary` 存在时注入，端到端未验证。除上面第一行的整体阻塞外，没有已知额外缺口 | L15 / L16 |

### runner / mock

| 需求 | owner |
|---|---|
| `w0.directive` mock 脚本 | X5 |
| `${llm.baseUrl}` 占位与子串替换 | X1 / X7 |
| `capture.db: ["*"]`（当前 runner 只接受 `[]`） | X1 / X7 |
| `waitAfter` 终态 / 审批请求等待（X1 B-driver 现为最后一步后固定 250 ms 窗口） | X5 / X7 |

### 空种子不可达（未覆盖，需 seed）

| 分支 | 需要 | owner |
|---|---|---|
| 库卡 preflight 块不匹配 / 归属错误（`chatanki_executor.rs:13341–13392`） | 带 anki_cards 块的消息种子 | L04 / X3 |
| 各工具 DB 读写失败分支 | 故障注入种子 | X3 |
| `optimistic_lock_failed` 并发竞态 | 并发驱动 | X7 |
| `Unsupported template designer tool`（`template_executor.rs:1661`） | 只有九个工具名能路由到该 executor，前端不可达 | 无（记为不可达） |

## 剩余命令

本包只覆盖上表 14 个工具。chatanki 其余工具（`chatanki_run/start/status/wait/get_cards/batch_update_cards/delete_cards/add_cards/enqueue_review/review_stats/undo_last_review/set_suspended/enqueue_library_review/set_library_suspended/undo_library_last_review/retemplate/transform/control/export/sync/import_apkg/list_templates/analyze/check_anki_connect`）留给后续包。`get_cards` 已放进卡片场景的 schema，但没有专门场景。

## 来源

场景由仓库外的生成脚本 `/tmp/opencode/wp056/gen.mjs` 产出。它从以下前端源码原样切出工具 schema：

- `src/features/chat/skills/builtin-tools/template-designer.ts:12`（`templateDesignerSkill.embeddedTools`）
- `src/features/chat/skills/builtin/index.ts:131`（`chatAnkiSkill.embeddedTools`，工具定义在 `:463,482,738,914,960,1087`）
- `src/features/chat/skills/progressiveDisclosure.ts:87`（`LOAD_SKILLS_TOOL_SCHEMA`）

前端 schema 变更后需重新生成。最小检查脚本 `/tmp/opencode/wp056/check.mjs` 校验：JSON 可解析、v0 顶层与场景键严格、id 唯一、`${n}` 只引用更早的步骤、每步命令在 `commands` 内、directive 可解析、sidecar 覆盖每个发送/审批步骤且审批 toolCallId 存在于 directive。

## 分支覆盖表

按场景最后一个目标工具分组。“Err”表示工具返回 Err 或提前返回（含 statusNotFound）；“负向”是冲突、校验不通过、审批拒绝等负向前置状态；其余为成功路径。行号均指 `template_executor.rs` 或 `chatanki_executor.rs`。

| 工具 | 成功 | Err/提前返回 | 负向（冲突/校验失败/审批拒绝，Ok 或 Err 以 A 为准） | 场景数 |
|---|---|---|---|---|
| template_list | 6 | 3 | 0 | 9 |
| template_get | 3 | 3 | 0 | 6 |
| template_validate | 3 | 4 | 8 | 15 |
| template_create | 2 | 4 | 1 | 7 |
| template_update | 8 | 11 | 2 | 21 |
| template_fork | 3 | 2 | 0 | 5 |
| template_preview | 5 | 6 | 0 | 11 |
| template_delete | 2 | 2 | 1 | 5 |
| template_set_default | 3 | 4 | 0 | 7 |
| chatanki_list_library_cards | 5 | 3 | 0 | 8 |
| chatanki_update_library_card | 4 | 6 | 4 | 14 |
| chatanki_delete_library_card | 1 | 4 | 2 | 7 |
| chatanki_update_card | 1 | 5 | 1 | 7 |
| chatanki_delete_card | 1 | 3 | 2 | 6 |
| **合计** | **47** | **60** | **21** | **128** |

### template_list

| 场景 id | 类别 | 分支 |
|---|---|---|
| `template.list.default` | 成功 | success; empty DB auto-imports builtins (template_executor.rs:765) |
| `template.list.filters` | 成功 | activeOnly=false, builtinOnly=true, query, limit |
| `template.list.limit_zero` | 成功 | limit=0 boundary |
| `template.list.limit_over_cap` | 成功 | limit 1000 clamps to 200 |
| `template.list.query_no_match` | 成功 | query filters to zero |
| `template.list.inactive_hidden` | 成功 | custom inactive template hidden by default activeOnly |
| `template.list.bad_args.type` | Err | Err: serde type error (:742) |
| `template.list.bad_args.negative_limit` | Err | Err: usize rejects -1 (:742) |
| `template.list.bad_args.null_active_only` | Err | Err: bool field null (:742) |

### template_get

| 场景 id | 类别 | 分支 |
|---|---|---|
| `template.get.custom` | 成功 | success visual dual-channel (:885) |
| `template.get.builtin_after_list` | 成功 | success builtin design-lab |
| `template.get.snake_alias` | 成功 | alias template_id |
| `template.get.missing` | Err | Err: Ok(None) (:893) |
| `template.get.bad_args.missing_id` | Err | Err: serde missing field (:837) |
| `template.get.bad_args.number_id` | Err | Err: serde type (:837) |

### template_validate

| 场景 id | 类别 | 分支 |
|---|---|---|
| `template.validate.valid` | 成功 | success valid=true with FrontSide/none warnings |
| `template.validate.errors_and_warnings` | 负向 | valid=false: empty name/fields/front/back/prompt + warnings |
| `template.validate.cloze_missing_placeholder` | 负向 | Cloze without {{cloze: (:700) |
| `template.validate.rules_mismatch` | 负向 | missing rule + extra rule (:676-694) |
| `template.validate.json_string` | 成功 | template as JSON string normalizes (:609) |
| `template.validate.bad_json_string` | Err | Err: string not JSON (:610) |
| `template.validate.json_string_array` | Err | Err: JSON string not object (:619) |
| `template.validate.non_object` | Err | Err: number template (:625) |
| `template.validate.parse_error_name_type` | 负向 | parse_create_request Err -> success valid=false (:928) |
| `template.validate.parse_error_fields_item` | 负向 | fields[1] non-string (:392) |
| `template.validate.parse_error_fields_type` | 负向 | fields not array (:381) |
| `template.validate.parse_error_rules` | 负向 | fieldExtractionRules serde error (:454) |
| `template.validate.parse_error_bool` | 负向 | isActive not bool (:357) |
| `template.validate.alias_and_snake` | 成功 | templateDefinition alias + snake_case keys + null defaults |
| `template.validate.bad_args.missing` | Err | Err: missing template (:915) |

### template_create

| 场景 id | 类别 | 分支 |
|---|---|---|
| `template.create.success` | 成功 | success; DB row (:985) |
| `template.create.success_version_inactive` | 成功 | explicit version/isActive=false/isBuiltIn=true passthrough |
| `template.create.validation_failed` | Err | Err: validate errors (:975) |
| `template.create.parse_error` | Err | Err: parse_create_request (:970) |
| `template.create.normalize_error` | Err | Err: non-object template (:965) |
| `template.create.bad_args.missing` | Err | Err: missing template (:957) |
| `template.create.duplicate_name` | 负向 | second create with same name (DB constraint decides; A is oracle) |

### template_update

| 场景 id | 类别 | 分支 |
|---|---|---|
| `template.update.success` | 成功 | success; version bump (:1152) |
| `template.update.stale_reuse` | 负向 | second update with pre-bump version -> Err 版本冲突 (:1131) |
| `template.update.stale_literal` | 负向 | Err: version conflict |
| `template.update.numeric_version` | 成功 | expectedVersion number -> to_string (:317) |
| `template.update.bool_version` | Err | Err: version token type (:318) |
| `template.update.missing_expected_version` | Err | Err (:1094) |
| `template.update.top_level_expected_version` | 成功 | top-level expectedVersion fallback (:1084) |
| `template.update.no_changes` | Err | Err: no update fields (:1101) |
| `template.update.only_is_built_in` | Err | isBuiltIn stripped -> no changes Err (:1088,:1101) |
| `template.update.flattened_patch` | 成功 | patch inferred from extra keys (:1052) |
| `template.update.template_alias_patch` | 成功 | patch via template key (:1048) |
| `template.update.patch_json_string` | 成功 | patch JSON string (:579) |
| `template.update.patch_bad_json_string` | Err | Err (:580) |
| `template.update.patch_json_string_non_object` | Err | Err (:589) |
| `template.update.patch_array` | Err | Err (:595) |
| `template.update.patch_field_type` | Err | Err parse_update_request (:1077) |
| `template.update.patch_rules_error` | Err | Err extract_opt_rules (:474) |
| `template.update.missing_template` | Err | Err Ok(None) (:1116) |
| `template.update.bad_args.missing_id` | Err | Err serde (:1037) |
| `template.update.builtin_marks_user_modified` | 成功 | builtin design-lab 3.0.4 update -> mark_template_user_modified (:1156) |
| `template.update.explicit_version` | 成功 | patch.version overrides increment |

### template_fork

| 场景 id | 类别 | 分支 |
|---|---|---|
| `template.fork.builtin_default_name` | 成功 | success; name "(副本)", isBuiltIn=false (:1291) |
| `template.fork.custom_named_inactive` | 成功 | name/description/setActive=false |
| `template.fork.template_id_alias` | 成功 | alias templateId |
| `template.fork.missing_source` | Err | Err Ok(None) (:1252) |
| `template.fork.bad_args` | Err | Err serde (:1238) |

### template_preview

| 场景 id | 类别 | 分支 |
|---|---|---|
| `template.preview.by_id_sample` | 成功 | success by templateId + sampleData |
| `template.preview.by_id_missing` | Err | Err Ok(None) (:1364) |
| `template.preview.draft` | 成功 | success draft object, no DB (:1374) |
| `template.preview.draft_snake_preview_data` | 成功 | snake_case draft + preview_data_json |
| `template.preview.draft_empty` | 成功 | empty draft object -> empty strings |
| `template.preview.draft_bad_json` | Err | Err normalize (:1377) |
| `template.preview.draft_fields_error` | Err | Err extract_fields (:1399) |
| `template.preview.draft_preview_data_type` | Err | Err extract_opt_str (:1404) |
| `template.preview.id_precedence` | 成功 | templateId wins over draft (:1350) |
| `template.preview.neither` | Err | Err neither (:1408) |
| `template.preview.bad_args` | Err | Err serde templateId type (:1342) |

### template_delete

| 场景 id | 类别 | 分支 |
|---|---|---|
| `template.delete.custom_approved` | 成功 | success physical delete (:1528) |
| `template.delete.custom_rejected` | 负向 | approval rejected -> executor not run, row kept |
| `template.delete.builtin_soft` | 成功 | builtin soft-delete deactivated (:1499) |
| `template.delete.missing` | Err | Err Ok(None) after approval (:1468) |
| `template.delete.bad_args` | Err | Err serde after approval (:1454) |

### template_set_default

| 场景 id | 类别 | 分支 |
|---|---|---|
| `template.set_default.custom` | 成功 | success (:1600) |
| `template.set_default.builtin_after_list` | 成功 | success builtin |
| `template.set_default.inactive` | Err | Err inactive (:1592) |
| `template.set_default.after_builtin_soft_delete` | Err | soft-deleted builtin inactive -> Err (:1592) |
| `template.set_default.missing` | Err | Err Ok(None) (:1579) |
| `template.set_default.snake_alias` | 成功 | alias template_id |
| `template.set_default.bad_args` | Err | Err serde (:1565) |

### chatanki_list_library_cards

| 场景 id | 类别 | 分支 |
|---|---|---|
| `library.list.empty` | 成功 | success total=0 |
| `library.list.seeded_filters` | 成功 | search/schedule/filter/page/pageSize clamp 20 |
| `library.list.query_alias_trim` | 成功 | query alias, whitespace trimmed to None, templateId blank |
| `library.list.page_zero` | 成功 | page 0 -> 1, pageSize 0 -> 1 |
| `library.list.schedules` | 成功 | due/suspended/enqueued + error_only |
| `library.list.bad_args.unknown_field` | Err | Err deny_unknown_fields (:3571) |
| `library.list.bad_args.enum` | Err | Err unknown variant (:3571) |
| `library.list.bad_args.negative_page` | Err | Err u32 (:3571) |

### chatanki_update_library_card

| 场景 id | 类别 | 分支 |
|---|---|---|
| `library.update.success_session_owned` | 成功 | CAS success; source session w/o block -> uiSync not found path (:3749) |
| `library.update.success_no_session` | 成功 | locator without source session -> not_required (:13385) |
| `library.update.cross_session` | 成功 | card owned by session A updated from session B (library scope is global) |
| `library.update.stale_reuse` | 负向 | second CAS with old version -> success payload status=conflict (:3785) |
| `library.update.stale_literal` | 负向 | expectedVersion literal mismatch -> conflict |
| `library.update.missing_card` | Err | Err statusNotFound (:3691) |
| `library.update.blank_args` | Err | Err normalize required (:1319) |
| `library.update.empty_patch` | Err | Err empty patch (:1318) |
| `library.update.patch_unknown_field` | Err | Err patch deny_unknown_fields |
| `library.update.unknown_top_field` | Err | Err deny_unknown_fields top |
| `library.update.content_required` | Err | Err cardContentRequired (:3717) |
| `library.update.text_null_tags` | 成功 | text:null nullable patch + extraFields |
| `library.update.rejected` | 负向 | approval rejected, card unchanged |
| `library.delete.then_update` | 负向 | deleted card no longer updatable |

### chatanki_delete_library_card

| 场景 id | 类别 | 分支 |
|---|---|---|
| `library.delete.success` | 成功 | Deleted (:4135) |
| `library.delete.missing_review_version` | Err | Err expectedReviewVersion required (:1427) |
| `library.delete.negative_review_version` | Err | Err negative (:1433) |
| `library.delete.stale_content` | 负向 | ContentConflict (:4162) |
| `library.delete.review_conflict` | 负向 | expectedReviewVersion 0 on non-enqueued card (A decides ReviewConflict) |
| `library.delete.missing_card` | Err | Err statusNotFound (:4094) |
| `library.delete.blank_args` | Err | Err cardId/expectedVersion required (:1424) |

### chatanki_update_card

| 场景 id | 类别 | 分支 |
|---|---|---|
| `card.update.owned_success` | 成功 | owned session CAS success |
| `card.update.foreign_session` | Err | other session -> statusNotFound (load_owned_chatanki_card :12117) |
| `card.update.no_owner` | Err | card saved without session -> statusNotFound |
| `card.update.stale` | 负向 | stale reuse -> Conflict payload |
| `card.update.args_required` | Err | Err updateArgsRequired |
| `card.update.bad_args` | Err | Err serde missing patch |
| `card.update.content_required` | Err | Err cardContentRequired |

### chatanki_delete_card

| 场景 id | 类别 | 分支 |
|---|---|---|
| `card.delete.owned_success` | 成功 | owned delete |
| `card.delete.foreign_session` | Err | other session -> statusNotFound |
| `card.delete.missing_review_version` | Err | Err expectedReviewVersion required |
| `card.delete.stale` | 负向 | Conflict |
| `card.delete.review_conflict` | 负向 | expectedReviewVersion 0 on non-enqueued card |
| `card.delete.unknown_field` | Err | Err deny_unknown_fields |

# 跨 lane 阻塞证据

## WP-168（2026-11-06）：授权/Plan 供方与精确时间

- 已核 main 的 F3 `DatabaseHandle.transaction(...,{behavior:'immediate'})`、F4 `JsonReader`/`parseJsonDocument`/`jsonNumberToRawJSON` 与 `ParsedDateTime` 均真实存在，无需再派 registry/context/assemble。新授权三方法本分支已实现，等待正常集成后由 L03/WP026 消费。
- 等价时间签名为 `consumeSessionPlanBinding(sessionId:string,bindingKey:string,now:ParsedDateTime):boolean`；F4 `time/index.ts` 的 `parseRfc3339(now().rfc3339)!` 可构造当前时刻。Date 会丢失纳秒、单一 epochNanos 会丢失闰秒身份，均不冒充原 chrono 比较。已向 L03 投递。
- 本包不把历史 RPC 原1改判通过。起点新定向 `20261105190012-d69a18` 43 passed / Errors 1 / raw1（`[vitest-worker]: Timeout calling "onTaskUpdate"`）；历史 097 候选保留，RPC 根因及豁免归 C2 定性。
- 以下旧记录是历史快照（如旧 execute/JsonReader 未发布），不作为本包当前阻塞；WP-168 的依赖已用 `git show main:<路径>` 核实。

## WP-018（2026-11-05）：shell policy 已发布与后继差异

- 已核 main `967f43c75`：L04 `api.ts:47,204-206` 有 ToolExecutorRegistry/createExecutorRegistry/assembleExecutorRegistry；L05 `api.ts:24-26` 已公开 enforceShellCommandPolicy/applyShellCommandSensitivity/ShellPolicyDecision。指定 8 条测试可直接复用公开策略入口，完整 roster 不是本包阻塞。
- 单一实现及生产调用点：L05 `src/tools/shell-policy.ts`；`index.ts:119-125` → executors.ts:74-75 → shell-execute.ts:102,200 / shell-preflight.ts:570,419。L04 不复制、不跨目录修该实现。
- 审读发现、交 L05 后继修复（不属于本包 8 条原输入）：`shell-policy.ts:73,93,95-101` 将 rules:null 当 []、未知/缺失 effect 当 ask、enabled:null 当 true、非字符串 note 当 null；Rust `shell_command_policy.rs:44-69,92-96` 的 typed serde 应拒绝这些输入并使 enforce 返回 config_valid=false。例 `{"version":1,"default_effect":"allow","rules":null}` + `echo ready` 当前可 Allow，Rust 应 Ask。重复已知字段和原文错误 Display 也尚未按 typed serde 实现。
- `shell-policy.ts:146-154` 的 JS `\s` 与 Rust `char::is_whitespace`（:145-150）不等价：prefix `git stat` 后接 U+0085 应命中、U+FEFF 不应命中；当前正好相反。请求所有者复用 F4 Rust 空白语义并补回归。上述差异不由调整本包原输入掩盖，也不宣称完整策略全输入签收。

## C04-01：原文 JSON AST 依赖申请（精确方案，未安装）

- 请求依赖 owner/架构师批准生产依赖 **jsonc-parser@3.3.1（MIT，Microsoft）**，精确锁定该版本。已只读核 npm registry 该版本元数据与发布的 main.d.ts；未执行安装或改 package/lock。F1 候选 96b23ae1d/c1efab411 只公开部分值级 serdeCheck/normalizeUnitEnums/rustDebugString，无原文 decoder，不能当全结构成功证明。
- 最小 API：`parseTree(text, errors, {disallowComments:true,allowTrailingComma:false,allowEmptyContent:false})` 取得保留 property 节点的 AST；`createScanner(text,false)` 仅用于原 token/EOF/语法定位（不重写 tokenizer）；类型 Node/ParseError。不用容错 `parse()` 返回对象，不用 stripComments，不用 edit/format API。
- 严格准入：root 必须存在；所有 ParseError 与 scanner ScanError 都检查；注释、尾逗号、空输入及剩余非 JSON 空白输入全部拒绝，必须消费至 EOF。AST 可以容错生成，但只作位置索引，任何语法错误都不得写库。语法错误与类型错误的先后按 Rust typed visitor 的消费顺序及各原文 offset 合并，不一律让后面的 syntax 错误覆盖前面的结构/类型错误。
- 原数字：只用 `text.slice(node.offset,node.offset+node.length)`，不信 node.value 的 JS number。u32/i64/u64 按原 token 区分整数/小数/指数并精确做范围/BigInt，保留 JSON Value 数字走已有 L20无损表示；不能先 Number 再 BigInt。
- 重复属性：按 object.children 的 property 原顺序走所有者 struct 字段，识别同一已知字段的第二次出现（即使首值为 null）；未知字段按 Rust 忽略。serde_json::Value 的 map 仍采用其最后值行为，不把所有对象重复键一刀切拒绝。
- 错误位置：AST/scanner offset 是 UTF-16 下标，以原文前缀确定行号、当前行前缀 UTF-8 字节数确定 serde 列号；所有者类型错误定位到 Rust 实际已消费 token/闭合符，缺字段定位到该 struct 结束，重复字段定位到第二次字段名。对照 serde_json 源码逐类映射 Display，不用 jsonc-parser 的 printParseErrorCode 文本、不通过重新 stringify 推位置。
- 完整 ConversationSnapshot/ChatSession/ChatMessage/MessageBlock/SessionState 的 default/Option/枚举/时间/Vec/schema 分支仍由 L04 迁移；此依赖只替代通用源 JSON 词法/AST工作。验证须覆盖缺session、错误嵌套字段、未知字段、缺省Vec与null Vec差异、重复known字段、注释/尾逗号/剩余输入、Unicode错误列与大整数。C04-01 当前只完成 plain Display wire，未签收完整解码。

## C2 / L13 加急集成清单（2026-11-04 11:21Z 请求）

- 首次完整发布提交：`03c9b17a79c7f34f8e23b51807dfd6c02344e364`（8 文件），现候选代码在 `bd4b221d0` 及后续本分支。对当前 main 的 ancestor 检查仍为 1；不能称 main 已可消费。
- Cordis `chatAttachmentErrors`：`requiredId(args: unknown,key: string): string`（缺参数抛 Error.message=本地化 JSON）、`notFound(detail: string): string`、`localize(error: string): string`。直接导出名为 requiredAttachmentId / attachmentNotFoundError / localizedAttachmentFailure，均来自本 lane api.ts。
- Cordis `chatRetrievalScope.loadSessionRagScope(sessionId: string): string[] | null` 已绑定当前 sessions.database；若调用方已有 ChatV2Database，api.ts 同时导出 `loadSessionRagScope(database,sessionId)`。无效 JSON/非 string 数组/连接失败返回 null；不让 L13 复制分类或 chat 表 SQL。
- 最小功能文件/hunk 清单：①新增 src/attachment-errors.ts；②新增 src/retrieval-scope.ts；③repository/session-state.ts 的 loadBackendRagScope；④api.ts 的两个接口、函数导出与 Cordis 声明；⑤index.ts 的两个 import、meta.provides、保存 sessions 实例和两次 provide；⑥tests/attachment-errors.test.ts；⑦tests/database-service.test.ts 的 backend retrieval scope 用例。依赖仅已有 F4 errors/api.ts、util/index.ts、F3 SqlExecutor，以及 main 已有 chatSession.database.getConnSafe，不需要新建表/服务实现。
- 原提交 TESTMAP 同时包含另外 9 个 message-persistence 去向，依赖更早提交，不能把 03c9b17a7 整体当作独立 cherry-pick；单元拆分只能取以上业务与测试 hunks及 stage_failure_maps_args_schema_and_not_found 该行，保留其他 TESTMAP 行/生成表头。当前 lane 禁止改分支历史/切分支，未重写或重造实现；协调者可按此清单集成，或合完整候选链。
- 生产入口实跑：`20261104111841-a0dcc4` 中 database-service 14 passed、attachment-errors 3 passed；整个 L04 61 文件、550 passed / 2 Rust 平台条件 skipped、无 Errors、exit 0。typecheck `20261104111841-e7a5ec` exit 0；普通 boundaries 当前 0 violations。正常宽路径门禁的实际剩余阻碍是下面 L03 injectionBudget 夹具缺失，与这两个 provider 功能无关。

## 集成测试目录前缀与 L03 新基线装配缺口

- **最新协调反馈覆盖旧结论**：C1 本轮已核集成失败推进到误选 L03 的 tiktoken 依赖 + RPC 超时，并已交架构师正常依赖集成；下列 injectionBudget 是历史复现，不要求再次修。下一次统一 lane-gate 以实际新日志为准，不把旧错误继续报告成当前阻碍。

- `npx vitest ... host/plugins/chat` 会同时选中 chat-pipeline/chatanki。`20261104110132-470778` 在 merge `ebd7674d0` 后：`Test Files 1 failed | 149 passed | 2 skipped (152)`，`Tests 2 failed | 1389 passed | 14 skipped (1405)`，无 Errors，退出码 1。
- 唯二失败位于 `chat-pipeline/tests/stream-hooks-guard.test.ts`，精确错误 `plugin "dstu.llm" did not start: required services not available: "injectionBudget"`。L02 index.ts:78 新增必需注入；F3 storage/index.ts:99 提供真实 injectionBudget；L03 tests/chat-host.ts 直接提供 storage 实例但未装配该服务。需 L03 修改自己的测试装配，L04 不在 chat 插件中冒充 F3 提供方。此前反馈的 stream-sink-wiring/completion-finalizer 已通过。

## X5-01 续作实核（2026-11-04）

- compact命令层现在经实际chat插件注册与kernel invoke测契约：writable/model/feature map读取/流准入/上游调用/响应映射/guard清理均已实现，结果映射走真实L03 helper，仅待发布执行函数作为外部替身；Node `20261104140117-8f46e5` 11 passed / exit0，Electron `20261104140808-ec5402` 5 passed / exit0，typecheck修复测试Promise辅助写法后 `20261104140808-d15f51` exit0。provider无runCompactionForSession时不注册，不报完整生产压缩完成。
- L05 escapeXmlContent出口已候选06c60555c（自检头2ec550ff1）提供，不再称“提供方尚未实现”；正常合入main后消费，不导入私有文件。owned/headless执行、GoalRuntime与四个WithConn的Electron复验 `20261104135505-2f7ceb` 22 passed / exit0 / 无Errors。

- L03新请求的四项已经复用原实现提供于chatSession：`getMessageWithConn(conn,messageId):ChatMessage|null`、`updateMessageWithConn(conn,message):void`、`getCompactionSummaryMessageIdsWithConn(conn,sessionId):string[]`、`markAvailableSkillsSnapshotStaleWithConn(conn,sessionId):number|bigint|null`；api.ts有对应纯函数出口。摘要ID查询对应pipeline/compaction.rs:1503-1514的DISTINCT block.message_id而非compaction表，不新增事务。Node `20261104134517-e506b3` 10 passed / exit0，无Errors；typecheck `20261104134516-a69fe8` exit0。
- C04-03 GoalRuntime循环/精确预算/CAS/取消归属/轮末settle已实现并经chatSession.createGoalRuntime公开；Node `20261104133139-886afb` 16 passed / exit0（含send执行契约），typecheck `20261104133139-4d258d` exit0。goal_resume/send最终命令接线仍pending：L05 escapeXmlContent公开请求已发，L03实际execute仍在组合；未把工厂或上游替身测试当完整命令完成。
- L03执行接口候选3998b3cd7→031640aa5已亲读：execute参数为window/request/signal/state|null；retry/edit的executeWithExistingUser是同execute+skipUserMessageSave=true的便捷入口，并非Rust另有函数。后续按候选executeVariantRetry与runCompactionForSession准确签名写调用方；正式类型到main再切import，不把候选当已消费。

- 补缺优先续作：当前候选107命令中仍有12个未闭合生产链：compact_session、continue_message、edit_and_resend、retry_message、retry_variant、retry_variants、send_message、stage_context_attachments、wake_session，以及workspace_create_agent/restore_executions/run_agent。前9项带chat_v2_前缀。compact已具备完整命令层并按真实执行方法有无条件注册，其余仍未注册；元数据声明不等于main已接通。旧main的20条统计不用于否认候选已完成的8条。
- 新公开低层接口 `ChatSendExecution` 经 `chatSession.createSendExecution(pipeline,state)` 构造：`runSendMessage(window,request,registration):Promise<string>` / `runHeadlessMessage(window,request,token):Promise<string>`。分别对应send_message.rs:324-342 / 301-322，真实owned/token guard与finally已实现；Node契约job `20261104130258-1b0c57` 9 passed / exit0 / 无Errors，typecheck `20261104130258-c88189` exit0。不是固定失败provider，未声明chat.send@1已生产注册。
- `chat.send@1` 已由 chat-pipeline 发布（W02 7458fca8，`chat-pipeline/src/super-inbox-send.ts`）：消费 `createSendExecution(...).runSendMessage(window, request, registration)`，registration 由 L06 `deliverInbox` 原子注册并整份传入，不二次注册、不借用 generation；收尾用 chat 自己发送绑定的 GoalRuntime（`chatSession.activeGoalRuntime()`，未绑定时再 `createGoalRuntime`）。L06 headless 高层编排仍归 L06。

- 当前 main `chat-pipeline/api.ts:214-496` 的 ChatPipelineService 无完整执行入口。L04 `api.ts` 已发布最小 `SendPipelinePort.execute(window: WindowRef, request: BackendSendRequest, cancellation: AbortSignal, state: ChatV2State): Promise<string>`，对应 send_message.rs:339-341；BackendSendRequest.options.streamGeneration 为后端 bigint，不从 IPC 输入采信。请 L03 在自身 api.ts 发布并绑定真实 execute（含终态/持久化），L04 随后消费正式类型；不以 singleShotCompletion 绕过 pipeline。
- L02 `LLMManager.getApiConfigs/selectModelFor` 已有，send 审计模型查询无 L02 缺口。L03 所需 unified stream 的提供方状态由 L03/L02 对齐，不在 L04 复制生成链路。
- L04 `chatSession.createMessageSender` 是调用方工厂，send/wake 命令暂未注册；其 goal runtime 及完整 IPC 接线仍为本 lane 续作，不声称仅剩跨 lane 阻塞。测试端口替身只证明 L04 校验/审计/ID/generation/清理行为，不证明 X5 SSE/落盘可达。
- 恢复检查：typecheck 作业 `20261104084253-defe0d` 退出码 0；本 lane 作业 `20261104084253-606fd1` 退出码 1，`Tests 30 failed | 512 passed | 2 skipped (544)`、`Errors 3 errors`。29 项初始化超时，另 1 项真实 workspace 删除仍报下面的治理接线错误；旧 receiver/readGuard 错误未出现。

## 已解除：main 账户调度类型声明

- 此前 TS7016 位于 `scripts/electron-migration/accounts.test.ts(2,68)`。main 已补 `lib/accounts.d.mts`；合并后 `npm run typecheck:host` 通过，不再构成门禁阻塞。

## 已解除：L05 真实工作区删除的治理锁与 receiver

- 复现：`npx vitest run -c vitest.host.config.ts host/plugins/chat/tests/workspace-runtime-integration.test.ts --maxWorkers=1`。
- 历史错误为 `Workspace deletion requires governance.acquireOperationGuard(DeletePropagation)`；本轮 merge `eb6cfdf8c` 已得到 L05 正式治理绑定，测试夹具同步装载真实 L21 backup/governance。
- 原 `liveExecutor` receiver 问题已由 main 的 `.apply(target,args)` 修复，getTaskManager/getSleepManager/emitWarning/emitCoordinatorAwakened 也已公开。L04 已改为直接使用 L05 类型，无需原局部接口断言。
- `20261104094325-1d86f7` 退出码 0，2 文件 / 12 passed、无 Errors：真实创建/取消/睡眠查询/关闭/删除全通过，并验证持有 Backup 许可时拒绝删除且 chat 会话仍在、释放后删除 workspace 与所属 worker chat 会话、最终许可释放。没有修改 L05 私有实例。

## L07 已承载 L04 connector ledger 的剩余语义差异

- 已有唯一生产实现 `agent-skills/repository/connector-ledger.ts`，经其 api.ts 被 L07 executor 与 L03 finalizer 消费；L04 已补齐 11 条原测试。
- main 已补 safeIntegers/bigint、prepare/parse 前缀和列类型拒绝；仍需 L07 对齐列类型错误的精确 rusqlite Display（当前 `Invalid column type for …` 与 Rust 的 `Invalid column type … at index: …, name: …` 不同）。L04 不建立第二套表写入实现。

## 待生产接线的接口（区分候选与 main，仍须完成 L04 自有调用方）

- F4 ZIP 接缝现已候选 `938e7c12c`（F4 lane-gate通过）提供：util/index.ts 的readZip/ZipError/zipEnclosedName，ZipArchive.inspectByIndex(i,{platform?})返回含unixMode/enclosedName/index的ZipIndexEntry且不inflate/CRC；错误按Rust by_index顺序。接入须等main，不再把该能力称为“提供方未实现”；本lane仍须实现stage的symlink/4096-entry/size/ratio限制与物化/分页，不以F4候选签收整个命令。

- stage_context_attachments的L11同conn原文回退读取已候选09c504019提供 `AttachmentRepository.getInlineDataWithConn(conn,fileId):string|null`，对应Rust attachment_stage_executor.rs:1350-1362，不再称未实现；待正常main后与已有getById/getContentSource一起消费。F4 ZIP所需by_index元数据面已由上段938e7c12c候选提供。不复制files/resources SQL或ZIP parser；自有stage文件名/IO/索引/分页清单流程仍待迁移，不能把该命令整条记为外部阻塞。

- L03 `ChatPipelineService` 尚无 Rust `execute/execute_with_existing_user/run_compaction_for_session/execute_multi_variant` 的执行入口；影响 send/wake/retry/edit/continue/variant-retry/compact 及 workspace run/create/restore。现有 api.ts 只有上下文、预算、序列化、prompt、finalizer 等局部能力。L04 的 handlers 本体仍有未迁移内容，不能全记为跨 lane 阻塞。
- L06 persona 路径校验/原子写/共享文件锁已发布并消费于 profile read/delete。merge `ebd7674d0` 后 L05 `api.ts:78` 已公开 `validatePersonaModelConfig`；L04 已接入 workspace_save_agent_profile_file，调用方 Node 验证 `20261104111116-01b955` 8 passed / exit 0，typecheck `20261104111116-f9f3ce` exit 0。模型错误保持原文；目录获取失败仍保存并回传原 warnings。
- 已解除：`resource_repo.rs` 11、旧 soft_delete_group 1、旧变体仓储 7，共 19 条已获 `migration/approvals.d/C1-app.json` 逐 ID 批准，TESTMAP 已更新 obsolete；没有豁免现行变体 handler 或 message helper。

## 接管续作（2026-11-04 晚）：执行类命令现状与外部阻塞

- **main 红（非 L04）**：lane-gate 的 tests 以 `host/plugins/chat` 前缀选中 chatanki；`chatanki/tests/review-executor-real-l15.test.ts` 3 条在 main 879e0a56b 上失败（L15 CAS 拒绝 >2^53 的 i64 review version，`local_version 9223372036854774784 exceeds the exact JS integer range`）。本分支对 review/chatanki 零改动（`git diff main -- host/plugins/review host/plugins/chatanki` 为空）；单跑复现作业 `20261104145427-7bd6b2`。修复在 L24 分支 `342c61556`（未合入）。自检作业见 LANE。
- **已实现、按真实提供方条件注册**（chatPipeline 服务上出现对应方法才注册，不注册空壳）：`chat_v2_retry_message`、`chat_v2_edit_and_resend`（需 `execute` + `llm` + `vfsRepo` + `agentVfsResolver`）、`chat_v2_retry_variant`（需 `executeVariantRetry`）、`chat_v2_compact_session`（需 `runCompactionForSession`，此前已完成）。L03 实现进入 main 前，这些命令在运行时不出现。
- **chat_v2_retry_variants**：命令层已按 variant_handlers.rs:766-828 实现，仅当 chatPipeline 提供 `executeVariantsRetryBatch` 时注册；Rust 调 `pipeline/multi_variant.rs:2831 execute_variants_retry_batch`，L03 契约（`ChatPipelineExecution`）尚无对应方法。已 coord 投递 L03，请求 `executeVariantsRetryBatch(window, sessionId, messageId, VariantRetrySpec[], userContent, userAttachments, sharedContext, options, cancellation, state)`。
- **[已解除 2026-11-05，886f9e633]** L06 已在 main 发布 todo 持久化接口，continue_message 已实现并注册。原记录：**chat_v2_continue_message**：依赖 L06 `todo_executor.rs` 的 `load_persisted_todo_list(_with_conn)` / `restore_todo_list_from_db`（含执行器内存 TODO_STORE），main 与 L06 分支均未发布；L04 不能自写 chat_v2_todo_lists SQL 或另建内存表。已 coord 投递 L06。
- **[已解除 2026-11-05，886f9e633]** L03 execute 已进 main，send/wake 已注册；窗口解析用 host/window 生命周期表。剩余：host 重启后不重放已存在窗口的 created（electron/shell/windows.ts:169 只发一次），已 coord 请 F2-shell 重放或提供窗口枚举。原记录：**chat_v2_send_message**（及 wake）：调用方 `MessageSender` 已有；L05 `escapeXmlContent` 已于 23:20 进 main。仍缺：L03 `execute` 实现（main 只有契约）；GoalRuntime.resolveWindow 对应 Rust `goal/runtime.rs:435 resolve_emit_window`（取 main webview，否则第一个），host/F2 目前没有窗口枚举提供方。

## H3 核查（2026-11-04 22:55 CST）：stage_context_attachments / wake_session 仍不能注册

- `chat_v2_stage_context_attachments`：Rust `attachment_stage_executor.rs:1849` 依赖 ZIP 条目的 unix_mode/enclosed_name（:411-419）与 files/resources 原文回退读取（:1350-1362）。对应提供方实现 F4 `938e7c12c`（`ZipArchive.inspectByIndex`/`zipEnclosedName`）与 L11 `09c504019`（`attachments.getInlineDataWithConn`）此刻都**不在 main**（`git merge-base --is-ancestor` 均为否）；main 的 `ZipArchive` 只有 name/size/compressedSize/isDirectory，没有 unixMode，无法实现 symlink 拒绝。按规定不复制 ZIP parser 和 SQL，所以本命令不注册。自有部分（文件名清洗、`.staged_index.json` 去重、有界拷贝、分页 CorpusManifest）可以直接复用 agent-skills api 的 `TaskObjectHandleBuilder`/`buildCorpusManifest`/`corpusManifestModelNotice`/`hashTransformParams`，以及 agent-workspace 的 `tempRoot`/`artifactRoot`；两个候选进入 main 后再落地。注意 serde_json 开启了 preserve_order（src-tauri/Cargo.toml:101），hash 参数要按 `{resource_id, source_id, display_name}` 的插入顺序。
- `chat_v2_wake_session`：编排本体已经在 `src/send-message.ts` 的 `MessageSender.wake` 里，并有 send-message.test.ts 覆盖，缺的只是生产接线：(1) L03 分支 `chat-pipeline/api.ts:246` 已发布 `ChatPipelineExecution.execute` 契约，但 `PipelineService`（chat-pipeline/index.ts:153）没有实现 execute，main 上也没有；(2) Rust 轮末会调 `goal::runtime::spawn_goal_continuation_if_idle`/`settle_active_goal_on_turn_end`，需要在生产环境构造 `GoalRuntime`，它依赖 `escapeObjective`（Rust 为 `vfs_resolver::escape_xml_content`，目前没有公开的 TS 提供方）、`backgroundTasks` 和窗口解析。这些和 `chat_v2_send_message` 共用同一个 MessageSender/GoalRuntime 实例，应由负责 send_message 接线的一方一次接好，wake 再按 `typeof chatPipeline.execute === 'function'` 有条件注册（与 compact_session 的做法一致）。

## H1：worker 运行时三命令（workspace_run_agent / workspace_create_agent / workspace_restore_executions）的跨 lane 依赖（2026-11-04）

实现已在分支 `ds-mig/L04-chat-session-h1`：`src/grants.ts`（grants.rs 注册表与撤权代际）、`src/completion-dispatcher.ts`（completion_dispatcher.rs）、`src/workspace-run-agent.ts`（run_workspace_agent_backend 与三命令）、`src/register-workspace-workers.ts`。三命令只在下列依赖全部存在时注册（index.ts 的 chatPipeline 注入里检测），缺任何一项都不注册，不降级运行。

1. **L03 `execute`**：main 的 `chat-pipeline/api.ts` 没有 `ChatPipelineExecution.execute`（契约在 L03 分支 api.ts:245）；`BackendSendOptions` 在 main 上也还没有 `strictModelId`（types.rs:2156 `serde(skip)`，L03 分支 persistence.ts:19 已加）。L04 按契约 `execute(window, request, signal, state)` 调用，并在 options 中传 `strictModelId`。
2. **L06 `headlessToolSchemas()`**（headless.rs:664）：L06 分支 api.ts:115 已导出，main 没有。worker schema 注入（extend_worker_tool_schemas）需要它；L04 通过 `workerRuntimeSurfaces()` 检测，进 main 后改为直接 import。
3. **L05 `CHATANKI_READONLY_TOOLS`**（custom_agents.rs）：TS 在 `agent-workspace/src/workspace/tool-registry.ts:70`，api.ts 未发布。已经 `coord.mjs queue L05-agent-workspace` 请求增加一行导出。install_worker_card_read_scope 需要它，检测方式同上。
4. **L03 hooks.rs:340 的 grant 存活门**：L04 已在 api.ts 发布 `lookupGrantForSession` / `ensureGrantLive` / `grantDenialMessage`。L03 需在白名单检查前调用（被拒消息原样回喂、warn 日志），否则撤权只落库不拦截。
5. **completion_dispatcher 无窗唤醒轮**：执行器用 L06 `agentSubagent.runHeadlessAgentTurn`（可选成员）。未发布时唤醒轮按 Rust 失败分支处理（warn，inbox 已持久化兜底），不是静默成功。
6. **窗口探针**：Rust 是 `app.webview_windows()` 非空。kernel 没有窗口列表 API，L04 只能跟踪 `host/window` 的 created/destroyed，chat 插件启动前已经存在的窗口统计不到。需要 F2/kernel 提供“当前窗口列表”才能完全等价。
7. **L04 自有剩余**：工具路径（L05 WorkspaceToolExecutor 的 `runWorkspaceAgentBackend` 上下文字段）还没在 L04 的执行上下文组装里接 `runWorkspaceAgentBackend`；这是本 lane 的后续工作，不算外部阻塞。

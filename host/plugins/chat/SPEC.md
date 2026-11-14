# L04-chat-session 行为规格（`host/plugins/chat/`）

## WP-168：会话授权 / Plan 原子仓储供方

生产入口：`index.ts` provide → `src/service.ts` → `repository/session-authority.ts`；值级操作从 `api.ts` 导出，命令层共用 `src/session-authority.ts`，不维护第二份授权解码。

| Rust（chat_v2/） | TS / 分支与顺序 |
|---|---|
| repo.rs:2851-2860 | getSessionAuthorityState：getSession → 不存在抛 SessionNotFound → 解码 metadata，无写入 |
| repo.rs:2898-2910 | setSessionPlanState：重读 → 解码授权 → 替换/清空 plan → apply metadata → 采样 updatedAt → updateSession → 返回；不新增事务 |
| repo.rs:2915-2940 | consumeSessionPlanBinding：IMMEDIATE → 同 tx 重读 → mode=plan 且 approved/binding/严格有效期全部匹配 → 清 plan/采样 updatedAt/update；不匹配仍正常提交且不写；提交成功才返回 true/false；异常交 F3 回滚 |
| types.rs:597-609,677-706 | Plan 必填 planId/status/summary；三个 Option<String> 缺省/null省略、错类型整体回退无 plan；unit enum 字符串/单键null对象、struct序列按 serde_json value/de.rs:482-495 接受；未知字段忽略。metadata 主键即使 null 也遮住 snake_case alias；Rust trim + ASCII lower；默认 craft/relaxed |
| types.rs:708-740 | 非对象 metadata 变空对象；保留其它字段，双写四个授权键；None 删除 plan，Some 仅序列化原六字段；metadata Value 用 F4 JsonReader/原生 raw 数字保留 >2^53 与超 f64 数值 |
| types.rs:612-654 | pending UUID v4、bind 原样；approvedUntil 缺省无限期、非法 RFC3339 无效、严格 > now；markApproved 同次时钟采样 + 精确 bigint 秒 TTL（含负数），越界按 chrono panic 抛 RangeError；markExpired 只改 status |

- 精确时间签名：`consumeSessionPlanBinding(sessionId, bindingKey, now: ParsedDateTime): boolean`；`isPlanBatchActive` / `isPlanActiveForBinding` 同用 F4 已发布 `ParsedDateTime`。调用方用 `parseRfc3339(now().rfc3339)!` 取得当前值。Date 只有毫秒，无法保留原边界；不接受舍入 Date。比较 `(epochNanos - nanos, nanos)`，保 chrono 闰秒顺序。
- 日志：新方法自身无 Rust 日志；复用 update_session_with_conn 的 debug `Updating session` 与 info `Session updated`，后者在外层 COMMIT **之前**（包括随后提交失败的情形）。SQL/BEGIN/COMMIT 错误保持 `ChatV2Error('Database', 原消息)`，缺行保持 `SessionNotFound`。
- 所有权：仅 chat_v2_sessions；无跨域 SQL、取消点、事件、额外预算或 dispatcher。中央组合由 L03/WP026 消费供方。
- 验证：`tests/session-authority.test.ts` 经真实 Host；别名/null/default/非法与重复 JSON、Plan 生命周期、纳秒/闰秒边界、metadata 精确数值与 updatedAt 顺序、不匹配提交、IMMEDIATE 锁内重读、UPDATE trigger 故障与 deferred FK COMMIT 故障回滚；两个独立 Host 进程/SQLite 连接同步起跑，仅一个 true。原测试时限不变。
- TESTMAP：没有这三个仓储方法/Plan 的对应原测试条目，本包不新增或改映射；实际 527 条，394 ported / 114 pending / 19 已批准 obsolete。证据等级为生产入口测试 + Rust/依赖源码审读；不计差分/C。

## main-red：Linux 原生 OCR 两用例（fulltest 16a254adf）

- 根因是main尚未集成本分支已有平台条件修复，不是L01接口变更。Rust dstu-llm/ocr_adapters/system_ocr/mod.rs:49-68只在macOS/Windows分发native，Linux返回Unsupported；原始修复`afecaa49a`保留两条native用例所有断言，仅限定原平台，并增加Linux真实IPC错误/首图停止/不触发binding回归。`8523e3723`仅移除与该handler无关的数据库夹具。
- 不放宽Linux语义、不重写已完成hunk；当前Node `20261104141156-496de6`与Electron `20261104141156-51c3be`均5 passed / 2 Rust平台条件skipped、无Errors、exit0。macOS/Windows本轮未实跑，不能把平台条件排除算作其能力验证。C1已亲核Rust依据并将可独立集成的测试hunk清单给C2。

## audit-L04-T1（关联C04-07 / X6-AP-0147）：权限回读测试精确等价

- Rust load_session.rs:143-151要求加载后Craft/FullAccess且persisted==loaded_authority（含plan）。旧TS部分匹配不足，已更正为完整metadata的toEqual，并明确断言plan=None缺键。
- 当前Rust types.rs:708-739的apply_to_metadata确实写四个键（authorityMode/authority_mode、permissionPreset/permission_preset），不是单一输出键名；保持该生产行为。输入改为两个各自仅含一种命名的独立用例，避免双键同时存在掩盖某个别名读取失败。输出精确要求Rust四键且无plan，持久化再与加载结果精确相等。

## X5-01：手动压缩命令层契约（block_actions.rs:57-115）

- [x] 入口/分支：先ensureSessionWritable，再Rust trim验证modelConfigId，之后读取会话features.userMemory（任何读取/typed map失败为None），最后tryRegisterStreamOwned；忙或kill switch拒绝都返回skipped/streaming，不变成Err。
- [x] L03调用形状：runCompactionForSession(sessionId,trimmedModel,'manual',[],contextLimit,memoryEnabled,token.signal)，不改成默认Model2、不把null memory视为false、不忽略显式0 contextLimit。
- [x] 输出：复用L03真实compactionStatus/ReasonCode/TokenEstimates；reason总是存在，可空；无tokens的字段省略。所有结果/异常均finally释放原generation；不取消/移除后注册的轮次。
- [x] 错误/日志/副作用：ChatV2Error在命令出口转原JSON字符串；此handler没有自己的日志/事件或事务，持久化/压缩事件由L03实现负责。
- [x] 所有权/测试：会话读归L04；上游执行仅调用L03端口。契约测试经实际chat插件注册与kernel invoke，结果映射使用真实L03 helper service，只有待发布的runCompactionForSession替身。
- [ ] 完整生产接线：仅在注入的chatPipeline确实提供runCompactionForSession时注册命令；main helper-only provider继续Command not found，不注册固定失败占位。L03完整执行进main后才可签收命令，不以声明/替身标完成。

## X5-01：L03 history/final 的四个同事务公开方法

- chatSession.getMessageWithConn/updateMessageWithConn复用repo.rs:row_to_message/update_message对应仓储，不重开连接/提交；日志继续传Host logger。markAvailableSkillsSnapshotStaleWithConn直接绑定已有repo.rs:3154-3189实现，不加外层事务，调用方传同tx。
- getCompactionSummaryMessageIdsWithConn对应pipeline/compaction.rs:1503-1514实际的SELECT DISTINCT blocks.message_id JOIN messages WHERE type='compaction_summary' AND session_id；不是查compaction记录表（旧/悬空摘要块也要排除）。不水合正文/toolOutput，不排序、不自行warn；查询/列类型错误原Display留给L03调用点:1521-1525记录。
- 契约测试通过真实chatSession和F3事务验证未提交消息读写、外部回滚、换代标记同事务回滚、摘要ID去重/会话隔离/损坏toolOutput不参与读取。缺消息更新仍MessageNotFound，无吞错。

## C04-03 / X5-01：Goal 续跑运行时（goal/runtime.rs:69-441；steering.rs:13-49）

- owner为L04，复用F4 BackgroundTasks.spawn而非另建全局调度器；每轮先睡150ms，再取pipeline/window/goal。无pipeline debug、无window warn、无目标/非active debug后退出。优先main窗口选择由调用方平台resolver提供，不把旧调用窗口当全局main。
- 每轮预算从同一chat表精确INTEGER读（safeIntegers）；continuationCount>=20或tokensUsed>=tokenBudget先warn，再按expected goalId改budget_limited并发goal_updated；取得第二个连接失败按Rust静默退出。
- 构造ephemeral wake（skipUserMessageSave=true，三个goal schema tool IDs，msg_UUID）→原子注册→在飞集合登记→同goalId/status/budget条件CAS认领。认领连接/SQL失败或零行必须清在飞标记并按generation释放，不调用execute。
- 调用已公开headless兼容runner，原token与state传给L03。guard释放后清在飞标记：成功debug并进入下一轮；Cancelled debug→paused；其他业务错误warn→blocked。CAS目标已替换则不覆盖新goal，不广播陈旧记录。
- settleActiveGoalOnTurnEnd只对仍active的goal转换状态，连接/查询/更新/emit分别保原warn；pause/clear只取消在飞续跑，不误取消普通用户轮。事件emit失败warn后继续，DB是权威状态。
- steering正文逐字保留Rust；objective转义消费L05现有escapeXmlContent最小端口，已申请公开，不能复制其私有通用转义。预算行用精确整数算剩余并max(0)。本单元先发布真实运行时工厂与契约测试；goal_resume命令及send后台钩子的最终接入仍依赖上述公开转义面和L03execute，不据工厂测试签收整条C04-03。

## X5-01：chat.send/headless 低层执行契约（send_message.rs:294-342）

- `runSendMessagePipelineOwned` 接收调用方已经原子注册的 StreamRegistration；不二次注册、不重写ID、不替代调用方spawn。注入精确generation后await L03 execute，finally按generation释放。
- headless兼容入口 `runSendMessagePipeline` 接收调用方保留的AbortController，按state.rs:520-545两次cancel检查查guard：有guard才覆盖generation，没有guard仍把原请求/token交execute；finally只释放实际创建的guard。保持Rust兼容路径，不新增token身份匹配规则。
- api.ts先公开 `ChatSendExecution`：runSendMessage(window,request,registration):Promise<string> 与 runHeadlessMessage(window,request,token):Promise<string>；chatSession.createSendExecution(pipeline,state)绑定真实执行器/状态。返回是Rust assistant ID，不伪造userMessage/时间戳；high-level headless.rs的会话模式/预算/摘要归L06，本lane不复制。
- L06现有单参数runSendMessage草稿丢失registration/token/window，须消费本公开契约；其调用方已注册，不能让L04再次注册，也不能重新查询替代generation。backend userMessageOrigin/executionAllowedTools保留在后端options，不向IPC公开。
- 这是一组可调用的真实runner与契约测试；完整 chat.send@1 provider/IPC仍等待L03正式execute接线，不宣称真实SSE/持久化X5已完成。

## 验收问题处理

### C04-02 / C04-06：创建 roots 与已定位日志

- manage_session.rs:338-403：先入口 info、mode/group 校验（缺失/非active各原 warn），持久化之后依次调用 L05 公共 artifactRoot(create=true)、tempRoot(create=true)，对应 runtime_roots.rs:805-808；失败只 warn，不回滚会话，不继续下一 root；最后 Created info。不复制 L05 路径/授权/文件创建算法。
- send_message.rs:866-878：cancel_stream 入口 info 在取消前，成功后第二条 info；idle只保留入口日志及原 Other 错误，不自行发 stream_cancelled。
- manage_session.rs:2133-2144：authority mode 先解析，成功后记录规范化值，再访问仓储；无效 mode 不记成功解析日志。
- variant_handlers.rs:204-207,368-378,1092-1123：switch 在写入/技能同步后 info；delete 在尝试发事件后 info；cancel 入口 info，所属校验后按 token 是否取消分别 info/debug。没有以日志改动替代完整 retry/X5 交付。

- C04-07 两个具体反例：`test_backend_event_serialization` 改用生产 BackendEvent.chunk 工厂（events.rs:1906-1943 所有12条原断言保留）；`test_session_event_serialization` 改由真实 ChatV2EventEmitter 分配 sequence=7、generation=42 并发出完成事件，接收器只记录，不构造被测载荷（events.rs:2085-2118 八条原断言保留）。其余 TESTMAP pending 仍不宣称全部闭合。

### C04-01 / C04-05：快照 Display 边界与真实事务失败

- snapshot_handlers.rs:87-97,123-137 的数据库/仓储错误使用 Display，不经过 ChatV2Error 的 JSON 命令转换；导入 :195-218 的 Validation 同样是 Display。register 的三个 snapshot 命令使用独立边界，仅映射 ChatV2Error/StorageError，不吞编程异常。
- 导入 :463-465 begin 的 rusqlite 错误直接 Display；:484-485 commit 错误带 `Failed to commit import transaction: `；回调内仓储错误仍保留 Database error 前缀。平台同步事务负责回滚，事务成功后才记 :487 info。
- settings manage_session.rs:1231-1232,1274-1275 的 begin/body/commit 全部经 ChatV2Error(Database)，再按原命令转换为 JSON 字符串。真实第二连接写锁与 deferred FK 提交失败验证错误 settle、事务回滚与重试。
- 快照完整 serde 解码仍需单独完成；本单元不把 C04-01 整项签收。

### C04-04：会话技能状态解码/合并

- types.rs:1196-1212：五个 Vec<String> 仅缺字段默认空，null/混合类型整体解码失败；version 缺省 0，u64 范围精确且拒绝浮点字面量；legacyMigrated 缺省/null 为 None，其他非 bool 拒绝；未知字段忽略。复用 L20 公开无损 JSON parser/stringifier，不写第二套 parser。
- manage_session.rs:2070-2098：有效入站结构优先，否则 existing.resolvedSkillState；两者没有则原样保存 incoming。不带有效结构时从 activeSkillIdsJson 解码整串 Vec<String>，错误整体空；手工列表按顺序比较，不排序/去重后比较；改变才 u64 饱和加一。
- without_branch_local_skills :1290-1297：branch 非空才清空并再饱和加一，legacyMigrated 始终 false。结构序列化省略空 Vec/None，version 保留；派生 active/loaded 列才按 Rust UTF-8 字节序排序并去重，空列 None。
- 同一解码/序列化复用于分支与历史重建；variants/deletion/branch 的既有附加测试曾错误要求持久 JSON 含 branchLocalSkillIds:[]，现按 types.rs:1205 改为明确断言该键不存在，其余技能保留/版本/源数据不变断言保留。不是删掉分支清空保证；内存态仍是空数组。
- deletion 的 fallback 持久化附加测试同样按 types.rs:1203 把 agenticSessionSkillIds:[] 更正为明确缺键断言，仍核 manual 技能、version=1、legacyMigrated=false；原 Rust 内存结构测试的空数组断言不变。
- C04-04/05/07 本单元验证：typecheck `20261104115245-a068d7` exit 0；本 lane 完整 Node `20261104115653-81f7b3` 63 文件、558 passed / 2 原平台 skipped、无 Errors、exit 0；Electron 针对事务/技能/事件/删除 `20261104115653-4324af` 4 文件、74 passed、无 Errors、exit 0。普通 boundaries 0 violations、importable ok、ledger problems 全0。C04-01 仅 Display 子项已修；完整 from_str 解码未签收。

- 保存命令接入后的完整本 lane 作业 `20261104111841-a0dcc4`：`Test Files 61 passed (61)`、`Tests 550 passed | 2 skipped (552)`、无 Errors、exit 0；typecheck `20261104111841-e7a5ec` exit 0。两个 skipped 是 Rust 原生 OCR 的 macOS/Windows 条件，不新增跳过。

- L04 独立目录复验 `20261104110713-a52d4d`：61 文件、547 passed / 2 平台条件 skipped、无 Errors、exit 0。宽路径被选中的 L03 stream-hooks-guard 两个失败已精确交接 BLOCKERS，不弱化其断言或给 chat 增加假的 injectionBudget。
- 新增 persona save：Node `20261104111116-01b955` 8 passed / exit 0；补充有效 model 成功断言后的 Electron `20261104111509-a39e26` 8 passed / exit 0；无 Errors。L02/L05/L06 实际公开方法已消费，未复制私有校验。

- X6-SW-CHAT-01：实际修复提交 `796ec7c9d`，`repository/vfs-folders.ts:21-36` 通过 L11 getFolder/folderExists/generateUniqueFolderTitle/createFolder/updateFolder 传入同一 SqlExecutor；本适配器无 folders/folder_items/path_cache 写 SQL，没有搬到本 lane 其他生产文件。原 folder provisioning → runtime root 校验顺序保留。真实 L11 Node 集成 `20261104094325-1d86f7`、Electron `20261104095356-7fb0d0` 各 12 passed / exit 0 / 无 Errors；候选待 main/X6/R2 复核，不自行签收。

- threads 复验 `20261104095355-b192a3`：148 文件通过、AGENTS.md 三个额外回归失败（exit 1，3 failed / 1382 passed / 2 skipped，无 Errors）。根因是 worker 的 process.env 副本不控制原生 os.homedir；测试改为只替换 OS home 查询，真实发现/文件读取/mtime 缓存/全局回退/错误日志路径与全部原断言保留，生产实现不变。

- 2026-11-04 集成门禁反馈（stream-sink-wiring / completion-finalizer）：merge main `eb6cfdf8c` 后作业 `20261104091152-347571` 已分别 2/2、4/4 通过。该作业整体仍退出码 1（12 failed / 1373 passed / 2 skipped，Errors 3），不把局部通过写成全量通过。
- 本 lane 新基线问题：groups 旧 paths 替身没有 F4 `dataSpaceDeviceId`，改用真实 createPaths，仍经真实 L11 FolderRepository；workspace 旧集成夹具缺 L21，补装真实 backup/governance，保持删除断言并增加许可/关联 chat 单写者回归。jobs `20261104094325-1d86f7` 两文件 12 passed / exit 0 / 无 Errors。groups 两库迁移实测单次 setup 24 秒，显式给予 60 秒 setup 预算，不修改业务断言。
- send/wake 调用方已发布，Node 作业 `20261104090619-0c9581`、Electron 作业 `20261104090739-ba0a39` 各 5 passed / exit 0 / 无 Errors；typecheck `20261104090619-7df4ed` 与合 main 后 `20261104091152-4b78d2` exit 0。完整命令尚未接入，TESTMAP 对应行保持 pending。

## X5 send/wake 调用方（send_message.rs:30-342,462-843）

- 顺序：原诊断日志 → session ID 前缀 → ensure_session_writable（不存在不拒绝）→ 内容/引用 → kill switch → L02 模型多模态查询 → request audit → 确定 assistant ID → send 的 waiting_user 目标恢复 → 原子注册 → tracked 后台执行 → 立即返回 ID。wake 不恢复 waiting_user，强制 skipUserMessageSave；显式空 ID 保留。
- 显式 modelId 用 Rust trim 后在 configs 顺序中匹配 id 或 model；未指定/全空调用 selectModelFor('default')。查询错误按原 warn 后 false；audit 发射失败 warn 后继续。contentLength 为 Unicode chars，诊断 content_len 为 UTF-8 bytes；审计 ref 的 injectModes/blocks/mismatchReasons 保留原顺序。
- replayMode 有值即 temperature=0；owned runner 把后端 bigint generation 写入后端 options，token 传 AbortSignal；finally 仅清同 generation，不清取消后新注册的轮次。handler 不生成 stream/block/save 终态、不代替 L03 持久化。
- 运行结果：成功 info 后触发本 lane goal continuation；Cancelled info 后仅 active goal→paused；其他错误 error 后 active goal→blocked。这些发生在 StreamGuard 释放之后。goal 查询/写入失败各自原 warn，成功更新才发 goal_updated；send 的 waiting_user 翻转在注册失败时也不回滚。
- 接口状态：L02 getApiConfigs/selectModelFor 已在 main；L03 execute 尚未公开。先发布 L04 最小执行端口与调用方测试；没有真实 provider 前不注册 send/wake，也不把端口替身验证计作 X5 真实 SSE/持久化完成。

## 变体隔离执行上下文（variant_context.rs:151-1199）

- 构造记录 createdAt，pending、独立子取消令牌、空块/工具/交替列表、TokenUsage 默认；共享检索上下文与 emitter。父取消只触发 signal，不自动发终态事件；cancel 方法始终取消自己，终态已到达则只 debug、不重复发事件。
- createBlock 生成 blk_UUID 并归属；addBlockId 允许重复，content/thinking setter 才去重。内容/推理首次非空 chunk 各记录时间；空推理追加把 None 变 Some("")。reset 只清本轮累积/当前块 ID/首 chunk 时间，不清历史交替块、token、工具结果或块归属。
- interleaved 同 ID 替换保留原 blockIndex，新 ID 按数组长度赋序号；追加文本倒序查找，成功更新 endedAt。tool round fetch_add 返回旧值并 u32 环绕。getter 返回 Rust clone 对应的副本。
- start 仅 pending→streaming，其他状态 warn；complete/fail/cancel 三终态分别 info/error/info 后 emitVariantEnd，usage 仅 total>0 时携带。toVariant 复用构造时刻、附可选 config/meta/error/usage，不在读取时刷新时间。
- manager 同 ID 覆盖，cancelAll 先取消全局 signal，再只对 pending/streaming 调 cancel；firstSuccess 按 createdAt+variantId UTF-8 字节排序后 success→cancelled→首个。clear/remove 不隐式取消；日志按 Rust 原级别。

## 课题 VFS 单写者与 runtime root 接线整改

- group_handlers.rs:62-142 的顺序保留：先 VFS folder provisioning，再解析 defaultRuntimeRootId。文件夹 get/exists/unique/create/update 全部委托 main 上 L11 FolderRepository；删除 L04 的 folders/folder_items/path_cache SQL 副本，缓存失效与约束由唯一所有者执行。
- L04 只构造 handler 所需的新 VfsFolder 值（fld_+nanoid10、当前毫秒、root/icon=folder），其字段与 Rust new 一致；没有引入第二个文件夹维护逻辑。
- runtime root 查找改为 ctx.inject runtimeRoots → rootById(id,{session_id:'session-preview'})，保持 create=false；失败按 Rust Validation 前缀包装原 Display，不泄漏普通 Error 成 panic。未指定/空 root 不访问服务，绝对路径在 lookup 前拒绝。
- groups 测试改装真实 L11 插件与 F3 库，保留原 assertions；路径依赖仅替身 L05 公共方法，并断言 session-preview 上下文与原错误前缀。

## 基础 wire 值回归（types.rs:2964-3012,3034-3181,3341-3417）

- 通过真实 chatSession 消息/块/会话回读和 save/load IPC 验证 camelCase、_meta、type、可选字段省略；后台 blockIndex 不能进入 MessageBlock 的线上输出。
- PanelStates 旧形状缺 skill 可读，当前 skill=true 原样往返；未知/缺省字段由同一 IPC 契约和仓储路径处理。inboundOrigin 只在 meta 有值时出现，旧 modelId-only 数据照常回读。
- role/persistStatus 的枚举 wire 值在真实消息/会话持久化中分别保持 user/assistant、active/archived/deleted，不仅比较测试字面量。

## 自定义代理档案读取/删除（workspace_handlers.rs:2710-2724,2790-2809）

- 经 L05 coordinator.customAgentsDir 定位目录，调用 L06 公开 resolvePersonaPath 进行与工具相同的文件名/路径检查。返回 fileName 保留输入原文，不改为清洗后的名字。
- read：path.exists=false 返回 PROFILE_FILE_NOT_FOUND；读取 UTF-8 失败 `Failed to read profile file '{原名}': {IO Display}`；成功返回 {fileName,content}，无日志、锁、写入或事件。
- delete：路径检查在共享文件锁之前，拿锁后重新检查存在性；缺失 PROFILE_FILE_NOT_FOUND；unlink 失败 `Failed to delete profile file '{原名}': {IO Display}`；成功 info 原文，null 返回。锁在成功/异常都释放，与 L06 同一个锁实例。
- save 的 L05 校验出口已随 main 合入；其校验算法仍归 L05，不复制到本 lane。

### 自定义代理档案保存（workspace_handlers.rs:2743-2785）

- L06 validatePersonaContent 先于目录、路径和文件锁；若包含 model，先调用 L02 getApiConfigs，再由 L05 validatePersonaModelConfig 按精确配置 ID 校验。校验失败原样抛出，不转为警告。
- 仅目录查询失败允许继续保存，warnings 添加 `{code:'PERSONA_MODEL_CATALOG_UNAVAILABLE',model_id,message}`，message 保留原错误与“不回退模型”全文；无 model 时不查询目录。
- 完成内容/模型校验后才取 customAgentsDir → L06 resolvePersonaPath → 同一共享文件锁 → exists 检查。overwrite=false 且已存在报 PROFILE_FILE_EXISTS；检查在锁内，不预检后放行竞争者。
- L06 atomicWrite 成功后记录 Saved info，bytes 为 UTF-8 字节数；返回 fileName 原输入、agentName、bytes、warnings。错误与成功都释放锁。无 DB/事件/独立重试或新文件协议。

## L07 executor 贡献消费与花名册装配

- 使用 F1 `composePipelineExecutorRoster` 的 Rust 固定顺序（app 条目、可选 workspace 组、pipeline tail），不按插件装载顺序分派。每次装配读取当前 agentTools.toolExecutors 快照，后注册的同名实例覆盖先前 catalog 条目；调用方提供的本 lane/tail 实例追加到 catalog。
- 仅有 canHandle/name、没有 execute 的 L07 贡献不能计为可运行执行器：不合成 execute，不注册占位，完整花名册缺项由 F1 MissingExecutorError 一次报告。此服务是装配入口，尚缺的各域执行器须由所属 lane 发布真实 execute。
- 装配成功返回 L04 ToolExecutorRegistry，具体调用仍透传同一 ExecutionContext 的 services/authority/cancellation/logger，风险策略通过已有必需端口。借助 ctx.inject 跟踪 agentTools 替换/卸载，调用时不缓存旧贡献列表。

## ReplaySkillPayloadSnapshot 与 canonical 内容（types.rs:1072-1105,4318-4390）

- 快照仅接受 activeSkillIds/executionAllowedTools/skillContents/skillDependencies/skillEmbeddedTools/mcpToolSchemas/selectedMcpServers；旧 skillAllowedTools 为未知字段，回读/写出都丢弃，不升级为后端白名单。
- 持久化去 skillContents，但保留其余非空 replay 元数据；空 Vec/Map 字段省略，executionAllowedTools 的 Some([]) 必须保留，None/null 省略。hasReplayMetadata 不把 skillContents 单独算作 replay 元数据。
- message 与 variant 的 before/after 都走同一归一化，嵌套工具 schema 的合法 null 不删。canonical image refs 持久化保留各自 image/source/blob/name 身份，不因共享 resourceId 合并。

## L03 增量保存端口绑定（pipeline/persistence.rs:743-753）

- `chatSession` 实例增补 createMessageWithConn/createBlockWithConn/getMessageBlocksWithConn/listBlockPositionsWithConn，与 L03 PipelinePersistenceStore 结构对齐；原函数导出保持不变。
- listBlockPositions 仅 SELECT block_index,id WHERE message_id/type，无正文与 toolOutput 水合、不排序（L03 负责后续位置排序），类型异常传播。L03 调用方事务覆盖用户消息、助手消息、增量块和 replay sidecar。
- 集成测试使用真实 L03 createPersistence(chatSession)，验证首次保存、早期重放文本、只写 dirty 块、外部 Anki 块不覆写、数据库触发器失败后保留 dirty 并回滚，再重试成功。

## Emergency stop 联动补全（kill_switch.rs:193-287；workspace_handlers.rs:385-465）

- 原顺序 trip→pause scheduler→cancel streams→cancel automation runs→按注册顺序调用 emergency hooks→reject approvals→workspace worker/task 状态收敛→首次 trip 的系统通知→状态事件→warn 汇总。hooks 经 Host 自有 HookSet，返回 Disposer；不把 L24 脱管任务混入 cancelledStreams。
- workspace 遍历 loaded IDs，仅 worker 的 running/queued/interrupted 或实际取消了 stream 才更新 cancelled；成功计数/info，失败 warn。任务 manager/枚举错误按 Rust 静默跳过，逐条任务状态失败 warn。coordinator 角色不修改，重复执行无新增 worker 取消。
- 首次 trip 通知经 F2 main 已发布 systemNotification；never 档 info 后跳过，失败 warn 后仍返回结果。reset 不恢复 scheduler，resume_agents/resume_automations 发事件之后各记录原 info。
- 不因通知 await 改变统计口径：最终 status 在通知结束后重读，cancelledStreams 为本次最初取消数；只首次 trip 发 OS 通知，重复 stop 仍执行 hooks/drain/worker 收尾。

## L13 附件错误/检索范围服务（attachment_stage_executor.rs:58-203；session_scope.rs:9-25）

- chatAttachmentErrors.requiredId 对对象字符串参数 Rust trim，缺失/非字符串/空值抛 ATTACHMENT_INVALID_ARGS 的本地化 JSON；notFound 保留 detail 并给出固定双语 hint。
- localize 已是 JSON 对象则交共享 ensure_localized_error 保留原字段；否则按 schema-unavailable→staged-file→source-unavailable→attachment-not-found 顺序分类，ASCII 小写比较，不 trim 错误前缀。其他字符串映射通用 ATTACHMENT_OPERATION_FAILED。仅 staged-file retryable=true，日志/事件/DB 均无。
- chatRetrievalScope.loadSessionRagScope 是后端 Option 语义：获取连接、查询、JSON Vec<String> 任一失败返回 null；字符串数组过滤 trim 后为空的元素但保留原非空字符串、不去重；非法混合数组整体拒绝；全空返回 null。与 IPC get_rag_scope 的错误传播职责分开，不改前端行为。

## 剩余消息持久化原测试（repo.rs:7075-7793）

- message UPSERT 保留块（不使用 REPLACE 的 DELETE 级联）；同 ID 工具块物理重试只覆盖同一行，清空 error 并保留最后 toolOutput。session 删除 FK 级联所有消息/块。
- pendingContextRefsJson 是不解析的可选字符串，非空 JSON 文本/"[]"/None 分别原样保存和恢复；None 线上省略。公开 saveSessionStateWithConn 复用现有仓储。
- save_results_basic 原测试只验证仓储保存与 blockIndex 顺序，不宣称完整 pipeline.save_results 已接入。content_only 的 Rust 测试手写过滤改为调用 L03 真实 contentTextFromBlocks，保留同一断言。
- `test_load_chat_history_context_limit` 暂留 pending：前半段 25 条仓储加载可执行，后半段测试自写 20 条裁剪对应已删除历史策略（history.rs:7/73-75 当前明确加载全部历史）。按 D8 申请仅废弃该子断言，未自行批准，不恢复旧策略。

## 工具描述符查询（tool_descriptors.rs:681-725）

- 静态表复用 L06 已发布的 BUILTIN_DESCRIPTORS，不再复制一份常量表。L04 中央 registry 的 timeout 查找与公开 lookup 共用同一索引。
- lookup 仅精确裸名，绝不剥前缀；headless/grants 查询仅剥一次 builtin-。PTC 复用 L06 同源公开判定。未知工具为 null/false；grants hint 返回原表 builtin/shell 分类。
- 8 条原测试保留静态表唯一性、Low 敏感度、bare/prefixed 查询与 shell hint 的断言；headless/PTC 集合与 Rust 的独立 legacy 白名单常量对比，不用派生自被测表的列表作 oracle。

## Variant/SharedContext 消息值（types.rs:912-1050,1524-1543,1658-1787）

- Variant 的四种构造组合保留 var_UUIDv4/显式 ID、可选 configId、pending、空 blockIds 与当前 createdAt；usage/error/meta 缺省。状态 setter 不清除旧 error，不修改 createdAt；error/interrupted 额外写 error。usage builder/原地 setter/getter 保留同一结构。
- isMultiVariant 仅 len>1；active block IDs 查指定 active variant，找不到回退 message.blockIds；不自动择优。selectBestActiveVariant 才按 success→cancelled→首项选择，空/缺变体保留原 active ID；removeVariant 移除全部同 ID 项但不修 active 指针。
- SharedContext 默认为空对象，hasSources 仅检查五种来源数组是否非空。导出过滤复用同一个 getActiveBlockIds，避免与消息模型分歧。无 DB、日志或事件；只有构造采样毫秒与 UUID。

## X3-L04-01：消息可选列 SQL NULL 回读

- Rust repo.rs row_to_message 的 attachments/shared_context/variants 走可选 Vec/struct 解析；SQL NULL 或 JSON `null` 均为 None，必须省略线上字段。修正 `parseOptional` 将这些顶层空容器归一为 undefined；不改库中原值，不递归删除嵌套 Value null。
- 回归通过真实 chatSession.getMessage/getBlock 断言：可选字段省略、原 SQL NULL 未被重写、toolResults.input/output 与块 toolInput/toolOutput 的合法 JSON null 保留。

## TokenUsage 运行时语义（types.rs:153-286；dstu-core/token_source.rs）

- API/估算构造的 total 与 lastRoundPromptTokens 均为 u32 saturating(prompt+completion)，lastRoundInputTokens=prompt；reasoning 不计入 total。缓存构造仅另设 cachedTokens，估算按 precise 选择 tiktoken/heuristic。
- 默认/zero 的 source=tiktoken、三计数=0，所有可选计数缺省。累加三计数、reasoning/cache-hit/cache-write 均 u32 饱和；来源不同时变 mixed；其他轮 prompt+completion>0 才覆盖 last-round 字段，使用本轮输入而非累计输入。
- None 字段经工厂省略；序列化/回读测试走既有 message repository，而非断言测试字面量。此处无日志、事件、DB 操作（测试另验证持久化 codec）或时间/ID。

## 执行白名单策略（tool_policy.rs:5-133）

- canonical 只按 builtin-/builtin:/mcp.tools./mcp_ 优先级剥一层。control 仅本地 load_skills、attempt_completion 和三个 sleep 名；MCP 前缀控制工具与裸名+非空 _serverId 调用不享受豁免。
- None 白名单放行；显式空数组拦截业务工具；条目用 Rust trim 后忽略空串。精确匹配仍检查来源，server::tool 按首次 :: 分割，要求相同 trim 后 _serverId，再比较四种原名/短名组合。普通短名匹配只允许同为 MCP 或同为本地；builtin 前缀调用忽略参数里的 _serverId。
- 复用 L07 SkillsExecutor.isLoadSkillsTool、L06 isAttemptCompletion 与 F4 trim；不在 registry.execute 增加第二道策略判断，由 L03 中央准入调用公开 service 方法。无日志、事件、持久化或时间/ID。

## L05/L06 消费面补齐

- api.ts 重导出已迁移的 session/message/group/tag/search/goal WithConn 原语；保持单一仓储实现，让 L06 删除其 chat_v2 表的重复 SQL。`loadSessionMessagesPageWithConn` 按 Rust 一基页码计算 max(page-1,0)*pageSize（BigInt 避免 u64 精度丢失），返回 [messages,blocks,total]；offset 版本保留独立入口。
- ask_user 回调注册/响应从 api.ts 发布，复用 IPC 同一张等待表，不创建 L06 的第二张 Map。
- `chatSession.deleteSessionV2` 对应 repo.rs:3378-3383：IMMEDIATE 事务中调用级联删除，repo debug/info 在原位置，缺行 SessionNotFound；不混入前端删除命令的 VFS/FS 前置步骤（L05 调用者已有自己的生命周期流程）。
- `appendBlockIdToMessageWithConn` 与工具防闪退保存共享同一条 json_insert + NOT IN(json_each) 原子语句，供 sleep executor 预存块使用；不存在 message 时零影响行正常返回。

## VFS 引用计数与删除清理（manage_session.rs:152-238,711-759,893-1066,1147-1184；block_actions.rs:300-375）

- 接入 L11 vfsRepo.resources 与 L13 vfs.database；不写 VFS 表。session refs 只取每条消息 _meta.contextSnapshot 的 userRefs+retrievalRefs，不去重；branch 在 chat 事务内收集所复制前缀的 refs，提交后才 increment。
- branch/session/trash 的补偿：连接失败重试一次，仍失败 error 整批 IDs；每个资源操作失败立即重试一次，仍失败 error 单项及最终完整清单；成功全批 debug。失败不阻断 chat 删除或已提交分支。
- 单消息删除不同：一次连接、一次 decrementRefs 批调用，没有单项重试；连接/批调用失败分别 warn 后仍删除。VFS 调整发生在 chat 的 deferred 删除事务之前；skill 重建失败按 Rust `let _` 忽略，不额外发 handler warn。
- 硬删先检查 stream/anki/ID，再调用 L05 cleanupSessionRuntimeRoots；FS 失败映射 IoError 且保留 DB。随后 refs、Super 标记、IMMEDIATE 级联删除、sequence 清理、info、最后 Super hook。
- 清空回收站先快照 ID，再清理全部 runtime roots（任何失败先中止，不开始 refs/删除），再汇总 refs，最后逐条复查 deleted 状态并各自 IMMEDIATE 删除。恢复为 active 的行不删并记 info；所有 DB 删除完成后才触发 Super hook。

## 工具执行器注册表（tools/executor_registry.rs:24-515）

### WP-018：shell command policy 的 8 条原测试

- Rust 来源 `shell_command_policy.rs:92-331`，生产实现已由 L05 的 `src/tools/shell-policy.ts` 承载；本包经 `agent-workspace/api.ts:24-26` 调用同一实现。没有第二份策略、没有新增 registry 注册项。
- 实际生产可达链：`agent-workspace/index.ts:119-125` provide `agentWorkspaceTools` → `src/tools/executors.ts:74-75` 的 createShell/createShellPreflight → `shell-execute.ts:102,200` / `shell-preflight.ts:570` → enforceForCall。敏感度下限由 `shell-preflight.ts:419` 调用 applyToSensitivity。L04 registry 工厂已在 main；完整 roster / P1 另包核验。
- 分支对应（Rust → L05 TS）：默认策略 `71-79 → 49-51`；解析失败 Ask/config_valid=false `288-295 → 223-237`；deny > ask > allow 与同效首条匹配 `165-187 → 168-179`；exact/prefix/executable `131-163 → 133-166`；本地只读门与平台分支 `189-276 → 181-215`；protected/reason/规则 ID `296-314 → 238-263`；敏感度 allow→low、ask→至少medium、deny→high `320-331 → 267-275`。
- 测试 `tests/shell-command-policy.test.ts` 保留原规则 JSON、所有命令字符串、14 个 effectful 向量、4 个 PATH 向量和 6 个 subprocess 向量，两个非 Windows 断言保留原 cfg 条件。原 `parse_policy(empty).is_err()` 经公开 enforce 入口断言 `config_valid=false`：该标志在存在 raw 时仅由同一 parsePolicy 抛错分支产生，不能用仅断言 Ask 代替解析失败。
- 纯策略无日志、事件、DB 写入、时钟、取消或清理资源。设置读取边界复用公开 `shellCommandDecision`，补测真实键 `tool_approval.shell_command_rules`、Low→Medium 与默认 deny→High。
- 证据等级：生产可达策略公开入口测试 + 原 Rust 全文审读。本包覆盖指定 8 条原测试；审读发现的额外入站 serde / Unicode 差异属于 L05 现有实现，精确证据见 BLOCKERS「WP-018」，不能用这 8 条通过推断所有输入完全等价。

- 保持注册顺序优先；外部 mcp_/mcp.tools. 名字（排除四个内建 MCP 管理裸名）只路由 GeneralToolExecutor，不经 builtin 归一化。查无执行器返回原 `No executor found for tool: …`。
- timeout 只剥一层 builtin-，查已由 L06 发布的同一 BUILTIN_DESCRIPTORS；None=120、0=关闭，未登记外部 MCP=180、其他=120。Workbench/Canvas/BuiltinResource 三执行器非零 timeout 下限 180。未知 chatanki_/workbench_ 不按前缀延长。
- 执行前取消先于查找；每次执行创建子 AbortSignal（父取消继续传播），使用 scoped context。普通工具取消立即返回结构化 TOOL_CANCELLED；自管理取消的工具等待自身终态。timeout 普通工具为结构化 TOOL_TIMEOUT/retryable=true，自管理为 RESULT_UNKNOWN 原文；返回错误前先取消子 token。成功/失败后清 timer 和本次 race listener，不取消成功子 token。
- 成功结果按执行器预算调用 F1 已发布的 applyToolResultBudget，未覆写默认 DEFAULT_TOOL_RESULT_CHAR_BUDGET，显式 null 禁止外层截断。不重写原 executor 错误。
- getSensitivity 默认 low，concurrency 默认 serial、dynamic/managesCancellation 默认 false。风险快照通过 L05 最小端口取得 protected/neverRemember，不复制 approval_scope 逻辑；调用方必须提供两项真实策略能力，测试替身仅限 L05 端口。
- register/execution/timeout 配置 debug；执行前/中取消 info；普通/自管理超时各自原文 error；无 DB、额外重试、ID 或事件。事件/副作用仍由 executor 使用 scoped token 收敛。

## ExecutionContext 运行时工厂（tools/executor.rs:172-739）

- 保持已有 snake_case 字段，默认 variant/meta/toolCall/canvas/db/skill/token/authority/dispatcher/RAG 配置为空，三个 feature flags 为 true、shell_guard_approved=false。Host services 由调用者传入；不把请求参数当可信 authoring config。
- hasFrontend/tryWindow/windowRef 保持 Option/原 panic 文案；runId 取非空 tool_call_id，否则 block_id；isCancelled 查询当前 token。scopedWithCancellationToken 共享服务/窗口/emitter/DB，克隆技能映射与工具白名单；子 token 不修改父上下文。
- saveToolBlock：先查 chat DB，再查 result.blockId，各缺失分别 warn 并成功返回；同一次 now 毫秒计算 ended、started=now-duration、firstChunk=started、index=0。块类型现默认直接调用 main 上 L03 api.ts 发布的 `getBlockTypeForToolStatic`；原 blockTypeForTool 端口保留为可选后端覆盖，不复制映射。测试已去掉映射替身，验证真实 L03→L04 保存链路。
- SQL 独立依次执行：INSERT OR IGNORE assistant 占位消息（再次取 timestamp）、块 UPSERT、json_insert 条件追加 block ID；没有额外事务。中途失败传播，前面成功的写入保留；成功 debug 的 tool 字段保留 Rust 原误用 self.block_id。toolInput/output 的显式 null 仍写 JSON null。
- tool start/end/error 发带 variant/skillStateVersion/roundId 的现有 tool_call 事件；progress percent=min(100,value)、空 message 不写，以 NDJSON 加换行发 chunk，variant 恒 null。serialize 失败静默略过；不擅自因 cancellation 禁止发事件或保存（Rust 由执行器负责检查）。

## 历史窗口批量重放（repo.rs:1415-1474,2000-2072）

- session message IDs 按 timestamp ASC/rowid ASC；按 ID 取消息每批 400 且受 session 过滤，最终恢复入参键顺序（不能按字母序或时间二次排序）。
- history blocks 每批 400 message IDs，按 message_id/block_index 排序；首个缺 replay 列错误后，本次剩余批次都用不含 replay 的 SELECT。其他错误传播；不因非法 sidecar 列丢掉展示块，非法展示行 warn 后跳过。
- BlockReplayData 三列全 null 不收录；返回两个 Map：message→块数组、block→旁路。空输入不查库。公开 WithConn 方法保留调用者事务与日志。

## L03 compaction 仓储公开面（repo.rs:8309-8596）

- 已有仓储通过 chatSession 的 WithConn 方法公开 create/getActive/getById/list/setPointer/clearPointer/invalidate，调用者传入同一 F3 事务，可与摘要消息、旁路及换代标记原子提交。create 只 INSERT，不隐式修改 session 指针，不覆盖已有 cutoff。
- 补齐既有实现遗漏：updated_at 使用 F4 chrono RFC3339 AutoSi/+00:00；getActive 的跨会话指针 error、悬空指针 warn；invalidate 边界受影响时在 clear 成功之后 info。summary 直接删除分支不额外 info，维持 Rust。
- getActive 的 NULL 指针返回 null，仅空字符串回退最新记录；其他会话或 deleted 记录不返回。setPointer 先使旧摘要 inactive、再使新摘要 active、最后写 session 指针；失败留给调用者事务回滚。

## 旧变体仓储死代码审批记录（repo.rs:3755-4359，C1 已批准）

以下原申请已获 `migration/approvals.d/C1-app.json` 逐 ID 批准；7 条已更新 obsolete，原申请中的 pending 状态已解除。

全仓检索 `update_message_active_variant/update_message_variants/update_variant_status/add_block_to_variant/repair_message_variant_status/repair_session_variant_status/update_message_shared_context/delete_variant_v2/delete_variant_with_conn`（含 `_with_conn/_v2`）仅命中 repo.rs 内定义、同族包装和测试；当前 variant_handlers 使用独立实现，不调用这组仓储方法。按 quality.md §8 申请以下 7 条 obsolete:dead-in-rust，保持 TESTMAP pending：test_variant_crud、test_variant_status_update、test_delete_variant_cascade、test_delete_last_variant_deletes_message、test_add_block_to_variant、test_shared_context_update、test_repair_variant_status。`test_message_variant_helpers` 测的是现行 ChatMessage，不在申请内。已撤回本轮尚未运行/提交的草拟测试文件，没有删除任何既有测试，也不实现死代码。下面保留已审读的行为证据供协调者核实。

- active ID 更新不校验变体是否存在；整体 variants 更新同时设置 active ID，先按原 size limit 规则处理 JSON。两者零影响行均 MessageNotFound，前后各 debug。
- status/addBlock/delete/repair 的读改写在 IMMEDIATE 事务内；已有 TransactionScope 复用外层。缺 message 为 MessageNotFound，缺 variant 为 Other(`Variant not found: …`)；状态更新会清除 absent error；addBlock 去重追加并同事务写块 variant_id，块不存在不报错。
- 仓储 delete 与前端 delete 命令语义不同：最后一个变体删除整条 message（FK 级联）；否则 SAVEPOINT 中先按 variant_id 删块，仅影响零行时才按 blockIds 逐个尽力删。删除 active 后选 success→cancelled→首个，即使全部 error；未删 active 则原样保留。不更新 message.blockIds。保存点创建失败有独立错误前缀，rollback/release 的失败按 Rust 静默忽略。
- repair 仅 streaming/pending→error(`Process interrupted unexpectedly`)；无 message/无 variants/没有待修状态返回 false，不单独修已有无效 active。发生修复后才按上述优先级选 active。成功 info 在事务内，提交失败也保留已发日志。
- 无新时间/ID/事件。日志：active/variants/status/addBlock/sharedContext 的前后 debug；delete 前 debug、删块数量 debug、最后消息删除或 variantDeleted info；repair message/session 非零计数 info。

## 消息/块运行时构造（types.rs:1614-1656；dstu-core/agent.rs:362-445）

- message UUIDv4 前缀 msg_，user 保留给定 blockIds，assistant 默认空；时间为当前毫秒，可选字段省略。生成 ID 入口由统一用户消息构建器复用。
- block UUIDv4 前缀 blk_，初始 pending、未带 content/时间字段，后台 blockIndex 保留；content/thinking/tool 构造分别设置固定类型，toolName/input 原样。
- setRunning 每次覆盖 startedAt，setSuccess 每次覆盖 endedAt，setError 同时写 error 与 endedAt；不清除既有内容/错误。append 空串仍建立 content=""，但只在第一次非空 chunk 时设置 firstChunkAt，之后不刷新。
- service 提供构造与状态变更入口，api.ts 同时导出纯函数，供 L03 替换仅有结构类型的构造缺口。无 DB、事件或日志；前端块输出仍经已有 toWireBlock 隐藏 blockIndex。

## 用户消息统一构建（user_message_builder.rs:48-317）

- 默认参数 id/timestamp/context/execution snapshot 为 None，附件/canonical 为空；缺时间戳先 warn 原文，再取一次当前毫秒；显式 0 保留。消息 ID 缺失用 msg_UUIDv4；用户块 ID 为 blk_ucontent_ 加去掉所有连续 msg_ 前缀的消息 ID。
- 用户消息 role=user，仅一个 blockIds；块 type=content/status=success/blockIndex=0，started/ended/firstChunk 同 now_ms。无附件时省略 attachments，无 context/canonical/execution 时省略 _meta，Option 缺省按 serde skip。
- 附件 MIME 判断大小写敏感：image/audio/video 前缀优先；application/pdf、text 或包含 document/word/excel/spreadsheet 为 document，其余 other。size 保留 Rust 估算 `(base64 UTF-8 字节数*3)/4` 整数除法，不解码、不扣 padding，text-only 为 0；preview 优先 textContent（UTF-8 base64，即使空串），否则原 base64，均无则省略。id=att_UUIDv4/status=ready，忽略 input.metadata。
- 用户 context 只克隆 userRefs，丢 retrievalRefs/pathMap，userRefs 空则 None；canonical 非空与 execution 有值各自足以创建 _meta，不凭 canonical 推断模型快照。构建不写库，无事件或取消点。
- `chatSession.buildUserMessage` 与 api.ts 的构建/引用辅助提供 L03 原持久化流程使用；现有 createMessage/createBlock 可在调用方事务中保存，构建器不另造保存协议。

## 块重放旁路（repo.rs:2084-2293）

- BlockReplayData 三字段 llmContent/toolCallId/roundText 可空，全部 null 时 update 直接成功，不清旧值；非空时三列 targeted UPDATE，不修改展示正文。不存在的 block 更新仍成功。
- getReplayMap 只收录非空旁路行；缺列返回空 Map，malformed sidecar 行静默略过（Rust rows.flatten）。copy 使用 SQL 子查询复制三列；clear 仅清 llm_content；均只对 `no such column` 静默回退，其他 DB 错误传播。
- updateBlock 先记 Updating debug，单条 UPDATE 在 content 变化时清 llm_content，不变则保留；旧库缺列时重试不含失效表达式的 UPDATE；零影响行 BlockNotFound；成功后 Block updated debug。tool_call_id/round_text 不随正文修改失效。
- sidecar 写缺列有 debug `[ChatV2::Repo] Replay columns missing (V20260806 not applied), skipping sidecar write for block {id}`；read/copy/clear 缺列没有日志。无事务包装，由传入 SqlExecutor 的调用事务决定。
- chatSession 提供 `updateBlockReplayWithConn` 与 L03 已发布 ReplaySidecarWriter 相同签名，以及 getBlockReplayMap/copyBlockReplay/clearBlockLlmContent 的 WithConn 方法；服务逐次传入 Host logger，不在 L03 复制 SQL。

## Workspace 取消与睡眠命令（workspace_handlers.rs:306-377,583-599,643-677,2140-2246,2275-2330）

- L05 实际 coordinator 已实现 getTaskManager/getSleepManager/emitWarning/emitCoordinatorAwakened，但 api.ts 的 WorkspaceCoordinator 未列出。按跨 lane 规则在 L04 发布最小增补端口，生产仍经注入的 agentWorkspace 调用，不引用 L05 实现文件。
- close/delete 先检查 workspace 存在和 creator 身份；之后枚举 worker（排除 coordinator），取消其 stream；有 stream 或状态 running 才写 cancelled。updateAgentStatus 失败按 Rust `let _` 忽略，仍记 info。枚举失败 warn 后继续任务查询；任务管理器/任务枚举/每条任务状态写失败分别 warn 后继续，最后才 close/delete，最后一步错误传播，前面的取消不回滚。
- cancel_agent 先 member/creator 校验，再取消 stream、查该 agent 最新任务并尝试 cancelled(user cancelled)。查询/写任务失败仅 warn；返回 stream_cancelled||task_cancelled。为 true 才尽力写 agent cancelled 并 emitWarning(agent_cancelled)，字段缺省与原 emitter 一致。后端入口复用同一核心但不做访问校验。
- manual_wake/cancel_sleep 先 member/creator，再 getSleepManager；manager 获取失败原 Display；操作错误分别 `Failed to wake: {Debug}` / `Failed to cancel sleep: {Debug}`；成功操作后 info，manual 有结果才 emitCoordinatorAwakened。返回 snake_case sleep_id 与 success / bool；无 DB 直写或新 ID。
- 补充端口错误 Debug 按 L05 的 SleepError/SubagentTaskError 变体字段还原（Database/NotFound/AlreadyAwakened/InvalidTransition/Timeout/Cancelled），不把 Debug 改成 Display。

## 会话工具前缀与压缩锚点（repo.rs:2948-3374）

- frozen order 缺键/非数组读为空，只留字符串项；按快照首次出现顺序追加缺失项，旧项不删不重排；无新增不写库。metadata 非对象在确需写时转对象，其余键保留。
- tool face 三键读取：generation 无效回退 0、digest 非字符串回退 null、order 取 frozen order；三个来源都无效返回 null。advance 合并 order、generation 取最大值、传 null digest 保留旧值；三者不变则不写，保持 updated_at。
- microcompact 缺键/非对象/eligibleUserTurns 无效返回 null，lineage 非字符串按 null；相同锚点跳过写库，写时保留其他 metadata 与 updated_at。L03 的 advanceMicrocompactAnchor 负责 lineage 变化算法，L04 只存取。
- 公共 service 的 merge/freeze/advance/set 各用 IMMEDIATE 事务，读取与写入在同一事务；`WithConn` 版换代标记供 L03 在 compaction 事务内使用。现有 freeze 命令改走 service 的同一事务入口。
- available skills 有效 pending 必须大于当前 generation；没有有效 pending 时首次写胜出（空串也算已有），存在有效 pending 时覆盖一次、推进 generation、删 pending；标记换代只在已存在字符串快照时生效，多次标记折叠。上述函数没有日志/事件/时间采样/新 ID。

## 启动遗留块收尾（repo.rs:3428-3509；mod.rs:245-264）

- 启动先清理 user 消息重复 content 块，每 message 只留最大 rowid；不按 blockIndex，不改 message.blockIds。成功删除非零时 repo 与启动调用点各一条 info；失败 warn 后继续收尾。
- 收尾先把 running/pending 且 thinking/content 且 SQLite length(trim(content))>0 的块置 success，ended_at 依次保留 ended/first_chunk/started/当前毫秒；不清已有 error。再把其余 running/pending 置 error，保留旧 error/ended_at，没有则写固定重启错误与同一次采样的时间。
- 两次 UPDATE 不加事务；第二条失败不会撤销第一条。仅全部成功且总数>0 才输出 repo info（含总数、finished、interrupted）；外层任意异常以原 Display 记 warn 后继续插件启动。完成块不改变，二次运行幂等，无事件/新 ID/取消点。
- SQLite trim 只去普通空格，不改成 Rust/JS 全 Unicode trim：仅换行/制表符的正文也保持原 SQL 判为非空。

## Connector ledger 原测试闭合（connector_ledger.rs:29-543,586-983）

- main 已由 L07 发布 `agent-skills/api.ts:253-263` 的 connector ledger；L07 ConnectorToolExecutor 和 L03 completion-finalizer 已调用。L04 仅从此公开 API 验证所属 Rust 测试，不建立第二个表写入方。
- draft 插入保留可选 NULL 与原样时间字符串；幂等键为 sha256(operation_id UTF-8 拼接 preview_sha256 UTF-8)，查询按 session_id 隔离，list 按 created_at/operation_id 排序。
- 单条条件 UPDATE 驱动 draft→confirmed→submitting→committed/failed/outcome_unknown；confirmed 同时校验预览哈希，无自环；终态不可外向迁移；unknown 可经 lookup 到 committed/failed，不能重新 submitting。错误文案按各状态操作区分。
- 启动仅 submitting→outcome_unknown，返回变更条数，再次运行返回 0，不自动提交/重试；unknown note 写入 error，commit 清 error 并写 evidence/external ID，failed 保留已有其他字段。
- 会话副作用摘要单次 SELECT 后计算 total/pending；draft/confirmed 不算未决，submitting/unknown 算未决；无日志、事件、额外事务、时钟或 ID 生成。
- 公开 L07 实现仍需协调者回派对齐的细节：list/summary 的 prepare/parse 错误前缀与 Rust 不同，rowToOperation 对列类型采用 String/Number 强转（含 expiresAtMs 的 i64 精度）；本轮原测试没有覆盖这些异常，不据此宣称模块完整等价。

## AGENTS.md 指令读取（agents_md.rs:17-239）

- workspace/AGENTS.md 优先；缺失、空内容、越界或 IO 失败后尝试 `~/.deep-student/AGENTS.md`。resolve 仅检查普通文件，load 则读取并校验 canonical 路径，不混淆两者。
- 先检查逻辑路径是否存在，再 realpath 根和文件；文件名 ASCII 大小写不敏感等于 AGENTS.md，规范化路径必须是根本身或根的后代。不存在为 NotFound，规范化/根校验失败为 OutOfBounds，读取/UTF-8 错误为 Io。
- 先去 HTML 注释，再去 script 标签及内容（固定正则大小写不敏感、跨行、非贪婪；script 后按 Rust Unicode `\b` 判断），最后 Rust trim；按 Unicode 字符截 6000，超出追加 `…（已截断）`，后缀不计预算。
- 缓存按 canonical 路径 + mtime（纳秒）命中，mtime 查询失败按 None 比较；不以大小或内容哈希替换。同步文件操作与 Map 访问无 await，不引入 Rust Mutex 中毒在 JS 中不存在的模拟状态。
- workspace/global 加载成功各记 debug；越界各记 warn；IO 失败各记 debug；不存在和空内容静默，无 DB、事件、ID 或取消点。
- `api.ts` 发布 loader 与辅助函数，`chatSession.loadAgentsInstructions` 提供 Host logger 绑定的生产入口，供 L03 prompt builder 使用。
- Linux 验证：typecheck:host 通过；Node/Electron 均 34 文件、307 passed、2 个按 Rust 平台条件排除的原生 OCR 用例；importable 通过，wiring 为 179 ported / 0 未接入。strict 全仓仍失败，本 lane 无违规；ledger 全仓 250 个测试去向问题，非本轮新增的六个 AGENTS.md 测试。环境多次重启后的实现由 afecaa49a、8523e3723 自动检查点保存。

## 自动质量反馈整改：分支时间与可擦除语法

- Linux 续接：`dstu-llm/src/ocr_adapters/system_ocr/mod.rs:49-68` 只在 macOS/Windows 分发原生 OCR；其他平台返回 Unsupported，handler 记录首图 error 后包装 Llm 并停止。两条原生绑定测试按相同条件 `skipIf`，新增非支持平台的命令级错误、日志及停止断言。

- `manage_session.rs:1640-1684,2010-2059`：读取源会话、消息与块后，在 IMMEDIATE 事务内只采样一次当前时刻；新会话 createdAt/updatedAt 为 chrono serde UTC `Z`，metadata.branchedFrom.branchedAt 和复制会话状态 updatedAt 为 `to_rfc3339()` 的 `+00:00`，克隆 compaction.createdAt 为同一时刻的毫秒。全部经 F4 time.now/toRfc3339Opts，不再经过 Date.toISOString 的毫秒截断。
- 反馈中的生产 console 与本地 utf8ByteLength 已在此前提交替换为逐层传入的 ChatLogger、F4 util。保留原日志级别；本轮复核，不重复改写。
- 合并 main 的可擦除语法整改；新增代码继续使用显式字段声明与构造函数赋值，并以 `importable.mjs host/plugins/chat/index.ts` 验证 Node 原生类型擦除加载。

## 中断续接：workspace coordinator 命令行为清单

日志参数整改：仓储的 malformed row 跳过分支（repo.rs 的 log_and_skip_err 及 paged/history 查询）必须经调用方传入的 ChatLogger 输出原有 warn 后继续。移除进程级 repositoryLogger，防止两个 Host 实例互相覆盖 logger、卸载一个实例使另一个实例丢日志。命令、chatSession 服务及其下层 export/snapshot/branch/compaction 路径逐层透传 logger；测试可传记录器。

批量事件生命周期（events.rs:1294-1319,1888-1899）：计时器显式归 emitter.dispose 管理；仅在窗口计时器活跃时登记 emitter，计时器完成后移出，避免永久保留没有 chunk 的 emitter。插件卸载按 backendEvents 所属 Host 只 flush 本实例，防止卸载 A 提前冲刷 B；保留默认全量 dispose 入口供进程关闭使用。

F4 模块替换：Rust str::trim/trim_end 使用 util.rustTrim/rustTrimEnd（NEL 属空白，BOM 不属空白）；UTF-8 len 使用 utf8ByteLength；RFC3339 解析/AutoSi/SecondsFormat::Secs 输出使用 time 模块。流式 upsert 追加 block id 失败只 warn；以真实 SQLite BEFORE UPDATE 失败触发器验证 block 已持久化、消息 blockIds 未更新、命令仍成功且日志保留。

续接验证记录：本 lane `tests/` 精确目录（避免 `host/plugins/chat` 同时匹配 chat-pipeline/chatanki）Electron 33 文件 / 299 测试通过；typecheck:host 通过；strict 输出无 `host/plugins/chat/` 违规。命令注册 87/107，TESTMAP 为 173 ported / 354 pending，尚未完成的自有工作仍需继续，不能把此记录当作完成验收。

剩余 20 个未注册命令（均还有本 lane 实现工作，不以依赖说明代替迁移）：
`chat_v2_compact_session`、`chat_v2_continue_message`、`chat_v2_edit_and_resend`、`chat_v2_retry_message`、`chat_v2_retry_variant`、`chat_v2_retry_variants`、`chat_v2_send_message`、`chat_v2_stage_context_attachments`、`chat_v2_wake_session`、`workspace_cancel_agent`、`workspace_cancel_sleep`、`workspace_close`、`workspace_create_agent`、`workspace_delete`、`workspace_delete_agent_profile_file`、`workspace_manual_wake`、`workspace_read_agent_profile_file`、`workspace_restore_executions`、`workspace_run_agent`、`workspace_save_agent_profile_file`。

旧小节的“阻塞（未注册）”说明需以上述规则及 main 最新 api.ts 为准：agentWorkspace/agentApproval/chatPipeline/agentAutomation/agentSubagent 已发布服务并已用 ctx.inject 连接。getTaskManager/getSleepManager/runtimeRootById 等方法仍需对照公开 API；类内部存在不等于 api.ts 已发布。354 条 pending 的完整名称在 TESTMAP，纯类型、repo、executor 等自有项不能列成跨 lane 阻塞。

### chatSession.database 行为清单（database.rs:146-237,331-369）

- getConn/getConnSafe 每次检查 F3 维护屏障；维护时 Database 错误 `Database is in maintenance mode (backup/restore in progress)`，释放屏障后重新获取句柄，不能持有已关闭连接。
- isInMaintenanceMode 查询 F3 屏障，不缓存恒 false；dbPath 不打开连接；getSchemaVersion 获取连接失败传播，SQL 查询失败静默 0。
- getStatistics 先获取连接；四个 COUNT 独立失败静默 0，schema_version 固定 Rust CURRENT_SCHEMA_VERSION=20260910。此处没有 warn/info 日志（Rust unwrap_or(0)）。
- service 各 CRUD 方法沿用 repository 行为、逐次获取当前句柄；F3 负责 schema/foreign_keys/维护期间关闭和恢复，L04 不复制连接池或迁移系统。

### repo.rs #469 元数据与尾窗

- MessageMeta/VariantMeta 写入和旧行回读均去掉 skillContents；before/after 结构相等则移除 after，保留 before 供有效 after 回退。禁止用 HashMap 的 JSON 字符串做内容比较，改用结构相等（Node isDeepStrictEqual）；字段插入顺序不同仍相等。
- toolResults 有非空 blockId 时 input/output=null，重放签名、reasoningContent、toolCallId 等保留；没有块承载时保留输入输出。
- tail_limit 同时受默认 2 MiB 预算约束；复用 loadSessionTailWithBudget 供 Rust 同名测试注入 35000/1 小预算；至少两条，顺序 timestamp DESC/rowid DESC 选择再还原正序，块查询窗口一致。全量分支不返回 totalMessageCount，分页分支返回总数。
- 保留 Rust SQL LENGTH(TEXT) 按字符统计而非 UTF-8 字节的现有缺陷，不能改成 BLOB 长度；预算条数取决于持久化原文，不是回读瘦身后的对象。
- load_session_full 的五条 debug 与一条 info、tail 的一条 info 按 Rust 原位置记录时长与计数，malformed row warn 后跳过。

### variants_json 大小限制（repo.rs:159-161,233-303）

- 64 KiB 以下直接返回原字符串；64 KiB 到 256 KiB 仅 warn（包含 size/warn/limit/count/message_id），不改字符串或数组。
- >=256 KiB 先 error，再按数组顺序移除最旧变体，每次 warn id/model/message_id 后重新序列化，直到 UTF-8 字节数 <256 KiB 或只剩一个；不得按 JS UTF-16 length 判断。
- 单个变体超限时先 error exceeded，再 error cannot truncate，保留原数据；截到一个后仍超限 error still；重新序列化错误 error 并返回上次成功的字符串。create/update_message 在副本上执行，不能改调用方对象。

### permission preset 审批接线（manage_session.rs:2154-2179）

解析 preset 和 danger confirm 校验成功后，必须调用 L05 agentApproval.clearSessionRemembered(sessionId)，再读取/修改 session metadata。清理在 DB 写入之前，写库失败也不能恢复记忆；无效 preset/未确认 danger 不得清理。Rust 为必需 State 注入，Host 缺服务显式报 `ApprovalManager is not available`，不能静默略过；此 handler 本身无日志、事件、事务。

### Super 删除钩子时序（manage_session.rs:779-831,893-1078）

软删先校验 ID/stream/anki，再读取 Super 标记并软删，清 sequence，记录完成 info 后调用 onSessionRemoved(id,false)。硬删读取标记后删除，清 sequence，记录 info，再调用 onSessionRemoved(id,true)。清空回收站逐个复查状态，删除时清 sequence；全部 DB 删除结束才循环 Super 钩子。普通会话不调用钩子。L06 服务缺失而目标有 Super 标记时，Host 在修改该行前明确报不可用，避免静默漏掉自动重建。运行时目录/VFS 引用计数现已接入，补偿时序与测试见页首对应小节。

### C1 已批准的 Rust 死代码（审批文件已合入）

- `resource_repo.rs` 的 11 个测试：文件第 1-16 行明确 DEPRECATED、禁止新调用、暂无生产调用方；全仓 `ResourceRepo` 检索除本文件实现与测试仅命中旧注释及 VFS 日志文本，实际资源真源为 VfsResourceRepo。C1 已批准 `obsolete:dead-in-rust`。
- `repo.rs::test_soft_delete_group_is_the_only_group_flow_that_ungroups_sessions`：全仓 `soft_delete_group_with_conn` 只有 repo.rs:1080 定义和 :6137 测试调用；C1 已按 quality.md §8 批准，不给 TS 人为增加生产入口。

`repo.rs::test_soft_delete_group_is_the_only_group_flow_that_ungroups_sessions`：softDeleteGroup 虽已在可达的 repository/groups.ts 中实现，但没有实际生产调用，不计为 ported；现按 C1 审批计 obsolete。

Rust `handlers/workspace_handlers.rs:607-639,867-1069`，对应已注册的 create/get/list_agents/send_message/list_messages/set_context/get_context/list_documents/get_document/list_all。

- create 直接调用 coordinator.createWorkspace，不加 session 校验；返回 snake_case 的 workspace_id/name/status。
- get、list_agents、list_messages、get_context、list_documents、get_document 先 ensureMemberOrCreator，再查询；不存在的工作区/上下文/文档按各自 Option 返回 null。set_context/send_message 的权限检查由 coordinator 执行，handler 不额外检查。
- send_message：progress/result/query/correction/broadcast 之外默认 task；Some(target) + broadcast 在访问 coordinator 前返回原始字符串 `Broadcast message must not specify target_session_id`。is_broadcast 只取决于 target 是否 None。
- list_messages 缺省 limit=50，显式 0 原样传入；输出蛇形字段。所有 coordinator 错误原样 Display 成字符串，不转换为 ChatV2Error JSON。
- list_agents 调用 L05 AgentProfileResolver.fromMetadata（验证并归一化）；解析错误以 None 处理；每 agent 单独 pendingInboxCount，失败静默取 0（Rust unwrap_or(0)，无日志）。
- get/list_agents/list_messages/list_documents 时间以 chrono to_rfc3339 AutoSi/+00:00 输出，经 F4 time 模块转换；list_all 保留 DB 原始时间字符串。
- list_all 从 chat_v2.workspace_index 只读 active，按 created_at DESC；row 映射失败跳过。逐项 membership 为 false 则不返回，失败则记录 `[Workspace::handlers] Failed to check workspace membership: workspace_id={}, error={}` 并继续。连接、prepare、query 错误前缀分别为 `Failed to get connection: `、`Failed to prepare statement: `、`Failed to query workspaces: `。
- handler 无额外事件、事务、取消或 ID 生成；coordinator 的持久化和事件由 L05 负责。L05 已发布并 provide agentWorkspace，生产通过 ctx.inject + ctx.agentWorkspace 接入。

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 107 个 · 发出事件 8 种 · 契约：`contracts/ipc/L04-chat-session.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [ ] Option → null 还是缺省（`skip_serializing_if`）：
- [ ] u64/i64 超过 2^53 的表示：
- [ ] 字段顺序（serde_json preserve_order）：
- [ ] f32 精度：
- [ ] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：
- [ ] 取消：CancellationToken / drop → AbortSignal，取消点一致：
- [ ] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：
- [ ] 时间与 ID：生成方式、格式、时区：
- [ ] 不对含 HashMap 的结构做序列化后比对：

## 命令 `chat_v2_add_tag`

<!-- BEGIN GENERATED:cmd:chat_v2_add_tag -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:117` · async
- 前端：app（1 处，例 `src/features/chat/hooks/useSessionTags.ts:76`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, tag: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_add_tag -->

- [x] 输入：search_handlers.rs:117-128；sess_/agent_/subagent_ 前缀，trim 后非空，保存 trim 后 tag。
- [x] 输出：null。
- [x] 错误：Validation / Database 经 error.rs:164 JSON 字符串转换。
- [x] 事件：无。
- [x] DB 读写：repo.rs:4649；INSERT OR IGNORE manual tag。
- [x] 取消/并发：无取消点，单条同步写。
- [x] 时间/ID：SQLite datetime('now')；不生成 ID。

## 命令 `chat_v2_archive_group`

<!-- BEGIN GENERATED:cmd:chat_v2_archive_group -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:330` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：groupId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_archive_group -->

- [x] 输入：group_handlers.rs:311-320；groupId 原样使用，不先校验存在性。
- [x] 输出：null。
- [x] 错误：DB 失败 Database（组不存在不报错）。
- [x] 事件：无。
- [x] DB 读写：IMMEDIATE 事务；UPDATE 组 persist_status='archived' WHERE persist_status!='deleted'；把 group_id 匹配且 active 的会话置 archived，并在 metadata 写入 groupArchivedBy{groupId,archivedAt}，updated_at=now。
- [x] 取消/并发：单事务，失败整体回滚。
- [x] 时间/ID：now=Utc::now().to_rfc3339()，组与会话共用同一时间串。

## 命令 `chat_v2_archive_session`

<!-- BEGIN GENERATED:cmd:chat_v2_archive_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:522` · async
- 前端：app（3 处，例 `src/components/ModernSidebar.tsx:571`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_archive_session -->

- [x] 输入：manage_session.rs:523-560；sessionId 前缀 sess_/agent_/subagent_；活跃 Super 会话（metadata.super_agent.active=true）拒绝归档。
- [x] 输出：null。
- [x] 错误：前缀验证 Validation；SessionNotFound；Super 会话 `Validation error: Super-agent 会话不能归档。如需清空，请删除该会话（会自动新建一个空的 Super-agent 会话）。`
- [x] 事件：无。
- [x] DB 读写：读会话后写 chat_v2_sessions：metadata.manuallyArchivedBy.archivedAt=RFC3339，persist_status='archived'，updated_at=now；非对象 metadata 重置为对象。
- [x] 取消/并发：读-改-写无显式事务（Rust get_session_v2 + update_session_v2 两条语句）。
- [x] 时间/ID：archivedAt/updatedAt 均为 chrono Utc::now().to_rfc3339()。

## 命令 `chat_v2_ask_user_respond`

<!-- BEGIN GENERATED:cmd:chat_v2_ask_user_respond -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/ask_user_handlers.rs:44` · async
- 前端：app（2 处，例 `src/features/chat/components/input-bar/BlockingAskUserBar.tsx:138`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：toolCallId: string, selectedTexts: string[], selectedIndices: integer(i32)[], customText?: string | null, source: string
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:chat_v2_ask_user_respond -->

> **已注册**：等待器由本 lane `src/ask-user.ts` 持有（`registerAskUserCallback`），命令经 `respondToAskUser` 投递；无等待回调时按 Rust 记 warn 并返回 null。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_branch_session`

<!-- BEGIN GENERATED:cmd:chat_v2_branch_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:710` · async
- 前端：app（2 处，例 `src/features/chat/adapters/tauri/sessionCommands.ts:129`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sourceSessionId: string, upToMessageId: string
  - 结果：ChatSession · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:chat_v2_branch_session -->

- [x] 输入：manage_session.rs:710-759 + branch_session_in_db:1578-2059；sourceSessionId 必须以 sess_/agent_/subagent_ 开头，upToMessageId 必须在该会话消息中（按 timestamp ASC, rowid ASC），前缀之后复制到该消息（含）。
- [x] 输出：新 ChatSession（id 恒为 sess_ 前缀）：mode=`chat`、title=`{源标题} (branch)`（源标题为 None 则保持 null）、titleLocked=true、description/groupId 继承、metadata 整体克隆并写入 `branchedFrom:{sessionId,messageId,compactionId,branchedAt}`；若源是 Super 会话（metadata 含 super_agent）则删 super_agent 与 pinned。
- [x] 错误：前缀非法 `Validation error: Invalid source session_id format: …`；会话不存在 SessionNotFound；源 persist_status 非 active `Validation error: Source session is not active (status: Archived|Deleted|Active): …`；截止消息不存在 `Message not found: {id} (not found in session {sid})`；subagent 会话只读 Validation；事务失败 `Database error: Failed to commit branch transaction: …`；其余 DB 错误 Database。
- [x] 事件：无。
- [x] DB 读写：单个 IMMEDIATE 事务：读源会话/活跃压缩/消息/块；写新会话、按前缀复制消息（重映射 id/blockIds/parentId/supersedes/variants/activeVariantId/sharedContext.blockIds；_meta、attachments 原样）、块（blockIndex/type/status/content/toolName/toolInput/toolOutput/citations/error/时间戳；tool input/output 深拷贝并按 message+block id 映射重写）、SQL 级补拷 `llm_content/tool_call_id/round_text` 重放三列；活跃压缩摘要与 tail 都存活时克隆一条 reason=`branch` 的压缩记录并更新摘要块 tool_output（sessionId/compactionId/previous=null/reason/range/tailStart，删除 tokensBefore/tokensAfter/tailMessageCount）；复制 session_state（清 input/panel/pending，skill state 去 branch-local 且 version+1、legacyMigrated=false，回填 active/loaded id 列）。
- [x] 取消/并发：无取消令牌；整个复制在 BEGIN IMMEDIATE 事务内原子提交；不注册流占位。提交后经 L11 resources.incrementRef 批量补偿引用计数，保留重复引用和一次重试，失败日志后继续。
- [x] 时间/ID：新会话 created_at/updated_at=now RFC3339；branchedAt=now RFC3339；压缩 created_at=now 毫秒，tailStartTimeCreated 继承；消息 timestamp 继承；新 id 均为 UUIDv4（sess_/msg_/blk_/var_/cmp_）。

## 命令 `chat_v2_cancel_stream`

<!-- BEGIN GENERATED:cmd:chat_v2_cancel_stream -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:859` · async
- 前端：app（2 处，例 `src/features/chat/adapters/tauri/messageOperations.ts:80`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, messageId: string
  - 结果：null · 错误：string · 注入：window, state
<!-- END GENERATED:cmd:chat_v2_cancel_stream -->

- [x] 输入：send_message.rs:860-883；sessionId/messageId 原样使用，不校验前缀与存在性。
- [x] 输出：null（取消成功）。
- [x] 错误：无活跃流时 `Other error: No active stream to cancel`；取消成功不报错。
- [x] 事件：本命令不发事件；pipeline 的 Cancelled 分支统一发射 stream_cancelled。
- [x] DB 读写：无。
- [x] 取消/并发：只操作 ChatV2State 内存 token（cancel_stream 取走并 abort），并发取消仅一个返回成功。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_cancel_variant`

<!-- BEGIN GENERATED:cmd:chat_v2_cancel_variant -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:1085` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/variantOperations.ts:190`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, variantId: string
  - 结果：null · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:chat_v2_cancel_variant -->

- [x] 输入：variant_handlers.rs:1085-1123；不校验 session 前缀，也不做 ensure_session_writable；按 session 的全部消息扫描 variants 判断 variantId 归属。
- [x] 输出：null（即使没有活动取消令牌也成功）。
- [x] 错误：变体不属于该会话时 Validation `Variant {variantId} does not belong to session {sessionId}`；DB 失败 Database。
- [x] 事件：本命令不发事件；pipeline 取消分支负责 stream_cancelled。
- [x] DB 读写：只读 chat_v2_messages。
- [x] 取消/并发：调用 ChatV2State.cancel_stream(`{sessionId}:{variantId}`)，返回值被忽略；token 不存在也视为成功。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_check_migration_status`

<!-- BEGIN GENERATED:cmd:chat_v2_check_migration_status -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/migration.rs:18` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1200`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：MigrationCheckResult · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:chat_v2_check_migration_status -->

- [x] 输入：handlers/migration.rs:18-29；无参数，先取主库（mistakes）连接再取 chat_v2 连接。
- [x] 输出：MigrationCheckResult{needsMigration, pendingMessages, pendingSessions, migratedMessages, canRollback, lastMigrationAt}；表/列不存在时按缺省计数（全部 pending 或 0），`lastMigrationAt` 取 chat_v2 元数据 `$.migratedAt`（非整数/缺失为 null）。
- [x] 错误：主库连接失败映射 `Database error: …`；chat_v2 连接失败同 ChatV2Error Display；查询失败按 Rust `.unwrap_or(0/false/null)` 吞掉，不报错。
- [x] 事件：无。
- [x] DB 读写：只读主库 `sqlite_master`/`pragma_table_info`/`chat_messages`/`mistakes` 与 chat_v2 `chat_v2_sessions`（json_extract）。
- [x] 取消/并发：无事务；两组计数分别在不同库上读取，可能观察到跨库不一致（与 Rust 相同）。
- [x] 时间/ID：lastMigrationAt 为旧数据 `migratedAt` 毫秒整数；不生成 ID。

## 命令 `chat_v2_clear_approval_history`

<!-- BEGIN GENERATED:cmd:chat_v2_clear_approval_history -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:178` · async
- 前端：app（1 处，例 `src/features/settings/components/mcp-tools/useToolPermissions.tsx:355`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：integer(usize) · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:chat_v2_clear_approval_history -->

- [x] 输入：approval_handlers.rs:192-229；无参数。
- [x] 输出：u32 —— 被删除的 settings 行数（不含内存条目）。
- [x] 错误：settings 删除失败映射 Database JSON；L05 服务缺失时仍可清 DB。
- [x] 事件：无。
- [x] DB 读写：先清 ApprovalManager 内存 remembered（服务存在时），再 DELETE FROM settings WHERE key LIKE 'tool_approval.scope.%'；同时覆盖 v1/v2 两种键。
- [x] 取消/并发：内存与 DB 两步非原子；顺序固定（先内存后 DB）。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_compact_session`

<!-- BEGIN GENERATED:cmd:chat_v2_compact_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:56` · async
- 前端：app（1 处，例 `src/features/chat/components/input-bar/InputBarV2.tsx:1022`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, modelConfigId: string, contextLimit?: integer(u32) | null
  - 结果：CompactSessionResponse · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:chat_v2_compact_session -->

> **阻塞（未注册）**：L03 `chatPipeline` 的 `ChatPipelineService`（api.ts:172-）没有 compact/模型调用执行方法，只发布预算与摘要 helper。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_continue_message`

<!-- BEGIN GENERATED:cmd:chat_v2_continue_message -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:2010` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/messageOperations.ts:439`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, messageId: string, variantId?: string | null, options?: SendOptions | null
  - 结果：string · 错误：string · 注入：window, state, state, state, state, state
<!-- END GENERATED:cmd:chat_v2_continue_message -->

> **阻塞（未注册）**：L03 `chatPipeline` 的 `ChatPipelineService` 没有 send/retry/continue 执行方法；当前 api.ts 只发布 citation/authority/compaction 等 helper。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_copy_block_content`

<!-- BEGIN GENERATED:cmd:chat_v2_copy_block_content -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:258` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：blockId: string, format?: string | null
  - 结果：CopyBlockContentResponse · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_copy_block_content -->

- [x] 输入：block_actions.rs:258-292；blockId 须 blk_ 前缀；format 缺省 text，markdown 原样返回，json 输出 pretty JSON。
- [x] 输出：CopyBlockContentResponse{content, content_type}；json 分支含 id/type/status/content/toolName/toolInput/toolOutput/citations/error/startedAt/endedAt，None→null，2 空格缩进。
- [x] 错误：前缀 Validation；块不存在 BlockNotFound。
- [x] 事件：无。
- [x] DB 读写：只读 chat_v2_blocks。
- [x] 取消/并发：只读。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_count_sessions`

<!-- BEGIN GENERATED:cmd:chat_v2_count_sessions -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:641` · async
- 前端：app（3 处，例 `src/features/chat/pages/useSessionLifecycle.ts:65`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：status?: string | null, groupId?: string | null
  - 结果：integer(u32) · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_count_sessions -->

- [x] 输入：manage_session.rs:642；status/groupId 可空，空 groupId=未分组，*=已分组。
- [x] 输出：u32 number。
- [x] 错误：Database JSON 字符串。
- [x] 事件：无。
- [x] DB 读写：repo.rs:646；排除 agent、隐藏草稿、superagent 与隐藏 super_agent。
- [x] 取消/并发：无取消点，同步只读。
- [x] 时间/ID：无生成。

## 命令 `chat_v2_create_group`

<!-- BEGIN GENERATED:cmd:chat_v2_create_group -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:145` · async
- 前端：app（2 处，例 `src/features/chat/hooks/useGroupManagement.ts:49`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：request: CreateGroupRequest
  - 结果：SessionGroup · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:chat_v2_create_group -->

> **已注册**：创建/更新命令已接入 VFS 文件夹 provisioning。**待接线：agentWorkspace.runtimeRootById** —— L05 `agent-workspace/api.ts` 未导出 runtime-root 解析器、`index.ts` 也未 provide；非空 `defaultRuntimeRootId` 因此按 Rust 的不可解析分支报 Validation。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_create_session`

<!-- BEGIN GENERATED:cmd:chat_v2_create_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:329` · async
- 前端：app（3 处，例 `src/features/chat/adapters/tauri/sessionCommands.ts:80`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：mode: string, title?: string | null, metadata?: Value | null, groupId?: string | null
  - 结果：ChatSession · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_create_session -->

- [x] 输入：manage_session.rs:330-390；mode 只接受 chat/analysis/review/textbook/bridge/general_chat；title 显式传入即 title_locked=true；groupId trim 后空串视为 None，非空须存在且 persist_status=active（否则 GroupNotFound，删除/归档的组文案带 ` (inactive)`）。
- [x] 输出：新 ChatSession（id=`sess_{uuid}`，persistStatus=active，createdAt/updatedAt 同一时刻，metadata/groupId/title 按入参落库）。
- [x] 错误：String→JSON；非法 mode 为 `Validation error: Invalid session mode: {mode}. Valid modes: ["chat", …]`，组不存在为 GroupNotFound，DB 失败为 Database。
- [x] 事件：无。
- [x] DB 读写：写 chat_v2_sessions 一行（repository/sessions.createSession）；Rust 另调 ensure_session_runtime_roots，失败仅 warn，Host lane 暂无该服务、无可观察差异。
- [x] 取消/并发：单条 INSERT，无事务；并发创建由 SQLite 写锁串行化。
- [x] 时间/ID：uuid v4；chrono Utc::now() 的 RFC3339（UTC）。

## 命令 `chat_v2_delete_group`

<!-- BEGIN GENERATED:cmd:chat_v2_delete_group -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:285` · async
- 前端：app（1 处，例 `src/features/settings/components/data-governance/ChatSessionArchiveTab.tsx:210`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：groupId: string
  - 结果：null · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:chat_v2_delete_group -->

- [x] 输入：group_handlers.rs:271-308；groupId 原样使用。
- [x] 输出：null（永久删除组及其全部会话，消息/块/状态级联）。
- [x] 错误：组不存在 GroupNotFound；active 组 `Validation error: 请先归档课题，再从归档页永久删除。`；组内会话流式中 `Cannot delete topic while a session is streaming. …`；ChatAnki 运行中 `Cannot delete topic while ChatAnki generation is still running. …`；DB 失败 Database。
- [x] 事件：无。
- [x] DB 读写：读组与组内会话 ID（含 groupArchivedBy 遗留标记）；逐会话校验流/anki；VFS 引用递减属 VFS lane（Host 省略）；IMMEDIATE 事务内逐个硬删会话再删组。
- [x] 取消/并发：先全量校验再删除；无全局生命周期锁（Host 无进程级 mutex）。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_delete_message`

<!-- BEGIN GENERATED:cmd:chat_v2_delete_message -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:195` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/messageOperations.ts:243`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, messageId: string
  - 结果：null · 错误：string · 注入：state, state, state
<!-- END GENERATED:cmd:chat_v2_delete_message -->

- [x] 输入：block_actions.rs:176-247；先 ensure_session_writable；messageId 须 msg_ 前缀；不校验 session 前缀。
- [x] 输出：null。
- [x] 错误：流式中固定 `Cannot delete message while streaming. Please wait for completion or cancel first.`；前缀 Validation；会话不存在 SessionNotFound；消息不存在 MessageNotFound；跨会话 `Validation error: Message {messageId} does not belong to session {sessionId}`。
- [x] 事件：无。
- [x] DB 读写：读 session/message；事务内 invalidate_compaction_for_message + DELETE chat_v2_messages（块由 FK CASCADE）；之后按存活历史重建 session skill state（失败忽略）。VFS 引用递减属 VFS lane，失败仅 warn。
- [x] 取消/并发：事务串行；活跃流检查基于 ChatV2State 内存表。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_delete_session`

<!-- BEGIN GENERATED:cmd:chat_v2_delete_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:892` · async
- 前端：app（10 处，例 `src/components/ModernSidebar.tsx:601`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：null · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:chat_v2_delete_session -->

- [x] 输入：manage_session.rs:893-978；检查顺序：活跃流 → 运行中 anki 块 → sessionId 前缀 sess_/agent_/subagent_。
- [x] 输出：null（硬删除，消息/块/状态级联删除）。
- [x] 错误：流式中固定 `Cannot delete session while streaming. …`；anki 运行中固定长文案 `Cannot delete session while ChatAnki generation is still running. …`；前缀 Validation；会话不存在 SessionNotFound。
- [x] 事件：无 IPC 事件；Super 会话删除后调用 super_session::on_session_removed（属编排 lane）。
- [x] DB 读写：运行时根目录清理与 VFS 引用递减先于删除（Host 无对应服务）；DELETE chat_v2_sessions；清 SESSION_* 序列计数器。
- [x] 取消/并发：持全局 session_lifecycle_guard（Host 无进程级 mutex）。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_delete_variant`

<!-- BEGIN GENERATED:cmd:chat_v2_delete_variant -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:224` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/variantOperations.ts:53`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, messageId: string, variantId: string
  - 结果：DeleteVariantResult · 错误：string · 注入：state, window
<!-- END GENERATED:cmd:chat_v2_delete_variant -->

- [x] 输入：variant_handlers.rs:224-390；先过 ensure_session_writable；message 须存在且归属 sessionId；variants 为空视为 VariantNotFound；只剩 1 个变体时 VariantCannotDeleteLast。
- [x] 输出：DeleteVariantResult（camelCase）：deletedVariantId/remainingCount/newActiveVariantId（未删除激活变体时该字段为 null）。
- [x] 错误：MessageNotFound/VariantNotFound；最后一个 VariantCannotDeleteLast；变体 status='streaming' 时固定 `Cannot delete a streaming variant. Please wait for completion or cancel it first.`；DB 失败 Database。
- [x] 事件：写库后向 `chat_v2_session_{sessionId}` 发 `variant_deleted`，payload=eventType/messageId/variantId/remainingCount/newActiveVariantId；emit 失败仅 warn。
- [x] DB 读写：逐个 best-effort 删除变体块（失败仅 warn）；UPDATE chat_v2_messages（variants/active_variant_id/block_ids 去重）；必要时按 success>pending>streaming>cancelled→可激活→首个 选新激活变体并同步技能状态。
- [x] 取消/并发：读-改-写无显式事务；块删除失败不回滚。
- [x] 时间/ID：不生成 ID/时间；payload 中的 newActiveVariantId 可为 null。

## 命令 `chat_v2_edit_and_resend`

<!-- BEGIN GENERATED:cmd:chat_v2_edit_and_resend -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:1267` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/messageOperations.ts:361`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, messageId: string, newContent: string, newContextRefs?: SendContextRef[] | null, newPathMap?: object | null, options?: SendOptions | null
  - 结果：EditAndResendResult · 错误：string · 注入：window, state, state, state, state, state
<!-- END GENERATED:cmd:chat_v2_edit_and_resend -->

> **阻塞（未注册）**：L03 `chatPipeline` 的 `ChatPipelineService` 没有 send/retry/continue 执行方法；当前 api.ts 只发布 citation/authority/compaction 等 helper。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_emergency_stop`

<!-- BEGIN GENERATED:cmd:chat_v2_emergency_stop -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/kill_switch.rs:194` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：reason?: string | null
  - 结果：KillSwitchStatus · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_emergency_stop -->

- [x] 输入：kill_switch.rs:193-252；reason 可选，trim 后空串回退 `user_emergency_stop`。
- [x] 输出：KillSwitchStatus；仅当本次取消的流数量>0 时带 cancelledStreams 字段。
- [x] 错误：无（各联动步骤失败仅记录日志）。
- [x] 事件：向全局 `chat_v2://kill_switch_changed` 发完整 status（emit 失败仅 warn）；首次 trip 另发系统通知（受通知策略约束）。
- [x] DB 读写：无（workspace worker 状态落库属编排 lane，无 coordinator 时为 0）。
- [x] 取消/并发：trip 为原子置位；先 pause 自动化调度，再取消全部活跃流 token，再取消进行中的 automation run；重复调用返回 false 但仍重新执行取消。
- [x] 时间/ID：trippedAtMs 仅在从未 trip 或本次新 trip 时更新；不生成 ID。

## 命令 `chat_v2_empty_deleted_sessions`

<!-- BEGIN GENERATED:cmd:chat_v2_empty_deleted_sessions -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:979` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：integer(u32) · 错误：string · 注入：app-handle, state, state
<!-- END GENERATED:cmd:chat_v2_empty_deleted_sessions -->

- [x] 输入：manage_session.rs:980-1078；无参数。
- [x] 输出：u32 实际永久删除的会话数。
- [x] 错误：列表/复查/删除 DB 失败 Database；运行时根目录清理失败 IoError 会中止整批（Host 无对应服务）。
- [x] DB 读写：列出 persist_status='deleted' ID；VFS 引用批量递减（其它 lane）；锁内逐个复查仍为 deleted 才 DELETE chat_v2_sessions，并清序列计数器。
- [x] 取消/并发：分两段持生命周期锁；锁外被恢复的会话跳过，新软删的留待下次。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_export_session`

<!-- BEGIN GENERATED:cmd:chat_v2_export_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/export_handlers.rs:56` · async
- 前端：app（1 处，例 `src/features/chat/api/sessionBrowserApi.ts:36`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, format?: string | null, includeThinking?: boolean | null
  - 结果：ExportSessionResponse · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_export_session -->

- [x] 输入：export_handlers.rs:56-127；sessionId 仅拒绝空/全空白（不校验前缀）；format 缺省 markdown，仅接受 markdown/json；includeThinking 缺省 false（仅影响 markdown）。
- [x] 输出：ExportSessionResponse（camelCase）{sessionId, format, content, messageCount}。json 时 content 为 {session,messages,blocks,exportedAt} 的 2 空格 pretty JSON；markdown 按标题/描述/元信息/逐消息逐块渲染。
- [x] 错误：空 ID 固定 Validation；非法 format `Invalid export format '{format}'. Valid formats: markdown, json`；会话不存在 SessionNotFound；序列化失败 Serialization。
- [x] 事件：无。
- [x] DB 读写：只读 chat_v2_sessions / chat_v2_messages / chat_v2_blocks；时间戳用会话行原值。
- [x] 取消/并发：只读。
- [x] 时间/ID：exportedAt=chrono Utc::now().to_rfc3339()（含 +00:00）；不生成 ID。

## 命令 `chat_v2_export_session_jsonl`

<!-- BEGIN GENERATED:cmd:chat_v2_export_session_jsonl -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/export_handlers.rs:130` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, targetPath: string, options?: SessionExportOptions | null
  - 结果：SessionExportSummary · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_export_session_jsonl -->

- [x] 输入：export_handlers.rs:130-174；sessionId 仅拒绝空/全空白；targetPath 小写后须以 .jsonl 结尾；options 缺省=全变体/含状态/含压缩/脱敏。
- [x] 输出：SessionExportSummary（与 footer 一致）：sessionId/schemaVersion=1/messageCount/blockCount/compactionCount/bytesWritten/truncated=false。文件按 JSONL 规范写 header (message block*)* compaction* footer，每行一个 JSON + LF。
- [x] 错误：空 ID Validation；路径后缀错误 `Invalid export path '{path}': expected a .jsonl file`；文件创建/写入失败 IoError `{path}: {os error}`；会话不存在 SessionNotFound（不写任何行）。
- [x] 事件：无。
- [x] DB 读写：只读会话/消息/块/会话状态/压缩记录；块按 block_index 升序逐消息加载；缺块跳过并 warn。
- [x] 取消/并发：全量读取后一次写文件；无事务。
- [x] 时间/ID：header.exportedAt=chrono SecondsFormat::Secs（UTC Z）；generator.version=应用版本；不生成 ID。

## 命令 `chat_v2_export_session_messages`

<!-- BEGIN GENERATED:cmd:chat_v2_export_session_messages -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:116` · async
- 前端：app（1 处，例 `src/features/chat/api/sessionBrowserApi.ts:90`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, offset: integer(usize), limit?: integer(usize) | null
  - 结果：ExportMessagesChunk · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_export_session_messages -->

- [x] 输入：snapshot_handlers.rs:116-154；offset 为消息下标，limit 缺省 100 且最小 1；offset 超出时 start 截到总数。
- [x] 输出：ExportMessagesChunk{messages, blocks, nextOffset}；blocks 覆盖本页每条消息的全部块（含各变体），nextOffset 仅在还有后续消息时出现。
- [x] 错误：DB 失败 Database（字符串）；不校验 session 是否存在，空会话返回空页。
- [x] 事件：无。
- [x] DB 读写：按 timestamp ASC,rowid ASC 读全部消息后切片，再逐消息读块。
- [x] 取消/并发：只读。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_export_session_meta`

<!-- BEGIN GENERATED:cmd:chat_v2_export_session_meta -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:82` · async
- 前端：app（1 处，例 `src/features/chat/api/sessionBrowserApi.ts:86`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：ExportSessionMeta · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_export_session_meta -->

- [x] 输入：snapshot_handlers.rs:82-114；sessionId 原样使用，不校验前缀。
- [x] 输出：ExportSessionMeta（camelCase）{format='deepstudent-conversation-snapshot', version=1, exportedAt, appVersion, session, sessionState|null, messageCount, pageSize=100}。
- [x] 错误：会话不存在 SessionNotFound；DB 失败 Database。
- [x] 事件：无。
- [x] DB 读写：只读 chat_v2_sessions、chat_v2_session_state、chat_v2_messages（仅计数）。
- [x] 取消/并发：只读。
- [x] 时间/ID：exportedAt=Utc::now().to_rfc3339()（+00:00）；appVersion=应用版本。

## 命令 `chat_v2_freeze_available_skills_snapshot`

<!-- BEGIN GENERATED:cmd:chat_v2_freeze_available_skills_snapshot -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:488` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/availableSkillsSnapshot.ts:144`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, snapshot: string
  - 结果：string · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_freeze_available_skills_snapshot -->

- [x] 输入：manage_session.rs:488-514；sessionId 前缀须 sess_/agent_/subagent_；snapshot 原样写入（允许空串）。
- [x] 输出：实际生效的快照字符串。
- [x] 错误：前缀 Validation；会话不存在 SessionNotFound；DB 失败 Database。
- [x] 事件：无。
- [x] DB 读写：读会话 metadata；已有 availableSkillsSnapshot 且无更高 pendingGeneration 时 first-write-wins 直接返回旧值；否则写 snapshot，若 pending 大于当前 generation 则 generation:=pending 并删除 pending 键。
- [x] 取消/并发：无显式事务；多窗口竞争时以持久化先写者为准。
- [x] 时间/ID：不更新 updated_at；只用 metadata 键。

## 命令 `chat_v2_get_anki_cards_from_block_by_document_id`

<!-- BEGIN GENERATED:cmd:chat_v2_get_anki_cards_from_block_by_document_id -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:552` · async
- 前端：app（1 处，例 `src/features/anki-tasks/components/SessionRow.tsx:176`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：documentId: string
  - 结果：AnkiCard[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_get_anki_cards_from_block_by_document_id -->

- [x] 输入：block_actions.rs:552-630；documentId 先 trim，空串报 Validation；作为 LIKE 预过滤（转义 \\ % _）后仍做 JSON 精确匹配。
- [x] 输出：AnkiCard[]（snake_case 字段，serde 默认补齐）；按块 rowid DESC 找第一条 documentId 精确匹配的 anki_cards 块，返回其 cards。无命中返回 []。
- [x] 错误：空 documentId 固定 `Validation error: documentId is required`；DB 查询失败 Database；单行/单卡解析失败跳过，不报错。
- [x] 事件：无。
- [x] DB 读写：只读 chat_v2_blocks 中 block_type='anki_cards' 且 tool_output_json 非空的行。
- [x] 取消/并发：只读。
- [x] 时间/ID：缺失 id/created_at/updated_at 的卡片按 serde 默认补 uuid/当前 RFC3339（仅畸形数据路径）。

## 命令 `chat_v2_get_emit_failure_count`

<!-- BEGIN GENERATED:cmd:chat_v2_get_emit_failure_count -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:827` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：integer(u64) · 错误：string
<!-- END GENERATED:cmd:chat_v2_get_emit_failure_count -->

- [x] 输入：events.rs:826-830；无参数，读取进程级 `AtomicU64`（`Ordering::Relaxed`）。
- [x] 输出：u64 累计 `window.emit` 失败次数（events.rs:819-821）；成功重试不计，重试仍失败才 +1（events.rs:944-947）。
- [x] 错误：始终 `Ok(u64)`，不会返回 Err（events.rs:828-830）。
- [x] 事件：无。
- [x] DB 读写：无；仅静态计数器（events.rs:816）。
- [x] 取消/并发：原子读；计数为进程级、跨会话累计，重启归零（events.rs:824-826）。
- [x] 时间/ID：不生成时间与 ID。

## 命令 `chat_v2_get_group`

<!-- BEGIN GENERATED:cmd:chat_v2_get_group -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:368` · async
- 前端：app（1 处，例 `src/features/chat/core/store/restoreActions.ts:1086`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：groupId: string
  - 结果：SessionGroup | null · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:chat_v2_get_group -->

- [x] 输入：group_handlers.rs:347-374；groupId 原样查询。
- [x] 输出：SessionGroup|null；仅 persist_status=active 时确保课题根文件夹存在（缺失则创建，标题冲突则加 ` (n)` 后缀并重命名旧根），pinnedResourceIds 变化时以 now 更新 updated_at 并落库。
- [x] 错误：VFS/DB 失败映射 Database（VFS Display 前缀 `Database error: `）；组不存在返回 null。
- [x] 事件：无。
- [x] DB 读写：读 chat_v2_session_groups；必要时 UPDATE 该行；读写 VFS folders（创建/改名 + 清 folder_items.cached_path 与 path_cache）。
- [x] 取消/并发：读-改-写无显式事务；文件夹标题唯一性检查与插入非原子（与 Rust 相同）。
- [x] 时间/ID：新文件夹 id=`fld_`+10 位 nanoid；创建时间毫秒；改名时 updated_at=now_ms；组 updated_at=Utc::now().to_rfc3339()。

## 命令 `chat_v2_get_message_summary`

<!-- BEGIN GENERATED:cmd:chat_v2_get_message_summary -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:1109` · async
- 前端：app（1 处，例 `src/hooks/useChatV2Stats.ts:215`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：MessageSummary · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_get_message_summary -->

- [x] 输入：manage_session.rs:1110-1136；无参数。
- [x] 输出：MessageSummary，字段为 snake_case：total_messages/user_messages/assistant_messages（结构体无 rename_all）。
- [x] 错误：DB 失败→`Database error: Failed to summarize messages: {e}`。
- [x] 事件：无。
- [x] DB 读写：一条聚合查询扫 chat_v2_messages（全表）。
- [x] 取消/并发：只读。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_get_rag_scope`

<!-- BEGIN GENERATED:cmd:chat_v2_get_rag_scope -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2980` · async
- 前端：app（1 处，例 `src/features/chat/kbScope/kbScope.ts:28`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：string[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_get_rag_scope -->

- [x] 输入：manage_session.rs:2981-2988；sessionId 原样使用，不校验。
- [x] 输出：string[]；行不存在/JSON 损坏/读取失败一律 []。
- [x] 错误：始终 Ok（unwrap_or_default），不返回 Err。
- [x] 事件：无。
- [x] DB 读写：只读 chat_v2_session_state.rag_library_ids_json；过滤空白 id，空列表按 [] 返回。
- [x] 取消/并发：只读。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_get_session`

<!-- BEGIN GENERATED:cmd:chat_v2_get_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:413` · async
- 前端：app（4 处，例 `src/features/chat/pages/ensureActiveChatSession.ts:58`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：ChatSession | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_get_session -->

- [x] 输入：manage_session.rs:414；sess_/agent_/subagent_，错误文案使用 session_id。
- [x] 输出：ChatSession 或 null；Option None 字段省略，tags 未加载。
- [x] 错误：Validation / Database JSON 字符串。
- [x] 事件：无。
- [x] DB 读写：repo.rs:397-481；按 id 查询，无状态/可见性过滤。
- [x] 取消/并发：无取消点，同步只读。
- [x] 时间/ID：UTC RFC3339，非法时间回退 epoch；不生成 ID。

## 命令 `chat_v2_get_session_tags`

<!-- BEGIN GENERATED:cmd:chat_v2_get_session_tags -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:96` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：string[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_get_session_tags -->

- [x] 输入：search_handlers.rs:96；校验 sess_/agent_/subagent_ 前缀。
- [x] 输出：string[]，无标签为空数组。
- [x] 错误：Validation / Database JSON 字符串。
- [x] 事件：无。
- [x] DB 读写：repo.rs:4667；按 tag_type ASC, created_at ASC，坏行跳过。
- [x] 取消/并发：无取消点，同步只读。
- [x] 时间/ID：无生成。

## 命令 `chat_v2_get_tags_batch`

<!-- BEGIN GENERATED:cmd:chat_v2_get_tags_batch -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:107` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionIds: string[]
  - 结果：object · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_get_tags_batch -->

- [x] 输入：search_handlers.rs:108；sessionIds 不校验前缀。
- [x] 输出：HashMap 对象，仅有标签的会话入结果；空输入返回 {}。
- [x] 错误：Database JSON 字符串。
- [x] 事件：无。
- [x] DB 读写：repo.rs:4681；每批 500，按 tag_type/created_at 升序；跨批重复 ID 保留原追加语义。
- [x] 取消/并发：无取消点，同步只读。
- [x] 时间/ID：无生成，不对 HashMap 序列化比较。

## 命令 `chat_v2_goal_clear`

<!-- BEGIN GENERATED:cmd:chat_v2_goal_clear -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:231` · async
- 前端：app（1 处，例 `src/features/chat/core/store/sessionActions.ts:528`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：null · 错误：string · 注入：state, window
<!-- END GENERATED:cmd:chat_v2_goal_clear -->

- [x] 输入：goal_handlers.rs:230-246；sessionId 不校验前缀；先过 ensure_session_writable。
- [x] 输出：null；目标不存在时静默成功。
- [x] 错误：子代理会话 Validation；DB 失败 Database；无目标不报错。
- [x] 事件：删除后固定向 `chat_v2_session_{sessionId}` 发 `goal_updated` 且 goal=null；再取消内存 continuation。
- [x] DB 读写：DELETE FROM chat_v2_goals WHERE session_id=?1。
- [x] 取消/并发：单条 DELETE；continuation 取消属运行时服务。
- [x] 时间/ID：不生成时间与 ID。

## 命令 `chat_v2_goal_edit`

<!-- BEGIN GENERATED:cmd:chat_v2_goal_edit -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:174` · async
- 前端：app（1 处，例 `src/features/chat/core/store/sessionActions.ts:517`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, objective: string, tokenBudget?: integer(i64) | null
  - 结果：GoalRecord · 错误：string · 注入：state, window
<!-- END GENERATED:cmd:chat_v2_goal_edit -->

- [x] 输入：goal_handlers.rs:175；先检查子代理只读，再 trim objective、校验非空与正 tokenBudget。
- [x] 输出：camelCase GoalRecord，tokenBudget null 始终保留。
- [x] 错误：原 Validation 文案（无目标、已完成、并发修改）；Database JSON 字符串。
- [x] 事件：更新后 chat_v2_session_{id}，{eventType:'goal_updated',sessionId,goal}。
- [x] DB 读写：repo.rs:8713；按 session_id 更新 objective/token_budget，不改 status。
- [x] 取消/并发：无取消点；原实现不以 goal_id 做本次更新 CAS。
- [x] 时间/ID：updated_at_ms=当前毫秒；不生成 ID。

## 命令 `chat_v2_goal_get`

<!-- BEGIN GENERATED:cmd:chat_v2_goal_get -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:75` · async
- 前端：app（1 处，例 `src/features/chat/core/store/sessionActions.ts:492`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：GoalRecord | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_goal_get -->

- [x] 输入：goal_handlers.rs:76；不校验前缀或可写性。
- [x] 输出：camelCase GoalRecord 或 null。
- [x] 错误：Database JSON 字符串。
- [x] 事件：无。
- [x] DB 读写：repo.rs:8635；按 session_id 读取 chat_v2_goals。
- [x] 取消/并发：无取消点，同步只读。
- [x] 时间/ID：原样读毫秒数，不生成。

## 命令 `chat_v2_goal_pause`

<!-- BEGIN GENERATED:cmd:chat_v2_goal_pause -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:85` · async
- 前端：app（1 处，例 `src/features/chat/core/store/sessionActions.ts:503`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：GoalRecord · 错误：string · 注入：state, window
<!-- END GENERATED:cmd:chat_v2_goal_pause -->

- [x] 输入：goal_handlers.rs:85-121；sessionId 不校验前缀；先过 ensure_session_writable（mode=subagent 或 metadata.is_subagent=true 时 Validation `Subagent sessions are read-only; use the workspace runtime to communicate with them.`）。
- [x] 输出：GoalRecord；仅 active/waiting_user 迁到 paused，其余状态原样返回。
- [x] 错误：无目标 `Validation error: cannot pause goal because this session has no goal`；并发改目标 `Validation error: goal was modified concurrently; please retry`；DB 失败 Database。
- [x] 事件：仅真正发生状态迁移后向 `chat_v2_session_{sessionId}` 发 `goal_updated`（payload 含 sessionId/goal）；无操作不发。另取消内存中的 goal continuation。
- [x] DB 读写：读 chat_v2_goals；UPDATE status='paused', updated_at_ms=now_ms（WHERE session_id+goal_id）。
- [x] 取消/并发：乐观并发（expected goal_id）；continuation 取消属运行时服务，Host lane 无该调度器。
- [x] 时间/ID：updated_at_ms=Utc::now().timestamp_millis()；goal_id 不变。

## 命令 `chat_v2_goal_resume`

<!-- BEGIN GENERATED:cmd:chat_v2_goal_resume -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:126` · async
- 前端：app（1 处，例 `src/features/chat/core/store/sessionActions.ts:510`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：GoalRecord · 错误：string · 注入：state, window, app-handle
<!-- END GENERATED:cmd:chat_v2_goal_resume -->

- [x] 输入：goal_handlers.rs:126-181；sessionId 不校验前缀；先过 ensure_session_writable。
- [x] 输出：GoalRecord；仅 paused/blocked/budget_limited/usage_limited 迁到 active，其余状态原样返回。
- [x] 错误：无目标 `Validation error: cannot resume goal because this session has no goal`；并发 `goal was modified concurrently; please retry`。
- [x] 事件：仅真正迁移后发 `goal_updated`；随后在连接归还后 spawn 空闲续跑（属自动化 lane，Host 未实现，无可观察 wire 差异）。
- [x] DB 读写：读 chat_v2_goals；UPDATE status='active', updated_at_ms=now_ms。
- [x] 取消/并发：乐观并发；连接在触发续跑前释放。
- [x] 时间/ID：updated_at_ms=now_ms；不生成新 ID。

## 命令 `chat_v2_has_active_stream`

<!-- BEGIN GENERATED:cmd:chat_v2_has_active_stream -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:890` · sync
- 前端：app（3 处，例 `src/features/chat/adapters/tauri/sendOperations.ts:52`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：boolean · 注入：state
<!-- END GENERATED:cmd:chat_v2_has_active_stream -->

- [x] 输入：send_message.rs:890-895；直接读取有状态 `ChatV2State`，不做校验、不 trim（`sess_` 前缀等规则不适用）。
- [x] 输出：boolean，等于 `state.has_active_stream(session_id)`（send_message.rs:894）；流注册即 true，`cancel_stream`/`remove_stream`/guard drop 后 false。
- [x] 错误：同步命令，不产生错误（send_message.rs:891-895 无 Result）。
- [x] 事件：无。
- [x] DB 读写：无；仅内存 HashMap（state.rs:333-342）。
- [x] 取消/并发：读锁内查 map，与 `register_stream`/`try_register_stream_owned` 互斥；同一 sessionId 有流时为 true。
- [x] 时间/ID：不生成时间与 ID。

## 命令 `chat_v2_import_session`

<!-- BEGIN GENERATED:cmd:chat_v2_import_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/snapshot_handlers.rs:189` · async
- 前端：app（1 处，例 `src/features/chat/api/sessionBrowserApi.ts:94`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：snapshotJson: string
  - 结果：ImportSessionResult · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_import_session -->

- [x] 输入：snapshot_handlers.rs:187-491；snapshotJson 为完整快照，UTF-8 字节数上限 50 MiB；format 必须为 deepstudent-conversation-snapshot、version=1。
- [x] 输出：ImportSessionResult{sessionId, messageCount, blockCount, warnings}；会话/消息/块/变体 ID 全部重新生成，标题追加 ` (imported)`，titleLocked=true，persistStatus=active，createdAt 保留、updatedAt=now。
- [x] 错误：超限 `Snapshot exceeds maximum size of 52428800 bytes`；JSON 解析失败/格式/版本错误均为 Validation；事务提交失败 `Failed to commit import transaction: …`；孤儿块与 VFS 引用只产生 warnings。
- [x] 事件：无。
- [x] DB 读写：IMMEDIATE 事务写 chat_v2_sessions → messages → blocks → session_state；metadata 插入 importedFrom{sourceSessionId,importedAt}；state 裁剪 inputValue/panelStates/pendingContextRefsJson。
- [x] 取消/并发：单事务，失败整体回滚；分组/标签不迁移。
- [x] 时间/ID：new ID 前缀 sess_/msg_/blk_/var_ + uuid v4；importedAt/updatedAt=Utc::now().to_rfc3339()。

## 命令 `chat_v2_kill_switch_status`

<!-- BEGIN GENERATED:cmd:chat_v2_kill_switch_status -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/kill_switch.rs:290` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：KillSwitchStatus · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_kill_switch_status -->

- [x] 输入：kill_switch.rs:290-295；无参数。
- [x] 输出：KillSwitchStatus{tripped, killSwitchTripped, trippedAtMs|null, reason|null, automationsPaused}；cancelledStreams 仅在 emergency_stop 且>0 时出现。
- [x] 错误：无（内存快照，不失败）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：只读内存原子/互斥量；automationsPaused 取自 L06 调度器暂停标志。
- [x] 时间/ID：trippedAtMs 为 trip 时的 Unix 毫秒；不生成 ID。

## 命令 `chat_v2_list_agent_sessions`

<!-- BEGIN GENERATED:cmd:chat_v2_list_agent_sessions -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:671` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：workspaceId?: string | null, limit?: integer(u32) | null
  - 结果：ChatSession[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_list_agent_sessions -->

- [x] 输入：manage_session.rs:673-709；workspaceId 可选（metadata.workspace_id 精确匹配），limit 缺省 50。
- [x] 输出：ChatSession[]，mode='agent' 且 persist_status='active'，updated_at DESC。
- [x] 错误：DB 失败→Database JSON。
- [x] 事件：无。
- [x] DB 读写：只读 chat_v2_sessions（两条固定 SQL 分支）。
- [x] 取消/并发：只读，无锁。
- [x] 时间/ID：不生成时间与 ID。

## 命令 `chat_v2_list_all_tags`

<!-- BEGIN GENERATED:cmd:chat_v2_list_all_tags -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:147` · async
- 前端：app（1 处，例 `src/features/chat/hooks/useSessionTags.ts:44`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：?[][] · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_list_all_tags -->

- [x] 输入：无参数，search_handlers.rs:148。
- [x] 输出：[string,number][]。
- [x] 错误：Database JSON 字符串。
- [x] 事件：无。
- [x] DB 读写：repo.rs:4720；仅 active 会话，COUNT DESC、tag ASC，无隐藏过滤。
- [x] 取消/并发：无取消点，同步只读。
- [x] 时间/ID：无生成。

## 命令 `chat_v2_list_groups`

<!-- BEGIN GENERATED:cmd:chat_v2_list_groups -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:398` · async
- 前端：app（5 处，例 `src/features/chat/hooks/useGroupManagement.ts:35`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：status?: string | null, workspaceId?: string | null
  - 结果：SessionGroup[] · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:chat_v2_list_groups -->

- [x] 输入：group_handlers.rs:377-405；status/workspaceId 均可空，原样作为过滤条件。
- [x] 输出：SessionGroup[]，按 sort_order ASC, updated_at DESC；active 组逐个确保根文件夹并在 pinned 变化时落库（不更新 updated_at）。
- [x] 错误：DB/VFS 失败 Database。
- [x] 事件：无。
- [x] DB 读写：读 chat_v2_session_groups；active 组必要时 UPDATE pinned_resource_ids_json；读写 VFS folders。
- [x] 取消/并发：逐组读-改-写；中途失败即中断，已处理组保持已写入状态。
- [x] 时间/ID：同 get_group（新建文件夹 id/毫秒时间）；已存在行只改 pinned 列。

## 命令 `chat_v2_list_sessions`

<!-- BEGIN GENERATED:cmd:chat_v2_list_sessions -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:597` · async
- 前端：app（8 处，例 `src/features/chat/hooks/useSessionManagement.ts:131`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：status?: string | null, groupId?: string | null, limit?: integer(u32) | null, offset?: integer(u32) | null
  - 结果：ChatSession[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_list_sessions -->

- [x] 输入：manage_session.rs:598；limit 默认 50（无上限），offset 默认 0；status 无默认过滤。
- [x] 输出：ChatSession[]；None 字段省略，tags 未加载。
- [x] 错误：Database JSON 字符串；映射坏行告警后跳过。
- [x] 事件：无。
- [x] DB 读写：repo.rs:583；agent/隐藏会话过滤，空 groupId/星号语义与 count 一致；updated_at DESC。
- [x] 取消/并发：无取消点，同步只读。
- [x] 时间/ID：UTC RFC3339，非法时间 epoch；不生成 ID。

## 命令 `chat_v2_list_sessions_referencing`

<!-- BEGIN GENERATED:cmd:chat_v2_list_sessions_referencing -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2938` · async
- 前端：app（1 处，例 `src/features/pdf/components/PdfRelatedPanel.tsx:29`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sourceIds: string[], limit?: integer(u32) | null
  - 结果：SessionReferencingResource[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_list_sessions_referencing -->

- [x] 输入：manage_session.rs:2938-2952；sourceIds 逐个 trim 后丢弃空串；limit 缺省 20 并 clamp 到 1..=100。
- [x] 输出：SessionReferencingResource[]（sessionId/title/messageId/lastReferencedAt），按最后引用时间降序，每会话只保留最新命中。
- [x] 错误：DB 失败 Database JSON。
- [x] 事件：无。
- [x] DB 读写：逐 sourceId 扫 chat_v2_messages(meta_json/attachments_json) 与 blocks(citations_json/content) 的 LIKE 命中（含 `"{id}"` 与 `[PDF@{id}:`），只保留 persist_status='active' 的会话。
- [x] 取消/并发：只读；sourceIds 顺序不影响结果（按时间排序）。
- [x] 时间/ID：不生成；lastReferencedAt 取消息 timestamp。

## 命令 `chat_v2_load_messages_page`

<!-- BEGIN GENERATED:cmd:chat_v2_load_messages_page -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/load_messages_page.rs:32` · async
- 前端：app（2 处，例 `src/features/chat/adapters/tauri/historyLoading.ts:217`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, offset?: integer(u32) | null, limit?: integer(u32) | null
  - 结果：LoadMessagesPageResponse · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_load_messages_page -->

- [x] 输入：load_messages_page.rs:32-82；仅拒绝空/全空白 sessionId；offset 缺省 0，limit 缺省 100 并 clamp 到 1..=500。
- [x] 输出：LoadMessagesPageResponse{messages,blocks,totalMessageCount,offset,limit[,nextOffset]}；nextOffset 仅当本页非空且 offset+len<total 时出现；blocks 不含 blockIndex。
- [x] 错误：空 ID 固定 Validation 文案；DB 失败 Database。
- [x] 事件：无。
- [x] DB 读写：COUNT + 按 timestamp ASC,rowid ASC 分页取消息与对应块；role 过滤固定 NULL。
- [x] 取消/并发：只读。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_load_session`

<!-- BEGIN GENERATED:cmd:chat_v2_load_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/load_session.rs:37` · async
- 前端：app（6 处，例 `src/demo/desktopHistory.ts:11`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, tailLimit?: integer(u32) | null
  - 结果：LoadSessionResponse · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_load_session -->

- [x] 输入：load_session.rs:37-90；仅拒绝空/全空白 sessionId（不校验前缀）；tailLimit>0 走尾窗，否则全量。
- [x] 输出：LoadSessionResponse{session,messages,blocks[,state][,totalMessageCount]}；尾窗只在截断时带 totalMessageCount；blocks 不含后端 blockIndex。
- [x] 错误：空 ID 固定 `Validation error: Invalid session ID: empty or whitespace-only`；会话不存在 SessionNotFound；DB 失败 Database。
- [x] 事件：无。
- [x] DB 读写：读 session/messages/blocks/session_state；尾窗预算 2 MiB、至少保留 2 条；若持久化 authorityMode≠craft，则调用 set_session_authority_mode(craft) 并把返回的会话替换进响应。
- [x] 取消/并发：只读 + 可能的单会话 UPDATE；无锁。
- [x] 时间/ID：authority 归一化时 updatedAt=Utc::now()。

## 命令 `chat_v2_migrate_legacy_chat`

<!-- BEGIN GENERATED:cmd:chat_v2_migrate_legacy_chat -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/migration.rs:35` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1208`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：MigrationReport · 错误：string · 注入：window, state, state
<!-- END GENERATED:cmd:chat_v2_migrate_legacy_chat -->

- [x] 输入：handlers/migration.rs:35-47 + legacy_migration.rs:94-238；无参数；逐条读取 `chat_messages WHERE migrated_to_v2 = 0 OR IS NULL ORDER BY mistake_id, timestamp`（列不存在时读全表）。
- [x] 输出：MigrationReport{status, sessionsCreated, messagesMigrated, blocksCreated, attachmentsCreated(恒 0), messagesSkipped(恒 0), errors, startedAt, endedAt, durationMs}；按 mistake_id 分组，每组 `sess_`/`msg_`/`blk_` UUIDv4，mode=`analysis`，标题优先级 chat_metadata.title（跳过 `新对话`）→ ocr_text → user_question → 首条 user 消息，均取首行 trim 后 50 码点截断加 `...`，兜底 `对话（迁移）`。
- [x] 错误：单组失败回滚该组事务并写入 `errors`（`会话 {id} 迁移失败: Database error: …`），继续其余组，整体仍 `completed`；`BEGIN IMMEDIATE`/`COMMIT` 失败使整体 `failed` 但仍以 Ok(report) 返回；命令仅在取连接失败时 reject。事务回滚不会回退已累加的 sessionsCreated/messagesMigrated 计数（Rust 缺陷，保留）。
- [x] 事件：`chat_v2_migration` 通道发 started/progress/completed/failed；progress 在每次步骤/消息前后发送（分组事件早于 totalSessions 赋值），payload 为 `{eventType, progress, message}` camelCase；emit 失败仅 warn。
- [x] DB 读写：读主库 mistakes/chat_messages；chat_v2 内每组独立 IMMEDIATE 事务写 sessions（metadata `{mistakeId,migratedFrom:'chat_messages',migratedAt}`）、messages（meta 含 migratedFrom/legacyId/legacyMetadata，attachments 由 image_paths/image_base64/doc_attachments 构造）、thinking/content/rag/memory/web_search/graph/mcp_tool 块并回填 block_ids_json；提交后逐条 UPDATE 主库 `migrated_to_v2=1, migrated_session_id`，必要时 ALTER 添加两列（失败忽略），标记失败仅 warn。
- [x] 取消/并发：无取消令牌；迁移期间持有 chat_v2 写事务，逐组提交；旧库标记在提交后写，失败重试可能重复迁移（Rust 注释承认）。
- [x] 时间/ID：会话 created_at/updated_at 为 chrono RFC3339（DB 存 `+00:00`），migratedAt 为毫秒；消息 timestamp 解析失败回退 0；块 started_at/ended_at 为 now 毫秒；ID 均为 UUIDv4。

## 命令 `chat_v2_move_session_to_group`

<!-- BEGIN GENERATED:cmd:chat_v2_move_session_to_group -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:438` · async
- 前端：app（2 处，例 `src/components/ModernSidebar.tsx:648`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, groupId?: string | null
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_move_session_to_group -->

- [x] 输入：group_handlers.rs:437-470；groupId trim 后空串视为 null；非空须存在且 persist_status=active（否则 GroupNotFound，文案不含 ` (inactive)`）。
- [x] 输出：null。
- [x] 错误：组不存在/非活跃 GroupNotFound；DB 失败 Database；不校验 sessionId 前缀，会话不存在也不报错。
- [x] 事件：无。
- [x] DB 读写：先读 chat_v2_session_groups 校验，再 UPDATE chat_v2_sessions SET group_id, updated_at。
- [x] 取消/并发：两条语句无显式事务。
- [x] 时间/ID：updated_at=Utc::now() RFC3339。

## 命令 `chat_v2_perform_ocr`

<!-- BEGIN GENERATED:cmd:chat_v2_perform_ocr -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/ocr.rs:44` · async
- 前端：app（2 处，例 `src/features/chat/plugins/modes/analysis.ts:160`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：request: OcrRequest
  - 结果：OcrResponse · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_perform_ocr -->

行为清单（handlers/ocr.rs:45-177）：先 info images_count，空数组 Validation `At least one image is required`。取得 L02 当前 adapter；native 分支 info Using system native OCR engine，逐图严格 STANDARD base64 解码、调用 L01 published performSystemOcr，非空文本之间加两个换行，不 trim。云分支先 adapter.buildPrompt(free_ocr)，逐图解码后重新 STANDARD 编码；data URL 按第一个逗号后的段（忽略后续逗号段），MIME 只识别原始前缀 png/gif/webp/bmp/heic/heif，其他一律 jpeg；raw prompt 结果按 Rust trim。

解码失败 Validation `Failed to parse image {index}: Invalid data URL format` 或 `Failed to parse image {index}: Base64 decode error: {base64::DecodeError Display}`，使用 F4 decodeBase64Standard 保留库文案。native 失败先 error `System OCR failed for image {index}: {e}` 再 Llm `System OCR failed: {e}`；云失败 error `OCR failed: {e}` 再 Llm `OCR failed: {e}`。成功 info text_len 使用 UTF-8 字节数，tags_count=0/type=""，返回蛇形 `{ocr_text,tags:[],mistake_type:""}`。无文件、DB、事务、事件或 ID 副作用。

待接线（真实依赖）：L02 `llm.getOcrAdapter/callOcrModelRawPrompt` 尚未在 api.ts 发布，L04 定义最小 OcrManager 接口并经 ctx.inject(['llm']) 读取真实服务，缺能力明确报不可用；native 分支通过 L01 API，F7 `SystemOcrNativeBinding.performSystemOcr` 仍缺提供方。L04 分支实现与命令注册照常完成，测试仅替换外部 LLM/native 能力。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_plan_gate_respond`

<!-- BEGIN GENERATED:cmd:chat_v2_plan_gate_respond -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2185` · async
- 前端：app（1 处，例 `src/features/chat/components/PlanGateCard.tsx:71`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, planId: string, toolCallId: string, approved: boolean, reason?: string | null
  - 结果：null · 错误：string
<!-- END GENERATED:cmd:chat_v2_plan_gate_respond -->

- [x] 输入：manage_session.rs:2185-2218；sessionId/planId/toolCallId/approved/reason 原样转交 L03 `chatPipeline` 的 planGateManager.respond；不做空值或归属校验。
- [x] 输出：null；命中等待中的 plan gate 即投递响应并 resolve 等待方。
- [x] 错误：无匹配（或 planId 与挂起请求不一致）`Tool execution timeout: plan_gate_expired: no waiting plan gate for tool_call_id={id}`（Timeout，消息保留 plan_gate_expired 字面量供旧调用方匹配）；L03 服务缺失时 `Other error: PlanGateManager is not available`（TS 宿主扩展，Rust 为全局单例恒可用）。
- [x] 事件：无。
- [x] DB 读写：无。
- [x] 取消/并发：投递是同步 Map 查找+删除；planId 不匹配时不消费挂起项；确认投递后等待方收到 approved/reason（reason 缺省则 omitted）。
- [x] 时间/ID：不生成时间戳/ID。

## 命令 `chat_v2_remove_tag`

<!-- BEGIN GENERATED:cmd:chat_v2_remove_tag -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:132` · async
- 前端：app（1 处，例 `src/features/chat/hooks/useSessionTags.ts:93`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, tag: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_remove_tag -->

- [x] 输入：search_handlers.rs:133；前缀及 trim 非空检查，删除传原始未 trim tag。
- [x] 输出：null，包括无匹配行。
- [x] 错误：Validation / Database JSON 字符串。
- [x] 事件：无。
- [x] DB 读写：repo.rs:4658；session_id/tag 精确匹配 DELETE。
- [x] 取消/并发：无取消点，单条同步写。
- [x] 时间/ID：无生成。

## 命令 `chat_v2_reorder_groups`

<!-- BEGIN GENERATED:cmd:chat_v2_reorder_groups -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:427` · async
- 前端：app（2 处，例 `src/components/ModernSidebar.tsx:826`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：groupIds: string[]
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_reorder_groups -->

- [x] 输入：group_handlers.rs:426-436；groupIds 按传入顺序使用，不校验存在性。
- [x] 输出：null。
- [x] 错误：DB 失败 Database JSON。
- [x] 事件：无。
- [x] DB 读写：IMMEDIATE 事务内逐条 UPDATE chat_v2_session_groups SET sort_order=idx, updated_at=now；空数组开/提交空事务。
- [x] 取消/并发：单事务，失败整体回滚。
- [x] 时间/ID：每条 updated_at=Utc::now() RFC3339；sort_order=下标（i32）。

## 命令 `chat_v2_restore_group`

<!-- BEGIN GENERATED:cmd:chat_v2_restore_group -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:341` · async
- 前端：app（1 处，例 `src/features/settings/components/data-governance/ChatSessionArchiveTab.tsx:171`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：groupId: string
  - 结果：SessionGroup · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:chat_v2_restore_group -->

- [x] 输入：group_handlers.rs:323-345；groupId 原样使用。
- [x] 输出：恢复后的 SessionGroup（含确保过的 pinnedResourceIds）。
- [x] 错误：组不存在 GroupNotFound；DB/VFS 失败 Database。
- [x] 事件：无。
- [x] DB 读写：IMMEDIATE 事务恢复 archived 组；恢复 archived 会话：group_id 匹配时若 marker 指向本组则恢复（无 marker 且非手动归档也恢复），group_id 被清但 marker 指向本组则重新挂回；移除 groupArchivedBy，persist_status='active'，updated_at=now；随后确保根文件夹并在 pinned 变化时 UPDATE 组。
- [x] 取消/并发：事务后独立做 VFS/组写入；两步之间无锁。
- [x] 时间/ID：会话 updated_at=事务开始时间；新文件夹 time/id 同 get_group。

## 命令 `chat_v2_restore_session`

<!-- BEGIN GENERATED:cmd:chat_v2_restore_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:845` · async
- 前端：app（1 处，例 `src/features/settings/components/data-governance/ChatSessionArchiveTab.tsx:157`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：ChatSession · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_restore_session -->

- [x] 输入：manage_session.rs:846-890；sessionId 前缀 sess_/agent_/subagent_。
- [x] 输出：恢复后的 ChatSession（persistStatus=active，updatedAt=now）。
- [x] 错误：前缀 Validation；SessionNotFound；组不存在/已删除 GroupNotFound；组已归档为固定 Validation 文案；组校验失败不写库。
- [x] 事件：无。
- [x] DB 读写：读会话；对象 metadata 删除 manuallyArchivedBy/groupArchivedBy；若另有活跃 Super 则把 super_agent 退役为 {active:false,retired_at} 并删 pinned；写回 chat_v2_sessions。
- [x] 取消/并发：持有全局 session_lifecycle_guard（Rust 进程级 mutex，Host 无对应对象）；读-改-写无 SQL 事务。
- [x] 时间/ID：updatedAt/retired_at 为 Utc::now() RFC3339（+00:00）。

## 命令 `chat_v2_resume_agents`

<!-- BEGIN GENERATED:cmd:chat_v2_resume_agents -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/kill_switch.rs:255` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：KillSwitchStatus · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_resume_agents -->

- [x] 输入：kill_switch.rs:254-269；无参数。
- [x] 输出：KillSwitchStatus（tripped=false，trippedAtMs/reason=null）。
- [x] 错误：无。
- [x] 事件：向 `chat_v2://kill_switch_changed` 发复位后的 status。
- [x] DB 读写：无。
- [x] 取消/并发：只复位 Kill Switch，故意不恢复自动化调度（需再调 resume_automations）。
- [x] 时间/ID：清除 trippedAtMs；不生成 ID。

## 命令 `chat_v2_resume_automations`

<!-- BEGIN GENERATED:cmd:chat_v2_resume_automations -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/kill_switch.rs:272` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：KillSwitchStatus · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_resume_automations -->

- [x] 输入：kill_switch.rs:271-289；无参数。
- [x] 输出：KillSwitchStatus（automationsPaused=false）。
- [x] 错误：Kill Switch 仍 tripped 时返回**非 JSON 原始字符串** `Cannot resume automations while AgentKillSwitch is still tripped. Call chat_v2_resume_agents first.`。
- [x] 事件：恢复后向 `chat_v2://kill_switch_changed` 发 status。
- [x] DB 读写：无。
- [x] 取消/并发：先检查 trip 状态再恢复 L06 调度器；不影响流 token。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_retry_message`

<!-- BEGIN GENERATED:cmd:chat_v2_retry_message -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:918` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/messageOperations.ts:149`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, messageId: string, options?: SendOptions | null
  - 结果：RetryMessageResult · 错误：string · 注入：window, state, state, state, state, state
<!-- END GENERATED:cmd:chat_v2_retry_message -->

> **阻塞（未注册）**：L03 `chatPipeline` 的 `ChatPipelineService` 没有 send/retry/continue 执行方法；当前 api.ts 只发布 citation/authority/compaction 等 helper。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_retry_variant`

<!-- BEGIN GENERATED:cmd:chat_v2_retry_variant -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:401` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/variantOperations.ts:116`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, messageId: string, variantId: string, modelOverride?: string | null, options?: SendOptions | null
  - 结果：null · 错误：string · 注入：state, state, state, state, state, window
<!-- END GENERATED:cmd:chat_v2_retry_variant -->

> **阻塞（未注册）**：L03 `chatPipeline` 的 `ChatPipelineService` 没有 send/retry/continue 执行方法；当前 api.ts 只发布 citation/authority/compaction 等 helper。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_retry_variants`

<!-- BEGIN GENERATED:cmd:chat_v2_retry_variants -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:446` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/variantOperations.ts:165`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, messageId: string, variantIds: string[], options?: SendOptions | null
  - 结果：null · 错误：string · 注入：state, state, state, state, state, window
<!-- END GENERATED:cmd:chat_v2_retry_variants -->

> **阻塞（未注册）**：L03 `chatPipeline` 的 `ChatPipelineService` 没有 send/retry/continue 执行方法；当前 api.ts 只发布 citation/authority/compaction 等 helper。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_rollback_migration`

<!-- BEGIN GENERATED:cmd:chat_v2_rollback_migration -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/migration.rs:52` · async
- 前端：app（1 处，例 `src/api/dataGovernance.ts:1216`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：MigrationReport · 错误：string · 注入：window, state, state
<!-- END GENERATED:cmd:chat_v2_rollback_migration -->

- [x] 输入：handlers/migration.rs:52-64 + legacy_migration.rs:936-1022；无参数。
- [x] 输出：MigrationReport{status:'rolled_back', sessionsCreated=删除会话数, messagesMigrated=重置标记行数, 其余计数 0, errors=删除失败列表, startedAt/endedAt/durationMs}。
- [x] 错误：先重置旧表标记，失败即 reject `Database error: 重置迁移标记失败: …` 且不删除新数据；删除单个会话失败只记入 errors 并继续；命令仅在取连接失败时 reject。
- [x] 事件：`chat_v2_migration` 通道发 rollback_started（默认 progress）与 rollback_completed（progress.status=rolled_back，message=`回滚完成，删除 N 个会话，重置 M 条消息`）；emit 失败仅 warn。
- [x] DB 读写：查 chat_v2 中 `metadata_json.$.migratedFrom='chat_messages'` 的会话 ID；主库 `UPDATE chat_messages SET migrated_to_v2=0, migrated_session_id=NULL WHERE migrated_to_v2=1`；逐个 DELETE 会话（级联消息/块）。
- [x] 取消/并发：无事务包裹；先重置标记后删除，任一步中断可重试（删除失败不阻断其他会话）。
- [x] 时间/ID：startedAt/endedAt 为毫秒；不生成 ID。

## 命令 `chat_v2_save_session`

<!-- BEGIN GENERATED:cmd:chat_v2_save_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:562` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/sessionCommands.ts:60`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, sessionState: SessionState__De
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_save_session -->

- [x] 输入：manage_session.rs:563-595；不校验 sessionId 前缀；session_state 按 SessionState 反序列化。
- [x] 输出：null。
- [x] 错误：会话不存在 SessionNotFound（JSON）；序列化/DB 失败 Database/Serialization。
- [x] 事件：无。
- [x] DB 读写：读 chat_v2_sessions 验证存在 → load session_state → 合并 skill state（兼容 legacy active/loaded 字段，清 branch-local 并递增 version）→ UPSERT chat_v2_session_state。
- [x] 取消/并发：无显式事务；UPSERT 单语句。
- [x] 时间/ID：使用入参 SessionState.updatedAt，不重新生成。

## 命令 `chat_v2_search_content`

<!-- BEGIN GENERATED:cmd:chat_v2_search_content -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:30` · async
- 前端：app（2 处，例 `src/features/chat/hooks/useContentSearch.ts:55`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：query: string, limit?: integer(u32) | null, dateFrom?: string | null, dateTo?: string | null, sessionId?: string | null, includeArchived?: boolean | null
  - 结果：ContentSearchResult[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_search_content -->

- [x] 输入：search_handlers.rs:31；空 query 先返回；limit 默认 50 上限 200；非空 sessionId 前缀校验。
- [x] 输出：ContentSearchResult[]；snippet HTML 转义后恢复 mark。
- [x] 错误：Validation / Database JSON 字符串；坏行跳过并告警。
- [x] 事件：无。
- [x] DB 读写：repo.rs:4436；FTS token 加引号、bm25 排序；日期闭区间；默认 active，可含 archived，不过滤隐藏会话。
- [x] 取消/并发：无取消点，同步只读。
- [x] 时间/ID：updatedAt 原样 SQL 字符串；不生成 ID。

## 命令 `chat_v2_search_sessions`

<!-- BEGIN GENERATED:cmd:chat_v2_search_sessions -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:71` · async
- 前端：app（1 处，例 `src/features/chat/api/sessionBrowserApi.ts:53`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：query: string, limit?: integer(u32) | null, includeArchived?: boolean | null
  - 结果：ChatSession[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_search_sessions -->

- [x] 输入：search_handlers.rs:72；空 query 先返回，limit 默认 50 上限 200。
- [x] 输出：ChatSession[]，Option None 省略。
- [x] 错误：Database JSON 字符串；坏行跳过并告警。
- [x] 事件：无。
- [x] DB 读写：repo.rs:4530；title/description/tag LIKE，转义反斜线、% 与 _；可见性过滤，updated_at DESC。
- [x] 取消/并发：无取消点，同步只读。
- [x] 时间/ID：UTC RFC3339，非法时间 epoch；不生成 ID。

## 命令 `chat_v2_send_message`

<!-- BEGIN GENERATED:cmd:chat_v2_send_message -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:461` · async
- 前端：app（3 处，例 `src/features/chat/adapters/tauri/sendOperations.ts:186`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：request: SendMessageRequest
  - 结果：string · 错误：string · 注入：window, state, state, state, state
<!-- END GENERATED:cmd:chat_v2_send_message -->

> **阻塞（未注册）**：L03 `chatPipeline` 的 `ChatPipelineService` 没有 send/retry/continue 执行方法；当前 api.ts 只发布 citation/authority/compaction 等 helper。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_session_message_count`

<!-- BEGIN GENERATED:cmd:chat_v2_session_message_count -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:1079` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：integer(u32) · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_session_message_count -->

- [x] 输入：manage_session.rs:1080-1106；sessionId 原样使用，不 trim、不校验前缀。
- [x] 输出：u32 消息总数（COUNT(*)）。
- [x] 错误：DB 失败→`Database error: Failed to count messages for session {session_id}: {e}`。
- [x] 事件：无。
- [x] DB 读写：只读 chat_v2_messages。
- [x] 取消/并发：只读。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_set_authority_mode`

<!-- BEGIN GENERATED:cmd:chat_v2_set_authority_mode -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2127` · async
- 前端：app（1 处，例 `src/features/chat/core/store/sessionActions.ts:400`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, mode: string
  - 结果：ChatSession · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_set_authority_mode -->

- [x] 输入：manage_session.rs:2128-2152；mode 解析前 trim+小写，仅 ask/plan/craft；不校验会话 ID 前缀。
- [x] 输出：更新后的 ChatSession。
- [x] 错误：非法 mode→`Validation error: Invalid authority mode '{mode}'. Valid modes: ask, plan, craft`；会话不存在 SessionNotFound。
- [x] 事件：无。
- [x] DB 读写：读会话→SessionAuthorityState::from_metadata→写 authorityMode/authority_mode/permissionPreset/permission_preset 四键，非 plan 时删除 plan→写回。
- [x] 取消/并发：读-改-写无显式事务。
- [x] 时间/ID：updatedAt=Utc::now() RFC3339。

## 命令 `chat_v2_set_permission_preset`

<!-- BEGIN GENERATED:cmd:chat_v2_set_permission_preset -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2153` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, preset: string, confirm?: boolean | null
  - 结果：ChatSession · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:chat_v2_set_permission_preset -->

- [x] 输入：manage_session.rs:2154-2184；preset trim+小写，仅 cautious/relaxed/full_access/danger_full_access；danger_full_access 必须 confirm=true。
- [x] 输出：更新后的 ChatSession。
- [x] 错误：非法 preset 固定 Validation 文案；缺少确认固定 `Enabling danger_full_access requires the explicit danger confirmation (confirm=true).`；会话不存在 SessionNotFound。
- [x] 事件：无。
- [x] DB 读写：读会话→写入 permissionPreset/permission_preset（authorityMode 保持）→写回；Rust 另调 ApprovalManager.clear_session_remembered，Host lane 无该服务，无 wire 结果差异。
- [x] 取消/并发：读-改-写无显式事务；失败关闭（未确认不落库）。
- [x] 时间/ID：updatedAt=Utc::now() RFC3339。

## 命令 `chat_v2_set_rag_scope`

<!-- BEGIN GENERATED:cmd:chat_v2_set_rag_scope -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:2988` · async
- 前端：app（1 处，例 `src/features/chat/kbScope/kbScope.ts:37`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, folderIds: string[]
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_set_rag_scope -->

- [x] 输入：manage_session.rs:2990-3021；folderIds 逐个 trim 后丢弃空串；无会话 ID 前缀校验。
- [x] 输出：null。
- [x] 错误：仅 FK 失败映射为纯字符串 `会话尚未保存，请先发送一条消息后再设置检索范围`（非 JSON）；其它 DB 错误原样字符串。
- [x] 事件：无。
- [x] DB 读写：UPSERT chat_v2_session_state(rag_library_ids_json, updated_at)；空列表写 NULL；冲突分支只更新 rag_library_ids_json（不更新 updated_at）。
- [x] 取消/并发：单条 UPSERT。
- [x] 时间/ID：插入时 updated_at=Utc::now().to_rfc3339()。

## 命令 `chat_v2_soft_delete_session`

<!-- BEGIN GENERATED:cmd:chat_v2_soft_delete_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:771` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：null · 错误：string · 注入：app-handle, state, state
<!-- END GENERATED:cmd:chat_v2_soft_delete_session -->

- [x] 输入：manage_session.rs:770-844；sessionId 前缀须 sess_/agent_/subagent_；先查 ChatV2State 活跃流。
- [x] 输出：null，会话 persistStatus='deleted'。
- [x] 错误：前缀 Validation；流式中 `Other error: Cannot delete session while streaming. Please wait for completion or cancel first.`；会话有 pending/running anki_cards 块时固定长文案 `Cannot delete session while ChatAnki generation is still running. …`；会话不存在 SessionNotFound。
- [x] 事件：无 IPC 事件；Super 会话软删时调用 super_session::on_session_removed（取消 Worker/关工作区/必要时自动新建），该钩子属编排 lane，Host 只记录标记。
- [x] DB 读写：读会话→写 chat_v2_sessions（persist_status='deleted', updated_at=now）；清 SESSION_* 事件序列计数器。
- [x] 取消/并发：持全局 session_lifecycle_guard（Host 无对应进程级 mutex）；流式/anki 检查在读改写前。
- [x] 时间/ID：updatedAt=Utc::now() RFC3339。

## 命令 `chat_v2_stage_context_attachments`

<!-- BEGIN GENERATED:cmd:chat_v2_stage_context_attachments -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/tools/attachment_stage_executor.rs:1848` · async
- 前端：app（1 处，例 `src/features/chat/adapters/attachmentMaterialization.ts:161`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, items: AutoStageContextAttachmentInput[]
  - 结果：AutoStageContextAttachmentsResult · 错误：string · 注入：app-handle, state
<!-- END GENERATED:cmd:chat_v2_stage_context_attachments -->

> **阻塞（未注册）**：需 VFS 附件/语料 staging API（`vfs` 当前只发布 `database`/`dstu`）；`tools/attachment_stage_executor.rs` 的 29 个测试仍 pending。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_switch_variant`

<!-- BEGIN GENERATED:cmd:chat_v2_switch_variant -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:153` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/variantOperations.ts:25`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, messageId: string, variantId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_switch_variant -->

- [x] 输入：variant_handlers.rs:153-219；先过 ensure_session_writable（子代理会话只读）；messageId 须存在且 message.session_id==sessionId，否则 Validation `Permission denied: cannot switch variant for message in another session`；variantId 须在该消息 variants 中。
- [x] 输出：null。
- [x] 错误：MessageNotFound；VariantNotFound；目标变体 status='error' 时 VariantCannotActivateFailed（`Cannot activate failed variant: …`）；DB 失败 Database。
- [x] 事件：无。
- [x] DB 读写：读 chat_v2_messages；写回 active_variant_id（整行 serialize）；若变体 meta 有 skillSnapshotAfter/skillSnapshotBefore，best-effort 更新 chat_v2_session_state 的技能状态列（失败被忽略）。
- [x] 取消/并发：读-改-写无显式事务；技能状态同步失败不影响成功返回。
- [x] 时间/ID：不生成 ID；技能状态 version=快照 version+1，session_state.updated_at=now。

## 命令 `chat_v2_tool_approval_cancel`

<!-- BEGIN GENERATED:cmd:chat_v2_tool_approval_cancel -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:153` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：toolCallId: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_tool_approval_cancel -->

- [x] 输入：approval_handlers.rs:174-190；toolCallId 原样传给 ApprovalManager.cancel。
- [x] 输出：null（即使没有挂起审批也成功）。
- [x] 错误：L05 服务缺失时 Other；正常取消不报错。
- [x] 事件：无（取消决策由 manager 直接送达等待方）。
- [x] DB 读写：无。
- [x] 取消/并发：按 tool_call_id 跨会话移除挂起审批并向等待方发送取消决策。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_tool_approval_respond`

<!-- BEGIN GENERATED:cmd:chat_v2_tool_approval_respond -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/approval_handlers.rs:39` · async
- 前端：app（2 处，例 `src/features/chat/components/ToolApprovalCard.tsx:189`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, toolCallId: string, toolName: string, approved: boolean, reason?: string | null, remember: boolean, rememberSession?: boolean | null, arguments?: Value | null
  - 结果：null · 错误：string · 注入：state, state, window
<!-- END GENERATED:cmd:chat_v2_tool_approval_respond -->

- [x] 输入：approval_handlers.rs:39-172；toolCallId trim 后空串先报错；rememberSession 缺省 false；arguments 仅记录日志，绝不用于计算持久化键。
- [x] 输出：null（决策已送达等待中的 pipeline）。
- [x] 错误：空 tool_call_id `InvalidInput error: tool_call_id must not be empty`；无等待方时 Timeout JSON `approval_expired: no waiting approval for tool_call_id={id}`；L05 服务缺失时 Other。
- [x] 事件：无等待方时向 `chat_v2_event_{sessionId}` 发 `tool_approval_request` 的 error 事件（blockId=`approval_{tool_call_id}`，error=`approval_expired`，phase=error，带 sequenceId）；送达成功不发事件。
- [x] DB 读写：仅当 remember=true 且 manager 返回非空 settingKey 时写主库 settings：键由服务端 pending 参数生成，值为 allow/deny；写失败只记日志。
- [x] 取消/并发：决策经 ApprovalManager 的 pending 通道送达；服务端会对伪造 tool_name 降级 remember，并对权限类工具返回 null settingKey（fail-closed）。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_undo_compaction`

<!-- BEGIN GENERATED:cmd:chat_v2_undo_compaction -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:118` · async
- 前端：app（1 处，例 `src/features/chat/plugins/blocks/compactionSummary.tsx:130`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, compactionId: string
  - 结果：UndoCompactionResponse · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:chat_v2_undo_compaction -->

- [x] 输入：block_actions.rs:118-175；sessionId/compactionId 原样使用；先 ensure_session_writable（subagent 只读拒绝）。
- [x] 输出：UndoCompactionResponse{activeCompactionId}；解决上一压缩后返回其 id，无上一压缩返回 null。
- [x] 错误：会话流式中 `Other error: Cannot undo compaction while the session is streaming.`；无活跃压缩 `Validation error: No active context compaction`；id 非当前活跃 `Validation error: Only the active compaction can be undone`；DB 失败 Database。
- [x] 事件：无。
- [x] DB 读写：deferred 事务内读 `chat_v2_sessions.last_compaction_id`（空串指针回退最新压缩；指针缺失/跨会话视为无活跃）、按 id 取上一压缩（仅同会话有效）；写时把旧摘要块 tool_output.isActive 置 false、新指针摘要置 true（存在 compaction_summary 块时），并 UPDATE 会话 last_compaction_id/updated_at；无上一压缩则清空指针。
- [x] 取消/并发：注册 `{sessionId}` 独占流占位，冲突即拒绝；成功/失败均通过 StreamGuard 释放；事务 deferred，查-改-写原子。
- [x] 时间/ID：清空/设置指针时 updated_at=now（RFC3339）；不生成 ID。

## 命令 `chat_v2_update_block_content`

<!-- BEGIN GENERATED:cmd:chat_v2_update_block_content -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:441` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/sessionCommands.ts:150`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：blockId: string, content: string
  - 结果：null · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:chat_v2_update_block_content -->

- [x] 输入：block_actions.rs:441-491；blockId 须 blk_ 前缀；content 原样写入。
- [x] 输出：null。
- [x] 错误：前缀 Validation；BlockNotFound/MessageNotFound；子代理会话只读（ensure_session_writable）；活跃流时固定 `Cannot update block content while session is streaming. Please wait for completion or cancel first.`
- [x] 事件：无。
- [x] DB 读写：deferred 事务内 UPDATE chat_v2_blocks（content 变化时同条语句把 llm_content 置 NULL）+ invalidate_compaction_for_message；先读 block→message 校验。
- [x] 取消/并发：事务串行；活跃流检查基于 ChatV2State 内存表。
- [x] 时间/ID：不生成时间与 ID。

## 命令 `chat_v2_update_block_tool_output`

<!-- BEGIN GENERATED:cmd:chat_v2_update_block_tool_output -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:499` · async
- 前端：app（2 处，例 `src/features/chat/debug/chatAnkiIntegrationTestPlugin.ts:518`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：blockId: string, toolOutputJson: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_update_block_tool_output -->

- [x] 输入：block_actions.rs:499-552；blockId 须 blk_ 前缀；toolOutputJson 必须是合法 JSON。
- [x] 输出：null。
- [x] 错误：前缀 Validation；JSON 解析失败 `Validation error: Invalid tool_output_json: {serde 错误}`（Host 用 JSON.parse 文案，措辞不可完全一致）；BlockNotFound/MessageNotFound；子代理会话只读。
- [x] 事件：无。
- [x] DB 读写：事务内 UPDATE chat_v2_blocks.tool_output_json + invalidate_compaction_for_message；先读 block→message。
- [x] 取消/并发：事务串行。
- [x] 时间/ID：不生成。

## 命令 `chat_v2_update_group`

<!-- BEGIN GENERATED:cmd:chat_v2_update_group -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/group_handlers.rs:197` · async
- 前端：app（3 处，例 `src/components/ModernSidebar.tsx:709`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：groupId: string, request: UpdateGroupRequest
  - 结果：SessionGroup · 错误：string · 注入：app-handle, state, state, state
<!-- END GENERATED:cmd:chat_v2_update_group -->

> **已注册**：更新命令已实现全部 merge/clear 语义并接入 VFS 文件夹。**待接线：agentWorkspace.runtimeRootById** —— 同 `chat_v2_create_group`，root 校验/路径派生依赖 L05 未公开的解析器。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `chat_v2_update_session_settings`

<!-- BEGIN GENERATED:cmd:chat_v2_update_session_settings -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/manage_session.rs:448` · async
- 前端：app（11 处，例 `src/App.tsx:1235`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, settings: SessionSettings
  - 结果：ChatSession · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_update_session_settings -->

- [x] 输入：manage_session.rs:449-486；sessionId 前缀须为 sess_/agent_/subagent_；settings.title 显式传入即覆盖并置 title_locked=true；settings.metadata 三态：缺省=不动，null=清空普通键，对象=替换普通键。
- [x] 输出：更新后的 ChatSession，updatedAt 刷新为当前时刻。
- [x] 错误：前缀错误 Validation；会话不存在 SessionNotFound；非 active 状态 `Validation error: 只能归档活跃会话，当前状态: Active|Archived|Deleted`。
- [x] 事件：无。
- [x] DB 读写：IMMEDIATE 事务内读 chat_v2_sessions → patch metadata → 写回；后端权威键（availableSkillsSnapshot*、toolFacePrefixGeneration、frozenToolSchemaOrder、toolSchemaDigest、microcompactAnchor、manuallyArchivedBy、groupArchivedBy、branchedFrom、super_agent）从旧行重新盖章，incoming 中的 null 普通键被删除。
- [x] 取消/并发：IMMEDIATE 事务与 freeze/advance 等 metadata 助手串行，避免旧快照覆盖。
- [x] 时间/ID：updatedAt=Utc::now() RFC3339。

## 命令 `chat_v2_upsert_streaming_block`

<!-- BEGIN GENERATED:cmd:chat_v2_upsert_streaming_block -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/block_actions.rs:689` · async
- 前端：app（6 处，例 `src/features/chat/adapters/tauri/sessionCommands.ts:199`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：blockId: string, messageId: string, sessionId?: string | null, blockType: string, content: string, status?: string | null, toolName?: string | null, toolInputJson?: string | null, toolOutputJson?: string | null
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:chat_v2_upsert_streaming_block -->

- [x] 输入：block_actions.rs:690-856；blockId 须 blk_、messageId 须 msg_；payload=content+tool_input_json+tool_output_json 的 UTF-8 字节数，>8 MiB 拒绝；sessionId 非空且消息已存在时必须与消息归属一致。
- [x] 输出：null。
- [x] 错误：前缀/越权为 Validation（越权文案 `Message {messageId} does not belong to session {sessionId}`）；超限为 LimitExceeded `Streaming block payload too large: {bytes} bytes (max 8388608 bytes, block_id=…)`；tool JSON 非法 Validation。
- [x] 事件：无。
- [x] DB 读写：消息缺失且有 sessionId 时先插占位 assistant 消息（best-effort）；UPSERT chat_v2_blocks（block_index=0，started_at/first_chunk_at 用 COALESCE 保留首次值）；把 block_id 追加进 block_ids_json（去重）。
- [x] 取消/并发：单条 UPSERT；占位/追加失败仅 warn；status 缺省 `running`，content 空串写 NULL。
- [x] 时间/ID：now_ms=Utc::now().timestamp_millis()，started_at=ended_at=first_chunk_at=now_ms。

## 命令 `chat_v2_wake_session`

<!-- BEGIN GENERATED:cmd:chat_v2_wake_session -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:717` · async
- 前端：app（1 处，例 `src/features/chat/adapters/tauri/sendOperations.ts:270`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, content: string, assistantMessageId?: string | null, options?: SendOptions | null
  - 结果：string · 错误：string · 注入：window, state, state, state, state
<!-- END GENERATED:cmd:chat_v2_wake_session -->

> **阻塞（未注册）**：L03 `chatPipeline` 的 `ChatPipelineService` 没有 send/retry/continue 执行方法；当前 api.ts 只发布 citation/authority/compaction 等 helper。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `rebuild_chat_fts`

<!-- BEGIN GENERATED:cmd:rebuild_chat_fts -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/search_handlers.rs:89` · async
- 前端：app（1 处，例 `src/utils/chatApi.ts:374`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：integer(usize) · 错误：string · 注入：state
<!-- END GENERATED:cmd:rebuild_chat_fts -->

- [x] 输入：search_handlers.rs:90；无参数。
- [x] 输出：回填行数 number。
- [x] 错误：Database JSON 字符串。
- [x] 事件：无。
- [x] DB 读写：repo.rs:4391；先 DELETE 全索引，再 INSERT 非空 content/thinking 块；保留原无事务行为。
- [x] 取消/并发：无取消点，同步顺序执行。
- [x] 时间/ID：保留原 rowid，不生成。

## 命令 `workspace_cancel_agent`

<!-- BEGIN GENERATED:cmd:workspace_cancel_agent -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2139` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:498`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string, agentSessionId: string
  - 结果：boolean · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:workspace_cancel_agent -->

已注册；L05 真实 SQL 委托缺陷使集成验证受阻，证据见 BLOCKERS.md。

- [x] 输入：2140-2153；先 member/creator，不校验 ID 前缀。
- [x] 输出：stream 或 task 有一个实际取消则 true，否则 false。
- [x] 错误：权限错误原字符串；任务查询/取消失败按 Debug warn 后继续；agent 状态失败静默忽略。
- [x] 事件：2230-2243；true 时经 coordinator 发 workspace_warning，snake_case 字段、缺值 null。
- [x] DB 读写：委托 task cancelled(user cancelled) 后尽力写 agent cancelled；不直写 L05 表。
- [x] 取消/并发：先取消本 lane stream，后持久化；无跨步骤事务、无回滚。
- [x] 时间/ID：handler 不生成，L05 管理状态更新时间。

## 命令 `workspace_cancel_sleep`

<!-- BEGIN GENERATED:cmd:workspace_cancel_sleep -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2308` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:648`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string, sleepId: string
  - 结果：boolean · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_cancel_sleep -->

已注册；L05 集成缺陷见 BLOCKERS.md。

- [x] 输入：2309-2317；先 member/creator 后 getSleepManager。
- [x] 输出：cancel 返回 bool 原样，随后记录 info。
- [x] 错误：获取 manager 原 Display，cancel 错误 `Failed to cancel sleep: {Debug}`。
- [x] 事件：handler 不发事件。
- [x] DB 读写：委托 L05 cancel，保留其状态写入及唤醒通道顺序。
- [x] 取消/并发：manager 持有活跃 sleep 与 timer，不引入新等待或超时。
- [x] 时间/ID：handler 不生成。

## 命令 `workspace_close`

<!-- BEGIN GENERATED:cmd:workspace_close -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:642` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:167`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string
  - 结果：null · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:workspace_close -->

已注册；经 L05 `agentWorkspace.closeWorkspace` 真实接线（旧集成缺陷已随 L05 治理绑定解除，见 BLOCKERS.md）。测试 `tests/workspace-runtime.test.ts`、`tests/workspace-runtime-integration.test.ts`（作业 20261104145509-590ad0）。

- [x] 输入：643-657、583-599；workspace 必须存在且调用者为 creator。
- [x] 输出：null。
- [x] 错误：缺 workspace/非 creator 原文；关闭错误传播；取消传播各 warn/忽略分支见页首行为清单。
- [x] 事件：关闭事件由 L05 closeWorkspace 发出，handler 无新增事件。
- [x] DB 读写：先取消 worker stream、agent/task 状态，reason=workspace closed，后 closeWorkspace。
- [x] 取消/并发：独立操作，不把已发生的取消回滚；state 同步原子取走令牌。
- [x] 时间/ID：handler 不生成。

## 命令 `workspace_create`

<!-- BEGIN GENERATED:cmd:workspace_create -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:606` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:128`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, request: CreateWorkspaceRequest
  - 结果：CreateWorkspaceResponse · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_create -->

> 已注册并接线 `agentWorkspace.createWorkspace`；分支与日志见本文“中断续接：workspace coordinator 命令行为清单”，测试 `tests/workspace-commands.test.ts`。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `workspace_create_agent`

<!-- BEGIN GENERATED:cmd:workspace_create_agent -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:680` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:189`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：request: CreateAgentRequest
  - 结果：CreateAgentResponse · 错误：string · 注入：state, state, state, state, window
<!-- END GENERATED:cmd:workspace_create_agent -->

> **有条件注册**：`src/register-workspace-workers.ts`，在 index.ts 的 chatPipeline 注入里检测到 L03 `execute` 且 L06 `headlessToolSchemas`、L05 `CHATANKI_READONLY_TOOLS` 均已发布后才注册（缺口见 BLOCKERS「H1」）。实现在 `src/workspace-run-agent.ts`。

- [x] 输入：680-689；先 ensure_member_or_creator；role 只有 `"coordinator"` 是协调者，其余都是 worker；agent id 为 `agent_{skill_id 或 worker}_{ULID}`。
- [x] 输出：CreateAgentResponse 取 register_agent 返回的 agent（status 为注册时的状态），role/status 小写，skill_id 原样。
- [x] 错误：连接/requester 深度查询/建会话失败带 Rust 前缀；register/send_message/run 后端错误原字符串传出；task 持久化与 task manager 失败只 warn（Debug 格式）。
- [x] 事件：worker 且有 initial_task 时，后端运行后发 workspace_worker_ready {workspace_id, agent_session_id, skill_id, run_id, runtime_managed:true}；失败 warn、成功 info。
- [x] DB 读写：chat_v2_sessions 新行（mode agent、title_locked、metadata 含 subagent_depth=requester+1）；L05 register_agent / send_message(Task, requester→agent) / create_task 都走 coordinator API。
- [x] 取消/并发：内部 await run_workspace_agent_backend（排队取 permit），完成交给后台任务。
- [x] 时间/ID：会话时间取当前 UTC；task id 由 L05 newSubagentTask 生成。

## 命令 `workspace_delete`

<!-- BEGIN GENERATED:cmd:workspace_delete -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:661` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:177`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string
  - 结果：null · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:workspace_delete -->

已注册；经 L05 `agentWorkspace.deleteWorkspace`，其内部取得共享 L21 `governance.tryAcquireOperationGuard(delete_propagation)`（= coordinator.rs:267 DataGovernanceOperationGuard），与 Rust 同序：creator 校验 → 取消传播 → 守卫 → 删除。真实 L21 backup 占用时整体失败且会话/工作区保留，见 `tests/workspace-runtime-integration.test.ts`（作业 20261104145509-590ad0）。

- [x] 输入：662-676、583-599；workspace 必须存在且调用者为 creator。
- [x] 输出：null。
- [x] 错误：缺 workspace/非 creator 原文；删除错误传播；取消传播失败只 warn，agent 状态失败静默。
- [x] 事件：由 L05 deleteWorkspace 管理关闭/删除副作用。
- [x] DB 读写：先取消 worker stream、agent/task 状态，reason=workspace deleted，后 deleteWorkspace。
- [x] 取消/并发：无跨步骤事务，删除失败保留已经发生的取消。
- [x] 时间/ID：handler 不生成。

## 命令 `workspace_delete_agent_profile_file`

<!-- BEGIN GENERATED:cmd:workspace_delete_agent_profile_file -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2789` · async
- 前端：app（1 处，例 `src/features/settings/components/SubagentProfilesSection.tsx:556`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：fileName: string
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_delete_agent_profile_file -->

已注册并使用 L06 共享锁和路径校验。

- [x] 输入：2790-2797；fileName 原样交共享 resolvePersonaPath。
- [x] 输出：null。
- [x] 错误：锁内缺文件 PROFILE_FILE_NOT_FOUND；unlink 失败保留原 fileName 与 IO Display。
- [x] 事件：无；删除成功后记录 settings 删除 info。
- [x] DB 读写：无；只 unlink 已验证的 persona 文件。
- [x] 取消/并发：2798-2807；持有与工具相同的文件锁，finally 释放。
- [x] 时间/ID：不生成。

## 命令 `workspace_get`

<!-- BEGIN GENERATED:cmd:workspace_get -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:622` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:157`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string
  - 结果：WorkspaceInfo | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_get -->

> 已注册并接线 `agentWorkspace.ensureMemberOrCreator/getWorkspace`；行为清单及测试同上。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `workspace_get_context`

<!-- BEGIN GENERATED:cmd:workspace_get_context -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:972` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:257`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string, key: string
  - 结果：Value | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_get_context -->

> 已注册并接线 `agentWorkspace.ensureMemberOrCreator/getContext`；行为清单及测试同上。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `workspace_get_document`

<!-- BEGIN GENERATED:cmd:workspace_get_document -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1008` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:285`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string, documentId: string
  - 结果：string | null · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_get_document -->

> 已注册并接线 `agentWorkspace.ensureMemberOrCreator/getDocument`；行为清单及测试同上。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `workspace_list_agent_profiles`

<!-- BEGIN GENERATED:cmd:workspace_list_agent_profiles -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2638` · async
- 前端：app（1 处，例 `src/features/settings/components/SubagentProfilesSection.tsx:425`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：（无）
  - 结果：ListAgentProfilesResponse · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_list_agent_profiles -->

行为清单（workspace_handlers.rs:2639-2696）：
- 获取 coordinator.customAgentsDir；mkdir recursive 失败记 warn `[Workspace::handlers] Failed to ensure custom agents dir {}: {}` 后继续。
- 固定顺序 default/worker/explorer，经 L05 AgentProfileResolver.builtIn，返回 id/description/model/toolCount；缺 profile 则跳过。
- 经 L05 listCustomAgentFiles（排序与 fail-closed 解析均归 L05），透传文件名/字节数/修改时间/frontmatter 摘要；profile 不存在 toolCount=null/valid=false/active=false；同 id 的第一个有效文件 active=true，其余 false，非法文件不占 id。
- 返回 camelCase builtin/customFiles/agentsDir；无额外 DB、事务或事件。仅 mkdir 失败有本 handler warn，L05 的解析日志经同一 logger 输出。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `workspace_list_agents`

<!-- BEGIN GENERATED:cmd:workspace_list_agents -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:866` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:198`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string
  - 结果：AgentInfo[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_list_agents -->

> 已注册并接线 `agentWorkspace.ensureMemberOrCreator/listAgents/pendingInboxCount` 与 L05 `AgentProfileResolver.fromMetadata`；行为清单及测试同上。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `workspace_list_all`

<!-- BEGIN GENERATED:cmd:workspace_list_all -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1021` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:296`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string
  - 结果：WorkspaceInfo[] · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:workspace_list_all -->

> 已注册；索引只读查询位于 `repository/workspaces.ts`，权限经 `agentWorkspace.isMemberOrCreatorSession`；行为清单及测试同上。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `workspace_list_documents`

<!-- BEGIN GENERATED:cmd:workspace_list_documents -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:985` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:271`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string
  - 结果：DocumentInfo[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_list_documents -->

> 已注册并接线 `agentWorkspace.ensureMemberOrCreator/listDocuments`；行为清单及测试同上。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `workspace_list_messages`

<!-- BEGIN GENERATED:cmd:workspace_list_messages -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:935` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:225`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string, limit?: integer(usize) | null
  - 结果：MessageInfo[] · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_list_messages -->

> 已注册并接线 `agentWorkspace.ensureMemberOrCreator/listMessages`；行为清单及测试同上。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `workspace_manual_wake`

<!-- BEGIN GENERATED:cmd:workspace_manual_wake -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2274` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:625`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：request: ManualWakeRequest
  - 结果：ManualWakeResponse · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_manual_wake -->

已注册；L05 集成缺陷见 BLOCKERS.md。

- [x] 输入：2275-2286；request snake_case，message 缺省 null；先 member/creator 后获取 manager。
- [x] 输出：{success: wake_result 非 null, sleep_id: 原 sleep_id}。
- [x] 错误：manager 获取原 Display；manualWake 失败 `Failed to wake: {Debug}`。
- [x] 事件：2290-2299；操作成功后记录 info，有结果才 emitCoordinatorAwakened。
- [x] DB 读写：全部经 L05 sleep manager，不直接写表。
- [x] 取消/并发：复用 manager 唤醒/timeout 清理语义；handler 无额外取消点。
- [x] 时间/ID：handler 不生成。

## 命令 `workspace_read_agent_profile_file`

<!-- BEGIN GENERATED:cmd:workspace_read_agent_profile_file -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2709` · async
- 前端：app（1 处，例 `src/features/settings/components/SubagentProfilesSection.tsx:486`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：fileName: string
  - 结果：AgentProfileFileResponse · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_read_agent_profile_file -->

已注册并使用 L06 公开路径校验。

- [x] 输入：2710-2717；共享 resolvePersonaPath，返回的 fileName 保留输入原文。
- [x] 输出：{fileName,content}，全文 UTF-8，保留 BOM/换行。
- [x] 错误：缺文件 PROFILE_FILE_NOT_FOUND；读取/UTF-8 失败带原 fileName/IO Display。
- [x] 事件：无日志或事件。
- [x] DB 读写：无；仅文件读取。
- [x] 取消/并发：无额外锁、无取消点。
- [x] 时间/ID：不生成。

## 命令 `workspace_restore_executions`

<!-- BEGIN GENERATED:cmd:workspace_restore_executions -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2413` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:589`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string
  - 结果：RestoreExecutionsResponse · 错误：string · 注入：window, state, state, state, state
<!-- END GENERATED:cmd:workspace_restore_executions -->

> **有条件注册**：`src/register-workspace-workers.ts`，在 index.ts 的 chatPipeline 注入里检测到 L03 `execute` 且 L06 `headlessToolSchemas`、L05 `CHATANKI_READONLY_TOOLS` 均已发布后才注册（缺口见 BLOCKERS「H1」）。实现在 `src/workspace-run-agent.ts`。

- [x] 输入：2414-2423；先 member/creator 校验；首次调用启动 completion dispatcher（每个插件实例一次，对应 Rust 的 Once）。
- [x] 输出：RestoreExecutionsResponse {subagent_tasks_restored, restored_agent_ids, has_active_sleeps, active_sleep_ids, unknown_tasks}。
- [x] 错误：get_task_manager / get_sleep_manager 原字符串；get_tasks_to_restore 为 `Failed to get tasks to restore: {Debug}`；sweep 失败 error、unknown 列表失败 warn，都不中断；单个任务恢复失败 warn 后继续。
- [x] 事件：成功恢复的每个任务发 workspace_worker_ready {restored:true, reminder, runtime_managed:true}；发送失败 warn。
- [x] DB 读写：L05 sweep_orphaned_running 把没有活跃流的 running 任务转为 unknown（不重跑）；pending/running 中有 inbox 或 running 无 inbox 的任务重进运行时，后者附带 reminder「继续执行上次中断任务（恢复）」。
- [x] 取消/并发：逐个顺序 await 后端入队；判断孤儿依据本进程流注册。
- [x] 时间/ID：不生成，started_at/created_at 原样透传。

## 命令 `workspace_run_agent`

<!-- BEGIN GENERATED:cmd:workspace_run_agent -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1075` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:465`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：request: RunAgentRequest
  - 结果：RunAgentResponse · 错误：string · 注入：window, state, state, state, state
<!-- END GENERATED:cmd:workspace_run_agent -->

> **有条件注册**：`src/register-workspace-workers.ts`，在 index.ts 的 chatPipeline 注入里检测到 L03 `execute` 且 L06 `headlessToolSchemas`、L05 `CHATANKI_READONLY_TOOLS` 均已发布后才注册（缺口见 BLOCKERS「H1」）。实现在 `src/workspace-run-agent.ts`。

- [x] 输入：1076-1093 → 1264；member/creator 校验；agent 不存在报 `Agent not found`；coordinator 拒绝；running/queued 且有活跃流时幂等返回当前状态。
- [x] 输出：排队后被取消返回 cancelled；inbox 为空且无 reminder 返回 idle 并置 Idle；正常返回 {message_id = assistant id, status: running}。
- [x] 错误：drain 之后任何失败都先经 fail_with_drained_rollback 把消息放回 inbox；回补失败时发 run_agent_requeue_failed 警告，并在错误串上追加说明；人格技能快照缺失时 fail-closed。
- [x] 事件：完成/失败/取消都发 workspace_agent_completion 信封（字段顺序和省略规则同 serde）；非 worker 分支有待处理消息时发 worker_ready。
- [x] DB 读写：先写 outbox(pending) → inbox Result 消息 + metadata → agent/task 终态 → outbox delivered → emit；读 assistant 块/消息 usage 作为 final_output/token_usage。
- [x] 取消/并发：按嵌套深度分池（MAX_SUBAGENT_DEPTH × MAX_CONCURRENT_WORKERS）；StreamGuard、卡面只读作用域、grant、预算绑定在所有退出路径都释放；600s 超时后取消，再给 30s 收尾。
- [x] 时间/ID：assistant id 由 generateMessageId 生成；delivery_id `deliv_{ULID}`；completed_at 为 RFC3339 UTC。

## 命令 `workspace_save_agent_profile_file`

<!-- BEGIN GENERATED:cmd:workspace_save_agent_profile_file -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2742` · async
- 前端：none
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：fileName: string, content: string, overwrite: boolean
  - 结果：SaveAgentProfileFileResponse · 错误：string · 注入：state, state
<!-- END GENERATED:cmd:workspace_save_agent_profile_file -->

生产入口：`src/register.ts` → `src/workspace-profiles.ts::saveAgentProfileFile`，已注册；L05/L06 所有者接口均已在 main。

| Rust 分支 | TS 落点 |
|---|---|
| :2753 内容/头部校验 | validatePersonaContent，直接传播 L06 原错误 |
| :2755-2767 Some(model) / None；catalog Ok / Err | getApiConfigs → validatePersonaModelConfig；查询失败只加原 warnings，None 不查询 |
| :2768-2773 路径/锁/存在且不覆盖 | resolvePersonaPath → withCustomAgentFileLock → PROFILE_FILE_EXISTS |
| :2774-2785 写入/日志/输出 | atomicWrite → info → fileName/agentName/UTF-8 bytes/warnings |

- [x] 输入：kernel 契约读取 fileName/content/overwrite；内容由 L06 真实校验器解码，模型配置由 L02 当前目录提供并经 L05 精确 ID 校验；文件名由 L06 校验。
- [x] 输出：{fileName,agentName,bytes,warnings}；fileName 保留输入，不用清洗后的路径名；warnings 总是数组。
- [x] 错误：内容→模型→路径→锁→存在→写入；原 Error.message 经 CommandError 字符串发送。模型目录获取失败独立返回警告，不吞模型校验失败。
- [x] 事件：无；写入成功之后唯一 info `[Workspace::handlers] Saved custom agent profile '…' (… bytes) via settings`。
- [x] DB 读写：无。文件写入唯一所有者 L06 atomicWrite；L04 不另写文件协议。
- [x] 取消/并发：无取消点；共享 L06 锁内重新检查 exists 后写入，try/finally 释放（由 withCustomAgentFileLock）；不跨网络持有锁。
- [x] 时间/ID：handler 不采样时间/生成 ID；临时文件 ID 归 L06。证据为生产 IPC 测试+逐分支审读，未声明 Rust 运行差分。

## 命令 `workspace_send_message`

<!-- BEGIN GENERATED:cmd:workspace_send_message -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:902` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:211`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, request: WorkspaceSendMessageRequest
  - 结果：SendMessageResponse · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_send_message -->

> 已注册并接线 `agentWorkspace.sendMessage`；行为清单及测试同上。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `workspace_set_context`

<!-- BEGIN GENERATED:cmd:workspace_set_context -->
- Rust：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:960` · async
- 前端：app（1 处，例 `src/features/chat/workspace/api.ts:241`）
- 契约：`contracts/ipc/L04-chat-session.json`
  - 参数：sessionId: string, workspaceId: string, key: string, value: Value
  - 结果：null · 错误：string · 注入：state
<!-- END GENERATED:cmd:workspace_set_context -->

> 已注册并接线 `agentWorkspace.setContext`；行为清单及测试同上。

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 事件 `chat_v2_migration`

<!-- BEGIN GENERATED:event:chat_v2_migration -->
- 事件名 `chat_v2_migration`，常量 `MIGRATION_EVENT_CHANNEL`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:80`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:951`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/migration/legacy_migration.rs:1018`（emit）
<!-- END GENERATED:event:chat_v2_migration -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `chat_v2_request_audit`

<!-- BEGIN GENERATED:event:chat_v2_request_audit -->
- 事件名 `chat_v2_request_audit`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:549`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/send_message.rs:764`（emit）
<!-- END GENERATED:event:chat_v2_request_audit -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `chat_v2://kill_switch_changed`

<!-- BEGIN GENERATED:event:chat_v2://kill_switch_changed -->
- 事件名 `chat_v2://kill_switch_changed`，常量 `KILL_SWITCH_CHANGED_EVENT`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/kill_switch.rs:153`（emit）
<!-- END GENERATED:event:chat_v2://kill_switch_changed -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `workspace_agent_completion`

<!-- BEGIN GENERATED:event:workspace_agent_completion -->
- 事件名 `workspace_agent_completion`，常量 `WORKSPACE_AGENT_COMPLETION_EVENT`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/completion_dispatcher.rs:310`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:1982`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2068`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2126`（emit）
<!-- END GENERATED:event:workspace_agent_completion -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `workspace_worker_ready`

<!-- BEGIN GENERATED:event:workspace_worker_ready -->
- 事件名 `workspace_worker_ready`，常量 `WORKSPACE_WORKER_READY_EVENT`
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:840`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2001`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/workspace_handlers.rs:2545`（emit）
<!-- END GENERATED:event:workspace_worker_ready -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `channel`

<!-- BEGIN GENERATED:event:expr:channel -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:904`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:913`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:937`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:945`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/goal_handlers.rs:39`（emit）
<!-- END GENERATED:event:expr:channel -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `event`

<!-- BEGIN GENERATED:event:expr:event -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1340`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1359`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1387`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1453`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1472`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1488`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1518`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1537`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1553`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1650`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1688`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1725`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1864`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/events.rs:1884`（emit）
<!-- END GENERATED:event:expr:event -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `event_name`

<!-- BEGIN GENERATED:event:expr:event_name -->
- 动态事件名（表达式）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/goal/mod.rs:28`（emit）
- 发送点：`src-tauri/crates/dstu-agent/src/chat_v2/handlers/variant_handlers.rs:368`（emit）
<!-- END GENERATED:event:expr:event_name -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

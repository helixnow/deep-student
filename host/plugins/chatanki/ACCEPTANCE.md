# L24-chatanki 独立验收（R5-review-learning，2026-11-04）

结论：不通过

初审基线 `f23c98702`；原无 ACCEPTANCE。只读审读与 Node/TS 验证，未运行 Rust。历轮候选/失败证据保留历史；最新正常main独立复验`1e80f32b4`四项自检全过，当前窄签收以文末表为准，不把下方候选阶段记录当最新未集成状态。

**抽样口径例外：本 lane 的契约确实有0条 Tauri 命令**（`contracts/ipc/L24-chatanki.json:4`、`index.ts:150`），无法抽出15条 `#[tauri::command]`。以下独立对照18个 Rust ToolExecutor 工具入口，不冒充15条 IPC命令；由协调者确认此口径。15条 ported 测试另逐条审查。

## 必须修复

- [x] **C1 / main复验签收：旧服务名缺陷已修。** 当前 `index.ts:480`消费真实`anki`；`tests/real-host-wiring.test.ts:29-50`安装真实Anki/review/L07/F7/chatanki，独立本轮该文件通过（5513ms）。签收范围为旧名导致无法启动，静态接线与真实启动证据相符；三目录总作业另有RPC错误/exit1，未宣称整组门禁通过，也未签C2完整链。
- [ ] **C2 / 高：注册hydrate包装已补，完整依赖链仍未闭合。** `2d627a513:index.ts:230-244` 已向L07注册经过 `adaptContext→hydrate` 的包装器，`:326-457` 补scheduler、review快照、AnkiConnect、JSON sink及Context nativeRegex；`:267-299` 转发L04顶层生命周期回调。真实插件测试读取实际L07注册对象调用review_stats，认可该增量。仍未hydrate模板CRUD的mainDb/ankiDb、refs、llmPlanner、sessionResources等；L16七面在另一候选已提供，不再笼统称其不存在，但完整组合及CAS消费未验证。保持未勾选（详见最新章节）。
  **retemplate Phase2后继73a23e3dc/cbd4b027e**：已改消费正式llmRawPrompt.callModel2RawPrompt(prompt,null,'anki')并只映射assistant_message，原私有llm缺方法依赖在候选已修。真实owner链＋本地HTTP定向正向1pass获提供方证据；仍非main、VFS注册占位未调用、UI回调为观察函数，不能签完整工具/UI/VFS或Planner/VLM角色。
- [ ] **C3 / main已移除SafeInteger拒绝，完整工具/CAS链仍未闭合。** `034d6c6fc`已进入本轮main基线，`src/executor-args.ts:82-101,120-127`以BigInt校验i64范围，原合法大整数拒绝问题已修。session enqueue局部独立通过证据继续有效；参数透传仍使用ReviewBoundaryDouble，不能签完整真实L16/CAS、内部精确版本链及未完成工具/APKG导出。当前TESTMAP244P/42待。
  **1e80f32b4当前签收**：D3/R7同根子项已由正常main真实L16 documents/cards→chatankiTools.execute→hydrate→L15四例独立通过，无CardStoreDouble/缺陷skip，原SQL TEXT/内部bigint/返回快照/wire及副本不变全部保留。该精确链已闭合，不再沿用“仅替身/候选API不齐”；C3剩余工具/APKG等原范围仍不一概通过。以下各版本阶段为历史记录。
  **P0 D3同根补录**：L24原参数门槛修复认可不撤回，但最新main L15 `227d44de4`在输入及内部读取重新以MAX_SAFE收窄i64（见review R7/L15-V2-S4）。L24候选`342c61556`将真实L15测试LARGE从`2^63-1024`降为MAX_SAFE-1，并锁定库内2^53+1的范围Database拒绝；这是为owner缺陷缩小向量，不是合法更严格策略。C1已派恢复原向量及SQL精确回读，本轮不重跑错误期望测试。
  **c5c8ce42c后继**：完整候选树已恢复原大i64、bigint绑定、TEXT回读、精确+1及stale不写断言，认可修复；但`skipOnL15PrecisionDefect`在三条正向路径的成功断言前按已知缺陷文本skip，仍把已知错误变成跳过，C3/R7测试保证未恢复。C1已要求现在移除helper/skip、保留失败blocked，不等L15修后才移除；不以该候选exit0签收。
  **L15 a0515bf75进展**：owner两处MAX_SAFE限制已在候选移除，内部reviewVersion为bigint。其未改旧L24文件的组合job实际2pass/2fail；失败仅在内部输出用number LARGE+1断言，而成功变更/stale conflict已成立。应保原大数范围，内部用BigInt(LARGE)+1n、SQL精确读、wire另断言Number；不得缩小向量或恢复缺陷skip。候选非main，整链未签。
  **48063ba9b最新测试状态**：已删除helper及三处runtime skip，原大数/SQL TEXT/+1/stale不写保证保留，认可该纠正；但新版公开provider链仍未断言`output.reviewState.reviewVersion`与`output.current.reviewVersion`为精确`LARGE_SQL+1n`。C1已要求补回，SQL回读不能替代返回快照保证。`a52cf7`实际是旧execute+直接FsrsReviewService注入，不能当新版hydrate公开链已运行。
  **de19f72a0后继**：两个缺失输出版本断言已补，另补undo输出及toWireJson副本/内部bigint未变，原大数/SQL精确回读和撤skip均保留，静态认可测试保证恢复。这不是运行签收；该候选api:173/234/507/510仍声明number，与L15/L16 bigint协议未齐，L16类型兼容断言实际失败，C3待正常main同批最小复验。
  **6962cbfed/e8b2046c1后继**：最新候选API已改snapshot bigint、scoped number|bigint、delete number|bigint|null，六个CAS decoder原样保留bigint/legacy整数number并按完整i64检查；旧“候选API仍number”只适用于de19快照。44条解析/consumer子集通过及两候选内存类型兼容diagnostics0分别认可，不替代正式main typecheck或真实三方公开链。C3仍未签。
  **L15已main增量**：a0515/7f9e63ea1经819b970b6已main，旧JSsafe拒绝不再是当前main现状。已取L24新main依赖树提供方job164944-744fb3为44files/391pass/exit0；官方receipt tip1d010c567/basefb463060d仍ok=false，仅typecheck失败。L16 a47及L24新API未main，不将这次提供方全绿签成正常三方联合。
  **25c1c30ce canonical类型后继**：snapshot/outcome改直接import/export已main review/api，服务签名Pick/Partial<Pick<ReviewService>>，不再手写漂移镜像；内部bigint及原精确向量/无skip保持。9178ca2b6仅报告，当前仍非main；三文件17pass含真实CAS4只是提供方候选运行，不能代签L16/L24正常main类型/生产联合。
- [ ] **C4 / 650ddffbe已闭合async常量/capture分配预检及fallback缺口，脚本/平台等范围仍开放。** 正常main已删除JS常量收集/拼接与capture事后fallback，统一必需F7 projected调用；本轮独立定向23pass/21标题过滤skip、exit0，真实工具验证首次超限/无写入及正常apply。常量增长仅dry_run动态覆盖，不冒称常量apply已测；完整脚本/跨平台、同步生产provider等不由该子项签收。下方1e80f32b4及更早状态均为历史，最新证据见文末。
  **新main 1e80f32b4更正**：F7已真实提供带limit的replaceAllProjected，L24 capture分支:517-524已调用，原“F7未提供/仅事后分配”只适用于旧基线。独立nativeRegex生产服务11向量exit0，配合原文captures/gap/展开/tail的u64预检源码确认该capture分支原阻塞已修。无`$`分支:494-510仍findIter后边计数边拼接前缀、能力缺失fallback仍在，不把局部修复签成所有正则路径/整个C4，完整消费者结果待同轮gate。
- [ ] **C5 / main已修info/start顺序，完整L04事件链待签收。** 当前`src/result.ts:9-15`info后start，对齐Rust `chatanki_executor.rs:1873-1883`；本轮tool-lifecycle7条通过但所属总job有RPC错误。各入口start与终态回调修复认可；真实registry测试的L04持久化/emitter仍为测试回调，完整消费者未签。
- [ ] **C6 / 候选合法回退已恢复，实际manager接线仍待闭合。** `2d627a513:src/chatanki-executor.ts:258-278` 已按 `llmManagerPresent` 区分无manager的heuristic与有manager但缺planner的接线错误；原Rust None分支 `chatanki_executor.rs:5628-5646` 得到保留。`:index.ts:439-443` 会标识manager存在，却尚未装配llmPlanner/refs；不以直接helper测试证明实际资料引用规划已接通，保持未勾选。
- [ ] **C7 / 候选真实CommandError映射已补，待集成验证。** `2d627a513:src/get-cards-executor.ts:24-39,128-137` 解包 `CommandError.value`，NotFound映射原key，其他AppError经 `src/result.ts:47-62` 保留 `output.error` 与errorCode前缀，符合Rust `chatanki_executor.rs:2406-2420,11983-12015` 的分流。新真实review缺卡用例和注入AppError的精确载荷用例设计有效，但前者卡读取仍为替身；本轮只静态确认，不签完整L16链。

## 建议

- [ ] 将 `service-wiring.test.ts:36-50` 的虚构服务面改成安装真实 L16/L15/L07 插件的集成证据；该用例现在通过恰好掩盖 C1/C2。
- [ ] 文档同步真实服务名：`SPEC.md:33-37` 所称 L16 仍提供 `anki@1` 已与被审基线源码冲突。

## 已核实通过

- [x] 复核确认：没有 Tauri 命令不是漏提取，本 lane 是工具服务；没有制造不存在的 IPC 命令来凑抽样数。
- [x] 复核确认：下表5条参数归一化测试确实断言生产代码，保留原 Rust 的错误/默认值要求。
- [x] 复核确认：模板 update 的 expectedVersion、空 patch、builtin 标志保护、CAS 错误和 user_modified warn 分支保留（`src/template-executor.ts:369-434`；Rust `src-tauri/src/chat_v2/tools/template_executor.rs:1029-1225`）。这不代表模板数据库已接上。
- [x] 复核确认：生产代码未使用测试目录导入或 `console.*` 调用；无本插件 SQL 写表。`chatankiTools` 命名符合规范，但消费协议不通过，见 C2。
- [x] 复核确认：31文件/319测试通过，入口原生导入通过，wiring扫描270 ported未接入0；这些结果没有验证真实提供方和数据层。
- [x] 复核确认：两处获 boundary-allow 的空 catch 确实对应 Rust 无日志的 `let _ = upsert_block_allow_orphan`，不误判为丢 warn（`src/block-patch.ts:83,153`；Rust `src-tauri/src/chat_v2/tools/chatanki_executor.rs:14504,14589`）。

## 入口等价抽查（18 个工具）

TS路径根 `host/plugins/chatanki/`；Rust根 `src-tauri/src/chat_v2/tools/`，C=`chatanki_executor.rs`、T=`template_executor.rs`。所有工具的整体可用性均受 C1/C2 阻塞；“通过”仅指所列 handler 子行为。

| 工具 | 结论与核对点 | TS 文件:行 | Rust 文件:行 |
|---|---|---|---|
| chatanki_analyze | 问题 C5/C6；route先校验、资源去重、纯文本分支正确 | src/chatanki-executor.ts:212-275 | C:5555-5681 |
| chatanki_get_cards | 问题 C2/C5/C7；page1/20、上限50、ownership先读正确 | src/get-cards-executor.ts:57-124 | C:2333-2445 |
| chatanki_update_card | 问题 C2/C5；先owner/截断保护/内容校验，再preflight和CAS | src/mutation-executor.ts:179-269 | C:2448-2592 |
| chatanki_delete_card | 问题 C2/C5；生产仓储缺失，替身不能证明删除事务 | src/mutation-executor.ts:272-369 | C:2593-2737 |
| chatanki_status | 问题 C2/C5：terminal error事件改warn | src/status-executor.ts:32-42,46-136 | C:2172-2325,14308 |
| chatanki_import_apkg | 问题 C2/C5；路径/资源两路和资源归属检查仍有代码 | src/apkg-executor.ts:64-139 | C:2003-2138 |
| chatanki_export | 问题 C2/C3/C5；JSON保留完整卡片，APKG硬失败 | src/chatanki-executor.ts:357-429 | C:5795-6056 |
| chatanki_retemplate | 问题 C2/C5；填充LLM前检查、目标模板存在/active校验 | src/retemplate-executor.ts:205-309 | C:4207-4552 |
| chatanki_transform | 问题 C2/C4/C5；dry_run/CAS入口存在，真实regex未hydrate | src/transform-executor.ts:517-623 | C:4553-5038 |
| template_list | 通过：active默认true、limit50/200、空库导入后过滤 | src/template-executor.ts:255-292 | T:734-826 |
| template_get | 通过：缺模板错误；展示完整结构、模型精简结构 | src/template-executor.ts:295-321 | T:829-903 |
| template_validate | 通过：参数/模板解析分层，格式不合法返回 valid:false | src/template-executor.ts:324-337 | T:907-946 |
| template_create | 通过：先校验、再写库，版本默认1.0.0、active默认true | src/template-executor.ts:340-366 | T:949-1023 |
| template_update | 通过：expectedVersion/CAS、受保护字段、警告后继续 | src/template-executor.ts:369-434 | T:1029-1225 |
| template_delete | 通过：引用统计失败warn/0；builtin软停用；用户模板删除 | src/template-executor.ts:515-553 | T:1446-1550 |
| template_set_default | 通过：存在→active校验→设置→成功对象 | src/template-executor.ts:556-577 | T:1557-1618 |
| chatanki_start | 问题 C3：未实现/未宣告支持 | index.ts:54-58；src/chatanki-executor.ts:461-463 | C:1939,6760 |
| chatanki_run | 问题 C3：未实现/未宣告支持 | index.ts:54-58；src/chatanki-executor.ts:461-463 | C:1940,6817 |

## 测试真实性抽查（15 条 ported）

前10项 Rust=`src-tauri/src/chat_v2/tools/chatanki_executor.rs`，TS=`host/plugins/chatanki/tests/card-repository-contract.test.ts`，TESTMAP `:47-56`。

| 测试名 | Rust行 / TS行 | 结论 |
|---|---|---|
| test_chatanki_get_cards_rejects_wrong_and_mixed_document_ownership | 16427 / 17 | 问题：只测 CardStoreDouble 的读取 |
| test_chatanki_update_card_rejects_wrong_owner_atomically | 16457 / 28 | 问题：只测替身更新，无生产事务 |
| test_chatanki_update_card_rejects_mixed_owner_document_atomically | 16478 / 42 | 问题：含真实 loadOwned helper，但核心原子更新仍为替身 |
| test_chatanki_delete_card_rejects_wrong_owner_atomically | 16520 / 64 | 问题：只测替身删除 |
| test_chatanki_delete_card_rejects_mixed_owner_document_atomically | 16542 / 77 | 问题：只测替身墓碑 |
| test_chatanki_add_cards_rejects_wrong_and_mixed_document_ownership | 16576 / 91 | 问题：只测替身插入 |
| test_chatanki_update_card_atomic_version_success_and_conflict | 16606 / 105 | 问题：payload helper真实，核心CAS不真实 |
| test_chatanki_delete_card_normal_path | 16645 / 134 | 问题：物理删除断言被改成deletedAt非空 |
| test_chatanki_delete_card_stale_version_returns_conflict_without_deletion | 16672 / 147 | 问题：冲突由替身产生 |
| test_chatanki_delete_card_review_cas_blocks_null_and_post_rating_stale_tokens | 16714 / 173 | 问题：enqueue/rate/version均为替身 |
| normalize_rejects_script_and_ops_together | chatanki_transform.rs:859 / transform.test.ts:32 | 通过：生产normalize拒绝两者并存 |
| normalize_requires_script_or_ops | chatanki_transform.rs:872 / transform.test.ts:38 | 通过：拒绝两者皆无 |
| normalize_script_mode_carries_language_code_and_default_timeout | chatanki_transform.rs:882 / transform.test.ts:42 | 通过：python/code/30000/dry_run |
| normalize_script_mode_propagates_script_contract_errors | chatanki_transform.rs:900 / transform.test.ts:49 | 通过：空代码、500ms错误不弱化 |
| normalize_defaults_to_dry_run_and_default_live_selection | chatanki_transform.rs:939 / transform.test.ts:66 | 通过：文档trim、tag去重、默认live/dry_run |

后5项根同上，TESTMAP `:189-192,194`。模块级 wiring 全绿不验证数据替身内容。0 merged/obsolete，无需批准；16 pending 未闭合，不能以“待接线”替代批准。

## 亲自运行（原始输出摘要）

```text
$ npx vitest run -c vitest.host.config.ts host/plugins/chatanki
Test Files  31 passed (31)
Tests       319 passed (319)
Duration    8.23s
exit 0

$ node scripts/electron-migration/wiring.mjs --lane chatanki
合计 ported 270，其中所测模块未从 index.ts 接入 0（0.0%）
```

四入口合并执行 `node scripts/electron-migration/importable.mjs`（含 `host/plugins/chatanki/index.ts`）：`importable: ok`，退出0。

另用 Node 原生导入真实 `createTestHost` 和本插件，提供新名 `anki`、settings/review/llm 的最小服务对象，仅测试依赖名，未访问 DB：

```text
PluginLifecycleError: plugin "dstu.chatanki" did not start: required services not available: "anki@1"
```

直接执行生产 `new ChatAnkiExecutor().execute(chatanki_analyze, context)`，输入普通文本，事件回调只记录名称：

```json
{"success":true,"events":["end"]}
```

这两项为本次临时命令验证，不新增/修改测试文件。

## 语义差异分类

- 应修：C1–C7；其中 C3/C4 是覆盖与验收证据缺陷，C5/C6/C7 是具体可观察行为不一致。
- `SPEC.md:26-48` 登记的是待接线，不是协调者批准的平台差异；尤其“L16仍用旧名”与当前代码不符。
- 已登记平台差异仅沿用全局 `docs/dev/electron-migration/decisions.md:52-59` 的 JS 时间精度；不能据此豁免事件、CAS、取消、数据库替身或更换正则引擎。

## 协调者指令1：C5 候选提交定向复核

本轮已先merge main到 `4b9c2809b`（main父提交 `35b4fbfdf`）。`git merge-base --is-ancestor afc0f422a HEAD` 退出1：该候选**未进入本次main快照**。`afc0f422a` 本身仅改 LANE/api；共同start/info的实际改动在其祖先 **`440782ab1`**，候选累计树的 `src/chatanki-executor.ts:495-500` 已有该代码。未cherry-pick或覆盖实现。

为验证增量而不重复旧main测试，采用一次性 Node `registerHooks`：`git show afc0f422a:<path>` 从对象库读取全部被导入的 `host/plugins/chatanki/*.ts` 源码，`stripTypeScriptTypes` 后仅在内存执行；平台/内核沿用本工作树依赖。无源文件写入/分支切换，也不是完整Host启动测试。

真实候选入口 `new ChatAnkiExecutor().execute` → 普通文本 analyze / 无效route analyze，回调记录start/info/end/error；`node --input-type=module` 脚本内以 `assert.deepEqual` 检验轨迹。原始输出：

```text
{"revision":"afc0f422a","case":"end","success":true,"trace":["start","info","end"]}
{"revision":"afc0f422a","case":"error","success":false,"trace":["start","info","error"]}
{"revision":"afc0f422a","case":"mutation-invalid-args","trace":["error"]}
exit 0
```

第三条调用候选的真实 `ChatAnkiMutationExecutor.execute`（空update参数），确认该独立executor仍无start/info（候选 `src/mutation-executor.ts:381-388`）。候选 `src/status-executor.ts:34-43` 仍将 terminal `emitError` 转为warn。Rust统一入口则先info再start（`src-tauri/src/chat_v2/tools/chatanki_executor.rs:1873-1883`）；候选共同入口顺序为start再可选info，此次只认可两者已存在，未宣称全日志顺序逐条等价。

结论：**C5“ChatAnkiExecutor共同入口缺start/info”在候选累计树已部分修复，且局部实测通过；C5整项保持未勾选**。独立mutation等入口、终态UI错误通道及候选合入后的真实插件链仍需闭合。本轮不据此关闭C1/C2；R2新增公开快照已另在review验收中确认，不再把那两个快照方法当作当前提供方缺口。仅Linux Node候选模块测试，未验证完整候选Host、Windows/macOS/Electron。

## C1 05:49Z新交付：`2d627a513` 定向静态复核

### 基线与证据等级

审读HEAD=`b2394fbe4`；检查时main=`fa99dd561`。`2d627a513` 对HEAD/main祖先检查均exit1，尚未集成。只用git show/diff审候选完整树，不摘实现、不执行候选内存代码、不用旧基线测试证明候选。下述路径/行号均在该候选的 `host/plugins/chatanki/`。提供方335passed不是本次R5实跑结果；本轮测试命令/作业号/退出码均不适用（无提交作业）。后续重测试必须走全局job队列。

### 已核实的修复范围

| 编号 | 候选真实入口 → 测试对象 | 静态结论 |
|---|---|---|
| C1 | `index.ts:474` inject anki；`tests/real-host-wiring.test.ts:29-50`安装真实native/anki/review/agentSkills/chatanki | 旧名启动根因已修，测试不再提供anki@1。paths/settings/llm仍有测试提供物，证明服务名与装载组合设计，不是全部功能实跑。 |
| C2 | `index.ts:230-244`注册包装器→adaptContext→hydrate；真实L07 `toolExecutors()`里取对象调用（测试`:52-99`） | 原raw-executor绕过hydrate缺陷已修；stats、scheduler、review快照、JSON sink、Context nativeRegex补入。顶层工具start/end/error回调由`:267-299`转发；不是直接调用本lane服务来绕过registry。 |
| C4引擎 | `index.ts:333,436-438` → `transform-executor.ts:541-562,637-641` → `compileTransformOpsAsync/applyTransformOpsAsync` | 使用Context的F7异步引擎；测试`transform.test.ts:11-14`改为真实F7 wasm，不再使用NativeRegexDouble。新适配的语义问题见下，不据引擎同源签完整等价。 |
| C5 | `beginChatAnkiToolCall`接到ChatAnki/Mutation/GetCards/Status/APKG/Retemplate六入口；`status-executor.ts:35-52`终态emitBlockError | 生命周期用例`tests/tool-lifecycle.test.ts:26-64`验证正常/参数失败先start，`:66-99`验证终态error回调不再仅warn。后者用CardStoreDouble/ChatBlockStoreDouble，不是L04存储集成；日志顺序仍与Rust相反。 |
| C6 | `src/chatanki-executor.ts:258-278` | 无manager时合法fallback恢复；测试`analyze.test.ts:165-171`调用生产executor验证heuristic，`:276-280`区分存在manager但缺planner。未证明真实Host引用规划，因为hydrate尚无refs/llmPlanner。 |
| C7 | `src/get-cards-executor.ts:24-39,128-137` → `src/result.ts:47-62` | 不再仅依赖私有错误类。`tests/review-state-errors.test.ts:39-81`验证真实CommandError形状与精确output/error文本；`real-host-wiring.test.ts:128-137`从真实review产生NotFound，卡片读取仍是替身。 |

真实Host用例的边界：JSON导出/regex dry_run/NotFound段落均复用 `CardStoreDouble`（`tests/real-host-wiring.test.ts:101-153`）。可证明真实JSON sink、regex和review错误被消费，不能证明真实L16 ownership/CAS/物理删除，亦未安装真实L04执行上下文/事件持久化整链。

### C4新增：真实引擎外的切片重匹配不等价

`src/transform.ts:487-501` 为每个原文match计算replacement时，对 `before.slice(match.start)` **重新执行**native.replace；Rust `src-tauri/src/chat_v2/tools/chatanki_transform.rs:562-592` 则用完整before的captures预检，再对完整before replace_all。前文被移除会改变合法Rust正则边界：

- 输入front=`afoo`，pattern=`\B(foo)`，replacement=`<$1>`。
- Rust在原文offset1捕获foo，预期 `a<foo>`。
- TS findIter先找到offset1，但再次replace的文本变为`foo`，起点不是 `\B`，无匹配返回`foo`；拼回前缀得到 `afoo`。

这是公开regex输入可触发的**静态推导**，本轮未运行复现；不能用JS RegExp替身验证/修复。应基于原文的同一captures展开，而不是截断前文后重匹配。Context引擎接入修复与该适配缺陷分开记录。

### C4测试账本与其余未闭合能力

- TESTMAP`:47-56`原10条仓储测试已pending，认可撤回虚假ported，不视为回归；物理删除期望即使改正，若仍测Double也不能恢复ported。
- **retemplate12条**（TESTMAP`:82-91,96-97`）仍ported，`tests/retemplate-contract.test.ts:11,42-83`等直接调用 `CardStoreDouble.retemplateCardsForSession`；**add2条**（`:58-59`）仍ported，`tests/add-cards-contract.test.ts:13-47` 的插入/复习入队/排序均来自Double。应换真实L16/review公开服务或pending，不豁免。
- 按实际行统计261 ported/25 pending。C3仍有未实现工具、APKG导出固定失败（`src/chatanki-executor.ts:416-418`）。C2仍缺模板CRUD的mainDb/ankiDb、sessionResources、refs/planner真实接线；`src/apkg-executor.ts:79-85`明确资源导入需要sessionResources。
- L16 `ecccdc845`候选已提供七个嵌套服务面，不能继续用“L16完全没提供”作笼统阻塞；它尚未集成，需明确合并版本并安装真实提供方验证，不将分支提供等同main消费。

**结论：C1/C2/C4引擎/C5/C6/C7均有可定位修复增量，C3及其余依赖、测试真实性、正则边界仍未闭合。全部原验收勾选保持不变；未运行测试，未新增跨平台证据。L15上一轮结论保留，不重复其静态审读。**

## C1 07:19Z：账本纠偏、真实enqueue与i64语义（正常main基线）

`f3c967eb8` / `b0ba8b75b` 已进入main；本工作树正常 `git merge --no-edit main` 得 `2f65ad2c6`，main父提交 `679fd3e4d`，未搭临时组合/混合worktree。下面源码与测试都是该正常运行基线；其他候选（包括L14 `21a99cc47`）没有摘入。此前未集成状态是旧时间点记录。

### 16条纠偏已确认

`f3c967eb8` 的实际变化为retemplate **11** 条、add **2** 条、agent-review **3** 条（合计16）；TESTMAP`:38-39,41,58-59,82-91,96`现pending，实际统计/表头`:12`均 **245 ported / 41 pending**。不是功能回归，也不是这些保留镜像测试已成为生产证据。

retemplate另1条 `test_chatanki_retemplate_batch_ui_upsert_and_fsrs_event_payload`仍ported（`:97`）：测试`:397-424`调生产UI/payload helper，块存储是ChatBlockStoreDouble，不直接验证CardStoreDouble的CAS；本轮不把它算进这16条，也不据此证明真实L04重模板整链。

### 真实enqueue：新增必要单元已入队验证

生产路径：`index.ts`创建ChatAnkiReviewExecutor → `review-executor.ts:106-144`选择/ownership预检 → 实际 `review.enqueueCardsForSession` → `getEnqueuedCards` → `fsrs://changed`。服务异常经publishedAppError保留结构、事件在返回成功写入结果后发送；对照Rust `src-tauri/src/chat_v2/tools/chatanki_executor.rs:3336-3399`。

用例 `tests/real-review-enqueue.test.ts:36-128`安装真实native/anki/review/L07/chatanki及SQLite，调用 `ctx.chatankiTools.execute`，断言：第一遍写1条真实FSRS state、stateId区别于cardId、事件payload/runId；第二遍skipped1、无额外事件。这是有效的L24→真实L15入队证据。

**范围限制**：`:79-87`卡片ownership/preflight仍由CardStoreDouble提供；settings/llm使用测试对象，未从L04 registry派发此用例。它不能证明真实L16卡仓储、完整registry上下文或undo/suspend双CAS端到端；不得拿临时组合报告替代当前main消费。

按全局队列执行，原命令及result输出：

```text
node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs submit -- npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/real-review-enqueue.test.ts --maxWorkers=1 --no-file-parallelism
作业号：20261104073232-d72dbf

node /home/dsdev/dev/deep-student/scripts/electron-migration/jobs/job.mjs result 20261104073232-d72dbf
Test Files  1 passed (1)
Tests       1 passed (1)
Duration    18.28s
[作业 20261104073232-d72dbf] npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/real-review-enqueue.test.ts --maxWorkers=1 --no-file-parallelism
[作业 20261104073232-d72dbf] 退出码 0；完整输出 /home/dsdev/.oc-jobs/done/20261104073232-d72dbf.log
```

result完整输出没有Errors段/未处理错误；仅有WASI ExperimentalWarning，未把warning混作errors或省略已有Errors。此为R5本轮亲自排队的正常集成基线测试，不引用提供方测试代替。

### 新CAS入口的SafeInteger拒绝不等价

`src/executor-args.ts:67-85`的requiredInt使用Number.isSafeInteger。`tests/review-executor.test.ts:220-235`传 `Number.MAX_SAFE_INTEGER+1`并断言失败/不触及CAS，确实把更严格的拒绝写入测试。这个值 **9007199254740992（2^53）本身可用JS double精确表示，且属于Rust i64合法非负范围**。Rust `ChatAnkiUndoLastReviewArgs/ChatAnkiSetSuspendedArgs` 的 `expected_review_version:i64` 及normalize只做非负校验（`chatanki_executor.rs:1178-1215`）；正确后续可能是版本冲突，不是参数类型失败。

依D3，内部版本比较/数据库读写必须精确，不能通过拒绝合法wire值掩盖精度问题，也不能将内部版本先转Number比较。该新增分支已由C1派回，本轮静态确认并纳入C3未决；没有把“更安全”的测试通过当等价证据，也没有再运行已知错误期望的测试来制造绿灯。

结论：新增16条pending纠偏认可，session enqueue主写入/事件局部实测通过；C3剩余工具/i64语义、C4真实业务替换与regex差异、其他依赖仍未闭合。勾选不变；L16/L15临时组合不等于main整链，Windows/macOS/Electron未验证。

## C1 08:06Z后继：`034d6c6fc` 只审新差异

当前审读HEAD=`6918e2340`（已保存L16单元），检查时main=`3b2758d7a`；`034d6c6fc`对HEAD/main均非祖先（exit1）。只读候选，不运行旧基线/候选内存代码，不新建临时组合，不重复全suite或已完成的enqueue作业。

### C3：SafeInteger拒绝子项已修，不外推完整i64/CAS

`src/executor-args.ts:82-101`保留Number整数检查，删除Number.isSafeInteger门槛，BigInt仅做[-2^63,2^63-1]范围判定；requiredInt及nullable版本走该函数（`:67-69,120-127`）。不再拒绝已审出的2^53合法整数。测试 `tests/executor-args.test.ts:317-347`覆盖六个session/library变更参数接受 `2^63-1024`、拒绝2^63越界；`tests/review-executor.test.ts:220-244`验证向review方法透传。

认可具体输入门槛修复。后一个测试仍为ReviewBoundaryDouble，不是实际L16卡/真实review CAS；BigInt(number)也不能恢复更早JSON.parse已丢的精度，因此不能以这项范围判断证明内部数据库版本/比较已全部精确。依D3保留wire边界与内部表示的区分，不要求以新校验拒绝合法请求。

### C5：info→单次start→终态顺序已修

`src/result.ts:9-14`先info后start，与Rust `src-tauri/src/chat_v2/tools/chatanki_executor.rs:1873-1883`一致。`tests/tool-lifecycle.test.ts`新增完整日志文本/顺序和start次数断言，覆盖正常analyze和参数失败入口；不再将旧“start在info之前”用作该候选的未修结论。真实块持久化/完整registry链仍未在本轮验证，原C5整项勾选保留。

### C4：左边界已修，分配闸门不能用事后拒绝替代

1. **已修**：`src/transform.ts:512-524`捕获展开在完整before上replaceAll，不再按match.start切片；新增 `regex_replace_expands_captures_without_losing_left_context`（`tests/transform.test.ts:137-142`）直接用真实F7引擎断言 `afoo + \B(foo) + <$1> → a<foo>`。原左边界反例对该候选已失效，保留为历史而非最新未修问题。
2. **未修**：F7未提供 `replaceAllProjected`（对候选 `host/platform` 的检索无实现，`host/platform/native/regex/api.ts:34-49`仅既有replace/replaceAll）。实际fallback在`:521`先取得完整输出字符串，`:522-523`才比对bytes上限；Rust在 `chatanki_transform.rs:562-590`逐次预检并遇超限立即return，`:592`才物化结果。
3. **最小已支持输入**：front为2048个`a`，pattern=`(?s)(.)`，replacement为`$1`重复1024次（替换串2048字符，小于4096上限）。候选先生成2MiB文本，再因1MiB阈值拒绝；Rust累计到首次超限即返回，不分配该2MiB结果。候选error.bytes为完整2MiB，Rust是首次超限累计值，也不必相同。新增测试 `security_capture_expansion_growth_is_rejected_by_full_text_result`只断言最终throws/bytes>阈值，不能证明分配前停止。
4. **声明能力不构成保证**：`api.ts:580-591`可选replaceAllProjected只收pattern/text/replacement，返回 `{value,bytes}`，没有caller limit/早停契约且尚无生产实现；不能声称它已恢复提前停止。本lane应与F7按原bounded_regex_replace所需的最小公开能力补齐，不能以同源引擎或最终拒绝替代原内存增长保证。无capture分支仍边累计边拼输出前缀（`:493-509`），也不能表述成完整Rust“全预检后才分配”。

此轮不跑增长样例，避免为静态已确定的先分配路径制造无必要负载；没有新建泛用正则框架。C4整项保持未勾选。

### 证据来源与状态

- C1核实的提供方local临时组合结果：作业尾号 **075253-b63b15：8 pass/exit0**、**075440-1e237f：3 pass/exit0**。本轮未重新取其result、未独立运行；指令未给完整命令/Errors原文，不补造。它们不是main组合或真实L16/CAS验收证据。
- 候选TESTMAP表头244 ported/42 pending，当前正常运行基线仍245/41，二者不混用；未在本轮重新审计全部账本。
- 所有勾选不变；C3/C5已修子项被认可，C4分配前保证/真实消费者及其他未决仍开放。Windows/macOS/Electron未验证。

## v2 main复验：`d414183bf`（2026-11-04）

本次正常main合并已含 `034d6c6fc`，上文“非main候选”为历史状态。当前TESTMAP为244 ported/42 pending。C1按实际旧名修复签收；C3大i64门槛、C4左边界、C5日志顺序已进入本次main基线，不能继续称仅候选修复。

独立作业 `20261104105734-f5cb83`：
`npx vitest run -c vitest.host.config.ts host/plugins/review host/plugins/anki host/plugins/chatanki --maxWorkers=1 --no-file-parallelism`

**86文件通过/2文件跳过；1200 passed/13 skipped；Errors 1；exit1；539.77s**。原错误为 `[vitest-worker]: Timeout calling "onTaskUpdate"`，完整输出 `/home/dsdev/.oc-jobs/done/20261104105734-f5cb83.log`。这是验证基础设施阻塞，当前没有业务失败断言，不推定业务全部正确。`real-host-wiring`、`transform`、`tool-lifecycle`分别报告1/33/7通过；总作业不算绿。

- C1仅旧名启动缺陷已签收，C2完整hydrate及L16消费者未签。C3范围校验修复认可，真实CAS/所有权不由Double证明。
- C5 `src/result.ts:9-15`确认info→start，与Rust一致；现有真实registry测试的L04 emitter/saveToolBlock仍由测试回调提供，保留完整消费者证据限制。
- C4仍不能签分配前闸门。F7通知明确当前API/预编译操作面缺captures_iter/replace_all_projected；其两项Node/Electron各9pass是提供方匹配语义证据，不是本轮独立运行或有界分配证明。所需最小primitive需原文captures按gap/展开/tail逐项检查，首次超限bytes及WASI32显式u64，之后才物化。
- C7真实review错误映射子项已集成并由该文件执行，但card preflight仍Double；不签完整读取/CAS链。

### C3/D3新增P0证据（C1正式交接）

`342c61556:tests/review-executor-real-l15.test.ts:19-24,80-95,152-163`静态核实：大数由`2**63-1024`降为`Number.MAX_SAFE_INTEGER-1`，成功路径version()仍以number读库；新增拒绝用例以bigint写2^53+1，却以MAX_SAFE作expected，并要求超JS精度范围的Database错误。该错token原本应Conflict而非成功；问题是错误类别与合法库值可读性被改变，且原合法大token成功向量被删除。最后CAST TEXT验证无写入值得保留，但不能抵消缩向量。

对应main `review/repository/fsrs.ts:888-909`及`src/review.ts:58-59`的限制已被独立只读核实，正式关联R7/L15-V2-S4。D3要求内部精确比较/绑定，wire JSON数字表示不授权拒绝请求。恢复原向量后须用精确SQL回读验证递增；CardStoreDouble的L16预检限制仍存在，真实L15测试不等于完整L16链。此轮没有运行候选或Rust，未将提供方5pass说明当签收。

### C3/R7 c5c8ce42c：向量已恢复，运行时skip仍削弱保证

检查时该候选非HEAD/main祖先，tip自身只改BLOCKERS；按完整树`tests/review-executor-real-l15.test.ts`审读。`:25-28`恢复`2**63-1024`、`9223372036854774784n`及精确+1字符串；`:104,159`以bigint绑定SQL，`:116-117`CAST TEXT回读，`:130,138,146,168`精确检查+1/冲突不写。前版“合法值应被拒绝”的新增测试已移除，以上改进明确认可。

但`:36-46`新增三类错误子串与skip helper，`:125,136,163`在suspend正向、stale场景首个变更、undo正向的success断言之前调用。L15任一已知JSsafe拒绝即可跳过后续成功/精确状态断言；stale场景甚至不会执行真正的stale调用。说明文字blocked不使这些路径成为通过，不能以“只跳过已知错误”恢复原测试保证。

按C1既有派工，helper和三处runtime skip须现在移除，保留正向失败以暴露L15两处缺陷；不新增兼容层、不改为等待owner修后才删skip。候选提交自述job`20261104144539-6840fb`为1pass/3skip/exit0，本轮未取result或重跑，不记为三条真实CAS成功。原L16 CardStoreDouble限制仍在，R7/C3继续开放，待正常main后最小复验。

后续独立静态核对L15 `a0515bf75`确认owner使用完整bigint CAS链，具体见review R7增量。已取**提供方**`20261104150540-a52cf7` result：原四条L24组合2pass/2fail/exit1，失败行99/125的实际值`9223372036854774785n`与旧number期望不相等；success、mutationApplied、stale status/error已先通过。**该运行树测试`:15-17,55-60,77`直接new ChatAnkiReviewExecutor/new FsrsReviewService并注入reviewStates，不是ctx.get('review')的公开provider/hydrate链**。该快照旧文件随后SQL number断言尚未执行，不能把未到达的SQL oracle也计通过；应同样恢复精确回读。正确的表示修正不是弱化原断言，缩小2^63-1024输入或按旧错误文本skip才会掩盖缺陷。此证据不同于c5的runtime-skip版，仍保留真实L16预检Double与main未集成限制。

### 48063ba9b撤skip核实，返回快照断言仍须补回

短SHA已解析为`48063ba9b06c48b6ea9161e53d6e5bdbcc8d5504`，检查时非HEAD/main。diff确认skipOnL15PrecisionDefect、错误文本表及三处调用全部删除；不再把旧c5运行时skip当该后继仍有的问题。

该候选`tests/review-executor-real-l15.test.ts:102-125`现在直接要求success/status/mutationApplied并核SQL TEXT，但缺原旧版`:99,125`对成功输出reviewState.reviewVersion、冲突输出current.reviewVersion的保证。应按D3恢复精确`LARGE_SQL+1n`，同时保留SQL递增/不写与最外wire数字断言。L15旧组合所证明的内部bigint正确，不能替代此新版公开provider链的回传验证；该新版未在本轮运行。C1已派补两断言，R7/C3仍不关闭。

### de19f72a0输出保证已补，API类型仍未齐

检查时非HEAD/main。候选测试`:111,132,155`恢复成功、stale current及undo的reviewVersion===LARGE_SQL+1n；`:114-118`通过真实kernel.toWireJson再JSON往返断言wire Number，并重新检查原内部快照仍bigint。原2^63-1024输入、SQL bigint/TEXT/+1/stale不写及48063撤skip全部保留；旧“缺两个输出断言”不再适用于该后继。

但同候选`api.ts:173`快照reviewVersion仍number，`:234`session删除仍number|null，`:507,510`suspend/undo仍number。这些是内部服务类型，不可拿Tauri最终wire number作为理由继续限制。L16 `a47f42ded`的typecheck job `20261104150842-c6c169`已由R5取result，唯一TS2322指向保留的L24SurfaceCompatibility；不能移除保证使类型检查变绿。提供方`review-version-i64`5pass中wire例注入L15快照，不等于三方真实owner链完成。当前只静态认可新断言与L16精度差异，待正常main后最小公开链/删除事务复验，无新运行作业。

### 6962cbfed公共API/consumer对齐及候选内存类型证据

检查时`6962cbfed`、前序`e8b2046c1`均非HEAD/main。静态确认api.ts快照reviewVersion为bigint，scoped CAS为number|bigint、删除为number|bigint|null；`executor-args.ts:68-70,97-103,123-129`保留输入整数形式，以BigInt检查完整i64，六个session/library decoder的字段类型同步。nullable的缺失/显式null语义保留，没有回到MAX_SAFE门槛或把内部bigint转number。de19的精确返回断言、原大数范围与无skip保证保持。

已取**提供方**`20261104152119-274d84`：executor-args/review-executor/library-output/card-repository-contract/agent-review-contract/add-cards-contract六文件，**44pass/exit0，无Errors/Unhandled段**。测试覆盖2^53+1、2^63-1024+1、i64MAX的解析/投影/事件payload及wire副本；review-executor仍用ReviewBoundaryDouble，命令不含review-executor-real-l15，因此不是公开L15联合验收。

已取`20261104152119-87836d`：正式`npm run typecheck:host` **exit2**，仍是旧L16树的service-surface.test.ts:210兼容断言。不得因L15/L16/L24各自依赖树单跑红而删除断言；本轮仅认可候选协议在源码上已对齐。

另已取**候选接口证据**`20261104153009-ff06f8`：L16输入`1df97b515`，从原测试AST抽取两份type-only import、原七项L24SurfaceCompatibility及原布尔赋值，仅compiler host.readFile内存提供`6962cbfed:chatanki/api.ts`；noEmit、无磁盘写入、未执行provider，**diagnostics0/exit0**。完整argv已读，确实没有替换工作树文件。它只证明这组候选接口兼容，不能覆盖上述正式tsc exit2、dirty前置或当作真实三方组合；报告提交`b789b9954`亦非main。

后续只在正常同批main上做chatankiTools.execute→hydrate→公开review服务及真实Anki删除的最小验证，保SQL TEXT、内部返回bigint、stale不写、最外wire和原对象不变。不在当前旧依赖树重跑已知class组合或全量。

### a61798e9f真实卡owner组合与PreferenceEntry.subject独立子项

`a61798e9f`删除D3测试CardStoreDouble及context.cards/reviewStates注入，使用实际公开anki.documents创建任务/绑定会话、anki.cards插卡，chatankiTools.execute经hydrate取实际owner；de19输出bigint/SQL TEXT/+1/stale/wire及副本不变断言保留。检查时非main，原旧CardStoreDouble限制不再用于该后继测试，但其它测试旧证据仍按版本保留。

已取**提供方临时组合**job `20261104161159-6893df`，cwd `l15t_combo`，两个文件 **5pass/exit0，无Errors/Unhandled段**：review scoped consumer1＋新真实公开卡owner D3链4。C1交付组合版本L15 7f9e63ea1＋L24 a617；临时目录已移除，R5不重建/重跑，不将整个job误记4例或升级正常main联合验收。另4个AP helper不可达问题按架构/X6待裁定pending口径，不纳这4条D3运行范围。

PreferenceEntry.subject为单独decoder子项：`0a18bca11`把缺省subject视为null，符合Rust `anki_preference_memory.rs:124-135` Option<String>，subject:1仍拒绝；测试不再把合法缺省当负例。`5eda95098`等前序真实Host用例通过chatanki_update_card→L04 preflight→L16 cards/preferenceMemory→生产settings持久化，断言卡片更新、无missing-subject warn、原条目不丢且subject=null。仅未调用的vfs/llm给空值，卡片/偏好算法与存储没有替身；不外推全部f32/i64持久化。

已读提供方红测`20261104161559-921b7e` 1fail/exit1，日志明确missing field subject warn；已取`20261104161712-be0b20`三文件17pass/exit0，无Errors/Unhandled段。两代码SHA仍非main，候选修复认可，待正常main最小复验。正式旧`20261104162342-60dc04`仍388pass/3fail/exit1（三条旧L15大i64拒绝），不由临时5pass或subject17pass覆盖；后续391pass新依赖结果另记。类型旧:210与各receipt适用tip保持。

### canonical review类型25c1c30ce / 9178ca2b6

独立静态核对实际api变更在25c1c30ce：FsrsAgentReviewStateSnapshot/MutationOutcome直接从review/api导入并再导出，latestReview类型取NonNullable，ChatAnkiReviewStateService改Pick必需getReviewStatesForSession与Partial<Pick>可选入队/变更面。没有把bigint退回number、添加兼容旧错误的skip或修改L16:210断言；可选方法仍须由既有执行器缺面报错路径处理，官方type引用不等于runtime方法自动存在。

已取提供方`20261104170120-fd00da`：real-l154＋library-output5＋review-executor8，**3files/17pass/exit0，无Errors/Unhandled段**。其中真实公开CAS4保L16 documents/cards fixture、SQL TEXT、成功/冲突/undo返回bigint及wire副本/原值不变；另外两文件并非新增真实owner联合用例。旧391pass证据未重取，正常main仍待L16/L24类型与实际组合一致，不自动签C2/C3。

### C2 retemplate Phase2：正式L02 raw入口候选复核

实际adapter在73a23e3dc，公开内部类型/报告在cbd4b027e，检查时均非HEAD/main。hydrate直接解析已main的`llmRawPrompt`服务，调用`callModel2RawPrompt(prompt,null,'anki')`并将assistant_message投影成该lane内部assistantMessage；不复制模型配置、adapter选择、重试、audit/usage。原内部无用systemPrompt参数删除，retemplate-executor:292先完成repo.retemplateCardsForSession，再:311执行fill，匹配Rust `chatanki_executor.rs:4435-4461`的后继model2(prompt,None,Anki)调用。

真实测试通过chatankiTools.execute('chatanki_retemplate',fill_missing_llm)，F4 secrets/settings、L01 provider adapter、L02 raw、L04读取preflight、L16卡创建/所有权/CAS均实际装配；只把远端替为本地HTTP，断言一次/v1/chat/completions请求、JSON response_format、fill计数、template_id及Example持久字段。VFS有未调用的注册占位，事件/块回调为观察函数，因此不声称完整VFS或UI生命周期链验收。

2f73fd1d5只将fixture模型local-fill改gpt-local-fill，保response_format原断言。Rust `provider_quirks.rs`的gpt-*条件及`model2_pipeline.rs:9074-9075`force_json条件支持此输入前提修正，不是削弱断言迁就缺字段。

已核提供方红测20261104173849-92ae22 **1fail/exit1**（LLM manager not available for fill_missing_llm）→已取20261104174709-2dbf86 **1pass/exit0**；已读全lane20261104175148-498e47 receipt/summary **45files/392pass/exit0**，无Errors/Unhandled段。官方selfgate receipt cbd4b027e/basee87727c09 **ok=false，仅typecheck失败**，不得写全部门禁绿；旧L16:210类型、A5真实宿主依赖装配另保留。

正常main后只复验该原入口最小正向与必要错误边界；Planner/VLM的高层角色task/配置重验/fallback仍未交付，不能由此签C6或所有执行器。本轮只读候选/取既有结果，无APKG/785或全量重跑，不向失败reviewer代派/代签其它域。

### 077bf139c仅增强真实入口测试：Phase1保留与并发CAS

检查时非HEAD/main；diff只含测试与LANE/SPEC，没有owner或生产实现修改，原成功场景全部断言保留。一个`it`内依次执行成功fill、坏响应、竞争写三场景，不能把配套三文件7pass称为7个端到端场景。

坏响应场景在HTTP回复前经真实L16 cards读取Phase1快照，检查目标模板与版本已经更新；响应无JSON后逐字段核fillStatus/错误/计数，并以最终整卡等于该已提交快照证明不撤销Phase1，符合Rust chatanki_executor.rs:4432-4461。竞争写场景在请求期间经公开updateCardIfVersionForSession用Phase1版本写manual Example，要求owner返回updated；fill输出conflict/version_conflict及winner.version，最终整卡等于winner且不覆盖manual字段，对应:4466-4472及原测试:18489-18495。

HTTP回调捕获的interleaving异常存入数组，两个新场景都断言数组为空，并断言快照/竞争结果数量恰1，不能把catch误读为吞掉测试失败。fixture仅将两张新卡front区分开避免真实owner同内容去重，保留insert长度1断言，不改去重实现。

已读提供方receipt/log：`20261104182107-f101ff` **1fail/exit1**，明确在新fixture插入后返回[]而非1处失败；`20261104182455-4fc8cd` **3files/7pass/exit0，无Errors/Unhandled段**，分布为真实入口1＋retemplate-fill3＋mutation-executor3。官方receipt077bf139c/base01c074ecf **ok=false、仅typecheck失败**，旧L16:210未动。只认可C2/C7所述测试增强；main后原入口必要场景独立复验，A5真实依赖装配、Planner/VLM、VFS占位和完整UI事件链均不搭车关闭。

### X6-AP-0187：8055938c2真实owned snapshot入口候选

代码仅新增owned-snapshot-real-host.test.ts，ce0ee3541为报告；检查时两者非HEAD/main。对照Rust chatanki_executor.rs:15084-15137逐项核对16个原断言：真实insert返回5；第一页total/len/两个ID；尾页len/ID；越界空页；error_only total/两个ID及原全局index2/4；edited_only total/两个ID，均保留原输入结构和期望。

fixture经公开L16 documents建任务/绑定session、cards插入5张卡；调用chatankiTools.execute(get_cards)，context没有cards/reviewStates注入，由hydrate消费实际owned-read/review-read。llm:{}是该路径未调用的注册依赖，UI回调仅观察；这证明所列读取/分页过滤设计，不扩为LLM/UI/全部工具或reviewVersion数值链。

已读提供方receipt/log `20261104184905-218327`，命令只含新owned-snapshot文件和旧executor-args：**2files/17pass/exit0，无Errors/Unhandled段**，其中新真实case仅1，另16为旧解析用例。旧helper测试未删，GENERATED/TESTMAP未改；另四条helper不可达事项不因新增此用例自动修复。原官方typecheck旧L16:210未绿状态保留。

沿AP0187/C1原真实性子项认可候选增量，正常main后只跑该真实入口必要场景；不扩大偏好f32/i64、A5联合或整D3。本轮未运行候选/全量，C1的185145463精确测试文件集成请求仅作交接状态，不替owner削断言。

### C2/C7 JSON export：3e553386f真实入口候选

初始新测试c1b106114、后继3e553386f检查时均非HEAD/main；diff只有测试/说明，没有owner或生产变更。两case安装真实Anki/review/chatanki，经公开documents/cards建会话/卡片，chatankiTools.execute hydrate真实读取和L16 saveJsonFile→writeJsonToTemp；context未注入卡仓储或sink。llm:{}只是未调用依赖、生命周期回调只是观察，不能称LLM/UI全部真实验收。

对照Rust chatanki_executor.rs:15558-15642与15646-15700：library显式选择跨会话两卡仍允许，保持请求顺序、cardsCount/format/status及无documentId/cards输出形状，导出front/hint/template字段原断言齐全；新增完整JSON等于实际owner rows。包含软删卡的选择整体失败且library_cards_unavailable，新增比较导出目录无新文件、旧文件内容不变。document选择拒foreign session/statusNotFound，仅owner成功并保documentId/hiddenOverLimitCount及导出数量/id/front断言。唯一直接SQL是原Rust同式软删fixture，不用它实现被测选择/导出逻辑。读取跨会话显式库选择不等于授予跨会话写权限。

已读提供方`20261104193106-6af59a`日志：**1fail/3pass/exit1**，失败在导出目录快照相等，diff为共享系统tmp的F7临时文件变化。3e553386f只将paths.os.temp指向该case私有目录并整理缩进，sink/no-write断言均未改，认可隔离修正。已取`20261104193345-c0d09e`：export-real-host新2＋export旧2，**2files/4pass/exit0，无Errors/Unhandled段**；不是4条新增端到端用例，旧失败仍保留。

官方4/5、旧L16:210 type2按owner/C1记录保留，本轮未把这份作业当正常main联合或全部gate通过。C2/C7只认可JSON导出测试真实性/所列错误边界增量；正常main后最小复验这两个原入口，不签APKG、写权限、A5或全域，未修改GENERATED/TESTMAP或重跑全量。

## 1e80f32b4正常main：对应原入口窄签收

统一独立job **20261104203909-c2516b**原始exit0，无Errors/Unhandled；四目录160files/1709pass/1外部APKG skip，官方四项全绿。此表签认已逐分支/逐断言静态审过且本轮实际运行的范围，不把整个C2–C7全勾：

- [x] **C3/R7 D3公开链**：review-executor-real-l154条通过，实际L16造卡/owned-read，review owner完整i64 CAS；保2^63-1024、bigint SQL绑定/TEXT精确+1、返回updated/current/undo精确bigint、stale不写及wire副本不改变内部值。canonical类型与L16兼容断言本轮正式tsc通过。
- [x] **C2/C7 retemplate Phase2 raw入口及两负向子项**：retemplate-model2-real-host1个it内3场景通过，包含原成功fill、HTTP坏响应不撤Phase1、真实owner竞争CAS返回winner且manual Example不被覆写。F4/L01/L02/L04读取/L16 CAS真实，远端本地HTTP；VFS未调用占位和UI观察限制仍在，Planner/VLM未交付不搭车关闭。
- [x] **X6-AP-0187真实owned snapshot分页/过滤**：1条真实case执行原16断言，首/尾/越界、错误卡原index、edited筛选及真实insert数均通过；不把另4条不可达helper TESTMAP自动升级。
- [x] **C2/C7 JSON export两入口**：export-real-host2条通过，显式库跨会话读取的顺序/完整row、软删选择整体失败无新文件/旧文件不改，document selector拒foreign/允许owner；私有tmp隔离保原sink，未扩大写权限/APKG范围。
- [x] **PreferenceEntry.subject缺省子项**：真实update_card链1条通过，Option缺省null、卡片编辑与原偏好保存、无missing-subject warn；其它持久化f32/i64尚不签。
- [x] **C4 capture预检接缝子项**：同轮transform33条通过，结合独立F7 projected11向量及原算法源码，原capture后分配缺口闭合；无$常量分支/其它脚本与UI保证不一概关闭。

完整业务仍不通过：Planner/VLM、全部工具/未决测试、常量替换分配保证、完整L04事件等按原finding保留。旧A5依赖失败、number断言/类型2与候选green均不抹去，但不再当本轮main现状；本次不需要另跑这些已通过入口。

### 正常main 1e80f32b4：联合修复已集成，原生capture预检独立通过

本轮main父5b1b19055已含此前L16 a47、L15 a0515、L24 canonical/真实CAS、retemplate077、AP0187、JSON export3e553、cloze5e05及LP0060/61，按实际祖先关系核实。已启动统一lane-gate覆盖相关消费者文件，未另跑相同目录；结果尚待返回，不把此前候选绿灯充作此次通过。

F7新增replaceAllProjected不在四目录gate范围，因此仅补一项必要独立小组：`20261104204101-dfb236`，`npx vitest run -c vitest.host.config.ts host/platform/native/tests/regex-projected.test.ts --maxWorkers=1 --no-file-parallelism`，**1file/11pass/exit0，15.86s，无Errors/Unhandled段**，有WASI ExperimentalWarning。测试经真实native插件公开服务覆盖原文左边界、捕获展开、gap/tail首次超限、UTF8长度和超限不返回value；使用已发布WASM，R5未编译或运行Rust测试。

静态对照原Rust chatanki_transform.rs:552-594与F7 regex_engine.rs:198-227：在原文captures_iter上按gap/expanded独立饱和累加u64，首次超limit返回当时bytes，tail也先检查，全部通过后才replace_all。L24 transform.ts:517-524传原文及max(1MiB,inputBytes)，透传首次超限bytes。认可原capture后分配反例的接缝修复；native11条不冒充所有工具/UI消费或常量分支保证，C4整项保持开放。

此前enqueue单次独立通过证据继续使用，没有重跑；本轮也没有重跑提供方728条。整体结论仍不通过。

## C4正常main650ddffbe独立窄复验（2026-11-05）

正常`git merge --no-edit main`快进至固定`650ddffbef3c755dce9fc3b3eb2fe5502bf72382`；独立核实3423a821c、7c6df8295、c91904d99、1093329fd、54e138f45均为祖先，核实际树而非用其它后继未合入推断C4仍缺。仅审原C4新增差异，不沿用供方52/407、旧native11或旧1709作为本轮运行证据。

**静态闭环**：`index.ts:318,425-426` hydrate真实nativeRegex → `transform-executor.ts:555-556,637-661` async编译/计划后dry/apply → `transform.ts:483-502`统一`replaceAllProjected(matcher, before, replacement, max(1MiB,utf8Bytes(before)))`。原无`$`常量findIter/前缀拼接及capture后置replaceAll fallback均已删除；`api.ts:572`能力改为必需。F7 `regex_engine.rs:189-227`按原文captures逐gap/展开/tail饱和累计u64，首次超限返回bytes，无value，全部预检通过后才replace_all，对齐原Rust `chatanki_transform.rs:477-594`。常量与capture共用该生产入口，原分配前闸门缺口认可修复。

**独立作业** `20261104230316-7884d4`，cwd本lane，固定上述正常main：
```sh
npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/regex-projected-real-host.test.ts host/plugins/chatanki/tests/transform.test.ts -t 'C4|regex_replace|bounded_replace|security_(regex|capture|projected|shrinking)|ops_apply' --maxWorkers=1 --no-file-parallelism
```
原始结果 **2files passed、23pass/21skip（标题过滤，非缺陷skip）、28.36s、exit0，无Errors/Unhandled/FAIL段**；WASI ExperimentalWarning保留。前文件11条全执行（8个primitive向量＋JS limit域1＋legacy计数1＋真实工具链1），后文件12通过/21过滤。原log/receipt在`/home/dsdev/.oc-jobs/done/20261104230316-7884d4.{log,json}`。

- 真实工具经native/chat/anki/review/chatanki、真实建卡与仓储读取；测试`:149-167` capture dry/apply均拒绝，首次超限**1049600**而非最终2097152，返回细节及完整卡快照不变。常量`:150-156`只测dry_run，首次超限**1052672**而非最终8388608，数据库不变；常量apply只有共用计划路径静态依据，未冒称动态覆盖。
- `\B(foo)`保留原文左上下文，正常apply确实写入；`$$[$1]`第三向量`a$[b]c`为**6 bytes**。无value失败、旧超长保持/收缩、foreign-session权限拒绝原断言均保留并执行。工具一条it内多场景不计成多条独立E2E；VFS/llm为未调用注册占位，UI为观察回调，不由此签完整L04事件。
- JS limit仅非负安全整数（0/MAX_SAFE接受，负数/小数/超safe拒绝），不等于引擎u64全域。legacy UTF8修正`:58-80`使用真F7 capture数据后注入固定match，只验证`中$1`/`$1😀`计数3/4字节，不证明同步生产provider；transform另两条projection forwarding用例仍仅是转发检查。

**范围结论**：签认本次async常量预检/fallback删除和上述真实工具场景；C4整体脚本/平台仍不勾。4c0cbd520/8463031c3经祖先核验仍非本轮main，`card-access.ts:15`仍本地Map；早期workspace-read-scope fixture不代表L05 owner，AP0189新scope消费与完整worker生命周期排除本轮。D3/A5等既有签收保持。实现/测试/SPEC/TESTMAP只读，未编译运行Rust。

按§5，先提交本报告再merge main并运行官方lane-gate；此定向exit0不替代该官方门禁，最终固定tip与结果以新官方收据为准。

## AP0189/C3 scope正常main窄复验（f821b3733，2026-11-05）

正常merge固定`f821b37337d90b0d256f072ffbf5bc0c3487d526`；独立核实e2d6b27a2、4c0cbd520、8463031c3、5a09dc0e3、56eae1110及已签C4 c4d5744cd均为祖先。上轮650基线的“scope未main/本地Map”仅保留历史，当前`card-access.ts:6,29-37`已删除重复注册表并读取L05 `api.workspaceCardReadScope`。L05公开导出`:91-94`落到`src/workspace/card-read-scope.ts:17,50-72`单一注册表，测试从同一公开api手动安装trusted scope并release。

**独立作业 `20261104232824-eb4b09`**：`npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/workspace-read-scope-real-host.test.ts host/plugins/chatanki/tests/workspace-read-scope.test.ts --maxWorkers=1 --no-file-parallelism`。固定上述main，**2files/6pass/0skip（无标题过滤）、20.71s、原始exit0，无Errors/Unhandled/FAIL或warning段**。原metadata/log在`/home/dsdev/.oc-jobs/done/20261104232824-eb4b09.{json,log}`。真实Host文件1条，旧CardStoreDouble文件5条，不能把6条全称真实链。

- [x] **AP0189/C3 scope读授权消费与写不放宽子项**：原Rust `chatanki_executor.rs:16345-16384`六项在real-host`:54,63-71`逐一保留：真实insert为true、读预检返回coordinator、verify写预检拒绝、load写预检精确statusNotFound、真实session CAS返回notFound、front仍before。`:78-94`进一步经真实`chatankiTools.get_cards/update_card`验证授权读成功、worker写拒绝、完整返回卡行快照不变，以及L05 guard.release后同一读入口撤权且行仍不变。只有1个it内多场景，不扩增E2E数量。
- 生产接线：`get-cards-executor.ts:83-107`解析有效readSession并用于L16卡读取/L15状态读取；`mutation-executor.ts:200-226`始终用原worker `ctx.sessionId`做load与CAS。L16 `repository/chatanki-surface.ts:260-271`在真实immediate事务中先检查完整文档所有权，非owner在UPDATE前返回notFound。对应Rust `:1798-1836`由agent侧唯一注册表提供读例外，写路径不查询scope。
- TESTMAP`:42-46`仍指向旧5条CardStoreDouble测试；本轮这5条只证明helper在真实L05注册表下的分支，跨workspace/混合归属等不冒称全是真实SQLite工具链。新增real-host以真实native/anki/review/chatanki、数据库和L05 installer运行，llm为未调用占位，事件回调为观察；未安装或驱动完整L04 worker创建/取消/异常生命周期。手动trusted scope前提保留，不把workspaceId字符串校验当实际worker归属验证。

- [ ] **AP0189/C3日志残差（静态，独立于上述授权子项）**：Rust `:1826-1832`命中scope时记录worker/workspace/coordinator/document的info；当前`card-access.ts:33-35`直接返回，无对应日志。Rust读预检调用`verify_document_ownership`，数据库错误走`:1783-1789` warn；TS读路径使用`:40-44`独立helper并`catch { return false; }`，未记录warn。本轮未注入数据库异常、未做日志动态断言，不宣称日志等价；fail-closed授权结果不因该日志差异被扩成权限放宽。

签收仅限上述AP0189/C3授权子项；C3整体、日志残差、L04完整worker生命周期、AP0188库列表、新L16 agent-page缺口仍未签。C4原23/407与其官方c4d/base650收据保持历史独立，本轮未手动重跑已签C4/旧1709。实现/测试/SPEC/TESTMAP只读，未运行Rust。提交报告后按§5 merge main并执行官方gate，定向6pass不替代新门禁。

## AP0189/C3两处日志残差复验（正常main f2d5b6c46，2026-11-05）

正常merge固定`f2d5b6c4653200c4c9edfcb4ba9d948d303cc492`；31554ea96、bbbabfab8、2a8c03323、9ee3dcb96均独立核实为祖先。旧scope授权6条与C4 23/407不重做，本节仅核上一节info/warn残差。

静态路径：`get-cards-executor.ts:84`/`status-executor.ts:80`把现有ctx.warn/info传入`card-access.ts:29-52`；direct-owned直接返回不记hit；读helper复用verifyDocumentOwnership，false不记warn，每次查询异常恰经`:19`一次warn后仍按原顺序尝试coordinator，只有scope成功才记含worker/workspace/coordinator/document的info。对齐Rust `chatanki_executor.rs:1775-1836`。注册wrapper `index.ts:217-227`经adaptContext/hydrate，snake_case上下文在`:303-304`使用真实Host logger。

指定独立job **20261105014748-26f08b**：`npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/workspace-read-scope-logs-real-host.test.ts --maxWorkers=1 --no-file-parallelism`。已亲取本lane原receipt/log：**1file/14pass/0skip，无标题过滤，41.46s，原始exit0，无Errors/Unhandled/FAIL或Warning段**。原件`/home/dsdev/.oc-jobs/done/20261105014748-26f08b.{json,log}`。

真实性：测试14场景为get_cards/status各7分支，使用真实agentTools注册wrapper、SQLite与Cordis logger exporter。DB.one观察器仅记录查询参数并Reflect.apply原调用，无伪造行/错误；列重命名产生真实SQLite故障。精确trace核direct-owned无hit、false无日志、无scope异常一次warn、两次异常各一次warn、worker→coordinator顺序、hit字段及快照读取的额外查询。exporter在首warn后恢复schema是受控故障恢复，只证明后续coordinator尝试能成功，不扩成所有数据库异常或完整worker生命周期；VFS/llm仍未调用占位，事件回调仅观察。

- [x] **AP0189/C3原两处info/warn日志残差窄签收**：正常main静态接线及上述14场景均通过，上一节未勾选日志残差现由本节结果覆盖，保留历史原文。只关闭指定get_cards/status读预检日志缺口；C3整体、L04 worker生命周期、AP0188与其它既有未决保持。报告提交后按§5正常merge main并执行官方gate，14pass不代替正式收据。

## 自动续派新main：preference i64接缝仍未联合闭合（d8366166a）

正常merge得到`d8366166aa3460a310d39684c7627f4537d578ad`（main父`628b4192e3c41a54b6a62f8d386a26176f53ad7f`）。已按续派第2步启动同一官方gate，固定该tip；本节为新增差异静态审读，不借旧421/407或提供方14通过签新树。

L24 `api.ts:335-345,383`时间字段/nowMs已改number|bigint，`src/preference-memory.ts:75-76,110-150`通过JsonReader按i64读取并用原生JSON.rawJSON写精确数字词法，覆盖已记录safe限制/JSON.parse舍入问题。但当前L16 `src/preference-memory.ts:130-131,549,567`与`api.ts:203-208`仍只声明number，检索`:667-670`同分时仍减时间戳；候选`931643d80`经祖先核验exit1，尚非当前树。第五项`anki/tests/anki-chatanki-service-surface.test.ts:94,215`兼容断言仍完整，不能削成number或删除断言换绿。此为实际新main的提供方/消费者未配齐，需L16 owner正常集成，不是旧D3 reviewVersion修复回退。

新`preference-i64-real-host.test.ts`14条真实性已审：卡编辑持久化使用真实仓储，数字词法oracle用JSON.parse context.source，精确保留相邻大数/i64极值及损坏值不覆盖；部分nowMs例直接调用生产持久化函数，不都是完整工具入口。现存大数卡编辑例仅一条template_preference，未覆盖多项同分检索/容量排序；即使这些运行通过，也不能证明L16检索排序与完整API联合正确。f32出站与完整Preference域继续未签。本轮复用官方gate覆盖该新文件，不另排重复preference矩阵；原scope授权/日志和C4窄签收保持。

### 后继dde940ee2/main536aad095：L16 owner精度接缝已main

931643d80现已祖先确认，L16 entry/nowMs及API/service/adapter均number|bigint，检索同分比较改关系比较。上节d836的未集成条件已解除。独立owner job **20261105022908-0fa684**（anki/tests/preference-memory-i64.test.ts，单worker串行）**4pass/0skip、18.08s、原始exit0，无Errors/Unhandled/FAIL或Warning段**：真实公开服务核min/max强化、number混用、相邻大版本时间检索与输入逆序、65→64同分淘汰。容量store为构造输入，不冒称持久化全链。与Rust:134-135,610-621,636,701-705对应。

当前官方gate固定dde940ee2/base536aad095已完成，2026-11-05T02:31:33.930Z，ok:true/failed:[]。测试job **20261105022821-02294c**为chatanki全目录，**51files/435pass/0skip、89.83s、原始exit0，无Errors/Unhandled/FAIL段**，其中真实preference-i6414条执行通过；typecheck e7f5a2、importable16fa19、boundaries7fbf2c（前缀同20261105022821）均原exit0。未重复提交。

- [x] **Preference时间i64窄项联合签收**：L24精确读取/数字词法写回/损坏值不覆盖与L16完整时间字段、强化及触及排序/容量tie-break，在同一正常main树具备静态＋独立执行证据；不再把旧owner未main作为现状。owner4条与consumer14条分开计数，不冒称18条单一E2E。f32输出、完整serde与整个Preference范围保持未签；L16新agent-page仅提供面，L24未消费，AP0188不随此签。后续报告保存tip不同于官方被测dde940ee2。

## C2/C7原八mutation场景真实补证（18d8cb7e2/main dd564e12f，2026-11-05）

按C1纠正完成最终报告门禁后处理新增补证：正常merge固定`18d8cb7e230f35a3de66d082711018135f0dc44f`、base`dd564e12f9ced043381b3b61410a01aba38a1a1b`；a028c30da/95ed38981/18437f71c均经祖先核验为true。仅新增测试补证，未据此制造产品修复。C1转述供方首轮6pass/2fail/exit1是delete夹具误带patch，修后8pass/exit0，不是产品红绿；本节不用该供方结果代独立运行。

同一次官方gate原收据`2026-11-05T03:02:21.870Z`、ok:true/failed:[]；测试job **20261105025308-642255**，`npx vitest run -c vitest.host.config.ts host/plugins/chatanki`，**52files/443pass/0skip、113.45s、原始exit0，无Errors/Unhandled/FAIL段**，其中`card-mutations-real-host.test.ts` **8条全部通过**（10494ms）。typecheck4ba06b、boundaries683d43、importabledcc1ec（均前缀20261105025308）原code0。独立本lane已经运行新八例，故不另排同文件重复job；完整原件在`/home/dsdev/.oc-jobs/done/`。

| Rust chatanki_executor.rs原场景 | 新真实文件 | 原断言/新增生产证据 |
|---|---|---|
| 16457-16474 wrong-owner update | 98-106 | insert成功、repo NotFound、front不变；tool拒绝、完整卡对象及事件数不变 |
| 16478-16516 mixed-owner update | 108-123 | concrete-task能读但整文档load拒绝、精确statusNotFound、repo NotFound、front/version不变；tool拒绝无事件 |
| 16520-16538 wrong-owner delete | 125-132 | insert成功、NotFound、卡仍在；tool同拒绝且对象不变 |
| 16542-16572 mixed-owner delete | 134-144 | NotFound、实际SQL deleted_at仍null；tool拒绝且无事件 |
| 16606-16638 update success/conflict | 146-182 | 版本推进、stale返回赢家front/back/version及原payload字段；真实tool stale完整payload相等/无事件，fresh实际写卡且事件+1 |
| 16645-16668 normal delete | 184-204 | owned-load、Deleted、live与物理行均不存在；另造卡经真实tool删除、SQL行0及事件+1 |
| 16672-16710 stale content delete | 206-231 | 冲突current/version、原payload status/error/id/version/retryable、卡仍在；tool返回相同payload且赢家全对象不变/无事件 |
| 16714-16819 active/null与post-rate review CAS | 233-275 | 真review enqueue版本0、null冲突；真实kernel fsrs_rate后stale版本1冲突与原payload、卡仍在；tool stale刷新实际review且无事件；当前双版本公开repo成功删，FSRS state/log SQL合计0 |

- [x] **C2/C7上述八场景证据缺口窄签收**：真实L16造卡/仓储、L15 review owner、L04 chat预检、L24 hydrate工具路径均已运行；对应原assert方向与结果逐项保留，0→0n/1→1n是内部精度表示，不弱化原条件。更新/删除生产在`mutation-executor.ts:200-226,288-344`使用原session owner预检与CAS，review冲突经真实状态读取；L16 `chatanki-surface.ts:338-392`同immediate事务检查完整owner/内容版本/review版本并经L15清理后物理删。

边界：review CAS最终成功删除仍是repo调用，不说每步都是tool；未另加该最终步骤物理anki行COUNT（正常删除例已有该SQL），review例保原live读取null及FSRS state/log清零。callbacks仅观察、VFS/LLM注册占位未运行、完整UI/worker未覆盖。旧CardStoreDouble文件未动，TESTMAP对应8行当前仍pending，本报告只提供已核实证据、不越权修改账本。C2/C7整体、AP0188/agent-list、其它UI/worker仍未签。新增报告提交后再按§5检查最终tip，完成后不追加确认文档改变tip。

## AP0188/library-list新增正常main消费（f2c6d46c4，2026-11-05）

本轮自动续派正常merge固定`f2c6d46c468f57e920a55e1e59defb8dcf53f764`，新生产handler `src/library-list-executor.ts`已由executors.ts注册，index.ts hydrate绑定L16 listAnkiAgentLibraryPage及L15 getReviewStatesForLibrary；不再沿旧“只有提供面/L24未消费”描述此main。原C4/scope/pref和八mutation签收范围保持。

独立审读Rust `chatanki_executor.rs:3562-3653,12270-12292,15229-15268`及`dstu-storage/database/mod.rs:7604-7725`：工具参数归一化后明确传page=1/pageSize=20（owner默认12不得误用），owner查询先全局filter/schedule后created DESC/id DESC分页；raw locator来自同SELECT行，不以sourceId代documentId或二次查task。随后以`'agent'`域读L15状态、按cardId挂载；list错误先于review，review AppError保结构，输出不暴露sourceSessionId/sourceRef/额外flat dueMs，ratingAvailableToAgent=false。跨会话只读不用于session mutation授权。

新`library-list-real-host.test.ts`10条已逐项审读：第1条把原AP0188归一化/默认/拒绝14项语义带到真实工具；其余覆盖全局error_only过滤/分页、四schedule差别（新卡Due不排除）、真实rate/locator/version/截断、bigint total与due/review、foreign/null provenance读成功但update/delete拒绝、解析/list/review故障顺序、真实竞争删除后的NotFound结构及真实执行器名单。spy默认原调用透传；竞争例mockImplementation只在原page读取后调用真实owner删除，不伪造行或错误。SQLite故障用临时测试库改表名并finally恢复。真实native/chat/anki/review/chatanki，回调仅观察，llm/vfs占位未运行，不代表完整UI/worker或所有类型/平台边界。

官方gate **sh_1a9cb814a001L2ThjVK9miXRio**实际只有2项（HEAD=main f2c6d46c4）：typecheck **20261105034049-b14b10**与boundaries **20261105034049-455bba**原code0，receipt 03:43:40.622Z ok:true；**没有测试/importable作业**，不把这次机械绿灯当新10条执行。因此补必要独立job **20261105034440-f3bb1c**：`npx vitest run -c vitest.host.config.ts host/plugins/chatanki/tests/library-list-real-host.test.ts --maxWorkers=1 --no-file-parallelism`，**1file/10pass/0skip、无标题过滤、24.82s、原始exit0，无Errors/Unhandled/FAIL或Warning段**，原件`/home/dsdev/.oc-jobs/done/20261105034440-f3bb1c.{json,log}`。

- [x] **AP0188原14项语义及上述library-list生产消费场景窄签收**：新10例在固定正常main独立运行通过，正式API/handler/owner接线与原Rust分支相符。原“库列表无真实handler/未消费agent-page”子项解除，不扩大为全部library工具、所有serde输入或全部C2/C3/C7；跨会话session写仍拒绝的原断言保持。数值断言仅覆盖内部bigint total/due/review，不宣称本文件另测kernel wire或构造真实超大COUNT。

TESTMAP原AP0188仍映射旧executor-args helper，本报告不修改账本或把其它pending升级。报告提交后正常merge并执行最终tip官方gate，完成后不追加回执文档改变tip。

### AP0188限定范围及未决parser/计时（59451501c核对）

C1已确认并派L24处理的残差在本次正常main仍存在，不由原14语义/10真实场景绿灯关闭：Rust `chatanki_executor.rs:1276-1287`derive结构的query/search重复别名、完整六槽sequence、unit-enum map与map首错语义，当前`executor-args.ts:463-486`仍为旧对象parser（优先search并先验schedule/filter）。Rust`:1873-1883`先Instant再info/start，当前`library-list-executor.ts:23-24`在begin之后取时。以上为明确未决，不签全AP0188入站/完整C3；待owner实际后继正常main再按新差异复验，本轮未重复parser矩阵。

上一最终报告gate `56eecb90a/basef2c6d46c4`收据03:52:57.528Z为ok:false、failed:[tests]：`20261105034708-504797`覆盖anki/chatanki，**99files中98pass/1fail，1277pass/1fail/1外部APKG skip、343.05s、原始exit1，无额外Errors/Unhandled段**。唯一失败为document-processing.test.ts:454 `forced_char_split_preserves_cjk_and_emoji` 超30000ms（30581ms）；没有证据定因为CPU，也不是报告引起的断言失败。该组library-list10与generation24通过，不抹去独立专项原结果；其余三项code0。后继59451501c含新实现差异，启动新gate，不将旧失败改称通过。

## AP0188后继parser/计时修复复核（a2c74534f，2026-11-05）

本轮正常merge固定`a2c74534fa979c0c257089071c09246cadef7ccd`、main父`9c81543595ccbdb81b30bdd3b5658c043fe7e8fd`，新实现1e471b064与测试29b155fd3已在实际树。原AP0188列出的残差现有新实现差异，不沿旧main未修文本；但须实际复验才作限定签收。

静态对照原Rust `chatanki_executor.rs:1276-1304,1873-1883`及本机只读锁定依赖源码：serde_derive1.0.228 de.rs:451-505逐槽next_element/default与struct_.rs字段alias映射；serde_json1.0.149 value/de.rs:195-209先visit_seq后检查多余元素、:234-265单键enum、:328-346字符串/map入口及number.rs:582-598 arbitrary_precision typed parse。TS library-only parser按输入字段次序解码，query/search共享seen、首值null也计已出现；早期非法值不被稍后的duplicate/unknown抢先。六槽对应原字段，缺schedule/filter使用default但page/pageSize仍需槽位；variant名先于unit值校验，unknown字段名列表保query/search顺序。u32负数/小数/越界走invalid number，非数字保expected u32。未运行Rust，未通过重串行化模拟Value。

新增25个真实工具入口场景：7个alias/map首错，2个enum-map/完整sequence正向，1个全六槽归一化正向，14个短/长sequence、错误首槽、enum-map形状/variant/unit及宽度负向，另1个计时场景。原10条保留，整个文件35条。负向断言精确from_value错误且不调用owner；正向透传真实L16/L15。计时先performance.now再begin，测试用可控monotonic值让info/start消耗40/60ms，断言duration=100及info→start→error；这是时钟观察替身，不签真实耗时或所有工具生命周期。

官方gate **sh_1a9fdb4c9001HYkCK9Hn5Un4Lq**固定a2c74534f/base9c8154359已完成，receipt 04:39:33.614Z、ok:true/failed:[]。原独立tests **20261105043539-791db2**为anki/chatanki两目录，**99files/1306pass/1外部APKG skip、230.42s、原始exit0，无Errors/Unhandled/FAIL段**；library-list-real-host **35条全部通过**（7271ms），包括原10及新增25，无标题过滤/缺陷skip。typecheck312c10/boundaries79fda4/importableb15555（同前缀20261105043539）均原code0。原件在`/home/dsdev/.oc-jobs/done/`，非供方56/35证据，未另跑旧库列表/其他矩阵。

- [x] **AP0188/C3已指定alias/map首错、六槽sequence、unit-enum map及起始计时残差窄签收**：上述真实入口35条与锁定Rust源码审读共同成立，不再将这些具体残差作为当前main未修。保持from_value非from_str，不附行列/path；中间enum default与Option槽必需、invalid number与非数字类型错误分别保留。

只签此次所列输入场景与修复，不签完整AP0188/完整C3、上游数字词法与对象顺序保真、其它工具typed/IgnoredAny/endArray、f32或完整UI/worker；缺失library/review能力的动态分支未由本文件覆盖。新报告统一提交后再执行最终tip§5，gate后不追加确认文档。

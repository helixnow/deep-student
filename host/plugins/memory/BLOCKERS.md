# L17-memory-research 跨 lane 阻塞清单

## W03 HPIAS retrieval 收口（2026-11-07，优先于下文历史记录）

- 已核当前公开依赖：L12 `retrieval.search(UnifiedRetrievalRequest)` 已有真实 VFS 检索；
  L02 `llmRawPrompt.callWithConfigIdRawPrompt(configId, prompt, signal?)` 已发布并实现
  config id → model name → Model2、无 agent session、force_json=false、chat_v2/compaction。
  原“缺无会话 raw-prompt 接口”阻塞撤回，无需修改 L02 公共面。
- `69f5f93d` 已替换 `hpias-service.ts` 的 unavailable throw：非 stub 的真实路径进入
  `hpias-retrieval.ts`，按 Rust 逐查询 top-8、120ms 事件间隔、摘要/前三引用、计数聚合，
  通过 `_hpias_synthesis_` 调真实 L02 接口；零证据不调模型，模型错误/空输出/90秒超时
  按 Rust 回退确定性证据报告并保留告警。卸载停止后续事件并 abort 在途 synthesis。
- 当前验证：HPIAS 纯函数/编排/真实 Host + L13 消费入口 44 例通过，HPIAS 定向 tsc 通过。
  旧“依赖齐全时抛 unavailable”的测试已替换为检索、模型证据 prompt 和最终报告断言，
  不再把缺口暴露测试当成功实现。`hpias-retrieval-integration.test.ts` 另 1 例通过：
  装载真实 memory/VFS/notes/vfs-index/LLM/provider 插件，从已迁移 SQLite 索引读出证据，
  经真实 config-id 路由与 HTTP adapter 请求本机模型 fixture，并完成真实研究报告事件。
  未调用外部模型服务，未验证 Linux；完整命令与结果见本轮交付报告。
- 本次仅关闭上述产品实现缺口；不改历史 TESTMAP 资格或冒称全分支/全平台验收。

## WP-208 夹具修复与整分支集成边界

- `tests/fixtures/migrated-schema.ts` 冷构造返回完整 MigrationReport，热读取返回既有 Pick
  的两字段，是测试夹具返回契约缺陷；真实迁移 success=true/error=null，不是分页业务失败。
  WP-208 仅将冷返回投影为同样的 `{ success, error }`；真实迁移、落盘校验与缓存策略保持。
- **历史 WP-170 / `051c4cb73` 曾为 partial blocked，整分支未签收**：依赖齐全的 retrieval 新 throw
  不符合 Rust `hpias/service.rs:97-98` 的真实 backend 路径。此前 5 gate 绿不能解除此阻断；
  下节记录的明确报错只是当前缺口，不是已接受的等价行为。保留原代码和测试，待后继包用真实
  retrieval 替换。该产品缺口现已由上方 W03 实现替换；WP-208 的夹具完成不能代替 WP-170 签收。
- 修复进入 main 后，L15/X1 消费结果另计；TESTMAP 仍为 109 ported /57 pending /2 approved
  obsolete，旧47不恢复，本包不新增 A/C 资格。

## WP-170 当时 HPIAS 范围（现状以上方 W03 收口为准）

- main `b17264b88` 已含 WP-104/158；本包正常 merge 保留全部历史。L13 真实消费者、L07
  registry、F4 rustTrim 均已发布。D-070 指定进程环境为唯一配置来源，公开 startFromIntent
  负责 backend/emit/question；默认静态与显式 stub 是本包修复范围。
- 原“backend 选择尚未成为 Host 配置入口”在本包修复后撤回。default/空/disabled/off/unknown
  无 pipeline；unknown 原 WARN；显式 stub 同步 session_started 后再跑原350ms时间线。
- **retrieval 仍未完成**：L17 自有 RetrievalHpiasResearchService 的真实120ms检索/聚合/synthesis
  pipeline 尚未移植，不归因于 L13 registry。原 factory 必需 deps 是 VFS DB + LLM，Lance可按需创建：
  本包从公开 ctx.vfsDatabase / ctx.llm 检查存在性；缺依赖按 Rust WARN/None，齐全则明确报
  `HPIAS retrieval backend is unavailable: L17 retrieval pipeline and L02 callWithConfigIdRawPrompt are required`，
  不谎报 disabled、不借用 stub。
- L12 已有 `retrieval.search(request)`，其真实装配属于后续 retrieval 包；L02 `llmRawPrompt`
  已有普通 raw/agent-compaction/exact-config-images，但仍缺无会话
  `callWithConfigIdRawPrompt(configId: string, prompt: string): Promise<StandardModel2Output>`。
  依据 Rust `model2_pipeline.rs:8682-8739`：id→model→Model2，force_json=false，ChatV2/compaction，
  agent_session_id=None；synthesis.rs:75 使用 `_hpias_synthesis_`。不能用需要会话的 agent 方法或
  不同路由的普通 raw 出口替代。此接口缺口与 L17 自有剩余分别记录。
- TESTMAP 保持 109 ported / 57 pending / 2 approved obsolete，旧47全部pending；本包不恢复映射。
  L22/WP-175 在本供方进入 main 后独立消费原三测试，不由本包代签。

## WP-158 精确分页供方（2026-11-05）

- main `f3753b682` 已含 F3 `SqlParam` bigint 绑定及 F1 `IpcInteger` / WP-133 入站整数面，
  本包无供方依赖阻塞。`api.ts` 重导出的 `InsightCommandService.listInsights` 扩为
  `limit: IpcInteger, offset: IpcInteger`；实际定义在 `src/insight-api.ts`。
- L15/WP-159 可直接把已解码的 `number | bigint` 传入该服务；L17 只做 `limit.min(500)`，
  offset 与负 limit 不经 Number，交 F3 原样绑定 SQLite。L15 的 ListArgs 类型消费由其包处理。
- 本包不恢复任何旧映射：109 ported / 57 pending / 2 approved obsolete，旧 a80 47 行全 pending。
  WP-170/171/166 仍由协调者另派，本文的历史未完成项不作为本包续作授权。

## WP-016 当前核验（2026-11-05，优先于下文历史记录）

- 基线 main `967f43c7547d1ed29a7e3d736b8118fb95d3661e` 已有 `hpiasResearch`：
  `index.ts:109` 提供，L13 的 `host/plugins/vfs/index.ts:219-220` 消费；旧“等 L13 分支合入”撤回。
  这只闭合现有 intent/timeline 服务，不代表 retrieval backend 或 request 对象测试通过验收。
- `api.ts:60` 已在 main 重导出 `mergeProfileJsonForSync`，实现 `src/learner-profile.ts:510`；
  R4-SYNC-05 的接口提供不是当前阻塞，也不在本包重新认领。
- main `host/plugins/llm/api.ts` / 实现仍无 `callMemoryDecisionRawPrompt`，
  `src/service.ts:853-862` 按缺接口报错；普通 raw prompt 和 embedding 均不能冒充该角色。
- 本包 13 条中六条解析/提取用例静态生产可达，保留旧映射且不报新增；
  `test_memory_event_from_str` 无生产调用，semantic_dedup 六条的模块也无生产 import，均纠正为 pending。
  semantic pass 未迁移/未接入是本 lane 自有工作，不只是 L02 阻塞（`src/service.ts:525-526`）。
  逐条证据见 `LANE.md` WP-016 小节。旧检查点另外 36 条映射本包未验收，不应整批视为本包交付。
- a80 污染纠正后（C1 授权）：child 独有 36 条与 `request_carries_session_and_intent` 已恢复
  a80 前 pending；C2 退回的 backendKindFromConfig / parseArxivAtom / parseBatchMoveArgs 均在其中。
  WP-102 逐行实测（2026-11-06）：TESTMAP 为 109 ported / 0 merged / 57 pending / 2 approved obsolete，
  168 行去向与 `967f43c75` 逐行相同；a80 改动的 47 行（含原 10 条 writer 候选）全部 pending。
  此前写的“117/2/47/2、10 条待验收”与“147/2/17/2”均为中间态历史计数，已不成立。

## Linux 续作核验（2026-11-05）

- 后续复验 `20261105004630-3c0af8` 仍有 4 个 30 秒测试超时及 1 个 worker RPC 错误，
  exit 1（265 passed）；不能用早先 f587 receipt 替代本次树的结果。
  已定位 fixture 的单文件迁移缓存不能跨默认隔离 forks 复用，以及若干逐用例 runAll；
  这是本 lane fixture 的工作，不派给 L04/L02，也不加大 timeout。修复/新回归证据见 LANE
  “跨 fork 迁移模板复用”小节。修后 `20261105010419-0f5587`：43 files / 270 passed /
  无 Errors / exit 0；Electron `20261105010420-282fef`：9 files / 28 passed / exit 0。
- 合并 main 后，L10 retention disposer 已由 `notes/index.ts:212-219` 纳入 scoped effect。
  `note-content-owner.test.ts` 四例通过；下节 Slot 故障仅保留为历史证据，不再算当前阻塞。
- 协调者反馈的四个文件均复现为 `beforeAll(prepareMemoryTestSchema)` 的默认 10 秒 hook
  超时（`20261105000321-603c5a`：4 failed suites / 20 skipped / exit 1），不是业务断言失败。
  删除重复预热，仍由 `setupMemoryHost` await 同一个真实迁移模板后复制隔离数据库；不改 timeout、
  schema、断言或测试选择。修后 `20261105000459-d06815`：41 files / 266 passed / exit 0。
- **L04 注册表已发布，不再是阻塞**：`chat/api.ts:199-201` 提供创建/装配入口；
  `agent-skills/api.ts:319-328` 提供 `registerToolExecutors`。原第 2 节的旧缺接口判断已撤回。
- 按 F1 本次指令，35 条暂保留 pending。准确原因是本 lane 尚无完整工具执行体与生产执行接线，
  不是对方缺 registry；纯 parser 测试和新 metadata 注册不能冒充执行体完成。
  `createMemoryToolMetadata()` / `ctx.memoryToolMetadata` 提供三个真实现有策略的同一组对象，
  `index.ts` 将其登记到 agentTools。它们刻意没有 `execute`，L04 不将 metadata-only 对象纳入
  可执行 roster（`chat/src/executor-roster.ts:11-14`）。F1 的策略检查可消费此入口；
  完整 headless 执行链仍不能据此签收。
- L02 仍缺 `callMemoryDecisionRawPrompt`；HPIAS 还需
  `callWithConfigIdRawPrompt(configId,prompt)`（Rust model2_pipeline.rs:8682-8739，
  id→model→Model2、force_json=false、ChatV2/compaction、无 agent session）。已发布的
  agent-compaction 必须有会话；exact-config image 方法要求至少一张图、无 failover，不能替代。

## main-red 后正式门禁阻塞：L10/F3 retention Slot 生命周期（2026-11-04）

`fix(main-red)` 候选 `9ef0ac60c` 的正式自检：静态四项通过；tests 作业
`20261104164359-2a1224` 259 passed / 3 failed、exit 1，无 timeout 断言。
失败均为 `note-content-owner.test.ts` 第二及后续真实 notes host 启动：
`SlotOccupied: service slot already occupied`，栈为
`host/kernel/primitives.ts:32` → `host/platform/storage/file-deletion-queue.ts:106`
→ `host/plugins/notes/repository/asset-retention.ts:16` → `host/plugins/notes/index.ts:169`。

证据：F3 的 `registerNoteAssetRetention` 当前用 `Slot.provide`，并返回注册 disposer；
L10 `registerNotesAssetRetention():void` 丢弃该 disposer，插件 apply 直接调用，未挂到
`ctx.effect`。L17 fixture 已在 afterEach **await host.dispose()**，且第一个真实-owner 用例
通过、后续用例在注册时失败，故不是旧 host 未卸载或 duplicate fixture schema 引起。
模板初始化只调用 storage 迁移，不安装 notes 插件。

**更新：已有真实实现候选，当前仅等待正常进入 main，不再索取重复修复。**
L10 `5f9082dbf` / `51ec310bd`（交付 tip `95ec4695b`）：wrapper 从 storage/api.ts 公共面
取得并归还 Disposer，index 的 journal/retention 分别在两个 ctx.effect 内注册并清理；
dispose/unload/apply 回滚只释放自己的注册，不覆盖他人 guard。owner 真实生命周期测试
`notes/tests/journal-registration.test.ts` 与 notes-app 共 4 passed（`20261104164350-a2802b`，
exit 0），C1 已亲核。按 2026-11-04T16:59 回执，main `fb463060d` 尚未包含该实现。
F3 的 Slot.provide 是正确语义，不再向 F3 重派修改。待实现进入 main 后，仅对 L17 原
note-content-owner 受影响三例做最小复验；不重复旧已知失败矩阵。
L17 不越权改 owner、不在测试里清全局 Slot/重载模块逃错，不降低或删除真实-owner 断言。

原 main 红灯两例已有局部改善：`20261104164000-1ea5f3` 16 passed exit 0；
这不能替代上述正式门禁仍失败的结论。

## v2 新增所有者接口请求（2026-11-04，L17-V2-01）

下列旧实现违反单写者，不因旧测试通过而接受。尚未关闭；请求所有者发布真实 API 后替换，
不得用更新时间的普通 CRUD 冒充。下表保留审读基线 `2ee9a9cbe` 的请求；当前发布/消费状态见表后增量。

| 所有者 | 精确需求与 Rust 依据 | 现状/受影响路径 |
|---|---|---|
| L10 notes | `rewriteTagsWithoutTouchingUpdatedAtWithConn(conn, noteId, tagsJson): void`：只执行 `UPDATE notes SET tags = ? WHERE id = ?`，不改 updated_at/resource/CAS，不添加事务、不校验目标存活；SQL 错误原样传播。Rust service.rs:3495-3524,4368-4429；evolution.rs 的直接 tags 写同规则。另需确认 getNoteContent 缺失资源修复已由真实 notes 服务提供。 | notes/api.ts:48-75 无 tags-only；updateNoteMetadata 不能替代。repository/vfs.ts:313,505,543 旧越权待替换。 |
| L16 anki | 合成 task upsert + projection card exists/update/insert + tombstone 的公开 `*WithConn` 接缝，字段精确见 `src-tauri/crates/dstu-research/src/insight/jobs.rs:646-729`。同一 now；task/card id 固定前缀；卡更新只 front/back/updated_at/deleted_at，不重置 FSRS/history；按原顺序独立执行，不新增原 Rust 没有的事务。 | anki/api.ts:22-43 无投影写入口；repository/insight-projection.ts 旧 SQL 越权。测试 test_srs_projection_materialize_and_regenerate 不能据此视为 v2 所有权闭合。 |
| L15 mastery | `recordInsightRecallVerdictWithConn(conn, insightId, sessionId, success, now)`，Rust recall.rs:426-446：INSERT OR IGNORE，id=`me_insight_${id}_${session}_${correct或wrong}`；concept_key=item_id=`insight:${id}`；source=insight/weight=1/signal=1或0，同一 created_at/updated_at。不额外 recompute/profile。错误前缀“写入 mastery 证据失败: ”。 | review/api.ts:32-49 无此幂等写接口；recordEvent 会改变幂等与副作用，不能替代。repository/insight.ts:41-53 旧 SQL 越权。 |

所有者回复（2026-11-04）：
- L10：实际代码 `518e8db56` 已进 main，L17 在 `7dd81f614` 消费 tags-only 同 conn 接缝（X6-SW-0016 / R5-M2）；getNoteContent 已走真实 notes owner（`cc0b61878`），缺资源错误不再转空串。
- L16：已消费 main 实现 `f09807bb4`（anki/repository/insight-projection.ts）的三个投影 `*WithConn`，同 mistakes conn、不新增事务；真实 anki 插件测试通过，待 R5 复核。未使用尚未 main 的 `a0515bf75`/`a47f42ded` 新 i64 类型。
- L15：已消费 main 实现 `8f037194c`（review/src/mastery.ts）的 `recordInsightRecallVerdictWithConn(conn,insightId,sessionId,success,now:string)`；真实 mastery 插件验证幂等且不重算状态。待 R5 复核，未使用尚未 main 的新类型。

57 个历史 pending 的逐项清单保留于下文；以上新增问题不混入旧计数，也不冒称已修。

更新时间：2026-11-04（合并 main 后）。当前 TESTMAP：168 行，`ported` 109，`pending` 57。

下文分组保留历史 pending 索引，包含自有未完成与已发布供方；当前状态以上方包级更新为准。按
`docs/dev/electron-migration/quality.md` 第三节第 3 条与第八节：被测模块在 Rust 中确有生产
调用方、只是对方 lane 还没移植调用点时，保持 `pending` 并注明“待 Lxx 接入”，不得标
`obsolete:dead-in-rust`，也不得用测试替身伪造接线。

统计：9（HPIAS 待验/真实 retrieval 剩余）+ 35（工具执行体待迁移）+ 13（决策/去重待验）= 57。
另有 2 条 `query_rewriter` 经 C1 批准为 `obsolete:dead-in-rust`；批准位于 main 的
`migration/approvals.d/C1-app.json`，由 ledger loader 与 `approvals.json` 合并读取。

## 1. L13 generative UI —— 13 条历史映射，9 条保持 pending

**L17 已提供**（本次提交，生产入口为 `host/plugins/memory/index.ts` 的
`ctx.provide('hpiasResearch', createHpiasResearchService(ctx))`）：

- `GenerativeResearchPort.startFromIntent({ window, sessionId, title, intent })`：
  研究块判断、进程环境选择、同步 session_started、显式 stub 的350ms后台时间线；
  `hpias_event`（`WebviewWindow` 目标）发送；非研究/disabled立即 no-op。
- `events.rs` / `orchestrator.rs` / `payloads.rs` 共 13 条测试已转
  `ported:host/plugins/memory/tests/hpias.test.ts`。

**仍 pending 的 9 条**：

| Rust 模块 | 条数 | 缺口 |
|---|---:|---|
| `crates/dstu-research/src/hpias/retrieval_backend.rs` | 3 | 自有真实 pipeline 未迁移；L12 已有检索 API，L02 无会话 config-id raw 缺口见上 |
| `crates/dstu-research/src/hpias/service.rs` | 5 | WP-170 修复 default/stub 配置与首事件，依赖齐全的 retrieval 明确阻断；旧47拒收资格不随修复恢复 |
| `crates/dstu-research/src/hpias/synthesis.rs` | 1 | LLM synthesis prompt 的调用方是 retrieval backend |

L13 `GenerativeUiExecutor` 消费方已在 main 的 `host/plugins/vfs/index.ts:219-220`；
本 lane 不再缺 `GenerativeResearchPort`，不再把执行器整体列为“无提供方”。

## 2. 工具执行体与生产执行接线 —— 35 条（F1 指令暂保留 pending）

旧 registry 阻塞已解除，见本文件开头。现有 `memory-executor.ts`、`academic-search.ts`、
`learning-overview.ts`、`paper-save.ts`、`knowledge.ts` 是纯解析/策略/聚合模块，
没有实现 Rust `ToolExecutor::execute` 的完整执行体。不得将自有执行体未迁移归因于 L04。
本次公开 metadata 服务只供 F1 策略核验，不能把下列 35 条转为 ported 或声称完整 roster 可用。

**影响测试**（共 35 条）：

| Rust 模块 | 条数 | TS 测试文件 |
|---|---:|---|
| `src/chat_v2/tools/paper_save_executor.rs` | 9 | `tests/tools-pure.test.ts` |
| `src/chat_v2/tools/memory_executor.rs` | 7 | `tests/memory-executor.test.ts` |
| `src/chat_v2/tools/learning_overview_executor.rs` | 7 | `tests/learning-overview-db.test.ts` |
| `src/chat_v2/tools/academic_search_executor.rs` | 7 | `tests/chat-tools.test.ts` |
| `src/chat_v2/tools/knowledge_executor.rs` | 5 | `tests/chat-tools.test.ts` |

## 3. L02 LLM memory-decision 角色 —— 13 条

**已发布**：`host/plugins/llm/api.ts:42-47` 的 `singleShotCompletion` 是可用的底层
单次调用，但**不等同于** Rust 的 `LLMManager::call_memory_decision_raw_prompt`。
本 lane 已在 `host/plugins/memory/api.ts` 定义 `MemoryDecisionCompletion` 端口，并在
`extractCompactionSegment` / `extractMemoryCandidates` 中按该端口调用；测试只替换
这个 L02 外部调用。

**向 L02 明确索取的方法语义**（对应
`src-tauri/crates/dstu-llm/src/llm_manager/model2_pipeline.rs:8842`）：

- 方法名：`callMemoryDecisionRawPrompt(prompt: string, signal?: AbortSignal):
  Promise<{ assistantMessage: string }>`（服务键仍为 `ctx.llm`）。
- 模型路由：`get_memory_decision_model_config()`，回退链
  `memory_decision_model → model2`；不使用 `selectModelFor` 的普通聊天默认值。
- 请求：非流式 raw prompt，`force_json = true`，无图片；caller type `Memory`，
  task `memory_decision`。
- 响应：返回 assistant 文本（Rust `StandardModel2Output.assistant_message`），
  不在这里替调用方解析 JSON。
- 取消/超时：Rust 入口无 per-call 取消参数；若 L02 提供 `signal`，取消应直接
  reject 并停止重试；本 lane 的 flush/extraction 会把 signal 原样传入。
- 失败：reject 原始错误，由本 lane 包装为
  `Memory flush LLM call failed: …` / `LLM extraction call failed: …`。

**影响测试**（13 条）：

| Rust 模块 | 条数 | TS 测试文件 | 说明 |
|---|---:|---|---|
| `crates/dstu-memory/src/memory/llm_decision.rs` | 7 | `tests/llm-decision.test.ts` | WP-016 保留六条生产可达解析/提取映射；from_str helper 无生产调用，pending；真实 L02 角色仍缺 |
| `crates/dstu-memory/src/memory/semantic_dedup.rs` | 6 | `tests/evolution-profile.test.ts` | 纯模块无生产调用，自有 pass 未迁移；六条 pending，不以纯函数测试绿冒充接线 |

**query_rewriter（2 条，已批准 `obsolete:dead-in-rust`）**：批准已由 main 的
`migration/approvals.d/C1-app.json` 落记录；main 的 ledger loader 会合并读取
`migration/approvals.d/*.json`，因此无需修改 `approvals.json`，也不再重新激活
query_rewriter 分支。TESTMAP 已转 `obsolete:dead-in-rust`。

### R5-M1 增量（2026-11-04）

L17 已将 fact smart-write 接入现有 `retrieval` 的 internal_dedup 路由（不记录用户搜索命中），
实现 Rust service.rs:1968-2429 的检索失败告警、索引未就绪 SKIPPED/待复核、真实模型失败熔断、
低置信度 NONE、候选 target 校验与五事件分派。检索/模型调用在事务外；幂等 mutation+receipt
在同一 IMMEDIATE 事务，await 后 renew 防止旧 owner 提交。

**仍阻塞于 L02 的仅是实际模型调用角色**：main `llm/api.ts` 没有
`callMemoryDecisionRawPrompt`。相似候选非空时明确报缺失接口并释放 reservation，不假造
singleShotCompletion provider，也不把接口缺失伪装成实际模型错误静默 ADD。实际调用已发布
角色时若 reject/返回不可解析响应，才走 Rust 的 warn + confidence 0.6 ADD/进程级熔断。
既有 llm_decision 7 条仍 pending，不因新增替身集成测试绿而自称真实 L02 接线完成。
新 main 的 `llmRawPrompt.callModel2RawPromptOpts`（raw_prompt_service.ts:238-240）始终
`getModel2Config()`，即使 task 传 memory_decision 也没有 memory_decision_model→model2 的
角色选择；config-id/images 入口又固定 forceJson=false。不能把这两个普通 raw 出口拼成
已发布 memory-decision 角色，也不因 raw/question 候选已落主线而关闭这项。

死代码证据：`search_with_rerank` 的 `use_query_rewrite` 参数在全部生产调用点均为
`false`：

- `src-tauri/crates/dstu-memory/src/memory/handlers.rs:244`
- `src-tauri/src/chat_v2/tools/memory_executor.rs:528,536`

`MemoryQueryRewriter::rewrite_simple` 因此不可达。

## 4. L03 消费契约 —— 已发布，等待 L03 接线（不阻塞本 lane 测试）

本 lane 已按 Rust `pipeline/compaction/memory_flush.rs` 发布以下 `MemoryService`
生产入口（`host/plugins/memory/api.ts`）：

| 方法 | Rust 对应 |
|---|---|
| `extractCompactionSegment(segmentText, signal?)` | `CompactionMemoryFlush::extract`（`compaction_flush.rs:95`） |
| `applyFlushExtraction(extraction, {segmentId, sessionId, factsCompleted, activitiesCompleted, onProgress})` | `process_claimed_memory_flush` 的逐条落库/进度段（`memory_flush.rs:780-870`） |
| `flushSegment(segmentText, sessionId, segmentId?, signal?)` | `CompactionMemoryFlush::flush_segment`（`compaction_flush.rs:78`）；单条 fact/activity 失败只 warn 并继续下一条，最后输出 info 统计，不写 ledger receipt |
| `queryFlushReceipts(segmentId)` / `getFlushReceipt(segmentId, index)` | receipt 查询（`memory_write_idempotency`） |
| `cleanupFlushReceipts(segmentId)` | `cleanup_memory_flush_receipts`（`memory_flush.rs:300-308`，SQLite `GLOB 'compaction_flush:${segmentId}:fact:*'`，返回 changes，SQL 错误原样抛出） |
| `tryReserveFlushReceiptWithConn` / `renewFlushReceiptWithConn` / `cacheFlushReceiptWithConn` / `clearFlushReceiptWithConn` | D1：在调用方事务内完成预留、续租、写结果与失败清理（Rust `renew_smart_write_reservation_with_conn` / `cache_smart_write_result_with_conn`） |
| `listFlushReceiptsWithConn` / `getFlushReceiptWithConn` / `cleanupFlushReceiptsWithConn` | D1：在调用方事务内查询或清理 receipt；SQL 只在 `repository/idempotency.ts` |
| `extractMemoryCandidates(userContent, assistantContent, profile, signal?)` | `MemoryAutoExtractor::extract_candidates_and_activities`（`auto_extractor.rs:62`） |
| `extractAndStoreMemory(userContent, assistantContent, signal?)` | `MemoryAutoExtractor::extract_and_store`（`auto_extractor.rs:100`） |
| `spawnPostWriteMaintenance()` | flush 完成后的统一维护触发（`memory_flush.rs:858`） |

L03 仍需完成自己的 Chat ledger/worker 接线；在此之前本 lane 的 11 条
compaction-flush/auto-extractor 测试已因模块从 `index.ts` 可达而标 `ported`。

`cleanupFlushReceipts` 由 memory 唯一所有者直接操作
`memory_write_idempotency`，只接受 `segmentId`，不向 L03 暴露 SQL 或整表清理；
实现是单条 `DELETE ... WHERE idempotency_key GLOB ?`，SQLite 隐式事务即可满足
Rust 语义。删除计数直接取 `changes`；打开数据库或执行 SQL 失败会原样抛出，由
调用方按 Rust `warn!` 处理。

需要与调用方自己的事务合并时，走 D1 的 `*WithConn` 接缝（上表后两行）：调用方用
`storage` 开启事务，只把 `SqlExecutor` 传进来，由 L17 在 `repository/idempotency.ts`
执行 SQL。普通 `flushSegment` 与带 ledger 的 `applyFlushExtraction` 是两套规则：
前者逐条失败继续，后者按 ledger 进度停点/重试，不能互相替代。

## 非阻塞（已接线）

- `quick_assistant_*`：经 F2 `ctx.shell` 的 `plugin:window|*` 实现；
  `global-shortcut://triggered` 仅在 `Pressed` 且 `quick_assistant.enabled !== "false"` 时切换。
- `evolution.rs`：`run_throttled` 与 Phase 1-5 已接入
  `MemoryServiceImpl.runPostWriteMaintenance`。
- `insight` / `masteryProfileSink`：均由本插件 `provide`。
- `memoryRetrieval`：本插件 `provide`，`search` 接受 `AbortSignal`；若 L12 提供
  `retrievalCancellable.search(request, signal)` 则把同一 signal 传入真实检索，否则
  只能中止本 lane 后处理。L12 main 的 `RetrievalService.retrieve(request)` 仍无
  `signal` 参数，真实在途取消的底层能力见 `ds-mig/L12-vfs-index` 分支待发布。
- `memoryConfig`：本插件 `provide`，`set` 使用 `memory_config` 的
  `datetime('now')` 更新时间；L13 `AttachmentConfig` 可直接读取。
- `vfsHooks`：本插件注册 memory note-delete hook（`captureDelete` →
  索引清理 + `memory_audit_log` DELETE 行），随 Cordis scope 释放。

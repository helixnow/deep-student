# W22 进度（chatanki 执行器）

## 第 6 轮（接手 `0129abc9`，INT 开工 `2be7ed80`，15:59 合 `1d1fdb78` → `2f5ed4f5`）

### 任务 2：FM-04/FM-06 撤销两条 routed RF（`5ea0e548`）
- INT `2be7ed80` 期间 `35971de8` 不在 INT；INT 前进到 `1d1fdb78` 后已含，合入后执行。W05 出口 `llmRawPrompt.callAnkiRoutedRawPrompt(decision, task, prompt, images, signal?)` 参数齐全，无需交接 W05。
- 应用 `.reports/W05-handoffs/W22-retire-RF-analyze-planner-model2-fallback.patch`（route-planner、analyze-real-assembly、删 RF json、index.ts 日志改 warn）。
- 补齐补丁未覆盖处：`src/vlm-extract.ts` 按 Rust :9713–9751 改走 routed 出口（有决策且失败 → warn 后 model2 带同一组图片重试一次；无决策不重试）；`src/run-input-sources.ts` 的 `rawPrompt` 需要 routed 出口，回调由 debug 改 warn（Rust 两处都是 `log::warn!`）；删除 `RF-W22-vlm-extract-model2-fallback.json` 及其 RUST-FIX 标记与测试。
- 新测试 `tests/routed-raw-prompt-real-host.test.ts`（6，真实 L01/L02 插件 + 生产接线 `createChatAnkiRunInputSources`，只有远端 HTTP 是本地服务）：Planner/Vlm 有决策 → force_json（`response_format`）、caller anki（用量记录）、caller task（task 专属 failover 链的 `llm-failover` 事件 task 字段）、Vlm 请求带图；routed 失败 → warn + model2（task utility）一次；无决策 → model2，失败不重试。`run-pipeline-real-host` 的 L02 替身补 routed 出口并断言 task/decision。
- `rust-fixes.mjs --check`：93 条（approved 92，proposed 1 = `RF-W22-sync-status-patch-session-scope`），0 错误。

### 任务 3：烟测 #28 跟进（`dc40edfd`）
- desktop profile 认领 chatanki_run/start；`{}` 与合法 start 经 tool-loop runtime 的终态测试。
- 交接 W12：smoke ⑥ `host/e2e/smoke/__tests__/golden/06-agent-tools.spec.ts:292-309`，withheld 探针需换合成工具名，run/start 应断言为已广告。

### 任务 4：上一任遗留（INT `1d1fdb78` 复查，仍阻塞）
- `agentCardReadScope` 未发布 → `RF-W22-sync-status-patch-session-scope` 保持 proposed。
- `anki/api.ts` 只 import 了 `ApkgExportReport` 类型，无导出方法 → `chatanki_export format=apkg` 仍报 L16 未发布（交接 W10）。
- `chat/api.ts` 未导出 `decodeVfsContextRefData` → 保留 `src/context-refs.ts` 本地 serde 解码（交接 chat owner）。
- W10 `chat/tests/desktop-tool-face-wiring.test.ts:17-22` 的 PENDING 集合与注释已过时（四个工具已认领）→ 交接 W10。
- `review/api.ts:26` 仍未导出 `mediaFileName`（`review/src/media-source.ts:4`）→ `index.ts:636` 继续置 null（交接 review owner）。
- `0d4e41ef` 拆出 `src/apkg-port.ts` 后 import-cycles 报 4 条基线环边归零（info，门禁通过）：`scripts/electron-migration/gate-checks/import-cycles-baseline.json:119-133、139-143` 不在本 lane 路径，交接 INT 降基线。

### 任务 5：执行器对拍与瘦身
| 提交 | 内容 |
|---|---|
| `ff74caeb` | executor-args 的绝对路径判断改用 `platform/util/path`（去 `node:path`） |
| `cb45e44f` | executor-args.ts 按职责拆分（桶文件保留 67 个导出） |
| `0b947e44` | run-pipeline.ts 拆出轮询 + 终态块（Rust :8353–8892）到 run-pipeline-poll.ts |
| `251a00f8` | update_card/retemplate 缺字段按 struct 顺序；list_templates 分页为 usize；真实注册表 13 个工具的 `Invalid <tool> arguments` 终态（tool_call error + 存块） |
| `8f16a9d3` | serde 辅助按 app 图的 preserve_order + arbitrary_precision：数字显示 `number`、整数 `str::parse`（小数/符号/越界 → `invalid number`）、OneOf 文案、unit enum 的单键 map 形式 |
| `18fc7829` | chatanki_transform 参数经 `deserializeSerdeStruct`（mode null 拒绝、script 在解码期解析） |
| `d1012d73` | 会话参数全部经 `deserializeSerdeStruct`：输入键序、deny_unknown/default 拒 null、别名重复；import_apkg 的 normalize 错误不带 `Invalid … arguments` 前缀 |
| `0d4e41ef` | api.ts 拆出 APKG 端口类型到 `src/apkg-port.ts`（877 → 794 行） |
| `321f82b9` | status（`document_id` 是未知键被忽略）、review_stats（空 struct 的 `there are no fields`）、analyze、模板设计器 9 个工具参数经 `deserializeSerdeStruct`（输入键序、usize、位置形式、update 因 flatten 只收 map） |
| `2b2f2ab0` | 模板 `fieldExtractionRules` 按 models.rs 四个 struct 解码（u32/f64、位置形式），输出按 Serialize 字段顺序 |
| `68966240` | 规则里的 `Vec<Value>`（`allowed_values`、`validation.enum_values`）与 `ensureFieldExtractionRules` 改用 `cloneAgentJson`：工具参数可带 `JSON.rawJSON` 数字原子（kernel `cloneAgentJson` 的约定，如写成 `1.0`），`structuredClone` 会抛 could not be cloned，Rust 照收 |
| `e404fee0` | 原子按字面量解码：fsrs 的 `as_u64`/`as_f64`（`0.90` 可收、`1.0` 报区间、`1e400` 报类型、≥2^64 报类型）、库卡列表 u32 走 `serdeU32`、`expectedVersion` 数字按 arbitrary_precision Display（`2E3` → `2e+3`）；`serdeUnsigned` 收原子 `-0`（serde_json `parse_any_number` 把 `-0` 存成 i64 0，`-0.0` 仍是文本） |

名册（name、`builtin-` 前缀、sensitivity、并发类）已由 `roster-registration` 与 `tool-coverage-real-host` 全量覆盖，本轮未发现差异。

### 断言纠正（断言的是 bug）
- `tests/executor-args.test.ts:341-348、375` 与 `tests/review-executor-real-l15.test.ts:162-163`：i64 越界原断言 `toContain('expected i64')`。app 图 serde_json 开 arbitrary_precision，`Number::deserialize_i64` 对字面量 `str::parse::<i64>`，越界报 `invalid number`；同仓 `library-write-real-host.test.ts:399-400` 已按此断言。改为精确 `invalid number`。

### 剩余缺口
- 模型流式工具调用的参数经 `llm/src/tool_calls.ts:81` 普通 `JSON.parse`，数字字面量丢失（u32 的 `1.0`：Rust `invalid number`，TS 视作 1；`-0` 与 `-0.0` 不可区分，前者 Rust 收、后者拒）。需 L02 无损解析成原子，chatanki 解析器已按原子对齐；不在本 lane。
- APKG 导出、`agentCardReadScope`、`decodeVfsContextRefData` 见任务 4。

## 第 5 轮（14:00 起，INT 开工 `fe5feb68`）

### 交接收集
| 来源 | 事项 | 处理 |
|---|---|---|
| V01-07 | `registerToolExecutors` 的 disposer 被丢弃 | 已修，见下 |
| W10-1316 交接 | 用 `anki/api.ts:307/316` 的 `startDocumentProcessingWithId`/`cancelStreaming` 注册 run/start；落地后删 `chat/tests/desktop-tool-face-wiring.test.ts:22` 的 PENDING | 门面随 INT `390f244b` 落地，start 已认领（`ced352fe`）；PENDING 在 W10 路径，已写交接 |
| M1-1316 | RF-W22-sync-status-patch-session-scope 仍 proposed | 任务 4 |
| W02-1316 | 不在 kernel 做 bigint 容错，产出方自行转换 | chatanki 已在 `agent-json.ts` 转换，无需改 |
| V08 / V09 | 报告未点名 chatanki | 自查 V08-04（AppError 普通对象被 `String()`）、V08-06（工具结果 bigint）、V09（卸载释放）在 chatanki 的落点，见任务 5 |

### V01-07（`44db7010`）
- `index.ts`：在 `ctx.inject(['agentTools'])` 里注册，返回的 disposer 随作用域撤销；删除布尔守卫。
- `tests/agent-tools-registration-lifecycle.test.ts`（真实 agent-skills）：卸载 chatanki 后执行器消失；替换 agentTools 提供者后恰好重新注册一次；重装 chatanki 不重复注册。修复前三例全红。

### run/start 编排移植：Rust 侧清单（`src-tauri/src/chat_v2/tools/chatanki_executor.rs`）

**入口**
- `execute_start` :6760（Content 输入，tuning 不含 visualHint/maxImages）
- `execute_run` :6817（VfsRef 输入：resourceId/resourceIds 去重合并、content 作 extra_content、route 强制路由）
- 都进 `start_background_pipeline` :6901–7213，再 `tokio::spawn(run_chatanki_pipeline_background)` :7462–8892

**前半段（同步返回 `started`）** :6901–7213
1. extraRequirements trim→None；`normalize_output_protocol_arg` :537（非法值直接失败）
2. `clamp_max_cards_arg` :554（>100 钳到 100 + 结构化 warning）
3. goal 为空 → `goal is required`
4. chat_db / llm_manager / anki_db 缺失 → `Err`（工具抛错，非 failure 结果）
5. 新块 id `blk_<uuid>`，`block_index = 工具块 index + 1`（取不到为 1）；预分配 documentId
6. `resolve_template_selection` :10741 → `normalize_template_selection`；单模板且未显式 noteType 时取模板 note_type
7. 初始 tool_output（schemaVersion 2、stateRevision、queued 进度、`ankiConnect.available=null`、debug）
8. **F2：先登记 guard（父取消令牌=工具调用令牌）再落库块**（`upsert_block_allow_orphan`：content/tool_input/citations 为 NULL）
9. `emit_start(anki_cards, message_id, block_id, {templateId, templateIds, templateMode, options})`
10. 工具结果 `{status:"started", ankiBlockId, documentId, message, warnings?}` → emit_tool_call_end → save_tool_block
11. spawn；后台返回 Err 时：emit error、`ensure_failed_document_session`、终态块 error；guard 随任务结束注销

**后台** :7462–8892
- 0 取消检查（启动前）→ `finish_pipeline_cancelled_before_generation` :7378
- 1 AnkiConnect 探测 → chunk `{ankiConnect, progress:routing}`
- 2 内容：Content 直接用；VfsRef 走 :7510–8046（会话/VFS 引用解析、最新用户消息兜底、blob 读取、VLM 路由、glossary hint）
- glossary 归一化 :8053（contentFormat 覆盖 > LLM hint ∪ 启发式）；内容为空 → noContent 终态
- 3 chunk generating；单模板加载（缺失/失败 → templateNotFound/templateLoadFailed 终态）
- 偏好 hint（settings 里的偏好库 + 模板名）→ `build_generation_options` → 媒体来源 → extraRequirements 偏好观察落库
- 多模板描述/字段/规则（部分失败 → `template_load_partial` warning）
- warnings 非空 → chunk + running patch
- 取消检查（生成前）
- `start_document_processing_with_id` → 成功写 `set_document_session_source`；失败 → startFailed 终态
- 4 chunk + running patch `{documentId, taskCreated, debug}`
- 900ms 轮询：取消→`cancel_document_processing`（非破坏性）；maxCards 达到→每个运行中任务 `cancel_streaming` + 未完成任务 Cancelled(GLOBAL_CARD_LIMIT)；进度 chunk（新卡每 25 张一批）+ running patch；空闲/总时长超时→停流 + 未完成任务 Failed(原因)，第二次仍未收敛→pipelineTimeout 终态
- 终态：超额卡 warning、`fsrs://changed`（非用户取消且有卡）、`project_chatanki_workflow` 合并、终态块、失败→chunk+error，否则 emit_end

### Node 现状对照与缺口
| 部分 | 现状 | 缺口 |
|---|---|---|
| 参数 | `run-args.ts` | 与 serde 不一致：接受 Rust 不认的 snake 别名（resource_id/template_id/deck_name/note_type/max_cards…）；缺字段检查顺序；i32/u32 范围与文案；start 复用 run 字段（Rust start 没有 route/resourceId/visualHint/maxImages，应忽略） |
| 归一化 | 无 | `normalize_output_protocol_arg`、`clamp_max_cards_arg`、`derive_document_name`、`normalize_glossary_paragraphs`、`build_preference_hint`、`infer_template_id_from_goal`、`resolve_template_selection` |
| 块写入 | `block-patch.ts` | `index.ts` 适配器写入 `content=JSON(toolOutput)`、丢 `blockIndex`；Rust 是 NULL 且保留 index（G3 db 面差异，单独修） |
| 注册表 | `pipeline-registry.ts` 已有 | 无人登记 |
| 生成门面 | INT `390f244b` 起 `anki.pipeline` 发布 `startDocumentProcessingWithId`/`cancelStreaming` | 能力探测保留：四个方法都在才认领 start |
| 轮询/终态 | `computeTaskCounts`、`projectChatankiWorkflow`、`classifyGenerationTerminal`、`decidePipelineTimeout`、`document-session.ts` 已有 | 编排本体 |
| VfsRef 内容 | 已移植：引用解析、blob/data 读取、最新用户消息兜底、路由计划、VLM（`run-vfs-input.ts`、`run-vfs-text.ts`） | VLM/Planner 按配置路由仍待 W05 `callAnkiRoutedRawPrompt`（两条 RF 回退 model2） |

### 分步计划
1. 参数与归一化纯函数对齐 serde/Rust（单测）。
2. start 前半段 + 后台 Content 管线（`run-pipeline.ts`），能力探测后认领 `chatanki_start`；测试经真实 chat 插件块存储与注册表。
3. INT 带上 W10 门面后：真实 anki 插件链路测试（startDocumentProcessingWithId → 任务/卡片 → 终态块），删 PENDING 交接给 W10。
4. VfsRef（chatanki_run）：引用解析 + 文本读取先行；VLM 在 W05 发布 `callAnkiRoutedRawPrompt` 前按 RF 回退 model2。认领条件：L16 生成控制 + L04 `chatSession` + L02 `llmRawPrompt` 都在（VFS 缺席即 Rust `vfs_db = None`，只走 content）。
5. 块写入形状（content NULL、blockIndex）。

### 分步进度
| 步骤 | 提交 | 测试 |
|---|---|---|
| 1 参数 serde + 归一化 | `f27c8a28`、`14e129c2` | `tests/run-args-serde.test.ts`（7）、`tests/run-options.test.ts`（9） |
| 5 块写入形状 | `3333ca8a` | 回归：mutation-ui-sync、sync-real-host、card-mutations-real-host 等全绿 |
| 2 start 前半段 + Content 后台管线 + V09 卸载取消 | `ee80f3dc` | `tests/start-pipeline-real-host.test.ts`（7）：能力门控、前半段失败、started→终态成功（事件序列全量断言）、startFailed、maxCards 上限、kill switch、卸载 |
| 3 真实 W10 门面链路 | `ced352fe` | `tests/start-pipeline-real-host.test.ts`（7）改走真实 `anki.pipeline`：成功（真实分段/流式切卡/入库，fsrs entityIds 取库内卡 id）、L16 校验拒绝（`../生物` → `文档名称包含非法字符`）→ startFailed、maxCards 达到时真实 `cancelStreaming` 中止仍在流的任务、kill switch 走真实 `cancelDocumentProcessing`、卸载（V09）；`tool-coverage-real-host` 认领 chatanki_start |
| 4a VfsRef 文本/图片读取 + VLM 提取器 | `a3a8fb6c` | `tests/run-vfs-text.test.ts`（13），含 `RF-W22-vlm-extract-model2-fallback` |
| 4b–4d VfsRef 输入解析（`run-vfs-input.ts` 对齐 :7511–8046）+ 宿主接线（`run-input-sources.ts`）+ 认领 chatanki_run | `4d0cd260` | `tests/run-pipeline-real-host.test.ts`（6，真实 vfs/vfs-repos/agent-workspace/media/chat/anki/review）：会话文件引用 → LLM 路由计划 simple_text → 生成器收到 VFS extracted_text；无引用无 content → 取最新「像材料」的用户消息；resourceId 不在会话快照 → VFS 回退解析；未知 id → Rust 原文错误终态 + Failed 占位任务；图片引用 + 强制 vlm_light → VLM 收到 VFS 原图，输出与文本/工具 content 合并。`tests/run-vfs-input.test.ts`（4）：无 VFS 分支、serde 解码。`tool-coverage-real-host` 改为 40 个工具全部认领 |

步骤 3 起只替身 L02 边界（`llm` + `llmStreaming.singleShotCompletion`），其余全部是真实插件。L16 各段配额之和恒等于 `max_cards_total`（`anki/src/document-processing.ts:113-121`），真实链路下不会超额，因此不再构造 `hiddenOverLimitCount>0`；上限路径测的是「卡数到顶但模型流未关」这一可达情形。

`ChatAnkiGenerationPipeline` 改为 `Pick<AnkiDocumentPipeline, …>`（`api.ts`），不再本地声明。

### 接口检查记录
- 14:05 INT `fe5feb68`：`startDocumentProcessingWithId` 无（在 `int/stage-1355`）；`callAnkiRoutedRawPrompt` 无（W05 分支也无）；`agentCardReadScope` 无。
- 14:18 INT `fe5feb68`（未动）：三者仍无。`anki/src/generation-critic.ts:141-143`、`anki-critic.ts:650` 里的同名方法是 L16 本地适配器，注释写明 L02 未发布。
- 14:30 INT `390f244b`（已合 `38ef9b6d`）：W10 门面落地（`anki/api.ts:300-334`，实现 `anki/src/document-pipeline.ts:90`），步骤 3 切换完成；`callAnkiRoutedRawPrompt`、`agentCardReadScope` 仍无。
- 14:52 INT `390f244b`（未动）：`callAnkiRoutedRawPrompt`、`agentCardReadScope` 仍无；chat 的 `decodeVfsContextRefData`（`chat/src/context-restore.ts:147`）未经 `chat/api.ts` 导出，chatanki 保留本地 serde 解码（`src/context-refs.ts`）。
- 15:20 INT `2be7ed80`（已合 `887b6744`）：`callAnkiRoutedRawPrompt`、`agentCardReadScope`、L16 APKG 导出门面、`chat/api.ts` 的 `decodeVfsContextRefData` 均仍无。
- 任务 6：`chatanki_import_apkg` 的 `sessionResources` 已注入（`cabdbb80`，无 VFS 时按 Rust `vfs_db = None` 报 `VFS database not available`）；`retemplate-fill` 改用 serde Value 解析（`0ce1d4e3`）；APKG 导出、模板列表 DB 报错前缀、SPEC 旧描述仍需他方（见报告交接）。
- W10 的 `chat/tests/desktop-tool-face-wiring.test.ts:17-22` PENDING 只是豁免集（不断言未广告），start/control/sync 现已认领，注释与集合过时 → 交接 W10。

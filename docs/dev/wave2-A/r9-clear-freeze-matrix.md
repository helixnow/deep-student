# r9 清/冻终稿矩阵：本会话「清什么 / 不清什么、冻什么 / 不冻什么」（第 9 轮 #5）

- 作者：0824 Wave2-A 第 9 轮子代理 #5（claude-fable-5-thinking-xhigh）。
- 基线：枝 `cursor/0824-wave2-agent-cache-a875` tip `dd300cd3`，官方基座
  `origin/cursor/0824-cde6` @ `061b4815`。行号为第 9 轮工作区现势，**以代码
  符号为准**（行号漂移史见 `r2-freeze-matrix.md` §6.1 勘误表）。
- 纪律自证：本席只写本文件 + `r2-freeze-matrix.md` 追加节；未改任何产品
  代码，未跑 cargo / npm / 任何测试，未 commit / push（父代理收轮）。
- 读法：**冻** = 已发出字节/序的稳定性承诺（为 prompt cache 前缀服务）；
  **不冻** = 有意易变、机制上明确豁免；**清** = 本会话明确允许清除/覆盖/
  删除且已落地的东西；**不清** = 红线禁改区，本会话零触碰并自证；
  **切代** = generation 何时 bump、何时只发信号。

---

## 1. 冻（5 项）

| # | 对象 | 粒度（生命周期） | 权威状态 / 持久化 | 代码锚点（符号级） |
|---|---|---|---|---|
| F1 | tools 名字序（已发出工具的相对顺序） | **会话级 append-only**：跨轮、跨 `execute_with_tools`、跨进程重启不变，新工具只按首见轮次追加末尾 | 内存 `frozen_tool_schema_orders` map + session.metadata `frozenToolSchemaOrder`（`types.rs:459`），经 `ChatV2Repo::advance_session_tool_face_prefix`（`repo.rs:3091`）IMMEDIATE 事务落库、无变更跳写、不推 updated_at | 读 `helpers.rs` `load_session_tool_face_prefix`（:1078，放锁读库、加锁 append-only 回填防 TOCTOU 双建）；单写者写回 `store_session_frozen_tool_schema_order`（:1318）；合并原语 `tool_loop.rs` `merge_frozen_tool_schema_order_baseline`（:134） |
| F2 | 已发出 schema 的序列化字节 | **窗口级**：一次工具环（单变体）/ 一个变体的工具环（多变体）= 一个稳定窗口；窗口内同名 schema 变化继续发首见冻结字节，变更延迟到下一稳定窗口 | 字节副本**不持久化**（局部 `frozen_tool_schemas`，`tool_loop.rs:459`；变体环各自持有）；仅摘要落库 `toolSchemaDigest`（`types.rs:502`），None 缺省不抹已有值 | `tool_loop.rs` `freeze_tool_schemas_for_prompt_cache`（:164）、`tool_schema_digest`（:206）、统一门面 `freeze_tool_face_for_prompt_cache`（:237） |
| F3 | tool-face generation 代号 `g` | **会话级只升不降**：load 恢复取 `max`、永不归零回退；唯一 bump 点见 §5 | `ToolFaceBaseline.generation` + session.metadata `toolFacePrefixGeneration`（`types.rs:492`），与 F1/F2-digest 三键同 IMMEDIATE 事务（`repo.rs:3122` 取 max、:3126-3131 无变更跳写） | 唯一切代点 `helpers.rs` `converge_session_tool_face_prefix`（:1153）；快照形态 `types.rs` `ToolFacePrefixSnapshot`（:515） |
| F4 | available_skills 目录快照 | **会话级 first-write-wins**：首次生成即冻结，中途 skill_install 改 live registry 不改已发出的 system 目录；发送 fail-closed 等待持久化确认 | session.metadata `availableSkillsSnapshot`（`types.rs:470`），`ChatV2Repo::freeze_session_available_skills_snapshot`（`repo.rs:2851`）——代内已冻结（含空串）绝不覆盖；唯一合法覆盖路径见 §3 C1 | 前端消费点 `TauriAdapter.buildSystemPromptWithSkills`（`TauriAdapter.ts:5395`）→ `ensureAvailableSkillsSnapshotFrozen`（:5437，await 冻结 RPC，失败中止发送） |
| F5 | 技能正文 digest（**不存正文**） | 锚点级：注入时刻对 (skill_id, body) 取 sha256 联合摘要，随锚点持久化；重放门禁只比对 digest | `types.rs` `skill_body_digest`（:1195）；锚点 JSON 只含 digest 不含正文（隐私红线，`without_skill_contents` 纪律不变） | 门禁 `history.rs` `rebuild_anchored_skill_messages_gated_with_signal`（:898）：digest 命中才重建（live 同渲染函数、字节不漂移），mismatch → warn + skip，绝不伪造历史 |

## 2. 不冻（4 项）

| # | 对象 | 为什么不冻 | 代码锚点 |
|---|---|---|---|
| N1 | 技能正文本身 | 正文不落库、不做字节冻结；冻的只是 F5 digest。编辑/删除后门禁 skip（漂移承认，不修复）；正文逐字节回退即自愈 | `history.rs:898` 门禁；缺正文 warn+skip 不产生信号（:906-911）；mismatch 判定 :913-928 |
| N2 | user_profile 等 system 易变段 | 有意易变：每轮随记忆库/隐私模式变化，缓存收益由 system 稳定层分段（stable_system vs turn-volatile）负责，与工具面冻结无关 | `pipeline/prompt.rs`、`prompt_builder.rs` 注入点；反例 `prefix_snapshot_tests.rs` `todos_and_canvas_never_leak_into_stable_system` |
| N3 | reasoning/content 过滤器状态（**每流独立**） | 过滤器持有跨 chunk 行前缀/围栏/tail-hold 状态，reasoning 与 content 两路交错会互相污染，故 R4 #1 起 reasoning 用**独立实例**；状态是流内瞬态，流末 flush 即弃，不跨流、不落库、不冻结 | `stream_filter_core.rs` `StreamFilterCore`（:53-67，`wrap_token_filter` 与 `reasoning_wrap_token_filter` 分字段 + 「不与 content 路径共享实例」注释；核心仍未接线，两适配器 `llm_adapter.rs` / `variant_adapter.rs` 各持内联实例）；瞬态字段 `model_special_tokens.rs` `input_cursor`（:150）、`tail_hold_raw`/`tail_hold_stripped`（:166-170），流末 `flush`（:200-218） |
| N4 | available_skills_delta 尾部瞬态 | 目录增量通道：只拼在当前请求最后一条 user 尾部，每轮按 live registry 重算，零缓存成本（尾部必然新字节）——设计上**永不冻结**；compaction 换代后基线换 live 全量、delta 自然收缩 | 渲染函数 `progressiveDisclosure.ts` `generateAvailableSkillsDeltaPrompt`（:816，本轮 grep：定义外零调用方，仍未接线）；定稿 `r4-catalog-delta.md` |

## 3. 清（3 项，均已落地）

| # | 清什么 | 规则 / 现状 | 代码锚点 |
|---|---|---|---|
| C1 | compaction 后的目录冻结快照（**唯一合法覆盖路径**） | 仅当 `availableSkillsSnapshotPendingGeneration` **> 当前 generation** 时，freeze 原语放行覆盖：generation := pending 并清标记，该次写入即新代 first write；脏数据（pending <= generation）按无标记处理维持 first-write-wins。pending 声明两来源：compaction 落盘事务（`compaction.rs:1114`）+ 技能 digest mismatch 信号（§5 G2）；多次声明幂等折叠不重复 +1；从未冻结过快照的会话 no-op | `repo.rs` `freeze_session_available_skills_snapshot_with_conn` 换代分支（:2874-2886，generation 推进与清标记 :2895-2905）；`mark_session_available_skills_snapshot_stale_with_conn`（:2937）；键常量 :79-80；前端兑现 `TauriAdapter.ts:5437`（pendingGeneration 有效时跳过冻结字节、按 live 重生成再走 freeze RPC；loadSession 回灌 :3804-3811） |
| C2 | Utf8 invalid 的日志内容（**只记长度类元数据，不打原文**） | issue #122 定位探针：真正非法字节触发 U+FFFD 替换时 warn 只记 `invalid_len / valid_up_to / pos / pending_len_before / chunk_len`；flush 残留只记 `pending_len`；SSE 侧只记 `tail_len / text_buffer_len / pending_lines`。禁止打印 chunk / 用户文本；U+FFFD 替换语义零改动，不声称修复 #122 | `llm_manager/utf8_stream.rs` :76-91（invalid 分支）、:107-119（flush）；`utils/sse_buffer.rs` :211-216；文案一致性核查 `r9-i18n.md` |
| C3 | OpenAI retention 24h 死实现（**已删**） | `apply_openai_prompt_cache_retention` / `provider_accepts_prompt_cache_retention` 全仓零调用点且 5.6+ 分支带非法值 `ttl:"24h"`（官方唯一合法值 `"30m"`），R5 #1 裁决整体删除；原位留接线硬约束注释（仅官方端点、仅 30m、必须请求体快照测试）。本轮 grep 复核：两符号仅存于该注释 | `model2_pipeline.rs` :3588-3590 留痕注释；裁决 `r5-model2-telemetry.md` §3、复核 `r5-review-model2.md` §三、台账第 7 节 |

## 4. 不清（5 项，红线禁改区，本会话零触碰）

| # | 不清什么 | 依据 / 自证 |
|---|---|---|
| K1 | hooks 十五段准入序列与 TOCTOU 三段 | `hooks.rs` `ApprovalGateHook::before_tool`（impl :249、fn :254 起）十五段编排 + TOCTOU 三段（入口 Kill Switch / 审批后复核 / tool_loop 执行前终检「Final admission point」）；R2 #8 审阅逐段核对（`r2-review-semantics.md` §3/§4），此后各轮任务卡列为禁改区，hooks.rs 相对基座仅第 1 轮 P8 卫生提交 |
| K2 | `ApprovalGateHook` 链首位 | `default_pipeline_hooks`（`hooks.rs:161`，`Arc::new(ApprovalGateHook)` 为 vec 首元素）；顺序敏感——`TaskAuditHook::after_tool` 消费 `before_tool` 写入的准入证据，倒序即审计读到 fail-closed 假值；测试锁定 `default_hooks_keep_approval_gate_first`（:1517）+ `audit_consumed_admission_fields_start_fail_closed`（:1531） |
| K3 | 负例测试 `preserves_literal_tokens_in_prose` | `model_special_tokens.rs:691`（同族 :701 `preserves_literal_tokens_in_inline_and_fenced_code`）：正文/代码中的字面量特殊 token 必须原样保留——保守三形态哲学的锚，R4 起任务卡明令「一条不许删」；r6 #5 tail-hold 修复亦未动它 |
| K4 | `coordinator.rs` | 两处同名文件（`chat_v2/workspace/coordinator.rs`、`data_governance/migration/coordinator.rs`）全会话零触碰（各轮任务卡红线 + `r9-pr-body.md` 声明） |
| K5 | issue #122 病灶 | 只加定位探针（C2），不改解码行为、不声称修复；乱码根因（上游非法字节 vs 跨 chunk 切断 vs 其他链路）留待探针数据定位后另开会话处理 |

## 5. 切代（唯一 bump 点 + 信号旁路）

| # | 规则 | 代码锚点 |
|---|---|---|
| G1 | **仅 multi_variant converge 真分叉 bump tool-face generation**：fan-out join 后按变体索引序（非完成竞态序）从空表 append-only 合并出收敛序，存在某变体本地 order 不是收敛序前缀 → 真分叉 → `generation += 1`，新基线 = 索引序确定性合并结果；随后放锁经 `advance` 持久化（失败仅 warn，内存基线仍权威） | `helpers.rs` `converge_session_tool_face_prefix`（:1153；真分叉判定 :1173-1175、bump :1199-1206）；调用面 `multi_variant.rs` load :509/:2779/:2993 → 变体环统一门面 :1364/:1730 → join 后 converge :602/:2868/:3017 |
| G2 | **技能 digest mismatch 走 catalog pending 信号，不 bump tool-face g**：mismatch 是 history 段漂移而非工具序分叉，伪造分叉 order 逼 converge +1 会破坏 G1 不变量；正确代际是 available_skills 目录代——门禁出参聚合 → 趟末唯一写点声明 pending（幂等折叠、从未冻结则 no-op、写库失败降级为日志、绝不阻断发送）→ 前端下轮兑现（§3 C1） | 信号出参 `history.rs:898`（mismatch 收集 :922-926，按 skill_id 去重）；趟末聚合 :567-574；唯一写点 `helpers.rs` `record_skill_digest_prefix_generation_signal`（:1256，接线选择论证 :1237-1246）；pending 声明 `repo.rs:2937` |

**G1 之外一律不 bump**（与 `r2-freeze-matrix.md` §3 清单一致，现势锚点）：

| 场景 | 锚点 |
|---|---|
| load / 跨进程恢复回填（含并发首建 miss 双方合并：generation 只取 max、order 只补缺失名） | `helpers.rs:1078`；`repo.rs:3122` |
| 单变体纯前缀扩展（环内 load_skills 只追加新名，沿用当前代号） | `helpers.rs:1318` |
| 单变体窗口 digest 变化（只打 info 日志 + 更新本地对账值，变更随下一稳定窗口 / 多变体 converge 评估） | `tool_loop.rs:1139-1150` |
| converge 的 digest 共识采纳（r6 接线：仅「本地 order == 收敛 order」且全体候选 digest 一致才采纳；互异 / 全 None 保持既有值，采纳绝不触发 bump） | `helpers.rs:1180-1189` |
| available_skills 目录换代（F4/C1 的 catalog generation 与 F3 的 tool-face generation **正交**，互不触发） | `repo.rs:2851`/`:2937` vs `helpers.rs:1153`，无任何交叉调用 |

## 6. 交叉引用与行数自报

- 勘误与 R3–R6 语义补记：`r2-freeze-matrix.md` §6（本席同轮追加）。
- 机制来源：`r4-catalog-compaction.md`（C1 声明端）、`r5-catalog-pending.md`
  （C1 兑现端）、`r5-digest-generation-signal.md`（G2）、`r6-gen.md`
  （digest 共识采纳）、`r4-reasoning-filter.md` + `r6-filter.md`（N3）、
  `r4-catalog-delta.md`（N4）、`r3-utf8-probe.md`（C2）、
  `r5-model2-telemetry.md`（C3）、`r2-review-semantics.md`（K1/K2）。
- 表格行数（数据行，不含表头）：§1 冻 5 + §2 不冻 4 + §3 清 3 +
  §4 不清 5 + §5 切代 2 + §5 不 bump 清单 5 = **24 行**；连同
  `r2-freeze-matrix.md` §6 补记的勘误表 12 行 + 语义补记表 4 行，
  本席两文件合计 **40 行**。

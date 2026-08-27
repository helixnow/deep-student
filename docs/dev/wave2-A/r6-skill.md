# Wave2-A r6 #4：技能版本化二检 —— history.rs 门禁与切代信号

> 铁律遵守：未运行 cargo/npm/任何测试；未 git commit。
> 独占可写文件：`src-tauri/src/chat_v2/pipeline/history.rs`（本文档除外）。
> 结论三选一：**确认**。未发现明确 bug，history.rs 零改动。

## 审查范围与方法

复检对象是 r3（digest 门禁，`r3-skill-replay-gate.md`）与 r5 #8（切代信号，
`r5-digest-generation-signal.md`）在 `history.rs` 的落地形态，基线 tip
`4b784bb4`。除通读 history.rs 全文外，逐一交叉验证了门禁依赖的四个对端：

- types.rs：`SkillInjectionAnchors.skill_content_digests` / `content_digest_for`
  / `skill_body_digest`（digest 原语与旧 JSON 兼容）；
- tool_loop.rs：turn 级（:707-735）与环内 tool 级（:1967-2017）两个锚点
  生产点的 digest 取材；
- helpers.rs：`record_skill_digest_prefix_generation_signal`（:1222）唯一写点
  与 `make_transient_skill_message` / `insert_transient_skill_messages` /
  `build_transient_skill_messages_with_audit_excluding` 渲染链；
- repo.rs：`mark_session_available_skills_snapshot_stale_with_conn`（:2937）
  幂等折叠与 `freeze_session_available_skills_snapshot_with_conn`（:2865）
  的 pending > generation 有效性过滤。

## 确认清单（逐条与代码对上）

### 1. 门禁四分支判定：与 r3 契约逐条一致

`rebuild_anchored_skill_messages_gated_with_signal`（history.rs:898-933）：

| 场景 | 代码行为 | 判定 |
| --- | --- | --- |
| 正文缺失 | :906-912 warn + `continue`，文案未变 | ✅ 旧行为保持 |
| 有 digest、正文存在、digest 命中 | :913-929 落空 → :930 走 `make_transient_skill_message` | ✅ live 同渲染函数，字节相等 |
| 有 digest、正文存在、字节漂移 | :915-927 warn（含 anchored/current 双侧 digest）+ skip + 信号去重追加 | ✅ 不伪造历史 |
| 无 digest（旧锚点 / `anchors=None`） | :913 `content_digest_for` 返回 `None` → 直接重建 | ✅ 向后兼容 |

skip 不阻塞不换序（单层 for + `continue`）；两层兼容薄包装（二参 :843、
三参 :871）均为一行委托，无逻辑复制。

### 2. 三个消费点全部走带信号版、共享同一聚合出参

| 行号（当前） | r3 文档行号 | 位置 | anchors 实参 |
| --- | --- | --- | --- |
| history.rs:164 | 159 | turn 级（`turn_skill_ids` 非空才进） | `Some(anchors)` |
| history.rs:333 | 327 | tool 级 `tool_call_id` 命中 | `skill_anchors.as_ref()` |
| history.rs:365 | 358 | tool 级兜底（未匹配追加末尾，warn 保留） | `skill_anchors.as_ref()` |

三处正文来源一致：`ctx.options.replay_skill_contents.as_ref()
.or(ctx.options.skill_contents.as_ref())`。聚合变量
`digest_mismatch_skill_ids`（:113）在整趟消息循环内共享，去重在门禁函数
内部按 skill_id 完成（:924-926）——**跨消息、跨消费点**都不会重复计数。

### 3. 生产/重放 digest 严格同源，live 从不截断正文

- 两个生产点（tool_loop.rs:717-724、:1986-1996）对「渲染注入消息所用的
  同一 `skill_contents` 映射」（同样 replay 优先、退回 options）算
  `skill_body_digest(id, body)`；正文不可得不写假 digest。
- `build_transient_skill_messages_with_audit_excluding`（helpers.rs:856-877）
  超预算是**整条 drop**（`dropped_skill_ids`）而非截断——被注入技能的
  消息字节 = `make_transient_skill_message(id, 原始正文)`，与 digest 取材
  完全同体。重放侧命中重建走同一函数、同一原始正文 → 字节相等成立。
- turn 级与 tool 级共用消息级 `skill_content_digests` map（按 skill_id 键，
  同轮同 id 必同体），门禁两级共查同一 map，无二义。

### 4. 切代信号：边界、位置、幂等都正确

- **信号边界**（只收确定性证据）：仅「有 digest + 正文存在 + 字节漂移」
  进信号；digest 命中、正文缺失、旧锚点无 digest 三种情形都不进
  （:913 的 `if let Some(stored)` 包住 :924 的追加点，缺正文分支 :906 在
  digest 比较之前 `continue`）——与 r5 表格逐行一致。
- **记录点位置**（:573-578）：消息循环结束后、microcompact / compaction
  summary 插入 / FIFO 裁剪之前。两个早退路径（:53、:90，历史为空）
  发生在任何门禁调用之前，不存在「有 mismatch 却漏记录」的窗口；
  强制 compaction 的 `return Ok(true)`（:658）在记录点之后，外层 while
  重跑第二趟重复调用由 repo 原语幂等折叠（:2948-2953 已有有效 pending
  时返回既有值不再 +1，repo.rs:5064-5079 测试钉死该行为）。
- **写点纪律**：helpers.rs:1222-1262 先落结构化计数日志（固定前缀
  `skill_digest_generation_signal`）再 IMMEDIATE 事务 mark；
  `Ok(None)`（从未冻结快照）降级 debug、`Err` 降级 warn，绝不阻断发送；
  不推进 updated_at。与 r5 文档声明逐条对上。
- **消费侧衔接**：freeze 原语只认 `pending > generation` 的有效标记
  （repo.rs:2876-2878），脏数据按无标记处理，first-write-wins 不回退——
  信号在前端 TauriAdapter 消费前安静滞留是设计内状态。

### 5. 插入位置与下标维护无越界/漂移

turn 级插入（:173-189）：`insert_at` 取 `last_user_message_index`
（`before_turn_user=false` 时取末尾）并 `.min(len)` 钳制；`inserted` 用
前后 len 差测量——正确覆盖了 `insert_transient_skill_messages` 在
`insert_at == 0` 时额外插一条 request anchor 消息的情形（helpers.rs:793-796，
live 同函数同行为）；`insert_at <= index` 才右移下标。全部 skip（restored
为空）时不插入、不产生 anchor 消息，与「该位置前缀已漂移」语义一致。

## 非 bug 观察（不改代码，留档）

1. **正文缺失不进信号的残余缺口**（r5 已声明的刻意收窄）：技能被
   删除/停用后当轮请求不携带正文 → warn+skip 但无切代信号，前缀同样
   漂移却不换代。这是 r5 表格明示的边界（缺正文 digest 无从比较，且
   r3 前语义即如此），维持现状；若后续要收口，正确做法是在锚点「有
   digest 但正文缺失」时也计入信号（有 digest 即证明锚定时正文存在，
   缺失同样是确定性漂移）——属语义扩展，非本轮 bug。
2. **assistant 消息有 tool 级锚点但重放不到任何 tool entry 时静默丢失**
   （:303 的 `!tool_entries.is_empty()` 外层条件）：变体过滤或老数据把
   工具块滤空时，`pending_tool_anchored` 不会被 drain，无 warn 无信号。
   该位置在重放视图里本就不存在（整个工具轮消失），skip 与 r3 语义
   一致，仅缺一条可观测日志；不构成错误字节。
3. **变体路径不重建技能锚点**：`load_variant_chat_history`
   （multi_variant.rs:2142）完全没有 skill anchors 还原（自然也无门禁/
   信号）。属 multi_variant 席位范围（r6 #1 可写 multi_variant.rs），
   本席只记录：变体扇出的 history 段缺技能消息，与单变体路径存在
   前缀差异。
4. **`skill_content_rev` 仍是只声明未写入的保留字段**（types.rs:1168，
   全仓无写点）：r3 #2 预留的可选世代号，当前恒 `None`，门禁不依赖它，
   无害。
5. **文档/注释行号漂移**：r3 文档的消费点行号（159/327/358）现为
   164/333/365；`skill_replay_digest_tests.rs` 文件头引用的
   `history.rs:809` 亦已漂移（该文件本轮不可写）。纯文案，不影响行为。

## 返回摘要

- **结论：确认**。r3 门禁四分支、r5 信号边界/聚合/记录点/幂等、生产-
  重放 digest 同源性、插入下标维护全部与代码对上，`history.rs` 无明确
  bug，零改动。
- 交叉验证覆盖 types.rs / tool_loop.rs 两个生产点 / helpers.rs 写点与
  渲染链 / repo.rs 两个原语及其测试。
- 留档五条非 bug 观察：缺正文不进信号的残余缺口（刻意收窄）、tool
  锚点滤空静默、变体路径无锚点还原（multi_variant 席）、
  `skill_content_rev` 保留字段、文档行号漂移。

# Wave2-A 第 10 轮 #2：全 PR 交叉终审 —— 重放 / digest / llm_content

- 作者：0824 Wave2-A 第 10 轮子代理 #2（`claude-fable-5-thinking-xhigh`）
- 日期：2026-08-26
- 基线：`cursor/0824-wave2-agent-cache-a875` @ `659b8c54`；官方基座
  `origin/cursor/0824-cde6` @ `061b4815`
- 方法：纯静态读码 + grep + git 考古（含对基座与 r3 时点 `6069675e` 的
  历史快照比对）。**零编译、零测试执行、零产品代码改动**（本机
  rustc 1.83.0 ≠ 项目要求 1.98，铁律停测）；本席唯一写入面 = 本文档。
- 行号口径：均为本轮 tip 实际读取值（非沿用早轮文档），漂移处已注明。

---

## 0. 总结论

**确认**。重放 / digest / llm_content 维度的全部生产改动（门禁函数与三
消费点、锚点类型与 digest 算法、两个锚点生产点、阶段 4.6 早写、repo 三列
四原语、分支复制补拷、七个测试文件的头部合同）逐项与实现对得上，未发现
新缺陷、未发现本轮新引入的字节漂移面。已登记残留（retry 缺口、
multi_variant 无早写、删除不进信号、#122）经复核**全部仍在且均系继承**，
本轮无人声称已修，维持残留定性不翻案。

**一处文档翻案（只翻文档、不翻代码）**：`r3-review-replay.md` §1.3
怪癖 2 声称「变体的 sidecar 仍在 multi_variant.rs 自己的保存点
(:3654/:3728) 落库」——经 git 考古证伪：**该两行自始至终在
`#[cfg(test)] mod variant_replay_tests` 内**（r3 文档落盘 commit
`6069675e` 时点 mod 起始 `:3629`，两调用 `:3654`/`:3728` 均在其中；
本轮 tip 移位为 `:3634`/`:3659`/`:3733`，性质不变）。多变体扇出的
**生产**路径（`save_multi_variant_results`，现 `:3211` 起）从 V20260806
起就没有任何 sidecar 写点——不是「有自有保存点、只缺前移」，而是
**变体轮自身的 sidecar 全程不落库**。该状态经与基座快照比对确认为
**继承基座**（基座 repo.rs 已有全部三列原语、multi_variant 读侧
override 已在 `:2216`），非本 PR 引入 → 代码定性仍归**残留**，但
r3 文档与沿用其表述的台账条目（r9-open-items §2 第 2 行「变体的
sidecar 仍在自己的保存点落库」隐含前提）应按本节口径更正，残留的
实际修复面比登记的更大：需给 `save_multi_variant_results` 补
user 块 `llm_content` 与变体工具块 `tool_call_id`/`round_text` 写点，
而不只是前移。

---

## 1. 门禁函数与三消费点（history.rs）—— 确认

### 1.1 `rebuild_anchored_skill_messages_gated_with_signal`（`:904-939`）

四分支判定逐条复核，与 r3/r5 合同一致：

| 分支 | 行为 | 信号 | 取证 |
|---|---|---|---|
| 正文缺失 | warn + skip（旧行为） | 不进 | `:912-918`，`else` 早 continue，未触 digest 比较 |
| 有 digest 且漂移 | warn + skip | 进（按 skill_id 去重 `:930-932`） | `:919-934`；warn 文案明示「不伪造历史」 |
| 无 digest（旧锚点/空 map） | 有正文即重建 | 不进 | `content_digest_for` 返回 None 跳过 if-let |
| digest 命中 | `make_transient_skill_message` 重建 | 不进 | `:936`，与 live 同一渲染函数 |

纯函数、无 IO ✓。两个兼容入口 `:846`（二参）/ `:877`（丢信号）均为
薄包装 + `#[cfg_attr(not(test), allow(dead_code))]`（r9 小问题 C 处置），
grep 复核非 test 生产调用方为零：`helpers.rs:2375` 在
`#[test] fn test_p1_8_cross_turn_injection_point_bytes_live_eq_replay` 内，
其余调用全在三个测试文件与 history.rs 内联测试模块。✓

### 1.2 三消费点（`load_chat_history_pass`）

| 消费点 | 位置 | 锚点 | 正文来源 | 信号 |
|---|---|---|---|---|
| turn 级 | `:164-172` | `anchors.turn_skill_ids`（`:161` 过滤空） | `replay_skill_contents.or(skill_contents)` | 共用 `digest_mismatch_skill_ids` |
| tool 级（call id 命中） | `:333-341` | `anchored.skill_ids`，anchors 传消息级共享 map | 同上 | 同上 |
| tool 级兜底（id 未匹配） | `:365-373` | 同上，warn 后追加 | 同上 | 同上 |

- 三处正文优先级与两个生产点（tool_loop）一致 ✓；tool 级与 turn 级共用
  同一 `skill_content_digests` map ✓（types.rs 设计即如此）。
- `turn_skill_ids` 为空时 `tool_anchored` 仍独立重放（`:295-299` 初始化
  不受 `:161` 过滤影响）✓。
- turn 级插入点：`before_turn_user` → `last_user_message_index`（即锚点
  所属轮自己的 user 消息之前），插入后右移下标（`:185-189`，计入
  `insert_transient_skill_messages` 可能补插的 `<request_context>` 壳）✓；
  与 live（tool_loop `:762-763` 插在历史末尾、user 之前）字节同位。
- 聚合信号唯一写点 `:573-578` → `record_skill_digest_prefix_generation_signal`
  （helpers.rs `:1256-1296`）：结构化 warn 先落、IMMEDIATE 事务写
  pending 换代标记、失败降级 log 不阻断 ✓。幂等复核：
  `mark_session_available_skills_snapshot_stale_with_conn`
  （repo.rs `:2937-2971`）在 `pending > generation` 已存在时直接返回
  现值不再 bump——外层 while 因强制 compaction 重跑本趟时重复调用
  确实天然幂等 ✓（信号记录在 compaction 早退 `return Ok(true)` 之前，
  丢弃趟也已写标记，无害且有意）。

### 1.3 门禁 skip 的下游闭环（顺带核）

digest mismatch 被 skip 的技能不进 `chat_history` → tool_loop
`anchored_skill_ids_in_history`（helpers.rs `:898-903`，按瞬态消息
metadata.skillId 收集）排除集不含它 → 本轮 turn 级注入以**新正文**在
**当前轮位置**重新注入并落**新 digest** 锚点。旧位置漂移（信号已发、
待换代），新位置自洽——无重复注入、无永久丢失。✓

---

## 2. types.rs 新字段与 digest 算法 —— 确认

- `SkillInjectionAnchors.skill_content_digests`（`:1163-1164`）：
  `serde(default)` + 空 map 跳过序列化 → 旧 JSON 反序列化为空 map =
  「旧锚点无 digest」兼容档；无 digest 的新锚点序列化字节与 r3 前一致
  （双向兼容，测试 `:4415-4472` 钉死，含隐私断言：JSON 只含 digest
  不含正文）。✓
- `is_empty()`（`:1174-1176`）刻意不纳入 digest/rev——与 r3 评审结论
  一致（纳入会改变 persistence 落库判定）。✓
- `content_digest_for`（`:1180-1182`）：旧锚点恒 None。✓
- `skill_body_digest`（`:1195-1203`）：sha256 over
  `id ‖ 0x1f ‖ body ‖ 0x1e`，小写 hex；拼接歧义/单字节敏感/id 换绑
  敏感由 `:4475-4491` 钉死。与 history 门禁 `:920` / tool_loop 两写点
  同一函数，无第二实现。✓
- `MessageMeta.skill_injection_anchors`（`:1858`）持久化载体、
  `SendOptions.skill_injection_anchors`（`:2717-2718`）`serde(skip)`
  运行时锚定记录——不来自前端、不参与序列化。✓
- **观察（残留级 nit）**：`skill_content_rev`（`:1168`）全仓**无写入方**
  （仅类型定义 + 序列化测试 + tool_loop 头注释提及），恒为 None。
  types.rs 文档写明「由写入方决定语义、缺字段 = None」，读侧无消费，
  行为无害；但 tool_loop.rs `:27` 头注释「anchors `skill_content_digests`
  / `skill_content_rev`，r3 落地」对 rev 属过满宣称（digest 已落地，
  rev 只是预留字段）。建议后续文档轮改口为「rev 预留未接线」。

---

## 3. tool_loop.rs 锚点生产者 —— 确认

- **turn 级**（`:703-754`）：首轮冻结构建；digest 取材 = 渲染注入消息的
  同一 `skill_contents`（`:707-712` replay 优先，`:730-742` 对
  `injected_skill_ids` 逐个 `filter_map`——**正文不可得不写假 digest**，
  重放侧按旧锚点兼容档处理）✓；`before_turn_user = !is_continue`
  （`:748`）与 history `:175` 消费对齐 ✓。
- **环内 load_skills**（`:1960-2031`）：`batch_contents` 同一优先级
  （`:1963-1969`）；`tool_anchored` push provider `anchor_call_id`
  （`:1960-1962` 过滤空 id，空 id 根本不进锚定分支）+ digest 并入消息级
  共享 map（`:2024-2026`，同轮同 id 必同体，覆盖写无歧义）✓。
- digest 与发出字节严格同源的纪律在两个生产点注释均明示，与
  edit_delete 测试 `anchors_for_turn` 的「同体取材」构造互证。✓

---

## 4. persistence.rs 早写与 pipeline.rs 阶段 4.6 —— 确认

- `persist_user_llm_content_early`（persistence.rs `:275-311`）：
  `live_user_llm_content()` None → skip；
  `existing_user_content_block_id`（`:201-210`，首个 CONTENT 块）查不到
  行 → skip；命中则单条 targeted UPDATE 只写 `llm_content` 一列。✓
- 唯一调用点 pipeline.rs `:1000-1010`（阶段 4.6）：位于
  `compile_frozen_context`（4.5，`:995-998`）与 `execute_with_tools`
  （5，`:1017-1023`）之间，`save_user_message_immediately` 已在更早
  执行——「行已 INSERT、编译已冻结、首个主对话 provider 请求前」三前置
  全部满足；Err 只 warn 不阻断 ✓。
- 早写不被保存点重建抹掉：`create_block_with_conn` 的
  `ON CONFLICT(id) DO UPDATE SET` 列清单（repo.rs `:1727-1740`，13 列）
  **不含**三旁路列——crash tests「保存点重建不抹早写」宣称与实现相符 ✓。
- 语义改写路径失效闭环：`update_block_with_conn`（`:2115-2139`）
  `CASE WHEN content IS ?3` 同语句失效 + 旧库无列回退；
  `clear_block_llm_content_with_conn`（`:2052-2065`）供编辑事务显式置
  NULL（全 NULL 载荷走不进 `update_block_replay` 的 is_empty 早退）✓。
- **文档 nit（不阻断）**：persistence.rs `:272-273` rustdoc
  「查不到用户 CONTENT 块（即时保存失败、wake/retry 新 id 无行）时跳过，
  后续 save_results 会兜底补写」——兜底只对「即时保存失败」成立
  （save_results skip_user=false 会重建行再写）；**wake/retry 下
  save_results 同样查不到行、无兜底**（r3 评审 §1.3 与 retry gap 测试
  头部均已明说，函数内日志文案「may retry if the block exists」与
  pipeline.rs `:1006` warn 文案是准确的）。仅该句 rustdoc 把两种情形
  混在一处，建议后续文档轮拆句。

---

## 5. repo.rs 三列与分支复制「是否带上 digest」—— 确认（答案：带，但不经三列）

### 5.1 三列四原语（`:1928-2065`）

写 `:1945-1977` / 读 `:1982-2019`（全 NULL 行不进表）/ 复制
`:2025-2045`（SQL 级子查询，分支/深拷贝专用）/ 清 `:2052-2065`；四处
均容忍 `no such column`（V20260806 未迁移旧库静默降级）✓。

### 5.2 任务卡核心问题：分支复制是否带上 digest

**digest 不在三列里，也不应在**——它在助手消息
`meta.skill_injection_anchors.skillContentDigests`（JSON）中。分支复制
（manage_session.rs `branch_session_in_db` `:1354` 起）：

- 消息级：新消息 `meta: msg.meta.clone()`（`:1587`）整体带走 →
  锚点（turn_skill_ids / tool_anchored / **digests** / rev）随 meta JSON
  原样进入分支会话 ✓；
- 块级：两处 `create_block_with_conn` 之后**均**紧跟
  `copy_block_replay_with_conn`（主复制环 `:1645`、compaction summary
  克隆 `:1685`）补拷三列 ✓；全仓 grep 确认无第三处块深拷贝路径漏拷
  （其余 create_block 调用点均为 live 新块写入，无需拷）。
- 一致性闭环：`tool_anchored[].tool_call_id`（meta 内）与块 sidecar
  `tool_call_id` 列都是 provider 原始 id、都不参与 `remap_ids_in_value`
  的 block/message id 重映射 → 分支会话重放时 history `:328` 的
  call-id 匹配仍然命中，tool 级锚点技能落位正确 ✓。
- **附注（继承性边界，非缺陷）**：分支后 `meta.tool_results[].block_id`
  指向旧块 id（meta 整体 clone 不重映射），thought_signature /
  reasoning_content 回填靠 `build_tool_round_messages` `:1063-1066` 的
  tool_call_id 或 block_id 双路匹配——已迁移库经补拷的 tool_call_id
  命中 ✓；**未迁移旧库**回退 `tc_{新块id}` 派生时双路皆 miss →
  分支会话丢 thought_signature。PR 前分支会话本就如此（当时恒为
  `tc_{block_id}` 派生），本 PR 在已迁移库上反而修好，旧库维持旧损。

---

## 6. 测试头部合同 —— 确认（附行号漂移 nit）

### 6.1 `llm_content_retry_gap_tests.rs`（r7 #6）

头部「现状时序」三条与生产逐一实证：retry handler
（send_message.rs `:798` 起）确以 `user_message_id: None`（`:1067`）+
`skip_user_message_save = Some(true)`（`:1056`）重跑管线，
`find_preceding_user_message_with_attachments`（`:863`）取前置 user 裸
content。四缺口（无处落库 / 陈旧 sidecar / 错失 NULL 回填 / 双重包含）
的复刻函数语义与 persistence/history 现实现一致；「修复合同」测试
（复用前置 user id）为未落地预期，生产未动 ✓。**缺口为 V20260806 起
既有语义、非本会话引入**——与任务卡口径一致，维持残留。测试 mod 已在
pipeline.rs `:104` 以 `#[cfg(test)]` 接线（七个测试文件 `:90-104` 全部
已挂，r9 归档项「挂/不挂决定」可记为已挂）。

### 6.2 `skill_replay_digest_tests.rs`（r3 #5 + r7 #3）

- r3 契约副本（第 1-4 节）+ r7 第 5 节直接打生产门禁：
  `finale_modified_skill_*` 的 mismatch→skip→去重信号→稳态→精确回退
  恢复，`finale_deleted_skill_*` 的缺正文永不进信号→混场只报漂移者→
  恢复分档（精确还原命中 / 字节不同转 mismatch），与 §1.1 四分支实现
  逐条一致 ✓；两兼容入口与带信号版判定一致的断言亦与实现相符 ✓。
- 第 1 节「缺口反例」已按 r7 更新说明转性为「兼容入口语义钉子」，
  不再宣称生产缺口 ✓。
- **nit**：头部对齐表引用 `history.rs:809` / `:809-824` / `:815-821` /
  `:817-821` 为 r3 时点行号，现漂移至 `:846-851`（兼容入口）与
  `:912-917`（缺正文 warn 分支）。r9 #1 已在自己文档改口「现 :846」，
  测试头部未同步。历史注记性质、断言本身按符号引用不受影响，不阻断。

### 6.3 `skill_replay_edit_delete_tests.rs`（r7 #4）

六条钉死契约（编辑 skip+信号 / 删除不进信号【r6 #4 留档残余缺口，
语义扩展时断言应翻转】/ replay 快照优先 / 回滚自愈 / 旧锚点盲取反例 /
全 skip 插入层零残留）与生产一致；第 6 条由 helpers.rs
`insert_transient_skill_messages` `:790-792` 空列表早退（连
`<request_context>` 壳都不插）实证 ✓。**nit**：头部「`history.rs:898`
起」现漂移至 `:904`；「三个消费点 :164/:333/:365」仍精确命中 ✓。

### 6.4 `llm_content_crash_tests.rs`（r3 #4 + r7 #5，顺带核）

头部合同与阶段 4.6 实现、`ON CONFLICT` 列清单（§4）、旧库降级、
空串/空白串边界（写侧 `live_user_llm_content` 的 `!is_empty` 过滤与
读侧 history `:264` 同名过滤）互证一致 ✓。其「已知缺口记录」条目
（multi_variant 无早写）与本文 §0 翻案后的更重口径不矛盾——该条只
记录了缺口的下界。

---

## 7. 残留清单复核（全部维持，无一翻案为已修）

| 残留 | 首次登记 | 本轮复核结论 |
|---|---|---|
| retry llm_content 四缺口 | r6-6 / r7 #6 / r9 §2 | **仍在**（§6.1 实证）；修复合同测试已备未落地 |
| multi_variant 扇出无阶段 4.6 早写 | r3 §1.3 怪癖 2 / r9 §2 | **仍在且比登记更重**：变体轮 sidecar 生产**全程无写点**（§0 翻案 r3 定位）；继承基座，本 PR 的 multi_variant diff 全为工具前缀代际收敛（#1 席位面），未触 sidecar |
| `load_variant_chat_history` 无技能锚点还原 | r6 #4 / r9 §2 | **仍在**：变体加载（multi_variant.rs `:2144` 起）复用 llm_content override（`:2284-2296`）与 `build_tool_round_messages`（`:2328`），但全程无 `rebuild_anchored_skill_messages*` 调用 |
| 变体重放只认 `MCP_TOOL` 块型 | （本轮观察补记） | 变体 `:2277-2280` 仅过滤 `MCP_TOOL`，主路径 `is_tool_call_block`（history.rs `:1222-1238`）覆盖十种工具块型——变体重放会丢非 MCP_TOOL 工具轮。**基座同款**（基座 `:2212` 同一过滤），继承非引入；建议并入 multi_variant 残留组一并修 |
| 删除/正文缺失不进切代信号 | r5 收窄 / r6 #4 / r9 §2 | **仍在且为有意收窄**；r7 #4 反例钉死现状（§6.3），语义扩展需产品裁决 |
| issue #122（流式乱码） | r9 §2 明令禁修 | **仍 OPEN**。全 PR grep 复核：仅 `utf8_stream.rs` 定位探针（+23 行，warn 只记长度类元数据），无任何席位/文档声称已修 ✓ |

## 8. 小问题汇总（全部不阻断、不改代码，留后续文档轮）

1. `skill_content_rev` 预留字段无写入方；tool_loop.rs `:27` 头注释对其
   「r3 落地」过满宣称（§2）。
2. persistence.rs `:272-273` rustdoc 兜底宣称对 wake/retry 分支过宽（§4）。
3. digest/edit_delete 测试头部 r3/r7 时点行号漂移（`:809*` → `:846/:912`；
   `:898` → `:904`）（§6.2/§6.3）。
4. r3-review-replay.md §1.3 怪癖 2 与沿用其口径的台账条目按 §0 翻案更正
   ——建议台账归档席位（#9/#10）引用本文档口径。

## 9. 红线自证

- 本席工作区改动 = 新建本文档一个文件（`git status` 唯一新增路径）。
- 未碰：产品代码、任何测试文件、coordinator.rs、hooks、负例测试、
  TauriAdapter；未执行 npm/cargo/安装/测试/commit。
- 本文全部结论为静态读码证据，不构成编译或运行时证据，与 r9-pr-body
  的 Draft 诚实口径一致。

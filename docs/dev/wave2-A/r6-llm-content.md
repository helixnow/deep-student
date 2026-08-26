# R6-#3 二检：`persist_user_llm_content_early` 与 pipeline.rs 调用点

- 席位：Wave2-A 第 6 轮 #3「llm_content」（claude-fable-5-thinking-high）
- 结论：**确认（三选一之「确认」）——未发现明确 bug，persistence.rs 零改动**
- 铁律遵守：未执行任何编译/测试/CI；未 commit/push；本席只产出本文档
- 复检对象：`src-tauri/src/chat_v2/pipeline/persistence.rs:275-311`（R3-#1 新函数）
  与 `src-tauri/src/chat_v2/pipeline.rs:994-1004`（阶段 4.6 唯一调用点）
- 前序依据：`r3-llm-content-forward.md`（作者自述）、`r3-review-replay.md` §1
  （第一遍审阅）、台账 R3-2 / R5-8

## 1. 复检方法

第 3 轮审阅（#8）核的是「时机链 + 幂等 + 失败语义」。本轮换角度做第二遍：
沿**数据行的生命周期**核——早写落在哪一行、这一行后续会被谁改写、改写会不会
抹掉早写的字节、读侧最终从哪一行取回。每条结论均给 file:line 静态证据。

## 2. 确认链（8 条，全部通过）

### 2.1 调用点唯一且时序成立

`persist_user_llm_content_early` 全仓生产调用点唯一：`pipeline.rs:998`
（阶段 4.6，grep 复核仅 persistence.rs 定义 + pipeline.rs 一处调用 + 文档命中）。
时序：`save_user_message_immediately`（`pipeline.rs:737`，execute 内、
execute_internal 之前）→ 阶段 4.5 `compile_frozen_context`（`pipeline.rs:989-992`）
→ 阶段 4.6 早写 → 阶段 5 `execute_with_tools`（`pipeline.rs:1012`）。
「行已 INSERT + 编译已冻结 + 首个主对话 provider 请求之前」三前提与 R3 口径一致。

### 2.2 编译产物在 4.6 之后不再变——早写字节 == live 字节

`compiled_current_user_message` 全仓唯一生产写点是
`context_compiler.rs:533`（`compile_frozen_context` 内部）；
`tool_loop.rs:764-768` 与 `multi_variant.rs:1196-1205` 均为只读消费；
`history.rs:2083` 的赋值在 `#[cfg(test)]` 测试内。即阶段 4.6 写下的
`live_user_llm_content()` 与阶段 5 实际入 messages 的当前 user 内容
（`tool_loop.rs:764-768` 优先取同一字段）逐字节同源。无「早写后再编译」窗口。

### 2.3 目标行身份稳定：确定性 block id

`build_user_message` 的 block id 为确定性派生
`blk_ucontent_{message_id 去前缀}`（`user_message_builder.rs:139`，A1 修复），
故 `save_user_message_immediately` / `save_intermediate_results` / `save_results`
三处重复构建命中**同一行**；早写经 `existing_user_content_block_id`
（`persistence.rs:201-210`）从 DB 找回的也是这一行。不存在「早写行 A、
后续保存行 B、A 成孤儿」的分叉。

### 2.4 后续保存不会抹掉早写（本轮新核的关键点）

这是 R3 两份文档都未显式论证的一环，本轮补核：

- `create_block_with_conn`（`repo.rs:1701-1758`）是
  `ON CONFLICT(id) DO UPDATE SET` **列清单式**原地更新，SET 清单
  （`repo.rs:1727-1740`）不含 `llm_content` / `tool_call_id` / `round_text`
  三旁路列——后续保存点重建用户块行时**不触碰**早写的 sidecar；
- `create_message_with_conn`（`repo.rs:1301-1318`）同为 `DO UPDATE`
  而非 `INSERT OR REPLACE`，用户消息行重存**不触发 CASCADE 删块**
  （persistence.rs:503-505 注释的自述与 SQL 实证一致）；
- 即使假想被删，`persist_replay_sidecar` 在同一显式事务内
  （`persistence.rs:614` / `:1275`）以同一 `live_user_llm_content()`
  幂等重写，事务原子性兜底。

结论：早写在「首个请求 → 首个保存点」窗口内稳定存在，窗口后被同值覆写，
无任何路径回退为 NULL。

### 2.5 三列整写的 NULL 不构成误清

`update_block_replay_with_conn` 单条 UPDATE 恒写三列
（`repo.rs:1953-1965`），早写对 user CONTENT 块把 `tool_call_id` /
`round_text` 置 NULL——该块从不携带工具旁路数据（工具旁路只写在工具块行，
`persistence.rs:231-248`），读侧 `get_block_replay_map_with_conn` 按块 id
分发，无跨块串扰。后续保存点对同块同形状重写，语义恒定。

### 2.6 读侧取行与写侧一致

`history.rs:252-264`：user 消息按 `block_index ASC`
（`repo.rs:1908-1911`）遍历 CONTENT 块 `find_map` 首个非空 `llm_content`；
写侧 `existing_user_content_block_id` 取同序首个 CONTENT 块——常规单块
消息恒同一行；legacy 多 CONTENT 块（A1 前孤儿）场景下唯一被写入的行就是
被读中的行。图片通路保留：override 命中时仍取快照解析出的 images
（`history.rs:275-279`），字节权威只接管文本。

### 2.7 三条跳过路径语义正确（逐一对源码核实）

| 路径 | 证据 | 早写行为 | 判定 |
|---|---|---|---|
| 编辑重发 | `send_message.rs` 编辑事务失效旧值；`history.rs:2035-2101` 测试钉死「补写后与编辑轮 live 包装字节相等」 | 行存在 → 用新编译值补写 | 正确（这正是 P0 的设计目的） |
| wake | `send_message.rs:272-274`（wake 内容瞬态、skip=true、不建 user 行） | 查不到块 → 跳过 | 正确（无行可写、无历史可漂移） |
| retry | `send_message.rs:1056` skip=true + `:1067` `user_message_id: None`（管线生成新 id，DB 无行） | 查不到块 → 跳过 | 正确（persistence.rs 内注释所述与实现相符） |

### 2.8 失败语义与旧库兼容

调用点 Err 只 `log::warn!` 不阻断发送（`pipeline.rs:998-1004`）；
V20260806 列未迁移的旧库在 repo 层按 `no such column` 静默跳过并返回 Ok
（`repo.rs:1938-1940` / `:1968-1974`）——早写不会把旧库用户的发送打断。

## 3. 记录在案、不构成本轮补丁的事项

按任务卡「仅明确 bug 才改 persistence.rs」，以下四项均非明确 bug，
且第 3、4 项的修复位不在 persistence.rs（越权），全部只记录：

1. **is_continue 轮写入未发送的包装**（R3 已记录的既有怪癖）：
   `tool_loop.rs:761-769` 在 continue 轮不推当前 user 消息，但早写与
   save_results 一样照写 `llm_content`——与既有保存点逐字节同行为，
   二检维持「不翻案」。
2. **multi_variant 扇出不经 `execute_internal`**：变体路径无早写，
   崩溃窗口仍在（R3 已记录，`multi_variant.rs` 自 R2 后未再触碰该面）。
   属覆盖缺口非早写缺陷，留后续轮。
3. **retry 轮的 live 包装无处落库**（本轮二检新明确的既有缺口，非回归）：
   retry 传新 `user_message_id`（`send_message.rs:1067`），早写跳过之外，
   `save_results` 的 skip 分支同样查不到块（`persistence.rs:732`）——
   retry 实际发送的新编译包装**从未**写入原 user 行，原行保留首发轮字节。
   下一轮 history 重放首发包装、与 retry 轮 live 字节可能漂移（如
   runtime_facts 时间变化）。此为 sidecar 体系自 V20260806 起的既有语义
   （原 `persist_replay_sidecar` 行为完全相同），非 R3 前移引入；修复位
   在 retry handler（传原 user_message_id 或显式失效重写），不在
   persistence.rs 可写面内。**建议列入后续轮遗留表。**
4. 风格备注（零行为影响）：`persist_user_llm_content_early` 是
   `async fn` 但函数体零 await（同步 SQLite IO 在 async 上下文，
   R2-#7 已记录为库内通行低危模式），可去 async 但无收益、不动。

## 4. 已验证 / 未验证

### 已验证（仅静态证据：读代码 / grep）

- 调用点唯一性、时序链、编译产物唯一写点（§2.1/§2.2）——本席 grep；
- `ON CONFLICT DO UPDATE` 列清单不含三旁路列、消息行无 REPLACE/CASCADE
  （§2.4）——本席读 SQL 原文；
- 确定性 block id、读写侧取行一致、三跳过路径的 handler 源码（§2.3/§2.6/§2.7）
  ——本席逐文件读码；
- retry 缺口的完整证据链（`:1056/:1067` + `persistence.rs:732` skip 分支）
  ——本席交叉核对。

### 未验证（诚实归因）

- 未跑任何编译/测试：`llm_content_crash_tests.rs`（R3-#4）等相关测试仍
  只写不跑；早写在真实崩溃场景下的收益无运行时证据；
- §3.3 retry 漂移的实际影响幅度（runtime_facts 变化频度、缓存前缀断点位置）
  为源码推理，未对拍真实请求。

## 5. 收轮交接

- 本席产出：仅本文档（untracked）。persistence.rs / pipeline.rs 零 diff。
- 建议父代理：把 §3.3「retry 包装无处落库」记入台账遗留表（挂 P5 尾巴），
  与 §3.2 multi_variant 覆盖缺口同组，候选第 7 轮或验证轮后处置。

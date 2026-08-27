# Wave2-A 第 10 轮 #1：并发 / 锁序 / IMMEDIATE 交叉终审

- 席位：r10 #1（claude-fable-5-thinking-xhigh），独占可写本文件。
- 基线：tip `659b8c54`，base `origin/cursor/0824-cde6` @ `061b4815`。r6 之后唯一产品代码提交为
  `618634a6`（digest converge 二次补丁 + token hold），`c1cde7e3` 仅测试、`dd300cd3`/`659b8c54` 仅文档。
- 铁律遵守：未运行 cargo / npm / 任何编译测试；未改任何产品代码；未 commit（第 10 轮任务卡明示本席不 commit）。
- 对照物：`r2-review-concurrency.md`（五项裁定 + 三条低危备注）、`r6-gen.md`（digest 接线翻案 + 补丁）。
- **总结论：r2 五项裁定与 r6 补丁后语义全部「确认」；r2 §1.3 的一句事实陈述「遗留 DEFERRED 位点与本次变更无新增交叉」需「翻案」（R4-#6 已把 mark 原语接入 compaction 的 DEFERRED 落盘事务）；另记 3 组「残留风险」（嵌套池连接、DEFERRED 伪失败面扩大、digest 收敛的纯观测漂移），全部不构成必须立刻修的死锁 / 锁序倒置 / TOCTOU 双建 / 持久化 generation 回退，不出产品补丁。**

---

## 0. 终审快照：全 PR 同步原语与事务位点

### 0.1 内存锁（tip 现势）

| 原语 | 位置 | 本轮裁定 |
| --- | --- | --- |
| `frozen_tool_schema_orders`（`Arc<Mutex<HashMap<String, ToolFaceBaseline>>>`） | `pipeline.rs:212` | 单锁不变，触点仍仅 load/converge/store 三原语 + `pipeline.rs:1193/1205` 测试 clear；生产路径无 `.remove()`，条目永不淘汰（内存增长面，非并发面） |
| `microcompact_anchors` | `pipeline.rs:197` | 与上一把锁无嵌套持有，base 既有语义未变 |
| `compaction_locks`（session 级 compaction 互斥） | `pipeline.rs:188` | base 既有，本 PR 未触碰 |
| `wrap_token_filter` / `reasoning_wrap_token_filter`（本 PR R4 #1 新增后者） | `llm_adapter.rs:191-197`、`variant_adapter.rs:24-29` | 适配器实例内细粒度锁，全部语句级守卫（`.lock()...process(text)` 临时守卫语句末即释放），无嵌套、无持锁 emit（`llm_adapter.rs:407-423` 的 emit 在守卫释放后）。**确认无锁序面** |
| `cache_debug_fingerprint_store`（静态 `Mutex<HashMap<String,[String;4]>>`，本 PR 新增） | `model2_pipeline.rs:3333-3338` | debug 观测用；指纹计算在锁外（`:3357`），锁内纯内存查表 + 容量满清空（`:3359-3374`），不与任何其他锁/连接交叉。**确认无风险** |
| `StreamFilterCore`（`stream_filter_core.rs`） | 未接线（`#![allow(dead_code)]`，无生产调用方） | 无并发面 |

### 0.2 SQLite 事务位点

- 连接池：`database.rs:99-118`，WAL + `busy_timeout=10s`、max 10 连接、`connection_timeout=10s`（r2 快照未变）。
- IMMEDIATE：`repo.rs` 12 处（含 `advance_session_tool_face_prefix:3097`、`freeze_session_available_skills_snapshot:2857`、`merge_session_frozen_tool_schema_order:2765`）；本 PR 在 repo.rs 之外新增 1 处 —— `helpers.rs:1272-1279`（r5 #8 信号的 mark 独立事务）。
- 遗留 DEFERRED（`conn.transaction()`）：`block_actions.rs:359/:644`、`compaction.rs:1068`、`memory_flush.rs:946`（`:1178` 为测试）。r2 列出的 send_message.rs 位点在 tip 上已不存在。**其中 compaction.rs:1068 的定性见 §3.2（翻案）。**

---

## 1. r2 五项裁定逐条复核

### 1.1 检查项 1：mutex + SQLite IMMEDIATE 持锁交叉死锁 —— **确认（无）**

三原语锁序在 tip 上与 r2 裁定逐字一致：

- `load_session_tool_face_prefix`（helpers.rs:1078-1116）：加锁查命中（if-let 守卫体内仅 clone + return，无 DB 调用）→ 放锁读库（`:1087-1099`）→ 再加锁 `entry().or_default()` 回填（`:1100-1115`，锁内仅纯函数 merge + `max` + 填空位 + clone）。
- `converge_session_tool_face_prefix`（helpers.rs:1153-1225）：收敛计算、`true_fork` 判定、**r6 新增的 digest 共识判定（`:1180-1189`）全部在锁外**；锁内（`:1192-1212`）仅 merge + 条件 bump + digest 采纳 + clone；块作用域结束守卫释放后（`:1213`）才调 `advance` 写库。r6 补丁没有把任何 IO 或第二把锁引入临界区。
- `store_session_frozen_tool_schema_order`（helpers.rs:1318-1343）：同构，锁内合并克隆（`:1323-1331`）、放锁写库（`:1332`）。

`advance_session_tool_face_prefix_with_conn`（repo.rs:3104-3158）事务体只调 `get_session_with_conn` / `tool_face_prefix_from_metadata` / 纯函数 merge / `update_session_with_conn`，全程不触 `frozen_tool_schema_orders`、不取第二个池连接。**「持 SQLite 写锁 → 等内存锁」与「持内存锁 → 等 SQLite 写锁」的环形等待在 tip 上仍不可能成立。**

r2 §1.3「调用方在调用三原语时不持有任何其他池连接」在三原语的全部调用点（fan-out 三入口、join 三收敛点、tool_loop `:443` 入口与 `:1156` 环内 store、`pipeline.rs` 测试）上复核仍成立 —— 主 fan-out 骨架落库连接的 `if let Ok(conn)` 块在 `multi_variant.rs:482-496` 关闭，早于 `:509` 的入口快照。但该论断**不外推**到 r5 新增的信号函数（见 §4.1 残留风险，那不是三原语）。

### 1.2 检查项 2：load miss 窗口双建收敛 generation=0 —— **确认**

entry-API 单条目化 + `max(0,0)=0` + 幂等 merge 的三层构造未变（helpers.rs:1104-1114）。r6 之后新增第三键推演：双方并发回填 digest 时 `if entry.schema_digest.is_none()` 只填空位 —— 先到者填持久化值，后到者见 `Some` 跳过，**双建对三键全部收敛**。有持久化快照的重启并发首建（双方读到同一 `(g, B_g, digest)`）合并幂等、不 bump 不回退。确认。

### 1.3 检查项 3：converge 放锁后写库 —— **确认**

`helpers.rs:1192-1212` 的 `baseline` 块表达式结束即 drop 守卫，`:1213` 的 `advance`（IMMEDIATE，最坏阻塞 busy_timeout 10s）在锁外执行。r6 digest 补丁只在锁内加了一条 `entry.schema_digest = Some(digest)` 纯内存赋值（`:1208-1210`），临界区长度量级不变。写库失败仅 warn、内存权威（`:1218-1222`）。确认。

### 1.4 检查项 4：变体中途写共享态 —— **确认（已彻底消除，tip 现势复核）**

- 入口一次性快照三处：主 fan-out `multi_variant.rs:509`、重试批 `:2779`、单变体重试 `:2993`，均在 spawn / 执行前 Arc 分发；三处调用时均无池连接在手、无锁在手。
- 变体环内（`execute_single_variant_with_config`，`:1089-1932`）：`frozen_tool_schema_order` 与 `variant_schema_digest` 是入口快照本地克隆（`:1310`、`:1320`）；两处统一冻结原语（首轮 `:1364-1370`、环内 load_skills 刷新 `:1729-1737`）只推本地。全文 grep 确认 `multi_variant.rs` 内无任何 `store_session_frozen_tool_schema_order` 调用。
- 变体结束写回**私有** `VariantMeta.tool_face_prefix`（`:1920-1928`），generation 原样写入口代号。
- join 后收敛三处：`:602` / `:2868` / `:3017`，均在 `join_all` 返回（`:551` / `:2823`）或单变体 await 结束（`:3011`）之后；`hooks_guard.cleanup().await`（`:1930`）在 meta 写回后、任务返回前完成，收敛点读 `ctx.get_meta()` 时变体任务已整体结束，无并跑窗口。

确认。「唯一切代点」不变量在 tip 上成立：全仓 `generation += 1` 的工具面写点仅 `helpers.rs:1200` 一处。

### 1.5 检查项 5：store 与 converge 并发错误 bump —— **确认（无）**

- store 锁内只 merge order + clone，generation/digest 原样带出（helpers.rs:1328-1330）；
- `true_fork` 只比较变体集合内部（锁外，与共享条目解耦），并发 store 追加的名字不参与 `converged` 构造；
- 单变体重试 converge（`:3017` 传 `&[(0, prefix)]`）构造上 `converged == local_order`，恒不切代；
- DB 侧 `advance` IMMEDIATE 读-合并-写：order append-only 并集、generation `max`（repo.rs:3122）、digest `snapshot.or(persisted)`（`:3123`）、三者皆无变化跳过写库（`:3126-3131`）—— 并发 advance 在 RESERVED 锁上串行，无丢失更新。

同会话双 fan-out 并发各自检出真分叉导致 +2 的既有结论不变（代号单调、无正确性问题）。确认。

---

## 2. r6 裁定复核（digest 接线补丁的并发面）

### 2.1 r6 翻案（digest 死接线）与补丁 —— **确认修复有效且未引入新锁序**

补丁三要件复核：签名改收 `&[(usize, ToolFacePrefixSnapshot)]`（helpers.rs:1156）、三处调用点整快照传入（multi_variant.rs:591-599 / :2857-2865 / :3016-3017）、共识判定锁外（helpers.rs:1180-1189）+ 采纳锁内（`:1208-1210`）。digest 唯一推进点 = converge 采纳，与 `tool_loop.rs:1139-1155` 单变体路径「只打日志不持久化」的纪律、repo `advance` 的「快照无 digest 不抹掉持久化值」契约（repo.rs:3123/:3148-3153）三方自洽。**锁的数量、粒度、顺序与 r2 快照完全一致，无新锁序组合。**

### 2.2 r6 §1.4（r5 #8 信号函数）—— **确认其结论，补充其遗漏（见 §4.1）**

`record_skill_digest_prefix_generation_signal`（helpers.rs:1256-1296）本体复核：不触 `frozen_tool_schema_orders`、不持内存锁、独立 IMMEDIATE 事务（`:1272-1279`）、失败仅 warn。r6 的「不破坏唯一切代点」结论**确认**。但 r6 未核查其**调用方**是否持有池连接 —— 事实上持有（history.rs:27 的 conn 活到函数尾，`:573-578` 调信号），这是本轮新记的残留风险（§4.1），不推翻 r6 结论本身。

### 2.3 r6 §1.5 三条低危备注现势 —— **全部维持**

- 变体早退跳过 meta 写回：四处早退在 tip 上仍在 —— 流超时 `multi_variant.rs:1509/:1524`、LLM 错误 `:1556`、工具执行错误传播 `:1607-1630` 的 `.await?`；取消（`:1434-1436`/`:1543-1550`）与 task_completed / doom-loop / max-rounds（`:1877-1908`）仍走 `break` 到达 `:1920` 写回点。后果不变：失败变体已发出的尾部不进收敛（漏检真分叉 + 弃缓存条目），order 从未进基线故**无错误字节**。维持低危。
- 跨路径并发分叉不检测：代码未变，窗口仍依赖 UI 串行化假设。维持低危（digest 侧的同窗口推论见 §4.3）。
- async 内同步 DB IO：未变，既有风格面。维持备注。

---

## 3. 翻案项（本轮唯一）

### 3.1 结论

**翻案对象：r2 §1.3 末句「遗留 DEFERRED 位点……本次变更没有与其新增交叉」。** 该陈述在 r2 撰写时点即已不完全成立、在 tip 上明确过时：R4-#6 把 `mark_session_available_skills_snapshot_stale_with_conn`（读-判-写 session.metadata）**新增接入**了 `persist_prepared_compaction` 的 DEFERRED 落盘事务（compaction.rs:1066-1139，`:1068` `conn.transaction()`、`:1114` mark 调用）。

### 3.2 影响评估（为何翻案后仍不出补丁）

- **锁形态未变**：该事务在 mark 加入前就是「先读（`:1069` query_row、`:1081` fingerprint）后写（`:1098+`）」的 DEFERRED 升级模式，mark 只是扩大了读写集，不引入新的升级点。
- **原子性不变量成立**：「压缩已落盘但目录未声明换代」的半提交状态确实被同事务排除 —— 这正是 mark 必须进这个事务的理由，接线本身是对的。
- **无丢失更新**：WAL 下 DEFERRED 事务读后写，若期间有其他写者提交，升级写会得到 `SQLITE_BUSY_SNAPSHOT` 而整体失败 —— SQLite 的快照隔离**排除**了「compaction 事务用旧读快照覆盖 advance 刚写入的 `frozenToolSchemaOrder`/`toolFacePrefixGeneration`」的丢失更新。metadata 整对象重写（`update_session_with_conn`，repo.rs:475-510）因此是安全的。
- **代价是伪失败面扩大**（转列 §4.2 残留风险）：`SQLITE_BUSY_SNAPSHOT` 不吃 busy_timeout 重试；本 PR 在发送热路径上新增了高频 IMMEDIATE 写者（advance 每个稳定窗口、signal 按 mismatch 触发），同库任意写者提交都可能击中 compaction 落盘事务的读→写窗口，使整次 compaction 变成 `CompactionOutcome::Failed` 降级（下轮重试）。降级不腐化数据。
- 修复方向（后续轮次，非本席权限）：`compaction.rs:1068` 改 `transaction_with_behavior(Immediate)` 即可关闭伪失败窗口，与 repo.rs 写路径统一；`block_actions.rs`/`memory_flush.rs` 两处同理属既有面。

---

## 4. 残留风险清单（本轮新记 3 组，均低危、不出补丁）

### 4.1 嵌套池连接获取：history pass 持连调用 r5 #8 信号 —— **残留风险（低，新记）**

- 证据链：`load_chat_history_pass` 在 `history.rs:27` 取池连接，绑定活到函数尾；`:573-578`（本 PR 新增）在持连状态下调 `record_skill_digest_prefix_generation_signal`，后者在 `helpers.rs:1273` 取**第二个**池连接并起 IMMEDIATE 事务。base 上 `:585` 的 `resolve_microcompact_eligible_turns`（内部 `get/set_session_microcompact_anchor` 各自取连）已是同构的「持 1 取 1」模式，本 PR 使该模式多了一个写事务位点。
- 定性：**不是死锁**。最坏情形（≥10 个并发 history pass 全部持连且全部命中 mismatch）下第二次取连在 `connection_timeout=10s` 后返回 Err，信号函数闭包捕获后降级 warn（`helpers.rs:1290-1294`），发送不阻断；但热路径可能多挂 10s（async 上下文内同步等待，叠加 r2 备注 3）。触发条件苛刻：mismatch 信号本身是「技能正文漂移」的罕见路径。
- 后续收口方向：信号调用挪到 `conn` 显式 drop 之后，或 pass 顶部读完消息即 drop conn。行为增强，非缺陷修复。

### 4.2 compaction DEFERRED 伪失败面扩大 —— **残留风险（低，§3 翻案的伴生项）**

见 §3.2。要点：正确性无损（快照隔离防丢失更新、同事务原子性成立），代价是本 PR 新增写流量提高了 compaction 落盘被 `SQLITE_BUSY_SNAPSHOT` 打断的概率，降级路径（Failed → 下轮重试）已存在。

### 4.3 digest 收敛的纯观测漂移（r6 补丁引入的新并发面）—— **残留风险（极低，纯观测、零字节影响）**

三个交错，全部不影响发往 provider 的字节、不影响 order/generation：

1. **双 converge 并发的 last-writer 不一致**：内存侧 digest 由锁序决定最终值，DB 侧由两个 IMMEDIATE `advance` 的提交序决定（`snapshot.digest.or(persisted)`，快照带 Some 必覆盖）——两个序可以不同，内存与 DB 的 digest 在下一次写前可能短暂互异。digest 仅作跨窗口对账观测。
2. **并发 store 扩展后采纳的 digest 描述较短 face**：converge 锁内 merge 后 `entry.order` 可能已长于锁外算出的 `converged`（单变体路径同会话并发追加），采纳的 digest 对应 `converged` 面而非 `entry.order` 面。与 r2 备注 2 同一 UI 串行化窗口，下一稳定窗口自愈。
3. **非对称真分叉时仍会采纳 digest**：`A=B̂+[X,Y]`、`B=B̂+[Y]` 时 `converged == A.order`，A 是候选、其 digest 被采纳 —— 与 helpers.rs:1140 文档「真分叉……保持既有值」的措辞不完全一致（r6 §3.2 表格只列了对称分叉 X vs Y 的无候选情形）。采纳本身是诚实的（A 确实发出过收敛后的完整 face），**不构成缺陷**，仅文档措辞轻微失真，建议后续轮次把注释改为「真分叉且无变体本地 order 恰等于收敛结果时不采纳」。

### 4.4 generation 回退终审 —— **确认（持久化代号单调不回退）**

全部写点推演：load 回填 `max`（helpers.rs:1111）、converge 条件 `+1`（`:1200`）、store 原样带出（`:1330`）、advance `max(persisted, snapshot)`（repo.rs:3122）、`tool_face_prefix_from_metadata` 缺键降 0 仅在三键全缺时才返回 None（repo.rs:138-155）。持久化代号在单进程生命周期内严格单调。两个「视回退」窗口均为既有裁定、非本轮新增：

- advance 写库失败仅 warn → 内存代号领先 DB，进程重启后回退到持久化基线（r2/r6 已裁定接受，字节侧由 order append-only 兜底不出错序）；
- load 时 DB 读失败降级 `ToolFaceBaseline::default()` 并把 g=0 空 order 建成内存条目（helpers.rs:1091-1098）——内存代号/序双回退，后续该会话请求按字母序重建（缓存损失，无错误字节）；写侧 advance 的 `max` 保证 DB 代号不被拉低。此为设计明示的降级路径（「只打日志、不阻断发送」）。注意 §4.1 的池收缩会提高这条降级路径的触发概率 —— 两条残留风险有叠加关系，记录在案。

### 4.5 TOCTOU 双建终审 —— **确认（无双建）**

- 工具面：miss 窗口双建收敛见 §1.2；
- catalog 双键（`availableSkillsSnapshotGeneration` + `availableSkillsSnapshotPendingGeneration`）：
  - freeze 并发双写：IMMEDIATE 串行 + 代内 first-write-wins（repo.rs:2879-2883，后到者返回持久化权威值回灌内存），无双建；
  - mark 并发双标：`pending > generation` 有效性过滤（`:2948-2951`）幂等折叠；即使两个 mark 都通过检查（一个在 compaction DEFERRED、一个在 signal IMMEDIATE），写入的 target 同为 `generation + 1`，同值幂等 —— 且 DEFERRED 侧若真与 IMMEDIATE 提交交错会被 BUSY_SNAPSHOT 整体回滚，不存在「pending 被 +2」路径；
  - mark/freeze 交错：IMMEDIATE 串行化后两种序都收敛（先 mark 后 freeze = 新代 first write 兑现换代并清标记 `:2899-2905`；先 freeze 后 mark = 正常声明下一代）；脏数据 `pending <= generation` 按无标记处理（`:2874-2878`），换代不回退。

---

## 5. 结论汇总

| # | 检查项 | 三选一 | 摘要 |
| --- | --- | --- | --- |
| 1 | r2-1 跨锁交叉死锁 | **确认** | 三原语零跨锁持有；r6 digest 补丁未加长临界区、未引入 IO |
| 2 | r2-2 load miss 双建收敛 g=0 | **确认** | 三键（order/generation/digest）全部收敛 |
| 3 | r2-3 converge 放锁后写库 | **确认** | `helpers.rs:1192-1212` 块作用域 → `:1213` advance |
| 4 | r2-4 变体中途写共享态 | **确认** | 入口 Arc 快照 + 本地副本 + 私有 meta + join 后唯一收敛点 |
| 5 | r2-5 store/converge 并发错误 bump | **确认** | store 不碰 generation；true_fork 与共享条目解耦；advance max 单调 |
| 6 | r6 digest 接线补丁并发面 | **确认** | 共识判定锁外、采纳锁内，锁序/事务边界零变化 |
| 7 | r2 §1.3「DEFERRED 位点无新增交叉」 | **翻案** | R4-#6 mark 已进 compaction DEFERRED 事务；原子性对、无丢失更新，伪失败面扩大转 §4.2 |
| 8 | history pass 持连嵌套取连（r5 #8 信号） | **残留风险（低）** | 「持 1 取 1」池收缩，10s 超时 + 降级 warn 兜底，非死锁 |
| 9 | compaction 落盘 BUSY_SNAPSHOT 伪失败 | **残留风险（低）** | 建议后续统一 IMMEDIATE；降级不腐化数据 |
| 10 | digest 观测漂移三交错（§4.3） | **残留风险（极低）** | 纯观测、零请求字节影响；附一处文档措辞失真建议 |
| 11 | generation 回退 | **确认（无持久化回退）** | 降级路径为设计明示；§4.1 与 load 降级有叠加关系已记录 |
| 12 | TOCTOU 双建（工具面 + catalog 双键） | **确认（无）** | first-write-wins / 幂等折叠 / 同值幂等 / 快照隔离四重兜底 |
| 13 | 本 PR 其他新增锁（适配器 reasoning 过滤器、cache debug store） | **确认（无风险）** | 语句级守卫、无嵌套、锁内纯内存 |

**最终裁定：全 PR 并发面可交付。1 项轻量翻案（事实陈述过时，非缺陷）与 3 组低危残留风险已记录，均有明确的后续收口方向，不阻塞转正。**

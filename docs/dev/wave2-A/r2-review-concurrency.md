# Wave2-A 第 2 轮审阅 #7：并发与锁序（tools 前缀代际）

- **席位**：r2 #7 审阅员-并发
- **审阅对象**：`helpers.rs`（load / converge / store 三原语）、`repo.rs`（`advance_session_tool_face_prefix(_with_conn)` IMMEDIATE 事务）、`multi_variant.rs`（fan-out 入口快照、join 收敛、两处 retry）、`pipeline.rs`（`frozen_tool_schema_orders` 值型）
- **总结论**：**确认**（三选一里的「确认」）。锁序不倒置、IMMEDIATE 事务边界干净、五项检查全部通过；未发现必须立刻修的死锁或代际错 bump。文末附 3 条低危备注（均为缓存效率层面的取舍，不构成正确性缺陷，不需要补丁）。

---

## 0. 审阅基座：涉及的同步原语清单

| 原语 | 位置 | 说明 |
| --- | --- | --- |
| `frozen_tool_schema_orders` | `pipeline.rs:201` | `Arc<Mutex<HashMap<String, ToolFaceBaseline>>>`，全部 Pipeline clone 共享的单锁；值型已从裸 `Vec<String>` 升级为 `ToolFaceBaseline { generation, order, schema_digest }` |
| SQLite 连接池 | `chat_v2/database.rs:99-120` | r2d2 池，max 10 连接，WAL + `busy_timeout=10s`，`connection_timeout=10s` |
| SQLite 写锁 | `repo.rs:2970` | `advance_session_tool_face_prefix` 用 `TransactionBehavior::Immediate` 起事务，begin 即抢 RESERVED 锁 |
| `microcompact_anchors` | `pipeline.rs:186` | 相邻的另一把 Mutex，本次审阅确认与 `frozen_tool_schema_orders` **无嵌套持有**（两把锁分属不同函数，互不交叉） |

值型声明（验收要求核对项）：

```187:201:src-tauri/src/chat_v2/pipeline.rs
    /// 🆕 P0 tools 会话冻结（会话级状态）：session_id → 权威工具面基线
    /// `ToolFaceBaseline { generation, order, schema_digest }`（P1 代际
    /// 升级：值型从裸 `Vec<String>` 扩为带代号的快照，单锁不变）。
    // ... 注释省略 ...
    frozen_tool_schema_orders: Arc<Mutex<HashMap<String, helpers::ToolFaceBaseline>>>,
```

值型升级只换 HashMap 的 V，锁的数量与粒度不变 —— 不引入新的锁序组合。**确认**。

---

## 1. 检查项 1：会不会新死锁（mutex + SQLite IMMEDIATE 持锁交叉）

**结论：不会。三条路径全部满足「绝不跨锁持有」，且 IMMEDIATE 事务内部不回调内存锁。**

### 1.1 三原语的锁序逐一核对

**`load_session_tool_face_prefix`（helpers.rs:1067-1105）**：三段式 ——

1. 加锁查内存命中（`helpers.rs:1068-1075`）。注意 Rust 的 if-let 临时守卫会活到 if-let 体结束，但体内只有 `existing.clone()` 与 return，**没有任何 DB 调用**；
2. 放锁后读库（`helpers.rs:1076-1088`，`get_session_tool_face_prefix` 内部 `get_conn_safe` 取池连接、无事务纯读）；
3. 再加锁 `entry().or_default()` 回填合并（`helpers.rs:1089-1104`），锁内只有纯内存的 `merge_frozen_tool_schema_order_baseline`（tool_loop.rs:78-87 的纯函数，无 IO）+ `max` + clone。

**`converge_session_tool_face_prefix`（helpers.rs:1127-1178）**：

- 收敛计算（排序 + 合并 + `true_fork` 判定，`helpers.rs:1134-1145`）全部在**锁外**完成；
- 锁内只做 append-only 合并 + 条件 bump + `entry.clone()`（`helpers.rs:1148-1165`），块作用域结束守卫即释放；
- **守卫释放之后**才调 `advance_session_tool_face_prefix` 写库（`helpers.rs:1166-1176`）。

**`store_session_frozen_tool_schema_order`（helpers.rs:1200-1225)**：同构 —— `merged` 块作用域内加锁合并克隆（`helpers.rs:1205-1213`），放锁后 `advance` 写库（`helpers.rs:1214-1224`）。

### 1.2 IMMEDIATE 事务内部不回调内存锁

```2964:2974:src-tauri/src/chat_v2/repo.rs
    pub fn advance_session_tool_face_prefix(
        db: &ChatV2Database,
        session_id: &str,
        snapshot: &ToolFacePrefixSnapshot,
    ) -> ChatV2Result<()> {
        let mut conn = db.get_conn_safe()?;
        let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
        Self::advance_session_tool_face_prefix_with_conn(&tx, session_id, snapshot)?;
        tx.commit()?;
        Ok(())
    }
```

`_with_conn` 体（repo.rs:2977-3031）只调用 `get_session_with_conn`、`tool_face_prefix_from_metadata`、纯函数 `merge_frozen_tool_schema_order_baseline`、`update_session_with_conn` —— 全程不接触 `frozen_tool_schema_orders`，也不再取第二个池连接（事务复用同一 conn）。因此不存在「持 SQLite 写锁 → 等内存 mutex」与「持内存 mutex → 等 SQLite 写锁」的环形等待，**经典交叉死锁不可能成立**。

### 1.3 SQLite 侧自身的死锁面

- 本特性所有写路径统一 IMMEDIATE（repo.rs 全文 12 处 `transaction_with_behavior(Immediate)`），begin 即抢锁，**不存在 DEFERRED 读→写升级死锁**；并发 IMMEDIATE 之间靠 `busy_timeout=10s` 排队（database.rs:106 的注释明确了这就是 3s→10s 调大的动机）。
- 池耗尽型互等：`load` / `converge` / `store` 都是「取一个连接 → 用完即还」，调用方（fan-out 入口、join 之后、tool_loop 环内）在调用时**不持有任何其他池连接**（multi_variant.rs:482-495 的骨架落库连接在 `if let` 作用域结束、即 :509 取快照之前已归还）。无「持 A 连接等 B 连接」链。
- 遗留背景：`block_actions.rs` / `compaction.rs` / `memory_flush.rs` / `send_message.rs` 仍有 `conn.transaction()`（DEFERRED）位点，与 IMMEDIATE 写者竞争时可能吃 `SQLITE_BUSY`（WAL 下由 busy_timeout 兜底）。这是**既有代码面**，本次变更没有与其新增交叉，不在本席位翻案范围。

---

## 2. 检查项 2：load miss 窗口双建是否仍收敛 generation=0

**结论：是，收敛正确。**

竞态窗口：两个调用同时 miss（`helpers.rs:1068-1075` 都没命中）→ 都放锁读库 → 先后拿锁回填。推演两种情形：

- **全新会话（DB 无快照）**：双方读到 `None` → `ToolFaceBaseline::default()`（generation=0、空 order、digest None）。先到者 `entry().or_default()` 建条目（default 即 generation=0），合并空 persisted 无副作用；后到者 `entry()` 命中同一条目，`entry.generation = entry.generation.max(0)` 仍为 0，空 order 合并幂等。**双建收敛为单条目、generation=0**，与函数文档「并发首建双方都带 0，合并后仍是 0」一致。
- **有持久化快照（重启后并发首轮）**：双方读到同一 `(g, B_g)`，先后 `max(0, g)=g` + append-only 合并同一 order（第二次幂等）。generation 恢复为 g、**不 bump**。

另一个交错：线程 A miss 放锁读库期间，线程 B 已通过 `store` 或 `converge` 建了内存条目并推进了 order/generation —— A 回填时 `entry()` 命中 B 的条目，merge 只补缺失名（不覆盖不重排 B 已建的前缀序），`generation.max(persisted)` 不会把 B 可能已 bump 的代号拉低。回填**永不 bump 也永不回退**。确认。

（`pipeline.rs:1160-1186` 的重启恢复测试覆盖了单线程版语义；并发双建路径靠上述 entry-API + max + 幂等 merge 构造保证。）

---

## 3. 检查项 3：converge 是否在放锁后写库

**结论：是。**

```1147:1166:src-tauri/src/chat_v2/pipeline/helpers.rs
        // 锁内合并 + 条件切代 + 克隆；放锁后再写库。
        let baseline = {
            let mut orders = self
                .frozen_tool_schema_orders
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let entry = orders.entry(session_id.to_string()).or_default();
            super::tool_loop::merge_frozen_tool_schema_order_baseline(&mut entry.order, &converged);
            if true_fork {
                entry.generation += 1;
                // ... 日志省略 ...
            }
            entry.clone()
        };
        if let Err(err) = ChatV2Repo::advance_session_tool_face_prefix(
```

`baseline` 的块表达式结束时 `MutexGuard` 被 drop，`advance`（IMMEDIATE 事务，最坏可阻塞 busy_timeout 10s）在锁外执行。写库失败仅降级 warn，内存基线仍权威 —— 不会出现「持内存锁等 SQLite 写锁 10s」的长临界区。`store` 同构（helpers.rs:1205-1213 克隆块 → :1214 写库）。确认。

---

## 4. 检查项 4：变体中途是否还写共享态

**结论：已彻底消除，变体环内零共享态写入。**

- fan-out 入口一次性快照：主 fan-out `multi_variant.rs:509`、重试批 `:2756`、单变体重试 `:2969`，三处都在 spawn 之前 `load_session_tool_face_prefix` 一次并 Arc 分发 —— 同一扇出内所有变体从同一 `(g, B_g)` 字节基线出发，旧「变体内独立 load」的轮内竞态已消除。
- 变体环内（`execute_single_variant_with_config`，multi_variant.rs:1087-1909）：`frozen_tool_schema_order` 是入口快照的**本地克隆**（:1308），两处 `freeze_tool_schema_order_for_prompt_cache`（首轮 :1351、环内 load_skills 刷新 :1712）都只推进这个本地副本。全文 grep 确认 `multi_variant.rs` 内**没有任何** `store_session_frozen_tool_schema_order` 调用；变体环也不走 `tool_loop::execute_with_tools`（后者仅在注释中被提及），因此 tool_loop.rs:1067 的环内 store 不会被变体路径间接触发。
- 变体结束写回目标是**变体私有**的 `VariantMeta.tool_face_prefix`（:1897-1905），generation 原样写入口代际、不自增 —— 切代判定完全收归 join 收敛点。
- 会话级共享态的唯一写点：join 之后的 `converge`（主 fan-out :599-601、重试批 :2843-2845、单变体重试 :2990-2992），此时 `join_all` 已返回、所有变体任务与其 hook 生命周期已结束，不存在「收敛与变体环并跑」的窗口。

确认。

---

## 5. 检查项 5：单变体 store 与多变体 converge 并发时 generation 会不会被错误 bump

**结论：不会。三层构造各自独立保证。**

1. **`store` 从不 bump**：`helpers.rs:1210-1212` 锁内只 merge order + clone，generation 字段原样带出（entry 当前值）；持久化侧 `advance` 对 generation 取 `max(persisted, snapshot)`（repo.rs:2995），单调不回退也不自增。即便交错发生在 converge 的 bump 与其写库之间（store 克隆到的 entry 已带新代号 g+1，先一步落库），也只是把 converge 即将写的同一个代号提前持久化 —— 语义等价。
2. **`converge` 的 bump 判定与共享条目解耦**：`true_fork`（helpers.rs:1143-1145）只比较「变体集合内部」—— 各变体本地 order 是否都是收敛结果的前缀。并发 store 追加到共享 entry 的名字**不参与** `converged` 的构造，因此不可能把「单变体纯扩展」误判成真分叉。锁内的 `entry` merge 只影响 order 拼接，不影响已在锁外算好的 `true_fork` 布尔值。
3. **单变体重试的 converge（:2991）构造上永不切代**：单输入时 `converged == local_order`，`starts_with` 恒真 → `true_fork == false`。与 `prefix_generation_fork_tests.rs` 的「单变体 = 纯扩展 no-bump」契约一致。

DB 侧丢失更新也不成立：`advance` 是 IMMEDIATE 事务内「读-合并-写」（repo.rs:2982-3030），并发 advance 在 RESERVED 锁上串行，后者读到前者已提交的行再 merge —— order append-only 并集、generation 取 max，两个方向的写回都不会互相覆盖。

极端情形「同会话两个 fan-out 并发、各自检出真分叉」会导致 generation +2 —— 代号单调递增、无正确性问题（代号语义只要求区分不同前缀代，不要求连续）。确认。

---

## 6. 低危备注（不构成翻案，不需要补丁）

以下三条均为缓存命中率层面的取舍或既有代码风格，**没有一条达到「必须立刻修的死锁 / 错误 bump」门槛**，故本席位不出补丁建议，仅记录供后续轮次评估：

1. **变体早退跳过 meta 写回**：变体环内 :1494 / :1509（超时）、:1540（LLM 错误）三处 `return Err` 发生在 :1897 的 `meta.tool_face_prefix` 写回之前，该变体在失败前若已实际向 provider 发出过含新工具的请求，其尾部不会进入收敛（`filter_map` 在 :593-597 / :2837-2841 直接跳过 None）。后果仅是该变体 provider 侧的 prompt cache 条目被遗弃 + 潜在真分叉漏检；由于其 order 从未进入会话基线，后续请求不会与之混用前缀，**无错误字节**。取消/doom-loop/轮次上限走 `break`（:1420/:1861/:1873/:1886），正常到达写回点，不受影响。
2. **跨路径分叉不检测的理论窗口**：若同会话的单变体轮与多变体 fan-out 真并发（产品上同会话发送通常被 UI 串行化，仅 retry 与 send 竞态才可能触碰），单变体 store 在 fan-out 期间向共享 entry 追加的名字 X 会使最终基线为 `[base, X, Y…]`，而变体实际发出的是 `[base, Y…]` —— converge 只查变体集合内部，不 bump。后果是变体侧 provider 缓存前缀命中在 X 位置截断，退化为部分命中；下一轮发出的字节仍严格按基线序，**无正确性问题**。
3. **async 上下文内的同步阻塞 DB IO**：`load`/`converge`/`store` 在 tokio 任务里直接做同步 SQLite 调用（IMMEDIATE 抢锁最坏阻塞 busy_timeout 10s），与本文件既有风格（如 :482 骨架落库）一致，属延迟/工作线程占用风险而非死锁；如未来做 `spawn_blocking` 化改造应整链统一，不宜单点改。

---

## 7. 验收结论汇总

| # | 检查项 | 结论 |
| --- | --- | --- |
| 1 | mutex + SQLite IMMEDIATE 持锁交叉死锁 | **确认无**：三原语零跨锁持有；IMMEDIATE 事务体不回调内存锁；写路径统一 IMMEDIATE 无升级死锁 |
| 2 | load miss 窗口双建收敛 generation=0 | **确认**：entry-API 单条目化 + `max(0,0)=0` + 幂等 merge |
| 3 | converge 放锁后写库 | **确认**：`helpers.rs:1148-1165` 块作用域释放守卫后才调 `advance` |
| 4 | 变体中途写共享态 | **确认已消除**：入口 Arc 快照 + 本地副本 + 变体私有 meta，共享写点唯一收归 join 后 converge |
| 5 | store 与 converge 并发错误 bump | **确认无**：store 不碰 generation、true_fork 与共享条目解耦、DB 侧 IMMEDIATE 读-合并-写 + max 单调 |

**最终裁定：确认。锁序与 IMMEDIATE 事务边界实现与设计稿（方案 A）及 `prefix_generation_fork_tests.rs` / `prefix_generation_restore_tests.rs` 契约一致，无需补丁。**

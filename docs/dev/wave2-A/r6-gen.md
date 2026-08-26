# Wave2-A 第 6 轮 #1：代际二检（helpers converge/load + multi_variant fan-out）

- 席位：r6 #1「代际二检」（claude-fable-5-thinking-high）
- 基线：tip `4b784bb4`。铁律遵守：未运行 cargo / npm / 任何编译与测试；未 git commit。
- 审阅对象：`helpers.rs`（`load_session_tool_face_prefix` / `converge_session_tool_face_prefix` /
  `store_session_frozen_tool_schema_order` / `record_skill_digest_prefix_generation_signal`）、
  `multi_variant.rs` fan-out 三路径（主扇出 / 重试批 / 单变体重试）。
  对照物：`r2-impl-generation.md`、`r2-freeze-matrix.md`、`r2-review-concurrency.md`、
  `r5-digest-generation-signal.md`、`prefix_generation_fork_tests.rs`、
  `prefix_generation_restore_tests.rs`、`ROUND-02-TASKS.md` API 合同、
  `repo.rs::advance_session_tool_face_prefix(_with_conn)`。
- **总结论：order / generation 两键全部确认；`schema_digest` 键一项翻案
  （会话级 digest 死接线，converge 从未收到变体 digest，`toolSchemaDigest`
  持久化键在生产路径上永远写不进去）——已按本席独占文件权限落地最小补丁
  （helpers.rs + multi_variant.rs，仅补 digest 收敛，order/generation 语义
  与请求字节零变化）。**

---

## 1. 确认项（逐条复核通过）

### 1.1 `load_session_tool_face_prefix`（helpers.rs:1076-1114，行号 4b784bb4 快照）

三段锁序与 r2 裁定逐字一致：加锁查命中（if-let 守卫体内无 DB 调用）→
放锁读库 → 再加锁 `entry().or_default()` 回填。回填段三条不变量在位：

- order：`merge_frozen_tool_schema_order_baseline` append-only（只补缺失名，
  绝不覆盖/重排并行调用已建前缀）；
- generation：`entry.generation.max(persisted.generation)`——**永不 bump、
  永不回退**；并发首建双方带 0，合并仍 0；
- digest：`if entry.schema_digest.is_none()` 只填空位。

`Ok(None)` / `Err` 均降级 `ToolFaceBaseline::default()`（generation=0 +
空 order），仅 warn 不阻断发送。与 `prefix_generation_restore_tests.rs`
的契约副本 `locked_refill_baseline`（:153-165）**逐语句同构**——测试与
生产未漂移。**确认。**

### 1.2 converge 的 order 合并与真分叉判定（helpers.rs）

对 `true_fork = ∃ 变体本地 order 不是收敛结果前缀` 做了边界推演，全部
与冻结矩阵第 3 节及 fork 测试契约一致：

| 输入（B̂ = 入口基线） | converged | true_fork | 判定 |
|---|---|---|---|
| 单变体任意 order | = 该 order | 恒 false | 构造上永不切代（单变体重试路径 :3017 传 `&[(0, …)]`）✅ |
| A=B̂，B=B̂+[X]（纯扩展） | B̂+[X] | false | 不切代 ✅ |
| A=B̂+[X]，B=B̂+[X,Y]（前缀链） | B̂+[X,Y] | false | 不切代 ✅ |
| A=B̂+[X]，B=B̂+[Y]（互异尾部） | B̂+[X,Y] | true（B 非前缀） | +1 ✅ |
| A=B̂+[X,Y]，B=B̂+[Y]（非对称） | B̂+[X,Y] | true（B 非前缀） | +1 ✅（B 在位置 \|B̂\| 发出的是 Y，确属分叉） |
| 全体相等（含收敛后重收敛） | = 输入 | false | 幂等不再 bump ✅ |
| 混入无工具变体（order = B̂） | 不受影响 | 由其余变体决定 | B̂ 恒为前缀，不稀释判定 ✅ |

按 `variant_index` 升序排序后从空表合并——收敛序由索引序唯一确定，与
完成竞态解耦。锁外算收敛与 fork、锁内 merge + 条件 bump + clone、放锁后
`advance` 写库（IMMEDIATE 事务内不回调内存锁）。**确认，与
`prefix_generation_fork_tests.rs::converge_orders_by_variant_index`
契约副本语义逐条一致。**

### 1.3 multi_variant fan-out 接线（行号 = 本席补丁后现势）

- 入口统一快照三处：主扇出 `:509`、重试批 `:2779`、单变体重试 `:2993`，
  均在 spawn/执行前一次 `load_session_tool_face_prefix` + Arc 分发；
- 变体环内**零共享态写入**：`frozen_tool_schema_order` 是入口快照本地
  克隆（:1310），两处统一冻结原语（首轮 :1364、环内 load_skills 刷新
  :1729）只推本地；全文无 `store_session_frozen_tool_schema_order` 调用；
- 变体私有写回 `:1920-1928`：generation 原样写入口代号（变体内不自增）；
  取消（:1436/:1545/:1550）、doom-loop 终止（:1888-1896）、max rounds
  （:1901-1909）全部走 `break` **到达写回点**——已向 provider 发出过
  字节的变体（含取消者）其 order 均进入收敛；
- join 收敛三处：`:602` / `:2868` / `:3017`，均在 `join_all` 返回、变体
  hook 生命周期结束之后；空集合跳过。

**确认。** 另 grep 全仓：`generation += 1` 的工具面写点仅 helpers converge
一处（:1200），`frozen_tool_schema_orders` 触点仅 load/converge/store 三
原语 + pipeline.rs 测试 clear——「唯一切代点」不变量在 tip 上成立。

### 1.4 r5 #8 信号函数不越界（helpers.rs `record_skill_digest_prefix_generation_signal`）

第 5 轮新增的唯一 helpers 改动。复核：只写
`availableSkillsSnapshotPendingGeneration`（available_skills 目录代），
不触碰 `frozen_tool_schema_orders`、不持内存锁、独立 IMMEDIATE 事务、
写库失败仅 warn。与其文档声明的「不是 converge 接线点」的裁定一致，
不构成对工具面代际唯一切代点的破坏。**确认。**

### 1.5 r2 并发审阅三条低危备注的现势复核

| r2 备注 | 现势 | 裁定 |
|---|---|---|
| 1. 变体早退跳过 meta 写回 | 仍在：`:1510`/`:1525`（超时）、`:1556`（LLM 错误）三处 return，**另有 r2 未列的第四处** `:1630` `execute_tool_calls(...).await?`（工具执行错误传播）。后果不变：失败变体已发出的尾部不进收敛（漏检真分叉 + 弃缓存条目），但其 order 从未进会话基线，**无错误字节** | 维持低危，不补丁 |
| 2. 跨路径并发分叉不检测 | 代码未变，窗口仍限于「同会话 send 与 retry 真并发」；后果为部分缓存命中截断，无正确性问题 | 维持低危 |
| 3. async 内同步 DB IO | 未变，既有代码风格面 | 维持备注 |

---

## 2. 翻案项：会话级 `schema_digest` 死接线（本轮唯一明确 bug）

### 2.1 证据链

1. `converge_session_tool_face_prefix` 原签名只收 `&[(usize, Vec<String>)]`
   ——三处调用点 `.map(|prefix| (variant_index, prefix.order))` **把变体
   窗口 digest（`VariantMeta.tool_face_prefix.schema_digest`）原地丢弃**；
2. converge 锁内只 merge order + 条件 bump，`entry.schema_digest` 不写；
   `store_session_frozen_tool_schema_order` 同样只 merge order；
3. 内存 entry 的 digest 唯一写点 = load 回填「只填空位」（来源是持久化
   键）；持久化键 `toolSchemaDigest` 的唯一写点 = repo `advance`，且仅当
   快照带 `Some(digest)` 时才写（repo.rs:3123/3148）；而 advance 收到的
   快照全部来自 entry clone——**闭环无引导点（bootstrap），生产路径上
   该键永远是缺省**。

### 2.2 与既有契约的冲突（翻案的对象）

- `tool_loop.rs:1137-1138`：「窗口 digest 变化只打日志、不随 store 持久化
  —— **digest 推进只发生在多变体 converge 收敛点**」——converge 根本收
  不到 digest，该声明在 4b784bb4 上为假；
- `r2-freeze-matrix.md` F2：「仅摘要落库：`toolSchemaDigest`……digest
  落库仅作跨窗口对账观测」——从未落库，跨窗口对账无从谈起；
- `ROUND-02-TASKS.md` #2/#3 合同：「digest 变化时……写入
  snapshot.schema_digest」「至少把 digest 纳入 snapshot，**供收敛统一
  原语**」——纳入了 VariantMeta，收敛原语未消费；
- r2 三键同事务的说法（「toolFacePrefixGeneration + frozenToolSchemaOrder
  + 可选 toolSchemaDigest」）事实上退化为两键；
- 派生症状：tool_loop 单变体路径 `:1122-1133` 的「digest changed」info
  日志每个窗口首次 freeze 必比对 `None -> Some(...)` 恒报「变化」，
  对账观测值永久失真。

### 2.3 影响评估（为何是明确 bug 而非仅文档瑕疵）

- 无请求字节错误：digest 纯观测，order/generation 均不受影响；变体重放
  消费的是 VariantMeta 内自带 digest（窗口内新算），重放不受影响；
- 但三份契约文档 + 任务卡 + 恢复测试（`advance_skips_write_...` 对照组 2
  明确演练「digest 变化 → 写库」）一致描述的持久化/对账行为在生产不可达
  ——属于「半接线」缺陷，且修复面完全落在本席独占文件内。

---

## 3. 补丁（已落地，未 commit）

### 3.1 变更点

**`helpers.rs`**：

- `converge_session_tool_face_prefix` 入参
  `&[(usize, Vec<String>)]` → `&[(usize, ToolFacePrefixSnapshot)]`
  （快照整体传入；入参 `generation` 字段显式忽略，权威代号仍在会话 entry）；
- 锁外新增 digest 共识判定，锁内条件采纳（见 3.2）；
- `ToolFaceBaseline.schema_digest` 字段文档同步改为「唯一推进点 =
  converge 共识采纳」。

**`multi_variant.rs`**（三处调用点，`:590-604` / `:2854-2870` / `:3013-3018`）：
`.map(|prefix| (variant_index, prefix.order))` → `(variant_index, prefix)`，
不再丢弃 digest；单变体重试传 `&[(0, prefix)]`。

### 3.2 digest 采纳规则（保守、确定性、绝不造假）

候选 = 「本地 order **恰等于**收敛结果」且带 `Some(digest)` 的变体；
全体候选 digest 一致 → 采纳写入 `entry.schema_digest`；否则保持既有值。

| 场景 | 行为 | 理由 |
|---|---|---|
| 单变体（重试 / 单输入收敛） | 采纳其窗口 digest | 收敛结果 ≡ 其本地 order，digest 对收敛面诚实 |
| 多变体全体同 face 同字节 | 采纳共同 digest | 各本地 order == converged 且 digest 一致 |
| 真分叉（X vs Y） | 不采纳 | 无变体发出过合并后的 union face，不存在诚实 digest；下一稳定窗口共识后再采纳 |
| 同名同序但字节互异（扇出中途 MCP 刷新） | 不采纳 | digest 互异 = 无共识 |
| 全体空窗口（digest 皆 None / 仅回带基线值） | 保持既有值 | None 永不抹掉已有 digest，与 repo advance「快照无 digest 不抹掉持久化值」契约一致 |

构造性质：补丁**不改** order 合并、fork 判定、bump 条件、锁序（digest
判定在锁外、采纳在既有锁内块），**不改任何发往 provider 的字节**；repo
`advance` 侧无改动（其「digest 仅在快照携带时更新」的既有语义现在首次
被真实触达，`advance_skips_write_when_generation_order_digest_unchanged`
对照组 2 的演练路径由此可达）。tool_loop.rs（#2 独占）零改动——其
「digest 推进只发生在多变体 converge 收敛点」注释由假变真。

### 3.3 明确不动的部分

- `tool_loop.rs` / `types.rs` / `repo.rs` / hooks / coordinator：零改动；
- `prefix_generation_fork_tests.rs` 契约副本：零改动（其 order/fork 语义
  与生产仍逐条一致；digest 收敛为新增行为，副本未覆盖——见 §4.1）。

---

## 4. 遗留观察（不构成本轮补丁，供后续轮次）

1. **fork 测试契约副本未按计划替换**：文件头声明「#1 落地后应改调
   `helpers::converge_session_tool_face_prefix` 并删除副本」，因生产函数
   需 `&self` + SQLite 未能纯逻辑调用，副本保留。今日语义一致，但本轮
   digest 收敛新增行为无测试覆盖——建议后续在该文件补一条「digest 共识
   采纳 / 分叉不采纳」的契约副本断言（该文件非本席独占，不越权改动）。
2. **变体早退漏收敛**（§1.5 备注 1，含新点名的 `:1630` `?` 传播）：若要
   收口，可在三处 `return Err` 前补 meta 写回或用 guard 兜底；属行为
   增强非缺陷修复，维持 r2 低危裁定。
3. **跨路径并发分叉不检测**（§1.5 备注 2）：真并发窗口依赖 UI 串行化
   假设；若产品侧引入同会话并发发送，需把 fork 判定扩展到「收敛结果 vs
   共享 entry 现值」。现阶段维持低危。

# R1 #7 锚定员-multi_variant：P1 多变体并发前缀分叉设计稿

- 基线：`cursor/0824-wave2-agent-cache-a875` @ `061b4815`（tip 为 wave2-A 开枝提交）
- 作者：R1 子代理 #7（claude-fable-5-thinking-high）
- 范围：只读分析 + 设计。**本轮不改产品代码。**
- 结论先行：**推荐方案 A（fan-out 统一代际）**。会话保持唯一权威 tools 前缀序 +
  代际号，分叉只在 fan-out 收敛点确定性切代一次，子代理与单变体续聊始终有单一
  母前缀可复用；方案 B 的 per-variant 键会把 append-only 不变式碎成 N 份、
  永久分叉 N 条缓存血统，侵入 repo / 分支复制 / GC，复杂度远超收益。

---

## 0. 现状机制盘点（涉案代码坐标）

P1 说的「前缀」在本仓当前实现里具体指 **tools 序基线**（frozen tool schema
order）。它是 provider prompt cache 稳定前缀的头部组成部分（Anthropic 把
tools 纳入缓存前缀，tools 段中段字节一变，其后 system + 全部 messages 的缓存
段全部失效 —— 见 `prefix_snapshot_tests.rs:1-17` 文件头论述）。

| 组件 | 位置 | 行为 |
| --- | --- | --- |
| 会话级内存基线 | `helpers.rs:1017-1047` `load_session_frozen_tool_schema_order` | `Mutex<HashMap<session_id, Vec<String>>>`；内存 miss 时无锁读库，再加锁 `entry().or_default()` + append-only 合并回填 |
| 会话级写回 | `helpers.rs:1058-1081` `store_session_frozen_tool_schema_order` | 锁内 append-only 合并→克隆→放锁→`merge_session_frozen_tool_schema_order` 持久化（失败仅降级打日志） |
| append-only 合并原语 | `tool_loop.rs:78-87` `merge_frozen_tool_schema_order_baseline` | 只按 `baseline` 顺序追加 `entry` 缺失名，绝不删除/重排 |
| 冻结排序原语 | `tool_loop.rs:39-72` `freeze_tool_schema_order_for_prompt_cache` | 空基线按字母序建基线；非空基线内按冻结序 stable sort，新名追加末尾并记入基线 |
| 字节级冻结（窗口级） | `tool_loop.rs:105-131` `freeze_tool_schemas_for_prompt_cache` | 已发出工具 schema 字节窗口内无条件回写冻结副本 |
| 持久化 | `repo.rs:2686-2734` `merge_session_frozen_tool_schema_order(_with_conn)` | IMMEDIATE 事务读-合并-写 `session.metadata.frozenToolSchemaOrder` 单键；无新增跳过写库；**不推 `updated_at`** |
| 单变体路径 | `tool_loop.rs:330-331`（环外一次 load）、`tool_loop.rs:981-995`（每轮 freeze + store） | 单写者，天然无分叉 |
| 多变体 fan-out | `multi_variant.rs:498-544` | `variant_contexts` 逐个 `spawn_tracked(execute_single_variant_with_config)`，`join_all` 等全部完成 |
| 变体内 load | `multi_variant.rs:1270-1275` | **每个变体各自**调 `load_session_frozen_tool_schema_order`（时机随调度漂移） |
| 变体内首次冻结+写回 | `multi_variant.rs:1313-1323` | freeze 后立即 `store_session_frozen_tool_schema_order` |
| 变体环内披露+写回 | `multi_variant.rs:1600-1691`（load_skills 渐进披露），写回在 `:1679-1686` | 全量重建 refreshed_tools → 按本地基线还原序 → **中途写回共享态** |
| 变体重试批 | `multi_variant.rs:2628` `execute_variants_retry_batch`、`:2824` `execute_variant_retry` | 同样走 `execute_single_variant_with_config`，即同一竞态面 |

关键结构事实：所有并行变体共享**同一个 `session_id`**，因此共享同一条内存基线
entry 与同一个 `frozenToolSchemaOrder` metadata 键；每个变体在
`execute_single_variant_with_config`（`multi_variant.rs:1059`）里持有基线的
**局部克隆**并独立推进，靠 append-only 合并写回「保证单调」。

---

## 1. 分叉场景：具体消息序列

设会话已收敛基线 `B̂ = [read_file, search]`（两轮前建立，provider 缓存热）。
用户第 T 轮发消息，fan-out 出变体 A、变体 B（`multi_variant.rs:508-544` 并行）。

### 轮 T（分叉发生）

```text
变体 A（并行任务 1）                      变体 B（并行任务 2）
─────────────────────────────           ─────────────────────────────
:1275 load → 本地基线 [read_file,search]  :1275 load → 本地基线 [read_file,search]
LLM 第 1 环：assistant 调 load_skills     LLM 第 1 环：assistant 调 load_skills
  → 披露技能工具 X (anki_export)            → 披露技能工具 Y (quiz_gen)
:1679 freeze → 本地 [read_file,search,X]  :1679 freeze → 本地 [read_file,search,Y]
:1683 store → 共享基线 merge 入 X          :1683 store → 共享基线 merge 入 Y
第 2 环请求字节：                          第 2 环请求字节：
  tools=[read_file,search,X]                tools=[read_file,search,Y]
  provider 缓存条目 cache_A =               provider 缓存条目 cache_B =
  [read_file,search,X | system | hist…]     [read_file,search,Y | system | hist…]
```

写回竞态：若 A 先 store，共享基线 = `[read_file, search, X, Y]`；若 B 先，
则 = `[read_file, search, Y, X]`。**由任务完成时序决定，不确定。** 更早一层，
两变体各自在 `:1275` load 的时机也在竞态窗口内 —— 若 B 先完成第 1 环写回，
A 的 load 就已带上 Y（且 Y 排在 X 前），同一轮内字节已不可复现。

### 轮 T+1（后轮两变体都「看见」X 和 Y）

设合并结果为 `[read_file, search, X, Y]`。用户再发消息，fan-out 两个新变体
A′、B′（沿用各自 provider/config，期望续接 cache_A / cache_B）：

```text
A′、B′ 都从共享基线 load 到 [read_file,search,X,Y]，发出同样的 tools 字节。

对 cache_A = [read_file,search,X | system | hist]：
  新请求 [read_file,search,X,Y | system | hist]
  → 命中止于 X 末尾；Y 起、system、全部 history 段 miss（占 prompt 绝对大头）。

对 cache_B = [read_file,search,Y | system | hist]：
  新请求第 3 个工具位是 X ≠ Y → 从 X 起全 miss，几乎颗粒无收。
```

若竞态反过来合并成 `[.., Y, X]`，则 B′ 半保、A′ 全 miss。**谁半保谁全灭由
join 竞态抽签**；跨进程重启后从 metadata 恢复的又是当时抽中的那个序，行为
不可预测但持久。重放层面更糟：会话级只存了最终合并序，变体 B 在轮 T 实际
发出的 `[read_file, search, Y]`（**不含 X、Y 在第 3 位**）已无从还原 ——
按现存基线重放会发出 `[read_file, search, X, Y]`，与原始请求字节不一致。

---

## 2. 为什么 append-only 合并救不了

append-only 合并（`tool_loop.rs:78-87` + `repo.rs:2699-2734`）保证的不变式是：

> **单一共享序列**单调增长，已有条目绝不删除、绝不重排。

它防的是「重排打爆已收敛前缀」（G6 时代的每轮字母序重建问题）。但缓存命中
要求的不变式是另一条：

> **每个写者（变体）本轮发出的字节序列**，是**该写者上一轮发出序列**的扩展。

两条不变式在单写者下等价（单变体路径 `tool_loop.rs` 因此没问题），在多写者
并发追加下**数学上不可兼得**：`B̂+[X]` 与 `B̂+[Y]`（X ≠ Y）互不为前缀，任何
单一合并序列 —— 无论 `B̂+[X,Y]`、`B̂+[Y,X]` 还是别的 —— 至多是其中**一个**的
扩展。这不是合并策略选得不好，而是「一个会话键、多个并发写者」这个形状本身
无解。append-only 只能保证合并结果不吞不排（它确实做到了），救不了：

1. **必 miss**：至少一个变体在 T+1 的前缀与自己 T 轮的缓存分叉；
2. **不确定性**：miss 落在谁头上由 store 竞态决定，且 `:1275` 的 load 竞态
   让同一轮内字节也不可复现；
3. **重放字节不一致**：会话级基线是「合并后的终态」，丢失了每个变体当轮
   实际发出的中间态（哪个子集、什么顺序），重放无法逐字节还原。

---

## 3. 方案对比与推荐

### 方案 A：fan-out 统一代际（共享 prefix generation，分叉后整扇出切代）

会话仍持**唯一**权威前缀基线，附加一个代际号 `g`：

- **fan-out 入口统一快照**：`execute_multi_variant` 在 spawn 之前一次性读
  `(g, B_g)`，Arc 分发给所有变体 —— 消除 `:1275` 的轮内 load 竞态，同一
  扇出内所有变体从**同一字节基线**出发；
- **环内只推本地、不写共享**：变体环内 load_skills 披露只推进本地副本，
  删除 `:1320` / `:1683` 的中途 `store_session_frozen_tool_schema_order`；
- **join 收敛点确定性合并**：`join_all`（`:544`）之后，按**变体索引序**
  （不是完成竞态序）把各变体本地尾部 append-only 合并进 `B_g` 得 `B'`；
  若 ≥2 个变体产生了互不相同的尾部（真分叉）→ `g+1`，一个 IMMEDIATE 事务
  同时落 `B'` 与新代号；仅单变体扩展（纯前缀延伸）不切代；
- **变体级重放快照**：每个变体把 `(g, 本地尾部)` 记入自己的 `VariantMeta`
  → 重放时 `B_g + tail` 逐字节还原该变体当轮真实 tools 序列。

代价与收益：分叉轮的**下一轮**至多一个变体保住部分前缀、其余一次性 miss ——
与现状损失相同（现状 T+1 本来就必 miss），但换到了：合并序确定可复现；
T+2 起**全体变体、单变体续聊、子代理收敛到同一前缀字节**，同 provider/key
下第一个请求建缓存、后续全部搭车。

### 方案 B：variant 级基线（每变体独立 generation）

键改为 `(session_id, variant_id)` → 独立基线。变体 A 永续 `[B̂,X,…]`、B 永续
`[B̂,Y,…]`，各自跨轮字节稳定：

- 收益：分叉轮的下一轮**双方都**命中自己的缓存（比 A 多保一轮）；重放天然
  per-variant 精确。
- 代价：
  - **前缀永久分叉**：N 变体 = N 条缓存血统，永不收敛；Anthropic cache write
    加价（5m 1.25× / 1h 2×）随变体数线性放大，且每条血统各自要养热；
  - **变体集合跨轮不稳定**：`execute_variants_retry_batch`（`:2628`）与新增
    变体拿**新 variant_id**，基线继承关系（继承谁的？空基线冷启？）要额外
    定义一套谱系规则；
  - **回归单变体时的晋升问题**：active variant 确定后（`:577`）单变体续聊
    要把该 variant 基线「晋升」为会话基线，晋升相对落选变体的血统又是一次
    分叉 —— 问题只是被推迟，没有消失；
  - **子代理复用母前缀失去权威对象**：子代理（独立 `agent_session_id`，见
    `docs/dev/chat-v2-subagent-runtime.md`）若要继承母会话稳定前缀，B 下
    必须先回答「继承哪个 variant 的」；
  - **侵入面大**：pipeline 内存 map 键型、repo 四个函数 + metadata 键设计
    （无界 per-variant 键）、分支复制（`repo.rs:1948-2049`）、会话删除 GC、
    现有 4 条 `frozen_tool_schema_order_*` repo 测试全部连带改写。

### 推荐：方案 A，按任务给定优先级逐条对照

| 优先项 | 方案 A | 方案 B |
| --- | --- | --- |
| 会话内工具面 append-only | 单一序列不变式原样保留，现有测试（`repo.rs:4341` `frozen_tool_schema_order_metadata_merge_is_append_only` 等）不动 | 不变式碎成 N 份 per-variant，测试全改 |
| system 稳定前缀 | 不动 system；T+2 起 tools 段全体一致，system 之后缓存段全体共享 | system 不动，但 tools 段永久多态，system 后缓存段按血统隔离 |
| 子代理复用母前缀 | 唯一 `(g, B)` 权威对象，子代理入口直接快照 | 需先选 variant，语义模糊 |
| 实现复杂度 | load 上移 + store 下移 + 1 个 generation 键 + 1 个收敛函数 | 键型全面改造 + 谱系规则 + 晋升逻辑 + 分支复制/GC 连带 |
| 重放正确性 | `VariantMeta` 记 `(g, tail)`，`B_g + tail` 逐字节还原 | 同样可精确，但依赖 per-variant 持久化永不被 GC |

唯一 B 占优的点（分叉轮下一轮多保一轮缓存）是一次性收益；A 用一次可预算的
miss 换长期单前缀收敛，且分叉本身（环内披露出**不同**技能工具）在真实使用中
是低频事件。**推荐 A。**

---

## 4. 方案 A 详设

### 4.1 数据键

| 键 | 层 | 形状 | 语义 |
| --- | --- | --- | --- |
| `frozenToolSchemaOrder` | `sessions.metadata`（现有键，`repo.rs:2653` 起） | `["name", ...]` | 权威基线 `B_g`，沿用不改形状 |
| `toolFacePrefixGeneration` | `sessions.metadata`（**新键**，与上键同层平级） | 整数，缺键视为 `0`（旧会话兼容） | 当前代号 `g`，仅 fan-out 收敛检出真分叉时 +1 |
| `toolFacePrefix` | `VariantMeta`（`types.rs:1241`，**新字段**，`Option` + `skip_serializing_if` 兼容老数据） | `{ "generation": g, "baseLen": B_g.len(), "localTail": ["X", ...] }` | 该变体当轮实际发出的前缀 = 快照时 `B_g` 截断到 `baseLen` + `localTail`，重放逐字节还原 |
| 内存 | `ChatV2Pipeline.frozen_tool_schema_orders` | 值型从 `Vec<String>` 扩为 `ToolFaceBaseline { generation: u64, order: Vec<String> }` | 单锁不变，不新增 Mutex |

写 metadata 遵守既有纪律（`repo.rs:2731-2733`）：单键 upsert、其他键
（authority/plan/branchedFrom/microcompactAnchor/availableSkillsSnapshot）
原样保留、**不推 `updated_at`**。

### 4.2 锁序与 IMMEDIATE 事务边界

沿用现有铁律：**内存 Mutex 决不跨 DB 调用持有**（load 侧先无锁读库再加锁
`or_insert`，`helpers.rs:960-994` 注释已明文；store 侧锁内合并克隆、放锁写库，
`helpers.rs:1063-1071`）。新增收敛点同构：

```text
fan-out join 收敛（新函数 converge_session_tool_face_prefix）：
  1. lock(frozen_tool_schema_orders)
       按变体索引序逐个 merge_frozen_tool_schema_order_baseline(entry.order, tail_v)
       真分叉判定：len(tails 非空的变体) ≥ 2 且尾部集合不全等 → entry.generation += 1
       克隆 (g', B')
  2. unlock
  3. repo::advance_session_tool_face_prefix：
       conn.transaction_with_behavior(Immediate)
         读 metadata → append-only 合并 B' → 无新增且 g 未变则跳过写库
         → 同事务 upsert frozenToolSchemaOrder + toolFacePrefixGeneration 两键
       tx.commit()
     失败仅 log::warn 降级（同 helpers.rs:1072-1080 现有语义），不阻断发送。
```

- 事务内不回调内存锁 → 无锁序倒置；
- 与 `microcompactAnchor`（`repo.rs:2847`）、`availableSkillsSnapshot`
  （`repo.rs:2772`）互为独立 IMMEDIATE 事务、不嵌套 → 无新增死锁面；
- 单变体路径（`tool_loop.rs:992`）保留每轮 append-only 写回，但**不 bump
  generation**（单写者是纯前缀扩展，旧缓存仍是新请求前缀，切代反而有害）。

### 4.3 对 cache hit 的影响

| 场景 | 现状（061b4815） | 方案 A |
| --- | --- | --- |
| 无分叉轮（变体无环内披露） | 全命中 | 全命中（不变），且消除 `:1275` load 竞态带来的偶发字节漂移 |
| 分叉轮 T 本身 | 各变体环内字节自洽，命中不受影响 | 同左 |
| T+1 | 必 miss ≥1 个变体；谁 miss 由竞态抽签；跨进程结果随抽签固化 | 至多 1 个变体保部分前缀、其余一次 miss；合并序确定（变体索引序），可复现可测试 |
| T+2 起 | 各变体理论上沿合并序恢复，但下次分叉再抽签 | 全体收敛同一前缀；扇出内同 provider/key 变体互蹭缓存 |
| 子代理 | 无权威前缀对象可引用 | 子代理入口快照母会话 `(g, B_g)`，tools 头字节与母一致，直接复用母前缀缓存段 |
| 重放 | 变体真实字节不可还原 | `VariantMeta.toolFacePrefix` 逐字节还原 |

### 4.4 第 2 轮落地步骤（文件与函数级）

1. **`types.rs`**：新增 `ToolFacePrefixSnapshot { generation, base_len, local_tail }`
   （serde camelCase）；`VariantMeta`（`:1241`）加
   `tool_face_prefix: Option<ToolFacePrefixSnapshot>`（`skip_serializing_if`）。
2. **`repo.rs`**：
   - 常量 `TOOL_FACE_PREFIX_GENERATION_METADATA_KEY`（与 `:2726` 的
     `FROZEN_TOOL_SCHEMA_ORDER_METADATA_KEY` 同区声明）；
   - `get_session_tool_face_prefix(_with_conn) -> (u64, Vec<String>)`（缺
     generation 键返回 0，复用 `frozen_tool_schema_order_from_metadata`）；
   - `advance_session_tool_face_prefix(_with_conn)`（IMMEDIATE、双键同事务、
     无变更跳过写库、不推 `updated_at`；内部复用
     `merge_frozen_tool_schema_order_baseline`）。
3. **`helpers.rs`**：
   - `load_session_frozen_tool_schema_order`（`:1017`）改造为
     `load_session_tool_face_prefix -> ToolFaceBaseline`（内存 miss 读库回填
     路径不变，`or_insert` 只填空位语义保留）；
   - 新增 `converge_session_tool_face_prefix(&self, session_id, variant_tails)`
     （见 4.2 伪码）；
   - `store_session_frozen_tool_schema_order`（`:1058`）保留给单变体路径，
     内部适配新值型（只动 `order`，不动 `generation`）。
4. **`multi_variant.rs`**：
   - `execute_multi_variant`：spawn 前（`:498` 之前）一次
     `load_session_tool_face_prefix` 快照，Arc 传入
     `execute_single_variant_with_config`（`:1059` 增参）；
   - `:1270-1275` 删除变体内独立 load，改用传入快照；
   - `:1320-1323`、`:1683-1686` 删除中途 `store_session_frozen_tool_schema_order`，
     只推进本地 `frozen_tool_schema_order`；
   - 变体收尾把 `(g, base_len, local_tail)` 写入该变体 `VariantMeta`
     （变体完成回写 meta 处，与 `skill_snapshot_after` 同路径）；
   - `join_all`（`:544`）之后、`=== 8` 之前调 `converge_session_tool_face_prefix`；
   - `execute_variants_retry_batch`（`:2628`）/ `execute_variant_retry`
     （`:2824`）同样接入「入口快照 + join 收敛」。
5. **`tool_loop.rs`**：`:331` load 改新结构取 `order`；`:992` store 语义不变
   （append-only 扩展、不切代）。
6. **反例测试源码（写不跑）**：
   - `prefix_snapshot_tests.rs`：
     `fanout_divergent_tool_faces_converge_deterministically`（B̂+X vs B̂+Y →
     收敛为按变体索引序的 B̂+X+Y 且 g+1；重复收敛幂等不再 bump）、
     `fanout_single_extender_does_not_bump_generation`、
     `variant_replay_bytes_reconstructed_from_meta`（`B_g[..base_len] + tail`
     逐字节等于该变体当轮 freeze 产出序列）；
   - `repo.rs` `#[cfg(test)]`：
     `tool_face_prefix_generation_roundtrips_and_preserves_metadata`
     （双键同事务、旧键兼容缺省 0、其他 metadata 键不丢、`updated_at` 不动）。
7. **文档**：`docs/dev/0824-g-invariants.md` 增补「多变体 tools 前缀代际」
   不变式一条。

### 4.5 不影响 hooks 准入序列（明确声明）

本设计**不触碰 `hooks.rs`**（该文件本轮归 #6 独占）。改动仅涉及 tools 序
基线的载入时机（fan-out 入口）、写回时机（join 收敛点）与 metadata 键：

- `before_turn` / `before_tool` / `after_tool` / `before_compaction` 的调用点
  （如 `tool_loop.rs:345`）零改动；
- 十五段准入序列、TOCTOU 三段检查、`ApprovalGateHook` 在
  `default_pipeline_hooks()` 首位 + `TaskAuditHook` 的约束零改动；
- 收敛点位于 `join_all` 之后 —— 所有变体的工具环与其 hook 生命周期已经结束，
  收敛只做内存合并与一次 metadata 写库，不产生任何新的工具执行或准入路径。

# R2 #1 代际实现-1：helpers + multi_variant 落地记录

- 基线：`cursor/0824-wave2-agent-cache-a875`（第 2 轮，方案 A——fan-out 统一代际）。
- 作者：R2 子代理 #1（claude-fable-5-thinking-high）。
- 范围：`helpers.rs` + `multi_variant.rs`（本席独占）+ `pipeline.rs` 仅值型
  升级（任务卡明示允许）。**未触碰** tool_loop（#2 独占）/ types / repo
  （#4 已完成）/ hooks / coordinator / 十五段准入 / TOCTOU。
- 依赖：#4 已落地的 `ToolFacePrefixSnapshot`、
  `ChatV2Repo::get/advance_session_tool_face_prefix(_with_conn)`、
  `VariantMeta.tool_face_prefix`。

---

## 1. 改了哪些函数 / 类型

### `pipeline.rs`（仅值型）

- `ChatV2Pipeline.frozen_tool_schema_orders` 值型：
  `HashMap<String, Vec<String>>` → `HashMap<String, helpers::ToolFaceBaseline>`
  （单锁不变、不新增 Mutex；构造仍 `HashMap::new()` 零改动；既有测试
  `frozen_tool_schema_order_survives_memory_clear` 的 `.clear()` 与
  load/store 薄封装调用零改动，原断言全部保留）。

### `helpers.rs`

- 新增 `pub struct ToolFaceBaseline { generation: u64, order: Vec<String>, schema_digest: Option<String> }`
  （derive Debug/Clone/Default/PartialEq/Eq），配套
  `to_snapshot()`（转 `types::ToolFacePrefixSnapshot`）与
  `From<ToolFacePrefixSnapshot>`。
- 新增 `load_session_tool_face_prefix(session_id) -> ToolFaceBaseline`：
  内存命中直接克隆返回；miss 走 `ChatV2Repo::get_session_tool_face_prefix`
  （`Ok(None)` / `Err` 均降级 `generation=0 + 空 order + digest None`，
  Err 仅 warn）。回填段：`entry().or_default()` + order append-only merge
  + generation 取 `max`（**miss 回填永不 bump**）+ digest 只填空位——
  与 #6 恢复测试 `locked_refill_baseline` 契约逐条一致。
- 新增 `converge_session_tool_face_prefix(session_id, variant_local_orders: &[(usize, Vec<String>)]) -> ToolFaceBaseline`：
  - 入参先按 `variant_index` **升序**排序（与完成竞态序彻底解耦）；
  - 锁外从空表出发按索引序逐个
    `merge_frozen_tool_schema_order_baseline`（每个本地 order 自带入口
    快照基线前缀，收敛结果 = 基线 + 各变体新尾部按索引序拼接）；
  - 真分叉判定：存在变体本地 order **不是**收敛结果前缀 →
    `generation += 1`；全部为前缀（同一前缀扩展或全等）→ 不 bump；
    单变体输入收敛结果恒等于其本地 order，构造上永不切代——与 #5
    分叉测试 `converge_orders_by_variant_index` 契约副本语义逐条一致
    （A 追加 X、B 追加 Y → `[base…, X, Y]` 且 +1；单变体 append → 不变）；
  - 锁内只做 append-only 合并 + 条件 bump + 克隆；放锁后
    `advance_session_tool_face_prefix` 写库，失败仅 warn 不阻断。
- `load_session_frozen_tool_schema_order`：改为薄封装，
  `load_session_tool_face_prefix(...).order`。
- `store_session_frozen_tool_schema_order`：保留为单写者纯扩展封装——
  锁内只 append-only 合并 `entry.order`、**不动 generation**；持久化从
  `merge_session_frozen_tool_schema_order` 改走
  `advance_session_tool_face_prefix`（generation 沿用当前值，双键
  `toolFacePrefixGeneration` + `frozenToolSchemaOrder` 同一 IMMEDIATE
  事务，避免「序新、代旧」漂移；repo 侧无变更跳过写库、不推 updated_at）。

### `multi_variant.rs`

- `execute_multi_variant`：spawn 之前（`=== 7` 段）一次
  `load_session_tool_face_prefix` → `Arc<ToolFaceBaseline>` 分发；
  `join_all` + 结果循环之后、`=== 8` 之前按变体索引序收集
  `VariantMeta.tool_face_prefix.order` 调 `converge_session_tool_face_prefix`。
- `execute_single_variant_with_config`：增参
  `tool_face_baseline: Arc<ToolFaceBaseline>`；变体内独立 load 删除，
  改 `tool_face_baseline.order.clone()`；两处中途 store 删除（环内
  `freeze_tool_schema_order_for_prompt_cache` 仍推进**本地** order）；
  工具环退出后（`hooks_guard.cleanup()` 之前）把
  `ToolFacePrefixSnapshot { generation: 入口代际, order: 本地完整序列, schema_digest: 入口 digest }`
  写入 `VariantMeta.tool_face_prefix`（generation 变体内不自增）。
- `execute_variants_retry_batch`：同构接入——futures 构建前统一快照、
  join 后按索引序 converge。
- `execute_variant_retry`：执行前统一快照、执行后以
  `&[(0, order)]` converge（单变体 = 纯扩展，构造上不切代）。

## 2. 删除的变体内 load / store（原基线行号）

| 原位置 | 原内容 | 替代 |
| --- | --- | --- |
| `multi_variant.rs:1274-1275` | 变体内独立 `load_session_frozen_tool_schema_order` | fan-out 入口快照 `tool_face_baseline.order.clone()` |
| `multi_variant.rs:1320-1323` | 首次注入 freeze 后中途 `store_session_frozen_tool_schema_order` | 删除（join 收敛点统一写回） |
| `multi_variant.rs:1683-1686` | 环内 load_skills 披露 freeze 后中途 `store_session_frozen_tool_schema_order` | 删除（同上） |

## 3. converge 调用点（改后行号）

| 调用点 | 位置 |
| --- | --- |
| 主 fan-out join 之后（`=== 8` 之前） | `multi_variant.rs:600` |
| `execute_variants_retry_batch` join 之后（持久化循环之前） | `multi_variant.rs:2844` |
| `execute_variant_retry` 变体环结束后 | `multi_variant.rs:2991` |

三处的入口统一快照分别在 `multi_variant.rs:509` / `:2756` / `:2969`。

## 4. 锁序（不倒置，与现 load/store/microcompact 同构）

- load：锁查命中 →（miss）**放锁**读库 → 再加锁 `or_default` merge 回填
  （防 TOCTOU 双建：后写只 append-only merge + generation max，不 bump）；
- converge：收敛计算全部锁外 → 锁内 merge + 条件 bump + 克隆 → **放锁后**
  `advance`（IMMEDIATE 事务内不回调内存锁）；
- store 薄封装：锁内合并克隆 → 放锁写库（advance）。
- 所有写库失败仅 `log::warn` 降级，不阻断发送。

## 5. 明确不动的部分

- hooks 调用链 / 十五段准入 / TOCTOU / `ApprovalGateHook` 首位：零改动
  （收敛点在 `join_all` 之后，所有变体工具环与 hook 生命周期已结束，
  收敛只做内存合并 + 一次 metadata 写库）。
- `tool_loop.rs`（#2 独占）：零改动。单变体路径 `:372` load、`:1067`
  store 仍走薄封装（签名不变），其中 store 的持久化通道已由封装内部
  升级为 advance（纯扩展不切代，generation 沿用当前值）。
- `coordinator.rs` / `types.rs` / `repo.rs` / executor 注册：零改动。
- `repo.rs` 旧函数 `get/merge_session_frozen_tool_schema_order` 保留
  （旧读路径与既有 4 条 repo 测试不动），helpers 不再调用 merge 版。

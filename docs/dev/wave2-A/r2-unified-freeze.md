# r2 实现记录：统一冻结原语（Wave2-A 第 2 轮 #3「收敛补刀」）

对象：`src-tauri/src/chat_v2/pipeline/tool_loop.rs`（统一入口 + 单变体接线）、
`src-tauri/src/chat_v2/pipeline/multi_variant.rs`（两处 freeze 换统一入口 + 字节冻结补齐）。
在 #1（helpers `ToolFaceBaseline` / `load_session_tool_face_prefix` /
`converge_session_tool_face_prefix`）与 #2（`tool_schema_digest` + 单变体
digest 观测）之上做收敛，`helpers.rs` 本轮零改动。

## 统一入口（tool_loop.rs，新门面）

```rust
pub(crate) fn freeze_tool_face_for_prompt_cache(
    tools: &mut [Value],
    frozen_names: &mut Vec<String>,
    frozen_schemas: &mut HashMap<String, Value>,
) -> Option<String>
```

- 内部即 `freeze_tool_schemas_for_prompt_cache`（名字序 append-only 冻结 +
  已发出 schema 窗口内**无条件字节回写**，语义逐字未动），随后返回
  `tool_schema_digest(frozen_schemas)`。
- 返回 `None` = 空窗口（尚未发出任何工具），调用方不得用 None 抹掉已有
  digest；`Some(digest)` = 当前窗口冻结快照的名字序稳定哈希。
- **是门面不是替代**：`freeze_tool_schema_order_for_prompt_cache` /
  `freeze_tool_schemas_for_prompt_cache` / `tool_schema_digest` 符号全部
  保留（`#[cfg(test)]` 冻结测试与 `prefix_generation_fork_tests.rs` /
  `prefix_snapshot_tests.rs` 仍直接调用原语）。

## 单变体 tool_loop 接线

- load（原 :372 一带）：改为 `self.load_session_tool_face_prefix(&ctx.session_id)`，
  三元组就位——`frozen_tool_schema_order = baseline.order`、
  `prefix_generation = baseline.generation`（不再局部缺省 0）、
  `baseline_schema_digest = baseline.schema_digest`（不再以 None 起步，
  跨窗口 digest 对账自此有持久化来源）。#2 留下的 load 段 TODO 已删。
- freeze（环内 custom_tools 处）：改调 `freeze_tool_face_for_prompt_cache`，
  digest 由返回值取得（不再单独调 `tool_schema_digest`）。digest 变化仍
  只打 info 日志（带 session_id / generation / 新旧 digest 截断值），
  **不 bump generation**。
- store：仍走 `store_session_frozen_tool_schema_order`（append-only 合并
  order、generation 沿用当前值、digest 不随 store 持久化——digest 推进
  只属于多变体 converge 收敛点）。store 段 TODO 已删，替换为现状注释。

## 多变体两处 freeze（execute_single_variant_with_config）

- 变体函数新增窗口级 `frozen_tool_schemas: HashMap<String, Value>`
  （与单变体同语义：一个变体工具环 = 一个稳定窗口，窗口内字节冻结、
  本地持有、不写共享态）与 `variant_schema_digest: Option<String>`
  （从 fan-out 入口基线 digest 起步）。
- 初始 MCP 注入处（原 :1316 一带）与 load_skills 渐进披露刷新处
  （原 :1679 一带）均改调 `freeze_tool_face_for_prompt_cache`；返回
  `Some(digest)` 时推进 `variant_schema_digest`（None 保持既有值）。
  多变体路径由此获得此前缺失的**字节级冻结**（同名 schema 环内变化时
  发送冻结字节，变更延迟到下一稳定窗口）。
- 变体结束写 `VariantMeta.tool_face_prefix` 时 `schema_digest` 改为
  `variant_schema_digest`（此前误写入口基线 digest，变体本地推进丢失）；
  `generation` 仍写入口代际、`order` 仍是本地完整序列。
- **未恢复中途 store**：两处原 `store_session_frozen_tool_schema_order`
  在 #1 落地时已移除，本轮保持只推本地、join 之后
  `converge_session_tool_face_prefix` 统一收敛的控制流，fan-out /
  converge 逻辑零改动。

## 未动项（红线自查）

- hooks 控制流（before_turn / before_compaction / before_tool / after_tool）
  未动；`coordinator/hooks.rs` 未碰。
- `converge_session_tool_face_prefix` 切代规则（真分叉判定 / 索引序合并 /
  锁序）未动；`helpers.rs` 本轮无 diff。
- append-only 首见序与窗口字节回写语义逐字未变（统一入口纯转发）。
- 旧符号 `load_session_frozen_tool_schema_order`（pipeline.rs 测试仍用）、
  `freeze_tool_schema_order_for_prompt_cache`、
  `freeze_tool_schemas_for_prompt_cache` 全部保留。
- 未执行 cargo / npm / 测试；未 git commit（按本席铁律，交由上游收敛提交）。

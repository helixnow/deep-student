# r2 实现记录：tool_loop.rs（Wave2-A 第 2 轮 #2「代际实现-2」）

对象：`src-tauri/src/chat_v2/pipeline/tool_loop.rs`（单变体工具环）。
遵循 `ROUND-02-TASKS.md` API 合同与方案 A（fan-out 统一代际）。本席只改 tool_loop.rs。

## digest 算法（`tool_schema_digest`，tool_loop.rs `pub(crate)`）

- 输入：当前稳定窗口的字节冻结快照 `frozen_tool_schemas: &HashMap<String, Value>`
  （`freeze_tool_schemas_for_prompt_cache` 维护的「名字 → 首见 schema 冻结副本」）。
- 空窗口（尚未发出任何工具）→ `None`，与 `ToolFacePrefixSnapshot::schema_digest`
  的缺省语义对齐（缺 digest 不构成变更、不得抹掉已持久化值——repo #4 已锁定）。
- 非空：按工具**名字序**（字典序，与 HashMap 迭代序无关）遍历，逐项以
  `名字字节 + 0x1f + serde_json::to_string(schema) 字节 + 0x1e` 喂入 sha256，
  输出小写 hex。分隔骨架复用 `DoomLoopGuard::fingerprint`（context.rs:174-185，
  `sha2::{Digest, Sha256}` 经 pipeline.rs:26 `pub(crate) use` 再导出，未引新 crate）。
- 稳定性依据：serde_json 开启 preserve_order，冻结副本在窗口内逐字节不变
  （freeze 对已发出工具无条件回写冻结副本），故同一冻结内容恒得同一 digest；
  0x1f/0x1e 定界防止「名字+JSON」拼接歧义。

## 不切代纪律（单变体路径）

- **纯前缀扩展不 bump generation**：环内 load_skills / MCP 追加只会向
  `frozen_tool_schemas` 追加新键（已发出条目字节冻结，不可能原地变），
  digest 变化即前缀扩展（或窗口首建）——只打 info 日志（带 session_id、
  当前 generation、新旧 digest 截断值）并把新 digest 写入本地快照变量，
  **禁止** `generation += 1`。代际切换只发生在多变体 converge
  （互异不可 append-only 对齐的尾部，#1 席位落地）。
- store 侧继续走 `store_session_frozen_tool_schema_order`（append-only 合并 +
  持久化，不动 generation）；字节冻结仍窗口级持有、不写回（P3-a 语义未变）。

## 与 #1/#3 的接缝（TODO 已内联标注）

写入时 `helpers.rs` 尚未暴露 `load_session_tool_face_prefix` / `ToolFaceBaseline`
（#1 同轮并行落地），按任务卡 fallback：

- load：暂用 `load_session_frozen_tool_schema_order` 取 order；
  `prefix_generation` 局部缺省 0、`baseline_schema_digest` 局部缺省 `None`
  （跨窗口 digest 对账随新 API 接入）。TODO 注释给出替换后的三行目标代码。
- store：TODO 注明 helpers 的 advance 封装可携带 generation + digest 后，
  改为同快照写回 `ToolFacePrefixSnapshot { generation, order, schema_digest }`
  （generation 保持不变、digest 更新）。#3 统一冻结原语时收敛此缺口，
  `tool_schema_digest` 已 `pub(crate)` 供其复用。

## 未动项（红线自查）

- hooks 四切点控制流未变：`before_turn`（环首，现 :395）、`before_compaction`
  （compaction 前，现 :517）、`before_tool`/`after_tool`（execute_single_tool
  内）原样；行号因上方插入 digest 原语整体下移，语句与顺序零改动。
- TOCTOU 第三段终检（「Final admission point」，现 :3324）未动。
- `#[cfg(test)]` 冻结测试一条未删未改。
- 文件头未大改；仅在 `freeze_tool_schemas_for_prompt_cache` rustdoc 补一句
  「digest 计算见 tool_schema_digest；单变体 digest 变不切代」（#9 写矩阵）。

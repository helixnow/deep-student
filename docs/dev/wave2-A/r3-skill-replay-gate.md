# Wave2-A r3 #3：技能锚定重放 digest 门禁（history.rs）

> 铁律遵守：未运行 cargo/npm/任何测试；未 git commit。
> 独占可写文件：`src-tauri/src/chat_v2/pipeline/history.rs`（本文档除外）。
> 未触碰 types.rs / persistence.rs / hooks.rs / coordinator.rs / helpers.rs /
> skill_replay_digest_tests.rs。

## 背景

P1-8 技能锚定重放只落库技能 **id**（`meta.skill_injection_anchors`），正文取自
当轮请求的 `replay_skill_contents` / `skill_contents`。隐含前提「当轮正文 ==
锚定当时的正文」一旦被用户编辑技能打破，按 id 盲取新正文重建会把**从未发给
provider 的字节**伪装成旧历史——既伪造对话历史，又必然打断 prompt cache。

#2 已在 types.rs 落地 `SkillInjectionAnchors.skill_content_digests`（skill_id →
`skill_body_digest` sha256 hex）、`skill_content_rev`、`content_digest_for()`。
本任务在 history.rs 重放侧接上门禁。

## 新签名

```rust
// 生产入口（新增）：带 digest 门禁
pub(super) fn rebuild_anchored_skill_messages_gated(
    skill_ids: &[String],
    skill_contents: Option<&std::collections::HashMap<String, String>>,
    anchors: Option<&crate::chat_v2::types::SkillInjectionAnchors>,
) -> Vec<LegacyChatMessage>

// 兼容入口（原签名保留）：等价于门禁版传 anchors = None
pub(super) fn rebuild_anchored_skill_messages(
    skill_ids: &[String],
    skill_contents: Option<&std::collections::HashMap<String, String>>,
) -> Vec<LegacyChatMessage>
```

选择「新增门禁函数 + 原签名降级为兼容包装」而非原地改签名的原因：

1. `helpers.rs:2270`（重放一致性测试）与 `skill_replay_digest_tests.rs`
   （:218/:328/:339/:395）按二参签名调用，且后者明确把二参函数当
   「无门禁反例」断言（digest mismatch 时输出 v2 字节的缺口记录）——
   两个文件都在本轮可写范围之外，原地改签名必然破坏编译。
2. 兼容包装体内只有一行委托，旧行为（有正文就重建 / 缺正文 warn+skip）
   由门禁版 `anchors = None` 分支承载，无逻辑复制。

## 门禁判定（逐锚点，skip 不阻塞不换序）

| 场景 | 行为 |
| --- | --- |
| 正文缺失（技能被删且无 replay 快照） | warn + skip（旧行为不变，warn 文案不变） |
| 锚点有 digest 且正文存在，`skill_body_digest(id, body) == stored` | 重建（live 同一渲染函数 `make_transient_skill_message`，字节相等） |
| 锚点有 digest 且正文存在，digest 不一致 | `log::warn!` 写明 mismatch（含 anchored/current 两侧 digest）+ skip，**禁止用新正文伪装旧历史** |
| 旧锚点无该 skill 的 digest（旧 JSON 空 map / `anchors = None`） | 旧行为：有正文就重建（向后兼容） |

digest 只读不写：本改动不向 DB 写任何技能正文或新字段。

## 三个消费点（load_chat_history_pass 内，改后行号）

| 行号 | 位置 | 传入的 anchors |
| --- | --- | --- |
| `history.rs:159` | turn 级锚点（`anchors.turn_skill_ids`，本轮 user 消息前还原） | `Some(anchors)`（`skill_anchors.as_ref().filter(...)` 绑定） |
| `history.rs:327` | tool 级锚点（`tool_call_id` 匹配命中，load_skills tool result 之后还原） | `skill_anchors.as_ref()` |
| `history.rs:358` | tool 级锚点兜底（`tool_call_id` 未匹配，追加到工具消息末尾） | `skill_anchors.as_ref()` |

tool 级锚点（`ToolAnchoredSkills`）不带独立 digest map，与 turn 级共用同一
`SkillInjectionAnchors.skill_content_digests`（#2 落地的形态即按消息级共享）。

## 旧锚点兼容

**保留。** 旧 JSON（无 `skill_content_digests` 字段）经 `#[serde(default)]`
反序列化为空 map，`content_digest_for` 恒返回 `None`，门禁对每个 skill 走
「无 digest → 有正文就重建」分支——与改动前逐字节同行为。缺正文的
warn+skip 文案也未变。

## 测试影响

- 可写范围外的既有测试**零改动**：`helpers.rs` 重放一致性测试与
  `skill_replay_digest_tests.rs` 契约/反例测试继续按二参兼容入口断言
  旧语义（后者文件头已注明门禁落地后反例段应改为对门禁版断言 skip，
  该文件本轮不可写，留待后续轮次收口）。
- 本文件（history.rs）改动前没有 `rebuild_anchored_skill_messages` 的
  `#[cfg(test)]` 调用点，无需同步改。
- 新增 `#[cfg(test)] mod skill_replay_gate_tests`（只写不跑）：
  - `gate_skips_mismatch_and_rebuilds_match_in_anchor_order`：mismatch skip、
    match 重建与 live 同字节、skip 不阻塞不换序;
  - `legacy_anchor_without_digest_keeps_old_rebuild_behavior`：空 digest map
    旧行为、二参入口 == 门禁版传 None、缺正文两路径均 skip。

## 返回摘要

- **新签名**：`rebuild_anchored_skill_messages_gated(skill_ids, skill_contents, anchors: Option<&SkillInjectionAnchors>)`；原二参 `rebuild_anchored_skill_messages` 保留为兼容包装（委托门禁版传 `None`）。
- **三消费点行号**：`history.rs:159`（turn 级）、`history.rs:327`（tool 级命中）、`history.rs:358`（tool 级兜底）。
- **旧锚点兼容**：保留——无 digest 的锚点（旧 JSON / None）逐字节维持「有正文就重建」旧行为，缺正文 warn+skip 不变。

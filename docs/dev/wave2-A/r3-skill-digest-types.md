# r3 #2 技能锚点 digest 类型合同（types.rs）

轮次：Wave2-A 第 3 轮 #2。独占可写：`src-tauri/src/chat_v2/types.rs`（仅技能锚点字段 + 小 helper）+ 本文档。
本轮铁律：未执行 cargo/npm/测试；测试只写不跑。

## 变更清单

`src-tauri/src/chat_v2/types.rs`：

1. `SkillInjectionAnchors` 新增两个字段（均带 `#[serde(default)]`，序列化空值时跳过）：
   - `skill_content_digests: HashMap<String, String>` — skill_id → 正文 sha256 小写 hex；
     `skip_serializing_if = "HashMap::is_empty"`。
   - `skill_content_rev: Option<u64>` — 可选版本世代；
     `skip_serializing_if = "Option::is_none"`。
2. 新增自由函数 `pub fn skill_body_digest(skill_id: &str, body: &str) -> String`。
3. 新增小 helper `SkillInjectionAnchors::content_digest_for(&self, skill_id) -> Option<&str>`
   （按 id 查 digest，旧锚点恒 `None`），供 #3 history 侧消费。
4. 测试模块新增 4 个只写不跑的测试：旧 JSON 兼容、空值跳过、roundtrip、digest 稳定性/分隔安全。

未动：tool face 相关类型、`VariantMeta` 语义、`ReplaySkillPayloadSnapshot::without_skill_contents`、
`SkillInjectionAnchors::is_empty()`（仍只看 `turn_skill_ids` / `tool_anchored`，digest/rev 不参与判空——
无技能 id 时它们无意义）。

## 字段默认值

| 字段 | 缺字段（旧 JSON）反序列化结果 | 序列化 |
|---|---|---|
| `skill_content_digests` | 空 `HashMap`（`serde(default)`） | 空 map 整个字段不输出（`skip_serializing_if = HashMap::is_empty`） |
| `skill_content_rev` | `None`（`serde(default)`） | `None` 不输出（`skip_serializing_if = Option::is_none`） |

重放侧合同：**缺字段 = 旧锚点**，视为「无 digest」，保持现有 warn 行为（#3 只在 digest 存在
且与当轮请求正文的 digest 不一致时才拒绝重放并要求切代）。`content_digest_for` 对旧锚点返回
`None`，消费方无需区分「字段缺失」与「map 里没有该 id」。

字段名走结构体既有 `#[serde(rename_all = "camelCase")]`：JSON 键为 `skillContentDigests` /
`skillContentRev`。

## digest 算法

```
skill_body_digest(skill_id, body) =
    hex_lower( sha256( utf8(skill_id) || 0x1f || utf8(body) || 0x1e ) )
```

- 复用仓内 `sha2::Sha256`（`Cargo.toml` 已有 `sha2 = "0.10.8"`，未引新 crate；函数体内
  `use sha2::{Digest, Sha256};`，与 `secure_store.rs` 等既有写法一致，types.rs 顶部 import 不动）。
- 骨架与 `tool_loop.rs::tool_schema_digest` / `DoomLoopGuard::fingerprint` 相同：`0x1f`
  字段分隔 + `0x1e` 记录终止，避免 `(id, body)` 拼接歧义碰撞（`("a","b|c")` ≠ `("a|b","c")`，
  `("ab","")` ≠ `("a","b")`）。
- 输入只有两个 `&str` 的 UTF-8 字节，无 HashMap 迭代序、无 serde 序列化中间层，跨进程/
  跨版本稳定。测试钉死了一个具体向量：
  `skill_body_digest("manual-a", "body text") = 316f875d29c27e04369ccd63e8a575827d71bee69a44c074b322a472f82bd3dc`
  （已用独立 python hashlib 验算）。
- 输出恒为 64 字符小写 hex。

## 旧 JSON 是否仍能 parse

**能。** 两个新字段都是 `#[serde(default)]`，第 2 轮及更早写入的
`meta.skill_injection_anchors`（只有 `turnSkillIds` / `beforeTurnUser` / `toolAnchored`）
反序列化后 digest 为空 map、rev 为 `None`。反向也兼容：无 digest 时序列化不输出新键，
旧读者看到的字节形态与 r3 前完全一致。测试
`test_skill_injection_anchors_old_json_without_digest_fields_still_parses` /
`test_skill_injection_anchors_digest_fields_skip_when_empty` 钉死了这两个方向。

## 隐私纪律

`without_skill_contents` 不变：技能正文仍不落库。anchors 只持久化 `skill_body_digest`
的输出（不可逆 hash）与可选 rev，正文不进 anchors——roundtrip 测试断言序列化 JSON 不含正文。

## 给 #3（history.rs）的接线要点

- 重建每条锚定技能消息前：`anchors.content_digest_for(skill_id)`。
  - `None`（旧锚点）→ 现有行为（正文缺失 warn + skip）。
  - `Some(expected)` → 与 `skill_body_digest(skill_id, 当轮请求正文)` 比较；不一致 →
    warn + 跳过该技能消息，并向调用方返回「需开新 prefix generation」信号，禁止用新正文伪装旧历史。
- 写入侧（tool_loop 冻结锚点处，本轮不属于 #2 范围）应在锚定时刻对即将发出的正文调用
  `skill_body_digest` 填入 map。

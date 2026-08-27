# Wave2-A 第 6 轮 #2：冻结原语二检（tool_loop.rs）

- 审阅员：r6 #2「冻结原语」（claude-fable-5-thinking-high）
- 对象：`src-tauri/src/chat_v2/pipeline/tool_loop.rs` @ tip `4b784bb4` ——
  `freeze_tool_face_for_prompt_cache` 统一门面、`tool_schema_digest`、
  单变体「digest 变化不切代」路径（一检：`r2-impl-tool-loop.md` /
  `r2-unified-freeze.md`；矩阵基准：`r2-freeze-matrix.md`）
- 铁律遵守：未运行 cargo / 任何测试；未 git commit
- **结论：确认（无补丁）**。三项原语语义与一检声明及冻结矩阵逐条相符，
  tool_loop.rs 内无明确 bug；检出一处**跨文件接线断头**（F-1，`toolSchemaDigest`
  持久化链路在生产路径永不落库），修复归属 helpers.rs / multi_variant.rs，
  不在本席可写范围，上报不落补丁。

---

## 1. 漂移核查：原语自 r2 落地后零改动

```
$ git diff f94f88d1..HEAD -- src-tauri/src/chat_v2/pipeline/tool_loop.rs
```

自 r2 落地提交 `f94f88d1`（unify tool-face prefix generation across fan-out）
至 tip，tool_loop.rs 仅有 r3 技能锚定 digest 两处插入（:708-733、:1976-2010，
属 #4 技能版本化面），**冻结原语区（:54-227）与单变体 freeze 调用点
（:426-442、:1101-1143）逐字节未动**。一检结论的审阅对象与当前代码一致，
二检不存在「审的不是落的」问题。

## 2. 逐项确认

### 2.1 `tool_schema_digest`（:189-203）

| 一检/矩阵声明 | 二检核对 | 判定 |
| --- | --- | --- |
| 名字序遍历，与 HashMap 迭代序无关 | `entries.sort_by_key(\|(name, _)\| *name)` 后逐项喂 hasher（:193-201），同一冻结内容恒得同一 digest | ✅ |
| `名字 + 0x1f + JSON 字节 + 0x1e` 定界防拼接歧义 | serde_json 序列化对字符串内控制字符恒转义（`\u001f`），序列化输出不含裸 0x1f/0x1e，帧边界无歧义；名字自身含 0x1f 的碰撞需伪造出合法 JSON 后缀，实际不可构造 | ✅ |
| 空窗口返回 `None`，与 `ToolFacePrefixSnapshot::schema_digest` 缺省对齐 | :190-192 早退；repo 侧 `advance_..._with_conn` 的 `next_digest = snapshot.or(persisted)`（repo.rs:3123）确实实现「None 不抹掉已有值」 | ✅ |
| 稳定性依赖 preserve_order 下冻结副本字节不变 | 输入是 `frozen_schemas` 冻结副本（首见后不再改写），`to_string(Value)` 实际不可失败，`unwrap_or_default()` 仅防御 | ✅ |

### 2.2 `freeze_tool_face_for_prompt_cache` 门面（:220-227）

- 纯转发：`freeze_tool_schemas_for_prompt_cache`（名字序 append-only +
  无条件字节回写）后取 `tool_schema_digest`，无任何附加控制流 —— 与
  r2-unified-freeze「语义逐字不变」声明一致。
- 全部 3 个调用方均遵守「不得用 None 抹掉已有 digest」契约：
  - tool_loop.rs:1122 `is_some() &&` 前置守卫；
  - multi_variant.rs:1362 / :1728 `if let Some(digest)` 才推进
    `variant_schema_digest`。
- 底层原语符号（`freeze_tool_schema_order_for_prompt_cache` /
  `freeze_tool_schemas_for_prompt_cache` / `tool_schema_digest`）全部保留，
  「门面不是替代」成立。
- 字节冻结的关键细节（preserve_order 下 `==` 相等 ≠ 字节相等，必须无条件
  回写）有专项测试锁定：
  `frozen_tool_schema_bytes_normalize_key_order_permutation`（:4078）。

### 2.3 单变体不切代（:426-442 载入段、:1101-1143 freeze 段）

- `prefix_generation` 全文件只读不写：grep `generation` 仅 :432 读基线、
  :1128 进日志；`+= 1` 在 tool_loop.rs 中零出现（:306-317 的
  `stream_generation` 是流事件标识符，无关）。
- store 路径（:1139 → helpers `store_session_frozen_tool_schema_order`
  :1284-1309）锁内只做 order append-only 合并，generation / digest 取内存
  entry 现值 —— 纯前缀扩展不切代成立；唯一切代点仍是
  `converge_session_tool_face_prefix`（helpers.rs:1168-1169 真分叉 bump）。
- digest 变化处置（:1122-1133）：info 日志（session_id / generation /
  新旧 digest 截断）+ 更新本地对账变量，不写回、不切代 —— 与矩阵第 3 节
  「单变体窗口 digest 变化不切」行一致。
- 窗口语义：`frozen_tool_schemas` 每次 `execute_with_tools` 重建（:442），
  跨窗口采纳新字节由 `same_name_schema_change_applies_at_next_stable_window`
  （:4044）锁定；名字序基线会话级持有（:426-427 经
  `load_session_tool_face_prefix` 含跨进程恢复）。

## 3. 检出问题（均不构成 tool_loop.rs 补丁）

### F-1（中，跨文件接线断头，上报）：会话级 `toolSchemaDigest` 生产路径永不落库

digest 的「推进」被三份文档一致托付给多变体 converge 收敛点
（tool_loop.rs:1137-1138 注释、r2-unified-freeze「digest 推进只属于多变体
converge 收敛点」、矩阵 F2「仅摘要落库：toolSchemaDigest」），但链路断在
收敛点自身：

1. `converge_session_tool_face_prefix(session_id, variant_local_orders)`
   **只收 order**（helpers.rs:1140-1143）；join 处收集也只取
   `prefix.order`（multi_variant.rs:596 / :2861 / :3012），变体辛苦推进的
   `VariantMeta.tool_face_prefix.schema_digest`（multi_variant.rs:1923）
   无人消费进会话基线；
2. `advance_session_tool_face_prefix` 的两个生产调用方（converge
   helpers.rs:1179、store helpers.rs:1298）传的都是内存 entry 快照，而
   entry 的 `schema_digest` 唯一写点是 load 时「从持久化填空位」
   （helpers.rs:1110-1112）—— 持久化值又只能来自快照携带（repo.rs:3123），
   **循环依赖，无一处生产代码首次播种**。

后果（均为观测面退化，不影响冻结正确性与缓存字节）：

- `baseline_schema_digest`（tool_loop.rs:436）恒以 None 起步，:1122 的
  「digest changed」日志在**每个窗口首个带工具轮次**必发一条
  `None -> Some(...)`，跨窗口真漂移淹没在首建噪声里 ——
  r2-impl-tool-loop「跨窗口 digest 对账自此有持久化来源」的声明未兑现；
- 矩阵 F2 的「仅摘要落库」描述的是死键：`toolSchemaDigest` 只有 repo
  单测直接构造快照时会写入（repo.rs:4786 等），生产库中该键恒缺。

**为何不在本席修**：单变体路径若擅自把窗口 digest 随 store 持久化，即违反
「digest 推进只发生在 converge」的既定纪律（一检 #3 的明确设计决策）；
正确修复是 converge 签名收 `(usize, Vec<String>, Option<String>)` 或等价
形态并在收敛点择定 digest，落点在 helpers.rs + multi_variant.rs 三处 join
收集 —— 均非本席可写文件。亦可反向裁决「digest 仅作 VariantMeta 级重放
观测，会话级键废弃」，则应修矩阵 F2 与 :1137-1138 注释。建议进 ledger
待裁决，本轮不动代码。

### F-2（低，理论 nit，不修）：digest 截断用字节切片

:1129-1130 `&d[..12.min(d.len())]` 对非 ASCII 字符串会 panic 于字符边界。
digest 均为自产 lowercase hex（且按 F-1 持久化值今日恒缺），仅手工篡改
session.metadata 才可达 —— 不构成明确 bug，不动。

### F-3（低，语义备忘，不修）：digest 是「窗口冻结快照」身份而非「本轮请求」身份

`frozen_schemas` 窗口内只增不减：工具中途从 `tools` 消失后仍留在快照与
digest 里。与 :177 rustdoc「当前稳定窗口字节冻结快照的 schema digest」
定义一致（有意为之），遥测消费方勿把它当单轮请求 tools 指纹用。

### F-4（低，覆盖缺口备忘）：digest / 门面无直接单测

`#[cfg(test)]` 覆盖了排序、order 冻结、字节冻结、键序扰动、窗口边界
（:3756-4107 共 7 条），但 `tool_schema_digest`（名字序稳定性、空窗口
None）与门面返回值无直接断言。本轮禁测试且非 bug，仅记录。

## 4. 最终判定

**确认。** 三项原语（统一门面 / digest / 单变体不切代）实现与一检声明、
冻结矩阵 F1-F3 及切代清单逐条相符，自 r2 落地后零漂移，调用方契约
（None 不抹 digest、变体只推本地、store 不动代号）全部在位；tool_loop.rs
无明确 bug，本轮不落补丁。F-1 为跨文件接线断头（converge 不收 digest →
`toolSchemaDigest` 生产死键、跨窗口对账退化为首建噪声），归属
helpers.rs / multi_variant.rs 席位或架构裁决，建议记入台账。

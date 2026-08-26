# Wave2-A R10 #6：缓存命中率静态推演

## 口径

- 对比对象：官方基座 `061b4815` 与本枝 `659b8c54`。
- 本文只沿最终请求字节、冻结状态和持久化时序做源码推演；**这是静态推演，无运行时命中率**，也不把测试源码当作已执行证据。
- 本文不提供百分比。是否实际命中还受 provider、模型、缓存 TTL、最小 token 门槛、请求间隔和并发完成顺序影响。
- 下文用 `tools | system | history | current_user` 表示逻辑前缀层。具体线序以各 provider 最终请求体为准；共同原则是：首个字节分歧之后的后缀不能沿用旧前缀缓存。

## 结论总表

| 场景 | 基座 `061b4815`：首个断裂点 | 本枝：首个断裂点与收敛 |
|---|---|---|
| 多变体 `[A,X]` vs `[A,Y]` | 两变体各自 load，并在环内竞态写回同一会话基线。共享终态可能是 `[A,X,Y]` 或 `[A,Y,X]`；T+1 至少一侧必在新增工具位断裂，哪一侧损失更多由写回时序决定 | fan-out 入口只取一次 `(generation, order, digest)` 快照；变体只推进本地副本，join 后按 `variant_index` 确定性收敛，真分叉才切代。T+1 是方案 A 明确接受的一次可预算 miss；无新分叉时 T+2 全体沿同一合并序收敛 |
| 技能正文编辑后重放 | 锚点只存 skill id；重放从 live registry 取编辑后的新正文，在历史中段静默以 v2 替换 v1，断裂从该技能消息开始 | 锚点携带正文 digest；不一致时 warn + skip，绝不拿新正文伪造旧历史。旧 v1 已不存在，所以该轮仍从原锚点位置断裂；收益是正确、显式且后续 omission 形态确定，而不是凭空恢复旧命中 |
| schema 跨窗口/环内刷新 | 单变体有窗口级 schema 字节冻结；多变体只有名字序治理，没有同一套 schema 字节冻结，schema 变化可在变体工具环中段打断 | 单、多变体统一走 `freeze_tool_face_for_prompt_cache`：名字序 append-only、窗口内 schema 字节冻结，并计算 digest。跨窗口仍有意采纳同名 schema 新字节，因此真实 schema 变更仍会在下一稳定窗口产生一次计划内断裂；digest 用于身份对账/共识落库，不伪装成永久字节冻结 |
| `available_skills` 目录首发 | 本地生成目录后 fire-and-forget 冻结 RPC，LLM 请求不等持久化裁决；并发窗口败方可能已经发出与最终 first-write-wins 权威不同的 system 字节 | `buildSendOptions` → `buildSystemPromptWithSkills` → `ensureAvailableSkillsSnapshotFrozen` 全链 await freeze；并发调用共享进行中的 Promise，后端返回的生效快照先回灌再放行。冻结失败 fail-closed，不发送未确认目录 |

## 1. 多变体：竞态血统改为方案 A 的确定性代际

设 fan-out 前共同基线为 `[A]`，T 轮两个变体分别披露 `X`、`Y`。

### 基座

```text
T:
  variant 0 发 [A,X] ─┐
                       ├─ 环内写共享基线，完成时序决定 [A,X,Y] 或 [A,Y,X]
  variant 1 发 [A,Y] ─┘

T+1（假设共享结果为 [A,X,Y]）:
  X 血统：旧 [A,X | system | history]
           新 [A,X,Y | system | history]
           首个分歧在 X 后原本应进入 system 的位置

  Y 血统：旧 [A,Y | system | history]
           新 [A,X,Y | system | history]
           首个分歧提前到 A 后的第一个新增工具位
```

因此 T+1 **必 miss 至少一侧**；合并序反过来时，受损血统也反过来。append-only 只能保证共享终态不删除、不重排已有条目，不能让互不为前缀的 `[A,X]` 与 `[A,Y]` 同时成为一个线性终态的前缀。基座若此后不再分叉也可能自然稳定，但没有确定性合并代际，也没有逐变体当轮字节快照，不能把这种稳定当作协议保证。

### 本枝

`multi_variant.rs` 的主 fan-out、retry batch 和单变体 retry 都在执行前统一载入快照；环内不再写共享基线。join 后，`helpers.rs::converge_session_tool_face_prefix` 按 `variant_index` 合并完整 `ToolFacePrefixSnapshot`：

1. `[A,X]` 与 `[A,Y]` 确认为真分叉；
2. 确定性得到 `[A,X,Y]`，并将 tool-face generation 加一；
3. 各变体自己的快照仍记录入口代号、`base_len`、本地 tail 与 schema digest，不把合并终态伪装成它在 T 轮实际发过的字节；
4. T+1 全部从 `[A,X,Y]` 起步。旧两条血统到新代的断裂不可消除，但位置、次数和新基线可推演；
5. T+1 建立新代缓存后，无新分叉时 T+2 继续使用同一工具面，完成收敛。

这里的“一次可预算 miss”不是命中率承诺，而是把不可避免的 T+1 重建从竞态事件改为显式、确定性的代际事件。

## 2. 技能正文编辑：仍断旧前缀，但不再伪造历史

基座按锚定 skill id 从当前 registry 重建历史技能消息。若历史当时发的是正文 v1，用户后来编辑为 v2，下一次重放会在历史中段直接发 v2：

```text
旧缓存：history_before | skill(v1) | history_after
基座重放：history_before | skill(v2) | history_after
                            ^ 首个断裂点；静默且语义上冒充旧历史
```

本枝在 turn 级和 tool 级锚点写入 `skill_body_digest(id, body)`，三个历史消费点统一过 `rebuild_anchored_skill_messages_gated_with_signal`。digest mismatch 时：

```text
本枝重放：history_before | <skip> | history_after
                            ^ 旧 v1 无法还原，断裂点仍在这里
```

这项改造首先是重放正确性修复：不存技能正文、不把 v2 伪装成 v1。skip 形态在正文持续不匹配时可重复，后续请求不再每次注入变化中的新正文；同时 mismatch 会声明 catalog pending generation。它不能让已经丢失的 v1 缓存后缀重新命中，故不能把“skip”写成命中率提升数字。

## 3. schema：统一窗口冻结与 digest，不承诺跨窗口永久不变

基座的单变体工具环已有局部 `frozen_tool_schemas`，但多变体路径主要冻结名字序；同一变体工具环内若 MCP 刷新或渐进披露带来同名 schema 新 JSON，多变体请求可从该 schema 字节处开始变化，其后的 system/history 一并失去旧前缀。

本枝把单变体、多变体初始注入和 `load_skills` 刷新统一到
`freeze_tool_face_for_prompt_cache`：

- 名字序：会话级 append-only；
- schema 序列化字节：稳定窗口内首见即冻结，环内后续刷新回写冻结副本；
- digest：对冻结窗口计算，写入变体快照；converge 只在“本地 order 等于收敛 order 且候选 digest 一致”时采纳为会话对账值。

边界必须保留：schema 字节副本不跨窗口持久化。下一稳定窗口若同名 schema 确实改变，本枝会采用新字节，断裂仍发生在该 schema 内；这是允许升级所需的计划内 miss。新机制消除的是多变体环内无统一字节冻结和跨窗口无身份信号，不是消除所有 schema 更新。

## 4. 目录首发：发送前取得唯一持久化权威

基座流程是：

```text
生成本地目录 D1 → 发起 freeze(D1) 但不等待 → 用 D1 发 LLM
```

若另一窗口先冻结 D2，后端最终权威是 D2，但前一窗口已经用 D1 发出；下轮从持久化 D2 恢复时，首个断裂位于 system 内目录。若 freeze 失败或进程在落库前退出，重启后按 live registry 重算也会产生同类断裂。

本枝流程是：

```text
生成候选目录 → await freeze → 取得后端 effective snapshot
             → 必要时回灌 effective → 才构造 system 并发 LLM
```

同进程并发发送复用同一个 in-flight freeze；跨窗口竞争由后端 first-write-wins 裁决，败方拿生效值后才发送。这样首条请求与 `session.metadata.availableSkillsSnapshot` 从一开始就是同一字节血统。RPC 失败直接中止发送，避免“请求已发、权威未定”的缓存孤枝。

## 5. 仍会断裂或仍不可观测的边界

| 遗留 | 静态后果 |
|---|---|
| **G3：整块 system + `user_profile`** | 上游仍把含 `user_profile` 等易变内容的 system 作为整块在尾部打断点，未拆稳定块与易变块。profile 任一字节变化，首个断裂就在 system 内；Anthropic 的 tools 独立断点或可保住工具段，但 system 及其后 history 仍 miss。 |
| **G-CC400** | CC 路径仍可能把 system content 数组及块级 `cache_control` 原样发往严格 OpenAI-compatible 端点；官方 DeepSeek V3.x 回落 CC 是确定性 400 风险面。这不是“缓存 miss”，而是请求在产生可计量命中前即失败，不能计入命中率收益。 |
| **`available_skills_delta` 未接线** | `generateAvailableSkillsDeltaPrompt` 已有局部原语，但发送路径没有生产消费方。原设计把新增目录信息放在当前 user 尾部、理论上不破坏历史前缀；当前未接线，所以这项“零前缀成本”收益尚不存在。 |
| **retry 的 `llm_content`** | retry 使用新 `user_message_id`，early persist 与后续 sidecar 保存都找不到原 user 块；实际 retry 包装不落库。下轮可能从原 sidecar/裸 UI content 重放，首个断裂位于该历史 user 消息。 |
| **multi_variant 的 `llm_content`** | fan-out 不走 `execute_internal` 的发送前 early persist，变体保存仍有崩溃窗口；若 provider 已收请求而 sidecar 未落库，后续重放从对应历史 user 消息处漂移。 |
| **指纹 scope：单变体每 turn 换 key** | `CHAT_V2_CACHE_DEBUG` 虽对 post-adapter 最终体分 `system/tools/history/current_user` 指纹，但 key 是 `session::variant`；单变体的 `variant_id` 通常是每 turn 新建的 assistant message id，跨 turn 常只有 `baseline`。这是观测盲区，不会直接制造 provider miss，却使该日志不能证明跨 turn 稳态命中。 |

## 最终判断

相对 `061b4815`，本枝把四类不可控断裂收窄为：

1. 多变体真分叉后的确定性单次换代与 T+2 收敛；
2. 技能正文不可还原时显式 skip、拒绝伪造；
3. schema 在稳定窗口内统一冻结、跨窗口用 digest 对账；
4. 目录首发在 freeze 权威确认后才发送。

但 G3、G-CC400、delta 未接线、retry/multi_variant `llm_content` 覆盖缺口和单变体指纹 scope 问题仍阻止把静态改善换算成实际命中率。**本文结论仅为静态推演，无运行时命中率。**

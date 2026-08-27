# Wave2-A r5 #8：技能 digest mismatch 的「需开新 prefix generation」信号

> 铁律遵守：未运行 cargo/npm/任何测试；未 git commit。
> 独占可写文件：`src-tauri/src/chat_v2/pipeline/history.rs`（最小改动）+
> `src-tauri/src/chat_v2/pipeline/helpers.rs`（仅新增一个记录函数）+ 本文档。
> 未触碰 tool_loop 准入 / types / repo / multi_variant / 前端。

## 背景与问题

r3 落地的 digest 门禁（`rebuild_anchored_skill_messages_gated`，见
`r3-skill-replay-gate.md`）在 history 重放时校验「当轮请求携带的技能正文
是否仍是锚定时刻的那份」：mismatch → warn + skip，绝不把编辑后的新正文
伪装成旧历史字节。

但 skip 只解决了「不伪造历史」。mismatch 本身意味着一个更硬的事实：

- 旧正文已经不存在（技能被编辑），该锚点位置**永远无法再还原旧字节**；
- 本轮起历史前缀在该位置**必然漂移**（技能消息整条消失），provider
  prompt cache 从该位置起已经断了；
- 同时，会话冻结的 `<available_skills>` 目录快照（first-write-wins）仍在
  描述编辑前的技能——若无人声明换代，会永远背着过期目录。

r3 只留了 warn 日志，没有任何结构化信号，调用方无从得知「该开新代了」。
本轮补上这个信号并接线到已有的换代机制。

## 接线决策：为什么不是 converge，而是 available_skills pending generation

任务卡允许两条路：「能接线 converge 就接；否则结构化计数/日志 + 文档」。
结论：**converge 不是正确的接线点，正确的代际是 available_skills 目录代**，
且后者已有现成原语可直接复用（属于「能接线就接」的接线，不是降级路径）。

| 候选 | 语义 | 判定 |
| --- | --- | --- |
| `converge_session_tool_face_prefix`（helpers） | 工具面（tools 槽）代际唯一切代点：fan-out 变体对 append-only 工具序产生**不可对齐真分叉**时 +1（r2-freeze-matrix 不变量） | ❌ 技能正文漂移是 **history 段**事件，与工具序无关。要逼 converge 切代必须伪造互斥的 variant order 输入——既破坏「唯一切代点 = 真分叉」的冻结矩阵不变量，切错的又是 tools 代而非受影响的前缀段 |
| `mark_session_available_skills_snapshot_stale_with_conn`（repo，R4-#6 compaction 已用） | 声明 `availableSkillsSnapshotPendingGeneration`（= 当前代 + 1）；前端下轮构建 system 时按 live registry 重新生成目录快照，经 freeze 原语作为新代 first write 兑现换代 | ✅ 技能被编辑 → 冻结目录描述的正是过期技能；且 mismatch 轮历史前缀已断，与 compaction 完全同构的**低成本换代时机**（增量损失只剩 system 段）。r5 #9 的 TauriAdapter 正是该 pending 标记的消费方，两席天然成对 |

## 实现

### 1. `history.rs`：门禁加信号出参（纯函数，不做 IO）

```rust
// 生产入口（新增）：门禁 + 信号出参
pub(super) fn rebuild_anchored_skill_messages_gated_with_signal(
    skill_ids: &[String],
    skill_contents: Option<&HashMap<String, String>>,
    anchors: Option<&SkillInjectionAnchors>,
    mismatched_skill_ids: &mut Vec<String>,   // 出参：按 skill_id 去重
) -> Vec<LegacyChatMessage>

// r3 三参签名保留为兼容薄包装（委托带信号版、丢弃信号）——
// 本文件内既有 skill_replay_gate_tests 与 r3 文档契约零改动
pub(super) fn rebuild_anchored_skill_messages_gated(...) -> Vec<LegacyChatMessage>
```

门禁判定逐字节不变（mismatch 的 warn 文案不变、skip 不阻塞不换序、
命中仍走 live 同一渲染函数）。唯一新增行为：**「锚点有 digest、正文
存在但字节漂移」时把 skill_id 追加进出参**（同一 skill 在 turn 级 +
多个 tool 级锚点重复 mismatch 时去重）。

信号边界（刻意收窄，只收确定性证据）：

| 场景 | 是否进信号 | 理由 |
| --- | --- | --- |
| digest mismatch（有 digest、正文存在、字节漂移） | ✅ | 确定性证据：旧字节永不可复原，前缀必漂移 |
| digest 命中重建 | ❌ | 无漂移 |
| 正文缺失（warn+skip 旧行为） | ❌ | digest 无从比较；r3 前语义即如此，不应触发换代 |
| 旧锚点无 digest（旧 JSON / `anchors=None`） | ❌ | 无证据；维持「有正文就重建」旧行为 |

### 2. `load_chat_history_pass`：趟内聚合、趟末一次记录

- 循环前声明 `let mut digest_mismatch_skill_ids: Vec<String>`；
- 三个消费点（turn 级 / tool 级命中 / tool 级兜底，即 r3 文档的
  159/327/358 三处）全部改调 `_with_signal` 版共享同一聚合出参；
- 消息循环结束（"Loaded N messages" 日志之后、microcompact 之前）非空
  即调 `self.record_skill_digest_prefix_generation_signal(&ctx.session_id, &ids)`。

外层 `while`（FIFO 前强制 compaction 触发重载）可能让本趟重跑 →
记录函数会被调两次：底层 mark 原语幂等折叠（已有有效 pending 时返回
既有值、不重复 +1），无重复换代。

### 3. `helpers.rs`：唯一新增记录函数（唯一写点）

```rust
pub(crate) fn record_skill_digest_prefix_generation_signal(
    &self,
    session_id: &str,
    mismatched_skill_ids: &[String],
)
```

行为顺序：

1. **结构化计数日志**（固定前缀 `skill_digest_generation_signal`，含
   session_id / mismatch_count / skill_ids，供日志侧聚合统计）——无论
   接线是否成功先落一条；
2. IMMEDIATE 事务内调
   `ChatV2Repo::mark_session_available_skills_snapshot_stale_with_conn`：
   - `Ok(Some(pending))` → info：pending generation 已声明；
   - `Ok(None)` → debug：会话从未冻结过目录快照，缺键语义本就是
     「下次按 live 建立」，无需换代，信号仅日志；
   - `Err` → warn：**降级为仅日志，绝不阻断发送**（与
     converge / store 写库失败同一降级纪律）。

不推进 `updated_at`（同 freeze/mark 原语）；不写任何技能正文
（`without_skill_contents` 隐私纪律不变）；不触碰任何进程内存锁
（函数体只做一次池连接 + 事务，锁序纪律无涉）。

第二个连接与在手 `conn` 并存的安全性：同函数内既有先例——
`resolve_microcompact_eligible_turns` 在 `conn` 持有期间同样经
`get_session_microcompact_anchor(&self.db, ...)` 取第二个池连接。

## 信号的消费方（调用链全景）

```
history 重放门禁检出 digest mismatch（本席，history.rs）
  → 趟末聚合 → record_skill_digest_prefix_generation_signal（本席，helpers.rs）
    → session.metadata.availableSkillsSnapshotPendingGeneration = 当前代 + 1
      （repo 既有原语，幂等；compaction R4-#6 同一标记，多来源折叠为一次换代）
      → 前端 TauriAdapter（r5 #9 席）：persisted 集合带 generation，
        看到 pending 时允许对该会话**再次** freeze——
        chat_v2_freeze_available_skills_snapshot → repo freeze 原语见有效
        标记才覆盖旧快照（唯一合法覆盖路径），generation 推进为 pending、
        标记清除。first-write-wins 不回退：无标记时冻结快照仍绝不覆盖。
```

即：**本席只生产信号 + 落标记；换代的兑现（新目录字节）由前端下轮
构建 system 时完成**——后端拿不到 live registry 目录字符串（渲染在前端
progressiveDisclosure.ts / skillRegistry），这与 compaction 换代的分工
完全一致（见 `r4-catalog-compaction.md`）。若 #9 尚未落地，标记会安静
地留在 metadata 中等待消费，freeze 原语的 first-write-wins 行为不受影响
（pending > generation 才生效，脏数据按无标记处理）。

## 与 tool_loop 准入的关系

零改动。信号不进入发送准入判断、不改变本轮请求的任何字节——本轮
history 视图仍按门禁 skip 后的形态发送（skip 后的视图是确定性的：
后续轮次同样 skip，同一形态自稳定）。换代只影响**下一轮** system 段
目录的重生成。

## 测试（只写不跑）

`history.rs::skill_replay_gate_tests` 新增
`gate_signal_collects_only_digest_mismatches_deduped`：

- mismatch 进信号、命中/缺正文/旧锚点不进；
- 同一 skill 跨锚点重复 mismatch 去重；
- 信号出参不改变 skip/重建结果（与三参兼容入口输出一致）。

既有测试零改动：r3 的两条门禁测试、`skill_replay_digest_tests.rs`
契约/反例、`helpers.rs` 重放一致性测试全部原样（兼容入口签名未动）。

## 新增符号清单

- `history.rs`：`rebuild_anchored_skill_messages_gated_with_signal`
  （原三参 `_gated` 降级为丢信号薄包装）；`load_chat_history_pass` 内
  聚合变量 + 趟末记录点。
- `helpers.rs`：`ChatV2Pipeline::record_skill_digest_prefix_generation_signal`
  （唯一新增函数，唯一写点）。
- 无新 metadata 键、无 schema/migration 改动（复用 R4-#6 的
  `availableSkillsSnapshotPendingGeneration`）。

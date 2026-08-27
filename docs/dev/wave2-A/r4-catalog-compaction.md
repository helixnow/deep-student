# R4-#6：compaction 落盘事务内的 available_skills 目录换代

> Wave2-A 第 4 轮 #6。可写面：`src-tauri/src/chat_v2/pipeline/compaction.rs`
> 及其直接调用的 repo 辅助（`repo.rs`）。未触碰 `TauriAdapter.ts`。

## 结论先行

- **事务函数**：`ChatV2Pipeline::persist_prepared_compaction`
  （`compaction.rs`，即 compaction 记录 / 摘要消息 / memory-flush 台账落盘的
  同一个 `conn.transaction()`）。
- **是否真的重生成了快照：否。** 后端拿不到 live registry 目录字符串
  （见下「缺口」），所以事务内写的是**显式换代标记**
  `availableSkillsSnapshotPendingGeneration`，快照本体由前端下一次构建
  system 时按 live registry 重新生成，并经既有 freeze 原语作为**新代
  first write** 冻结。first-write-wins 没有被静默覆盖——覆盖只能走
  换代键。

## 为什么 compaction 是零缓存成本的换代时机

会话请求的 prompt cache 前缀是 `system → tools → history`。
`availableSkillsSnapshot` 冻结的 `<available_skills>` 目录直接拼进 system
（第 0 字节前缀），平时任何按 live registry 的重算都会从第 0 字节打碎整段
缓存，这正是 first-write-wins 冻结存在的理由。

而 compaction 落盘后，`apply_compaction_view` 用摘要伪 user 消息替换掉
tail 起点之前的全部历史：下一轮请求里 system+tools 之后的字节必然全变，
provider 侧这段前缀缓存已经报废。此时顺带换掉 system 里的目录段，增量
损失只剩 system+tools 段本身；不换代则会话永远背着过期目录（中途
skill_install/卸载的技能永远不进目录）。所以换代标记与 compaction 记录
在**同一事务**提交：要么一起生效，要么一起回滚，不存在「压缩落盘了但
目录没声明换代」（或反之）的半提交状态。

## 缺口：后端为什么重生成不了快照本体

`<available_skills>` 目录字符串的唯一生产者在前端
`src/features/chat/skills/progressiveDisclosure.ts`
（`generateAvailableSkillsMetadata` + `skillRegistry`）：

- live registry 状态（哪些技能已注册/启用）只存在于前端进程内存；
- `disableAutoInvoke` 过滤、`requires` 门控缺失说明的渲染是前端逻辑；
- 每个 skill 的 `embeddedTools` 数量、描述、XML 转义（`escapeXmlAttr`）
  也都在前端。

后端 `src-tauri/src/chat_v2/skills.rs` 只是 SKILL.md 的文件系统处理器
（读/写/导入 zip），不解析 frontmatter 成 registry，更没有门控求值。让
后端影子实现一份渲染器意味着两处逐字节对齐的目录生成器——任何一字节漂移
都会打碎缓存且极难排查。因此后端只声明「该换代了」，不代产目录。

## 持久化契约（session.metadata，camelCase 键）

| 键 | 类型 | 语义 |
|---|---|---|
| `availableSkillsSnapshot` | string（既有） | 当前代冻结的目录字节；空串合法（安装前发过消息的会话冻结为无目录） |
| `availableSkillsSnapshotGeneration` | number，缺键=0 | 当前冻结快照所属代号。普通首冻**不写**该键（缺键即第 0 代，旧会话/升级前字节形态不变） |
| `availableSkillsSnapshotPendingGeneration` | number，缺键=无 | 待生效代号（= 写入时的当前代号 + 1）。仅由 compaction 落盘事务写入 |

常量定义在 `repo.rs`（`AVAILABLE_SKILLS_SNAPSHOT_GENERATION_METADATA_KEY`、
`AVAILABLE_SKILLS_SNAPSHOT_PENDING_GENERATION_METADATA_KEY`）。本轮独占面
不含 `types.rs`，如需与其他 metadata 键常量同址可后续迁移并 re-export。

### 状态机

```
无快照(缺键) ──freeze(首冻,gen=0)──▶ 冻结@gen G ──竞争 freeze──▶ 拒绝，返回已冻结值
                                        │
                              compaction 落盘事务
                    mark_..._stale_with_conn: pending := G+1
                              （幂等：已有有效 pending 不再 +1，
                               多次 compaction 折叠为一次换代）
                                        ▼
                               冻结@gen G + pending G+1
                                        │
                        前端下轮按 live registry 生成目录
                              freeze(catalog_live)
                                        ▼
                     冻结@gen G+1（快照覆盖，pending 清除）
                     —— 新代内 first-write-wins 立即恢复
```

- `mark_session_available_skills_snapshot_stale_with_conn`（repo）：
  从未冻结过快照的会话 no-op 返回 `None`（缺键语义本就是「下次按 live
  建立」）；有快照则写 `pending = generation + 1` 并返回它。
- `freeze_session_available_skills_snapshot_with_conn`（repo，语义扩展）：
  仅当存在**有效** pending（严格大于当前代号；脏数据按无标记处理）时才
  允许覆盖已冻结快照，同时 `generation := pending` 并删除 pending 键。
  其余路径与升级前逐字节等价（含空串合法快照、只 merge 相关键、不推进
  `updated_at`）。

### 不变量（负例测试保持）

- 无换代标记时，任何按 live 重算的写回（多窗口竞争、安装后追加）仍被
  first-write-wins 拒绝——既有测试
  `available_skills_snapshot_freeze_is_first_write_wins` 一字未动；
- 空串快照在无标记时不得追加目录；有标记时允许（新增互补正例
  `available_skills_snapshot_empty_freeze_then_compaction_marker_allows_catalog`）；
- 换代只 merge 目录相关三键，authority/plan/frozenToolSchemaOrder/
  microcompactAnchor 等其他 metadata 键原样保留；不扰动会话列表排序。

## 前端待接线（本轮不改 TauriAdapter.ts，留给 #5/#7 或下一轮）

当前前端行为不变：hydrate 后逐字节复用冻结快照，换代标记暂时只是落库
的哑数据，**不会造成任何行为回退**。要吃到换代收益需要：

1. session 加载 / 发送前读 metadata：若
   `availableSkillsSnapshotPendingGeneration > availableSkillsSnapshotGeneration ?? 0`，
   跳过内存快照与 hydrate 值，按 live registry 调
   `generateAvailableSkillsMetadata` 重新生成目录；
2. 调既有命令 `chat_v2_freeze_available_skills_snapshot`（后端 freeze
   原语已按代放行），用返回值回灌
   `hydrateSessionAvailableSkillsSnapshot`——多窗口竞争时新代内仍是
   first-write-wins，输家以返回值对齐；
3. 无需新增 Tauri 命令；`chat_v2_load_session` 带回的 session.metadata
   已含全部三键。

与 #7（`available_skills_delta` / 显式刷新代际设计）的关系：本文契约只
定义「何时允许换代 + 换代原子性」；delta 表达（换代后目录如何增量描述
新技能）归 #7，两者正交。

### 与 #7 设计稿（r4-catalog-delta.md 第 4 节）的两处偏离及理由

#7 定稿把落地归 #6，其草案是「compaction 同事务内按 live registry 重生成
目录 → 覆写 snapshot + 单键 `availableSkillsCatalogGeneration` +1，换代走
独立 repo API `refresh_session_available_skills_snapshot`」。实际落地偏离：

1. **事务内不重生成快照本体**：草案的「事务内重生成」在后端不可行
   （live registry 在前端，见上「缺口」）。于是单代号键拆成
   `...Generation`（已生效）+ `...PendingGeneration`（compaction 声明、
   前端消费）两键——换代的「声明」与「兑现」发生在两个进程、两个时刻，
   单键表达不了中间态。
2. **不新增独立 refresh API，扩展既有 freeze 原语**：草案要独立 API 是为
   防普通路径误覆写；本落地中覆写门闩是「存在有效 pending 标记」，而该
   标记只有 compaction 落盘事务能写，普通 first-write 路径无标记时行为
   与升级前逐字节一致，误覆写面为零。收益是前端零新命令：既有
   `chat_v2_freeze_available_skills_snapshot` 直接兑现换代。
   （pending 存在时任何 freeze 调用都会兑现新代——freeze 的调用方语义
   本就是「刚按 live registry 生成的目录」，兑现值恰为所需。）

#7 文档第 4 节如需与实现对齐，键名以本文为准
（`availableSkillsSnapshotGeneration` / `availableSkillsSnapshotPendingGeneration`）。

## 变更清单

- `src-tauri/src/chat_v2/pipeline/compaction.rs`
  - `persist_prepared_compaction` 事务内、`set_session_last_compaction_with_conn`
    之后调用 `mark_session_available_skills_snapshot_stale_with_conn`，
    带 info/debug 日志；标记失败即整个 compaction 事务回滚（原子性优先）。
- `src-tauri/src/chat_v2/repo.rs`
  - 新增两个 metadata 键常量与解析辅助；
  - 新增 `mark_session_available_skills_snapshot_stale_with_conn`；
  - `freeze_session_available_skills_snapshot(_with_conn)` 扩展为按代
    first-write-wins（见状态机）；
  - 新增测试：`available_skills_snapshot_explicit_generation_bump_via_compaction_marker`、
    `available_skills_snapshot_stale_marker_is_noop_when_never_frozen`、
    `available_skills_snapshot_empty_freeze_then_compaction_marker_allows_catalog`
    （按本轮红线只写源码未执行）。

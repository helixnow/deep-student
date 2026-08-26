# R4 #7 目录 delta 定稿：available_skills_delta（尾部瞬态）+ 显式刷新代际

- 基线：`cursor/0824-wave2-agent-cache-a875` tip `6069675e`。
- 作者：R4 子代理 #7（claude-fable-5-thinking-high）。
- 可写范围：`src/features/chat/skills/progressiveDisclosure.ts`（最小落地）+ 本文档。
  **未碰** `TauriAdapter.ts`（#5 独占）、`skills/index.ts`（不在可写清单）、
  后端 repo / compaction（#6 独占）。未执行 cargo/npm/测试，未 commit。

---

## 1. 问题

P0 冻结（R1/R2 已落地）把 available_skills 目录做成会话级 first-write-wins
快照：首次生成后冻结进 `session.metadata.availableSkillsSnapshot`，中途
`skill_install` 改写 live registry 也不重算——system 前缀字节由此恒定，
整段历史 prompt cache 得以存活。

代价：**会话中途安装的技能对模型完全不可见**。目录里没有它，模型不知道
它存在，连「调 load_skills 试试」的线索都没有；空目录冻结的会话（安装前
已发过消息）更是整个会话都拿不到任何技能。已加载状态有 tool result 和
瞬态技能消息兜底，但「可发现性」没有通道。

## 2. 定稿：双通道，delta 为主、代际为界

两个候选不是二选一，而是分工互补：

| 通道 | 时机 | 缓存成本 | 归属 |
|---|---|---|---|
| `available_skills_delta` 尾部瞬态块 | 每轮请求构建时 | 零（尾部必然新字节） | 本席，本轮落地 |
| 显式刷新代际（compaction 换代重生成目录） | compaction 落盘事务内 | 零（前缀本来就作废重建） | #6，本文只定稿键语义 |

delta 是常态通道：装完技能下一轮模型就能看到；代际刷新是收敛点：
compaction 后基线换成 live 全量目录，delta 自然收缩为空，尾部不会
无限增长。

## 3. available_skills_delta 设计

### 3.1 注入位置与生命周期

- **只允许**拼接在当前请求最后一条 user 消息尾部（与既有瞬态技能消息
  同位）。禁止写入 system，禁止插入历史中段。
- 请求构建时即时渲染，**不持久化进消息历史**。下一轮该 user 消息进入
  历史时不携带 delta——历史字节稳定，前缀 cache 不受影响。
- 每轮重算：继续安装则 delta 增长；显式换代后基线更新，delta 清空。
  轮与轮之间 delta 字节可变没有代价——最后一条 user 消息本来就是每轮
  的新字节区，任何 provider 的前缀 cache 都覆盖不到这里。

### 3.2 基线语义：解析冻结快照字节，不设第二个持久化键

基线 = 冻结快照字符串中**以可用状态列出**的技能 ID 集合
（`extractCatalogSkillIds`）。选择解析快照而非另存 ID 列表的理由：

- 快照字符串是持久化权威（repo first-write-wins + 重启 hydrate 回灌
  同一字节），解析它得到的基线跨重启、跨窗口天然一致，**零新增持久化
  键、零新增竞争面**；
- 若另存 ID 列表，就多出一个必须与快照原子同写的键，多窗口竞争下会
  出现「快照是 A 窗口的、ID 列表是 B 窗口的」撕裂态。

解析规则：

- `<skill id="..." tools="N">` 计入基线（id 经 `unescapeXmlAttr` 反转义，
  与生成侧 `escapeXmlAttr` 互逆）；
- `available="false"`（requires 门控）条目**不计入**基线——门控技能
  后续满足 requires 时应作为「新增可用」重新出现在 delta 中；
- 空串快照解析为空基线（合法：安装前发过消息的会话冻结为无目录，
  此后装的所有技能都走 delta 通道，正好修复该场景）。

### 3.3 delta 内容口径

`computeAvailableSkillsDelta` 的 added 过滤口径与
`generateAvailableSkillsPrompt` 可用段逐条一致：prompt 可见
（runtimeAdmission）+ 非 `disableAutoInvoke` + requires 满足，再减去
基线集合。顺序沿用 registry 顺序，同一轮内渲染确定。

- 会话尚未冻结快照 → 返回 `null`：首轮 system 目录本身就是 live 全量，
  delta 无语义；
- 门控中的新技能**不进** delta（列出来也只能标「不要加载」，纯噪声；
  满足 requires 后自然进入）。

渲染（`generateAvailableSkillsDeltaPrompt`）与冻结目录 `<skill>` 行同形
（同一套 escapeXmlAttr/escapeXmlText），尾注一句话指引仍走 load_skills。
无基线或无增量返回空串，调用方零拼接。

### 3.4 first-write-wins 自查

- delta 路径对快照 Map **只读**（直接 `sessionAvailableSkillsSnapshots.get`，
  刻意不调 `getSessionAvailableSkillsPrompt`——那会在未冻结时产生冻结
  副作用）；
- 不调用 `hydrateSessionAvailableSkillsSnapshot` / 后端 freeze 命令；
- repo 侧 `freeze_session_available_skills_snapshot` 及其三条测试
  （first-write-wins / 重启逐字节 / metadata 共存）语义零影响。

## 4. 显式刷新代际（设计定稿，落地归 #6）

- 新 metadata 键 `availableSkillsCatalogGeneration`（number，缺键视为 0），
  与 `availableSkillsSnapshot` 成对：**代际是唯一允许改写已冻结快照的
  显式换代键**，普通 freeze API 的 first-write-wins 不放松。
- 换代只发生在 compaction 落盘的同一事务内（前缀本来就作废重建的
  零成本时机）：按 live registry 重生成目录 → 覆写 snapshot + generation+1，
  同一 IMMEDIATE 事务，避免「目录新、代旧」撕裂。
- 换代走独立 repo API（如 `refresh_session_available_skills_snapshot`），
  不复用 freeze API——调用意图在类型层面区分，防止普通路径误覆写。
- 前端收到换代结果后用既有 `hydrateSessionAvailableSkillsSnapshot` 回灌
  新目录；delta 基线随之更新、自然清空，无需额外接口。

## 5. 本轮落地清单（progressiveDisclosure.ts）

| 符号 | 说明 |
|---|---|
| `AvailableSkillsDeltaEntry` / `AvailableSkillsDelta` | delta 类型 |
| `extractCatalogSkillIds(snapshot)` | 从冻结快照字节解析可用基线 ID 集 |
| `computeAvailableSkillsDelta(sessionId)` | 只读快照计算增量，未冻结返回 null |
| `generateAvailableSkillsDeltaPrompt(sessionId)` | 渲染尾部瞬态块，无增量返回空串 |
| `unescapeXmlAttr`（模块内私有） | escapeXmlAttr 逆操作，&amp; 最后替换防二次解码 |

未动项：`TauriAdapter.ts` 接线（含瞬态注入点，#5 独占本轮）、
`skills/index.ts` 再导出（不在可写清单，接线轮一并补）、后端换代 API
（#6）。既有导出符号、冻结/回灌/清除函数、订阅机制零改动。

## 6. 接线指引（后续轮）

发送路径在拼接瞬态技能消息处追加：

```ts
const deltaPrompt = generateAvailableSkillsDeltaPrompt(sessionId);
if (deltaPrompt) {
  // 拼到当前 user 消息尾部瞬态段，与已加载技能瞬态消息同位；不持久化。
}
```

顺序建议：瞬态技能指令在前（已加载技能的使用说明），delta 在后
（尚未加载技能的发现线索），避免模型把 delta 误读为已加载。

---

## 7. 勘误（R9 追记，§1–§6 原文保持不动）

### 7.1 §4 键名与换代 API 形态已被 R4 #6 实际落地取代

§4 所写「单键 `availableSkillsCatalogGeneration` + 独立 refresh API
（`refresh_session_available_skills_snapshot`）」是设计稿形态，**未按此落地**。
R4 #6 实际落地以 `docs/dev/wave2-A/r4-catalog-compaction.md` 与 repo 双键
（`src-tauri/src/chat_v2/repo.rs` 的
`AVAILABLE_SKILLS_SNAPSHOT_GENERATION_METADATA_KEY` /
`AVAILABLE_SKILLS_SNAPSHOT_PENDING_GENERATION_METADATA_KEY`）为准：

- `availableSkillsSnapshotGeneration`——已生效代号，缺键=0，普通首冻不写
  （旧会话字节形态不变）；
- `availableSkillsSnapshotPendingGeneration`——待生效代号，仅 compaction
  落盘事务写入；**pending 必须严格大于 generation 才允许覆盖**已冻结快照，
  `pending <= generation` 的脏数据视为无标记；
- **不新增独立 refresh API**：换代由既有 freeze 原语
  （`chat_v2_freeze_available_skills_snapshot`）在存在有效 pending 标记时
  兑现（generation := pending 并清除标记），普通 first-write-wins 路径行为
  与升级前逐字节一致。

拆两键的原因见 compaction 文档「两处偏离及理由」节：live registry 在前端，
compaction 事务内无法重生成快照本体，换代的「声明」（后端事务写 pending）
与「兑现」（前端重生成 + freeze）发生在两个进程、两个时刻，§4 的单代号键
表达不了中间态。

### 7.2 §5/§6 delta 发送路径——仍开

`generateAvailableSkillsDeltaPrompt` 仍未接到 `TauriAdapter.ts` / SendOptions
发送路径，§6 的接线片段至今没有消费方。该缺口**仍开，需 TS+Rust 对席**
（前端瞬态注入点 + 后端历史构建侧口径确认）一并收口。

# R4 复核 #9：目录原子首发（#5）/ compaction 换代键（#6）/ 目录 delta（#7）

- 复核人：R4 #9（claude-fable-5-thinking-high），只写本文档，未改产品代码，未 commit。
- 基线：`cursor/0824-wave2-agent-cache-a875` tip `6069675e` + 工作区未提交改动。
- 复核方式：逐行读三席位 diff（`TauriAdapter.ts`、`compaction.rs`、`repo.rs`、
  `progressiveDisclosure.ts`）与三份文档（`r4-catalog-atomic.md`、
  `r4-catalog-compaction.md`、`r4-catalog-delta.md`），交叉 grep 调用点与测试。
  按本轮红线未执行编译/测试。

## 结论速览

| 席位 | 判定 | 备注 |
|---|---|---|
| #5 TauriAdapter 原子首发 | **确认** | 8 调用点全部 await 核实；fail-closed 错误路径落在既有 catch；first-write-wins 无回退，反而更强 |
| #6 compaction 换代键 | **确认** | 换代标记与 compaction 同事务核实；无标记时 freeze 行为与升级前逐字节一致；既有负例测试一字未动 |
| #7 目录 delta | **确认**（代码）；**文档第 4 节需修订** | 解析器与生成器同形核对通过；快照 Map 只读核实；但 §4 键名/API 形态与 #6 实际落地不一致 |

无翻案。三处需注意的偏差/风险列在文末「遗留项」。

---

## #5 TauriAdapter 原子首发：确认

### 调用点覆盖（核实为「恰好 8 个，全部 await」）

grep `buildSendOptions(` 全仓：`TauriAdapter.ts` 内恰好 8 个调用点 + 定义本身，
无其他生产调用方（`chatInteractionTestPlugin.ts` 仅注释提及）。8 处均已改为
`await this.buildSendOptions(...)`，对应函数逐一核对为 `sendMessage`（:2676）、
`executeWakeSession`（:2867）、`executeSendMessage`（:2917）、`executeRetry`
（:3249）、`executeEditAndResend`（:3438）、`continueMessage`（:3582）、
`executeRetryVariant`（:4190）、`executeRetryAllVariants`（:4245），与文档所列
一致。`buildSystemPromptWithSkills` / `ensureAvailableSkillsSnapshotFrozen`
无 `buildSendOptions` 之外的调用方——不存在绕过冻结闸的发送路径。

### fail-closed 错误路径（确认可复位）

`ensureAvailableSkillsSnapshotFrozen` 抛错沿 `buildSystemPromptWithSkills →
buildSendOptions` 冒泡。抽查 `executeRetry`：`buildSendOptions` 调用在 try 块内，
catch 分支调用 `clearStreamExpectation(messageId)` 复位流状态后再抛——文档
「由既有 catch 复位 streaming 状态」的说法成立。注意 `executeRetry` 等路径在
`buildSendOptions` 之前已调 `beginStreamExpectation`，正是 catch 里的 clear
在兜底，链路闭合。

### 多窗口竞争 / first-write-wins：无回退

- 后端 `chat_v2_freeze_available_skills_snapshot` 语义未被 #5 触碰（本轮它被
  #6 扩展，见下节，但普通路径逐字节等价）。
- 旧实现的两个窗口（持久化失败静默发送、回灌晚到）确实被关闭：await 生效值
  后才构建 system，竞争输家的**第一条**请求即用 first-write-wins 生效字节，
  比旧的「.then 异步回灌、下一条才对齐」更强。这是增强，不是回退。
- 并发发送共享 inflight Promise：核实 `freeze.finally(...)` 清句柄 +
  `.catch(() => {})` 防派生链 unhandled rejection 的写法正确；原 Promise 的
  拒绝由每个 await 方的 try/catch 消费。存在一个极窄的微任务窗口（finally
  已删句柄、await 续体尚未把 session 加入 persisted 集合，恰有新发送同步进入）
  可能触发一次冗余冻结 RPC——后端幂等返回已冻结值，无正确性影响，不构成问题。
- `loadSession` 回灌路径同时标记 persisted 集合（:3738-3740），回灌值来自持久化
  权威，跳过 RPC 合理。

### 需留意（非翻案）

1. **persisted 集合与内存 Map 清理不同步**（#5 文档已自曝）：
   `clearSessionAvailableSkillsSnapshot` 只清 `progressiveDisclosure.ts` 的
   Map。当前 grep 证实该函数生产代码无调用方（仅测试），风险是潜伏的：若未来
   某路径清 Map 而 persisted 集合仍含该 session，下次发送会按 live registry
   重新生成目录并**跳过冻结直接发出**——恰好绕开本轮建立的不变式。接线轮如引入
   清理调用，必须同步清 persisted 集合。
2. **「所有窗口收敛」不变式在 #6 落地后需加代际前提**，见下文「跨席位交互」。

---

## #6 compaction 换代键：确认

### 事务原子性（核实）

`mark_session_available_skills_snapshot_stale_with_conn` 的调用点在
`persist_prepared_compaction` 内、`set_session_last_compaction_with_conn` 之后、
`tx.commit()` 之前（compaction.rs :1114-1126），传入 `&tx`，与 compaction 记录/
摘要消息/memory-flush 同事务提交。标记读的是同事务内 set_last_compaction 之后
的 session 行，无自我覆写。标记失败 `?` 使整个 compaction 回滚——「原子性优先」
是可辩护的取舍（换代标记丢失的代价是会话永久背过期目录），且已文档化。

### freeze 原语扩展：first-write-wins 未被静默破坏（核实）

- 覆盖门闩是 `effective_pending = pending.filter(|p| *p > generation)`，严格
  大于，脏数据（pending <= generation）按无标记处理；
- **无标记时**：已冻结（含空串）绝不覆盖、返回持久化权威值——与升级前逐字节
  等价；普通首冻不写代号键（缺键即第 0 代），旧会话 metadata 字节形态不变；
- 既有负例测试 `available_skills_snapshot_freeze_is_first_write_wins`（:4931）
  与 `..._survives_process_restart...`、`..._preserves_other_session_metadata`
  在 diff 中零改动，红线达成；
- 新增三条测试覆盖了换代主链路、never-frozen no-op、空串快照换代后允许出目录
  （与既有负例互补，证明覆盖只能走显式换代键）。测试内还断言了幂等折叠
  （消费前多次 compaction 不重复 +1）与其他 metadata 键保留。
- `update_session_with_conn` 写的是同事务内刚读出的 `session.updated_at`
  原值（repo.rs :475-505，不取 now）——「故意不推进 updated_at」的说法核实成立。

### 「后端不重生成快照本体」的论证：成立

核对 `src-tauri/src/chat_v2/skills.rs` 定位与 `progressiveDisclosure.ts`：
registry 状态、`disableAutoInvoke` 过滤、requires 门控、`escapeXmlAttr` 渲染
确实全在前端，后端影子渲染器意味着两处逐字节对齐，任何漂移打碎缓存且难排查。
「事务内只写换代声明、前端经既有 freeze 原语兑现」是正确的工程取舍，且避免了
新增 Tauri 命令。

---

## #7 目录 delta：代码确认；文档 §4 与 #6 键名不对齐

### 键名对齐检查（任务卡专项）：**不对齐，以 #6 实现为准**

- #7 文档（`r4-catalog-delta.md` 第 4 节）写的是：单键
  `availableSkillsCatalogGeneration`、compaction **事务内重生成**目录本体、
  独立 repo API `refresh_session_available_skills_snapshot`。
- #6 实际落地（repo.rs，已进代码）：双键
  `availableSkillsSnapshotGeneration` + `availableSkillsSnapshotPendingGeneration`、
  事务内只写待换代标记、**扩展既有 freeze 原语**而非新 API。
- #6 文档已用一整节记录两处偏离及理由（后端拿不到 live registry → 单键表达
  不了「声明/兑现分属两进程两时刻」的中间态；覆盖门闩使独立 API 失去必要性），
  并声明「#7 第 4 节如需对齐，键名以本文为准」。两个理由我核对后均成立。
- **但 #7 文档本体未回改**。代码层无冲突（#7 的 delta 代码不读不写任何代际键；
  前端目前也没有 generation 键常量），风险纯在文档：后续接线者若照抄 #7 §4
  的 `availableSkillsCatalogGeneration` 会读错键、或去找不存在的 refresh 命令。
  **建议 #10（ledger）或下一轮在 #7 §4 顶部加一行指针「本节已被 #6 实现取代，
  键名与 API 形态见 r4-catalog-compaction.md」**。

### delta 代码正确性（核实通过）

- **first-write-wins 自查属实**：`computeAvailableSkillsDelta` 直接
  `sessionAvailableSkillsSnapshots.get`（同模块私有 Map），未调用会产生冻结
  副作用的 `getSessionAvailableSkillsPrompt`，未调用 hydrate / 后端 freeze。
  grep 证实两个新导出目前零调用方——「本轮不接线」与宣称一致。
- **解析器与生成器同形**：生成侧可用行 `<skill id=".." tools="N">`、门控行
  多出 `available="false" reason="..."`（:596/:608）。正则
  `/<skill\s+([^>]*?)\/?>/g` + `\bavailable="false"` 排除 + `\bid="([^"]*)"`
  提取：因 `escapeXmlAttr` 转义 `"` `<` `>`、`escapeXmlText` 转义 `<`，属性值
  内不可能出现裸 `id="` 或 `available="false"` 字面量，描述文本行不可能出现
  `<skill`，无误判面。`</skill>` 闭合标签因 `\s+` 要求不会匹配。
- **unescapeXmlAttr 与 escapeXmlAttr 互逆**：`&amp;` 最后替换，与转义侧
  `&` 最先替换镜像；手工验证 `&lt;` → `&amp;lt;` → `&lt;` 回环正确。
- **口径一致**：added 过滤链 `isSkillPromptVisible → !disableAutoInvoke →
  isSkillRequiresSatisfied` 与 `generateAvailableSkillsPrompt` 可用段（:573-583）
  逐条同序；门控条目不入基线 → 满足 requires 后进 delta，与文档语义吻合。
- 未冻结返回 null、空串快照为空基线、无增量返回空串——边界与文档一致。

---

## 跨席位交互（复核新增观察，三份文档均未完整覆盖)

**#5 的 persisted 集合与 #6 的 pending 标记组合行为**：

1. 窗口一旦进入 persisted 集合（首冻成功或 loadSession 回灌），本进程内**永不
   再调 freeze**。因此 compaction 写下的 pending 标记在当前前端（未接线）几乎
   不会被消费——这与 #6「换代标记暂时只是落库的哑数据」的宣称一致，无行为回退。
2. 存在一条 rare 的**意外消费路径**：某窗口在会话首冻**之前**加载过它（metadata
   无快照键 → 未回灌、不在 persisted 集合），而它的首次发送发生在另一窗口
   首冻 + compaction 换代声明**之后**——此时它的「普通首冻」会命中有效 pending，
   作为新代 first write 覆盖旧快照。语义上无害甚至正确（该窗口的快照恰是按
   live registry 生成的目录，正是换代想要的兑现值），但副作用是：**已在
   persisted 集合中的老窗口继续用旧代字节发送**，与持久化权威分叉，直到它
   重新 loadSession。#5 的不变式「多窗口收敛到 first-write-wins 生效值」在
   #6 落地后应加限定：**代内收敛**；跨代收敛要等接线轮让发送路径重读
   generation/pending。
3. 接线轮消费 pending 时注意与 #5 的状态表交互：兑现新代后需刷新
   persisted 集合语义（当前集合语义是「已确认某一代」，没有代号维度），否则
   兑现窗口自己也不会再发 freeze。建议届时把集合升级为 `Map<sessionId, generation>`
   或在检测到 pending 时主动失效对应表项。
4. #7 delta 基线解析的是本窗口内存快照字节：换代兑现 + 回灌后基线自动换新、
   delta 收缩为空——两机制正交衔接，设计自洽，无需额外接口，确认 #7 文档
   第 2 节的分工表述。

## 遗留项（建议 #10 记入 ledger）

1. **#7 文档 §4 修订**：键名与 API 形态以 #6 实现为准，加指针防接线者读错键
   （文档债，非代码缺陷）。
2. **接线轮双注意**：消费 pending 时处理 #5 persisted 集合的代号盲区（上节
   第 3 点）；若引入 `clearSessionAvailableSkillsSnapshot` 生产调用，同步清
   persisted 集合。
3. **未验证项声明**：按红线未跑 `cargo test` / vitest / tsc。#5 的 async 化
   涉及 8 个调用点签名变化，#6 新增三条 Rust 测试仅源码级核对——下一个允许
   执行的轮次应优先跑 `chat_v2::repo` 测试与前端类型检查。

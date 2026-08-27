# R5-#9：TauriAdapter 消费 available_skills 换代标记（pending generation）

> Wave2-A 第 5 轮 #9 leftover。可写面：`src/features/chat/adapters/TauriAdapter.ts`
> 的 availableSkillsSnapshot 相关段 + 本文档。按红线未跑 tsc/vitest，未 commit。
> 上游契约：`r4-catalog-compaction.md`（#6，后端双键 + freeze 原语按代放行）；
> 接线注意事项来源：`r4-review-frontend.md`「跨席位交互」第 3 点与遗留项 2。

## 结论先行

R4-#6 落库的 `availableSkillsSnapshotPendingGeneration` 从「哑数据」变为前端
可消费信号：

- **persisted 集合带代号**：模块级 `Set<sessionId>` 升级为
  `Map<sessionId, { generation, pendingGeneration? }>`，即 r4-review-frontend
  建议的 `Map<sessionId, generation>` 形态——「已确认」不再是无代号的布尔事实。
- **见到有效 pending 时允许再 freeze 兑现换代**：发送路径不复用冻结的
  内存/回灌字节，改按 live registry 重新生成目录，再调既有
  `chat_v2_freeze_available_skills_snapshot`（后端在有效 pending 存在时放行
  覆盖并 `generation := pending`、清标记），该次写入即新代 first write。
- **普通路径不回退**：无 pending 时行为与 R4 逐字节一致——已确认即复用、
  绝不重复冻结、绝不按 live 重算。既有 first-write-wins 不变式原样保持。
- 无新增 Tauri 命令、无后端改动（#6 已备好原语）；改动集中在三处：
  模块级状态表、`loadSession` 回灌段、`ensureAvailableSkillsSnapshotFrozen`。

## 变更清单（均在 `TauriAdapter.ts`）

1. **模块级状态**（原 `persistedAvailableSkillsSnapshotSessions` 一段）
   - `persistedAvailableSkillsSnapshotGenerations: Map<string, AvailableSkillsSnapshotPersistedState>`，
     条目 = `{ generation: number; pendingGeneration?: number }`；
   - 新增两个 metadata 键常量
     `AVAILABLE_SKILLS_SNAPSHOT_GENERATION_METADATA_KEY` /
     `AVAILABLE_SKILLS_SNAPSHOT_PENDING_GENERATION_METADATA_KEY`，字符串与
     后端 `repo.rs` 常量逐字对齐（#6 文档明确前端对齐字面量即可；本轮独占面
     仅本文件，不动 `progressiveDisclosure.ts`，后续如统一可迁过去）；
   - 新增解析辅助 `readAvailableSkillsSnapshotGeneration`（缺键/类型不符 = 0，
     与后端同语义）与 `readAvailableSkillsSnapshotPendingGeneration`
     （仅 `pending > generation` 才有效，脏数据按无标记处理——**镜像后端
     freeze 原语的 effective_pending 门闩**，保证前端不会在后端必然拒绝
     覆盖的场景下白白按 live 重算）。
   - `inflightAvailableSkillsSnapshotFreezes` 保持不变（共享 inflight Promise
     语义对换代路径同样成立，见下「并发」）。
2. **`loadSession` 回灌段**
   - 原样 hydrate 冻结快照字节（兑现前旧代字节仍是持久化权威，后端尚未
     覆盖，禁止此处按 live 重算——与 P0 跨进程约束一致）；
   - 从同一份 `session.metadata` 解析 generation 与有效 pending 写入状态表。
     `chat_v2_load_session` 本就带回全部三键（#6 文档「前端待接线」第 3 点），
     零新增 RPC。
3. **`ensureAvailableSkillsSnapshotFrozen`（发送等待点）**
   - 快路径：有确认记录且无 pending → 逐字节复用（R4 行为，字节不变）；
   - 冻结路径二分：无确认记录 → 普通首冻（内存字节，gen 0 语义、失败重试
     同字节，与 R4 一致）；有有效 pending → `generateAvailableSkillsPrompt()`
     按 live registry 重新生成作为新代快照；
   - 成功后 `generation := pendingGeneration ?? 原值 ?? 0` 并清 pending；
     换代路径**无条件**以 freeze 返回的生效值回灌内存（内存里还是旧代
     回灌字节；赢家生效值 = 刚生成的 live 目录，输家 = 抢先窗口的新代
     冻结值），普通路径维持「仅 effective ≠ snapshot 时回灌」不变；
   - fail-closed 策略不变：冻结失败抛错中止发送。换代路径失败时
     pendingGeneration 不清除（只在兑现成功后清），下次发送重新按 live
     生成再试，**换代意图不丢**；且旧代内存字节未被污染。

## 状态机（前端视角，衔接 #6 后端状态机）

```
表缺项 ──loadSession(metadata 无快照键)──▶ 仍缺项 ──首次发送──▶ 普通首冻(gen 0 语义)
表缺项 ──loadSession(快照@G, 无有效 pending)──▶ {generation:G} ──发送──▶ 复用字节，零 RPC
表缺项 ──loadSession(快照@G, pending P>G)──▶ {generation:G, pending:P}
                                                   │ 发送
                                                   ▼
                     live 重新生成 → freeze（后端放行覆盖，新代 first write）
                                                   │ 成功
                                                   ▼
                              {generation:P}，内存回灌生效值
                     （失败：状态表不动，fail-closed 中止；下次发送重试兑现）
```

## 不变量核对

- **first-write-wins 普通路径不回退**：进入「再 freeze」的唯一门是
  `pendingGeneration !== undefined`，而它只可能来自 loadSession 解析出的
  有效 pending 键——该键只有 compaction 落盘事务会写。无标记时冻结字节的
  复用、inflight 共享、竞争输家回灌逻辑与 R4 版逐行等价。
- **双保险**：即使前端状态表被意外污染（幻影 pending），后端 freeze 原语
  的覆盖门闩独立判断——无有效 pending 时拒绝覆盖并返回已冻结值，前端
  随即回灌生效值对齐。最坏结果是一次多余的目录重算 + 一次幂等 RPC，
  持久化权威不可能被普通路径覆写。
- **空串快照**：`generateAvailableSkillsPrompt()` 可能返回空串（无可见
  技能），作为新代快照冻结合法（#6 空串语义 + 互补正例）；反向（空串
  旧快照 + pending → 兑现出目录）正是 #6 测试
  `..._empty_freeze_then_compaction_marker_allows_catalog` 覆盖的场景。

## 并发与跨窗口

- **同窗口并发发送**（多变体重试等）：共享同一 inflight freeze Promise。
  各 caller 在入口各自读同一状态表条目，看到相同 pending；后完成者对
  状态表/内存的写入与先完成者相同，幂等。极窄的 finally 已删句柄窗口
  与 R4 相同（后端幂等，无正确性影响）。
- **多窗口换代竞争**：两窗口都见到 pending P → 各自按本窗口 live registry
  生成目录并 freeze。后端第一个到达者兑现（`generation := P`、清标记），
  第二个退化为新代内 first-write-wins 拒绝、返回赢家字节，前端回灌对齐。
  两窗口记录的 generation 同为 P，与后端一致。
- **代内收敛，跨代收敛仍需 reload**（r4-review-frontend「跨席位交互」
  第 2 点的限定在本轮依旧成立）：pending 的唯一检测点是 loadSession——
  后端没有 compaction 成功的 session 事件（只有 `compaction_failed` /
  `context_trimmed`），本轮不新增事件面。因此**会话中途**发生的 compaction
  要等该窗口下次 loadSession 才见到 pending；已加载的老窗口在此之前继续
  用旧代字节发送。这与 #6「换代前旧字节仍是冻结权威」语义兼容：晚兑现
  只是晚享收益（继续背过期目录），不产生错误覆盖。review 描述的 rare
  「意外消费路径」（未回灌窗口的首冻恰好命中 pending）在本轮成为**设计内
  路径**：其首冻字节正是按 live 生成的目录，恰为兑现值。

## 遗留项

1. `clearSessionAvailableSkillsSnapshot`（progressiveDisclosure）仍只清
   内存 Map、不清本状态表（r4-review-frontend 遗留项 2 后半）。当前生产
   代码零调用方，风险维持潜伏级；引入生产调用时必须同步
   `persistedAvailableSkillsSnapshotGenerations.delete(sessionId)`，否则
   会出现「内存无快照但状态表已确认」→ 按 live 重生成后**跳过冻结**发送。
   本轮不可写 `progressiveDisclosure.ts`，未动。
2. 若后续希望 compaction 后**同会话不 reload 即兑现**，需要后端在
   compaction 成功时发 session 事件（或手动压缩响应带回 metadata），
   前端在事件处理里更新状态表 pending——事件面改动超出本轮独占面。
3. 键常量目前定义在消费点（`TauriAdapter.ts`）；与
   `AVAILABLE_SKILLS_SNAPSHOT_METADATA_KEY` 统一收口到
   `progressiveDisclosure.ts` 留给可写面覆盖该文件的轮次。
4. **未验证声明**：按红线未执行 tsc / vitest / 任何构建。改动为 TS 源码级
   自查（引用点 grep 全量替换核对、`strict:false` 主 tsconfig 下无
   exactOptionalPropertyTypes 顾虑）。下一个允许执行的轮次建议跑前端
   类型检查与 `chat_v2::repo` 测试（连同 R4 积欠）。

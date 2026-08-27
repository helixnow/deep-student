# R4 目录原子化：available_skills 快照持久化成功后再发请求

日期：2026-08-26
范围：`src/features/chat/adapters/TauriAdapter.ts`（独占），仅 availableSkillsSnapshot 段
与 send 调用链。不涉及移动热区 class、桌面 Composer 行为、`progressiveDisclosure.ts`。

## 问题

`buildSystemPromptWithSkills` 在「首次无快照」路径生成目录后，通过
`persistAvailableSkillsSnapshot` fire-and-forget 冻结进 session.metadata，随后
**立刻**把内存目录拼进 system 发出。存在两个窗口：

1. **持久化失败静默**：冻结 RPC 失败只打 warn，第一条请求已带内存目录发出。
   应用重启后 metadata 缺键 → 按当时 live registry 重算 → 同一会话 system 从第
   0 字节变，打碎整段 provider prompt cache（P0 快照机制想避免的正是这个）。
2. **first-write-wins 回灌晚到**：多窗口竞争时后端返回更早冻结的生效值，异步
   `.then` 回灌内存前，本窗口第一条请求可能已用本地生成的不同字节发出。

## 方案

「首次无快照」路径改为 **await 冻结成功（或拿到 first-write-wins 回灌值）后
才进入 LLM 请求**。

### 发送等待点（函数名）

- **`ensureAvailableSkillsSnapshotFrozen()`** —— 实际等待点（新增，替代原
  `persistAvailableSkillsSnapshot`）。await 后端
  `chat_v2_freeze_available_skills_snapshot`，成功后返回生效目录字节。
- 由 **`buildSystemPromptWithSkills()`**（改为 async）await 调用；
- 后者由 **`buildSendOptions()`**（改为 async，`systemPromptOverride` 处 await）
  调用；
- `buildSendOptions` 的全部 8 个调用点补 `await`，均位于各 send/retry 入口的
  `invoke(chat_v2_*)` 之前：`sendMessage`、`executeWakeSession`、
  `executeSendMessage`、`executeRetry`、`executeEditAndResend`、
  `continueMessage`、`executeRetryVariant`、`executeRetryAllVariants`。

即：任何会产生 LLM 请求的路径，都在构建 SendOptions 时被冻结确认闸住。

### 持久化确认状态（模块级）

- `persistedAvailableSkillsSnapshotSessions: Set<sessionId>` ——
  后端已确认写入。两个来源：首次发送 await 冻结成功；`loadSession` 从
  session.metadata 回灌（回灌值本身来自持久化权威，直接标记，不再发 RPC）。
- `inflightAvailableSkillsSnapshotFreezes: Map<sessionId, Promise<string>>` ——
  冻结 RPC 进行中，并发发送（多变体重试等）共享同一 Promise，避免重复 RPC。
  settle 后清除。

模块级而非实例字段：适配器重建（切会话再回来）不丢「已确认」事实，与
`progressiveDisclosure.ts` 的内存快照 Map 生命周期对齐。

### first-write-wins（保持）

后端语义不变。await 返回的生效值若与本地生成字节不同（多窗口竞争、本窗口
后到），用 `hydrateSessionAvailableSkillsSnapshot` 回灌内存，并以**生效值**
构建本次 system —— 第一条请求即与持久化权威逐字节一致，不再有回灌晚到窗口。
重试冻结时发送的仍是内存快照的同一字节，后端幂等返回已冻结值。

## 失败策略：fail-closed（不发）

冻结 RPC 失败时 `ensureAvailableSkillsSnapshotFrozen` 抛错（消息含
`fail-closed` 与底层错误），中止本次发送：

- 错误沿 `buildSendOptions` 冒泡到各 send/retry 入口的**既有** try/catch，
  由其复位 streaming 状态并向用户报错，无需新增错误处理面。
- 不带未持久化的目录发请求，杜绝「发了但没冻住」→ 重启后 system 变字节。
- **可恢复**：内存快照保留原字节，inflight 句柄在 settle 时清除，下次发送以
  同一字节重试冻结；重试不改变目录内容（目录仍是首次生成的冻结字节）。

选 fail-closed 而非降级发送的理由：该快照是 system 第 0 字节前缀的持久化
权威，降级发送等于把 R1/P0 防的缓存击穿窗口重新打开；冻结 RPC 只是一次本地
sqlite 元数据写，失败罕见且重试成本低（用户重发即可）。

## 不变式

- 会话内目录字节恒定（首次生成即冻结，中途 skill_install 不改已发 system）。
- 第一条 LLM 请求发出时，其目录字节 == session.metadata 持久化值（本轮新增）。
- 多窗口竞争下所有窗口收敛到后端 first-write-wins 生效值。
- 空目录（''）同样冻结与确认，语义与此前一致。

## 已知边界

- `clearSessionAvailableSkillsSnapshot`（会话删除/测试）只清
  `progressiveDisclosure.ts` 的内存 Map，不清本文件的 persisted 集合。会话 id
  为 UUID 不复用，集合只增长少量字符串，无正确性影响；若未来复用 id 需同步清理。
- 验证约束：本轮禁止 cargo/npm/测试，未运行编译与测试；改动为纯 TS 层
  async 化 + 状态表，8 个调用点均已在 async 函数内且原本就有后续 await。

# WI-12：Session JSONL 导出格式规范 v1

> 状态：Implemented（R4 落地：`export_session_jsonl` 实现 + 单测 +
> Tauri command `chat_v2_export_session_jsonl`；实现报告见
> `progress/R4-WI-12-impl.md`）  
> Schema 版本：`1`  
> 负责模块：`src-tauri/src/chat_v2/session_export.rs`  
> 数据来源：`chat_v2.db`（`ChatV2Repo` / `ChatV2Database`）

## 1. 背景与目标

初始调研（`INITIAL-RESEARCH.md`）确定 WI-12 为「session replay」补齐项：
成熟 agent 运行时（Claude Code、pi 等）均以 **一行一个 JSON 对象的 JSONL 文件**
持久化会话时间线，天然支持流式追加、`jq`/`grep` 检索、断点续读与跨工具互操作。

deep-student 当前会话数据分散在 `chat_v2.db` 三张表
（sessions / messages / blocks）+ 会话状态表 + 压缩记录表中，
只能通过 SQLite 直接访问，无法：

1. **离线调试 / 回放**：把一次多轮 agent run 完整带走，在无 DB 环境下重演；
2. **外部分析**：token 消耗、工具调用成功率等指标用脚本直接统计；
3. **用户数据可携带**：导出即备份，未来可支持导入。

**仍属非目标**：导入（import）、回放执行器（replayer）、前端导出 UI
（R4 已落地导出实现 + Tauri command，其余另行排期）。

## 2. 文件约定

| 项 | 约定 |
| --- | --- |
| 编码 | UTF-8，无 BOM，行分隔符 `\n`（LF） |
| 行格式 | 每行恰好一个 JSON object，行内不含裸换行（字符串内换行由 JSON 转义承载） |
| 扩展名 | `.jsonl` |
| 建议文件名 | `session-{sessionId}-{exportedAt:yyyyMMddTHHmmssZ}.jsonl` |
| 字段命名 | camelCase，与前端 Store 契约一致（直接复用现有 serde 序列化，见 §4） |
| 时间 | 结构体内保持原类型：`ChatSession` 用 ISO 8601 UTC，消息/块用 ms epoch |

## 3. 记录封套与行序

每行是一个带 `type` 判别字段的记录。**消费者必须跳过未知 `type` 与未知字段**
（前向兼容）；`schemaVersion` 只在 header 声明一次，消费者应先读首行。

行序为固定状态机（正则表示）：

```
header (message block*)* compaction* footer
```

- `message` 按 `timestamp` 升序（与 `ChatV2Repo::get_session_messages_with_conn`
  的 `ORDER BY time_created` 一致）；
- 每条 `message` 之后紧跟它的全部 `block` 行，按 `block_index` 升序
  （块的**权威显示顺序**仍以 `message.blockIds` / `variant.blockIds` 为准，见 §5.3）；
- `footer` 必须是最后一行，用于完整性校验。

### 3.1 `type: "header"`（首行，恰好 1 条）

```json
{"type":"header","schemaVersion":1,"exportedAt":"2026-08-24T02:00:00Z","generator":{"app":"deep-student","version":"0.9.x"},"options":{"includeAllVariants":true,"includeSessionState":true,"includeCompactions":true,"redactSecrets":true},"session":{"id":"sess_…","mode":"general_chat","title":"…","persistStatus":"active","createdAt":"…","updatedAt":"…","metadata":{…},"tags":["…"]},"state":{"sessionId":"sess_…","chatParams":{…},"features":{…},"updatedAt":"…"}}
```

- `session`：`types::ChatSession` 的 serde 序列化原样嵌入；
- `state`：`types::SessionState`（可选，`includeSessionState=false` 或无状态时省略）；
- `options`：导出参数回显，便于消费者判断文件语义（如是否已裁剪变体）。

### 3.2 `type: "message"`（0..N 条）

```json
{"type":"message","message":{"id":"msg_…","sessionId":"sess_…","role":"assistant","blockIds":["blk_a","blk_b"],"timestamp":1756000000000,"parentId":null,"supersedes":null,"_meta":{"modelId":"…","usage":{…},"contextSnapshot":{…}},"attachments":[…],"activeVariantId":"var_1","variants":[{"id":"var_1","modelId":"…","blockIds":["blk_a","blk_b"],"status":"success","createdAt":…,"usage":{…}}]}}
```

- `message`：`types::ChatMessage` 的 serde 序列化原样嵌入
  （含 `_meta`、`attachments`、`variants`、`sharedContext` 等全部可选字段）；
- `role` 仅 `user | assistant`（`types::MessageRole`）；
- 编辑/重试分支通过 `parentId` / `supersedes` 保留，导出不做线性化。

### 3.3 `type: "block"`（每条 message 后 0..M 条）

```json
{"type":"block","messageId":"msg_…","block":{"id":"blk_…","messageId":"msg_…","type":"mcp_tool","status":"success","toolName":"todo_write","toolInput":{…},"toolOutput":{…},"startedAt":…,"endedAt":…,"firstChunkAt":…}}
```

- `block`：`types::MessageBlock` 的 serde 序列化原样嵌入。注意
  `block_index` 标注了 `#[serde(skip_serializing)]`，因此**不出现在 JSON 中**，
  顺序契约见 §5.3；
- `block.type` 取值即 `types::block_types` 常量全集（`thinking` / `content` /
  `mcp_tool` / `rag` / `web_search` / `ask_user` / `compaction_summary` /
  `workspace_injection` 等），消费者遇到新类型按未知块降级为纯文本处理；
- 外层冗余 `messageId` 便于流式消费者不回看 message 行即可归属。

### 3.4 `type: "compaction"`（0..K 条）

```json
{"type":"compaction","record":{"id":"cmp_…","sessionId":"sess_…","summaryMessageId":"msg_…","tailStartMessageId":"msg_…","tailStartTimeCreated":…,"reason":"auto","isAuto":true,"tokensBefore":…,"tokensAfter":…,"previousCompactionId":null,"createdAt":…}}
```

- `record`：`types::CompactionRecord` 的 serde 序列化原样嵌入；
- 回放消费者据此重建「摘要 + 逐字尾部」的上下文视图；只关心完整时间线的
  消费者可整体忽略该类型。

### 3.5 `type: "footer"`（末行，恰好 1 条）

```json
{"type":"footer","messageCount":42,"blockCount":137,"compactionCount":1,"truncated":false}
```

- 计数不匹配或缺失 footer ⇒ 文件被截断/损坏，消费者应按不完整导出处理；
- `truncated=true` 保留给未来「预算内导出」场景（v1 实现不主动截断）。

## 4. 字段来源映射（单一事实源）

导出层**不定义新的消息 schema**——所有嵌入对象直接复用
`chat_v2/types.rs` 现有 `Serialize` 实现（camelCase rename），
与前端 Store / `LoadSessionResponse` 完全同构：

| JSONL 位置 | Rust 类型 | DB 来源（repo.rs 访问器） |
| --- | --- | --- |
| `header.session` | `ChatSession` | `ChatV2Repo::get_session_v2` |
| `header.state` | `SessionState` | `ChatV2Repo::load_session_state_v2` |
| `message.message` | `ChatMessage` | `ChatV2Repo::get_session_messages_v2` |
| `block.block` | `MessageBlock` | `ChatV2Repo::get_session_blocks_v2` |
| `compaction.record` | `CompactionRecord` | `ChatV2Repo::list_compactions_with_conn` |

由此获得两条不变式：

1. **types.rs 改字段 ⇒ 导出格式自动跟进**，无需双维护；新增可选字段属于
   向后兼容变更，`schemaVersion` 不变；
2. `header + message* + block*` 与 `load_session_full_v2` 返回的
   `LoadSessionResponse` 信息等价（round-trip 目标，见 §7 验收）。

## 5. 语义规约

### 5.1 变体（multi-variant）

- 默认 `includeAllVariants=true`：`message.variants` 全量导出，
  所有变体的 block 都会出现在 `block` 行中（块归属由各
  `variant.blockIds` 判定）；
- `includeAllVariants=false`：仅保留 active 变体链——即
  `ChatMessage::get_active_block_ids()` 的结果（有激活变体取
  `activeVariantId` 对应变体的 `blockIds`，否则回退 `message.blockIds`），
  `variants` 数组裁剪为激活项，其余变体的 block 行不导出。
  该规则与前端 `getDisplayBlockIds()` 保持一致。

### 5.2 隐私与脱敏（默认开启 `redactSecrets=true`）

- `toolInput` / `toolOutput` / `_meta.chatParams` 等 JSON 值经
  `task_audit::redact_secrets` 递归处理（URL 内 token/password 等打码）；
- `_meta` 经 `MessageMeta::without_skill_runtime_contents()` 去除
  技能全文快照（`skillRuntimeBefore/After` 只留骨架）；
- 附件不内联 base64：`attachments` 仅含 `AttachmentMeta` 引用
  （id / 文件名 / mime / size / hash），与 `canonical_content`
  「稳定引用而非持久化 base64」的既有设计对齐；
- `redactSecrets=false` 仅供本机调试，UI 不暴露。

### 5.3 顺序与完整性

- 块**渲染顺序**的唯一权威是 `message.blockIds` / `variant.blockIds`
  （后端权威实现 `ChatMessage::get_active_block_ids`）；`block` 行的物理
  行序（`block_index` 升序）仅为流式友好，不得作为渲染依据；
- `blockIds` 中引用但 DB 缺失的块：跳过并计入日志，不中断导出
  （与 `row_to_message` 「解析失败降级为空、不 panic」的容错策略一致）；
- 单行大小无硬上限，但受 repo 层 `variants_json` 256KB 截断上限约束，
  实现必须**逐行流式写出**（`io::Write`），禁止整文件缓冲。

## 6. Rust API（已实现）

```rust
pub fn export_session_jsonl<W: std::io::Write>(
    db: &ChatV2Database,
    session_id: &str,
    options: &SessionExportOptions,
    writer: &mut W,
) -> ChatV2Result<SessionExportSummary>;
```

- 会话不存在 ⇒ `ChatV2Error::SessionNotFound`；写失败 ⇒ `ChatV2Error::IoError`；
- 另有 repo 惯例的 `export_session_jsonl_with_conn` 连接级变体；
- `SessionExportSummary` 与 footer 字段一致，Tauri command
  `chat_v2_export_session_jsonl(session_id, target_path, options?)`
  （`handlers/export_handlers.rs`）流式写入目标 `.jsonl` 文件后
  将其直接回传前端；headless 归档钩子（R13+）复用同一函数。

前端通过 Tauri `invoke` 调用；参数键使用 camelCase，`targetPath` 应来自保存
对话框返回的绝对 `.jsonl` 路径。产品 UI 必须保持 `redactSecrets: true`：

```ts
import { invoke } from '@tauri-apps/api/core';

interface SessionExportSummary {
  sessionId: string;
  schemaVersion: number;
  messageCount: number;
  blockCount: number;
  compactionCount: number;
  bytesWritten: number;
  truncated: boolean;
}

const summary = await invoke<SessionExportSummary>(
  'chat_v2_export_session_jsonl',
  {
    sessionId,
    targetPath,
    options: {
      includeAllVariants: true,
      includeSessionState: true,
      includeCompactions: true,
      redactSecrets: true,
    },
  },
);
```

## 7. 验收标准（已由 `session_export` 单测覆盖）

1. 对含多变体 + 工具块 + 压缩记录的会话导出，`jq -c .type` 输出满足
   §3 状态机，footer 计数与实际行数一致；
2. round-trip：解析 JSONL 重建的 `(session, messages, blocks)` 与
   `load_session_full_v2` 结果 serde JSON 等价（忽略字段序）；
3. 默认脱敏下，导出文件 `grep -i "password\|token="` 无命中
   （复用 `task_audit` 已有测试语料）；
4. 10MB 级会话导出内存峰值 O(单条消息)，不随会话总量线性增长。

## 8. 后续工作

| 轮次 | 内容 | 状态 |
| --- | --- | --- |
| R4 | 实现 `export_session_jsonl` + 单测（含 round-trip） | ✅ 已完成 |
| R4 | Tauri command `chat_v2_export_session_jsonl` | ✅ 已完成 |
| 后续 | 前端会话菜单导出入口 | 待排期 |
| R13+ | headless/automations 运行归档钩子（跑完自动落 JSONL） | 待排期 |
| 后续 | import / replay 执行器（schemaVersion 协商） | 待排期 |

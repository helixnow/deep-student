# Anki Agent 工具面说明

本文档说明 ChatV2 中对 Agent 开放的 29 个 `builtin-chatanki_*` 工具。内容以当前工具 Schema、Rust 执行器和服务实现为准，供技能编排、联调和故障排查使用。

实现入口：

- 工具 Schema 与技能工作流：[src/features/chat/skills/builtin/index.ts](../src/features/chat/skills/builtin/index.ts)
- 工具执行器：[src-tauri/src/chat_v2/tools/chatanki_executor.rs](../src-tauri/src/chat_v2/tools/chatanki_executor.rs)
- APKG 导入：[src-tauri/src/apkg_importer_service.rs](../src-tauri/src/apkg_importer_service.rs)
- FSRS 复习服务：[src-tauri/src/fsrs_review_service.rs](../src-tauri/src/fsrs_review_service.rs)

## 工具总览

| 工具 | 用途 | 作用域 | 是否写数据 |
|---|---|---|---|
| `builtin-chatanki_import_apkg` | 把已有 APKG 导入本地卡片库 | 当前会话资源或用户给出的绝对路径 | 是 |
| `builtin-chatanki_run` | 从文本或文件自动解析并启动制卡 | 当前会话 | 是，后台执行 |
| `builtin-chatanki_start` | 从已整理的纯文本/Markdown 直接启动制卡 | 当前会话 | 是，后台执行 |
| `builtin-chatanki_status` | 查询文档级生成进度 | 当前会话的 `documentId` | 否 |
| `builtin-chatanki_wait` | 等待生成流程进入终态或超时 | 当前会话的块或文档 | 否 |
| `builtin-chatanki_get_cards` | 分页读回卡片全文与版本 | 当前会话的 `documentId` | 否 |
| `builtin-chatanki_update_card` | 乐观锁修改一张卡 | 当前会话拥有的 `cardId` | 是 |
| `builtin-chatanki_batch_update_cards` | 批量（1~100 张）乐观锁修改卡片，逐卡返回成功/冲突 | 当前会话的 `documentId` 内多张卡 | 是 |
| `builtin-chatanki_delete_card` | 按内容及复习版本删除一张卡 | 当前会话拥有的 `cardId` + `expectedVersion` + `expectedReviewVersion` | 是 |
| `builtin-chatanki_delete_cards` | 批量（1~100 张）按双版本锁删除卡片，逐卡返回结果 | 当前会话同一文档内多张卡 | 是 |
| `builtin-chatanki_add_cards` | 向已有文档补卡 | 当前会话的 `documentId` | 是 |
| `builtin-chatanki_enqueue_review` | 加入内置 FSRS 复习计划 | 当前会话的文档或卡片 | 是 |
| `builtin-chatanki_review_stats` | 查询 FSRS 全库统计 | 库级 | 否 |
| `builtin-chatanki_undo_last_review` | 撤销单卡最后一次可撤销评分 | 当前会话拥有且已入队的卡片 | 是 |
| `builtin-chatanki_set_suspended` | 暂停或恢复单卡复习状态 | 当前会话拥有且已入队的卡片 | 是 |
| `builtin-chatanki_list_library_cards` | 搜索并分页读取完整本地卡片库 | 全库 | 否 |
| `builtin-chatanki_update_library_card` | 按内容版本修改一张库卡片 | 全库 | 是 |
| `builtin-chatanki_enqueue_library_review` | 按内容版本批量加入复习计划 | 全库 | 是 |
| `builtin-chatanki_set_library_suspended` | 按复习版本暂停或恢复库卡片 | 全库 | 是 |
| `builtin-chatanki_undo_library_last_review` | 按复习版本撤销库卡片最后评分 | 全库 | 是 |
| `builtin-chatanki_delete_library_card` | 按内容及复习版本删除库卡片 | 全库 | 是 |
| `builtin-chatanki_retemplate` | 乐观锁批量换模板 | 当前会话的文档或卡片 | 是 |
| `builtin-chatanki_transform` | 批量程序化变换（ops 声明式 / script 沙箱脚本），dry_run 出 diff、apply 乐观锁写回 | 当前会话的 `documentId` 或选择集 | 是（dry_run 否） |
| `builtin-chatanki_control` | 暂停、恢复、重试或取消生成 | 当前会话的 `documentId` | 是 |
| `builtin-chatanki_export` | 导出 APKG 或 JSON | 当前会话的 `documentId` | 是，写文件 |
| `builtin-chatanki_sync` | 通过 AnkiConnect 同步到桌面 Anki | 当前会话的 `documentId` | 是，写外部 Anki |
| `builtin-chatanki_list_templates` | 列出本地模板及字段契约 | 库级 | 否 |
| `builtin-chatanki_analyze` | 预分析材料并给出与管线同源的路由/参数预估，不生成卡片 | 当前调用内容/引用元数据 | 否 |
| `builtin-chatanki_check_anki_connect` | 检查 AnkiConnect 可用性 | 本机环境 | 否 |

## 通用契约

### ID 不可混用

| 字段 | 含义 | 来源 |
|---|---|---|
| `ankiBlockId` | 聊天中的 `anki_cards` 预览块 ID | `run`/`start` 返回值或最近的预览块 |
| `documentId` | 一批卡片及其分段任务的文档 ID | `run`/`start`/`wait`/`import_apkg` 返回值 |
| `cardId` | `anki_cards` 表中一张真实卡片的 ID | `get_cards` 或 `list_library_cards` 返回值 |
| `version` | 卡片当前的乐观锁版本，当前实现等于 `updatedAt` | `get_cards` 或 `list_library_cards` 返回值 |
| `reviewVersion` | FSRS 调度状态的整数乐观锁版本，与内容 `version` 相互独立 | `get_cards.cards[].reviewState` 或 `list_library_cards.cards[].reviewState` 返回值 |
| `taskId` | 文档中的单个分段任务 ID | 任务诊断或定点 `retry` 时使用 |

禁止使用牌组名、数组序号、临时字符串或 UI 合成 ID 代替上述真实 ID。

### 会话所有权

除库级工具外，所有按 `documentId` 操作的工具都会校验文档是否属于当前 ChatV2 会话。按 `cardId` 操作的工具会先解析卡片所属文档，再校验该文档的会话所有权。

跨会话、mixed-owner、已删除或不存在的文档/卡片统一表现为 `blocks.ankiCards.errors.statusNotFound`。文档级写操作要求该文档的全部未删除 task 都属于当前会话；这是有意的信息隐藏，调用方不能据此区分“确实不存在”和“所有权不完整”。

六个 `*_library_*` 工具是显式的全库作用域：它们可读取或修改其他 ChatV2 会话及 APKG 导入产生的 live 本地卡片，不使用当前会话的 document ownership 过滤。进入全库作用域必须来自用户对“卡片库、以前的卡、全部卡片、到期卡”等明确意图；当前会话刚生成的卡仍优先使用会话级工具。`review_stats`、`list_templates`、`analyze`、`check_anki_connect` 也不受单个文档所有权约束。

### 工具失败与业务拒绝

ChatV2 的工具结果外层带有 `success`。本文各工具的“返回值”指外层结果中的 `output`。

- 参数解析失败、数据库不可用、所有权拒绝等通常是工具失败：外层 `success=false`，`error` 是错误消息或 i18n key。
- `update_card` 的版本冲突，以及 `retemplate` 的版本、选择集或 Cloze 冲突，是可恢复的业务结果：外层 `success=true`，`output.status` 为 `conflict`、`blocked` 或 `rejected`，并带结构化 `error`。
- `undo_last_review` 与 `set_suspended` 的调度版本冲突也是结构化业务结果：外层 `success=true`、`output.status=conflict`、`error=review_state_conflict`。必须重新读取 `get_cards.reviewState`，不能复用旧 `reviewVersion` 或旧日志 ID。
- 复习写操作不能安全执行时返回 `status=blocked`、当前 `reviewState` 和稳定原因；这是明确拒绝，不得改用其他写工具绕过。卡片不存在、跨会话或未入队时仍使用统一 not-found 工具失败，不泄露所有权信息。
- 库级内容写入的 `version_conflict`、库级复习写入的 `review_state_conflict` 都要求重新调用 `list_library_cards`。库级批量入队还可能结构化返回 `status=not_found` 或 `blocked`；这些结果均保证 `mutationApplied=false`，不能把部分命中项视为已写入。
- `wait` 的 `timeout` 是结构化成功结果，表示仍可继续等待；`invalid_args` 和 `not_found` 的外层 `success=false`。
- 写卡工具可能返回 `status=partial`。此时数据库修改已经生效，但聊天预览块的持久化同步失败，应重新 `get_cards` 获取权威数据，不要重复盲写。

### 实时刷新与复习事件

`update_card`、`delete_card`、`add_cards` 和 `retemplate` 在当前会话存在该文档的 `anki_cards` 预览块时，会严格校验块的类型、文档和会话归属，持久化并发送卡片 patch，使已打开的聊天块按卡片 ID 更新；同时发送 `fsrs://changed`。库级修改/删除会在来源聊天块仍存在时执行相同同步；无来源块（例如外部 APKG）时返回 `uiSync.status=not_required`。`import_apkg` 和成功入队也会发送 `fsrs://changed`。会话级与库级撤销/暂停工具仅在实际写入时发送该事件；冲突、拒绝和幂等 no-op 不发送。闪卡 Today、Library、Stats 及活动复习 session 会据此协调刷新。事件发送失败不会回滚已经成功的数据库写入。

聊天预览块在流式生成期间可以使用 `anki_synthetic_*`、`chat-batch-*` 或缺失 ID 表示尚未落库的卡片。用户执行本地保存时，`save_anki_cards` 会为这些卡片分配真实 ID，并返回输入索引到实际落库 ID 的映射；前端必须把映射合并到最新块数据并持久化 `tool_output`，完成后才允许“复习这批”。批量复习不得携带临时 ID。

`import_apkg` 创建数据库文档，但不会为整包卡片伪造或回填聊天预览块。对这类文档调用上述四个写工具时，只要 Anki 文档/卡片归属校验通过，数据库 mutation 会正常执行，并返回 `uiSync.status=not_required`、`uiSync.eventAttempted=false`，不包含 `blockId`。这不是降级或部分失败。若 Chat V2 数据库本身不可用或查询失败，预检仍会阻止写入。

### 破坏性操作确认

技能层要求以下操作先调用 `builtin-ask_user` 明确确认：

- 一次删除超过 3 张卡（包括使用 `delete_cards` 批量删除超过 3 张）；
- 使用 `batch_update_cards` 一次修改超过 3 张卡；
- 更换超过 3 张卡的模板或整份文档换模板；
- 整批重做；
- 覆盖用户已经手动编辑的内容；
- 导出或同步完整卡片内容；
- 把卡片加入复习计划。

撤销评分、暂停或恢复复习状态只允许响应用户对目标单卡的明确要求；如果“这张”“上一次”或暂停/恢复方向有歧义，也必须先确认。Agent 不得根据卡片难度、答题正确率或内容自行决定暂停，更不得推断或代替用户选择 Again/Hard/Good/Easy。本工具面有撤销工具，但没有 Agent 评分工具。

`cancel` 只停止未完成的生成，已生成卡片会保留。

### 后台管线的取消语义

`run`/`start` 启动的后台制卡管线注册在进程内活跃管线注册表中，并各自持有取消令牌：

- 全局 Kill Switch（`chat_v2_emergency_stop`）会枚举注册表取消全部活跃制卡管线；
- 聊天流取消（用户点停止）通过父子令牌传播到同会话工具调用派生出的管线；
- 两者都走与 `control(cancel)` 相同的**非破坏性取消**路径：停止调度协程、断流、把未完成分段置为 `cancelled`，已生成卡片全部保留，预览块以 `cancelled` 终态收敛。

管线在生成尚未开始（内容解析阶段）就被取消时，会插入一条 `cancelled` 占位任务并把预览块落为 `cancelled` 终态，`wait`/`status` 不会因此返回 `not_found`。

## 生成状态模型

底层分段任务状态为 `pending`、`processing`、`streaming`、`paused`、`completed`、`failed`、`truncated`、`cancelled`。`status` 和 `wait` 将其聚合为文档级状态：

| 聚合状态 | 含义 | 后续动作 |
|---|---|---|
| `running` | 至少一个分段仍在处理 | 继续 `wait` 或稍后 `status` |
| `paused` | 文档已暂停 | 用户要求后 `control(resume)` |
| `completed` | 所有分段正常结束，或因达到 `maxCards` 上限而正常收口 | 进入 `get_cards` 全量验收 |
| `completed_with_errors` | 已结束，但至少有一个 `failed`/`truncated` 分段；通常仍保留部分结果 | 检查 `cardsCount`，先验收现有卡，再按需 `control(retry)` |
| `cancelled` | 用户或系统取消，且不是达到卡数上限的收口 | 保留已有卡，向用户说明 |
| `error` | 预览块以错误终止；该值由 `wait` 返回 | 查看 `error`，按原因处理 |
| `timeout` | 本次等待到期，任务不一定失败 | 再次 `wait` 或调用 `status` |
| `not_found` | ID 不存在、不可见或不属于当前会话 | 重新定位真实 ID；不要猜测 |
| `invalid_args` | `wait` 未提供可用的块 ID 或文档 ID | 补充 `ankiBlockId` 或 `documentId` |

`limitReached=true` 表示已达到本批 `maxCards` 上限，这是正常完成信号，不是取消或失败。

`status` 与 `wait` 的顶层输出还包含 `usableCards`（非诊断卡数量）。`completed_with_errors` 且 `usableCards=0` 等价于完全失败：不得仅凭状态名把它当作“已有部分可用卡”。

## 工具明细

### `builtin-chatanki_import_apkg`

把 APKG 中的卡片导入本地 `anki_cards`，创建一个归属当前会话的新 `documentId`。导入优先读取 `collection.anki21`，否则读取 `collection.anki2`；字段名大小写无关地优先用 `Front`/`Back` 映射正反面，缺少这些命名时才回退首/次字段。Cloze model 的 `Text` 写入卡片 `text`，Basic model 中名为 `Text` 的自定义字段则保留在 `extraFields`。`Header`、`Subject`、`Question`、`Extra` 等非核心字段无论位于哪个槽位都会进入 `extraFields`。

参数：

| 参数 | 必填 | 约束 |
|---|---|---|
| `resourceId` | 与 `path` 二选一 | 当前会话可访问的 `file_`、`att_`，或可解析到文件的 `res_` |
| `path` | 与 `resourceId` 二选一 | 用户明确提供的本机绝对路径；相对路径被拒绝 |

两者必须且只能提供一个。不得猜测路径，也不得把非当前会话资源作为 `resourceId`。

成功返回：

```json
{
  "documentId": "apkg-...",
  "importedCards": 146,
  "importedTemplates": 0,
  "mediaImported": 12,
  "mediaSkipped": 2,
  "mediaReport": {
    "declared": 14,
    "imported": 12,
    "skipped": 2,
    "skips": [
      { "reason": "entry_missing", "count": 2, "filenames": ["a.png", "b.mp3"] }
    ],
    "mediaDir": "/app-data/anki_media"
  },
  "warnings": ["媒体清单声明的条目在包内缺失，已跳过: 3 (a.png)"]
}
```

当前实现不导入 APKG 模板，故 `importedTemplates` 为 `0`。本应用导出的 APKG 会在 model 中携带模板 ID 元数据，重新导入时该 ID 会写回卡片，因此只要本地仍有对应模板即可直接再次导出，无需先 `retemplate`；无此元数据的外部 APKG 保持 `templateId=null`。导出 Cloze 时，每个唯一且有效的 `{{cN::答案}}` 会写入一条 `ord=N-1` 的 Anki card row；Basic 始终只有一条 `ord=0`。自有包还携带 Cloze 折叠元数据，导回时同一 note 的多个 ord 只恢复成一张内部内容卡，反复导入/导出不会倍增；无该元数据的外部包仍按每条 Anki card row 导入。导入成功后应立即用返回的 `documentId` 分页 `get_cards`。

**媒体导入**：包内媒体（图片与音频，legacy JSON 清单和现代 anki21b zstd+protobuf 清单均支持）会按清单文件名解出到应用数据目录下的 `anki_media/`（`mediaReport.mediaDir`）。字段 HTML 保留 Anki 原生引用（`src="name.png"`、`[sound:name.mp3]`，不改写，保证再导出后桌面 Anki 可直接解析）；被引用且成功落盘的媒体以绝对路径写入卡片 `images`，`images` 中的路径与字段引用按 basename 一一对应，这也是 `chatanki_export(apkg)` 把媒体打回 zip 的依据——导入→导出构成完整媒体往返。

`mediaImported` 是成功落盘（或按文件名复用已有文件）的数量；`mediaSkipped` 是声明但未落盘的数量。任何跳过都必须出现在结构化的 `mediaReport.skips` 中（按 `reason` 分组，`count` 为全量计数，`filenames` 最多采样 20 个），不存在静默丢弃。稳定 `reason` 码：

| reason | 含义 |
|---|---|
| `entry_missing` | 清单声明的条目在包内缺失 |
| `unsafe_filename` | 文件名含路径穿越/反斜杠/盘符/控制字符，被安全策略拒绝 |
| `entry_oversized` | 解压后超过单条目 256 MiB 上限（解压炸弹防护），半成品已删除 |
| `io_error` | 落盘或解压失败 |
| `orphan_entry` | 包内数字条目未出现在 media 清单（无文件名可用，按 zip 键列出） |
| `manifest_unparsed` | 现代包媒体清单无法解析，全部媒体跳过（卡片导入不受影响） |
| `media_dir_unavailable` | 媒体目录创建失败 |
| `media_import_disabled` | 调用方未启用媒体目录（旧行为兼容路径） |

包内无媒体且无任何跳过时不返回 `mediaReport` 与 `warnings` 字段。zip 条目名的路径穿越（zip slip）在解析阶段即整包拒绝（`apkg_invalid_archive`）；清单文件名只取 basename 落盘，任何情况下不会写出媒体目录之外。向用户汇报导入结果时应包含媒体统计与跳过原因。

失败时 `output.error` 是结构化 `AppError`，稳定错误码位于 `output.error.details.errorCode`：

| 错误码 | 含义 |
|---|---|
| `apkg_invalid_input` | 参数、空文件或输入形式无效 |
| `apkg_not_found` | 路径、资源或会话资源不可见 |
| `apkg_not_file` | 路径不是普通文件 |
| `apkg_io` | 文件或临时文件读写失败 |
| `apkg_invalid_archive` | ZIP、entry、media manifest 或压缩数据无效 |
| `apkg_limit_exceeded` | 超过安全限制，例如压缩包大于 256 MiB |
| `apkg_collection_missing` | 缺少 `collection.anki21` 和 `collection.anki2` |
| `apkg_collection_invalid` | SQLite schema、models/decks、notes/cards 数据无效或不受支持 |
| `apkg_database` | 本地数据库或导入事务失败 |
| `apkg_resource_mismatch` | VFS 原始路径文件与记录的 SHA-256 不一致 |

### `builtin-chatanki_run`

从当前会话的文件/图片上下文或直接文本自动解析材料，并异步启动完整制卡流水线。适合原始上传材料；若材料已经整理为最终 Markdown，优先使用 `start`。

参数：

| 参数 | 必填 | 约束与语义 |
|---|---|---|
| `goal` | 是 | 非空学习目标，影响拆卡粒度和模板生成提示 |
| `maxCards` | 是 | 整数 `1..100`；表示上限，不保证精确生成该数量 |
| `templateMode` | 是 | `single`、`multiple` 或 `all` |
| `templateId` | `single` 时优先 | 来自 `list_templates` 的模板 ID；`single` 模式未传时自动读取用户设置的默认模板（settings 表 `default_template_id`），无默认模板或默认模板已删除则报错 |
| `templateIds` | `multiple` 时是 | 非空模板 ID 数组 |
| `content` | 否 | 无文件时的正文；有文件时只能作补充说明，不能替代材料主体 |
| `route` | 否 | `simple_text`、`vlm_light`、`vlm_full`；省略则自动路由 |
| `resourceId` | 否 | 指定一个直接文件类资源 |
| `resourceIds` | 否 | 指定多个资源；实现会与 `resourceId` 合并并去重 |
| `deckName` | 否 | 后续导出/同步默认牌组；默认取设置或 `Default` |
| `noteType` | 否 | 后续导出/同步默认笔记类型；默认取设置或 `Basic` |
| `extraRequirements` | 否 | 附加生成要求（卡片风格/语言/格式类约束），作为高优先级规则注入生成提示；学习目标仍放 `goal` |
| `outputProtocol` | 否 | 流式输出协议：`auto`（默认，管线按模型能力自选）、`delimiter`、`json_object`、`json_schema`。非法值在启动前被 `normalize_output_protocol_arg` 直接拒绝，不会静默回退成 `delimiter` |
| `visualHint` | 否 | 视觉重点提示（"看图看哪里"）。仅 VLM 路由（`vlm_light`/`vlm_full`）生效，以数据分隔符包裹注入 VLM prompt（非指令）；`simple_text` 路由忽略 |
| `contentFormat` | 否 | 材料形态覆盖：`auto`（默认，启发式判定）、`glossary`（词汇表/术语清单，逐条条目制卡）、`prose`（叙述性文章）。与 `analyze` 的 `routing.glossaryMode` 对应 |
| `enableQaPass` | 否 | 字段 QA 校验留痕开关；缺省 = `true`（产出 `_qa_flags` 留痕） |
| `enableCriticPass` | 否 | 生成后 grounded LLM critic 质检/复审开关；缺省 = `false`。仅当用户明确要求“质检/复审/critic”时传 `true` |
| `enableFsrsFeedback` | 否 | FSRS 复习画像回流开关；缺省 = `true` |
| `maxImages` | 否 | VLM 单次调用图片数上限，整数 `1..12`（默认 `vlm_light` 6 / `vlm_full` 12）；超出范围被 clamp 到 `1..=12`，仅 VLM 路由生效 |
| `enablePreferenceMemory` | 否 | 历史制卡偏好记忆注入开关；缺省 = `true` |
| `debug` | 否 | 是否在预览块中附加路由和资源诊断信息 |

`templateMode=all` 使用全部激活模板；若目标明确是选择题，实现可能收敛到匹配的单模板。Schema 已强制 `maxCards<=100`，超过 100 张必须拆批，不应依赖执行器的兼容性截断。

调优参数中，`enableCriticPass` 默认关闭，只有用户明确要求质检、复审或 critic 时才开启；其余参数默认 auto/开启，绝大多数调用不需要传。参数名与 Rust `ChatAnkiRunArgs` 的 serde camelCase 字段一一对应，Rust 解析层同时兼容 snake_case alias（`enableCriticPass` 对应 `enable_critic_pass`）。Schema 已声明 `additionalProperties: false`：`temperature`、`segmentOverlapSize` 等 `analyze` 预估参数不是 run/start 参数，不得传入。

立即返回，不等待后台完成：

```json
{
  "status": "started",
  "ankiBlockId": "blk_...",
  "documentId": "...",
  "message": "ChatAnki pipeline started (background)"
}
```

常见失败没有独立稳定错误码，外层 `error` 为消息，包括参数解析失败、`goal is required`、模板选择无效或模板不存在、数据库或 LLM 管理器不可用。内容解析和后台生成错误发生在工具返回之后，会写入预览块和文档任务，由下一轮 `wait`/`status` 观察。

多文件材料的文本提取有 10MB 总预算。预算耗尽时不再静默丢弃剩余文件：预览块与终态输出的 `warnings` 中，`code=text_truncated` 的警告会携带 `includedFiles`（已收录）与 `droppedFiles`（被整体或部分丢弃）的文件名清单，`messageParams.droppedCount`/`droppedFiles` 同步给出。Agent 必须据此告知用户哪些材料没有参与本次制卡。

终态输出还包含 `hiddenOverLimitCount`：超出本批 `maxCards`、保留在卡片库中但未展示在预览块里的卡片数。

### `builtin-chatanki_start`

从已经准备好的纯文本或 Markdown 直接启动制卡，跳过文件解析并固定走文本路径。

参数与 `run` 的模板、牌组、卡数和 `debug` 参数相同，但有三点不同：

- `content` 必填且应为实际材料正文；
- 不接受 `route`、`resourceId` 或 `resourceIds`；
- 固定纯文本路径、永不触发 VLM，因此也没有 `visualHint` 和 `maxImages`（Rust `ChatAnkiStartArgs` 无这两个字段）。

其余调优参数与 `run` 一致：`extraRequirements`、`outputProtocol`（非法值同样在启动前被拒绝）、`contentFormat`、`enableQaPass`、`enableCriticPass`（默认关闭，仅响应用户明确质检/复审要求）、`enableFsrsFeedback`、`enablePreferenceMemory`。

成功返回与 `run` 相同：`status=started`、真实 `ankiBlockId`、预分配的真实 `documentId` 和后台启动消息。参数/模板/运行环境失败语义也与 `run` 相同。

`run`/`start` 后不要在同一轮并发调用 `wait`。使用返回的真实 ID，在下一轮调用 `wait`。

### `builtin-chatanki_status`

获取文档级瞬时进度，不阻塞等待。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `documentId` | 是 | 当前会话拥有的真实文档 ID |

成功返回：

```json
{
  "status": "running",
  "documentId": "...",
  "counts": {
    "counts": {
      "total": 4,
      "pending": 1,
      "processing": 1,
      "streaming": 0,
      "paused": 0,
      "completed": 2,
      "failed": 0,
      "truncated": 0,
      "cancelled": 0
    },
    "completedRatio": 0.5
  },
  "cardsCount": 18,
  "usableCards": 18,
  "limitReached": false,
  "error": null,
  "shouldRetry": false
}
```

`status` 可能为 `running`、`paused`、`completed`、`completed_with_errors`、`cancelled` 或 `not_found`。`completedRatio` 只按 `completed/total` 计算，不把失败、截断或取消计为完成。

当前 `status` 的聚合只要看见 `failed`/`truncated` 就会返回 `completed_with_errors`，即使 `cardsCount=0`。顶层 `usableCards` 是非诊断卡数量：`completed_with_errors` 且 `usableCards=0` 等价于完全失败，不能仅凭状态名断言已有可用卡片。

错误包括缺少 `documentId`、数据库不可用和 `blocks.ankiCards.errors.statusNotFound`。`not_found` 时外层 `success=false`，`shouldRetry=true`。

### `builtin-chatanki_wait`

轮询预览块或文档任务，直到终态、暂停、取消或等待超时。优先提供稳定的 `documentId`；只有尚未取得它时才用 `ankiBlockId` 回退。两个 ID 同传时必须来自同一次 `run`/`start`，不匹配会返回 `chatanki_wait_document_mismatch`。

参数：

| 参数 | 必填 | 约束 |
|---|---|---|
| `ankiBlockId` | 至少一个 ID | `run`/`start` 返回的预览块 ID；仅在缺少 documentId 时使用 |
| `documentId` | 至少一个 ID | 文档任务 ID；稳定优先路径 |
| `timeoutMs` | 否 | 默认 5 分钟，最大 60 分钟；`0` 按默认值处理。默认值刻意偏短：应分轮轮询（timeout 后下一轮继续 `wait` 或改查 `status`），不要用一次超长 wait 占死整个回合 |

返回：

```json
{
  "status": "completed_with_errors",
  "ankiBlockId": "blk_...",
  "documentId": "...",
  "cardsCount": 22,
  "usableCards": 20,
  "progress": {
    "counts": {
      "total": 4,
      "pending": 0,
      "processing": 0,
      "streaming": 0,
      "paused": 0,
      "completed": 3,
      "failed": 1,
      "truncated": 0,
      "cancelled": 0
    },
    "completedRatio": 0.75
  },
  "ankiConnect": null,
  "limitReached": false,
  "error": null,
  "shouldRetry": false
}
```

`status` 可为 `completed`、`completed_with_errors`、`paused`、`cancelled`、`error`、`timeout`、`not_found` 或 `invalid_args`。`timeout`/`not_found` 的 `shouldRetry=true`；其中 `timeout` 外层仍成功，不能直接报告生成失败。仅靠块 ID 且约 8 秒内始终找不到块时会提前返回 `not_found`。

稳定错误 key：

- `blocks.ankiCards.errors.waitInvalidArgs`
- `blocks.ankiCards.errors.waitNotFound`
- `blocks.ankiCards.errors.waitTimeout`
- `blocks.ankiCards.errors.statusNotFound`

### `builtin-chatanki_get_cards`

分页读取某文档当前的 live 卡片，是任何 Agent 修改、换模板、导出或入队前的权威观测入口。

参数：

| 参数 | 必填 | 默认/约束 |
|---|---|---|
| `documentId` | 是 | 当前会话拥有的文档 |
| `page` | 否 | 默认 `1`，最小 `1` |
| `pageSize` | 否 | 默认 `20`，范围 `1..50` |
| `filter` | 否 | `all`、`error_only`、`edited_only`；默认 `all` |

成功返回顶层字段：`status=ok`、`documentId`、`total`、`page`、`pageSize`、`filter`、`cards`、`hiddenOverLimitCount`。`total` 是应用筛选后的总数。卡片中的 `index` 仍是原始文档顺序，从 1 开始。

`get_cards` 返回库中该文档的全部 live 卡，包括因 `maxCards` 上限被隐藏出预览块的超限保留卡；`hiddenOverLimitCount` 表示这类“库里有、块里看不见”的卡片数（读取自预览块终态，无预览块时为 0）。

每张卡返回：

```json
{
  "id": "...",
  "index": 1,
  "front": "...",
  "back": "...",
  "text": null,
  "tags": ["..."],
  "templateId": "design-swiss",
  "extraFields": {},
  "isErrorCard": false,
  "errorContent": null,
  "updatedAt": "2026-07-14T...Z",
  "version": "2026-07-14T...Z",
  "reviewState": {
    "ankiCardId": "...",
    "cardStateId": "...",
    "state": 2,
    "suspended": false,
    "dueMs": 1784000000000,
    "lastReviewMs": 1783900000000,
    "reviewVersion": 7,
    "latestReview": {
      "logId": "...",
      "rating": 3,
      "reviewMs": 1783900000000,
      "undoable": true
    }
  },
  "truncated": false,
  "truncatedFields": []
}
```

`reviewState=null` 表示卡片尚未进入 FSRS 队列，不能调用复习状态写工具。非空时，`state` 的 `0/1/2/3` 分别表示 new/learning/review/relearning；`lastReviewMs` 与 `latestReview` 在没有评分记录时为 `null`。`reviewVersion` 是调度写操作唯一接受的 CAS token，不能用卡片内容的字符串 `version` 代替。`latestReview.undoable=false` 时不得调用撤销工具。

`front`、`back`、`text`、每个 tag、每个 `extraFields` 值和 `errorContent` 分别按 2000 个字符截断。只要任一字段截断，`truncated=true` 且 `truncatedFields` 列出字段路径。截断内容不能作为覆盖原字段的完整来源。

`edited_only` 的当前判断是 `updatedAt != createdAt`。错误包括参数无效、数据库不可用、读取失败和 `blocks.ankiCards.errors.statusNotFound`。

### `builtin-chatanki_update_card`

带乐观锁修改单卡。调用前必须用 `get_cards` 取得当前 `cardId` 和 `version`。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `cardId` | 是 | 当前会话拥有的真实卡片 ID |
| `expectedVersion` | 是 | 最近一次 `get_cards` 返回的 `version` |
| `patch` | 是 | 至少包含 `front`、`back`、`text`、`tags`、`extraFields` 之一 |
| `allowTruncatedSource` | 否 | 默认 `false`；显式确认“新值可能基于截断输出，仍要整字段覆盖” |

`patch` 不接受其他字段。`tags` 和 `extraFields` 是整字段替换，不是增量合并；`extraFields` 的 key 会 trim 后转小写，空 key 被丢弃。写入后卡片必须满足“非空 `front` 与 `back`”或“非空 Cloze `text`”之一。

**截断防御**：`get_cards` 的单字段按 2000 字符截断输出，而 `update_card` 是整字段替换——把截断文本当完整字段回写会静默毁掉超限部分。当目标卡某字段现存长度超过截断限，且 patch 提供的新值疑似基于截断源（长度达到截断限、比现存内容短、与现存内容截断前缀高度重合）时，工具不写数据并返回结构化拒绝：

```json
{
  "status": "blocked",
  "error": "truncated_source_overwrite",
  "documentId": "...",
  "cardId": "...",
  "fields": ["back"],
  "mutationApplied": false,
  "retryable": false
}
```

此时应放弃整字段替换或先取得字段全文；只有用户明确同意丢弃超限内容时才显式传 `allowTruncatedSource=true` 重试。

成功更新返回：

```json
{
  "status": "ok",
  "documentId": "...",
  "card": { "id": "...", "version": "..." },
  "mutationApplied": true,
  "retryable": false,
  "uiSync": {
    "status": "ok",
    "blockId": "blk_...",
    "eventAttempted": true
  }
}
```

若数据库写入成功但聊天块持久化失败，顶层 `status=partial`，`mutationApplied=true`，`uiSync.status=failed`。此时不要用旧版本重试写入，应重新 `get_cards`。

当前会话没有该文档的 `anki_cards` 预览块时，成功更新仍返回顶层 `status=ok`，但 `uiSync={"status":"not_required","eventAttempted":false}`。APKG 导入文档通常属于此路径。

版本冲突是结构化成功结果：

```json
{
  "status": "conflict",
  "error": "version_conflict",
  "documentId": "...",
  "current": { "id": "...", "version": "当前版本" },
  "retryable": true
}
```

冲突后必须保留 `current` 中用户的最新内容，重新构造 patch。其他失败没有统一业务码，包括空 patch、卡片内容无效、UI 同步预检失败、数据库失败和 `blocks.ankiCards.errors.statusNotFound`。

### `builtin-chatanki_batch_update_cards`

批量修改同一文档中的 1~100 张卡，单次调用替代 N 次 `update_card`。每一项复用 `update_card` 的 CAS + patch 语义与截断防御；成功项汇总为**一次**预览块 patch 同步与 `fsrs://changed` 事件。敏感度 Medium；技能层要求一次修改超过 3 张先经 `ask_user` 确认。

参数：

| 参数 | 必填 | 约束 |
|---|---|---|
| `documentId` | 是 | 当前会话拥有的文档；所有卡必须属于该文档 |
| `updates` | 是 | `1..100` 项，`cardId` 不得重复；每项含 `cardId`、`expectedVersion`、非空 `patch` |
| `allowTruncatedSource` | 否 | 默认 `false`；截断防御豁免，对整批生效 |

实现说明：逐卡各自在既有的 `IMMEDIATE` 事务 CAS 原语中执行（非整批单事务原子提交）——冲突/拒绝的卡被跳过，成功的卡生效，与逐卡报告语义一致；不要把顶层 `status` 当作全批原子成功的凭证。

返回（外层 `success=true` 的结构化结果）：

```json
{
  "status": "partial",
  "documentId": "...",
  "total": 5,
  "updated": 3,
  "conflicts": 1,
  "blocked": 1,
  "failed": 0,
  "results": [
    { "cardId": "...", "status": "ok", "card": { "id": "...", "version": "新版本" } },
    { "cardId": "...", "status": "conflict", "error": "version_conflict", "current": {} },
    { "cardId": "...", "status": "blocked", "error": "truncated_source_overwrite", "fields": ["back"] }
  ],
  "mutationApplied": true,
  "retryable": true,
  "uiSync": {}
}
```

顶层 `status`：全部成功且 UI 同步成功为 `ok`；部分成功（或成功但 UI 同步失败）为 `partial`；零成功时按冲突/防御/失败依次为 `conflict`/`blocked`/`failed`。逐卡 `results[].status` 取值 `ok`/`conflict`/`blocked`/`invalid`/`not_found`/`rejected`/`failed`。任何 `conflict` 项都必须重新 `get_cards` 刷新版本后重试，不得复用旧 token。参数无效、文档所有权拒绝、数据库不可用是工具失败（外层 `success=false`）。

### `builtin-chatanki_delete_card`

按双乐观锁删除一张当前会话完整拥有其文档的卡片。删除会在单个 `IMMEDIATE` 事务内复验完整文档归属、内容版本和 FSRS 状态存在性/`local_version`，然后物理移除 `anki_cards` 行及对应的 FSRS 状态与复习历史。

三个参数都必填，并且必须来自最近一次 `builtin-chatanki_get_cards` 的同一卡片快照：

| 参数 | 约束 |
|---|---|
| `cardId` | 当前会话完整拥有其文档的真实卡片 ID |
| `expectedVersion` | 卡片的 `version` 内容版本 |
| `expectedReviewVersion` | 已入队时传 `reviewState.reviewVersion`；未入队即 `reviewState=null` 时必须显式传 `null` |

成功返回 `status`、`documentId`、`cardId`、`deleted=true`、`mutationApplied=true`、`retryable=false` 和 `uiSync`。`status` 可能为 `ok` 或前述 UI 同步失败时的 `partial`。

版本过期时外层工具调用仍成功，且不会删除卡片、清理 FSRS 或发送 UI 删除事件：

```json
{
  "status": "conflict",
  "error": "version_conflict",
  "documentId": "...",
  "current": { "id": "...", "version": "当前版本" },
  "retryable": true
}
```

FSRS 状态在读取后发生入队、评分、暂停、恢复或撤销时，返回同样不会写数据的复习冲突：

```json
{
  "status": "conflict",
  "error": "review_state_conflict",
  "documentId": "...",
  "current": { "id": "...", "version": "...", "reviewState": { "reviewVersion": 2 } },
  "mutationApplied": false,
  "retryable": true
}
```

任何冲突后都必须重新调用 `get_cards`，基于完整 `current` 和用户意图决定是否使用新 token 重试；不得复用旧 `expectedVersion` / `expectedReviewVersion`，也不得把未知状态猜成 `null`。

当前会话没有该文档的预览块时，删除只写数据库，`uiSync.status=not_required` 且 `eventAttempted=false`。错误包括缺少必填 token、非法复习版本、数据库/UI 同步失败和 `blocks.ankiCards.errors.statusNotFound`。一次需要删除超过 3 张时，必须在逐张调用前先征得用户确认。

### `builtin-chatanki_delete_cards`

批量删除同一文档中的 1~100 张卡，单次调用替代 N 次 `delete_card`。每一项复用 `delete_card` 的双 CAS 语义（内容 `version` + 复习 `reviewVersion`，未入队时后者显式传 `null`），逐卡返回结果；成功删除汇总为**一次**预览块 delete patch 与 `fsrs://changed` 事件。敏感度 Medium；技能层要求一次删除超过 3 张先经 `ask_user` 确认。

参数：

| 参数 | 必填 | 约束 |
|---|---|---|
| `cards` | 是 | `1..100` 项，`cardId` 不得重复；每项含 `cardId`、`expectedVersion`、显式 nullable `expectedReviewVersion` |

选择必须来自同一文档：跨文档选择返回 `status=rejected`、`error=cross_document_selection` 且不写数据。所有卡都不可见/不属于当前会话时返回统一 not-found 工具失败。实现说明与 `batch_update_cards` 相同：逐卡各自使用既有 `IMMEDIATE` 事务原语，冲突项跳过、成功项生效。

返回：

```json
{
  "status": "partial",
  "documentId": "...",
  "total": 4,
  "deleted": 2,
  "conflicts": 1,
  "failed": 1,
  "deletedCardIds": ["...", "..."],
  "results": [
    { "cardId": "...", "status": "ok", "deleted": true },
    { "cardId": "...", "status": "conflict", "error": "review_state_conflict", "current": {} },
    { "cardId": "...", "status": "not_found", "error": "blocks.ankiCards.errors.statusNotFound" }
  ],
  "mutationApplied": true,
  "retryable": true,
  "uiSync": {}
}
```

逐卡 `results[].status` 取值 `ok`/`conflict`/`not_found`/`failed`；`conflict` 的 `error` 为 `version_conflict` 或 `review_state_conflict`，都要求重新 `get_cards` 取新快照。批量删除同样不做部分猜测：不能把 `expectedReviewVersion` 猜成 `null`。

### `builtin-chatanki_add_cards`

向已有文档补充卡片，不重新运行整批生成。

参数：

| 参数 | 必填 | 约束 |
|---|---|---|
| `documentId` | 是 | 当前会话拥有的文档 |
| `cards` | 是 | `1..100` 张 |

每个卡片对象可包含 `front`、`back`、`text`、`tags`、`extraFields`、`templateId`，并必须提供 `front+back` 或 `text`。未提供的 `front/back/tags/extraFields` 使用空值；`extraFields` key 会规范为小写。

成功返回：

```json
{
  "status": "ok",
  "documentId": "...",
  "requested": 3,
  "inserted": 3,
  "skipped": 0,
  "cards": [{ "id": "...", "version": "..." }],
  "mutationApplied": true,
  "retryable": false,
  "uiSync": {}
}
```

`cards` 是实际插入卡片的完整工具视图，包含新 `id/version`。`status` 同样可能因 UI 同步持久化失败变为 `partial`。失败包括数量/内容无效、所有权拒绝、数据库或 UI 同步失败。

当前会话没有该文档的预览块时（包括 `import_apkg` 创建的文档），新增卡片仍正常入库，`uiSync.status=not_required` 且 `eventAttempted=false`；不会把 APKG 的全量卡片写进聊天块。

### `builtin-chatanki_enqueue_review`

将已验收的非诊断卡片加入内置 FSRS 默认牌组。新卡立即到期；已经存在且未删除的 FSRS 状态会幂等跳过。

参数必须且只能选择一种：

| 参数 | 约束 |
|---|---|
| `documentId` | 整批入队；事务内重新解析该文档所有 live、非诊断卡片 |
| `cardIds` | 精确入队 `1..100` 个真实卡片 ID；重复 ID 会去重 |

成功返回：

```json
{
  "status": "ok",
  "enqueued": 8,
  "skipped": 2
}
```

`skipped` 主要表示已经入队的卡片，不是失败。`documentId` 选择器会自动排除 `isErrorCard=true` 的生成诊断卡；显式 `cardIds` 只要包含诊断卡就原子拒绝整批，并在 `output.error.details` 返回 `errorCode=fsrs_diagnostic_card_not_reviewable` 与对应 `cardId`。整批校验和写入在同一事务中，任何所有权变化或缺失卡片会使整批回滚。其他失败包括选择器无效、卡片数量超限、数据库错误和 `blocks.ankiCards.errors.statusNotFound`。

只有用户明确同意加入复习计划后才调用；部分入队只能使用 `get_cards` 返回的真实 `cardIds`。

### `builtin-chatanki_review_stats`

库级只读工具，参数必须是空对象 `{}`。

成功返回：

```json
{
  "status": "ok",
  "total": 120,
  "due": 18,
  "new": 20,
  "learning": 4,
  "review": 80,
  "relearning": 2,
  "suspended": 3,
  "reviews_today": 15
}
```

注意返回字段是 `new` 和 `reviews_today`，不是 Rust 内部字段名 `newCount`/`reviewsToday`。失败只有参数非空、数据库不可用或统计查询错误，没有独立稳定错误码。

### `builtin-chatanki_undo_last_review`

撤销当前会话拥有的一张卡最后一次仍可撤销的 FSRS 评分。该工具不会重新评分，也不会替用户选择下一次评分。

调用前重新 `get_cards`，从同一张卡的同一份 `reviewState` 取得：

| 参数 | 必填 | 约束 |
|---|---|---|
| `cardId` | 是 | 当前会话拥有的真实卡片 ID |
| `expectedReviewVersion` | 是 | 非负整数，等于最新 `reviewState.reviewVersion` |
| `expectedLogId` | 是 | 最新 `reviewState.latestReview.logId`，且 `undoable=true` |

成功返回 `status=ok`、`cardId`、`changed=true` 和撤销后的 `reviewState`。成功撤销会软删除目标 review log、原子恢复评分前调度快照并递增 `reviewVersion`。

若 CAS、最新日志或调度指纹已变化，返回：

```json
{
  "status": "conflict",
  "error": "review_state_conflict",
  "cardId": "...",
  "current": {},
  "mutationApplied": false,
  "retryable": true
}
```

此时必须重新 `get_cards` 并向用户说明变化；不得把 `current` 中的新版本和旧的用户意图拼接后静默重试。缺少、损坏或不适用的撤销快照返回 `status=blocked`、`error` 原因、`current`、`mutationApplied=false`、`retryable=false`。不存在、跨会话、已删除或未入队统一工具失败为 `blocks.ankiCards.errors.statusNotFound`。

### `builtin-chatanki_set_suspended`

设置当前会话拥有的一张已入队卡片的暂停状态。参数：

| 参数 | 必填 | 约束 |
|---|---|---|
| `cardId` | 是 | 当前会话拥有的真实卡片 ID |
| `expectedReviewVersion` | 是 | 非负整数，等于最新 `reviewState.reviewVersion` |
| `suspended` | 是 | `true` 暂停，`false` 恢复 |

成功返回 `status=ok`、`cardId`、`changed` 和最新 `reviewState`。目标已经处于所需状态时 `changed=false`，这是幂等成功，不发送 `fsrs://changed`。实际修改时 `changed=true`、`reviewVersion` 递增，并实时刷新复习界面。

版本变化返回与撤销相同的 `review_state_conflict` 结构；诊断卡等不允许操作的状态返回 `status=blocked`。冲突或拒绝都不会写数据。Agent 只能执行用户明确指定的暂停/恢复，不能把“这张很难”“最近总答错”自行解释为暂停指令。

### `builtin-chatanki_list_library_cards`

分页读取本机完整 live 卡片库。该工具不受当前 ChatV2 会话限制，是后续五个库级写工具唯一的权威观测入口。

| 参数 | 必填 | 默认/约束 |
|---|---|---|
| `search` | 否 | 搜索 `front/back/text/tags`；空白按未提供处理 |
| `templateId` | 否 | 精确匹配模板 ID |
| `schedule` | 否 | `all`、`due`、`not_enqueued`、`suspended`、`enqueued`；默认 `all` |
| `filter` | 否 | `all` 或 `error_only`；默认 `all` |
| `page` | 否 | 默认 `1`，小于 1 规范为 1 |
| `pageSize` | 否 | 默认 `20`，范围 `1..20`，超出时后端钳制 |

结果按 `created_at DESC, id DESC` 稳定分页，返回 `status/total/page/pageSize/search/templateId/schedule/filter/cards` 及顶层 `ratingAvailableToAgent=false`。每张卡包含会话级卡片视图中的内容、`version` 和截断标记，并额外包含：

```json
{
  "documentId": "...",
  "sourceType": "...",
  "sourceId": "...",
  "enqueued": true,
  "isDue": false,
  "reviewState": {
    "cardStateId": "...",
    "reviewVersion": 4,
    "latestReview": { "logId": "...", "undoable": true }
  },
  "ratingAvailableToAgent": false
}
```

`reviewState=null` 只表示已成功读取且该卡未入队。若响应含 `reviewStateUnavailable=true`，说明写入已完成但复习状态重读失败；不得把它当成未入队，也不得据此构造复习状态写操作，必须重新 `list_library_cards`。必须根据 `total/page/pageSize` 翻完所需范围；不能把前 20 条当作完整卡片库。卡片字段沿用工具统一的单字段 2,000 字符上限；发生截断时返回 `truncated=true` 和具体的 `truncatedFields`，不得把截断文本当作完整字段，也不得在未取得完整替换内容时覆盖该字段。`ratingAvailableToAgent=false` 是硬边界：读取结果中的历史 `rating` 不授权 Agent 评分。

### `builtin-chatanki_update_library_card`

带内容 CAS 修改任意一张库卡片。必须先从同一次 `list_library_cards` 取得 `cardId` 和字符串 `version`。

| 参数 | 必填 | 约束 |
|---|---|---|
| `cardId` | 是 | list 返回的真实卡片 ID |
| `expectedVersion` | 是 | 同一快照的内容 `version` |
| `patch` | 是 | 至少一个 `front/back/text/tags/extraFields`；`text=null` 表示清除 |

写后卡片仍必须满足非空 `front+back` 或非空 Cloze `text`。成功返回 `status=ok`（来源聊天块同步或复习状态重读失败时为 `partial`）、`documentId`、更新后 `card`、`mutationApplied=true`、`retryable=false` 和 `uiSync`。复习状态重读失败会带 `reviewStateUnavailable=true`，此时 card 内不提供 `reviewState`，必须重新 list。无来源聊天块时 `uiSync.status=not_required`。

内容版本变化返回 `status=conflict`、`error=version_conflict`、包含最新内容及 `reviewState` 的 `current`、`mutationApplied=false`、`retryable=true`，并明确要求重新 list。不存在的卡是工具失败 `blocks.ankiCards.errors.statusNotFound`。冲突后不得去掉 `expectedVersion` 或换用会话级更新绕过。

### `builtin-chatanki_enqueue_library_review`

把完整库中的 `1..100` 张卡原子加入 FSRS 队列。参数只有 `cards` 数组；每项必须是同一次或仍然最新的 list 快照中的 `{ cardId, expectedVersion }`，`cardId` 不得重复。

成功返回；若复习状态回读失败则顶层 `status=partial` 并带 `reviewStateUnavailable=true`，各卡不提供 `reviewState`，但 `enqueued` 仍然是已成功写入的真实结果：

```json
{
  "status": "ok",
  "enqueued": 8,
  "skipped": 2,
  "cards": [{ "cardId": "...", "reviewState": {} }],
  "mutationApplied": true,
  "retryable": false
}
```

已经入队的卡计入 `skipped`。任一卡内容版本变化会使整批返回 `status=conflict`、`error=version_conflict` 和 `conflicts`；缺失卡返回结构化 `status=not_found`、`error=card_not_found`、`cardIds`；诊断卡等不可入队对象返回 `status=blocked`、原因和 `cardIds`。三种结果都不会部分写入。只有用户明确同意目标集合后才可调用，不能把一次搜索的全部命中项自动入队。

### `builtin-chatanki_set_library_suspended`

暂停或恢复一张已入队的库卡片。参数为 `cardId`、非负整数 `expectedReviewVersion` 和布尔 `suspended`；三者都必须来自用户明确目标及最新 `list_library_cards.reviewState`。

成功返回 `status=ok`、`cardId`、`changed`、`mutationApplied=changed`、`retryable=false` 和最新 `reviewState`。目标已经处于所需状态时 `changed=false`，不发送变更事件。版本冲突返回 `review_state_conflict` 及 `current`；不可操作状态返回 `blocked`；不存在或未入队是 `blocks.ankiCards.errors.statusNotFound` 工具失败。

### `builtin-chatanki_undo_library_last_review`

撤销一张库卡片最后一次仍可撤销的评分。仅当用户明确要求且最新 list 快照满足 `reviewState.latestReview.undoable=true` 时调用，参数为该卡 `cardId`、`expectedReviewVersion` 和同一快照的 `expectedLogId=latestReview.logId`。

成功、冲突、拒绝和 not-found 结构与库级暂停工具一致；成功的 `reviewState` 是撤销后的新快照。冲突 guidance 指向 `list_library_cards`，不得使用旧日志 ID 静默重试。此工具只撤销，不会重新评分；撤销后的 Again/Hard/Good/Easy 必须由用户在复习 UI 选择。

### `builtin-chatanki_delete_library_card`

从完整库删除一张内容卡，并在同一数据库事务内删除对应 FSRS 状态和复习日志。它同时使用内容与复习两个 CAS：

| 参数 | 必填 | 约束 |
|---|---|---|
| `cardId` | 是 | list 返回的真实卡片 ID |
| `expectedVersion` | 是 | 同一快照的内容 `version` |
| `expectedReviewVersion` | 是 | 已入队传 `reviewState.reviewVersion`；未入队即 `reviewState=null` 时必须显式传 `null` |

成功返回 `status=ok/partial`、`documentId`、`cardId`、`deleted=true`、`mutationApplied=true`、`retryable=false` 和 `uiSync`。内容 CAS 变化返回 `error=version_conflict`；FSRS 状态在预检后变化返回 `error=review_state_conflict`；两者都返回最新 `current`、不写数据并要求重新 list。不存在返回统一 not-found 工具失败。

删除是 High 风险。用户明确指定单卡并要求删除时才可执行；目标不唯一或一次计划删除超过 3 张时，必须先汇总目标、数量及后果并调用 `builtin-ask_user`。不能把 `expectedReviewVersion` 猜成 `null`，也不能在冲突后改用会话级删除。

### `builtin-chatanki_retemplate`

在不重做内容的情况下批量更换模板。整批在同一事务内校验选择集和所有版本，任何冲突都不会写入部分结果。

参数：

| 参数 | 必填 | 约束 |
|---|---|---|
| `documentId` | 与 `cardIds` 二选一 | 选择当前文档全部 live 卡片 |
| `cardIds` | 与 `documentId` 二选一 | `1..100` 个不重复真实 ID，且必须来自同一文档 |
| `targetTemplateId` | 是 | 来自 `list_templates` 的激活模板 |
| `strategy` | 是 | `map_only`、`fill_missing` 或 `fill_missing_llm` |
| `expectedVersions` | 是 | `cardId -> version`，必须与本次完整选择精确一致 |

`map_only` 映射已有同名/别名字段并报告缺失字段。`fill_missing` 仍不会调用 LLM 或自动填值，只会在缺字段卡片上额外返回 `source`，供后续 `update_card` 使用。

`fill_missing_llm` 是两阶段策略：

- **Phase 1** 与 `fill_missing` 完全相同——同一 `IMMEDIATE` 事务内校验选择集与全部版本并换模板，任何冲突都不会写入部分结果；LLM 不可用时在写库前即以工具失败返回。
- **Phase 2** 在 Phase 1 提交后，对仍有 `missingFields` 的卡按批（每批至多 8 张）调用后台模型生成字段值，只允许填该卡列出的缺失字段，然后以 Phase 1 之后的新 `version` 逐卡 CAS 写回。Phase 2 失败**不回滚 Phase 1**：换模板已生效，失败卡只体现在 `fillStatus` 上。

`fill_missing_llm` 的逐卡返回额外携带 `fillStatus` 与 `filledFields`；顶层追加 `fill` 汇总：

| `fillStatus` | 含义 |
|---|---|
| `filled` | 全部缺失字段已生成并 CAS 写回，`version` 已再次前进 |
| `partial` | 部分字段写回，剩余留在 `missingFields`，需 `update_card` 补齐 |
| `skipped` | LLM 未返回该卡可用字段值，未写库 |
| `conflict` | Phase 2 CAS 版本冲突（Phase 1 后另有写入），未写库；重新 `get_cards` |
| `failed` | LLM 调用/解析或写库失败，未写库，`fillError` 给出原因 |
| `not_needed` | 该卡 Phase 1 后没有缺失字段，无需补齐 |

成功返回：

```json
{
  "status": "ok",
  "documentId": "...",
  "targetTemplateId": "design-lexicon",
  "targetNoteType": "Basic",
  "isCloze": false,
  "strategy": "map_only",
  "updated": 10,
  "missingCards": 2,
  "cards": [
    {
      "id": "...",
      "version": "新版本",
      "missingFields": ["example"],
      "missingFieldDetails": [{ "field": "example", "required": true }]
    }
  ],
  "mutationApplied": true,
  "retryable": false,
  "uiSync": {}
}
```

`strategy=fill_missing_llm` 时逐卡追加 `fillStatus`/`filledFields`（失败时含 `fillError`），顶层追加：

```json
{
  "fill": {
    "attempted": 2,
    "filled": 1,
    "partial": 0,
    "skipped": 0,
    "conflicts": 0,
    "failed": 1
  }
}
```

`missingCards` 与逐卡 `missingFields`/`version` 均为 Phase 2 之后的终态。

结构化拒绝/冲突：

| `error` | `status` | 含义与处理 |
|---|---|---|
| `selection_changed` | `conflict` | 卡片已删除或文档集合变化；重新 `get_cards` |
| `expected_versions_mismatch` | `conflict` | `expectedVersions` 缺少或多出卡片；重建完整映射 |
| `version_conflict` | `conflict` | 至少一张卡版本过期；返回 `conflicts`，重新读取全部选择 |
| `invalid_cloze_text` | `blocked` | 目标为 Cloze，但卡片缺少有效 `{{cN::answer}}`；先逐卡 `update_card` |
| `cross_document_selection` | `rejected` | `cardIds` 跨文档；拆成每文档一次调用 |
| `blocks.ankiCards.errors.statusNotFound` | `rejected` 或工具失败 | 所有权拒绝或选择不可见 |

目标模板不存在/未激活分别以工具失败消息 `target_template_not_found`、`target_template_inactive` 返回。成功写入后也可能出现 `status=partial`，含义与其他写卡工具相同。

当前会话没有该文档的预览块时，换模板仍会在完整的 Anki 所有权与乐观锁校验后写入，`uiSync.status=not_required` 且 `eventAttempted=false`。

### `builtin-chatanki_transform`

对选中卡片执行批量程序化变换（批量挖空、术语替换、格式清洗、批量增删标签）。快照直接出自数据库全文（**无 2000 字符截断视图**，不存在截断毒化，无需 `allowTruncatedSource`），写回逐卡复用与 `batch_update_cards` 同源的乐观锁原语，成功项汇总为一次预览块 patch + `fsrs://changed`。

两种互斥的变换定义（`transform.script` 与 `transform.ops` 必须且只能提供一个）：

| 模式 | 能力 | 执行面 | 敏感度 | 平台 |
|---|---|---|---|---|
| `ops` | 声明式安全子集（`regex_replace` / `tag_add` / `tag_remove`，≤20 个按序应用） | 纯 Rust（regex crate，无回溯灾难） | Medium | 全平台（含移动端） |
| `script` | Agent 现写 python/node 脚本（能力全集） | 平台硬沙箱（macOS Seatbelt / Linux bwrap / Windows AppContainer），网络恒禁、仅 job 目录可写 | **High**（审批卡完整展示脚本正文） | 仅桌面端；移动端/缺沙箱/缺解释器结构化拒绝 |

参数：

| 参数 | 必填 | 约束 |
|---|---|---|
| `documentId` | 是 | 当前会话拥有的制卡任务 |
| `selection` | 否 | `cardIds`（1..500 个真实 ID）与 `filter`（`all`/`edited_only`/`error_only`）互斥；缺省为文档全部 live 非诊断卡 |
| `mode` | 否 | `dry_run`（默认，只出 diff 不写库）或 `apply` |
| `transform.ops` | 与 script 二选一 | 声明式操作序列；正则 pattern ≤1024、replacement ≤4096、单 op tags ≤50 |
| `transform.script` | 与 ops 二选一 | `language`（`python`/`node`）+ `code`（≤65536 字符）+ `timeoutMs`（1000..120000，默认 30000） |
| `expectedVersions` | apply 必填 | `cardId -> version` 完整映射，必须与选择集精确一致（与 `retemplate` 相同 CAS 语义）；dry_run 忽略 |
| `purpose` | 否 | 一句话目的说明，进入审批卡与审计 |

#### ops 模式契约

- 全部正则一次性编译，任一失败整批返回 `error=invalid_pattern`（`blocked`，附 `opIndex`/`pattern`/`detail`），不写库。
- `regex_replace` 作用于 `front`/`back`/`text`（`text=null` 的卡自动跳过），替换串支持 `$1`/`$name` 捕获组引用；`tag_add` 去重追加，`tag_remove` 精确删除。

#### script 模式契约（I/O 合同）

执行链：DB 无截断快照 → 会话 temp root 的 job 目录（`runtime-root://temp/chatanki_transform/job-<ts>-<seq>`，保留至会话清理供审计）→ 平台硬沙箱运行脚本 → 输出严格校验 → 与 ops 模式**同一条** CAS 写回路径。

脚本从环境变量 `CHATANKI_INPUT` 指向的 UTF-8 JSON 文件读输入：

```json
{
  "documentId": "…",
  "cards": [
    {
      "id": "…",
      "index": 1,
      "front": "全文，无 2000 字符截断",
      "back": "…",
      "text": null,
      "tags": ["…"],
      "templateId": "design-swiss",
      "extraFields": {},
      "version": "2026-08-24T…Z"
    }
  ]
}
```

把结果写到 `CHATANKI_OUTPUT` 指向的路径（≤32 MiB）：

```json
{
  "cards": [
    { "id": "…", "text": "变换后的 {{c1::术语}} 全文" },
    { "id": "…", "front": "更新的问题", "tags": ["生物", "重点"] }
  ]
}
```

输出校验规则（违反者**逐卡**拒绝，不整批失败）：

| 规则 | 违反时逐卡 `error` |
|---|---|
| 只允许 `front`/`back`/`text`/`tags` 更新键；输入合同键（`id`/`version`/`index`/`templateId`/`extraFields`）回显被静默忽略；其余键拒绝 | `unknown_output_field` |
| `null`/缺省 = 不修改；字符串字段 trim 后必须非空（v1 不支持清空字段）；tags 元素非空 | `empty_field` |
| 字段类型必须匹配（字符串/字符串数组） | `invalid_field_type` |
| 修改 `text` 必须携带合法 `{{cN::答案}}` 挖空标记（N ≥ 1，答案非空，允许 `::hint`） | `invalid_cloze_text` |
| 单卡 tags 去重后 ≤100 | `tags_limit_exceeded` |

不可绕过的硬防线：

- **`version` 回传一律忽略**：CAS 只认快照时 Rust 记录的版本，脚本篡改无效；`apply` 还要求显式携带 `expectedVersions` 双保险。
- **v1 禁止脚本增删卡**：输出中快照之外的 `id` 记入顶层 `unknownCardIds`（不写库、不整批失败）；输出未提及的卡不修改。增删卡走 `add_cards`/`delete_cards` 正门。
- **网络恒禁**（无豁免参数）、只挂载 job 目录可写、环境变量白名单（仅 `CHATANKI_INPUT`/`CHATANKI_OUTPUT`/净化 PATH/UTF-8 locale 等，python 以 `-I` 隔离模式运行）。
- stdout/stderr 仅承载日志，各保留末尾 16KB 进 `script.stdoutTail`/`stderrTail`。

顶层合同违规（非 JSON / 缺 `cards` / 条目缺字符串 `id` / 重复 `id` / 超 32 MiB）整批返回 `error=invalid_script_output`（`failed`），不写库。

#### 返回值

dry_run 返回逐卡 `diff`（before/after 仅展示用途截断；`Invalid` 计划以 `invalid: true` 条目呈现）；apply 返回逐卡 `results`（`ok`/`unchanged`/`invalid`/`conflict`/`not_found`/`failed`，语义与 `batch_update_cards` 一致）。script 模式两者均追加：

```json
{
  "script": {
    "language": "python",
    "exitCode": 0,
    "timedOut": false,
    "timeoutMs": 30000,
    "durationMs": 812,
    "stdoutTail": "…",
    "stderrTail": "",
    "sandbox": "linux_bwrap",
    "interpreter": "/usr/bin/python3"
  },
  "jobPath": "runtime-root://temp/chatanki_transform/job-1756005600000-0001",
  "unknownCardIds": []
}
```

结构化拒绝/失败（均 `mutationApplied=false`，不写库）：

| `error` | `status` | 含义与处理 |
|---|---|---|
| `invalid_pattern` | `blocked` | ops 正则编译失败；按 `opIndex` 修正 |
| `selection_changed` / `selection_too_large` | `conflict` / `blocked` | 与 ops 模式共用的选择集防线 |
| `expected_versions_mismatch` | `conflict` | apply 前置校验（script 模式在沙箱执行**之前** fail-fast） |
| `script_sandbox_unavailable` | `rejected` | 移动端 / Linux 缺 bwrap / macOS 缺 sandbox-exec；改用 ops |
| `script_environment_unavailable` | `rejected` | 无窗口环境无法解析会话 temp root；改用 ops |
| `interpreter_unavailable` | `rejected` | 本机无 python3/python 或 node；装解释器、换 language 或改用 ops |
| `script_setup_failed` | `failed` | job 目录/命令构造/spawn 基础设施失败 |
| `script_timed_out` | `failed` | 超时，进程组已终止；提高 `timeoutMs` 或缩小选择集 |
| `script_failed` | `failed` | 非零退出（含被信号杀死 `exitCode=null`）；看 `stderrTail` |
| `script_output_missing` | `failed` | 0 退出但未写 `$CHATANKI_OUTPUT` |
| `script_output_too_large` | `failed` | 输出超 32 MiB；只回传变更卡与变更字段 |
| `invalid_script_output` | `failed` | 顶层输出合同违规，见 `detail` |

敏感度：`transform.ops` Medium；`transform.script` **High**（`sensitivity_level_for_call` 按参数动态分级，对齐 shell script-runner 恒 High 的纪律）。审批卡展示的参数对 chatanki 工具原样透传，因此脚本正文完整可见。技能层纪律：首次变换必须先 dry_run；apply 影响超过 3 张卡先 `ask_user`。

### `builtin-chatanki_control`

控制文档后台任务。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `action` | 是 | `pause`、`resume`、`retry`、`cancel` |
| `documentId` | 是 | 当前会话拥有的文档 |
| `taskId` | 否 | 仅 `retry` 的高级用法；必须属于该文档 |

不传 `taskId` 的 `retry` 会根据文档失败/错误卡片构建统一重试任务，并恢复文档处理；传入时只把指定分段置为 `pending` 后恢复。统一重试会追加修复结果，不会按生成数量猜测并自动删除旧诊断卡；验收修复结果后可用 `delete_card` 明确删除旧错误卡。`cancel` 保留已经生成的卡片。

成功返回：

```json
{
  "status": "ok",
  "action": "retry",
  "documentId": "...",
  "counts": {
    "counts": {},
    "completedRatio": 0.5
  }
}
```

错误包括不支持的 action、LLM/数据库不可用、动作执行失败、`taskId` 不属于文档，以及 `blocks.ankiCards.errors.statusNotFound`。

### `builtin-chatanki_export`

把当前文档中的非错误卡片导出为 APKG 或 JSON。调用前应完成 `get_cards` 验收并取得用户明确确认。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `documentId` | 是 | 当前会话拥有的文档 |
| `format` | 是 | `apkg` 或 `json` |
| `deckName` | 否 | 默认取设置或 `Default` |
| `noteType` | 否 | 默认取设置或 `Basic`；全 Cloze 批次自动改为 `Cloze` |
| `templateId` | 否 | APKG 中卡片缺少模板 ID 时的回退模板 |
| `suggestedName` | 否 | 建议文件名，不是输出路径 |

成功返回：

```json
{
  "status": "ok",
  "documentId": "...",
  "format": "apkg",
  "path": "/absolute/output/path.apkg",
  "deckName": "Default",
  "noteType": "Basic",
  "cardsCount": 20,
  "hiddenOverLimitCount": 3,
  "exportedMedia": 2
}
```

导出包含库中该文档的全部非错误卡，含因 `maxCards` 超限保留、未展示在预览块的卡；`hiddenOverLimitCount` 表示其中的隐藏卡数量，因此 `cardsCount` 可能大于块内可见数，应向用户说明。

APKG 导出会把卡片 `images` 引用的本地媒体（图片与音频，含 `import_apkg` 落盘的媒体）按 Anki 规范打回包内（清单键 `"0","1",...` 指向文件名），`exportedMedia` 是实际打包数。磁盘缺失或超过 256 MiB 单文件上限的媒体不会中断导出：路径列入 `missingMedia` 数组、细节写入 `mediaWarnings`；两个字段仅在非空时返回，出现时必须向用户如实汇报，不得静默忽略。`format=json` 不打包媒体，也没有这三个字段。

APKG 支持同一包内按卡片 `templateId` 建立多个 Anki model。若某些卡无模板，优先使用显式 `templateId`，其次使用整批唯一模板；仍无法解析时返回 `blocks.ankiCards.errors.templateNotFound`。

其他失败包括 `blocks.ankiCards.errors.statusNotFound`、没有可导出的非错误卡片、格式不支持、模板加载/文件写入失败。除上述 i18n key 外多数是错误消息，不是稳定错误码。

### `builtin-chatanki_sync`

通过本机 AnkiConnect 将当前文档中的非错误卡片写入桌面 Anki。可先调用 `check_anki_connect`。

公开 Schema 参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `documentId` | 是 | 当前会话拥有的文档 |
| `deckName` | 否 | 默认取设置或 `Default` |
| `noteType` | 否 | 默认取设置或 `Basic`；全 Cloze 批次强制使用 `Cloze` |

执行器还保留 `templateId`、`templateIds`、`templateMode` 兼容字段，但当前 Agent 工具 Schema 未公开，不能依赖它们作为稳定调用契约。默认会从卡片已有 `templateId` 推断 model，并在需要时创建自定义 Anki model。

返回：

```json
{
  "status": "ok",
  "documentId": "...",
  "deckName": "Default",
  "noteType": "Basic",
  "total": 20,
  "added": 18,
  "duplicates": 2,
  "failed": 0,
  "createdModels": [],
  "receiptWritten": 18,
  "error": null,
  "warning": null
}
```

三态语义：

- `ok`：`failed=0`，包括全部卡片已存在的幂等成功；
- `partial`：既有新增或重复，又有真实失败，外层工具结果仍成功；`warning.code=anki_sync_partial`；
- `error`：全部真实失败，外层 `success=false`，`error=blocks.ankiCards.errors.ankiSyncEmpty`。

`duplicates` 不是失败。常见稳定错误 key 还有 `blocks.ankiCards.errors.ankiConnectUnavailable`、`blocks.ankiCards.errors.missingClozeNoteType` 和 `blocks.ankiCards.errors.statusNotFound`。网络、AnkiConnect API 或模型创建失败可能以原始消息返回。

### `builtin-chatanki_list_templates`

列出本地模板及 Agent 换模板所需的字段契约。若模板库为空，执行器会尝试导入内置模板。

参数：

| 参数 | 必填 | 默认/语义 |
|---|---|---|
| `category` | 否 | 在 ID、名称、描述和 note type 中做不区分大小写的包含匹配 |
| `activeOnly` | 否 | 默认 `true` |
| `page` | 否 | 默认 `1`；`0` 按 `1` 处理；负数参数无效 |
| `pageSize` | 否 | 默认 `20`；限制为 `1..50` |

系统先应用 `activeOnly/category` 筛选，再对筛选结果分页。成功返回 `status=ok`、`activeOnly`、`query`、`total`、`page`、`pageSize`、`count` 和 `templates`：`total` 是筛选后的总数，`count` 是当前页 `templates` 数量；尾页可少于 `pageSize`，越过尾页时 `templates=[]`、`count=0`，但 `total` 保持不变。每个模板项包含：

- `id`、`name`、`description`、固定的 `category=general`；
- `noteType`、`isCloze`、`fields`、`field_extraction_rules`；
- `isActive`、`isBuiltIn`；
- `complexityLevel`、`useCaseDescription`、`generation_prompt`。

失败包括参数解析、数据库不可用或模板查询失败，没有独立稳定错误码。

### `builtin-chatanki_analyze`

预分析学习材料，不创建卡片。路由决策与制卡管线共用同一决策函数
（forced > 高置信度 LLM 路由计划 > 引用类型启发式），不再固定推荐 `simple_text`。

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `content` | 二选一 | 文本/Markdown；传 `resourceIds` 时可省略 |
| `resourceId` / `resourceIds` | 二选一 | 要预分析的资源 ID；解析出引用元数据后走与 `chatanki_run` 相同的 LLM 路由规划（失败/低置信度回退启发式）。解析失败 fail-open：降级为纯文本分析并写入 `warnings[].code=analyze_refs_unresolved` |
| `goal` | 否 | 进入路由规划提示词参与决策（不再只是回显） |
| `route` | 否 | 预演强制路由（`simple_text/vlm_light/vlm_full`）；非法值直接失败 |

成功返回：

```json
{
  "status": "ok",
  "goal": null,
  "metrics": {
    "chars": 1200, "nonEmptyLines": 60, "entryLikeLines": 45,
    "refTotal": 2, "refFiles": 1, "refImages": 1, "refOthers": 0
  },
  "routing": {
    "route": "vlm_light",
    "routeSource": "llm",
    "confidence": 0.85,
    "glossaryMode": true,
    "reason": "少量图表需要视觉补充"
  },
  "recommended": {
    "route": "vlm_light",
    "maxCards": 50,
    "glossaryMode": true,
    "segmentOverlapSize": 0,
    "maxOutputTokensOverride": 2400,
    "temperature": 0.2,
    "pipelineDefaultMaxCards": 0
  }
}
```

- `routing.routeSource ∈ {forced, llm, heuristic}`；`confidence` 仅 `llm` 来源非 null；`metrics.ref*` 仅引用解析成功时出现。
- **可回传 `chatanki_run` 的参数**：`recommended.route`（作 `route` 强制，通常不必传——管线会自己再跑同一条决策链）与 `recommended.maxCards`（1..=100；词汇表 = 条目数 + 余量，封顶 100）。
- **管线内自算、run/start 没有对应参数**（仅供解释预估）：`temperature`、`maxOutputTokensOverride`、`segmentOverlapSize` 来自与 `build_generation_options` 共享的词汇表旋钮函数；`pipelineDefaultMaxCards` 是未显式传 `maxCards` 时的内部默认（`0` 表示词汇表模式不设数值上限）。
- `glossaryMode` 与管线相同取「高置信度 LLM 提示 ∪ 内容启发式」并集。

失败为参数解析错误、`content or resourceIds is required` 或非法 `route`。

### `builtin-chatanki_check_anki_connect`

无参数，调用 `{}`。无论检查服务是否报错，工具本身都会返回结构化成功：

```json
{
  "status": "ok",
  "available": false,
  "error": "连接失败的原始消息或 null"
}
```

因此必须检查 `available`，不能只检查外层 `success`。`available=false` 时不要继续 `sync`，应提示用户启动 Anki 并启用 AnkiConnect。

## 标准工作流

### 新制卡与验收循环

1. 确认材料、目标、`maxCards` 和模板选择。只有直接 `content` 少于 800 字、`maxCards<=10` 且所有必需参数无歧义时，允许省略启动前确认。
2. 原始文件/图片调用 `run`；已清洗 Markdown 调用 `start`。
3. 在下一轮调用 `wait`，遇到 `timeout` 继续等待或用 `status` 查询，直到进入终态。
4. 用 `get_cards` 分页读回全部卡片，检查事实、正反面、Cloze 挖空、必需字段、目标偏离和重复项。
5. 用 `update_card`、`delete_card`、`add_cards` 修正；同一文档内多张卡的修改/删除优先用 `batch_update_cards`/`delete_cards` 一次完成（超过 3 张先 `ask_user` 确认）。删除必须传同一次 `get_cards` 的内容与复习版本；未入队时显式传 `expectedReviewVersion=null`。每次写入后重新 `get_cards`，直到验收通过。
6. 向用户报告生成数、修改数、删除数、补卡数和未决事项。
7. 主动询问是否入队复习。只有同意后调用 `enqueue_review`；导出或同步也必须有用户明确要求或确认。

用户说“第 N 张错了”时，先 `get_cards` 定位真实 `cardId/version/reviewState`，只修改该卡；除非用户明确要求，不得整批重跑。

### 更换模板

1. `list_templates` 查看目标模板的 `noteType`、`fields` 和字段规则；根据 `total/page/pageSize` 翻完所需页面，不能把第一页当作完整模板库。
2. `get_cards` 分页读完完整选择，构造每张卡的 `cardId -> version`。
3. 用户确认后调用 `retemplate(strategy=map_only)`。
4. 检查每张卡的 `missingFields`。若目标为 Cloze，先用 `update_card` 写入有效 `{{cN::...}}` 文本。
5. 按卡调用 `update_card` 补齐字段；`fill_missing` 只提供源内容，不会自动填值。用户明确要求自动补齐时可改用 `fill_missing_llm`，之后按逐卡 `fillStatus` 对 `partial/skipped/conflict/failed` 的卡走 `update_card` 兜底。
6. 再次分页 `get_cards` 验收。任何版本冲突都要刷新完整选择和全部版本，不得复用旧映射。

### APKG 加工闭环

1. 上传资源用 `import_apkg(resourceId)`；明确绝对路径用 `import_apkg(path)`。
2. 记录返回的真实 `documentId`、`importedCards`、`importedTemplates` 和 `mediaSkipped`。
3. 立即分页 `get_cards`，检查 Basic/Cloze 映射、重复项、缺失字段和媒体缺失影响。
4. 使用单卡修改、删卡、补卡或版本化换模板流程加工，每次修改后复核。
5. 用户确认后按需 `export`、`enqueue_review` 或 `sync`。

### 撤销评分与暂停/恢复

1. 先用 `get_cards` 定位目标真实 `cardId` 并读取最新 `reviewState`；`reviewState=null` 时停止。
2. 撤销只在用户明确要求且 `latestReview.undoable=true` 时执行，把同一快照的 `reviewVersion` 和 `latestReview.logId` 原样传入 `undo_last_review`。
3. 暂停/恢复只在用户明确指定方向时执行，把最新 `reviewVersion` 传入 `set_suspended`。
4. `conflict` 时重新读取并报告，不盲重试；`blocked` 时报告原因，不绕过。
5. Agent 不得评分，也不得从用户描述、卡片难度或历史 rating 推断 Again/Hard/Good/Easy。撤销后的下一次评分必须由用户在复习 UI 中完成。

### 完整卡片库闭环

1. 只有用户明确指向卡片库或既有卡片时进入全库流程；先用 `list_library_cards` 搜索/筛选并按 `total/page/pageSize` 翻页定位，不能猜 ID。
2. 目标不唯一时展示足够的区分信息并询问；后续所有 CAS token 必须来自最终选中卡的最新同一快照。
3. 编辑使用 `update_library_card(expectedVersion)`；入队使用最多 100 个不重复 `{cardId, expectedVersion}`，且先取得用户对完整集合的同意。
4. 暂停/恢复及撤销使用 `reviewState.reviewVersion`；撤销还要求同一快照的 `latestReview.logId` 和 `undoable=true`。
5. 删除同时传内容版本和复习版本；未入队时显式传 `expectedReviewVersion=null`。批量删除超过 3 张先确认。
6. 任一 `version_conflict/review_state_conflict/not_found` 后重新 list 并报告变化，不复用旧 token、不盲重试、不切换到会话级工具绕过。
7. 写后再次 list 验证权威终态。全库工具始终不开放评分；需要 Again/Hard/Good/Easy 时打开复习 UI 由用户操作。

### 超过 100 张的大批量

单次 `run`/`start` 的 `maxCards` 上限为 100。目标超过 100 张时：

1. 按 `resourceId`/`resourceIds` 子集拆成多批，每批 `maxCards<=100`；
2. 每批分别 `wait`；
3. 每批分别用 `get_cards` 读回全部卡片并完成修正；
4. 全部批次通过验收后，再汇总各批 `documentId`、生成数和修订数；
5. 不得一次塞入几十个资源后跳过逐批等待和验收。

## 已知边界与后续工作

- `batch_update_cards` / `delete_cards` 逐卡使用既有 `IMMEDIATE` 事务 CAS 原语，不是整批单事务原子提交：冲突卡跳过、成功卡生效（与逐卡报告语义一致）。若未来需要整批原子性，应在 database 层新增批量事务原语。
- APKG 媒体会按清单导入本地 `anki_media/` 并在再导出时打回包内；无法安全落盘的媒体按结构化原因统计并跳过。APKG 模板当前不落入本地模板库，`importedTemplates=0`。
- 统一失败分段重试不会自动删除旧错误诊断卡；必须在 `get_cards` 验收替代卡后显式删除，避免部分修复时误删证据。
- FSRS 目前使用默认牌组，不提供每日新卡上限或 Agent 牌组管理工具。
- `analyze` 与制卡管线共用路由决策函数（Round 3 #7），但引用解析是元数据轻量版（不展开 VFS 存储的完整 ref data），复合引用计数可能与 run 管线有出入；它仍不提供精确卡数预测，`recommended.maxCards` 只是与 skill 口径一致的建议上限。
- `sync` 依赖本机 Anki 和 AnkiConnect；本工具面不改变 AnkiConnect 协议。
- 聊天输入栏不提供模板选择 UI，模板选择由 Agent 工具参数和现有模板管理界面承担。

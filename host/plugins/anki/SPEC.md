# L16-anki 行为规格（`host/plugins/anki/`）

## WP-160：模板原始 owner 方法（承接 WP-119 四项缺口）

公开位置 `api.ts::AnkiTemplateService`，运行时仍为 `AnkiHostService.templates` →
`src/template-service.ts::createAnkiTemplates` → `repository/templates.ts`。输入为已解码
Create/Update 类型；不新增 IPC 命令，不改变旧 facade 的校验、同版本自增或 AppError。

| 方法 / Rust 来源 | 分支与 SQL 落点 | 错误 / 日志 / 事务 |
|---|---|---|
| `importBuiltinTemplatesIfEmpty()`；`chatanki_executor.rs:11742-11861,11357-11414` | 读取 bundled Vec<Value>；id Rust trim 后空值跳过；可读已有行（包括墓碑）跳过；fields_json/rules_json → 字段值 → 默认；空 fields 用 front/back/tags，补缺规则；`createTemplateWithId` 原19列 INSERT | parse 错误 `Parse builtin templates failed: …`；查询失败继续尝试 INSERT，INSERT 失败静默跳过；返回插入数；每条 INSERT 独立提交，无整批事务、事件或新增日志 |
| `updateIfVersion(id, request)`；`database/mod.rs:2713-2836` | 显式 version 原样写（含同值）；缺省/null 时独立 SELECT version，读取错误/非文本/无行回落1.0.0，再 incrementVersion；沿原动态 UPDATE，fields-only 不合并校验；可选 WHERE id AND version | 有 expected_version 且 affected=0 → 原始 Error(`optimistic_lock_failed`)；无 expected 且无行成功；写错误原样抛出；无新事务、预读模板或自动 user_modified |
| `markUserModified(id)`；同文件`:2848-2864,2907-2915` | 原 ensure 两标记列，duplicate column 忽略；仅 is_built_in=1 UPDATE | 原始错误由 L24 在 UPDATE 成功之后 warn；失败不回滚已提交模板，不在 owner 写 L16 warn |
| `countReferencingCards(id)`；`:2867-2882` | 原 live COUNT；任何失败尝试不带 deleted_at 的旧库 COUNT | 第二次失败原样抛出；L24 `template_executor.rs:1486-1495` 自行 warn→0→继续，旧 IPC 仍 Database fail-fast |
| `softDeleteBuiltin(id)`；`:2921-2937` | 原 ensure + UPDATE user_deleted=1/is_active=0/updated_at，保留行与ID | affected=0 → `builtin_template_not_found: <id>`；原始 SQL 错误，无日志/新事务 |
| `deleteCustom(id)`；`:2839-2846` | 原 unconditional DELETE（缺失 no-op） | 原始 SQL 错误；不统计引用、不预读、不附加 facade warn |

L24 负责在正常 main 消费这些方法并保留 `template_executor.rs:764-774` 自动导入 warn、
`:1152-1165` 标记失败 warn、`:1486-1530` 计数失败 warn 与删除失败前缀。本包只交付供方，
不改消费者；现有 list/get/create/update/delete 高层命令行为继续由 WP-015 17例验证。
真实 owner 回归在 `tests/template-owner-primitives.test.ts`：同版本/fields-only、原始错误、
两条独立 SQLite 连接在 SELECT 与 UPDATE 之间的真实竞争写、affected0、墓碑不复活、
标记失败保已提交更新、COUNT故障及旧列 fallback。它们不是新增 Rust TESTMAP 移植条目。

## WP-015 / B6-D19：模板 owner facade 来源（2026-11-05）

开工逐项核对；下列路径均相对仓库。main 已有相同生产命令及仓储实现，
本包从 handler 提取同一实现给正式 `ctx.anki.templates`，命令反向委托该服务。

| 方法 | Rust 命令 | Rust 仓储 `src-tauri/crates/dstu-storage/src/database/mod.rs` | 开工 TS 来源 |
|---|---|---|---|
| list | `src-tauri/src/commands.rs:4280-4288` | `2552-2622`：created_at DESC/id ASC，NULL description、JSON fallback、时间解码 | `src/plugin-handlers-templates.ts:55-63`；`repository/templates.ts:9-21` |
| get | `src-tauri/src/commands.rs:4292-4301` | `2625-2694`：不存在 None，同 list 行解码 | 同 handler `65-74`；repository `14-25` |
| create | `src-tauri/src/commands.rs:4304-4317` | `2462-2504`：UUID v4、默认版本/布尔、同一 now 写两列、单条 INSERT | 同 handler `76-87`；repository `28-57` |
| update | `src-tauri/src/commands.rs:4321-4392` | `2697-2836,2907-2915`：版本递增/显式覆盖、WHERE version CAS、内建 user_modified | 同 handler `89-129`；repository `66-132,203-206` |
| delete | `src-tauri/src/commands.rs:4403-4462` | `2839-2882,2921-2938`：活卡引用计数/旧库 fallback、内建停用墓碑、自建物理删除 | 同 handler `131-176`；repository `169-218` |

- 校验与顺序：Rust `commands.rs:6045-6191` → `src/templates.ts:415-475`。
  update 先 missing，再缺 expected_version，再版本冲突，再合并校验；显式同版本改为自动递增。
  内建模板允许编辑；标记失败 warn 后仍成功；delete 计数失败必须终止，删除后引用 warn。
- 事务：上述 Rust CRUD 无显式多语句事务；UPDATE/INSERT/DELETE 各自原子，
  user_modified 是 UPDATE 成功后的 best-effort，不将它们合并成新事务。
- 错误：命令级 `CommandError.value={error_type,message,details:null}` 原前缀；
  get 缺失返回 null，update/delete 缺失为 Validation；写失败保 Database 上下文。
- 数据边界：沿用生成的 Create/Update/CustomAnkiTemplate 类型；IPC 仍由 kernel serde 校验，
  进程内 facade 接收调用方已解码的 typed request（非任意 JSON 接口）。
- 审读发现：旧 `decodeTemplateRow` 缺坏日期 warn、旧 validator 缺未知引用 warn；
  本包在共同 helper 补齐相关分支并使用已发布 time/util 原语，先增加真实 provider 回归。
  不将这五入口的证据外推为全模板导入或全 lane v2 签收。

<!-- BEGIN GENERATED:spec:header -->
逐条对照 Rust 源码填写（README §3.3）。每节下的清单项全部勾选（`- [x]`）即视为该节完成，ledger 据此计算 B 级；
勾选前在冒号后写明结论与 Rust 依据（文件:行）。生成区块由 `npm run migration:scaffold -- --refresh` 维护。

命令 61 个 · 发出事件 2 种 · 契约：`contracts/ipc/L16-anki.json`
<!-- END GENERATED:spec:header -->

## 全局语义（README §3.3）

<!-- BEGIN GENERATED:spec:global -->
本 lane 全部命令共同适用的约定；与某个命令不同时在该命令一节单独说明。
<!-- END GENERATED:spec:global -->

- [ ] Option → null 还是缺省（`skip_serializing_if`）：
- [ ] u64/i64 超过 2^53 的表示：
- [ ] 字段顺序（serde_json preserve_order）：
- [ ] f32 精度：
- [ ] 错误形状（字符串 / 对象、文案、错误码）与 panic 的前端可见结果：
- [ ] 取消：CancellationToken / drop → AbortSignal，取消点一致：
- [ ] 并发：锁 / 单写者 / 队列在 Node 中的对应（await 交错）：
- [ ] 时间与 ID：生成方式、格式、时区：
- [ ] 不对含 HashMap 的结构做序列化后比对：

## 命令 `add_cards_to_anki_connect`

<!-- BEGIN GENERATED:cmd:add_cards_to_anki_connect -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:226` · async
- 前端：app（3 处，例 `src/components/anki/cardforge/engines/CardAgent.ts:736`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：selectedCards: AnkiCard__De[], deckName: string, noteType: string
  - 结果：AnkiSyncReport · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:add_cards_to_anki_connect -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `anki_get_deck_names`

<!-- BEGIN GENERATED:cmd:anki_get_deck_names -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:198` · async
- 前端：app（1 处，例 `src/features/settings/components/AnkiConnectSettingsSection.tsx:53`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：string[] · 错误：AppError
<!-- END GENERATED:cmd:anki_get_deck_names -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `batch_export_cards`

<!-- BEGIN GENERATED:cmd:batch_export_cards -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:1323` · async
- 前端：app（1 处，例 `src/services/ankiApiAdapter.ts:88`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：notes: BatchExportNote[], format: string, options: BatchExportOptions
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:batch_export_cards -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `cancel_document_processing`

<!-- BEGIN GENERATED:cmd:cancel_document_processing -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:140` · async
- 前端：app（2 处，例 `src/components/anki/cardforge/engines/CardAgent.ts:628`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：documentId: string
  - 结果：boolean · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:cancel_document_processing -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `check_anki_connect_availability`

<!-- BEGIN GENERATED:cmd:check_anki_connect_availability -->
- Rust：`src-tauri/crates/dstu-anki/src/anki_connect_service.rs:308` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：boolean · 错误：string
<!-- END GENERATED:cmd:check_anki_connect_availability -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `check_anki_connect_status`

<!-- BEGIN GENERATED:cmd:check_anki_connect_status -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:180` · async
- 前端：app（2 处，例 `src/features/chat/plugins/blocks/ankiCardsBlock.tsx:2150`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：boolean · 错误：AppError
<!-- END GENERATED:cmd:check_anki_connect_status -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `count_custom_template_references`

<!-- BEGIN GENERATED:cmd:count_custom_template_references -->
- Rust：`src-tauri/src/commands.rs:4465` · async
- 前端：app（1 处，例 `src/features/template-management/TemplateManagementApp.tsx:997`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：templateId: string
  - 结果：integer(i64) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:count_custom_template_references -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `create_anki_deck`

<!-- BEGIN GENERATED:cmd:create_anki_deck -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:213` · async
- 前端：app（1 处，例 `src/services/ankiConnectClient.ts:63`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：deckName: string
  - 结果：null · 错误：AppError
<!-- END GENERATED:cmd:create_anki_deck -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `create_custom_template`

<!-- BEGIN GENERATED:cmd:create_custom_template -->
- Rust：`src-tauri/src/commands.rs:4303` · async
- 前端：app（1 处，例 `src/data/ankiTemplates.ts:267`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：request: CreateTemplateRequest
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:create_custom_template -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `delete_anki_card`

<!-- BEGIN GENERATED:cmd:delete_anki_card -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:287` · async
- 前端：app（3 处，例 `src/features/chat/plugins/blocks/pendingCardDeletes.ts:67`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：cardId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:delete_anki_card -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `delete_custom_template`

<!-- BEGIN GENERATED:cmd:delete_custom_template -->
- Rust：`src-tauri/src/commands.rs:4402` · async
- 前端：app（1 处，例 `src/data/ankiTemplates.ts:276`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：templateId: string
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:delete_custom_template -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `delete_document_session`

<!-- BEGIN GENERATED:cmd:delete_document_session -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:325` · async
- 前端：app（1 处，例 `src/features/anki-tasks/components/SessionRow.tsx:143`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：documentId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:delete_document_session -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `delete_document_task`

<!-- BEGIN GENERATED:cmd:delete_document_task -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:306` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：taskId: string
  - 结果：boolean · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:delete_document_task -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `dismiss_pending_memory_candidates`

<!-- BEGIN GENERATED:cmd:dismiss_pending_memory_candidates -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:786` · async
- 前端：app（1 处，例 `src/utils/graphApi.ts:103`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：conversationId: string
  - 结果：integer(u32) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:dismiss_pending_memory_candidates -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `export_anki_cards`

<!-- BEGIN GENERATED:cmd:export_anki_cards -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:646` · async
- 前端：app（1 处，例 `src/utils/chatApi.ts:285`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：request: ExportAnkiCardsRequest
  - 结果：ExportAnkiCardsResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:export_anki_cards -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `export_apkg_for_selection`

<!-- BEGIN GENERATED:cmd:export_apkg_for_selection -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:347` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：documentId?: string | null, taskIds?: string[] | null, cardIds?: string[] | null, options: AnkiGenerationOptions
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:export_apkg_for_selection -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `export_cards_as_apkg`

<!-- BEGIN GENERATED:cmd:export_cards_as_apkg -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:947` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：selectedCards: AnkiCard__De[], deckName: string, noteType: string
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:export_cards_as_apkg -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `export_cards_as_apkg_with_template`

<!-- BEGIN GENERATED:cmd:export_cards_as_apkg_with_template -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:977` · async
- 前端：app（1 处，例 `src/services/ankiApiAdapter.ts:92`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：selectedCards: AnkiCard__De[], deckName: string, noteType: string, templateId?: string | null
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:export_cards_as_apkg_with_template -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `export_multi_template_apkg`

<!-- BEGIN GENERATED:cmd:export_multi_template_apkg -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:1123` · async
- 前端：app（1 处，例 `src/features/chat/anki/index.tsx:375`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：cards: AnkiCard__De[], deckName: string, outputPath?: string | null
  - 结果：ExportMultiTemplateApkgResult · 错误：AppError · 注入：state, window
<!-- END GENERATED:cmd:export_multi_template_apkg -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `export_template`

<!-- BEGIN GENERATED:cmd:export_template -->
- Rust：`src-tauri/src/commands.rs:4476` · async
- 前端：app（1 处，例 `src/features/template-management/TemplateManagementApp.tsx:341`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：templateId: string
  - 结果：TemplateExportResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:export_template -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `generate_anki_cards_from_document`

<!-- BEGIN GENERATED:cmd:generate_anki_cards_from_document -->
- Rust：`src-tauri/src/commands.rs:3911` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：request: AnkiDocumentGenerationRequest
  - 结果：AnkiDocumentGenerationResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:generate_anki_cards_from_document -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `generate_anki_cards_from_document_base64`

<!-- BEGIN GENERATED:cmd:generate_anki_cards_from_document_base64 -->
- Rust：`src-tauri/src/commands.rs:3998` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：fileName: string, base64Content: string, options?: AnkiGenerationOptions | null
  - 结果：AnkiDocumentGenerationResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:generate_anki_cards_from_document_base64 -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `generate_anki_cards_from_document_file`

<!-- BEGIN GENERATED:cmd:generate_anki_cards_from_document_file -->
- Rust：`src-tauri/src/commands.rs:3950` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：filePath: string, options?: AnkiGenerationOptions | null
  - 结果：AnkiDocumentGenerationResponse · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:generate_anki_cards_from_document_file -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_all_custom_templates`

<!-- BEGIN GENERATED:cmd:get_all_custom_templates -->
- Rust：`src-tauri/src/commands.rs:4279` · async
- 前端：app（4 处，例 `src/data/ankiTemplates.ts:53`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：CustomAnkiTemplate[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_all_custom_templates -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_all_recent_cards`

<!-- BEGIN GENERATED:cmd:get_all_recent_cards -->
- Rust：`src-tauri/src/commands.rs:7075` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：limit?: integer(u32) | null
  - 结果：AnkiCard[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_all_recent_cards -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_anki_deck_names`

<!-- BEGIN GENERATED:cmd:get_anki_deck_names -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:189` · async
- 前端：app（1 处，例 `src/services/ankiConnectClient.ts:55`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：string[] · 错误：AppError
<!-- END GENERATED:cmd:get_anki_deck_names -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_anki_library_card_content`

<!-- BEGIN GENERATED:cmd:get_anki_library_card_content -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:460` · async
- 前端：app（1 处，例 `src/features/chat/components/input-bar/AnkiCardUpdateDiff.tsx:113`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：cardId: string
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_anki_library_card_content -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_anki_model_names`

<!-- BEGIN GENERATED:cmd:get_anki_model_names -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:204` · async
- 前端：app（2 处，例 `src/features/settings/components/AnkiConnectSettingsSection.tsx:54`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：string[] · 错误：AppError
<!-- END GENERATED:cmd:get_anki_model_names -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_anki_stats`

<!-- BEGIN GENERATED:cmd:get_anki_stats -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:612` · async
- 前端：app（1 处，例 `src/features/anki-tasks/AnkiTasksApp.tsx:235`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_anki_stats -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_custom_template_by_id`

<!-- BEGIN GENERATED:cmd:get_custom_template_by_id -->
- Rust：`src-tauri/src/commands.rs:4291` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：templateId: string
  - 结果：CustomAnkiTemplate | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_custom_template_by_id -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_default_template_id`

<!-- BEGIN GENERATED:cmd:get_default_template_id -->
- Rust：`src-tauri/src/commands.rs:6239` · async
- 前端：app（4 处，例 `src/components/anki/cardforge/engines/CardAgent.ts:1244`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：string | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_default_template_id -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_document_cards`

<!-- BEGIN GENERATED:cmd:get_document_cards -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:379` · async
- 前端：app（5 处，例 `src/components/anki/cardforge/engines/CardAgent.ts:1385`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：documentId: string
  - 结果：AnkiCard[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_document_cards -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_document_processing_state`

<!-- BEGIN GENERATED:cmd:get_document_processing_state -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:181` · async
- 前端：app（1 处，例 `src/components/anki/cardforge/engines/TaskController.ts:452`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：documentId: string
  - 结果：DocumentStateDto · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_document_processing_state -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_document_task_counts`

<!-- BEGIN GENERATED:cmd:get_document_task_counts -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:195` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：documentId: string
  - 结果：DocumentTaskCountsDto · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_document_task_counts -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_document_tasks`

<!-- BEGIN GENERATED:cmd:get_document_tasks -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:229` · async
- 前端：app（7 处，例 `src/components/anki/cardforge/engines/CardAgent.ts:1358`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：documentId: string
  - 结果：DocumentTask[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_document_tasks -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_model_adapter_options`

<!-- BEGIN GENERATED:cmd:get_model_adapter_options -->
- Rust：`src-tauri/src/cmd/anki_cards.rs:19` · async
- 前端：app（1 处，例 `src/features/settings/components/ShadApiEditModal.tsx:634`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：Value[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_model_adapter_options -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_pending_memory_candidates`

<!-- BEGIN GENERATED:cmd:get_pending_memory_candidates -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:725` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：conversationId: string
  - 结果：PendingMemoryCandidatesResponse | null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_pending_memory_candidates -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `get_task_cards`

<!-- BEGIN GENERATED:cmd:get_task_cards -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:247` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：taskId: string
  - 结果：AnkiCard[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:get_task_cards -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `import_anki_package`

<!-- BEGIN GENERATED:cmd:import_anki_package -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:413` · async
- 前端：app（1 处，例 `src/services/ankiConnectClient.ts:67`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：path: string, deleteAfter?: boolean | null
  - 结果：boolean · 错误：AppError
<!-- END GENERATED:cmd:import_anki_package -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `import_apkg_to_library`

<!-- BEGIN GENERATED:cmd:import_apkg_to_library -->
- Rust：`src-tauri/src/cmd/apkg_import.rs:81` · async
- 前端：app（2 处，例 `src/command-palette/modules/anki.commands.ts:50`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：path: string
  - 结果：ApkgImportResult · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:import_apkg_to_library -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `import_builtin_templates`

<!-- BEGIN GENERATED:cmd:import_builtin_templates -->
- Rust：`src-tauri/src/commands.rs:4898` · async
- 前端：app（4 处，例 `src/data/ankiTemplates.ts:46`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:import_builtin_templates -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `import_custom_templates_bulk`

<!-- BEGIN GENERATED:cmd:import_custom_templates_bulk -->
- Rust：`src-tauri/src/commands.rs:4579` · async
- 前端：app（1 处，例 `src/features/template-management/TemplateManagementApp.tsx:506`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：request: TemplateBulkImportRequest
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:import_custom_templates_bulk -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `import_template`

<!-- BEGIN GENERATED:cmd:import_template -->
- Rust：`src-tauri/src/commands.rs:4504` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：request: TemplateImportRequest
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:import_template -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `list_anki_library_cards`

<!-- BEGIN GENERATED:cmd:list_anki_library_cards -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:477` · async
- 前端：app（4 处，例 `src/features/flashcards/hooks/useReviewActivity.ts:193`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：request: ListAnkiCardsRequest
  - 结果：Value · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:list_anki_library_cards -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `list_document_sessions`

<!-- BEGIN GENERATED:cmd:list_document_sessions -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:559` · async
- 前端：app（3 处，例 `src/features/anki-tasks/AnkiTasksApp.tsx:234`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：limit?: integer(u32) | null
  - 结果：Value[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:list_document_sessions -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `mark_pending_memory_candidates_saved`

<!-- BEGIN GENERATED:cmd:mark_pending_memory_candidates_saved -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:814` · async
- 前端：app（1 处，例 `src/utils/graphApi.ts:116`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：conversationId: string
  - 结果：integer(u32) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:mark_pending_memory_candidates_saved -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `pause_document_processing`

<!-- BEGIN GENERATED:cmd:pause_document_processing -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:121` · async
- 前端：app（2 处，例 `src/components/anki/cardforge/engines/CardAgent.ts:594`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：documentId: string
  - 结果：boolean · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:pause_document_processing -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `read_anki_media`

<!-- BEGIN GENERATED:cmd:read_anki_media -->
- Rust：`src-tauri/src/cmd/apkg_import.rs:306` · async
- 前端：app（1 处，例 `src/components/anki/utils/cardMedia.ts:24`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：path: string
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:read_anki_media -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `recover_stuck_document_tasks`

<!-- BEGIN GENERATED:cmd:recover_stuck_document_tasks -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:547` · async
- 前端：app（1 处，例 `src/features/anki-tasks/AnkiTasksApp.tsx:318`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：integer(u32) · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:recover_stuck_document_tasks -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `reset_model_adapter_options`

<!-- BEGIN GENERATED:cmd:reset_model_adapter_options -->
- Rust：`src-tauri/src/cmd/anki_cards.rs:57` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：（无）
  - 结果：Value[] · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:reset_model_adapter_options -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `resume_document_processing`

<!-- BEGIN GENERATED:cmd:resume_document_processing -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:162` · async
- 前端：app（2 处，例 `src/components/anki/cardforge/engines/CardAgent.ts:601`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：documentId: string
  - 结果：boolean · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:resume_document_processing -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `save_anki_cards`

<!-- BEGIN GENERATED:cmd:save_anki_cards -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:925` · async
- 前端：app（1 处，例 `src/services/ankiApiAdapter.ts:127`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：request: SaveAnkiCardsRequest
  - 结果：SaveAnkiCardsResponse · 错误：AppError · 注入：app-handle, state
<!-- END GENERATED:cmd:save_anki_cards -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `save_json_file`

<!-- BEGIN GENERATED:cmd:save_json_file -->
- Rust：`src-tauri/src/cmd/anki_connect.rs:2145` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：content: string, suggestedName: string
  - 结果：string · 错误：AppError
<!-- END GENERATED:cmd:save_json_file -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `save_model_adapter_options`

<!-- BEGIN GENERATED:cmd:save_model_adapter_options -->
- Rust：`src-tauri/src/cmd/anki_cards.rs:28` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：options: Value[]
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:save_model_adapter_options -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `save_template_debug_data`

<!-- BEGIN GENERATED:cmd:save_template_debug_data -->
- Rust：`src-tauri/src/commands.rs:6856` · async
- 前端：none
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：debugData: Value
  - 结果：string · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:save_template_debug_data -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `set_default_template`

<!-- BEGIN GENERATED:cmd:set_default_template -->
- Rust：`src-tauri/src/commands.rs:6230` · async
- 前端：app（1 处，例 `src/data/ankiTemplates.ts:319`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：templateId: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:set_default_template -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `set_document_session_source`

<!-- BEGIN GENERATED:cmd:set_document_session_source -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:623` · async
- 前端：app（1 处，例 `src/features/chat/services/selectionCardGeneration.ts:94`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：documentId: string, sessionId: string
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:set_document_session_source -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `start_enhanced_document_processing`

<!-- BEGIN GENERATED:cmd:start_enhanced_document_processing -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:85` · async
- 前端：app（2 处，例 `src/components/anki/cardforge/engines/CardAgent.ts:380`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：documentContent: string, originalDocumentName: string, options: AnkiGenerationOptions
  - 结果：string · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:start_enhanced_document_processing -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `trigger_task_processing`

<!-- BEGIN GENERATED:cmd:trigger_task_processing -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:209` · async
- 前端：app（4 处，例 `src/components/anki/cardforge/engines/CardAgent.ts:617`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：taskId: string
  - 结果：null · 错误：AppError · 注入：window, state
<!-- END GENERATED:cmd:trigger_task_processing -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `update_anki_card`

<!-- BEGIN GENERATED:cmd:update_anki_card -->
- Rust：`src-tauri/src/cmd/enhanced_anki.rs:266` · async
- 前端：app（4 处，例 `src/features/chat/plugins/blocks/ankiCardsBlock.tsx:2356`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：card: AnkiCard__De
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:update_anki_card -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 命令 `update_custom_template`

<!-- BEGIN GENERATED:cmd:update_custom_template -->
- Rust：`src-tauri/src/commands.rs:4320` · async
- 前端：app（1 处，例 `src/data/ankiTemplates.ts:299`）
- 契约：`contracts/ipc/L16-anki.json`
  - 参数：templateId: string, request: UpdateTemplateRequest
  - 结果：null · 错误：AppError · 注入：state
<!-- END GENERATED:cmd:update_custom_template -->

- [ ] 输入：
- [ ] 输出：
- [ ] 错误：
- [ ] 事件：
- [ ] DB 读写：
- [ ] 取消/并发：
- [ ] 时间/ID：

## 事件 `anki_generation_event`

<!-- BEGIN GENERATED:event:anki_generation_event -->
- 事件名 `anki_generation_event`
- 发送点：`src-tauri/crates/dstu-anki/src/enhanced_anki_service.rs:237`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/enhanced_anki_service.rs:479`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/enhanced_anki_service.rs:600`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/enhanced_anki_service.rs:609`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/enhanced_anki_service.rs:672`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/enhanced_anki_service.rs:882`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/enhanced_anki_service.rs:893`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/streaming_anki_service.rs:3286`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/streaming_anki_service.rs:3301`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/streaming_anki_service.rs:3314`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/streaming_anki_service.rs:3339`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/streaming_anki_service.rs:3356`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/streaming_anki_service.rs:3381`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/streaming_anki_service.rs:3410`（emit）
- 发送点：`src-tauri/crates/dstu-anki/src/streaming_anki_service.rs:3462`（emit）
<!-- END GENERATED:event:anki_generation_event -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 事件 `fsrs://changed`

<!-- BEGIN GENERATED:event:fsrs://changed -->
- 事件名 `fsrs://changed`
- 发送点：`src-tauri/src/cmd/anki_connect.rs:938`（emit）
- 发送点：`src-tauri/src/cmd/apkg_import.rs:71`（emit）
<!-- END GENERATED:event:fsrs://changed -->

- [ ] 载荷：
- [ ] 触发时机与顺序：
- [ ] 节流/合并：
- [ ] 是否在事务提交后：
- [ ] 目标窗口（emit / emit_to / emit_filter）：

## 模块 `anki_preference_memory`：完整 i64 时间（L24 请求，2026-11-05）

- Rust `anki_preference_memory.rs:125-142,572-591`：`first_seen_ms` / `last_seen_ms`
  与 `now_ms` 都是有符号 i64，不限制为正数、现实日期或 JS safe integer；无时钟采样，原样用调用者时间。
- `:595-624`：新增时两时间相同；强化仅刷新 last_seen，first_seen 不变；空候选仍执行容量维护。
- `:627-640`：同分淘汰 last_seen 最小者，同时间保留原迭代顺序；`:701-705` 检索按得分降序、
  last_seen 降序，完全相同保持稳定顺序。时间比较不经 Number、不用可能返回 bigint 的 sort 减法。
- 公开类型 `PreferenceTimestamp = number | bigint`：旧 number 调用/正常 epoch 毫秒输出保留；
  完整 i64 用 bigint 输入及存储，合并原样写回，混合表示通过关系比较精确排序。
  number 表示调用者已持有的整数，不可能恢复调用前已经发生的 IEEE-754 舍入；无 MAX_SAFE 限制。
- 本模块纯函数无 DB、日志、事件、事务、取消或 I/O；持久化由 L24 settings 编排负责。
  bigint 不能直接 JSON.stringify：L24 应以精确 JSON 数字词法读写，不转字符串字段、不先 Number。
  此处不签收 L24 decoder / serializer，亦不修改它们。
- 回归从真实 `ctx.anki.preferenceMemory` / `ctx.anki.consolidatePreferenceObservation` /
  `ctx.anki.retrievePreferencePrompt` 服务验证新增/强化、i64 边界、相邻 2^53+ 的同分排序与淘汰；
  既有 22 条 Rust 移植测试不改断言。

## 服务 `listAnkiAgentLibraryPage`（C3 agent page，2026-11-05）

- 新增专用只读服务，不改旧 `listAnkiAgentLibraryCards` / UI 命令的 due 排新卡与 200 上限。
  Rust `dstu-storage/src/database/mod.rs:7604-7725`；TS `repository/anki-agent-library.ts`
  由 `src/service.ts` 经真实 `ctx.anki` 提供；不接管 L24 handler 或 L15 review state。
- 输入固定 agent 读 scope（可读 NULL/外会话来源），templateId/search 用 Rust trim，空白忽略；
  LIKE 按 `sql_util.rs:6-11` 转义反斜杠、% 与 _。schedule 的五分支和 diagnostic 的两分支
  均在 COUNT / LIMIT 前加入相同 WHERE（`:7622-7663`）。due 包含 state=0、忽略 buried；
  enqueued 包含任何存活 fs.id（含 suspended），not_enqueued 包含仅有软删状态的卡。
- 两查询依次 COUNT → SELECT，不新开事务（`:7666-7719`），失败原样向服务调用者传播，
  L24 负责 `Failed to list Anki library cards: ...` 前缀及列表成功后的 review 查询。
  该 Rust 方法无日志/事件/写入/取消；无 caller session 条件，不改任何 session 写方法。
- page/pageSize 是 u32，page=max(1)，size=clamp(1,20)，默认 1/12（L24 原默认），
  offset 按 (page-1)*size（u32×20 可由 number 精确表示）；顺序 created_at DESC,id DESC。
- COUNT 从 driver safeIntegers 读 bigint（i64），total=max(0) 作为内部 u64 bigint。
  dueMs（Option<i64>）也精确读为 bigint，nowMs 可 number|bigint；不先 Number 再 BigInt。
  state/i32 保持 number。卡片文本/JSON 按原 mapper NULL/坏 JSON 兜底；sourceRef 恒 null。
- 每项 `{libraryCard, locator:{documentId,sourceSessionId}}`：locator 来源与该页 SELECT 同行，
  保留 sourceSessionId 原文（含空白），仅 libraryCard 来源字段过滤 Rust trim 后空字符串，
  不将 sourceId 当 documentId，不逐项补查。
- 测试先写，经真实 owner 服务、迁移库和真实 L15 enqueue，覆盖五 schedule、ErrorOnly
  先筛后分页、cap20、稳定顺序、软删、原定位、精确 due、COUNT driver bigint、UI 旧语义及 session 写拒绝。

## X6-LP-0062：结构化输出降级日志（2026-11-05）

- Rust `streaming_anki_service.rs:842-881`：结构化请求错误且不是用户取消、匹配 HTTP
  400/404/422 时，先 warn `[ANKI_PROTOCOL] 结构化输出请求被拒绝（<message>），回退 delimiter 协议重试一次`，
  再设 delimiter、重建 prompt、清零统计、重试一次。重建失败先 warn
  `[ANKI_PROTOCOL] 回退 delimiter 时重建 prompt 失败，保留原始错误: <error>`，保留首个请求错误。
- TS `generation-service.ts` 两处目前误用 `[ANKI_GENERATION]` 前缀；此次只恢复原日志标签，
  不修改协议判定、重试数、统计、取消、DB/事件或 L02 传输，也不把 B3 缺口声明解除。
- 新回归通过真实 `trigger_task_processing` 及插件 logger，只有外部 L02 transport 首次拒绝；
  断言一次原 warn、两次请求的 response_format 差异、仅一张卡落库与成功收尾事件。
  prompt 重建失败分支仅静态映射，不替换生产 builder 或制造原本不可达输入来凑覆盖。

## X6-LP-0062：正文/收尾残片日志（2026-11-05）

- Rust `streaming_anki_service.rs:1553-1570`：正文不可读残片只增 dropped_fragments，warn
  `[ANKI_CARD_DEBUG] 丢弃不可读残片（<chars> 字符）: <message>`，发 GenerationWarning，不创建错误卡。
- `:1778-1792`：收尾不可读同样只增 dropped_fragments、发警告事件，但 warn 文案为
  `[ANKI_CARD_DEBUG] 丢弃流收尾的不可读残片（<chars> 字符）`，没有后附错误字符串。
- `:1713-1739`：wrapper 末卡字符串中途截断增 failed_cards，不解析为正常卡；warn 原
  `[ANKI_CARD_DEBUG] 流收尾 wrapper 的最后一张卡在字符串中途截断，降级为错误卡（<chars> 字符）`，
  错误卡 error_content 保留 `卡片在流结束时于字符串中途被截断，内容不完整: <payload>`。
  字符数按 Rust chars，不是 UTF-16；三分支仍让任务成功收尾并发原统计。
- 新回归经真实 Host trigger，正文用完整不可读对象，收尾用未闭合 wrapper（真实修复），
  另用中途截断的 CJK/emoji 字符串。断言准确 warn、8/15 码点、事件/统计与卡片状态；
  不替换 cutter、wrapper expander、parser 或存储。此次不签普通解析失败的收尾错误卡内容分支。

## X6-LP-0063：收尾普通解析失败与错误卡插入失败（2026-11-05）

- Rust `streaming_anki_service.rs:1794-1806`：收尾卡解析普通错误（非 UNREADABLE）只记 debug
  `[ANKI_CARD_DEBUG] 流收尾残留缓冲解析失败: <AppError Display>`，不在该 catch 增计数或创建卡。
  随后未处理且含 `{` 的 payload 才增 failed_cards 一次，以 **原 payload** 创建错误卡，
  不是正文分支的 `error_card_content(message,payload)` 包装。AppError Display 仅为 message
  （`dstu-core/models.rs:1038-1041`）。
- 原 `:1717-1739` truncated 标记及 `:1804-1806` 普通残留错误卡的创建均为 `if let Ok`，
  插入失败静默继续，不新增 error 日志、不传播为任务失败；failed_cards 已增加且不回滚。
  正文卡错误路径 `:1573-1601` 的 match/日志行为不同，本次不合并或改变它。
- 新测试走真实 Host / 未闭合 delimiter wrapper / 必填 back 错误，断言原错误卡 payload、debug
  与 failed=1；另用真实 SQLite BEFORE INSERT trigger 拒绝错误卡，call-through run 确认真抛错，
  仍 Completed、统计 failed=1 且无新增 error 日志；普通与 truncated 两种创建失败均覆盖。

## 遮挡草稿在收尾卡之间的单次消费（2026-11-05）

- Rust `streaming_anki_service.rs:1528-1539,1753-1759`：正文/收尾每张实际保存的卡若含
  `_occlusion`，将局部 `pending_occlusion_fields` 置None；下一张不能再继承该草稿。
  `:2258-2279` 只补机器字段/tag/缺失text，不改front/back，不覆盖模型已有text。
- TS 正文callback更新runStreamAttempt的变量；processResidual此前仅调用外层callback，
  自己接收的旧draft参数却保持不变，第二个收尾payload重复得到同一机器字段/image/tag/text。
  本次需同时清除收尾局部draft与原外层变量，不改成功/重复/异常判定、入库或事件顺序。
- 两条新真实trigger回归使用同一合法图示marker，分别走正文两个对象与未闭合delimiter wrapper
  的两个收尾payload；断言两卡front/back保留，首卡含真实合并的遮挡字段/图片/cloze/tag，
  第二卡仍普通卡。正文作为原行为控制，不重跑已关闭的trim向量，不mock parser或草稿消费逻辑。

## 文档分段：纯处理重复扫描与空白谓词等价快路（2026-11-05）

- 独立 R5 `20261105034708-504797`（固定main f2c）原1277pass/1fail/1skip、exit1，
  无Errors/Unhandled；唯一forced_char_split本体30s。它不等于旧RPC失败，也不被旧825pass/0覆盖。
- Rust `document_processing_service.rs:257-276,551-592,1510-1530` 与 TS
  `document-processing-segment.ts:18-47,325-369`：原估算公式/f32截断、标量遍历、二分与
  slice/join预算判断相同。测试增长while不变，固定unit无空白，反复对全部前缀估算为O(k²*u)；
  硬切上界O(S*N*logN)，每probe构造slice数组/join字符串，峰值临时空间O(N)。
- 只读元数据 `20261105042845-d368b1`（非test/非timing、未执行增长while）：Node26.5/Linuxx64，
  unit11标量/13UTF16/35bytes，4630次重复=50930标量/60190UTF16/162050bytes；前一次24997token，
  本次25003，故原fixture4631次estimate共117928415码点；每码点调用一次F4 isRustWhitespace。
  原生产split三段标量20371/20371/10188、token10000/10000/5003，拼接无损。
- F4 `util/text.ts:9-22` 是纯数值谓词，不进行字符串分配，所有真空白码点<=U+3000。
  本样本所有码点>U+3000，1.179亿次调用均必为false。只在调用前加等价范围guard，
  仍使用共享谓词，不复制空白表、不改公式/二分/原测试增长loop、Unicode样本、断言或30s。
  新9个语义向量先钉住U+3000/3001、NEL、BOM、假名/谚文/emoji标量；旧31条原断言全部保持。
- 路径在Vitest forks子进程主线程同步执行；生产segmentDocument同样同步调用纯分段函数。
  无F7/DB/worker调用；B4临时collection连接缺口无关。静态工作量与此次最小修复不证明
  耗时占比、CPU或唯一超时根因；V8 concat rope/flatten实际分配不能仅据源码定量宣称。

## X6-LP-0064：batch_export_cards 模板读取失败日志（2026-11-05）

- Rust `cmd/anki_connect.rs:1376-1404` 的 `Ok(None)` 与 `Err(e)` 是互斥分支：
  不存在时仅 warn `[batch_export_cards] 模板不存在: <tid>，将按 note_type 直接同步`；
  读取失败时仅 warn `[batch_export_cards] 读取模板失败: <tid>，将按 note_type 直接同步: <e>`。
  两分支均以空模型映射继续 detailed 同步，不把模板读取失败传播成命令错误。
- 当前 TS catch 先省略模板 id、改变错误顺序，随后又走 row===undefined 补报“模板不存在”；
  本次恢复互斥分支与原字段/文案。真实 missing 分支不改，不改同步结果、批次设置或重试语义。
- 新测试经 Host `batch_export_cards`，missing 使用真实空模板表，read-error 使用真实 SQLite
  DROP TABLE，AnkiConnect 网络边界提供确定响应；断言仅一条准确 warn、同步成功、无本地卡片/receipt。
  不 mock 仓储/logger/详细同步算法，不把两例外推为全部命令日志闭合。

## X6-LP-0064：APKG 模板独立读取与错误上下文（2026-11-05）

- Rust `cmd/anki_connect.rs:1002-1027`：先 config（经 `anki/mod.rs:15-27`），再完整模板，
  **两个独立查询**，第一失败不阻止第二；两结果各自 None 时仍继续默认导出。
  config missing 错误为 `模板不存在: <id>`，DB失败为 `获取模板失败: <error>`；
  完整模板 missing 静默，DB失败单独 warn `获取完整模板失败 - 模板ID: <id>, 错误: <error>，回退默认模板`。
- `export_apkg_for_selection` 则对应 `enhanced_anki_service.rs:1002-1017`，只有一次 config 查询；
  仅恢复原 config 错误上下文，不增加第二次查询，不改导出参数、卡片筛选或错误包装。
- 新测试经真实 Host 单模板导出、SQLite 表改名故障与真实 ZIP 文件，call-through db.get 检查二读，
  原 logger 检查 missing 一条 / DB失败两条的准确顺序与文案；不 mock 仓储、模板或导出算法。
- 多模板命令是不同分支：Rust `cmd/anki_connect.rs:1139-1149` 的 `if let Ok(Some(t))`
  对 missing/DB失败都静默跳过，不额外 warn。TS 原 catch 擅自加 warn；恢复原 continue。
  新回归用真实表改名 + call-through get 确认查询确实抛错，输出仍是实际 APKG，logger 未被调用。

## 跨 lane 依赖与待接线（2026-11-03 质量整改）

- `llmAdapterInfos.listAdapterInfos`（L02）：**已消费**。`src/model-adapters.ts`
  通过 `ctx.get('llmAdapterInfos')` 调用 main 上已发布的只读注册表；缺失时命令返回
  `Configuration` 错误，不静默降级。
- `review` FSRS 事务面（L15，D1/D4）：**已消费已发布 API**。L15 分支已合入本 lane
  （`0857832cf`），`src/fsrs-owner.ts` 直接使用 `review/api.ts` 发布的
  `ReviewService`、`FsrsImportedCard`、`FsrsImportedSchedule`、
  `FsrsImportEnqueueSummary`，不再维护类型副本；`FsrsTransactionOwner` 只是
  `ReviewService` 四个事务内方法的 `Pick`。`requireFsrsTransactionOwner(ctx)` 要求
  `cleanupCardDeletionInTx` / `cleanupTaskDeletionInTx` /
  `cleanupDocumentDeletionInTx` / `enqueueImportedCardsInTx` 同时存在；卡片/任务/文档
  删除与 APKG 导入都在 `BEGIN IMMEDIATE` 事务内把同一个 `SqlExecutor` 传给 L15，
  随后才写/删 L16 的 `anki_cards` / `document_tasks`。L16 生产代码无任何 `fsrs_*`
  写 SQL；测试宿主默认安装真实 L15 `review` 插件（`tests/env.ts`），不再使用
  test-only FSRS 写表替身；只有显式 `withReview: false` 的 fail-closed 用例验证缺失
  事务面时零写入。
- `review` 库卡片复习快照（L15）：`list_anki_library_cards` 已通过已发布的
  `review.getReviewStatesForLibrary('agent', ids)` 取 `review_version` / `latest_review`；
  L16 命令层不再自行查询列表快照，L15 服务缺失时显式失败。
- F3 卡片库公开面：`api.ts::AnkiService` 与真实 `AnkiHostService` 已发布
  `insertAnkiCard` / `listAnkiAgentLibraryCards` / `updateAnkiCardIfVersionForLibrary` /
  `updateAnkiCardIfVersionForSession` / `getAnkiAgentLibraryCardsByIds` /
  `deleteAnkiCardForLibrary`。库删除执行内容版本 + `expectedReviewVersion` 双 CAS，
  FSRS 清理与卡片行删除同事务；`expectedReviewVersion` 必须是整数（Rust `i64`），
  不按 safe-integer 收窄。
- `nativeRegex`（F7）：已接入。`anki_qa_lint` 的模板 `validation_pattern` 与金标脱敏正则
  均经 F7 `regex`（Rust `regex` 1.12.3 wasm）执行；编译失败按 Rust `regex::Error` 语义
  区分「模板配置错误（跳过该项）」与引擎故障（向上传播）。
- `nativeCompression`（F7，W08）：**异步导入路径已消费**。`ApkgImporterService`
  新增 `importBytesAsync` / `importPathAsync`（命令 `import_apkg_to_library` 使用），
  先经 `ctx.nativeCompression.zstdDecode` 预解压 collection / 现代 media 清单 / 数字媒体
  条目，再复用原有归档扫描；`MAX_ZSTD_WINDOW_LOG` 与各输出上限在任何解压前/后都保留，
  预解压失败时回退同步路径以维持原错误与媒体 skip 文案。L24 的已发布
  `ChatAnkiApkgImporter` 仍是同步接口，继续走同步 zlib 路径；**精确阻塞：待 L24 把
  `ChatAnkiApkgImporter` 改为可 await（或提供异步变体）后，chatanki 才能切到
  `importBytesAsync` / `importPathAsync`。**
- `host/platform/time` / `util`（F4）：**已消费**。`src/time.ts` 使用
  `host/platform/time` 的 chrono AutoSi 实现；trim/UTF-8 工具使用
  `host/platform/util` 的 `rustTrim` / `utf8ByteLength`，`src/enhanced-service.ts`
  的本地副本已删除。`MODEL_SPECIAL_TOKENS` 单源来自
  `host/platform/util/api.ts`；L16 的纯 token/JSON 外侧包装清理与 F4 的
  流式 `ModelWrapTokenStreamFilter` 语义不同，保留为独立函数并引用共享常量。
- **生成已在本 lane 内完成（L02 只提供传输）**：`generate_anki_cards_from_document*` /
  `start_enhanced_document_processing` / `resume_document_processing` / `trigger_task_processing`
  由 `src/generation-service.ts` 直接消费 L02 已发布的 `llm` 配置读取与
  `llmStreaming.singleShotCompletion`；prompt、输出协议、切卡、去重、入库、流式事件、
  统计、critic、取消与收尾均在本 lane 实现，旧的 `ankiGeneration@1` 端口已删除。
  **传输失败的 Rust 文案与终态**（V05-01/03/05）：`src/generation-errors.ts` 把 L02 的
  `${label} …` 失败文本还原为 Rust 文案——流式走 `streaming_anki_service.rs:1411-1471`
  （状态码友好文案 `"{文案} (HTTP {status})"`、`AI请求失败: …`、`AI响应超时`（Truncated）、
  `读取AI响应流失败: …`），非流式走 `model2_pipeline.rs:9914-9942`；两条路径都传
  `maxRetries: 0`（Rust 单次请求），流式 `headerTimeoutMs` 与 Rust 600s 客户端超时一致；
  `decryptApiKey` 失败进入 Failed 并派发 `TaskProcessingError`。剩余差异：L02 的"流式被拒 →
  非流式回退"没有关闭开关（已交接 W05）；非流式 HTTP 失败附带的响应体是 L02 脱敏、截断后的文本。
  **L02 路由已消费**：`src/generation-service.ts` 通过 `llmAnkiRouting` 的
  `probeAnkiRoutingSlots` / `resolveAnkiRoleDecision` 取 Generator 与 Critic 决策，
  并直接使用 L02 `api.ts` 发布的 `parseRoutingMode` / `planRouting`；槽位或配置不可用时
  回退 Rust 旧单模型路径。critic 的模型调用走 L02 `llmRawPrompt.callAnkiRoutedRawPrompt`
  （与 anki_critic.rs:968-973 相同：决策、`anki_critic.run_critic_pass`、prompt、无图片），
  决策/降级字段写入摘要。**精确剩余**：生成流的 L02 `singleShotCompletion` 目前不接受
  Codex OAuth 配置（Rust `prepare_provider_request` 支持），因此 Codex 账号的生成请求会由
  L02 拒绝；**待接线：L02 补齐 OAuth 请求准备。**
- **`tests/anki_ai_native_integration.rs` 的 14 条 transform/script/analyze/retemplate 用例**
  （L24-chatanki）：这些用例调用 `chat_v2::tools::chatanki_transform` /
  `chatanki_transform_script` / `chatanki_executor` 的纯函数与 wire 解析器（CAS、
  sandbox policy、route 容错）。L24 已在 `api.ts` 发布这些纯函数
  （`compileTransformOps` / `buildScriptInput` / `parseRoutePlanResponse` /
  `parseChatAnkiRetemplateStrategy` 等）；本 lane 的
  `tests/anki-ai-native-chatanki-integration.test.ts` 只从 `../../chatanki/api.ts`
  导入公开符号，不再引用 `chatanki/src/*`，对应 `cross-plugin-impl` 豁免已删除。
- **L24 已改为注入 `anki`**：main 的 `host/plugins/chatanki/index.ts`
  `inject: ['settings', 'review', 'llm', 'anki']`，并按 registry hydrate。
  L16 已按 `docs/plugins/ARCHITECTURE.md` 附录 A 提供 `ctx.anki`
  （`meta.provides: ['anki']`），并在 `api.ts` 发布七个嵌套面（`AnkiService`），
  由真实 mistakes / L04 / L11 / F4 实现支撑；
  `tests/anki-chatanki-service-surface.test.ts` 从真实 Host 取 `ctx.anki` 并安装
  真实 L04/L11 插件。剩余仅是 L24 完整消费者链与 main 集成验证，不再归因旧名。

## L24 chatanki 服务面（A5，2026-11-04）

L16 生产的 `anki` 服务现在提供 L24 `chatanki` 运行时所需的七个嵌套仓储：

- `cards`：`repository/chatanki-surface.ts` 的真实 mistakes-DB 读写。覆盖会话文档归属、
  库卡片保序读取、追加卡片、内容 CAS 更新、原子 retemplate（字段映射/cloze/版本集合校验）、
  内容 + 复习双 CAS 删除。写路径都在 `BEGIN IMMEDIATE` 事务内重复校验。
- `documents`：`document_tasks` 的真实任务读取/插入与 `source_session_id` 读写。
- `chatBlocks`：按需查找 L04 `chatSession`，映射会话/消息/块；缺失服务显式抛错。
- `settings`：按需查找 F4 `settings`，用 `get`/`save` 适配 L24 的
  `getSetting`/`saveSetting` 形状。
- `preferenceMemory`：直接委托 L16 `src/preference-memory.ts` 的纯函数，观察字段
  从 camelCase 映射到 Rust serde snake_case。
- `apkgImporter`：直接实例化 L16 `ApkgImporterService`，使用真实 mistakes 库、
  `<mistakes 库目录>/anki_media` 与平台临时目录；保留内部 `cardIds`。
- `apkgVfs`：按需查找 L11 `vfsDatabase`（连接 + blob 目录）与 `vfsRepo` 公共仓储
  服务。`repository/chatanki-vfs.ts` 只组合以下已发布 API，不再复制 L11 SQL：
  `files.getFile`（文件行）、`resources.getResource`（resource hash/sourceId/type）、
  `attachments.resolveFileId`（`res_*` → `file_*`/`att_*`/`tb_*`）、
  `blobs.getBlobPath`（blob 相对路径）。原始路径读取、URI 判定与 SHA-256 校验仍由
  L24 `loadApkgVfsFileBytes` 负责。

测试：`tests/anki-chatanki-service-surface.test.ts`（10 条）。从真实插件装载后的
`ctx.anki` 取服务；卡片/文档/设置/偏好/APKG 落真实库或真实实现，L04 `chatSession`
与 L11 `vfsDatabase` + `vfsRepo` 分别装载真实插件，不使用内存替身。同一文件还覆盖
F3 卡片库公开面（插入/分页/内容 CAS/会话 CAS/按 id 读取/双 CAS 删除）与 L15
事务所有者缺失时的显式失败。

## 模块 `anki_gold_set`（`crates/dstu-anki/src/anki_gold_set.rs`）

移植文件：`src/anki-gold-set.ts`；测试：`tests/anki-gold-set.test.ts`（50 条，标题与 Rust 测试名一致）。

- **原文快照** `insert_original_generation_once`：键已存在时先返回 `Ok(false)`，不检查体积、不覆盖
  任何既有值（含非法 JSON）；序列化按 serde 字段序 `front, back, text`，`text=None` 省略；
  上限按序列化 JSON 的 UTF-8 字节数（`ORIGINAL_GENERATION_MAX_BYTES = 16384`），超限返回
  `TooLarge { actual_bytes, max_bytes }`，Display 为
  `快照大小 {actual_bytes} 字节超过上限 {max_bytes} 字节`；失败不修改 extras。
- **提取** `extract_original_generation`：接受值直接是对象或二次编码 JSON 字符串；缺键 / 非法 JSON /
  非对象 / 字段类型不符 → `None`。`extract_original_from_extras` 是内存态变体。
- **critic 标记** `has_critic_revision_marker`：`_qa_flags` 必须是数组，只认 `code ==
  "llm_critic_revised"` 的结构化条目；非法 JSON 保守返回 false。
- **内容溯源**：`_content_provenance` camelCase，`code`/`at` 为 Option（null 省略）；未知字段忽略；
  非法值 fail-closed（不算任何一方证明）。`insert_content_provenance` last-writer-wins。
- **编辑距离**：按 Unicode 标量值计；`edit_ratio` 原文空白时，改后空白返回 0，否则 1.0；
  否则 `levenshtein(combined(original), combined(edited)) / chars(combined(original))`。
- **标注** `classify_candidate`：决策树与 reason 文案逐字对照 Rust；critic 来源（marker 或
  `edit_actor=llm_critic`）→ Unlabeled；早删窗口按 `deleted_at - created_at <= window`；
  编辑通道只有 `edit_actor == "user"` 才产出修正对；小幅/大幅阈值 `minor_edit_max_ratio`
  用 `{:.3}` / `{:.2}` 格式化；留存率用 `{:.0}`。
- **lint 契约**：`gold_lint_config` 关闭 tags_empty / mixed_language；只看 Warn+；
  `lint_repair_pair` 去重排序 code，`lint_blind_spot = 两端皆干净且 original != edited`。
- **grounded 参照对**：只取三种修正对标签，金标端非空且 lint 零 Warn+，按 trim 后 `edited.front`
  去重，保持输入顺序，最多 `max` 对。
- **脱敏**：邮箱 / 手机号（带边界捕获组，仅替换组 1）/ 18 位身份证号；正则经 F7
  `nativeRegex`（`regex` crate 1.12.3 wasm）执行，保持 Rust 的 `\d` Unicode 语义。
- **导出整形**：Unlabeled 返回 None；字段 `id, label, reason, original?, edited?, distanceRatio?`；
  `distanceRatio = round(ratio*1000)/1000`。
- **日志**：Rust 本模块无 `warn!/error!/info!`，TS 无额外日志。
- **接线**：`anki-critic` 的 `GoldSetMining` 端口由 `defaultGoldSetMining()` 提供，
  critic 测试已改为直接使用生产实现；`anki-cards` 的 provenance 常量/写入委托到本模块。

## 集成回归测试覆盖（2026-11-03）

以下 `src-tauri/tests` 集成用例已按 Rust 测试名逐条移植到本 lane 的 vitest：

- `tests/qa_pass_critic_combo.rs`（11）→ `tests/qa-pass-critic-combo.test.ts`：
  字段规则 / 确定性 lint / critic relint × `enable_qa_pass` 两态。`false` 侧
  `sanitizePlanForDisabledQaPass` 只剥 `_qa_flags`，`_content_provenance` 必须存活；
  内容零变化的 revise 与 flag-only 写回整体丢弃，裁决统计不受门控影响。
- `tests/anki_ai_native_integration.rs`（本 lane 15/29）→ `tests/anki-ai-native-integration.test.ts`：
  qa_lint 规则抽样、`merge_flags` 幂等、偏好检索预算、FSRS 画像/干扰纯函数链、
  协议能力矩阵、multi-template `oneOf` schema、`repair_json` 有损/无损边界、
  wrapper 流式剥离与 eval fixture 基线。其余 14 条（transform/script/route/retemplate
  策略）→ `tests/anki-ai-native-chatanki-integration.test.ts`，见跨 lane 段。
- `tests/anki_nullable_card_reads.rs`（4）→ `tests/anki-nullable-card-reads.test.ts`：
  历史库 NULL 列读侧兜底（front/back→""、tags/images→[]、extra_fields→{}），
  非法 JSON 软解析为空集合；`getCardsForDocumentForSession` 的会话归属守卫
  fail-closed（任务数 0 或存在他人任务 → null）。测试用裸建表复现旧 schema。
- `tests/anki_new_wiring_tests.rs`（3）→ `tests/anki-new-wiring.test.ts`：
  偏好设置往返强化、`_occlusion` 扩展字段入库回读、`_original_generation` 二次编码
  落库后编辑正文不改快照。
- `tests/anki_export_integration.rs`（3）→ `tests/anki-export-integration.test.ts`：
  全模板导出、媒体打包/缺失报告、超过 `MAX_EXPORT_MEDIA_FILE_BYTES` 的媒体跳过并告警。
- `tests/occlusion_export_roundtrip.rs`（11）→ `tests/occlusion-export-roundtrip.test.ts`：
  生成字段 → 入库形状 → IO cloze / 协议字段过滤 / 媒体名解析全链路；镜像 helper
  与生产函数交叉校验。
- `tests/gold_provenance_excludes_critic.rs`（14）→ `tests/gold-provenance-excludes-critic.test.ts`：
  critic 修订卡（marker 或 provenance）零 grounded reference；非 user actor
  fail-closed；`enable_qa_pass=false` 洗白路径仍被 provenance 闸门拦截。
- `tests/anki_fsrs_feedback.rs`（5）→ `tests/anki-fsrs-feedback.test.ts`：
  真实 SQLite 的反馈行排序/limit、画像与干扰注入、空库降级。测试夹具直接建
  `fsrs_card_states` 行以精确构造画像输入；生产路径的入队/清理已由 L15 发布的
  `enqueueImportedCardsInTx` / `cleanup*InTx` 承担（见 APKG 导入与删除测试）。
- `crates/dstu-anki/src/anki/repository.rs`（1）→ `tests/anki-repository.test.ts`：
  repository 是无状态入口（导出面只有纯函数，db 句柄显式传入）。
- `crates/dstu-anki/src/enhanced_anki_service.rs::tests`（5/5）→
  `tests/enhanced-anki-service.test.ts`：`update_anki_card` 对卡墓碑与父任务墓碑
  均返回 `NotFound`；FSRS 显式授权；暂停/恢复测试镜像；生成卡只入队一次且跳过错误卡。
  另加 3 条命令级测试覆盖 pause/cancel/get_state 的落库与事件。
- `src/commands.rs:3911-4030` + `src/cmd/enhanced_anki.rs:85-209` 的 6 条生成/调度命令
  → `tests/anki-generation-commands.test.ts`：真实 `AnkiGenerationService`（L02
  `llm`/`llmStreaming` 边界替身）驱动，覆盖非流式成功/失败/解析失败、start 校验与
  Started/Completed 事件、FSRS 授权注入、resume 过滤排序与空剩余完成、
  trigger 状态守卫/防重入/缺失服务 Configuration。

### 新增/调整的生产代码

- `get_document_task_counts`：`enhanced_anki_service.rs:1061-1079` 的独立移植。
  `repository/anki-cards.ts::countDocumentTasks` 复用 `get_document_tasks` 的过滤
  （`deleted_at IS NULL`）并按 `TaskStatus::from_str` 归类；读取失败时按 Rust
  语义静默返回全零 DTO。测试：`tests/document-task-counts.test.ts`（补充覆盖）。
- `repository/anki-cards.ts::getCardsForDocumentForSession`：`database/mod.rs:4999-5045`
  的移植。先统计文档内活任务数与归属当前会话的任务数，不相等即返回 null；
  随后复用 `listCardsForDocument` 的共享 mapper（NULL 列兜底）。

## R5 A1/A2/A4/A6 收口（2026-11-04）

- **A2 路由/ready/Context**：`src/generation-service.ts` 已消费 L02
  `llmAnkiRouting`（Generator + Critic）与已发布的 `parseRoutingMode` / `planRouting`；
  `src/plugin-handlers-generation.ts` 不再具体 import `regex` 单例，改为
  `ctx.get('nativeRegex')`，缺失时显式 `Configuration` 失败。
  `processTaskAndGenerateCardsStream` 新增运行句柄 `AbortSignal` 与 `onReady`：
  取消通道注册完成后回执，等价 Rust `ready_signal`。
- **A2 校验顺序**：`triggerTaskProcessing` 恢复 Rust `enhanced_anki_service.rs:704-719`
  顺序——先拒绝非 Pending/Failed/Truncated/Cancelled，再判运行句柄/取消通道。
  两条错误分支分别由 `tests/enhanced-anki-service.test.ts` 的
  `trigger_rejects_non_retryable_status_before_the_running_handle_branch` 断言。
- **A4 真实 abort**：`runningTaskHandles` 从 ID Set 改为
  `Map<string, RunningTaskHandle>`，句柄持有独立 `AbortController`。调度层在 spawn
  前注册（`registerRunningTask`），删除/暂停路径在 `cancel_streaming` 返回 Err 时执行
  `abortRunningTask`（`RUNNING_HANDLES.remove(..).abort()` 语义），
  `cancelStreaming` 缺失通道时返回 Rust 原文 `任务 {id} 未在运行状态`，
  `pauseDocumentProcessing` 同样补 abort + clear 兜底。命令级测试
  `delete_during_config_fetch_aborts_the_real_run_handle_before_the_cancel_channel_exists`
  在配置 await 期间删除文档，证明真实运行句柄被 abort 且 LLM 请求从未发出。
- **A6 错误文本**：`src/serde-json.ts` 按 serde_json 的语法/行列规则生成错误，
  `src/anki-connect.ts` 在 `response.json::<AnkiConnectResponse>()` 阶段包装为
  reqwest 0.11 `Kind::Decode` 的 Display：`error decoding response body: {serde error}`；
  合法 JSON 的结果类型错误仍走独立 `from_value` 文案（不带 `while parsing`）。
  `tests/anki-connect.test.ts` 断言
  `解析AnkiConnect响应失败: error decoding response body: expected ident at line 1 column 2`
  与 `expected \`,\` or \`]\` at line 1 column 14` 的精确值。
- **仍开放的外部阻塞**：生成流传输的 Codex OAuth 请求准备（critic 已改走
  `llmRawPrompt.callAnkiRoutedRawPrompt`）。L11 APKG 读取接缝
  已闭合：复用已发布 `vfsRepo.files/resources/attachments/blobs` + `vfsDatabase`
  连接/blob 目录，`repository/chatanki-vfs.ts` 不再含 VFS SQL。L15 已在
  `0857832cf` 合入本 lane，测试默认安装真实 `review` 插件；main 的最终合入仍由
  集成环节完成。
- **L11 精确字段缺口（真实软删除过滤未闭合，不阻塞其他单元）**：Rust
  `resolve_context_ref_from_vfs_source` 的 `LEFT JOIN resources` 带
  `r.deleted_at IS NULL`，而 L11 `VfsResource` 不暴露 `deletedAt`、也无同义读取；
  L16 只能按本地 VFS 不软删 resources 的现状组合 `files.getFile` +
  `resources.getResource`。这不是等价签收：一旦同步治理软删 resources，APKG
  resource 解析仍会读到已删资源。请求 L11 增补 `deletedAt`（或
  `getLiveResource`）；另可选用严格
  `files.getLiveFileIdByResourceId` 替代更宽的 `attachments.resolveFileId`
  （Rust 调用面前者结果等价）。精确输入/返回与 Rust 原文见 `LANE.md`
  「L11 VFS 接缝交接」。
- **集成门禁跨 lane 阻塞**：`host/plugins/review/tests/l24-review-state-consumer.test.ts`
  的 `provide` 仍是 `'anki@1': {}`，main 的 `chatanki` 已注入 `anki`，该用例以
  `PluginLifecycleError: required services not available: "anki"` 失败。文件属于
  review lane，且测试宿主未安装 anki，L16 无法修改；需 review 测试 owner 改用
  `anki: {}`。

## R5 08:55 审计反例收口（A3/A4/A6）

- **A4 配置 reject 分支**：`src/generation-service.ts` 在
  `getStreamingConfig` 的 catch 首行检查 `runSignal.aborted`，删除/暂停已 abort
  后不再写 Failed/Truncated 或发 `TaskProcessingError`（Rust
  `enhanced_anki_service.rs:914-922` 的 `JoinHandle::abort` 不会恢复配置 future）。
  正常未取消的配置错误仍走 `handleTaskError`。命令级回归
  `delete_during_config_fetch_does_not_write_failed_state_when_config_rejects`
  在删除后 reject 配置，断言无 `TaskProcessingError` 且 LLM 未被调用。
- **A3 锁模式**：普通卡片/任务/文档删除恢复 rusqlite 默认 deferred
  `conn.transaction()`（`database/mod.rs:6055/6072/6097`），同一事务仍传真实 L15
  `review` owner；CAS（`update/delete_*_if_version*`、retemplate）与 APKG 导入保持
  `TransactionBehavior::Immediate`。
- **A6 两条解码路径**：`src/serde-json.ts` 重写为 AnkiConnect 响应专用解析器：
  - version：`response.text()` 宽松解码 + `from_str` 语义，语法/typed 错误**不带**
    reqwest 前缀；`result: 5.0` 按 arbitrary_precision `as_u64` 返回 None，告警放行。
  - deck/其他：`response.json` 语义，严格 UTF-8 + `error decoding response body:`；
    typed error 在后续字段语法错误前按字段顺序报出；重复 `result` 按派生结构体
    `duplicate field` 拒绝；整数保留原始词法（`9007199254740993` 不舍入）。
  - 新增精确断言覆盖：version `{`、`result:5.0`、error 先于 syntax、重复 result、
    超出 JS safe range 的整数、非法 UTF-8 字节。

## 最终门禁证据（2026-11-04 09:20Z，merge main `081b3426d` 后）

- 类型检查：`npm run typecheck:host`（作业 `20261104091805-b8c700`，退出码 0）。
- 全目录测试（36 文件，作业 `20261104091805-22d4c6`）：
  `npx vitest run -c vitest.host.config.ts host/plugins/anki --pool=threads --maxWorkers=1 --hookTimeout=120000`
  → 36 passed、735 passed / 1 skipped（736 条）、退出码 0。
- A6 定向：`tests/anki-connect.test.ts` 14/14、退出码 0（作业
  `20261104090738-ac233d`），含 version `{` 无 reqwest 前缀、`result:5.0` 放行、
  error 先于后字段 syntax、重复 result、9007199254740993 原始词法、非法 UTF-8。
- A4/A3 定向：`anki-generation-commands` + `anki-db` 36/36、退出码 0（作业
  `20261104085943-f88dce`），含删除后配置 reject 不写失败态。
- APKG VFS 接缝：`anki-chatanki-service-surface` 10/10、退出码 0（作业
  `20261104091647-1cad1c`，merge main 后 `paths.dataSpaceDeviceId` 夹具已补）。
- `npm run migration:boundaries`：`scanned 2356 files, 0 violation(s), 162
  suppressed via boundary-allow`，退出码 0。
- **集成门禁跨 lane 失败（非本 lane）**：作业 `20261104090937-974672` 运行
  `host/plugins/review/tests/l24-review-state-consumer.test.ts` 退出码 1：
  `PluginLifecycleError: plugin "dstu.chatanki" did not start: required services
  not available: "anki"`。该测试 `provide: {'anki@1': {}}`，而 main 的 chatanki
  注入 `anki`；文件不在本 lane 允许路径，需 review 测试 owner 修 provide 键。

## 历史门禁证据（2026-11-04 08:42Z 复核）

- 类型检查：
  `npx tsc -p tsconfig.host.json --noEmit`（作业 `20261104084209-c9b04c`，
  `job.mjs result` 退出码 0）。
- 全目录测试（36 文件，作业 `20261104074154-acbb9c`）：
  `npx vitest run -c vitest.host.config.ts host/plugins/anki --pool=threads --maxWorkers=1 --hookTimeout=120000`
  → 36 passed、728 passed / 1 skipped（729 条）、退出码 0。唯一 skip 是
  `DEEP_STUDENT_EXTERNAL_APKG` 未设置的外部包 smoke。此前 `forks` 池在并发负载下
  偶发 `onTaskUpdate` worker RPC 超时（断言全过但退出码 1），改用 `threads` 后获得
  上述干净退出码。
  本轮整合后首次全目录复跑（作业 `20261104072903-8741f2`）发现
  `library-query.test.ts` 的夹具仍按 snake_case 写 `state_before_json`，与 Rust
  `#[serde(rename_all = "camelCase")]` 及 L15 `getReviewStatesForLibrary` 的
  `undoable` 校验不一致；已按 Rust wire 形状修正夹具，单文件复跑（作业
  `20261104073346-2bbe50`）8/8、退出码 0，随后全目录复跑得到上述干净退出码。
- L11 APKG 读取接缝（作业 `20261104083756-a288cd`）：
  `tests/anki-chatanki-service-surface.test.ts` 10/10、退出码 0；测试装载真实
  `vfs` + `vfs-repos` 插件，`apkgVfs` 经 `vfsRepo.files/resources/attachments/blobs`
  解析 `file_*`/`res_*` 并读取真实 blob 字节；`repository/chatanki-vfs.ts` 已无 VFS SQL。
- 本轮 L15/L24 整合后的定向测试（作业 `20261104072612-fb3737`，`threads` 池）
  → 4 文件通过、83 passed / 1 skipped（84 条）、退出码 0：
  `anki-chatanki-service-surface` 10/10（A5 + F3 公开面 + owner 缺失失败）、
  `anki-ai-native-chatanki-integration` 14/14（全部 import 来自 L24 `api.ts`）、
  `apkg-importer` 49 passed / 1 skipped（真实 L15 `review` 事务面 + 异步
  `nativeCompression` 路径）、`enhanced-anki-service` 10/10（真实 `review`
  owner + trigger 顺序 + 运行句柄 abort）。
- 既有定向复跑（均退出码 0）：
  `anki-generation-service` 8/8（含 L02 路由 Generator/Critic）、
  `anki-generation-commands` 19/19（含配置 await 期间删除的真实 abort）、
  `anki-critic` 54/54、`anki-db` 16/16（含 X1 命令错误转换）、
  `enhanced-anki-service` 10/10（含 trigger 顺序与运行句柄 abort）、
  `anki-connect` 8/8（reqwest Display + serde_json 文案）、
  `document-processing` 31/31、
  `streaming-anki` 94/94（拆分后公共导出面不变）、`anki-repository` 1/1。
- `DSTU_BOUNDARY_STRICT=1 node scripts/electron-migration/boundaries.mjs host/plugins/anki`：
  `scanned 116 files, 0 violation(s), 2 suppressed via boundary-allow`（仅剩
  qa-lint 的 `TODO` 领域词白名单）；L24 集成测试 4 处 `cross-plugin-impl` 豁免已删除。
- `node scripts/electron-migration/importable.mjs host/plugins/anki/index.ts`：
  `importable: ok`。
- `npm run migration:wiring -- --lane anki`：
  `合计 ported 630，其中所测模块未从 index.ts 接入 0（0.0%）`，退出码 0。
- `npm run migration:ledger -- --check --no-write`：全局 `commands 1058
  (A 92% / B 7.2%) / tests 8036 (A 77.9% / B 0.9%), problems 0`，退出码 0；
  L16 自身仍为 `commands 61/61 A`、`tests 630/630 A`、pending 0。

### 文件拆分（quality.md §2.4）

`index.ts` 只保留 `definePlugin` 接线，命令清单为同文件字面量数组（账本静态
扫描要求）。`src/plugin.ts`（1928→约 350 行）按命令组拆到
`plugin-handlers-{media,templates,cards,export,rest}.ts`，共享错误语义与运行时
类型在 `plugin-runtime.ts`。APKG 导入拆为 types/media/zstd/mapping/metadata/
collection/archive/fsrs/persist 九个模块；文档处理拆为 text/segment/overlap/
distribution；QA lint 拆为 types/rules/tracker/text；critic 拆为
`anki-critic-prompt.ts` + `anki-critic.ts`；APKG 导出拆为
`apkg-export-constants.ts` / `apkg-export-model.ts` / `apkg-exporter.ts`。
`streaming-anki.ts`（1716 行）按职责拆为 protocol / templates / fields / prompt /
buffer / cancel / errors / runtime 八个模块，原文件只保留稳定导出面接线。
所有原模块继续 `export *` 重导出，测试与跨模块导入路径不变。

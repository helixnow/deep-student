# Anki 制卡功能全链路批判性审阅（2026-06-11）

> 审阅方法：依据 `.cursor/skills/critical-review-workflow` 与 `docs/FABLE_SOTA_GOAL.md` 第 353-385 行（AI 生产力工具审阅目标）。
> 审阅人：Fable（边审阅边记录，未使用子代理）。
> 状态：进行中。

## 0. 审阅范围与入口

### 涉及模块

**前端（~10.8k 行）**
- `src/components/anki/` — 制卡台主模块（TaskDashboardPage、cardforge 引擎、panels、services）
- `src/components/anki/cardforge/engines/` — CardAgent / CardEngine / SegmentEngine / TaskController（核心状态机）
- `src/stores/anki/` — useAnkiUIStore、types
- `src/stores/ankiQueueStore.ts` — 制卡队列持久化
- `src/features/chat/anki/index.tsx` + `AnkiPanelHost.tsx` + `useAnkiPanelV2Bridge.ts` — Chat 内制卡面板桥接
- `src/features/chat/plugins/blocks/ankiCardsBlock.tsx` + `plugins/events/ankiCards.ts` — Chat 流式制卡块
- `src/services/ankiApiAdapter.ts`、`src/services/ankiConnectClient.ts` — API 适配
- `src/data/ankiTemplates.ts`、`src/data/anki/builtin-templates.json` — 模板
- `src/utils/ankiSourceBuilder.ts`、`src/utils/ankiTemplateAttachment.ts`
- `src/components/AnkiCardPreviewModal.tsx`

**后端（~13.3k 行）**
- `src-tauri/src/chat_v2/tools/chatanki_executor.rs`（5779 行，Chat 制卡工具）
- `src-tauri/src/chat_v2/tools/anki_executor.rs`
- `src-tauri/src/streaming_anki_service.rs`（流式制卡）
- `src-tauri/src/enhanced_anki_service.rs`（增强制卡服务）
- `src-tauri/src/apkg_exporter_service.rs`（APKG 导出）
- `src-tauri/src/anki_connect_service.rs` + `src-tauri/src/cmd/anki_connect.rs`（AnkiConnect）
- `src-tauri/src/cmd/enhanced_anki.rs`、`src-tauri/src/cmd/anki_cards.rs`

**数据库**
- `src-tauri/migrations/mistakes/V20260209__anki_card_dedup_unique.sql`
- anki_cards / anki_tasks 相关表结构

### 关键用户路径（待逐一核验）

1. 独立制卡台：上传/粘贴资料 → 分段 → AI 流式生成卡片 → 实时预览 → 编辑/删除卡片 → 导出 APKG / 推送 AnkiConnect
2. Chat 内制卡：对话中让 AI 制卡 → 工具调用 → 流式卡片块渲染 → 保存到库 / 导出
3. 模板路径：选择/自定义模板 → 字段映射 → 预览渲染 → 导出时模板嵌入
4. 失败恢复路径：生成一半失败/取消/中断 → 用户区分已保存、草稿、失败项 → 重试或撤销
5. 历史任务路径：关闭应用 → 重开 → 任务/卡片是否还在，状态是否可理解

## 1. 数据流图（端到端，已核验）

### 1.1 生成生命周期（唯一活跃链路：Chat → ChatAnki）

```
用户在聊天里说"给我制卡"
  → AI 调 chatanki_analyze（可选，纯启发式）→ chatanki_run(goal, maxCards*, templateMode*, resourceIds?)
  → ChatAnkiToolExecutor::execute_run
      ├─ 预分配 documentId；立即持久化 anki_cards 块（status=running）→ 工具秒回 "started"
      └─ start_background_pipeline（tokio 后台）
          ├─ 资源解析：纯文本 / VFS 文件提取 / VLM 识图（SimpleText|VlmLight|VlmFull 三路）
          │    └─ 失败/空内容 → ensure_failed_document_session（占位 Failed 任务）+ 块置 ERROR
          ├─ build_generation_options（glossary 启发式、模板字段、maxCards 分配）
          ├─ DocumentProcessingService::process_document_and_create_tasks_with_id
          │    └─ 分段（10k token 或被输出上限钳制）→ N 条 document_task(Pending) 入库
          ├─ EnhancedAnkiService 逐任务调度 → StreamingAnkiService::process_task_streaming
          │    ├─ LLM 流式输出 → 增量 JSON 解析 → anki_cards 入库（含 is_error_card）
          │    └─ 事件: anki_cards chunk(patch/cards) → 前端 ankiCards.ts 事件处理器 → ChatStore 块更新
          └─ 900ms 轮询收尾：全任务终态 → 块置 success/error/cancelled + 终态 cards 合并
  → AI 调 chatanki_wait（同轮，最长 30/60min）拿终态 → 总结给用户
```

### 1.2 卡片消费生命周期

```
anki_cards 块（聊天内）
  ├─ 预览/翻面/编辑/删除 —— 仅改块 toolOutput（persistToolOutput），不回写 anki_cards 表 ←(已记 批次3/A9)
  ├─ 保存到库 saveCardsToLibrary → save_anki_cards(INSERT OR IGNORE) ←(A3/A4/A12)
  ├─ 导出 APKG exportCardsAsApkg → dialogSave → export_multi_template_apkg（多模板、双重过滤错误卡）
  └─ 同步 AnkiConnect importCardsViaAnkiConnect → add_cards_to_anki_connect ←(D1)
任务台 TaskDashboardPage（管理视图）
  ├─ list_document_sessions 聚合 document_task → 展开懒加载卡片 ←(A8 缓存陈旧)
  ├─ 重试/恢复/删除会话 → trigger_task_processing ←(A1 IPC 断裂) / recover ←(A5/A15)
  └─ 导出：selectTaskExportCards 优先聊天块副本 ←(A9)
AI 后续操作：chatanki_status/control/export/sync（跨会话被 not_found 挡 ←C4）
```

### 1.3 模板生命周期

```
内置模板 JSON（src/data + commands.rs include_str!）
  → 每次启动 import_builtin_templates（缺失补齐/版本高则全量覆盖 ←D3）
  → TemplateManager.loadTemplates（启动时还做 CSS overflow 静默改写 ←D4）
用户 CRUD：TemplateManagementPage/编辑器 → create/update(乐观锁)/delete(无引用检查 ←D5)
导入导出：export_template(JSON) / import_template(覆盖=先删后建 ←D2) / import_custom_templates_bulk(保 id)
消费方：生成（generation_prompt+字段抽取规则）、渲染（front/back_template+css，DOMPurify+iframe 沙箱）、
        APKG（每 template_id 一个 model）、AnkiConnect（note_type → 本机模型名 ←D1）
```

### 1.4 死代码层（不在任何活跃路径上，但仍在仓库里）

- 后端：`anki_executor.rs`（旧桥接工具，未注册）
- 前端：CardAgent 的 `anki_tool_call/anki_tool_result` 事件桥、`ChatV2AnkiAdapter`、`AnkiPanelHost`+`useAnkiPanelV2Bridge`+`dispatchOpenAnkiPanelEvent`（零调用）、`BatchOperationToolbar`、`IntegrationTest.tsx`
- 半死：`useCardForge`/`TaskController`（仅被死 UI 与测试引用；其 cancel=delete_document_session 的破坏性语义若复活即成缺陷 ←C2）

## 2. 问题清单

> 级别：🔴 严重（正确性/安全/数据一致性）；🟡 中等（体验/稳定性/可维护性）；🟢 轻微（可改进）

### 批次 1：任务台（TaskDashboardPage）+ 命令层 + 数据库层

- [🔴 A1] IPC 契约破坏：`trigger_task_processing` 前端全部传 `task_id`，后端期望 `taskId`，"重试失败任务"全链路必然报错
  - 证据：后端 `src-tauri/src/cmd/enhanced_anki.rs:124` 定义 `task_id: String` 且无 `rename_all = "snake_case"`；tauri-macros 2.x 默认把参数 key 转为 lowerCamelCase（已核对 `tauri-macros-2.5.4/src/command/wrapper.rs` 第 460-466 行与 `tauri-2.10.2/src/ipc/command.rs` 的 `v.get(self.key)` 严格匹配，无 snake_case 回退）。
  - 前端三个调用点全部传 snake_case：`src/components/anki/TaskDashboardPage.tsx:421`、`src/components/anki/cardforge/engines/TaskController.ts:220`、`src/components/anki/cardforge/engines/CardAgent.ts:471`。
  - 影响：任务台"重试失败"按钮、CardForge 引擎的单任务重试、CardAgent 自动重试**全部**会收到 `invalid args: missing required key taskId` 错误。失败任务永远无法通过 UI 重试。
  - 旁证：`tests/vitest/anki/cardforge/TaskController.test.ts:102` 断言 `{ task_id: 'task-2' }` —— 测试按（错误的）实现写，掩盖了契约断裂。
  - 建议：后端命令加 `#[tauri::command(rename_all = "snake_case")]` 或前端统一改 `taskId`；补一条真实 IPC 集成冒烟测试。
  - 验证：在任务台对一个失败任务点"重试失败"，观察 console/通知报错。

- [🔴 A2] 同类契约破坏：`chatApi.deleteAnkiCard` 传 `card_id`，后端 `delete_anki_card` 期望 `cardId`
  - 证据：`src/utils/chatApi.ts:172` `invoke('delete_anki_card', { card_id: cardId })`；后端 `src-tauri/src/cmd/enhanced_anki.rs:205` `card_id: String`（默认 camelCase key）。对照 `src/services/ankiApiAdapter.ts:140` 用 `cardId`（正确）。
  - 影响：凡走 `chatApi.deleteAnkiCard` 的删除卡片操作必然失败。
  - 建议：与 A1 一并统一契约；用 TS 层封装一处 invoke 适配，禁止散落手写 key。

- [🔴 A3] `save_anki_cards` 在"全部卡片因内容去重被忽略且 id 不存在"时返回假成功
  - 证据：`src-tauri/src/cmd/anki_connect.rs:427-441` —— `save_document_task_with_cards_atomic` 对卡片用 `INSERT OR IGNORE`（`src-tauri/src/database/mod.rs:3918`），全部被忽略时报 `no_cards_saved_in_atomic_insert`，回退逻辑对每张卡执行 `update_anki_card`（`UPDATE ... WHERE id = ?`）。若卡片 id 是新生成的（与库中重复内容的旧卡 id 不同），UPDATE 影响 0 行**且不报错**，最终返回 `saved_ids = 全部新 id`，前端显示保存成功。
  - 影响：用户看到"已保存 N 张"，但库中既没有这些 id，也没有更新任何内容 —— 假成功 + 幽灵 id。典型触发路径：同一聊天块重复保存但前端未传稳定卡片 id。
  - 建议：回退路径改为按去重键（source_id+内容）定位已有行返回其真实 id；UPDATE 0 行时显式报告"已存在/跳过"。
  - 验证：连续两次以不同卡片 id、相同内容调用 `save_anki_cards`，检查第二次响应与 DB 实际行数。

- [🔴 A4] 部分插入时静默丢弃重复卡片，且混合场景下用户编辑丢失
  - 证据：`src-tauri/src/database/mod.rs:3916-3946` —— 部分卡片 INSERT 成功即 commit，被 IGNORE 的卡片不更新、不报告（仅不出现在 saved_ids）；`cmd/anki_connect.rs` 不向前端区分"保存/跳过/失败"。
  - 影响：用户保存 10 张，其中 3 张与历史内容重复 → 实际只保存 7 张，但 UI 无任何"跳过 3 张"的提示；若重复的 3 张是用户编辑过的（id 不同、内容与旧卡相同的镜像场景），编辑结果静默丢失。违反 FABLE 目标"AI 生成卡片失败一半，用户能区分已保存、草稿、失败项"。
  - 建议：响应结构增加 skipped/duplicated 明细；前端通知展示。

- [🟡 A5] 任务台"恢复卡住任务"语义与用户预期不符：只重置 >1 小时的任务，且重置为 Pending 后无人调度
  - 证据：`src-tauri/src/database/mod.rs:5531-5541`（`updated_at < datetime('now','-1 hour')` 才重置）；重置后状态为 `Pending`，而 `list_document_sessions`（5560 行）把 `Pending` 计入 active_tasks → 前端 classify 显示"进行中"转圈。未发现任何后台调度器轮询 Pending 任务自动续跑（启动时 lib.rs:1948 仅做同样的状态重置）。
  - 影响：用户看到任务卡在"进行中"，点"恢复卡住任务"提示"没有卡住的任务"（不足 1 小时），或恢复后任务永远停在 Pending（显示为进行中转圈），除非手动逐个触发 `trigger_task_processing`（而它又因 A1 坏了）。
  - 建议：恢复命令返回后立即对 Pending 任务重新投递处理；或把 Pending 显示为"等待中/需手动继续"并提供续跑按钮。
  - 验证：制卡中途强杀应用 → 重开 → 观察任务状态与"恢复"按钮行为。

- [🟡 A6] 仪表盘"模板数"统计口径错误
  - 证据：`src-tauri/src/database/mod.rs:5608-5612` —— `COUNT(DISTINCT template_id) FROM anki_cards`，统计的是"被卡片引用过的模板数"，而 UI（`TaskDashboardPage.tsx:1118-1123`）把它显示在"模板"属性行并紧跟"打开模板库"按钮，用户心智是"模板库里有多少模板"。
  - 影响：新用户模板库有 N 个内置模板但显示 0；误导。
  - 建议：改查 custom_templates 表计数。

- [🟡 A7] `get_recent_anki_cards` 列索引错位（latent bug + 死代码）
  - 证据：`src-tauri/src/database/mod.rs:5622-5658` —— SELECT 13 列（extra_fields_json=11、template_id=12），代码读 `row.get(12)` 当 extra_fields、`row.get(13)`（越界）当 template_id；任何调用必报 `InvalidColumnIndex`。其唯一入口命令 `get_all_recent_cards`（commands.rs:4145）在前端无调用者。
  - 影响：当前为死代码；一旦"恢复最近卡片"功能接入即全量失败。
  - 建议：修复索引或删除死命令；补单测。

- [🟡 A8] 任务台展开区卡片缓存只增不减、不感知编辑
  - 证据：`src/components/anki/TaskDashboardPage.tsx:379-388` —— 仅当 `session.totalCards > cards.length` 时重新加载；卡片被删除（数量减少）或被编辑（数量不变）时展开区显示陈旧数据；`handleQuickExport`（455-495 行）还会把"聊天块编辑副本"写进展开区 state（`setCards(sourceCards)`），与"任务库卡片"视角混用。
  - 影响：用户在聊天里编辑/删除卡片后回到任务台，看到旧内容；导出一次后展开区内容悄然变成另一来源。
  - 建议：展开时始终拉最新；导出流程不要复用展示 state。

- [🟡 A9] 导出来源选择规则会让"任务库的新卡片"被旧聊天块快照遮蔽
  - 证据：`src/components/anki/utils/normalizeTaskCardsForExport.ts:25-33` —— 只要聊天块持久化副本非空就**完全**用它；若用户后来在任务库中重试生成了更多卡片（或删除了某些卡片），导出内容与任务台显示的 totalCards 不一致。
  - 影响：导出的 apkg 卡片数与界面所示不符，违反所见即所得。
  - 建议：按更新时间或卡片 id 集合做合并/提示，至少在数量不一致时给出警告。

- [🟡 A10] `update_anki_card` 命令强制 front/back 非空，对模板卡/填空卡不成立
  - 证据：`src-tauri/src/cmd/enhanced_anki.rs:185-191`（front/back 为空直接报错）；但保存路径允许 back 为空（`cmd/anki_connect.rs:384-388` back 缺省为 ""），填空卡内容在 `text`/extra_fields。
  - 影响：用户编辑一张合法的"back 为空"的卡片（如 cloze 卡）再保存会被拒绝："卡片背面不能为空"。
  - 建议：校验放宽为"front/back/text/extra_fields 至少一项非空"，与模板类型联动。

- [🟡 A11] 编辑卡片可能撞内容去重唯一索引，错误不友好
  - 证据：唯一索引 `idx_anki_cards_dedup_unique`（`V20260209__anki_card_dedup_unique.sql:40-50`）作用于 UPDATE；`update_anki_card`（database/mod.rs:4238）撞索引时返回原始 SQLite 错误（"UNIQUE constraint failed: ..."）。
  - 影响：用户把卡 B 改得与卡 A 内容一致 → 收到数据库术语报错，无法理解。
  - 建议：捕获该约束错误转译为"已有内容相同的卡片"。

- [🟡 A12] `save_anki_cards` 每次调用都新建一个 `document_task` 行，重复保存会虚增任务/统计
  - 证据：`cmd/anki_connect.rs:325`（每次 `task_id = Uuid::new_v4()`）+ `save_document_task_with_cards_atomic` 先插任务行；只有"全部卡片被忽略"才回滚任务行；"部分插入"时也会留下新任务行。
  - 影响：同一聊天块多次保存 → 同一 document_id 下任务数膨胀，任务台 totalTasks/completedTasks 虚高，进度条含义失真。
  - 建议：以 (document_id, 来源块) 幂等复用任务行。

- [🟢 A13] 运行时 `ALTER TABLE ... ADD COLUMN`（set/get_document_session_source、list_document_sessions）绕过迁移体系
  - 证据：`database/mod.rs:3829-3832, 3844-3847, 5547-5550`。
  - 影响：schema 漂移不可追踪，数据治理/同步的 schema registry 可能不感知该列。
  - 建议：转为正式迁移文件。

- [🟢 A14] 任务台统计"今日/本周制卡"按会话 createdAt 归集而非卡片时间
  - 证据：`TaskDashboardPage.tsx:945-959`。旧会话今天新增的卡片不计入"今日"。
  - 建议：后端补 per-day 卡片统计。

- [🟢 A15] `timeAgo`/`formatDate` 直接 `new Date(iso)` 解析后端 RFC3339/`%Y-%m-%dT%H:%M:%fZ` 混合格式
  - 证据：后端有两种时间写法：`chrono::Utc::now().to_rfc3339()`（含 +00:00）与 SQLite `strftime('%Y-%m-%dT%H:%M:%fZ','now')`（含 Z）。均可被 WebKit 解析，目前无伤；但 `recover_stuck_document_tasks` 的比较 `updated_at < datetime('now','-1 hour')` 是**字符串比较**，`to_rfc3339()` 产生的 `+00:00` 后缀与 `datetime()` 输出格式（`YYYY-MM-DD HH:MM:SS`，含空格）排序语义不同：`2026-06-11T09:00:00+00:00` 与 `2026-06-11 08:00:00` 比较时 `T`(0x54) > 空格(0x20)，恒为"更大" → **使用 RFC3339 存的任务永远不会被判定为卡住**。
  - 影响：恢复机制对一半的写入路径完全失效（取决于该行 updated_at 的写入来源）。
  - 建议：统一时间格式；比较改用 `datetime(updated_at) < datetime('now','-1 hour')`。
  - 验证：插入一条 updated_at 为 RFC3339（带 T）的 Processing 任务且时间为 2 小时前，调用恢复命令观察是否被重置。

### 批次 2：后端生成管线（enhanced_anki_service + streaming_anki_service）

- [🔴 B1] 模型"收尾客套话"会被当成截断错误卡，并触发自动重试任务，生成用户没要的卡片
  - 证据：`src-tauri/src/streaming_anki_service.rs:954-959` —— 流结束后残留 buffer 非空即 `create_error_card(&buffer)`；模型在最后一张卡片分隔符之后输出任何"以上就是全部卡片"之类文本都会变成 is_error_card=1 的记录。随后 `enhanced_anki_service.rs:309`（每次主流程结束）自动调用 `build_retry_task_for_document`，把这些"错误内容"再次喂给 LLM"逐条修复并补全为有效的 Anki 卡片JSON"（streaming_anki_service.rs:2232-2247）→ 可能凭空多生成卡片。
  - 影响：a) 任务台出现莫名"错误卡片 N 张"；b) 自动追加一个"错误卡修复"任务，额外消耗 token 并可能产出与原文无关的卡片；c) totalTasks +1，统计失真。
  - 建议：残留 buffer 先尝试 JSON 解析/启发式判别是否像卡片内容，纯自然语言收尾应丢弃；自动修复任务应默认需用户确认。
  - 验证：用一个习惯输出结尾语的模型生成 → 观察错误卡与"错误卡修复"任务。

- [🔴 B2] 固定 30 秒空闲超时对思考型模型必然误杀
  - 证据：`streaming_anki_service.rs:756`（`IDLE_TIMEOUT: 30s`）+ 770 行 `timeout(IDLE_TIMEOUT, stream.next())`。Reasoning 事件虽被忽略（917 行）但能喂活计时器；若供应商在深度思考阶段不下发任何字节（常见于部分 OpenAI 兼容中转/非流式思考），30 秒即报"AI响应超时"→ Truncated。
  - 影响：用户配置 o 系列/R1/Gemini thinking 等模型时任务高概率假失败；且 handle_task_error 以"消息含'超时'"分类为 Truncated（2120 行），状态语义靠字符串匹配，英文错误消息（"timeout"）会被错分为 Failed。
  - 建议：超时阈值可配置/放宽首 token 阈值；错误分类改用枚举。

- [🔴 B3] 任务失败原因对用户完全不可见
  - 证据：`update_task_status` 把 error_message 写入 document_tasks（streaming_anki_service.rs:2027-2029），但任务台 SessionRow 展开区只展示错误卡片的 error_content（TaskDashboardPage.tsx:716-740），从不读取/展示 task.error_message；list_document_sessions 也不返回它。
  - 影响：典型场景"未配置制卡模型"（get_configurations 报错，streaming_anki_service.rs:356-360）→ 用户只看到"失败 1"，不知道是配置问题还是网络问题，更不知道去设置页修复。直接违反 FABLE 目标"用户能判断是账号配置、网络、provider 限制还是内部错误"。
  - 建议：list_document_sessions 聚合最近一条 error_message 返回；展开区显示每个失败任务的原因与修复指引。

- [🟡 B4] 暂停语义混乱：软暂停通道无人使用，硬暂停丢弃已生成内容，暂停后会话仍显示"进行中"
  - 证据：`pause_streaming/resume_streaming`（2152-2171）在全代码库无调用方（仅 cancel_streaming 被用）；硬暂停取消流后整个 buffer 丢弃（768 行直接 return Err），已花费的 token 浪费，恢复后整段重跑（靠去重索引兜底）；暂停只把"正在跑的任务"标为 Paused，排队中的任务保持 Pending，而 `list_document_sessions` 把 Pending 计入 activeTasks → 前端 classify 显示"进行中"+转圈（用户明明点了暂停）。
  - 影响：用户心智"暂停=停住且可见暂停态"被破坏；token 浪费。
  - 建议：暂停时把同文档 Pending 一并置为 Paused；或 classify 把 paused>0 的会话优先显示"已暂停"。

- [🟡 B5] `process_all_tasks_async` 用 20ms sleep 缓解取消通道注册竞态
  - 证据：`enhanced_anki_service.rs:259-260`（"短暂让出以便流任务完成取消通道注册，降低竞态窗口"）。任务启动后 20ms 内点暂停 → cancel_streaming 找不到通道 → 回退 `JoinHandle::abort()`（431-433 行），任务在任意 await 点被硬杀。
  - 影响：abort 可能发生在"已写 Streaming 状态、未写终态"之间 → 任务永久停在 Streaming（前端永远转圈），只能靠 1 小时后的 recover_stuck（且受 A15 字符串比较缺陷影响可能永远不触发）。
  - 建议：注册通道先于任务启动；abort 后补写终态。

- [🟡 B6] 取消语义缺失 `Cancelled` 终态：状态机存在 Cancelled 但取消路径从不写入
  - 证据：`process_task_and_generate_cards_stream` 收到 CANCELLED_BY_USER 时"保持暂停态由调度层处理"（324-327 行），调度层只写 Paused；`TaskStatus::Cancelled` 仅在 chatanki 链路使用。而 list_document_sessions 把 Cancelled 计入 failed_tasks（5559 行），`trigger_task_processing` 又拒绝重试 Cancelled 任务（仅 Pending|Failed|Truncated，enhanced_anki_service.rs:560-565）。
  - 影响：Chat 链路取消的任务被算成"失败"，且无法重试 —— 死路（只能删除整个会话）。
  - 建议：统一取消终态语义，并允许重试 Cancelled。

- [🟡 B7] 错误卡修复完成后，原错误卡永远留存，错误统计永不归零
  - 证据：`build_retry_task_for_document` 修复时仅给原错误卡打 `[RETRY_ASSIGNED]` 标记（2267-2276 行），修复成功后不删除/不标记已修复；`get_anki_stats.errorCards` 持续累计。防重检查 `t.content_segment.contains("错误卡修复")`（2199-2204 行）匹配的字符串实际写在 original_document_name 而非 content_segment —— 该检查恒假（死代码，靠 RETRY_ASSIGNED 兜底）。
  - 影响：用户修复后错误计数不变，"需要关注"状态可能永远挂着。
  - 建议：修复成功后删除/降级原错误卡；修正防重检查字段。

- [🟡 B8] `front` 兜底链最后会把整段原始 JSON 塞进卡片正面
  - 证据：`streaming_anki_service.rs:1525-1527` `front = json_value.to_string()`。
  - 影响：模板字段不匹配时用户拿到一张正面是 `{"concept":"...","definition":"..."}` 的卡，导出后也是 JSON。比报错更糟糕（劣质数据入库且参与去重键）。
  - 建议：该兜底改为生成错误卡或丢弃并提示。

- [🟡 B9] extra_fields 键统一小写化与模板字段原大小写的映射依赖各消费端自行兼容
  - 证据：`extract_fields_with_rules` 以 `field_name_lower` 写入（1390 行）、legacy 同样小写（1962 行）；前端 `getCardFieldValue` 同时尝试两种（TaskDashboardPage.tsx:298-316）。导出侧（apkg_exporter / AnkiConnect note 构建）是否大小写不敏感待批次 4 核验 —— 若不是，模板字段值将丢失。
  - 影响：跨层契约靠约定，无单点 SSOT。

- [🟢 B10] 请求体伪装 Chrome UA、Accept-Language 写死 zh-CN（streaming_anki_service.rs:712-718）；调试日志整段输出 prompt（700-710 行，含用户文档内容）到日志文件，体积与隐私都值得收敛。

- [🟢 B11] `max_cards_total` 与 `max_cards_per_mistake<=0` 的组合直接把任务标记 Completed 跳过（243-254 行），额度分配逻辑分散在前后端两侧，前端若给某段分配 0 张会看到"完成"但 0 卡片，无说明。

### 批次 3：Chat 内制卡链路（ChatAnkiToolExecutor，5779 行）

> 关键架构事实：`pipeline.rs:226` 注明"AnkiToolExecutor 已移除 — 旧 CardForge 2.0 管线由 ChatAnki 完全接管"。聊天制卡的**真实链路**是 `chatanki_executor.rs`（后端原生，不依赖前端桥接），工具 schema 与工作流提示词定义在 `src/features/chat/skills/builtin/index.ts:127-427`（chatanki skill）。

- [🔴 C1] `maxCards` 必传 + 达到上限即"取消"：词汇表全覆盖目标必然失败，且完成被标成"已取消"
  - 证据链：
    1. skill schema 要求 `required: ['goal','maxCards','templateMode']`（builtin/index.ts:211），提示词强制"绝不允许不传 maxCards"（425 行），AI 必须自行估数（"超长文档→30~80 张"）。
    2. `build_generation_options`（chatanki_executor.rs:4678-4698）里 glossary 模式"不限制、由内容条目数决定"的分支只在 `max_cards_override` 为 None 时生效 —— 而 maxCards 必传，**该分支永远不可达**，词汇表"每条目 1 张、不要遗漏"的精心设计（build_chatanki_requirements:4725）被上限截断。
    3. 达到上限后（3465-3499 行）：运行中任务被 `cancel_streaming`，Pending/Paused 全部置 `Cancelled`（error_message=GLOBAL_CARD_LIMIT_REACHED），超限卡片在收尾时被**静默删除**（3595-3598 行）。
    4. 收尾 stage 计算只看 `has_cancelled`（3619-3623）→ final_stage="cancelled"，messageKey="...messages.cancelled"；`chatanki_wait`/`chatanki_status` 同样返回 "cancelled"（derive_status_snapshot:5103）。
  - 影响：用户贴 120 条名词解释 → AI 估 60 张 → 只得 60 张且 UI/AI 都说"制卡已取消"。三重心智违背：①数量不达预期；②成功完成被报告为取消（AI 可能向用户道歉"任务被取消了"并重试 → 重复制卡）；③多生成的卡被悄悄删掉。
  - 建议：limit 触发的取消用独立终态/标记（如 limit_reached），收尾时 GLOBAL_CARD_LIMIT_REACHED 的 Cancelled 不计入"取消"判定；词汇表模式允许 maxCards 留空或按条目数自动放大；删除超限卡前在 warnings 中告知。
  - 验证：粘贴 120 条术语、不指定数量 → 观察最终卡数、块状态文案、AI 的总结话术。

- [🔴 C2] 旧"前端桥接"制卡链路成为死代码残骸，但其入口仍部分可达，行为与新链路冲突
  - 证据：`anki_executor.rs`（490 行，anki_generate_cards/anki_control_task/... 桥接到前端 CardAgent）已不再注册（pipeline.rs:226），AI 无法调用；但 ① `executor_registry.rs` 的超时表仍为其保留 120s 默认值；② 前端 `CardAgent.ts` 的事件桥（监听 `anki_tool_call`、回发 `anki_tool_result`）、`chatV2Adapter.ts`、`useCardForge.ts` 等仍完整保留并被**独立制卡台**复用；③ 批次 1 发现的 CardAgent 缺陷（5 分钟收集器超时返回部分成功、controlTask('cancel') 调 `delete_document_session` 删除全部卡片、APKG 导出单模板降维与字段大小写丢失）在独立制卡台路径上仍真实可达。
  - 影响：双链路并存（chat=chatanki 后端原生；独立制卡台=CardAgent 前端引擎），同名概念行为不同：chat 里"取消"保留卡片（chatanki_executor.rs:2028-2064），制卡台里"取消"删除会话与卡片 —— 同一产品内同词不同义，违反用户心智一致性。
  - 建议：删除 anki_executor.rs 与前端桥接事件代码；统一"取消"语义为非破坏性，删除行为单独命名"删除会话"。
  - 验证：在制卡台进行中任务上点取消，对比聊天里让 AI 取消制卡的结果（卡片是否保留）。

- [🟡 C3] `chatanki_status` 不返回任务列表/taskId → `chatanki_control(retry, taskId)` 对 AI 不可用
  - 证据：execute_status 输出仅 `counts/cardsCount/error/shouldRetry`（chatanki_executor.rs:508-515）；任何 chatanki 工具都不返回 per-task id（卡片 JSON 里的 task_id 在块 toolOutput 中，不进入工具结果）。control 的 retry-with-taskId 分支（1982-2012 行）因此永远无法被 AI 正确填参。
  - 影响：精确重试单个失败分段的能力形同虚设，AI 只能整体 retry → 走 `build_retry_task_for_document`（受 B7 缺陷影响：防重检查恒假、错误卡残留）。
  - 建议：status 返回 tasks 摘要（id/segment_index/status/error_message 截断版）；或 control.retry 支持"重试全部失败分段"。

- [🟡 C4] 跨会话所有权校验把"别的会话的任务"与"不存在"统一报 not_found，且 shouldRetry=true 鼓励 AI 重复制卡
  - 证据：verify_document_ownership（289-306 行）对 Ok(Some(其他会话)) 与 Ok(None) 一律返回 statusNotFound；execute_wait/status 对 not_found 设置 `shouldRetry: true`（978 行、derive_status_snapshot:5115）。
  - 影响：用户换了个会话说"继续上次那个制卡/导出昨天那批卡"→ AI 查 status 得 not_found + shouldRetry → 倾向重新发起一次完整制卡 → 重复任务与卡片。安全边界本身合理（A 会话不能操作 B 会话任务），但错误语义应区分"无权访问（请回原会话或去制卡台）"与"不存在"，shouldRetry 不应为 true。
  - 建议：返回独立错误 key（如 belongsToOtherSession），提示词指引 AI 引导用户去任务台操作。

- [🟡 C5] AI 驱动的 `chatanki_sync` 成功后不更新 anki_cards 块的 syncStatus
  - 证据：execute_sync（1551-1846 行）完成后仅写工具结果，不 patch 块的 `tool_output.syncStatus`（块内仍是创建时的 "pending"）；前端块 UI 的同步状态只在用户点击块内按钮时更新。
  - 影响：用户让 AI"同步到 Anki"成功后，预览块仍显示未同步 → 用户可能再点一次块内同步 → AnkiConnect 重复添加（或触发去重报错），状态双轨。
  - 建议：sync 成功后 persist_anki_cards_running_patch 更新 syncStatus/ankiConnect 字段。

- [🟡 C6] 后台管线 30 分钟硬超时：超时即整体取消且不可恢复
  - 证据：MAX_TOTAL_DURATION=30min（3371 行），超时把所有未完成任务置 Cancelled、块置 ERROR(pipelineTimeout)（3378-3434 行）。而 Cancelled 任务无法被 `trigger_task_processing` 重试（enhanced_anki_service.rs:560-565 仅允许 Pending|Failed|Truncated），任务台也没有"继续生成"入口。
  - 影响：大文档（数百段 × 串行/受限并发）超 30 分钟是常态 → 用户半小时后回来发现"管线超时"，剩余分段全部死路，只能重新制卡（已完成的卡片保留但与新文档 ID 割裂）。
  - 建议：超时改为"暂停"而非"取消"；或允许对 Cancelled 任务恢复；超时阈值按分段数动态放大。

- [🟡 C7] 失败兜底占位任务 content_segment 为空，"重试"会触发空内容制卡
  - 证据：ensure_failed_document_session（2518-2563 行）插入 `content_segment: String::new()` 的 Failed 任务以便 wait/status 收敛；该任务出现在任务台会话列表中（以 goal 命名）。用户/AI 对其 retry → trigger/resume 接受 Failed 任务 → 把空字符串交给 LLM 生成。
  - 影响：空 prompt 制卡 → 模型幻觉输出或报错，再次失败并消耗 token；用户无法理解这个"0 段任务"是什么。
  - 建议：占位任务加专用标记（如 placeholder=1），任务台过滤展示为"启动失败原因"，禁止 retry。

- [🟡 C8] run/start 参数严格性不一致：缺 templateMode 硬失败，缺 maxCards 静默放开
  - 证据：`ChatAnkiRunArgs.template_mode` 为必填枚举（无 #[serde(default)]，99-129 行），模型漏传 → "Invalid chatanki_run arguments: missing field templateMode"，浪费一轮工具调用；`max_cards` 是 Option 且容忍字符串/空串（68-97 行），漏传则不限量。schema 把两者都标 required，但运行时一硬一软。
  - 影响：对模型容错不对称；templateMode 完全可以默认 all（与提示词推荐一致）。
  - 建议：template_mode 加 `#[serde(default)]`（默认 All）；或两者一致硬校验并在错误信息中给出修正示例。

- [🟢 C9] `chatanki_analyze` 是纯启发式（无 LLM），返回的 recommended（temperature/segmentOverlapSize/maxOutputTokensOverride）没有任何 chatanki_run 参数能承接 —— 纯装饰性输出，可能诱导 AI 编造不存在的参数。建议：要么让 run 接受这些覆盖项，要么从输出中移除。
- [🟢 C10] 后台轮询每 900ms 全量 `get_tasks_for_document` + `get_cards_for_document`（3436-3443 行），30 分钟最多 2000 轮 × 全卡片反序列化；大文档（数千卡）有明显 CPU/IO 浪费。建议增量查询（WHERE created_at > last_seen 或 LIMIT/OFFSET 游标）。
- [🟢 C11] `distribute_global_max_cards` 在 chatanki_executor.rs:5055 与 document_processing_service.rs:706 重复实现两份（逻辑一致），仅其一有测试 —— SSOT 缺失，将来改其一必漂移。
- [🟢 C12] `execute_export` JSON 导出直接序列化整个 `AnkiCard` 内部模型（含 is_error_card/error_content/task_id 等实现细节字段），导出物即内部 schema —— 后续模型字段重命名会破坏用户已导出文件的可再导入性（若有导入功能）。建议定义稳定导出 DTO。

**批次 3 正面确认（设计良好，无需修改）**：
- 预分配 documentId + 提前持久化 anki_cards 块（2270-2366 行），彻底解决了旧桥接"工具超时但前端还在跑"的割裂 —— run/start 秒回 "started"，重活全在后台。
- `chatanki_wait` 设计完善：默认 30min/上限 60min、block 发现 8 秒宽限、取消响应、timeout 与 not_found 语义区分（decide_wait_timeout_status 对 <5s 小超时不误报 not_found）。
- `tool_loop.ordered_tool_calls_for_execution`（1314-1397 行）对同轮 run→wait→export 做依赖感知排序，缓解模型并发调用顺序错误。
- chat 链路"取消"保留已生成卡片（非破坏性）；execute_sync 返回 added/failed/partial 三态统计；APKG 导出用 export_multi_template_apkg 支持每卡独立模板。
- 文本提取 10MB 上限与下游对齐；glossary 单换行归一化；启动失败时 ensure_failed_document_session 保证 wait/status 能收敛到终态（机制本身正确，仅占位任务展示/重试有 C7 问题）。

### 批次 4：模板生命周期 + 导出/同步终端环节 + 前端块渲染编辑 + 文档分段

> 本批覆盖：`commands.rs` 模板 CRUD/导入导出/内置模板同步、`ankiTemplates.ts`（前端 TemplateManager）、`anki_connect_service.rs`、`apkg_exporter_service.rs`（字段映射复核）、`document_processing_service.rs`（分段）、`AnkiPanelHost`/`useAnkiPanelV2Bridge`/`useCardForge`/`TaskController`（前端面板与引擎）、`htmlSandboxPolicy.ts`（渲染安全）。

- [🔴 D1] AnkiConnect 同步对"模板卡"基本不可用：从不创建 Anki 模型，且不处理重复导致的误导性报错
  - 证据链：
    1. 全仓库无任何 `createModel` 调用（rg 证实）。`add_cards_to_anki_connect`（cmd/anki_connect.rs:201-227）把卡片的 `template_id` 映射为 `template.note_type` 作为 modelName 直接发给 AnkiConnect。
    2. 自定义模板的 note_type（如"选择题"或任意字符串）在用户本机 Anki 中几乎必然不存在 → `addNotes` 对这些卡返回 null → 全部计入"失败"。
    3. `addNotes` 请求不带 `options.allowDuplicate/duplicateScope`（anki_connect_service.rs:473-481），Anki 默认拒绝重复笔记 → 用户第二次点同步（或部分失败后重试）时，已存在的卡全部返回 null。
    4. 失败时的统一文案是猜测式的："所有卡片同步失败，可能是重复卡片或字段/模板不匹配"（cmd/anki_connect.rs:243-246）。
  - 影响：① 用模板生成的卡（选择题/填空增强等）同步必然失败且原因不可知；② 重复同步被报告成"同步失败"，但实际卡已在 Anki 里 —— 用户会反复重试、怀疑数据丢失。心智模型期望：同步应幂等，重复应报告"N 张已存在"。
  - 建议：同步前用 `modelNames` 校验，缺失模型时用 `createModel` 自动创建（字段+模板 HTML/CSS 都来自 custom_template，数据齐全）；用 `canAddNotes` 预检并把"重复"与"失败"分开统计返回；错误文案区分 模型缺失/重复/字段为空。
  - 验证：用"选择题卡片"模板生成卡 → 同步到干净的 Anki → 观察结果；同一批卡同步两次 → 观察第二次的报告。

- [🔴 D2] 模板"覆盖导入"先删后建：校验失败会把旧模板也弄丢，且新模板换 ID 导致存量卡片绑定断裂
  - 证据：`import_template`（commands.rs:2441-2501）流程为：发现同名 → **先 delete 旧模板**（2465-2470）→ 之后才 `validate_template_request`（2493）→ create。校验失败时旧模板已删除且不回滚。同时 create 走 `create_custom_template` 生成**新 id**，而 `import_custom_templates_bulk` 用 `create_custom_template_with_id` 保留 id —— 两条导入路径语义不一致。
  - 影响：① 用户导入一个有缺陷的模板文件并勾选"覆盖" → 旧模板直接消失；② 即使导入成功，所有 `anki_cards.template_id` 仍指向旧 id → 预览/导出全部静默降级 Basic（多模板导出在 cmd/anki_connect.rs:1116-1118 对查不到的模板回退 Basic），用户看到的是"卡片样式突然全没了"。
  - 建议：校验前置；覆盖时保留原 id（update 而非 delete+create）；或导入后把引用旧 id 的卡片迁移到新 id。
  - 验证：创建模板 A 并生成卡片 → 导出 A → 改名后再"覆盖导入" → 检查旧卡片的预览与 APKG 导出是否仍带模板。

- [🔴 D3] 内置模板的"编辑/删除自由"是假的：启动版本同步会覆盖用户编辑、复活已删除的内置模板
  - 证据链：
    1. `update_custom_template` 注释明确"内置模板只是不能被删除，但可以被修改"（commands.rs:2344-2346）；而 `delete_custom_template` 又注释"允许删除内置模板"（2402-2405）—— 两处自相矛盾，实际都放行。
    2. 前端每次启动调用 `import_builtin_templates`（ankiTemplates.ts:36，"缺失则补齐，版本落后则覆盖更新"）。
    3. 后端逻辑（commands.rs:2829-2954）：同 id 存在且 `should_update_builtin_template(existing.version, builtin_version)` 为真 → 用 JSON 内容**全量覆盖** name/fields/front/back/css/prompt/规则；id 不存在（被删过）→ 重新创建。
    4. 前端 `updateTemplate` 会把 version 从请求中剥离（ankiTemplates.ts:301），用户编辑不改变版本号 → 一旦应用升级附带更高版本的内置模板 JSON，用户对内置模板的所有定制被静默清空。
  - 影响：用户长期维护的"在内置模板上改的提示词/CSS"在某次升级后无声丢失；删除的内置模板每次重启都复活。两者都严重违反"我的修改会被保留"的基本心智。
  - 建议：内置模板被用户修改时落一个 `user_modified` 标记，版本同步跳过并提示"有新版本（查看差异/恢复默认）"；删除内置模板改为 `is_active=false`（隐藏）而非物理删除，启动同步尊重隐藏标记。
  - 验证：改"极简卡片"的 CSS → 手动调用 import_builtin_templates（或把 JSON 版本调高）→ 观察编辑是否还在；删除内置模板后重启应用。

- [🟡 D4] 前端启动时静默"修复"所有模板 CSS，且正则带 /g 标志用 .test() 导致漏修（状态性 bug）
  - 证据：ankiTemplates.ts:57-78 每次加载模板都把 `overflow: hidden;` 替换为 `overflow: visible;` 并直接写回数据库（不经用户同意，连用户自建模板也改）；`fixOverflowRegex` 声明为 `/overflow:\s*hidden\s*;/gi` 后用于 `filter(t => fixOverflowRegex.test(...))` —— 带 g 标志的 RegExp.test 在多次调用间保留 lastIndex，会跳过部分本应命中的模板（经典 JS 陷阱），导致"有的模板被改有的没被改"的非确定行为。
  - 影响：① 用户刻意写的 `overflow:hidden`（裁剪装饰、轮播等）被偷偷改掉，模板渲染变形且每次启动都会再来一次；② 漏修 bug 让行为不可预测。
  - 建议：删除这个启动副作用（或仅对渲染时的预览容器做处理，而不改源数据）；如必须保留，去掉 g 标志或改用 `t.css_style.includes()` 判断。

- [🟡 D5] 删除模板无引用检查：在用卡片的 template_id 悬挂，样式静默降级
  - 证据：`delete_custom_template`（commands.rs:2395-2417）直接删行，不检查 `anki_cards.template_id` 引用，无"有 N 张卡片正在使用"提示；导出侧对查不到的模板静默回退 Basic。
  - 影响：用户删除一个旧模板后，历史卡片的预览/导出全部退化为 Front/Back 两字段，extra_fields 里的选项/解析等内容不再展示，看起来像"卡片内容丢了"。
  - 建议：删除前统计引用数并二次确认；或软删除（is_active=false）+ 渲染端提示"模板已删除"。

- [🟡 D6] "卡片编辑"侧栏（AnkiPanelHost）是不可达死 UI；若被复活，其数据通路也是断的
  - 证据链：
    1. 打开面板的唯一事件 `open-anki-panel` 只有 `dispatchOpenAnkiPanelEvent`（features/chat/anki/index.tsx:275）会派发，而该函数**全仓库零调用**（rg 证实）；`AnkiPanelHost` 挂在 ChatV2Page:1247 永远等不到事件。
    2. 面板内部：删除/撤销只改 `useAnkiPanelV2Bridge` 的本地 state（useAnkiPanelV2Bridge.ts:95-123），关闭即丢，从不写回块 toolOutput / 任务库；
    3. 导出/同步映射只传 `{id, front, back, tags, fields}`（AnkiPanelHost.tsx:139-145），丢掉 template_id/text/extra_fields/images，且不过滤 is_error_card → 走 `ChatV2AnkiAdapter.exportCards` → CardAgent 单模板降级路径。
  - 关联死代码盘点：`BatchOperationToolbar`（旧分析页批量工具栏，invoke saveAnkiCards/batchExportCards）同样无任何引用；加上批次 3 的 anki_executor.rs / CardAgent 桥接事件，聊天制卡周边已沉积三层死代码。
  - 影响：维护者极易误改死路径以为修了 bug（例如在 AnkiPanelHost 修导出问题）；若哪天把事件接回来，上述编辑丢失/导出降级立即变成线上缺陷。
  - 建议：删除 AnkiPanelHost/useAnkiPanelV2Bridge/dispatchOpenAnkiPanelEvent/BatchOperationToolbar；或接回事件并补"写回块"的持久化。

- [🟡 D7] 分段大小被"输出 token 上限"反向钳制：调小输出上限 → 分段变碎 → 任务数膨胀
  - 证据：`calculate_max_tokens_per_segment`（document_processing_service.rs:269-286）：若 `max_output_tokens_override.or(max_tokens) < 20000`，输入分段上限 = `min(10000, 输出上限/2)`。chatanki 词汇表模式固定 `max_output_tokens_override=Some(2400)`（chatanki_executor.rs:4701）→ 输入分段被钳到 **1200 tokens**；同时 2400 的输出上限在"每条目一卡、不许遗漏"的要求下极易 mid-JSON 截断（→ Truncated → 错误卡 → 修复任务，连锁撞上 B1/B7）。
  - 影响：输出与输入两个独立预算被一个公式耦合；用户/上游调低输出限额，得到的是"分段数翻倍、任务变多、整体时长变长"，完全反直觉。
  - 建议：输入分段大小独立配置；glossary 模式按条目数动态估算输出预算而非固定 2400。
  - 验证：同一文档分别用 max_tokens=2000/8000/默认 跑一遍，对比任务数与截断率。

- [🟡 D8] 全局限额下"0 配额分段"显示为"已完成 0 卡"，无任何解释
  - 证据：maxCards < 分段数时（distribute_global_max_cards：如 2 张限额 5 段 → [1,1,0,0,0]），0 配额分段被直接置 Completed（streaming_anki_service.rs:242-254，该防御本身正确）。任务台/状态里它们就是"完成了但一张卡都没有"。
  - 影响：用户看到 5 个分段 3 个"完成 0 卡"，会以为生成失败或内容被跳过（确实被跳过了，但没人告诉他原因是 maxCards 太小）。
  - 建议：这类任务记一个可展示的 skip 原因（error_message="quota=0 (maxCards 不足)"或独立状态），前端给出"提高 maxCards 可覆盖更多内容"提示。

- [🟢 D9] `split_by_characters` 按 `max_tokens*2` 字符硬切：按自家估算器（中文 1 字≈1 token）这是 2 倍超限段，超长中文段落（无句读）会产出过大分段，徒增截断风险（document_processing_service.rs:183-198）。
- [🟢 D10] `estimate_tokens` 只识别 CJK 基本区（0x4E00-0x9FFF）：扩展区汉字、日文假名、谚文按 0.2 token/字符计 → 日韩文档 token 低估约 5 倍 → 分段过大 → LLM 输入超限或输出截断（document_processing_service.rs:252-258）。
- [🟢 D11] 任务创建循环逐条 insert 无事务（document_processing_service.rs:53-81）：中途失败（磁盘满/锁冲突）残留半截任务集，文档无失败记录，wait/status 会对着残缺任务集收敛出错误结论。
- [🟢 D12] APKG 默认导出路径静默覆盖：AI 链路 `chatanki_export` 固定写 `~/Downloads/<deck>.apkg`（chatanki_executor.rs:1394-1417），同名 deck 第二次导出直接覆盖上一次文件，无去重后缀、无提示（用户块内导出走 dialogSave 不受影响）。
- [🟢 D13] `forceImportTemplates.ts` 用正则解析后端返回的中文结果串（`/新增[:：]?\s*(\d+)\s*个/`）统计成败 —— 后端文案一改即失真；应让命令返回结构化结果。
- [🟢 D14] 模板校验强制 `generation_prompt` 非空（commands.rs:3339-3341）：纯展示型模板（用户只想要个排版，不用于 AI 生成）也被迫编一段提示词，徒增创建摩擦。

### 批次 5：流式解析内核 + 提示词协议 + 字段抽取 + 调度并发 + 双数据源（应用户要求继续深挖）

> 本批逐行核验：`streaming_anki_service.rs` 的 `stream_cards_from_ai`/`extract_card_from_buffer`/`parse_and_save_card`/`extract_fields_with_rules`/`build_prompt`、`enhanced_anki_service.rs` 的调度与校验、去重索引迁移 SQL、块内编辑持久化与 AI 工具数据源的对账。

- [🔴 E1] 流结束后的残余缓冲区不尝试解析，直接整体变成错误卡 —— "最后一张卡必然风险"
  - 证据：`stream_cards_from_ai` 收尾处（streaming_anki_service.rs:954-959）：`if !buffer.trim().is_empty() { create_error_card(&buffer, ...) }`，没有任何"先试着 parse_and_save_card"的尝试。协议要求 LLM 在**每张卡后**输出 `<<<ANKI_CARD_JSON_END>>>`（build_prompt:593），而"最后一张卡之后还要补一个分隔符"恰恰是 LLM 最常遗漏的行为。
  - 影响：每个分段的最后一张卡有相当概率变成错误卡（内容其实是合法 JSON）→ errorCards 计数 +1 → 调度收尾自动触发 `build_retry_task_for_document` 又打一次 LLM（B1/B7 连锁）→ 钱花了、卡重复、错误卡还残留。这能解释"为什么总有零星错误卡"的日常现象。
  - 建议：流结束时对残余 buffer 先 `parse_and_save_card`，成功则入库，失败再降级错误卡；同时提示词改为"最后一张卡后也必须输出分隔符"并在收尾容忍缺失。
  - 验证：构造 mock SSE 流，最后一张卡不带分隔符 → 断言入库为正常卡。

- [🔴 E2] 卡片存在两套事实源且永不合流：块副本（tool_output） vs anki_cards 表 —— 用户删过的卡会在 AI 导出里"复活"
  - 证据链：
    1. 块内编辑/删除只写 `chat_v2_update_block_tool_output`（ankiCardsBlock.tsx:1110-1158），**从不调用** `update_anki_card`/`delete_anki_card`；
    2. 块按钮导出/同步用块副本卡（exportCardsAsApkg/importCardsViaAnkiConnect 的 params.cards）；
    3. AI 的 `chatanki_export`/`chatanki_sync` 却读 DB：`get_cards_for_document`（chatanki_executor.rs:1325、1607）；
    4. 生成运行中后端还会 `persist_anki_cards_running_patch` 全量覆写 tool_output —— 运行中用户编辑与后端 patch 存在丢失更新竞态（前端 onEnd 的 mergeCardsUnique 只能救一部分）。
  - 影响：用户在块里精心删掉 10 张废卡、改好措辞，然后对 AI 说"导出/同步" → 得到的是**未删未改**的 DB 版本；反过来在任务台改的卡，块按钮导出时又不生效。同一批卡在两个入口看到两种内容，这是对"所见即所得"的根本性破坏。
  - 建议：把块内编辑/删除落到 DB（update/delete_anki_card），块仅作视图缓存；或所有导出/同步统一从一处读取并明示数据来源与时间戳。
  - 验证：块内删 1 改 1 → AI chatanki_export → 解包 APKG 对比；任务台改卡 → 块按钮导出对比。

- [🟡 E3] chat 制卡存在隐藏硬上限 100 张：maxCards>100 时整次制卡直接被拒
  - 证据：EnhancedAnkiService 校验 `max_cards_per_mistake > 100 → Err("单次生成卡片数量过多，最大支持 100 张")`（enhanced_anki_service.rs:110-115）；而 chatanki 把 AI 传的 maxCards **未封顶**地塞进该字段（`max_cards_override.unwrap_or_else(...)`，chatanki_executor.rs:4678 —— 注释自称"Cap to <=100"但只对默认分支生效）。skill 提示词又教 AI"预估条目数×1.5"（120 条词汇 → 180）。
  - 影响：长词汇表/用户明说"给我 150 张"→ run 启动即失败，错误进入 ensure_failed_document_session + 块 ERROR；AI 可能换个数字反复试。上限本身（100）从未出现在 schema/提示词里。
  - 建议：要么放开/调高校验，要么在 chatanki 侧 clamp 到 100 并在结果中告知"已按系统上限 100 截断"；skill 提示词同步声明上限。

- [🟡 E4] "恰好 N 张"提示词 × 均匀配额 = 与内容密度失配
  - 证据：card_count_instruction 写"你必须严格生成**恰好 N 张**，不多不少"（streaming_anki_service.rs:572-583），而 N 是全局 maxCards 均分到段的配额（distribute_global_max_cards，按段数均分、与各段内容多少无关）。
  - 影响：薄段被迫凑数（低质卡），厚段被迫截断（漏知识点）。与 C1 叠加构成"数量驱动压倒内容驱动"的系统性质量问题。
  - 建议：提示词改"最多 N 张、按内容定量"；配额分配按各段 token 占比加权而非均分。

- [🟡 E5] 单模板提示词把模板必填字段标注为"可选"，与抽取规则的 is_required 自相矛盾
  - 证据：fields_requirement 对所有非 front/back/tags 字段输出 `“{field}（字符串，可选）”`（streaming_anki_service.rs:536），而模板的 FieldExtractionRule 可声明 `is_required=true`，缺失且无默认值时直接报"缺少必需字段"→ 错误卡（extract_fields_with_rules:1394-1418）。
  - 影响：LLM 被告知"可选"于是省略 → 解析失败 → 错误卡 + 修复任务。提示词与校验器互相拆台。
  - 建议：按 rule.is_required 生成"（必填）/（可选）"标注。

- [🟡 E6] 流式缓冲区 10000 字节硬上限按字节计：单张长卡可在分隔符到达前被误判"截断"
  - 证据：`extract_card_from_buffer` 在无分隔符且 `buffer.len() > 10000`（字节）时清空缓冲并产出错误卡（streaming_anki_service.rs:1009-1024）。中文 3 字节/字 → 约 3300 字即触发；详解型/代码型模板卡完全可能超过。触发后整个缓冲（含半张卡）成错误卡，后续流从残破位置继续解析 → 连锁错误卡。
  - 建议：上限提高且按字符计；超限时先尝试逐个提取完整 JSON 对象再降级。

- [🟡 E7] 生成期去重"静默吞卡"无任何观测性
  - 证据：`insert_anki_card` 撞唯一索引返回 false → `Ok(None)` 只打 debug 日志（streaming_anki_service.rs:838-841、1226-1235），不进事件、不进任务统计、不进块 warnings。
  - 影响：重叠分段（200 字符 overlap）天然会让相邻段生成相似卡 → 被去重吞掉 → 用户数出来的卡比"已生成 N 张"少，无处可查原因。
  - 建议：跳过数计入任务统计并在块 progress/warnings 中呈现（"去重跳过 M 张"）。

- [🟢 E8] 选择题组装硬编码在服务层：optiona-d/correct/explanation 字段名写死（1446-1475、1542-1575），字段名不同的自定义选择题模板不组装 back，≥5 选项丢 E/F；模板语义应由模板自身驱动（SSOT）。
- [🟢 E9] SafetyBlocked 仅 break 内层 events 循环（912 行），外层继续消费流；行为无害但语义混乱，且安全阻断不会中止任务（只多一张错误卡）。
- [🟢 E10] 分隔符协议对内容不设防：学习材料/LLM 引文中若出现 `<<<ANKI_CARD_JSON_END>>>` 或 PHP heredoc 风格 `<<<`（损坏分隔符修复分支 rfind("<<<")，992-1008 行），会提前切断 JSON → 错误卡。建议输出协议改用 JSON 数组流或对分隔符做转义约定。
- [🟢 E11] 填空卡去重键仅 `text`（V20260209 迁移的 CASE 分支）：同文档内 text 相同但 hint/extra 不同的两张 cloze 卡会被静默去重为一张。

### 批次 6：事件桥多会话路由、会话生命周期、AI 模板工具链、VFS 资源解析

- [🔴 F1] `anki_generation_event` 全局广播 + "最新活跃块"回退路由：多会话并发制卡时 A 会话的卡片/进度会错投进 B 会话的块，且会把 B 块永久错绑到 A 的文档
  - 证据：`src/features/chat/adapters/TauriAdapter.ts`
    1. 每个会话的 adapter 都监听全局 `anki_generation_event`（381、506 行），后端按 app-level emit，无会话定向；
    2. 路由逻辑（987-989 行）：`documentId ? findBlockByDocumentId(documentId) ?? findLatestActiveAnkiBlock() : findLatestActiveAnkiBlock()` —— 带 documentId 的事件在本会话找不到匹配块时**不丢弃**，而是回退投递到"本会话最后一个 running/pending 的 anki_cards 块"；
    3. 1000-1001 行注释自称"documentId 存在但本 session 没有匹配的块 → 事件属于其他 session，静默忽略"，与上述实现**直接矛盾**（只有连活跃块都没有时才忽略）；
    4. `ankiEventOwnerAdapterId` 守门（947-965 行）只拦"无 documentId"的事件，带 documentId 的事件所有 adapter 都放行；
    5. `ensureDocumentId`（1021 行）：目标块尚未绑定 documentId 时，会把**事件携带的 documentId**（可能是别的会话的文档）写进块的 toolOutput。
  - 触发路径：会话 A 制卡运行中 → 用户切到会话 B 也发起制卡 → B 的块在 `chatanki_run` 解析资源期间尚未绑定 documentId → A 的 NewCard/进度事件广播到 B 的 adapter → `findBlockByDocumentId(docA)` 落空 → 回退到 B 的 running 块 → A 的卡片混入 B 的预览，且 B 块被 `ensureDocumentId` 绑成 docA；之后 B 自己的事件（docB）反而匹配不上，继续走回退 → 两个文档的卡挤在同一个块里，进度互相覆盖。
  - 影响：双会话并发制卡（完全合法的用法，后端调度天然支持并行）下前端预览数据交叉污染；块绑错 documentId 后，块上的导出/同步/取消按钮全部操作**错误的文档**。
  - 建议：事件回退路由仅允许"无 documentId 的早期事件"使用；带 documentId 的事件找不到块就丢弃（与注释对齐）；或后端 emit 时带 session_id，adapter 按 session 过滤。
  - 验证：两个会话各自发起制卡（资源解析期较长的 PDF 在后），观察后发会话块内是否出现先发会话的卡片。

- [🟡 F2] 僵尸 running 块会永久阻止会话删除：watchdog 修复只写内存，删除检查却查数据库
  - 证据链：
    1. 软删/硬删会话都先查 `session_has_running_anki_blocks`（`src-tauri/src/chat_v2/handlers/manage_session.rs:51-71`，纯查 `chat_v2_blocks.status IN ('pending','running')`，无时间界限），命中即拒绝："Cannot delete session while ChatAnki generation is still running..."（514、608 行）；
    2. 应用崩溃/强退后块可停留 running，DB 无启动修复（chat_v2 侧未发现把 stale running 块标记为 error/interrupted 的恢复逻辑；anki 任务侧的 `recover_stuck_document_tasks` 只修 document_tasks 表）；
    3. 前端 zombie watchdog（`ankiCardsBlock.tsx:1020-1086`）能在 5 分钟无更新后把块标记为 error，但它调用的 `setBlockError` 只更新 Zustand 内存（`blockActions.ts:141-158`），不写 DB；autosave 由事件桥在处理流事件时调度（`eventBridge.ts` scheduleAutoSave），静止会话未必触发；watchdog 还要求该块**被渲染**（用户必须打开那个会话并滚到该消息）。
  - 影响：制卡中强退应用 → 重启 → 用户想删掉该会话 → 永远报"生成仍在运行中"，但实际上没有任何任务在跑；除非用户碰巧打开该会话、等 watchdog 触发、且 autosave 恰好把状态写回 DB。错误信息引导用户"等待完成或取消"，但无 documentId 的僵尸块连取消都无从下手。
  - 建议：启动时把 `ended_at IS NULL 且超过阈值` 的 anki_cards running 块标记为 interrupted（落库）；或删除检查放宽为"仅拦截 ChatV2State 中真实存在活跃流/活跃制卡的会话"；watchdog 标记 error 时同步调用 `chat_v2_update_block_tool_output`/状态持久化命令。
  - 验证：制卡运行中 `kill -9` 应用 → 重启 → 直接尝试删除该会话。

- [🟡 F3] 模板 sanitize 时机错位且双路径不一致：UI 入库前用正则剥 script（还有跨行失效 bug），AI 路径完全不剥
  - 证据：
    1. UI 创建/更新模板走 `TemplateManager.normalizeTemplatePayload`（`src/data/ankiTemplates.ts:246-267`）→ `sanitizeHTML/sanitizeCSS`（`src/utils/templateValidation.ts:135-172`）：正则移除 `<script>...</script>`、`on*=`、`javascript:`；
    2. 该正则 `/<script[^>]*>.*?<\/script>/gi` 无 `s` 标志，`.` 不匹配换行 → **跨行 script 标签剥除失效**（绝大多数真实模板脚本都是多行的），名义上的防线本身是漏的；
    3. AI 的 `template_create/template_update`（template_executor.rs）直接入库，无任何 sanitize；
    4. 渲染端已有真正的防线（DOMPurify + sandbox iframe + CSP，批次 4 确认）。
  - 影响：同一个产品两条创建路径产物不同 —— Anki 模板里的 `<script>` 在 Anki 桌面端是合法常用特性（社区模板大量使用），用户经 UI 导入/编辑会被（部分地、不可靠地）剥脚本，导出 APKG 后模板在 Anki 里行为残缺；而 AI 创建的模板保留脚本。更隐蔽的是交叉场景：AI 创建的带脚本模板，用户用 UI 改个名字保存 → 单行脚本被剥、多行脚本保留 —— 行为完全不可预测。
  - 建议：入库不做破坏性清洗（保留原始数据），渲染端继续依赖 DOMPurify/沙箱；若坚持入库清洗则统一两条路径并修正正则（或改用 DOMPurify）。
  - 验证：UI 导入带单行/多行 `<script>` 的模板各一个，对比 DB 中存储内容与 AI `template_create` 的结果。

- [🟡 F4] AI 模板工具与 UI 命令对"内置模板"策略相反，叠加启动同步形成三方打架
  - 证据：AI `template_delete` 禁止删除内置模板（template_executor.rs:1427-1431，提示"请先 fork"）；UI `delete_custom_template` 允许删除内置（commands.rs，见 D3）；AI `template_update` **允许**修改内置模板（仅剥离 isBuiltIn 字段本身，1055-1058 行），但启动时 `import_builtin_templates` 又会按内置版本覆盖用户/AI 的修改并复活已删内置（D3）。
  - 影响：用户通过 AI 删内置被拒（"不能删除内置模板"），转到模板库 UI 却一键删除成功 —— 同一产品两套规则；AI 帮用户改完内置模板，下次升级静默回滚（D3 的 AI 路径变体）。
  - 建议：统一策略（推荐：内置模板禁止原地改删，提供 fork；或加 user_modified 标志保护）。AI 与 UI 必须同一套规则。

- [🟢 F5] 会话删除后 Anki 文档"孤儿化"：成果保留但 AI 永远失去管理权
  - 证据：会话硬删除只级联 chat_v2 库（messages/blocks/session_state）并递减 VFS 引用（manage_session.rs:626-630），mistakes 库的 anki_documents/document_tasks/anki_cards 原样保留；而这些文档的 ownership 永久绑定已删除的 session_id（verify_document_ownership），任何新会话的 AI 都无法 status/export/sync/control 它们（C4 的跨会话拒绝）。
  - 影响：卡片成果保留（合理、可辩护），但任务台里这些文档失去"回到对话"路径，AI 入口永久关闭，只能靠任务台 UI 管理；用户没有任何提示说明这种状态转变。
  - 建议：删除会话时提示"关联的 N 个制卡文档将转为仅任务台管理"；或 ownership 校验对"源会话已删除"的文档放行至任意会话。

- [🟢 F6] `chatanki_wait` 在任务暂停时立即返回 paused 并结束 AI 回合：用户恢复生成后没有任何 AI 跟进，块靠全局事件桥更新但对话里再无总结（B4 的补充）；wait 轮询有取消检查、900ms 间隔、30 分钟默认/60 分钟上限超时，设计本身合理。

**批次 6 正面确认（设计良好，无需修改）**：
- 资源引用预算治理完善：文本 10MB 预算截断（`push_with_budget` 按字符边界安全截断）+ VLM 图片 6/12 张上限，两者都生成带 i18n 键的结构化 warnings（imageTruncated/textTruncated）且 UI 真实渲染（ankiCardsBlock.tsx:1285）、中文文案带补救建议（"建议拆分文档分批制卡"）。
- 后端 14 个 `blocks.ankiCards.errors.*` 错误键在 zh-CN 全部有翻译，无缺键。
- 路由降级链完备：SimpleText 空文本 → 自动转 VlmFull 取图；VlmLight/VlmFull 无图 → 回落 SimpleText，每次降级都 emit 进度消息。
- 会话删除对活跃流（has_active_stream）与运行中制卡块都有防护意识（仅僵尸态会反噬，见 F2）；`chatanki_wait` 对 documentId 有 ownership 预检。
- `extract_text_from_refs` 优先用 `files.extracted_text`，缺失时回退 blob 解析 —— 双层兜底。

**批次 5 正面确认（设计良好，无需修改）**：
- 去重索引按 `(source_type, source_id, 内容键)` 文档级隔离（V20260209），`insert_anki_card` 写入时回填 source 字段（database/mod.rs:4043-4084）—— 跨文档/跨会话重复制卡不受历史卡阻断，此前担心的"全局去重误杀"不存在。
- 多模板 template_id 防呆三重奏：提示词白名单 + 名称→ID 映射 + `resolve_template_id_candidate` 规范化解析（含完整单测），降低模型幻觉 ID 的概率。
- 调度并发度 5（buffer_unordered）+ 暂停检查 + 输入验证（10MB 上限、路径穿越、文件名长度）齐备；`chat_v2_update_block_tool_output` 的 camelCase 契约核对无误。
- SSE 解析走 ProviderAdapter 统一兼容 OpenAI/Gemini/Claude 流格式，并有行缓冲器处理跨 chunk 断行。

**批次 4 正面确认（设计良好，无需修改）**：
- 渲染安全扎实：模板/卡片 HTML 经 DOMPurify（FORBID script/iframe/object/form/base + 全量 on* 属性默认剥离），再进 `sandbox` iframe（template-safe 仅 allow-scripts、无 same-origin，无法触达 Tauri API），双层 CSP `connect-src 'none'`；CSS 清洗拦截 @import/expression/javascript:/url() 非 data:image（htmlSandboxPolicy.ts）。XSS 风险可控。
- 字段大小写兼容已在两个导出终端落实：APKG `insert_note` 用 `to_lowercase + 原名 fallback`（apkg_exporter_service.rs:1172-1190），AnkiConnect `build_fields_with_model_names` 用 lower + normalize_key 双映射（anki_connect_service.rs:76-154）→ 批次 2 的 B9 在导出侧实际已缓解，可降级为"渲染/编辑侧一致性问题"。
- 块内导出（exportCardsAsApkg）走 dialogSave 用户自选路径，前端过滤 is_error_card 后后端再过滤一次（cmd/anki_connect.rs:673），双保险且映射字段完整（含 template_id/extra_fields）。
- `convert_backend_card` 输出 snake_case 与前端块/导出/同步的读取键一致（抽查核验通过）。
- 模板更新有乐观锁（expected_version → optimistic_lock_failed → "模板已被更新，请刷新后重试"），多端并发编辑模板不会互相覆盖。
- `export_multi_template_apkg` 支持单包多 model、媒体去重打包、Cloze model_type 识别、模板字段缺失时按 extra_fields keys 动态补列。

## 4. 真实用户路径模拟与心智违背汇总

> 按"一个真实用户从第一次制卡到长期使用"的时间线串联全部发现。

### 路径 1：第一次制卡（粘贴 120 条名词解释，说"全部做成卡片"）
1. AI 被 schema 强制填 maxCards（估 60）→ 后端 glossary"按条目数生成"分支永远不可达【C1】
2. 词汇表模式输出上限固定 2400 token + 输入分段被钳到 1200 token【D7】→ 分段多、易截断
3. 达到 60 张 → 运行中任务被取消、超额卡被静默删除、块和 AI 都说"已取消"【C1】
4. 用户困惑："为什么只有一半？为什么说取消了？我没取消啊。"——首次体验即三重心智违背。

### 路径 2：生成过程中等待与干预
- 块内进度只有 messageKey 文案，任务级失败原因不进 UI【B3】；
- 用户点"暂停"→ 实为硬取消丢缓冲【B4】；DB 里 Pending 在任务台显示"进行中"【B4/A5】；
- 慢模型 30 秒无输出 → Truncated 假失败【B2】；LLM 结尾客套话 → 错误卡 + 自动修复任务连锁【B1/B7】；
- 超 30 分钟 → 全部 Cancelled + 块 ERROR，无恢复入口【C6】。

### 路径 3：卡片清理与导出
- 在聊天块里删掉 10 张废卡、改好 5 张 → 只改了块副本；"保存到库"走 INSERT OR IGNORE 假成功【A3/A4】；
- 去任务台导出 → selectTaskExportCards 优先用聊天块陈旧副本【A9】；展开会话看到的卡片列表可能是缓存【A8】；
- 导出 APKG（块内）体验正常（dialogSave + 多模板）✓；AI 导出则固定写 Downloads 且同名覆盖【D12】。

### 路径 4：同步到 Anki
- 第一次同步：模板卡全部失败（本机无对应 model，系统从不 createModel）【D1】；
- 文案说"可能是重复卡片或字段/模板不匹配"——用户检查半天字段；
- 第二次同步（部分成功后重试）：已入库的卡全部 null →"同步失败"，实际全在 Anki 里【D1】;
- AI 帮忙 sync 成功后块上仍显示未同步 → 用户再点一次 → 又一轮重复报错【C5】。

### 路径 5：模板深度使用
- 改内置模板的提示词/CSS → 某次升级后被静默还原【D3】；删除不想要的内置模板 → 重启复活【D3】；
- 自建模板写 overflow:hidden → 每次启动被偷偷改成 visible（还时灵时不灵）【D4】；
- 覆盖导入一个有问题的模板文件 → 旧模板直接丢失【D2】；即便成功，旧卡片样式全部退化 Basic【D2/D5】。

### 路径 6：跨会话/重启后回访
- 换个会话说"继续昨天那个制卡"→ not_found + shouldRetry → AI 重新发起 → 重复卡片【C4】;
- 重启后任务台里"进行中"的任务永远进行中（无调度器接管 Pending）【A5】；
- "恢复卡住任务"按 RFC3339 vs datetime() 字符串比较恒假，恢复不了【A15】;
- 占位失败任务（空 content_segment）被当成正常任务重试 → 空 prompt 制卡【C7】。

### 路径 7：多会话并行制卡（重度用户）
- 会话 A 跑长 PDF 制卡，切到会话 B 再开一单 → A 的卡片实时混进 B 的预览块，B 块被错绑到 A 的文档【F1】；
- 之后在 B 块上点导出/取消 → 操作的全是 A 的文档【F1】；
- 制卡中途应用崩溃 → 重启后想删掉那个会话 → 永远报"生成仍在运行中"，但其实什么都没在跑【F2】；
- 删除（另一个已完成的）会话成功 → 任务台里它的制卡文档变成"孤儿"：AI 再也无法 status/export/sync，只剩任务台 UI 可用，且无任何提示【F5】。

### 路径 8：用 AI 管理模板（进阶用户）
- 让 AI 删一个不喜欢的内置模板 → 被拒"不能删除内置模板"；自己打开模板库 UI → 一键删除成功【F4】；
- 让 AI 改内置模板提示词 → 成功；下次升级 → 静默回滚【F4/D3】；
- AI 创建的模板带多行交互脚本（合法 Anki 特性）→ 正常入库；用 UI 改个名字保存 → 脚本被正则剥除（而且只剥得掉单行的）【F3】。

### 心智违背 Top 6（按伤害排序）
1. **成功被报告为失败/取消**：C1（限额=取消）、D1（重复=失败）、B2（慢=截断）。
2. **静默数据丢失/改写**：C1（删超额卡）、D2（覆盖导入丢模板）、D3（升级覆盖编辑）、D4（改 CSS）、F3（剥模板脚本）、A4（编辑被忽略）。
3. **所见非所得**：A8/A9（任务台 vs 块副本）、C5（同步状态不更新）、F1（别的会话的卡出现在我的块里）、块编辑不回写库。
4. **死路状态**：B6/C6（Cancelled 不可重试）、A5（Pending 无人调度）、C7（占位任务）、F2（僵尸块锁死会话删除）。
5. **同词不同义**：取消（chat 保留卡 vs 制卡台删全部）、暂停（实为取消）、模板"可编辑可删除"（实为临时）。
6. **AI 与 UI 两套规则**：F4（内置模板 AI 禁删/UI 允删）、F3（AI 不清洗/UI 清洗）、E2（AI 读库/UI 读块）。

## 5. 验证与测试建议

### 5.1 必补的自动化测试（按 ROI 排序）
1. **IPC 契约测试**：遍历前端所有 `invoke('...')` 调用与 Rust `#[tauri::command]` 签名做参数名 camel/snake 对账（可静态扫描），覆盖 A1/A2 类问题，防回归。
2. **save_anki_cards 语义测试**：重复内容/编辑成重复/部分冲突 → 断言返回 saved/skipped 明细而非 OK（A3/A4/A11/A12）。
3. **限额收尾语义测试**：maxCards < 预期生成数 → 断言终态不是 cancelled、超额删除有 warning（C1）。
4. **时间戳恢复测试**：插入 RFC3339 updated_at 的 Processing 任务 → recover → 断言被重置（A15）。
5. **AnkiConnect 模拟器测试**：mock 8765 端口，覆盖 模型缺失/重复笔记/部分成功 三态的用户文案（D1）。
6. **模板导入回滚测试**：覆盖导入校验失败 → 断言旧模板仍在（D2）；内置模板用户编辑 + 版本同步 → 断言不被覆盖（D3，修复后）。
7. **JS 正则状态 bug 单测**：两个含 overflow:hidden 的模板连续 test → 第二个不应漏判（D4，修复时顺带删 g 标志）。
8. **分段属性测试（proptest）**：任意 unicode 文本 × 任意 max_tokens → 分段拼回去无内容丢失、无 panic（segment_with_overlap 裁剪分支多，目前零测试）。
9. **事件路由测试**：模拟两个 store 并发持有 running anki 块，向双方广播带不同 documentId 的事件 → 断言各自只消费自己的（F1）。
10. **僵尸块恢复测试**：DB 中预置 running 状态 anki_cards 块（无活跃流）→ 启动修复后断言可删除会话（F2，修复后）。

### 5.2 建议的手工验收脚本（tauri-lab 实测路径）
- 120 条词汇表全覆盖制卡（观察终态文案/卡数/AI 总结）
- 同一批卡连点两次"同步到 Anki"（观察第二次报告）
- 改内置模板 CSS → 重启 → 检查是否保留
- 删除模板后查看历史卡片预览与导出
- 聊天块删 5 张卡 → 任务台导出 → 数一致性
- 断网/杀 LLM 进程后看块状态与任务台状态是否一致、能否恢复

### 5.3 修复优先级建议（如果只做六件事）
1. E1：流收尾先解析残余缓冲再降级错误卡（一行逻辑消灭大半"莫名错误卡"+修复任务连锁）
2. C1+E3+E4：limit_reached 独立终态 + 不删卡只截断 + maxCards 上限显式化 + "恰好 N 张"改"至多 N 张"
3. E2：块编辑/删除回写 DB，消灭双数据源（用户删的卡不再复活）
4. D1：同步前 createModel + canAddNotes 预检 + 三态文案
5. A1/A2 + 契约扫描：把 IPC 断裂一次性清零；A3/A4/A12 同根修复（保存返回明细）
6. D3/D4：停止启动期对用户模板的静默改写/覆盖/复活

## 6. 结论

整体架构方向正确（chatanki 后端原生管线、预分配 documentId、多模板 APKG、渲染沙箱都是 SOTA 水准的设计），但**终端环节的诚实性**（状态语义、失败原因、幂等反馈）与**用户数据的不可侵犯性**（模板/卡片的静默改写删除）存在系统性欠账；多会话并发下的**事件路由正确性**（F1）与崩溃后的**状态自愈能力**（F2）也未达产品级；另有三层死代码使双链路语义冲突随时可能复燃。按第 5.3 节六件事修复后，该功能可达到"用户可信赖"的水位。

> 本文档共记录：🔴 12 项、🟡 32 项、🟢 20 项，正面确认 20 项。覆盖前端入口/状态机/事件流/多会话事件路由、后端命令/服务/分段/流式解析内核/提示词协议、数据库/迁移/去重索引、模板生命周期（UI+AI 双路径）、APKG/AnkiConnect 导出、渲染安全、Chat 工具链与 AI 可用性、双数据源对账、会话生命周期与资源孤儿化。

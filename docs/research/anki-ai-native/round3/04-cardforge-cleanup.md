# Round 3 #4 — CardForge 2.0 死链路清理 + 划词制卡迁向生产路径

> 状态：已完成（2026-08-24）
> 分支：`cursor/anki-ai-native-research-bfca`
> 前置事实核对：`src-tauri/src/chat_v2/pipeline.rs` 的
> `create_executor_registry_with_workspace` 确认**不注册** `AnkiToolExecutor`
> （仅注册 `ChatAnkiToolExecutor`），即旧 CardForge 工具桥在生产中永远不可达。

## 一、删了什么

### 1. Chat V2 工具桥（前后端两侧，整条死链路）

| 位置 | 删除内容 | 理由 |
| --- | --- | --- |
| `src-tauri/src/chat_v2/tools/anki_executor.rs` | **整个文件删除**（`AnkiToolExecutor`：`anki_query_progress` 后端查询 + `anki_generate_cards` 等 5 个工具经 `anki_tool_call` 事件桥接前端） | pipeline 从不注册；全仓库唯一引用是 `mod.rs` 的 `pub use`（注释自述"仅保留类型"）。前端监听删除后该桥即使被注册也会永久超时 |
| `src-tauri/src/chat_v2/tools/mod.rs` | `pub mod anki_executor` + `pub use anki_executor::AnkiToolExecutor` 及模块文档中的对应条目；顺带清掉 `ask_user_executor` 行尾误留的"桥接到前端 CardAgent"注释 | 随文件删除 |
| `src-tauri/src/chat_v2/headless.rs` | 仅改注释：`anki_generate_cards` 拦截项标注"执行器与前端监听均已删除，防御性保留拦截" | 拦截白名单本身保留（防历史会话/伪造调用挂起） |
| `CardAgent.ts` | `setupToolCallListener` / `handleToolCall` / `ChatV2ToolCallPayload` / `toolCallUnlistenFn` / `getWindowLabel`（含 `cachedWindowLabel`）/ `anki_tool_result:*` 回发 | 监听的 `anki_tool_call` 事件生产中永不发出；保留监听器反而给伪造事件留攻击面 |
| `cardforge/types/index.ts` | `CardForgeEventType` 中的 `tool:result` / `tool:error` | 只有 handleToolCall 发射 |

**测试证明**（`tests/vitest/anki/cardforge/CardAgent.test.ts`）：新增用例
`only listens to anki_generation_event — the anki_tool_call bridge is gone`，
断言 `CardAgent` 初始化后按事件名去重的 `listen` 调用集合恰为
`['anki_generation_event']`，永不监听 `anki_tool_call`。

### 2. ChatV2AnkiAdapter / useChatV2Anki（死适配器）

`src/components/anki/cardforge/adapters/`（`chatV2Adapter.ts` + `index.ts`）
**整目录删除**。全 `src` 中该适配器唯一消费者是划词制卡
`selectionCardGeneration.ts`（本轮已迁走，见下）；`useChatV2Anki` React hook
从未被任何组件引用。文件头"为 Chat V2 的 ankiCardsBlock 提供桥接"的说法
早已失实——`ankiCardsBlock` 实际走 `features/chat/anki` 的
`exportCardsAsApkg`/`saveCardsToLibrary`（直连后端命令）。

### 3. SegmentEngine 前端 LLM 定界（死代码 + 谎言注释）

删除 `detectBoundaries` / `detectSingleBoundary` / `buildBoundaryPrompt` /
`parseBoundaryResponse` / `BoundaryDetectionResponse` 及 `invoke` 依赖；
`SegmentOptions.enableLLMBoundary` 一并移除。
事实：该引擎唯一调用方是 `CardAgent.analyzeContent`，且显式传
`enableLLMBoundary: false`——前端 LLM 定界从未在任何生产路径启用；
真正的 LLM 语义定界发生在**后端**生成管线
（`streaming_anki_service`，经 `options.enable_llm_boundary_detection` 开启）。
文件头"阶段二：LLM 定界（可选，当文档较大时启用）"的注释已按事实改写为
"分段估算引擎（纯数学计算，无 LLM 调用）"。
配套删除 types 中的 `BoundaryDetectionRequest` / `BoundaryDetectionResult`，
`SegmentConfig` 收敛为 `{ chunkSize, minSegmentSize }`
（`boundaryContext` / `boundaryModel` 只服务于已删代码）。

### 4. PromptKit 死 prompt

| Prompt | 处置 | 理由 |
| --- | --- | --- |
| `buildBoundaryPrompt` | 删除 | 唯一"消费者"是 SegmentEngine 内部的**另一份私有拷贝**（也已删）；导出版从未被调用 |
| `buildCardGenerationUserPrompt` | 删除 | user 消息由后端注入学习材料，前端从不组装；自述"仅用于前端直连 LLM 场景"的场景不存在 |
| `buildErrorRepairPrompt` | 删除 | 修复流程从未接线 |
| `buildQualityAssessmentPrompt` | 删除 | 质量评估流程从未接线 |
| `buildCardGenerationSystemPrompt` | **保留** | 经 `options.custom_anki_prompt` 送入后端 system 消息（generateCards / startGeneration 共用），END-only 协议（`CARD_JSON_END` 唯一分隔符，无 `{{DOCUMENT_CONTENT}}` 占位符——#2 的修复已对齐） |
| `buildContentAnalysisPrompt` | **保留** | `CardAgent.analyzeContent` 的 LLM 内容预分析 |

`prompts.test.ts` 新增契约用例：`PromptKit` 的键集合恰为
`{ CARD_JSON_END, buildCardGenerationSystemPrompt, buildContentAnalysisPrompt }`，
防止死 prompt 回潮。

### 5. exportNormalize（保留 + 接入导出 UI）

- `normalizeToolExportCards` 删除：它只服务于已删的 `handleToolCall`
  （归一 `anki_export_cards` 工具载荷）。
- `validateCardsForExport` / `filterExportableCards` **保留**，并新接入真实
  导出 UI 链路：`src/features/chat/anki/index.tsx` 的 `exportCardsAsApkg`
  （被聊天块 `ankiCardsBlock` 与任务台 `SessionRow` 引用）导出前统一走该校验，
  error 级问题卡（错误卡/全空卡）排除出导出集合，替换原先只认
  `is_error_card` 的 ad-hoc 过滤（顺带修正了该函数"使用 ChatV2AnkiAdapter
  导出"的谎言注释——它实际直连 `export_multi_template_apkg`）。
- `exportNormalize.test.ts` 重写：覆盖 error/warning 分级、camelCase 与
  snake_case 双形态、必填字段校验、`filterExportableCards` 只剔 error 级。

## 二、划词制卡现在走哪条路径

```
SelectionToolbar (MessageItem.handleSelectionMakeCards)
  → generateCardsFromSelection (selectionCardGeneration.ts)
    → cardAgent.startGeneration          ← 新增的非阻塞入口
      → tauri command start_enhanced_document_processing
        → EnhancedAnkiService::start_document_processing   ← 与 ChatAnki 同一入口
  → set_document_session_source（documentId ↔ 聊天会话回链）
  → 成功通知 + "打开任务台" 动作；进度/结果由任务台（anki-tasks）跟踪
```

- 后端没有 chatanki 专用 tauri command（`ChatAnkiToolExecutor` 在工具循环内
  直接调用 `EnhancedAnkiService::start_document_processing_with_id`），因此
  `start_enhanced_document_processing` 就是前端可用的**等价后端入口**：
  同一个服务、同一个方法（仅差预分配 document_id）。
- 旧路径 `ChatV2AnkiAdapter.generateCards` 会在前端阻塞收集全部卡片
  （事件收集器 + 5 分钟空闲超时 + DB 兜底），收完才弹"已开始制卡"——
  语义失实且长文档期间 UI 无着落。新路径启动即返回 documentId，
  通知语义与 chatanki_start 一致（启动确认，非完成确认）。
- `startGeneration` 与 `generateCards` 共用同一个私有装配器
  `buildBackendGenerationOptions`（模板描述/字段提取规则/
  `custom_anki_prompt`=END-only system prompt），两条路径的 Prompt 契约
  不会分叉；且 `startGeneration` 不依赖 CardAgent 的事件监听初始化
  （有测试证明监听失败时仍可直启）。

## 三、剩余技术债

1. **CardAgent 半退役**：`generateCards`（阻塞收集式）、`exportCards`、
   `controlTask`、`listTemplates`、`analyzeContent` 在删除适配器后已无 UI
   生产调用方，仅剩 `@/components/anki` 的编程导出与 vitest 覆盖。
   保留原因：任务书允许暂留 `generateCards`（Prompt 已对齐 END-only），
   且 `analyzeContent`→`buildContentAnalysisPrompt`、
   `exportCards`→exportNormalize 校验仍是唯一成型的实现。若下一轮确认
   无人复用，可将 CardAgent 收敛为 `startGeneration` + 模板装配器。
2. **划词制卡缺少 anki_cards 聊天块**：迁移后卡片只在任务台可见，不像
   ChatAnki 在聊天流内渲染卡片块。若要对齐体验，需要一个后端 headless
   chatanki_start 入口（复用其块创建/快照逻辑），本轮禁改
   `chatanki_executor.rs`，未做。
3. **`analyzeContent` 复用 `call_llm_for_boundary` 命令**作为通用 LLM 通道，
   命令名与实际用途（内容分析）不符；后端命令归属 #2/#8 的文件，未动。
4. **`chat_v2_anki_cards_result` 后端命令**的前端唯一调用方（handleToolCall）
   已删，该命令疑似可退役；属后端 handler 文件（非本轮文件），仅记录。
5. **既有失败与本轮无关**：`styleDebugComponentInventoryContract.test.ts`
   （扫描指纹过期）与 `AnkiCardsBlock.test.tsx` 的
   `progress.metrics.cardsValue` i18n 断言在本轮改动前即失败（已在
   HEAD 上用 stash 验证），未纳入本轮修复范围。
6. **headless 拦截表仍含 `anki_generate_cards`**：防御性保留（防历史会话/
   外部注入的同名调用挂起），如需彻底移除应连同其契约测试一起清理。

## 四、验证

- `vitest`：`tests/vitest/anki/**`（cardforge 4 个套件 + normalizeTaskCardsForExport）、
  `selectionCardGeneration.test.ts`、`src/features/anki-tasks` 全绿（58 tests）。
- `tsc --noEmit`：仅剩 3 个与本轮无关的既有错误（缺少生成文件 `src/version.ts`，
  由 `npm run version:generate` 产生）。
- `cargo check --lib`：在共享工作区执行时，唯一编译错误位于并行子代理
  正在编辑的未提交文件 `streaming_anki_service.rs:2237`（本轮禁改文件），
  与本次删除无关；模块解析阶段通过——`anki_executor` 删除后全仓库无
  悬挂引用（grep 亦确认 `AnkiToolExecutor` 仅剩注释提及），无任何
  anki_executor 相关错误/警告。

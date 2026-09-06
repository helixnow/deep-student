# Canvas 类模式吸收方案（P0–P3）

> 调研来源：Cursor（Canvases / Design Mode / Agents Window，2025-09 → 2026-08 changelog 与官方文档）、
> WorkBuddy（设计创意 × Ardot 画布 / 人机双写 / 右侧边栏，官方文档与 changelog）。
> 本方案基于对 deep-student 现状的三路代码调研（2026-09-06），所有引用文件路径均已核实。

## 0. 总原则

两家的 "canvas" 拆成三个互相独立的 pattern，分别吸收、分别落地：

| Pattern | 对标 | 我们的地基 | 缺口 |
|---|---|---|---|
| B. 选区即上下文 | Cursor Design Mode / WorkBuddy 选区精调 | `SelectionToolbar` 共享浮动条（PDF+聊天消息双宿主已验证）、`addContextRef`/`pendingContextRefs` 管线、徽章体系 | 选区文本本身不进 prompt（只纯文本预填）；导图/笔记无入口 |
| A. 产物一等公民 | Cursor Canvases / WorkBuddy 产物区 | generative-ui（18 种 block + intent 落库，**重开不重跑已成立**）、UnifiedAppPanel、AgentTaskPanel 的 extractArtifacts | 无会话级产物索引；生成 prompt/数据源未快照；无产物列表 UI |
| C. 人机同区可核对 | WorkBuddy 人机双写 | notes AIDiffPanel 全链路、mindmap ACR ledger + 版本表、anki `_original_generation`/`_content_provenance`、generative action undo 基础设施 | 各面零散、无聚合变更视图；生产 action 无一接 undo |

**克制清单（明确不做）**：不做通用无限画布（workbench 已是空间桌面）；不做像素级设计编辑器（无 Ardot 类资产）；
不做 fiber 树/DOM 逆向（内容全自渲染，引用 id 即精确坐标）；不做分享/协作快照（单机无团队场景）；不做语音；
不为 registry 新建存储层（blocks 表已是 SSOT）；不为 skill 模板另起注册机制（复用 SKILL.md manifest）。

---

## P0 选区即上下文（Design Mode 学习版）

### 目标

在 PDF / 聊天消息 / 思维导图 / 笔记四个面，选中内容 → 浮动条点「引用到聊天」→ 选区作为**结构化 contextRef**
（含文本快照 + 来源定位）注入 pendingContextRefs，发送时随 `_meta.contextSnapshot` 进 prompt。
替代现在的纯文本预填（`PREFILL_CHAT_INPUT` / `CHAT_V2_SET_INPUT`）。

### 现状关键事实

- `SelectionToolbar`（`src/shared/selection/SelectionToolbar.tsx`）已有复制/解释/翻译/存笔记/制卡/添加到聊天六个动作，
  宿主接入层：PDF = `PdfSelectionActions.tsx`，聊天消息 = `MessageItem.tsx` L256/L1479。
- 现有"添加到聊天"是纯文本预填；`useReferenceToChat` 注入的是**整份资源** ref，`selectedText`/`locator`
  只落在 `Resource.metadata`，**无任何 formatToBlocks 消费**——选区文本不进 prompt。
- 后端 `VfsResourceType` 是封闭 9 值枚举（`src-tauri/src/vfs/types.rs` L86-105），新增类型要改 Rust；
  但 `retrieval` 是虚拟快照类型（无领域表、无工具绑定），`formatToBlocks` 直接读 `resource.data`
  （范例：`context/definitions/retrieval.ts`）。
- 导图：节点选中态在 `mindmapStore.selection`，全 feature 内**没有** referenceToChat/addContextRef 调用。
- 笔记：Crepe/milkdown，无任何选区浮动条；ProseMirror `state.selection` 可用。

### 设计

**1. 新增前端 context 类型 `selection`（零 Rust 改动，快照模式）**

- 新文件 `src/features/chat/context/definitions/selection.ts`，照抄 `retrieval.ts` 模式：
  - `typeId: 'selection'`，`xmlTag: '<selection>'`，priority 介于 note(10) 与 textbook(25) 之间；
  - `formatToBlocks(resource)` 直接读 `resource.data` 格式化为：
    `<selection source="《机器学习系统》第 47 页" source-id="tb_xxx" locator="page:47">选中文本</selection>`——
    source-id 暴露给模型是为了让它可用 `builtin-resource_read`（支持 page_start/page_end）回读上下文；
    但按页精确回读依赖该 PDF 已有 `ocr_pages_json`（无 OCR 页数据时回退全量内容），
    systemPromptHint 不得承诺"可精确回读任意页"；
  - 在 `definitions/index.ts` 注册（**三处结构都要加**：`builtInDefinitions` 数组、`definitionMap`、
    `builtInTypeIds`——漏注册不崩溃，但 `registry.formatResource` 兜底会把 `resource.data` 裸 JSON
    塞进 `[Unknown type: selection]` 块污染 prompt，需单测覆盖注册完整性）。
- 存储：复用 `retrieval` 类型 `resourceStoreApi.createOrReuse({ type: 'retrieval', data, sourceId, metadata })`。
  `data` JSON 形状（新类型，放 `src/features/chat/context/selectionRef.ts`）：

```ts
interface SelectionRefData {
  text: string;                       // 选区文本（导图面为节点+子树大纲文本）
  source: {
    kind: 'pdf' | 'message' | 'mindmap' | 'note';
    sourceId?: string;                // 源资源 id（pdf/note/mindmap），用于跳转回链
    locator?: string;                 // 'page:N' / 'chapter:N' / 导图节点 id 路径
    title?: string;                   // 来源显示名
    messageId?: string;               // kind=message 时
  };
}
```

**locator 必须放在 `data` 内（而非仅 metadata）**：`createOrReuse` 按 data hash 去重，
locator 不进 hash 会导致"同一文本、不同位置"的选区被错误合并。

**存储的 24h 清扫注意**：启动时 `cleanup_unreferenced_retrievals` 会删除
`type='retrieval' AND ref_count=0 AND updated_at < now-24h` 的行（lib.rs L3206-3227）。
已发送消息引用的快照安全（ref_count 对称）；但"加了引用又放弃草稿"的快照 24h 后被回收——
语义可接受，测试时别踩"昨天加的引用今天 404"。

- `isVfsRefType` 守卫会自动跳过它（`contextHelper.ts` L1018），发送链路
  `buildSendContextRefsWithPaths` → `_meta.contextSnapshot` → `ContextRefsDisplay` 全部免改自动生效。
- `ContextRefChips.tsx` 补 `selection` 分支（`getTypeIcon`/`getTypeLabelKey`/`getTypeColorClass`）。
  **不创建伪附件**（`chat_v2_stage_context_attachments` 只认 file/image）。

**2. 注入动作 `selectionToChat.ts`（新文件，仿 `src/features/learning-hub/useReferenceToChat.ts` L228-376 骨架）**

```
ensureActiveChatSession()
→ createOrReuse({ type:'retrieval', data: JSON.stringify(SelectionRefData), sourceId, metadata:{ title, locator, originKind } })
→ store.getState().addContextRef({ resourceId, hash, typeId:'selection', displayName: 来源+locator })
```

`addContextRef` 按 resourceId 去重（同一文本同一来源天然幂等）；非 sticky 发送后自动清，语义正确。
直接拿 sessionManager，两壳（经典/workbench）通用——不走事件通道（WorkbenchEventBridge 只桥事件不桥 store）。
与 referenceToChat 的有意差异：不做 `getResourceRefsV2` 后端解析、不 addAttachment、不开附件面板——
注意用户习惯差异（现有"引用到对话"会出附件 chip 并弹右侧面板，选区引用只出 ContextRefChip）。

**3. 四个面接入**

| 面 | 接入点 | 改动 |
|---|---|---|
| PDF | `PdfSelectionActions.tsx` | 「添加到聊天」动作从纯文本预填改为 `selectionToChat({ text, source:{kind:'pdf', sourceId, locator:'page:'+resolveSelectionPage(), title } })`；保留纯文本预填为长按/次级动作 |
| 聊天消息 | `MessageItem.tsx` SelectionToolbar 回调 | `onAddToChat` 改为 `selectionToChat({ text, source:{kind:'message', messageId, title:会话标题 } })` |
| 思维导图 | `MindMapFormatBar`（选中节点时内联展开处，MindMapContentView.tsx L1370） | 加「引用到聊天」按钮：payload = 选中节点 text/note + 子树大纲（序列化缩进文本），`source:{kind:'mindmap', sourceId: mm_xxx, locator: 节点id, title:导图标题}`。**不是文本选区**，接 store 的 `selection`。**注意挂载条件含 `!isCoarsePointer`：触屏永不渲染，移动端导图无入口——桌面先行，验收标准写明** |
| 笔记 | `NotesCrepeEditor.tsx` | 挂共享 `SelectionToolbar`（`useTextSelection` 对 ProseMirror DOM 有效；如需源码级精确选区走 `editorApi`/`state.selection.textBetween`，`CrepeEditor.tsx` L1171 有先例），只启用「引用到聊天/解释/翻译」 |

`SelectionToolbar` 本体只需加一个可选动作回调（如 `onAddAsContext`），保持 `hideUnavailableActions` 语义。

**4. 回链跳转（扩展现有事件，必需而非可选）**

`context-ref:preview` 的 detail 目前只传 `resourceId/typeId`；扩可选 `sourceId/locator`。
**这是必需的**：现有消费侧（`useChatPageEvents.ts` L250-308 与 workbench WorkbenchEventBridge L162-190）
硬依赖 VFS sourceId——无 sourceId 直接 toast「预览失败」；kind=message 的选区没有 VFS 资源可跳，
且 `CHAT_OPEN_ATTACHMENT_PREVIEW` 通道本身不支持页码 focus。
消费侧解析后：kind=pdf 复用 `pdf-ref:open` + `pdf-ref:focus` 跳页；
kind=mindmap/note 走 `NAVIGATE_TO_VIEW` openResource；kind=message 跳回会话消息定位（或 MVP 不支持跳转，仅展示快照文本）。

### 改动文件清单

| 文件 | 改动 |
|---|---|
| `context/definitions/selection.ts` | 新增 |
| `context/definitions/index.ts` | 注册一行 |
| `context/selectionRef.ts` | 新增（类型 + selectionToChat） |
| `shared/selection/SelectionToolbar.tsx` | 加可选动作 |
| `features/pdf/components/PdfSelectionActions.tsx` | 接新动作 |
| `features/chat/components/MessageItem.tsx` | onAddToChat 改结构化注入 |
| `features/mindmap/components/mindmap/MindMapFormatBar.tsx`（或工具栏） | 加按钮 + 子树序列化 |
| `features/notes/NotesCrepeEditor.tsx` | 挂 SelectionToolbar |
| `components/ContextRefChips.tsx`（input-bar 下） | selection 分支 |
| `utils/contextRefPreview.ts` + `useChatPageEvents.ts` | detail 扩 sourceId/locator + 跳转 |
| `src/demo/mockIpc.ts` | demo 验证时补对应 mock（现有 vfs_* mock 块 L187-258 参照） |

### 验证

- 单测：selection definition 的 formatToBlocks；selectionToChat 的去重/无会话闭环；四个面的 locator 解析。
- demo 壳：fixtures 加一个"PDF 划线引用提问"剧本，走真实 sendMessage 全链路验证徽章/chip/跳转。

---

## P1 产物一等公民化（Canvas 的核心：生命周期）

### 目标

generative-ui 产物（报告/看板/导图/卡片组）+ 文件/笔记类产物登记为**会话级 artifact**：
可在列表重开（不重跑）、可带新数据刷新、可跳转对应完整应用。

### 现状关键事实

- **SSOT 已在 blocks 表**：generative_ui 块由后端 `save_tool_block` 落库、restore 原样恢复
  （restoreActions.ts:159）——"重开不重跑"天然成立。**但注意落库渠道**：intent 在 **tool_input**
  （executor 的 tool_output 只有 `{status:'rendered', blockCount, researchSessionId?}`，
  generative_ui_executor.rs:442-448）；前端 onEnd 写进 store 的 `toolOutput.intent` **从不回写 DB**
  （`chat_v2_update_block_tool_output` 只有 ankiCardsBlock 在用）。因此所有"从块取 intent"的地方
  必须走 `extractGenerativeUIIntent(toolOutput, content, toolInput, blockId)` 三级回退
  （chatBlockBridge.ts:86-93），真实重载后只有 toolInput 通道有值。
  **demo 壳 playedHistory 快照的是 store 态（toolOutput 含 intent），demo 验证会掩盖这个差异——
  需补真实重启路径的测试。**
- `AgentTaskPanel` 的 `extractArtifacts(blocks)` 已是派生索引先例，但只覆盖 note/file 工具块，不含 generative_ui。
- `GenerativeUIPanel`（`generative-ui/components/GenerativeUIPanel.tsx`）是现成的独立 intent 渲染壳。
- ChatV2Page 次级面板现有三种 mode（`'sandbox'|'attachment'|'canvas'`），有成熟的切换/快照机制。
- 缺口：① 无会话级产物索引；② **生成 prompt / 数据源不在块里**（toolInput 只有 intent/noteEdit/researchSessionId）；
  ③ 无产物列表 UI。

### 设计

**1. 会话级 artifact registry = 派生索引 + 薄元数据层（不动 Rust）**

新文件 `src/features/chat/core/store/artifactRegistry.ts`：

```ts
interface ArtifactEntry {
  artifactId: string;        // = blockId（全局唯一、已持久化）
  kind: 'generative-ui' | 'anki-cards' | 'note' | 'file';
  title: string;             // intent.meta.title ?? 工具名回退
  createdAt: number;
  sourceMessageId: string;
  // 刷新用快照（登记时捕获）：
  refreshPrompt?: string;    // 触发该产物的用户消息文本
  contextRefs?: ContextRef[];// 同消息 _meta.contextSnapshot.userRefs
}
```

- **派生**：扫 `store.blocks`：`generative_ui` 块（终态）→ kind 'generative-ui'；
  `anki_cards` 块 → 'anki-cards'；note 写入/文件生成工具块（复用 AgentTaskPanel extractors 的
  NOTE_WRITE_TOOLS/文件类集合）→ 'note'/'file'。
- **登记点**：generativeUI 事件插件 onEnd（`plugins/events/generativeUI.ts`）——此处拿得到 store、
  blockId（messageId 经 `store.blocks.get(blockId)?.messageId` 派生）和终态 intent。
  **live/restore 不对称**：live 路径里 contextSnapshot 只建在**用户消息**上（messageActions.ts:214-235），
  助手消息的 _meta 要 restore 后才有（persistence.rs:1178-1182）——onEnd 时需沿 messageOrder
  **前溯到前一用户消息**取 userRefs 与 refreshPrompt。快照进内存 Map<sessionId, Map<artifactId, ArtifactEntry>>
  （仿 `generativeUIStreamRegistry` 的模块级 Map 形态，但清理钩子要自己加：同时订阅 `session-evicted`
  与 `session-destroyed`，先例 App.tsx:2521）。
- **水合**：`restoreFromBackend` 后或产物面板首次打开时懒扫 blocks 重建索引。**历史分页漏收风险**：
  restore 是分页的（prependHistoryFromBackend），懒扫只覆盖已加载页——产物在旧消息里时索引漏收，
  需在分页加载后做增量水合（prepend 后补扫新到的 blocks）。历史会话的 refreshPrompt
  从对应用户消息文本回填，contextRefs 从该消息 _meta 回填——都在已持久化数据内。
- **用户态元数据**（pin/重命名/隐藏）：存 `sessionMetadata`（经 `chat_v2_update_session_settings`，
  SessionSettings 有 metadata 字段），不存大 payload。**写入是整体替换语义**（merge_session_metadata：
  全量替换/清空/保持三态），且 metadata 里已住着 authorityMode/availableSkillsSnapshot 等键——
  必须 read-modify-write 全量对象，注意多窗口并发覆盖面。

**2. 产物列表 UI：ChatV2Page 次级面板第四种 mode `'artifacts'`**

- 复用 `DesktopSecondaryPanelMode` 现有切换/快照/动效机制。注意两处事实：该类型是
  **ChatV2Page.tsx:92 的本地类型**（不在 core/types）；现有 mode 的入口本就不在顶栏
  （sandbox 是浮动边钮 L1402-1442、canvas 由 toggleCanvasSidebar 驱动）——artifacts 入口可放顶栏，
  但互斥/快照/关闭逻辑要在 L809-935 的推导链与渲染分支里显式接线。
- 列表项：kind 图标 + 标题 + 相对时间 + （pin）；点击重开：
  - generative-ui → 面板内用 `GenerativeUIPanel intent={...}` 渲染（**不重跑**；intent 经
    `extractGenerativeUIIntent` 三级回退取，见上）。GenerativeUIPanel 本体无 store 依赖、可在聊天外渲染；
    action handlers 需调用方经 `resolveGenerativeUIChatActionHandlers` 构造（纯函数），不传则
    action-bar 按钮进入未注册安全模式（不渲染），可接受；
  - anki-cards → **直接重渲染持久化块**（AnkiCardsBlock 不依赖消息上下文，cards 已在 toolOutput
    自包含，入库后 id 已经 cardIdMappings 换成 persistedId）。"跳卡片库定位这批卡"需要给库查询新增
    documentId/ids 过滤（Rust `list_anki_agent_library_cards` + 库 UI 改动），MVP 不做。
    注意 LRU 淘汰后会话 store 销毁，面板需经 sessionManager 复活 store 且数据加载后才可交互
    （否则卡片编辑持久化等路径降级为只读）；
  - note/file → 既有通道 `DSTU_OPEN_NOTE` / `openResource` / `setOpenApp`。
- 列表项两个固定动作：
  - **刷新**：用快照的 `refreshPrompt + contextRefs` 作为新消息发送（产物更新走"新消息新块"，
    不覆盖历史——与 Cursor "rerun with fresh data" 语义一致且天然有审计轨迹）；
  - **在 X 中打开**：导图 → `NAVIGATE_TO_VIEW { view:'learning-hub', openResource:'/mm_xxx' }`
    （MindMapEmbed.handleOpen 先例）；PDF → `pdf-ref:open`；exam/essay/translation → 既有 navigate 函数。
- workbench 壳：列表点击复用 `WorkbenchEventBridge` 的 `launchResourceWindow`；generative-ui 重开
  可先在 ChatV2Page 壳落地，workbench 侧二期（content app 加 intent 渲染分支）。
- 注意 ChatV2Page 切会话强制 `setOpenApp(null)`（L184-188，**但不清 canvasSidebarOpen**）——
  artifacts 面板的选中态重置要在该处显式加，不能假设复用现有清理；
  列表内容随 store 切换自动正确（索引按 sessionId 分桶）。

**3. 与 AgentTaskPanel 的关系**

AgentTaskPanel 的 artifacts 区保留（任务执行视角）；新面板是"产物架"视角（可 pin/重开/刷新）。
两者共用同一套派生抽取函数（把 extractors.ts 的产物判定提出来共用，避免两套口径漂移）。

### 改动文件清单

| 文件 | 改动 |
|---|---|
| `core/store/artifactRegistry.ts` | 新增（派生索引 + 内存 Map + 水合） |
| `plugins/events/generativeUI.ts` | onEnd 处登记快照 |
| `core/store/restoreActions.ts` | restore 后触发水合（或面板懒扫） |
| `agent-task/extractors.ts` | 产物判定函数抽出共用 |
| `ChatV2Page.tsx` + 次级面板组件 | 第四种 mode 'artifacts' + 列表 UI |
| `ChatV2Page.tsx`（本地类型） | DesktopSecondaryPanelMode 加 'artifacts' + 推导链/渲染分支/切会话重置接线 |
| workbench `apps/content` | 二期：intent 渲染分支 |

### 验证

- 单测：registry 派生（各 kind 块 → entry）、水合（BackendBlock → 索引）、刷新动作的消息构造。
- demo 壳：套用 `playedHistory.ts` 快照夹具验证"切走再切回，产物列表与重开不重跑"；
  fixtures 加"生成周度学习看板 → 切会话 → 从产物面板重开"剧本。

---

## P2 人机同区可核对（人机双写推广）

### 目标

AI 修改**笔记 / 导图 / Anki 卡片**时：改动处高亮 + 可撤销 + 会话级改动记录可核对。
原则：**各面复用已有机制，不新造轮子**；聚合视图只做薄壳。

### 分面设计

**1. 笔记（链路已齐，补"多改动并存 + 记录"）**

- 现状：`canvas:ai-edit-request` → `useCanvasAIEditHandler` → `AIDiffPanel`（diff 确认）→
  accept 走 `replaceFullMarkdown` OCC；checkpoint **单槽、仅内存、切笔记失效**。
- 改动：
  - `AIEditCheckpoint` 单槽 → 每笔记栈（上限 5 条），checkpoint bar 支持逐条回滚——**回滚走
    `replaceFullMarkdown` OCC（expectedMarkdown=current），多轮回滚遇用户中间编辑会冲突，
    需定义冲突语义（建议：冲突时该条标记不可回滚，不强行覆盖）**；
  - accept 时把 `{noteId, diffLines, request, appliedAt}` 推入会话级 change-log store（见下"聚合视图"）。
    注意 diffLines 在 startEdit 时算好但**不在 accept 载荷里**，且等待期间用户编辑触发重算路径时
    diffLines 陈旧——accept 时需补一次 `computeDiffLines`（廉价但非零成本）；
  - **经典壳缺口**：`builtin-note_append/replace/set` 在经典壳下经后端 OCC 直写，绕过
    AIDiffPanel/checkpoint（try_frontend_delegate probe 得 disabled 后回落，canvas_executor.rs:294-300）。
    P2 笔记面 MVP 只覆盖 generative-ui `apply-note-edit` 路径（经典壳可用）与 workbench ACR 路径；
    工具直写接回建议通道是独立改动，列为一期可选项。

**2. 导图（升级现有 suggestion 屏障，不接新机制）**

- 现状：ACR 路径每 op 已记 ledger 逆操作（mindmapDriver.ts:898+，带 stableValue 冲突检测）+ TTL 高亮；
  dirty/hot + 破坏类 op 走**拒绝式** suggestionPending（无确认 UI）；后端路径自动建 `chat_edit_nodes` 版本；
  `builtin-mindmap_diff_versions` 是现成的节点级 diff 原语。
- 改动：
  - suggestionPending 从"拒绝"升级为"**暂存 ops → 预览 → 接受后 apply**"：暂存 ops 在画布上以
    幽灵态演出——**现有 markAgentEntering/Updated 是 TTL 自动消退的演出态（约 0.3–1.1s），
    幽灵态需持续到裁决，要加非 TTL 的第三标记态**；预览摘要复用 `builtin-mindmap_diff_versions`
    的输出形状（summary/changes）渲染，但该工具只 diff **已持久化版本**，暂存 ops 调不了它——
    需在前端文档副本上模拟 ops 自建 diff（或"先 apply → diff → 拒绝则 ledger 回滚"）。
    确认条复用 VersionHistoryPanel 的 VersionPreview 摘要样式（+增/−删/改 N 节点）；
    接受 → 正常 apply + save；拒绝 → 丢弃暂存。driver 改动集中在 `applyMindmap` 的屏障分支
    （`src/features/workbench/agent/drivers/mindmapDriver.ts` L1237-1249）。
  - 改动记录 = run receipt 的人读 label 列表 + versionId 对，天然可核对，直接喂给聚合视图。

**3. Anki 卡片（确认挂在工具执行前，留痕用现有协议字段）**

- 现状：`builtin-chatanki_update_library_card`（CAS 写回）；`_original_generation` 是天然 before 基线；
  `_content_provenance` 是 actor 戳；`_qa_flags` 条目形状 `{code,field,message,severity}` 可复用；
  聊天块内联编辑 `InlineCardItem` 已有人手改卡链路。
- 改动：
  - LLM 改库卡工具（`builtin-chatanki_update_library_card`，当前 sensitivity=Low 不触发审批）
    提级到 **High** 走现有审批通道（**Craft+Relaxed 预设会绕过 Medium**，authority_mode.rs:124-132，
    故须 High；一行 Rust 改动，或零代码走设置 `tool_approval.override`）。
    **注意审批 UI（BlockingApprovalBar）只渲染脱敏参数 JSON，无字段级 diff**——diff 预览卡是
    新增 UI 工作：审批栏加 anki 分支按 cardId 拉 before（`_original_generation` 或 expectedVersion
    快照）现算 diff，或把 diff 摘要预计算进工具描述。
  - 撤销 = CAS 写回 before 快照（`update_anki_card_if_version_for_library` 已是版本化写入）。
  - 留痕：追加一条 `_qa_flags` 形状的记录条目（`_` 前缀字段已被编辑 UI/导出自动排除）。
    **不要动 `_content_provenance` 的 actor**——LLM 改库卡现盖 `actor=user, code=chatanki_update_library_card`
    是 gold 挖掘契约（有测试守门，gold_provenance_excludes_critic），区分"AI 改卡"用 code 或新增字段。

**4. generative action undo 接生产（样板）**

- 基础设施完整（ActionBarBlock 撤销按钮 + undoStack + wrapReversibleAction）但**生产 handler 无一接 undo**。
- 选 1–2 个天然可逆的 handler 接 undo 作样板。`apply-note-edit` 有两个接线缺口：
  ① handler 只派发 `canvas:ai-edit-request` 建议，dispatch 即 resolve、undoStack 当即入栈，
  而用户 accept 在其后——undo 需定义两态语义（未 accept = 撤回建议；已 accept = checkpoint 回滚）；
  ② checkpoint 活在 NotesCrepeEditor 的 hook 实例里，generative-ui 侧无通道可达，
  需新建一条查询/回滚通道（事件或 registry）。
  导航类 action（start-review/open-resource）不接（无可撤销的持久化变更，openResourceActionHandlers.ts:166 语义保留）。

**5. 会话级"变更"聚合视图（薄壳）**

- 数据源按壳区分（**runLedger 只在 workbench 激活时产生新数据**——经典壳下 ACR probe 返回
  disabled，apply_ops/revert_run 被 gate，stageManager.ts:2168-2192）：
  - **两壳通用（已持久化）**：聊天写工具块 toolOutput（mindmap_edit_nodes 后端路径返回
    versionId+citation、note 写回执、chatanki 结果——复用 P1 的 extractors 模式扫 blocks）
    + 导图版本表（`chat_edit_nodes` 来源可枚举，持久、跨重启，是经典壳下最硬的改动记录）
    + Anki provenance 条目；
  - **workbench 壳附加**：ACR receipt（done/undone 人读列表随 block.toolOutput 持久化）。
    **注意 runLedger 虽存了 label 却无读取 API**——人读列表只能从持久化 receipt 块派生；
    撤销入口在 ledger LRU 淘汰后降级为 undoExpired（语义抄 workbenchOpsBlock）。
- 渲染复用 `workbenchOpsBlock` 的 undo chrome 模式（步骤流 + 撤销按钮 + undoExpired 语义）。
- 落点：P1 的 artifacts 面板内加一个"变更"分段（与 WorkBuddy 右侧边栏"产物+变更"同构）。
  补充订正：`undoDurability:'persistent'` **已实现**（agentUndoJournal + localStorage 跨重启），
  但仅覆盖 ACR 2.0 语义 action 路径；P2 各面的 driver ops 仍是 session-only，MVP 不依赖持久撤销。

### 改动文件清单

| 文件 | 改动 |
|---|---|
| `notes/hooks/useCanvasAIEditHandler.ts` | checkpoint 栈化 + accept 时推 change-log |
| `workbench/agent/drivers/mindmapDriver.ts` | suggestion 屏障升级为暂存+预览+接受 |
| `mindmap/components/...` | 幽灵态演出 + 确认条（复用 VersionPreview 样式） |
| `chat/skills/builtin/index.ts`（chatanki_update_library_card 处） | 执行前 HITL 字段级 diff 预览 |
| `generative-ui/bridge/resolveGenerativeUIChatActionHandlers.ts` | apply-note-edit 接 undo |
| `chat/components/artifacts/ChangesSection.tsx` | 新增（聚合视图薄壳） |

### 验证

- 单测：checkpoint 栈回滚序列；mindmap 暂存 ops 的接受/拒绝；anki 字段级 diff 与 CAS 撤销。
- demo 壳：fixtures 加"AI 改导图 → 预览确认 → 撤销"剧本。

---

## P3 产物模板 skill 化（canvas-in-skills）

### 目标

skill 可声明产物布局：触发描述 + generative-ui intent 骨架 + 数据工具绑定；
用户一句话（"生成本周学习报告"）产出同构看板。**复用 SKILL.md manifest，不另起机制。**

### 设计

**1. 声明面**：frontmatter 加可选键 `artifact:`

```yaml
---
name: weekly-report
description: 生成周度学习报告（掌握度/错题分布/复习曲线）   # 触发描述并入 description，目录发现零改动
artifact:
  intentSkeleton: { version: '1.1', layout: { mode: 'grid', columns: 2 },
                    blocks: [ { type: 'stat-card', ... }, { type: 'chart', ... } ] }
  dataTools: [query_review_stats]     # 指向本 skill embeddedTools 的 name
  layoutLock: true                    # 模型只能填数据，不能增删块
---
```

改动点：`skills/parser.ts` 的 `KNOWN_FRONTMATTER_KEYS` + 解析处 + `types.ts SkillMetadata` 加字段 +
校验函数 + **`serializeSkillToMarkdown` 显式序列化该键**（关键陷阱：一旦进 KNOWN 集合就不再进
`preservedFrontmatter`，序列化漏了它，技能编辑保存后该键**静默丢失**；未知键本就走
preservedFrontmatter，旧版本互读不炸）。

**2. 注入面**：skill 激活时把 intentSkeleton 渲染进 skill content（经现有 `<skill_instructions>`
transient 消息进 prompt，零新管道）；**加载时对照 `generativeUIRegistry` 校验骨架 block type 合法性**。
注意白名单实际有**三处**：skill content 硬编码、前端 registry、Rust `ALLOWED_GENERATIVE_UI_BLOCK_TYPES`
（generative_ui_executor.rs:23-42，真正的闸门）——骨架校验以前端 registry 为准，
顺带补上"skill content 与 registry 无契约测试"的现有缺口。

**3. 执行面**：`builtin-render_generative_ui` 的 inputSchema 加可选参数 `skeletonRef`
（顶层 `additionalProperties: false`，必须显式加 property）。**但 executor 拿不到骨架**——
frontmatter 由前端 parser 解析，后端只收到 skill 正文（TauriAdapter 只发 `skill.content`），
ExecutionContext 只有 `skill_contents`/`skill_package_roots`，Rust 侧也无通用 YAML 解析。
可行路径按推荐排序：
- (d) **前端校验**（推荐）：generativeUI onEnd 处对照已激活 skill 的 SkillMetadata 校验块序列，
  不符则降级为普通产物 + 提示（无工具错误通道，但零协议改动）；
- (a) `skeletonRef` 内联携带骨架：模型自控、强制力弱，作为模型面契约与 (d) 搭配；
- (c) 新通道把骨架透传进 ExecutionContext：真实的 Rust+协议改动，强约束需求被验证后再做。

数据工具走该 skill 自己的 embeddedTools（渐进披露已保证只在激活后注入）。

**4. 注意**：`<available_skills>` 目录会话级冻结（first-write-wins）——骨架只进激活后的 skill 正文，
不进目录，避免撑爆目录和 prompt cache。

### 依赖与验证

- 依赖 P1 的 registry（产物可重开/刷新，模板价值才闭环）；建议 P1 落地后用"周度学习报告"做第一个真实模板验证。
- 单测：manifest 解析（含未知键 round-trip）、骨架校验（合法/非法 type、layoutLock 不符）。

---

## 分期与依赖

```
P0 选区即上下文        —— 独立，成本最小，先行
P1 产物 registry       —— 独立（与 P0 并行亦可），P3 的前置
P2 人机双写            —— 独立；聚合视图分段落在 P1 面板内（弱依赖，可后补）
P3 skill 产物模板      —— 依赖 P1
```

每个 P 独立可交付、独立可用 demo 壳验证；均不需要新架构、新存储层。Rust 改动面：P0/P1 零改动；
P2 仅 anki 工具 sensitivity 提级一行（或零代码走设置 override）；P3 推荐路径（前端校验）零改动，
强约束路径（骨架透传进 ExecutionContext）才涉及 Rust+协议。

## 风险与开放问题

1. **P0 导图子树序列化长度**：选中大子树时文本膨胀——截断策略（深度/节点数上限 + "等 N 个节点"后缀），
   与现有 context 截断（truncateContextByTokens）叠加即可。
2. **P1 历史会话的 refreshPrompt 回填**：用户消息可能被编辑/删除，回填失败时隐藏"刷新"动作即可（降级不报错）。
3. **P2 导图暂存预览的演出复杂度**：幽灵态与 ACR pacing 演出的交互需要原型验证；若复杂度过高，
   MVP 退化为"diff 摘要确认条（无画布幽灵态）→ 接受后正常演出"，仍满足可核对。
4. **P2 变更聚合视图的数据源异构**：三类来源的时间线合并按 appliedAt 简单排序，不做跨源关联（过度设计）。
5. **开放**：产物面板在移动端（isSmallScreen）的形态——建议 MVP 桌面端先行，移动端复用右屏 UnifiedAppPanel 通道二期评估。
6. **P0 retrieval 快照 24h 清扫**：未发送的选区快照（ref_count=0）24h 后被启动清扫回收——语义可接受，
   但要在测试与边界文案中知晓；已发送消息引用的快照安全。
7. **P0 移动端导图无入口**：MindMapFormatBar 挂载条件含 `!isCoarsePointer`，触屏永不渲染——桌面先行，
   移动端入口（如节点长按菜单）列为后续项。
8. **P1 历史分页水合漏收**：restore 分页加载，懒扫只覆盖已加载页——prependHistoryFromBackend 后需增量补扫。
9. **P1 session.metadata 并发覆盖**：整体替换语义 + 多键同住（authorityMode/availableSkillsSnapshot/...），
   artifact 元数据写必须 read-modify-write；多窗口同时写存在互相覆盖面，MVP 接受（单用户桌面场景），
   不做版本化合并（过度设计）。
10. **P2 经典壳 HITL 缺口**：builtin-note_* 工具直写在经典壳绕过确认链路——MVP 只覆盖 generative-ui
    与 workbench ACR 路径，工具直写接回建议通道列为一期可选项。

---

## 复审记录（2026-09-06 第二轮：三路并行代码验证）

对方案全部承重事实做了逐条 PASS/FAIL 验证（P0 13 条、P1/P3 14 条、P2 10 条），
结果：**无方向性错误，1 个关键事实错误已修正，17 处细节/行号已修正，12 个新风险已并入上文**。

### 关键修正（会影响实现正确性的）

1. **intent 落库渠道是 tool_input 而非 tool_output**（P1）：executor 的 tool_output 只有
   `{status:'rendered', blockCount}`；前端 onEnd 写的 `toolOutput.intent` 从不回写 DB。
   所有取 intent 处必须走 `extractGenerativeUIIntent` 三级回退。**demo 壳快照会掩盖此差异**，
   需补真实重启路径测试。
2. **live/restore 的 contextSnapshot 不对称**（P1）：live 路径 userRefs 在**前一用户消息**上，
   onEnd 登记时需沿 messageOrder 前溯；restore 后助手消息才有 contextSnapshot。
3. **diff_versions 不能用于暂存 ops 预览**（P2）：它只 diff 已持久化版本；暂存预览需前端模拟
   ops 自建 diff（或先 apply → diff → 拒绝则 ledger 回滚）。
4. **经典壳下笔记工具直写绕过确认链路**（P2）：P2 笔记面 MVP 范围收窄为 generative-ui +
   workbench ACR 两路径。
5. **P3 executor 拿不到骨架**：frontmatter 只在前端解析；推荐改在前端 onEnd 校验（零协议改动），
   "仅 executor 加可选校验参数"的原判断低估了这一层。
6. **runLedger 无 label 读取 API**（P2）：聚合视图的人读列表只能从持久化 receipt 块派生。

### 已并入正文的细节修正

行号/位置类：VfsResourceType 在 types.rs L86-105；useReferenceToChat 在 features/learning-hub/ 且跨度
L228-376；mindmapDriver 实际路径 `workbench/agent/drivers/`；DesktopSecondaryPanelMode 是 ChatV2Page
本地类型；definitions 注册是三处结构而非一行。

语义类：session metadata 整体替换需 read-modify-write；LRU 清理要同时挂 session-evicted 与
session-destroyed；切会话清理不含 canvasSidebarOpen，artifacts mode 重置需显式加；anki 产物重开走
"块快照自渲染"（卡片库无 taskId 过滤，MVP 不做）；审批 UI 无字段级 diff（新增 UI 工作）且须 High
敏感度（Relaxed 绕过 Medium）；`_content_provenance` actor 是 gold 挖掘契约不可动；
`artifact:` 键进 KNOWN_FRONTMATTER_KEYS 后必须同步 serializeSkillToMarkdown；block 白名单是三处
（Rust ALLOWED_GENERATIVE_UI_BLOCK_TYPES 是闸门）；`undoDurability:'persistent'` 已实现但仅覆盖
ACR 2.0 语义 action。

### 验证中确认"比预期更好"的点

- retrieval 类型资源在所有用户可见列表（dstu list/search/收藏/回收站/FTS 索引）中均被排除——
  选区快照用 retrieval 存储**不污染资源库**（P0 最大隐患排除）。
- ContextRefChips/ContextRefsDisplay 对未知 typeId 均有兜底，不崩溃。
- AnkiCardsBlock 不依赖消息上下文，可在面板独立渲染。
- GenerativeUIPanel 本体零 store 依赖，可在聊天外渲染 intent。
- HITL 审批通道（approval_scope + BlockingApprovalBar + sensitivity 分级）成熟可用。
- 导图 ACR 路径每 op 的 ledger 逆操作带 stableValue 冲突检测，行号全部命中。

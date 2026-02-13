# Chat V2 块渲染/互动/持久化 — 开发者参考手册

> **适用版本**：2026-02-09  
> **适用场景**：新增块类型、扩展工具渲染、调试块生命周期、理解引用系统

---

## 目录

1. [总体架构](#1-总体架构)
2. [Block 类型体系](#2-block-类型体系)
3. [插件注册机制](#3-插件注册机制)
4. [块渲染链路](#4-块渲染链路)
5. [事件系统与块创建](#5-事件系统与块创建)
6. [块持久化与流式处理](#6-块持久化与流式处理)
7. [工具块渲染详解](#7-工具块渲染详解)
8. [引用/来源渲染系统](#8-引用来源渲染系统)
9. [Markdown 渲染系统](#9-markdown-渲染系统)
10. [活动时间线](#10-活动时间线)
11. [变体系统](#11-变体系统)
12. [工作区与子代理](#12-工作区与子代理)
13. [技能与工具定义系统](#13-技能与工具定义系统)
14. [后端工具执行器](#14-后端工具执行器)
15. [扩展指南：新增块类型](#15-扩展指南新增块类型)
16. [扩展指南：新增引用跳转类型](#16-扩展指南新增引用跳转类型)
17. [技能迁移指南：builtin → builtin-tools](#17-技能迁移指南builtin--builtin-tools)
18. [后端执行器开发规范](#18-后端执行器开发规范)

---

## 1. 总体架构

Chat V2 采用 **三注册表协作** 的插件化架构：

```
┌─────────────────────────────────────────────────────────────────┐
│                        Plugin System                            │
│                                                                 │
│  ┌─────────────┐   ┌──────────────┐   ┌────────────────────┐   │
│  │ modeRegistry│   │ eventRegistry│   │   blockRegistry    │   │
│  │ (模式插件)  │   │ (事件处理器) │   │   (块渲染组件)     │   │
│  └──────┬──────┘   └──────┬───────┘   └──────────┬─────────┘   │
│         │                 │                       │             │
│    控制工具/提示      创建+更新 Block          渲染 Block       │
│         ▼                 ▼                       ▼             │
│  ┌──────────┐      ┌───────────┐          ┌───────────────┐    │
│  │ChatStore │◄─────│EventBridge│─────────►│BlockRenderer  │    │
│  │(状态中心)│      │(事件桥接)  │          │(渲染分发器)   │    │
│  └──────────┘      └───────────┘          └───────────────┘    │
│                           ▲                                     │
│                  后端事件流 │ (Tauri IPC)                        │
└─────────────────────────────────────────────────────────────────┘
```

**核心设计原则**：

| 原则 | 实现方式 | 收益 |
|------|---------|------|
| 注册表驱动 | `Registry<T>` 泛型基类 + 3 个单例注册表 | 开闭原则，新增块类型无需修改渲染器 |
| Import 即注册 | 模块顶级作用域调用 `registry.register()` | 零配置，导入即可用 |
| 禁止 switch/case | EventBridge 和 BlockRenderer 强制走注册表 | 消除硬编码，支持运行时动态注册 |
| SSOT | Store 作为唯一真相源 | 事件处理器和块渲染器解耦 |

---

## 2. Block 类型体系

### 2.1 类型定义

所有 Block 类型在 `core/types/common.ts` 中定义：

```typescript
export type BlockType =
  | 'thinking'           // 思维链
  | 'content'            // 正文
  | 'rag'                // 文档知识库 RAG
  | 'memory'             // 用户记忆
  | 'web_search'         // 网络搜索
  | 'multimodal_rag'     // 多模态知识库
  | 'mcp_tool'           // MCP 工具调用
  | 'image_gen'          // 图片生成
  | 'anki_cards'         // Anki 卡片生成
  | 'workspace_status'   // 工作区状态面板
  | 'subagent_retry'     // 子代理重试提醒块
  | 'tool_limit'         // 工具递归限制提示
  | string;              // 插件扩展
```

### 2.2 Block 状态机

```
pending → running → success
                  → error
```

```typescript
export type BlockStatus = 'pending' | 'running' | 'success' | 'error';
```

### 2.3 Block 数据结构

```typescript
// core/types/block.ts
export interface Block {
  id: string;                          // blk_{uuid}
  type: BlockType;
  status: BlockStatus;
  messageId: string;
  content?: string;                    // 流式块文本内容
  toolName?: string;                   // 工具调用名
  toolInput?: Record<string, unknown>; // 工具输入参数
  toolOutput?: unknown;                // 工具输出结果
  isPreparing?: boolean;               // LLM 正在生成工具参数
  toolCallId?: string;
  citations?: Citation[];              // 引用来源
  error?: string;
  startedAt?: number;
  firstChunkAt?: number;               // 首个有效 chunk 到达时间
  endedAt?: number;
}
```

### 2.4 分类总览

| 分类 | 块类型 | 插件文件 | onAbort |
|------|--------|---------|---------|
| **流式内容** | `thinking`, `content` | `blocks/thinking.tsx`, `blocks/content.tsx` | keep-content |
| **知识检索** | `rag`, `memory`, `web_search`, `multimodal_rag` | `blocks/rag.tsx`, `blocks/memory.tsx`, `blocks/webSearch.tsx` | mark-error |
| **工具调用** | `mcp_tool`, `image_gen` | `blocks/mcpTool.tsx`, `blocks/imageGen.tsx` | mark-error |
| **任务管理** | `todo_list` | `blocks/todoList.tsx` | keep-content |
| **多Agent** | `workspace_status`, `subagent_embed`, `subagent_retry`, `sleep` | 各同名文件 | 混合 |
| **Anki** | `anki_cards` | `blocks/ankiCardsBlock.tsx` | keep-content |
| **系统** | `tool_limit` | `blocks/toolLimit.tsx` | keep-content |
| **兜底** | `generic` | `blocks/generic.tsx` | mark-error |

---

## 3. 插件注册机制

### 3.1 注册表基类

```typescript
// registry/Registry.ts
export class Registry<T> {
  private plugins: Map<string, T> = new Map();
  register(key: string, plugin: T): void;
  get(key: string): T | undefined;
  has(key: string): boolean;
  getAll(): Map<string, T>;
  keys(): string[];
  unregister(key: string): boolean;
}
```

### 3.2 块注册表

```typescript
// registry/blockRegistry.ts
export interface BlockRendererPlugin {
  type: string;
  component: ComponentType<BlockComponentProps>;
  onAbort?: OnAbortBehavior;  // 'keep-content' | 'mark-error'
}

export interface BlockComponentProps {
  block: Block;
  isStreaming?: boolean;
  store?: StoreApi<ChatStore>;
  onContinue?: () => Promise<void>;
}
```

### 3.3 自执行注册模式

每个插件文件在模块顶级作用域执行注册：

```typescript
// plugins/blocks/content.tsx（示例）
blockRegistry.register('content', {
  type: 'content',
  component: ContentBlock,
  onAbort: 'keep-content',
});
```

### 3.4 注册入口链

```
应用启动
  → import 'chat-v2/plugins'           // plugins/index.ts
    → import './blocks'                 // plugins/blocks/index.ts
      → import './content'              // → blockRegistry.register('content', ...)
      → import './thinking'             // → blockRegistry.register('thinking', ...)
      → import './mcpTool'              // → blockRegistry.register('mcp_tool', ...)
      → ...
    → import './events'                 // plugins/events/index.ts
      → import './content'              // → eventRegistry.register('content', ...)
      → import './toolCall'             // → eventRegistry.register('tool_call', ...)
      → ...
    → import './modes'                  // plugins/modes/index.ts
      → import './chat'                 // → modeRegistry.register('chat', ...)
```

---

## 4. 块渲染链路

### 4.1 完整数据流

```
Store(blocks Map)
  → MessageList (订阅 messageOrder)
    → MessageItem (计算 displayBlockIds)
      ├── 时间线块 → ActivityTimelineWithStore (分组渲染)
      └── 内容块 → BlockRendererWithStore (独立渲染)
           → blockRegistry.get(block.type) → 获取渲染组件
             → 渲染具体 Block Component
```

### 4.2 BlockRendererWithStore

渲染核心组件，性能优化关键：

```typescript
// components/BlockRenderer.tsx
const BlockRendererWithStoreInner = ({ store, blockId, className }) => {
  // 细粒度订阅：只订阅单个 block
  const block = useBlock(store, blockId);
  // 细粒度订阅：只订阅此 block 的流式状态
  const isStreaming = useIsBlockActive(store, blockId);

  if (!block) return null;
  // 来源类型块不在此渲染（由 SourcePanelV2 统一展示）
  if (SOURCE_BLOCK_TYPES.has(block.type)) return null;

  // 从注册表获取渲染插件（禁止 switch/case）
  const plugin = blockRegistry.get(block.type);
  const Component = plugin?.component ?? GenericBlock;

  return (
    <div className="block-renderer">
      <BlockErrorBoundary block={block}>
        <Component block={block} isStreaming={isStreaming} store={store} />
      </BlockErrorBoundary>
    </div>
  );
};
```

**设计要点**：

- **注册表驱动**：`blockRegistry.get(block.type)` 获取渲染组件
- **GenericBlock 兜底**：未注册类型使用通用块显示原始内容
- **来源块过滤**：`rag`, `memory`, `web_search`, `multimodal_rag` 不在消息流渲染
- **ErrorBoundary**：每个块独立错误边界
- **React.memo**：只在 `store`/`blockId`/`className` 变化时重渲染

---

## 5. 事件系统与块创建

### 5.1 后端事件结构

```typescript
interface BackendEvent {
  sequence_id: number;    // 递增序列号（乱序检测）
  type: string;           // 事件类型：'thinking' | 'content' | 'tool_call' | ...
  phase: EventPhase;      // 'start' | 'chunk' | 'end' | 'error'
  messageId?: string;
  blockId?: string;
  chunk?: string;         // 流式内容
  result?: unknown;       // 最终结果
  error?: string;
  payload?: Record<string, unknown>;
  variantId?: string;     // 多变体支持
}
```

### 5.2 事件处理器接口

```typescript
// registry/eventRegistry.ts
export interface EventHandler {
  onStart?: (store, messageId, payload, backendBlockId?) => string;  // 返回 blockId
  onChunk?: (store, blockId, chunk) => void;
  onEnd?: (store, blockId, result?) => void;
  onError?: (store, blockId, error) => void;
}
```

### 5.3 事件分发链路

```
后端 SSE
  → TauriAdapter.handleBlockEvent()
    → EventBridge.handleBackendEventWithSequence()
      → 序列号检测 + 乱序缓冲
      → eventRegistry.get(type) → Handler
        → phase=start  → handler.onStart()  → store.createBlock()
        → phase=chunk  → chunkBuffer 批量更新（content/thinking）
                        → handler.onChunk()（其他类型）
        → phase=end    → handler.onEnd()    → store.setBlockResult()
        → phase=error  → handler.onError()  → store.setBlockError()
```

### 5.4 chunkBuffer 性能优化

对 `content` 和 `thinking` 类型的高频 chunk，不直接更新 Store，而是通过 chunkBuffer（16ms 窗口）合并后批量更新：

```typescript
if ((type === 'content' || type === 'thinking') && chunk) {
  chunkBuffer.setStore(store);
  chunkBuffer.push(effectiveBlockId, chunk, store.sessionId);
  // 定期保存到后端（防闪退）
  streamingBlockSaver.scheduleBlockSave(...);
}
```

### 5.5 已注册的事件处理器

| 事件类型 | 注册文件 | 创建的块类型 |
|---------|----------|------------|
| `thinking` | `events/thinking.ts` | `thinking` |
| `content` | `events/content.ts` | `content` |
| `tool_call` | `events/toolCall.ts` | `mcp_tool` 或 `sleep` |
| `tool_call_preparing` | `events/toolCall.ts` | `mcp_tool`（preparing 状态） |
| `image_gen` | `events/toolCall.ts` | `image_gen` |
| `rag` / `memory` / `web_search` / `multimodal_rag` | `events/retrieval.ts` | 各自对应类型 |
| `tool_approval_request` | `events/approval.ts` | 审批请求 |
| `tool_limit` | `events/toolLimit.ts` | `tool_limit` |
| `anki_cards` | `events/ankiCards.ts` | `anki_cards` |

---

## 6. 块持久化与流式处理

### 6.1 数据库存储

`chat_v2_blocks` 表（SQLite），14 列：

| 字段 | 类型 | 说明 |
|------|------|------|
| `id` | TEXT PK | 块 ID，格式 `blk_{uuid}` |
| `message_id` | TEXT FK | 所属消息 ID，级联删除 |
| `block_type` | TEXT | 块类型 |
| `status` | TEXT | 块状态 |
| `block_index` | INTEGER | 块在消息内的排序索引 |
| `content` | TEXT | 文本内容 |
| `tool_name` | TEXT | 工具名称 |
| `tool_input_json` | TEXT | 工具输入参数 JSON |
| `tool_output_json` | TEXT | 工具输出结果 JSON |
| `citations_json` | TEXT | 引用来源 JSON |
| `error` | TEXT | 错误描述 |
| `started_at` | INTEGER | 块开始时间戳（ms） |
| `ended_at` | INTEGER | 块结束时间戳（ms） |
| `first_chunk_at` | INTEGER | 首个有效 chunk 到达时间 |

### 6.2 双保险持久化策略

```
           流式过程中                         流式完成后
    ┌──────────────────────┐         ┌──────────────────────┐
    │ 前端 streamingBlock  │         │ 后端 Pipeline        │
    │ Saver（5秒节流）     │         │ .save_results()      │
    │                      │         │                      │
    │ INSERT OR REPLACE    │         │ BEGIN IMMEDIATE      │
    │ 临时禁用外键约束     │         │ 事务原子性写入       │
    │ 确保消息占位存在     │         │ COMMIT / ROLLBACK    │
    └──────────────────────┘         └──────────────────────┘
```

### 6.3 会话加载恢复

```rust
// repo.rs: 批量查询优化（4次查询代替 N+1）
pub fn load_session_full_with_conn(conn, session_id) -> LoadSessionResponse {
    let session = get_session(conn, session_id)?;
    let messages = get_session_messages(conn, session_id)?;
    let blocks = get_session_blocks(conn, session_id)?;  // JOIN 排序
    let state = load_session_state(conn, session_id)?;
}

// 块排序：COALESCE(first_chunk_at, started_at) ASC, block_index ASC
```

### 6.4 安全机制

| 机制 | 实现 | 作用 |
|------|------|------|
| StreamGuard（RAII） | `impl Drop` 自动 `remove_stream()` | 即使 panic 也能清理流状态 |
| 原子流注册 | `try_register_stream()` + Mutex | 防并发多流 |
| VFS 引用计数 | COMMIT 后执行 `decrement_refs` | 防事务回滚后计数不一致 |
| AutoSave | 500ms 节流 + 流式结束强制保存 | 前端状态落盘 |

---

## 7. 工具块渲染详解

### 7.1 MCP 工具块（`mcp_tool`）— 最复杂的块

**文件**：`plugins/blocks/mcpTool.tsx`

`mcp_tool` 是通用工具块容器，内部按 `toolName` 进行二次路由：

| 匹配条件 | 渲染策略 |
|---------|---------|
| `todo_init/update/add/get` | 委托给 `TodoListBlock` |
| `attempt_completion` + success | 委托给 `CompletionCard` |
| 笔记工具 `note_*` | 标准渲染 + 笔记跳转按钮 |
| 其他 | ToolHeader + ToolInputView + ToolProgress + ToolOutputView/ToolError |

**通用渲染框架**：

- `ToolInputView`：可折叠参数展示，键值对简洁模式 + JSON 完整展开
- `ToolOutputView`：智能检测输出格式（json / text / table / image）
- `TemplateToolOutput`：Anki 模板可视化输出（ShadowDOM + Mustache 渲染）

### 7.2 Todo 列表块（`todo_list`）

**文件**：`plugins/blocks/todoList.tsx`

```typescript
interface TodoListOutput {
  success: boolean;
  todoListId?: string;
  title?: string;
  steps?: TodoStep[];
  completedCount?: number;
  totalCount?: number;
  isAllDone?: boolean;
  currentRunning?: TodoStep;
  continue_execution?: boolean;
}
```

**特殊交互**：
- 状态图标：pending=空心圆, running=蓝色实心+序号, completed=绿色✓, failed=红色✗
- `changedStepId` 高亮本次变更的步骤
- AnimatePresence 动画折叠/展开

### 7.3 网页搜索块（`web_search`）

**文件**：`plugins/blocks/webSearch.tsx`

- 头部显示搜索引擎标签、统计信息
- `SourceList` 组件渲染来源列表（默认 3 个，可展开）

### 7.4 子代理嵌入块（`subagent_embed`）

**文件**：`plugins/blocks/subagentEmbed.tsx`

- 嵌入完整 `ChatContainer`（子代理聊天视图）
- 预热机制：首次渲染时主动 preheat Store + Adapter
- 折叠/展开切换，折叠时显示任务摘要

### 7.5 睡眠块（`sleep`）

**文件**：`plugins/blocks/sleepBlock.tsx`

- 每个 awaiting agent 渲染一个 `SubagentEmbedItem`
- 手动唤醒按钮：`manualWake(workspaceId, sleepId)`
- 实时事件监听：agent 状态、消息、唤醒状态

### 7.6 工作区状态块（`workspace_status`）

**文件**：`plugins/blocks/workspaceStatus.tsx`

- 三种模式：历史（快照）、不匹配（警告）、实时
- Agent 列表 + 进度条动画 + 最近消息

### 7.7 Anki 卡片块（`anki_cards`）

**文件**：`plugins/blocks/ankiCardsBlock.tsx`

- 折叠态：`AnkiCardStackPreview` 卡片堆叠预览
- 展开态：`InlineCardItem` 列表，支持内联编辑
- 多模板支持：`useMultiTemplateLoader` + ShadowDOM 渲染
- 持久化编辑：`invoke('chat_v2_update_block_tool_output')`

### 7.8 图片生成块（`image_gen`）

**文件**：`plugins/blocks/imageGen.tsx`

- 四态渲染：pending/running(动画)/error(重试)/success(ImagePreview)
- 支持全屏查看

### 7.9 笔记工具块的特殊渲染

笔记工具块有 **两条渲染路径**：

**路径 A — 活动时间线中**：`NoteToolPreview` 组件

| 工具类型 | 渲染策略 |
|---------|---------|
| `note_read` | 灰色背景展示读取的 Markdown |
| `note_append` | 绿色背景高亮追加内容 + 操作后预览 |
| `note_replace` | 左右对比：红色（修改前）+ 绿色（修改后） |
| `note_set` | 左右对比：红色（修改前）+ 绿色（修改后） |
| `note_create/list/search` | 标准工具头部 |

支持 Diff/Preview 双视图切换，操作统计（字符数/替换次数）。

**路径 B — 独立 MCP 块中**：`McpToolBlockComponent` 标准渲染 + 笔记跳转按钮

跳转通过 `window.dispatchEvent(new CustomEvent('DSTU_OPEN_NOTE', { detail: { noteId } }))` 实现。

### 7.10 工具审批卡片

**文件**：`components/ToolApprovalCard.tsx`

- 带倒计时审批卡片（黄色边框）
- 4 个按钮：始终允许 / 始终拒绝 / 单次拒绝 / 单次批准
- 超时自动拒绝
- `remember` 参数支持记忆决策

---

## 8. 引用/来源渲染系统

### 8.1 引用类型

| 类型 | 来源 | 跳转行为 |
|------|------|---------|
| `rag` | 文档知识库 | `DSTU_NAVIGATE_TO_KNOWLEDGE_BASE` 跳转知识库 |
| `memory` | 用户记忆 | 跳转知识库记忆 Tab |
| `web_search` | 互联网搜索 | `openUrl` 外部链接 |
| `multimodal` | 多模态 RAG | 跳转知识库 |
| 思维导图 | `MindmapCitationCard` | `NAVIGATE_TO_VIEW` → Learning Hub |
| PDF 页面 | PDF 引用标记 | `pdf-ref:open` 事件 |

### 8.2 引用数据流

```
后端 SSE (rag/memory/web_search/multimodal_rag)
  → eventRegistry (retrieval.ts)
    → store.createBlock() → block.toolOutput 填充
  → sourceAdapter.ts 转换
    → UnifiedSourceBundle { total, groups[] }
  → UnifiedSourcePanel 聚合渲染
```

`sourceAdapter.ts` 兼容 5 种后端数据格式：

```typescript
// 格式 1: { citations: [...] }
// 格式 2: 直接数组 [...]
// 格式 3: { items: [...] }
// 格式 4: { sources: [...] }
// 格式 5: { results: [...] }
```

### 8.3 正文引用标记

通过 remark 插件在 Markdown AST 层面处理 4 种引用标记：

| 正则模式 | 匹配示例 | 渲染组件 |
|---------|---------|---------|
| `CITATION_PATTERN` | `[知识库-1]` | `CitationBadge`（点击高亮来源面板） |
| 带图引用 | `[知识库-1:图片]` | `CitationBadge` + `AsyncCitationImage` |
| `MINDMAP_CITATION_PATTERN` | `[思维导图:mm_abc123]` / `[思维导图:mv_abc123]` | `MindmapCitationCard`（ReactFlow 预览） |
| `PDF_REF_PATTERN` | `[PDF@sourceId:3]` | PDF 跳转链接 |

### 8.4 统一来源面板

**文件**：`components/panels/UnifiedSourcePanel.tsx`

- 类别优先级：tool > multimodal > rag > memory > web_search
- 桌面端：水平轮播 + 网格展开 + Hover 预览 Portal
- 移动端：底部 Sheet 抽屉
- 全局索引与正文引用编号一致
- `citationEvents` 单例通信：正文标记点击 → 面板高亮定位

### 8.5 内联查看器

| 查看器 | 文件 | 功能 |
|--------|------|------|
| `InlineDocumentViewer` | `components/InlineDocumentViewer.tsx` | 字体缩放、全文搜索、复制、下载 |
| `InlineImageViewer` | `components/InlineImageViewer.tsx` | 缩放 0.1x~5x、旋转、拖拽平移、多图导航 |

两者都采用 Portal 策略：挂载到 `document.body`，精确覆盖 `.chat-v2` 区域。

---

## 9. Markdown 渲染系统

### 9.1 渲染器层次

```
StreamingMarkdownRenderer (流式入口)
  → 数学公式安全裁剪 (trimTrailingIncompleteMath)
  → Markdown 悬垂修复 (sanitizeDanglingMarkdown)
  → MarkdownRenderer (底层静态渲染)
    → ReactMarkdown + remark/rehype 插件管线
      ├── CodeBlock (代码块: 语法高亮/Mermaid/SVG/HTML)
      ├── KaTeX (数学公式)
      └── CitationBadge (引用标记)
```

### 9.2 渲染器选择

| 渲染器 | 用途 | 场景 |
|--------|------|------|
| `StreamingMarkdownRenderer` | 流式 AI 回复 | ContentBlock、ThinkingBlock |
| `EnhancedStreamingMarkdownRenderer` | 改进版流式 | 更精细的悬垂处理 |
| `MarkdownRenderer` | 底层静态渲染 | 所有渲染器的基石 |
| `renderMarkdownStatic` | 静态 HTML 输出 | 导出 |

### 9.3 Remark 插件管线

执行顺序：

1. `disableIndentedCodePlugin` — 禁用缩进代码块
2. `normalizeFullWidthPunctPlugin` — 全角标点规范化
3. `convertMathCodeBlocksPlugin` — math/latex 代码块转换
4. `remarkMath` — 数学公式
5. `remarkGfm` — GFM 扩展
6. `makeCitationRemarkPlugin()` — 引用标记处理
7. `extraRemarkPlugins` — 外部插件

### 9.4 代码块（CodeBlock）

- 5 种可渲染语言：`mermaid`、`svg`、`html/htm`、`xml`
- Mermaid：动态 import + 暗/亮色主题 + 平移缩放 + Fit View
- SVG：DOMPurify 消毒
- LaTeX 代码块兜底检测

### 9.5 性能优化

- `React.memo` + 自定义 `arePropsEqual`
- `useMemo` 替代 `useEffect + setState`
- 模块级常量避免击穿 memo
- `shallowEqualSpans` 替代 `JSON.stringify`
- KaTeX 样式按需加载

---

## 10. 活动时间线

### 10.1 时间线块类型

`thinking`、`rag`、`memory`、`web_search`、`multimodal_rag`、`mcp_tool`、`tool_limit`

### 10.2 分组渲染

在 `MessageItem` 中，助手消息的块被分为两类：
- **时间线块** → `ActivityTimelineWithStore`（分组渲染）
- **内容块** → `BlockRendererWithStore`（独立渲染）

### 10.3 节点类型映射

| Block 类型 | 时间线节点类型 | 特殊处理 |
|-----------|--------------|---------|
| `thinking` | `thinking` | 流式展开，完成折叠 |
| `mcp_tool` + TODO 工具 | `todoList` | TodoListPanel |
| `mcp_tool` + 笔记工具 | `tool`（专用） | NoteToolPreview |
| `mcp_tool` + 普通工具 | `tool` | 标准展示 |
| 检索块 | `tool` | 统一映射 |
| `tool_limit` | `limit` | 继续按钮 |

### 10.4 Thinking 节点行为

- 流式时默认展开，完成后默认折叠
- 用户手动操作后不再自动控制（`isManuallyControlled` ref）
- 内容按段落分割，最后一段显示流式光标

---

## 11. 变体系统

### 11.1 核心 Hook：`useVariantUI`

- `displayBlockIds` 通过 `store.getDisplayBlockIds()` 获取
- 浅比较优化避免无效渲染
- Feature Flag 控制并行视图

### 11.2 并行变体视图

- 双卡片并排展示
- 移动端横向滚动 + snap 对齐
- 变体切换器支持键盘导航

### 11.3 状态图标

- pending → Clock
- streaming → Loader2（动画）
- success → CheckCircle（绿）
- error → XCircle（红）
- cancelled → Ban（黄）

---

## 12. 工作区与子代理

### 12.1 Coordinator-Worker 模式

每个工作区拥有独立 SQLite 数据库（`ws_{id}.db`），包含 7 张表。

### 12.2 生命周期

```
Coordinator 创建工作区
  → 创建 Worker Agent（session + inbox）
  → 发送任务消息
  → 后端 emit workspace_worker_ready
  → 前端自动启动 Worker Pipeline
  → Coordinator 调用 coordinator_sleep
    → Pipeline 挂起在 oneshot::Receiver
Worker 完成任务
  → workspace_send(type=result)
  → MessageRouter 路由到 Coordinator inbox
  → SleepManager 检测唤醒条件
  → oneshot 唤醒 Coordinator
  → Coordinator 综合结果回复用户
```

### 12.3 唤醒条件

- `AnyMessage`：任意消息
- `ResultMessage`：result 类型消息（默认）
- `AllCompleted`：所有子代理完成
- `Timeout`：超时

### 12.4 前端实时更新

8 个 Tauri 事件通道驱动 Zustand `workspaceStore` 更新。

---

## 13. 技能与工具定义系统

### 13.1 渐进式披露架构

```
首轮请求：只注入 load_skills 元工具 + <available_skills> 目录
  → LLM 判断需要某能力
  → 调用 load_skills 加载技能组
  → 后续请求自动包含已加载的工具 Schema
```

### 13.2 内置工具组

| 技能 ID | 工具 | 后端执行器 |
|---------|------|-----------|
| `knowledge-retrieval` | rag_search, web_search, memory_search | BuiltinRetrievalExecutor |
| `canvas-note` | note_read/append/replace/set/create/list/search | CanvasToolExecutor |
| `vfs-memory` | memory_search/read/write/delete | MemoryToolExecutor |
| `learning-resource` | resource_list/read/search | BuiltinResourceExecutor |
| `mindmap-tools` | mindmap_create/update/delete | BuiltinResourceExecutor |
| `todo-tools` | todo_init/update/add/get | TodoListExecutor |
| `workspace-tools` | workspace_create/create_agent/send/query | WorkspaceExecutor |
| `web-fetch` | web_fetch | FetchExecutor |
| `qbank-tools` | qbank_* | QBankExecutor |
| `template-designer` | template_list/get/validate/create/update/fork/preview/delete | TemplateDesignerExecutor |

### 13.3 工具命名规范

所有内置工具：`builtin-<功能域>_<动作>`

后端 `strip_prefix("builtin-")` 后匹配执行器。

---

## 14. 后端工具执行器

### 14.1 ToolExecutor Trait

```rust
#[async_trait]
pub trait ToolExecutor: Send + Sync {
    fn can_handle(&self, tool_name: &str) -> bool;
    async fn execute(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<ToolResultInfo, String>;
    fn sensitivity_level(&self, tool_name: &str) -> ToolSensitivity;  // Low/Medium/High
    fn name(&self) -> &'static str;
}
```

### 14.2 执行注册表

`ToolExecutorRegistry`：有序列表 + 线性匹配 + 超时保护（`tokio::select!`）。

### 14.3 执行流程

```
LLM 返回 tool_use
  → Pipeline 解析 ToolCall
  → ToolExecutorRegistry.execute(call, ctx)
    → 线性匹配 can_handle
    → emit_tool_call_start() → 前端显示 loading
    → Executor.execute()    → 业务逻辑
    → emit_end/error()      → 前端更新状态
    → save_tool_block()     → 防闪退持久化
  → 返回 ToolResultInfo → 注入下一轮 LLM 请求
```

### 14.4 敏感等级

| 等级 | 行为 | 典型工具 |
|------|------|---------|
| `Low` | 直接执行 | 只读检索、todo、笔记、附件 |
| `Medium` | 按配置决定 | template_create、qbank_reset、memory_delete |
| `High` | 必须审批 | mindmap_delete、shell_execute |

### 14.5 笔记工具的后端执行

`CanvasToolExecutor` 支持两条执行路径：

| 路径 | 方式 | 默认 |
|------|------|------|
| 后端直写 | NotesManager 直接操作 VFS | ✅ 优先使用 |
| 前端编辑器 | `canvas:ai-edit-request` + oneshot 等待 | 备选 |

后端直写时会生成 `beforePreview`/`afterPreview`/`addedContent` 用于前端 diff 展示。

---

## 15. 扩展指南：新增块类型

### 步骤 1：定义块类型（可选）

在 `core/types/common.ts` 的 `BlockType` 联合类型中添加（或直接用 `string` 扩展）。

### 步骤 2：创建块渲染插件

```typescript
// plugins/blocks/myCustom.tsx
import { blockRegistry, type BlockComponentProps } from '../../registry';

const MyCustomBlock: React.FC<BlockComponentProps> = ({ block, isStreaming, store }) => {
  // 从 block.toolOutput / block.content 解析数据
  // 渲染 UI
  return <div>...</div>;
};

// 自执行注册（import 即生效）
blockRegistry.register('my_custom', {
  type: 'my_custom',
  component: MyCustomBlock,
  onAbort: 'mark-error',  // 或 'keep-content'
});
```

### 步骤 3：创建事件处理插件

```typescript
// plugins/events/myCustom.ts
import { eventRegistry, type EventHandler } from '../../registry';

const myCustomHandler: EventHandler = {
  onStart: (store, messageId, payload, backendBlockId?) => {
    return backendBlockId
      ? store.createBlockWithId(messageId, 'my_custom', backendBlockId)
      : store.createBlock(messageId, 'my_custom');
  },
  onChunk: (store, blockId, chunk) => {
    store.updateBlockContent(blockId, chunk);
  },
  onEnd: (store, blockId, result?) => {
    store.updateBlock(blockId, { toolOutput: result });
    store.updateBlockStatus(blockId, 'success');
  },
  onError: (store, blockId, error) => {
    store.setBlockError(blockId, error);
  },
};

eventRegistry.register('my_custom', myCustomHandler);
```

### 步骤 4：注册导入

```typescript
// plugins/blocks/index.ts 添加：
import './myCustom';

// plugins/events/index.ts 添加：
import './myCustom';
```

### 步骤 5：后端执行器（如需工具调用）

```rust
// tools/my_custom_executor.rs
pub struct MyCustomExecutor;

#[async_trait]
impl ToolExecutor for MyCustomExecutor {
    fn can_handle(&self, tool_name: &str) -> bool {
        tool_name == "my_custom" || tool_name == "builtin-my_custom"
    }

    async fn execute(&self, call: &ToolCall, ctx: &ExecutionContext) -> Result<ToolResultInfo, String> {
        ctx.emitter.emit_tool_call_start(&ctx.message_id, &ctx.block_id, &call.name, ...);
        // ... 业务逻辑 ...
        ctx.emitter.emit_end(event_types::TOOL_CALL, &ctx.block_id, Some(result), None);
        ctx.save_tool_block(&result)?;
        Ok(result)
    }

    fn sensitivity_level(&self, _: &str) -> ToolSensitivity { ToolSensitivity::Low }
    fn name(&self) -> &'static str { "MyCustomExecutor" }
}
```

### 步骤 6：工具 Schema（如需 LLM 调用）

```typescript
// skills/builtin-tools/my-custom.ts
export const myCustomSkill: SkillDefinition = {
  id: 'my-custom',
  embeddedTools: [{
    name: 'builtin-my_custom',
    description: '...',
    inputSchema: { type: 'object', properties: { ... }, required: [...] },
  }],
};
```

**注意**：整个过程**无需修改任何已有文件**（除了 index.ts 的 import），符合开闭原则。

---

## 16. 扩展指南：新增引用跳转类型

当需要让 AI 回复中的某类资源（如题目集、笔记、思维导图）可点击跳转时，遵循以下标准流程。

### 现有引用类型参考

| 引用类型 | 格式 | 正则常量 | 渲染组件 | 跳转事件 | 主题色 |
|---------|------|---------|---------|---------|--------|
| 思维导图 | `[思维导图:mm_xxx:标题]` / `[思维导图:mv_xxx:标题]` | `MINDMAP_CITATION_PATTERN` | `MindmapCitationCard` | `NAVIGATE_TO_VIEW`（仅 mm_，mv_ 仅预览） | 紫色 (violet) |
| 题目集 | `[题目集:session_id:名称]` | `QBANK_CITATION_PATTERN` | `QbankCitationBadge` | `navigateToExamSheet` | 翡翠绿 (emerald) |
| 普通引用 | `[知识库-1]` | `CITATION_PATTERN` | `CitationBadge` | `citationEvents` | 主题色 |
| PDF 页面 | `[PDF@id:3]` | `PDF_REF_PATTERN` | 内联链接 | `pdf-ref:open` | 蓝色 |

### 步骤 1：定义正则（`utils/citationRemarkPlugin.ts`）

```typescript
const MY_CITATION_PATTERN = /\[(前缀词|别名):(id格式)(?::([^\]]+))?\]/gi;
```

**要点**：
- ID 捕获组的正则要尽量严格（如 `mm_[a-zA-Z0-9_-]+`），防止误匹配
- 标题捕获组使用 `[^\]]+` 匹配到 `]` 前的所有字符
- 使用 `gi` 标志支持全局匹配和大小写不敏感

### 步骤 2：添加 AST 收集和 HTML 节点生成

在 `makeCitationRemarkPlugin` 中：

1. **重置正则 lastIndex**（检测阶段 + 收集阶段各一次）
2. **添加到快速检测**：`if (!hasCitation && !hasMyType && ...) return;`
3. **收集匹配**：push 到 `matches` 数组，type 用新的字面量（如 `'my_type'`）
4. **生成 HTML 节点**：

```typescript
parts.push({
  type: 'html',
  value: `<span data-my-citation="true" data-my-id="${id}"${titleAttr} class="my-citation-placeholder">[显示文本]</span>`,
});
```

**安全要点**：
- ID 从正则捕获，天然只含安全字符，无需额外转义
- 标题必须用 `encodeURIComponent` 编码，读取时 `decodeURIComponent` 解码
- `CitationMatch.type` 联合类型中添加新字面量

### 步骤 3：添加占位 CSS 样式

在 `CITATION_PLACEHOLDER_STYLES` 中添加 `.my-citation-placeholder` 的样式。参照思维导图的 `linear-gradient` 背景 + border 风格，使用区别于已有类型的色调。

### 步骤 4：添加 rehype-sanitize 白名单（`renderers/MarkdownRenderer.tsx`）

在 `markdownSanitizeSchema.attributes.span` 数组中添加 HAST camelCase 属性名：

```typescript
'dataMyId',        // 对应 HTML data-my-id
'dataMyCitation',  // 对应 HTML data-my-citation
'dataMyTitle',     // 对应 HTML data-my-title
```

**关键**：rehype-sanitize 使用 HAST camelCase 名称做白名单，React props 中读取时使用原始 kebab-case。映射规则：`data-my-session-id` → HAST `dataMySessionId`。

### 步骤 5：创建渲染组件

参照 `MindmapCitationBadge` 或 `QbankCitationBadge` 创建新组件：

```typescript
// components/MyCitationBadge.tsx
export const MyCitationBadge: React.FC<Props> = ({ id, title, onClick }) => {
  const handleClick = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    if (onClick) { onClick(); return; }
    // 使用项目已有的导航事件
    window.dispatchEvent(new CustomEvent('navigateToXxx', { detail: { id } }));
  }, [id, onClick]);

  return <button onClick={handleClick} className="...">...</button>;
};
```

**跳转事件选择**：
- 优先复用 `App.tsx` 已注册的事件（如 `navigateToExamSheet`、`navigateToNote`）
- 如需新事件，需在 `App.tsx` 的 `useEventRegistry` 中注册监听

### 步骤 6：在 MarkdownRenderer 的 span 组件中添加检测

```typescript
span: ({ children, ...props }) => {
  // ... 已有的思维导图、题目集检测 ...

  const isMyCitation = props['data-my-citation'] === 'true';
  if (isMyCitation) {
    const id = props['data-my-id'] as string;
    const rawTitle = props['data-my-title'] as string | undefined;
    const displayTitle = rawTitle ? decodeURIComponent(rawTitle) : undefined;
    return <MyCitationBadge id={id} title={displayTitle} />;
  }

  // ... 后续的普通引用检测 ...
}
```

### 步骤 7：在 Skill content 中提示 LLM

在对应技能的 `content` 字段中，明确告知 LLM：

```
## 引用格式

创建成功后，**必须**在回复中使用引用让用户可以直接点击打开：
- `[前缀词:返回的ID:名称]` — 推荐带名称
示例：> 我已创建了 [前缀词:xxx:名称]，点击可直接打开。
```

同时在工具的 `description` 中也加入提示（如 `创建成功后，在回复中使用 [前缀词:返回的ID:名称] 格式`）。

### 检查清单

- [ ] 正则 ID 捕获组足够严格，不会误匹配正常文本
- [ ] `encodeURIComponent` / `decodeURIComponent` 标题编解码成对出现
- [ ] rehype-sanitize 白名单使用 HAST camelCase，React props 使用 kebab-case
- [ ] 跳转事件在 `App.tsx` 或目标页面有对应的监听处理
- [ ] CSS 样式在亮色/暗色主题下均可读
- [ ] Skill content 和工具 description 都提示了引用格式
- [ ] `CitationMatch.type` 联合类型已更新

---

## 17. 技能迁移指南：builtin → builtin-tools

当需要将旧的 `builtin/index.ts` 中的技能迁移到 `builtin-tools/` 目录（启用渐进披露）时：

### 迁移步骤

1. **创建独立文件** `skills/builtin-tools/my-skill.ts`，将技能定义从 `builtin/index.ts` 中提取
2. **在 `builtin-tools/index.ts` 中注册**：添加 export + import + 加入 `builtinToolSkills` 数组
3. **从 `builtin/index.ts` 中移除**：删除旧定义 + 从 `builtinSkills` 数组中移除
4. **全局搜索旧导出名**：确认无残留 import

### 迁移影响

| 维度 | 迁移前（`builtinSkills`） | 迁移后（`builtinToolSkills`） |
|------|-------------------------|------------------------------|
| 激活方式 | 用户手动激活（SkillSelector） | LLM 通过 `load_skills` 按需加载 |
| 工具注入时机 | 激活后每次请求都带上 | 首轮只带 `<available_skills>` 目录，按需加载 |
| Token 消耗 | 始终占用 context | 按需加载，减少首轮 token |

### 注意事项

- 迁移后技能的 `embeddedTools` 将通过渐进披露注入，不再需要用户手动激活
- `priority` 字段影响 `<available_skills>` 中的排序
- 如果原技能有 `dependencies`，它们也必须在 `builtinToolSkills` 中

---

## 18. 后端执行器开发规范

### 错误处理模式

所有执行器方法**必须**使用 `Ok(Self::emit_failure(...))` 返回错误，**禁止**使用 `Err(msg)` 或 `?` 操作符传播错误：

```rust
// ✅ 正确：错误走 emit_failure，返回 Ok(ToolResultInfo)
let args: MyArgs = match serde_json::from_value(call.arguments.clone()) {
    Ok(a) => a,
    Err(e) => {
        let msg = format!("参数错误: {}", e);
        return Ok(Self::emit_failure(call, ctx, &msg, start_time));
    }
};

let db = match Self::get_db(ctx) {
    Ok(db) => db,
    Err(e) => return Ok(Self::emit_failure(call, ctx, &e, start_time)),
};

// ❌ 错误：使用 ? 操作符
let args: MyArgs = serde_json::from_value(call.arguments.clone())
    .map_err(|e| { ... msg })?;  // 会跳过 emit_end/error，前端块卡在 running
```

**原因**：`Err(String)` 返回到 `ToolExecutorRegistry.execute()` 后，会被当作执行器级别崩溃处理，不会触发 `emit_end`/`emit_error` 事件，导致：
- 前端工具块永远卡在 `running` 状态
- `save_tool_block()` 不被调用，防闪退持久化失效
- LLM 收不到工具错误结果，可能无限重试

### 敏感等级选择

| 操作类型 | 等级 | 理由 |
|---------|------|------|
| 只读（list/get/search/preview） | `Low` | 无副作用 |
| 写入（create/update/fork） | `Medium` | 可撤销/可覆盖 |
| 删除（delete/reset） | `High` | 不可撤销 |

### 工具名前缀处理

所有执行器的 `can_handle` 方法必须通过 `strip_namespace` 去除 `builtin-` 和 `mcp_` 前缀后匹配：

```rust
fn strip_namespace(tool_name: &str) -> &str {
    tool_name
        .strip_prefix("builtin-")
        .or_else(|| tool_name.strip_prefix("mcp_"))
        .unwrap_or(tool_name)
}
```

---

## 附录：文件索引

### 前端核心

| 路径 | 职责 |
|------|------|
| `registry/blockRegistry.ts` | 块渲染注册表 |
| `registry/eventRegistry.ts` | 事件处理注册表 |
| `registry/modeRegistry.ts` | 模式注册表 |
| `components/BlockRenderer.tsx` | 块渲染分发器 |
| `components/MessageItem.tsx` | 消息项组件 |
| `components/MessageList.tsx` | 消息列表 |
| `core/middleware/eventBridge.ts` | 事件桥接 |
| `core/store/createChatStore.ts` | Store 创建 |
| `adapters/TauriAdapter.ts` | Tauri 适配器 |

### 前端插件

| 路径 | 职责 |
|------|------|
| `plugins/blocks/*.tsx` | 块渲染插件 |
| `plugins/events/*.ts` | 事件处理插件 |
| `plugins/modes/*.ts` | 模式插件 |

### 前端组件

| 路径 | 职责 |
|------|------|
| `components/ActivityTimeline/` | 活动时间线 |
| `components/panels/` | 来源面板 |
| `components/renderers/` | Markdown 渲染器 |
| `components/Variant/` | 变体系统 |
| `workspace/` | 工作区前端 |

### 后端

| 路径 | 职责 |
|------|------|
| `chat_v2/pipeline.rs` | 处理管道 |
| `chat_v2/events.rs` | 事件发射 |
| `chat_v2/database.rs` | 数据库连接 |
| `chat_v2/repo.rs` | 数据仓库 |
| `chat_v2/tools/*.rs` | 工具执行器 |
| `chat_v2/workspace/*.rs` | 工作区后端 |

---

*最后更新：2026-02-09（含引用跳转/技能迁移/执行器规范）*

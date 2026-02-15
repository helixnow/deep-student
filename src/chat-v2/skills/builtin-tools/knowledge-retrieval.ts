/**
 * 知识检索技能组
 *
 * 包含统一本地搜索和网络搜索工具
 *
 * ★ 2026-01: graph_search 已废弃（知识图谱模块已移除）
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const knowledgeRetrievalSkill: SkillDefinition = {
  id: 'knowledge-retrieval',
  name: 'knowledge-retrieval',
  description: '知识检索能力组，包含统一本地搜索和网络搜索工具。当用户需要查询知识库、图片/PDF、用户记忆或获取网络信息时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://knowledge-retrieval',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 知识检索技能

当你需要查找信息时，请根据信息来源和类型选择合适的检索工具：

## 搜索工具使用指南

### 本地搜索（优先使用）
使用 \`builtin-unified_search\` 搜索所有本地知识，包括：
- **知识库文档**（笔记、教材、翻译等文本内容）
- **图片和PDF页面**（扫描件、截图、PDF图片）
- **用户记忆**（个人偏好、知识笔记、学习经历）

一次调用即可获取所有相关内容，无需分别搜索。

### 网络搜索（补充使用）
当本地知识库没有答案，或需要获取实时/最新信息时，使用 \`builtin-web_search\`。

### 搜索策略
1. **默认先用 \`builtin-unified_search\`** 搜索本地知识
2. 如果本地结果不足或用户明确要求网上查找，再用 \`builtin-web_search\`
3. 可以同时调用两个工具以并行获取结果
4. 使用 resource_ids 参数可精确搜索特定文档
5. 使用 max_per_resource 参数可避免单一文档占满结果

## 读取完整文档

检索结果包含 **readResourceId**（推荐）、**sourceId**、**resourceId** 字段。读取完整文档时优先使用 **readResourceId**：

\`\`\`
1. unified_search(查询) → 获得 readResourceId: "note_abc123"
2. resource_read(resource_id: "note_abc123") → 完整文档内容
\`\`\`

### 按页读取（PDF/教材/文件）

对于多页文档，首次全量读取会返回 **totalPages**。后续可用 **page_start/page_end** 按需读取特定页，节省 token：

\`\`\`
1. resource_read(resource_id: "tb_xxx") → 全文 + totalPages: 118
2. resource_read(resource_id: "tb_xxx", page_start: 56, page_end: 57) → 只返回第 56-57 页
\`\`\`

## 图片引用指南（必读）

检索结果可能包含来自 PDF/教材的页面图片（resourceId + pageIndex 字段），展示时请遵循以下规则：

### 引用格式
- \`[知识库-N]\` — 引用知识库文本来源
- \`[图片-N]\` — 引用多模态图片来源
- \`[记忆-N]\` — 引用用户记忆来源
- \`[搜索-N]\` — 引用网络搜索来源
- \`[知识库-N:图片]\` / \`[图片-N:图片]\` — 渲染对应 PDF 页面图片

### ⚠️ 强制自动渲染规则（第一优先级）
**当搜索结果中存在 pageIndex 字段（值不为 null）时，你必须在回复中立即使用 \`[知识库-N:图片]\` 格式渲染至少 1 张最相关的图片。**

❌ 错误做法：只用纯文本引用 \`[知识库-1]\`，不渲染图片
✅ 正确做法：使用 \`[知识库-1:图片]\` 直接在回复中渲染图片

### 图片渲染示例
搜索返回 pageIndex 不为 null 的结果时，正确的回复格式：

\`\`\`
根据搜索结果，我找到了相关内容：

[知识库-1:图片]

上图展示了 XXX 的核心概念...
\`\`\`

### 重要：已有结果可直接引用
**如果之前的搜索结果已包含 pageIndex 字段，用户要求看图时，直接使用 \`[知识库-N:图片]\` 引用已有结果即可，无需重新搜索。**

### 何时再次调用 unified_search
- 需要搜索**新的图片内容**（如"帮我找一张关于 XX 的图"）
- 之前的搜索结果**没有 pageIndex**，但用户需要图片

### 必须遵守的规则
1. **立即自动渲染**：搜索结果有 pageIndex 时，**第一轮回复必须使用 \`[知识库-N:图片]\` 渲染 1-3 张最相关页面**，不要等用户要求
2. **精选展示**：优先选择与问题最相关的结果进行图片渲染
3. **禁止操作**：不要输出图片 URL 或 Markdown 图片语法（如 \`![](url)\`）
4. **纯文本补充**：其余引用可使用 \`[知识库-N]\` 仅显示角标
`,
  embeddedTools: [
    {
      name: 'builtin-unified_search',
      description: '统一搜索：同时搜索知识库文档、图片/PDF、用户记忆，合并返回最相关结果。这是默认的搜索工具，一次调用即可获取所有本地知识。\n\n**返回的 ID 字段说明**：每条结果包含 readResourceId（DSTU 格式，如 note_xxx/tb_xxx）、sourceId、resourceId（VFS UUID）。调用 resource_read 时传 readResourceId（优先）或 sourceId，不要传 resourceId（VFS UUID 格式）。调用 memory_read 时传记忆结果的 noteId 字段。\n\n引用方式：[知识库-N] 引用文本，[图片-N] 引用图片，[记忆-N] 引用记忆。pageIndex 不为空时可用 [知识库-N:图片]/[图片-N:图片] 渲染页面图片。',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '【必填】搜索查询文本，描述你想找的信息',
          },
          folder_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '限制搜索的文件夹 ID 列表（可选，不填则搜索所有文件夹）',
          },
          resource_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '限制搜索的资源 ID 列表（可选，精确到特定资源）',
          },
          resource_types: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['note', 'textbook', 'file', 'image', 'exam', 'essay', 'translation', 'mindmap'],
            },
            description: '限制搜索的资源类型列表（可选）',
          },
          top_k: {
            type: 'integer',
            description: '每种搜索源返回的最大结果数（可选，默认 10）。注意：此参数名为 top_k，不是 limit 或 max_results。',
            default: 10,
            minimum: 1,
            maximum: 30,
          },
          max_per_resource: {
            type: 'integer',
            description: '每个资源最多返回的片段数（0表示不限制），用于避免单个资源占据过多结果',
            default: 0,
            minimum: 0,
          },
          enable_reranking: {
            type: 'boolean',
            description: '是否启用重排序优化结果质量，默认启用',
            default: true,
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'builtin-web_search',
      description: '搜索互联网获取最新信息。当本地知识库没有答案，或需要获取实时信息时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '【必填】搜索查询文本' },
          engine: { type: 'string', description: '搜索引擎', enum: ['google_cse', 'serpapi', 'tavily', 'brave', 'searxng', 'zhipu', 'bocha'], default: 'google_cse' },
          top_k: { type: 'integer', description: '返回的结果数量（可选，默认 5）。注意：此参数名为 top_k，不是 limit 或 max_results。', default: 5, minimum: 1, maximum: 20 },
        },
        required: ['query'],
      },
    },
  ],
};

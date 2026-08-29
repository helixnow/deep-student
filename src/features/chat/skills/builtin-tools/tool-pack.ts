/**
 * ToolPack 并行工具包技能
 *
 * 允许 AI agent 在一次调用中并行执行多个内置工具。
 * 用于需要同时从多个数据源获取数据的场景（如同时检索知识库、文件系统、外部 API）。
 *
 * @see docs/design/29-ChatV2-Agent能力增强改造方案.md
 */

import type { SkillDefinition } from '../types';

export const toolPackSkill: SkillDefinition = {
  id: 'tool-pack',
  name: 'tool-pack',
  description: 'ToolPack 并行工具包能力，允许在一次调用中并行执行多个内置工具并汇总结果。当需要同时查询多个数据源时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 1,
  location: 'builtin',
  sourcePath: 'builtin://tool-pack',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# ToolPack 并行工具包

使用 \`builtin-tool_pack\` 工具在一次调用中并行执行多个内置工具：你可以同时查询知识库、搜索网络、读取文件等，结果会汇总后一起返回。

## 使用说明

- **builtin-tool_pack**: 并行执行多个工具，提供 tools 数组和可选的 timeout 参数。

## 工具参数格式

### builtin-tool_pack

并行执行多个内置工具：

\`\`\`json
{
  "tools": [
    { "name": "builtin-rag_search", "args": { "query": "什么是RAG?" } },
    { "name": "builtin-web_search", "args": { "query": "RAG latest research 2024" } },
    { "name": "builtin-web_fetch", "args": { "url": "https://example.com/rag-paper" } }
  ],
  "timeout": 300
}
\`\`\`

**参数说明**：
- \`tools\`: 要并行执行的工具数组（必填），每个元素包含:
  - \`name\`: 工具名称（必填），支持前缀（builtin-）或无前缀形式
  - \`args\`: Required arguments object. Use {} when the sub-tool has no arguments.
- \`timeout\`: 整体超时时间（秒），默认 300 秒，范围 1-600 秒

**限制**：
- 最多支持 20 个子工具
- 最多 10 个同时执行（Semaphore 控制）
- 不能递归调用 tool_pack

**结果**：
返回包含所有子工具执行结果的汇总 JSON，格式：
\`\`\`json
{
  "total_ms": 2500,
  "succeeded": 2,
  "failed": 1,
  "results": [
    { "tool_name": "builtin-rag_search", "success": true, "output": ..., "duration_ms": 1200 },
    { "tool_name": "builtin-web_search", "success": true, "output": ..., "duration_ms": 800 },
    { "tool_name": "builtin-web_fetch", "success": false, "error": "...", "duration_ms": 500 }
  ]
}
\`\`\`

## 注意事项

1. 敏感工具（需要用户审批的）不能在 tool_pack 中执行
2. tool_pack 不能递归调用自身
3. 如果一个子工具失败，不会影响其他子工具的执行
`,
  embeddedTools: [
    {
      name: 'builtin-tool_pack',
      description: 'Runs multiple built-in tools in parallel through the Rust backend executor.',
      inputSchema: {
        type: 'object',
        properties: {
          tools: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  description: 'Built-in tool name, e.g. builtin-rag_search',
                },
                args: {
                  type: 'object',
                  description: 'Arguments object; use {} when the sub-tool has none.',
                },
              },
              required: ['name', 'args'],
            },
            description: 'Tool calls to execute in parallel',
            minItems: 1,
            maxItems: 20,
          },
          timeout: {
            type: 'integer',
            description: 'Pack-level timeout in seconds (default 300).',
            minimum: 1,
            maximum: 600,
          },
        },
        required: ['tools'],
      },
    },
  ],
};

/**
 * PPTX 演示文稿读写技能组
 *
 * 提供完整的 PPTX 演示文稿读写能力，基于 pptx-to-md（读取）+ ppt-rs（写入）：
 * - 结构化读取（Markdown 输出）
 * - 演示文稿信息
 * - PPTX 生成（从 JSON spec 创建）
 * - round-trip 编辑（spec 互转）
 * - 文本查找替换
 */

import type { SkillDefinition } from '../types';

export const pptxToolsSkill: SkillDefinition = {
  id: 'pptx-tools',
  name: 'pptx-tools',
  description:
    'PPTX 演示文稿读写编辑能力组，支持结构化读取、PPTX 文件生成、round-trip 编辑和文本替换。' +
    '当用户需要分析/创建/编辑 PowerPoint 演示文稿时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 5,
  location: 'builtin',
  sourcePath: 'builtin://pptx-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# PPTX 演示文稿读写技能

当用户需要处理 PowerPoint (.pptx) 演示文稿时，使用这些工具：

## 工具选择指南

### 读取类
- **builtin-pptx_read_structured**: 结构化读取 PPTX，输出 Markdown 格式（保留标题/要点/文本）
- **builtin-pptx_get_metadata**: 读取演示文稿信息（幻灯片数量等）

### 写入类
- **builtin-pptx_create**: 从 JSON spec 生成格式化 PPTX 文件并保存到用户的学习资源

### 编辑类
- **builtin-pptx_to_spec**: 将已有 PPTX 转换为 JSON spec（与 pptx_create 互逆，实现 round-trip 编辑）
- **builtin-pptx_replace_text**: 在已有 PPTX 中执行批量文本查找替换，保存为新文件

## resource_id 获取方式

用户上传的文件会以 \`<attachment name="..." source_id="att_xxx" ...>\` 标签注入。
**\`source_id\` 属性值即为工具所需的 \`resource_id\` 参数。**

## 典型场景

1. 用户说"分析这个 PPT 的内容" → pptx_read_structured
2. 用户说"这个 PPT 有几页" → pptx_get_metadata
3. 用户说"帮我做一份 PPT" → pptx_create（无需 resource_id）
4. 用户说"修改这个 PPT" → pptx_to_spec → 修改 spec → pptx_create
5. 用户说"把 PPT 里的 XXX 替换为 YYY" → pptx_replace_text

## pptx_create spec 格式说明

spec 是一个 JSON 对象，包含 title 和 slides 数组：
\`\`\`json
{
  "title": "演示文稿标题",
  "slides": [
    { "type": "title", "title": "欢迎页", "subtitle": "副标题" },
    { "type": "content", "title": "要点页", "bullets": ["要点1", "要点2", "要点3"] },
    { "type": "table", "title": "数据页", "headers": ["列1","列2"], "rows": [["a","b"],["c","d"]] },
    { "type": "blank", "title": "自由页" }
  ]
}
\`\`\`

支持的幻灯片类型：
- **title**: 标题页（title + subtitle）
- **content**: 内容页（title + bullets 要点列表）
- **table**: 表格页（title + headers + rows）
- **blank**: 空白页（仅 title）
`,
  embeddedTools: [
    {
      name: 'builtin-pptx_read_structured',
      description:
        '结构化读取 PPTX 演示文稿，输出 Markdown 格式。保留幻灯片标题和文本要点。' +
        '当用户需要了解 PPT 内容时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】PPTX 文件的资源 ID（如 file_xxx）。可通过 resource_list 或 attachment_list 获取。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-pptx_get_metadata',
      description:
        '读取 PPTX 演示文稿的基本信息：幻灯片数量、内容长度等。' +
        '当用户询问"这个 PPT 有几页"时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】PPTX 文件的资源 ID（如 file_xxx）。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-pptx_to_spec',
      description:
        '将已有 PPTX 演示文稿转换为 JSON spec 格式（与 pptx_create 互逆）。' +
        '返回的 spec 可被修改后传给 pptx_create 生成新文件，实现 round-trip 编辑闭环。' +
        '当用户要求"修改这个 PPT"时，先用此工具读取结构。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】PPTX 文件的资源 ID（如 file_xxx）。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-pptx_replace_text',
      description:
        '在已有 PPTX 演示文稿中执行批量文本查找替换，保存为新文件。' +
        '当用户要求"把 PPT 里的 XXX 替换为 YYY"时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: '【必填】源 PPTX 文件的资源 ID。',
          },
          replacements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                find: { type: 'string', description: '要查找的文本' },
                replace: { type: 'string', description: '替换为的文本' },
              },
              required: ['find', 'replace'],
            },
            description: '【必填】替换对数组，每项包含 find 和 replace 字段。',
          },
          file_name: {
            type: 'string',
            description: '替换后的文件名（含 .pptx 后缀），默认 "edited.pptx"',
            default: 'edited.pptx',
          },
        },
        required: ['resource_id', 'replacements'],
      },
    },
    {
      name: 'builtin-pptx_create',
      description:
        '从 JSON spec 生成格式化的 PPTX 演示文稿文件并保存到用户的学习资源。' +
        '支持标题页、内容页（要点列表）、表格页、空白页。' +
        '当用户要求"帮我做一份 PPT"、"生成演示文稿"时使用。' +
        '生成成功后返回文件 ID，用户可在学习资源中查看和下载。',
      inputSchema: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description:
              '【必填】演示文稿规格 JSON，包含 title 和 slides 数组。' +
              'slides 支持类型：title/content/table/blank。',
          },
          file_name: {
            type: 'string',
            description: '生成的文件名（含 .pptx 后缀），默认 "generated.pptx"',
            default: 'generated.pptx',
          },
          folder_id: {
            type: 'string',
            description: '可选：保存到的文件夹 ID。不指定则保存到根目录。',
          },
        },
        required: ['spec'],
      },
    },
  ],
};

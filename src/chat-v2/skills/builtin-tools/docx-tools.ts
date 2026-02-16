/**
 * DOCX 文档读写技能组
 *
 * 提供完整的 DOCX 文档读写能力，基于 docx-rs crate：
 * - 结构化读取（保留标题/表格/列表/超链接/格式）
 * - 表格提取（结构化 JSON）
 * - 文档属性读取（作者/标题/创建时间）
 * - DOCX 生成（从 JSON spec 创建格式化文档）
 *
 * @see docs/design/docx-tools-design.md
 */

import type { SkillDefinition } from '../types';

export const docxToolsSkill: SkillDefinition = {
  id: 'docx-tools',
  name: 'docx-tools',
  description:
    'DOCX 文档读写编辑能力组，支持结构化读取、表格提取、元数据查询、DOCX 文件生成、round-trip 编辑和文本替换。' +
    '当用户需要分析/创建/编辑 Word 文档时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 5,
  location: 'builtin',
  sourcePath: 'builtin://docx-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# DOCX 文档读写技能

当用户需要处理 Word (.docx) 文档时，使用这些工具：

## 工具选择指南

### 读取类
- **builtin-docx_read_structured**: 结构化读取 DOCX，输出富 Markdown（保留标题/表格/列表/超链接/粗体/斜体/图片占位）
- **builtin-docx_extract_tables**: 专门提取 DOCX 中的所有表格为结构化 JSON 数组
- **builtin-docx_get_metadata**: 读取文档属性（标题/作者/创建时间/修改时间）

### 写入类
- **builtin-docx_create**: 从 JSON spec 生成格式化 DOCX 文件并保存到用户的学习资源

### 编辑类
- **builtin-docx_to_spec**: 将已有 DOCX 转换为 JSON spec（与 docx_create 互逆，实现 round-trip 编辑）
- **builtin-docx_replace_text**: 在已有 DOCX 中执行批量文本查找替换，保存为新文件

## resource_id 获取方式

用户上传的文件会以 \`<attachment name="..." source_id="att_xxx" ...>\` 标签注入。
**\`source_id\` 属性值即为工具所需的 \`resource_id\` 参数。**

当 docx_create 或 docx_replace_text 成功后，返回的 \`file_id\` 可作为后续工具调用的 \`resource_id\`（例如对新文件继续编辑）。

## 典型场景

1. 用户说"分析这个 Word 文件的结构" → 从 \`<attachment source_id="...">\` 取 resource_id → docx_read_structured
2. 用户说"把文档里的表格提取出来" → docx_extract_tables
3. 用户说"这份文档谁写的" → docx_get_metadata
4. 用户说"帮我生成一份 Word 报告" → 用 docx_create（无需 resource_id）
5. 用户说"把笔记导出为 Word" → 先读取笔记内容，再用 docx_create 生成
6. 用户说"修改这个 Word 文档的内容" → docx_to_spec 转换 → 修改 spec → docx_create 生成新文件
7. 用户说"把文档里的 XXX 替换为 YYY" → docx_replace_text
8. 用户说"基于这个模板生成新文档" → docx_to_spec 读取模板 → 修改 spec → docx_create

## docx_create spec 格式说明

spec 是一个 JSON 对象，包含 title（可选）和 blocks 数组：
\`\`\`json
{
  "title": "文档标题",
  "blocks": [
    { "type": "heading", "level": 1, "text": "一级标题" },
    { "type": "heading", "level": 2, "text": "二级标题" },
    { "type": "paragraph", "text": "正文内容", "bold": false, "italic": false, "alignment": "left" },
    { "type": "table", "rows": [["表头1","表头2"],["数据1","数据2"]] },
    { "type": "list", "ordered": true, "items": ["第一项","第二项","第三项"] },
    { "type": "list", "ordered": false, "items": ["无序项1","无序项2"] },
    { "type": "code", "text": "代码内容" },
    { "type": "pagebreak" }
  ]
}
\`\`\`

支持的 block 类型：
- **heading**: 标题（level 1-6）
- **paragraph**: 段落（支持 bold/italic/alignment）
- **table**: 表格（rows 为二维字符串数组）
- **list**: 列表（ordered=true 有序，false 无序）
- **code**: 代码块（等宽字体）
- **pagebreak**: 分页符

alignment 可选值：left / center / right / justify
`,
  embeddedTools: [
    {
      name: 'builtin-docx_read_structured',
      description:
        '结构化读取 DOCX 文档，输出富 Markdown 格式。保留标题层级、表格（Markdown 表格）、' +
        '有序/无序列表、超链接、粗体/斜体/删除线格式、图片占位符。' +
        '比普通的 resource_read 提供更丰富的文档结构信息。' +
        '当用户需要深入分析 Word 文档内容、理解文档结构时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】DOCX 文件的资源 ID（如 file_xxx）。可通过 resource_list 或 attachment_list 获取。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-docx_extract_tables',
      description:
        '专门提取 DOCX 文档中的所有表格，返回结构化 JSON 数组。' +
        '每个表格是一个二维字符串数组（行×列）。' +
        '当用户需要分析文档中的表格数据、将表格导出为其他格式时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】DOCX 文件的资源 ID（如 file_xxx）。可通过 resource_list 或 attachment_list 获取。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-docx_get_metadata',
      description:
        '读取 DOCX 文档的属性信息：标题、主题、作者、描述、最后修改者、创建时间、修改时间。' +
        '当用户询问"这份文档谁写的"、"文档什么时候创建的"时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】DOCX 文件的资源 ID（如 file_xxx）。可通过 resource_list 或 attachment_list 获取。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-docx_to_spec',
      description:
        '将已有 DOCX 文档转换为 JSON spec 格式（与 docx_create 互逆）。' +
        '返回的 spec 可被 LLM 修改后传给 docx_create 生成新文件，实现 round-trip 编辑闭环。' +
        '当用户要求"修改这个 Word 文件"、"基于模板生成"时，先用此工具读取结构。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】DOCX 文件的资源 ID（如 file_xxx）。可通过 resource_list 或 attachment_list 获取。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-docx_replace_text',
      description:
        '在已有 DOCX 文档中执行批量文本查找替换，保存为新文件。' +
        '支持多组替换对，同时替换标题、正文段落和表格中的文本。' +
        '当用户要求"把文档里的 XXX 替换为 YYY"时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】源 DOCX 文件的资源 ID。',
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
            description: '替换后的文件名（含 .docx 后缀），默认 "edited.docx"',
            default: 'edited.docx',
          },
        },
        required: ['resource_id', 'replacements'],
      },
    },
    {
      name: 'builtin-docx_create',
      description:
        '从 JSON spec 生成格式化的 DOCX 文件并保存到用户的学习资源。' +
        '支持标题（6级）、段落（粗体/斜体/对齐）、表格、有序/无序列表、代码块、分页符。' +
        '当用户要求"生成 Word 文件"、"导出为 Word"、"写一份报告"时使用。' +
        '生成成功后返回文件 ID，用户可在学习资源中查看和下载。',
      inputSchema: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description:
              '【必填】文档规格 JSON，包含 title（可选）和 blocks 数组。' +
              'blocks 支持类型：heading/paragraph/table/list/code/pagebreak。',
          },
          file_name: {
            type: 'string',
            description: '生成的文件名（含 .docx 后缀），默认 "generated.docx"',
            default: 'generated.docx',
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

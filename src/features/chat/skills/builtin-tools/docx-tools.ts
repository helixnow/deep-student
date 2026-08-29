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
        '结构化读取 DOCX，输出富 Markdown：保留标题层级、表格、列表、超链接、粗体/斜体/删除线、图片占位符，' +
        '比 resource_read 更完整，用于深入分析文档结构。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'DOCX 资源 ID，可经 resource_list 或 attachment_list 获取。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-docx_extract_tables',
      description: '提取 DOCX 中所有表格为 JSON 数组，每个表格是二维字符串数组（行×列）。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'DOCX 资源 ID。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-docx_get_metadata',
      description: '读取 DOCX 属性：标题、主题、作者、描述、最后修改者、创建/修改时间。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'DOCX 资源 ID。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-docx_to_spec',
      description:
        '将已有 DOCX 转为 JSON spec（与 docx_create 互逆）；修改 spec 后再 docx_create 即完成 round-trip 编辑，也适用于"基于模板生成"。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'DOCX 资源 ID。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-docx_replace_text',
      description: '批量查找替换文本（标题、正文与表格）并保存为新文件。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: '源 DOCX 资源 ID。',
          },
          replacements: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                find: { type: 'string', description: '查找文本' },
                replace: { type: 'string', description: '替换文本' },
              },
              required: ['find', 'replace'],
            },
            description: '替换对数组。',
          },
          file_name: {
            type: 'string',
            description: '输出文件名（含 .docx 后缀）',
            default: 'edited.docx',
          },
          output_target: {
            type: 'string', enum: ['vfs', 'workspace'], default: 'vfs',
            description: 'vfs=学习资源；workspace=已授权读写工作区。',
          },
          root_id: { type: 'string', enum: ['workspace'], description: 'workspace 输出时必填。' },
          relative_path: { type: 'string', description: 'workspace 内相对路径，禁止绝对路径与 ..。' },
          overwrite_policy: {
            type: 'string', enum: ['fail', 'replace_if_match'], default: 'fail',
            description: '覆盖已有文件须用 replace_if_match。',
          },
          expected_sha256: { type: 'string', description: 'replace_if_match 必填：目标文件当前 SHA-256。' },
        },
        required: ['resource_id', 'replacements'],
      },
    },
    {
      name: 'builtin-docx_create',
      description:
        '从 JSON spec 生成格式化 DOCX（标题 6 级、段落粗体/斜体/对齐、表格、列表、代码块、分页符），默认存学习资源，也可写入已授权 workspace。' +
        '返回 TaskObjectHandle；workspace 输出附带可撤销的 mutation receipt/change set。',
      inputSchema: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description:
              '文档规格 JSON：title（可选）+ blocks 数组，block 类型 heading/paragraph/table/list/code/pagebreak。',
          },
          file_name: {
            type: 'string',
            description: '生成文件名（含 .docx 后缀）',
            default: 'generated.docx',
          },
          folder_id: {
            type: 'string',
            description: '保存目标文件夹 ID，缺省为根目录。',
          },
          output_target: {
            type: 'string', enum: ['vfs', 'workspace'], default: 'vfs',
            description: 'vfs=学习资源；workspace=已授权读写工作区。',
          },
          root_id: { type: 'string', enum: ['workspace'], description: 'workspace 输出时必填。' },
          relative_path: { type: 'string', description: 'workspace 内相对路径，禁止绝对路径与 ..。' },
          overwrite_policy: {
            type: 'string', enum: ['fail', 'replace_if_match'], default: 'fail',
            description: '覆盖已有文件须用 replace_if_match。',
          },
          expected_sha256: { type: 'string', description: 'replace_if_match 必填：目标文件当前 SHA-256。' },
        },
        required: ['spec'],
      },
    },
  ],
};

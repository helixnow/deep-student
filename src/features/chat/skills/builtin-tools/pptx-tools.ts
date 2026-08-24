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
    'PPTX 演示文稿读写编辑能力组，支持结构化读取、表格提取、元数据查询、PPTX 文件生成、round-trip 编辑和文本替换。' +
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
- **builtin-pptx_get_metadata**: 读取演示文稿信息（精确幻灯片数量、文本总长度）
- **builtin-pptx_extract_tables**: 提取 PPTX 中所有表格为结构化 JSON

### 写入类
- **builtin-pptx_create**: 从 JSON spec 生成格式化 PPTX 文件并保存到用户的学习资源

### 编辑类
- **builtin-pptx_to_spec**: 将已有 PPTX 转换为 JSON spec（与 pptx_create 互逆，实现 round-trip 编辑）
- **builtin-pptx_replace_text**: 在已有 PPTX 中执行批量文本查找替换，保存为新文件

## resource_id 获取方式

用户上传的文件会以 \`<attachment name="..." source_id="att_xxx" ...>\` 标签注入。
**\`source_id\` 属性值即为工具所需的 \`resource_id\` 参数。**

## 典型场景

1. 用户说“分析这个 PPT 的内容” → pptx_read_structured
2. 用户说“这个 PPT 有几页” → pptx_get_metadata
3. 用户说“提取 PPT 中的表格” → pptx_extract_tables
4. 用户说“帮我做一份 PPT” → pptx_create（无需 resource_id）
5. 用户说“修改这个 PPT” → pptx_to_spec → 修改 spec → pptx_create
6. 用户说“把 PPT 里的 XXX 替换为 YYY” → pptx_replace_text

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
      description: '结构化读取 PPTX，输出 Markdown，保留幻灯片标题和文本要点。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'PPTX 资源 ID，可经 resource_list 或 attachment_list 获取。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-pptx_get_metadata',
      description: '读取 PPTX 基本信息：精确幻灯片数量、文本总长度。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'PPTX 资源 ID。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-pptx_extract_tables',
      description:
        '提取 PPTX 中所有表格为 JSON 数组，每个表格含所在幻灯片标题、表头、数据行、行列数。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'PPTX 资源 ID。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-pptx_to_spec',
      description:
        '将已有 PPTX 转为 JSON spec（与 pptx_create 互逆）；修改 spec 后再 pptx_create 即完成 round-trip 编辑。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'PPTX 资源 ID。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-pptx_replace_text',
      description: '批量查找替换 PPTX 中的文本，保存为新文件。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: '源 PPTX 资源 ID。',
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
            description: '输出文件名（含 .pptx 后缀）',
            default: 'edited.pptx',
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
      name: 'builtin-pptx_create',
      description:
        '从 JSON spec 生成格式化 PPTX（标题页/内容页/表格页/空白页），默认存学习资源，也可写入已授权 workspace。' +
        '返回 TaskObjectHandle；workspace 输出附带可撤销的 mutation receipt/change set。',
      inputSchema: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description: '演示文稿规格 JSON：title + slides 数组，slide 类型 title/content/table/blank。',
          },
          file_name: {
            type: 'string',
            description: '生成文件名（含 .pptx 后缀）',
            default: 'generated.pptx',
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

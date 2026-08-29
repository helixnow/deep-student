/**
 * XLSX 电子表格读写技能组
 *
 * 提供完整的 XLSX 电子表格读写能力，基于 calamine（读取）+ umya-spreadsheet（写入/编辑）：
 * - 结构化读取
 * - 表格提取（结构化 JSON）
 * - XLSX 生成（从 JSON spec 创建）
 * - round-trip 编辑（spec 互转）
 * - 单元格编辑
 * - 文本查找替换
 */

import type { SkillDefinition } from '../types';

export const xlsxToolsSkill: SkillDefinition = {
  id: 'xlsx-tools',
  name: 'xlsx-tools',
  description:
    'XLSX 电子表格读写编辑能力组，支持结构化读取、表格提取、XLSX 文件生成、round-trip 编辑、单元格编辑和文本替换。' +
    '当用户需要分析/创建/编辑 Excel 电子表格时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 5,
  location: 'builtin',
  sourcePath: 'builtin://xlsx-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# XLSX 电子表格读写技能

当用户需要处理 Excel (.xlsx) 电子表格时，使用这些工具：

## 工具选择指南

### 读取类
- **builtin-xlsx_read_structured**: 结构化读取 XLSX，输出文本格式（按工作表分节，行数据制表符分隔）
- **builtin-xlsx_extract_tables**: 提取所有工作表为结构化 JSON（含行列数据）
- **builtin-xlsx_get_metadata**: 读取 XLSX 文件元数据（工作表数量/名称/行列数）

### 写入类
- **builtin-xlsx_create**: 从 JSON spec 生成格式化 XLSX 文件并保存到用户的学习资源

### 编辑类
- **builtin-xlsx_to_spec**: 将已有 XLSX 转换为 JSON spec（与 xlsx_create 互逆，实现 round-trip 编辑）
- **builtin-xlsx_edit_cells**: 直接编辑指定单元格的值，保存为新文件
- **builtin-xlsx_replace_text**: 在已有 XLSX 中执行批量文本查找替换，保存为新文件

## resource_id 获取方式

用户上传的文件会以 \`<attachment name="..." source_id="att_xxx" ...>\` 标签注入。
**\`source_id\` 属性值即为工具所需的 \`resource_id\` 参数。**

## 典型场景

1. 用户说"分析这个 Excel 表格" → xlsx_read_structured 或 xlsx_extract_tables
2. 用户说"这个 Excel 有几个工作表" → xlsx_get_metadata
3. 用户说"帮我生成一个 Excel 表格" → xlsx_create
4. 用户说"把成绩导出为 Excel" → xlsx_create
5. 用户说"修改这个 Excel" → xlsx_to_spec → 修改 spec → xlsx_create
6. 用户说"把 A1 单元格改为 100" → xlsx_edit_cells
7. 用户说"把表格里的 XXX 替换为 YYY" → xlsx_replace_text

## xlsx_create spec 格式说明

spec 是一个 JSON 对象，支持两种格式：

### 多工作表格式
\`\`\`json
{
  "sheets": [
    {
      "name": "Sheet1",
      "headers": ["姓名", "年龄", "城市"],
      "rows": [
        ["张三", "25", "北京"],
        ["李四", "30", "上海"]
      ]
    }
  ]
}
\`\`\`

### 单工作表简写
\`\`\`json
{
  "name": "成绩表",
  "headers": ["学生", "语文", "数学", "英语"],
  "rows": [
    ["张三", "95", "88", "92"],
    ["李四", "82", "95", "88"]
  ]
}
\`\`\`

数字字符串会自动识别并以数字类型写入 Excel。
`,
  embeddedTools: [
    {
      name: 'builtin-xlsx_read_structured',
      description: '结构化读取 XLSX，按工作表分节输出文本，行数据制表符分隔，用于快速了解内容。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'XLSX 资源 ID，可经 resource_list 或 attachment_list 获取。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-xlsx_extract_tables',
      description:
        '提取全部工作表为 JSON：每表含 sheet_name、row_count、col_count、rows 二维数组，用于精确分析数据。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'XLSX 资源 ID。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-xlsx_get_metadata',
      description: '读取 XLSX 元数据：工作表数量、名称及行列数。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'XLSX 资源 ID。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-xlsx_to_spec',
      description:
        '将已有 XLSX 转为 JSON spec（与 xlsx_create 互逆）；修改 spec 后再 xlsx_create 即完成 round-trip 编辑。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: 'XLSX 资源 ID。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-xlsx_edit_cells',
      description: '批量编辑指定单元格的值并保存为新文件，保留原文件其余内容与格式。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: '源 XLSX 资源 ID。',
          },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sheet: {
                  type: 'string',
                  description: '工作表名称',
                  default: 'Sheet1',
                },
                cell: {
                  type: 'string',
                  description: '单元格引用，如 A1',
                },
                value: {
                  type: 'string',
                  description: '新值；数字字符串自动按数字写入',
                },
              },
              required: ['cell', 'value'],
            },
            description: '编辑操作数组。',
          },
          file_name: {
            type: 'string',
            description: '输出文件名（含 .xlsx 后缀）',
            default: 'edited.xlsx',
          },
        },
        required: ['resource_id', 'edits'],
      },
    },
    {
      name: 'builtin-xlsx_replace_text',
      description: '遍历全部工作表批量查找替换文本，保存为新文件。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: '源 XLSX 资源 ID。',
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
            description: '输出文件名（含 .xlsx 后缀）',
            default: 'edited.xlsx',
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
      name: 'builtin-xlsx_create',
      description:
        '从 JSON spec 生成格式化 XLSX（多工作表、表头加粗、数字自动识别），默认存学习资源，也可写入已授权 workspace。' +
        '返回 TaskObjectHandle；workspace 输出附带可撤销的 mutation receipt/change set。',
      inputSchema: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description:
              '表格规格 JSON：多工作表 {sheets:[{name,headers,rows}]} 或单工作表简写 {name,headers,rows}。',
          },
          file_name: {
            type: 'string',
            description: '生成文件名（含 .xlsx 后缀）',
            default: 'generated.xlsx',
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

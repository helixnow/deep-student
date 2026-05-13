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
      description:
        '结构化读取 XLSX 电子表格，输出文本格式。按工作表分节显示，行数据制表符分隔。' +
        '当用户需要快速了解 Excel 文件内容时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】XLSX 文件的资源 ID（如 file_xxx）。可通过 resource_list 或 attachment_list 获取。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-xlsx_extract_tables',
      description:
        '提取 XLSX 中所有工作表的结构化数据，返回 JSON 格式。' +
        '每个工作表包含 sheet_name、row_count、col_count 和 rows 二维数组。' +
        '当用户需要精确分析表格数据、进行数据处理时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】XLSX 文件的资源 ID（如 file_xxx）。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-xlsx_get_metadata',
      description:
        '读取 XLSX 电子表格的元数据信息：工作表数量、各工作表名称及行列数。' +
        '当用户询问"这个 Excel 有几个工作表"、"表格有多少行"时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】XLSX 文件的资源 ID（如 file_xxx）。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-xlsx_to_spec',
      description:
        '将已有 XLSX 电子表格转换为 JSON spec 格式（与 xlsx_create 互逆）。' +
        '返回的 spec 可被修改后传给 xlsx_create 生成新文件，实现 round-trip 编辑闭环。' +
        '当用户要求"修改这个 Excel"时，先用此工具读取结构。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description:
              '【必填】XLSX 文件的资源 ID（如 file_xxx）。',
          },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-xlsx_edit_cells',
      description:
        '直接编辑 XLSX 中指定单元格的值，保存为新文件。' +
        '支持同时编辑多个单元格，保留原文件的其他内容和格式。' +
        '当用户要求"把 A1 改为 100"、"更新某个单元格"时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: '【必填】源 XLSX 文件的资源 ID。',
          },
          edits: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                sheet: {
                  type: 'string',
                  description: '工作表名称，默认 "Sheet1"',
                  default: 'Sheet1',
                },
                cell: {
                  type: 'string',
                  description: '单元格引用（如 "A1"、"B3"、"C10"）',
                },
                value: {
                  type: 'string',
                  description: '新值（数字字符串会自动识别为数字类型）',
                },
              },
              required: ['cell', 'value'],
            },
            description: '【必填】编辑操作数组，每项包含 sheet（可选）、cell 和 value。',
          },
          file_name: {
            type: 'string',
            description: '编辑后的文件名（含 .xlsx 后缀），默认 "edited.xlsx"',
            default: 'edited.xlsx',
          },
        },
        required: ['resource_id', 'edits'],
      },
    },
    {
      name: 'builtin-xlsx_replace_text',
      description:
        '在已有 XLSX 电子表格中执行批量文本查找替换，保存为新文件。' +
        '遍历所有工作表的所有单元格，替换匹配的文本。' +
        '当用户要求"把表格里的 XXX 替换为 YYY"时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: {
            type: 'string',
            description: '【必填】源 XLSX 文件的资源 ID。',
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
            description: '替换后的文件名（含 .xlsx 后缀），默认 "edited.xlsx"',
            default: 'edited.xlsx',
          },
        },
        required: ['resource_id', 'replacements'],
      },
    },
    {
      name: 'builtin-xlsx_create',
      description:
        '从 JSON spec 生成格式化的 XLSX 电子表格文件并保存到用户的学习资源。' +
        '支持多工作表、表头加粗、数字自动识别。' +
        '当用户要求"生成 Excel 文件"、"导出为表格"、"做一个成绩表"时使用。' +
        '生成成功后返回文件 ID，用户可在学习资源中查看和下载。',
      inputSchema: {
        type: 'object',
        properties: {
          spec: {
            type: 'object',
            description:
              '【必填】表格规格 JSON。支持两种格式：' +
              '1) 多工作表：{sheets: [{name, headers, rows}]}；' +
              '2) 单工作表简写：{name, headers, rows}。',
          },
          file_name: {
            type: 'string',
            description: '生成的文件名（含 .xlsx 后缀），默认 "generated.xlsx"',
            default: 'generated.xlsx',
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

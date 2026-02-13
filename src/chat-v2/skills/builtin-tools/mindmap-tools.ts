/**
 * Chat V2 - 思维导图技能组
 *
 * 专门用于创建和编辑思维导图的技能
 * 前置依赖：learning-resource（提供资源列表、读取等基础能力）
 */

import type { SkillDefinition } from '../types';

export const mindmapToolsSkill: SkillDefinition = {
  id: 'mindmap-tools',
  name: 'mindmap-tools',
  description: '思维导图创建与编辑能力。当用户明确要求创建思维导图、知识导图、脑图时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  location: 'builtin',
  sourcePath: 'builtin://mindmap-tools',
  isBuiltin: true,
  // 前置依赖：需要先加载 learning-resource 技能
  dependencies: ['learning-resource'],
  content: `
# 思维导图技能

你现在拥有创建和编辑思维导图的能力。

## 工作流程

### 创建思维导图

1. **分析用户需求**：理解用户想要的主题和结构
2. **设计节点层级**：
   - 根节点：主题
   - 一级节点：主要分类（3-7个为宜）
   - 子节点：具体内容
3. **丰富视觉表达**（重要！创建时就应该做）：
   - 用 \`bgColor\` 为每个**一级分支设置不同的主题色**，让分支间一目了然
   - 对核心概念/关键节点使用 \`fontWeight: "bold"\` 加粗
   - 为需要补充说明的节点添加 \`note\` 备注
   - 推荐一级分支配色（柔和色系，适配深浅主题）：
     \`"#4FC3F7"\`(蓝) \`"#81C784"\`(绿) \`"#FFB74D"\`(橙) \`"#E57373"\`(红) \`"#BA68C8"\`(紫) \`"#4DB6AC"\`(青) \`"#FFD54F"\`(黄)
4. **调用 builtin-mindmap_create 工具**
5. **在回复中使用版本引用格式**：工具返回结果中包含 \`versionId\`（mv_xxx 格式），使用 \`[思维导图:返回的versionId:标题]\` 引用。版本引用是不可变的，确保每次展示的内容与创建时一致。

### 整体编辑思维导图

当需要重构整棵导图结构时：

1. **获取现有内容**：先用 \`builtin-resource_read\` 读取导图
2. **修改节点结构**：根据用户要求增删改节点
3. **调用 builtin-mindmap_update 工具**：传入完整的新 content

### 细粒度编辑节点（推荐）

当用户要求修改节点属性（颜色、高亮、加粗、备注、挖空、标记完成等），或增删少量节点时，
使用 \`builtin-mindmap_edit_nodes\`，**无需读取完整 JSON**，更高效：

**操作类型**：
- \`update_node\`: 修改节点属性（文本、样式、备注、完成状态、挖空区间等）
- \`add_node\`: 在指定父节点下添加子节点
- \`delete_node\`: 删除节点
- \`move_node\`: 移动节点到新父节点下

**示例 — 将节点设为红色高亮+加粗+添加备注**：
\`\`\`json
{
  "mindmap_id": "mm_xxx",
  "operations": [
    {
      "type": "update_node",
      "node_id": "n1",
      "patch": {
        "style": { "bgColor": "#ff6b6b", "fontWeight": "bold" },
        "note": "这是重点内容"
      }
    }
  ]
}
\`\`\`

**示例 — 批量操作**：
\`\`\`json
{
  "mindmap_id": "mm_xxx",
  "operations": [
    { "type": "update_node", "node_id": "n1", "patch": { "completed": true } },
    { "type": "update_node", "node_id": "n2", "patch": { "style": { "textColor": "#ff0000" } } },
    { "type": "add_node", "parent_id": "n3", "data": { "text": "新子节点" } },
    { "type": "delete_node", "node_id": "n4" }
  ]
}
\`\`\`

## 工具说明

### builtin-mindmap_create

创建新思维导图，必须提供 title 和 content。

**创建示例**（注意：一级分支带颜色 + 关键节点加粗 + 备注）：

\`\`\`json
{
  "title": "Python 基础",
  "content": {
    "version": "1.0",
    "root": {
      "id": "root",
      "text": "Python 基础",
      "style": {"fontWeight": "bold"},
      "children": [
        {"id": "n1", "text": "数据类型", "style": {"bgColor": "#4FC3F7", "fontWeight": "bold"}, "children": [
          {"id": "n1-1", "text": "int / float", "note": "整数和浮点数", "children": []},
          {"id": "n1-2", "text": "str", "note": "不可变序列，支持切片", "style": {"fontWeight": "bold"}, "children": []},
          {"id": "n1-3", "text": "list / tuple", "children": []},
          {"id": "n1-4", "text": "dict / set", "children": []}
        ]},
        {"id": "n2", "text": "控制流", "style": {"bgColor": "#81C784", "fontWeight": "bold"}, "children": [
          {"id": "n2-1", "text": "if / elif / else", "children": []},
          {"id": "n2-2", "text": "for 循环", "note": "可配合 enumerate、zip 使用", "children": []},
          {"id": "n2-3", "text": "while 循环", "children": []},
          {"id": "n2-4", "text": "异常处理", "style": {"fontWeight": "bold"}, "note": "try/except/finally", "children": []}
        ]},
        {"id": "n3", "text": "函数", "style": {"bgColor": "#FFB74D", "fontWeight": "bold"}, "children": [
          {"id": "n3-1", "text": "def 定义", "children": []},
          {"id": "n3-2", "text": "参数类型", "note": "位置参数、关键字参数、*args、**kwargs", "children": []},
          {"id": "n3-3", "text": "lambda 表达式", "children": []},
          {"id": "n3-4", "text": "装饰器", "style": {"fontWeight": "bold"}, "note": "@decorator 语法糖", "children": []}
        ]}
      ]
    },
    "meta": {"createdAt": "2026-01-01T00:00:00Z"}
  }
}
\`\`\`

**节点结构规范**：
- \`id\`: 唯一标识符（如 root, n1, n2, n2-1）
- \`text\`: 节点显示文本
- \`children\`: 子节点数组（无子节点时为空数组 \`[]\`）
- \`note\`: 节点备注（可选，显示在节点文本下方，用于补充说明）
- \`completed\`: 是否标记完成（可选，布尔值，显示为删除线样式）
- \`style\`: 节点样式（可选），包含：
  - \`bgColor\`: 背景色/高亮色（hex 如 "#4FC3F7"）— **创建时一级分支必须设置**
  - \`textColor\`: 文字颜色（hex 如 "#ff0000"）
  - \`fontWeight\`: "bold" 或 "normal" — **关键概念建议加粗**
  - \`fontSize\`: 字体大小（数字，像素值）
- \`blankedRanges\`: 背诵挖空区间（可选），如 [{"start": 0, "end": 3}]

### builtin-mindmap_update

更新已有导图（整体替换），需要 mindmap_id：

\`\`\`json
{
  "mindmap_id": "mm_xxx",
  "title": "新标题（可选）",
  "content": "{...新的完整 MindMapDocument JSON...}"
}
\`\`\`

### builtin-mindmap_edit_nodes

细粒度编辑节点（推荐用于局部修改），无需读取完整 JSON。
详见上方"细粒度编辑节点"章节。

## 引用格式（重要！）

创建或编辑完成后，**必须**在回复中使用引用让用户可以直接点击查看。

**★ 核心规则：始终使用工具返回的 \`versionId\`（mv_xxx 格式）作为引用 ID，不要使用 mm_xxx。**
版本引用（mv_xxx）指向不可变的内容快照，确保每条消息中的引用永远展示该时刻的内容，不会因后续编辑而变化。

- \`[思维导图:mv_xxx:标题]\` - **推荐格式**，使用工具返回的 versionId
- \`[思维导图:mv_xxx]\` - 无标题版本

如果用户要求“对比新旧版本 / 展示某个历史版本”，先调用 \`builtin-mindmap_versions\` 获取版本 ID，再引用对应 \`mv_*\`。
如果用户要求“告诉我具体改了什么 / diff 结果”，调用 \`builtin-mindmap_diff_versions\` 并基于返回的 \`summary/changes\` 解释差异。

**示例回复**（假设 create 工具返回 versionId 为 mv_abc123）：
> 我已为你创建了关于 Python 的知识导图 [思维导图:mv_abc123:Python基础]，包含了基础语法、数据结构和常用库三个主要分支。点击可查看和编辑。

## 最佳实践

1. **控制首次创建规模**（极重要！）：
   - 首次创建时，一级分支 3-5 个，每个一级分支下最多 3-5 个二级节点，二级以下**不展开**
   - 总节点数控制在 **30 个以内**，避免 JSON 过大导致生成失败
   - 如果主题内容多（如"高中生物学"、"数据结构与算法"），先创建**骨架导图**（一级+少量二级），创建成功后再用 \`builtin-mindmap_edit_nodes\` 的 \`add_node\` 逐步补充子节点
2. **节点数量适中**：每层 3-5 个节点最易阅读
3. **层级不宜过深**：建议不超过 3 层
4. **文本简洁**：每个节点文本控制在 10 字以内
5. **ID 命名规范**：使用有意义的前缀（如 n1, n1-1, n1-1-1）
6. **善用样式增强可读性**（创建时就应做到）：
   - 一级分支**必须**设置不同 bgColor 区分类别
   - 核心概念、易错点用 \`fontWeight: "bold"\` 加粗突出
   - 需要补充说明的知识点添加 \`note\` 备注（note 比增加子节点更节省空间）
   - 推荐柔和色板：\`#4FC3F7\` \`#81C784\` \`#FFB74D\` \`#E57373\` \`#BA68C8\` \`#4DB6AC\` \`#FFD54F\`
7. **局部修改用 edit_nodes**：修改颜色/备注/加粗等属性时，优先使用 edit_nodes 而非 update
8. **整体重构用 update**：需要大幅调整结构时，使用 update 传入完整 JSON
`,
  allowedTools: [
    'builtin-mindmap_create',
    'builtin-mindmap_update',
    'builtin-mindmap_delete',
    'builtin-mindmap_edit_nodes',
    'builtin-mindmap_versions',
    'builtin-mindmap_diff_versions',
  ],
  embeddedTools: [
    {
      name: 'builtin-mindmap_create',
      description: '【必须调用】创建知识导图。当用户要求创建思维导图/知识导图/脑图时调用，不要用文本画图。必须提供 title（标题）和 content（内容）两个参数。创建成功后，工具返回 versionId（mv_xxx 格式），在回复中使用 [思维导图:返回的versionId:标题] 格式让用户可点击查看。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '【必填】导图标题，不可为空' },
          description: { type: 'string', description: '导图描述（可选）' },
          content: {
            type: 'object',
            description: 'MindMapDocument 对象',
            properties: {
              version: { type: 'string', description: '版本号，固定为 "1.0"' },
              root: {
                type: 'object',
                description: '根节点',
                properties: {
                  id: { type: 'string', description: '节点ID，根节点使用 "root"' },
                  text: { type: 'string', description: '【必填】节点显示文本' },
                  note: { type: 'string', description: '节点备注（可选）' },
                  completed: { type: 'boolean', description: '是否标记完成（可选）' },
                  style: {
                    type: 'object',
                    description: '节点样式（可选）',
                    properties: {
                      bgColor: { type: 'string', description: '背景色/高亮色（hex）' },
                      textColor: { type: 'string', description: '文字颜色（hex）' },
                      fontSize: { type: 'number', description: '字体大小' },
                      fontWeight: {
                        type: 'string',
                        enum: ['normal', 'bold'],
                        description: '加粗',
                      },
                    },
                  },
                  blankedRanges: {
                    type: 'array',
                    description: '背诵挖空区间（可选）',
                    items: {
                      type: 'object',
                      properties: {
                        start: { type: 'number', description: '起始位置（包含）' },
                        end: { type: 'number', description: '结束位置（不包含）' },
                      },
                      required: ['start', 'end'],
                    },
                  },
                  children: {
                    type: 'array',
                    description: '子节点数组',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string', description: '唯一ID，如 n1, n2, n2-1' },
                        text: { type: 'string', description: '【必填】节点显示文本' },
                        note: { type: 'string', description: '节点备注（可选）' },
                        completed: { type: 'boolean', description: '是否标记完成（可选）' },
                        style: {
                          type: 'object',
                          description: '节点样式（可选）',
                          properties: {
                            bgColor: { type: 'string', description: '背景色/高亮色（hex）' },
                            textColor: { type: 'string', description: '文字颜色（hex）' },
                            fontSize: { type: 'number', description: '字体大小' },
                            fontWeight: {
                              type: 'string',
                              enum: ['normal', 'bold'],
                              description: '加粗',
                            },
                          },
                        },
                        blankedRanges: {
                          type: 'array',
                          description: '背诵挖空区间（可选）',
                          items: {
                            type: 'object',
                            properties: {
                              start: { type: 'number', description: '起始位置（包含）' },
                              end: { type: 'number', description: '结束位置（不包含）' },
                            },
                            required: ['start', 'end'],
                          },
                        },
                        children: { type: 'array', description: '子节点数组' },
                      },
                      required: ['id', 'text', 'children'],
                    },
                  },
                },
                required: ['id', 'text', 'children'],
              },
              meta: {
                type: 'object',
                description: '元数据',
                properties: {
                  createdAt: { type: 'string', description: '创建时间' },
                },
              },
            },
            required: ['version', 'root'],
          },
          folder_id: { type: 'string', description: '存放文件夹 ID（可选）' },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'builtin-mindmap_update',
      description: '更新已有知识导图。需先用 resource_read 获取当前内容，修改后传入完整的新 content。',
      inputSchema: {
        type: 'object',
        properties: {
          mindmap_id: { type: 'string', description: '【必填】导图 ID（mm_xxx 格式）' },
          title: { type: 'string', description: '新标题（可选）' },
          description: { type: 'string', description: '新描述（可选）' },
          content: {
            oneOf: [
              { type: 'string', description: '思维导图内容（JSON 字符串格式）' },
              {
                type: 'object',
                description: '思维导图内容（对象格式，含 root/theme/settings）',
              },
            ],
            description: '新的完整 MindMapDocument 内容（可选，支持 JSON 字符串或对象）',
          },
        },
        required: ['mindmap_id'],
      },
    },
    {
      name: 'builtin-mindmap_delete',
      description: '删除指定的思维导图。此操作会软删除导图及其关联资源。',
      inputSchema: {
        type: 'object',
        properties: {
          mindmap_id: {
            type: 'string',
            description: '【必填】要删除的思维导图 ID（mm_xxx 格式）',
          },
        },
        required: ['mindmap_id'],
      },
    },
    {
      name: 'builtin-mindmap_edit_nodes',
      description:
        '细粒度编辑思维导图节点。支持批量操作：修改节点颜色/高亮/加粗/备注/挖空/完成状态，添加/删除/移动节点。无需传完整 JSON，比 mindmap_update 更高效。需先用 resource_read 获取导图了解节点 ID。',
      inputSchema: {
        type: 'object',
        properties: {
          mindmap_id: {
            type: 'string',
            description: '【必填】导图 ID（mm_xxx 格式）',
          },
          operations: {
            type: 'array',
            description: '批量节点操作列表，按顺序执行',
            items: {
              type: 'object',
              properties: {
                type: {
                  type: 'string',
                  enum: ['update_node', 'add_node', 'delete_node', 'move_node'],
                  description: '操作类型',
                },
                node_id: {
                  type: 'string',
                  description: '目标节点 ID（update_node/delete_node/move_node 必需）',
                },
                parent_id: {
                  type: 'string',
                  description: '父节点 ID（add_node 必需）',
                },
                new_parent_id: {
                  type: 'string',
                  description: '新父节点 ID（move_node 必需）',
                },
                index: {
                  type: 'number',
                  description: '插入位置索引（可选，默认追加到末尾）',
                },
                patch: {
                  type: 'object',
                  description: '更新内容（update_node 使用）',
                  properties: {
                    text: { type: 'string', description: '节点文本' },
                    note: {
                      type: 'string',
                      description: '节点备注。传空字符串 "" 可清除备注',
                    },
                    completed: { type: 'boolean', description: '是否标记完成' },
                    collapsed: { type: 'boolean', description: '是否折叠' },
                    style: {
                      type: 'object',
                      description: '节点样式（与现有 style 合并，不会覆盖未指定的属性）',
                      properties: {
                        bgColor: {
                          type: 'string',
                          description:
                            '背景色/高亮色（hex 如 "#ffeb3b"），传 null 清除',
                        },
                        textColor: {
                          type: 'string',
                          description: '文字颜色（hex 如 "#ff0000"），传 null 清除',
                        },
                        fontSize: { type: 'number', description: '字体大小' },
                        fontWeight: {
                          type: 'string',
                          enum: ['normal', 'bold'],
                          description: '字重：加粗用 "bold"',
                        },
                      },
                    },
                    blankedRanges: {
                      type: 'array',
                      description: '背诵挖空区间。传 [] 可清除所有挖空',
                      items: {
                        type: 'object',
                        properties: {
                          start: {
                            type: 'number',
                            description: '起始字符位置（包含）',
                          },
                          end: {
                            type: 'number',
                            description: '结束字符位置（不包含）',
                          },
                        },
                        required: ['start', 'end'],
                      },
                    },
                  },
                },
                data: {
                  type: 'object',
                  description: '新节点数据（add_node 使用）',
                  properties: {
                    text: { type: 'string', description: '【必填】节点文本' },
                    note: { type: 'string', description: '节点备注' },
                    completed: { type: 'boolean', description: '是否标记完成' },
                    style: {
                      type: 'object',
                      description: '节点样式',
                      properties: {
                        bgColor: { type: 'string', description: '背景色/高亮色（hex）' },
                        textColor: { type: 'string', description: '文字颜色（hex）' },
                        fontSize: { type: 'number', description: '字体大小' },
                        fontWeight: {
                          type: 'string',
                          enum: ['normal', 'bold'],
                          description: '加粗',
                        },
                      },
                    },
                    blankedRanges: {
                      type: 'array',
                      description: '背诵挖空区间',
                      items: {
                        type: 'object',
                        properties: {
                          start: { type: 'number' },
                          end: { type: 'number' },
                        },
                        required: ['start', 'end'],
                      },
                    },
                    children: {
                      type: 'array',
                      description: '子节点数组（可选，支持嵌套创建）',
                    },
                  },
                },
              },
              required: ['type'],
            },
          },
        },
        required: ['mindmap_id', 'operations'],
      },
    },
    {
      name: 'builtin-mindmap_versions',
      description:
        '列出指定思维导图的历史版本。用于让用户查看/对比不同版本并在回复中引用 `mv_*` 版本 ID。',
      inputSchema: {
        type: 'object',
        properties: {
          mindmap_id: {
            type: 'string',
            description: '【必填】导图 ID（mm_xxx 格式）',
          },
          limit: {
            type: 'number',
            description: '返回版本条数（可选，默认 20）',
          },
        },
        required: ['mindmap_id'],
      },
    },
    {
      name: 'builtin-mindmap_diff_versions',
      description:
        '比较思维导图两个版本（或历史版本 vs 当前版本）的结构差异，返回增删改移动节点统计与明细。',
      inputSchema: {
        type: 'object',
        properties: {
          mindmap_id: {
            type: 'string',
            description: '【必填】导图 ID（mm_xxx 格式）',
          },
          from_version_id: {
            type: 'string',
            description: '起始版本 ID（mv_xxx，可选，默认使用最新历史版本）',
          },
          to_version_id: {
            type: 'string',
            description: '目标版本 ID（mv_xxx 或 current，可选，默认 current）',
          },
          detail_limit: {
            type: 'number',
            description: '明细条数上限（可选，默认 20，最大 100）',
          },
        },
        required: ['mindmap_id'],
      },
    },
  ],
};

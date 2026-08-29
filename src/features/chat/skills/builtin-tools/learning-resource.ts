/**
 * 学习资源技能组
 *
 * 包含学习资源列表、读取、搜索等工具
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const learningResourceSkill: SkillDefinition = {
  id: 'learning-resource',
  name: 'learning-resource',
  description: '学习资源只读发现能力组。当用户需要浏览、搜索或读取学习资料（笔记、教材、整卷、作文、翻译、知识导图）时使用；创建文件夹、移动、重命名、删除、恢复、收藏或上传资源请同时加载 dstu-tools。创建/编辑思维导图请加载 mindmap-tools。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://learning-resource',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 学习资源管理技能

当你需要浏览或读取用户的学习资源时，请选择合适的工具：

## 工具选择指南

- **builtin-resource_list**: 列出学习资源，可按类型和文件夹筛选
- **builtin-resource_read**: 读取指定资源的内容（支持按页读取 PDF/教材）
- **builtin-resource_search**: 在资源中全文搜索
- **builtin-folder_list**: 列出文件夹结构，了解资源组织方式

> 💡 如需创建/编辑思维导图，请加载 **mindmap-tools** 技能
> 资源库组织写入（创建文件夹、移动、重命名、删除/恢复、收藏、上传）请加载
> **dstu-tools**；本技能只负责发现与读取。

## 工具参数格式

### builtin-resource_list
列出资源，参数格式：
\`\`\`json
{
  "type": "note",
  "limit": 20
}
\`\`\`
type 可选：note/textbook/file/image/exam/essay/translation/mindmap/all

### builtin-resource_read
读取资源，参数格式：
\`\`\`json
{
  "resource_id": "note_xxx 或 tb_xxx 或 exam_xxx"
}
\`\`\`
**注意**：\`resource_id\` 是必需参数。可通过 resource_list、resource_search，或 unified_search 返回的 \`readResourceId\`（优先）/\`sourceId\`/\`resourceId\` 获取。

**按页读取**（PDF/教材/文件类型）：
\`\`\`json
{
  "resource_id": "tb_xxx",
  "page_start": 56,
  "page_end": 57
}
\`\`\`
首次全量读取会返回 \`totalPages\`，后续可用 page_start/page_end 按需读取特定页，节省 token。

### builtin-resource_search
搜索资源，参数格式：
\`\`\`json
{
  "query": "搜索关键词",
  "top_k": 10
}
\`\`\`
**注意**：\`query\` 是必需参数。

## 资源类型

- **note**: 笔记
- **textbook**: 教材
- **exam**: 整卷识别
- **essay**: 作文批改
- **translation**: 翻译
- **mindmap**: 知识导图
- **file**: 通用文件
- **image**: 图片资源

### builtin-folder_list
列出文件夹，参数格式：
\`\`\`json
{
  "parent_id": "root",
  "include_count": true
}
\`\`\`
parent_id 为空或 "root" 时列出根目录下的文件夹

## 使用建议

1. 先用 folder_list 了解文件夹结构
2. 再用 resource_list 浏览指定文件夹的资源
3. 找到目标后用 resource_read 读取详细内容
4. 不确定在哪个资源时使用 resource_search 搜索
5. 需要组织写入时加载 dstu-tools，使用上述只读结果中的准确 ID/path 执行，再回到本技能复查结果
`,
  embeddedTools: [
    {
      name: 'builtin-resource_list',
      description: '列出用户学习资源，可按类型、文件夹、关键词、收藏筛选，用于浏览用户的学习材料。',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '资源类型', enum: ['note', 'textbook', 'file', 'image', 'exam', 'essay', 'translation', 'mindmap', 'all'], default: 'all' },
          folder_id: { type: 'string', description: '只列出该文件夹下的资源' },
          search: { type: 'string', description: '按标题/名称过滤的关键词' },
          limit: { type: 'integer', description: '返回数量限制。参数名是 limit，不是 max_results/top_k。', default: 20, minimum: 1, maximum: 100 },
          favorites_only: { type: 'boolean', description: '只返回收藏的资源' },
        },
      },
    },
    {
      name: 'builtin-resource_read',
      description:
        '读取资源内容（笔记/教材/整卷/作文/翻译/导图）。多页文档可用 page_start/page_end 按页读取；首次不指定页码返回全文与 totalPages，之后按需读页节省 token。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: { type: 'string', description: '资源 ID（DSTU 格式，如 note_xxx/tb_xxx/exam_xxx）；来自 resource_list/resource_search 的 id 或 unified_search 的 readResourceId（优先）/sourceId。不要传 VFS UUID（res_xxx）。' },
          include_metadata: { type: 'boolean', description: '包含元数据（标题、创建时间等），默认 true' },
          page_start: { type: 'integer', description: '起始页码（1-based），仅 PDF/教材/文件类型有效', minimum: 1 },
          page_end: { type: 'integer', description: '结束页码（1-based，含），未指定时等于 page_start', minimum: 1 },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-resource_search',
      description: '在学习资源中全文搜索，返回匹配资源列表与相关片段。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词（标题与内容）' },
          types: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['note', 'textbook', 'file', 'image', 'exam', 'essay', 'translation', 'mindmap'],
            },
            description: '限制搜索的资源类型',
          },
          folder_id: { type: 'string', description: '限制搜索到指定文件夹' },
          top_k: { type: 'integer', description: '返回结果数量。参数名是 top_k，不是 limit/max_results。', default: 10, minimum: 1, maximum: 50 },
        },
        required: ['query'],
      },
    },
    {
      name: 'builtin-folder_list',
      description: '列出用户的文件夹结构，了解资源组织方式。',
      inputSchema: {
        type: 'object',
        properties: {
          parent_id: { 
            type: 'string', 
            description: '父文件夹 ID，空或 "root" 时列根目录' 
          },
          include_count: { 
            type: 'boolean', 
            description: '附带各文件夹资源数量统计，默认 true' 
          },
          recursive: {
            type: 'boolean',
            description: '递归列出子文件夹，默认 false',
          },
        },
      },
    },
  ],
};

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
  description: '学习资源管理能力组。当用户需要浏览或查看学习资料（笔记、教材、整卷、作文、翻译、知识导图）或搜索学习资源时使用。注：创建/编辑思维导图请加载 mindmap-tools 技能。',
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
- **builtin-resource_read**: 读取指定资源的完整内容
- **builtin-resource_search**: 在资源中全文搜索
- **builtin-folder_list**: 列出文件夹结构，了解资源组织方式

> 💡 如需创建/编辑思维导图，请加载 **mindmap-tools** 技能

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
`,
  embeddedTools: [
    {
      name: 'builtin-resource_list',
      description: '列出用户的学习资源。可按类型（笔记、教材、整卷、作文、翻译、知识导图）和文件夹筛选。当需要了解用户有哪些学习材料、浏览用户的笔记或教材列表时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          type: { type: 'string', description: '资源类型，默认all', enum: ['note', 'textbook', 'file', 'image', 'exam', 'essay', 'translation', 'mindmap', 'all'], default: 'all' },
          folder_id: { type: 'string', description: '可选：文件夹 ID，只列出该文件夹下的资源' },
          search: { type: 'string', description: '可选：搜索关键词，按标题/名称过滤' },
          limit: { type: 'integer', description: '返回数量限制，默认20条，最多100条', default: 20, minimum: 1, maximum: 100 },
          favorites_only: { type: 'boolean', description: '可选：是否只返回收藏的资源' },
        },
      },
    },
    {
      name: 'builtin-resource_read',
      description: '读取指定学习资源的完整内容。支持笔记、教材页面、整卷题目、作文批改、翻译结果、知识导图。当检索结果片段不够完整、需要查看完整文档时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          resource_id: { type: 'string', description: '【必填】资源 ID（如 note_xxx, tb_xxx, exam_xxx 或 res_xxx）。可通过 resource_list、resource_search，或 unified_search 返回的 readResourceId（优先）/sourceId/resourceId 获取。' },
          include_metadata: { type: 'boolean', description: '是否包含元数据（标题、创建时间等），默认true' },
        },
        required: ['resource_id'],
      },
    },
    {
      name: 'builtin-resource_search',
      description: '在学习资源中全文搜索。当用户询问特定知识点、想查找某个主题的笔记、或寻找相关学习材料时使用。返回匹配的资源列表和相关片段。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '【必填】搜索关键词，支持标题和内容搜索' },
          types: {
            type: 'array',
            items: {
              type: 'string',
              enum: ['note', 'textbook', 'file', 'image', 'exam', 'essay', 'translation', 'mindmap'],
            },
            description: '可选：限制搜索的资源类型',
          },
          folder_id: { type: 'string', description: '可选：限制搜索范围到指定文件夹' },
          top_k: { type: 'integer', description: '返回结果数量，默认10条，最多50条', default: 10, minimum: 1, maximum: 50 },
        },
        required: ['query'],
      },
    },
    {
      name: 'builtin-folder_list',
      description: '列出用户的文件夹结构。当需要了解资源的组织方式、查看有哪些文件夹、或者用户问"我的文件夹有哪些"时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          parent_id: { 
            type: 'string', 
            description: '父文件夹 ID，为空或 "root" 时列出根目录下的文件夹' 
          },
          include_count: { 
            type: 'boolean', 
            description: '是否包含每个文件夹的资源数量统计，默认 true' 
          },
          recursive: {
            type: 'boolean',
            description: '是否递归列出子文件夹，默认 false（只列出直接子文件夹）',
          },
        },
      },
    },
  ],
};

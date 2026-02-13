/**
 * VFS 记忆技能组
 *
 * 包含记忆读取、写入、列表、更新、删除等工具
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const vfsMemorySkill: SkillDefinition = {
  id: 'vfs-memory',
  name: 'vfs-memory',
  description: 'VFS 记忆管理能力组，包含记忆读取、写入、列表、更新、删除等工具。当用户要求记住某些信息、回忆之前保存的内容、或管理个人记忆时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://vfs-memory',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  dependencies: ['knowledge-retrieval'],
  content: `# VFS 记忆管理技能

当你需要管理用户记忆时，请根据操作类型选择合适的工具：

## 工具选择指南

### 查询记忆
- **builtin-unified_search**: 搜索记忆内容（通过 knowledge-retrieval 技能中的统一搜索，包含文本/图片/记忆）
- **builtin-memory_read**: 读取指定记忆的完整内容
- **builtin-memory_list**: 列出记忆目录结构

### 写入记忆
- **builtin-memory_write**: 创建新记忆或更新现有记忆
- **builtin-memory_write_smart**: 智能写入，自动决策新增/更新/追加
- **builtin-memory_update_by_id**: 按 ID 精确更新记忆

### 删除记忆
- **builtin-memory_delete**: 删除指定记忆（软删除）

## 记忆分类

记忆按文件夹分类存储：
- **偏好**: 用户的个人偏好和习惯
- **知识**: 用户学到的知识和概念
- **经历**: 用户的重要经历和事件

## 使用建议

1. 写入前先用 builtin-unified_search 搜索是否有相关记忆，避免重复
2. 使用 memory_write_smart 可自动处理新增/更新逻辑
3. 按 note_id 更新比按标题更新更精确
`,
  embeddedTools: [
    {
      name: 'builtin-memory_read',
      description: '读取指定记忆文件的完整内容。通过 note_id（从 unified_search 的记忆结果或 memory_list 获取）读取记忆笔记。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '【必填】记忆笔记 ID（从 unified_search 的记忆结果或 memory_list 中获取）' },
        },
        required: ['note_id'],
      },
    },
    {
      name: 'builtin-memory_write',
      description: '创建或更新用户记忆文件。用于保存用户偏好、学习到的知识或重要经历。记忆以 Markdown 笔记形式存储。必须提供 title 和 content。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '可选：指定 note_id 则按 ID 更新/追加该记忆' },
          folder: { type: 'string', description: '记忆分类文件夹路径，如 "偏好"、"知识"、"经历"。留空表示存储在记忆根目录。' },
          title: { type: 'string', description: '【必填】记忆标题' },
          content: { type: 'string', description: '【必填】记忆内容（Markdown 格式）' },
          mode: { type: 'string', description: '写入模式：create=新建, update=替换同名记忆, append=追加', enum: ['create', 'update', 'append'] },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'builtin-memory_update_by_id',
      description: '按 note_id 更新记忆内容或标题（避免同名记忆误更新）。必须提供 note_id。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '【必填】记忆笔记 ID（从 unified_search 的记忆结果或 memory_list 获取）' },
          title: { type: 'string', description: '可选：新的记忆标题' },
          content: { type: 'string', description: '可选：新的记忆内容（Markdown 格式）' },
        },
        required: ['note_id'],
      },
    },
    {
      name: 'builtin-memory_delete',
      description: '删除指定记忆（软删除）。必须提供 note_id。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '【必填】记忆笔记 ID（从 unified_search 的记忆结果或 memory_list 获取）' },
        },
        required: ['note_id'],
      },
    },
    {
      name: 'builtin-memory_write_smart',
      description: '智能写入记忆（由 LLM 决策新增/更新/追加）。自动判断是否有重复记忆。必须提供 title 和 content。',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: '记忆分类文件夹路径。留空表示存储在记忆根目录。' },
          title: { type: 'string', description: '【必填】记忆标题' },
          content: { type: 'string', description: '【必填】记忆内容（Markdown 格式）' },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'builtin-memory_list',
      description: '列出指定文件夹下的记忆笔记列表。返回笔记 ID、标题、文件夹路径和更新时间。',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: '相对于记忆根目录的文件夹路径，留空表示根目录' },
          limit: { type: 'integer', description: '返回数量限制，默认100条', default: 100, minimum: 1, maximum: 500 },
        },
      },
    },
  ],
};

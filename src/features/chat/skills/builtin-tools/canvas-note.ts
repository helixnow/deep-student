/**
 * Canvas 笔记技能组
 *
 * 包含笔记读取、追加、替换、设置、创建、列表、搜索等工具
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const canvasNoteSkill: SkillDefinition = {
  id: 'canvas-note',
  name: 'canvas-note',
  description: '智能笔记能力组，包含笔记读取、追加、替换、创建、列表、搜索等工具。当用户需要查看、编辑、创建笔记或在笔记中添加内容时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://canvas-note',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 智能笔记技能

当你需要操作笔记时，请根据操作类型选择合适的工具：

## 工具选择指南

### 读取操作
- **builtin-note_read**: 读取笔记内容，可指定章节只读取部分内容

### 写入操作
- **builtin-note_append**: 追加内容到笔记末尾或指定章节末尾
- **builtin-note_replace**: 替换笔记中的特定内容（支持正则）
- **builtin-note_set**: 设置笔记完整内容（⚠️ 会覆盖原有内容）

### 创建和管理
- **builtin-note_create**: 创建新笔记
- **builtin-note_list**: 列出笔记列表
- **builtin-note_search**: 在笔记中搜索

## 使用建议

1. 编辑前先用 note_read 读取当前内容
2. 增量修改优先使用 note_append 或 note_replace
3. 只有需要完全重写时才使用 note_set
4. 支持 Markdown 格式
`,
  allowedTools: [
    'builtin-note_read',
    'builtin-note_append',
    'builtin-note_replace',
    'builtin-note_set',
    'builtin-note_create',
    'builtin-note_list',
    'builtin-note_search',
  ],
  embeddedTools: [
    {
      name: 'builtin-note_read',
      description: '读取笔记的内容。当用户询问笔记内容、需要分析笔记、或要基于笔记进行操作时使用。可指定 section 参数只读取特定章节。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。' },
          section: { type: 'string', description: '可选：要读取的章节标题（如 "## 代码实现"）。不指定则读取完整内容。' },
        },
      },
    },
    {
      name: 'builtin-note_append',
      description: '追加内容到笔记末尾。当用户要求添加新内容、补充笔记、或在笔记中添加总结时使用。可指定 section 参数追加到特定章节末尾。支持 Markdown 格式。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。' },
          content: { type: 'string', description: '【必填】要追加的内容（支持 Markdown 格式）' },
          section: { type: 'string', description: '可选：要追加到的章节标题。不指定则追加到末尾。' },
        },
        required: ['content'],
      },
    },
    {
      name: 'builtin-note_replace',
      description: '替换笔记中的内容。当用户要求修改特定内容、更正错误、或更新笔记中的某部分时使用。支持普通文本和正则表达式。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。' },
          search: { type: 'string', description: '【必填】要查找的文本或正则表达式' },
          replace: { type: 'string', description: '【必填】替换后的文本' },
          is_regex: { type: 'boolean', description: '是否使用正则表达式（默认 false）' },
        },
        required: ['search', 'replace'],
      },
    },
    {
      name: 'builtin-note_set',
      description: '设置笔记的完整内容。⚠️ 谨慎使用，会覆盖原有内容。当用户要求重写整个笔记、或需要完全替换笔记内容时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '笔记 ID。如果在 Canvas 上下文中已选择笔记，可省略此参数。' },
          content: { type: 'string', description: '【必填】笔记的新完整内容（支持 Markdown 格式）' },
        },
        required: ['content'],
      },
    },
    {
      name: 'builtin-note_create',
      description: '创建新笔记。当用户要求创建新的笔记、调研报告、或需要记录新内容时使用。创建成功后返回笔记 ID。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '【必填】笔记标题' },
          content: { type: 'string', description: '笔记初始内容（支持 Markdown 格式，可选）' },
          folder_id: { type: 'string', description: '可选：存放笔记的文件夹 ID' },
        },
        required: ['title'],
      },
    },
    {
      name: 'builtin-note_list',
      description: '列出笔记列表。当需要查看用户有哪些笔记、或在操作前确认笔记存在时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          folder_id: { type: 'string', description: '可选：指定文件夹 ID，只列出该文件夹下的笔记' },
          limit: { type: 'integer', description: '返回数量限制，默认20条', default: 20, minimum: 1, maximum: 100 },
        },
      },
    },
    {
      name: 'builtin-note_search',
      description: '在笔记中搜索特定内容。当用户想找特定主题的笔记、或查找包含某些关键词的笔记时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '【必填】搜索关键词' },
          folder_id: { type: 'string', description: '可选：限制搜索范围到指定文件夹' },
          limit: { type: 'integer', description: '返回结果数量，默认10条', default: 10, minimum: 1, maximum: 50 },
        },
        required: ['query'],
      },
    },
  ],
};

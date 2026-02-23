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
  description: 'VFS 记忆管理能力组，包含记忆读取、写入、列表、更新、删除等工具。你应主动使用这些工具：回答前检索相关记忆以个性化回复，发现用户偏好/背景/目标时主动保存，用户纠正信息时更新旧记忆。',
  version: '2.0.0',
  author: 'Deep Student',
  priority: 3,
  location: 'builtin',
  sourcePath: 'builtin://vfs-memory',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  dependencies: ['knowledge-retrieval'],
  content: `# VFS 记忆管理技能

你拥有持久记忆能力，可以跨对话记住用户信息。**主动使用记忆**是提供优质个性化服务的关键。

## 记忆 = 原子事实（最重要的原则）

每条记忆是关于用户的**一个简短陈述句**（≤ 50 字），不是一篇笔记。

✅ 正确："高三理科生" / "数学是弱项" / "偏好表格形式总结" / "高考在2026年6月7日"
❌ 错误：写一篇知识点总结 / 罗列错题分析 / 总结章节内容 / 一条记忆塞多个事实

**绝对禁止**存入记忆：学科知识、定理公式、题目内容、解题过程、文档摘要。
判断标准：这条信息换一个用户还成立吗？如果是，就不是记忆。

## 何时应主动使用记忆

### 主动读取（每次对话都应考虑）
- 回答涉及用户个人情况的问题前，先搜索相关记忆
- 需要做个性化决策时（推荐、规划、格式选择），先查看用户偏好
- 用户提到"之前/上次/老规矩"时，检索历史记忆

### 主动写入（发现有价值的用户事实时立即记录）
- 用户透露身份背景（年级、学校、专业、备考目标）
- 用户表达稳定偏好（讲解风格、输出格式、语言偏好）
- 用户提到时间约束（考试日期、截止日期）
- 用户纠正你的理解（更新旧记忆）
- 用户明确要求"记住"某些信息
- 多个事实 → 分多次写入，每次只写一条

## 工具选择指南

### 查询记忆
- **builtin-unified_search**: 搜索记忆内容（推荐首选，同时搜索知识库和记忆）
- **builtin-memory_read**: 读取指定记忆的完整内容
- **builtin-memory_list**: 列出记忆目录结构

### 写入记忆
- **builtin-memory_write_smart**: 智能写入（推荐首选），自动判断新增/更新/追加
- **builtin-memory_write**: 创建新记忆或更新现有记忆
- **builtin-memory_update_by_id**: 按 ID 精确更新记忆

### 删除记忆
- **builtin-memory_delete**: 删除指定记忆（用户要求忘记时使用）

## 记忆分类

记忆按文件夹分类存储：
- **偏好**: 用户的个人偏好和习惯（格式偏好、风格偏好、负面偏好等）
- **偏好/个人背景**: 身份、年级、学校、专业方向
- **经历**: 用户的重要经历、计划和进度
- **经历/时间节点**: 考试日期、截止日期等时间约束
- **经历/学科状态**: 强项/弱项、成绩记录、学习进度

## 使用建议

1. 写入前先用 builtin-unified_search 搜索是否有相关记忆，避免重复
2. 优先使用 memory_write_smart，它能自动处理新增/更新逻辑
3. 按 note_id 更新比按标题更新更精确
4. 写入后简短告知用户即可，如"（已记住你的 XX 偏好）"
5. **每条记忆 ≤ 50 字，一条记忆 = 一个事实**
`,
  embeddedTools: [
    {
      name: 'builtin-memory_read',
      description: '读取指定记忆的完整内容。当 unified_search 返回记忆摘要不够详细时，用此工具获取完整记忆。note_id 从 unified_search 的记忆结果或 memory_list 获取。',
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
      description: '创建或更新用户记忆。记忆只存储关于用户的原子事实（≤50字的短句），禁止存入学科知识/题目分析/文档摘要。多个事实应分多次调用。',
      inputSchema: {
        type: 'object',
        properties: {
          note_id: { type: 'string', description: '可选：指定 note_id 则按 ID 更新/追加该记忆' },
          folder: { type: 'string', description: '记忆分类文件夹路径，如 "偏好"、"偏好/个人背景"、"经历"、"经历/时间节点"、"经历/学科状态"。留空表示存储在记忆根目录。' },
          title: { type: 'string', description: '【必填】记忆标题（事实的关键词概括，如"数学弱项"、"高考日期"、"格式偏好-表格"）' },
          content: { type: 'string', description: '【必填】一个关于用户的简短陈述句，≤50字。示例："高三理科生" / "数学是弱项科目" / "偏好表格形式的总结"。禁止写入学科知识、解题过程、知识点总结。' },
          mode: { type: 'string', description: '写入模式：create=新建, update=替换同名记忆, append=追加', enum: ['create', 'update', 'append'] },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'builtin-memory_update_by_id',
      description: '按 note_id 精确更新记忆。当用户纠正了之前的信息、偏好发生变化、或需要补充已有记忆时使用。优先使用此工具更新而非创建重复记忆。',
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
      description: '删除指定记忆（软删除）。当用户明确要求"忘掉"、"不要记"、"删除这条记忆"时立即执行。',
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
      description: '智能写入记忆（推荐首选）。自动判断是否有重复记忆并决策新增/更新/追加。只存储关于用户的原子事实（≤50字），禁止存入学科知识或文档内容。多个事实分多次调用。',
      inputSchema: {
        type: 'object',
        properties: {
          folder: { type: 'string', description: '记忆分类文件夹路径，如 "偏好"、"经历"、"经历/学科状态"。留空表示存储在记忆根目录。' },
          title: { type: 'string', description: '【必填】记忆标题（事实的关键词概括，如"数学弱项"、"高考日期"）' },
          content: { type: 'string', description: '【必填】一个关于用户的简短陈述句，≤50字。示例："高考在2026年6月7日" / "模考总分580分（2026-02）"。禁止写入知识点、公式、题目分析。' },
        },
        required: ['title', 'content'],
      },
    },
    {
      name: 'builtin-memory_list',
      description: '列出记忆目录结构和笔记列表。当需要了解用户已有哪些记忆、或浏览特定分类下的记忆时使用。返回笔记 ID、标题、文件夹路径和更新时间。',
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

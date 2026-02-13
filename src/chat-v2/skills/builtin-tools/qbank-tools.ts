/**
 * 智能题目集技能组
 *
 * 支持题目管理、刷题练习、进度追踪
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const qbankToolsSkill: SkillDefinition = {
  id: 'qbank-tools',
  name: 'qbank-tools',
  description: '智能题目集能力组，支持题目管理、刷题练习、进度追踪、变式题生成。当用户需要练习题目、管理错题集、查看学习进度时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 7,
  location: 'builtin',
  sourcePath: 'builtin://qbank-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 智能题目集技能

当你需要帮助用户管理和练习题目时，请选择合适的工具：

## 工具选择指南

### 题目集管理
- **builtin-qbank_list**: 列出所有题目集
- **builtin-qbank_list_questions**: 列出题目集中的题目
- **builtin-qbank_get_question**: 获取单个题目详情
- **builtin-qbank_update_question**: 更新题目信息
- **builtin-qbank_batch_import**: 批量导入题目
- **builtin-qbank_import_document**: 从文档导入题目
- **builtin-qbank_export**: 导出题目集

### 刷题练习
- **builtin-qbank_get_next_question**: 获取下一道题
- **builtin-qbank_submit_answer**: 提交答案
- **builtin-qbank_generate_variant**: 生成变式题

### 进度追踪
- **builtin-qbank_get_stats**: 获取学习统计
- **builtin-qbank_reset_progress**: 重置学习进度

## 引用格式

创建或导入题目集后，**必须**在回复中使用引用让用户可以直接点击打开：

- \`[题目集:session_id]\` — 基本引用
- \`[题目集:session_id:名称]\` — 带名称的引用（推荐）

**示例回复**：
> 我已为你创建了 [题目集:abc123:高等数学期中练习]，共导入了 25 道题目。点击可直接开始练习。

## 出题格式要求

使用 \`qbank_batch_import\` 创建题目时，必须正确设置题型和选项：

- **选择题**：\`question_type\` 设为 \`"single_choice"\` 或 \`"multiple_choice"\`，提供 \`options\` 数组（\`[{"key":"A","content":"..."}, ...]\`），\`answer\` 填选项字母（如 \`"A"\` 或 \`"ABD"\`）。不要把选项写在 content 题干里。
- **填空题**：\`question_type\` 设为 \`"fill_blank"\`，题干中用 \`____\` 表示空位
- **简答/计算/证明题**：分别设 \`"short_answer"\`/\`"calculation"\`/\`"proof"\`
- **禁止**：如果题目明显有 A/B/C/D 选项，不要设为 \`"other"\`

## 注意事项

- 创建/导入题目集后，工具返回的 \`session_id\` 用于引用格式中的 ID
- 批量导入和文档导入都会返回 \`session_id\` 和 \`name\`，请务必在回复中渲染引用
- 引用格式会被渲染为可点击的跳转徽章，用户点击后直接打开对应题目集
`,
  allowedTools: [
    'builtin-qbank_list',
    'builtin-qbank_list_questions',
    'builtin-qbank_get_question',
    'builtin-qbank_submit_answer',
    'builtin-qbank_update_question',
    'builtin-qbank_get_stats',
    'builtin-qbank_get_next_question',
    'builtin-qbank_generate_variant',
    'builtin-qbank_batch_import',
    'builtin-qbank_reset_progress',
    'builtin-qbank_export',
    'builtin-qbank_import_document',
    'builtin-qbank_ai_grade',
  ],
  embeddedTools: [
    {
      name: 'builtin-qbank_list',
      description: '列出用户的所有题目集，返回每个题目集的基本信息和学习统计数据。无需 session_id 参数。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 20, minimum: 1, maximum: 100, description: '返回数量限制' },
          offset: { type: 'integer', default: 0, minimum: 0, description: '偏移量（用于分页）' },
          search: { type: 'string', description: '搜索关键词（匹配题目集名称）' },
          include_stats: { type: 'boolean', default: true, description: '是否包含统计信息' },
        },
      },
    },
    {
      name: 'builtin-qbank_list_questions',
      description: '列出题目集中的题目。支持按状态、难度、标签筛选，支持分页。必须提供 session_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          status: { type: 'string', enum: ['new', 'in_progress', 'mastered', 'review'], description: '筛选状态' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'], description: '筛选难度' },
          tags: { type: 'array', items: { type: 'string' }, description: '筛选标签' },
          page: { type: 'integer', default: 1, minimum: 1, description: '页码' },
          page_size: { type: 'integer', default: 20, minimum: 1, maximum: 100, description: '每页数量' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_get_question',
      description: '获取单个题目的详细信息，包括题干、答案、解析、用户作答记录等。必须提供 session_id 和 card_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          card_id: { type: 'string', description: '【必填】题目卡片 ID' },
        },
        required: ['session_id', 'card_id'],
      },
    },
    {
      name: 'builtin-qbank_submit_answer',
      description: '提交用户答案并判断正误。自动更新题目状态和统计数据。必须提供 session_id、card_id 和 user_answer。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          card_id: { type: 'string', description: '【必填】题目卡片 ID' },
          user_answer: { type: 'string', description: '【必填】用户提交的答案' },
          is_correct: { type: 'boolean', description: '是否正确（可选，如果不提供则自动判断）' },
        },
        required: ['session_id', 'card_id', 'user_answer'],
      },
    },
    {
      name: 'builtin-qbank_update_question',
      description: '更新题目信息，如答案、解析、难度、标签、用户笔记等。必须提供 session_id 和 card_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          card_id: { type: 'string', description: '【必填】题目卡片 ID' },
          answer: { type: 'string', description: '更新答案' },
          explanation: { type: 'string', description: '更新解析' },
          difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'], description: '更新难度' },
          tags: { type: 'array', items: { type: 'string' }, description: '更新标签' },
          user_note: { type: 'string', description: '更新用户笔记' },
          status: { type: 'string', enum: ['new', 'in_progress', 'mastered', 'review'], description: '更新学习状态' },
        },
        required: ['session_id', 'card_id'],
      },
    },
    {
      name: 'builtin-qbank_get_stats',
      description: '获取题目集的学习统计信息，包括总题数、各状态数量、正确率等。必须提供 session_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_get_next_question',
      description: '获取下一道推荐题目。支持多种模式：顺序、随机、错题优先、知识点聚焦。必须提供 session_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          mode: {
            type: 'string',
            enum: ['sequential', 'random', 'review_first', 'by_tag'],
            default: 'sequential',
            description: '推题模式',
          },
          tag: { type: 'string', description: '当 mode=by_tag 时，指定要练习的标签' },
          current_card_id: { type: 'string', description: '当前题目 ID（用于顺序模式获取下一题）' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_generate_variant',
      description: '基于原题生成变式题。AI 会保持题目结构和考点，但改变具体数值或情境。必须提供 session_id 和 card_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          card_id: { type: 'string', description: '【必填】原题卡片 ID' },
          variant_type: {
            type: 'string',
            enum: ['similar', 'harder', 'easier', 'different_context'],
            default: 'similar',
            description: '变式类型',
          },
          parent_card_id: { type: 'string', description: '父题目的 card_id，用于关联变式题' },
        },
        required: ['session_id', 'card_id'],
      },
    },
    {
      name: 'builtin-qbank_batch_import',
      description: '批量导入题目到题目集。支持 JSON 格式的题目数据。必须提供 questions 数组。导入成功后，在回复中使用 [题目集:返回的session_id:名称] 格式让用户可点击查看。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '目标题目集 ID（可选，不提供则创建新题目集）' },
          name: { type: 'string', description: '新题目集名称（创建新题目集时使用）' },
          questions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '【必填】题干内容（不要把选项写在题干里，选项放 options 数组）' },
                answer: { type: 'string', description: '答案。选择题填选项字母（如 "A" 或 "ABD"），填空题填答案文本' },
                explanation: { type: 'string', description: '解析' },
                question_type: {
                  type: 'string',
                  enum: ['single_choice', 'multiple_choice', 'fill_blank', 'short_answer', 'essay', 'calculation', 'proof', 'other'],
                  description: '【重要】题型。有 A/B/C/D 选项的必须设为 single_choice 或 multiple_choice，不要设为 other',
                },
                options: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      key: { type: 'string', description: '选项标识，如 A、B、C、D' },
                      content: { type: 'string', description: '选项内容' },
                    },
                    required: ['key', 'content'],
                  },
                  description: '选择题选项（question_type 为 single_choice/multiple_choice 时必填）',
                },
                difficulty: { type: 'string', enum: ['easy', 'medium', 'hard', 'very_hard'] },
                tags: { type: 'array', items: { type: 'string' } },
                parent_card_id: { type: 'string', description: '父题目的 card_id，用于关联变式题' },
              },
              required: ['content'],
            },
            description: '要导入的题目列表',
          },
        },
        required: ['questions'],
      },
    },
    {
      name: 'builtin-qbank_reset_progress',
      description: '重置题目集的学习进度。可以重置全部或指定题目。必须提供 session_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          card_ids: { type: 'array', items: { type: 'string' }, description: '要重置的题目 ID 列表（可选，不提供则重置全部）' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_export',
      description: '导出题目集为 JSON 或 Markdown 格式。必须提供 session_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          format: { type: 'string', enum: ['json', 'markdown'], default: 'json', description: '导出格式' },
          include_stats: { type: 'boolean', default: true, description: '是否包含学习统计' },
          filter_status: { type: 'string', enum: ['new', 'in_progress', 'mastered', 'review'], description: '只导出指定状态的题目' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-qbank_import_document',
      description:
        '从文档导入题目到题目集。支持 DOCX、TXT、MD 格式。超长文档将自动分块处理，每块独立调用 AI 解析，最后合并结果。当用户上传题目文档、想要批量导入题目时使用。导入成功后，在回复中使用 [题目集:返回的session_id:名称] 格式让用户可点击查看。',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '【必填】文档内容（纯文本或 base64 编码）' },
          format: { type: 'string', enum: ['txt', 'md', 'docx', 'json'], default: 'txt', description: '文档格式' },
          name: { type: 'string', description: '题目集名称（可选，不提供则自动生成）' },
          session_id: { type: 'string', description: '目标题目集 ID（可选，不提供则创建新题目集）' },
          folder_id: { type: 'string', description: '目标文件夹 ID（创建新题目集时使用）' },
        },
        required: ['content'],
      },
    },
    {
      name: 'builtin-qbank_ai_grade',
      description: '[仅在练习界面可用] 此工具无法在对话中执行。对话中请改用 qbank_submit_answer 提交答案，主观题会自动在练习界面触发 AI 评判。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】题目集 ID' },
          card_id: { type: 'string', description: '【必填】题目卡片 ID' },
          mode: { type: 'string', enum: ['grade', 'analyze'], default: 'grade', description: '评判模式：grade=主观题评判，analyze=客观题解析' },
        },
        required: ['session_id', 'card_id'],
      },
    },
  ],
};

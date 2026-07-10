/**
 * 作文批改技能组
 *
 * 调用后端作文批改流水线（essay_grading），支持发起批改、等待结果、查询历史。
 * 是"批改 → 错题入库 → 安排复习"学习闭环的入口环节。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const essayGradingSkill: SkillDefinition = {
  id: 'essay-grading',
  name: 'essay-grading',
  description:
    '作文批改能力组：提交作文全文调用专业批改流水线（支持高考/中考/雅思/托福/考研/四六级等内置批阅模式），返回总分、维度分与逐段批注；支持同一会话多轮修改对比与历史批改查询。当用户要求"批改作文/帮我看看这篇作文/作文打分"时使用。批改结果中的错误点可衔接 qbank-tools 入错题本，再用 review-planning 安排间隔复习，形成完整学习闭环。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 7,
  location: 'builtin',
  sourcePath: 'builtin://essay-grading',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 作文批改技能

调用后端专业作文批改流水线，对用户提交的作文给出总分、维度评分、逐段批注与改进建议。

## 标准工作流（必须遵守）

批改是**异步任务**（LLM 流式批改可能耗时 1-3 分钟），调用顺序：

1. \`builtin-essay_grade\` 发起批改 → 立即返回 \`task_id\` / \`session_id\` / \`round_number\`
2. **下一轮**调用 \`builtin-essay_grade_wait\`（传 task_id）等待完成
   - 返回 \`status=timeout\` 时**不是失败**，再次调用 wait 继续等待即可
   - 返回 \`status=completed\` 时附带完整批改结果
3. 向用户呈现批改结果（总分、维度分、主要问题、改进建议）

## 工具选择指南

### 发起与等待
- **builtin-essay_grade**: 提交作文文本发起批改（可选批阅模式/文体/学段/题目要求）
- **builtin-essay_grade_wait**: 等待批改任务完成并取回结果
- **builtin-essay_grade_status**: 非阻塞查询任务状态

### 模式与历史
- **builtin-essay_list_modes**: 列出内置批阅模式（gaokao/zhongkao/ielts/toefl/kaoyan/cet/practice 等），不确定用哪个模式时先调用
- **builtin-essay_list_sessions**: 列出历史批改会话
- **builtin-essay_list_results**: 列出某会话的所有批改轮次摘要
- **builtin-essay_get_result**: 获取某轮完整批改结果（原文 + 批改 + 评分）

## 多轮修改批改

用户修改作文后再次批改时，**传入上次返回的 session_id**：流水线会自动带上上一轮
批改结果与原文做对比，指出进步与仍存在的问题。

## 🔗 杀手级链路：批改 → 错题入库 → 安排复习（强烈建议主动引导）

批改完成后，**主动建议**用户把批改指出的薄弱点沉淀为可复习的资产：

1. **提取错误点**：从批改结果中归纳语法错误、用词不当、结构问题等具体错误
2. **入错题本**：\`load_skills(["qbank-tools"])\` 后用 \`builtin-qbank_batch_import\` 把错误点
   转成题目（如"改错题：<原句>"，answer 填正确写法，explanation 填批改依据），
   记下返回的 \`session_id\` 与 \`new_card_ids\`
3. **安排复习**：\`load_skills(["review-planning"])\` 后用 \`builtin-review_schedule\`
   （exam_id=上一步的 session_id，card_ids=new_card_ids）安排间隔复习，
   SM-2 算法会自动排期（首次复习为次日）

这样一次批改就变成了"可追踪、可复习"的长期学习计划。

## 注意事项

- 作文正文上限 50000 字符；空文本会被拒绝
- 批阅模式仅支持内置模式（用户自定义模式请在作文批改界面使用）
- 不要在发起 essay_grade 的同一轮并发调用 essay_grade_wait
- 批改结果已由系统持久化，随时可用 essay_get_result 重新取回
`,
  allowedTools: [
    'builtin-essay_grade',
    'builtin-essay_grade_wait',
    'builtin-essay_grade_status',
    'builtin-essay_list_modes',
    'builtin-essay_list_sessions',
    'builtin-essay_list_results',
    'builtin-essay_get_result',
  ],
  embeddedTools: [
    {
      name: 'builtin-essay_grade',
      description:
        '提交作文文本发起专业批改（异步任务）。立即返回 task_id，下一轮用 essay_grade_wait 等待结果。传 session_id 可在同一会话做多轮修改对比批改。批改完成后建议把错误点用 qbank_batch_import 入错题本并用 review_schedule 安排复习。',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: '【必填】作文全文（纯文本，上限 50000 字符）' },
          topic: { type: 'string', description: '作文题目/题干要求（可选，提供后批改会核对是否切题）' },
          mode_id: {
            type: 'string',
            description:
              '批阅模式 ID（可选，来自 essay_list_modes，如 gaokao/zhongkao/ielts/toefl/kaoyan/cet/practice；不传用默认通用模式）',
          },
          essay_type: { type: 'string', description: '作文文体（可选，如 议论文/记叙文/说明文）' },
          grade_level: { type: 'string', description: '学段（可选，如 middle_school/high_school/college）' },
          custom_prompt: { type: 'string', description: '自定义批改要求（可选，会追加到批阅模式提示词后）' },
          session_id: {
            type: 'string',
            description: '批改会话 ID（可选。传入则作为该会话的新一轮批改，自动与上一轮对比；不传则新建会话）',
          },
          title: { type: 'string', description: '新建会话标题（可选，仅在不传 session_id 时生效）' },
        },
        required: ['text'],
      },
    },
    {
      name: 'builtin-essay_grade_wait',
      description:
        '等待批改任务完成（内部轮询，默认最长 90 秒）。返回 completed 时附带完整批改结果；返回 timeout 时任务仍在进行，请再次调用本工具继续等待，不要判定为失败。',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '批改任务 ID（优先，来自 essay_grade 返回）' },
          session_id: { type: 'string', description: '批改会话 ID（task_id 不可用时的兜底定位方式）' },
          round_number: { type: 'integer', description: '轮次号（配合 session_id 使用，不传则取最新轮次）' },
          timeout_ms: {
            type: 'integer',
            minimum: 1000,
            maximum: 100000,
            default: 90000,
            description: '本次等待的超时时间（毫秒），上限 100000',
          },
        },
      },
    },
    {
      name: 'builtin-essay_grade_status',
      description: '非阻塞查询批改任务状态（running/completed/error/cancelled/not_found）。用于快速探测进度。',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: '批改任务 ID（优先）' },
          session_id: { type: 'string', description: '批改会话 ID（兜底）' },
          round_number: { type: 'integer', description: '轮次号（配合 session_id，不传取最新）' },
        },
      },
    },
    {
      name: 'builtin-essay_list_modes',
      description: '列出所有内置批阅模式（ID、名称、评分维度、满分）。为用户选择合适的批改标准时先调用。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
    {
      name: 'builtin-essay_list_sessions',
      description: '列出历史作文批改会话（标题、轮次数、最新得分）。用于回顾批改历史或续批旧作文。',
      inputSchema: {
        type: 'object',
        properties: {
          limit: { type: 'integer', default: 20, minimum: 1, maximum: 100, description: '返回数量上限' },
          offset: { type: 'integer', default: 0, minimum: 0, description: '偏移量（分页）' },
        },
      },
    },
    {
      name: 'builtin-essay_list_results',
      description: '列出某批改会话的所有轮次摘要（轮次号、得分、批改结果预览）。必须提供 session_id。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】批改会话 ID' },
        },
        required: ['session_id'],
      },
    },
    {
      name: 'builtin-essay_get_result',
      description: '获取某轮批改的完整结果（作文原文 + 完整批改文本 + 总分 + 维度评分）。提取错误点入错题本前调用。',
      inputSchema: {
        type: 'object',
        properties: {
          session_id: { type: 'string', description: '【必填】批改会话 ID' },
          round_number: { type: 'integer', description: '轮次号（可选，不传取最新轮次）' },
        },
        required: ['session_id'],
      },
    },
  ],
};

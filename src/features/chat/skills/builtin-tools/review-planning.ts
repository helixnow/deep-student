/**
 * 间隔重复复习计划技能组
 *
 * 调用后端复习计划服务（SM-2 间隔重复算法），支持查询到期复习、
 * 为错题/题目安排复习计划、提交复习结果、查看复习统计。
 * 是"批改/刷题 → 错题入库 → 安排复习"学习闭环的收口环节。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const reviewPlanningSkill: SkillDefinition = {
  id: 'review-planning',
  name: 'review-planning',
  description:
    '间隔重复复习计划能力组（SM-2 算法）：查询今日到期复习项、为题目集/错题安排复习计划、提交复习评分自动排期下次复习、查看复习统计与记忆曲线。当用户说"安排复习/今天该复习什么/帮我制定复习计划/记不住"时使用。上游衔接：qbank-tools 导入的错题（session_id 即 exam_id）、essay-grading 批改后入库的错误点，都可通过本技能组转化为持续复习计划。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 7,
  location: 'builtin',
  sourcePath: 'builtin://review-planning',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 间隔重复复习计划技能

基于 SM-2 间隔重复算法为题目安排科学的复习计划：复习通过则间隔逐步拉长
（1 天 → 6 天 → 按易度因子倍增），失败则重置，确保薄弱题目高频出现。

## 核心概念

- **exam_id（题目集 ID）**：即 qbank 工具返回的 \`session_id\`，一个题目集对应一批题目
- **question_id / card_id**：题目的两种 ID；qbank_batch_import 返回 \`new_card_ids\`（card_id），
  review 工具两种都接受
- **plan_id**：复习计划 ID，来自 review_get_due / review_schedule 的返回
- **quality（0-5 评分）**：0=完全不记得，1-2=错误，3=勉强正确，4=良好，5=完美回忆

## 工具选择指南

### 安排复习（写操作）
- **builtin-review_schedule**: 为指定题目（question_ids 或 card_ids）创建复习计划
- **builtin-review_plan_generate**: 为整个题目集一键生成复习计划（阶段复习计划）

### 执行复习（日常）
- **builtin-review_get_due**: 查询今日/指定日期前到期的复习项（含题目内容预览）
- **builtin-review_submit**: 提交一次复习结果（0-5 评分），SM-2 自动计算下次复习时间

### 统计概览
- **builtin-review_stats**: 复习统计（各状态数量、到期/逾期、正确率；可选日历热力图）

## 典型工作流

### A. 错题入库后立刻安排复习（🔗 与 qbank-tools / essay-grading 衔接）
1. 上游产生错题：
   - 试卷分析/刷题错题 → \`builtin-qbank_batch_import\` 返回 \`session_id\` + \`new_card_ids\`
   - 作文批改（essay-grading）→ 把批改指出的错误点整理为改错题后同样经 qbank_batch_import 入库
2. \`builtin-review_schedule\`（exam_id=session_id, card_ids=new_card_ids）
3. 告知用户：已安排复习，明天首次复习，可随时问"今天该复习什么"

### B. 每日复习
1. \`builtin-review_get_due\` 查到期项（含题目预览）
2. 逐题向用户提问（需要完整题面时用 \`builtin-qbank_get_question\`）
3. 用户作答后按表现调用 \`builtin-review_submit\`（quality 0-5）
4. 全部完成后用 \`builtin-review_stats\` 给出小结

### C. 为整个题目集制定复习计划
1. \`builtin-review_plan_generate\`（exam_id）
2. \`builtin-review_stats\` 展示计划全貌（今日到期/总计划数）

## quality 评分指导（替用户判断时）

- 答案完全正确且流畅 → 5
- 正确但犹豫/耗时长 → 4
- 勉强正确或部分正确 → 3
- 错误但看到答案能想起来 → 2
- 错误且答案感觉陌生 → 1
- 完全没印象 → 0

## 注意事项

- review_schedule 对已有计划的题目自动跳过（幂等），可放心重复调用
- 不提供删除复习计划的工具；用户要求停止复习某题时，说明可在复习界面暂停
- 日期参数统一使用 YYYY-MM-DD 格式
`,
  allowedTools: [
    'builtin-review_get_due',
    'builtin-review_schedule',
    'builtin-review_plan_generate',
    'builtin-review_submit',
    'builtin-review_stats',
  ],
  embeddedTools: [
    {
      name: 'builtin-review_get_due',
      description:
        '查询到期的复习项（默认今天，含题目内容预览与 plan_id）。用于"今天该复习什么"。拿到清单后逐题考察用户，作答后用 review_submit 提交评分。',
      inputSchema: {
        type: 'object',
        properties: {
          exam_id: { type: 'string', description: '题目集 ID（可选，不传查所有题目集）' },
          until_date: { type: 'string', description: '截止日期 YYYY-MM-DD（可选，默认今天；查未来几天可传未来日期）' },
          status: {
            type: 'array',
            items: { type: 'string' },
            description: '状态筛选（可选）：new/learning/reviewing/graduated/suspended',
          },
          difficult_only: { type: 'boolean', description: '只看困难题（连续失败 3 次以上标记为困难）' },
          limit: { type: 'integer', default: 20, minimum: 1, maximum: 100, description: '返回数量上限' },
          offset: { type: 'integer', default: 0, minimum: 0, description: '偏移量（分页）' },
        },
      },
    },
    {
      name: 'builtin-review_schedule',
      description:
        '为指定题目批量创建复习计划（SM-2 排期，首次复习为次日）。question_ids 与 card_ids 至少传一项；card_ids 用 qbank_batch_import 返回的 new_card_ids。已有计划的题目自动跳过。错题入库后应立即调用本工具形成复习闭环。',
      inputSchema: {
        type: 'object',
        properties: {
          exam_id: { type: 'string', description: '【必填】题目集 ID（即 qbank 工具返回的 session_id）' },
          question_ids: { type: 'array', items: { type: 'string' }, description: '题目 ID 列表（与 card_ids 二选一或并用）' },
          card_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '题目卡片 ID 列表（qbank_batch_import 返回的 new_card_ids 可直接使用）',
          },
        },
        required: ['exam_id'],
      },
    },
    {
      name: 'builtin-review_plan_generate',
      description:
        '为整个题目集的所有题目一键生成复习计划（阶段复习计划）。适合"帮我把这套题安排上复习"的场景；已有计划的题目自动跳过。返回创建统计与今日到期数。',
      inputSchema: {
        type: 'object',
        properties: {
          exam_id: { type: 'string', description: '【必填】题目集 ID（即 qbank 工具返回的 session_id）' },
        },
        required: ['exam_id'],
      },
    },
    {
      name: 'builtin-review_submit',
      description:
        '提交一次复习结果（quality 0-5 评分），SM-2 算法自动计算下次复习日期：通过则间隔拉长，失败则重置为明天。plan_id 与 question_id 二选一。',
      inputSchema: {
        type: 'object',
        properties: {
          plan_id: { type: 'string', description: '复习计划 ID（优先，来自 review_get_due 返回）' },
          question_id: { type: 'string', description: '题目 ID（无 plan_id 时自动解析其复习计划）' },
          quality: {
            type: 'integer',
            minimum: 0,
            maximum: 5,
            description: '【必填】0-5 评分：0=完全不记得, 1-2=错误, 3=勉强正确, 4=良好, 5=完美回忆',
          },
          user_answer: { type: 'string', description: '用户本次作答内容（可选，记入复习历史）' },
          time_spent_seconds: { type: 'integer', minimum: 0, description: '本次复习耗时秒数（可选）' },
        },
        required: ['quality'],
      },
    },
    {
      name: 'builtin-review_stats',
      description:
        '获取复习统计概览：各状态计划数、今日到期/逾期数、困难题数、正确率、平均易度因子；include_calendar=true 时附带按日复习量日历热力图（记忆曲线概览）。',
      inputSchema: {
        type: 'object',
        properties: {
          exam_id: { type: 'string', description: '题目集 ID（可选，不传返回全局统计）' },
          include_calendar: { type: 'boolean', default: false, description: '是否附带日历热力图数据' },
          start_date: { type: 'string', description: '日历起始日期 YYYY-MM-DD（可选）' },
          end_date: { type: 'string', description: '日历结束日期 YYYY-MM-DD（可选）' },
        },
      },
    },
  ],
};

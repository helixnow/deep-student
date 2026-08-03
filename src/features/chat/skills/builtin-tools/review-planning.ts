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

### 管理单个计划
- **builtin-review_suspend**: 暂停计划，之后不再出现在到期队列中
- **builtin-review_resume**: 恢复已暂停计划，并重新排到今天
- **builtin-review_delete**: 永久删除计划（High；必须先用 ask_user 明确确认）

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

### D. 停止或恢复单题复习
1. 从 \`review_get_due\` 的结果取得准确 \`plan_id\` 和 \`updatedAt\`
2. 临时停止时调用 \`builtin-review_suspend\`；之后使用暂停结果返回的新 \`updatedAt\` 调 \`builtin-review_resume\`
3. 永久删除时必须先 \`load_skills(["ask-user"])\`，再用 \`builtin-ask_user\` 列明计划并确认“永久删除”
4. 只有用户明确确认后才调用 \`builtin-review_delete\`；审批通过后不可恢复

## quality 评分指导（替用户判断时）

- 答案完全正确且流畅 → 5
- 正确但犹豫/耗时长 → 4
- 勉强正确或部分正确 → 3
- 错误但看到答案能想起来 → 2
- 错误且答案感觉陌生 → 1
- 完全没印象 → 0

## 注意事项

- review_schedule 对已有计划的题目自动跳过（幂等），可放心重复调用
- 临时停止优先 suspend，不要用 delete 代替；delete 是不可恢复的 High 操作
- submit/suspend/resume/delete 都必须使用刚读取工具返回的准确 \`plan_id\` 与 \`updatedAt\`；不要猜测 ID 或复用过期版本
- 日期参数统一使用 YYYY-MM-DD 格式
`,
  allowedTools: [
    'builtin-review_get_due',
    'builtin-review_schedule',
    'builtin-review_plan_generate',
    'builtin-review_submit',
    'builtin-review_stats',
    'builtin-review_suspend',
    'builtin-review_resume',
    'builtin-review_delete',
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
        '提交一次复习结果（quality 0-5 评分），SM-2 自动计算下次复习日期。必须先从 review_get_due 等读取计划，并携带返回的 updatedAt 作为 expected_updated_at；plan_id 与 question_id 二选一。',
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
          expected_updated_at: {
            type: 'string',
            minLength: 1,
            description: '【必填】计划读取结果中的 updatedAt；用于防止覆盖并发更新',
          },
          user_answer: { type: 'string', description: '用户本次作答内容（可选，记入复习历史）' },
          time_spent_seconds: { type: 'integer', minimum: 0, description: '本次复习耗时秒数（可选）' },
        },
        required: ['quality', 'expected_updated_at'],
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
    {
      name: 'builtin-review_suspend',
      description:
        '暂停一个复习计划（Medium）。plan_id 和 expected_updated_at 必须来自刚读取的计划；暂停后该计划不再进入到期队列。返回暂停后的计划状态，可用 review_resume 恢复。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan_id: { type: 'string', minLength: 1, description: '【必填】复习计划 ID（来自 review_get_due）' },
          expected_updated_at: { type: 'string', minLength: 1, description: '【必填】读取计划时返回的 updatedAt' },
        },
        required: ['plan_id', 'expected_updated_at'],
      },
    },
    {
      name: 'builtin-review_resume',
      description:
        '恢复一个已暂停的复习计划（Medium）。恢复后会重新排到今天；plan_id 和 expected_updated_at 必须来自此前 suspend/get_due 返回的准确值。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan_id: { type: 'string', minLength: 1, description: '【必填】已暂停的复习计划 ID' },
          expected_updated_at: { type: 'string', minLength: 1, description: '【必填】读取计划时返回的 updatedAt' },
        },
        required: ['plan_id', 'expected_updated_at'],
      },
    },
    {
      name: 'builtin-review_delete',
      description:
        '永久删除一个复习计划（High，不可恢复）。调用前必须加载 ask-user 技能并用 builtin-ask_user 向用户列明目标、取得明确确认；还必须携带读取计划时的 updatedAt，避免删除已变化的计划。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          plan_id: { type: 'string', minLength: 1, description: '【必填】要永久删除的复习计划 ID' },
          expected_updated_at: { type: 'string', minLength: 1, description: '【必填】读取计划时返回的 updatedAt' },
        },
        required: ['plan_id', 'expected_updated_at'],
      },
    },
  ],
};

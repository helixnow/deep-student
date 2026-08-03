import type { SkillDefinition } from '../types';

const paginationProperties = {
  page: {
    type: 'integer',
    minimum: 1,
    default: 1,
    description: '页码，从 1 开始。',
  },
  page_size: {
    type: 'integer',
    minimum: 1,
    maximum: 20,
    default: 20,
    description: '单页天数，最多 20。',
  },
} as const;

export const learningOverviewToolsSkill: SkillDefinition = {
  id: 'learning-overview-tools',
  name: 'learning-overview-tools',
  description:
    '只读汇总指定区间的学习活动与番茄钟，并附题库、FSRS/SM-2 的调用时当前快照，回答本周学了什么、学了多久以及近期专注趋势。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://learning-overview-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 学习总览与番茄钟统计

## 何时使用

- “我这周学了什么、学了多久”：调用 \`builtin-learning_overview\`。
- “今天专注了多久”：调用 \`builtin-pomodoro_today_stats\`。
- “最近 30 天番茄钟趋势”：调用 \`builtin-pomodoro_daily_stats\`，并按 \`has_more\` 翻页。

## 数据边界

- 三个工具均为 Low、只读，不创建、修改或删除学习记录。
- learning_overview 默认返回本地今天在内的最近 7 天；自定义日期必须同时提供
  \`start_date/end_date\`，使用严格 \`YYYY-MM-DD\`，结束日期不得晚于今天，跨度最多 90 天。
- 日明细单页最多 20 条。\`activityTotals/focusTotals\` 覆盖完整请求区间，不因分页截断；
  \`daily\` 仅是当前页。
- \`questionBank/fsrsReview/sm2Review\` 是调用时的当前库存/调度快照，不是请求日期范围内的
  历史增量。回答“本周”时不得把这些快照说成仅在本周发生的数据。
- \`partial=true\` 表示一个或多个数据源不可用。必须查看 \`sourceErrors\` 并明确说明缺失来源，
  不能把缺失的题库、FSRS、SM-2、热力图或番茄钟数据描述成 0。
- \`fsrsReview\` 是 Anki/FSRS 调度统计；\`sm2Review\` 是题库复习计划统计，两者不可混为同一队列。
- 番茄钟时长统一为秒；需要分钟或小时时由 Agent 在回答中换算，并保留合理精度。
`,
  allowedTools: [
    'builtin-learning_overview',
    'builtin-pomodoro_today_stats',
    'builtin-pomodoro_daily_stats',
  ],
  embeddedTools: [
    {
      name: 'builtin-learning_overview',
      description:
        '只读聚合学习热力图与番茄钟区间统计，并附题库、FSRS、SM-2 的调用时当前快照。默认最近 7 天；自定义范围最多 90 天。返回区间 activity/focus 汇总、分页 daily、partial 和 sourceErrors。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          start_date: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: '开始日期，严格 YYYY-MM-DD；必须与 end_date 同时提供。',
          },
          end_date: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: '结束日期，严格 YYYY-MM-DD，不得晚于本地今天；必须与 start_date 同时提供。',
          },
          ...paginationProperties,
        },
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            properties: {
              ...paginationProperties,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['start_date', 'end_date'],
            properties: {
              start_date: {
                type: 'string',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                description: '开始日期，严格 YYYY-MM-DD。',
              },
              end_date: {
                type: 'string',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$',
                description: '结束日期，严格 YYYY-MM-DD，不得晚于本地今天。',
              },
              ...paginationProperties,
            },
          },
        ],
      },
    },
    {
      name: 'builtin-pomodoro_today_stats',
      description:
        '读取本地今天的番茄钟统计（Low）：完成工作番茄数、专注秒数和中断次数。无参数。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'builtin-pomodoro_daily_stats',
      description:
        '读取包含本地今天在内的最近 N 天番茄钟日统计（Low），升序返回，汇总覆盖全部 N 天，daily 单页最多 20 条。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: {
            type: 'integer',
            minimum: 1,
            maximum: 90,
            default: 7,
            description: '包含今天在内的天数，1 到 90。',
          },
          ...paginationProperties,
        },
      },
    },
  ],
};

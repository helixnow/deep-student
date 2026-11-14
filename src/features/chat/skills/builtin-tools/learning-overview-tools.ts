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
    description: '单页天数。',
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
- \`media.recentCourses\`：最近在看的课，\`positionRef\` 为看到的位置，\`wrongCheckpoints\` 为答错的课中
  检查点。提到时刻时原样写出 \`[媒体@…]\` 引用；字段为空时不要编造观看记录。
- 番茄钟时长统一为秒；需要分钟或小时时由 Agent 在回答中换算，并保留合理精度。

## 番茄钟记录管理

- \`builtin-pomodoro_record_create\`（Medium，串行）：补录一次已完成的专注记录，返回真实记录 ID。
  \`duration\` 为计划秒数；\`mode\` 仅区分倒计时/正计时；\`todo_id\` 关联待办。
  当前数据表只保存时长与时间，\`mode\`/\`note\` 会回显但不会持久化。
- \`builtin-pomodoro_record_list\`（Low，只读）：按本地日期范围读取记录，默认最近 7 天，
  最多 90 天；可按 \`todo_id\` 过滤，\`limit\` 默认 20、最多 100，\`has_more=true\` 表示还有更多。
- \`builtin-pomodoro_record_delete\`（High，串行）：按 \`id\` 删除记录；这是高风险操作，
  调用前必须获得用户明确确认。
`,
  allowedTools: [
    'builtin-learning_overview',
    'builtin-pomodoro_today_stats',
    'builtin-pomodoro_daily_stats',
    'builtin-pomodoro_record_create',
    'builtin-pomodoro_record_list',
    'builtin-pomodoro_record_delete',
  ],
  embeddedTools: [
    {
      name: 'builtin-learning_overview',
      description:
        '只读聚合学习热力图与番茄钟区间统计，附题库、FSRS、SM-2 当前快照。默认最近 7 天，自定义最多 90 天；数据边界见技能说明。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          start_date: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: '开始日期 YYYY-MM-DD；须与 end_date 同时提供。',
          },
          end_date: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: '结束日期 YYYY-MM-DD，不得晚于本地今天；须与 start_date 同时提供。',
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
              // 校验结构同顶层 start_date/end_date，省略重复的 description 注释
              start_date: {
                type: 'string',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              },
              end_date: {
                type: 'string',
                pattern: '^\\d{4}-\\d{2}-\\d{2}$',
              },
              ...paginationProperties,
            },
          },
        ],
      },
    },
    {
      name: 'builtin-pomodoro_today_stats',
      description: '读取本地今天的番茄钟统计（Low）：完成番茄数、专注秒数、中断次数。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'builtin-pomodoro_daily_stats',
      description: '读取含今天的最近 N 天番茄钟日统计（Low），升序返回；汇总覆盖全部 N 天。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          days: {
            type: 'integer',
            minimum: 1,
            maximum: 90,
            default: 7,
            description: '包含今天在内的天数。',
          },
          ...paginationProperties,
        },
      },
    },
    {
      name: 'builtin-pomodoro_record_create',
      description:
        '补录一次已完成的番茄钟专注记录（Medium）。返回真实记录 ID 与计划/实际秒数；mode/note 仅回显，当前数据表不持久化。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          duration: {
            type: 'integer',
            minimum: 1,
            maximum: 86400,
            description: '计划专注时长（秒）。',
          },
          mode: {
            type: 'string',
            enum: ['countdown', 'stopwatch'],
            default: 'countdown',
            description: '计时方式：倒计时或正计时。',
          },
          todo_id: {
            type: 'string',
            minLength: 1,
            description: '可选，关联的待办 ID。',
          },
          note: {
            type: 'string',
            minLength: 1,
            maxLength: 2000,
            description: '可选备注（当前不持久化）。',
          },
          started_at: {
            type: 'string',
            description: '可选，开始时间（ISO 8601）；省略为当前时间。',
          },
          completed_at: {
            type: 'string',
            description: '可选，完成时间（ISO 8601）；省略按开始时间 + duration 计算。',
          },
        },
        required: ['duration'],
      },
    },
    {
      name: 'builtin-pomodoro_record_list',
      description:
        '按本地日期范围读取番茄钟记录（Low，只读），最新在前。默认最近 7 天、最多 90 天；可按待办过滤并按 has_more 判断是否还有更多。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          start_date: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: '开始日期 YYYY-MM-DD；省略时默认最近 7 天。',
          },
          end_date: {
            type: 'string',
            pattern: '^\\d{4}-\\d{2}-\\d{2}$',
            description: '结束日期 YYYY-MM-DD，不得晚于今天；省略为今天。',
          },
          todo_id: {
            type: 'string',
            minLength: 1,
            description: '可选，仅返回该待办关联的记录。',
          },
          limit: {
            type: 'integer',
            minimum: 1,
            maximum: 100,
            default: 20,
            description: '返回条数上限。',
          },
        },
      },
    },
    {
      name: 'builtin-pomodoro_record_delete',
      description:
        '按记录 ID 删除番茄钟记录（High）。不可撤销，调用前必须获得用户明确确认；不确定 ID 时先用 pomodoro_record_list 查询。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            minLength: 1,
            description: 'pomodoro_record_list 返回的真实记录 ID。',
          },
        },
        required: ['id'],
      },
    },
  ],
};

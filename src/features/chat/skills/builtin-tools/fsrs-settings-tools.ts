import type { SkillDefinition } from '../types';

/**
 * 闪卡 FSRS 调度设置工具组：读取/修改每日新卡上限、每日复习上限、
 * 目标保持率等。与闪卡设置面板（SchedulerSettingsSection）读写同一份
 * 默认牌组 config_json，后端执行器为 FsrsSettingsExecutor。
 */
export const fsrsSettingsToolsSkill: SkillDefinition = {
  id: 'fsrs-settings-tools',
  name: 'fsrs-settings-tools',
  description:
    '读取或修改闪卡 FSRS 调度设置：每日新卡上限、每日复习上限、目标保持率、leech 阈值与处置、调度 fuzz，并附今日额度余量。回答"每天复习多少张""今天还能复习几张""帮我提高每日上限"。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://fsrs-settings-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 闪卡调度设置（FSRS 每日上限等）

## 何时使用

- "每日新卡上限是多少 / 今天还能复习几张"：调用 \`builtin-fsrs_get_scheduler_config\`。
- "把每日新卡上限改成 50 / 目标保持率调到 0.9"：调用 \`builtin-fsrs_update_scheduler_config\`。

## 数据边界

- 作用于默认牌组（全局唯一调度配置），与闪卡应用"统计 → 调度设置"面板同源：
  一处修改，另一处立即可见。
- \`fsrs_get_scheduler_config\` 只读（Low）；\`fsrs_update_scheduler_config\` 写本地配置（Medium，
  可能按用户风险预设要求确认），只更新显式提供的字段，未提供字段保持不变。
- \`dailyLimits\` 反映调用时刻的今日额度：\`newIntroducedToday/reviewsDoneToday\` 是已用量，
  \`newRemainingToday/reviewsRemainingToday\` 是剩余量；Learning/Relearning 中的卡片不占每日额度。
- 上限取值 0–9999；0 表示该类卡片当日不再进入队列。目标保持率必须在 (0,1) 开区间内
  （如 0.85、0.9），过高会显著拉长间隔计算负担，不建议高于 0.99。
- 修改配置只影响之后的调度，不会追溯重排今日队列；删除卡片不在本工具职责内。

## 回答要求

- 上限数量必须区分"新卡"与"复习"两条队列，不得混为一个数字。
- 用户问"今天还能学多少"时用 remaining 字段回答，并说明剩余量会随完成动态变化。
`,
  allowedTools: [
    'builtin-fsrs_get_scheduler_config',
    'builtin-fsrs_update_scheduler_config',
  ],
  embeddedTools: [
    {
      name: 'builtin-fsrs_get_scheduler_config',
      description:
        '只读读取闪卡 FSRS 调度配置与今日额度（Low）：每日新卡/复习上限、目标保持率、leech 阈值与处置、fuzz 开关，以及今日已用/剩余额度。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {},
      },
    },
    {
      name: 'builtin-fsrs_update_scheduler_config',
      description:
        '部分更新闪卡 FSRS 调度配置（Medium，写本地默认牌组）：只更新显式提供的字段，返回更新后的完整配置。至少提供一个字段。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          new_per_day: {
            type: 'integer',
            minimum: 0,
            maximum: 9999,
            description: '每日新卡上限（0–9999；0 表示当日不引入新卡）。',
          },
          reviews_per_day: {
            type: 'integer',
            minimum: 0,
            maximum: 9999,
            description: '每日复习上限（0–9999；0 表示当日不复习到期卡）。',
          },
          desired_retention: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description:
              '目标保持率，(0,1) 开区间小数（不得为 0 或 1，例如 0.9）；越接近 1 复习间隔越短、复习量越大。',
          },
          leech_threshold: {
            type: 'integer',
            minimum: 0,
            maximum: 9999,
            description: 'leech 阈值：累计遗忘次数达到该值时标记 leech。',
          },
          leech_action: {
            type: 'string',
            enum: ['suspend', 'mark'],
            description: 'leech 处置方式：suspend=标记并自动暂停，mark=仅标记。',
          },
          enable_fuzz: {
            type: 'boolean',
            description: '是否启用确定性 fuzz（对间隔加确定性抖动，默认关闭以保持可复现）。',
          },
        },
      },
    },
  ],
};

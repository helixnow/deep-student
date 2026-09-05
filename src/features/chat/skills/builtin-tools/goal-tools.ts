/**
 * Goal 目标模式技能组（P0）
 *
 * 会话级持久目标：目标跨轮次持续存在，本轮结束后系统自动续跑推进，
 * 直到被标记完成。后端 executor：goal_create / goal_update / goal_get
 * （前端工具名带 builtin- 前缀，后端路由时剥离）。
 *
 * @see docs/design/Skills渐进披露架构设计.md
 */

import type { SkillDefinition } from '../types';

export const goalToolsSkill: SkillDefinition = {
  id: 'goal-tools',
  name: 'goal-tools',
  description: '会话目标管理工具：创建跨轮次持续推进的会话目标（系统自动续跑直到完成）、更新目标状态、查询目标进度与预算消耗。仅在用户明确提出需要多步推进的目标时使用。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 5,
  location: 'builtin',
  sourcePath: 'builtin://goal-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 会话目标（Goal）管理技能

> ⚠️ **使用门槛**：仅在用户明确提出一个需要多步推进的目标时才创建（如"帮我把这章错题全部弄懂"）。
> 普通单轮问答不要创建目标。

目标创建后跨轮次持续存在：本轮回答结束后，系统会自动发起续跑轮继续推进，
直到你通过 goal_update 标记完成（complete）或挂起（waiting_user / blocked）。

## 可用工具

- **builtin-goal_create**: 创建会话目标（每会话至多一个未完成目标）
- **builtin-goal_update**: 更新目标状态（complete / blocked / waiting_user）
- **builtin-goal_get**: 获取当前目标状态、预算与已用 token/时间

## 使用流程

1. 用户明确提出多步目标时，用 goal_create 创建（token_budget 除非用户明确要求否则省略）
2. 每轮推进后，若目标已达成，用 goal_update 标记 complete（必须逐条证据核实，不得凭印象）
3. 需要用户回答才能继续时，标记 waiting_user（目标挂起直到用户回复）
4. 同一阻塞条件连续多轮无法推进时，标记 blocked
5. 用 goal_get 查看剩余预算与进度
`,
  embeddedTools: [
    {
      name: 'builtin-goal_create',
      description:
        '创建会话目标。目标跨轮次持续存在：本轮结束后系统自动续跑推进，直到标记完成。仅在用户明确提出需多步推进的目标时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          objective: {
            type: 'string',
            description: '要达成的目标描述，需具体、可验证',
          },
          token_budget: {
            type: 'integer',
            description: 'token 预算上限（正整数）。除非用户明确要求，否则省略。',
          },
        },
        required: ['objective'],
      },
    },
    {
      name: 'builtin-goal_update',
      description:
        '更新当前会话目标状态。仅允许 complete（已逐条证据核实达成）/blocked（同一阻塞连续多轮）/waiting_user（需用户回答才能继续，挂起直到用户回复）。',
      inputSchema: {
        type: 'object',
        properties: {
          status: {
            type: 'string',
            enum: ['complete', 'blocked', 'waiting_user'],
            description: '新状态',
          },
        },
        required: ['status'],
      },
    },
    {
      name: 'builtin-goal_get',
      description: '获取当前会话目标，含状态、预算、已用 token/时间与剩余预算。',
      inputSchema: {
        type: 'object',
        properties: {},
      },
    },
  ],
};

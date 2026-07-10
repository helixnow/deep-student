/**
 * 周期自动化技能组
 *
 * v1：agent 可提案创建每日/每周固定时刻的自动化；审批后落库；
 * 到点发送系统通知并创建带 reminder 的用户待办。
 * v2（2026-07 headless 基建）：新增 action_type=agent_turn——到点由后端
 * headless runner 真正跑一轮完整 agent turn（工具受 headless 白名单约束，
 * 无 MCP/ask_user/shell/子代理），完成后发系统通知（含结果摘要 + 会话入口），
 * 支持 isolated / named 两种会话模式与 interval（每 N 分钟）调度。
 */

import type { SkillDefinition } from '../types';

export const automationToolsSkill: SkillDefinition = {
  id: 'automation-tools',
  name: 'automation-tools',
  description:
    '周期自动化：提案创建每日/每周/间隔调度的自动任务（审批后落库）。notify 类型到点=系统通知+待办；agent_turn 类型到点由后端 headless 跑完整 agent 任务（无人值守、工具受限）并推送结果摘要。可列出/启停已有自动化。',
  version: '2.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://automation-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 周期自动化技能

两种到点动作（action_type）：

- **notify**（默认，v1 行为）：到点发送系统通知 + 在默认待办收件箱创建带 reminder 的待办；**不会**自动执行 agent 任务，用户需手动打开应用。
- **agent_turn**（v2）：到点由后端 **headless runner** 真正跑一轮完整 agent turn（无人值守），完成后发系统通知（含结果摘要，可跳转会话）。适合"每天 21:00 检查到期复习卡并生成今日复习简报"这类自动任务。

## agent_turn 的能力边界（重要）

headless 运行时**没有用户在场**，工具集被策略预过滤（fail-closed）：

- 可用：知识库/记忆/网络检索、记忆写入、学习资源只读、用户待办管理、题库只读统计、复习计划只读（review_get_due / review_stats）等 Low 敏感度后端工具
- **不可用**：全部 MCP 外部工具（依赖前端桥）、ask_user、shell、子代理/workspace、以及一切 Medium/High 敏感度写操作（需人工授权）
- 单次运行硬超时 10 分钟、工具轮次上限 15；运行过程完整落库，用户可随时打开会话查看

## 何时使用

- 用户希望「每晚 21:00 提醒我做错题总结」→ notify
- 用户希望「每天 21:00 自动检查到期复习卡并生成今日复习简报」→ agent_turn + agent_prompt
- 用户希望「每周一 8:00 生成学情周报，且每周在同一会话里递进」→ agent_turn + session_mode=named
- 需要先 **load_skills** 加载本技能后再调用工具

## 创建自动化

1. 向用户确认名称、周期（daily/weekly/interval + 时刻或间隔分钟）、动作类型与任务提示词
2. 调用 **builtin-automation_propose**（**High 审批**，不可记住授权）
3. 审批通过后写入 \`chat_v2.automations\`；返回 id 与下次预计触发时间

## 管理

- **builtin-automation_list**（Low）：查看全部自动化（enabled、action_type、last_run_at、next_trigger_at、agent_session_id 等）
- **builtin-automation_set_enabled**（Medium）：按 id 启用/停用

## 限制

- 最多 **20** 条自动化；name ≤ 100 字符；prompt / agent_prompt ≤ 4000 字符
- schedule.time 必须为 **24 小时制 HH:MM**（如 \`21:00\`）；weekly 必须提供 **weekday**（0=周日 … 6=周六）；interval 必须提供 **interval_minutes**（5–1440）
- 不支持 cron 表达式、编辑已有自动化
- agent_turn 失败/超时也会通知并记录运行历史（心跳类静默）
`,
  embeddedTools: [
    {
      name: 'builtin-automation_propose',
      description:
        '提案创建一条周期自动化（High 审批，不可记住授权）。写入 chat_v2.automations。action_type=notify（默认）：到点发系统通知并创建带 reminder 的待办；action_type=agent_turn：到点由后端 headless 跑完整 agent 任务（无人值守、工具受白名单约束，无 MCP/ask_user/shell/子代理，硬超时 10 分钟），完成后推送结果摘要通知。最多 20 条；daily/weekly 需 time（HH:MM），weekly 需 weekday 0-6，interval 需 interval_minutes 5-1440。',
      inputSchema: {
        type: 'object',
        required: ['name', 'schedule', 'prompt'],
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            description: '自动化名称（≤100 字符，显示在通知与待办标题）',
          },
          schedule: {
            type: 'object',
            required: ['kind'],
            additionalProperties: false,
            properties: {
              kind: {
                type: 'string',
                enum: ['daily', 'weekly', 'interval'],
                description:
                  'daily=每日固定时刻；weekly=每周固定 weekday + 时刻；interval=每 N 分钟（心跳类检查）',
              },
              time: {
                type: 'string',
                description: '24 小时制 HH:MM，如 21:00（daily/weekly 必填，interval 忽略）',
              },
              weekday: {
                type: 'integer',
                minimum: 0,
                maximum: 6,
                description: 'weekly 必填：0=周日 … 6=周六',
              },
              interval_minutes: {
                type: 'integer',
                minimum: 5,
                maximum: 1440,
                description: 'interval 必填：间隔分钟数（5–1440）',
              },
            },
          },
          prompt: {
            type: 'string',
            description:
              '任务说明（≤4000 字符）。notify 类型：写入通知正文与待办描述；agent_turn 类型：未提供 agent_prompt 时作为 agent 任务提示词',
          },
          action_type: {
            type: 'string',
            enum: ['notify', 'agent_turn'],
            default: 'notify',
            description:
              '到点动作：notify=仅通知+待办（默认）；agent_turn=后端 headless 真跑一轮 agent 任务并推送结果摘要',
          },
          agent_prompt: {
            type: 'string',
            description:
              '仅 action_type=agent_turn 有效：headless agent 的任务提示词（≤4000 字符），如"检查到期复习卡并生成今日复习简报，写入用户待办"。缺省时回退使用 prompt',
          },
          session_mode: {
            type: 'string',
            enum: ['isolated', 'named'],
            default: 'isolated',
            description:
              '仅 action_type=agent_turn 有效：isolated=每次运行新建独立会话（默认，适合日报/检查类）；named=固定会话跨运行积累上下文（适合"每周学情报告"这类需要参考上次结果的任务）',
          },
          model_id: {
            type: 'string',
            description:
              '仅 action_type=agent_turn 有效：指定运行模型的配置 ID，缺省使用默认对话模型',
          },
          enabled: {
            type: 'boolean',
            default: true,
            description: '是否立即启用，默认 true',
          },
        },
      },
    },
    {
      name: 'builtin-automation_list',
      description:
        '列出全部周期自动化（Low）。含 enabled、action_type、session_mode、last_run_at、next_trigger_at、agent_session_id；无参数。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-automation_set_enabled',
      description:
        '按 id 启用或停用自动化（Medium 审批）。停用后调度器不再触发。',
      inputSchema: {
        type: 'object',
        required: ['id', 'enabled'],
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description: 'automation_propose 返回的 id（auto_<毫秒>_<4位>）',
          },
          enabled: {
            type: 'boolean',
            description: 'true=启用，false=停用',
          },
        },
      },
    },
  ],
};

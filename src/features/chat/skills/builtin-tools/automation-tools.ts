/**
 * 周期自动化技能组
 *
 * v1：agent 可提案创建每日/每周固定时刻的自动化；审批后落库；
 * 到点发送系统通知并创建带 reminder 的用户待办。
 * v2（2026-07 headless 基建）：新增 action_type=agent_turn——到点由后端
 * headless runner 真正跑一轮完整 agent turn（工具受 headless 白名单约束，
 * 无 MCP/ask_user/shell/子代理），完成后发系统通知；运行历史提供会话入口，
 * 支持 isolated / named 两种会话模式与 interval（每 N 分钟）调度。
 */

import type { SkillDefinition } from '../types';

export const automationToolsSkill: SkillDefinition = {
  id: 'automation-tools',
  name: 'automation-tools',
  description:
    '周期自动化：创建、查看、完整修改、启停、立即运行、查询历史、重试、取消或删除每日/工作日/每周/每月/间隔调度。notify 类型到点=系统通知+待办；agent_turn 类型到点由后端 headless 跑完整 Agent 任务并推送结果摘要。',
  version: '4.0.0',
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
- **agent_turn**（v2）：到点由后端 **headless runner** 真正跑一轮完整 agent turn（无人值守），完成后发系统通知（含结果摘要），并可从运行历史打开对应会话。适合"每天 21:00 检查到期复习卡并生成今日复习简报"这类自动任务。

## agent_turn 的能力边界（重要）

headless 运行时**没有用户在场**，工具集被策略预过滤（fail-closed）：

- 可用：知识库/网络检索、记忆只读、学习资源只读、用户待办只读、题库只读统计、复习计划只读（review_get_due / review_stats）等 Low 敏感度后端工具
- 默认**不可用**：全部 MCP 外部工具（依赖前端桥）、ask_user、shell、子代理/workspace、以及一切 Medium/High 敏感度写操作（需人工授权）
- 仅当用户显式保存并锁定 trusted_profile 时，可额外开放受控 shell/workspace 工具；profile 固定工具、RO/RW roots、命令前缀、网络域、轮次/超时/输出预算及回滚要求，内容 hash 不匹配即拒绝运行
- 单次运行硬超时 10 分钟、工具轮次上限 15；运行过程完整落库，用户可随时打开会话查看

## 何时使用

- 用户希望「每晚 21:00 提醒我做错题总结」→ notify
- 用户希望「每天 21:00 自动检查到期复习卡并生成今日复习简报」→ agent_turn + agent_prompt
- 用户希望「每周一 8:00 生成学情周报，且每周在同一会话里递进」→ agent_turn + session_mode=named
- 需要先 **load_skills** 加载本技能后再调用工具

## 创建自动化

1. 向用户确认名称、周期（daily/weekdays/weekly/monthly/interval）、时区、动作类型与任务提示词
2. 调用 **builtin-automation_propose**（**High 审批**，不可记住授权）
3. 审批通过后写入持久化自动化定义；返回 id 与下次预计触发时间

## 管理

- **builtin-automation_list**（Low）：查看全部自动化（version、enabled、action_type、last_run_at、next_trigger_at、agent_session_id 等）
- **builtin-automation_set_enabled**（Medium）：按 id 启用/停用；必须把 list 返回的 version 传为 expected_version
- **builtin-automation_update**（Medium）：修改名称、调度、动作、提示词、会话、补偿、重试或超时；先 list 确认目标并把当前 version 原样传为 expected_version。版本冲突时必须重新 list 和规划，禁止用猜测版本覆盖
- **builtin-automation_run_now**（Medium）：绕过下次调度时间立即运行一次；必须携带 expected_version，避免运行已被改写的任务
- **builtin-automation_runs**（Low）：查询运行历史、状态、摘要和错误
- **builtin-automation_retry_run**（Medium）：重试失败、超时、启动失败或已取消的运行
- **builtin-automation_cancel_run**（Medium）：取消排队、重试等待或正在执行的运行
- **builtin-automation_delete**（High，不可恢复）：必须先用 builtin-ask_user 列明名称与周期并取得确认，不得记住授权；确认前读取的 version 必须原样传为 expected_version。内置心跳不可删除，只能停用

## 限制

- 最多 **20** 条自动化；name ≤ 100 字符；prompt / agent_prompt ≤ 4000 字符
- schedule.time 必须为 **24 小时制 HH:MM**（如 \`21:00\`）；weekly 必须提供 **weekday**（0=周日 … 6=周六）；monthly 必须提供 **day_of_month**（1–31，短月份落到月末）；interval 必须提供 **interval_minutes**（5–1440）
- 非 interval 调度可提供 IANA \`timezone\`（如 \`Asia/Shanghai\`）；不支持 cron 表达式
- 补偿策略：skip=错过后跳过，run_once=恢复后补跑一次，catch_up_all=按历史时点逐次追赶
- agent_turn 失败/超时也会通知并记录运行历史（心跳类静默）
- set_enabled/update/delete/run_now 缺少 expected_version 时稳定返回 \`AUTOMATION_OCC_REQUIRED\`；版本冲突返回 \`AUTOMATION_VERSION_CONFLICT\` 与 current，必须重新 list
`,
  allowedTools: [
    'builtin-automation_propose',
    'builtin-automation_list',
    'builtin-automation_set_enabled',
    'builtin-automation_update',
    'builtin-automation_delete',
    'builtin-automation_run_now',
    'builtin-automation_runs',
    'builtin-automation_retry_run',
    'builtin-automation_cancel_run',
  ],
  embeddedTools: [
    {
      name: 'builtin-automation_propose',
      description:
        '提案创建一条周期自动化（High 审批，不可记住授权）。action_type=notify（默认）：到点发系统通知并创建待办；action_type=agent_turn：到点由后端 headless 跑完整 Agent 任务，完成后推送结果摘要。最多 20 条；支持 daily/weekdays/weekly/monthly/interval、IANA 时区、补偿策略和失败重试。',
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
                enum: ['daily', 'weekdays', 'weekly', 'monthly', 'interval'],
                description:
                  'daily=每日；weekdays=工作日；weekly=每周；monthly=每月；interval=每 N 分钟',
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
              day_of_month: {
                type: 'integer',
                minimum: 1,
                maximum: 31,
                description: 'monthly 必填；短月份自动使用该月最后一天',
              },
              interval_minutes: {
                type: 'integer',
                minimum: 5,
                maximum: 1440,
                description: 'interval 必填：间隔分钟数（5–1440）',
              },
              timezone: {
                type: 'string',
                description: '非 interval 可选的 IANA 时区，如 Asia/Shanghai；缺省使用系统时区',
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
              '仅 action_type=agent_turn 有效：headless agent 的任务提示词（≤4000 字符），如"检查到期复习卡并生成今日复习简报"。缺省时回退使用 prompt；headless 只能读取用户待办，不能写入',
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
          catch_up_policy: {
            type: 'string',
            enum: ['skip', 'run_once', 'catch_up_all'],
            default: 'run_once',
            description: '应用离线错过时点后的补偿方式',
          },
          max_retries: {
            type: 'integer',
            minimum: 0,
            maximum: 10,
            default: 2,
            description: '失败后的自动重试次数',
          },
          retry_backoff_seconds: {
            type: 'integer',
            minimum: 5,
            maximum: 86400,
            default: 60,
            description: '首次重试退避秒数，后续指数增长',
          },
          timeout_seconds: {
            type: 'integer',
            minimum: 30,
            maximum: 3600,
            default: 600,
            description: '单次 agent_turn 硬超时秒数',
          },
          trusted_profile: {
            type: 'object',
            description: '仅 agent_turn：显式预授权且带内容哈希锁的 trusted AutomationProfile。普通自动化不要设置。',
            additionalProperties: false,
            required: ['schemaVersion', 'profileHash', 'allowedTools', 'runtimeRoots', 'shellCommandPrefixes', 'networkDomains', 'maxToolRounds', 'timeoutSeconds', 'maxOutputBytes', 'rollbackRequired'],
            properties: {
              schemaVersion: { type: 'integer', enum: [1] },
              profileHash: { type: 'string', pattern: '^(|[0-9a-fA-F]{64})$', description: '创建/更新时可传空字符串，由后端 canonical seal 后回传并持久化；非空值必须与内容匹配。' },
              allowedTools: { type: 'array', items: { type: 'string' }, minItems: 1 },
              runtimeRoots: { type: 'array', minItems: 1, items: { type: 'object', required: ['rootId', 'access'], properties: { rootId: { type: 'string' }, access: { type: 'string', enum: ['read_only', 'read_write'] } }, additionalProperties: false } },
              shellCommandPrefixes: { type: 'array', items: { type: 'string' } },
              networkDomains: { type: 'array', items: { type: 'string' } },
              maxToolRounds: { type: 'integer', minimum: 1, maximum: 30 },
              timeoutSeconds: { type: 'integer', minimum: 30, maximum: 3600 },
              maxOutputBytes: { type: 'integer', minimum: 1, maximum: 4194304 },
              rollbackRequired: { type: 'boolean' },
            },
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
        '按 id 启用或停用自动化（Medium 审批）。先 list 并将当前 version 原样传为 expected_version；冲突后重新读取。停用后调度器不再触发。',
      inputSchema: {
        type: 'object',
        required: ['id', 'expected_version', 'enabled'],
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description: 'automation_propose 返回的 id（auto_<毫秒>_<4位>）',
          },
          expected_version: {
            type: 'integer',
            minimum: 1,
            description: 'automation_list 返回的当前 version',
          },
          enabled: {
            type: 'boolean',
            description: 'true=启用，false=停用',
          },
        },
      },
    },
    {
      name: 'builtin-automation_update',
      description:
        '完整修改已有自动化（Medium 审批）。先用 automation_list 读取当前 version，并原样传入 expected_version；版本冲突时重新读取，禁止盲重试。可修改名称、调度、动作类型、提示词、Agent 会话/模型、补偿策略、重试和超时；至少提供一个待修改字段。返回修改前后快照。',
      inputSchema: {
        type: 'object',
        required: ['id', 'expected_version'],
        anyOf: [
          { required: ['schedule'] },
          { required: ['prompt'] },
          { required: ['name'] },
          { required: ['action_type'] },
          { required: ['agent_prompt'] },
          { required: ['session_mode'] },
          { required: ['model_id'] },
          { required: ['catch_up_policy'] },
          { required: ['max_retries'] },
          { required: ['retry_backoff_seconds'] },
          { required: ['timeout_seconds'] },
        ],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, description: 'automation_list 返回的自动化 ID' },
          expected_version: { type: 'integer', minimum: 1, description: 'automation_list 返回的当前 version；用于乐观并发控制' },
          name: { type: 'string', minLength: 1, maxLength: 100, description: '新名称' },
          schedule: {
            type: 'object',
            required: ['kind'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly', 'interval'] },
              time: { type: 'string', description: '非 interval 必填：24 小时制 HH:MM' },
              weekday: { type: 'integer', minimum: 0, maximum: 6, description: 'weekly 必填：0=周日…6=周六' },
              day_of_month: { type: 'integer', minimum: 1, maximum: 31, description: 'monthly 必填' },
              interval_minutes: { type: 'integer', minimum: 5, maximum: 1440, description: 'interval 必填：间隔分钟数' },
              timezone: { type: 'string', description: '非 interval 可选 IANA 时区' },
            },
          },
          prompt: { type: 'string', minLength: 1, maxLength: 4000, description: '新任务说明/提示词' },
          action_type: { type: 'string', enum: ['notify', 'agent_turn'] },
          agent_prompt: { type: 'string', maxLength: 4000, description: 'Agent 提示词；空字符串清除并回退到 prompt' },
          session_mode: { type: 'string', enum: ['isolated', 'named'] },
          model_id: { type: 'string', description: '模型配置 ID；空字符串清除' },
          catch_up_policy: { type: 'string', enum: ['skip', 'run_once', 'catch_up_all'] },
          max_retries: { type: 'integer', minimum: 0, maximum: 10 },
          retry_backoff_seconds: { type: 'integer', minimum: 5, maximum: 86400 },
          timeout_seconds: { type: 'integer', minimum: 30, maximum: 3600 },
          trusted_profile: { type: 'object', description: '替换 trusted profile；调用底层更新 API 时传 null 可清除并恢复默认只读 headless。' },
        },
      },
    },
    {
      name: 'builtin-automation_delete',
      description:
        '永久删除一条自动化（High，不可恢复）。调用前必须加载 ask-user 技能，用 builtin-ask_user 列明自动化名称、周期和动作并取得明确确认；不得记住该授权。确认前 list 返回的 version 必须作为 expected_version，冲突后重新确认。返回 success、automationId、deleted（删除前快照）、reversible=false 与 restoreWith=null。',
      inputSchema: {
        type: 'object',
        required: ['id', 'expected_version'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, description: '要永久删除的自动化 ID' },
          expected_version: { type: 'integer', minimum: 1, description: '确认前 automation_list 返回的 version' },
        },
      },
    },
    {
      name: 'builtin-automation_run_now',
      description:
        '绕过调度时点，立即运行一条自动化（Medium 审批）。必须把 automation_list 返回的 version 传为 expected_version，冲突后重新读取再决定是否运行。notify 类型会立即发通知并建待办；agent_turn 类型会启动 headless 任务。返回 success 与 result；result 含 status、automationId，agent_turn 还含 timeoutSecs。运行副作用不可撤销（reversible=false）。',
      inputSchema: {
        type: 'object',
        required: ['id', 'expected_version'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, description: '要立即运行的自动化 ID' },
          expected_version: { type: 'integer', minimum: 1, description: 'automation_list 返回的当前 version' },
        },
      },
    },
    {
      name: 'builtin-automation_runs',
      description:
        '查询自动化运行历史（Low）。可按 automation_id 筛选，返回状态、触发类型、尝试次数、摘要、错误和会话 ID。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          automation_id: { type: 'string', minLength: 1, description: '可选的自动化 ID' },
          page: { type: 'integer', minimum: 1, default: 1 },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
        },
      },
    },
    {
      name: 'builtin-automation_retry_run',
      description:
        '重试一条失败、超时、启动失败或已取消的运行（Medium 审批）。返回 success 与 runId。',
      inputSchema: {
        type: 'object',
        required: ['id'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, description: 'automation_runs 返回的运行 ID' },
        },
      },
    },
    {
      name: 'builtin-automation_cancel_run',
      description:
        '取消排队、等待重试或正在执行的运行（Medium 审批）。正在运行的 headless 管线会收到取消信号。',
      inputSchema: {
        type: 'object',
        required: ['id'],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, description: 'automation_runs 返回的运行 ID' },
        },
      },
    },
  ],
};

/**
 * 周期自动化技能组
 *
 * v1：agent 可提案创建每日/每周固定时刻的自动化；审批后落库；
 * 到点发送系统通知并创建带 reminder 的用户待办。
 * v2（2026-07 headless 基建）：新增 action_type=agent_turn——到点由后端
 * headless runner 真正跑一轮完整 agent turn（工具受 headless 白名单约束，
 * 无 MCP/ask_user/shell/子代理），完成后发系统通知；运行历史提供会话入口，
 * 支持 isolated / named 两种会话模式与 interval（每 N 分钟）调度。
 * v4.1（定时任务改造）：新增 once 单次调度（kind=once + date=YYYY-MM-DD，
 * 触发一次后自动完成）；list 输出附带人话调度/相对时间/上次运行状态/容量；
 * runs 支持按状态过滤。
 */

import type { SkillDefinition } from '../types';

export const automationToolsSkill: SkillDefinition = {
  id: 'automation-tools',
  name: 'automation-tools',
  description:
    '定时自动化：创建、查看、完整修改、启停、立即运行、查询历史、重试、取消或删除每日/工作日/每周/每月/间隔/单次（once）调度。notify 类型到点=系统通知+待办；agent_turn 类型到点由后端 headless 跑完整 Agent 任务并推送结果摘要。',
  version: '4.1.0',
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
- 用户希望「明天 09:00 提醒我复习」→ notify + schedule.kind=once（单次，触发后自动完成）
- 用户希望「每天 21:00 自动检查到期复习卡并生成今日复习简报」→ agent_turn + agent_prompt
- 用户希望「每周一 8:00 生成学情周报，且每周在同一会话里递进」→ agent_turn + session_mode=named
- 需要先 **load_skills** 加载本技能后再调用工具

## 创建自动化

1. 向用户确认名称、周期（daily/weekdays/weekly/monthly/interval/once）、时区、动作类型与任务提示词
2. **确认前先给用户一个预览**：用人话复述调度（如「每天 21:00」「仅 2026-07-20 09:00 一次」）和首次运行时间，确认无歧义再提案
3. 调用 **builtin-automation_propose**（**High 审批**，不可记住授权）
4. 审批通过后写入持久化自动化定义；返回 id、schedule_description（人话调度）、next_trigger_at 与 next_trigger_relative（相对描述，如「约 2 小时后」），向用户转述首次运行时间

## 管理

- **builtin-automation_list**（Low）：查看全部自动化（version、enabled、action_type、last_run_at、next_trigger_at、agent_session_id 等），并附带 schedule_description（人话调度）、next_trigger_relative（下次运行相对描述）、last_run_status/last_run_summary（上次运行结果）、once_completed（单次任务是否已完成）与 capacity（容量占用）。用户问"我有哪些定时任务"时直接调用本工具并转述这些字段
- **builtin-automation_set_enabled**（Medium）：按 id 启用/停用；必须把 list 返回的 version 传为 expected_version
- **builtin-automation_update**（Medium）：修改名称、调度、动作、提示词、会话、补偿、重试或超时；先 list 确认目标并把当前 version 原样传为 expected_version。版本冲突时必须重新 list 和规划，禁止用猜测版本覆盖
- **builtin-automation_run_now**（Medium）：绕过下次调度时间立即运行一次；必须携带 expected_version，避免运行已被改写的任务
- **builtin-automation_runs**（Low）：查询运行历史、状态、摘要和错误；支持 page/page_size 分页与 status 过滤（过滤在当前页内进行）
- **builtin-automation_retry_run**（Medium）：重试失败、超时、启动失败或已取消的运行
- **builtin-automation_cancel_run**（Medium）：取消排队、重试等待或正在执行的运行
- **builtin-automation_delete**（High，不可恢复）：必须先用 builtin-ask_user 列明名称与周期并取得确认，不得记住授权；确认前读取的 version 必须原样传为 expected_version。内置心跳不可删除，只能停用

## 限制

- 最多 **20** 条自动化（list 返回 count/max/capacity）；name ≤ 100 字符；prompt / agent_prompt ≤ 4000 字符
- schedule.time 必须为 **24 小时制 HH:MM**（如 \`21:00\`）；weekly 必须提供 **weekday**（0=周日 … 6=周六）或多天集合 **weekdays**（如每周一三五 → \`[1,3,5]\`，两者同时提供以 weekdays 为准）；monthly 必须提供 **day_of_month**（1–31，短月份落到月末）；interval 必须提供 **interval_minutes**（5–1440）；once 必须提供 **date**（YYYY-MM-DD，不能是过去时点），触发一次后自动完成、不再重复
- 非 interval 调度可提供 IANA \`timezone\`（如 \`Asia/Shanghai\`）；不支持 cron 表达式
- 补偿策略：skip=错过后跳过，run_once=恢复后补跑一次，catch_up_all=按历史时点逐次追赶
- agent_turn 失败/超时也会通知并记录运行历史（心跳类静默）
- set_enabled/update/delete/run_now 缺少 expected_version 时稳定返回 \`AUTOMATION_OCC_REQUIRED\`；版本冲突返回 \`AUTOMATION_VERSION_CONFLICT\` 与 current，必须重新 list；同一自动化已有运行在执行时返回 \`AUTOMATION_RUN_ALREADY_ACTIVE\`，先用 automation_runs 查看或 cancel 后再试。错误 JSON 中的 hint 字段是给你的下一步建议，直接照做并向用户解释
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
        '提案创建定时自动化（High 审批，不可记住授权）。调用前先用人话向用户预览调度与首次运行时间，确认无歧义再提案。notify（默认）=到点发通知并建待办；agent_turn=后端 headless 跑完整 Agent 任务并推送结果摘要。最多 20 条。返回 schedule_description 与 next_trigger_relative，用于转述首次运行时间。',
      inputSchema: {
        type: 'object',
        required: ['name', 'schedule', 'prompt'],
        additionalProperties: false,
        properties: {
          name: {
            type: 'string',
            description: '自动化名称（≤100 字符）',
          },
          schedule: {
            type: 'object',
            required: ['kind'],
            additionalProperties: false,
            properties: {
              kind: {
                type: 'string',
                enum: ['daily', 'weekdays', 'weekly', 'monthly', 'interval', 'once'],
                description:
                  'daily=每日；weekdays=工作日；weekly=每周；monthly=每月；interval=每 N 分钟；once=单次（触发后自动完成）',
              },
              time: {
                type: 'string',
                description: '24 小时制 HH:MM（interval 以外必填）',
              },
              date: {
                type: 'string',
                description: 'once 必填：目标日期 YYYY-MM-DD（不能是过去时点）',
              },
              weekday: {
                type: 'integer',
                minimum: 0,
                maximum: 6,
                description: 'weekly 单天：0=周日…6=周六（有 weekdays 时可省略）',
              },
              weekdays: {
                type: 'array',
                items: { type: 'integer', minimum: 0, maximum: 6 },
                minItems: 1,
                description: 'weekly 多天集合（0=周日…6=周六）；与 weekday 同时提供以本字段为准',
              },
              day_of_month: {
                type: 'integer',
                minimum: 1,
                maximum: 31,
                description: 'monthly 必填；短月份落到月末',
              },
              interval_minutes: {
                type: 'integer',
                minimum: 5,
                maximum: 1440,
                description: 'interval 必填：间隔分钟数',
              },
              timezone: {
                type: 'string',
                description: '非 interval 可选 IANA 时区；缺省系统时区',
              },
            },
          },
          prompt: {
            type: 'string',
            description:
              '任务说明（≤4000 字符）。notify：写入通知正文与待办描述；agent_turn：缺省 agent_prompt 时作为其提示词',
          },
          action_type: {
            type: 'string',
            enum: ['notify', 'agent_turn'],
            default: 'notify',
            description: '到点动作：notify=通知+待办（默认）；agent_turn=headless 跑 agent 任务',
          },
          agent_prompt: {
            type: 'string',
            description:
              '仅 agent_turn：headless 任务提示词（≤4000 字符），缺省回退使用 prompt',
          },
          session_mode: {
            type: 'string',
            enum: ['isolated', 'named'],
            default: 'isolated',
            description:
              '仅 agent_turn：isolated=每次新建独立会话（默认）；named=固定会话跨运行积累上下文',
          },
          model_id: {
            type: 'string',
            description: '仅 agent_turn：运行模型配置 ID，缺省默认对话模型',
          },
          enabled: {
            type: 'boolean',
            default: true,
            description: '是否立即启用',
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
              profileHash: { type: 'string', pattern: '^(|[0-9a-fA-F]{64})$', description: '创建/更新可传空字符串，由后端 seal 后回传；非空必须与内容匹配' },
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
        '列出全部定时自动化（Low，无参数）。每条含 id、version、enabled、action_type、schedule_description（人话调度）、next_trigger_relative、last_run_status/last_run_summary、once_completed、agent_session_id 等；顶层含 count/max/capacity。回答"我有哪些定时任务"时转述人话调度、下次运行相对时间与上次运行状态即可。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-automation_set_enabled',
      description:
        '按 id 启用或停用自动化（Medium 审批）。先 list 并把当前 version 传为 expected_version；冲突后重新读取。',
      inputSchema: {
        type: 'object',
        required: ['id', 'expected_version', 'enabled'],
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description: 'automation_list 返回的自动化 ID',
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
        '修改已有自动化（Medium 审批）。先 list 读取当前 version 并传为 expected_version；冲突时重新读取，禁止盲重试。至少提供一个待修改字段；返回修改前后快照。',
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
          { required: ['trusted_profile'] },
        ],
        additionalProperties: false,
        properties: {
          id: { type: 'string', minLength: 1, description: 'automation_list 返回的自动化 ID' },
          expected_version: { type: 'integer', minimum: 1, description: 'automation_list 返回的当前 version' },
          name: { type: 'string', minLength: 1, maxLength: 100, description: '新名称' },
          schedule: {
            type: 'object',
            required: ['kind'],
            additionalProperties: false,
            properties: {
              kind: { type: 'string', enum: ['daily', 'weekdays', 'weekly', 'monthly', 'interval', 'once'] },
              time: { type: 'string', description: '非 interval 必填：24 小时制 HH:MM' },
              date: { type: 'string', description: 'once 必填：YYYY-MM-DD（不能是过去时点）' },
              weekday: { type: 'integer', minimum: 0, maximum: 6, description: 'weekly 单天：0=周日…6=周六' },
              weekdays: {
                type: 'array',
                items: { type: 'integer', minimum: 0, maximum: 6 },
                minItems: 1,
                description: 'weekly 多天集合；与 weekday 同时提供以本字段为准',
              },
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
          trusted_profile: { type: 'object', description: '替换 trusted profile；底层 API 传 null 可清除并恢复默认只读 headless' },
        },
      },
    },
    {
      name: 'builtin-automation_delete',
      description:
        '永久删除自动化（High，不可恢复）。先用 builtin-ask_user 列明名称、周期和动作并取得明确确认，不得记住授权；确认前 list 返回的 version 传为 expected_version，冲突后重新确认。返回删除前快照，reversible=false。',
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
        '绕过调度时点，立即运行一条自动化（Medium 审批）。必须把 list 返回的 version 传为 expected_version，冲突后重新读取。notify 立即发通知并建待办；agent_turn 启动 headless 任务。运行副作用不可撤销。',
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
        '查询自动化运行历史（Low，只读）。可按 automation_id 与 status 筛选，支持分页；返回状态、摘要、错误和会话 ID。status 过滤在当前页内进行，需要更多匹配时递增 page。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          automation_id: { type: 'string', minLength: 1, description: '可选：只看某条自动化的运行记录' },
          status: {
            type: 'string',
            enum: ['queued', 'running', 'retrying', 'success', 'error', 'timeout', 'spawn_error', 'cancelled', 'heartbeat_ok', 'skipped'],
            description: '可选：按运行状态过滤（当前页内）',
          },
          page: { type: 'integer', minimum: 1, default: 1, description: '页码，从 1 开始' },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20, description: '每页条数' },
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

/** Agent-safe LLM usage reporting tools. */

import type { SkillDefinition } from '../types';

const dateProperty = {
  type: 'string' as const,
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
  description: '真实日历日期 YYYY-MM-DD',
};

// oneOf 分支复用的日期约束：校验结构与顶层 dateProperty 一致，
// 仅省略 description 注释以避免 schema 序列化后重复计费（token 预算）
const dateBranchProperty = {
  type: 'string' as const,
  pattern: '^\\d{4}-\\d{2}-\\d{2}$',
};

const offsetProperty = {
  type: 'integer' as const,
  minimum: 0,
  maximum: 100_000,
  default: 0,
};
const limitProperty = { type: 'integer' as const, minimum: 1, maximum: 20, default: 20 };

export const llmUsageToolsSkill: SkillDefinition = {
  id: 'llm-usage-tools',
  name: 'llm-usage-tools',
  description:
    '查询本地记录的 LLM token/调用用量：区间汇总、小时/日趋势、按模型或调用方分组、最近调用。成本一律标为 estimated，并明确区分缺失定价。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 7,
  location: 'builtin',
  sourcePath: 'builtin://llm-usage-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# LLM 用量查询

使用 **builtin-llm_usage_query**（Low）查询本地用量记录。action 与参数严格配对：

- \`summary\`：start_date + end_date，回答“本月用了多少 token / 估算花费”。
- \`trends\`：days + granularity(hour|day)，用于近期趋势；hour 最多 31 天。
- \`by_model\` / \`by_caller\`：start_date + end_date，分页查看模型或调用方分布。
- \`recent\`：只接受 offset/limit，查看最近调用。

日期必须是严格 YYYY-MM-DD 的真实日历日期，start_date 不得晚于 end_date。列表默认每页 20、最多 20。不得给 action 混入其他分支的字段。

所有货币字段都是 **estimated cost（估算成本）**。汇总或分组结果的 \`cost.priceCoverage\` 给出定价覆盖状态、已定价/总请求数及 token 覆盖率；缺定价时 \`cost.estimatedUsd\` 可为 null，这不代表免费，回答时必须明确说明。模型、调用方与错误文本均经过有界输出处理，不返回请求正文、API key 或认证信息。
`,
  allowedTools: ['builtin-llm_usage_query'],
  embeddedTools: [
    {
      name: 'builtin-llm_usage_query',
      description:
        '查询本地 LLM 用量（Low），action 与参数严格配对（见 oneOf）。成本仅为 estimated；缺定价时 estimatedUsd 可为 null，不等于免费。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          action: {
            type: 'string',
            enum: ['summary', 'trends', 'by_model', 'by_caller', 'recent'],
          },
          start_date: dateProperty,
          end_date: dateProperty,
          days: { type: 'integer', minimum: 1, maximum: 366 },
          granularity: { type: 'string', enum: ['hour', 'day'] },
          offset: offsetProperty,
          limit: limitProperty,
        },
        oneOf: [
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'start_date', 'end_date'],
            properties: {
              action: { type: 'string', enum: ['summary'] },
              start_date: dateBranchProperty,
              end_date: dateBranchProperty,
            },
          },
          {
            type: 'object',
            additionalProperties: false,
            required: ['action', 'days', 'granularity'],
            properties: {
              action: { type: 'string', enum: ['trends'] },
              days: { type: 'integer', minimum: 1, maximum: 366 },
              granularity: { type: 'string', enum: ['hour', 'day'] },
              offset: offsetProperty,
              limit: limitProperty,
            },
          },
          ...(['by_model', 'by_caller'] as const).map((action) => ({
            type: 'object' as const,
            additionalProperties: false,
            required: ['action', 'start_date', 'end_date'],
            properties: {
              action: { type: 'string' as const, enum: [action] },
              start_date: dateBranchProperty,
              end_date: dateBranchProperty,
              offset: offsetProperty,
              limit: limitProperty,
            },
          })),
          {
            type: 'object',
            additionalProperties: false,
            required: ['action'],
            properties: {
              action: { type: 'string', enum: ['recent'] },
              offset: offsetProperty,
              limit: limitProperty,
            },
          },
        ],
      },
    },
  ],
};

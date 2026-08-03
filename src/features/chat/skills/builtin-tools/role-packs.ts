import type { SkillDefinition } from '../types';

const PACK_ID = {
  type: 'string' as const,
  description: 'Role pack id returned by role_pack_list',
};

const VERSION = {
  type: 'string' as const,
  pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+$',
  description: 'Exact immutable pack version. Omit only when latest is explicitly acceptable.',
};

export const rolePacksSkill: SkillDefinition = {
  id: 'role-packs',
  name: 'role-packs',
  description:
    '精选岗位专家与可审计工作流入口。提供 finance、legal、hr、operations、admin、research、teaching、content 的版本化 Role Packs，以及 invoice reconcile、contract review、resume batch、mail merge、operations report 工作流。只读发现/校验；高风险结论和最终发送必须人工终审。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 9,
  location: 'builtin',
  sourcePath: 'builtin://role-packs',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 精选岗位专家（Role Packs）

Role Pack 是数据驱动、可版本锁定的专业工作流契约，不是自动决策代理。

1. 用 \`builtin-role_pack_list\` 查看全部 pack 与历史版本。
2. 用 \`builtin-role_pack_get\` 取得精确版本的 input schema、rules/rubric、template refs、capabilities、exception queue、verification gates、delivery manifest 与可组合工作流。
3. 用 \`builtin-role_pack_validate\` 校验输入并把选定的 \`pack_id@version\` 写入持久化工具块中的 task provenance/audit manifest。
4. 后续工具执行必须携带该精确版本；不要把旧版本静默升级。

## 人工终审

invoice reconcile、contract review、resume batch、mail merge、operations report 均只产生草稿、差异、异常队列和交付 manifest。财务批准、法律结论、招聘决定、外发邮件和运营签发必须由具备权限的人最终审阅；Role Pack 不允许自动作出最终决定或发送。
`,
  embeddedTools: [
    {
      name: 'builtin-role_pack_list',
      description: '只读列出 Role Pack registry。默认包含历史/废弃版本，保证旧任务可以继续精确选择旧版本。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          domain: {
            type: 'string',
            enum: ['finance', 'legal', 'hr', 'operations', 'admin', 'research', 'teaching', 'content'],
          },
          include_deprecated: { type: 'boolean', default: true },
        },
      },
    },
    {
      name: 'builtin-role_pack_get',
      description: '只读取得一个 Role Pack。传 version 时严格精确匹配，并返回 task provenance/audit manifest。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pack_id'],
        properties: { pack_id: PACK_ID, version: VERSION },
      },
    },
    {
      name: 'builtin-role_pack_validate',
      description:
        '只读校验 inputs 是否满足精确 Role Pack 版本，并生成带 input digest 的 task provenance/audit manifest。通过 schema 不等于专业终审通过。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['pack_id', 'version', 'inputs'],
        properties: {
          pack_id: PACK_ID,
          version: VERSION,
          inputs: { type: 'object', additionalProperties: true },
        },
      },
    },
  ],
};

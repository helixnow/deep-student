import type { SkillDefinition } from '../types';

const TASK_OBJECT_HANDLE = {
  type: 'object' as const,
  description: '完整 TaskObjectHandle，包含稳定 handleId、来源、能力、hash 及可选 managed locator。',
};

export const taskGovernanceToolsSkill: SkillDefinition = {
  id: 'task-governance-tools',
  name: 'task-governance-tools',
  description: '任务审计导出与可验证的 lineage forget。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 9,
  location: 'builtin',
  sourcePath: 'builtin://task-governance-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# Task Governance

用 builtin-task_audit_export 生成可外发的 TaskAuditManifest。输入必须包含本次任务实际观察到的 TaskObjectHandle、工具调用、审批、输出 hash、connector 收件人/ACL、Role Pack 精确版本，以及 change/rollback coverage。导出会递归脱敏秘密字段。当前证据由调用方聚合，因此 evidenceOrigin=caller_supplied、authoritative=false，并始终缺少 backend_session_ledger；不得声称是权威审计包。

用户要求忘记附件及其派生内容时，先调用 builtin-lineage_forget(mode=dry_run)，列出 source、cache、embedding、stage、copy、lineage 六层的目标和缺口。用户确认后才以 mode=commit 重放同一计划。commit 仅不可逆删除当前会话 temp/artifacts root 中带 SHA-256 的 managed file，不创建 checkpoint/backup；未提供目标、不支持的存储层或删除失败都必须保留在 incompleteLayers 中。dry_run 的 complete 始终为 false。`,
  allowedTools: ['builtin-task_audit_export', 'builtin-lineage_forget'],
  embeddedTools: [
    {
      name: 'builtin-task_audit_export',
      description:
        'COL-08 Medium：聚合输入 TaskObjectHandle、工具及结果 hash、审批、输出、connector 收件人/ACL、Role Pack 版本与 change/rollback coverage，递归脱敏后导出 TaskAuditManifest。当前 evidenceOrigin=caller_supplied、authoritative=false，缺少 backend_session_ledger，coverageComplete=false。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          taskId: { type: 'string', minLength: 1 },
          objectHandles: { type: 'array', items: TASK_OBJECT_HANDLE },
          toolCalls: { type: 'array', items: { type: 'object' } },
          approvals: { type: 'array', items: { type: 'object' } },
          outputs: { type: 'array', items: { type: 'object' } },
          connectorTargets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                operationId: { type: 'string' },
                recipients: { type: 'array', items: { type: 'string' } },
                aclPrincipals: { type: 'array', items: { type: 'string' } },
              },
              required: ['operationId'],
            },
          },
          rolePackVersion: { type: 'string', description: '精确 packId@version。' },
          changeCoverage: {
            type: 'object',
            additionalProperties: false,
            properties: {
              changesRecorded: { type: 'boolean' },
              rollbackAvailable: { type: 'boolean' },
              rollbackVerified: { type: 'boolean' },
            },
            required: ['changesRecorded', 'rollbackAvailable', 'rollbackVerified'],
          },
        },
        required: [
          'taskId', 'objectHandles', 'toolCalls', 'approvals', 'outputs',
          'connectorTargets', 'changeCoverage',
        ],
      },
    },
    {
      name: 'builtin-lineage_forget',
      description:
        'COL-06 High：dry_run/commit 删除契约。只允许当前会话 temp/artifacts root 的 rootId+relativePath，要求 TaskObjectHandle.sha256，重验 root identity、canonical containment 与 symlink；执行 no-follow/hash-bound irreversible delete，不留 backup。返回 complete、coverageComplete、incompleteLayers、items，绝不把 dry-run 或未覆盖层报告为删除完成。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          mode: { type: 'string', enum: ['dry_run', 'commit'] },
          requestedLayers: {
            type: 'array',
            minItems: 1,
            uniqueItems: true,
            items: { type: 'string', enum: ['source', 'cache', 'embedding', 'stage', 'copy', 'lineage'] },
          },
          targets: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                layer: { type: 'string', enum: ['source', 'cache', 'embedding', 'stage', 'copy', 'lineage'] },
                objectHandle: TASK_OBJECT_HANDLE,
              },
              required: ['layer', 'objectHandle'],
            },
          },
        },
        required: ['mode', 'requestedLayers', 'targets'],
      },
    },
  ],
};

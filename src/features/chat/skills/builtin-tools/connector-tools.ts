import type { SkillDefinition } from '../types';

const CAPABILITIES = ['mail', 'calendar', 'meeting', 'drive', 'comments', 'share'];

export const connectorToolsSkill: SkillDefinition = {
  id: 'connector-tools',
  name: 'connector-tools',
  description: '一等 Connector/Object Bridge：邮件、日历、会议、云盘、评论与分享。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://connector-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# Connector / Object Bridge

先调用 connector_registry 查看已配置 provider、OAuth scopes、capability snapshot 和 mapped actions。
未配置真实 provider、OAuth 未连接、scope 不足或没有 MCP mapping 时，工具返回 capability_unavailable；不得声称已发送、已创建或已分享。

所有外部副作用严格三阶段：
1. connector_operation_draft：完整列出 recipients、timezone、conflicts、destination、ACL、attachments 与 payload。
2. connector_operation_confirm：把用户确认绑定到原 draft 的 preview_sha256，并受 expires_at_ms 限制。
3. connector_operation_commit：必须携带同一 preview_sha256 和新的 idempotency_key；commit 会重新核对 OAuth scopes、权限、对象版本和 MCP mapping。

attachments 必须传完整 TaskObjectHandle，不接受裸主机路径。commit 成功返回统一 TaskObjectHandle 与 ConnectorOperationReceipt。`,
  embeddedTools: [
    {
      name: 'builtin-connector_registry',
      description:
        '列出 Connector registry：各 provider 支持能力、OAuth 状态与 scopes、capability snapshot、MCP mapping；不返回令牌。',
      inputSchema: { type: 'object', properties: {} },
    },
    {
      name: 'builtin-connector_operation_draft',
      description: '创建外部操作预览（无副作用）；返回 operation_id、preview_sha256 与 TTL。',
      inputSchema: {
        type: 'object',
        properties: {
          provider_id: { type: 'string', description: 'registry 返回的 provider id。' },
          capability: { type: 'string', enum: CAPABILITIES },
          action: { type: 'string', description: 'registry 中 mapped_actions 列出的动作。' },
          recipients: {
            type: 'array', items: { type: 'string' },
            description: '收件人/参与者稳定标识；不适用传空数组。',
          },
          timezone: {
            type: 'string',
            description: 'IANA 时区；不涉及时间时显式传 not_applicable。',
          },
          conflicts: {
            type: 'array', items: { type: 'object' },
            description: '已发现的时间/版本/权限/名称冲突；无则空数组。',
          },
          destination: {
            type: 'string',
            description: '目标文件夹/日历/线程/分享位置；不适用显式传 not_applicable。',
          },
          acl: {
            type: 'object',
            description: '预期访问级别、主体与权限；未知时不得猜测。',
          },
          attachments: {
            type: 'array', items: { type: 'object' },
            description: '完整 TaskObjectHandle 数组；无附件传空数组。',
          },
          payload: { type: 'object', description: 'provider 动作的业务 payload。' },
          confirm_ttl_seconds: {
            type: 'integer', minimum: 30, maximum: 3600, default: 600,
          },
        },
        required: [
          'provider_id', 'capability', 'action', 'recipients', 'timezone', 'conflicts',
          'destination', 'acl', 'attachments', 'payload',
        ],
      },
    },
    {
      name: 'builtin-connector_operation_confirm',
      description: '确认未过期的 draft；哈希不匹配、重复确认或 TTL 过期均失败。',
      inputSchema: {
        type: 'object',
        properties: {
          operation_id: { type: 'string' },
          preview_sha256: { type: 'string', description: 'draft 返回的 64 位 SHA-256。' },
        },
        required: ['operation_id', 'preview_sha256'],
      },
    },
    {
      name: 'builtin-connector_operation_commit',
      description:
        '提交已确认操作；执行前重核能力、OAuth scopes、权限与版本，仅经 registry 映射的 MCP 执行。',
      inputSchema: {
        type: 'object',
        properties: {
          operation_id: { type: 'string' },
          preview_sha256: { type: 'string' },
          idempotency_key: {
            type: 'string',
            description: '本次逻辑操作的稳定唯一键；重试必须复用同一键。',
          },
        },
        required: ['operation_id', 'preview_sha256', 'idempotency_key'],
      },
    },
  ],
};

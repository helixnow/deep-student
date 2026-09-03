import type { JsonSchemaProperty, SkillDefinition } from '../types';

const FILE_MANAGER_TOOLS = [
  'builtin-file_manager_plan',
  'builtin-file_manager_commit',
  'builtin-file_manager_restore',
] as const;

const itemSchema: JsonSchemaProperty = {
  type: 'object', additionalProperties: false,
  properties: {
    item_id: { type: 'string', minLength: 1, description: 'Stable unique id in batch_manifest.' },
    operation: { type: 'string', enum: ['rename', 'move', 'delete', 'format_convert'] },
    source_path: { type: 'string', minLength: 1, description: 'Workspace-relative path; absolute/parent/hidden/symlink rejected.' },
    destination_path: { type: 'string', minLength: 1, description: 'Required for rename/move/format_convert; never valid for delete.' },
    format: { type: 'string', enum: ['json_pretty', 'json_compact', 'csv_to_tsv', 'tsv_to_csv'], description: 'Required only for format_convert.' },
  },
  required: ['item_id', 'operation', 'source_path'],
};

export const fileManagerToolsSkill: SkillDefinition = {
  id: 'file-manager-tools', name: 'file-manager-tools',
  description: 'Preview-bound batch rename, move, soft-delete, restore, and explicit text format conversion inside the read-write workspace with item-level OCC.',
  version: '1.0.0', author: 'Deep Student', priority: 8, location: 'builtin',
  sourcePath: 'builtin://file-manager-tools', isBuiltin: true, disableAutoInvoke: false, skillType: 'standalone',
  content: `# File manager

Use this skill for batch rename, move, soft-delete, or supported text format conversion inside the configured read-write workspace.

## Required workflow

1. Call builtin-file_manager_plan with root_id="workspace" and every requested item.
2. Review its normalized preview, which contains SHA-256 and expectedCurrentHash values.
3. Call builtin-file_manager_commit with the exact plan_id, root_id, and preview_sha256. Never reconstruct items at commit time.
4. Read batch_manifest. Claim full completion only when complete=true; otherwise report every failed item.

Plans expire after ten minutes and are bound to the chat session and canonical workspace root. Create a new plan if a plan expires, the workspace changes, or any source changes. Commits are item-wise and non-transactional; successful items remain committed if another item fails.

Deletes are always reversible soft-deletes. The backend alone chooses .deep-student-trash/<operation>/...; never supply a trash path. Pass the returned receipt unchanged to builtin-file_manager_restore. Permanent deletion is not supported.

Authorized roots and Skill package roots stay read-only. Only root_id="workspace" is accepted. Supported conversions are JSON pretty/compact and CSV/TSV; conversion creates a destination and preserves its source.
`,
  allowedTools: [...FILE_MANAGER_TOOLS],
  embeddedTools: [
    {
      name: 'builtin-file_manager_plan',
      description: 'Read-only plan for 1-100 workspace files; returns a session/root-bound preview_sha256 (10-minute TTL).',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        root_id: { type: 'string', enum: ['workspace'], description: 'Runtime root; authorized roots stay read-only.' },
        items: { type: 'array', minItems: 1, maxItems: 100, items: itemSchema },
      }, required: ['root_id', 'items'] },
    },
    {
      name: 'builtin-file_manager_commit',
      description: 'Commits one exact unexpired plan; approval binds root_id and preview_sha256. Sources re-hashed for OCC; complete=false on any failure.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {
        plan_id: { type: 'string', minLength: 1 },
        root_id: { type: 'string', enum: ['workspace'] },
        preview_sha256: { type: 'string', pattern: '^[A-Fa-f0-9]{64}$' },
      }, required: ['plan_id', 'root_id', 'preview_sha256'] },
    },
    {
      name: 'builtin-file_manager_restore',
      description: 'Restores one soft-deleted file from the unchanged receipt; verifies session/root binding, trash path, hash, and absent destination.',
      inputSchema: { type: 'object', additionalProperties: false, properties: { receipt: {
        type: 'object', additionalProperties: false,
        properties: {
          receiptId: { type: 'string' }, planId: { type: 'string' }, itemId: { type: 'string' }, sessionId: { type: 'string' },
          rootId: { type: 'string', enum: ['workspace'] }, originalPath: { type: 'string' }, trashPath: { type: 'string' },
          sha256: { type: 'string', pattern: '^[A-Fa-f0-9]{64}$' }, deletedAt: { type: 'string' },
        },
        required: ['receiptId', 'planId', 'itemId', 'sessionId', 'rootId', 'originalPath', 'trashPath', 'sha256', 'deletedAt'],
      } }, required: ['receipt'] },
    },
  ],
};

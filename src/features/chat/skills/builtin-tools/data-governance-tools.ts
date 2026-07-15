/** Backup and sync tools with a credential-free agent contract. */

import type { SkillDefinition } from '../types';

const backupAssetTypes = [
  'images',
  'notes_assets',
  'documents',
  'vfs_blobs',
  'subjects',
  'workspaces',
  'audio',
  'videos',
  'textbooks',
  'pdf_ocr_sessions',
] as const;

export const dataGovernanceToolsSkill: SkillDefinition = {
  id: 'data-governance-tools',
  name: 'data-governance-tools',
  description:
    '查看本地备份与同步状态，创建完整备份并轮询后台任务，或使用 Settings 已配置的安全云存储执行同步。恢复、导入、清库和任何云凭据操作不开放。',
  version: '1.0.0',
  author: 'Deep Student',
  priority: 8,
  location: 'builtin',
  sourcePath: 'builtin://data-governance-tools',
  isBuiltin: true,
  disableAutoInvoke: false,
  skillType: 'standalone',
  content: `# 数据治理

## 备份

1. **builtin-backup_status**（Low）分页读取本机备份目录中的真实备份目录项。
2. 用户明确要求创建备份后，调用 **builtin-backup_create**（High）。它只启动 full 后台备份并返回 queued/job_id，不代表备份已经完成。
3. 必须用 **builtin-backup_job_status**（Low）轮询同一 job_id，直到 completed/failed/cancelled。以终态 result.success 为准，不能根据 queued/running 或 HTTP/工具调用成功猜测备份成功。

## 同步

- **builtin-sync_status**（Low）只观测本地 change-log 与是否存在安全配置；cloud_probed=false，绝不把它描述成云端已连接、可达或两端一致。
- **builtin-sync_run**（High）只接受 direction 和冲突 strategy。云端 endpoint/用户名等非敏感配置从后端 SSOT 读取，密码/secret/access key/加密密码由 secure store 在 Rust 内补齐；不得把 cloud_config、WebDAV/S3/FTP 凭据、token 或密钥放进工具参数。
- download/bidirectional 可能覆盖本地状态，应先向用户说明方向和冲突策略并取得明确确认。返回 partial 或 skipped_changes>0 时不得宣称完全成功。

## 明确不开放

恢复备份、删除备份、ZIP 导入、purge_all_data、API key/OAuth/WebDAV/S3/FTP 凭据与云配置编辑均不暴露给 Agent。需要这些操作时打开 Settings > Data Governance / Cloud Storage 让用户接管。
`,
  allowedTools: [
    'builtin-backup_status',
    'builtin-backup_create',
    'builtin-backup_job_status',
    'builtin-sync_status',
    'builtin-sync_run',
  ],
  embeddedTools: [
    {
      name: 'builtin-backup_status',
      description:
        '分页读取本机备份目录（Low）。返回 backup_id/created_at/size_bytes/backup_type/databases 及 total/has_more，scope=local_backup_catalog；不探测云端。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          page_size: { type: 'integer', minimum: 1, maximum: 20, default: 20 },
        },
      },
    },
    {
      name: 'builtin-backup_create',
      description:
        '启动一个 full 后台备份（High）。立即且仅返回 status=queued/job_id，必须随后用 backup_job_status 轮询终态；queued 不代表成功。可选择是否包含资产及严格资产类型。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          include_assets: {
            type: 'boolean',
            default: false,
            description: '是否包含资产文件；默认 false（仅备份数据库和设置）',
          },
          asset_types: {
            type: 'array',
            maxItems: backupAssetTypes.length,
            uniqueItems: true,
            items: { type: 'string', enum: [...backupAssetTypes] },
            description: '可选资产类型；仅 include_assets=true 时使用',
          },
        },
      },
    },
    {
      name: 'builtin-backup_job_status',
      description:
        '查询 backup_create 返回的后台任务（Low）。lookup=found 时返回真实 status/phase/progress/terminal/result；expired 表示 Agent 创建过但已超出保留窗口，not_found 表示未知 ID。终态以 result.success 为准。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['job_id'],
        properties: {
          job_id: {
            type: 'string',
            minLength: 1,
            maxLength: 80,
            description: 'backup_create 返回的 UUID job_id',
          },
        },
      },
    },
    {
      name: 'builtin-sync_status',
      description:
        '读取本地同步 change-log 统计与 cloud_configured（Low）。固定 observation_scope=local_change_logs_only、cloud_probed=false；不能据此判断云端可达、已连接或两端一致。无参数。',
      inputSchema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: 'builtin-sync_run',
      description:
        '使用 Settings 已保存的后端安全配置执行真实同步（High）。只接受 direction/strategy，绝不接受 cloud_config、endpoint、用户名、密码、token 或密钥。partial/skipped_changes 表示未完全成功。',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        required: ['direction'],
        properties: {
          direction: {
            type: 'string',
            enum: ['upload', 'download', 'bidirectional'],
            description: 'upload=本地推送；download=云端拉取；bidirectional=双向同步',
          },
          strategy: {
            type: 'string',
            enum: ['keep_local', 'use_cloud', 'keep_latest'],
            default: 'keep_latest',
            description: '冲突策略；默认 keep_latest，不开放需要人工逐条处理的 manual',
          },
        },
      },
    },
  ],
};

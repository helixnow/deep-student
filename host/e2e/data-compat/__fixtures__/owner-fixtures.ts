import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HERE, I64, ISO, JSON_TEXT, SQL_TIME, UTC, type SeedRow } from './fixtures.ts';

export const WORKSPACE_ID = 'ws_old';
export const INSTANCE_ID = '旧实例📚';
export const U64_MAX = 18446744073709551615n;
// Internal owner services use RFC3339 +00:00; SQL still retains its original offset.
export const UTC_OFFSET = '2026-09-30T17:02:03.123456789+00:00';
export const OWNER_SEEDS: Record<'audit' | 'sync_state' | 'workspace', Record<string, SeedRow[]>> = {
  audit: {
    __audit_log: [
      { id: 'audit_backup', timestamp: ISO, operation_type: 'Backup',
        operation_data: '{ "type": "Backup", "backup_type": "Incremental", "file_count": 4294967295, "total_size": 18446744073709551615 }',
        target: '旧备份📚.zip', status: 'Completed', duration_ms: I64, details: JSON_TEXT, error_message: null },
      { id: 'audit_null', timestamp: UTC, operation_type: 'Restore',
        operation_data: '{ "type": "Restore", "backup_path": "备份/旧📚.zip" }',
        target: 'slotA', status: 'Failed', duration_ms: null, details: null, error_message: '历史错误📚' },
      { id: 'audit_json_null', timestamp: '2026-10-02T00:00:00Z', operation_type: 'Sync',
        operation_data: '{ "type": "Sync", "direction": "Download", "records_affected": 0 }',
        target: 'vfs', status: 'Started', duration_ms: 0, details: 'null', error_message: null },
    ],
  },
  sync_state: {
    upload_seq: [{ instance_id: INSTANCE_ID, device_id: 'device_old', last_seq: I64, updated_at: ISO }],
    consume_cursor: [{ instance_id: INSTANCE_ID, uploader_device_id: 'uploader_old', last_seq: I64, updated_at: UTC }],
    legacy_processed_key: [{ instance_id: INSTANCE_ID, object_key: '旧目录/📚.json', processed_at: SQL_TIME }],
    tombstone_watermark: [{ instance_id: INSTANCE_ID, source_device_id: 'source_old', kind: 'assets', last_applied_offset: I64, updated_at: ISO }],
    instance_binding: [{ instance_id: INSTANCE_ID, provider: 'webdav', endpoint_hint: 'https://example.com/中文', bound_at: UTC }],
    device_history: [{ old_device_id: 'device_old', new_device_id: 'device_new', rotated_at: SQL_TIME, reason: '旧设备迁移📚' }],
  },
  workspace: {
    workspace: [{ id: WORKSPACE_ID, name: '旧工作区📚', status: 'active', creator_session_id: 'creator_old',
      created_at: ISO, updated_at: UTC, metadata_json: JSON_TEXT }],
    agent: [{ session_id: 'worker_old', workspace_id: WORKSPACE_ID, role: 'worker', skill_id: null, status: 'idle',
      joined_at: ISO, last_active_at: UTC, metadata_json: null }],
    message: [{ id: 'message_old', workspace_id: WORKSPACE_ID, sender_session_id: 'creator_old', target_session_id: null,
      message_type: 'broadcast', content: '旧消息📚\n第二行', status: 'pending', created_at: ISO, metadata_json: JSON_TEXT }],
    inbox: [{ id: I64, session_id: 'worker_old', message_id: 'message_old', priority: 2147483647, status: 'unread', created_at: UTC }],
    document: [{ id: 'document_old', workspace_id: WORKSPACE_ID, doc_type: 'notes', title: '旧文档📚', content: '# 中文\n正文📚',
      version: 2147483647, updated_by: 'worker_old', updated_at: ISO }],
    context: [{ workspace_id: WORKSPACE_ID, key: '上下文📚', value_json: JSON_TEXT, updated_by: 'creator_old', updated_at: UTC }],
    sleep_block: [{ id: 'sleep_old', workspace_id: WORKSPACE_ID, coordinator_session_id: 'creator_old', awaiting_agents: '[ "worker_old" ]',
      wake_condition: '{"type":"result_message"}', status: 'awakened', timeout_at: null, created_at: ISO,
      awakened_at: UTC, awakened_by: 'worker_old', awaken_message: null, message_id: 'message_old', block_id: null }],
    subagent_task: [{ id: 'task_old', workspace_id: WORKSPACE_ID, agent_session_id: 'worker_old', skill_id: null,
      initial_task: '历史任务📚', status: 'pending', created_at: ISO, started_at: null, completed_at: null, result_summary: null }],
  },
};

export function historicalSql(name: 'audit' | 'sync-state' | 'workspace-v1'): string {
  return readFileSync(join(HERE, '__fixtures__/historical', `${name}.sql`), 'utf8');
}

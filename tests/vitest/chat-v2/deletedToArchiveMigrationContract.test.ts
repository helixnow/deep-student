import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('chat v2 deleted session migration contract', () => {
  it('registers a migration that reinterprets legacy deleted sessions as archived', () => {
    const migrationPath = resolve(
      process.cwd(),
      'src-tauri/migrations/chat_v2/V20260502__archive_legacy_deleted_sessions.sql'
    );
    const migrationRegistrySource = readFileSync(
      resolve(process.cwd(), 'src-tauri/src/data_governance/migration/chat_v2.rs'),
      'utf8'
    );

    expect(existsSync(migrationPath)).toBe(true);

    const migrationSql = readFileSync(migrationPath, 'utf8');
    expect(migrationSql).toContain("UPDATE chat_v2_sessions");
    expect(migrationSql).toContain("SET persist_status = 'archived'");
    expect(migrationSql).toContain("WHERE persist_status = 'deleted'");
    expect(migrationSql).not.toContain('DELETE FROM chat_v2_sessions');

    expect(migrationRegistrySource).toContain('V20260502_ARCHIVE_LEGACY_DELETED_SESSIONS');
    expect(migrationRegistrySource).toContain('20260502');
    expect(migrationRegistrySource).toContain('archive_legacy_deleted_sessions');
    expect(migrationRegistrySource).toContain(
      'include_str!("../../../migrations/chat_v2/V20260502__archive_legacy_deleted_sessions.sql")'
    );
  });
});

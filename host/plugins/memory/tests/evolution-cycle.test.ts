import { afterEach, describe, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryServiceImpl } from '../src/service.ts';

let current: MemoryHost | undefined;
afterEach(async () => { await current?.dispose(); current = undefined; });

const DAY_MS = 86_400_000;

function oldIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString().replace('Z', '+00:00');
}

describe('memory evolution cycle', () => {
  it('demotes stale, promotes high-frequency and archives dormant memories', async () => {
    current = await setupMemoryHost();
    const { host, db } = current;
    await host.invoke('memory_get_or_create_root_folder', {});
    const service = host.ctx.memory as unknown as MemoryServiceImpl;

    const stale = service.write(null, '旧弱项', '数学公式总记错', 'create');
    const frequent = service.write(null, '高频偏好', '喜欢图解', 'create');
    const dormant = service.write(null, '休眠记忆', '很久没用的内容', 'create');

    db.run('UPDATE notes SET tags = ?1, updated_at = ?2 WHERE id = ?3',
      [JSON.stringify(['_type:fact', '_hits:0']), oldIso(200), stale.noteId]);
    db.run('UPDATE notes SET tags = ?1 WHERE id = ?2',
      [JSON.stringify(['_type:fact', '_hits:5']), frequent.noteId]);
    db.run('UPDATE notes SET tags = ?1, updated_at = ?2 WHERE id = ?3',
      [JSON.stringify(['_type:fact', '_stale', '_hits:0']), oldIso(400), dormant.noteId]);

    await service.spawnPostWriteMaintenance();

    const staleTags = db.pluck<string>('SELECT tags FROM notes WHERE id = ?1', [stale.noteId]);
    const frequentTags = db.pluck<string>('SELECT tags FROM notes WHERE id = ?1', [frequent.noteId]);
    const dormantTags = db.pluck<string>('SELECT tags FROM notes WHERE id = ?1', [dormant.noteId]);
    expect(JSON.parse(staleTags ?? '[]')).toContain('_stale');
    expect(JSON.parse(frequentTags ?? '[]')).toContain('_important');
    expect(JSON.parse(dormantTags ?? '[]')).toContain('_archived');

    const events = db.all<{ event: string }>(
      "SELECT event FROM memory_audit_log WHERE source = 'evolution' ORDER BY id");
    expect(events.map(row => row.event)).toEqual(['STALE_DEMOTE', 'ARCHIVE']);
  });
});

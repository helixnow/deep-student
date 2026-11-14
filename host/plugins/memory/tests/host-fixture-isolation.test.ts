import { afterEach, expect, it } from 'vitest';
import { setupMemoryHost, type MemoryHost } from './support.ts';
import type { MemoryWriteOutput } from '../api.ts';

const hosts: MemoryHost[] = [];
afterEach(async () => { for (const host of hosts.splice(0)) await host.dispose(); });

it('schema copies keep migrated versions but never share test rows or configuration', async () => {
  const first = await setupMemoryHost();
  const second = await setupMemoryHost();
  hosts.push(first, second);
  expect(first.dir).not.toBe(second.dir);
  for (const database of ['vfs', 'chat_v2', 'mistakes', 'llm_usage'] as const) {
    const version = first.storage.migrations.currentVersion(database);
    expect(version).toBeGreaterThan(0);
    expect(second.storage.migrations.currentVersion(database)).toBe(version);
  }
  const note = await first.host.invoke('memory_write', {
    title: 'First host only', content: 'Only this copy contains the note.',
  }) as MemoryWriteOutput;
  await first.host.invoke('memory_set_privacy_mode', { enabled: true });
  expect(first.db.pluck<number>('SELECT COUNT(*) FROM notes WHERE id=?1', [note.noteId])).toBe(1);
  expect(second.db.pluck<number>('SELECT COUNT(*) FROM notes WHERE id=?1', [note.noteId])).toBe(0);
  expect((await second.host.invoke('memory_get_config', {}) as { privacyMode: boolean }).privacyMode).toBe(false);

  // Opening a later clone still starts from the immutable migrated seed, not an earlier host.
  const third = await setupMemoryHost();
  hosts.push(third);
  expect(third.db.pluck<number>('SELECT COUNT(*) FROM notes WHERE id=?1', [note.noteId])).toBe(0);
  expect((await third.host.invoke('memory_get_config', {}) as { privacyMode: boolean }).privacyMode).toBe(false);
});

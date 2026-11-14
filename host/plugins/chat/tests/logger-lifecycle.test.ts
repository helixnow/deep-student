import { expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import { newSession } from '../src/types.ts';

it('repository warnings stay with their Host and survive unloading a different Host', async () => {
  const firstDb = databaseFixture();
  const secondDb = databaseFixture();
  const first = await createTestHost({ plugins: [plugin], provide: { storage: firstDb.storage, vfs: vfsStub } });
  const second = await createTestHost({ plugins: [plugin], provide: { storage: secondDb.storage, vfs: vfsStub } });
  const firstWarnings: string[] = [];
  const secondWarnings: string[] = [];
  first.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
    if (message.type === 'warn') firstWarnings.push(String(message.args[0]));
  } });
  second.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
    if (message.type === 'warn') secondWarnings.push(String(message.args[0]));
  } });
  try {
    for (const [host, fixture] of [[first, firstDb], [second, secondDb]] as const) {
      host.ctx.get('chatSession')!.createSession(newSession('sess_bad', 'chat'));
      fixture.db.run('UPDATE chat_v2_sessions SET mode = ? WHERE id = ?', [Buffer.from('chat'), 'sess_bad']);
    }
    expect(await first.invoke('chat_v2_list_sessions')).toEqual([]);
    expect(firstWarnings).toEqual(['[ChatV2Repo] Skipping malformed row: Database error: Invalid column type for mode']);
    expect(secondWarnings).toEqual([]);
    await first.dispose();
    expect(await second.invoke('chat_v2_list_sessions')).toEqual([]);
    expect(secondWarnings).toEqual(['[ChatV2Repo] Skipping malformed row: Database error: Invalid column type for mode']);
  } finally {
    await first.dispose();
    await second.dispose();
    firstDb.dispose();
    secondDb.dispose();
  }
});

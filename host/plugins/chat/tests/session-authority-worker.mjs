import { createTestHost } from '../../../kernel/testing.ts';
import { StorageServiceImpl } from '../../../platform/storage/service.ts';
import { parseRfc3339 } from '../../../platform/time/index.ts';
import plugin from '../index.ts';

const [root, sessionId] = process.argv.slice(2);
const storage = new StorageServiceImpl({ baseDir: root, dataLocalDir: root });
const host = await createTestHost({ plugins: [plugin], provide: { storage, vfs: { version: 1 } } });
// Open each process's physical connection before releasing the shared start barrier.
host.ctx.chatSession.database.getConnSafe();
process.send('ready');
process.once('message', async () => {
  try {
    const result = host.ctx.chatSession.consumeSessionPlanBinding(sessionId, 'binding',
      parseRfc3339('2026-11-06T12:00:00.123456789Z'));
    process.send(result);
  } finally {
    await host.dispose();
    storage.dispose();
    process.disconnect();
  }
});

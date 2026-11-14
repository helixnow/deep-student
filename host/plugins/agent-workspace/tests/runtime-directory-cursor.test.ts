import fs from 'node:fs';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';

it('R2-W5 runtime_directory_cursor_past_end_terminates_empty across the full 64-bit usize range', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const root = path.join(host.app.dataDir, 'cursor');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'one.txt'), 'one');
    await host.invoke('chat_v2_set_workspace_root', { path: root });
    for (const cursor of ['9007199254740992', '9007199254740993', '18446744073709551615', '+18446744073709551615', '000000000000000000000000000002']) {
      await expect(host.invoke('chat_v2_list_runtime_directory', { sessionId: 'test', cursor }))
        .resolves.toEqual({ rootId: 'workspace', relativePath: '', entries: [], nextCursor: null, truncated: false, scanned: 0 });
    }
    for (const cursor of ['18446744073709551616', '-1', '-0', '+', '', '1.0', '1e3', ' 1', '1\n', '1\r\n']) {
      await expect(host.invoke('chat_v2_list_runtime_directory', { sessionId: 'test', cursor }))
        .rejects.toBe('Invalid runtime directory cursor');
    }
    await expect(host.invoke('chat_v2_list_runtime_directory', { sessionId: 'test', cursor: '+0', limit: 1 }))
      .resolves.toMatchObject({ nextCursor: '1', scanned: 1, truncated: true });
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

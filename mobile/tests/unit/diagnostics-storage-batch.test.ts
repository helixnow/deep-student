/**
 * V06-03：诊断插件的 `storageBatch` 不再改写用户数据。批处理作用于整张表；在真实 mistakes.db 上跑会把用户
 * 30 天前的错题归档、删掉用户的孤儿消息。现在它在同结构的临时库上跑，结果与 e2e（全新库）期望的相同。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { HOST_CALL_COMMAND } from '../../../host/kernel/core.ts';
import { loadImportedProfile } from '../../../host/kernel/profile-install.ts';
import { createTestHost, type TestHost } from '../../../host/kernel/testing.ts';
import mobileStorage from '../../../host/platform/storage-mobile/index.ts';
import { MOBILE_DIAGNOSTICS_PLUGIN_ID } from '../../src/diagnostics-id.ts';
import { createDiagnosticsPlugin } from '../../src/worker/diagnostics-plugin.ts';
import { nodeRuntime, nodeSqlite } from './support/sqlite-node.ts';

let host: TestHost | undefined;

afterEach(async () => {
  await host?.dispose();
  host = undefined;
});

describe('mobile diagnostics storageBatch', () => {
  it('leaves the user\'s mistakes and messages untouched and reports only its own rows', async () => {
    const runtime = nodeRuntime(await nodeSqlite());
    host = await createTestHost({ provide: { sqliteRuntime: runtime, files: {}, appCommandState: {} } });
    // 存储以 builtin 身份安装：测试条目的 `source` 会被判成社区插件，社区 ctx 的深层代理不让 `Object.keys`
    // 枚举注入服务的普通对象（`sqliteRuntime.migrations`），迁移会被当成空集。
    const loaded = await loadImportedProfile(host.runtime, [
      { plugin: mobileStorage },
      { plugin: createDiagnosticsPlugin(runtime, { modulesEvaluatedMs: 0, wasmInitMs: 0, poolInstallMs: 0 }), source: 'test:diagnostics' },
    ]);
    expect(loaded.degraded).toEqual([]);

    const mistakes = host.ctx.storage.database('mistakes');
    const longAgo = new Date(Date.now() - 200 * 86_400_000).toISOString();
    mistakes.run(
      `INSERT INTO mistakes
         (id, created_at, question_images, analysis_images, user_question, ocr_text,
          tags, mistake_type, status, chat_category, updated_at, last_accessed_at)
       VALUES ('user-mistake', ?1, '[]', '[]', 'q', '', '[]', 'analysis', 'completed', 'analysis', ?1, ?1)`,
      [longAgo],
    );
    mistakes.exec('PRAGMA foreign_keys = OFF');
    mistakes.run("INSERT INTO chat_messages (mistake_id, role, content, timestamp) VALUES ('deleted-long-ago', 'user', 'history', ?1)", [longAgo]);
    mistakes.exec('PRAGMA foreign_keys = ON');
    const userRows = () => ({
      mistakes: mistakes.all('SELECT id, status, updated_at, last_accessed_at FROM mistakes ORDER BY id'),
      messages: mistakes.all('SELECT mistake_id, content FROM chat_messages ORDER BY id'),
    });
    const before = userRows();

    const result = await host.invoke(HOST_CALL_COMMAND, { caller: MOBILE_DIAGNOSTICS_PLUGIN_ID, service: 'mobileDiagnostics', method: 'storageBatch', args: [] });

    expect(result).toEqual({
      archived: 1,
      statuses: [
        { id: 'batch-new-active', status: 'completed' },
        { id: 'batch-old-active', status: 'archived' },
        { id: 'batch-old-archived', status: 'archived' },
      ],
      removed: 1,
      messages: [{ mistake_id: 'batch-old-active' }],
    });
    expect(userRows()).toEqual(before);
    expect(before.mistakes).toHaveLength(1);
    expect(before.messages).toHaveLength(1);
  }, 60_000);
});

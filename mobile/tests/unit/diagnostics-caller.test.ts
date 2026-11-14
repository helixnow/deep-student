/**
 * SEC-E06：诊断页的 `plugin:host|call` 带 `caller`（诊断插件 id），kernel 切到 `require` 后照常可用；
 * 主线程（`main.ts`）与诊断插件 `meta.id` 用同一个常量，不会各写各的。
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

describe('diagnostics page caller', () => {
  it('passes the kernel in require mode; a missing or foreign caller is refused', async () => {
    const runtime = nodeRuntime(await nodeSqlite());
    host = await createTestHost({ hostCallCaller: 'require', provide: { sqliteRuntime: runtime, files: {}, appCommandState: {} } });
    const loaded = await loadImportedProfile(host.runtime, [
      { plugin: mobileStorage, source: 'test:storage-mobile' },
      { plugin: createDiagnosticsPlugin(runtime, { modulesEvaluatedMs: 0, wasmInitMs: 0, poolInstallMs: 0 }), source: 'test:diagnostics' },
    ]);
    expect(loaded.degraded).toEqual([]);
    const call = (caller: string | undefined) => host!.invoke(HOST_CALL_COMMAND, { ...(caller === undefined ? {} : { caller }), service: 'mobileDiagnostics', method: 'ping', args: ['caller'] });

    await expect(call(MOBILE_DIAGNOSTICS_PLUGIN_ID)).resolves.toBe('pong:caller');
    await expect(call(undefined)).rejects.toMatchObject({ message: expect.stringContaining('requires "caller", the plugin id of the calling UI half') });
    await expect(call('dstu.platform.storage')).rejects.toMatchObject({
      message: expect.stringContaining(`plugin "dstu.platform.storage" cannot call service "mobileDiagnostics" of "${MOBILE_DIAGNOSTICS_PLUGIN_ID}"`),
    });
  }, 60_000);
});

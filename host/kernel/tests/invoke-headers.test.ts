import { expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import greeter from '../__fixtures__/greeter.plugin.ts';
import { ContractSet } from '../contracts.ts';
import { createTestHost } from '../testing.ts';

const FIXTURES = fileURLToPath(new URL('../__fixtures__/', import.meta.url));
const contracts = () => ContractSet.fromDirectory(`${FIXTURES}contracts`);
const SOURCE = { window: 'main', webview: 'main' };

it('passes optional InvokeRequest headers through to CallContext', async () => {
  const host = await createTestHost({ plugins: [greeter], contracts: contracts() });
  try {
    // 旧版 main / 普通 JSON invoke 不发送 headers：CallContext 上保持缺省。
    await expect(host.invoke('fixture_headers')).resolves.toBeNull();

    const headers = { 'content-type': 'application/octet-stream', 'x-raw-body': '1' };
    await expect(host.runtime.dispatchInvoke({
      id: 'headers-1',
      cmd: 'fixture_headers',
      args: {},
      source: SOURCE,
      headers,
    })).resolves.toEqual({ kind: 'ok', value: headers });
  } finally {
    await host.dispose();
  }
});

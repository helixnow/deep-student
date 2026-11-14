import { expect, it } from 'vitest';
import { ToolDescriptor, ToolRegistryBuilder, ToolRegistryError } from '../api.ts';
import { IlinkClient } from '../../plugins/ilink/api.ts';

it('empty_descriptor_name_fails uses Rust whitespace for names and aliases without renaming valid tools', () => {
  // dstu-agent-api/registry.rs:285-310: trim().is_empty(), then store the ORIGINAL name.
  // The provider/identity are inputs, as in the Rust registry tests; the builder is production API.
  const executor = {};
  const builder = (descriptor: ToolDescriptor) => new ToolRegistryBuilder().register({
    id: 'text-boundary', descriptors: () => [descriptor],
    executor: () => executor, executors: () => [executor],
  });
  for (const descriptor of [new ToolDescriptor(' \u0085\t'), new ToolDescriptor('valid').withAliases(['\u0085'])]) {
    try { builder(descriptor).build(); throw new Error('accepted empty tool name'); }
    catch (error) {
      expect(error).toBeInstanceOf(ToolRegistryError);
      expect(error).toMatchObject({ code: 'EmptyToolName', fields: { provider: 'text-boundary' } });
    }
  }
  for (const name of ['\uFEFF', '\u0085tool\u0085']) {
    const registry = builder(new ToolDescriptor(name)).build();
    expect(registry.executorFor(name)).toBe(executor);
    expect(registry.descriptor(name)?.name).toBe(name);
    expect(registry.executorFor('tool')).toBeUndefined();
  }
});

it('iLink base URL fallback uses Rust trim and does not treat BOM as an empty URL', async () => {
  // src/plugins/ilink_bot/client.rs:145-151. HTTP is external input; URL selection and
  // response/error decoding are the actual IlinkClient implementation. No outbound network.
  const requested: string[] = [];
  const client = new IlinkClient({ fetch: async url => {
    requested.push(url);
    new URL(url); // Reject the invalid nonempty URL at the transport boundary.
    return new Response('{"msgs":[]}');
  } });
  const credentials = { token: 't', baseUrl: '\u0085', accountId: 'a', userId: 'u', getUpdatesBuf: '', contextTokens: {} };
  await expect(client.getUpdates(credentials, 1)).resolves.toMatchObject({ msgs: [] });
  expect(requested).toEqual(['https://ilinkai.weixin.qq.com/ilink/bot/getupdates']);
  await expect(client.getUpdates({ ...credentials, baseUrl: '\uFEFF' }, 1)).rejects.toMatchObject({ error_type: 'Network' });
  expect(requested[1]).toBe('\uFEFF/ilink/bot/getupdates');
});

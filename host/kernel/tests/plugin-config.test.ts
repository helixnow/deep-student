/**
 * 插件 `Config`（Schemastery）：`apply` 之前校验并补齐默认值；凭据不进配置。
 *
 * 另外核实 Cordis 自身的配置校验：`ctx.plugin(plugin, config)` 在 `Fiber._reload` 中调用
 * `plugin.Config['~standard'].validate`（`@deepseek-ai/cordis/src/fiber.ts` `resolveConfig`），
 * 所以 profile 装载路径（`runtime.start` → `ctx.plugin`）只要插件对象带 `Config` 就会触发；
 * kernel 先校验一次，以给出结构化错误码与凭据检查。
 */
import Schema from '@deepseek-ai/schemastery';
import { Context } from '@deepseek-ai/cordis';
import { describe, expect, it } from 'vitest';
import { definePlugin } from '../api.ts';
import { ContractSet } from '../contracts.ts';
import { credentialFields, resolvePluginConfig } from '../plugin-config.ts';
import { installProfile } from '../profile.ts';
import { createTestHost } from '../testing.ts';

interface StatsConfig { interval: number; label: string; nested: { enabled: boolean } }
const StatsConfig: Schema<Partial<StatsConfig>, StatsConfig> = Schema.object({
  interval: Schema.natural().default(30),
  label: Schema.string().default('stats'),
  nested: Schema.object({ enabled: Schema.boolean().default(true) }),
});

function statsPlugin(id: string, seen: unknown[]) {
  return definePlugin<StatsConfig>({
    meta: { id, lane: 'W01-test' },
    Config: StatsConfig,
    apply(_ctx, config) {
      seen.push(config);
    },
  });
}

describe('W01 plugin Config (Schemastery) is validated before apply', () => {
  it('fills defaults before apply and keeps the resolved config on the installed plugin', async () => {
    const seen: unknown[] = [];
    const host = await createTestHost({ contracts: ContractSet.empty() });
    try {
      const result = await installProfile(host.runtime, [{ plugin: statsPlugin('fixture.config-stats', seen), config: { interval: 5 } }]);
      expect(result.degraded).toEqual([]);
      expect(seen).toEqual([{ interval: 5, label: 'stats', nested: { enabled: true } }]);
      expect(host.runtime.get('fixture.config-stats')!.config).toEqual({ interval: 5, label: 'stats', nested: { enabled: true } });
    } finally {
      await host.dispose();
    }
  });

  it('degrades the plugin with CONFIG_INVALID (apply never runs) and keeps the rest of the profile', async () => {
    const seen: unknown[] = [];
    const host = await createTestHost({ contracts: ContractSet.empty() });
    try {
      const result = await installProfile(host.runtime, [
        { plugin: statsPlugin('fixture.config-bad', seen), config: { interval: -1 } },
        { plugin: statsPlugin('fixture.config-good', seen) },
      ]);
      expect(result.degraded).toEqual([{ id: 'fixture.config-bad', reason: 'CONFIG_INVALID: invalid config: $.interval expected number >= 0 but got -1' }]);
      expect(result.installed.map(p => p.id)).toEqual(['fixture.config-good']);
      expect(seen).toEqual([{ interval: 30, label: 'stats', nested: { enabled: true } }]);
    } finally {
      await host.dispose();
    }
  });

  it('rejects Config schemas that declare credentials (role secret or credential-like keys)', async () => {
    const secret = definePlugin<{ endpoint: string; auth: { apiKey: string } }>({
      meta: { id: 'fixture.config-secret', lane: 'W01-test' },
      Config: Schema.object({ endpoint: Schema.string(), auth: Schema.object({ apiKey: Schema.string() }) }),
      apply() {},
    });
    const role = Schema.object({ list: Schema.array(Schema.object({ x: Schema.string().role('secret') })), maxTokens: Schema.natural() });
    expect(credentialFields(role)).toEqual(['$.list[].x']);
    expect(() => resolvePluginConfig(secret, { endpoint: 'x', auth: { apiKey: 'k' } }))
      .toThrow('CONFIG_CREDENTIAL: Config declares credential fields $.auth.apiKey; credentials belong in the secrets service, not in plugin config');
    const host = await createTestHost({ contracts: ContractSet.empty() });
    try {
      const result = await installProfile(host.runtime, [{ plugin: secret, config: { endpoint: 'x', auth: { apiKey: 'k' } } }]);
      expect(result.degraded.map(d => d.reason.split(':')[0])).toEqual(['CONFIG_CREDENTIAL']);
    } finally {
      await host.dispose();
    }
  });

  it('plugins without Config receive the profile config unchanged', () => {
    const plain = definePlugin<{ a: number }>({ meta: { id: 'fixture.config-plain' }, apply() {} });
    const config = { a: 1, extra: true };
    expect(resolvePluginConfig(plain, config)).toBe(config);
    const notSchemastery = { ...plain, Config: { '~standard': { validate: () => ({ value: 1 }) } } } as never;
    expect(() => resolvePluginConfig(notSchemastery, {})).toThrow('CONFIG_INVALID: plugin.Config must be a Schemastery schema');
  });

  it('Cordis itself validates Config on ctx.plugin (the path the profile loader uses), including later fiber.update', async () => {
    const seen: unknown[] = [];
    const root = new Context();
    const fiber = root.plugin({ name: 'raw', Config: StatsConfig, apply: (_ctx: Context, config: unknown) => { seen.push(config); } }, { label: 'raw' });
    await fiber;
    expect(seen).toEqual([{ interval: 30, label: 'raw', nested: { enabled: true } }]);
    expect(() => fiber.update({ interval: 'x' })).toThrow(/invalid config:\n {2}- \$\.interval expected number but got x/);
    const bad = root.plugin({ name: 'raw-bad', Config: StatsConfig, apply: () => { seen.push('applied'); } }, { interval: -1 });
    await expect(bad.await()).rejects.toThrow(/invalid config/);
    expect(seen).not.toContain('applied');
  });
});

/**
 * Service-name contract: the names llm / llm-providers register at runtime are exactly
 * the names their api.ts augment onto Cordis `Context`, and every llm-owned service name
 * another plugin injects or looks up exists. Commands whose contract error is `string`
 * reject with strings under the debug contract check.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import { AppError } from '../../../platform/errors/api.ts';
import type { SettingsStore } from '../../../platform/settings/api.ts';
import { image } from '../../../platform/native/image/index.ts';
import { tokenizer } from '../../../platform/native/tokenizer/index.ts';
// boundary-allow cross-plugin-import: install the real L01 plugin to observe its registrations.
import providers from '../../llm-providers/index.ts';
import { llmReplayPlugin } from '../../llm-providers/api.ts';
import llm from '../index.ts';
import { realInjectionBudget } from './host.ts';

const ROOT = fileURLToPath(new URL('../../../../', import.meta.url));

/** Owned elsewhere: `llmUsage` is provided by platform/storage. */
const FOREIGN_OWNED = new Set(['llmUsage']);
/** Declared by llm-providers but provided only by the opt-in `dstu.llm-replay` plugin, never by the two entries. */
const OPT_IN = new Map([['llmReplay', llmReplayPlugin]]);
function declaredServices(apiFile: string): string[] {
  const text = readFileSync(join(ROOT, apiFile), 'utf8');
  const block = /declare module '@deepseek-ai\/cordis' \{\s*interface Context \{([\s\S]*?)\n {2}\}/.exec(text);
  if (block === null) throw new Error(`${apiFile}: no Context augmentation`);
  return [...block[1]!.matchAll(/^\s*'?([\w@]+)'?\??:/gm)].map(match => match[1]!).sort();
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (name === 'node_modules' || name === 'tests' || name === 'e2e') continue;
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (path.endsWith('.ts') && !path.endsWith('.test.ts')) out.push(path);
  }
  return out;
}

/** llm-prefixed names used in inject lists, ctx.get / reflect.get and optionalService lookups. */
function consumedLlmNames(): Map<string, string[]> {
  const used = new Map<string, string[]>();
  const ownDirs = ['host/plugins/llm/', 'host/plugins/llm-providers/'];
  for (const file of [...sourceFiles(join(ROOT, 'host')), ...sourceFiles(join(ROOT, 'electron'))]) {
    const rel = relative(ROOT, file);
    if (ownDirs.some(dir => rel.startsWith(dir))) continue;
    const text = readFileSync(file, 'utf8');
    const sites = text.matchAll(/(?:inject\s*(?:\(|:)\s*\[([^\]]*)\]|\.get\(\s*'([^']+)'|optionalService<[^>]*>\(\s*\w+,\s*'([^']+)')/g);
    for (const site of sites) {
      const names = site[1] !== undefined ? [...site[1].matchAll(/'([^']+)'/g)].map(m => m[1]!) : [site[2] ?? site[3]!];
      for (const name of names) {
        if (!/^llm/.test(name) && name !== 'essayGrading' && name !== 'embedding@1') continue;
        used.set(name, [...(used.get(name) ?? []), rel]);
      }
    }
  }
  return used;
}

function memorySettings(): SettingsStore & { fail: AppError | null } {
  const values = new Map<string, string>();
  const store = {
    fail: null as AppError | null,
    get(key: string) { if (store.fail) throw store.fail; return values.get(key) ?? null; },
    save(key: string, value: string) { if (store.fail) throw store.fail; values.set(key, value); },
    delete: (key: string) => values.delete(key),
    listByPrefix: () => [], deleteByPrefix: () => 0,
    getSecret: async (key: string) => values.get(key) ?? null,
    saveSecret: async (key: string, value: string) => { values.set(key, value); },
    deleteSecret: async (key: string) => values.delete(key),
  };
  return store;
}

async function startHost(settings: SettingsStore, extra: NonNullable<Parameters<typeof createTestHost>[0]>['plugins'] = []) {
  return createTestHost({ plugins: [providers, llm, ...extra], provide: {
    settings, secrets: { isEncryptedFormat: () => false, openCrypto: async () => ({ migratePlaintextKey: (value: string) => value }) },
    nativeImage: image, nativeTokenizer: tokenizer, injectionBudget: realInjectionBudget, vfsDatabase: {}, vfsRepo: { essays: {} },
  } });
}

let host: Awaited<ReturnType<typeof startHost>> | undefined;
afterEach(async () => { await host?.dispose(); host = undefined; });

describe('llm service-name contract', () => {
  it('every Context name declared by llm and llm-providers is registered at runtime', async () => {
    host = await startHost(memorySettings());
    const declared = [...declaredServices('host/plugins/llm/api.ts'), ...declaredServices('host/plugins/llm-providers/api.ts')];
    expect(declared).toEqual(expect.arrayContaining([...OPT_IN.keys()]));
    expect(declared.filter(name => !OPT_IN.has(name) && host!.ctx.get(name as never) === undefined)).toEqual([]);
    // Default off: opt-in names stay absent until their plugin is mounted.
    expect([...OPT_IN.keys()].filter(name => host!.ctx.get(name as never) !== undefined)).toEqual([]);
  });

  it('opt-in names are registered once their plugin is mounted', async () => {
    host = await startHost(memorySettings(), [...OPT_IN.values()].map(plugin => [plugin, { scripts: {} }] as const));
    expect([...OPT_IN.keys()].filter(name => host!.ctx.get(name as never) === undefined)).toEqual([]);
  });

  it('every ctx.provide name in the plugin entries is declared on Context', () => {
    const declared = new Set([...declaredServices('host/plugins/llm/api.ts'), ...declaredServices('host/plugins/llm-providers/api.ts')]);
    const provided = ['host/plugins/llm/index.ts', 'host/plugins/llm-providers/index.ts']
      .flatMap(file => [...readFileSync(join(ROOT, file), 'utf8').matchAll(/ctx\.provide\('([^']+)'/g)].map(m => m[1]!));
    expect(provided.filter(name => !declared.has(name))).toEqual([]);
  });

  it('llm-owned names consumed by other plugins are all provided', () => {
    const declared = new Set([...declaredServices('host/plugins/llm/api.ts'), ...declaredServices('host/plugins/llm-providers/api.ts')]);
    const consumed = consumedLlmNames();
    expect([...consumed.keys()]).toEqual(expect.arrayContaining(['llm', 'llmStreaming', 'llmReranker']));
    const unknown = [...consumed].filter(([name]) => !declared.has(name) && !FOREIGN_OWNED.has(name));
    expect(unknown).toEqual([]);
  });

  it('vfs and vfs-index both resolve rerank through the single llmReranker name', () => {
    const consumed = consumedLlmNames();
    expect(consumed.get('llmReranker')).toEqual(expect.arrayContaining(['host/plugins/vfs/src/plugin.ts', 'host/plugins/vfs-index/src/runtime-adapter.ts']));
    expect(consumed.has('llmRerank')).toBe(false);
  });
});

describe('llm commands with a string error contract', () => {
  it('check_api_config_status rejects with the Rust string, not an AppError, when configs cannot be read', async () => {
    const settings = memorySettings();
    host = await startHost(settings);
    settings.fail = AppError.database('磁盘只读');
    const error = await host.invoke('check_api_config_status').then(() => null, (reason: unknown) => reason);
    expect(typeof error).toBe('string');
    expect(error).toMatch(/^获取配置失败: /);
    expect(error).not.toMatch(/violates its contract/);
  });

  it('restore_default_api_configs rejects with the Rust string, not an AppError, when saving fails', async () => {
    const settings = memorySettings();
    host = await startHost(settings);
    settings.fail = AppError.database('磁盘只读');
    const error = await host.invoke('restore_default_api_configs').then(() => null, (reason: unknown) => reason);
    expect(typeof error).toBe('string');
    expect(error).toMatch(/^保存默认配置失败: /);
    expect(error).not.toMatch(/violates its contract/);
  });
});

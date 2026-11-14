import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { PluginHost, type PluginDefinition, type MethodContract } from '../../../src/plugin-runtime/host';
import { translationContract } from '../../../src/plugin-runtime/contracts/validation';

const numberContract: MethodContract = {
  input: (value) => { if (typeof value !== 'number') throw new Error('number input required'); },
  output: (value) => { if (typeof value !== 'number') throw new Error('number output required'); },
};
const provider = (id: string, multiplier: number): PluginDefinition => ({
  manifest: { id, apiVersion: 1, requires: [], provides: ['calculator@1'] },
  activate: (ctx) => ctx.provide('calculator@1', { run: async (value) => Number(value) * multiplier }),
});
const dirs: string[] = [];
afterEach(async () => { for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true }); });

describe('plugin ownership and replacement', () => {
  it('replaces the official provider at the same contract, without changing its consumer', async () => {
    const host = new PluginHost({ 'calculator@1': { run: numberContract } });
    await host.install(provider('official', 2));
    const consumer = () => host.call('calculator@1', 'run', 3);
    expect(await consumer()).toBe(6);
    await expect(host.install(provider('user', 4))).rejects.toMatchObject({ code: 'provider_exists' });
    await host.unload('official');
    await host.install(provider('user', 4));
    expect(await consumer()).toBe(12);
    await host.dispose();
    await expect(consumer()).rejects.toMatchObject({ code: 'service_unavailable' });
  });

  it('keeps schema validation under host ownership when a provider is replaced', async () => {
    const host = new PluginHost({ 'calculator@1': { run: numberContract } });
    await host.install({ ...provider('bad', 1), activate: (ctx) => ctx.provide('calculator@1', { run: async () => 'not a number' }) });
    await expect(host.call('calculator@1', 'run', 'bad input')).rejects.toThrow('number input');
    await expect(host.call('calculator@1', 'run', 1)).rejects.toThrow('number output');
    await host.dispose();
  });

  it('routes plugin-to-plugin calls through declared service contracts', async () => {
    const host = new PluginHost({ 'calculator@1': { run: numberContract }, 'consumer@1': { run: numberContract } });
    await host.install(provider('provider', 3));
    await host.install({
      manifest: { id: 'consumer', apiVersion: 1, requires: ['calculator@1'], provides: ['consumer@1'] },
      activate: (ctx) => ctx.provide('consumer@1', {
        run: (input, invocation) => ctx.call('calculator@1', 'run', input, { signal: invocation.signal }),
      }),
    });
    expect(await host.call('consumer@1', 'run', 4)).toBe(12);
    await host.dispose();
  });

  it('rolls back every effect in reverse order if activation fails', async () => {
    const host = new PluginHost();
    const disposed: number[] = [];
    await expect(host.install({
      manifest: { id: 'broken', apiVersion: 1, requires: [], provides: ['x@1'] },
      activate(ctx) {
        ctx.provideValue('x@1', {});
        ctx.effect(() => { disposed.push(1); });
        ctx.effect(() => { disposed.push(2); throw new Error('cleanup failure'); });
        throw new Error('activation failure');
      },
    })).rejects.toThrow('activation failure');
    expect(disposed).toEqual([2, 1]);
    expect(host.has('x@1')).toBe(false);
    await host.install({ manifest: { id: 'broken', apiVersion: 1, requires: [], provides: ['x@1'] }, activate: (ctx) => ctx.provideValue('x@1', {}) });
    await host.dispose();
  });

  it('rejects missing and undeclared dependencies and protects an active dependent', async () => {
    const host = new PluginHost();
    const dependent: PluginDefinition = { manifest: { id: 'child', apiVersion: 1, requires: ['x@1'], provides: [] }, activate: (ctx) => { ctx.use('x@1'); } };
    await expect(host.install(dependent)).rejects.toMatchObject({ code: 'service_unavailable' });
    await host.install({ manifest: { id: 'parent', apiVersion: 1, requires: [], provides: ['x@1'] }, activate: (ctx) => ctx.provideValue('x@1', {}) });
    await expect(host.install({ ...dependent, manifest: { ...dependent.manifest, requires: [] } })).rejects.toMatchObject({ code: 'undeclared_dependency' });
    await host.install(dependent);
    await expect(host.unload('parent')).rejects.toMatchObject({ code: 'dependents_active' });
    await host.dispose();
    expect(host.has('x@1')).toBe(false);
  });

  it('stops admission, cancels active calls and waits for cleanup before disposing effects', async () => {
    const host = new PluginHost({ 'calculator@1': { run: numberContract } });
    const events: string[] = [];
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    await host.install({
      ...provider('worker', 1),
      activate(ctx) {
        ctx.effect(() => { events.push('disposed'); });
        ctx.provide('calculator@1', { run: async (_input, call) => {
          entered();
          await new Promise<void>((resolve) => call.signal.addEventListener('abort', () => resolve(), { once: true }));
          await Promise.resolve();
          events.push('cleaned');
          return 0;
        } });
      },
    });
    const running = host.call('calculator@1', 'run', 1);
    await ready;
    const stopping = host.unload('worker');
    await expect(host.call('calculator@1', 'run', 1)).rejects.toMatchObject({ code: 'service_unavailable' });
    await stopping;
    expect(await running).toBe(0);
    expect(events).toEqual(['cleaned', 'disposed']);
  });

  it('loads a user module from an external profile and rolls back a broken profile', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'dstu-plugin-test-')); dirs.push(dir);
    await writeFile(path.join(dir, 'custom.mjs'), `export default {
      manifest: {id:'user.external', apiVersion:1, provides:['calculator@1'], requires:[]},
      activate(ctx) { ctx.provide('calculator@1', {run: async (n) => n + 41}); }
    };`);
    const profile = path.join(dir, 'profile.json');
    await writeFile(profile, JSON.stringify({ plugins: [{ entry: './custom.mjs' }] }));
    await writeFile(path.join(dir, 'missing.mjs'), `export default {
      manifest: {id:'missing',apiVersion:1,provides:[],requires:['absent@1']},activate(){}
    };`);
    const brokenProfile = path.join(dir, 'broken.json');
    await writeFile(brokenProfile, JSON.stringify({ plugins: [{ entry: './custom.mjs' }, { entry: './missing.mjs' }] }));
    // A real Node carrier, not Vite's module loader: external files must work
    // outside the repository without rebuilding the desktop application.
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import { PluginHost } from ${JSON.stringify(pathToFileURL(path.resolve('.plugin-build/src/plugin-runtime/host.js')).href)};
      import { loadProfile } from ${JSON.stringify(pathToFileURL(path.resolve('scripts/plugins/profile.mjs')).href)};
      const numeric = v => { if (typeof v !== 'number') throw Error('number required'); };
      const host = new PluginHost({'calculator@1':{run:{input:numeric,output:numeric}}});
      const installed = await loadProfile(host, process.env.PLUGIN_PROFILE);
      const value = await host.call('calculator@1','run',1);
      await host.dispose();
      let failed = false;
      try { await loadProfile(host, process.env.BROKEN_PROFILE); } catch { failed = true; }
      console.log(JSON.stringify({installed,value,failed,remaining:host.has('calculator@1')}));
    `], { encoding: 'utf8', env: { ...process.env, PLUGIN_PROFILE: profile, BROKEN_PROFILE: brokenProfile } });
    expect(result.stderr).toBe('');
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ installed: ['user.external'], value: 42, failed: true, remaining: false });
  });
});

describe('wire contract', () => {
  it('rejects malformed requests/results/events while preserving legacy optional null fields', () => {
    const request = { text: '你好', src_lang: 'auto', tgt_lang: 'en', session_id: 'x', glossary: null };
    expect(() => translationContract.input(request)).not.toThrow();
    expect(() => translationContract.input({ ...request, glossary: [['one']] })).toThrow();
    expect(() => translationContract.input({ ...request, text: 42 })).toThrow();
    expect(() => translationContract.output(null)).not.toThrow();
    expect(() => translationContract.output({ translated_text: 'missing fields' })).toThrow();
    expect(() => translationContract.event!({ type: 'data', chunk: 'x', delta: 'x', char_count: -1, word_count: 1 })).toThrow();
  });
});

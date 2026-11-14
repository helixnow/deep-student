import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestHost } from '../../../kernel/testing.ts';
import plugin from '../index.ts';
import { databaseFixture, vfsStub } from './database-fixture.ts';
import type { ListAgentProfilesResponse } from '../api.ts';
import { lockCustomAgentFiles } from '../../agent-orchestration/api.ts';
// boundary-allow cross-plugin-impl: wire agent-orchestration local-node runtime port for desktop host tests
import { setLocalNodeRuntime } from '../../agent-orchestration/src/local-node-runtime.ts';
// boundary-allow cross-plugin-impl: wire agent-orchestration local-node runtime port for desktop host tests
import { nodeLocalNodeRuntime } from '../../agent-orchestration/src/local-node-runtime.node.ts';

// 人设写入走 agent-orchestration 的同步端口；桌面入口注入 `node:fs` 实现，测试直接装同一份。
beforeAll(() => { setLocalNodeRuntime(nodeLocalNodeRuntime); });
afterAll(() => { setLocalNodeRuntime(null); });

describe('workspace_list_agent_profiles', () => {
  let f: ReturnType<typeof databaseFixture>;
  let host: Awaited<ReturnType<typeof createTestHost>>;
  let directory: string;
  let modelCatalog: { id: string; enabled: boolean; isEmbedding?: boolean }[];
  let catalogError: Error | null;
  let catalogCalls: number;
  beforeEach(async () => {
    f = databaseFixture();
    directory = join(f.root, 'agents');
    modelCatalog = [{ id: 'cfg_exact', enabled: true }]; catalogError = null; catalogCalls = 0;
    host = await createTestHost({ plugins: [plugin], provide: {
      storage: f.storage, vfs: vfsStub, agentWorkspace: { customAgentsDir: () => directory },
      llm: { async getApiConfigs() {
        catalogCalls++;
        if (catalogError !== null) throw catalogError;
        return modelCatalog;
      } },
    } });
  });
  afterEach(async () => { await host.dispose(); f.dispose(); });

  it('creates the directory and preserves builtin order and nullable summary fields', async () => {
    const result = await host.invoke<ListAgentProfilesResponse>('workspace_list_agent_profiles');
    expect(result.agentsDir).toBe(directory);
    expect(existsSync(directory)).toBe(true);
    expect(result.customFiles).toEqual([]);
    expect(result.builtin.map(profile => profile.id)).toEqual(['default', 'worker', 'explorer']);
    for (const profile of result.builtin) {
      expect(profile.description).toEqual(expect.any(String));
      expect(profile.model).toBeNull();
      if (profile.id === 'explorer') {
        expect(profile.toolCount).toBeGreaterThan(0);
      } else {
        expect(profile.toolCount).toBe(0);
      }
    }
  });

  it('lists invalid definitions and marks only the first valid duplicate active', async () => {
    mkdirSync(directory);
    const content = '---\nname: my-agent\ndescription: 中文说明\nbase: worker\n---\nDo research.';
    writeFileSync(join(directory, 'z.md'), content);
    writeFileSync(join(directory, 'a.md'), content);
    writeFileSync(join(directory, '0-invalid.md'), '---\nname: my-agent\nbase: missing\n---\nInvalid.');
    const result = await host.invoke<ListAgentProfilesResponse>('workspace_list_agent_profiles');
    expect(result.customFiles.map(file => [file.fileName, file.valid, file.active, file.name])).toEqual([
      ['0-invalid.md', false, false, 'my-agent'], ['a.md', true, true, 'my-agent'], ['z.md', true, false, 'my-agent'],
    ]);
    expect(result.customFiles[0]!.toolCount).toBeNull();
    expect(result.customFiles[1]).toMatchObject({ bytes: Buffer.byteLength(content),
      description: '中文说明', base: 'worker', model: null, modifiedAt: expect.any(String), toolCount: 0 });
  });

  it('warns and returns builtins when ensuring the directory fails', async () => {
    writeFileSync(directory, 'not a directory');
    const warnings: string[] = [];
    host.ctx.logger.exporter({ levels: { default: 3 }, export(message) {
      if (message.type === 'warn') warnings.push(String(message.args[0]));
    } });
    const result = await host.invoke<ListAgentProfilesResponse>('workspace_list_agent_profiles');
    expect(result.builtin).toHaveLength(3);
    expect(result.customFiles).toEqual([]);
    expect(warnings.some(message => message.startsWith(`[Workspace::handlers] Failed to ensure custom agents dir ${directory}: `))).toBe(true);
  });
  it('reads full UTF-8 content while preserving the original input file name', async () => {
    mkdirSync(directory); writeFileSync(join(directory, 'profile.md'), '\ufeff你好\r\nbody');
    expect(await host.invoke('workspace_read_agent_profile_file', { fileName: ' profile.md ' }))
      .toEqual({ fileName: ' profile.md ', content: '\ufeff你好\r\nbody' });
    await expect(host.invoke('workspace_read_agent_profile_file', { fileName: 'missing.md' })).rejects.toBe('PROFILE_FILE_NOT_FOUND');
    writeFileSync(join(directory, 'profile.md'), Buffer.from([0xff]));
    await expect(host.invoke('workspace_read_agent_profile_file', { fileName: 'profile.md' }))
      .rejects.toBe("Failed to read profile file 'profile.md': stream did not contain valid UTF-8");
  });
  it('deletes only after acquiring the shared L06 lock and releases it on missing-file errors', async () => {
    mkdirSync(directory); writeFileSync(join(directory, 'profile.md'), 'body');
    const release = await lockCustomAgentFiles();
    const operation = host.invoke('workspace_delete_agent_profile_file', { fileName: 'profile.md' });
    await Promise.resolve(); expect(existsSync(join(directory, 'profile.md'))).toBe(true);
    release(); await expect(operation).resolves.toBeNull(); expect(existsSync(join(directory, 'profile.md'))).toBe(false);
    await expect(host.invoke('workspace_delete_agent_profile_file', { fileName: 'profile.md' })).rejects.toBe('PROFILE_FILE_NOT_FOUND');
    writeFileSync(join(directory, 'second.md'), 'body');
    await expect(host.invoke('workspace_delete_agent_profile_file', { fileName: 'second.md' })).resolves.toBeNull();
  });
  it('save uses public persona validation and atomic writer with original fileName and UTF-8 byte count', async () => {
    const content = '---\nname: research-agent\nbase: worker\n---\n中文正文';
    const result = await host.invoke('workspace_save_agent_profile_file', { fileName: ' agent.md ', content, overwrite: false });
    expect(result).toEqual({ fileName: ' agent.md ', agentName: 'research-agent', bytes: Buffer.byteLength(content), warnings: [] });
    expect(readFileSync(join(directory, 'agent.md'), 'utf8')).toBe(content);
    expect(catalogCalls).toBe(0);
    await expect(host.invoke('workspace_save_agent_profile_file', { fileName: 'agent.md', content, overwrite: false })).rejects.toBe('PROFILE_FILE_EXISTS');
    await expect(host.invoke('workspace_save_agent_profile_file', { fileName: 'agent.md', content: `${content}\nupdated`, overwrite: true })).resolves.toMatchObject({ warnings: [] });
    expect(readFileSync(join(directory, 'agent.md'), 'utf8')).toBe(`${content}\nupdated`);
  });
  it('save validates content and exact model identity before resolving an invalid path', async () => {
    const content = '---\nname: research-agent\nbase: worker\nmodel: cfg_exact\n---\nbody';
    await expect(host.invoke('workspace_save_agent_profile_file', { fileName: '../bad.md', content: '', overwrite: false })).rejects.toBe('content must not be empty');
    expect(catalogCalls).toBe(0);
    modelCatalog = [];
    await expect(host.invoke('workspace_save_agent_profile_file', { fileName: '../bad.md', content, overwrite: false })).rejects.toBe("PERSONA_MODEL_NOT_FOUND: model configuration id 'cfg_exact' does not exist");
    modelCatalog = [{ id: 'cfg_exact', enabled: false, isEmbedding: true }];
    await expect(host.invoke('workspace_save_agent_profile_file', { fileName: 'agent.md', content, overwrite: false })).rejects.toBe("PERSONA_MODEL_DISABLED: model configuration 'cfg_exact' is disabled or has no usable authentication");
    modelCatalog[0]!.enabled = true;
    await expect(host.invoke('workspace_save_agent_profile_file', { fileName: 'agent.md', content, overwrite: false })).rejects.toBe("PERSONA_MODEL_UNSUPPORTED: model configuration 'cfg_exact' is not a chat generation model");
    expect(existsSync(join(directory, 'agent.md'))).toBe(false);
    modelCatalog = [{ id: 'cfg_exact', enabled: true }];
    await expect(host.invoke('workspace_save_agent_profile_file', { fileName: 'agent.md', content, overwrite: false })).resolves.toMatchObject({ warnings: [], agentName: 'research-agent' });
    expect(readFileSync(join(directory, 'agent.md'), 'utf8')).toBe(content);
  });
  it('only catalog read failure becomes a warning while saving under the shared lock', async () => {
    const content = '---\nname: research-agent\nbase: worker\nmodel: cfg_exact\n---\nbody';
    catalogError = new Error('catalog unavailable');
    const release = await lockCustomAgentFiles();
    const operation = host.invoke('workspace_save_agent_profile_file', { fileName: 'agent.md', content, overwrite: false });
    try {
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(existsSync(join(directory, 'agent.md'))).toBe(false);
      mkdirSync(directory); writeFileSync(join(directory, 'agent.md'), 'racing write');
    } finally { release(); }
    await expect(operation).rejects.toBe('PROFILE_FILE_EXISTS');
    expect(readFileSync(join(directory, 'agent.md'), 'utf8')).toBe('racing write');
    const result = await host.invoke('workspace_save_agent_profile_file', { fileName: 'agent.md', content, overwrite: true });
    expect(result).toEqual({ fileName: 'agent.md', agentName: 'research-agent', bytes: Buffer.byteLength(content), warnings: [{
      code: 'PERSONA_MODEL_CATALOG_UNAVAILABLE', model_id: 'cfg_exact',
      message: 'Failed to read the model catalog: catalog unavailable. The profile was saved, but runtime will require this exact model configuration and will not fall back.',
    }] });
    expect(readFileSync(join(directory, 'agent.md'), 'utf8')).toBe(content);
  });
});

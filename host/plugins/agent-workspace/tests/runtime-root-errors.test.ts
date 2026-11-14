import * as fs from 'node:fs';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';
import nativePlugin from '../../../platform/native/index.ts';
import { AUTHORIZED_ROOTS_KEY, WORKSPACE_ROOT_KEY, loadWorkspaceRecord, loadAuthorizedRecords, saveWorkspaceRecord } from '../src/runtime-roots.ts';
import { memorySettings } from './support.ts';
import { encodeRuntimeRootRecord } from '../src/runtime-root-records.ts';

// Host setup preloads the public barrel; reload before installing the fs fault injection.
vi.hoisted(() => vi.resetModules());
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, readSync: vi.fn(actual.readSync) };
});

afterEach(() => { vi.restoreAllMocks(); });

it('W1 settings failures retain the complete Rust error at the IPC boundary', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const settings = host.ctx.settings;
    const root = path.join(host.app.dataDir, 'root');
    fs.mkdirSync(root);
    const fail = () => { throw new Error('database is locked'); };
    const get = vi.spyOn(settings, 'get').mockImplementation(fail);
    await expect(host.invoke('chat_v2_list_runtime_roots', {})).rejects.toBe('Failed to load workspace runtime root: database is locked');
    get.mockRestore();
    const authorizedGet = vi.spyOn(settings, 'get').mockImplementation(key => {
      if (key === AUTHORIZED_ROOTS_KEY) return fail();
      return null;
    });
    await expect(host.invoke('chat_v2_list_runtime_roots', {})).rejects.toBe('Failed to load authorized runtime roots: database is locked');
    authorizedGet.mockRestore();
    const save = vi.spyOn(settings, 'save').mockImplementation(fail);
    await expect(host.invoke('chat_v2_set_workspace_root', { path: root })).rejects.toBe('Failed to save workspace runtime root: database is locked');
    await expect(host.invoke('chat_v2_authorize_runtime_root', { path: root })).rejects.toBe('Failed to save authorized runtime roots: database is locked');
    const skillRoot = path.join(host.app.dataDir, '.skills', 'demo');
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '---\nname: demo\n---\nBody');
    await expect(host.invoke('chat_v2_set_skill_trust', { skillId: 'demo', packageRoot: skillRoot, trusted: true }))
      .rejects.toBe('Failed to persist skill trust: database is locked');
    save.mockRestore();
    vi.spyOn(settings, 'delete').mockImplementation(fail);
    await expect(host.invoke('chat_v2_reset_workspace_root', {})).rejects.toBe('Failed to reset workspace runtime root: database is locked');
    await expect(host.invoke('chat_v2_set_skill_trust', { skillId: 'demo', trusted: false })).rejects.toBe('Failed to revoke skill trust: database is locked');
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

it.each([
  ['{}', 'invalid type: map, expected a sequence at line 1 column 0'],
  ['null', 'invalid type: null, expected a sequence at line 1 column 4'],
  ['[{}]', 'missing field `id` at line 1 column 3'],
  ['[{"id":true}]', 'invalid type: boolean `true`, expected a string at line 1 column 11'],
])('W1 authorized record serde rejects %s', (raw, detail) => {
  expect(() => loadAuthorizedRecords(memorySettings({ [AUTHORIZED_ROOTS_KEY]: raw })))
    .toThrow(`Failed to parse authorized runtime roots: ${detail}`);
});

it.each([
  ['{}', 'missing field `path` at line 1 column 2'],
  ['{"path":"/tmp"}', 'missing field `label` at line 1 column 15'],
  ['{"path":null,"label":"x"}', 'invalid type: null, expected path string at line 1 column 12'],
  ['{"path":"/tmp","label":"x","access":"bad"}', 'unknown variant `bad`, expected `read_only` or `read_write` at line 1 column 41'],
  ['{"path":"/tmp","path":"/other","label":"x"}', 'duplicate field `path` at line 1 column 21'],
])('W1 workspace record serde rejects %s', (raw, detail) => {
  expect(() => loadWorkspaceRecord(memorySettings({ [WORKSPACE_ROOT_KEY]: raw })))
    .toThrow(`Failed to parse workspace runtime root setting '${WORKSPACE_ROOT_KEY}': ${detail}`);
});

it('W1 record decoding applies defaults, enum map form and ignores unknown fields', () => {
  const settings = memorySettings();
  settings.save(WORKSPACE_ROOT_KEY, '{"path":"/tmp","label":"x","extra":true}');
  expect(loadWorkspaceRecord(settings)).toEqual({ path: '/tmp', label: 'x', access: 'read_only', identity: null });
  settings.save(WORKSPACE_ROOT_KEY, '{"path":"/tmp","label":"x","access":{"read_write":null}}');
  expect(loadWorkspaceRecord(settings)?.access).toBe('read_write');
  settings.save(AUTHORIZED_ROOTS_KEY, '[["id","/tmp","x"]]');
  expect(loadAuthorizedRecords(settings)).toEqual([{ id: 'id', path: '/tmp', label: 'x', identity: null }]);
  settings.save(WORKSPACE_ROOT_KEY, '{"path":"/tmp","label":"x","identity":{"kind":"unix","device":9007199254740993,"inode":18446744073709551615}}');
  const large = loadWorkspaceRecord(settings)!;
  expect(large.identity).toEqual({ kind: 'unix', device: 9007199254740993n, inode: 18446744073709551615n });
  saveWorkspaceRecord(settings, large);
  expect(settings.get(WORKSPACE_ROOT_KEY)).toContain('"device":9007199254740993,"inode":18446744073709551615');
  expect(loadWorkspaceRecord(settings)).toEqual(large);
});

it('W1 malformed settings reject through the production command with serde context', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    host.ctx.settings.save(AUTHORIZED_ROOTS_KEY, '{}');
    await expect(host.invoke('chat_v2_list_runtime_roots', {}))
      .rejects.toBe('Failed to parse authorized runtime roots: invalid type: map, expected a sequence at line 1 column 0');
    host.ctx.settings.delete(AUTHORIZED_ROOTS_KEY);
    host.ctx.settings.save(WORKSPACE_ROOT_KEY, '{');
    await expect(host.invoke('chat_v2_list_runtime_roots', {}))
      .rejects.toBe(`Failed to parse workspace runtime root setting '${WORKSPACE_ROOT_KEY}': EOF while parsing an object at line 1 column 1`);
    host.ctx.settings.save(WORKSPACE_ROOT_KEY, '{"path":"/tmp","label":"x","identity":{"kind":"unix","device":1}}');
    await expect(host.invoke('chat_v2_list_runtime_roots', {}))
      .rejects.toBe(`Failed to parse workspace runtime root setting '${WORKSPACE_ROOT_KEY}': missing field \`inode\` at line 1 column 64`);
    await host.invoke('chat_v2_set_workspace_root', { path: host.app.dataDir });
    const record = loadWorkspaceRecord(host.ctx.settings);
    if (!record?.identity) throw new Error('missing persisted identity');
    const reordered = { ...record, identity: Object.fromEntries(Object.entries(record.identity).reverse()) };
    host.ctx.settings.save(WORKSPACE_ROOT_KEY, encodeRuntimeRootRecord(reordered));
    await expect(host.invoke('chat_v2_list_runtime_roots', {}))
      .resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: 'workspace', configured: true })]));
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

it('R2-W1 typed field errors precede later truncated JSON at the IPC boundary', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const workspacePrefix = `Failed to parse workspace runtime root setting '${WORKSPACE_ROOT_KEY}': `;
    const authorizedPrefix = 'Failed to parse authorized runtime roots: ';
    const cases: Array<[string, string, string]> = [
      [WORKSPACE_ROOT_KEY, '{"path":null,"label":', workspacePrefix + 'invalid type: null, expected path string at line 1 column 12'],
      [WORKSPACE_ROOT_KEY, '{"label":true,"path":', workspacePrefix + 'invalid type: boolean `true`, expected a string at line 1 column 13'],
      [WORKSPACE_ROOT_KEY, '{"path":{},"label":', workspacePrefix + 'invalid type: map, expected path string at line 1 column 8'],
      [WORKSPACE_ROOT_KEY, '{"path":"x","path":', workspacePrefix + 'duplicate field `path` at line 1 column 18'],
      [WORKSPACE_ROOT_KEY, '[null,', workspacePrefix + 'invalid type: null, expected path string at line 1 column 5'],
      [AUTHORIZED_ROOTS_KEY, '[{"id":true,"path":', authorizedPrefix + 'invalid type: boolean `true`, expected a string at line 1 column 11'],
      [AUTHORIZED_ROOTS_KEY, '[{},', authorizedPrefix + 'missing field `id` at line 1 column 3'],
      [WORKSPACE_ROOT_KEY, '{"path":"x","label":', workspacePrefix + 'EOF while parsing a value at line 1 column 20'],
    ];
    for (const [key, raw, expected] of cases) {
      host.ctx.settings.delete(WORKSPACE_ROOT_KEY);
      host.ctx.settings.delete(AUTHORIZED_ROOTS_KEY);
      host.ctx.settings.save(key, raw);
      await expect(host.invoke('chat_v2_list_runtime_roots', {}), raw).rejects.toBe(expected);
    }
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

it('W1 runtime preview read failure keeps the read step prefix', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const root = path.join(host.app.dataDir, 'preview');
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root, 'file.txt'), 'hello');
    await host.invoke('chat_v2_set_workspace_root', { path: root });
    const original = (await vi.importActual<typeof import('node:fs')>('node:fs')).readSync;
    if (process.platform === 'win32') {
      if (!host.ctx.get('nativeWindowsFiles')) await host.install(nativePlugin);
      const native = host.ctx.nativeWindowsFiles;
      const open = native.openRegularFileNoFollow.bind(native);
      vi.spyOn(native, 'openRegularFileNoFollow').mockImplementation((target, label) => {
        const file = open(target, label);
        vi.spyOn(file, 'readAt').mockImplementation(() => { throw new Error('Input/output error (os error 5)'); });
        return file;
      });
    }
    vi.mocked(fs.readSync).mockImplementation(((...args: Parameters<typeof fs.readSync>) => {
      if (Buffer.isBuffer(args[1]) && args[1].length === 65_537) {
        throw Object.assign(new Error('read failed'), { code: 'EIO', errno: -5 });
      }
      return Reflect.apply(original, fs, args);
    }) as typeof fs.readSync);
    await expect(host.invoke('chat_v2_read_runtime_file', {
      sessionId: 'test', rootId: 'workspace', relativePath: 'file.txt',
    })).rejects.toBe('Failed to read file: Input/output error (os error 5)');
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

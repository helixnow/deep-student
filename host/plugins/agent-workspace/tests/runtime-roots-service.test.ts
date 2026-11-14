import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { createWorkspaceHost } from './host-support.ts';
import { resolveStagedFileInTempRoot } from '../api.ts';

it('L13 runtimeRoots resolves session-managed upload roots without creating them', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const roots = host.ctx.runtimeRoots;
    const first = roots.rootById('artifacts', { session_id: 'upload-a' });
    const second = roots.rootById('artifacts', { session_id: 'upload-b' });
    expect(first.path).not.toBe(second.path);
    expect(first.session_scoped).toBe(true);
    expect(fs.existsSync(first.path)).toBe(false);
    expect(fs.existsSync(second.path)).toBe(false);
    fs.mkdirSync(first.path, { recursive: true });
    expect(roots.revalidate(first)).toBe(fs.realpathSync.native(first.path));
    expect(() => roots.rootById('artifacts', {})).toThrow('requires a session_id');
    expect(() => roots.rootById('workspace', { session_id: 'upload-a' })).toThrow('Workspace root is not configured');

    const selected = path.join(host.app.dataDir, 'selected');
    fs.mkdirSync(selected);
    const authorized = await host.invoke('chat_v2_authorize_runtime_root', { path: selected }) as Array<{ id: string; path: string }>;
    const id = authorized.find(root => root.path === fs.realpathSync.native(selected))!.id;
    const root = roots.rootById(id, { session_id: 'upload-a' });
    expect(root.access).toBe('read_only');
    expect(roots.revalidate(root)).toBe(fs.realpathSync.native(selected));
    await host.invoke('chat_v2_revoke_runtime_root', { rootId: id });
    expect(() => roots.revalidate(root)).toThrow('Authorized runtime root was revoked');
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

it('L13 runtimeRoots uses the caller skill package mapping and current trust record', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const packageRoot = path.join(host.app.dataDir, '.skills', 'upload-skill');
    fs.mkdirSync(packageRoot, { recursive: true });
    fs.writeFileSync(path.join(packageRoot, 'SKILL.md'), '---\nname: upload-skill\n---\nBody');
    await host.invoke('chat_v2_set_skill_trust', { skillId: 'upload-skill', packageRoot, trusted: true });
    const context = { session_id: 'upload-a', skill_package_roots: { 'upload-skill': packageRoot } };
    const root = host.ctx.runtimeRoots.rootById('skill:upload-skill', context);
    expect(root.kind).toBe('skill_package');
    expect(root.access).toBe('read_only');
    expect(host.ctx.runtimeRoots.revalidate(root)).toBe(fs.realpathSync.native(packageRoot));
    expect(() => host.ctx.runtimeRoots.rootById('skill:upload-skill', { session_id: 'upload-b' }))
      .toThrow('No skill package roots are available in the current runtime context.');
    await host.invoke('chat_v2_set_skill_trust', { skillId: 'upload-skill', trusted: false });
    expect(() => host.ctx.runtimeRoots.rootById('skill:upload-skill', context))
      .toThrow("Skill 'upload-skill' is not trusted by the backend");
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

it('runtimeRoots probes AGENTS.md root candidates and the process cwd for the chat pipeline', async () => {
  const { host, storage } = await createWorkspaceHost();
  try {
    const roots = host.ctx.runtimeRoots;
    const dir = path.join(host.app.dataDir, 'project');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'file.txt'), 'x');
    expect(roots.isDirectory!(dir)).toBe(true);
    expect(roots.isDirectory!(path.join(dir, 'file.txt'))).toBe(false);
    expect(roots.isDirectory!(path.join(dir, 'missing'))).toBe(false);
    expect(roots.currentDir!()).toBe(process.cwd());
  } finally {
    storage.dispose();
    await host.dispose();
  }
});

it('resolveStagedFileInTempRoot keeps attachment_stage_executor.rs checks: regular file, no symlink, component-wise containment', () => {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'staged-')));
  try {
    const temp = path.join(base, 'temp');
    fs.mkdirSync(path.join(temp, 'in'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'in', 'a.json'), '{"a":1}');
    fs.writeFileSync(path.join(temp, '..dotted.json'), 'x');
    fs.writeFileSync(path.join(base, 'outside.json'), 'x');
    fs.symlinkSync(path.join(base, 'outside.json'), path.join(temp, 'link.json'));
    const staged = resolveStagedFileInTempRoot(temp, 'in/a.json');
    expect(staged.path).toBe(path.join(temp, 'in', 'a.json'));
    expect(staged.size()).toBe(7);
    expect(new TextDecoder().decode(staged.read())).toBe('{"a":1}');
    expect(resolveStagedFileInTempRoot(temp, '..dotted.json').path).toBe(path.join(temp, '..dotted.json'));
    expect(() => resolveStagedFileInTempRoot(temp, 'in/missing.json')).toThrow('Staged file not found: in/missing.json');
    expect(() => resolveStagedFileInTempRoot(temp, 'in')).toThrow('Staged path must be a regular file');
    expect(() => resolveStagedFileInTempRoot(temp, 'link.json')).toThrow('Staged path must be a regular file');
    expect(() => resolveStagedFileInTempRoot(path.join(base, 'missing'), 'in/a.json')).toThrow(/^Failed to canonicalize temp root: /);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

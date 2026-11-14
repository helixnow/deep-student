import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import JSZip from 'jszip';
import type { AppInfo } from '../../../kernel/api.ts';
import { WorkshopOperations, type WorkshopAdmin } from '../src/operations.ts';
import { seedTemplate } from '../src/resources.ts';
import { materializeGeneratedFiles } from '../src/generation.ts';

const brief = { sessionId: 'test', title: 'Recall', description: 'Practice', template: 'host-tool' as const, changes: [], capabilities: [] };
async function operations() {
  const dataDir = await mkdtemp(join(tmpdir(), 'dstu-operations-'));
  return new WorkshopOperations({ version: '0.20.0', dataDir, debug: true } as AppInfo);
}
async function terminal(ops: WorkshopOperations, id: string) {
  await vi.waitFor(async () => { expect((await ops.status(id)).state).not.toBe('generating'); }, { timeout: 5000 });
  return ops.status(id);
}
describe('workshop user operations', () => {
  it('RF-P3-workshop-tools: never generates on propose; cancels background writes and preserves files', async () => {
    const ops = await operations();
    const card = await ops.propose(brief);
    await expect(ops.create(card.id, card.revision)).rejects.toThrow('GENERATION_UNAVAILABLE');
    let finish!: () => void;
    const generate = vi.fn(async () => new Promise<void>(resolve => { finish = resolve; }));
    ops.bindGeneration({ generate });
    expect(generate).not.toHaveBeenCalled();
    const running = await ops.create(card.id, card.revision);
    expect(running.state).toBe('generating');
    await ops.cancel(card.id, running.revision);
    finish();
    expect((await ops.status(card.id)).state).toBe('cancelled');
    await expect(ops.install(card.id, running.revision)).rejects.toThrow('CONFLICT');
  });
  it('validates real ESM, freezes confirmation bytes, exports; user-only admin port preserves restore without model', async () => {
    const ops = await operations();
    const generate = vi.fn(async (card, source) => { await seedTemplate(source, card); });
    ops.bindGeneration({ generate });
    const card = await ops.propose(brief);
    await ops.create(card.id, card.revision);
    const ready = await terminal(ops, card.id);
    expect(ready.state, ready.error ?? '').toBe('pending-confirmation');
    await expect(ops.install(card.id, ready.revision)).rejects.toThrow('INSTALL_UNAVAILABLE');
    const exported = await ops.export(card.id);
    const zip = await JSZip.loadAsync(await readFile(exported.path));
    expect(Object.keys(zip.files)).toContain('dist/host.js');
    expect(Object.keys(zip.files)).not.toContain('index.ts');
    const installs: string[] = [];
    const admin: WorkshopAdmin = {
      inventory: async () => ({ revision: 'test-revision', safeMode: false, plugins: [] }),
      installManagedDirectory: async request => {
        installs.push(await readFile(join(request.directory, 'dist/host.js'), 'utf8'));
        return { id: request.id, version: request.version, enabled: false, revision: 'next', rollback: 'not-needed',
          consentRequired: { code: 'CONSENT_REQUIRED', id: request.id, version: request.version, permissions: request.permissions } };
      },
      uninstall: vi.fn(async () => null),
    };
    ops.bindAdmin(admin);
    await writeFile(join(ops.store.directory(card.id), 'source/index.ts'), 'export default null;');
    const installed = await ops.install(card.id, ready.revision);
    expect(installed.state).toBe('installed');
    expect(installs[0]).toContain('review');
    const revoked = await ops.revoke(card.id, installed.revision);
    expect(revoked.state).toBe('revoked');
    const restored = await ops.restore(card.id, revoked.revision);
    expect(restored.state).toBe('installed');
    expect(installs).toHaveLength(2);
    expect(generate).toHaveBeenCalledTimes(1);
  });
  it('rejects generated paths outside source before writing any file', async () => {
    const ops = await operations(), card = await ops.propose(brief);
    const source = join(ops.store.directory(card.id), 'source');
    await expect(materializeGeneratedFiles(source, JSON.stringify({ files: [{ path: '../profile.json', content: '{}' }] }), new AbortController().signal)).rejects.toThrow('outside source');
    const controller = new AbortController(); controller.abort();
    await materializeGeneratedFiles(source, '{"files":[{"path":"index.ts","content":"never"}]}', controller.signal);
    await expect(readFile(join(source, 'index.ts'))).rejects.toThrow();
  });
});

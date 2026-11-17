import { describe, expect, it, vi } from 'vitest';
import { reportWorkshopRuntimeFailure } from '../runtime-failures';
import { workshopItem, type WorkshopCard, type WorkshopRemote } from '../host-adapter';

const installed: WorkshopCard = {
  kind: 'dstu-plugin-workshop', id: 'one', pluginId: 'workshop.one', sessionId: 'chat', title: 'Sample',
  description: 'Show a working sample', template: 'learning-tool', state: 'installed', revision: 20,
  version: '2.0.0', capabilities: [], changes: [], trust: 'full', source: 'workshop', risk: '',
  check: null, error: null, previousVersion: '1.0.0', createdAt: '', updatedAt: '',
  installation: { state: 'installed', version: '2.0.0', previousVersion: '1.0.0' },
};
function remoteFor(card: WorkshopCard) {
  return { list: vi.fn().mockResolvedValue([card]), reportValidation: vi.fn(), reportFault: vi.fn() } as unknown as WorkshopRemote;
}

describe('managed runtime failure routing', () => {
  it('rejects a late old renderer failure after a replacement', async () => {
    const remote = remoteFor(installed);
    await reportWorkshopRuntimeFailure(remote, { id: installed.pluginId, version: '1.0.0', error: 'late error' });
    expect(remote.reportValidation).not.toHaveBeenCalled();
    expect(remote.reportFault).not.toHaveBeenCalled();
  });

  it('fails the exact pending activation revision, not the newer record revision', async () => {
    const card = { ...installed, validation: { version: '2.0.0', revision: 18, status: 'pending' as const } };
    const remote = remoteFor(card);
    await reportWorkshopRuntimeFailure(remote, { id: card.pluginId, version: '2.0.0', error: 'render failed' });
    expect(remote.reportValidation).toHaveBeenCalledWith('one', '2.0.0', 18, { ok: false, detail: 'render failed' });
    expect(remote.reportFault).not.toHaveBeenCalled();
  });

  it('recovers an older installed record without the split installation field', async () => {
    const remote = remoteFor({ ...installed, installation: undefined });
    await reportWorkshopRuntimeFailure(remote, { id: installed.pluginId, version: '2.0.0', error: 'runtime failed' });
    expect(remote.reportFault).toHaveBeenCalledWith('one', 'runtime failed', '2.0.0');
  });

  it('does not recover a revoked installation', async () => {
    const remote = remoteFor({ ...installed, state: 'revoked', installation: { state: 'revoked', version: '2.0.0' } });
    await reportWorkshopRuntimeFailure(remote, { id: installed.pluginId, version: '2.0.0', error: 'unmounted' });
    expect(remote.reportFault).not.toHaveBeenCalled();
  });

  it('keeps a live candidate in verification and exposes blocked work separately from its installation', () => {
    const validation = { version: '2.0.0', revision: 18, status: 'pending' as const };
    expect(workshopItem({ ...installed, validation, execution: { mode: 'delegated', stage: 'validating' } }, true).phase).toBe('validating');
    const blocked = workshopItem({ ...installed, validation, execution: { mode: 'delegated', stage: 'blocked', reason: 'Need a real interaction' } }, true);
    expect(blocked.phase).toBe('failed');
    expect(blocked.error).toBe('Need a real interaction');
    expect(blocked.installed?.version).toBe('2.0.0');
  });
});

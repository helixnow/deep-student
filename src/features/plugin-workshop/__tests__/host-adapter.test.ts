import { describe, expect, it, vi } from 'vitest';
import { HostWorkshopAdapter, workshopItem, type WorkshopCard, type WorkshopRemote } from '../host-adapter';
import { openWorkshopSession } from '../session';

const card: WorkshopCard = {
  kind: 'dstu-plugin-workshop', id: 'work-1', pluginId: 'workshop.one', sessionId: 'chat-1',
  title: '单词', description: '复习单词', template: 'learning-tool', state: 'draft', revision: 3,
  version: null, capabilities: ['service:notes'], changes: ['初始版本'], trust: 'full', source: 'workshop',
  risk: '同进程', check: null, error: null, previousVersion: null, createdAt: '', updatedAt: '',
};

function fixture() {
  const remote: WorkshopRemote = {
    bindSession: vi.fn().mockResolvedValue(card),
    list: vi.fn().mockResolvedValue([card]), status: vi.fn().mockResolvedValue(card),
    create: vi.fn().mockResolvedValue({ ...card, state: 'generating' }),
    install: vi.fn().mockResolvedValue(card), cancel: vi.fn().mockResolvedValue(card),
    revoke: vi.fn().mockResolvedValue(card), restore: vi.fn().mockResolvedValue(card),
    export: vi.fn().mockResolvedValue({ id: card.id, version: '1', path: '/managed/one.dstuplugin' }),
  };
  const manager = { list: vi.fn().mockResolvedValue({ plugins: [{ id: card.pluginId, enabled: false }] }), setEnabled: vi.fn().mockResolvedValue({ ok: true }) };
  return { remote, manager, adapter: new HostWorkshopAdapter(remote, manager) };
}

describe('P3 wire adapter contract (transport double, not Host E2E)', () => {
  it('separates creating a draft from installing a built candidate, preserving the displayed revision', async () => {
    const { adapter, remote } = fixture();
    await adapter.act('confirm', workshopItem(card));
    expect(remote.create).toHaveBeenCalledWith('work-1', 3);
    expect(remote.install).not.toHaveBeenCalled();
    await adapter.act('confirm', workshopItem({ ...card, state: 'pending-confirmation', revision: 7 }));
    expect(remote.install).toHaveBeenCalledWith('work-1', 7);
  });
  it('restore calls only Host restore, never model create', async () => {
    const { adapter, remote } = fixture();
    await adapter.act('restore', workshopItem({ ...card, state: 'revoked' }));
    expect(remote.restore).toHaveBeenCalledWith('work-1', 3);
    expect(remote.create).not.toHaveBeenCalled();
    expect(remote.install).not.toHaveBeenCalled();
  });
  it('reads stopped intent from manager and exposes the exported managed file', async () => {
    const { adapter, remote, manager } = fixture();
    vi.mocked(remote.list).mockResolvedValue([{ ...card, state: 'installed' }]);
    expect((await adapter.list())[0].phase).toBe('disabled');
    await adapter.act('try', workshopItem({ ...card, state: 'installed' }));
    expect(manager.setEnabled).toHaveBeenCalledWith(card.pluginId, true);
    expect((await adapter.act('export', workshopItem(card))).exportPath).toBe('/managed/one.dstuplugin');
  });
  it('propagates stale confirmations instead of silently retrying with a new revision', async () => {
    const { adapter, remote } = fixture();
    vi.mocked(remote.install).mockRejectedValue(new Error('WORKSHOP_CONFLICT'));
    await expect(adapter.act('confirm', workshopItem({ ...card, state: 'pending-confirmation' }))).rejects.toThrow('WORKSHOP_CONFLICT');
    expect(remote.install).toHaveBeenCalledTimes(1);
    expect(remote.status).not.toHaveBeenCalled();
  });
  it('does not infer rollback from the mere presence of an older version', () => {
    expect(workshopItem({ ...card, state: 'failed', previousVersion: '1' }).rollback).toBeUndefined();
  });
});

describe('workshop session entry', () => {
  it('creates a fresh scoped session, activates only its skill and navigates without draft/send/default APIs', async () => {
    const port = { bindSession: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockResolvedValue({ id: 'new-session' }), activateSkill: vi.fn().mockResolvedValue(true), navigate: vi.fn() };
    const target = { pluginId: 'workshop.one', workshopId: 'work-1', version: '2', revision: 7 };
    await openWorkshopSession(port, target);
    expect(port.create).toHaveBeenCalledWith({ mode: 'chat', title: '修改插件', metadata: { dstuWorkshop: { kind: 'modify', ...target } } });
    expect(port.activateSkill).toHaveBeenCalledWith('new-session', 'dstu-plugin-development');
    expect(port.bindSession).toHaveBeenCalledWith('work-1', 7, 'new-session');
    expect(port.bindSession.mock.invocationCallOrder[0]).toBeLessThan(port.activateSkill.mock.invocationCallOrder[0]!);
    expect(port.navigate).toHaveBeenCalledWith('new-session');
  });
  it('shows skill readiness failure and keeps the new session reachable', async () => {
    const port = { bindSession: vi.fn().mockResolvedValue(undefined), create: vi.fn().mockResolvedValue({ id: 'new-session' }), activateSkill: vi.fn().mockResolvedValue(false), navigate: vi.fn() };
    await expect(openWorkshopSession(port)).rejects.toThrow('技能未就绪');
    expect(port.navigate).toHaveBeenCalledWith('new-session');
  });
  it('does not activate or navigate when the precise edit binding is stale', async () => {
    const port = { bindSession: vi.fn().mockRejectedValue(new Error('WORKSHOP_CONFLICT')), create: vi.fn().mockResolvedValue({ id: 'new-session' }), activateSkill: vi.fn(), navigate: vi.fn() };
    await expect(openWorkshopSession(port, { pluginId: 'workshop.one', workshopId: 'work-1', version: '2', revision: 7 })).rejects.toThrow('WORKSHOP_CONFLICT');
    expect(port.activateSkill).not.toHaveBeenCalled();
    expect(port.navigate).not.toHaveBeenCalled();
  });
});

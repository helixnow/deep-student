import { describe, expect, it, vi } from 'vitest';
import { HostWorkshopAdapter, workshopCapabilities, workshopCardView, workshopInstallation, workshopItem, type WorkshopCard, type WorkshopRemote } from '../host-adapter';
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
    const revoked = { ...card, state: 'revoked' as const, version: '1.0.0' };
    vi.mocked(remote.status).mockResolvedValue(revoked);
    await adapter.act('restore', workshopItem(revoked));
    expect(remote.restore).toHaveBeenCalledWith('work-1', 3);
    expect(remote.create).not.toHaveBeenCalled();
    expect(remote.install).not.toHaveBeenCalled();
  });
  it('accepts a newer revision for the same rollback target and rejects a changed target', async () => {
    const { adapter, remote, manager } = fixture();
    manager.list.mockResolvedValue({ plugins: [{ id: card.pluginId, enabled: true }] });
    const installed: WorkshopCard = { ...card, state: 'installed', version: '1.0.1',
      installation: { state: 'installed', version: '1.0.1', previousVersion: '1.0.0' } };
    const item = workshopItem(installed);
    vi.mocked(remote.status).mockResolvedValue({ ...installed, revision: 4 });
    await adapter.act('restore', item);
    expect(remote.restore).toHaveBeenCalledWith(card.id, 4);
    vi.mocked(remote.status).mockResolvedValue({ ...installed, revision: 5, version: '1.0.2' });
    await expect(adapter.act('restore', item)).rejects.toThrow('WORKSHOP_CONFLICT');
    expect(remote.restore).toHaveBeenCalledTimes(1);
  });
  it('reads stopped intent from manager and exposes the exported managed file', async () => {
    const { adapter, remote, manager } = fixture();
    vi.mocked(remote.list).mockResolvedValue([{ ...card, state: 'installed' }]);
    expect((await adapter.list())[0].phase).toBe('disabled');
    await adapter.act('try', workshopItem({ ...card, state: 'installed' }, false));
    expect(manager.setEnabled).toHaveBeenCalledWith(card.pluginId, true);
    expect((await adapter.act('export', workshopItem(card))).exportPath).toBe('/managed/one.dstuplugin');
  });
  it('启用/停用 survives a profile written elsewhere since the port last read it (one resend after its refresh)', async () => {
    const { adapter, remote, manager } = fixture();
    vi.mocked(remote.list).mockResolvedValue([{ ...card, state: 'installed' }]);
    vi.mocked(remote.status).mockResolvedValue({ ...card, state: 'installed' });
    manager.setEnabled
      .mockResolvedValueOnce({ ok: false, code: 'PROFILE_CONFLICT', detail: 'PROFILE_CONFLICT: profile changed since revision "a"' })
      .mockResolvedValueOnce({ ok: true });
    await adapter.act('try', workshopItem({ ...card, state: 'installed' }, false));
    expect(manager.setEnabled.mock.calls).toEqual([[card.pluginId, true], [card.pluginId, true]]);
    // Any other refusal (and a second conflict) still reaches the user.
    manager.setEnabled.mockReset();
    manager.setEnabled.mockResolvedValue({ ok: false, code: 'PROFILE_CONFLICT', detail: 'PROFILE_CONFLICT: again' });
    await expect(adapter.act('disable', workshopItem({ ...card, state: 'installed' }, true))).rejects.toThrow('PROFILE_CONFLICT: again');
    expect(manager.setEnabled).toHaveBeenCalledTimes(2);
    manager.setEnabled.mockReset();
    manager.setEnabled.mockResolvedValue({ ok: false, code: 'CONSENT_REQUIRED', detail: 'CONSENT_REQUIRED: x' });
    await expect(adapter.act('try', workshopItem({ ...card, state: 'installed' }, false))).rejects.toThrow('CONSENT_REQUIRED: x');
    expect(manager.setEnabled).toHaveBeenCalledTimes(1);
  });
  it('propagates stale confirmations instead of silently retrying with a new revision', async () => {
    const { adapter, remote } = fixture();
    vi.mocked(remote.install).mockRejectedValue(new Error('WORKSHOP_CONFLICT'));
    await expect(adapter.act('confirm', workshopItem({ ...card, state: 'pending-confirmation' }))).rejects.toThrow('WORKSHOP_CONFLICT');
    expect(remote.install).toHaveBeenCalledTimes(1);
    expect(remote.status).not.toHaveBeenCalled();
  });
  it('an installed work the manager no longer lists is 已卸载 (never offers 打开); a running one only opens on 试', async () => {
    const { adapter, remote, manager } = fixture();
    vi.mocked(remote.list).mockResolvedValue([{ ...card, state: 'installed', version: '1.0.0' }]);
    vi.mocked(manager.list).mockResolvedValue({ plugins: [] });
    expect((await adapter.list())[0].phase).toBe('undone');
    const opened = vi.fn();
    const running = new HostWorkshopAdapter(remote, { list: vi.fn().mockResolvedValue({ plugins: [{ id: card.pluginId, enabled: true }] }), setEnabled: vi.fn() }, opened);
    vi.mocked(remote.status).mockResolvedValue({ ...card, state: 'installed', version: '1.0.0', places: [{ kind: 'selectionButton' }] });
    await running.act('try', workshopItem({ ...card, state: 'installed', places: [{ kind: 'selectionButton' }] }, true));
    expect(opened).toHaveBeenCalledWith(card.pluginId, { kind: 'selectionButton' });
  });
  it('maps progress to 正在做 / 正在自己检查 / 发现问题，正在修（第 n 次）', () => {
    expect(workshopItem({ ...card, state: 'generating' }).progress).toEqual({ stage: 'making' });
    expect(workshopItem({ ...card, state: 'generating', buildStage: 'checking' }).progress).toEqual({ stage: 'checking' });
    expect(workshopItem({ ...card, state: 'generating', buildAttempt: 1, error: 'WORKSHOP_INVALID: x', buildStage: 'making' }).progress).toEqual({ stage: 'fixing', attempt: 2 });
    expect(workshopItem({ ...card, state: 'pending-confirmation' }).progress).toBeUndefined();
  });
  it('places: Host places win; before a build the recipe expectation is marked 预计; an old built learning tool is an app', () => {
    // Unbuilt and no expectation (older record): no guessed line.
    expect(workshopItem(card).places).toBeUndefined();
    expect(workshopItem({ ...card, state: 'installed', version: '1.0.0' }).places).toEqual([{ kind: 'app', title: '单词' }]);
    const expected = workshopItem({ ...card, expectedPlaces: [{ kind: 'selectionButton' }] });
    expect(expected).toMatchObject({ places: [{ kind: 'selectionButton' }], placesExpected: true });
    expect(workshopItem({ ...card, expectedPlaces: [] }).places).toBeUndefined();
    expect(workshopItem({ ...card, template: 'host-tool' }).places).toBeUndefined();
    expect(workshopItem({ ...card, places: [{ kind: 'agentTool', title: '查课表' }] }).places).toEqual([{ kind: 'agentTool', title: '查课表' }]);
  });
  it('does not infer rollback from the mere presence of an older version', () => {
    expect(workshopItem({ ...card, state: 'failed', previousVersion: '1' }).rollback).toBeUndefined();
  });
  it('lists what the Host read from the candidate before the Agent\'s own wording, each line once', () => {
    // Before a build passed there is nothing Host-derived to show.
    expect(workshopItem(card).capabilities).toEqual(['service:notes']);
    const staged = workshopItem({ ...card, state: 'pending-confirmation', version: '1.0.0',
      capabilities: ['让 AI 助手学会新本事「查课表」', ' 读取你订阅的教务日历（只读） ', ''],
      declared: ['让 AI 助手学会新本事「查课表」', '联网读取 calendar.example.edu.cn（只读，仅限这个域名）'] });
    expect(staged.capabilities).toEqual([
      '让 AI 助手学会新本事「查课表」', '联网读取 calendar.example.edu.cn（只读，仅限这个域名）', '读取你订阅的教务日历（只读）',
    ]);
    expect(workshopCapabilities({ capabilities: [], declared: ['用当前对话模型生成文字'] })).toEqual(['用当前对话模型生成文字']);
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
    await expect(openWorkshopSession(port)).rejects.toThrow('WORKSHOP_SKILL_MISSING');
    expect(port.navigate).toHaveBeenCalledWith('new-session');
  });
  it('does not activate or navigate when the precise edit binding is stale', async () => {
    const port = { bindSession: vi.fn().mockRejectedValue(new Error('WORKSHOP_CONFLICT')), create: vi.fn().mockResolvedValue({ id: 'new-session' }), activateSkill: vi.fn(), navigate: vi.fn() };
    await expect(openWorkshopSession(port, { pluginId: 'workshop.one', workshopId: 'work-1', version: '2', revision: 7 })).rejects.toThrow('WORKSHOP_CONFLICT');
    expect(port.activateSkill).not.toHaveBeenCalled();
    expect(port.navigate).not.toHaveBeenCalled();
  });
});

describe('progress, honest states and the background result (transport double)', () => {
  it('maps Host progress to files written, the check step and the repair round', () => {
    const generating = { ...card, state: 'generating' as const };
    expect(workshopItem({ ...generating, buildStage: 'making', buildFiles: ['package.json'] }).progress).toEqual({ stage: 'making', files: ['package.json'] });
    expect(workshopItem({ ...generating, buildStage: 'checking', buildStep: 'link' }).progress).toEqual({ stage: 'checking', step: 'link' });
    expect(workshopItem({ ...generating, buildStage: 'checking', buildStep: 'load', buildAttempt: 1, error: 'x' }).progress).toEqual({ stage: 'checking', step: 'load' });
    expect(workshopItem({ ...generating, buildStage: 'making', buildAttempt: 1, error: 'x' }).progress).toEqual({ stage: 'fixing', attempt: 2 });
  });
  it('shows a started work the Agent is editing as 「AI 正在改」 (no 开始做), and falls back when the edit is stale', () => {
    expect(workshopItem({ ...card, state: 'failed', agentEditing: new Date().toISOString() }).phase).toBe('editing');
    expect(workshopItem({ ...card, state: 'failed', agentEditing: new Date(Date.now() - 60 * 60_000).toISOString() }).phase).toBe('failed');
    expect(workshopItem({ ...card, state: 'pending-confirmation', agentEditing: new Date().toISOString() }).phase).toBe('ready');
  });
  it('sends the values entered on the card with 开始做 and reports the finished generation once, even with no card on screen', async () => {
    vi.useFakeTimers();
    try {
      const { remote, manager } = fixture();
      const onFinished = vi.fn();
      const adapter = new HostWorkshopAdapter(remote, manager, undefined, onFinished);
      vi.mocked(remote.status).mockResolvedValueOnce({ ...card, state: 'generating' }).mockResolvedValueOnce({ ...card, state: 'generating' })
        .mockResolvedValue({ ...card, state: 'pending-confirmation', version: '1.0.0' });
      await adapter.act('confirm', workshopItem(card), { calendarUrl: 'https://jw.school.edu.cn/a.ics' });
      expect(remote.create).toHaveBeenCalledWith('work-1', 3, { calendarUrl: 'https://jw.school.edu.cn/a.ics' });
      await vi.advanceTimersByTimeAsync(6000);
      expect(onFinished).toHaveBeenCalledTimes(1);
      expect(onFinished.mock.calls[0]![0]).toMatchObject({ phase: 'ready', name: '单词' });
    } finally { vi.useRealTimers(); }
  });
  it('polls faster while a work is being made', async () => {
    vi.useFakeTimers();
    try {
      const { remote, adapter } = fixture();
      vi.mocked(remote.list).mockResolvedValue([{ ...card, state: 'generating' }]);
      await adapter.list();
      const listener = vi.fn();
      const stop = adapter.subscribe(listener);
      await vi.advanceTimersByTimeAsync(1300);
      expect(listener).toHaveBeenCalledTimes(2);
      stop();
    } finally { vi.useRealTimers(); }
  });
  it('follows delegated work through actual validation and reports completion once after leaving the card', async () => {
    vi.useFakeTimers();
    try {
      const { remote, manager } = fixture();
      manager.list.mockResolvedValue({ plugins: [{ id: card.pluginId, enabled: true }] });
      const onFinished = vi.fn();
      const adapter = new HostWorkshopAdapter(remote, manager, undefined, onFinished);
      const pending = { ...card, state: 'installed' as const, version: '1.0.0',
        execution: { mode: 'delegated' as const, stage: 'validating' as const },
        validation: { version: '1.0.0', revision: 4, status: 'pending' as const } };
      vi.mocked(remote.list).mockResolvedValue([pending]);
      vi.mocked(remote.status).mockResolvedValue(pending);
      await adapter.list();
      await vi.advanceTimersByTimeAsync(1600);
      expect(onFinished).not.toHaveBeenCalled();
      vi.mocked(remote.status).mockResolvedValue({ ...pending,
        execution: { mode: 'delegated', stage: 'complete' }, validation: { ...pending.validation, status: 'passed' } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(onFinished).toHaveBeenCalledTimes(1);
      expect(onFinished.mock.calls[0]![0]).toMatchObject({ phase: 'installed', validation: { status: 'passed' } });
    } finally { vi.useRealTimers(); }
  });
});

describe('installed version apart from the proposal (F3)', () => {
  const installedV1 = { ...card, state: 'installed' as const, version: '1.0.0', revision: 5, proposalRevision: 1,
    installation: { state: 'installed' as const, version: '1.0.0', previousVersion: null }, usableVersion: '1.0.0' };
  // The AI proposed v2 at revision 6 and the user turned it down.
  const cancelledV2 = { ...installedV1, state: 'cancelled' as const, version: null, previousVersion: '1.0.0', revision: 7, proposalRevision: 6 };

  it('turning down v2 leaves the old v1 card installed, says 不要了 only on the v2 card, and lists v1 as installed', () => {
    const item = workshopItem(cancelledV2, true, undefined, true);
    expect(item.phase).toBe('installed');
    expect(item.installed).toEqual({ phase: 'installed', version: '1.0.0' });
    // The v1 card (made at revision 1) still shows the installed plugin.
    expect(workshopCardView(item, 1)).toMatchObject({ phase: 'installed', version: '1.0.0' });
    expect(workshopCardView(item, 1).elsewhere).toBeUndefined();
    // The v2 card says it was turned down.
    expect(workshopCardView(item, 6).phase).toBe('cancelled');
  });

  it('while v2 waits, the v1 card stays installed with one line about it; the v2 card shows the proposal', () => {
    const proposed = workshopItem({ ...cancelledV2, state: 'draft' }, true, undefined, true);
    expect(proposed.phase).toBe('proposed');
    expect(workshopCardView(proposed, 1)).toMatchObject({ phase: 'installed', elsewhere: 'proposed' });
    expect(workshopCardView(proposed, 6)).toMatchObject({ phase: 'proposed', installed: { phase: 'installed', version: '1.0.0' } });
  });

  it('uninstall acts on the installed version even after a modification was turned down', async () => {
    const { adapter, remote } = fixture();
    vi.mocked(remote.status).mockResolvedValue({ ...cancelledV2, state: 'revoked', installation: { state: 'revoked', version: '1.0.0' } });
    await adapter.act('undo', workshopCardView(workshopItem(cancelledV2, true), 1));
    expect(remote.revoke).toHaveBeenCalledWith('work-1', 7);
  });

  it('records from before the split derive the installed version from the last running one', () => {
    const legacy = { ...card, state: 'cancelled' as const, version: null, usableVersion: '1.0.0', revision: 9 };
    expect(workshopInstallation(legacy)).toEqual({ state: 'installed', version: '1.0.0', previousVersion: null });
    // No proposal revision known: a turned-down change never turns an old card into 不要了.
    expect(workshopCardView(workshopItem(legacy, true), 3).phase).toBe('installed');
  });
});

describe('export (F4/F16) and the shared poll (F11)', () => {
  it('offers the save dialog with the readable name; cancel exports nothing visible; no dialog keeps the Host file', async () => {
    const { remote, manager } = fixture();
    vi.mocked(remote.export).mockResolvedValue({ id: 'work-1', version: '1.0.0', path: '/managed/单词-v1.0.0.dstuplugin', fileName: '单词-v1.0.0.dstuplugin' });
    const save = vi.fn().mockResolvedValueOnce('D:/桌面/单词-v1.0.0.dstuplugin').mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('no dialog'));
    const adapter = new HostWorkshopAdapter(remote, manager, undefined, undefined, { save, reveal: vi.fn() });
    const installed = workshopItem({ ...card, state: 'installed', version: '1.0.0' });
    expect((await adapter.act('export', installed)).exportPath).toBe('D:/桌面/单词-v1.0.0.dstuplugin');
    expect(save).toHaveBeenCalledWith('/managed/单词-v1.0.0.dstuplugin', '单词-v1.0.0.dstuplugin');
    expect((await adapter.act('export', installed)).exportPath).toBeUndefined();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((await adapter.act('export', installed)).exportPath).toBe('/managed/单词-v1.0.0.dstuplugin');
    expect(adapter.reveal).toBeTypeOf('function');
  });

  it('many cards share one timer and one Host read per tick', async () => {
    vi.useFakeTimers();
    try {
      const { remote, adapter } = fixture();
      const listeners = Array.from({ length: 5 }, () => vi.fn(() => { void adapter.list(); }));
      const stops = listeners.map(listener => adapter.subscribe(listener));
      await vi.advanceTimersByTimeAsync(2100);
      expect(listeners.every(listener => listener.mock.calls.length === 1)).toBe(true);
      expect(remote.list).toHaveBeenCalledTimes(1);
      stops.forEach(stop => stop());
      await vi.advanceTimersByTimeAsync(5000);
      expect(remote.list).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
});

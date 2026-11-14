import { beforeEach, describe, expect, it, vi } from 'vitest';

const { invokeMock, dstuCreateMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
  dstuCreateMock: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}));

vi.mock('@/dstu', () => ({
  dstu: {
    create: dstuCreateMock,
  },
  sanitizeName: (raw: string) => raw.trim().replace(/[<>:"|?*\\/]/g, '_'),
}));

import {
  MAX_PINNED_ARTIFACT_REVISIONS,
  usePinnedArtifactStore,
} from '../pinnedArtifactStore';
import {
  LEGACY_SANDBOX_OWNER_KEY,
  useSandboxWorkbenchStore,
} from '@/features/sandbox/store/useSandboxWorkbenchStore';
import { pinArtifactToCanvas } from '@/features/sandbox/launchSandboxWorkbench';

describe('pinnedArtifactStore', () => {
  beforeEach(() => {
    invokeMock.mockReset();
    dstuCreateMock.mockReset();
    usePinnedArtifactStore.getState().resetPinnedArtifacts();
    useSandboxWorkbenchStore.setState({
      activeSession: null,
      isOpen: false,
      viewportPreset: 'desktop',
      inspectorOpen: false,
      ownerStates: {},
      activeOwnerKey: LEGACY_SANDBOX_OWNER_KEY,
    });
  });

  const pin = (widgetId = 'widget-save', content = '<div>v1</div>') =>
    usePinnedArtifactStore.getState().upsertPinnedArtifact({
      ownerKey: 'sandbox:chat:save', sessionId: 'save', widgetId,
      kind: 'html', language: 'html', title: '相同标题', sourceMessageId: widgetId, content,
    });

  it('keeps explicitly distinct widgets separate even when titles match', () => {
    const first = pin('first');
    const second = pin('second');
    expect(second.artifactId).not.toBe(first.artifactId);
    expect(Object.keys(usePinnedArtifactStore.getState().recordsById)).toHaveLength(2);
  });

  it('coalesces concurrent saves and reuses unchanged saved notes while retaining saved identity through revisions', async () => {
    let complete!: (value: unknown) => void;
    dstuCreateMock.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const record = pin();
    const input = { artifactId: record.artifactId, title: record.title,
      kind: record.kind, language: record.language, content: '<div>v1</div>' };
    const first = usePinnedArtifactStore.getState().saveArtifactToStudySpace(input);
    const second = usePinnedArtifactStore.getState().saveArtifactToStudySpace({ ...input, title: '重命名' });
    await vi.waitFor(() => expect(dstuCreateMock).toHaveBeenCalledTimes(1));
    complete({ ok: true, value: { id: 'note-shared' } });
    expect(await first).toEqual(await second);
    await usePinnedArtifactStore.getState().saveArtifactToStudySpace(input);
    expect(dstuCreateMock).toHaveBeenCalledTimes(1);
    const updated = pin('widget-save', '<div>v2</div>');
    expect(updated.savedResourceId).toBe('note-shared');
    expect(updated.savedContent).toBe('<div>v1</div>');
    dstuCreateMock.mockResolvedValueOnce({ ok: true, value: { id: 'note-v2' } });
    await usePinnedArtifactStore.getState().saveArtifactToStudySpace({ ...input, content: '<div>v2</div>' });
    expect(dstuCreateMock).toHaveBeenCalledTimes(2);
  });

  it('retries failed group pinning without creating another VFS note', async () => {
    const record = pin();
    const input = { artifactId: record.artifactId, title: record.title,
      kind: record.kind, language: record.language, content: '<div>v1</div>', groupId: 'group-save' };
    dstuCreateMock.mockResolvedValue({ ok: true, value: { id: 'note-retry' } });
    invokeMock.mockImplementation(async (command) => {
      if (command === 'chat_v2_get_group') return { pinnedResourceIds: [] };
      throw { message: '分组暂不可写' };
    });
    await expect(usePinnedArtifactStore.getState().saveArtifactToStudySpace(input)).rejects.toThrow('分组暂不可写');
    invokeMock.mockImplementation(async (command) => command === 'chat_v2_get_group' ? { pinnedResourceIds: [] } : null);
    await expect(usePinnedArtifactStore.getState().saveArtifactToStudySpace(input)).resolves.toEqual({ nodeId: 'note-retry', pinnedToGroup: true });
    expect(dstuCreateMock).toHaveBeenCalledTimes(1);
  });

  it('propagates structured creation errors and allows a retry after failure', async () => {
    const input = { title: '错误', kind: 'html' as const, language: 'html', content: '<div />' };
    dstuCreateMock.mockRejectedValueOnce({ message: '存储离线' });
    await expect(usePinnedArtifactStore.getState().saveArtifactToStudySpace(input)).rejects.toThrow('存储离线');
    dstuCreateMock.mockResolvedValueOnce({ ok: false, error: { detail: '配额不足' } });
    await expect(usePinnedArtifactStore.getState().saveArtifactToStudySpace(input)).rejects.toThrow('配额不足');
    expect(dstuCreateMock).toHaveBeenCalledTimes(2);
  });

  it('uses a longer markdown fence for artifacts containing backtick fences', async () => {
    dstuCreateMock.mockResolvedValue({ ok: true, value: { id: 'note-fence' } });
    await usePinnedArtifactStore.getState().saveArtifactToStudySpace({
      title: '围栏', kind: 'html', language: 'html', content: '<pre>```ts\nx\n```</pre>',
    });
    expect(dstuCreateMock.mock.calls[0][1].content).toContain('````html\n<pre>```ts\nx\n```</pre>\n````');
  });

  it('creates v1 on first pin, keeps v1 when content is identical, and appends v2/v3 on updates or search/replace patches', () => {
    const store = usePinnedArtifactStore.getState();

    const v1Record = store.upsertPinnedArtifact({
      ownerKey: 'sandbox:chat:sess_alpha',
      sessionId: 'sess_alpha',
      groupId: 'grp_physics',
      widgetId: 'widget_oscillator',
      kind: 'html',
      language: 'html-interactive',
      title: '阻尼振子参数实验',
      sourceMessageId: 'msg_1',
      content: '<div class="ds-box">k = 1.0</div>',
    });

    expect(v1Record.activeVersion).toBe(1);
    expect(v1Record.revisions).toHaveLength(1);
    expect(v1Record.revisions[0].version).toBe(1);
    expect(
      usePinnedArtifactStore.getState().getActiveArtifactForSession('sess_alpha')?.artifactId,
    ).toBe(v1Record.artifactId);

    // Re-pinning identical source keeps v1 without creating duplicate revisions
    const sameRecord = usePinnedArtifactStore.getState().upsertPinnedArtifact({
      ownerKey: 'sandbox:chat:sess_alpha',
      sessionId: 'sess_alpha',
      widgetId: 'widget_oscillator',
      kind: 'html',
      language: 'html-interactive',
      title: '阻尼振子参数实验',
      sourceMessageId: 'msg_1',
      content: '<div class="ds-box">k = 1.0</div>',
    });
    expect(sameRecord.artifactId).toBe(v1Record.artifactId);
    expect(sameRecord.revisions).toHaveLength(1);
    expect(sameRecord.activeVersion).toBe(1);

    // Re-pinning updated source appends v2
    const v2Record = usePinnedArtifactStore.getState().upsertPinnedArtifact({
      ownerKey: 'sandbox:chat:sess_alpha',
      sessionId: 'sess_alpha',
      widgetId: 'widget_oscillator',
      kind: 'html',
      language: 'html-interactive',
      title: '阻尼振子参数实验',
      sourceMessageId: 'msg_2',
      content: '<div class="ds-box">k = 2.5</div>',
      patchSummary: '增大弹性系数',
    });
    expect(v2Record.artifactId).toBe(v1Record.artifactId);
    expect(v2Record.revisions).toHaveLength(2);
    expect(v2Record.activeVersion).toBe(2);
    expect(v2Record.revisions[1].content).toContain('k = 2.5');

    // Incremental { search, replace } patch appends v3
    const v3Record = usePinnedArtifactStore.getState().applyPatchToArtifact(
      v1Record.artifactId,
      { search: 'k = 2.5', replace: 'k = 4.0, zeta = 0.2' },
      '补充阻尼比',
    );
    expect(v3Record).not.toBeNull();
    expect(v3Record?.activeVersion).toBe(3);
    expect(v3Record?.revisions).toHaveLength(3);
    expect(v3Record?.revisions[2].content).toBe('<div class="ds-box">k = 4.0, zeta = 0.2</div>');

    // Selecting historical version v1 switches activeVersion without losing v2/v3
    const selectedV1 = usePinnedArtifactStore
      .getState()
      .selectArtifactVersion(v1Record.artifactId, 1);
    expect(selectedV1?.activeVersion).toBe(1);
    expect(selectedV1?.revisions).toHaveLength(3);
  });

  it('caps retained revisions at MAX_PINNED_ARTIFACT_REVISIONS and rejects invalid search patches', () => {
    const base = usePinnedArtifactStore.getState().upsertPinnedArtifact({
      ownerKey: 'sandbox:chat:sess_cap',
      sessionId: 'sess_cap',
      widgetId: 'widget_cap',
      kind: 'html',
      language: 'html',
      title: '版本上限测试',
      sourceMessageId: 'msg_cap',
      content: '<div>step-1</div>',
    });

    for (let i = 2; i <= MAX_PINNED_ARTIFACT_REVISIONS + 5; i += 1) {
      usePinnedArtifactStore.getState().applyPatchToArtifact(base.artifactId, {
        search: `step-${i - 1}`,
        replace: `step-${i}`,
      });
    }

    const latest = usePinnedArtifactStore.getState().getActiveArtifactForSession('sess_cap');
    expect(latest).not.toBeNull();
    expect(latest!.revisions).toHaveLength(MAX_PINNED_ARTIFACT_REVISIONS);
    expect(latest!.activeVersion).toBe(MAX_PINNED_ARTIFACT_REVISIONS + 5);
    expect(latest!.revisions[0].version).toBe(6);

    expect(() =>
      usePinnedArtifactStore.getState().applyPatchToArtifact(base.artifactId, {
        search: 'non-existent-token',
        replace: 'x',
      }),
    ).toThrow(/search/);
  });

  it('deactivates session active artifact when closing workbench or session, and restores on reopen', () => {
    const ownerKey = 'sandbox:chat-page:1';
    const record = pinArtifactToCanvas(
      {
        kind: 'openui',
        language: 'openui-lang',
        title: '收敛速度对比',
        content: 'root = Stack([Stat("步数", "12")])',
        sessionId: 'sess_live',
        groupId: 'grp_math',
      },
      ownerKey,
    );

    expect(
      usePinnedArtifactStore.getState().getActiveArtifactForSession('sess_live')?.artifactId,
    ).toBe(record.artifactId);

    // Closing workbench panel temporarily deactivates session context injection
    useSandboxWorkbenchStore.getState().closeWorkbench(ownerKey);
    expect(usePinnedArtifactStore.getState().getActiveArtifactForSession('sess_live')).toBeNull();

    // Reopening workbench restores active artifact for the session
    useSandboxWorkbenchStore.getState().openWorkbench(ownerKey);
    expect(
      usePinnedArtifactStore.getState().getActiveArtifactForSession('sess_live')?.artifactId,
    ).toBe(record.artifactId);

    // Closing session permanently clears active status while preserving revision history
    useSandboxWorkbenchStore.getState().closeSession(ownerKey);
    expect(usePinnedArtifactStore.getState().getActiveArtifactForSession('sess_live')).toBeNull();
    expect(usePinnedArtifactStore.getState().recordsById[record.artifactId]).toBeDefined();
  });

  it('saves artifact as VFS note via dstu.create and mounts nodeId into StudySpace pinnedResourceIds when groupId is provided', async () => {
    dstuCreateMock.mockResolvedValue({
      ok: true,
      value: {
        id: 'note_artifact_101',
        name: '傅里叶级数合成器',
        path: '/note_artifact_101',
        type: 'note',
      },
    });
    invokeMock.mockImplementation(async (cmd: string) => {
      if (cmd === 'chat_v2_get_group') {
        return {
          id: 'grp_signal',
          pinnedResourceIds: ['note_existing_1'],
        };
      }
      if (cmd === 'chat_v2_update_group') {
        return {
          id: 'grp_signal',
          pinnedResourceIds: ['note_existing_1', 'note_artifact_101'],
        };
      }
      return null;
    });

    const record = usePinnedArtifactStore.getState().upsertPinnedArtifact({
      ownerKey: 'sandbox:chat:sess_signal',
      sessionId: 'sess_signal',
      groupId: 'grp_signal',
      kind: 'html',
      language: 'html-interactive',
      title: '傅里叶级数:合成器?',
      sourceMessageId: 'msg_fourier',
      content: '<div>Fourier Canvas</div>',
    });

    const saveResult = await usePinnedArtifactStore.getState().saveArtifactToStudySpace({
      artifactId: record.artifactId,
      title: '傅里叶级数:合成器?',
      kind: 'html',
      language: 'html-interactive',
      content: '<div>Fourier Canvas</div>',
      sessionId: 'sess_signal',
      groupId: 'grp_signal',
    });

    expect(saveResult).toEqual({
      nodeId: 'note_artifact_101',
      pinnedToGroup: true,
    });
    expect(dstuCreateMock).toHaveBeenCalledTimes(1);
    expect(dstuCreateMock).toHaveBeenCalledWith('/', {
      type: 'note',
      name: '傅里叶级数_合成器_',
      content: '# 傅里叶级数:合成器?\n\n```html-interactive\n<div>Fourier Canvas</div>\n```\n',
    });
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_get_group', { groupId: 'grp_signal' });
    expect(invokeMock).toHaveBeenCalledWith('chat_v2_update_group', {
      groupId: 'grp_signal',
      request: {
        pinnedResourceIds: ['note_existing_1', 'note_artifact_101'],
      },
    });
    expect(
      usePinnedArtifactStore.getState().recordsById[record.artifactId]?.savedResourceId,
    ).toBe('note_artifact_101');
  });

  it('saves note without calling group IPC when groupId is absent', async () => {
    dstuCreateMock.mockResolvedValue({
      ok: true,
      value: {
        id: 'note_standalone_2',
        name: '独立图表',
        path: '/note_standalone_2',
        type: 'note',
      },
    });

    const res = await usePinnedArtifactStore.getState().saveArtifactToStudySpace({
      title: '独立图表',
      kind: 'openui',
      language: 'openui',
      content: 'root = Stack([])',
    });

    expect(res).toEqual({
      nodeId: 'note_standalone_2',
      pinnedToGroup: false,
    });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});

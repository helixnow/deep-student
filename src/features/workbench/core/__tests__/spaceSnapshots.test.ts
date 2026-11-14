import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invoke } from '@tauri-apps/api/core';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }));
import {
  STUDY_SPACE_CHANGED_EVENT,
  type StudySpaceChangedEventDetail,
} from '@/shared/study-space/types';
import { appRegistry } from '../appRegistry';
import {
  WORKBENCH_SNAPSHOT_KEY,
  cancelPendingSnapshotSave,
  flushSnapshot,
  invalidateSnapshotDedupeCache,
  registerDockPinnedProvider,
  registerSnapshotMirrorHook,
} from '../snapshot';
import {
  ACTIVE_STUDY_SPACE_STORAGE_KEY,
  INBOX_SNAPSHOT_BUCKET_KEY,
  MAX_PERSISTED_SPACE_SNAPSHOTS,
  WORKBENCH_SPACE_SNAPSHOTS_KEY,
  bootInitialSpaceWorkbench,
  handleStudySpaceChanged,
  installSpaceSnapshotMirror,
  loadSpaceSnapshotsEnvelope,
  loadSpaceWorkbenchEntry,
  normalizeSpaceSnapshotKey,
  readInitialActiveSpaceKey,
  resetSpaceSnapshotsForTests,
  saveSpaceWorkbenchEntry,
} from '../spaceSnapshots';
import {
  getStagePresetState,
  resetStagePresetStoreForTests,
  setStagePresetState,
} from '../stagePresets';
import { tilingPairKey } from '../tiling';
import { resetWindowStoreForTests, useWindowStore } from '../windowStore';
import { makeWin, registerTestApp } from './testUtils';

function registerSuiteApps(): void {
  registerTestApp('file-preview', { instanceMode: 'multi' });
  registerTestApp('files', { instanceMode: 'single' });
  registerTestApp('notes', { instanceMode: 'single' });
  registerTestApp('chat', { instanceMode: 'single' });
  registerTestApp('flashcards', { instanceMode: 'single' });
}

function makeSpaceEventDetail(
  overrides: Partial<StudySpaceChangedEventDetail> & Pick<StudySpaceChangedEventDetail, 'spaceId'>,
): StudySpaceChangedEventDetail {
  return {
    spaceId: overrides.spaceId,
    rootFolderId: overrides.rootFolderId ?? 'fld_default',
    defaultDeckId: overrides.defaultDeckId ?? null,
    targetRetention: overrides.targetRetention ?? 0.9,
    memoryScope: overrides.memoryScope ?? 'space_and_global',
    workbenchLayoutPreset: overrides.workbenchLayoutPreset ?? 'freeform_desktop',
  };
}

beforeEach(() => {
  registerSuiteApps();
  localStorage.clear();
  registerDockPinnedProvider(null);
  registerSnapshotMirrorHook(null);
  invalidateSnapshotDedupeCache();
  resetWindowStoreForTests({ w: 1600, h: 900 });
  resetStagePresetStoreForTests();
  resetSpaceSnapshotsForTests();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  cancelPendingSnapshotSave();
  registerSnapshotMirrorHook(null);
  appRegistry.unregister('dirty-note-app');
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('normalizeSpaceSnapshotKey & readInitialActiveSpaceKey', () => {
  it('normalizes null, undefined, blank strings, and __inbox__ into INBOX_SNAPSHOT_BUCKET_KEY', () => {
    expect(normalizeSpaceSnapshotKey(null)).toBe(INBOX_SNAPSHOT_BUCKET_KEY);
    expect(normalizeSpaceSnapshotKey(undefined)).toBe(INBOX_SNAPSHOT_BUCKET_KEY);
    expect(normalizeSpaceSnapshotKey('')).toBe(INBOX_SNAPSHOT_BUCKET_KEY);
    expect(normalizeSpaceSnapshotKey('   ')).toBe(INBOX_SNAPSHOT_BUCKET_KEY);
    expect(normalizeSpaceSnapshotKey('__inbox__')).toBe(INBOX_SNAPSHOT_BUCKET_KEY);
    expect(normalizeSpaceSnapshotKey('null')).toBe(INBOX_SNAPSHOT_BUCKET_KEY);
    expect(normalizeSpaceSnapshotKey('  space_math  ')).toBe('space_math');
  });

  it('parses raw strings, JSON strings, JSON null, and JSON object shapes from localStorage', () => {
    expect(readInitialActiveSpaceKey()).toBe(INBOX_SNAPSHOT_BUCKET_KEY);

    localStorage.setItem(ACTIVE_STUDY_SPACE_STORAGE_KEY, 'space_math');
    expect(readInitialActiveSpaceKey()).toBe('space_math');

    localStorage.setItem(ACTIVE_STUDY_SPACE_STORAGE_KEY, JSON.stringify('space_physics'));
    expect(readInitialActiveSpaceKey()).toBe('space_physics');

    localStorage.setItem(ACTIVE_STUDY_SPACE_STORAGE_KEY, JSON.stringify(null));
    expect(readInitialActiveSpaceKey()).toBe(INBOX_SNAPSHOT_BUCKET_KEY);

    localStorage.setItem(
      ACTIVE_STUDY_SPACE_STORAGE_KEY,
      JSON.stringify({ spaceId: 'space_chem' }),
    );
    expect(readInitialActiveSpaceKey()).toBe('space_chem');
  });
});

describe('Per-Space Workbench Layout Isolation & Synchronous Outgoing Capture', () => {
  it('recognizes a legacy dual-reader layout and retains its sidecar mode at boot', async () => {
    localStorage.setItem(WORKBENCH_SNAPSHOT_KEY, JSON.stringify({ version: 1, windows: [
      makeWin({ id: 'a', typeId: 'file-preview', displayMode: 'tiled-tl' }),
      makeWin({ id: 'b', typeId: 'file-preview', displayMode: 'tiled-bl' }),
      makeWin({ id: 'hub', typeId: 'notes', displayMode: 'tiled-right' }),
    ], dockPinned: [], tilingRatios: { v: 0.52, 'h-left': 0.5 } }));
    const result = await bootInitialSpaceWorkbench('space-dual');
    expect(result).toMatchObject({ activeStagePreset: 'deep-reading-map', sidecarMode: 'dual_reader', migratedFromLegacy: true });
    expect(getStagePresetState().sidecarMode).toBe('dual_reader');
    expect((await loadSpaceWorkbenchEntry('space-dual'))?.sidecarMode).toBe('dual_reader');
  });
  it('does not save an empty outgoing desktop when switching before startup hydration', async () => {
    await bootInitialSpaceWorkbench('space_a');
    await saveSpaceWorkbenchEntry({ spaceKey: 'space_a', snapshot: { version: 1, windows: [makeWin({ id: 'saved-a' })], dockPinned: [], tilingRatios: {} }, activeStagePreset: 'freeform-desktop' });
    await handleStudySpaceChanged(makeSpaceEventDetail({ spaceId: 'space_b' }), { captureOutgoing: false });
    expect((await loadSpaceWorkbenchEntry('space_a'))?.snapshot.windows.map((w) => w.id)).toEqual(['saved-a']);
  });

  it('binds a snapshot mirror to its capture-time space while native persistence is still pending', async () => {
    await bootInitialSpaceWorkbench('space_a');
    const a = useWindowStore.getState().openWindow({ typeId: 'chat', title: 'A' });
    const dispose = installSpaceSnapshotMirror();
    let releaseWrite!: () => void;
    const waitingWrite = new Promise<void>((resolve) => { releaseWrite = resolve; });
    let enteredWrite!: () => void;
    const entered = new Promise<void>((resolve) => { enteredWrite = resolve; });
    Object.defineProperty(window, '__TAURI_INTERNALS__', { configurable: true, value: {} });
    vi.mocked(invoke).mockImplementation(async (command, args) => {
      const data = args as { key: string; value: string };
      if (command === 'get_setting') return localStorage.getItem(data.key) as never;
      if (command === 'save_setting') {
        if (data.key === WORKBENCH_SNAPSHOT_KEY) { enteredWrite(); await waitingWrite; }
        localStorage.setItem(data.key, data.value);
      }
      return undefined as never;
    });
    try {
      const flush = flushSnapshot();
      await entered;
      const switching = handleStudySpaceChanged(makeSpaceEventDetail({ spaceId: 'space_b' }));
      releaseWrite();
      await Promise.all([flush, switching]);
      expect((await loadSpaceWorkbenchEntry('space_a'))?.snapshot.windows.map((w) => w.id)).toEqual([a]);
      expect(await loadSpaceWorkbenchEntry('space_b')).toBeNull();
    } finally {
      releaseWrite();
      delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
      dispose();
    }
  });

  it('does not overwrite an unhydrated intermediate space during rapid A -> B -> C switches or cleanup flush', async () => {
    await bootInitialSpaceWorkbench('space_a');
    const a = useWindowStore.getState().openWindow({ typeId: 'chat', title: 'A' });
    const b = makeWin({ id: 'b', typeId: 'notes', title: 'B' });
    await saveSpaceWorkbenchEntry({ spaceKey: 'space_b', snapshot: { version: 1, windows: [b], dockPinned: [], tilingRatios: {} }, activeStagePreset: 'note-cocreation' });
    const dispose = installSpaceSnapshotMirror();
    let releasePrune!: () => void;
    let enteredPrune!: () => void;
    const entered = new Promise<void>((resolve) => { enteredPrune = resolve; });
    const pruning = new Promise<void>((resolve) => { releasePrune = resolve; });
    const first = handleStudySpaceChanged(makeSpaceEventDetail({ spaceId: 'space_b' }), {
      pruneWindows: async (windows) => { enteredPrune(); await pruning; return windows; },
    });
    await entered;
    await flushSnapshot();
    const second = handleStudySpaceChanged(makeSpaceEventDetail({ spaceId: 'space_c' }));
    releasePrune();
    await Promise.all([first, second]);
    expect((await loadSpaceWorkbenchEntry('space_a'))?.snapshot.windows.map((w) => w.id)).toEqual([a]);
    expect((await loadSpaceWorkbenchEntry('space_b'))?.snapshot.windows.map((w) => w.id)).toEqual(['b']);
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([]);
    dispose();
  });

  it('restores a deliberately empty saved space instead of opening its default preset', async () => {
    await bootInitialSpaceWorkbench('space_a');
    await saveSpaceWorkbenchEntry({ spaceKey: 'space_b', snapshot: { version: 1, windows: [], dockPinned: [], tilingRatios: {} }, activeStagePreset: 'freeform-desktop' });
    const setDockPinned = vi.fn();
    await handleStudySpaceChanged(makeSpaceEventDetail({ spaceId: 'space_b', workbenchLayoutPreset: 'split_reader_chat' }), { setDockPinned });
    expect(Object.keys(useWindowStore.getState().windows)).toEqual([]);
    expect(setDockPinned).toHaveBeenCalledWith([]);
    expect(getStagePresetState().activeStagePreset).toBe('freeform-desktop');
  });

  it('isolates window layouts and tilingRatios across Space A (space_math), Space B (space_physics), and Inbox', async () => {
    localStorage.setItem(ACTIVE_STUDY_SPACE_STORAGE_KEY, 'space_math');
    await bootInitialSpaceWorkbench();

    // Space A (space_math): PDF + Notes tiled at 0.62
    const store = useWindowStore.getState();
    const mathPdfId = store.openWindow({
      typeId: 'file-preview',
      instanceKey: 'pdf_calculus',
      title: '高等数学讲义.pdf',
      initialFrame: { x: 80, y: 60, w: 680, h: 520 },
    });
    const mathNotesId = store.openWindow({
      typeId: 'notes',
      title: '微积分导图',
      initialFrame: { x: 800, y: 60, w: 700, h: 520 },
    });
    useWindowStore.getState().batchSetDisplayModes?.([
      { id: mathPdfId, mode: 'tiled-left' },
      { id: mathNotesId, mode: 'tiled-right' },
    ]);
    useWindowStore
      .getState()
      .setTilingRatio(tilingPairKey(mathPdfId, mathNotesId), 0.62);
    setStagePresetState('deep-reading-map', null);

    // Switch to Space B (space_physics) with split_notes_chat -> note-cocreation (0.52)
    await handleStudySpaceChanged(
      makeSpaceEventDetail({
        spaceId: 'space_physics',
        rootFolderId: 'fld_physics',
        workbenchLayoutPreset: 'split_notes_chat',
      }),
    );

    const physicsState = useWindowStore.getState();
    const physicsWindows = Object.values(physicsState.windows);
    expect(physicsWindows.some((w) => w.instanceKey === 'pdf_calculus')).toBe(false);
    expect(physicsWindows.map((w) => w.typeId).sort()).toEqual(['chat', 'notes']);
    expect(getStagePresetState().activeStagePreset).toBe('note-cocreation');

    // Customize Space B tiling ratio to 0.36
    const physNotes = physicsWindows.find((w) => w.typeId === 'notes')!;
    const physChat = physicsWindows.find((w) => w.typeId === 'chat')!;
    useWindowStore
      .getState()
      .setTilingRatio(tilingPairKey(physNotes.id, physChat.id), 0.36);

    // Switch to Inbox (null -> '__inbox__') with freeform_desktop and open a floating window
    await handleStudySpaceChanged(
      makeSpaceEventDetail({
        spaceId: null,
        rootFolderId: 'fld_inbox',
        workbenchLayoutPreset: 'freeform_desktop',
      }),
    );
    expect(Object.keys(useWindowStore.getState().windows)).toHaveLength(0);
    const inboxWinId = useWindowStore.getState().openWindow({
      typeId: 'chat',
      title: 'Inbox Quick Chat',
      initialFrame: { x: 210, y: 140, w: 640, h: 480 },
    });
    expect(useWindowStore.getState().windows[inboxWinId].displayMode).toBe('floating');

    // Switch back to Space A (space_math): exact PDF + Notes + 0.62 ratio restored
    await handleStudySpaceChanged(
      makeSpaceEventDetail({
        spaceId: 'space_math',
        rootFolderId: 'fld_math',
        workbenchLayoutPreset: 'split_reader_chat',
      }),
    );
    const restoredMath = useWindowStore.getState();
    expect(restoredMath.windows[mathPdfId]).toBeDefined();
    expect(restoredMath.windows[mathPdfId].instanceKey).toBe('pdf_calculus');
    expect(restoredMath.windows[mathPdfId].displayMode).toBe('tiled-left');
    expect(restoredMath.windows[mathNotesId]?.displayMode).toBe('tiled-right');
    expect(restoredMath.tilingRatios[tilingPairKey(mathPdfId, mathNotesId)]).toBe(0.62);
    expect(getStagePresetState().activeStagePreset).toBe('deep-reading-map');

    // Switch back to Space B (space_physics): customized 0.36 ratio restored
    await handleStudySpaceChanged(
      makeSpaceEventDetail({
        spaceId: 'space_physics',
        rootFolderId: 'fld_physics',
        workbenchLayoutPreset: 'split_notes_chat',
      }),
    );
    const restoredPhysics = useWindowStore.getState();
    expect(restoredPhysics.tilingRatios[tilingPairKey(physNotes.id, physChat.id)]).toBe(0.36);
    expect(getStagePresetState().activeStagePreset).toBe('note-cocreation');

    // Switch back to Inbox: floating window frame restored
    await handleStudySpaceChanged(
      makeSpaceEventDetail({
        spaceId: null,
        rootFolderId: 'fld_inbox',
        workbenchLayoutPreset: 'freeform_desktop',
      }),
    );
    const restoredInbox = useWindowStore.getState();
    expect(restoredInbox.windows[inboxWinId]?.frame).toEqual({
      x: 210,
      y: 140,
      w: 640,
      h: 480,
    });
    expect(restoredInbox.windows[inboxWinId]?.displayMode).toBe('floating');
  });

  it('synchronously captures outgoing Space A layout before concurrent microtask preset mutations', async () => {
    localStorage.setItem(ACTIVE_STUDY_SPACE_STORAGE_KEY, 'space_math');
    await bootInitialSpaceWorkbench();

    const winLeft = useWindowStore.getState().openWindow({
      typeId: 'file-preview',
      instanceKey: 'pdf_linear_algebra',
      initialFrame: { x: 50, y: 40, w: 600, h: 500 },
    });
    const winRight = useWindowStore.getState().openWindow({
      typeId: 'notes',
      initialFrame: { x: 700, y: 40, w: 600, h: 500 },
    });
    useWindowStore.getState().batchSetDisplayModes?.([
      { id: winLeft, mode: 'tiled-left' },
      { id: winRight, mode: 'tiled-right' },
    ]);
    const pairKey = tilingPairKey(winLeft, winRight);
    useWindowStore.getState().setTilingRatio(pairKey, 0.64);
    setStagePresetState('deep-reading-map', null);

    let switchPromise: Promise<void> | null = null;
    const onSpaceEvent = (e: Event) => {
      const detail = (e as CustomEvent<StudySpaceChangedEventDetail>).detail;
      switchPromise = handleStudySpaceChanged(detail);
    };
    window.addEventListener(STUDY_SPACE_CHANGED_EVENT, onSpaceEvent);

    // Simulate W03 concurrent dynamic-import applier mutating windowStore in the first microtask
    const w03RaceListener = () => {
      void Promise.resolve().then(() => {
        useWindowStore.getState().hydrate([], {});
        useWindowStore.getState().openWindow({
          typeId: 'chat',
          title: 'Transient W03 Preset Window',
        });
      });
    };
    window.addEventListener(STUDY_SPACE_CHANGED_EVENT, w03RaceListener);

    try {
      window.dispatchEvent(
        new CustomEvent<StudySpaceChangedEventDetail>(STUDY_SPACE_CHANGED_EVENT, {
          detail: makeSpaceEventDetail({
            spaceId: 'space_physics',
            rootFolderId: 'fld_physics',
            workbenchLayoutPreset: 'split_reader_chat',
          }),
        }),
      );
      await switchPromise;

      // Verify Space A's outgoing snapshot was captured cleanly BEFORE the microtask mutation
      const savedMathEntry = await loadSpaceWorkbenchEntry('space_math');
      expect(savedMathEntry).not.toBeNull();
      expect(savedMathEntry!.snapshot.windows.map((w) => w.id)).toEqual([winLeft, winRight]);
      expect(savedMathEntry!.snapshot.tilingRatios[pairKey]).toBe(0.64);

      // Verify Space B ended up with W04's authoritative deep-reading-map layout (files + notes)
      const spaceBTypes = Object.values(useWindowStore.getState().windows)
        .filter((w) => !w.minimized)
        .map((w) => w.typeId)
        .sort();
      expect(spaceBTypes).toEqual(['files', 'notes']);

      // Switching back to Space A restores exact frames & 0.64 ratio despite W03 microtask race
      await handleStudySpaceChanged(
        makeSpaceEventDetail({
          spaceId: 'space_math',
          rootFolderId: 'fld_math',
          workbenchLayoutPreset: 'split_reader_chat',
        }),
      );
      expect(useWindowStore.getState().tilingRatios[pairKey]).toBe(0.64);
      expect(useWindowStore.getState().windows[winLeft]?.restoreFrame).toEqual({
        x: 50,
        y: 40,
        w: 600,
        h: 500,
      });
    } finally {
      window.removeEventListener(STUDY_SPACE_CHANGED_EVENT, onSpaceEvent);
      window.removeEventListener(STUDY_SPACE_CHANGED_EVENT, w03RaceListener);
    }
  });
});

describe('Legacy Migration, Mirror Hook & LRU Eviction', () => {
  it('keeps session snapshots when storage quota is exceeded', async () => {
    const snapshot = { version: 1 as const, windows: [makeWin({ id: 'a' })], dockPinned: [], tilingRatios: {} };
    await saveSpaceWorkbenchEntry({ spaceKey: 'space_a', snapshot, activeStagePreset: 'freeform-desktop' });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new DOMException('Full', 'QuotaExceededError'); });
    await expect(saveSpaceWorkbenchEntry({ spaceKey: 'space_b', snapshot, activeStagePreset: 'deep-reading-map' })).resolves.not.toBeNull();
    expect((await loadSpaceWorkbenchEntry('space_a'))?.snapshot.windows[0].id).toBe('a');
    expect((await loadSpaceWorkbenchEntry('space_b'))?.activeStagePreset).toBe('deep-reading-map');
  });

  it('tolerates corrupt JSON and unavailable browser storage', async () => {
    localStorage.setItem(WORKBENCH_SPACE_SNAPSHOTS_KEY, '{broken');
    expect(await loadSpaceSnapshotsEnvelope()).toBeNull();
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('localStorage', undefined);
    expect(readInitialActiveSpaceKey()).toBe(INBOX_SNAPSHOT_BUCKET_KEY);
    expect(await loadSpaceSnapshotsEnvelope()).toBeNull();
  });

  it('migrates legacy desktop.workbenchSnapshot cleanly on first boot and mirrors flushSnapshot', async () => {
    const legacyWinA = makeWin({
      id: 'leg_left',
      typeId: 'file-preview',
      instanceKey: 'pdf_old',
      displayMode: 'tiled-left',
      frame: { x: 40, y: 40, w: 600, h: 500 },
      restoreFrame: { x: 40, y: 40, w: 600, h: 500 },
    });
    const legacyWinB = makeWin({
      id: 'leg_right',
      typeId: 'notes',
      displayMode: 'tiled-right',
      frame: { x: 660, y: 40, w: 600, h: 500 },
      restoreFrame: { x: 660, y: 40, w: 600, h: 500 },
    });
    localStorage.setItem(
      WORKBENCH_SNAPSHOT_KEY,
      JSON.stringify({
        version: 1,
        windows: [legacyWinA, legacyWinB],
        dockPinned: ['chat', 'files'],
        tilingRatios: { 'leg_left:leg_right': 0.48 },
        desktopSize: { w: 1600, h: 900 },
      }),
    );
    localStorage.setItem(ACTIVE_STUDY_SPACE_STORAGE_KEY, 'space_migrated');

    const disposeMirror = installSpaceSnapshotMirror();
    try {
      const boot = await bootInitialSpaceWorkbench();
      expect(boot.migratedFromLegacy).toBe(true);
      expect(boot.spaceKey).toBe('space_migrated');
      expect(boot.activeStagePreset).toBe('deep-reading-map');
      expect(boot.snapshot?.windows.map((w) => w.id)).toEqual(['leg_left', 'leg_right']);

      const persisted = await loadSpaceWorkbenchEntry('space_migrated');
      expect(persisted).not.toBeNull();
      expect(persisted!.snapshot.tilingRatios).toEqual({ 'leg_left:leg_right': 0.48 });

      // Hydrate, mutate window, flushSnapshot -> mirror updates space entry
      useWindowStore
        .getState()
        .hydrate(boot.snapshot!.windows, boot.snapshot!.tilingRatios);
      useWindowStore.getState().setTilingRatio('leg_left:leg_right', 0.56);
      await flushSnapshot();

      const afterFlush = await loadSpaceWorkbenchEntry('space_migrated');
      expect(afterFlush!.snapshot.tilingRatios['leg_left:leg_right']).toBe(0.56);
    } finally {
      disposeMirror();
    }
  });

  it('enforces MAX_PERSISTED_SPACE_SNAPSHOTS = 32 LRU eviction by updatedAt', async () => {
    const totalSpaces = MAX_PERSISTED_SPACE_SNAPSHOTS + 4; // 36 spaces
    for (let i = 0; i < totalSpaces; i += 1) {
      const spaceKey = `space_${String(i).padStart(2, '0')}`;
      await saveSpaceWorkbenchEntry({
        spaceKey,
        snapshot: {
          version: 1,
          windows: [makeWin({ id: `w_${i}`, title: `Window ${i}` })],
          dockPinned: [],
          tilingRatios: {},
        },
        activeStagePreset: 'freeform-desktop',
        nextActiveSpaceKey: spaceKey,
      });
    }

    const envelope = await loadSpaceSnapshotsEnvelope();
    expect(envelope).not.toBeNull();
    const keys = Object.keys(envelope!.entries);
    expect(keys).toHaveLength(MAX_PERSISTED_SPACE_SNAPSHOTS);

    // Oldest 4 (space_00 .. space_03) were evicted; newest 32 (space_04 .. space_35) remain
    expect(envelope!.entries['space_00']).toBeUndefined();
    expect(envelope!.entries['space_03']).toBeUndefined();
    expect(envelope!.entries['space_04']).toBeDefined();
    expect(envelope!.entries['space_35']).toBeDefined();
    expect(localStorage.getItem(WORKBENCH_SPACE_SNAPSHOTS_KEY)).toBeTruthy();
  });

  it('preserves unsaved dirty windows minimized across space switches without unmounting them', async () => {
    appRegistry.register({
      typeId: 'dirty-note-app',
      nameKey: 'workbench:apps.note',
      icon: null,
      instanceMode: 'multi',
      memoryWeight: 2,
      defaultFrame: { w: 500, h: 400 },
      minSize: { w: 240, h: 180 },
      render: null as never,
      canSuspend: () => false,
    });

    localStorage.setItem(ACTIVE_STUDY_SPACE_STORAGE_KEY, 'space_a');
    await bootInitialSpaceWorkbench();

    const dirtyWinId = useWindowStore.getState().openWindow({
      typeId: 'dirty-note-app',
      instanceKey: 'draft_unsaved_1',
      title: '未保存草稿',
    });

    await handleStudySpaceChanged(
      makeSpaceEventDetail({
        spaceId: 'space_b',
        rootFolderId: 'fld_b',
        workbenchLayoutPreset: 'freeform_desktop',
      }),
    );

    const survivor = useWindowStore.getState().windows[dirtyWinId];
    expect(survivor).toBeDefined();
    expect(survivor.minimized).toBe(true);
  });
});

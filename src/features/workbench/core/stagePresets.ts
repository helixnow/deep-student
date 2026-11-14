/**
 * W04 — MarginNote 5 学习流阶段预设（Study-Flow Stage Presets）
 *
 * 将单个学习空间内的认知阶段映射为确定性的 Workbench 窗口分屏几何：
 * - 'deep-reading-map'    精读导图：左栏阅读器/资源库 (48%) + 右栏导图/笔记工作区 (52%)
 * - 'note-cocreation'     笔记共创：左栏笔记/导图工作区 (52%) + 右栏 AI 对话共创 (48%)
 * - 'practice-correction' 刷题订正：左栏闪卡/试卷 (50%) + 右栏错题笔记/AI 诊断 (50%)
 * - 'freeform-desktop'    自由桌面：将所有平铺窗口恢复为浮动窗口及原 restoreFrame
 *
 * 核心不变量：
 * 1. 仅编排现有 Workbench 子应用（files/file-preview/textbook/file/media、notes、flashcards/exam、chat），绝不新建独立导图壳。
 * 2. 进入结构化分屏预设时最小化无关窗口（minimizeWindow(id, true)），绝不 closeWindow（保护未保存草稿）。
 * 3. 严格先切 displayMode、后写 tilingRatio，避开 windowStore.pruneTilingRatios 对未就位配对的裁剪。
 */
import { create } from 'zustand';
import { dispatchTypedEvent } from '@/events';
import type { ActiveSpaceSelection, WorkbenchLayoutPreset } from '@/shared/study-space/types';
import type { DisplayMode, WorkbenchWindow } from './types';
import { useWindowStore } from './windowStore';
import { tilingPairKey } from './tiling';
import { workbenchBus } from './workbenchBus';
import { saveSnapshot } from './snapshot';

export type StudyFlowStagePresetId =
  | 'deep-reading-map'
  | 'note-cocreation'
  | 'practice-correction'
  | 'freeform-desktop';

export type StudyFlowSidecarKind = 'chat' | 'flashcards' | 'dual_reader' | null;

export interface StagePresetContext {
  spaceId?: ActiveSpaceSelection;
  rootFolderId?: string | null;
  defaultDeckId?: string | null;
  sidecar?: StudyFlowSidecarKind;
  /** When switching into a clean space, minimize floating windows outside the preset pair */
  closeUnmatched?: boolean;
}

export interface AppliedStagePresetResult {
  presetId: StudyFlowStagePresetId;
  sidecar: StudyFlowSidecarKind;
  leftWindowId: string | null;
  rightWindowId: string | null;
  sidecarWindowId: string | null;
  splitRatio: number | null;
}

export const STUDY_FLOW_STAGE_PRESET_IDS: readonly StudyFlowStagePresetId[] = [
  'deep-reading-map',
  'note-cocreation',
  'practice-correction',
  'freeform-desktop',
] as const;

const VALID_STAGE_PRESET_SET = new Set<string>(STUDY_FLOW_STAGE_PRESET_IDS);

const READER_WINDOW_TYPE_IDS: readonly string[] = [
  'file-preview',
  'textbook',
  'file',
  'media',
];

const NOTES_HOST_TYPE_IDS: readonly string[] = ['notes', 'mindmap'];

export function isValidStagePresetId(value: unknown): value is StudyFlowStagePresetId {
  return typeof value === 'string' && VALID_STAGE_PRESET_SET.has(value);
}

export function isValidSidecarKind(value: unknown): value is StudyFlowSidecarKind {
  return value === 'chat' || value === 'flashcards' || value === 'dual_reader' || value === null;
}

export function mapStudySpacePresetToStagePreset(
  preset: WorkbenchLayoutPreset | undefined,
): StudyFlowStagePresetId {
  switch (preset) {
    case 'split_reader_chat':
      return 'deep-reading-map';
    case 'split_notes_chat':
    case 'chat_focus':
      return 'note-cocreation';
    case 'practice_review':
      return 'practice-correction';
    case 'freeform_desktop':
    default:
      return 'freeform-desktop';
  }
}

export interface StagePresetStoreState {
  activeStagePreset: StudyFlowStagePresetId;
  sidecarMode: StudyFlowSidecarKind;
  setActiveStagePreset: (
    preset: StudyFlowStagePresetId,
    sidecar?: StudyFlowSidecarKind,
  ) => void;
  setSidecarMode: (sidecar: StudyFlowSidecarKind) => void;
}

export const useStagePresetStore = create<StagePresetStoreState>((set) => ({
  activeStagePreset: 'freeform-desktop',
  sidecarMode: null,
  setActiveStagePreset: (preset, sidecar) =>
    set((state) => ({
      activeStagePreset: preset,
      sidecarMode: sidecar !== undefined ? sidecar : state.sidecarMode,
    })),
  setSidecarMode: (sidecar) => set({ sidecarMode: sidecar }),
}));

export function getStagePresetState(): {
  activeStagePreset: StudyFlowStagePresetId;
  sidecarMode: StudyFlowSidecarKind;
} {
  const { activeStagePreset, sidecarMode } = useStagePresetStore.getState();
  return { activeStagePreset, sidecarMode };
}

export function setStagePresetState(
  activeStagePreset: StudyFlowStagePresetId,
  sidecarMode: StudyFlowSidecarKind = null,
): void {
  useStagePresetStore.getState().setActiveStagePreset(activeStagePreset, sidecarMode);
}

export function resetStagePresetStoreForTests(): void {
  useStagePresetStore.setState({
    activeStagePreset: 'freeform-desktop',
    sidecarMode: null,
  });
}

function pickMostRecentWindow(
  windows: Record<string, WorkbenchWindow>,
  candidateTypeIds: readonly string[],
): WorkbenchWindow | null {
  const candidates = Object.values(windows).filter((win) =>
    candidateTypeIds.includes(win.typeId),
  );
  if (candidates.length === 0) return null;
  candidates.sort(
    (a, b) =>
      b.lastFocusedAt - a.lastFocusedAt ||
      b.zIndex - a.zIndex ||
      b.createdAt - a.createdAt,
  );
  return candidates[0] ?? null;
}

function ensureAppWindow(typeId: string, payload?: unknown): string {
  const store = useWindowStore.getState();
  const existing = pickMostRecentWindow(store.windows, [typeId]);
  if (existing) {
    if (existing.minimized) {
      store.minimizeWindow(existing.id, false);
    }
    return existing.id;
  }
  if (workbenchBus.isEnabled()) {
    const launchedId = workbenchBus.launch({
      typeId,
      payload,
      reason: 'api',
    });
    if (launchedId && useWindowStore.getState().windows[launchedId]) {
      return launchedId;
    }
  }
  return useWindowStore.getState().openWindow({
    typeId,
    instanceKey: null,
    payload,
  });
}

function isTiledDisplayMode(mode: DisplayMode): boolean {
  return mode.startsWith('tiled-');
}

function minimizeUnrelatedWindows(targetIds: ReadonlySet<string>): void {
  const store = useWindowStore.getState();
  const restoreFloatingEntries: Array<{ id: string; mode: DisplayMode }> = [];
  for (const win of Object.values(store.windows)) {
    if (targetIds.has(win.id)) {
      if (win.minimized) {
        store.minimizeWindow(win.id, false);
      }
      continue;
    }
    if (isTiledDisplayMode(win.displayMode)) {
      restoreFloatingEntries.push({ id: win.id, mode: 'floating' });
    }
    if (!win.minimized) {
      store.minimizeWindow(win.id, true);
    }
  }
  if (restoreFloatingEntries.length > 0) {
    if (store.batchSetDisplayModes) {
      store.batchSetDisplayModes(restoreFloatingEntries);
    } else {
      for (const entry of restoreFloatingEntries) {
        useWindowStore.getState().setDisplayMode(entry.id, entry.mode);
      }
    }
  }
}

function applyTwoPaneSplit(
  leftWinId: string,
  rightWinId: string,
  defaultRatio: number,
): void {
  const targetIds = new Set([leftWinId, rightWinId]);
  minimizeUnrelatedWindows(targetIds);

  const store = useWindowStore.getState();
  const modeEntries: Array<{ id: string; mode: DisplayMode }> = [
    { id: leftWinId, mode: 'tiled-left' },
    { id: rightWinId, mode: 'tiled-right' },
  ];
  if (store.batchSetDisplayModes) {
    store.batchSetDisplayModes(modeEntries);
  } else {
    store.setDisplayMode(leftWinId, 'tiled-left');
    useWindowStore.getState().setDisplayMode(rightWinId, 'tiled-right');
  }

  const afterModes = useWindowStore.getState();
  afterModes.setTilingRatio(tilingPairKey(leftWinId, rightWinId), defaultRatio);
  afterModes.setTilingRatio('v', defaultRatio);
  afterModes.focusWindow(rightWinId);
}

function applyThreePaneSplit(
  leftWinId: string,
  topRightWinId: string,
  bottomRightWinId: string,
  defaultRatio: number,
  hRightRatio: number,
): void {
  const targetIds = new Set([leftWinId, topRightWinId, bottomRightWinId]);
  minimizeUnrelatedWindows(targetIds);

  const store = useWindowStore.getState();
  const modeEntries: Array<{ id: string; mode: DisplayMode }> = [
    { id: leftWinId, mode: 'tiled-left' },
    { id: topRightWinId, mode: 'tiled-tr' },
    { id: bottomRightWinId, mode: 'tiled-br' },
  ];
  if (store.batchSetDisplayModes) {
    store.batchSetDisplayModes(modeEntries);
  } else {
    store.setDisplayMode(leftWinId, 'tiled-left');
    useWindowStore.getState().setDisplayMode(topRightWinId, 'tiled-tr');
    useWindowStore.getState().setDisplayMode(bottomRightWinId, 'tiled-br');
  }

  const afterModes = useWindowStore.getState();
  afterModes.setTilingRatio('v', defaultRatio);
  afterModes.setTilingRatio('h-right', hRightRatio);
  afterModes.focusWindow(topRightWinId);
}

function applyLeftStackRightHubSplit(
  topLeftWinId: string,
  bottomLeftWinId: string,
  rightHubWinId: string,
  defaultRatio: number,
  hLeftRatio: number,
): void {
  const targetIds = new Set([topLeftWinId, bottomLeftWinId, rightHubWinId]);
  minimizeUnrelatedWindows(targetIds);

  const store = useWindowStore.getState();
  const modeEntries: Array<{ id: string; mode: DisplayMode }> = [
    { id: topLeftWinId, mode: 'tiled-tl' },
    { id: bottomLeftWinId, mode: 'tiled-bl' },
    { id: rightHubWinId, mode: 'tiled-right' },
  ];
  if (store.batchSetDisplayModes) {
    store.batchSetDisplayModes(modeEntries);
  } else {
    store.setDisplayMode(topLeftWinId, 'tiled-tl');
    useWindowStore.getState().setDisplayMode(bottomLeftWinId, 'tiled-bl');
    useWindowStore.getState().setDisplayMode(rightHubWinId, 'tiled-right');
  }

  const afterModes = useWindowStore.getState();
  afterModes.setTilingRatio('v', defaultRatio);
  afterModes.setTilingRatio('h-left', hLeftRatio);
  afterModes.focusWindow(rightHubWinId);
}

function pickSecondaryReferenceWindow(
  windows: Record<string, WorkbenchWindow>,
  excludeIds: ReadonlySet<string>,
  rootFolderId?: string | null,
): string {
  const secondaryTypes = ['file-preview', 'textbook', 'file', 'media', 'exam', 'files'];
  const candidates = Object.values(windows).filter(
    (win) => !excludeIds.has(win.id) && secondaryTypes.includes(win.typeId),
  );
  if (candidates.length > 0) {
    candidates.sort(
      (a, b) =>
        b.lastFocusedAt - a.lastFocusedAt ||
        b.zIndex - a.zIndex ||
        b.createdAt - a.createdAt,
    );
    const chosen = candidates[0]!;
    if (chosen.minimized) {
      useWindowStore.getState().minimizeWindow(chosen.id, false);
    }
    return chosen.id;
  }
  const primaryType = windows[[...excludeIds][0] ?? '']?.typeId;
  if (primaryType !== 'files') {
    const folderId = rootFolderId?.trim() || undefined;
    return ensureAppWindow('files', folderId ? { folderId } : undefined);
  }
  return ensureAppWindow('exam');
}

function dispatchPreferMindMapTab(rootFolderId?: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    dispatchTypedEvent('workbench:prefer-mindmap-tab', { rootFolderId: rootFolderId ?? null });
  } catch {
    // non-DOM fallback
  }
}

export async function applyStudyFlowStagePreset(
  presetId: StudyFlowStagePresetId,
  ctx?: StagePresetContext,
): Promise<AppliedStagePresetResult> {
  if (presetId === 'freeform-desktop') {
    const store = useWindowStore.getState();
    const tiledWindows = Object.values(store.windows).filter((win) =>
      isTiledDisplayMode(win.displayMode),
    );
    for (const win of tiledWindows) {
      useWindowStore.getState().setDisplayMode(win.id, 'floating');
    }
    if (ctx?.closeUnmatched) {
      for (const win of Object.values(useWindowStore.getState().windows)) {
        if (!win.minimized) {
          useWindowStore.getState().minimizeWindow(win.id, true);
        }
      }
    }
    setStagePresetState('freeform-desktop', null);
    saveSnapshot('layout');
    return {
      presetId: 'freeform-desktop',
      sidecar: null,
      leftWindowId: null,
      rightWindowId: null,
      sidecarWindowId: null,
      splitRatio: null,
    };
  }

  if (presetId === 'deep-reading-map') {
    const defaultRatio = 0.48;
    const requestedSidecar: StudyFlowSidecarKind =
      ctx?.sidecar !== undefined ? ctx.sidecar : null;
    const readerWindows = useWindowStore.getState().windows;
    // Keep Reader A when disabling the comparison, even if Reader B was focused last.
    const existingReader = Object.values(readerWindows).find((win) => !win.minimized
      && READER_WINDOW_TYPE_IDS.includes(win.typeId)
      && (win.displayMode === 'tiled-tl' || win.displayMode === 'tiled-left')) ?? pickMostRecentWindow(
      readerWindows,
      READER_WINDOW_TYPE_IDS,
    );

    let leftWinId: string;
    if (existingReader) {
      if (existingReader.minimized) {
        useWindowStore.getState().minimizeWindow(existingReader.id, false);
      }
      leftWinId = existingReader.id;
    } else {
      const folderId = ctx?.rootFolderId?.trim() || undefined;
      leftWinId = ensureAppWindow('files', folderId ? { folderId } : undefined);
      if (folderId && workbenchBus.isEnabled()) {
        void workbenchBus.activate({
          typeId: 'files',
          instanceKey: '',
          action: 'openFolder',
          payload: { folderId },
        });
      }
    }

    const existingNotesHost = pickMostRecentWindow(
      useWindowStore.getState().windows,
      NOTES_HOST_TYPE_IDS,
    );
    const rightWinId = existingNotesHost
      ? (() => {
          if (existingNotesHost.minimized) {
            useWindowStore.getState().minimizeWindow(existingNotesHost.id, false);
          }
          return existingNotesHost.id;
        })()
      : ensureAppWindow('notes');

    // Existing notes hosts own their active document/tab; layout changes must
    // not steal it. Only a freshly opened host needs an initial preference.
    if (!existingNotesHost) dispatchPreferMindMapTab(ctx?.rootFolderId);

    if (requestedSidecar === 'dual_reader') {
      const readerBWinId = pickSecondaryReferenceWindow(
        useWindowStore.getState().windows,
        new Set([leftWinId, rightWinId]),
        ctx?.rootFolderId,
      );
      if (readerBWinId !== leftWinId && readerBWinId !== rightWinId) {
        applyLeftStackRightHubSplit(leftWinId, readerBWinId, rightWinId, 0.52, 0.5);
        setStagePresetState('deep-reading-map', 'dual_reader');
        saveSnapshot('layout');
        return {
          presetId: 'deep-reading-map',
          sidecar: 'dual_reader',
          leftWindowId: leftWinId,
          rightWindowId: rightWinId,
          sidecarWindowId: readerBWinId,
          splitRatio: 0.52,
        };
      }
    }

    if (requestedSidecar === 'chat' || requestedSidecar === 'flashcards') {
      const sidecarPayload =
        requestedSidecar === 'flashcards' && ctx?.defaultDeckId
          ? { deckId: ctx.defaultDeckId }
          : undefined;
      const sidecarWinId = ensureAppWindow(requestedSidecar, sidecarPayload);
      if (sidecarWinId !== leftWinId && sidecarWinId !== rightWinId) {
        applyThreePaneSplit(leftWinId, rightWinId, sidecarWinId, defaultRatio, 0.58);
        setStagePresetState('deep-reading-map', requestedSidecar);
        saveSnapshot('layout');
        return {
          presetId: 'deep-reading-map',
          sidecar: requestedSidecar,
          leftWindowId: leftWinId,
          rightWindowId: rightWinId,
          sidecarWindowId: sidecarWinId,
          splitRatio: defaultRatio,
        };
      }
    }

    applyTwoPaneSplit(leftWinId, rightWinId, defaultRatio);
    setStagePresetState('deep-reading-map', null);
    saveSnapshot('layout');
    return {
      presetId: 'deep-reading-map',
      sidecar: null,
      leftWindowId: leftWinId,
      rightWindowId: rightWinId,
      sidecarWindowId: null,
      splitRatio: defaultRatio,
    };
  }

  if (presetId === 'note-cocreation') {
    const defaultRatio = 0.52;
    const requestedSidecar: StudyFlowSidecarKind =
      ctx?.sidecar === 'flashcards' ? 'flashcards' : null;

    const existingNotesHost = pickMostRecentWindow(
      useWindowStore.getState().windows,
      NOTES_HOST_TYPE_IDS,
    );
    const leftWinId = existingNotesHost
      ? (() => {
          if (existingNotesHost.minimized) {
            useWindowStore.getState().minimizeWindow(existingNotesHost.id, false);
          }
          return existingNotesHost.id;
        })()
      : ensureAppWindow('notes');

    const rightWinId = ensureAppWindow('chat');

    if (requestedSidecar === 'flashcards') {
      const sidecarWinId = ensureAppWindow(
        'flashcards',
        ctx?.defaultDeckId ? { deckId: ctx.defaultDeckId } : undefined,
      );
      if (sidecarWinId !== leftWinId && sidecarWinId !== rightWinId) {
        applyThreePaneSplit(leftWinId, rightWinId, sidecarWinId, defaultRatio, 0.6);
        setStagePresetState('note-cocreation', 'flashcards');
        saveSnapshot('layout');
        return {
          presetId: 'note-cocreation',
          sidecar: 'flashcards',
          leftWindowId: leftWinId,
          rightWindowId: rightWinId,
          sidecarWindowId: sidecarWinId,
          splitRatio: defaultRatio,
        };
      }
    }

    applyTwoPaneSplit(leftWinId, rightWinId, defaultRatio);
    setStagePresetState('note-cocreation', null);
    saveSnapshot('layout');
    return {
      presetId: 'note-cocreation',
      sidecar: null,
      leftWindowId: leftWinId,
      rightWindowId: rightWinId,
      sidecarWindowId: null,
      splitRatio: defaultRatio,
    };
  }

  // 'practice-correction'
  const defaultRatio = 0.5;
  const currentWindows = useWindowStore.getState().windows;
  const openExam = pickMostRecentWindow(currentWindows, ['exam']);
  const openFlashcards = pickMostRecentWindow(currentWindows, ['flashcards']);

  let leftWinId: string;
  if (
    openExam &&
    (!openFlashcards || openExam.lastFocusedAt >= openFlashcards.lastFocusedAt)
  ) {
    if (openExam.minimized) {
      useWindowStore.getState().minimizeWindow(openExam.id, false);
    }
    leftWinId = openExam.id;
  } else if (openFlashcards) {
    if (openFlashcards.minimized) {
      useWindowStore.getState().minimizeWindow(openFlashcards.id, false);
    }
    leftWinId = openFlashcards.id;
  } else {
    leftWinId = ensureAppWindow(
      'flashcards',
      ctx?.defaultDeckId ? { deckId: ctx.defaultDeckId } : undefined,
    );
  }

  const afterLeftWindows = useWindowStore.getState().windows;
  const existingNotes = pickMostRecentWindow(afterLeftWindows, ['notes']);
  const existingChat = pickMostRecentWindow(afterLeftWindows, ['chat']);
  const wantsThreePane =
    (Boolean(existingNotes) && Boolean(existingChat)) || ctx?.sidecar === 'chat';

  if (wantsThreePane) {
    const notesWinId = existingNotes
      ? (() => {
          if (existingNotes.minimized) {
            useWindowStore.getState().minimizeWindow(existingNotes.id, false);
          }
          return existingNotes.id;
        })()
      : ensureAppWindow('notes');
    const chatWinId = existingChat
      ? (() => {
          if (existingChat.minimized) {
            useWindowStore.getState().minimizeWindow(existingChat.id, false);
          }
          return existingChat.id;
        })()
      : ensureAppWindow('chat');

    applyThreePaneSplit(leftWinId, notesWinId, chatWinId, defaultRatio, 0.55);
    setStagePresetState('practice-correction', 'chat');
    saveSnapshot('layout');
    return {
      presetId: 'practice-correction',
      sidecar: 'chat',
      leftWindowId: leftWinId,
      rightWindowId: notesWinId,
      sidecarWindowId: chatWinId,
      splitRatio: defaultRatio,
    };
  }

  const rightWinId = existingNotes
    ? (() => {
        if (existingNotes.minimized) {
          useWindowStore.getState().minimizeWindow(existingNotes.id, false);
        }
        return existingNotes.id;
      })()
    : ensureAppWindow('chat');

  applyTwoPaneSplit(leftWinId, rightWinId, defaultRatio);
  setStagePresetState('practice-correction', null);
  saveSnapshot('layout');
  return {
    presetId: 'practice-correction',
    sidecar: null,
    leftWindowId: leftWinId,
    rightWindowId: rightWinId,
    sidecarWindowId: null,
    splitRatio: defaultRatio,
  };
}

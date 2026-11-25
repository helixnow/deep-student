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
import { invoke } from '@tauri-apps/api/core';
import { dstu, folderApi, type DstuNode } from '@/dstu';
import { sessionManager } from '@/features/chat';
import { dispatchTypedEvent } from '@/events';
import type { ActiveSpaceSelection, WorkbenchLayoutPreset } from '@/shared/study-space/types';
import type { DisplayMode, WorkbenchWindow } from './types';
import { appRegistry } from './appRegistry';
import { useWindowStore } from './windowStore';
import { tilingPairKey } from './tiling';
import { workbenchBus } from './workbenchBus';
import { saveSnapshot } from './snapshot';
import { resourceTypeToAppTypeId } from '../apps/content/typeMap';
import { requestWorkspaceResource } from '../apps/notes/workspaceRegistry';
import { requestResourceWorkspace } from '../apps/content/resourceWorkspaceRegistry';
import {
  WORKBENCH_HYDRATE_RECENT_RESOURCE_EVENT,
  type WorkbenchHydrateRecentResourceDetail,
} from '../apps/content/ResourceAppWorkspace';
import { openChatSession } from '../apps/chat/newSession';
import { QBANK_CONTROL_EVENT, type QbankControlEventDetail } from '../agent/drivers/qbankDriver';

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

function ensureAppWindow(
  typeId: string,
  payload?: unknown,
  instanceKey: string | null = null,
): string {
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
      instanceKey: instanceKey ?? undefined,
      payload,
      reason: 'api',
    });
    if (launchedId && useWindowStore.getState().windows[launchedId]) {
      return launchedId;
    }
  }
  return useWindowStore.getState().openWindow({
    typeId,
    instanceKey,
    payload,
  });
}

const PRESET_HYDRATE_TIMEOUT_MS = 500;

async function withHydrateTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((resolve) => {
        timer = setTimeout(() => resolve(fallback), PRESET_HYDRATE_TIMEOUT_MS);
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer !== null) clearTimeout(timer);
  }
}

async function collectSubtreeResourceIds(rootFolderId?: string | null): Promise<Set<string> | null> {
  const folderId = rootFolderId?.trim();
  if (!folderId || typeof folderApi?.getFolderTree !== 'function') return null;
  const treeResult = await withHydrateTimeout(folderApi.getFolderTree(), null);
  if (!treeResult?.ok || !Array.isArray(treeResult.value)) return null;

  type FolderTreeNode = {
    id?: string;
    items?: Array<{ itemId?: string }>;
    children?: FolderTreeNode[];
  };

  const ids = new Set<string>();
  const collect = (node: FolderTreeNode) => {
    for (const item of node.items ?? []) {
      if (item?.itemId) ids.add(item.itemId);
    }
    for (const child of node.children ?? []) collect(child);
  };
  const findRoot = (nodes: FolderTreeNode[]): FolderTreeNode | null => {
    for (const node of nodes) {
      if (node.id === folderId) return node;
      const found = node.children ? findRoot(node.children) : null;
      if (found) return found;
    }
    return null;
  };
  const matched = findRoot(treeResult.value as FolderTreeNode[]);
  if (!matched) return null;
  collect(matched);
  return ids.size > 0 ? ids : null;
}

async function listRecentNodesByTypes(
  types: readonly ('note' | 'mindmap' | 'textbook' | 'file' | 'exam')[],
  limitPerType = 12,
): Promise<DstuNode[]> {
  if (typeof dstu?.list !== 'function') return [];
  const results = await withHydrateTimeout(
    Promise.allSettled(
      types.map((typeFilter) =>
        dstu.list('/', {
          typeFilter,
          sortBy: 'updatedAt',
          sortOrder: 'desc',
          limit: limitPerType,
        }),
      ),
    ),
    [],
  );
  const byId = new Map<string, DstuNode>();
  for (const res of results) {
    if (res.status !== 'fulfilled' || !res.value?.ok || !Array.isArray(res.value.value)) continue;
    for (const node of res.value.value) {
      if (node?.id && node.type !== 'folder') {
        byId.set(node.id, node);
      }
    }
  }
  return [...byId.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
}

async function resolveRecentReaderNode(rootFolderId?: string | null): Promise<{
  node: DstuNode;
  appTypeId: string;
} | null> {
  const candidates = await listRecentNodesByTypes(['textbook', 'file'], 10);
  if (candidates.length === 0) return null;
  const folderItemIds = await collectSubtreeResourceIds(rootFolderId);
  const ordered = folderItemIds
    ? [
        ...candidates.filter((n) => folderItemIds.has(n.id)),
        ...candidates.filter((n) => !folderItemIds.has(n.id)),
      ]
    : candidates;
  for (const node of ordered) {
    const appTypeId = resourceTypeToAppTypeId(node.type);
    if (appTypeId && appRegistry.get(appTypeId)) {
      return { node, appTypeId };
    }
  }
  return null;
}

async function resolveRecentNotesNode(
  preferredType: 'mindmap' | 'note',
  rootFolderId?: string | null,
  preferCorrectionNotes = false,
): Promise<{ node: DstuNode; resourceType: 'mindmap' | 'note' } | null> {
  const types: readonly ('mindmap' | 'note')[] =
    preferredType === 'mindmap' ? ['mindmap', 'note'] : ['note', 'mindmap'];
  const candidates = await listRecentNodesByTypes(types, 16);
  if (candidates.length === 0) return null;
  const folderItemIds = await collectSubtreeResourceIds(rootFolderId);
  const inFolder = folderItemIds ? candidates.filter((n) => folderItemIds.has(n.id)) : [];
  const pool = inFolder.length > 0 ? inFolder : candidates;
  const correctionRegex = /错题|订正|复盘|mistake|review|error/i;

  const picked =
    (preferCorrectionNotes
      ? pool.find((n) => n.type === 'note' && correctionRegex.test(n.name))
      : undefined) ??
    pool.find((n) => n.type === preferredType) ??
    pool[0];

  if (!picked || (picked.type !== 'note' && picked.type !== 'mindmap')) return null;
  return { node: picked, resourceType: picked.type };
}

async function resolveRecentExamTarget(rootFolderId?: string | null): Promise<{
  examNode: DstuNode;
  hasDueMistakes: boolean;
} | null> {
  if (!appRegistry.get('exam')) return null;
  const [exams, dueResult] = await Promise.all([
    listRecentNodesByTypes(['exam'], 12),
    withHydrateTimeout(
      invoke<{ plans?: Array<{ exam_id?: string | null }> }>(
        'review_plan_get_due_with_filter',
        { filter: { limit: 10 } },
      ),
      { plans: [] },
    ),
  ]);
  if (exams.length === 0) return null;
  const dueList = Array.isArray(dueResult?.plans) ? dueResult.plans : [];
  const dueExamId = dueList.find((plan) => plan?.exam_id)?.exam_id ?? null;
  if (dueExamId) {
    const matchedDueExam = exams.find((exam) => exam.id === dueExamId);
    if (matchedDueExam) {
      return { examNode: matchedDueExam, hasDueMistakes: true };
    }
  }
  const folderItemIds = await collectSubtreeResourceIds(rootFolderId);
  const preferredExam =
    (folderItemIds ? exams.find((exam) => folderItemIds.has(exam.id)) : undefined) ?? exams[0];
  return preferredExam
    ? { examNode: preferredExam, hasDueMistakes: dueList.length > 0 }
    : null;
}

async function resolveRecentChatSessionId(): Promise<string | null> {
  try {
    const currentId = sessionManager?.getCurrentSessionId?.();
    if (currentId) return currentId;
  } catch {
    // ignore
  }
  type SessionRow = { id?: string; mode?: string; updatedAt?: string };
  const settledResults = await withHydrateTimeout<Array<PromiseSettledResult<SessionRow[]>>>(
    Promise.allSettled([
      invoke<SessionRow[]>('chat_v2_list_sessions', {
        status: 'active',
        groupId: '',
        limit: 5,
        offset: 0,
      }),
      invoke<SessionRow[]>('chat_v2_list_sessions', {
        status: 'active',
        groupId: '*',
        limit: 5,
        offset: 0,
      }),
    ]),
    [],
  );
  const rows: Array<{ id: string; updatedAt: string }> = [];
  for (const res of settledResults) {
    if (!res || res.status !== 'fulfilled' || !Array.isArray(res.value)) continue;
    for (const row of res.value) {
      if (row?.id && row.mode !== 'agent') {
        rows.push({ id: row.id, updatedAt: row.updatedAt ?? '' });
      }
    }
  }
  rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return rows[0]?.id ?? null;
}

function dispatchHydrateNotesStage(
  preferredType: 'mindmap' | 'note',
  rootFolderId?: string | null,
  preferCorrectionNotes = false,
): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(
      new CustomEvent('workbench:hydrate-notes-stage', {
        detail: {
          preferredType,
          rootFolderId: rootFolderId ?? null,
          preferCorrectionNotes,
        },
      }),
    );
  } catch {
    // non-DOM fallback
  }
}

function dispatchHydrateRecentResource(detail: WorkbenchHydrateRecentResourceDetail): void {
  if (typeof window === 'undefined') return;
  try {
    window.dispatchEvent(new CustomEvent(WORKBENCH_HYDRATE_RECENT_RESOURCE_EVENT, { detail }));
  } catch {
    // non-DOM fallback
  }
}

function dispatchPreferReviewFirstMode(): void {
  if (typeof window === 'undefined') return;
  try {
    const detail: QbankControlEventDetail = {
      action: 'setPracticeMode',
      payload: { mode: 'review_first' },
    };
    window.dispatchEvent(new CustomEvent(QBANK_CONTROL_EVENT, { detail }));
  } catch {
    // non-DOM fallback
  }
}

function ensureHydratedNotesWindow(
  existingNotesHost: WorkbenchWindow | null,
  recentNotes: { node: DstuNode; resourceType: 'mindmap' | 'note' } | null,
  preferredType: 'mindmap' | 'note',
  rootFolderId?: string | null,
  preferCorrectionNotes = false,
): string {
  if (existingNotesHost) {
    if (existingNotesHost.minimized) {
      useWindowStore.getState().minimizeWindow(existingNotesHost.id, false);
    }
    // 仅在宿主窗口当前无任何打开标签时由 NotesWorkspaceApp 温和补入最近文档，绝不抢占活跃标签
    dispatchHydrateNotesStage(preferredType, rootFolderId, preferCorrectionNotes);
    return existingNotesHost.id;
  }
  const payload = recentNotes
    ? {
        resourceType: recentNotes.resourceType,
        resourceId: recentNotes.node.id,
        title: recentNotes.node.name,
      }
    : undefined;
  const winId = ensureAppWindow(
    'notes',
    payload,
    recentNotes ? `${recentNotes.resourceType}:${recentNotes.node.id}` : null,
  );
  if (recentNotes) {
    requestWorkspaceResource(
      { type: recentNotes.resourceType, id: recentNotes.node.id },
      recentNotes.node.name,
    );
  }
  dispatchHydrateNotesStage(preferredType, rootFolderId, preferCorrectionNotes);
  return winId;
}

function ensureHydratedChatWindow(recentSessionId: string | null): string {
  const existingChat = pickMostRecentWindow(useWindowStore.getState().windows, ['chat']);
  if (existingChat) {
    if (existingChat.minimized) {
      useWindowStore.getState().minimizeWindow(existingChat.id, false);
    }
    if (recentSessionId && !existingChat.instanceKey) {
      openChatSession(recentSessionId, 'api');
    }
    return existingChat.id;
  }
  if (recentSessionId) {
    const launchedViaSession = openChatSession(recentSessionId, 'api');
    if (launchedViaSession && useWindowStore.getState().windows[launchedViaSession]) {
      return launchedViaSession;
    }
    return ensureAppWindow('chat', { sessionId: recentSessionId }, recentSessionId);
  }
  return ensureAppWindow('chat');
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
  focusTarget: 'left' | 'right' = 'right',
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
  afterModes.focusWindow(focusTarget === 'left' ? leftWinId : rightWinId);
}

function applyThreePaneSplit(
  leftWinId: string,
  topRightWinId: string,
  bottomRightWinId: string,
  defaultRatio: number,
  hRightRatio: number,
  focusTarget: 'left' | 'topRight' = 'topRight',
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
  afterModes.focusWindow(focusTarget === 'left' ? leftWinId : topRightWinId);
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
      const recentReader = await resolveRecentReaderNode(ctx?.rootFolderId);
      if (recentReader) {
        leftWinId = ensureAppWindow(
          recentReader.appTypeId,
          {
            resourceId: recentReader.node.id,
            title: recentReader.node.name,
          },
          recentReader.node.id,
        );
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
    }

    const existingNotesHost = pickMostRecentWindow(
      useWindowStore.getState().windows,
      NOTES_HOST_TYPE_IDS,
    );
    const recentMindmapOrNote = existingNotesHost
      ? null
      : await resolveRecentNotesNode('mindmap', ctx?.rootFolderId, false);
    const rightWinId = ensureHydratedNotesWindow(
      existingNotesHost,
      recentMindmapOrNote,
      'mindmap',
      ctx?.rootFolderId,
      false,
    );

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
      const recentChatId =
        requestedSidecar === 'chat' ? await resolveRecentChatSessionId() : null;
      const sidecarWinId =
        requestedSidecar === 'chat'
          ? ensureHydratedChatWindow(recentChatId)
          : ensureAppWindow(
              'flashcards',
              ctx?.defaultDeckId ? { deckId: ctx.defaultDeckId } : undefined,
            );
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
    const [recentNote, recentChatId] = await Promise.all([
      existingNotesHost ? Promise.resolve(null) : resolveRecentNotesNode('note', ctx?.rootFolderId, false),
      resolveRecentChatSessionId(),
    ]);
    const leftWinId = ensureHydratedNotesWindow(
      existingNotesHost,
      recentNote,
      'note',
      ctx?.rootFolderId,
      false,
    );

    const rightWinId = ensureHydratedChatWindow(recentChatId);

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
    dispatchHydrateRecentResource({ type: 'exam', practiceMode: 'review_first' });
    dispatchPreferReviewFirstMode();
  } else if (openFlashcards) {
    if (openFlashcards.minimized) {
      useWindowStore.getState().minimizeWindow(openFlashcards.id, false);
    }
    leftWinId = openFlashcards.id;
  } else {
    const recentExamTarget = ctx?.defaultDeckId
      ? null
      : await resolveRecentExamTarget(ctx?.rootFolderId);
    if (recentExamTarget) {
      const { examNode } = recentExamTarget;
      leftWinId = ensureAppWindow(
        'exam',
        {
          resourceId: examNode.id,
          practiceMode: 'review_first',
          title: examNode.name,
        },
        examNode.id,
      );
      requestResourceWorkspace('exam', examNode.id);
      dispatchHydrateRecentResource({
        type: 'exam',
        resourceId: examNode.id,
        practiceMode: 'review_first',
      });
      dispatchPreferReviewFirstMode();
    } else {
      leftWinId = ensureAppWindow(
        'flashcards',
        ctx?.defaultDeckId ? { deckId: ctx.defaultDeckId } : undefined,
      );
    }
  }

  const afterLeftWindows = useWindowStore.getState().windows;
  const existingNotes = pickMostRecentWindow(afterLeftWindows, ['notes']);
  const existingChat = pickMostRecentWindow(afterLeftWindows, ['chat']);
  const [recentCorrectionNote, recentChatId] = await Promise.all([
    existingNotes
      ? Promise.resolve(null)
      : resolveRecentNotesNode('note', ctx?.rootFolderId, true),
    resolveRecentChatSessionId(),
  ]);
  const wantsThreePane =
    (Boolean(existingNotes) && Boolean(existingChat)) ||
    ctx?.sidecar === 'chat' ||
    (!existingNotes && !existingChat && Boolean(recentCorrectionNote) && Boolean(recentChatId));

  if (wantsThreePane) {
    const notesWinId = ensureHydratedNotesWindow(
      existingNotes,
      recentCorrectionNote,
      'note',
      ctx?.rootFolderId,
      true,
    );
    const chatWinId = ensureHydratedChatWindow(recentChatId);

    applyThreePaneSplit(leftWinId, notesWinId, chatWinId, defaultRatio, 0.55, 'left');
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
    ? ensureHydratedNotesWindow(existingNotes, null, 'note', ctx?.rootFolderId, true)
    : !existingChat && recentCorrectionNote
      ? ensureHydratedNotesWindow(null, recentCorrectionNote, 'note', ctx?.rootFolderId, true)
      : ensureHydratedChatWindow(recentChatId);

  applyTwoPaneSplit(leftWinId, rightWinId, defaultRatio, 'left');
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

/**
 * W04 — 按学习空间隔离的 Workbench 窗口布局快照（Per-Space Layout Snapshots）
 *
 * 解决单一全局 desktop.workbenchSnapshot 在切换不同学习空间（如「高等数学」↔「大学物理」↔ Inbox）
 * 时窗口与平铺比例互相覆盖的问题，同时 100% 保持既有 snapshot.ts 接口与单测向后兼容：
 * - 存储键：'desktop.workbenchSpaceSnapshots.v1'（最多保留 32 个空间快照，按 updatedAt LRU 淘汰）
 * - 首次启动平滑迁移：无空间快照时自动读取既有 'desktop.workbenchSnapshot' 并注入初始空间桶
 * - 零竞态空间切换：在 'study-space:changed' 触发瞬间（任何 await 之前）同步捕获迁出空间快照，
 *   让出一个微任务（避开 W03 动态 preset applier 并发写入）后恢复目标空间快照或应用阶段预设
 */
import { create } from 'zustand';
import type {
  ActiveSpaceSelection,
  StudySpaceChangedEventDetail,
  WorkbenchLayoutPreset,
} from '@/shared/study-space/types';
import type { WorkbenchSnapshotV1, WorkbenchWindow } from './types';
import { appRegistry } from './appRegistry';
import { setPendingRestoreDesktopSize, useWindowStore } from './windowStore';
import {
  buildSnapshot,
  cancelPendingSnapshotSave,
  invalidateSnapshotDedupeCache,
  loadSnapshot,
  readWorkbenchSetting,
  registerSnapshotMirrorHook,
  sanitizeSnapshot,
  saveSnapshot,
  setSnapshotPersistencePaused,
  unregisterSnapshotMirrorHook,
  writeWorkbenchSetting,
} from './snapshot';
import {
  applyStudyFlowStagePreset,
  getStagePresetState,
  isValidSidecarKind,
  isValidStagePresetId,
  mapStudySpacePresetToStagePreset,
  setStagePresetState,
  type StudyFlowSidecarKind,
  type StudyFlowStagePresetId,
} from './stagePresets';

export const WORKBENCH_SPACE_SNAPSHOTS_KEY = 'desktop.workbenchSpaceSnapshots.v1' as const;
export const ACTIVE_STUDY_SPACE_STORAGE_KEY = 'ds.studySpace.activeId.v1' as const;
export const INBOX_SNAPSHOT_BUCKET_KEY = '__inbox__' as const;
export const MAX_PERSISTED_SPACE_SNAPSHOTS = 32;

export interface PersistedSpaceWorkbenchEntry {
  spaceKey: string;
  /** Canonical Workbench window + tilingRatios snapshot sanitized via sanitizeSnapshot() */
  snapshot: WorkbenchSnapshotV1;
  /** Last user-selected Study-Flow Stage Preset in this space */
  activeStagePreset: StudyFlowStagePresetId;
  /** Optional active sidecar companion ('chat' | 'flashcards' | 'dual_reader' | null) */
  sidecarMode?: StudyFlowSidecarKind;
  updatedAt: number;
}

export interface WorkbenchSpaceSnapshotsEnvelopeV1 {
  version: 1;
  activeSpaceKey: string;
  entries: Record<string, PersistedSpaceWorkbenchEntry>;
}

export interface ActiveSpaceRuntimeContext {
  spaceKey: string;
  spaceId: ActiveSpaceSelection;
  rootFolderId: string | null;
  defaultDeckId: string | null;
  workbenchLayoutPreset?: WorkbenchLayoutPreset;
}

interface ActiveSpaceContextStore {
  context: ActiveSpaceRuntimeContext;
  setContext: (next: ActiveSpaceRuntimeContext) => void;
}

export function normalizeSpaceSnapshotKey(spaceId: ActiveSpaceSelection | undefined): string {
  if (typeof spaceId !== 'string') return INBOX_SNAPSHOT_BUCKET_KEY;
  const trimmed = spaceId.trim();
  if (!trimmed || trimmed === '__inbox__' || trimmed === 'null') {
    return INBOX_SNAPSHOT_BUCKET_KEY;
  }
  return trimmed;
}

export function readInitialActiveSpaceKey(): string {
  try {
    if (typeof localStorage === 'undefined') return INBOX_SNAPSHOT_BUCKET_KEY;
    const raw = localStorage.getItem(ACTIVE_STUDY_SPACE_STORAGE_KEY);
    if (raw == null) return INBOX_SNAPSHOT_BUCKET_KEY;
    const trimmed = raw.trim();
    if (!trimmed || trimmed === 'null') return INBOX_SNAPSHOT_BUCKET_KEY;
    if (
      (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith('{') && trimmed.endsWith('}'))
    ) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (typeof parsed === 'string' || parsed === null) {
          return normalizeSpaceSnapshotKey(parsed);
        }
        if (parsed && typeof parsed === 'object' && 'spaceId' in parsed) {
          const sid = (parsed as { spaceId?: unknown }).spaceId;
          if (typeof sid === 'string' || sid === null) {
            return normalizeSpaceSnapshotKey(sid);
          }
        }
      } catch {
        // fall through to raw string normalization
      }
    }
    return normalizeSpaceSnapshotKey(trimmed);
  } catch {
    return INBOX_SNAPSHOT_BUCKET_KEY;
  }
}

function makeSpaceRuntimeContext(spaceKey: string): ActiveSpaceRuntimeContext {
  return {
    spaceKey,
    spaceId: spaceKey === INBOX_SNAPSHOT_BUCKET_KEY ? null : spaceKey,
    rootFolderId: null,
    defaultDeckId: null,
    workbenchLayoutPreset: undefined,
  };
}

export const useActiveSpaceContextStore = create<ActiveSpaceContextStore>((set) => ({
  context: makeSpaceRuntimeContext(readInitialActiveSpaceKey()),
  setContext: (context) => set({ context }),
}));

export function getActiveSpaceContext(): ActiveSpaceRuntimeContext {
  return useActiveSpaceContextStore.getState().context;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

let lastMonotonicTimestamp = 0;

function nextMonotonicTimestamp(): number {
  const now = Date.now();
  lastMonotonicTimestamp = now > lastMonotonicTimestamp ? now : lastMonotonicTimestamp + 1;
  return lastMonotonicTimestamp;
}

export function evictOverflowSpaceEntries(
  entries: Record<string, PersistedSpaceWorkbenchEntry>,
  maxEntries: number = MAX_PERSISTED_SPACE_SNAPSHOTS,
  pinnedKey?: string,
): Record<string, PersistedSpaceWorkbenchEntry> {
  const keys = Object.keys(entries);
  if (keys.length <= maxEntries) return entries;

  const next = { ...entries };
  const removable = keys
    .filter((key) => key !== pinnedKey)
    .sort((a, b) => (next[a]?.updatedAt ?? 0) - (next[b]?.updatedAt ?? 0));

  let excess = keys.length - maxEntries;
  for (const key of removable) {
    if (excess <= 0) break;
    delete next[key];
    excess -= 1;
  }
  return next;
}

export function sanitizeSpaceSnapshotsEnvelope(
  input: unknown,
): WorkbenchSpaceSnapshotsEnvelopeV1 | null {
  if (!isRecord(input)) return null;
  const version = input.version;
  if (
    version !== 1 &&
    version !== undefined &&
    !(typeof version === 'number' && Number.isInteger(version) && version > 1)
  ) {
    return null;
  }
  if (!isRecord(input.entries)) return null;

  const activeSpaceKey = normalizeSpaceSnapshotKey(
    typeof input.activeSpaceKey === 'string' ? input.activeSpaceKey : null,
  );

  const sanitizedEntries: Record<string, PersistedSpaceWorkbenchEntry> = {};
  for (const [rawKey, rawEntry] of Object.entries(input.entries)) {
    if (!isRecord(rawEntry)) continue;
    const spaceKey = normalizeSpaceSnapshotKey(
      typeof rawEntry.spaceKey === 'string' ? rawEntry.spaceKey : rawKey,
    );
    const snapshot = sanitizeSnapshot(rawEntry.snapshot);
    if (!snapshot) continue;
    const activeStagePreset: StudyFlowStagePresetId = isValidStagePresetId(
      rawEntry.activeStagePreset,
    )
      ? rawEntry.activeStagePreset
      : 'freeform-desktop';
    const sidecarMode: StudyFlowSidecarKind | undefined = isValidSidecarKind(rawEntry.sidecarMode)
      ? rawEntry.sidecarMode
      : undefined;
    const updatedAt =
      typeof rawEntry.updatedAt === 'number' && Number.isFinite(rawEntry.updatedAt)
        ? rawEntry.updatedAt
        : 0;

    sanitizedEntries[spaceKey] = {
      spaceKey,
      snapshot,
      activeStagePreset,
      ...(sidecarMode !== undefined ? { sidecarMode } : {}),
      updatedAt,
    };
  }

  return {
    version: 1,
    activeSpaceKey,
    entries: evictOverflowSpaceEntries(
      sanitizedEntries,
      MAX_PERSISTED_SPACE_SNAPSHOTS,
      activeSpaceKey,
    ),
  };
}

let spacePersistChain: Promise<void> | null = null;
let cachedEnvelope: WorkbenchSpaceSnapshotsEnvelopeV1 | null | undefined;

function enqueueSpaceOperation<T>(task: () => Promise<T>): Promise<T> {
  const prev = spacePersistChain ?? Promise.resolve();
  const next = prev.then(task, task);
  const voidDone = next.then(
    () => undefined,
    () => undefined,
  );
  spacePersistChain = voidDone;
  void voidDone.finally(() => {
    if (spacePersistChain === voidDone) {
      spacePersistChain = null;
    }
  });
  return next;
}

async function readEnvelopeUnlocked(): Promise<WorkbenchSpaceSnapshotsEnvelopeV1 | null> {
  if (cachedEnvelope !== undefined) return cachedEnvelope;
  try {
    const raw = await readWorkbenchSetting(WORKBENCH_SPACE_SNAPSHOTS_KEY);
    if (raw == null || raw === '') return null;
    const parsed: unknown = JSON.parse(raw);
    cachedEnvelope = sanitizeSpaceSnapshotsEnvelope(parsed);
    return cachedEnvelope;
  } catch (error) {
    console.warn('[workbench] space snapshots read failed:', error);
    return null;
  }
}

async function writeEnvelopeUnlocked(envelope: WorkbenchSpaceSnapshotsEnvelopeV1): Promise<void> {
  // Keep switching usable for this session even when storage is full or unavailable.
  cachedEnvelope = envelope;
  try {
    await writeWorkbenchSetting(WORKBENCH_SPACE_SNAPSHOTS_KEY, JSON.stringify(envelope));
  } catch (error) {
    console.warn('[workbench] space snapshots write failed:', error);
  }
}

export async function loadSpaceSnapshotsEnvelope(): Promise<WorkbenchSpaceSnapshotsEnvelopeV1 | null> {
  return enqueueSpaceOperation(() => readEnvelopeUnlocked());
}

export async function loadSpaceWorkbenchEntry(
  spaceId: ActiveSpaceSelection | undefined,
): Promise<PersistedSpaceWorkbenchEntry | null> {
  const spaceKey = normalizeSpaceSnapshotKey(spaceId);
  const envelope = await loadSpaceSnapshotsEnvelope();
  return envelope?.entries[spaceKey] ?? null;
}

export async function saveSpaceWorkbenchEntry(params: {
  spaceKey: string;
  snapshot: WorkbenchSnapshotV1;
  activeStagePreset: StudyFlowStagePresetId;
  sidecarMode?: StudyFlowSidecarKind;
  nextActiveSpaceKey?: string;
}): Promise<PersistedSpaceWorkbenchEntry | null> {
  const sanitized = sanitizeSnapshot(params.snapshot);
  if (!sanitized) return null;
  const normalizedKey = normalizeSpaceSnapshotKey(params.spaceKey);
  const activeKey = params.nextActiveSpaceKey
    ? normalizeSpaceSnapshotKey(params.nextActiveSpaceKey)
    : normalizedKey;
  const entry: PersistedSpaceWorkbenchEntry = {
    spaceKey: normalizedKey,
    snapshot: sanitized,
    activeStagePreset: params.activeStagePreset,
    sidecarMode: params.sidecarMode ?? null,
    updatedAt: nextMonotonicTimestamp(),
  };

  await enqueueSpaceOperation(async () => {
    const existing = await readEnvelopeUnlocked();
    const mergedEntries = evictOverflowSpaceEntries(
      {
        ...(existing?.entries ?? {}),
        [normalizedKey]: entry,
      },
      MAX_PERSISTED_SPACE_SNAPSHOTS,
      activeKey,
    );
    await writeEnvelopeUnlocked({
      version: 1,
      activeSpaceKey: activeKey,
      entries: mergedEntries,
    });
  });

  return entry;
}

function inferStagePresetFromSnapshot(snapshot: WorkbenchSnapshotV1): StudyFlowStagePresetId {
  const visible = snapshot.windows.filter((w) => !w.minimized);
  const left = visible.find((w) => w.displayMode === 'tiled-left' || w.displayMode === 'tiled-tl');
  const right = visible.find(
    (w) => w.displayMode === 'tiled-right' || w.displayMode === 'tiled-tr',
  );
  if (!left || !right) return 'freeform-desktop';
  if (
    ['files', 'file-preview', 'textbook', 'file', 'media'].includes(left.typeId) &&
    ['notes', 'mindmap'].includes(right.typeId)
  ) {
    return 'deep-reading-map';
  }
  if (['notes', 'mindmap'].includes(left.typeId) && right.typeId === 'chat') {
    return 'note-cocreation';
  }
  if (['flashcards', 'exam'].includes(left.typeId)) {
    return 'practice-correction';
  }
  return 'freeform-desktop';
}

export interface BootSpaceWorkbenchResult {
  spaceKey: string;
  snapshot: WorkbenchSnapshotV1 | null;
  activeStagePreset: StudyFlowStagePresetId;
  sidecarMode: StudyFlowSidecarKind;
  migratedFromLegacy: boolean;
}

/**
 * 桌面冷启动入口：
 * 1. 若 WORKBENCH_SPACE_SNAPSHOTS_KEY 已有 initialSpaceKey 的条目 → 直接返回并同步 stagePresetStore；
 * 2. 若 WORKBENCH_SPACE_SNAPSHOTS_KEY 尚无任何条目 → 回退读取既有 'desktop.workbenchSnapshot'，
 *    写入 entries[initialSpaceKey] 完成无感迁移；
 * 3. 若已有其他空间条目但当前空间尚未保存过 → 返回 snapshot: null。
 */
export async function bootInitialSpaceWorkbench(
  initialSpaceId?: ActiveSpaceSelection,
): Promise<BootSpaceWorkbenchResult> {
  const spaceKey =
    initialSpaceId !== undefined
      ? normalizeSpaceSnapshotKey(initialSpaceId)
      : readInitialActiveSpaceKey();

  const generation = spaceSwitchGeneration;
  useActiveSpaceContextStore.getState().setContext(makeSpaceRuntimeContext(spaceKey));

  const envelope = await loadSpaceSnapshotsEnvelope();
  const existingEntry = envelope?.entries[spaceKey];
  if (existingEntry) {
    if (generation === spaceSwitchGeneration) setStagePresetState(existingEntry.activeStagePreset, existingEntry.sidecarMode ?? null);
    return {
      spaceKey,
      snapshot: existingEntry.snapshot,
      activeStagePreset: existingEntry.activeStagePreset,
      sidecarMode: existingEntry.sidecarMode ?? null,
      migratedFromLegacy: false,
    };
  }

  const hasAnySpaceEntries = Boolean(envelope && Object.keys(envelope.entries).length > 0);
  if (!hasAnySpaceEntries) {
    const legacySnapshot = await loadSnapshot();
    if (legacySnapshot) {
      const inferredStage = inferStagePresetFromSnapshot(legacySnapshot);
      const inferredSidecar = inferredStage === 'deep-reading-map'
        && legacySnapshot.windows.some((win) => !win.minimized && win.displayMode === 'tiled-bl')
        ? 'dual_reader' : null;
      await saveSpaceWorkbenchEntry({
        spaceKey,
        snapshot: legacySnapshot,
        activeStagePreset: inferredStage,
        sidecarMode: inferredSidecar,
        nextActiveSpaceKey: spaceKey,
      });
      if (generation === spaceSwitchGeneration) setStagePresetState(inferredStage, inferredSidecar);
      return {
        spaceKey,
        snapshot: legacySnapshot,
        activeStagePreset: inferredStage,
        sidecarMode: inferredSidecar,
        migratedFromLegacy: true,
      };
    }
  }

  if (generation === spaceSwitchGeneration) setStagePresetState('freeform-desktop', null);
  return {
    spaceKey,
    snapshot: null,
    activeStagePreset: 'freeform-desktop',
    sidecarMode: null,
    migratedFromLegacy: false,
  };
}

/**
 * 注册 snapshot.ts 镜像钩子：每次防抖 saveSnapshot 或 flushSnapshot 写入全局快照时，
 * 同步更新当前活跃空间桶（WORKBENCH_SPACE_SNAPSHOTS_KEY）。
 */
export function installSpaceSnapshotMirror(): () => void {
  const hook = async (snapshot: WorkbenchSnapshotV1): Promise<void> => {
    const { spaceKey } = getActiveSpaceContext();
    const { activeStagePreset, sidecarMode } = getStagePresetState();
    await saveSpaceWorkbenchEntry({
      spaceKey,
      snapshot,
      activeStagePreset,
      sidecarMode,
      nextActiveSpaceKey: spaceKey,
    });
  };
  registerSnapshotMirrorHook(hook);
  return () => {
    unregisterSnapshotMirrorHook(hook);
  };
}

function collectDirtyMinimizedSurvivors(windows: Record<string, WorkbenchWindow>): WorkbenchWindow[] {
  const survivors: WorkbenchWindow[] = [];
  for (const win of Object.values(windows)) {
    const def = appRegistry.get(win.typeId);
    let canSuspend = true;
    if (def?.canSuspend) {
      try {
        const result = def.canSuspend(win.instanceKey);
        if (result === false) {
          canSuspend = false;
        }
      } catch {
        canSuspend = false;
      }
    }
    if (!canSuspend) {
      survivors.push({
        ...win,
        displayMode: win.displayMode.startsWith('tiled-') ? 'floating' : win.displayMode,
        frame:
          win.displayMode.startsWith('tiled-') && win.restoreFrame
            ? { ...win.restoreFrame }
            : { ...win.frame },
        restoreFrame: null,
        minimized: true,
      });
    }
  }
  return survivors;
}

export interface HandleStudySpaceChangedOptions {
  /** Startup has not hydrated the outgoing layout yet. */
  captureOutgoing?: boolean;
  pruneWindows?: (windows: WorkbenchWindow[]) => Promise<WorkbenchWindow[]>;
  isDisposed?: () => boolean;
  onApplied?: (info: { restoredFromSnapshot: boolean; spaceKey: string }) => void;
  setDockPinned?: (pinned: string[]) => void;
}

let spaceSwitchGeneration = 0;
let spaceSwitchPending = false;

export function getSpaceSwitchGeneration(): number {
  return spaceSwitchGeneration;
}

/**
 * 响应 'study-space:changed' 事件的权威协调器：
 * - Step A（同步）：在任何 await 之前立即采集迁出空间的 buildSnapshot() 并入队持久化；
 * - Step B（微任务让位）：更新活跃空间键并 await Promise.resolve()，确保 W03 的异步 preset applier 先行收敛；
 * - Step C（恢复或预设）：若目标空间已有保存窗口则精确恢复 hydrate，否则按 workbenchLayoutPreset 应用阶段预设。
 */
export function handleStudySpaceChanged(
  detail: StudySpaceChangedEventDetail,
  options?: HandleStudySpaceChangedOptions,
): Promise<void> {
  const nextSpaceKey = normalizeSpaceSnapshotKey(detail.spaceId);
  const currentCtx = getActiveSpaceContext();
  const currentSpaceKey = currentCtx.spaceKey;

  if (nextSpaceKey === currentSpaceKey) {
    useActiveSpaceContextStore.getState().setContext({
      spaceKey: nextSpaceKey,
      spaceId: detail.spaceId,
      rootFolderId: detail.rootFolderId ?? null,
      defaultDeckId: detail.defaultDeckId ?? null,
      workbenchLayoutPreset: detail.workbenchLayoutPreset,
    });
    return Promise.resolve();
  }

  // Step A: Synchronous Outgoing Capture (BEFORE any await!)
  cancelPendingSnapshotSave();
  const outgoingSnapshot = spaceSwitchPending || options?.captureOutgoing === false
    ? null : sanitizeSnapshot(buildSnapshot());
  const { activeStagePreset: outgoingStage, sidecarMode: outgoingSidecar } = getStagePresetState();
  const outgoingSavePromise = outgoingSnapshot
    ? saveSpaceWorkbenchEntry({
        spaceKey: currentSpaceKey,
        snapshot: outgoingSnapshot,
        activeStagePreset: outgoingStage,
        sidecarMode: outgoingSidecar,
        nextActiveSpaceKey: nextSpaceKey,
      })
    : Promise.resolve(null);

  // Step B: Switch Active Key & Yield One Microtask
  useActiveSpaceContextStore.getState().setContext({
    spaceKey: nextSpaceKey,
    spaceId: detail.spaceId,
    rootFolderId: detail.rootFolderId ?? null,
    defaultDeckId: detail.defaultDeckId ?? null,
    workbenchLayoutPreset: detail.workbenchLayoutPreset,
  });
  const generation = ++spaceSwitchGeneration;
  spaceSwitchPending = true;
  setSnapshotPersistencePaused(true);

  return (async () => {
    try {
      await Promise.resolve();
      await outgoingSavePromise;
      if (generation !== spaceSwitchGeneration || options?.isDisposed?.()) return;

      const targetEntry = await loadSpaceWorkbenchEntry(nextSpaceKey);
      if (generation !== spaceSwitchGeneration || options?.isDisposed?.()) return;

      cancelPendingSnapshotSave();
      invalidateSnapshotDedupeCache();

      if (targetEntry) {
        const prunedWindows = options?.pruneWindows
          ? await options.pruneWindows(targetEntry.snapshot.windows)
          : targetEntry.snapshot.windows;
        if (generation !== spaceSwitchGeneration || options?.isDisposed?.()) return;

        const dirtySurvivors = collectDirtyMinimizedSurvivors(useWindowStore.getState().windows).filter(
          (dirty) => !prunedWindows.some((w) => w.id === dirty.id),
        );
        setPendingRestoreDesktopSize(targetEntry.snapshot.desktopSize ?? null);
        useWindowStore
          .getState()
          .hydrate([...prunedWindows, ...dirtySurvivors], targetEntry.snapshot.tilingRatios);
        setStagePresetState(targetEntry.activeStagePreset, targetEntry.sidecarMode ?? null);
        options?.setDockPinned?.(targetEntry.snapshot.dockPinned);
        spaceSwitchPending = false;
        setSnapshotPersistencePaused(false);
        saveSnapshot('layout');
        options?.onApplied?.({ restoredFromSnapshot: true, spaceKey: nextSpaceKey });
        return;
      }

      // A new space starts clean, except for unsaved windows which stay mounted.
      const dirtySurvivors = collectDirtyMinimizedSurvivors(useWindowStore.getState().windows);
      setPendingRestoreDesktopSize(null);
      useWindowStore.getState().hydrate(dirtySurvivors, {});

      const mappedStage = mapStudySpacePresetToStagePreset(detail.workbenchLayoutPreset);
      await applyStudyFlowStagePreset(mappedStage, {
        spaceId: detail.spaceId,
        rootFolderId: detail.rootFolderId,
        defaultDeckId: detail.defaultDeckId,
        closeUnmatched: true,
      });
      if (generation !== spaceSwitchGeneration || options?.isDisposed?.()) return;
      spaceSwitchPending = false;
      setSnapshotPersistencePaused(false);
      saveSnapshot('layout');
      options?.onApplied?.({ restoredFromSnapshot: false, spaceKey: nextSpaceKey });
    } finally {
      if (generation === spaceSwitchGeneration) {
        spaceSwitchPending = false;
        setSnapshotPersistencePaused(false);
      }
    }
  })();
}

export function resetSpaceSnapshotsForTests(): void {
  spaceSwitchGeneration = 0;
  lastMonotonicTimestamp = 0;
  spacePersistChain = null;
  cachedEnvelope = undefined;
  spaceSwitchPending = false;
  setSnapshotPersistencePaused(false);
  useActiveSpaceContextStore
    .getState()
    .setContext(makeSpaceRuntimeContext(readInitialActiveSpaceKey()));
}

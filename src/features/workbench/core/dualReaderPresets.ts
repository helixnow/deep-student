/**
 * C7 §2.6 — Workbench Dual-Reader Reference Split Engine
 *
 * Pure layout tree transformations (`applyDualReaderReferenceSplit` &
 * `collapseDualReaderSplit`) on Workbench `PaneNode` trees (`split` / `leaf`)
 * arranging:
 *   Reader A (e.g. Textbook PDF) + Reader B (e.g. Past Exam / Paper PDF or Notes)
 *   + MindMap Convergence Hub
 * in either a balanced 3-column workspace (`'three-column'`) or a left vertical
 * reader stack + right MindMap hub (`'left-stack-right-hub'`), preserving 100%
 * of open tabs across panes and round-tripping cleanly through `spaceSnapshots`.
 */
import type { DisplayMode, Frame, Size, WorkbenchSnapshotV1, WorkbenchWindow } from './types';
import { clampTilingRatio, DEFAULT_TILE_MARGIN, tilingPairKey } from './tiling';
import { readWorkbenchSetting, sanitizeSnapshot, writeWorkbenchSetting } from './snapshot';
import {
  loadSpaceWorkbenchEntry,
  normalizeSpaceSnapshotKey,
  saveSpaceWorkbenchEntry,
  type PersistedSpaceWorkbenchEntry,
} from './spaceSnapshots';

export type PaneRole = 'reader-a' | 'reader-b' | 'mindmap-hub' | 'general';

export type PaneSplitDirection = 'horizontal' | 'vertical';

export type DualReaderArrangement = 'three-column' | 'left-stack-right-hub';

export interface PaneTab {
  id: string;
  typeId: string;
  resourceId?: string | null;
  title: string;
  isPinned?: boolean;
  meta?: Record<string, unknown>;
}

export interface PaneLeafNode {
  kind: 'leaf';
  id: string;
  role?: PaneRole;
  tabs: PaneTab[];
  activeTabId: string | null;
}

export interface PaneSplitNode {
  kind: 'split';
  id: string;
  direction: PaneSplitDirection;
  /** Share of `first` child in (0, 1), clamped to [MIN_TILING_RATIO, MAX_TILING_RATIO]. */
  ratio: number;
  first: PaneNode;
  second: PaneNode;
  presetTag?: 'dual-reader-root' | 'dual-reader-pair';
}

export type PaneNode = PaneLeafNode | PaneSplitNode;

export interface DualReaderSplitOptions {
  /**
   * - `'three-column'`: Reader A | Reader B | MindMap Hub (horizontal 3-column)
   * - `'left-stack-right-hub'`: (Reader A / Reader B vertical stack) | MindMap Hub
   * Default: `'three-column'`.
   */
  arrangement?: DualReaderArrangement;
  /** Explicit tab ID to feature in Reader A leaf. */
  readerATabId?: string;
  /** Explicit tab ID to feature in Reader B leaf. */
  readerBTabId?: string;
  /** Explicit tab ID to feature in MindMap Convergence Hub leaf. */
  mindmapTabId?: string;
  /** Optional seed tab inserted into Reader A if not already open. */
  readerATab?: PaneTab;
  /** Optional seed tab inserted into Reader B if not already open. */
  readerBTab?: PaneTab;
  /** Optional seed tab inserted into MindMap Hub if not already open. */
  mindmapTab?: PaneTab;
  /** Ratio between Reader A and Reader B inside the reader pair (default 0.5). */
  readerSplitRatio?: number;
  /**
   * Ratio of combined Reader A+B space vs MindMap Hub:
   * - `'three-column'` default: `0.66` (Reader A 33% / Reader B 33% / MindMap Hub 34%)
   * - `'left-stack-right-hub'` default: `0.52` (Left reader stack 52% / MindMap Hub 48%)
   */
  hubSplitRatio?: number;
}

export interface CollapseDualReaderOptions {
  /**
   * - `'single-leaf'` (default): collapses into one unified leaf preserving all open tabs.
   * - `'reader-and-hub'`: merges Reader A + Reader B into one left reader leaf while keeping MindMap Hub on the right.
   */
  mode?: 'single-leaf' | 'reader-and-hub';
  /** Optional tab ID to activate after collapsing (if present among open tabs). */
  preferredActiveTabId?: string;
  /** Split ratio when `mode === 'reader-and-hub'` (default 0.48). */
  hubSplitRatio?: number;
}

export const WORKBENCH_DUAL_READER_PANES_KEY = 'desktop.workbenchDualReaderPanes.v1' as const;
export const DEFAULT_THREE_COLUMN_HUB_SPLIT_RATIO = 0.66;
export const DEFAULT_LEFT_STACK_HUB_SPLIT_RATIO = 0.52;
export const DEFAULT_READER_PAIR_SPLIT_RATIO = 0.5;

const MINDMAP_TYPE_IDS = new Set(['mindmap']);
const PRIMARY_READER_TYPE_IDS = new Set([
  'pdf',
  'textbook',
  'file-preview',
  'file',
  'epub',
  'media',
]);
const SECONDARY_REFERENCE_TYPE_IDS = new Set([
  'exam',
  'qbank',
  'notes',
  'note',
  'pdf',
  'file-preview',
  'textbook',
  'epub',
]);

const VALID_ROLES = new Set<PaneRole>(['reader-a', 'reader-b', 'mindmap-hub', 'general']);
const VALID_DIRECTIONS = new Set<PaneSplitDirection>(['horizontal', 'vertical']);
const VALID_PRESET_TAGS = new Set<NonNullable<PaneSplitNode['presetTag']>>([
  'dual-reader-root',
  'dual-reader-pair',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function cloneTab(tab: PaneTab): PaneTab {
  return {
    id: tab.id,
    typeId: tab.typeId,
    ...(tab.resourceId !== undefined ? { resourceId: tab.resourceId } : {}),
    title: tab.title,
    ...(tab.isPinned !== undefined ? { isPinned: tab.isPinned } : {}),
    ...(tab.meta ? { meta: { ...tab.meta } } : {}),
  };
}

function resolveValidActiveTabId(
  tabs: readonly PaneTab[],
  candidates: readonly (string | null | undefined)[],
): string | null {
  if (tabs.length === 0) return null;
  const tabIds = new Set(tabs.map((t) => t.id));
  for (const candidate of candidates) {
    if (candidate && tabIds.has(candidate)) {
      return candidate;
    }
  }
  return tabs[0]?.id ?? null;
}

/** Collects all leaf nodes in deterministic left-to-right / top-to-bottom pre-order. */
export function collectPaneLeaves(node: PaneNode): PaneLeafNode[] {
  if (node.kind === 'leaf') {
    return [node];
  }
  return [...collectPaneLeaves(node.first), ...collectPaneLeaves(node.second)];
}

/** Collects all unique open tabs across the entire `PaneNode` tree in pre-order. */
export function collectPaneTabs(node: PaneNode): PaneTab[] {
  const seen = new Set<string>();
  const out: PaneTab[] = [];
  for (const leaf of collectPaneLeaves(node)) {
    for (const tab of leaf.tabs) {
      if (!seen.has(tab.id)) {
        seen.add(tab.id);
        out.push(cloneTab(tab));
      }
    }
  }
  return out;
}

/** Checks whether `node` is currently structured as a 3-pane Dual-Reader + MindMap Hub split. */
export function isDualReaderSplit(node: PaneNode): node is PaneSplitNode {
  if (node.kind !== 'split' || node.direction !== 'horizontal') return false;
  if (node.second.kind !== 'leaf' || node.first.kind !== 'split') return false;
  if (node.first.first.kind !== 'leaf' || node.first.second.kind !== 'leaf') return false;
  if (node.presetTag === 'dual-reader-root') return true;
  return (
    node.first.first.role === 'reader-a' &&
    node.first.second.role === 'reader-b' &&
    node.second.role === 'mindmap-hub'
  );
}

/** Detects the current Dual-Reader arrangement if `node` is a Dual-Reader split, else `null`. */
export function getDualReaderArrangement(node: PaneNode): DualReaderArrangement | null {
  if (!isDualReaderSplit(node) || node.first.kind !== 'split') return null;
  return node.first.direction === 'vertical' ? 'left-stack-right-hub' : 'three-column';
}

interface IndexedTabOrigin {
  tab: PaneTab;
  leafIndex: number;
  leafRole: PaneRole | undefined;
  wasActive: boolean;
}

function collectIndexedTabOrigins(root: PaneNode, seedTabs: readonly (PaneTab | undefined)[]): IndexedTabOrigin[] {
  const leaves = collectPaneLeaves(root);
  const seen = new Set<string>();
  const origins: IndexedTabOrigin[] = [];

  leaves.forEach((leaf, leafIndex) => {
    for (const tab of leaf.tabs) {
      if (!tab?.id || seen.has(tab.id)) continue;
      seen.add(tab.id);
      origins.push({
        tab: cloneTab(tab),
        leafIndex,
        leafRole: leaf.role,
        wasActive: leaf.activeTabId === tab.id,
      });
    }
  });

  for (const seed of seedTabs) {
    if (!seed?.id || seen.has(seed.id)) continue;
    seen.add(seed.id);
    origins.push({
      tab: cloneTab(seed),
      leafIndex: leaves.length,
      leafRole: undefined,
      wasActive: true,
    });
  }

  return origins;
}

function scoreReaderACandidate(origin: IndexedTabOrigin): number {
  let score = 0;
  if (origin.leafRole === 'reader-a') score += 40;
  if (PRIMARY_READER_TYPE_IDS.has(origin.tab.typeId)) score += 25;
  if (origin.tab.typeId === 'textbook' || origin.tab.typeId === 'pdf') score += 10;
  if (origin.wasActive) score += 8;
  if (origin.leafIndex === 0) score += 4;
  return score;
}

function scoreReaderBCandidate(origin: IndexedTabOrigin, readerALeafIndex: number | null): number {
  let score = 0;
  if (origin.leafRole === 'reader-b') score += 40;
  if (SECONDARY_REFERENCE_TYPE_IDS.has(origin.tab.typeId)) score += 22;
  if (origin.tab.typeId === 'exam' || origin.tab.typeId === 'qbank') score += 12;
  if (readerALeafIndex !== null && origin.leafIndex !== readerALeafIndex) score += 10;
  if (origin.wasActive) score += 6;
  return score;
}

/**
 * Pure transformation arranging `root` into a balanced 3-pane workspace:
 * Reader A + Reader B + MindMap Convergence Hub.
 *
 * Guarantees:
 * - Zero input mutation;
 * - 100% of open tabs in `root` (plus any optional seed tabs) are preserved with zero duplicates;
 * - Switching between `'three-column'` and `'left-stack-right-hub'` on an existing dual-reader
 *   tree preserves each pane's exact tab list and active tab.
 */
export function applyDualReaderReferenceSplit(
  root: PaneNode,
  options?: DualReaderSplitOptions,
): PaneSplitNode {
  const arrangement: DualReaderArrangement = options?.arrangement ?? 'three-column';
  const defaultHubRatio =
    arrangement === 'left-stack-right-hub'
      ? DEFAULT_LEFT_STACK_HUB_SPLIT_RATIO
      : DEFAULT_THREE_COLUMN_HUB_SPLIT_RATIO;
  const hubSplitRatio = clampTilingRatio(options?.hubSplitRatio ?? defaultHubRatio);
  const readerSplitRatio = clampTilingRatio(
    options?.readerSplitRatio ?? DEFAULT_READER_PAIR_SPLIT_RATIO,
  );

  const hasExplicitRouting = Boolean(
    options?.readerATabId ||
      options?.readerBTabId ||
      options?.mindmapTabId ||
      options?.readerATab ||
      options?.readerBTab ||
      options?.mindmapTab,
  );

  // Fast lossless re-arrangement when already in a Dual-Reader split without explicit tab overrides.
  if (isDualReaderSplit(root) && !hasExplicitRouting && root.first.kind === 'split') {
    const existingA = root.first.first as PaneLeafNode;
    const existingB = root.first.second as PaneLeafNode;
    const existingHub = root.second as PaneLeafNode;

    const tabsA = existingA.tabs.map(cloneTab);
    const tabsB = existingB.tabs.map(cloneTab);
    const tabsHub = existingHub.tabs.map(cloneTab);

    return {
      kind: 'split',
      id: root.id || 'pane-split-dual-reader-root',
      direction: 'horizontal',
      ratio: hubSplitRatio,
      presetTag: 'dual-reader-root',
      first: {
        kind: 'split',
        id: root.first.id || 'pane-split-dual-readers',
        direction: arrangement === 'left-stack-right-hub' ? 'vertical' : 'horizontal',
        ratio: readerSplitRatio,
        presetTag: 'dual-reader-pair',
        first: {
          kind: 'leaf',
          id: existingA.id || 'pane-leaf-reader-a',
          role: 'reader-a',
          tabs: tabsA,
          activeTabId: resolveValidActiveTabId(tabsA, [existingA.activeTabId]),
        },
        second: {
          kind: 'leaf',
          id: existingB.id || 'pane-leaf-reader-b',
          role: 'reader-b',
          tabs: tabsB,
          activeTabId: resolveValidActiveTabId(tabsB, [existingB.activeTabId]),
        },
      },
      second: {
        kind: 'leaf',
        id: existingHub.id || 'pane-leaf-mindmap-hub',
        role: 'mindmap-hub',
        tabs: tabsHub,
        activeTabId: resolveValidActiveTabId(tabsHub, [existingHub.activeTabId]),
      },
    };
  }

  const origins = collectIndexedTabOrigins(root, [
    options?.readerATab,
    options?.readerBTab,
    options?.mindmapTab,
  ]);

  const explicitAId = options?.readerATabId ?? options?.readerATab?.id;
  const explicitBId = options?.readerBTabId ?? options?.readerBTab?.id;
  const explicitHubId = options?.mindmapTabId ?? options?.mindmapTab?.id;

  const assigned = new Set<string>();
  const readerATabs: PaneTab[] = [];
  const readerBTabs: PaneTab[] = [];
  const mindmapTabs: PaneTab[] = [];

  let preferredActiveA: string | undefined;
  let preferredActiveB: string | undefined;
  let preferredActiveHub: string | undefined;

  // 1. Explicit MindMap Hub selection + all MindMap-typed tabs (unless explicitly pinned to Reader A/B)
  if (explicitHubId) {
    const found = origins.find((o) => o.tab.id === explicitHubId);
    if (found) {
      mindmapTabs.push(found.tab);
      assigned.add(found.tab.id);
      preferredActiveHub = found.tab.id;
    }
  }

  for (const origin of origins) {
    if (assigned.has(origin.tab.id)) continue;
    if (origin.tab.id === explicitAId || origin.tab.id === explicitBId) continue;
    if (MINDMAP_TYPE_IDS.has(origin.tab.typeId) || origin.leafRole === 'mindmap-hub') {
      mindmapTabs.push(origin.tab);
      assigned.add(origin.tab.id);
      if (!preferredActiveHub && origin.wasActive) {
        preferredActiveHub = origin.tab.id;
      }
    }
  }

  // 2. Explicit Reader A & Reader B selections
  let readerAPrimaryOrigin: IndexedTabOrigin | undefined;
  if (explicitAId && !assigned.has(explicitAId)) {
    const found = origins.find((o) => o.tab.id === explicitAId);
    if (found) {
      readerAPrimaryOrigin = found;
      readerATabs.push(found.tab);
      assigned.add(found.tab.id);
      preferredActiveA = found.tab.id;
    }
  }

  let readerBPrimaryOrigin: IndexedTabOrigin | undefined;
  if (explicitBId && !assigned.has(explicitBId)) {
    const found = origins.find((o) => o.tab.id === explicitBId);
    if (found) {
      readerBPrimaryOrigin = found;
      readerBTabs.push(found.tab);
      assigned.add(found.tab.id);
      preferredActiveB = found.tab.id;
    }
  }

  // 3. Automatic Reader A selection if not explicitly resolved
  if (!readerAPrimaryOrigin) {
    const remaining = origins.filter((o) => !assigned.has(o.tab.id));
    if (remaining.length > 0) {
      const sorted = [...remaining].sort(
        (a, b) => scoreReaderACandidate(b) - scoreReaderACandidate(a),
      );
      readerAPrimaryOrigin = sorted[0];
      if (readerAPrimaryOrigin) {
        readerATabs.push(readerAPrimaryOrigin.tab);
        assigned.add(readerAPrimaryOrigin.tab.id);
        preferredActiveA = readerAPrimaryOrigin.tab.id;
      }
    }
  }

  // 4. Automatic Reader B selection if not explicitly resolved
  if (!readerBPrimaryOrigin) {
    const remaining = origins.filter((o) => !assigned.has(o.tab.id));
    if (remaining.length > 0) {
      const aLeafIdx = readerAPrimaryOrigin ? readerAPrimaryOrigin.leafIndex : null;
      const sorted = [...remaining].sort(
        (a, b) => scoreReaderBCandidate(b, aLeafIdx) - scoreReaderBCandidate(a, aLeafIdx),
      );
      readerBPrimaryOrigin = sorted[0];
      if (readerBPrimaryOrigin) {
        readerBTabs.push(readerBPrimaryOrigin.tab);
        assigned.add(readerBPrimaryOrigin.tab.id);
        preferredActiveB = readerBPrimaryOrigin.tab.id;
      }
    }
  }

  // 5. Preserve all remaining open tabs deterministically in their natural pane bucket
  for (const origin of origins) {
    if (assigned.has(origin.tab.id)) continue;
    assigned.add(origin.tab.id);
    if (
      origin.leafRole === 'reader-b' ||
      (readerBPrimaryOrigin &&
        readerAPrimaryOrigin &&
        readerBPrimaryOrigin.leafIndex !== readerAPrimaryOrigin.leafIndex &&
        origin.leafIndex === readerBPrimaryOrigin.leafIndex)
    ) {
      readerBTabs.push(origin.tab);
    } else if (readerATabs.length <= readerBTabs.length) {
      readerATabs.push(origin.tab);
    } else {
      readerBTabs.push(origin.tab);
    }
  }

  const readerALeaf: PaneLeafNode = {
    kind: 'leaf',
    id: 'pane-leaf-reader-a',
    role: 'reader-a',
    tabs: readerATabs,
    activeTabId: resolveValidActiveTabId(readerATabs, [preferredActiveA]),
  };

  const readerBLeaf: PaneLeafNode = {
    kind: 'leaf',
    id: 'pane-leaf-reader-b',
    role: 'reader-b',
    tabs: readerBTabs,
    activeTabId: resolveValidActiveTabId(readerBTabs, [preferredActiveB]),
  };

  const mindmapHubLeaf: PaneLeafNode = {
    kind: 'leaf',
    id: 'pane-leaf-mindmap-hub',
    role: 'mindmap-hub',
    tabs: mindmapTabs,
    activeTabId: resolveValidActiveTabId(mindmapTabs, [preferredActiveHub]),
  };

  return {
    kind: 'split',
    id: 'pane-split-dual-reader-root',
    direction: 'horizontal',
    ratio: hubSplitRatio,
    presetTag: 'dual-reader-root',
    first: {
      kind: 'split',
      id: 'pane-split-dual-readers',
      direction: arrangement === 'left-stack-right-hub' ? 'vertical' : 'horizontal',
      ratio: readerSplitRatio,
      presetTag: 'dual-reader-pair',
      first: readerALeaf,
      second: readerBLeaf,
    },
    second: mindmapHubLeaf,
  };
}

/**
 * Collapses a Dual-Reader split (or general `PaneNode` split tree) back into a single
 * unified leaf (or 2-pane `reader-and-hub` when `options.mode === 'reader-and-hub'`),
 * preserving 100% of open tabs without duplicates.
 */
export function collapseDualReaderSplit(
  root: PaneNode,
  options?: CollapseDualReaderOptions,
): PaneNode {
  const mode = options?.mode ?? 'single-leaf';
  const leaves = collectPaneLeaves(root);

  if (mode === 'reader-and-hub') {
    const readerTabs: PaneTab[] = [];
    const hubTabs: PaneTab[] = [];
    const seen = new Set<string>();
    const readerActiveCandidates: Array<string | null | undefined> = [
      options?.preferredActiveTabId,
    ];
    const hubActiveCandidates: Array<string | null | undefined> = [options?.preferredActiveTabId];

    for (const leaf of leaves) {
      const isHub = leaf.role === 'mindmap-hub';
      if (isHub) {
        hubActiveCandidates.push(leaf.activeTabId);
      } else {
        readerActiveCandidates.push(leaf.activeTabId);
      }
      for (const tab of leaf.tabs) {
        if (seen.has(tab.id)) continue;
        seen.add(tab.id);
        if (isHub) hubTabs.push(cloneTab(tab));
        else readerTabs.push(cloneTab(tab));
      }
    }

    return {
      kind: 'split',
      id: 'pane-split-reader-hub',
      direction: 'horizontal',
      ratio: clampTilingRatio(options?.hubSplitRatio ?? 0.48),
      first: {
        kind: 'leaf',
        id: 'pane-leaf-reader-a',
        role: 'reader-a',
        tabs: readerTabs,
        activeTabId: resolveValidActiveTabId(readerTabs, readerActiveCandidates),
      },
      second: {
        kind: 'leaf',
        id: 'pane-leaf-mindmap-hub',
        role: 'mindmap-hub',
        tabs: hubTabs,
        activeTabId: resolveValidActiveTabId(hubTabs, hubActiveCandidates),
      },
    };
  }

  const mergedTabs = collectPaneTabs(root);
  const activeCandidates: Array<string | null | undefined> = [options?.preferredActiveTabId];
  for (const leaf of leaves) {
    if (leaf.role === 'reader-a' && leaf.activeTabId) {
      activeCandidates.push(leaf.activeTabId);
    }
  }
  for (const leaf of leaves) {
    if (leaf.activeTabId) {
      activeCandidates.push(leaf.activeTabId);
    }
  }

  return {
    kind: 'leaf',
    id: root.kind === 'leaf' && root.id ? root.id : 'pane-leaf-main',
    role: 'general',
    tabs: mergedTabs,
    activeTabId: resolveValidActiveTabId(mergedTabs, activeCandidates),
  };
}

/**
 * Computes exact non-overlapping pixel `Frame`s for every leaf in `root`
 * inside `desktopSize` with outer and inter-pane `margin`.
 */
export function computePaneNodeFrames(
  root: PaneNode,
  desktopSize: Size,
  margin: number = DEFAULT_TILE_MARGIN,
): Record<string, Frame> {
  const m = Math.max(0, margin);
  const outerX = Math.min(m, desktopSize.w / 2);
  const outerY = Math.min(m, desktopSize.h / 2);
  const outer: Frame = {
    x: outerX,
    y: outerY,
    w: Math.max(0, desktopSize.w - m * 2),
    h: Math.max(0, desktopSize.h - m * 2),
  };
  const out: Record<string, Frame> = {};

  const walk = (node: PaneNode, bounds: Frame): void => {
    if (node.kind === 'leaf') {
      out[node.id] = bounds;
      return;
    }
    const r = clampTilingRatio(node.ratio);
    if (node.direction === 'horizontal') {
      const gap = Math.min(m, bounds.w);
      const availW = Math.max(0, bounds.w - gap);
      const firstW = Math.round(availW * r);
      const secondW = Math.max(0, availW - firstW);
      walk(node.first, { x: bounds.x, y: bounds.y, w: firstW, h: bounds.h });
      walk(node.second, {
        x: bounds.x + firstW + gap,
        y: bounds.y,
        w: secondW,
        h: bounds.h,
      });
    } else {
      const gap = Math.min(m, bounds.h);
      const availH = Math.max(0, bounds.h - gap);
      const firstH = Math.round(availH * r);
      const secondH = Math.max(0, availH - firstH);
      walk(node.first, { x: bounds.x, y: bounds.y, w: bounds.w, h: firstH });
      walk(node.second, {
        x: bounds.x,
        y: bounds.y + firstH + gap,
        w: bounds.w,
        h: secondH,
      });
    }
  };

  walk(root, outer);
  return out;
}

function sanitizePaneTab(raw: unknown): PaneTab | null {
  if (!isRecord(raw)) return null;
  if (typeof raw.id !== 'string' || !raw.id.trim()) return null;
  if (typeof raw.typeId !== 'string' || !raw.typeId.trim()) return null;
  const title = typeof raw.title === 'string' ? raw.title : '';
  const resourceId: string | undefined =
    typeof raw.resourceId === 'string' ? raw.resourceId : undefined;
  const isPinned = typeof raw.isPinned === 'boolean' ? raw.isPinned : undefined;
  const meta = isRecord(raw.meta) ? { ...raw.meta } : undefined;

  return {
    id: raw.id.trim(),
    typeId: raw.typeId.trim(),
    ...(resourceId !== undefined ? { resourceId } : {}),
    title,
    ...(isPinned !== undefined ? { isPinned } : {}),
    ...(meta ? { meta } : {}),
  };
}

/** Validates and whitelist-sanitizes an arbitrary JSON payload into a clean `PaneNode` tree. */
export function sanitizePaneNode(input: unknown, maxDepth = 12): PaneNode | null {
  const seenTabIds = new Set<string>();

  const visit = (raw: unknown, depth: number): PaneNode | null => {
    if (depth > maxDepth || !isRecord(raw)) return null;
    if (typeof raw.id !== 'string' || !raw.id.trim()) return null;

    if (raw.kind === 'leaf') {
      if (!Array.isArray(raw.tabs)) return null;
      const tabs: PaneTab[] = [];
      for (const item of raw.tabs) {
        const tab = sanitizePaneTab(item);
        if (!tab || seenTabIds.has(tab.id)) continue;
        seenTabIds.add(tab.id);
        tabs.push(tab);
      }
      const role = VALID_ROLES.has(raw.role as PaneRole) ? (raw.role as PaneRole) : undefined;
      const requestedActive = typeof raw.activeTabId === 'string' ? raw.activeTabId : null;
      return {
        kind: 'leaf',
        id: raw.id.trim(),
        ...(role ? { role } : {}),
        tabs,
        activeTabId: resolveValidActiveTabId(tabs, [requestedActive]),
      };
    }

    if (raw.kind === 'split') {
      if (!VALID_DIRECTIONS.has(raw.direction as PaneSplitDirection)) return null;
      if (typeof raw.ratio !== 'number' || !Number.isFinite(raw.ratio)) return null;
      const first = visit(raw.first, depth + 1);
      const second = visit(raw.second, depth + 1);
      if (!first || !second) return null;
      const presetTag = VALID_PRESET_TAGS.has(
        raw.presetTag as NonNullable<PaneSplitNode['presetTag']>,
      )
        ? (raw.presetTag as NonNullable<PaneSplitNode['presetTag']>)
        : undefined;
      return {
        kind: 'split',
        id: raw.id.trim(),
        direction: raw.direction as PaneSplitDirection,
        ratio: clampTilingRatio(raw.ratio),
        first,
        second,
        ...(presetTag ? { presetTag } : {}),
      };
    }

    return null;
  };

  return visit(input, 0);
}

/** Serializes a `PaneNode` tree into a canonical JSON string. */
export function serializePaneTree(root: PaneNode): string {
  const clean = sanitizePaneNode(root);
  if (!clean) {
    throw new TypeError('Cannot serialize invalid PaneNode tree');
  }
  return JSON.stringify(clean);
}

/** Safely parses and sanitizes a serialized `PaneNode` JSON string, returning `null` on bad input. */
export function deserializePaneTree(raw: string | null | undefined): PaneNode | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  try {
    return sanitizePaneNode(JSON.parse(raw));
  } catch {
    return null;
  }
}

export interface BuildDualReaderSnapshotOptions {
  desktopSize?: Size;
  margin?: number;
  dockPinned?: string[];
  /** Optional unrelated minimized background windows to preserve in the snapshot. */
  minimizedWindows?: readonly WorkbenchWindow[];
}

/**
 * Projects a `PaneNode` layout tree into a canonical `WorkbenchSnapshotV1`
 * compatible with `sanitizeSnapshot()` and `spaceSnapshots.ts`.
 */
export function buildDualReaderWorkbenchSnapshot(
  root: PaneNode,
  options?: BuildDualReaderSnapshotOptions,
): WorkbenchSnapshotV1 {
  const desktopSize: Size = options?.desktopSize ?? { w: 1600, h: 900 };
  const margin = options?.margin ?? DEFAULT_TILE_MARGIN;
  const frames = computePaneNodeFrames(root, desktopSize, margin);
  const arrangement = getDualReaderArrangement(root);
  const leaves = collectPaneLeaves(root);

  const windows: WorkbenchWindow[] = [];
  const tilingRatios: Record<string, number> = {};

  if (root.kind === 'split') {
    tilingRatios[`pane:${root.id}`] = clampTilingRatio(root.ratio);
    if (root.first.kind === 'split') {
      tilingRatios[`pane:${root.first.id}`] = clampTilingRatio(root.first.ratio);
    }
    if (arrangement === 'left-stack-right-hub' && root.first.kind === 'split') {
      tilingRatios['v'] = clampTilingRatio(root.ratio);
      tilingRatios['h-left'] = clampTilingRatio(root.first.ratio);
    }
  }

  let zCursor = 10;
  leaves.forEach((leaf) => {
    const activeTab =
      leaf.tabs.find((t) => t.id === leaf.activeTabId) ?? leaf.tabs[0] ?? null;
    const defaultTypeId =
      leaf.role === 'mindmap-hub' ? 'mindmap' : leaf.role === 'reader-b' ? 'notes' : 'file-preview';
    const frame = frames[leaf.id] ?? { x: 40, y: 40, w: 480, h: 560 };

    let displayMode: DisplayMode = 'floating';
    if (arrangement === 'left-stack-right-hub') {
      if (leaf.role === 'reader-a') displayMode = 'tiled-tl';
      else if (leaf.role === 'reader-b') displayMode = 'tiled-bl';
      else if (leaf.role === 'mindmap-hub') displayMode = 'tiled-right';
    } else if (root.kind === 'split' && leaves.length === 2) {
      displayMode = leaf === leaves[0] ? 'tiled-left' : 'tiled-right';
    }

    zCursor += 1;
    windows.push({
      id: `wb_${leaf.id}`,
      typeId: activeTab?.typeId ?? defaultTypeId,
      instanceKey: activeTab?.resourceId ?? activeTab?.id ?? null,
      title: activeTab?.title ?? leaf.id,
      frame: { ...frame },
      restoreFrame: { ...frame },
      displayMode,
      minimized: false,
      zIndex: zCursor,
      createdAt: 1000 + zCursor,
      lastFocusedAt: 2000 + zCursor,
    });
  });

  if (leaves.length === 2 && root.kind === 'split') {
    tilingRatios[tilingPairKey(`wb_${leaves[0]!.id}`, `wb_${leaves[1]!.id}`)] = clampTilingRatio(
      root.ratio,
    );
  }

  if (options?.minimizedWindows) {
    for (const bg of options.minimizedWindows) {
      if (windows.some((w) => w.id === bg.id)) continue;
      windows.push({
        ...bg,
        minimized: true,
        displayMode: bg.displayMode.startsWith('tiled-') ? 'floating' : bg.displayMode,
      });
    }
  }

  const rawSnapshot: WorkbenchSnapshotV1 = {
    version: 1,
    windows,
    dockPinned: options?.dockPinned ? [...options.dockPinned] : [],
    tilingRatios,
    desktopSize: { ...desktopSize },
  };

  return sanitizeSnapshot(rawSnapshot) ?? rawSnapshot;
}

interface DualReaderPaneEnvelopeV1 {
  version: 1;
  treesBySpace: Record<string, PaneNode>;
}

async function readDualReaderPaneEnvelope(): Promise<DualReaderPaneEnvelopeV1> {
  try {
    const raw = await readWorkbenchSetting(WORKBENCH_DUAL_READER_PANES_KEY);
    if (!raw) return { version: 1, treesBySpace: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || !isRecord(parsed.treesBySpace)) {
      return { version: 1, treesBySpace: {} };
    }
    const treesBySpace: Record<string, PaneNode> = {};
    for (const [key, rawTree] of Object.entries(parsed.treesBySpace)) {
      const clean = sanitizePaneNode(rawTree);
      if (clean) {
        treesBySpace[normalizeSpaceSnapshotKey(key)] = clean;
      }
    }
    return { version: 1, treesBySpace };
  } catch {
    return { version: 1, treesBySpace: {} };
  }
}

/**
 * Persists a Dual-Reader `PaneNode` workspace (all panes, ratios, and open tabs)
 * alongside its canonical `spaceSnapshots` entry for `spaceId`.
 */
export async function saveDualReaderSpaceSnapshot(
  spaceId: string | null | undefined,
  root: PaneNode,
  options?: BuildDualReaderSnapshotOptions,
): Promise<PersistedSpaceWorkbenchEntry | null> {
  const sanitizedTree = sanitizePaneNode(root);
  if (!sanitizedTree) return null;

  const spaceKey = normalizeSpaceSnapshotKey(spaceId);
  const snapshot = buildDualReaderWorkbenchSnapshot(sanitizedTree, options);

  const envelope = await readDualReaderPaneEnvelope();
  envelope.treesBySpace[spaceKey] = sanitizedTree;
  await writeWorkbenchSetting(WORKBENCH_DUAL_READER_PANES_KEY, JSON.stringify(envelope));

  return saveSpaceWorkbenchEntry({
    spaceKey,
    snapshot,
    activeStagePreset: isDualReaderSplit(sanitizedTree) ? 'deep-reading-map' : 'freeform-desktop',
    sidecarMode: isDualReaderSplit(sanitizedTree) ? 'dual_reader' : null,
    nextActiveSpaceKey: spaceKey,
  });
}

/**
 * Loads both the `spaceSnapshots` entry and the lossless `PaneNode` tab tree for `spaceId`.
 * Reconstructs a fallback `PaneNode` tree from `entry.snapshot` if only the window snapshot exists.
 */
export async function loadDualReaderSpaceSnapshot(
  spaceId: string | null | undefined,
): Promise<{
  spaceKey: string;
  entry: PersistedSpaceWorkbenchEntry | null;
  paneTree: PaneNode | null;
}> {
  const spaceKey = normalizeSpaceSnapshotKey(spaceId);
  const [entry, envelope] = await Promise.all([
    loadSpaceWorkbenchEntry(spaceId),
    readDualReaderPaneEnvelope(),
  ]);

  const savedTree = envelope.treesBySpace[spaceKey] ?? null;
  if (savedTree) {
    return { spaceKey, entry, paneTree: savedTree };
  }

  if (!entry || entry.snapshot.windows.length === 0) {
    return { spaceKey, entry, paneTree: null };
  }

  const visible = entry.snapshot.windows.filter((w) => !w.minimized);
  const fallbackTabs: PaneTab[] = visible.map((win) => ({
    id: win.id,
    typeId: win.typeId,
    resourceId: win.instanceKey,
    title: win.title,
  }));

  const baseLeaf: PaneLeafNode = {
    kind: 'leaf',
    id: 'pane-leaf-main',
    role: 'general',
    tabs: fallbackTabs,
    activeTabId: fallbackTabs[0]?.id ?? null,
  };

  const hasLeftStack =
    visible.some((w) => w.displayMode === 'tiled-tl') &&
    visible.some((w) => w.displayMode === 'tiled-bl') &&
    visible.some((w) => w.displayMode === 'tiled-right');

  const paneTree = hasLeftStack
    ? applyDualReaderReferenceSplit(baseLeaf, {
        arrangement: 'left-stack-right-hub',
        hubSplitRatio: entry.snapshot.tilingRatios['v'],
        readerSplitRatio: entry.snapshot.tilingRatios['h-left'],
      })
    : baseLeaf;

  return { spaceKey, entry, paneTree };
}

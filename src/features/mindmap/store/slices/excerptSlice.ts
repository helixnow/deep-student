/**
 * mindmapStore slice：摘录入图与知识汇聚中枢（MarginNote 5 式学习流，W08 + C7 §3）。
 *
 * 涵盖：
 * 1. 待整理池（Staging Tray）：暂存、归入选中节点、拖拽上树、移除与清空（全单步 Cmd+Z）；
 * 2. 复合摘录卡片（Compound Excerpt Card）：多源摘录槽（excerpts[]）、个人批注（cardNote）、展开态；
 * 3. 双热区原子入图（Merge vs Child）：每次入图只走一次 applyMutation；
 * 4. 归纳总结大括号 `}`（Summary Braces）：同父兄弟区间创建、改名与删除；
 * 5. 节点一键闪卡投影（isFlashcard）与分支矿物语义色反向广播。
 */

import { nanoid } from 'nanoid';
import i18next from 'i18next';
import type { ExcerptDragPayload, SemanticAnchor } from '@/ui-kernel/contracts/interop';
import type { MindMapNode, MindMapSummaryBrace } from '../../types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { findNodeById } from '../../utils/node/find';
import {
  appendExcerptImage,
  appendExcerptQuote,
  appendExcerptSlot,
  buildExcerptSlotFromPayload,
  buildStagingExcerptFromPayload,
  distillExcerpt,
  hasExplicitAutoExcerptTarget,
  resolveAutoExcerptParent,
  resolveExcerptPlacement,
  stagingExcerptToDragPayload,
  syncMindMapAnchorEdges,
  upsertNodeAnchorEdges,
  type IngestExcerptOptions,
} from '../../utils/excerptIngest';
import {
  dedupeSemanticAnchors,
  safeSerializeAnchor,
  sanitizeCardNote,
} from '../../utils/nodeAnchors';
import {
  resolveSiblingRangeForSummary,
  sanitizeSummaryLabel,
} from '../../utils/summaryBraces';
import { reconcileMindMapProjectedFlashcards } from '../../interop/mindmapCardProjection';
import { MAX_MINDMAP_DEPTH, MAX_MINDMAP_NODES, countNodes } from '../mindmapStoreHelpers';
import type { MindMapSliceCreator } from '../mindmapStoreRuntime';

/** 入场标记保留时长：--mm-agent-enter-ms(260ms) + 余量，之后自动清除 */
const EXCERPT_ENTERING_CLEAR_MS = 700;
/** 合并高亮保留时长：--mm-agent-updated-ms(900ms) + 余量 */
const EXCERPT_UPDATED_CLEAR_MS = 1100;

export const createExcerptSlice: MindMapSliceCreator<
  | 'ingestExcerpt'
  | 'ingestAutoExcerpt'
  | 'stageExcerpt'
  | 'commitStagingExcerpt'
  | 'removeStagingExcerpt'
  | 'clearStagingExcerpts'
  | 'appendNodeAnchor'
  | 'removeNodeAnchor'
  | 'removeNodeExcerptSlot'
  | 'setNodeCardNote'
  | 'toggleNodeExpandedCard'
  | 'toggleNodeFlashcard'
  | 'addSummaryBrace'
  | 'updateSummaryBrace'
  | 'removeSummaryBrace'
> = (_set, get, rt) => {
  const { applyMutation } = rt;

  const scheduleFlagClear = (nodeId: string, kind: 'entering' | 'updated') => {
    setTimeout(() => {
      const state = get();
      if (kind === 'entering' && state.agentEnteringIds.has(nodeId)) {
        state.clearAgentEntering([nodeId]);
      }
      if (kind === 'updated' && state.agentUpdatedIds.has(nodeId)) {
        state.clearAgentUpdated([nodeId]);
      }
    }, kind === 'entering' ? EXCERPT_ENTERING_CLEAR_MS : EXCERPT_UPDATED_CLEAR_MS);
  };

  const removeStagedEntryInDraft = (
    doc: { stagingExcerpts?: Array<{ id: string }> },
    stagingId: string | undefined,
  ) => {
    if (!stagingId || !doc.stagingExcerpts?.length) return;
    doc.stagingExcerpts = doc.stagingExcerpts.filter((item) => item.id !== stagingId);
    if (doc.stagingExcerpts.length === 0) {
      delete doc.stagingExcerpts;
    }
  };

  const ingestExcerptInternal = (
    payload: ExcerptDragPayload,
    options: IngestExcerptOptions,
    removeStagingId?: string,
  ): string | null => {
    const before = get();
    if (before.reciteMode) return null;
    const placement = resolveExcerptPlacement(before.document.root, options, {
      viewRootId: before.viewRootId,
      maxDepth: MAX_MINDMAP_DEPTH,
    });
    if (!placement) return null;

    const distilled = distillExcerpt(payload, {
      regionDefaultTitle: i18next.t('mn5.regionExcerptDefaultTitle', { ns: 'mindmap' }),
    });
    const slot = buildExcerptSlotFromPayload(payload, distilled);

    if (placement.kind === 'merge') {
      let merged = false;
      applyMutation(
        (state) => {
          const node = findNodeById(state.document.root, placement.nodeId);
          if (!node) return;
          removeStagedEntryInDraft(state.document, removeStagingId);
          node.anchors = dedupeSemanticAnchors(node.anchors, [payload.anchor]);
          node.excerpts = appendExcerptSlot(node.excerpts, slot);
          if (node.excerpts.length >= 2 && node.isExpandedCard === undefined) {
            node.isExpandedCard = true;
          }
          if (!node.text.trim()) {
            node.text = distilled.text;
            const quote = distilled.excerptQuote
              ? appendExcerptQuote(node.excerptQuote, distilled.excerptQuote)
              : node.excerptQuote;
            if (quote) node.excerptQuote = quote;
          } else {
            const quote = appendExcerptQuote(node.excerptQuote, payload.text || distilled.text);
            if (quote) node.excerptQuote = quote;
          }
          if (distilled.imageAssetId && !node.imageAssetId) {
            node.imageAssetId = distilled.imageAssetId;
          }
          const images = appendExcerptImage(node.images, distilled.image);
          if (images) node.images = images;
          merged = true;
        },
        { coalesceKey: null },
      );
      if (!merged) return null;
      const after = get();
      after.markAgentUpdated([placement.nodeId]);
      scheduleFlagClear(placement.nodeId, 'updated');
      upsertNodeAnchorEdges(
        after.mindmapId,
        findNodeById(after.document.root, placement.nodeId),
        { root: after.document.root, styleId: after.styleId },
      );
      reconcileMindMapProjectedFlashcards(after.mindmapId, after.document.root);
      return placement.nodeId;
    }

    if (countNodes(before.document.root) >= MAX_MINDMAP_NODES) {
      showGlobalNotification('warning', i18next.t('store.nodeCountExceeded', { ns: 'mindmap' }));
      return null;
    }

    const newNode: MindMapNode = {
      id: `node_${nanoid(10)}`,
      text: distilled.text,
      children: [],
      anchors: [payload.anchor],
      excerpts: [slot],
      ...(distilled.excerptQuote ? { excerptQuote: distilled.excerptQuote } : {}),
      ...(distilled.imageAssetId ? { imageAssetId: distilled.imageAssetId } : {}),
      ...(distilled.image ? { images: [distilled.image] } : {}),
    };

    let inserted = false;
    applyMutation(
      (state) => {
        const parent = findNodeById(state.document.root, placement.parentId);
        if (!parent) return;
        removeStagedEntryInDraft(state.document, removeStagingId);
        if (parent.collapsed) parent.collapsed = false;
        const index = Math.max(0, Math.min(placement.index, parent.children.length));
        parent.children.splice(index, 0, newNode);
        state.focusedNodeId = newNode.id;
        state.selection = [];
        state.selectionAnchorId = null;
        state.lastExcerptContext = { parentId: parent.id, createdId: newNode.id };
        // 与焦点同一提交写入视口跟随请求：画布在同一帧内判定是否需要平移
        state.excerptRevealRequest = {
          nodeId: newNode.id,
          nonce: (state.excerptRevealRequest?.nonce ?? 0) + 1,
        };
        inserted = true;
      },
      { coalesceKey: null },
    );
    if (!inserted) return null;

    const after = get();
    after.markAgentEntering([newNode.id]);
    scheduleFlagClear(newNode.id, 'entering');
    upsertNodeAnchorEdges(after.mindmapId, newNode, {
      root: after.document.root,
      styleId: after.styleId,
    });
    reconcileMindMapProjectedFlashcards(after.mindmapId, after.document.root);
    return newNode.id;
  };

  const stageExcerpt = (payload: ExcerptDragPayload): string | null => {
    const before = get();
    if (before.reciteMode) return null;
    const existing = before.document.stagingExcerpts ?? [];
    const dup = existing.find(
      (item) =>
        item.anchorUri === payload.anchorUri &&
        item.text.trim() === payload.text.trim() &&
        (item.imageDataUrl ?? '') === (payload.imageDataUrl ?? ''),
    );
    if (dup) {
      before.setStagingTrayOpen(true);
      return dup.id;
    }

    const staged = buildStagingExcerptFromPayload(payload, {
      regionDefaultTitle: i18next.t('mn5.regionExcerptDefaultTitle', { ns: 'mindmap' }),
    });
    applyMutation(
      (state) => {
        if (!state.document.stagingExcerpts) {
          state.document.stagingExcerpts = [];
        }
        state.document.stagingExcerpts.push(staged);
        state.stagingTrayOpen = true;
      },
      { coalesceKey: null },
    );
    return staged.id;
  };

  return {
    ingestExcerpt: (payload, options) => ingestExcerptInternal(payload, options),

    stageExcerpt,

    ingestAutoExcerpt: (payload: ExcerptDragPayload) => {
      const state = get();
      if (state.reciteMode) return null;
      const selectionContext = {
        focusedNodeId: state.focusedNodeId,
        selection: state.selection,
        viewRootId: state.viewRootId,
        lastExcerptContext: state.lastExcerptContext,
      };
      if (
        state.excerptIntakeMode === 'staging' ||
        !hasExplicitAutoExcerptTarget(state.document.root, selectionContext)
      ) {
        return stageExcerpt(payload);
      }
      const targetNodeId = resolveAutoExcerptParent(state.document.root, selectionContext);
      return ingestExcerptInternal(payload, { mode: 'child', targetNodeId });
    },

    commitStagingExcerpt: (stagingId: string, options?: IngestExcerptOptions) => {
      const state = get();
      if (state.reciteMode) return null;
      const item = state.document.stagingExcerpts?.find((entry) => entry.id === stagingId);
      if (!item) return null;
      const payload = stagingExcerptToDragPayload(item);
      if (!payload) return null;

      const resolvedOptions: IngestExcerptOptions = options ?? {
        mode: 'child',
        targetNodeId: resolveAutoExcerptParent(state.document.root, {
          focusedNodeId: state.focusedNodeId,
          selection: state.selection,
          viewRootId: state.viewRootId,
          lastExcerptContext: state.lastExcerptContext,
        }),
      };
      return ingestExcerptInternal(payload, resolvedOptions, stagingId);
    },

    removeStagingExcerpt: (stagingId: string) => {
      const state = get();
      if (!state.document.stagingExcerpts?.some((entry) => entry.id === stagingId)) return;
      applyMutation(
        (draft) => {
          removeStagedEntryInDraft(draft.document, stagingId);
        },
        { coalesceKey: null },
      );
    },

    clearStagingExcerpts: () => {
      const state = get();
      if (!state.document.stagingExcerpts?.length) return;
      applyMutation(
        (draft) => {
          delete draft.document.stagingExcerpts;
        },
        { coalesceKey: null },
      );
    },

    appendNodeAnchor: (nodeId: string, anchor: SemanticAnchor) => {
      if (!safeSerializeAnchor(anchor)) return;
      const node = findNodeById(get().document.root, nodeId);
      if (!node) return;
      const next = dedupeSemanticAnchors(node.anchors, [anchor]);
      if (next.length === (node.anchors?.length ?? 0)) return;
      applyMutation(
        (state) => {
          const live = findNodeById(state.document.root, nodeId);
          if (live) live.anchors = next;
        },
        { coalesceKey: null },
      );
      const after = get();
      upsertNodeAnchorEdges(
        after.mindmapId,
        findNodeById(after.document.root, nodeId),
        { root: after.document.root, styleId: after.styleId },
      );
      reconcileMindMapProjectedFlashcards(after.mindmapId, after.document.root);
    },

    removeNodeAnchor: (nodeId: string, anchorUri: string) => {
      const node = findNodeById(get().document.root, nodeId);
      if (!node) return;
      const nextAnchors = (node.anchors ?? []).filter(
        (anchor) => safeSerializeAnchor(anchor) !== anchorUri,
      );
      const nextSlots = (node.excerpts ?? []).filter(
        (slot) => safeSerializeAnchor(slot.anchor) !== anchorUri,
      );
      const anchorsChanged = nextAnchors.length !== (node.anchors?.length ?? 0);
      const slotsChanged = nextSlots.length !== (node.excerpts?.length ?? 0);
      if (!anchorsChanged && !slotsChanged) return;

      applyMutation(
        (state) => {
          const live = findNodeById(state.document.root, nodeId);
          if (!live) return;
          if (nextAnchors.length > 0) live.anchors = nextAnchors;
          else delete live.anchors;
          if (nextSlots.length > 0) live.excerpts = nextSlots;
          else delete live.excerpts;
        },
        { coalesceKey: null },
      );
      const after = get();
      syncMindMapAnchorEdges(after.mindmapId, after.document.root, { styleId: after.styleId });
      reconcileMindMapProjectedFlashcards(after.mindmapId, after.document.root);
    },

    removeNodeExcerptSlot: (nodeId: string, slotId: string) => {
      const node = findNodeById(get().document.root, nodeId);
      if (!node?.excerpts?.length) return;
      const removedSlot = node.excerpts.find((slot) => slot.id === slotId);
      if (!removedSlot) return;
      const nextSlots = node.excerpts.filter((slot) => slot.id !== slotId);
      const removedUri = safeSerializeAnchor(removedSlot.anchor);
      const uriStillUsed =
        removedUri != null &&
        nextSlots.some((slot) => safeSerializeAnchor(slot.anchor) === removedUri);

      applyMutation(
        (state) => {
          const live = findNodeById(state.document.root, nodeId);
          if (!live) return;
          if (nextSlots.length > 0) live.excerpts = nextSlots;
          else delete live.excerpts;
          if (removedUri && !uriStillUsed && live.anchors?.length) {
            const nextAnchors = live.anchors.filter(
              (anchor) => safeSerializeAnchor(anchor) !== removedUri,
            );
            if (nextAnchors.length > 0) live.anchors = nextAnchors;
            else delete live.anchors;
          }
        },
        { coalesceKey: null },
      );
      const after = get();
      syncMindMapAnchorEdges(after.mindmapId, after.document.root, { styleId: after.styleId });
      reconcileMindMapProjectedFlashcards(after.mindmapId, after.document.root);
    },

    setNodeCardNote: (nodeId: string, cardNote: string | undefined) => {
      const node = findNodeById(get().document.root, nodeId);
      if (!node) return;
      const cleaned = sanitizeCardNote(cardNote);
      if (cleaned === node.cardNote) return;
      applyMutation(
        (state) => {
          const live = findNodeById(state.document.root, nodeId);
          if (!live) return;
          if (cleaned) live.cardNote = cleaned;
          else delete live.cardNote;
        },
        { coalesceKey: `cardNote:${nodeId}` },
      );
      const after = get();
      reconcileMindMapProjectedFlashcards(after.mindmapId, after.document.root);
    },

    toggleNodeExpandedCard: (nodeId: string, expanded?: boolean) => {
      const node = findNodeById(get().document.root, nodeId);
      if (!node) return;
      const current = node.isExpandedCard ?? (node.excerpts?.length ?? 0) >= 2;
      const next = expanded ?? !current;
      if (node.isExpandedCard === next) return;
      applyMutation(
        (state) => {
          const live = findNodeById(state.document.root, nodeId);
          if (live) live.isExpandedCard = next;
        },
        { coalesceKey: `cardExpand:${nodeId}` },
      );
    },

    toggleNodeFlashcard: (nodeId: string, enabled?: boolean) => {
      const node = findNodeById(get().document.root, nodeId);
      if (!node) return false;
      const next = enabled ?? !(node.isFlashcard === true);
      if ((node.isFlashcard === true) === next) return next;
      applyMutation(
        (state) => {
          const live = findNodeById(state.document.root, nodeId);
          if (!live) return;
          if (next) live.isFlashcard = true;
          else delete live.isFlashcard;
        },
        { coalesceKey: null },
      );
      const after = get();
      reconcileMindMapProjectedFlashcards(after.mindmapId, after.document.root);
      return next;
    },

    addSummaryBrace: (nodeIds?: readonly string[], label?: string) => {
      const state = get();
      if (state.reciteMode) return null;
      const candidateIds = nodeIds ?? state.selection;
      const range = resolveSiblingRangeForSummary(state.document.root, candidateIds);
      if (!range) return null;

      const defaultLabel = i18next.t('mn5.summaryDefaultLabel', { ns: 'mindmap' });
      const resolvedLabel = sanitizeSummaryLabel(label, defaultLabel);

      const existing = state.document.summaries?.find(
        (item) =>
          item.parentId === range.parentId &&
          item.startChildId === range.startChildId &&
          item.endChildId === range.endChildId,
      );
      if (existing) {
        if (label !== undefined && sanitizeSummaryLabel(label, existing.label) !== existing.label) {
          applyMutation(
            (draft) => {
              const live = draft.document.summaries?.find((s) => s.id === existing.id);
              if (live) live.label = sanitizeSummaryLabel(label, existing.label);
            },
            { coalesceKey: null },
          );
        }
        return existing.id;
      }

      const summary: MindMapSummaryBrace = {
        id: `summary_${nanoid(10)}`,
        parentId: range.parentId,
        startChildId: range.startChildId,
        endChildId: range.endChildId,
        label: resolvedLabel,
      };
      applyMutation(
        (draft) => {
          if (!draft.document.summaries) {
            draft.document.summaries = [];
          }
          draft.document.summaries.push(summary);
        },
        { coalesceKey: null },
      );
      return summary.id;
    },

    updateSummaryBrace: (id: string, label: string) => {
      const existing = get().document.summaries?.find((item) => item.id === id);
      if (!existing) return;
      const nextLabel = sanitizeSummaryLabel(label, '');
      if (nextLabel === existing.label) return;
      applyMutation(
        (draft) => {
          const live = draft.document.summaries?.find((item) => item.id === id);
          if (live) live.label = nextLabel;
        },
        { coalesceKey: `summary:${id}` },
      );
    },

    removeSummaryBrace: (id: string) => {
      if (!get().document.summaries?.some((item) => item.id === id)) return;
      applyMutation(
        (draft) => {
          if (!draft.document.summaries) return;
          draft.document.summaries = draft.document.summaries.filter((item) => item.id !== id);
          if (draft.document.summaries.length === 0) {
            delete draft.document.summaries;
          }
        },
        { coalesceKey: null },
      );
    },
  };
};

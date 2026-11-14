/**
 * 思维导图子树 → 结构化精读讲义一键导出（C7 §2.3 & §3.2）
 *
 * 将选中节点（或多选节点）编译为保留全部 `ds-anchor://v1/...` 出处胶囊的
 * Markdown 精读讲义，自动落入导图所在学习空间 VFS 文件夹、同步反向引用边，并在分屏打开。
 */

import { invoke } from '@tauri-apps/api/core';
import type { DstuNode } from '@/dstu';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import type { AnchorEdgeUpsertInput, ExcerptContentKind } from '@/ui-kernel/contracts/interop';
import {
  compileMindMapSubtreeToHandout,
  type CompiledHandoutResult,
  type HandoutMindMapNodeInput,
  type HandoutNodeExcerptSlot,
} from '@/ui-kernel/services/mindmapHandoutBridge';
import type { MindMapExcerptSlot, MindMapNode } from '../types';

function mapSlotKindToExcerptKind(kind: MindMapExcerptSlot['kind']): ExcerptContentKind {
  switch (kind) {
    case 'image':
      return 'region-image';
    case 'media':
      return 'transcript-cue';
    default:
      return 'text';
  }
}

export function toHandoutMindMapNodeInput(node: MindMapNode): HandoutMindMapNodeInput {
  const mappedSlots: HandoutNodeExcerptSlot[] | undefined = node.excerpts?.map((slot) => ({
    id: slot.id,
    excerptKind: mapSlotKindToExcerptKind(slot.kind),
    text: slot.text,
    imageDataUrl: slot.imageDataUrl,
    imageAssetId: slot.imageAssetId,
    sourceTitle: slot.sourceTitle,
    anchor: slot.anchor,
  }));

  return {
    id: node.id,
    text: node.text,
    note: node.note,
    cardNote: node.cardNote,
    excerptQuote: node.excerptQuote,
    imageAssetId: node.imageAssetId,
    images: node.images,
    anchors: node.anchors,
    excerpts: mappedSlots,
    children: node.children.map(toHandoutMindMapNodeInput),
  };
}

function sanitizeHandoutNoteName(raw: string, fallback: string): string {
  const singleLine = raw
    .replace(/\r\n?/g, ' ')
    // eslint-disable-next-line no-control-regex -- intentionally strip ASCII control characters from handout note name
    .replace(/[/\\:*?"<>|\u0000-\u001f]/g, ' ')
    .replace(/\.\.+/g, '.')
    .replace(/\s+/g, ' ')
    .trim();
  const base = singleLine || fallback;
  return base.length > 72 ? base.slice(0, 72).trim() : base;
}

export interface ExportSubtreeHandoutParams {
  nodes: MindMapNode[];
  mindmapId?: string | null;
  mindmapTitle?: string;
  defaultNoteSuffix?: string;
}

export interface ExportSubtreeHandoutOutcome {
  noteId: string;
  noteTitle: string;
  compiled: CompiledHandoutResult;
}

export async function exportMindMapSelectionToHandoutNote(
  params: ExportSubtreeHandoutParams,
): Promise<ExportSubtreeHandoutOutcome> {
  const selected = new Map(params.nodes.filter(Boolean).map((node) => [node.id, node]));
  const descendantIds = new Set<string>();
  const visit = (node: MindMapNode) => {
    for (const child of node.children) {
      descendantIds.add(child.id);
      visit(child);
    }
  };
  for (const node of selected.values()) visit(node);
  const validNodes = [...selected.values()].filter((node) => !descendantIds.has(node.id));
  if (validNodes.length === 0) {
    throw new Error('未选择要导出为讲义的思维导图节点');
  }

  const suffix = (params.defaultNoteSuffix ?? '精读讲义').trim() || '精读讲义';
  const rawRootInput: HandoutMindMapNodeInput =
    validNodes.length === 1
      ? toHandoutMindMapNodeInput(validNodes[0]!)
      : {
          id: 'handout_selection_root',
          text: `${(params.mindmapTitle ?? '').trim() || '思维导图'} · ${suffix}`,
          children: validNodes.map(toHandoutMindMapNodeInput),
        };

  const baseTitleSource =
    validNodes.length === 1
      ? `${validNodes[0]!.text || params.mindmapTitle || '导图'} · ${suffix}`
      : rawRootInput.text;
  const noteTitle = sanitizeHandoutNoteName(baseTitleSource, suffix);

  const compiled = compileMindMapSubtreeToHandout(rawRootInput, {
    mindmapId: params.mindmapId ?? undefined,
    mindmapTitle: params.mindmapTitle,
    baseHeadingLevel: 1,
    maxHeadingLevel: 4,
    includeMindMapNodeBacklinks: Boolean(params.mindmapId),
  });

  let folderId: string | null = null;
  if (params.mindmapId) {
    try {
      const loc = await invoke<{ folderId?: string | null }>('dstu_get_resource_location', {
        resourceId: params.mindmapId,
      });
      if (loc && typeof loc.folderId === 'string' && loc.folderId.startsWith('fld_')) {
        folderId = loc.folderId;
      }
    } catch {
      // Unsaved or root-level mindmap; fall back to root folder cleanly.
    }
  }

  const dstuModule = await import('@/dstu');
  const sanitizeFn =
    typeof dstuModule.sanitizeName === 'function'
      ? dstuModule.sanitizeName
      : (name: string) => sanitizeHandoutNoteName(name, suffix);
  const finalName = sanitizeFn(noteTitle) || suffix;

  const createResponse = await dstuModule.dstu.create('/', {
    type: 'note',
    name: finalName,
    content: compiled.markdown,
    metadata: folderId ? { folderId } : {},
  });

  let createdNode: DstuNode;
  if (createResponse && typeof createResponse === 'object' && 'ok' in createResponse) {
    if (!createResponse.ok) {
      const errMessage =
        createResponse.error?.toUserMessage?.() ??
        createResponse.error?.message ??
        '生成精读讲义失败';
      throw new Error(errMessage);
    }
    createdNode = createResponse.value;
  } else {
    createdNode = createResponse as unknown as DstuNode;
  }

  const noteId = createdNode?.id;
  if (!noteId) {
    throw new Error('生成精读讲义未返回有效笔记标识');
  }

  const kernel = getAppKernel();
  if (kernel?.anchors) {
    const noteEdges: AnchorEdgeUpsertInput[] = compiled.provenanceLinks
      .filter((link) => !(link.anchor.kind === 'note' && link.anchor.resourceId === noteId))
      .map((link) => ({
        sourceKind: 'note',
        sourceResourceId: noteId,
        sourceSubId: link.sectionHeading ? `sec_${link.lineNumber}` : undefined,
        sourceAnchor: {
          kind: 'note',
          resourceId: noteId,
          heading: link.sectionHeading,
          label: finalName,
        },
        sourceLabel: link.sectionHeading || finalName,
        targetAnchor: link.anchor,
      }));
    if (noteEdges.length > 0) {
      try {
        await kernel.anchors.upsertAnchorEdges(noteEdges);
      } catch {
        // Non-blocking provenance edge sync.
      }
    }
    try {
      await kernel.anchors.reveal(
        {
          kind: 'note',
          resourceId: noteId,
          label: finalName,
        },
        { splitIfClosed: true, pulse: false },
      );
    } catch {
      // Non-blocking reveal.
    }
  }

  return {
    noteId,
    noteTitle: finalName,
    compiled,
  };
}

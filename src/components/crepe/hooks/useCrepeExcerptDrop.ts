/**
 * Crepe 语义锚点点击拦截 + 跨工作区摘录拖放（DS_EXCERPT_MIME）Hook
 *
 * - 拦截编辑器内 `ds-anchor://v1/...` 链接点击并路由到 AnchorRegistry（只读态同样生效）；
 * - 可编辑态注册 `DS_EXCERPT_MIME` 拖放目标，上传内联摘录图片到 VFS，插入带引文标注的引用块，
 *   并在锚点图谱中写入/更新关联边。
 */

import { useEffect } from 'react';
import type React from 'react';
import type { Crepe } from '@milkdown/crepe';
import { parserCtx } from '@milkdown/kit/core';
import { Slice } from '@milkdown/prose/model';
import i18next from 'i18next';
import { vfsFileApi } from '@/api/vfsFileApi';
import { getAppKernel } from '@/ui-kernel/bootstrap';
import {
  formatAnchorShortLocator,
  isSemanticAnchorUri,
  type ExcerptDragPayload,
  type NoteSemanticAnchor,
} from '@/ui-kernel/contracts/interop';
import type { useOptionalUiKernel } from '@/ui-kernel/react';
import { debugLog } from '../../../debug-panel/debugMasterSwitch';
import { canEditCrepeView } from '../commandRegistry';
import { withCrepeEditorView, type EditorViewRef } from '../crepeViewAccess';

type OptionalUiKernel = ReturnType<typeof useOptionalUiKernel>;

export interface UseCrepeExcerptDropOptions {
  isReady: boolean;
  readonly: boolean;
  containerRef: React.RefObject<HTMLDivElement | null>;
  crepeRef: React.RefObject<Crepe | null>;
  viewRef: EditorViewRef;
  noteIdRef: React.RefObject<string | undefined>;
  readonlyRef: React.RefObject<boolean>;
  reviewLeasesRef: React.RefObject<Set<symbol>>;
  uiKernel: OptionalUiKernel;
  uiKernelRef: React.RefObject<OptionalUiKernel>;
}

const escapeMarkdownBrackets = (text: string): string =>
  text.replace(/\[/g, '\\[').replace(/\]/g, '\\]');

async function resolveExcerptImageUrl(imageDataUrl: string): Promise<string> {
  const trimmed = imageDataUrl.trim();
  if (!trimmed.startsWith('data:image/')) return trimmed;
  const match = /^data:(image\/[A-Za-z0-9.+-]+);base64,([\s\S]+)$/.exec(trimmed);
  if (!match) return trimmed;
  try {
    const uploaded = await vfsFileApi.upload({
      name: `excerpt_${Date.now()}.png`,
      mimeType: match[1],
      base64Content: match[2],
      fileType: 'image',
    });
    if (uploaded?.sourceId) {
      return `vfs://${uploaded.sourceId}`;
    }
  } catch {
    // Fallback to inline data URL when VFS IPC is unavailable in isolated tests.
  }
  return trimmed;
}

export function useCrepeExcerptDrop({
  isReady,
  readonly,
  containerRef,
  crepeRef,
  viewRef,
  noteIdRef,
  readonlyRef,
  reviewLeasesRef,
  uiKernel,
  uiKernelRef,
}: UseCrepeExcerptDropOptions): void {
  // Intercept clicks on `ds-anchor://v1/...` links and route to AnchorRegistry (<50ms reveal).
  useEffect(() => {
    if (!isReady) return;
    const container = containerRef.current;
    if (!container) return;

    const onAnchorClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0) return;
      if (!(event.target instanceof Element)) return;
      const link = event.target.closest('a[href]');
      const href = link?.getAttribute('href')?.trim();
      if (!href || !isSemanticAnchorUri(href)) return;
      event.preventDefault();
      event.stopPropagation();
      const kernel = uiKernelRef.current ?? getAppKernel();
      void kernel.anchors.reveal(href, { splitIfClosed: true, pulse: true });
    };

    container.addEventListener('click', onAnchorClick, true);
    return () => {
      container.removeEventListener('click', onAnchorClick, true);
    };
  }, [isReady, containerRef, uiKernelRef]);

  // Register `DS_EXCERPT_MIME` drop target when editable to insert cited Markdown + record anchor edge.
  useEffect(() => {
    if (!isReady || readonly) return;
    const container = containerRef.current;
    if (!container) return;

    const kernel = uiKernel ?? getAppKernel();

    const handleExcerptDrop = async (payload: ExcerptDragPayload, event: DragEvent) => {
      if (readonlyRef.current || reviewLeasesRef.current.size > 0) return;
      const crepe = crepeRef.current;
      if (!crepe) return;

      const dropCoords = { left: event.clientX, top: event.clientY };
      const title = payload.sourceTitle || payload.anchor.label || '';
      const locator = formatAnchorShortLocator(payload.anchor);
      const rawLabel =
        title && locator && title !== locator
          ? `${title} \u00b7 ${locator}`
          : title || locator || payload.anchor.resourceId;
      const escapedLabel = escapeMarkdownBrackets(rawLabel);

      let markdown: string;
      if (payload.imageDataUrl) {
        const imageUrl = await resolveExcerptImageUrl(payload.imageDataUrl);
        const prefix = i18next.t('notes:inlineCards.excerpt_source_prefix');
        const bodyText = payload.text?.trim();
        const quoteLines = bodyText && bodyText !== rawLabel
          ? `${bodyText.split(/\r?\n/).map((line) => (line ? `> ${line}` : '>')).join('\n')}\n> \u2014 ${prefix} [${escapedLabel}](${payload.anchorUri})`
          : `> \u2014 ${prefix} [${escapedLabel}](${payload.anchorUri})`;
        markdown = `![](${imageUrl})\n\n${quoteLines}\n`;
      } else {
        const bodySource = (payload.text || rawLabel).trim();
        const quoted = bodySource
          .split(/\r?\n/)
          .map((line) => (line ? `> ${line}` : '>'))
          .join('\n');
        markdown = `${quoted}\n> \u2014 [${escapedLabel}](${payload.anchorUri})\n`;
      }

      let insertedBlockId: string | undefined;
      try {
        withCrepeEditorView(crepe, viewRef, (view, ctx) => {
          if (!ctx || !canEditCrepeView(view)) return;
          const parsed = ctx.get(parserCtx)(markdown);
          if (!parsed || parsed.content.size === 0) return;

          const hit = view.posAtCoords(dropCoords);
          const rawPos = Math.max(
            0,
            Math.min(hit?.pos ?? view.state.selection.from, view.state.doc.content.size),
          );
          const $pos = view.state.doc.resolve(rawPos);
          let replaceFrom = rawPos;
          let replaceTo = rawPos;
          if ($pos.depth >= 1) {
            if ($pos.depth === 1 && $pos.parent.isTextblock && $pos.parent.content.size === 0) {
              replaceFrom = $pos.before(1);
              replaceTo = $pos.after(1);
            } else {
              replaceFrom = $pos.after(1);
              replaceTo = replaceFrom;
            }
          }

          const tr = view.state.tr.replace(
            replaceFrom,
            replaceTo,
            new Slice(parsed.content, 0, 0),
          );
          const mappedStart = tr.mapping.map(replaceFrom, 1);
          view.dispatch(tr.scrollIntoView());
          view.focus();

          const $inserted = view.state.doc.resolve(
            Math.min(mappedStart, view.state.doc.content.size),
          );
          const rootNode = $inserted.depth >= 1 ? $inserted.node(1) : view.state.doc.nodeAt(replaceFrom);
          const rawBlockId = (rootNode?.attrs as Record<string, unknown> | undefined)?.dsBlockId;
          if (typeof rawBlockId === 'string' && rawBlockId) {
            insertedBlockId = rawBlockId;
          }
        });
      } catch (err) {
        debugLog.error('[CrepeEditor] Excerpt drop insertion failed:', err);
        return;
      }

      const currentNoteId = noteIdRef.current?.trim();
      if (currentNoteId) {
        const sourceAnchor: NoteSemanticAnchor = {
          kind: 'note',
          resourceId: currentNoteId,
          ...(insertedBlockId ? { blockId: insertedBlockId } : {}),
        };
        const activeKernel = uiKernelRef.current ?? getAppKernel();
        void activeKernel.anchors.upsertAnchorEdges([
          {
            sourceKind: 'note',
            sourceResourceId: currentNoteId,
            sourceSubId: insertedBlockId ?? '',
            sourceAnchor,
            sourceLabel: (payload.text || rawLabel).slice(0, 120),
            targetAnchor: payload.anchor,
          },
        ]);
      }
    };

    return kernel.dnd.registerExcerptDropTarget(
      container,
      (payload, event) => {
        void handleExcerptDrop(payload, event);
      },
      {
        canAccept: () => !readonlyRef.current && reviewLeasesRef.current.size === 0,
      },
    );
  }, [isReady, readonly, uiKernel, containerRef, crepeRef, viewRef, noteIdRef, readonlyRef, reviewLeasesRef, uiKernelRef]);
}

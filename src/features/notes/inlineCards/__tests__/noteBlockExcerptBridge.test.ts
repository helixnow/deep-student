import { describe, expect, it, vi } from 'vitest';
import { WB_RESOURCE_MIME } from '@/features/workbench/hooks/useDesktopDrop';
import {
  DS_EXCERPT_MIME,
  parseSemanticAnchor,
  serializeSemanticAnchor,
} from '@/ui-kernel/contracts/interop';
import { AnchorRegistry } from '@/ui-kernel/services/anchors';
import { ExcerptDndHub } from '@/ui-kernel/services/excerpt-dnd';
import {
  buildNoteBlockExcerptPayload,
  buildNoteBlockSemanticAnchor,
  emitNoteBlockAutoExcerpt,
  registerNoteBlockRevealHandler,
  startNoteBlockExcerptDrag,
} from '../noteBlockExcerptBridge';

describe('noteBlockExcerptBridge (Note Block DS_EXCERPT_MIME & Reveal Bridge)', () => {
  it('packages a Milkdown block into a clean NoteSemanticAnchor and ExcerptDragPayload without block-id comments', () => {
    const anchor = buildNoteBlockSemanticAnchor({
      noteId: 'note_bio_101',
      blockId: 'blk_9f8a12',
      headingPath: ['# 第二章 细胞工程', '## 2.1 植物体细胞杂交'],
      noteTitle: '生物选修三笔记',
    });
    expect(anchor).toEqual({
      kind: 'note',
      resourceId: 'note_bio_101',
      blockId: 'blk_9f8a12',
      heading: '第二章 细胞工程 > 2.1 植物体细胞杂交',
      label: '生物选修三笔记 · 2.1 植物体细胞杂交',
    });

    const payload = buildNoteBlockExcerptPayload({
      noteId: 'note_bio_101',
      blockId: 'blk_9f8a12',
      headingPath: ['第二章 细胞工程', '2.1 植物体细胞杂交'],
      noteTitle: '生物选修三笔记',
      markdownText: '原生质体融合可用聚乙二醇（PEG）诱导 <!-- ds:block-id=blk_9f8a12 -->',
      createdAt: 1700000123000,
    });
    expect(payload).not.toBeNull();
    expect(payload!.text).toBe('原生质体融合可用聚乙二醇（PEG）诱导');
    expect(payload!.anchorUri).toContain('ds-anchor://v1/note/note_bio_101');
    expect(payload!.anchorUri).toContain('block=blk_9f8a12');
    expect(parseSemanticAnchor(payload!.anchorUri)).toEqual(anchor);
  });

  it('writes DS_EXCERPT_MIME without touching WB_RESOURCE_MIME and fans out over Auto-Excerpt bus', () => {
    const dnd = new ExcerptDndHub();
    const dataMap = new Map<string, string>();
    const fakeEvent = {
      dataTransfer: {
        setData: (mime: string, val: string) => {
          dataMap.set(mime, val);
        },
        effectAllowed: 'none',
      } as unknown as DataTransfer,
    };

    const dragged = startNoteBlockExcerptDrag(
      fakeEvent,
      {
        noteId: 'note_chem',
        blockId: 'blk_eq1',
        headingPath: ['化学平衡', '勒夏特列原理'],
        noteTitle: '化学原理精要',
        markdownText: '改变影响平衡的一个条件，平衡就向着能够减弱这种改变的方向移动。',
      },
      dnd,
    );

    expect(dragged).not.toBeNull();
    expect(dataMap.has(DS_EXCERPT_MIME)).toBe(true);
    expect(dataMap.has(WB_RESOURCE_MIME)).toBe(false);
    expect(dataMap.get('text/uri-list')).toBe(dragged!.anchorUri);
    expect(dataMap.get('text/plain')).toContain(dragged!.anchorUri);

    const autoReceived: string[] = [];
    const dispose = dnd.subscribeAutoExcerpt((p) => autoReceived.push(p.text));
    emitNoteBlockAutoExcerpt(
      {
        noteId: 'note_chem',
        blockId: 'blk_eq2',
        markdownText: '催化剂同等程度改变正逆反应速率。',
      },
      dnd,
    );
    expect(autoReceived).toEqual(['催化剂同等程度改变正逆反应速率。']);
    dispose();
  });

  it('reveals exact Note blockId with pulse in <50ms and falls back to leaf heading when blockId misses', async () => {
    const registry = new AnchorRegistry();
    const materializeFullDocument = vi.fn();
    const focusBlock = vi.fn((blockId: string) => blockId === 'blk_target');
    const pulseBlock = vi.fn();
    const scrollToHeading = vi.fn();

    const dispose = registerNoteBlockRevealHandler(
      {
        noteId: 'note_phys',
        isFocused: () => true,
        materializeFullDocument,
        focusBlock,
        pulseBlock,
        scrollToHeading,
      },
      registry,
    );

    const exactUri = serializeSemanticAnchor({
      kind: 'note',
      resourceId: 'note_phys',
      blockId: 'blk_target',
      heading: '动量守恒 > 完全非弹性碰撞',
    });
    const res1 = await registry.reveal(exactUri, { pulse: true });
    expect(res1.ok).toBe(true);
    expect(res1.outcome).toBe('revealed-in-open-pane');
    expect(res1.elapsedMs).toBeLessThan(50);
    expect(materializeFullDocument).toHaveBeenCalledTimes(1);
    expect(focusBlock).toHaveBeenCalledWith('blk_target');
    expect(pulseBlock).toHaveBeenCalledWith('blk_target');
    expect(scrollToHeading).not.toHaveBeenCalled();

    // Fallback to leaf heading when blockId is missing/renamed
    const fallbackUri = serializeSemanticAnchor({
      kind: 'note',
      resourceId: 'note_phys',
      blockId: 'blk_deleted',
      heading: '动量守恒 > 完全非弹性碰撞',
    });
    const res2 = await registry.reveal(fallbackUri, { pulse: true });
    expect(res2.ok).toBe(true);
    expect(scrollToHeading).toHaveBeenCalledWith('完全非弹性碰撞');

    dispose();
  });
});

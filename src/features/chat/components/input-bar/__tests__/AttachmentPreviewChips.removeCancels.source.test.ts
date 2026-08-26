/**
 * chip 删除路径 source 契约（0824 Wave2-C R4 · chip 路径对齐）
 *
 * 契约分两层，方向相反，务必分开读：
 *
 * 【第一组 · 基线 af0be136 即绿】chip 层保持"薄"：
 * - AttachmentPreviewChips 的 X 删除只调 onRemove(attachment.id)，
 *   不 import / 不调用 cancelPdfProcessing，也不自己 revokeObjectURL。
 *   取消处理、清 pdfProcessingStore、释放 Blob URL 都是 store 层
 *   (sessionActions.removeAttachment / clearAttachments) 的职责——
 *   chip 里再做一遍就是双重 cancel/revoke，禁止回潮。
 *
 * 【第二组 · 基线 af0be136 预期红，卡 1 落地后转绿】store 层补全取消：
 * - sessionActions 的 removeAttachment / clearAttachments 源码应包含
 *   cancelPdfProcessing（删除处理中的 PDF 附件时通知后端取消，而不是
 *   只清前端状态让后端白跑）。基线上两个 action 只有
 *   usePdfProcessingStore.remove + revokeObjectURL，尚无 cancel 调用，
 *   所以这两条断言在卡 1（sessionActions 删除即取消）落地前是红的——
 *   这是刻意的 TDD 先行，不是测试写错。
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const chipsSource = readFileSync(
  resolve(
    process.cwd(),
    'src/features/chat/components/input-bar/AttachmentPreviewChips.tsx'
  ),
  'utf-8'
);

const sessionActionsSource = readFileSync(
  resolve(process.cwd(), 'src/features/chat/core/store/sessionActions.ts'),
  'utf-8'
);

/** 按锚点切出一个 action 的实现体（锚点漂移时由防空断言兜底） */
const sliceBetween = (source: string, startAnchor: string, endAnchor: string) => {
  const start = source.indexOf(startAnchor);
  const end = source.indexOf(endAnchor, start);
  return { start, end, slice: start > -1 && end > start ? source.slice(start, end) : '' };
};

const removeAttachmentSlice = sliceBetween(
  sessionActionsSource,
  'removeAttachment: (attachmentId: string): void =>',
  'clearAttachments:'
);
const clearAttachmentsSlice = sliceBetween(
  sessionActionsSource,
  'clearAttachments: (): void =>',
  'setPanelState:'
);

describe('AttachmentPreviewChips remove-path source contract', () => {
  it('keeps the structural anchors this contract slices on', () => {
    // 防空断言：锚点漂移时直接红，而不是让切片断言空转通过
    expect(removeAttachmentSlice.start).toBeGreaterThan(-1);
    expect(removeAttachmentSlice.end).toBeGreaterThan(removeAttachmentSlice.start);
    expect(clearAttachmentsSlice.start).toBeGreaterThan(-1);
    expect(clearAttachmentsSlice.end).toBeGreaterThan(clearAttachmentsSlice.start);
  });

  describe('chip layer stays thin (green at baseline af0be136)', () => {
    it('the X button only delegates to onRemove(attachment.id)', () => {
      expect(chipsSource).toContain('onRemove(attachment.id)');
      // 删除是 chip 内嵌按钮，必须先 stopPropagation 挡住外层"点 chip 开预览"
      const removeCallAt = chipsSource.indexOf('onRemove(attachment.id)');
      const stopPropagationBefore = chipsSource.lastIndexOf(
        'event.stopPropagation()',
        removeCallAt
      );
      expect(stopPropagationBefore).toBeGreaterThan(-1);
    });

    it('does not call or import cancelPdfProcessing from the chip', () => {
      // 取消属于 store 层职责；chip 再调一次就是双重 cancel
      expect(chipsSource).not.toContain('cancelPdfProcessing');
      expect(chipsSource).not.toContain('vfsPdfProcessingApi');
    });

    it('does not revoke blob URLs or mutate the processing store from the chip', () => {
      // revoke / store 清理由 sessionActions 统一做，chip 只读 statusMap
      expect(chipsSource).not.toContain('revokeObjectURL');
      expect(chipsSource).not.toContain('usePdfProcessingStore.getState()');
    });

    it('keeps the onRemove prop shape: id in, no attachment object leak', () => {
      expect(chipsSource).toContain('onRemove: (attachmentId: string) => void');
    });
  });

  describe('store layer cancels backend processing on remove (RED until card 1 lands)', () => {
    it('removeAttachment source contains cancelPdfProcessing', () => {
      // 卡 1 落地后应绿：删除单个处理中附件时通知后端取消
      expect(removeAttachmentSlice.slice).toContain('cancelPdfProcessing');
    });

    it('clearAttachments source contains cancelPdfProcessing', () => {
      // 卡 1 落地后应绿：清空附件时批量取消处理中的任务
      expect(clearAttachmentsSlice.slice).toContain('cancelPdfProcessing');
    });

    it('removeAttachment keeps its existing frontend cleanup (regression guard)', () => {
      // 已落地的清理不许被卡 1 顺手删掉：processing store 清 key + blob 释放
      expect(removeAttachmentSlice.slice).toContain(
        'usePdfProcessingStore.getState().remove(attachment.sourceId)'
      );
      expect(removeAttachmentSlice.slice).toContain('URL.revokeObjectURL');
    });
  });
});

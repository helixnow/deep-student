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
 * 【第二组 · 卡 1 已落地（R9 随机制修订）】store 层删除即取消：
 * - 落地形态不是当初设想的内联 cancelPdfProcessing 调用，而是收敛为
 *   模块级包装函数 cancelAttachmentProcessing(attachmentId, sourceId)
 *   （fire-and-forget + 失败日志），removeAttachment / clearAttachments
 *   两个 action 各调用一次。契约因此分两段锁：
 *   a) 两个 action 切片必须调用 cancelAttachmentProcessing；
 *   b) 包装函数定义体内必须真的调用 cancelPdfProcessing 通知后端——
 *      防止包装名还在、后端取消被悄悄挖空。
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

// 包装函数定义体：模块级 function，止于 createSessionActions 工厂声明
const cancelWrapperSlice = sliceBetween(
  sessionActionsSource,
  'function cancelAttachmentProcessing(',
  'export function createSessionActions('
);

describe('AttachmentPreviewChips remove-path source contract', () => {
  it('keeps the structural anchors this contract slices on', () => {
    // 防空断言：锚点漂移时直接红，而不是让切片断言空转通过
    expect(removeAttachmentSlice.start).toBeGreaterThan(-1);
    expect(removeAttachmentSlice.end).toBeGreaterThan(removeAttachmentSlice.start);
    expect(clearAttachmentsSlice.start).toBeGreaterThan(-1);
    expect(clearAttachmentsSlice.end).toBeGreaterThan(clearAttachmentsSlice.start);
    expect(cancelWrapperSlice.start).toBeGreaterThan(-1);
    expect(cancelWrapperSlice.end).toBeGreaterThan(cancelWrapperSlice.start);
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

  describe('store layer cancels backend processing on remove (card 1 landed, R9 updated)', () => {
    it('removeAttachment calls the cancelAttachmentProcessing wrapper', () => {
      // 删除单个处理中附件时经统一包装通知后端取消
      expect(removeAttachmentSlice.slice).toContain('cancelAttachmentProcessing(');
    });

    it('clearAttachments calls the cancelAttachmentProcessing wrapper', () => {
      // 清空附件时逐个经统一包装取消处理中的任务
      expect(clearAttachmentsSlice.slice).toContain('cancelAttachmentProcessing(');
    });

    it('the cancelAttachmentProcessing wrapper itself dispatches cancelPdfProcessing', () => {
      // 契约第二段：包装函数体内必须真调后端取消 API，
      // 否则「action 调了包装」也可能只是空壳（取消被挖空而两段各自为绿）
      expect(cancelWrapperSlice.slice).toContain('cancelPdfProcessing(');
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

/**
 * pdfref:// 回链插件：事件契约
 */

/** document 级事件（复用既有打开机制，勿改名） */
export const PDF_REF_EVENTS = {
  /**
   * 点击 pdfref:// 链接 → 打开 PDF 资源并跳页。
   * detail: { sourceId, pageNumber } —— 与 MarkdownRenderer（聊天 [PDF@id:N]
   * 引用徽章）派发的 pdf-ref:open 同形，WorkbenchEventBridge / ChatV2Page 消费。
   */
  OPEN_PDF_REF: 'pdf-ref:open',
} as const;

export interface PdfRefOpenDetail {
  sourceId: string;
  pageNumber: number;
}

export function dispatchOpenPdfRef(sourceId: string, pageNumber: number): void {
  document.dispatchEvent(
    new CustomEvent<PdfRefOpenDetail>(PDF_REF_EVENTS.OPEN_PDF_REF, {
      detail: { sourceId, pageNumber },
    }),
  );
}

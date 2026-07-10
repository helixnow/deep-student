/**
 * PDF 加载错误分类（pdf.js / WebView 常见错误文案）
 */

export type PdfLoadErrorKind =
  | 'password'
  | 'invalid'
  | 'network'
  | 'unknown';

export interface ClassifiedPdfLoadError {
  kind: PdfLoadErrorKind;
  /** 原始错误信息（用于调试/次要展示） */
  rawMessage: string;
}

export function classifyPdfLoadError(error: unknown): ClassifiedPdfLoadError {
  const rawMessage = error instanceof Error ? error.message : String(error ?? '');
  // pdf.js 异常的 name 比 message 更稳定（PasswordException / InvalidPDFException /
  // MissingPDFException / UnexpectedResponseException），一并纳入匹配
  const errorName = error instanceof Error ? error.name : '';
  const normalized = `${errorName} ${rawMessage}`.toLowerCase();

  if (
    normalized.includes('password') ||
    normalized.includes('encrypt')
  ) {
    return { kind: 'password', rawMessage };
  }

  // 文件取不到 / 流式响应异常：属于路径失效或访问被拒，走"重新关联"引导
  if (
    normalized.includes('missing pdf') ||
    normalized.includes('missingpdf') ||
    normalized.includes('unexpected server response') ||
    normalized.includes('unexpectedresponse') ||
    normalized.includes('network') ||
    normalized.includes('fetch') ||
    normalized.includes('timed out') ||
    normalized.includes('timeout') ||
    normalized.includes('403') ||
    normalized.includes('404')
  ) {
    return { kind: 'network', rawMessage };
  }

  if (
    normalized.includes('invalid pdf') ||
    normalized.includes('invalidpdf') ||
    normalized.includes('corrupt') ||
    normalized.includes('bad xref') ||
    normalized.includes('format error')
  ) {
    return { kind: 'invalid', rawMessage };
  }

  return { kind: 'unknown', rawMessage };
}

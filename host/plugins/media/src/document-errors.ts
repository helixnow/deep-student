/** `dstu-docs/src/document_parser.rs` `ParsingError` and its Display prefixes. */

export type ParsingErrorKind =
  | 'FileNotFound' | 'IoError' | 'UnsupportedFormat' | 'DocxParsingError'
  | 'PdfParsingError' | 'PptxParsingError' | 'EpubParsingError' | 'RtfParsingError'
  | 'ExcelParsingError' | 'Base64DecodingError' | 'FileTooLarge' | 'ZipBombDetected'
  | 'EncryptedDocument' | 'Other';

export const DISPLAY_PREFIX: Record<ParsingErrorKind, string> = {
  FileNotFound: '文件未找到',
  IoError: 'IO错误',
  UnsupportedFormat: '不支持的文件格式',
  DocxParsingError: 'DOCX解析错误',
  PdfParsingError: 'PDF解析错误',
  PptxParsingError: 'PPTX解析错误',
  EpubParsingError: 'EPUB解析错误',
  RtfParsingError: 'RTF解析错误',
  ExcelParsingError: 'Excel解析错误',
  Base64DecodingError: 'Base64解码错误',
  FileTooLarge: '文件过大',
  ZipBombDetected: 'ZIP Bomb检测',
  EncryptedDocument: '文档已加密',
  Other: '其他错误',
};

export class ParsingError extends Error {
  readonly kind: ParsingErrorKind;
  constructor(kind: ParsingErrorKind, detail: string) {
    super(`${DISPLAY_PREFIX[kind]}: ${detail}`);
    this.name = 'ParsingError';
    this.kind = kind;
  }
}

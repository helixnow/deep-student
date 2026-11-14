/**
 * `question_import_service.rs:365 inspect_pdf_text`（`commands.rs:1042`）。
 *
 * `DocumentParser::extract_text_from_base64` 由 L18 `docs` 服务提供；本模块只做
 * 文本归一化、有效字符统计、预览截断与建议判定，文案与 Rust 逐字一致。
 */
export interface PdfTextInspection {
  valid_char_count: number;
  total_char_count: number;
  preview_text: string;
  recommendation: string;
}

/** `count_valid_chars`：字母/数字或 CJK 统一表意文字（含扩展 A）。 */
export function countValidChars(text: string): number {
  let count = 0;
  for (const char of text) {
    if (/\p{L}|\p{N}/u.test(char)) {
      count += 1;
      continue;
    }
    const code = char.codePointAt(0) ?? 0;
    if ((code >= 0x4e00 && code <= 0x9fff) || (code >= 0x3400 && code <= 0x4dbf)) {
      count += 1;
    }
  }
  return count;
}

export function inspectPdfText(extracted: string): PdfTextInspection {
  const normalized = extracted.trim();
  const validCharCount = countValidChars(normalized);
  const totalCharCount = [...normalized].length;
  const recommendation = validCharCount < 100
    ? 'auto_ocr'
    : validCharCount < 500
      ? 'manual_decision'
      : 'use_text';
  return {
    valid_char_count: validCharCount,
    total_char_count: totalCharCount,
    preview_text: [...normalized].slice(0, 800).join(''),
    recommendation,
  };
}

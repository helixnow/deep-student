/**
 * 多图 OCR 的顺序占位回填。
 *
 * 上传时按顺序把「图片识别中 第 x/y 张」占位符插入正文，
 * 单张识别完成后在原位替换为识别文本（失败则移除占位符并收敛空行），
 * 保证最终文本顺序 = 上传顺序，而非 OCR 完成顺序（并发识别会乱序完成）。
 */

/** 把一批占位符按顺序追加到正文末尾（段落分隔） */
export function appendOcrPlaceholders(text: string, placeholders: string[]): string {
  let result = text;
  for (const placeholder of placeholders) {
    result = result ? `${result}\n\n${placeholder}` : placeholder;
  }
  return result;
}

/**
 * 用识别结果原位回填占位符：
 * - replacement 非空 → 原位替换；
 * - replacement 为空（识别失败/无文字）→ 移除占位符并收敛两侧多余空行；
 * - 占位符已被用户手动改动 → 非空结果退回末尾追加，空结果不动正文。
 */
export function fillOcrPlaceholder(text: string, placeholder: string, replacement: string): string {
  const trimmedReplacement = replacement.trim();
  const index = placeholder ? text.indexOf(placeholder) : -1;
  if (index === -1) {
    if (!trimmedReplacement) return text;
    return text ? `${text}\n\n${trimmedReplacement}` : trimmedReplacement;
  }
  if (trimmedReplacement) {
    return text.slice(0, index) + trimmedReplacement + text.slice(index + placeholder.length);
  }
  const before = text.slice(0, index).replace(/\n+$/, '');
  const after = text.slice(index + placeholder.length).replace(/^\n+/, '');
  if (!before) return after;
  if (!after) return before;
  return `${before}\n\n${after}`;
}

/** OCR cache has used both an array of page strings and structured page results. */
export function readPdfOcrText(raw: unknown): ReadonlyMap<number, string> {
  const pages = new Map<number, string>();
  const add = (index: unknown, text: unknown) => {
    if (typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || typeof text !== 'string') return;
    const value = text.trim();
    if (value && value !== '__OCR_FAILED__') pages.set(index + 1, value);
  };
  if (typeof raw !== 'string') return pages;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value)) {
      value.forEach((text, index) => add(index, text));
    } else if (value && typeof value === 'object' && 'pages' in value && Array.isArray(value.pages)) {
      value.pages.forEach((page, index) => {
        if (!page || typeof page !== 'object') return;
        const blocks = Array.isArray(page.blocks)
          ? page.blocks.map((block: { text?: unknown } | null) => typeof block?.text === 'string' ? block.text : '').filter(Boolean).join('\n')
          : '';
        const text = typeof page.text === 'string' && page.text.trim().length >= blocks.trim().length ? page.text : blocks;
        add(page.page_index ?? page.pageIndex ?? index, text);
      });
    }
  } catch { /* An invalid cache is the same as a missing OCR result. */ }
  return pages;
}

/**
 * 引用 → 原文句子高亮：跳到页后在 pdf.js 文本层里找到被引用的片段并闪烁，
 * 学习者看到的是「AI 依据的那句话」，而不只是「那一页」。
 *
 * 匹配：去掉全部空白后比较（中文 PDF 文本层常把一句拆成多个 span，且混入空格/换行）；
 * 取引用开头 24 字（模型摘录与原文尾部常有出入），失败再退到 12 字。
 */
const FLASH_CLASS = 'ds-pdf-quote-flash';
const FLASH_MS = 2400;

const squash = (text: string) => text.replace(/\s+/g, '');

export function findQuoteSpans(spans: readonly HTMLElement[], quote: string): HTMLElement[] {
  const target = squash(quote);
  if (target.length < 4) return [];
  // 拼接文本并记录每个字符所属 span
  let joined = '';
  const owner: number[] = [];
  spans.forEach((span, index) => {
    const text = squash(span.textContent ?? '');
    joined += text;
    for (let i = 0; i < text.length; i += 1) owner.push(index);
  });
  for (const length of [24, 12]) {
    const needle = target.slice(0, Math.min(length, target.length));
    if (needle.length < 4) continue;
    const start = joined.indexOf(needle);
    if (start < 0) continue;
    const end = Math.min(start + target.length, joined.length) - 1;
    const hit = new Set<number>();
    for (let i = start; i <= end; i += 1) hit.add(owner[i]);
    return [...hit].sort((a, b) => a - b).map((index) => spans[index]);
  }
  return [];
}

/** 等待该页文本层出现后闪烁命中片段；返回是否命中（超时 / 未命中返回 false） */
export async function flashQuoteOnPage(root: ParentNode, pageNumber: number, quote: string, timeoutMs = 3000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const page = root.querySelector(`[data-page-number="${pageNumber}"]`);
    const spans = page ? Array.from(page.querySelectorAll<HTMLElement>('.textLayer span, .react-pdf__Page__textContent span')) : [];
    if (spans.length > 0) {
      const hits = findQuoteSpans(spans, quote);
      if (hits.length === 0) return false;
      hits[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
      hits.forEach((span) => span.classList.add(FLASH_CLASS));
      window.setTimeout(() => hits.forEach((span) => span.classList.remove(FLASH_CLASS)), FLASH_MS);
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  return false;
}

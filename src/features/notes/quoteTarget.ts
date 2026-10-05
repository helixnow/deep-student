/**
 * 笔记片段定位：知识库检索命中笔记时只有 chunk 文本，打开笔记后据此滚到命中的块。
 *
 * 索引侧（`vfs/indexing.rs` extract_markdown_text）去掉了图片、代码块、行内代码和强调记号，
 * 按行拼接后按固定窗口切块——片段可能从半行开始；块级记号的正则没开多行模式，
 * 只有全文第一行被去掉，其余行还带着 `## ` / `1. ` / `- [x] ` 等。
 *
 * 打开动作（CHAT_OPEN_ATTACHMENT_PREVIEW / workbench launch）与编辑器挂载是异步的：
 * 先登记挂起请求，编辑器挂载时消费；已挂载的编辑器经事件即时响应。
 * 找不到命中块时静默放弃——笔记照常打开，只是不定位。
 */

export interface NotesQuoteTarget {
  noteId: string;
  quote: string;
}

export const NOTES_QUOTE_TARGET_EVENT = 'notes:quote-target';
/** 挂起请求有效期：笔记没能打开时，不在之后某次打开里重放陈旧的定位 */
export const NOTES_QUOTE_TARGET_TTL_MS = 10_000;
/** 逐行匹配时参与比对的最短行（骨架字符数），「1」「a」这类碎行不作数 */
const MIN_LINE_LENGTH = 4;
const LINE_MARKERS = /^(?:\s*>\s*|\s*(?:#{1,6}|[-*+]|\d{1,9}[.)])\s+|\s*\[[ xX]\]\s+)+/;

const pendingByNoteId = new Map<string, { quote: string; expiresAt: number }>();

export function publishNotesQuoteTarget(request: NotesQuoteTarget): void {
  const quote = request.quote.trim();
  if (!request.noteId || !quote) return;
  pendingByNoteId.set(request.noteId, { quote, expiresAt: Date.now() + NOTES_QUOTE_TARGET_TTL_MS });
  window.dispatchEvent(new CustomEvent<NotesQuoteTarget>(NOTES_QUOTE_TARGET_EVENT, {
    detail: { noteId: request.noteId, quote },
  }));
}

export function consumeNotesQuoteTarget(noteId: string | null | undefined): string | null {
  if (!noteId) return null;
  const pending = pendingByNoteId.get(noteId);
  if (!pending) return null;
  pendingByNoteId.delete(noteId);
  return pending.expiresAt >= Date.now() ? pending.quote : null;
}

export function clearPendingNotesQuoteTargetsForTests(): void {
  pendingByNoteId.clear();
}

/** 只留字母与数字（含中日韩文字）：抹平 Markdown 残留、被去掉的格式记号与空白差异 */
function skeleton(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

/**
 * 在笔记各文本块（文档顺序）里找片段起始所在的块，返回块下标；找不到返回 -1。
 * 整段连续命中最准；片段跨过代码块、行内代码或公式时整段对不上，
 * 改为按片段行序找第一条在全文只出现一次的行，都不唯一就取第一条命中行的首次出现。
 */
export function findQuoteBlockIndex(blockTexts: readonly string[], quote: string): number {
  const lines = quote.split('\n').map((line) => skeleton(line.replace(LINE_MARKERS, '')));
  const starts: number[] = [];
  let doc = '';
  for (const text of blockTexts) {
    starts.push(doc.length);
    doc += skeleton(text);
  }
  if (!doc) return -1;
  const blockAt = (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };

  const whole = lines.join('');
  if (whole.length >= MIN_LINE_LENGTH) {
    const hit = doc.indexOf(whole);
    if (hit >= 0) return blockAt(hit);
  }

  let fallback = -1;
  for (const line of lines) {
    if (line.length < MIN_LINE_LENGTH) continue;
    const first = doc.indexOf(line);
    if (first < 0) continue;
    if (doc.indexOf(line, first + 1) < 0) return blockAt(first);
    if (fallback < 0) fallback = blockAt(first);
  }
  return fallback;
}

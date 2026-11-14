/**
 * `dstu-media/src/media/ledger.rs`: handout Markdown → chapter anchors. The
 * study-ledger SQL tallies stay unmigrated (they need L11 repositories).
 */
import type { MediaChapter, MediaStudyLedger } from '../api.ts';
import type { CardTally, QuestionTally } from '../repository/media-ledger.ts';

/** 去空白、去重，保持首次出现顺序，截到上限 */
export const MAX_LEDGER_RESOURCES = 500;

/** 去掉 `[媒体@…]` 锚点后取标题。 */
export function stripMediaRefs(text: string): string {
  let out = text;
  for (;;) {
    const start = out.indexOf('[媒体@');
    if (start < 0) break;
    const end = out.indexOf(']', start);
    if (end < 0) break;
    out = out.slice(0, start) + out.slice(end + 1);
  }
  return out.trim();
}

/** `mm:ss` / `hh:mm:ss`（各段 1-3 位数字，秒/分必须 < 60）。 */
/** `study_loop/media_source.rs::format_media_clock`：≥1 小时写 h:mm:ss。 */
export function formatMediaClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const mm = String(m).padStart(2, '0');
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}

/** `study_loop/media_source.rs::media_citation`。 */
export function mediaCitation(resourceId: string, seconds: number): string {
  return `[媒体@${resourceId}:${formatMediaClock(seconds)}]`;
}

export function parseClock(raw: string): number | null {
  const parts = raw.trim().split(':');
  const nums: number[] = [];
  for (const part of parts) {
    if (part === '' || part.length > 3 || !/^[0-9]+$/.test(part)) return null;
    const value = Number(part);
    if (value > 0xffff_ffff) return null;
    nums.push(value);
  }
  if (nums.length === 2 && nums[1]! < 60) return nums[0]! * 60 + nums[1]!;
  if (nums.length === 3 && nums[1]! < 60 && nums[2]! < 60) {
    return nums[0]! * 3600 + nums[1]! * 60 + nums[2]!;
  }
  return null;
}

/** 文本里第一个属于本资源的媒体锚点（study_loop/media_source.rs:106）。 */
export function mediaCitationSecondsFor(text: string, resourceId: string): number | null {
  const needle = `[媒体@${resourceId}:`;
  let cursor = text;
  for (;;) {
    const pos = cursor.indexOf(needle);
    if (pos < 0) return null;
    const after = cursor.slice(pos + needle.length);
    const end = after.indexOf(']');
    if (end >= 0) {
      const seconds = parseClock(after.slice(0, end));
      if (seconds !== null) return seconds;
    }
    cursor = after;
  }
}

/** 讲义笔记 Markdown → 章节：每个 `##` 小节标题配其后第一个本课锚点，按时刻排序去重。 */
export function parseHandoutChapters(markdown: string, resourceId: string): MediaChapter[] {
  const chapters: MediaChapter[] = [];
  let pending: string | null = null;
  for (const line of markdown.split('\n')) {
    const trimmed = line.endsWith('\r') ? line.slice(0, -1) : line;
    const text = trimmed.trim();
    if (text.startsWith('## ')) {
      const heading = text.slice(3);
      const title = stripMediaRefs(heading);
      pending = null;
      if (title === '') continue;
      const seconds = mediaCitationSecondsFor(heading, resourceId);
      if (seconds !== null) chapters.push({ title, seconds });
      else pending = title;
      continue;
    }
    if (pending !== null) {
      const seconds = mediaCitationSecondsFor(text, resourceId);
      if (seconds !== null) {
        chapters.push({ title: pending, seconds });
        pending = null;
      }
    }
  }
  chapters.sort((a, b) => a.seconds - b.seconds);
  const seen = new Set<number>();
  return chapters.filter(chapter => seen.has(chapter.seconds) ? false : (seen.add(chapter.seconds), true));
}

/** 去空白、去重，保持首次出现顺序，截到上限。 */
export function normalizeIds(resourceIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of resourceIds) {
    const id = raw.trim();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_LEDGER_RESOURCES) break;
  }
  return out;
}

/** `ledger.rs::assemble`：按请求顺序逐项输出，题目集按题数降序、id 升序。 */
export function assembleLedgers(
  ids: readonly string[],
  cards: ReadonlyMap<string, CardTally>,
  questions: ReadonlyMap<string, QuestionTally>,
): MediaStudyLedger[] {
  return ids.map(id => {
    const card = cards.get(id);
    const question = questions.get(id);
    const exams = [...(question?.exams ?? new Map<string, number>()).entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    return {
      resourceId: id,
      cardCount: card?.count ?? 0,
      cardsDue: card?.due ?? 0,
      cardsNew: card?.new ?? 0,
      cardIds: card?.ids ?? [],
      questionCount: question?.count ?? 0,
      questionsAttempted: question?.attempted ?? 0,
      attemptTotal: question?.attempts ?? 0,
      correctTotal: question?.correct ?? 0,
      questionsWrong: question?.wrong ?? 0,
      examIds: exams.map(([exam]) => exam),
    };
  });
}

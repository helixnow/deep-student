import type { SqlExecutor } from '../../../platform/storage/api.ts';
import { rustTrim, rustTrimEnd, rustTrimStart } from '../../../platform/util/portable.ts';
import { mediaFileName } from '../repository/media-source.ts';
export { mediaFileName } from '../repository/media-source.ts';

export const MEDIA_CHUNK_SPAN_SECS = 600;
export const MEDIA_RECAP_LINES = 3;
export const MEDIA_CARD_REQUIREMENTS = '材料来自音视频课程转写（每行 [mm:ss] 为该句开始时间，标题含 [媒体@资源ID:时间] 锚点）：\n'
  + '- 每张卡背面末尾另起一行写出处 [媒体@资源ID:mm:ss]，资源 ID 取所在片段标题，时间取该知识点讲到的那一行（≥1 小时写 h:mm:ss），不得编造。\n'
  + '- 一卡一事实；问题自包含，带上必要的课程语境，脱离视频也能看懂。\n'
  + '- 只针对值得长期记忆的内容（定义、结论、公式、步骤、对比、易错点）；口头禅、寒暄、课程安排不制卡。\n'
  + '- 「上文回顾」引用块只帮助理解语境，不要针对它制卡；跨片段重复讲到的知识点只制一张。';
export const MEDIA_QUESTION_REQUIREMENTS = '## 音视频课程出处要求\n'
  + '参考资料含音视频转写（每行 [mm:ss] 为该句开始时间，片段标题含 [媒体@资源ID:时间] 锚点）：\n'
  + '- 每题 explanation 末尾另起一行写依据出处 [媒体@资源ID:mm:ss]（资源 ID 取所在片段标题，时间取依据所在行，≥1 小时写 h:mm:ss），不得编造。\n'
  + '- 题目必须基于课程实际讲到的内容；「上文回顾」引用块只帮助理解语境，不要单独据此出题；不同片段重复讲到的知识点只出一次。\n\n';
export function formatMediaClock(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600), m = Math.floor(totalSeconds % 3600 / 60), s = totalSeconds % 60;
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
export function mediaCitation(resourceId: string, seconds: number): string { return `[媒体@${resourceId}:${formatMediaClock(seconds)}]`; }
export function parseClock(raw: string): number | null {
  const parts = rustTrim(raw).split(':');
  if (!parts.every(p => /^[0-9]{1,3}$/.test(p))) return null;
  const nums = parts.map(Number);
  if (nums.length === 2 && nums[1]! < 60) return nums[0]! * 60 + nums[1]!;
  if (nums.length === 3 && nums[1]! < 60 && nums[2]! < 60) return nums[0]! * 3600 + nums[1]! * 60 + nums[2]!;
  return null;
}
export function parseTimestampedLine(line: string): [number, string] | null {
  const trimmed = rustTrimStart(line);
  if (!trimmed.startsWith('[')) return null;
  const close = trimmed.indexOf(']');
  if (close < 0) return null;
  const seconds = parseClock(trimmed.slice(1, close).split(/[-–~→]/)[0]!);
  return seconds === null ? null : [seconds, rustTrimStart(trimmed.slice(close + 1))];
}
export function firstMediaCitation(text: string): [string, number] | null {
  let cursor = text;
  for (;;) {
    const pos = cursor.indexOf('[媒体@');
    if (pos < 0) return null;
    const after = cursor.slice(pos + '[媒体@'.length), end = after.indexOf(']');
    if (end >= 0) {
      const body = after.slice(0, end), colon = body.indexOf(':'), id = rustTrim(body.slice(0, colon));
      if (colon >= 0 && id && !/\p{White_Space}/u.test(id)) {
        const seconds = parseClock(body.slice(colon + 1));
        if (seconds !== null) return [id, seconds];
      }
    }
    cursor = after;
  }
}
export function mediaCitationSecondsFor(text: string, resourceId: string): number | null {
  const needle = `[媒体@${resourceId}:`;
  let cursor = text;
  for (;;) {
    const pos = cursor.indexOf(needle);
    if (pos < 0) return null;
    const after = cursor.slice(pos + needle.length), end = after.indexOf(']');
    if (end >= 0) { const seconds = parseClock(after.slice(0, end)); if (seconds !== null) return seconds; }
    cursor = after;
  }
}
export function containsMediaAnchor(text: string): boolean { return firstMediaCitation(text) !== null; }
export function chunkTranscriptForGeneration(resourceId: string, text: string): string | null {
  const lines = text.split('\n').map(rustTrimEnd).filter(s => rustTrim(s) !== '');
  if (lines.filter(l => parseTimestampedLine(l) !== null).length < 3) return null;
  const chunks: { start: number; lines: string[] }[] = [];
  for (const line of lines) {
    const ts = parseTimestampedLine(line)?.[0], last = chunks.at(-1);
    if (!last || (ts !== undefined && ts >= last.start + MEDIA_CHUNK_SPAN_SECS)) chunks.push({ start: ts ?? 0, lines: [] });
    chunks.at(-1)!.lines.push(line);
  }
  const rendered = chunks.map((chunk, i) => {
    let out = `## 片段 ${i + 1}/${chunks.length} · ${mediaCitation(resourceId, chunk.start)} 起\n`;
    if (i > 0) {
      out += '> 上文回顾（仅帮助理解语境，不要针对它制卡/出题）：\n';
      out += chunks[i - 1]!.lines.slice(-MEDIA_RECAP_LINES).map(l => `> ${rustTrim(l)}\n`).join('');
    }
    return out + chunk.lines.map(l => `${l}\n`).join('');
  }).join('\n\n');
  return rustTrimEnd(rendered);
}
export function prepareMediaTextForGeneration(db: SqlExecutor, fileId: string, text: string): string {
  if (mediaFileName(db, fileId) === null) return text;
  return chunkTranscriptForGeneration(fileId, text) ?? text;
}

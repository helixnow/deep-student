/**
 * 新建资源的自动起名：作文批改完、翻译出译文后，名字还是「新作文」「新翻译」
 * （含「新作文 2」这类去重序号）时按内容起一个能认出来的名字。
 */
import { parseNameWithNumber } from './naming';
import { EMPTY_RESOURCE_TEMPLATES } from './types';

/** 自动标题中「主题」部分的上限（按 Unicode 字符计） */
const SUBJECT_MAX_CHARS = 24;

/** 名字仍是新建默认名（或未命名兜底）才允许自动起名，用户手动改过的名字不覆盖 */
export function isDefaultResourceName(
  name: string | null | undefined,
  type: 'essay' | 'translation',
  untitledLabel?: string,
): boolean {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return true;
  if (untitledLabel && trimmed === untitledLabel) return true;
  return parseNameWithNumber(trimmed).baseName === EMPTY_RESOURCE_TEMPLATES[type].defaultName;
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? '';
}

/** 首句：中文句末标点直接断开；西文 . ! ? 需后接空白或行尾（避开 6.5、e.g. 之类） */
function firstSentence(text: string): string {
  const line = firstLine(text);
  const match = line.match(/^(.+?(?:[。！？]|[.!?](?=\s|$)))/);
  return (match ? match[1] : line).trim();
}

/** 超长截断；西文单词被拦腰切开时退到上一个空格 */
function truncateSubject(subject: string): string {
  const chars = Array.from(subject);
  if (chars.length <= SUBJECT_MAX_CHARS) return subject;
  let cut = chars.slice(0, SUBJECT_MAX_CHARS).join('');
  const midWord = /[A-Za-z0-9]$/.test(cut) && /[A-Za-z0-9]/.test(chars[SUBJECT_MAX_CHARS]);
  const lastSpace = cut.lastIndexOf(' ');
  if (midWord && lastSpace > SUBJECT_MAX_CHARS / 2) cut = cut.slice(0, lastSpace);
  return `${cut.trimEnd()}…`;
}

export interface EssayAutoTitleSource {
  topicText?: string;
  inputText?: string;
  modeName?: string;
  /** 组合「模式名 + 主题」（走 i18n，中西文分隔符不同） */
  join: (mode: string, subject: string) => string;
}

/** 作文：优先用题目首行，没有题目取正文首句；都为空返回 null（保持原名） */
export function buildEssayAutoTitle({ topicText, inputText, modeName, join }: EssayAutoTitleSource): string | null {
  const source = firstLine(topicText ?? '') || firstSentence(inputText ?? '');
  if (!source) return null;
  const subject = truncateSubject(source);
  return modeName ? join(modeName, subject) : subject;
}

/** 翻译：取原文首行；原文为空返回 null */
export function buildTranslationAutoTitle(sourceText: string): string | null {
  const line = firstLine(sourceText);
  return line ? truncateSubject(line) : null;
}

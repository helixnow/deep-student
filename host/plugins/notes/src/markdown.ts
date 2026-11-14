import {
  rustTrim, rustTrimEnd, rustTrimStart,
} from '../../../platform/util/index.ts';

// notes_manager.rs:1637-1774. These are the legacy Canvas section rules,
// deliberately distinct from CommonMark root-node parsing used by stable blocks.
export const trimStart = rustTrimStart;
export const trimEnd = rustTrimEnd;
export const trim = rustTrim;
export function lines(text: string): string[] {
  if (text === '') return [];
  const result = text.split('\n');
  if (result.at(-1) === '') result.pop();
  return result.map((line, index) => index < result.length - 1 || text.endsWith('\n')
    ? line.replace(/\r$/, '') : line);
}

export function getHeadingLevel(line: string): number | null {
  const text = trim(line);
  const level = /^#+/.exec(text)?.[0].length ?? 0;
  if (level > 0 && level <= 6 && (text.length === level || text[level] === ' ')) return level;
  return null;
}

function stripAtxClosing(text: string): string {
  const trimmed = trimEnd(text);
  const stripped = trimmed.replace(/#+$/, '');
  if (stripped.length !== trimmed.length) {
    const beforeHashes = trimEnd(stripped);
    if (beforeHashes.length < stripped.length && beforeHashes !== '') return beforeHashes;
  }
  return trimmed;
}

function findSectionBounds(source: string[], query: string): [number, number, number] | null {
  const trimmed = trim(query);
  const level = /^#+/.exec(trimmed)?.[0].length ?? 0;
  const wantLevel = level > 0 && level <= 6 ? level : null;
  const wantText = (wantLevel === null ? trimmed : trim(trimmed.slice(level))).toLowerCase();
  if (wantText === '') return null;
  let fence: string | null = null;
  let start: number | null = null;
  let sectionLevel = 0;
  for (const [i, line] of source.entries()) {
    const prefix = trimStart(line);
    const marker = prefix.startsWith('```') ? '```' : prefix.startsWith('~~~') ? '~~~' : null;
    if (marker !== null) {
      if (fence === marker) fence = null;
      else if (fence === null) fence = marker;
      continue;
    }
    if (fence !== null) continue;
    const text = trim(line);
    const headingLevel = getHeadingLevel(text);
    if (headingLevel === null) continue;
    if (start !== null) {
      if (headingLevel <= sectionLevel) return [start, sectionLevel, i];
      continue;
    }
    if (wantLevel !== null && wantLevel !== headingLevel) continue;
    if (stripAtxClosing(trim(text.slice(headingLevel))).toLowerCase() === wantText) {
      start = i;
      sectionLevel = headingLevel;
    }
  }
  return start === null ? null : [start, sectionLevel, source.length];
}

export function extractSectionContent(content: string, title: string): string | null {
  const source = lines(content);
  const bounds = findSectionBounds(source, title);
  return bounds === null ? null : trim(source.slice(bounds[0] + 1, bounds[2]).join('\n'));
}

export function appendToSection(content: string, title: string, appended: string): string | null {
  const source = lines(content);
  const bounds = findSectionBounds(source, title);
  return bounds === null ? null : [...source.slice(0, bounds[2]), '', appended, ...source.slice(bounds[2])].join('\n');
}

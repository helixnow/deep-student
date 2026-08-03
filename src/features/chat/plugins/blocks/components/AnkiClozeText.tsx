/**
 * Anki Cloze 文本渲染
 *
 * 把 `{{c1::答案}}` / `{{c1::答案::提示}}` 标记渲染成高亮片段：
 * - revealed：高亮显示答案（背面）
 * - !revealed：显示提示或省略占位（正面）
 *
 * 无 cloze 标记时按原始文本直接输出（不包裹额外节点），
 * 保证纯文本卡片的 DOM 结构与既有行为完全一致。
 */

import React, { useMemo } from 'react';
import { cn } from '@/utils/cn';
import './chat-anki-cards.css';

const CLOZE_DETECT = /\{\{c\d+::/;
const CLOZE_PATTERN = /\{\{c(\d+)::([\s\S]*?)(?:::([\s\S]*?))?\}\}/g;

export function hasClozeMarkers(text: string | null | undefined): boolean {
  return typeof text === 'string' && CLOZE_DETECT.test(text);
}

export type ClozeSegment =
  | { kind: 'text'; value: string }
  | { kind: 'cloze'; ordinal: number; answer: string; hint?: string };

export function parseClozeSegments(text: string): ClozeSegment[] {
  const segments: ClozeSegment[] = [];
  let lastIndex = 0;
  CLOZE_PATTERN.lastIndex = 0;
  let match = CLOZE_PATTERN.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      segments.push({ kind: 'text', value: text.slice(lastIndex, match.index) });
    }
    const ordinal = Number.parseInt(match[1], 10);
    segments.push({
      kind: 'cloze',
      ordinal: Number.isFinite(ordinal) ? ordinal : 1,
      answer: match[2] ?? '',
      hint: match[3]?.trim() ? match[3].trim() : undefined,
    });
    lastIndex = match.index + match[0].length;
    match = CLOZE_PATTERN.exec(text);
  }
  if (lastIndex < text.length) {
    segments.push({ kind: 'text', value: text.slice(lastIndex) });
  }
  return segments;
}

export const ClozeText: React.FC<{
  text: string;
  /** true（默认）：显示并高亮答案；false：隐藏为提示/省略占位 */
  revealed?: boolean;
  className?: string;
}> = ({ text, revealed = true, className }) => {
  const segments = useMemo(
    () => (hasClozeMarkers(text) ? parseClozeSegments(text) : null),
    [text],
  );

  // 无 cloze：保持原始文本节点（不新增元素层级）
  if (!segments) return <>{text}</>;

  return (
    <span className={className}>
      {segments.map((segment, index) =>
        segment.kind === 'text' ? (
          <React.Fragment key={index}>{segment.value}</React.Fragment>
        ) : (
          <mark
            key={index}
            className={cn('canki-cloze', !revealed && 'canki-cloze-hidden')}
            data-cloze-ordinal={segment.ordinal}
          >
            {revealed ? segment.answer : `[${segment.hint ?? '…'}]`}
          </mark>
        ),
      )}
    </span>
  );
};

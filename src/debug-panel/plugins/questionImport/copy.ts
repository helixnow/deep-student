/**
 * 题目导入调试：本地时间戳格式、详情的 JSON 展开，以及复制 / 下载用的纯文本日志。
 */

import type { ImportLogEntry } from './model';


export function formatTs(ts: number): string {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

export function stringify(v: unknown): string {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

export function buildCopyText(logs: ImportLogEntry[]): string {
  const lines = logs.map((l) => {
    const parts = [
      formatTs(l.ts),
      `[${l.level.toUpperCase()}]`,
      `[${l.phase}]`,
    ];
    if (l.sessionId) parts.push(`sid=${l.sessionId.slice(0, 16)}`);
    if (l.percent != null) parts.push(`${l.percent}%`);
    if (l.durationMs != null) parts.push(`${l.durationMs}ms`);
    parts.push(l.summary);
    if (l.detail) parts.push(`\n  detail: ${stringify(l.detail)}`);
    return parts.join(' ');
  });
  return lines.join('\n');
}

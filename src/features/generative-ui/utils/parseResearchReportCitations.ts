/**
 * 研究报告中 [type-N] 引用标记解析（对齐 Chat citation 契约）
 */

export interface ResearchReportCitation {
  fullMatch: string;
  typeText: string;
  index: number;
  start: number;
  end: number;
}

export const RESEARCH_REPORT_CITATION_PATTERN = /\[([^[\]-]+)-(\d+)\]/g;

export function parseResearchReportCitations(text: string): ResearchReportCitation[] {
  const citations: ResearchReportCitation[] = [];
  const pattern = new RegExp(RESEARCH_REPORT_CITATION_PATTERN.source, 'g');

  for (const match of text.matchAll(pattern)) {
    const fullMatch = match[0];
    const typeText = match[1]?.trim() ?? '';
    const index = Number.parseInt(match[2] ?? '', 10);
    if (!fullMatch || !typeText || !Number.isFinite(index)) continue;

    citations.push({
      fullMatch,
      typeText,
      index,
      start: match.index ?? 0,
      end: (match.index ?? 0) + fullMatch.length,
    });
  }

  return citations.sort((a, b) => a.start - b.start);
}

export function countResearchReportCitations(text: string): number {
  return parseResearchReportCitations(text).length;
}

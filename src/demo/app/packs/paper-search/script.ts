/**
 * 第 06 章剧本：在对话里检索论文。
 * 第一问：先 arXiv 搜梯度压缩预印本，再用 OpenAlex 找数据并行训练的高引经典，正文整理成对照表。
 * 追问：「把第 1、3 篇下载保存」→ paper_save 进度块；「按 GB/T 7714 / BibTeX / APA 排参考文献」→ cite_format。
 */
import type { DemoBlocks } from '../../../fixtures';
import {
  ALL_PAPERS,
  ARXIV_PAPERS,
  OPENALEX_PAPERS,
  formatCitation,
  toSources,
  type CitationFormat,
  type DemoPaper,
} from './papers';

export const PAPER_SESSION_ID = 'demo-paper-search';
export const PAPER_TITLE = '梯度压缩 · 文献检索';
export const PAPER_PROMPT =
  '我在写数据并行训练的课程报告。先在 arXiv 上找几篇梯度压缩方向的论文，再用学术搜索找这个领域引用量高的经典论文，整理成表，标上年份和引用数。';

const ARXIV_QUERY = 'gradient compression distributed training';
const OPENALEX_QUERY = 'data parallel distributed deep learning';

const kCount = (n: number) => `≈${n.toLocaleString('en-US')}`;
const firstAuthor = (p: DemoPaper) => `${p.authors[0][1]}${p.authors.length > 1 ? ' 等' : ''}`;
const where = (p: DemoPaper) => p.venueShort ?? `arXiv ${p.arxivId}`;
const row = (p: DemoPaper, i: number) =>
  `| ${i + 1} | ${p.title}（${firstAuthor(p)}）[搜索-${i + 1}] | ${p.year} | ${where(p)} | ${kCount(p.citations)} |`;

const TABLE_HEAD = '| # | 论文 | 年份 | 发表 | 引用数 |\n|---|---|---|---|---|';

export const PAPER_REPLY: DemoBlocks = [
  {
    type: 'thinking',
    status: 'success',
    streaming: true,
    content:
      '两个来源互补：arXiv 用来找梯度压缩方向的预印本，学科分类选 cs.LG 与 cs.DC；OpenAlex 带引用数，用来找数据并行训练里被引最多的经典论文，限定 2012 年以后、引用数 500 以上，按引用数排序。检索词用英文效果更好。',
  },
  {
    type: 'academic_search',
    status: 'success',
    dwellMs: 900,
    toolName: 'arxiv_search',
    toolInput: { query: ARXIV_QUERY, categories: ['cs.LG', 'cs.DC'], sort_by: 'relevance', max_results: 5 },
    toolOutput: { source: 'arxiv', total_results: ARXIV_PAPERS.length, sources: toSources(ARXIV_PAPERS, 'arxiv') },
  },
  {
    type: 'academic_search',
    status: 'success',
    dwellMs: 900,
    toolName: 'scholar_search',
    toolInput: { query: OPENALEX_QUERY, year_from: 2012, min_citation_count: 500, sort_by: 'citations', limit: 4 },
    toolOutput: {
      source: 'openalex',
      total_results: 1286,
      returned_results: OPENALEX_PAPERS.length,
      sources: toSources(OPENALEX_PAPERS, 'openalex'),
    },
  },
  {
    type: 'content',
    status: 'success',
    streaming: true,
    content: `两路检索共找到 9 篇，按用途分成两组（引用数来自 OpenAlex，为约数）。

### 梯度压缩方向（arXiv）

${TABLE_HEAD}
${ARXIV_PAPERS.map((p, i) => row(p, i)).join('\n')}

### 数据并行训练的高引经典（OpenAlex）

${TABLE_HEAD}
${OPENALEX_PAPERS.map((p, i) => row(p, i + ARXIV_PAPERS.length)).join('\n')}

**怎么读**：先看参数服务器 [搜索-7] 和大批量 SGD [搜索-8]，理解数据并行的基本流程与扩展瓶颈；再按「稀疏化」（DGC [搜索-1]、误差反馈 [搜索-4]）与「量化 / 低秩」（QSGD [搜索-2]、TernGrad [搜索-5]、PowerSGD [搜索-3]）两条线读压缩方法。

接下来可以说「把第 1、3 篇下载保存」存进资源库，或者「按 GB/T 7714 排出参考文献」。`,
  },
];

/** 访客提到的编号（1–9），没提就用默认 */
function pickPapers(content: string, fallback: number[]): Array<{ paper: DemoPaper; index: number }> {
  const numbers = [...content.matchAll(/\d+/g)]
    .map((m) => Number(m[0]))
    .filter((n) => n >= 1 && n <= ALL_PAPERS.length);
  const chosen = numbers.length ? [...new Set(numbers)] : fallback;
  return chosen.map((n) => ({ paper: ALL_PAPERS[n - 1], index: n }));
}

type Stage = 'resolving' | 'downloading' | 'storing' | 'indexing' | 'done';

function progressLine(items: Array<{ paper: DemoPaper; stage: Stage; pct: number; total: number; dedup?: boolean }>): string {
  return `${JSON.stringify({
    papers: items.map((it, i) => ({
      i,
      t: it.paper.title,
      s: it.stage,
      pct: it.pct,
      dl: Math.round((it.total * it.pct) / 100),
      total: it.total,
      ...(it.stage === 'done' ? { fid: `file_demo_paper_${it.paper.arxivId?.replace('.', '_') ?? i}` } : {}),
      ...(it.dedup ? { dedup: true } : {}),
      src: it.paper.arxivId ? 'arXiv' : 'Unpaywall',
    })),
  })}\n`;
}

export function saveReply(content: string): DemoBlocks {
  const picked = pickPapers(content, [1, 3]);
  // 参数服务器（OSDI）没有 arXiv 版本、OpenAlex 也没有开放获取 PDF 时，会如实报错
  const sizes = picked.map(({ paper }) => 900_000 + (paper.title.length % 7) * 310_000);
  const frames: Array<Array<{ stage: Stage; pct: number }>> = [
    picked.map(() => ({ stage: 'resolving' as Stage, pct: 0 })),
    picked.map((_, i) => ({ stage: (i === 0 ? 'downloading' : 'resolving') as Stage, pct: i === 0 ? 45 : 0 })),
    picked.map((_, i) => ({ stage: 'downloading' as Stage, pct: i === 0 ? 100 : 40 })),
    picked.map((_, i) => ({ stage: (i === 0 ? 'indexing' : 'downloading') as Stage, pct: 100 })),
    picked.map(() => ({ stage: 'done' as Stage, pct: 100 })),
  ];
  const chunks = frames.map((frame) =>
    progressLine(frame.map((f, i) => ({ paper: picked[i].paper, ...f, total: sizes[i] }))),
  );
  const list = picked.map(({ paper, index }) => `- 第 ${index} 篇：${paper.title}（${paper.year}）`).join('\n');
  return [
    {
      type: 'tool_call',
      status: 'success',
      toolName: 'builtin-paper_save',
      dwellMs: 380,
      toolInput: {
        papers: picked.map(({ paper }) => ({ title: paper.title, arxiv_id: paper.arxivId, url: paper.url })),
        folder: '论文 / 梯度压缩',
      },
      chunks,
      toolOutput: {
        total: picked.length,
        success_count: picked.length,
        failed_count: 0,
        results: picked.map(({ paper }, i) => ({
          index: i,
          success: true,
          title: paper.title,
          fileId: `file_demo_paper_${paper.arxivId?.replace('.', '_') ?? i}`,
        })),
      },
    },
    {
      type: 'content',
      status: 'success',
      streaming: true,
      content: `已下载 ${picked.length} 篇 PDF，存进资源库的「论文 / 梯度压缩」文件夹：\n\n${list}\n\n资源库按内容去重，重复下载会直接复用已有文件。完成知识库索引后，就可以在对话里引用它们提问，比如「对比这两篇的实验设置」。`,
    },
  ];
}

export function citeReply(content: string): DemoBlocks {
  const text = content.toLowerCase();
  const format: CitationFormat = text.includes('bib') ? 'bibtex' : text.includes('apa') ? 'apa' : 'gbt7714';
  const picked = pickPapers(content.replace(/7714/g, ''), [1, 2, 3]);
  const citations = picked.map(({ paper }) => ({ title: paper.title, citation: formatCitation(paper, format) }));
  const label = format === 'bibtex' ? 'BibTeX' : format === 'apa' ? 'APA' : 'GB/T 7714';
  const body =
    format === 'bibtex'
      ? `\`\`\`bibtex\n${citations.map((c) => c.citation).join('\n\n')}\n\`\`\``
      : citations.map((c, i) => `[${i + 1}] ${c.citation}`).join('\n\n');
  return [
    {
      type: 'tool_call',
      status: 'success',
      toolName: 'builtin-cite_format',
      dwellMs: 300,
      toolInput: {
        format,
        papers: picked.map(({ paper }) => ({
          title: paper.title,
          authors: paper.authors.map(([g, f]) => `${g} ${f}`),
          year: paper.year,
          venue: paper.venue,
          arxiv_id: paper.arxivId,
        })),
      },
      toolOutput: { format, count: citations.length, citations },
    },
    {
      type: 'content',
      status: 'success',
      streaming: true,
      content: `按 ${label} 排好了 ${citations.length} 条，可以直接复制进参考文献：\n\n${body}\n\n${format === 'gbt7714' ? '会议论文标 [C]，预印本标 [J] 并注明 arXiv 编号；正式提交前建议核对是否已有期刊或会议版本。' : '还可以换成「GB/T 7714」或「APA」格式。'}`,
    },
  ];
}

export const PAPER_FOLLOW_UPS = [
  { keywords: ['下载', '保存', '存', 'save', 'download', 'doi'], reply: saveReply },
  { keywords: ['引用', '参考文献', 'bibtex', 'bib', 'gb/t', 'gbt', '7714', 'apa', 'cite'], reply: citeReply },
];

export const PAPER_FALLBACK: DemoBlocks = [
  {
    type: 'content',
    status: 'success',
    streaming: true,
    content:
      '这段演示里的检索结果来自预设数据：可以展开上面的搜索卡片查看论文与原文链接，或者试试「把第 1、3 篇下载保存」「按 BibTeX 排参考文献」。\n\n在 Deep Student 桌面版里，用自然语言描述你的方向（建议用英文检索词），AI 会直接调用 arXiv 与 OpenAlex 检索，国内可直连。',
  },
];

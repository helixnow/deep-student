/**
 * 第 06 章「论文搜索」演示用的论文元数据：数据并行训练与梯度压缩方向的经典论文
 * （标题、作者、年份、会议、arXiv 编号均为真实信息）。
 *
 * 引用数是演示用的约数（OpenAlex 的实时数字随时间变化），正文与表格里一律标「约」。
 * 引用格式（GB/T 7714 / BibTeX / APA）由 formatCitation 按元数据现排，与桌面版 cite_format 的格式规则同类。
 */

export interface DemoPaper {
  title: string;
  /** [名, 姓] */
  authors: Array<[string, string]>;
  year: number;
  /** 会议 / 期刊全称；只有预印本时为空 */
  venue?: string;
  venueShort?: string;
  arxivId?: string;
  url: string;
  /** OpenAlex 引用数（约数） */
  citations: number;
  /** 一句话摘要（中文，卡片上的 snippet） */
  summary: string;
}

const arxiv = (id: string) => `https://arxiv.org/abs/${id}`;

/** arXiv 预印本搜索：梯度压缩 */
export const ARXIV_PAPERS: DemoPaper[] = [
  {
    title: 'Deep Gradient Compression: Reducing the Communication Bandwidth for Distributed Training',
    authors: [['Yujun', 'Lin'], ['Song', 'Han'], ['Huizi', 'Mao'], ['Yu', 'Wang'], ['William J.', 'Dally']],
    year: 2018, venue: 'International Conference on Learning Representations', venueShort: 'ICLR 2018',
    arxivId: '1712.01887', url: arxiv('1712.01887'), citations: 1500,
    summary: '分布式 SGD 中 99.9% 的梯度交换是冗余的：只传大梯度，配合动量修正、局部梯度裁剪与预热训练，通信量压缩数百倍而精度不降。',
  },
  {
    title: 'QSGD: Communication-Efficient SGD via Gradient Quantization and Encoding',
    authors: [['Dan', 'Alistarh'], ['Demjan', 'Grubic'], ['Jerry', 'Li'], ['Ryota', 'Tomioka'], ['Milan', 'Vojnovic']],
    year: 2017, venue: 'Advances in Neural Information Processing Systems 30', venueShort: 'NeurIPS 2017',
    arxivId: '1610.02132', url: arxiv('1610.02132'), citations: 1600,
    summary: '对梯度做随机量化与高效编码，在通信比特数与方差之间给出可调的折中，并保证收敛。',
  },
  {
    title: 'PowerSGD: Practical Low-Rank Gradient Compression for Distributed Optimization',
    authors: [['Thijs', 'Vogels'], ['Sai Praneeth', 'Karimireddy'], ['Martin', 'Jaggi']],
    year: 2019, venue: 'Advances in Neural Information Processing Systems 32', venueShort: 'NeurIPS 2019',
    arxivId: '1905.13727', url: arxiv('1905.13727'), citations: 500,
    summary: '用幂迭代求梯度的低秩近似，压缩结果可直接用 all-reduce 聚合，在真实集群上带来端到端加速。',
  },
  {
    title: 'Sparsified SGD with Memory',
    authors: [['Sebastian U.', 'Stich'], ['Jean-Baptiste', 'Cordonnier'], ['Martin', 'Jaggi']],
    year: 2018, venue: 'Advances in Neural Information Processing Systems 31', venueShort: 'NeurIPS 2018',
    arxivId: '1809.07599', url: arxiv('1809.07599'), citations: 700,
    summary: '只传 top-k 梯度分量并把其余误差累积到下一轮（误差反馈），证明其收敛速度与普通 SGD 同阶。',
  },
  {
    title: 'TernGrad: Ternary Gradients to Reduce Communication in Distributed Deep Learning',
    authors: [['Wei', 'Wen'], ['Cong', 'Xu'], ['Feng', 'Yan'], ['Chunpeng', 'Wu'], ['Yandan', 'Wang'], ['Yiran', 'Chen'], ['Hai', 'Li']],
    year: 2017, venue: 'Advances in Neural Information Processing Systems 30', venueShort: 'NeurIPS 2017',
    arxivId: '1705.07878', url: arxiv('1705.07878'), citations: 900,
    summary: '把梯度量化为 {-1, 0, 1} 三值，配合逐层缩放与梯度裁剪，在多种网络上基本保持精度。',
  },
];

/** OpenAlex 学术搜索：数据并行训练的高引经典 */
export const OPENALEX_PAPERS: DemoPaper[] = [
  {
    title: 'Large Scale Distributed Deep Networks',
    authors: [['Jeffrey', 'Dean'], ['Greg S.', 'Corrado'], ['Rajat', 'Monga'], ['Kai', 'Chen'], ['Matthieu', 'Devin'], ['Quoc V.', 'Le'], ['Mark Z.', 'Mao'], ["Marc'Aurelio", 'Ranzato'], ['Andrew', 'Senior'], ['Paul', 'Tucker'], ['Ke', 'Yang'], ['Andrew Y.', 'Ng']],
    year: 2012, venue: 'Advances in Neural Information Processing Systems 25', venueShort: 'NeurIPS 2012',
    url: '', citations: 4000,
    summary: 'DistBelief 框架：用 Downpour SGD（异步数据并行 + 参数服务器）与模型并行，在上万 CPU 核上训练大规模网络。',
  },
  {
    title: 'Scaling Distributed Machine Learning with the Parameter Server',
    authors: [['Mu', 'Li'], ['David G.', 'Andersen'], ['Jun Woo', 'Park'], ['Alexander J.', 'Smola'], ['Amr', 'Ahmed'], ['Vanja', 'Josifovski'], ['James', 'Long'], ['Eugene J.', 'Shekita'], ['Bor-Yiing', 'Su']],
    year: 2014, venue: '11th USENIX Symposium on Operating Systems Design and Implementation', venueShort: 'OSDI 2014',
    url: 'https://www.usenix.org/conference/osdi14/technical-sessions/presentation/li_mu', citations: 2000,
    summary: '第三代参数服务器：异步通信、灵活一致性模型与容错设计，支撑数十亿参数的分布式训练。',
  },
  {
    title: 'Accurate, Large Minibatch SGD: Training ImageNet in 1 Hour',
    authors: [['Priya', 'Goyal'], ['Piotr', 'Dollár'], ['Ross', 'Girshick'], ['Pieter', 'Noordhuis'], ['Lukasz', 'Wesolowski'], ['Aapo', 'Kyrola'], ['Andrew', 'Tulloch'], ['Yangqing', 'Jia'], ['Kaiming', 'He']],
    year: 2017, arxivId: '1706.02677', url: arxiv('1706.02677'), citations: 3000,
    summary: '线性缩放学习率加预热，把 minibatch 扩到 8192 张图仍保持精度，256 块 GPU 一小时训完 ResNet-50。',
  },
  {
    title: 'Horovod: fast and easy distributed deep learning in TensorFlow',
    authors: [['Alexander', 'Sergeev'], ['Mike', 'Del Balso']],
    year: 2018, arxivId: '1802.05799', url: arxiv('1802.05799'), citations: 1200,
    summary: '基于 ring all-reduce 的数据并行库，几行代码即可把单机训练脚本扩展到多机多卡。',
  },
];

/** 两批结果按出现顺序的全局编号（对应正文的 [搜索-N]） */
export const ALL_PAPERS: DemoPaper[] = [...ARXIV_PAPERS, ...OPENALEX_PAPERS];

const authorNames = (paper: DemoPaper) => paper.authors.map(([given, family]) => `${given} ${family}`);

/** 后端 papers_to_sources 的形状：标题、链接、摘要，元数据里是作者、年份、引用数等 */
export function toSources(papers: DemoPaper[], searchSource: 'arxiv' | 'openalex') {
  return papers.map((paper) => ({
    title: paper.title,
    url: paper.url,
    snippet: paper.summary,
    metadata: {
      sourceType: 'academic_search',
      searchSource,
      authors: authorNames(paper),
      year: paper.year,
      citationCount: paper.citations,
      pdfUrl: paper.arxivId ? `https://arxiv.org/pdf/${paper.arxivId}` : null,
      doi: null,
      venue: paper.venueShort ?? null,
      arxivId: paper.arxivId ?? null,
    },
  }));
}

export type CitationFormat = 'gbt7714' | 'bibtex' | 'apa';

const initials = (given: string, sep: string) =>
  given.split(/[\s-]+/).filter(Boolean).map((part) => `${part[0].toUpperCase()}${sep}`).join(sep === '.' ? ' ' : ' ');

function gbt(paper: DemoPaper): string {
  const names = paper.authors.map(([given, family]) => `${family.toUpperCase()} ${initials(given, '')}`.trim());
  const who = names.length > 3 ? `${names.slice(0, 3).join(', ')}, et al` : names.join(', ');
  return paper.venue
    ? `${who}. ${paper.title}[C]//${paper.venue}. ${paper.year}.`
    : `${who}. ${paper.title}[J]. arXiv preprint arXiv:${paper.arxivId}, ${paper.year}.`;
}

function bibtex(paper: DemoPaper): string {
  const [, family] = paper.authors[0];
  const firstWord = paper.title.split(/[^A-Za-z]+/).find((w) => w.length > 3)?.toLowerCase() ?? 'paper';
  const key = `${family.toLowerCase().replace(/[^a-z]/g, '')}${paper.year}${firstWord}`;
  const author = paper.authors.map(([given, fam]) => `${fam}, ${given}`).join(' and ');
  return paper.venue
    ? `@inproceedings{${key},\n  title     = {${paper.title}},\n  author    = {${author}},\n  booktitle = {${paper.venue}},\n  year      = {${paper.year}}\n}`
    : `@article{${key},\n  title   = {${paper.title}},\n  author  = {${author}},\n  journal = {arXiv preprint arXiv:${paper.arxivId}},\n  year    = {${paper.year}}\n}`;
}

function apa(paper: DemoPaper): string {
  const names = paper.authors.map(([given, family]) => `${family}, ${initials(given, '.')}`);
  const who = names.length > 1 ? `${names.slice(0, -1).join(', ')}, & ${names[names.length - 1]}` : names[0];
  return paper.venue
    ? `${who} (${paper.year}). ${paper.title}. In *${paper.venue}*.`
    : `${who} (${paper.year}). ${paper.title}. *arXiv preprint arXiv:${paper.arxivId}*.`;
}

export function formatCitation(paper: DemoPaper, format: CitationFormat): string {
  if (format === 'bibtex') return bibtex(paper);
  if (format === 'apa') return apa(paper);
  return gbt(paper);
}

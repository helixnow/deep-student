/**
 * 资源库演示数据（第 04 章「资源库」与第 05 章「文档阅读与翻译」共用）。
 *
 * 一学期的资料：按课程分文件夹，教材 PDF、笔记、题目集、思维导图、翻译、
 * 图片、音视频和 Office 文档齐全；知识库索引大多已就绪，一份教材正在索引。
 * 纯数据模块，不碰 app 代码（见 ../../types.ts 的加载顺序约束）。
 */
import { DEMO_PDF_NAME } from '../../../attachmentAssets';

export type LibraryNodeType =
  | 'note'
  | 'textbook'
  | 'exam'
  | 'translation'
  | 'essay'
  | 'image'
  | 'file'
  | 'mindmap';

/** 索引状态（vfs_get_all_index_status 的 textIndexState） */
export type LibraryIndexState = 'indexed' | 'pending' | 'indexing' | 'failed' | 'disabled';

export interface LibraryFolderSeed {
  id: string;
  title: string;
  parentId: string | null;
  /** 距今天数（创建 / 更新） */
  createdDaysAgo: number;
  updatedDaysAgo: number;
}

export interface LibraryResourceSeed {
  id: string;
  type: LibraryNodeType;
  name: string;
  folderId: string | null;
  createdDaysAgo: number;
  updatedDaysAgo: number;
  size?: number;
  mimeType?: string;
  previewType?: string;
  pageCount?: number;
  favorite?: boolean;
  /** 笔记正文（markdown） / 翻译正文（JSON）等 dstu_get_content 内容 */
  content?: string;
  index: LibraryIndexState;
  /** 索引分块数（已索引时显示） */
  chunks?: number;
  /** 是否带 OCR（扫描版 / 图片） */
  ocr?: boolean;
  /** 额外 metadata（书签、高亮、语向等） */
  metadata?: Record<string, unknown>;
  /** 回收站里的项目 */
  deleted?: boolean;
}

/** 第 05 章阅读器打开的那本教材（复用对话演示生成的 60 页 PDF） */
export const LIBRARY_PDF_ID = 'tb_demo_mlsys';
/** 第 05 章翻译工作台默认打开的翻译 */
export const LIBRARY_TRANSLATION_ID = 'tr_demo_dp_abstract';

export const LIBRARY_FOLDERS: LibraryFolderSeed[] = [
  { id: 'fld_demo_calc', title: '高等数学', parentId: null, createdDaysAgo: 34, updatedDaysAgo: 0.1 },
  { id: 'fld_demo_linalg', title: '线性代数', parentId: null, createdDaysAgo: 34, updatedDaysAgo: 2 },
  { id: 'fld_demo_mlsys', title: '机器学习系统', parentId: null, createdDaysAgo: 30, updatedDaysAgo: 0.05 },
  { id: 'fld_demo_english', title: '考研英语', parentId: null, createdDaysAgo: 28, updatedDaysAgo: 1 },
  { id: 'fld_demo_chem', title: '有机化学', parentId: null, createdDaysAgo: 26, updatedDaysAgo: 4 },
  { id: 'fld_demo_calc_mid', title: '期中复习', parentId: 'fld_demo_calc', createdDaysAgo: 9, updatedDaysAgo: 0.1 },
];

const NOTE_PLAN = `# 2026 秋季学期学习计划

## 每周节奏
- 周一 / 周三：高等数学（极限 → 导数 → 中值定理）
- 周二 / 周四：线性代数 + 机器学习系统
- 周末：考研英语阅读 2 篇 + 有机化学机理复盘

## 本月目标
1. 高数期中模拟卷两套，错题全部制卡
2. 读完《机器学习系统》第 3 章，整理数据并行笔记
3. 考研英语核心词汇第 1–20 单元过一遍`;

const NOTE_LIMIT = `# 极限与连续

## 两个重要极限
- $\\lim_{x\\to 0} \\frac{\\sin x}{x} = 1$
- $\\lim_{x\\to\\infty} (1+\\frac{1}{x})^x = e$

## 等价无穷小（$x\\to 0$）
$\\sin x \\sim x$，$\\tan x \\sim x$，$1-\\cos x \\sim \\frac{x^2}{2}$，$e^x-1 \\sim x$

> 易错：加减运算中不能随意替换等价无穷小。`;

const NOTE_PS = `# 课堂笔记 · 参数服务器

- 每个 worker 持有完整模型副本，计算本地梯度后推送给参数服务器
- 服务器聚合（求均值）后广播新参数，下一步开始前所有 worker 参数一致
- 同步 SGD 的瓶颈：最慢的 worker（straggler）拖慢整步
- 破局：梯度压缩（FP16 / 8-bit / top-k）、流水线并行`;

const NOTE_EIGEN = `# 特征值与特征向量

- 定义：$A\\mathbf{x} = \\lambda \\mathbf{x}$，$\\mathbf{x} \\neq 0$
- 求法：解特征方程 $\\det(\\lambda I - A) = 0$
- 性质：$\\sum \\lambda_i = \\operatorname{tr} A$，$\\prod \\lambda_i = \\det A$
- 实对称矩阵一定可以正交相似对角化`;

const NOTE_MISTAKES = `# 高数错题整理（期中）

1. 洛必达法则使用前未验证 0/0 型 → 先判型再求导
2. 分段函数在分界点求导，必须用定义分别求左右导数
3. 罗尔定理三个条件缺一不可，闭区间连续常被漏写`;

const NOTE_STEREO = `# 立体化学

- 手性碳：连有四个不同基团的饱和碳原子
- R/S 命名：按 CIP 规则排序，最小基团朝后，1→2→3 顺时针为 R
- 对映体物理性质相同，旋光方向相反`;

const NOTE_OLD_DRAFT = `# 高数笔记（草稿）

旧版草稿，内容已合并进「极限与连续」。`;

/** 翻译工作台里打开的翻译：教材第 3 章开头的英文段落 → 中文 */
export const LIBRARY_TRANSLATION_SOURCE = `Data parallelism splits each mini-batch across K workers. Every worker keeps a full replica of the model, computes gradients on its own shard, and hands them to the parameter server.

The server aggregates the K gradient tensors and broadcasts the updated parameters back to all workers before the next step begins. The protocol is simple to reason about because every worker observes the same parameters at the start of a step.

Synchronous SGD requires every worker to wait for the slowest one. This is the straggler effect: a single slow link or a hotspot GPU stretches the whole step.`;

export const LIBRARY_TRANSLATION_TARGET = `数据并行把每个小批量（mini-batch）切分给 K 个工作节点。每个工作节点都保存一份完整的模型副本，在自己分到的数据分片上计算梯度，再把梯度交给参数服务器。

参数服务器对 K 份梯度张量进行聚合，并在下一步开始之前把更新后的参数广播回所有工作节点。由于每个工作节点在每一步开始时看到的参数完全相同，这一协议很容易推理。

同步 SGD 要求每个工作节点都等待最慢的那一个。这就是"掉队者效应"（straggler effect）：一条慢链路或一块过热的 GPU 就会拉长整个训练步。`;

const TRANSLATION_META = {
  schemaVersion: 2,
  srcLang: 'en',
  tgtLang: 'zh-CN',
  formality: 'formal',
  domain: 'academic',
  glossary: [
    ['parameter server', '参数服务器'],
    ['straggler', '掉队者'],
    ['mini-batch', '小批量'],
  ],
};

const ENGLISH_SOURCE = `In the past decade, the number of students choosing to study abroad has risen steadily, yet the reasons behind this choice have shifted. Rather than prestige alone, many now cite the chance to develop independence and to see their own culture from the outside.`;
const ENGLISH_TARGET = `过去十年里，选择出国留学的学生人数稳步上升，但这一选择背后的原因已经发生了变化。如今许多人看重的不再只是名气，而是培养独立能力、从外部视角审视本国文化的机会。`;

const DAY = 86_400_000;

/** 第 45、47 页的示范高亮（0–1 相对坐标，与 60 页 PDF 的排版对齐） */
function lineRect(line: number, startChar: number, chars: number): { x: number; y: number; width: number; height: number } {
  // 生成的 PDF：595×842pt，正文 11pt Helvetica，首行基线 y=792，行距 17pt，左边距 56pt
  const baselineFromTop = 842 - 792 + 17 * line;
  const charW = 5.35;
  return {
    x: (56 + startChar * charW) / 595,
    y: (baselineFromTop - 9.5) / 842,
    width: (chars * charW) / 595,
    height: 13 / 842,
  };
}

export const LIBRARY_PDF_HIGHLIGHTS = [
  {
    id: 'hl_demo_1',
    pageIndex: 44,
    text: 'Data parallelism splits each mini-batch across K workers.',
    color: 'yellow',
    rects: [lineRect(2, 0, 57)],
    createdAt: Date.now() - 2 * DAY,
    coordVersion: 2,
  },
  {
    id: 'hl_demo_2',
    pageIndex: 44,
    text: 'The server aggregates (mean) the K gradient tensors and broadcasts the updated parameters back to all workers',
    color: 'green',
    rects: [lineRect(6, 0, 52), lineRect(7, 0, 57)],
    createdAt: Date.now() - 2 * DAY + 60_000,
    coordVersion: 2,
  },
  {
    id: 'hl_demo_3',
    pageIndex: 46,
    text: 'This is the straggler effect',
    color: 'red',
    rects: [lineRect(3, 0, 28)],
    createdAt: Date.now() - DAY,
    coordVersion: 2,
  },
  {
    id: 'hl_demo_4',
    pageIndex: 46,
    text: 'speedup deviates from linear scaling',
    color: 'blue',
    rects: [lineRect(7, 0, 36)],
    createdAt: Date.now() - DAY + 120_000,
    coordVersion: 2,
  },
];

export const LIBRARY_PDF_BOOKMARKS = [
  { id: 'bm_demo_1', page: 44, title: '第 3 章 · 数据并行训练', createdAt: Date.now() - 3 * DAY },
  { id: 'bm_demo_2', page: 47, title: '3.2 同步代价与掉队者效应', createdAt: Date.now() - DAY },
  { id: 'bm_demo_3', page: 52, title: '3.4 梯度压缩（期中重点）', createdAt: Date.now() - 0.2 * DAY },
];

export const LIBRARY_RESOURCES: LibraryResourceSeed[] = [
  // ---------- 根目录 ----------
  { id: 'note_demo_plan', type: 'note', name: '2026 秋季学期学习计划', folderId: null, createdDaysAgo: 33, updatedDaysAgo: 0.3, favorite: true, content: NOTE_PLAN, index: 'indexed', chunks: 3 },
  { id: 'tb_demo_formula', type: 'textbook', name: '高等数学公式速查.pdf', folderId: null, createdDaysAgo: 20, updatedDaysAgo: 6, size: 1_842_000, mimeType: 'application/pdf', previewType: 'pdf', pageCount: 12, favorite: true, index: 'indexed', chunks: 36 },
  { id: LIBRARY_TRANSLATION_ID, type: 'translation', name: '数据并行训练 · 段落精读', folderId: null, createdDaysAgo: 1, updatedDaysAgo: 0.08, content: JSON.stringify({ source: LIBRARY_TRANSLATION_SOURCE, translated: LIBRARY_TRANSLATION_TARGET, meta: TRANSLATION_META }), index: 'indexed', chunks: 2, metadata: { srcLang: 'en', tgtLang: 'zh-CN', sourceText: LIBRARY_TRANSLATION_SOURCE, translatedText: LIBRARY_TRANSLATION_TARGET } },
  { id: 'img_demo_board', type: 'image', name: '板书 · 泰勒展开.jpg', folderId: null, createdDaysAgo: 3, updatedDaysAgo: 3, size: 684_000, mimeType: 'image/jpeg', index: 'indexed', chunks: 1, ocr: true },

  // ---------- 高等数学 ----------
  { id: 'tb_demo_calc', type: 'textbook', name: '高等数学（上册）讲义.pdf', folderId: 'fld_demo_calc', createdDaysAgo: 0.02, updatedDaysAgo: 0.02, size: 18_420_000, mimeType: 'application/pdf', previewType: 'pdf', pageCount: 412, index: 'indexing' },
  { id: 'note_demo_limit', type: 'note', name: '极限与连续', folderId: 'fld_demo_calc', createdDaysAgo: 18, updatedDaysAgo: 1.2, content: NOTE_LIMIT, index: 'indexed', chunks: 4 },
  { id: 'mm_demo_mvt', type: 'mindmap', name: '微分中值定理', folderId: 'fld_demo_calc', createdDaysAgo: 12, updatedDaysAgo: 2.5, index: 'indexed', chunks: 2 },
  { id: 'exam_demo_calc3', type: 'exam', name: '第三章 · 导数与微分习题', folderId: 'fld_demo_calc', createdDaysAgo: 10, updatedDaysAgo: 0.9, index: 'indexed', chunks: 8 },
  { id: 'tb_demo_calc_mock', type: 'textbook', name: '高数期中模拟卷.pdf', folderId: 'fld_demo_calc_mid', createdDaysAgo: 8, updatedDaysAgo: 0.1, size: 926_000, mimeType: 'application/pdf', previewType: 'pdf', pageCount: 6, index: 'indexed', chunks: 14, ocr: true },
  { id: 'note_demo_mistakes', type: 'note', name: '高数错题整理（期中）', folderId: 'fld_demo_calc_mid', createdDaysAgo: 7, updatedDaysAgo: 0.4, content: NOTE_MISTAKES, index: 'indexed', chunks: 2 },

  // ---------- 线性代数 ----------
  { id: 'tb_demo_linalg', type: 'textbook', name: '线性代数讲义.pdf', folderId: 'fld_demo_linalg', createdDaysAgo: 31, updatedDaysAgo: 5, size: 9_310_000, mimeType: 'application/pdf', previewType: 'pdf', pageCount: 236, index: 'indexed', chunks: 412 },
  { id: 'note_demo_eigen', type: 'note', name: '特征值与特征向量', folderId: 'fld_demo_linalg', createdDaysAgo: 9, updatedDaysAgo: 2, content: NOTE_EIGEN, index: 'indexed', chunks: 2 },
  { id: 'mm_demo_decomp', type: 'mindmap', name: '矩阵分解一览', folderId: 'fld_demo_linalg', createdDaysAgo: 6, updatedDaysAgo: 4, index: 'indexed', chunks: 1 },
  { id: 'exam_demo_linalg', type: 'exam', name: '线代每日一练', folderId: 'fld_demo_linalg', createdDaysAgo: 14, updatedDaysAgo: 2, index: 'indexed', chunks: 6 },

  // ---------- 机器学习系统 ----------
  { id: LIBRARY_PDF_ID, type: 'textbook', name: DEMO_PDF_NAME, folderId: 'fld_demo_mlsys', createdDaysAgo: 5, updatedDaysAgo: 0.05, mimeType: 'application/pdf', previewType: 'pdf', pageCount: 60, favorite: true, index: 'indexed', chunks: 96, metadata: { readingProgress: { page: 45 }, bookmarks: LIBRARY_PDF_BOOKMARKS, highlights: LIBRARY_PDF_HIGHLIGHTS } },
  { id: 'note_demo_ps', type: 'note', name: '课堂笔记 · 参数服务器', folderId: 'fld_demo_mlsys', createdDaysAgo: 4, updatedDaysAgo: 0.6, content: NOTE_PS, index: 'indexed', chunks: 2 },
  { id: 'exam_demo_dp', type: 'exam', name: '数据并行训练', folderId: 'fld_demo_mlsys', createdDaysAgo: 3, updatedDaysAgo: 0.7, index: 'indexed', chunks: 5 },
  { id: 'file_demo_lecture', type: 'file', name: '第 7 讲 · 反向传播推导.mp4', folderId: 'fld_demo_mlsys', createdDaysAgo: 6, updatedDaysAgo: 1, size: 412_600_000, mimeType: 'video/mp4', previewType: 'video', index: 'indexed', chunks: 58 },
  { id: 'file_demo_audio', type: 'file', name: '答疑课录音 10-02.m4a', folderId: 'fld_demo_mlsys', createdDaysAgo: 4, updatedDaysAgo: 4, size: 38_200_000, mimeType: 'audio/mp4', previewType: 'audio', index: 'pending' },

  // ---------- 考研英语 ----------
  { id: 'file_demo_vocab', type: 'file', name: '考研英语核心词汇.xlsx', folderId: 'fld_demo_english', createdDaysAgo: 27, updatedDaysAgo: 1, size: 286_000, mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', previewType: 'xlsx', index: 'indexed', chunks: 44 },
  { id: 'file_demo_sentences', type: 'file', name: '长难句 50 句.docx', folderId: 'fld_demo_english', createdDaysAgo: 20, updatedDaysAgo: 3, size: 74_000, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', previewType: 'docx', index: 'indexed', chunks: 12 },
  { id: 'tr_demo_reading', type: 'translation', name: '2024 阅读 Text 2 · 首段', folderId: 'fld_demo_english', createdDaysAgo: 2, updatedDaysAgo: 1, content: JSON.stringify({ source: ENGLISH_SOURCE, translated: ENGLISH_TARGET, meta: { schemaVersion: 2, srcLang: 'en', tgtLang: 'zh-CN', domain: 'general' } }), index: 'indexed', chunks: 1, metadata: { srcLang: 'en', tgtLang: 'zh-CN', sourceText: ENGLISH_SOURCE, translatedText: ENGLISH_TARGET } },
  { id: 'file_demo_epub', type: 'file', name: '英语外刊精选.epub', folderId: 'fld_demo_english', createdDaysAgo: 15, updatedDaysAgo: 2, size: 2_140_000, mimeType: 'application/epub+zip', previewType: 'text', index: 'indexed', chunks: 88 },

  // ---------- 有机化学 ----------
  { id: 'tb_demo_chem', type: 'textbook', name: '有机化学反应机理.pdf', folderId: 'fld_demo_chem', createdDaysAgo: 25, updatedDaysAgo: 4, size: 12_960_000, mimeType: 'application/pdf', previewType: 'pdf', pageCount: 318, index: 'indexed', chunks: 530, ocr: true },
  { id: 'mm_demo_groups', type: 'mindmap', name: '官能团转化', folderId: 'fld_demo_chem', createdDaysAgo: 11, updatedDaysAgo: 4, index: 'indexed', chunks: 2 },
  { id: 'note_demo_stereo', type: 'note', name: '立体化学', folderId: 'fld_demo_chem', createdDaysAgo: 10, updatedDaysAgo: 5, content: NOTE_STEREO, index: 'indexed', chunks: 2 },
  { id: 'file_demo_lab', type: 'file', name: '实验报告 · 乙酸乙酯的制备.docx', folderId: 'fld_demo_chem', createdDaysAgo: 8, updatedDaysAgo: 8, size: 132_000, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', previewType: 'docx', index: 'indexed', chunks: 9 },

  // ---------- 回收站 ----------
  { id: 'note_demo_old', type: 'note', name: '高数笔记（草稿）', folderId: 'fld_demo_calc', createdDaysAgo: 30, updatedDaysAgo: 6, content: NOTE_OLD_DRAFT, index: 'indexed', chunks: 1, deleted: true },
  { id: 'tb_demo_dup', type: 'textbook', name: '线性代数讲义 (1).pdf', folderId: 'fld_demo_linalg', createdDaysAgo: 31, updatedDaysAgo: 3, size: 9_310_000, mimeType: 'application/pdf', previewType: 'pdf', pageCount: 236, index: 'indexed', chunks: 412, deleted: true },
];

/**
 * 音视频演示的剧本数据：一门 B 站分 P 课（线性代数第五讲，已建分组）+ 本地课堂录音 / 实验视频 / 英语听力。
 * 课程、UP 主、BV 号都是虚构的；视频是 ffmpeg 由讲义幻灯片合成的无声 MP4（每个只有几十 KB，打开时才下载）。
 * 只依赖演示自身，不碰 app 模块。
 */
import p1Url from './p1.mp4?url';
import p2Url from './p2.mp4?url';
import p3Url from './p3.mp4?url';
import p4Url from './p4.mp4?url';
import p5Url from './p5.mp4?url';
import chemUrl from './chem.mp4?url';
import probUrl from './prob.mp4?url';
import englishUrl from './english.mp4?url';
import pe1Url from './pe1.mp4?url';
import pe2Url from './pe2.mp4?url';
import pe3Url from './pe3.mp4?url';
import coverLa5Url from './cover-la5.jpg?url';
import coverPe7Url from './cover-pe7.jpg?url';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

export const COURSE_TITLE = '线性代数第五讲 特征值与对角化';
export const COURSE_OWNER = '数学公开课';
export const COURSE_BVID = 'BV1Lq4y1d7Xe';
export const COURSE_COVER = coverLa5Url;
export const COURSE_FOLDER = { id: 'fld_demo_la5', title: '线性代数 · 第五讲' };

/** [秒, 文本] */
export type Line = [number, string];

export interface DemoMedia {
  id: string;
  name: string;
  kind: 'audio' | 'video';
  mimeType: string;
  /** 播放用的资源地址（vite 资源 URL） */
  src: string;
  size: number;
  durationMs: number;
  folderId: string | null;
  createdAgo: number;
  /** 最近观看距今（毫秒）；null = 从未播放 */
  watchedAgo: number | null;
  positionSec: number;
  watchedMin: number;
  finished: boolean;
  /** 字幕：B 站字幕轨 / 已有字幕 = import，转写 = asr；null = 未转写 */
  source: 'asr' | 'import' | null;
  lines: Line[];
  /** B 站分 P */
  bilibili?: { page: number; part: string; cid: number };
  /** 讲义幻灯片（时间轴，供「截帧提问」与讲义插图说明） */
  slides?: Array<{ at: number; title: string; caption: string }>;
}

const P4_LINES: Line[] = [
  [0, '好，我们开始这一讲。'],
  [2, '上一讲我们学会了求特征值和特征向量，'],
  [5, '今天回答一个问题：'],
  [8, '什么样的矩阵可以相似于对角矩阵？'],
  [13, '先回顾一下定义。'],
  [16, '若存在可逆矩阵 P，使 P⁻¹AP = Λ，'],
  [23, '就称 A 可以相似对角化。'],
  [28, '那么判断的依据是什么？'],
  [33, '来看下面这个定理。'],
  [37, 'n 阶矩阵 A 可对角化，'],
  [41, '当且仅当 A 有 n 个线性无关的特征向量。'],
  [48, '这时 P 的列就是这 n 个特征向量，'],
  [54, 'Λ 的对角线上依次是对应的特征值。'],
  [61, '为什么？把 AP = PΛ 按列拆开来看，'],
  [68, '第 i 列就是 Aξᵢ = λᵢξᵢ。'],
  [75, '所以对角化，本质上就是找够 n 个线性无关的特征向量。'],
  [84, 'P 可逆，正好要求这些列线性无关。'],
  [95, '注意顺序：P 的第几列，对应 Λ 的第几个对角元。'],
  [108, '列的顺序换了，Λ 的对角元跟着换，结论仍然成立。'],
  [122, '很多同学在这里丢分，写 P 和 Λ 时顺序对不上。'],
  [140, '再强调一点：特征向量不唯一，'],
  [150, '乘一个非零常数仍然是特征向量，所以 P 也不唯一。'],
  [170, '但 Λ 在不计顺序的意义下是唯一的。'],
  [195, '证明的思路我们简单过一下。'],
  [205, '必要性：P⁻¹AP = Λ，则 AP = PΛ，P 的 n 列就是特征向量。'],
  [225, '充分性：有 n 个线性无关的特征向量，就把它们排成 P。'],
  [245, 'P 的列线性无关，所以 P 可逆，于是 P⁻¹AP = Λ。'],
  [270, '这个定理给出了判别方法，但直接用并不方便。'],
  [300, '下面看一个很常用的推论。'],
  [306, '如果 A 有 n 个互不相同的特征值，'],
  [312, '那么 A 一定可以对角化。'],
  [320, '依据是：属于不同特征值的特征向量线性无关。'],
  [340, '每个特征值至少取一个特征向量，凑够 n 个，就满足定理。'],
  [365, '但要注意，这只是充分条件，不是必要条件。'],
  [382, '举个最简单的反例：单位矩阵 E。'],
  [392, '它只有一个特征值 1，是 n 重的，'],
  [402, '可它本身就是对角阵，当然可以对角化。'],
  [430, '所以特征值有重复时，不能直接下结论，'],
  [445, '需要进一步检查。'],
  [470, '考试里常见的说法是「A 有 n 个不同的特征值」，'],
  [482, '看到这个条件，直接就能说 A 可对角化。'],
  [492, '那反过来，看到重特征值，我们该怎么判断呢？'],
  [510, '这就要引入两个概念：代数重数和几何重数。'],
  [540, '先放一下，我们把推论的证明补完。'],
  [570, '好，现在来看有重特征值的情形。'],
  [578, '设 λ 是 A 的一个特征值。'],
  [584, '它作为特征多项式根的重数，叫代数重数；'],
  [595, '它的特征子空间的维数，叫几何重数。'],
  [606, '几何重数等于 n 减去 λE − A 的秩。'],
  [620, '一个基本事实：几何重数总是小于等于代数重数，'],
  [640, '而且至少是 1。'],
  [660, '于是有下面这个定理：'],
  [668, 'A 可对角化，当且仅当每个特征值的几何重数都等于代数重数。'],
  [690, '直观地说，每个特征值都要「交够」自己那一份特征向量。'],
  [720, '只要有一个特征值交不够，总数就凑不满 n 个。'],
  [750, '实际计算时，单根一定没问题，'],
  [760, '只需检查重根：看 r(λE − A) 是否等于 n 减重数。'],
  [800, '比如二重根，就要求 r(λE − A) = n − 2。'],
  [840, '这是判断可对角化最常用的方法，大家一定记住。'],
  [880, '下面我们做一道例题。'],
  [900, '例 5.9，A 是这个三阶矩阵，对角线是 4，其余元素都是 1。'],
  [915, '问能否对角化，能的话求出 P。'],
  [930, '第一步，求特征多项式。'],
  [945, '把各列加到第一列，提出公因子，'],
  [960, '得到 |λE − A| = (λ − 6)(λ − 3)²。'],
  [985, '所以特征值是 3（二重）和 6。'],
  [1005, '第二步，检查二重根 λ = 3。'],
  [1020, '3E − A 的每个元素都是 −1，'],
  [1030, '秩等于 1，几何重数 3 − 1 = 2，'],
  [1045, '等于代数重数 2，所以 A 可以对角化。'],
  [1080, '其实 A 是实对称矩阵，下一讲会看到，实对称矩阵一定可以对角化。'],
  [1140, '第三步，求特征向量。'],
  [1150, 'λ = 3 时，解 x₁ + x₂ + x₃ = 0，'],
  [1162, '取 ξ₁ = (−1, 1, 0)ᵀ，ξ₂ = (−1, 0, 1)ᵀ。'],
  [1180, 'λ = 6 时，解得 ξ₃ = (1, 1, 1)ᵀ。'],
  [1200, '令 P = (ξ₁, ξ₂, ξ₃)，'],
  [1210, '就有 P⁻¹AP = diag(3, 3, 6)。'],
  [1240, '再强调一遍顺序：P 的列和对角元一一对应。'],
  [1270, '最后总结一下这一讲的判断流程：'],
  [1280, '先求特征值，单根不用管，'],
  [1290, '重根逐个检查几何重数，'],
  [1300, '都满足，就把特征向量按顺序排成 P。'],
  [1325, '下一讲我们讲实对称矩阵的对角化。'],
  [1340, '好，这一讲就到这里。'],
];

const P4_SLIDES = [
  { at: 0, title: '第五讲 特征值与对角化', caption: '标题页：第五讲 特征值与对角化 · 5.4 对角化的条件' },
  { at: 33, title: '定理 5.6', caption: '定理 5.6：n 阶矩阵 A 可对角化 ⟺ A 有 n 个线性无关的特征向量；P 的列为特征向量，P⁻¹AP = Λ' },
  { at: 300, title: '推论 5.7', caption: '推论 5.7：n 个互不相同的特征值 ⇒ 可对角化（充分不必要，反例：单位矩阵）' },
  { at: 570, title: '定理 5.8', caption: '定理 5.8：可对角化 ⟺ 每个特征值的几何重数 = 代数重数；几何重数 = n − r(λE − A)' },
  { at: 900, title: '例 5.9', caption: '例 5.9：A 对角元为 4、其余为 1，|λE − A| = (λ − 6)(λ − 3)²，r(3E − A) = 1' },
  { at: 1140, title: '例 5.9（续）', caption: '例 5.9（续）：ξ₁ = (−1,1,0)ᵀ，ξ₂ = (−1,0,1)ᵀ，ξ₃ = (1,1,1)ᵀ，P⁻¹AP = diag(3,3,6)' },
];

const P1_LINES: Line[] = [
  [0, '这一讲开始我们进入第五章，特征值与特征向量。'],
  [12, '先看定义：如果 Aξ = λξ，并且 ξ 不是零向量，'],
  [24, '就称 λ 是 A 的特征值，ξ 是属于 λ 的特征向量。'],
  [60, '几何上看，A 作用在 ξ 上，只把它伸缩了 λ 倍，方向不变。'],
  [140, '怎么求？把等式移项，得到 (λE − A)x = 0。'],
  [175, '要有非零解，系数行列式必须为零。'],
  [260, '所以先解 |λE − A| = 0 求出特征值，'],
  [300, '再对每个特征值解齐次方程组，求出特征向量。'],
  [480, '来看一个二阶的例子。'],
  [760, '注意：特征向量的非零线性组合，仍然是同一特征值的特征向量。'],
  [1050, '这一点下一讲讲特征子空间时还会用到。'],
  [1260, '好，这一讲就到这里。'],
];

const P2_LINES: Line[] = [
  [0, '这一讲我们专门讨论特征多项式。'],
  [15, 'f(λ) = |λE − A| 是 λ 的 n 次多项式，'],
  [40, '它的 n 个根就是 A 的 n 个特征值，重根按重数计算。'],
  [180, '两个很有用的结论：特征值之和等于 A 的迹，'],
  [200, '特征值之积等于 A 的行列式。'],
  [420, '由此可知：A 可逆，当且仅当 0 不是 A 的特征值。'],
  [700, '再看 A 的多项式 g(A) 的特征值：就是 g(λ)。'],
  [1040, '这在计算 A 的高次幂时非常方便。'],
];

const P3_LINES: Line[] = [
  [0, '这一讲讲相似矩阵。'],
  [10, '若存在可逆矩阵 P，使 P⁻¹AP = B，就称 A 与 B 相似。'],
  [90, '相似是一种等价关系：反身、对称、传递。'],
  [240, '相似矩阵有相同的特征多项式，因此特征值相同。'],
  [300, '迹和行列式也都相同，秩也相同。'],
  [520, '但反过来不成立：特征值相同的两个矩阵未必相似。'],
  [610, '比如单位矩阵和一个二阶若尔当块。'],
  [960, '下一讲的问题是：什么时候 A 能相似于一个对角阵？'],
];

const P5_LINES: Line[] = [
  [0, '这一讲我们做几道综合例题。'],
  [30, '例 1：已知 A 的一个特征值，反求矩阵里的参数。'],
  [360, '例 2：由 P⁻¹AP = Λ，计算 A 的 100 次幂。'],
  [400, '关键是 A = PΛP⁻¹，于是 A¹⁰⁰ = PΛ¹⁰⁰P⁻¹。'],
  [760, '例 3：抽象矩阵的相似对角化。'],
  [1150, '例 4：历年真题，判断矩阵能否对角化。'],
  [1480, '好，第五讲到这里就全部结束了。'],
];

const PROB_LINES: Line[] = [
  [0, '同学们，我们开始上课，今天讲第七章参数估计。'],
  [45, '先回顾一下，样本均值和样本方差的分布。'],
  [320, '参数估计分两类：点估计和区间估计。'],
  [610, '点估计最常用的两种方法：矩估计和最大似然估计。'],
  [900, '矩估计的想法很朴素：用样本矩去估计总体矩。'],
  [1500, '最大似然估计：选使样本出现概率最大的参数值。'],
  [1800, '步骤是：写似然函数，取对数，求导，令导数为零。'],
  [2330, '我们看一个正态总体的例子。'],
  [2900, '下面讲估计量的评选标准：无偏性、有效性、相合性。'],
  [3600, '无偏：估计量的期望等于被估参数。'],
  [4300, '接下来讲区间估计，置信水平 1 − α。'],
  [5100, '下次课讲假设检验，大家回去把习题 7.3 做一下。'],
];

const ENGLISH_LINES: Line[] = [
  [0, 'Welcome to Unit 5. Today we will practise listening for main ideas.'],
  [40, 'First, listen to a short lecture about urban green spaces.'],
  [300, 'Notice how the speaker signals a new point: "Another reason is…"'],
  [620, 'Now let\'s focus on numbers and dates in the passage.'],
  [980, 'Section B: a conversation between a student and a librarian.'],
  [1400, 'Pay attention to the question words: who, where, why.'],
  [1900, 'Section C: a news report. Try to note down the key facts.'],
  [2500, 'That\'s all for Unit 5. Review the new words before next class.'],
];

/** 有机化学实验视频：未转写，演示里点「转写」后逐段出现 */
export const CHEM_LINES: Line[] = [
  [0, '今天这个实验演示两种亲核取代反应。'],
  [18, '左边试管是溴代叔丁烷，右边是 1-溴丁烷。'],
  [52, '分别加入硝酸银的乙醇溶液。'],
  [96, '可以看到左边很快出现浅黄色沉淀，这是溴化银。'],
  [150, '叔丁基正离子稳定，反应按 SN1 进行，速度快。'],
  [230, '右边要加热一段时间才出现沉淀。'],
  [310, '伯卤代烷更倾向于 SN2，但这个条件下不利于 SN2。'],
  [420, '第二组实验换用碘化钠的丙酮溶液。'],
  [500, '这时 1-溴丁烷反应很快，生成白色的溴化钠沉淀。'],
  [600, '因为 SN2 是一步完成的背面进攻，空间位阻小更有利。'],
  [760, '叔丁基位阻太大，几乎不反应。'],
  [900, '总结一下：底物结构决定反应走 SN1 还是 SN2。'],
  [1040, '课后请写出两组实验的反应式和机理。'],
];

const kb = (n: number) => n * 1024;
const mb = (n: number) => Math.round(n * 1024 * 1024);

export const DEMO_MEDIA: DemoMedia[] = [
  {
    id: 'file_demo_la5_p1', name: `${COURSE_TITLE} P1 特征值与特征向量.bilibili`, kind: 'video', mimeType: 'video/x-bilibili',
    src: p1Url, size: kb(1), durationMs: 1296_000, folderId: COURSE_FOLDER.id, createdAgo: 9 * DAY,
    watchedAgo: 4 * DAY, positionSec: 1296, watchedMin: 22, finished: true, source: 'import', lines: P1_LINES,
    bilibili: { page: 1, part: '特征值与特征向量', cid: 1580214401 },
  },
  {
    id: 'file_demo_la5_p2', name: `${COURSE_TITLE} P2 特征多项式.bilibili`, kind: 'video', mimeType: 'video/x-bilibili',
    src: p2Url, size: kb(1), durationMs: 1085_000, folderId: COURSE_FOLDER.id, createdAgo: 9 * DAY,
    watchedAgo: 3 * DAY, positionSec: 1085, watchedMin: 19, finished: true, source: 'import', lines: P2_LINES,
    bilibili: { page: 2, part: '特征多项式', cid: 1580214402 },
  },
  {
    id: 'file_demo_la5_p3', name: `${COURSE_TITLE} P3 相似矩阵.bilibili`, kind: 'video', mimeType: 'video/x-bilibili',
    src: p3Url, size: kb(1), durationMs: 1002_000, folderId: COURSE_FOLDER.id, createdAgo: 9 * DAY,
    watchedAgo: 1 * DAY + 2 * HOUR, positionSec: 1002, watchedMin: 17, finished: true, source: 'import', lines: P3_LINES,
    bilibili: { page: 3, part: '相似矩阵', cid: 1580214403 },
  },
  {
    id: 'file_demo_la5_p4', name: `${COURSE_TITLE} P4 对角化的条件.bilibili`, kind: 'video', mimeType: 'video/x-bilibili',
    src: p4Url, size: kb(1), durationMs: 1368_000, folderId: COURSE_FOLDER.id, createdAgo: 9 * DAY,
    watchedAgo: 25 * MIN, positionSec: 492, watchedMin: 14, finished: false, source: 'import', lines: P4_LINES,
    bilibili: { page: 4, part: '对角化的条件', cid: 1580214404 },
    slides: P4_SLIDES,
  },
  {
    id: 'file_demo_la5_p5', name: `${COURSE_TITLE} P5 例题精讲.bilibili`, kind: 'video', mimeType: 'video/x-bilibili',
    src: p5Url, size: kb(1), durationMs: 1510_000, folderId: COURSE_FOLDER.id, createdAgo: 9 * DAY,
    watchedAgo: null, positionSec: 0, watchedMin: 0, finished: false, source: 'import', lines: P5_LINES,
    bilibili: { page: 5, part: '例题精讲', cid: 1580214405 },
  },
  {
    id: 'file_demo_prob7', name: '概率论 第 7 讲 课堂录音.m4a', kind: 'audio', mimeType: 'audio/mp4',
    src: probUrl, size: mb(84.6), durationMs: 5530_000, folderId: null, createdAgo: 6 * DAY,
    watchedAgo: 2 * DAY, positionSec: 2330, watchedMin: 41, finished: false, source: 'asr', lines: PROB_LINES,
  },
  {
    id: 'file_demo_chem_sn', name: '有机化学 亲核取代反应演示.mp4', kind: 'video', mimeType: 'video/mp4',
    src: chemUrl, size: mb(126.3), durationMs: 1104_000, folderId: null, createdAgo: 3 * HOUR,
    watchedAgo: null, positionSec: 0, watchedMin: 0, finished: false, source: null, lines: [],
  },
  {
    id: 'file_demo_english_u5', name: '英语听力 Unit 5 精讲.mp3', kind: 'audio', mimeType: 'audio/mpeg',
    src: englishUrl, size: mb(42.2), durationMs: 2765_000, folderId: null, createdAgo: 12 * DAY,
    watchedAgo: 5 * DAY, positionSec: 2765, watchedMin: 46, finished: true, source: 'import', lines: ENGLISH_LINES,
  },
];

export const P4_ID = 'file_demo_la5_p4';
export const CHEM_ID = 'file_demo_chem_sn';

/** 已有的讲义笔记（P4） */
export const PRESET_HANDOUT = {
  id: 'note_demo_la5_p4_handout',
  title: '对角化的条件 · 讲义',
  resourceId: P4_ID,
  updatedAgo: 2 * DAY,
};

/** 「从 B 站链接导入」解析出的另一门虚构课程（概率论与数理统计 · 第七章） */
export const PROBE_COURSE = {
  bvid: 'BV1Rk4y1G7Pz',
  title: '概率论与数理统计 第七章 参数估计',
  owner: COURSE_OWNER,
  cover: coverPe7Url,
  pages: [
    { page: 1, cid: 1610730101, part: '点估计与矩估计', durationMs: 1532_000, src: pe1Url },
    { page: 2, cid: 1610730102, part: '最大似然估计', durationMs: 1846_000, src: pe2Url },
    { page: 3, cid: 1610730103, part: '估计量的评选标准', durationMs: 1418_000, src: pe3Url },
  ],
  lines: [
    [0, '这一节我们讲参数估计。'],
    [20, '总体分布的形式已知，但其中的参数未知，'],
    [45, '要用样本来估计它，这就是参数估计问题。'],
    [120, '先看矩估计：用样本矩代替总体矩。'],
    [400, '再看一个例子：均匀分布 U(0, θ) 的矩估计。'],
    [900, '下一节我们讲最大似然估计。'],
  ] as Line[],
};

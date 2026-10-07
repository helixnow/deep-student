/**
 * 题目集演示的种子数据：三个题目集（高等数学为主，另两个只为让错题本跨题目集）。
 * 作答状态是「做过一阵子」的样子：有已掌握、有错题待复习、有学习中和新题。
 */
import type { Question } from '@/stores/questionBankStore';

export interface DemoExamSet {
  id: string;
  name: string;
  createdAt: string;
  updatedAt: string;
}

export const QB_MAIN_ID = 'exam_demo_calculus';

export const DEMO_EXAM_SETS: DemoExamSet[] = [
  { id: QB_MAIN_ID, name: '高等数学 · 极限与导数', createdAt: '2026-09-02T08:30:00Z', updatedAt: '2026-10-05T21:10:00Z' },
  { id: 'exam_demo_linalg', name: '线性代数 · 矩阵与行列式', createdAt: '2026-09-10T09:00:00Z', updatedAt: '2026-10-03T20:40:00Z' },
  { id: 'exam_demo_mlsys', name: '机器学习系统 · 分布式训练', createdAt: '2026-09-18T14:00:00Z', updatedAt: '2026-10-01T16:20:00Z' },
];

type Seed = Omit<Question, 'id' | 'exam_id' | 'created_at' | 'updated_at' | 'images' | 'is_favorite' | 'source_type' | 'attempt_count' | 'correct_count' | 'status'> &
  Partial<Pick<Question, 'is_favorite' | 'source_type' | 'attempt_count' | 'correct_count' | 'status'>>;

const CALCULUS: Seed[] = [
  {
    question_label: '1', question_type: 'single_choice', difficulty: 'easy', tags: ['重要极限'],
    content: '极限 $\\lim\\limits_{x\\to 0}\\dfrac{\\sin 3x}{x}$ 的值为',
    options: [{ key: 'A', content: '$0$' }, { key: 'B', content: '$1$' }, { key: 'C', content: '$3$' }, { key: 'D', content: '$\\dfrac{1}{3}$' }],
    answer: 'C', explanation: '凑成重要极限：$\\dfrac{\\sin 3x}{x}=3\\cdot\\dfrac{\\sin 3x}{3x}\\to 3$。',
    status: 'mastered', attempt_count: 2, correct_count: 2, user_answer: 'C', is_correct: true,
  },
  {
    question_label: '2', question_type: 'single_choice', difficulty: 'medium', tags: ['重要极限', '幂指型极限'],
    content: '$\\lim\\limits_{x\\to\\infty}\\left(1+\\dfrac{2}{x}\\right)^{x}=$',
    options: [{ key: 'A', content: '$e$' }, { key: 'B', content: '$e^{2}$' }, { key: 'C', content: '$2e$' }, { key: 'D', content: '$1$' }],
    answer: 'B', explanation: '$\\left(1+\\dfrac{2}{x}\\right)^{x}=\\left[\\left(1+\\dfrac{2}{x}\\right)^{x/2}\\right]^{2}\\to e^{2}$。常见错误是把指数里的 2 漏掉而选 $e$。',
    status: 'review', attempt_count: 2, correct_count: 0, user_answer: 'A', is_correct: false, is_favorite: true,
  },
  {
    question_label: '3', question_type: 'multiple_choice', difficulty: 'medium', tags: ['无穷小比较'],
    content: '当 $x\\to 0$ 时，下列无穷小中与 $x$ 等价的有',
    options: [{ key: 'A', content: '$\\sin x$' }, { key: 'B', content: '$\\ln(1+x)$' }, { key: 'C', content: '$1-\\cos x$' }, { key: 'D', content: '$e^{x}-1$' }],
    answer: 'ABD', explanation: '$\\sin x\\sim x$，$\\ln(1+x)\\sim x$，$e^{x}-1\\sim x$；而 $1-\\cos x\\sim\\dfrac{x^{2}}{2}$ 是 $x$ 的高阶无穷小。',
    status: 'review', attempt_count: 1, correct_count: 0, user_answer: 'ABCD', is_correct: false,
  },
  {
    question_label: '4', question_type: 'true_false', difficulty: 'easy', tags: ['连续与可导'],
    content: '函数在某点连续，则它在该点一定可导。',
    answer: 'false', explanation: '可导必连续，连续不一定可导。反例：$f(x)=|x|$ 在 $x=0$ 处连续但不可导。',
    status: 'mastered', attempt_count: 2, correct_count: 2, user_answer: 'false', is_correct: true,
  },
  {
    question_label: '5', question_type: 'fill_blank', difficulty: 'easy', tags: ['导数计算'],
    content: '设 $f(x)=x^{2}e^{x}$，则 $f\'(0)=$ ____。',
    answer: '0', explanation: '$f\'(x)=2xe^{x}+x^{2}e^{x}$，代入 $x=0$ 得 $0$。',
    structured_data: { blanks: [{ answers: ['0'] }] },
    status: 'in_progress', attempt_count: 1, correct_count: 1, user_answer: '0', is_correct: true,
  },
  {
    question_label: '6', question_type: 'single_choice', difficulty: 'medium', tags: ['洛必达法则'],
    content: '$\\lim\\limits_{x\\to 0}\\dfrac{e^{x}-1-x}{x^{2}}=$',
    options: [{ key: 'A', content: '$0$' }, { key: 'B', content: '$\\dfrac{1}{2}$' }, { key: 'C', content: '$1$' }, { key: 'D', content: '$\\infty$' }],
    answer: 'B', explanation: '两次洛必达：$\\dfrac{e^{x}-1}{2x}\\to\\dfrac{e^{x}}{2}\\to\\dfrac{1}{2}$；或用泰勒展开 $e^{x}=1+x+\\dfrac{x^{2}}{2}+o(x^{2})$。',
  },
  {
    question_label: '7', question_type: 'numeric', difficulty: 'medium', tags: ['导数应用'],
    content: '曲线 $y=x^{3}-3x$ 在区间 $[0,2]$ 上的最小值为多少？',
    answer: '-2', explanation: '$y\'=3x^{2}-3=0$ 得 $x=1$；比较 $y(0)=0$、$y(1)=-2$、$y(2)=2$，最小值为 $-2$。',
    structured_data: { answer_value: -2, tolerance: 0 },
    status: 'review', attempt_count: 1, correct_count: 0, user_answer: '0', is_correct: false,
  },
  {
    question_label: '8', question_type: 'single_choice', difficulty: 'hard', tags: ['洛必达法则', '无穷小比较'],
    content: '若 $x\\to 0$ 时 $x-\\sin x$ 与 $ax^{k}$ 是等价无穷小，则',
    options: [{ key: 'A', content: '$a=\\dfrac{1}{6},\\ k=3$' }, { key: 'B', content: '$a=\\dfrac{1}{3},\\ k=3$' }, { key: 'C', content: '$a=\\dfrac{1}{6},\\ k=2$' }, { key: 'D', content: '$a=\\dfrac{1}{2},\\ k=2$' }],
    answer: 'A', explanation: '$\\sin x=x-\\dfrac{x^{3}}{6}+o(x^{3})$，故 $x-\\sin x\\sim\\dfrac{x^{3}}{6}$。',
  },
  {
    question_label: '9', question_type: 'calculation', difficulty: 'medium', tags: ['导数计算'],
    content: '求由方程 $e^{y}+xy=e$ 所确定的隐函数在 $x=0$ 处的导数 $\\dfrac{dy}{dx}$。',
    answer: '$-\\dfrac{1}{e}$', explanation: '两边对 $x$ 求导：$e^{y}y\'+y+xy\'=0$。$x=0$ 时 $y=1$，代入得 $e\\,y\'+1=0$，$y\'=-\\dfrac{1}{e}$。',
    status: 'in_progress', attempt_count: 1, correct_count: 1, user_answer: 'y\' = -1/e', is_correct: true,
  },
  {
    question_label: '10', question_type: 'short_answer', difficulty: 'medium', tags: ['连续与可导'],
    content: '简述函数 $f(x)$ 在点 $x_0$ 处「可导」与「可微」的关系。',
    answer: '一元函数中可导与可微等价：$f$ 在 $x_0$ 可微当且仅当 $f\'(x_0)$ 存在，且 $dy=f\'(x_0)\\,dx$。',
    explanation: '可微定义为 $\\Delta y=A\\Delta x+o(\\Delta x)$，可证 $A=f\'(x_0)$；反之导数存在即可写出这种线性主部。',
  },
  {
    question_label: '11', question_type: 'multiple_choice', difficulty: 'hard', tags: ['导数应用'],
    content: '关于函数 $f(x)=x^{4}$，下列说法正确的有',
    options: [{ key: 'A', content: '$x=0$ 是极小值点' }, { key: 'B', content: '$f\'\'(0)=0$' }, { key: 'C', content: '$(0,0)$ 是拐点' }, { key: 'D', content: '$f$ 在 $\\mathbb{R}$ 上是凹函数（下凸）' }],
    answer: 'ABD', explanation: '$f\'\'(x)=12x^{2}\\ge 0$ 处处成立，图形下凸，没有拐点；$x=0$ 处 $f\'\'(0)=0$ 但仍是极小值点——二阶导为零时判别法失效，要回到定义或更高阶导数。',
  },
  {
    question_label: '12', question_type: 'fill_blank', difficulty: 'easy', tags: ['重要极限'],
    content: '$\\lim\\limits_{n\\to\\infty}\\left(1-\\dfrac{1}{n}\\right)^{n}=$ ____。',
    answer: '$e^{-1}$', explanation: '$\\left(1-\\dfrac{1}{n}\\right)^{n}=\\left[\\left(1+\\dfrac{1}{-n}\\right)^{-n}\\right]^{-1}\\to e^{-1}$。',
    structured_data: { blanks: [{ answers: ['e^{-1}', '$e^{-1}$', '1/e', 'e^-1'] }] },
  },
];

const LINALG: Seed[] = [
  {
    question_label: '1', question_type: 'single_choice', difficulty: 'medium', tags: ['行列式'],
    content: '设 $A$ 为 3 阶方阵且 $|A|=2$，则 $|2A|=$',
    options: [{ key: 'A', content: '$4$' }, { key: 'B', content: '$8$' }, { key: 'C', content: '$16$' }, { key: 'D', content: '$32$' }],
    answer: 'C', explanation: '$|kA|=k^{n}|A|$，这里 $n=3$：$|2A|=2^{3}\\times 2=16$。',
    status: 'review', attempt_count: 2, correct_count: 0, user_answer: 'A', is_correct: false,
  },
  {
    question_label: '2', question_type: 'true_false', difficulty: 'easy', tags: ['矩阵运算'],
    content: '对任意 $n$ 阶方阵 $A,B$，都有 $(AB)^{T}=A^{T}B^{T}$。',
    answer: 'false', explanation: '转置会交换顺序：$(AB)^{T}=B^{T}A^{T}$。',
    status: 'review', attempt_count: 1, correct_count: 0, user_answer: 'true', is_correct: false,
  },
  {
    question_label: '3', question_type: 'fill_blank', difficulty: 'medium', tags: ['秩'],
    content: '矩阵 $\\begin{pmatrix}1&2&3\\\\2&4&6\\\\1&0&1\\end{pmatrix}$ 的秩为 ____。',
    answer: '2', explanation: '第二行是第一行的 2 倍，第一、三行线性无关，秩为 2。',
    structured_data: { blanks: [{ answers: ['2'] }] },
    status: 'mastered', attempt_count: 2, correct_count: 2, user_answer: '2', is_correct: true,
  },
];

const MLSYS: Seed[] = [
  {
    question_label: '1', question_type: 'single_choice', difficulty: 'medium', tags: ['数据并行'],
    content: '数据并行训练中，每一步结束前各卡之间需要同步的是',
    options: [{ key: 'A', content: '输入数据' }, { key: 'B', content: '梯度' }, { key: 'C', content: '激活值' }, { key: 'D', content: '学习率' }],
    answer: 'B', explanation: '每张卡持有完整模型副本、处理不同的数据分片；反向传播后用 AllReduce 聚合梯度，再各自更新参数。',
    status: 'review', attempt_count: 1, correct_count: 0, user_answer: 'C', is_correct: false,
  },
  {
    question_label: '2', question_type: 'multiple_choice', difficulty: 'hard', tags: ['显存优化'],
    content: '以下哪些技术可以降低单卡训练显存占用？',
    options: [{ key: 'A', content: '梯度检查点（重计算）' }, { key: 'B', content: 'ZeRO 优化器状态分片' }, { key: 'C', content: '增大全局批大小' }, { key: 'D', content: '混合精度训练' }],
    answer: 'ABD', explanation: '重计算以时间换显存；ZeRO 把优化器状态/梯度/参数分片到各卡；混合精度减半激活与梯度存储。增大批大小反而增加激活显存。',
    status: 'in_progress', attempt_count: 2, correct_count: 1, user_answer: 'ABD', is_correct: true,
  },
];

function daysAgo(days: number, hour = 20): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  d.setHours(hour, 15, 0, 0);
  return d.toISOString();
}

function build(examId: string, seeds: Seed[], baseDays: number): Question[] {
  return seeds.map((seed, i) => {
    const attempted = (seed.attempt_count ?? 0) > 0;
    return {
      ...seed,
      id: `${examId.replace('exam_demo_', 'q_')}_${i + 1}`,
      exam_id: examId,
      tags: seed.tags,
      images: [],
      is_favorite: seed.is_favorite ?? false,
      source_type: seed.source_type ?? 'ai_generated',
      status: seed.status ?? 'new',
      attempt_count: seed.attempt_count ?? 0,
      correct_count: seed.correct_count ?? 0,
      last_attempt_at: attempted ? daysAgo((i % 4) + 1) : undefined,
      created_at: daysAgo(baseDays, 9),
      updated_at: attempted ? daysAgo((i % 4) + 1) : daysAgo(baseDays, 9),
    } as Question;
  });
}

export function buildSeedQuestions(): Question[] {
  return [
    ...build(QB_MAIN_ID, CALCULUS, 30),
    ...build('exam_demo_linalg', LINALG, 24),
    ...build('exam_demo_mlsys', MLSYS, 16),
  ];
}

export { daysAgo };

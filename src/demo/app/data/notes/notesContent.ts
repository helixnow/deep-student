/**
 * 笔记章演示的知识库内容：两门课的文件夹、九篇笔记（标题 / 列表 / 公式 / 双链 / 标签 / 学习属性）。
 * 双链 [[标题]] 互相指向，「链接」面板的反向链接与图谱都有内容。
 */

export interface DemoFolderSeed {
  id: string;
  parentId: string | null;
  title: string;
  sortOrder: number;
}

export interface DemoNoteSeed {
  id: string;
  title: string;
  folderId: string | null;
  tags: string[];
  props?: Record<string, string>;
  favorite?: boolean;
  /** 相对今天的天数（负数 = 过去），用于创建 / 更新时间 */
  createdDaysAgo: number;
  updatedDaysAgo: number;
  content: string;
}

export const FOLDER_LA = 'fd_demo_linear_algebra';
export const FOLDER_LA_WRONG = 'fd_demo_la_mistakes';
export const FOLDER_MLSYS = 'fd_demo_mlsys';

export const DEMO_FOLDERS: DemoFolderSeed[] = [
  { id: FOLDER_LA, parentId: null, title: '线性代数', sortOrder: 0 },
  { id: FOLDER_LA_WRONG, parentId: FOLDER_LA, title: '错题复盘', sortOrder: 0 },
  { id: FOLDER_MLSYS, parentId: null, title: '机器学习系统', sortOrder: 1 },
];

export const NOTE_EIGEN_ID = 'note_demo_eigen';

/** 今天往后 n 天的本地日历日期（学习属性的复习日期） */
function dayOffset(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

export const DEMO_NOTES: DemoNoteSeed[] = [
  {
    id: NOTE_EIGEN_ID,
    title: '特征值与特征向量',
    folderId: FOLDER_LA,
    tags: ['线性代数', '期末复习'],
    favorite: true,
    props: {
      study_course: '线性代数',
      study_chapter: '第 5 章',
      study_mastery: 'learning',
      study_review_date: dayOffset(1),
      来源: '同济版教材 + 课堂笔记',
    },
    createdDaysAgo: 9,
    updatedDaysAgo: 0,
    content: `## 定义

设 $A$ 是 $n$ 阶方阵，若存在数 $\\lambda$ 和**非零**向量 $\\boldsymbol{x}$ 使

$$
A\\boldsymbol{x}=\\lambda\\boldsymbol{x}
$$

则称 $\\lambda$ 为 $A$ 的**特征值**，$\\boldsymbol{x}$ 为对应的**特征向量**。移项得齐次方程组 $(\\lambda E-A)\\boldsymbol{x}=\\boldsymbol{0}$，它有非零解当且仅当

$$
\\lvert \\lambda E-A\\rvert = 0
$$

这就是**特征方程**，左边是关于 $\\lambda$ 的 $n$ 次多项式（特征多项式）。行列式的展开技巧见 [[行列式的计算]]。

## 求解步骤

1. 写出特征多项式 $\\lvert \\lambda E-A\\rvert$，因式分解求出全部特征值 $\\lambda_1,\\dots,\\lambda_n$
2. 对每个 $\\lambda_i$，解齐次方程组 $(\\lambda_i E-A)\\boldsymbol{x}=\\boldsymbol{0}$
3. 基础解系就是属于 $\\lambda_i$ 的线性无关特征向量，全体非零线性组合即全部特征向量

## 重要性质

- 特征值之和等于迹：$\\sum_{i=1}^{n}\\lambda_i=\\operatorname{tr}A$
- 特征值之积等于行列式：$\\prod_{i=1}^{n}\\lambda_i=\\lvert A\\rvert$，所以 $A$ 可逆 $\\iff$ 没有零特征值
- 属于**不同**特征值的特征向量线性无关
- 若 $A\\boldsymbol{x}=\\lambda\\boldsymbol{x}$，则 $f(A)\\boldsymbol{x}=f(\\lambda)\\boldsymbol{x}$，例如 $A^{-1}$ 的特征值为 $\\dfrac{1}{\\lambda}$

> 易错：特征向量必须非零；同一个特征值的特征向量有无穷多个。错题见 [[错题复盘 · 第 5 章]]。

## 例题

求 $A=\\begin{pmatrix}2&1\\\\1&2\\end{pmatrix}$ 的特征值。

$\\lvert \\lambda E-A\\rvert=(\\lambda-2)^2-1=(\\lambda-1)(\\lambda-3)$，所以 $\\lambda_1=1,\\ \\lambda_2=3$；对应特征向量 $(1,-1)^{\\mathrm T}$ 与 $(1,1)^{\\mathrm T}$。验算：$1+3=4=\\operatorname{tr}A$，$1\\times3=3=\\lvert A\\rvert$。

## 和后面章节的联系

- [[矩阵的相似对角化]]：有 $n$ 个线性无关的特征向量 $\\iff$ 可对角化
- [[二次型与正定矩阵]]：实对称矩阵的特征值决定二次型的标准形与正定性
- 机器学习里的 PCA 就是对协方差矩阵做特征分解，见 [[数据并行训练]] 前置的数学复习

## 待办

- [x] 整理课本例 5.3、5.5
- [ ] 做完习题 5-2 第 4、7、9 题
- [ ] 周五前把本章生成导图背一遍
`,
  },
  {
    id: 'note_demo_diag',
    title: '矩阵的相似对角化',
    folderId: FOLDER_LA,
    tags: ['线性代数'],
    props: {
      study_course: '线性代数',
      study_chapter: '第 5 章',
      study_mastery: 'needs-review',
      study_review_date: dayOffset(-1),
    },
    createdDaysAgo: 7,
    updatedDaysAgo: 2,
    content: `## 相似

若存在可逆矩阵 $P$ 使 $P^{-1}AP=B$，称 $A$ 与 $B$ **相似**。相似矩阵有相同的特征多项式，因此特征值、迹、行列式、秩都相同。

## 可对角化的判定

- 充要条件：$A$ 有 $n$ 个线性无关的特征向量（回顾 [[特征值与特征向量]]）
- 充分条件：$A$ 有 $n$ 个互不相同的特征值
- 对每个 $k$ 重特征值 $\\lambda$，要求 $n-r(\\lambda E-A)=k$（几何重数 = 代数重数）

## 对角化步骤

1. 求出全部特征值与特征向量
2. 以特征向量为列拼出 $P=(\\boldsymbol{p}_1,\\dots,\\boldsymbol{p}_n)$
3. $P^{-1}AP=\\Lambda=\\operatorname{diag}(\\lambda_1,\\dots,\\lambda_n)$，**顺序要一一对应**

## 应用：求矩阵的幂

$$
A^{k}=P\\Lambda^{k}P^{-1}
$$

实对称矩阵还能用正交矩阵对角化，见 [[二次型与正定矩阵]]。
`,
  },
  {
    id: 'note_demo_det',
    title: '行列式的计算',
    folderId: FOLDER_LA,
    tags: ['线性代数', '计算技巧'],
    props: { study_course: '线性代数', study_chapter: '第 1 章', study_mastery: 'mastered' },
    createdDaysAgo: 30,
    updatedDaysAgo: 12,
    content: `## 常用方法

- **化三角形**：用行变换把行列式化成上三角，结果是主对角线乘积
- **按行（列）展开**：$D=\\sum_{j} a_{ij}A_{ij}$，优先选零多的一行
- **范德蒙德行列式**：$\\prod_{1\\le j<i\\le n}(x_i-x_j)$

## 性质速记

1. 两行互换，行列式变号
2. 某行乘 $k$，行列式乘 $k$
3. 某行的 $k$ 倍加到另一行，行列式不变
4. $\\lvert AB\\rvert=\\lvert A\\rvert\\lvert B\\rvert$，$\\lvert kA\\rvert=k^{n}\\lvert A\\rvert$

求特征多项式时经常要算含参数 $\\lambda$ 的行列式，技巧同上，见 [[特征值与特征向量]]。
`,
  },
  {
    id: 'note_demo_quadratic',
    title: '二次型与正定矩阵',
    folderId: FOLDER_LA,
    tags: ['线性代数', '期末复习'],
    props: {
      study_course: '线性代数',
      study_chapter: '第 6 章',
      study_mastery: 'unstarted',
      study_review_date: dayOffset(4),
    },
    createdDaysAgo: 3,
    updatedDaysAgo: 3,
    content: `## 二次型的矩阵表示

$$
f(\\boldsymbol{x})=\\boldsymbol{x}^{\\mathrm T}A\\boldsymbol{x},\\quad A^{\\mathrm T}=A
$$

## 化标准形

实对称矩阵 $A$ 一定存在正交矩阵 $Q$，使 $Q^{\\mathrm T}AQ=\\Lambda$。令 $\\boldsymbol{x}=Q\\boldsymbol{y}$，得标准形 $f=\\lambda_1y_1^2+\\dots+\\lambda_ny_n^2$——系数正是 [[特征值与特征向量]] 里求出的特征值。

## 正定的判定

- 全部特征值大于 0
- 顺序主子式全部大于 0（行列式算法见 [[行列式的计算]]）
- 存在可逆矩阵 $C$ 使 $A=C^{\\mathrm T}C$
`,
  },
  {
    id: 'note_demo_mistakes5',
    title: '错题复盘 · 第 5 章',
    folderId: FOLDER_LA_WRONG,
    tags: ['错题', '线性代数'],
    props: { study_course: '线性代数', study_chapter: '第 5 章', study_mastery: 'needs-review', study_review_date: dayOffset(0) },
    createdDaysAgo: 2,
    updatedDaysAgo: 1,
    content: `## 题目

已知 $A^2=A$，求 $A$ 的特征值的可能取值。

## 我的错解

直接写 $\\lambda^2=\\lambda$，得 $\\lambda=1$，**漏了 $\\lambda=0$**。

## 正确思路

设 $A\\boldsymbol{x}=\\lambda\\boldsymbol{x}$，则 $A^2\\boldsymbol{x}=\\lambda^2\\boldsymbol{x}=A\\boldsymbol{x}=\\lambda\\boldsymbol{x}$，因 $\\boldsymbol{x}\\neq\\boldsymbol{0}$ 得 $\\lambda^2-\\lambda=0$，所以 $\\lambda\\in\\{0,1\\}$。

## 反思

- 解方程不能随手约掉 $\\lambda$
- 「矩阵多项式 → 特征值多项式」这条性质见 [[特征值与特征向量]]
`,
  },
  {
    id: 'note_demo_dp',
    title: '数据并行训练',
    folderId: FOLDER_MLSYS,
    tags: ['机器学习系统', '分布式'],
    props: { study_course: '机器学习系统', study_chapter: '第 3 章', study_mastery: 'learning', study_review_date: dayOffset(6) },
    createdDaysAgo: 14,
    updatedDaysAgo: 4,
    content: `## 基本范式

1. 把一个 mini-batch 均分到 $K$ 个 worker，各自前向、反向得到局部梯度 $g_k$
2. 聚合：$g=\\frac{1}{K}\\sum_{k=1}^{K}g_k$，常用 [[AllReduce 通信原语]]
3. 每个 worker 用同一个 $g$ 更新参数，模型副本保持一致

## 同步的代价

- 每步都要等最慢的 worker（straggler）
- 通信量与参数量成正比，大模型下通信时间可能超过计算时间

## 优化方向

- 计算与通信重叠：反向传播一边算一边发送已完成层的梯度
- [[梯度压缩方法]]：量化、稀疏化，减少每步通信字节数
- 增大 batch 并配合学习率预热，降低通信频率
`,
  },
  {
    id: 'note_demo_allreduce',
    title: 'AllReduce 通信原语',
    folderId: FOLDER_MLSYS,
    tags: ['机器学习系统', '分布式'],
    createdDaysAgo: 13,
    updatedDaysAgo: 5,
    content: `## Ring AllReduce

$K$ 个节点排成环，分两阶段：

1. **Reduce-Scatter**：$K-1$ 步后每个节点持有一段完整的归约结果
2. **All-Gather**：再 $K-1$ 步，把各段广播给所有节点

每个节点的通信量约为 $2\\cdot\\frac{K-1}{K}N$，与节点数基本无关，所以比参数服务器更易扩展。

用在 [[数据并行训练]] 的梯度聚合环节。
`,
  },
  {
    id: 'note_demo_compress',
    title: '梯度压缩方法',
    folderId: FOLDER_MLSYS,
    tags: ['机器学习系统'],
    createdDaysAgo: 10,
    updatedDaysAgo: 8,
    content: `## 量化

把 32 位浮点梯度量化成 8 位甚至 1 位（signSGD），通信量降为 $\\frac{1}{4}$ 到 $\\frac{1}{32}$。

## 稀疏化

只发送绝对值最大的 top-$k$ 个分量，其余累积到本地残差，下一步再补发（误差反馈）。

## 代价

压缩引入噪声，可能要更多迭代才能收敛；与 [[AllReduce 通信原语]] 配合时需要支持稀疏格式。参见 [[数据并行训练]]。
`,
  },
  {
    id: 'note_demo_week',
    title: '本周学习计划',
    folderId: null,
    tags: ['计划'],
    createdDaysAgo: 2,
    updatedDaysAgo: 0,
    content: `## 本周目标

- 线性代数第 5 章收尾，能独立做出对角化大题
- 机器学习系统读完第 3 章并整理笔记

## 安排

| 时间 | 内容 | 关联笔记 |
| --- | --- | --- |
| 周一 | 特征值例题 + 习题 5-2 | [[特征值与特征向量]] |
| 周三 | 相似对角化 | [[矩阵的相似对角化]] |
| 周五 | 第 3 章分布式训练 | [[数据并行训练]] |
| 周日 | 错题回顾、背导图 | [[错题复盘 · 第 5 章]] |

## 本周复盘

- [x] 周一任务完成
- [ ] 周三任务
- [ ] 周五任务
`,
  },
];

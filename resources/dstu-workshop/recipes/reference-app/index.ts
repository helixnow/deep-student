// Recipe (Host half): a reference app's built-in data set, served to the UI half through one remote method.
//
// - Keep the data here (or in a .ts/.json file next to it): the UI half asks once and filters locally.
// - Formulas are LaTeX without $ (the UI renders them with MathText). In a TS string a backslash is written twice,
//   or use String.raw`…` as below.
// - No permissions needed: the data ships with the plugin, nothing is read from the user's files or the network.

export interface Formula { id: string; name: string; category: string; tex: string; note: string }

const FORMULAS: Formula[] = [
  { id: 'pythagoras', name: '勾股定理', category: '几何', tex: String.raw`a^2 + b^2 = c^2`, note: '直角三角形两直角边的平方和等于斜边的平方' },
  { id: 'circle-area', name: '圆的面积', category: '几何', tex: String.raw`S = \pi r^2`, note: 'r 为半径' },
  { id: 'quadratic', name: '一元二次方程求根公式', category: '代数', tex: String.raw`x = \frac{-b \pm \sqrt{b^2 - 4ac}}{2a}`, note: '要求 a ≠ 0；判别式 Δ = b² − 4ac 决定实根个数' },
  { id: 'arithmetic-sum', name: '等差数列求和', category: '代数', tex: String.raw`S_n = \frac{n(a_1 + a_n)}{2}`, note: '首项加末项，乘项数除以二' },
  { id: 'geometric-sum', name: '等比数列求和', category: '代数', tex: String.raw`S_n = \frac{a_1(1 - q^n)}{1 - q}`, note: '公比 q ≠ 1' },
  { id: 'sin-cos', name: '平方关系', category: '三角', tex: String.raw`\sin^2\alpha + \cos^2\alpha = 1`, note: '同角三角函数的基本关系' },
  { id: 'double-angle', name: '二倍角公式', category: '三角', tex: String.raw`\sin 2\alpha = 2\sin\alpha\cos\alpha`, note: '余弦：cos 2α = cos²α − sin²α' },
  { id: 'derivative-power', name: '幂函数求导', category: '微积分', tex: String.raw`(x^n)' = n x^{n-1}`, note: 'n 为任意实数' },
  { id: 'newton-leibniz', name: '牛顿—莱布尼茨公式', category: '微积分', tex: String.raw`\int_a^b f(x)\,dx = F(b) - F(a)`, note: 'F 是 f 的一个原函数' },
  { id: 'newton-second', name: '牛顿第二定律', category: '物理', tex: String.raw`F = ma`, note: '合外力等于质量乘加速度' },
  { id: 'kinetic-energy', name: '动能', category: '物理', tex: String.raw`E_k = \frac{1}{2} m v^2`, note: '单位：焦耳（J）' },
];

export default {
  name: '__PLUGIN_ID__',
  meta: { id: '__PLUGIN_ID__', version: '1.0.0', ui: './ui.js', provides: ['__SERVICE__'], remote: { '__SERVICE__': ['list'] } },
  apply(ctx: { provide(name: string, service: unknown): void }) {
    ctx.provide('__SERVICE__', { list(): Formula[] { return FORMULAS; } });
  },
};

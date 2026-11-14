import { font } from '../../theme';
import { barLen, cellCss, cellValue } from './beats';

/**
 * 资料纵深里的纸片纹理（canvas 程序化绘制，DOM 交接替身复用同一张图，保证无缝）。
 * 所有随机都来自固定种子，逐帧渲染可复现。
 */
export type CardType = 'page' | 'note' | 'memory' | 'photo' | 'anki' | 'mindmap';

export const CARD_ASPECT: Record<CardType, number> = {
  page: 1.36,
  note: 1.18,
  memory: 0.64,
  photo: 0.78,
  anki: 0.66,
  mindmap: 0.72,
};

const INK = '#1d1d1f';
const INK2 = '#5b6170';
const BAR = '#dedfe3';
const ACCENT = 'hsl(215 72% 42%)';

const SECTIONS = [
  '罗尔定理', '柯西中值定理', '洛必达法则', '泰勒公式', '函数的单调性', '曲线的凹凸性', '函数的极值与最值',
  '定积分的概念', '牛顿—莱布尼茨公式', '换元积分法', '分部积分法', '反常积分', '极限存在准则', '无穷小的比较',
  '连续函数的性质', '导数的概念', '高阶导数', '隐函数求导', '弧微分与曲率', '矩阵的秩', '特征值与特征向量',
  '二次型', '向量空间', '条件概率', '大数定律', '中心极限定理', '傅里叶级数', '格林公式',
];
const MEMOS = [
  '洛必达前先确认 0/0 型', '泰勒展开别漏余项', '分部积分 u 选对数优先', '换元后积分限要跟着换',
  '凹凸性看二阶导号', '极值点不一定是驻点', '矩阵秩 ≤ min(m, n)', '条件概率先画树状图',
];
const ANKI_Q = ['罗尔定理的三个条件？', '何时可用洛必达法则？', '泰勒公式的拉格朗日余项？', '曲率公式是什么？', '特征值之积等于？'];
const FORMULAS = ["f'(x₀) = lim Δy/Δx", '∫ u dv = uv − ∫ v du', 'κ = |y″| / (1+y′²)^{3/2}', 'f(x) = Σ fⁿ(x₀)/n! · (x−x₀)ⁿ', 'F(b) − F(a)'];

let PHOTO_IMAGES: HTMLImageElement[] = [];
/** 资料堆里的「照片」纸片用片中那两张错题照片（assets 里预加载后注入，canvas 只能画已解码的图）。 */
export const setPhotoImages = (imgs: HTMLImageElement[]) => {
  PHOTO_IMAGES = imgs;
};

const mulberry = (seed: number) => () => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const rr = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
};

const bars = (ctx: CanvasRenderingContext2D, r: () => number, x: number, y: number, w: number, n: number, step: number, h: number) => {
  ctx.fillStyle = BAR;
  for (let i = 0; i < n; i++) {
    const indent = i % 5 === 0 ? w * 0.06 : 0;
    const ww = i % 5 === 4 ? w * (0.35 + r() * 0.3) : w - indent - r() * w * 0.04;
    rr(ctx, x + indent, y + i * step, ww, h, h / 2);
    ctx.fill();
  }
};

/** 卡片底部的小向量：与查询向量同一种细竖条，把「每份资料都是一个向量」画进纸面。 */
const embedStrip = (ctx: CanvasRenderingContext2D, seed: number, x: number, y: number, w: number) => {
  const n = 24;
  const pitch = w / n;
  const h = pitch * 2.2;
  for (let i = 0; i < n; i++) {
    const v = cellValue(seed * 17 + i * 3);
    const bh = h * barLen(v);
    ctx.fillStyle = cellCss(v);
    rr(ctx, x + i * pitch, y + (h - bh) / 2, pitch * 0.42, bh, pitch * 0.21);
    ctx.fill();
  }
};

/** 发丝边：浅色空间里白纸贴白底，靠它和投影分出纸边。 */
const hairline = (ctx: CanvasRenderingContext2D, W: number, H: number, u: number) => {
  ctx.strokeStyle = 'rgba(20, 30, 50, 0.1)';
  ctx.lineWidth = 1.2 * u;
  ctx.strokeRect(0.6 * u, 0.6 * u, W - 1.2 * u, H - 1.2 * u);
};

const draw: Record<CardType, (ctx: CanvasRenderingContext2D, W: number, H: number, r: () => number, seed: number) => void> = {
  page: (ctx, W, H, r, seed) => {
    const u = W / 320;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    const m = 26 * u;
    ctx.fillStyle = '#7a7a7a';
    ctx.font = `${9 * u}px ${font.serif}`;
    ctx.fillText(String(60 + Math.floor(r() * 300)), m, 22 * u);
    ctx.fillRect(m, 28 * u, W - 2 * m, 0.8 * u);
    ctx.fillStyle = INK;
    ctx.font = `600 ${15 * u}px ${font.ui}`;
    ctx.fillText(`${Math.floor(r() * 9) + 1}、${SECTIONS[seed % SECTIONS.length]}`, m, 56 * u);
    bars(ctx, r, m, 72 * u, W - 2 * m, 6, 14 * u, 5 * u);
    ctx.fillStyle = INK;
    ctx.font = `italic ${13 * u}px "Times New Roman", serif`;
    const f = FORMULAS[seed % FORMULAS.length];
    ctx.fillText(f, W / 2 - ctx.measureText(f).width / 2, 176 * u);
    bars(ctx, r, m, 198 * u, W - 2 * m, 9, 14 * u, 5 * u);
    if (r() > 0.5) {
      ctx.strokeStyle = '#c9ccd3';
      ctx.lineWidth = 1 * u;
      ctx.strokeRect(m + 40 * u, 332 * u, W - 2 * m - 80 * u, 54 * u);
      ctx.beginPath();
      ctx.moveTo(m + 46 * u, 380 * u);
      ctx.bezierCurveTo(m + 100 * u, 300 * u, m + 160 * u, 400 * u, W - m - 46 * u, 340 * u);
      ctx.stroke();
    } else bars(ctx, r, m, 334 * u, W - 2 * m, 4, 14 * u, 5 * u);
    embedStrip(ctx, seed, m, H - 22 * u, 120 * u);
  },
  note: (ctx, W, H, r, seed) => {
    const u = W / 320;
    ctx.fillStyle = '#fbfaf6';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#e4e8ef';
    ctx.lineWidth = 1 * u;
    for (let y = 64 * u; y < H - 30 * u; y += 22 * u) {
      ctx.beginPath();
      ctx.moveTo(18 * u, y);
      ctx.lineTo(W - 18 * u, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'hsl(215 72% 42% / 0.12)';
    rr(ctx, 18 * u, 18 * u, 46 * u, 18 * u, 9 * u);
    ctx.fill();
    ctx.fillStyle = ACCENT;
    ctx.font = `600 ${10 * u}px ${font.ui}`;
    ctx.fillText('笔记', 29 * u, 31 * u);
    ctx.fillStyle = INK;
    ctx.font = `600 ${15 * u}px ${font.ui}`;
    ctx.fillText(SECTIONS[(seed * 7) % SECTIONS.length], 18 * u, 56 * u);
    ctx.font = `${12 * u}px "Kaiti SC", "STKaiti", ${font.serif}`;
    ctx.fillStyle = '#2f3a52';
    for (let i = 0; i < 8; i++) {
      const y = 82 * u + i * 22 * u;
      const w = (W - 40 * u) * (0.5 + r() * 0.45);
      if (r() > 0.72) {
        ctx.fillStyle = 'hsl(48 96% 60% / 0.45)';
        ctx.fillRect(18 * u, y - 12 * u, w * 0.6, 15 * u);
        ctx.fillStyle = '#2f3a52';
      }
      ctx.fillRect(18 * u, y - 2 * u, w, 1.6 * u);
    }
    embedStrip(ctx, seed, 18 * u, H - 22 * u, 120 * u);
  },
  memory: (ctx, W, H, r, seed) => {
    const u = W / 320;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'hsl(152 60% 36% / 0.12)';
    rr(ctx, 20 * u, 18 * u, 70 * u, 20 * u, 10 * u);
    ctx.fill();
    ctx.fillStyle = 'hsl(152 60% 30%)';
    ctx.font = `600 ${11 * u}px ${font.ui}`;
    ctx.fillText('学习记忆', 30 * u, 32 * u);
    ctx.fillStyle = INK;
    ctx.font = `500 ${15 * u}px ${font.ui}`;
    ctx.fillText(MEMOS[seed % MEMOS.length], 20 * u, 72 * u);
    ctx.fillStyle = INK2;
    ctx.font = `${11 * u}px ${font.ui}`;
    ctx.fillText(`来自 ${1 + Math.floor(r() * 4)} 次错题 · ${1 + Math.floor(r() * 9)} 月`, 20 * u, 98 * u);
    embedStrip(ctx, seed, 20 * u, H - 30 * u, 120 * u);
  },
  photo: (ctx, W, H, r, seed) => {
    const u = W / 320;
    const img = PHOTO_IMAGES[seed % Math.max(1, PHOTO_IMAGES.length)];
    if (img) {
      const s = Math.max(W / img.width, H / img.height) * (1.04 + r() * 0.16);
      const dw = img.width * s;
      const dh = img.height * s;
      ctx.drawImage(img, (W - dw) / 2 + (r() - 0.5) * 18 * u, (H - dh) / 2 + (r() - 0.5) * 18 * u, dw, dh);
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, H - 34 * u, W, 34 * u);
      embedStrip(ctx, seed, 20 * u, H - 24 * u, 120 * u);
      return;
    }
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#f3efe4');
    g.addColorStop(1, '#e4dfd2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#3b4a6b';
    ctx.lineWidth = 1.6 * u;
    for (let i = 0; i < 7; i++) {
      const y = 34 * u + i * 26 * u;
      ctx.beginPath();
      ctx.moveTo(24 * u, y);
      for (let x = 24; x < 300 * (0.55 + r() * 0.4); x += 12) ctx.lineTo(x * u, y + Math.sin(x * 0.4 + i) * 2.2 * u);
      ctx.stroke();
    }
    ctx.strokeStyle = '#d64545';
    ctx.lineWidth = 2.2 * u;
    ctx.beginPath();
    ctx.ellipse(W * (0.55 + r() * 0.2), H * 0.55, 34 * u, 20 * u, -0.2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(0,0,0,0.04)';
    ctx.fillRect(0, H - 34 * u, W, 34 * u);
    embedStrip(ctx, seed, 20 * u, H - 24 * u, 120 * u);
  },
  anki: (ctx, W, H, r, seed) => {
    const u = W / 320;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#e6e7ea';
    ctx.lineWidth = 1 * u;
    ctx.strokeRect(10 * u, 10 * u, W - 20 * u, H - 20 * u);
    ctx.fillStyle = INK2;
    ctx.font = `600 ${10 * u}px ${font.ui}`;
    ctx.fillText('正面', 22 * u, 32 * u);
    ctx.fillStyle = INK;
    ctx.font = `500 ${16 * u}px ${font.ui}`;
    const q = ANKI_Q[seed % ANKI_Q.length];
    ctx.fillText(q, W / 2 - ctx.measureText(q).width / 2, H / 2 + 4 * u);
    void r;
    embedStrip(ctx, seed, 22 * u, H - 30 * u, 120 * u);
  },
  mindmap: (ctx, W, H, r, seed) => {
    const u = W / 320;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    const cx = 80 * u;
    const cy = H / 2;
    ctx.strokeStyle = '#b9c3d6';
    ctx.lineWidth = 1.4 * u;
    const kids = 4 + Math.floor(r() * 2);
    for (let i = 0; i < kids; i++) {
      const y = 30 * u + (i * (H - 60 * u)) / (kids - 1);
      ctx.beginPath();
      ctx.moveTo(cx + 40 * u, cy);
      ctx.bezierCurveTo(cx + 80 * u, cy, cx + 90 * u, y, 190 * u, y);
      ctx.stroke();
      ctx.fillStyle = BAR;
      rr(ctx, 190 * u, y - 8 * u, (60 + r() * 50) * u, 16 * u, 8 * u);
      ctx.fill();
    }
    ctx.fillStyle = ACCENT;
    rr(ctx, cx - 50 * u, cy - 15 * u, 90 * u, 30 * u, 15 * u);
    ctx.fill();
    ctx.fillStyle = '#fff';
    ctx.font = `600 ${11 * u}px ${font.ui}`;
    const s = SECTIONS[(seed * 3) % SECTIONS.length].slice(0, 5);
    ctx.fillText(s, cx - 5 * u - ctx.measureText(s).width / 2, cy + 4 * u);
  },
};

export type CardTex = { canvas: HTMLCanvasElement; type: CardType; aspect: number };

export const makeCardCanvas = (type: CardType, seed: number, width = 480): CardTex => {
  const aspect = CARD_ASPECT[type];
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(width * aspect);
  const ctx = canvas.getContext('2d');
  if (ctx) {
    draw[type](ctx, canvas.width, canvas.height, mulberry(seed * 7919 + 13), seed);
    hairline(ctx, canvas.width, canvas.height, canvas.width / 320);
  }
  return { canvas, type, aspect };
};

/** 三张命中资料：内容与对话/教材第 134 页一致。 */
export const makeHitCanvas = (kind: 'textbook' | 'note' | 'memory', width = 640): CardTex => {
  const aspect = 1.33;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = Math.round(width * aspect);
  const ctx = canvas.getContext('2d');
  const W = canvas.width;
  const H = canvas.height;
  const u = W / 320;
  if (!ctx) return { canvas, type: 'page', aspect };
  if (kind === 'textbook') {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    const m = 26 * u;
    ctx.fillStyle = '#666';
    ctx.font = `${9 * u}px ${font.serif}`;
    ctx.fillText('134', m, 22 * u);
    const hdr = '第三章　微分中值定理与导数的应用';
    ctx.fillText(hdr, W - m - ctx.measureText(hdr).width, 22 * u);
    ctx.fillStyle = '#999';
    ctx.fillRect(m, 28 * u, W - 2 * m, 0.6 * u);
    ctx.fillStyle = INK;
    ctx.font = `600 ${12 * u}px ${font.ui}`;
    ctx.fillText('证', m, 56 * u);
    ctx.font = `${11.5 * u}px ${font.serif}`;
    ctx.fillText('　引进辅助函数', m + 10 * u, 56 * u);
    ctx.font = `italic ${12 * u}px "Times New Roman", serif`;
    const f1 = 'φ(x) = f(x) − f(a) − [f(b) − f(a)]/(b − a) · (x − a)';
    ctx.fillText(f1, W / 2 - ctx.measureText(f1).width / 2, 84 * u);
    // 命中片段（[2]「构造辅助函数」的出处）：产品定位到句子时的琥珀色底，逐行一块（文本层按 span 高亮）
    ctx.font = `${11 * u}px ${font.serif}`;
    const hit = ['容易验证 φ(a) = φ(b) = 0，且 φ(x) 在闭区间 [a, b] 上', '连续、在开区间 (a, b) 内可导。根据罗尔定理，在', '(a, b) 内至少有一点 ξ，使 φ′(ξ) = 0，即'];
    hit.forEach((s, i) => {
      ctx.fillStyle = 'hsl(38 70% 45% / 0.42)';
      rr(ctx, m - 1.5 * u, 104 * u + i * 18 * u, ctx.measureText(s).width + 3 * u, 15 * u, 2 * u);
      ctx.fill();
      ctx.fillStyle = INK;
      ctx.fillText(s, m, 116 * u + i * 18 * u);
    });
    const f2 = "f′(ξ) − [f(b) − f(a)]/(b − a) = 0";
    ctx.fillStyle = INK;
    ctx.font = `italic ${12 * u}px "Times New Roman", serif`;
    ctx.fillText(f2, W / 2 - ctx.measureText(f2).width / 2, 188 * u);
    bars(ctx, mulberry(6), m, 206 * u, W - 2 * m, 3, 14 * u, 5 * u);
    ctx.fillStyle = INK;
    ctx.font = `${11 * u}px ${font.serif}`;
    ctx.fillText('注意 ξ 取在开区间 (a, b) 内部，定理只断言', m, 266 * u);
    ctx.fillText('它存在，并不给出它的具体位置。', m, 284 * u);
    ctx.font = `600 ${11.5 * u}px ${font.ui}`;
    ctx.fillText('推论', m, 318 * u);
    bars(ctx, mulberry(7), m, 330 * u, W - 2 * m, 5, 14 * u, 5 * u);
    embedStrip(ctx, 134, m, H - 22 * u, 120 * u);
  } else if (kind === 'note') {
    ctx.fillStyle = '#fbfaf6';
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#e4e8ef';
    ctx.lineWidth = 1 * u;
    for (let y = 70 * u; y < H - 34 * u; y += 26 * u) {
      ctx.beginPath();
      ctx.moveTo(18 * u, y);
      ctx.lineTo(W - 18 * u, y);
      ctx.stroke();
    }
    ctx.fillStyle = 'hsl(215 72% 42% / 0.12)';
    rr(ctx, 18 * u, 18 * u, 46 * u, 18 * u, 9 * u);
    ctx.fill();
    ctx.fillStyle = ACCENT;
    ctx.font = `600 ${10 * u}px ${font.ui}`;
    ctx.fillText('笔记', 29 * u, 31 * u);
    ctx.fillStyle = INK;
    ctx.font = `600 ${15 * u}px ${font.ui}`;
    ctx.fillText('拉格朗日中值定理 · 证明思路', 18 * u, 60 * u);
    ctx.font = `${13 * u}px "Kaiti SC", "STKaiti", ${font.serif}`;
    ctx.fillStyle = '#2f3a52';
    const lines = ['① 构造 φ(x) = f(x) − 弦 AB', '② φ(a) = φ(b)，满足罗尔定理', '③ φ′(ξ) = 0 ⇒ 斜率相等', '几何：切线 ∥ 弦', '反例：|x| 在 0 处不可导'];
    lines.forEach((s, i) => {
      if (i === 1) {
        ctx.fillStyle = 'hsl(48 96% 60% / 0.5)';
        ctx.fillRect(18 * u, 96 * u + i * 26 * u - 14 * u, ctx.measureText(s).width, 17 * u);
        ctx.fillStyle = '#2f3a52';
      }
      ctx.fillText(s, 18 * u, 92 * u + i * 26 * u);
    });
    embedStrip(ctx, 77, 18 * u, H - 24 * u, 120 * u);
  } else {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = 'hsl(152 60% 36% / 0.12)';
    rr(ctx, 20 * u, 20 * u, 70 * u, 20 * u, 10 * u);
    ctx.fill();
    ctx.fillStyle = 'hsl(152 60% 30%)';
    ctx.font = `600 ${11 * u}px ${font.ui}`;
    ctx.fillText('学习记忆', 30 * u, 34 * u);
    ctx.fillStyle = INK;
    ctx.font = `600 ${16 * u}px ${font.ui}`;
    ctx.fillText('ξ 的取值范围常写错', 20 * u, 76 * u);
    ctx.font = `${12.5 * u}px ${font.ui}`;
    ctx.fillStyle = INK2;
    ['应为开区间 (a, b)，不含端点；', '两次错题都写成了 [a, b]。'].forEach((s, i) => ctx.fillText(s, 20 * u, 108 * u + i * 22 * u));
    ctx.strokeStyle = '#eceef1';
    ctx.lineWidth = 1 * u;
    ctx.beginPath();
    ctx.moveTo(20 * u, 168 * u);
    ctx.lineTo(W - 20 * u, 168 * u);
    ctx.stroke();
    ctx.font = `${11 * u}px ${font.ui}`;
    ctx.fillText('来源', 20 * u, 194 * u);
    ['错题-中值定理.jpg', '错题-辅助函数.jpg'].forEach((s, i) => {
      ctx.fillStyle = '#f2f3f5';
      rr(ctx, 20 * u, 206 * u + i * 34 * u, 200 * u, 26 * u, 13 * u);
      ctx.fill();
      ctx.fillStyle = INK;
      ctx.fillText(s, 32 * u, 223 * u + i * 34 * u);
      ctx.fillStyle = INK2;
    });
    ctx.fillStyle = '#d64545';
    ctx.font = `600 ${11 * u}px ${font.ui}`;
    ctx.fillText('薄弱 · 已记录 2 次', 20 * u, 300 * u);
    embedStrip(ctx, 41, 20 * u, H - 26 * u, 120 * u);
  }
  hairline(ctx, W, H, u);
  return { canvas, type: 'page', aspect };
};

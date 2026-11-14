import { Fragment, type CSSProperties, type ReactNode } from 'react';
import { font, light } from '../theme';
import { Tex } from './tex';

export const PAGE_W = 688;
export const PAGE_H = 973;

const INK = '#1d1d1f';
const SERIF_BODY: CSSProperties = { fontFamily: font.serif, fontSize: 17.5, lineHeight: '32px', color: INK };
const HEI: CSSProperties = { fontFamily: font.ui, fontWeight: 600, color: INK };

type Tok = { s: string; i?: boolean; b?: boolean };

/** 教材页的定理句（逐字可选中）。文本为本片自拟，排版仿教材。 */
export const THEOREM: Tok[] = [
  { s: '如果函数 ' },
  { s: 'f', i: true },
  { s: '(' },
  { s: 'x', i: true },
  { s: ') 满足：(1) 在闭区间 [' },
  { s: 'a', i: true },
  { s: ', ' },
  { s: 'b', i: true },
  { s: '] 上连续；(2) 在开区间 (' },
  { s: 'a', i: true },
  { s: ', ' },
  { s: 'b', i: true },
  { s: ') 内可导，那么在 (' },
  { s: 'a', i: true },
  { s: ', ' },
  { s: 'b', i: true },
  { s: ') 内至少有一点 ' },
  { s: 'ξ', i: true },
  { s: '，使等式' },
];
export const THEOREM_CHARS = THEOREM.reduce((n, tk) => n + [...tk.s].length, 0);

/** 选区在页面坐标中的大致范围（定理段四行），供工具条与芯片定位。 */
export const SELECTION_BOX = { x: 64, y: 262, w: PAGE_W - 128, h: 64 };

const Block = ({ y, children, style }: { y: number; children: ReactNode; style?: CSSProperties }) => (
  <div style={{ position: 'absolute', left: 64, right: 64, top: y, ...style }}>{children}</div>
);

const ITALIC: CSSProperties = { fontStyle: 'italic', fontFamily: '"Times New Roman", Times, serif', fontSize: 19 };

/**
 * 选中的部分包在同一个 span 里铺底色：每行一整条、高度一致。
 * 逐字各铺一块半透明底时，相邻字的抗锯齿边缘会叠出深色缝，斜体字的行框又更高，镜头推拉时整条选区会闪。
 */
const SelectableText = ({ tokens, selected, selColor }: { tokens: Tok[]; selected: number; selColor: string }) => {
  const on: ReactNode[] = [];
  const off: ReactNode[] = [];
  let idx = 0;
  tokens.forEach((tk, ti) => {
    const chars = [...tk.s];
    const n = Math.max(0, Math.min(chars.length, selected - idx));
    const piece = (s: string, key: string) =>
      tk.i ? (
        <span key={key} style={ITALIC}>
          {s}
        </span>
      ) : (
        <Fragment key={key}>{s}</Fragment>
      );
    if (n > 0) on.push(piece(chars.slice(0, n).join(''), `on-${ti}`));
    if (n < chars.length) off.push(piece(chars.slice(n).join(''), `off-${ti}`));
    idx += chars.length;
  });
  return (
    <>
      {on.length > 0 ? <span style={{ background: selColor }}>{on}</span> : null}
      {off}
    </>
  );
};

/** 产品 PDF 文字层的选区色：`enhanced-pdf.css` 里 `.react-pdf__Page__textContent span::selection` 为 primary / 0.4。 */
export const PDF_SELECTION = `color-mix(in srgb, ${light.primary} 40%, transparent)`;

/**
 * 引用定位到句子（`quoteFlash.ts` + `.ds-pdf-quote-flash`）：命中的文本层 span 铺 warning 色（亮色主题 38 70% 45%），
 * 关键帧 0–60% 停在 0.48、到 100% 淡到 0，共 2.4s 真实时间；每行各一块、圆角 2。
 */
export const QUOTE_FLASH_S = 2.4;
export const quoteFlashAlpha = (sinceReal: number) =>
  sinceReal < 0 || sinceReal > QUOTE_FLASH_S ? 0 : sinceReal < QUOTE_FLASH_S * 0.6 ? 0.48 : 0.48 * (1 - (sinceReal - QUOTE_FLASH_S * 0.6) / (QUOTE_FLASH_S * 0.4));
const quoteFlashStyle = (alpha: number): CSSProperties | undefined =>
  alpha > 0.001 ? { background: `hsl(38 70% 45% / ${alpha})`, borderRadius: 2, WebkitBoxDecorationBreak: 'clone', boxDecorationBreak: 'clone' } : undefined;

const Figure = () => {
  const fx = (x: number) => {
    const u = (x - 100) / 340;
    return 222 - 128 * u - 105 * Math.sin(Math.PI * u);
  };
  const pts: string[] = [];
  for (let x = 70; x <= 470; x += 4) pts.push(`${x},${fx(x).toFixed(1)}`);
  const a = 100;
  const b = 440;
  const A = { x: a, y: fx(a) };
  const B = { x: b, y: fx(b) };
  const slope = (B.y - A.y) / (B.x - A.x);
  let xi = a;
  let best = Infinity;
  for (let x = a + 20; x < b - 20; x += 0.5) {
    const d = Math.abs(fx(x + 0.25) - fx(x - 0.25) - slope * 0.5);
    if (d < best) {
      best = d;
      xi = x;
    }
  }
  const C = { x: xi, y: fx(xi) };
  const len = Math.hypot(1, slope);
  const ux = 130 / len;
  const uy = (130 * slope) / len;
  const it: CSSProperties = { fontStyle: 'italic', fontFamily: '"Times New Roman", Times, serif', fontSize: 17 };
  return (
    <svg width={520} height={290} viewBox="0 0 520 290" style={{ display: 'block', margin: '0 auto' }}>
      <line x1={40} y1={260} x2={500} y2={260} stroke={INK} strokeWidth={1.2} />
      <line x1={50} y1={272} x2={50} y2={16} stroke={INK} strokeWidth={1.2} />
      <path d="M496 256 L504 260 L496 264" fill="none" stroke={INK} strokeWidth={1.2} />
      <path d="M46 20 L50 12 L54 20" fill="none" stroke={INK} strokeWidth={1.2} />
      <polyline points={pts.join(' ')} fill="none" stroke={INK} strokeWidth={1.8} />
      <line x1={A.x} y1={A.y} x2={B.x} y2={B.y} stroke={INK} strokeWidth={1.2} />
      <line x1={C.x - ux} y1={C.y - uy} x2={C.x + ux} y2={C.y + uy} stroke={INK} strokeWidth={1.2} />
      {[A, B, C].map((p, i) => (
        <line key={i} x1={p.x} y1={p.y} x2={p.x} y2={260} stroke={INK} strokeWidth={1} strokeDasharray="4 4" />
      ))}
      {[A, B, C].map((p, i) => (
        <circle key={`d${i}`} cx={p.x} cy={p.y} r={3} fill={INK} />
      ))}
      <text x={36} y={280} style={it}>O</text>
      <text x={A.x - 4} y={282} style={it}>a</text>
      <text x={C.x - 4} y={282} style={it}>ξ</text>
      <text x={B.x - 4} y={282} style={it}>b</text>
      <text x={506} y={276} style={it}>x</text>
      <text x={58} y={22} style={it}>y</text>
      <text x={A.x - 22} y={A.y + 4} style={it}>A</text>
      <text x={B.x + 8} y={B.y - 6} style={it}>B</text>
      <text x={C.x - 6} y={C.y - 12} style={it}>C</text>
      <text x={400} y={52} style={it}>y = f(x)</text>
    </svg>
  );
};

export const TextbookPage = ({
  page = 132,
  selected = 0,
  selColor = PDF_SELECTION,
  flash = 0,
  style,
}: {
  page?: 132 | 134;
  selected?: number;
  selColor?: string;
  /** 第 134 页命中句（[2]「构造辅助函数」的出处）的定位高亮透明度，见 quoteFlashAlpha */
  flash?: number;
  style?: CSSProperties;
}) => (
  <div
    style={{
      position: 'relative',
      width: PAGE_W,
      height: PAGE_H,
      background: '#ffffff',
      borderRadius: 4,
      overflow: 'hidden',
      ...style,
    }}
  >
    <Block y={36} style={{ display: 'flex', justifyContent: 'space-between', fontFamily: font.serif, fontSize: 13, color: '#555' }}>
      <span>{page}</span>
      <span>第三章　微分中值定理与导数的应用</span>
    </Block>
    <div style={{ position: 'absolute', left: 64, right: 64, top: 62, height: 1, background: '#999' }} />
    {page === 132 ? (
      <>
        <Block y={92} style={{ ...HEI, fontSize: 20 }}>
          二、拉格朗日中值定理
        </Block>
        <Block y={138} style={SERIF_BODY}>
          <span style={{ paddingLeft: '2em' }} />
          去掉罗尔定理里 <i style={{ fontFamily: 'Times New Roman' }}>f</i>(<i style={{ fontFamily: 'Times New Roman' }}>a</i>) ={' '}
          <i style={{ fontFamily: 'Times New Roman' }}>f</i>(<i style={{ fontFamily: 'Times New Roman' }}>b</i>)
          这一特殊要求，只保留连续与可导两个条件，结论相应放宽，就得到微分学中最重要的定理之一。
        </Block>
        <Block y={230} style={{ ...HEI, fontSize: 17.5 }}>
          拉格朗日中值定理
        </Block>
        <Block y={262} style={SERIF_BODY}>
          <span style={{ paddingLeft: '2em' }} />
          <SelectableText tokens={THEOREM} selected={selected} selColor={selColor} />
        </Block>
        <Block y={400} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 60, color: INK, fontSize: 21 }}>
          <Tex tex="f(b)-f(a)=f'(\xi)(b-a)" />
          <span style={{ fontFamily: font.serif, fontSize: 16 }}>(1-1)</span>
        </Block>
        <Block y={446} style={SERIF_BODY}>
          成立。
        </Block>
        <Block y={494}>
          <Figure />
          <div style={{ textAlign: 'center', fontFamily: font.serif, fontSize: 14, color: '#444', marginTop: 4 }}>图 3-3</div>
        </Block>
        <Block y={822} style={SERIF_BODY}>
          <span style={{ paddingLeft: '2em' }} />
          几何意义：连续曲线 <i style={{ fontFamily: 'Times New Roman' }}>y</i> = <i style={{ fontFamily: 'Times New Roman' }}>f</i>(
          <i style={{ fontFamily: 'Times New Roman' }}>x</i>) 的弧 <i style={{ fontFamily: 'Times New Roman' }}>AB</i>{' '}
          上若处处有不垂直于 <i style={{ fontFamily: 'Times New Roman' }}>x</i> 轴的切线，那么弧上至少有一点 <i style={{ fontFamily: 'Times New Roman' }}>C</i>
          ，该点的切线平行于弦 <i style={{ fontFamily: 'Times New Roman' }}>AB</i>。
        </Block>
      </>
    ) : (
      <>
        <Block y={92} style={SERIF_BODY}>
          <span style={{ ...HEI, fontSize: 17.5 }}>证</span>　引进辅助函数
        </Block>
        <Block y={140} style={{ display: 'flex', justifyContent: 'center', color: INK, fontSize: 21 }}>
          <Tex tex="\varphi(x)=f(x)-f(a)-\dfrac{f(b)-f(a)}{b-a}(x-a)" />
        </Block>
        <Block y={214} style={SERIF_BODY}>
          <span style={{ paddingLeft: '2em' }} />
          <span style={quoteFlashStyle(flash)}>
            容易验证 φ(<i>a</i>) = φ(<i>b</i>) = 0，且 φ(<i>x</i>) 在闭区间 [<i>a</i>, <i>b</i>] 上连续、在开区间 (<i>a</i>, <i>b</i>)
            内可导。根据罗尔定理，在 (<i>a</i>, <i>b</i>) 内至少有一点 <i>ξ</i>，使 φ′(<i>ξ</i>) = 0，即
          </span>
        </Block>
        <Block y={344} style={{ display: 'flex', justifyContent: 'center', color: INK, fontSize: 21 }}>
          <Tex tex="f'(\xi)-\dfrac{f(b)-f(a)}{b-a}=0" />
        </Block>
        <Block y={418} style={SERIF_BODY}>
          由此得 <Tex tex="\dfrac{f(b)-f(a)}{b-a}=f'(\xi)" style={{ fontSize: 19 }} />，即 (1-1) 式成立。
        </Block>
        <Block y={500} style={SERIF_BODY}>
          <span style={{ paddingLeft: '2em' }} />
          注意 <i>ξ</i> 取在开区间 (<i>a</i>, <i>b</i>) 内部，定理只断言它存在，并不给出它的具体位置。公式 (1-1) 对 <i>b</i> &lt; <i>a</i>{' '}
          也成立，称为拉格朗日中值公式。
        </Block>
        <Block y={630} style={{ ...HEI, fontSize: 17.5 }}>
          推论
        </Block>
        <Block y={664} style={SERIF_BODY}>
          <span style={{ paddingLeft: '2em' }} />
          如果函数 <i>f</i>(<i>x</i>) 在区间 <i>I</i> 上的导数恒为零，那么 <i>f</i>(<i>x</i>) 在区间 <i>I</i> 上是一个常数。
        </Block>
        <Block y={780} style={SERIF_BODY}>
          <span style={{ paddingLeft: '2em' }} />
          在区间 <i>I</i> 上任取两点 <i>x</i>
          <sub>1</sub>, <i>x</i>
          <sub>2</sub>，应用 (1-1) 式即得 <i>f</i>(<i>x</i>
          <sub>2</sub>) − <i>f</i>(<i>x</i>
          <sub>1</sub>) = 0。
        </Block>
      </>
    )}
  </div>
);

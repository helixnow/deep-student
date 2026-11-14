import { ArrowsOut, Crosshair, GitFork, MagnifyingGlassMinus, MagnifyingGlassPlus } from '@phosphor-icons/react';
import type { CSSProperties, ReactNode } from 'react';
import { brand, font, type Tokens } from '../theme';
import { lerp } from '../lib/time';
import { S } from '../strings';
import { Tex } from './tex';

/** src/features/mindmap/styles/themes/palettes.ts */
const LIGHT_PALETTE = ['#E05252', '#E69038', '#EBCB4B', '#5BB98C', '#2EAADC', '#6C63FF', '#F2668B'];
const DARK_PALETTE = ['#FF6B6B', '#FFA94D', '#FFD43B', '#51CF66', '#4DABF7', '#9775FA', '#F783AC'];

export type MMNode = {
  id: string;
  parent?: string;
  depth: 0 | 1 | 2;
  text: string;
  branch?: number;
  tex?: string;
  blank?: [string, string, string];
};

export const MM_NODES: MMNode[] = [
  { id: 'root', depth: 0, text: '微分中值定理' },
  { id: 'rolle', parent: 'root', depth: 1, text: '罗尔定理', branch: 0 },
  { id: 'lag', parent: 'root', depth: 1, text: '拉格朗日中值定理', branch: 4 },
  { id: 'cauchy', parent: 'root', depth: 1, text: '柯西中值定理', branch: 5 },
  { id: 'taylor', parent: 'root', depth: 1, text: '泰勒公式', branch: 3 },
  { id: 'rolle1', parent: 'rolle', depth: 2, text: '端点值相等 ⇒ f′(ξ) = 0', blank: ['端点值相等 ⇒ ', 'f′(ξ) = 0', ''] },
  { id: 'lag1', parent: 'lag', depth: 2, text: 'f(b) − f(a) = f′(ξ)(b − a)', tex: "f(b)-f(a)=f'(\\xi)(b-a)" },
  { id: 'lag2', parent: 'lag', depth: 2, text: '关键：构造辅助函数 φ(x)', blank: ['关键：构造', '辅助函数 φ(x)', ''] },
  { id: 'cauchy1', parent: 'cauchy', depth: 2, text: '推广到两个函数', blank: ['推广到', '两个函数', ''] },
  { id: 'taylor1', parent: 'taylor', depth: 2, text: '余项 Rₙ(x) 刻画误差', blank: ['余项 ', 'Rₙ(x)', ' 刻画误差'] },
];

export const MM_BLANK_IDS = MM_NODES.filter((n) => n.blank).map((n) => n.id);

const byId = Object.fromEntries(MM_NODES.map((n) => [n.id, n]));
const kids = (id: string) => MM_NODES.filter((n) => n.parent === id);
const branchOf = (n: MMNode): number => (n.branch !== undefined ? n.branch : n.parent ? branchOf(byId[n.parent]) : 4);

const charW = (ch: string, size: number) => (/[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? size : /[A-Za-z0-9 ()=−+.,]/.test(ch) ? size * 0.56 : size * 0.62);
export const textW = (s: string, size: number) => [...s].reduce((w, ch) => w + charW(ch, size), 0);

/** 根 / 一级节点盒子按真机（probe-clv-open：根 = 文字 + 52 × 47，一级 = 文字 + 40 × 35）。 */
export const nodeSize = (n: MMNode) => {
  if (n.depth === 0) return { w: textW(n.text, 18) + 52, h: 47 };
  if (n.depth === 1) return { w: textW(n.text, 15) + 40, h: 35 };
  if (n.tex) return { w: 236, h: 36 };
  return { w: textW(n.text, 14) + 12, h: 28 };
};

export type LayoutId = 'balanced' | 'mindRight' | 'logic' | 'org' | 'timeline';
export type Pos = { x: number; y: number };
type Layout = Record<string, Pos>;

const GAP_X = 80;
const GAP_Y = 24;

const layoutHorizontal = (sides: Array<{ side: 1 | -1; l1: MMNode[] }>): Layout => {
  const out: Layout = { root: { x: 0, y: 0 } };
  const root = nodeSize(byId.root);
  for (const { side, l1 } of sides) {
    const heights = l1.map((n) => {
      const leaves = kids(n.id);
      const lh = leaves.reduce((s, c) => s + nodeSize(c).h, 0) + GAP_Y * Math.max(0, leaves.length - 1);
      return Math.max(nodeSize(n).h, lh);
    });
    const total = heights.reduce((s, h) => s + h, 0) + GAP_Y * 1.6 * (l1.length - 1);
    let y = -total / 2;
    l1.forEach((n, i) => {
      const sz = nodeSize(n);
      const cy = y + heights[i] / 2;
      const x = side * (root.w / 2 + GAP_X + sz.w / 2);
      out[n.id] = { x, y: cy };
      const leaves = kids(n.id);
      const lh = leaves.reduce((s, c) => s + nodeSize(c).h, 0) + GAP_Y * Math.max(0, leaves.length - 1);
      let ly = cy - lh / 2;
      leaves.forEach((c) => {
        const cs = nodeSize(c);
        out[c.id] = { x: side * (root.w / 2 + GAP_X + sz.w + GAP_X * 0.75 + cs.w / 2), y: ly + cs.h / 2 };
        ly += cs.h + GAP_Y;
      });
      y += heights[i] + GAP_Y * 1.6;
    });
  }
  return out;
};

const layoutOrg = (): Layout => {
  const out: Layout = { root: { x: 0, y: 0 } };
  const l1 = kids('root');
  const widths = l1.map((n) => {
    const leaves = kids(n.id);
    const lw = leaves.reduce((s, c) => s + nodeSize(c).w, 0) + 24 * Math.max(0, leaves.length - 1);
    return Math.max(nodeSize(n).w, lw);
  });
  const total = widths.reduce((s, w) => s + w, 0) + 40 * (l1.length - 1);
  let x = -total / 2;
  l1.forEach((n, i) => {
    const cx = x + widths[i] / 2;
    out[n.id] = { x: cx, y: 104 };
    const leaves = kids(n.id);
    const lw = leaves.reduce((s, c) => s + nodeSize(c).w, 0) + 24 * Math.max(0, leaves.length - 1);
    let lx = cx - lw / 2;
    leaves.forEach((c) => {
      const cs = nodeSize(c);
      out[c.id] = { x: lx + cs.w / 2, y: 196 };
      lx += cs.w + 24;
    });
    x += widths[i] + 40;
  });
  return out;
};

const layoutTimeline = (): Layout => {
  const root = nodeSize(byId.root);
  const out: Layout = { root: { x: 0, y: 0 } };
  let x = root.w / 2 + 64;
  for (const n of kids('root')) {
    const sz = nodeSize(n);
    const leaves = kids(n.id);
    const colW = Math.max(sz.w, ...leaves.map((c) => nodeSize(c).w + 24));
    out[n.id] = { x: x + sz.w / 2, y: 0 };
    let ly = sz.h / 2 + 26;
    for (const c of leaves) {
      const cs = nodeSize(c);
      out[c.id] = { x: x + 24 + cs.w / 2, y: ly + cs.h / 2 };
      ly += cs.h + 12;
    }
    x += colW + 44;
  }
  return out;
};

export const LAYOUTS: Record<LayoutId, Layout> = {
  balanced: layoutHorizontal([
    { side: 1, l1: [byId.rolle, byId.lag] },
    { side: -1, l1: [byId.cauchy, byId.taylor] },
  ]),
  /** 思维导图(向右)：与逻辑图同位置，连线是曲线（编辑器打开这张图时的默认结构） */
  mindRight: layoutHorizontal([{ side: 1, l1: kids('root') }]),
  logic: layoutHorizontal([{ side: 1, l1: kids('root') }]),
  org: layoutOrg(),
  timeline: layoutTimeline(),
};

const bounds = (l: Layout) => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const n of MM_NODES) {
    const p = l[n.id];
    const s = nodeSize(n);
    x0 = Math.min(x0, p.x - s.w / 2);
    x1 = Math.max(x1, p.x + s.w / 2);
    y0 = Math.min(y0, p.y - s.h / 2);
    y1 = Math.max(y1, p.y + s.h / 2);
  }
  return { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
};

const edgePath = (layout: LayoutId, p: Pos, ps: { w: number; h: number }, c: Pos, cs: { w: number; h: number }, childDepth: number) => {
  if (layout === 'org') {
    const y0 = p.y + ps.h / 2;
    const y1 = c.y - cs.h / 2;
    const my = (y0 + y1) / 2;
    const r = Math.min(8, Math.abs(c.x - p.x) / 2);
    if (Math.abs(c.x - p.x) < 1) return `M${p.x} ${y0} V${y1}`;
    const dir = c.x > p.x ? 1 : -1;
    return `M${p.x} ${y0} V${my - r} Q${p.x} ${my} ${p.x + dir * r} ${my} H${c.x - dir * r} Q${c.x} ${my} ${c.x} ${my + r} V${y1}`;
  }
  if (layout === 'timeline') {
    if (childDepth === 1) return `M${p.x + ps.w / 2} ${p.y} H${c.x - cs.w / 2}`;
    const x0 = p.x - ps.w / 2 + 12;
    return `M${x0} ${p.y + ps.h / 2} V${c.y} H${c.x - cs.w / 2}`;
  }
  const dir = c.x >= p.x ? 1 : -1;
  const x0 = p.x + (dir * ps.w) / 2;
  const x1 = c.x - (dir * cs.w) / 2;
  if (layout === 'logic') {
    const mx = (x0 + x1) / 2;
    return `M${x0} ${p.y} H${mx} V${c.y} H${x1}`;
  }
  const dx = (x1 - x0) / 2;
  return `M${x0} ${p.y} C${x0 + dx} ${p.y} ${x1 - dx} ${c.y} ${x1} ${c.y}`;
};

/**
 * 背诵态：mask 为遮罩浮现进度（0→1），revealed[id] 为逐个揭示进度（0→1）；
 * highlight 控制揭示后浅绿高亮的保留程度（退出背诵时淡掉）。
 */
export type ReciteState = { active: boolean; mask?: number; revealed: Record<string, number>; highlight?: number; whole?: boolean };

/** 编辑器（右侧面板 MindMapContentView）默认主题：灰色连线、二级节点细灰框、叶子灰下划线（probe-clv-open）。 */
const EDITOR_LINE = 'rgba(101, 105, 114, 0.4)';

const NodeLabel = ({ n, tk, recite }: { n: MMNode; tk: Tokens; recite?: ReciteState }) => {
  if (n.tex) return <Tex tex={n.tex} style={{ fontSize: 15 }} />;
  if (!n.blank) return <>{n.text}</>;
  const [pre, mid, post] = n.blank;
  const mask = recite ? (recite.mask ?? (recite.active ? 1 : 0)) : 0;
  const rk = recite?.revealed[n.id] ?? 0;
  const hl = (recite?.highlight ?? 1) * Math.min(1, rk * 1.4);
  const hiColor = tk.dark ? brand.emerald900a : brand.emerald100;
  const cover = mask * (1 - rk);
  const ink = 1 - cover;
  return (
    <>
      {pre}
      <span
        style={{
          position: 'relative',
          display: 'inline-block',
          borderRadius: 2,
          padding: '0 2px',
          background: `color-mix(in srgb, ${hiColor} ${hl * 100}%, transparent)`,
          color: `color-mix(in srgb, ${tk.foreground} ${ink * 100}%, transparent)`,
          transform: `scale(${1 + Math.sin(rk * Math.PI) * 0.08})`,
        }}
      >
        {mid}
        {cover > 0.001 ? (
          <span
            style={{
              position: 'absolute',
              inset: 0,
              borderRadius: 2,
              background: tk.foreground,
              opacity: mask,
              clipPath: `inset(0 0 0 ${rk * 100}%)`,
            }}
          />
        ) : null}
      </span>
      {post}
    </>
  );
};

export const MindmapGraph = ({
  tk,
  from,
  to,
  k,
  width,
  height,
  zoom = 1,
  pan = { x: 0, y: 0 },
  enter,
  recite,
  fit = 0.86,
  maxScale = Infinity,
  theme = 'card',
}: {
  tk: Tokens;
  from: LayoutId;
  to: LayoutId;
  k: number;
  width: number;
  height: number;
  zoom?: number;
  pan?: Pos;
  enter?: (n: MMNode, i: number) => number;
  recite?: ReciteState;
  fit?: number;
  /** fitView 的最大缩放（对应 React Flow maxZoom），避免节点少的布局被放得过大。 */
  maxScale?: number;
  /** card = 对话内嵌卡片的彩色分支；editor = 右侧面板编辑器的灰色默认主题 */
  theme?: 'card' | 'editor';
}) => {
  const editor = theme === 'editor';
  const pos = (id: string) => nodePos(from, to, k, id);
  const frame = graphFrame(from, to, k, width, height, fit, maxScale);
  const scale = frame.scale * zoom;
  const { cx, cy } = frame;
  // 布局形变时两种连线风格交叉淡化，避免在某一帧硬切
  const edgeStyles: Array<[LayoutId, number]> = from === to ? [[to, 1]] : [[from, 1 - k], [to, k]];
  const axisW = edgeStyles.reduce((s, [st, w]) => s + (st === 'timeline' ? w : 0), 0);
  const edgeColor = (n: MMNode) => (editor ? EDITOR_LINE : nodeColor(n, tk.dark));
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width, height, overflow: 'hidden' }}>
      <div
        style={{
          position: 'absolute',
          left: width / 2,
          top: height / 2,
          transform: `scale(${scale}) translate(${-cx + pan.x}px, ${-cy + pan.y}px)`,
          transformOrigin: '0 0',
        }}
      >
        <svg style={{ position: 'absolute', left: -2000, top: -2000, overflow: 'visible' }} width={4000} height={4000}>
          <g transform="translate(2000 2000)">
            {axisW > 0.001 ? (
              <line
                x1={pos('root').x + nodeSize(byId.root).w / 2}
                y1={pos('root').y}
                x2={pos('taylor').x + nodeSize(byId.taylor).w / 2 + 30}
                y2={pos('root').y}
                stroke={tk.mutedFg}
                strokeOpacity={0.45 * axisW}
                strokeWidth={1.5}
              />
            ) : null}
            {edgeStyles.map(([st, w]) =>
              w > 0.001
                ? MM_NODES.filter((n) => n.parent).map((n, i) => {
                    const p = byId[n.parent!];
                    const e = enter ? enter(n, i) : 1;
                    return (
                      <path
                        key={`${st}:${n.id}`}
                        d={edgePath(st, pos(p.id), nodeSize(p), pos(n.id), nodeSize(n), n.depth)}
                        fill="none"
                        stroke={edgeColor(n)}
                        strokeOpacity={(editor ? 1 : 0.85) * Math.min(1, e * 1.5) * w}
                        strokeWidth={1.5}
                        strokeLinecap="round"
                      />
                    );
                  })
                : null,
            )}
          </g>
        </svg>
        {MM_NODES.map((n, i) => {
          const p = pos(n.id);
          const s = nodeSize(n);
          const e = enter ? enter(n, i) : 1;
          const color = edgeColor(n);
          const base: CSSProperties = {
            position: 'absolute',
            left: p.x - s.w / 2,
            top: p.y - s.h / 2,
            width: s.w,
            height: s.h,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            boxSizing: 'border-box',
            fontFamily: font.ui,
            color: tk.foreground,
            whiteSpace: 'nowrap',
            opacity: Math.min(1, e * 2),
            transform: `scale(${0.6 + 0.4 * e})`,
            lineHeight: 1.5,
          };
          if (n.depth === 0) {
            return (
              <div
                key={n.id}
                style={{ ...base, padding: '10px 20px', borderRadius: 4, fontSize: 18, fontWeight: 600, background: tk.card, border: `1px solid color-mix(in hsl, ${tk.mutedFg} 50%, transparent)` }}
              >
                {n.text}
              </div>
            );
          }
          if (n.depth === 1) {
            return (
              <div key={n.id} style={{ ...base, padding: '6px 12px', borderRadius: 4, fontSize: 15, background: editor ? '#fff' : tk.card, border: `1px solid ${editor ? 'rgb(224, 224, 224)' : color}` }}>
                {n.text}
              </div>
            );
          }
          if (recite?.whole) {
            // 「一键遮住要点」：叶子整段铺文字色底（BlankedText bg-current，字与底同色即看不见）；
            // 点开后底色 300ms 渐变成 emerald-100（transition-colors duration-300），字随之浮现
            const rk = recite.revealed[n.id] ?? 0;
            const hi = tk.dark ? brand.emerald900a : brand.emerald100;
            return (
              <div key={n.id} style={{ ...base, padding: '2px 4px 4px 4px', fontSize: 14, borderBottom: `1.5px solid ${color}`, justifyContent: 'flex-start' }}>
                <span
                  style={{
                    position: 'absolute',
                    left: 2.25,
                    right: 2.25,
                    top: 4,
                    bottom: 5.5,
                    borderRadius: 3,
                    background: rk > 0 ? `color-mix(in srgb, ${hi} ${rk * 100}%, ${tk.foreground})` : tk.foreground,
                    opacity: rk > 0 ? (recite.highlight ?? 1) : (recite.mask ?? 1),
                  }}
                />
                <span style={{ position: 'relative' }}>{n.tex ? <Tex tex={n.tex} style={{ fontSize: 15 }} /> : n.text}</span>
              </div>
            );
          }
          return (
            <div
              key={n.id}
              style={{ ...base, padding: '2px 4px 4px 4px', fontSize: 14, borderBottom: `1.5px solid ${color}`, justifyContent: 'flex-start' }}
            >
              <NodeLabel n={n} tk={tk} recite={recite} />
            </div>
          );
        })}
      </div>
    </div>
  );
};

/** MindmapGraph 的取景（相当于 React Flow fitView）：缩放与图心（图坐标），图心落在容器中心。 */
export const graphFrame = (from: LayoutId, to: LayoutId, k: number, width: number, height: number, fit = 0.86, maxScale = Infinity) => {
  const ba = bounds(LAYOUTS[from]);
  const bb = bounds(LAYOUTS[to]);
  return {
    scale: Math.min((width * fit) / lerp(ba.w, bb.w, k), (height * fit) / lerp(ba.h, bb.h, k), maxScale),
    cx: lerp(ba.cx, bb.cx, k),
    cy: lerp(ba.cy, bb.cy, k),
  };
};

/** 节点中心（图坐标），布局形变中按 k 插值。 */
export const nodePos = (from: LayoutId, to: LayoutId, k: number, id: string): Pos => ({
  x: lerp(LAYOUTS[from][id].x, LAYOUTS[to][id].x, k),
  y: lerp(LAYOUTS[from][id].y, LAYOUTS[to][id].y, k),
});

/** 分支色（src/features/mindmap/styles/themes/palettes.ts），根节点沿用默认分支。 */
export const nodeColor = (n: MMNode, dark = false) => {
  const palette = dark ? DARK_PALETTE : LIGHT_PALETTE;
  return palette[branchOf(n) % palette.length];
};

const ctl: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 6,
  borderRadius: 6,
};

/** 对话内嵌导图卡（MindmapCitationCard → MindMapEmbed）。 */
export const MindmapCard = ({
  tk,
  width,
  height = 280,
  enter,
  openPress = 0,
  children,
}: {
  tk: Tokens;
  width: number;
  height?: number;
  enter?: (n: MMNode, i: number) => number;
  openPress?: number;
  children?: ReactNode;
}) => (
  <div
    style={{
      position: 'relative',
      width,
      height,
      borderRadius: 7,
      border: `1px solid color-mix(in hsl, ${tk.border} 50%, transparent)`,
      overflow: 'hidden',
      background: tk.background,
    }}
  >
    {children ?? <MindmapGraph tk={tk} from="balanced" to="balanced" k={0} width={width} height={height} enter={enter} fit={0.8} />}
    <MindmapCardChrome tk={tk} openPress={openPress} />
  </div>
);

/** 卡片右上「打开」按钮（42.5×28，距右 8、距顶 6）的中心，相对卡片右上角。 */
export const CARD_OPEN_BTN = { right: 8 + 42.5 / 2, top: 6 + 14 } as const;

/** 内嵌导图卡的浮层控件：标题行（标题 12px + 节点数 11px … 打开）+ 左下角缩放组（probe-clv-open）。 */
export const MindmapCardChrome = ({ tk, openPress = 0, opacity = 1 }: { tk: Tokens; openPress?: number; opacity?: number }) => {
  const chrome: CSSProperties = {
    ...ctl,
    background: `color-mix(in hsl, ${tk.background} 80%, transparent)`,
    border: `1px solid color-mix(in hsl, ${tk.border} 50%, transparent)`,
    color: tk.mutedFg,
  };
  return (
    <div style={{ position: 'absolute', inset: 0, opacity, pointerEvents: 'none' }}>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 0,
          height: 40,
          background: `linear-gradient(to bottom, color-mix(in hsl, ${tk.background} 80%, transparent), transparent)`,
          fontFamily: font.ui,
        }}
      >
        <span style={{ position: 'absolute', left: 11.5, top: 9.7, display: 'inline-flex', alignItems: 'baseline', gap: 5.3, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 12, fontWeight: 500, lineHeight: '20.64px', color: `color-mix(in hsl, ${tk.foreground} 80%, transparent)` }}>微分中值定理</span>
          <span style={{ fontSize: 11, lineHeight: '18.92px', color: `color-mix(in hsl, ${tk.mutedFg} 60%, transparent)` }}>{S.nodeCount(MM_NODES.length)}</span>
        </span>
        <span
          style={{
            position: 'absolute',
            right: 8,
            top: 6,
            width: 42.5,
            height: 28,
            boxSizing: 'border-box',
            borderRadius: 5,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: openPress > 0 ? tk.background : 'rgba(255, 255, 255, 0.8)',
            border: '1px solid rgba(224, 224, 224, 0.5)',
            color: tk.mutedFg,
            transform: `scale(${1 - openPress * 0.1})`,
          }}
        >
          <ArrowsOut size={16} />
        </span>
      </div>
      <div style={{ position: 'absolute', left: 10, bottom: 10, display: 'flex', gap: 6 }}>
        {[GitFork, MagnifyingGlassPlus, MagnifyingGlassMinus, Crosshair].map((I, i) => (
          <span key={i} style={chrome}>
            <I size={14} />
          </span>
        ))}
      </div>
    </div>
  );
};


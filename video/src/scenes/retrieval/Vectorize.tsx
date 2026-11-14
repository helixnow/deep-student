import { clamp, ease, PACE, prog, rand } from '../../lib/time';
import { font, light } from '../../theme';
import { CW } from '../../ui/classic';
import {
  BAR,
  barLen,
  BUBBLE,
  cellCss,
  cellValue,
  QUERY_TOKENS,
  RV,
  STRIP,
  STRIP_W,
  STRIP_WORLD,
  TOKEN_DIMS,
  tokenCell,
} from './beats';

let measureCtx: CanvasRenderingContext2D | null = null;
const measure = (s: string) => {
  measureCtx ??= document.createElement('canvas').getContext('2d');
  if (!measureCtx) return [...s].length * BUBBLE.font;
  measureCtx.font = `${BUBBLE.font}px ${font.ui}`;
  return measureCtx.measureText(s).width;
};

/** 词元下方每一维的短横（长度表示数值），池化时转成查询向量里的一根竖条。 */
const DASH = { pitch: 5, h: 2, min: 4, max: 13 };

/**
 * 提问被向量化（世界坐标层，叠在经典窗口之上）：
 * 背景界面虚化压暗 → 词元依次亮起 → 每个词元下面升起一列短横（8 维）→
 * 短横沿弧线飞到气泡下方、转成竖条，汇成 64 根细竖条的查询向量。结尾镜头推到向量，匹配剪辑进 3D。
 */
export const Vectorize = ({ t }: { t: number }) => {
  if (t < RV.focus || t > RV.cut + 0.02) return null;
  const tk = light;
  const widths = QUERY_TOKENS.map(measure);
  const W = widths.reduce((a, b) => a + b, 0);
  const textX = CW.chatX + BUBBLE.right - BUBBLE.padX - W;
  const lineTop = CW.title + BUBBLE.top + BUBBLE.padY;
  const bubbleBottom = lineTop - BUBBLE.padY + BUBBLE.line + BUBBLE.padY * 2;
  const xs = widths.map((_, i) => textX + widths.slice(0, i).reduce((a, b) => a + b, 0));

  const veil = prog(t, RV.focus, RV.focus + 0.26, ease.inOutCubic);
  const labelK = prog(t, RV.pool + 0.22, RV.pool + 0.34, ease.brand) * (1 - prog(t, RV.cut - 0.1, RV.cut - 0.03));
  const stripX0 = STRIP_WORLD.x - STRIP_W / 2;

  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: CW.w, height: CW.h, pointerEvents: 'none' }}>
      {/* 背景界面虚化 + 压白：保留上下文，但不再和向量、标签抢字 */}
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `hsl(0 0% 100% / ${0.82 * veil})`,
          backdropFilter: `blur(${6 * veil}px)`,
        }}
      />

      {/* 气泡副本（与真实气泡同位置），浮在虚化层之上 */}
      <div
        style={{
          position: 'absolute',
          left: textX - BUBBLE.padX,
          top: lineTop - BUBBLE.padY,
          width: W + BUBBLE.padX * 2,
          height: BUBBLE.line + BUBBLE.padY * 2,
          borderRadius: 12,
          background: tk.muted,
          boxShadow: `0 ${12 * veil}px ${32 * veil}px hsl(220 30% 20% / ${0.1 * veil}), 0 1px 2px hsl(220 30% 20% / ${0.06 * veil})`,
        }}
      />
      {QUERY_TOKENS.map((tok, i) => {
        const k = prog(t, RV.tokenize + i * 0.022, RV.tokenize + i * 0.022 + 0.12, ease.brand);
        const fadeOut = 1 - prog(t, RV.pool + 0.1, RV.pool + 0.3);
        return (
          <div key={i} style={{ position: 'absolute', left: xs[i], top: lineTop, width: widths[i], height: BUBBLE.line }}>
            <div
              style={{
                position: 'absolute',
                left: 0.5,
                right: 0.5,
                top: 1,
                bottom: 1,
                borderRadius: 6,
                background: `hsl(215 72% 42% / ${0.09 * k * fadeOut})`,
                boxShadow: `inset 0 0 0 1px hsl(215 72% 42% / ${0.22 * k * fadeOut})`,
                transform: `scale(${0.94 + 0.06 * k})`,
              }}
            />
            <span
              style={{
                position: 'relative',
                fontFamily: font.ui,
                fontSize: BUBBLE.font,
                lineHeight: `${BUBBLE.line}px`,
                color: tk.foreground,
                whiteSpace: 'pre',
              }}
            >
              {tok}
            </span>
          </div>
        );
      })}

      {/* 词元短横 → 查询向量细竖条 */}
      {QUERY_TOKENS.flatMap((_, i) =>
        Array.from({ length: TOKEN_DIMS }, (_, d) => {
          const j = i * TOKEN_DIMS + d;
          const at0 = RV.embed + i * 0.026 + d * 0.008;
          const appear = prog(t, at0, at0 + 0.12, ease.brand);
          if (appear <= 0) return null;
          // 刚升起时数值在跳（模型在算），0.18s 后定格成这个词元的嵌入
          const settle = prog(t, at0 + 0.06, at0 + 0.2, ease.outCubic);
          const jitter = rand(j * 31 + Math.floor(t * PACE * 24)) * 2 - 1;
          const v0 = jitter + (tokenCell(i, d) - jitter) * settle;
          const pool = prog(t, RV.pool + i * 0.012 + d * 0.004, RV.pool + i * 0.012 + d * 0.004 + 0.22, ease.inOutCubic);
          const v = v0 + (cellValue(j) - v0) * pool;
          const dashW = DASH.min + (DASH.max - DASH.min) * barLen(v0);
          const ax = xs[i] + widths[i] / 2;
          const ay = bubbleBottom + 14 + d * DASH.pitch + (1 - appear) * -6;
          const bx = STRIP_WORLD.x + (j - (STRIP.cells - 1) / 2) * STRIP.pitch;
          const by = STRIP_WORLD.y;
          const x = ax + (bx - ax) * pool;
          const y = ay + (by - ay) * pool - Math.sin(pool * Math.PI) * 22;
          const w = dashW + (BAR.w - dashW) * pool;
          const h = DASH.h + (barLen(v) * BAR.h - DASH.h) * pool;
          return (
            <div
              key={j}
              style={{
                position: 'absolute',
                left: x - w / 2,
                top: y - h / 2,
                width: w,
                height: h,
                borderRadius: Math.min(w, h) / 2,
                background: cellCss(v),
                opacity: clamp(appear * 1.4),
              }}
            />
          );
        }),
      )}

      <div
        style={{
          position: 'absolute',
          left: stripX0,
          top: STRIP_WORLD.y - BAR.h / 2 - 26,
          width: STRIP_W,
          display: 'flex',
          justifyContent: 'space-between',
          fontFamily: font.ui,
          fontSize: 11,
          lineHeight: '14px',
          color: tk.mutedFg,
          opacity: labelK,
          transform: `translateY(${(1 - labelK) * 4}px)`,
        }}
      >
        <span>查询向量</span>
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>1024 维</span>
      </div>
    </div>
  );
};

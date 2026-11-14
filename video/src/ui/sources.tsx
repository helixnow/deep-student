import { ArrowSquareOut, BookOpen, Brain, FileText, NotePencil } from '@phosphor-icons/react';
import type { ReactNode } from 'react';
import { font, type Tokens } from '../theme';

/**
 * 回答末尾的来源面板展开态（UnifiedSourcePanel，取证 probe-clz-open：经典窗口 1760 宽、PDF 面板开着时的 720 聊天栏）。
 * 分类芯片一行（知识库 / 用户记忆）+ 当前分类的来源卡；点正文 [N] 打开时切到该来源所在分类，目标卡跑 usp-citation-pulse。
 */
export const SOURCES_PANEL_H = 176.7;

const PRI = 'rgb(30, 94, 184)';
const OK = 'rgb(37, 147, 95)';
const FG = 'rgb(42, 45, 50)';
const MUTED = 'rgb(101, 105, 114)';

type Source = { n: number; icon: ReactNode; title: string; score: number; snippet: string };
const KB: Source[] = [
  { n: 1, icon: <NotePencil size={15} />, title: '证明笔记 · 拉格朗日中值定理', score: 88, snippet: '……① 构造 φ(x) = f(x) − 弦 AB；② φ(a) = φ(b)，满足罗尔定理；③ φ′(ξ) = 0 ⇒ 斜率相等' },
  { n: 2, icon: <FileText size={15} />, title: '高等数学（第七版）上册 · 第 134 页', score: 93, snippet: '……引进辅助函数 φ(x)。容易验证 φ(a) = φ(b) = 0，且 φ(x) 在闭区间 [a, b] 上连续、在开区间 (a, b) 内可导。根据罗尔定理' },
];

const Pill = ({ active, icon, label, count }: { active: boolean; icon: ReactNode; label: string; count: number }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 5,
      height: 26.3,
      boxSizing: 'border-box',
      padding: '0 10px 0 11px',
      borderRadius: 999,
      border: `1px solid ${active ? 'rgba(30, 94, 184, 0.4)' : 'rgba(224, 224, 224, 0.25)'}`,
      background: active ? 'rgba(30, 94, 184, 0.1)' : 'rgba(240, 240, 240, 0.6)',
      color: active ? PRI : MUTED,
      fontSize: 10.92,
      fontWeight: 500,
      whiteSpace: 'nowrap',
    }}
  >
    {icon}
    {label}
    <span
      style={{
        padding: '2px 5px',
        borderRadius: 999,
        fontSize: 9.52,
        lineHeight: 1,
        fontVariantNumeric: 'tabular-nums',
        background: active ? 'rgba(30, 94, 184, 0.15)' : 'rgba(101, 105, 114, 0.12)',
        color: active ? PRI : 'rgba(101, 105, 114, 0.8)',
      }}
    >
      {count}
    </span>
  </span>
);

/** usp-citation-pulse（2s，关键帧 0% / 60% / 100%，每段 ease-out）：k = 0 → 1 走完一遍。 */
const BORDER = 'rgba(224, 224, 224, 0.5)';
const pulseStyle = (k: number) => {
  if (k <= 0 || k >= 1) return { border: BORDER, background: 'rgb(252, 252, 252)', boxShadow: 'none' };
  const first = k < 0.6;
  const u = first ? k / 0.6 : (k - 0.6) / 0.4;
  const e = 1 - (1 - u) ** 2;
  const lerp = (a: number, b: number) => a + (b - a) * e;
  const ring = first ? lerp(3, 2) : lerp(2, 0);
  const ringA = first ? lerp(0.35, 0.15) : lerp(0.15, 0);
  const bg = first ? lerp(0.12, 0.06) : lerp(0.06, 0);
  const border = first ? `rgba(30, 94, 184, ${lerp(0.7, 0.5)})` : `color-mix(in srgb, rgba(30, 94, 184, 0.5) ${(1 - e) * 100}%, ${BORDER})`;
  return {
    border,
    background: `color-mix(in srgb, ${PRI} ${bg * 100}%, rgb(252, 252, 252))`,
    boxShadow: ring > 0.01 ? `0 0 0 ${ring}px rgba(30, 94, 184, ${ringA})` : 'none',
  };
};

const Card = ({ s, x, pulse }: { s: Source; x: number; pulse: number }) => {
  const p = pulseStyle(pulse);
  return (
    <span
      style={{
        position: 'absolute',
        left: x,
        top: 48.8,
        width: 196,
        height: 113.4,
        boxSizing: 'border-box',
        borderRadius: 12,
        border: `1px solid ${p.border}`,
        background: p.background,
        boxShadow: p.boxShadow,
      }}
    >
      <span style={{ position: 'absolute', left: 10, top: 10.3, width: 20, height: 20, borderRadius: 999, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(30, 94, 184, 0.1)', color: PRI, fontSize: 10.08, fontWeight: 600 }}>
        {s.n}
      </span>
      <span style={{ position: 'absolute', left: 37, top: 12.8, display: 'inline-flex', color: MUTED }}>{s.icon}</span>
      <span style={{ position: 'absolute', left: 59, top: 11.3, width: 71, fontSize: 12, fontWeight: 500, lineHeight: '18px', color: FG, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</span>
      <span
        style={{
          position: 'absolute',
          left: 137.2,
          top: 10,
          width: 46.8,
          height: 20.7,
          boxSizing: 'border-box',
          borderRadius: 999,
          border: '1px solid rgba(37, 147, 95, 0.3)',
          background: 'rgba(37, 147, 95, 0.08)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 4,
          color: OK,
          fontSize: 9.8,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        <i style={{ width: 5, height: 5, borderRadius: 999, background: OK }} />
        {s.score}%
      </span>
      <span
        style={{
          position: 'absolute',
          left: 10,
          top: 35.9,
          width: 174,
          height: 33,
          fontSize: 11,
          lineHeight: '16.5px',
          color: MUTED,
          overflow: 'hidden',
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
        }}
      >
        {s.snippet}
      </span>
      <span style={{ position: 'absolute', left: 10, right: 10, top: 74.2, height: 27.3, borderTop: '1px solid rgba(224, 224, 224, 0.5)' }}>
        <span style={{ position: 'absolute', left: 0, top: 9.6, fontSize: 9.52, lineHeight: '14.28px', color: MUTED }}>知识库</span>
        <span style={{ position: 'absolute', left: 55, top: 6.2, height: 21, display: 'inline-flex', alignItems: 'center', gap: 6, padding: '0 0 0 11.5px', fontSize: 11, fontWeight: 500, color: PRI }}>
          <ArrowSquareOut size={12} />
          在知识库中打开
        </span>
      </span>
    </span>
  );
};

export const SourcesPanel = ({ tk, width, target = 2, pulse = 0 }: { tk: Tokens; width: number; target?: number; pulse?: number }) => (
  <div
    style={{
      position: 'relative',
      width,
      height: SOURCES_PANEL_H,
      boxSizing: 'border-box',
      borderRadius: 16,
      border: '1px solid rgba(224, 224, 224, 0.35)',
      background: tk.dark ? tk.card : 'rgb(252, 252, 252)',
      fontFamily: font.ui,
    }}
  >
    <span style={{ position: 'absolute', left: 12, top: 10, display: 'flex', gap: 6 }}>
      <Pill active icon={<BookOpen size={16} />} label="知识库" count={KB.length} />
      <Pill active={false} icon={<Brain size={16} />} label="用户记忆" count={1} />
    </span>
    {KB.map((s, i) => (
      <Card key={s.n} s={s} x={12 + i * 204} pulse={s.n === target ? pulse : 0} />
    ))}
  </div>
);

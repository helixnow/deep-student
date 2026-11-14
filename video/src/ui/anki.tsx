import {
  ArrowsClockwise,
  CaretDown,
  CaretLeft,
  CaretRight,
  Cards,
  Check,
  CheckCircle,
  CircleNotch,
  DotsThree,
  DownloadSimple,
  FloppyDisk,
  ListChecks,
  Pause,
  Pencil,
  Play,
  Stack,
  Stop,
} from '@phosphor-icons/react';
import type { CSSProperties, ReactNode } from 'react';
import { ease, lerp, PACE, prog } from '../lib/time';
import { ANKI_CARDS, PR } from '../scenes/practice/beats';
import { S } from '../strings';
import { font, type Tokens } from '../theme';

/**
 * 对话里的 Anki 卡片块（ankiCardsBlock → AnkiCardStackPreview → Card3DPreview .chat-card3d-compact + chatanki-bottom-actions）。
 * 取证 cza-*（demo-anki-cards，probe-cza-6 / cza-bottom）：≤3 张平铺内联卡，第 4 张起 3D 叠放（自动播放默认关）；
 * 进度卡从一开始就在（后端先检测 AnkiConnect 并发 routing 进度），生成中带「正在生成第 N 张卡片…」，完成后多出小结条；
 * 生成中操作行前面有「暂停 / 取消」（有 documentId 时），卡片操作禁用（opacity 0.4）。
 * 真实后端卡片以 UUID 入库并在完成时自动入队，「复习这批」完成即可点；演示壳卡片 id 是 chat-batch-demo-N 占位，取证里那颗按钮是灰的。
 */
export const AK = {
  w: 656,
  inset: 24,
  flatH: 100,
  flatGap: 12,
  cardW: 300,
  /** 卡高 = 正面内容（上下 18 + 行高 26.25）+ 36；这批正面都是一行。 */
  cardH: 98,
  ctlTop: 8,
  cardTop: 91.6,
  navGap: 40,
  navH: 40,
  rowH: 35,
  statusH: 40.5,
  progH: 89.5,
  tickerH: 22,
  actH: 46.5,
} as const;

const N = ANKI_CARDS.length;
const FG = 'rgb(42, 45, 50)';
const MUTED = 'rgb(101, 105, 114)';
const PRI = 'rgb(30, 94, 184)';
const OK = 'rgb(37, 147, 95)';
const MUTED_BG = 'rgba(240, 240, 240, 0.6)';
const SOFT_LINE = 'rgba(224, 224, 224, 0.3)';
const at = (x: number, y: number): CSSProperties => ({ position: 'absolute', left: x, top: y });

const arrive = (i: number) => PR.cards0 + i * PR.cardGap;
const countAt = (t: number) => ANKI_CARDS.filter((_, i) => t >= arrive(i)).length;
/** 平铺 → 叠放：第 4 张卡到达时切换。 */
const stackK = (t: number) => prog(t, arrive(3), arrive(3) + 0.05);
const itemK = (t: number, i: number) => prog(t, arrive(i), arrive(i) + 0.08, ease.brand);

const flatListH = (t: number) => {
  let h = 0;
  for (let i = 0; i < 3; i++) h += itemK(t, i) * (AK.flatH + AK.flatGap);
  return Math.max(0, h - AK.flatGap * itemK(t, 0));
};
const STACK_H = AK.cardTop + AK.cardH + AK.navGap + AK.navH;

/** 生成阶段：先 routing（检测 AnkiConnect / 路由），首张卡前进入 generating。 */
const generating = (t: number) => t >= PR.cards0 - 0.03;

/** 各段在块内的纵向位置（块局部坐标）。首张卡到达前列表区只有一行「正在生成卡片...」、没有张数行。 */
export const ankiLayout = (t: number) => {
  const started = t >= PR.cards0;
  const list = started ? lerp(flatListH(t), STACK_H, stackK(t)) : 21;
  const row = list + 7;
  const statusK = prog(t, PR.done, PR.done + 0.075, ease.brand);
  const status = (started ? row + AK.rowH : list) + 7;
  const prog0 = status + (AK.statusH + 7) * statusK;
  const progH = AK.progH + (generating(t) ? AK.tickerH * (1 - statusK) : 0);
  const act = prog0 + progH + 10.5;
  return { list, row, status, statusK, prog: prog0, progH, act, h: act + AK.actH };
};

/** 操作行（DsButton ghost，13px，间距 7；宽度取自 probe-cza-bottom，牌组按钮按「高数 · 中值定理」字宽）。 */
type ActId = 'pause' | 'cancel' | 'edit' | 'save' | 'review' | 'deck' | 'more';
const ACT_W: Record<ActId, number> = { pause: 73.5, cancel: 73.5, edit: 73.5, save: 114.5, review: 101.5, deck: 135.5, more: 35 };
const actRow = (busy: boolean, hasCards: boolean): ActId[] => [...(busy ? (['pause', 'cancel'] as const) : []), ...(hasCards ? (['edit', 'save', 'review', 'deck', 'more'] as const) : [])];
const actX = (row: ActId[], id: ActId) => {
  let x = 0;
  for (const a of row) {
    if (a === id) return x;
    x += ACT_W[a] + 7;
  }
  return x;
};
export const ankiActionCenter = (id: 'review', t: number) => ({ x: actX(actRow(t < PR.done, true), id) + ACT_W[id] / 2, y: ankiLayout(t).act + 11.5 + 17.5 });

const ActBtn = ({ x, w, icon, label, disabled, hover = 0, press = 0, color }: { x: number; w: number; icon: ReactNode; label: string; disabled?: boolean; hover?: number; press?: number; color?: string }) => (
  <span
    style={{
      ...at(x, 11.5),
      width: w,
      height: 35,
      borderRadius: 9,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 7,
      fontSize: 13,
      fontWeight: 500,
      color: color ?? (hover > 0.5 ? FG : MUTED),
      whiteSpace: 'nowrap',
      opacity: disabled ? 0.4 : 1,
      background: hover > 0 ? `rgba(240, 240, 240, ${0.9 * hover})` : 'transparent',
      transform: `scale(${1 - press * 0.05})`,
    }}
  >
    {icon}
    {label ? label : null}
  </span>
);

const RoundBtn = ({ x, y, children, bg = MUTED_BG }: { x: number; y: number; children: ReactNode; bg?: string }) => (
  <span style={{ ...at(x, y), width: 40, height: 40, boxSizing: 'border-box', borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: FG, background: bg, border: `1px solid ${SOFT_LINE}` }}>
    {children}
  </span>
);

/** 卡面（模板正面：15px / 600、行高 1.75，底 252、圆角 10，下方柔影）。 */
const CardFace = ({ text, w, h, radius = 10, border }: { text: string; w: number; h: number; radius?: number; border?: string }) => (
  <div
    style={{
      position: 'relative',
      width: w,
      height: h,
      boxSizing: 'border-box',
      borderRadius: radius,
      background: 'rgb(252, 252, 252)',
      border,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '18px 38px',
      textAlign: 'center',
      fontFamily: font.ui,
      fontSize: 15,
      fontWeight: 600,
      lineHeight: 1.75,
      color: FG,
    }}
  >
    {text}
  </div>
);

const ProgressStep = ({ x, idx, label, state, t }: { x: number; idx: number; label: string; state: 'done' | 'active' | 'pending'; t: number }) => {
  const c = state === 'done' ? OK : state === 'active' ? PRI : MUTED;
  return (
    <>
      <span
        style={{
          ...at(x, 16.8),
          width: 17.5,
          height: 17.5,
          boxSizing: 'border-box',
          borderRadius: 9999,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          border: `1px solid ${state === 'pending' ? 'rgb(224, 224, 224)' : c}`,
          background: state === 'done' ? OK : state === 'active' ? 'rgba(30, 94, 184, 0.1)' : 'rgba(255, 255, 255, 0.4)',
          color: state === 'done' ? '#fff' : c,
          fontSize: 10,
        }}
      >
        {state === 'done' ? <Check size={10.5} weight="bold" /> : state === 'active' ? <CircleNotch size={10.5} style={{ transform: `rotate(${t * 720}deg)` }} /> : idx + 1}
      </span>
      <span style={{ ...at(x + 22.8, 20), fontSize: 11, lineHeight: '11px', color: c, whiteSpace: 'nowrap' }}>{label}</span>
    </>
  );
};

export const AnkiBlock = ({ tk, t, reviewHover = 0, reviewPress = 0 }: { tk: Tokens; t: number; reviewHover?: number; reviewPress?: number }) => {
  const appear = prog(t, PR.block, PR.block + 0.075, ease.brand);
  if (appear <= 0) return null;
  const n = countAt(t);
  const done = t >= PR.done;
  const L = ankiLayout(t);
  const sk = stackK(t);
  const gen = generating(t);
  const row = actRow(!done, n > 0);
  // 进度百分比：Progress 宽度 duration-500 ease-out 平滑
  const pct = done ? 100 : Math.round((n / N) * 100);
  const barPct = Math.min(100, ANKI_CARDS.reduce((s, _, i) => s + prog(t, arrive(i), arrive(i) + 0.25, ease.outCubic), 0) / N * 100);
  const secs = Math.max(1, Math.round((PR.done - PR.block) * PACE));
  const W = AK.w;
  const cx = W / 2;
  /** 计数胶囊：左右 10 内边距 + 「1 / n」（12px 数字约 6.7 宽）。 */
  const counterW = n < 10 ? 45.7 : 52.4;

  return (
    <div style={{ position: 'relative', width: W, height: L.h, fontFamily: font.ui, opacity: appear }}>
      {n === 0 ? (
        <span style={{ ...at(0, 0), fontSize: 14, lineHeight: '21px', color: tk.mutedFg, opacity: 0.55 + 0.45 * Math.abs(Math.sin(t * Math.PI * 1.2)) }}>{S.anki.generating}</span>
      ) : null}

      {/* ≤3 张：平铺内联卡 */}
      {n > 0 && sk < 1 ? (
        <div style={{ position: 'absolute', left: 0, top: 0, width: W, opacity: 1 - sk }}>
          {[0, 1, 2].map((i) => {
            const k = itemK(t, i);
            if (k <= 0) return null;
            let y = 0;
            for (let j = 0; j < i; j++) y += itemK(t, j) * (AK.flatH + AK.flatGap);
            return (
              <div key={i} style={{ position: 'absolute', left: AK.inset, top: y, opacity: k, transform: `translateY(${(1 - k) * 6}px)` }}>
                <CardFace text={ANKI_CARDS[i].front} w={W - AK.inset * 2} h={AK.flatH} radius={12} border="1px solid rgba(224, 224, 224, 0.6)" />
              </div>
            );
          })}
        </div>
      ) : null}

      {/* ≥4 张：3D 叠放（当前卡居中，其余向右错开：横移 70%、translateZ −80、rotateY −5°、缩 0.08 / 张） */}
      {sk > 0 ? (
        <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: STACK_H, opacity: sk }}>
          <RoundBtn x={W - 12 - counterW - 8 - 40 - 8 - 40} y={AK.ctlTop}>
            <Play size={16} weight="fill" />
          </RoundBtn>
          <RoundBtn x={W - 12 - counterW - 8 - 40} y={AK.ctlTop}>
            <ArrowsClockwise size={16} />
          </RoundBtn>
          <span style={{ ...at(W - 12 - counterW, AK.ctlTop + 6), width: counterW, height: 28, boxSizing: 'border-box', borderRadius: 12, background: MUTED_BG, border: `1px solid ${SOFT_LINE}`, fontSize: 12, fontWeight: 500, lineHeight: '26px', textAlign: 'center', color: MUTED, fontVariantNumeric: 'tabular-nums' }}>
            1 / {n}
          </span>
          <div style={{ position: 'absolute', left: 0, top: AK.cardTop, width: W, height: AK.cardH + 24, overflow: 'hidden', perspective: 1200 }}>
            <div style={{ position: 'absolute', inset: 0, transformStyle: 'preserve-3d' }}>
              {ANKI_CARDS.map((c, i) => {
                const k = itemK(t, i);
                if (k <= 0 || i > 4) return null;
                return (
                  <div
                    key={c.front}
                    style={{
                      position: 'absolute',
                      left: cx - AK.cardW / 2,
                      top: 0,
                      zIndex: 100 - i,
                      opacity: k,
                      transform: `translateX(${i * 0.7 * AK.cardW}px) translateZ(${-i * 80}px) rotateY(${-i * 5}deg) scale(${1 - i * 0.08})`,
                      transformOrigin: '50% 50%',
                    }}
                  >
                    <CardFace text={c.front} w={AK.cardW} h={AK.cardH} />
                    <div style={{ position: 'absolute', left: i === 0 ? '5%' : '10%', width: i === 0 ? '90%' : '80%', bottom: -20, height: 10, background: 'radial-gradient(ellipse at center, hsl(220 20% 10% / 0.15) 0%, transparent 70%)', opacity: i === 0 ? 0.8 : 0.3 }} />
                  </div>
                );
              })}
            </div>
          </div>
          {/* 导航：‹ 圆点（40 宽命中区、可视 200 宽、只露前 4 个）› */}
          <RoundBtn x={cx - 152} y={AK.cardTop + AK.cardH + AK.navGap} bg="rgba(240, 240, 240, 0.5)">
            <CaretLeft size={18} />
          </RoundBtn>
          <div style={{ position: 'absolute', left: cx - 100, top: AK.cardTop + AK.cardH + AK.navGap, width: 200, height: 40, overflow: 'hidden' }}>
            {Array.from({ length: n }, (_, i) => (
              <span
                key={i}
                style={{
                  position: 'absolute',
                  left: i * 48 + 20 - (i === 0 ? 12 : 4),
                  top: 16,
                  width: i === 0 ? 24 : 8,
                  height: 8,
                  borderRadius: i === 0 ? 4 : 999,
                  background: i === 0 ? FG : 'rgba(101, 105, 114, 0.3)',
                }}
              />
            ))}
          </div>
          <RoundBtn x={cx + 112} y={AK.cardTop + AK.cardH + AK.navGap} bg="rgba(240, 240, 240, 0.5)">
            <CaretRight size={18} />
          </RoundBtn>
        </div>
      ) : null}

      {n > 0 ? (
        <>
          {/* 共 N 张卡片 … 点击编辑 → */}
          <span style={{ ...at(0, L.row + 9.3), fontSize: 11, lineHeight: '16.5px', color: MUTED, whiteSpace: 'nowrap' }}>{S.anki.total(n)}</span>
          <span style={{ ...at(W - 73.3, L.row), width: 73.3, height: 35, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 500, color: MUTED, whiteSpace: 'nowrap' }}>{S.anki.clickToEdit}→</span>
        </>
      ) : null}

      {/* 完成态小结条（ui-rise-in） */}
      {L.statusK > 0.001 ? (
        <div style={{ ...at(0, L.status), width: W, height: AK.statusH, boxSizing: 'border-box', borderRadius: 7, background: 'rgba(37, 147, 95, 0.05)', border: '1px solid rgba(37, 147, 95, 0.25)', opacity: L.statusK, transform: `translateY(${(1 - L.statusK) * 4}px)` }}>
          <CheckCircle size={16} weight="fill" color={OK} style={at(11.5, 11.3)} />
          <span style={{ ...at(36.3, 11), display: 'inline-flex', gap: 8, fontSize: 11, lineHeight: '16.5px', whiteSpace: 'nowrap' }}>
            <span style={{ fontWeight: 500, color: FG }}>{S.anki.summary(N)}</span>
            <span style={{ color: MUTED }}>{S.anki.duration(secs)}</span>
          </span>
          <span style={{ ...at(W - 195.1, 5.3), width: 87, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 11, fontWeight: 500, color: MUTED }}>
            <ListChecks size={13} />
            {S.anki.taskCenter}
          </span>
          <span style={{ ...at(W - 104.6, 5.3), width: 98.3, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 6, fontSize: 11, fontWeight: 500, color: MUTED }}>
            <DownloadSimple size={13} />
            {S.anki.exportApkg}
          </span>
        </div>
      ) : null}

      {/* 进度卡：路由 → 生成 → 完成 · AnkiConnect · 百分比 · 进度条 · 正在生成第 N 张 · 卡片：N */}
      <div style={{ ...at(0, L.prog), width: W, height: L.progH, boxSizing: 'border-box', borderRadius: 7, background: 'rgba(240, 240, 240, 0.1)', border: '1px solid rgba(224, 224, 224, 0.5)', overflow: 'hidden' }}>
        {S.anki.steps.map((label, i) => {
          const active = done ? 3 : gen ? 1 : 0;
          const state = i < active ? 'done' : i === active ? 'active' : 'pending';
          return (
            <span key={label}>
              <ProgressStep x={11.5 + i * 93.8} idx={i} label={label} state={state} t={t} />
              {i < 2 ? <span style={{ ...at(11.5 + i * 93.8 + 58.8, 25), width: 21, height: 1, background: state === 'done' ? 'rgba(37, 147, 95, 0.6)' : state === 'active' ? 'rgba(30, 94, 184, 0.4)' : 'rgb(224, 224, 224)' }} /> : null}
            </span>
          );
        })}
        {/* AnkiConnect 已连接 = default 徽标（primary/5 底、primary 字）；刷新钮只在未连接时渲染，徽标直接接在百分比前（gap 7） */}
        <span style={{ ...at(W - 207, 15.5), width: 122.2, height: 20, borderRadius: 9999, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 500, color: PRI, background: 'rgba(30, 94, 184, 0.05)', whiteSpace: 'nowrap' }}>{S.anki.ankiConnect}</span>
        <span style={{ ...at(W - 77.7, 17.3), fontSize: 11, lineHeight: '16.5px', color: MUTED, fontVariantNumeric: 'tabular-nums' }}>{pct}%</span>
        <CaretDown size={14} color={MUTED} style={{ ...at(W - 32.5, 18.5), transform: 'rotate(180deg)' }} />
        <span style={{ ...at(11.5, 50), width: W - 23, height: 8, borderRadius: 9999, background: 'rgba(240, 240, 240, 0.5)', overflow: 'hidden' }}>
          <span style={{ display: 'block', height: '100%', width: `${done ? 100 : barPct}%`, background: PRI, borderRadius: 9999 }} />
        </span>
        {gen && !done ? <span style={{ ...at(11.5, 65), fontSize: 11, lineHeight: '16.5px', color: MUTED, whiteSpace: 'nowrap' }}>{S.anki.generatingNth(Math.min(N, n + 1))}</span> : null}
        <span style={{ ...at(11.5, gen && !done ? 65 + AK.tickerH : 65), fontSize: 11, lineHeight: '16.5px', color: MUTED, whiteSpace: 'nowrap' }}>{S.anki.cardsValue(n)}</span>
      </div>

      {/* 操作行：生成中前面是「暂停 / 取消」，卡片操作禁用；完成后「复习这批」可用 */}
      <div style={{ ...at(0, L.act), width: W, height: AK.actH, borderTop: '1px solid rgba(224, 224, 224, 0.5)' }}>
        {row.includes('pause') ? <ActBtn x={actX(row, 'pause')} w={ACT_W.pause} icon={<Pause size={14} />} label={S.anki.pause} /> : null}
        {row.includes('cancel') ? <ActBtn x={actX(row, 'cancel')} w={ACT_W.cancel} icon={<Stop size={14} />} label={S.anki.cancel} color={tk.destructive} /> : null}
        {n > 0 ? (
          <>
            <ActBtn x={actX(row, 'edit')} w={ACT_W.edit} icon={<Pencil size={14} />} label={S.anki.edit} />
            <ActBtn x={actX(row, 'save')} w={ACT_W.save} icon={<FloppyDisk size={16} />} label={S.anki.add} disabled={!done} />
            <ActBtn x={actX(row, 'review')} w={ACT_W.review} icon={<Stack size={16} />} label={S.anki.review} disabled={!done} hover={reviewHover} press={reviewPress} />
            <ActBtn x={actX(row, 'deck')} w={ACT_W.deck} icon={<Cards size={14} />} label="高数 · 中值定理" />
            <ActBtn x={actX(row, 'more')} w={ACT_W.more} icon={<DotsThree size={20} />} label="" />
          </>
        ) : null}
      </div>
    </div>
  );
};

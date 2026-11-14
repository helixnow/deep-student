import {
  ArrowsLeftRight,
  CaretDown,
  Check,
  CircleNotch,
  Columns,
  Copy,
  Download,
  FileArrowUp,
  Info,
  Lightning,
  PencilSimple,
  Rows,
  SpeakerHigh,
  TextAa,
  Translate,
  Trash,
  X,
} from '@phosphor-icons/react';
import type { CSSProperties } from 'react';
import { clamp, ease } from '../lib/time';
import { S } from '../strings';
import { font, type Tokens } from '../theme';
import { at, Btn, CollapsingSidebar, FULL_W, FULL_X, HOVER_BG, mix, RESOURCE_NEW_PT, ResourceHome, ResourceSidebar } from './resource';

/**
 * 翻译：ResourceAppWorkspace（左栏翻译列表）+ TranslationContentView（新建引导条 + 翻译工作台）。
 * 片中走产品真实路径：选择一个项目 →「新建翻译」→ 引导条滑入 + 空工作台 → 粘贴原文 →「翻译」→ 流式译文
 * → 完成后自动保存：引导条随会话有了原文而消失（整个工作台上移）、右下角「已保存」。
 * 几何取自真机 DOM 取证（video/out/cap/probe-y*.txt），默认窗口 880×620（apps/content/register.ts defaultFrame）。
 */
export const TRANS_W = 880;
export const TRANS_H = 620;

const NEW_NAME = '新翻译';
const SOURCE =
  'The testing effect refers to the finding that retrieving information from memory produces better long-term retention than restudying the same material for an equal amount of time.\n\nCrucially, the benefit grows when retrieval is effortful and spaced out over days rather than massed into a single session, which is why low-stakes quizzes outperform rereading.\n\nFeedback after each attempt matters as well: learners who see the correct answer immediately correct their misconceptions instead of rehearsing their errors.\n\nTaken together, these results suggest that study tools should schedule retrieval, not exposure — a principle that modern spaced-repetition algorithms such as FSRS make explicit.';
const TARGET =
  '测试效应指的是：与花同样时间重读材料相比，从记忆中主动提取信息能带来更好的长期保持。\n\n关键在于，当提取需要付出努力、并且分散在数天之内而非集中在一次学习中时，收益会进一步增大——这也是低风险小测优于反复重读的原因。\n\n每次作答后的反馈同样重要：立即看到正确答案的学习者会纠正误解，而不是一再强化自己的错误。\n\n综合来看，这些结果表明，学习工具应当安排「提取」，而不是安排「接触」——FSRS 等现代间隔重复算法正是把这一原则写进了调度之中。';
/** 新建空翻译的引导条高度：会话保存出原文前一直在，消失时整个工作台上移这么多 */
const HINT_H = 39.5;
const SOURCE_BOTTOM = 545.6;
const FOOTER_TOP = 595.6;
/** 新建后资源列表自动收起，工作台占满 877 宽（probe-tz*.txt）：左栏 434.5 | 拖柄 5.3 | 右栏 435.5 */
const X0 = FULL_X;
const PANE_W = 434.5;
const PANE_R = PANE_W + X0;
const DIV_X = PANE_R + 1;
const COL_X = 442.8;
const COL_W = 435.5;

export type TransStage = 'home' | 'draft' | 'running' | 'done';
export type TransTarget = 'new' | 'run';

export type TransState = {
  stage: TransStage;
  /** 视图切换淡入 0–1 */
  enter: number;
  /** 资源列表收起进度 0–1（新建后） */
  collapse: number;
  /** 引导条滑入 0–1（ui-slide-in-top 400ms） */
  hint: number;
  pasted: boolean;
  hover: TransTarget | null;
  press: number;
  /** 已流出的译文字符数 */
  run: number;
  /** 完成（自动保存）后经过的脚本秒；未完成为负 */
  sinceDone: number;
  /** 真实时间秒：转圈 1s/圈，animate-pulse 2s 一个来回 */
  clock: number;
};

const LINE = 'rgba(224,224,224,0.5)';

const Spin = ({ size, color, clock, style }: { size: number; color: string; clock: number; style?: CSSProperties }) => (
  <CircleNotch size={size} color={color} style={{ ...style, transform: `rotate(${(clock * 360) % 360}deg)` }} />
);

const Switch = ({ tk, x, y, on }: { tk: Tokens; x: number; y: number; on: boolean }) => (
  <>
    <span style={{ ...at(x, y), width: 38.5, height: 21, borderRadius: 999, background: on ? tk.primary : mix(tk.mutedFg, 20) }} />
    <span style={{ ...at(on ? x + 19.5 : x + 2, y + 1.8), width: 17.5, height: 17.5, borderRadius: '50%', background: '#fff', boxShadow: '0 1px 2px rgba(0,0,0,0.18)' }} />
  </>
);

/** TranslationMain 工具条：三栏 grid（布局切换 / 语向 / 开关）；全宽时语向组居中，流式中语向后多一个灰字「翻译中...」。 */
const Toolbar = ({ tk, y0, running }: { tk: Tokens; y0: number; running: boolean }) => {
  const lang = { opacity: running ? 0.5 : 1 };
  return (
    <>
      <span style={{ ...at(X0, y0), width: FULL_W, height: 42, background: 'rgba(255,255,255,0.5)' }} />
      <span style={{ ...at(16, y0 + 5.3), width: 71, height: 30.5, borderRadius: 12, background: 'rgb(240,240,240)' }} />
      <span style={{ ...at(19, y0 + 8.3), width: 31.5, height: 24.5, boxSizing: 'border-box', borderRadius: 10, background: 'rgb(253,253,253)', border: '1px solid rgba(224,224,224,0.76)' }} />
      <Columns size={14} color={tk.foreground} style={{ ...at(27.8, y0 + 13.5) }} />
      <Rows size={14} color={tk.mutedFg} style={{ ...at(61.3, y0 + 13.5) }} />
      <span style={{ ...at(351, y0 + 14.5), fontSize: 12, fontWeight: 500, lineHeight: '12px', color: tk.mutedFg, ...lang }}>{S.trans.en}</span>
      <CaretDown size={14} color={tk.mutedFg} style={{ ...at(380.3, y0 + 13.5), ...lang }} />
      <ArrowsLeftRight size={16} color={tk.mutedFg} style={{ ...at(420.5, y0 + 12.5), ...lang }} />
      <span style={{ ...at(462.8, y0 + 14.5), fontSize: 12, fontWeight: 500, lineHeight: '12px', color: tk.mutedFg, ...lang }}>{S.trans.zh}</span>
      <CaretDown size={14} color={tk.mutedFg} style={{ ...at(516, y0 + 13.5), ...lang }} />
      {running ? <span style={{ ...at(573.8, y0 + 12.8), fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg }}>{S.trans.translating}</span> : null}
      <Switch tk={tk} x={650} y={y0 + 10} on={false} />
      <span style={{ ...at(695.5, y0 + 14.5), fontSize: 12, fontWeight: 500, lineHeight: '12px', color: tk.mutedFg }}>{S.trans.auto}</span>
      <Switch tk={tk} x={764.5} y={y0 + 10} on />
      <span style={{ ...at(810, y0 + 14.5), fontSize: 12, fontWeight: 500, lineHeight: '12px', color: tk.mutedFg }}>{S.trans.sync}</span>
    </>
  );
};

const Header = ({ x, y, w }: { x: number; y: number; w: number }) => (
  <span style={{ ...at(x, y), width: w, height: 35, boxSizing: 'border-box', background: 'rgba(255,255,255,0.5)', borderBottom: `1px solid ${LINE}` }} />
);

const SourcePanel = ({ tk, s, y0 }: { tk: Tokens; s: TransState; y0: number }) => {
  const top = y0 + 42;
  const taTop = top + 35;
  const running = s.stage === 'running';
  const hover = s.hover === 'run';
  const btnColor = hover ? tk.foreground : tk.mutedFg;
  return (
    <>
      <Header x={X0} y={top} w={PANE_W} />
      <TextAa size={14} color={tk.mutedFg} style={{ ...at(16, top + 10) }} />
      <span style={{ ...at(35.3, top + 8.6), fontSize: 12, lineHeight: '16.8px', color: mix(tk.foreground, 70) }}>{S.trans.source}</span>
      <span style={{ ...at(X0, top + 9.3), width: PANE_R - 49 - X0, textAlign: 'right', fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg, fontVariantNumeric: 'tabular-nums' }}>
        {`${(s.pasted ? SOURCE.length : 0).toLocaleString()} / 50,000`}
      </span>
      <Trash size={14} color={mix(tk.mutedFg, 60)} style={{ ...at(PANE_R - 35, top + 10), opacity: s.pasted && !running ? 1 : 0.5 }} />
      <div style={{ ...at(X0, taTop), width: PANE_W, height: SOURCE_BOTTOM - taTop, overflow: 'hidden' }}>
        {s.pasted ? (
          <div style={{ position: 'absolute', left: 14, top: 18.25, width: PANE_W - 28, fontSize: 12, lineHeight: '19.5px', color: tk.foreground, whiteSpace: 'pre-wrap' }}>{SOURCE}</div>
        ) : (
          <span style={{ position: 'absolute', left: 14, top: 18.25, fontSize: 12, lineHeight: '19.5px', color: mix(tk.mutedFg, 50) }}>{S.trans.placeholder}</span>
        )}
      </div>
      {!s.pasted ? (
        <>
          <Lightning size={12} color={mix(tk.mutedFg, 70)} style={{ ...at(16, 434.5) }} />
          <span style={{ ...at(33, 432.8), fontSize: 11, lineHeight: '15.4px', color: mix(tk.mutedFg, 70) }}>{S.trans.samples}</span>
          {[
            [455.2, S.trans.sampleEn],
            [484.8, S.trans.sampleZh],
          ].map(([y, text]) => (
            <Btn
              key={y as number}
              style={{ ...at(16, y as number), maxWidth: PANE_W - 28, height: 24.4, borderRadius: 999, boxSizing: 'border-box', padding: '0 10.5px', background: 'rgba(255,255,255,0.8)', border: '1px solid rgba(224,224,224,0.7)', fontSize: 11, color: tk.mutedFg, overflow: 'hidden' }}
            >
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{text as string}</span>
            </Btn>
          ))}
          <FileArrowUp size={12} color={mix(tk.mutedFg, 50)} style={{ ...at(16, 517.9) }} />
          <span style={{ ...at(33, 516.2), fontSize: 11, lineHeight: '15.4px', color: mix(tk.mutedFg, 50) }}>{S.trans.dropHint}</span>
        </>
      ) : null}
      <svg width={8} height={8} viewBox="0 0 8 8" style={{ ...at(PANE_R - 9, SOURCE_BOTTOM - 9) }}>
        <path d="M7 1L1 7M7 4.5L4.5 7" stroke={mix(tk.mutedFg, 55)} strokeWidth={1} strokeLinecap="round" />
      </svg>
      <span style={{ ...at(X0, SOURCE_BOTTOM), width: PANE_W, height: 50, boxSizing: 'border-box', background: 'rgba(255,255,255,0.5)', borderTop: `1px solid ${tk.border}` }} />
      {running ? (
        <Btn style={{ ...at(306, 557.1), width: 120, height: 28, borderRadius: 9, justifyContent: 'center', gap: 7, fontSize: 13, fontWeight: 500, color: tk.mutedFg }}>
          <X size={14} />
          {S.trans.cancel}
        </Btn>
      ) : (
        <Btn
          style={{
            ...at(306, 557.1),
            width: 120,
            height: 28,
            borderRadius: 9,
            justifyContent: 'center',
            gap: 10.7,
            fontSize: 13,
            fontWeight: 500,
            color: btnColor,
            opacity: s.pasted ? 1 : 0.5,
            background: hover ? HOVER_BG : 'transparent',
            transform: `scale(${1 - 0.03 * (hover ? s.press : 0)})`,
          }}
        >
          {S.trans.translate}
          <span style={{ fontSize: 10, fontWeight: 500, color: tk.mutedFg }}>⌘↵</span>
        </Btn>
      )}
    </>
  );
};

const TargetPanel = ({ tk, s, y0 }: { tk: Tokens; s: TransState; y0: number }) => {
  const top = y0 + 42;
  const running = s.stage === 'running';
  const has = running || s.stage === 'done';
  const icon = (x: number, I: typeof Copy) => <I key={x} size={16} color={tk.mutedFg} style={{ ...at(x + 6, top + 9), opacity: running ? 0.5 : 1 }} />;
  const pulse = 0.75 + 0.25 * Math.cos(Math.PI * s.clock);
  const shown = TARGET.slice(0, Math.floor(s.run));
  return (
    <>
      <span style={{ ...at(DIV_X, top), width: 5.3, height: FOOTER_TOP - top, background: 'rgb(224, 224, 224)' }} />
      {[-3, 0, 3].map((d) => (
        <span key={d} style={{ ...at(DIV_X + 1.9, (top + FOOTER_TOP) / 2 + d - 0.75), width: 1.5, height: 1.5, borderRadius: '50%', background: mix(tk.mutedFg, 50) }} />
      ))}
      <span style={{ ...at(COL_X, top), width: COL_W, height: FOOTER_TOP - top, background: 'rgba(240,240,240,0.1)' }} />
      <Header x={COL_X} y={top} w={COL_W} />
      <Translate size={14} color={tk.mutedFg} style={{ ...at(COL_X + 14, top + 10) }} />
      <span style={{ ...at(COL_X + 33.3, top + 8.6), fontSize: 12, lineHeight: '16.8px', color: mix(tk.foreground, 70) }}>{S.trans.target}</span>
      {has ? (
        <>
          {icon(698.8, Columns)}
          <span style={{ ...at(733.8, top + 10), width: 1, height: 14, background: tk.border }} />
          {[icon(741.8, PencilSimple), icon(773.3, SpeakerHigh), icon(804.8, Copy), icon(836.3, Download)]}
        </>
      ) : (
        icon(836.3, Columns)
      )}
      {!has ? (
        <span style={{ ...at(COL_X, 349), width: COL_W, textAlign: 'center', fontSize: 13, fontStyle: 'italic', lineHeight: '18.2px', color: mix(tk.mutedFg, 50) }}>{S.trans.resultPlaceholder}</span>
      ) : null}
      {running ? (
        <>
          <Spin size={16} color={tk.primary} clock={s.clock} style={{ ...at(COL_X + 14, 156) }} />
          <span style={{ ...at(COL_X + 37, 155.5), fontSize: 12, lineHeight: '16.8px', color: tk.primary }}>{S.trans.translating}</span>
        </>
      ) : null}
      {has ? (
        <div style={{ ...at(COL_X + 14, running ? 204.4 : 137.6), width: COL_W - 29.5, fontSize: 14, lineHeight: '22.75px', color: tk.foreground, whiteSpace: 'pre-wrap' }}>
          {running ? shown : TARGET}
          {running ? <span style={{ display: 'inline-block', width: 1.8, height: 15.4, marginLeft: 1, verticalAlign: 'text-bottom', background: tk.primary, opacity: pulse }} /> : null}
        </div>
      ) : null}
    </>
  );
};

const Kbd = ({ tk, x, keys, w, label }: { tk: Tokens; x: number; keys: string; w: number; label: string }) => (
  <>
    <span style={{ ...at(x, 600.6), width: w, height: 14.4, boxSizing: 'border-box', borderRadius: 3, background: 'rgba(240,240,240,0.4)', border: '1px solid rgba(224,224,224,0.6)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 9.9, color: tk.mutedFg }}>{keys}</span>
    <span style={{ ...at(x + w + 3.5, 600.1), fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg }}>{label}</span>
  </>
);

const Footer = ({ tk, running }: { tk: Tokens; running: boolean }) => (
  <>
    <span style={{ ...at(X0, FOOTER_TOP), width: FULL_W, height: 1, background: LINE }} />
    <Kbd tk={tk} x={running ? 588.2 : 672.2} keys="⌘+Enter" w={49.8} label={S.trans.sc.translate} />
    <Kbd tk={tk} x={running ? 674 : 758} keys="⌘+Shift+S" w={59.5} label={S.trans.sc.swap} />
    {running ? <Kbd tk={tk} x={791.5} keys="Esc" w={26} label={S.trans.sc.cancel} /> : null}
  </>
);

/** 保存状态徽标（保存中 → 已保存，ui-rise-in 150ms） */
const SaveChip = ({ tk, since }: { tk: Tokens; since: number }) => {
  if (since < 0) return null;
  const saved = since >= 0.04;
  const k = ease.wbOut(clamp((saved ? since - 0.04 : since) / 0.075));
  return (
    <Btn
      style={{
        ...at(795.3, 580.6),
        width: 69.8,
        height: 24.4,
        borderRadius: 999,
        boxSizing: 'border-box',
        padding: '0 0 0 9.7px',
        gap: 5.3,
        background: 'rgba(255,255,255,0.9)',
        border: '1px solid rgba(224,224,224,0.6)',
        boxShadow: tk.shadowSoft,
        fontSize: 11,
        color: saved ? tk.success : tk.mutedFg,
        opacity: k,
        translate: `0 ${(1 - k) * 4}px`,
      }}
    >
      {saved ? <Check size={12} /> : <CircleNotch size={12} />}
      {saved ? S.trans.saved : S.trans.saving}
    </Btn>
  );
};

const Workbench = ({ tk, s }: { tk: Tokens; s: TransState }) => {
  const done = s.stage === 'done';
  const y0 = 39 + (done ? 0 : HINT_H);
  const running = s.stage === 'running';
  return (
    <>
      {!done ? (
        <div style={{ ...at(X0, 39), width: FULL_W, height: HINT_H, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', inset: 0, boxSizing: 'border-box', background: 'rgba(240,240,240,0.2)', borderBottom: `1px solid ${LINE}`, translate: `0 ${-(1 - ease.wbOut(s.hint)) * 100}%` }}>
            <Info size={14} color={tk.info} style={{ position: 'absolute', left: 10.5, top: 12.3 }} />
            <span style={{ position: 'absolute', left: 31.5, top: 11.5, fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg }}>{S.trans.hint}</span>
            <X size={12} color={tk.mutedFg} style={{ position: 'absolute', left: 848.5 - X0, top: 13.3 }} />
          </div>
        </div>
      ) : null}
      <Toolbar tk={tk} y0={y0} running={running} />
      <SourcePanel tk={tk} s={s} y0={y0} />
      <TargetPanel tk={tk} s={s} y0={y0} />
      <Footer tk={tk} running={running} />
      {done ? <SaveChip tk={tk} since={s.sinceDone} /> : null}
    </>
  );
};

export const TranslateView = ({ tk, s }: { tk: Tokens; s: TransState }) => {
  const home = s.stage === 'home';
  const sidebar = <ResourceSidebar tk={tk} winH={TRANS_H} icon={Translate} title={S.trans.title} items={home ? [] : [NEW_NAME]} fresh={!home} settings={S.trans.settings} />;
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: font.sys, background: tk.background, overflow: 'hidden' }}>
      {home ? sidebar : null}
      <div style={{ position: 'absolute', inset: 0, opacity: ease.wbOut(s.enter) }}>
        {home ? <ResourceHome tk={tk} icon={Translate} label={S.trans.newTranslation} btn={{ x: 531.5, w: 89 }} hover={s.hover === 'new'} press={s.press} /> : <Workbench tk={tk} s={s} />}
      </div>
      {home ? null : (
        <CollapsingSidebar tk={tk} k={s.collapse}>
          {sidebar}
        </CollapsingSidebar>
      )}
    </div>
  );
};

/** 片中点到的位置（窗口坐标，含 1px 边框与 38px 标题栏）。 */
export const TRANS_PT = {
  newTranslation: RESOURCE_NEW_PT,
  /** 点进原文输入框，随后 ⌘V（落点在粘贴后第一、二段之间的空行上） */
  input: { x: 220, y: 242 },
  run: { x: 366, y: 571.1 },
} as const;
export const TRANS_LEN = TARGET.length;
/** 各段译文开始流出的位置（字符数），音效按它对点。 */
export const TRANS_PARAS = [0, ...[...TARGET.matchAll(/\n\n/g)].map((m) => m.index! + 2)];

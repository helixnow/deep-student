import {
  ArrowClockwise,
  ArrowRight,
  Cards,
  CaretDown,
  ChartBar,
  ChartPolar,
  CircleNotch,
  ClipboardText,
  Copy,
  Download,
  Eye,
  FileText,
  GraduationCap,
  Image as ImageIcon,
  ListChecks,
  Notebook,
  Pen,
  PencilSimple,
  PenNib,
  Robot,
  Sparkle,
  Trash,
  UploadSimple,
} from '@phosphor-icons/react';
import type { CSSProperties, ReactNode } from 'react';
import { clamp, ease } from '../lib/time';
import { S } from '../strings';
import { font, type Tokens } from '../theme';
import { at, Btn, CollapsingSidebar, FULL_W, FULL_X, HOVER_BG, mix, RESOURCE_NEW_PT, ResourceHome, ResourceSidebar } from './resource';

/**
 * 作文批改：ResourceAppWorkspace（左栏作文列表）+ EssayContentView（InputPanel 上 / ResultPanel 下）。
 * 片中走产品真实路径：选择一个项目 →「新建作文批改」→ 新作文 → 粘贴作文 →「开始批改」→ 流式批注（准备中 → 批注中 → 润色中）
 * → 完成后分数卡插在视口上方 → 往上滚看分数、再往下看雷达 →「润色提升」。
 * 几何取自真机 DOM 取证（video/out/cap/probe-x*.txt），默认窗口 880×620（apps/content/register.ts defaultFrame）。
 * 流式内容与 wb2.mjs 的 mock 是同一份后端 wire 格式（批注标签 → <section-polish> → <score> 在最末尾）。
 */
export const ESSAY_W = 880;
export const ESSAY_H = 620;

const MODE_NAME = '雅思大作文';
const MODEL_NAME = 'deepseek-v4';
/** 摘要行里显示的是模型配置名（essay_grading_get_models 的 name） */
const MODEL_LABEL = 'DeepSeek V4';
const NEW_NAME = '新作文';
const EXISTING = ['雅思大作文：远程办公的利弊', '雅思大作文：城市该不该限车'];
/** 粘贴后的输入统计（真机 xc-4） */
const INPUT_STATS = { han: 0, en: 129, para: 4, punct: 18, chars: 758 };

const ESSAY_TEXT =
  'Some people believe that university education should be free for everyone, while others argue that students should pay for it. In my opinion, the government have to cover most of the cost, but not all of it.\n\nOn the one hand, free education gives every talented students the same chance. Many families cannot afford high tuition fees, and a lot of capable young people give up their studies for this reason.\n\nOn the other hand, completely free universities put heavy pressure on public budgets. If students pay a small part of the fee, they may also value their learning more, which make the system fairer for taxpayers.\n\nIn conclusion, a shared model, where the state pays the majority and students contribute a modest amount, is the most balanced solution.';
const RESULT =
  'Some people believe that university education should be free for everyone, while others argue that students <good>should pay</good> for it. In my opinion, <replace old="the government have to" new="the government should" reason="主语 the government 是单数，且表达观点用 should 更自然；have to 语气过强"/> cover most of the cost, but not all of it.\n\nOn the one hand, free education gives <err type="agreement" explanation="every 后接单数名词：every talented student；也可改成 all talented students">every talented students</err> the same chance. Many families cannot afford high tuition fees, and <replace old="a lot of" new="a considerable number of" reason="a lot of 偏口语，学术写作用 a considerable number of 更正式"/> capable young people give up their studies for this reason.\n\nOn the other hand, <note text="completely free 语气绝对，改成 entirely tuition-free 更准确">completely free</note> universities put heavy pressure on public budgets. If students pay a small part of the fee, they may also <good>value their learning more</good>, which <err type="agreement" explanation="which 指代前面整句话，作单数主语，谓语用 makes">make</err> the system fairer for taxpayers.\n\nIn conclusion, a shared model, where the state pays the majority and students contribute a modest amount, is the most balanced solution.\n\n<section-polish>\n<polish-item>\n<original>Many families cannot afford high tuition fees, and a lot of capable young people give up their studies for this reason.</original>\n<polished>Many families cannot afford high tuition fees, which forces a considerable number of capable young people to abandon their studies.</polished>\n</polish-item>\n<polish-item>\n<original>If students pay a small part of the fee, they may also value their learning more</original>\n<polished>Requiring students to contribute a modest share of the fee may also lead them to value their education more highly</polished>\n</polish-item>\n<polish-item>\n<original>In conclusion, a shared model, where the state pays the majority and students contribute a modest amount, is the most balanced solution.</original>\n<polished>In conclusion, a cost-sharing model, in which the state covers the majority and students contribute a modest amount, offers the most balanced solution.</polished>\n</polish-item>\n</section-polish>\n\n<score total="6.5" max="9">\n<dim name="Task Response" score="6.5" max="9">立场明确（政府承担大部分、学生分担小部分），两方面都有展开，但第二段论据停留在一般性陈述，缺少具体例子支撑。</dim>\n<dim name="Coherence & Cohesion" score="7" max="9">四段结构清晰，On the one hand / On the other hand / In conclusion 衔接自然；段内句间推进还可以更紧。</dim>\n<dim name="Lexical Resource" score="6" max="9">基本词汇使用准确，但 a lot of、completely free 等表达偏口语，学术搭配偏少。</dim>\n<dim name="Grammatical Range & Accuracy" score="6.5" max="9">有定语从句和条件句，句式有变化；主谓一致错误出现 3 处（the government have、every talented students、which make）。</dim>\n</score>';

const POLISH_AT = RESULT.indexOf('<section-polish>');
const POLISH_END = RESULT.indexOf('</section-polish>');
const SCORE_AT = RESULT.indexOf('<score');

// ── 解析 wire 格式 ─────────────────────────────────────
type Seg =
  | { kind: 'text'; text: string; start: number }
  | { kind: 'good' | 'err' | 'note'; text: string; start: number; inner: number; end: number }
  | { kind: 'replace'; old: string; neu: string; start: number; end: number };

/** buildParagraphs：文本按换行切段（space-y-3），批注留在所在段内。 */
const PARAS: Seg[][] = (() => {
  const body = RESULT.slice(0, POLISH_AT);
  const paras: Seg[][] = [[]];
  const pushText = (s: string, from: number) => {
    let i = 0;
    for (const m of s.matchAll(/\n+/g)) {
      if (m.index! > i) paras[paras.length - 1].push({ kind: 'text', text: s.slice(i, m.index), start: from + i });
      paras.push([]);
      i = m.index! + m[0].length;
    }
    if (i < s.length) paras[paras.length - 1].push({ kind: 'text', text: s.slice(i), start: from + i });
  };
  const re = /<good>([\s\S]*?)<\/good>|<replace old="([^"]*)" new="([^"]*)"[^>]*\/>|<(err|note)\b[^>]*>([\s\S]*?)<\/\4>/g;
  let last = 0;
  for (const m of body.matchAll(re)) {
    const start = m.index!;
    const end = start + m[0].length;
    pushText(body.slice(last, start), last);
    const para = paras[paras.length - 1];
    if (m[1] !== undefined) para.push({ kind: 'good', text: m[1], start, inner: start + '<good>'.length, end });
    else if (m[2] !== undefined) para.push({ kind: 'replace', old: m[2], neu: m[3], start, end });
    else para.push({ kind: m[4] as 'err' | 'note', text: m[5], start, inner: end - `</${m[4]}>`.length - m[5].length, end });
    last = end;
  }
  pushText(body.slice(last), last);
  return paras.filter((p) => p.length > 0);
})();
const MARKS = PARAS.flat().filter((s) => s.kind !== 'text') as Array<Exclude<Seg, { kind: 'text' }>>;
const FIRST_MARK = MARKS[0].start;

const DIMS = [...RESULT.matchAll(/<dim name="([^"]+)" score="([^"]+)" max="([^"]+)">([^<]*)<\/dim>/g)].map((m) => ({
  name: m[1],
  score: Number(m[2]),
  max: Number(m[3]),
  comment: m[4],
  start: m.index! + m[0].indexOf('>') + 1,
}));
const TOTAL = 6.5;
const MAX = 9;

// ── 状态 ──────────────────────────────────────────────
export type EssayStage = 'home' | 'draft' | 'grading' | 'done';
export type EssayTarget = 'new' | 'grade' | 'polish';

export type EssayState = {
  stage: EssayStage;
  /** 视图切换淡入 0–1 */
  enter: number;
  /** 资源列表收起进度 0–1（新建后） */
  collapse: number;
  pasted: boolean;
  hover: EssayTarget | null;
  press: number;
  /** 开始批改后原文收成摘要行、结果区接管 0–1 */
  lock: number;
  /** 已流出的原始字符数（含批注标签，= 后端 progress 的 char_count） */
  stream: number;
  /** 每脚本秒流出的原始字符数（批注入场淡入按时间换算） */
  rate: number;
  /** 批改完成后经过的脚本秒（分数卡挂载动画）；未完成为负 */
  sinceDone: number;
  /** 完成后结果区的滚动位置（px） */
  scroll: number;
  tab: 'overview' | 'polish';
  /** 分段切换后内容淡入 0–1（animate-chat-fade-in 200ms） */
  tabEnter: number;
  /** 指针停在结果区（悬停才显示的浮动字数统计）0–1 */
  resultHover: number;
  /** 结果区滚动条（CustomScrollArea 闲置隐藏，滚动 / 跟随流式时出现）0–1 */
  thumb: number;
  /** 真实时间秒：转圈 1s/圈，animate-pulse 2s 一个来回 */
  clock: number;
};

const AMBER = 'rgb(180, 83, 9)';
const EMERALD = 'rgb(4, 120, 87)';
const EMERALD_600 = 'rgb(5, 150, 105)';
const LINE = 'rgba(224,224,224,0.3)';
const LINE_SOFT = 'rgba(224,224,224,0.2)';

const pulseOf = (clock: number) => 0.75 + 0.25 * Math.cos(Math.PI * clock);

const Spin = ({ size, color, clock, style }: { size: number; color: string; clock: number; style?: CSSProperties }) => (
  <CircleNotch size={size} color={color} style={{ ...style, transform: `rotate(${(clock * 360) % 360}deg)` }} />
);

// ── 布局（880 宽窗口新建后资源列表自动收起，主区 877 宽；取证 probe-ey* / probe-ez*）────────
const X0 = FULL_X;
/** 正文 / 分数卡 / 润色卡的居中栏：max-width 728 */
const COL = 76.5;
const COL_W = 728;
const LINE_X = { left: X0, width: FULL_W } as const;

const PHASES = ['preparing', 'annotating', 'scoring', 'polishing', 'model_essay'] as const;
type Phase = 'preparing' | 'annotating' | 'polishing';
/** 产品按内容推断阶段（ResultPanel.inferGradingPhase）：<section-polish 一出现就判成润色，<score> 在它之后，所以评分阶段也显示「润色中」。 */
const phaseOf = (stream: number): Phase => (stream <= 0 ? 'preparing' : stream > POLISH_AT ? 'polishing' : 'annotating');
void PHASES;

// ── 批改前：原文占满（模式行 / 题目参考材料 / 输入区 / 统计 / 模型行），结果折成底部占位条 ──
const TopRows = ({ tk }: { tk: Tokens }) => (
  <>
    <Btn style={{ ...at(16, 45), width: 130.5, height: 28, borderRadius: 5, padding: '0 0 0 13.3px', gap: 7, fontSize: 12, fontWeight: 500, color: tk.mutedFg }}>
      <GraduationCap size={14} />
      {MODE_NAME}
      <CaretDown size={16} />
    </Btn>
    <Btn style={{ ...at(737.2, 45.9), width: 88, height: 26.3, borderRadius: 9, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: mix(tk.mutedFg, 60) }}>
      <ImageIcon size={14} />
      {S.essay.importImages}
    </Btn>
    <span style={{ ...at(828.7, 51.3), fontSize: 11, lineHeight: '15.4px', color: mix(tk.mutedFg, 60) }}>{S.essay.round(1)}</span>
    <span style={{ ...at(X0, 79), width: FULL_W, height: 1, background: LINE }} />
    <span style={{ ...at(16, 87), width: 16, height: 16, borderRadius: 3.5, background: 'rgba(240,240,240,0.6)' }} />
    <FileText size={12} color={mix(tk.mutedFg, 70)} style={{ ...at(18, 89) }} />
    <span style={{ ...at(39, 87.3), fontSize: 11, fontWeight: 500, lineHeight: '15.4px', color: mix(tk.mutedFg, 70) }}>{S.essay.topic}</span>
    <CaretDown size={14} color={mix(tk.mutedFg, 70)} style={{ ...at(850, 88) }} />
    <span style={{ ...at(X0, 110), width: FULL_W, height: 1, background: LINE }} />
  </>
);

/** textarea 的 resize 角标 */
const Grip = ({ tk, bottom }: { tk: Tokens; bottom: number }) => (
  <svg width={8} height={8} viewBox="0 0 8 8" style={{ ...at(870, bottom - 9) }}>
    <path d="M7 1L1 7M7 4.5L4.5 7" stroke={mix(tk.mutedFg, 55)} strokeWidth={1} strokeLinecap="round" />
  </svg>
);

const INPUT_BOTTOM = 507.1;

const InputArea = ({ tk, s }: { tk: Tokens; s: EssayState }) => {
  const st = S.essay.stat;
  if (!s.pasted) {
    const dim = mix(tk.mutedFg, 45);
    const n0 = `${st.han}: 0 · ${st.en}: 0 · ${st.para}: 0 · ${st.punct}: 0 · 0 / 50,000 ${st.chars}`;
    return (
      <>
        <span style={{ ...at(310, 253), width: 260, textAlign: 'center', fontSize: 12, fontWeight: 500, lineHeight: '18px', color: mix(tk.foreground, 70) }}>{S.essay.emptyTitle}</span>
        <span style={{ ...at(310, 274.5), width: 260, textAlign: 'center', fontSize: 11, lineHeight: '17.9px', color: mix(tk.mutedFg, 50) }}>{S.essay.emptyDesc}</span>
        <ClipboardText size={12} color={dim} style={{ ...at(323.3, 321.4) }} />
        <span style={{ ...at(338.8, 320.8), fontSize: 11, lineHeight: '13.2px', color: dim }}>{S.essay.pasteHint}</span>
        <span style={{ ...at(438.3, 320.8), fontSize: 11, lineHeight: '13.2px', color: dim }}>·</span>
        <UploadSimple size={12} color={dim} style={{ ...at(448.7, 321.4) }} />
        <span style={{ ...at(464.2, 320.8), fontSize: 11, lineHeight: '13.2px', color: dim }}>{S.essay.dropHint}</span>
        <Btn style={{ ...at(326.5, 344.5), width: 110, height: 26.3, borderRadius: 9, border: `1px solid ${LINE}`, padding: '0 0 0 10.5px', gap: 7, fontSize: 11, fontWeight: 500, color: mix(tk.mutedFg, 70) }}>
          <ImageIcon size={14} />
          {S.essay.ocr}
        </Btn>
        <Btn style={{ ...at(443.5, 344.5), width: 110, height: 26.3, borderRadius: 9, border: `1px solid ${mix(tk.primary, 25)}`, padding: '0 0 0 10.5px', gap: 7, fontSize: 11, fontWeight: 500, color: mix(tk.primary, 80) }}>
          <Sparkle size={14} />
          {S.essay.sample}
        </Btn>
        <Grip tk={tk} bottom={INPUT_BOTTOM} />
        <span style={{ ...at(X0, 513.7), width: 864 - X0, textAlign: 'right', fontSize: 11, lineHeight: '13px', color: mix(tk.mutedFg, 50), whiteSpace: 'nowrap' }}>{n0}</span>
      </>
    );
  }
  const n = INPUT_STATS;
  return (
    <>
      <div style={{ ...at(X0, 111), width: FULL_W, height: INPUT_BOTTOM - 111, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: COL - X0, top: 17.5, width: COL_W, fontSize: 12, lineHeight: '21.6px', color: tk.foreground, whiteSpace: 'pre-wrap' }}>{ESSAY_TEXT}</div>
      </div>
      <Grip tk={tk} bottom={INPUT_BOTTOM} />
      <span style={{ ...at(X0, 510.9), width: 836 - X0, textAlign: 'right', fontSize: 11, lineHeight: '13px', color: mix(tk.mutedFg, 50), whiteSpace: 'nowrap' }}>
        {`${st.han}: ${n.han} · ${st.en}: ${n.en} · ${st.para}: ${n.para} · ${st.punct}: ${n.punct} · ${n.chars} / 50,000 ${st.chars}`}
      </span>
      <Trash size={14} color={mix(tk.mutedFg, 50)} style={{ ...at(846.5, 510.6) }} />
    </>
  );
};

const ModelRow = ({ tk, s }: { tk: Tokens; s: EssayState }) => {
  const hover = s.hover === 'grade';
  return (
    <>
      <span style={{ ...at(X0, 535.1), width: FULL_W, height: 1, background: LINE }} />
      <Btn style={{ ...at(16, 547.5), width: 134.9, height: 26.3, borderRadius: 9, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
        <Robot size={14} />
        {MODEL_NAME}
        <CaretDown size={14} />
      </Btn>
      <Btn
        style={{
          ...at(786, 544.9),
          width: 78,
          height: 31.5,
          borderRadius: 9,
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 500,
          color: s.pasted ? tk.foreground : tk.mutedFg,
          opacity: s.pasted ? 1 : 0.5,
          background: hover ? HOVER_BG : 'transparent',
          transform: `scale(${1 - 0.03 * (hover ? s.press : 0)})`,
        }}
      >
        {S.essay.grade}
      </Btn>
      <span style={{ ...at(X0, 585.1), width: FULL_W, height: 1, background: 'rgba(224,224,224,0.4)' }} />
      <Pen size={13} color={mix(tk.mutedFg, 60)} style={{ ...at(16, 596) }} />
      <span style={{ ...at(36, 594.9), fontSize: 11, lineHeight: '15.4px', color: mix(tk.mutedFg, 60) }}>{S.essay.result}</span>
      <span style={{ ...at(821, 594.9), fontSize: 11, lineHeight: '15.4px', color: mix(tk.mutedFg, 40) }}>{S.essay.waitTitle}</span>
    </>
  );
};

const DraftPane = ({ tk, s }: { tk: Tokens; s: EssayState }) => (
  <>
    <TopRows tk={tk} />
    <InputArea tk={tk} s={s} />
    <ModelRow tk={tk} s={s} />
  </>
);

// ── 批改开始后：原文收成一行摘要，结果标题并入分段 Tab 行 ──────────
const SummaryLine = ({ tk, s }: { tk: Tokens; s: EssayState }) => {
  const grading = s.stage === 'grading';
  const btn = (x: number, w: number, icon: ReactNode, label: string, labelX: number, color: string) => (
    <>
      <span style={{ ...at(x, 45.9), width: w, height: 26.3, borderRadius: 9 }} />
      {icon}
      <span style={{ ...at(labelX, 53.5), fontSize: 11, fontWeight: 500, lineHeight: '11px', color }}>{label}</span>
    </>
  );
  return (
    <>
      <GraduationCap size={14} color={tk.mutedFg} style={{ ...at(16, 52) }} />
      <span style={{ ...at(35.3, 50.6), fontSize: 12, lineHeight: '16.8px', color: mix(tk.foreground, 80) }}>{MODE_NAME}</span>
      <Robot size={13} color={tk.mutedFg} style={{ ...at(105.8, 52.5) }} />
      <span style={{ ...at(124, 51.3), fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg }}>{MODEL_LABEL}</span>
      <span style={{ ...at(205.3, 51.3), fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg }}>{S.essay.words(INPUT_STATS.en)}</span>
      {grading ? (
        <>
          {btn(705.8, 88, <Eye key="i" size={14} color={mix(tk.mutedFg, 70)} style={{ ...at(717.3, 52) }} />, S.essay.viewOriginal, 738.3, mix(tk.mutedFg, 70))}
          {btn(799, 66, <Spin key="i" size={14} color={tk.mutedFg} clock={s.clock} style={{ ...at(810.5, 52) }} />, S.essay.cancel, 831.5, tk.mutedFg)}
        </>
      ) : (
        <>
          {btn(683.8, 88, <PencilSimple key="i" size={14} color={mix(tk.mutedFg, 70)} style={{ ...at(695.3, 52) }} />, S.essay.editOriginal, 716.3, mix(tk.mutedFg, 70))}
          {btn(777, 88, <ArrowClockwise key="i" size={14} color={mix(tk.mutedFg, 70)} style={{ ...at(788.5, 52) }} />, S.essay.regrade, 809.5, mix(tk.mutedFg, 70))}
        </>
      )}
      <span style={{ ...at(X0, 79), width: FULL_W, height: 1, background: LINE }} />
    </>
  );
};

type Counts = { all: number; errors: number; suggestions: number; highlights: number };
const countsAt = (pos: number): Counts => {
  const done = MARKS.filter((m) => pos >= m.end);
  const errors = done.filter((m) => m.kind === 'err').length;
  const suggestions = done.filter((m) => m.kind === 'replace' || m.kind === 'note').length;
  const highlights = done.filter((m) => m.kind === 'good').length;
  return { all: errors + suggestions + highlights, errors, suggestions, highlights };
};

const TAB_Y = 87;
const VIEW_TOP = 155;

/** 分段 Tab + 右侧状态：流式中「◌ 批注中 / 润色中 · 已生成 N 字 · 第 1 轮」+ 复制 / 导出；完成后「6.5/9」总分徽标 · 第 1 轮 + 复制 / 存笔记 / 导出。 */
const TabsRow = ({ tk, s }: { tk: Tokens; s: EssayState }) => {
  const grading = s.stage === 'grading';
  const hasContent = s.stage === 'done' || s.stream > 0;
  const polishShown = s.stage === 'done' || s.stream > POLISH_AT;
  const polishGenerating = grading && s.stream > POLISH_AT && s.stream < POLISH_END;
  const tabs: Array<{ id: string; x: number; w: number; label: string; Icon: typeof FileText }> = [
    { id: 'overview', x: 16, w: 84.3, label: S.essay.tab.overview, Icon: FileText },
    { id: 'details', x: 103.8, w: 84.3, label: S.essay.tab.details, Icon: ListChecks },
    ...(polishShown ? [{ id: 'polish', x: 191.5, w: polishGenerating ? 99.5 : 84.3, label: S.essay.tab.polish, Icon: Sparkle }] : []),
  ];
  const phase = phaseOf(s.stream);
  const chars = Math.floor(s.stream);
  const icon = (x: number, I: typeof Copy) => <I key={x} size={14} color={mix(tk.mutedFg, 50)} style={{ ...at(x + 5.3, 93) }} />;
  return (
    <>
      {hasContent
        ? tabs.map(({ id, x, w, label, Icon }) => {
            const active = s.tab === id;
            const hovered = !active && id === 'polish' && s.hover === 'polish';
            return (
              <Btn
                key={id}
                style={{
                  ...at(x, TAB_Y),
                  width: w,
                  height: 25.9,
                  borderRadius: 5,
                  padding: '0 0 0 10.5px',
                  gap: 5.25,
                  fontSize: 11,
                  fontWeight: active ? 500 : 400,
                  color: active ? tk.primary : hovered ? tk.foreground : mix(tk.mutedFg, 60),
                  background: active ? mix(tk.primary, 10) : hovered ? HOVER_BG : 'transparent',
                  transform: `scale(${1 - 0.03 * (hovered ? s.press : 0)})`,
                }}
              >
                <Icon size={14} />
                {label}
                {id === 'polish' && polishGenerating ? <Spin size={10} color={mix(tk.mutedFg, 50)} clock={s.clock} style={{ marginLeft: 1 }} /> : null}
              </Btn>
            );
          })
        : null}
      {grading ? (
        <span style={{ position: 'absolute', right: 1078 - 805.5, top: 92.3 - 39, display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, lineHeight: '15.4px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          <Spin size={12} color={mix(tk.primary, 70)} clock={s.clock} />
          <span style={{ color: mix(tk.primary, 70) }}>{S.essay.phase[phase]}</span>
          {chars > 0 ? <span style={{ color: mix(tk.mutedFg, 50) }}>· {S.essay.generated(chars)}</span> : null}
          <span style={{ marginLeft: 3, color: mix(tk.mutedFg, 60) }}>{S.essay.round(1)}</span>
        </span>
      ) : (
        <>
          <span style={{ ...at(676.7, 86.9), width: 58.5, height: 26.3, borderRadius: 9 }} />
          <span style={{ ...at(690, 93.5), fontSize: 11, fontWeight: 500, lineHeight: '13px', color: tk.mutedFg, fontVariantNumeric: 'tabular-nums' }}>{TOTAL}</span>
          <span style={{ ...at(713, 94.5), fontSize: 11, fontWeight: 500, lineHeight: '11px', color: mix(tk.mutedFg, 60) }}>/{MAX}</span>
          <span style={{ ...at(742.2, 92.3), fontSize: 11, lineHeight: '15.4px', color: mix(tk.mutedFg, 60) }}>{S.essay.round(1)}</span>
        </>
      )}
      {grading && chars > 0 ? [icon(812.5, Copy), icon(840.5, Download)] : null}
      {s.stage === 'done' ? [icon(784.5, Copy), icon(812.5, Notebook), icon(840.5, Download)] : null}
      <span style={{ ...at(X0, 116.4), width: FULL_W, height: 1, background: LINE_SOFT }} />
    </>
  );
};

const ChipsRow = ({ tk, counts }: { tk: Tokens; counts: Counts }) => {
  const chips: Array<[keyof Counts, number, number]> = [
    ['all', 16, 50.2],
    ['errors', 69.7, 50],
    ['suggestions', 123.2, 50],
    ['highlights', 176.7, 50],
  ];
  return (
    <>
      {chips.map(([id, x, w]) => {
        const active = id === 'all';
        return (
          <Btn
            key={id}
            style={{
              ...at(x, 126.3),
              width: w,
              height: 22.4,
              borderRadius: 999,
              padding: '0 0 0 8.75px',
              fontSize: 11,
              fontWeight: active ? 500 : 400,
              color: active ? tk.primary : mix(tk.mutedFg, 60),
              background: active ? mix(tk.primary, 10) : 'transparent',
              opacity: !active && counts[id] === 0 ? 0.4 : 1,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {S.essay.filter[id]}
            <span style={{ marginLeft: 3.5, color: active ? mix(tk.primary, 70) : mix(tk.mutedFg, 40) }}>{counts[id]}</span>
          </Btn>
        );
      })}
      <span style={{ ...at(805.5, 129.8), fontSize: 11, lineHeight: '15.4px', color: mix(tk.mutedFg, 60) }}>{S.essay.expand}</span>
      <CaretDown size={12} color={mix(tk.mutedFg, 60)} style={{ ...at(853, 131.4) }} />
      <span style={{ ...at(X0, VIEW_TOP - 1), width: FULL_W, height: 1, background: LINE_SOFT }} />
    </>
  );
};

// ── 批注正文 ──────────────────────────────────────────
const markStyle = (kind: 'good' | 'err' | 'note'): CSSProperties =>
  kind === 'good'
    ? { color: EMERALD, background: 'rgba(209,250,229,0.5)', borderLeft: '2px solid rgba(52,211,153,0.8)', borderRadius: '0 3px 3px 0', padding: '0 1.75px 0 3.5px' }
    : kind === 'err'
      ? { color: 'rgba(220,38,38,0.9)', textDecoration: 'underline wavy', textDecorationColor: 'rgba(248,113,113,0.6)', textUnderlineOffset: 4 }
      : { color: AMBER, borderBottom: '1px dashed rgba(251,191,36,0.7)' };

/**
 * StreamingAnnotatedText：15px / 1.8 行高 / foreground 85%，段间 space-y-3。
 * 流式中普通文字逐字出现；批注标签没闭合前，已到的内文是 pending（muted 60% + animate-pulse），闭合后换成批注样式并淡入 200ms；
 * 评分段（<score> 在最末尾）流式中不进正文，正文下方出「◌ 评分生成中...」占位，光标随之隐藏。
 */
const EssayBody = ({ tk, s, streaming }: { tk: Tokens; s: EssayState; streaming: boolean }) => {
  const pos = streaming ? s.stream : Infinity;
  const pulse = pulseOf(s.clock);
  const pendingStyle: CSSProperties = { color: mix(tk.mutedFg, 60), opacity: pulse };
  const fade = (end: number) => (streaming ? ease.wbOut(clamp((pos - end) / (s.rate * 0.1))) : 1);
  const scorePending = streaming && pos > SCORE_AT;
  const paras: ReactNode[][] = [];
  for (const para of PARAS) {
    if (para[0].start >= pos) break;
    paras.push(
      para.map((seg, i) => {
        if (seg.kind === 'text') {
          const n = Math.min(seg.text.length, Math.floor(pos - seg.start));
          return n > 0 ? <span key={i}>{seg.text.slice(0, n)}</span> : null;
        }
        if (pos < seg.end) {
          if (seg.kind === 'replace' || pos <= seg.inner) return null;
          return (
            <span key={i} style={pendingStyle}>
              {seg.text.slice(0, Math.floor(pos - seg.inner))}
            </span>
          );
        }
        const k = fade(seg.end);
        if (seg.kind === 'replace') {
          return (
            <span key={i} style={{ display: 'inline-flex', alignItems: 'baseline', gap: 3.5, padding: '0 1.75px', opacity: k }}>
              <span style={{ color: mix(tk.mutedFg, 70), textDecoration: 'line-through' }}>{seg.old}</span>
              <span style={{ color: mix(tk.mutedFg, 50), fontSize: 11 }}>→</span>
              <span style={{ color: AMBER, fontWeight: 500 }}>{seg.neu}</span>
            </span>
          );
        }
        return (
          <span key={i} style={{ ...markStyle(seg.kind), opacity: k }}>
            {seg.text}
          </span>
        );
      }),
    );
  }
  if (streaming && !scorePending && paras.length > 0) {
    paras[paras.length - 1].push(
      <span key="cursor" style={{ display: 'inline-block', width: 1.75, height: 16.5, marginLeft: 1.75, verticalAlign: 'middle', background: mix(tk.foreground, 40), opacity: pulse }} />,
    );
  }
  return (
    <div style={{ fontSize: 15, lineHeight: '27px', color: mix(tk.foreground, 85) }}>
      {paras.map((items, i) => (
        <div key={i} style={{ whiteSpace: 'pre-wrap', marginTop: i ? 10.5 : 0 }}>
          {items}
        </div>
      ))}
      {scorePending ? (
        <div style={{ marginTop: 21, height: 45.5, boxSizing: 'border-box', borderRadius: 7, border: '1px solid rgba(224,224,224,0.3)', background: 'rgba(240,240,240,0.1)', display: 'flex', alignItems: 'center', gap: 7, padding: '0 14px', fontSize: 14, lineHeight: '20px', color: tk.mutedFg }}>
          <Spin size={14} color={tk.mutedFg} clock={s.clock} />
          {S.essay.scoreGenerating}
        </div>
      ) : null}
    </div>
  );
};

// ── 分数卡（ScoreCard：圆环 / 分数滚动 / 进度条 / 雷达，挂载即播 700ms / 500ms 入场）────
/** 内容区坐标：取证 ezc（滚动到顶，视口顶 155）里的窗口 y 直接换算。 */
const sc = (x: number, y: number): CSSProperties => ({ position: 'absolute', left: x - X0, top: y - VIEW_TOP });
const gradeColor = (tk: Tokens, ratio: number) => (ratio >= 0.9 ? tk.success : ratio >= 0.75 ? tk.primary : ratio >= 0.6 ? tk.warning : tk.destructive);
const cssEaseOut = (x: number) => 1 - Math.pow(1 - clamp(x), 2.2);
const RADAR_LABELS: Record<string, string[]> = {
  'Task Response': ['Task', 'Response'],
  'Coherence & Cohesion': ['Coherence &', 'Cohesion'],
  'Lexical Resource': ['Lexical', 'Resource'],
  'Grammatical Range & Accuracy': ['Grammatical', 'Range &', 'Accuracy'],
};

const Radar = ({ tk, k }: { tk: Tokens; k: number }) => {
  const cx = 150;
  const cy = 110;
  const r = 70;
  const ang = (i: number) => ((-90 + (360 / DIMS.length) * i) * Math.PI) / 180;
  const pt = (i: number, rr: number) => [cx + rr * Math.cos(ang(i)), cy + rr * Math.sin(ang(i))] as const;
  const poly = (rr: (i: number) => number) => DIMS.map((_, i) => pt(i, rr(i)).join(',')).join(' ');
  const vals = DIMS.map((d) => d.score / d.max);
  return (
    <svg width={300} height={220} viewBox="0 0 300 220" style={{ ...sc(COL + (COL_W - 300) / 2, 314.4), overflow: 'visible' }}>
      {[0.25, 0.5, 0.75, 1].map((lv) => (
        <polygon key={lv} points={poly(() => r * lv)} fill="none" stroke={lv === 1 ? 'rgba(224,224,224,0.6)' : LINE} strokeWidth={1} />
      ))}
      {DIMS.map((_, i) => {
        const [x, y] = pt(i, r);
        return <line key={i} x1={cx} y1={cy} x2={x} y2={y} stroke={LINE} strokeWidth={1} />;
      })}
      <g style={{ transformOrigin: `${cx}px ${cy}px`, transform: `scale(${0.6 + 0.4 * k})`, opacity: k }}>
        <polygon points={poly((i) => r * vals[i])} fill={mix(tk.primary, 15)} stroke={tk.primary} strokeWidth={1.5} strokeLinejoin="round" />
        {vals.map((v, i) => {
          const [x, y] = pt(i, r * v);
          return <circle key={i} cx={x} cy={y} r={2.5} fill={tk.primary} />;
        })}
      </g>
      {DIMS.map((d, i) => {
        const [x, y] = pt(i, 82);
        const cos = Math.cos(ang(i));
        const lines = RADAR_LABELS[d.name] ?? [d.name];
        return (
          <text key={d.name} x={x} y={y} textAnchor={Math.abs(cos) < 0.3 ? 'middle' : cos > 0 ? 'start' : 'end'} dominantBaseline="middle" fill={tk.mutedFg} style={{ fontSize: 10, fontFamily: font.sys }}>
            {lines.map((line, li) => (
              <tspan key={li} x={x} dy={li === 0 ? `${-((lines.length - 1) * 1.15) / 2}em` : '1.15em'}>
                {line}
              </tspan>
            ))}
          </text>
        );
      })}
    </svg>
  );
};

const ScoreCard = ({ tk, since }: { tk: Tokens; since: number }) => {
  const ratio = TOTAL / MAX;
  const color = gradeColor(tk, ratio);
  const k = cssEaseOut(since / 0.35);
  const count = (TOTAL * (1 - Math.pow(1 - clamp(since / 0.35), 3))).toFixed(1);
  const R = 24.5;
  const C = 2 * Math.PI * R;
  const right = COL + COL_W;
  return (
    <>
      <svg width={56} height={56} viewBox="0 0 56 56" style={{ ...sc(COL, 172.4), transform: 'rotate(-90deg)' }}>
        <circle cx={28} cy={28} r={R} fill="none" stroke={mix(tk.muted, 20)} strokeWidth={3.5} />
        <circle cx={28} cy={28} r={R} fill="none" stroke={color} strokeWidth={3.5} strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - ratio * k)} />
      </svg>
      <span style={{ ...sc(COL, 187.8), width: 56, textAlign: 'center', fontSize: 18, fontWeight: 600, lineHeight: '25.2px', color, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      <span style={{ ...sc(COL + 70, 174.3), fontSize: 12, lineHeight: '16.8px', color: tk.mutedFg }}>{S.essay.total}</span>
      <span style={{ ...sc(COL + 70, 192.9), fontSize: 24, fontWeight: 600, lineHeight: '33.6px', color, fontVariantNumeric: 'tabular-nums' }}>{count}</span>
      <span style={{ ...sc(COL + 108.5, 202.9), fontSize: 14, lineHeight: '19.6px', color: mix(tk.mutedFg, 60) }}>/{MAX}</span>
      <Btn style={{ ...sc(right - 45, 172.4), width: 45, height: 27.3, borderRadius: 5, justifyContent: 'center', fontSize: 12, fontWeight: 500, color, background: mix(color, 10) }}>{S.essay.pass}</Btn>
      <span style={{ ...sc(COL, 245.9), width: COL_W, height: 3.5, borderRadius: 999, background: 'rgba(240,240,240,0.3)', overflow: 'hidden' }}>
        <span style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: COL_W * ratio * k, borderRadius: 999, background: color }} />
      </span>
      <span style={{ ...sc(COL, 275.9), fontSize: 11, fontWeight: 500, lineHeight: '15.4px', color: mix(tk.mutedFg, 70) }}>{S.essay.dims}</span>
      <span style={{ ...sc(right - 63.3, 266.9), width: 63.3, height: 33.5, boxSizing: 'border-box', borderRadius: 5, border: '1px solid rgba(224,224,224,0.4)' }} />
      <ChartBar size={13} color={mix(tk.mutedFg, 50)} style={{ ...sc(right - 53, 277.1) }} />
      <span style={{ ...sc(right - 30.7, 269.6), width: 28, height: 28, borderRadius: 9, background: mix(tk.primary, 10) }} />
      <ChartPolar size={13} color={tk.primary} style={{ ...sc(right - 23.2, 277.1) }} />
      <Radar tk={tk} k={cssEaseOut(since / 0.25)} />
      <div style={{ ...sc(COL, 544.45), width: COL_W, fontSize: 11, lineHeight: '17.9px' }}>
        {DIMS.map((d, i) => (
          <div key={d.name} style={{ marginTop: i ? 5.25 : 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            <span style={{ color: mix(tk.foreground, 80) }}>{d.name}</span>
            <span style={{ marginLeft: 5.25, fontVariantNumeric: 'tabular-nums' }}>
              <span style={{ fontWeight: 500, color: gradeColor(tk, d.score / d.max) }}>{d.score}</span>
              <span style={{ color: mix(tk.mutedFg, 50) }}>/{d.max}</span>
            </span>
            <span style={{ marginLeft: 7, color: mix(tk.mutedFg, 60) }}>{d.comment}</span>
          </div>
        ))}
      </div>
    </>
  );
};

// ── 润色提升（PolishSectionView：词级 diff，删除红色删除线、新增绿色下划线）──────
type Op = [0 | 1, string];
const POLISH_CARD: { original: Op[]; polished: Op[] } = {
  original: [
    [0, 'Many families cannot afford high tuition fees, '],
    [1, 'and'],
    [0, ' a '],
    [1, 'lot'],
    [0, ' of capable young people '],
    [1, 'give'],
    [0, ' '],
    [1, 'up'],
    [0, ' their studies'],
    [1, ' for this reason'],
    [0, '.'],
  ],
  polished: [
    [0, 'Many families cannot afford high tuition fees, '],
    [1, 'which'],
    [0, ' '],
    [1, 'forces'],
    [0, ' a '],
    [1, 'considerable'],
    [0, ' '],
    [1, 'number'],
    [0, ' of capable young people '],
    [1, 'to'],
    [0, ' '],
    [1, 'abandon'],
    [0, ' their studies.'],
  ],
};
const DEL: CSSProperties = { color: 'rgba(239,68,68,0.9)', textDecoration: 'line-through', textDecorationColor: 'rgba(248,113,113,0.6)', background: 'rgba(239,68,68,0.05)', borderRadius: 1.75 };
const INS: CSSProperties = { color: EMERALD_600, textDecoration: 'underline', textDecorationColor: 'rgba(52,211,153,0.6)', textUnderlineOffset: 1.75, background: 'rgba(16,185,129,0.05)', borderRadius: 1.75 };

/** 第一张润色卡（原句一行 / 润色后一行，728 宽卡片 152.1 高，取证 probe-eyp）。 */
const PolishPane = ({ tk }: { tk: Tokens }) => (
  <>
    {/* ca22ff014：标签页名「润色提升」已说明用途，首行说明 + 装饰图标去掉 */}
    <Btn style={{ ...at(693, 138.6), width: 108, height: 26.3, borderRadius: 9, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.primary }}>
      <Eye size={12} />
      {S.essay.hideDiff}
    </Btn>
    <div style={{ ...at(COL, 178.8), width: COL_W, height: 152.1, boxSizing: 'border-box', borderRadius: 10.5, border: '1px solid rgba(224,224,224,0.4)', background: 'rgba(252,252,252,0.5)', overflow: 'hidden' }}>
      <span style={{ position: 'absolute', left: 14, top: 10.5, fontSize: 11, lineHeight: '15.4px', color: mix(tk.mutedFg, 50) }}>{S.essay.original}</span>
      <div style={{ position: 'absolute', left: 14, top: 29.15, width: COL_W - 30, fontSize: 12, lineHeight: '19.5px', color: mix(tk.foreground, 70), whiteSpace: 'pre-wrap' }}>
        {POLISH_CARD.original.map(([d, text], i) => (
          <span key={i} style={d ? DEL : undefined}>
            {text}
          </span>
        ))}
      </div>
      <div style={{ position: 'absolute', left: 0, top: 61, width: COL_W - 2, height: 89.1, borderTop: `1px solid ${LINE_SOFT}`, background: 'rgba(236,253,245,0.3)' }}>
        <ArrowRight size={12} color={EMERALD_600} style={{ position: 'absolute', left: 14, top: 17.6 }} />
        <span style={{ position: 'absolute', left: 31.3, top: 16, fontSize: 11, lineHeight: '15.4px', color: EMERALD_600 }}>{S.essay.polished}</span>
        <Btn style={{ position: 'absolute', left: COL_W - 80, top: 10.5, width: 64, height: 26.3, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: mix(tk.mutedFg, 50) }}>
          <Copy size={12} />
          {S.essay.copy}
        </Btn>
        <div style={{ position: 'absolute', left: 14, top: 40.05, width: COL_W - 30, fontSize: 12, fontWeight: 500, lineHeight: '19.5px', color: mix(tk.foreground, 85), whiteSpace: 'pre-wrap' }}>
          {POLISH_CARD.polished.map(([d, text], i) => (
            <span key={i} style={d ? INS : undefined}>
              {text}
            </span>
          ))}
        </div>
      </div>
    </div>
  </>
);

// ── 结果区组装 ────────────────────────────────────────
/** 完成态内容总高（取证 ezc：滚动条 199.5 / 轨道 420.9 → 约 888）。 */
const DONE_CONTENT_H = 888;
const DONE_BODY_TOP = 670.5;
const THUMB_MIN = 40;

const Thumb = ({ tk, y, h, k }: { tk: Tokens; y: number; h: number; k: number }) =>
  k > 0 ? <span style={{ ...at(872, y), width: 4, height: h, borderRadius: 999, background: mix(tk.foreground, 26), opacity: k }} /> : null;

const ResultPane = ({ tk, s }: { tk: Tokens; s: EssayState }) => {
  const grading = s.stage === 'grading';
  const done = s.stage === 'done';
  const barTop = done ? 577.8 : 557.1;
  const hasContent = done || s.stream > 0;
  const overview = s.tab === 'overview';
  const counts = countsAt(done ? Infinity : s.stream);
  const chips = overview && (done || s.stream > FIRST_MARK);
  const viewTop = chips ? VIEW_TOP : 116.4;
  const viewH = barTop - viewTop;
  return (
    <>
      <SummaryLine tk={tk} s={s} />
      <TabsRow tk={tk} s={s} />
      {chips ? <ChipsRow tk={tk} counts={counts} /> : null}
      {grading && !hasContent ? (
        <Btn style={{ ...at(X0, (116.4 + barTop) / 2 - 9), width: FULL_W, justifyContent: 'center', gap: 7, fontSize: 12, color: mix(tk.mutedFg, 40) }}>
          <Spin size={14} color={mix(tk.mutedFg, 40)} clock={s.clock} />
          {S.essay.waiting}
        </Btn>
      ) : null}
      {grading && hasContent ? (
        <div style={{ ...at(X0, viewTop), width: FULL_W, height: viewH, overflow: 'hidden' }}>
          {/* stick-to-bottom：内容底（含 pb-20）贴住视口底；内容不足一屏时从顶部排 */}
          <div style={{ position: 'absolute', left: COL - X0, width: COL_W, bottom: 0, minHeight: viewH, boxSizing: 'border-box', padding: '17.5px 0 70px' }}>
            <EssayBody tk={tk} s={s} streaming />
          </div>
        </div>
      ) : null}
      {done && overview ? (
        <div style={{ ...at(X0, viewTop), width: FULL_W, height: viewH, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, top: -s.scroll, width: FULL_W }}>
            <ScoreCard tk={tk} since={s.sinceDone} />
            <div style={{ position: 'absolute', left: COL - X0, top: DONE_BODY_TOP - VIEW_TOP, width: COL_W }}>
              <EssayBody tk={tk} s={s} streaming={false} />
            </div>
          </div>
        </div>
      ) : null}
      {done && overview ? <Thumb tk={tk} y={viewTop + 2 + ((viewH - 4 - 199.5) * s.scroll) / (DONE_CONTENT_H - viewH)} h={199.5} k={s.thumb} /> : null}
      {done && !overview ? (
        <div style={{ position: 'absolute', inset: 0, opacity: ease.wbOut(s.tabEnter) }}>
          <PolishPane tk={tk} />
        </div>
      ) : null}
      <span style={{ ...at(X0, barTop), width: FULL_W, height: 1, background: LINE }} />
      {[
        [649, 121, Notebook, S.essay.mistakes],
        [777, 88, Cards, S.essay.cards],
      ].map(([x, w, I, label]) => {
        const Icon = I as typeof Notebook;
        return (
          <Btn key={x as number} style={{ ...at(x as number, barTop + 8), width: w as number, height: 26.3, borderRadius: 9, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg, opacity: grading ? 0.5 : 1 }}>
            <Icon size={14} />
            {label as string}
          </Btn>
        );
      })}
      {grading ? <span style={{ ...at(16, 596.6), width: 849, textAlign: 'right', fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg }}>{S.essay.afterGrading}</span> : null}
    </>
  );
};

export const EssayView = ({ tk, s }: { tk: Tokens; s: EssayState }) => {
  const home = s.stage === 'home';
  const sidebar = <ResourceSidebar tk={tk} winH={ESSAY_H} icon={PenNib} title={S.essay.title} items={home ? EXISTING : [NEW_NAME, ...EXISTING]} fresh={!home} settings={S.essay.settings} />;
  const k = ease.outCubic(s.lock);
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: font.sys, background: tk.background, overflow: 'hidden' }}>
      {home ? sidebar : null}
      <div style={{ position: 'absolute', inset: 0, opacity: ease.wbOut(s.enter) }}>
        {home ? (
          <ResourceHome tk={tk} icon={PenNib} label={S.essay.newEssay} btn={{ x: 520.5, w: 111 }} hover={s.hover === 'new'} press={s.press} />
        ) : (
          <>
            {k < 1 ? (
              <div style={{ position: 'absolute', inset: 0, opacity: 1 - k }}>
                <DraftPane tk={tk} s={s.stage === 'draft' ? s : { ...s, stage: 'draft' }} />
              </div>
            ) : null}
            {k > 0 ? (
              <div style={{ position: 'absolute', inset: 0, opacity: k }}>
                <ResultPane tk={tk} s={s} />
              </div>
            ) : null}
          </>
        )}
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
export const ESSAY_PT = {
  newEssay: RESOURCE_NEW_PT,
  /** 点进输入框（空态说明下方的空白处），随后 ⌘V */
  input: { x: 600, y: 430 },
  grade: { x: 825, y: 560.6 },
  /** 结果区里停指针的位置：分数卡右侧留白，不挡字 */
  wheel: { x: 640, y: 222 },
  polish: { x: 233.7, y: 100 },
} as const;
/** 流式进度里的关键位置（原始字符数）：各条批注闭合处、润色段开始、评分段开始、全文长度。 */
export const ESSAY_STREAM = { marks: MARKS.map((m) => m.end), polish: POLISH_AT, score: SCORE_AT, total: RESULT.length } as const;
/** 完成后结果区的滚动位置：分数卡插在上方、视口仍停在正文末尾（滚动锚定）→ 自动平滑滚回顶部分数卡。 */
export const ESSAY_SCROLL = { done: DONE_CONTENT_H - (577.8 - VIEW_TOP), top: 0 } as const;
void LINE_X;

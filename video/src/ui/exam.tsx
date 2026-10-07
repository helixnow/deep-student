import DsAnalysisIconMuted from '@app/components/icons/DsAnalysisIconMuted';
import {
  ArrowClockwise,
  ArrowCounterClockwise,
  BookOpen,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChatCircleText,
  Check,
  CheckCircle,
  CircleNotch,
  ClipboardText,
  ClockCounterClockwise,
  CopySimple,
  Crop,
  Download,
  File as FileIcon,
  FilePdf,
  FileText,
  Funnel,
  GearSix,
  GridNine,
  Image as ImageIcon,
  Lightbulb,
  List,
  ListChecks,
  MagnifyingGlass,
  Note,
  PaperPlaneRight,
  Pause,
  Play,
  Plus,
  Robot,
  Rows,
  Scan,
  Sparkle,
  Star,
  Table,
  Tag,
  Target,
  TrendUp,
  X,
} from '@phosphor-icons/react';
import type { CSSProperties, ReactElement, ReactNode } from 'react';
import { clamp, ease } from '../lib/time';
import { S } from '../strings';
import { font, type Tokens } from '../theme';
import { CollapsingSidebar, FULL_W, FULL_X } from './resource';
import { Tex } from './tex';

/**
 * 题目集：ResourceAppWorkspace（左栏题目集列表）+ ExamContentView（工具条 + 视图）。
 * 片中走产品真实路径：选择一个项目 →「新建题目集」→ 启动台 → 拖入试卷（UnifiedDragDropZone 遮罩）
 * → 识别导入第 1 步（文件已选好，不自动开始）→「解析文档」→ 智能解析 → 导入完成 →「查看题目」→ 题库
 * → 点第 7 题卡片 → 做题（顺序 7/18）→ 选 A 提交 → 判错 → 滚到结果面板底部 →「AI 解析」流式输出。
 * 几何取自真机 DOM 取证（video/out/cap/probe-k*.txt，窗口坐标），默认窗口 880×660（apps/content/register.ts defaultFrame）。
 */
export const EXAM_W = 880;
export const EXAM_H = 660;
/** 「选择一个项目」时资源列表可见：主区 x 273–879 */
const HOME_X = 273;
const HOME_W = 606;
/** 新建后资源列表自动收起（880 宽 < 1100）：主区 x 2–879；识别导入那一栏居中 588 宽（probe-kz*） */
const MAIN_X = FULL_X;
const MAIN_W = FULL_W;
const COL_X = 146.5;
const COL_W = 588;

/** 窗口坐标 → 内容区坐标（1px 边框 + 38px 标题栏）。 */
const at = (x: number, y: number): CSSProperties => ({ position: 'absolute', left: x - 1, top: y - 39 });
const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
/** 按钮悬停底（DsButton ghost hover） */
const HOVER_BG = 'hsl(0 0% 91%)';

export const PAPER_NAME = '高数期中模拟卷.pdf';
const PAPER_TITLE = '高数期中模拟卷';
const NEW_NAME = '新题目集';
const EXISTING = ['线性代数期中 2025', '离子方程式专题', '英语完形填空 ×5'];

type QType = 'single_choice' | 'fill_blank' | 'short_answer' | 'calculation';
type Diff = 'easy' | 'medium' | 'hard' | 'very_hard';
/** `lines`：解析卡片题干 line-clamp-2，在 534px 栏宽里折成两行的题 */
type Q = { content: string; type: QType; answer: string; diff: Diff; options?: number; lines?: 2 };
const SC = (content: string, answer: string, diff: Diff = 'medium'): Q => ({ content, type: 'single_choice', answer, diff, options: 4 });
const FB = (content: string, answer: string, diff: Diff = 'medium'): Q => ({ content, type: 'fill_blank', answer, diff });

/** 与真机取证同一套 18 题（wb2.mjs 的 mock，按 Visual-First 管线逐题入库）。 */
const QUESTIONS: Q[] = [
  SC('函数 f(x) = x³ − 3x 的极大值点为（　　）', 'A', 'easy'),
  SC('当 x → 0 时，与 x 等价的无穷小是（　　）', 'B', 'easy'),
  SC('设 y = ln(1 + x²)，则 dy 等于（　　）', 'A', 'easy'),
  SC('曲线 y = eˣ 在点 (0, 1) 处的切线方程为（　　）', 'A', 'easy'),
  SC('下列反常积分收敛的是（　　）', 'B'),
  SC('设 f(x) 在 x₀ 处可导，则极限 lim(h→0) [f(x₀ + 2h) − f(x₀)] / h 等于（　　）', 'B'),
  SC('设 f(x) 在 [a, b] 上连续，在 (a, b) 内可导，且 f(a) = f(b)。下列结论一定成立的是（　　）', 'C'),
  SC('函数 y = x·e⁻ˣ 的单调递增区间是（　　）', 'A'),
  SC('f(x) = x² 在 [0, 2] 上满足拉格朗日中值定理的 ξ =（　　）', 'B'),
  SC('lim(x→0) (eˣ − 1 − x) / x² =（　　）', 'B'),
  FB('∫₀¹ x·eˣ dx = ____', '1'),
  FB('lim(x→∞) (1 + 2/x)ˣ = ____', 'e²', 'easy'),
  FB('曲线 y = x³ − 3x² 的拐点为 ____', '(1, −2)'),
  FB('曲线 y = x² 与 y = x 所围图形的面积为 ____', '1/6'),
  FB('eˣ 的二阶麦克劳林多项式为 ____', '1 + x + x²/2'),
  { content: '证明：当 x > 0 时，ln(1 + x) < x。', type: 'short_answer', answer: '令 f(t) = ln(1 + t)，在 [0, x] 上用拉格朗日中值定理。', diff: 'hard' },
  { content: '求函数 f(x) = x³ − 6x² + 9x + 1 在 [0, 4] 上的最大值与最小值。', type: 'calculation', answer: '最大值 5，最小值 1', diff: 'hard' },
  {
    content: '设 f(x) 在 [0, 1] 上连续，在 (0, 1) 内可导，f(0) = f(1) = 0，f(1/2) = 1。证明：存在 ξ ∈ (0, 1)，使 f′(ξ) = 1。',
    type: 'short_answer',
    answer: '构造 F(x) = f(x) − x，先用零点定理再用罗尔定理。',
    diff: 'very_hard',
    lines: 2,
  },
];
const TYPE_DIST: Array<[QType, number]> = [
  ['single_choice', 10],
  ['fill_blank', 5],
  ['short_answer', 2],
  ['calculation', 1],
];
const Q7 = QUESTIONS[6];
const Q7_OPTIONS: Array<[string, string]> = [
  ['A', '存在 ξ ∈ [a, b]，使 f′(ξ) = 0'],
  ['B', '存在 ξ ∈ (a, b)，使 f(ξ) = 0'],
  ['C', '存在 ξ ∈ (a, b)，使 f′(ξ) = 0'],
  ['D', '对任意 x ∈ (a, b)，都有 f′(x) = 0'],
];

/**
 * AI 解析（qbank_grading ANALYZE_SYSTEM_PROMPT：解题思路 / 知识点 / 易错点 / 学习建议，公式用 $…$）。
 * 提示词里没有作答历史，所以解析只讲这一题，不说「和你之前的错题一样」。
 */
type Seg = string | { tex: string };
const AI_ITEMS: Array<[string, Seg[]]> = [
  [
    '解题思路',
    ['题设给出 ', { tex: 'f(x)' }, ' 在 ', { tex: '[a,b]' }, ' 上连续、在 ', { tex: '(a,b)' }, ' 内可导，且 ', { tex: 'f(a)=f(b)' }, '，正好是罗尔定理的三个条件，所以存在 ', { tex: '\\xi\\in(a,b)' }, '，使 ', { tex: "f'(\\xi)=0" }, '，选 C。'],
  ],
  ['知识点', ['罗尔定理——闭区间上连续、开区间内可导、端点函数值相等，则开区间内至少有一点导数为零。']],
  ['易错点', [{ tex: '\\xi' }, ' 只保证落在开区间 ', { tex: '(a,b)' }, ' 内。A 把区间写成了闭区间 ', { tex: '[a,b]' }, '，端点不在结论里；B 把 ', { tex: "f'(\\xi)" }, ' 换成了 ', { tex: 'f(\\xi)' }, '。']],
  ['学习建议', ['拉格朗日、柯西中值定理里的 ', { tex: '\\xi' }, ' 同样取开区间，三个定理放在一起对比着记。']],
];
const segLen = (s: Seg) => (typeof s === 'string' ? s.length : 3);
const AI_LEN = AI_ITEMS.reduce((n, [label, body]) => n + label.length + 1 + body.reduce((m, s) => m + segLen(s), 0), 0);

/** 产品答错时已自动建复习计划（下次复习日 = 今天）但界面没有任何提示；这句是优化文档建议补上的文案，locale 里还没有。 */
const REVIEW_TOAST = '第 7 题已加入今日复习';

export type ExamStage = 'home' | 'launcher' | 'upload' | 'parsing' | 'summary' | 'grid' | 'practice';
export type ExamTarget = 'new' | 'parse' | 'view' | 'q7' | 'optA' | 'submit' | 'ai';

export type ExamState = {
  stage: ExamStage;
  /** 当前视图入场 0–1（视图切换是 React 状态切换，片中给 100ms 淡入） */
  enter: number;
  /** 资源列表收起进度 0–1（新建后） */
  collapse: number;
  /** 做题计时芯片（mm:ss） */
  timer: string;
  /** 左栏已有「新题目集」；导入完成后改名为试卷名（修正版）0–1 */
  created: boolean;
  renamed: number;
  /** 拖入启动台时的遮罩 0–1 */
  drag: number;
  hover: ExamTarget | null;
  press: number;
  /** 从点「解析文档」到导入完成 0–1 */
  parse: number;
  picked: boolean;
  /** 判题结果出现 0–1 */
  submitted: number;
  /** 做题区滚动 px */
  scroll: number;
  ai: 'idle' | 'thinking' | 'stream' | 'done';
  /** 流式输出进度 0–1 */
  aiK: number;
};

const Btn = ({ style, children }: { style: CSSProperties; children: ReactNode }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box', whiteSpace: 'nowrap', ...style }}>{children}</span>
);

/** DsAnalysisIconMuted 只认 className 定尺寸（24px viewBox），片中按比例缩放。 */
const AnalysisIcon = ({ size, color, opacity = 1 }: { size: number; color: string; opacity?: number }) => (
  <span style={{ display: 'inline-block', width: size, height: size, color, opacity, flex: 'none' }}>
    <span style={{ display: 'block', width: 24, height: 24, transform: `scale(${size / 24})`, transformOrigin: '0 0' }}>
      <DsAnalysisIconMuted />
    </span>
  </span>
);

/** ResourceIcons.tsx 的 ExamIcon（48 viewBox，紫色叠放试卷）；原组件依赖 @/lib/utils，片中转写。 */
const ExamIllustration = ({ size }: { size: number }) => {
  const bg = '#F6F3F9';
  const fg = '#9A6DD7';
  const sheet = 'M8 6C6.89543 6 6 6.89543 6 8V40C6 41.1046 6.89543 42 7 42H31C32.1046 42 33 41.1046 33 40V12L25 6H8Z';
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" fill="none">
      {[
        [16, 0.3, 1],
        [8, 0.5, 1],
        [0, 0.7, 1],
      ].map(([deg, op, sw]) => (
        <g key={deg} style={{ transformOrigin: '8px 44px', transform: `rotate(${deg}deg)` }}>
          <path d={sheet} fill={bg} stroke={fg} strokeWidth={sw} opacity={op} />
        </g>
      ))}
      <g style={{ transformOrigin: '8px 44px', transform: 'rotate(-8deg)' }}>
        <path d={sheet} fill="#FFFFFF" stroke={fg} strokeWidth="1.5" />
        <path d="M25 6V12H33L25 6Z" fill={bg} stroke={fg} strokeWidth="1.5" strokeLinejoin="round" />
        <circle cx="12" cy="20" r="1.5" stroke={fg} strokeWidth="1.2" fill="none" />
        <rect x="16" y="19" width="10" height="2" rx="1" fill={fg} opacity="0.6" />
        <circle cx="12" cy="27" r="1.5" fill={fg} />
        <rect x="16" y="26" width="8" height="2" rx="1" fill={fg} opacity="0.8" />
        <circle cx="12" cy="34" r="1.5" stroke={fg} strokeWidth="1.2" fill="none" />
        <rect x="16" y="33" width="12" height="2" rx="1" fill={fg} opacity="0.6" />
      </g>
    </svg>
  );
};

/** ExamContentView ProgressRing（描边 2.5，底圈 18% 透明度）。 */
const Ring = ({ size, stroke, ratio, color }: { size: number; stroke: number; ratio: number; color: string }) => {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{ color }}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="currentColor" strokeOpacity={0.18} strokeWidth={stroke} />
      {ratio > 0 ? (
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={c * (1 - ratio)}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      ) : null}
    </svg>
  );
};

// ── 左栏 ──────────────────────────────────────────────
const Sidebar = ({ tk, s }: { tk: Tokens; s: ExamState }) => {
  const rows = s.created ? [NEW_NAME, ...EXISTING] : EXISTING;
  return (
    <>
      <span style={{ ...at(11, 46), width: 26, height: 26, boxSizing: 'border-box', borderRadius: 6, background: 'rgba(255,255,255,0.72)', border: '1px solid rgba(224,224,224,0.7)' }} />
      <ClipboardText size={18} color={tk.mutedFg} style={{ ...at(15, 50) }} />
      <span style={{ ...at(44, 50.6), fontSize: 12, fontWeight: 600, lineHeight: '16.8px', color: tk.foreground }}>{S.exam.title}</span>
      <Plus size={14} color={tk.mutedFg} style={{ ...at(245.5, 52) }} />
      <Btn style={{ ...at(9, 79), width: 255, height: 30, borderRadius: 5, background: mix(tk.foreground, 5), border: '1px solid rgba(224,224,224,0.6)', padding: '0 0 0 7px', gap: 7, fontSize: 13, color: mix(tk.mutedFg, 70) }}>
        <MagnifyingGlass size={14} color={tk.mutedFg} />
        {S.exam.search}
      </Btn>
      <Btn style={{ ...at(7, 116), width: 259, height: 32, borderRadius: 14, background: mix(tk.foreground, 10), padding: '0 9.8px', gap: 8.7, fontSize: 14, color: tk.foreground }}>
        <Rows size={14} />
        <span style={{ flex: 1 }}>{S.exam.all}</span>
        <span style={{ fontSize: 12 }}>{rows.length}</span>
      </Btn>
      <Btn style={{ ...at(7, 150), width: 259, height: 32, borderRadius: 14, padding: '0 9.8px', gap: 8.7, fontSize: 14, color: tk.foreground }}>
        <ClockCounterClockwise size={14} />
        {S.exam.recent}
      </Btn>
      <span style={{ ...at(1, 187), width: 271, height: 1, background: mix(tk.border, 70) }} />
      {rows.map((name, i) => {
        const fresh = s.created && i === 0;
        return (
          <Btn key={name} style={{ ...at(1, 188 + 32 * i), width: 271, height: 32, borderRadius: 14, background: fresh ? mix(tk.foreground, 10) : 'transparent', padding: '0 0 0 9.3px', gap: 8.2, fontSize: 14, color: tk.foreground }}>
            <ClipboardText size={15} />
            {fresh && s.renamed > 0 ? (
              <span style={{ position: 'relative' }}>
                <span style={{ opacity: 1 - s.renamed }}>{NEW_NAME}</span>
                <span style={{ position: 'absolute', left: 0, top: 0, opacity: s.renamed }}>{PAPER_TITLE}</span>
              </span>
            ) : (
              name
            )}
          </Btn>
        );
      })}
      <span style={{ ...at(1, 637), width: 271, height: 22, boxSizing: 'border-box', background: 'rgba(240,240,240,0.24)', borderTop: `1px solid ${tk.border}` }} />
      <span style={{ ...at(10, 641.5), fontSize: 10, lineHeight: '14px', color: tk.mutedFg }}>{S.exam.itemCount(rows.length)}</span>
      <ArrowClockwise size={13} color={tk.mutedFg} style={{ ...at(250.5, 642) }} />
      <span style={{ ...at(272, 39), width: 1, height: EXAM_H - 40, background: tk.border }} />
    </>
  );
};

// ── 工具条 ────────────────────────────────────────────
const Toolbar = ({ tk, s }: { tk: Tokens; s: ExamState }) => {
  const hasQuestions = s.stage === 'grid' || s.stage === 'practice';
  const practice = s.stage === 'practice';
  const pill = s.stage === 'launcher' || s.stage === 'grid' ? 16 : practice ? 67 : null;
  const tab = (x: number, label: string, active: boolean, disabled: boolean) => (
    <Btn style={{ ...at(x, practice ? 48.6 : 47.8), width: 47, height: 26.3, justifyContent: 'center', fontSize: 12, fontWeight: 500, color: active ? tk.foreground : tk.mutedFg, opacity: disabled ? 0.45 : 1 }}>{label}</Btn>
  );
  return (
    <>
      {pill !== null ? <span style={{ ...at(pill, practice ? 48.8 : 47.8), width: 47, height: 26, borderRadius: 5, background: tk.accent }} /> : null}
      {tab(16, S.exam.tab.bank, pill === 16, false)}
      {tab(66.5, S.exam.tab.practice, practice, !hasQuestions)}
      {hasQuestions ? (
        <Btn style={{ ...at(117, practice ? 48.6 : 47.8), width: 66, height: 26.3, padding: '0 0 0 12px', gap: 6.5, fontSize: 12, fontWeight: 500, color: tk.mutedFg }}>
          {S.exam.tab.more}
          <CaretDown size={12} />
        </Btn>
      ) : null}
      {practice ? (
        <>
          <span style={{ ...at(193.5, 54.8), width: 1, height: 14, background: 'rgba(224,224,224,0.6)' }} />
          {/* 列表收起后主区够宽：模式下拉与计时芯片都完整露出（probe-kzf） */}
          <Btn style={{ ...at(205, 47.8), width: 200, height: 28, borderRadius: 5, background: 'rgba(240,240,240,0.3)', padding: '0 12.2px 0 12.3px', fontSize: 13, fontWeight: 500, color: tk.mutedFg, justifyContent: 'space-between' }}>
            {S.exam.q.sequential}
            <CaretDown size={16} />
          </Btn>
          <Btn style={{ ...at(408.5, 48.6), width: 76.1, height: 26.3, borderRadius: 9, background: mix(tk.primary, 5), padding: '0 0 0 11px', gap: 7.5, fontSize: 11, fontWeight: 500, color: tk.primary, fontVariantNumeric: 'tabular-nums' }}>
            <Pause size={14} weight="bold" />
            {s.timer}
          </Btn>
        </>
      ) : null}
      {hasQuestions ? (
        <>
          <span style={{ ...at(539, practice ? 52.8 : 51.9), display: 'inline-flex' }}>
            <Ring size={18} stroke={2.5} ratio={0} color={tk.success} />
          </span>
          <span style={{ ...at(562.3, practice ? 56.3 : 55.4), fontSize: 11, fontWeight: 600, lineHeight: '11px', color: tk.foreground }}>0%</span>
          <span style={{ ...at(584.1, practice ? 57.3 : 56.4), fontSize: 10, lineHeight: '10px', color: tk.mutedFg }}>{S.exam.tab.mastery}</span>
          <span style={{ ...at(614.6, practice ? 55.6 : 54.8), width: 1, height: 12.3, background: 'rgba(224,224,224,0.6)' }} />
          <span style={{ ...at(626.1, practice ? 56.3 : 55.4), fontSize: 11, fontWeight: 600, lineHeight: '11px', color: tk.foreground }}>0%</span>
          <span style={{ ...at(648, practice ? 57.3 : 56.4), fontSize: 10, lineHeight: '10px', color: tk.mutedFg }}>{S.exam.tab.correctRate}</span>
          <Btn style={{ ...at(686.8, practice ? 48.6 : 47.8), width: 66, height: 26.3, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
            <Download size={14} />
            {S.exam.tab.export}
          </Btn>
        </>
      ) : null}
      <Btn style={{ ...at(758, practice ? 48.6 : 47.8), width: 107, height: 26.3, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
        <Plus size={14} />
        {S.exam.tab.add}
        <CaretDown size={12} style={{ marginLeft: 0 }} />
      </Btn>
      {!practice ? <span style={{ ...at(MAIN_X, 83.8), width: MAIN_W, height: 1, background: mix(tk.border, 60) }} /> : null}
    </>
  );
};

// ── 视图：选择一个项目 / 启动台 ───────────────────────
const HomePane = ({ tk, s }: { tk: Tokens; s: ExamState }) => (
  <>
    <ClipboardText size={38} color={tk.mutedFg} style={{ ...at(557, 287.4) }} />
    <span style={{ ...at(HOME_X, 333.4), width: HOME_W, textAlign: 'center', fontSize: 13, fontWeight: 500, lineHeight: '18.2px', color: tk.foreground }}>{S.exam.selectTitle}</span>
    <span style={{ ...at(HOME_X, 359.6), width: HOME_W, textAlign: 'center', fontSize: 12, lineHeight: '16.8px', color: tk.mutedFg }}>{S.exam.selectHint}</span>
    <Btn
      style={{
        ...at(526, 384.4),
        width: 100,
        height: 26.3,
        borderRadius: 9,
        padding: '0 0 0 11.5px',
        gap: 6,
        fontSize: 11,
        fontWeight: 500,
        color: s.hover === 'new' ? tk.foreground : tk.mutedFg,
        background: s.hover === 'new' ? HOVER_BG : 'transparent',
        transform: `scale(${1 - 0.03 * (s.hover === 'new' ? s.press : 0)})`,
      }}
    >
      <Plus size={15} />
      {S.exam.newExam}
    </Btn>
  </>
);

const LAUNCHER_ICONS = [<Plus key="p" size={18} />, <Sparkle key="s" size={18} />, <Scan key="c" size={18} />, <Table key="t" size={18} />];

const LauncherPane = ({ tk }: { tk: Tokens }) => (
  <>
    <span style={{ ...at(419.5, 228), width: 42, height: 42, borderRadius: 10.5, background: 'rgba(240,240,240,0.6)', display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <ExamIllustration size={28} />
    </span>
    <span style={{ ...at(MAIN_X, 284), width: MAIN_W, textAlign: 'center', fontSize: 14, fontWeight: 500, lineHeight: '17.5px', color: tk.foreground }}>{S.exam.launcher.empty}</span>
    <span style={{ ...at(MAIN_X, 306.8), width: MAIN_W, textAlign: 'center', fontSize: 12, lineHeight: '16.8px', color: tk.mutedFg }}>{S.exam.launcher.choose}</span>
    {S.exam.launcher.cards.map(([title, desc], i) => {
      const x = COL_X + i * 149.6;
      return (
        <span key={title} style={{ ...at(x, 351.6), width: 139.1, height: 126.8, boxSizing: 'border-box', borderRadius: 10.5, background: 'rgba(252,252,252,0.4)', border: '1px solid rgba(224,224,224,0.6)' }}>
          <span style={{ position: 'absolute', left: 14, top: 14, width: 31.5, height: 31.5, borderRadius: 7, background: tk.muted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.mutedFg }}>{LAUNCHER_ICONS[i]}</span>
          <span style={{ position: 'absolute', left: 14, top: 54.2, fontSize: 12, fontWeight: 500, lineHeight: '12px', color: tk.mutedFg, whiteSpace: 'nowrap' }}>{title}</span>
          <span style={{ position: 'absolute', left: 14, top: 75, width: 109.1, fontSize: 11, fontWeight: 500, lineHeight: '17.9px', color: tk.mutedFg }}>{desc}</span>
        </span>
      );
    })}
    <span style={{ ...at(MAIN_X, 499.3), width: MAIN_W, textAlign: 'center', fontSize: 11, lineHeight: '15.4px', color: mix(tk.mutedFg, 80) }}>{S.exam.launcher.dropHint}</span>
  </>
);

/** UnifiedDragDropZone 遮罩：整块启动台 primary 10% + 4px 模糊，中间虚线框。 */
const DropOverlay = ({ tk, k }: { tk: Tokens; k: number }) => (
  <span
    style={{
      ...at(MAIN_X, 84.8),
      width: MAIN_W,
      height: EXAM_H - 1 - 84.8,
      background: mix(tk.primary, 10),
      backdropFilter: 'blur(4px)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      opacity: k,
    }}
  >
    <span
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 14,
        padding: '21px 28px',
        borderRadius: 7,
        background: tk.background,
        border: `2px dashed ${tk.primary}`,
        boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1), 0 4px 6px -4px rgba(0,0,0,0.1)',
      }}
    >
      <span style={{ fontSize: 16, fontWeight: 500, lineHeight: '22px', color: tk.foreground }}>{S.exam.launcher.overlay}</span>
      <span style={{ fontSize: 12, lineHeight: '16px', color: tk.mutedFg }}>{S.exam.launcher.maxFiles}</span>
    </span>
  </span>
);

// ── 识别导入 ──────────────────────────────────────────
const StepBar = ({ tk, step }: { tk: Tokens; step: 0 | 1 | 2 }) => {
  const xs = [280.6, 405.9, 531.1];
  return (
    <>
      {xs.map((x, i) => {
        const done = i < step;
        const active = i === step;
        return (
          <span key={i}>
            <Btn
              style={{
                ...at(x, 160.8),
                width: 20,
                height: 20,
                borderRadius: 9999,
                justifyContent: 'center',
                fontSize: 11,
                fontWeight: 500,
                color: active ? tk.primaryFg : done ? tk.primary : tk.mutedFg,
                background: active ? tk.primary : done ? mix(tk.primary, 15) : tk.muted,
              }}
            >
              {done ? <Check size={11} weight="bold" /> : i + 1}
            </Btn>
            <span style={{ ...at(x + 25.3, 163.1), fontSize: 11, fontWeight: active ? 500 : 400, lineHeight: '15.4px', color: active ? tk.foreground : tk.mutedFg }}>{S.exam.up.steps[i]}</span>
            {i < 2 ? <span style={{ ...at(x + 76.3, 170.3), width: 42, height: 1, background: done ? mix(tk.primary, 50) : tk.border }} /> : null}
          </span>
        );
      })}
    </>
  );
};

const Header = ({ tk }: { tk: Tokens }) => (
  <>
    <span style={{ ...at(COL_X, 104.8), width: COL_W, textAlign: 'center', fontSize: 16, fontWeight: 600, lineHeight: '20px', color: tk.foreground }}>{S.exam.up.title}</span>
    <span style={{ ...at(COL_X, 130), width: COL_W, textAlign: 'center', fontSize: 12, lineHeight: '16.8px', color: tk.mutedFg }}>{S.exam.up.desc}</span>
  </>
);

const ghostBtn = (tk: Tokens, hovered: boolean, press: number): CSSProperties => ({
  borderRadius: 9,
  justifyContent: 'center',
  gap: 7,
  fontSize: 13,
  fontWeight: 500,
  color: hovered ? tk.foreground : tk.mutedFg,
  background: hovered ? HOVER_BG : 'transparent',
  transform: `scale(${1 - 0.02 * (hovered ? press : 0)})`,
});

const UploadPane = ({ tk, s }: { tk: Tokens; s: ExamState }) => (
  <>
    <Header tk={tk} />
    <StepBar tk={tk} step={0} />
    <span style={{ ...at(COL_X, 201.8), width: COL_W, height: 226.9, boxSizing: 'border-box', borderRadius: 5, background: 'rgba(252,252,252,0.3)', border: '2px dashed rgba(224,224,224,0.6)' }} />
    {[385.8, 453.2].map((x, i) => (
      <span key={x} style={{ ...at(x, 267.3), width: 42, height: 42, borderRadius: 7, background: tk.muted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.mutedFg }}>
        {i === 0 ? <ImageIcon size={22} /> : <FileText size={22} />}
      </span>
    ))}
    <span style={{ ...at(438.3, 277.1), fontSize: 16, fontWeight: 300, lineHeight: '22.4px', color: mix(tk.mutedFg, 30) }}>/</span>
    <span style={{ ...at(COL_X, 323.3), width: COL_W, textAlign: 'center', fontSize: 14, fontWeight: 500, lineHeight: '19.6px', color: tk.foreground }}>{S.exam.up.drop}</span>
    <span style={{ ...at(COL_X, 346.4), width: COL_W, textAlign: 'center', fontSize: 12, lineHeight: '16.8px', color: tk.mutedFg }}>{S.exam.up.formats}</span>
    <span style={{ ...at(COL_X, 442.7), width: COL_W, height: 54.6, borderRadius: 7, background: 'rgba(240,240,240,0.5)' }} />
    <FileIcon size={20} color={tk.mutedFg} style={{ ...at(157, 460) }} />
    <span style={{ ...at(187.5, 453.2), fontSize: 13, fontWeight: 500, lineHeight: '18.2px', color: tk.foreground }}>{PAPER_NAME}</span>
    <span style={{ ...at(187.5, 471.4), fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg }}>2150.4 KB</span>
    <Btn style={{ ...at(652.5, 456.8), width: 71.5, height: 26.3, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
      <X size={16} />
      {S.exam.up.remove}
    </Btn>
    <span style={{ ...at(COL_X, 507.8), width: COL_W, height: 47.3, borderRadius: 7, background: 'rgba(240,240,240,0.3)' }} />
    <Robot size={16} color={tk.mutedFg} style={{ ...at(157, 523.4) }} />
    <span style={{ ...at(180, 523), fontSize: 12, lineHeight: '16.8px', color: tk.mutedFg }}>{S.exam.up.parseModel}</span>
    <Btn style={{ ...at(247, 518.3), width: 110, height: 26.3, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
      {S.exam.up.defaultModel}
      <CaretDown size={14} />
    </Btn>
    <Btn style={{ ...at(COL_X, 576), width: 288.8, height: 28, ...ghostBtn(tk, false, 0) }}>{S.exam.up.back}</Btn>
    <Btn style={{ ...at(445.8, 576), width: 288.8, height: 28, ...ghostBtn(tk, s.hover === 'parse', s.press) }}>
      <FileText size={16} />
      {S.exam.up.parse}
    </Btn>
    <span style={{ ...at(COL_X, 625), width: COL_W, textAlign: 'center', fontSize: 11, fontWeight: 500, lineHeight: '20px', color: tk.mutedFg }}>{S.exam.up.manual}</span>
  </>
);

/** 解析进度 k（0–1）→ 子步骤 / 逐页状态 / 已解析题数 / 进度条 / 文案。阶段按单调推进画（产品的阶段会来回跳，见优化文档）。 */
const P_PREP = 0.12;
const P_OCR = 0.46;
const P_PARSE = 0.56;
const P_PARSED = 0.97;
const PAGE_AT = [0.18, 0.26, 0.34, 0.42];
const PCT_KEYS: Array<[number, number]> = [
  [0, 2],
  [P_PREP, 17],
  [PAGE_AT[0], 25],
  [PAGE_AT[1], 30],
  [PAGE_AT[2], 35],
  [PAGE_AT[3], 40],
  [P_OCR, 40],
  [P_PARSE, 45],
  [1, 45],
];
const parseAt = (k: number) => {
  const pages = PAGE_AT.filter((a) => k >= a).length;
  const parsedF = clamp((k - P_PARSE) / (P_PARSED - P_PARSE)) * QUESTIONS.length;
  const parsed = Math.floor(parsedF + 1e-6);
  let pct = 45;
  for (let i = 1; i < PCT_KEYS.length; i++) {
    const [k0, v0] = PCT_KEYS[i - 1];
    const [k1, v1] = PCT_KEYS[i];
    if (k <= k1) {
      pct = v0 + (v1 - v0) * clamp((k - k0) / Math.max(1e-6, k1 - k0));
      break;
    }
  }
  const up = S.exam.up;
  let phase: 0 | 1 | 2 = 2;
  let msg: string;
  if (k < P_PREP) {
    phase = 0;
    msg = up.rendering(Math.min(4, 1 + Math.floor((k / P_PREP) * 4)), 4);
  } else if (k < P_OCR) {
    phase = 1;
    msg = pages === 0 ? up.parsingStarted(4) : up.ocrPage(pages, 4);
  } else if (k < P_PARSE) {
    msg = k < (P_OCR + P_PARSE) / 2 ? up.ocrDone(4) : up.structuring(0, QUESTIONS.length);
  } else {
    msg = parsed === 0 ? up.structuring(0, QUESTIONS.length) : up.parsedCount(parsed);
  }
  return { phase, pages, parsed, parsedF, pct, msg, pageCard: k >= P_PREP };
};

const PhasePills = ({ tk, phase }: { tk: Tokens; phase: 0 | 1 | 2 }) => (
  <span style={{ ...at(COL_X, 201.8), width: COL_W, height: 16.7, display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 5.25 }}>
    {S.exam.up.phases.map((label, i) => {
      const done = i < phase;
      const active = i === phase;
      return (
        <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 5.25 }}>
          {i > 0 ? <span style={{ width: 21, height: 1, background: i <= phase ? mix(tk.primary, 50) : tk.border }} /> : null}
          <Btn
            style={{
              height: 16.7,
              padding: '0 7px',
              borderRadius: 9999,
              gap: 3.5,
              fontSize: 11,
              fontWeight: active ? 500 : 400,
              lineHeight: '16.7px',
              color: done ? tk.success : active ? tk.primary : mix(tk.mutedFg, 60),
              background: active ? mix(tk.primary, 10) : 'transparent',
            }}
          >
            {done ? <Check size={10} weight="bold" /> : active ? <CircleNotch size={10} /> : null}
            {label}
          </Btn>
        </span>
      );
    })}
  </span>
);

const CARD_H = 58.8;
const STEM_LH = 16.8;
const CARD_GAP = 7;
const LIST_TOP = 379.3;
const LIST_BOTTOM = 645;
const cardH = (q: Q) => CARD_H + ((q.lines ?? 1) - 1) * STEM_LH;
/** 第 i 张解析卡片的顶边（列表内坐标） */
const CARD_TOP = QUESTIONS.reduce<number[]>((acc, q, i) => [...acc, i === 0 ? 0 : acc[i - 1] + cardH(QUESTIONS[i - 1]) + CARD_GAP], []);

const ParsedCard = ({ tk, q, i }: { tk: Tokens; q: Q; i: number }) => (
  <span style={{ display: 'block', position: 'relative', height: cardH(q), boxSizing: 'border-box', borderRadius: 7, background: tk.card, border: '1px solid rgba(224,224,224,0.5)' }}>
    <Btn style={{ position: 'absolute', left: 10.5, top: 10.5, width: 24, height: 24, borderRadius: 9999, justifyContent: 'center', background: mix(tk.primary, 10), color: tk.primary, fontSize: 11, fontWeight: 700 }}>{i + 1}</Btn>
    <span
      style={{
        position: 'absolute',
        left: 41.5,
        right: 10.5,
        top: 10.5,
        fontSize: 12,
        lineHeight: `${STEM_LH}px`,
        color: tk.foreground,
        display: '-webkit-box',
        WebkitBoxOrient: 'vertical',
        WebkitLineClamp: 2,
        overflow: 'hidden',
      }}
    >
      {q.content}
    </span>
    <span style={{ position: 'absolute', left: 41.5, right: 10.5, top: 30.8 + ((q.lines ?? 1) - 1) * STEM_LH, display: 'flex', alignItems: 'center', gap: 7, fontSize: 10, lineHeight: '12px', whiteSpace: 'nowrap', overflow: 'hidden' }}>
      <span style={{ padding: '1.75px 5.25px', borderRadius: 3.5, background: mix(tk.primary, 10), color: tk.primary }}>{S.exam.type[q.type]}</span>
      {q.options ? <span style={{ color: tk.mutedFg }}>{S.exam.up.options(q.options)}</span> : null}
      <span style={{ color: tk.success, overflow: 'hidden', textOverflow: 'ellipsis' }}>{S.exam.up.answer(q.answer)}</span>
    </span>
  </span>
);

const ParsingPane = ({ tk, s }: { tk: Tokens; s: ExamState }) => {
  const p = parseAt(s.parse);
  const listH = LIST_BOTTOM - LIST_TOP;
  const last = Math.max(0, Math.ceil(p.parsedF) - 1);
  const contentH = CARD_TOP[last] + cardH(QUESTIONS[last]) * clamp(p.parsedF - last);
  const scroll = Math.max(0, contentH - listH);
  const waitTop = p.pageCard ? 356.9 : 288.8;
  return (
    <>
      <Header tk={tk} />
      <StepBar tk={tk} step={1} />
      <PhasePills tk={tk} phase={p.phase} />
      <span style={{ ...at(COL_X, 229), width: COL_W, height: 49.3, borderRadius: 7, background: 'rgba(240,240,240,0.3)' }} />
      <CircleNotch size={27.3} color={tk.primary} style={{ ...at(153.3, 240), transform: `rotate(${s.parse * 1100}deg)` }} />
      <span style={{ ...at(187.5, 239.5), width: 409.6, fontSize: 12, fontWeight: 500, lineHeight: '16.8px', color: tk.foreground, whiteSpace: 'nowrap' }}>{p.msg}</span>
      <span style={{ ...at(187.5, 259.8), width: 409.6, height: 8, borderRadius: 9999, background: 'rgba(240,240,240,0.5)', overflow: 'hidden' }}>
        <span style={{ display: 'block', width: `${p.pct}%`, height: '100%', background: tk.primary }} />
      </span>
      <span style={{ ...at(594, 245.2), width: 28, textAlign: 'right', fontSize: 12, fontWeight: 700, lineHeight: '16.8px', color: tk.primary, fontVariantNumeric: 'tabular-nums' }}>{p.parsed}</span>
      <Btn style={{ ...at(632.5, 240.5), width: 91.5, height: 26.3, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
        <X size={14} />
        {S.exam.up.cancel}
      </Btn>
      {p.pageCard ? (
        <>
          <span style={{ ...at(COL_X, 288.8), width: COL_W, height: 57.6, boxSizing: 'border-box', borderRadius: 5, background: 'rgba(252,252,252,0.5)', border: '1px solid rgba(224,224,224,0.4)' }} />
          <span style={{ ...at(158, 296.8), fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg }}>{S.exam.up.pageStatus}</span>
          {[0, 1, 2, 3].map((i) => {
            const done = i < p.pages;
            return (
              <Btn
                key={i}
                style={{
                  ...at(158 + i * 26.25, 317.4),
                  width: 21,
                  height: 21,
                  borderRadius: 3.5,
                  justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: 500,
                  background: done ? mix(tk.success, 15) : tk.muted,
                  color: done ? tk.success : mix(tk.mutedFg, 60),
                }}
              >
                {done ? <Check size={11} /> : i + 1}
              </Btn>
            );
          })}
        </>
      ) : null}
      {p.parsedF <= 0 ? (
        <span style={{ ...at(COL_X, waitTop), width: COL_W, paddingTop: 28, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 7, fontSize: 12, lineHeight: '16.8px', color: tk.mutedFg }}>
          <CircleNotch size={32} style={{ opacity: 0.5, transform: `rotate(${s.parse * 1100}deg)` }} />
          {S.exam.up.waiting}
        </span>
      ) : (
        <>
          <span style={{ ...at(COL_X, 356.9), fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg }}>{S.exam.up.parsedLabel}</span>
          <span style={{ ...at(COL_X, LIST_TOP), width: COL_W, height: listH, overflow: 'hidden' }}>
            <span style={{ position: 'absolute', left: 0, right: 0, top: -scroll }}>
              {QUESTIONS.slice(0, Math.ceil(p.parsedF)).map((q, i) => {
                const k = ease.outCubic(clamp(p.parsedF - i));
                return (
                  <span key={i} style={{ position: 'absolute', left: 0, right: 0, top: CARD_TOP[i], opacity: k, transform: `translateY(${(1 - k) * 8}px)` }}>
                    <ParsedCard tk={tk} q={q} i={i} />
                  </span>
                );
              })}
            </span>
          </span>
        </>
      )}
    </>
  );
};

const SummaryPane = ({ tk, s }: { tk: Tokens; s: ExamState }) => (
  <>
    <Header tk={tk} />
    <StepBar tk={tk} step={2} />
    <span style={{ ...at(424.8, 201.8), width: 31.5, height: 31.5, borderRadius: 5, background: mix(tk.success, 10), display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <CheckCircle size={20} weight="fill" color={tk.success} />
    </span>
    <span style={{ ...at(COL_X, 240.3), width: COL_W, textAlign: 'center', fontSize: 14, fontWeight: 600, lineHeight: '17.5px', color: tk.foreground }}>{S.exam.up.complete}</span>
    {(
      [
        [COL_X, String(QUESTIONS.length), S.exam.up.total, tk.primary],
        [COL_X + 297.5, '4', S.exam.up.pages, tk.foreground],
      ] as Array<[number, string, string, string]>
    ).map(([x, v, label, c]) => (
      <span key={label} style={{ ...at(x, 268.3), width: 290.5, height: 60.2, borderRadius: 5, background: 'rgba(240,240,240,0.5)', textAlign: 'center' }}>
        <span style={{ display: 'block', marginTop: 10.5, fontSize: 16, fontWeight: 600, lineHeight: '22.4px', color: c }}>{v}</span>
        <span style={{ display: 'block', fontSize: 12, lineHeight: '16.8px', color: tk.mutedFg }}>{label}</span>
      </span>
    ))}
    <span style={{ ...at(COL_X, 339), width: COL_W, height: 67.2, borderRadius: 5, background: 'rgba(240,240,240,0.3)' }} />
    <span style={{ ...at(157, 349.5), fontSize: 12, fontWeight: 500, lineHeight: '16.8px', color: tk.foreground }}>{S.exam.up.typeDist}</span>
    <span style={{ ...at(157, 373.3), display: 'flex', gap: 7 }}>
      {TYPE_DIST.map(([type, n]) => (
        <Btn key={type} style={{ height: 22.4, padding: '0 10.5px', borderRadius: 9999, gap: 3, fontSize: 11, background: mix(tk.primary, 10), color: tk.primary }}>
          {S.exam.type[type]} {n}
        </Btn>
      ))}
    </span>
    <span style={{ ...at(COL_X, 416.7), width: COL_W, height: 65.7, boxSizing: 'border-box', borderRadius: 5, border: '1px solid rgba(224,224,224,0.5)', overflow: 'hidden' }}>
      <span style={{ position: 'absolute', left: 0, top: 0, right: 0, height: 34.3, background: 'rgba(240,240,240,0.3)' }} />
      <Funnel size={16} color={tk.mutedFg} style={{ position: 'absolute', left: 14, top: 9.1 }} />
      <span style={{ position: 'absolute', left: 37, top: 8.7, fontSize: 12, fontWeight: 500, lineHeight: '16.8px', color: tk.foreground }}>{S.exam.up.filter}</span>
      <span style={{ position: 'absolute', right: 13, top: 9.4, fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg }}>▼</span>
      <span style={{ position: 'absolute', left: 14, top: 39.6, fontSize: 11, lineHeight: '15.4px', color: tk.mutedFg }}>{S.exam.up.filterHint}</span>
    </span>
    <Btn style={{ ...at(COL_X, 499.9), width: 288.8, height: 28, ...ghostBtn(tk, false, 0) }}>{S.exam.up.again}</Btn>
    <Btn style={{ ...at(445.8, 499.9), width: 288.8, height: 28, ...ghostBtn(tk, s.hover === 'view', s.press) }}>{S.exam.up.view}</Btn>
  </>
);

// ── 题库 ──────────────────────────────────────────────
/** 全宽后网格 3 列（278.3 宽）；同一行任一题干折成两行时整行 122.9，否则 103.4（probe-kze；第 5、6 行在视口下方） */
const GRID_ROW_H = [103.4, 122.9, 122.9, 103.4, 122.9, 122.9];
const GRID_COLS = 3;
const GRID_CARD_W = 278.3;
const GRID_PITCH = 285.35;
const GRID_ROW_Y = GRID_ROW_H.reduce<number[]>((acc, h, i) => [...acc, i === 0 ? 234.3 : acc[i - 1] + GRID_ROW_H[i - 1] + 6.9], []);
const diffColor = (tk: Tokens, d: Diff) => (d === 'easy' ? tk.success : d === 'very_hard' ? tk.mutedFg : tk.warning);

const GridPane = ({ tk, s }: { tk: Tokens; s: ExamState }) => {
  const b = S.exam.bank;
  const filters: Array<[string, number, string]> = [
    [`${b.all} ${QUESTIONS.length}`, 53.7, tk.mutedFg],
    [`${b.newQ} ${QUESTIONS.length}`, 53.7, tk.mutedFg],
  ];
  return (
    <>
      <span style={{ ...at(19.5, 97.8), display: 'inline-flex' }}>
        <Ring size={35} stroke={3 * (35 / 40)} ratio={0} color={tk.success} />
      </span>
      <span style={{ ...at(19.5, 109.3), width: 35, textAlign: 'center', fontSize: 10, fontWeight: 600, lineHeight: '12px', color: tk.foreground }}>0%</span>
      <span style={{ ...at(61.5, 106.8), fontSize: 12, lineHeight: '15px', color: tk.mutedFg, whiteSpace: 'nowrap' }}>
        {b.mastery} <span style={{ fontWeight: 500, color: tk.foreground }}>0</span>/{QUESTIONS.length}
      </span>
      <span style={{ ...at(139.8, 109.1), width: 1, height: 12.3, background: 'rgba(224,224,224,0.6)' }} />
      <span style={{ ...at(161.8, 106.8), fontSize: 12, lineHeight: '15px', color: tk.mutedFg, whiteSpace: 'nowrap' }}>
        {S.exam.q.rate} <span style={{ fontWeight: 500, color: tk.foreground }}>0%</span>
      </span>
      <Btn style={{ ...at(773.5, 102.1), width: 88, height: 26.3, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.primary }}>
        <Play size={14} />
        {b.start}
      </Btn>
      <span style={{ ...at(MAIN_X, 146), width: MAIN_W, height: 1, background: mix(tk.border, 40) }} />
      <Btn style={{ ...at(16, 158.3), width: 657, height: 31.5, borderRadius: 12, background: 'rgba(240,240,240,0.3)', padding: '0 0 0 10.5px', gap: 8, fontSize: 12, color: mix(tk.mutedFg, 60) }}>
        <MagnifyingGlass size={16} />
        {b.search}
      </Btn>
      <span style={{ ...at(680, 159.1), width: 52.5, height: 29.8, borderRadius: 5, background: 'rgba(240,240,240,0.3)' }} />
      <Btn style={{ ...at(681.8, 160.9), width: 24.5, height: 26.3, borderRadius: 9, justifyContent: 'center', background: tk.background, boxShadow: '0 1px 2px rgba(0,0,0,0.08)', color: tk.mutedFg }}>
        <GridNine size={14} />
      </Btn>
      <Btn style={{ ...at(706.3, 160.9), width: 24.5, height: 26.3, justifyContent: 'center', color: tk.mutedFg }}>
        <List size={14} />
      </Btn>
      <Star size={16} color={tk.mutedFg} style={{ ...at(743.8, 166) }} />
      <Plus size={16} color={tk.mutedFg} style={{ ...at(775.3, 166) }} />
      <Btn style={{ ...at(802.5, 161.8), width: 62.5, height: 24.5, padding: '0 0 0 8px', gap: 10.5, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
        <ListChecks size={14} />
        {b.manage}
      </Btn>
      {filters.map(([label, w], i) => (
        <Btn key={label} style={{ ...at(16 + i * 59, 200.3), width: w, height: 20, borderRadius: 5, justifyContent: 'center', fontSize: 11, fontWeight: 500, color: tk.mutedFg, background: i === 0 ? tk.accent : 'transparent' }}>
          {label}
        </Btn>
      ))}
      <span style={{ ...at(137.4, 205), width: 1, height: 10.5, background: 'rgba(224,224,224,0.6)' }} />
      {(
        [
          [147.2, 27, b.diff.easy, tk.success],
          [179.4, 27, b.diff.medium, tk.warning],
          [211.7, 27, b.diff.hard, tk.warning],
          [243.9, 38, b.diff.very_hard, tk.mutedFg],
        ] as Array<[number, number, string, string]>
      ).map(([x, w, label, c]) => (
        <Btn key={label} style={{ ...at(x, 200.3), width: w, height: 20, justifyContent: 'center', fontSize: 11, fontWeight: 500, color: c }}>
          {label}
        </Btn>
      ))}
      <span style={{ ...at(290.7, 205), width: 1, height: 10.5, background: 'rgba(224,224,224,0.6)' }} />
      {TYPE_DIST.map(([type], i) => (
        <Btn key={type} style={{ ...at(300.4 + i * 43.27, 200.3), width: 38, height: 20, justifyContent: 'center', fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
          {S.exam.type[type]}
        </Btn>
      ))}
      {QUESTIONS.map((q, i) => {
        const row = Math.floor(i / GRID_COLS);
        const x = 16 + (i % GRID_COLS) * GRID_PITCH;
        const y = GRID_ROW_Y[row];
        const h = GRID_ROW_H[row];
        if (y > EXAM_H) return null;
        const hot = i === 6 && s.hover === 'q7';
        return (
          <span
            key={i}
            style={{
              ...at(x, y),
              width: GRID_CARD_W,
              height: h,
              boxSizing: 'border-box',
              borderRadius: 7,
              background: hot ? 'rgba(240,240,240,0.7)' : 'rgba(252,252,252,0.3)',
              border: `1px solid ${hot ? 'rgba(224,224,224,0.9)' : 'rgba(224,224,224,0.4)'}`,
              transform: `scale(${1 - 0.01 * (hot ? s.press : 0)})`,
            }}
          >
            <span style={{ position: 'absolute', left: 14, top: 14.3, fontSize: 12, fontWeight: 500, lineHeight: '16.8px', color: tk.mutedFg }}>{i + 1}</span>
            <span
              style={{
                position: 'absolute',
                left: 14,
                top: 38.5,
                width: GRID_CARD_W - 30,
                fontSize: 12,
                lineHeight: '19.5px',
                color: mix(tk.foreground, 80),
                display: '-webkit-box',
                WebkitBoxOrient: 'vertical',
                WebkitLineClamp: 2,
                overflow: 'hidden',
              }}
            >
              {q.content}
            </span>
            <span style={{ position: 'absolute', left: 14, top: h - 34.9, display: 'flex', alignItems: 'center', gap: 5.25, fontSize: 11, lineHeight: '18.9px' }}>
              <span style={{ padding: '0 5.25px', borderRadius: 3.5, fontWeight: 500, background: mix(tk.primary, 10), color: tk.primary }}>{S.exam.type[q.type]}</span>
              <span style={{ padding: '0 5.25px', borderRadius: 3.5, fontWeight: 500, background: mix(diffColor(tk, q.diff), 10), color: diffColor(tk, q.diff) }}>{b.diff[q.diff]}</span>
              <span style={{ color: tk.mutedFg }}>{b.statusNew}</span>
            </span>
          </span>
        );
      })}
    </>
  );
};

// ── 做题 ──────────────────────────────────────────────
/** 做题卡：x 16、宽 644（内容 614），整栏再右移 COL_DX 到与底栏同一条 672 居中栏（probe-kzx）；统计行四格铺在卡片宽度里 */
const CARD_W = 644;
const COL_DX = 102.5;
const CARD_IN = 614;
const OPT_Y = 344.5;
const OPT_PITCH = 54;
const RESULT_Y = 605.2;
/** 底部导航（上一题 / 7 / 18 / 下一题）顶边 */
const NAV_Y = 610.8;
const AI_Y = 741.6;
const AI_FONT = 12;
const AI_LH = 19.5;

/** 流式 Markdown：有序列表 + 加粗小标题，公式整段出现（StreamingMarkdownRenderer 的 $…$ 走 KaTeX）。 */
const AiMarkdown = ({ tk, chars }: { tk: Tokens; chars: number }) => {
  let left = chars;
  const items: ReactNode[] = [];
  for (const [i, [label, body]] of AI_ITEMS.entries()) {
    if (left <= 0) break;
    const head = label.slice(0, left);
    left -= label.length;
    const parts: ReactNode[] = [];
    if (left > 0) {
      parts.push('：');
      left -= 1;
    }
    for (const [j, seg] of body.entries()) {
      if (left <= 0) break;
      if (typeof seg === 'string') {
        parts.push(seg.slice(0, left));
        left -= seg.length;
      } else {
        parts.push(<Tex key={j} tex={seg.tex} />);
        left -= segLen(seg);
      }
    }
    items.push(
      <li key={i} style={{ marginTop: i === 0 ? 0 : 3.5 }}>
        <strong style={{ fontWeight: 600, color: tk.foreground }}>{head}</strong>
        {parts}
      </li>,
    );
  }
  return <ol style={{ margin: 0, paddingLeft: 18, fontSize: AI_FONT, lineHeight: `${AI_LH}px`, color: tk.mutedFg }}>{items}</ol>;
};

/** 各条在 509px 列表宽里折成的行数（静帧实测）；流式输出时面板按行长高、把「我的笔记」往下推。 */
const AI_LINES = [2, 2, 2, 1];
const aiTextH = (chars: number) => {
  let left = chars;
  let h = 0;
  for (const [i, [label, body]] of AI_ITEMS.entries()) {
    if (left <= 0) break;
    const n = label.length + 1 + body.reduce((m, s) => m + segLen(s), 0);
    const lines = left >= n ? AI_LINES[i] : Math.max(1, Math.ceil((left / n) * AI_LINES[i]));
    h += (i > 0 ? 3.5 : 0) + lines * AI_LH;
    left -= n;
  }
  return h;
};
const aiExtra = (s: ExamState) => {
  if (s.ai === 'idle') return 0;
  if (s.ai === 'thinking') return 20 - 18 + 7 + 12.25;
  return 20 - 18 + (s.ai === 'done' ? 3.5 : 7) + aiTextH(Math.round(AI_LEN * s.aiK));
};

const OptionRow = ({ tk, s, i, k, text }: { tk: Tokens; s: ExamState; i: number; k: string; text: string }) => {
  const y = OPT_Y + i * OPT_PITCH;
  const v = s.submitted;
  const wrong = i === 0 && v > 0;
  const right = i === 2 && v > 0;
  const dim = v > 0 && !wrong && !right;
  const selected = i === 0 && s.picked && v <= 0;
  const hovered = i === 0 && s.hover === 'optA';
  const verdict = wrong ? tk.destructive : right ? tk.success : null;
  const bg = verdict ? mix(verdict, 8 * v) : selected ? (hovered ? HOVER_BG : mix(tk.primary, 7)) : hovered ? mix(tk.foreground, 4) : 'transparent';
  return (
    <span
      style={{
        ...at(31, y),
        width: CARD_IN,
        height: 43.5,
        borderRadius: 5,
        background: bg,
        boxShadow: selected ? `inset 0 0 0 1px ${mix(tk.primary, 40)}` : 'none',
        transform: `scale(${1 - 0.006 * (hovered ? s.press : 0)})`,
      }}
    >
      <Btn
        style={{
          position: 'absolute',
          left: 11.5,
          top: 9.7,
          width: 24,
          height: 24,
          borderRadius: 9999,
          justifyContent: 'center',
          fontSize: 12,
          fontWeight: 500,
          color: verdict || selected ? '#fff' : mix(tk.foreground, dim ? 35 : 65),
          background: verdict ? verdict : selected ? tk.primary : 'transparent',
          border: verdict || selected ? 'none' : `1px solid ${mix(tk.foreground, dim ? 8 : 16)}`,
        }}
      >
        {wrong ? <X size={14} weight="bold" /> : right ? <Check size={14} weight="bold" /> : k}
      </Btn>
      <span style={{ position: 'absolute', left: 46, top: 13.5, display: 'inline-flex', alignItems: 'flex-start', gap: 10.5, whiteSpace: 'nowrap' }}>
        <span style={{ fontSize: 12, fontWeight: 500, lineHeight: '15px', color: verdict ?? mix(tk.foreground, dim ? 50 : 100) }}>{text}</span>
        {verdict ? (
          <span style={{ marginTop: -3.8, fontSize: 11, fontWeight: 500, lineHeight: '11px', color: verdict }}>{wrong ? S.exam.q.wrong : S.exam.q.correct}</span>
        ) : selected || hovered ? (
          <Btn style={{ marginTop: -3.8, width: 18, height: 18, borderRadius: 3.5, justifyContent: 'center', background: tk.muted, fontSize: 10, fontWeight: 500, color: mix(tk.mutedFg, 70) }}>{i + 1}</Btn>
        ) : null}
      </span>
    </span>
  );
};

const PracticePane = ({ tk, s }: { tk: Tokens; s: ExamState }) => {
  const q = S.exam.q;
  const v = s.submitted;
  const extra = aiExtra(s);
  const notesY = v > 0 ? 794.3 + extra : 657.7;
  const cardH = notesY + 15 + 39 + 15 - 172.6;
  const stats: Array<[ReactNode, string, string]> = [
    [<BookOpen key="b" size={16} color={tk.mutedFg} />, String(QUESTIONS.length), q.total],
    [<Target key="t" size={16} color={tk.success} />, '0', q.mastered],
    [<ArrowCounterClockwise key="r" size={16} color={tk.warning} />, v > 0.5 ? '1' : '0', q.review],
    [<TrendUp key="u" size={16} color={tk.primary} />, '0%', q.rate],
  ];
  const statX = [27.4, 189.6, 351.8, 514];
  const aiHover = s.hover === 'ai';
  return (
    <>
      <span style={{ ...at(MAIN_X, 85.5), width: MAIN_W, height: 8, background: 'rgba(224,224,224,0.4)' }}>
        <span style={{ display: 'block', width: (MAIN_W * 7) / QUESTIONS.length, height: '100%', background: tk.primary }} />
      </span>
      <span style={{ ...at(MAIN_X, 93.5), width: MAIN_W, height: EXAM_H - 1 - 93.5, overflow: 'hidden' }}>
        <span style={{ position: 'absolute', left: -MAIN_X + 1 + COL_DX, top: -93.5 + 39 - s.scroll, width: EXAM_W, height: 1400 }}>
          {stats.map(([icon, value, label], i) => (
            <span key={label}>
              <span style={{ ...at(statX[i], 132), display: 'inline-flex' }}>{icon}</span>
              <span style={{ ...at(statX[i] + 24.8, 130.3), fontSize: 14, fontWeight: 500, lineHeight: '19.6px', color: tk.foreground, whiteSpace: 'nowrap' }}>
                {value}
                <span style={{ marginLeft: 5.5, fontSize: 11, fontWeight: 400, lineHeight: '15.4px', color: tk.mutedFg }}>{label}</span>
              </span>
            </span>
          ))}
          <span style={{ ...at(16, 172.6), width: CARD_W, height: cardH, boxSizing: 'border-box', borderRadius: 12, background: tk.background, border: '1px solid rgba(224,224,224,0.6)', boxShadow: '0 1px 3px hsl(220 20% 10% / 0.05)' }} />
          <Btn style={{ ...at(31, 190.7), width: 17, height: 20, borderRadius: 3.5, justifyContent: 'center', fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>7</Btn>
          <Btn style={{ ...at(55, 190.7), width: 43.5, height: 20, borderRadius: 3.5, justifyContent: 'center', fontSize: 11, fontWeight: 500, color: tk.mutedFg, background: 'rgba(240,240,240,0.1)' }}>{q.singleChoice}</Btn>
          <Btn style={{ ...at(105.5, 190.7), width: 32.5, height: 20, borderRadius: 3.5, justifyContent: 'center', fontSize: 11, fontWeight: 500, color: tk.warning, background: mix(tk.warning, 10) }}>{q.medium}</Btn>
          <span style={{ ...at(145, 193), fontSize: 11, lineHeight: '15.4px', color: v > 0.5 ? tk.warning : tk.mutedFg }}>{v > 0.5 ? q.statusReview : q.statusNew}</span>
          <GearSix size={16} color={tk.mutedFg} style={{ ...at(16 + CARD_W - 36.1, 192.7) }} />
          {['罗尔定理', '中值定理'].map((tag, i) => (
            <Btn key={tag} style={{ ...at(31 + i * 78.8, 220.8), width: 73.5, height: 18.9, borderRadius: 5, padding: '0 0 0 7px', gap: 4, fontSize: 11, color: tk.mutedFg, background: 'rgba(240,240,240,0.8)' }}>
              <Tag size={12} />
              {tag}
            </Btn>
          ))}
          <span style={{ ...at(31, 250.2), width: CARD_IN, fontSize: 13, lineHeight: '18.2px', color: tk.foreground }}>{Q7.content}</span>
          <Btn style={{ ...at(31, 297.2), width: 115.3, height: 26.3, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
            <Crop size={14} />
            {q.sourceImages}
          </Btn>
          {Q7_OPTIONS.map(([k, text], i) => (
            <OptionRow key={k} tk={tk} s={s} i={i} k={k} text={text} />
          ))}
          {v <= 0 ? (
            <>
              <Btn style={{ ...at(31, 571), width: CARD_IN, height: 31.5, ...ghostBtn(tk, s.hover === 'submit', s.press), fontSize: 12, opacity: s.picked ? 1 : 0.5 }}>
                <PaperPlaneRight size={16} />
                {q.submit}
              </Btn>
              <span style={{ ...at(31, 623.5), width: CARD_IN, textAlign: 'center', fontSize: 11, lineHeight: '13.2px', color: mix(tk.mutedFg, 60) }}>{q.hint}</span>
            </>
          ) : (
            <>
              <span style={{ ...at(31, 571), width: CARD_IN, textAlign: 'center', fontSize: 11, lineHeight: '13.2px', color: mix(tk.mutedFg, 60), opacity: v }}>{q.hintAfter}</span>
              <span style={{ ...at(31, RESULT_Y), width: CARD_IN, height: 168.1 + extra, borderRadius: 5, background: mix(tk.destructive, 8), opacity: v, transform: `translateY(${(1 - v) * 6}px)` }}>
                <Btn style={{ position: 'absolute', left: 10.5, top: 12, width: 20, height: 20, borderRadius: 9999, justifyContent: 'center', background: tk.destructive, color: '#fff' }}>
                  <X size={12} weight="bold" />
                </Btn>
                <span style={{ position: 'absolute', left: 39.3, top: 13.6, fontSize: 12, lineHeight: '16.8px', whiteSpace: 'nowrap', color: tk.mutedFg }}>
                  <span style={{ fontWeight: 500, color: tk.destructive }}>{q.answerWrong}</span>
                  <span style={{ marginLeft: 8.7 }}>· {q.correctAnswer}</span>
                  <span style={{ fontWeight: 500, color: tk.foreground }}>C</span>
                </span>
                <Btn style={{ position: 'absolute', left: CARD_IN - 73, top: 10.5, width: 62.5, height: 23, padding: '0 0 0 9.8px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
                  <ArrowClockwise size={14} />
                  {q.retry}
                </Btn>
                {[44, 83.6, 128.4].map((y) => (
                  <span key={y} style={{ position: 'absolute', left: 10.5, top: y, width: CARD_IN - 21, height: 1, background: mix(tk.foreground, 6) }} />
                ))}
                <Btn style={{ position: 'absolute', left: 10.5, top: 52, height: 18, gap: 4.5, fontSize: 11, fontWeight: 500, color: tk.warning }}>
                  <Lightbulb size={16} />
                  {q.viewExplanation}
                  <CaretDown size={14} />
                </Btn>
                <Btn style={{ position: 'absolute', left: 10.5, top: 91.6, width: 95, height: 26.3, padding: '0 0 0 11.5px', gap: 6, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
                  <ChatCircleText size={15} />
                  {q.ask}
                </Btn>
                <Btn style={{ position: 'absolute', left: 110.8, top: 91.6, width: 100, height: 26.3, padding: '0 0 0 11.5px', gap: 6, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
                  <CopySimple size={15} />
                  {q.similar}
                </Btn>
                {s.ai === 'idle' ? (
                  <Btn style={{ position: 'absolute', left: 10.5, top: AI_Y - RESULT_Y, height: 18, gap: 4.5, fontSize: 11, fontWeight: 500, color: aiHover ? tk.foreground : tk.mutedFg, textDecoration: aiHover ? 'underline' : 'none' }}>
                    <AnalysisIcon size={16} color="currentColor" />
                    {q.ai}
                  </Btn>
                ) : (
                  <span style={{ position: 'absolute', left: 10.5, right: 10.5, top: AI_Y - RESULT_Y }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: s.ai === 'done' ? 5.25 : 7, height: 20, fontSize: 12, color: tk.info }}>
                      <AnalysisIcon size={16} color={tk.info} opacity={s.ai === 'done' ? 1 : 0.6 + 0.4 * Math.abs(Math.cos(s.aiK * 9 + (s.ai === 'thinking' ? 0 : 1)))} />
                      {s.ai === 'done' ? q.ai : q.aiRunning}
                      {s.ai !== 'done' ? <span style={{ marginLeft: 'auto', fontSize: 11, color: tk.mutedFg }}>{q.cancel}</span> : null}
                    </span>
                    {s.ai === 'thinking' ? (
                      <span style={{ display: 'flex', gap: 3.5, padding: '3.5px 0', marginTop: 7 }}>
                        {[0, 1, 2].map((d) => (
                          <span key={d} style={{ width: 5.25, height: 5.25, borderRadius: 9999, background: mix(tk.info, 60), transform: `translateY(${-Math.max(0, Math.sin(s.aiK * Math.PI * 2 - d * 0.9)) * 4}px)` }} />
                        ))}
                      </span>
                    ) : (
                      <span style={{ display: 'block', marginTop: s.ai === 'done' ? 3.5 : 7 }}>
                        <AiMarkdown tk={tk} chars={Math.round(AI_LEN * s.aiK)} />
                      </span>
                    )}
                  </span>
                )}
              </span>
            </>
          )}
          <span style={{ ...at(31, notesY), width: CARD_IN, height: 1, background: 'rgba(224,224,224,0.3)' }} />
          <Btn style={{ ...at(31, notesY + 15), width: CARD_IN, height: 39, borderRadius: 5, border: '1px solid rgba(224,224,224,0.5)', padding: '0 0 0 11.5px', gap: 7, fontSize: 12, fontWeight: 500, color: tk.mutedFg }}>
            <Note size={16} />
            {q.notes}
            <span style={{ fontSize: 11 }}>{q.addNote}</span>
          </Btn>
        </span>
      </span>
      <span style={{ ...at(MAIN_X, NAV_Y), width: MAIN_W, height: EXAM_H - 1 - NAV_Y, boxSizing: 'border-box', background: tk.background, borderTop: '1px solid rgba(224,224,224,0.4)' }} />
      <Btn style={{ ...at(104.5, NAV_Y + 11.5), width: 82.5, height: 26.3, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
        <CaretLeft size={16} />
        {q.prev}
      </Btn>
      <Btn style={{ ...at(402.1, NAV_Y + 11.5), width: 76.7, height: 26.3, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
        <span>
          7 <span style={{ marginLeft: 1 }}>/{QUESTIONS.length}</span>
        </span>
        <CaretDown size={14} />
      </Btn>
      <Btn style={{ ...at(694, NAV_Y + 11.5), width: 82.5, height: 26.3, padding: '0 0 0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
        {q.next}
        <CaretRight size={16} />
      </Btn>
    </>
  );
};

// ── 组装 ──────────────────────────────────────────────
const PANES: Record<ExamStage, (p: { tk: Tokens; s: ExamState }) => ReactElement> = {
  home: HomePane,
  launcher: LauncherPane,
  upload: UploadPane,
  parsing: ParsingPane,
  summary: SummaryPane,
  grid: GridPane,
  practice: PracticePane,
};
/** 识别导入的第 2、3 步是 ui-slide-fade-in（从右 24px 滑入）；其余视图直接切换。 */
const SLIDE: Partial<Record<ExamStage, boolean>> = { parsing: true, summary: true };

export const ExamView = ({ tk, s }: { tk: Tokens; s: ExamState }) => {
  const Pane = PANES[s.stage];
  const k = ease.wbOut(s.enter);
  return (
    <div style={{ position: 'absolute', inset: 0, fontFamily: font.ui, background: tk.background, overflow: 'hidden' }}>
      {s.stage === 'home' ? <Sidebar tk={tk} s={s} /> : null}
      {s.stage !== 'home' ? <Toolbar tk={tk} s={s} /> : null}
      <div style={{ position: 'absolute', inset: 0, opacity: k, transform: SLIDE[s.stage] ? `translateX(${(1 - k) * 24}px)` : undefined }}>
        <Pane tk={tk} s={s} />
      </div>
      {s.stage === 'launcher' && s.drag > 0 ? <DropOverlay tk={tk} k={s.drag} /> : null}
      {s.stage !== 'home' ? (
        <CollapsingSidebar tk={tk} k={s.collapse}>
          <Sidebar tk={tk} s={s} />
        </CollapsingSidebar>
      ) : null}
    </div>
  );
};

/**
 * 「已加入今日复习」提示（修正版，UnifiedNotification success 样式）：屏幕顶部居中 top 12px，
 * 28px 高胶囊、成功色 6% 底 + 68% 描边、13px 状态图标、12px/500 文案，底部 1px 倒计时线；入场 220ms、退场 180ms。
 */
/** 全局通知（UnifiedNotification success）：默认是题目集判错后的「已加入今日复习」；text / action 可换成别的通知 */
export const ExamToast = ({ tk, life, dur, text = REVIEW_TOAST, action }: { tk: Tokens; life: number; dur: number; text?: string; action?: string }) => {
  if (life < 0 || life > dur) return null;
  const inK = ease.wbOut(clamp(life / 0.11));
  const outK = clamp((life - (dur - 0.09)) / 0.09);
  const stroke = mix(tk.success, 68);
  return (
    <div
      style={{
        position: 'absolute',
        left: 960,
        top: 12,
        transform: `translateX(-50%) translateY(${(1 - inK) * -10 - outK * 8}px) scale(${0.98 + 0.02 * inK - 0.02 * outK})`,
        opacity: inK * (1 - outK),
        minHeight: 28,
        boxSizing: 'border-box',
        padding: '4px 12px',
        borderRadius: 12,
        display: 'flex',
        alignItems: 'center',
        gap: 6,
        background: `color-mix(in srgb, ${tk.success} 6%, ${tk.card} 94%)`,
        border: `1px solid ${stroke}`,
        boxShadow: `0 6px 14px ${mix(tk.foreground, 7)}, 0 1px 3px ${mix(tk.foreground, 5)}`,
        fontFamily: font.ui,
        whiteSpace: 'nowrap',
        overflow: 'hidden',
      }}
    >
      <span style={{ width: 14, height: 14, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: stroke, opacity: 0.82 }}>
        <CheckCircle size={13} />
      </span>
      <span style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.35, color: tk.foreground }}>{text}</span>
      {action ? <span style={{ marginLeft: 4, height: 24, padding: '0 8px', borderRadius: 8, display: 'inline-flex', alignItems: 'center', fontSize: 12, fontWeight: 500, color: tk.foreground }}>{action}</span> : null}
      <span
        style={{
          position: 'absolute',
          left: 12,
          right: 12,
          bottom: 2,
          height: 1,
          borderRadius: 999,
          background: `linear-gradient(90deg, transparent 0%, ${stroke} 18%, ${stroke} 82%, transparent 100%)`,
          opacity: 0.28,
          transformOrigin: 'left center',
          transform: `scaleX(${1 - clamp(life / dur)})`,
        }}
      />
    </div>
  );
};

/** 拖拽中的文件（从屏幕外拖进来，桌面坐标系，由场景摆放）。 */
export const FileChip = ({ tk, lift = 0 }: { tk: Tokens; lift?: number }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      padding: '10px 14px 10px 10px',
      borderRadius: 10,
      background: tk.background,
      border: `1px solid ${tk.border}`,
      boxShadow: `0 ${4 + lift * 14}px ${12 + lift * 24}px -8px rgba(0,0,0,${0.18 + lift * 0.14})`,
      fontFamily: font.ui,
      transform: `rotate(${lift * -3}deg) scale(${1 + lift * 0.04})`,
    }}
  >
    <span style={{ width: 34, height: 40, borderRadius: 4, background: `color-mix(in hsl, ${tk.destructive} 10%, #fff)`, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.destructive }}>
      <FilePdf size={22} weight="fill" />
    </span>
    <span>
      <span style={{ display: 'block', fontSize: 14, fontWeight: 500, color: tk.foreground, whiteSpace: 'nowrap' }}>{PAPER_NAME}</span>
      <span style={{ display: 'block', fontSize: 12, color: tk.mutedFg }}>4 页 · 2.1 MB</span>
    </span>
  </div>
);

/** 片中点到的位置（窗口坐标，含 1px 边框与 38px 标题栏）。`ai` 是未滚动时的位置。 */
export const EXAM_PT = {
  newExam: { x: 576, y: 397.6 },
  drop: { x: 454, y: 392 },
  parse: { x: 590.2, y: 590 },
  view: { x: 590.2, y: 513.9 },
  /** 3 列网格里第 7 题在第 3 行第 1 列 */
  q7: { x: 150, y: 540 },
  optA: { x: 352.5, y: 366.3 },
  submit: { x: 440.5, y: 586.8 },
  /** 判错后结果面板整块压在底栏下面，在选项区滚动（滚完「AI 解析」按钮就在指针上方） */
  wheel: { x: 432.5, y: 560 },
  /** 读解析时瞳点停在题卡右侧的空白里（762.5–879），不挡字 */
  aside: { x: 818, y: 420 },
  ai: { x: 176.5, y: 750.6 },
} as const;
/** 解析进度里逐页识别完成、逐题入库起止的位置（0–1），音效按它对点。 */
export const EXAM_PARSE_MARKS = { pages: PAGE_AT, q0: P_PARSE, q1: P_PARSED } as const;
/** 启动台拖放区的右边界（窗口坐标）：瞳点越过它即 dragenter。 */
export const EXAM_DROP_RIGHT = MAIN_X + MAIN_W;
/** 判错后两次滚动的累计位移（px）：先把结果面板与「AI 解析」按钮滚出底栏，再跟着流式输出往下看。 */
export const EXAM_SCROLL = [250, 400] as const;

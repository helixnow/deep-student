import {
  ArrowLeft,
  ArrowUpRight,
  Camera,
  CardsThree,
  CaretDown,
  ChatCircleText,
  CheckCircle,
  CheckSquare,
  CircleNotch,
  ClosedCaptioning,
  Copy,
  Crosshair,
  DotsThree,
  FilmStrip,
  Folders,
  GridFour,
  List,
  ListBullets,
  ListChecks,
  MagnifyingGlass,
  MusicNotes,
  Notebook,
  Play,
  QrCode,
  Sparkle,
  Subtitles,
  Television,
  UploadSimple,
  UserCircle,
  X,
} from '@phosphor-icons/react';
import aiDashboardIcon from '@app/features/workbench/icons/app-icons/aiDashboard.svg';
import chatIcon from '@app/features/workbench/icons/app-icons/chat.svg';
import essayIcon from '@app/features/workbench/icons/app-icons/essay.svg';
import examIcon from '@app/features/workbench/icons/app-icons/exam.svg';
import filesIcon from '@app/features/workbench/icons/app-icons/files.svg';
import flashcardsIcon from '@app/features/workbench/icons/app-icons/flashcards.svg';
import mediaIcon from '@app/features/workbench/icons/app-icons/media.svg';
import mindmapIcon from '@app/features/workbench/icons/app-icons/mindmap.svg';
import notesIcon from '@app/features/workbench/icons/app-icons/notes.svg';
import pomodoroIcon from '@app/features/workbench/icons/app-icons/pomodoro.svg';
import settingsIcon from '@app/features/workbench/icons/app-icons/settings.svg';
import skillsIcon from '@app/features/workbench/icons/app-icons/skills.svg';
import taskDashboardIcon from '@app/features/workbench/icons/app-icons/taskDashboard.svg';
import templatesIcon from '@app/features/workbench/icons/app-icons/templates.svg';
import todoIcon from '@app/features/workbench/icons/app-icons/todo.svg';
import translationIcon from '@app/features/workbench/icons/app-icons/translation.svg';
import type { CSSProperties, ReactNode } from 'react';
import { clamp, ease, prog } from '../lib/time';
import { S } from '../strings';
import { font, type Tokens } from '../theme';
import { Tex } from './tex';
import { glassOf, WB } from './workbench';

/**
 * 音视频（0.10.2 起的独立应用，MediaStudioApp）在学习桌面里的转写：
 * - 全部应用面板（AppsPanel.tsx / AppsPanel.css）：网格 → 输入即进入分区搜索；
 * - 库页（MediaLibraryPage + MediaLibraryRow）：标题行（选择 / B 站链接 / 导入音视频）、tagline、搜索 + 状态筛选、
 *   列表行 = 86×42 缩略图（B 站封面 + 左上「B 站」角标 + 底边进度）· 名称 · 时长 / 最近观看 · 转写状态徽章 · ⋯；
 * - 「从 B 站链接导入」弹窗（BilibiliLinkDialog，DsDialog max-w-lg，全屏 black/30 遮罩）：账号行 → 链接 + 解析 →
 *   封面 / 标题 / 共 n P → 分 P 勾选列表 → 字幕轨 → 「导入 n 个分 P」→ 逐 P 进度；
 * - 学习页（MediaStudyPage → MediaStudyView）：返回 / 标题行、工具栏、播放器（16:9 contain）+ 右侧 380 宽伴随分区
 *   （字幕 / 讲义 / 问答 / 练习；字幕分区 = TranscriptPanel：段数、定位 / 复制、搜索、逐段时间 + 文本，当前段 primary/10 底；
 *   讲义 / 问答 / 练习 = MediaStudyTabs 的 MediaHandoutTab / MediaAskTab / MediaPracticeTab。问答与练习在桌面版会新开对话，
 *   片中按网页演示 src/demo/app/packs/media/companion.ts 的做法在分区里就地展示对话层，剧本与演示同文）。
 * 根字号 14px：Tailwind 0.25rem = 3.5px；text-xs 11 / text-sm 12 / text-ui 13 / text-base 14。
 * 画面里的课程与 UP 主均为虚构；视频画面是 CSS 画的讲义幻灯片，不是真实视频。
 */
export const MEDIA_W = 1100;
export const MEDIA_H = 700;
/** 窗口内容区（标题栏之下）：内容坐标 (0,0) = 窗口坐标 (1, 1 + 标题栏)。 */
const CW = MEDIA_W - 2;
const CH = MEDIA_H - 2 - WB.titlebar;
export const contentToWin = (p: { x: number; y: number }) => ({ x: p.x + 1, y: p.y + 1 + WB.titlebar });

const PRI = 'hsl(215 72% 42%)';
const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
const SUCCESS = 'hsl(152 60% 36%)';
const CARD_BORDER = 'hsl(0 0% 90%)';

// ── 课程内容（虚构） ─────────────────────────────────────────
export const COURSE = {
  title: '线性代数第五讲 特征值与对角化',
  owner: '数学公开课',
  link: 'https://www.bilibili.com/video/BV1Wq4y1K7mS',
  track: '中文（中国）',
  pages: [
    { part: '特征值与特征向量', dur: '21:36' },
    { part: '特征多项式', dur: '18:05' },
    { part: '相似矩阵', dur: '16:42' },
    { part: '对角化的条件', dur: '22:48' },
    { part: '例题精讲', dur: '25:10' },
  ],
} as const;
/** 片中点开的分 P（P4 对角化的条件） */
export const STUDY_PAGE = 3;
export const pageName = (i: number) => `${COURSE.title} P${i + 1} ${COURSE.pages[i].part}`;

/** P4 的字幕（UP 主上传的字幕轨）：[秒, 文本]；与网页演示 src/demo/app/packs/media/data.ts 的 P4_LINES 同一份 */
export const SEGMENTS: Array<[number, string]> = [
  [0, '好，我们开始这一讲。'],
  [2, '上一讲我们学会了求特征值和特征向量，'],
  [5, '今天回答一个问题：'],
  [8, '什么样的矩阵可以相似于对角矩阵？'],
  [13, '先回顾一下定义。'],
  [16, '若存在可逆矩阵 P，使 P⁻¹AP = Λ，'],
  [23, '就称 A 可以相似对角化。'],
  [28, '那么判断的依据是什么？'],
  [33, '来看下面这个定理。'],
  [37, 'n 阶矩阵 A 可对角化，'],
  [41, '当且仅当 A 有 n 个线性无关的特征向量。'],
  [48, '这时 P 的列就是这 n 个特征向量，'],
  [54, 'Λ 的对角线上依次是对应的特征值。'],
  [61, '为什么？把 AP = PΛ 按列拆开来看，'],
  [68, '第 i 列就是 Aξᵢ = λᵢξᵢ。'],
  [75, '所以对角化，本质上就是找够 n 个线性无关的特征向量。'],
  [84, 'P 可逆，正好要求这些列线性无关。'],
  [95, '注意顺序：P 的第几列，对应 Λ 的第几个对角元。'],
  [108, '列的顺序换了，Λ 的对角元跟着换，结论仍然成立。'],
  [122, '很多同学在这里丢分，写 P 和 Λ 时顺序对不上。'],
  [140, '再强调一点：特征向量不唯一，'],
  [150, '乘一个非零常数仍然是特征向量，所以 P 也不唯一。'],
  [170, '但 Λ 在不计顺序的意义下是唯一的。'],
  [195, '证明的思路我们简单过一下。'],
  [205, '必要性：P⁻¹AP = Λ，则 AP = PΛ，P 的 n 列就是特征向量。'],
  [225, '充分性：有 n 个线性无关的特征向量，就把它们排成 P。'],
  [245, 'P 的列线性无关，所以 P 可逆，于是 P⁻¹AP = Λ。'],
  [270, '这个定理给出了判别方法，但直接用并不方便。'],
  [300, '下面看一个很常用的推论。'],
  [306, '如果 A 有 n 个互不相同的特征值，'],
  [312, '那么 A 一定可以对角化。'],
  [320, '依据是：属于不同特征值的特征向量线性无关。'],
  [340, '每个特征值至少取一个特征向量，凑够 n 个，就满足定理。'],
  [365, '但要注意，这只是充分条件，不是必要条件。'],
  [382, '举个最简单的反例：单位矩阵 E。'],
  [392, '它只有一个特征值 1，是 n 重的，'],
  [402, '可它本身就是对角阵，当然可以对角化。'],
  [430, '所以特征值有重复时，不能直接下结论，'],
  [445, '需要进一步检查。'],
  [470, '考试里常见的说法是「A 有 n 个不同的特征值」，'],
  [482, '看到这个条件，直接就能说 A 可对角化。'],
  [492, '那反过来，看到重特征值，我们该怎么判断呢？'],
  [510, '这就要引入两个概念：代数重数和几何重数。'],
  [540, '先放一下，我们把推论的证明补完。'],
  [570, '好，现在来看有重特征值的情形。'],
  [578, '设 λ 是 A 的一个特征值。'],
  [584, '它作为特征多项式根的重数，叫代数重数；'],
  [595, '它的特征子空间的维数，叫几何重数。'],
  [606, '几何重数等于 n 减去 λE − A 的秩。'],
  [620, '一个基本事实：几何重数总是小于等于代数重数，'],
  [640, '而且至少是 1。'],
  [660, '于是有下面这个定理：'],
  [668, 'A 可对角化，当且仅当每个特征值的几何重数都等于代数重数。'],
  [690, '直观地说，每个特征值都要「交够」自己那一份特征向量。'],
  [720, '只要有一个特征值交不够，总数就凑不满 n 个。'],
  [750, '实际计算时，单根一定没问题，'],
  [760, '只需检查重根：看 r(λE − A) 是否等于 n 减重数。'],
  [800, '比如二重根，就要求 r(λE − A) = n − 2。'],
  [840, '这是判断可对角化最常用的方法，大家一定记住。'],
  [880, '下面我们做一道例题。'],
  [900, '例 5.9，A 是这个三阶矩阵，对角线是 4，其余元素都是 1。'],
  [915, '问能否对角化，能的话求出 P。'],
  [930, '第一步，求特征多项式。'],
  [945, '把各列加到第一列，提出公因子，'],
  [960, '得到 |λE − A| = (λ − 6)(λ − 3)²。'],
  [985, '所以特征值是 3（二重）和 6。'],
  [1005, '第二步，检查二重根 λ = 3。'],
  [1020, '3E − A 的每个元素都是 −1，'],
  [1030, '秩等于 1，几何重数 3 − 1 = 2，'],
  [1045, '等于代数重数 2，所以 A 可以对角化。'],
  [1080, '其实 A 是实对称矩阵，下一讲会看到，实对称矩阵一定可以对角化。'],
  [1140, '第三步，求特征向量。'],
  [1150, 'λ = 3 时，解 x₁ + x₂ + x₃ = 0，'],
  [1162, '取 ξ₁ = (−1, 1, 0)ᵀ，ξ₂ = (−1, 0, 1)ᵀ。'],
  [1180, 'λ = 6 时，解得 ξ₃ = (1, 1, 1)ᵀ。'],
  [1200, '令 P = (ξ₁, ξ₂, ξ₃)，'],
  [1210, '就有 P⁻¹AP = diag(3, 3, 6)。'],
  [1240, '再强调一遍顺序：P 的列和对角元一一对应。'],
  [1270, '最后总结一下这一讲的判断流程：'],
  [1280, '先求特征值，单根不用管，'],
  [1290, '重根逐个检查几何重数，'],
  [1300, '都满足，就把特征向量按顺序排成 P。'],
  [1325, '下一讲我们讲实对称矩阵的对角化。'],
  [1340, '好，这一讲就到这里。'],
];
export const segAt = (sec: number) => {
  let i = -1;
  SEGMENTS.forEach(([s], k) => {
    if (sec >= s) i = k;
  });
  return i;
};
const clockOf = (sec: number) => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

// ── 通用小件 ───────────────────────────────────────────────
const Box = ({ x, y, w, h, style, children }: { x: number; y: number; w?: number; h?: number; style?: CSSProperties; children?: ReactNode }) => (
  <div style={{ position: 'absolute', left: x, top: y, width: w, height: h, boxSizing: 'border-box', ...style }}>{children}</div>
);

const btn = (style: CSSProperties): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 5.25,
  boxSizing: 'border-box',
  whiteSpace: 'nowrap',
  fontSize: 12,
  fontWeight: 500,
  borderRadius: 9,
  ...style,
});
const ghostBtn = (tk: Tokens, hover: number, press: number): CSSProperties =>
  btn({ color: tk.foreground, background: hover > 0 ? mix(tk.foreground, 7 * hover + 5 * press) : 'transparent' });
const primaryBtn = (tk: Tokens, hover: number, press: number): CSSProperties =>
  btn({
    color: tk.primary,
    background: `color-mix(in srgb, ${tk.primary} ${10 + 5 * hover + 6 * press}%, ${tk.background})`,
    border: `1px solid ${mix(tk.primary, 24)}`,
  });

const Spin = ({ size, color, t }: { size: number; color: string; t: number }) => (
  <CircleNotch size={size} color={color} style={{ transform: `rotate(${(t * 2 * 360) % 360}deg)`, flex: '0 0 auto' }} />
);

const Check = ({ on, tk }: { on: boolean; tk: Tokens }) => (
  <span
    style={{
      width: 14,
      height: 14,
      borderRadius: 4,
      boxSizing: 'border-box',
      border: `1px solid ${on ? tk.primary : tk.border}`,
      background: on ? tk.primary : 'transparent',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      flex: '0 0 auto',
    }}
  >
    {on ? (
      <svg width={9} height={9} viewBox="0 0 10 10">
        <path d="M2 5.2 4.2 7.3 8 2.8" stroke="#fff" strokeWidth={1.6} fill="none" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    ) : null}
  </span>
);

/** B 站封面（虚构课程的统一封面：深蓝底 + 矩阵记号），各分 P 共用 */
export const Cover = ({ w, h }: { w: number; h: number }) => {
  const u = h / 42;
  return (
    <span style={{ position: 'absolute', inset: 0, width: w, height: h, overflow: 'hidden', background: 'linear-gradient(135deg, hsl(212 52% 22%) 0%, hsl(205 56% 32%) 100%)' }}>
      <span style={{ position: 'absolute', right: -9 * u, top: -13 * u, width: 30 * u, height: 30 * u, borderRadius: '50%', background: 'hsl(38 90% 60% / 0.85)' }} />
      <span style={{ position: 'absolute', left: 7 * u, top: 20 * u, fontSize: 9.5 * u, lineHeight: 1, fontWeight: 700, color: '#fff', letterSpacing: '0.02em', fontFamily: font.ui, whiteSpace: 'nowrap' }}>线性代数</span>
      <span style={{ position: 'absolute', left: 7 * u, top: 31.5 * u, fontSize: 6 * u, lineHeight: 1, fontWeight: 500, color: 'hsl(0 0% 100% / 0.78)', fontFamily: font.ui, whiteSpace: 'nowrap' }}>第五讲 · 特征值与对角化</span>
    </span>
  );
};

// ── 全部应用面板 ──────────────────────────────────────────────
/**
 * 启动器可见的 16 个应用（appRegistry 里 showInLauncher !== false；浏览器只在可用时出现，这里不算），
 * 按名称 localeCompare 排序（AppsPanel.filterApps；中文系统下是拼音序，拉丁字母开头的排最后）。
 */
const GRID_APPS: Array<[string, string]> = [
  ['note', notesIcon],
  ['todo', todoIcon],
  ['chat', chatIcon],
  ['pomodoro', pomodoroIcon],
  ['translation', translationIcon],
  ['skills', skillsIcon],
  ['templates', templatesIcon],
  ['flashcards', flashcardsIcon],
  ['settings', settingsIcon],
  ['mindmap', mindmapIcon],
  ['exam', examIcon],
  ['media', mediaIcon],
  ['files', filesIcon],
  ['essay', essayIcon],
  ['aiDashboard', aiDashboardIcon],
  ['taskDashboard', taskDashboardIcon],
];
/** .wb-apps-grid：repeat(auto-fill, minmax(96px, 1fr))，面板内容宽 694 → 6 列 */
const GRID_COLS = 6;
const AP_W = 720;
/** 标题 48 + 搜索 50 + 3 行网格（106 × 3 + 间距 12）+ 内边距 20 + 底栏 37 + 边框 2 */
const AP_H_GRID = 487;
const AP_H_SEARCH = 226;
const AP_CY = 520;

const Kbd = ({ children }: { children: ReactNode }) => (
  <span style={{ padding: '1px 5px', borderRadius: 4, border: '1px solid hsl(0 0% 88% / 0.7)', background: 'hsl(220 6% 42% / 0.08)', fontSize: 10, lineHeight: 1.4 }}>{children}</span>
);

/** WorkbenchAppIcon 的 IllustratedTile：64 视框里 62 见方的白→#eef1f5 渐变底（rx 14.3、0.5 描边）+ 居中 46 见方的插画 */
const TileIcon = ({ src, size }: { src: string; size: number }) => (
  <span
    style={{
      position: 'relative',
      width: size,
      height: size,
      flex: '0 0 auto',
      display: 'inline-flex',
      filter: 'drop-shadow(0 2px 3px rgba(33,43,54,0.12))',
    }}
  >
    <span
      style={{
        position: 'absolute',
        inset: size / 64,
        borderRadius: (size * 14.3) / 64,
        background: 'linear-gradient(180deg, #ffffff, #eef1f5)',
        boxShadow: 'inset 0 0 0 0.5px rgba(31, 41, 55, 0.14)',
      }}
    />
    <img src={src} style={{ position: 'absolute', left: (size * 9) / 64, top: (size * 9) / 64, width: (size * 46) / 64, height: (size * 46) / 64, objectFit: 'contain' }} />
  </span>
);

export type AppsPanelState = {
  /** 开合进度 0–1（200ms 淡入 + 上移 10px + 0.97→1） */
  k: number;
  query: string;
  /** 搜索态面板高度过渡 0–1 */
  searchK: number;
  /** Enter 按下的高亮 */
  press: number;
};

export const AppsPanel = ({ tk, s }: { tk: Tokens; s: AppsPanelState }) => {
  if (s.k <= 0.001) return null;
  const g = glassOf(tk, true);
  const h = AP_H_GRID + (AP_H_SEARCH - AP_H_GRID) * ease.inOutCubic(s.searchK);
  const searching = s.query.length > 0;
  return (
    <div
      style={{
        position: 'absolute',
        left: 960 - AP_W / 2,
        top: AP_CY - h / 2,
        width: AP_W,
        height: h,
        boxSizing: 'border-box',
        borderRadius: 18,
        overflow: 'hidden',
        backgroundColor: tk.dark ? 'hsl(0 0% 12% / 0.62)' : 'hsl(0 0% 99% / 0.62)',
        backgroundImage: g.sheen,
        backdropFilter: g.blur,
        border: `1px solid ${g.border}`,
        boxShadow: `inset 0 1px 0 ${g.highlight}, 0 32px 96px hsl(0 0% 0% / 0.30)`,
        color: tk.foreground,
        fontFamily: font.ui,
        opacity: s.k,
        transform: `translateY(${(1 - s.k) * 10}px) scale(${0.97 + 0.03 * s.k})`,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '14px 16px 10px' }}>
        <span style={{ fontSize: 15, fontWeight: 600, flex: 1 }}>{S.appsPanel.title}</span>
        {!searching ? (
          <span style={{ display: 'flex', gap: 2, padding: 2, borderRadius: 9, background: 'hsl(220 6% 42% / 0.1)' }}>
            <span style={{ width: 28, height: 24, borderRadius: 7, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'hsl(0 0% 100% / 0.8)', boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.35)' }}>
              <GridFour size={16} weight="bold" />
            </span>
            <span style={{ width: 28, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.mutedFg }}>
              <List size={16} weight="bold" />
            </span>
          </span>
        ) : null}
        <span style={{ width: 24, height: 24, borderRadius: '50%', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: 'hsl(220 6% 42% / 0.12)', color: tk.mutedFg }}>
          <svg viewBox="0 0 12 12" width={10} height={10}>
            <path d="M2 2 L10 10 M10 2 L2 10" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" />
          </svg>
        </span>
      </div>
      <div
        style={{
          position: 'relative',
          margin: '0 16px 12px',
          padding: '8px 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          borderRadius: 10,
          border: `1px solid ${PRI.replace(')', ' / 0.65)')}`,
          boxShadow: '0 0 0 2px hsl(215 72% 42% / 0.14)',
          background: 'hsl(220 9% 18% / 0.05)',
        }}
      >
        <MagnifyingGlass size={16} style={{ opacity: 0.9 }} />
        <span style={{ fontSize: 14, lineHeight: 1.4, color: searching ? tk.foreground : mix(tk.mutedFg, 85) }}>
          {searching ? s.query : S.wb.appsSearch}
          {searching ? <span style={{ display: 'inline-block', width: 1.5, height: 17, marginLeft: 1, verticalAlign: -3, background: tk.foreground }} /> : null}
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: '4px 12px 16px', overflow: 'hidden' }}>
        {!searching ? (
          <div style={{ display: 'grid', gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`, gap: 6 }}>
            {GRID_APPS.map(([id, src], i) => (
              <div
                key={id}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  gap: 8,
                  padding: '14px 8px 12px',
                  borderRadius: 12,
                  // 打开时 activeIndex = 0：第一项是键盘选中态（底色 + 内缘 1px primary/32 光圈）
                  ...(i === 0 ? { background: 'hsl(220 6% 42% / 0.14)', boxShadow: `inset 0 0 0 1px ${PRI.replace(')', ' / 0.32)')}` } : null),
                }}
              >
                <TileIcon src={src} size={56} />
                <span style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.35, whiteSpace: 'nowrap' }}>{id === 'chat' ? S.apps.chat : S.appsPanel.app(id)}</span>
              </div>
            ))}
          </div>
        ) : (
          <>
            <div style={{ padding: '6px 10px 6px', fontSize: 11, fontWeight: 600, color: tk.mutedFg }}>{S.appsPanel.sectionApps}</div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 10px',
                borderRadius: 12,
                background: `hsl(220 6% 42% / ${0.14 + 0.06 * s.press})`,
                boxShadow: `inset 0 0 0 1px ${PRI.replace(')', ' / 0.32)')}`,
                transform: `scale(${1 - 0.03 * s.press})`,
              }}
            >
              <TileIcon src={mediaIcon} size={36} />
              <span style={{ fontSize: 13, fontWeight: 500 }}>{S.media.app}</span>
            </div>
          </>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '8px 16px 12px', fontSize: 11, opacity: 0.6, borderTop: '1px solid hsl(0 0% 88% / 0.32)' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Kbd>↑↓←→</Kbd>
          {S.appsPanel.select}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Kbd>Enter</Kbd>
          {S.appsPanel.open}
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <Kbd>Esc</Kbd>
          {S.appsPanel.close}
        </span>
      </div>
    </div>
  );
};

// ── 库页 ───────────────────────────────────────────────────
const PADX = 35;
const LIST_Y = 122;
const ROW_H = 61;
const ROW_PITCH = 68;
/** 库页点击目标（内容坐标） */
export const LIB_PT = {
  bili: { x: 912.5, y: 28 },
  row: (i: number) => ({ x: 330, y: LIST_Y + i * ROW_PITCH + ROW_H / 2 }),
};

type LibRow = {
  name: string;
  meta: string;
  kind: 'audio' | 'video' | 'link';
  chip: 'completed' | 'imported' | 'none';
  ratio?: number;
  /** 看完：名称后 CheckCircle，缩略图不画进度 */
  finished?: boolean;
};
const OLD_ROWS: LibRow[] = [
  { name: '概率论 第 7 讲 课堂录音', meta: '1:32:10 · 前天看过', kind: 'audio', chip: 'completed', ratio: 0.42 },
  { name: '有机化学 亲核取代反应演示', meta: '18:24 · 未开始', kind: 'video', chip: 'none' },
  { name: '英语听力 Unit 5 精讲', meta: '46:05 · 5天前看过', kind: 'audio', chip: 'completed', finished: true },
];
const NEW_ROWS: LibRow[] = COURSE.pages.map((p, i) => ({ name: pageName(i), meta: `${p.dur} · ${S.media.notStarted}`, kind: 'link', chip: 'imported' }));

export type LibraryState = {
  /** 新导入的分 P 行入场 0–1 */
  imported: number;
  biliHover: number;
  biliPress: number;
  /** 悬停 / 按下的行（新行序号） */
  rowHover: number | null;
  rowPress: number;
};

const Chip = ({ tk, kind }: { tk: Tokens; kind: LibRow['chip'] }) => {
  const ok = kind !== 'none';
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        minHeight: 20,
        padding: '0 8px',
        borderRadius: 999,
        fontSize: 11,
        fontWeight: 500,
        lineHeight: 1,
        whiteSpace: 'nowrap',
        flex: '0 0 auto',
        color: ok ? SUCCESS : tk.mutedFg,
        background: ok ? `color-mix(in hsl, ${SUCCESS} 10%, ${tk.background})` : mix(tk.foreground, 8),
      }}
    >
      {S.media.status[kind]}
    </span>
  );
};

const Row = ({ tk, r, y, hover = 0, press = 0, opacity = 1 }: { tk: Tokens; r: LibRow; y: number; hover?: number; press?: number; opacity?: number }) => {
  const Icon = r.kind === 'link' ? Television : r.kind === 'audio' ? MusicNotes : FilmStrip;
  return (
    <Box
      x={PADX}
      y={y}
      w={CW - 2 * PADX}
      h={ROW_H}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10.5,
        padding: '0 10.5px',
        borderRadius: 14,
        border: `1px solid ${hover > 0 ? 'hsl(0 0% 84%)' : CARD_BORDER}`,
        background: hover > 0 ? `color-mix(in srgb, ${tk.foreground} ${2.5 * hover + 2 * press}%, ${tk.background})` : tk.background,
        boxShadow: '0 1px 2px hsl(220 20% 10% / 0.04)',
        opacity,
        transform: `scale(${1 - 0.006 * press})`,
      }}
    >
      <span style={{ position: 'relative', width: 86, height: 42, flex: '0 0 auto', borderRadius: 12, overflow: 'hidden', background: tk.muted, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.mutedFg }}>
        {r.kind === 'link' ? <Cover w={86} h={42} /> : <Icon size={20} weight="duotone" />}
        {r.kind === 'link' ? (
          <span style={{ position: 'absolute', left: 3.5, top: 3.5, padding: '0 3.5px', borderRadius: 3.5, fontSize: 10, fontWeight: 500, lineHeight: '14px', color: '#fff', background: 'rgb(0 0 0 / 0.55)' }}>{S.media.biliBadge}</span>
        ) : null}
        {r.ratio !== undefined && !r.finished ? (
          <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: 'rgb(0 0 0 / 0.25)' }}>
            <span style={{ display: 'block', width: `${r.ratio * 100}%`, height: '100%', background: tk.primary }} />
          </span>
        ) : null}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3.5, minWidth: 0, flex: 1 }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }}>
          <span style={{ fontSize: 12, fontWeight: 500, color: tk.foreground, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
          {r.finished ? <CheckCircle size={14} weight="fill" color={SUCCESS} style={{ flex: '0 0 auto' }} /> : null}
        </span>
        <span style={{ fontSize: 11, color: tk.mutedFg, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{r.meta}</span>
      </span>
      <Chip tk={tk} kind={r.chip} />
      <span style={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.mutedFg, flex: '0 0 auto' }}>
        <DotsThree size={18} weight="bold" />
      </span>
    </Box>
  );
};

export const MediaLibrary = ({ tk, s }: { tk: Tokens; s: LibraryState }) => {
  const done = s.imported > 0;
  const total = OLD_ROWS.length + (done ? NEW_ROWS.length : 0);
  const counts = { all: total, watching: 1, untranscribed: 1, transcribed: total - 1 - 0 };
  counts.transcribed = OLD_ROWS.filter((r) => r.chip !== 'none').length + (done ? NEW_ROWS.length : 0);
  // 新行从上方依次落位，旧行随之下移
  const shift = ROW_PITCH * NEW_ROWS.length * ease.brand(clamp(s.imported * 1.8));
  return (
    <div style={{ position: 'absolute', inset: 0, background: tk.background, fontFamily: font.ui, color: tk.foreground, overflow: 'hidden' }}>
      {/* 标题行 */}
      <Box x={PADX} y={14} h={28} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>{S.media.title}</span>
        <span style={{ color: mix(tk.mutedFg, 40), fontSize: 13 }}>/</span>
        <span style={{ fontSize: 11, color: tk.mutedFg, fontVariantNumeric: 'tabular-nums' }}>{S.media.count(total)}</span>
      </Box>
      <Box x={798.5} y={14} w={64} h={28} style={ghostBtn(tk, 0, 0)}>
        <CheckSquare size={14} />
        {S.media.select}
      </Box>
      <Box x={867.5} y={14} w={90} h={28} style={ghostBtn(tk, s.biliHover, s.biliPress)}>
        <Television size={14} />
        {S.media.bilibili}
      </Box>
      <Box x={963} y={14} w={100} h={28} style={primaryBtn(tk, 0, 0)}>
        <UploadSimple size={14} />
        {S.media.importBtn}
      </Box>
      <Box x={PADX} y={52.5} style={{ fontSize: 11, lineHeight: '17px', color: tk.mutedFg }}>
        {S.media.tagline}
      </Box>
      {/* 搜索 + 状态筛选 + 视图 */}
      <Box x={PADX} y={80} w={280} h={28} style={{ borderRadius: 9, background: tk.muted, display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 9, fontSize: 11, color: mix(tk.mutedFg, 70) }}>
        <MagnifyingGlass size={14} color={mix(tk.mutedFg, 50)} />
        {S.media.search}
      </Box>
      <Box x={PADX + 280 + 10.5} y={80} h={28} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        {(['all', 'watching', 'untranscribed', 'transcribed'] as const).map((f) => (
          <span
            key={f}
            style={{
              height: 26,
              padding: '0 8.75px',
              borderRadius: 10,
              display: 'inline-flex',
              alignItems: 'center',
              fontSize: 11,
              fontWeight: 500,
              color: f === 'all' ? tk.foreground : tk.mutedFg,
              background: f === 'all' ? tk.background : 'transparent',
              boxShadow: f === 'all' ? '0 0 0 1px hsl(0 0% 88%)' : undefined,
            }}
          >
            {S.media.filter[f]}
            <span style={{ marginLeft: 3.5, fontSize: 10, fontVariantNumeric: 'tabular-nums', opacity: f === 'all' ? 1 : 0.6 }}>{counts[f]}</span>
          </span>
        ))}
      </Box>
      <Box x={CW - PADX - 62} y={81} w={62} h={26} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <span style={{ width: 30, height: 26, borderRadius: 10, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', background: tk.background, boxShadow: '0 0 0 1px hsl(0 0% 88%)' }}>
          <ListBullets size={15} />
        </span>
        <span style={{ width: 30, height: 26, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.mutedFg }}>
          <Folders size={15} />
        </span>
      </Box>
      {/* 列表 */}
      {done
        ? NEW_ROWS.map((r, i) => {
            const k = ease.brand(clamp(s.imported * 1.8 - i * 0.1));
            return (
              <Row
                key={r.name}
                tk={tk}
                r={r}
                y={LIST_Y + i * ROW_PITCH - (1 - k) * 10}
                opacity={k}
                hover={s.rowHover === i ? 1 : 0}
                press={s.rowHover === i ? s.rowPress : 0}
              />
            );
          })
        : null}
      {OLD_ROWS.map((r, i) => (
        <Row key={r.name} tk={tk} r={r} y={LIST_Y + i * ROW_PITCH + shift} />
      ))}
    </div>
  );
};

// ── 从 B 站链接导入（DsDialog，屏幕居中） ─────────────────────────────
const DLG_W = 448;
const DLG_X = 960 - DLG_W / 2;
const D_HEAD = 91;
const D_FOOT = 56;
const D_BODY_INPUT = 107.5;
const D_PROBE = 341;
const D_BATCH = 40;
export type DialogStage = 'input' | 'parsing' | 'probe' | 'batch';
const dialogH = (stage: DialogStage) =>
  D_HEAD + D_BODY_INPUT + (stage === 'parsing' ? 31 : stage === 'probe' ? 14 + D_PROBE : stage === 'batch' ? 14 + D_PROBE + D_BATCH : 0) + D_FOOT;
const dialogTop = (stage: DialogStage) => 540 - dialogH(stage) / 2;
/** 弹窗点击目标（屏幕坐标） */
export const DLG_PT = {
  input: { x: DLG_X + 17.5 + 160, y: dialogTop('input') + D_HEAD + 14 + 34 + 14 + 15.75 },
  parse: { x: DLG_X + DLG_W - 17.5 - 23, y: dialogTop('input') + D_HEAD + 14 + 34 + 14 + 15.75 },
  confirm: { x: DLG_X + DLG_W - 17.5 - 52, y: dialogTop('probe') + dialogH('probe') - D_FOOT / 2 },
};

export type DialogState = {
  /** 开合 0–1 */
  k: number;
  stage: DialogStage;
  pasted: boolean;
  /** 弹窗高度在两档之间过渡：from → stage，0–1 */
  grow: number;
  from: DialogStage;
  /** 逐 P 进度：已完成数（可带小数） */
  batch: number;
  hover: 'parse' | 'confirm' | null;
  press: number;
  t: number;
};

export const BiliDialog = ({ tk, s }: { tk: Tokens; s: DialogState }) => {
  if (s.k <= 0.001) return null;
  const h = dialogH(s.from) + (dialogH(s.stage) - dialogH(s.from)) * ease.inOutCubic(s.grow);
  const top = 540 - h / 2;
  const probe = s.stage === 'probe' || s.stage === 'batch';
  const idx = Math.min(COURSE.pages.length, Math.floor(s.batch) + 1);
  const label = (txt: string, extra?: CSSProperties) => <span style={{ fontSize: 11, color: tk.mutedFg, ...extra }}>{txt}</span>;
  return (
    <>
      <div style={{ position: 'absolute', inset: 0, background: `rgb(0 0 0 / ${0.3 * s.k})`, backdropFilter: `blur(${2 * s.k}px)` }} />
      <div
        style={{
          position: 'absolute',
          left: DLG_X,
          top,
          width: DLG_W,
          height: h,
          boxSizing: 'border-box',
          borderRadius: 22,
          border: '1px solid hsl(0 0% 88% / 0.8)',
          background: tk.background,
          boxShadow: '0 18px 36px hsl(0 0% 0% / 0.12), 0 2px 8px hsl(0 0% 0% / 0.06)',
          overflow: 'hidden',
          fontFamily: font.ui,
          color: tk.foreground,
          opacity: s.k,
          transform: `translateY(${(1 - s.k) * 8}px) scale(${0.96 + 0.04 * s.k})`,
        }}
      >
        <div style={{ padding: '17.5px 17.5px 10.5px' }}>
          <div style={{ fontSize: 14, fontWeight: 600, lineHeight: '17.5px' }}>{S.media.dlg.title}</div>
          <div style={{ marginTop: 3.5, fontSize: 13, lineHeight: '21px', color: tk.mutedFg }}>{S.media.dlg.desc}</div>
        </div>
        <div style={{ padding: '14px 17.5px', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div style={{ height: 34, boxSizing: 'border-box', display: 'flex', alignItems: 'center', gap: 7, padding: '0 10.5px', borderRadius: 12, background: tk.muted, fontSize: 11 }}>
            <UserCircle size={20} color={tk.mutedFg} />
            <span style={{ flex: 1, color: tk.mutedFg }}>{S.media.dlg.account}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, height: 24.5, padding: '0 7px', fontSize: 11, fontWeight: 500 }}>
              <QrCode size={13} />
              {S.media.dlg.login}
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 7, height: 31.5 }}>
            <span
              style={{
                flex: 1,
                height: 31.5,
                boxSizing: 'border-box',
                borderRadius: 9,
                border: `1px solid ${s.pasted && !probe ? mix(tk.primary, 60) : tk.border}`,
                boxShadow: s.pasted && !probe ? `0 0 0 2px ${mix(tk.primary, 14)}` : undefined,
                padding: '0 10.5px',
                display: 'flex',
                alignItems: 'center',
                fontSize: 12,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                color: s.pasted ? tk.foreground : mix(tk.mutedFg, 80),
              }}
            >
              {s.pasted ? COURSE.link : S.media.dlg.placeholder}
            </span>
            <span style={{ ...ghostBtn(tk, s.hover === 'parse' ? 1 : 0, s.hover === 'parse' ? s.press : 0), height: 28, padding: '0 10.5px', opacity: s.pasted ? 1 : 0.5 }}>
              {s.stage === 'parsing' ? <Spin size={14} color={tk.mutedFg} t={s.t} /> : null}
              {S.media.dlg.parse}
            </span>
          </div>
          {s.stage === 'parsing' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: 11, color: tk.mutedFg, height: 17 }}>
              <Spin size={14} color={tk.mutedFg} t={s.t} />
              {S.media.dlg.parsing}
            </div>
          ) : null}
          {probe ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10.5, opacity: s.stage === 'probe' ? clamp((s.grow - 0.55) / 0.45) : 1 }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10.5, height: 54 }}>
                <span style={{ position: 'relative', width: 96, height: 54, borderRadius: 7, overflow: 'hidden', flex: '0 0 auto' }}>
                  <Cover w={96} h={54} />
                </span>
                <span style={{ display: 'flex', flexDirection: 'column', gap: 3.5, minWidth: 0 }}>
                  <span style={{ fontSize: 12, fontWeight: 500, lineHeight: '17px' }}>{COURSE.title}</span>
                  <span style={{ fontSize: 11, color: tk.mutedFg }}>
                    {COURSE.owner} · {S.media.dlg.pageCount(COURSE.pages.length)}
                  </span>
                </span>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5.25 }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', height: 24.5 }}>
                  {label(S.media.dlg.pages(COURSE.pages.length, COURSE.pages.length))}
                  <span style={{ display: 'flex', gap: 3.5, fontSize: 11, fontWeight: 500 }}>
                    <span style={{ padding: '0 7px' }}>{S.media.dlg.selectAll}</span>
                    <span style={{ padding: '0 7px' }}>{S.media.dlg.selectNone}</span>
                  </span>
                </div>
                <div style={{ border: `1px solid ${tk.border}`, borderRadius: 7, overflow: 'hidden' }}>
                  {COURSE.pages.map((p, i) => (
                    <div key={p.part} style={{ height: 28, display: 'flex', alignItems: 'center', gap: 7, padding: '0 8.75px', fontSize: 12 }}>
                      <Check on tk={tk} />
                      <span style={{ fontSize: 11, color: tk.mutedFg, fontVariantNumeric: 'tabular-nums' }}>P{i + 1}</span>
                      <span style={{ flex: 1 }}>{p.part}</span>
                      <span style={{ fontSize: 11, color: tk.mutedFg, fontVariantNumeric: 'tabular-nums' }}>{p.dur}</span>
                    </div>
                  ))}
                </div>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 5.25 }}>
                {label(S.media.dlg.track)}
                <span style={{ height: 31.5, boxSizing: 'border-box', borderRadius: 9, border: `1px solid ${tk.border}`, padding: '0 10.5px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', fontSize: 12 }}>
                  {COURSE.track}
                  <CaretDown size={13} color={tk.mutedFg} />
                </span>
                {label(S.media.dlg.batchHint, { lineHeight: '18px' })}
              </div>
            </div>
          ) : null}
          {s.stage === 'batch' ? (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 5.25 }}>
              <span style={{ fontSize: 11, color: tk.mutedFg, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                {S.media.dlg.progress(idx, COURSE.pages.length, idx, COURSE.pages[idx - 1].part)}
              </span>
              <span style={{ height: 3.5, borderRadius: 999, background: tk.muted, overflow: 'hidden' }}>
                <span style={{ display: 'block', height: '100%', width: `${((idx - 1) / COURSE.pages.length) * 100}%`, background: tk.primary, borderRadius: 999 }} />
              </span>
            </div>
          ) : null}
        </div>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: D_FOOT, display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 7, padding: '0 17.5px' }}>
          <span style={{ ...ghostBtn(tk, 0, 0), height: 28, padding: '0 10.5px' }}>{s.stage === 'batch' ? S.media.dlg.stop : S.media.dlg.cancel}</span>
          <span
            style={{
              ...primaryBtn(tk, s.hover === 'confirm' ? 1 : 0, s.hover === 'confirm' ? s.press : 0),
              height: 28,
              padding: '0 10.5px',
              opacity: probe ? 1 : 0.5,
              transform: `scale(${1 - 0.03 * (s.hover === 'confirm' ? s.press : 0)})`,
            }}
          >
            {s.stage === 'batch' ? <Spin size={14} color={tk.primary} t={s.t} /> : null}
            {S.media.dlg.confirm(COURSE.pages.length)}
          </span>
        </div>
      </div>
    </>
  );
};

// ── 学习页 ─────────────────────────────────────────────────
const PANEL_W = 380;
const PLAYER_W = CW - PANEL_W;
const BODY_Y = 77;
const BODY_H = CH - BODY_Y;
const VIDEO_H = (PLAYER_W * 9) / 16;
const VIDEO_Y = BODY_Y + (BODY_H - VIDEO_H) / 2;
const SEG_Y0 = BODY_Y + 112;
const SEG_PITCH = 29.75;
/** 伴随分区（MediaStudyView：SegmentedControl compact stretch，px-3 pt-2 pb-1）：字幕 / 讲义 / 问答 / 练习 */
export type StudyTab = 'transcript' | 'handout' | 'ask' | 'practice';
const TABS: StudyTab[] = ['transcript', 'handout', 'ask', 'practice'];
const TAB_W = (PANEL_W - 21 - 6) / 4;
const tabX = (i: number) => 10.5 + i * (TAB_W + 2);
/** 分区内容区顶（分段控件之下） */
const TAB_TOP = 38.5;
const PAD = 10.5;
/** 对话层（网页演示 companion.ts 的 panelFor）：头部 border-b px-3 py-2，正文 px-3 py-3 gap-3，底部输入行 border-t px-3 py-2 */
const LAYER_HEAD = 35;
const LAYER_BODY = TAB_TOP + LAYER_HEAD;
const COMPOSER_H = 43;
/** 问答首屏：说明 2 行 → 「就这门课提问」 */
const ASK_START = { x: PAD, y: 91.75, w: 112, h: 28 };
/** 讲义：说明 2 行 →「生成讲义」/ 生成中状态条；「本课讲义」列表第一项 */
const HO_GEN = { x: PAD, y: 91.75, w: 92, h: 28 };
const HO_ITEM = { x: PAD, y: 172, w: PANEL_W - 2 * PAD, h: 50 };
/** 练习：说明 2 行 → 两个动作卡（制作闪卡 / 生成练习题） */
const PR_CARD = (i: number) => ({ x: PAD, y: 91.75 + i * 61.5, w: PANEL_W - 2 * PAD, h: 54.5 });
const SEND_W = 43;
/** 学习页点击目标（内容坐标） */
export const STUDY_PT = {
  play: { x: PLAYER_W / 2, y: VIDEO_Y + VIDEO_H / 2 },
  seg: (i: number) => ({ x: PLAYER_W + 150, y: SEG_Y0 + i * SEG_PITCH + 14 }),
  tab: (id: StudyTab) => ({ x: PLAYER_W + tabX(TABS.indexOf(id)) + TAB_W / 2, y: BODY_Y + 7 + 14 }),
  askStart: { x: PLAYER_W + ASK_START.x + ASK_START.w / 2, y: BODY_Y + ASK_START.y + ASK_START.h / 2 },
  composer: { x: PLAYER_W + PAD + 120, y: BODY_Y + BODY_H - COMPOSER_H / 2 },
  send: { x: PLAYER_W + PANEL_W - PAD - SEND_W / 2, y: BODY_Y + BODY_H - COMPOSER_H / 2 },
  handoutGen: { x: PLAYER_W + HO_GEN.x + HO_GEN.w / 2, y: BODY_Y + HO_GEN.y + HO_GEN.h / 2 },
  handoutItem: { x: PLAYER_W + HO_ITEM.x + 120, y: BODY_Y + HO_ITEM.y + HO_ITEM.h / 2 },
  practiceCards: { x: PLAYER_W + PR_CARD(0).x + 120, y: BODY_Y + PR_CARD(0).y + PR_CARD(0).h / 2 },
};

// ── 问答剧本（P4；回答基于字幕，时间引用对应 SEGMENTS 里的原句） ─────────────
export const ASK_QUESTION = '为什么特征值互不相同就能对角化？';
/** 回答片段：文字 / 时间引用（05:20「依据是：属于不同特征值的特征向量线性无关。」、06:22「举个最简单的反例：单位矩阵 E。」） */
const ANSWER: Array<string | { t: number }> = [
  '属于不同特征值的特征向量线性无关。n 个特征值互不相同时，每个各取一个特征向量，正好凑够 n 个线性无关的特征向量，由定理 5.6 即可对角化',
  { t: 320 },
  '。\n\n注意这只是充分条件：单位矩阵 E 只有特征值 1，却本身就是对角阵',
  { t: 382 },
  '。',
];
/** 回答总长（引用算 1 个字符，整块出现） */
export const ANSWER_LEN = ANSWER.reduce<number>((n, p) => n + (typeof p === 'string' ? [...p].length : 1), 0);
/** 片中点的那个引用（第一个，05:20） */
export const ASK_SEEK_TO = 320;
/** 回答里第一个引用的位置（内容坐标）：按 1 倍渲染的整帧取证定位（回答流完后「▶ 05:20」的中心） */
export const ASK_CHIP_PT = { x: PLAYER_W + 198, y: BODY_Y + 256 };

/** 练习：制作闪卡（与网页演示 companion.ts 的 P4_CARDS 同文） */
const CARDS: Array<{ front: string; back: string; t: number }> = [
  { front: 'n 阶矩阵 A 可相似对角化的充要条件？', back: 'A 有 n 个线性无关的特征向量（定理 5.6）', t: 37 },
  { front: '对角化时 P 与 Λ 的对应关系？', back: 'P 的第 i 列是属于 Λ 第 i 个对角元 λᵢ 的特征向量，顺序必须一致', t: 95 },
  { front: '「n 个特征值互不相同」与可对角化的关系？', back: '充分不必要：互不相同 ⇒ 可对角化；反例：单位矩阵 E', t: 365 },
  { front: '特征值 λ 的几何重数怎么算？', back: 'dim V_λ = n − r(λE − A)，且 1 ≤ 几何重数 ≤ 代数重数', t: 606 },
];
export const CARD_COUNT = CARDS.length;

/** 讲义生成的阶段（learningHub.mediaHandout.phase），撰写章节按 4 节计数 */
export const HANDOUT_PHASES: Array<[label: string, at: number]> = [
  ['transcript', 0],
  ['frames', 0.14],
  ['outline', 0.3],
  ['writing:1', 0.44],
  ['writing:2', 0.56],
  ['writing:3', 0.68],
  ['writing:4', 0.8],
  ['saving', 0.92],
];
export const HANDOUT_TITLE = '对角化的条件 · 讲义';

export type StudyState = {
  /** 进入学习页的淡入 0–1 */
  enter: number;
  /** 当前播放位置（秒） */
  pos: number;
  playing: boolean;
  /** 控制条显隐 0–1（指针在播放器上时显示） */
  controls: number;
  playHover: number;
  playPress: number;
  /** 跳转后画面切换 0–1 */
  seekFlash: number;
  t: number;
  tab: StudyTab;
  tabHover: StudyTab | null;
  tabPress: number;
  /** 问答：对话层入场 0–1（0 = 分区首屏） */
  askLayer: number;
  askStartHover: number;
  askStartPress: number;
  /** 输入框里已打的字；focus = 输入框聚焦 */
  typed: string;
  composerFocus: boolean;
  sendPress: number;
  /** 已发出：用户气泡 0–1 */
  sent: number;
  thinking: boolean;
  /** 回答已流出的字符数（0 = 未开始） */
  answer: number;
  chipHover: number;
  chipPress: number;
  /** 讲义：生成阶段（null = 未开始 / 已完成）；done = 列表里有新讲义（入场 0–1） */
  phase: string | null;
  genHover: number;
  genPress: number;
  handoutK: number;
  itemHover: number;
  itemPress: number;
  /** 练习：动作卡悬停 / 按下；对话层入场；卡片逐张入场（已出现张数，可带小数） */
  pcHover: number;
  pcPress: number;
  practiceLayer: number;
  cards: number;
  /** 学习进度（练习分区底部）：已观看分钟 */
  watchedMin: number;
};

/** 讲义幻灯片（视频画面）：标题页（00:00–00:33）/ 定理 5.6（00:33–05:00）/ 推论 5.7（05:00 起），以 0,0 为原点画 PLAYER_W × VIDEO_H */
export const LectureSlide = ({ pos }: { pos: number }) => {
  const W = PLAYER_W;
  const H = VIDEO_H;
  const page = pos >= 300 ? 'corollary' : pos >= 33 ? 'theorem' : 'title';
  const head = (
    <>
      <div style={{ position: 'absolute', left: 42, top: 34, fontSize: 22, fontWeight: 700 }}>5.4　对角化的条件</div>
      <div style={{ position: 'absolute', left: 42, top: 74, width: 160, height: 3, background: 'hsl(38 90% 55%)' }} />
    </>
  );
  const boxStyle: CSSProperties = { position: 'absolute', left: 42, top: 100, right: 42, padding: '16px 20px', borderRadius: 8, background: 'hsl(212 60% 94%)', borderLeft: '5px solid hsl(212 52% 32%)' };
  return (
    <div style={{ position: 'absolute', left: 0, top: 0, width: W, height: H, overflow: 'hidden', background: 'hsl(40 30% 97%)', fontFamily: font.ui, color: 'hsl(215 40% 18%)' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: 6, background: 'linear-gradient(90deg, hsl(212 52% 26%), hsl(205 56% 38%))' }} />
      <div style={{ position: 'absolute', right: 26, bottom: 18, fontSize: 11, color: 'hsl(215 20% 50%)', letterSpacing: '0.04em' }}>线性代数 · 第五讲</div>
      {page === 'theorem' ? (
        <>
          {head}
          <div style={boxStyle}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'hsl(212 52% 30%)' }}>定理 5.6</div>
            <div style={{ marginTop: 8, fontSize: 17, lineHeight: 1.6, fontFamily: font.serif }}>
              <Tex tex="n" /> 阶矩阵 <Tex tex="A" /> 可对角化 <Tex tex="\iff" /> <Tex tex="A" /> 有 <Tex tex="n" /> 个线性无关的特征向量
            </div>
          </div>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 196, textAlign: 'center', fontSize: 16 }}>
            <Tex tex="P^{-1}AP=\Lambda=\begin{pmatrix}\lambda_1&&\\&\ddots&\\&&\lambda_n\end{pmatrix}" display />
          </div>
        </>
      ) : page === 'corollary' ? (
        <>
          {head}
          <div style={boxStyle}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'hsl(212 52% 30%)' }}>推论 5.7</div>
            <div style={{ marginTop: 8, fontSize: 17, lineHeight: 1.6, fontFamily: font.serif }}>
              <Tex tex="n" /> 阶矩阵 <Tex tex="A" /> 有 <Tex tex="n" /> 个互不相同的特征值 <Tex tex="\Rightarrow" /> <Tex tex="A" /> 可对角化
            </div>
          </div>
          <div style={{ position: 'absolute', left: 48, top: 214, fontSize: 15, lineHeight: 1.9, fontFamily: font.serif, color: 'hsl(215 30% 26%)' }}>
            <div>依据：属于不同特征值的特征向量线性无关</div>
            <div>
              注：只是充分条件——反例 <Tex tex="E" />，只有特征值 <Tex tex="1" />，本身就是对角阵
            </div>
          </div>
        </>
      ) : (
        <>
          <div style={{ position: 'absolute', left: 52, top: 110, fontSize: 13, letterSpacing: '0.3em', color: 'hsl(205 50% 40%)', fontWeight: 600 }}>LINEAR ALGEBRA</div>
          <div style={{ position: 'absolute', left: 50, top: 138, fontSize: 36, fontWeight: 700, fontFamily: font.serif, letterSpacing: '0.04em' }}>第五讲　特征值与对角化</div>
          <div style={{ position: 'absolute', left: 52, top: 200, width: 220, height: 3, background: 'hsl(38 90% 55%)' }} />
          <div style={{ position: 'absolute', left: 52, top: 222, fontSize: 18, color: 'hsl(215 25% 35%)' }}>5.4　对角化的条件</div>
          <div style={{ position: 'absolute', right: 44, top: 34, fontSize: 48, color: 'hsl(212 40% 87%)', fontFamily: 'KaTeX_Math, serif', fontStyle: 'italic' }}>Ax=λx</div>
        </>
      )}
    </div>
  );
};
export const SLIDE_W = PLAYER_W;
export const SLIDE_H = VIDEO_H;

/** 媒体时间引用（网页演示 citationChip：rounded-full bg-primary/10 px-1.5 text-[11px] tabular-nums） */
const Cite = ({ tk, sec, hover = 0, press = 0 }: { tk: Tokens; sec: number; hover?: number; press?: number }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      height: 17.5,
      margin: '0 1.75px',
      padding: '0 5.25px',
      borderRadius: 999,
      verticalAlign: 1,
      fontSize: 11,
      fontWeight: 500,
      lineHeight: 1,
      fontVariantNumeric: 'tabular-nums',
      color: tk.primary,
      background: mix(tk.primary, 10 + 10 * hover + 6 * press),
      transform: `scale(${1 - 0.04 * press})`,
      whiteSpace: 'nowrap',
    }}
  >
    ▶ {clockOf(sec)}
  </span>
);

/** study-shell-secondary-card：surface-panel-strong 底、工作区描边、shell-panel 圆角、柔阴影；悬停换导航描边 */
const secondaryCard = (tk: Tokens, hover = 0, press = 0): CSSProperties => ({
  position: 'absolute',
  boxSizing: 'border-box',
  borderRadius: 12,
  border: `1px solid ${hover > 0 ? 'hsl(0 0% 84%)' : CARD_BORDER}`,
  background: hover > 0 ? `color-mix(in srgb, ${tk.foreground} ${2.5 * hover + 2 * press}%, ${tk.background})` : tk.background,
  boxShadow: '0 1px 2px hsl(220 20% 10% / 0.04)',
  transform: `scale(${1 - 0.008 * press})`,
});

const xsMuted = (tk: Tokens, extra?: CSSProperties): CSSProperties => ({ fontSize: 11, lineHeight: '17.9px', color: tk.mutedFg, ...extra });
const sectionTitle = (tk: Tokens, y: number, text: string) => <div style={{ position: 'absolute', left: PAD, top: y, fontSize: 11, fontWeight: 500, lineHeight: '16.5px', color: tk.mutedFg }}>{text}</div>;

/** 分区里的对话层头部（← 返回 + 标题） */
const LayerHead = ({ tk, title }: { tk: Tokens; title: string }) => (
  <div style={{ position: 'absolute', left: 0, right: 0, top: TAB_TOP, height: LAYER_HEAD, boxSizing: 'border-box', borderBottom: `1px solid ${tk.border}`, display: 'flex', alignItems: 'center', gap: 7, padding: '0 10.5px' }}>
    <span style={{ padding: '1.75px 5.25px', borderRadius: 4, fontSize: 11, color: tk.mutedFg }}>{S.media.layer.back}</span>
    <span style={{ fontSize: 11, fontWeight: 500, color: tk.foreground, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{title}</span>
  </div>
);

const AskTab = ({ tk, s }: { tk: Tokens; s: StudyState }) => {
  const layer = s.askLayer;
  // 回答按字符流出（引用整块出现）
  let left = s.answer;
  const pieces: ReactNode[] = [];
  ANSWER.forEach((p, i) => {
    if (left <= 0) return;
    if (typeof p === 'string') {
      const chars = [...p];
      pieces.push(<span key={i}>{chars.slice(0, Math.min(chars.length, Math.floor(left))).join('')}</span>);
      left -= chars.length;
    } else {
      pieces.push(<Cite key={i} tk={tk} sec={p.t} hover={p.t === ASK_SEEK_TO ? s.chipHover : 0} press={p.t === ASK_SEEK_TO ? s.chipPress : 0} />);
      left -= 1;
    }
  });
  const bubbleText: CSSProperties = { fontSize: 13, lineHeight: '21.1px', whiteSpace: 'pre-wrap' };
  return (
    <>
      {layer < 1 ? (
        <div style={{ position: 'absolute', inset: 0, opacity: 1 - layer }}>
          <div style={{ position: 'absolute', left: PAD, top: 49, width: PANEL_W - 2 * PAD, ...xsMuted(tk) }}>{S.media.ask.intro}</div>
          <span
            style={{
              ...primaryBtn(tk, s.askStartHover, s.askStartPress),
              position: 'absolute',
              left: ASK_START.x,
              top: ASK_START.y,
              width: ASK_START.w,
              height: ASK_START.h,
              transform: `scale(${1 - 0.03 * s.askStartPress})`,
            }}
          >
            <ChatCircleText size={14} />
            {S.media.ask.start}
          </span>
          {sectionTitle(tk, 140.75, S.media.ask.quickTitle)}
          {S.media.ask.quick.map((q, i) => (
            <div key={q} style={{ ...secondaryCard(tk), left: PAD, top: 164.25 + i * 40.5, width: PANEL_W - 2 * PAD, height: 33.5, display: 'flex', alignItems: 'center', gap: 7, padding: '0 10.5px', fontSize: 12, color: tk.foreground }}>
              <Sparkle size={14} color={tk.mutedFg} />
              {q}
            </div>
          ))}
        </div>
      ) : null}
      {layer > 0 ? (
        <div style={{ position: 'absolute', inset: 0, opacity: layer }}>
          <LayerHead tk={tk} title={S.media.layer.askTitle} />
          <div style={{ position: 'absolute', left: PAD, right: PAD, top: LAYER_BODY + PAD, display: 'flex', flexDirection: 'column', gap: 10.5 }}>
            <div style={{ ...bubbleText, color: tk.foreground }}>{S.media.layer.askHello(pageName(STUDY_PAGE))}</div>
            {s.sent > 0 ? (
              <div
                style={{
                  ...bubbleText,
                  alignSelf: 'flex-end',
                  maxWidth: '88%',
                  padding: '7px 10.5px',
                  borderRadius: '16px 16px 6px 16px',
                  background: tk.primary,
                  color: tk.primaryFg,
                  opacity: s.sent,
                  transform: `translateY(${(1 - s.sent) * 6}px)`,
                }}
              >
                {ASK_QUESTION}
              </div>
            ) : null}
            {s.thinking ? <div style={xsMuted(tk)}>{S.media.layer.thinking}</div> : null}
            {s.answer > 0 ? <div style={{ ...bubbleText, color: tk.foreground }}>{pieces}</div> : null}
          </div>
          {/* 输入行 */}
          <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: COMPOSER_H, boxSizing: 'border-box', borderTop: `1px solid ${tk.border}`, display: 'flex', alignItems: 'center', gap: 7, padding: '0 10.5px' }}>
            <span
              style={{
                flex: 1,
                height: 28,
                boxSizing: 'border-box',
                borderRadius: 6,
                border: `1px solid ${s.composerFocus ? tk.primary : tk.border}`,
                background: tk.background,
                display: 'flex',
                alignItems: 'center',
                padding: '0 8.75px',
                fontSize: 13,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                color: s.typed ? tk.foreground : mix(tk.mutedFg, 80),
              }}
            >
              {s.typed || S.media.layer.placeholder}
              {s.composerFocus && s.typed ? <span style={{ display: 'inline-block', width: 1.5, height: 15, marginLeft: 1, background: tk.foreground }} /> : null}
            </span>
            <span style={{ width: SEND_W, height: 28, borderRadius: 6, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: 500, background: tk.primary, color: tk.primaryFg, transform: `scale(${1 - 0.05 * s.sendPress})`, filter: s.sendPress > 0 ? `brightness(${1 - 0.12 * s.sendPress})` : undefined }}>
              {S.media.layer.send}
            </span>
          </div>
        </div>
      ) : null}
    </>
  );
};

const phaseLabel = (phase: string) => {
  const [key, n] = phase.split(':');
  return `${S.media.handout.phase(key)}${n ? ` ${n}/4` : ''}`;
};

const HandoutTab = ({ tk, s }: { tk: Tokens; s: StudyState }) => (
  <>
    <div style={{ position: 'absolute', left: PAD, top: 49, width: PANEL_W - 2 * PAD, ...xsMuted(tk) }}>{S.media.handout.intro}</div>
    {s.phase ? (
      <div style={{ ...secondaryCard(tk), left: PAD, top: HO_GEN.y - 3.5, width: PANEL_W - 2 * PAD, height: 35, display: 'flex', alignItems: 'center', gap: 7, padding: '0 3.5px 0 10.5px', fontSize: 11, color: tk.mutedFg }}>
        <Spin size={14} color={tk.primary} t={s.t} />
        <span style={{ flex: 1, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{phaseLabel(s.phase)}</span>
        <span style={{ width: 24.5, height: 24.5, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
          <X size={13} />
        </span>
      </div>
    ) : (
      <span
        style={{
          ...primaryBtn(tk, s.genHover, s.genPress),
          position: 'absolute',
          left: HO_GEN.x,
          top: HO_GEN.y,
          width: HO_GEN.w,
          height: HO_GEN.h,
          transform: `scale(${1 - 0.03 * s.genPress})`,
        }}
      >
        <Notebook size={14} />
        {S.media.handout.generate}
      </span>
    )}
    {sectionTitle(tk, 141, S.media.handout.listTitle)}
    {s.handoutK > 0 ? (
      <div
        style={{
          ...secondaryCard(tk, s.itemHover, s.itemPress),
          left: HO_ITEM.x,
          top: HO_ITEM.y,
          width: HO_ITEM.w,
          height: HO_ITEM.h,
          display: 'flex',
          alignItems: 'center',
          gap: 8.75,
          padding: '0 10.5px',
          opacity: s.handoutK,
        }}
      >
        <Notebook size={16} color={tk.mutedFg} />
        <span style={{ display: 'flex', flexDirection: 'column' }}>
          <span style={{ fontSize: 12, lineHeight: '17.5px', color: tk.foreground }}>{HANDOUT_TITLE}</span>
          <span style={{ fontSize: 11, lineHeight: '16.5px', color: tk.mutedFg }}>{S.media.handout.justNow}</span>
        </span>
      </div>
    ) : (
      <div style={{ position: 'absolute', left: PAD, top: 164.5, ...xsMuted(tk) }}>{S.media.handout.empty}</div>
    )}
    <div style={{ position: 'absolute', left: PAD, top: s.handoutK > 0 ? 229 : 192.5, ...xsMuted(tk, { color: mix(tk.mutedFg, 80) }) }}>{S.media.handout.wordHint}</div>
  </>
);

const PracticeTab = ({ tk, s }: { tk: Tokens; s: StudyState }) => {
  const layer = s.practiceLayer;
  const actions = [
    { Icon: CardsThree, label: S.media.practice.cards, hint: S.media.practice.cardsHint },
    { Icon: ListChecks, label: S.media.practice.questions, hint: S.media.practice.questionsHint },
  ];
  const posSec = Math.floor(s.pos);
  return (
    <>
      {layer < 1 ? (
        <div style={{ position: 'absolute', inset: 0, opacity: 1 - layer }}>
          <div style={{ position: 'absolute', left: PAD, top: 49, width: PANEL_W - 2 * PAD, ...xsMuted(tk) }}>{S.media.practice.intro}</div>
          {actions.map(({ Icon, label, hint }, i) => {
            const r = PR_CARD(i);
            return (
              <div key={label} style={{ ...secondaryCard(tk, i === 0 ? s.pcHover : 0, i === 0 ? s.pcPress : 0), left: r.x, top: r.y, width: r.w, height: r.h, display: 'flex', alignItems: 'center', gap: 7, padding: '0 10.5px' }}>
                <Icon size={16} color={tk.mutedFg} />
                <span style={{ display: 'flex', flexDirection: 'column' }}>
                  <span style={{ fontSize: 12, lineHeight: '18px', color: tk.foreground }}>{label}</span>
                  <span style={{ fontSize: 11, lineHeight: '17px', color: tk.mutedFg }}>{hint}</span>
                </span>
              </div>
            );
          })}
          {sectionTitle(tk, 237, S.media.progress.title)}
          <div style={{ position: 'absolute', left: PAD, top: 260.5, width: PANEL_W - 2 * PAD, boxSizing: 'border-box', borderRadius: 9, background: tk.muted, padding: '8.75px 10.5px', display: 'grid', gridTemplateColumns: 'auto 1fr', columnGap: 14, rowGap: 5.25, fontSize: 11, lineHeight: '16.5px' }}>
            <span style={{ color: tk.mutedFg }}>{S.media.progress.watched}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{S.media.progress.minutes(s.watchedMin)}</span>
            <span style={{ color: tk.mutedFg }}>{S.media.progress.position}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{`${clockOf(posSec)} / ${COURSE.pages[STUDY_PAGE].dur}`}</span>
            <span style={{ color: tk.mutedFg }}>{S.media.progress.transcript}</span>
            <span style={{ fontVariantNumeric: 'tabular-nums' }}>{S.media.progress.segments(SEGMENTS.length, SEGMENTS.length)}</span>
          </div>
        </div>
      ) : null}
      {layer > 0 ? (
        <div style={{ position: 'absolute', inset: 0, opacity: layer }}>
          <LayerHead tk={tk} title={S.media.layer.practiceTitle} />
          <div style={{ position: 'absolute', left: PAD, right: PAD, top: LAYER_BODY + PAD, display: 'flex', flexDirection: 'column', gap: 10.5 }}>
            <div style={xsMuted(tk)}>{S.media.layer.cardsIntro(CARDS.length)}</div>
            {CARDS.map((c, i) => {
              const k = clamp(s.cards - i);
              return (
                <div key={c.front} style={{ ...secondaryCard(tk), position: 'relative', padding: '8.75px 10.5px', display: 'flex', flexDirection: 'column', gap: 5.25, opacity: k }}>
                  <div style={{ fontSize: 13, fontWeight: 500, lineHeight: '19.5px', color: tk.foreground }}>{c.front}</div>
                  <div style={{ fontSize: 11, lineHeight: '17.9px', color: tk.mutedFg }}>{c.back}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 3.5, fontSize: 11, color: tk.mutedFg }}>
                    {S.media.layer.source}
                    <Cite tk={tk} sec={c.t} />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      ) : null}
    </>
  );
};

export const MediaStudy = ({ tk, s }: { tk: Tokens; s: StudyState }) => {
  const active = segAt(s.pos);
  const cue = active >= 0 ? SEGMENTS[active][1] : '';
  const tbBtn = (icon: ReactNode, text?: string) => (
    <span style={{ ...ghostBtn(tk, 0, 0), height: 28, padding: text ? '0 8.75px' : 0, width: text ? undefined : 28, fontSize: 11 }}>
      {icon}
      {text}
    </span>
  );
  const ratio = s.pos / (22 * 60 + 48);
  // 字幕列表跟随当前句（TranscriptPanel 自动滚动：当前句保持在可视区）
  const segScroll = Math.max(0, active - 9) * SEG_PITCH;
  return (
    <div style={{ position: 'absolute', inset: 0, background: tk.background, fontFamily: font.ui, color: tk.foreground, overflow: 'hidden', opacity: s.enter }}>
      {/* 标题行 */}
      <Box x={10.5} y={0} w={CW - 21} h={38.5} style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
        <span style={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.mutedFg }}>
          <ArrowLeft size={16} />
        </span>
        <span style={{ fontSize: 12, fontWeight: 600 }}>{S.media.title}</span>
        <span style={{ color: mix(tk.mutedFg, 40) }}>/</span>
        <span style={{ fontSize: 11, color: tk.mutedFg, whiteSpace: 'nowrap' }}>{pageName(STUDY_PAGE)}</span>
      </Box>
      {/* 工具栏 */}
      <Box x={0} y={38.5} w={CW} h={38.5} style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 3.5, padding: '0 7px', borderTop: `1px solid ${mix(tk.border, 50)}`, borderBottom: `1px solid ${tk.border}` }}>
        {tbBtn(<ArrowUpRight size={14} />, S.media.openOnBili)}
        {tbBtn(null, S.media.useEmbed)}
        {tbBtn(<Camera size={14} />, S.media.capture)}
        <span style={{ width: 28, height: 28, borderRadius: 9, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.primary, background: mix(tk.foreground, 7) }}>
          <Subtitles size={16} />
        </span>
        {tbBtn(<DotsThree size={18} weight="bold" />)}
      </Box>
      {/* 播放器 */}
      <Box x={0} y={BODY_Y} w={PLAYER_W} h={BODY_H} style={{ background: '#000' }} />
      <div style={{ position: 'absolute', left: 0, top: VIDEO_Y, width: PLAYER_W, height: VIDEO_H, opacity: 1 - 0.85 * Math.sin(Math.PI * clamp(s.seekFlash)) }}>
        <LectureSlide pos={s.pos} />
      </div>
      {cue ? (
        <Box x={0} y={VIDEO_Y + VIDEO_H - 50 - 30 * s.controls} w={PLAYER_W} style={{ display: 'flex', justifyContent: 'center' }}>
          <span style={{ padding: '2px 8px', fontSize: 17, lineHeight: '24px', color: '#fff', background: 'rgb(0 0 0 / 0.78)', fontFamily: font.sys }}>{cue}</span>
        </Box>
      ) : null}
      {/* 顶部信息条 + 底部控制条（指针在播放器上时显示） */}
      <Box x={0} y={BODY_Y} w={PLAYER_W} h={64} style={{ opacity: s.controls, background: 'linear-gradient(180deg, rgb(0 0 0 / 0.6), transparent)', padding: '10.5px 14px', fontSize: 12, fontWeight: 500, color: 'rgb(255 255 255 / 0.9)', whiteSpace: 'nowrap' }}>
        {pageName(STUDY_PAGE)}
      </Box>
      <Box x={0} y={BODY_Y + BODY_H - 92} w={PLAYER_W} h={92} style={{ opacity: s.controls, background: 'linear-gradient(0deg, rgb(0 0 0 / 0.7), rgb(0 0 0 / 0.35) 50%, transparent)', padding: '35px 14px 10.5px' }}>
        <div style={{ position: 'relative', height: 4, borderRadius: 999, background: 'rgb(255 255 255 / 0.25)' }}>
          <div style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: `${ratio * 100}%`, borderRadius: 999, background: tk.primary }} />
          <div style={{ position: 'absolute', left: `${ratio * 100}%`, top: -4, width: 12, height: 12, marginLeft: -6, borderRadius: '50%', background: '#fff' }} />
        </div>
        <div style={{ marginTop: 5.25, display: 'flex', alignItems: 'center', gap: 3.5, color: '#fff' }}>
          <span style={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
            {s.playing ? (
              <svg width={16} height={16} viewBox="0 0 16 16">
                <rect x={3.5} y={2.5} width={3} height={11} rx={1} fill="#fff" />
                <rect x={9.5} y={2.5} width={3} height={11} rx={1} fill="#fff" />
              </svg>
            ) : (
              <Play size={16} weight="fill" />
            )}
          </span>
          <span style={{ marginLeft: 5, fontSize: 11, fontVariantNumeric: 'tabular-nums', color: 'rgb(255 255 255 / 0.9)' }}>
            {clockOf(s.pos)}
            <span style={{ color: 'rgb(255 255 255 / 0.5)' }}> / {COURSE.pages[STUDY_PAGE].dur}</span>
          </span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, padding: '0 7px' }}>1.0x</span>
          <ClosedCaptioning size={16} weight="fill" />
        </div>
      </Box>
      {!s.playing ? (
        <Box x={PLAYER_W / 2 - 32} y={VIDEO_Y + VIDEO_H / 2 - 32} w={64} h={64} style={{ borderRadius: '50%', background: `rgb(255 255 255 / ${0.18 + 0.1 * s.playHover})`, backdropFilter: 'blur(4px)', display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `scale(${1 - 0.06 * s.playPress})`, boxShadow: '0 4px 20px rgb(0 0 0 / 0.25)' }}>
          <Play size={28} weight="fill" color="#fff" style={{ marginLeft: 3 }} />
        </Box>
      ) : null}
      {/* 伴随分区 */}
      <Box x={PLAYER_W} y={BODY_Y} w={PANEL_W} h={BODY_H} style={{ borderLeft: `1px solid ${tk.border}`, background: tk.background, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', left: 10.5, right: 10.5, top: 7, height: 28, display: 'flex', gap: 2 }}>
          {TABS.map((id) => {
            const on = s.tab === id;
            const hov = s.tabHover === id;
            return (
              <span
                key={id}
                style={{
                  flex: 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  borderRadius: 10,
                  fontSize: 11,
                  fontWeight: 500,
                  color: on || hov ? tk.foreground : tk.mutedFg,
                  background: on ? tk.background : hov ? mix(tk.foreground, 4 + 3 * s.tabPress) : 'transparent',
                  boxShadow: on ? '0 0 0 1px hsl(0 0% 88%)' : undefined,
                }}
              >
                {S.media.tabs[id]}
              </span>
            );
          })}
        </div>
        {s.tab === 'transcript' ? (
          <>
            <div style={{ position: 'absolute', left: 10.5, right: 10.5, top: 38.5, height: 35, display: 'flex', alignItems: 'center', gap: 3.5 }}>
              <span style={{ fontSize: 11, color: tk.mutedFg, flex: 1 }}>{S.media.segments(SEGMENTS.length)}</span>
              <span style={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.mutedFg }}>
                <Crosshair size={15} />
              </span>
              <span style={{ width: 28, height: 28, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.mutedFg }}>
                <Copy size={15} />
              </span>
            </div>
            <div style={{ position: 'absolute', left: 10.5, right: 10.5, top: 73.5, height: 28, boxSizing: 'border-box', borderRadius: 7, border: `1px solid ${tk.border}`, display: 'flex', alignItems: 'center', gap: 7, paddingLeft: 9, fontSize: 12, color: tk.mutedFg }}>
              <MagnifyingGlass size={14} />
              {S.media.transcriptSearch}
            </div>
            <div style={{ position: 'absolute', left: 0, right: 0, top: SEG_Y0 - BODY_Y - 7, bottom: 0, overflow: 'hidden' }}>
              {SEGMENTS.map(([sec, text], i) => {
                const y = 7 + i * SEG_PITCH - segScroll;
                if (y < -SEG_PITCH || y > BODY_H) return null;
                const on = i === active;
                return (
                  <div
                    key={sec}
                    style={{
                      position: 'absolute',
                      left: 5.25,
                      right: 5.25,
                      top: y,
                      height: 28,
                      boxSizing: 'border-box',
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8.75,
                      padding: '0 21px 0 8.75px',
                      borderRadius: 9,
                      background: on ? mix(tk.primary, 10) : 'transparent',
                    }}
                  >
                    <span style={{ fontFamily: font.mono, fontSize: 11, fontVariantNumeric: 'tabular-nums', color: on ? tk.primary : tk.mutedFg }}>{clockOf(sec)}</span>
                    <span style={{ fontSize: 12, lineHeight: '17.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: on ? tk.foreground : mix(tk.foreground, 85) }}>{text}</span>
                  </div>
                );
              })}
            </div>
          </>
        ) : null}
        {s.tab === 'ask' ? <AskTab tk={tk} s={s} /> : null}
        {s.tab === 'handout' ? <HandoutTab tk={tk} s={s} /> : null}
        {s.tab === 'practice' ? <PracticeTab tk={tk} s={s} /> : null}
      </Box>
    </div>
  );
};

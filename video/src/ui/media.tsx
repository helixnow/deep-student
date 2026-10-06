import {
  ArrowLeft,
  ArrowUpRight,
  Camera,
  CaretDown,
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
  MagnifyingGlass,
  MusicNotes,
  Play,
  QrCode,
  Subtitles,
  Television,
  UploadSimple,
  UserCircle,
} from '@phosphor-icons/react';
import aiDashboardIcon from '@app/features/workbench/icons/app-icons/aiDashboard.svg';
import essayIcon from '@app/features/workbench/icons/app-icons/essay.svg';
import examIcon from '@app/features/workbench/icons/app-icons/exam.svg';
import filesIcon from '@app/features/workbench/icons/app-icons/files.svg';
import flashcardsIcon from '@app/features/workbench/icons/app-icons/flashcards.svg';
import mediaIcon from '@app/features/workbench/icons/app-icons/media.svg';
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
 *   （字幕 / 讲义 / 问答 / 练习；字幕分区 = TranscriptPanel：段数、定位 / 复制、搜索、逐段时间 + 文本，当前段 primary/10 底）。
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

/** P4 的字幕（UP 主上传的字幕轨）：[秒, 文本] */
export const SEGMENTS: Array<[number, string]> = [
  [0, '好，我们开始这一讲。'],
  [2, '上一讲会求了特征值和特征向量，'],
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
  [61, '特别地，特征值互不相同时，'],
  [66, 'A 一定可以对角化。'],
  [70, '有重特征值时要逐个检查：'],
  [75, '几何重数是否等于代数重数。'],
  [82, '我们来看一个例子。'],
];
/** 片中点的那一句（「n 阶矩阵 A 可对角化，」） */
export const SEEK_SEG = 9;
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
      <span style={{ position: 'absolute', right: -6 * u, top: -10 * u, width: 40 * u, height: 40 * u, borderRadius: '50%', background: 'hsl(38 90% 60% / 0.85)' }} />
      <span style={{ position: 'absolute', left: 7 * u, top: 20 * u, fontSize: 9.5 * u, lineHeight: 1, fontWeight: 700, color: '#fff', letterSpacing: '0.02em', fontFamily: font.ui, whiteSpace: 'nowrap' }}>线性代数</span>
      <span style={{ position: 'absolute', left: 7 * u, top: 31.5 * u, fontSize: 6 * u, lineHeight: 1, fontWeight: 500, color: 'hsl(0 0% 100% / 0.78)', fontFamily: font.ui, whiteSpace: 'nowrap' }}>第五讲 · 特征值与对角化</span>
    </span>
  );
};

// ── 全部应用面板 ──────────────────────────────────────────────
const GRID_APPS: Array<[string, string]> = [
  ['exam', examIcon],
  ['translation', translationIcon],
  ['essay', essayIcon],
  ['note', notesIcon],
  ['files', filesIcon],
  ['todo', todoIcon],
  ['skills', skillsIcon],
  ['templates', templatesIcon],
  ['taskDashboard', taskDashboardIcon],
  ['flashcards', flashcardsIcon],
  ['media', mediaIcon],
  ['settings', settingsIcon],
  ['pomodoro', pomodoroIcon],
  ['aiDashboard', aiDashboardIcon],
];
const AP_W = 720;
const AP_H_GRID = 364;
const AP_H_SEARCH = 226;
const AP_CY = 520;

const Kbd = ({ children }: { children: ReactNode }) => (
  <span style={{ padding: '1px 5px', borderRadius: 4, border: '1px solid hsl(0 0% 88% / 0.7)', background: 'hsl(220 6% 42% / 0.08)', fontSize: 10, lineHeight: 1.4 }}>{children}</span>
);

const TileIcon = ({ src, size }: { src: string; size: number }) => (
  <span
    style={{
      width: size,
      height: size,
      flex: '0 0 auto',
      boxSizing: 'border-box',
      borderRadius: size * 0.2,
      overflow: 'hidden',
      border: '1px solid hsl(0 0% 88% / 0.52)',
      background: 'hsl(0 0% 100%)',
      boxShadow: 'inset 0 1px 0 rgba(255,255,255,0.72), 0 2px 5px rgba(33,43,54,0.09)',
      display: 'inline-flex',
    }}
  >
    <img src={src} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
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
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 6 }}>
            {GRID_APPS.map(([id, src]) => (
              <div key={id} style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 8, padding: '14px 8px 12px', borderRadius: 12 }}>
                <TileIcon src={src} size={56} />
                <span style={{ fontSize: 12, fontWeight: 500, lineHeight: 1.35, whiteSpace: 'nowrap' }}>{S.appsPanel.app(id)}</span>
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
};
const OLD_ROWS: LibRow[] = [
  { name: '概率论 第 7 讲 课堂录音', meta: '1:32:10 · 2天前看过', kind: 'audio', chip: 'completed', ratio: 0.42 },
  { name: '有机化学 亲核取代反应演示', meta: '18:24 · 未开始', kind: 'video', chip: 'none' },
  { name: '英语听力 Unit 5 精讲', meta: '46:05 · 5天前看过', kind: 'audio', chip: 'completed', ratio: 1 },
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
        {r.ratio !== undefined && r.ratio < 1 ? (
          <span style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: 'rgb(0 0 0 / 0.25)' }}>
            <span style={{ display: 'block', width: `${r.ratio * 100}%`, height: '100%', background: tk.primary }} />
          </span>
        ) : null}
      </span>
      <span style={{ display: 'flex', flexDirection: 'column', gap: 3.5, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: 12, fontWeight: 500, color: tk.foreground, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.name}</span>
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
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10.5, opacity: s.stage === 'probe' ? clamp(s.grow * 2) : 1 }}>
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
                <span style={{ display: 'block', height: '100%', width: `${(Math.min(s.batch, COURSE.pages.length) / COURSE.pages.length) * 100}%`, background: tk.primary, borderRadius: 999 }} />
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
/** 学习页点击目标（内容坐标） */
export const STUDY_PT = {
  play: { x: PLAYER_W / 2, y: VIDEO_Y + VIDEO_H / 2 },
  seg: (i: number) => ({ x: PLAYER_W + 150, y: SEG_Y0 + i * SEG_PITCH + 14 }),
};

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
  segHover: number | null;
  segPress: number;
  /** 跳转后画面切换 0–1 */
  seekFlash: number;
  t: number;
};

/** 讲义幻灯片：标题页（00:00–00:33）/ 定理页（之后） */
const Slide = ({ pos }: { pos: number }) => {
  const W = PLAYER_W;
  const H = VIDEO_H;
  const theorem = pos >= 33;
  return (
    <div style={{ position: 'absolute', left: 0, top: VIDEO_Y, width: W, height: H, overflow: 'hidden', background: 'hsl(40 30% 97%)', fontFamily: font.ui, color: 'hsl(215 40% 18%)' }}>
      <div style={{ position: 'absolute', left: 0, top: 0, right: 0, height: 6, background: 'linear-gradient(90deg, hsl(212 52% 26%), hsl(205 56% 38%))' }} />
      <div style={{ position: 'absolute', right: 26, bottom: 18, fontSize: 11, color: 'hsl(215 20% 50%)', letterSpacing: '0.04em' }}>线性代数 · 第五讲</div>
      {theorem ? (
        <>
          <div style={{ position: 'absolute', left: 42, top: 34, fontSize: 22, fontWeight: 700 }}>5.4　对角化的条件</div>
          <div style={{ position: 'absolute', left: 42, top: 74, width: 160, height: 3, background: 'hsl(38 90% 55%)' }} />
          <div style={{ position: 'absolute', left: 42, top: 100, right: 42, padding: '16px 20px', borderRadius: 8, background: 'hsl(212 60% 94%)', borderLeft: '5px solid hsl(212 52% 32%)' }}>
            <div style={{ fontSize: 15, fontWeight: 700, color: 'hsl(212 52% 30%)' }}>定理 5.6</div>
            <div style={{ marginTop: 8, fontSize: 17, lineHeight: 1.6, fontFamily: font.serif }}>
              <Tex tex="n" /> 阶矩阵 <Tex tex="A" /> 可对角化 <Tex tex="\iff" /> <Tex tex="A" /> 有 <Tex tex="n" /> 个线性无关的特征向量
            </div>
          </div>
          <div style={{ position: 'absolute', left: 0, right: 0, top: 196, textAlign: 'center', fontSize: 16 }}>
            <Tex tex="P^{-1}AP=\Lambda=\begin{pmatrix}\lambda_1&&\\&\ddots&\\&&\lambda_n\end{pmatrix}" display />
          </div>
        </>
      ) : (
        <>
          <div style={{ position: 'absolute', left: 52, top: 110, fontSize: 13, letterSpacing: '0.3em', color: 'hsl(205 50% 40%)', fontWeight: 600 }}>LINEAR ALGEBRA</div>
          <div style={{ position: 'absolute', left: 50, top: 138, fontSize: 36, fontWeight: 700, fontFamily: font.serif, letterSpacing: '0.04em' }}>第五讲　特征值与对角化</div>
          <div style={{ position: 'absolute', left: 52, top: 200, width: 220, height: 3, background: 'hsl(38 90% 55%)' }} />
          <div style={{ position: 'absolute', left: 52, top: 222, fontSize: 18, color: 'hsl(215 25% 35%)' }}>5.4　对角化的条件</div>
          <div style={{ position: 'absolute', right: 56, top: 96, fontSize: 64, color: 'hsl(212 40% 85%)', fontFamily: 'KaTeX_Math, serif', fontStyle: 'italic' }}>Ax=λx</div>
        </>
      )}
    </div>
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
      <div style={{ position: 'absolute', inset: 0, opacity: 1 - 0.85 * Math.sin(Math.PI * clamp(s.seekFlash)) }}>
        <Slide pos={s.pos} />
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
            <span style={{ color: 'rgb(255 255 255 / 0.5)' }}> / 22:48</span>
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
      <Box x={PLAYER_W} y={BODY_Y} w={PANEL_W} h={BODY_H} style={{ borderLeft: `1px solid ${tk.border}`, background: tk.background }}>
        <div style={{ position: 'absolute', left: 10.5, right: 10.5, top: 7, height: 28, display: 'flex', gap: 2 }}>
          {([S.media.tabs.transcript, S.media.tabs.handout, S.media.tabs.ask, S.media.tabs.practice] as const).map((l, i) => (
            <span
              key={l}
              style={{
                flex: 1,
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                borderRadius: 10,
                fontSize: 11,
                fontWeight: 500,
                color: i === 0 ? tk.foreground : tk.mutedFg,
                background: i === 0 ? tk.background : 'transparent',
                boxShadow: i === 0 ? '0 0 0 1px hsl(0 0% 88%)' : undefined,
              }}
            >
              {l}
            </span>
          ))}
        </div>
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
        {SEGMENTS.map(([sec, text], i) => {
          const y = SEG_Y0 - BODY_Y + i * SEG_PITCH;
          if (y > BODY_H) return null;
          const on = i === active;
          const hov = s.segHover === i;
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
                background: on ? mix(tk.primary, 10) : hov ? mix(tk.foreground, 5 + 3 * s.segPress) : 'transparent',
              }}
            >
              <span style={{ fontFamily: font.mono, fontSize: 11, fontVariantNumeric: 'tabular-nums', color: on ? tk.primary : tk.mutedFg }}>{clockOf(sec)}</span>
              <span style={{ fontSize: 12, lineHeight: '17.5px', whiteSpace: 'nowrap', color: on ? tk.foreground : mix(tk.foreground, 85) }}>{text}</span>
            </div>
          );
        })}
      </Box>
    </div>
  );
};

import {
  ArrowClockwise,
  ArrowSquareOut,
  BookmarkSimple,
  BookOpen,
  CaretDown,
  CaretLeft,
  CaretRight,
  ChatDots,
  Cards,
  Copy,
  CornersOut,
  File as FileIcon,
  FolderPlus,
  Highlighter,
  Moon,
  SquaresFour,
  FunnelSimple,
  MagnifyingGlass,
  MagnifyingGlassMinus,
  MagnifyingGlassPlus,
  NotePencil,
  Sparkle,
  Terminal,
  Translate,
  X,
} from '@phosphor-icons/react';
import {
  StudyBooksIcon,
  StudyCardsIcon,
  StudyChatIcon,
  StudyMagicWandIcon,
  StudySettingsIcon,
  StudyTodoIcon,
} from '@app/components/icons/StudySidebarIcons';
import type { CSSProperties, ReactNode } from 'react';
import { font, TRAFFIC, type Tokens } from '../theme';
import { S } from '../strings';
import { StreamingRing, type SidebarRow } from './research';
import { PAGE_H, TextbookPage } from './TextbookPage';

export const CW = { w: 1760, h: 990, nav: 320, title: 40, panel: 720, chatX: 320, chatW: 720, panelX: 1040 } as const;
export const PANEL_HEADER = 40.5;
export const PDF_TOOLBAR = 36;
/** 面板里第一页纸左上角（面板左侧有 1px 边框，内容从边框内侧算起）。 */
export const PAGE_ORIGIN = { x: CW.panelX + 1 + 16, y: CW.title + PANEL_HEADER + 16 };
/** PDF 面板里每页纸的投影；k 用于漂浮页落定时渐变成同一道投影。 */
export const pageShadow = (k = 1) => `0 2px 8px hsl(214 62% 50% / ${0.1 * k})`;

export const TrafficLights = ({ gap = 8, size = 12 }: { gap?: number; size?: number }) => (
  <div style={{ display: 'flex', gap }}>
    {[TRAFFIC.close, TRAFFIC.min, TRAFFIC.zoom].map((c) => (
      <span
        key={c}
        style={{ width: size, height: size, borderRadius: '50%', background: c, boxShadow: 'inset 0 0 0 0.5px rgba(0,0,0,0.12)' }}
      />
    ))}
  </div>
);

const SidebarFrameIcon = ({ color }: { color: string }) => (
  <svg width={16} height={16} viewBox="0 0 16 16" fill="none">
    <rect x={1.5} y={2.5} width={13} height={11} rx={2.5} stroke={color} strokeWidth={1.3} />
    <path d="M6 2.5v11" stroke={color} strokeWidth={1.3} />
  </svg>
);

/** 经典壳左栏导航（「设置」不在这里，贴在左栏最底）。 */
const NAV: Array<{ label: string; Icon: (p: { className?: string }) => JSX.Element }> = [
  { label: S.nav.newChat, Icon: StudyChatIcon },
  { label: S.nav.learningHub, Icon: StudyBooksIcon },
  { label: S.nav.todo, Icon: StudyTodoIcon },
  { label: S.nav.skills, Icon: StudyMagicWandIcon },
  { label: S.nav.flashcards, Icon: StudyCardsIcon },
];

/** 第一幕（10-02 21:00）侧栏里已有的会话：与 08 侧栏同一批，相对时间往前推一天。 */
export const OLD_SESSIONS: SidebarRow[] = [
  { title: '线性代数：特征值的直觉', time: '1天前' },
  { title: '英语作文批改 · Task 2', time: '2天前' },
  { title: '有机化学反应机理整理', time: '3天前' },
  { title: '概率论错题复盘', time: '5天前' },
  { title: '机器学习系统 · 第 3 章', time: '6天前' },
];

const SB_SECTION = 'rgba(101, 105, 114, 0.72)';
const SB_SEL = 'rgba(42, 45, 50, 0.1)';
const sb = (x: number, y: number): CSSProperties => ({ position: 'absolute', left: x, top: y });
const sbText = (size: number, lh: number, color: string, weight = 400): CSSProperties => ({ fontSize: size, lineHeight: `${lh}px`, fontWeight: weight, color, whiteSpace: 'nowrap' });
const SbIcon = ({ x, y, children }: { x: number; y: number; children: ReactNode }) => (
  <span className="ds-icon" style={{ ...sb(x, y), width: 18, height: 18, display: 'inline-flex', color: 'rgb(42, 45, 50)' }}>
    {children}
  </span>
);

/** 几何取自真机经典壳（probe-cla-0，左栏 320 宽，坐标即窗口坐标）。
 * 2026-10-04 起闪卡合并 Anki 制卡 / 模板管理（51e8d7260），导航剩 5 项，下方分区整体上移两行（67.5）。 */
export const ClassicSidebar = ({ tk, rows, t }: { tk: Tokens; rows: SidebarRow[]; t: number }) => (
  <div style={{ position: 'absolute', left: 0, top: 0, width: CW.nav, height: CW.h, background: tk.nav, fontFamily: font.ui, color: 'rgb(42, 45, 50)' }}>
    <span style={{ ...sb(14, 60.8), ...sbText(18, 18, 'rgb(42, 45, 50)', 600), fontFamily: font.display }}>DeepStudent</span>
    <FunnelSimple size={15} color={tk.mutedFg} style={sb(254.8, 62.3)} />
    <MagnifyingGlass size={16} weight="bold" color={tk.mutedFg} style={sb(284, 61.8)} />
    {NAV.map(({ label, Icon }, i) => (
      <div key={label}>
        <SbIcon x={14.8} y={99.5 + 33.75 * i}>
          <Icon className="ds-icon" />
        </SbIcon>
        <span style={{ ...sb(39.5, 101.5 + 33.75 * i), ...sbText(14, 14, 'rgb(42, 45, 50)') }}>{label}</span>
      </div>
    ))}
    <span style={{ ...sb(18.5, 290.3), ...sbText(13, 18, SB_SECTION) }}>{S.nav.topics}</span>
    <CaretDown size={12.3} color={tk.mutedFg} style={sb(264.9, 293.1)} />
    <FolderPlus size={12.3} color={tk.mutedFg} style={sb(289.4, 293.1)} />
    <span style={{ ...sb(18.5, 329.5), ...sbText(13, 18, SB_SECTION) }}>{S.nav.conversations}</span>
    {rows.slice(0, 5).map((r, i) => {
      const y = 352.0 + 33.75 * i;
      return (
        <div key={`${r.title}-${i}`} style={{ position: 'absolute', inset: 0, opacity: r.enter ?? 1, transform: `translateY(${(1 - (r.enter ?? 1)) * 4}px)` }}>
          {r.active ? <span style={{ ...sb(7, y), width: 306, height: 32, borderRadius: 14, background: SB_SEL }} /> : null}
          <span style={{ ...sb(39.5, y + 9), ...sbText(14, 14, 'rgb(42, 45, 50)'), width: 211.5, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.title}</span>
          {r.streaming ? (
            <StreamingRing x={289.3} y={y + 8.7} t={t} />
          ) : (
            <span style={{ ...sb(203.3, y + 9.4), ...sbText(11, 13.2, tk.mutedFg), width: 100, textAlign: 'right' }}>{r.time}</span>
          )}
        </div>
      );
    })}
    {rows.length > 5 ? <span style={{ ...sb(38.5, 524.3), ...sbText(12, 12, tk.mutedFg) }}>{S.nav.showMore}</span> : null}
    <SbIcon x={14.8} y={CW.h - 35.5}>
      <StudySettingsIcon className="ds-icon" />
    </SbIcon>
    <span style={{ ...sb(39.5, CW.h - 33.5), ...sbText(14, 14, 'rgb(42, 45, 50)') }}>{S.nav.settings}</span>
  </div>
);

const TitleButton = ({ children, tk }: { children: ReactNode; tk: Tokens }) => (
  <span
    style={{
      width: 32,
      height: 32,
      borderRadius: 14,
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      color: tk.mutedFg,
    }}
  >
    {children}
  </span>
);

/**
 * 标题行：左栏顶上「边栏开关 / ← / →」（x=84 / 121.3 / 157.3）；主区「>_」+ 会话名（x=340 / 386）。
 * 新会话草稿时主区是空的；发出第一条后出现「>_」，首轮结束起名后才有会话名（probe-cls-new / cls-sent）。
 */
export const ClassicTitlebar = ({ tk, title, terminal = true }: { tk: Tokens; title?: string; terminal?: boolean }) => (
  <div style={{ position: 'absolute', left: 0, top: 0, width: CW.w, height: CW.title, fontFamily: font.ui }}>
    <div style={{ position: 'absolute', left: 0, top: 0, width: CW.nav, height: CW.title, background: tk.nav }} />
    <div style={{ position: 'absolute', left: CW.nav, top: 0, right: 0, height: CW.title, background: tk.background }} />
    <div style={{ position: 'absolute', left: 20, top: 14 }}>
      <TrafficLights />
    </div>
    <div style={{ position: 'absolute', left: 84, top: 4 }}>
      <TitleButton tk={tk}>
        <SidebarFrameIcon color={tk.mutedFg} />
      </TitleButton>
    </div>
    <div style={{ position: 'absolute', left: 121.3, top: 4, color: tk.foreground }}>
      <TitleButton tk={tk}>
        <CaretLeft size={16} color={tk.foreground} />
      </TitleButton>
    </div>
    <div style={{ position: 'absolute', left: 157.3, top: 4 }}>
      <TitleButton tk={tk}>
        <CaretRight size={16} color={tk.foreground} />
      </TitleButton>
    </div>
    {terminal ? (
      <div style={{ position: 'absolute', left: CW.nav + 20, top: 4 }}>
        <TitleButton tk={tk}>
          <Terminal size={16} color={tk.foreground} />
        </TitleButton>
      </div>
    ) : null}
    {title ? <span style={{ position: 'absolute', left: CW.nav + 66, top: 11.3, fontSize: 14, fontWeight: 500, lineHeight: '17.5px', color: tk.foreground, whiteSpace: 'nowrap' }}>{title}</span> : null}
  </div>
);

export const PdfPanel = ({
  tk,
  scrollY = 0,
  selected = 0,
  pageLabel = 132,
  flash = 0,
  pagesHidden = false,
  bodyHeight = CW.h - CW.title,
}: {
  tk: Tokens;
  scrollY?: number;
  selected?: number;
  pageLabel?: number;
  /** 第 134 页命中句的定位高亮（TextbookPage flash） */
  flash?: number;
  /** 命中页飞来的途中先空出页面槽位，落地那一帧再显示 */
  pagesHidden?: boolean;
  bodyHeight?: number;
}) => {
  const bodyH = bodyHeight - PANEL_HEADER;
  return (
    <div
      style={{
        position: 'absolute',
        left: CW.panelX,
        top: CW.title,
        width: CW.panel,
        height: bodyHeight,
        background: tk.background,
        borderLeft: `1px solid ${tk.border}`,
        boxShadow: '-12px 0 32px rgba(0,0,0,0.08)',
        fontFamily: font.ui,
        overflow: 'hidden',
      }}
    >
      {/* 头部（probe-clr-pdf，x 相对面板左缘）：文件图标 + 文件名 12px +「(文档)」… 外部打开 / 关闭 */}
      <div style={{ position: 'relative', height: PANEL_HEADER, background: tk.background }}>
        <FileIcon size={16} color={tk.mutedFg} style={{ position: 'absolute', left: 12.5, top: 12.3 }} />
        <span style={{ position: 'absolute', left: 35.5, top: 11.3, display: 'inline-flex', alignItems: 'baseline', gap: 7, whiteSpace: 'nowrap' }}>
          <span style={{ fontSize: 12, fontWeight: 500, lineHeight: '18px', color: tk.foreground }}>高等数学（第七版）上册.pdf</span>
          <span style={{ fontSize: 11, lineHeight: '16.5px', color: tk.mutedFg }}>(文档)</span>
        </span>
        <ArrowSquareOut size={14} color={tk.mutedFg} style={{ position: 'absolute', left: 662.3, top: 13.3 }} />
        <X size={16} color={tk.mutedFg} style={{ position: 'absolute', left: 689.3, top: 12.3 }} />
      </div>
      <div style={{ position: 'relative', height: bodyH - PDF_TOOLBAR, overflow: 'hidden', background: tk.dark ? 'hsl(0 0% 11%)' : 'hsl(0 0% 96%)' }}>
        <div style={{ position: 'absolute', left: 16, top: 16 - scrollY, opacity: pagesHidden ? 0 : 1 }}>
          <TextbookPage page={132} selected={selected} style={{ boxShadow: pageShadow() }} />
          <FillerPage style={{ marginTop: 16 }} n={133} />
          <TextbookPage page={134} flash={flash} style={{ marginTop: 16, boxShadow: pageShadow() }} />
        </div>
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, height: 3, background: 'rgb(240, 240, 240)' }} />
        <div style={{ position: 'absolute', left: 0, bottom: 0, height: 3, width: `${(pageLabel / PDF_PAGES) * 100}%`, background: tk.primary }} />
        <span style={{ position: 'absolute', right: 8, bottom: 4.5, padding: '0 4px', borderRadius: 4, background: tk.background, fontSize: 11, lineHeight: '16.5px', color: tk.mutedFg }}>{Math.round((pageLabel / PDF_PAGES) * 100)}%</span>
      </div>
      <PdfToolbar tk={tk} page={pageLabel} />
    </div>
  );
};

export const PDF_PAGES = 486;
const tbIcon = (x: number): CSSProperties => ({ position: 'absolute', left: x, top: 10.5 });
/** 底部工具条（居中一排，x 相对面板左缘）：缩略图 / 搜索 | 书签 / 批注笔（默认激活）/ − 100% ▾ + | ‹ [页] /总 › / 旋转 / 夜间 / 阅读 / 全屏。 */
const PdfToolbar = ({ tk, page }: { tk: Tokens; page: number }) => (
  <div style={{ position: 'relative', height: PDF_TOOLBAR, boxSizing: 'border-box', borderTop: '1px solid rgba(224, 224, 224, 0.5)', background: 'rgb(252, 252, 252)', color: tk.mutedFg }}>
    <SquaresFour size={16} style={tbIcon(110.4)} />
    <MagnifyingGlass size={16} style={tbIcon(140.4)} />
    <span style={{ ...tbIcon(166.4), width: 1, height: 16, background: 'rgba(224, 224, 224, 0.4)' }} />
    <BookmarkSimple size={16} style={tbIcon(177.4)} />
    <span style={{ position: 'absolute', left: 201.4, top: 5.5, width: 28, height: 26, borderRadius: 6, background: 'rgba(30, 94, 184, 0.1)' }} />
    <Highlighter size={16} color={tk.primary} style={tbIcon(207.4)} />
    <MagnifyingGlassMinus size={16} style={tbIcon(237.4)} />
    <span style={{ position: 'absolute', left: 264.4, top: 12.5, width: 42, textAlign: 'center', fontSize: 12, fontWeight: 500, lineHeight: '12px' }}>100%</span>
    <CaretDown size={12} style={{ position: 'absolute', left: 313.4, top: 12.5 }} />
    <MagnifyingGlassPlus size={16} style={tbIcon(336.4)} />
    <span style={{ ...tbIcon(362.4), width: 1, height: 16, background: 'rgba(224, 224, 224, 0.4)' }} />
    <CaretLeft size={16} style={tbIcon(373.4)} />
    <span style={{ position: 'absolute', left: 397.4, top: 4.5, width: 44, height: 28, boxSizing: 'border-box', borderRadius: 6, border: '1px solid rgba(224, 224, 224, 0.7)', background: 'rgba(240, 240, 240, 0.3)', fontSize: 12, lineHeight: '26px', textAlign: 'center', color: tk.foreground, fontVariantNumeric: 'tabular-nums' }}>{page}</span>
    <span style={{ position: 'absolute', left: 445.4, top: 9.5, fontSize: 12, lineHeight: '18px', fontVariantNumeric: 'tabular-nums' }}>/{PDF_PAGES}</span>
    <CaretRight size={16} style={tbIcon(475.6 + PAGES_DX)} />
    <ArrowClockwise size={16} style={tbIcon(505.6 + PAGES_DX)} />
    <Moon size={16} style={tbIcon(535.6 + PAGES_DX)} />
    <BookOpen size={16} style={tbIcon(565.6 + PAGES_DX)} />
    <CornersOut size={16} style={tbIcon(595.6 + PAGES_DX)} />
  </div>
);
/** 「/60」→「/486」多一位数字（12px 数字宽约 7px）。 */
const PAGES_DX = 7;

const FillerPage = ({ style, n }: { style?: CSSProperties; n: number }) => (
  <div style={{ width: 688, height: PAGE_H, background: '#fff', borderRadius: 4, position: 'relative', ...style }}>
    <div style={{ position: 'absolute', left: 64, top: 36, fontFamily: font.serif, fontSize: 13, color: '#555' }}>{n}</div>
    {Array.from({ length: 24 }, (_, i) => (
      <div
        key={i}
        style={{
          position: 'absolute',
          left: 64 + (i % 6 === 0 ? 35 : 0),
          top: 96 + i * 34,
          height: 9,
          borderRadius: 4,
          width: i % 6 === 5 ? 260 : 560 - (i % 6 === 0 ? 35 : 0),
          background: '#e6e6e6',
        }}
      />
    ))}
  </div>
);

/** 高亮色板（黄 / 绿 / 蓝 / 红 + 复制），来自 EnhancedPdfViewer HIGHLIGHT_COLORS。 */
export const HighlightMenu = ({ tk, style }: { tk: Tokens; style?: CSSProperties }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 4,
      padding: '6px 8px',
      background: tk.card,
      border: `1px solid ${tk.border}`,
      borderRadius: 8,
      boxShadow: '0 4px 12px hsl(214 62% 50% / 0.15)',
      ...style,
    }}
  >
    {['#fef08a', '#bbf7d0', '#bfdbfe', '#fecaca'].map((c) => (
      <span key={c} style={{ width: 24, height: 24, borderRadius: '50%', background: c, border: '2px solid transparent', boxSizing: 'border-box' }} />
    ))}
    <span style={{ width: 1, height: 18, margin: 2, background: tk.border }} />
    <span style={{ width: 24, height: 24, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: tk.foreground }}>
      <Copy size={16} />
    </span>
  </div>
);

export const SELECTION_ACTIONS = [
  { label: S.sel.copy, Icon: Copy },
  { label: S.sel.explain, Icon: Sparkle },
  { label: S.sel.translate, Icon: Translate },
  { label: S.sel.saveAsNote, Icon: NotePencil },
  { label: S.sel.makeCards, Icon: Cards },
  { label: S.sel.addToChat, Icon: ChatDots },
];
/** PDF 里「添加到聊天」= 选区引用（PdfSelectionActions 不传 onAddAsContext，「引用到聊天」那项不渲染）。 */
export const SEL_ADD_TO_CHAT = 5;
/** 工具条宽（probe-clt-sel1：6 项 425.5）与「添加到聊天」项中心。 */
export const SEL_TOOLBAR_W = 425.5;
export const SEL_ADD_CX = 378.5;

export const SelectionToolbar = ({
  tk,
  hot = -1,
  press = 0,
  style,
}: {
  tk: Tokens;
  hot?: number;
  press?: number;
  style?: CSSProperties;
}) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      height: 29,
      boxSizing: 'border-box',
      borderRadius: 7,
      border: '1px solid rgba(224, 224, 224, 0.5)',
      background: tk.dark ? 'rgba(30, 30, 30, 0.9)' : 'rgba(255, 255, 255, 0.8)',
      backdropFilter: 'blur(24px)',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.06)',
      fontFamily: font.ui,
      ...style,
    }}
  >
    {SELECTION_ACTIONS.map(({ label, Icon }, i) => (
      <span key={label} style={{ display: 'inline-flex', alignItems: 'center', height: '100%' }}>
        {i > 0 ? <span style={{ width: 1, height: 17.5, background: 'rgba(224, 224, 224, 0.5)' }} /> : null}
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 5.2,
            height: '100%',
            padding: '0 9.7px',
            fontSize: 11,
            fontWeight: 500,
            lineHeight: '16.5px',
            color: 'rgba(42, 45, 50, 0.8)',
            background: i === hot ? `color-mix(in hsl, ${tk.accent} ${60 + press * 40}%, transparent)` : 'transparent',
            borderRadius: i === 0 ? '6px 0 0 6px' : i === SELECTION_ACTIONS.length - 1 ? '0 6px 6px 0' : 0,
          }}
        >
          <Icon size={14} />
          {label}
        </span>
      </span>
    ))}
  </div>
);

export const Toast = ({ tk, text, sub, style }: { tk: Tokens; text: string; sub?: string; style?: CSSProperties }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 8,
      minHeight: 28,
      padding: '4px 12px',
      borderRadius: 12,
      background: tk.card,
      border: `1px solid color-mix(in hsl, ${tk.success} 68%, transparent)`,
      boxShadow: '0 6px 14px rgba(0,0,0,0.08), 0 1px 3px rgba(0,0,0,0.06)',
      fontFamily: font.ui,
      fontSize: 13,
      color: tk.foreground,
      whiteSpace: 'nowrap',
      ...style,
    }}
  >
    <span style={{ fontWeight: 500 }}>{text}</span>
    {sub ? <span style={{ color: tk.mutedFg, fontSize: 12 }}>{sub}</span> : null}
  </div>
);

export const ClassicWindow = ({
  tk,
  t,
  title,
  terminal,
  sessions,
  chat,
  panel,
  chromeOpacity = 1,
  style,
}: {
  tk: Tokens;
  t: number;
  title?: string;
  terminal?: boolean;
  sessions: SidebarRow[];
  chat: ReactNode;
  panel?: ReactNode;
  chromeOpacity?: number;
  style?: CSSProperties;
}) => (
  <div
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      width: CW.w,
      height: CW.h,
      borderRadius: 12,
      overflow: 'hidden',
      background: tk.background,
      boxShadow: `0 0 0 0.5px ${tk.dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.14)'}, 0 30px 80px rgba(20,24,32,${tk.dark ? 0.5 : 0.18}), 0 8px 24px rgba(20,24,32,0.08)`,
      ...style,
    }}
  >
    <div style={{ opacity: chromeOpacity }}>
      <ClassicSidebar tk={tk} rows={sessions} t={t} />
      <ClassicTitlebar tk={tk} title={title} terminal={terminal} />
    </div>
    <div style={{ position: 'absolute', left: CW.chatX, top: CW.title, width: CW.chatW, height: CW.h - CW.title, overflow: 'hidden' }}>
      <div style={{ opacity: chromeOpacity, position: 'absolute', inset: 0 }}>{chat}</div>
    </div>
    {panel}
  </div>
);

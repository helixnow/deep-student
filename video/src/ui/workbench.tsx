import { ChartBar, GearSix, MagnifyingGlass, Robot, SquaresFour, Stack, Timer } from '@phosphor-icons/react';
import appIconPng from '@app-public/app-icon.png';
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
import textbookIcon from '@app/features/workbench/icons/app-icons/textbook.svg';
import todoIcon from '@app/features/workbench/icons/app-icons/todo.svg';
import translationIcon from '@app/features/workbench/icons/app-icons/translation.svg';
import mountainMist from '@app-public/wallpapers/study-os/mountain-mist.webp';
import type { CSSProperties, ReactNode } from 'react';
import { Easing, Img } from 'remotion';
import { S } from '../strings';
import { font, TRAFFIC, type Tokens } from '../theme';
import { LogoMark } from './brand';
import { clamp, HEIGHT, PACE, WIDTH } from '../lib/time';

/**
 * 学习桌面（OS 模式）外壳的转写。来源：
 * workbench.tokens.css / workbench.css / motion.css / WindowLifecycle.css（材质、阴影、开关窗与 genie 关键帧）、
 * Dock.tsx + DockItem.tsx + Dock.css（固定区 / 运行区 / 全部应用 / AI 操控、气泡、角标、启动弹跳）、
 * StatusBar.tsx + StatusBarItems.tsx + StatusBar.css（菜单栏）、icons/appIcons.tsx。
 * 几何以真机取证为准（video/out/cap/probe-desk.txt）。产品根字号 14px，0.25rem = 3.5px。
 */
export const WB = { menubar: 40, titlebar: 38, radius: 20 } as const;
/** macOS 上菜单栏与系统标题栏共面，左侧给原生红黄绿按钮留 72px（全屏时按钮隐藏，留白仍在）。 */
export const MAC_INSET = 72;

const glass = (tk: Tokens, strong = false) => ({
  bg: tk.dark ? `hsl(0 0% 12% / ${strong ? 0.42 : 0.32})` : `hsl(0 0% 99% / ${strong ? 0.28 : 0.2})`,
  blur: tk.dark ? `blur(${strong ? 24 : 18}px) saturate(1.8) brightness(0.92)` : `blur(${strong ? 24 : 18}px) saturate(1.8) brightness(1.08)`,
  border: tk.dark ? 'hsl(0 0% 18% / 0.7)' : 'hsl(0 0% 88% / 0.52)',
  highlight: tk.dark ? 'rgba(255,255,255,0.22)' : 'rgba(255,255,255,0.55)',
  sheen: tk.dark
    ? 'linear-gradient(118deg, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0.035) 34%, rgba(255,255,255,0) 58%), radial-gradient(130% 70% at 50% 102%, rgba(255,255,255,0.07) 0%, rgba(255,255,255,0) 48%)'
    : 'linear-gradient(118deg, rgba(255,255,255,0.22) 0%, rgba(255,255,255,0.06) 34%, rgba(255,255,255,0) 58%), radial-gradient(130% 70% at 50% 102%, rgba(255,255,255,0.12) 0%, rgba(255,255,255,0) 48%)',
});
export const glassOf = glass;

/** --wb-shadow-idle / --wb-shadow-focused（明暗两档）。 */
export const wbShadow = (tk: Tokens, focused: boolean) =>
  tk.dark
    ? focused
      ? '0 0 0 0.5px rgba(0,0,0,0.42), 0 28px 80px rgba(0,0,0,0.56), 0 9px 26px rgba(0,0,0,0.36)'
      : '0 0 0 0.5px rgba(0,0,0,0.34), 0 12px 32px rgba(0,0,0,0.38), 0 3px 10px rgba(0,0,0,0.26)'
    : focused
      ? '0 0 0 0.5px hsl(0 0% 0% / 0.10), 0 26px 76px hsl(0 0% 0% / 0.27), 0 9px 24px hsl(0 0% 0% / 0.15)'
      : '0 0 0 0.5px hsl(0 0% 0% / 0.07), 0 10px 30px hsl(0 0% 0% / 0.14), 0 3px 9px hsl(0 0% 0% / 0.08)';

/**
 * 壁纸：产品默认预设 mountain-mist（CC0 实拍，见 public/wallpapers/study-os/ATTRIBUTION.md）。
 * night = 1 是晚上 21:30：压暗、降饱和、冷色；night = 0 是白天原片。
 * 其上叠产品对应明暗档的 scrim、压暗层（imageDim 0.06）与暗角（WallpaperLayer.css）。
 */
export const Wallpaper = ({ drift = 0, night = 1, style }: { drift?: number; night?: number; style?: CSSProperties }) => {
  const mix = (day: number, nightV: number) => day + (nightV - day) * night;
  return (
    <div style={{ position: 'absolute', inset: 0, overflow: 'hidden', background: 'hsl(220 14% 7%)', ...style }}>
      <Img
        src={mountainMist}
        style={{
          position: 'absolute',
          left: -48,
          top: -27,
          width: WIDTH + 96,
          height: HEIGHT + 54,
          objectFit: 'cover',
          objectPosition: 'center 52%',
          filter: `brightness(${mix(1, 0.42)}) saturate(${mix(1, 0.55)}) contrast(${mix(1, 1.08)})`,
          transform: `translate(${drift * -16}px, ${drift * 7}px)`,
        }}
      />
      <div style={{ position: 'absolute', inset: 0, background: 'hsl(214 46% 30% / 0.5)', mixBlendMode: 'multiply', opacity: night }} />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, hsl(0 0% 9% / 0.10) 0%, hsl(0 0% 9% / 0.30) 100%)', opacity: night }} />
      <div style={{ position: 'absolute', inset: 0, background: 'linear-gradient(180deg, hsl(0 0% 100% / 0.06) 0%, hsl(0 0% 100% / 0.18) 100%)', opacity: 1 - night }} />
      <div style={{ position: 'absolute', inset: 0, background: 'rgb(0 0 0)', opacity: 0.06 * (1 - night) }} />
      <div style={{ position: 'absolute', inset: 0, background: `radial-gradient(135% 110% at 50% 42%, transparent ${mix(58, 55)}%, hsl(0 0% 0% / ${mix(0.18, 0.34)}) 100%)` }} />
    </div>
  );
};

// ── 菜单栏（StatusBar） ─────────────────────────────────────────
const MbItem = ({ tk, children, iconOnly = false, weight = 400 }: { tk: Tokens; children: ReactNode; iconOnly?: boolean; weight?: number }) => (
  <span
    style={{
      height: 26,
      width: iconOnly ? 26 : undefined,
      padding: iconOnly ? 0 : '0 7px',
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
      borderRadius: 6,
      fontSize: 12,
      fontWeight: weight,
      lineHeight: 1,
      fontVariantNumeric: 'tabular-nums',
      color: tk.foreground,
      whiteSpace: 'nowrap',
    }}
  >
    {children}
  </span>
);

const MbValue = ({ children }: { children: ReactNode }) => <span style={{ fontWeight: 500, letterSpacing: '0.01em' }}>{children}</span>;

/**
 * 左：品牌钮（纯 logo）→ 聚焦应用名（无焦点时「学习桌面」）→「窗口」。
 * 右：搜索 →（番茄钟运行中）⏱ m:ss →（有到期）闪卡数 →（有制卡任务）任务数 → 定时任务 → 设置 → 今日节律 → 时钟。
 */
export const MenuBar = ({
  tk,
  app,
  clock,
  pomo = null,
  due = 0,
  tasks = 0,
  style,
}: {
  tk: Tokens;
  app: string;
  clock: string;
  pomo?: string | null;
  due?: number;
  tasks?: number;
  style?: CSSProperties;
}) => {
  const g = glass(tk);
  return (
    <div
      style={{
        position: 'absolute',
        left: 0,
        top: 0,
        width: WIDTH,
        height: WB.menubar,
        boxSizing: 'border-box',
        padding: `0 12px 0 ${MAC_INSET}px`,
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        fontFamily: font.ui,
        ...style,
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          background: `${g.sheen}, ${tk.dark ? 'hsl(0 0% 12% / 0.18)' : 'hsl(0 0% 99% / 0.10)'}`,
          backdropFilter: g.blur,
          borderBottom: `1px solid ${tk.dark ? 'hsl(0 0% 18% / 0.4)' : 'hsl(0 0% 88% / 0.3)'}`,
        }}
      />
      <div style={{ position: 'absolute', left: 0, right: 0, bottom: -1, height: 1, background: `linear-gradient(90deg, transparent 0%, ${g.highlight} 16%, ${g.highlight} 84%, transparent 100%)` }} />
      <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        <MbItem tk={tk} iconOnly>
          <LogoMark id={`wb-menubar-${tk.dark ? 'd' : 'l'}`} size={15.3} color={tk.foreground} pupilColor={tk.foreground} />
        </MbItem>
        <MbItem tk={tk} weight={700}>
          {app}
        </MbItem>
        <MbItem tk={tk} weight={500}>
          {S.desk.windowMenu}
        </MbItem>
      </span>
      <span style={{ position: 'relative', marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 2 }}>
        <MbItem tk={tk} iconOnly>
          <MagnifyingGlass size={15} weight="bold" />
        </MbItem>
        {pomo ? (
          <MbItem tk={tk}>
            <Timer size={14} weight="duotone" />
            <MbValue>{pomo}</MbValue>
          </MbItem>
        ) : null}
        {due > 0 ? (
          <MbItem tk={tk}>
            <Stack size={14} weight="duotone" />
            <MbValue>{due}</MbValue>
          </MbItem>
        ) : null}
        {tasks > 0 ? (
          <MbItem tk={tk}>
            <ChartBar size={14} weight="duotone" />
            <MbValue>{tasks}</MbValue>
          </MbItem>
        ) : null}
        <MbItem tk={tk}>
          <Robot size={14} weight="duotone" />
        </MbItem>
        <MbItem tk={tk} iconOnly>
          <GearSix size={15} weight="bold" />
        </MbItem>
        <MbItem tk={tk} iconOnly>
          <SquaresFour size={14} weight="duotone" />
        </MbItem>
        <MbItem tk={tk}>{clock}</MbItem>
      </span>
    </div>
  );
};

/** 菜单栏时钟（StatusBarClock.formatMenuBarClock，zh：「10月3日 周六 7:30」，小时不补零）。 */
export const menuClock = (day: 2 | 3, hh: number, mm: number) => `10月${day}日 ${day === 2 ? '周五' : '周六'} ${hh}:${String(mm).padStart(2, '0')}`;

// ── Dock ──────────────────────────────────────────────
export const APP_ICONS: Record<string, string> = {
  chat: chatIcon,
  files: filesIcon,
  settings: settingsIcon,
  todo: todoIcon,
  flashcards: flashcardsIcon,
  pomodoro: pomodoroIcon,
  exam: examIcon,
  essay: essayIcon,
  translation: translationIcon,
  notes: notesIcon,
  mindmap: mindmapIcon,
  textbook: textbookIcon,
  skills: skillsIcon,
  media: mediaIcon,
};

export const APP_NAMES: Record<string, string> = {
  chat: S.apps.chat,
  files: S.apps.files,
  settings: S.apps.settings,
  todo: S.apps.todo,
  flashcards: S.apps.flashcards,
  pomodoro: S.apps.pomodoro,
  exam: S.apps.exam,
  essay: S.apps.essay,
  translation: S.apps.translation,
  notes: S.apps.note,
  textbook: S.apps.textbook,
  media: S.media.app,
  __apps__: S.desk.dockApps,
  __agent__: S.desk.agentDock,
};

/** 默认固定区（registerAll.ts DEFAULT_DOCK_PINNED）。 */
export const DOCK_PINNED = ['chat', 'files', 'settings', 'todo'] as const;
const DK = { item: 44, gap: 3.5, padX: 7, padY: 3.5, border: 1, sep: 8, top: 1010, h: 53 } as const;
export const DOCK_TOP = DK.top;

type Slot = { kind: 'app'; id: string } | { kind: 'sep' } | { kind: 'apps' } | { kind: 'agent' };

/** 固定区 →（有未固定的运行应用时）分隔 + 运行区（按最早开窗保序）→ 分隔 →「全部应用」→ AI 操控。 */
const dockSlots = (running: string[]): Slot[] => {
  const extra = running.filter((id, i) => !(DOCK_PINNED as readonly string[]).includes(id) && running.indexOf(id) === i);
  return [
    ...DOCK_PINNED.map((id): Slot => ({ kind: 'app', id })),
    ...(extra.length > 0 ? [{ kind: 'sep' } as Slot, ...extra.map((id): Slot => ({ kind: 'app', id }))] : []),
    { kind: 'sep' },
    { kind: 'apps' },
    { kind: 'agent' },
  ];
};
const slotW = (s: Slot) => (s.kind === 'sep' ? DK.sep : DK.item);
const slotKey = (s: Slot) => (s.kind === 'app' ? s.id : s.kind === 'apps' ? '__apps__' : s.kind === 'agent' ? '__agent__' : null);
const dockWidth = (slots: Slot[]) => 2 * DK.border + 2 * DK.padX + slots.reduce((w, s) => w + slotW(s), 0) + DK.gap * (slots.length - 1);

/** Dock 图标中心（屏幕坐标）；Dock 居中，运行区变化时整体宽度与位置随之变化。 */
export const dockIconCenter = (id: string, running: string[] = []) => {
  const slots = dockSlots(running);
  let x = (WIDTH - dockWidth(slots)) / 2 + DK.border + DK.padX;
  for (const s of slots) {
    if (slotKey(s) === id) return { x: x + DK.item / 2, y: DK.top + DK.border + DK.padY + DK.item / 2 };
    x += slotW(s) + DK.gap;
  }
  return { x: WIDTH / 2, y: DK.top + DK.h / 2 };
};

export const AppIcon = ({ src, size }: { src: string; size: number }) => (
  <span
    style={{
      width: size,
      height: size,
      flexShrink: 0,
      borderRadius: '22.5%',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      background: 'linear-gradient(180deg, #ffffff, #eef1f5)',
      boxShadow: 'inset 0 0 0 0.5px rgba(31, 41, 55, 0.16), 0 1px 2px rgba(15, 23, 42, 0.25)',
    }}
  >
    <img src={src} style={{ width: '76%', height: '76%', objectFit: 'contain' }} />
  </span>
);

/** 悬停气泡（Dock.css .wb-dock-tip：玻璃底、带箭头，悬停 350ms 后浮现，图标本身不放大）。 */
const DockTip = ({ tk, label, k }: { tk: Tokens; label: string; k: number }) => {
  const g = glass(tk, true);
  const bg = tk.dark ? 'hsl(0 0% 12% / 0.42)' : 'hsl(0 0% 99% / 0.28)';
  return (
    <span
      style={{
        position: 'absolute',
        left: '50%',
        bottom: 'calc(100% + 12px)',
        zIndex: 1,
        padding: '4px 11px',
        borderRadius: 8,
        fontSize: 12,
        fontWeight: 500,
        lineHeight: 1.4,
        whiteSpace: 'nowrap',
        color: tk.foreground,
        backgroundColor: bg,
        backgroundImage: g.sheen,
        backdropFilter: g.blur,
        border: `1px solid ${g.border}`,
        boxShadow: `inset 0 1px 0 ${g.highlight}, 0 6px 18px hsl(0 0% 0% / 0.16)`,
        opacity: k,
        transform: `translate(-50%, ${(1 - k) * 5}px) scale(${0.94 + 0.06 * k})`,
        transformOrigin: '50% 100%',
      }}
    >
      {label}
      <span
        style={{
          position: 'absolute',
          left: '50%',
          bottom: -4.5,
          width: 9,
          height: 9,
          transform: 'translateX(-50%) rotate(45deg)',
          borderRadius: 2,
          backgroundColor: bg,
          borderRight: `1px solid ${g.border}`,
          borderBottom: `1px solid ${g.border}`,
        }}
      />
    </span>
  );
};

export type DockBadge = { kind: 'count'; value: number } | { kind: 'dot' };

/** 角标（workbench.css .wb-dock-badge：16px 红底，右上角外扩 3px）。 */
const Badge = ({ tk, badge }: { tk: Tokens; badge: DockBadge }) => (
  <span
    style={{
      position: 'absolute',
      top: -3,
      right: -3,
      minWidth: 16,
      height: 16,
      padding: '0 4px',
      boxSizing: 'border-box',
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      borderRadius: 999,
      background: tk.destructive,
      color: '#fff',
      fontSize: 10,
      fontWeight: 600,
      lineHeight: 1,
      fontFamily: font.ui,
      fontVariantNumeric: 'tabular-nums',
      boxShadow: '0 1px 4px hsl(0 0% 0% / 0.28)',
    }}
  >
    {badge.kind === 'count' ? badge.value : null}
  </span>
);

const E_OUT = Easing.bezier(0.16, 1, 0.3, 1);

export const Dock = ({
  tk,
  running = [],
  bounce = {},
  tip,
  press = {},
  badges = {},
  indicator = {},
  style,
}: {
  tk: Tokens;
  /** 有窗口的应用（含最小化），按最早开窗保序 */
  running?: string[];
  /** 每个图标的弹跳位移（px，向上为正） */
  bounce?: Record<string, number>;
  /** 正在悬停的图标与气泡进度 */
  tip?: { id: string; k: number };
  /** 按压压暗（0–1） */
  press?: Record<string, number>;
  badges?: Record<string, DockBadge>;
  /** 运行指示点入场进度（0–1，240ms 淡入）；缺省视为已入场 */
  indicator?: Record<string, number>;
  style?: CSSProperties;
}) => {
  const g = glass(tk, true);
  const slots = dockSlots(running);
  const w = dockWidth(slots);
  const item = (key: string, body: ReactNode, isRunning: boolean) => {
    const ind = E_OUT(clamp(indicator[key] ?? 1));
    return (
      <span key={key} style={{ position: 'relative', width: DK.item, height: DK.item, flex: `0 0 ${DK.item}px` }}>
        {tip && tip.id === key && tip.k > 0.001 ? <DockTip tk={tk} label={APP_NAMES[key] ?? key} k={tip.k} /> : null}
        <span style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', transform: `translateY(${-(bounce[key] ?? 0)}px)` }}>
          <span style={{ display: 'inline-flex', transform: 'scale(1.3)', filter: press[key] ? `brightness(${1 - 0.18 * press[key]})` : undefined }}>{body}</span>
          {badges[key] ? <Badge tk={tk} badge={badges[key]} /> : null}
        </span>
        {isRunning ? (
          <span
            style={{
              position: 'absolute',
              left: '50%',
              bottom: -5,
              width: 4,
              height: 4,
              borderRadius: '50%',
              background: `color-mix(in hsl, ${tk.foreground} ${tk.dark ? 72 : 62}%, transparent)`,
              opacity: 0.85 * ind,
              transform: `translateX(-50%) scale(${0.3 + 0.7 * ind})`,
            }}
          />
        ) : null}
      </span>
    );
  };
  return (
    <div
      style={{
        position: 'absolute',
        left: (WIDTH - w) / 2,
        top: DK.top,
        width: w,
        height: DK.h,
        boxSizing: 'border-box',
        padding: `${DK.padY}px ${DK.padX}px`,
        display: 'flex',
        alignItems: 'flex-end',
        gap: DK.gap,
        borderRadius: 22,
        backgroundColor: g.bg,
        backgroundImage: g.sheen,
        backdropFilter: g.blur,
        border: `${DK.border}px solid ${g.border}`,
        boxShadow: tk.dark
          ? `inset 0 1px 0 ${g.highlight}, 0 0 0 0.5px rgba(0,0,0,0.40), 0 20px 50px rgba(0,0,0,0.50), 0 5px 14px rgba(0,0,0,0.32)`
          : `inset 0 1px 0 ${g.highlight}, 0 0 0 0.5px hsl(0 0% 0% / 0.08), 0 18px 44px hsl(0 0% 0% / 0.20), 0 4px 12px hsl(0 0% 0% / 0.10)`,
        ...style,
      }}
    >
      {slots.map((s, i) => {
        if (s.kind === 'sep') {
          return <span key={`sep${i}`} style={{ width: 1, height: 32, margin: '0 3.5px', alignSelf: 'center', flex: '0 0 1px', background: `color-mix(in hsl, ${tk.border} 80%, transparent)` }} />;
        }
        if (s.kind === 'apps') return item('__apps__', <SquaresFour size={26} weight="duotone" color={tk.foreground} />, false);
        if (s.kind === 'agent') return item('__agent__', <img src={appIconPng} style={{ width: 30, height: 30, objectFit: 'contain', display: 'block' }} />, false);
        return item(s.id, <AppIcon src={APP_ICONS[s.id] ?? chatIcon} size={28} />, running.includes(s.id));
      })}
    </div>
  );
};

// ── 动效（脚本秒；产品时长按真实时间折算：脚本秒 = 毫秒 / 1000 / PACE） ─────────────
const E_OPEN = Easing.bezier(0.32, 0.72, 0, 1);
const E_CLOSE = Easing.bezier(0.42, 0, 1, 1);
const E_BOUNCE_UP = Easing.bezier(0.2, 0.7, 0.3, 1);
const E_BOUNCE_DOWN = Easing.bezier(0.55, 0.06, 0.68, 0.19);
export const WIN_OPEN_S = 0.22 / PACE;
export const WIN_CLOSE_S = 0.11 / PACE;
export const GENIE_S = 0.4 / PACE;
export const BOUNCE_S = 0.78 / PACE;
export const IND_S = 0.24 / PACE;
export const TIP_DELAY_S = 0.35 / PACE;
export const TIP_FADE_S = 0.13 / PACE;

/** Dock 启动弹跳（Dock.css wb-dock-bounce-launch：780ms，−20px / −8px 两段递减，上升 ease-out、下落 ease-in）。 */
export const dockBounceAt = (t: number, at: number) => {
  if (t < at || t >= at + BOUNCE_S) return 0;
  const p = (t - at) / BOUNCE_S;
  if (p < 0.28) return 20 * E_BOUNCE_UP(p / 0.28);
  if (p < 0.54) return 20 * (1 - E_BOUNCE_DOWN((p - 0.28) / 0.26));
  if (p < 0.76) return 8 * E_BOUNCE_UP((p - 0.54) / 0.22);
  return 8 * (1 - E_BOUNCE_DOWN((p - 0.76) / 0.24));
};

const GENIE_MIN: Array<[number, number, number, number, number]> = [
  // [进度, opacity, scaleX, scaleY, translateY%]（motion.css wb-kf-genie-min，逐段 linear）
  [0, 1, 1, 1, 0],
  [0.1, 1, 0.94, 0.995, 0.2],
  [0.22, 1, 0.82, 0.965, 0.7],
  [0.35, 1, 0.64, 0.905, 1.6],
  [0.48, 1, 0.46, 0.815, 2.8],
  [0.6, 1, 0.3, 0.7, 4.1],
  [0.71, 1, 0.19, 0.55, 5.4],
  [0.81, 0.96, 0.115, 0.38, 6.6],
  [0.89, 0.62, 0.068, 0.22, 7.4],
  [0.95, 0.28, 0.042, 0.115, 7.8],
  [1, 0, 0.03, 0.06, 8],
];

const GENIE_RESTORE: Array<[number, number, number, number, number]> = [
  // motion.css wb-kf-genie-restore
  [0, 0, 0.03, 0.06, 8],
  [0.06, 0.42, 0.05, 0.13, 7.7],
  [0.13, 0.86, 0.09, 0.24, 7.2],
  [0.2, 1, 0.15, 0.4, 6.3],
  [0.31, 1, 0.24, 0.57, 5],
  [0.44, 1, 0.38, 0.72, 3.6],
  [0.57, 1, 0.55, 0.84, 2.3],
  [0.7, 1, 0.72, 0.92, 1.3],
  [0.82, 1, 0.87, 0.97, 0.55],
  [0.91, 1, 0.97, 0.995, 0.15],
  [0.96, 1, 1.006, 1.002, 0],
  [1, 1, 1, 1, 0],
];

const sampleKeys = (keys: Array<[number, number, number, number, number]>, p: number) => {
  for (let i = 1; i < keys.length; i++) {
    const a = keys[i - 1];
    const b = keys[i];
    if (p <= b[0]) {
      const k = (p - a[0]) / (b[0] - a[0]);
      return a.map((v, j) => v + (b[j] - v) * k) as [number, number, number, number, number];
    }
  }
  return keys[keys.length - 1];
};
const genieAt = (p: number) => sampleKeys(GENIE_MIN, p);

export type Rect = { x: number; y: number; w: number; h: number };
type Pt = { x: number; y: number };

/**
 * 窗口生命周期（WindowLifecycle.css）：
 * - 开窗 220ms：scale 0.34→1，opacity 在 45% 处满；源点 = 应用在 Dock 上的图标（固定区应用），
 *   图标此前不在 Dock 上时回退窗口中心（Dock 几何在开窗后一帧才发布）。
 * - 关窗 110ms：淡出 + scale 0.96。
 * - 最小化 400ms：genie 吸入 Dock 图标。
 */
export const winLife = (
  t: number,
  rect: Rect,
  o: { openAt?: number; openFrom?: Pt | null; restoreAt?: number; restoreFrom?: Pt; closeAt?: number; minimizeAt?: number; minimizeTo?: Pt },
): { visible: boolean; style: CSSProperties } => {
  if (o.openAt !== undefined && t < o.openAt) return { visible: false, style: {} };
  if (o.restoreAt !== undefined && t < o.restoreAt) return { visible: false, style: {} };
  if (o.restoreAt !== undefined && o.restoreFrom && t < o.restoreAt + GENIE_S) {
    const [op, sx, sy, ty] = sampleKeys(GENIE_RESTORE, clamp((t - o.restoreAt) / GENIE_S)).slice(1);
    return {
      visible: true,
      style: { opacity: op, transform: `scale(${sx}, ${sy}) translateY(${ty}%)`, transformOrigin: `${o.restoreFrom.x - rect.x}px ${o.restoreFrom.y - rect.y}px` },
    };
  }
  if (o.closeAt !== undefined && t >= o.closeAt + WIN_CLOSE_S) return { visible: false, style: {} };
  if (o.minimizeAt !== undefined && t >= o.minimizeAt + GENIE_S) return { visible: false, style: {} };
  if (o.minimizeAt !== undefined && t >= o.minimizeAt && o.minimizeTo) {
    const [op, sx, sy, ty] = genieAt(clamp((t - o.minimizeAt) / GENIE_S)).slice(1);
    return {
      visible: true,
      style: { opacity: op, transform: `scale(${sx}, ${sy}) translateY(${ty}%)`, transformOrigin: `${o.minimizeTo.x - rect.x}px ${o.minimizeTo.y - rect.y}px` },
    };
  }
  if (o.closeAt !== undefined && t >= o.closeAt) {
    const e = E_CLOSE(clamp((t - o.closeAt) / WIN_CLOSE_S));
    return { visible: true, style: { opacity: 1 - e, transform: `scale(${1 - 0.04 * e})`, transformOrigin: '50% 50%' } };
  }
  if (o.openAt !== undefined && t < o.openAt + WIN_OPEN_S) {
    const k = clamp((t - o.openAt) / WIN_OPEN_S);
    const origin = o.openFrom ? `${o.openFrom.x - rect.x}px ${o.openFrom.y - rect.y}px` : '50% 50%';
    return { visible: true, style: { opacity: E_OPEN(clamp(k / 0.45)), transform: `scale(${0.34 + 0.66 * E_OPEN(k)})`, transformOrigin: origin } };
  }
  return { visible: true, style: {} };
};

// ── 窗口 ──────────────────────────────────────────────
export const Traffic = ({ tk, idle = false }: { tk: Tokens; idle?: boolean }) => (
  <span style={{ display: 'inline-flex', gap: 8, flex: '0 0 auto' }}>
    {[
      [TRAFFIC.close, '#e0443e'],
      [TRAFFIC.min, '#d89e24'],
      [TRAFFIC.zoom, '#1dad2c'],
    ].map(([c, b]) => (
      <span
        key={c}
        style={{
          width: 12,
          height: 12,
          boxSizing: 'border-box',
          borderRadius: '50%',
          background: idle ? `color-mix(in hsl, ${tk.mutedFg} 38%, ${tk.card})` : c,
          border: `1px solid ${idle ? `color-mix(in hsl, ${tk.mutedFg} 52%, ${tk.card})` : b}`,
        }}
      />
    ))}
  </span>
);

/** 三键中心（窗口内坐标）：padding 12 + 边框 1，键 12px、间隔 8px。 */
export const trafficCenter = (i: 0 | 1 | 2) => ({ x: 1 + 12 + 6 + i * 20, y: 1 + WB.titlebar / 2 });

export const WbWindow = ({
  tk,
  rect,
  title,
  focused = true,
  toolbar,
  children,
  style,
}: {
  tk: Tokens;
  rect: Rect;
  title?: string;
  focused?: boolean;
  /** 应用自绘的标题栏内容（如待办把视图标题与工具条放进标题栏）；有它时不再居中显示标题 */
  toolbar?: ReactNode;
  children: ReactNode;
  style?: CSSProperties;
}) => {
  const g = glass(tk);
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        boxSizing: 'border-box',
        borderRadius: WB.radius,
        background: tk.card,
        border: `1px solid ${tk.dark ? 'hsl(0 0% 18% / 0.85)' : 'hsl(0 0% 88% / 0.72)'}`,
        boxShadow: `inset 0 1px 0 ${tk.dark ? 'rgba(255,255,255,0.10)' : 'rgba(255,255,255,0.55)'}, ${wbShadow(tk, focused)}`,
        overflow: 'hidden',
        fontFamily: font.ui,
        ...style,
      }}
    >
      <div
        style={{
          position: 'relative',
          height: WB.titlebar,
          boxSizing: 'border-box',
          padding: '0 12px',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          background: `${g.sheen}, color-mix(in hsl, ${tk.card} ${tk.dark ? 45 : 55}%, transparent)`,
          borderBottom: `1px solid color-mix(in hsl, ${tk.border} ${tk.dark ? 60 : 45}%, transparent)`,
          fontSize: 13,
          fontWeight: 500,
          lineHeight: 1,
          color: focused ? tk.foreground : tk.mutedFg,
        }}
      >
        <Traffic tk={tk} idle={!focused} />
        {toolbar ?? <span style={{ position: 'absolute', left: 0, right: 0, textAlign: 'center' }}>{title}</span>}
        <span style={{ position: 'absolute', left: 0, right: 0, top: 0, height: 1, background: `linear-gradient(90deg, transparent 0%, ${g.highlight} 16%, ${g.highlight} 84%, transparent 100%)` }} />
      </div>
      <div style={{ position: 'absolute', left: 0, right: 0, top: WB.titlebar, bottom: 0 }}>{children}</div>
    </div>
  );
};

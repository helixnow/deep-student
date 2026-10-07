import {
  ArrowDown,
  ArrowRight,
  ArrowsOut,
  ArrowUp,
  Brain,
  Calendar,
  CalendarPlus,
  CaretDown,
  ChartBar,
  Check,
  CheckCircle,
  CheckSquare,
  Clock,
  Flag,
  Flame,
  FunnelSimple,
  GearSix,
  ListChecks,
  MagnifyingGlass,
  Pause,
  Play,
  Plus,
  Robot,
  SortAscending,
  SpeakerSlash,
  Square,
  SquaresFour,
  Timer,
  Trash,
  Tray,
  Warning,
} from '@phosphor-icons/react';
import type { CSSProperties, ReactNode } from 'react';
import { S } from '../strings';
import { font, type Tokens } from '../theme';

/**
 * 待办应用：TodoSidebar（智能视图 / 列表 / 回收站）+ TodoMainPanel（标题栏工具条、快速添加、
 * 今日复习入口、TodoItemRow）+ 底部 PomodoroPanel。默认窗口 920×660（apps/system/register.tsx）。
 * 几何取自真机 DOM 取证（video/out/cap/probe-todo.txt，窗口坐标）。
 */
export const TODO_W = 920;
export const TODO_H = 660;

/** 窗口坐标 → 内容区坐标（1px 边框 + 38px 标题栏）。 */
const at = (x: number, y: number): CSSProperties => ({ position: 'absolute', left: x - 1, top: y - 39 });
/** 窗口坐标 → 标题栏坐标。 */
const tb = (x: number, y: number): CSSProperties => ({ position: 'absolute', left: x - 1, top: y - 1 });

export type Prio = 'high' | 'medium' | 'low';
export const LIST_COLOR = { inbox: '#06b6d4', math: 'rgb(14, 165, 233)', english: 'rgb(34, 197, 94)', research: 'rgb(245, 158, 11)' } as const;

export type TodoItem = { title: string; prio: Prio; time: string; list: keyof typeof LIST_COLOR; listName: string; pomos?: [number, number] };

/** 第二天清晨的到期闪卡：昨晚 12 张新卡评了 3 张（重来 1 分钟、良好 10 分钟、简单 15 天）→ 9 张没复习的 + 2 张学习步 = 11 */
export const MORNING_DUE = 11;

export const TODO_ITEMS: TodoItem[] = [
  { title: '复习到期卡片', prio: 'medium', time: '07:30', list: 'inbox', listName: S.todo.views.inbox },
  { title: '完成高数期中模拟卷', prio: 'high', time: '09:00', list: 'math', listName: '高等数学', pomos: [0, 2] },
  { title: '雅思大作文二稿', prio: 'medium', time: '14:00', list: 'english', listName: '英语' },
  { title: '调研：大模型怎样辅助数学证明', prio: 'low', time: '20:00', list: 'research', listName: '调研' },
];

export type TodoState = {
  view: 'inbox' | 'today';
  /** 侧栏「今日」悬停 / 按下 */
  navHover: number;
  navPress: number;
  /** 第 2 行（完成高数期中模拟卷）悬停 */
  rowHover: number;
  playHover: number;
  playPress: number;
  focusing: boolean;
  /** 剩余时间 m:ss */
  remaining: string;
  /** 本轮专注进度 0–1 */
  ring: number;
};

const faint = (tk: Tokens, a: number) => `color-mix(in hsl, ${tk.mutedFg} ${a}%, transparent)`;
const fgA = (tk: Tokens, a: number) => `color-mix(in hsl, ${tk.foreground} ${a}%, transparent)`;

const Btn = ({ style, children }: { style: CSSProperties; children: ReactNode }) => (
  <span style={{ display: 'inline-flex', alignItems: 'center', boxSizing: 'border-box', whiteSpace: 'nowrap', ...style }}>{children}</span>
);

/** 标题栏工具条（TodoMainPanel 经 todoToolbarPortal 渲染进窗口标题栏）。 */
export const TodoToolbar = ({ tk, view }: { tk: Tokens; view: 'inbox' | 'today' }) => {
  const title = view === 'today' ? S.todo.views.today : S.todo.views.inbox;
  return (
    <>
      <span style={{ ...tb(80, 11.4), fontSize: 13, fontWeight: 600, lineHeight: '16px', color: tk.foreground }}>{title}</span>
      <span style={{ ...tb(80 + 13 * title.length + 10.5, 13.4), display: 'inline-flex', gap: 3.5, fontSize: 11, fontWeight: 500, lineHeight: '13px', color: faint(tk, 40), whiteSpace: 'nowrap' }}>
        <span>
          {view === 'today' ? 4 : 1} {S.todo.pending}
        </span>
        {view === 'today' ? (
          <>
            <span style={{ color: faint(tk, 30) }}>·</span>
            <span>{S.todo.pomodoroLoad(2)}</span>
          </>
        ) : null}
      </span>
      <Btn style={{ ...tb(355.5, 5.5), width: 185.5, height: 28, borderRadius: 12, background: 'hsl(0 0% 95.7%)', border: `1px solid color-mix(in hsl, ${tk.border} 70%, transparent)`, padding: '0 9px', gap: 8, fontSize: 12, color: faint(tk, 70) }}>
        <MagnifyingGlass size={14} color={faint(tk, 60)} />
        {S.todo.search}
      </Btn>
      <Btn style={{ ...tb(548, 5.5), width: 73.5, height: 28, borderRadius: 9, padding: '0 9.8px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
        <FunnelSimple size={14} />
        {S.todo.priorityFilter}
      </Btn>
      <Btn style={{ ...tb(628.5, 5.5), width: 111.5, height: 28, borderRadius: 12, background: 'hsl(0 0% 95.7%)', border: `1px solid color-mix(in hsl, ${tk.border} 70%, transparent)`, padding: '0 9.8px', gap: 7, fontSize: 12, fontWeight: 500, color: tk.foreground }}>
        <SortAscending size={14} color={tk.mutedFg} />
        {S.todo.sortManual}
        <CaretDown size={16} color={faint(tk, 70)} />
      </Btn>
      <Btn style={{ ...tb(747, 5.5), width: 95.5, height: 28, borderRadius: 9, padding: '0 9.8px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
        <CheckCircle size={14} />
        {S.todo.showCompleted}
      </Btn>
      <Btn style={{ ...tb(849.5, 5.5), width: 62.5, height: 28, borderRadius: 9, padding: '0 9.8px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
        <ListChecks size={14} />
        {S.todo.select}
      </Btn>
    </>
  );
};

const NAV: Array<{ id: string; icon: ReactNode; label: string; count?: number }> = [
  { id: 'inbox', icon: <Tray size={18} />, label: S.todo.views.inbox, count: 1 },
  { id: 'today', icon: <Calendar size={18} />, label: S.todo.views.today, count: 4 },
  { id: 'upcoming', icon: <Clock size={18} />, label: S.todo.views.upcoming },
  { id: 'matrix', icon: <SquaresFour size={18} />, label: S.todo.views.matrix },
  { id: 'overdue', icon: <Warning size={18} />, label: S.todo.views.overdue },
  { id: 'completed', icon: <CheckSquare size={18} />, label: S.todo.views.completed },
  { id: 'automation', icon: <Robot size={18} />, label: S.todo.automation },
];

const LISTS: Array<[keyof typeof LIST_COLOR, string]> = [
  ['math', '高等数学'],
  ['english', '英语'],
  ['research', '调研'],
];

const NavRow = ({ tk, y, icon, label, count, bg }: { tk: Tokens; y: number; icon: ReactNode; label: string; count?: number; bg: number }) => (
  <div style={{ ...at(8, y), width: 257, height: 32, borderRadius: 14, background: bg > 0 ? fgA(tk, 10 * bg) : 'transparent', color: tk.foreground }}>
    <span style={{ position: 'absolute', left: 7.8, top: 7, display: 'inline-flex' }}>{icon}</span>
    <span style={{ position: 'absolute', left: 32.5, top: 9, fontSize: 14, lineHeight: '14px' }}>{label}</span>
    {count ? <span style={{ position: 'absolute', right: 9.7, top: 10.5, fontSize: 11, fontWeight: 500, lineHeight: '11px', color: tk.mutedFg }}>{count}</span> : null}
  </div>
);

const Sidebar = ({ tk, s }: { tk: Tokens; s: TodoState }) => (
  <>
    <div style={{ ...at(1, 46), width: 271, height: 613, background: tk.nav }} />
    <Btn style={{ ...at(8, 56.5), width: 257, height: 28, borderRadius: 12, background: 'hsl(0 0% 95.7%)', padding: '0 8.8px', gap: 6, fontSize: 12, color: faint(tk, 70) }}>
      <MagnifyingGlass size={14} color={tk.mutedFg} />
      {S.todo.searchLists}
    </Btn>
    <Btn style={{ ...at(15, 95), height: 16, gap: 3.5, fontSize: 12, color: faint(tk, 72) }}>
      {S.todo.smartViews}
      <CaretDown size={12} color={tk.mutedFg} />
    </Btn>
    {NAV.map((n, i) => {
      const active = n.id === s.view;
      const bg = active ? 1 : n.id === 'today' ? 0.6 * s.navHover + 0.4 * s.navPress : 0;
      return <NavRow key={n.id} tk={tk} y={114.5 + 33.75 * i} icon={n.icon} label={n.label} count={n.count} bg={bg} />;
    })}
    <Btn style={{ ...at(15, 358), height: 16, gap: 3.5, fontSize: 12, color: faint(tk, 72) }}>
      {S.todo.lists}
      <CaretDown size={12} color={tk.mutedFg} />
    </Btn>
    <span style={{ ...at(241, 359), display: 'inline-flex' }}>
      <Plus size={14} color={tk.mutedFg} />
    </span>
    {LISTS.map(([id, name], i) => (
      <NavRow
        key={id}
        tk={tk}
        y={379.5 + 33.75 * i}
        icon={<span style={{ width: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}><span style={{ width: 9.9, height: 9.9, borderRadius: 999, background: LIST_COLOR[id] }} /></span>}
        label={name}
        count={1}
        bg={0}
      />
    ))}
    <div style={{ ...at(1, 615.5), width: 271, height: 1, background: `color-mix(in hsl, ${tk.border} 55%, transparent)` }} />
    <NavRow tk={tk} y={621.8} icon={<Trash size={18} />} label={S.todo.trash} bg={0} />
  </>
);

const PRIO_ICON = { high: ArrowUp, medium: ArrowRight, low: ArrowDown } as const;

const Row = ({ tk, item, top, hover = 0, playHover = 0, playPress = 0 }: { tk: Tokens; item: TodoItem; top: number; hover?: number; playHover?: number; playPress?: number }) => {
  const h = item.pomos ? 60 : 56.5;
  const prioColor = item.prio === 'low' ? tk.info : tk.warning;
  const PrioIcon = PRIO_ICON[item.prio];
  const circleTop = item.pomos ? 20.5 : 18;
  return (
    <div style={{ ...at(273, top), width: 646, height: h, background: hover > 0 ? fgA(tk, 10 * hover) : 'transparent' }}>
      <span
        style={{
          position: 'absolute',
          left: 21,
          top: circleTop,
          width: 20,
          height: 20,
          boxSizing: 'border-box',
          borderRadius: 9999,
          border: `1px solid ${item.prio === 'high' ? tk.warning : tk.border}`,
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span style={{ display: 'inline-flex', opacity: hover }}>
          <Check size={12} color={prioColor} />
        </span>
      </span>
      <span style={{ position: 'absolute', left: 51.5, top: item.pomos ? 9.8 : 9, fontSize: 12, fontWeight: 500, lineHeight: '18px', color: tk.foreground, whiteSpace: 'nowrap' }}>{item.title}</span>
      <span style={{ position: 'absolute', left: 51.5, top: item.pomos ? 31.3 : 30.5, height: 20, display: 'inline-flex', alignItems: 'center', fontSize: 11, lineHeight: '16.5px', whiteSpace: 'nowrap' }}>
        {item.pomos ? (
          <span
            style={{
              height: 20,
              boxSizing: 'border-box',
              padding: '0 8px',
              marginRight: 10.5,
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              borderRadius: 999,
              border: `1px solid color-mix(in hsl, ${tk.warning} 28%, transparent)`,
              background: `color-mix(in hsl, ${tk.warning} 8%, ${tk.card})`,
              color: tk.warning,
              fontWeight: 500,
            }}
          >
            <Brain size={12} />
            {item.pomos[0]}/{item.pomos[1]}
          </span>
        ) : null}
        <PrioIcon size={12} color={prioColor} />
        <span style={{ marginLeft: 3.5, color: tk.mutedFg }}>{S.todo.priority[item.prio]}</span>
        <span style={{ marginLeft: 10.5, display: 'inline-flex', alignItems: 'center', gap: 4, color: tk.primary, fontWeight: 500 }}>
          <Calendar size={12} weight="fill" />
          {S.todo.today} {item.time}
        </span>
      </span>
      {[
        [481.5, <Flag key="f" size={16} weight="fill" />, hover],
        [520, <CalendarPlus key="c" size={16} />, hover],
        [558.5, <Play key="p" size={16} />, 1],
        [597, <Trash key="t" size={16} />, hover],
      ].map(([x, icon, op], i) => (
        <span
          key={i}
          style={{
            position: 'absolute',
            left: x as number,
            top: h / 2 - 14,
            width: 28,
            height: 28,
            borderRadius: 9,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: i === 2 ? (hover > 0.5 ? tk.foreground : faint(tk, 45)) : tk.mutedFg,
            opacity: op as number,
            background: i === 2 && playHover > 0 ? fgA(tk, 6 * playHover + 6 * playPress) : 'transparent',
            transform: i === 2 ? `scale(${1 - 0.06 * playPress})` : undefined,
          }}
        >
          {icon as ReactNode}
        </span>
      ))}
    </div>
  );
};

/** 第 2 行「开始专注」（▷）按钮中心，窗口坐标。 */
export const todoPlayCenter = () => ({ x: 831.5 + 14, y: 211 + 30 });
/** 侧栏「今日」中心，窗口坐标。 */
export const todoTodayNavCenter = () => ({ x: 8 + 60, y: 148.3 + 16 });
/** 第 2 行中部（悬停落点），窗口坐标。 */
export const todoRowCenter = () => ({ x: 560, y: 241 });

const Ring = ({ tk, k, focusing }: { tk: Tokens; k: number; focusing: boolean }) => {
  const R = 20;
  const C = 2 * Math.PI * R;
  const a = -Math.PI / 2 + k * 2 * Math.PI;
  return (
    <span style={{ position: 'relative', width: 44, height: 44, display: 'inline-flex', alignItems: 'center', justifyContent: 'center' }}>
      <svg width={44} height={44} viewBox="0 0 44 44" style={{ position: 'absolute', inset: 0 }}>
        <circle cx={22} cy={22} r={R} fill="none" stroke={`color-mix(in hsl, ${tk.border} 70%, transparent)`} strokeWidth={3} />
        {focusing ? (
          <>
            <circle cx={22} cy={22} r={R} fill="none" stroke={tk.primary} strokeWidth={3} strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - k)} transform="rotate(-90 22 22)" />
            <circle cx={22 + R * Math.cos(a)} cy={22 + R * Math.sin(a)} r={2.6} fill={tk.primary} />
          </>
        ) : null}
      </svg>
      {focusing ? <Brain size={14} color={tk.primary} /> : <Timer size={14} color={tk.mutedFg} />}
    </span>
  );
};

/** 底部番茄钟条（PomodoroPanel 的嵌入形态）：空闲 = 时长选择 +「开始」；专注中 = 任务名 + 倒计时 + 暂停。 */
const PomodoroBar = ({ tk, s }: { tk: Tokens; s: TodoState }) => (
  <>
    <div style={{ ...at(273, 571), width: 646, height: 1, background: `color-mix(in hsl, ${tk.border} 35%, transparent)` }} />
    {s.focusing ? (
      <>
        <Btn style={{ ...at(294, 594.8), height: 16.5, gap: 3.5, fontSize: 11, fontWeight: 500, color: tk.primary }}>
          <Brain size={14} />
          {S.todo.pomoFocusing}
        </Btn>
        <Btn style={{ ...at(354, 592.5), height: 22, padding: '0 9px', borderRadius: 999, border: `1px solid ${tk.border}`, background: tk.card, fontSize: 11, fontWeight: 500, color: tk.foreground }}>{TODO_ITEMS[1].title}</Btn>
        <span style={{ ...at(480, 581) }}>
          <Ring tk={tk} k={s.ring} focusing />
        </span>
        <span style={{ ...at(536, 592), fontSize: 16, fontWeight: 650, lineHeight: '20px', color: tk.foreground, fontVariantNumeric: 'tabular-nums' }}>{s.remaining}</span>
        <span style={{ ...at(589, 596), fontSize: 11, lineHeight: '13px', color: tk.mutedFg, fontVariantNumeric: 'tabular-nums' }}>/ 25:00</span>
        <span style={{ ...at(697, 596), display: 'inline-flex', color: tk.mutedFg }}>
          <Square size={14} />
        </span>
        <Btn style={{ ...at(724, 590.8), height: 24.5, padding: '0 6px', gap: 5, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
          <Pause size={14} />
          {S.todo.pomoPause}
        </Btn>
        {[
          [797, <SpeakerSlash key="a" size={14} />],
          [823, <ArrowsOut key="b" size={14} />],
          [849, <ChartBar key="c" size={14} />],
          [877, <GearSix key="d" size={14} />],
        ].map(([x, icon], i) => (
          <span key={i} style={{ ...at(x as number, 596), display: 'inline-flex', color: tk.mutedFg }}>
            {icon as ReactNode}
          </span>
        ))}
      </>
    ) : (
      <>
        <Btn style={{ ...at(294, 594.8), height: 16.5, gap: 3.5, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
          <Timer size={14} />
          {S.todo.pomoIdle}
        </Btn>
        <span style={{ ...at(356.8, 581) }}>
          <Ring tk={tk} k={0} focusing={false} />
        </span>
        <span style={{ ...at(411.3, 591.5), fontSize: 14, fontWeight: 600, lineHeight: '21px', color: tk.mutedFg, fontVariantNumeric: 'tabular-nums' }}>25:00</span>
        {[
          [459, '15'],
          [492.8, '25'],
          [526.9, '45'],
          [560.7, '60'],
        ].map(([x, v]) => (
          <span key={v} style={{ ...at(x as number, 589.9), width: 30.3, height: 26.3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, fontWeight: v === '25' ? 600 : 500, color: v === '25' ? tk.primary : tk.mutedFg }}>
            {v}
          </span>
        ))}
        <span style={{ ...at(594.5, 597), fontSize: 10, lineHeight: '12px', color: faint(tk, 60) }}>{S.todo.minutes}</span>
        <Btn style={{ ...at(748, 589.9), width: 66, height: 26.3, padding: '0 11.5px', gap: 7, fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
          <Play size={14} />
          {S.todo.pomoStart}
        </Btn>
        {[
          [822.8, <SpeakerSlash key="a" size={14} />],
          [850.8, <ChartBar key="b" size={14} />],
          [878.8, <GearSix key="c" size={14} />],
        ].map(([x, icon], i) => (
          <span key={i} style={{ ...at(x as number, 596), display: 'inline-flex', color: tk.mutedFg }}>
            {icon as ReactNode}
          </span>
        ))}
      </>
    )}
    <span style={{ ...at(294, 636), display: 'inline-flex' }}>
      <Flame size={12} color={tk.warning} />
    </span>
    <span style={{ ...at(311.3, 633.8), fontSize: 11, lineHeight: '16.5px', color: tk.mutedFg, whiteSpace: 'nowrap' }}>
      {S.todo.pomoToday} <b style={{ fontWeight: 600, color: tk.foreground }}>0</b>/8 {S.todo.pomoUnit}
    </span>
    <span style={{ ...at(399.1, 640.3), width: 56, height: 3.5, borderRadius: 9999, background: `color-mix(in hsl, ${tk.border} 55%, transparent)` }} />
  </>
);

/**
 * 番茄钟窗口（pomodoroSource 投射，380×560）：从待办「开始专注」后在下一个级联槽位后台开窗，
 * 恰好被待办窗口整个挡住（见优化建议 5）；片中只在「显示桌面」一起最小化时露出一瞬。
 */
export const POMO_RECT = { x: 72, y: 112, w: 380, h: 560 } as const;
export const pomoTitle = `${S.todo.pomoFocusing} · ${TODO_ITEMS[1].title}`;

export const PomodoroWindowBody = ({ tk, remaining, ring }: { tk: Tokens; remaining: string; ring: number }) => {
  const R = 88;
  const C = 2 * Math.PI * R;
  const a = -Math.PI / 2 + ring * 2 * Math.PI;
  return (
    <div style={{ position: 'absolute', inset: 0, background: tk.background, fontFamily: font.ui }}>
      <span style={{ position: 'absolute', left: 0, right: 0, top: 64, display: 'flex', justifyContent: 'center' }}>
        <span style={{ height: 24, padding: '0 10px', display: 'inline-flex', alignItems: 'center', gap: 5, borderRadius: 999, background: `color-mix(in hsl, ${tk.primary} 10%, transparent)`, color: tk.primary, fontSize: 11, fontWeight: 500 }}>
          <Brain size={12} />
          {S.todo.pomoFocusing}
        </span>
      </span>
      <svg width={200} height={200} viewBox="0 0 200 200" style={{ position: 'absolute', left: 89, top: 96 }}>
        <circle cx={100} cy={100} r={R} fill="none" stroke={`color-mix(in hsl, ${tk.border} 70%, transparent)`} strokeWidth={6} />
        <circle cx={100} cy={100} r={R} fill="none" stroke={tk.primary} strokeWidth={6} strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - ring)} transform="rotate(-90 100 100)" />
        <circle cx={100 + R * Math.cos(a)} cy={100 + R * Math.sin(a)} r={4.5} fill={tk.primary} />
      </svg>
      <span style={{ position: 'absolute', left: 0, right: 0, top: 168, textAlign: 'center', fontSize: 40, fontWeight: 700, letterSpacing: '0.02em', color: tk.foreground, fontVariantNumeric: 'tabular-nums' }}>{remaining}</span>
      <span style={{ position: 'absolute', left: 0, right: 0, top: 222, textAlign: 'center', fontSize: 12, color: tk.mutedFg }}>/ 25:00</span>
      <span style={{ position: 'absolute', left: 0, right: 0, top: 322, display: 'flex', justifyContent: 'center' }}>
        <span style={{ height: 24, padding: '0 12px', display: 'inline-flex', alignItems: 'center', borderRadius: 999, background: tk.muted, color: tk.foreground, fontSize: 11 }}>{TODO_ITEMS[1].title}</span>
      </span>
      <span style={{ position: 'absolute', left: 0, right: 0, top: 360, display: 'flex', justifyContent: 'center', gap: 6 }}>
        {[0, 1, 2, 3].map((i) => (
          <i key={i} style={{ width: 5, height: 5, boxSizing: 'border-box', borderRadius: '50%', border: i === 0 ? `1px solid ${tk.primary}` : 'none', background: i === 0 ? 'transparent' : `color-mix(in hsl, ${tk.mutedFg} 35%, transparent)` }} />
        ))}
      </span>
      <span style={{ position: 'absolute', left: 16, top: 448, display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: tk.mutedFg }}>
        <Flame size={12} color={tk.warning} />
        {S.todo.pomoToday} <b style={{ fontWeight: 600, color: tk.foreground }}>0</b>/8 {S.todo.pomoUnit}
        <span style={{ marginLeft: 6, width: 56, height: 3.5, borderRadius: 999, background: `color-mix(in hsl, ${tk.border} 55%, transparent)` }} />
      </span>
      <span style={{ position: 'absolute', right: 16, top: 448, display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11, color: tk.mutedFg }}>
        <ChartBar size={12} />
        {S.todo.pomoStats}
      </span>
      <div style={{ position: 'absolute', left: 0, right: 0, top: 476, height: 1, background: `color-mix(in hsl, ${tk.border} 40%, transparent)` }} />
      <span style={{ position: 'absolute', left: 16, right: 16, top: 488, display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: tk.mutedFg, fontSize: 11 }}>
        <GearSix size={14} />
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 18 }}>
          <Square size={14} />
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontWeight: 500 }}>
            <Pause size={14} />
            {S.todo.pomoPause}
          </span>
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 14 }}>
          <ArrowsOut size={14} />
          <SpeakerSlash size={14} />
        </span>
      </span>
    </div>
  );
};

export const TodoApp = ({ tk, s }: { tk: Tokens; s: TodoState }) => {
  const today = s.view === 'today';
  const rowTops = today ? [155.3, 211, 271, 327.5] : [98.6];
  const items = today ? TODO_ITEMS : [TODO_ITEMS[0]];
  return (
    <div style={{ position: 'absolute', inset: 0, background: tk.background, fontFamily: font.ui, overflow: 'hidden' }}>
      <Sidebar tk={tk} s={s} />
      <span style={{ ...at(294, 55.8), display: 'inline-flex' }}>
        <Plus size={16} color={tk.mutedFg} />
      </span>
      <span style={{ ...at(320, 54.5), fontSize: 13, lineHeight: '19px', color: faint(tk, 70), whiteSpace: 'nowrap' }}>{S.todo.quickAdd}</span>
      <div style={{ ...at(273, 88.5), width: 646, height: 1, background: `color-mix(in hsl, ${tk.border} 20%, transparent)` }} />
      {today ? (
        <div style={{ ...at(294, 100), width: 230.8, height: 55.5, boxSizing: 'border-box', borderRadius: 12, border: `1px solid color-mix(in hsl, ${tk.border} 40%, transparent)` }}>
          <span style={{ position: 'absolute', left: 16.5, top: 18.8, display: 'inline-flex' }}>
            <Brain size={16} color={tk.info} />
          </span>
          <span style={{ position: 'absolute', left: 49, top: 8.8, fontSize: 13, fontWeight: 500, lineHeight: '19.5px', color: tk.foreground, whiteSpace: 'nowrap' }}>{S.todo.reviewTitle(MORNING_DUE)}</span>
          <span style={{ position: 'absolute', left: 49, top: 28.3, fontSize: 11, lineHeight: '16.5px', color: tk.mutedFg }}>{S.todo.reviewCards(MORNING_DUE)}</span>
          <span style={{ position: 'absolute', left: 171.6, top: 18.5, display: 'inline-flex', alignItems: 'center', gap: 2, fontSize: 11, lineHeight: '16.5px', color: tk.mutedFg }}>
            {S.todo.reviewAction}
            <ArrowRight size={12} />
          </span>
        </div>
      ) : null}
      {items.map((item, i) => (
        <Row
          key={item.title}
          tk={tk}
          item={item}
          top={rowTops[i]}
          hover={today && i === 1 ? s.rowHover : 0}
          playHover={today && i === 1 ? s.playHover : 0}
          playPress={today && i === 1 ? s.playPress : 0}
        />
      ))}
      <PomodoroBar tk={tk} s={s} />
    </div>
  );
};

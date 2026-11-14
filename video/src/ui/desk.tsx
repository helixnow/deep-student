import { ArrowRight, CaretLeft, CaretRight, Check, Plus, Sparkle, TrendUp } from '@phosphor-icons/react';
import essayIcon from '@app/features/workbench/icons/app-icons/essay.svg';
import examIcon from '@app/features/workbench/icons/app-icons/exam.svg';
import mindmapIcon from '@app/features/workbench/icons/app-icons/mindmap.svg';
import notesIcon from '@app/features/workbench/icons/app-icons/notes.svg';
import translationIcon from '@app/features/workbench/icons/app-icons/translation.svg';
import type { CSSProperties, ReactNode } from 'react';
import { Img } from 'remotion';
import { S } from '../strings';
import { font, type Tokens } from '../theme';
import { LIST_COLOR, type TodoItem } from './todo';
import { glassOf, wbShadow } from './workbench';

/**
 * 桌面层（壁纸之上、窗口之下）：
 * - 左列默认快捷方式（desktopStore.initDefaultShortcuts 的 5 个应用入口，DesktopShortcuts.css：92×106 网格、52px 插画瓷贴、白字投影）；
 * - 右列小组件（DesktopAgendaWidget 日历与日程 + DesktopAiBriefingWidget AI 学习简报，wb-glass 材质，有可见窗口时淡到 0.55）。
 */
export const SHORTCUTS = [
  { id: 'note', label: S.desk.shortcut.note, icon: notesIcon },
  { id: 'exam', label: S.desk.shortcut.exam, icon: examIcon },
  { id: 'essay', label: S.desk.shortcut.essay, icon: essayIcon },
  { id: 'translation', label: S.desk.shortcut.translation, icon: translationIcon },
  { id: 'mindmap', label: S.desk.shortcut.mindmap, icon: mindmapIcon },
] as const;
export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

const CELL = { x: 16, y: 56, w: 92, h: 106, step: 112 } as const;

/** 快捷方式图标中心（屏幕坐标）。 */
export const shortcutCenter = (id: ShortcutId) => {
  const i = SHORTCUTS.findIndex((s) => s.id === id);
  return { x: CELL.x + CELL.w / 2, y: CELL.y + CELL.step * i + 8 + 26 };
};

export const DesktopShortcuts = ({ tk, selected, pressed }: { tk: Tokens; selected?: { id: ShortcutId; k: number }; pressed?: { id: ShortcutId; k: number } }) => (
  <>
    {SHORTCUTS.map((s, i) => {
      const sel = selected?.id === s.id ? selected.k : 0;
      const pr = pressed?.id === s.id ? pressed.k : 0;
      return (
        <div
          key={s.id}
          style={{
            position: 'absolute',
            left: CELL.x,
            top: CELL.y + CELL.step * i,
            width: CELL.w,
            height: CELL.h,
            boxSizing: 'border-box',
            padding: '8px 4px 6px',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 4,
            borderRadius: 10,
            background: sel > 0 ? `color-mix(in hsl, ${tk.foreground} ${14 * sel}%, transparent)` : 'transparent',
            fontFamily: font.ui,
          }}
        >
          <span style={{ display: 'inline-flex', transform: `scale(${1 - 0.06 * pr})` }}>
            <span
              style={{
                width: 52,
                height: 52,
                borderRadius: '22.5%',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: 'linear-gradient(180deg, #ffffff, #eef1f5)',
                boxShadow: 'inset 0 0 0 0.5px rgba(31, 41, 55, 0.16)',
              }}
            >
              <Img src={s.icon} style={{ width: '78%', height: '78%', objectFit: 'contain' }} />
            </span>
          </span>
          <span
            style={{
              maxWidth: 84,
              fontSize: 12,
              lineHeight: 1.25,
              fontWeight: 500,
              textAlign: 'center',
              color: '#fff',
              borderRadius: 5,
              padding: sel > 0.5 ? '0 4px' : 0,
              background: sel > 0.5 ? `color-mix(in hsl, ${tk.primary} 92%, transparent)` : 'transparent',
              textShadow: sel > 0.5 ? 'none' : '0 1px 2px rgba(0,0,0,0.65), 0 0 6px rgba(0,0,0,0.35)',
            }}
          >
            {s.label}
          </span>
        </div>
      );
    })}
  </>
);

// ── 右列小组件 ─────────────────────────────────────────
export const AGENDA_RECT = { x: 1556, y: 58, w: 340, h: 424 } as const;
export const BRIEF_RECT = { x: 1556, y: 494, w: 340, h: 286 } as const;

const Panel = ({ tk, rect, dim, padding, children }: { tk: Tokens; rect: { x: number; y: number; w: number; h: number }; dim: number; padding: string; children: ReactNode }) => {
  const g = glassOf(tk);
  return (
    <div
      style={{
        position: 'absolute',
        left: rect.x,
        top: rect.y,
        width: rect.w,
        height: rect.h,
        boxSizing: 'border-box',
        padding,
        borderRadius: 18,
        backgroundColor: g.bg,
        backgroundImage: g.sheen,
        backdropFilter: g.blur,
        border: `1px solid ${g.border}`,
        boxShadow: `inset 0 1px 0 ${g.highlight}, ${wbShadow(tk, false)}`,
        color: tk.foreground,
        fontFamily: font.ui,
        opacity: 1 - 0.45 * dim,
        overflow: 'hidden',
      }}
    >
      {children}
    </div>
  );
};

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日'];
/** 2026 年 10 月：周一起排，9/28 – 11/1 五行（当月只需五行时不再补第六行，见优化建议 2）。 */
const DAYS: Array<{ d: number; outside: boolean }> = Array.from({ length: 35 }, (_, i) => {
  if (i < 3) return { d: 28 + i, outside: true };
  if (i < 34) return { d: i - 2, outside: false };
  return { d: 1, outside: true };
});
const ROW_H = 32.5;
/** 「待办 →」按钮中心（屏幕坐标）：五行月历下的列表头右端。 */
export const agendaOpenCenter = () => ({ x: AGENDA_RECT.x + AGENDA_RECT.w - 17 - 20, y: AGENDA_RECT.y + 1 + 16 + 44 + 12 + 18 + 5 * ROW_H + 4 + 10 + 1 + 9 + 12 });

const iconBtn = (tk: Tokens, add = false): CSSProperties => ({
  width: 27,
  height: 27,
  borderRadius: 7,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  color: add ? tk.primary : tk.mutedFg,
  background: add ? `color-mix(in hsl, ${tk.primary} 13%, transparent)` : 'transparent',
  marginLeft: add ? 2 : 0,
});

const MAX_LIST = 2;

/**
 * items：10 月 3 日仍未完成的待办（「N 项待安排」、当天圆点与列表都由它算）。
 * day = 2：前一晚（10 月 2 日周五），当天的待办都已完成，列表是空态；
 * day = 3：第二天，列前 2 条，其余折进「还有 N 项」（见优化建议 2）。
 */
export const AgendaWidget = ({ tk, dim = 0, day = 3, items, openPress = 0 }: { tk: Tokens; dim?: number; day?: 2 | 3; items: TodoItem[]; openPress?: number }) => {
  const todayIndex = day === 3 ? 5 : 4;
  return (
  <Panel tk={tk} rect={AGENDA_RECT} dim={dim} padding="16px">
    <div style={{ minHeight: 44, display: 'flex', alignItems: 'center', gap: 12 }}>
      <span style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 2 }}>
        <strong style={{ fontSize: 14, fontWeight: 650, lineHeight: '21px' }}>2026年10月</strong>
        <small style={{ fontSize: 10, lineHeight: '15px', color: tk.mutedFg }}>{S.desk.agendaPending(items.length)}</small>
      </span>
      <span style={{ display: 'inline-flex', gap: 3, opacity: 0.68 }}>
        <span style={iconBtn(tk)}>
          <CaretLeft size={15} weight="bold" />
        </span>
        <span style={iconBtn(tk)}>
          <CaretRight size={15} weight="bold" />
        </span>
        <span style={iconBtn(tk, true)}>
          <Plus size={16} weight="bold" />
        </span>
      </span>
    </div>
    <div style={{ marginTop: 12, display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))' }}>
      {WEEKDAYS.map((w) => (
        <span key={w} style={{ height: 18, lineHeight: '18px', textAlign: 'center', fontSize: 9, fontWeight: 600, color: tk.mutedFg }}>
          {w}
        </span>
      ))}
    </div>
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0, 1fr))', rowGap: 1 }}>
      {DAYS.map((cell, i) => {
        const today = i === todayIndex;
        return (
          <span
            key={i}
            style={{
              height: ROW_H,
              position: 'relative',
              borderRadius: 8,
              background: today ? `color-mix(in hsl, ${tk.foreground} 10%, transparent)` : 'transparent',
              opacity: cell.outside ? 0.35 : 1,
              fontSize: 14,
              textAlign: 'center',
              lineHeight: `${ROW_H - 6}px`,
              color: today ? tk.destructive : tk.foreground,
              fontWeight: today ? 750 : 400,
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {cell.d}
            {i === 5 ? (
              <span style={{ position: 'absolute', left: 0, right: 0, bottom: 5, display: 'flex', justifyContent: 'center', gap: 2 }}>
                {items.slice(0, 3).map((it) => (
                  <i key={it.title} style={{ width: 3, height: 3, borderRadius: '50%', background: LIST_COLOR[it.list] }} />
                ))}
              </span>
            ) : null}
          </span>
        );
      })}
    </div>
    <div style={{ height: 1, margin: '10px 0 9px', background: `color-mix(in hsl, ${tk.border} 32%, transparent)` }} />
    <div style={{ minHeight: 24, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
      <strong style={{ fontSize: 12, fontWeight: 650 }}>{day === 3 ? '10月3日周六' : '10月2日周五'}</strong>
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, padding: '4px 2px', fontSize: 10, fontWeight: 600, color: tk.primary, opacity: 0.9 + 0.1 * openPress, transform: `scale(${1 - 0.05 * openPress})` }}>
        {S.desk.agendaOpen}
        <ArrowRight size={13} weight="bold" />
      </span>
    </div>
    {day === 2 ? (
      <div style={{ marginTop: 4, minHeight: 88, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 7, fontSize: 10, color: tk.mutedFg }}>
        <Check size={16} weight="bold" />
        <span>{S.desk.agendaClear}</span>
      </div>
    ) : (
    <div style={{ marginTop: 4 }}>
      {items.slice(0, MAX_LIST).map((it) => (
        <div key={it.title} style={{ minHeight: 38, display: 'flex', alignItems: 'center', gap: 7 }}>
          <span style={{ width: 28, height: 34, flex: '0 0 28px', display: 'grid', placeItems: 'center' }}>
            <span style={{ width: 13, height: 13, boxSizing: 'border-box', borderRadius: '50%', border: `1.5px solid ${LIST_COLOR[it.list]}`, background: `color-mix(in hsl, ${tk.background} 22%, transparent)` }} />
          </span>
          <span style={{ minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 2, padding: '4px 5px 4px 0' }}>
            <span style={{ fontSize: 11, fontWeight: 560, lineHeight: '16.5px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{it.title}</span>
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 9, lineHeight: '13.5px', color: tk.mutedFg, whiteSpace: 'nowrap' }}>
              <i style={{ width: 3, height: 3, borderRadius: '50%', background: LIST_COLOR[it.list] }} />
              <span>{it.listName}</span>
              <span>·</span>
              <span>{it.time}</span>
            </span>
          </span>
        </div>
      ))}
      {items.length > MAX_LIST ? (
        <span style={{ display: 'inline-block', marginTop: 2, marginLeft: 35, fontSize: 10, fontWeight: 600, color: tk.primary, opacity: 0.85 }}>{S.desk.agendaMore(items.length - MAX_LIST)}</span>
      ) : null}
    </div>
    )}
  </Panel>
  );
};

const Card = ({ tk, children, style }: { tk: Tokens; children: ReactNode; style?: CSSProperties }) => (
  <div
    style={{
      boxSizing: 'border-box',
      padding: 15,
      borderRadius: 12,
      background: tk.card,
      border: `1px solid color-mix(in hsl, ${tk.border} 60%, transparent)`,
      ...style,
    }}
  >
    {children}
  </div>
);

/**
 * AI 学习简报（generative-ui 意图 buildLearningBriefingIntent）。片中画修正后的样子（见优化建议 3、4）：
 * 待办进度改为「今日已完成 / 今日总数」，去掉重复的数据表。
 */
export const BriefingWidget = ({ tk, dim = 0, due, done, total }: { tk: Tokens; dim?: number; due: number; done: number; total: number }) => (
  <Panel tk={tk} rect={BRIEF_RECT} dim={dim} padding="12px 14px">
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 13, fontWeight: 600, lineHeight: '22px' }}>
      <Sparkle size={16} weight="fill" color={tk.primary} />
      {S.desk.briefing}
    </div>
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <Card tk={tk}>
        <div style={{ fontSize: 12, fontWeight: 600, lineHeight: '12px', color: tk.mutedFg }}>{S.desk.dueTitle}</div>
        <div style={{ marginTop: 7, fontSize: 20, fontWeight: 600, lineHeight: '30px', fontVariantNumeric: 'tabular-nums' }}>{due}</div>
        <div style={{ marginTop: 3.5, display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, lineHeight: '16.5px', color: tk.mutedFg }}>
          <TrendUp size={14} color={tk.success} />
          {S.desk.dueTrend}
        </div>
      </Card>
      <Card tk={tk}>
        <div style={{ fontSize: 12, fontWeight: 600, lineHeight: '12px' }}>{S.desk.progressTitle}</div>
        <div style={{ marginTop: 12, height: 8, borderRadius: 999, background: `color-mix(in hsl, ${tk.primary} 14%, transparent)`, overflow: 'hidden' }}>
          <div style={{ width: `${(done / total) * 100}%`, height: '100%', borderRadius: 999, background: tk.primary }} />
        </div>
        <div style={{ marginTop: 6, display: 'flex', justifyContent: 'space-between', fontSize: 11, lineHeight: '16.5px', color: tk.mutedFg, fontVariantNumeric: 'tabular-nums' }}>
          <span>{S.todo.progress(done, total)}</span>
          <span>{Math.round((done / total) * 100)}%</span>
        </div>
      </Card>
      <div style={{ display: 'flex', gap: 4 }}>
        {[S.desk.startReview, S.desk.openQbank].map((label) => (
          <span key={label} style={{ height: 28, padding: '0 11.5px', display: 'inline-flex', alignItems: 'center', fontSize: 11, fontWeight: 500, color: tk.mutedFg }}>
            {label}
          </span>
        ))}
      </div>
    </div>
  </Panel>
);

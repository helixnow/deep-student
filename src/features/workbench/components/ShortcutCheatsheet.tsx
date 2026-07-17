/**
 * ShortcutCheatsheet — 快捷键速查表玻璃浮层（O12）
 *
 * 触发（useWorkbenchShortcuts 驱动 overlay store）：
 * - `?` 切换常驻显示（sticky）；
 * - 长按 Ctrl+Alt（700ms）临时显示，松开修饰键即收起；
 * - Esc / 点击背景 / 右上角关闭按钮关闭。
 *
 * 展示：按 listWorkbenchShortcutGroups() 分组，行 = 描述 + 键帽可视化；
 * 收到 `workbench:shortcut-feedback` 事件时对应行短暂高亮（帮助用户
 * 在速查表打开时确认刚触发的快捷键）。
 *
 * 挂载：与 WindowSwitcher 同层级，渲染在桌面容器内（absolute inset-0），
 * 由 O20 在 WorkbenchDesktop 接线：`<ShortcutCheatsheet />`。
 * 动画仅 transform/opacity；reduced-motion / minimal 材质档下时长归零。
 */
import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  listWorkbenchShortcutGroups,
  useWorkbenchOverlay,
  WORKBENCH_SHORTCUT_FEEDBACK_EVENT,
  type WorkbenchShortcutFeedbackDetail,
  type WorkbenchShortcutId,
} from '../core/shortcuts';
import { useFocusReturn } from '../hooks/useWorkbenchA11y';
import './ShortcutCheatsheet.css';

/** 关闭后保留 DOM 播放退场动画的时长（与 CSS --wb-cheat-duration 对齐） */
export const CHEATSHEET_EXIT_MS = 200;

/** 行高亮持续时长 */
const ROW_FLASH_MS = 650;

const Keycaps: React.FC<{ parts: string[] }> = ({ parts }) => (
  <span className="wb-cheat-keys">
    {parts.map((part, i) => (
      <React.Fragment key={`${part}-${i}`}>
        {i > 0 && (
          <span className="wb-cheat-key-sep" aria-hidden="true">
            +
          </span>
        )}
        <kbd className="wb-cheat-key">{part}</kbd>
      </React.Fragment>
    ))}
  </span>
);

const CHEAT_FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const ShortcutCheatsheetComponent: React.FC = () => {
  const { t } = useTranslation();
  const open = useWorkbenchOverlay((s) => s.cheatsheetOpen);
  const closeCheatsheet = useWorkbenchOverlay((s) => s.closeCheatsheet);

  /** 退场动画期间保持挂载 */
  const [rendered, setRendered] = useState(open);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);

  /** 最近触发的快捷键行（feedback 事件驱动的短暂高亮） */
  const [flashId, setFlashId] = useState<WorkbenchShortcutId | null>(null);
  const flashTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useFocusReturn(open);

  useEffect(() => {
    if (open) {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
      setRendered(true);
      return undefined;
    }
    if (!rendered) return undefined;
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      setRendered(false);
    }, CHEATSHEET_EXIT_MS);
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current);
        exitTimerRef.current = null;
      }
    };
  }, [open, rendered]);

  useEffect(() => {
    if (!rendered) return undefined;
    const onFeedback = (e: Event) => {
      const detail = (e as CustomEvent<WorkbenchShortcutFeedbackDetail>).detail;
      if (!detail?.shortcutId) return;
      if (flashTimerRef.current) clearTimeout(flashTimerRef.current);
      setFlashId(detail.shortcutId);
      flashTimerRef.current = setTimeout(() => {
        flashTimerRef.current = null;
        setFlashId(null);
      }, ROW_FLASH_MS);
    };
    window.addEventListener(WORKBENCH_SHORTCUT_FEEDBACK_EVENT, onFeedback);
    return () => {
      window.removeEventListener(WORKBENCH_SHORTCUT_FEEDBACK_EVENT, onFeedback);
      if (flashTimerRef.current) {
        clearTimeout(flashTimerRef.current);
        flashTimerRef.current = null;
      }
    };
  }, [rendered]);

  // 打开时聚焦面板；Tab 在面板内循环（轻量焦点陷阱）
  useEffect(() => {
    if (!open) return undefined;
    const panel = panelRef.current;
    if (!panel) return undefined;

    const focusInitial = () => {
      const closeBtn = panel.querySelector<HTMLElement>('.wb-cheat-close');
      const target = closeBtn ?? panel;
      try {
        target.focus({ preventScroll: true });
      } catch {
        target.focus();
      }
    };
    // 等挂载/入场一帧后再聚焦，避免与退场重开竞态
    const raf = window.requestAnimationFrame(focusInitial);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const items = Array.from(
        panel.querySelectorAll<HTMLElement>(CHEAT_FOCUSABLE),
      ).filter((el) => el.offsetParent !== null || el === panel);
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (e.shiftKey) {
        if (!active || active === first || !panel.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else if (!active || active === last || !panel.contains(active)) {
        e.preventDefault();
        first.focus();
      }
    };

    panel.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(raf);
      panel.removeEventListener('keydown', onKeyDown);
    };
  }, [open, rendered]);

  if (!rendered) return null;

  const groups = listWorkbenchShortcutGroups();

  return (
    <div className="wb-cheat-root" data-wb-cheat-open={open ? 'true' : 'false'}>
      <div
        className="wb-cheat-backdrop"
        data-wb-cheat-backdrop
        onClick={closeCheatsheet}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        className="wb-glass wb-glass-highlight wb-cheat-panel"
        role="dialog"
        aria-modal="true"
        aria-label={t('workbench:cheatsheet.title')}
        tabIndex={-1}
      >
        <div className="wb-cheat-header">
          <h2 className="wb-cheat-title">{t('workbench:cheatsheet.title')}</h2>
          <button
            type="button"
            className="wb-cheat-close wb-focus-ring"
            onClick={closeCheatsheet}
            aria-label={t('workbench:cheatsheet.close')}
          >
            <svg viewBox="0 0 12 12" width="10" height="10" aria-hidden="true">
              <path
                d="M2 2 L10 10 M10 2 L2 10"
                stroke="currentColor"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="wb-cheat-groups">
          {groups.map((group) => (
            <section key={group.id} className="wb-cheat-group" aria-label={t(group.labelKey, group.defaultLabel)}>
              <h3 className="wb-cheat-group-title">{t(group.labelKey, group.defaultLabel)}</h3>
              <ul className="wb-cheat-rows">
                {group.shortcuts.map((s) => (
                  <li
                    key={s.id}
                    className={`wb-cheat-row${flashId === s.id ? ' wb-cheat-row-flash' : ''}`}
                    data-wb-cheat-shortcut={s.id}
                  >
                    <span className="wb-cheat-desc">{t(s.descriptionKey, s.defaultDescription)}</span>
                    <Keycaps parts={s.keyParts} />
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>

        <div className="wb-cheat-footer">
          {t('workbench:cheatsheet.hint')}
        </div>
      </div>
    </div>
  );
};

export const ShortcutCheatsheet = React.memo(ShortcutCheatsheetComponent);
ShortcutCheatsheet.displayName = 'ShortcutCheatsheet';

export default ShortcutCheatsheet;

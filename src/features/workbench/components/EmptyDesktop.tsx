/**
 * 空桌面引导（A4：4 步首启 tour）
 * ---------------------------------------------------------------------------
 * 桌面上没有任何窗口时展示的轻量引导：
 * - 主 CTA（打开资源库）**始终在**——tour 关掉的只是 tour，空桌面不该变成
 *   一块什么都点不到的壁纸；
 * - 4 步 tour：Dock 应用 → ⌘K/Ctrl+K 搜索 → 状态栏 → Agent 控制；
 *   「跳过」仅本会话隐藏，「不再显示」/「完成」写入 localStorage 永久消隐，
 *   两者都只作用于 tour 区块；
 * - 桌面右键菜单的「重新查看引导」经 replayEmptyDesktopTour 复活 tour；
 * - 可选的「恢复上次桌面」次级 CTA：由 WorkbenchDesktop 在探测到可用快照时
 *   下发（不翻转「启动时恢复上次桌面」这个设置的默认值）；
 * - 整层 pointer-events: none，仅 CTA / tour 控件恢复指针，
 *   不拦截桌面右键 / 双击手势。
 *
 * 2026-08 打磨：
 * - 再入口：关闭后可从快捷键速查表底部「重新播放快速上手」重看
 *   （replayEmptyDesktopTour 清持久化位并广播事件，本组件监听后复位）；
 * - 不指向隐藏项：菜单栏 autohide 开启时状态栏不可见，跳过 statusBar 步
 *   （步数与进度随之收缩），tour 不再指向一个看不见的目标。
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppWindow,
  ClockCounterClockwise,
  FolderOpen,
  Keyboard,
  Pulse,
  Robot,
  SquaresFour,
} from '@phosphor-icons/react';
import { isMacOS } from '@/utils/platform';
import { workbenchBus } from '../core/workbenchBus';
import { useMenuBarAutohide } from './menuBarAutohideStore';
import '../styles/workbench.css';
import './EmptyDesktop.css';

/** 首次使用 onboarding 的记忆位（本地 UI 偏好，不进设置后端/快照） */
export const EMPTY_DESKTOP_ONBOARDING_KEY = 'workbench.emptyDesktop.onboardingDismissed';

/** tour 再入口广播事件（速查表「重新播放快速上手」触发） */
export const EMPTY_DESKTOP_TOUR_REPLAY_EVENT = 'workbench:empty-tour-replay';
/** leftovers 桌面菜单使用过的事件名；保留兼容已发出的自定义事件。 */
export const EMPTY_DESKTOP_REPLAY_TOUR_EVENT = 'workbench:empty-desktop-replay-tour';

/**
 * 重新播放空桌面 tour：清持久化消隐位并通知已挂载的 EmptyDesktop 复位。
 * 桌面上仍有窗口时 EmptyDesktop 未挂载——此时只清标记，
 * 下次桌面清空时 tour 自然重新出现。
 */
export function replayEmptyDesktopTour(): void {
  try {
    localStorage.removeItem(EMPTY_DESKTOP_ONBOARDING_KEY);
  } catch {
    /* 存储不可用时仅广播事件 */
  }
  window.dispatchEvent(new CustomEvent(EMPTY_DESKTOP_TOUR_REPLAY_EVENT));
}

const TOUR_STEP_IDS = ['dock', 'search', 'statusBar', 'agent'] as const;
export type EmptyDesktopTourStepId = (typeof TOUR_STEP_IDS)[number];

const TOUR_ICONS: Record<EmptyDesktopTourStepId, React.ReactNode> = {
  dock: <AppWindow size={22} weight="duotone" aria-hidden="true" />,
  search: <Keyboard size={22} weight="duotone" aria-hidden="true" />,
  statusBar: <Pulse size={22} weight="duotone" aria-hidden="true" />,
  agent: <Robot size={22} weight="duotone" aria-hidden="true" />,
};

function readOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(EMPTY_DESKTOP_ONBOARDING_KEY) === '1';
  } catch {
    return false;
  }
}

function persistOnboardingDismissed(dismissed: boolean): void {
  try {
    if (dismissed) localStorage.setItem(EMPTY_DESKTOP_ONBOARDING_KEY, '1');
    else localStorage.removeItem(EMPTY_DESKTOP_ONBOARDING_KEY);
  } catch {
    /* 存储不可用时仅本次会话生效 */
  }
}

export interface EmptyDesktopProps {
  /** 存在可恢复的上次桌面快照时显示次级 CTA（默认 false，不做破坏性默认翻转） */
  restoreAvailable?: boolean;
  /** 可恢复快照里的窗口数（>0 时 CTA 文案附带数量，帮用户预判恢复规模） */
  restoreWindowCount?: number;
  /** 「恢复上次桌面」点击回调（由总装提供 hydrate 实现） */
  onRestoreSession?: () => void;
}

export const EmptyDesktop: React.FC<EmptyDesktopProps> = React.memo(({
  restoreAvailable = false,
  restoreWindowCount = 0,
  onRestoreSession,
}) => {
  const { t } = useTranslation();
  const [tourDismissed, setTourDismissed] = useState(readOnboardingDismissed);
  const [sessionSkipped, setSessionSkipped] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  // 菜单栏 autohide 时状态栏不可见：tour 跳过 statusBar 步（不指向隐藏项）
  const menuBarHidden = useMenuBarAutohide();
  const steps = useMemo<readonly EmptyDesktopTourStepId[]>(
    () => (menuBarHidden ? TOUR_STEP_IDS.filter((id) => id !== 'statusBar') : TOUR_STEP_IDS),
    [menuBarHidden],
  );

  const dismissForever = useCallback(() => {
    setTourDismissed(true);
    persistOnboardingDismissed(true);
  }, []);

  const skipSession = useCallback(() => {
    setSessionSkipped(true);
  }, []);

  const goNext = useCallback(() => {
    setStepIndex((prev) => {
      if (prev >= steps.length - 1) {
        dismissForever();
        return prev;
      }
      return prev + 1;
    });
  }, [dismissForever, steps.length]);

  // 再入口：速查表「重新播放快速上手」→ 复位 tour（含仅会话跳过的场景）
  useEffect(() => {
    const onReplay = () => {
      persistOnboardingDismissed(false);
      setTourDismissed(false);
      setSessionSkipped(false);
      setStepIndex(0);
    };
    window.addEventListener(EMPTY_DESKTOP_TOUR_REPLAY_EVENT, onReplay);
    window.addEventListener(EMPTY_DESKTOP_REPLAY_TOUR_EVENT, onReplay);
    return () => {
      window.removeEventListener(EMPTY_DESKTOP_TOUR_REPLAY_EVENT, onReplay);
      window.removeEventListener(EMPTY_DESKTOP_REPLAY_TOUR_EVENT, onReplay);
    };
  }, []);

  const launch = useCallback((typeId: string) => {
    workbenchBus.launch({ typeId, reason: 'api' });
  }, []);

  const openPrimary = useCallback(() => {
    launch('files');
  }, [launch]);

  const tourVisible = !tourDismissed && !sessionSkipped;
  // autohide 中途切换可能让 index 越界：夹取到最后一步
  const clampedIndex = Math.min(stepIndex, steps.length - 1);
  const stepId = steps[clampedIndex] ?? steps[0];
  const isLast = clampedIndex >= steps.length - 1;
  const searchShortcut = isMacOS() ? '⌘K' : 'Ctrl+K';

  return (
    <div className="wb-empty-desktop">
      <div className="wb-empty-card wb-glass wb-glass-highlight wb-empty-card-pro" role="note">
        <div className="wb-empty-scene wb-empty-rise" aria-hidden="true">
          <div className="wb-empty-icons"><SquaresFour size={28} weight="duotone" /></div>
        </div>

        <h2 className="wb-empty-title wb-empty-rise wb-empty-rise-2">
          {t('workbench:emptyDesktop.title')}
        </h2>
        <p className="wb-empty-hint wb-empty-rise wb-empty-rise-3">
          {t('workbench:emptyDesktop.hint')}
        </p>

        <div
          className="wb-empty-cta-block wb-empty-rise wb-empty-rise-4"
          role="group"
          aria-label={t('workbench:emptyDesktop.actionsLabel')}
        >
          <button type="button" className="wb-empty-cta" onClick={openPrimary}>
            <FolderOpen size={18} weight="duotone" aria-hidden="true" />
            {t('workbench:emptyDesktop.actionFiles')}
          </button>
          {restoreAvailable && onRestoreSession ? (
            <button
              type="button"
              className="wb-empty-cta wb-empty-cta-secondary"
              data-testid="wb-empty-restore-session"
              onClick={onRestoreSession}
            >
              <ClockCounterClockwise size={18} weight="duotone" aria-hidden="true" />
              {restoreWindowCount > 0
                ? t('workbench:emptyDesktop.actionRestoreSessionCount', {
                    count: restoreWindowCount,
                  })
                : t('workbench:emptyDesktop.actionRestoreSession')}
            </button>
          ) : null}
        </div>

        {tourVisible ? (
          <div
            className="wb-empty-tour wb-empty-rise wb-empty-rise-5"
            role="region"
            aria-label={t('workbench:emptyDesktop.tourTitle')}
            data-testid="wb-empty-tour"
            data-tour-step={stepId}
          >
            <div className="wb-empty-tour-head">
              <span className="wb-empty-tour-icon" aria-hidden="true">
                {TOUR_ICONS[stepId]}
              </span>
              <span className="wb-empty-tour-title">
                {t('workbench:emptyDesktop.tourTitle')}
              </span>
              <span className="wb-empty-tour-progress" data-testid="wb-empty-tour-progress">
                {t('workbench:emptyDesktop.tourStep', {
                  current: clampedIndex + 1,
                  total: steps.length,
                })}
              </span>
            </div>

            <div className="wb-empty-tour-body">
              <h3 className="wb-empty-tour-step-title">
                {t(`workbench:emptyDesktop.tourSteps.${stepId}.title`)}
              </h3>
              <p className="wb-empty-tour-step-desc">
                {stepId === 'search'
                  ? t('workbench:emptyDesktop.tourSteps.search.body', { shortcut: searchShortcut })
                  : t(`workbench:emptyDesktop.tourSteps.${stepId}.body`)}
              </p>
              {stepId === 'search' ? (
                <p className="wb-empty-tour-shortcut" data-testid="wb-empty-tour-shortcut">
                  <kbd className="wb-empty-kbd">{searchShortcut}</kbd>
                </p>
              ) : null}
            </div>

            <div className="wb-empty-tour-dots" aria-hidden="true">
              {steps.map((id, index) => (
                <span
                  key={id}
                  className="wb-empty-tour-dot"
                  data-active={index === clampedIndex ? 'true' : undefined}
                />
              ))}
            </div>

            <div className="wb-empty-tour-actions">
              <button
                type="button"
                className="wb-empty-tour-btn wb-empty-tour-btn-ghost"
                data-testid="wb-empty-tour-skip"
                onClick={skipSession}
              >
                {t('workbench:emptyDesktop.tourSkip')}
              </button>
              <button
                type="button"
                className="wb-empty-tour-btn wb-empty-tour-btn-ghost"
                data-testid="wb-empty-tour-dont-show"
                onClick={dismissForever}
              >
                {t('workbench:emptyDesktop.tourDontShow')}
              </button>
              <button
                type="button"
                className="wb-empty-tour-btn wb-empty-tour-btn-primary"
                data-testid="wb-empty-tour-next"
                onClick={goNext}
              >
                {isLast
                  ? t('workbench:emptyDesktop.tourDone')
                  : t('workbench:emptyDesktop.tourNext')}
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});

EmptyDesktop.displayName = 'EmptyDesktop';

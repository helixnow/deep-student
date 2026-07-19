/**
 * 空桌面引导（A4：4 步首启 tour）
 * ---------------------------------------------------------------------------
 * 桌面上没有任何窗口时展示的轻量引导：
 * - 单主 CTA（打开资源库）；
 * - 4 步 tour：Dock 应用 → ⌘K/Ctrl+K 搜索 → 状态栏 → Agent 控制；
 * - 「跳过」仅本会话隐藏；「不再显示」/「完成」写入 localStorage 永久消隐；
 * - 整层 pointer-events: none，仅 CTA / tour 控件恢复指针，
 *   不拦截桌面右键 / 双击手势。
 */
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppWindow,
  FolderOpen,
  Keyboard,
  Pulse,
  Robot,
  SquaresFour,
} from '@phosphor-icons/react';
import { isMacOS } from '@/utils/platform';
import { workbenchBus } from '../core/workbenchBus';
import '../styles/workbench.css';
import './EmptyDesktop.css';

/** 首次使用 onboarding 的记忆位（本地 UI 偏好，不进设置后端/快照） */
export const EMPTY_DESKTOP_ONBOARDING_KEY = 'workbench.emptyDesktop.onboardingDismissed';

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

function persistOnboardingDismissed(): void {
  try {
    localStorage.setItem(EMPTY_DESKTOP_ONBOARDING_KEY, '1');
  } catch {
    /* 存储不可用时仅本次会话隐藏 */
  }
}

export const EmptyDesktop: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const [onboardingDismissed, setOnboardingDismissed] = useState(readOnboardingDismissed);
  const [sessionSkipped, setSessionSkipped] = useState(false);
  const [stepIndex, setStepIndex] = useState(0);

  const dismissForever = useCallback(() => {
    setOnboardingDismissed(true);
    persistOnboardingDismissed();
  }, []);

  const skipSession = useCallback(() => {
    setSessionSkipped(true);
  }, []);

  const goNext = useCallback(() => {
    setStepIndex((prev) => {
      if (prev >= TOUR_STEP_IDS.length - 1) {
        dismissForever();
        return prev;
      }
      return prev + 1;
    });
  }, [dismissForever]);

  const launch = useCallback((typeId: string) => {
    workbenchBus.launch({ typeId, reason: 'api' });
  }, []);

  const openPrimary = useCallback(() => {
    launch('files');
  }, [launch]);

  if (onboardingDismissed || sessionSkipped) return null;

  const stepId = TOUR_STEP_IDS[stepIndex] ?? TOUR_STEP_IDS[0];
  const isLast = stepIndex >= TOUR_STEP_IDS.length - 1;
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
        </div>

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
                current: stepIndex + 1,
                total: TOUR_STEP_IDS.length,
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
            {TOUR_STEP_IDS.map((id, index) => (
              <span
                key={id}
                className="wb-empty-tour-dot"
                data-active={index === stepIndex ? 'true' : undefined}
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
      </div>
    </div>
  );
});

EmptyDesktop.displayName = 'EmptyDesktop';

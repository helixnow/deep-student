/**
 * 空桌面引导（L5 克制化，原 O14）
 * ---------------------------------------------------------------------------
 * 桌面上没有任何窗口时展示的轻量引导：
 * - 单主 CTA（打开资源库）+ 次要文字链（全部应用 / 闪卡 / 新建对话 / 查看待办）；
 * - 首次使用 onboarding：三条操作技巧，「知道了」后写 localStorage 消隐；
 * - 整层 pointer-events: none，仅 CTA / 文字链 / onboarding 恢复指针，
 *   不拦截桌面右键 / 双击手势（O13 依赖 target===currentTarget 判空白）。
 * i18n key 兜底文案内联（§0.4）。
 *
 * 主 CTA 打开资源库；次要链含「全部应用」→ openAppsPanel（L4）。
 */
import React, { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppWindow,
  CaretDown,
  ChatCircleText,
  CheckSquare,
  FolderOpen,
  GridFour,
  Lightbulb,
  Stack,
} from '@phosphor-icons/react';
import { workbenchBus } from '../core/workbenchBus';
import { openAppsPanel } from './appsPanelStore';
import '../styles/workbench.css';
import './EmptyDesktop.css';

/** 首次使用 onboarding 的记忆位（本地 UI 偏好，不进设置后端/快照） */
export const EMPTY_DESKTOP_ONBOARDING_KEY = 'workbench.emptyDesktop.onboardingDismissed';

function readOnboardingDismissed(): boolean {
  try {
    return localStorage.getItem(EMPTY_DESKTOP_ONBOARDING_KEY) === '1';
  } catch {
    return false;
  }
}

type SecondaryLink =
  | {
      kind: 'launch';
      typeId: string;
      labelKey: string;
      labelFallback: string;
    }
  | {
      kind: 'apps';
      labelKey: string;
      labelFallback: string;
    };

const SECONDARY_LINKS: readonly SecondaryLink[] = [
  {
    kind: 'apps',
    labelKey: 'workbench:emptyDesktop.actionApps',
    labelFallback: '全部应用',
  },
  {
    kind: 'launch',
    typeId: 'flashcards',
    labelKey: 'workbench:emptyDesktop.actionFlashcards',
    labelFallback: '闪卡',
  },
  {
    kind: 'launch',
    typeId: 'chat',
    labelKey: 'workbench:emptyDesktop.actionChat',
    labelFallback: '新建对话',
  },
  {
    kind: 'launch',
    typeId: 'todo',
    labelKey: 'workbench:emptyDesktop.actionTodo',
    labelFallback: '查看待办',
  },
] as const;

export const EmptyDesktop: React.FC = React.memo(() => {
  const { t } = useTranslation();
  const [onboardingDismissed, setOnboardingDismissed] = useState(readOnboardingDismissed);

  const dismissOnboarding = useCallback(() => {
    setOnboardingDismissed(true);
    try {
      localStorage.setItem(EMPTY_DESKTOP_ONBOARDING_KEY, '1');
    } catch {
      /* 存储不可用时仅本次会话隐藏 */
    }
  }, []);

  const launch = useCallback((typeId: string) => {
    workbenchBus.launch({ typeId, reason: 'api' });
  }, []);

  const openPrimary = useCallback(() => {
    launch('files');
  }, [launch]);

  const onSecondary = useCallback(
    (link: SecondaryLink) => {
      if (link.kind === 'apps') openAppsPanel();
      else launch(link.typeId);
    },
    [launch],
  );

  return (
    <div className="wb-empty-desktop">
      <div className="wb-empty-card wb-glass wb-glass-highlight wb-empty-card-pro" role="note">
        <div className="wb-empty-scene wb-empty-rise" aria-hidden="true">
          <div className="wb-empty-icons">
            <AppWindow size={40} weight="duotone" />
          </div>
        </div>

        <h2 className="wb-empty-title wb-empty-rise wb-empty-rise-2">
          {t('workbench:emptyDesktop.title', '你的学习桌面')}
        </h2>
        <p className="wb-empty-hint wb-empty-rise wb-empty-rise-3">
          {t(
            'workbench:emptyDesktop.hint',
            '从下方 Dock 打开应用开始工作——窗口可以自由摆放、平铺与并排对比。',
          )}
        </p>

        <div
          className="wb-empty-cta-block wb-empty-rise wb-empty-rise-4"
          role="group"
          aria-label={t('workbench:emptyDesktop.actionsLabel', '快速开始')}
        >
          <button type="button" className="wb-empty-cta" onClick={openPrimary}>
            <FolderOpen size={18} weight="duotone" aria-hidden="true" />
            {t('workbench:emptyDesktop.actionFiles', '打开资源库')}
          </button>
          <div className="wb-empty-links">
            {SECONDARY_LINKS.map((link) => (
              <button
                key={link.kind === 'apps' ? 'apps' : link.typeId}
                type="button"
                className="wb-empty-link"
                onClick={() => onSecondary(link)}
              >
                {link.kind === 'apps' ? (
                  <GridFour size={14} weight="regular" aria-hidden="true" />
                ) : link.typeId === 'flashcards' ? (
                  <Stack size={14} weight="regular" aria-hidden="true" />
                ) : link.typeId === 'chat' ? (
                  <ChatCircleText size={14} weight="regular" aria-hidden="true" />
                ) : (
                  <CheckSquare size={14} weight="regular" aria-hidden="true" />
                )}
                {t(link.labelKey, link.labelFallback)}
              </button>
            ))}
          </div>
        </div>

        {!onboardingDismissed && (
          <div className="wb-empty-onboarding wb-empty-rise wb-empty-rise-5" role="note">
            <div className="wb-empty-onboarding-head">
              <Lightbulb size={14} weight="duotone" aria-hidden="true" />
              <span className="wb-empty-onboarding-title">
                {t('workbench:emptyDesktop.tipsTitle', '小技巧')}
              </span>
              <button
                type="button"
                className="wb-empty-onboarding-dismiss"
                onClick={dismissOnboarding}
              >
                {t('workbench:emptyDesktop.tipsDismiss', '知道了')}
              </button>
            </div>
            <ul className="wb-empty-onboarding-list">
              <li className="wb-empty-onboarding-item">
                {t('workbench:emptyDesktop.tipTile', '把窗口拖到屏幕边缘，松手即可平铺')}
              </li>
              <li className="wb-empty-onboarding-item">
                <kbd className="wb-empty-kbd">Ctrl</kbd>
                <span className="wb-empty-kbd-plus">+</span>
                <kbd className="wb-empty-kbd">Tab</kbd>
                {t('workbench:emptyDesktop.tipSwitch', '在窗口间快速切换')}
              </li>
              <li className="wb-empty-onboarding-item">
                <kbd className="wb-empty-kbd">Ctrl</kbd>
                <span className="wb-empty-kbd-plus">+</span>
                <kbd className="wb-empty-kbd">Alt</kbd>
                <span className="wb-empty-kbd-plus">+</span>
                <kbd className="wb-empty-kbd">E</kbd>
                {t('workbench:emptyDesktop.tipExpose', '俯瞰所有打开的窗口')}
              </li>
            </ul>
          </div>
        )}

        <CaretDown size={18} weight="bold" className="wb-empty-hint-arrow" aria-hidden="true" />
      </div>
    </div>
  );
});

EmptyDesktop.displayName = 'EmptyDesktop';

/**
 * WelcomeOnboardingDialog - 首次启动欢迎引导
 *
 * 触发时机：用户协议同意之后（同一会话或后续启动），且尚未配置任何 AI 服务。
 * 目标：把"空白首屏"变成一个有方向的起点——
 *   1. 选择界面语言（中/英）
 *   2. 30 秒了解三大核心能力
 *   3. 一键跳转到"模型服务"设置页完成 AI 接入（支持 SiliconFlow 一键配置）
 *
 * 已配置过模型的老用户会被静默跳过（写入完成标记，不再查询）。
 * 完成状态存 localStorage（onboarding_completed_flows，随备份同步）。
 *
 * 样式：纯简洁风格，与 UserAgreementDialog 保持一致。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { Books, ChatCircleText, Cards, Sparkle } from '@phosphor-icons/react';

import { cn } from '@/lib/utils';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Z_INDEX } from '@/config/zIndex';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import type { ApiConfig } from '@/types';

// ============================================================================
// 完成状态存取
// ============================================================================
const WELCOME_FLOW_ID = 'welcome-v1';
const FLOWS_KEY = 'onboarding_completed_flows';
const LEGACY_SKIP_KEY = 'onboarding_skipped';

function readCompletedFlows(): string[] {
  try {
    const raw = localStorage.getItem(FLOWS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
}

function markWelcomeFlowDone(): void {
  try {
    const flows = readCompletedFlows();
    if (!flows.includes(WELCOME_FLOW_ID)) {
      flows.push(WELCOME_FLOW_ID);
    }
    localStorage.setItem(FLOWS_KEY, JSON.stringify(flows));
  } catch {
    // localStorage 不可用时静默失败：最坏情况是下次启动再展示一次
  }
}

// ============================================================================
// Hook: useWelcomeOnboarding
// ============================================================================
/**
 * @param agreementReady 用户协议已同意（needsAgreement === false）
 */
export function useWelcomeOnboarding(agreementReady: boolean) {
  const [open, setOpen] = useState(false);
  const checkedRef = useRef(false);

  useEffect(() => {
    if (!agreementReady || checkedRef.current) return;
    checkedRef.current = true;

    // 已完成或旧版跳过标记 → 不再展示
    if (
      readCompletedFlows().includes(WELCOME_FLOW_ID) ||
      localStorage.getItem(LEGACY_SKIP_KEY) === 'true'
    ) {
      return;
    }

    let cancelled = false;
    (async () => {
      // 已配置过 AI 服务的用户（含升级用户）静默跳过并落标记。
      // 注意：内置（isBuiltin）配置出厂自带中转 key，不能把"有 key"当作用户配置过；
      // 只有「用户自己添加的带 key 配置」或「任一已启用的配置」才算真实接入。
      const configs = await invoke<ApiConfig[]>('get_api_configurations').catch(
        () => [] as ApiConfig[],
      );
      const hasRealConfig = configs.some(
        (c) => c.enabled || (!c.isBuiltin && !!c.apiKey && c.apiKey.trim().length > 0),
      );
      if (hasRealConfig) {
        markWelcomeFlowDone();
        return;
      }
      if (!cancelled) setOpen(true);
    })();

    return () => {
      cancelled = true;
    };
  }, [agreementReady]);

  const dismiss = useCallback(() => {
    markWelcomeFlowDone();
    setOpen(false);
  }, []);

  return { open, dismiss };
}

// ============================================================================
// 主组件
// ============================================================================
interface WelcomeOnboardingDialogProps {
  /** 点击"去配置 AI 服务"：调用方负责导航到设置页 apis 标签 */
  onConfigure: () => void;
  /** 点击"先随便看看" */
  onSkip: () => void;
}

interface FeatureRow {
  icon: React.ReactNode;
  titleKey: string;
  descKey: string;
}

export const WelcomeOnboardingDialog: React.FC<WelcomeOnboardingDialogProps> = ({
  onConfigure,
  onSkip,
}) => {
  const { t, i18n } = useTranslation('common');

  // 入场动画
  const [mounted, setMounted] = useState(false);
  useEffect(() => {
    requestAnimationFrame(() => setMounted(true));
  }, []);

  // 锁定 body 滚动
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // 模态焦点管理：打开时把焦点移入面板，关闭时还原到触发前的元素
  const panelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  // ★ 2026-07-08（移动端审计 D-9）：自绘弹窗无 Radix data-state，
  // androidBackCoordinator 的 Escape 兜底覆盖不到 —— Android 返回键
  // 等价于「先随便看看」（与 Esc 同语义），避免返回键穿透到底层导航。
  const onSkipRef = useRef(onSkip);
  onSkipRef.current = onSkip;
  useEffect(() => {
    return registerBackHandler(() => {
      onSkipRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, []);

  // Esc 关闭（等价于"先随便看看"）+ Tab 焦点圈定在面板内
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onSkip();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;

      const focusables = Array.from(
        panelRef.current.querySelectorAll<HTMLElement>(
          'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null);
      if (focusables.length === 0) {
        event.preventDefault();
        return;
      }

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (event.shiftKey) {
        if (active === first || active === panelRef.current) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last) {
        event.preventDefault();
        first.focus();
      }
    },
    [onSkip],
  );

  const currentLanguage = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';

  const features: FeatureRow[] = [
    {
      icon: <Books size={18} weight="duotone" className="text-blue-500/80" />,
      titleKey: 'welcome_onboarding.feature_hub_title',
      descKey: 'welcome_onboarding.feature_hub_desc',
    },
    {
      icon: <ChatCircleText size={18} weight="duotone" className="text-emerald-500/80" />,
      titleKey: 'welcome_onboarding.feature_chat_title',
      descKey: 'welcome_onboarding.feature_chat_desc',
    },
    {
      icon: <Cards size={18} weight="duotone" className="text-orange-500/80" />,
      titleKey: 'welcome_onboarding.feature_anki_title',
      // ★ 2026-07-08：修正文案——实际复习调度为 SM-2（reviewPlanStore），并非 FSRS
      descKey: 'welcome_onboarding.feature_anki_desc',
    },
  ];

  const dialog = (
    <div
      className={cn(
        'fixed inset-0 flex items-center justify-center p-3 sm:p-4',
        'transition-opacity duration-200 ease-out',
        mounted ? 'opacity-100' : 'opacity-0',
      )}
      style={{
        zIndex: Z_INDEX.modal,
        paddingTop: 'calc(0.75rem + var(--mobile-safe-area-top, 0px))',
        paddingBottom: 'calc(0.75rem + var(--mobile-safe-area-bottom, 0px))',
        paddingLeft: 'calc(0.75rem + var(--mobile-safe-area-left, 0px))',
        paddingRight: 'calc(0.75rem + var(--mobile-safe-area-right, 0px))',
      }}
      onKeyDown={handleKeyDown}
    >
      {/* 遮罩层 */}
      <div className="absolute inset-0 bg-black/25" />

      {/* 面板 */}
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="welcome-onboarding-title"
        tabIndex={-1}
        className={cn(
          'outline-none',
          'relative flex flex-col overflow-hidden',
          'w-full max-w-[520px]',
          'bg-background rounded-lg',
          'shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.08)]',
          'dark:shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.3)]',
          'transition-all duration-200 ease-out',
          mounted
            ? 'opacity-100 scale-100 translate-y-0'
            : 'opacity-0 scale-[0.97] translate-y-2',
        )}
        style={{
          maxHeight: 'min(85dvh, calc(100dvh - 1.5rem - var(--mobile-safe-area-top, 0px) - var(--mobile-safe-area-bottom, 0px)))',
        }}
      >
        {/* 标题区 */}
        <div className="flex-shrink-0 px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 id="welcome-onboarding-title" className="text-[20px] font-semibold text-foreground leading-tight tracking-[-0.01em]">
                {t('welcome_onboarding.title')}
              </h1>
              <p className="mt-1.5 text-[13px] text-foreground/50 leading-relaxed">
                {t('welcome_onboarding.subtitle')}
              </p>
            </div>
          </div>

          {/* 语言切换（即时生效，i18next 自动持久化） */}
          <div className="mt-4">
            <SegmentedControl
              ariaLabel={t('welcome_onboarding.language_label')}
              value={currentLanguage}
              onValueChange={(next) => {
                void i18n.changeLanguage(next);
              }}
              size="compact"
              stretch
              // 触屏：compact 档 28px 行高不满足 ≥40px 触控基线，仅 coarse 放大
              itemClassName="[@media(pointer:coarse)]:h-10"
              options={[
                { value: 'zh-CN', label: t('welcome_onboarding.lang_zh') },
                { value: 'en-US', label: t('welcome_onboarding.lang_en') },
              ]}
            />
          </div>
        </div>

        <div className="mx-4 h-px bg-foreground/[0.06] sm:mx-6" />

        {/* 内容区 */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 py-4 scroll-area--native sm:px-6">
          {/* 三大能力速览 */}
          <div className="space-y-3">
            {features.map((f) => (
              <div key={f.titleKey} className="flex items-start gap-3">
                <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-foreground/[0.04]">
                  {f.icon}
                </span>
                <div className="min-w-0">
                  <p className="text-[13px] font-medium text-foreground/85 leading-snug">
                    {t(f.titleKey)}
                  </p>
                  <p className="mt-0.5 text-[12px] text-foreground/50 leading-[1.55]">
                    {t(f.descKey)}
                  </p>
                </div>
              </div>
            ))}
          </div>

          {/* AI 接入提示卡 */}
          <div className="mt-4 rounded-md bg-foreground/[0.03] px-3.5 py-3">
            <div className="flex items-start gap-2">
              <Sparkle size={15} weight="fill" className="mt-[2px] flex-shrink-0 text-primary/70" />
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground/85 leading-snug">
                  {t('welcome_onboarding.ai_setup_title')}
                </p>
                <p className="mt-1 text-[12px] text-foreground/50 leading-[1.6]">
                  {t('welcome_onboarding.ai_setup_desc')}
                </p>
              </div>
            </div>
          </div>
        </div>

        <div className="mx-4 h-px bg-foreground/[0.06] sm:mx-6" />

        {/* 底部操作栏 */}
        <div className="flex-shrink-0 space-y-2 px-4 py-4 sm:px-6">
          <DsButton
            variant="primary"
            size="lg"
            className="w-full justify-center text-[13px] font-medium"
            onClick={onConfigure}
          >
            {t('welcome_onboarding.cta_configure')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="lg"
            className="w-full justify-center text-[13px] text-foreground/55"
            onClick={onSkip}
          >
            {t('welcome_onboarding.cta_skip')}
          </DsButton>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
};

export default WelcomeOnboardingDialog;

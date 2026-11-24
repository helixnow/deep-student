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
import { Books, ChatCircleText, Cards, CheckCircle } from '@phosphor-icons/react';

import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Z_INDEX } from '@/config/zIndex';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { UserAgreementDialog } from '@/components/legal/UserAgreementDialog';
import { PrivacyPolicyDialog } from '@/components/legal/PrivacyPolicyDialog';
import { QuickByokProvisionerCard } from './byok';
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
// 预配置模型状态共享（供不透传新 props 的宿主壳自动展示 AI Ready 引导）
// ============================================================================
interface PreconfiguredAiInfo {
  modelLabel: string | null;
}

let detectedPreconfiguredAi: PreconfiguredAiInfo | null = null;

/** 测试辅助：重置模块级预配置检测缓存 */
export function resetWelcomeOnboardingRuntimeState(): void {
  detectedPreconfiguredAi = null;
}

// ============================================================================
// Hook: useWelcomeOnboarding
// ============================================================================
/**
 * @param agreementReady 用户协议已同意（needsAgreement === false）
 */
export function useWelcomeOnboarding(agreementReady: boolean) {
  const [open, setOpen] = useState(false);
  const [aiReady, setAiReady] = useState(false);
  const [preconfiguredModel, setPreconfiguredModel] = useState<string | null>(null);
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
      // 注意：内置（isBuiltin）配置出厂自带中转 key，不能把"有 key"当作用户配置过；
      // 只有「用户自己添加的带 key 配置」或「任一已启用的配置」才算真实接入。
      const configs = await invoke<ApiConfig[]>('get_api_configurations').catch(
        () => [] as ApiConfig[],
      );
      const activeConfig = configs.find(
        (c) => c.enabled || (!c.isBuiltin && !!c.apiKey && c.apiKey.trim().length > 0),
      );
      if (activeConfig) {
        // 区分「已有历史数据的升级/老用户」与「自带预配置模型的全新首启用户」：
        // 只有已存在会话或笔记的老用户才静默跳过；全新空白工作区即使预配置了模型，
        // 仍应展示简洁的「AI 已就绪」欢迎引导，避免首次启动完全失去引导入口。
        const [sessionCount, notes] = await Promise.all([
          invoke<number>('chat_v2_count_sessions', {}).catch(() => 0),
          invoke<unknown[]>('vfs_list_notes', { params: { limit: 1 } }).catch(() => []),
        ]);
        const hasExistingWorkspaceData =
          (typeof sessionCount === 'number' && sessionCount > 0) ||
          (Array.isArray(notes) && notes.length > 0);
        if (hasExistingWorkspaceData) {
          detectedPreconfiguredAi = null;
          markWelcomeFlowDone();
          return;
        }
        const modelLabel =
          activeConfig.name?.trim() ||
          activeConfig.model?.trim() ||
          activeConfig.vendorName?.trim() ||
          null;
        detectedPreconfiguredAi = { modelLabel };
        if (!cancelled) {
          setAiReady(true);
          setPreconfiguredModel(modelLabel);
          setOpen(true);
        }
        return;
      }
      detectedPreconfiguredAi = null;
      if (!cancelled) {
        setAiReady(false);
        setPreconfiguredModel(null);
        setOpen(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [agreementReady]);

  const dismiss = useCallback(() => {
    detectedPreconfiguredAi = null;
    markWelcomeFlowDone();
    setOpen(false);
  }, []);

  return { open, dismiss, aiReady, preconfiguredModel };
}

// ============================================================================
// 主组件
// ============================================================================
interface WelcomeOnboardingDialogProps {
  /** 点击"去配置 AI 服务"：调用方负责导航到设置页 apis 标签 */
  onConfigure: () => void;
  /** 点击"先随便看看" / "开始使用" */
  onSkip: () => void;
  /** 可选：显式指定预配置模型就绪态；缺省读取 useWelcomeOnboarding 检测结果 */
  preconfiguredAi?: boolean | { modelLabel?: string | null };
}

interface FeatureRow {
  icon: React.ReactNode;
  titleKey: string;
  descKey: string;
}

export const WelcomeOnboardingDialog: React.FC<WelcomeOnboardingDialogProps> = ({
  onConfigure,
  onSkip,
  preconfiguredAi,
}) => {
  const { t, i18n } = useTranslation(['common', 'settings']);

  const resolvedPreconfigured =
    preconfiguredAi !== undefined
      ? preconfiguredAi === false
        ? null
        : {
            modelLabel:
              typeof preconfiguredAi === 'object' ? (preconfiguredAi.modelLabel ?? null) : null,
          }
      : detectedPreconfiguredAi;
  const isAiReady = resolvedPreconfigured !== null;
  const readyModelLabel = resolvedPreconfigured?.modelLabel ?? null;

  const [activeLegalDoc, setActiveLegalDoc] = useState<'terms' | 'privacy' | null>(null);
  const activeLegalDocRef = useRef<'terms' | 'privacy' | null>(null);
  activeLegalDocRef.current = activeLegalDoc;

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
      if (activeLegalDocRef.current !== null) {
        setActiveLegalDoc(null);
        return true;
      }
      onSkipRef.current();
      return true;
    }, BACK_PRIORITY.overlay);
  }, []);

  // Esc 关闭（等价于"先随便看看"）+ Tab 焦点圈定在面板内
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (activeLegalDocRef.current !== null) {
        if (event.key === 'Escape') {
          event.preventDefault();
          event.stopPropagation();
          setActiveLegalDoc(null);
        }
        return;
      }
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
  const isZh = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith('zh');

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
      // 闪卡与错题复习统一采用 FSRS 智能间隔重复调度
      descKey: 'welcome_onboarding.feature_anki_desc',
    },
  ];

  const dialog = (
    <div
      aria-hidden={activeLegalDoc !== null ? 'true' : undefined}
      className={cn(
        'fixed inset-0 flex items-center justify-center p-3 sm:p-4',
        'transition-opacity duration-200 ease-out',
        mounted ? 'opacity-100' : 'opacity-0',
        activeLegalDoc !== null && 'pointer-events-none',
      )}
      style={{
        zIndex: activeLegalDoc !== null ? Z_INDEX.modal - 10 : Z_INDEX.modal,
        // Portal 到 body：--mobile-safe-area-*（app-shell 作用域）不可见，
        // 必须走 :root 级 --android-safe-area-* 链（对齐 command-palette.css 注释）
        paddingTop: 'calc(0.75rem + var(--android-safe-area-top, env(safe-area-inset-top, 0px)))',
        paddingBottom: 'calc(0.75rem + var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)))',
        paddingLeft: 'calc(0.75rem + var(--android-safe-area-left, env(safe-area-inset-left, 0px)))',
        paddingRight: 'calc(0.75rem + var(--android-safe-area-right, env(safe-area-inset-right, 0px)))',
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
        aria-describedby="welcome-onboarding-subtitle"
        tabIndex={-1}
        className={cn(
          'outline-none',
          'relative flex flex-col overflow-hidden',
          'w-full max-w-[480px]',
          'bg-background rounded-lg',
          'shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.08)]',
          'dark:shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.3)]',
          'transition-all duration-200 ease-out',
          mounted
            ? 'opacity-100 scale-100 translate-y-0'
            : 'opacity-0 scale-[0.97] translate-y-2',
        )}
        style={{
          maxHeight: 'min(85dvh, calc(100dvh - 1.5rem - var(--android-safe-area-top, env(safe-area-inset-top, 0px)) - var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))))',
        }}
      >
        {/* 标题区 */}
        <div className="flex-shrink-0 border-b border-border/35 px-4 pb-4 pt-5 sm:px-6 sm:pt-6">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h1 id="welcome-onboarding-title" className="text-[20px] font-semibold text-foreground leading-tight tracking-[-0.01em]">
                {t('welcome_onboarding.title')}
              </h1>
              <p
                id="welcome-onboarding-subtitle"
                className="mt-1.5 text-[13px] text-foreground/50 leading-relaxed"
              >
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
              // 触屏：compact 档 28px 行高不满足 ≥44px 触控基线，仅 coarse 放大
              // ！必须带 important：app.css .study-shell-segmented-button { min-height: 0 }
              // 会压掉基元里非 important 的同名工具类
              itemClassName="[@media(pointer:coarse)]:!min-h-11"
              options={[
                { value: 'zh-CN', label: t('welcome_onboarding.lang_zh') },
                { value: 'en-US', label: t('welcome_onboarding.lang_en') },
              ]}
            />
          </div>
        </div>

        {/* 内容区 */}
        <div className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pt-3 pb-5 scroll-pb-5 scroll-area--native sm:px-6 sm:py-4 space-y-3 sm:space-y-4">
          {/* 已预配置模型时展示简洁的「AI 服务已就绪」卡片；否则展示 10 秒单 Key 自动配置面板 */}
          {isAiReady ? (
            <div
              data-testid="welcome-ai-ready-card"
              className="flex items-start gap-3 rounded-lg border border-emerald-500/25 bg-emerald-500/[0.06] px-3.5 py-3"
            >
              <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-emerald-500/15 text-emerald-600 dark:text-emerald-400">
                <CheckCircle size={18} weight="duotone" />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-foreground/90 leading-snug">
                  {t('settings:vendor_panel.welcome_ai_ready_title', {
                    defaultValue: 'AI service is ready',
                  })}
                </p>
                <p className="mt-0.5 text-[12px] text-foreground/60 leading-[1.55]">
                  {readyModelLabel
                    ? t('settings:vendor_panel.welcome_ai_ready_desc', {
                        model: readyModelLabel,
                        defaultValue: `A configured model (${readyModelLabel}) is ready to use. You can start right away or manage providers anytime in Settings.`,
                      })
                    : t('settings:vendor_panel.welcome_ai_ready_desc_generic', {
                        defaultValue:
                          'A configured AI service is ready to use. You can start right away or manage providers anytime in Settings.',
                      })}
                </p>
              </div>
            </div>
          ) : (
            <QuickByokProvisionerCard
              mode="onboarding"
              onCompleted={() => onSkip()}
              onOpenFullSettings={onConfigure}
            />
          )}

          {/* 三大能力速览 */}
          <div className="space-y-2.5 border-t border-border/35 pt-3.5 sm:space-y-3 sm:pt-4">
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
        </div>

        {/* 底部操作栏 + 非阻塞条款声明 */}
        <div className="flex-shrink-0 border-t border-border/35 px-4 py-3.5 sm:px-6">
          <div className="flex items-center justify-between gap-2">
            <DsButton
              variant="ghost"
              size="md"
              className="text-[13px] [@media(pointer:coarse)]:!min-h-11"
              onClick={onConfigure}
            >
              {isAiReady
                ? t('settings:vendor_panel.welcome_ai_ready_cta_manage', {
                    defaultValue: t('welcome_onboarding.cta_configure'),
                  })
                : t('settings:byok.fullSettingsLink', {
                    defaultValue: t('welcome_onboarding.cta_configure'),
                  })}
            </DsButton>
            <DsButton
              variant={isAiReady ? 'primary' : 'ghost'}
              size="md"
              className={cn(
                'text-[13px] [@media(pointer:coarse)]:!min-h-11',
                !isAiReady && 'text-foreground/55',
              )}
              onClick={onSkip}
            >
              {isAiReady
                ? t('settings:vendor_panel.welcome_ai_ready_cta_start', {
                    defaultValue: t('welcome_onboarding.cta_skip'),
                  })
                : t('welcome_onboarding.cta_skip')}
            </DsButton>
          </div>
          <p
            data-testid="onboarding-legal-notice"
            className="mt-2.5 text-center text-[11px] leading-relaxed text-foreground/50"
          >
            {isZh ? (
              <>
                {'继续使用即表示同意'}
                <button
                  type="button"
                  data-testid="onboarding-terms-link"
                  onClick={() => setActiveLegalDoc('terms')}
                  className="mx-0.5 cursor-pointer rounded-sm text-foreground/75 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {`《${t('legal.userAgreement.agreementTitle', { defaultValue: '用户协议' })}》`}
                </button>
                {'与'}
                <button
                  type="button"
                  data-testid="onboarding-privacy-link"
                  onClick={() => setActiveLegalDoc('privacy')}
                  className="mx-0.5 cursor-pointer rounded-sm text-foreground/75 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {`《${t('legal.privacyPolicy.title', { defaultValue: '隐私政策' })}》`}
                </button>
              </>
            ) : (
              <>
                {'By continuing, you agree to the '}
                <button
                  type="button"
                  data-testid="onboarding-terms-link"
                  onClick={() => setActiveLegalDoc('terms')}
                  className="cursor-pointer rounded-sm text-foreground/75 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {t('legal.userAgreement.agreementTitle', { defaultValue: 'User Agreement' })}
                </button>
                {' and '}
                <button
                  type="button"
                  data-testid="onboarding-privacy-link"
                  onClick={() => setActiveLegalDoc('privacy')}
                  className="cursor-pointer rounded-sm text-foreground/75 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {t('legal.privacyPolicy.title', { defaultValue: 'Privacy Policy' })}
                </button>
                {'.'}
              </>
            )}
          </p>
        </div>
      </div>
    </div>
  );

  return (
    <>
      {createPortal(dialog, document.body)}
      {activeLegalDoc === 'terms' && (
        <UserAgreementDialog
          preview
          open
          onClose={() => setActiveLegalDoc(null)}
          onAccept={() => setActiveLegalDoc(null)}
        />
      )}
      {activeLegalDoc === 'privacy' && (
        <PrivacyPolicyDialog
          open
          onOpenChange={(open) => {
            if (!open) setActiveLegalDoc(null);
          }}
        />
      )}
    </>
  );
};

export default WelcomeOnboardingDialog;

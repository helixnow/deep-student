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
import { Books, ChatCircleText, Cards, CaretDown, Check, CheckCircle } from '@phosphor-icons/react';

import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Z_INDEX } from '@/config/zIndex';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { APP_EVENTS, dispatchAppEvent } from '@/events/app';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';
import {
  readLegalConsentRecord,
  type LegalConsentRecord,
} from '@/components/legal/UserAgreementDialog';
import { OnboardingLegalDialog, type OnboardingLegalTab } from './OnboardingLegalDialog';
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
    try {
      if (!localStorage.getItem(STARTER_FOCUS_KEY)) {
        localStorage.setItem(STARTER_FOCUS_KEY, 'chat');
      }
      window.dispatchEvent(new CustomEvent('deepstudent:onboarding-starter-updated'));
    } catch {
      // Ignore storage/event failures.
    }
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

export type OnboardingStarterFocus = 'hub' | 'chat' | 'anki';
const STARTER_FOCUS_KEY = 'onboarding_starter_focus';

/**
 * 完成欢迎引导后真正打开/聚焦用户选中的工作台应用，避免落回空白桌面壁纸。
 * - chat: 打开/激活 Chat 窗口（focusInput）并展示底部起步提问胶囊
 * - hub: 打开/激活 Notes 资料与笔记工作区（经典壳回退 learning-hub）
 * - anki: 打开/激活 Flashcards 闪卡复习工作区（经典壳回退 flashcards）
 */
export function launchOnboardingStarterApp(focus: OnboardingStarterFocus): void {
  try {
    localStorage.setItem(STARTER_FOCUS_KEY, focus);
    localStorage.removeItem('onboarding_starter_cue_dismissed');
    window.dispatchEvent(new CustomEvent('deepstudent:onboarding-starter-updated'));
  } catch {
    // Ignore storage errors.
  }

  if (focus === 'chat') {
    if (workbenchBus.isEnabled()) {
      void workbenchBus.activate({
        typeId: 'chat',
        instanceKey: '',
        action: 'focusInput',
        fallbackLaunch: { typeId: 'chat', reason: 'api' },
      });
    } else {
      dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'chat-v2' });
    }
    return;
  }

  if (focus === 'hub') {
    if (workbenchBus.isEnabled()) {
      void workbenchBus.activate({
        typeId: 'notes',
        instanceKey: '',
        action: 'openWorkspace',
        fallbackLaunch: { typeId: 'notes', reason: 'api' },
      });
    } else {
      dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'learning-hub' });
    }
    return;
  }

  if (workbenchBus.isEnabled()) {
    void workbenchBus.activate({
      typeId: 'flashcards',
      instanceKey: '',
      action: 'open',
      fallbackLaunch: { typeId: 'flashcards', reason: 'api' },
    });
  } else {
    dispatchAppEvent(APP_EVENTS.NAVIGATE_TO_VIEW, { view: 'flashcards' });
  }
}

interface FeatureRow {
  id: OnboardingStarterFocus;
  stepNumber: 1 | 2 | 3;
  icon: React.ReactNode;
  titleZh: string;
  titleEn: string;
  descZh: string;
  descEn: string;
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

  const [activeLegalDoc, setActiveLegalDoc] = useState<OnboardingLegalTab | null>(null);
  const [byokReady, setByokReady] = useState(false);
  const effectiveAiReady = isAiReady || byokReady;
  const [legalConsent, setLegalConsent] = useState<LegalConsentRecord | null>(() =>
    readLegalConsentRecord(),
  );
  const [selectedFeature, setSelectedFeature] = useState<OnboardingStarterFocus>(() => {
    try {
      const saved = localStorage.getItem(STARTER_FOCUS_KEY);
      if (saved === 'hub' || saved === 'chat' || saved === 'anki') return saved;
    } catch {
      // Ignore storage failures.
    }
    return 'chat';
  });
  const activeLegalDocRef = useRef<OnboardingLegalTab | null>(null);
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
  const bodyScrollRef = useRef<HTMLDivElement>(null);
  const [hasMoreBelow, setHasMoreBelow] = useState(false);

  const updateScrollCue = useCallback(() => {
    const el = bodyScrollRef.current;
    if (!el) return;
    setHasMoreBelow(el.scrollHeight - el.clientHeight - el.scrollTop > 4);
  }, []);

  useEffect(() => {
    const previouslyFocused = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();
    return () => {
      previouslyFocused?.focus?.();
    };
  }, []);

  useEffect(() => {
    updateScrollCue();
    const el = bodyScrollRef.current;
    const ro =
      typeof ResizeObserver !== 'undefined' && el
        ? new ResizeObserver(() => updateScrollCue())
        : null;
    if (ro && el) {
      ro.observe(el);
      if (el.firstElementChild) {
        ro.observe(el.firstElementChild);
      }
    }
    return () => {
      ro?.disconnect();
    };
  }, [updateScrollCue]);

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

  // Esc 关闭（等价于"先随便看看"）+ Tab 焦点圈定在面板内（挂载在 document 上，避免点击遮罩或焦点外泄后失效）
  useEventRegistry(
    activeLegalDoc === null
      ? [
          {
            target: 'document',
            type: 'keydown',
            options: true,
            listener: (rawEvent) => {
              const event = rawEvent as KeyboardEvent;
              if (activeLegalDocRef.current !== null) return;
              if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                onSkipRef.current();
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
              const activeInside = active !== null && panelRef.current.contains(active);
              if (!activeInside) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
                return;
              }
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
          },
        ]
      : [],
    [activeLegalDoc],
  );

  const currentLanguage = i18n.language === 'zh-CN' ? 'zh-CN' : 'en-US';
  const isZh = (i18n.resolvedLanguage ?? i18n.language).toLowerCase().startsWith('zh');

  const features: FeatureRow[] = [
    {
      id: 'hub',
      stepNumber: 1,
      icon: <Books size={18} weight="duotone" className="text-foreground/75" />,
      titleZh: '1. 导入学习资料',
      titleEn: '1. Import your study materials',
      descZh: '拖入 PDF、教材或课堂笔记，整理到你本地私密的学习空间。',
      descEn: 'Add PDFs, textbooks, or class notes to your private local workspace.',
    },
    {
      id: 'chat',
      stepNumber: 2,
      icon: <ChatCircleText size={18} weight="duotone" className="text-foreground/75" />,
      titleZh: '2. 向 AI 提问与记笔记',
      titleEn: '2. Ask AI & take notes',
      descZh: '结合你的资料向 AI 提问、拆解难题，并随时沉淀学习笔记。',
      descEn: 'Ask AI questions grounded in your materials, solve problems, and capture notes.',
    },
    {
      id: 'anki',
      stepNumber: 3,
      icon: <Cards size={18} weight="duotone" className="text-foreground/75" />,
      titleZh: '3. 制作闪卡与复习',
      titleEn: '3. Make flashcards & review',
      descZh: '把重点与错题一键生成记忆闪卡，按遗忘规律自动安排复习。',
      descEn: 'Turn key points and mistakes into flashcards with automatic spaced review.',
    },
  ];

  const handleSelectFeature = useCallback((id: OnboardingStarterFocus) => {
    setSelectedFeature(id);
    try {
      localStorage.setItem(STARTER_FOCUS_KEY, id);
      localStorage.removeItem('onboarding_starter_cue_dismissed');
      window.dispatchEvent(new CustomEvent('deepstudent:onboarding-starter-updated'));
    } catch {
      // Ignore storage errors.
    }
  }, []);

  const handleCompleteOnboarding = useCallback(() => {
    launchOnboardingStarterApp(selectedFeature);
    onSkip();
  }, [onSkip, selectedFeature]);

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
        paddingTop: 'calc(0.5rem + var(--android-safe-area-top, env(safe-area-inset-top, 0px)))',
        paddingBottom: 'calc(0.5rem + var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)))',
        paddingLeft: 'calc(0.75rem + var(--android-safe-area-left, env(safe-area-inset-left, 0px)))',
        paddingRight: 'calc(0.75rem + var(--android-safe-area-right, env(safe-area-inset-right, 0px)))',
      }}
    >
      {/* 遮罩层：阻止 mousedown 默认失焦行为，保持键盘焦点留在弹窗内 */}
      <div
        className="absolute inset-0 bg-black/25"
        onMouseDown={(event) => event.preventDefault()}
      />

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
          'max-h-[calc(100dvh_-_1rem_-_var(--android-safe-area-top,env(safe-area-inset-top,0px))_-_var(--android-safe-area-bottom,env(safe-area-inset-bottom,0px)))]',
          'sm:max-h-[min(85dvh,calc(100dvh_-_1.5rem_-_var(--android-safe-area-top,env(safe-area-inset-top,0px))_-_var(--android-safe-area-bottom,env(safe-area-inset-bottom,0px))))]',
          'bg-background rounded-lg',
          'shadow-[0_0_0_1px_rgba(0,0,0,0.04),0_8px_24px_rgba(0,0,0,0.12),0_2px_8px_rgba(0,0,0,0.08)]',
          'dark:shadow-[0_0_0_1px_rgba(255,255,255,0.06),0_8px_24px_rgba(0,0,0,0.4),0_2px_8px_rgba(0,0,0,0.3)]',
          'transition-all duration-200 ease-out',
          mounted
            ? 'opacity-100 scale-100 translate-y-0'
            : 'opacity-0 scale-[0.97] translate-y-2',
        )}
      >
        {/* 标题区 */}
        <div className="flex-shrink-0 border-b border-border/35 px-4 pt-3.5 pb-2.5 sm:px-6 sm:pt-6 sm:pb-4">
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
          <div className="mt-2.5 sm:mt-4">
            <SegmentedControl
              ariaLabel={t('welcome_onboarding.language_label')}
              value={currentLanguage}
              onValueChange={(next) => {
                void i18n.changeLanguage(next);
                void invoke('save_setting', { key: 'language', value: next }).catch(() => {});
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
        <div className="relative flex min-h-0 flex-1 flex-col">
        <div
          ref={bodyScrollRef}
          onScroll={updateScrollCue}
          data-testid="welcome-onboarding-scroll-body"
          className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pt-3 pb-5 scroll-pb-5 scroll-area--native sm:px-6 sm:py-4 space-y-3 sm:space-y-4"
        >
          {/* 已预配置模型时展示简洁的「AI 服务已就绪」卡片；否则展示 10 秒单 Key 自动配置面板 */}
          {isAiReady ? (
            <div
              data-testid="welcome-ai-ready-card"
              className="flex items-start gap-3 rounded-lg border border-success/25 bg-success/[0.06] px-3.5 py-3"
            >
              <CheckCircle size={18} weight="duotone" className="mt-0.5 flex-shrink-0 text-success" />
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
              hideFooterNavigationActions
              onReadyStateChange={setByokReady}
              onCompleted={handleCompleteOnboarding}
            />
          )}

          {/* 三步学习指引（点击选择优先体验方向） */}
          <div className="space-y-2 border-t border-border/35 pt-3.5 sm:space-y-2.5 sm:pt-4">
            <p
              data-testid="welcome-steps-heading"
              className="px-1 text-[12px] font-medium text-foreground/65"
            >
              {isZh ? '三步开始高效学习（点击选择起点）' : 'Get started in 3 simple steps (pick where to begin)'}
            </p>
            {features.map((f) => {
              const isSelected = selectedFeature === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  data-testid={`welcome-feature-card-${f.id}`}
                  aria-pressed={isSelected}
                  onClick={() => handleSelectFeature(f.id)}
                  className={cn(
                    'flex w-full items-start gap-3 rounded-lg border px-2.5 py-2 text-left transition-colors [@media(pointer:coarse)]:min-h-11',
                    isSelected
                      ? 'border-primary/40 bg-primary/[0.06] ring-1 ring-primary/20'
                      : 'border-transparent hover:border-border/60 hover:bg-foreground/[0.03]',
                  )}
                >
                  <span className="mt-0.5 flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md bg-foreground/[0.04]">
                    {f.icon}
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-[13px] font-medium leading-snug text-foreground/90">
                      {isZh ? f.titleZh : f.titleEn}
                    </p>
                    <p className="mt-0.5 text-[12px] leading-[1.55] text-foreground/55">
                      {isZh ? f.descZh : f.descEn}
                    </p>
                  </div>
                  {isSelected && (
                    <span
                      aria-hidden="true"
                      className="mt-1 flex h-4 w-4 flex-shrink-0 items-center justify-center rounded-full bg-primary/15 text-primary"
                    >
                      <Check size={11} weight="bold" />
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </div>
        {hasMoreBelow && (
          <div
            aria-hidden="true"
            data-testid="welcome-onboarding-scroll-cue"
            className="pointer-events-none absolute inset-x-0 bottom-0 flex h-7 items-end justify-center bg-gradient-to-t from-background via-background/85 to-transparent pb-0.5 text-foreground/45"
          >
            <CaretDown size={13} weight="bold" />
          </div>
        )}
        </div>

        {/* 底部操作栏 + 非阻塞条款声明 */}
        <div className="flex-shrink-0 border-t border-border/35 px-4 py-2.5 sm:px-6 sm:py-3.5">
          <div className="flex items-center justify-between gap-2">
            <DsButton
              variant="ghost"
              size="md"
              className="text-[13px] [@media(pointer:coarse)]:!min-h-11"
              onClick={onConfigure}
            >
              {effectiveAiReady
                ? (isZh ? '管理 AI 模型' : 'Manage AI Models')
                : (isZh ? '前往完整模型设置' : 'Open AI Settings')}
            </DsButton>
            <DsButton
              variant={effectiveAiReady ? 'primary' : 'ghost'}
              size="md"
              className={cn(
                'text-[13px] [@media(pointer:coarse)]:!min-h-11',
                !effectiveAiReady && 'text-foreground/55',
              )}
              onClick={handleCompleteOnboarding}
            >
              {effectiveAiReady
                ? t('settings:vendor_panel.welcome_ai_ready_cta_start', {
                    defaultValue: t('welcome_onboarding.cta_skip'),
                  })
                : t('welcome_onboarding.cta_skip')}
            </DsButton>
          </div>
          <p
            data-testid="onboarding-legal-notice"
            data-agreed={legalConsent ? 'true' : 'false'}
            className="mt-1.5 sm:mt-2.5 text-center text-[11px] leading-relaxed text-foreground/50"
          >
            {legalConsent ? (
              <span
                data-testid="onboarding-legal-agreed-badge"
                className="mr-1 inline-flex items-center gap-0.5 font-medium text-success"
              >
                <Check size={11} weight="bold" aria-hidden="true" />
                <span>{t('legal.userAgreement.agreedBadge')}</span>
              </span>
            ) : null}
            {isZh ? (
              <>
                {legalConsent ? null : '继续使用即表示同意'}
                <button
                  type="button"
                  data-testid="onboarding-terms-link"
                  onClick={() => setActiveLegalDoc('terms')}
                  className="mx-0.5 cursor-pointer rounded-sm text-foreground/75 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {`《${t('legal.userAgreement.agreementTitle', { defaultValue: '用户协议' })}》`}
                </button>
                {legalConsent ? '' : '与'}
                <button
                  type="button"
                  data-testid="onboarding-privacy-link"
                  onClick={() => setActiveLegalDoc('privacy')}
                  className="mx-0.5 cursor-pointer rounded-sm text-foreground/75 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {`《${t('legal.privacyPolicy.title', { defaultValue: '隐私政策' })}》`}
                </button>
                {legalConsent ? (
                  <>
                    {'与'}
                    <button
                      type="button"
                      data-testid="onboarding-safety-link"
                      onClick={() => setActiveLegalDoc('safety')}
                      className="mx-0.5 cursor-pointer rounded-sm text-foreground/75 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {`《${t('legal.userAgreement.contentSafetyTitle', { defaultValue: '内容使用规范' })}》`}
                    </button>
                  </>
                ) : null}
              </>
            ) : (
              <>
                {legalConsent ? ' ' : 'By continuing, you agree to the '}
                <button
                  type="button"
                  data-testid="onboarding-terms-link"
                  onClick={() => setActiveLegalDoc('terms')}
                  className="cursor-pointer rounded-sm text-foreground/75 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {t('legal.userAgreement.agreementTitle', { defaultValue: 'User Agreement' })}
                </button>
                {legalConsent ? ', ' : ' and '}
                <button
                  type="button"
                  data-testid="onboarding-privacy-link"
                  onClick={() => setActiveLegalDoc('privacy')}
                  className="cursor-pointer rounded-sm text-foreground/75 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                >
                  {t('legal.privacyPolicy.title', { defaultValue: 'Privacy Policy' })}
                </button>
                {legalConsent ? (
                  <>
                    {', and '}
                    <button
                      type="button"
                      data-testid="onboarding-safety-link"
                      onClick={() => setActiveLegalDoc('safety')}
                      className="cursor-pointer rounded-sm text-foreground/75 underline underline-offset-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    >
                      {t('legal.userAgreement.contentSafetyTitle', {
                        defaultValue: 'Content Usage Guidelines',
                      })}
                    </button>
                  </>
                ) : null}
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
      {activeLegalDoc !== null && (
        <OnboardingLegalDialog
          open
          initialTab={activeLegalDoc}
          onClose={() => setActiveLegalDoc(null)}
          onAccept={(record) => setLegalConsent(record)}
        />
      )}
    </>
  );
};

export default WelcomeOnboardingDialog;

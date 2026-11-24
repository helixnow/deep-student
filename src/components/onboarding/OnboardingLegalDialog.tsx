/**
 * OnboardingLegalDialog - 欢迎引导页内置法律文本弹窗
 *
 * 使用标签页（《用户协议》《隐私政策》《内容使用规范》）在固定可滚动视图中直接渲染完整正文，
 * 避免折叠区块在点击标题时收起正文导致空白。
 */
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { cn } from '@/utils/cn';
import { DsButton } from '@/components/ui/DsButton';
import { Z_INDEX } from '@/config/zIndex';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { useFocusTrap } from '@/hooks/useFocusTrap';

export type OnboardingLegalTab = 'terms' | 'privacy' | 'safety';

export interface OnboardingLegalDialogProps {
  open: boolean;
  initialTab: OnboardingLegalTab;
  onClose: () => void;
}

export const OnboardingLegalDialog: React.FC<OnboardingLegalDialogProps> = ({
  open,
  initialTab,
  onClose,
}) => {
  const { t } = useTranslation('common');
  const [activeTab, setActiveTab] = useState<OnboardingLegalTab>(initialTab);
  const panelRef = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (open) {
      setActiveTab(initialTab);
    }
  }, [initialTab, open]);

  useEffect(() => {
    if (!open) return;
    return registerBackHandler(() => {
      onClose();
      return true;
    }, BACK_PRIORITY.overlay + 1);
  }, [onClose, open]);

  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [onClose, open]);

  if (!open || typeof document === 'undefined') return null;

  const isPrivacyInitial = initialTab === 'privacy';
  const headingText = isPrivacyInitial
    ? t('legal.privacyPolicy.title')
    : t('legal.userAgreement.welcomeTitle');
  const closeLabel = isPrivacyInitial ? t('actions.close') : t('close');

  const tabs: Array<{ id: OnboardingLegalTab; label: string }> = [
    { id: 'terms', label: t('legal.userAgreement.agreementTitle') },
    { id: 'privacy', label: t('legal.userAgreement.privacyTitle') },
    { id: 'safety', label: t('legal.userAgreement.contentSafetyTitle') },
  ];

  const dialog = (
    <div
      data-testid="onboarding-legal-dialog"
      className="fixed inset-0 flex items-center justify-center p-3 sm:p-4"
      style={{
        zIndex: Z_INDEX.modal + 10,
        paddingTop: 'calc(0.75rem + var(--android-safe-area-top, env(safe-area-inset-top, 0px)))',
        paddingBottom: 'calc(0.75rem + var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)))',
        paddingLeft: 'calc(0.75rem + var(--android-safe-area-left, env(safe-area-inset-left, 0px)))',
        paddingRight: 'calc(0.75rem + var(--android-safe-area-right, env(safe-area-inset-right, 0px)))',
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div className="absolute inset-0 bg-black/30" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={isPrivacyInitial ? 'privacy-policy-title' : 'user-agreement-title'}
        tabIndex={-1}
        className={cn(
          'relative flex w-full max-w-[560px] flex-col overflow-hidden rounded-lg bg-background outline-none',
          'shadow-[0_0_0_1px_rgba(0,0,0,0.06),0_12px_32px_rgba(0,0,0,0.16)]',
          'dark:shadow-[0_0_0_1px_rgba(255,255,255,0.08),0_12px_32px_rgba(0,0,0,0.45)]',
        )}
        style={{
          maxHeight: 'min(82dvh, calc(100dvh - 1.5rem - var(--android-safe-area-top, env(safe-area-inset-top, 0px)) - var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px))))',
        }}
      >
        {/* 标题区 */}
        <div className="flex-shrink-0 border-b border-border/40 px-4 pb-3 pt-5 sm:px-6 sm:pt-6">
          <h1
            id={isPrivacyInitial ? 'privacy-policy-title' : 'user-agreement-title'}
            className="text-[18px] font-semibold leading-tight text-foreground"
          >
            {headingText}
          </h1>
          <p className="mt-1 text-[12px] leading-relaxed text-foreground/60">
            {isPrivacyInitial
              ? t('legal.privacyPolicy.subtitle')
              : t('legal.userAgreement.welcomeDesc')}
          </p>

          {/* 切换标签（始终展示对应文档全文，不折叠） */}
          <div
            role="tablist"
            aria-label={t('legal.userAgreement.agreementTitle')}
            className="mt-3 flex flex-wrap gap-1.5"
          >
            {tabs.map((tab) => {
              const selected = activeTab === tab.id;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={selected}
                  data-testid={`onboarding-legal-tab-${tab.id}`}
                  onClick={() => setActiveTab(tab.id)}
                  className={cn(
                    'rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors [@media(pointer:coarse)]:min-h-11',
                    selected
                      ? 'border-primary/40 bg-primary/10 text-primary'
                      : 'border-border/50 bg-transparent text-foreground/70 hover:bg-muted/60 hover:text-foreground',
                  )}
                >
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 可滚动正文区：始终非空展示 */}
        <div
          role="tabpanel"
          data-testid="onboarding-legal-body"
          className="min-h-[220px] flex-1 overflow-y-auto overscroll-contain px-4 py-4 text-[13px] leading-relaxed text-foreground/80 scroll-area--native sm:px-6"
          onWheel={(e) => e.stopPropagation()}
        >
          {activeTab === 'terms' && (
            <div className="space-y-3">
              <p>{t('legal.userAgreement.agreementContent.intro')}</p>
              <div className="space-y-2.5">
                <section>
                  <h2 className="text-[13px] font-semibold text-foreground">
                    {t('legal.userAgreement.agreementContent.aiFeatures')}
                  </h2>
                  <p className="mt-0.5 text-foreground/65">
                    {t('legal.userAgreement.agreementContent.aiFeaturesDesc')}
                  </p>
                </section>
                <section>
                  <h2 className="text-[13px] font-semibold text-foreground">
                    {t('legal.userAgreement.agreementContent.dataProcessing')}
                  </h2>
                  <p className="mt-0.5 text-foreground/65">
                    {t('legal.userAgreement.agreementContent.dataProcessingDesc')}
                  </p>
                </section>
                <section>
                  <h2 className="text-[13px] font-semibold text-foreground">
                    {t('legal.userAgreement.agreementContent.userRights')}
                  </h2>
                  <p className="mt-0.5 text-foreground/65">
                    {t('legal.userAgreement.agreementContent.userRightsDesc')}
                  </p>
                </section>
                <section>
                  <h2 className="text-[13px] font-semibold text-foreground">
                    {t('legal.userAgreement.agreementContent.intellectualProperty')}
                  </h2>
                  <p className="mt-0.5 text-foreground/65">
                    {t('legal.userAgreement.agreementContent.intellectualPropertyDesc')}
                  </p>
                </section>
                <section>
                  <h2 className="text-[13px] font-semibold text-foreground">
                    {t('legal.userAgreement.agreementContent.crossBorderData')}
                  </h2>
                  <p className="mt-0.5 text-foreground/65">
                    {t('legal.userAgreement.agreementContent.crossBorderDataDesc')}
                  </p>
                </section>
              </div>
            </div>
          )}

          {activeTab === 'privacy' && (
            <div className="space-y-3">
              <p>{t('legal.privacyPolicy.sections.overview.content')}</p>
              <div className="space-y-2.5">
                <section>
                  <h2 className="text-[13px] font-semibold text-foreground">
                    {t('legal.privacyPolicy.sections.localStorage.title')}
                  </h2>
                  <p className="mt-0.5 text-foreground/65">
                    {t('legal.privacyPolicy.sections.localStorage.content')}
                  </p>
                </section>
                <section>
                  <h2 className="text-[13px] font-semibold text-foreground">
                    {t('legal.privacyPolicy.sections.llmApi.title')}
                  </h2>
                  <p className="mt-0.5 text-foreground/65">
                    {t('legal.privacyPolicy.sections.llmApi.content')}
                  </p>
                </section>
                <section>
                  <h2 className="text-[13px] font-semibold text-foreground">
                    {t('legal.privacyPolicy.sections.errorReporting.title')}
                  </h2>
                  <p className="mt-0.5 text-foreground/65">
                    {t('legal.privacyPolicy.sections.errorReporting.content')}
                  </p>
                </section>
                <section>
                  <h2 className="text-[13px] font-semibold text-foreground">
                    {t('legal.privacyPolicy.sections.noTracking.title')}
                  </h2>
                  <p className="mt-0.5 text-foreground/65">
                    {t('legal.privacyPolicy.sections.noTracking.content')}
                  </p>
                </section>
              </div>
            </div>
          )}

          {activeTab === 'safety' && (
            <div className="space-y-3">
              <p>{t('legal.userAgreement.contentSafety.intro')}</p>
              <ul className="space-y-1.5 text-foreground/70">
                {[1, 2, 3, 4, 5, 6, 7].map((i) => (
                  <li key={i} className="flex items-start gap-2">
                    <span className="mt-[7px] h-1.5 w-1.5 flex-shrink-0 rounded-full bg-foreground/35" />
                    <span>{t(`legal.userAgreement.contentSafety.rule${i}`)}</span>
                  </li>
                ))}
              </ul>
              <p className="rounded-md border border-orange-500/25 bg-orange-500/[0.06] px-3 py-2 text-[12px] font-medium text-orange-600/90 dark:text-orange-400/90">
                {t('legal.userAgreement.contentSafety.note')}
              </p>
            </div>
          )}
        </div>

        {/* 底部关闭栏 */}
        <div className="flex-shrink-0 border-t border-border/40 px-4 py-3.5 sm:px-6">
          <DsButton
            variant="default"
            size="lg"
            data-testid="onboarding-legal-close"
            className="w-full justify-center text-[13px] font-medium [@media(pointer:coarse)]:!min-h-11"
            onClick={onClose}
          >
            {closeLabel}
          </DsButton>
        </div>
      </div>
    </div>
  );

  return createPortal(dialog, document.body);
};

export default OnboardingLegalDialog;

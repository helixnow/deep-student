/**
 * 数据维护与高危操作区（挂载于「设置 → 数据与系统 → 恢复」）
 *
 * 从旧版 DataImportExport 迁移收口：
 * - 原生端（桌面 / 移动）显示 A/B 数据空间切换
 * - 统一提供三步确认的「清空所有数据」入口
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Clock, HardDrives, Trash, Warning } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import {
  DsDialog,
  DsDialogBody,
  DsDialogDescription,
  DsDialogFooter,
  DsDialogHeader,
  DsDialogTitle,
} from '@/components/ui/DsDialog';
import { Input } from '@/components/ui/shad/Input';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { isWebUiShell } from '@/utils/platform';
import { TauriAPI } from '@/utils/tauriApi';
import { getErrorMessage } from '@/utils/errorUtils';
import { cn } from '@/lib/utils';
import { GroupTitle } from '../settingsTabPrimitives';

interface DataSpaceSlotInfo {
  active_slot: string;
  inactive_slot: string;
  pending_slot?: string;
  active_dir: string;
  inactive_dir: string;
}

const isMobileRuntime = (): boolean => {
  if (typeof navigator === 'undefined') return false;
  return /android|iphone|ipad|ipod/i.test(navigator.userAgent || '');
};

export const DataMaintenanceSection: React.FC = () => {
  const { t } = useTranslation(['data', 'common']);
  const isWebUi = isWebUiShell();

  const [slotInfo, setSlotInfo] = useState<DataSpaceSlotInfo | null>(null);
  const [switchingSlot, setSwitchingSlot] = useState(false);

  const [showClearDataDialog, setShowClearDataDialog] = useState(false);
  const [clearDataStep, setClearDataStep] = useState(0);
  const [confirmText, setConfirmText] = useState('');
  const [countdown, setCountdown] = useState(0);
  const [isClearing, setIsClearing] = useState(false);
  const countdownTimerRef = useRef<number | null>(null);

  const clearCountdownTimer = useCallback(() => {
    if (countdownTimerRef.current !== null) {
      window.clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
  }, []);

  const loadDataSpaceInfo = useCallback(async () => {
    if (isWebUi) return;
    try {
      const info = await TauriAPI.getDataSpaceInfo();
      setSlotInfo(info);
    } catch {
      /* 非原生环境或槽位信息不可用时静默跳过 */
    }
  }, [isWebUi]);

  useEffect(() => {
    void loadDataSpaceInfo();
  }, [loadDataSpaceInfo]);

  useEffect(() => {
    if (!showClearDataDialog) {
      clearCountdownTimer();
    }
  }, [showClearDataDialog, clearCountdownTimer]);

  useEffect(() => () => clearCountdownTimer(), [clearCountdownTimer]);

  const startCountdown = useCallback(() => {
    clearCountdownTimer();
    countdownTimerRef.current = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev <= 1) {
          clearCountdownTimer();
          setClearDataStep(2);
          return 0;
        }
        return prev - 1;
      });
    }, 1000);
  }, [clearCountdownTimer]);

  const handleOpenClearDialog = () => {
    setClearDataStep(0);
    setConfirmText('');
    setCountdown(0);
    setShowClearDataDialog(true);
  };

  const executeClearAllData = async () => {
    if (isClearing) return;
    setIsClearing(true);
    try {
      showGlobalNotification('info', t('data:clear_data.in_progress'));
      await TauriAPI.purgeAllDatabaseFiles();
      setShowClearDataDialog(false);

      const mobile = isMobileRuntime();
      showGlobalNotification(
        'success',
        mobile
          ? t('data:clear_data.scheduled_mobile')
          : t('data:clear_data.scheduled_desktop')
      );

      window.setTimeout(() => {
        void TauriAPI.restartApp().catch((error: unknown) => {
          showGlobalNotification(
            'warning',
            t('data:clear_data.restart_failed', { error: getErrorMessage(error) })
          );
        });
      }, 3000);
    } catch {
      showGlobalNotification('error', t('data:clear_data.error'));
    } finally {
      setIsClearing(false);
    }
  };

  const handleNextStep = () => {
    if (clearDataStep === 0) {
      setClearDataStep(1);
      setCountdown(5);
      startCountdown();
      return;
    }
    if (clearDataStep === 2) {
      const expectedText = t('data:clear_dialog.step2_confirm_text');
      if (confirmText === expectedText) {
        clearCountdownTimer();
        void executeClearAllData();
      } else {
        showGlobalNotification('error', t('data:clear_data.confirm_text_error'));
      }
    }
  };

  const handleSwitchSlot = async () => {
    if (switchingSlot) return;
    setSwitchingSlot(true);
    try {
      const msg = await TauriAPI.markDataSpacePendingSwitchToInactive();
      showGlobalNotification('success', msg + t('data:data_space.switch_success_suffix'));
      await loadDataSpaceInfo();
    } catch (error: unknown) {
      showGlobalNotification(
        'error',
        t('data:data_space.switch_failed', { error: getErrorMessage(error) })
      );
    } finally {
      setSwitchingSlot(false);
    }
  };

  return (
    <div className="space-y-6" data-testid="data-maintenance-section">
      {/* A/B 数据空间切换仅原生端可用，WebUI 隐藏 */}
      {!isWebUi && (
        <section>
          <GroupTitle title={t('data:data_space.title')} />
          <div className="rounded-2xl bg-muted p-4 space-y-3">
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('data:data_space.description')}
            </p>
            {slotInfo ? (
              <div className="grid gap-2.5 sm:grid-cols-2">
                <div className="rounded-xl bg-background/70 p-3">
                  <div className="text-xs text-muted-foreground">{t('data:data_space.active_label')}</div>
                  <div className="mt-0.5 text-sm font-semibold text-foreground">{slotInfo.active_slot}</div>
                  {slotInfo.active_dir ? (
                    <div className="mt-0.5 break-all text-xs text-muted-foreground/80">{slotInfo.active_dir}</div>
                  ) : null}
                </div>
                <div className="rounded-xl bg-background/70 p-3">
                  <div className="text-xs text-muted-foreground">{t('data:data_space.inactive_label')}</div>
                  <div className="mt-0.5 text-sm font-semibold text-foreground">{slotInfo.inactive_slot}</div>
                  {slotInfo.inactive_dir ? (
                    <div className="mt-0.5 break-all text-xs text-muted-foreground/80">{slotInfo.inactive_dir}</div>
                  ) : null}
                </div>
                <div className="rounded-xl bg-background/70 p-3 sm:col-span-2">
                  <div className="text-xs text-muted-foreground">{t('data:data_space.pending_label')}</div>
                  <div
                    className={cn(
                      'mt-0.5 text-sm font-semibold',
                      slotInfo.pending_slot ? 'text-primary' : 'text-foreground'
                    )}
                  >
                    {slotInfo.pending_slot || t('data:data_space.pending_none')}
                  </div>
                </div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">{t('data:data_space.loading')}</div>
            )}
            <div className="pt-1">
              <DsButton
                variant="outline"
                size="sm"
                disabled={switchingSlot}
                onClick={() => void handleSwitchSlot()}
                className="rounded-xl border-border/70 bg-background/60 px-3.5 text-foreground hover:bg-background/90"
              >
                <HardDrives size={14} className="mr-1.5" aria-hidden="true" />
                {t('data:data_space.switch_button')}
              </DsButton>
            </div>
          </div>
        </section>
      )}

      {/* 高危区：清空所有数据（三步确认） */}
      <section>
        <GroupTitle title={t('data:clear_section.title')} />
        <div className="rounded-2xl bg-muted p-4 space-y-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('data:clear_section.description')}
          </p>
          <div>
            <DsButton
              variant="outline"
              size="sm"
              data-testid="data-maintenance-clear-all"
              onClick={handleOpenClearDialog}
              className="rounded-xl border-destructive/40 bg-destructive/10 px-3.5 text-destructive hover:bg-destructive/15"
            >
              <Trash size={14} className="mr-1.5" aria-hidden="true" />
              {t('data:clear_section.button')}
            </DsButton>
          </div>
        </div>
      </section>

      <DsDialog
        open={showClearDataDialog}
        onOpenChange={setShowClearDataDialog}
        maxWidth="max-w-md"
        closeOnOverlay={false}
        showClose={false}
      >
        {clearDataStep === 0 && (
          <>
            <DsDialogHeader>
              <DsDialogTitle className="flex items-center gap-2.5">
                <Warning size={20} className="text-destructive" aria-hidden="true" />
                {t('data:clear_dialog.step0_title')}
              </DsDialogTitle>
              <DsDialogDescription>
                {t('data:clear_dialog.step0_desc_prefix')}
                <strong>{t('data:clear_dialog.step0_desc_bold')}</strong>
                {'\n'}
                {t('data:clear_dialog.step0_desc_items')
                  .split('\n')
                  .map((line, i) => (
                    <span key={i}>
                      <br />
                      {line}
                    </span>
                  ))}
                <br />
                <strong>{t('data:clear_dialog.step0_desc_warning')}</strong>
                {'\u3001'}
                {t('data:clear_dialog.step0_desc_advice')}
              </DsDialogDescription>
            </DsDialogHeader>
            <DsDialogFooter>
              <DsButton variant="ghost" size="sm" onClick={() => setShowClearDataDialog(false)}>
                {t('data:clear_dialog.step0_cancel')}
              </DsButton>
              <DsButton variant="danger" size="sm" onClick={handleNextStep}>
                {t('data:clear_dialog.step0_confirm')}
              </DsButton>
            </DsDialogFooter>
          </>
        )}

        {clearDataStep === 1 && (
          <>
            <DsDialogHeader>
              <DsDialogTitle className="flex items-center gap-2.5">
                <Clock size={20} className="text-warning" aria-hidden="true" />
                {t('data:clear_dialog.step1_title')}
              </DsDialogTitle>
              <DsDialogDescription>
                {t('data:clear_dialog.step1_wait')} <strong className="text-base">{countdown}</strong>{' '}
                {t('data:clear_dialog.step1_seconds')}
                <br />
                {t('data:clear_dialog.step1_hint')}
              </DsDialogDescription>
            </DsDialogHeader>
            <DsDialogFooter>
              <DsButton variant="ghost" size="sm" onClick={() => setShowClearDataDialog(false)}>
                {t('data:clear_dialog.step1_cancel')}
              </DsButton>
            </DsDialogFooter>
          </>
        )}

        {clearDataStep === 2 && (
          <>
            <DsDialogHeader>
              <DsDialogTitle className="flex items-center gap-2.5">
                <Trash size={20} className="text-destructive" aria-hidden="true" />
                {t('data:clear_dialog.step2_title')}
              </DsDialogTitle>
              <DsDialogDescription>{t('data:clear_dialog.step2_description')}</DsDialogDescription>
            </DsDialogHeader>
            <DsDialogBody>
              <p className="mb-4 rounded-md bg-muted p-3 text-center text-base font-semibold text-foreground">
                {t('data:clear_dialog.step2_confirm_text')}
              </p>
              <Input
                type="text"
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={t('data:clear_dialog.step2_placeholder')}
              />
            </DsDialogBody>
            <DsDialogFooter>
              <DsButton variant="ghost" size="sm" onClick={() => setShowClearDataDialog(false)}>
                {t('data:clear_dialog.step2_cancel')}
              </DsButton>
              <DsButton
                variant="danger"
                size="sm"
                onClick={handleNextStep}
                disabled={isClearing || confirmText !== t('data:clear_dialog.step2_confirm_text')}
              >
                {t('data:clear_dialog.step2_confirm_button')}
              </DsButton>
            </DsDialogFooter>
          </>
        )}
      </DsDialog>
    </div>
  );
};

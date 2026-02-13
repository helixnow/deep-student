import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertTriangle, Copy, Database, X, XCircle } from 'lucide-react';

import { NotionButton } from '@/components/ui/NotionButton';
import { useSystemStatusStore } from '@/stores/systemStatusStore';
import { cn } from '@/lib/utils';
import { setPendingSettingsTab } from '@/utils/pendingSettingsTab';
import { getMigrationDiagnosticReport } from '@/api/dataGovernance';

/** warning 级别自动消失时长（ms） */
const AUTO_DISMISS_MS = 8000;

export const MigrationStatusBanner: React.FC = () => {
  const { t } = useTranslation(['common', 'data']);
  const migrationVisible = useSystemStatusStore((state) => state.migrationVisible);
  const migrationLevel = useSystemStatusStore((state) => state.migrationLevel);
  const migrationMessage = useSystemStatusStore((state) => state.migrationMessage);
  const migrationDetails = useSystemStatusStore((state) => state.migrationDetails);
  const clearMigrationStatus = useSystemStatusStore((state) => state.clearMigrationStatus);

  // 控制入场/退场动画
  const [phase, setPhase] = useState<'hidden' | 'entering' | 'visible' | 'leaving'>('hidden');
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hoverRef = useRef(false);

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // 退场 -> 清除 store
  const dismiss = useCallback(() => {
    clearTimer();
    setPhase('leaving');
    setTimeout(() => {
      clearMigrationStatus();
      setPhase('hidden');
    }, 200); // 退场动画时长
  }, [clearMigrationStatus, clearTimer]);

  // 自动消失计时
  const startAutoTimer = useCallback(() => {
    clearTimer();
    if (migrationLevel !== 'error') {
      timerRef.current = setTimeout(() => {
        if (!hoverRef.current) dismiss();
      }, AUTO_DISMISS_MS);
    }
  }, [migrationLevel, dismiss, clearTimer]);

  // visible 变化 -> 触发入场
  useEffect(() => {
    if (migrationVisible) {
      setPhase('entering');
      requestAnimationFrame(() => {
        requestAnimationFrame(() => setPhase('visible'));
      });
      startAutoTimer();
    } else {
      setPhase('hidden');
      clearTimer();
    }
    return clearTimer;
  }, [migrationVisible, startAutoTimer, clearTimer]);

  // hover 时暂停自动消失
  const onMouseEnter = useCallback(() => {
    hoverRef.current = true;
    clearTimer();
  }, [clearTimer]);

  const onMouseLeave = useCallback(() => {
    hoverRef.current = false;
    startAutoTimer();
  }, [startAutoTimer]);

  const levelStyles = useMemo(() => {
    if (migrationLevel === 'error') {
      return {
        border: 'border-red-200/60 dark:border-red-500/30',
        iconBg: 'bg-red-500/10 dark:bg-red-500/15',
        iconColor: 'text-red-500 dark:text-red-400',
        Icon: XCircle,
      };
    }
    if (migrationLevel === 'warning') {
      return {
        border: 'border-amber-200/60 dark:border-amber-500/30',
        iconBg: 'bg-amber-500/10 dark:bg-amber-500/15',
        iconColor: 'text-amber-500 dark:text-amber-400',
        Icon: AlertTriangle,
      };
    }
    return {
      border: 'border-blue-200/60 dark:border-blue-500/30',
      iconBg: 'bg-blue-500/10 dark:bg-blue-500/15',
      iconColor: 'text-blue-500 dark:text-blue-400',
      Icon: Database,
    };
  }, [migrationLevel]);

  if (phase === 'hidden') return null;

  const { Icon } = levelStyles;

  const openDataGovernance = () => {
    // 先写入 pending tab，Settings 挂载时会消费该值完成 tab 切换
    setPendingSettingsTab('data-governance');
    // 切换 App 视图到 Settings
    window.dispatchEvent(new CustomEvent('navigate-to-tab', { detail: { tabName: 'settings' } }));
  };

  return (
    <div
      className={cn(
        // 固定定位，右上角浮动
        'fixed top-16 right-4 z-50',
        'w-[360px] max-w-[calc(100vw-2rem)]',
        // 卡片样式：与 UnifiedNotification 保持一致
        'rounded-xl border shadow-lg backdrop-blur-md',
        'bg-card/95 dark:bg-card/90',
        levelStyles.border,
        // 动画
        'transition-all duration-200 ease-out',
        phase === 'entering' && 'opacity-0 translate-x-4',
        phase === 'visible' && 'opacity-100 translate-x-0',
        phase === 'leaving' && 'opacity-0 translate-x-4',
      )}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      data-testid="migration-status-toast"
    >
      <div className="p-3">
        <div className="flex items-start gap-3">
          {/* 图标 */}
          <div className={cn(
            'flex items-center justify-center shrink-0 w-7 h-7 rounded-full',
            levelStyles.iconBg,
          )}>
            <Icon className={cn('h-3.5 w-3.5', levelStyles.iconColor)} />
          </div>

          {/* 内容 */}
          <div className="min-w-0 flex-1">
            <div className="text-[13px] font-semibold text-foreground leading-tight">
              {migrationMessage}
            </div>
            {migrationDetails && (
              <div className="mt-1 text-xs text-muted-foreground leading-snug line-clamp-3">
                {migrationDetails}
              </div>
            )}
          </div>

          {/* 关闭按钮 */}
          <button
            onClick={dismiss}
            className={cn(
              'shrink-0 p-1 rounded-md',
              'text-muted-foreground/60 hover:text-foreground hover:bg-muted/60',
              'transition-colors duration-150',
            )}
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>

        {/* 操作区 */}
        <div className="mt-2.5 flex gap-2 pl-10">
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={openDataGovernance}
          >
            {t('data:governance.toast_view_details', '查看详情')}
          </NotionButton>
          {migrationLevel === 'error' && (
            <CopyDiagnosticButton />
          )}
          <NotionButton
            variant="ghost"
            size="sm"
            className="h-7 px-2.5 text-xs text-muted-foreground"
            onClick={dismiss}
          >
            {t('common:actions.later', '稍后处理')}
          </NotionButton>
        </div>
      </div>
    </div>
  );
};

/** 复制诊断日志按钮（内联子组件） */
const CopyDiagnosticButton: React.FC = () => {
  const { t } = useTranslation(['data']);
  const [copied, setCopied] = useState(false);

  const [copyFailed, setCopyFailed] = useState(false);

  const handleCopy = useCallback(async () => {
    try {
      const report = await getMigrationDiagnosticReport();
      await navigator.clipboard.writeText(report);
      setCopied(true);
      setCopyFailed(false);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setCopyFailed(true);
      setTimeout(() => setCopyFailed(false), 2000);
    }
  }, []);

  return (
    <NotionButton
      variant="ghost"
      size="sm"
      className="h-7 px-2.5 text-xs"
      onClick={handleCopy}
    >
      <Copy className="h-3 w-3 mr-1" />
      {copied
        ? t('data:governance.copied', '已复制')
        : copyFailed
          ? t('data:governance.copy_failed', '复制失败')
          : t('data:governance.copy_log', '复制日志')}
    </NotionButton>
  );
};

export default MigrationStatusBanner;

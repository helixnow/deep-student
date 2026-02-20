import React from 'react';
import { useTranslation } from 'react-i18next';
import { LucideIcon, RefreshCw, Download } from 'lucide-react';
import { NotionButton } from '@/components/ui/NotionButton';

interface HeaderAction {
  icon: LucideIcon;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

interface HeaderTemplateProps {
  icon: LucideIcon;
  iconColor?: string;
  iconSize?: number;
  title: string;
  subtitle?: string;
  isRefreshing?: boolean;
  refreshingText?: string;
  onRefresh?: () => void;
  onExport?: () => void;
  showRefreshButton?: boolean;
  showExportButton?: boolean;
  customActions?: HeaderAction[];
  customRightContent?: React.ReactNode;
  bottomToolbar?: React.ReactNode;
  className?: string;
}

export const HeaderTemplate: React.FC<HeaderTemplateProps> = ({
  icon: Icon,
  iconColor = '#6366f1',
  iconSize = 32,
  title,
  subtitle,
  isRefreshing = false,
  refreshingText,
  onRefresh,
  onExport,
  showRefreshButton = true,
  showExportButton = true,
  customActions = [],
  customRightContent,
  bottomToolbar,
  className = ''
}) => {
  const { t } = useTranslation('common');
  const displayRefreshingText = refreshingText ?? t('header.refreshing_text');

  return (
    <>
      <header
        className={`w-full bg-card px-6 py-4 flex items-center justify-between ${className || ''}`}
      >
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3">
            <Icon size={iconSize} color={iconColor} />
            <div>
              <h1 className="m-0 text-2xl font-semibold text-[hsl(var(--card-foreground))] leading-tight">
                {title}
              </h1>
              {subtitle && (
                <p className="m-0 text-sm text-[hsl(var(--muted-foreground))]">{subtitle}</p>
              )}
            </div>
          </div>
          {isRefreshing && (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium bg-emerald-500/10 text-emerald-600 dark:text-emerald-400">
              <span className="inline-block w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
              <span>{displayRefreshingText}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {customRightContent && <div className="mr-2">{customRightContent}</div>}

          {showRefreshButton && onRefresh && (
            <NotionButton
              variant="outline"
              size="sm"
              onClick={onRefresh}
              disabled={isRefreshing}
            >
              <RefreshCw size={16} className={isRefreshing ? 'animate-spin' : ''} />
              {t('header.refresh')}
            </NotionButton>
          )}

          {showExportButton && onExport && (
            <NotionButton variant="ghost" size="sm" onClick={onExport}>
              <Download size={16} />
              {t('header.export')}
            </NotionButton>
          )}

          {customActions.map((action, index) => (
            <NotionButton
              key={index}
              variant="outline"
              size="sm"
              onClick={action.onClick}
              disabled={action.disabled}
              className={action.className}
            >
              <action.icon size={16} />
              {action.label}
            </NotionButton>
          ))}
        </div>
      </header>

      {bottomToolbar && (
        <div className="w-full bg-card px-6 py-3 flex items-center justify-between min-h-[56px]">
          {bottomToolbar}
        </div>
      )}
    </>
  );
};

import React from 'react';
import { useTranslation } from 'react-i18next';
import { CircleNotch, DownloadSimple } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';

/** Generic icon component type compatible with both Phosphor and Lucide icons */
type IconComponent = React.ComponentType<any>;

interface HeaderAction {
  icon: IconComponent;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

interface HeaderTemplateProps {
  icon: IconComponent;
  iconColor?: string;
  iconSize?: number;
  title: string;
  subtitle?: string;
  isRefreshing?: boolean;
  refreshingText?: string;
  onExport?: () => void;
  showExportButton?: boolean;
  customActions?: HeaderAction[];
  customRightContent?: React.ReactNode;
  bottomToolbar?: React.ReactNode;
  className?: string;
}

export const HeaderTemplate: React.FC<HeaderTemplateProps> = ({
  icon: Icon,
  iconColor = 'currentColor',
  iconSize = 32,
  title,
  subtitle,
  isRefreshing = false,
  refreshingText,
  onExport,
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
            <Icon size={iconSize} color={iconColor} className="text-foreground shrink-0" />
            <div>
              <h1 className="m-0 text-2xl font-semibold text-card-foreground leading-tight">
                {title}
              </h1>
              {subtitle && (
                <p className="m-0 text-sm text-muted-foreground">{subtitle}</p>
              )}
            </div>
          </div>
          {isRefreshing && (
            <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-muted text-muted-foreground">
              <CircleNotch size={14} className="animate-spin motion-reduce:animate-none text-primary" aria-hidden="true" />
              <span>{displayRefreshingText}</span>
            </div>
          )}
        </div>

        <div className="flex items-center gap-2">
          {customRightContent && <div className="mr-2">{customRightContent}</div>}


          {showExportButton && onExport && (
            <DsButton variant="ghost" size="sm" onClick={onExport}>
              <DownloadSimple size={16} />
              {t('header.export')}
            </DsButton>
          )}

          {customActions.map((action, index) => (
            <DsButton
              key={index}
              variant="outline"
              size="sm"
              onClick={action.onClick}
              disabled={action.disabled}
              className={action.className}
            >
              <action.icon size={16} />
              {action.label}
            </DsButton>
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

/**
 * P2增强：附件验证通知组件
 * 显示附件限制信息和验证错误
 */

import React from 'react';
import { DsButton } from '@/components/ui/DsButton';
import { Warning, Info, X } from '@phosphor-icons/react';
import { useTranslation } from 'react-i18next';

interface AttachmentValidationNoticeProps {
  accepted: number;
  rejected: Array<{ item: any; reason: string }>;
  limits: {
    images: string;
    documents: string;
    total: string;
  };
  onClose?: () => void;
  className?: string;
}

export const AttachmentValidationNotice: React.FC<AttachmentValidationNoticeProps> = ({
  accepted,
  rejected,
  limits,
  onClose,
  className = ''
}) => {
  const { t } = useTranslation('chat_host');
  const hasErrors = rejected.length > 0;
  const hasSuccess = accepted > 0;

  if (!hasErrors && !hasSuccess) return null;

  return (
    <div className={`rounded-lg border p-3 ${hasErrors ? 'bg-red-50 border-red-200' : 'bg-green-50 border-green-200'} ${className}`}>
      <div className="flex items-start gap-2">
        {hasErrors ? (
          <Warning size={16} className="text-red-500 mt-0.5 flex-shrink-0" />
        ) : (
          <Info size={16} className="text-green-500 mt-0.5 flex-shrink-0" />
        )}
        
        <div className="flex-1 space-y-2">
          {/* 成功信息 */}
          {hasSuccess && (
            <div className="text-sm text-green-700">
              {t('attachmentValidation.success_added', { count: accepted })}
            </div>
          )}
          
          {/* 错误信息 */}
          {hasErrors && (
            <div className="space-y-1">
              <div className="text-sm font-medium text-red-700">
                {t('attachmentValidation.rejected_count', { count: rejected.length })}
              </div>
              {rejected.slice(0, 5).map((item, index) => (
                <div key={index} className="text-xs text-red-600 ml-4">
                  • {item.item.name}: {item.reason}
                </div>
              ))}
              {rejected.length > 5 && (
                <div className="text-xs text-red-500 ml-4">
                  {t('attachmentValidation.more_rejected', { count: rejected.length - 5 })}
                </div>
              )}
            </div>
          )}
          
          {/* 限制信息 */}
          <div className="text-xs text-gray-600 mt-2 pt-2 border-t border-gray-200">
            <div className="font-medium mb-1">{t('attachmentValidation.limits_title')}</div>
            <div>{t('attachmentValidation.images_limit', { limit: limits.images })}</div>
            <div>{t('attachmentValidation.documents_limit', { limit: limits.documents })}</div>
            <div>{t('attachmentValidation.total_limit', { limit: limits.total })}</div>
          </div>
        </div>
        
        {onClose && (
          <DsButton variant="ghost" size="icon" iconOnly onClick={onClose} className="text-gray-400 hover:text-gray-600 flex-shrink-0 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11" aria-label={t('attachmentValidation.close_notice')}>
            <X size={16} />
          </DsButton>
        )}
      </div>
    </div>
  );
};

export default AttachmentValidationNotice;

import React, { useState } from 'react';
import { AlertTriangle, RefreshCw, X, RotateCcw, Trash2, Download, Wifi } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { getErrorMessage } from '../utils/errorUtils';
import i18n from '../i18n';

// P0修复：统一错误类型定义
export type UnifiedErrorType = 
  | 'streaming'      // 流式处理错误
  | 'attachment'     // 附件解析错误  
  | 'network'        // 网络连接错误
  | 'ocr'           // OCR处理错误
  | 'analysis'      // 分析处理错误
  | 'persistence'   // 持久化错误
  | 'unknown';      // 未知错误

// P0修复：恢复操作类型定义
export type RecoveryAction = {
  type: 'retry' | 'resend' | 'cancel' | 'cleanup' | 'download' | 'skip';
  label: string;
  icon: React.ReactNode;
  action: () => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'danger';
};

// P0修复：统一错误信息接口
export interface UnifiedError {
  id: string;
  type: UnifiedErrorType;
  title: string;
  message: string;
  details?: string;
  timestamp: Date;
  recoveryActions?: RecoveryAction[];
  context?: Record<string, any>;
}

interface UnifiedErrorHandlerProps {
  errors: UnifiedError[];
  onDismiss: (id: string) => void;
  onClearAll: () => void;
  maxVisible?: number;
}

// P0修复：错误类型到UI样式的映射
const getErrorStyles = (type: UnifiedErrorType) => {
  switch (type) {
    case 'streaming':
      return {
        bgColor: 'bg-blue-50 border-blue-200',
        iconColor: 'text-blue-600',
        titleColor: 'text-blue-900'
      };
    case 'attachment':
    case 'ocr':
      return {
        bgColor: 'bg-yellow-50 border-yellow-200', 
        iconColor: 'text-yellow-600',
        titleColor: 'text-yellow-900'
      };
    case 'network':
    case 'analysis':
    case 'persistence':
      return {
        bgColor: 'bg-red-50 border-red-200',
        iconColor: 'text-red-600', 
        titleColor: 'text-red-900'
      };
    default:
      return {
        bgColor: 'bg-gray-50 border-gray-200',
        iconColor: 'text-gray-600',
        titleColor: 'text-gray-900'
      };
  }
};

// P0修复：恢复操作按钮样式
const getActionStyles = (variant: RecoveryAction['variant'] = 'secondary') => {
  switch (variant) {
    case 'primary':
      return 'bg-blue-600 hover:bg-blue-700 text-white';
    case 'danger':
      return 'bg-red-600 hover:bg-red-700 text-white';
    default:
      return 'bg-gray-600 hover:bg-gray-700 text-white';
  }
};

const UnifiedErrorHandler: React.FC<UnifiedErrorHandlerProps> = ({ 
  errors, 
  onDismiss, 
  onClearAll,
  maxVisible = 5 
}) => {
  const { t } = useTranslation('common');
  const [expandedErrors, setExpandedErrors] = useState<Set<string>>(new Set());

  const toggleExpanded = (id: string) => {
    setExpandedErrors(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const visibleErrors = errors.slice(0, maxVisible);
  const hiddenCount = Math.max(0, errors.length - maxVisible);

  if (errors.length === 0) return null;

  return (
    <div className="fixed top-4 right-4 z-50 w-96 space-y-2">
      {/* P0修复：批量清理按钮 */}
      {errors.length > 1 && (
        <div className="flex justify-end">
          <button
            onClick={onClearAll}
            className="text-xs text-gray-500 hover:text-gray-700 flex items-center gap-1"
          >
            <Trash2 size={12} />
            {t('errorHandler.clearAll', { count: errors.length })}
          </button>
        </div>
      )}

      {/* P0修复：错误卡片列表 */}
      {visibleErrors.map((error) => {
        const styles = getErrorStyles(error.type);
        const isExpanded = expandedErrors.has(error.id);

        return (
          <div
            key={error.id}
            className={`${styles.bgColor} border rounded-lg shadow-lg animate-in slide-in-from-right-2 duration-300`}
          >
            {/* 错误头部 */}
            <div className="p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="flex items-start gap-3 flex-1">
                  <AlertTriangle className={`${styles.iconColor} flex-shrink-0 mt-0.5`} size={20} />
                  <div className="flex-1 min-w-0">
                    <h4 className={`font-medium ${styles.titleColor}`}>
                      {error.title}
                    </h4>
                    <p className="text-sm text-gray-700 mt-1 break-words">
                      {error.message}
                    </p>
                    <div className="text-xs text-gray-500 mt-2">
                      {error.timestamp.toLocaleTimeString()}
                    </div>
                  </div>
                </div>
                
                <div className="flex items-center gap-1">
                  {/* 展开/收起按钮 */}
                  {(error.details || error.context) && (
                    <button
                      onClick={() => toggleExpanded(error.id)}
                      className="text-gray-400 hover:text-gray-600 p-1"
                      title={isExpanded ? t('errorHandler.collapseDetails') : t('errorHandler.expandDetails')}
                    >
                      <RotateCcw 
                        size={14} 
                        className={`transform transition-transform ${isExpanded ? 'rotate-180' : ''}`}
                      />
                    </button>
                  )}
                  
                  {/* 关闭按钮 */}
                  <button
                    onClick={() => onDismiss(error.id)}
                    className="text-gray-400 hover:text-gray-600 p-1"
                    title={t('actions.close')}
                  >
                    <X size={14} />
                  </button>
                </div>
              </div>

              {/* P0修复：错误详情展开区域 */}
              {isExpanded && (error.details || error.context) && (
                <div className="mt-3 pt-3 border-t border-gray-200">
                  {error.details && (
                    <div className="mb-2">
                      <div className="text-xs font-medium text-gray-600 mb-1">{t('errorHandler.details')}:</div>
                      <div className="text-xs text-gray-700 bg-white p-2 rounded border font-mono whitespace-pre-wrap">
                        {error.details}
                      </div>
                    </div>
                  )}
                  
                  {error.context && Object.keys(error.context).length > 0 && (
                    <div>
                      <div className="text-xs font-medium text-gray-600 mb-1">{t('errorHandler.contextInfo')}:</div>
                      <div className="text-xs text-gray-700 bg-white p-2 rounded border">
                        {Object.entries(error.context).map(([key, value]) => (
                          <div key={key} className="flex justify-between py-0.5">
                            <span className="font-medium">{key}:</span>
                            <span className="ml-2 break-all">{String(value)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* P0修复：恢复操作按钮区域 */}
            {error.recoveryActions && error.recoveryActions.length > 0 && (
              <div className="px-4 pb-4">
                <div className="flex flex-wrap gap-2">
                  {error.recoveryActions.map((action, index) => (
                    <button
                      key={index}
                      onClick={async () => {
                        try {
                          await action.action();
                        } catch (err: unknown) {
                          console.error('Recovery action failed:', err);
                        }
                      }}
                      className={`
                        px-3 py-1.5 rounded text-xs font-medium 
                        flex items-center gap-1.5 transition-colors
                        ${getActionStyles(action.variant)}
                      `}
                    >
                      {action.icon}
                      {action.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* P0修复：隐藏错误计数提示 */}
      {hiddenCount > 0 && (
        <div className="text-center">
          <div className="text-xs text-gray-500 bg-gray-100 rounded px-3 py-2">
            {t('errorHandler.hiddenCount', { count: hiddenCount })}
          </div>
        </div>
      )}
    </div>
  );
};

export default UnifiedErrorHandler;

// P0修复：错误创建工具函数
export const createUnifiedError = (
  type: UnifiedErrorType,
  error: unknown,
  context?: {
    title?: string;
    recoveryActions?: RecoveryAction[];
    additionalContext?: Record<string, any>;
  }
): UnifiedError => {
  const errorMessage = getErrorMessage(error);
  
  // 根据错误类型生成默认标题和恢复操作
  // 每种类型至少提供一个"关闭"按钮；network / streaming 类型提供额外操作
  const dismissAction: RecoveryAction = {
    type: 'cancel',
    label: i18n.t('common:actions.close'),
    icon: React.createElement(X, { size: 14 }),
    action: () => {/* 由调用方通过 onDismiss 处理 */},
    variant: 'secondary',
  };

  const getDefaultsForType = (type: UnifiedErrorType) => {
    switch (type) {
      case 'streaming':
        return {
          title: i18n.t('common:errorHandler.title_streaming'),
          defaultActions: [
            {
              type: 'retry' as const,
              label: i18n.t('common:actions.retry'),
              icon: React.createElement(RefreshCw, { size: 14 }),
              action: () => { window.location.reload(); },
              variant: 'primary' as const,
            },
            dismissAction,
          ],
        };
      case 'network':
        return {
          title: i18n.t('common:errorHandler.title_network'),
          defaultActions: [
            {
              type: 'retry' as const,
              label: i18n.t('common:actions.check_network'),
              icon: React.createElement(Wifi, { size: 14 }),
              action: () => { window.location.reload(); },
              variant: 'primary' as const,
            },
            dismissAction,
          ],
        };
      case 'attachment':
        return {
          title: i18n.t('common:errorHandler.title_attachment'),
          defaultActions: [dismissAction],
        };
      case 'ocr':
        return {
          title: i18n.t('common:errorHandler.title_ocr'),
          defaultActions: [dismissAction],
        };
      case 'analysis':
        return {
          title: i18n.t('common:errorHandler.title_analysis'),
          defaultActions: [dismissAction],
        };
      case 'persistence':
        return {
          title: i18n.t('common:errorHandler.title_persistence'),
          defaultActions: [dismissAction],
        };
      default:
        return {
          title: i18n.t('common:errorHandler.title_unknown'),
          defaultActions: [dismissAction],
        };
    }
  };

  const defaults = getDefaultsForType(type);

  return {
    id: `error_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    type,
    title: context?.title || defaults.title,
    message: errorMessage,
    details: error instanceof Error ? error.stack : undefined,
    timestamp: new Date(),
    recoveryActions: context?.recoveryActions || defaults.defaultActions,
    context: context?.additionalContext
  };
};

// P0修复：错误管理Hook
export const useUnifiedErrorHandler = () => {
  const [errors, setErrors] = useState<UnifiedError[]>([]);

  const addError = (
    type: UnifiedErrorType,
    error: unknown,
    context?: Parameters<typeof createUnifiedError>[2]
  ) => {
    const unifiedError = createUnifiedError(type, error, context);
    setErrors(prev => [unifiedError, ...prev]);
    return unifiedError.id;
  };

  const dismissError = (id: string) => {
    setErrors(prev => prev.filter(error => error.id !== id));
  };

  const clearAllErrors = () => {
    setErrors([]);
  };

  return {
    errors,
    addError,
    dismissError,
    clearAllErrors
  };
};

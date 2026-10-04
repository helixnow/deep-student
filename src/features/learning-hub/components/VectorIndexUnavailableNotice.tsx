import React from 'react';
import { useTranslation } from 'react-i18next';
import { MagnifyingGlass } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

/**
 * 未编入向量索引的构建（Android mobile-slim，后端无 `lance` feature）下，
 * 取代索引状态页 / 嵌入维度管理的说明：资料不需要也无法向量化，
 * 检索自动走 SQLite 关键词账本，照常可用。
 */
export const VectorIndexUnavailableNotice: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation('learningHub');
  return (
    <div role="note" className={cn('flex items-start gap-3 rounded-xl bg-muted px-4 py-3 text-sm', className)}>
      <MagnifyingGlass size={18} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {t('vectorIndexUnavailable.title', { defaultValue: '此版本使用关键词检索' })}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {t('vectorIndexUnavailable.body', {
            defaultValue: '此版本不包含向量索引，资料无需建立索引：上传后即可在对话和搜索中按关键词检索到。',
          })}
        </p>
      </div>
    </div>
  );
};

export default VectorIndexUnavailableNotice;

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Plugs } from '@phosphor-icons/react';
import { isVectorIndexUnavailable, openEmbeddingSettings, useEmbeddingReadiness } from '../embeddingReadiness';

/**
 * 「知识库未启用」横幅：嵌入模型不可用时，说明后果与原因，并一键前往配置。
 * 配置完成后后台会自动把因此失败的资料重新排队索引，无需逐条重试。
 */
export const EmbeddingReadinessBanner: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation('learningHub');
  const readiness = useEmbeddingReadiness();
  // 未编入向量索引的构建：配置嵌入模型也不会启用向量化，不引导用户去配置
  if (!readiness || readiness.ready || isVectorIndexUnavailable(readiness)) return null;
  return (
    <div role="alert" className={`flex items-start gap-3 border-b border-[hsl(var(--warning)/0.25)] bg-[hsl(var(--warning)/0.08)] px-4 py-3 text-sm ${className ?? ''}`}>
      <Plugs size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">{t('embeddingReadiness.title', { defaultValue: '知识库尚未启用：没有可用的嵌入模型' })}</p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {t('embeddingReadiness.body', { defaultValue: '资料可以上传和阅读，但无法被向量化，对话时检索不到。配置嵌入模型后，失败和待处理的资料会自动重新索引。' })}
          {readiness.reason && <span className="mt-1 block opacity-80">{readiness.reason}</span>}
        </p>
      </div>
      <button type="button" onClick={openEmbeddingSettings}
        className="shrink-0 rounded-md bg-[hsl(var(--primary))] px-3 py-1.5 text-xs font-medium text-[hsl(var(--primary-foreground))] hover:opacity-90 [@media(pointer:coarse)]:min-h-11">
        {t('embeddingReadiness.action', { defaultValue: '配置嵌入模型' })}
      </button>
    </div>
  );
};

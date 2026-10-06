import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plugs } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import {
  getCapabilityStatusCached,
  subscribeCapabilityStatus,
  type MultimodalCapabilityStatus,
} from '@/services/multimodalRagService';
import { isVectorIndexUnavailable, openEmbeddingSettings, useEmbeddingReadiness } from '../embeddingReadiness';

/**
 * 「多模态索引尚未启用」横幅。
 *
 * 与 EmbeddingReadinessBanner 的区别：那条管**文本向量**轨道——配置任意文本嵌入模型
 * 后后端会自动探测并生效；这条管**原生多模态**轨道，它只读「默认多模态维度」绑定的
 * 模型（`embedding.default_multimodal_model_config_id`）。没有默认多模态维度时，
 * 一键索引的多模态部分会对每个资源报「未配置多模态嵌入模型」，而错误文案把用户
 * 引向供应商/模型配置，真正缺的东西却在「嵌入维度管理」里。
 *
 * 因此这里把「多模态轨道未就绪」显式暴露出来，并直达配置页。
 */
export const MultimodalReadinessBanner: React.FC<{ className?: string }> = ({ className }) => {
  const { t } = useTranslation('learningHub');
  const embeddingReadiness = useEmbeddingReadiness();
  const [status, setStatus] = useState<MultimodalCapabilityStatus | null>(null);

  // 挂载时探测一次；能力快照更新时同步；回到窗口时重新探测
  // （用户在设置里配好默认维度后切回索引页，横幅应立即消失）。
  const refresh = useCallback(() => {
    void getCapabilityStatusCached().then(setStatus);
  }, []);

  useEffect(() => {
    refresh();
    return subscribeCapabilityStatus(setStatus);
  }, [refresh]);

  useEventRegistry([{ target: 'window', type: 'focus', listener: refresh }], [refresh]);

  // 未编入向量索引的构建：多模态索引根本不存在，配置也无用，不引导用户去配置
  if (isVectorIndexUnavailable(embeddingReadiness)) return null;
  // 探测失败/尚未探测（probe_failed 或非 Tauri 环境）：状态未知时不打扰用户
  if (!status || !status.probed || status.available) return null;

  return (
    <div role="alert" className={`flex items-start gap-3 border-b border-[hsl(var(--warning)/0.25)] bg-[hsl(var(--warning)/0.08)] px-4 py-3 text-sm ${className ?? ''}`}>
      <Plugs size={18} className="mt-0.5 shrink-0 text-warning" aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <p className="font-medium text-foreground">
          {t('multimodalReadiness.title', { defaultValue: '多模态索引尚未启用' })}
        </p>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
          {t('multimodalReadiness.body', {
            defaultValue: '资料可以上传和阅读，但不会建立按页图像的多模态索引。请在「设置 → 模型 → 模型分配 → 嵌入维度管理」中把多模态维度设为默认。',
          })}
          {status.error && <span className="mt-1 block opacity-80">{status.error}</span>}
        </p>
      </div>
      <DsButton variant="primary" size="sm" onClick={openEmbeddingSettings} className="shrink-0">
        {t('multimodalReadiness.action', { defaultValue: '去配置多模态嵌入' })}
      </DsButton>
    </div>
  );
};

export default MultimodalReadinessBanner;

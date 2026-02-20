/**
 * P2增强：来源预览面板组件
 * 用于侧边显示RAG/记忆来源的原文预览
 */

import React, { useMemo, useState } from 'react';
import { NotionButton } from '@/components/ui/NotionButton';
import { X, Copy, ExternalLink, FileText, Download } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { MarkdownRenderer } from '../chat-v2/components/renderers';
import { CustomScrollArea } from './custom-scroll-area';
import { fileManager } from '@/utils/fileManager';
import { copyTextToClipboard } from '@/utils/clipboardUtils';

interface SourceInfo {
  document_id: string;
  file_name: string;
  chunk_text: string;
  score: number;
  chunk_index: number;
  source_type: 'rag' | 'memory' | 'web_search' | 'multimodal';
}

interface SourcePreviewPanelProps {
  source: SourceInfo | null;
  isOpen: boolean;
  onClose: () => void;
  onOpenInKnowledgeBase?: (documentId: string, fileName: string) => void;
}

export const SourcePreviewPanel: React.FC<SourcePreviewPanelProps> = ({
  source,
  isOpen,
  onClose,
  onOpenInKnowledgeBase
}) => {
  const { t } = useTranslation('common');
  const [copied, setCopied] = useState(false);

  if (!isOpen || !source) return null;

  const handleCopyContent = async () => {
    try {
      await copyTextToClipboard(source.chunk_text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      console.log('📋 [来源预览] 已复制内容到剪贴板');
    } catch (e: unknown) {
      console.warn('复制失败:', e);
    }
  };

  const handleOpenInKnowledgeBase = () => {
    if (onOpenInKnowledgeBase) {
      onOpenInKnowledgeBase(source.document_id, source.file_name);
    } else {
      console.log('🔍 [来源预览] 在学习资源中打开:', source.file_name);
      // 默认行为：尝试导航到学习资源页面
      try {
        window.dispatchEvent(new CustomEvent('DSTU_NAVIGATE_TO_KNOWLEDGE_BASE', {
          detail: { documentId: source.document_id, fileName: source.file_name }
        }));
      } catch {}
    }
  };

  const handleDownload = async () => {
    try {
      const defaultName = `${source.file_name}_chunk_${source.chunk_index}.txt`;
      await fileManager.saveTextFile({
        title: defaultName,
        defaultFileName: defaultName,
        content: source.chunk_text,
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
      console.log('💾 [来源预览] 已下载片段内容');
    } catch (e: unknown) {
      console.warn('下载失败:', e);
    }
  };

  // 来源类型提示文案
  const variant = useMemo(() => {
    if (source.source_type === 'memory') return 'info';
    if (source.source_type === 'rag') return 'success';
    if (source.source_type === 'web_search') return 'warning';
    if (source.source_type === 'multimodal') return 'info';
    return 'muted';
  }, [source.source_type]);

  const badgeStyles = useMemo(() => {
    switch (variant) {
      case 'info':
        return {
          bg: 'hsl(var(--info-bg))',
          color: 'hsl(var(--info))',
          border: 'hsl(var(--info) / 0.35)'
        };
      case 'success':
        return {
          bg: 'hsl(var(--success-bg))',
          color: 'hsl(var(--success))',
          border: 'hsl(var(--success) / 0.35)'
        };
      case 'warning':
        return {
          bg: 'hsl(var(--warning-bg))',
          color: 'hsl(var(--warning))',
          border: 'hsl(var(--warning) / 0.35)'
        };
      default:
        return {
          bg: 'hsl(var(--muted))',
          color: 'hsl(var(--muted-foreground))',
          border: 'hsl(var(--border))'
        };
    }
  }, [variant]);

  const panelAccentStyles = useMemo(() => {
    switch (variant) {
      case 'info':
        return {
          background: 'hsl(var(--info-bg))',
          borderColor: 'hsl(var(--info) / 0.3)',
          color: 'hsl(var(--info))'
        };
      case 'success':
        return {
          background: 'hsl(var(--success-bg))',
          borderColor: 'hsl(var(--success) / 0.3)',
          color: 'hsl(var(--success))'
        };
      case 'warning':
        return {
          background: 'hsl(var(--warning-bg))',
          borderColor: 'hsl(var(--warning) / 0.35)',
          color: 'hsl(var(--warning))'
        };
      default:
        return {
          background: 'hsl(var(--muted) / 0.65)',
          borderColor: 'hsl(var(--border) / 0.5)',
          color: 'hsl(var(--muted-foreground))'
        };
    }
  }, [variant]);

  const copyButtonState = copied ? 'success' : 'idle';

  return (
    <div className="fixed inset-y-0 right-0 w-96 bg-card text-[hsl(var(--foreground))] shadow-lg ring-1 ring-border/40 border-l border-transparent z-50 flex flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between p-4 border-b border-transparent ring-1 ring-border/40 bg-muted/50">
        <div className="flex items-center gap-3">
          <FileText size={20} className="text-[hsl(var(--muted-foreground))]" />
          <div>
            <h3 className="text-lg font-semibold text-[hsl(var(--foreground))]">{t('source_preview.title')}</h3>
            <div className="flex items-center gap-2 mt-1">
              <span
                style={{
                  fontSize: 12,
                  padding: '2px 6px',
                  background: badgeStyles.bg,
                  color: badgeStyles.color,
                  border: `1px solid ${badgeStyles.border}`,
                  borderRadius: 999
                }}
              >
                {variant === 'info' ? t('source_preview.info') : variant === 'success' ? t('source_preview.kb_search') : variant === 'warning' ? t('source_preview.external_search') : t('source_preview.other')}
              </span>
              <span className="text-sm text-[hsl(var(--muted-foreground))]">
                {t('source_preview.confidence', { score: Math.round(source.score * 100) })}
              </span>
            </div>
          </div>
        </div>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} className="!p-2 !rounded-lg hover:bg-[hsl(var(--muted)/0.6)]" aria-label={t('source_preview.close')}>
          <X size={20} className="text-[hsl(var(--muted-foreground))]" />
        </NotionButton>
      </div>

      {/* 文件信息 */}
      <div
        className="p-4 border-b"
        style={{
          background: panelAccentStyles.background,
          borderColor: panelAccentStyles.borderColor,
          color: panelAccentStyles.color
        }}
      >
        <div className="text-sm font-medium">{source.file_name}</div>
        <div className="text-xs mt-1 opacity-80">
          {t('source_preview.chunk_label', { index: source.chunk_index + 1 })} · ID: {source.document_id.slice(0, 8)}...
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="p-4 border-b border-[hsl(var(--border))]">
        <div className="flex gap-2 flex-wrap">
          <NotionButton variant="ghost" size="sm" onClick={handleCopyContent} className={`!px-3 !py-2 text-sm !rounded-lg border ${copyButtonState === 'success' ? 'bg-[hsl(var(--success)/0.18)] text-[hsl(var(--success))] border-[hsl(var(--success)/0.35)] shadow-sm' : 'bg-[hsl(var(--card)/0.65)] text-[hsl(var(--foreground))] border-[hsl(var(--border)/0.55)] hover:bg-[hsl(var(--card)/0.8)]'}`}>
            <Copy size={14} />
            {copied ? t('source_preview.copied') : t('source_preview.copy_chunk')}
          </NotionButton>

          <NotionButton variant="ghost" size="sm" onClick={handleOpenInKnowledgeBase} className="!px-3 !py-2 text-sm !rounded-lg border bg-[hsl(var(--info-bg))] text-[hsl(var(--info))] border-[hsl(var(--info)/0.4)] hover:brightness-95">
            <ExternalLink size={14} />
            {t('source_preview.open_in_kb')}
          </NotionButton>

          <NotionButton variant="ghost" size="sm" onClick={handleDownload} className="!px-3 !py-2 text-sm !rounded-lg border bg-[hsl(var(--card)/0.65)] text-[hsl(var(--foreground))] border-[hsl(var(--border)/0.55)] hover:bg-[hsl(var(--card)/0.8)]">
            <Download size={14} />
            {t('source_preview.download')}
          </NotionButton>
        </div>
      </div>

      {/* 内容预览 */}
      <CustomScrollArea className="flex-1 min-h-0 -mr-4 pl-4 pb-4 bg-card" viewportClassName="pr-4" trackOffsetTop={12} trackOffsetBottom={12} trackOffsetRight={0}>
        <div className="prose prose-sm max-w-none text-[hsl(var(--foreground))]">
          <MarkdownRenderer content={source.chunk_text} />
        </div>
      </CustomScrollArea>
    </div>
  );
};

export default SourcePreviewPanel;

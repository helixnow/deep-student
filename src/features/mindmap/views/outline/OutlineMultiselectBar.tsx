/**
 * 多选浮动操作条：完成 / 缩进 / 反缩进 / 复制 / 删除 / 清除选择。
 * 内容区内 absolute 浮层，非模态。
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  ArrowsInLineVertical,
  CheckCircle,
  Copy,
  TextIndent,
  TextOutdent,
  Trash,
  X,
} from '@phosphor-icons/react';
import { NotionButton } from '@/components/ui/NotionButton';

export interface OutlineMultiselectBarProps {
  count: number;
  onComplete: () => void;
  onIndent: () => void;
  onOutdent: () => void;
  onCopy: () => void;
  onDelete: () => void;
  onClear: () => void;
}

export const OutlineMultiselectBar: React.FC<OutlineMultiselectBarProps> = ({
  count,
  onComplete,
  onIndent,
  onOutdent,
  onCopy,
  onDelete,
  onClear,
}) => {
  const { t } = useTranslation('mindmap');

  return (
    <div
      className="outline-multiselect-bar"
      role="toolbar"
      aria-label={t('outline.selectedCount', { count })}
    >
      <span className="outline-multiselect-count">
        {t('outline.selectedCount', { count })}
      </span>
      <NotionButton
        variant="ghost"
        className="outline-multiselect-btn"
        onClick={onComplete}
        title={t('outline.batchComplete')}
      >
        <CheckCircle size={16} />
        <span>{t('outline.batchComplete')}</span>
      </NotionButton>
      <NotionButton
        variant="ghost"
        className="outline-multiselect-btn"
        onClick={onIndent}
        title={`${t('mindmap:outline.batchIndent', { defaultValue: '缩进' })} (Tab)`}
      >
        <TextIndent size={16} />
        <span>{t('mindmap:outline.batchIndent', { defaultValue: '缩进' })}</span>
      </NotionButton>
      <NotionButton
        variant="ghost"
        className="outline-multiselect-btn"
        onClick={onOutdent}
        title={`${t('mindmap:outline.batchOutdent', { defaultValue: '反缩进' })} (Shift+Tab)`}
      >
        <TextOutdent size={16} />
        <span>{t('mindmap:outline.batchOutdent', { defaultValue: '反缩进' })}</span>
      </NotionButton>
      <NotionButton
        variant="ghost"
        className="outline-multiselect-btn"
        onClick={onCopy}
        title={t('mindmap:outline.batchCopy', { defaultValue: '复制' })}
      >
        <Copy size={16} />
        <span>{t('mindmap:outline.batchCopy', { defaultValue: '复制' })}</span>
      </NotionButton>
      <NotionButton
        variant="ghost"
        className="outline-multiselect-btn destructive"
        onClick={onDelete}
        title={t('actions.delete')}
      >
        <Trash size={16} />
        <span>{t('actions.delete')}</span>
      </NotionButton>
      <NotionButton
        variant="ghost"
        className="outline-multiselect-btn"
        onClick={onClear}
        title={t('outline.clearSelection')}
      >
        <X size={16} />
      </NotionButton>
    </div>
  );
};

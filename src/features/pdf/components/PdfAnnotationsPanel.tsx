/**
 * PDF 侧栏批注面板（0824 Wave2-B r5「SOTA-PDF」）
 *
 * 从 EnhancedPdfViewer 内联的 renderHighlightList 独立出来的批注 tab 内容，
 * 桌面侧栏与移动全屏子屏共用。在原「列表 + 跳页 + 删除」之上补齐：
 * - S5：颜色 chips + 文本过滤（纯前端列表过滤，逻辑在 pdfAnnotationList）
 * - S1：点击批注项经 onSelectHighlight 精确定位到高亮块（滚动 + 闪烁，
 *   由 viewer 侧 focusHighlight 实现——面板不碰页面 DOM）
 * - S2：「导出为笔记」把当前（筛选后）批注按页分组汇总成 Markdown，
 *   走共享 useSaveAsNoteFlow 选目录落库；来源行带 pdfref:// 回链（S4），
 *   在笔记里点击即可跳回原 PDF 对应页
 *
 * 本组件由 viewer React.lazy 挂载（与 PdfSelectionActions 同一纪律）：
 * shared/notes → FolderPickerDialog 链路不进 PDF 主 chunk。
 */

import React, { useCallback, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Export, Highlighter, X } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { SaveAsNoteFolderPicker, useSaveAsNoteFlow } from '@/shared/notes';
import {
  buildAnnotationSummaryMarkdown,
  collectHighlightColors,
  filterHighlights,
  resourceIdFromDstuPath,
  sortHighlightsForList,
  type AnnotationHighlight,
} from '../pdfAnnotationList';

export interface PdfAnnotationsPanelProps {
  highlights: AnnotationHighlight[];
  /** 人类可读文件名（导出笔记标题与来源行用），不是 DSTU 资源 ID */
  fileName?: string;
  /** DSTU 资源路径（末段为 sourceId）；缺省时导出来源行降级为纯文本、无回链 */
  resourcePath?: string;
  /** 点击批注项：viewer 侧跳页 + 精确定位闪烁；移动端由 viewer 包一层关面板 */
  onSelectHighlight: (highlight: AnnotationHighlight) => void;
  onRemoveHighlight: (id: string) => void;
}

export const PdfAnnotationsPanel: React.FC<PdfAnnotationsPanelProps> = ({
  highlights,
  fileName,
  resourcePath,
  onSelectHighlight,
  onRemoveHighlight,
}) => {
  const { t } = useTranslation(['pdf', 'common']);
  const [query, setQuery] = useState('');
  const [activeColors, setActiveColors] = useState<string[]>([]);

  const sorted = useMemo(() => sortHighlightsForList(highlights), [highlights]);
  const colors = useMemo(() => collectHighlightColors(sorted), [sorted]);
  const visible = useMemo(
    () => filterHighlights(sorted, { colors: activeColors, query }),
    [sorted, activeColors, query],
  );

  const toggleColor = useCallback((color: string) => {
    setActiveColors((prev) => {
      const key = color.toLowerCase();
      return prev.some((c) => c.toLowerCase() === key)
        ? prev.filter((c) => c.toLowerCase() !== key)
        : [...prev, color];
    });
  }, []);

  // 导出为笔记：当前筛选结果按页分组 → Markdown（来源行带 pdfref:// 回链）
  // → 共享目录选择流程（与划词「保存为笔记」同一落库路径，绝不直写根目录）
  const saveAsNoteFlow = useSaveAsNoteFlow({ openSource: 'pdf-annotations' });
  const startSaveAsNote = saveAsNoteFlow.start;
  const handleExport = useCallback(() => {
    const content = buildAnnotationSummaryMarkdown({
      highlights: visible,
      sourceId: resourceIdFromDstuPath(resourcePath),
      labels: {
        pageHeading: (page) => t('pdf:toolbar.page', { page }),
        sourceLine: (page) =>
          fileName
            ? t('pdf:selection.note_source', { name: fileName, page })
            : t('pdf:toolbar.page', { page }),
      },
    });
    if (!content) return;
    startSaveAsNote({
      content,
      title: fileName
        ? t('pdf:annotations.summary_title', { name: fileName })
        : t('pdf:annotations.summary_title_fallback'),
    });
  }, [visible, resourcePath, fileName, startSaveAsNote, t]);

  const hasAnyHighlights = sorted.length > 0;

  return (
    <div className="ds-annotations-panel">
      {hasAnyHighlights && (
        <div className="ds-annotations-toolbar">
          <Input
            type="search"
            className="ds-annotations-filter-input [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!text-base"
            placeholder={t('pdf:annotations.filter_placeholder')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            aria-label={t('pdf:annotations.filter_placeholder')}
          />
          <div className="ds-annotations-toolbar-row">
            {colors.length > 1 && (
              <div
                className="ds-annotations-color-chips"
                role="group"
                aria-label={t('pdf:annotations.filter_by_color')}
              >
                {colors.map((color) => {
                  const active = activeColors.some(
                    (c) => c.toLowerCase() === color.toLowerCase(),
                  );
                  return (
                    <button
                      key={color.toLowerCase()}
                      type="button"
                      className={`ds-annotations-color-chip [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11 ${active ? 'active' : ''}`}
                      style={{ backgroundColor: color }}
                      onClick={() => toggleColor(color)}
                      aria-pressed={active}
                      aria-label={t('pdf:annotations.color_chip', { color })}
                      title={t('pdf:annotations.color_chip', { color })}
                    />
                  );
                })}
              </div>
            )}
            <DsButton
              variant="ghost"
              size="sm"
              className="ds-annotations-export gap-1.5 [@media(pointer:coarse)]:!min-h-11"
              onClick={handleExport}
              disabled={visible.length === 0 || saveAsNoteFlow.isSaving}
              title={t('pdf:annotations.export_hint')}
            >
              <Export size={14} />
              {t('pdf:annotations.export', { num: visible.length })}
            </DsButton>
          </div>
        </div>
      )}

      <CustomScrollArea
        className="ds-highlights-list"
        viewportClassName="ds-highlights-list-viewport"
      >
        {!hasAnyHighlights ? (
          <div className="ds-bookmarks-empty">
            <Highlighter size={24} className="ds-bookmarks-empty-icon" />
            <p>{t('pdf:toolbar.no_highlights')}</p>
            <p className="ds-bookmarks-empty-hint">{t('pdf:toolbar.no_highlights_hint')}</p>
          </div>
        ) : visible.length === 0 ? (
          <div className="ds-bookmarks-empty">
            <Highlighter size={24} className="ds-bookmarks-empty-icon" />
            <p>{t('pdf:annotations.no_filter_match')}</p>
          </div>
        ) : (
          visible.map((hl) => (
            <div
              key={hl.id}
              className="ds-highlight-item"
              onClick={() => onSelectHighlight(hl)}
              title={t('pdf:annotations.locate', { page: hl.pageIndex })}
            >
              <div className="ds-highlight-color" style={{ backgroundColor: hl.color }} />
              <div className="ds-highlight-content">
                <div className="ds-highlight-text">{hl.text}</div>
                <div className="ds-highlight-meta">
                  {t('pdf:toolbar.page', { page: hl.pageIndex })}
                </div>
              </div>
              <DsButton
                variant="ghost"
                size="icon"
                iconOnly
                className="ds-highlight-delete"
                onClick={(e) => {
                  e.stopPropagation();
                  onRemoveHighlight(hl.id);
                }}
                title={t('pdf:toolbar.delete_highlight')}
                aria-label={t('pdf:a11y.delete')}
              >
                <X size={12} />
              </DsButton>
            </div>
          ))
        )}
      </CustomScrollArea>

      <SaveAsNoteFolderPicker {...saveAsNoteFlow.pickerProps} />
    </div>
  );
};

export default PdfAnnotationsPanel;

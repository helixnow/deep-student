/**
 * 模板库 — 内联导入 / 导出面板（页内展开，替代原模态框）。
 */
import React, { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Upload, Download, X, FileArrowUp, CheckCircle, WarningCircle,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { cn } from '@/lib/utils';
import type { CustomAnkiTemplate } from '@/types';

export interface ImportPanelResult {
  ok: boolean;
  message: string;
}

/* ── 导入面板 ── */

export interface TemplateImportPanelProps {
  selectedFile: File | null;
  onFileChange: (file: File | null) => void;
  overwriteExisting: boolean;
  onOverwriteChange: (value: boolean) => void;
  isImporting: boolean;
  onConfirm: () => void;
  onClose: () => void;
  result: ImportPanelResult | null;
}

export const TemplateImportPanel: React.FC<TemplateImportPanelProps> = ({
  selectedFile,
  onFileChange,
  overwriteExisting,
  onOverwriteChange,
  isImporting,
  onConfirm,
  onClose,
  result,
}) => {
  const { t } = useTranslation('template');
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    onFileChange(file || null);
    // 允许重复选择同一文件
    e.target.value = '';
  };

  return (
    <section className="wb-tm-panel" aria-label={t('templateMgmt.import_panel_title')}>
      <header className="wb-tm-panel-header">
        <h3 className="wb-tm-panel-title">
          <Upload size={15} aria-hidden />
          {t('templateMgmt.import_panel_title')}
        </h3>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          onClick={onClose}
          disabled={isImporting}
          aria-label={t('templateMgmt.panel_close')}
          title={t('templateMgmt.panel_close')}
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
        >
          <X size={14} />
        </DsButton>
      </header>

      <p className="wb-tm-panel-desc">{t('import_external_dialog_desc')}</p>

      <details className="wb-tm-panel-details">
        {/* 触屏：summary 命中区升到 44px（保留 list-item display，不丢失展开三角标） */}
        <summary className="[@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:py-3">
          {t('templateMgmt.import_rules_toggle')}
        </summary>
        <ul className="wb-tm-panel-rules">
          <li>{t('import_external_rule_1')}</li>
          <li>{t('import_external_rule_2')}</li>
          <li>{t('import_external_rule_3')}</li>
          <li>{t('import_external_rule_4')}</li>
          <li>{t('import_external_rule_5')}</li>
        </ul>
      </details>

      <div className="wb-tm-panel-body">
        <input
          ref={fileInputRef}
          type="file"
          accept="application/json,.json"
          onChange={handleFileSelected}
          className="sr-only"
          tabIndex={-1}
          aria-hidden
        />
        <div className="wb-tm-file-row">
          <DsButton
            variant="default"
            size="sm"
            onClick={() => fileInputRef.current?.click()}
            disabled={isImporting}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            <FileArrowUp size={14} />
            {selectedFile ? t('templateMgmt.import_change_file') : t('templateMgmt.import_choose_file')}
          </DsButton>
          {selectedFile ? (
            <span className="wb-tm-file-name" title={selectedFile.name}>
              {selectedFile.name}
              <button
                type="button"
                className="wb-tm-file-clear"
                onClick={() => onFileChange(null)}
                disabled={isImporting}
                aria-label={t('templateMgmt.import_clear_file')}
                title={t('templateMgmt.import_clear_file')}
              >
                <X size={11} weight="bold" />
              </button>
            </span>
          ) : (
            <span className="wb-tm-file-name wb-tm-file-name--empty">{t('templateMgmt.import_no_file')}</span>
          )}
        </div>

        {/* 触屏：勾选行整体升到 44px 命中高度（checkbox 本体 16px 不足触控标准） */}
        <label className="wb-tm-panel-checkline [@media(pointer:coarse)]:min-h-11">
          <Checkbox
            checked={overwriteExisting}
            onCheckedChange={(v) => onOverwriteChange(Boolean(v))}
            disabled={isImporting}
          />
          <span>{t('overwrite_existing_label')}</span>
        </label>
      </div>

      {result && (
        <div
          className={cn('wb-tm-panel-result', result.ok ? 'wb-tm-panel-result--ok' : 'wb-tm-panel-result--error')}
          role="status"
        >
          {result.ok
            ? <CheckCircle size={15} weight="fill" aria-hidden />
            : <WarningCircle size={15} weight="fill" aria-hidden />}
          <pre className="wb-tm-panel-result-text">{result.message}</pre>
        </div>
      )}

      <footer className="wb-tm-panel-footer">
        <DsButton
          variant="ghost"
          size="sm"
          onClick={onClose}
          disabled={isImporting}
          className="[@media(pointer:coarse)]:!min-h-11"
        >
          {t('cancel_button')}
        </DsButton>
        <DsButton
          variant="primary"
          size="sm"
          onClick={onConfirm}
          disabled={!selectedFile || isImporting}
          className="[@media(pointer:coarse)]:!min-h-11"
        >
          {isImporting ? t('importing') : t('start_import_button')}
        </DsButton>
      </footer>
    </section>
  );
};

/* ── 导出面板 ── */

export interface TemplateExportPanelProps {
  templates: CustomAnkiTemplate[];
  selection: Set<string>;
  onToggleSelection: (templateId: string, checked: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  isExporting: boolean;
  onConfirm: () => void;
  onClose: () => void;
  error: string | null;
}

export const TemplateExportPanel: React.FC<TemplateExportPanelProps> = ({
  templates,
  selection,
  onToggleSelection,
  onSelectAll,
  onClearSelection,
  isExporting,
  onConfirm,
  onClose,
  error,
}) => {
  const { t } = useTranslation('template');

  return (
    <section className="wb-tm-panel" aria-label={t('templateMgmt.export_panel_title')}>
      <header className="wb-tm-panel-header">
        <h3 className="wb-tm-panel-title">
          <Download size={15} aria-hidden />
          {t('templateMgmt.export_panel_title')}
        </h3>
        <div className="wb-tm-panel-header-actions">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={onSelectAll}
            disabled={isExporting || templates.length === 0}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            {t('select_all_button')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={onClearSelection}
            disabled={isExporting || selection.size === 0}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            {t('clear_selection_button')}
          </DsButton>
          <DsButton
            variant="ghost"
            size="icon"
            iconOnly
            onClick={onClose}
            disabled={isExporting}
            aria-label={t('templateMgmt.panel_close')}
            title={t('templateMgmt.panel_close')}
            className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          >
            <X size={14} />
          </DsButton>
        </div>
      </header>

      <p className="wb-tm-panel-desc">{t('export_dialog_desc')}</p>

      {templates.length === 0 ? (
        <div className="wb-tm-panel-desc">{t('no_exportable_templates')}</div>
      ) : (
        <CustomScrollArea
          className="wb-tm-export-list"
          fullHeight={false}
        >
          <div className="wb-tm-export-list-grid">
            {templates.map((template) => (
              <label key={template.id} className="wb-tm-export-item">
                <Checkbox
                  checked={selection.has(template.id)}
                  onCheckedChange={(checked) => onToggleSelection(template.id, checked === true)}
                  disabled={isExporting}
                />
                <span className="wb-tm-export-item-body">
                  <span className="wb-tm-export-item-name">{template.name}</span>
                  <span className="wb-tm-export-item-meta">
                    {t('field_count_meta', { count: template.fields.length })}
                    {' · '}
                    {t('type_meta', { type: template.note_type })}
                    {template.is_built_in ? ` · ${t('builtin_badge')}` : ''}
                  </span>
                </span>
              </label>
            ))}
          </div>
        </CustomScrollArea>
      )}

      {error && (
        <div className="wb-tm-panel-result wb-tm-panel-result--error" role="alert">
          <WarningCircle size={15} weight="fill" aria-hidden />
          <pre className="wb-tm-panel-result-text">{error}</pre>
        </div>
      )}

      <footer className="wb-tm-panel-footer">
        <span className="wb-tm-panel-count" aria-live="polite">
          {t('templateMgmt.export_selected_count', { count: selection.size })}
        </span>
        <div className="wb-tm-panel-footer-actions">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={onClose}
            disabled={isExporting}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            {t('cancel_button')}
          </DsButton>
          <DsButton
            variant="primary"
            size="sm"
            onClick={onConfirm}
            disabled={isExporting || selection.size === 0}
            className="[@media(pointer:coarse)]:!min-h-11"
          >
            {isExporting ? t('exporting') : t('export_count_button', { count: selection.size })}
          </DsButton>
        </div>
      </footer>
    </section>
  );
};

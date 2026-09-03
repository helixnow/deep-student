import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { DsButton } from '@/components/ui/DsButton';
import { Input } from '@/components/ui/shad/Input';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/shad/Tabs';
import { Progress } from '@/components/ui/shad/Progress';
import { CircleNotch, FileArchive, Info, Package, Warning, X } from '@phosphor-icons/react';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { NotesAPI } from '@/utils/notesApi';
import { cn } from '@/lib/utils';
import { readCssDurationMs, useMotionPresence } from '@/hooks/useMotionPresence';

export type ImportConflictStrategy = 'skip' | 'overwrite' | 'merge_keep_newer';

/** Pref key shared with the host wrappers that record successful exports. */
export const NOTES_LIBRARY_LAST_EXPORT_PREF = 'notes.library.last_export_at';

export interface ImportProgress {
  stage: 'parsing' | 'importing_notes' | 'importing_attachments' | 'importing_preferences' | 'done';
  progress: number;
  current_item: string | null;
  processed: number;
  total: number;
}

export interface NotesLibraryPanelProps {
  activeTab: 'export' | 'import';
  onTabChange: (tab: 'export' | 'import') => void;
  /** Dismisses the hosting panel (Esc / close button / cancel). */
  onClose: () => void;

  // 导出相关
  exportTargetPath: string;
  onExportTargetPathChange: (path: string) => void;
  onPickExportPath: () => void;
  exportPathLoading: boolean;
  exporting: boolean;
  onConfirmExport: () => void;

  // 导入相关
  importFilePath: string;
  onImportFilePathChange: (path: string) => void;
  onPickImportFile: () => void;
  importing: boolean;
  onConfirmImport: () => void;
  importConflictStrategy: ImportConflictStrategy;
  onImportConflictStrategyChange: (strategy: ImportConflictStrategy) => void;
  importProgress: ImportProgress | null;
}

interface NotesLibraryManagerProps extends Omit<NotesLibraryPanelProps, 'onClose'> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function formatExportTimestamp(value: number, language: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(language.startsWith('zh') ? 'zh-CN' : language, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/**
 * Pure inline panel body for the notes library (export / import).
 * Carries no positioning, scrim, or modal semantics — the host decides
 * where it lives. `NotesLibraryManager` below wraps it into a
 * right-anchored floating panel for backward compatibility.
 */
export function NotesLibraryPanel({
  activeTab,
  onTabChange,
  onClose,
  exportTargetPath,
  onExportTargetPathChange,
  onPickExportPath,
  exportPathLoading,
  exporting,
  onConfirmExport,
  importFilePath,
  onImportFilePathChange,
  onPickImportFile,
  importing,
  onConfirmImport,
  importConflictStrategy,
  onImportConflictStrategyChange,
  importProgress,
}: NotesLibraryPanelProps) {
  const { t, i18n } = useTranslation(['notes', 'common']);
  const conflictGroupId = useId();
  const [lastExportAt, setLastExportAt] = useState<number | null>(null);

  // Refresh "last exported" info on mount and after an export run settles.
  useEffect(() => {
    if (exporting) return;
    let cancelled = false;
    void NotesAPI.getPref(NOTES_LIBRARY_LAST_EXPORT_PREF)
      .then((value) => {
        if (cancelled) return;
        const parsed = value ? Number(value) : NaN;
        setLastExportAt(Number.isFinite(parsed) && parsed > 0 ? parsed : null);
      })
      .catch(() => {
        if (!cancelled) setLastExportAt(null);
      });
    return () => { cancelled = true; };
  }, [exporting]);

  const lastExportLabel = lastExportAt !== null
    ? formatExportTimestamp(lastExportAt, i18n.language || 'zh-CN')
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start justify-between gap-2 border-b border-border px-5 pt-4 pb-3">
        <div className="min-w-0 space-y-1">
          <h2 className="text-[15px] font-semibold text-foreground">
            {t('notes:library_manager.title')}
          </h2>
          <p className="text-xs leading-relaxed text-muted-foreground">
            {t('notes:library_manager.description')}
          </p>
        </div>
        <DsButton
          variant="ghost"
          size="icon"
          className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11"
          onClick={onClose}
          disabled={exporting || importing}
          aria-label={t('common:actions.close', '关闭')}
          title={t('common:actions.close', '关闭')}
        >
          <X className="h-4 w-4" />
        </DsButton>
      </div>

      <Tabs
        value={activeTab}
        onValueChange={(v) => onTabChange(v as 'export' | 'import')}
        className="flex flex-1 flex-col min-h-0"
      >
        <TabsList className="mx-5 mt-3 grid w-auto grid-cols-2">
          <TabsTrigger value="export" className="gap-2">
            <FileArchive className="h-4 w-4" />
            {t('notes:library_manager.tabs.export')}
          </TabsTrigger>
          <TabsTrigger value="import" className="gap-2">
            <Package className="h-4 w-4" />
            {t('notes:library_manager.tabs.import')}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="export" className="flex-1 mt-4 min-h-0">
          <CustomScrollArea className="h-full" viewportClassName="px-5 pb-5 space-y-5">
            {/* 导出说明 */}
            <div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-foreground">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0 text-info" aria-hidden />
              <span className="leading-relaxed">{t('notes:export.all_notes_hint')}</span>
            </div>

            {/* 导出格式说明 */}
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4">
              <div className="flex items-start gap-3">
                <FileArchive className="h-5 w-5 text-primary mt-0.5 flex-shrink-0" />
                <div className="space-y-1">
                  <h4 className="text-sm font-semibold text-foreground">
                    {t('notes:export.format.markdown')} (.zip)
                  </h4>
                  <p className="text-xs text-muted-foreground leading-relaxed">
                    {t('notes:export.format.markdown_help')}
                  </p>
                </div>
              </div>
            </div>

            {/* 导出路径 */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                {t('notes:export.destination.label')}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={exportTargetPath}
                  readOnly
                  placeholder={t('notes:export.destination.placeholder')}
                  className="min-w-[180px] flex-1 [@media(pointer:coarse)]:min-h-11"
                />
                <DsButton
                  variant="outline"
                  size="sm"
                  className="[@media(pointer:coarse)]:!min-h-11"
                  onClick={onPickExportPath}
                  disabled={exportPathLoading || exporting}
                >
                  {exportPathLoading ? (
                    <>
                      <CircleNotch className="mr-2 h-4 w-4 animate-spin" />
                      {t('notes:export.destination.choose')}
                    </>
                  ) : (
                    t('notes:export.destination.choose')
                  )}
                </DsButton>
                {exportTargetPath && (
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className="[@media(pointer:coarse)]:!min-h-11"
                    onClick={() => onExportTargetPathChange('')}
                    disabled={exporting || exportPathLoading}
                  >
                    {t('notes:export.destination.clear')}
                  </DsButton>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('notes:export.destination.help')}
              </p>
              {lastExportLabel && (
                <p className="text-xs text-muted-foreground/80">
                  {(i18n.language || 'zh-CN').startsWith('zh')
                    ? `上次导出：${lastExportLabel}`
                    : `Last exported: ${lastExportLabel}`}
                </p>
              )}
            </div>
          </CustomScrollArea>
        </TabsContent>

        <TabsContent value="import" className="flex-1 mt-4 min-h-0">
          <CustomScrollArea className="h-full" viewportClassName="px-5 pb-5 space-y-5">
            <div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-muted/20 px-4 py-3 text-sm text-foreground">
              <Warning className="mt-0.5 h-4 w-4 flex-shrink-0 text-warning" aria-hidden />
              <span className="leading-relaxed">{t('notes:import.restore_warning')}</span>
            </div>
            {/* 选择导入文件 */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                {t('notes:import.file.label')}
              </label>
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  value={importFilePath}
                  readOnly
                  placeholder={t('notes:import.file.placeholder')}
                  className="min-w-[180px] flex-1 [@media(pointer:coarse)]:min-h-11"
                />
                <DsButton
                  variant="outline"
                  size="sm"
                  className="[@media(pointer:coarse)]:!min-h-11"
                  onClick={onPickImportFile}
                  disabled={importing}
                >
                  {t('notes:import.file.choose')}
                </DsButton>
                {importFilePath && (
                  <DsButton
                    variant="ghost"
                    size="sm"
                    className="[@media(pointer:coarse)]:!min-h-11"
                    onClick={() => onImportFilePathChange('')}
                    disabled={importing}
                  >
                    {t('notes:import.file.clear')}
                  </DsButton>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('notes:import.file.help')}
              </p>
            </div>

            {/* 冲突策略：内联单选，不再弹出下拉 */}
            <div className="space-y-2">
              <span
                id={`${conflictGroupId}-label`}
                className="block text-sm font-medium text-foreground"
              >
                {t('notes:import.conflict_strategy.label')}
              </span>
              <div
                role="radiogroup"
                aria-labelledby={`${conflictGroupId}-label`}
                className="grid gap-1.5"
              >
                {([
                  { value: 'skip', label: t('notes:import.conflict_strategy.skip') },
                  { value: 'overwrite', label: t('notes:import.conflict_strategy.overwrite') },
                  { value: 'merge_keep_newer', label: t('notes:import.conflict_strategy.merge_keep_newer') },
                ] as const).map((option) => {
                  const selected = importConflictStrategy === option.value;
                  return (
                    <label
                      key={option.value}
                      className={cn(
                        'flex cursor-pointer items-center gap-2.5 rounded-lg border px-3 py-2 text-sm transition-colors [@media(pointer:coarse)]:min-h-11',
                        selected
                          ? 'border-primary/50 bg-primary/5 text-foreground'
                          : 'border-border/60 text-muted-foreground hover:bg-muted/30',
                        importing && 'cursor-not-allowed opacity-60',
                      )}
                    >
                      <input
                        type="radio"
                        name={conflictGroupId}
                        value={option.value}
                        checked={selected}
                        disabled={importing}
                        onChange={() => onImportConflictStrategyChange(option.value)}
                        className="h-3.5 w-3.5 flex-shrink-0 accent-primary"
                      />
                      <span>{option.label}</span>
                    </label>
                  );
                })}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('notes:import.conflict_strategy.help')}
              </p>
            </div>

            {/* 进度显示 */}
            {importing && importProgress && (
              <div className="space-y-3 rounded-lg border border-border/60 bg-muted/20 p-4">
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-foreground">
                    {t(`notes:import.progress.stage.${importProgress.stage}`)}
                  </span>
                  <span className="text-muted-foreground">
                    {importProgress.progress}%
                  </span>
                </div>
                <Progress value={importProgress.progress} className="h-2" />
                {importProgress.current_item && (
                  <p className="text-xs text-muted-foreground truncate">
                    {importProgress.current_item}
                  </p>
                )}
                {importProgress.total > 0 && (
                  <p className="text-xs text-muted-foreground">
                    {t('notes:import.progress.processed', {
                      processed: importProgress.processed,
                      total: importProgress.total,
                    })}
                  </p>
                )}
              </div>
            )}

            {/* 导入说明 */}
            <div className="rounded-lg border border-border/60 bg-muted/20 p-4 space-y-3">
              <h4 className="text-sm font-semibold text-foreground">
                {t('notes:import.instructions.title')}
              </h4>
              <ul className="space-y-2 text-sm text-muted-foreground list-disc list-inside">
                <li>{t('notes:import.instructions.step1')}</li>
                <li>{t('notes:import.instructions.step2')}</li>
                <li>{t('notes:import.instructions.step3')}</li>
              </ul>
            </div>
          </CustomScrollArea>
        </TabsContent>
      </Tabs>

      <div className="flex items-center justify-end gap-2 border-t border-border/60 px-5 py-3">
        <DsButton
          variant="ghost"
          className="[@media(pointer:coarse)]:!min-h-11"
          onClick={onClose}
          disabled={exporting || importing}
        >
          {t('notes:dialogs.cancel')}
        </DsButton>
        {activeTab === 'export' ? (
          <DsButton
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={onConfirmExport}
            disabled={exporting || !exportTargetPath}
          >
            {exporting ? (
              <>
                <CircleNotch className="mr-2 h-4 w-4 animate-spin" />
                {t('notes:export.actions.exporting')}
              </>
            ) : (
              t('notes:export.actions.export')
            )}
          </DsButton>
        ) : (
          <DsButton
            className="[@media(pointer:coarse)]:!min-h-11"
            onClick={onConfirmImport}
            disabled={importing || !importFilePath}
          >
            {importing ? (
              <>
                <CircleNotch className="mr-2 h-4 w-4 animate-spin" />
                {t('notes:import.actions.importing')}
              </>
            ) : (
              t('notes:import.actions.import')
            )}
          </DsButton>
        )}
      </div>
    </div>
  );
}

/**
 * Backward-compatible export. Same props as the old dialog version, but the
 * presentation is now a non-modal, right-anchored inline panel:
 * - no fullscreen scrim, outside clicks stay live;
 * - no dialog role / aria-modal / focus trap; Escape dismisses (unless a job
 *   is running);
 * - rise-in entry via the shared `.ui-rise-in` motion class.
 */
export function NotesLibraryManager({
  open,
  onOpenChange,
  ...panelProps
}: NotesLibraryManagerProps) {
  const { t } = useTranslation(['notes', 'common']);
  const titleId = useId();
  const busy = panelProps.exporting || panelProps.importing;
  const presence = useMotionPresence(open, {
    exitMs: readCssDurationMs('--dropdown-close-dur', 150),
    enter: 'animation',
  });

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      if (!busy) onOpenChange(false);
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [busy, onOpenChange, open]);

  if (!presence.mounted) return null;

  return (
    <section
      role="region"
      aria-labelledby={titleId}
      data-state={presence.exiting ? 'closed' : 'open'}
      aria-hidden={presence.exiting || undefined}
      className={cn(
        presence.exiting ? 'ui-rise-out' : 'ui-rise-in',
        'absolute right-3 top-3 bottom-3 z-[60] flex w-[min(460px,calc(100%-24px))] flex-col overflow-hidden rounded-[var(--notes-radius-popup,12px)] border border-border bg-popover text-popover-foreground shadow-[var(--shadow-shell-floating,var(--notes-popup-shadow))]',
      )}
    >
      {/* Visually-hidden anchor for aria-labelledby; the visible title lives inside the panel. */}
      <span id={titleId} className="sr-only">
        {t('notes:library_manager.title')}
      </span>
      <NotesLibraryPanel
        {...panelProps}
        onClose={() => { if (!busy) onOpenChange(false); }}
      />
    </section>
  );
}

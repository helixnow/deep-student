import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/shad/Dialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { Input } from '../ui/shad/Input';
import { AppSelect } from '../ui/app-menu';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/shad/Tabs';
import { Progress } from '../ui/shad/Progress';
import { Loader2, FileArchive, Package } from 'lucide-react';
import { CustomScrollArea } from '../custom-scroll-area';

export type ImportConflictStrategy = 'skip' | 'overwrite' | 'merge_keep_newer';

export interface ImportProgress {
  stage: 'parsing' | 'importing_notes' | 'importing_attachments' | 'importing_preferences' | 'done';
  progress: number;
  current_item: string | null;
  processed: number;
  total: number;
}

interface NotesLibraryManagerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  activeTab: 'export' | 'import';
  onTabChange: (tab: 'export' | 'import') => void;
  
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

export function NotesLibraryManager({
  open,
  onOpenChange,
  activeTab,
  onTabChange,
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
}: NotesLibraryManagerProps) {
  const { t } = useTranslation(['notes', 'common']);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-hidden p-0 flex flex-col">
        <DialogHeader className="px-6 pt-6 pb-3 flex-shrink-0">
          <DialogTitle>{t('notes:library_manager.title')}</DialogTitle>
          <DialogDescription className="text-sm leading-relaxed text-muted-foreground">
            {t('notes:library_manager.description')}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(v) => onTabChange(v as 'export' | 'import')} className="flex-1 flex flex-col min-h-0">
          <TabsList className="mx-6 grid w-auto grid-cols-2">
            <TabsTrigger value="export" className="gap-2">
              <FileArchive className="h-4 w-4" />
              {t('notes:library_manager.tabs.export')}
            </TabsTrigger>
            <TabsTrigger value="import" className="gap-2">
              <Package className="h-4 w-4" />
              {t('notes:library_manager.tabs.import')}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="export" className="flex-1 mt-4">
            <CustomScrollArea className="h-full" viewportClassName="px-6 pb-6 space-y-5">
            {/* 导出说明 */}
            <div className="rounded-lg border border-blue-500/40 bg-blue-50 px-4 py-3 text-sm text-blue-900 dark:border-blue-500/30 dark:bg-blue-500/10 dark:text-blue-100">
              {t('notes:export.all_notes_hint', '将导出所有笔记及其附件')}
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
                  className="min-w-[200px] flex-1"
                />
                <NotionButton
                  variant="outline"
                  size="sm"
                  onClick={onPickExportPath}
                  disabled={exportPathLoading || exporting}
                >
                  {exportPathLoading ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t('notes:export.destination.choose')}
                    </>
                  ) : (
                    t('notes:export.destination.choose')
                  )}
                </NotionButton>
                {exportTargetPath && (
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => onExportTargetPathChange('')}
                    disabled={exporting || exportPathLoading}
                  >
                    {t('notes:export.destination.clear')}
                  </NotionButton>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('notes:export.destination.help')}
              </p>
            </div>
            </CustomScrollArea>
          </TabsContent>

          <TabsContent value="import" className="flex-1 mt-4">
            <CustomScrollArea className="h-full" viewportClassName="px-6 pb-6 space-y-5">
            <div className="rounded-lg border border-amber-500/40 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-100">
              {t('notes:import.restore_warning')}
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
                  className="min-w-[200px] flex-1"
                />
                <NotionButton
                  variant="outline"
                  size="sm"
                  onClick={onPickImportFile}
                  disabled={importing}
                >
                  {t('notes:import.file.choose')}
                </NotionButton>
                {importFilePath && (
                  <NotionButton
                    variant="ghost"
                    size="sm"
                    onClick={() => onImportFilePathChange('')}
                    disabled={importing}
                  >
                    {t('notes:import.file.clear')}
                  </NotionButton>
                )}
              </div>
              <p className="text-xs text-muted-foreground">
                {t('notes:import.file.help')}
              </p>
            </div>

            {/* 冲突策略选择 */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">
                {t('notes:import.conflict_strategy.label')}
              </label>
              <AppSelect
                value={importConflictStrategy}
                onValueChange={(value) => onImportConflictStrategyChange(value as ImportConflictStrategy)}
                disabled={importing}
                placeholder={t('notes:import.conflict_strategy.placeholder')}
                options={[
                  { value: 'skip', label: t('notes:import.conflict_strategy.skip') },
                  { value: 'overwrite', label: t('notes:import.conflict_strategy.overwrite') },
                  { value: 'merge_keep_newer', label: t('notes:import.conflict_strategy.merge_keep_newer') },
                ]}
              />
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
                      total: importProgress.total 
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

        <DialogFooter className="px-6 pb-6 pt-2 flex-shrink-0 border-t border-border/40">
          <NotionButton
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={exporting || importing}
          >
            {t('notes:dialogs.cancel')}
          </NotionButton>
          {activeTab === 'export' ? (
            <NotionButton
              onClick={onConfirmExport}
              disabled={exporting || !exportTargetPath}
            >
              {exporting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('notes:export.actions.exporting')}
                </>
              ) : (
                t('notes:export.actions.export')
              )}
            </NotionButton>
          ) : (
            <NotionButton
              onClick={onConfirmImport}
              disabled={importing || !importFilePath}
            >
              {importing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t('notes:import.actions.importing')}
                </>
              ) : (
                t('notes:import.actions.import')
              )}
            </NotionButton>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

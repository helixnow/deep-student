/**
 * CSV 导入对话框
 * 
 * 支持 4 个步骤的导入流程：
 * 1. 文件选择（支持拖拽上传）
 * 2. 预览和字段映射
 * 3. 去重策略选择
 * 4. 导入进度和结果
 * 
 * Notion 风格 UI：
 * - 清晰的步骤指示
 * - 友好的拖拽区域
 * - 简洁的表格预览
 * - 流畅的进度动画
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
import { NotionButton } from '@/components/ui/NotionButton';
import { Label } from '@/components/ui/shad/Label';
import { Progress } from '@/components/ui/shad/Progress';
import { Alert, AlertDescription } from '@/components/ui/shad/Alert';
import {
  FileSpreadsheet,
  ChevronRight,
  ChevronLeft,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  RefreshCw,
  Upload,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { fileManager } from '@/utils/fileManager';
import { showGlobalNotification } from './UnifiedNotification';
import CsvFieldMapper, { FieldMapping, QUESTION_FIELDS, QuestionFieldKey } from './CsvFieldMapper';
import { UnifiedDragDropZone, type FileTypeDefinition } from './shared/UnifiedDragDropZone';

// CSV 专用文件类型定义
const CSV_FILE_TYPE: FileTypeDefinition = {
  extensions: ['csv'],
  mimeTypes: ['text/csv', 'application/csv', 'text/comma-separated-values'],
  description: 'CSV',
};

// 去重策略
type DuplicateStrategy = 'skip' | 'overwrite' | 'merge';

// CSV 预览结果（来自后端）
interface CsvPreviewResult {
  headers: string[];
  rows: string[][];
  total_rows: number;
  encoding: string;
}

// CSV 导入进度（来自后端事件）
interface CsvImportProgressEvent {
  type: 'Started' | 'Progress' | 'Completed' | 'Failed';
  total_rows?: number;
  file_path?: string;
  current?: number;
  total?: number;
  success?: number;
  skipped?: number;
  failed?: number;
  error?: string;
  /** M-022: 会话隔离标识 */
  exam_id?: string;
}

// CSV 导入结果（来自后端）
interface CsvImportResult {
  success_count: number;
  skipped_count: number;
  failed_count: number;
  errors: Array<{ row: number; message: string; raw_data?: string }>;
  exam_id: string;
  total_rows: number;
}

interface CsvImportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 目标题目集 ID */
  examId: string;
  /** 题目集名称（用于创建新题目集） */
  examName?: string;
  /** 文件夹 ID（可选） */
  folderId?: string;
  /** 导入完成回调 */
  onImportComplete?: (result: CsvImportResult) => void;
}

const STEP_KEYS = ['select', 'mapping', 'strategy', 'progress'] as const;

const STEPS = STEP_KEYS.map((key) => ({ key }));

type StepKey = typeof STEPS[number]['key'];

// 去重策略选项 (titles/descriptions resolved via i18n at render time)
const DUPLICATE_STRATEGY_KEYS: DuplicateStrategy[] = ['skip', 'overwrite', 'merge'];

export const CsvImportDialog: React.FC<CsvImportDialogProps> = ({
  open,
  onOpenChange,
  examId,
  examName,
  folderId,
  onImportComplete,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common']);

  // 步骤状态
  const [currentStep, setCurrentStep] = useState<StepKey>('select');
  const stepIndex = STEPS.findIndex((s) => s.key === currentStep);

  // 文件选择状态
  const [selectedFile, setSelectedFile] = useState<string | null>(null);

  // CSV 预览状态
  const [preview, setPreview] = useState<CsvPreviewResult | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);

  // 字段映射状态
  const [fieldMapping, setFieldMapping] = useState<FieldMapping>({});

  // 去重策略状态
  const [duplicateStrategy, setDuplicateStrategy] = useState<DuplicateStrategy>('skip');

  // 导入状态
  const [isImporting, setIsImporting] = useState(false);
  const [importProgress, setImportProgress] = useState<{
    current: number;
    total: number;
    success: number;
    skipped: number;
    failed: number;
  } | null>(null);
  const [importResult, setImportResult] = useState<CsvImportResult | null>(null);
  const [importError, setImportError] = useState<string | null>(null);

  // 事件监听清理函数
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // 重置状态
  const resetState = useCallback(() => {
    setCurrentStep('select');
    setSelectedFile(null);
    setPreview(null);
    setFieldMapping({});
    setDuplicateStrategy('skip');
    setImportProgress(null);
    setImportResult(null);
    setImportError(null);
    setIsImporting(false);
    setIsLoadingPreview(false);
    setIsCancelled(false);
  }, []);

  // 关闭对话框时重置
  useEffect(() => {
    if (!open) {
      resetState();
    }
  }, [open, resetState]);

  // 清理事件监听
  useEffect(() => {
    return () => {
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, []);

  // 处理文件选择
  const handleFileSelect = useCallback(async (filePath: string) => {
    setSelectedFile(filePath);
    setIsLoadingPreview(true);
    setImportError(null);

    try {
      // 调用后端获取预览
      const result = await invoke<CsvPreviewResult>('get_csv_preview', {
        filePath,
        rows: 5,
      });
      
      setPreview(result);

      // 自动推断字段映射
      const autoMapping: FieldMapping = {};
      result.headers.forEach((header) => {
        const headerLower = header.toLowerCase().trim();
        // 常见映射规则
        if (/题目|题干|内容|content|question|text/.test(headerLower)) {
          autoMapping[header] = 'content';
        } else if (/答案|正确|answer|correct/.test(headerLower)) {
          autoMapping[header] = 'answer';
        } else if (/解析|解答|说明|explanation|analysis/.test(headerLower)) {
          autoMapping[header] = 'explanation';
        } else if (/选项|options|choices/.test(headerLower)) {
          autoMapping[header] = 'options';
        } else if (/难度|difficulty|level/.test(headerLower)) {
          autoMapping[header] = 'difficulty';
        } else if (/标签|分类|tags|category/.test(headerLower)) {
          autoMapping[header] = 'tags';
        } else if (/题型|类型|type|question_type/.test(headerLower)) {
          autoMapping[header] = 'question_type';
        } else if (/题号|序号|label|number|no/.test(headerLower)) {
          autoMapping[header] = 'question_label';
        }
      });
      setFieldMapping(autoMapping);

      // 自动跳转到映射步骤
      setCurrentStep('mapping');
    } catch (error: unknown) {
      console.error('[CsvImport] 预览失败:', error);
      setImportError(t('exam_sheet:csv.preview_failed', '预览 CSV 文件失败：{{error}}', {
        error: String(error),
      }));
    } finally {
      setIsLoadingPreview(false);
    }
  }, [t]);

  // 选择文件按钮点击
  const handleSelectFileClick = useCallback(async () => {
    try {
      const filePath = await fileManager.pickSingleFile({
        title: t('exam_sheet:csv.select_csv_file', '选择 CSV 文件'),
        // 移除 filters 以支持移动端
      });
      
      if (filePath) {
        // 验证文件扩展名
        if (!filePath.toLowerCase().endsWith('.csv')) {
          showGlobalNotification('warning', t('exam_sheet:csv.invalid_file_type', '请选择 CSV 格式的文件'));
          return;
        }
        await handleFileSelect(filePath);
      }
    } catch (error: unknown) {
      console.error('[CsvImport] 选择文件失败:', error);
      showGlobalNotification('error', t('exam_sheet:csv.select_file_failed', '选择文件失败'));
    }
  }, [t, handleFileSelect]);

  // 处理拖拽上传的文件路径（通过 UnifiedDragDropZone 的 onPathsDropped）
  const handlePathsDropped = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    const filePath = paths[0];
    // 验证文件扩展名
    if (!filePath.toLowerCase().endsWith('.csv')) {
      showGlobalNotification('warning', t('exam_sheet:csv.invalid_file_type', '请选择 CSV 格式的文件'));
      return;
    }
    await handleFileSelect(filePath);
  }, [handleFileSelect, t]);

  // 处理拖拽上传的 File 对象（Web 环境 fallback，不使用）
  const handleFilesDropped = useCallback(() => {
    // CSV 导入需要文件路径，不使用 File 对象
    // Tauri 环境会使用 onPathsDropped
  }, []);

  // 检查映射是否有效
  const isMappingValid = Object.values(fieldMapping).includes('content');

  // 开始导入
  const handleStartImport = useCallback(async () => {
    if (!selectedFile || !preview || !isMappingValid) return;

    setIsImporting(true);
    setImportError(null);
    setImportProgress({ current: 0, total: preview.total_rows, success: 0, skipped: 0, failed: 0 });
    setCurrentStep('progress');

    try {
      // 设置进度事件监听
      const unlisten = await listen<CsvImportProgressEvent>('csv_import_progress', (event) => {
        const payload = event.payload;

        // M-022: 会话隔离 - 只处理当前 exam 的事件，防止多任务进度串台
        if (payload.exam_id && payload.exam_id !== examId) return;
        
        if (payload.type === 'Progress') {
          setImportProgress({
            current: payload.current || 0,
            total: payload.total || preview.total_rows,
            success: payload.success || 0,
            skipped: payload.skipped || 0,
            failed: payload.failed || 0,
          });
        } else if (payload.type === 'Failed') {
          setImportError(payload.error || t('exam_sheet:csv.import_failed_generic'));
          setIsImporting(false);
        }
      });
      unlistenRef.current = unlisten;

      // 构建字段映射（CSV 列名 -> 目标字段）
      const mapping: Record<string, string> = {};
      Object.entries(fieldMapping).forEach(([csvCol, targetField]) => {
        if (targetField) {
          mapping[csvCol] = targetField;
        }
      });

      // 调用后端导入命令
      const result = await invoke<CsvImportResult>('import_questions_csv', {
        request: {
          file_path: selectedFile,
          exam_id: examId,
          field_mapping: mapping,
          duplicate_strategy: duplicateStrategy,
          folder_id: folderId,
          exam_name: examName,
        },
      });

      setImportResult(result);
      setImportProgress({
        current: result.total_rows,
        total: result.total_rows,
        success: result.success_count,
        skipped: result.skipped_count,
        failed: result.failed_count,
      });

      // 回调通知
      onImportComplete?.(result);

      showGlobalNotification(
        result.failed_count > 0 ? 'warning' : 'success',
        t('exam_sheet:csv.import_complete', '导入完成：成功 {{success}} 条，跳过 {{skipped}} 条，失败 {{failed}} 条', {
          success: result.success_count,
          skipped: result.skipped_count,
          failed: result.failed_count,
        })
      );
    } catch (error: unknown) {
      console.error('[CsvImport] 导入失败:', error);
      setImportError(String(error));
      showGlobalNotification('error', t('exam_sheet:csv.import_failed', '导入失败：{{error}}', {
        error: String(error),
      }));
    } finally {
      setIsImporting(false);
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    }
  }, [selectedFile, preview, isMappingValid, fieldMapping, duplicateStrategy, examId, examName, folderId, onImportComplete, t]);

  // 取消导入（前端停止监听进度事件，后端任务仍会继续完成）
  const [isCancelled, setIsCancelled] = useState(false);

  const handleCancelImport = useCallback(() => {
    // 停止监听后端进度事件
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    setIsCancelled(true);
    setIsImporting(false);
    showGlobalNotification('info', t('exam_sheet:csv.import_cancelled', '已取消监听导入进度，后端任务仍会完成'));
  }, [t]);

  const handleCancel = useCallback(() => {
    if (isImporting) {
      handleCancelImport();
      return;
    }
    onOpenChange(false);
  }, [isImporting, onOpenChange, handleCancelImport]);

  // 重试
  const handleRetry = useCallback(() => {
    setImportResult(null);
    setImportError(null);
    setCurrentStep('strategy');
  }, []);

  // 下一步
  const handleNext = useCallback(() => {
    const nextIndex = stepIndex + 1;
    if (nextIndex < STEPS.length) {
      setCurrentStep(STEPS[nextIndex].key);
    }
  }, [stepIndex]);

  // 上一步
  const handlePrev = useCallback(() => {
    const prevIndex = stepIndex - 1;
    if (prevIndex >= 0) {
      setCurrentStep(STEPS[prevIndex].key);
    }
  }, [stepIndex]);

  // 渲染步骤指示器
  const renderStepIndicator = () => (
    <div className="flex items-center justify-center gap-2 mb-6">
      {STEPS.map((step, index) => {
        const isActive = index === stepIndex;
        const isCompleted = index < stepIndex;
        
        return (
          <React.Fragment key={step.key}>
            {index > 0 && (
              <div
                className={cn(
                  'w-8 h-0.5 rounded',
                  isCompleted ? 'bg-primary' : 'bg-border'
                )}
              />
            )}
            <div
              className={cn(
                'flex items-center gap-2 px-3 py-1.5 rounded-full transition-colors',
                isActive && 'bg-primary/10 text-primary font-medium',
                isCompleted && 'text-primary',
                !isActive && !isCompleted && 'text-muted-foreground'
              )}
            >
              <span
                className={cn(
                  'w-6 h-6 rounded-full flex items-center justify-center text-xs font-medium',
                  isActive && 'bg-primary text-primary-foreground',
                  isCompleted && 'bg-primary text-primary-foreground',
                  !isActive && !isCompleted && 'bg-muted text-muted-foreground'
                )}
              >
                {isCompleted ? (
                  <CheckCircle2 className="w-4 h-4" />
                ) : (
                  index + 1
                )}
              </span>
              <span className="text-sm hidden sm:inline">{t(`exam_sheet:csv.steps.${step.key}`)}</span>
            </div>
          </React.Fragment>
        );
      })}
    </div>
  );

  // 渲染文件选择步骤
  const renderSelectStep = () => (
    <div className="space-y-4">
      {/* 拖拽区域 - 使用统一的 UnifiedDragDropZone */}
      <UnifiedDragDropZone
        zoneId="csv-import"
        onFilesDropped={handleFilesDropped}
        onPathsDropped={handlePathsDropped}
        acceptedFileTypes={[CSV_FILE_TYPE]}
        maxFiles={1}
        showOverlay={true}
        customOverlayText={t('exam_sheet:csv.drop_csv_here', '松开鼠标上传 CSV 文件')}
        enabled={!isLoadingPreview}
        className="cursor-pointer"
      >
        <div
          className={cn(
            'relative border-2 border-dashed rounded-lg p-8 transition-colors',
            'flex flex-col items-center justify-center gap-4',
            'hover:border-primary/50 hover:bg-primary/5',
            'border-border'
          )}
          onClick={handleSelectFileClick}
        >
          {isLoadingPreview ? (
            <Loader2 className="w-10 h-10 text-primary animate-spin" />
          ) : (
            <>
              <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center">
                <FileSpreadsheet className="w-8 h-8 text-muted-foreground" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">
                  {t('exam_sheet:csv.drop_or_click', '拖拽 CSV 文件到此处，或点击选择')}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('exam_sheet:csv.supported_formats', '支持 UTF-8 和 GBK 编码')}
                </p>
              </div>
            </>
          )}
        </div>
      </UnifiedDragDropZone>

      {/* 错误提示 */}
      {importError && (
        <Alert variant="destructive">
          <AlertTriangle className="w-4 h-4" />
          <AlertDescription>{importError}</AlertDescription>
        </Alert>
      )}
    </div>
  );

  // 渲染字段映射步骤
  const renderMappingStep = () => (
    <div className="space-y-4">
      {preview && (
        <>
          {/* 文件信息 */}
          <div className="flex items-center gap-4 p-3 rounded-lg bg-muted/30">
            <FileSpreadsheet className="w-5 h-5 text-primary" />
            <div className="flex-1">
              <p className="text-sm font-medium">
                {selectedFile?.split(/[/\\]/).pop() || t('exam_sheet:csv.csv_file_fallback')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('exam_sheet:csv.file_info', '{{rows}} 行数据，{{cols}} 列，编码：{{encoding}}', {
                  rows: preview.total_rows,
                  cols: preview.headers.length,
                  encoding: preview.encoding,
                })}
              </p>
            </div>
          </div>

          {/* 字段映射器 */}
          <CsvFieldMapper
            headers={preview.headers}
            previewRows={preview.rows}
            fieldMapping={fieldMapping}
            onMappingChange={setFieldMapping}
            showPreview={true}
          />
        </>
      )}
    </div>
  );

  // 渲染去重策略步骤
  const renderStrategyStep = () => (
    <div className="space-y-4">
      <Label className="text-sm font-medium">
        {t('exam_sheet:csv.duplicate_strategy', '重复数据处理')}
      </Label>
      <div className="space-y-2">
        {DUPLICATE_STRATEGY_KEYS.map((strategyKey) => (
          <div
            key={strategyKey}
            className={cn(
              'flex items-start gap-3 p-4 rounded-lg border cursor-pointer transition-colors',
              duplicateStrategy === strategyKey
                ? 'border-primary bg-primary/5'
                : 'border-border hover:bg-muted/50'
            )}
            onClick={() => setDuplicateStrategy(strategyKey)}
          >
            <div
              className={cn(
                'w-4 h-4 rounded-full border-2 flex items-center justify-center mt-0.5',
                duplicateStrategy === strategyKey ? 'border-primary' : 'border-muted-foreground/50'
              )}
            >
              {duplicateStrategy === strategyKey && (
                <div className="w-2 h-2 rounded-full bg-primary" />
              )}
            </div>
            <div className="flex-1">
              <p className="text-sm font-medium">{t(`exam_sheet:csv.duplicate_${strategyKey}_title`)}</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {t(`exam_sheet:csv.duplicate_${strategyKey}_desc`)}
              </p>
            </div>
          </div>
        ))}
      </div>

      {/* 映射预览 */}
      <div className="p-4 rounded-lg bg-muted/30 space-y-2">
        <p className="text-sm font-medium">{t('exam_sheet:csv.mapping_preview', '映射配置预览')}</p>
        <div className="flex flex-wrap gap-2">
          {Object.entries(fieldMapping)
            .filter(([, target]) => target)
            .map(([csvCol, target]) => (
              <span
                key={csvCol}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-background text-xs"
              >
                <span className="font-mono text-muted-foreground">{csvCol}</span>
                <ChevronRight className="w-3 h-3 text-muted-foreground" />
                <span className="font-medium">
                  {t(`exam_sheet:export.fields.${target}`, target as string)}
                </span>
              </span>
            ))}
        </div>
      </div>
    </div>
  );

  // 渲染进度和结果步骤
  const renderProgressStep = () => (
    <div className="space-y-6">
      {/* 进度条 */}
      {isImporting && importProgress && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="text-muted-foreground">
              {t('exam_sheet:csv.importing', '正在导入...')}
            </span>
            <span className="font-medium">
              {Math.round((importProgress.current / importProgress.total) * 100)}%
            </span>
          </div>
          <Progress value={(importProgress.current / importProgress.total) * 100} />
          <div className="flex items-center justify-center gap-6 text-sm text-muted-foreground">
            <span className="flex items-center gap-1">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              {importProgress.success}
            </span>
            <span className="flex items-center gap-1">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              {importProgress.skipped}
            </span>
            <span className="flex items-center gap-1">
              <XCircle className="w-4 h-4 text-rose-500" />
              {importProgress.failed}
            </span>
          </div>
          {/* 取消按钮 */}
          <div className="flex justify-center pt-1">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={handleCancelImport}
              className="text-muted-foreground hover:text-destructive"
            >
              <XCircle className="w-4 h-4 mr-1.5" />
              {t('exam_sheet:csv.cancel_import', '取消导入')}
            </NotionButton>
          </div>
        </div>
      )}

      {/* 用户取消导入后的提示 */}
      {isCancelled && !importResult && !importError && (
        <div className="flex items-center gap-3 p-4 rounded-lg bg-amber-500/10">
          <AlertTriangle className="w-6 h-6 text-amber-500" />
          <div>
            <p className="font-medium">{t('exam_sheet:csv.import_cancelled_title', '导入已取消')}</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t('exam_sheet:csv.import_cancelled_desc', '已停止监听导入进度。后端任务可能仍在运行，已导入的数据不会回滚。')}
            </p>
          </div>
        </div>
      )}

      {/* 结果展示 */}
      {importResult && !isImporting && (
        <div className="space-y-4">
          <div className={cn(
            'flex items-center gap-3 p-4 rounded-lg',
            importResult.failed_count > 0 ? 'bg-amber-500/10' : 'bg-emerald-500/10'
          )}>
            {importResult.failed_count > 0 ? (
              <AlertTriangle className="w-6 h-6 text-amber-500" />
            ) : (
              <CheckCircle2 className="w-6 h-6 text-emerald-500" />
            )}
            <div>
              <p className="font-medium">
                {importResult.failed_count > 0
                  ? t('exam_sheet:csv.import_partial', '导入完成（部分失败）')
                  : t('exam_sheet:csv.import_success', '导入成功！')}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {t('exam_sheet:csv.import_summary', '成功 {{success}} 条，跳过 {{skipped}} 条，失败 {{failed}} 条', {
                  success: importResult.success_count,
                  skipped: importResult.skipped_count,
                  failed: importResult.failed_count,
                })}
              </p>
            </div>
          </div>

          {/* 错误详情 */}
          {importResult.errors.length > 0 && (
            <div className="space-y-2">
              <Label className="text-sm font-medium text-rose-600">
                {t('exam_sheet:csv.error_details', '错误详情（前 10 条）')}
              </Label>
              <div className="max-h-[150px] overflow-auto rounded-lg border border-rose-200 bg-rose-50 dark:border-rose-800 dark:bg-rose-950/30 p-3 space-y-2">
                {importResult.errors.slice(0, 10).map((error, index) => (
                  <div key={index} className="text-xs">
                    <span className="font-mono text-rose-600">{t('exam_sheet:csv.error_row', { row: error.row, message: '' })}</span>
                    <span className="text-rose-700 dark:text-rose-300">{error.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 错误状态 */}
      {importError && !isImporting && !importResult && (
        <Alert variant="destructive">
          <XCircle className="w-4 h-4" />
          <AlertDescription>{importError}</AlertDescription>
        </Alert>
      )}
    </div>
  );

  // 渲染当前步骤内容
  const renderStepContent = () => {
    switch (currentStep) {
      case 'select':
        return renderSelectStep();
      case 'mapping':
        return renderMappingStep();
      case 'strategy':
        return renderStrategyStep();
      case 'progress':
        return renderProgressStep();
      default:
        return null;
    }
  };

  // 渲染底部按钮
  const renderFooter = () => {
    const isFirstStep = stepIndex === 0;
    const isLastStep = stepIndex === STEPS.length - 1;
    const showResult = currentStep === 'progress' && (importResult || importError || isCancelled);

    return (
      <NotionDialogFooter>
        {/* 取消/关闭按钮 */}
        <NotionButton
          variant="outline"
          onClick={handleCancel}
          disabled={isImporting}
        >
          {showResult ? t('common:close', '关闭') : t('common:cancel', '取消')}
        </NotionButton>

        {/* 重试按钮（仅错误时显示） */}
        {importError && !isImporting && !importResult && (
          <NotionButton variant="ghost" onClick={handleRetry}>
            <RefreshCw className="w-4 h-4 mr-2" />
            {t('common:retry', '重试')}
          </NotionButton>
        )}

        {/* 上一步按钮 */}
        {!isFirstStep && !showResult && !isImporting && (
          <NotionButton variant="ghost" onClick={handlePrev}>
            <ChevronLeft className="w-4 h-4 mr-1" />
            {t('common:prev', '上一步')}
          </NotionButton>
        )}

        {/* 下一步/开始导入按钮 */}
        {!showResult && (
          <>
            {currentStep === 'strategy' ? (
              <NotionButton onClick={handleStartImport} disabled={isImporting}>
                {isImporting ? (
                  <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                ) : (
                  <Upload className="w-4 h-4 mr-2" />
                )}
                {t('exam_sheet:csv.start_import', '开始导入')}
              </NotionButton>
            ) : currentStep !== 'progress' && currentStep !== 'select' && (
              <NotionButton
                onClick={handleNext}
                disabled={currentStep === 'mapping' && !isMappingValid}
              >
                {t('common:next', '下一步')}
                <ChevronRight className="w-4 h-4 ml-1" />
              </NotionButton>
            )}
          </>
        )}
      </NotionDialogFooter>
    );
  };

  return (
    <NotionDialog open={open} onOpenChange={onOpenChange} maxWidth="max-w-2xl">
        <NotionDialogHeader>
          <NotionDialogTitle className="flex items-center gap-2">
            <FileSpreadsheet className="w-5 h-5" />
            {t('exam_sheet:csv.import_title', 'CSV 导入')}
          </NotionDialogTitle>
          <NotionDialogDescription>
            {t('exam_sheet:csv.import_description', '从 CSV 文件批量导入题目到题目集')}
          </NotionDialogDescription>
        </NotionDialogHeader>
        <NotionDialogBody nativeScroll>

        {/* 步骤指示器 */}
        {renderStepIndicator()}

        {/* 步骤内容 */}
        <div className="min-h-[300px]">{renderStepContent()}</div>

        </NotionDialogBody>
        {/* 底部按钮 */}
        {renderFooter()}
    </NotionDialog>
  );
};

export default CsvImportDialog;

/**
 * CSV 导入面板（非模态）
 * 
 * 支持 4 个步骤的导入流程：
 * 1. 文件选择（支持拖拽上传）
 * 2. 预览和字段映射
 * 3. 去重策略选择
 * 4. 导入进度和结果
 * 
 * 项目已禁用模态框：CsvImportPanel 为页面内嵌形态；CsvImportDialog 保留
 * open/onOpenChange 接口，但渲染为占满宿主容器的内联覆盖面板。
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
import { NotionButton } from '@/components/ui/NotionButton';
import { Label } from '@/components/ui/shad/Label';
import { Progress } from '@/components/ui/shad/Progress';
import { Alert, AlertDescription } from '@/components/ui/shad/Alert';
import {
  Table,
  CaretRight,
  CaretLeft,
  CircleNotch,
  CheckCircle,
  XCircle,
  Warning,
  ArrowClockwise,
  Upload,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { fileManager, extractFileName } from '@/utils/fileManager';
import { showGlobalNotification } from './UnifiedNotification';
import CsvFieldMapper, { FieldMapping } from './CsvFieldMapper';
import { UnifiedDragDropZone, type FileTypeDefinition } from './shared/UnifiedDragDropZone';
import { inferCsvFieldFromHeader } from '@/utils/csvHeaderAliases';

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
  type: 'Started' | 'Progress' | 'Completed' | 'Cancelled' | 'Failed';
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
  /** Cancelled imports retain rows completed before the cancellation was observed. */
  cancelled?: boolean;
}

interface CsvImportAttempt {
  id: string;
  session: number;
  /** `true` only after the Tauri import command has been dispatched. */
  backendStarted: boolean;
}

interface CsvImportFlowProps {
  /** 目标题目集 ID */
  examId: string;
  /** 题目集名称（用于创建新题目集） */
  examName?: string;
  /** 文件夹 ID（可选） */
  folderId?: string;
  /** 导入完成回调 */
  onImportComplete?: (result: CsvImportResult) => void;
  /** 关闭/返回：内嵌模式返回题库列表；覆盖面板模式收起面板（导入中由内部先请求取消） */
  onClose: () => void;
  /**
   * 展示形式（项目已禁用模态框，两种形式都是内联渲染）：
   * - inline  = 页面内嵌（题目集内容区整页流程）
   * - overlay = 占满宿主容器的内联覆盖面板（原 dialog 形态的替代，仅关闭文案不同）
   */
  layout?: 'overlay' | 'inline';
  /** 导入中状态上报（外层用于阻止关闭/切换视图） */
  onImportingChange?: (importing: boolean) => void;
}

export interface CsvImportDialogProps {
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

export interface CsvImportPanelProps extends Omit<CsvImportDialogProps, 'open' | 'onOpenChange'> {
  /** 返回题库列表 */
  onClose: () => void;
  /** 导入中状态上报（用于阻止视图切换） */
  onImportingChange?: (importing: boolean) => void;
}

const STEP_KEYS = ['select', 'mapping', 'strategy', 'progress'] as const;

const STEPS = STEP_KEYS.map((key) => ({ key }));

type StepKey = typeof STEPS[number]['key'];

// 去重策略选项 (titles/descriptions resolved via i18n at render time)
const DUPLICATE_STRATEGY_KEYS: DuplicateStrategy[] = ['skip', 'overwrite', 'merge'];

const isLikelyCsvPath = (candidate: string): boolean => {
  if (!candidate) return false;
  const trimmed = candidate.trim();
  if (!trimmed) return false;

  const lower = trimmed.toLowerCase();
  if (lower.endsWith('.csv')) return true;

  // Android/iOS 虚拟 URI（如 content://）常不带后缀，允许后端继续识别
  if (lower.startsWith('content://') || lower.startsWith('file://') || lower.startsWith('ph://')) {
    return true;
  }

  const extractedName = extractFileName(trimmed).toLowerCase();
  if (extractedName.endsWith('.csv')) return true;

  try {
    const parsed = new URL(trimmed);
    const hintedName =
      parsed.searchParams.get('fileName') ||
      parsed.searchParams.get('filename') ||
      parsed.searchParams.get('name') ||
      parsed.searchParams.get('displayName');
    return Boolean(hintedName && hintedName.toLowerCase().endsWith('.csv'));
  } catch {
    return false;
  }
};

const createCsvImportId = (): string => {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `csv-import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const CsvImportFlow: React.FC<CsvImportFlowProps> = ({
  examId,
  examName,
  folderId,
  onImportComplete,
  onClose,
  layout = 'overlay',
  onImportingChange,
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
  const [isCancelled, setIsCancelled] = useState(false);
  const [isCancelling, setIsCancelling] = useState(false);

  // 事件监听清理函数
  const unlistenRef = useRef<UnlistenFn | null>(null);

  // 导入会话代际守卫：对话框关闭或重置后，旧任务的回调不能污染新会话。
  const importSessionRef = useRef(0);
  const activeImportAttemptRef = useRef<CsvImportAttempt | null>(null);
  const mountedRef = useRef(true);

  // 卸载即重置：外层（模态框关闭 / 内嵌视图切换）卸载本流程组件，
  // 重新挂载时从初始 state 重新开始，无需手动 reset。
  // 卸载清理同时负责终止孤立的后端导入与释放事件监听器。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const attempt = activeImportAttemptRef.current;
      if (attempt?.backendStarted) {
        void invoke<boolean>('cancel_questions_csv_import', { importId: attempt.id })
          .catch(() => undefined);
      }
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
    };
  }, []);

  // 导入中状态上报（外层模态框阻止关闭 / 内嵌面板阻止视图切换）
  useEffect(() => {
    onImportingChange?.(isImporting);
  }, [isImporting, onImportingChange]);

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

      // 自动推断字段映射（别名表见 csvHeaderAliases，含中英常见列名）
      const autoMapping: FieldMapping = {};
      result.headers.forEach((header) => {
        const inferred = inferCsvFieldFromHeader(header);
        if (inferred) autoMapping[header] = inferred;
      });
      setFieldMapping(autoMapping);

      // 自动跳转到映射步骤
      setCurrentStep('mapping');
    } catch (error: unknown) {
      console.error('[CsvImport] preview failed:', error);
      setImportError(t('exam_sheet:csv.preview_failed', {
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
        title: t('exam_sheet:csv.select_csv_file'),
        // 移除 filters 以支持移动端
      });
      
      if (filePath) {
        if (!isLikelyCsvPath(filePath)) {
          showGlobalNotification('warning', t('exam_sheet:csv.invalid_file_type'));
          return;
        }
        await handleFileSelect(filePath);
      }
    } catch (error: unknown) {
      console.error('[CsvImport] file select failed:', error);
      showGlobalNotification('error', t('exam_sheet:csv.select_file_failed'));
    }
  }, [t, handleFileSelect]);

  // 处理拖拽上传的文件路径（通过 UnifiedDragDropZone 的 onPathsDropped）
  const handlePathsDropped = useCallback(async (paths: string[]) => {
    if (paths.length === 0) return;
    const filePath = paths[0];
    if (!isLikelyCsvPath(filePath)) {
      showGlobalNotification('warning', t('exam_sheet:csv.invalid_file_type'));
      return;
    }
    await handleFileSelect(filePath);
  }, [handleFileSelect, t]);

  // 处理拖拽上传的 File 对象（Web 环境 fallback，不使用）
  const handleFilesDropped = useCallback(() => {
    // CSV 导入需要文件路径，不使用 File 对象
    // Tauri 环境会使用 onPathsDropped
  }, []);

  // 检查映射是否有效（必须映射 content，且不允许重复目标字段）
  const isMappingValid = (() => {
    const targets = Object.values(fieldMapping).filter(Boolean);
    if (!targets.includes('content')) return false;
    return new Set(targets).size === targets.length;
  })();

  // 开始导入
  const handleStartImport = useCallback(async () => {
    if (!selectedFile || !preview || !isMappingValid) return;

    const session = importSessionRef.current;
    const attempt: CsvImportAttempt = {
      id: createCsvImportId(),
      session,
      backendStarted: false,
    };
    const isStale = () => importSessionRef.current !== attempt.session
      || !mountedRef.current
      || activeImportAttemptRef.current !== attempt;
    activeImportAttemptRef.current = attempt;

    setIsImporting(true);
    setIsCancelling(false);
    setIsCancelled(false);
    setImportError(null);
    setImportProgress({ current: 0, total: preview.total_rows, success: 0, skipped: 0, failed: 0 });
    setCurrentStep('progress');

    try {
      // 设置进度事件监听
      const unlisten = await listen<CsvImportProgressEvent>('csv_import_progress', (event) => {
        if (isStale()) return;
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
        }
      });
      if (isStale()) {
        unlisten();
        return;
      }
      unlistenRef.current = unlisten;

      // 构建字段映射（CSV 列名 -> 目标字段）
      const mapping: Record<string, string> = {};
      Object.entries(fieldMapping).forEach(([csvCol, targetField]) => {
        if (targetField) {
          mapping[csvCol] = targetField;
        }
      });

      // Mark this only immediately before dispatching IPC. Until then the
      // cancel control can safely stop this local preparation phase.
      attempt.backendStarted = true;

      // 调用后端导入命令
      const result = await invoke<CsvImportResult>('import_questions_csv', {
        request: {
          file_path: selectedFile,
          exam_id: examId,
          field_mapping: mapping,
          duplicate_strategy: duplicateStrategy,
          folder_id: folderId,
          exam_name: examName,
          import_id: attempt.id,
        },
      });

      // ★ 会话代际比对：用户已取消/重开对话框时丢弃过期结果，不污染新会话
      if (isStale()) return;

      setImportResult(result);
      const processedRows = result.cancelled
        ? result.success_count + result.skipped_count + result.failed_count
        : result.total_rows;
      setImportProgress({
        current: processedRows,
        total: result.total_rows,
        success: result.success_count,
        skipped: result.skipped_count,
        failed: result.failed_count,
      });

      if (result.cancelled) {
        setIsCancelled(true);
        if (result.success_count > 0 || result.skipped_count > 0 || result.failed_count > 0) {
          onImportComplete?.(result);
        }
        showGlobalNotification(
          'info',
          t('exam_sheet:csv.import_cancelled'),
        );
      } else {
        // 回调通知
        onImportComplete?.(result);

        showGlobalNotification(
          result.failed_count > 0 ? 'warning' : 'success',
          t('exam_sheet:csv.import_complete', {
            success: result.success_count,
            skipped: result.skipped_count,
            failed: result.failed_count,
          })
        );
      }
    } catch (error: unknown) {
      if (isStale()) return;
      console.error('[CsvImport] import failed:', error);
      setImportError(String(error));
      showGlobalNotification('error', t('exam_sheet:csv.import_failed', {
        error: String(error),
      }));
    } finally {
      // 过期会话不清监听器：此时 ref 可能已指向新会话，误清会让新会话收不到进度。
      if (!isStale()) {
        setIsImporting(false);
        setIsCancelling(false);
        if (activeImportAttemptRef.current === attempt) {
          activeImportAttemptRef.current = null;
        }
        if (unlistenRef.current) {
          unlistenRef.current();
          unlistenRef.current = null;
        }
      }
    }
  }, [selectedFile, preview, isMappingValid, fieldMapping, duplicateStrategy, examId, examName, folderId, onImportComplete, t]);

  // 请求后端取消。后端会在当前行完成后停止后续写入，并通过原 invoke 返回部分结果。
  const handleCancelImport = useCallback(async () => {
    const attempt = activeImportAttemptRef.current;
    if (!attempt || isCancelling) return;

    // `listen()` is asynchronous. If the user cancels while the listener is
    // still being established, no backend request exists yet. Invalidate this
    // attempt locally so the eventual listener callback cannot dispatch an
    // import after the UI has reported cancellation.
    if (!attempt.backendStarted) {
      importSessionRef.current += 1;
      activeImportAttemptRef.current = null;
      setIsImporting(false);
      setIsCancelling(false);
      setIsCancelled(false);
      setImportError(null);
      setImportProgress(null);
      setCurrentStep('strategy');
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      showGlobalNotification(
        'info',
        t('exam_sheet:csv.import_cancelled_before_start'),
      );
      return;
    }

    setIsCancelling(true);
    try {
      const accepted = await invoke<boolean>('cancel_questions_csv_import', {
        importId: attempt.id,
      });
      if (activeImportAttemptRef.current !== attempt || !mountedRef.current) return;
      if (!accepted) {
        setIsCancelling(false);
        showGlobalNotification(
          'warning',
          t('exam_sheet:csv.import_cancel_unavailable'),
        );
      }
    } catch (error: unknown) {
      console.error('[CsvImport] cancel request failed:', error);
      setIsCancelling(false);
      showGlobalNotification(
        'error',
        t('exam_sheet:csv.import_cancel_failed'),
      );
    }
  }, [isCancelling, t]);

  const handleCancel = useCallback(() => {
    if (isImporting) {
      void handleCancelImport();
      return;
    }
    onClose();
  }, [isImporting, onClose, handleCancelImport]);

  // 重试
  const handleRetry = useCallback(() => {
    setImportResult(null);
    setImportError(null);
    setImportProgress(null);
    setIsCancelled(false);
    setIsCancelling(false);
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
                  <CheckCircle size={16} />
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
        customOverlayText={t('exam_sheet:csv.drop_csv_here')}
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
            <CircleNotch size={40} className="text-primary animate-spin" />
          ) : (
            <>
              <div className="w-16 h-16 rounded-full bg-muted/50 flex items-center justify-center">
                <Table size={32} className="text-muted-foreground" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">
                  {t('exam_sheet:csv.drop_or_click')}
                </p>
                <p className="text-xs text-muted-foreground mt-1">
                  {t('exam_sheet:csv.supported_formats')}
                </p>
              </div>
            </>
          )}
        </div>
      </UnifiedDragDropZone>

      {/* 格式说明：示例列名需与 csvHeaderAliases 别名表保持一致（自动映射依据） */}
      <div className="rounded-md bg-muted/30 px-3 py-2 space-y-1">
        <p className="text-xs text-muted-foreground">{t('exam_sheet:csv.format_hint')}</p>
        <p className="font-mono text-xs text-foreground/80">{t('exam_sheet:csv.format_example')}</p>
      </div>

      {/* 错误提示 */}
      {importError && (
        <Alert variant="destructive">
          <Warning size={16} />
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
            <Table size={20} className="text-primary" />
            <div className="flex-1">
              <p className="text-sm font-medium">
                {selectedFile ? extractFileName(selectedFile) : t('exam_sheet:csv.csv_file_fallback')}
              </p>
              <p className="text-xs text-muted-foreground">
                {t('exam_sheet:csv.file_info', {
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
        {t('exam_sheet:csv.duplicate_strategy')}
      </Label>
      <div className="space-y-2">
        {DUPLICATE_STRATEGY_KEYS.map((strategyKey) => (
          <div
            key={strategyKey}
            className={cn(
              'flex items-start gap-3 p-4 rounded-lg border cursor-pointer transition-colors bg-transparent',
              duplicateStrategy === strategyKey
                ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                : 'border-border/60 hover:bg-[var(--interactive-hover)]'
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
        <p className="text-sm font-medium">{t('exam_sheet:csv.mapping_preview')}</p>
        <div className="flex flex-wrap gap-2">
          {Object.entries(fieldMapping)
            .filter(([, target]) => target)
            .map(([csvCol, target]) => (
              <span
                key={csvCol}
                className="inline-flex items-center gap-1 px-2 py-1 rounded bg-background text-xs"
              >
                <span className="font-mono text-muted-foreground">{csvCol}</span>
                <CaretRight size={12} className="text-muted-foreground" />
                <span className="font-medium">
                  {/* Bug 修复：原 key `exam_sheet:export.fields.*` 不存在（实际在 questionBank 下），导致显示英文原始字段名 */}
                  {t(`exam_sheet:questionBank.export.fields.${target}`, target as string)}
                </span>
              </span>
            ))}
        </div>
      </div>
    </div>
  );

  // 渲染进度和结果步骤
  const renderProgressStep = () => {
    const progressPercent = importProgress && importProgress.total > 0
      ? Math.round((importProgress.current / importProgress.total) * 100)
      : 0;

    return (
    <div className="space-y-6">
      {/* 进度条 */}
      {isImporting && importProgress && (
        <div className="space-y-3">
          <div className="flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-muted-foreground">
              <CircleNotch size={14} className="animate-spin text-primary" />
              {t('exam_sheet:csv.importing')}
              <span className="tabular-nums">
                {importProgress.current} / {importProgress.total}
              </span>
            </span>
            <span className="font-medium tabular-nums">
              {progressPercent}%
            </span>
          </div>
          <Progress value={progressPercent} />
          <div className="flex items-center justify-center gap-6 text-sm text-muted-foreground">
            <span className="flex items-center gap-1.5" title={t('exam_sheet:csv.result_success')}>
              <CheckCircle size={16} className="text-success" />
              <span className="tabular-nums">{importProgress.success}</span>
              <span className="text-xs">{t('exam_sheet:csv.result_success')}</span>
            </span>
            <span className="flex items-center gap-1.5" title={t('exam_sheet:csv.result_skipped')}>
              <Warning size={16} className="text-warning" />
              <span className="tabular-nums">{importProgress.skipped}</span>
              <span className="text-xs">{t('exam_sheet:csv.result_skipped')}</span>
            </span>
            <span className="flex items-center gap-1.5" title={t('exam_sheet:csv.result_failed')}>
              <XCircle size={16} className="text-destructive" />
              <span className="tabular-nums">{importProgress.failed}</span>
              <span className="text-xs">{t('exam_sheet:csv.result_failed')}</span>
            </span>
          </div>
          {/* 取消按钮 */}
          <div className="flex justify-center pt-1">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={() => void handleCancelImport()}
              disabled={isCancelling}
              className="text-muted-foreground hover:text-destructive"
            >
              {isCancelling ? (
                <CircleNotch size={16} className="mr-1.5 animate-spin" />
              ) : (
                <XCircle size={16} className="mr-1.5" />
              )}
              {isCancelling
                ? t('exam_sheet:csv.cancelling_import')
                : t('exam_sheet:csv.cancel_import')}
            </NotionButton>
          </div>
        </div>
      )}

      {/* 用户取消导入后的提示 */}
      {isCancelled && !importError && (
        <div className="flex items-center gap-3 rounded-md bg-warning/10 p-4">
          <Warning size={20} className="text-warning" />
          <div>
            <p className="font-medium">{t('exam_sheet:csv.import_cancelled_title')}</p>
            <p className="text-sm text-muted-foreground mt-0.5">
              {t('exam_sheet:csv.import_cancelled_desc')}
            </p>
          </div>
        </div>
      )}

      {/* 结果展示 */}
      {importResult && !isImporting && (
        <div className="space-y-4 ui-rise-in">
          <div className={cn(
            'flex items-center gap-3 rounded-md p-4',
            importResult.cancelled || importResult.failed_count > 0 ? 'bg-warning/10' : 'bg-success/10'
          )}>
            {importResult.cancelled || importResult.failed_count > 0 ? (
              <Warning size={20} className="text-warning ui-zoom-fade-in" />
            ) : (
              <CheckCircle size={20} weight="fill" className="text-success ui-zoom-fade-in" />
            )}
            <div>
              <p className="font-medium">
                {importResult.cancelled
                  ? t('exam_sheet:csv.import_cancelled_title')
                  : importResult.failed_count > 0
                  ? t('exam_sheet:csv.import_partial')
                  : t('exam_sheet:csv.import_success')}
              </p>
              <p className="text-sm text-muted-foreground mt-0.5">
                {t('exam_sheet:csv.import_summary', {
                  success: importResult.success_count,
                  skipped: importResult.skipped_count,
                  failed: importResult.failed_count,
                })}
              </p>
            </div>
          </div>

          {/* 结果摘要计数 */}
          <div className="grid grid-cols-3 gap-2">
            <div className="rounded-md bg-success/10 p-3 text-center">
              <div className="text-lg font-semibold tabular-nums text-success">{importResult.success_count}</div>
              <div className="text-xs text-muted-foreground">{t('exam_sheet:csv.result_success')}</div>
            </div>
            <div className="rounded-md bg-warning/10 p-3 text-center">
              <div className="text-lg font-semibold tabular-nums text-warning">{importResult.skipped_count}</div>
              <div className="text-xs text-muted-foreground">{t('exam_sheet:csv.result_skipped')}</div>
            </div>
            <div className="rounded-md bg-destructive/10 p-3 text-center">
              <div className="text-lg font-semibold tabular-nums text-destructive">{importResult.failed_count}</div>
              <div className="text-xs text-muted-foreground">{t('exam_sheet:csv.result_failed')}</div>
            </div>
          </div>

          {/* 错误详情：行号标红 + 原因 + 原始数据摘要 */}
          {importResult.errors.length > 0 && (
            <div className="space-y-2">
              <Label className="text-sm font-medium text-destructive">
                {t('exam_sheet:csv.error_details_count', { count: importResult.errors.length })}
              </Label>
              <div className="max-h-[200px] overflow-auto rounded-md border border-destructive/30 divide-y divide-destructive/10">
                {importResult.errors.slice(0, 50).map((error, index) => (
                  <div key={index} className="flex items-start gap-2 bg-destructive/5 px-3 py-2 text-xs">
                    <span className="flex-shrink-0 rounded bg-destructive/15 px-1.5 py-0.5 font-mono font-medium text-destructive">
                      {t('exam_sheet:csv.error_row_label', { row: error.row })}
                    </span>
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="text-destructive">{error.message}</div>
                      {error.raw_data && (
                        <div className="truncate font-mono text-muted-foreground" title={error.raw_data}>
                          {error.raw_data}
                        </div>
                      )}
                    </div>
                  </div>
                ))}
                {importResult.errors.length > 50 && (
                  <div className="bg-destructive/5 px-3 py-2 text-xs text-muted-foreground">
                    {t('exam_sheet:csv.error_more', { count: importResult.errors.length - 50 })}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 错误状态 */}
      {importError && !isImporting && !importResult && (
        <Alert variant="destructive">
          <XCircle size={16} />
          <AlertDescription>{importError}</AlertDescription>
        </Alert>
      )}
    </div>
    );
  };

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
    const showResult = currentStep === 'progress' && (importResult || importError || isCancelled);
    const canRetry = !isImporting && (Boolean(importError && !importResult) || Boolean(importResult?.cancelled));

    const footerContent = (
      <>
        {/* 取消/关闭/返回按钮 */}
        <NotionButton
          variant="outline"
          onClick={handleCancel}
          disabled={isCancelling}
        >
          {isImporting
            ? (isCancelling
              ? t('exam_sheet:csv.cancelling_import')
              : t('exam_sheet:csv.cancel_import'))
            : showResult
              ? t('common:close')
              : layout === 'inline'
                ? t('common:actions.back')
                : t('common:cancel')}
        </NotionButton>


        {/* 重试按钮（错误或已取消时显示） */}
        {canRetry && (
          <NotionButton variant="ghost" onClick={handleRetry}>
            <ArrowClockwise size={16} className="mr-2" />
            {t('common:retry')}
          </NotionButton>
        )}

        {/* 上一步按钮 */}
        {!isFirstStep && !showResult && !isImporting && (
          <NotionButton variant="ghost" onClick={handlePrev}>
            <CaretLeft size={16} className="mr-1" />
            {t('common:prev')}
          </NotionButton>
        )}

        {/* 下一步/开始导入按钮 */}
        {!showResult && (
          <>
            {currentStep === 'strategy' ? (
              <NotionButton onClick={handleStartImport} disabled={isImporting}>
                {isImporting ? (
                  <CircleNotch size={16} className="mr-2 animate-spin" />
                ) : (
                  <Upload size={16} className="mr-2" />
                )}
                {t('exam_sheet:csv.start_import')}
              </NotionButton>
            ) : currentStep !== 'progress' && currentStep !== 'select' && (
              <NotionButton
                onClick={handleNext}
                disabled={currentStep === 'mapping' && !isMappingValid}
              >
                {t('common:next')}
                <CaretRight size={16} className="ml-1" />
              </NotionButton>
            )}
          </>
        )}
      </>
    );

    // 项目禁用模态框：inline 与 overlay 统一使用页内页脚样式
    return (
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border/40 pt-4">
        {footerContent}
      </div>
    );
  };

  const header = (
    <div className="mb-6 space-y-1.5 text-center">
      <h2 className="flex items-center justify-center gap-2 text-lg font-semibold">
        <Table size={20} />
        {t('exam_sheet:csv.import_title')}
      </h2>
      <p className="text-sm text-muted-foreground">{t('exam_sheet:csv.import_description')}</p>
    </div>
  );

  const body = (
    <>
      {/* 步骤指示器 */}
      {renderStepIndicator()}

      {/* 步骤内容：key 触发步骤切换的滑动过渡动画 */}
      <div key={currentStep} className="ui-slide-fade-in [--ui-enter-x:24px]">
        {renderStepContent()}
      </div>
    </>
  );

  // 整页内容（外层面板提供滚动与居中）
  return (
    <div className="w-full">
      {header}
      {body}
      {renderFooter()}
    </div>
  );
};

/** CSV 导入内嵌面板：在题目集内容区直接渲染完整导入流程（非模态） */
export const CsvImportPanel: React.FC<CsvImportPanelProps> = ({ onImportingChange, ...rest }) => (
  <div className="flex h-full flex-col bg-background">
    <div className="flex-1 overflow-y-auto p-4 flex flex-col">
      <div className="my-auto w-full max-w-2xl mx-auto py-4">
        <CsvImportFlow {...rest} layout="inline" onImportingChange={onImportingChange} />
      </div>
    </div>
  </div>
);

/**
 * CSV 导入面板（原模态对话框形态）。
 *
 * 项目已禁用模态框：`open` / `onOpenChange` 的对外接口保持不变，但内部渲染为
 * 占满宿主容器的内联覆盖面板（absolute inset-0，无遮罩、无居中弹窗）。
 * 宿主容器需为定位上下文（relative）。
 */
export const CsvImportDialog: React.FC<CsvImportDialogProps> = ({
  open,
  onOpenChange,
  examId,
  examName,
  folderId,
  onImportComplete,
}) => {
  const { t } = useTranslation(['exam_sheet', 'common']);
  const [isImporting, setIsImporting] = useState(false);

  // 导入中阻止关闭（与内嵌面板导入中阻止视图切换的行为一致）
  const handleClose = useCallback(() => {
    if (isImporting) {
      showGlobalNotification('warning', t('exam_sheet:csv.import_in_progress_close_blocked'));
      return;
    }
    onOpenChange(false);
  }, [isImporting, onOpenChange, t]);

  // 仅在打开时挂载流程：关闭即卸载，天然重置状态并清理后端任务/监听器
  if (!open) return null;

  return (
    <div
      className="absolute inset-0 z-30 flex flex-col bg-background ui-rise-in"
      role="region"
      aria-label={t('exam_sheet:csv.import_title')}
    >
      <div className="flex-1 overflow-y-auto p-4 flex flex-col">
        <div className="my-auto w-full max-w-2xl mx-auto py-4">
          <CsvImportFlow
            examId={examId}
            examName={examName}
            folderId={folderId}
            onImportComplete={onImportComplete}
            onClose={handleClose}
            layout="overlay"
            onImportingChange={setIsImporting}
          />
        </div>
      </div>
    </div>
  );
};

export default CsvImportDialog;

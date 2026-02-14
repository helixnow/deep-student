/**
 * OCR 引擎对比测试面板
 *
 * 用于对比不同 OCR 引擎的速度和质量
 */

import React, { useState, useCallback, useRef, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { 
  Play, 
  Loader2, 
  Clock, 
  CheckCircle2, 
  XCircle, 
  Image as ImageIcon,
  FileText,
  MapPin,
  X,
  Upload,
} from 'lucide-react';
import { NotionButton } from '../ui/NotionButton';
import { showGlobalNotification } from '../UnifiedNotification';
import { invoke } from '@tauri-apps/api/core';
import { UnifiedDragDropZone, FILE_TYPES } from '../shared/UnifiedDragDropZone';

/** OCR 测试区域 */
interface OcrTestRegion {
  text: string;
  bbox: [number, number, number, number] | null;
  label: string | null;
}

/** OCR 测试响应 */
interface OcrTestResponse {
  engineType: string;
  engineName: string;
  text: string;
  regions: OcrTestRegion[];
  elapsedMs: number;
  success: boolean;
  error: string | null;
}

/** 已配置的 OCR 模型 */
interface AvailableOcrModel {
  configId: string;
  model: string;
  engineType: string;
  name: string;
  isFree: boolean;
  description?: string;
  supportsGrounding: boolean;
  enabled: boolean;
}

interface OcrEngineTestPanelProps {
  availableModels: AvailableOcrModel[];
  onClose?: () => void;
}

export const OcrEngineTestPanel: React.FC<OcrEngineTestPanelProps> = ({
  availableModels,
  onClose,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const clickInputRef = useRef<HTMLInputElement>(null);
  const maxImageSize = 10 * 1024 * 1024;
  // 测试所有已配置的引擎（不按 engineType 去重，支持同类型多引擎对比）
  const engineModels = availableModels;
  
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [imagePreview, setImagePreview] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [results, setResults] = useState<OcrTestResponse[]>([]);

  // M9 fix: 处理 UnifiedDragDropZone 的文件上传
  const handleFilesDropped = useCallback((files: File[]) => {
    const file = files[0];
    if (!file) return;
    const ext = file.name.split('.').pop()?.toLowerCase();
    const hasValidExt = !!ext && FILE_TYPES.IMAGE.extensions.includes(ext);
    const hasValidMime = !!file.type && FILE_TYPES.IMAGE.mimeTypes.includes(file.type);
    if (!hasValidExt && !hasValidMime) {
      showGlobalNotification('warning', t('settings:ocr.select_image_warning'));
      return;
    }

    if (file.size > maxImageSize) {
      showGlobalNotification('warning', t('settings:ocr.image_too_large'));
      return;
    }

    // 读取文件为 base64
    const reader = new FileReader();
    reader.onload = (e) => {
      const base64 = e.target?.result as string;
      setSelectedImage(base64);
      setImagePreview(base64);
      setResults([]); // 清空之前的结果
    };
    reader.readAsDataURL(file);
  }, [maxImageSize, t]);

  // 执行对比测试
  const handleRunTest = useCallback(async () => {
    if (!selectedImage) {
      showGlobalNotification('warning', t('settings:ocr.select_image_first'));
      return;
    }

    if (engineModels.length === 0) {
      showGlobalNotification('warning', t('settings:ocr.no_available_engines'));
      return;
    }

    setTesting(true);
    setResults([]);

    try {
      // M8 fix: 并行测试所有引擎，提升速度
      const promises = engineModels.map(async (model): Promise<OcrTestResponse> => {
        try {
          return await invoke<OcrTestResponse>('test_ocr_engine', {
            request: {
              imageBase64: selectedImage,
              engineType: model.engineType,
              configId: model.configId,
            },
          });
        } catch (error: unknown) {
          return {
            engineType: model.engineType,
            engineName: model.name,
            text: '',
            regions: [],
            elapsedMs: 0,
            success: false,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      });

      const testResults = await Promise.all(promises);
      setResults(testResults);

      showGlobalNotification('success', t('settings:ocr.test_complete', { count: testResults.length }));
    } catch (error: unknown) {
      console.error('OCR 测试失败:', error);
      showGlobalNotification('error', `${t('settings:ocr.error')}: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTesting(false);
    }
  }, [selectedImage, engineModels, t]);

  // 清除选择
  const handleClear = useCallback(() => {
    setSelectedImage(null);
    setImagePreview(null);
    setResults([]);
  }, []);

  return (
    <div className="space-y-4">
      <input
        ref={clickInputRef}
        type="file"
        accept="image/*"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFilesDropped([file]);
          e.target.value = '';
        }}
        className="hidden"
      />
      {/* 标题栏 */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-medium">{t('settings:ocr.test_title')}</h3>
        {onClose && (
          <NotionButton variant="ghost" size="sm" iconOnly onClick={onClose}>
            <X size={16} />
          </NotionButton>
        )}
      </div>

      {/* M9 fix: 使用 UnifiedDragDropZone 替代原生 input */}
      {imagePreview ? (
        <div className="border-2 border-dashed border-border rounded-lg p-4 space-y-3">
          <div className="relative">
            <img
              src={imagePreview}
              alt={t('settings:ocr.test_image')}
              className="max-h-48 mx-auto rounded-lg shadow-sm"
            />
            <button
              onClick={handleClear}
              className="absolute top-2 right-2 p-1 bg-black/50 rounded-full text-white hover:bg-black/70 transition-colors"
            >
              <X size={14} />
            </button>
          </div>
          <div className="flex justify-center gap-2">
            <NotionButton
              variant="default"
              size="sm"
              onClick={() => clickInputRef.current?.click()}
            >
              <ImageIcon size={14} />
              {t('settings:ocr.change_image')}
            </NotionButton>
            <NotionButton
              onClick={handleRunTest}
              disabled={testing || engineModels.length === 0}
              size="sm"
              variant="primary"
            >
              {testing ? (
                <>
                  <Loader2 size={14} className="animate-spin" />
                  {t('settings:ocr.testing')}
                </>
              ) : (
                <>
                  <Play size={14} />
                  {t('settings:ocr.start_test')} ({engineModels.length} {t('settings:ocr.engines_count')})
                </>
              )}
            </NotionButton>
          </div>
        </div>
      ) : (
        <UnifiedDragDropZone
          zoneId="ocr-test-upload"
          onFilesDropped={handleFilesDropped}
          acceptedFileTypes={[FILE_TYPES.IMAGE]}
          maxFiles={1}
          maxFileSize={maxImageSize}
          className="rounded-lg"
        >
          <div
            className="flex flex-col items-center justify-center py-8 cursor-pointer"
            onClick={() => clickInputRef.current?.click()}
          >
            <Upload size={32} className="text-muted-foreground mb-2" />
            <p className="text-sm text-muted-foreground">{t('settings:ocr.upload_hint')}</p>
            <p className="text-xs text-muted-foreground/70 mt-1">{t('settings:ocr.upload_formats')}</p>
          </div>
        </UnifiedDragDropZone>
      )}

      {/* 测试结果 */}
      {results.length > 0 && (
        <div className="space-y-3">
          <h4 className="text-sm font-medium flex items-center gap-2">
            <FileText size={14} />
            {t('settings:ocr.test_results')}
          </h4>
          
          <div className="grid gap-3">
            {results.map((result, index) => (
              <div
                key={`${result.engineType}-${index}`}
                className={`
                  border rounded-lg p-3
                  ${result.success ? 'border-border' : 'border-red-300 bg-red-50 dark:bg-red-900/10'}
                `}
              >
                {/* 引擎信息头 */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    {result.success ? (
                      <CheckCircle2 size={16} className="text-green-500" />
                    ) : (
                      <XCircle size={16} className="text-red-500" />
                    )}
                    <span className="font-medium text-sm">{result.engineName}</span>
                    {!engineModels[index]?.enabled && (
                      <span className="text-xs px-1.5 py-0.5 bg-muted text-muted-foreground rounded">
                        {t('settings:ocr.disabled')}
                      </span>
                    )}
                    {engineModels[index]?.isFree && (
                      <span className="text-xs px-1.5 py-0.5 bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400 rounded">
                        {t('settings:ocr.free')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <Clock size={12} />
                    <span>{result.elapsedMs} ms</span>
                  </div>
                </div>

                {result.success ? (
                  <>
                    {/* 识别统计 */}
                    <div className="flex items-center gap-4 text-xs text-muted-foreground mb-2">
                      <span className="flex items-center gap-1">
                        <FileText size={12} />
                        {result.text.length} {t('settings:ocr.chars')}
                      </span>
                      <span className="flex items-center gap-1">
                        <MapPin size={12} />
                        {result.regions.filter(r => r.bbox).length} {t('settings:ocr.coord_regions')}
                      </span>
                    </div>
                    
                    {/* 识别文本预览 */}
                    <div className="bg-muted/50 rounded p-2 max-h-32 overflow-y-auto">
                      <pre className="text-xs whitespace-pre-wrap font-mono">
                        {result.text.slice(0, 500)}
                        {result.text.length > 500 && '...'}
                      </pre>
                    </div>

                    {/* 区域详情（可折叠） */}
                    {result.regions.length > 0 && result.regions.some(r => r.bbox) && (
                      <details className="mt-2">
                        <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                          {t('settings:ocr.view_regions')} {result.regions.filter(r => r.bbox).length} {t('settings:ocr.regions_count')}
                        </summary>
                        <div className="mt-2 space-y-1 max-h-40 overflow-y-auto">
                          {result.regions.filter(r => r.bbox).map((region, idx) => (
                            <div key={idx} className="text-xs bg-muted/30 rounded px-2 py-1">
                              <span className="text-muted-foreground">
                                [{region.bbox?.map(n => n.toFixed(3)).join(', ')}]
                              </span>
                              <span className="ml-2">{region.text.slice(0, 50)}{region.text.length > 50 ? '...' : ''}</span>
                            </div>
                          ))}
                        </div>
                      </details>
                    )}
                  </>
                ) : (
                  <div className="text-sm text-red-600 dark:text-red-400">
                    {t('settings:ocr.error')}: {result.error}
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* 对比总结 */}
          {results.length >= 2 && results.every(r => r.success) && (
            <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-3">
              <h5 className="text-sm font-medium text-blue-700 dark:text-blue-400 mb-2">
                {t('settings:ocr.comparison_summary')}
              </h5>
              <div className="text-xs text-blue-600 dark:text-blue-300 space-y-1">
                <p>
                  ⏱ {t('settings:ocr.fastest_engine')}: {results.reduce((a, b) => a.elapsedMs < b.elapsedMs ? a : b).engineName} 
                  ({Math.min(...results.map(r => r.elapsedMs))} ms)
                </p>
                <p>
                  📝 {t('settings:ocr.most_text')}: {results.reduce((a, b) => a.text.length > b.text.length ? a : b).engineName}
                  ({Math.max(...results.map(r => r.text.length))} {t('settings:ocr.chars')})
                </p>
                <p>
                  📍 {t('settings:ocr.most_coords')}: {results.reduce((a, b) => 
                    a.regions.filter(r => r.bbox).length > b.regions.filter(r => r.bbox).length ? a : b
                  ).engineName}
                  ({Math.max(...results.map(r => r.regions.filter(rr => rr.bbox).length))} {t('settings:ocr.regions')})
                </p>
              </div>
            </div>
          )}
        </div>
      )}

      {/* 无可用引擎提示 */}
      {engineModels.length === 0 && (
        <div className="text-center py-4 text-muted-foreground text-sm">
          <p>{t('settings:ocr.no_engines')}</p>
          <p className="text-xs mt-1">{t('settings:ocr.configure_hint')}</p>
        </div>
      )}
    </div>
  );
};

export default OcrEngineTestPanel;

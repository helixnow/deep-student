/**
 * OCR 引擎配置区域
 * Notion 风格：简洁、无边框、hover 效果
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '../ui/NotionButton';
import { showGlobalNotification } from '../UnifiedNotification';
import { invoke } from '@tauri-apps/api/core';
import { OcrEngineTestPanel } from './OcrEngineTestPanel';
import { cn } from '@/lib/utils';
import { SiliconFlowLogo } from '../ui/SiliconFlowLogo';

interface AvailableOcrModel {
  configId: string;
  model: string;
  engineType: string;
  name: string;
  isFree: boolean;
  description?: string;
  supportsGrounding: boolean;
}

interface OcrEngineInfo {
  engineType: string;
  name: string;
  description: string;
  recommendedModel: string;
  supportsGrounding: boolean;
  isFree: boolean;
}

interface OcrEngineCardProps {
  className?: string;
}

export const OcrEngineCard: React.FC<OcrEngineCardProps> = ({ className }) => {
  const { t } = useTranslation(['settings', 'common']);
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [currentEngineType, setCurrentEngineType] = useState<string>('deepseek_ocr');
  const [availableModels, setAvailableModels] = useState<AvailableOcrModel[]>([]);
  const [builtinEngines, setBuiltinEngines] = useState<OcrEngineInfo[]>([]);
  const [showTestPanel, setShowTestPanel] = useState(false);
  const engineModels = useMemo(() => {
    const seen = new Set<string>();
    return availableModels.filter((model) => {
      if (seen.has(model.engineType)) return false;
      seen.add(model.engineType);
      return true;
    });
  }, [availableModels]);

  const loadAvailableModels = useCallback(async () => {
    try {
      const result = await invoke<AvailableOcrModel[]>('get_available_ocr_models');
      setAvailableModels(result);
    } catch (error: unknown) {
      console.error('加载已配置 OCR 模型失败:', error);
    }
  }, []);

  const loadBuiltinEngines = useCallback(async () => {
    try {
      const result = await invoke<OcrEngineInfo[]>('get_ocr_engines');
      setBuiltinEngines(result);
    } catch (error: unknown) {
      console.error('加载内置 OCR 引擎失败:', error);
    }
  }, []);

  const loadCurrentEngine = useCallback(async () => {
    try {
      const engineType = await invoke<string>('get_ocr_engine_type');
      setCurrentEngineType(engineType);
    } catch (error: unknown) {
      console.error('加载当前 OCR 引擎类型失败:', error);
    }
  }, []);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([
        loadAvailableModels(),
        loadBuiltinEngines(),
        loadCurrentEngine(),
      ]);
      setLoading(false);
    };
    load();
  }, [loadAvailableModels, loadBuiltinEngines, loadCurrentEngine]);

  const handleEngineChange = useCallback(async (engineType: string) => {
    try {
      setSaving(true);
      await invoke('set_ocr_engine_type', { engineType });
      setCurrentEngineType(engineType);
      showGlobalNotification('success', t('settings:ocr.engine_switched'));
    } catch (error: unknown) {
      console.error('切换 OCR 引擎失败:', error);
      showGlobalNotification('error', `${t('settings:ocr.switch_failed')}: ${String(error)}`);
    } finally {
      setSaving(false);
    }
  }, [t]);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    await Promise.all([
      loadAvailableModels(),
      loadCurrentEngine(),
    ]);
    setLoading(false);
    showGlobalNotification('success', t('settings:ocr.refreshed'));
  }, [loadAvailableModels, loadCurrentEngine, t]);

  const renderEngineOption = (
    engineType: string,
    name: string,
    description: string,
    isFree: boolean,
    supportsGrounding: boolean,
    isConfigured: boolean
  ) => {
    const isSelected = currentEngineType === engineType;
    
    return (
      <button
        key={engineType}
        onClick={() => !saving && handleEngineChange(engineType)}
        className={cn(
          "w-full group flex items-start gap-2.5 py-2 px-1.5 rounded text-left transition-all duration-200",
          isSelected 
            ? "bg-muted/40" 
            : "hover:bg-muted/30",
          saving && "opacity-50 cursor-not-allowed"
        )}
      >
        <div className={cn(
          "mt-0.5 flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-full border transition-colors",
          isSelected 
            ? "border-primary bg-primary" 
            : "border-muted-foreground/30 group-hover:border-primary/50"
        )}>
          {isSelected && <span className="w-1 h-1 rounded-full bg-primary-foreground" />}
        </div>

        <div className="flex-1 min-w-0 space-y-0.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            <span className={cn(
              "text-sm",
              isSelected ? "text-foreground" : "text-foreground/80"
            )}>
              {name}
            </span>
            
            {isFree && (
              <span className="text-[10px] text-green-600/80 dark:text-green-400/80">
                {t('settings:ocr.free')}
              </span>
            )}
            
            {supportsGrounding && (
              <span className="text-[10px] text-blue-600/80 dark:text-blue-400/80">
                {t('settings:ocr.coordinate_positioning')}
              </span>
            )}
            
            {isConfigured && (
              <span className="text-[10px] text-purple-600/80 dark:text-purple-400/80">
                {t('settings:ocr.configured')}
              </span>
            )}
          </div>
          
          <p className="text-[11px] text-muted-foreground/60 leading-relaxed line-clamp-1">
            {description}
          </p>
        </div>
      </button>
    );
  };

  return (
    <div className={cn("text-left overflow-hidden min-w-0", className)}>
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between px-1">
          <h3 className="text-base font-semibold text-foreground flex items-center gap-2">
            <SiliconFlowLogo className="h-4 inline-block opacity-70" />
            {t('settings:cards.exam_sheet_ocr_title')}
          </h3>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={handleRefresh}
            disabled={loading}
            className="h-6 px-2 text-muted-foreground/60 hover:text-foreground text-xs"
            title={t('common:refresh')}
          >
            {t('common:refresh')}
          </NotionButton>
        </div>

        <p className="text-xs text-muted-foreground/70 leading-relaxed px-1">
          {t('settings:descriptions.exam_sheet_ocr_desc')}
        </p>

        <div className="space-y-px">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : (
            <>
              {engineModels.length > 0 ? (
                engineModels.map((model) =>
                  renderEngineOption(
                    model.engineType,
                    model.name,
                    model.description || `${t('settings:ocr.model_fallback_desc', { model: model.model })}`,
                    model.isFree,
                    model.supportsGrounding,
                    true
                  )
                )
              ) : (
                builtinEngines.map((engine) =>
                  renderEngineOption(
                    engine.engineType,
                    engine.name,
                    engine.description,
                    engine.isFree,
                    engine.supportsGrounding,
                    false
                  )
                )
              )}

              {engineModels.length === 0 && (
                <div className="mx-1 my-1.5 py-1.5 px-2 text-[11px] text-amber-600/80 dark:text-amber-500/80">
                  {t('settings:ocr.siliconflow_hint')}
                </div>
              )}
            </>
          )}
        </div>
        
        {engineModels.length >= 2 && !loading && (
          <div className="border-t border-border/20 pt-1.5 mt-1">
            <button
              onClick={() => setShowTestPanel(!showTestPanel)}
              className="w-full flex items-center justify-center gap-2 py-1.5 text-[11px] text-muted-foreground/60 hover:text-foreground transition-colors hover:bg-muted/20 rounded"
            >
              {showTestPanel ? t('settings:ocr.collapse_test') : t('settings:ocr.engine_comparison_test')}
            </button>
            
            {showTestPanel && (
              <div className="pt-3">
                <OcrEngineTestPanel
                  availableModels={engineModels}
                  onClose={() => setShowTestPanel(false)}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default OcrEngineCard;

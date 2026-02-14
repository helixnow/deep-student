/**
 * OCR 引擎配置区域
 *
 * 支持多引擎优先级排序 + 启用/禁用开关：
 * - 按 priority 从上到下排列，上面的优先使用
 * - 拖拽调整优先级（通过上移/下移按钮）
 * - 每个引擎可独立启用/禁用
 * - 支持将任意多模态模型添加为 OCR 引擎
 * - 引擎故障时自动熔断到下一个
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { NotionButton } from '../ui/NotionButton';
import { showGlobalNotification } from '../UnifiedNotification';
import { invoke } from '@tauri-apps/api/core';
import { OcrEngineTestPanel } from './OcrEngineTestPanel';
import { cn } from '@/lib/utils';
import { SiliconFlowLogo } from '../ui/SiliconFlowLogo';
import { UnifiedModelSelector } from '../shared/UnifiedModelSelector';
import type { ApiConfig } from '../../types';

interface AvailableOcrModel {
  configId: string;
  model: string;
  engineType: string;
  name: string;
  isFree: boolean;
  description?: string;
  supportsGrounding: boolean;
  enabled: boolean;
  priority: number;
}

interface OcrEngineInfo {
  engineType: string;
  name: string;
  description: string;
  recommendedModel: string;
  supportsGrounding: boolean;
  isFree: boolean;
}

interface UnifiedModelInfo {
  id: string;
  name: string;
  model?: string;
  isMultimodal?: boolean;
  isReasoning?: boolean;
}

interface OcrEngineCardProps {
  className?: string;
  apiConfigs: ApiConfig[];
  toUnifiedModelInfo: (apis: ApiConfig[]) => UnifiedModelInfo[];
  getAllEnabledApis: (currentId?: string) => ApiConfig[];
}

export const OcrEngineCard: React.FC<OcrEngineCardProps> = ({ className, apiConfigs, toUnifiedModelInfo, getAllEnabledApis }) => {
  const { t } = useTranslation(['settings', 'common']);
  
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [engines, setEngines] = useState<AvailableOcrModel[]>([]);
  const [builtinEngines, setBuiltinEngines] = useState<OcrEngineInfo[]>([]);
  const [showTestPanel, setShowTestPanel] = useState(false);
  const [showAddDialog, setShowAddDialog] = useState(false);

  const loadEngines = useCallback(async () => {
    try {
      const result = await invoke<AvailableOcrModel[]>('get_available_ocr_models');
      setEngines(result);
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

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      await Promise.all([loadEngines(), loadBuiltinEngines()]);
      setLoading(false);
    };
    load();
  }, [loadEngines, loadBuiltinEngines]);

  const handleToggleEnabled = useCallback(async (configId: string) => {
    const updated = engines.map((e) =>
      e.configId === configId ? { ...e, enabled: !e.enabled } : e
    );
    setEngines(updated);

    try {
      setSaving(true);
      await invoke('update_ocr_engine_priority', {
        engineList: updated.map((e) => ({ configId: e.configId, enabled: e.enabled })),
      });
    } catch (error: unknown) {
      console.error('更新 OCR 引擎状态失败:', error);
      showGlobalNotification('error', `${t('settings:ocr.switch_failed')}: ${String(error)}`);
      await loadEngines();
    } finally {
      setSaving(false);
    }
  }, [engines, loadEngines, t]);

  const handleMoveUp = useCallback(async (index: number) => {
    if (index <= 0) return;
    const updated = [...engines];
    [updated[index - 1], updated[index]] = [updated[index], updated[index - 1]];
    updated.forEach((e, i) => { e.priority = i; });
    setEngines(updated);

    try {
      setSaving(true);
      await invoke('update_ocr_engine_priority', {
        engineList: updated.map((e) => ({ configId: e.configId, enabled: e.enabled })),
      });
    } catch (error: unknown) {
      console.error('更新 OCR 引擎优先级失败:', error);
      await loadEngines();
    } finally {
      setSaving(false);
    }
  }, [engines, loadEngines]);

  const handleMoveDown = useCallback(async (index: number) => {
    if (index >= engines.length - 1) return;
    const updated = [...engines];
    [updated[index], updated[index + 1]] = [updated[index + 1], updated[index]];
    updated.forEach((e, i) => { e.priority = i; });
    setEngines(updated);

    try {
      setSaving(true);
      await invoke('update_ocr_engine_priority', {
        engineList: updated.map((e) => ({ configId: e.configId, enabled: e.enabled })),
      });
    } catch (error: unknown) {
      console.error('更新 OCR 引擎优先级失败:', error);
      await loadEngines();
    } finally {
      setSaving(false);
    }
  }, [engines, loadEngines]);

  const handleRemoveEngine = useCallback(async (configId: string) => {
    try {
      setSaving(true);
      await invoke('remove_ocr_engine', { configId });
      await loadEngines();
      showGlobalNotification('success', t('settings:ocr.engine_removed'));
    } catch (error: unknown) {
      console.error('移除 OCR 引擎失败:', error);
      showGlobalNotification('error', String(error));
    } finally {
      setSaving(false);
    }
  }, [loadEngines, t]);

  const multimodalModels = useMemo(() => {
    const allApis = getAllEnabledApis();
    const multimodal = allApis.filter(
      (c) => c.isMultimodal && !engines.some((e) => e.configId === c.id)
    );
    return toUnifiedModelInfo(multimodal);
  }, [getAllEnabledApis, toUnifiedModelInfo, engines]);

  const handleAddEngineById = useCallback(async (modelId: string) => {
    if (!modelId) return;
    const config = apiConfigs.find((c) => c.id === modelId);
    if (!config) return;
    try {
      setSaving(true);
      await invoke('add_ocr_engine', {
        configId: config.id,
        model: config.model,
        name: config.name,
      });
      await loadEngines();
      setShowAddDialog(false);
      showGlobalNotification('success', t('settings:ocr.engine_added'));
    } catch (error: unknown) {
      console.error('添加 OCR 引擎失败:', error);
      showGlobalNotification('error', String(error));
    } finally {
      setSaving(false);
    }
  }, [apiConfigs, loadEngines, t]);

  const handleRefresh = useCallback(async () => {
    setLoading(true);
    await loadEngines();
    setLoading(false);
    showGlobalNotification('success', t('settings:ocr.refreshed'));
  }, [loadEngines, t]);

  const enabledCount = engines.filter((e) => e.enabled).length;

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
          {t('settings:ocr.priority_desc')}
        </p>

        <div className="space-y-px">
          {loading ? (
            <div className="flex items-center justify-center py-6">
              <div className="w-4 h-4 border-2 border-muted-foreground/30 border-t-primary rounded-full animate-spin" />
            </div>
          ) : engines.length > 0 ? (
            engines.map((engine, index) => (
              <div
                key={engine.configId}
                className={cn(
                  "group flex items-center gap-2 py-1.5 px-1.5 rounded transition-all duration-200",
                  engine.enabled ? "hover:bg-muted/30" : "opacity-50 hover:bg-muted/20"
                )}
              >
                {/* 优先级序号 */}
                <span className="w-4 text-center text-[10px] text-muted-foreground/50 shrink-0 tabular-nums">
                  {index + 1}
                </span>

                {/* 启用/禁用开关 */}
                <button
                  onClick={() => handleToggleEnabled(engine.configId)}
                  disabled={saving}
                  className={cn(
                    "relative shrink-0 rounded-full transition-colors",
                    "w-[28px] h-[16px]",
                    engine.enabled ? "bg-primary" : "bg-muted-foreground/20"
                  )}
                  title={engine.enabled ? t('settings:ocr.click_to_disable') : t('settings:ocr.click_to_enable')}
                >
                  <span
                    className={cn(
                      "block absolute rounded-full bg-white shadow-sm transition-transform",
                      "w-[12px] h-[12px] top-[2px]",
                      engine.enabled ? "left-[14px]" : "left-[2px]"
                    )}
                  />
                </button>

                {/* 引擎信息 */}
                <div className="flex-1 min-w-0 space-y-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className={cn(
                      "text-sm truncate",
                      engine.enabled ? "text-foreground" : "text-foreground/50"
                    )}>
                      {engine.name}
                    </span>
                    
                    {engine.isFree && (
                      <span className="text-[10px] text-green-600/80 dark:text-green-400/80 shrink-0">
                        {t('settings:ocr.free')}
                      </span>
                    )}
                    
                    {engine.supportsGrounding && (
                      <span className="text-[10px] text-blue-600/80 dark:text-blue-400/80 shrink-0">
                        {t('settings:ocr.coordinate_positioning')}
                      </span>
                    )}

                    {index === 0 && engine.enabled && (
                      <span className="text-[10px] text-amber-600/80 dark:text-amber-400/80 shrink-0">
                        {t('settings:ocr.primary')}
                      </span>
                    )}
                  </div>
                  
                  <p className="text-[10px] text-muted-foreground/50 leading-relaxed line-clamp-1">
                    {engine.description || engine.model}
                  </p>
                </div>

                {/* 操作按钮 */}
                <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
                  <button
                    onClick={() => handleMoveUp(index)}
                    disabled={index === 0 || saving}
                    className="p-0.5 text-muted-foreground/40 hover:text-foreground disabled:invisible"
                    title={t('settings:ocr.move_up')}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 3L9 7H3L6 3Z" fill="currentColor"/></svg>
                  </button>
                  <button
                    onClick={() => handleMoveDown(index)}
                    disabled={index === engines.length - 1 || saving}
                    className="p-0.5 text-muted-foreground/40 hover:text-foreground disabled:invisible"
                    title={t('settings:ocr.move_down')}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M6 9L3 5H9L6 9Z" fill="currentColor"/></svg>
                  </button>
                  <button
                    onClick={() => handleRemoveEngine(engine.configId)}
                    disabled={saving}
                    className="p-0.5 text-muted-foreground/30 hover:text-red-500 transition-colors ml-0.5"
                    title={t('common:delete')}
                  >
                    <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M3 3L9 9M9 3L3 9" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
                  </button>
                </div>
              </div>
            ))
          ) : (
            <div className="mx-1 my-1.5 py-3 px-2 text-center">
              <p className="text-xs text-muted-foreground/60">{t('settings:ocr.no_engines')}</p>
              <p className="text-[11px] text-amber-600/80 dark:text-amber-500/80 mt-1">
                {t('settings:ocr.siliconflow_hint')}
              </p>
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        {!loading && (
          <div className="flex items-center justify-between px-1 pt-1 border-t border-border/20">
            <div className="flex items-center gap-2">
              <button
                onClick={() => setShowAddDialog(true)}
                className="text-[11px] text-primary/70 hover:text-primary transition-colors"
              >
                + {t('settings:ocr.add_engine')}
              </button>
              {enabledCount > 1 && (
                <span className="text-[10px] text-muted-foreground/40">
                  {t('settings:ocr.fallback_hint', { count: enabledCount })}
                </span>
              )}
            </div>

            {engines.length >= 2 && (
              <button
                onClick={() => setShowTestPanel(!showTestPanel)}
                className="text-[11px] text-muted-foreground/60 hover:text-foreground transition-colors"
              >
                {showTestPanel ? t('settings:ocr.collapse_test') : t('settings:ocr.engine_comparison_test')}
              </button>
            )}
          </div>
        )}

        {/* 添加引擎 - 使用统一模型选择器 */}
        {showAddDialog && (
          <div className="mx-1 mt-1 space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium">{t('settings:ocr.select_multimodal_model')}</span>
              <button
                onClick={() => setShowAddDialog(false)}
                className="text-muted-foreground/40 hover:text-foreground text-xs"
              >
                ✕
              </button>
            </div>
            <UnifiedModelSelector
              models={multimodalModels}
              value=""
              onChange={handleAddEngineById}
              variant="full"
              placeholder={t('settings:ocr.select_multimodal_model')}
              className="bg-transparent hover:bg-muted/20 transition-colors"
              popoverClassName="w-[280px]"
            />
            {multimodalModels.length === 0 && (
              <p className="text-[11px] text-muted-foreground/50 py-1 text-center">
                {t('settings:ocr.no_multimodal_available')}
              </p>
            )}
          </div>
        )}

        {/* 引擎对比测试 */}
        {showTestPanel && engines.length >= 2 && (
          <div className="pt-2">
            <OcrEngineTestPanel
              availableModels={engines}
              onClose={() => setShowTestPanel(false)}
            />
          </div>
        )}
      </div>
    </div>
  );
};

export default OcrEngineCard;

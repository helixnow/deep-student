/**
 * 模型分配 Tab 组件
 * 从 Settings.tsx 拆分，包含完整的模型分配功能
 * Notion 风格：简洁、无边框、hover 效果
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { SettingSection } from './SettingsCommon';
import { UnifiedModelSelector } from '../shared/UnifiedModelSelector';
import { DimensionManagement } from './DimensionManagement';
import { showGlobalNotification } from '../UnifiedNotification';
import { OcrEngineCard } from './OcrEngineCard';
import { cn } from '../../lib/utils';
import type { ApiConfig } from '../../types';

interface UnifiedModelInfo {
  id: string;
  name: string;
  vendorName?: string;
  providerType?: string;
  isMultimodal?: boolean;
  isReasoning?: boolean;
  isEmbedding?: boolean;
  isReranker?: boolean;
}

interface ModelsTabProps {
  config: {
    model2ConfigId: string;
    ankiCardModelConfigId: string;
    qbank_ai_grading_model_config_id: string;
    rerankerModelConfigId: string;
    vl_reranker_model_config_id: string;
    chat_title_model_config_id: string;
    exam_sheet_ocr_model_config_id: string;
    translation_model_config_id: string;
  };
  setConfig: React.Dispatch<React.SetStateAction<any>>;
  apiConfigs: ApiConfig[];
  toUnifiedModelInfo: (apis: ApiConfig[]) => UnifiedModelInfo[];
  getAllEnabledApis: (currentId?: string) => ApiConfig[];
  getEmbeddingApis: (currentId?: string) => ApiConfig[];
  getRerankerApis: (currentId?: string) => ApiConfig[];
  saveSingleAssignmentField: (field: string, value: string | null) => Promise<any>;
}

// 内部组件：模型分配行 - Notion 风格（无 icon，简洁）
const ModelAssignmentRow = ({
  title,
  description,
  value,
  field,
  models,
  placeholder,
  notificationKey,
  noModelsMessage,
  onSave,
  setConfig
}: {
  title: string;
  description: string;
  value: string;
  field: string;
  models: UnifiedModelInfo[];
  placeholder: string;
  notificationKey: string;
  noModelsMessage?: string;
  onSave: (field: string, value: string | null) => Promise<any>;
  setConfig: React.Dispatch<React.SetStateAction<any>>;
}) => (
  <div className="group flex flex-col sm:flex-row sm:items-start gap-2 py-2.5 px-1 hover:bg-muted/30 rounded transition-colors overflow-hidden">
    <div className="flex-1 min-w-0 pt-1.5 sm:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      <p className="text-[11px] text-muted-foreground/70 leading-relaxed mt-0.5 line-clamp-2">
        {description}
      </p>
    </div>
    
    <div className="w-full sm:w-[280px] flex-shrink-0 [&>div]:w-full [&_button]:w-full">
      <UnifiedModelSelector
        models={models}
        value={value || ''}
        onChange={async (v) => {
          try {
            const merged = await onSave(field, v || null);
            setConfig((prev: any) => ({ ...prev, [field.replace(/_([a-z])/g, (g) => g[1].toUpperCase())]: merged[field] || '' }));
            showGlobalNotification('success', notificationKey);
          } catch (error: unknown) {
          }
        }}
        variant="full"
        allowEmpty
        placeholder={placeholder}
        className="bg-transparent hover:bg-muted/20 transition-colors"
        popoverClassName="w-[280px]"
      />
      {models.length === 0 && noModelsMessage && (
        <div className="text-[11px] text-destructive/80 mt-1">
          {noModelsMessage}
        </div>
      )}
    </div>
  </div>
);

const GroupTitle = ({ title }: { title: string }) => (
  <div className="px-1 mb-3 mt-8 first:mt-0">
    <h3 className="text-base font-semibold text-foreground">{title}</h3>
  </div>
);

export const ModelsTab: React.FC<ModelsTabProps> = ({
  config,
  setConfig,
  apiConfigs,
  toUnifiedModelInfo,
  getAllEnabledApis,
  getEmbeddingApis,
  getRerankerApis,
  saveSingleAssignmentField,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const [ocrEngineConfigured, setOcrEngineConfigured] = useState(false);

  // 获取 OCR 引擎配置状态
  useEffect(() => {
    const checkOcrEngine = async () => {
      try {
        const engineType = await invoke<string>('get_ocr_engine_type');
        setOcrEngineConfigured(!!engineType);
      } catch {
        setOcrEngineConfigured(false);
      }
    };
    checkOcrEngine();
  }, []);

  const handleSave = async (field: string, value: string | null) => {
    return await saveSingleAssignmentField(field, value);
  };

  const notify = (key: string) => t(`settings:save_notifications.${key}`);

  return (
    <div className="space-y-1 pb-10 text-left animate-in fade-in duration-500" data-tour-id="model-assignment">
      <SettingSection 
        title={t('settings:sections.model_assignment_title')} 
        description={t('settings:sections.model_assignment_desc')} 
        dataTourId="model-assignment" 
        hideHeader
      >
        {/* 1. 基础核心模型 */}
        <div>
          <GroupTitle title={t('settings:groups.core_models')} />
          <div className="space-y-px">
            <ModelAssignmentRow
              title={t('settings:cards.model2_title')}
              description={t('settings:descriptions.model2_desc')}
              value={config.model2ConfigId}
              field="model2_config_id"
              models={toUnifiedModelInfo(getAllEnabledApis(config.model2ConfigId))}
              placeholder={t('settings:api.select_model')}
              notificationKey={notify('model2_saved')}
              onSave={handleSave}
              setConfig={setConfig}
            />
          </div>
        </div>

        {/* 2. 功能增强模型 */}
        <div>
          <GroupTitle title={t('settings:groups.feature_models')} />
          <div className="space-y-px">
            <ModelAssignmentRow
              title={t('settings:api.anki_card_title')}
              description={t('settings:api.anki_card_description')}
              value={config.ankiCardModelConfigId}
              field="anki_card_model_config_id"
              models={toUnifiedModelInfo(getAllEnabledApis(config.ankiCardModelConfigId))}
              placeholder={t('settings:api.select_model')}
              notificationKey={notify('model_saved')}
              onSave={handleSave}
              setConfig={setConfig}
            />
            <ModelAssignmentRow
              title={t('settings:cards.qbank_ai_grading_model_title')}
              description={t('settings:descriptions.qbank_ai_grading_desc')}
              value={config.qbank_ai_grading_model_config_id}
              field="qbank_ai_grading_model_config_id"
              models={toUnifiedModelInfo(getAllEnabledApis(config.qbank_ai_grading_model_config_id))}
              placeholder={t('settings:api.select_model')}
              notificationKey={notify('qbank_ai_grading_saved')}
              onSave={handleSave}
              setConfig={setConfig}
            />
            <ModelAssignmentRow
              title={t('settings:api_config.chat_title_model_label')}
              description={t('settings:api_config.chat_title_model_hint')}
              value={config.chat_title_model_config_id}
              field="chat_title_model_config_id"
              models={toUnifiedModelInfo(getAllEnabledApis(config.chat_title_model_config_id))}
              placeholder={t('settings:api.select_model')}
              notificationKey={notify('chat_title_saved')}
              onSave={handleSave}
              setConfig={setConfig}
            />
            <ModelAssignmentRow
              title={t('settings:cards.translation_model_title')}
              description={t('settings:descriptions.translation_desc')}
              value={config.translation_model_config_id}
              field="translation_model_config_id"
              models={toUnifiedModelInfo(getAllEnabledApis(config.translation_model_config_id))}
              placeholder={t('settings:api.select_model')}
              notificationKey={notify('translation_saved')}
              onSave={handleSave}
              setConfig={setConfig}
            />
          </div>
        </div>

        {/* 3. RAG 与知识库 */}
        <div>
          <GroupTitle title={t('settings:groups.rag_models')} />
          <div className="space-y-px">
            <ModelAssignmentRow
              title={t('settings:cards.reranker_title')}
              description={t('settings:descriptions.reranker_desc')}
              value={config.rerankerModelConfigId}
              field="reranker_model_config_id"
              models={toUnifiedModelInfo(getRerankerApis(config.rerankerModelConfigId))}
              placeholder={t('settings:placeholders.no_reranker')}
              notificationKey={notify('reranker_saved')}
              onSave={handleSave}
              setConfig={setConfig}
            />
            {/* ★ VL Reranker 模型配置 - 多模态索引已禁用，暂时隐藏。恢复 MULTIMODAL_INDEX_ENABLED = true 后取消注释即可 */}
            {/* <ModelAssignmentRow
              title={t('settings:cards.vl_reranker_title')}
              description={t('settings:descriptions.vl_reranker_desc')}
              value={config.vl_reranker_model_config_id}
              field="vl_reranker_model_config_id"
              models={toUnifiedModelInfo(getRerankerApis(config.vl_reranker_model_config_id))}
              placeholder={t('settings:placeholders.select_vl_reranker')}
              notificationKey={notify('vl_reranker_saved')}
              onSave={handleSave}
              setConfig={setConfig}
            /> */}
          </div>
          
          <div className="mt-8">
             <DimensionManagement apiConfigs={apiConfigs} getEmbeddingApis={getEmbeddingApis} />
          </div>
        </div>

        {/* 4. 其他配置 */}
        <div className="mt-8">
           <OcrEngineCard
             apiConfigs={apiConfigs}
             toUnifiedModelInfo={toUnifiedModelInfo}
             getAllEnabledApis={getAllEnabledApis}
           />
        </div>

        {/* 配置状态概览 */}
        <div className="mt-8 pt-4 border-t border-border/20">
          <h3 className="text-base font-semibold text-foreground mb-3">{t('settings:cards.config_check_title')}</h3>
          <div className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 text-sm">
            {[
              { id: config.model2ConfigId, label: t('settings:config_status.model2') },
              { id: config.ankiCardModelConfigId, label: t('settings:config_status.anki_card') },
              { id: config.qbank_ai_grading_model_config_id, label: t('settings:status_labels.qbank_ai_grading_model') },
              { id: config.rerankerModelConfigId, label: t('settings:config_status.reranker'), optional: true },
              { id: config.chat_title_model_config_id, label: t('settings:status_labels.chat_title_model') },
              { id: ocrEngineConfigured ? 'configured' : '', label: t('settings:status_labels.exam_sheet_ocr'), optional: true },
            ].map((item, idx) => (
              <div key={idx} className="flex items-center gap-1.5 py-0.5">
                <span className={cn(
                  "w-1.5 h-1.5 rounded-full flex-shrink-0",
                  item.id ? "bg-emerald-500" : item.optional ? "bg-amber-500/70" : "bg-muted-foreground/30"
                )} />
                <span className={cn("truncate text-xs", item.id ? "text-foreground/80" : "text-muted-foreground/60")}>
                  {item.label}
                </span>
              </div>
            ))}
          </div>
          
          {config.model2ConfigId && (
            <div className="mt-3 text-xs text-emerald-600/80 py-1">
              {t('settings:status_labels.basic_config_complete')}
            </div>
          )}
        </div>
      </SettingSection>
    </div>
  );
};

export default ModelsTab;

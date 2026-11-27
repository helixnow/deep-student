/**
 * 模型分配 Tab 组件
 * 从 Settings.tsx 拆分，包含完整的模型分配功能
 * 简洁风格 + 渐进披露：常显「核心学习模型」与「拍题识别与知识库检索」，
 * 低频专项槽位收起在可一键展开的「更多专项模型设置」中并展示「已配置 X/Y」徽标。
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { CaretDown, Check, Minus } from '@phosphor-icons/react';
import { SettingSection, settingsQuietInteractiveRowClassName } from './SettingsCommon';
import { GroupTitle } from './settingsTabPrimitives';
import { UnifiedModelSelector } from '@/components/shared/UnifiedModelSelector';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { DimensionManagement } from './DimensionManagement';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { OcrEngineCard } from './OcrEngineCard';
import { cn } from '@/lib/utils';
import type { ApiConfig } from '@/types';
import { isOpenCodeGoConfig } from '@/utils/opencodeGo';
import { supportsKnowledgeModelCapability } from './knowledgeModelCapabilities';
import { isVectorIndexUnavailable, useEmbeddingReadiness } from '@/features/learning-hub/embeddingReadiness';
import { VectorIndexUnavailableNotice } from '@/features/learning-hub/components/VectorIndexUnavailableNotice';

type TranslationDisplayMode = 'aligned' | 'streaming';

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
    qbank_ai_generation_model_config_id: string;
    rerankerModelConfigId: string;
    vl_reranker_model_config_id: string;
    chat_title_model_config_id: string;
    exam_sheet_ocr_model_config_id: string;
    translation_model_config_id: string;
    translation_display_mode: TranslationDisplayMode;
    memory_decision_model_config_id: string;
    voice_input_asr_model_config_id: string;
    image_generation_model_config_id: string;
    compaction_model_config_id: string;
  };
  setConfig: React.Dispatch<React.SetStateAction<any>>;
  apiConfigs: ApiConfig[];
  toUnifiedModelInfo: (apis: ApiConfig[]) => UnifiedModelInfo[];
  getAllEnabledApis: (currentId?: string) => ApiConfig[];
  getEmbeddingApis: (currentId?: string) => ApiConfig[];
  getRerankerApis: (currentId?: string) => ApiConfig[];
  getAsrApis: (currentId?: string) => ApiConfig[];
  getImageGenerationApis: (currentId?: string) => ApiConfig[];
  saveSingleAssignmentField: (field: string, value: string | null) => Promise<any>;
}

// 内部组件：设置行 - 简洁风格（无 icon，简洁）
const ModelAssignmentRow = ({
  title,
  description,
  value,
  field,
  configKey,
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
  configKey: string;
  models: UnifiedModelInfo[];
  placeholder: string;
  notificationKey: string;
  noModelsMessage?: string;
  onSave: (field: string, value: string | null) => Promise<any>;
  setConfig: React.Dispatch<React.SetStateAction<any>>;
}) => (
  // 双栏切换点与 isSmallScreen（<768）对齐，避免 640-767px 移动模式下出现桌面双栏行
  <div className={cn("group flex flex-col md:flex-row md:items-start gap-2 py-2.5 px-2 rounded-lg overflow-hidden", settingsQuietInteractiveRowClassName)}>
    <div className="flex-1 min-w-0 pt-1.5 md:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground/70 md:line-clamp-2">
        {description}
      </p>
    </div>
    
    <div className="w-full md:w-[280px] flex-shrink-0 [&>div]:w-full [&_button]:w-full flex items-center justify-end md:justify-start">
      <UnifiedModelSelector
        models={models}
        value={value || ''}
        onChange={async (v) => {
          try {
            const merged = await onSave(field, v || null);
            setConfig((prev: any) => ({ ...prev, [configKey]: merged[field] || '' }));
            showGlobalNotification('success', notificationKey);
          } catch (error: unknown) {
          }
        }}
        variant="full"
        allowEmpty
        placeholder={placeholder}
        className="w-full justify-between h-9 [@media(pointer:coarse)]:!min-h-11 bg-transparent hover:bg-[var(--interactive-hover)] transition-colors border border-border/30 hover:border-border/50"
        popoverClassName="w-[min(280px,calc(100vw-2rem))]"
      />
      {models.length === 0 && noModelsMessage && (
        <div className="text-xs text-destructive/80 mt-1">
          {noModelsMessage}
        </div>
      )}
    </div>
  </div>
);


// 内部组件：翻译显示模式行 — 复用 ModelAssignmentRow 的 padding/字号节奏
const TranslationDisplayModeRow = ({
  title,
  description,
  value,
  alignedLabel,
  streamingLabel,
  onSave,
  setConfig,
}: {
  title: string;
  description: string;
  value: TranslationDisplayMode;
  alignedLabel: string;
  streamingLabel: string;
  onSave: (field: string, value: string | null) => Promise<any>;
  setConfig: React.Dispatch<React.SetStateAction<any>>;
}) => (
  // 双栏切换点与 isSmallScreen（<768）对齐，避免 640-767px 移动模式下出现桌面双栏行
  <div className={cn("group flex flex-col md:flex-row md:items-start gap-2 py-2.5 px-2 rounded-lg overflow-hidden", settingsQuietInteractiveRowClassName)}>
    <div className="flex-1 min-w-0 pt-1.5 md:min-w-[200px]">
      <h3 className="text-sm text-foreground/90 leading-tight">{title}</h3>
      <p className="mt-0.5 break-words text-xs leading-relaxed text-muted-foreground/70 md:line-clamp-2">
        {description}
      </p>
    </div>
    <div className="w-full md:w-[280px] flex-shrink-0 flex items-center justify-end md:justify-start">
      <SegmentedControl<TranslationDisplayMode>
        ariaLabel={title}
        value={value}
        // !min-h-11：app.css .study-shell-segmented-button 的 min-height:0 会压掉基元
        // 非 important 的 coarse min-h-11，这里用 important 恢复触屏 ≥44px 命中高度
        itemClassName="[@media(pointer:coarse)]:!min-h-11"
        options={[
          { value: 'aligned', label: alignedLabel },
          { value: 'streaming', label: streamingLabel },
        ]}
        onValueChange={async (next) => {
          try {
            const merged = await onSave('translation_display_mode', next);
            const persisted = (merged?.translation_display_mode === 'streaming' ? 'streaming' : 'aligned') as TranslationDisplayMode;
            setConfig((prev: any) => ({ ...prev, translation_display_mode: persisted }));
          } catch {
            // 错误已由 saveSingleAssignmentField 通知用户，这里保持当前 UI 不变
          }
        }}
      />
    </div>
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
  getAsrApis,
  getImageGenerationApis,
  saveSingleAssignmentField,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  // OpenCode Go 建议只用于 Agent 对话（对话默认模型、会话标题、上下文压缩），但不强制：
  // 其他功能的选择器照常列出 Go 模型，只在下方提示哪些非 Agent 功能会用到 Go。
  const findApi = (id?: string | null) => (id ? apiConfigs.find((api) => api.id === id) : undefined);
  const model2IsOpenCodeGo = isOpenCodeGoConfig(findApi(config.model2ConfigId));
  // 手动指定为 Go，或未单独指定而回退到 Go 对话模型的非 Agent 功能。
  const goNonAgentFeatures = ([
    [config.ankiCardModelConfigId, t('settings:api.anki_card_title')],
    [config.qbank_ai_grading_model_config_id, t('settings:cards.qbank_ai_grading_model_title')],
    [config.qbank_ai_generation_model_config_id, t('settings:cards.qbank_ai_generation_model_title')],
    [config.translation_model_config_id, t('settings:cards.translation_model_title')],
    [config.memory_decision_model_config_id, t('settings:api_config.memory_decision_model_label')],
  ] as Array<[string | undefined, string]>)
    .filter(([id]) => (id ? isOpenCodeGoConfig(findApi(id)) : model2IsOpenCodeGo))
    .map(([, label]) => label);
  const [ocrEngineConfigured, setOcrEngineConfigured] = useState(false);
  const [specializedExpanded, setSpecializedExpanded] = useState(false);
  // 未编入向量索引的构建（mobile-slim）：嵌入维度/模型绑定没有任何效果，换成说明
  const vectorIndexUnavailable = isVectorIndexUnavailable(useEmbeddingReadiness());

  // 专项模型槽位已配置统计（8 项专项能力，不含非模型槽位 translation_display_mode）
  const specializedSlotValues = [
    config.qbank_ai_generation_model_config_id,
    config.translation_model_config_id,
    config.voice_input_asr_model_config_id,
    config.image_generation_model_config_id,
    config.memory_decision_model_config_id,
    config.compaction_model_config_id,
    config.rerankerModelConfigId,
    config.vl_reranker_model_config_id,
  ];
  const specializedConfiguredCount = specializedSlotValues.filter((val) => Boolean(val && val.trim())).length;
  const specializedTotalCount = specializedSlotValues.length;

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
    if (value && (field === 'reranker_model_config_id' || field === 'vl_reranker_model_config_id')) {
      const model = apiConfigs.find((candidate) => candidate.id === value);
      const requiredCapability = field === 'vl_reranker_model_config_id'
        ? 'vl_reranker'
        : 'text_reranker';
      if (!model || !supportsKnowledgeModelCapability(model, requiredCapability)) {
        throw new Error(`Model ${value} does not support ${requiredCapability}`);
      }
    }
    return await saveSingleAssignmentField(field, value);
  };

  const notify = (key: string) => t(`settings:save_notifications.${key}`);

  return (
    <div className="space-y-8 pb-10 text-left ui-fade-in-slow" data-tour-id="model-assignment">
      <SettingSection 
        title={t('settings:sections.model_assignment_title')} 
        description={t('settings:sections.model_assignment_desc')} 
        dataTourId="model-assignment" 
        hideHeader
      >
        {/* 1. 常显：核心学习模型（主力对话、快速辅助、闪卡制卡、错题批改） */}
        <div data-testid="core-study-models-section">
          <GroupTitle
            title={t('settings:models_tab.core_learning_title')}
            description={t('settings:models_tab.core_learning_desc')}
          />
          <div className="rounded-2xl bg-muted px-3 py-3 sm:px-4">
            <div className="space-y-px">
              <ModelAssignmentRow
                title={t('settings:cards.model2_title')}
                description={t('settings:descriptions.model2_desc')}
                value={config.model2ConfigId}
                field="model2_config_id"
                configKey="model2ConfigId"
                models={toUnifiedModelInfo(getAllEnabledApis(config.model2ConfigId))}
                placeholder={t('settings:api.select_model')}
                notificationKey={notify('model2_saved')}
                onSave={handleSave}
                setConfig={setConfig}
              />
              {(model2IsOpenCodeGo || goNonAgentFeatures.length > 0) && (
                <p className="px-2 pb-1.5 pt-1 text-xs text-muted-foreground" data-testid="opencode-go-model2-notice">
                  {goNonAgentFeatures.length > 0
                    ? t('settings:vendor_panel.opencode_go.non_agent_notice', {
                        features: goNonAgentFeatures.join(t('settings:vendor_panel.opencode_go.list_separator')),
                      })
                    : t('settings:vendor_panel.opencode_go.model2_notice')}
                </p>
              )}
              <ModelAssignmentRow
                title={t('settings:api_config.chat_title_model_label')}
                description={t('settings:api_config.chat_title_model_hint')}
                value={config.chat_title_model_config_id}
                field="chat_title_model_config_id"
                configKey="chat_title_model_config_id"
                models={toUnifiedModelInfo(getAllEnabledApis(config.chat_title_model_config_id))}
                placeholder={t('settings:api.select_model')}
                notificationKey={notify('chat_title_saved')}
                onSave={handleSave}
                setConfig={setConfig}
              />
              <ModelAssignmentRow
                title={t('settings:api.anki_card_title')}
                description={t('settings:api.anki_card_description')}
                value={config.ankiCardModelConfigId}
                field="anki_card_model_config_id"
                configKey="ankiCardModelConfigId"
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
                configKey="qbank_ai_grading_model_config_id"
                models={toUnifiedModelInfo(getAllEnabledApis(config.qbank_ai_grading_model_config_id))}
                placeholder={t('settings:api.select_model')}
                notificationKey={notify('qbank_ai_grading_saved')}
                onSave={handleSave}
                setConfig={setConfig}
              />
            </div>
          </div>
        </div>

        {/* 2. 常显：拍题识别（多模态/OCR）与知识库检索向量 */}
        <div className="mt-8 space-y-6" data-testid="core-ocr-rag-section">
          <GroupTitle
            title={t('settings:models_tab.ocr_and_rag_title')}
            description={t('settings:models_tab.ocr_and_rag_desc')}
          />
          <OcrEngineCard
            apiConfigs={apiConfigs}
            toUnifiedModelInfo={toUnifiedModelInfo}
            getAllEnabledApis={getAllEnabledApis}
          />
          <div>
            {vectorIndexUnavailable ? (
              <VectorIndexUnavailableNotice />
            ) : (
              <DimensionManagement apiConfigs={apiConfigs} getEmbeddingApis={getEmbeddingApis} />
            )}
          </div>
        </div>

        {/* 3. 渐进折叠：更多专项模型设置（含「已配置 X/Y」数量徽标） */}
        <div className="mt-8" data-testid="specialized-models-section">
          <div className="rounded-2xl bg-muted">
            <DsButton
              type="button"
              variant="ghost"
              data-testid="specialized-models-toggle"
              aria-expanded={specializedExpanded}
              aria-controls="specialized-models-panel"
              onClick={() => setSpecializedExpanded((prev) => !prev)}
              className={cn(
                '!h-auto w-full justify-between gap-3 whitespace-normal rounded-2xl !border-0 !bg-transparent px-4 py-3.5 text-left font-normal transition-colors',
                settingsQuietInteractiveRowClassName,
              )}
            >
              <div className="min-w-0 flex-1 space-y-0.5">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm font-medium text-foreground">
                    {t('settings:models_tab.specialized_title')}
                  </span>
                  <span
                    data-testid="specialized-models-badge"
                    className={cn(
                      'rounded-full px-2 py-0.5 text-xs font-medium tabular-nums',
                      specializedConfiguredCount > 0
                        ? 'bg-primary/15 text-primary'
                        : 'bg-background/70 text-muted-foreground',
                    )}
                  >
                    {t('settings:models_tab.specialized_configured_badge', {
                      configured: specializedConfiguredCount,
                      total: specializedTotalCount,
                    })}
                  </span>
                </div>
                <p className="text-xs leading-relaxed text-muted-foreground/80">
                  {t('settings:models_tab.specialized_desc')}
                </p>
              </div>
              <div className="flex flex-shrink-0 items-center gap-1.5 text-xs font-medium text-muted-foreground">
                <span>
                  {specializedExpanded
                    ? t('settings:models_tab.collapse_specialized')
                    : t('settings:models_tab.expand_specialized')}
                </span>
                <CaretDown
                  size={14}
                  className={cn(
                    'transition-transform duration-200',
                    specializedExpanded && 'rotate-180',
                  )}
                />
              </div>
            </DsButton>

            {specializedExpanded && (
              <div
                id="specialized-models-panel"
                data-testid="specialized-models-panel"
                className="border-t border-border/30 px-3 py-3 sm:px-4 space-y-px"
              >
                <ModelAssignmentRow
                  title={t('settings:cards.qbank_ai_generation_model_title')}
                  description={t('settings:descriptions.qbank_ai_generation_desc')}
                  value={config.qbank_ai_generation_model_config_id}
                  field="qbank_ai_generation_model_config_id"
                  configKey="qbank_ai_generation_model_config_id"
                  models={toUnifiedModelInfo(getAllEnabledApis(config.qbank_ai_generation_model_config_id))}
                  placeholder={t('settings:api.select_model')}
                  notificationKey={notify('qbank_ai_generation_saved')}
                  onSave={handleSave}
                  setConfig={setConfig}
                />
                <ModelAssignmentRow
                  title={t('settings:cards.translation_model_title')}
                  description={t('settings:descriptions.translation_desc')}
                  value={config.translation_model_config_id}
                  field="translation_model_config_id"
                  configKey="translation_model_config_id"
                  models={toUnifiedModelInfo(getAllEnabledApis(config.translation_model_config_id))}
                  placeholder={t('settings:api.select_model')}
                  notificationKey={notify('translation_saved')}
                  onSave={handleSave}
                  setConfig={setConfig}
                />
                <TranslationDisplayModeRow
                  title={t('settings:cards.translation_display_mode_title')}
                  description={t('settings:descriptions.translation_display_mode_desc')}
                  value={config.translation_display_mode}
                  alignedLabel={t('settings:cards.translation_display_mode_aligned')}
                  streamingLabel={t('settings:cards.translation_display_mode_streaming')}
                  onSave={handleSave}
                  setConfig={setConfig}
                />
                <ModelAssignmentRow
                  title={t('settings:cards.voice_input_asr_title')}
                  description={t('settings:descriptions.voice_input_asr_desc')}
                  value={config.voice_input_asr_model_config_id}
                  field="voice_input_asr_model_config_id"
                  configKey="voice_input_asr_model_config_id"
                  models={toUnifiedModelInfo(getAsrApis(config.voice_input_asr_model_config_id))}
                  placeholder={t('settings:placeholders.no_voice_input_asr', 'No ASR model available')}
                  notificationKey={notify('voice_input_asr_saved')}
                  noModelsMessage={t(
                    'settings:placeholders.no_voice_input_asr',
                    'No ASR model available'
                  )}
                  onSave={handleSave}
                  setConfig={setConfig}
                />
                <ModelAssignmentRow
                  title={t('settings:cards.image_generation_model_title', 'Image generation model')}
                  description={t('settings:descriptions.image_generation_desc', 'Used by the built-in image generation tool in Chat V2.')}
                  value={config.image_generation_model_config_id}
                  field="image_generation_model_config_id"
                  configKey="image_generation_model_config_id"
                  models={toUnifiedModelInfo(getImageGenerationApis(config.image_generation_model_config_id))}
                  placeholder={t('settings:placeholders.no_image_generation_model', 'No image generation model available')}
                  notificationKey={notify('image_generation_saved')}
                  noModelsMessage={t('settings:placeholders.no_image_generation_model', 'No image generation model available')}
                  onSave={handleSave}
                  setConfig={setConfig}
                />
                <ModelAssignmentRow
                  title={t('settings:api_config.memory_decision_model_label')}
                  description={t('settings:api_config.memory_decision_model_hint')}
                  value={config.memory_decision_model_config_id}
                  field="memory_decision_model_config_id"
                  configKey="memory_decision_model_config_id"
                  models={toUnifiedModelInfo(getAllEnabledApis(config.memory_decision_model_config_id))}
                  placeholder={t('settings:api.select_model')}
                  notificationKey={notify('memory_decision_saved')}
                  onSave={handleSave}
                  setConfig={setConfig}
                />
                <ModelAssignmentRow
                  title={t('settings:api_config.compaction_model_label')}
                  description={t('settings:api_config.compaction_model_hint')}
                  value={config.compaction_model_config_id}
                  field="compaction_model_config_id"
                  configKey="compaction_model_config_id"
                  models={toUnifiedModelInfo(getAllEnabledApis(config.compaction_model_config_id))}
                  placeholder={t('settings:api.select_model')}
                  notificationKey={notify('compaction_model_saved')}
                  onSave={handleSave}
                  setConfig={setConfig}
                />
                <ModelAssignmentRow
                  title={t('settings:cards.reranker_title')}
                  description={t('settings:descriptions.reranker_desc')}
                  value={config.rerankerModelConfigId}
                  field="reranker_model_config_id"
                  configKey="rerankerModelConfigId"
                  models={toUnifiedModelInfo(
                    getRerankerApis(config.rerankerModelConfigId)
                      .filter((model) => supportsKnowledgeModelCapability(model, 'text_reranker'))
                  )}
                  placeholder={t('settings:placeholders.no_reranker')}
                  notificationKey={notify('reranker_saved')}
                  onSave={handleSave}
                  setConfig={setConfig}
                />
                <ModelAssignmentRow
                  title={t('settings:cards.vl_reranker_title')}
                  description={t('settings:descriptions.vl_reranker_desc')}
                  value={config.vl_reranker_model_config_id}
                  field="vl_reranker_model_config_id"
                  configKey="vl_reranker_model_config_id"
                  models={toUnifiedModelInfo(
                    getRerankerApis(config.vl_reranker_model_config_id)
                      .filter((model) => supportsKnowledgeModelCapability(model, 'vl_reranker'))
                  )}
                  placeholder={t('settings:placeholders.select_vl_reranker')}
                  notificationKey={notify('vl_reranker_saved')}
                  onSave={handleSave}
                  setConfig={setConfig}
                />
              </div>
            )}
          </div>
        </div>

        {/* 配置状态概览 */}
        <div className="mt-8">
          <GroupTitle title={t('settings:cards.config_check_title')} />
          <div className="rounded-2xl bg-muted px-3 py-3 sm:px-4">
            <div className="grid gap-1.5 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 text-sm">
              {[
                { id: config.model2ConfigId, label: t('settings:config_status.model2') },
                { id: config.ankiCardModelConfigId, label: t('settings:config_status.anki_card') },
                { id: config.qbank_ai_grading_model_config_id, label: t('settings:status_labels.qbank_ai_grading_model') },
                { id: config.qbank_ai_generation_model_config_id, label: t('settings:status_labels.qbank_ai_generation_model'), optional: true },
                { id: config.rerankerModelConfigId, label: t('settings:config_status.reranker'), optional: true },
                { id: config.chat_title_model_config_id, label: t('settings:status_labels.chat_title_model') },
                { id: config.voice_input_asr_model_config_id, label: t('settings:status_labels.voice_input_asr_model'), optional: true },
                { id: config.image_generation_model_config_id, label: t('settings:status_labels.image_generation_model', 'Image generation'), optional: true },
                { id: ocrEngineConfigured ? 'configured' : '', label: t('settings:status_labels.exam_sheet_ocr'), optional: true },
              ].map((item, idx) => (
                <div key={idx} className="flex items-center gap-1.5 py-0.5">
                  {item.id ? (
                    <Check size={12} weight="bold" className="flex-shrink-0 text-success" aria-hidden="true" />
                  ) : (
                    <Minus size={12} className={cn("flex-shrink-0", item.optional ? "text-warning/70" : "text-muted-foreground/40")} aria-hidden="true" />
                  )}
                  <span className={cn("truncate text-xs", item.id ? "text-foreground/80" : "text-muted-foreground/60")}>
                    {item.label}
                  </span>
                </div>
              ))}
            </div>
            
            {config.model2ConfigId && (
              <div className="mt-3 text-xs text-success py-1">
                {t('settings:status_labels.basic_config_complete')}
              </div>
            )}
          </div>
        </div>
      </SettingSection>
    </div>
  );
};

export default ModelsTab;

/**
 * Model Assignment Presets Management Component
 * 模型分配预设管理组件
 */

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { FloppyDisk, Trash, CheckCircle, Gear as SettingsIcon, Lightning } from '@phosphor-icons/react';
import { ModelAssignments } from '@/types';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/shad/Card';
import { NotionButton } from '@/components/ui/NotionButton';
import { Badge } from '@/components/ui/shad/Badge';
import { Input } from '@/components/ui/shad/Input';
import { NotionDialog, NotionDialogHeader, NotionDialogTitle, NotionDialogDescription, NotionDialogBody, NotionDialogFooter } from '@/components/ui/NotionDialog';
import { TauriAPI } from '@/utils/tauriApi';

interface ModelAssignmentPreset {
  id: string;
  name: string;
  description?: string;
  assignments: ModelAssignments;
  isDefault?: boolean;
  isBuiltin?: boolean;
  createdAt: number;
  updatedAt: number;
}

interface ModelAssignmentPresetsProps {
  currentAssignments: ModelAssignments;
  onApplyPreset: (assignments: ModelAssignments) => void;
  apiConfigs: any[]; // API配置列表，用于验证
  onBuiltinPresetUpdateRef?: (updateFn: (assignments: ModelAssignments) => void) => void; // 内置预设更新函数引用回调
}

// 固定的内置预设配置 - 永远不会被修改
const BUILTIN_PRESET_CONFIG: ModelAssignments = {
  model2_config_id: null, // 对话模型
  anki_card_model_config_id: null, // Anki制卡模型
  qbank_ai_grading_model_config_id: null, // 题库AI批改/解析模型
  embedding_model_config_id: null, // RAG嵌入模型（已废弃，通过维度管理设置）
  reranker_model_config_id: null, // RAG重排序模型
  exam_sheet_ocr_model_config_id: null, // 题目集识别OCR专用模型
  chat_title_model_config_id: null, // 聊天标题生成模型
  translation_model_config_id: null, // 翻译模型
  // 多模态知识库模型（嵌入模型通过维度管理设置）
  vl_embedding_model_config_id: null, // 多模态嵌入模型（已废弃）
  vl_reranker_model_config_id: null, // 多模态重排序模型
  memory_decision_model_config_id: null, // 记忆决策模型
  voice_input_asr_model_config_id: null, // 语音输入 ASR 模型
  image_generation_model_config_id: null, // 生图模型
  translation_display_mode: null, // 聊天翻译显示模式（aligned 默认 / streaming）
}; 

const hasLocalStorage = () => typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';

export const ModelAssignmentPresets: React.FC<ModelAssignmentPresetsProps> = ({
  currentAssignments,
  onApplyPreset,
  apiConfigs,
  onBuiltinPresetUpdateRef
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const [presets, setPresets] = useState<ModelAssignmentPreset[]>([]);
  const [newPresetName, setNewPresetName] = useState('');
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [selectedPresetId, setSelectedPresetId] = useState<string | null>(null);

  // 创建或恢复内置预设的函数
  const createBuiltinPreset = (): ModelAssignmentPreset => {
    return {
      id: 'quick_assign',
      name: t('settings:model_presets.builtin_name'),
      description: t('settings:model_presets.builtin_description'),
      assignments: { ...BUILTIN_PRESET_CONFIG },
      isBuiltin: true,
      isDefault: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
  };

  // 验证配置是否为空（所有字段都为null或undefined）
  const isEmptyAssignments = (assignments: ModelAssignments): boolean => {
    return Object.values(assignments).every(value => value === null || value === undefined);
  };

  // 加载保存的预设
  useEffect(() => {
    let mounted = true;
    (async () => {
      let parsed: ModelAssignmentPreset[] = [];
      try {
        const saved = await TauriAPI.getSetting('model_assignment_presets');
        if (saved) {
          parsed = JSON.parse(saved);
        }
      } catch (error: unknown) {
        console.error('Failed to load model assignment presets:', error);
        parsed = [];
      }

      if (parsed.length === 0 && hasLocalStorage()) {
        try {
          const legacy = window.localStorage.getItem('model_assignment_presets');
          if (legacy) {
            parsed = JSON.parse(legacy);
            await TauriAPI.saveSetting('model_assignment_presets', legacy);
            try { window.localStorage.removeItem('model_assignment_presets'); } catch (storageError: unknown) { console.error('移除旧版模型预设失败:', storageError); }
          }
        } catch (storageError: unknown) {
          console.error('从 localStorage 迁移模型预设失败:', storageError);
        }
      }

      // 确保内置预设存在且配置正确
      let builtinPreset = parsed.find(p => p.id === 'quick_assign');
      let needsUpdate = false;

      if (!builtinPreset) {
        builtinPreset = createBuiltinPreset();
        parsed.unshift(builtinPreset);
        needsUpdate = true;
        console.log('🔧 创建内置预设');
      } else {
        const shouldRestore = !builtinPreset.isBuiltin ||
          isEmptyAssignments(builtinPreset.assignments) ||
          !builtinPreset.name.includes(t('settings:model_presets.builtin_name'));
        if (shouldRestore) {
          console.log('🔧 恢复内置预设配置');
          parsed = parsed.map(p =>
            p.id === 'quick_assign'
              ? { ...createBuiltinPreset(), createdAt: p.createdAt }
              : p
          );
          needsUpdate = true;
        }
      }

      parsed = parsed.map(p => ({
        ...p,
        isBuiltin: p.id === 'quick_assign'
      }));

      if (needsUpdate) {
        try {
          await TauriAPI.saveSetting('model_assignment_presets', JSON.stringify(parsed));
        } catch (error: unknown) {
          console.error('同步内置预设失败:', error);
        }
      }

      if (mounted) {
        setPresets(parsed);
        const builtIn = parsed.find(p => p.isBuiltin);
        if (builtIn) {
          setSelectedPresetId(builtIn.id);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, []);

  // 保存预设
  const savePresetsToStorage = async (updatedPresets: ModelAssignmentPreset[]) => {
    try {
      await TauriAPI.saveSetting('model_assignment_presets', JSON.stringify(updatedPresets));
      if (hasLocalStorage()) {
        try { window.localStorage.removeItem('model_assignment_presets'); } catch (error: unknown) { console.error('清除旧版模型预设失败:', error); }
      }
      setPresets(updatedPresets);
    } catch (error: unknown) {
      console.error('保存模型分配预设失败:', error);
      if (hasLocalStorage()) {
        try {
          window.localStorage.setItem('model_assignment_presets', JSON.stringify(updatedPresets));
          setPresets(updatedPresets);
          showGlobalNotification('warning', t('settings:model_presets.backend_unavailable_local_save'));
          return;
        } catch (storageError: unknown) {
          console.error('localStorage 备份模型预设失败:', storageError);
        }
      }
      showGlobalNotification('error', t('settings:model_presets.save_failed'));
    }
  };

  // 创建新预设
  const handleCreatePreset = async () => {
    if (!newPresetName.trim()) {
      showGlobalNotification('warning', t('settings:model_presets.name_required_warning'));
      return;
    }

    // 验证当前配置不为空
    if (isEmptyAssignments(currentAssignments)) {
      showGlobalNotification('warning', t('settings:model_presets.empty_assignments_warning'));
      return;
    }

    const newPreset: ModelAssignmentPreset = {
      id: Date.now().toString(),
      name: newPresetName,
      assignments: { ...currentAssignments },
      isBuiltin: false,
      isDefault: false,
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    const updatedPresets = [...presets, newPreset];
    await savePresetsToStorage(updatedPresets);
    setNewPresetName('');
    setShowCreateDialog(false);
    showGlobalNotification('success', t('settings:model_presets.preset_created', { name: newPresetName }));
  };

  // 应用预设
  const handleApplyPreset = (preset: ModelAssignmentPreset) => {
    // 🔒 内置预设永远不允许被修改！
    // 移除了危险的内置预设更新逻辑
    const validateAssignment = (configId: string | null) => {
      if (!configId) return true;
      return apiConfigs.some(config => config.id === configId);
    };

    const invalidAssignments = [];
    
    if (!validateAssignment(preset.assignments.model2_config_id)) {
      invalidAssignments.push(t('settings:model_presets.model_assignments.model2'));
    }
    if (!validateAssignment(preset.assignments.anki_card_model_config_id)) {
      invalidAssignments.push(t('settings:model_presets.model_assignments.anki_card'));
    }
    if (!validateAssignment(preset.assignments.qbank_ai_grading_model_config_id)) {
      invalidAssignments.push(t('settings:model_presets.model_assignments.qbank_ai_grading'));
    }
    // 嵌入模型通过维度管理设置，不再验证 embedding_model_config_id
    if (!validateAssignment(preset.assignments.reranker_model_config_id)) {
      invalidAssignments.push(t('settings:model_presets.model_assignments.reranker'));
    }
    if (!validateAssignment(preset.assignments.voice_input_asr_model_config_id)) {
      invalidAssignments.push(t('settings:cards.voice_input_asr_title'));
    }
    if (invalidAssignments.length > 0) {
      showGlobalNotification('warning', t('settings:model_presets.invalid_assignments', { assignments: invalidAssignments.join('、') }));
    }

    onApplyPreset(preset.assignments);
    setSelectedPresetId(preset.id);
    showGlobalNotification('success', t('settings:model_presets.preset_applied', { name: preset.name }));
  };

  // 删除预设
  const handleDeletePreset = async (presetId: string) => {
    const preset = presets.find(p => p.id === presetId);
    
    // 🔒 禁止删除内置预设
    if (preset?.isBuiltin) {
      showGlobalNotification('warning', t('settings:model_presets.builtin_cannot_delete'));
      return;
    }
    
    const updatedPresets = presets.filter(p => p.id !== presetId);
    await savePresetsToStorage(updatedPresets);
    
    if (selectedPresetId === presetId) {
      setSelectedPresetId(null);
    }
    
    // 删除成功时不显示通知
  };

  // 设置默认预设
  const handleSetDefault = async (presetId: string) => {
    const updatedPresets = presets.map(p =>
      p.isBuiltin ? p : { ...p, isDefault: p.id === presetId }
    );
    await savePresetsToStorage(updatedPresets);
    showGlobalNotification('success', t('settings:model_presets.set_default_success'));
  };

  // 🔧 专门用于一键分配功能更新内置预设的函数
  const updateBuiltinPreset = (newAssignments: ModelAssignments) => {
    const updatedPresets = presets.map(p => 
      p.id === 'quick_assign'
        ? { ...p, assignments: { ...newAssignments }, updatedAt: Date.now() }
        : p
    );
    void savePresetsToStorage(updatedPresets);
    console.log('🔧 内置预设已更新');
  };

  // 暴露内置预设更新函数给父组件
  React.useEffect(() => {
    if (onBuiltinPresetUpdateRef) {
      onBuiltinPresetUpdateRef(updateBuiltinPreset);
    }
  }, [onBuiltinPresetUpdateRef, presets]);

  // 更新现有预设
  const handleUpdatePreset = async (presetId: string) => {
    const preset = presets.find(p => p.id === presetId);
    
    // 🔒 禁止更新内置预设
    if (preset?.isBuiltin) {
      showGlobalNotification('warning', t('settings:model_presets.builtin_cannot_update'));
      return;
    }
    
    // 验证当前配置不为空
    if (isEmptyAssignments(currentAssignments)) {
      showGlobalNotification('warning', t('settings:model_presets.empty_assignments_update_warning'));
      return;
    }
    
    const updatedPresets = presets.map(p => 
      p.id === presetId
        ? { ...p, assignments: { ...currentAssignments }, updatedAt: Date.now() }
        : p
    );
    await savePresetsToStorage(updatedPresets);
    showGlobalNotification('success', t('settings:model_presets.update_success'));
  };

  return (
    <Card className="border-border/40 bg-transparent shadow-none p-4 text-left" data-tour-id="settings-model-presets">
      <CardHeader className="p-0 mb-3 w-full text-left">
        <div className="flex items-center gap-2">
          <SettingsIcon size={20} className="text-muted-foreground shrink-0" />
          <CardTitle className="text-base text-left" style={{ textAlign: 'left' }}>{t('settings:model_presets.title')}</CardTitle>
        </div>
        <NotionButton size="sm" variant="primary" className="ml-auto" onClick={() => setShowCreateDialog(true)} data-tour-id="settings-model-presets-save">
          <FloppyDisk size={14} className="shrink-0" /> {t('settings:model_presets.save_current')}
        </NotionButton>
      </CardHeader>
      <CardContent className="p-0 space-y-3">
        <CardDescription className="text-xs">
          {t('settings:model_presets.update_description')}
        </CardDescription>

        {presets.length === 0 ? (
          <div className="text-sm text-muted-foreground border border-border rounded-md p-3">{t('settings:model_presets.no_presets')}</div>
        ) : (
          <div className="space-y-2">
            {presets.map((preset) => (
              <Card key={preset.id} className={`p-3 ${selectedPresetId === preset.id ? 'ring-1 ring-primary/30' : ''}`}>
                <div className="flex items-start justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <div className="text-sm font-medium text-foreground">{preset.name}</div>
                      {preset.isBuiltin ? (
                        <Badge className="inline-flex items-center gap-1" variant="outline">
                          <CheckCircle size={14} className="shrink-0" /> {t('settings:model_presets.builtin')}
                        </Badge>
                      ) : preset.isDefault ? (
                        <Badge className="inline-flex items-center gap-1" variant="secondary">
                          <CheckCircle size={14} className="shrink-0" /> {t('settings:model_presets.default')}
                        </Badge>
                      ) : null}
                    </div>
                    {preset.description && (
                      <div className="text-xs text-muted-foreground mt-1">{preset.description}</div>
                    )}
                  </div>
                  <div className="text-xs text-muted-foreground whitespace-nowrap">{t('settings:model_presets.created_on', { date: new Date(preset.createdAt).toLocaleDateString() })}</div>
                </div>

                <div className="mt-3 flex items-center gap-2 justify-end">
                  <NotionButton size="sm" onClick={() => handleApplyPreset(preset)} title={t('settings:model_presets.apply')}>
                    <Lightning size={14} className="shrink-0" /> {t('settings:model_presets.apply')}
                  </NotionButton>
                    <NotionButton size="sm" variant="default" onClick={() => { void handleUpdatePreset(preset.id); }} title={t('settings:model_presets.update')} disabled={preset.isBuiltin}>
                    <FloppyDisk size={14} className="shrink-0" /> {t('settings:model_presets.update')}
                  </NotionButton>
                  {!preset.isBuiltin && (
                    <NotionButton size="sm" variant="ghost" onClick={() => { void handleSetDefault(preset.id); }} title={t('settings:model_presets.default')}>
                      <CheckCircle size={14} className="shrink-0" /> {t('settings:model_presets.default')}
                    </NotionButton>
                  )}
                  {!preset.isBuiltin && (
                    <NotionButton size="sm" variant="danger" onClick={() => { void handleDeletePreset(preset.id); }} title={t('settings:model_presets.delete')}>
                      <Trash size={14} className="shrink-0" /> {t('settings:model_presets.delete')}
                    </NotionButton>
                  )}
                </div>
              </Card>
            ))}
          </div>
        )}

        <NotionDialog open={showCreateDialog} onOpenChange={setShowCreateDialog} maxWidth="max-w-md">
          <NotionDialogHeader>
            <NotionDialogTitle>{t('settings:model_presets.create_dialog_title')}</NotionDialogTitle>
            <NotionDialogDescription>{t('settings:model_presets.create_dialog_description')}</NotionDialogDescription>
          </NotionDialogHeader>
          <NotionDialogBody>
            <Input
              value={newPresetName}
              onChange={(e) => setNewPresetName(e.target.value)}
              placeholder={t('settings:model_presets.preset_name_placeholder')}
              onKeyDown={(e) => e.key === 'Enter' && handleCreatePreset()}
            />
          </NotionDialogBody>
          <NotionDialogFooter>
            <NotionButton size="sm" variant="default" onClick={() => { setShowCreateDialog(false); setNewPresetName(''); }}>{t('common:actions.cancel')}</NotionButton>
            <NotionButton size="sm" variant="primary" onClick={handleCreatePreset}>{t('common:actions.add')}</NotionButton>
          </NotionDialogFooter>
        </NotionDialog>
      </CardContent>
    </Card>
  );
};

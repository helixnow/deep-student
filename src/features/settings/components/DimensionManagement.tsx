/**
 * 嵌入维度管理组件
 *
 * 管理知识库中不同维度向量数据与嵌入模型的映射关系。
 *
 * 设计文档: docs/multimodal-user-memory-design.md (Section 8.5)
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  WarningCircle,
  Warning,
  CircleNotch,
  Plus,
  X,
  Check,
  CaretDown,
  CaretUp,
  Trash,
} from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { Badge } from '@/components/ui/shad/Badge';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/shad/Input';
import { Label } from '@/components/ui/shad/Label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/shad/Table';
import { AppSelect } from '@/components/ui/app-menu';
import { Skeleton } from '@/components/ui/shad/Skeleton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { vfsUnifiedIndexApi, type VfsEmbeddingDimension } from '@/api/vfsUnifiedIndexApi';
import { ApiConfig } from '@/types';
import {
  embeddingCapabilityForModality,
  supportsKnowledgeModelCapability,
} from './knowledgeModelCapabilities';

/** 默认维度状态 */
interface DefaultDimensions {
  text: number | null;
  multimodal: number | null;
}

/** 维度状态 */
type DimensionStatus = 'active' | 'empty';

interface DimensionManagementProps {
  apiConfigs: ApiConfig[];
  getEmbeddingApis?: (currentValue?: string) => ApiConfig[];
}

/** 扩展的维度摘要（用于 UI 显示） */
interface DimensionSummary extends VfsEmbeddingDimension {
  status: DimensionStatus;
  isMultimodal: boolean;
}

export const DimensionManagement: React.FC<DimensionManagementProps> = ({
  apiConfigs,
  getEmbeddingApis,
}) => {
  const { t } = useTranslation(['settings', 'common']);
  const [dimensions, setDimensions] = useState<DimensionSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedDimension, setSelectedDimension] = useState<DimensionSummary | null>(null);
  const [selectedModelId, setSelectedModelId] = useState<string>('');
  const [updating, setUpdating] = useState(false);
  
  const [isAddingNew, setIsAddingNew] = useState(false);
  const [expandedRow, setExpandedRow] = useState<string | null>(null); // 'dimension-modality'
  
  const [newDimension, setNewDimension] = useState<string>('');
  const [newModality, setNewModality] = useState<string>('text');
  const [presetDimensions, setPresetDimensions] = useState<number[]>([]);
  const [dimensionRange, setDimensionRange] = useState<[number, number]>([64, 8192]);
  const [creating, setCreating] = useState(false);
  
  // 行内删除确认：记录处于确认态的行 id（'dimension-modality'），无对话框
  const [confirmingDeleteRow, setConfirmingDeleteRow] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  
  const [newModelId, setNewModelId] = useState<string>('__none__');
  
  // 默认维度状态
  const [defaultDimensions, setDefaultDimensions] = useState<DefaultDimensions>({
    text: null,
    multimodal: null,
  });
  const [settingDefault, setSettingDefault] = useState(false);

  const stats = useMemo(() => ({
    totalDimensions: dimensions.length,
    totalRecords: dimensions.reduce((sum, d) => sum + d.recordCount, 0),
    textDimensions: dimensions.filter(d => d.modality === 'text').length,
    multimodalDimensions: dimensions.filter(d => d.modality === 'multimodal').length,
  }), [dimensions]);

  // 过滤出嵌入模型：优先使用传入的 getEmbeddingApis 函数，否则 fallback
  // 用于更换模型对话框（需要包含当前已选模型）
  const selectedModality = selectedDimension?.modality ?? 'text';
  const embeddingModels = (getEmbeddingApis
    ? getEmbeddingApis(selectedDimension?.modelConfigId)
    : apiConfigs.filter((config) => config.enabled)
  ).filter((config) => (
    config.enabled
    && supportsKnowledgeModelCapability(
      config,
      embeddingCapabilityForModality(selectedModality),
    )
  ));

  // 用于创建对话框的嵌入模型列表（不依赖 selectedDimension）
  const allEmbeddingModels = useMemo(() => {
    const candidates = getEmbeddingApis
      ? getEmbeddingApis()
      : apiConfigs.filter((config) => config.enabled);
    return candidates.filter((config) => (
      config.enabled
      && supportsKnowledgeModelCapability(
        config,
        embeddingCapabilityForModality(newModality),
      )
    ));
  }, [apiConfigs, getEmbeddingApis, newModality]);

  // 加载默认维度设置
  const loadDefaultDimensions = useCallback(async () => {
    try {
      const [textDefault, multimodalDefault] = await Promise.all([
        vfsUnifiedIndexApi.getDefaultEmbeddingDimension('text'),
        vfsUnifiedIndexApi.getDefaultEmbeddingDimension('multimodal'),
      ]);
      setDefaultDimensions({
        text: textDefault?.dimension ?? null,
        multimodal: multimodalDefault?.dimension ?? null,
      });
    } catch (error: unknown) {
      console.error('Failed to load default embedding dimensions:', error);
    }
  }, []);

  // 加载维度数据
  const loadDimensions = useCallback(async () => {
    setLoading(true);
    try {
      const rawDims = await vfsUnifiedIndexApi.listDimensions();
      // 转换为 UI 需要的格式
      const registry: DimensionSummary[] = rawDims.map((d) => ({
        ...d,
        status: d.recordCount > 0 ? 'active' : 'empty',
        isMultimodal: d.modality === 'multimodal',
      }));
      setDimensions(registry);
      // 同时加载默认维度设置
      await loadDefaultDimensions();
    } catch (error: unknown) {
      console.error('Failed to load embedding dimensions:', error);
      showGlobalNotification('error', t('settings:dimension_management.load_error'));
    } finally {
      setLoading(false);
    }
  }, [t, loadDefaultDimensions]);

  useEffect(() => {
    loadDimensions();
    vfsUnifiedIndexApi.getPresetDimensions().then(setPresetDimensions).catch(console.error);
    vfsUnifiedIndexApi.getDimensionRange().then(setDimensionRange).catch(console.error);
  }, [loadDimensions]);

  const getStatusIndicator = (status: DimensionStatus) => {
    switch (status) {
      case 'active':
        return <span className="w-1.5 h-1.5 rounded-full bg-success" />;
      case 'empty':
        return <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />;
      default:
        return <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/30" />;
    }
  };

  // 获取状态文本
  const getStatusText = (status: DimensionStatus) => {
    switch (status) {
      case 'active':
        return t('settings:dimension_management.status_active');
      case 'empty':
        return t('settings:dimension_management.status_empty');
      default:
        return t('common:unknown');
    }
  };

  // 打开更换模型内联面板
  const handleChangeModel = (dimension: DimensionSummary) => {
    const rowId = `${dimension.dimension}-${dimension.modality}`;
    if (expandedRow === rowId) {
      setExpandedRow(null);
      setSelectedDimension(null);
    } else {
      setSelectedDimension(dimension);
      setSelectedModelId(dimension.modelConfigId || '');
      setExpandedRow(rowId);
      setIsAddingNew(false);
      setConfirmingDeleteRow(null);
    }
  };

  // 确认分配模型
  const handleConfirmChangeModel = async () => {
    if (!selectedDimension || !selectedModelId) return;

    const selectedModel = embeddingModels.find((m) => m.id === selectedModelId);
    if (!selectedModel || !selectedModel.enabled || !supportsKnowledgeModelCapability(
      selectedModel,
      embeddingCapabilityForModality(selectedDimension.modality),
    )) {
      showGlobalNotification('error', t('settings:dimension_management.assign_failed'));
      return;
    }

    setUpdating(true);
    try {
      const success = await vfsUnifiedIndexApi.assignDimensionModel(
        selectedDimension.dimension,
        selectedDimension.modality,
        selectedModelId,
        selectedModel.model
      );
      
      if (success) {
        showGlobalNotification('success', t('settings:dimension_management.assign_success'));
        setExpandedRow(null);
        setSelectedDimension(null);
        loadDimensions();
      } else {
        showGlobalNotification('error', t('settings:dimension_management.assign_failed'));
      }
    } catch (error: unknown) {
      console.error('Failed to assign dimension model:', error);
      showGlobalNotification('error', t('settings:dimension_management.assign_failed'));
    } finally {
      setUpdating(false);
    }
  };

  const handleOpenCreateDialog = () => {
    setNewDimension('');
    setNewModality('text');
    setNewModelId('__none__');
    setIsAddingNew(true);
    setExpandedRow(null);
  };

  const handleCreateDimension = async () => {
    const dim = parseInt(newDimension, 10);
    if (isNaN(dim) || dim < dimensionRange[0] || dim > dimensionRange[1]) {
      showGlobalNotification('error', t('settings:dimension_management.invalid_dimension', {
        min: dimensionRange[0],
        max: dimensionRange[1],
      }));
      return;
    }

    const exists = dimensions.some(d => d.dimension === dim && d.modality === newModality);
    if (exists) {
      showGlobalNotification('error', t('settings:dimension_management.dimension_exists'));
      return;
    }

    setCreating(true);
    try {
      const selectedModel = newModelId !== '__none__' 
        ? allEmbeddingModels.find(m => m.id === newModelId) 
        : null;
      if (newModelId !== '__none__' && (!selectedModel || !supportsKnowledgeModelCapability(
        selectedModel,
        embeddingCapabilityForModality(newModality),
      ))) {
        showGlobalNotification('error', t('settings:dimension_management.assign_failed'));
        return;
      }
      await vfsUnifiedIndexApi.createDimension(
        dim, 
        newModality,
        selectedModel?.id,
        selectedModel?.model
      );
      showGlobalNotification('success', t('settings:dimension_management.create_success'));
      setIsAddingNew(false);
      loadDimensions();
    } catch (error: unknown) {
      console.error('Failed to create dimension:', error);
      showGlobalNotification('error', t('settings:dimension_management.create_failed'));
    } finally {
      setCreating(false);
    }
  };

  // 切换行内删除确认条（同一行再次点击则收起）
  const handleToggleDeleteConfirm = (dim: DimensionSummary) => {
    const rowId = `${dim.dimension}-${dim.modality}`;
    setConfirmingDeleteRow((current) => (current === rowId ? null : rowId));
    // 删除确认与分配模型面板互斥，避免同一行叠开两个展开区
    setExpandedRow(null);
    setSelectedDimension(null);
  };

  // 设置为默认维度
  const handleSetAsDefault = async (dim: DimensionSummary) => {
    // 检查是否绑定了模型
    if (!dim.modelConfigId) {
      showGlobalNotification('warning', t('settings:dimension_management.bind_model_first'));
      return;
    }

    setSettingDefault(true);
    try {
      const modality = dim.isMultimodal ? 'multimodal' : 'text';
      await vfsUnifiedIndexApi.setDefaultEmbeddingDimension(dim.dimension, modality);
      showGlobalNotification('success', t('settings:dimension_management.set_default_success', {
        type: dim.isMultimodal ? t('settings:dimension_management.type_multimodal') : t('settings:dimension_management.type_text'),
      }));
      await loadDefaultDimensions();
    } catch (error: unknown) {
      console.error('Failed to set default dimension:', error);
      showGlobalNotification('error', t('settings:dimension_management.set_default_failed'));
    } finally {
      setSettingDefault(false);
    }
  };

  // 检查维度是否为默认
  const isDefaultDimension = (dim: DimensionSummary) => {
    const modality = dim.isMultimodal ? 'multimodal' : 'text';
    return defaultDimensions[modality] === dim.dimension;
  };

  const handleDeleteDimension = async (dim: DimensionSummary) => {
    setDeleting(true);
    try {
      const result = await vfsUnifiedIndexApi.deleteDimension(dim.dimension, dim.modality);
      showGlobalNotification('success', t('settings:dimension_management.delete_success', {
        count: result.deletedSegments,
      }));
      setConfirmingDeleteRow(null);
      loadDimensions();
    } catch (error: unknown) {
      console.error('Failed to delete dimension:', error);
      showGlobalNotification('error', t('settings:dimension_management.delete_failed'));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row items-start sm:items-center sm:justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-base font-semibold text-foreground">
            {t('settings:dimension_management.title')}
          </h3>
          <p className="text-xs text-muted-foreground/70 mt-0.5">
            {t('settings:dimension_management.description')}
          </p>
        </div>
        <div className="flex items-center gap-1.5 w-full sm:w-auto">
          <DsButton
            variant={isAddingNew ? 'default' : 'ghost'}
            size="sm"
            onClick={isAddingNew ? () => setIsAddingNew(false) : handleOpenCreateDialog}
            className="flex-1 sm:flex-none h-7 [@media(pointer:coarse)]:!h-11 text-xs px-2 py-0"
          >
            {isAddingNew ? <X size={12} className="mr-1" /> : <Plus size={12} className="mr-1" />}
            <span>{isAddingNew ? t('common:cancel') : t('settings:dimension_management.create_dimension')}</span>
          </DsButton>
          <DsButton
            variant="ghost"
            size="sm"
            onClick={loadDimensions}
            disabled={loading}
            className="flex-1 sm:flex-none h-7 [@media(pointer:coarse)]:!h-11 text-xs px-2 py-0"
          >
            {t('common:refresh')}
          </DsButton>
        </div>
      </div>
      
      {/* 内联新建维度面板 */}
      {isAddingNew && (
        <div className="mb-4 p-4 rounded-lg border border-border/60 bg-muted/20 ui-drop-in">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('settings:dimension_management.create_dimension_title')}
            </h4>
            <DsButton variant="ghost" size="sm" onClick={() => setIsAddingNew(false)} className="h-6 w-6 p-0 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11">
               <X size={14} />
            </DsButton>
          </div>
          
          <div className="space-y-2 md:space-y-0 md:grid md:grid-cols-3 md:gap-x-4 mb-3">
            <div className="space-y-1.5">
              <Label className="text-2xs uppercase text-muted-foreground font-semibold">{t('settings:dimension_management.dimension_value')}</Label>
              <Input
                type="number"
                value={newDimension}
                onChange={(e) => setNewDimension(e.target.value)}
                placeholder={`${dimensionRange[0]} - ${dimensionRange[1]}`}
                className="h-8 text-xs [@media(pointer:coarse)]:h-11 [@media(pointer:coarse)]:text-[16px]"
                autoFocus
              />
            </div>
            
            <div className="grid grid-cols-2 gap-2 md:contents">
              <div className="space-y-1.5">
                <Label className="text-2xs uppercase text-muted-foreground font-semibold">{t('settings:dimension_management.modality')}</Label>
                <AppSelect value={newModality} onValueChange={setNewModality}
                  options={[
                    { value: 'text', label: t('settings:dimension_management.type_text') },
                    { value: 'multimodal', label: t('settings:dimension_management.type_multimodal') },
                  ]}
                  size="sm"
                  variant="outline"
                />
              </div>
              
              <div className="space-y-1.5">
                <Label className="text-2xs uppercase text-muted-foreground font-semibold">{t('settings:dimension_management.optional_model')}</Label>
                <AppSelect value={newModelId} onValueChange={setNewModelId}
                  placeholder={t('settings:dimension_management.select_model_optional')}
                  options={[
                    { value: '__none__', label: t('settings:dimension_management.no_model_selected') },
                    ...allEmbeddingModels.map((model) => ({ value: model.id, label: model.name })),
                  ]}
                  size="sm"
                  variant="outline"
                />
              </div>
            </div>
          </div>
          
          {presetDimensions.length > 0 && (
            <div className="flex flex-wrap items-center gap-1 md:gap-1.5 mb-3">
              <span className="text-2xs text-muted-foreground/60 mr-0.5 md:mr-1">{t('settings:dimension_management.preset_dimensions')}:</span>
              {presetDimensions.map((preset) => {
                const isSelected = newDimension === String(preset);
                const exists = dimensions.some(d => d.dimension === preset && d.modality === newModality);
                return (
                  <Badge
                    key={preset}
                    variant={isSelected ? 'default' : 'outline'}
                    className={`cursor-pointer text-2xs px-1.5 py-0.5 h-5 [@media(pointer:coarse)]:h-auto [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-2.5 transition-colors ${exists ? 'opacity-30 line-through cursor-not-allowed' : 'hover:bg-primary/10 active:scale-95'}`}
                    onClick={() => !exists && setNewDimension(String(preset))}
                  >
                    {preset}
                  </Badge>
                );
              })}
            </div>
          )}
          
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/20">
            <DsButton variant="ghost" size="sm" onClick={() => setIsAddingNew(false)} className="h-7 [@media(pointer:coarse)]:!h-11 text-xs flex-1 md:flex-none">
              {t('common:cancel')}
            </DsButton>
            <DsButton 
              variant="primary" 
              size="sm" 
              onClick={handleCreateDimension} 
              disabled={creating || !newDimension}
              className="h-7 [@media(pointer:coarse)]:!h-11 text-xs flex-1 md:flex-none"
            >
              {creating ? <CircleNotch size={12} className="mr-1.5 animate-spin" /> : <Check size={12} className="mr-1.5" />}
              {t('common:create')}
            </DsButton>
          </div>
        </div>
      )}

      <div>
        {!loading && dimensions.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 text-xs">
            <div className="flex flex-col gap-0.5 py-1.5 px-2.5 rounded bg-muted/20 border border-muted-foreground/5 transition-colors hover:bg-muted/30 hover:border-muted-foreground/10">
              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">{t('settings:dimension_management.stats_dimensions')}</span>
              <span className="font-medium text-sm">{stats.totalDimensions}</span>
            </div>
            <div className="flex flex-col gap-0.5 py-1.5 px-2.5 rounded bg-muted/20 border border-muted-foreground/5 transition-colors hover:bg-muted/30 hover:border-muted-foreground/10">
              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">{t('settings:dimension_management.stats_records')}</span>
              <span className="font-medium text-sm">{stats.totalRecords.toLocaleString()}</span>
            </div>
            <div className="flex flex-col gap-0.5 py-1.5 px-2.5 rounded bg-muted/20 border border-muted-foreground/5 transition-colors hover:bg-muted/30 hover:border-muted-foreground/10">
              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">{t('settings:dimension_management.type_text')}</span>
              <span className="font-medium text-sm text-info/80">{stats.textDimensions}</span>
            </div>
            <div className="flex flex-col gap-0.5 py-1.5 px-2.5 rounded bg-muted/20 border border-muted-foreground/5 transition-colors hover:bg-muted/30 hover:border-muted-foreground/10">
              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">{t('settings:dimension_management.type_multimodal')}</span>
              <span className="font-medium text-sm text-purple-500/80">{stats.multimodalDimensions}</span>
            </div>
          </div>
        )}

        {loading ? (
          <div className="space-y-3" aria-busy="true">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-11 rounded" />
              ))}
            </div>
            <div className="border rounded-md overflow-hidden bg-background/50 divide-y divide-border/40">
              {Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3 px-4 h-12">
                  <Skeleton className="h-3.5 w-12 shrink-0" />
                  <Skeleton className="h-3.5 w-full max-w-[220px]" />
                  <Skeleton className="h-3.5 w-16 ml-auto shrink-0" />
                  <Skeleton className="h-3.5 w-14 shrink-0" />
                </div>
              ))}
            </div>
          </div>
        ) : dimensions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed rounded-lg bg-muted/5">
            <p className="text-sm text-muted-foreground/70 mb-2">
              {t('settings:dimension_management.no_data')}
            </p>
            <p className="text-xs text-muted-foreground/50 mb-4 max-w-md px-4">
              {t('settings:dimension_management.no_data_hint')}
            </p>
            <DsButton onClick={handleOpenCreateDialog} variant="ghost" size="sm" className="h-8 [@media(pointer:coarse)]:!h-11 text-xs">
              {t('settings:dimension_management.create_first_dimension')}
            </DsButton>
          </div>
        ) : (
          <>
            {/* 桌面端表格 */}
            <div className="hidden md:block border rounded-md overflow-hidden bg-background/50">
              <CustomScrollArea className="h-[min(400px,50dvh)]">
                <Table>
                  <TableHeader className="bg-muted/30 sticky top-0 z-10">
                    <TableRow className="hover:bg-transparent border-b">
                      <TableHead className="w-[80px] text-xs font-semibold uppercase tracking-wider py-2 h-9">
                        {t('settings:dimension_management.column_dimension')}
                      </TableHead>
                      <TableHead className="text-xs font-semibold uppercase tracking-wider py-2 h-9">
                        {t('settings:dimension_management.column_model')}
                      </TableHead>
                      <TableHead className="w-[90px] text-xs font-semibold uppercase tracking-wider py-2 h-9 text-right">
                        {t('settings:dimension_management.column_count')}
                      </TableHead>
                      <TableHead className="w-[80px] text-xs font-semibold uppercase tracking-wider py-2 h-9">
                        {t('settings:dimension_management.column_type')}
                      </TableHead>
                      <TableHead className="w-[100px] text-xs font-semibold uppercase tracking-wider py-2 h-9">
                        {t('settings:dimension_management.column_status')}
                      </TableHead>
                      <TableHead className="w-[120px] text-xs font-semibold uppercase tracking-wider py-2 h-9 text-right pr-4">
                        {t('settings:dimension_management.column_actions')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dimensions.map((dim) => {
                      const rowId = `${dim.dimension}-${dim.modality}`;
                      const isExpanded = expandedRow === rowId;
                      const isConfirmingDelete = confirmingDeleteRow === rowId;
                      
                      return (
                        <React.Fragment key={rowId}>
                          <TableRow className={cn(
                            "group h-12 transition-colors hover:bg-[var(--interactive-hover)]",
                            isExpanded && "bg-muted/40",
                            isConfirmingDelete && "bg-destructive/5 hover:bg-destructive/5",
                          )}>
                            <TableCell className="font-mono py-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-sm font-medium">{dim.dimension}</span>
                                {isDefaultDimension(dim) && (
                                  <CommonTooltip content={t('settings:dimension_management.set_as_default')}>
                                    <span className="w-1.5 h-1.5 rounded-full bg-warning shadow-[0_0_4px_hsl(var(--warning)/0.5)]" />
                                  </CommonTooltip>
                                )}
                              </div>
                            </TableCell>
                            <TableCell className="py-1">
                              <div className="flex flex-col gap-0.5">
                                <span className="truncate max-w-[220px] text-xs font-medium">
                                  {dim.modelName || (
                                    <span className="text-muted-foreground/50 italic">{t('settings:dimension_management.no_model_bound')}</span>
                                  )}
                                </span>
                                <span className="text-2xs text-muted-foreground/40 font-mono truncate max-w-[220px]">
                                  {dim.lanceTableName}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs py-1">
                              {dim.recordCount.toLocaleString()}
                            </TableCell>
                            <TableCell className="py-1">
                              <span className="text-xs">
                                {dim.isMultimodal
                                  ? <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">{t('settings:dimension_management.type_multimodal')}</span>
                                  : <span className="px-1.5 py-0.5 rounded bg-info/10 text-info border border-info/20">{t('settings:dimension_management.type_text')}</span>}
                              </span>
                            </TableCell>
                            <TableCell className="py-1">
                              <div className="flex items-center gap-1.5">
                                {getStatusIndicator(dim.status)}
                                <span className="text-xs text-muted-foreground">{getStatusText(dim.status)}</span>
                              </div>
                            </TableCell>
                            <TableCell className="py-1 pr-4">
                              <div className={cn(
                                "flex items-center justify-end gap-0.5 transition-opacity",
                                (isExpanded || isConfirmingDelete) ? "opacity-100" : "opacity-0 group-hover:opacity-100 [@media(pointer:coarse)]:opacity-100"
                              )}>
                                {!isDefaultDimension(dim) && (
                                  <CommonTooltip content={dim.modelConfigId ? t('settings:dimension_management.set_as_default') : t('settings:dimension_management.bind_model_first')}>
                                    <DsButton
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => handleSetAsDefault(dim)}
                                      disabled={settingDefault || !dim.modelConfigId}
                                      className="text-warning/70 hover:text-warning hover:bg-warning/10 h-6 w-6 p-0 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11"
                                    >
                                      <span className="text-2xs">⭐</span>
                                    </DsButton>
                                  </CommonTooltip>
                                )}
                                <CommonTooltip content={t('settings:dimension_management.assign_model')}>
                                  <DsButton
                                    variant={isExpanded ? "default" : "ghost"}
                                    size="sm"
                                    onClick={() => handleChangeModel(dim)}
                                    className={cn(
                                      "h-6 px-1.5 text-2xs transition-colors [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:px-2.5",
                                      isExpanded ? "bg-primary/10 text-primary hover:bg-primary/20" : "text-muted-foreground hover:text-foreground"
                                    )}
                                  >
                                    {isExpanded ? <CaretUp size={12} className="mr-1" /> : <CaretDown size={12} className="mr-1" />}
                                    {t('settings:dimension_management.assign_model').split(' ')[0]}
                                  </DsButton>
                                </CommonTooltip>
                                <CommonTooltip content={t('common:delete')}>
                                  <DsButton
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleToggleDeleteConfirm(dim)}
                                    aria-expanded={isConfirmingDelete}
                                    className={cn(
                                      "h-6 w-6 p-0 transition-colors [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11",
                                      isConfirmingDelete
                                        ? "text-destructive bg-destructive/10"
                                        : "text-destructive/60 hover:text-destructive hover:bg-destructive/10"
                                    )}
                                  >
                                    <span className="text-2xs">✕</span>
                                  </DsButton>
                                </CommonTooltip>
                              </div>
                            </TableCell>
                          </TableRow>
                          
                          {/* 行内展开：分配模型面板 */}
                          {isExpanded && (
                            <TableRow className="bg-muted/20 border-b border-border/40">
                              <TableCell colSpan={6} className="p-0">
                                <div className="px-6 py-3 space-y-2 ui-drop-in">
                                  <div className="flex items-start justify-between gap-4">
                                    <div className="space-y-0.5">
                                      <h5 className="text-xs font-semibold text-foreground">
                                        {t('settings:dimension_management.change_model_title')}
                                      </h5>
                                      <p className="text-2xs text-muted-foreground">
                                        {t('settings:dimension_management.change_model_description', {
                                          dimension: dim.dimension,
                                        })}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                      <DsButton
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setExpandedRow(null)}
                                        disabled={updating}
                                        className="h-7 [@media(pointer:coarse)]:!h-11 text-xs"
                                      >
                                        {t('common:cancel')}
                                      </DsButton>
                                      <DsButton
                                        variant="primary"
                                        size="sm"
                                        onClick={handleConfirmChangeModel}
                                        disabled={updating || !selectedModelId}
                                        className="h-7 [@media(pointer:coarse)]:!h-11 text-xs"
                                      >
                                        {updating ? <CircleNotch size={12} className="mr-1.5 animate-spin" /> : <Check size={12} className="mr-1.5" />}
                                        {t('common:confirm')}
                                      </DsButton>
                                    </div>
                                  </div>

                                  {embeddingModels.length === 0 ? (
                                    <div className="p-2.5 bg-muted/50 rounded border border-border/40 flex items-start gap-2">
                                      <WarningCircle size={14} className="text-muted-foreground mt-0.5" />
                                      <p className="text-xs text-muted-foreground leading-relaxed">
                                        {t('settings:dimension_management.no_embedding_models')}
                                      </p>
                                    </div>
                                  ) : (
                                    <div className="space-y-2">
                                      <div className="flex flex-wrap gap-1.5">
                                        {embeddingModels.map((model) => (
                                          <DsButton
                                            key={model.id}
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setSelectedModelId(model.id)}
                                            className={cn(
                                              "!h-auto !px-2.5 !py-1 text-xs [@media(pointer:coarse)]:!min-h-11",
                                              model.id === selectedModelId
                                                ? "bg-primary/10 text-primary border border-primary/30"
                                                : "bg-muted/50 text-foreground/70 hover:bg-[var(--interactive-hover)] hover:text-foreground border border-transparent"
                                            )}
                                          >
                                            {model.name}
                                          </DsButton>
                                        ))}
                                      </div>

                                      {selectedModelId && dim.modelConfigId !== selectedModelId && (
                                        <div className="p-2.5 bg-warning/5 border border-warning/10 rounded flex items-start gap-2">
                                          <Warning size={14} className="text-warning/80 mt-0.5" />
                                          <p className="text-2xs text-warning/80 leading-relaxed">
                                            {t('settings:dimension_management.change_model_warning')}
                                          </p>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                </div>
                              </TableCell>
                            </TableRow>
                          )}

                          {/* 行内展开：删除确认条（常驻挂载，grid-rows 动画收展） */}
                          <TableRow
                            className={cn("hover:bg-transparent", !isConfirmingDelete && "border-none")}
                            aria-hidden={!isConfirmingDelete}
                          >
                            <TableCell colSpan={6} className="p-0 border-none">
                              <div className={cn(
                                "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
                                isConfirmingDelete ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                              )}>
                                <div className="overflow-hidden">
                                  <div className="flex items-center gap-3 px-4 py-2.5 bg-destructive/5 border-l-2 border-destructive/60">
                                    <Warning size={14} className="text-destructive shrink-0" />
                                    <p className="flex-1 min-w-0 text-xs text-destructive/90 leading-relaxed">
                                      {t('settings:dimension_management.delete_confirm_inline', {
                                        dimension: dim.dimension,
                                        count: dim.recordCount,
                                      })}
                                    </p>
                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <DsButton
                                        variant="ghost"
                                        size="sm"
                                        tabIndex={isConfirmingDelete ? 0 : -1}
                                        onClick={() => setConfirmingDeleteRow(null)}
                                        disabled={deleting}
                                        className="h-6 [@media(pointer:coarse)]:!h-11 px-2 text-xs"
                                      >
                                        {t('common:cancel')}
                                      </DsButton>
                                      <DsButton
                                        variant="danger"
                                        size="sm"
                                        tabIndex={isConfirmingDelete ? 0 : -1}
                                        onClick={() => handleDeleteDimension(dim)}
                                        disabled={deleting}
                                        className="h-6 [@media(pointer:coarse)]:!h-11 px-2 text-xs"
                                      >
                                        {deleting && isConfirmingDelete
                                          ? <CircleNotch size={12} className="mr-1 animate-spin" />
                                          : <Trash size={12} className="mr-1" />}
                                        {t('settings:dimension_management.delete_confirm_button')}
                                      </DsButton>
                                    </div>
                                  </div>
                                </div>
                              </div>
                            </TableCell>
                          </TableRow>
                        </React.Fragment>
                      );
                    })}
                  </TableBody>
                </Table>
              </CustomScrollArea>
            </div>
            {/* 移动端卡片 */}
            <div className="md:hidden space-y-2">
              {dimensions.map((dim) => {
                const rowId = `${dim.dimension}-${dim.modality}`;
                const isExpanded = expandedRow === rowId;
                const isConfirmingDelete = confirmingDeleteRow === rowId;
                
                return (
                  <div key={rowId} className={cn(
                    "border rounded-md bg-background/50 transition-colors hover:border-border hover:bg-muted/20",
                    isExpanded && "border-primary/30 bg-muted/30",
                    isConfirmingDelete && "border-destructive/40 bg-destructive/5"
                  )}>
                    <div className="p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-bold">{dim.dimension}</span>
                          {/* 触屏无 hover，Tooltip 圆点不可发现：移动卡片改用可见文字徽标 */}
                          {isDefaultDimension(dim) && (
                            <span className="rounded bg-warning/10 px-1.5 py-0.5 text-2xs text-warning">
                              {t('common:default', '默认')}
                            </span>
                          )}
                          <span className="text-2xs">
                            {dim.isMultimodal
                              ? <span className="px-1 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400">{t('settings:dimension_management.type_multimodal')}</span>
                              : <span className="px-1 py-0.5 rounded bg-info/10 text-info">{t('settings:dimension_management.type_text')}</span>}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          {getStatusIndicator(dim.status)}
                          <span className="text-2xs text-muted-foreground">{getStatusText(dim.status)}</span>
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium truncate flex-1">
                          {dim.modelName || <span className="text-muted-foreground/50 italic">{t('settings:dimension_management.no_model_bound')}</span>}
                        </p>
                        <span className="text-2xs text-muted-foreground font-mono shrink-0">
                          {dim.recordCount.toLocaleString()} {t('settings:dimension_management.column_count').toLowerCase()}
                        </span>
                      </div>
                      
                      <div className="flex items-center gap-1 pt-2 border-t border-muted-foreground/5">
                        {!isDefaultDimension(dim) && (
                          // 禁用按钮不触发事件：包裹层点击时提示「需先绑定模型」（触屏看不到 Tooltip）
                          <span
                            onClick={() => {
                              if (!dim.modelConfigId) {
                                showGlobalNotification('info', t('settings:dimension_management.bind_model_first'));
                              }
                            }}
                          >
                            <DsButton
                              variant="ghost"
                              size="sm"
                              onClick={() => handleSetAsDefault(dim)}
                              disabled={settingDefault || !dim.modelConfigId}
                              className="text-warning/70 hover:text-warning text-2xs h-7 [@media(pointer:coarse)]:!h-11 px-2 active:scale-95"
                            >
                              <span className="mr-1">⭐</span>
                              {t('settings:dimension_management.set_as_default')}
                            </DsButton>
                          </span>
                        )}
                        <DsButton
                          variant={isExpanded ? "default" : "ghost"}
                          size="sm"
                          onClick={() => handleChangeModel(dim)}
                          className={cn(
                            "text-2xs h-7 [@media(pointer:coarse)]:!h-11 px-2 active:scale-95",
                            isExpanded && "bg-primary/10 text-primary"
                          )}
                        >
                          {isExpanded ? <CaretUp size={12} className="mr-1" /> : <CaretDown size={12} className="mr-1" />}
                          {t('settings:dimension_management.assign_model')}
                        </DsButton>
                        <div className="flex-1" />
                        <DsButton
                          variant="ghost"
                          size="sm"
                          onClick={() => handleToggleDeleteConfirm(dim)}
                          aria-expanded={isConfirmingDelete}
                          className={cn(
                            "text-2xs h-7 w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 p-0 active:scale-95 transition-colors",
                            isConfirmingDelete
                              ? "text-destructive bg-destructive/10"
                              : "text-destructive/60 hover:text-destructive"
                          )}
                        >
                          <span>✕</span>
                        </DsButton>
                      </div>
                    </div>

                    {/* 行内删除确认条（常驻挂载，grid-rows 动画收展） */}
                    <div
                      className={cn(
                        "grid transition-[grid-template-rows] duration-300 ease-out motion-reduce:transition-none",
                        isConfirmingDelete ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
                      )}
                      aria-hidden={!isConfirmingDelete}
                    >
                      <div className="overflow-hidden">
                        <div className="mx-3 mb-3 p-2.5 rounded bg-destructive/5 border border-destructive/20 space-y-2">
                          <div className="flex items-start gap-2">
                            <Warning size={14} className="text-destructive shrink-0 mt-0.5" />
                            <p className="text-xs text-destructive/90 leading-relaxed">
                              {t('settings:dimension_management.delete_confirm_inline', {
                                dimension: dim.dimension,
                                count: dim.recordCount,
                              })}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            <DsButton
                              variant="ghost"
                              size="sm"
                              tabIndex={isConfirmingDelete ? 0 : -1}
                              onClick={() => setConfirmingDeleteRow(null)}
                              disabled={deleting}
                              className="h-7 [@media(pointer:coarse)]:!h-11 text-xs flex-1"
                            >
                              {t('common:cancel')}
                            </DsButton>
                            <DsButton
                              variant="danger"
                              size="sm"
                              tabIndex={isConfirmingDelete ? 0 : -1}
                              onClick={() => handleDeleteDimension(dim)}
                              disabled={deleting}
                              className="h-7 [@media(pointer:coarse)]:!h-11 text-xs flex-1"
                            >
                              {deleting && isConfirmingDelete
                                ? <CircleNotch size={12} className="mr-1 animate-spin" />
                                : <Trash size={12} className="mr-1" />}
                              {t('settings:dimension_management.delete_confirm_button')}
                            </DsButton>
                          </div>
                        </div>
                      </div>
                    </div>
                    
                    {isExpanded && (
                      <div className="px-3 pb-3 pt-1 border-t border-border/40 ui-drop-in">
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <p className="text-2xs text-muted-foreground">
                              {t('settings:dimension_management.change_model_description', { dimension: dim.dimension })}
                            </p>
                          </div>
                          
                          {embeddingModels.length === 0 ? (
                            <div className="p-2.5 bg-muted/50 rounded border border-border/40 flex items-start gap-2">
                              <WarningCircle size={14} className="text-muted-foreground mt-0.5 shrink-0" />
                              <p className="text-xs text-muted-foreground leading-relaxed">
                                {t('settings:dimension_management.no_embedding_models')}
                              </p>
                            </div>
                          ) : (
                            <div className="space-y-2">
                              <AppSelect value={selectedModelId} onValueChange={setSelectedModelId}
                                placeholder={t('settings:dimension_management.select_model')}
                                options={embeddingModels.map((model) => ({ value: model.id, label: model.name }))}
                                size="sm"
                                variant="outline"
                              />
                              
                              {selectedModelId && dim.modelConfigId !== selectedModelId && (
                                <div className="p-2 bg-warning/5 border border-warning/10 rounded flex items-start gap-2">
                                  <Warning size={12} className="text-warning/80 mt-0.5 shrink-0" />
                                  <p className="text-2xs text-warning/80 leading-relaxed">
                                    {t('settings:dimension_management.change_model_warning')}
                                  </p>
                                </div>
                              )}
                            </div>
                          )}
                          
                          <div className="flex items-center gap-2">
                            <DsButton
                              variant="ghost"
                              size="sm"
                              onClick={() => setExpandedRow(null)}
                              disabled={updating}
                              className="h-7 [@media(pointer:coarse)]:!h-11 text-xs flex-1"
                            >
                              {t('common:cancel')}
                            </DsButton>
                            <DsButton
                              variant="primary"
                              size="sm"
                              onClick={handleConfirmChangeModel}
                              disabled={updating || !selectedModelId}
                              className="h-7 [@media(pointer:coarse)]:!h-11 text-xs flex-1"
                            >
                              {updating ? <CircleNotch size={12} className="mr-1.5 animate-spin" /> : <Check size={12} className="mr-1.5" />}
                              {t('common:confirm')}
                            </DsButton>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}

      </div>
    </div>
  );
};

export default DimensionManagement;

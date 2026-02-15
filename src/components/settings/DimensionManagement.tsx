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
  AlertCircle,
  AlertTriangle,
  Loader2,
  Plus,
  X,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { NotionButton } from '../ui/NotionButton';
import { CustomScrollArea } from '../custom-scroll-area';
import { CommonTooltip } from '../shared/CommonTooltip';
import { Badge } from '../ui/shad/Badge';
import { cn } from '../../lib/utils';
import { Input } from '../ui/shad/Input';
import { Label } from '../ui/shad/Label';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '../ui/shad/Table';
import { AppSelect } from '../ui/app-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../ui/shad/Dialog';
import { showGlobalNotification } from '../UnifiedNotification';
import { vfsUnifiedIndexApi, type VfsEmbeddingDimension } from '../../api/vfsUnifiedIndexApi';
import { ApiConfig } from '../../types';

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
  
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [dimensionToDelete, setDimensionToDelete] = useState<DimensionSummary | null>(null);
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
  const embeddingModels = getEmbeddingApis
    ? getEmbeddingApis(selectedDimension?.modelConfigId)
    : apiConfigs.filter(
        (config) => config.enabled && config.isEmbedding === true && config.isReranker !== true
      );

  // 用于创建对话框的嵌入模型列表（不依赖 selectedDimension）
  const allEmbeddingModels = useMemo(() => {
    return getEmbeddingApis
      ? getEmbeddingApis()
      : apiConfigs.filter(
          (config) => config.enabled && config.isEmbedding === true && config.isReranker !== true
        );
  }, [apiConfigs, getEmbeddingApis]);

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
      console.error('加载默认维度设置失败:', error);
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
      console.error('加载维度数据失败:', error);
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
        return <span className="w-1.5 h-1.5 rounded-full bg-green-500" />;
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
    }
  };

  // 确认分配模型
  const handleConfirmChangeModel = async () => {
    if (!selectedDimension || !selectedModelId) return;

    const selectedModel = embeddingModels.find((m) => m.id === selectedModelId);
    if (!selectedModel) return;

    setUpdating(true);
    try {
      const success = await vfsUnifiedIndexApi.assignDimensionModel(
        selectedDimension.dimension,
        selectedDimension.modality,
        selectedModelId,
        selectedModel.name
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
      console.error('分配维度模型失败:', error);
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
      await vfsUnifiedIndexApi.createDimension(
        dim, 
        newModality,
        selectedModel?.id,
        selectedModel?.name
      );
      showGlobalNotification('success', t('settings:dimension_management.create_success'));
      setIsAddingNew(false);
      loadDimensions();
    } catch (error: unknown) {
      console.error('创建维度失败:', error);
      showGlobalNotification('error', t('settings:dimension_management.create_failed'));
    } finally {
      setCreating(false);
    }
  };

  const handleOpenDeleteDialog = (dim: DimensionSummary) => {
    setDimensionToDelete(dim);
    setShowDeleteDialog(true);
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
      console.error('设置默认维度失败:', error);
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

  const handleDeleteDimension = async () => {
    if (!dimensionToDelete) return;

    setDeleting(true);
    try {
      const result = await vfsUnifiedIndexApi.deleteDimension(
        dimensionToDelete.dimension,
        dimensionToDelete.modality
      );
      showGlobalNotification('success', t('settings:dimension_management.delete_success', {
        count: result.deletedSegments,
      }));
      setShowDeleteDialog(false);
      setDimensionToDelete(null);
      loadDimensions();
    } catch (error: unknown) {
      console.error('删除维度失败:', error);
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
          <NotionButton
            variant={isAddingNew ? 'default' : 'ghost'}
            size="sm"
            onClick={isAddingNew ? () => setIsAddingNew(false) : handleOpenCreateDialog}
            className="flex-1 sm:flex-none h-7 text-[11px] px-2 py-0"
          >
            {isAddingNew ? <X className="w-3 h-3 mr-1" /> : <Plus className="w-3 h-3 mr-1" />}
            <span>{isAddingNew ? t('common:cancel') : t('settings:dimension_management.create_dimension')}</span>
          </NotionButton>
          <NotionButton
            variant="ghost"
            size="sm"
            onClick={loadDimensions}
            disabled={loading}
            className="flex-1 sm:flex-none h-7 text-[11px] px-2 py-0"
          >
            {t('common:refresh')}
          </NotionButton>
        </div>
      </div>
      
      {/* 内联新建维度面板 */}
      {isAddingNew && (
        <div className="mb-4 p-4 rounded-lg border border-border/60 bg-muted/20 animate-in fade-in slide-in-from-top-2 duration-200">
          <div className="flex items-center justify-between mb-4">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {t('settings:dimension_management.create_dimension_title')}
            </h4>
            <NotionButton variant="ghost" size="sm" onClick={() => setIsAddingNew(false)} className="h-6 w-6 p-0">
              <X className="w-3.5 h-3.5" />
            </NotionButton>
          </div>
          
          <div className="space-y-2 md:space-y-0 md:grid md:grid-cols-3 md:gap-x-4 mb-3">
            <div className="space-y-1.5">
              <Label className="text-[10px] uppercase text-muted-foreground font-semibold">{t('settings:dimension_management.dimension_value')}</Label>
              <Input
                type="number"
                value={newDimension}
                onChange={(e) => setNewDimension(e.target.value)}
                placeholder={`${dimensionRange[0]} - ${dimensionRange[1]}`}
                className="h-8 text-xs"
                autoFocus
              />
            </div>
            
            <div className="grid grid-cols-2 gap-2 md:contents">
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase text-muted-foreground font-semibold">{t('settings:dimension_management.modality')}</Label>
                <AppSelect value={newModality} onValueChange={setNewModality}
                  options={[
                    { value: 'text', label: t('settings:dimension_management.type_text') },
                    // ★ 多模态索引已禁用，暂时隐藏多模态选项。恢复 MULTIMODAL_INDEX_ENABLED = true 后取消注释即可
                    // { value: 'multimodal', label: t('settings:dimension_management.type_multimodal') },
                  ]}
                  size="sm"
                  variant="outline"
                />
              </div>
              
              <div className="space-y-1.5">
                <Label className="text-[10px] uppercase text-muted-foreground font-semibold">{t('settings:dimension_management.optional_model')}</Label>
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
              <span className="text-[10px] text-muted-foreground/60 mr-0.5 md:mr-1">{t('settings:dimension_management.preset_dimensions')}:</span>
              {presetDimensions.map((preset) => {
                const isSelected = newDimension === String(preset);
                const exists = dimensions.some(d => d.dimension === preset && d.modality === newModality);
                return (
                  <Badge
                    key={preset}
                    variant={isSelected ? 'default' : 'outline'}
                    className={`cursor-pointer text-[10px] px-1.5 py-0.5 h-5 transition-all ${exists ? 'opacity-30 line-through cursor-not-allowed' : 'hover:bg-primary/10 active:scale-95'}`}
                    onClick={() => !exists && setNewDimension(String(preset))}
                  >
                    {preset}
                  </Badge>
                );
              })}
            </div>
          )}
          
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-border/20">
            <NotionButton variant="ghost" size="sm" onClick={() => setIsAddingNew(false)} className="h-7 text-xs flex-1 md:flex-none">
              {t('common:cancel')}
            </NotionButton>
            <NotionButton 
              variant="primary" 
              size="sm" 
              onClick={handleCreateDimension} 
              disabled={creating || !newDimension}
              className="h-7 text-xs flex-1 md:flex-none"
            >
              {creating ? <Loader2 className="w-3 h-3 mr-1.5 animate-spin" /> : <Check className="w-3 h-3 mr-1.5" />}
              {t('common:create')}
            </NotionButton>
          </div>
        </div>
      )}

      <div>
        {!loading && dimensions.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4 text-[11px]">
            <div className="flex flex-col gap-0.5 py-1.5 px-2.5 rounded bg-muted/20 border border-muted-foreground/5">
              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">{t('settings:dimension_management.stats_dimensions')}</span>
              <span className="font-medium text-sm">{stats.totalDimensions}</span>
            </div>
            <div className="flex flex-col gap-0.5 py-1.5 px-2.5 rounded bg-muted/20 border border-muted-foreground/5">
              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">{t('settings:dimension_management.stats_records')}</span>
              <span className="font-medium text-sm">{stats.totalRecords.toLocaleString()}</span>
            </div>
            <div className="flex flex-col gap-0.5 py-1.5 px-2.5 rounded bg-muted/20 border border-muted-foreground/5">
              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">{t('settings:dimension_management.type_text')}</span>
              <span className="font-medium text-sm text-blue-500/80">{stats.textDimensions}</span>
            </div>
            {/* ★ 多模态索引已禁用，暂时隐藏多模态维度统计。恢复 MULTIMODAL_INDEX_ENABLED = true 后取消注释即可 */}
            {/* <div className="flex flex-col gap-0.5 py-1.5 px-2.5 rounded bg-muted/20 border border-muted-foreground/5">
              <span className="text-muted-foreground/60 uppercase tracking-wider font-semibold">{t('settings:dimension_management.type_multimodal')}</span>
              <span className="font-medium text-sm text-purple-500/80">{stats.multimodalDimensions}</span>
            </div> */}
          </div>
        )}

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="w-5 h-5 text-muted-foreground/40 animate-spin" />
          </div>
        ) : dimensions.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-12 text-center border border-dashed rounded-lg bg-muted/5">
            <p className="text-sm text-muted-foreground/70 mb-2">
              {t('settings:dimension_management.no_data')}
            </p>
            <p className="text-xs text-muted-foreground/50 mb-4 max-w-md px-4">
              {t('settings:dimension_management.no_data_hint')}
            </p>
            <NotionButton onClick={handleOpenCreateDialog} variant="ghost" size="sm" className="h-8 text-xs">
              {t('settings:dimension_management.create_first_dimension')}
            </NotionButton>
          </div>
        ) : (
          <>
            {/* 桌面端表格 */}
            <div className="hidden md:block border rounded-md overflow-hidden bg-background/50">
              <CustomScrollArea className="max-h-[400px]">
                <Table>
                  <TableHeader className="bg-muted/30 sticky top-0 z-10">
                    <TableRow className="hover:bg-transparent border-b">
                      <TableHead className="w-[80px] text-[11px] font-semibold uppercase tracking-wider py-2 h-9">
                        {t('settings:dimension_management.column_dimension')}
                      </TableHead>
                      <TableHead className="text-[11px] font-semibold uppercase tracking-wider py-2 h-9">
                        {t('settings:dimension_management.column_model')}
                      </TableHead>
                      <TableHead className="w-[90px] text-[11px] font-semibold uppercase tracking-wider py-2 h-9 text-right">
                        {t('settings:dimension_management.column_count')}
                      </TableHead>
                      <TableHead className="w-[80px] text-[11px] font-semibold uppercase tracking-wider py-2 h-9">
                        {t('settings:dimension_management.column_type')}
                      </TableHead>
                      <TableHead className="w-[100px] text-[11px] font-semibold uppercase tracking-wider py-2 h-9">
                        {t('settings:dimension_management.column_status')}
                      </TableHead>
                      <TableHead className="w-[120px] text-[11px] font-semibold uppercase tracking-wider py-2 h-9 text-right pr-4">
                        {t('settings:dimension_management.column_actions')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {dimensions.map((dim) => {
                      const rowId = `${dim.dimension}-${dim.modality}`;
                      const isExpanded = expandedRow === rowId;
                      
                      return (
                        <React.Fragment key={rowId}>
                          <TableRow className={cn("group h-12 transition-colors", isExpanded && "bg-muted/40 hover:bg-muted/40")}>
                            <TableCell className="font-mono py-1">
                              <div className="flex items-center gap-1.5">
                                <span className="text-sm font-medium">{dim.dimension}</span>
                                {isDefaultDimension(dim) && (
                                  <CommonTooltip content={t('settings:dimension_management.set_as_default')}>
                                    <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 shadow-[0_0_4px_hsl(var(--warning)/0.5)]" />
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
                                <span className="text-[10px] text-muted-foreground/40 font-mono truncate max-w-[220px]">
                                  {dim.lanceTableName}
                                </span>
                              </div>
                            </TableCell>
                            <TableCell className="text-right font-mono text-xs py-1">
                              {dim.recordCount.toLocaleString()}
                            </TableCell>
                            <TableCell className="py-1">
                              <span className="text-[11px]">
                                {dim.isMultimodal
                                  ? <span className="px-1.5 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400 border border-purple-500/20">{t('settings:dimension_management.type_multimodal')}</span>
                                  : <span className="px-1.5 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400 border border-blue-500/20">{t('settings:dimension_management.type_text')}</span>}
                              </span>
                            </TableCell>
                            <TableCell className="py-1">
                              <div className="flex items-center gap-1.5">
                                {getStatusIndicator(dim.status)}
                                <span className="text-[11px] text-muted-foreground">{getStatusText(dim.status)}</span>
                              </div>
                            </TableCell>
                            <TableCell className="py-1 pr-4">
                              <div className={cn(
                                "flex items-center justify-end gap-0.5 transition-opacity",
                                isExpanded ? "opacity-100" : "opacity-0 group-hover:opacity-100"
                              )}>
                                {!isDefaultDimension(dim) && (
                                  <CommonTooltip content={dim.modelConfigId ? t('settings:dimension_management.set_as_default') : t('settings:dimension_management.bind_model_first')}>
                                    <NotionButton
                                      variant="ghost"
                                      size="sm"
                                      onClick={() => handleSetAsDefault(dim)}
                                      disabled={settingDefault || !dim.modelConfigId}
                                      className="text-yellow-600/70 hover:text-yellow-600 hover:bg-yellow-500/10 h-6 w-6 p-0"
                                    >
                                      <span className="text-[10px]">⭐</span>
                                    </NotionButton>
                                  </CommonTooltip>
                                )}
                                <CommonTooltip content={t('settings:dimension_management.assign_model')}>
                                  <NotionButton
                                    variant={isExpanded ? "default" : "ghost"}
                                    size="sm"
                                    onClick={() => handleChangeModel(dim)}
                                    className={cn(
                                      "h-6 px-1.5 text-[10px] transition-colors",
                                      isExpanded ? "bg-primary/10 text-primary hover:bg-primary/20" : "text-muted-foreground hover:text-foreground"
                                    )}
                                  >
                                    {isExpanded ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
                                    {t('settings:dimension_management.assign_model').split(' ')[0]}
                                  </NotionButton>
                                </CommonTooltip>
                                <CommonTooltip content={t('common:delete')}>
                                  <NotionButton
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleOpenDeleteDialog(dim)}
                                    className="text-destructive/60 hover:text-destructive hover:bg-destructive/10 h-6 w-6 p-0"
                                  >
                                    <span className="text-[10px]">✕</span>
                                  </NotionButton>
                                </CommonTooltip>
                              </div>
                            </TableCell>
                          </TableRow>
                          
                          {/* 行内展开：分配模型面板 */}
                          {isExpanded && (
                            <TableRow className="bg-muted/20 hover:bg-muted/20 border-b border-border/40">
                              <TableCell colSpan={6} className="p-0">
                                <div className="px-6 py-3 space-y-2 animate-in fade-in slide-in-from-top-1 duration-200">
                                  <div className="flex items-start justify-between gap-4">
                                    <div className="space-y-0.5">
                                      <h5 className="text-xs font-semibold text-foreground">
                                        {t('settings:dimension_management.change_model_title')}
                                      </h5>
                                      <p className="text-[10px] text-muted-foreground">
                                        {t('settings:dimension_management.change_model_description', {
                                          dimension: dim.dimension,
                                        })}
                                      </p>
                                    </div>
                                    <div className="flex items-center gap-2 shrink-0">
                                      <NotionButton
                                        variant="ghost"
                                        size="sm"
                                        onClick={() => setExpandedRow(null)}
                                        disabled={updating}
                                        className="h-7 text-xs"
                                      >
                                        {t('common:cancel')}
                                      </NotionButton>
                                      <NotionButton
                                        variant="primary"
                                        size="sm"
                                        onClick={handleConfirmChangeModel}
                                        disabled={updating || !selectedModelId}
                                        className="h-7 text-xs"
                                      >
                                        {updating ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <Check className="h-3 w-3 mr-1.5" />}
                                        {t('common:confirm')}
                                      </NotionButton>
                                    </div>
                                  </div>

                                  {embeddingModels.length === 0 ? (
                                    <div className="p-2.5 bg-muted/50 rounded border border-border/40 flex items-start gap-2">
                                      <AlertCircle className="h-3.5 w-3.5 text-muted-foreground mt-0.5" />
                                      <p className="text-[11px] text-muted-foreground leading-relaxed">
                                        {t('settings:dimension_management.no_embedding_models')}
                                      </p>
                                    </div>
                                  ) : (
                                    <div className="space-y-2">
                                      <div className="flex flex-wrap gap-1.5">
                                        {embeddingModels.map((model) => (
                                          <NotionButton
                                            key={model.id}
                                            variant="ghost"
                                            size="sm"
                                            onClick={() => setSelectedModelId(model.id)}
                                            className={cn(
                                              "!h-auto !px-2.5 !py-1 text-xs",
                                              model.id === selectedModelId
                                                ? "bg-primary/10 text-primary border border-primary/30"
                                                : "bg-muted/50 text-foreground/70 hover:bg-muted hover:text-foreground border border-transparent"
                                            )}
                                          >
                                            {model.name}
                                          </NotionButton>
                                        ))}
                                      </div>

                                      {selectedModelId && dim.modelConfigId !== selectedModelId && (
                                        <div className="p-2.5 bg-yellow-500/5 border border-yellow-500/10 rounded flex items-start gap-2">
                                          <AlertTriangle className="h-3.5 w-3.5 text-yellow-600/80 mt-0.5" />
                                          <p className="text-[10px] text-yellow-700/80 dark:text-yellow-400/80 leading-relaxed">
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
                
                return (
                  <div key={rowId} className={cn(
                    "border rounded-md bg-background/50 transition-colors",
                    isExpanded && "border-primary/30 bg-muted/30"
                  )}>
                    <div className="p-3 space-y-2">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-sm font-bold">{dim.dimension}</span>
                          {isDefaultDimension(dim) && (
                            <CommonTooltip content={t('settings:dimension_management.set_as_default')}>
                              <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 shadow-[0_0_4px_hsl(var(--warning)/0.5)]" />
                            </CommonTooltip>
                          )}
                          <span className="text-[10px]">
                            {dim.isMultimodal
                              ? <span className="px-1 py-0.5 rounded bg-purple-500/10 text-purple-600 dark:text-purple-400">{t('settings:dimension_management.type_multimodal')}</span>
                              : <span className="px-1 py-0.5 rounded bg-blue-500/10 text-blue-600 dark:text-blue-400">{t('settings:dimension_management.type_text')}</span>}
                          </span>
                        </div>
                        <div className="flex items-center gap-1">
                          {getStatusIndicator(dim.status)}
                          <span className="text-[10px] text-muted-foreground">{getStatusText(dim.status)}</span>
                        </div>
                      </div>
                      
                      <div className="flex items-center justify-between gap-2">
                        <p className="text-xs font-medium truncate flex-1">
                          {dim.modelName || <span className="text-muted-foreground/50 italic">{t('settings:dimension_management.no_model_bound')}</span>}
                        </p>
                        <span className="text-[10px] text-muted-foreground font-mono shrink-0">
                          {dim.recordCount.toLocaleString()} {t('settings:dimension_management.column_count').toLowerCase()}
                        </span>
                      </div>
                      
                      <div className="flex items-center gap-1 pt-2 border-t border-muted-foreground/5">
                        {!isDefaultDimension(dim) && (
                          <NotionButton
                            variant="ghost"
                            size="sm"
                            onClick={() => handleSetAsDefault(dim)}
                            disabled={settingDefault || !dim.modelConfigId}
                            className="text-yellow-600/70 hover:text-yellow-600 text-[10px] h-7 px-2 active:scale-95"
                          >
                            <span className="mr-1">⭐</span>
                            {t('settings:dimension_management.set_as_default')}
                          </NotionButton>
                        )}
                        <NotionButton
                          variant={isExpanded ? "default" : "ghost"}
                          size="sm"
                          onClick={() => handleChangeModel(dim)}
                          className={cn(
                            "text-[10px] h-7 px-2 active:scale-95",
                            isExpanded && "bg-primary/10 text-primary"
                          )}
                        >
                          {isExpanded ? <ChevronUp className="w-3 h-3 mr-1" /> : <ChevronDown className="w-3 h-3 mr-1" />}
                          {t('settings:dimension_management.assign_model')}
                        </NotionButton>
                        <div className="flex-1" />
                        <NotionButton
                          variant="ghost"
                          size="sm"
                          onClick={() => handleOpenDeleteDialog(dim)}
                          className="text-destructive/60 hover:text-destructive text-[10px] h-7 w-7 p-0 active:scale-95"
                        >
                          <span>✕</span>
                        </NotionButton>
                      </div>
                    </div>
                    
                    {isExpanded && (
                      <div className="px-3 pb-3 pt-1 border-t border-border/40 animate-in fade-in slide-in-from-top-1 duration-200">
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <p className="text-[10px] text-muted-foreground">
                              {t('settings:dimension_management.change_model_description', { dimension: dim.dimension })}
                            </p>
                          </div>
                          
                          {embeddingModels.length === 0 ? (
                            <div className="p-2.5 bg-muted/50 rounded border border-border/40 flex items-start gap-2">
                              <AlertCircle className="h-3.5 w-3.5 text-muted-foreground mt-0.5 shrink-0" />
                              <p className="text-[11px] text-muted-foreground leading-relaxed">
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
                                <div className="p-2 bg-yellow-500/5 border border-yellow-500/10 rounded flex items-start gap-2">
                                  <AlertTriangle className="h-3 w-3 text-yellow-600/80 mt-0.5 shrink-0" />
                                  <p className="text-[10px] text-yellow-700/80 dark:text-yellow-400/80 leading-relaxed">
                                    {t('settings:dimension_management.change_model_warning')}
                                  </p>
                                </div>
                              )}
                            </div>
                          )}
                          
                          <div className="flex items-center gap-2">
                            <NotionButton
                              variant="ghost"
                              size="sm"
                              onClick={() => setExpandedRow(null)}
                              disabled={updating}
                              className="h-7 text-xs flex-1"
                            >
                              {t('common:cancel')}
                            </NotionButton>
                            <NotionButton
                              variant="primary"
                              size="sm"
                              onClick={handleConfirmChangeModel}
                              disabled={updating || !selectedModelId}
                              className="h-7 text-xs flex-1"
                            >
                              {updating ? <Loader2 className="h-3 w-3 mr-1.5 animate-spin" /> : <Check className="h-3 w-3 mr-1.5" />}
                              {t('common:confirm')}
                            </NotionButton>
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

        {/* 更换模型对话框 (已改为内联编辑) */}

        {/* 新建维度对话框 (已改为内联编辑) */}

        <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
          <DialogContent className="sm:max-w-[400px]">
            <DialogHeader>
              <DialogTitle className="text-base">
                {t('settings:dimension_management.delete_dimension_title')}
              </DialogTitle>
              <DialogDescription className="text-xs">
                {t('settings:dimension_management.delete_dimension_description', {
                  dimension: dimensionToDelete?.dimension,
                  count: dimensionToDelete?.recordCount ?? 0,
                })}
              </DialogDescription>
            </DialogHeader>

            {dimensionToDelete && dimensionToDelete.recordCount > 0 && (
              <div className="p-3 bg-destructive/5 border border-destructive/10 rounded-md">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-destructive/80 leading-relaxed">
                    {t('settings:dimension_management.delete_warning', {
                      count: dimensionToDelete.recordCount,
                    })}
                  </p>
                </div>
              </div>
            )}

            <DialogFooter className="gap-2 sm:gap-0">
              <NotionButton
                variant="ghost"
                onClick={() => setShowDeleteDialog(false)}
                disabled={deleting}
                className="h-8 text-xs"
              >
                {t('common:cancel')}
              </NotionButton>
              <NotionButton
                variant="danger"
                onClick={handleDeleteDimension}
                disabled={deleting}
                className="h-8 text-xs"
              >
                {deleting && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                {t('common:delete')}
              </NotionButton>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
};

export default DimensionManagement;

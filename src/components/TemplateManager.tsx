import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { CustomAnkiTemplate, CreateTemplateRequest } from '../types';
import { templateManager } from '../data/ankiTemplates';
import { templateService } from '../services/templateService';
import './TemplateManager.css';
import { IframePreview, renderCardPreview } from './SharedPreview';
import RealTimeTemplateEditor from './RealTimeTemplateEditor';
import { NotionButton } from './ui/NotionButton';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from './ui/shad/Dialog';
import { Checkbox } from './ui/shad/Checkbox';
import { ErrorBoundary } from './ErrorBoundary';
import { ComplexityReport, ComplexityLevel, EnhancedFieldExtractionRule } from '../types/enhanced-field-types';
import { checkComplexTemplatesStatus } from '../utils/forceImportTemplates';
import { invoke } from '@tauri-apps/api/core';
import FieldTypeConfigurator from './FieldTypeConfigurator';
import { CustomScrollArea } from './custom-scroll-area';
import { showGlobalNotification } from './UnifiedNotification';
import { formatErrorMessage, logError } from '../utils/errorUtils';
import {
  Palette,
  BookOpen,
  Plus,
  Edit,
  AlertTriangle,
  Search,
  FileText,
  User,
  Copy,
  Trash2,
  CheckCircle,
  X,
  Settings,
  Paintbrush,
  Eye,
  RefreshCw,
  Download,
  Upload,
} from 'lucide-react';
import {
  UnifiedSidebar,
  UnifiedSidebarHeader,
  UnifiedSidebarContent,
  UnifiedSidebarItem,
} from './ui/unified-sidebar/UnifiedSidebar';
import { useMobileHeader, MobileSlidingLayout } from '@/components/layout';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { MOBILE_LAYOUT } from '@/config/mobileLayout';

interface TemplateManagerProps {
  onClose: () => void;
  onSelectTemplate?: (template: CustomAnkiTemplate) => void;
}

const TemplateManager: React.FC<TemplateManagerProps> = ({ onClose, onSelectTemplate }) => {
  const { t } = useTranslation();
  const { isSmallScreen } = useBreakpoint();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // 移动端统一顶栏配置
  useMobileHeader('template-management', {
    title: t('template.manager_title'),
    showMenu: true,
    onMenuClick: () => setSidebarOpen(prev => !prev),
  }, [t]);

  const [templates, setTemplates] = useState<CustomAnkiTemplate[]>([]);
  const [activeTab, setActiveTab] = useState<'browse' | 'edit' | 'create'>('browse');
  const [useRealTimeEditor, setUseRealTimeEditor] = useState(true); // 默认启用实时编辑器
  const [selectedTemplate, setSelectedTemplate] = useState<CustomAnkiTemplate | null>(null);
  const [editingTemplate, setEditingTemplate] = useState<CustomAnkiTemplate | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [complexityReport, setComplexityReport] = useState<ComplexityReport | null>(null);
  const [showComplexityAnalysis, setShowComplexityAnalysis] = useState(false);
  const [showImportDialog, setShowImportDialog] = useState(false);
  const [importStatus, setImportStatus] = useState<any>(null);
  const [isImporting, setIsImporting] = useState(false);
  const [showImportExternalDialog, setShowImportExternalDialog] = useState(false);
  const [overwriteExisting, setOverwriteExisting] = useState(true);
  const [selectedImportFile, setSelectedImportFile] = useState<File | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingDeleteTemplateRef = useRef<{ id: string | null; expiresAt: number }>({ id: null, expiresAt: 0 });
  const onClickImportExternal = () => {
    setSelectedImportFile(null);
    setOverwriteExisting(true);
    setShowImportExternalDialog(true);
  };

  const handleExternalFilesSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files && e.target.files[0];
    setSelectedImportFile(file || null);
  };

  const handleConfirmImportExternal = async () => {
    if (!selectedImportFile) return;
    setIsImporting(true);
    try {
      const text = await selectedImportFile.text();
      let strictBuiltin = true;
      try {
        const parsed = JSON.parse(text);
        const items = Array.isArray(parsed) ? parsed : [parsed];
        strictBuiltin = items.every(item => item && typeof item === 'object' && ('fields_json' in item || 'field_extraction_rules_json' in item));
      } catch {
        strictBuiltin = false;
      }
      const result = await invoke<string>('import_custom_templates_bulk', {
        template_data: text,
        templateData: text,
        overwrite_existing: overwriteExisting,
        overwriteExisting: overwriteExisting,
        strict_builtin: strictBuiltin,
        strictBuiltin: strictBuiltin,
      });
      showGlobalNotification('success', t('template.import_success') + `\n${result}`);
      await loadTemplates();
      setShowImportExternalDialog(false);
      setSelectedImportFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (err: unknown) {
      logError('Import external template failed', err);
      setError(formatErrorMessage(t('template.import_external_failed_msg'), err));
    } finally {
      setIsImporting(false);
    }
  };

  // 加载模板
  useEffect(() => {
    loadTemplates();
    
    // 订阅模板变化
    const unsubscribe = templateManager.subscribe(setTemplates);
    return unsubscribe;
  }, []);
  
  // 强制导入复杂模板 - 已停用，改为通过统一数据库迁移
  const handleForceImport = async () => {
    showGlobalNotification('info', t('template.import_migrated_notice'));
    setShowImportDialog(false);
  };
  
  // 强制刷新模板列表 - 清除所有缓存
  const handleForceRefresh = async () => {
    console.log('🔄 执行强制刷新，清除所有缓存...');
    setIsLoading(true);
    try {
      // 清除localStorage缓存
      localStorage.removeItem('high_quality_templates_imported_v2');
      localStorage.removeItem('complex_templates_force_imported');
      
      // 强制重新加载模板
      await loadTemplates();
      
      showGlobalNotification('success', t('template.refresh_done', { count: templates.length }));
    } catch (error: unknown) {
      logError('Force refresh failed', error);
      setError(formatErrorMessage(t('template.refresh_failed_msg'), error));
    } finally {
      setIsLoading(false);
    }
  };
  
  // 检查模板状态
  const handleCheckStatus = async () => {
    try {
      const status = await checkComplexTemplatesStatus();
      const report = t('template.check_status_report', {
        total: status.totalInDatabase,
        existing: status.existingTemplates.length,
        missing: status.missingTemplates.length,
      });
      const detail = status.missingTemplates.length > 0
        ? t('template.check_status_missing_list', { list: status.missingTemplates.join('\n') })
        : t('template.check_status_all_imported');
      showGlobalNotification('info', report + detail);
    } catch (error: unknown) {
      logError('Check status failed', error);
      setError(formatErrorMessage(t('template.check_status_failed_msg'), error));
    }
  };

  // 导入内置模板
  const handleImportBuiltinTemplates = async () => {
    setIsImporting(true);
    try {
      const result = await invoke<string>('import_builtin_templates');
      showGlobalNotification('success', t('template.import_success') + `\n${result}`);
      
      // 刷新模板列表
      await loadTemplates();
    } catch (error: unknown) {
      logError('Import builtin templates failed', error);
      setError(formatErrorMessage(t('template.import_builtin_failed_msg'), error));
    } finally {
      setIsImporting(false);
    }
  };

  const loadTemplates = async () => {
    setIsLoading(true);
    try {
      // 强制刷新模板管理器缓存
      console.log('🔄 开始强制刷新模板列表...');
      await templateManager.refresh();
      const allTemplates = templateManager.getAllTemplates();
      console.log(`📊 加载了 ${allTemplates.length} 个模板:`, allTemplates.map(t => t.name));
      setTemplates(allTemplates);
    } catch (err: unknown) {
      logError('Template load failed', err);
      setError(formatErrorMessage(t('template.load_failed'), err));
    } finally {
      setIsLoading(false);
    }
  };

  // 过滤模板
  const filteredTemplates = templates.filter(template =>
    template.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    template.description.toLowerCase().includes(searchTerm.toLowerCase())
  );

  // 选择模板
  const handleSelectTemplate = (template: CustomAnkiTemplate) => {
    const normalizedTemplate = templateService.ensureFieldExtractionRules(template);
    setSelectedTemplate(normalizedTemplate);

    const report = templateService.analyzeComplexity(normalizedTemplate);
    setComplexityReport(report);

    if (onSelectTemplate) {
      onSelectTemplate(normalizedTemplate);
    }
  };
  
  // 获取复杂度级别的颜色
  const getComplexityColor = (level: ComplexityLevel): string => {
    switch (level) {
      case ComplexityLevel.Simple: return 'hsl(var(--success))';
      case ComplexityLevel.Moderate: return 'hsl(var(--warning))';
      case ComplexityLevel.Complex: return 'hsl(var(--danger))';
      case ComplexityLevel.VeryComplex: return 'hsl(var(--danger-muted))';
      default: return 'hsl(var(--muted-foreground))';
    }
  };

  // 编辑模板
  const handleEditTemplate = (template: CustomAnkiTemplate) => {
    setEditingTemplate({ ...template });
    setActiveTab('edit');
  };

  // 复制模板
  const handleDuplicateTemplate = (template: CustomAnkiTemplate) => {
    const duplicated: CustomAnkiTemplate = {
      ...template,
      id: `${template.id}-copy-${Date.now()}`,
      name: `${template.name}${t('template.copy_suffix')}`,
      author: t('template.copy_author'),
      is_built_in: false,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    setEditingTemplate(duplicated);
    setActiveTab('create');
  };

  // 删除模板
  const handleDeleteTemplate = async (template: CustomAnkiTemplate) => {
    const now = Date.now();
    const pendingDelete = pendingDeleteTemplateRef.current;

    if (pendingDelete.id !== template.id || pendingDelete.expiresAt < now) {
      pendingDeleteTemplateRef.current = { id: template.id, expiresAt: now + 8000 };
      showGlobalNotification(
        'warning',
        t('template.delete_confirm_again', { name: template.name })
      );
      return;
    }

    pendingDeleteTemplateRef.current = { id: null, expiresAt: 0 };

    try {
      await templateManager.deleteTemplate(template.id);
      setError(null);
      showGlobalNotification('success', t('template.delete_success'));
    } catch (err: unknown) {
      logError('Delete template failed', err);
      setError(formatErrorMessage(t('template.delete_failed'), err));
      showGlobalNotification('error', t('template.delete_failed'));
    }
  };

  // 创建新模板
  const handleCreateNewTemplate = () => {
    const newTemplate: CustomAnkiTemplate = {
      id: `template_${Date.now()}`,
      name: t('template.new_template_name'),
      description: t('template.new_template_description'),
      author: '',
      version: '1.0.0',
      preview_front: '{{Front}}',
      preview_back: '{{Back}}',
      note_type: 'Basic',
      fields: ['Front', 'Back', 'Notes', 'Tags'],
      generation_prompt: '',
      front_template: '<div class="card">\n  <div class="question">{{Front}}</div>\n</div>',
      back_template: '<div class="card">\n  <div class="question">{{Front}}</div>\n  <div class="answer">{{Back}}</div>\n</div>',
      css_style: '.card {\n  font-family: Arial, sans-serif;\n  padding: 20px;\n  text-align: center;\n}\n\n.question {\n  font-size: 20px;\n  color: hsl(var(--foreground));\n  margin-bottom: 20px;\n}\n\n.answer {\n  font-size: 18px;\n  color: hsl(var(--primary));\n}',
      field_extraction_rules: {},
      is_built_in: false,
      is_active: true,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    setEditingTemplate(newTemplate);
    setActiveTab('create');
  };

  const importExternalDialog = (
    <Dialog
      open={showImportExternalDialog}
      onOpenChange={(open) => {
        if (!isImporting) setShowImportExternalDialog(open);
      }}
    >
      <DialogContent className="flex w-[min(92vw,960px)] max-w-3xl max-h-[85vh] flex-col overflow-hidden p-0">
        <div className="sticky top-0 z-10 border-b border-border bg-white px-6 py-5 dark:border-border dark:bg-card">
          <DialogHeader>
            <DialogTitle>{t('template.import_external_dialog_title')}</DialogTitle>
            <DialogDescription>
              {t('template.import_external_dialog_desc')}
            </DialogDescription>
          </DialogHeader>
        </div>
        <CustomScrollArea
          className="flex-1 min-h-0 -mr-6 pl-6"
          viewportClassName="space-y-3 pr-6 py-6 text-sm text-foreground dark:text-foreground"
          trackOffsetTop={12}
          trackOffsetBottom={12}
          trackOffsetRight={0}
        >
          <ul className="list-disc pl-5 space-y-1">
            <li>{t('template.import_external_rule_1')}</li>
            <li>{t('template.import_external_rule_2')}</li>
            <li>{t('template.import_external_rule_3')}</li>
            <li>{t('template.import_external_rule_4')}</li>
            <li>{t('template.import_external_rule_5')}</li>
          </ul>
          <div className="flex items-center gap-2">
            <Checkbox
              id="templateManagerOverwriteExisting"
              checked={overwriteExisting}
              onCheckedChange={(v) => setOverwriteExisting(Boolean(v))}
            />
            <label htmlFor="templateManagerOverwriteExisting" className="text-sm select-none">
              {t('template.overwrite_existing_label')}
            </label>
          </div>
          <div className="mt-2">
            <input
              ref={fileInputRef}
              type="file"
              accept="application/json,.json"
              onChange={handleExternalFilesSelected}
            />
            {selectedImportFile && (
              <div className="mt-1 text-xs text-muted-foreground dark:text-muted-foreground">
                {t('template.file_selected_prefix')}
                {selectedImportFile.name}
              </div>
            )}
          </div>
        </CustomScrollArea>
        <DialogFooter className="border-t border-border bg-white px-6 py-4 dark:border-border dark:bg-card">
          <NotionButton
            variant="default"
            onClick={() => setShowImportExternalDialog(false)}
            disabled={isImporting}
          >
            {t('template.cancel_button')}
          </NotionButton>
          <NotionButton
            variant="primary"
            onClick={handleConfirmImportExternal}
            disabled={!selectedImportFile || isImporting}
          >
            {isImporting ? t('template.importing') : t('template.start_import_button')}
          </NotionButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );

  // 渲染侧边栏
  const renderSidebar = () => (
    <UnifiedSidebar
      width={isSmallScreen ? 'full' : 220}
      showMacSafeZone={false}
      searchQuery={searchTerm}
      onSearchQueryChange={setSearchTerm}
      displayMode="panel"
      autoResponsive={false}
      onClose={() => setSidebarOpen(false)}
    >
        <UnifiedSidebarHeader
          title={t('template.manager_title')}
          icon={Palette}
          showSearch={true}
          searchPlaceholder={t('template.search_placeholder')}
          showCreate={true}
          createTitle={t('template.tab_create')}
          onCreateClick={handleCreateNewTemplate}
          showRefresh={true}
          refreshTitle={t('template.refresh')}
          onRefreshClick={handleForceRefresh}
          isRefreshing={isLoading}
          showCollapse={false}
        />
        
        <UnifiedSidebarContent>
          {/* 导航项 */}
          <div className="px-1 py-2">
            <UnifiedSidebarItem
              id="browse"
              isSelected={activeTab === 'browse'}
              onClick={() => setActiveTab('browse')}
              icon={BookOpen}
              title={t('template.tab_browse')}
              description={t('template.total_templates', { count: filteredTemplates.length })}
            />
            {editingTemplate && (
              <UnifiedSidebarItem
                id="edit"
                isSelected={activeTab === 'edit' || activeTab === 'create'}
                onClick={() => setActiveTab(activeTab === 'create' ? 'create' : 'edit')}
                icon={Edit}
                title={activeTab === 'create' ? t('template.tab_create') : t('template.tab_edit')}
                description={editingTemplate.name}
              />
            )}
          </div>

          {/* 分隔线 */}
          <div className="mx-2 my-2 h-px bg-border" />

          {/* 导入操作 */}
          <div className="px-2 py-1">
            <div className="text-xs text-muted-foreground px-2 py-1 font-semibold">
              {t('template.import_section')}
            </div>
            <UnifiedSidebarItem
              id="import-builtin"
              onClick={handleImportBuiltinTemplates}
              icon={Download}
              title={t('anki:template_management.import_builtin')}
            />
            <UnifiedSidebarItem
              id="import-external"
              onClick={onClickImportExternal}
              icon={Upload}
              title={t('anki:template_management.import_external')}
            />
          </div>

          {/* 工具操作 */}
          <div className="px-2 py-1">
            <div className="text-xs text-muted-foreground px-2 py-1 font-semibold">
              {t('template.tools_section')}
            </div>
            <UnifiedSidebarItem
              id="check-status"
              onClick={handleCheckStatus}
              icon={Search}
              title={t('anki:template_management.check')}
            />
          </div>
        </UnifiedSidebarContent>

        {/* 底部关闭按钮 */}
        {onClose && (
          <div className="mt-auto p-2 border-t border-border">
            <NotionButton
              variant="ghost"
              size="sm"
              onClick={onClose}
              className="w-full justify-start gap-2"
            >
              <X className="h-4 w-4" />
              {t('template.close_button')}
            </NotionButton>
          </div>
        )}
    </UnifiedSidebar>
  );

  // 渲染主内容
  const renderMainContent = () => (
    <div className="flex-1 flex flex-col min-w-0 h-full bg-background">
        {/* 错误提示 */}
        {error && (
          <div className="mx-4 mt-4 rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/30 dark:border-amber-800 px-4 py-3 text-sm text-amber-800 dark:text-amber-200 flex items-center justify-between">
            <span className="flex items-center gap-2">
              <AlertTriangle size={16} />
              {error}
            </span>
            <NotionButton variant="ghost" size="icon" iconOnly onClick={() => setError(null)} className="text-amber-700 hover:text-amber-900 dark:text-amber-300 dark:hover:text-amber-100" aria-label="close">
              <X size={14} />
            </NotionButton>
          </div>
        )}

        {/* 主内容 */}
        <main className="flex-1 min-h-0">
          {/* 移动端去除 padding，让卡片容器拉伸到边缘 */}
          <CustomScrollArea className="h-full" viewportClassName={isSmallScreen ? "p-0" : "p-4"}>
            {activeTab === 'browse' && (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-200">
                <TemplateBrowser
                  templates={filteredTemplates}
                  selectedTemplate={selectedTemplate}
                  searchTerm={searchTerm}
                  onSearchChange={setSearchTerm}
                  onSelectTemplate={handleSelectTemplate}
                  onEditTemplate={handleEditTemplate}
                  onDuplicateTemplate={handleDuplicateTemplate}
                  onDeleteTemplate={handleDeleteTemplate}
                  isLoading={isLoading}
                  complexityReport={complexityReport}
                  showComplexityAnalysis={showComplexityAnalysis}
                  onToggleComplexityAnalysis={() => setShowComplexityAnalysis(!showComplexityAnalysis)}
                  isSmallScreen={isSmallScreen}
                />
              </div>
            )}

            {activeTab === 'create' && (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-200">
                {useRealTimeEditor && editingTemplate ? (
                  <ErrorBoundary>
                    <RealTimeTemplateEditor
                      template={editingTemplate}
                      onSave={async (templateData) => {
                        try {
                          await templateManager.createTemplate(templateData);
                          setActiveTab('browse');
                          setEditingTemplate(null);
                          setError(null);
                        } catch (err: unknown) {
                          logError('Create template failed', err);
                          setError(formatErrorMessage(t('template.create_failed'), err));
                        }
                      }}
                      onCancel={() => {
                        setActiveTab('browse');
                        setEditingTemplate(null);
                      }}
                    />
                  </ErrorBoundary>
                ) : (
                  <TemplateEditor
                    template={editingTemplate}
                    mode="create"
                    onSave={async (templateData) => {
                      try {
                        await templateManager.createTemplate(templateData);
                        setActiveTab('browse');
                        setEditingTemplate(null);
                        setError(null);
                      } catch (err: unknown) {
                        logError('Create template failed', err);
                        setError(formatErrorMessage(t('template.create_failed'), err));
                      }
                    }}
                    onCancel={() => {
                      setActiveTab('browse');
                      setEditingTemplate(null);
                    }}
                  />
                )}
              </div>
            )}

            {activeTab === 'edit' && editingTemplate && (
              <div className="animate-in fade-in slide-in-from-bottom-2 duration-200">
                {useRealTimeEditor ? (
                  <ErrorBoundary>
                    <RealTimeTemplateEditor
                      template={editingTemplate}
                      onSave={async (templateData) => {
                        try {
                          await templateManager.updateTemplate(editingTemplate.id, templateData);
                          setActiveTab('browse');
                          setEditingTemplate(null);
                          setError(null);
                        } catch (err: unknown) {
                          logError('Update template failed', err);
                          setError(formatErrorMessage(t('template.update_failed'), err));
                        }
                      }}
                      onCancel={() => {
                        setActiveTab('browse');
                        setEditingTemplate(null);
                      }}
                    />
                  </ErrorBoundary>
                ) : (
                  <TemplateEditor
                    template={editingTemplate}
                    mode="edit"
                    onSave={async (templateData) => {
                      try {
                        await templateManager.updateTemplate(editingTemplate.id, templateData);
                        setActiveTab('browse');
                        setEditingTemplate(null);
                        setError(null);
                      } catch (err: unknown) {
                        logError('Update template failed', err);
                        setError(formatErrorMessage(t('template.update_failed'), err));
                      }
                    }}
                    onCancel={() => {
                      setActiveTab('browse');
                      setEditingTemplate(null);
                    }}
                  />
                )}
              </div>
            )}
          </CustomScrollArea>
        </main>
    </div>
  );

  // ===== 移动端布局：MobileSlidingLayout =====
  if (isSmallScreen) {
    return (
      <>
        <div className="absolute inset-0 overflow-hidden bg-background flex flex-col">
          <MobileSlidingLayout
            sidebar={
              <div
                className="h-full flex flex-col bg-background"
                style={{
                  paddingBottom: `calc(var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)) + ${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px)`,
                }}
              >
                {renderSidebar()}
              </div>
            }
            sidebarOpen={sidebarOpen}
            onSidebarOpenChange={setSidebarOpen}
            enableGesture={true}
            threshold={0.3}
            className="flex-1"
          >
            {renderMainContent()}
          </MobileSlidingLayout>
        </div>
        {importExternalDialog}
      </>
    );
  }

  // ===== 桌面端布局 =====
  return (
    <>
      <div className="w-full h-screen overflow-hidden bg-background flex flex-col">
        <div className="flex-1 flex overflow-hidden min-h-0">
          {renderSidebar()}
          {renderMainContent()}
        </div>
      </div>
      {importExternalDialog}
    </>
  );
};

// 模板浏览器组件
interface TemplateBrowserProps {
  templates: CustomAnkiTemplate[];
  selectedTemplate: CustomAnkiTemplate | null;
  searchTerm: string;
  onSearchChange: (term: string) => void;
  onSelectTemplate: (template: CustomAnkiTemplate) => void;
  onEditTemplate: (template: CustomAnkiTemplate) => void;
  onDuplicateTemplate: (template: CustomAnkiTemplate) => void;
  onDeleteTemplate: (template: CustomAnkiTemplate) => void;
  isLoading: boolean;
  complexityReport: ComplexityReport | null;
  showComplexityAnalysis: boolean;
  onToggleComplexityAnalysis: () => void;
  isSmallScreen?: boolean;
}

const TemplateBrowser: React.FC<TemplateBrowserProps> = ({
  templates,
  selectedTemplate,
  searchTerm,
  onSearchChange,
  onSelectTemplate,
  onEditTemplate,
  onDuplicateTemplate,
  onDeleteTemplate,
  isLoading,
  complexityReport,
  showComplexityAnalysis,
  onToggleComplexityAnalysis,
  isSmallScreen = false
}) => {
  const { t } = useTranslation();
  return (
    <div className={`template-browser ${isSmallScreen ? 'mobile' : ''}`}>
      {/* 搜索和工具栏 */}
      <div className="browser-toolbar">
        <div className="search-box">
          <input
            type="text"
            placeholder={t('template.search_placeholder')}
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            className="search-input"
          />
          <span className="search-icon">
            <Search size={16} />
          </span>
        </div>
        <div className="toolbar-actions">
          {selectedTemplate && (
            <NotionButton
              variant="ghost"
              size="sm"
              className="btn-analysis"
              onClick={onToggleComplexityAnalysis}
              title={t('template.complexity_analysis')}
            >
              <Settings size={16} />
              {t('template.analyze_complexity')}
            </NotionButton>
          )}
          <div className="toolbar-info">
            {t('template.total_templates', { count: templates.length })}
          </div>
        </div>
      </div>

      {/* 复杂度分析面板 */}
      {showComplexityAnalysis && selectedTemplate && complexityReport && (
        <ComplexityAnalysisPanel
          report={complexityReport}
          templateName={selectedTemplate.name}
          onClose={onToggleComplexityAnalysis}
        />
      )}

      {/* 模板网格 */}
      {isLoading ? (
        <div className="loading-state">
          <div className="loading-spinner"></div>
          <span>{t('template.loading_text')}</span>
        </div>
      ) : (
        <div className="templates-grid" style={isSmallScreen ? { padding: 0, gap: 0 } : undefined}>
          {templates.map(template => (
            <TemplateCard
              key={template.id}
              template={template}
              isSelected={selectedTemplate?.id === template.id}
              onSelect={() => onSelectTemplate(template)}
              onEdit={() => onEditTemplate(template)}
              onDuplicate={() => onDuplicateTemplate(template)}
              onDelete={() => onDeleteTemplate(template)}
              isSmallScreen={isSmallScreen}
            />
          ))}
        </div>
      )}

      {templates.length === 0 && !isLoading && (
        <div className="empty-state">
          <div className="empty-icon">
            <FileText size={48} />
          </div>
          <h3>{t('template.empty_title')}</h3>
          <p>{t('template.empty_description')}</p>
        </div>
      )}
    </div>
  );
};

// 模板卡片组件
interface TemplateCardProps {
  template: CustomAnkiTemplate;
  isSelected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onDuplicate: () => void;
  onDelete: () => void;
  isSmallScreen?: boolean;
}

const TemplateCard: React.FC<TemplateCardProps> = ({
  template,
  isSelected,
  onSelect,
  onEdit,
  onDuplicate,
  onDelete,
  isSmallScreen = false
}) => {
  const { t } = useTranslation();
  const normalizedTemplate = templateService.ensureFieldExtractionRules(template);
  const cardTemplate = templateManager.toAnkiCardTemplate(normalizedTemplate);
  
  // 分析模板复杂度
  const complexityReport = templateService.analyzeComplexity(normalizedTemplate);
  
  const getComplexityColor = (level: ComplexityLevel): string => {
    switch (level) {
      case ComplexityLevel.Simple: return 'hsl(var(--success))';
      case ComplexityLevel.Moderate: return 'hsl(var(--warning))';
      case ComplexityLevel.Complex: return 'hsl(var(--danger))';
      case ComplexityLevel.VeryComplex: return 'hsl(var(--danger-muted))';
      default: return 'hsl(var(--muted-foreground))';
    }
  };
  
  const getComplexityText = (level: ComplexityLevel): string => {
    const levelMap: Record<ComplexityLevel, string> = {
      [ComplexityLevel.Simple]: t('template.complexity_simple'),
      [ComplexityLevel.Moderate]: t('template.complexity_moderate'),
      [ComplexityLevel.Complex]: t('template.complexity_complex'),
      [ComplexityLevel.VeryComplex]: t('template.complexity_very_complex')
    };
    return levelMap[level] || level;
  };

  // 移动端卡片样式 - 直接判断是否在移动端布局中
  // 通过检查父元素是否有 .mobile 类或者窗口宽度来判断
  const isMobileLayout = isSmallScreen || (typeof window !== 'undefined' && window.innerWidth < 768);
  const mobileCardStyle: React.CSSProperties | undefined = isMobileLayout ? {
    borderRadius: 0,
    borderLeft: 'none',
    borderRight: 'none',
    margin: 0,
    padding: '16px 12px',
  } : undefined;

  return (
    <div
      className={`template-card ${isSelected ? 'selected' : ''} ${!template.is_active ? 'inactive' : ''}`}
      style={mobileCardStyle}
    >
      {/* 卡片头部 */}
      <div className="card-header">
        <h4 className="template-name">{template.name}</h4>
        <div className="template-badges">
          {template.is_built_in && <span className="badge built-in">{t('template.builtin_badge')}</span>}
          {!template.is_active && <span className="badge inactive">{t('template.inactive_badge')}</span>}
          <span className="badge version">v{template.version}</span>
          {complexityReport && (
            <span 
              className="badge complexity"
              style={{ 
                backgroundColor: getComplexityColor(complexityReport.level) + '20',
                color: getComplexityColor(complexityReport.level),
                border: `1px solid ${getComplexityColor(complexityReport.level)}`
              }}
              title={`${t('template.complexity_score')}: ${complexityReport.score}`}
            >
              {getComplexityText(complexityReport.level)}
            </span>
          )}
        </div>
      </div>

      {/* 预览区域 */}
      <div className="card-preview">
        <div className="preview-front">
          <div className="preview-label">{t('template.front_label')}</div>
          <div className="preview-content">
            <IframePreview
              htmlContent={renderCardPreview(cardTemplate.front_template, cardTemplate, undefined, false)}
              cssContent={cardTemplate.css_style}
            />
          </div>
        </div>
        <div className="preview-back">
          <div className="preview-label">{t('template.back_label')}</div>
          <div className="preview-content">
            <IframePreview
              htmlContent={renderCardPreview(cardTemplate.back_template, cardTemplate, undefined, true)}
              cssContent={cardTemplate.css_style}
            />
          </div>
        </div>
      </div>

      {/* 卡片信息 */}
      <div className="card-info">
        <p className="template-description">{template.description}</p>
        <div className="template-meta">
          <span className="author" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <User size={14} />
            {template.author || t('template.author_unknown')}
          </span>
          <span className="fields" style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
            <FileText size={14} />
            {t('template.fields_count', { count: template.fields.length })}
          </span>
        </div>
        <div className="template-fields">
          {template.fields.slice(0, 3).map(field => (
            <span key={field} className="field-tag">{field}</span>
          ))}
          {template.fields.length > 3 && (
            <span className="field-tag more">{t('template.field_more', { count: template.fields.length - 3 })}</span>
          )}
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="card-actions">
        <NotionButton variant={isSelected ? 'primary' : 'default'} size="sm" onClick={onSelect} className="btn-select" style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          {isSelected ? (
            <>
              <CheckCircle size={16} />
              {t('template.selected_button')}
            </>
          ) : (
            t('template.select_button')
          )}
        </NotionButton>
        <div className="action-menu">
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onEdit} className="btn-action" aria-label="edit">
            <Edit size={16} />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onDuplicate} className="btn-action" aria-label="duplicate">
            <Copy size={16} />
          </NotionButton>
          <NotionButton variant="ghost" size="icon" iconOnly onClick={onDelete} className="btn-action danger" aria-label="delete">
            <Trash2 size={16} />
          </NotionButton>
        </div>
      </div>
    </div>
  );
};

// 模板编辑器组件（简化版，完整版需要更多功能）
interface TemplateEditorProps {
  template: CustomAnkiTemplate | null;
  mode: 'create' | 'edit';
  onSave: (templateData: CreateTemplateRequest) => Promise<void>;
  onCancel: () => void;
}

const TemplateEditor: React.FC<TemplateEditorProps> = ({
  template,
  mode,
  onSave,
  onCancel
}) => {
  const { t } = useTranslation();
  const [formData, setFormData] = useState({
    name: template?.name || '',
    description: template?.description || '',
    author: template?.author || '',
    preview_front: template?.preview_front || '',
    preview_back: template?.preview_back || '',
    note_type: template?.note_type || 'Basic',
    fields: template?.fields.join(',') || 'Front,Back,Notes',
    generation_prompt: template?.generation_prompt || '',
    front_template: template?.front_template || '<div class="card">{{Front}}</div>',
    back_template: template?.back_template || '<div class="card">{{Front}}<hr>{{Back}}</div>',
    css_style: template?.css_style || '.card { padding: 20px; background: white; border-radius: 8px; }'
  });

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeEditorTab, setActiveEditorTab] = useState<'basic' | 'templates' | 'styles' | 'advanced'>('basic');
  const [isAdvancedMode, setIsAdvancedMode] = useState(false);
  const [fieldExtractionRules, setFieldExtractionRules] = useState<Record<string, EnhancedFieldExtractionRule>>(
    (template?.field_extraction_rules as unknown as Record<string, EnhancedFieldExtractionRule>) || {}
  );
  const [showJsonEditor, setShowJsonEditor] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSubmitting(true);
    
    try {
      const fields = formData.fields.split(',').map(f => f.trim()).filter(f => f);
      
      // 使用当前的字段提取规则（由 FieldTypeConfigurator 管理）
      const rulesForSubmit = isAdvancedMode ? fieldExtractionRules : {};
      
      if (!isAdvancedMode) {
        // 基础模式：自动生成简单规则
        fields.forEach(field => {
          if (!rulesForSubmit[field]) {
            rulesForSubmit[field] = {
              field_type: (field.toLowerCase() === 'tags' ? 'array' : 'text') as any,
              is_required: field.toLowerCase() === 'front' || field.toLowerCase() === 'back',
              default_value: field.toLowerCase() === 'tags' ? [] : '',
              description: t('template.field_description', { field })
            };
          }
        });
      }

      const templateData: CreateTemplateRequest = {
        name: formData.name,
        description: formData.description,
        author: formData.author || undefined,
        preview_front: formData.preview_front,
        preview_back: formData.preview_back,
        note_type: formData.note_type,
        fields,
        generation_prompt: formData.generation_prompt,
        front_template: formData.front_template,
        back_template: formData.back_template,
        css_style: formData.css_style,
        field_extraction_rules: rulesForSubmit as any
      };

      await onSave(templateData);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="template-editor">
      <div className="editor-header">
        <h3>{mode === 'create' ? t('template.editor_title_create') : t('template.editor_title_edit')}</h3>
      </div>

      {/* 编辑器标签页 */}
      <div className="editor-tabs">
        <NotionButton variant="ghost" size="sm" className={`editor-tab ${activeEditorTab === 'basic' ? 'active' : ''}`} onClick={() => setActiveEditorTab('basic')} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <FileText size={16} />
          {t('template.editor_tab_basic')}
        </NotionButton>
        <NotionButton variant="ghost" size="sm" className={`editor-tab ${activeEditorTab === 'templates' ? 'active' : ''}`} onClick={() => setActiveEditorTab('templates')} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Palette size={16} />
          {t('template.editor_tab_templates')}
        </NotionButton>
        <NotionButton variant="ghost" size="sm" className={`editor-tab ${activeEditorTab === 'styles' ? 'active' : ''}`} onClick={() => setActiveEditorTab('styles')} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Paintbrush size={16} />
          {t('template.editor_tab_styles')}
        </NotionButton>
        <NotionButton variant="ghost" size="sm" className={`editor-tab ${activeEditorTab === 'advanced' ? 'active' : ''}`} onClick={() => setActiveEditorTab('advanced')} style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <Settings size={16} />
          {t('template.editor_tab_advanced')}
        </NotionButton>
      </div>

      <form onSubmit={handleSubmit} className="editor-form">
        {/* 基本信息标签页 */}
        {activeEditorTab === 'basic' && (
          <div className="editor-section">
            <div className="form-grid">
              <div className="form-group">
                <label>{t('template.form_name_required')}</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({...formData, name: e.target.value})}
                  required
                  className="form-input"
                  placeholder={t('template.form_name_placeholder')}
                />
              </div>

              <div className="form-group">
                <label>{t('template.form_author')}</label>
                <input
                  type="text"
                  value={formData.author}
                  onChange={(e) => setFormData({...formData, author: e.target.value})}
                  className="form-input"
                  placeholder={t('template.form_author_placeholder')}
                />
              </div>

              <div className="form-group full-width">
                <label>{t('template.form_description')}</label>
                <textarea
                  value={formData.description}
                  onChange={(e) => setFormData({...formData, description: e.target.value})}
                  className="form-textarea"
                  rows={3}
                  placeholder={t('template.form_description_placeholder')}
                />
              </div>

              <div className="form-group">
                <label>{t('template.form_note_type')}</label>
                <input
                  type="text"
                  value={formData.note_type}
                  onChange={(e) => setFormData({...formData, note_type: e.target.value})}
                  className="form-input"
                  placeholder={t('template.form_note_type_placeholder')}
                />
              </div>

              <div className="form-group">
                <label>{t('template.form_fields_required')}</label>
                <input
                  type="text"
                  value={formData.fields}
                  onChange={(e) => setFormData({...formData, fields: e.target.value})}
                  required
                  className="form-input"
                  placeholder={t('template.form_fields_placeholder')}
                />
                <small className="form-help">{t('template.form_fields_help')}</small>
              </div>

              <div className="form-group">
                <label>{t('template.form_preview_front_required')}</label>
                <input
                  type="text"
                  value={formData.preview_front}
                  onChange={(e) => setFormData({...formData, preview_front: e.target.value})}
                  required
                  className="form-input"
                  placeholder={t('template.form_preview_front_placeholder')}
                />
              </div>

              <div className="form-group">
                <label>{t('template.form_preview_back_required')}</label>
                <input
                  type="text"
                  value={formData.preview_back}
                  onChange={(e) => setFormData({...formData, preview_back: e.target.value})}
                  required
                  className="form-input"
                  placeholder={t('template.form_preview_back_placeholder')}
                />
              </div>
            </div>
          </div>
        )}

        {/* 模板代码标签页 */}
        {activeEditorTab === 'templates' && (
          <div className="editor-section">
            <div className="template-code-editor">
              <div className="code-group">
                <label>{t('template.form_front_template_required')}</label>
                <textarea
                  value={formData.front_template}
                  onChange={(e) => setFormData({...formData, front_template: e.target.value})}
                  required
                  className="code-textarea"
                  rows={8}
                  placeholder="<div class=&quot;card&quot;>&#123;&#123;Front&#125;&#125;</div>"
                />
                <small className="form-help">{t('template.form_template_help')}</small>
              </div>

              <div className="code-group">
                <label>{t('template.form_back_template_required')}</label>
                <textarea
                  value={formData.back_template}
                  onChange={(e) => setFormData({...formData, back_template: e.target.value})}
                  required
                  className="code-textarea"
                  rows={8}
                  placeholder="<div class=&quot;card&quot;>&#123;&#123;Front&#125;&#125;<hr>&#123;&#123;Back&#125;&#125;</div>"
                />
              </div>
            </div>
          </div>
        )}

        {/* 样式设计标签页 */}
        {activeEditorTab === 'styles' && (
          <div className="editor-section">
            <div className="styles-editor">
              <label>{t('template.form_css_style')}</label>
              <textarea
                value={formData.css_style}
                onChange={(e) => setFormData({...formData, css_style: e.target.value})}
                className="css-textarea"
                rows={12}
                placeholder=".card { padding: 20px; background: white; border-radius: 8px; }"
              />
              <small className="form-help">{t('template.form_css_help')}</small>
            </div>
          </div>
        )}

        {/* 高级设置标签页 */}
        {activeEditorTab === 'advanced' && (
          <div className="editor-section">
            <div className="advanced-settings">
              <label>{t('template.form_generation_prompt_required')}</label>
              <textarea
                value={formData.generation_prompt}
                onChange={(e) => setFormData({...formData, generation_prompt: e.target.value})}
                required
                className="prompt-textarea"
                rows={8}
                placeholder={t('template.form_generation_prompt_placeholder')}
              />
              <small className="form-help">{t('template.form_generation_prompt_help')}</small>

              {/* 字段提取规则高级编辑 */}
              <div className="field-extraction-rules-section" style={{ marginTop: '20px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
                  <label>{t('template.field_extraction_rules')}</label>
                  <label style={{ display: 'flex', alignItems: 'center', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={isAdvancedMode}
                      onChange={(e) => setIsAdvancedMode(e.target.checked)}
                      style={{ marginRight: '5px' }}
                    />
                    {t('template.advanced_mode')}
                  </label>
                </div>
                
                {isAdvancedMode ? (
                  <>
                    <FieldTypeConfigurator
                      fields={formData.fields.split(',').map(f => f.trim()).filter(f => f)}
                      rules={fieldExtractionRules}
                      onChange={setFieldExtractionRules}
                    />
                    
                    {/* 可选的JSON编辑模式 */}
                    <div style={{ marginTop: '16px', textAlign: 'right' }}>
                      <NotionButton variant="ghost" size="sm" onClick={() => setShowJsonEditor(!showJsonEditor)} className="json-toggle-btn" style={{ fontSize: '12px' }}>
                        {showJsonEditor ? t('template.hide_json_editor') : t('template.show_json_editor')}
                      </NotionButton>
                    </div>
                    
                    {showJsonEditor ? (
                      <>
                        <textarea
                          value={JSON.stringify(fieldExtractionRules, null, 2)}
                          onChange={(e) => {
                            try {
                              const parsed = JSON.parse(e.target.value);
                              setFieldExtractionRules(parsed);
                            } catch (err: unknown) {
                              // 忽略解析错误，让用户继续编辑
                            }
                          }}
                          className="json-editor"
                          rows={10}
                          style={{
                            marginTop: '8px',
                            fontFamily: 'monospace',
                            fontSize: '13px',
                            backgroundColor: 'hsl(var(--muted))',
                            border: '1px solid hsl(var(--border))',
                            borderRadius: '4px',
                            padding: '10px',
                            width: '100%'
                          }}
                          placeholder={JSON.stringify({
                            "Front": {
                              "field_type": "Text",
                              "is_required": true,
                            "default_value": "",
                            "description": "Card front content"
                          }
                        }, null, 2)}
                      />
                      <small className="form-help">{t('template.field_extraction_json_help')}</small>
                    </>
                  ) : (
                    <small className="form-help">{t('template.field_extraction_auto_help')}</small>
                  )}
                </>
                ) : (
                  <small className="form-help">{t('template.field_extraction_simple_help')}</small>
                )}
              </div>
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="editor-actions">
          <NotionButton variant="primary" size="sm" type="submit" disabled={isSubmitting} className="btn-primary">
            {isSubmitting ? t('template.submit_creating') : mode === 'create' ? t('template.submit_create') : t('template.submit_save')}
          </NotionButton>
          <NotionButton variant="default" size="sm" onClick={onCancel} className="btn-secondary">
            {t('template.cancel_button')}
          </NotionButton>
        </div>
      </form>
    </div>
  );
};

// 复杂度分析面板组件
interface ComplexityAnalysisPanelProps {
  report: ComplexityReport;
  templateName: string;
  onClose: () => void;
}

const ComplexityAnalysisPanel: React.FC<ComplexityAnalysisPanelProps> = ({
  report,
  templateName,
  onClose
}) => {
  const { t } = useTranslation();
  
  const getLevelText = (level: ComplexityLevel): string => {
    const levelMap: Record<ComplexityLevel, string> = {
      [ComplexityLevel.Simple]: t('template.complexity_simple'),
      [ComplexityLevel.Moderate]: t('template.complexity_moderate'),
      [ComplexityLevel.Complex]: t('template.complexity_complex'),
      [ComplexityLevel.VeryComplex]: t('template.complexity_very_complex')
    };
    return levelMap[level] || level;
  };
  
  const getLevelColor = (level: ComplexityLevel): string => {
    switch (level) {
      case ComplexityLevel.Simple: return 'hsl(var(--success))';
      case ComplexityLevel.Moderate: return 'hsl(var(--warning))';
      case ComplexityLevel.Complex: return 'hsl(var(--danger))';
      case ComplexityLevel.VeryComplex: return 'hsl(var(--danger-muted))';
      default: return 'hsl(var(--muted-foreground))';
    }
  };
  
  const getSeverityColor = (severity: 'low' | 'medium' | 'high'): string => {
    switch (severity) {
      case 'low': return 'hsl(var(--info))';
      case 'medium': return 'hsl(var(--warning))';
      case 'high': return 'hsl(var(--danger))';
      default: return 'hsl(var(--muted-foreground))';
    }
  };
  
  return (
    <div className="complexity-analysis-panel">
      <div className="panel-header">
        <h3>{t('template.complexity_analysis_title')}: {templateName}</h3>
        <NotionButton variant="ghost" size="icon" iconOnly onClick={onClose} className="close-btn" aria-label="close">
          <X size={16} />
        </NotionButton>
      </div>
      
      <div className="panel-content">
        {/* 总体评分 */}
        <div className="complexity-score">
          <div className="score-circle" style={{ borderColor: getLevelColor(report.level) }}>
            <div className="score-value">{report.score}</div>
            <div className="score-label">{t('template.complexity_score')}</div>
          </div>
          <div className="score-details">
            <div className="complexity-level" style={{ color: getLevelColor(report.level) }}>
              {getLevelText(report.level)}
            </div>
            <div className="success-rate">
              {t('template.estimated_success_rate')}: {Math.round(report.estimated_success_rate * 100)}%
            </div>
            {report.recommended_downgrade && (
              <div className="downgrade-warning">
                <AlertTriangle size={16} />
                {t('template.recommend_simplify')}
              </div>
            )}
          </div>
        </div>
        
        {/* 问题列表 */}
        {report.issues.length > 0 && (
          <div className="issues-section">
            <h4>{t('template.detected_issues')}</h4>
            <div className="issues-list">
              {report.issues.map((issue, index) => (
                <div key={index} className="issue-item" style={{ borderLeftColor: getSeverityColor(issue.severity) }}>
                  <span className="issue-severity" style={{ color: getSeverityColor(issue.severity) }}>
                    [{t(`template.severity_${issue.severity}`)}]
                  </span>
                  <span className="issue-message">{issue.message}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        
        {/* 优化建议 */}
        {report.suggestions.length > 0 && (
          <div className="suggestions-section">
            <h4>{t('template.optimization_suggestions')}</h4>
            <ul className="suggestions-list">
              {report.suggestions.map((suggestion, index) => (
                <li key={index}>{suggestion}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
};

export default TemplateManager;

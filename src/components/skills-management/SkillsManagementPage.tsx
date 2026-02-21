/**
 * SkillsManagementPage - 技能管理页面
 *
 * 卡片网格布局，顶部工具栏包含搜索和筛选功能
 */

import React, { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { LayoutGroup } from 'framer-motion';
import {
  Upload,
  Download,
  Plus,
  RotateCcw,
  Search,
  Zap,
  Globe,
  FolderOpen,
  Package,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { NotionButton } from '@/components/ui/NotionButton';
import { NotionAlertDialog } from '../ui/NotionDialog';
import { showGlobalNotification } from '../UnifiedNotification';
import { useMobileHeader, MobileSlidingLayout, ScreenPosition } from '@/components/layout';
import { MOBILE_LAYOUT } from '@/config/mobileLayout';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { fileManager } from '@/utils/fileManager';

// Skills 模块
import {
  skillRegistry,
  subscribeToSkillRegistry,
  reloadSkills,
  createSkill,
  updateSkill,
  deleteSkill,
  serializeSkillToMarkdown,
  saveBuiltinSkillCustomization,
  resetBuiltinSkillCustomization,
  parseSkillFile,
  useSkillDefaults,
} from '@/chat-v2/skills';
import type { SkillDefinition, SkillLocation } from '@/chat-v2/skills/types';
import { getLocalizedSkillDescription, getLocalizedSkillName } from '@/chat-v2/skills/utils';

// 子组件
import { SkillsList } from './SkillsList';
import { SkillEditorModal, type SkillFormData } from './SkillEditorModal';
import { SkillFullscreenEditor } from './SkillFullscreenEditor';
import './SkillFullscreenEditor.css';
import { SkillDeleteConfirm } from './SkillDeleteConfirm';

// ============================================================================
// 类型定义
// ============================================================================

interface SkillsManagementPageProps {
  className?: string;
}

// ============================================================================
// 常量
// ============================================================================

/** 全局技能目录路径 */
const GLOBAL_SKILLS_PATH = '~/.deep-student/skills';

// ============================================================================
// 组件
// ============================================================================

export const SkillsManagementPage: React.FC<SkillsManagementPageProps> = ({
  className,
}) => {
  const { t } = useTranslation(['skills', 'common']);

  // ========== 响应式布局 ==========
  const { isSmallScreen } = useBreakpoint();
  const [screenPosition, setScreenPosition] = useState<ScreenPosition>('center');
  const [rightPanelOpen, setRightPanelOpen] = useState(false);

  // ========== 状态 ==========
  const [registryVersion, setRegistryVersion] = useState(0);
  const [isLoading, setIsLoading] = useState(false);

  // 搜索和筛选状态
  const [searchQuery, setSearchQuery] = useState('');
  const [locationFilter, setLocationFilter] = useState<'all' | SkillLocation>('all');

  // 当前选中的技能（用于列表高亮）
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  // 默认启用的技能（使用持久化的 Hook）
  const { defaultIds: defaultSkillIds, toggleDefault } = useSkillDefaults();

  // 编辑器状态
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingSkill, setEditingSkill] = useState<SkillDefinition | null>(null);
  const [editorLocation, setEditorLocation] = useState<SkillLocation>('global');

  // 删除确认状态
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<SkillDefinition | null>(null);

  // 导入覆盖确认状态
  const [importOverwriteOpen, setImportOverwriteOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ content: string; skill: SkillDefinition } | null>(null);

  // 卡片位置（用于全屏编辑器动画）
  const [editOriginRect, setEditOriginRect] = useState<DOMRect | null>(null);
  const cardRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());

  // 检测主题（通过 MutationObserver 监听 DOM class 变化，确保跨组件主题切换实时响应）
  const [isDarkMode, setIsDarkMode] = useState(() =>
    typeof document !== 'undefined' && document.documentElement.classList.contains('dark')
  );
  useEffect(() => {
    const el = document.documentElement;
    const observer = new MutationObserver(() => {
      setIsDarkMode(el.classList.contains('dark'));
    });
    observer.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => observer.disconnect();
  }, []);

  // ========== 订阅 Registry 更新 ==========
  useEffect(() => {
    const unsubscribe = subscribeToSkillRegistry(() => {
      setRegistryVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  // ========== 监听 screenPosition 变化，同步编辑器状态 ==========
  // 当用户通过手势滑动从编辑器返回时，清除编辑器状态
  useEffect(() => {
    // 仅在移动端滑动布局下同步关闭右侧编辑器，避免桌面端意外闪闭
    if (!isSmallScreen) return;
    if (screenPosition !== 'right' && (editorOpen || rightPanelOpen)) {
      setEditorOpen(false);
      setRightPanelOpen(false);
    }
  }, [isSmallScreen, screenPosition, editorOpen, rightPanelOpen]);

  // ========== 获取技能列表 ==========
  const allSkills = useMemo(() => {
    return skillRegistry.getAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryVersion]);

  // 如果当前选中项已不存在，清空选中
  useEffect(() => {
    if (!selectedSkillId) return;
    if (!allSkills.find(s => s.id === selectedSkillId)) {
      setSelectedSkillId(null);
    }
  }, [allSkills, selectedSkillId]);

  // 默认启用的技能列表
  const defaultSkills = useMemo(() => {
    return allSkills.filter(s => defaultSkillIds.includes(s.id));
  }, [allSkills, defaultSkillIds]);

  // 技能摘要
  const skillSummary = useMemo(() => ({
    total: allSkills.length,
    global: allSkills.filter(s => s.location === 'global').length,
    project: allSkills.filter(s => s.location === 'project').length,
    builtin: allSkills.filter(s => s.location === 'builtin').length,
  }), [allSkills]);

  // ========== 操作回调 ==========

  // 刷新
  const handleRefresh = useCallback(async () => {
    setIsLoading(true);
    try {
      await reloadSkills();
      showGlobalNotification(
        'success',
        t('skills:management.refresh_success', '技能列表已刷新')
      );
    } catch (error) {
      console.error('[SkillsManagement] 刷新失败:', error);
      showGlobalNotification(
        'error',
        t('skills:management.refresh_failed', '刷新失败')
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // 打开创建编辑器
  const handleCreate = useCallback(() => {
    setEditingSkill(null);
    setEditorLocation('global');
    setSelectedSkillId(null);
    setEditOriginRect(null); // 创建时没有原始位置
    setEditorOpen(true);
    // 移动端时切换到右侧面板
    if (isSmallScreen) {
      setRightPanelOpen(true);
      setScreenPosition('right');
    }
  }, [isSmallScreen]);

  // 打开编辑器
  const handleEdit = useCallback((skill: SkillDefinition, cardRect?: DOMRect) => {
    setEditingSkill(skill);
    setEditorLocation(skill.location);
    setSelectedSkillId(skill.id);
    
    // 桌面端使用全屏编辑器
    if (!isSmallScreen) {
      // 如果没有传入 cardRect，尝试从 ref map 获取
      if (!cardRect) {
        const cardEl = cardRefsMap.current.get(skill.id);
        if (cardEl) {
          cardRect = cardEl.getBoundingClientRect();
        }
      }
      setEditOriginRect(cardRect || null);
    }
    
    setEditorOpen(true);
    // 移动端时切换到右侧面板
    if (isSmallScreen) {
      setRightPanelOpen(true);
      setScreenPosition('right');
    }
  }, [isSmallScreen]);

  // 打开删除确认
  const handleDelete = useCallback((skill: SkillDefinition) => {
    setSkillToDelete(skill);
    setDeleteConfirmOpen(true);
  }, []);

  // 选择技能
  const handleSelectSkill = useCallback((skillId: string | null) => {
    if (skillId) {
      setSelectedSkillId(skillId);
    }
  }, []);

  // 切换默认启用状态
  const handleToggleDefault = useCallback((skill: SkillDefinition) => {
    toggleDefault(skill.id);
  }, [toggleDefault]);

  // 保存技能
  const handleSave = useCallback(async (data: SkillFormData) => {
    const isEdit = Boolean(editingSkill);
    const isBuiltinSkill = editingSkill?.isBuiltin === true;

    if (isEdit && editingSkill) {
      if (isBuiltinSkill) {
        // 内置技能：保存自定义到数据库
        const customization = {
          name: data.name,
          description: data.description,
          version: data.version || undefined,
          author: data.author || undefined,
          priority: data.priority,
          disableAutoInvoke: data.disableAutoInvoke,
          skillType: data.skillType,
          relatedSkills: data.relatedSkills,
          dependencies: data.dependencies,
          content: data.content,
          embeddedTools: data.embeddedTools,
        };
        await saveBuiltinSkillCustomization(editingSkill.id, customization);
        showGlobalNotification(
          'success',
          t('skills:management.builtin_save_success', '内置技能自定义已保存')
        );
      } else {
        // 用户技能：更新文件系统
        const content = serializeSkillToMarkdown(
          {
            name: data.name,
            description: data.description,
            version: data.version || undefined,
            author: data.author || undefined,
            priority: data.priority,
            disableAutoInvoke: data.disableAutoInvoke,
            skillType: data.skillType,
            relatedSkills: data.relatedSkills,
            dependencies: data.dependencies,
            embeddedTools: data.embeddedTools,
          },
          data.content
        );
        const skillFilePath = editingSkill.sourcePath;
        await updateSkill({ path: skillFilePath, content });
        showGlobalNotification(
          'success',
          t('skills:management.save_success', '技能保存成功')
        );
      }
    } else {
      // 创建新技能（只能创建用户技能）
      const content = serializeSkillToMarkdown(
        {
          name: data.name,
          description: data.description,
          version: data.version || undefined,
          author: data.author || undefined,
          priority: data.priority,
          disableAutoInvoke: data.disableAutoInvoke,
          skillType: data.skillType,
          relatedSkills: data.relatedSkills,
          dependencies: data.dependencies,
          embeddedTools: data.embeddedTools,
        },
        data.content
      );
      await createSkill({
        basePath: GLOBAL_SKILLS_PATH,
        skillId: data.id,
        content,
      });
      showGlobalNotification(
        'success',
        t('skills:management.create_success', '技能创建成功')
      );
    }

    // 刷新列表
    await reloadSkills();
  }, [editingSkill, t]);

  // 恢复内置技能默认值
  const handleResetToDefault = useCallback(async (skill: SkillDefinition) => {
    if (!skill.isBuiltin) return;

    try {
      await resetBuiltinSkillCustomization(skill.id);
      showGlobalNotification(
        'success',
        t('skills:management.reset_success', '已恢复默认设置')
      );
      // 刷新列表
      await reloadSkills();
    } catch (error) {
      console.error('[SkillsManagement] 恢复默认失败:', error);
      showGlobalNotification(
        'error',
        t('skills:management.reset_failed', '恢复默认失败')
      );
    }
  }, [t]);

  // 确认删除
  const handleConfirmDelete = useCallback(async () => {
    if (!skillToDelete) return;

    // ★ 防御性检查：内置技能不可删除
    if (skillToDelete.isBuiltin) {
      console.warn('[SkillsManagement] 尝试删除内置技能，已阻止:', skillToDelete.id);
      showGlobalNotification(
        'error',
        t('skills:management.builtin_no_delete', '内置技能不可删除')
      );
      return;
    }

    // 获取技能目录路径（从 sourcePath 中提取）
    const dirPath = skillToDelete.sourcePath.replace(/\/SKILL\.md$/i, '');
    await deleteSkill(dirPath);

    showGlobalNotification(
      'success',
      t('skills:management.delete_success', '技能已删除')
    );

    // 刷新列表
    await reloadSkills();
  }, [skillToDelete, t]);

  // 切换右侧面板
  const toggleRightPanel = useCallback(() => {
    setRightPanelOpen(prev => !prev);
    setScreenPosition(prev => prev === 'right' ? 'center' : 'right');
  }, []);

  // 导出技能为 SKILL.md 文件
  const handleExport = useCallback(async (skill: SkillDefinition) => {
    const content = serializeSkillToMarkdown(
      {
        name: skill.name,
        description: skill.description,
        version: skill.version,
        author: skill.author,
        priority: skill.priority,
        disableAutoInvoke: skill.disableAutoInvoke,
        allowedTools: skill.allowedTools,
        embeddedTools: skill.embeddedTools,
        skillType: skill.skillType,
        relatedSkills: skill.relatedSkills,
        dependencies: skill.dependencies,
      },
      skill.content
    );

    try {
      const defaultName = `${skill.id}.SKILL.md`;
      const result = await fileManager.saveTextFile({
        title: defaultName,
        defaultFileName: defaultName,
        content,
        filters: [{ name: 'Markdown', extensions: ['md'] }],
      });
      if (!result.canceled) {
        showGlobalNotification(
          'success',
          t('skills:management.export_success', '技能已导出')
        );
      }
    } catch (e) {
      console.error('[SkillsManagement] Export failed:', e);
    }
  }, [t]);

  // 批量导出：逐个弹出保存对话框
  const handleExportAll = useCallback(async () => {
    const userSkills = allSkills.filter(s => !s.isBuiltin);
    if (userSkills.length === 0) {
      showGlobalNotification('info', t('skills:management.export_no_skills', '没有可导出的用户技能'));
      return;
    }

    let exportedCount = 0;
    for (const skill of userSkills) {
      const content = serializeSkillToMarkdown(
        {
          name: skill.name,
          description: skill.description,
          version: skill.version,
          author: skill.author,
          priority: skill.priority,
          disableAutoInvoke: skill.disableAutoInvoke,
          allowedTools: skill.allowedTools,
          embeddedTools: skill.embeddedTools,
          skillType: skill.skillType,
          relatedSkills: skill.relatedSkills,
          dependencies: skill.dependencies,
        },
        skill.content
      );

      try {
        const defaultName = `${skill.id}.SKILL.md`;
        const result = await fileManager.saveTextFile({
          title: defaultName,
          defaultFileName: defaultName,
          content,
          filters: [{ name: 'Markdown', extensions: ['md'] }],
        });
        if (!result.canceled) {
          exportedCount++;
        }
      } catch (e) {
        console.error(`[SkillsManagement] Export ${skill.id} failed:`, e);
      }
    }

    if (exportedCount > 0) {
      showGlobalNotification(
        'success',
        t('skills:management.export_all_success', '已导出 {{count}} 个技能', { count: exportedCount })
      );
    }
  }, [allSkills, t]);

  // 导入技能文件
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

const handleImportFile = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;

    let successCount = 0;
    let skipCount = 0;
    const errors: string[] = [];

    const MAX_SKILL_FILE_SIZE = 512 * 1024; // 512KB

    for (const file of Array.from(files)) {
      if (file.size > MAX_SKILL_FILE_SIZE) {
        errors.push(`${file.name}: exceeds 512KB limit`);
        continue;
      }

      try {
        const content = await file.text();
        // 🔧 从文件名提取 skillId 并清理非法字符
        const rawId = file.name.replace(/\.SKILL\.md$/i, '').replace(/\.md$/i, '');
        // 将非法字符（非字母数字连字符下划线）替换为连字符，并去除首尾连字符
        const skillId = rawId
          .toLowerCase()
          .replace(/[^a-z0-9\-_]/g, '-')
          .replace(/^-+|-+$/g, '')
          || 'imported-skill';
        
        const parseResult = parseSkillFile(content, '', skillId, 'global');
        
        if (!parseResult.success || !parseResult.skill) {
          errors.push(`${file.name}: ${parseResult.error}`);
          continue;
        }

        const existingSkill = skillRegistry.get(parseResult.skill.id);
        if (existingSkill) {
          if (files.length === 1) {
            setPendingImport({ content, skill: parseResult.skill });
            setImportOverwriteOpen(true);
            return;
          } else {
            skipCount++;
            continue;
          }
        }

        await createSkill({
          basePath: GLOBAL_SKILLS_PATH,
          skillId: parseResult.skill.id,
          content,
        });
        successCount++;
      } catch (error) {
        errors.push(`${file.name}: ${String(error)}`);
      }
    }

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }

    if (successCount > 0) {
      await reloadSkills();
    }

    if (files.length === 1) {
      if (successCount === 1) {
        showGlobalNotification('success', t('skills:management.import_success', '技能导入成功'));
      } else if (errors.length > 0) {
        showGlobalNotification('error', t('skills:management.import_failed', '导入失败: {{error}}', { error: errors[0] }));
      }
    } else {
      const message = t('skills:management.import_batch_result', '导入完成: {{success}} 成功, {{skip}} 跳过, {{fail}} 失败', {
        success: successCount,
        skip: skipCount,
        fail: errors.length,
      });
      showGlobalNotification(successCount > 0 ? 'success' : 'error', message);
    }
  }, [t]);

  const handleConfirmOverwrite = useCallback(async () => {
    if (!pendingImport) return;

    try {
      const existingSkill = skillRegistry.get(pendingImport.skill.id);
      if (existingSkill && !existingSkill.isBuiltin) {
        const skillFilePath = existingSkill.sourcePath;
        await updateSkill({ path: skillFilePath, content: pendingImport.content });
      } else {
        await createSkill({
          basePath: GLOBAL_SKILLS_PATH,
          skillId: pendingImport.skill.id,
          content: pendingImport.content,
        });
      }

      showGlobalNotification(
        'success',
        t('skills:management.import_overwrite_success', '技能 "{{name}}" 已覆盖', { name: pendingImport.skill.name })
      );
      await reloadSkills();
    } catch (error) {
      showGlobalNotification(
        'error',
        t('skills:management.import_failed', '导入失败: {{error}}', { error: String(error) })
      );
    } finally {
      setPendingImport(null);
      setImportOverwriteOpen(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }, [pendingImport, t]);

  const handleCancelOverwrite = useCallback(() => {
    setPendingImport(null);
    setImportOverwriteOpen(false);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  }, []);

  // ========== 移动端统一顶栏配置 ==========
  const headerTitle = useMemo(() => {
    if (isSmallScreen && !(screenPosition === 'right' && (editorOpen || rightPanelOpen))) {
      return t('skills:management.title', '技能管理');
    }
    // 右侧面板打开时显示编辑器标题
    if (screenPosition === 'right' && (editorOpen || rightPanelOpen)) {
      return editingSkill
        ? t('skills:management.edit', '编辑技能')
        : t('skills:management.create', '新建技能');
    }
    if (defaultSkills.length === 0) {
      return t('skills:management.title', '技能管理');
    }
    if (defaultSkills.length === 1) {
      return defaultSkills[0].name;
    }
    return t('skills:management.default_count', '{{count}} 个默认技能', { count: defaultSkills.length });
  }, [defaultSkills, t, screenPosition, editorOpen, rightPanelOpen, editingSkill, isSmallScreen]);

  const headerSubtitle = useMemo(() => {
    if (isSmallScreen) {
      return undefined;
    }
    // 右侧面板打开时不显示副标题
    if (screenPosition === 'right' && (editorOpen || rightPanelOpen)) {
      return undefined;
    }
    if (defaultSkills.length === 1) {
      return t(`skills:location.${defaultSkills[0].location}`, defaultSkills[0].location);
    }
    if (defaultSkills.length > 1) {
      return defaultSkills.map(s => s.name).join(', ');
    }
    return undefined;
  }, [defaultSkills, t, screenPosition, editorOpen, rightPanelOpen, isSmallScreen]);

  // 判断是否在编辑器视图
  const isEditorView = screenPosition === 'right' && (editorOpen || rightPanelOpen);

  useMobileHeader('skills-management', {
    title: headerTitle,
    subtitle: headerSubtitle,
    showMenu: !isEditorView,
    showBackArrow: isEditorView,
    suppressGlobalBackButton: !isEditorView,
    onMenuClick: isEditorView
      ? () => {
          setEditorOpen(false);
          setRightPanelOpen(false);
          setScreenPosition('center');
        }
      : undefined,
    rightActions: !isEditorView ? (
      <NotionButton variant="ghost" size="icon" iconOnly onClick={handleCreate} className="!p-1.5 hover:bg-accent text-muted-foreground hover:text-foreground" title={t('skills:management.create', '新建技能')} aria-label="create">
        <Plus className="w-5 h-5" />
      </NotionButton>
    ) : undefined,
  }, [headerTitle, headerSubtitle, isEditorView, handleCreate, t]);

  // ========== 位置筛选标签 ==========
  const locationTabs = useMemo(() => [
    { id: 'all' as const, label: t('skills:location.all', '全部'), icon: <Zap size={12} /> },
    { id: 'global' as const, label: t('skills:location.global', '全局'), icon: <Globe size={12} /> },
    { id: 'project' as const, label: t('skills:location.project', '项目'), icon: <FolderOpen size={12} /> },
    { id: 'builtin' as const, label: t('skills:location.builtin', '内置'), icon: <Package size={12} /> },
  ], [t]);

  const locationCounts = useMemo(() => ({
    all: allSkills.length,
    global: allSkills.filter(s => s.location === 'global').length,
    project: allSkills.filter(s => s.location === 'project').length,
    builtin: allSkills.filter(s => s.location === 'builtin').length,
  }), [allSkills]);

  // ========== 过滤技能列表 ==========
  const filteredSkills = useMemo(() => {
    let result = allSkills;
    if (locationFilter !== 'all') {
      result = result.filter(skill => skill.location === locationFilter);
    }
    const query = searchQuery.trim().toLowerCase();
    if (query) {
      result = result.filter(skill =>
        getLocalizedSkillName(skill.id, skill.name, t).toLowerCase().includes(query) ||
        getLocalizedSkillDescription(skill.id, skill.description, t).toLowerCase().includes(query) ||
        skill.id.toLowerCase().includes(query)
      );
    }
    return result;
  }, [allSkills, locationFilter, searchQuery, t]);

  // ========== 渲染主内容 ==========
  const renderMainContent = () => (
    <div className="flex-1 flex flex-col min-w-0 h-full overflow-hidden bg-background">
      <div className="flex-shrink-0 px-4 sm:px-6 py-3 border-b border-border/20 bg-background/50 backdrop-blur-sm sticky top-0 z-10 space-y-3">
        <div className={cn("flex items-center gap-4", isSmallScreen ? "justify-between" : "justify-between")}>
          <div className="flex items-center gap-2 text-sm text-muted-foreground min-w-0">
            <span className="font-medium text-foreground truncate">{t('skills:management.all_skills', '所有技能')}</span>
            <span className="text-muted-foreground/40">/</span>
            <span className="flex-shrink-0">{t('skills:management.skills_count', { count: filteredSkills.length })}</span>
          </div>

          <div className="flex items-center gap-1 flex-shrink-0">
            <input
              ref={fileInputRef}
              type="file"
              accept=".md"
              multiple
              onChange={handleImportFile}
              className="hidden"
            />
            
            {/* 新建按钮：移动端在应用顶栏，桌面端保留在此 */}
            {!isSmallScreen && (
              <>
                <NotionButton
                  variant="primary"
                  size="sm"
                  onClick={handleCreate}
                  className="h-7 text-xs px-2.5 shadow-sm"
                >
                  <Plus size={14} className="mr-1.5" />
                  {t('skills:management.create', '新建')}
                </NotionButton>
                <div className="w-px h-4 bg-border/40 mx-1.5" />
              </>
            )}

            <NotionButton
              variant="ghost"
              size="sm"
              onClick={handleImportClick}
              className="h-7 text-xs px-2 text-muted-foreground"
            >
              <Upload size={14} className="mr-1" />
              {t('skills:management.import', '导入')}
            </NotionButton>

            <NotionButton
              variant="ghost"
              size="sm"
              onClick={handleExportAll}
              disabled={allSkills.filter(s => !s.isBuiltin).length === 0}
              className="h-7 text-xs px-2 text-muted-foreground"
            >
              <Download size={14} className="mr-1" />
              {t('skills:management.export_all_short', '导出')}
            </NotionButton>

          </div>
        </div>

        <div className={cn("flex items-center gap-3", isSmallScreen && "flex-col items-stretch")}>
          <div className={cn("relative flex-1", !isSmallScreen && "max-w-xs")}>
            <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('skills:selector.searchPlaceholder', '搜索技能...')}
              className="w-full h-7 pl-8 pr-3 text-xs rounded-md border border-border/40 bg-muted/30 placeholder:text-muted-foreground/50 focus:outline-none focus:ring-1 focus:ring-primary/30 focus:border-primary/30"
            />
          </div>

          <div className={cn("flex items-center gap-1 overflow-x-auto scrollbar-none", isSmallScreen && "-mx-1 px-1")}>
            {locationTabs.map(tab => {
              const count = locationCounts[tab.id];
              const isActiveTab = locationFilter === tab.id;
              if (tab.id !== 'all' && count === 0) return null;
              return (
                <NotionButton
                  key={tab.id}
                  variant="ghost" size="sm"
                  onClick={() => setLocationFilter(tab.id)}
                  className={cn(
                    '!px-2.5 !py-1 !h-auto text-[11px] font-medium whitespace-nowrap',
                    isActiveTab
                      ? 'bg-secondary text-secondary-foreground shadow-sm'
                      : 'text-muted-foreground hover:bg-muted/50 hover:text-foreground'
                  )}
                >
                  <span className={cn("opacity-70", isActiveTab && "opacity-100")}>{tab.icon}</span>
                  <span>{tab.label}</span>
                  <span className={cn(
                    'ml-0.5 text-[10px] opacity-60',
                    isActiveTab && 'opacity-100 font-bold'
                  )}>
                    {count}
                  </span>
                </NotionButton>
              );
            })}
          </div>
        </div>
      </div>

      <CustomScrollArea className="flex-1 min-h-0" viewportClassName="p-4 sm:p-6">
        <SkillsList
          skills={filteredSkills}
          selectedSkillId={selectedSkillId}
          defaultSkillIds={defaultSkillIds}
          onEdit={handleEdit}
          onDelete={handleDelete}
          onToggleDefault={handleToggleDefault}
          onResetToOriginal={handleResetToDefault}
          onExport={handleExport}
          onSelectSkill={(skill) => setSelectedSkillId(skill.id)}
          cardRefsMap={cardRefsMap}
          editingSkillId={editorOpen ? editingSkill?.id : null}
        />
      </CustomScrollArea>

      {/* 移动端底部导航栏占位 */}
      {isSmallScreen && (
        <div
          className="flex-shrink-0"
          style={{
            // 使用 CSS 变量作为 Android fallback
            height: `calc(${MOBILE_LAYOUT.bottomTabBar.defaultHeight}px + var(--android-safe-area-bottom, env(safe-area-inset-bottom, 0px)))`
          }}
        />
      )}
    </div>
  );

  // ========== 渲染右侧面板（移动端编辑器） ==========
  const renderRightPanel = () => (
    <div className="h-full flex flex-col bg-background">
      {/* 面板内容 - 编辑器（嵌入模式，头部由统一顶栏管理） */}
      {(editorOpen || rightPanelOpen) && (
        <SkillEditorModal
          open={true}
          onOpenChange={(open) => {
            if (!open) {
              setEditorOpen(false);
              setRightPanelOpen(false);
              setScreenPosition('center');
            }
          }}
          skill={editingSkill ?? undefined}
          location={editorLocation}
          onSave={handleSave}
          embeddedMode={true}
        />
      )}
    </div>
  );

  // ========== 移动端布局 ==========
  if (isSmallScreen) {
    return (
      <div className={cn('skills-management-page absolute inset-0 flex flex-col overflow-hidden bg-background', className)}>
        <MobileSlidingLayout
          sidebar={null}
          rightPanel={renderRightPanel()}
          screenPosition={screenPosition}
          onScreenPositionChange={setScreenPosition}
          rightPanelEnabled={true}
          enableGesture={true}
          threshold={0.3}
          className="flex-1"
        >
          {renderMainContent()}
        </MobileSlidingLayout>

        <SkillDeleteConfirm
          skill={skillToDelete}
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
          onConfirm={handleConfirmDelete}
        />

        <NotionAlertDialog
          open={importOverwriteOpen}
          onOpenChange={setImportOverwriteOpen}
          title={t('skills:management.import_overwrite_title', '技能已存在')}
          description={t(
            'skills:management.import_overwrite_confirm',
            '技能 "{{name}}" 已存在，是否覆盖？',
            { name: pendingImport?.skill.name }
          )}
          confirmText={t('skills:management.import_overwrite', '覆盖')}
          cancelText={t('common:actions.cancel', '取消')}
          confirmVariant="warning"
          onConfirm={handleConfirmOverwrite}
          onCancel={handleCancelOverwrite}
        />
      </div>
    );
  }

  // ========== 桌面端布局 ==========
  return (
    <LayoutGroup>
      <div className={cn('skills-management-page absolute inset-0 flex flex-col overflow-hidden bg-background', className)}>
        {renderMainContent()}

        <SkillFullscreenEditor
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          skill={editingSkill ?? undefined}
          location={editorLocation}
          onSave={handleSave}
          originRect={editOriginRect}
          theme={isDarkMode ? 'dark' : 'light'}
        />

        <SkillDeleteConfirm
          skill={skillToDelete}
          open={deleteConfirmOpen}
          onOpenChange={setDeleteConfirmOpen}
          onConfirm={handleConfirmDelete}
        />

        <NotionAlertDialog
          open={importOverwriteOpen}
          onOpenChange={setImportOverwriteOpen}
          title={t('skills:management.import_overwrite_title', '技能已存在')}
          description={t(
            'skills:management.import_overwrite_confirm',
            '技能 "{{name}}" 已存在，是否覆盖？',
            { name: pendingImport?.skill.name }
          )}
          confirmText={t('skills:management.import_overwrite', '覆盖')}
          cancelText={t('common:actions.cancel', '取消')}
          confirmVariant="warning"
          onConfirm={handleConfirmOverwrite}
          onCancel={handleCancelOverwrite}
        />
      </div>
    </LayoutGroup>
  );
};

export default SkillsManagementPage;

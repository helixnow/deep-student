/**
 * SkillsManagementPage - 技能管理页面
 *
 * 卡片网格布局，顶部工具栏包含搜索和筛选功能
 */

import React, { useState, useCallback, useMemo, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { LayoutGroup } from 'framer-motion';
import {
  Upload,
  Download,
  Plus,
  ArrowCounterClockwise,
  MagnifyingGlass,
  Lightning,
  Globe,
  FolderOpen,
  Package,
  CloudArrowDown,
  Storefront,
  UploadSimple,
  DotsThree,
  Trash,
  Warning,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useDesktopShellHeaderPortal } from '@/app/shell/DesktopShellHeaderPortal';
import {
  TITLEBAR_CONTROL_CLASS,
  TITLEBAR_ICON_CONTROL_CLASS,
  TITLEBAR_TITLE_CLASS,
} from '@/app/shell/titlebarUiTokens';
import { DsButton } from '@/components/ui/DsButton';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { Input } from '@/components/ui/shad/Input';
import {
  AppMenu,
  AppMenuTrigger,
  AppMenuContent,
  AppMenuItem,
} from '@/components/ui/app-menu/AppMenu';
import { showGlobalNotification } from '../UnifiedNotification';
import { useMobileHeader, MobileSlidingLayout, ScreenPosition } from '@/components/layout';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { fileManager } from '@/utils/fileManager';
import { unifiedConfirm } from '@/utils/unifiedDialogs';

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
  extractCustomizationFromSkill,
} from '@/features/chat/skills';
import {
  checkSkillUpdates,
  updateSkillFromSource,
  exportSkillsAsTap,
  type SkillUpdateCheckResult,
} from '@/features/chat/skills/api';
import {
  formatSkillUpdateDrift,
  selectAvailableSkillUpdates,
} from '@/features/chat/skills/communitySkillsUi';
import type { SkillDefinition, SkillLocation } from '@/features/chat/skills/types';
import { getLocalizedSkillDescription, getLocalizedSkillName } from '@/features/chat/skills/utils';
import {
  isSkillDisabled,
  setSkillDisabled,
} from '@/features/chat/skills/skillEnableStorage';
import {
  registerSkillsAgentSurface,
  type SkillsAgentSnapshot,
} from '@/features/workbench/apps/system/agentSurfaceRegistry';

// 子组件
import { SkillsList } from './SkillsList';
import { SkillEditorModal, type SkillFormData } from './SkillEditorModal';
import { SkillFullscreenEditor } from './SkillFullscreenEditor';
import { SkillTapBrowser } from './SkillTapBrowser';

// ============================================================================
// 类型定义
// ============================================================================

interface SkillsManagementPageProps {
  className?: string;
  /** Workbench 窗口 id：提供时注册 skills agent 观察/操作面（ACR 4.0 A3） */
  workbenchWindowId?: string;
  /**
   * Workbench 窗口内容区尺寸分级（data-wb-sys-size 同源，SkillsAppWindow 下传）。
   * 页面自身的 viewport 断点在窗口里恒为桌面大屏；非 wide 档时工具栏的
   * 七个次级操作收进「⋯」溢出菜单，避免窄窗横向溢出。legacy 页面不传，
   * 维持纯 viewport 断点行为。
   */
  windowSizeClass?: 'compact' | 'medium' | 'wide';
}

// ============================================================================
// 常量
// ============================================================================

/** 全局技能目录路径 */
const GLOBAL_SKILLS_PATH = '~/.deep-student/skills';

interface SkillImportZipResult {
  skill_id: string;
  path: string;
  files_extracted: number;
  scripts_count: number;
  references_count: number;
  allowed_tools_count: number;
  package_sha256: string;
  risk_level: string;
  risk_signals: string[];
  requires?: SkillRequiresProbeResult;
}

interface SkillRequiresProbeResult {
  bins: Array<{ name: string; found: boolean }>;
  env: Array<{ name: string; set: boolean }>;
  python_packages?: Array<{ name: string; found: boolean }>;
  invalid: string[];
  missing_count: number;
}

/** 风险分级徽章配色（对齐 McpToolsSection 敏感等级徽章风格） */
const RISK_BADGE_CLASSES: Record<string, string> = {
  low: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
  high: 'bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400',
};

// ============================================================================
// 行内确认横幅容器：出现时焦点移入，Esc 取消并归还焦点（非模态、无遮罩）
// ============================================================================

interface InlineConfirmSectionProps {
  label: string;
  className?: string;
  onCancel: () => void;
  children: React.ReactNode;
}

const InlineConfirmSection: React.FC<InlineConfirmSectionProps> = ({
  label,
  className,
  onCancel,
  children,
}) => {
  const sectionRef = useRef<HTMLElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    sectionRef.current?.focus();
    return () => {
      // 归还焦点给触发元素（若其仍在文档中）
      const el = restoreFocusRef.current;
      if (el && el.isConnected) el.focus();
    };
  }, []);

  return (
    <section
      ref={sectionRef}
      tabIndex={-1}
      role="group"
      aria-label={label}
      className={cn('outline-none', className)}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault();
          e.stopPropagation();
          onCancel();
        }
      }}
    >
      {children}
    </section>
  );
};

// ============================================================================
// 组件
// ============================================================================

export const SkillsManagementPage: React.FC<SkillsManagementPageProps> = ({
  className,
  workbenchWindowId,
  windowSizeClass,
}) => {
  const { t } = useTranslation(['skills', 'common']);

  // ========== 响应式布局 ==========
  const { isSmallScreen } = useBreakpoint();
  // workbench 窗口标题栏 app 槽位查找（与 ChatAppWindow 同款：壳内查询 + 观察兜底）
  const [windowTitlebarSlot, setWindowTitlebarSlot] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!workbenchWindowId) return;
    const escapedId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(workbenchWindowId) : workbenchWindowId;
    const shell = document.querySelector<HTMLElement>(`[data-wb-window-id="${escapedId}"]`);
    const queryRoot: ParentNode = shell ?? document;
    let currentTarget: HTMLElement | null = null;
    let observer: MutationObserver | null = null;
    const findTarget = () => {
      const target = Array.from(queryRoot.querySelectorAll<HTMLElement>('[data-wb-titlebar-slot]'))
        .find((element) => element.dataset.windowId === workbenchWindowId) ?? null;
      if (!target) return;
      currentTarget = target;
      setWindowTitlebarSlot((current) => (current === target ? current : target));
      observer?.disconnect();
      observer = null;
    };
    findTarget();
    if (!currentTarget) {
      observer = new MutationObserver(findTarget);
      observer.observe(shell ?? document.body, { childList: true, subtree: true });
    }
    return () => observer?.disconnect();
  }, [workbenchWindowId]);
  // legacy 壳标题栏槽位；与 workbench 窗口槽位互斥
  const shellHeaderTarget = useDesktopShellHeaderPortal('skills-management');
  const toolbarPortalTarget = windowTitlebarSlot ?? shellHeaderTarget;
  const inTitlebar = Boolean(toolbarPortalTarget);
  // 顶栏模式统一控件规格（28px / coarse 40px / text-xs，对齐 chat 与 learning-hub 既有件）
  const titlebarSecondaryBtnCls = cn(TITLEBAR_CONTROL_CLASS, 'text-muted-foreground');
  const inlineSecondaryBtnCls = 'max-lg:!h-11 [@media(pointer:coarse)]:!min-h-11 h-7 text-xs px-2 text-muted-foreground';
  const secondaryBtnCls = inTitlebar ? titlebarSecondaryBtnCls : inlineSecondaryBtnCls;
  // 工具栏折叠口径：移动端 viewport 或非 wide 档的 workbench 窗口
  const collapseToolbarActions =
    isSmallScreen || (windowSizeClass !== undefined && windowSizeClass !== 'wide');
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

  // 删除确认状态（列表顶部行内确认横幅，非模态）
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [skillToDelete, setSkillToDelete] = useState<SkillDefinition | null>(null);
  const [inlineDeleting, setInlineDeleting] = useState(false);

  // 恢复内置默认确认状态（丢弃全部自定义且不可撤销 → 与删除同级的风险确认）
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [skillToReset, setSkillToReset] = useState<SkillDefinition | null>(null);
  const [resetting, setResetting] = useState(false);

  // 导入覆盖确认状态
  const [importOverwriteOpen, setImportOverwriteOpen] = useState(false);
  const [pendingImport, setPendingImport] = useState<{ content: string; skill: SkillDefinition } | null>(null);

  // zip 技能包导入覆盖确认状态（复用 pendingImport 的确认交互模式）
  const [zipOverwriteOpen, setZipOverwriteOpen] = useState(false);
  const [pendingZipImport, setPendingZipImport] = useState<{ zipPath: string; name: string } | null>(null);

  // zip 导入装前确认状态：dry_run 扫描结果（含风险分级）先行展示，用户确认后才真正安装
  const [zipConfirmOpen, setZipConfirmOpen] = useState(false);
  const [pendingZipConfirm, setPendingZipConfirm] = useState<{
    zipPath: string;
    fileName: string;
    scan: SkillImportZipResult;
    overwrite: boolean;
  } | null>(null);
  const [zipInstalling, setZipInstalling] = useState(false);

  // Tap 技能源浏览对话框
  const [tapBrowserOpen, setTapBrowserOpen] = useState(false);

  // 上游更新检查状态（基于安装 provenance 的 drift 检测）
  const [updateChecking, setUpdateChecking] = useState(false);
  const [pendingUpdates, setPendingUpdates] = useState<SkillUpdateCheckResult[]>([]);
  const [updateConfirmOpen, setUpdateConfirmOpen] = useState(false);
  const [updating, setUpdating] = useState(false);

  // 卡片位置（用于全屏编辑器动画）
  const [editOriginRect, setEditOriginRect] = useState<DOMRect | null>(null);
  const cardRefsMap = useRef<Map<string, HTMLDivElement>>(new Map());

  // 移动端编辑器子屏的「带脏检查关闭」入口：由嵌入式编辑器填充，
  // 顶栏返回箭头走此入口以复用未保存更改的二次确认（与表单内取消一致）
  const editorRequestCloseRef = useRef<(() => void) | null>(null);

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

  // 打开技能管理时重扫磁盘，避免 Agent 刚安装的技能仍停留在启动时的旧缓存
  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    void reloadSkills()
      .then(() => {
        if (!cancelled) setRegistryVersion((v) => v + 1);
      })
      .catch((error: unknown) => {
        console.error('[SkillsManagement] 打开时刷新失败:', error);
      })
      .finally(() => {
        if (!cancelled) setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onTrustChanged = () => {
      void reloadSkills().then(() => setRegistryVersion((v) => v + 1));
    };
    window.addEventListener('SKILL_TRUST_CHANGED', onTrustChanged);
    return () => window.removeEventListener('SKILL_TRUST_CHANGED', onTrustChanged);
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
        t('skills:management.refresh_success')
      );
    } catch (error) {
      console.error('[SkillsManagement] 刷新失败:', error);
      showGlobalNotification(
        'error',
        t('skills:management.refresh_failed')
      );
    } finally {
      setIsLoading(false);
    }
  }, [t]);

  // 检查上游更新（只覆盖有 provenance 记录的链接/zip 安装技能）
  const handleCheckUpdates = useCallback(async () => {
    setUpdateChecking(true);
    try {
      const results = await checkSkillUpdates();
      const checkable = results.filter((r) => r.checkable);
      if (checkable.length === 0) {
        showGlobalNotification('info', t('skills:management.update_none_checkable'));
        return;
      }
      // error / RATE_LIMITED 行不得进入 outdated 列表
      const available = selectAvailableSkillUpdates(results);
      const failed = checkable.filter((r) => r.error);
      if (available.length === 0) {
        showGlobalNotification(
          'success',
          t('skills:management.update_all_latest', { count: checkable.length }),
          failed.length > 0
            ? t('skills:management.update_check_partial_failed', { count: failed.length })
            : undefined,
        );
        return;
      }
      setPendingUpdates(available);
      setUpdateConfirmOpen(true);
    } catch (error) {
      console.error('[SkillsManagement] 检查更新失败:', error);
      showGlobalNotification('error', String(error), t('skills:management.update_check_failed'));
    } finally {
      setUpdateChecking(false);
    }
  }, [t]);

  // 应用全部可用更新（逐个重装；更新后回到未信任状态）
  const handleConfirmUpdates = useCallback(async () => {
    if (pendingUpdates.length === 0) return;
    setUpdating(true);
    let successCount = 0;
    const errors: string[] = [];
    for (const item of pendingUpdates) {
      try {
        const result = await updateSkillFromSource(item.skillId);
        if (result.updated) successCount++;
      } catch (error) {
        errors.push(`${item.skillId}: ${String(error)}`);
      }
    }
    setUpdating(false);
    setPendingUpdates([]);
    setUpdateConfirmOpen(false);

    if (successCount > 0) {
      await reloadSkills();
    }
    if (errors.length === 0) {
      // showGlobalNotification(type, message, title)：短摘要作标题，长提示作正文
      showGlobalNotification(
        'success',
        t('skills:management.update_retrust_hint'),
        t('skills:management.update_success', { count: successCount }),
      );
    } else {
      showGlobalNotification(
        successCount > 0 ? 'info' : 'error',
        errors.join('\n'),
        t('skills:management.update_partial', { success: successCount, fail: errors.length }),
      );
    }
  }, [pendingUpdates, t]);

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
          allowedTools: data.allowedTools,
          skillType: data.skillType,
          relatedSkills: data.relatedSkills,
          dependencies: data.dependencies,
          content: data.content,
          embeddedTools: data.embeddedTools,
        };
        await saveBuiltinSkillCustomization(editingSkill.id, customization);
        showGlobalNotification(
          'success',
          t('skills:management.builtin_save_success')
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
            allowedTools: data.allowedTools,
            skillType: data.skillType,
            relatedSkills: data.relatedSkills,
            dependencies: data.dependencies,
            embeddedTools: data.embeddedTools,
            preservedFrontmatter: editingSkill.preservedFrontmatter,
          },
          data.content
        );
        const skillFilePath = editingSkill.sourcePath;
        await updateSkill({ path: skillFilePath, content });
        showGlobalNotification(
          'success',
          t('skills:management.save_success')
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
          allowedTools: data.allowedTools,
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
        t('skills:management.create_success')
      );
    }

    // 刷新列表
    await reloadSkills();
  }, [editingSkill, t]);

  // 请求恢复内置技能默认值（风险操作：先经列表顶部行内确认横幅，再真正执行）
  const handleRequestResetToDefault = useCallback((skill: SkillDefinition) => {
    if (!skill.isBuiltin) return;
    setSkillToReset(skill);
    setResetConfirmOpen(true);
  }, []);

  const handleCancelResetToDefault = useCallback(() => {
    setResetConfirmOpen(false);
    setSkillToReset(null);
  }, []);

  // 确认恢复内置技能默认值（丢弃全部自定义，不可撤销）
  const handleConfirmResetToDefault = useCallback(async () => {
    if (!skillToReset) return;
    setResetting(true);
    try {
      await resetBuiltinSkillCustomization(skillToReset.id);
      showGlobalNotification(
        'success',
        t('skills:management.reset_success')
      );
      // 刷新列表
      await reloadSkills();
      setResetConfirmOpen(false);
      setSkillToReset(null);
    } catch (error) {
      console.error('[SkillsManagement] 恢复默认失败:', error);
      showGlobalNotification(
        'error',
        t('skills:management.reset_failed')
      );
    } finally {
      setResetting(false);
    }
  }, [skillToReset, t]);

  // 确认删除
  const handleConfirmDelete = useCallback(async () => {
    if (!skillToDelete) return;

    // ★ 防御性检查：内置技能不可删除
    if (skillToDelete.isBuiltin) {
      console.warn('[SkillsManagement] 尝试删除内置技能，已阻止:', skillToDelete.id);
      showGlobalNotification(
        'error',
        t('skills:management.builtin_no_delete')
      );
      return;
    }

    // 获取技能目录路径（从 sourcePath 中提取）
    const dirPath = skillToDelete.sourcePath.replace(/\/SKILL\.md$/i, '');
    await deleteSkill(dirPath);

    showGlobalNotification(
      'success',
      t('skills:management.delete_success')
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
        preservedFrontmatter: skill.preservedFrontmatter,
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
          t('skills:management.export_success')
        );
      }
    } catch (e) {
      console.error('[SkillsManagement] Export failed:', e);
    }
  }, [t]);

  // 批量导出：逐个弹出保存对话框
  const handleExportAll = useCallback(async () => {
    const userSkills = allSkills.filter((s) => !s.isBuiltin || s.isCustomized);
    if (userSkills.length === 0) {
      showGlobalNotification('info', t('skills:management.export_no_skills'));
      return;
    }

    // 移动端逐个弹保存对话框体验差：两击确认并提示「导出源」一包打包的替代路径
    if (isSmallScreen && userSkills.length > 1) {
      const confirmed = unifiedConfirm(
        t('skills:management.export_all_mobile_confirm', { count: userSkills.length }),
        { key: 'skills-export-all-mobile', level: 'info' },
      );
      if (!confirmed) return;
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
          preservedFrontmatter: skill.preservedFrontmatter,
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
        t('skills:management.export_all_success', { count: exportedCount })
      );
    }
  }, [allSkills, t, isSmallScreen]);

  // 导出为 tap 结构 zip：所有非内置技能一包带走（README + 每技能一个顶层目录）
  const handleExportTap = useCallback(async () => {
    const exportableIds = allSkills
      .filter((s) => !s.isBuiltin && s.location === 'global')
      .map((s) => s.id);
    if (exportableIds.length === 0) {
      showGlobalNotification('info', t('skills:management.export_no_skills'));
      return;
    }
    try {
      const { save: dialogSave } = await import('@tauri-apps/plugin-dialog');
      const picked = await dialogSave({
        title: t('skills:management.export_tap_title'),
        defaultPath: 'my-skills-tap.zip',
        filters: [{ name: 'Zip', extensions: ['zip'] }],
      });
      if (!picked) return;
      const result = await exportSkillsAsTap(exportableIds, picked);
      // showGlobalNotification(type, message, title)：第三参是短标题
      showGlobalNotification(
        'success',
        t('skills:management.export_tap_hint'),
        t('skills:management.export_tap_success', { count: result.skillCount }),
      );
    } catch (error) {
      console.error('[SkillsManagement] 导出技能源失败:', error);
      showGlobalNotification('error', String(error), t('skills:management.export_tap_failed'));
    }
  }, [allSkills, t]);

  // 导入技能文件
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  // 执行 zip 导入并展示装前扫描摘要（首次导入与覆盖确认后共用）
  const runZipImport = useCallback(async (zipPath: string, overwrite: boolean) => {
    const result = await invoke<SkillImportZipResult>('skill_import_zip', {
      zipPath,
      basePath: GLOBAL_SKILLS_PATH,
      overwrite,
    });

    await reloadSkills();

    const scanParts: string[] = [];
    if (result.scripts_count > 0) {
      scanParts.push(t('skills:management.import_scan_scripts', { count: result.scripts_count }));
    }
    if (result.allowed_tools_count > 0) {
      scanParts.push(t('skills:management.import_scan_tools', { count: result.allowed_tools_count }));
    }
    if (result.references_count > 0) {
      scanParts.push(t('skills:management.import_scan_refs', { count: result.references_count }));
    }
    if (result.package_sha256) {
      scanParts.push(`sha256:${result.package_sha256.slice(0, 12)}`);
    }

    showGlobalNotification(
      'success',
      overwrite
        ? t('skills:management.import_zip_overwrite_success', { name: result.skill_id })
        : t('skills:management.import_zip_success', { name: result.skill_id }),
      scanParts.length > 0
        ? t('skills:management.import_scan_summary', { summary: scanParts.join(' · ') })
        : undefined,
    );
  }, [t]);

  const handleImportZipClick = useCallback(async () => {
    try {
      const { open: dialogOpen } = await import('@tauri-apps/plugin-dialog');
      const picked = await dialogOpen({
        multiple: false,
        filters: [{ name: 'Skill Package', extensions: ['zip'] }],
        title: t('skills:management.import_zip_title'),
      });
      if (!picked || typeof picked !== 'string') return;

      // 扫描先行：dry_run 只做装前扫描（含启发式风险分级），不写盘
      const scan = await invoke<SkillImportZipResult>('skill_import_zip', {
        zipPath: picked,
        basePath: GLOBAL_SKILLS_PATH,
        overwrite: false,
        dryRun: true,
      });

      const fileName = picked
        .replace(/\\/g, '/')
        .split('/')
        .filter(Boolean)
        .pop() || picked;
      // 同名已存在时，该确认对话框兼任覆盖确认（标题/按钮文案区分）
      const overwrite = Boolean(skillRegistry.get(scan.skill_id));
      setPendingZipConfirm({ zipPath: picked, fileName, scan, overwrite });
      setZipConfirmOpen(true);
    } catch (error: unknown) {
      showGlobalNotification(
        'error',
        t('skills:management.import_zip_failed'),
        String(error),
      );
    }
  }, [t]);

  // 装前确认通过后真正安装（dry_run: false）
  const handleConfirmZipInstall = useCallback(async () => {
    if (!pendingZipConfirm) return;
    setZipInstalling(true);
    try {
      await runZipImport(pendingZipConfirm.zipPath, pendingZipConfirm.overwrite);
      setPendingZipConfirm(null);
      setZipConfirmOpen(false);
    } catch (error: unknown) {
      const message = String(error);
      if (!pendingZipConfirm.overwrite && message.includes('already exists')) {
        // registry 未收录但磁盘目录已存在：转入既有覆盖确认对话框兜底
        setPendingZipImport({
          zipPath: pendingZipConfirm.zipPath,
          name: pendingZipConfirm.scan.skill_id,
        });
        setPendingZipConfirm(null);
        setZipConfirmOpen(false);
        setZipOverwriteOpen(true);
      } else {
        showGlobalNotification(
          'error',
          t('skills:management.import_zip_failed'),
          message,
        );
        setPendingZipConfirm(null);
        setZipConfirmOpen(false);
      }
    } finally {
      setZipInstalling(false);
    }
  }, [pendingZipConfirm, runZipImport, t]);

  const handleCancelZipInstall = useCallback(() => {
    setPendingZipConfirm(null);
    setZipConfirmOpen(false);
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
        showGlobalNotification('success', t('skills:management.import_success'));
      } else if (errors.length > 0) {
        showGlobalNotification('error', t('skills:management.import_failed', { error: errors[0] }));
      }
    } else {
      const message = t('skills:management.import_batch_result', {
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
      if (existingSkill?.isBuiltin) {
        await saveBuiltinSkillCustomization(
          pendingImport.skill.id,
          extractCustomizationFromSkill(pendingImport.skill),
        );
      } else if (existingSkill) {
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
        t('skills:management.import_overwrite_success', { name: pendingImport.skill.name })
      );
      await reloadSkills();
    } catch (error) {
      showGlobalNotification(
        'error',
        t('skills:management.import_failed', { error: String(error) })
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

  const handleConfirmZipOverwrite = useCallback(async () => {
    if (!pendingZipImport) return;

    try {
      await runZipImport(pendingZipImport.zipPath, true);
    } catch (error) {
      showGlobalNotification(
        'error',
        t('skills:management.import_zip_failed'),
        String(error),
      );
    } finally {
      setPendingZipImport(null);
      setZipOverwriteOpen(false);
    }
  }, [pendingZipImport, runZipImport, t]);

  const handleCancelZipOverwrite = useCallback(() => {
    setPendingZipImport(null);
    setZipOverwriteOpen(false);
  }, []);

  // 行内删除确认（桌面端与移动端共用列表顶部确认横幅）
  const handleInlineConfirmDelete = useCallback(async () => {
    setInlineDeleting(true);
    try {
      await handleConfirmDelete();
      setDeleteConfirmOpen(false);
      setSkillToDelete(null);
    } catch (error) {
      console.error('[SkillsManagement] 删除失败:', error);
      showGlobalNotification(
        'error',
        t('skills:management.delete_failed'),
        String(error),
      );
    } finally {
      setInlineDeleting(false);
    }
  }, [handleConfirmDelete, t]);

  const handleCancelInlineDelete = useCallback(() => {
    setDeleteConfirmOpen(false);
    setSkillToDelete(null);
  }, []);

  // ========== / 聚焦搜索（非输入态） ==========
  // 门禁与 TodoMainPanel 同范式：workbench 窗口承载（祖先带
  // data-wb-sys-app="skills"）时要求所在窗口聚焦（data-focused）且事件
  // 发生在窗内；legacy 页面承载时要求页面可见（离场层 visibility:hidden 不消费）。
  const pageRootRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const root = pageRootRef.current;
      if (!root || !root.isConnected) return;
      const target = e.target as HTMLElement | null;
      const wbHost = root.closest<HTMLElement>('[data-wb-sys-app="skills"]');
      if (wbHost) {
        const windowShell = wbHost.closest<HTMLElement>('[data-wb-window]');
        if (windowShell && !windowShell.hasAttribute('data-focused')) return;
        const scope = windowShell ?? wbHost;
        if (!target || !scope.contains(target)) return;
      } else if (root.getClientRects().length === 0) {
        return;
      }
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      const input = root.querySelector<HTMLInputElement>('[data-skills-search]');
      if (!input) return;
      e.preventDefault();
      input.focus();
      input.select();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 行内确认横幅 / 技能源浏览器渲染在列表顶部：打开时把列表滚回顶部保证可见
  const listViewportRef = useRef<HTMLDivElement>(null);
  const anyInlinePanelOpen =
    tapBrowserOpen || updateConfirmOpen || zipConfirmOpen || resetConfirmOpen ||
    deleteConfirmOpen || importOverwriteOpen || zipOverwriteOpen;
  useEffect(() => {
    if (!anyInlinePanelOpen) return;
    listViewportRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  }, [anyInlinePanelOpen]);

  // ========== 移动端统一顶栏配置 ==========
  const headerTitle = useMemo(() => {
    if (isSmallScreen && !(screenPosition === 'right' && (editorOpen || rightPanelOpen))) {
      return t('skills:management.title');
    }
    // 右侧面板打开时显示编辑器标题
    if (screenPosition === 'right' && (editorOpen || rightPanelOpen)) {
      return editingSkill
        ? t('skills:management.edit')
        : t('skills:management.create');
    }
    if (defaultSkills.length === 0) {
      return t('skills:management.title');
    }
    if (defaultSkills.length === 1) {
      return defaultSkills[0].name;
    }
    return t('skills:management.default_count', { count: defaultSkills.length });
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
    onMenuClick: isEditorView
      ? () => {
          // 优先走编辑器的脏检查关闭（有未保存更改时先二次确认）；
          // 编辑器未挂载时兜底直接关闭
          if (editorRequestCloseRef.current) {
            editorRequestCloseRef.current();
            return;
          }
          setEditorOpen(false);
          setRightPanelOpen(false);
          setScreenPosition('center');
        }
      : screenPosition === 'left'
        ? () => setScreenPosition('center')
        : () => setScreenPosition('left'),
    rightActions: !isEditorView ? (
      <DsButton variant="ghost" size="icon" iconOnly onClick={handleCreate} className="!p-1.5 [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!min-w-11 hover:bg-[var(--interactive-hover)] text-muted-foreground hover:text-foreground" title={t('skills:management.create')} aria-label={t('skills:management.create')}>
        <Plus size={20} />
      </DsButton>
    ) : undefined,
  }, [headerTitle, headerSubtitle, isEditorView, screenPosition, handleCreate, t, workbenchWindowId],
  // Workbench 窗口内嵌入时不接管全局移动端顶栏（对照 TodoContentView）
  !workbenchWindowId);

  // ========== 位置筛选标签 ==========
  const locationTabs = useMemo(() => [
    { id: 'all' as const, label: t('skills:location.all'), icon: <Lightning size={12} /> },
    { id: 'global' as const, label: t('skills:location.global'), icon: <Globe size={12} /> },
    { id: 'project' as const, label: t('skills:location.project'), icon: <FolderOpen size={12} /> },
    { id: 'builtin' as const, label: t('skills:location.builtin'), icon: <Package size={12} /> },
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
    // 用户安装的全局/项目技能置顶，避免被大量内置技能挤出首屏
    const locationRank = (location: SkillLocation) => {
      if (location === 'global') return 0;
      if (location === 'project') return 1;
      return 2;
    };
    return [...result].sort((a, b) => {
      const byLocation = locationRank(a.location) - locationRank(b.location);
      if (byLocation !== 0) return byLocation;
      const byPriority = (a.priority ?? 3) - (b.priority ?? 3);
      if (byPriority !== 0) return byPriority;
      return a.name.localeCompare(b.name, 'zh');
    });
  }, [allSkills, locationFilter, searchQuery, t]);

  // ========== ACR skills agent 观察/操作面（ACR 4.0 A3） ==========
  // 快照走 ref：注册 effect 只依赖 windowId，避免每次渲染反复挂/卸。
  // enabled 在 snapshot() 时经 isSkillDisabled 现算——启停写在 localStorage，
  // 切换不触发本组件重渲，读取时才是最新事实。
  const agentSkillsRef = useRef<SkillDefinition[]>(allSkills);
  agentSkillsRef.current = allSkills;
  const agentDefaultIdsRef = useRef<string[]>(defaultSkillIds);
  agentDefaultIdsRef.current = defaultSkillIds;
  const agentUiStateRef = useRef({
    searchQuery,
    locationFilter,
    selectedSkillId,
    editorOpen,
    loading: isLoading,
  });
  agentUiStateRef.current = {
    searchQuery,
    locationFilter,
    selectedSkillId,
    editorOpen,
    loading: isLoading,
  };
  const agentHandleEditRef = useRef(handleEdit);
  agentHandleEditRef.current = handleEdit;

  useEffect(() => {
    if (!workbenchWindowId) return undefined;
    const findSkill = (skillId: string) =>
      agentSkillsRef.current.find((skill) => skill.id === skillId);
    return registerSkillsAgentSurface(workbenchWindowId, {
      snapshot: (): SkillsAgentSnapshot => {
        const ui = agentUiStateRef.current;
        const defaults = new Set(agentDefaultIdsRef.current);
        return {
          searchQuery: ui.searchQuery,
          locationFilter: ui.locationFilter,
          selectedSkillId: ui.selectedSkillId,
          editorOpen: ui.editorOpen,
          loading: ui.loading,
          skills: agentSkillsRef.current.slice(0, 80).map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            location: skill.location,
            builtin: skill.isBuiltin === true,
            enabled: !isSkillDisabled(skill.id),
            defaultEnabled: defaults.has(skill.id),
          })),
          totalSkills: agentSkillsRef.current.length,
        };
      },
      search: (query) => {
        setSearchQuery(query);
        return true;
      },
      focusSkill: (skillId) => {
        if (!findSkill(skillId)) return false;
        setSelectedSkillId(skillId);
        return true;
      },
      openSkill: (skillId) => {
        const skill = findSkill(skillId);
        if (!skill) return false;
        agentHandleEditRef.current(skill);
        return true;
      },
      setEnabled: (skillId, enabled) => {
        if (!findSkill(skillId)) return false;
        setSkillDisabled(skillId, !enabled);
        return true;
      },
    });
  }, [workbenchWindowId]);

  // ========== 渲染主内容 ==========
  const renderMainContent = () => {
    // 工具栏第一行（面包屑/计数 + 动作条）：桌面端有全局顶栏槽位时 portal 上移，
    // 页内不再重复渲染；第二行（搜索 + 位置筛选）始终页内保留
    const toolbarPrimaryRow = (
        <div className={cn("flex items-center gap-4", isSmallScreen ? "justify-between" : "justify-between", toolbarPortalTarget && 'pointer-events-auto min-w-0 flex-1')}>
          <div className={cn('flex min-w-0 items-center gap-2 text-muted-foreground', inTitlebar ? 'text-xs' : 'text-sm')}>
            <span className={inTitlebar ? TITLEBAR_TITLE_CLASS : 'font-medium text-foreground truncate'}>{t('skills:management.all_skills')}</span>
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
                <DsButton
                  variant="shell"
                  size="sm"
                  onClick={handleCreate}
                  className={inTitlebar
                    ? cn(TITLEBAR_CONTROL_CLASS, 'border-transparent bg-[color:var(--button-tonal-bg)]')
                    : 'h-7 [@media(pointer:coarse)]:!h-11 border-transparent bg-[color:var(--button-tonal-bg)] px-2.5 text-xs'}
                >
                  <Plus size={14} className="mr-1.5" />
                  {t('skills:management.create')}
                </DsButton>
                <div className="w-px h-4 bg-border/40 mx-1.5" />
              </>
            )}

            {!collapseToolbarActions ? (
              <>
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleRefresh()}
                  disabled={isLoading}
                  className={secondaryBtnCls}
                  aria-label={t('skills:selector.refresh')}
                >
                  <ArrowCounterClockwise size={14} className={cn('mr-1', isLoading && 'animate-spin')} />
                  {t('skills:management.refresh')}
                </DsButton>

                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setTapBrowserOpen((v) => !v)}
                  aria-expanded={tapBrowserOpen}
                  className={cn(
                    secondaryBtnCls,
                    tapBrowserOpen && 'bg-[color:var(--interactive-hover)] text-foreground',
                  )}
                >
                  <Storefront size={14} className="mr-1" />
                  {t('skills:tap.entry')}
                </DsButton>

                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleCheckUpdates()}
                  disabled={updateChecking}
                  className={secondaryBtnCls}
                >
                  <CloudArrowDown size={14} className={cn('mr-1', updateChecking && 'animate-pulse')} />
                  {t('skills:management.check_updates')}
                </DsButton>

                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleImportZipClick}
                  className={secondaryBtnCls}
                >
                  <Package size={14} className="mr-1" />
                  {t('skills:management.import_zip')}
                </DsButton>

                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleImportClick}
                  className={secondaryBtnCls}
                >
                  <Upload size={14} className="mr-1" />
                  {t('skills:management.import')}
                </DsButton>

                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleExportAll}
                  disabled={allSkills.filter(s => !s.isBuiltin).length === 0}
                  className={secondaryBtnCls}
                >
                  <Download size={14} className="mr-1" />
                  {t('skills:management.export_all_short')}
                </DsButton>

                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => void handleExportTap()}
                  disabled={allSkills.filter(s => !s.isBuiltin && s.location === 'global').length === 0}
                  className={secondaryBtnCls}
                >
                  <UploadSimple size={14} className="mr-1" />
                  {t('skills:management.export_tap')}
                </DsButton>
              </>
            ) : (
              /* 移动端 / 非 wide 档窗口：七个次级操作横排必溢出 → 收进「⋯」溢出菜单，
                 主操作（搜索/筛选在下一行，新建在应用顶栏或本行首）保持直达 */
              <AppMenu>
                <AppMenuTrigger asChild>
                  <DsButton
                    variant="ghost"
                    size="icon"
                    iconOnly
                    className={cn('text-muted-foreground', inTitlebar ? TITLEBAR_ICON_CONTROL_CLASS : isSmallScreen ? '!h-11 !w-11' : '!h-7 !w-7')}
                    aria-label={t('common:more')}
                    title={t('common:more')}
                  >
                    <DotsThree size={22} weight="bold" />
                  </DsButton>
                </AppMenuTrigger>
                <AppMenuContent align="end" width={224}>
                  <AppMenuItem
                    icon={<ArrowCounterClockwise size={16} className={cn(isLoading && 'animate-spin')} />}
                    disabled={isLoading}
                    onClick={() => void handleRefresh()}
                  >
                    {t('skills:management.refresh')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<Storefront size={16} />}
                    onClick={() => setTapBrowserOpen((v) => !v)}
                  >
                    {t('skills:tap.entry')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<CloudArrowDown size={16} className={cn(updateChecking && 'animate-pulse')} />}
                    disabled={updateChecking}
                    onClick={() => void handleCheckUpdates()}
                  >
                    {t('skills:management.check_updates')}
                  </AppMenuItem>
                  <AppMenuItem icon={<Package size={16} />} onClick={handleImportZipClick}>
                    {t('skills:management.import_zip')}
                  </AppMenuItem>
                  <AppMenuItem icon={<Upload size={16} />} onClick={handleImportClick}>
                    {t('skills:management.import')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<Download size={16} />}
                    disabled={allSkills.filter(s => !s.isBuiltin).length === 0}
                    onClick={handleExportAll}
                  >
                    {t('skills:management.export_all_short')}
                  </AppMenuItem>
                  <AppMenuItem
                    icon={<UploadSimple size={16} />}
                    disabled={allSkills.filter(s => !s.isBuiltin && s.location === 'global').length === 0}
                    onClick={() => void handleExportTap()}
                  >
                    {t('skills:management.export_tap')}
                  </AppMenuItem>
                </AppMenuContent>
              </AppMenu>
            )}
          </div>
        </div>
    );

    return (
    <div className="study-shell-page flex-1 flex flex-col min-w-0 h-full overflow-hidden">
      {toolbarPortalTarget
        ? createPortal(
            <div className="pointer-events-none flex h-full min-w-0 items-center px-2">{toolbarPrimaryRow}</div>,
            toolbarPortalTarget,
          )
        : null}
      <div className={cn('study-shell-toolbar flex-shrink-0 px-5 sm:px-8 lg:px-10', toolbarPortalTarget ? 'py-2' : 'py-3 space-y-3')}>
        {!toolbarPortalTarget && toolbarPrimaryRow}
        <div className={cn("flex items-center gap-3", isSmallScreen && "flex-col items-stretch")}>
          <div className={cn("relative flex-1", !isSmallScreen && "max-w-xs")}>
            <MagnifyingGlass size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground/50" />
            <Input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('skills:selector.searchPlaceholder')}
              data-skills-search
              className={cn(
                'border-transparent bg-[color:var(--surface-muted)] pl-8 pr-3',
                // 移动端加高到触控目标标准，桌面保持紧凑；粗指针设备（如 iPad 横屏）同样加高
                isSmallScreen ? 'h-11 text-sm' : 'h-8 text-xs [@media(pointer:coarse)]:!h-11',
              )}
/>
          </div>

          <SegmentedControl<typeof locationFilter>
            ariaLabel={t('skills:location.all')}
            value={locationFilter}
            onValueChange={setLocationFilter}
            size="compact"
            className={cn(
              'flex items-center gap-1 overflow-x-auto scrollbar-none [&_.study-shell-segmented-thumb]:border-transparent',
              isSmallScreen && '-mx-1 px-1',
            )}
            itemClassName={isSmallScreen
              // 移动端加大纵向点击区，接近触控目标标准（对齐制卡任务页做法）
              // 粗指针设备（如 iPad 横屏走桌面分支）用 !min-h-11 兜底触控高度，
              // 需带 ! 以覆盖 .study-shell-segmented-button 的 min-height: 0
              ? '!h-auto !px-3 !py-2 text-sm font-medium whitespace-nowrap [@media(pointer:coarse)]:!min-h-11'
              : '!h-auto !px-2.5 !py-1 text-xs font-medium whitespace-nowrap [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:!px-3'}
            options={locationTabs
              .filter((tab) => tab.id === 'all' || locationCounts[tab.id] > 0)
              .map((tab) => {
                const count = locationCounts[tab.id];
                const isActiveTab = locationFilter === tab.id;
                return {
                  value: tab.id,
                  label: (
                    <>
                      <span className={cn('opacity-70', isActiveTab && 'opacity-100')}>
                        {tab.icon}
                      </span>
                      <span>{tab.label}</span>
                      <span
                        className={cn(
                          'ml-0.5 text-2xs opacity-60',
                          isActiveTab && 'opacity-100 font-bold',
                        )}
                      >
                        {count}
                      </span>
                    </>
                  ),
                };
              })}
/>
        </div>
      </div>

      <CustomScrollArea
        className="flex-1 min-h-0"
        viewportRef={listViewportRef}
        viewportClassName="pb-[calc(1rem+var(--mobile-safe-area-bottom,0px))] sm:pb-[calc(1.5rem+var(--mobile-safe-area-bottom,0px))]"
      >
        <div className="px-5 pt-5 sm:px-8 sm:pt-7 lg:px-10">
          {/* 技能源浏览器 / 上游更新确认：列表顶部内联展开（非模态，不遮挡页面） */}
          {tapBrowserOpen && (
            <SkillTapBrowser onClose={() => setTapBrowserOpen(false)} />
          )}
          {renderUpdateConfirm()}
          {renderZipImportConfirm()}
          {renderInlineConfirms()}
          <SkillsList
            skills={filteredSkills}
            selectedSkillId={selectedSkillId}
            defaultSkillIds={defaultSkillIds}
            onEdit={handleEdit}
            onDelete={handleDelete}
            onToggleDefault={handleToggleDefault}
            onResetToOriginal={handleRequestResetToDefault}
            onExport={handleExport}
            onSelectSkill={(skill) => setSelectedSkillId(skill.id)}
            cardRefsMap={cardRefsMap}
            editingSkillId={editorOpen ? editingSkill?.id : null}
          />
        </div>
      </CustomScrollArea>
    </div>
    );
  };

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
          requestCloseRef={editorRequestCloseRef}
/>
      )}
    </div>
  );

  // ========== 渲染上游更新确认（列表顶部内联横幅，非模态） ==========
  const handleCancelUpdates = useCallback(() => {
    setPendingUpdates([]);
    setUpdateConfirmOpen(false);
  }, []);

  const renderUpdateConfirm = () => {
    if (!updateConfirmOpen || pendingUpdates.length === 0) return null;
    return (
      <InlineConfirmSection
        label={t('skills:management.update_confirm_title')}
        onCancel={() => {
          if (!updating) handleCancelUpdates();
        }}
        className="mb-4 space-y-2.5 rounded-lg border border-amber-300/50 bg-amber-50/50 p-3 dark:border-amber-700/40 dark:bg-amber-900/10"
      >
        <div className="text-ui font-medium text-foreground">
          {t('skills:management.update_confirm_title')}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('skills:management.update_confirm_desc', { count: pendingUpdates.length })}
        </p>
        <div className="space-y-2">
          {pendingUpdates.map((item) => (
            <div
              key={item.skillId}
              className="space-y-0.5"
              data-testid={`skill-update-outdated-${item.skillId}`}
              data-source-kind={item.sourceKind}
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <div className="text-xs font-medium text-foreground">{item.skillId}</div>
                <span
                  className="study-shell-badge study-shell-badge--warning study-shell-badge--borderless text-2xs"
                  data-testid={`skill-outdated-badge-${item.skillId}`}
                  title={t('skills:management.update_outdated_hint')}
                >
                  {t('skills:management.update_outdated_badge')}
                </span>
              </div>
              <div className="font-mono text-2xs text-muted-foreground">
                {formatSkillUpdateDrift(item)}
              </div>
              <div className="truncate text-2xs text-muted-foreground/70">{item.sourceSummary}</div>
            </div>
          ))}
        </div>
        <p
          className="text-xs leading-relaxed text-amber-600 dark:text-amber-400"
          data-testid="skill-update-retrust-hint"
        >
          {t('skills:management.update_retrust_hint')}
        </p>
        <div className="flex items-center justify-end gap-2">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={handleCancelUpdates}
            disabled={updating}
            className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!min-h-11"
          >
            {t('common:actions.cancel')}
          </DsButton>
          <DsButton
            variant="primary"
            size="sm"
            onClick={() => void handleConfirmUpdates()}
            disabled={updating}
            className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!min-h-11"
          >
            {updating ? t('skills:management.update_applying') : t('skills:management.update_apply')}
          </DsButton>
        </div>
      </InlineConfirmSection>
    );
  };

  // ========== 渲染 zip 导入装前确认（列表顶部内联横幅，非模态；扫描先行：分级可见后再安装） ==========
  const renderZipImportConfirm = () => {
    if (!zipConfirmOpen || !pendingZipConfirm) return null;
    const { scan, fileName, overwrite } = pendingZipConfirm;
    const riskLevel = RISK_BADGE_CLASSES[scan.risk_level] ? scan.risk_level : 'low';
    const isHighRisk = riskLevel === 'high';

    return (
      <InlineConfirmSection
        label={t('skills:management.import_confirm_title')}
        onCancel={() => {
          if (!zipInstalling) handleCancelZipInstall();
        }}
        className={cn(
          'mb-4 space-y-3 rounded-lg border p-3',
          isHighRisk
            ? 'border-red-300/50 bg-red-50/50 dark:border-red-700/40 dark:bg-red-900/10'
            : 'border-border/60 bg-[color:var(--surface-muted)]',
        )}
      >
        <div className="text-ui font-medium text-foreground">
          {overwrite
            ? t('skills:management.import_confirm_overwrite_title')
            : t('skills:management.import_confirm_title')}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          {t('skills:management.import_confirm_source', { name: scan.skill_id, file: fileName })}
        </p>
        <div className="space-y-3">
          {/* 包扫描摘要：文件 / 脚本 / 兼容工具声明 / sha256 */}
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs">
              {t('skills:package.permission_files', { count: scan.files_extracted })}
            </span>
            <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs">
              {t('skills:management.import_scan_scripts', { count: scan.scripts_count })}
            </span>
            <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs">
              {t('skills:management.import_scan_tools', { count: scan.allowed_tools_count })}
            </span>
            {scan.package_sha256 && (
              <span className="study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-2xs">
                sha256:{scan.package_sha256.slice(0, 12)}
              </span>
            )}
          </div>

          {scan.requires &&
            (scan.requires.bins.length > 0 ||
              scan.requires.env.length > 0 ||
              (scan.requires.python_packages?.length ?? 0) > 0) && (
            <div className="space-y-1">
              <div className="text-xs font-semibold uppercase tracking-wider text-muted-foreground/70">
                {t('skills:management.requires_heading')}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {scan.requires.bins.map((bin) => (
                  <span
                    key={`bin-${bin.name}`}
                    className={cn(
                      'study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 text-2xs',
                      !bin.found && 'study-shell-badge--warning',
                    )}
                  >
                    {t('skills:management.requires_bin', { name: bin.name })}
                    {!bin.found && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {t('skills:management.requires_missing')}
                      </span>
                    )}
                  </span>
                ))}
                {scan.requires.env.map((env) => (
                  <span
                    key={`env-${env.name}`}
                    className={cn(
                      'study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-2xs',
                      !env.set && 'study-shell-badge--warning',
                    )}
                  >
                    {t('skills:management.requires_env', { name: env.name })}
                    {!env.set && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {t('skills:management.requires_missing')}
                      </span>
                    )}
                  </span>
                ))}
                {(scan.requires.python_packages ?? []).map((pkg) => (
                  <span
                    key={`py-${pkg.name}`}
                    className={cn(
                      'study-shell-badge inline-flex items-center gap-1 px-1.5 py-0.5 font-mono text-2xs',
                      !pkg.found && 'study-shell-badge--warning',
                    )}
                  >
                    {t('skills:management.requires_python_package', { name: pkg.name })}
                    {!pkg.found && (
                      <span className="text-amber-600 dark:text-amber-400">
                        {t('skills:management.requires_missing')}
                      </span>
                    )}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* 风险分级 + 信号列表（只提示不拦截） */}
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="text-xs text-muted-foreground">
                {t('skills:management.risk_heading')}
              </span>
              <span
                className={cn(
                  'rounded-full px-1.5 py-0.5 text-2xs font-medium',
                  RISK_BADGE_CLASSES[riskLevel]
                )}
              >
                {t(`skills:management.risk_${riskLevel}`, scan.risk_level)}
              </span>
            </div>
            {riskLevel !== 'low' && scan.risk_signals.length > 0 && (
              <ul className="space-y-0.5">
                {scan.risk_signals.map((signal) => (
                  <li key={signal} className="text-xs leading-relaxed text-muted-foreground">
                    · {t(`skills:management.risk_signal_${signal}`, signal)}
                  </li>
                ))}
              </ul>
            )}
            {isHighRisk && (
              <p className="text-xs leading-relaxed text-red-600 dark:text-red-400">
                {t('skills:management.risk_high_warning')}
              </p>
            )}
            {overwrite && (
              <p className="text-xs leading-relaxed text-amber-600 dark:text-amber-400">
                {t('skills:management.import_confirm_overwrite_hint')}
              </p>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2">
          <DsButton
            variant="ghost"
            size="sm"
            onClick={handleCancelZipInstall}
            disabled={zipInstalling}
            className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!min-h-11"
          >
            {t('common:actions.cancel')}
          </DsButton>
          <DsButton
            variant={isHighRisk ? 'danger' : 'primary'}
            size="sm"
            onClick={() => void handleConfirmZipInstall()}
            disabled={zipInstalling}
            className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!min-h-11"
          >
            {zipInstalling
              ? t('skills:tap.installing')
              : overwrite
                ? t('skills:management.import_confirm_overwrite_install')
                : t('skills:management.import_confirm_install')}
          </DsButton>
        </div>
      </InlineConfirmSection>
    );
  };

  // ========== 行内二次确认（替代模态 AlertDialog；列表顶部内联横幅，桌面/移动通用） ==========
  const renderInlineConfirms = () => {
    return (
      <>
        {deleteConfirmOpen && skillToDelete && (
          <InlineConfirmSection
            label={t('skills:management.delete')}
            onCancel={() => {
              if (!inlineDeleting) handleCancelInlineDelete();
            }}
            className="mb-4 space-y-2.5 rounded-lg border border-red-300/50 bg-red-50/50 p-3 dark:border-red-700/40 dark:bg-red-900/10"
          >
            <div className="flex items-center gap-2 text-ui font-medium text-foreground">
              <Warning size={16} className="text-destructive" />
              {t('skills:management.delete')}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('skills:management.delete_confirm', {
                name: getLocalizedSkillName(skillToDelete.id, skillToDelete.name, t),
              })}
            </p>
            <div className="rounded-md bg-muted/50 p-2 text-xs">
              <div className="flex items-center gap-2">
                <Trash size={14} className="flex-shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate font-medium">
                  {getLocalizedSkillName(skillToDelete.id, skillToDelete.name, t)}
                </span>
                <span className="flex-shrink-0 text-2xs text-muted-foreground">({skillToDelete.id})</span>
              </div>
              {skillToDelete.description && (
                <p className="mt-1 line-clamp-2 text-xs text-muted-foreground">
                  {getLocalizedSkillDescription(skillToDelete.id, skillToDelete.description, t)}
                </p>
              )}
            </div>
            <div className="flex items-center justify-end gap-2">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={handleCancelInlineDelete}
                disabled={inlineDeleting}
                className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!min-h-11"
              >
                {t('common:actions.cancel')}
              </DsButton>
              <DsButton
                variant="danger"
                size="sm"
                onClick={() => void handleInlineConfirmDelete()}
                disabled={inlineDeleting}
                className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!min-h-11"
              >
                {inlineDeleting ? t('common:actions.deleting') : t('common:actions.delete')}
              </DsButton>
            </div>
          </InlineConfirmSection>
        )}

        {resetConfirmOpen && skillToReset && (
          <InlineConfirmSection
            label={t('skills:management.reset_confirm_title')}
            onCancel={() => {
              if (!resetting) handleCancelResetToDefault();
            }}
            className="mb-4 space-y-2.5 rounded-lg border border-amber-300/50 bg-amber-50/50 p-3 dark:border-amber-700/40 dark:bg-amber-900/10"
          >
            <div className="flex items-center gap-2 text-ui font-medium text-foreground">
              <ArrowCounterClockwise size={16} className="text-amber-600 dark:text-amber-400" />
              {t('skills:management.reset_confirm_title')}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('skills:management.reset_confirm_desc', {
                name: getLocalizedSkillName(skillToReset.id, skillToReset.name, t),
              })}
            </p>
            <div className="flex items-center justify-end gap-2">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={handleCancelResetToDefault}
                disabled={resetting}
                className="!h-9 px-3 text-xs"
              >
                {t('common:actions.cancel')}
              </DsButton>
              <DsButton
                variant="primary"
                size="sm"
                onClick={() => void handleConfirmResetToDefault()}
                disabled={resetting}
                className="!h-9 px-3 text-xs"
              >
                {resetting
                  ? t('skills:management.resetting')
                  : t('skills:management.reset_confirm_action')}
              </DsButton>
            </div>
          </InlineConfirmSection>
        )}

        {importOverwriteOpen && pendingImport && (
          <InlineConfirmSection
            label={t('skills:management.import_overwrite_title')}
            onCancel={handleCancelOverwrite}
            className="mb-4 space-y-2.5 rounded-lg border border-amber-300/50 bg-amber-50/50 p-3 dark:border-amber-700/40 dark:bg-amber-900/10"
          >
            <div className="text-ui font-medium text-foreground">
              {t('skills:management.import_overwrite_title')}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('skills:management.import_overwrite_confirm', { name: pendingImport.skill.name })}
            </p>
            <div className="flex items-center justify-end gap-2">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={handleCancelOverwrite}
                className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!min-h-11"
              >
                {t('common:actions.cancel')}
              </DsButton>
              <DsButton
                variant="primary"
                size="sm"
                onClick={() => void handleConfirmOverwrite()}
                className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!min-h-11"
              >
                {t('skills:management.import_overwrite')}
              </DsButton>
            </div>
          </InlineConfirmSection>
        )}

        {zipOverwriteOpen && pendingZipImport && (
          <InlineConfirmSection
            label={t('skills:management.import_zip_overwrite_title')}
            onCancel={handleCancelZipOverwrite}
            className="mb-4 space-y-2.5 rounded-lg border border-amber-300/50 bg-amber-50/50 p-3 dark:border-amber-700/40 dark:bg-amber-900/10"
          >
            <div className="text-ui font-medium text-foreground">
              {t('skills:management.import_zip_overwrite_title')}
            </div>
            <p className="text-xs leading-relaxed text-muted-foreground">
              {t('skills:management.import_zip_overwrite_confirm', { name: pendingZipImport.name })}
            </p>
            <div className="flex items-center justify-end gap-2">
              <DsButton
                variant="ghost"
                size="sm"
                onClick={handleCancelZipOverwrite}
                className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!min-h-11"
              >
                {t('common:actions.cancel')}
              </DsButton>
              <DsButton
                variant="primary"
                size="sm"
                onClick={() => void handleConfirmZipOverwrite()}
                className="!h-9 px-3 text-xs [@media(pointer:coarse)]:!min-h-11"
              >
                {t('skills:management.import_overwrite')}
              </DsButton>
            </div>
          </InlineConfirmSection>
        )}
      </>
    );
  };

  // ========== 移动端布局 ==========
  if (isSmallScreen) {
    return (
      <div ref={pageRootRef} className={cn('skills-management-page study-shell-page absolute inset-0 flex flex-col overflow-hidden', className)}>
        <MobileSlidingLayout
          sidebar={
            // 本页无页内工具，抽屉只承载统一应用导航；
            // 不再渲染与顶栏标题重复的孤立分区标签
            <div aria-hidden className="h-0" />
          }
          rightPanel={renderRightPanel()}
          screenPosition={screenPosition}
          onScreenPositionChange={(next) => {
            // 手势从编辑器右屏滑回时，走编辑器的脏检查关闭入口：
            // 有未保存更改先二次确认，拒绝本次位置切换（不更新 state 即回弹），
            // 确认/无脏数据时由编辑器 onClose 收敛状态。与顶栏返回箭头同一条路径。
            if (
              screenPosition === 'right' &&
              next !== 'right' &&
              (editorOpen || rightPanelOpen) &&
              editorRequestCloseRef.current
            ) {
              editorRequestCloseRef.current();
              return;
            }
            setScreenPosition(next);
          }}
          // 仅编辑器打开时允许手势滑入右屏：否则左滑会滑到一块空白面板（死胡同）
          rightPanelEnabled={editorOpen || rightPanelOpen}
          showSidebarAppNavigation
          showContentOverlay
          enableGesture={true}
          threshold={0.3}
          className="flex-1"
        >
          {renderMainContent()}
        </MobileSlidingLayout>

        {/* 删除/覆盖确认已改为列表顶部行内横幅（renderInlineConfirms），不再挂载模态 AlertDialog */}
      </div>
    );
  }

  // ========== 桌面端布局 ==========
  return (
    <LayoutGroup>
      <div ref={pageRootRef} className={cn('skills-management-page study-shell-page absolute inset-0 flex flex-col overflow-hidden', className)}>
        {renderMainContent()}

        {/* 桌面端编辑器：页面容器内的内联全区编辑视图（absolute 于本页面内，不逃出 OS 窗口）。
            删除/覆盖确认与移动端共用列表顶部行内横幅（renderInlineConfirms），无模态 */}
        <SkillFullscreenEditor
          open={editorOpen}
          onClose={() => setEditorOpen(false)}
          skill={editingSkill ?? undefined}
          location={editorLocation}
          onSave={handleSave}
          originRect={editOriginRect}
          theme={isDarkMode ? 'dark' : 'light'}
/>
      </div>
    </LayoutGroup>
  );
};

export default SkillsManagementPage;

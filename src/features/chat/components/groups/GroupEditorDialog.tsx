import React, { useCallback, useEffect, useMemo, useState, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { 
  Archive, Check, X, TextT, Smiley, TextAlignLeft, Terminal, Lightning,
  Folder, FolderOpen, Star, Heart, BookOpen, GraduationCap,
  Code, Calculator, Flask, Atom, Globe, Translate,
  MusicNote, Palette, Camera, Lightbulb, Target, Trophy,
  Rocket, Brain, Sparkle, Chat, FileText, BookmarkSimple,
  Paperclip, Plus, CircleNotch,
  ClipboardText, PenNib, Image as ImageIcon, File as FileIcon, ListChecks,
} from '@phosphor-icons/react';
import type { VfsResourceRef } from '../../context/vfsRefTypes';
import { getResourceRefsV2 } from '../../context/vfsRefApi';
import { LearningHubSidebar } from '@/features/learning-hub';
import type { ResourceListItem } from '@/features/learning-hub/types';

interface RuntimeRootEntry {
  id: string;
  kind: string;
  path: string;
  access: 'read_only' | 'read_write' | string;
  label: string;
  description?: string;
  session_scoped?: boolean;
  configured?: boolean;
}

function getResourceTypeIcon(type: string): React.ElementType {
  switch (type) {
    case 'note': return FileText;
    case 'textbook': return BookOpen;
    case 'exam': return ClipboardText;
    case 'translation': return Translate;
    case 'essay': return PenNib;
    case 'image': return ImageIcon;
    case 'mindmap': return Brain;
    case 'todo': return ListChecks;
    case 'file':
    default:
      return FileIcon;
  }
}

// 预设图标列表
export const PRESET_ICONS = [
  { name: 'folder', Icon: Folder },
  { name: 'folder-open', Icon: FolderOpen },
  { name: 'star', Icon: Star },
  { name: 'heart', Icon: Heart },
  { name: 'book-open', Icon: BookOpen },
  { name: 'graduation-cap', Icon: GraduationCap },
  { name: 'code', Icon: Code },
  { name: 'calculator', Icon: Calculator },
  { name: 'flask', Icon: Flask },
  { name: 'atom', Icon: Atom },
  { name: 'globe', Icon: Globe },
  { name: 'languages', Icon: Translate },
  { name: 'music', Icon: MusicNote },
  { name: 'palette', Icon: Palette },
  { name: 'camera', Icon: Camera },
  { name: 'lightbulb', Icon: Lightbulb },
  { name: 'target', Icon: Target },
  { name: 'trophy', Icon: Trophy },
  { name: 'rocket', Icon: Rocket },
  { name: 'brain', Icon: Brain },
  { name: 'sparkles', Icon: Sparkle },
  { name: 'message-square', Icon: Chat },
  { name: 'file-text', Icon: FileText },
  { name: 'bookmark', Icon: BookmarkSimple },
];
import { Input } from '@/components/ui/shad/Input';
import { Textarea } from '@/components/ui/shad/Textarea';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { cn } from '@/lib/utils';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { skillRegistry, subscribeToSkillRegistry } from '../../skills/registry';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import type { CreateGroupRequest, SessionGroup, UpdateGroupRequest } from '../../types/group';
import { configureTaskWorkspace } from '../../api/taskWorkspaceApi';

interface GroupEditorPanelProps {
  mode: 'create' | 'edit';
  initial?: SessionGroup | null;
  autoFocusField?: 'name' | null;
  onSubmit: (payload: CreateGroupRequest | UpdateGroupRequest) => Promise<void>;
  onClose: () => void;
  onArchive?: () => void;
  /** 移动端：通过父级 MobileSlidingLayout 右面板浏览资源，传入 togglePinnedResource 回调和当前已选 ID */
  onMobileBrowse?: (toggleResource: (sourceId: string) => 'added' | 'removed' | false, currentIds: string[]) => void;
}

const PropertyRow: React.FC<{
  icon: React.ElementType;
  label: string;
  children: React.ReactNode;
  className?: string;
  mobileStacked?: boolean;
}> = ({ icon: Icon, label, children, className, mobileStacked }) => (
  <div className={cn(
    "group grid items-start py-2", 
    mobileStacked 
      ? "grid-cols-1 md:grid-cols-[140px_1fr]" 
      : "grid-cols-[100px_1fr] md:grid-cols-[140px_1fr]",
    className
  )}>
    <div className={cn(
      "flex items-center gap-2 text-sm text-muted-foreground/80",
      mobileStacked ? "mb-2 md:mb-0 min-h-[auto] md:min-h-[36px]" : "min-h-[36px]"
    )}>
      <Icon size={16} />
      <span>{label}</span>
    </div>
    <div className="flex-1 min-w-0">
      {children}
    </div>
  </div>
);

export const GroupEditorPanel: React.FC<GroupEditorPanelProps> = ({
  mode,
  initial,
  autoFocusField = null,
  onSubmit,
  onClose,
  onArchive,
  onMobileBrowse,
}) => {
  const { t } = useTranslation(['chatV2', 'common', 'skills']);
  const { isSmallScreen } = useBreakpoint();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [icon, setIcon] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [defaultSkillIds, setDefaultSkillIds] = useState<string[]>([]);
  const [pinnedResourceIds, setPinnedResourceIds] = useState<string[]>([]);
  const [resolvedPinnedRefs, setResolvedPinnedRefs] = useState<VfsResourceRef[]>([]);
  const [pinnedLoading, setPinnedLoading] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [registryVersion, setRegistryVersion] = useState(0);
  const [defaultRuntimeRootId, setDefaultRuntimeRootId] = useState('');
  const [preferredProjectRootPath, setPreferredProjectRootPath] = useState('');
  const [runtimeRoots, setRuntimeRoots] = useState<RuntimeRootEntry[]>([]);
  const [rootsLoading, setRootsLoading] = useState(false);
  const [isAuthorizingRoot, setIsAuthorizingRoot] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
        textareaRef.current.style.height = `${textareaRef.current.scrollHeight}px`;
    }
  }, [systemPrompt]);

  useEffect(() => {
    if (autoFocusField !== 'name') return;
    const frame = window.requestAnimationFrame(() => {
      nameInputRef.current?.focus();
      nameInputRef.current?.select();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [autoFocusField, initial?.id, mode]);
  useEffect(() => {
    if (mode === 'edit' && initial) {
      setName(initial.name);
      setDescription(initial.description ?? '');
      setIcon(initial.icon ?? '');
      setSystemPrompt(initial.systemPrompt ?? '');
      setDefaultSkillIds(initial.defaultSkillIds ?? []);
      setPinnedResourceIds(initial.pinnedResourceIds ?? []);
      setDefaultRuntimeRootId(initial.defaultRuntimeRootId ?? '');
      setPreferredProjectRootPath(initial.preferredProjectRootPath ?? '');
    } else {
      setName('');
      setDescription('');
      setIcon('');
      setSystemPrompt('');
      setDefaultSkillIds([]);
      setPinnedResourceIds([]);
      setResolvedPinnedRefs([]);
      setDefaultRuntimeRootId('');
      setPreferredProjectRootPath('');
    }
  }, [mode, initial]);

  const loadRuntimeRoots = useCallback(async () => {
    setRootsLoading(true);
    try {
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_list_runtime_roots');
      // 课题绑定仅使用持久根（workspace / authorized），排除会话临时根
      setRuntimeRoots((roots ?? []).filter((root) => !root.session_scoped));
    } catch (err) {
      console.error('[GroupEditorPanel] Failed to load runtime roots:', err);
      setRuntimeRoots([]);
      showGlobalNotification('error', t('page.groupDefaultRuntimeRootLoadFailed'));
    } finally {
      setRootsLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadRuntimeRoots();
  }, [loadRuntimeRoots]);

  // Resolve pinned resource IDs to display info
  useEffect(() => {
    if (pinnedResourceIds.length === 0) {
      setResolvedPinnedRefs([]);
      return;
    }
    let cancelled = false;
    setPinnedLoading(true);
    getResourceRefsV2(pinnedResourceIds).then((result) => {
      if (cancelled) return;
      if (result.ok) {
        setResolvedPinnedRefs(result.value.refs);
      } else {
        console.warn('[GroupEditorPanel] Failed to resolve pinned refs:', result.error);
        // Show sourceIds as fallback
        setResolvedPinnedRefs(
          pinnedResourceIds.map((id) => ({
            sourceId: id,
            resourceHash: '',
            type: 'file' as const,
            name: id,
          }))
        );
      }
      setPinnedLoading(false);
    });
    return () => { cancelled = true; };
  }, [pinnedResourceIds]);

  useEffect(() => {
    const unsubscribe = subscribeToSkillRegistry(() => {
      setRegistryVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  const skillList = useMemo(() => {
    void registryVersion;
    return skillRegistry.getAll().sort((a, b) => a.name.localeCompare(b.name));
  }, [registryVersion]);

  const pinnedHighlightSet = useMemo(() => new Set(pinnedResourceIds), [pinnedResourceIds]);

  const togglePinnedResource = useCallback((sourceId: string): 'added' | 'removed' | false => {
    const trimmed = sourceId.trim();
    if (!trimmed) return false;
    const box = { result: 'added' as 'added' | 'removed' };
    setPinnedResourceIds((prev) => {
      if (prev.includes(trimmed)) {
        box.result = 'removed';
        return prev.filter((id) => id !== trimmed);
      }
      return [...prev, trimmed];
    });
    if (box.result === 'removed') {
      setResolvedPinnedRefs((prev) => prev.filter((r) => r.sourceId !== trimmed));
    }
    return box.result;
  }, []);

  const removePinnedResource = useCallback((sourceId: string) => {
    setPinnedResourceIds((prev) => prev.filter((id) => id !== sourceId));
    setResolvedPinnedRefs((prev) => prev.filter((r) => r.sourceId !== sourceId));
  }, []);

  const toggleSkill = useCallback((skillId: string) => {
    setDefaultSkillIds((prev) => {
      if (prev.includes(skillId)) {
        return prev.filter((id) => id !== skillId);
      }
      return [...prev, skillId];
    });
  }, []);

  const bindRuntimeRoot = useCallback((root: RuntimeRootEntry) => {
    setDefaultRuntimeRootId(root.id);
    setPreferredProjectRootPath(root.path);
  }, []);

  const clearRuntimeRoot = useCallback(() => {
    setDefaultRuntimeRootId('');
    setPreferredProjectRootPath('');
  }, []);

  const handleSelectRuntimeRoot = useCallback((rootId: string) => {
    if (!rootId) {
      clearRuntimeRoot();
      return;
    }
    const root = runtimeRoots.find((entry) => entry.id === rootId);
    if (root) {
      bindRuntimeRoot(root);
      return;
    }
    setDefaultRuntimeRootId(rootId);
  }, [bindRuntimeRoot, clearRuntimeRoot, runtimeRoots]);

  const handleBrowseAndAuthorizeRoot = useCallback(async () => {
    if (isAuthorizingRoot) return;
    try {
      const { open: dialogOpen } = await import('@tauri-apps/plugin-dialog');
      const selected = await dialogOpen({
        directory: true,
        multiple: false,
        title: t('page.groupDefaultRuntimeRootBrowseTitle'),
      });
      if (typeof selected !== 'string' || !selected.trim()) return;

      setIsAuthorizingRoot(true);
      const roots = await configureTaskWorkspace(selected.trim());
      const nextRoots = (roots ?? []).filter((root) => !root.session_scoped);
      setRuntimeRoots(nextRoots);
      const matched = nextRoots.find((root) => root.id === 'workspace' && root.access === 'read_write');
      if (matched) {
        bindRuntimeRoot(matched);
      }
    } catch (err) {
      console.error('[GroupEditorPanel] Authorize runtime root failed:', err);
      showGlobalNotification('error', t('page.groupDefaultRuntimeRootAuthorizeFailed'));
    } finally {
      setIsAuthorizingRoot(false);
    }
  }, [bindRuntimeRoot, isAuthorizingRoot, t]);

  const selectedRuntimeRootPath = useMemo(() => {
    if (preferredProjectRootPath.trim()) return preferredProjectRootPath.trim();
    const matched = runtimeRoots.find((root) => root.id === defaultRuntimeRootId);
    return matched?.path ?? '';
  }, [defaultRuntimeRootId, preferredProjectRootPath, runtimeRoots]);

  const handleSubmit = useCallback(async () => {
    if (!name.trim()) return;
    setIsSaving(true);
    try {
      if (mode === 'create') {
        const payload: CreateGroupRequest = {
          name: name.trim(),
          description: description.trim() || undefined,
          icon: icon.trim() || undefined,
          systemPrompt: systemPrompt.trim() || undefined,
          defaultSkillIds,
          pinnedResourceIds,
          defaultRuntimeRootId: defaultRuntimeRootId.trim() || undefined,
          preferredProjectRootPath: preferredProjectRootPath.trim() || undefined,
        };
        await onSubmit(payload);
      } else {
        // Edit mode: send "" to clear fields (backend treats Some("") as clear-to-None)
        const payload: UpdateGroupRequest = {
          name: name.trim(),
          description: description.trim(),
          icon: icon.trim(),
          systemPrompt: systemPrompt.trim(),
          defaultSkillIds,
          pinnedResourceIds,
          defaultRuntimeRootId: defaultRuntimeRootId.trim(),
          preferredProjectRootPath: preferredProjectRootPath.trim(),
        };
        await onSubmit(payload);
      }
    } catch (error: unknown) {
      console.error('[GroupEditorPanel] Failed to save group:', error);
      showGlobalNotification('error', t('page.groupSaveFailed'));
    } finally {
      setIsSaving(false);
    }
  }, [
    defaultRuntimeRootId,
    defaultSkillIds,
    pinnedResourceIds,
    description,
    icon,
    mode,
    name,
    onSubmit,
    preferredProjectRootPath,
    systemPrompt,
    t,
  ]);

  return (
    <div className="flex flex-col h-full bg-background relative">
      {/* Action Buttons - Absolute Positioned */}
      <div className="absolute top-4 right-4 md:top-6 md:right-8 z-10 flex items-center gap-2">
          <NotionButton variant="ghost" onClick={onClose} disabled={isSaving} className="h-8 px-3 max-md:h-10">
            {t('common:cancel')}
          </NotionButton>
          <NotionButton 
            variant="primary" 
            onClick={handleSubmit} 
            disabled={isSaving || !name.trim()}
            className="h-8 px-3 max-md:h-10"
          >
            {mode === 'create' ? t('common:create') : t('common:save')}
          </NotionButton>
      </div>

      <CustomScrollArea className="flex-1">
        <div className="max-w-3xl mx-auto px-5 py-8 md:px-8 md:py-10 space-y-6 md:space-y-8 mt-10 md:mt-12">
          
          {/* Title Section */}
          <div className="space-y-4">
             {/* Icon Preview if available */}
             {icon && (
                <div className="text-4xl mb-4">
                  {(() => {
                    const presetIcon = PRESET_ICONS.find(p => p.name === icon);
                    if (presetIcon) {
                      const IconComp = presetIcon.Icon;
                      return <IconComp size={40} className="text-primary" />;
                    }
                    return icon;
                  })()}
                </div>
             )}
             <Input
               ref={nameInputRef}
               type="text"
               value={name}
               onChange={(e) => setName(e.target.value)}
               placeholder={t('page.groupNamePlaceholder')}
               autoFocus={autoFocusField === 'name'}
               className="w-full text-2xl md:text-3xl font-semibold border-0 border-b-2 border-border/50 bg-transparent placeholder:text-muted-foreground/40 py-3 pr-24 md:pr-0 rounded-none focus-visible:ring-0 focus-visible:border-primary transition-colors"
             />
          </div>

          {/* Properties Section */}
          <div className="space-y-1">
            
            <PropertyRow icon={Smiley} label={t('page.groupIcon')} mobileStacked>
              <div className="space-y-3">
                {/* 图标选择网格 */}
                <div className="flex flex-wrap gap-1.5">
                  {PRESET_ICONS.map(({ name: iconName, Icon: IconComponent }) => (
                    <div
                      key={iconName}
                      onClick={() => setIcon(iconName)}
                      className={cn(
                        // 移动端触控目标放大到 44px，桌面保持 36px
                        "w-9 h-9 max-md:w-11 max-md:h-11 flex items-center justify-center rounded-md cursor-pointer transition-colors",
                        icon === iconName
                          ? "bg-primary/15 text-primary ring-1 ring-primary/30"
                          : "hover:bg-[var(--interactive-hover)] text-muted-foreground hover:text-foreground"
                      )}
                      title={iconName}
                    >
                      <IconComponent size={20} />
                    </div>
                  ))}
                  {/* 清除按钮 */}
                  {icon && (
                    <div
                      onClick={() => setIcon('')}
                      className="w-9 h-9 max-md:w-11 max-md:h-11 flex items-center justify-center rounded-md cursor-pointer hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-colors"
                      title={t('common:clear')}
                    >
                      <X size={16} />
                    </div>
                  )}
                </div>
                {/* 自定义输入（支持 emoji） */}
                <Input
                  value={icon}
                  onChange={(e) => setIcon(e.target.value)}
                  placeholder={t('page.groupIconPlaceholder')}
                  className="h-8 text-sm border-transparent shadow-none bg-transparent hover:bg-[var(--interactive-hover)] focus:bg-muted/20 focus:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 outline-none px-2 transition-colors"
                />
              </div>
            </PropertyRow>

            <PropertyRow icon={TextAlignLeft} label={t('page.groupDescription')}>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={t('page.groupDescriptionPlaceholder')}
                className="h-9 border-transparent shadow-none bg-transparent hover:bg-[var(--interactive-hover)] focus:bg-muted/20 focus:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 outline-none px-2 transition-colors"
              />
            </PropertyRow>

            <PropertyRow icon={Terminal} label={t('page.groupSystemPrompt')} mobileStacked>
              <Textarea
                ref={textareaRef}
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                rows={5}
                className="min-h-[120px] border-transparent shadow-none bg-transparent hover:bg-[var(--interactive-hover)] focus:bg-muted/20 focus:border-transparent focus-visible:ring-0 focus-visible:ring-offset-0 outline-none px-2 py-2 transition-colors resize-none overflow-hidden"
                placeholder={t('page.groupSystemPromptPlaceholder')}
              />
            </PropertyRow>

            <PropertyRow icon={FolderOpen} label={t('page.groupDefaultRuntimeRoot')} mobileStacked>
              <div className="space-y-2 px-0 md:px-2 pt-1">
                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={defaultRuntimeRootId}
                    onChange={(e) => handleSelectRuntimeRoot(e.target.value)}
                    disabled={rootsLoading || isAuthorizingRoot}
                    className="h-9 min-w-[12rem] max-w-full flex-1 rounded-md border border-border/60 bg-background px-2 text-sm text-foreground outline-none focus:border-primary/50 disabled:opacity-50"
                  >
                    <option value="">{t('page.groupDefaultRuntimeRootNone')}</option>
                    {defaultRuntimeRootId
                      && !runtimeRoots.some((root) => root.id === defaultRuntimeRootId) && (
                      <option value={defaultRuntimeRootId}>
                        {selectedRuntimeRootPath || defaultRuntimeRootId}
                      </option>
                    )}
                    {runtimeRoots.map((root) => (
                      <option key={root.id} value={root.id}>
                        {root.label || root.id}
                        {root.access === 'read_only' ? ' (RO)' : ''}
                        {root.path ? ` — ${root.path}` : ''}
                      </option>
                    ))}
                  </select>
                  <NotionButton
                    variant="ghost"
                    onClick={() => void handleBrowseAndAuthorizeRoot()}
                    disabled={isAuthorizingRoot}
                    className="h-8 px-3 shrink-0"
                  >
                    {isAuthorizingRoot ? (
                      <CircleNotch size={14} className="mr-1.5 animate-spin" />
                    ) : (
                      <Folder size={14} className="mr-1.5" />
                    )}
                    {t('page.groupDefaultRuntimeRootBrowse')}
                  </NotionButton>
                  {defaultRuntimeRootId && (
                    <NotionButton
                      variant="ghost"
                      onClick={clearRuntimeRoot}
                      disabled={isAuthorizingRoot}
                      className="h-8 px-3 shrink-0 text-muted-foreground hover:text-destructive"
                      title={t('common:clear')}
                    >
                      <X size={14} className="mr-1.5" />
                      {t('common:clear')}
                    </NotionButton>
                  )}
                </div>
                {selectedRuntimeRootPath ? (
                  <div
                    className="text-xs text-muted-foreground font-mono truncate"
                    title={selectedRuntimeRootPath}
                  >
                    {selectedRuntimeRootPath}
                  </div>
                ) : null}
                <p className="text-xs text-muted-foreground/60 leading-relaxed">
                  {t('page.groupDefaultRuntimeRootHint')}
                </p>
              </div>
            </PropertyRow>

            <PropertyRow icon={Lightning} label={t('page.groupDefaultSkills')} mobileStacked>
                <div className="flex flex-wrap gap-2 pt-1.5 px-0 md:px-2">
                    {skillList.length === 0 ? (
                        <div className="text-sm text-muted-foreground/50">
                            {t('page.noSkills')}
                        </div>
                    ) : (
                        skillList.map(skill => {
                            const checked = defaultSkillIds.includes(skill.id);
                            // 优先使用国际化友好名称
                            const displayName = t(`skills:builtinNames.${skill.id}`, { defaultValue: '' }) || skill.name;
                            return (
                                <div
                                    key={skill.id}
                                    onClick={() => toggleSkill(skill.id)}
                                    className={cn(
                                        "inline-flex items-center gap-1.5 px-2 py-1 rounded-md text-sm border cursor-pointer transition-colors select-none",
                                        checked 
                                          ? "bg-primary/10 text-primary border-primary/20" 
                                          : "bg-background border-border hover:bg-[var(--interactive-hover)] text-muted-foreground"
                                    )}
                                >
                                    {checked && <Check size={12} />}
                                    <span>{displayName}</span>
                                </div>
                            )
                        })
                    )}
                </div>
            </PropertyRow>

          </div>

          {/* Pinned Resources Section */}
          <div className="space-y-3 pt-4 border-t border-border/40">
            <div className="flex items-center gap-2 text-sm font-medium text-foreground/80">
              <Paperclip size={16} />
              <span>{t('page.groupPinnedResources')}</span>
            </div>

            {/* Pinned resource list */}
            {pinnedLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground py-2">
                <CircleNotch size={16} className="animate-spin" />
                <span>{t('common:loading')}</span>
              </div>
            ) : resolvedPinnedRefs.length > 0 ? (
              <div className="space-y-1">
                {resolvedPinnedRefs.map((ref) => {
                  const TypeIcon = getResourceTypeIcon(ref.type);
                  return (
                    <div
                      key={ref.sourceId}
                      className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-md bg-muted/30 hover:bg-[var(--interactive-hover)] transition-colors group"
                    >
                      <div className="flex items-center gap-2 min-w-0">
                        <TypeIcon size={14} className="text-muted-foreground flex-shrink-0" />
                        <span className="text-sm truncate">{ref.name}</span>
                        <span className="text-xs text-muted-foreground/60 flex-shrink-0">{ref.type}</span>
                      </div>
                      <button
                        type="button"
                        onClick={() => removePinnedResource(ref.sourceId)}
                        className={cn(
                          // 视觉紧凑，透明伪元素扩大触控命中区
                          'p-0.5 rounded hover:bg-destructive/10 hover:text-destructive transition-colors relative after:absolute after:-inset-2.5 after:content-[\'\']',
                          isSmallScreen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100'
                        )}
                        aria-label={t('common:remove')}
                      >
                        <X size={14} />
                      </button>
                    </div>
                  );
                })}
              </div>
            ) : null}

            {/* Add from browse — primary action（桌面端切换内联资源选择区，不再用侧滑抽屉） */}
            <button
              type="button"
              aria-expanded={!onMobileBrowse ? pickerOpen : undefined}
              onClick={() => {
                if (onMobileBrowse) {
                  onMobileBrowse(togglePinnedResource, pinnedResourceIds);
                } else {
                  setPickerOpen((open) => !open);
                }
              }}
              className={cn(
                'w-full flex items-center gap-2 px-3 py-2 rounded-md border border-dashed text-sm transition-colors cursor-pointer',
                !onMobileBrowse && pickerOpen
                  ? 'border-primary/40 bg-primary/5 text-foreground'
                  : 'border-border/60 text-muted-foreground hover:bg-[var(--interactive-hover)] hover:text-foreground hover:border-border'
              )}
            >
              {!onMobileBrowse && pickerOpen ? <X size={16} /> : <Plus size={16} />}
              <span>
                {!onMobileBrowse && pickerOpen
                  ? t('common:close')
                  : t('page.groupPinnedBrowse')}
              </span>
              {!onMobileBrowse && pickerOpen && pinnedResourceIds.length > 0 && (
                <span className="ml-auto text-xs text-muted-foreground">
                  {t('page.groupPinnedSelectedCount', { count: pinnedResourceIds.length })}
                </span>
              )}
            </button>

            {/* 内联资源选择区（原 Portal 右侧抽屉内联化；grid-rows 展开动画，遵循 D 报告动效基线） */}
            {!onMobileBrowse && (
              <div
                className={cn(
                  'grid transition-[grid-template-rows,opacity] duration-200 ease-[var(--dropdown-ease)] motion-reduce:transition-none',
                  pickerOpen ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                )}
              >
                <div className={cn('min-h-0 overflow-hidden', !pickerOpen && 'pointer-events-none')}>
                  <div className="h-[380px] overflow-hidden rounded-[var(--radius-shell-control)] border border-border/50 bg-card">
                    {pickerOpen && (
                      <LearningHubSidebar
                        mode="canvas"
                        hostId="group-picker"
                        sessionActive={pickerOpen}
                        commandsEnabled={false}
                        onClose={() => setPickerOpen(false)}
                        onOpenApp={(item: ResourceListItem) => {
                          togglePinnedResource(item.id);
                        }}
                        className="h-full"
                        highlightedIds={pinnedHighlightSet}
                      />
                    )}
                  </div>
                </div>
              </div>
            )}

            {resolvedPinnedRefs.length > 0 && (
              <p className="text-xs text-muted-foreground/60">
                {t('page.groupPinnedResourcesHint')}
              </p>
            )}
          </div>

          {mode === 'edit' && onArchive && (
            <div className="pt-6 border-t border-border/40">
              <NotionButton
                variant="warning"
                onClick={onArchive}
                className="h-8 px-3"
              >
                <Archive size={14} className="mr-1.5" />
                {t('page.archiveGroup')}
              </NotionButton>
            </div>
          )}
        </div>
      </CustomScrollArea>
    </div>
  );
};

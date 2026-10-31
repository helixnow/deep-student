import { useMemo, useState, useCallback, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { invoke } from '@tauri-apps/api/core';
import { saveSetting, deleteSetting } from '@/utils/settingsApi';
import { cn } from '@/lib/utils';
import { isMobilePlatform } from '@/utils/platform';
import { DsButton } from '@/components/ui/DsButton';
import { showGlobalNotification } from '@/components/UnifiedNotification';
import { assessAuthorizedRootRisk, type AuthorizedRootRisk } from '../runtimeRootRisk';
import {
  buildManagedPermissionTools,
  filterManagedPermissionTools,
  resolveToolOverride,
  resolveToolOverrideEntry,
  selectedOverrideKeysForReset,
  type ToolLevelFilter,
  type ToolOverrideFilter,
  type ManagedPermissionTool,
} from '../toolPermissionModel';
import { stripMcpPrefix } from './utils';
import { useAppConfirm } from './useAppConfirm';
import {
  SENSITIVITY_CONFIG,
  TOOL_CAPABILITIES,
  type RuntimeRootEntry,
  type SensitivityLevel,
  type ToolOverrideEntry,
} from './toolPermissionTypes';
import type { McpCachedTool } from './types';

/** ToolPermissionsSection 的状态、数据加载与操作（自组件体原样抽出，hooks 顺序不变） */
export function useToolPermissions(toolsByServer: Record<string, { items: McpCachedTool[]; at?: number }>) {
  const { t } = useTranslation(['settings', 'common']);
  const [isLoading, setIsLoading] = useState(true);
  const [globalBypass, setGlobalBypass] = useState(false);
  const [toolOverrides, setToolOverrides] = useState<ToolOverrideEntry[]>([]);
  const [sourceOverrides, setSourceOverrides] = useState<Map<string, SensitivityLevel>>(new Map());
  const [domainOverrides, setDomainOverrides] = useState<Map<string, SensitivityLevel>>(new Map());
  const [historyCount, setHistoryCount] = useState(0);
  const [runtimeRoots, setRuntimeRoots] = useState<RuntimeRootEntry[]>([]);
  const [newRuntimeRootPath, setNewRuntimeRootPath] = useState('');
  const [workspaceAccess, setWorkspaceAccess] = useState<'read_only' | 'read_write'>('read_only');
  const [isSavingRuntimeRoot, setIsSavingRuntimeRoot] = useState(false);
  const [toolSearch, setToolSearch] = useState('');
  const [sourceFilter, setSourceFilter] = useState('all');
  const [levelFilter, setLevelFilter] = useState<ToolLevelFilter>('all');
  const [overrideFilter, setOverrideFilter] = useState<ToolOverrideFilter>('all');
  const [showAdvancedTools, setShowAdvancedTools] = useState(false);
  const [groupMode, setGroupMode] = useState<'domain' | 'source'>('domain');
  const [selectedTools, setSelectedTools] = useState<Set<string>>(new Set());
  const [isBulkUpdating, setIsBulkUpdating] = useState(false);
  const { appConfirm, confirmDialog } = useAppConfirm();
  /** 待确认的高风险授权（两步确认：第一次点添加只显示警示，再点才真正授权） */
  const [pendingRootRisk, setPendingRootRisk] = useState<Exclude<AuthorizedRootRisk, 'safe'> | null>(null);
  const runtimeRootInputRef = useRef<HTMLInputElement>(null);

  /** 每个来源/工具对都是独立权限主体，同名工具不会跨服务串权。 */
  const allTools = useMemo(
    () => buildManagedPermissionTools(toolsByServer),
    [toolsByServer]
  );

  useEffect(() => {
    const validIds = new Set(allTools.map(tool => tool.id));
    setSelectedTools(prev => new Set(Array.from(prev).filter(id => validIds.has(id))));
  }, [allTools]);

  const overrideMap = useMemo(
    () => new Map(toolOverrides.map(override => [override.toolName, override.level])),
    [toolOverrides]
  );
  const toolById = useMemo(
    () => new Map(allTools.map(tool => [tool.id, tool])),
    [allTools]
  );

  const resolveConfiguredPolicy = useCallback((tool: ManagedPermissionTool) => {
    const direct = resolveToolOverrideEntry(tool, overrideMap);
    if (direct) return { level: direct.level, origin: direct.scoped ? 'tool' : 'legacy' } as const;
    const sourceLevel = sourceOverrides.get(tool.source);
    if (sourceLevel) return { level: sourceLevel, origin: 'source' } as const;
    const domainLevel = domainOverrides.get(tool.domain);
    if (domainLevel) return { level: domainLevel, origin: 'domain' } as const;
    if (globalBypass) return { level: 'low' as const, origin: 'global' } as const;
    return { level: null, origin: 'default' } as const;
  }, [domainOverrides, globalBypass, overrideMap, sourceOverrides]);

  const effectiveLevelMap = useMemo(() => {
    const levels = new Map<string, SensitivityLevel>();
    for (const tool of allTools) {
      const level = resolveConfiguredPolicy(tool).level;
      if (level) levels.set(tool.id, level);
    }
    return levels;
  }, [allTools, resolveConfiguredPolicy]);

  const availableSources = useMemo(() => (
    Array.from(new Set(allTools.map(tool => tool.source))).sort((a, b) => a.localeCompare(b))
  ), [allTools]);

  const filteredTools = useMemo(() => filterManagedPermissionTools(allTools, effectiveLevelMap, {
    query: toolSearch,
    source: sourceFilter,
    level: levelFilter,
    override: overrideFilter,
  }, overrideMap), [allTools, effectiveLevelMap, levelFilter, overrideFilter, overrideMap, sourceFilter, toolSearch]);

  useEffect(() => {
    setSelectedTools(new Set());
  }, [levelFilter, overrideFilter, sourceFilter, toolSearch]);

  const capabilityGroups = useMemo(() => TOOL_CAPABILITIES
    .map(capability => ({
      capability,
      tools: filteredTools.filter(tool => tool.capability === capability),
    }))
    .filter(group => group.tools.length > 0), [filteredTools]);

  /** 从后端加载所有权限配置 */
  const fetchConfig = useCallback(async () => {
    setIsLoading(true);
    try {
      const results = await invoke<[string, string, string][]>('get_settings_by_prefix', {
        prefix: 'tool_approval.',
      });
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_list_runtime_roots').catch((err) => {
        console.error('[ToolPermissions] Failed to load runtime roots:', err);
        return [] as RuntimeRootEntry[];
      });

      let bypass = false;
      const overrides: ToolOverrideEntry[] = [];
      const sources = new Map<string, SensitivityLevel>();
      const domains = new Map<string, SensitivityLevel>();
      let histCount = 0;

      for (const [key, value] of results) {
        if (key === 'tool_approval.global_bypass') {
          bypass = value === 'true';
        } else if (key.startsWith('tool_approval.override.')) {
          const toolName = key.slice('tool_approval.override.'.length);
          const level = (['low', 'medium', 'high'].includes(value) ? value : 'medium') as SensitivityLevel;
          overrides.push({
            toolName,
            displayName: stripMcpPrefix(toolName),
            level,
          });
        } else if (key.startsWith('tool_approval.source.')) {
          const source = key.slice('tool_approval.source.'.length);
          if (source && ['low', 'medium', 'high'].includes(value)) {
            sources.set(source, value as SensitivityLevel);
          }
        } else if (key.startsWith('tool_approval.domain.')) {
          const domain = key.slice('tool_approval.domain.'.length);
          if (domain && ['low', 'medium', 'high'].includes(value)) {
            domains.set(domain, value as SensitivityLevel);
          }
        } else if (key.startsWith('tool_approval.scope.')) {
          histCount++;
        }
      }

      setGlobalBypass(bypass);
      setToolOverrides(overrides);
      setSourceOverrides(sources);
      setDomainOverrides(domains);
      setHistoryCount(histCount);
      setRuntimeRoots(roots);
    } catch (err) {
      console.error('[ToolPermissions] Failed to load config:', err);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // 组件挂载时自动加载
  useEffect(() => {
    fetchConfig();
  }, [fetchConfig]);

  /** 切换全局免审批开关 */
  const handleToggleGlobalBypass = useCallback(async (checked: boolean) => {
    const newVal = checked;
    if (newVal && !(await appConfirm(t('settings:tool_permissions.bypass_enable_confirm', { count: allTools.length })))) return;
    try {
      await saveSetting('tool_approval.global_bypass', newVal ? 'true' : 'false',);
      setGlobalBypass(newVal);
      showGlobalNotification(
        'success',
        t(newVal
          ? 'settings:tool_permissions.bypass_enabled'
          : 'settings:tool_permissions.bypass_disabled')
      );
    } catch (err) {
      console.error('[ToolPermissions] Toggle global bypass failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.toggle_failed'));
    }
  }, [allTools.length, appConfirm, t]);

  /** 设置单个工具的等级覆盖 */
  const handleSetOverride = useCallback(async (toolName: string, level: SensitivityLevel) => {
    const key = `tool_approval.override.${toolName}`;
    try {
      await saveSetting(key, level);
      setToolOverrides(prev => {
        const existing = prev.find(o => o.toolName === toolName);
        if (existing) {
          return prev.map(o => o.toolName === toolName ? { ...o, level } : o);
        }
        return [...prev, { toolName, displayName: stripMcpPrefix(toolName), level }];
      });
    } catch (err) {
      console.error('[ToolPermissions] Set override failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.toggle_failed'));
    }
  }, [t]);

  /** 删除单个工具的等级覆盖（恢复默认） */
  const handleRemoveOverride = useCallback(async (toolName: string) => {
    const key = `tool_approval.override.${toolName}`;
    try {
      await deleteSetting(key);
      setToolOverrides(prev => prev.filter(o => o.toolName !== toolName));
    } catch (err) {
      console.error('[ToolPermissions] Remove override failed:', err);
    }
  }, []);

  /** 批量更新沿用现有单工具设置键，支持能力域和多选操作。 */
  const handleBulkOverride = useCallback(async (
    toolIds: string[],
    level: SensitivityLevel | null
  ) => {
    const ids = Array.from(new Set(toolIds));
    if (ids.length === 0 || isBulkUpdating) return;
    if (level === 'low' && ids.length > 1) {
      if (!(await appConfirm(t('settings:tool_permissions.bulk_low_confirm', { count: ids.length })))) return;
    }
    const settingKeys = level
      ? ids.map(id => `tool_approval.override.${id}`)
      : selectedOverrideKeysForReset(allTools, new Set(ids), overrideMap);
    if (settingKeys.length === 0) return;
    setIsBulkUpdating(true);
    try {
      const results = await Promise.allSettled(settingKeys.map(key => {
        return level
          ? saveSetting(key, level)
          : deleteSetting(key);
      }));
      const succeededKeys = settingKeys.filter((_, index) => results[index].status === 'fulfilled');
      const failedKeys = new Set(settingKeys.filter((_, index) => results[index].status === 'rejected'));
      const succeededIds = succeededKeys.map(key => key.slice('tool_approval.override.'.length));
      const succeededSet = new Set(succeededIds);
      setToolOverrides(prev => {
        const unchanged = prev.filter(override => !succeededSet.has(override.toolName));
        if (!level) return unchanged;
        return [
          ...unchanged,
          ...succeededIds.map(toolName => ({
            toolName,
            displayName: stripMcpPrefix(toolName),
            level,
          })),
        ];
      });
      setSelectedTools(prev => {
        const next = new Set(prev);
        for (const id of ids) {
          const expectedKey = level
            ? `tool_approval.override.${id}`
            : (() => {
                const tool = toolById.get(id);
                const entry = tool ? resolveToolOverrideEntry(tool, overrideMap) : null;
                return entry ? `tool_approval.override.${entry.id}` : null;
              })();
          if (expectedKey && !failedKeys.has(expectedKey)) next.delete(id);
        }
        return next;
      });
      if (succeededKeys.length !== settingKeys.length) {
        showGlobalNotification('error', t('settings:tool_permissions.bulk_partial_failed', {
          success: succeededKeys.length,
          total: settingKeys.length,
        }));
      } else {
        showGlobalNotification('success', t('settings:tool_permissions.bulk_updated', {
          count: level ? ids.length : succeededKeys.length,
        }));
      }
    } finally {
      setIsBulkUpdating(false);
    }
  }, [allTools, appConfirm, isBulkUpdating, overrideMap, t, toolById]);

  const handleSetGroupOverride = useCallback(async (
    kind: 'source' | 'domain',
    group: string,
    level: SensitivityLevel | null
  ) => {
    if (isBulkUpdating) return;
    const affectedCount = allTools.filter(tool => (
      kind === 'source' ? tool.source === group : tool.domain === group
    )).length;
    if (level === 'low') {
      if (!(await appConfirm(t('settings:tool_permissions.group_low_confirm', { count: affectedCount })))) return;
    }
    const key = `tool_approval.${kind}.${group}`;
    setIsBulkUpdating(true);
    try {
      if (level) await saveSetting(key, level);
      else await deleteSetting(key);
      const setMap = kind === 'source' ? setSourceOverrides : setDomainOverrides;
      setMap(prev => {
        const next = new Map(prev);
        if (level) next.set(group, level);
        else next.delete(group);
        return next;
      });
      showGlobalNotification('success', t('settings:tool_permissions.group_updated'));
    } catch (err) {
      console.error('[ToolPermissions] Set group override failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.toggle_failed'));
    } finally {
      setIsBulkUpdating(false);
    }
  }, [allTools, appConfirm, isBulkUpdating, t]);

  const toggleToolSelection = useCallback((toolName: string, selected: boolean) => {
    setSelectedTools(prev => {
      const next = new Set(prev);
      if (selected) next.add(toolName);
      else next.delete(toolName);
      return next;
    });
  }, []);

  const selectVisibleTools = useCallback((selected: boolean) => {
    setSelectedTools(prev => {
      const next = new Set(prev);
      for (const tool of filteredTools) {
        if (selected) next.add(tool.id);
        else next.delete(tool.id);
      }
      return next;
    });
  }, [filteredTools]);

  /** 清除所有历史审批记录（DB + 内存） */
  const handleClearHistory = useCallback(async () => {
    if (!(await appConfirm(t('settings:tool_permissions.clear_history_confirm')))) return;
    try {
      // 🔧 R2-H2 修复：调用统一命令，同时清内存 + DB。
      // 旧实现 `delete_settings_by_prefix` 只清 DB，ApprovalManager 内存 HashMap
      // 还留着，未重启进程期间前面的批准继续自动通过，违背"清除"承诺。
      const result = await invoke<number>('chat_v2_clear_approval_history');
      setHistoryCount(0);
      showGlobalNotification(
        'success',
        t('settings:tool_permissions.clear_history_success', { count: result })
      );
    } catch (err) {
      console.error('[ToolPermissions] Clear history failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.clear_all_failed'));
    }
  }, [appConfirm, t]);

  const handleAuthorizeRuntimeRoot = useCallback(async () => {
    const path = newRuntimeRootPath.trim();
    if (!path || isSavingRuntimeRoot) return;
    // 高风险目录两步确认：第一次提交只展示内联警示（不阻止授权），再次提交才真正执行
    const risk = assessAuthorizedRootRisk(path);
    if (risk !== 'safe' && pendingRootRisk === null) {
      setPendingRootRisk(risk);
      return;
    }
    setIsSavingRuntimeRoot(true);
    try {
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_authorize_runtime_root', { path });
      setRuntimeRoots(roots);
      setNewRuntimeRootPath('');
      setPendingRootRisk(null);
      showGlobalNotification('success', t('settings:tool_permissions.runtime_root_added'));
    } catch (err) {
      console.error('[ToolPermissions] Authorize runtime root failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.runtime_root_add_failed'));
    } finally {
      setIsSavingRuntimeRoot(false);
    }
  }, [isSavingRuntimeRoot, newRuntimeRootPath, pendingRootRisk, t]);

  const handleSetWorkspaceRoot = useCallback(async () => {
    const path = newRuntimeRootPath.trim();
    if (!path || isSavingRuntimeRoot) return;
    setIsSavingRuntimeRoot(true);
    try {
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_set_workspace_root', {
        path,
        access: workspaceAccess,
      });
      setRuntimeRoots(roots);
      setNewRuntimeRootPath('');
      showGlobalNotification('success', t('settings:tool_permissions.runtime_root_workspace_set'));
    } catch (err) {
      console.error('[ToolPermissions] Set workspace root failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.runtime_root_workspace_set_failed'));
    } finally {
      setIsSavingRuntimeRoot(false);
    }
  }, [isSavingRuntimeRoot, newRuntimeRootPath, t, workspaceAccess]);

  const handleResetWorkspaceRoot = useCallback(async () => {
    try {
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_reset_workspace_root');
      setRuntimeRoots(roots);
      showGlobalNotification('success', t('settings:tool_permissions.runtime_root_workspace_reset_done'));
    } catch (err) {
      console.error('[ToolPermissions] Reset workspace root failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.runtime_root_workspace_reset_failed'));
    }
  }, [t]);

  const handleRevokeRuntimeRoot = useCallback(async (rootId: string) => {
    try {
      const roots = await invoke<RuntimeRootEntry[]>('chat_v2_revoke_runtime_root', { rootId });
      setRuntimeRoots(roots);
      showGlobalNotification('success', t('settings:tool_permissions.runtime_root_removed'));
    } catch (err) {
      console.error('[ToolPermissions] Revoke runtime root failed:', err);
      showGlobalNotification('error', t('settings:tool_permissions.runtime_root_remove_failed'));
    }
  }, [t]);

  /** 「立即设置」引导：滚动并聚焦到已有的路径输入框（旁边就是浏览按钮） */
  const handleFocusRuntimeRootInput = useCallback(() => {
    const input = runtimeRootInputRef.current;
    if (!input) return;
    input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    input.focus({ preventScroll: true });
  }, []);

  /** 打开系统目录选择器，把选中的目录填入路径输入框 */
  const handleBrowseRuntimeRoot = useCallback(async () => {
    try {
      const { open: dialogOpen } = await import('@tauri-apps/plugin-dialog');
      const selected = await dialogOpen({
        directory: true,
        multiple: false,
        title: t('settings:tool_permissions.runtime_root_browse_title'),
      });
      if (typeof selected === 'string' && selected.trim()) {
        setNewRuntimeRootPath(selected);
        setPendingRootRisk(null);
      }
    } catch (err) {
      console.error('[ToolPermissions] Browse runtime root failed:', err);
    }
  }, [t]);

  /** 高风险警示的「重新选择」：清空输入并重开目录选择器 */
  const handleReselectRuntimeRoot = useCallback(() => {
    setPendingRootRisk(null);
    setNewRuntimeRootPath('');
    // 移动端没有目录选择器：清空后把焦点交回路径输入框
    if (isMobilePlatform()) {
      handleFocusRuntimeRootInput();
      return;
    }
    void handleBrowseRuntimeRoot();
  }, [handleBrowseRuntimeRoot, handleFocusRuntimeRootInput]);

  /** 按钮组：等级选择器 */
  const LevelSelector = useCallback(({ toolName, currentLevel, resetOverrideId }: {
    toolName: string;
    currentLevel: SensitivityLevel | null;
    resetOverrideId?: string;
  }) => {
    const levels: SensitivityLevel[] = ['low', 'medium', 'high'];
    return (
      <div className="flex items-center gap-0.5 bg-muted/40 rounded-md p-0.5" role="group" aria-label={t('settings:tool_permissions.level_filter')}>
        {levels.map(level => {
          const isActive = currentLevel === level;
          const config = SENSITIVITY_CONFIG[level];
          return (
            <DsButton
              key={level}
              variant="ghost"
              size="sm"
              disabled={isBulkUpdating}
              aria-pressed={isActive}
              onClick={() => {
                if (isActive) {
                  handleRemoveOverride(resetOverrideId ?? toolName);
                } else {
                  handleSetOverride(toolName, level);
                }
              }}
              className={cn(
                '!h-auto !px-2 !py-0.5 text-xs font-medium [@media(pointer:coarse)]:!min-h-11',
                isActive
                  ? config.badge
                  : 'text-muted-foreground hover:text-foreground hover:bg-[var(--interactive-hover)]'
              )}
              title={isActive
                ? t('settings:tool_permissions.reset_to_default')
                : t(`settings:tool_permissions.set_to_${level}`)}
            >
              {t(`settings:tool_permissions.level_${level}`)}
            </DsButton>
          );
        })}
      </div>
    );
  }, [handleSetOverride, handleRemoveOverride, isBulkUpdating, t]);

  const BulkLevelSelector = useCallback(({ toolNames }: { toolNames: string[] }) => {
    const configuredLevels = toolNames.map(id => {
      const tool = toolById.get(id);
      return tool ? resolveToolOverride(tool, overrideMap) : null;
    });
    const firstLevel = configuredLevels[0] ?? null;
    const sharedLevel = configuredLevels.every(level => level === firstLevel) ? firstLevel : null;
    const allInherited = configuredLevels.every(level => level === null);
    const levels: Array<SensitivityLevel | 'default'> = ['default', 'low', 'medium', 'high'];

    return (
      <div className="flex items-center gap-0.5 bg-muted/40 rounded-md p-0.5" role="group" aria-label={t('settings:tool_permissions.bulk_level_label')}>
        {levels.map(level => {
          const active = level === 'default' ? allInherited : sharedLevel === level;
          return (
            <DsButton
              key={level}
              variant="ghost"
              size="sm"
              disabled={isBulkUpdating}
              aria-pressed={active}
              onClick={() => void handleBulkOverride(toolNames, level === 'default' ? null : level)}
              className={cn(
                '!h-6 !px-1.5 text-xs font-medium [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-2.5',
                active && level === 'default' && 'bg-background text-foreground shadow-sm',
                active && level !== 'default' && SENSITIVITY_CONFIG[level].badge,
                !active && 'text-muted-foreground hover:text-foreground'
              )}
              title={level === 'default'
                ? t('settings:tool_permissions.reset_group_to_default')
                : t(`settings:tool_permissions.set_group_to_${level}`)}
            >
              {level === 'default'
                ? t('settings:tool_permissions.level_default')
                : t(`settings:tool_permissions.level_${level}`)}
            </DsButton>
          );
        })}
      </div>
    );
  }, [handleBulkOverride, isBulkUpdating, overrideMap, t, toolById]);

  const GroupLevelSelector = useCallback(({ kind, group, currentLevel }: {
    kind: 'source' | 'domain';
    group: string;
    currentLevel: SensitivityLevel | null;
  }) => {
    const levels: Array<SensitivityLevel | 'default'> = ['default', 'low', 'medium', 'high'];
    return (
      <div className="flex items-center gap-0.5 bg-muted/40 rounded-md p-0.5" role="group" aria-label={t('settings:tool_permissions.group_level_label', { group })}>
        {levels.map(level => {
          const active = level === 'default' ? currentLevel === null : currentLevel === level;
          return (
            <DsButton
              key={level}
              variant="ghost"
              size="sm"
              disabled={isBulkUpdating}
              aria-pressed={active}
              onClick={() => void handleSetGroupOverride(kind, group, level === 'default' ? null : level)}
              className={cn(
                '!h-6 !px-1.5 text-xs font-medium [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-2.5',
                active && level === 'default' && 'bg-background text-foreground shadow-sm',
                active && level !== 'default' && SENSITIVITY_CONFIG[level].badge,
                !active && 'text-muted-foreground hover:text-foreground'
              )}
            >
              {level === 'default'
                ? t('settings:tool_permissions.level_default')
                : t(`settings:tool_permissions.level_${level}`)}
            </DsButton>
          );
        })}
      </div>
    );
  }, [handleSetGroupOverride, isBulkUpdating, t]);

  const selectedVisibleCount = filteredTools.filter(tool => selectedTools.has(tool.id)).length;
  const allVisibleSelected = filteredTools.length > 0 && selectedVisibleCount === filteredTools.length;
  const configuredToolCount = allTools.filter(tool => resolveConfiguredPolicy(tool).level !== null).length;
  const policyGroups = useMemo(() => {
    const groups = new Map<string, ManagedPermissionTool[]>();
    for (const tool of allTools) {
      const key = groupMode === 'source' ? tool.source : tool.domain;
      const groupTools = groups.get(key) ?? [];
      groupTools.push(tool);
      groups.set(key, groupTools);
    }
    return Array.from(groups.entries()).sort(([left], [right]) => left.localeCompare(right));
  }, [allTools, groupMode]);

  return {
    t, isLoading, globalBypass, toolOverrides,
    sourceOverrides, domainOverrides, historyCount, runtimeRoots,
    newRuntimeRootPath, setNewRuntimeRootPath, workspaceAccess, setWorkspaceAccess,
    isSavingRuntimeRoot, toolSearch, setToolSearch, sourceFilter,
    setSourceFilter, levelFilter, setLevelFilter, overrideFilter,
    setOverrideFilter, showAdvancedTools, setShowAdvancedTools, groupMode,
    setGroupMode, selectedTools, setSelectedTools, isBulkUpdating,
    confirmDialog, pendingRootRisk, setPendingRootRisk, runtimeRootInputRef,
    allTools, overrideMap, resolveConfiguredPolicy, availableSources,
    filteredTools, capabilityGroups, fetchConfig, handleToggleGlobalBypass,
    toggleToolSelection, selectVisibleTools, handleClearHistory, handleAuthorizeRuntimeRoot,
    handleSetWorkspaceRoot, handleResetWorkspaceRoot, handleRevokeRuntimeRoot, handleFocusRuntimeRootInput,
    handleBrowseRuntimeRoot, handleReselectRuntimeRoot, LevelSelector, BulkLevelSelector,
    GroupLevelSelector, selectedVisibleCount, allVisibleSelected, configuredToolCount,
    policyGroups,
  };
}

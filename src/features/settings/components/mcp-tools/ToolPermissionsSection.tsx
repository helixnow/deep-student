import { cn } from '@/lib/utils';
import { isMobilePlatform } from '@/utils/platform';
import { Plus, ArrowClockwise, Trash, Check, Package, Lock, Shield, ShieldCheck, FolderOpen, Warning, MagnifyingGlass, Funnel, CaretRight, Stack } from '@phosphor-icons/react';
import { DsButton } from '@/components/ui/DsButton';
import { Switch } from '@/components/ui/shad/Switch';
import { Input } from '@/components/ui/shad/Input';
import { Checkbox } from '@/components/ui/shad/Checkbox';
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '@/components/ui/shad/Select';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import {
  formatToolSource,
  resolveToolOverrideEntry,
  type ToolLevelFilter,
  type ToolOverrideFilter,
} from '../toolPermissionModel';
import { TECHNICAL_INPUT_PROPS } from '@/components/ui/shad/technicalInputProps';
import { isComposingKeyEvent } from '@/utils/isComposingKeyEvent';
import { ShellCommandRulesSection } from './ShellCommandRulesSection';
import { SENSITIVITY_CONFIG } from './toolPermissionTypes';
import { useToolPermissions } from './useToolPermissions';
import type { McpCachedTool } from './types';

/** 工具权限管理区域；embedded 时由外层折叠头承载标题，避免双标题与双分隔线 */
export function ToolPermissionsSection({ toolsByServer, embedded = false }: {
  toolsByServer: Record<string, { items: McpCachedTool[]; at?: number }>;
  embedded?: boolean;
}) {
  const {
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
  } = useToolPermissions(toolsByServer);

  return (
    <div
      id="settings-tool-permissions"
      className={cn(
        'min-w-0 max-w-full',
        embedded
          ? 'mt-3'
          : 'mt-8 scroll-mt-6 border-t border-border/40 pt-6 [content-visibility:auto] [contain-intrinsic-size:auto_720px]',
      )}
    >
      {!embedded && (
        <h3 className="mb-4 text-sm font-medium text-foreground">
          {t('settings:tool_permissions.title')}
        </h3>
      )}

      {isLoading ? (
        <div className="space-y-3">
          <div className="h-16 bg-muted/30 rounded-lg animate-pulse" />
          <div className="h-40 bg-muted/30 rounded-lg animate-pulse" />
        </div>
      ) : (
        <div className="space-y-5">
          {/* 1. 全局免审批开关 */}
          <div
            className={cn(
              'p-4 rounded-lg border transition-colors duration-200',
              globalBypass
                ? 'border-primary/30 bg-primary/5'
                : 'border-border/40 bg-muted/20 hover:border-border/60'
            )}
          >
            <div className="flex items-center justify-between">
              <div className="min-w-0 flex-1 mr-4">
                <div className="flex items-center gap-2 mb-1">
                  <ShieldCheck className="h-4 w-4 text-muted-foreground" />
                  <span className="text-sm font-medium text-foreground">
                    {t('settings:tool_permissions.global_bypass_title')}
                  </span>
                  {globalBypass && (
                    <span className="text-xs bg-success/10 text-success px-1.5 py-0.5 rounded-full">
                      {t('settings:tool_permissions.bypass_badge')}
                    </span>
                  )}
                </div>
                <p className="text-xs text-muted-foreground leading-relaxed">
                  {t('settings:tool_permissions.global_bypass_desc')}
                </p>
              </div>
              <Switch
                checked={globalBypass}
                onCheckedChange={handleToggleGlobalBypass}
                aria-label={t('settings:tool_permissions.global_bypass_title')}
                title={t('settings:tool_permissions.global_bypass_title')}
              />
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2 min-w-0">
                <Lock className="h-3.5 w-3.5 text-muted-foreground flex-shrink-0" />
                <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                  {t('settings:tool_permissions.runtime_roots_title')}
                </h4>
                <span className="text-xs text-muted-foreground">
                  ({runtimeRoots.length})
                </span>
              </div>
            </div>

            <p className="text-xs text-muted-foreground mb-3">
              {t('settings:tool_permissions.runtime_roots_desc')}
            </p>

            <div className="mb-3 flex min-w-0 flex-col lg:flex-row gap-2">
              <Input
                ref={runtimeRootInputRef}
                {...TECHNICAL_INPUT_PROPS}
                value={newRuntimeRootPath}
                onChange={(event) => {
                  setNewRuntimeRootPath(event.target.value);
                  setPendingRootRisk(null);
                }}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && !isComposingKeyEvent(event)) {
                    event.preventDefault();
                    void handleAuthorizeRuntimeRoot();
                  }
                }}
                placeholder={t('settings:tool_permissions.runtime_root_path_placeholder')}
                className="min-w-0 font-mono lg:basis-0 lg:flex-1 [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:text-[16px]"
              />
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <Select
                  value={workspaceAccess}
                  onValueChange={(value) => setWorkspaceAccess(value as 'read_only' | 'read_write')}
                >
                  <SelectTrigger className="w-[8.5rem] [@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:text-[16px]" aria-label={t('settings:tool_permissions.runtime_root_workspace_access')}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="read_only">{t('settings:tool_permissions.runtime_root_read_only')}</SelectItem>
                    <SelectItem value="read_write">{t('settings:tool_permissions.runtime_root_read_write')}</SelectItem>
                  </SelectContent>
                </Select>
                {/* 系统目录选择器在移动端未实现（FolderPickerNotImplemented），
                    移动端只能手动输入路径。 */}
                {!isMobilePlatform() && (
                  <DsButton
                    variant="outline"
                    size="sm"
                    onClick={handleBrowseRuntimeRoot}
                    disabled={isSavingRuntimeRoot}
                    className="flex-shrink-0 [@media(pointer:coarse)]:!min-h-11"
                  >
                    <FolderOpen className="h-3 w-3 mr-1" />
                    {t('settings:tool_permissions.runtime_root_browse')}
                  </DsButton>
                )}
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleSetWorkspaceRoot}
                  disabled={!newRuntimeRootPath.trim() || isSavingRuntimeRoot}
                  className="text-xs flex-shrink-0 [@media(pointer:coarse)]:!min-h-11"
                >
                  <Check className="h-3 w-3 mr-1" />
                  {t('settings:tool_permissions.runtime_root_set_workspace')}
                </DsButton>
                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={handleAuthorizeRuntimeRoot}
                  disabled={!newRuntimeRootPath.trim() || isSavingRuntimeRoot}
                  className={cn(
                    'text-xs flex-shrink-0 [@media(pointer:coarse)]:!min-h-11',
                    pendingRootRisk && 'text-warning'
                  )}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  {t(pendingRootRisk
                    ? 'settings:tool_permissions.runtime_root_confirm_add'
                    : 'settings:tool_permissions.runtime_root_add')}
                </DsButton>
              </div>
            </div>

            {workspaceAccess === 'read_write' && (
              <div className="mb-3 flex items-start gap-2 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-warning">
                <Warning className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                <span>{t('settings:tool_permissions.runtime_root_workspace_write_warning')}</span>
              </div>
            )}

            {pendingRootRisk && (
              <div className="mb-3 rounded-md border border-warning/30 bg-warning/5 px-3 py-2 text-xs leading-relaxed text-warning">
                <div className="flex items-start gap-2">
                  <Warning className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" />
                  <div className="min-w-0 flex-1">
                    <span>
                      {pendingRootRisk === 'critical'
                        ? t('settings:tool_permissions.runtime_root_risk_critical', { path: newRuntimeRootPath.trim() })
                        : t('settings:tool_permissions.runtime_root_risk_broad', {
                            folder: newRuntimeRootPath.trim().replace(/\\/g, '/').split('/').filter(Boolean).pop()
                              ?? newRuntimeRootPath.trim(),
                          })}
                    </span>
                    <DsButton
                      variant="ghost"
                      size="sm"
                      onClick={handleReselectRuntimeRoot}
                      className="!h-auto !px-1 !py-0 ml-1 align-baseline text-xs font-medium text-primary hover:underline [@media(pointer:coarse)]:!min-h-11"
                    >
                      {t('settings:tool_permissions.runtime_root_reselect')}
                    </DsButton>
                  </div>
                </div>
              </div>
            )}

            {runtimeRoots.length === 0 ? (
              <div className="py-5 px-4 rounded-lg border border-dashed border-border/60 bg-muted/5">
                <Lock className="h-5 w-5 text-muted-foreground/40 mb-2" />
                <p className="text-xs text-muted-foreground">
                  {t('settings:tool_permissions.runtime_roots_empty')}
                </p>
                <p className="mt-1 text-xs text-muted-foreground/80 leading-relaxed px-4">
                  {t('settings:tool_permissions.runtime_roots_authorized_empty_hint')}
                </p>
              </div>
            ) : (
              <div className="rounded-lg border border-border/30 bg-muted/5 overflow-hidden">
                <div className="divide-y divide-border/30">
                  {runtimeRoots.map((root) => {
                    const isReadWrite = root.access === 'read_write';
                    const canRevoke = root.kind === 'authorized';
                    const canResetWorkspace = root.kind === 'workspace' && root.configured;
                    const displayKind = t(
                      `settings:tool_permissions.runtime_root_kind.${root.kind}`,
                      root.kind.replace(/_/g, ' '),
                    );
                    return (
                      <div key={root.id} className="px-3 py-2.5 flex items-start gap-3">
                        <div className="mt-0.5 h-7 w-7 rounded-md bg-muted/40 border border-border/30 flex items-center justify-center flex-shrink-0">
                          {root.kind === 'artifact' || root.kind === 'temp' ? (
                            <Package className="h-3.5 w-3.5 text-muted-foreground" />
                          ) : (
                            <Lock className="h-3.5 w-3.5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-sm font-medium text-foreground truncate">
                              {root.label || root.id}
                            </span>
                            <span className="text-2xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground border border-border/40 capitalize">
                              {displayKind}
                            </span>
                            <span
                              className="inline-block max-w-[12rem] truncate text-2xs px-1.5 py-0.5 rounded bg-muted/50 text-muted-foreground border border-border/30 font-mono normal-case"
                              title={root.id}
                            >
                              {root.id}
                            </span>
                            <span
                              className={cn(
                                'text-2xs px-1.5 py-0.5 rounded border',
                                isReadWrite
                                  ? 'bg-warning/10 text-warning border-warning/25'
                                  : 'bg-success/10 text-success border-success/25'
                              )}
                            >
                              {t(isReadWrite
                                ? 'settings:tool_permissions.runtime_root_read_write'
                                : 'settings:tool_permissions.runtime_root_read_only')}
                            </span>
                            {root.session_scoped && (
                              <span className="text-2xs px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                                {t('settings:tool_permissions.runtime_root_session_scoped')}
                              </span>
                            )}
                            {root.kind === 'workspace' && root.configured && (
                              <span className="text-2xs px-1.5 py-0.5 rounded bg-primary/10 text-primary border border-primary/20">
                                {t('settings:tool_permissions.runtime_root_configured')}
                              </span>
                            )}
                            {root.kind === 'workspace' && !root.configured && (
                              <span className="inline-flex items-center gap-1 text-2xs px-1.5 py-0.5 rounded border bg-warning/10 text-warning border-warning/25">
                                <Warning className="h-3 w-3" />
                                {t('settings:tool_permissions.runtime_root_not_configured')}
                              </span>
                            )}
                          </div>
                          <div className="mt-1 text-xs text-muted-foreground font-mono truncate" title={root.path}>
                            {root.path}
                          </div>
                          {root.description && (
                            <div className="mt-1 text-xs text-muted-foreground/80 leading-relaxed">
                              {root.description}
                            </div>
                          )}
                          {root.kind === 'workspace' && !root.configured && (
                            <div className="mt-1 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs leading-relaxed text-warning">
                              <span>{t('settings:tool_permissions.runtime_root_not_configured_hint')}</span>
                              <DsButton
                                variant="ghost"
                                size="sm"
                                onClick={handleFocusRuntimeRootInput}
                                className="!h-auto !px-1 !py-0 text-xs font-medium text-primary hover:underline [@media(pointer:coarse)]:!min-h-11"
                              >
                                {t('settings:tool_permissions.runtime_root_configure_now')}
                              </DsButton>
                            </div>
                          )}
                        </div>
                        {canRevoke && (
                          <DsButton
                            variant="ghost"
                            size="icon"
                            iconOnly
                            onClick={() => handleRevokeRuntimeRoot(root.id)}
                            className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-muted-foreground hover:text-destructive flex-shrink-0"
                            title={t('settings:tool_permissions.runtime_root_remove')}
                            aria-label={t('settings:tool_permissions.runtime_root_remove')}
                          >
                            <Trash className="h-3.5 w-3.5" />
                          </DsButton>
                        )}
                        {canResetWorkspace && (
                          <DsButton
                            variant="ghost"
                            size="icon"
                            iconOnly
                            onClick={handleResetWorkspaceRoot}
                            className="!h-7 !w-7 [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!w-11 text-muted-foreground flex-shrink-0"
                            title={t('settings:tool_permissions.runtime_root_workspace_reset')}
                            aria-label={t('settings:tool_permissions.runtime_root_workspace_reset')}
                          >
                            <ArrowClockwise className="h-3.5 w-3.5" />
                          </DsButton>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {runtimeRoots.length > 0 && !runtimeRoots.some((root) => root.kind === 'authorized') && (
              <p className="mt-2 text-xs text-muted-foreground/80 leading-relaxed">
                {t('settings:tool_permissions.runtime_roots_authorized_empty_hint')}
              </p>
            )}
          </div>

          <ShellCommandRulesSection />

          {/* 2. 工具策略：默认展示能力域，单工具覆盖收进高级管理。 */}
          <div>
            <div className="flex flex-wrap items-start justify-between gap-2 mb-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Stack className="h-3.5 w-3.5 text-muted-foreground" />
                  <h4 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                    {t('settings:tool_permissions.policy_overview_title')}
                  </h4>
                </div>
                <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                  {t('settings:tool_permissions.policy_overview_desc')}
                </p>
              </div>
              <DsButton
                variant="outline"
                size="sm"
                onClick={fetchConfig}
                disabled={isLoading || isBulkUpdating}
                className="flex-shrink-0 [@media(pointer:coarse)]:!min-h-11"
              >
                <ArrowClockwise className={cn('h-3 w-3 mr-1', (isLoading || isBulkUpdating) && 'animate-spin')} />
                {t('settings:tool_permissions.refresh')}
              </DsButton>
            </div>

            {allTools.length === 0 ? (
              <div className="py-6 px-4 rounded-lg border border-dashed border-border/60 bg-muted/5">
                <Shield className="h-6 w-6 text-muted-foreground/40 mb-2" />
                <p className="text-xs text-muted-foreground">
                  {t('settings:tool_permissions.no_tools')}
                </p>
              </div>
            ) : (
              <>
                <div className="grid grid-cols-3 border-y border-border/30 mb-3">
                  <div className="py-2.5 pr-3">
                    <div className="text-base font-semibold tabular-nums">{allTools.length}</div>
                    <div className="text-xs text-muted-foreground">{t('settings:tool_permissions.summary_tools')}</div>
                  </div>
                  <div className="py-2.5 px-3 border-x border-border/30">
                    <div className="text-base font-semibold tabular-nums">{availableSources.length}</div>
                    <div className="text-xs text-muted-foreground">{t('settings:tool_permissions.summary_sources')}</div>
                  </div>
                  <div className="py-2.5 pl-3">
                    <div className="text-base font-semibold tabular-nums text-primary">{configuredToolCount}</div>
                    <div className="text-xs text-muted-foreground">{t('settings:tool_permissions.summary_overrides')}</div>
                  </div>
                </div>

                <div className="flex items-center justify-between gap-2 mb-2">
                  <span className="text-xs text-muted-foreground">{t('settings:tool_permissions.group_by')}</span>
                  <div className="flex items-center bg-muted/40 rounded-md p-0.5" role="group" aria-label={t('settings:tool_permissions.group_by')}>
                    {(['domain', 'source'] as const).map(mode => (
                      <DsButton
                        key={mode}
                        variant="ghost"
                        size="sm"
                        onClick={() => setGroupMode(mode)}
                        aria-pressed={groupMode === mode}
                        className={cn(
                          '!h-6 !px-2 text-xs [@media(pointer:coarse)]:!h-11 [@media(pointer:coarse)]:!px-3',
                          groupMode === mode && 'bg-background text-foreground shadow-sm'
                        )}
                      >
                        {t(`settings:tool_permissions.group_by_${mode}`)}
                      </DsButton>
                    ))}
                  </div>
                </div>

                <div className="rounded-md border border-border/40 divide-y divide-border/30 overflow-hidden">
                  {policyGroups.map(([group, tools]) => {
                    const overriddenCount = tools.filter(tool => resolveToolOverrideEntry(tool, overrideMap) !== null).length;
                    const currentLevel = groupMode === 'source'
                      ? sourceOverrides.get(group) ?? null
                      : domainOverrides.get(group) ?? null;
                    return (
                      <div key={group} className="flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2.5 hover:bg-muted/20 transition-colors">
                        <div className="flex items-center min-w-0 flex-1 gap-2">
                          <span className="h-2 w-2 rounded-full bg-muted-foreground/40 flex-shrink-0" />
                          <div className="min-w-0">
                            <div className="text-sm font-medium text-foreground truncate" title={group}>
                              {groupMode === 'source' ? formatToolSource(group) : group}
                            </div>
                            <div className="text-xs text-muted-foreground">
                              {t('settings:tool_permissions.group_summary', {
                                count: tools.length,
                                overridden: overriddenCount,
                              })}
                            </div>
                          </div>
                        </div>
                        <div className="self-end sm:self-auto flex-shrink-0">
                          <GroupLevelSelector kind={groupMode} group={group} currentLevel={currentLevel} />
                        </div>
                      </div>
                    );
                  })}
                </div>

                <div className="mt-2 flex items-start gap-1.5 text-xs text-muted-foreground/80 leading-relaxed">
                  <Lock className="h-3.5 w-3.5 mt-px flex-shrink-0" />
                  <span>{t('settings:tool_permissions.dynamic_risk_hint')}</span>
                </div>

                <DsButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setShowAdvancedTools(value => !value)}
                  className="mt-2 !px-1 text-xs [@media(pointer:coarse)]:!min-h-11"
                  aria-expanded={showAdvancedTools}
                >
                  <CaretRight className={cn('h-3.5 w-3.5 mr-1 transition-transform', showAdvancedTools && 'rotate-90')} />
                  {t('settings:tool_permissions.advanced_title')}
                  <span className="ml-1 text-muted-foreground">({toolOverrides.length})</span>
                </DsButton>

                {showAdvancedTools && (
                  <div className="mt-3 border-t border-border/30 pt-3">
                    <div className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
                      <Funnel className="h-3.5 w-3.5" />
                      <span>{t('settings:tool_permissions.filters_title')}</span>
                      <span className="ml-auto tabular-nums">
                        {t('settings:tool_permissions.filtered_count', { count: filteredTools.length })}
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-[minmax(12rem,1fr)_10rem_9rem_9rem] gap-2 mb-3">
                      <div className="relative">
                        <MagnifyingGlass className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground pointer-events-none" />
                        <Input
                          value={toolSearch}
                          onChange={event => setToolSearch(event.target.value)}
                          placeholder={t('settings:tool_permissions.search_placeholder')}
                          aria-label={t('settings:tool_permissions.search_placeholder')}
                          className="h-8 pl-8 text-xs [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:text-[16px]"
                        />
                      </div>
                      <Select value={sourceFilter} onValueChange={setSourceFilter}>
                        <SelectTrigger className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:text-[16px]" aria-label={t('settings:tool_permissions.source_filter')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">{t('settings:tool_permissions.source_all')}</SelectItem>
                          {availableSources.map(source => (
                            <SelectItem key={source} value={source}>{formatToolSource(source)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <Select value={levelFilter} onValueChange={value => setLevelFilter(value as ToolLevelFilter)}>
                        <SelectTrigger className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:text-[16px]" aria-label={t('settings:tool_permissions.level_filter')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">{t('settings:tool_permissions.level_all')}</SelectItem>
                          <SelectItem value="default">{t('settings:tool_permissions.level_default')}</SelectItem>
                          <SelectItem value="low">{t('settings:tool_permissions.level_low')}</SelectItem>
                          <SelectItem value="medium">{t('settings:tool_permissions.level_medium')}</SelectItem>
                          <SelectItem value="high">{t('settings:tool_permissions.level_high')}</SelectItem>
                        </SelectContent>
                      </Select>
                      <Select value={overrideFilter} onValueChange={value => setOverrideFilter(value as ToolOverrideFilter)}>
                        <SelectTrigger className="[@media(pointer:coarse)]:!min-h-11 [@media(pointer:coarse)]:text-[16px]" aria-label={t('settings:tool_permissions.override_filter')}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="all">{t('settings:tool_permissions.override_all')}</SelectItem>
                          <SelectItem value="overridden">{t('settings:tool_permissions.override_only')}</SelectItem>
                          <SelectItem value="inherited">{t('settings:tool_permissions.inherited_only')}</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>

                    {filteredTools.length > 0 && (
                      <div className="flex flex-wrap items-center gap-2 px-3 py-2 bg-muted/20 border border-border/30 rounded-t-md [@media(pointer:coarse)]:min-h-11">
                        <Checkbox
                          checked={allVisibleSelected ? true : selectedVisibleCount > 0 ? 'indeterminate' : false}
                          onCheckedChange={checked => selectVisibleTools(checked === true)}
                          aria-label={t('settings:tool_permissions.select_visible')}
                          className="relative [@media(pointer:coarse)]:before:content-[''] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-3.5"
                        />
                        <span className="text-xs text-muted-foreground">
                          {selectedTools.size > 0
                            ? t('settings:tool_permissions.selected_count', { count: selectedTools.size })
                            : t('settings:tool_permissions.select_visible')}
                        </span>
                        {selectedTools.size > 0 && (
                          <>
                            <div className="ml-auto">
                              <BulkLevelSelector toolNames={Array.from(selectedTools)} />
                            </div>
                            <DsButton
                              variant="outline"
                              size="sm"
                              onClick={() => setSelectedTools(new Set())}
                              className="[@media(pointer:coarse)]:!min-h-11"
                            >
                              {t('settings:tool_permissions.clear_selection')}
                            </DsButton>
                          </>
                        )}
                      </div>
                    )}

                    {filteredTools.length === 0 ? (
                      <div className="py-8 px-4 border border-dashed border-border/50 rounded-md text-xs text-muted-foreground">
                        {t('settings:tool_permissions.no_matching_tools')}
                      </div>
                    ) : (
                      <CustomScrollArea
                        className="h-[min(480px,60dvh)] rounded-b-md border-x border-b border-border/30"
                      >
                        <div className="divide-y divide-border/20">
                          {capabilityGroups.flatMap(group => group.tools).map(tool => {
                            const overrideEntry = resolveToolOverrideEntry(tool, overrideMap);
                            const policy = resolveConfiguredPolicy(tool);
                            const statusKey = policy.origin === 'tool' || policy.origin === 'legacy'
                              ? 'status_overridden'
                              : `status_${policy.origin}`;
                            return (
                              <div
                                key={tool.id}
                                className={cn(
                                  'flex flex-col sm:flex-row sm:items-center gap-2 px-3 py-2.5 transition-colors',
                                  overrideEntry ? 'bg-primary/[0.035]' : 'hover:bg-muted/20'
                                )}
                              >
                                <div className="flex items-start gap-2 min-w-0 flex-1">
                                  <Checkbox
                                    checked={selectedTools.has(tool.id)}
                                    onCheckedChange={checked => toggleToolSelection(tool.id, checked === true)}
                                    aria-label={t('settings:tool_permissions.select_tool', { name: tool.display })}
                                    className="mt-0.5 relative [@media(pointer:coarse)]:before:content-[''] [@media(pointer:coarse)]:before:absolute [@media(pointer:coarse)]:before:-inset-3.5"
                                  />
                                  <span className={cn(
                                    'mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0',
                                    policy.level ? SENSITIVITY_CONFIG[policy.level].dot : 'bg-muted-foreground/30'
                                  )} />
                                  <div className="min-w-0">
                                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                                      <span className="text-sm text-foreground font-mono break-all" title={tool.name}>
                                        {tool.display}
                                      </span>
                                      <span className={cn(
                                        'text-2xs px-1.5 py-0.5 rounded border',
                                        overrideEntry
                                          ? 'border-primary/20 bg-primary/5 text-primary'
                                          : 'border-border/40 text-muted-foreground'
                                      )}>
                                        {t(`settings:tool_permissions.${statusKey}`)}
                                      </span>
                                    </div>
                                    <div className="mt-0.5 text-xs text-muted-foreground truncate" title={tool.description || tool.name}>
                                      {t(`settings:tool_permissions.capability_${tool.capability}`)}
                                      <span className="mx-1">·</span>
                                      {formatToolSource(tool.source)}
                                      {tool.description && <><span className="mx-1">·</span>{tool.description}</>}
                                    </div>
                                  </div>
                                </div>
                                <div className="self-end sm:self-auto flex-shrink-0">
                                  <LevelSelector
                                    toolName={tool.id}
                                    currentLevel={overrideEntry?.level ?? null}
                                    resetOverrideId={overrideEntry?.id}
                                  />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </CustomScrollArea>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 3. 历史审批记录清理 */}
          {historyCount > 0 && (
            <div className="p-3 rounded-lg bg-muted/10 border border-border/30 flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {t('settings:tool_permissions.history_records', { count: historyCount })}
              </span>
              <DsButton
                variant="outline"
                size="sm"
                onClick={handleClearHistory}
                className="!text-destructive [@media(pointer:coarse)]:!min-h-11"
              >
                <Trash className="h-3 w-3 mr-1" />
                {t('settings:tool_permissions.clear_history')}
              </DsButton>
            </div>
          )}
        </div>
      )}
      {confirmDialog}
    </div>
  );
}

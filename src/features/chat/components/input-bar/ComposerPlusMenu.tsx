/**
 * Composer left "+" menu.
 *
 * Desktop: flyout secondary menus (files / mode / skills / connectors)，
 * built on AppMenu + AppMenuSub — same shell as the previous attachment menu.
 *
 * Mobile (P1-1): 单层扁平列表——文件/拍照/资源库直出、模式开关直出、
 * 技能与连接器改为跳转到内联面板（不再塞进 SubContent 飞出层），
 * 行高 ≥44px 满足触控目标。
 */

import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Archive,
  Camera,
  Check,
  CircleNotch,
  FolderOpen,
  Hammer,
  Lightning,
  LinkSimple,
  Paperclip,
  Plus,
  Sparkle,
} from '@phosphor-icons/react';
import {
  AppMenu,
  AppMenuContent,
  AppMenuFooter,
  AppMenuGroup,
  AppMenuItem,
  AppMenuLabel,
  AppMenuSeparator,
  AppMenuSub,
  AppMenuSubContent,
  AppMenuSubTrigger,
  AppMenuSwitchItem,
  AppMenuTrigger,
} from '@/components/ui/app-menu/AppMenu';
import { CommonTooltip } from '@/components/shared/CommonTooltip';
import { NotionButton } from '@/components/ui/NotionButton';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';

export type ComposerAuthorityMode = 'ask' | 'plan' | 'craft';
export type ComposerPermissionPreset = 'cautious' | 'relaxed';

export interface ComposerPlusMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  attachmentCount: number;
  iconButtonClass: string;
  tooltipPosition?: 'top' | 'bottom' | 'left' | 'right';
  tooltipDisabled?: boolean;
  /** 布局断点（MobileLayoutContext）：true 时渲染单层扁平菜单 */
  isMobile?: boolean;
  /** 设备能力（pointer: coarse）：仅控制拍照入口是否出现 */
  isMobileEnv?: boolean;
  onAddAttachment: () => void;
  onOpenResourceLibrary: () => void;
  onOpenCamera?: () => void;
  /** 移动端：打开内联技能面板（替代桌面端的技能 SubContent 飞出层） */
  onOpenSkillPanel?: () => void;
  sessionId?: string;
  onCompactContext?: () => void | Promise<void>;
  isCompactingContext?: boolean;
  compactContextDisabled?: boolean;
  compactContextStatus?: 'success' | 'not-needed' | 'skipped' | 'error' | null;
  authorityMode?: ComposerAuthorityMode;
  onAuthorityModeChange?: (mode: ComposerAuthorityMode) => void | Promise<void>;
  permissionPreset?: ComposerPermissionPreset;
  onPermissionPresetChange?: (preset: ComposerPermissionPreset) => void | Promise<void>;
  authorityAskBlockedHint?: boolean;
  renderSkillPanel?: () => React.ReactNode;
  activeSkillCount?: number;
  hasLoadedSkills?: boolean;
  renderMcpPanel?: () => React.ReactNode;
  onOpenMcpPanel?: () => void;
  mcpEnabled?: boolean;
  selectedMcpServerCount?: number;
}

// React.memo：输入栏每个按键都会重渲染，"+"菜单（AppMenu/Radix 子树）
// props 稳定时整体跳过协调（调用点回调均为 useCallback/useMemo 稳定引用）
export const ComposerPlusMenu: React.FC<ComposerPlusMenuProps> = React.memo(({
  open,
  onOpenChange,
  attachmentCount,
  iconButtonClass,
  tooltipPosition,
  tooltipDisabled,
  isMobile = false,
  isMobileEnv,
  onAddAttachment,
  onOpenResourceLibrary,
  onOpenCamera,
  onOpenSkillPanel,
  sessionId,
  onCompactContext,
  isCompactingContext = false,
  compactContextDisabled = false,
  compactContextStatus = null,
  authorityMode = 'craft',
  onAuthorityModeChange,
  permissionPreset = 'cautious',
  onPermissionPresetChange,
  authorityAskBlockedHint = false,
  renderSkillPanel,
  activeSkillCount = 0,
  hasLoadedSkills = false,
  renderMcpPanel,
  onOpenMcpPanel,
  mcpEnabled = false,
  selectedMcpServerCount = 0,
}) => {
  const { t } = useTranslation(['analysis', 'chatV2', 'skills', 'common']);

  const modeDescription = useMemo(() => {
    switch (authorityMode) {
      case 'ask':
        return t('chatV2:authority.hints.ask', '只读：写工具会被拒绝');
      case 'plan':
        return t('chatV2:authority.hints.plan', '写操作先确认计划再执行');
      default:
        return t(
          'chatV2:inputBar.plusMenu.modeDefaultDescription',
          '当前为默认模式，可高效执行并完成任务。',
        );
    }
  }, [authorityMode, t]);

  const handlePlanChange = useCallback(
    (checked: boolean) => {
      if (!onAuthorityModeChange) return;
      void onAuthorityModeChange(checked ? 'plan' : 'craft');
    },
    [onAuthorityModeChange],
  );

  const handleAskChange = useCallback(
    (checked: boolean) => {
      if (!onAuthorityModeChange) return;
      void onAuthorityModeChange(checked ? 'ask' : 'craft');
    },
    [onAuthorityModeChange],
  );

  const handleRelaxedChange = useCallback(
    (checked: boolean) => {
      if (!onPermissionPresetChange) return;
      void onPermissionPresetChange(checked ? 'relaxed' : 'cautious');
    },
    [onPermissionPresetChange],
  );

  const handleOpenConnectors = useCallback(() => {
    onOpenChange(false);
    onOpenMcpPanel?.();
  }, [onOpenChange, onOpenMcpPanel]);

  const handleOpenSkills = useCallback(() => {
    onOpenChange(false);
    onOpenSkillPanel?.();
  }, [onOpenChange, onOpenSkillPanel]);

  const handleSwitchToPlan = useCallback(() => {
    if (!onAuthorityModeChange) return;
    void onAuthorityModeChange('plan');
  }, [onAuthorityModeChange]);
  const handleCompactContext = useCallback(() => {
    if (!onCompactContext || isCompactingContext || compactContextDisabled) return;
    void onCompactContext();
  }, [compactContextDisabled, isCompactingContext, onCompactContext]);

  const showMode = Boolean(sessionId && onAuthorityModeChange);
  const showSkills = Boolean(renderSkillPanel);
  const showConnectors = Boolean(renderMcpPanel && onOpenMcpPanel);
  // 📱 P1-1：移动端单层扁平列表（无 AppMenuSub 飞出层），触控行高 ≥44px
  const useFlatMobileMenu = isMobile;
  const mobileItemClass = 'min-h-[44px]';

  const skillBadge = activeSkillCount > 0 ? (
    <span className="rounded-full bg-[color:var(--button-primary-surface)] px-1.5 text-2xs font-medium text-[color:var(--button-primary-foreground)]">
      {activeSkillCount}
    </span>
  ) : hasLoadedSkills ? (
    <Lightning className="h-3 w-3 shrink-0 text-warning" weight="fill" />
  ) : null;

  const connectorsBadge = selectedMcpServerCount > 0 ? (
    <span className="rounded-full bg-muted px-1.5 text-2xs font-medium text-muted-foreground">
      {selectedMcpServerCount}
    </span>
  ) : mcpEnabled ? (
    <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
  ) : null;
  const compactionIcon = isCompactingContext
    ? <CircleNotch className="h-4 w-4 animate-spin" />
    : compactContextStatus === 'success'
      ? <Check className="h-4 w-4 text-success" />
      : <Archive className="h-4 w-4" />;
  const compactionLabel = isCompactingContext
    ? t('chatV2:inputBar.plusMenu.compactingContext')
    : compactContextStatus === 'success'
      ? t('chatV2:inputBar.plusMenu.compactionComplete')
      : compactContextStatus === 'not-needed'
        ? t('chatV2:inputBar.plusMenu.compactionNotNeeded')
        : compactContextStatus === 'skipped'
          ? t('chatV2:inputBar.plusMenu.compactionSkipped')
          : compactContextStatus === 'error'
            ? t('chatV2:inputBar.plusMenu.compactionFailed')
            : t('chatV2:inputBar.plusMenu.compactContext');

  return (
    <div className="flex flex-col items-start gap-0.5">
      <AppMenu open={open} onOpenChange={onOpenChange}>
        <AppMenuTrigger asChild>
          <span className="inline-flex rounded-[var(--radius-shell-control)]">
            <CommonTooltip
              content={
                attachmentCount > 0
                  ? `${t('analysis:input_bar.attachments.title')} (${attachmentCount})`
                  : t('chatV2:inputBar.plusMenu.trigger', '添加与会话选项')
              }
              position={tooltipPosition}
              disabled={tooltipDisabled || open}
            >
              <NotionButton
                data-testid="btn-toggle-attachments"
                variant="ghost"
                size="icon"
                iconOnly
                className={cn(
                  iconButtonClass,
                  'relative transition-colors disabled:opacity-60',
                  open && 'bg-[color:var(--button-secondary-surface)]',
                )}
                aria-label={t('chatV2:inputBar.plusMenu.trigger', '添加与会话选项')}
                aria-expanded={open}
              >
                <Plus size={18} weight="bold" className={cn(open && 'rotate-45 transition-transform')} />
              </NotionButton>
            </CommonTooltip>
          </span>
        </AppMenuTrigger>

        <AppMenuContent
          align="start"
          width={useFlatMobileMenu ? 248 : 200}
          // ★ L4 修复：魔法数 320 收敛到 Z_INDEX 体系（高于移动顶栏 1100）
          style={{ zIndex: Z_INDEX.composerPanel }}
          data-testid="composer-plus-menu"
        >
          {useFlatMobileMenu ? (
            <>
              {/* 📱 移动端扁平列表：文件动作直出 */}
              <AppMenuGroup>
                <AppMenuItem
                  className={mobileItemClass}
                  icon={<Paperclip className="w-4 h-4" weight="bold" />}
                  onClick={onAddAttachment}
                  data-testid="plus-menu-add-attachment"
                >
                  {t('analysis:input_bar.attachments.add')}
                </AppMenuItem>
                {isMobileEnv && onOpenCamera && (
                  <AppMenuItem
                    className={mobileItemClass}
                    icon={<Camera className="w-4 h-4" weight="bold" />}
                    onClick={onOpenCamera}
                    data-testid="plus-menu-camera"
                  >
                    {t('chatV2:inputBar.camera')}
                  </AppMenuItem>
                )}
                <AppMenuItem
                  className={mobileItemClass}
                  icon={<FolderOpen className="w-4 h-4" weight="bold" />}
                  onClick={onOpenResourceLibrary}
                  data-testid="plus-menu-resource-library"
                >
                  {t('chatV2:inputBar.resourceLibrary')}
                </AppMenuItem>
              </AppMenuGroup>

              {sessionId && onCompactContext && (
                <>
                  <AppMenuSeparator />
                  <AppMenuGroup>
                    <AppMenuItem
                      className={mobileItemClass}
                      icon={compactionIcon}
                      onClick={handleCompactContext}
                      disabled={compactContextDisabled || isCompactingContext}
                      data-testid="plus-menu-compact-context"
                    >
                      {compactionLabel}
                    </AppMenuItem>
                  </AppMenuGroup>
                </>
              )}

              {/* 模式开关直出（不再折进 SubContent） */}
              {showMode && (
                <>
                  <AppMenuSeparator />
                  <AppMenuGroup label={t('chatV2:inputBar.plusMenu.mode', '模式')} data-testid="plus-menu-mode-panel">
                    <AppMenuSwitchItem
                      className={mobileItemClass}
                      checked={authorityMode === 'plan'}
                      onCheckedChange={handlePlanChange}
                      data-testid="plus-menu-mode-plan"
                    >
                      {t('chatV2:authority.modes.plan', '想一想')}
                    </AppMenuSwitchItem>
                    <AppMenuSwitchItem
                      className={mobileItemClass}
                      checked={authorityMode === 'ask'}
                      onCheckedChange={handleAskChange}
                      data-testid="plus-menu-mode-ask"
                    >
                      {t('chatV2:authority.modes.ask', '问一问')}
                    </AppMenuSwitchItem>
                    <AppMenuSwitchItem
                      className={mobileItemClass}
                      checked={permissionPreset === 'relaxed'}
                      onCheckedChange={handleRelaxedChange}
                      data-testid="plus-menu-permission-relaxed"
                      title={t('chatV2:authority.permissionPreset.hints.relaxed')}
                    >
                      {t('chatV2:authority.permissionPreset.modes.relaxed', '放开')}
                    </AppMenuSwitchItem>
                  </AppMenuGroup>
                </>
              )}

              {/* 技能/连接器：跳转到内联面板，不嵌套飞出层 */}
              {((showSkills && onOpenSkillPanel) || showConnectors) && <AppMenuSeparator />}
              {showSkills && onOpenSkillPanel && (
                <AppMenuItem
                  className={mobileItemClass}
                  icon={<Hammer className="w-4 h-4" weight="bold" />}
                  onClick={handleOpenSkills}
                  data-testid="btn-toggle-skill"
                  suffix={skillBadge}
                >
                  {t('skills:title')}
                </AppMenuItem>
              )}
              {showConnectors && (
                <AppMenuItem
                  className={mobileItemClass}
                  icon={<LinkSimple className="w-4 h-4" weight="bold" />}
                  onClick={handleOpenConnectors}
                  data-testid="plus-menu-connectors"
                  suffix={connectorsBadge}
                >
                  {t('chatV2:inputBar.plusMenu.connectors', '连接器')}
                </AppMenuItem>
              )}
            </>
          ) : (
          <AppMenuGroup>
            <AppMenuSub openOnClick>
              <AppMenuSubTrigger
                icon={<Paperclip className="w-4 h-4" weight="bold" />}
                data-testid="plus-menu-add-file"
              >
                {t('chatV2:inputBar.plusMenu.addFile', '添加文件')}
              </AppMenuSubTrigger>
              <AppMenuSubContent className="min-w-[180px]">
                <AppMenuItem
                  icon={<Paperclip className="w-4 h-4" weight="bold" />}
                  onClick={onAddAttachment}
                  data-testid="plus-menu-add-attachment"
                >
                  {t('analysis:input_bar.attachments.add')}
                </AppMenuItem>
                <AppMenuItem
                  icon={<FolderOpen className="w-4 h-4" weight="bold" />}
                  onClick={onOpenResourceLibrary}
                  data-testid="plus-menu-resource-library"
                >
                  {t('chatV2:inputBar.resourceLibrary')}
                </AppMenuItem>
                {isMobileEnv && onOpenCamera && (
                  <AppMenuItem
                    icon={<Camera className="w-4 h-4" weight="bold" />}
                    onClick={onOpenCamera}
                    data-testid="plus-menu-camera"
                  >
                    {t('chatV2:inputBar.camera')}
                  </AppMenuItem>
                )}
              </AppMenuSubContent>
            </AppMenuSub>

            {sessionId && onCompactContext && (
              <AppMenuItem
                icon={compactionIcon}
                onClick={handleCompactContext}
                disabled={compactContextDisabled || isCompactingContext}
                data-testid="plus-menu-compact-context"
              >
                {compactionLabel}
              </AppMenuItem>
            )}

            {showMode && (
              <AppMenuSub openOnClick>
                <AppMenuSubTrigger
                  icon={<Sparkle className="w-4 h-4" weight="bold" />}
                  data-testid="plus-menu-mode"
                >
                  {t('chatV2:inputBar.plusMenu.mode', '模式')}
                </AppMenuSubTrigger>
                <AppMenuSubContent
                  className="w-[min(280px,calc(100vw-24px))]"
                  data-testid="plus-menu-mode-panel"
                >
                  <AppMenuLabel className="!whitespace-normal !normal-case !tracking-normal text-[12px] leading-snug text-muted-foreground px-2 py-1.5">
                    {modeDescription}
                  </AppMenuLabel>
                  <AppMenuSeparator />
                  <AppMenuSwitchItem
                    checked={authorityMode === 'plan'}
                    onCheckedChange={handlePlanChange}
                    data-testid="plus-menu-mode-plan"
                  >
                    <span className="flex flex-col items-start gap-0.5">
                      <span>{t('chatV2:authority.modes.plan', '想一想')}</span>
                      <span className="text-2xs text-muted-foreground">Plan</span>
                    </span>
                  </AppMenuSwitchItem>
                  <AppMenuSwitchItem
                    checked={authorityMode === 'ask'}
                    onCheckedChange={handleAskChange}
                    data-testid="plus-menu-mode-ask"
                  >
                    <span className="flex flex-col items-start gap-0.5">
                      <span>{t('chatV2:authority.modes.ask', '问一问')}</span>
                      <span className="text-2xs text-muted-foreground">Ask</span>
                    </span>
                  </AppMenuSwitchItem>
                  <AppMenuSeparator />
                  <AppMenuSwitchItem
                    checked={permissionPreset === 'relaxed'}
                    onCheckedChange={handleRelaxedChange}
                    data-testid="plus-menu-permission-relaxed"
                    title={t('chatV2:authority.permissionPreset.hints.relaxed')}
                  >
                    <span className="flex flex-col items-start gap-0.5">
                      <span>{t('chatV2:authority.permissionPreset.modes.relaxed', '放开')}</span>
                      <span className="text-2xs text-muted-foreground">
                        {t('chatV2:inputBar.plusMenu.approvalMemory', '审批记忆')}
                      </span>
                    </span>
                  </AppMenuSwitchItem>
                </AppMenuSubContent>
              </AppMenuSub>
            )}

            {showSkills && (
              <AppMenuSub openOnClick>
                <AppMenuSubTrigger
                  icon={<Hammer className="w-4 h-4" weight="bold" />}
                  data-testid="btn-toggle-skill"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">{t('skills:title')}</span>
                    {skillBadge}
                  </span>
                </AppMenuSubTrigger>
                <AppMenuSubContent
                  className="w-[min(360px,calc(100vw-24px))] max-h-[min(520px,70vh)] overflow-hidden p-0"
                  data-testid="plus-menu-skills-panel"
                  onMouseDown={(event) => event.stopPropagation()}
                >
                  <div className="flex max-h-[min(520px,70vh)] flex-col overflow-hidden">
                    {renderSkillPanel?.()}
                  </div>
                </AppMenuSubContent>
              </AppMenuSub>
            )}

            {showConnectors && (
              <AppMenuSub openOnClick>
                <AppMenuSubTrigger
                  icon={<LinkSimple className="w-4 h-4" weight="bold" />}
                  data-testid="plus-menu-connectors"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">
                      {t('chatV2:inputBar.plusMenu.connectors', '连接器')}
                    </span>
                    {connectorsBadge}
                  </span>
                </AppMenuSubTrigger>
                <AppMenuSubContent className="min-w-[200px]" data-testid="plus-menu-connectors-panel">
                  <AppMenuItem
                    icon={<LinkSimple className="w-4 h-4" weight="bold" />}
                    onClick={handleOpenConnectors}
                    data-testid="plus-menu-open-connectors"
                  >
                    {t('chatV2:inputBar.plusMenu.openConnectors', '管理连接器')}
                  </AppMenuItem>
                  <AppMenuFooter className="text-[11px] text-muted-foreground">
                    {t(
                      'chatV2:inputBar.plusMenu.connectorsHint',
                      '选择 MCP / 外部工具连接',
                    )}
                  </AppMenuFooter>
                </AppMenuSubContent>
              </AppMenuSub>
            )}
          </AppMenuGroup>
          )}
        </AppMenuContent>
      </AppMenu>

      {authorityAskBlockedHint && authorityMode === 'ask' && onAuthorityModeChange && (
        <button
          type="button"
          className="ml-1 text-[11px] text-warning underline-offset-2 hover:underline"
          onClick={handleSwitchToPlan}
          data-testid="plus-menu-switch-to-plan"
        >
          {t('chatV2:authority.switchToPlan', '切换到想一想')}
        </button>
      )}
    </div>
  );
});

ComposerPlusMenu.displayName = 'ComposerPlusMenu';

export default ComposerPlusMenu;

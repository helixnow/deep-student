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
  Books,
  Camera,
  Check,
  CircleNotch,
  FolderOpen,
  Hammer,
  Lightning,
  LinkSimple,
  Paperclip,
  Plus,
  ShieldWarning,
  Sparkle,
  Warning,
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
import { DsButton } from '@/components/ui/DsButton';
import { DsAlertDialog } from '@/components/ui/DsDialog';
import { cn } from '@/lib/utils';
import { Z_INDEX } from '@/config/zIndex';
import type { PermissionPreset } from '../../core/types/store';

export type ComposerAuthorityMode = 'ask' | 'plan' | 'craft';
export type ComposerPermissionPreset = PermissionPreset;

const PERMISSION_PRESETS: ComposerPermissionPreset[] = [
  'cautious',
  'relaxed',
  'full_access',
  'danger_full_access',
];

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
  /** 知识库主动检索开关（开启后注入系统提示词，要求模型优先检索本地知识库） */
  knowledgeBaseProactive?: boolean;
  onKnowledgeBaseProactiveChange?: (enabled: boolean) => void | Promise<void>;
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
  permissionPreset = 'relaxed',
  onPermissionPresetChange,
  authorityAskBlockedHint = false,
  renderSkillPanel,
  activeSkillCount = 0,
  hasLoadedSkills = false,
  renderMcpPanel,
  onOpenMcpPanel,
  mcpEnabled = false,
  selectedMcpServerCount = 0,
  knowledgeBaseProactive = false,
  onKnowledgeBaseProactiveChange,
}) => {
  const { t } = useTranslation(['analysis', 'chatV2', 'skills', 'common']);
  const [confirmDangerOpen, setConfirmDangerOpen] = React.useState(false);

  const modeDescription = useMemo(() => {
    switch (authorityMode) {
      case 'ask':
        return t('chatV2:authority.hints.ask');
      case 'plan':
        return t('chatV2:authority.hints.plan');
      default:
        return t('chatV2:inputBar.plusMenu.modeDefaultDescription');
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

  const applyPermissionPreset = useCallback(
    (preset: ComposerPermissionPreset) => {
      if (!onPermissionPresetChange || preset === permissionPreset) return;
      void onPermissionPresetChange(preset);
    },
    [onPermissionPresetChange, permissionPreset],
  );

  const handlePermissionPresetSelect = useCallback(
    (preset: ComposerPermissionPreset) => {
      if (preset === permissionPreset) return;
      if (preset === 'danger_full_access') {
        setConfirmDangerOpen(true);
        return;
      }
      applyPermissionPreset(preset);
    },
    [applyPermissionPreset, permissionPreset],
  );

  const handleKnowledgeBaseProactiveChange = useCallback(
    (checked: boolean) => {
      if (!onKnowledgeBaseProactiveChange) return;
      void onKnowledgeBaseProactiveChange(checked);
    },
    [onKnowledgeBaseProactiveChange],
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
  const showKnowledgeBase = Boolean(onKnowledgeBaseProactiveChange);
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
    <div className="flex items-center gap-1">
      <AppMenu open={open} onOpenChange={onOpenChange}>
        <AppMenuTrigger asChild>
          <span className="inline-flex rounded-[var(--radius-shell-control)]">
            <CommonTooltip
              content={
                attachmentCount > 0
                  ? t('chatV2:inputBar.plusMenu.attachmentsCount', { count: attachmentCount })
                  : t('chatV2:inputBar.plusMenu.trigger')
              }
              position={tooltipPosition}
              disabled={tooltipDisabled || open}
            >
              <DsButton
                data-testid="btn-toggle-attachments"
                variant="ghost"
                size="icon"
                iconOnly
                className={cn(
                  iconButtonClass,
                  'relative transition-colors disabled:opacity-60',
                  open && 'bg-[color:var(--button-secondary-surface)]',
                )}
                aria-label={t('chatV2:inputBar.plusMenu.trigger')}
                aria-expanded={open}
              >
                <Plus size={18} weight="bold" className={cn(open && 'rotate-45 transition-transform')} />
              </DsButton>
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
                  <AppMenuGroup label={t('chatV2:inputBar.plusMenu.mode')} data-testid="plus-menu-mode-panel">
                    <AppMenuSwitchItem
                      className={mobileItemClass}
                      checked={authorityMode === 'plan'}
                      onCheckedChange={handlePlanChange}
                      data-testid="plus-menu-mode-plan"
                    >
                      {t('chatV2:authority.modes.plan')}
                    </AppMenuSwitchItem>
                    <AppMenuSwitchItem
                      className={mobileItemClass}
                      checked={authorityMode === 'ask'}
                      onCheckedChange={handleAskChange}
                      data-testid="plus-menu-mode-ask"
                    >
                      {t('chatV2:authority.modes.ask')}
                    </AppMenuSwitchItem>
                    <AppMenuLabel className="!whitespace-normal !normal-case !tracking-normal px-2 py-1 text-[11px] leading-snug text-muted-foreground">
                      {t('chatV2:authority.permissionPreset.modePriority')}
                    </AppMenuLabel>
                    {PERMISSION_PRESETS.map((preset) => (
                      <AppMenuItem
                        key={preset}
                        className={cn(
                          mobileItemClass,
                          preset === 'danger_full_access' && 'text-destructive',
                        )}
                        onClick={() => handlePermissionPresetSelect(preset)}
                        data-testid={`plus-menu-permission-${preset}`}
                        title={t(`chatV2:authority.permissionPreset.hints.${preset}`)}
                        suffix={permissionPreset === preset ? <Check className="h-4 w-4" /> : undefined}
                      >
                        {t(`chatV2:authority.permissionPreset.modes.${preset}`)}
                      </AppMenuItem>
                    ))}
                  </AppMenuGroup>
                </>
              )}

              {/* 知识库开关直出 */}
              {showKnowledgeBase && (
                <>
                  <AppMenuSeparator />
                  <AppMenuGroup
                    label={t('chatV2:inputBar.plusMenu.knowledgeBase')}
                    data-testid="plus-menu-knowledge-base-panel"
                  >
                    <AppMenuSwitchItem
                      className={mobileItemClass}
                      checked={knowledgeBaseProactive}
                      onCheckedChange={handleKnowledgeBaseProactiveChange}
                      data-testid="plus-menu-kb-proactive"
                      title={t('chatV2:inputBar.plusMenu.kbProactiveHint')}
                    >
                      {t('chatV2:inputBar.plusMenu.kbProactive')}
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
                  {t('chatV2:inputBar.plusMenu.connectors')}
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
                {t('chatV2:inputBar.plusMenu.addFile')}
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
                  {t('chatV2:inputBar.plusMenu.mode')}
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
                      <span>{t('chatV2:authority.modes.plan')}</span>
                      <span className="text-2xs text-muted-foreground">
                        {t('chatV2:authority.modeSubtitles.plan')}
                      </span>
                    </span>
                  </AppMenuSwitchItem>
                  <AppMenuSwitchItem
                    checked={authorityMode === 'ask'}
                    onCheckedChange={handleAskChange}
                    data-testid="plus-menu-mode-ask"
                  >
                    <span className="flex flex-col items-start gap-0.5">
                      <span>{t('chatV2:authority.modes.ask')}</span>
                      <span className="text-2xs text-muted-foreground">
                        {t('chatV2:authority.modeSubtitles.ask')}
                      </span>
                    </span>
                  </AppMenuSwitchItem>
                  <AppMenuSeparator />
                  <AppMenuLabel className="!whitespace-normal !normal-case !tracking-normal px-2 py-1 text-[11px] leading-snug text-muted-foreground">
                    {t('chatV2:authority.permissionPreset.modePriority')}
                  </AppMenuLabel>
                  {PERMISSION_PRESETS.map((preset) => (
                    <AppMenuItem
                      key={preset}
                      className={cn(preset === 'danger_full_access' && 'text-destructive')}
                      onClick={() => handlePermissionPresetSelect(preset)}
                      data-testid={`plus-menu-permission-${preset}`}
                      title={t(`chatV2:authority.permissionPreset.hints.${preset}`)}
                      suffix={permissionPreset === preset ? <Check className="h-4 w-4" /> : undefined}
                    >
                      <span className="flex flex-col items-start gap-0.5">
                        <span>{t(`chatV2:authority.permissionPreset.modes.${preset}`)}</span>
                        <span className="text-2xs text-muted-foreground">
                          {t(`chatV2:authority.permissionPreset.shortHints.${preset}`)}
                        </span>
                      </span>
                    </AppMenuItem>
                  ))}
                </AppMenuSubContent>
              </AppMenuSub>
            )}

            {showKnowledgeBase && (
              <AppMenuSub openOnClick>
                <AppMenuSubTrigger
                  icon={<Books className="w-4 h-4" weight="bold" />}
                  data-testid="plus-menu-knowledge-base"
                >
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate">
                      {t('chatV2:inputBar.plusMenu.knowledgeBase')}
                    </span>
                    {knowledgeBaseProactive && (
                      <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" />
                    )}
                  </span>
                </AppMenuSubTrigger>
                <AppMenuSubContent
                  className="w-[min(280px,calc(100vw-24px))]"
                  data-testid="plus-menu-knowledge-base-panel"
                >
                  <AppMenuLabel className="!whitespace-normal !normal-case !tracking-normal text-[12px] leading-snug text-muted-foreground px-2 py-1.5">
                    {t('chatV2:inputBar.plusMenu.kbProactiveHint')}
                  </AppMenuLabel>
                  <AppMenuSeparator />
                  <AppMenuSwitchItem
                    checked={knowledgeBaseProactive}
                    onCheckedChange={handleKnowledgeBaseProactiveChange}
                    data-testid="plus-menu-kb-proactive"
                  >
                    {t('chatV2:inputBar.plusMenu.kbProactive')}
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
                      {t('chatV2:inputBar.plusMenu.connectors')}
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
                    {t('chatV2:inputBar.plusMenu.openConnectors')}
                  </AppMenuItem>
                  <AppMenuFooter className="text-[11px] text-muted-foreground">
                    {t('chatV2:inputBar.plusMenu.connectorsHint')}
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
          className="shrink-0 text-[11px] text-warning underline-offset-2 hover:underline"
          onClick={handleSwitchToPlan}
          data-testid="plus-menu-switch-to-plan"
        >
          {t('chatV2:authority.switchToPlan')}
        </button>
      )}
      {permissionPreset === 'full_access' && (
        <button
          type="button"
          // Compact inline chip next to "+" — full guidance lives in title/aria-label.
          // Pseudo-element expands hit target without growing toolbar height.
          className={cn(
            'relative inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md',
            'bg-warning/15 px-1.5 text-[10px] font-medium leading-none text-warning',
            'hover:bg-warning/25 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-warning/40',
            "after:absolute after:-inset-y-1.5 after:-inset-x-1 after:content-['']",
          )}
          onClick={() => applyPermissionPreset('relaxed')}
          data-testid="full-access-active"
          title={t('chatV2:authority.permissionPreset.fullAccessDowngradeHint')}
          aria-label={t('chatV2:authority.permissionPreset.fullAccessDowngradeHint')}
        >
          <ShieldWarning size={12} weight="fill" className="shrink-0" aria-hidden="true" />
          <span className="max-w-[3.75rem] truncate">
            {t('chatV2:authority.permissionPreset.fullAccessActive')}
          </span>
        </button>
      )}
      {permissionPreset === 'danger_full_access' && (
        <button
          type="button"
          className={cn(
            'relative inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md',
            'bg-destructive px-1.5 text-[10px] font-medium leading-none text-destructive-foreground shadow-sm',
            'hover:bg-destructive/90 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-destructive/50',
            "after:absolute after:-inset-y-1.5 after:-inset-x-1 after:content-['']",
          )}
          onClick={() => applyPermissionPreset('relaxed')}
          data-testid="danger-full-access-active"
          title={t('chatV2:authority.permissionPreset.dangerDowngradeHint')}
          aria-label={t('chatV2:authority.permissionPreset.dangerDowngradeHint')}
        >
          <Warning size={12} weight="fill" className="shrink-0" aria-hidden="true" />
          <span className="max-w-[3.75rem] truncate">
            {t('chatV2:authority.permissionPreset.dangerActive')}
          </span>
        </button>
      )}
      <DsAlertDialog
        open={confirmDangerOpen}
        onOpenChange={setConfirmDangerOpen}
        title={t('chatV2:authority.permissionPreset.dangerConfirmTitle')}
        description={t('chatV2:authority.permissionPreset.dangerConfirmDescription')}
        confirmText={t('chatV2:authority.permissionPreset.dangerConfirmAction')}
        confirmVariant="danger"
        onConfirm={() => {
          setConfirmDangerOpen(false);
          applyPermissionPreset('danger_full_access');
        }}
      />
    </div>
  );
});

ComposerPlusMenu.displayName = 'ComposerPlusMenu';

export default ComposerPlusMenu;

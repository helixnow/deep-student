/**
 * Composer left "+" menu.
 *
 * Desktop: flyout secondary menus (files / mode / skills / connectors)，
 * built on AppMenu + AppMenuSub — same shell as the previous attachment menu.
 *
 * Mobile: 根层只放动作（附件/资源库/技能/连接器/对话控制）。
 * 模式与执行档位走页内二级面板（避免窄屏飞出层被裁切），
 * 技能与连接器跳转到内联面板。行高 ≥44px 满足触控目标。
 */

import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Books,
  Camera,
  CaretLeft,
  CaretRight,
  Check,
  FolderOpen,
  Hammer,
  Lightning,
  LinkSimple,
  Paperclip,
  Plus,
  ShieldWarning,
  SlidersHorizontal,
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

export type ComposerPermissionPreset = PermissionPreset;
export type ComposerAuthorityMode = 'ask' | 'plan' | 'craft';

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
  /**
   * 相机捕获能力：仅控制拍照入口是否出现。上游传入
   * inputBarCapabilities.canCapturePhoto()（平台/capture 特性判定），
   * 早已不是 pointer: coarse。prop 名为历史遗留，待改名为 canCapturePhoto。
   */
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
  /** 打开对话控制（高级设置）面板（桌面浮层 / 移动端内联面板） */
  onOpenAdvancedPanel?: () => void;
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
  permissionPreset = 'relaxed',
  onPermissionPresetChange,
  renderSkillPanel,
  activeSkillCount = 0,
  hasLoadedSkills = false,
  renderMcpPanel,
  onOpenMcpPanel,
  mcpEnabled = false,
  selectedMcpServerCount = 0,
  onOpenAdvancedPanel,
  knowledgeBaseProactive = false,
  onKnowledgeBaseProactiveChange,
}) => {
  const { t } = useTranslation(['analysis', 'chatV2', 'skills', 'common']);
  const [confirmDangerOpen, setConfirmDangerOpen] = React.useState(false);
  const [mobilePane, setMobilePane] = React.useState<'root' | 'mode'>('root');

  React.useEffect(() => {
    if (!open) setMobilePane('root');
  }, [open]);

  const modeSummary = t(`chatV2:authority.permissionPreset.modes.${permissionPreset}`);
  const modeDescription = t('chatV2:inputBar.plusMenu.modeDefaultDescription');

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

  const handleOpenAdvancedPanel = useCallback(() => {
    onOpenChange(false);
    onOpenAdvancedPanel?.();
  }, [onOpenChange, onOpenAdvancedPanel]);

  const showMode = Boolean(sessionId && onPermissionPresetChange);
  const showKnowledgeBase = Boolean(onKnowledgeBaseProactiveChange);
  const showSkills = Boolean(renderSkillPanel);
  const showConnectors = Boolean(renderMcpPanel && onOpenMcpPanel);
  const showAdvanced = Boolean(onOpenAdvancedPanel);
  // 📱 P1-1：移动端单层扁平列表（无 AppMenuSub 飞出层）
  // 行目标体系化：触控行高跟随 pointer:coarse（设备能力）而非布局断点，
  // 统一走 --touch-target-size token（44px），与 AppMenu.css 的 coarse 基线一致
  const useFlatMobileMenu = isMobile;
  const mobileItemClass = '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]';

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
                  isMobile && '!rounded-full',
                  'relative transition-colors disabled:opacity-60',
                  '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:min-w-[var(--touch-target-size)]',
                  open && 'bg-[color:var(--button-secondary-surface)]',
                )}
                aria-label={t('chatV2:inputBar.plusMenu.trigger')}
                aria-expanded={open}
              >
                <Plus size={18} weight="bold" className={cn('transition-transform duration-[var(--dropdown-close-dur,150ms)]', open && 'rotate-45')} />
              </DsButton>
            </CommonTooltip>
          </span>
        </AppMenuTrigger>

        <AppMenuContent
          align="start"
          width={useFlatMobileMenu ? 248 : 200}
          maxHeight={useFlatMobileMenu ? 'min(28rem, calc(100dvh - 7.5rem))' : undefined}
          // ★ L4 修复：魔法数 320 收敛到 Z_INDEX 体系（高于移动顶栏 1100）
          style={{ zIndex: Z_INDEX.composerPanel }}
          data-testid="composer-plus-menu"
        >
          {useFlatMobileMenu ? (
            mobilePane === 'mode' ? (
              <>
                <AppMenuGroup>
                  <AppMenuItem
                    className={mobileItemClass}
                    icon={<CaretLeft className="w-4 h-4" />}
                    onClick={(event) => {
                      event.preventDefault();
                      setMobilePane('root');
                    }}
                    data-testid="plus-menu-mode-back"
                  >
                    {t('common:back')}
                  </AppMenuItem>
                </AppMenuGroup>
                <AppMenuSeparator />
                <AppMenuGroup label={t('chatV2:inputBar.plusMenu.mode')} data-testid="plus-menu-mode-panel">
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
              </>
            ) : (
            <>
              <AppMenuGroup>
                <AppMenuItem
                  className={mobileItemClass}
                  icon={<Paperclip className="w-4 h-4" />}
                  onClick={onAddAttachment}
                  data-testid="plus-menu-add-attachment"
                >
                  {t('analysis:input_bar.attachments.add')}
                </AppMenuItem>
                {isMobileEnv && onOpenCamera && (
                  <AppMenuItem
                    className={mobileItemClass}
                    icon={<Camera className="w-4 h-4" />}
                    onClick={onOpenCamera}
                    data-testid="plus-menu-camera"
                  >
                    {t('chatV2:inputBar.camera')}
                  </AppMenuItem>
                )}
                <AppMenuItem
                  className={mobileItemClass}
                  icon={<FolderOpen className="w-4 h-4" />}
                  onClick={onOpenResourceLibrary}
                  data-testid="plus-menu-resource-library"
                >
                  {t('chatV2:inputBar.resourceLibrary')}
                </AppMenuItem>
              </AppMenuGroup>

              {showMode && (
                <>
                  <AppMenuSeparator />
                  <AppMenuItem
                    className={mobileItemClass}
                    icon={<Sparkle className="w-4 h-4" />}
                    onClick={(event) => {
                      event.preventDefault();
                      setMobilePane('mode');
                    }}
                    data-testid="plus-menu-mode"
                    suffix={(
                      <span className="flex items-center gap-1 text-muted-foreground">
                        <span className="max-w-[5.5rem] truncate text-[12px]">{modeSummary}</span>
                        <CaretRight className="h-3.5 w-3.5 shrink-0" />
                      </span>
                    )}
                  >
                    {t('chatV2:inputBar.plusMenu.mode')}
                  </AppMenuItem>
                </>
              )}

              {!showMode && showKnowledgeBase && (
                <>
                  <AppMenuSeparator />
                  <AppMenuSwitchItem
                    className={mobileItemClass}
                    checked={knowledgeBaseProactive}
                    onCheckedChange={handleKnowledgeBaseProactiveChange}
                    data-testid="plus-menu-kb-proactive"
                    title={t('chatV2:inputBar.plusMenu.kbProactiveHint')}
                  >
                    {t('chatV2:inputBar.plusMenu.kbProactive')}
                  </AppMenuSwitchItem>
                </>
              )}

              {((showSkills && onOpenSkillPanel) || showConnectors || showAdvanced) && <AppMenuSeparator />}
              {showSkills && onOpenSkillPanel && (
                <AppMenuItem
                  className={mobileItemClass}
                  icon={<Hammer className="w-4 h-4" />}
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
                  icon={<LinkSimple className="w-4 h-4" />}
                  onClick={handleOpenConnectors}
                  data-testid="plus-menu-connectors"
                  suffix={connectorsBadge}
                >
                  {t('chatV2:inputBar.plusMenu.connectors')}
                </AppMenuItem>
              )}
              {showAdvanced && (
                <AppMenuItem
                  className={mobileItemClass}
                  icon={<SlidersHorizontal className="w-4 h-4" />}
                  onClick={handleOpenAdvancedPanel}
                  data-testid="plus-menu-advanced"
                >
                  {t('common:chat_controls')}
                </AppMenuItem>
              )}
            </>
            )
          ) : (
          <AppMenuGroup>
            <AppMenuSub openOnClick>
              <AppMenuSubTrigger
                icon={<Paperclip className="w-4 h-4" />}
                data-testid="plus-menu-add-file"
              >
                {t('chatV2:inputBar.plusMenu.addFile')}
              </AppMenuSubTrigger>
              <AppMenuSubContent className="min-w-[180px]">
                <AppMenuItem
                  icon={<Paperclip className="w-4 h-4" />}
                  onClick={onAddAttachment}
                  data-testid="plus-menu-add-attachment"
                >
                  {t('analysis:input_bar.attachments.add')}
                </AppMenuItem>
                <AppMenuItem
                  icon={<FolderOpen className="w-4 h-4" />}
                  onClick={onOpenResourceLibrary}
                  data-testid="plus-menu-resource-library"
                >
                  {t('chatV2:inputBar.resourceLibrary')}
                </AppMenuItem>
                {isMobileEnv && onOpenCamera && (
                  <AppMenuItem
                    icon={<Camera className="w-4 h-4" />}
                    onClick={onOpenCamera}
                    data-testid="plus-menu-camera"
                  >
                    {t('chatV2:inputBar.camera')}
                  </AppMenuItem>
                )}
              </AppMenuSubContent>
            </AppMenuSub>

            {showMode && (
              <AppMenuSub openOnClick>
                <AppMenuSubTrigger
                  icon={<Sparkle className="w-4 h-4" />}
                  data-testid="plus-menu-mode"
                >
                  {t('chatV2:inputBar.plusMenu.mode')}
                </AppMenuSubTrigger>
                <AppMenuSubContent
                  className="w-[min(280px,calc(100vw-24px))]"
                  data-testid="plus-menu-mode-panel"
                >
                  <AppMenuLabel className="!whitespace-normal !normal-case !tracking-normal text-caption leading-snug text-muted-foreground px-2 py-1.5">
                    {modeDescription}
                  </AppMenuLabel>
                  <AppMenuSeparator />
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
                  icon={<Books className="w-4 h-4" />}
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
                  <AppMenuLabel className="!whitespace-normal !normal-case !tracking-normal text-caption leading-snug text-muted-foreground px-2 py-1.5">
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
                  icon={<Hammer className="w-4 h-4" />}
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
                  icon={<LinkSimple className="w-4 h-4" />}
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
                    icon={<LinkSimple className="w-4 h-4" />}
                    onClick={handleOpenConnectors}
                    data-testid="plus-menu-open-connectors"
                  >
                    {t('chatV2:inputBar.plusMenu.openConnectors')}
                  </AppMenuItem>
                  <AppMenuFooter className="text-caption text-muted-foreground">
                    {t('chatV2:inputBar.plusMenu.connectorsHint')}
                  </AppMenuFooter>
                </AppMenuSubContent>
              </AppMenuSub>
            )}

            {showAdvanced && (
              <AppMenuItem
                icon={<SlidersHorizontal className="w-4 h-4" />}
                onClick={handleOpenAdvancedPanel}
                data-testid="plus-menu-advanced"
              >
                {t('common:chat_controls')}
              </AppMenuItem>
            )}
          </AppMenuGroup>
          )}
        </AppMenuContent>
      </AppMenu>

      {permissionPreset === 'full_access' && (
        <button
          type="button"
          // Compact inline chip next to "+" — full guidance lives in title/aria-label.
          // 实体命中区：coarse 下按钮自身抬到 --touch-target-size（44px），
          // 不再用 after 伪元素扩区（会与相邻 gap-1 控件命中重叠）；
          // 视觉胶囊由内层 span 保持 h-6 不变，工具条高度不受影响。
          className={cn(
            'group inline-flex shrink-0 items-center justify-center focus-visible:outline-none',
            '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
          )}
          onClick={() => applyPermissionPreset('relaxed')}
          data-testid="full-access-active"
          title={t('chatV2:authority.permissionPreset.fullAccessDowngradeHint')}
          aria-label={t('chatV2:authority.permissionPreset.fullAccessDowngradeHint')}
        >
          <span
            className={cn(
              'inline-flex h-6 items-center gap-0.5 rounded-md',
              'bg-warning/15 px-1.5 text-caption font-medium leading-none text-warning',
              'group-hover:bg-warning/25 group-focus-visible:ring-1 group-focus-visible:ring-warning/40',
            )}
          >
            <ShieldWarning size={12} weight="fill" className="shrink-0" aria-hidden="true" />
            <span className="max-w-[3.75rem] truncate">
              {t('chatV2:authority.permissionPreset.fullAccessActive')}
            </span>
          </span>
        </button>
      )}
      {permissionPreset === 'danger_full_access' && (
        <button
          type="button"
          // 同上：实体命中区替代伪元素扩区，视觉胶囊保持 h-6
          className={cn(
            'group inline-flex shrink-0 items-center justify-center focus-visible:outline-none',
            '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
          )}
          onClick={() => applyPermissionPreset('relaxed')}
          data-testid="danger-full-access-active"
          title={t('chatV2:authority.permissionPreset.dangerDowngradeHint')}
          aria-label={t('chatV2:authority.permissionPreset.dangerDowngradeHint')}
        >
          <span
            className={cn(
              'inline-flex h-6 items-center gap-0.5 rounded-md',
              'bg-destructive px-1.5 text-caption font-medium leading-none text-destructive-foreground shadow-sm',
              'group-hover:bg-destructive/90 group-focus-visible:ring-1 group-focus-visible:ring-destructive/50',
            )}
          >
            <Warning size={12} weight="fill" className="shrink-0" aria-hidden="true" />
            <span className="max-w-[3.75rem] truncate">
              {t('chatV2:authority.permissionPreset.dangerActive')}
            </span>
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

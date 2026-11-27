/**
 * Composer left "+" menu（上下文与扩展入口）
 *
 * 职责聚焦于向当前会话注入资料与扩展能力（与右侧 T3 模型/运行时选择器形成清晰分工）：
 *   1. 添加文件（本地附件 / 资源库 / 拍照）
 *   2. 知识库（RAG 开关 / 主动检索 / 检索范围）
 *   3. 技能（桌面飞出面板 / 移动端内联面板）
 *   4. 连接器（MCP 服务器面板）
 *
 * 运行时状态控制（联网搜索 / 对话采样参数 / 权限执行档位）已统一收入右侧模型选择器底栏；
 * 工具栏行内仍保留活跃高权限降级胶囊与插件工坊活跃胶囊，保证常驻可见与一键退出。
 */

import { requestKbScopePicker, useKbScope } from '../../kbScope/kbScope';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Books,
  Camera,
  FolderOpen,
  FolderSimple,
  Hammer,
  Lightning,
  LinkSimple,
  Paperclip,
  Plus,
  PuzzlePiece,
  ShieldWarning,
  Warning,
  X,
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
   * inputBarCapabilities.canCapturePhoto()（平台/capture 特性判定）。
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
  permissionPreset?: ComposerPermissionPreset;
  onPermissionPresetChange?: (
    preset: ComposerPermissionPreset,
    confirm?: boolean,
  ) => void | Promise<void>;
  renderSkillPanel?: () => React.ReactNode;
  activeSkillCount?: number;
  hasLoadedSkills?: boolean;
  renderMcpPanel?: () => React.ReactNode;
  onOpenMcpPanel?: () => void;
  selectedMcpServerCount?: number;
  /** 兼容保留（已迁入右侧模型选择器底栏「参数」） */
  onOpenAdvancedPanel?: () => void;
  /** 知识库主动检索开关（开启后注入系统提示词，要求模型优先检索本地知识库） */
  knowledgeBaseProactive?: boolean;
  onKnowledgeBaseProactiveChange?: (enabled: boolean) => void | Promise<void>;
  /** 知识库检索开关（session features 'rag'，控制 RAG 工具是否可用） */
  ragEnabled?: boolean;
  onRagEnabledChange?: (enabled: boolean) => void | Promise<void>;
  /** 兼容保留（已迁入右侧模型选择器底栏「联网」） */
  webSearchEnabled?: boolean;
  onWebSearchEnabledChange?: (enabled: boolean) => void | Promise<void>;
  /** 插件工坊活跃状态胶囊展示与一键退出 */
  pluginWorkshopActive?: boolean;
  onTogglePluginWorkshop?: () => void | Promise<void>;
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
  selectedMcpServerCount = 0,
  knowledgeBaseProactive = false,
  onKnowledgeBaseProactiveChange,
  ragEnabled = true,
  onRagEnabledChange,
  pluginWorkshopActive = false,
  onTogglePluginWorkshop,
}) => {
  const { t } = useTranslation(['analysis', 'chatV2', 'skills', 'common']);
  const [permissionSyncing, setPermissionSyncing] = React.useState(false);
  const [switchError, setSwitchError] = React.useState<string | null>(null);

  const downgradePermissionPreset = useCallback(
    async (preset: ComposerPermissionPreset) => {
      if (!onPermissionPresetChange || preset === permissionPreset || permissionSyncing) return;
      setPermissionSyncing(true);
      try {
        await onPermissionPresetChange(preset);
      } catch (error) {
        console.error('[ComposerPlusMenu] permission preset downgrade failed:', preset, error);
        setSwitchError(error instanceof Error ? error.message : String(error));
      } finally {
        setPermissionSyncing(false);
      }
    },
    [onPermissionPresetChange, permissionPreset, permissionSyncing],
  );

  const handleKnowledgeBaseProactiveChange = useCallback(
    (checked: boolean) => {
      if (!onKnowledgeBaseProactiveChange) return;
      void onKnowledgeBaseProactiveChange(checked);
    },
    [onKnowledgeBaseProactiveChange],
  );

  const handleRagEnabledChange = useCallback(
    (checked: boolean) => {
      if (!onRagEnabledChange) return;
      void onRagEnabledChange(checked);
    },
    [onRagEnabledChange],
  );

  const handleOpenConnectors = useCallback(() => {
    onOpenChange(false);
    onOpenMcpPanel?.();
  }, [onOpenChange, onOpenMcpPanel]);

  const handleOpenSkills = useCallback(() => {
    onOpenChange(false);
    onOpenSkillPanel?.();
  }, [onOpenChange, onOpenSkillPanel]);

  const showKnowledgeBase = Boolean(onKnowledgeBaseProactiveChange || onRagEnabledChange);
  const showSkills = Boolean(renderSkillPanel);
  const showConnectors = Boolean(renderMcpPanel && onOpenMcpPanel);
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
  ) : null;

  const renderKnowledgeBaseItems = (itemClassName?: string) => (
    <>
      {onRagEnabledChange && (
        <AppMenuSwitchItem
          className={itemClassName}
          checked={ragEnabled}
          onCheckedChange={handleRagEnabledChange}
          data-testid="plus-menu-rag"
          title={t('chatV2:inputBar.plusMenu.ragHint')}
        >
          {t('chatV2:inputBar.plusMenu.rag')}
        </AppMenuSwitchItem>
      )}
      {onKnowledgeBaseProactiveChange && (
        <AppMenuSwitchItem
          className={itemClassName}
          checked={knowledgeBaseProactive}
          disabled={Boolean(onRagEnabledChange && !ragEnabled)}
          onCheckedChange={handleKnowledgeBaseProactiveChange}
          data-testid="plus-menu-kb-proactive"
          title={t('chatV2:inputBar.plusMenu.kbProactiveHint')}
        >
          {t('chatV2:inputBar.plusMenu.kbProactive')}
        </AppMenuSwitchItem>
      )}
      {sessionId && <KbScopeMenuItem sessionId={sessionId} className={itemClassName} />}
    </>
  );

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
          width={useFlatMobileMenu ? 248 : 196}
          maxHeight={useFlatMobileMenu ? 'min(28rem, calc(100dvh - 7.5rem))' : undefined}
          style={{ zIndex: Z_INDEX.composerPanel }}
          data-testid="composer-plus-menu"
        >
          {useFlatMobileMenu ? (
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

              {showKnowledgeBase && (
                <>
                  <AppMenuSeparator />
                  <AppMenuGroup
                    label={t('chatV2:inputBar.plusMenu.knowledgeBase')}
                    data-testid="plus-menu-knowledge-base-panel"
                  >
                    {renderKnowledgeBaseItems(mobileItemClass)}
                  </AppMenuGroup>
                </>
              )}

              {((showSkills && onOpenSkillPanel) || showConnectors) && <AppMenuSeparator />}
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
            </>
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

              {showKnowledgeBase && (
                <AppMenuSub openOnClick>
                  <AppMenuSubTrigger
                    icon={<Books className="w-4 h-4" />}
                    data-testid="plus-menu-knowledge-base"
                  >
                    <span className="truncate">
                      {t('chatV2:inputBar.plusMenu.knowledgeBase')}
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
                    {renderKnowledgeBaseItems()}
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
                  {open ? (
                    <AppMenuSubContent
                      className="w-[min(360px,calc(100vw-24px))] max-h-[min(520px,70vh)] overflow-hidden p-0"
                      data-testid="plus-menu-skills-panel"
                      onMouseDown={(event) => event.stopPropagation()}
                    >
                      <div className="flex max-h-[min(520px,70vh)] flex-col overflow-hidden">
                        {renderSkillPanel?.()}
                      </div>
                    </AppMenuSubContent>
                  ) : null}
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
            </AppMenuGroup>
          )}
        </AppMenuContent>
      </AppMenu>

      {pluginWorkshopActive && onTogglePluginWorkshop && (
        <button
          type="button"
          className={cn(
            'group inline-flex shrink-0 items-center justify-center focus-visible:outline-none',
            '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
          )}
          onClick={() => void onTogglePluginWorkshop()}
          data-testid="plugin-workshop-active"
          title={t('chatV2:inputBar.plusMenu.pluginWorkshopExitHint')}
          aria-label={t('chatV2:inputBar.plusMenu.pluginWorkshopExitHint')}
        >
          <span
            className={cn(
              'inline-flex h-6 items-center gap-1 rounded-md',
              'bg-primary/15 px-2 text-caption font-medium leading-none text-primary',
              'group-hover:bg-primary/25 group-focus-visible:ring-1 group-focus-visible:ring-primary/40',
            )}
          >
            <PuzzlePiece size={12} weight="fill" className="shrink-0" aria-hidden="true" />
            <span className="max-w-[5rem] truncate">
              {t('chatV2:inputBar.plusMenu.pluginWorkshopActive')}
            </span>
            <X size={10} weight="bold" className="shrink-0 opacity-70 group-hover:opacity-100" aria-hidden="true" />
          </span>
        </button>
      )}
      {permissionPreset === 'full_access' && (
        <button
          type="button"
          className={cn(
            'group inline-flex shrink-0 items-center justify-center focus-visible:outline-none',
            '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
          )}
          onClick={() => void downgradePermissionPreset('relaxed')}
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
          className={cn(
            'group inline-flex shrink-0 items-center justify-center focus-visible:outline-none',
            '[@media(pointer:coarse)]:min-h-[var(--touch-target-size)]',
          )}
          onClick={() => void downgradePermissionPreset('relaxed')}
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
        open={switchError !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) setSwitchError(null);
        }}
        title={t('chatV2:authority.permissionPreset.switchFailedTitle')}
        description={switchError ?? ''}
        confirmText={t('common:actions.ok')}
        onConfirm={() => setSwitchError(null)}
      />
    </div>
  );
});

ComposerPlusMenu.displayName = 'ComposerPlusMenu';

export default ComposerPlusMenu;

/** 知识库「检索范围」：显示当前范围，点击打开文件夹选择器（由 KbScopePickerHost 承载） */
const KbScopeMenuItem: React.FC<{ sessionId: string; className?: string }> = ({
  sessionId,
  className,
}) => {
  const { t } = useTranslation(['chatV2']);
  const scope = useKbScope(sessionId);
  return (
    <AppMenuItem
      className={className}
      icon={<FolderSimple className="w-4 h-4" />}
      onClick={() => requestKbScopePicker(sessionId)}
      data-testid="plus-menu-kb-scope"
    >
      {scope.label
        ? t('chatV2:inputBar.plusMenu.kbScopeOnly', {
            defaultValue: '只检索：{{name}}',
            name: scope.label,
          })
        : t('chatV2:inputBar.plusMenu.kbScopeAll', { defaultValue: '检索范围：全部资料' })}
    </AppMenuItem>
  );
};

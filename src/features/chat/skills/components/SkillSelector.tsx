/**
 * Chat V2 - SkillSelector 组件
 *
 * 技能选择面板，支持搜索和激活技能。
 * 视觉骨架统一走 ComposerPanel.* primitives，列表行选中态走 --button-primary-* 强调色。
 */

import React, { useState, useMemo, useCallback, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Lightning, ArrowClockwise, Check, User, Wrench, Star, CaretLeft, ShieldWarning, ShieldCheck, Terminal, Stack, X } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import { NotionButton } from '@/components/ui/NotionButton';
import { CustomScrollArea } from '@/components/custom-scroll-area';
import { useEventRegistry } from '@/hooks/useEventRegistry';
import { useMobileLayoutSafe } from '@/components/layout/MobileLayoutContext';
import { registerBackHandler, BACK_PRIORITY } from '@/app/navigation/androidBackCoordinator';
import { ComposerPanel } from '@/features/chat/components/input-bar/ComposerPanel';
import { skillRegistry, subscribeToSkillRegistry } from '../registry';
import { useLoadedSkills } from '../hooks/useLoadedSkills';
import { useSkillFavorites } from '../hooks/useSkillFavorites';
import { useSkillDefaults } from '../hooks/useSkillDefaults';
import {
  getLocalizedSkillDescription,
  getLocalizedSkillName,
  getLocationLabel,
  getLocationStyle,
} from '../utils';
import { getSkillEmbeddedToolLabels, getSkillPermissionSummary } from '../packageMetadata';
import { resolveEffectiveTrustStatus, setSkillTrustOverride } from '../skillTrustStorage';
import { isSkillDisabled, setSkillDisabled, SKILL_ENABLED_CHANGED_EVENT } from '../skillEnableStorage';
import { getSkillUsageScore, SKILL_USAGE_CHANGED_EVENT } from '../skillUsageStats';
import {
  getSkillBundles,
  saveSkillBundle,
  deleteSkillBundle,
  SKILL_BUNDLES_CHANGED_EVENT,
} from '../skillBundles';

// ============================================================================
// 类型定义
// ============================================================================

export interface SkillSelectorProps {
  /** 当前激活的技能 ID 列表（支持多选） */
  activeSkillIds: string[];
  /** 激活/取消激活技能回调（切换模式） */
  onToggleSkill: (skillId: string) => void | Promise<void>;
  /** 关闭面板回调 */
  onClose?: () => void;
  /** 刷新技能列表回调 */
  onRefresh?: () => Promise<void>;
  /** 是否禁用操作 */
  disabled?: boolean;
  /** 自定义类名 */
  className?: string;
  /** 会话 ID（用于显示工具调用加载的技能状态） */
  sessionId?: string | null;
}

// ============================================================================
// 组件
// ============================================================================

export const SkillSelector: React.FC<SkillSelectorProps> = ({
  activeSkillIds,
  onToggleSkill,
  onClose,
  onRefresh,
  disabled = false,
  className,
  sessionId,
}) => {
  const { t } = useTranslation(['skills', 'common']);

  const { isSkillLoaded } = useLoadedSkills(sessionId ?? null);
  const { isFavorite, toggleFavorite } = useSkillFavorites();
  const { defaultIds, isDefault, toggleDefault } = useSkillDefaults();

  const [searchTerm, setSearchTerm] = useState('');
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [registryVersion, setRegistryVersion] = useState(0);
  const [selectedSkillId, setSelectedSkillId] = useState<string | null>(null);
  // 信任覆盖存在 localStorage，变更后靠 tick 强制重算 resolveEffectiveTrustStatus
  const [, setTrustTick] = useState(0);
  // 停用覆盖同样存在 localStorage，变更后靠 tick 强制重算 isSkillDisabled
  const [, setEnableTick] = useState(0);
  // 使用遥测同样存在 localStorage，变更后靠 tick 重算排序
  const [usageTick, setUsageTick] = useState(0);
  // 技能组合（Bundles）
  const [bundlesTick, setBundlesTick] = useState(0);
  const [bundleNameInput, setBundleNameInput] = useState<string | null>(null);

  useEffect(() => {
    const unsubscribe = subscribeToSkillRegistry(() => {
      setRegistryVersion((v) => v + 1);
    });
    return unsubscribe;
  }, []);

  useEventRegistry(
    [
      { target: 'window', type: 'SKILL_TRUST_CHANGED', listener: () => setTrustTick((v) => v + 1) },
      { target: 'window', type: SKILL_ENABLED_CHANGED_EVENT, listener: () => setEnableTick((v) => v + 1) },
      { target: 'window', type: SKILL_USAGE_CHANGED_EVENT, listener: () => setUsageTick((v) => v + 1) },
      { target: 'window', type: SKILL_BUNDLES_CHANGED_EVENT, listener: () => setBundlesTick((v) => v + 1) },
    ],
    []
  );

  const allSkills = useMemo(() => {
    return skillRegistry.getAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registryVersion]);

  const filteredSkills = useMemo(() => {
    let result = allSkills;

    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      result = result.filter(
        (skill) =>
          getLocalizedSkillName(skill.id, skill.name, t).toLowerCase().includes(term) ||
          getLocalizedSkillDescription(skill.id, skill.description, t).toLowerCase().includes(term) ||
          skill.id.toLowerCase().includes(term)
      );
    }

    const favoriteSet = new Set(result.filter((s) => isFavorite(s.id)).map((s) => s.id));
    const defaultSet = new Set(defaultIds);

    return [...result].sort((a, b) => {
      const aFav = favoriteSet.has(a.id) ? 0 : 1;
      const bFav = favoriteSet.has(b.id) ? 0 : 1;
      if (aFav !== bFav) return aFav - bFav;
      const aDefault = defaultSet.has(a.id) ? 0 : 1;
      const bDefault = defaultSet.has(b.id) ? 0 : 1;
      if (aDefault !== bDefault) return aDefault - bDefault;
      // 使用遥测：同层级内常用技能靠前
      return getSkillUsageScore(b.id) - getSkillUsageScore(a.id);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allSkills, searchTerm, isFavorite, defaultIds, t, usageTick]);

  // 从全量技能解析选中项：搜索词过滤掉选中技能时，详情面板仍保持可见
  // （尤其是移动端，否则列表隐藏 + 详情空白会造成无法返回的死角）
  const selectedSkill = useMemo(() => {
    if (!selectedSkillId) return null;
    return allSkills.find((s) => s.id === selectedSkillId) || null;
  }, [selectedSkillId, allSkills]);

  const selectedSkillToolCount = useMemo(() => {
    if (!selectedSkill) return 0;
    return selectedSkill.embeddedTools?.length ?? 0;
  }, [selectedSkill]);

  const handleSelect = useCallback((skillId: string) => {
    setSelectedSkillId(skillId);
  }, []);

  const handleToggleActivate = useCallback(
    (skillId: string) => {
      if (disabled) return;
      // 停用的技能不可被激活；仍允许取消先前的激活状态
      if (isSkillDisabled(skillId) && !activeSkillIds.includes(skillId)) return;
      onToggleSkill(skillId);
    },
    [disabled, onToggleSkill, activeSkillIds]
  );

  const isSkillActive = useCallback(
    (skillId: string) => activeSkillIds.includes(skillId),
    [activeSkillIds]
  );

  const handleRefresh = useCallback(async () => {
    if (!onRefresh || isRefreshing) return;
    setIsRefreshing(true);
    try {
      await onRefresh();
    } finally {
      setIsRefreshing(false);
    }
  }, [onRefresh, isRefreshing]);

  const handleTrustOverride = useCallback(async (skillId: string, trust: 'trusted' | 'untrusted') => {
    try {
      await setSkillTrustOverride(skillId, trust);
      setTrustTick((v) => v + 1);
    } catch (error) {
      console.error('[SkillTrust] Failed to update trust:', error);
    }
  }, []);

  const handleEnableSkill = useCallback((skillId: string) => {
    setSkillDisabled(skillId, false);
    setEnableTick((v) => v + 1);
  }, []);

  // ========== 技能组合（Bundles） ==========
  const bundles = useMemo(() => {
    void bundlesTick;
    return getSkillBundles();
  }, [bundlesTick]);

  // 一键激活组合：只补激活未激活的技能，不做取消。
  // ★ 必须顺序 await：activateSkill 内有 per-store 并发锁，同步循环会导致
  // 第二个及之后的激活请求被锁丢弃（整组只激活第一个）。
  const handleActivateBundle = useCallback(async (skillIds: string[]) => {
    if (disabled) return;
    for (const skillId of skillIds) {
      if (activeSkillIds.includes(skillId)) continue;
      if (!skillRegistry.get(skillId)) continue;
      if (isSkillDisabled(skillId)) continue;
      await onToggleSkill(skillId);
    }
  }, [disabled, activeSkillIds, onToggleSkill]);

  const handleSaveBundle = useCallback(() => {
    const name = (bundleNameInput ?? '').trim();
    if (!name || activeSkillIds.length === 0) return;
    const saved = saveSkillBundle(name, activeSkillIds);
    if (saved) {
      setBundleNameInput(null);
    }
  }, [bundleNameInput, activeSkillIds]);

  const mobileLayout = useMobileLayoutSafe();
  const isMobile = mobileLayout?.isMobile ?? false;

  // 📱 移动端详情子屏：Android 返回键先退回技能列表，再由 InputBarUI 关闭整个面板
  // （同优先级后注册者先执行，本 handler 在面板打开后才注册，天然先于面板关闭 handler）
  useEffect(() => {
    if (!isMobile || !selectedSkillId) return;
    return registerBackHandler(() => {
      setSelectedSkillId(null);
      return true;
    }, BACK_PRIORITY.overlay);
  }, [isMobile, selectedSkillId]);

  const headerActions = onRefresh ? (
    <NotionButton
      variant="ghost"
      size="icon"
      iconOnly
      onClick={handleRefresh}
      disabled={isRefreshing}
      aria-label={t('skills:selector.refresh')}
      title={t('skills:selector.refresh')}
      className={cn(isRefreshing && 'animate-spin')}
    >
      <ArrowClockwise size={16} />
    </NotionButton>
  ) : null;

  return (
    <ComposerPanel.Root fillHeight className={cn('overflow-hidden', className)}>
      {/* 📱 移动端也渲染 Header：提供可见的关闭按钮（契约：面板须可见关闭 + 返回键） */}
      <ComposerPanel.Header
        icon={Lightning}
        title={t('skills:selector.title')}
        subtitle={t('skills:selector.count', {count: allSkills.length})}
        actions={headerActions}
        onClose={onClose}
        closeAriaLabel={t('common:actions.close')}
      />

      <ComposerPanel.Search
        value={searchTerm}
        onChange={setSearchTerm}
        placeholder={t('skills:selector.searchPlaceholder')}
        ariaLabel={t('skills:selector.searchPlaceholder')}
      />

      {/* 技能组合：一键整组激活 + 保存当前激活为组合 */}
      {(bundles.length > 0 || activeSkillIds.length >= 2) && (
        <div className="flex flex-wrap items-center gap-1.5 px-1 pb-1.5">
          {bundles.map((bundle) => (
            <span
              key={bundle.id}
              className="group inline-flex items-center gap-1 rounded-full border border-[color:var(--composer-panel-control-border)] pl-2 pr-1 py-0.5 text-[11px]"
            >
              {/* eslint-disable-next-line ds-components/no-native-button -- chip 内联小按钮，NotionButton 尺寸体系不适配 */}
              <button
                type="button"
                onClick={() => void handleActivateBundle(bundle.skillIds)}
                disabled={disabled}
                title={bundle.skillIds.join(', ')}
                aria-label={t('skills:bundles.activate', { name: bundle.name })}
                className="inline-flex items-center gap-1 text-foreground hover:opacity-80 disabled:opacity-50"
              >
                <Stack size={11} />
                {bundle.name}
                <span className="text-muted-foreground/60">{bundle.skillIds.length}</span>
              </button>
              {/* eslint-disable-next-line ds-components/no-native-button -- chip 内联删除按钮 */}
              <button
                type="button"
                onClick={() => deleteSkillBundle(bundle.id)}
                aria-label={t('skills:bundles.delete', { name: bundle.name })}
                title={t('skills:bundles.delete', { name: bundle.name })}
                className="ml-0.5 rounded-full p-0.5 text-muted-foreground/50 opacity-0 transition-opacity hover:text-foreground group-hover:opacity-100 max-lg:opacity-100"
              >
                <X size={10} />
              </button>
            </span>
          ))}

          {activeSkillIds.length >= 2 && (
            bundleNameInput === null ? (
              // eslint-disable-next-line ds-components/no-native-button -- chip 形态入口
              <button
                type="button"
                onClick={() => setBundleNameInput('')}
                className="inline-flex items-center gap-1 rounded-full border border-dashed border-[color:var(--composer-panel-control-border)] px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <Stack size={11} />
                {t('skills:bundles.save_current', { count: activeSkillIds.length })}
              </button>
            ) : (
              <span className="inline-flex items-center gap-1">
                <input
                  autoFocus
                  value={bundleNameInput}
                  onChange={(e) => setBundleNameInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleSaveBundle();
                    if (e.key === 'Escape') setBundleNameInput(null);
                  }}
                  placeholder={t('skills:bundles.name_placeholder')}
                  aria-label={t('skills:bundles.name_placeholder')}
                  className="h-6 w-32 rounded-md border border-[color:var(--composer-panel-control-border)] bg-transparent px-2 text-[11px] outline-none focus:border-[color:var(--button-primary-border)]"
                />
                {/* eslint-disable-next-line ds-components/no-native-button -- chip 内联确认按钮 */}
                <button
                  type="button"
                  onClick={handleSaveBundle}
                  disabled={!(bundleNameInput ?? '').trim()}
                  aria-label={t('common:actions.confirm')}
                  className="rounded-md p-1 text-muted-foreground hover:text-foreground disabled:opacity-40"
                >
                  <Check size={12} weight="bold" />
                </button>
              </span>
            )
          )}
        </div>
      )}

      {/* 分栏布局：左侧技能列表 + 右侧详情面板 */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        {/* 左侧：技能列表 */}
        <CustomScrollArea
          className={cn(
            'h-full',
            // 以解析后的 selectedSkill 判断：选中技能被删除/刷新掉时移动端回退到列表，避免死角
            isMobile ? (selectedSkill ? 'hidden' : 'w-full') : 'w-1/2'
          )}
          viewportClassName="space-y-1 pr-1"
        >
          {filteredSkills.length === 0 ? (
            <ComposerPanel.Empty
              icon={Lightning}
              description={searchTerm ? t('skills:selector.noResults') : t('skills:selector.empty')}
            />
          ) : (
            <div className="space-y-1">
              {filteredSkills.map((skill) => {
                const isSelected = skill.id === selectedSkillId;
                const isActiveSkill = isSkillActive(skill.id);
                const isToolLoaded = isSkillLoaded(skill.id);
                const isDefaultSkill = isDefault(skill.id);
                const isDisabledSkill = isSkillDisabled(skill.id);
                const activationBlocked = disabled || (isDisabledSkill && !isActiveSkill);
                const skillName = getLocalizedSkillName(skill.id, skill.name, t);

                return (
                  <ComposerPanel.Row
                    key={skill.id}
                    selected={isSelected}
                    selectedAccent="tinted"
                    onClick={() => handleSelect(skill.id)}
                    aria-label={skillName}
                    leading={
                      !isActiveSkill && isToolLoaded ? (
                        <span
                          className="mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center text-amber-500"
                          title={t('skills:status.toolLoaded')}
                          aria-hidden="true"
                        >
                          <Lightning size={14} />
                        </span>
                      ) : (
                        // eslint-disable-next-line ds-components/no-native-button -- 此处需精确控制 --button-primary-* token 的 16px 方块复选框，NotionButton 的 size/variant 体系不适配
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (!activationBlocked) handleToggleActivate(skill.id);
                          }}
                          disabled={activationBlocked}
                          aria-pressed={isActiveSkill}
                          aria-label={
                            isDisabledSkill && !isActiveSkill
                              ? t('skills:selector.disabled_hint')
                              : isActiveSkill
                                ? t('skills:card.clickToDeactivate')
                                : t('skills:card.clickToActivate')
                          }
                          title={
                            isDisabledSkill && !isActiveSkill
                              ? t('skills:selector.disabled_hint')
                              : isActiveSkill
                                ? t('skills:card.clickToDeactivate')
                                : t('skills:card.clickToActivate')
                          }
                          className={cn(
                            'mt-0.5 flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md border text-[11px] font-semibold transition-colors',
                            'relative after:absolute after:-inset-2.5 after:content-[\'\']',
                            isActiveSkill
                              ? 'border-[color:var(--button-primary-border)] bg-[color:var(--button-primary-surface)] text-[color:var(--button-primary-foreground)]'
                              : 'border-[color:var(--composer-panel-control-border)] text-transparent',
                            !activationBlocked && !isActiveSkill && 'hover:border-[color:var(--button-primary-border)]',
                            activationBlocked && 'cursor-not-allowed opacity-60'
                          )}
                        >
                          {isActiveSkill ? <Check size={12} weight="bold" /> : null}
                        </button>
                      )
                    }
                    trailing={
                      <span className="flex shrink-0 items-center gap-1">
                        <NotionButton
                          variant="ghost"
                          size="icon"
                          iconOnly
                          onClick={(e) => {
                            e.stopPropagation();
                            toggleFavorite(skill.id);
                          }}
                          aria-label={
                            isFavorite(skill.id)
                              ? t('skills:favorite.remove')
                              : t('skills:favorite.add')
                          }
                          title={
                            isFavorite(skill.id)
                              ? t('skills:favorite.remove')
                              : t('skills:favorite.add')
                          }
                          className={cn(
                            // 视觉 20px，透明伪元素扩大触控命中区（移动端契约 ≥44px 方向靠拢）
                            '!h-5 !w-5 relative after:absolute after:-inset-2 after:content-[\'\']',
                            isFavorite(skill.id)
                              ? 'text-amber-500 hover:text-amber-600'
                              : 'text-[color:var(--composer-panel-muted-foreground)] opacity-60 hover:text-amber-500 hover:opacity-100'
                          )}
                        >
                          <Star size={12} weight={isFavorite(skill.id) ? 'fill' : 'regular'} />
                        </NotionButton>
                        <span
                          className={cn(
                            'rounded px-1.5 py-0.5 text-[10px] font-medium',
                            getLocationStyle(skill.location)
                          )}
                        >
                          {getLocationLabel(skill.location, t)}
                        </span>
                      </span>
                    }
                  >
                    <span className={cn('flex items-center gap-1.5', isDisabledSkill && 'opacity-60')}>
                      <span
                        className={cn(
                          'truncate text-sm font-medium',
                          isToolLoaded && 'text-amber-600 dark:text-amber-400'
                        )}
                      >
                        {skillName}
                      </span>
                      {isDisabledSkill ? (
                        <span
                          className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                          title={t('skills:selector.disabled_hint')}
                        >
                          {t('skills:selector.disabled_badge')}
                        </span>
                      ) : null}
                      {isDefaultSkill ? (
                        <span
                          className="inline-flex shrink-0 items-center gap-0.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400"
                          title={t('skills:default.isDefault')}
                        >
                          <Check size={9} />
                          {t('skills:default.label')}
                        </span>
                      ) : null}
                    </span>
                  </ComposerPanel.Row>
                );
              })}
            </div>
          )}
        </CustomScrollArea>

        {/* 右侧：技能详情面板 */}
        <div
          className={cn(
            'flex h-full flex-col',
            isMobile ? (selectedSkill ? 'w-full' : 'hidden') : 'w-1/2 border-l border-[color:var(--composer-panel-control-border)] pl-3'
          )}
        >
          {selectedSkill ? (
            <>
              {isMobile && (
                <NotionButton
                  variant="ghost"
                  size="sm"
                  onClick={() => setSelectedSkillId(null)}
                  className="mb-2 shrink-0"
                >
                  <CaretLeft size={14} />
                  <span>{t('common:actions.back')}</span>
                </NotionButton>
              )}
              <CustomScrollArea className="flex-1 min-h-0" viewportClassName="pr-1">
                <div className="mb-2 flex items-start justify-between gap-2">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <h3
                        className={cn(
                          'truncate text-base font-medium text-[color:var(--composer-panel-foreground)]',
                          isSkillDisabled(selectedSkill.id) && 'opacity-60'
                        )}
                      >
                        {getLocalizedSkillName(selectedSkill.id, selectedSkill.name, t)}
                      </h3>
                      {isSkillDisabled(selectedSkill.id) ? (
                        <span className="inline-flex shrink-0 items-center rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                          {t('skills:selector.disabled_badge')}
                        </span>
                      ) : null}
                      <NotionButton
                        variant="ghost"
                        size="icon"
                        iconOnly
                        onClick={() => toggleFavorite(selectedSkill.id)}
                        className={cn(
                          '!h-6 !w-6',
                          isFavorite(selectedSkill.id)
                            ? 'text-amber-500 hover:text-amber-600'
                            : 'text-[color:var(--composer-panel-muted-foreground)] opacity-60 hover:text-amber-500 hover:opacity-100'
                        )}
                        aria-label={
                          isFavorite(selectedSkill.id)
                            ? t('skills:favorite.remove')
                            : t('skills:favorite.add')
                        }
                        title={
                          isFavorite(selectedSkill.id)
                            ? t('skills:favorite.remove')
                            : t('skills:favorite.add')
                        }
                      >
                        <Star size={14} weight={isFavorite(selectedSkill.id) ? 'fill' : 'regular'} />
                      </NotionButton>
                    </div>
                    <div className="mt-0.5 flex items-center gap-2">
                      {selectedSkill.version ? (
                        <span className="text-xs text-[color:var(--composer-panel-muted-foreground)]">
                          v{selectedSkill.version}
                        </span>
                      ) : null}
                      {isDefault(selectedSkill.id) ? (
                        <span className="inline-flex items-center gap-0.5 rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400">
                          <Check size={9} />
                          {t('skills:default.isDefault')}
                        </span>
                      ) : null}
                    </div>
                  </div>
                  <span
                    className={cn(
                      'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                      getLocationStyle(selectedSkill.location)
                    )}
                  >
                    {getLocationLabel(selectedSkill.location, t)}
                  </span>
                </div>

                <p
                  className={cn(
                    'mb-3 text-xs text-[color:var(--composer-panel-muted-foreground)]',
                    isSkillDisabled(selectedSkill.id) && 'opacity-60'
                  )}
                >
                  {getLocalizedSkillDescription(selectedSkill.id, selectedSkill.description, t)}
                </p>

                {isSkillDisabled(selectedSkill.id) ? (
                  <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-0.5 rounded-md bg-muted px-2 py-1.5 text-[11px] text-muted-foreground">
                    <span>{t('skills:selector.disabled_hint')}</span>
                    <NotionButton
                      variant="ghost"
                      size="sm"
                      onClick={() => handleEnableSkill(selectedSkill.id)}
                      className="!h-auto !px-1.5 !py-0.5 text-xs font-medium text-primary hover:underline"
                    >
                      {t('skills:selector.enable')}
                    </NotionButton>
                  </div>
                ) : null}

                {(() => {
                  const trust = resolveEffectiveTrustStatus(selectedSkill);
                  const source = selectedSkill.packageSource ?? (selectedSkill.isBuiltin ? 'builtin' : selectedSkill.location);
                  const canToggleTrust = !selectedSkill.isBuiltin && source !== 'builtin';
                  if (trust === 'untrusted') {
                    return (
                      <div className="mb-3 space-y-1 rounded-md border border-amber-500/30 bg-amber-500/10 px-2 py-1.5 text-[11px] text-amber-700 dark:text-amber-300">
                        <div className="flex items-start gap-1.5">
                          <ShieldWarning size={12} className="mt-0.5 shrink-0" />
                          <span>{t('skills:selector.untrusted_hint')}</span>
                        </div>
                        {canToggleTrust && (
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-[18px]">
                            <NotionButton
                              variant="ghost"
                              size="sm"
                              onClick={() => handleTrustOverride(selectedSkill.id, 'trusted')}
                              className="!h-auto !px-1.5 !py-0.5 text-xs font-medium text-primary hover:underline"
                            >
                              {t('skills:package.trust_enable')}
                            </NotionButton>
                            <span className="text-[10px] opacity-80">
                              {t('skills:package.trust_effect_trusted')}
                            </span>
                          </div>
                        )}
                      </div>
                    );
                  }
                  if (trust === 'trusted' && canToggleTrust) {
                    return (
                      <div className="mb-3 flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px] text-[color:var(--composer-panel-muted-foreground)]">
                        <ShieldCheck size={12} className="shrink-0 text-emerald-600 dark:text-emerald-400" />
                        <span title={t('skills:package.trust_effect_trusted')}>
                          {t('skills:package.trust_trusted')}
                        </span>
                        <NotionButton
                          variant="ghost"
                          size="sm"
                          onClick={() => handleTrustOverride(selectedSkill.id, 'untrusted')}
                          title={t('skills:package.trust_effect_untrusted')}
                          className="!h-auto !px-1.5 !py-0.5 text-xs hover:underline"
                        >
                          {t('skills:package.trust_revoke')}
                        </NotionButton>
                      </div>
                    );
                  }
                  return null;
                })()}

                {(() => {
                  const perm = getSkillPermissionSummary(selectedSkill);
                  const toolLabels = getSkillEmbeddedToolLabels(selectedSkill, 10);
                  if (toolLabels.length === 0 && perm.scripts === 0) return null;
                  return (
                    <div className="mb-3 space-y-1.5">
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-[color:var(--composer-panel-muted-foreground)]">
                        {t('skills:selector.capabilities')}
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {perm.scripts > 0 && (
                          <span className="inline-flex items-center gap-0.5 rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            <Terminal size={10} />
                            {t('skills:package.permission_scripts', { count: perm.scripts })}
                          </span>
                        )}
                        {toolLabels.map((label) => (
                          <span
                            key={label}
                            className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                          >
                            {label}
                          </span>
                        ))}
                      </div>
                    </div>
                  );
                })()}

                {(selectedSkillToolCount > 0 || selectedSkill.author) && (
                  <div className="mb-3 flex items-center gap-3 text-xs text-[color:var(--composer-panel-muted-foreground)]">
                    {selectedSkillToolCount > 0 && (
                      <span className="flex items-center gap-1">
                        <Wrench size={12} />
                        {t('skills:card.toolsCount', { count: selectedSkillToolCount })}
                      </span>
                    )}
                    {selectedSkill.author && (
                      <span className="flex items-center gap-1">
                        <User size={12} />
                        <span className="max-w-[100px] truncate">{selectedSkill.author}</span>
                      </span>
                    )}
                  </div>
                )}
              </CustomScrollArea>

              <ComposerPanel.Footer divided className="!justify-stretch flex-col gap-2">
                <NotionButton
                  variant={isDefault(selectedSkill.id) ? 'success' : 'default'}
                  size="md"
                  onClick={() => toggleDefault(selectedSkill.id)}
                  className="w-full"
                >
                  <Check
                    size={14}
                    className={cn(
                      'transition-opacity',
                      !isDefault(selectedSkill.id) && 'opacity-50'
                    )}
                  />
                  <span>
                    {isDefault(selectedSkill.id)
                      ? t('skills:default.removeDefault')
                      : t('skills:default.setDefault')}
                  </span>
                </NotionButton>

                {isSkillLoaded(selectedSkill.id) && !isSkillActive(selectedSkill.id) ? (
                  <div className="flex w-full items-center justify-center gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-2.5 text-sm font-medium text-amber-600 dark:text-amber-400">
                    <Lightning size={16} />
                    <span>{t('skills:card.loadedByTool')}</span>
                  </div>
                ) : (
                  <NotionButton
                    variant={isSkillActive(selectedSkill.id) ? 'primary' : 'default'}
                    size="md"
                    onClick={() => handleToggleActivate(selectedSkill.id)}
                    disabled={disabled || (isSkillDisabled(selectedSkill.id) && !isSkillActive(selectedSkill.id))}
                    title={
                      isSkillDisabled(selectedSkill.id) && !isSkillActive(selectedSkill.id)
                        ? t('skills:selector.disabled_hint')
                        : undefined
                    }
                    className="w-full"
                  >
                    {isSkillActive(selectedSkill.id) ? (
                      <>
                        <Check size={16} />
                        <span>{t('skills:card.activatedClickToCancel')}</span>
                      </>
                    ) : (
                      <>
                        <Lightning size={16} />
                        <span>{t('skills:card.activateSkill')}</span>
                      </>
                    )}
                  </NotionButton>
                )}
              </ComposerPanel.Footer>
            </>
          ) : (
            // 移动端不会显示这个状态（因为没选中时会显示列表）
            <div className="flex h-full flex-col items-center justify-center gap-2 py-8 text-center">
              <Lightning
                size={22}
                className="text-[color:var(--composer-panel-muted-foreground)] opacity-60"
                aria-hidden="true"
              />
              <p className="text-xs text-[color:var(--composer-panel-muted-foreground)]">
                {t('skills:card.selectSkillToViewDetails')}
              </p>
            </div>
          )}
        </div>
      </div>
    </ComposerPanel.Root>
  );
};

export default SkillSelector;

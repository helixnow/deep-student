/**
 * 学习优先分层的技能管理页（SkillsManagementPage）
 *
 * 在保持原有技能管理壳层、搜索/位置筛选、导入更新与 Agent 观察面 100% 兼容的基础上，
 * 在顶部工具栏注入醒目的「学习精选 / 全部技能 / 系统与扩展」分类切换（默认展示学习精选），
 * 并按学生高频学习工作流权重排序，避免底层脚本工具与职场角色包淹没学习主场景。
 */

import React, { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { BookOpen, SquaresFour, Wrench } from '@phosphor-icons/react';
import { SkillsManagementPage as BaseSkillsManagementPage } from '@/components/skills-management';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { DsButton } from '@/components/ui/DsButton';
import { cn } from '@/lib/utils';
import {
  classifySkillAudience,
  getLearnerSkillSortRank,
  isKnownBuiltinSkillId,
  type SkillAudienceCategory,
} from './skillCategories';

export type SkillsManagementPageProps = React.ComponentProps<typeof BaseSkillsManagementPage> & {
  /** 初始选中的技能场景分类，默认优先展示「学习精选」(`learning`) */
  defaultCategory?: SkillAudienceCategory;
};

interface VisibleCounts {
  learning: number;
  all: number;
  system: number;
  visibleInActive: number;
  hiddenInOther: number;
}

export const SkillsManagementPage: React.FC<SkillsManagementPageProps> = ({
  defaultCategory = 'learning',
  ...baseProps
}) => {
  const { t } = useTranslation(['skills', 'common']);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const activeCategoryRef = useRef<SkillAudienceCategory>(defaultCategory);
  const [activeCategory, setActiveCategory] = useState<SkillAudienceCategory>(defaultCategory);
  activeCategoryRef.current = activeCategory;

  const [toolbarMountEl, setToolbarMountEl] = useState<HTMLElement | null>(null);
  const [emptyBannerMountEl, setEmptyBannerMountEl] = useState<HTMLElement | null>(null);
  const [counts, setCounts] = useState<VisibleCounts>({
    learning: 0,
    all: 0,
    system: 0,
    visibleInActive: 0,
    hiddenInOther: 0,
  });

  const syncDomAndCounts = useCallback(() => {
    const root = wrapperRef.current;
    if (!root) return;

    // 1. 确保顶部 .study-shell-toolbar 内挂载分类栏容器
    const toolbar = root.querySelector<HTMLElement>('.study-shell-toolbar');
    if (toolbar) {
      let slot = toolbar.querySelector<HTMLElement>('[data-skills-audience-slot="true"]');
      if (!slot) {
        slot = document.createElement('div');
        slot.setAttribute('data-skills-audience-slot', 'true');
        slot.className = 'pt-1 sm:pt-2';
        toolbar.appendChild(slot);
      }
      setToolbarMountEl((prev) => (prev === slot ? prev : slot));
    }

    // 2. 扫描当前由 BaseSkillsList 渲染的技能卡片，执行分类打标、学习优先排序与显隐过滤
    const cards = Array.from(
      root.querySelectorAll<HTMLElement>('[data-agent-entity^="skills:"]'),
    );
    const currentCategory = activeCategoryRef.current;

    let learning = 0;
    let system = 0;
    let visibleInActive = 0;

    for (const card of cards) {
      const entity = card.getAttribute('data-agent-entity') ?? '';
      const skillId = entity.slice('skills:'.length);
      const skillDef = {
        id: skillId,
        name: card.textContent ?? undefined,
        isBuiltin: isKnownBuiltinSkillId(skillId),
      };
      const category = classifySkillAudience(skillDef);
      const rank = getLearnerSkillSortRank(skillDef);

      if (category === 'learning') learning += 1;
      else system += 1;

      card.dataset.skillCategory = category;
      card.style.order = String(rank);

      const isVisible = currentCategory === 'all' || category === currentCategory;
      if (isVisible) visibleInActive += 1;

      card.hidden = !isVisible;
      card.style.display = isVisible ? '' : 'none';
    }

    const totalCards = cards.length;
    const hiddenInOther = totalCards - visibleInActive;

    // 3. 当搜索或位置筛选的结果恰好全在另一分类时，在卡片网格前提供一键切到「全部」的柔和引导
    const firstCardGrid = cards[0]?.parentElement ?? null;
    if (firstCardGrid && firstCardGrid.parentElement) {
      let bannerSlot = firstCardGrid.parentElement.querySelector<HTMLElement>(
        '[data-skills-empty-fallback-slot="true"]',
      );
      if (!bannerSlot) {
        bannerSlot = document.createElement('div');
        bannerSlot.setAttribute('data-skills-empty-fallback-slot', 'true');
        firstCardGrid.parentElement.insertBefore(bannerSlot, firstCardGrid);
      }
      setEmptyBannerMountEl((prev) => (prev === bannerSlot ? prev : bannerSlot));
    }

    const nextCounts: VisibleCounts =
      totalCards > 0
        ? {
            learning,
            all: totalCards,
            system,
            visibleInActive,
            hiddenInOther,
          }
        : {
            learning: 0,
            all: 0,
            system: 0,
            visibleInActive: 0,
            hiddenInOther: 0,
          };

    setCounts((prev) =>
      prev.learning === nextCounts.learning &&
      prev.all === nextCounts.all &&
      prev.system === nextCounts.system &&
      prev.visibleInActive === nextCounts.visibleInActive &&
      prev.hiddenInOther === nextCounts.hiddenInOther
        ? prev
        : nextCounts,
    );
  }, []);

  useLayoutEffect(() => {
    syncDomAndCounts();
  }, [syncDomAndCounts, activeCategory]);

  useLayoutEffect(() => {
    const root = wrapperRef.current;
    if (!root) return;

    const observer = new MutationObserver((mutations) => {
      const hasRelevantChildChange = mutations.some((m) => {
        if (m.type !== 'childList') return false;
        const targetEl = m.target instanceof HTMLElement ? m.target : null;
        if (!targetEl) return false;
        if (
          targetEl.closest('[data-skills-audience-slot="true"]') ||
          targetEl.closest('[data-skills-empty-fallback-slot="true"]')
        ) {
          return false;
        }
        return true;
      });
      if (hasRelevantChildChange) {
        syncDomAndCounts();
      }
    });

    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [syncDomAndCounts]);

  const categoryHint =
    activeCategory === 'learning'
      ? t('skills:management.categories.learning_hint')
      : activeCategory === 'system'
        ? t('skills:management.categories.system_hint')
        : t('skills:management.categories.all_hint');

  const categoryToolbarContent = (
    <div
      className="flex flex-wrap items-center justify-between gap-2 sm:border-t sm:border-border/30 sm:pt-2.5"
      data-testid="skills-audience-filter-bar"
    >
      <SegmentedControl<SkillAudienceCategory>
        ariaLabel={t('skills:management.categories.aria_label')}
        value={activeCategory}
        onValueChange={setActiveCategory}
        size="compact"
        className="flex w-full items-center gap-1 overflow-x-auto scrollbar-none sm:w-auto [&_.study-shell-segmented-thumb]:border-transparent"
        itemClassName="!h-auto !min-h-9 flex-1 justify-center !px-2.5 !py-1.5 text-xs font-medium whitespace-nowrap sm:!min-h-0 sm:flex-initial sm:!px-2.5 sm:!py-1 [@media(pointer:coarse)]:!min-h-[var(--touch-target-size)] [@media(pointer:coarse)]:!px-2.5"
        options={[
          {
            value: 'learning',
            label: (
              <>
                <BookOpen size={13} className="opacity-80" />
                <span>{t('skills:management.categories.learning')}</span>
                <span
                  data-testid="skills-count-learning"
                  className={cn(
                    'ml-0.5 text-2xs tabular-nums opacity-65',
                    activeCategory === 'learning' && 'font-bold opacity-100',
                  )}
                >
                  {counts.learning}
                </span>
              </>
            ),
          },
          {
            value: 'all',
            label: (
              <>
                <SquaresFour size={13} className="opacity-80" />
                <span>{t('skills:management.categories.all')}</span>
                <span
                  data-testid="skills-count-all"
                  className={cn(
                    'ml-0.5 text-2xs tabular-nums opacity-65',
                    activeCategory === 'all' && 'font-bold opacity-100',
                  )}
                >
                  {counts.all}
                </span>
              </>
            ),
          },
          {
            value: 'system',
            label: (
              <>
                <Wrench size={13} className="opacity-80" />
                <span>{t('skills:management.categories.system')}</span>
                <span
                  data-testid="skills-count-system"
                  className={cn(
                    'ml-0.5 text-2xs tabular-nums opacity-65',
                    activeCategory === 'system' && 'font-bold opacity-100',
                  )}
                >
                  {counts.system}
                </span>
              </>
            ),
          },
        ]}
      />
      <p className="hidden text-xs text-muted-foreground/75 sm:block">{categoryHint}</p>
    </div>
  );

  const emptyInTabBanner =
    activeCategory !== 'all' && counts.visibleInActive === 0 && counts.hiddenInOther > 0 ? (
      <div
        data-testid="skills-hidden-in-other-category"
        className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border/50 bg-[color:var(--surface-muted)] px-4 py-3 text-xs"
      >
        <span className="text-muted-foreground">
          {t('skills:management.categories.hidden_in_tab', { count: counts.hiddenInOther })}
        </span>
        <DsButton
          variant="outline"
          size="sm"
          onClick={() => setActiveCategory('all')}
          className="h-7 text-xs"
        >
          {t('skills:management.categories.switch_to_all')}
        </DsButton>
      </div>
    ) : null;

  return (
    <div ref={wrapperRef} className="contents">
      <BaseSkillsManagementPage {...baseProps} />
      {toolbarMountEl ? createPortal(categoryToolbarContent, toolbarMountEl) : null}
      {emptyBannerMountEl && emptyInTabBanner
        ? createPortal(emptyInTabBanner, emptyBannerMountEl)
        : null}
    </div>
  );
};

export default SkillsManagementPage;

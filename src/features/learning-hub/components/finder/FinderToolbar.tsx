import React, { useLayoutEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  AppMenu,
  AppMenuContent,
  AppMenuItem,
  AppMenuSeparator,
  AppMenuTrigger,
} from '@/components/ui/app-menu';
import { DsButton } from '@/components/ui/DsButton';
import {
  ArrowClockwise,
  CaretLeft,
  CaretRight,
  Check,
  DotsThree,
  FolderPlus,
  List,
  MagnifyingGlass,
  SortAscending,
  SortDescending,
  SquaresFour,
} from '@phosphor-icons/react';
import { cn } from '@/lib/utils';
import {
  classifyWbSysWidth,
  type WbSysSizeClass,
} from '@/features/workbench/apps/system/useWbSysSize';
import type { SortBy, SortOrder, ViewMode } from '../../stores/finderStore';

interface FinderToolbarProps {
  breadcrumbs: { id: string; name: string }[];
  onBreadcrumbClick: (index: number) => void;
  currentTitle?: string;
  onNavigateHome?: () => void;
  canGoBack?: boolean;
  canGoForward?: boolean;
  onBack?: () => void;
  onForward?: () => void;
  viewMode?: ViewMode;
  onViewModeChange?: (mode: ViewMode) => void;
  sortBy?: SortBy;
  sortOrder?: SortOrder;
  onSortChange?: (sortBy: SortBy, sortOrder: SortOrder) => void;
  searchQuery?: string;
  onSearchChange?: (value: string) => void;
  /** View-honest placeholder (recent/trash/favorites/smart folder) */
  searchPlaceholder?: string;
  searchDisabled?: boolean;
  onNewFolder?: () => void;
  onRefresh?: () => void;
  titlebarMode?: false | 'shell' | 'window';
}

/** 触屏面包屑命中区扩展：padding 撑出热区，负 margin 抵消占位（对齐 MobileBreadcrumb 范式） */
const CRUMB_TOUCH_HIT_CLASS =
  '[@media(pointer:coarse)]:!px-1.5 [@media(pointer:coarse)]:!py-2.5 [@media(pointer:coarse)]:!-mx-0.5 [@media(pointer:coarse)]:!-my-2.5';

const SORT_OPTIONS: { value: SortBy; labelKey: string }[] = [
  { value: 'name', labelKey: 'finder.sort.name' },
  { value: 'updatedAt', labelKey: 'finder.sort.updatedAt' },
  { value: 'createdAt', labelKey: 'finder.sort.createdAt' },
  { value: 'type', labelKey: 'finder.sort.type' },
  { value: 'size', labelKey: 'finder.sort.size' },
];

/**
 * 工具栏自身宽度分级（与 O18 useWbSysSize 同源阈值 classifyWbSysWidth）。
 *
 * legacy 全屏页没有 data-wb-sys-size 宿主可读，workbench 标题栏槽的宽度
 * 也不等于窗口内容区宽度，因此直接用 ResizeObserver 观察工具栏自身：
 * compact（<640px）时把排序 / 新建 / 刷新收进溢出菜单，避免窄窗按钮溢出换行。
 * 分级结果同时写到根元素 data-wb-size 属性，供 CSS / 测试消费。
 */
function useToolbarSizeClass(): {
  ref: React.RefObject<HTMLDivElement>;
  sizeClass: WbSysSizeClass;
} {
  const ref = useRef<HTMLDivElement>(null);
  const [sizeClass, setSizeClass] = useState<WbSysSizeClass>('wide');
  const lastRef = useRef<WbSysSizeClass>('wide');

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const apply = (width: number) => {
      const next = classifyWbSysWidth(width);
      if (el.getAttribute('data-wb-size') !== next) {
        el.setAttribute('data-wb-size', next);
      }
      if (lastRef.current !== next) {
        lastRef.current = next;
        setSizeClass(next);
      }
    };

    apply(el.getBoundingClientRect().width || el.clientWidth);

    // jsdom / 老 WebView 无 ResizeObserver 时安全兜底为首帧量宽结果
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry) return;
      const box = entry.contentBoxSize?.[0];
      apply(box ? box.inlineSize : entry.contentRect.width);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return { ref, sizeClass };
}

/** 可点击压缩面包屑：根 / 中间可点，末级文本；深度大时 Home › … › current */
function CompressedBreadcrumbs({
  breadcrumbs,
  onBreadcrumbClick,
  onNavigateHome,
  currentTitle,
  rootLabel,
}: {
  breadcrumbs: { id: string; name: string }[];
  onBreadcrumbClick: (index: number) => void;
  onNavigateHome?: () => void;
  currentTitle?: string;
  rootLabel: string;
}) {
  const lastCrumb = breadcrumbs[breadcrumbs.length - 1];
  const title = currentTitle || lastCrumb?.name || rootLabel;
  const deep = breadcrumbs.length > 2;

  const sep = (
    <span className="shrink-0 px-0.5 text-foreground/35" aria-hidden>
      ›
    </span>
  );

  const homeButton = (
    <DsButton
      variant="ghost"
      size="sm"
      onClick={() => (onNavigateHome ? onNavigateHome() : onBreadcrumbClick(-1))}
      className={cn(
        '!h-auto !min-w-0 !px-1 !py-0 text-ui font-medium tracking-tight',
        CRUMB_TOUCH_HIT_CLASS,
        breadcrumbs.length === 0
          ? 'text-foreground/85 cursor-default'
          : 'text-foreground/55 hover:text-foreground'
      )}
      title={rootLabel}
      aria-label={rootLabel}
      disabled={breadcrumbs.length === 0}
    >
      <span className="truncate max-w-[72px]">{rootLabel}</span>
    </DsButton>
  );

  if (breadcrumbs.length === 0) {
    return (
      <nav data-agent-entity="files:path" className="pointer-events-auto flex min-w-0 items-center justify-center gap-0.5 rounded-md" aria-label={rootLabel}>
        <span className="block w-full truncate text-center text-ui font-medium tracking-tight text-foreground/85">
          {title}
        </span>
      </nav>
    );
  }

  if (deep) {
    // 深度路径：Home › … › parent › current；省略号跳到第一个被折叠的祖先。
    const parentIndex = breadcrumbs.length - 2;
    const parentCrumb = breadcrumbs[parentIndex];
    return (
      <nav data-agent-entity="files:path" className="pointer-events-auto flex min-w-0 max-w-full items-center justify-center gap-0.5 rounded-md" aria-label={title}>
        {homeButton}
        {sep}
        <DsButton
          variant="ghost"
          size="sm"
          onClick={() => onBreadcrumbClick(0)}
          className={cn('!h-auto !min-w-0 !px-1 !py-0 text-ui font-medium tracking-tight text-foreground/55 hover:text-foreground', CRUMB_TOUCH_HIT_CLASS)}
          title={parentCrumb?.name}
          aria-label={parentCrumb?.name || '…'}
        >
          …
        </DsButton>
        {sep}
        {parentCrumb ? (
          <DsButton
            variant="ghost"
            size="sm"
            onClick={() => onBreadcrumbClick(parentIndex)}
            className={cn('!h-auto !min-w-0 !px-1 !py-0 text-ui font-medium tracking-tight text-foreground/55 hover:text-foreground', CRUMB_TOUCH_HIT_CLASS)}
            title={parentCrumb.name}
          >
            <span className="truncate max-w-[72px]">{parentCrumb.name}</span>
          </DsButton>
        ) : null}
        {parentCrumb ? sep : null}
        <span className="min-w-0 truncate text-ui font-medium tracking-tight text-foreground/85">
          {lastCrumb?.name || title}
        </span>
      </nav>
    );
  }

  return (
    <nav data-agent-entity="files:path" className="pointer-events-auto flex min-w-0 max-w-full items-center justify-center gap-0.5 rounded-md" aria-label={title}>
      {homeButton}
      {breadcrumbs.map((crumb, index) => {
        const isLast = index === breadcrumbs.length - 1;
        return (
          <React.Fragment key={crumb.id}>
            {sep}
            {isLast ? (
              <span className="min-w-0 truncate text-ui font-medium tracking-tight text-foreground/85">
                {crumb.name}
              </span>
            ) : (
              <DsButton
                variant="ghost"
                size="sm"
                onClick={() => onBreadcrumbClick(index)}
                className={cn('!h-auto !min-w-0 !px-1 !py-0 text-ui font-medium tracking-tight text-foreground/55 hover:text-foreground', CRUMB_TOUCH_HIT_CLASS)}
                title={crumb.name}
              >
                <span className="truncate max-w-[88px]">{crumb.name}</span>
              </DsButton>
            )}
          </React.Fragment>
        );
      })}
    </nav>
  );
}

/** Tahoe Finder-style chrome. Content controls stay in the top toolbar; the bottom bar is status-only. */
export const FinderToolbar = React.memo(function FinderToolbar({
  breadcrumbs,
  onBreadcrumbClick,
  currentTitle,
  onNavigateHome,
  canGoBack = false,
  canGoForward = false,
  onBack,
  onForward,
  viewMode = 'grid',
  onViewModeChange,
  sortBy = 'updatedAt',
  sortOrder = 'desc',
  onSortChange,
  searchQuery = '',
  onSearchChange,
  searchPlaceholder,
  searchDisabled = false,
  onNewFolder,
  onRefresh,
  titlebarMode = false,
}: FinderToolbarProps) {
  const { t } = useTranslation('learningHub');
  const [sortMenuOpen, setSortMenuOpen] = useState(false);
  const [overflowMenuOpen, setOverflowMenuOpen] = useState(false);
  // ★ 窄窗（compact）时排序 / 新建 / 刷新收进溢出菜单
  const { ref: sizeRef, sizeClass } = useToolbarSizeClass();
  const isCompact = sizeClass === 'compact';
  const rootLabel = t('folder.root');
  // 禁用时给出原因（此前直接 disabled 无解释，用户不知为何不可用）
  const resolvedSearchPlaceholder = searchDisabled
    ? t('finder.search.placeholderDisabled')
    : searchPlaceholder || t('finder.search.placeholder');

  // 触屏图标钮：视觉保持 40px（44px 会溢出 38px 窗口标题栏 chrome），
  // 伪元素 after:-inset-1 外扩 4px 使触控命中区达 48px，明确 ≥44px（对齐 FinderQuickAccess 范式）
  const navButtons = (
    <div className="finder-toolbar-control-group flex shrink-0 items-center gap-0.5 rounded-xl bg-[color:var(--interactive-hover)]/70 p-0.5">
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        className="pointer-events-auto relative !h-7 !w-7 !p-1 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-[''] text-foreground/70 hover:bg-background/70"
        onClick={onBack}
        disabled={!canGoBack}
        title={t('finder.toolbar.back')}
        aria-label={t('finder.toolbar.back')}
      >
        <CaretLeft size={16} />
      </DsButton>
      <DsButton
        variant="ghost"
        size="icon"
        iconOnly
        className="pointer-events-auto relative !h-7 !w-7 !p-1 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-[''] text-foreground/70 hover:bg-background/70"
        onClick={onForward}
        disabled={!canGoForward}
        title={t('finder.toolbar.forward')}
        aria-label={t('finder.toolbar.forward')}
      >
        <CaretRight size={16} />
      </DsButton>
    </div>
  );

  // 排序菜单项（宽窗独立排序菜单与窄窗溢出菜单共用）
  const sortMenuEntries = onSortChange ? (
    <>
      {SORT_OPTIONS.map((option) => (
        <AppMenuItem
          key={option.value}
          onClick={() => onSortChange(option.value, sortOrder)}
          icon={sortBy === option.value ? <Check size={14} /> : <span className="w-3.5" />}
        >
          {t(option.labelKey)}
        </AppMenuItem>
      ))}
      <AppMenuSeparator />
      <AppMenuItem
        onClick={() => onSortChange(sortBy, 'asc')}
        icon={sortOrder === 'asc' ? <Check size={14} /> : <span className="w-3.5" />}
      >
        {t('finder.sort.asc')}
      </AppMenuItem>
      <AppMenuItem
        onClick={() => onSortChange(sortBy, 'desc')}
        icon={sortOrder === 'desc' ? <Check size={14} /> : <span className="w-3.5" />}
      >
        {t('finder.sort.desc')}
      </AppMenuItem>
    </>
  ) : null;

  const viewModeToggle = onViewModeChange ? (
    <div className="finder-toolbar-control-group pointer-events-auto flex shrink-0 items-center gap-0.5 rounded-xl bg-[color:var(--interactive-hover)]/70 p-0.5">
      {(['grid', 'list'] as ViewMode[]).map((mode) => (
        <DsButton
          key={mode}
          variant="ghost"
          size="icon"
          iconOnly
          className={cn(
            "pointer-events-auto relative !h-7 !w-7 !p-1 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-['']",
            viewMode === mode ? 'bg-background text-foreground shadow-sm' : 'text-foreground/65 hover:bg-background/70'
          )}
          onClick={() => onViewModeChange(mode)}
          title={mode === 'grid' ? t('finder.viewMode.grid') : t('finder.viewMode.list')}
          aria-label={mode === 'grid' ? t('finder.viewMode.grid') : t('finder.viewMode.list')}
          aria-pressed={viewMode === mode}
        >
          {mode === 'grid' ? <SquaresFour size={16} /> : <List size={16} />}
        </DsButton>
      ))}
    </div>
  ) : null;

  // ★ 窄窗溢出菜单：新建文件夹 / 刷新 / 排序 收进一个 … 菜单
  const overflowMenu = (onNewFolder || onRefresh || onSortChange) ? (
    <AppMenu open={overflowMenuOpen} onOpenChange={setOverflowMenuOpen}>
      <AppMenuTrigger asChild>
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          className="pointer-events-auto relative !h-8 !w-8 !p-1.5 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-[''] rounded-xl bg-[color:var(--interactive-hover)]/70 text-foreground/70 hover:bg-background"
          title={t('finder.toolbar.more')}
          aria-label={t('finder.toolbar.more')}
          data-finder-toolbar-overflow
        >
          <DotsThree size={16} weight="bold" />
        </DsButton>
      </AppMenuTrigger>
      <AppMenuContent align="end" width={190}>
        {onNewFolder && (
          <AppMenuItem icon={<FolderPlus size={14} />} onClick={onNewFolder}>
            {t('finder.toolbar.newFolder')}
          </AppMenuItem>
        )}
        {onRefresh && (
          <AppMenuItem icon={<ArrowClockwise size={14} />} onClick={onRefresh}>
            {t('common:refresh')}
          </AppMenuItem>
        )}
        {sortMenuEntries && (onNewFolder || onRefresh) && <AppMenuSeparator />}
        {sortMenuEntries}
      </AppMenuContent>
    </AppMenu>
  ) : null;

  const utilityButtons = isCompact ? (
    <>
      {viewModeToggle}
      {overflowMenu}
    </>
  ) : (
    <>
      {viewModeToggle}

      {onSortChange && (
        <AppMenu open={sortMenuOpen} onOpenChange={setSortMenuOpen}>
          <AppMenuTrigger asChild>
            <DsButton
              variant="ghost"
              size="icon"
              iconOnly
              className="pointer-events-auto relative !h-8 !w-8 !p-1.5 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-[''] rounded-xl bg-[color:var(--interactive-hover)]/70 text-foreground/70 hover:bg-background"
              title={t('finder.sort.title')}
              aria-label={t('finder.sort.title')}
            >
              {sortOrder === 'asc' ? <SortAscending size={16} /> : <SortDescending size={16} />}
            </DsButton>
          </AppMenuTrigger>
          <AppMenuContent align="start" width={170}>
            {sortMenuEntries}
          </AppMenuContent>
        </AppMenu>
      )}

      {onNewFolder && (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          className="pointer-events-auto relative !h-8 !w-8 !p-1.5 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-[''] rounded-xl bg-[color:var(--interactive-hover)]/70 text-foreground/70 hover:bg-background"
          onClick={onNewFolder}
          title={t('finder.toolbar.newFolder')}
          aria-label={t('finder.toolbar.newFolder')}
        >
          <FolderPlus size={16} />
        </DsButton>
      )}

      {onRefresh && (
        <DsButton
          variant="ghost"
          size="icon"
          iconOnly
          className="pointer-events-auto relative !h-8 !w-8 !p-1.5 [@media(pointer:coarse)]:!h-10 [@media(pointer:coarse)]:!w-10 [@media(pointer:coarse)]:after:absolute [@media(pointer:coarse)]:after:-inset-1 [@media(pointer:coarse)]:after:content-[''] rounded-xl text-foreground/65 hover:bg-[color:var(--interactive-hover)]"
          onClick={onRefresh}
          title={t('common:refresh')}
          aria-label={t('common:refresh')}
        >
          <ArrowClockwise size={16} />
        </DsButton>
      )}
    </>
  );

  const searchField = onSearchChange ? (
    <div
      className={cn(
        'pointer-events-auto relative shrink-0',
        isCompact ? 'w-[128px]' : titlebarMode ? 'w-[168px]' : 'ml-1 w-[180px]'
      )}
    >
      <MagnifyingGlass className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground/45" size={14} />
      <input
        type="search"
        value={searchQuery}
        onChange={(event) => onSearchChange(event.target.value)}
        disabled={searchDisabled}
        placeholder={resolvedSearchPlaceholder}
        aria-label={resolvedSearchPlaceholder}
        className={cn(
          'h-8 w-full appearance-none rounded-xl border border-transparent bg-[color:var(--interactive-hover)]/70 pl-8 pr-2.5 text-ui [@media(pointer:coarse)]:!text-[16px] text-foreground outline-none placeholder:text-foreground/45 focus:border-[color:var(--border)] focus:bg-background [&::-webkit-search-cancel-button]:hidden',
          // 标题栏模式受 38px 窗口 chrome 约束，触屏保持 40px；内嵌顶栏无高度约束，触屏升至 44px 命中区
          titlebarMode ? '[@media(pointer:coarse)]:!h-10' : '[@media(pointer:coarse)]:!min-h-11'
        )}
      />
    </div>
  ) : null;

  const breadcrumbCenter = (
    <CompressedBreadcrumbs
      breadcrumbs={breadcrumbs}
      onBreadcrumbClick={onBreadcrumbClick}
      onNavigateHome={onNavigateHome}
      currentTitle={currentTitle}
      rootLabel={rootLabel}
    />
  );

  // 标题栏模式：左侧 = 导航 + 功能；中间可点面包屑相对整窗居中；右侧 = 搜索
  if (titlebarMode) {
    return (
      <div
        ref={sizeRef}
        data-wb-size={sizeClass}
        className="finder-toolbar pointer-events-none relative h-full shrink-0 bg-transparent py-0 pl-1 pr-2"
      >
        {/* OS 窗口槽从 traffic inset 后开始；全局 shell 槽则按自身宽度居中。 */}
        <div
          className="pointer-events-none absolute inset-y-0 z-0 flex items-center justify-center"
          style={{
            left: titlebarMode === 'window'
              ? 'calc(50% - (var(--wb-macos-traffic-lights-inset, 72px) / 2))'
              : '50%',
            width: 'min(42%, 280px)',
            transform: 'translateX(-50%)',
          }}
        >
          {breadcrumbCenter}
        </div>

        <div className="relative z-10 flex h-full min-w-0 items-center gap-1.5">
          {/* 左侧：导航 + 功能（原右侧按钮） */}
          <div className="flex shrink-0 items-center gap-1.5">
            {navButtons}
            {utilityButtons}
          </div>
          {/* 中间留给绝对定位标题 */}
          <div className="min-w-0 flex-1" aria-hidden />
          {/* 右侧：搜索（访达常见） */}
          {searchField}
        </div>
      </div>
    );
  }

  // 非标题栏（内嵌顶栏）：导航 + 面包屑居中 + 右侧工具
  return (
    <div
      ref={sizeRef}
      data-wb-size={sizeClass}
      className="finder-toolbar shrink-0 border-b border-[color:var(--shell-chrome-border)] bg-[color:var(--shell-titlebar-surface)] px-2 py-1.5"
    >
      <div className="flex h-full min-w-0 items-center gap-1.5">
        {navButtons}
        <div className="min-w-0 flex-1 px-2 text-center">
          {breadcrumbCenter}
        </div>
        {utilityButtons}
        {searchField}
      </div>
    </div>
  );
});

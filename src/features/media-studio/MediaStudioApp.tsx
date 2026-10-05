/**
 * 音视频子应用（docs/dev/media-learning/README.md §0.5）
 *
 * 资源库的专用视角：库页（导入 / 筛选 / 进度）↔ 学习页（播放器 + 字幕 / 讲义 / 问答 / 练习）。
 * 宿主：经典壳 'media' 视图（App.tsx）与学习桌面「音视频」窗口（MediaStudioAppWindow）。
 * 当前打开的媒体在 useMediaStudioNavStore，任意入口经 openMediaStudio 进入。
 *
 * 手机：库页套 MobileSlidingLayout（抽屉 = 应用启动器 + 最近在看），学习页顶栏为返回箭头；
 * Android 返回键：菜单 / 弹窗（各自注册的 overlay 档）→ 学习页回库页 → 交给全局。
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { FilmStrip, MusicNotes } from '@phosphor-icons/react';
import { useMobileHeader } from '@/components/layout/MobileHeaderContext';
import { MobileSlidingLayout } from '@/components/layout/MobileSlidingLayout';
import {
  mobileDrawerNavRowClassName,
  mobileDrawerRowIconWrapClassName,
  mobileDrawerRowTitleClassName,
  mobileDrawerSectionLabelClassName,
} from '@/components/layout/mobileDrawerStyles';
import { DsButton } from '@/components/ui/DsButton';
import { useBreakpoint } from '@/hooks/useBreakpoint';
import { useDesktopShellHeaderPortal } from '@/app/shell/DesktopShellHeaderPortal';
import { BACK_PRIORITY, registerVisibilityGuardedBackHandler } from '@/app/navigation/androidBackCoordinator';
import type { MediaLibraryItem } from './api';
import { isWatching, sortByRecent } from './libraryModel';
import {
  MEDIA_STUDIO_VIEW,
  mediaStudioPayloadResourceId,
  useMediaStudioNavStore,
} from './mediaStudioNavigation';
import { useMediaLibrary } from './useMediaLibrary';
import { useMediaImport } from './useMediaImport';
import { MediaLibraryPage } from './components/MediaLibraryPage';
import { MediaStudyPage } from './components/MediaStudyPage';

/** 抽屉「最近在看」条数 */
const DRAWER_RECENT_LIMIT = 6;

export interface MediaStudioAppProps {
  /** 视图 / 窗口是否在前台（后台时不播放、不响应引用跳转、不注册顶栏） */
  isActive?: boolean;
  /** 学习桌面窗口启动参数（{ resourceId }） */
  launchPayload?: unknown;
  /** 学习桌面窗口内嵌入：不接管全局移动端顶栏与经典壳顶栏槽位 */
  embedded?: boolean;
  /** 窗口标题回调（学习桌面） */
  onTitleChange?: (title: string | null) => void;
}

export const MediaStudioApp: React.FC<MediaStudioAppProps> = ({
  isActive = true,
  launchPayload,
  embedded = false,
  onTitleChange,
}) => {
  const { t } = useTranslation(['mediaStudio', 'sidebar']);
  const { isSmallScreen } = useBreakpoint();
  const rootRef = useRef<HTMLDivElement>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [studyTitle, setStudyTitle] = useState<string | null>(null);
  const activeResourceId = useMediaStudioNavStore((s) => s.activeResourceId);
  const openStudy = useMediaStudioNavStore((s) => s.openStudy);
  const closeStudy = useMediaStudioNavStore((s) => s.closeStudy);
  const classicTitlebar = useDesktopShellHeaderPortal(MEDIA_STUDIO_VIEW);
  const titlebarTarget = embedded || isSmallScreen ? null : classicTitlebar;

  const library = useMediaLibrary(true);
  const importer = useMediaImport({ onImported: () => void library.refresh() });

  // 学习桌面窗口：launchPayload 带资源 id 时直接进学习页
  const payloadResourceId = mediaStudioPayloadResourceId(launchPayload);
  useEffect(() => {
    if (payloadResourceId) openStudy(payloadResourceId);
  }, [payloadResourceId, openStudy]);

  const handleOpen = useCallback((item: MediaLibraryItem) => openStudy(item.id), [openStudy]);
  const handleBack = useCallback(() => {
    closeStudy();
    // 回库页时对账一次（观看进度 / 转写状态在学习页里变了）
    void library.refresh();
  }, [closeStudy, library]);

  const inStudy = Boolean(activeResourceId);
  const title = inStudy ? studyTitle ?? t('mediaStudio:title') : t('mediaStudio:title');

  useEffect(() => {
    onTitleChange?.(inStudy ? studyTitle : null);
  }, [inStudy, onTitleChange, studyTitle]);

  useMobileHeader('media', {
    title,
    subtitle: inStudy ? t('mediaStudio:title') : undefined,
    showMenu: !inStudy,
    showBackArrow: inStudy,
    onMenuClick: inStudy ? handleBack : () => setDrawerOpen((open) => !open),
  }, [title, inStudy, handleBack, t, isActive], isActive && !embedded);

  // Android 返回：学习页 → 库页（菜单 / 弹窗以 overlay 档先行处理）
  useEffect(() => {
    if (!isSmallScreen || !isActive || !inStudy) return;
    return registerVisibilityGuardedBackHandler(rootRef, () => {
      handleBack();
      return true;
    }, BACK_PRIORITY.view);
  }, [handleBack, inStudy, isActive, isSmallScreen]);

  const recent = useMemo(
    () => sortByRecent(library.items.filter((item) => isWatching(item) || item.lastWatchedAt)).slice(0, DRAWER_RECENT_LIMIT),
    [library.items],
  );

  const content = inStudy && activeResourceId ? (
    <MediaStudyPage
      key={activeResourceId}
      resourceId={activeResourceId}
      isActive={isActive}
      isSmallScreen={isSmallScreen}
      titlebarTarget={titlebarTarget}
      onBack={handleBack}
      onTitleChange={setStudyTitle}
    />
  ) : (
    <MediaLibraryPage
      library={library}
      importer={importer}
      onOpen={handleOpen}
      isSmallScreen={isSmallScreen}
      titlebarTarget={titlebarTarget}
    />
  );

  const drawer = (
    <nav className="min-h-0 space-y-0.5 pb-1 pt-1 text-foreground" aria-label={t('mediaStudio:drawer.recent')}>
      <span className={mobileDrawerSectionLabelClassName}>{t('mediaStudio:drawer.recent')}</span>
      {recent.length === 0 ? (
        <p className="px-3 py-2 text-xs text-muted-foreground">{t('mediaStudio:drawer.empty')}</p>
      ) : recent.map((item) => {
        const Icon = item.kind === 'audio' ? MusicNotes : FilmStrip;
        return (
          <DsButton
            key={item.id}
            variant="ghost"
            className={mobileDrawerNavRowClassName(activeResourceId === item.id)}
            aria-current={activeResourceId === item.id ? 'page' : undefined}
            onClick={() => {
              openStudy(item.id);
              setDrawerOpen(false);
            }}
          >
            <span className={mobileDrawerRowIconWrapClassName}><Icon size={16} weight="duotone" /></span>
            <span className={mobileDrawerRowTitleClassName}>{item.name}</span>
          </DsButton>
        );
      })}
    </nav>
  );

  return (
    <div
      ref={rootRef}
      className="flex h-full w-full min-w-0 flex-col overflow-hidden bg-background"
      data-media-studio={inStudy ? 'study' : 'library'}
    >
      {isSmallScreen && !embedded ? (
        <MobileSlidingLayout
          sidebar={drawer}
          sidebarOpen={drawerOpen}
          onSidebarOpenChange={setDrawerOpen}
          // 学习页自己处理返回；播放器 / 字幕有自己的手势
          enableGesture={!inStudy}
          showSidebarAppNavigation
          showContentOverlay
          className="flex-1"
        >
          <div className="flex h-full min-h-0 flex-col">{content}</div>
        </MobileSlidingLayout>
      ) : content}
    </div>
  );
};

export default MediaStudioApp;

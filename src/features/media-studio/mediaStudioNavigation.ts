/**
 * 音视频子应用导航（docs/dev/media-learning/README.md §0.5）
 *
 * 子应用是资源库的专用视角：库页（列表）↔ 学习页（某个音视频）。当前打开的
 * 媒体放在模块级 store，经典壳视图与学习桌面窗口共用同一份状态——任何入口
 * （资源库「在音视频中学习」、`[媒体@…]` 引用、命令面板）都只需调用
 * openMediaStudio，宿主各自订阅。
 *
 * 本模块保持轻量（不拖入播放器 / 页面 chunk），学习资源视图与聊天可静态 import。
 */
import { create } from 'zustand';
import { workbenchBus } from '@/features/workbench/core/workbenchBus';

/** 经典壳视图 id 与学习桌面应用 typeId */
export const MEDIA_STUDIO_VIEW = 'media' as const;
export const MEDIA_STUDIO_APP_TYPE_ID = 'media' as const;
/** 学习页里媒体视图的 focusScopeId：引用跳转只让子应用内的播放器响应 */
export const MEDIA_STUDIO_FOCUS_SCOPE = 'media-studio';

interface MediaStudioNavState {
  /** 学习页正在打开的 VFS File 资源 id；null = 库页 */
  activeResourceId: string | null;
  /** 每次 open 自增：同一资源再次打开也能让宿主感知（如重新聚焦窗口） */
  openSeq: number;
  openStudy: (resourceId: string) => void;
  closeStudy: () => void;
}

export const useMediaStudioNavStore = create<MediaStudioNavState>((set) => ({
  activeResourceId: null,
  openSeq: 0,
  openStudy: (resourceId) =>
    set((s) => ({ activeResourceId: resourceId, openSeq: s.openSeq + 1 })),
  closeStudy: () => set({ activeResourceId: null }),
}));

/** 去掉 DSTU 路径前缀（`/file_x` → `file_x`） */
export function normalizeMediaResourceId(resourceId: string): string {
  return resourceId.trim().replace(/^\/+/, '');
}

/**
 * 打开音视频子应用：带 resourceId 进学习页，否则进库页。
 * 学习桌面启用时开 / 聚焦「音视频」窗口；否则经 legacy 降级切到经典壳 'media' 视图。
 */
export function openMediaStudio(resourceId?: string | null): void {
  const store = useMediaStudioNavStore.getState();
  const id = resourceId ? normalizeMediaResourceId(resourceId) : '';
  if (id) store.openStudy(id);
  else store.closeStudy();
  const payload = id ? { resourceId: id } : undefined;
  if (workbenchBus.isEnabled()) {
    workbenchBus.launch({ typeId: MEDIA_STUDIO_APP_TYPE_ID, payload, reason: 'api' });
    return;
  }
  window.dispatchEvent(new CustomEvent('NAVIGATE_TO_VIEW', { detail: { view: MEDIA_STUDIO_VIEW } }));
}

/** 学习桌面窗口 launchPayload → 资源 id */
export function mediaStudioPayloadResourceId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null;
  const id = (payload as { resourceId?: unknown }).resourceId;
  return typeof id === 'string' && id.trim() ? normalizeMediaResourceId(id) : null;
}

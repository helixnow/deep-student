/**
 * 桌面快捷方式图标映射
 *
 * 由资源库「桌面」视图（DesktopView）与学习桌面（workbench DesktopShortcuts）
 * 共用，保证两处桌面的图标视觉一致。
 */

import type React from 'react';
import {
  IllustratedNoteIcon,
  IllustratedTextbookIcon,
  IllustratedExamIcon,
  IllustratedEssayIcon,
  IllustratedTranslationIcon,
  IllustratedMindmapIcon,
  IllustratedFolderIcon,
  FavoriteIcon,
  RecentIcon,
  AllFilesIcon,
  IllustratedImageIcon,
  IllustratedGenericFileIcon,
  TrashIcon as TrashIconSvg,
  type ResourceIconProps,
} from '../../icons';
import type { DesktopShortcut, AppType } from '../../stores/desktopStore';
import type { QuickAccessType } from '../../stores/finderStore';

/** 应用类型对应的图标 */
export const APP_TYPE_ICONS: Record<AppType, React.FC<ResourceIconProps>> = {
  note: IllustratedNoteIcon,
  exam: IllustratedExamIcon,
  essay: IllustratedEssayIcon,
  translation: IllustratedTranslationIcon,
  mindmap: IllustratedMindmapIcon,
  textbook: IllustratedTextbookIcon,
};

/** 快捷入口类型对应的图标 */
export const QUICK_ACCESS_ICONS: Partial<Record<QuickAccessType, React.FC<ResourceIconProps>>> = {
  notes: IllustratedNoteIcon,
  exams: IllustratedExamIcon,
  essays: IllustratedEssayIcon,
  translations: IllustratedTranslationIcon,
  mindmaps: IllustratedMindmapIcon,
  textbooks: IllustratedTextbookIcon,
  favorites: FavoriteIcon,
  recent: RecentIcon,
  allFiles: AllFilesIcon,
  images: IllustratedImageIcon,
  files: IllustratedGenericFileIcon,
  trash: TrashIconSvg,
};

/** 获取快捷方式图标 */
export function getShortcutIcon(shortcut: DesktopShortcut): React.FC<ResourceIconProps> {
  if (shortcut.type === 'app' && shortcut.target.appType) {
    return APP_TYPE_ICONS[shortcut.target.appType] || IllustratedGenericFileIcon;
  }
  if (shortcut.type === 'quickAccess' && shortcut.target.quickAccessType) {
    return QUICK_ACCESS_ICONS[shortcut.target.quickAccessType] || IllustratedGenericFileIcon;
  }
  if (shortcut.type === 'folder') {
    return IllustratedFolderIcon;
  }
  if (shortcut.type === 'resource' && shortcut.target.resourceType) {
    const typeIconMap: Record<string, React.FC<ResourceIconProps>> = {
      note: IllustratedNoteIcon,
      exam: IllustratedExamIcon,
      essay: IllustratedEssayIcon,
      translation: IllustratedTranslationIcon,
      mindmap: IllustratedMindmapIcon,
      textbook: IllustratedTextbookIcon,
      image: IllustratedImageIcon,
      folder: IllustratedFolderIcon,
    };
    return typeIconMap[shortcut.target.resourceType] || IllustratedGenericFileIcon;
  }
  return IllustratedGenericFileIcon;
}

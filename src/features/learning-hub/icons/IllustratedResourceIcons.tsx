/**
 * 扁平拟物风学习资源类型图标（复用 workbench/icons/app-icons/*.svg 同一套 SVG 资源）：
 *
 * - 文档与学习资源图标自身已内置 64×64 圆角底座与纸厚边，无需二次叠加白底外框；
 * - 文件夹图标为独立经典 Finder 晴空蓝折页造型，同样直接等比渲染；
 * - Props 与 ResourceIcons.tsx 的 ResourceIconProps 保持兼容。
 */
import React from 'react';
import { cn } from '@/utils/cn';
import type { ResourceIconProps } from './ResourceIcons';
import folderUrl from '@/features/workbench/icons/app-icons/folder.svg';
import noteUrl from '@/features/workbench/icons/app-icons/notes.svg';
import textbookUrl from '@/features/workbench/icons/app-icons/textbook.svg';
import examUrl from '@/features/workbench/icons/app-icons/exam.svg';
import translationUrl from '@/features/workbench/icons/app-icons/translation.svg';
import essayUrl from '@/features/workbench/icons/app-icons/essay.svg';
import imageUrl from '@/features/workbench/icons/app-icons/image.svg';
import fileUrl from '@/features/workbench/icons/app-icons/file.svg';
import mindmapUrl from '@/features/workbench/icons/app-icons/mindmap.svg';

const defaultSize = 48;

function makeIllustratedIcon(
  url: string,
  displayName: string,
): React.FC<ResourceIconProps> {
  const Component: React.FC<ResourceIconProps> = React.memo(({ className, size = defaultSize }) => (
    <img
      src={url}
      alt=""
      draggable={false}
      width={size}
      height={size}
      className={cn('pointer-events-none shrink-0 select-none object-contain', className)}
    />
  ));
  Component.displayName = displayName;
  return Component;
}

export const IllustratedFolderIcon = makeIllustratedIcon(folderUrl, 'IllustratedFolderIcon');
export const IllustratedNoteIcon = makeIllustratedIcon(noteUrl, 'IllustratedNoteIcon');
export const IllustratedTextbookIcon = makeIllustratedIcon(textbookUrl, 'IllustratedTextbookIcon');
export const IllustratedExamIcon = makeIllustratedIcon(examUrl, 'IllustratedExamIcon');
export const IllustratedTranslationIcon = makeIllustratedIcon(translationUrl, 'IllustratedTranslationIcon');
export const IllustratedEssayIcon = makeIllustratedIcon(essayUrl, 'IllustratedEssayIcon');
export const IllustratedImageIcon = makeIllustratedIcon(imageUrl, 'IllustratedImageIcon');
export const IllustratedGenericFileIcon = makeIllustratedIcon(fileUrl, 'IllustratedGenericFileIcon');
export const IllustratedMindmapIcon = makeIllustratedIcon(mindmapUrl, 'IllustratedMindmapIcon');

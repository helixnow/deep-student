/**
 * 全彩插画风资源类型图标(与 workbench 应用图标同一套 SVG 资源,统一青绿→藏青主色 + 琥珀/橙点缀)。
 *
 * - 文档类图标自带浅色圆角底座,保证在深色列表背景下辨识度(藏青线条不沉底);
 * - 文件夹图标为实体色块造型,无需底座;
 * - Props 与 ResourceIcons.tsx 的 ResourceIconProps 兼容,可直接替换 TYPE_CUSTOM_ICONS 等映射。
 */
import React from 'react';
import { cn } from '@/lib/utils';
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
  withTile: boolean,
): React.FC<ResourceIconProps> {
  const Component: React.FC<ResourceIconProps> = React.memo(({ className, size = defaultSize }) => {
    if (!withTile) {
      return (
        <img
          src={url}
          alt=""
          draggable={false}
          width={size}
          height={size}
          className={cn('pointer-events-none shrink-0 select-none object-contain', className)}
        />
      );
    }
    return (
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none inline-flex shrink-0 select-none items-center justify-center',
          className,
        )}
        style={{
          width: size,
          height: size,
          borderRadius: '22.5%',
          background: 'linear-gradient(180deg, #ffffff, #eef1f5)',
          boxShadow: 'inset 0 0 0 0.5px rgba(31, 41, 55, 0.16)',
        }}
      >
        <img
          src={url}
          alt=""
          draggable={false}
          className="pointer-events-none select-none object-contain"
          style={{ width: '78%', height: '78%' }}
        />
      </span>
    );
  });
  Component.displayName = displayName;
  return Component;
}

export const IllustratedFolderIcon = makeIllustratedIcon(folderUrl, 'IllustratedFolderIcon', false);
export const IllustratedNoteIcon = makeIllustratedIcon(noteUrl, 'IllustratedNoteIcon', true);
export const IllustratedTextbookIcon = makeIllustratedIcon(textbookUrl, 'IllustratedTextbookIcon', true);
export const IllustratedExamIcon = makeIllustratedIcon(examUrl, 'IllustratedExamIcon', true);
export const IllustratedTranslationIcon = makeIllustratedIcon(translationUrl, 'IllustratedTranslationIcon', true);
export const IllustratedEssayIcon = makeIllustratedIcon(essayUrl, 'IllustratedEssayIcon', true);
export const IllustratedImageIcon = makeIllustratedIcon(imageUrl, 'IllustratedImageIcon', true);
export const IllustratedGenericFileIcon = makeIllustratedIcon(fileUrl, 'IllustratedGenericFileIcon', true);
export const IllustratedMindmapIcon = makeIllustratedIcon(mindmapUrl, 'IllustratedMindmapIcon', true);

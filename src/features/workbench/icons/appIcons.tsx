import React from 'react';
import { cn } from '@/lib/utils';
import todoUrl from './app-icons/todo.svg';
import notesUrl from './app-icons/notes.svg';
import examUrl from './app-icons/exam.svg';
import translationUrl from './app-icons/translation.svg';
import essayUrl from './app-icons/essay.svg';
import pomodoroUrl from './app-icons/pomodoro.svg';
import skillsUrl from './app-icons/skills.svg';
import chatUrl from './app-icons/chat.svg';
import textbookUrl from './app-icons/textbook.svg';
import browserUrl from './app-icons/browser.svg';
import templatesUrl from './app-icons/templates.svg';
import sandboxUrl from './app-icons/sandbox.svg';
import flashcardsUrl from './app-icons/flashcards.svg';
import settingsUrl from './app-icons/settings.svg';
import imageUrl from './app-icons/image.svg';
import fileUrl from './app-icons/file.svg';
import filePreviewUrl from './app-icons/file-preview.svg';
import taskDashboardUrl from './app-icons/taskDashboard.svg';
import aiDashboardUrl from './app-icons/aiDashboard.svg';
import filesUrl from './app-icons/files.svg';
import mindmapUrl from './app-icons/mindmap.svg';

/**
 * 全彩插画风应用图标（独立 SVG 资源，统一青绿→藏青主色 + 琥珀/橙点缀）。
 * 以 <img> 引用而非内联，避免各 SVG 内部渐变 id（SVGID_1_ 等）互相冲突。
 */
export const APP_ICON_URLS: Record<string, string> = {
  todo: todoUrl,
  notes: notesUrl,
  exam: examUrl,
  translation: translationUrl,
  essay: essayUrl,
  pomodoro: pomodoroUrl,
  skills: skillsUrl,
  chat: chatUrl,
  textbook: textbookUrl,
  browser: browserUrl,
  templates: templatesUrl,
  sandbox: sandboxUrl,
  flashcards: flashcardsUrl,
  settings: settingsUrl,
  image: imageUrl,
  file: fileUrl,
  'file-preview': filePreviewUrl,
  taskDashboard: taskDashboardUrl,
  aiDashboard: aiDashboardUrl,
  files: filesUrl,
  mindmap: mindmapUrl,
};

export function hasIllustratedAppIcon(typeId: string): boolean {
  return Object.hasOwn(APP_ICON_URLS, typeId);
}

interface AppIconImageProps {
  typeId: keyof typeof APP_ICON_URLS | string;
  className?: string;
}

/**
 * 自带浅色圆角底座的应用图标。
 * 底座随图标走（而非依赖使用场景提供背景），保证在应用面板的白色瓷贴
 * 和 Dock 的深色透明底两种环境下辨识度一致——藏青线条为主的插画
 * （笔记/题目集等）在深色背景上不会沉底。
 */
export const AppIconImage: React.FC<AppIconImageProps> = ({ typeId, className }) => {
  const src = APP_ICON_URLS[typeId];
  if (!src) return null;
  return (
    <span
      aria-hidden="true"
      data-app-icon={typeId}
      className={cn(
        'pointer-events-none inline-flex aspect-square select-none items-center justify-center',
        className,
      )}
      style={{
        borderRadius: '22.5%',
        background: 'linear-gradient(180deg, #ffffff, #eef1f5)',
        boxShadow: 'inset 0 0 0 0.5px rgba(31, 41, 55, 0.16), 0 1px 2px rgba(15, 23, 42, 0.25)',
      }}
    >
      <img
        src={src}
        alt=""
        draggable={false}
        className="pointer-events-none select-none object-contain"
        style={{ width: '76%', height: '76%' }}
      />
    </span>
  );
};

function makeAppIcon(typeId: keyof typeof APP_ICON_URLS): React.FC<{ className?: string }> {
  const Component: React.FC<{ className?: string }> = ({ className }) => (
    <AppIconImage typeId={typeId} className={className} />
  );
  Component.displayName = `AppIcon(${typeId})`;
  return Component;
}

export const TodoAppIcon = makeAppIcon('todo');
export const NotesAppIcon = makeAppIcon('notes');
export const ExamAppIcon = makeAppIcon('exam');
export const TranslationAppIcon = makeAppIcon('translation');
export const EssayAppIcon = makeAppIcon('essay');
export const PomodoroAppIcon = makeAppIcon('pomodoro');
export const SkillsAppIcon = makeAppIcon('skills');
export const ChatAppIcon = makeAppIcon('chat');
export const TextbookAppIcon = makeAppIcon('textbook');
export const BrowserAppIcon = makeAppIcon('browser');
export const TemplatesAppIcon = makeAppIcon('templates');
export const SandboxAppIcon = makeAppIcon('sandbox');
export const FlashcardsAppIcon = makeAppIcon('flashcards');
export const SettingsAppIcon = makeAppIcon('settings');
export const ImageAppIcon = makeAppIcon('image');
export const FileAppIcon = makeAppIcon('file');
export const FilePreviewAppIcon = makeAppIcon('file-preview');
export const TaskDashboardAppIcon = makeAppIcon('taskDashboard');
export const FilesAppIcon = makeAppIcon('files');

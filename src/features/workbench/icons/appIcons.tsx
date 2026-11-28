import React from 'react';
import { cn } from '@/utils/cn';
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
import mediaUrl from './app-icons/media.svg';
import pluginWorkshopUrl from './app-icons/pluginWorkshop.svg';

/**
 * 扁平拟物风子应用图标资源映射（64×64 画布，各 SVG 自带纸墨矿物色系圆角底座与纸厚边）。
 * 以 <img> / <image> 引用独立资源，避免跨图标内部 clipPath id 冲突。
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
  media: mediaUrl,
  pluginWorkshop: pluginWorkshopUrl,
};

export function hasIllustratedAppIcon(typeId: string): boolean {
  return Object.hasOwn(APP_ICON_URLS, typeId);
}

interface AppIconImageProps {
  typeId: keyof typeof APP_ICON_URLS | string;
  className?: string;
}

/**
 * 应用图标展示组件。
 * 各图标 SVG 已内置圆角底座与实体描边，此处直接等比铺满容器，不再叠加二次外框底座。
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
    >
      <img
        src={src}
        alt=""
        draggable={false}
        className="pointer-events-none h-full w-full select-none object-contain"
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
export const PluginWorkshopAppIcon = makeAppIcon('pluginWorkshop');

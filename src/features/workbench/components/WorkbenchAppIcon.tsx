import React from 'react';
import { APP_ICON_URLS } from '../icons/appIcons';

interface WorkbenchAppIconProps {
  typeId: string;
  className?: string;
}

/**
 * 工作台启动台扁平拟物图标（64×64 画布）：
 * 各子应用 SVG 资源（见 icons/app-icons/*.svg）已内置圆角方块底座与纸厚边，
 * 此处直接按 64×64 满幅挂载，不叠加额外渐变底板。
 */
const IllustratedTile: React.FC<{ typeId: string }> = ({ typeId }) => (
  <>
    <rect width="64" height="64" fill="none" />
    <image
      href={APP_ICON_URLS[typeId]}
      x="0"
      y="0"
      width="64"
      height="64"
      preserveAspectRatio="xMidYMid meet"
    />
  </>
);

const artwork: Record<string, React.FC> = {
  notes: () => <IllustratedTile typeId="notes" />,
  todo: () => <IllustratedTile typeId="todo" />,
  chat: () => <IllustratedTile typeId="chat" />,
  pomodoro: () => <IllustratedTile typeId="pomodoro" />,
  translation: () => <IllustratedTile typeId="translation" />,
  skills: () => <IllustratedTile typeId="skills" />,
  textbook: () => <IllustratedTile typeId="textbook" />,
  browser: () => <IllustratedTile typeId="browser" />,
  templates: () => <IllustratedTile typeId="templates" />,
  sandbox: () => <IllustratedTile typeId="sandbox" />,
  flashcards: () => <IllustratedTile typeId="flashcards" />,
  settings: () => <IllustratedTile typeId="settings" />,
  exam: () => <IllustratedTile typeId="exam" />,
  image: () => <IllustratedTile typeId="image" />,
  file: () => <IllustratedTile typeId="file" />,
  'file-preview': () => <IllustratedTile typeId="file-preview" />,
  taskDashboard: () => <IllustratedTile typeId="taskDashboard" />,
  files: () => <IllustratedTile typeId="files" />,
  essay: () => <IllustratedTile typeId="essay" />,
  mindmap: () => <IllustratedTile typeId="mindmap" />,
  media: () => <IllustratedTile typeId="media" />,
  aiDashboard: () => <IllustratedTile typeId="aiDashboard" />,
  pluginWorkshop: () => <IllustratedTile typeId="pluginWorkshop" />,
};

export function hasWorkbenchAppIcon(typeId: string): boolean {
  return Object.hasOwn(artwork, typeId);
}

export const WorkbenchAppIcon = React.memo(({ typeId, className }: WorkbenchAppIconProps) => {
  const Artwork = artwork[typeId];
  if (!Artwork) return null;

  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      data-workbench-app-icon={typeId}
    >
      <Artwork />
    </svg>
  );
});

WorkbenchAppIcon.displayName = 'WorkbenchAppIcon';

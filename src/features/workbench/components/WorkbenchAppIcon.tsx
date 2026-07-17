import React from 'react';
import { APP_ICON_URLS } from '../icons/appIcons';

interface WorkbenchAppIconProps {
  typeId: string;
  className?: string;
}

/**
 * macOS Big Sur 风格图标（64×64 画布）：
 * - 每枚图标自带全出血圆角方块底座（rx≈14.3，接近 macOS squircle 比例 22.37%）；
 * - 底座为竖向双色渐变，符号统一用白色（细节用半透明白）居中绘制；
 * - 浅色底座（如笔记/待办）追加 0.5px 内描边避免融入浅色背景；
 * - 渐变 id 以 wbai-<typeId>- 前缀保证跨图标唯一。
 */

const TILE_RX = 14.3;

const Tile: React.FC<{ id: string; from: string; to: string; light?: boolean }> = ({ id, from, to, light }) => (
  <>
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={from} />
        <stop offset="1" stopColor={to} />
      </linearGradient>
    </defs>
    <rect x="1" y="1" width="62" height="62" rx={TILE_RX} fill={`url(#${id})`} />
    {light ? (
      <rect x="1.25" y="1.25" width="61.5" height="61.5" rx="14.1" fill="none" stroke="#1f2937" strokeOpacity=".14" strokeWidth=".5" />
    ) : (
      <rect x="1.5" y="1.5" width="61" height="61" rx="13.9" fill="none" stroke="#fff" strokeOpacity=".18" strokeWidth="1" />
    )}
  </>
);

/** 全彩插画图标铺在浅色底座上（资源见 icons/app-icons/*.svg，经统一调色） */
const IllustratedTile: React.FC<{ typeId: string }> = ({ typeId }) => (
  <>
    <Tile id={`wbai-${typeId}-tile`} from="#ffffff" to="#eef1f5" light />
    <image
      href={APP_ICON_URLS[typeId]}
      x="9"
      y="9"
      width="46"
      height="46"
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

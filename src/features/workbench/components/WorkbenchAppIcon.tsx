import React from 'react';

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

const artwork: Record<string, React.FC> = {
  notes: () => (
    <>
      <Tile id="wbai-notes-tile" from="#fdfdf8" to="#f1f0e6" light />
      <path d="M1 15h62v-.7C63 6.4 57.6 1 50.7 1H13.3C6.4 1 1 6.4 1 14.3v.7Z" fill="#fcd44e" />
      <path d="M1 15h62v1.6H1Z" fill="#e8b83a" />
      <rect x="12" y="25" width="40" height="3.6" rx="1.8" fill="#c8c6ba" />
      <rect x="12" y="34.5" width="33" height="3.6" rx="1.8" fill="#d4d2c7" />
      <rect x="12" y="44" width="37" height="3.6" rx="1.8" fill="#d4d2c7" />
    </>
  ),
  todo: () => (
    <>
      <Tile id="wbai-todo-tile" from="#ffffff" to="#f0f1f4" light />
      <circle cx="16.5" cy="17" r="6" fill="#3f8cf3" />
      <path d="m13.7 17 2.1 2.1 3.6-4.4" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" fill="none" />
      <rect x="28" y="14.8" width="24" height="4" rx="2" fill="#c8ccd4" />
      <circle cx="16.5" cy="33.5" r="6" fill="none" stroke="#f59a23" strokeWidth="2.6" />
      <rect x="28" y="31.3" width="19" height="4" rx="2" fill="#d3d6dd" />
      <circle cx="16.5" cy="50" r="6" fill="none" stroke="#e8556d" strokeWidth="2.6" />
      <rect x="28" y="47.8" width="15" height="4" rx="2" fill="#d3d6dd" />
    </>
  ),
  chat: () => (
    <>
      <Tile id="wbai-chat-tile" from="#69e46c" to="#2fc248" />
      <path
        d="M32 13.5c-11.3 0-20.5 7.7-20.5 17.3 0 5.5 3 10.3 7.7 13.5-.3 2.7-1.5 5.1-3.5 7-.5.5-.1 1.4.6 1.4 3.9-.1 7.3-1.4 10-3.3 1.8.4 3.7.7 5.7.7 11.3 0 20.5-7.7 20.5-17.3S43.3 13.5 32 13.5Z"
        fill="#fff"
      />
      <circle cx="23.5" cy="31" r="2.6" fill="#41c952" />
      <circle cx="32" cy="31" r="2.6" fill="#41c952" />
      <circle cx="40.5" cy="31" r="2.6" fill="#41c952" />
    </>
  ),
  pomodoro: () => (
    <>
      <Tile id="wbai-pomodoro-tile" from="#fa6a5d" to="#dd3a36" />
      <circle cx="32" cy="35" r="17.5" fill="none" stroke="#fff" strokeWidth="3.6" />
      <path d="M32 35V21.5A13.5 13.5 0 0 1 43.7 41.75Z" fill="#fff" fillOpacity=".9" />
      <path d="M32 13.5v-3M26 11.6l1 2.8M38 11.6l-1 2.8" stroke="#fff" strokeWidth="3" strokeLinecap="round" fill="none" />
      <path d="M32 10.5c-2-3-5.2-4-7.6-3 .9 3.1 3.6 4.6 7.6 3Z" fill="#8ee6a2" />
    </>
  ),
  translation: () => (
    <>
      <Tile id="wbai-translation-tile" from="#4f9df4" to="#2b6ee0" />
      <text x="21" y="32" fill="#fff" fontFamily="'PingFang SC','Microsoft YaHei',sans-serif" fontSize="21" fontWeight="700" textAnchor="middle">文</text>
      <rect x="32.5" y="32.5" width="20.5" height="20.5" rx="5.5" fill="#fff" />
      <text x="42.8" y="47.6" fill="#2b6ee0" fontFamily="system-ui,-apple-system,sans-serif" fontSize="15" fontWeight="800" textAnchor="middle">A</text>
      <path d="M22 42.5c3 4.5 7 7.6 12 9.4M42 22c-2.4-4-5.8-7-10-8.8" stroke="#fff" strokeOpacity=".55" strokeWidth="2.4" strokeLinecap="round" fill="none" />
      <path d="m31.2 49.3 3.4 2.2-3.9 1.6ZM34.9 15l-3.5-2 4-1.7Z" fill="#fff" fillOpacity=".55" />
    </>
  ),
  skills: () => (
    <>
      <Tile id="wbai-skills-tile" from="#a06cf5" to="#7440e8" />
      <path d="M27 13q2.6 14.4 17 17-14.4 2.6-17 17-2.6-14.4-17-17 14.4-2.6 17-17Z" fill="#fff" />
      <path d="M46 34q1.5 8.5 10 10-8.5 1.5-10 10-1.5-8.5-10-10 8.5-1.5 10-10Z" fill="#fff" fillOpacity=".85" />
      <circle cx="46.5" cy="16.5" r="3.2" fill="#fff" fillOpacity=".75" />
    </>
  ),
  textbook: () => (
    <>
      <Tile id="wbai-textbook-tile" from="#f9a03d" to="#ec751e" />
      <path d="M32 18.5c-4.6-3.4-10.4-4.4-17.5-3.6a1.8 1.8 0 0 0-1.5 1.8v27.6c0 1.1 1 2 2.1 1.9 6.4-.6 11.7.4 16.9 3.6V18.5Z" fill="#fff" />
      <path d="M32 18.5c4.6-3.4 10.4-4.4 17.5-3.6a1.8 1.8 0 0 1 1.5 1.8v27.6c0 1.1-1 2-2.1 1.9-6.4-.6-11.7.4-16.9 3.6V18.5Z" fill="#fff" fillOpacity=".82" />
      <path d="M32 18.5v31.3" stroke="#ec751e" strokeOpacity=".5" strokeWidth="1.6" />
    </>
  ),
  browser: () => (
    <>
      <Tile id="wbai-browser-tile" from="#41a9f5" to="#1c72dd" />
      <circle cx="32" cy="32" r="20" fill="none" stroke="#fff" strokeWidth="3.2" />
      <path d="m43.5 20.5-7.3 15.7-15.7 7.3 7.3-15.7Z" fill="#fff" />
      <path d="m36.2 36.2-15.7 7.3 7.3-15.7Z" fill="#d7e9fb" />
    </>
  ),
  templates: () => (
    <>
      <Tile id="wbai-templates-tile" from="#93a3b8" to="#65758b" />
      <rect x="21" y="11" width="28" height="34" rx="4" fill="#fff" fillOpacity=".4" />
      <rect x="17.5" y="15.5" width="28" height="34" rx="4" fill="#fff" fillOpacity=".65" />
      <rect x="14" y="20" width="29" height="34" rx="4" fill="#fff" />
      <rect x="19.5" y="28" width="18" height="3.4" rx="1.7" fill="#8b9aae" />
      <rect x="19.5" y="35.5" width="12" height="3.4" rx="1.7" fill="#aeb9c8" />
      <rect x="19.5" y="43" width="15" height="3.4" rx="1.7" fill="#aeb9c8" />
    </>
  ),
  sandbox: () => (
    <>
      <Tile id="wbai-sandbox-tile" from="#2eb89b" to="#0f8a71" />
      <path d="M32 12.5 50 23 32 33.5 14 23Z" fill="#fff" />
      <path d="M14 23v18l18 10.5v-18Z" fill="#fff" fillOpacity=".72" />
      <path d="M50 23v18L32 51.5v-18Z" fill="#fff" fillOpacity=".5" />
    </>
  ),
  flashcards: () => (
    <>
      <Tile id="wbai-flashcards-tile" from="#7e6cf6" to="#5741e4" />
      <rect x="11" y="13" width="32" height="24" rx="4.5" fill="#fff" fillOpacity=".45" />
      <rect x="19" y="24" width="34" height="27" rx="4.5" fill="#fff" />
      <path d="M43 27.5 34.5 39h5.6l-2.4 9.2 8.9-11.6h-5.7l2-9.1Z" fill="#f7b731" />
      <rect x="24" y="32" width="7" height="3.2" rx="1.6" fill="#b0a7ee" />
      <rect x="24" y="39" width="5.5" height="3.2" rx="1.6" fill="#c8c2f4" />
    </>
  ),
  settings: () => (
    <>
      <Tile id="wbai-settings-tile" from="#9aa5b1" to="#67737f" />
      <g fill="#fff">
        <rect x="28.9" y="9" width="6.2" height="46" rx="3.1" />
        <rect x="28.9" y="9" width="6.2" height="46" rx="3.1" transform="rotate(45 32 32)" />
        <rect x="28.9" y="9" width="6.2" height="46" rx="3.1" transform="rotate(90 32 32)" />
        <rect x="28.9" y="9" width="6.2" height="46" rx="3.1" transform="rotate(135 32 32)" />
        <circle cx="32" cy="32" r="15" />
      </g>
      <circle cx="32" cy="32" r="6.5" fill="#7d8894" />
    </>
  ),
  exam: () => (
    <>
      <Tile id="wbai-exam-tile" from="#8a70f0" to="#5f48d8" />
      <rect x="13" y="10" width="38" height="44" rx="5" fill="#fff" />
      <circle cx="21.5" cy="21" r="3" fill="none" stroke="#8a70f0" strokeWidth="2.2" />
      <rect x="27.5" y="19.4" width="16" height="3.2" rx="1.6" fill="#c0b4f2" />
      <circle cx="21.5" cy="32" r="3" fill="none" stroke="#8a70f0" strokeWidth="2.2" />
      <rect x="27.5" y="30.4" width="13" height="3.2" rx="1.6" fill="#c0b4f2" />
      <circle cx="21.5" cy="43" r="3" fill="none" stroke="#8a70f0" strokeWidth="2.2" />
      <rect x="27.5" y="41.4" width="15" height="3.2" rx="1.6" fill="#c0b4f2" />
      <circle cx="46" cy="46" r="9.5" fill="#f7b731" stroke="#fff" strokeWidth="2.4" />
      <text x="46" y="50.8" fill="#7a4d08" fontFamily="system-ui,-apple-system,sans-serif" fontSize="13" fontWeight="800" textAnchor="middle">?</text>
    </>
  ),
  image: () => (
    <>
      <Tile id="wbai-image-tile" from="#57bef5" to="#2688dd" />
      <circle cx="22" cy="21" r="5.5" fill="#ffd166" />
      <path d="M8 54l17.5-23L39 48.5l6.5-8L56 54H8Z" fill="#fff" fillOpacity=".92" />
      <path d="M33 54l9.5-13.5L56 54Z" fill="#fff" fillOpacity=".6" />
    </>
  ),
  file: () => (
    <>
      <Tile id="wbai-file-tile" from="#5aa2f2" to="#2f6fd4" />
      <path d="M19 15a4 4 0 0 1 4-4h14l12 12v26a4 4 0 0 1-4 4H23a4 4 0 0 1-4-4V15Z" fill="#fff" />
      <path d="M37 11l12 12h-8a4 4 0 0 1-4-4v-8Z" fill="#c4dbf7" />
      <rect x="24" y="30" width="13" height="3.2" rx="1.6" fill="#9dc0ef" />
      <rect x="24" y="37" width="16" height="3.2" rx="1.6" fill="#bcd5f4" />
      <rect x="24" y="44" width="11" height="3.2" rx="1.6" fill="#bcd5f4" />
    </>
  ),
  'file-preview': () => (
    <>
      <Tile id="wbai-file-preview-tile" from="#6e97c8" to="#446e9f" />
      <path d="M17 14a4 4 0 0 1 4-4h13l11 11v22a4 4 0 0 1-4 4H21a4 4 0 0 1-4-4V14Z" fill="#fff" />
      <path d="M34 10l11 11h-7a4 4 0 0 1-4-4v-7Z" fill="#cfdded" />
      <rect x="22" y="26" width="11" height="3" rx="1.5" fill="#a5bdd8" />
      <rect x="22" y="33" width="14" height="3" rx="1.5" fill="#c2d3e5" />
      <circle cx="42.5" cy="44.5" r="11" fill="#3b71ad" stroke="#fff" strokeWidth="2.6" />
      <path d="M34.8 44.5s3-4.8 7.7-4.8 7.7 4.8 7.7 4.8-3 4.8-7.7 4.8-7.7-4.8-7.7-4.8Z" fill="#fff" />
      <circle cx="42.5" cy="44.5" r="2.4" fill="#3b71ad" />
    </>
  ),
  taskDashboard: () => (
    <>
      <Tile id="wbai-taskDashboard-tile" from="#4c86dd" to="#2a56ac" />
      <rect x="14" y="34" width="9" height="16" rx="2.5" fill="#fff" fillOpacity=".55" />
      <rect x="27.5" y="25" width="9" height="25" rx="2.5" fill="#fff" fillOpacity=".78" />
      <rect x="41" y="13" width="9" height="37" rx="2.5" fill="#fff" />
      <rect x="12" y="52" width="40" height="3" rx="1.5" fill="#fff" fillOpacity=".65" />
    </>
  ),
  files: () => (
    <>
      <Tile id="wbai-files-tile" from="#44bd74" to="#1c9351" />
      <path d="M12 20a4 4 0 0 1 4-4h10l4.5 4.5H48a4 4 0 0 1 4 4V44a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V20Z" fill="#fff" fillOpacity=".55" />
      <path d="M12 26a4 4 0 0 1 4-4h32a4 4 0 0 1 4 4v18a4 4 0 0 1-4 4H16a4 4 0 0 1-4-4V26Z" fill="#fff" />
    </>
  ),
  essay: () => (
    <>
      <Tile id="wbai-essay-tile" from="#8496ab" to="#5c7089" />
      <rect x="14" y="10" width="36" height="44" rx="5" fill="#fff" />
      <text x="21" y="33" fill="#5c7089" fontFamily="Georgia,'Times New Roman',serif" fontSize="18" fontStyle="italic" fontWeight="700">Aa</text>
      <rect x="20" y="39" width="19" height="3.2" rx="1.6" fill="#b4c0cf" />
      <rect x="20" y="46" width="13" height="3.2" rx="1.6" fill="#c6d0dc" />
      <circle cx="46" cy="46" r="9.5" fill="#ef5468" stroke="#fff" strokeWidth="2.4" />
      <path d="m41.8 46 3 3 5.4-6" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>
  ),
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

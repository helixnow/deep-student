/**
 * 主应用组件在片子里看到的浏览器环境。由 src/index.ts 最先引入，早于任何主应用模块求值。
 * - 界面语言报中文：主应用按 navigator.language 排日期与数字，渲染用的浏览器默认报 en-US。
 * - 报「减少动态效果」：图表等的入场动画按真实时间播放，截帧会落在动画中途；片中的动效由镜头自己驱动。
 *   只改脚本读到的结果（matchMedia），CSS 里的 @media 不受影响。
 */
const REDUCED_MOTION = /prefers-reduced-motion:\s*reduce/;

Object.defineProperty(navigator, 'language', { configurable: true, get: () => 'zh-CN' });
Object.defineProperty(navigator, 'languages', { configurable: true, get: () => ['zh-CN', 'zh'] });

const matchMedia = window.matchMedia.bind(window);
window.matchMedia = (query: string): MediaQueryList => {
  const list = matchMedia(query);
  return REDUCED_MOTION.test(query) ? Object.defineProperty(list, 'matches', { get: () => true }) : list;
};

export {};

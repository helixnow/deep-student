import path from 'node:path';
import { webpack } from '@remotion/bundler';

// remotion.config.ts 会被打包成 CJS 执行，import.meta 不可用；npm scripts 的 cwd 恒为 video/。
const here = process.cwd();
const appSrc = path.resolve(here, '..', 'src');
const shim = (name) => path.resolve(here, 'src/shims', name);
const script = (name) => path.resolve(here, 'scripts', name);
const katex = (file) => path.resolve(here, 'node_modules/katex/dist', file);

/** 主应用里整个换掉的模块（按解析后的路径）。换上的文件仍按原目录解析导入，所以都不能有相对导入。 */
const REPLACED = new Map([
  // 靠 import.meta.glob 异步加载文案 → 本工程同步初始化的实例
  [path.join(appSrc, 'i18n.ts'), path.resolve(here, 'src/app-ui/i18n.ts')],
  // 按需加载命令面板、对话块、工作台应用等注册表（等于把大半个应用打进片子）→ 只留锚点跳转的空实现
  [path.join(appSrc, 'ui-kernel/bootstrap.ts'), shim('ui-kernel-bootstrap.ts')],
  // 按需加载笔记、导图、PDF 等全部编辑器（约 2300 个模块）→ 打开资源一律返回失败
  [path.join(appSrc, 'dstu/openResource.ts'), shim('dstu-open-resource.ts')],
  // 生成式界面的导图嵌入块按需加载整个导图编辑器（同样约 2300 个模块）→ 不渲染内容
  [path.join(appSrc, 'features/mindmap/components/mindmap/MindMapEmbed.tsx'), shim('mindmap-embed.ts')],
]);

/**
 * 允许从主应用源码直接导入 locale 文案、图标、静态资源与组件（单一来源），
 * 并把 react 固定到本工程的副本，避免主仓 node_modules 里的第二份 React。
 */
export const webpackOverride = (config) => ({
  ...config,
  module: {
    ...config.module,
    rules: [
      ...(config.module?.rules ?? []),
      // 主应用组件用到的 .ogg?inline 内联音频资源（如 DeepSeekCapabilities）
      { test: /\.ogg$/i, resourceQuery: /inline/, type: 'asset/inline' },
      // 主应用组件自带的 CSS 先收进 .ds-app 作用域（scripts/app-css-scope.cjs），再交给 Remotion 的 css-loader
      { test: /\.css$/i, enforce: 'pre', include: appSrc, use: [script('app-css-loader.cjs')] },
      // 主应用里 (import.meta as any) 的裸引用先改写掉（scripts/app-import-meta-loader.cjs），否则产物里会留下 import.meta
      { test: /\.tsx?$/i, enforce: 'pre', include: appSrc, use: [script('app-import-meta-loader.cjs')] },
      // 主应用读到的时间固定在片中的「今天」（scripts/app-clock-loader.cjs），画面不随渲染日期变
      { test: /\.tsx?$/i, enforce: 'pre', include: appSrc, use: [script('app-clock-loader.cjs')] },
    ],
  },
  plugins: [
    ...(config.plugins ?? []),
    // 主应用按 Vite 的 import.meta.env 判断环境
    new webpack.DefinePlugin({ 'import.meta.env': JSON.stringify({ MODE: 'production', DEV: false, PROD: false }) }),
    new webpack.NormalModuleReplacementPlugin(/[\\/](?:i18n|bootstrap|openResource|MindMapEmbed)\.tsx?$/, (result) => {
      const to = REPLACED.get(result.createData?.resource);
      if (to) result.createData.resource = to;
    }),
  ],
  resolve: {
    ...config.resolve,
    alias: {
      ...(config.resolve?.alias ?? {}),
      // 主应用源码内部的 @/ 别名：src/app-ui 直接渲染主应用组件时需要
      '@': appSrc,
      '@app': appSrc,
      '@app-public': path.resolve(here, '..', 'public'),
      '@tauri-apps/api/core': shim('tauri-core.ts'),
      '@tauri-apps/api/event': shim('tauri-event.ts'),
      '@tauri-apps/plugin-dialog': shim('tauri-plugin-dialog.ts'),
      '@tauri-apps/plugin-fs': shim('tauri-plugin-fs.ts'),
      // 主应用的卡面公式也用本工程这一份 KaTeX：主仓 node_modules 里是另一个版本，会带进第二套同名字体声明
      katex$: katex('katex.mjs'),
      'katex/contrib/mhchem$': katex('contrib/mhchem.mjs'),
      'katex/dist/katex.min.css$': katex('katex.min.css'),
      react: path.resolve(here, 'node_modules/react'),
      'react-dom': path.resolve(here, 'node_modules/react-dom'),
    },
  },
});
